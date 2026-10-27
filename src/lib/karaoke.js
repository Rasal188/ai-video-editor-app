/**
 * Karaoke & Active-Word Caption Highlighting
 *
 * Provides utilities for determining active words, validating word timings,
 * mapping words across wrapped lines, and resolving styling.
 */

import { validateSegmentWords } from "./transcriptReview.js";

export const DEFAULT_ACTIVE_WORD_COLOR = "#ffd43b";

/**
 * Validates word-level timings for safe karaoke highlighting.
 *
 * @param {Array} words - Array of { text, start, end }
 * @param {number} [segmentStart] - Parent segment start
 * @param {number} [segmentEnd] - Parent segment end
 * @returns {boolean} True if all word timings are valid
 */
export function areWordsValidForKaraoke(words, segmentStart, segmentEnd) {
  if (!Array.isArray(words) || words.length === 0) return false;
  const validation = validateSegmentWords(
    words,
    Number.isFinite(segmentStart) ? segmentStart : 0,
    Number.isFinite(segmentEnd) ? segmentEnd : Infinity
  );
  return validation.valid;
}

/**
 * Identifies the index of the active word in a words array at currentTime.
 *
 * @param {Array<{ text: string, start: number, end: number }>} words
 * @param {number} currentTime - Current playback / timeline time in seconds
 * @param {{ start?: number, end?: number }} [segment] - Optional parent segment
 * @returns {number} Index of active word, or -1 if no word is active
 */
export function getActiveWordIndex(words, currentTime, segment = null) {
  if (!Array.isArray(words) || words.length === 0) return -1;
  const time = Number(currentTime);
  if (!Number.isFinite(time)) return -1;

  const segStart = segment ? Number(segment.start) : undefined;
  const segEnd = segment ? Number(segment.end) : undefined;

  // If parent segment bounds are provided, verify currentTime is inside [start, end)
  if (Number.isFinite(segStart) && time < segStart - 0.001) return -1;
  if (Number.isFinite(segEnd) && time >= segEnd) return -1;

  // Detect whether words are relative to segment start (e.g. 0-based within clip)
  // or absolute timeline timestamps (standard from Milestone 1 ASR).
  const isSegmentRelative =
    Number.isFinite(segStart) &&
    segStart > 0.001 &&
    Number(words[0]?.start) < segStart - 0.001 &&
    Number(words[0]?.start) >= 0;

  const effectiveTime = isSegmentRelative ? time - segStart : time;
  const validationStart = isSegmentRelative ? 0 : segStart;
  const validationEnd = isSegmentRelative && Number.isFinite(segEnd) ? segEnd - segStart : segEnd;

  // Validate words timestamps before using them
  if (!areWordsValidForKaraoke(words, validationStart, validationEnd)) {
    return -1;
  }

  const firstStart = Number(words[0].start);
  const lastEnd = Number(words[words.length - 1].end);

  // Before first word starts -> no word is active
  if (effectiveTime < firstStart) return -1;

  // At or after the end of the last word -> no word is active (prevents stale highlights)
  if (effectiveTime >= lastEnd) return -1;

  // Search for the word covering effectiveTime: [start, end)
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const ws = Number(w.start);
    const we = Number(w.end);

    // Exact interval match
    if (effectiveTime >= ws && effectiveTime < we) {
      return i;
    }

    // Zero-duration edge case (instantaneous token): matches at exact time
    if (ws === we && Math.abs(effectiveTime - ws) < 0.0001) {
      return i;
    }
  }

  // Current time falls into a pause / gap between words -> no word is active
  return -1;
}

/**
 * Checks whether karaoke active-word highlighting is enabled.
 *
 * @param {object} [captionStyle]
 * @param {object} [segment]
 * @returns {boolean}
 */
