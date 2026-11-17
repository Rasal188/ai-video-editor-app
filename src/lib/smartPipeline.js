import { browserProjectFingerprint } from "./browserEditPlan.js";
import { attachTranscriptionOutcome } from "./transcriptionOutcome.js";
import { regroupWorkflowTranscript } from "./workflowTranscription.js";
import {
  canRemovePauses,
  findRoughCutCandidates,
  buildRoughCutReview,
  mergeCutCandidates,
} from "./roughCut.js";
import {
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
  // Contract: Full-source transcription is retained and explicitly remapped
  // to clip-local coordinates using clip.sourceStart, duration, and playbackRate.
  const sourceStart = Math.max(0, Number(clip?.sourceStart) || 0);
  const playbackRate = Math.max(0.01, Number(clip?.playbackRate) || 1);
  const sourceWindowStart = sourceStart;
  const sourceWindowEnd = sourceStart + duration * playbackRate;

  // Compute clip-local rawChunks so review regrouping always operates on local coordinates
  const isChunkAlreadyClipLocal =
    sourceStart <= 0.001 ||
    (rawChunks.length > 0 &&
      !rawChunks.some((c) => Number(c?.timestamp?.[0]) >= sourceWindowStart - 0.05) &&
      rawChunks.every((c) => Number(c?.timestamp?.[1]) <= duration * playbackRate + 0.5));

  const localChunks = rawChunks
    .filter((c) => {
      if (isChunkAlreadyClipLocal) return true;
      const s = Number(c?.timestamp?.[0]);
      const e = Number(c?.timestamp?.[1]);
      if (!Number.isFinite(s) || !Number.isFinite(e)) return true;
      return e > sourceWindowStart + 0.001 && s < sourceWindowEnd - 0.001;
    })
    .map((c) => {
      if (isChunkAlreadyClipLocal) return c;
      const s = Number(c?.timestamp?.[0]);
      const e = Number(c?.timestamp?.[1]);
      if (!Number.isFinite(s) || !Number.isFinite(e)) return c;
      const localS = Math.max(0, (s - sourceWindowStart) / playbackRate);
      const localE = Math.min(duration, (e - sourceWindowStart) / playbackRate);
      return {
        ...c,
        timestamp: [Number(localS.toFixed(4)), Number(Math.max(localS + 0.01, localE).toFixed(4))],
      };
    });

  let captionSegments = [];
  if (Array.isArray(rawSegments) && rawSegments.length > 0) {
    const isSegmentAlreadyClipLocal =
      sourceStart <= 0.001 ||
      (!rawSegments.some((seg) => Number(seg.start) >= sourceWindowStart - 0.05) &&
        rawSegments.every((seg) => Number(seg.end) <= duration * playbackRate + 0.5));

    const remapped = [];
    for (let idx = 0; idx < rawSegments.length; idx++) {
      const seg = rawSegments[idx];
      const rawStart = Number(seg.start);
      const rawEnd = Number(seg.end);
      if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawEnd <= rawStart) {
        continue;
      }

      let localStart;
      let localEnd;

      if (isSegmentAlreadyClipLocal) {
        localStart = Math.max(0, rawStart);
        localEnd = Math.min(duration, rawEnd);
      } else {
        // Exclude segments completely outside the clip's source window
        if (rawEnd <= sourceWindowStart + 0.001 || rawStart >= sourceWindowEnd - 0.001) {
          continue;
        }
        // Explicitly remap timestamps using clip sourceStart and playbackRate
        localStart = Math.max(0, (rawStart - sourceWindowStart) / playbackRate);
        localEnd = Math.min(duration, (rawEnd - sourceWindowStart) / playbackRate);
      }

      if (localEnd - localStart < 0.001) {
        continue;
      }

      let start = Math.max(0, Number(localStart.toFixed(4)));
      let end = Math.min(duration, Number(localEnd.toFixed(4)));

      if (end - start < 0.2) {
        if (start + 0.2 <= duration) {
          end = start + 0.2;
        } else {
          end = duration;
          start = Math.max(0, duration - 0.2);
        }
      }

      const segmentWords = Array.isArray(seg.words) && seg.words.length > 0
        ? seg.words
            .map((w) => {
              const ws = Number(w.start);
              const we = Number(w.end);
              if (!Number.isFinite(ws) || !Number.isFinite(we) || we <= ws) return null;
              const localWs = isSegmentAlreadyClipLocal ? ws : (ws - sourceWindowStart) / playbackRate;
              const localWe = isSegmentAlreadyClipLocal ? we : (we - sourceWindowStart) / playbackRate;
              const validWs = Math.max(start, Math.min(end, localWs));
              const validWe = Math.max(validWs, Math.min(end, localWe));
              return {
                ...w,
                text: String(w.text || "").trim(),
                start: Number(validWs.toFixed(4)),
                end: Number(validWe.toFixed(4)),
              };
            })
            .filter(Boolean)
        : undefined;

      remapped.push({
        ...seg,
        id: seg.id || `pipeline-cap-${idx}`,
        start: Number(start.toFixed(4)),
        end: Number(end.toFixed(4)),
        text: String(seg.text || "").trim(),
        ...(segmentWords ? { words: segmentWords } : {}),
      });
    }
    captionSegments = remapped;
  } else if (localChunks.length > 0) {
    const rawGrouped = regroupWorkflowTranscript(localChunks, duration, { grouping: "phrases" });
    captionSegments = (rawGrouped || []).map((seg, idx) => {
      const rawStart = Number(seg.start);
      let start = Math.max(0, Number.isFinite(rawStart) ? rawStart : 0);
      const rawEnd = Number(seg.end);
      let end = Number.isFinite(rawEnd) ? Math.min(duration, Math.max(start + 0.2, rawEnd)) : Math.min(duration, start + 0.2);
      if (end - start < 0.2) {
        if (start + 0.2 <= duration) {
          end = start + 0.2;
        } else {
          end = duration;
          start = Math.max(0, duration - 0.2);
        }
      }
      return {
        ...seg,
        id: seg.id || `pipeline-cap-${idx}`,
        start: Number(start.toFixed(4)),
        end: Number(end.toFixed(4)),
        ...(Array.isArray(seg.words) ? {
          words: seg.words.map((w) => {
            const ws = Number(w.start);
            const we = Number(w.end);
            const validWs = Number.isFinite(ws) ? Math.max(start, ws) : start;
            const validWe = Number.isFinite(we) ? Math.max(validWs, Math.min(end, we)) : end;
            return {
              ...w,
              start: Number(validWs.toFixed(4)),
              end: Number(validWe.toFixed(4)),
            };
          }),
        } : {}),
      };
    });
  }

  captionSegments = attachTranscriptionOutcome(captionSegments, transcriptResult);
  const metrics = calculatePipelineMetrics(duration, candidates, captionSegments);

  return attachTranscriptionOutcome({
    clip,
    candidates,
    captionSegments,
    rawChunks: attachTranscriptionOutcome(localChunks, transcriptResult),
    transcriptResult,
    metrics,
  }, transcriptResult);
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

  if (hasCaptions && snapshot.trackLocks?.caption) {
    fail("pipelineLocked");
  }

  if (hasCuts && snapshot.sourceAudioLinked !== false && runtime.sourceAudioBlob && snapshot.trackLocks?.source) {
    fail("pipelineLocked");
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

      // Check if captions are already timeline-positioned relative to clipStartOffset
      const alreadyTimelineOffset =
        clipStartOffset > 0.001 &&
        approvedCaptions.length > 0 &&
        (
          approvedCaptions.some((cap) => cap.isTimelineOffset || cap.timelineOffset || cap.timeline) ||
          (
            approvedCaptions.every((cap) => Number(cap.start) >= clipStartOffset - 0.05) &&
            approvedCaptions.some((cap) => Number(cap.end) > live.duration + 0.05)
          )
        );
      const offsetToAdd = alreadyTimelineOffset ? 0 : clipStartOffset;

      // Convert captions to timeline coordinates relative to clipStartOffset and ensure MIN_TIMED_CAPTION_SECONDS
      const positionedCaptions = approvedCaptions.map((cap, i) => {
        const rawStart = offsetToAdd + Number(cap.start);
        const start = Math.max(0, Number.isFinite(rawStart) ? rawStart : 0);
        const rawEnd = offsetToAdd + Number(cap.end);
        let end = Number.isFinite(rawEnd) ? Math.max(start + 0.2, rawEnd) : start + 0.2;
        if (end - start < 0.2) {
          end = start + 0.2;
        }
        return {
          ...cap,
          id: cap.id || `cap-${i}-${Date.now()}`,
          start,
          end,
          ...(Array.isArray(cap.words) ? {
            words: cap.words.map((w) => {
              const ws = offsetToAdd + Number(w.start);
              const we = offsetToAdd + Number(w.end);
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

      // Preserve existing captions outside the target clip's timeline window
      const clipTimelineStart = clipStartOffset;
      const clipTimelineEnd = clipStartOffset + live.duration;
      const existingOtherCaptions = (snapshot.captionSegments || []).filter(
        (c) => Number(c.end) <= clipTimelineStart + 0.01 || Number(c.start) >= clipTimelineEnd - 0.01
      );
      const combinedCaptions = [...existingOtherCaptions, ...positionedCaptions].sort(
        (a, b) => (Number(a.start) || 0) - (Number(b.start) || 0)
      );

      working.captionSegments = combinedCaptions;
      working.script = combinedCaptions.map((c) => c.text).join("\n");
      working.captionsEnabled = true;
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

      if (hasCaptions) {
        cutReview.project.captionsEnabled = true;
      }

      return {
        ...cutReview,
        rippleEditing,
        fingerprint: browserProjectFingerprint(snapshot, rippleEditing, runtime.visualSegments, runtime),
        isSmartPipeline: true,
        appliedCutsCount: enabledCuts.length,
        appliedCaptionsCount: hasCaptions ? (cutReview.project.captionSegments?.length ?? approvedCaptions.length) : 0,
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
  const alreadyTimelineOffset =
    clipStartOffset > 0.001 &&
    approvedCaptions.length > 0 &&
    (
      approvedCaptions.some((cap) => cap.isTimelineOffset || cap.timelineOffset || cap.timeline) ||
      (
        approvedCaptions.every((cap) => Number(cap.start) >= clipStartOffset - 0.05) &&
        approvedCaptions.some((cap) => Number(cap.end) > live.duration + 0.05)
      )
    );
  const offsetToAdd = alreadyTimelineOffset ? 0 : clipStartOffset;

  const positionedCaptions = approvedCaptions.map((cap, i) => {
    const rawStart = offsetToAdd + Number(cap.start);
    const start = Math.max(0, Number.isFinite(rawStart) ? rawStart : 0);
    const rawEnd = offsetToAdd + Number(cap.end);
    let end = Number.isFinite(rawEnd) ? Math.max(start + 0.2, rawEnd) : start + 0.2;
    if (end - start < 0.2) {
      end = start + 0.2;
    }
    return {
      ...cap,
      id: cap.id || `cap-${i}-${Date.now()}`,
      start,
      end,
      ...(Array.isArray(cap.words) ? {
        words: cap.words.map((w) => {
          const ws = offsetToAdd + Number(w.start);
          const we = offsetToAdd + Number(w.end);
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

  // Preserve existing captions outside the target clip's timeline window
  const clipTimelineStart = clipStartOffset;
  const clipTimelineEnd = clipStartOffset + live.duration;
  const existingOtherCaptions = (snapshot.captionSegments || []).filter(
    (c) => Number(c.end) <= clipTimelineStart + 0.01 || Number(c.start) >= clipTimelineEnd - 0.01
  );
  const combinedCaptions = [...existingOtherCaptions, ...positionedCaptions].sort(
    (a, b) => (Number(a.start) || 0) - (Number(b.start) || 0)
  );

  nextProject.captionSegments = combinedCaptions;
  nextProject.script = combinedCaptions.map((c) => c.text).join("\n");
  nextProject.captionsEnabled = true;

  return {
    project: nextProject,
    mediaOrigins: Object.create(null),
    hasChanges: true,
    rippleEditing,
    fingerprint: browserProjectFingerprint(snapshot, rippleEditing, runtime.visualSegments, runtime),
    duration: nextProject.visualSegments.reduce((sum, clip) => sum + clip.duration, 0),
    focusTime: positionedCaptions[0]?.start ?? clipStartOffset,
    rows: [{ changed: true, index, start: clipStartOffset }],
    isSmartPipeline: true,
    appliedCutsCount: 0,
    appliedCaptionsCount: positionedCaptions.length,
  };
}
