import { captureTranscriptionPreferences } from "./transcriptionPreferences.js";
import { attachTranscriptionOutcome, getTranscriptionOutcome } from "./transcriptionOutcome.js";
import { isTranscriptionCancellation, workflowTranscriptionOutcome, regroupWorkflowTranscript } from "./workflowTranscription.js";
import { makeId } from "./timeline.js";
import { canRemovePauses } from "./silenceRemoval.js";
import { findRoughCutCandidates, buildRoughCutReview, mergeCutCandidates } from "./roughCut.js";
import { detectVideoScenes } from "./sceneDetection.js";
import { analyzeVideoPauses } from "./sileroVad.js";
import { transcribeAudioToCaptionSegments } from "./asr.js";
import { browserProjectFingerprint } from "./browserEditPlan.js";

const AUTO_EDIT_LANGUAGE_TAGS = {
  zh: "zh-CN",
  en: "en",
  ja: "ja",
  ko: "ko",
  es: "es",
  fr: "fr",
  de: "de",
  pt: "pt-BR",
  th: "th",
  vi: "vi",
  it: "it",
  id: "id",
};

export function getAutoEditLanguage(language = "en") {
  return AUTO_EDIT_LANGUAGE_TAGS[language] || language || "en";
}

export function getAutoEditPromptLanguage(language = "en") {
  return getAutoEditLanguage(language);
}

/**
 * Backward compatibility probe for existing test scripts and capability checks.
 * Returns immediate local availability without requiring Chrome experimental AI flags.
 */
export async function probeBuiltInAI(language = "en") {
  return {
    availability: "available",
    reason: "",
    language: getAutoEditLanguage(language),
    promptLanguage: getAutoEditPromptLanguage(language),
  };
}

export function canRunAutoEdit(clip, previousClip, trackLocks = {}) {
  if (trackLocks?.image) return false;
  return Boolean(
    clip?.type === "video" &&
    Number(clip?.duration) > 0 &&
    canRemovePauses(clip, previousClip)
  );
}

export function calculateAutoEditMetrics(originalDuration = 0, candidates = [], captions = []) {
  const safeDuration = Math.max(0, Number(originalDuration) || 0);
  const enabledCuts = (candidates || []).filter((cut) => (cut.enabled ?? cut.selected ?? true) !== false);
  const mergedCuts = mergeCutCandidates(enabledCuts);
  const timeSaved = mergedCuts.reduce((sum, cut) => sum + (cut.end - cut.start), 0);
  const projectedDuration = Math.max(0, safeDuration - timeSaved);

  const pauseCount = (candidates || []).filter((cut) => cut.type === "pause" || cut.type === "merged").length;
  const fillerCount = (candidates || []).filter((cut) => cut.type === "filler").length;
  const sceneCount = (candidates || []).filter((cut) => cut.type === "scene").length;

  return {
    originalDuration: safeDuration,
    projectedDuration,
    timeSaved: Number(timeSaved.toFixed(3)),
    percentageReduced: safeDuration > 0 ? Math.round((timeSaved / safeDuration) * 100) : 0,
    totalCutsCount: candidates?.length || 0,
    enabledCutsCount: enabledCuts.length,
    pauseCount,
    fillerCount,
    sceneCount,
    captionCount: captions?.length || 0,
  };
}

/**
 * Executes the integrated smart Auto Edit analysis pipeline:
 * 1. Speech transcription with Whisper ASR (token-level timestamps)
 * 2. VAD pause detection with Silero VAD
 * 3. Filler word detection and candidate merging via Rough Cut
 * 4. Optional AI visual scene boundary detection
 */