export function isKaraokeEnabled(captionStyle = {}, segment = null) {
  if (segment?.styleOverrides?.karaoke !== undefined) {
    return Boolean(segment.styleOverrides.karaoke);
  }
  if (segment?.animation === "karaoke" || (segment?.isKinetic && segment?.animation !== "none")) {
    return true;
  }
  return Boolean(captionStyle?.karaoke);
}

/**
 * Resolves the active-word highlight color.
 *
 * @param {object} [captionStyle]
 * @param {object} [segment]
 * @param {string} [fallbackColor]
 * @returns {string} Hex or rgba color
 */
export function resolveActiveWordColor(
  captionStyle = {},
  segment = null,
  fallbackColor = DEFAULT_ACTIVE_WORD_COLOR
) {
  return (
    segment?.styleOverrides?.activeWordColor ||
    captionStyle?.activeWordColor ||
    fallbackColor
  );
}

export const DEFAULT_KEYWORD_COLOR = "#38d9a9";

/**
 * Normalizes user-specified keywords into a clean array of strings.
 * Supports arrays or comma/newline/semicolon delimited strings.
 *
 * @param {Array<string>|string} keywords
 * @returns {Array<string>}
 */
export function normalizeKeywords(keywords) {
  if (!keywords) return [];
  if (Array.isArray(keywords)) {
    return keywords
      .map((k) => String(k ?? "").trim())
      .filter((k) => k.length > 0);
  }
  if (typeof keywords === "string") {
    return keywords
      .split(/[,;\n]+/)
      .map((k) => k.trim())
      .filter((k) => k.length > 0);
  }
  return [];
}

/**
 * Checks whether keyword highlighting is enabled.
 *
 * @param {object} [captionStyle]
 * @param {object} [segment]
 * @returns {boolean}
 */
export function isKeywordHighlightEnabled(captionStyle = {}, segment = null) {
  if (segment?.styleOverrides?.keywordHighlight !== undefined) {
    return Boolean(segment.styleOverrides.keywordHighlight);
  }
  return Boolean(captionStyle?.keywordHighlight);
}

/**
 * Resolves keyword highlight color.
 *
 * @param {object} [captionStyle]
 * @param {object} [segment]
 * @param {string} [fallbackColor]
 * @returns {string} Hex or rgba color
 */
export function resolveKeywordColor(
  captionStyle = {},
  segment = null,
  fallbackColor = DEFAULT_KEYWORD_COLOR
) {
  return (
    segment?.styleOverrides?.keywordColor ||
    captionStyle?.keywordColor ||
    fallbackColor
  );
}

/**
 * Resolves active keywords list.
 *
 * @param {object} [captionStyle]
 * @param {object} [segment]
 * @returns {Array<string>}
 */
export function resolveKeywords(captionStyle = {}, segment = null) {
  const segmentKeywords = segment?.styleOverrides?.keywords;
  if (segmentKeywords !== undefined && segmentKeywords !== null) {
    return normalizeKeywords(segmentKeywords);
  }
  return normalizeKeywords(captionStyle?.keywords);
}

/**
 * Checks whether a word or text matches any keyword in the list.
 *
 * @param {string} wordText
 * @param {Array<string>} [keywords=[]]
 * @returns {boolean}
 */
export function isWordMatchingKeywords(wordText, keywords = []) {
  if (!wordText || !Array.isArray(keywords) || keywords.length === 0) return false;
  const cleanWord = String(wordText).trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
  if (!cleanWord) return false;
  return keywords.some((kw) => {
    const cleanKw = String(kw).trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
    return cleanKw.length > 0 && cleanWord === cleanKw;
  });
}

/**
 * Finds non-overlapping keyword match ranges in a line of text.
 * Multi-word phrases and individual words are supported.
 *
 * @param {string} line
 * @param {Array<string>} [keywords=[]]
 * @returns {Array<{ start: number, end: number, keyword: string }>}
 */
