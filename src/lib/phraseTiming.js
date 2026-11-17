/**
 * Source-Word-Derived Phrase Timing for Translated Captions
 *
 * Translation returns text only. The Ollalink transcription that produced the
 * cue, however, already carries genuine source-language word intervals. Those
 * intervals describe *when the speaker was talking*, which is language
 * independent: the second spoken word occupies the same slice of audio whatever
 * language the caption is displayed in.
 *
 * This module therefore does one narrow, honest thing: it groups the translated
 * caption into sequential phrase chunks and gives each chunk the time window of
 * the source word intervals it corresponds to.
 *
 * Design rules enforced here:
 *
 * 1. Nothing is invented. Every chunk window is the union of real source word
 *    intervals. There is no uniform division of the cue duration and no
 *    interpolation between source words.
 * 2. This is NOT target-language word alignment. A translated chunk covers
 *    whatever source words were spoken in its window; it is marked with
 *    `timingSource: "source-word-derived-phrase"` so it can never be mistaken
 *    for provider-generated target-word timing.
 * 3. The source `words` array is never written to. Derived timing is stored in
 *    a separate `phraseTiming` record so switching back to the original
 *    language restores genuine word-level karaoke untouched.
 * 4. Tokenization is deterministic and script independent. `Intl.Segmenter`
 *    word granularity is used where available, which handles Chinese (no
 *    spaces), Arabic (right-to-left), Hindi and Latin scripts without
 *    per-language tables. Chunk text is sliced from the rendered display string
 *    so it stays a literal substring of what is drawn, and separators, spacing
 *    direction and punctuation all survive verbatim.
 * 5. When the source cue has no usable word timing, no record is produced. The
 *    caption renders as plain phrases instead of pretending to be synchronized.
 */

import { getCaptionDisplayText } from "./captionDisplayText.js";
import { WORD_TIMING_SOURCES } from "./wordAlignment.js";

const TIMING_TOLERANCE = 0.001;

/**
 * Upper bound on highlight steps within one cue. A cue with more source words
 * than this is merged into this many groups so the caption does not flicker.
 */
export const MAX_PHRASE_GROUPS = 8;

function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

/**
 * Splits text into word-like tokens while recording each token's offset.
 *
 * Offsets are essential: chunk text is sliced from the original display string,
 * so no separator, space or punctuation mark is ever rewritten or reordered.
 * `Intl.Segmenter` handles scripts without whitespace word separation (Chinese,
 * Japanese) and right-to-left scripts (Arabic, Hebrew) correctly.
 *
 * @param {string} text
 * @returns {Array<{ text: string, index: number }>}
 */
export function segmentTokensWithOffsets(text) {
    const value = String(text ?? "");
    if (!value) return [];

    const tokens = [];
    if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
        try {
            const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
            for (const part of segmenter.segment(value)) {
                if (!part.isWordLike) continue;
                if (!part.segment) continue;
                tokens.push({ text: part.segment, index: part.index });
            }
        } catch {
            tokens.length = 0;
        }
    }
    if (tokens.length) return tokens;

    // Deterministic fallback for runtimes without Intl.Segmenter.
    const pattern = /\S+/gu;
    let match = pattern.exec(value);
    while (match) {
        tokens.push({ text: match[0], index: match.index });
        match = pattern.exec(value);
    }
    if (tokens.length) return tokens;

    // Nothing word-like at all (punctuation only): the whole line is one chunk.
    return [{ text: value, index: 0 }];
}

/**
 * Reads a cue's genuine source word intervals in absolute timeline seconds.
 *
 * Word arrays arrive either as absolute timestamps or as offsets relative to
 * the cue start. Both shapes are used by the karaoke renderer, so both are
 * accepted here and normalized to absolute seconds. Malformed timing is
 * rejected whole rather than partially trusted.
 *
 * @param {Array<{ start?: number, end?: number }>} words
 * @param {number} cueStart
 * @param {number} cueEnd
 * @returns {Array<{ start: number, end: number }>|null}
 */
export function normalizeSourceWordIntervals(words, cueStart, cueEnd) {
    if (!Array.isArray(words) || words.length === 0) return null;
    const start = finiteNumber(cueStart);
    const end = finiteNumber(cueEnd);
    if (start === null || end === null || end <= start) return null;

    const firstStart = finiteNumber(words[0]?.start);
    if (firstStart === null) return null;

    // Mirror resolveWordTimingWindow: a first word that begins before a
    // non-zero cue start is read as cue-relative.
    const isSegmentRelative =
        start > TIMING_TOLERANCE && firstStart < start - TIMING_TOLERANCE && firstStart >= 0;
    const offset = isSegmentRelative ? start : 0;

    const intervals = [];
    let previousStart = -Infinity;
    for (const word of words) {
        const wordStart = finiteNumber(word?.start);
        const wordEnd = finiteNumber(word?.end);
        if (wordStart === null || wordEnd === null) return null;
        if (wordEnd < wordStart) return null;
        if (wordStart < previousStart - TIMING_TOLERANCE) return null;

        const absoluteStart = wordStart + offset;
        const absoluteEnd = wordEnd + offset;
        if (absoluteStart < start - TIMING_TOLERANCE || absoluteEnd > end + TIMING_TOLERANCE) return null;

        intervals.push({
            start: Math.max(absoluteStart, start),
            end: Math.min(absoluteEnd, end),
        });
        previousStart = wordStart;
    }
    return intervals;
}