export async function runAutoEditPipeline({
  clip,
  sourceAudioBlob = null,
  settings = {},
  onProgress = () => {},
  signal,
  onTranscriptionOutcome = () => { },
}) {
  const transcription = captureTranscriptionPreferences(settings.transcription);
  const duration = Number(clip?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw Object.assign(new Error("autoEditClipUnsupported"), { code: "autoEditClipUnsupported" });
  }

  const {
    transcribe = true,
    removePauses = true,
    removeFillerWords = true,
    detectScenes = false,
    threshold = 0.5,
    minimum = 0.8,
    keep = 0.3,
    language = "en",
  } = settings;

  onProgress?.(5, "autoEditPreparing");
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  // Step 1: VAD Silence / Pause Analysis
  let probabilities = null;
  if (removePauses) {
    onProgress?.(10, "autoEditFindingScenes");
    try {
      probabilities = await analyzeVideoPauses(clip, {
        language,
        signal,
        onProgress: (p, phase) => {
          if (!signal?.aborted) {
            onProgress?.(Number.isFinite(p) ? Math.min(45, 10 + Math.round(p * 0.35)) : 10, phase || "autoEditFindingScenes");
          }
        },
      });
    } catch (vadErr) {
      if (signal?.aborted) throw vadErr;
      console.warn("[AutoEdit] VAD pause analysis warning:", vadErr);
    }
  }

  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  // Step 2: Speech Transcription (Whisper) for Captions and Filler Words
  let transcriptResult = null;
  let outcome = null;
  if (transcribe || removeFillerWords) {
    onTranscriptionOutcome(null, { started: true, preferences: transcription });
    onProgress?.(50, "autoEditWritingCaptions");
    try {
      let audioBlob = sourceAudioBlob;
      if (!audioBlob && clip.blob instanceof Blob) {
        audioBlob = clip.blob;
      } else if (!audioBlob && typeof clip.src === "string") {
        try {
          const res = await fetch(clip.src, { signal });
          if (res.ok) audioBlob = await res.blob();
        } catch {
          // ignore fetch error
        }
      }

      if (audioBlob) {
        transcriptResult = await transcribeAudioToCaptionSegments(audioBlob, {
          preferredLanguage: language,
          ...transcription,
          signal,
          onProgress: ({ progress, phase }) => {
            if (!signal?.aborted) {
              onProgress?.(Number.isFinite(progress) ? Math.min(85, 50 + Math.round(progress * 0.35)) : 50, phase || "autoEditWritingCaptions");
            }
          },
        });
        outcome = getTranscriptionOutcome(transcriptResult);
      } else {
        outcome = workflowTranscriptionOutcome(null, transcription);
      }
    } catch (asrErr) {
      outcome = workflowTranscriptionOutcome(asrErr, transcription,
        isTranscriptionCancellation(asrErr, signal) ? "cancelled" : "failed");
      onTranscriptionOutcome(outcome);
      if (isTranscriptionCancellation(asrErr, signal)) throw asrErr;
      console.warn("[AutoEdit] Speech transcription warning:", asrErr);
    }
    onTranscriptionOutcome(outcome);
  }

  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  // Step 3: Scene Detection (Optional)
  let sceneResult = null;
  if (detectScenes) {
    onProgress?.(86, "autoEditFindingScenes");
    try {
      const videoSource = clip.blob || clip.src;
      if (videoSource) {
        sceneResult = await detectVideoScenes(videoSource, {
          onProgress: (p) => {
            if (!signal?.aborted) {
              onProgress?.(Math.min(95, 86 + Math.round(p * 0.09)), "autoEditFindingScenes");
            }
          },
        });
      }
    } catch (sceneErr) {
      if (signal?.aborted) throw sceneErr;
      console.warn("[AutoEdit] Scene detection warning:", sceneErr);
    }
  }

  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  // Step 4: Extract rough cut candidates (Pauses & Filler Words)
  const rawChunks = transcriptResult?.rawChunks || [];
  const rawSegments = transcriptResult?.segments || [];

  const roughCandidates = (removePauses || removeFillerWords)
    ? findRoughCutCandidates({
        probabilities,
        chunks: rawChunks,
        clip,
        settings: {
          threshold,
          minimum,
          keep,
          removeFillerWords,
        },
      })
    : [];

  const candidates = roughCandidates.map((c, idx) => ({
    ...c,
    id: c.id || `cut-${idx}`,
    enabled: true,
  }));

  // Step 5: Format Captions
  let captions = [];
  if (transcribe) {
    if (Array.isArray(rawSegments) && rawSegments.length > 0) {
      captions = rawSegments.map((seg) => ({
        ...seg,
        id: seg.id || makeId("caption"),
        start: Number(seg.start) || 0,
        end: Number(seg.end) || 0,
        text: String(seg.text || "").trim(),
        visualSegmentId: clip.id,
        ...(Array.isArray(seg.words) && seg.words.length > 0 ? {
          words: seg.words.map((w) => ({
            ...w,
            text: String(w.text || "").trim(),
            start: Number(w.start),
            end: Number(w.end),
          })),
        } : {}),
      }));
    } else if (rawChunks.length > 0) {
      captions = regroupWorkflowTranscript(rawChunks, duration, { grouping: "phrases" }).map((seg) => ({
        ...seg,
        visualSegmentId: clip.id,
      }));
    }
  }

  captions = attachTranscriptionOutcome(captions, outcome);
  const sceneBoundaries = sceneResult?.boundaries || [];
  const metrics = calculateAutoEditMetrics(duration, candidates, captions);
  onProgress?.(100, "autoEditDone");

  return attachTranscriptionOutcome({
    clip,
    candidates,
    sceneBoundaries,
    captions,
    rawChunks: attachTranscriptionOutcome(rawChunks, outcome),
    transcriptResult,
    metrics,
  }, outcome);
}

