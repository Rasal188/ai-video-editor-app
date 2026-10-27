import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_SCENE_DETECTION_SETTINGS,
  normalizeSceneDetectionSettings,
  detectVideoScenes,
  detectScenesFromSignatures,
} from "../lib/sceneDetection.js";
import {
  validateSceneCutBoundaries,
  splitVisualSegmentAtBoundaries,
} from "../lib/timelineCutActions.js";

export { validateSceneCutBoundaries, splitVisualSegmentAtBoundaries };

/**
 * Checks whether the given timeline segment can undergo scene detection.
 *
 * @param {Object} segment
 * @returns {boolean}
 */
export function canDetectScenes(segment) {
  if (!segment || segment.type !== "video") return false;
  const duration = Number(segment.duration);
  return Number.isFinite(duration) && duration > 0;
}

/**
 * Calculates absolute timeline position for a boundary within a clip given all visual track segments.
 *
 * @param {Array<Object>} visualSegments
 * @param {string|number} segmentId
 * @param {number} boundaryTime
 * @returns {number}
 */
export function calculateBoundaryTimelineOffset(visualSegments = [], segmentId, boundaryTime = 0) {
  const clipIndex = visualSegments.findIndex((c) => c?.id === segmentId);
  const clipStart = clipIndex >= 0
    ? visualSegments.slice(0, clipIndex).reduce((sum, c) => sum + (Number(c?.duration) || 0), 0)
    : 0;
  return Number((clipStart + Math.max(0, Number(boundaryTime) || 0)).toFixed(3));
}

/**
 * Toggles a boundary timestamp in the selected boundaries array.
 * Returns a new sorted array.
 *
 * @param {number[]} currentList
 * @param {number} time
 * @returns {number[]}
 */
export function toggleBoundarySelection(currentList = [], time) {
  const safeTime = Number(Number(time).toFixed(3));
  const exists = currentList.some((t) => Math.abs(t - safeTime) < 0.005);
  if (exists) {
    return currentList.filter((t) => Math.abs(t - safeTime) >= 0.005);
  }
  return [...currentList, safeTime].sort((a, b) => a - b);
}

/**
 * Builds contiguous scene intervals from approved boundaries and video duration.
 *
 * @param {Object} draft - Scene detection draft result
 * @param {number[]} selectedBoundaries - Array of selected cut timestamps in seconds
 * @returns {Array<{ index: number, start: number, end: number, duration: number }>}
 */
export function buildApprovedScenePlan(draft, selectedBoundaries = []) {
  const duration = Number(draft?.duration) || 0;
  if (duration <= 0) return [];

  const sortedCuts = [...selectedBoundaries]
    .map((t) => Number(Number(t).toFixed(3)))
    .filter((t) => t > 0 && t < duration)
    .sort((a, b) => a - b);

  const scenes = [];
  let start = 0;

  for (let i = 0; i < sortedCuts.length; i++) {
    const end = sortedCuts[i];
    scenes.push({
      index: i,
      start,
      end,
      duration: Number((end - start).toFixed(3)),
    });
    start = end;
  }

  scenes.push({
    index: scenes.length,
    start,
    end: duration,
    duration: Number((duration - start).toFixed(3)),
  });

  return scenes;
}

/**
 * React hook driving the Scene Detection UI workflow and review modal.
 *
 * @param {Object} options
 * @param {Object} [options.selectedSegment] - Current timeline selection
 * @param {Array<Object>} [options.visualSegments] - Timeline visual segments
 * @param {string|number} [options.projectVersion] - Project revision fingerprint
 * @param {boolean} [options.locked] - Whether the visual track is locked
 * @param {Function} [options.seekTo] - Video preview seek function
 * @param {Function} [options.notify] - User toast notification function
 * @param {Function} [options.t] - Localization translator
 * @param {Function} [options.onApplyApproved] - Optional callback when boundaries are approved
 * @param {Function} [options.onApplyCuts] - Optional callback to apply cuts to timeline
 * @returns {Object} Scene detection tool controller
 */
