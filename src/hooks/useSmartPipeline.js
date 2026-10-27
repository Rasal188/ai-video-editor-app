import { useEffect, useRef, useState } from "react";
import { browserProjectFingerprint } from "../lib/browserEditPlan.js";
import {
  canRemovePauses,
  createSmartPipelinePlan,
  buildSmartPipelineReview,
  calculatePipelineMetrics,
} from "../lib/smartPipeline.js";
import { analyzeVideoPauses } from "../lib/sileroVad.js";
import { transcribeAudioToCaptionSegments } from "../lib/asr.js";
import { regroupReviewSegments } from "../lib/transcriptReview.js";
import { sliceAudioBlob } from "../lib/media.js";

export function useSmartPipeline(options) {
  const [isOpen, setIsOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [stage, setStage] = useState("select"); // "select" | "analyzing" | "captions" | "cuts" | "review" | "applied"
  const [selectedClipId, setSelectedClipId] = useState("");
  const [settings, setSettings] = useState({
    threshold: 0.5,
    minimum: 0.8,
    keep: 0.3,
    removeFillerWords: true,
    generateCaptions: true,
    rippleEditing: true,
    language: options.language || "zh",
  });
  const [includeCaptions, setIncludeCaptions] = useState(true);
  const [includeCuts, setIncludeCuts] = useState(true);
  const [captionGrouping, setCaptionGrouping] = useState("phrases");

  const [job, setJob] = useState({ running: false, progress: 0, phase: "" });
  const [error, setError] = useState("");
  const [plan, setPlan] = useState(null);
  const [auditioningCaptionId, setAuditioningCaptionId] = useState(null);

  const abortRef = useRef(null);
  const auditionTimerRef = useRef(null);
  const isMinimizedRef = useRef(false);
  isMinimizedRef.current = isMinimized;
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (auditionTimerRef.current) {
        clearTimeout(auditionTimerRef.current);
      }
    };
  }, []);

  const visualSegments = options.visualSegments || [];
  const isVideo = (clip) => clip?.type === "video";
  const explicitClip = selectedClipId ? visualSegments.find((clip) => clip.id === selectedClipId) : null;
  const activeClip = explicitClip
    || (isVideo(options.selectedSegment) ? options.selectedSegment : null)
    || visualSegments.find(isVideo)
    || (options.selectedSegment ? visualSegments.find((clip) => clip.id === options.selectedSegment.id) : null)
    || visualSegments[0]
    || null;

  const clipIndex = visualSegments.findIndex((c) => c.id === activeClip?.id);
  const isSupported = Boolean(
    activeClip?.type === "video" &&
    canRemovePauses(activeClip, visualSegments[clipIndex - 1])
  );

  const stopAudition = () => {
    if (auditionTimerRef.current) {
      clearTimeout(auditionTimerRef.current);
      auditionTimerRef.current = null;
    }
    options.pauseTimelineMedia?.();
    options.setIsPlaying?.(false);
    setAuditioningCaptionId(null);
  };

  const open = (clipId, initialPlan) => {
    setIsMinimized(false);
    setIsOpen(true);
    // If analysis is already running or a plan is already active, keep existing session and progress
    if (job.running || plan) {
      return;
    }
    const defaultClip = (isVideo(options.selectedSegment) ? options.selectedSegment : null)
      || visualSegments.find(isVideo)
      || options.selectedSegment
      || visualSegments[0]
      || null;
    const targetId = clipId || defaultClip?.id;
    if (targetId) setSelectedClipId(targetId);
    setError("");
    if (initialPlan) {
      const targetClip = visualSegments.find((c) => c.id === targetId) || activeClip;
      const snapshot = latest.current.getSnapshot?.() || {};
      const runtime = latest.current.getRuntime?.() || {};
      const fp = browserProjectFingerprint(snapshot, false, runtime.visualSegments || [], runtime);
      const readyPlan = {
        clip: targetClip,
        fingerprint: initialPlan.fingerprint || fp,
        captionSegments: [],
        candidates: [],
        ...initialPlan,
      };
      setPlan(readyPlan);
      setIncludeCaptions(Boolean(readyPlan.captionSegments?.length > 0));
      setIncludeCuts(Boolean(readyPlan.candidates?.length > 0));
      setStage(readyPlan.captionSegments?.length > 0 ? "captions" : (readyPlan.candidates?.length > 0 ? "cuts" : "review"));
    } else {
      setStage("select");
    }
  };

  const close = () => {
    stopAudition();
    if (job.running) {
      abortRef.current?.abort();
      abortRef.current = null;
      setJob({ running: false, progress: 0, phase: "" });
    }
    setIsMinimized(false);
    setIsOpen(false);
    setError("");
  };

  const minimize = () => {
    setIsMinimized(true);
  };

  const restore = () => {
    setIsMinimized(false);
    setIsOpen(true);
  };

  const cancel = () => {
    stopAudition();
    abortRef.current?.abort();
    abortRef.current = null;
    setJob({ running: false, progress: 0, phase: "" });
    setError("");
    setStage("select");
    setIsMinimized(false);
  };

  const updateSettings = (patch) => {
    setSettings((prev) => ({ ...prev, ...patch }));
    setError("");
  };

  const startAnalysis = async () => {
    if (abortRef.current || job.running || !activeClip || !isSupported || options.locked) return;

    const snapshot = options.getSnapshot();
    const runtime = options.getRuntime();

    if (snapshot.trackLocks?.image) {
      setError("smartPipelineLocked");
      return;
    }
    if (settings.generateCaptions && snapshot.trackLocks?.caption) {
      setError("smartPipelineLocked");
      return;
    }
    if (settings.removeFillerWords && snapshot.trackLocks?.source && snapshot.sourceAudioLinked !== false && runtime.sourceAudioBlob) {
      setError("smartPipelineLocked");
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    const capturedClip = { ...activeClip };
    const fingerprint = browserProjectFingerprint(snapshot, false, runtime.visualSegments, runtime);

    setError("");
    setPlan(null);
    setStage("analyzing");
    setJob({ running: true, progress: 5, phase: "smartPipelineStepAnalyze" });

    try {
      // Step A: Detect speech and pauses using Silero VAD
      const probabilities = await analyzeVideoPauses(capturedClip, {
        language: settings.language || options.language,
        signal: controller.signal,
        onProgress: (progress, phase) => {
          if (!controller.signal.aborted) {
            setJob({
              running: true,
              progress: Math.min(50, Math.round(progress * 0.5)),
              phase: phase || "smartPipelineStepAnalyze",
            });
          }
        },
      });

      controller.signal.throwIfAborted();

      // Step B: Speech transcription for captions and filler words
      let transcriptResult = null;
      if (settings.generateCaptions || settings.removeFillerWords) {
        setJob({ running: true, progress: 55, phase: "smartPipelineStepCaptions" });
        if (Array.isArray(capturedClip.rawChunks) && capturedClip.rawChunks.length > 0) {
          transcriptResult = {
            rawChunks: capturedClip.rawChunks,
            text: capturedClip.transcriptText || "",
            duration: capturedClip.duration,
          };
        } else {
          try {
            const mediaBlob = capturedClip.blob || (
              capturedClip.src
                ? await fetch(capturedClip.src, { signal: controller.signal }).then((r) => r.blob())
                : null
            );
            if (mediaBlob) {
              const clipSourceStart = Number.isFinite(capturedClip.sourceStart) ? Math.max(0, capturedClip.sourceStart) : 0;
              const clipDuration = Number.isFinite(capturedClip.duration) ? Math.max(0, capturedClip.duration) : undefined;
              const playbackRate = Math.max(0.01, Number(capturedClip.playbackRate) || 1);
              const sourceDuration = clipDuration ? clipDuration * playbackRate : undefined;
              const clipBlob = (clipSourceStart > 0.001 || (Number.isFinite(sourceDuration) && sourceDuration > 0)) && typeof sliceAudioBlob === "function"
                ? await sliceAudioBlob(mediaBlob, clipSourceStart, sourceDuration)
                : mediaBlob;
              transcriptResult = await transcribeAudioToCaptionSegments(clipBlob, {
                preferredLanguage: settings.language || options.language,
                signal: controller.signal,
                onProgress: ({ progress, phase }) => {
                  if (!controller.signal.aborted) {
                    setJob({
                      running: true,
                      progress: Math.min(95, 50 + Math.round(progress * 0.45)),
                      phase: phase || "smartPipelineStepCaptions",
                    });
                  }
                },
              });
            }
          } catch (asrErr) {
            console.warn("[SmartPipeline] Transcription warning:", asrErr);
          }
        }
      }

      controller.signal.throwIfAborted();

      // Step C: Build unified plan
      const smartPlan = createSmartPipelinePlan({
        clip: capturedClip,
        probabilities,
        transcriptResult,
        settings,
      });

      smartPlan.fingerprint = fingerprint;
      smartPlan.probabilities = probabilities;
      setPlan(smartPlan);
      setIncludeCaptions(Boolean(settings.generateCaptions && smartPlan.captionSegments.length > 0));
      setIncludeCuts(Boolean(smartPlan.candidates.length > 0));

      setJob({ running: false, progress: 100, phase: "" });
      abortRef.current = null;

      // Navigate to next appropriate stage
      if (settings.generateCaptions && smartPlan.captionSegments.length > 0) {
        setStage("captions");
      } else {
        setStage("cuts");
      }

      if (isMinimizedRef.current) {
        const notifyMsg = options.t?.("smartPipelineComplete", "Smart Editing analysis complete! Click to review.")
          || "Smart Editing analysis complete!";
        options.notify?.(notifyMsg);
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        const errKey = failure.code || "smartPipelineFailed";
        setError(errKey);
        setStage("select");
        if (isMinimizedRef.current) {
          const errMsg = options.t?.(errKey, failure.message || "Smart Editing analysis failed.")
            || failure.message || "Smart Editing analysis failed.";
          options.notify?.(errMsg);
        }
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setJob({ running: false, progress: 0, phase: "" });
      }
    }
  };

  const toggleCut = (id) => {
    if (!plan) return;
    setError("");
    const updatedCandidates = plan.candidates.map((cut) => {
      if (cut.id !== id) return cut;
      const isCurrentlyEnabled = (cut.enabled ?? cut.selected ?? true) !== false;
      return { ...cut, enabled: !isCurrentlyEnabled, selected: !isCurrentlyEnabled };
    });
    const updatedMetrics = calculatePipelineMetrics(
      plan.clip.duration,
      updatedCandidates,
      plan.captionSegments
    );
    setPlan({
      ...plan,
      candidates: updatedCandidates,
      metrics: updatedMetrics,
    });
  };

  const toggleAllCuts = (enabled) => {
    if (!plan) return;
    setError("");
    const updatedCandidates = plan.candidates.map((cut) => ({
      ...cut,
      enabled,
      selected: enabled,
    }));
    const updatedMetrics = calculatePipelineMetrics(
      plan.clip.duration,
      updatedCandidates,
      plan.captionSegments
    );
    setPlan({
      ...plan,
      candidates: updatedCandidates,
      metrics: updatedMetrics,
    });
  };

  const updateCaptionSegment = (id, patch) => {
    if (!plan) return;
    const updatedSegments = plan.captionSegments.map((seg) =>
      seg.id === id ? { ...seg, ...patch } : seg
    );
    setPlan({
      ...plan,
      captionSegments: updatedSegments,
    });
  };

  const updateCaptionGrouping = (newGrouping) => {
    if (!plan || !plan.rawChunks?.length) return;
    setCaptionGrouping(newGrouping);
    const regrouped = regroupReviewSegments(plan.rawChunks, plan.clip.duration, {
      grouping: newGrouping,
    });
    if (regrouped.length) {
      const sanitized = regrouped.map((seg, idx) => {
        const rawStart = Number(seg.start);
        const start = Math.max(0, Number.isFinite(rawStart) ? rawStart : 0);
        const rawEnd = Number(seg.end);
        let end = Number.isFinite(rawEnd) ? Math.max(start + 0.2, rawEnd) : start + 0.2;
        if (end - start < 0.2) {
          end = start + 0.2;
        }
        return {
          ...seg,
          id: seg.id || `pipeline-cap-${idx}`,
          start,
          end,
          ...(Array.isArray(seg.words) ? {
            words: seg.words.map((w) => {
              const ws = Number(w.start);
              const we = Number(w.end);
              const validWs = Number.isFinite(ws) ? Math.max(start, ws) : start;
              const validWe = Number.isFinite(we) ? Math.max(validWs, Math.min(end, we)) : end;
              return {
                ...w,
                start: validWs,
                end: validWe,
              };
            }),
          } : {}),
        };
      });
      setPlan({
        ...plan,
        captionSegments: sanitized,
      });
    }
  };

  const previewCut = (cut) => {
    if (!plan || !activeClip) return;
    const clipStart = visualSegments
      .slice(0, clipIndex)
      .reduce((sum, c) => sum + c.duration, 0);
    options.seekTo?.(clipStart + Math.max(0, cut.start - 0.25));
  };

  const previewCaption = (seg) => {
    if (!plan || !activeClip || !seg) return;
    const targetId = seg.id || `${seg.start}-${seg.end}`;
    if (auditioningCaptionId === targetId) {
      stopAudition();
      return;
    }
    if (auditionTimerRef.current) {
      clearTimeout(auditionTimerRef.current);
      auditionTimerRef.current = null;
    }
    const clipStart = visualSegments
      .slice(0, clipIndex)
      .reduce((sum, c) => sum + c.duration, 0);
    const startSec = Math.max(0, Number(seg.start) || 0);
    const endSec = Math.max(startSec + 0.1, Number(seg.end) || startSec + 0.5);
    const startTime = clipStart + startSec;
    const durationMs = Math.max(250, (endSec - startSec) * 1000);

    options.seekTo?.(startTime);
    if (!options.isPlaying) {
      options.handlePlayToggle?.();
    }
    setAuditioningCaptionId(targetId);

    auditionTimerRef.current = setTimeout(() => {
      options.pauseTimelineMedia?.();
      options.setIsPlaying?.(false);
      setAuditioningCaptionId(null);
      auditionTimerRef.current = null;
    }, durationMs);
  };

  const apply = () => {
    if (!plan || job.running) return;

    const current = latest.current;
    const snapshot = current.getSnapshot();
    const runtime = current.getRuntime();
    const currentFingerprint = browserProjectFingerprint(
      snapshot,
      false,
      runtime.visualSegments,
      runtime
    );

    if (currentFingerprint !== plan.fingerprint) {
      setError("smartPipelineStale");
      return;
    }

    if (snapshot.trackLocks?.image) {
      setError("smartPipelineLocked");
      return;
    }
    if (includeCaptions && snapshot.trackLocks?.caption) {
      setError("smartPipelineLocked");
      return;
    }
    if (includeCuts && snapshot.sourceAudioLinked !== false && runtime.sourceAudioBlob && snapshot.trackLocks?.source) {
      setError("smartPipelineLocked");
      return;
    }

    try {
      const effectiveRipple = settings.rippleEditing !== undefined ? Boolean(settings.rippleEditing) : Boolean(current.rippleEditing);
      if (typeof current.setRippleEditing === "function" && current.rippleEditing !== effectiveRipple) {
        current.setRippleEditing(effectiveRipple);
      }

      const review = buildSmartPipelineReview({
        snapshot,
        runtime,
        clipId: plan.clip.id,
        approvedCuts: plan.candidates,
        approvedCaptions: plan.captionSegments,
        rippleEditing: effectiveRipple,
        includeCaptions,
        includeCuts,
      });

      current.applyReview(review, current.t("smartPipelineApplied"));
      setStage("applied");
      setError("");
    } catch (failure) {
      console.error("[SmartPipeline] apply failed code:", failure?.code, "message:", failure?.message, failure);
      if (failure.code === "BROWSER_EDIT_STALE_PLAN" || failure.code === "pipelineStale") {
        setError("smartPipelineStale");
      } else if (
        failure.code === "pipelineLocked" ||
        failure.code === "roughCutLocked" ||
        failure.code === "pauseLocked"
      ) {
        setError("smartPipelineLocked");
      } else if (
        failure.code === "pipelineTooShort" ||
        failure.code === "roughCutTooShort" ||
        failure.code === "pauseTooShort"
      ) {
        setError("smartPipelineTooShort");
      } else if (
        failure.code === "pipelineNoSelection" ||
        failure.code === "roughCutNoSelection" ||
        failure.code === "pauseNoSelection"
      ) {
        setError("smartPipelineNoSelection");
      } else if (failure.code === "pipelineClipUnsupported") {
        setError("smartPipelineClipUnsupported");
      } else if (failure.code?.startsWith("smartPipeline")) {
        setError(failure.code);
      } else if (failure.code?.startsWith("pipeline")) {
        const mapped = "smart" + failure.code.charAt(0).toUpperCase() + failure.code.slice(1);
        setError(mapped);
      } else {
        setError("smartPipelineFailed");
      }
    }
  };

  return {
    isOpen,
    stage,
    setStage,
    activeClip,
    selectedClipId,
    setSelectedClipId,
    isSupported,
    settings,
    updateSettings,
    includeCaptions,
    setIncludeCaptions,
    includeCuts,
    setIncludeCuts,
    captionGrouping,
    updateCaptionGrouping,
    job,
    error,
    plan,
    open,
    close,
    cancel,
    isMinimized,
    minimize,
    restore,
    startAnalysis,
    toggleCut,
    toggleAllCuts,
    updateCaptionSegment,
    previewCut,
    previewCaption,
    auditioningCaptionId,
    stopAudition,
    apply,
    rippleEditing: options.rippleEditing,
    setRippleEditing: options.setRippleEditing,
  };
}
