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

export function useSmartPipeline(options) {
  const [isOpen, setIsOpen] = useState(false);
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

  const abortRef = useRef(null);
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => () => abortRef.current?.abort(), []);

  const visualSegments = options.visualSegments || [];
  const activeClip = visualSegments.find((clip) => clip.id === selectedClipId)
    || visualSegments.find((clip) => clip.id === options.selectedSegment?.id)
    || visualSegments.find((clip) => clip.type === "video")
    || visualSegments[0]
    || null;

  const clipIndex = visualSegments.findIndex((c) => c.id === activeClip?.id);
  const isSupported = Boolean(
    activeClip?.type === "video" &&
    canRemovePauses(activeClip, visualSegments[clipIndex - 1])
  );

  const open = (clipId, initialPlan) => {
    const targetId = clipId || activeClip?.id;
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
    setIsOpen(true);
  };

  const close = () => {
    if (job.running) {
      abortRef.current?.abort();
      abortRef.current = null;
      setJob({ running: false, progress: 0, phase: "" });
    }
    setIsOpen(false);
    setError("");
  };

  const cancel = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setJob({ running: false, progress: 0, phase: "" });
    setError("");
    setStage("select");
  };

  const updateSettings = (patch) => {
    setSettings((prev) => ({ ...prev, ...patch }));
    setError("");
  };

  const startAnalysis = async () => {
    if (abortRef.current || !activeClip || !isSupported || options.locked) return;

    const controller = new AbortController();
    abortRef.current = controller;
    const capturedClip = { ...activeClip };
    const snapshot = options.getSnapshot();
    const runtime = options.getRuntime();
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
              transcriptResult = await transcribeAudioToCaptionSegments(mediaBlob, {
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
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure.code || "smartPipelineFailed");
        setStage("select");
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
      setPlan({
        ...plan,
        captionSegments: regrouped,
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
    if (!plan || !activeClip) return;
    const clipStart = visualSegments
      .slice(0, clipIndex)
      .reduce((sum, c) => sum + c.duration, 0);
    options.seekTo?.(clipStart + Math.max(0, seg.start));
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
      setError(
        failure.code?.startsWith("pipeline") || failure.code?.startsWith("smart")
          ? failure.code
          : "smartPipelineFailed"
      );
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
    startAnalysis,
    toggleCut,
    toggleAllCuts,
    updateCaptionSegment,
    previewCut,
    previewCaption,
    apply,
    rippleEditing: options.rippleEditing,
    setRippleEditing: options.setRippleEditing,
  };
}