/**
 * Builds an atomic review plan for Auto Edit, ensuring:
 * - Existing captions on the timeline are preserved by default.
 * - Track locks are strictly validated.
 * - Stale plans are rejected via project fingerprinting.
 * - Multi-track ripple cuts across visual, audio, caption, and overlay tracks.
 */
export function buildAutoEditReview({
  snapshot,
  runtime,
  clipId,
  approvedCuts = [],
  approvedCaptions = [],
  approvedSceneBoundaries = [],
  rippleEditing = true,
  preserveCaptions = true,
  includeCuts = true,
  includeCaptions = true,
}) {
  const index = runtime.visualSegments.findIndex((c) => c.id === clipId);
  const live = runtime.visualSegments[index];
  if (!live || !canRemovePauses(live, runtime.visualSegments[index - 1])) {
    throw Object.assign(new Error("autoEditClipUnsupported"), { code: "autoEditClipUnsupported" });
  }

  // Validate track locks
  if (snapshot.trackLocks?.image && includeCuts && approvedCuts.length > 0) {
    throw Object.assign(new Error("autoEditTrackLocked"), { code: "autoEditTrackLocked" });
  }
  if (snapshot.trackLocks?.caption && includeCaptions && approvedCaptions.length > 0) {
    throw Object.assign(new Error("captionTrackLocked"), { code: "captionTrackLocked" });
  }
  if (runtime.sourceAudioBlob && snapshot.sourceAudioLinked !== false && snapshot.trackLocks?.source && includeCuts && approvedCuts.length > 0) {
    throw Object.assign(new Error("sourceAudioTrackLocked"), { code: "sourceAudioTrackLocked" });
  }

  const enabledCuts = includeCuts
    ? (approvedCuts || [])
        .filter((c) => (c.enabled ?? c.selected ?? true) !== false)
        .map((c) => ({ ...c, enabled: true }))
    : [];

  const hasCuts = enabledCuts.length > 0;
  const hasCaptions = includeCaptions && Array.isArray(approvedCaptions) && approvedCaptions.length > 0;

  if (!hasCuts && !hasCaptions && (!approvedSceneBoundaries || !approvedSceneBoundaries.length)) {
    throw Object.assign(new Error("autoEditNoSelection"), { code: "autoEditNoSelection" });
  }

  const clipStartOffset = runtime.visualSegments
    .slice(0, index)
    .reduce((sum, c) => sum + (c.duration || 0), 0);

  // Position captions relative to clip start offset
  let positionedCaptions = [];
  if (hasCaptions) {
    const alreadyOffset =
      clipStartOffset > 0.001 &&
      approvedCaptions.every((cap) => Number(cap.start) >= clipStartOffset - 0.05);
    const offsetToAdd = alreadyOffset ? 0 : clipStartOffset;

    positionedCaptions = approvedCaptions.map((cap) => ({
      ...cap,
      id: cap.id || makeId("caption"),
      start: Number((offsetToAdd + Number(cap.start)).toFixed(3)),
      end: Number((offsetToAdd + Number(cap.end)).toFixed(3)),
      visualSegmentId: clipId,
      ...(Array.isArray(cap.words) ? {
        words: cap.words.map((w) => ({
          ...w,
          text: String(w.text || "").trim(),
          start: Number((offsetToAdd + Number(w.start)).toFixed(3)),
          end: Number((offsetToAdd + Number(w.end)).toFixed(3)),
        })),
      } : {}),
    }));
  }

  // Preserve existing captions on the timeline outside this clip
  let mergedCaptions = positionedCaptions;
  const existingCaptions = Array.isArray(snapshot.captionSegments) ? snapshot.captionSegments : [];
  if (preserveCaptions && existingCaptions.length > 0) {
    const clipStart = clipStartOffset;
    const clipEnd = clipStartOffset + (Number(live.duration) || 0);
    const preserved = existingCaptions.filter((cap) => {
      const s = Number(cap.start) || 0;
      const e = Number(cap.end) || 0;
      return e <= clipStart + 0.05 || s >= clipEnd - 0.05;
    });
    mergedCaptions = [...preserved, ...positionedCaptions].sort((a, b) => (a.start || 0) - (b.start || 0));
  }

  // If cuts are present:
  if (hasCuts) {
    const working = structuredClone(snapshot);
    if (mergedCaptions.length > 0) {
      working.captionSegments = mergedCaptions;
      working.script = mergedCaptions.map((c) => c.text).join("\n");
      working.captionsEnabled = true;
    }

    try {
      const cutReview = buildRoughCutReview(
        working,
        runtime,
        clipId,
        enabledCuts,
        rippleEditing
      );

      return {
        ...cutReview,
        rippleEditing,
        fingerprint: browserProjectFingerprint(snapshot, rippleEditing, runtime.visualSegments, runtime),
        isAutoEdit: true,
        appliedCutsCount: enabledCuts.length,
        appliedCaptionsCount: positionedCaptions.length,
      };
    } catch (err) {
      if (err.code === "roughCutLocked" || err.code === "pauseLocked") {
        throw Object.assign(new Error("autoEditTrackLocked"), { code: "autoEditTrackLocked" });
      }
      if (err.code === "roughCutTooShort" || err.code === "pauseTooShort") {
        throw Object.assign(new Error("autoEditTooShort"), { code: "autoEditTooShort" });
      }
      if (err.code === "roughCutNoSelection" || err.code === "pauseNoSelection") {
        throw Object.assign(new Error("autoEditNoSelection"), { code: "autoEditNoSelection" });
      }
      throw err;
    }
  }

  // If only captions are being applied:
  const nextProject = structuredClone(snapshot);
  nextProject.captionSegments = mergedCaptions;
  nextProject.script = mergedCaptions.map((c) => c.text).join("\n");
  nextProject.captionsEnabled = true;

  return {
    project: nextProject,
    mediaOrigins: Object.create(null),
    hasChanges: true,
    rippleEditing,
    fingerprint: browserProjectFingerprint(snapshot, rippleEditing, runtime.visualSegments, runtime),
    duration: nextProject.visualSegments.reduce((sum, c) => sum + (c.duration || 0), 0),
    focusTime: positionedCaptions[0]?.start ?? clipStartOffset,
    rows: [{ changed: true, index, start: clipStartOffset }],
    isAutoEdit: true,
    appliedCutsCount: 0,
    appliedCaptionsCount: positionedCaptions.length,
  };
}

