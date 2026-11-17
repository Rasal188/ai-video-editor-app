import { useCallback, useEffect, useRef, useState } from "react";
import { attachTranscriptionOutcome, getTranscriptionOutcome } from "../lib/transcriptionOutcome.js";
import { cancelledWorkflowTranscription, isTranscriptionCancellation, workflowTranscriptionStatus } from "../lib/workflowTranscription.js";
import {
  canRunAutoEdit,
  runAutoEditPipeline,
  buildAutoEditReview,
  probeBuiltInAI,
  getAutoEditLanguage,
} from "../lib/autoEdit.js";
import { makeId } from "../lib/timeline.js";

export function useAutoEdit(options = {}) {
  const {
    language = "en",
    selectedSegment,
    visualSegments = [],
    captionSegments = [],
    commitCaptionSegments,
    setCaptionsEnabled,
    setTrackVisibility,
    setSelectedSegmentId,
    setSelectedTrack,
    trackLocks = {},
    sourceAudioBlob = null,
    sourceAudioLinked: _sourceAudioLinked = true,
    rippleEditing: globalRipple = true,
    getSnapshot,
    getRuntime,
    applyReview,
    seekTo: _seekTo,
    notify = () => {},
    t = (k, fb) => fb || k,
  } = options;

  const [support, setSupport] = useState({
    availability: "available",
    reason: "",
    language: getAutoEditLanguage(language),
  });

  const [settings, setSettings] = useState({
    transcribe: true,
    removePauses: true,
    removeFillerWords: true,
    detectScenes: false,
    preserveCaptions: true,
    rippleEditing: globalRipple,
    threshold: 0.5,
    minimum: 0.8,
    keep: 0.3,
  });

  const [job, setJob] = useState({ running: false, progress: 0, phase: "" });
  const [review, setReview] = useState({
    open: false,
    clip: null,
    candidates: [],
    captions: [],
    sceneBoundaries: [],
    metrics: null,
    error: "",
  });

  const abortRef = useRef(null);

  useEffect(() => {
    setSupport((prev) => ({
      ...prev,
      language: getAutoEditLanguage(language),
    }));
  }, [language]);

  const isVideo = (clip) => clip?.type === "video";
  const activeClip = (isVideo(selectedSegment) ? selectedSegment : null)
    || visualSegments.find(isVideo)
    || (selectedSegment ? visualSegments.find((clip) => clip.id === selectedSegment.id) : null)
    || visualSegments[0]
    || null;

  const clipIndex = visualSegments.findIndex((c) => c.id === activeClip?.id);
  const isSupported = Boolean(activeClip && canRunAutoEdit(activeClip, visualSegments[clipIndex - 1], trackLocks));

  const checkSupport = useCallback(async () => {
    const result = await probeBuiltInAI(language);
    setSupport(result);
    return result;
  }, [language]);

  const prepareSupport = useCallback(async () => {
    return checkSupport();
  }, [checkSupport]);

  const updateSettings = useCallback((patch) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const toggleCut = useCallback((cutId) => {
    setReview((prev) => {
      const candidates = prev.candidates.map((c) => (c.id === cutId ? { ...c, enabled: !c.enabled } : c));
      return { ...prev, candidates };
    });
  }, []);

  const toggleCaption = useCallback((captionId) => {
    setReview((prev) => {
      const captions = prev.captions.map((c) => (c.id === captionId ? { ...c, hidden: !c.hidden } : c));
      return { ...prev, captions };
    });
  }, []);

  const run = useCallback(async () => {
    if (!visualSegments.length || job.running) return;

    if (!activeClip) {
      notify(t("autoEditNeedsVisual", "Please add a video clip first"));
      return;
    }

    if (trackLocks?.image) {
      notify(t("autoEditTrackLocked", "Visual track is locked. Please unlock it to auto edit."));
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setReview({
      open: true,
      clip: activeClip,
      candidates: [],
      captions: [],
      sceneBoundaries: [],
      metrics: null,
      error: "",
    });

    setJob({ running: true, progress: 5, phase: t("autoEditPreparing", "Preparing media analysis...") });

    try {
      const result = await runAutoEditPipeline({
        clip: activeClip,
        visualSegments,
        sourceAudioBlob,
        settings: {
          ...settings,
          language,
        },
        onProgress: (progress, phaseKey) => {
          if (!controller.signal.aborted) setJob((current) => ({ ...current, running: true, progress, phase: t(phaseKey, phaseKey) }));
        },
        onTranscriptionOutcome: (outcome, state) => {
          if (state?.started) {
            controller.transcriptionStarted = true;
            controller.transcriptionPreferences = state.preferences;
          }
          controller.transcriptionOutcome = outcome;
          if (!controller.signal.aborted && outcome) setJob((current) => attachTranscriptionOutcome(current, outcome));
        },
        signal: controller.signal,
      });

      controller.signal.throwIfAborted();
      if (abortRef.current !== controller) return;
      setReview(attachTranscriptionOutcome({
        open: true,
        clip: activeClip,
        candidates: result.candidates || [],
        captions: result.captions || [],
        sceneBoundaries: result.sceneBoundaries || [],
        metrics: result.metrics || null,
        error: "",
      }, result));

      const status = workflowTranscriptionStatus(result);
      setJob(attachTranscriptionOutcome({
        running: false, progress: 100,
        phase: [t("autoEditDone", "Auto edit complete"), status].filter(Boolean).join(" ")
      }, result));
      if (status) notify(status);
    } catch (err) {
      if (abortRef.current !== controller) return;
      const outcome = getTranscriptionOutcome(err) || controller.transcriptionOutcome;
      if (isTranscriptionCancellation(err, controller.signal)) {
        const status = workflowTranscriptionStatus(outcome);
        setReview((prev) => attachTranscriptionOutcome(prev, outcome));
        setJob(attachTranscriptionOutcome({ running: false, progress: 0, phase: status }, outcome));
        if (status) notify(status);
        return;
      }
      console.error("[useAutoEdit] pipeline failed:", err);
      const errMsg = err?.message || String(err);
      setReview((prev) => attachTranscriptionOutcome({ ...prev, error: errMsg }, outcome));
      setJob(attachTranscriptionOutcome({ running: false, progress: 0, phase: workflowTranscriptionStatus(outcome) }, outcome));
      notify(t("autoEditFailed", "Auto Edit failed: ") + errMsg + " " + workflowTranscriptionStatus(outcome));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [activeClip, job.running, language, notify, settings, sourceAudioBlob, t, trackLocks, visualSegments]);

  const cancel = useCallback(() => {
    const controller = abortRef.current;
    controller?.abort();
    abortRef.current = null;
    const outcome = cancelledWorkflowTranscription(controller, controller?.transcriptionPreferences);
    const status = workflowTranscriptionStatus(outcome);
    setReview((prev) => attachTranscriptionOutcome(prev, outcome));
    setJob((current) => attachTranscriptionOutcome({ ...current, running: false, progress: 0, phase: status }, outcome));
    if (status) notify(status);
  }, [notify]);

  const closeReview = useCallback(() => {
    if (job.running) cancel();
    setJob({ running: false, progress: 0, phase: "" });
    setReview({
      open: false,
      clip: null,
      candidates: [],
      captions: [],
      sceneBoundaries: [],
      metrics: null,
      error: "",
    });
  }, [job.running, cancel]);

  const applyCaptions = useCallback(async () => {
    if (!review.clip) return;

    const enabledCuts = (review.candidates || []).filter((c) => (c.enabled ?? true) !== false);
    const activeCaptions = (review.captions || []).filter((c) => !c.hidden);

    if (!enabledCuts.length && !activeCaptions.length && !review.sceneBoundaries?.length) {
      notify(t("autoEditNoSelection", "No cuts or captions selected to apply."));
      return;
    }

    try {
      if (typeof applyReview === "function" && typeof getSnapshot === "function" && typeof getRuntime === "function") {
        const snapshot = getSnapshot();
        const runtime = getRuntime();

        const reviewPlan = buildAutoEditReview({
          snapshot,
          runtime,
          clipId: review.clip.id,
          approvedCuts: enabledCuts,
          approvedCaptions: activeCaptions,
          approvedSceneBoundaries: review.sceneBoundaries,
          rippleEditing: settings.rippleEditing,
          preserveCaptions: settings.preserveCaptions,
          includeCuts: settings.removePauses || settings.removeFillerWords,
          includeCaptions: settings.transcribe,
        });

        applyReview(reviewPlan, t("autoEditDone", "Auto edit applied to timeline"));
      } else if (typeof commitCaptionSegments === "function" && activeCaptions.length) {
        // Fallback for caption-only commit if atomic review engine is unavailable
        const finalCaptions = settings.preserveCaptions && captionSegments.length
          ? [...captionSegments, ...activeCaptions].sort((a, b) => (a.start || 0) - (b.start || 0))
          : activeCaptions;

        commitCaptionSegments(finalCaptions);
        setCaptionsEnabled?.(true);
        setTrackVisibility?.((v) => ({ ...v, caption: true }));
        setSelectedTrack?.("caption");
        if (activeCaptions[0]?.id) setSelectedSegmentId?.(activeCaptions[0].id);
        notify(t("autoEditDone", "Captions added to timeline"));
      }

      closeReview();
    } catch (err) {
      console.error("[useAutoEdit] apply failed:", err);
      if (err.code === "BROWSER_EDIT_STALE_PLAN") {
        notify(t("autoEditStalePlan", "Timeline changed during analysis. Please run Auto Edit again."));
      } else if (err.code === "autoEditTrackLocked" || err.code === "captionTrackLocked" || err.code === "pipelineLocked") {
        notify(t("autoEditTrackLocked", "Track is locked. Please unlock it to apply edits."));
      } else {
        notify(t("autoEditFailed", "Failed to apply edits: ") + (err?.message || ""));
      }
    }
  }, [
    applyReview,
    captionSegments,
    closeReview,
    commitCaptionSegments,
    getRuntime,
    getSnapshot,
    notify,
    review,
    setCaptionsEnabled,
    setSelectedSegmentId,
    setSelectedTrack,
    setTrackVisibility,
    settings.preserveCaptions,
    settings.removeFillerWords,
    settings.removePauses,
    settings.rippleEditing,
    settings.transcribe,
    t,
  ]);

  // Backward compatibility helper for Timeline context menu
  const generateImageCaption = useCallback(async (segment) => {
    if (!segment?.src || segment.type === "video") return;
    const index = visualSegments.findIndex((item) => item.id === segment.id);
    if (index < 0) return;
    const start = visualSegments.slice(0, index).reduce((sum, item) => sum + Math.max(0, Number(item.duration) || 0), 0);
    const end = start + Math.max(0.2, Number(segment.duration) || 0.2);

    const caption = {
      id: makeId("caption"),
      text: segment.name ? `[${segment.name}]` : t("imageCaptionDefault", "Visual scene"),
      start,
      end,
      hidden: false,
      visualSegmentId: segment.id,
    };
    const next = [...captionSegments, caption].sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0));
    commitCaptionSegments?.(next, t("imageAiCaptionAdded", "Caption added"), next.findIndex((item) => item.id === caption.id));
    setCaptionsEnabled?.(true);
    setTrackVisibility?.((visibility) => ({ ...visibility, caption: true }));
    setSelectedTrack?.("caption");
    setSelectedSegmentId?.(caption.id);
    notify(t("imageAiCaptionAdded", "Caption added"));
  }, [captionSegments, commitCaptionSegments, notify, setCaptionsEnabled, setSelectedSegmentId, setSelectedTrack, setTrackVisibility, t, visualSegments]);

  return {
    support,
    settings,
    updateSettings,
    job,
    review,
    activeClip,
    isSupported,
    checkSupport,
    prepareSupport,
    run,
    cancel,
    closeReview,
    applyCaptions,
    applyReview: applyCaptions,
    toggleCut,
    toggleCaption,
    generateImageCaption,
  };
}
