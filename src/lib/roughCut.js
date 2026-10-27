import { MIN_VISUAL_SEGMENT_SECONDS } from "../config/editor.js";
import {
  canRemovePauses,
  findPauseCandidates,
  retainedRanges,
  collapseTime,
  buildSilenceRemovalReview,
} from "./silenceRemoval.js";

const EPS = 0.000001;

export { canRemovePauses, retainedRanges, collapseTime };

export const DEFAULT_FILLER_WORDS = Object.freeze(new Set([
  "um", "uh", "er", "ah", "umm", "uhh", "hmm", "hm",
  "uh-huh", "um-hum",
  "like", "you know", "i mean", "sort of", "kind of",
  "basically", "actually",
  "嗯", "啊", "呃", "额", "那个", "就是",
]));

/**
 * Normalizes text to extract lowercase clean word without surrounding punctuation.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeWord(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/**
 * Checks if a given token represents a recognized filler word.
 *
 * @param {string} text
 * @param {Set<string>} [fillerWords=DEFAULT_FILLER_WORDS]
 * @returns {boolean}
 */
export function isFillerWord(text, fillerWords = DEFAULT_FILLER_WORDS) {
  const clean = normalizeWord(text);
  return Boolean(clean && fillerWords.has(clean));
}

/**
 * Extracts filler-word cut candidates from Whisper word-level chunks.
 * Only words explicitly recognized with usable timestamps are included.
 *
 * @param {Array<{ text: string, timestamp?: [number, number] }>} chunks
 * @param {{ duration: number, sourceStart?: number }} clip
 * @param {Object} [options]
 * @param {number} [options.keep=0]
 * @param {number} [options.minDuration=0.08]
 * @param {Set<string>} [options.fillerWords=DEFAULT_FILLER_WORDS]
 * @returns {Array<Object>}
 */
export function findFillerWordCandidates(chunks, clip, {
  keep: _keep = 0,
  minDuration = 0.08,
  fillerWords = DEFAULT_FILLER_WORDS,
} = {}) {
  const duration = Number(clip?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || !Array.isArray(chunks) || !chunks.length) {
    return [];
  }

  const safeMinDuration = Math.max(0.05, Number(minDuration) || 0.08);
  const sourceStart = Number(clip?.sourceStart) || 0;
  const candidates = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;

    const nextChunk = i + 1 < chunks.length ? chunks[i + 1] : null;
    let matchedWord = null;
    let rawStart = null;
    let rawEnd = null;
    let advance = 0;

    // Check 2-word phrase first (e.g., "you know", "i mean", "sort of")
    if (nextChunk) {
      const phrase = `${normalizeWord(chunk.text)} ${normalizeWord(nextChunk.text)}`.trim();
      if (fillerWords.has(phrase)) {
        const s = Number(chunk.timestamp?.[0]);
        const e = Number(nextChunk.timestamp?.[1]);
        if (Number.isFinite(s) && Number.isFinite(e) && e > s) {
          matchedWord = phrase;
          rawStart = s;
          rawEnd = e;
          advance = 1;
        }
      }
    }

    // Check single-word filler
    if (!matchedWord) {
      const single = normalizeWord(chunk.text);
      if (fillerWords.has(single)) {
        const s = Number(chunk.timestamp?.[0]);
        const e = Number(chunk.timestamp?.[1]);
        if (Number.isFinite(s) && Number.isFinite(e) && e > s) {
          matchedWord = single;
          rawStart = s;
          rawEnd = e;
        }
      }
    }

    if (!matchedWord) continue;

    // Normalize clip-relative offset if Whisper chunks used un-sliced source time
    if (sourceStart > 0 && rawStart >= sourceStart - EPS) {
      rawStart = Math.max(0, Number((rawStart - sourceStart).toFixed(4)));
      rawEnd = Math.max(rawStart + 0.05, Number((rawEnd - sourceStart).toFixed(4)));
    }

    // Cut interval covers the full filler word to ensure it is completely removed
    const start = Math.max(0, Math.min(duration, Number(rawStart.toFixed(4))));
    const end = Math.max(start, Math.min(duration, Number(rawEnd.toFixed(4))));

    if (end - start >= safeMinDuration) {
      candidates.push({
        id: `filler-${candidates.length}`,
        start,
        end,
        duration: Number((end - start).toFixed(4)),
        type: "filler",
        word: matchedWord,
        reason: `Filler: "${matchedWord}"`,
        enabled: true,
      });
    }

    if (advance > 0) {
      i += advance;
    }
  }

  return candidates;
}

/**
 * Merges overlapping or contiguous cut candidates into single distinct intervals.
 * Preserves compound reasons (e.g., "Silence + Filler").
 *
 * @param {Array<Object>} candidates
 * @returns {Array<Object>}
 */
