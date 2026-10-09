import { browserProjectFingerprint } from "./browserEditPlan.js";
import {
  canRemovePauses,
  findRoughCutCandidates,
  buildRoughCutReview,
  mergeCutCandidates,
} from "./roughCut.js";
import {
  regroupReviewSegments,
  validateCaptionSegments,
} from "./transcriptReview.js";

const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};

export { canRemovePauses };

/**
 * Calculates metrics for proposed rough cuts and captions.
 *
 * @param {number} originalDuration - Original clip duration in seconds
 * @param {Array<Object>} candidates - Array of cut candidates
 * @param {Array<Object>} [captionSegments=[]] - Array of caption segments
 * @returns {Object} Calculated metrics
 */
export function calculatePipelineMetrics(originalDuration = 0, candidates = [], captionSegments = []) {
  const safeDuration = Math.max(0, Number(originalDuration) || 0);
  const enabledCuts = (candidates || []).filter((cut) => (cut.enabled ?? cut.selected ?? true) !== false);
  const mergedCuts = mergeCutCandidates(enabledCuts);
  const timeSaved = mergedCuts.reduce((sum, cut) => sum + (cut.end - cut.start), 0);
  const projectedDuration = Math.max(0, safeDuration - timeSaved);

  const pauseCount = (candidates || []).filter((cut) => cut.type === "pause" || cut.type === "merged").length;
  const fillerCount = (candidates || []).filter((cut) => cut.type === "filler").length;

  return {
    originalDuration: safeDuration,
    projectedDuration,
    timeSaved,
    percentageReduced: safeDuration > 0 ? Math.round((timeSaved / safeDuration) * 100) : 0,
    totalCutsCount: candidates?.length || 0,
    enabledCutsCount: enabledCuts.length,
    pauseCount,
    fillerCount,
    captionCount: captionSegments?.length || 0,
  };
}

/**
 * Creates a smart editing pipeline plan combining speech analysis and silence detection.
 *
 * @param {Object} params
 * @param {Object} params.clip - Target visual clip
 * @param {Float32Array|Array<number>} [params.probabilities] - Silero VAD probabilities
 * @param {Object} [params.transcriptResult] - ASR transcription result
 * @param {Object} [params.settings] - Analysis settings
 * @returns {Object} Smart pipeline plan
 */
export function createSmartPipelinePlan({
  clip,
  probabilities,
  transcriptResult,
  settings = {},
}) {
  const duration = Number(clip?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    fail("pipelineClipUnsupported");
  }

  const {
    threshold = 0.5,
    minimum = 0.8,
    keep = 0.3,
    removeFillerWords = true,
  } = settings;

  const rawChunks = transcriptResult?.rawChunks || [];
  const rawSegments = transcriptResult?.segments || [];

  // 1. Identify rough cut candidates (pauses and filler words)
  const candidates = findRoughCutCandidates({
    probabilities,
    chunks: rawChunks,
    clip,
    settings: {
      threshold,
      minimum,
      keep,
      removeFillerWords,
    },
  });

  // 2. Prepare captions
  let captionSegments = [];
  if (Array.isArray(rawSegments) && rawSegments.length > 0) {
    captionSegments = rawSegments.map((seg, idx) => ({
      id: seg.id || `pipeline-cap-${idx}`,
      start: Number(seg.start) || 0,
      end: Number(seg.end) || 0,
      text: String(seg.text || "").trim(),
      words: Array.isArray(seg.words) ? seg.words : [],
    }));
  } else if (rawChunks.length > 0) {
    captionSegments = regroupReviewSegments(rawChunks, duration, { grouping: "phrases" });
  }

  const metrics = calculatePipelineMetrics(duration, candidates, captionSegments);

  return {
    clip,
    candidates,
    captionSegments,
    rawChunks,
    transcriptResult,
    metrics,
  };
}

/**
 * Builds an atomic review plan for the entire smart editing pipeline.
 * Synchronously applies rough cuts and aligns captions in one single atomic review.
 *
 * @param {Object} params
 * @param {Object} params.snapshot - Project snapshot
 * @param {Object} params.runtime - Runtime state
 * @param {string} params.clipId - Target visual clip ID
 * @param {Array<Object>} [params.approvedCuts=[]] - Approved cut candidates
 * @param {Array<Object>} [params.approvedCaptions=[]] - Approved caption segments
 * @param {boolean} [params.rippleEditing=true] - Ripple editing across tracks
 * @param {boolean} [params.includeCaptions=true] - Whether to apply captions
 * @param {boolean} [params.includeCuts=true] - Whether to apply rough cuts
 * @returns {Object} Staged review plan ready for applyBrowserReview
 */