export function findKeywordRangesInLine(line, keywords = []) {
  if (!line || !Array.isArray(keywords) || keywords.length === 0) return [];
  const lowerLine = String(line).toLowerCase();
  const ranges = [];

  // Sort keywords by length descending so longer multi-word phrases match first
  const sortedKeywords = [...keywords].sort((a, b) => b.length - a.length);

  for (const kw of sortedKeywords) {
    const cleanKw = String(kw).trim().toLowerCase();
    if (!cleanKw) continue;

    let searchPos = 0;
    while (searchPos < lowerLine.length) {
      const idx = lowerLine.indexOf(cleanKw, searchPos);
      if (idx === -1) break;

      const endIdx = idx + cleanKw.length;
      // Word boundary check: ensure we match complete tokens or phrases
      const isStartWordBoundary = idx === 0 || /[\s\p{P}]/u.test(lowerLine[idx - 1]);
      const isEndWordBoundary = endIdx >= lowerLine.length || /[\s\p{P}]/u.test(lowerLine[endIdx]);

      if (isStartWordBoundary && isEndWordBoundary) {
        // Prevent overlapping with previously found ranges
        const overlaps = ranges.some((r) => idx < r.end && endIdx > r.start);
        if (!overlaps) {
          ranges.push({ start: idx, end: endIdx, keyword: kw });
        }
      }
      searchPos = idx + 1;
    }
  }

  ranges.sort((a, b) => a.start - b.start);
  return ranges;
}

/**
 * Splits a line of caption text into rendered chunks (words, separators, keywords),
 * matching against segment words and keyword rules.
 *
 * @param {string} line - A single wrapped text line
 * @param {Array<{ text: string }>} words - Full words array of the caption segment
 * @param {number} [wordCursor=0] - Starting index in the words array for this line
 * @param {number} [activeWordIndex=-1] - Global index of active word
 * @param {object} [options={}] - Options for keyword highlighting and colors
 * @returns {{ chunks: Array<{ text: string, isWord: boolean, wordIndex: number, isActive: boolean, isKeyword: boolean, offset: number, color: string }>, nextWordCursor: number }}
 */