/**
 * Validates a stored derived phrase record against its cue.
 *
 * The rules intentionally mirror `validateSegmentWords`, which is what the
 * renderer itself enforces: finite non-negative bounds, `end >= start`, every
 * window inside the cue, and monotonic non-decreasing starts. Overlapping
 * windows are permitted because real ASR word intervals routinely touch or
 * overlap slightly, and rejecting them here would throw away timing the
 * renderer can already highlight correctly. A record that fails any rule is
 * refused whole, because partial timing is indistinguishable from fabricated
 * timing.
 *
 * @param {object} record
 * @param {{ start?: number, end?: number }} [cue]
 * @returns {boolean}
 */
export function validatePhraseTiming(record, cue = {}) {
    if (!record || typeof record !== "object") return false;
    if (record.timingSource !== WORD_TIMING_SOURCES.SOURCE_WORD_DERIVED_PHRASE) return false;
    if (!Array.isArray(record.chunks) || record.chunks.length === 0) return false;

    const start = finiteNumber(cue.start ?? record.cueStart);
    const end = finiteNumber(cue.end ?? record.cueEnd);
    if (start === null || end === null || end <= start) return false;

    let previousStart = start;
    for (const chunk of record.chunks) {
        if (!chunk || typeof chunk.text !== "string" || !chunk.text.trim()) return false;
        const chunkStart = finiteNumber(chunk.start);
        const chunkEnd = finiteNumber(chunk.end);
        if (chunkStart === null || chunkEnd === null) return false;
        if (chunkStart < 0 || chunkEnd < 0) return false;
        if (chunkEnd < chunkStart) return false;
        if (chunkStart < start - TIMING_TOLERANCE || chunkEnd > end + TIMING_TOLERANCE) return false;
        if (chunkStart < previousStart - TIMING_TOLERANCE) return false;
        previousStart = chunkStart;
    }
    return true;
}

/**
 * Derives phrase-level timing for translated text from source word intervals.
 *
 * Grouping is index bucketed, not time bucketed: the source word intervals and
 * the translated tokens are both split into the same number of sequential
 * groups, so group N covers source word N's real window. Because each window is
 * a real interval union, the highlight advances exactly at source timestamp
 * boundaries.
 *
 * Re-translation: once a cue has been translated its own `words` array is gone,
 * so the genuine intervals are re-read from the previous record's
 * `sourceIntervals` copy. Without that, a second translation would silently lose
 * phrase synchronization.
 *
 * @param {object} params
 * @param {Array<{ start?: number, end?: number }>|null} params.sourceWords - The cue's genuine source words
 * @param {number} params.cueStart
 * @param {number} params.cueEnd
 * @param {string} params.targetText - The translated caption text
 * @param {string|null} [params.language] - Target language code, for provenance
 * @param {object|null} [params.previousRecord] - Existing derived record for this cue
 * @returns {object|null} A derived phrase record, or null when nothing safe can be derived
 */
