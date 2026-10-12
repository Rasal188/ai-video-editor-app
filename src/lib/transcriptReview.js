import { makeId } from "./timeline.js";
import { captionSegmentsFromWords } from "./captionSegmentation.js";

/**
 * Validates a single caption segment's timestamps.
 *
 * @param {number} start - Segment start time in seconds
 * @param {number} end - Segment end time in seconds
 * @returns {{ valid: boolean, error: string|null }}
 */
export function validateCaptionTimestamp(start, end) {
  const s = Number(start);
  const e = Number(end);

  if (!Number.isFinite(s)) {
    return { valid: false, error: "Start time must be a valid number" };
  }
  if (s < 0) {
    return { valid: false, error: "Start time cannot be negative" };
  }
  if (!Number.isFinite(e)) {
    return { valid: false, error: "End time must be a valid number" };
  }
  if (e < s) {
    return { valid: false, error: "End time must be greater than or equal to start time" };
  }

  return { valid: true, error: null };
}

/**
 * Validates an array of caption segments.
 *
 * @param {Array} segments - Array of caption segment objects
 * @returns {{ valid: boolean, errors: Array<{ id: string, index: number, error: string }> }}
 */
export function validateCaptionSegments(segments = []) {
  const errors = [];

  if (!Array.isArray(segments)) {
    return { valid: false, errors: [{ id: "", index: -1, error: "Segments must be an array" }] };
  }

  segments.forEach((seg, index) => {
    const check = validateCaptionTimestamp(seg?.start, seg?.end);
    if (!check.valid) {
      errors.push({
        id: seg?.id || `segment-${index}`,
        index,
        error: check.error,
      });
    }
  });

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Regroups caption segments using existing Whisper word chunks.
 *
 * @param {Array} rawChunks - Raw Whisper chunks
 * @param {number} duration - Media duration in seconds
 * @param {Object} options - Options (timelineOffset, grouping)
 * @returns {Array} Regrouped caption segments
 */
export function regroupReviewSegments(rawChunks, duration, { timelineOffset = 0, grouping = "phrases" } = {}) {
  if (!Array.isArray(rawChunks) || !rawChunks.length || !(duration > 0)) {
    return [];
  }
  return captionSegmentsFromWords(rawChunks, duration, {
    timelineOffset,
    grouping: grouping === "words" || grouping === "word" ? "words" : "phrases",
  });
}

/**
 * Tokenizes text into word-like units using Intl.Segmenter or whitespace fallback.
 *
 * @param {string} text - Input text
 * @returns {Array<string>} Array of word tokens
 */
export function tokenizeWords(text) {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
    const tokens = [];
    for (const segment of segmenter.segment(String(text ?? ""))) {
      if (segment.isWordLike) tokens.push(segment.segment);
    }
    if (tokens.length) return tokens;
  }
  return String(text ?? "").trim().split(/\s+/).filter(Boolean);
}

/**
 * Validates word-level timestamps inside a parent segment interval.
 *
 * @param {Array} words - Array of word objects { text, start, end }
 * @param {number} segmentStart - Parent segment start
 * @param {number} segmentEnd - Parent segment end
 * @returns {{ valid: boolean, error: string|null }}
 */
export function validateSegmentWords(words = [], segmentStart = 0, segmentEnd = Infinity) {
  if (!Array.isArray(words)) {
    return { valid: false, error: "Words must be an array" };
  }
  const sStart = Number(segmentStart);
  const sEnd = Number(segmentEnd);
  let previousStart = sStart;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const wStart = Number(w?.start);
    const wEnd = Number(w?.end);
    if (!Number.isFinite(wStart) || wStart < 0) {
      return { valid: false, error: `Word ${i} start must be a valid non-negative number` };
    }
    if (!Number.isFinite(wEnd) || wEnd < 0) {
      return { valid: false, error: `Word ${i} end must be a valid non-negative number` };
    }
    if (wEnd < wStart) {
      return { valid: false, error: `Word ${i} end must be greater than or equal to start` };
    }
    if (wStart < sStart - 0.001 || wEnd > sEnd + 0.001) {
      return { valid: false, error: `Word ${i} timing must remain within parent segment interval` };
    }
    if (wStart < previousStart - 0.001) {
      return { valid: false, error: "Words must maintain monotonic non-decreasing order" };
    }
    previousStart = wStart;
  }
  return { valid: true, error: null };
}