export function splitLineIntoWordChunks(
  line = "",
  words = [],
  wordCursor = 0,
  activeWordIndex = -1,
  options = {}
) {
  const safeLine = String(line ?? "");
  const {
    keywords = [],
    keywordHighlight = false,
    keywordColor = DEFAULT_KEYWORD_COLOR,
    activeWordColor = DEFAULT_ACTIVE_WORD_COLOR,
    textColor = "#f5fbff",
  } = options;

  const effectiveKeywords = keywordHighlight ? normalizeKeywords(keywords) : [];
  const keywordRanges = effectiveKeywords.length > 0 ? findKeywordRangesInLine(safeLine, effectiveKeywords) : [];

  const isRangeKeyword = (start, end, wordText) => {
    if (effectiveKeywords.length === 0) return false;
    if (keywordRanges.some((r) => (start < r.end && end > r.start))) return true;
    return isWordMatchingKeywords(wordText, effectiveKeywords);
  };

  const resolveChunkColor = (isActive, isKeyword) => {
    if (isActive) return activeWordColor;
    if (isKeyword) return keywordColor;
    return textColor;
  };

  // Case 1: No word timing array available (e.g. legacy phrase caption)
  if (!Array.isArray(words) || words.length === 0 || wordCursor >= words.length) {
    if (keywordRanges.length === 0) {
      return {
        chunks: [
          {
            text: safeLine,
            isWord: false,
            wordIndex: -1,
            isActive: false,
            isKeyword: false,
            offset: 0,
            color: textColor,
          },
        ],
        nextWordCursor: wordCursor,
      };
    }

    // Segment line by keyword ranges
    const chunks = [];
    let currentPos = 0;
    for (const range of keywordRanges) {
      if (range.start > currentPos) {
        chunks.push({
          text: safeLine.slice(currentPos, range.start),
          isWord: false,
          wordIndex: -1,
          isActive: false,
          isKeyword: false,
          offset: currentPos,
          color: textColor,
        });
      }
      chunks.push({
        text: safeLine.slice(range.start, range.end),
        isWord: true,
        wordIndex: -1,
        isActive: false,
        isKeyword: true,
        offset: range.start,
        color: keywordColor,
      });
      currentPos = range.end;
    }
    if (currentPos < safeLine.length) {
      chunks.push({
        text: safeLine.slice(currentPos),
        isWord: false,
        wordIndex: -1,
        isActive: false,
        isKeyword: false,
        offset: currentPos,
        color: textColor,
      });
    }

    return {
      chunks: chunks.length ? chunks : [{ text: "", isWord: false, wordIndex: -1, isActive: false, isKeyword: false, offset: 0, color: textColor }],
      nextWordCursor: wordCursor,
    };
  }

  // Case 2: Segment line by words array, checking active and keyword states
  const chunks = [];
  let linePos = 0;
  let currentWordIdx = wordCursor;

  while (linePos < safeLine.length) {
    if (currentWordIdx >= words.length) {
      const remaining = safeLine.slice(linePos);
      if (remaining) {
        const isRemKeyword = isRangeKeyword(linePos, safeLine.length, remaining);
        chunks.push({
          text: remaining,
          isWord: false,
          wordIndex: -1,
          isActive: false,
          isKeyword: isRemKeyword,
          offset: linePos,
          color: resolveChunkColor(false, isRemKeyword),
        });
      }
      break;
    }

    const targetWord = String(words[currentWordIdx]?.text ?? "").trim();
    if (!targetWord) {
      currentWordIdx++;
      continue;
    }

    // Check if the target word starts right at linePos
    if (safeLine.startsWith(targetWord, linePos)) {
      const isActive = currentWordIdx === activeWordIndex;
      const isKeyword = isRangeKeyword(linePos, linePos + targetWord.length, targetWord);
      chunks.push({
        text: targetWord,
        isWord: true,
        wordIndex: currentWordIdx,
        isActive,
        isKeyword,
        offset: linePos,
        color: resolveChunkColor(isActive, isKeyword),
      });
      linePos += targetWord.length;
      currentWordIdx++;
      continue;
    }

    // Otherwise, find next occurrence of targetWord in this line
    const matchIndex = safeLine.indexOf(targetWord, linePos);
    if (matchIndex >= linePos) {
      const separator = safeLine.slice(linePos, matchIndex);
      if (separator) {
        const isSepKeyword = isRangeKeyword(linePos, matchIndex, separator);
        chunks.push({
          text: separator,
          isWord: false,
          wordIndex: -1,
          isActive: false,
          isKeyword: isSepKeyword,
          offset: linePos,
          color: resolveChunkColor(false, isSepKeyword),
        });
      }
      const isActive = currentWordIdx === activeWordIndex;
      const isKeyword = isRangeKeyword(matchIndex, matchIndex + targetWord.length, targetWord);
      chunks.push({
        text: targetWord,
        isWord: true,
        wordIndex: currentWordIdx,
        isActive,
        isKeyword,
        offset: matchIndex,
        color: resolveChunkColor(isActive, isKeyword),
      });
      linePos = matchIndex + targetWord.length;
      currentWordIdx++;
    } else {
      const remaining = safeLine.slice(linePos);
      if (remaining) {
        const isRemKeyword = isRangeKeyword(linePos, safeLine.length, remaining);
        chunks.push({
          text: remaining,
          isWord: false,
          wordIndex: -1,
          isActive: false,
          isKeyword: isRemKeyword,
          offset: linePos,
          color: resolveChunkColor(false, isRemKeyword),
        });
      }
      break;
    }
  }

  return {
    chunks: chunks.length ? chunks : [{ text: "", isWord: false, wordIndex: -1, isActive: false, isKeyword: false, offset: 0, color: textColor }],
    nextWordCursor: currentWordIdx,
  };
}