export function mergeCutCandidates(candidates) {
  if (!Array.isArray(candidates) || !candidates.length) return [];

  const sorted = [...candidates].sort((a, b) => a.start - b.start);
  const merged = [];

  for (const cut of sorted) {
    if (!merged.length) {
      merged.push({ ...cut });
      continue;
    }

    const prev = merged[merged.length - 1];
    if (cut.start <= prev.end + EPS) {
      // Overlapping or touching cuts
      prev.end = Math.max(prev.end, cut.end);
      prev.duration = prev.end - prev.start;
      if (cut.type && prev.type !== cut.type) {
        prev.type = "merged";
        prev.reason = "Pause & filler";
      }
    } else {
      merged.push({ ...cut });
    }
  }

  return merged;
}

/**
 * Generates rough cut candidates combining pause intervals and optional filler words.
 *
 * @param {Object} params
 * @param {Float32Array|Array<number>} [params.probabilities]
 * @param {Array<Object>} [params.chunks]
 * @param {Object} params.clip
 * @param {Object} [params.settings]
 * @param {number} [params.settings.threshold=0.5]
 * @param {number} [params.settings.minimum=0.8]
 * @param {number} [params.settings.keep=0.3]
 * @param {boolean} [params.settings.removeFillerWords=false]
 * @returns {Array<Object>}
 */
export function findRoughCutCandidates({
  probabilities,
  chunks,
  clip,
  settings = {},
}) {
  const duration = Number(clip?.duration);
  if (!Number.isFinite(duration) || duration <= 0) return [];

  const {
    threshold = 0.5,
    minimum = 0.8,
    keep = 0.3,
    removeFillerWords = false,
  } = settings;

  const pauseCandidates = probabilities?.length
    ? findPauseCandidates(probabilities, clip, { threshold, minimum, keep })
    : [];

  const formattedPauses = pauseCandidates.map((pause, index) => ({
    ...pause,
    id: `pause-${index}`,
    type: "pause",
    duration: pause.end - pause.start,
    reason: `Silence (${(pause.end - pause.start).toFixed(2)}s)`,
    enabled: true,
  }));

  let fillerCandidates = [];
  if (removeFillerWords && Array.isArray(chunks) && chunks.length > 0) {
    fillerCandidates = findFillerWordCandidates(chunks, clip, { keep, minDuration: 0.15 });
  }

  // Combine pause and filler candidates safely
  const combined = [...formattedPauses, ...fillerCandidates].sort((a, b) => a.start - b.start);
  const merged = mergeCutCandidates(combined);

  // Filter against editor minimum visual segment length (MIN_VISUAL_SEGMENT_SECONDS = 0.2s)
  // Ensure that no cut leaves a micro-clip before or after it
  const safe = [];
  let cursor = 0;
  for (const cut of merged) {
    if (cut.start > cursor + EPS && cut.start - cursor < MIN_VISUAL_SEGMENT_SECONDS) continue;
    if (cut.end < duration - EPS && duration - cut.end < MIN_VISUAL_SEGMENT_SECONDS) continue;
    if (cut.end - cut.start > duration - MIN_VISUAL_SEGMENT_SECONDS) continue;

    safe.push({
      ...cut,
      id: `rough-cut-${safe.length}`,
      duration: cut.end - cut.start,
      enabled: true,
    });
    cursor = cut.end;
  }

  return safe;
}

/**
 * Builds an atomic rough cut review plan for the timeline editor.
 * Ensures enabled cuts are non-overlapping and executes ripple editing across
 * visual, audio, caption, overlay, and sticker tracks.
 *
 * @param {Object} snapshot - Project snapshot
 * @param {Object} runtime - Browser runtime state
 * @param {string} clipId - ID of target visual clip
 * @param {Array<Object>} candidates - Proposed cut candidates
 * @param {boolean} rippleEditing - Whether ripple editing is enabled
 * @returns {Object} Staged review plan ready for applyBrowserReview
 */
export function buildRoughCutReview(snapshot, runtime, clipId, candidates, rippleEditing) {
  const enabledCuts = (candidates || []).filter((cut) => cut.enabled);
  if (!enabledCuts.length) {
    throw Object.assign(new Error("roughCutNoSelection"), { code: "roughCutNoSelection" });
  }

  // Pre-merge any enabled cuts to ensure strictly disjoint intervals
  const mergedCuts = mergeCutCandidates(enabledCuts);

  try {
    return buildSilenceRemovalReview(snapshot, runtime, clipId, mergedCuts, rippleEditing);
  } catch (error) {
    // Map internal codes to roughCut namespace if relevant
    if (error.code === "pauseNoSelection") {
      throw Object.assign(new Error("roughCutNoSelection"), { code: "roughCutNoSelection" });
    }
    if (error.code === "pauseLocked") {
      throw Object.assign(new Error("roughCutLocked"), { code: "roughCutLocked" });
    }
    if (error.code === "pauseTooShort") {
      throw Object.assign(new Error("roughCutTooShort"), { code: "roughCutTooShort" });
    }
    throw error;
  }
}