export function useSceneDetection(options = {}) {
  const {
    selectedSegment: segment,
    visualSegments = [],
    projectVersion,
    locked = false,
    seekTo,
    handlePlayToggle,
    pauseTimelineMedia,
    setIsPlaying,
    isPlaying = false,
    notify,
    t = (k, fb) => fb || k,
    onApplyApproved,
    onApplyCuts,
  } = options;

  const [isOpen, setIsOpen] = useState(false);
  const [settings, setSettings] = useState({
    sampleInterval: DEFAULT_SCENE_DETECTION_SETTINGS.sampleInterval,
    threshold: DEFAULT_SCENE_DETECTION_SETTINGS.threshold,
    minSceneDuration: DEFAULT_SCENE_DETECTION_SETTINGS.minSceneDuration,
  });
  const [draft, setDraft] = useState(null);
  const [selectedBoundaries, setSelectedBoundaries] = useState([]);
  const [currentSceneIndex, setCurrentSceneIndex] = useState(0);
  const [job, setJob] = useState({ running: false, progress: 0, phase: "" });
  const [error, setError] = useState("");
  const [previewingTime, setPreviewingTime] = useState(null);

  const abortRef = useRef(null);
  const previewTimerRef = useRef(null);

  const stopPreview = () => {
    if (previewTimerRef.current) {
      clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
    pauseTimelineMedia?.();
    setIsPlaying?.(false);
    setPreviewingTime(null);
  };

  // Clean up any ongoing analysis or preview playback if unmounted
  useEffect(() => () => {
    stopPreview();
    abortRef.current?.abort();
  }, []);

  const supported = canDetectScenes(segment);
  const stale = Boolean(draft && (draft.clipId !== segment?.id || draft.version !== projectVersion));

  const open = (prefilledResult = null) => {
    setError("");
    setIsOpen(true);
    if (prefilledResult) {
      setDraft(prefilledResult);
      setSelectedBoundaries((prefilledResult.boundaries || []).map((b) => b.time));
      setCurrentSceneIndex(0);
    }
  };

  const close = () => {
    stopPreview();
    if (job.running) cancel();
    setIsOpen(false);
  };

  const dismiss = () => {
    close();
  };

  const cancel = () => {
    stopPreview();
    abortRef.current?.abort();
    abortRef.current = null;
    setJob({ running: false, progress: 0, phase: "" });
  };

  const updateSettings = (partial) => {
    setSettings((prev) => normalizeSceneDetectionSettings({ ...prev, ...partial }));
  };

  const run = async (testFrameProvider = null) => {
    if (job.running) return;
    if (!supported && !testFrameProvider) {
      setError("sceneDetectUnsupported");
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    setError("");
    setJob({ running: true, progress: 5, phase: "sceneDetectPreparing" });

    let lastProgress = 5;
    const handleProgress = (progressPercent, meta) => {
      if (controller.signal.aborted) return;
      const rawPercent = typeof progressPercent === "number"
        ? progressPercent
        : (meta?.processed && meta?.total ? (meta.processed / meta.total) * 100 : 0);
      const mapped = Math.min(95, Math.max(10, Math.round(10 + (Math.max(0, Math.min(100, rawPercent)) / 100) * 85)));
      if (mapped > lastProgress) {
        lastProgress = mapped;
        setJob({
          running: true,
          progress: mapped,
          phase: "sceneDetectAnalyzing",
        });
      }
    };

    try {
      const clipDuration = Number(segment?.duration) || 0;
      let result;

      if (typeof testFrameProvider === "function") {
        // Test/mock injection path
        setJob({ running: true, progress: 10, phase: "sceneDetectAnalyzing" });
        const samples = await testFrameProvider(controller.signal, handleProgress);
        controller.signal.throwIfAborted();
        result = detectScenesFromSignatures(samples, {
          ...settings,
          duration: clipDuration,
        });
      } else {
        // Real browser video extraction path
        result = await detectVideoScenes(segment?.src || segment?.blob || segment?.videoElement, {
          ...settings,
          duration: clipDuration,
          signal: controller.signal,
          onProgress: handleProgress,
        });
      }

      controller.signal.throwIfAborted();

      const populatedDraft = {
        ...result,
        clipId: segment?.id,
        version: projectVersion,
      };

      setDraft(populatedDraft);
      setSelectedBoundaries((populatedDraft.boundaries || []).map((b) => b.time));
      setCurrentSceneIndex(0);
      setJob({ running: false, progress: 100, phase: "" });
    } catch (err) {
      if (err.name === "AbortError" || controller.signal.aborted) {
        setJob({ running: false, progress: 0, phase: "" });
        return;
      }
      setJob({ running: false, progress: 0, phase: "" });
      setError(err.message?.includes("UNSUPPORTED") ? "sceneDetectUnsupported" : "sceneDetectFailed");
    } finally {
      abortRef.current = null;
    }
  };

  const toggleBoundary = (time) => {
    setSelectedBoundaries((prev) => toggleBoundarySelection(prev, time));
  };

  const toggleAll = (enabled) => {
    if (enabled) {
      setSelectedBoundaries((draft?.boundaries || []).map((b) => b.time));
    } else {
      setSelectedBoundaries([]);
    }
  };

  const previewTime = (time, duration = 2.5) => {
    if (!Number.isFinite(time)) return;

    // Toggle off if already previewing this boundary
    if (previewingTime !== null && Math.abs(previewingTime - time) < 0.01) {
      stopPreview();
      return;
    }

    if (previewTimerRef.current) {
      clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }

    try {
      const targetTimelineTime = calculateBoundaryTimelineOffset(visualSegments, segment?.id, time);

      if (typeof seekTo === "function") {
        seekTo(targetTimelineTime, { immediate: true, play: true });
      }

      if (!isPlaying) {
        handlePlayToggle?.();
      } else {
        setIsPlaying?.(true);
      }

      setPreviewingTime(time);

      // Auto-stop preview after duration
      previewTimerRef.current = setTimeout(() => {
        stopPreview();
      }, Math.max(500, Math.round(duration * 1000)));
    } catch (err) {
      console.warn("Scene boundary preview failed:", err);
      stopPreview();
      notify?.(t("sceneDetectPreviewFailed", "Unable to preview scene boundary frame."));
    }
  };

  const navigateToScene = (index) => {
    if (!draft?.scenes?.length) return;
    const clamped = Math.max(0, Math.min(index, draft.scenes.length - 1));
    setCurrentSceneIndex(clamped);
    const scene = draft.scenes[clamped];
    if (scene) {
      previewTime(scene.start, scene.duration || 2.5);
    }
  };

  const prevScene = () => navigateToScene(currentSceneIndex - 1);
  const nextScene = () => navigateToScene(currentSceneIndex + 1);

  const apply = () => {
    const approvedScenes = buildApprovedScenePlan(draft, selectedBoundaries);
    // Non-destructive: Preserve timeline clips unmodified, record approved boundaries
    notify?.(t("sceneDetectApproved", "Scene boundaries approved. Timeline remains unmodified."));
    onApplyApproved?.({
      clipId: segment?.id,
      boundaries: selectedBoundaries,
      scenes: approvedScenes,
      draft,
    });
    setIsOpen(false);
    return { success: true, approvedBoundaries: selectedBoundaries, approvedScenes };
  };

  const applyCuts = () => {
    if (!segment) {
      notify?.(t("sceneDetectSelect", "Select a video on the main visual track."));
      return { success: false, reason: "NO_SEGMENT" };
    }
    if (locked) {
      notify?.(t("sceneDetectClipLocked", "Visual track is locked. Unlock it to cut clips."));
      return { success: false, reason: "LOCKED" };
    }
    if (!draft) {
      return { success: false, reason: "NO_DRAFT" };
    }
    if (stale) {
      notify?.(t("sceneDetectStale", "The project or clip changed. Analyze again."));
      return { success: false, reason: "STALE" };
    }
    const approvedScenes = buildApprovedScenePlan(draft, selectedBoundaries);
    const validBoundaries = validateSceneCutBoundaries(selectedBoundaries, segment.duration);
    if (!validBoundaries.length) {
      notify?.(t("sceneDetectNoBoundaries", "No valid scene boundaries selected"));
      return { success: false, reason: "NO_BOUNDARIES" };
    }

    if (typeof onApplyCuts === "function") {
      const res = onApplyCuts({
        clipId: segment?.id,
        boundaries: validBoundaries,
        scenes: approvedScenes,
        draft,
      });
      if (res?.success !== false) {
        setIsOpen(false);
      }
      return res || { success: true };
    }

    setIsOpen(false);
    return { success: true, approvedBoundaries: validBoundaries, approvedScenes };
  };

  return {
    isOpen,
    open,
    close,
    dismiss,
    supported,
    stale,
    locked,
    segment,
    visualSegments,
    settings,
    updateSettings,
    job,
    error,
    draft,
    selectedBoundaries,
    currentSceneIndex,
    previewingTime,
    stopPreview,
    run,
    cancel,
    toggleBoundary,
    toggleAll,
    previewTime,
    navigateToScene,
    prevScene,
    nextScene,
    apply,
    applyCuts,
  };
}