/**
 * Updates text of a specific segment.
 * If word-level timings correspond 1-to-1 to edited tokens, updates word text while preserving
 * genuine Whisper timestamps. If words no longer correspond, safely removes word timings to fall
 * back to phrase-level rendering without claiming redistributed timestamps are genuine ASR.
 *
 * @param {Array} segments - Array of segments
 * @param {string} id - Target segment ID
 * @param {string} newText - New text content
 * @returns {Array} Updated array of segments
 */
export function updateSegmentText(segments, id, newText) {
  return segments.map((seg) => {
    if (seg.id !== id) return seg;
    if (seg.text === newText) return seg;
    const nextSeg = { ...seg, text: newText };
    if (Array.isArray(seg.words) && seg.words.length > 0) {
      const tokens = tokenizeWords(newText);
      if (tokens.length === seg.words.length) {
        nextSeg.words = seg.words.map((w, idx) => ({
          ...w,
          text: tokens[idx],
        }));
      } else {
        delete nextSeg.words;
        nextSeg.timingSource = "manual";
      }
    }
    return nextSeg;
  });
}

/**
 * Updates timestamps of a specific segment.
 * Clamps existing word timestamps within the updated interval.
 *
 * @param {Array} segments - Array of segments
 * @param {string} id - Target segment ID
 * @param {{ start?: number, end?: number }} timing - Timing update
 * @returns {Array} Updated array of segments
 */
export function updateSegmentTiming(segments, id, { start, end }) {
  return segments.map((seg) => {
    if (seg.id !== id) return seg;
    const newStart = start !== undefined ? Number(start) : seg.start;
    const newEnd = end !== undefined ? Number(end) : seg.end;
    const updated = {
      ...seg,
      ...(start !== undefined ? { start: newStart } : {}),
      ...(end !== undefined ? { end: newEnd } : {}),
    };
    if (Array.isArray(seg.words) && seg.words.length > 0) {
      if (Number.isFinite(newStart) && Number.isFinite(newEnd) && newEnd >= newStart) {
        updated.words = seg.words.map((w) => {
          const ws = Math.max(newStart, Math.min(newEnd, Number(w.start)));
          const we = Math.max(ws, Math.min(newEnd, Number(w.end)));
          return { ...w, start: ws, end: we };
        });
      }
      updated.timingSource = "manual";
    }
    return updated;
  });
}

/**
 * Deletes a segment by ID.
 *
 * @param {Array} segments - Array of segments
 * @param {string} id - Segment ID to delete
 * @returns {Array} Filtered array of segments
 */
export function deleteSegment(segments, id) {
  return segments.filter((seg) => seg.id !== id);
}

/**
 * Inserts a new segment, optionally after an existing segment.
 *
 * @param {Array} segments - Array of segments
 * @param {string} [afterId] - Optional ID of preceding segment
 * @param {Object} [partial] - Initial segment values
 * @returns {Array} Array with newly inserted segment
 */
export function addSegment(segments = [], afterId = null, partial = {}) {
  let insertIndex = segments.length;
  let defaultStart = 0;
  let defaultEnd = 2;

  if (afterId) {
    const idx = segments.findIndex((s) => s.id === afterId);
    if (idx !== -1) {
      insertIndex = idx + 1;
      defaultStart = segments[idx].end;
      defaultEnd = defaultStart + 2;
    }
  } else if (segments.length > 0) {
    const last = segments[segments.length - 1];
    defaultStart = last.end;
    defaultEnd = defaultStart + 2;
  }

  const newSeg = {
    id: makeId("caption"),
    text: partial.text || "",
    start: Number.isFinite(Number(partial.start)) ? Number(partial.start) : defaultStart,
    end: Number.isFinite(Number(partial.end)) ? Number(partial.end) : defaultEnd,
    hidden: false,
    source: "asr",
    timingSource: "manual",
    ...partial,
  };

  const next = [...segments];
  next.splice(insertIndex, 0, newSeg);
  return next;
}

/**
 * Prepares reviewed segments for application to timeline state.
 * Sorts segments monotonically by start time and assigns inherited font IDs.
 *
 * @param {Array} segments - Reviewed segments
 * @param {string} [inheritedFontId="default"] - Default font ID
 * @returns {Array} Ready-to-commit segments
 */
export function prepareSegmentsForTimeline(segments = [], inheritedFontId = "default") {
  const sorted = [...segments].sort((a, b) => (a.start || 0) - (b.start || 0));
  let fontId = inheritedFontId;
  return sorted.map((seg) => {
    fontId = seg.fontId || fontId;
    return seg.fontId ? seg : { ...seg, fontId };
  });
}