// Backward-compatibility stubs for legacy helper exports
export function normalizeGeneratedCaptions(value, duration) {
  const items = Array.isArray(value) ? value : value?.captions;
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      const start = Math.max(0, Math.min(Math.max(0, duration - 0.2), Number(item.start) || 0));
      const end = Math.max(start + 0.2, Math.min(duration, Number(item.end) || start + 2));
      return { id: makeId("caption"), text: String(item.text || "").trim(), start, end, hidden: false };
    })
    .filter((item) => item.text)
    .sort((a, b) => a.start - b.start);
}

export function normalizeClipCaptionTimings(captions, clipStart, clipEnd, preferredMinimum = 1.2) {
  if (!captions.length) return [];
  const safeStart = Math.max(0, Number(clipStart) || 0);
  const safeEnd = Math.max(safeStart + 0.2, Number(clipEnd) || safeStart + 0.2);
  const minimum = Math.min(preferredMinimum, (safeEnd - safeStart) / captions.length);
  const normalized = captions
    .map((caption) => ({
      ...caption,
      start: Math.max(safeStart, Math.min(safeEnd - 0.2, Number(caption.start) || safeStart)),
      end: Math.max(safeStart + 0.2, Math.min(safeEnd, Number(caption.end) || safeEnd)),
    }))
    .sort((a, b) => a.start - b.start);
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const caption = normalized[index];
    if (index < normalized.length - 1) caption.end = Math.min(caption.end, normalized[index + 1].start);
    if (caption.end - caption.start < minimum) caption.start = Math.max(safeStart, caption.end - minimum);
  }
  for (let index = 0; index < normalized.length - 1; index += 1) {
    normalized[index].end = Math.min(normalized[index].end, normalized[index + 1].start);
  }
  return normalized.filter((caption) => caption.end - caption.start >= 0.19);
}

export function createFrameCaptionSession() {
  return Promise.resolve({ destroy: () => {} });
}

export function createAutoEditTranslator() {
  return null;
}

export function extractAutoEditFrames() {
  return Promise.resolve([]);
}

export function generateFrameCaptions() {
  return Promise.resolve([]);
}

export function generateImageVoiceoverText() {
  return Promise.resolve("");
}