export function derivePhraseTiming({
    sourceWords = null,
    cueStart,
    cueEnd,
    targetText = "",
    language = null,
    previousRecord = null,
} = {}) {
    const intervals =
        normalizeSourceWordIntervals(sourceWords, cueStart, cueEnd)
        ?? normalizeSourceWordIntervals(previousRecord?.sourceIntervals, cueStart, cueEnd);
    if (!intervals) return null;

    const cueStartValue = finiteNumber(cueStart);
    const cueEndValue = finiteNumber(cueEnd);
    if (cueStartValue === null || cueEndValue === null || cueEndValue <= cueStartValue) return null;

    // Slice against what is actually rendered: the display string may drop a
    // trailing punctuation mark, and a chunk must remain a literal substring of
    // the drawn line or the renderer cannot highlight it.
    const displayText = getCaptionDisplayText(targetText);
    const tokens = segmentTokensWithOffsets(displayText);
    if (tokens.length === 0) return null;

    const groupCount = Math.max(
        1,
        Math.min(intervals.length, tokens.length, MAX_PHRASE_GROUPS),
    );

    const chunks = [];
    for (let group = 0; group < groupCount; group += 1) {
        const sourceFrom = Math.floor((group * intervals.length) / groupCount);
        const sourceTo = Math.floor(((group + 1) * intervals.length) / groupCount);
        const tokenFrom = Math.floor((group * tokens.length) / groupCount);
        const tokenTo = Math.floor(((group + 1) * tokens.length) / groupCount);
        if (sourceTo <= sourceFrom || tokenTo <= tokenFrom) continue;

        const firstToken = tokens[tokenFrom];
        const lastToken = tokens[tokenTo - 1];
        const text = displayText.slice(firstToken.index, lastToken.index + lastToken.text.length);
        if (!text.trim()) continue;

        chunks.push({
            text,
            start: intervals[sourceFrom].start,
            end: intervals[sourceTo - 1].end,
            sourceWordRange: [sourceFrom, sourceTo - 1],
            tokenRange: [tokenFrom, tokenTo - 1],
        });
    }
    // A single group cannot progress: it would highlight the whole line for one
    // short window and then go dark, which reads as a broken highlight rather
    // than synchronization. Requiring at least two steps keeps the "fall back
    // safely without a false active highlight" promise.
    if (chunks.length < 2) return null;

    const record = {
        // Explicit provenance. This is derived from source word intervals; it is
        // not provider-generated target-language word alignment.
        timingSource: WORD_TIMING_SOURCES.SOURCE_WORD_DERIVED_PHRASE,
        language: typeof language === "string" && language ? language : null,
        cueStart: cueStartValue,
        cueEnd: cueEndValue,
        sourceWordCount: intervals.length,
        // A copy of the genuine source windows this record was built from, so a
        // re-translation of an already-translated cue can be derived again after
        // its own `words` array has been replaced. Read-only: nothing writes to
        // the cue's source `words`.
        sourceIntervals: intervals.map((interval) => ({ start: interval.start, end: interval.end })),
        chunks,
    };

    return validatePhraseTiming(record, { start: cueStartValue, end: cueEndValue }) ? record : null;
}

/**
 * Converts a derived phrase record into the words-shaped array the renderer
 * already understands. Chunk `text` values are literal substrings of the
 * rendered line, so the existing word-chunk splitter highlights them unchanged.
 *
 * @param {object} [record]
 * @returns {Array<{ text: string, start: number, end: number }>|null}
 */
export function toPhraseKaraokeWords(record) {
    if (!record || !Array.isArray(record.chunks) || record.chunks.length === 0) return null;
    return record.chunks.map((chunk) => ({ text: chunk.text, start: chunk.start, end: chunk.end }));
}

/**
 * Returns validated phrase karaoke words for a cue, or null.
 *
 * @param {object} [cue]
 * @returns {Array<{ text: string, start: number, end: number }>|null}
 */
export function getDerivedPhraseWords(cue) {
    if (!cue || typeof cue !== "object") return null;
    if (cue.wordTimingSource !== WORD_TIMING_SOURCES.SOURCE_WORD_DERIVED_PHRASE) return null;
    const record = cue.phraseTiming;
    if (!validatePhraseTiming(record, cue)) return null;
    return toPhraseKaraokeWords(record);
}

/**
 * Reports whether a cue carries usable derived phrase timing.
 *
 * @param {object} [cue]
 * @returns {boolean}
 */
export function hasPhraseTiming(cue) {
    return getDerivedPhraseWords(cue) !== null;
}

/**
 * Stores derived phrase timing on a cue without touching its source `words`.
 *
 * `timingSource` is left alone because it describes the *text* provenance
 * ("manual" = the text was replaced). Word-timing provenance is recorded in
 * `wordTimingSource` and inside the record itself.
 *
 * @param {object} cue
 * @param {object} record
 * @returns {object}
 */
export function attachPhraseTimingToCue(cue, record) {
    if (!cue || !record) return cue;
    return {
        ...cue,
        phraseTiming: record,
        wordTimingSource: WORD_TIMING_SOURCES.SOURCE_WORD_DERIVED_PHRASE,
    };
}

/**
 * Human-readable copy describing what a derived record does and does not claim.
 *
 * @param {object} [record]
 * @returns {string}
 */
export function describePhraseTimingStatus(record) {
    if (!record || record.timingSource !== WORD_TIMING_SOURCES.SOURCE_WORD_DERIVED_PHRASE) {
        return "Translated karaoke is unavailable for this cue: it has no usable source word timing, so the caption renders as plain phrases without a synchronized highlight.";
    }
    const groups = Array.isArray(record.chunks) ? record.chunks.length : 0;
    const sourceWords = Number(record.sourceWordCount) || 0;
    return `Translated karaoke follows ${groups} phrase group${groups === 1 ? "" : "s"} timed by ${sourceWords} genuine source word interval${sourceWords === 1 ? "" : "s"}. This is phrase-level synchronization derived from source timing, not target-language word alignment.`;
}