export function buildSmartPipelineReview({
  snapshot,
  runtime,
  clipId,
  approvedCuts = [],
  approvedCaptions = [],
  rippleEditing = true,
  includeCaptions = true,
  includeCuts = true,
}) {
  const index = runtime.visualSegments.findIndex((clip) => clip.id === clipId);
  const live = runtime.visualSegments[index];
  if (!live || !canRemovePauses(live, runtime.visualSegments[index - 1])) {
    fail("pipelineClipUnsupported");
  }

  if (snapshot.trackLocks?.image) {
    fail("pipelineLocked");
  }

  const enabledCuts = includeCuts
    ? (approvedCuts || [])
        .filter((cut) => (cut.enabled ?? cut.selected ?? true) !== false)
        .map((c) => ({ ...c, enabled: true }))
    : [];
  const hasCuts = enabledCuts.length > 0;
  const hasCaptions = includeCaptions && Array.isArray(approvedCaptions) && approvedCaptions.length > 0;

  if (!hasCuts && !hasCaptions) {
    fail("pipelineNoSelection");
  }

  const clipStartOffset = runtime.visualSegments
    .slice(0, index)
    .reduce((sum, clip) => sum + clip.duration, 0);

  // If cuts are to be applied:
  if (hasCuts) {
    // If captions are also to be applied, prepare snapshot with positioned captions
    // so buildRoughCutReview automatically ripples and trims them synchronously.
    let workingSnapshot = snapshot;
    if (hasCaptions) {
      const working = structuredClone(snapshot);
      // Validate captions first
      const validation = validateCaptionSegments(approvedCaptions);
      if (!validation.valid) {
        fail("pipelineCaptionsInvalid");
      }

      // Convert captions to timeline coordinates relative to clipStartOffset
      const positionedCaptions = approvedCaptions.map((cap, i) => ({
        ...cap,
        id: cap.id || `cap-${i}-${Date.now()}`,
        start: clipStartOffset + cap.start,
        end: clipStartOffset + cap.end,
      }));

      // If replacing or appending captions, put them in project.captionSegments
      working.captionSegments = positionedCaptions;
      working.script = positionedCaptions.map((c) => c.text).join("\n");
      workingSnapshot = working;
    }

    try {
      const cutReview = buildRoughCutReview(
        workingSnapshot,
        runtime,
        clipId,
        enabledCuts,
        rippleEditing
      );

      return {
        ...cutReview,
        fingerprint: browserProjectFingerprint(snapshot, rippleEditing, runtime.visualSegments, runtime),
        isSmartPipeline: true,
        appliedCutsCount: enabledCuts.length,
        appliedCaptionsCount: hasCaptions ? approvedCaptions.length : 0,
      };
    } catch (err) {
      if (err.code === "roughCutLocked" || err.code === "pauseLocked") {
        fail("pipelineLocked");
      }
      if (err.code === "roughCutTooShort" || err.code === "pauseTooShort") {
        fail("pipelineTooShort");
      }
      if (err.code === "roughCutNoSelection" || err.code === "pauseNoSelection") {
        fail("pipelineNoSelection");
      }
      throw err;
    }
  }

  // If only captions are to be applied (no cuts):
  const nextProject = structuredClone(snapshot);
  const positionedCaptions = approvedCaptions.map((cap, i) => ({
    ...cap,
    id: cap.id || `cap-${i}-${Date.now()}`,
    start: clipStartOffset + cap.start,
    end: clipStartOffset + cap.end,
  }));

  nextProject.captionSegments = positionedCaptions;
  nextProject.script = positionedCaptions.map((c) => c.text).join("\n");

  return {
    project: nextProject,
    mediaOrigins: Object.create(null),
    hasChanges: true,
    fingerprint: browserProjectFingerprint(snapshot, rippleEditing, runtime.visualSegments, runtime),
    duration: nextProject.visualSegments.reduce((sum, clip) => sum + clip.duration, 0),
    focusTime: positionedCaptions[0]?.start ?? clipStartOffset,
    rows: [{ changed: true, index, start: clipStartOffset }],
    isSmartPipeline: true,
    appliedCutsCount: 0,
    appliedCaptionsCount: positionedCaptions.length,
  };
}
