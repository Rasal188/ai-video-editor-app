/**
 * Target-language Word Alignment for Translated Captions
 *
 * Translated caption text arrives without word timing. Source-language ASR
 * timings describe the *spoken source words*, not the translated words, so they
 * must never be reused. This module is the contract for storing and validating
 * genuinely aligned target-language timing.
 *
 * Design rules enforced here:
 *
 * 1. Alignment is either genuine or absent. There is no interpolation,
 *    proportional distribution of the cue duration, or borrowed timing.
 * 2. Target timing is stored separately (`alignedWords`), leaving the cue's
 *    source-language `words` array untouched so switching back to the original
 *    language keeps its genuine karaoke timing.
 * 3. A word that cannot be aligned is marked `aligned: false`, and karaoke is
 *    withheld rather than showing a highlight that cannot follow the audio.
 * 4. Every supplied interval is re-validated here. A provider result that is
 *    out of range, overlapping, out of order or malformed is rejected whole,
 *    because partially trusted timing would be indistinguishable from
 *    fabricated timing.
 *
 * This module deliberately performs no acoustic analysis of its own. It accepts
 * an aligner callback; when no aligner is configured the result is an explicit
 * `provider-unavailable` refusal. That keeps the capability honest: translated
 * karaoke is only enabled once a real aligner returns real intervals.
 */

/** Why target-language alignment could not be produced. */
export const ALIGNMENT_UNAVAILABLE_REASONS = Object.freeze({
    NO_PROVIDER: "no-target-alignment-provider",
    PROVIDER_FAILED: "provider-failed",
    PROVIDER_TIMEOUT: "provider-timeout",
    PROVIDER_ABORTED: "provider-aborted",
    INVALID_RESULT: "invalid-alignment-result",
    WORD_COUNT_MISMATCH: "word-count-mismatch",
    LOW_CONFIDENCE: "insufficient-confidence",
    EMPTY_TARGET: "empty-target-text",
});

/**
 * Timing source for a caption cue's word array.
 *
 * SOURCE_ASR        genuine provider word timing for the spoken language
 * TARGET_ALIGNMENT  genuine provider alignment of translated words (aligner)
 * SOURCE_WORD_DERIVED_PHRASE
 *                   phrase-level timing for translated text, derived from the
 *                   source cue's real word intervals. This is NOT target-word
 *                   alignment: a translated chunk covers whatever source words
 *                   were spoken in its window. Keeping it a distinct value is
 *                   what stops derived timing being mistaken for alignment.
 */
export const WORD_TIMING_SOURCES = Object.freeze({
    SOURCE_ASR: "source-asr",
    TARGET_ALIGNMENT: "target-alignment",
    SOURCE_WORD_DERIVED_PHRASE: "source-word-derived-phrase",
});

const TIMING_TOLERANCE = 0.001;

function finiteOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

/**
 * Builds an explicit "alignment is not available" record.
 *
 * This is a first-class result, not an error: callers store it so the editor can
 * explain why translated karaoke cannot be enabled for the cue.
 *
 * @param {string} reason - One of ALIGNMENT_UNAVAILABLE_REASONS
 * @param {object} [details]
 * @returns {{ status: "unavailable", aligned: false, reason: string, provider: string|null, words: null, unalignedIndices: number[] }}
 */
export function createUnavailableAlignment(reason = ALIGNMENT_UNAVAILABLE_REASONS.NO_PROVIDER, details = {}) {
    return {
        status: "unavailable",
        aligned: false,
        reason,
        provider: details.provider ?? null,
        language: details.language ?? null,
        words: null,
        unalignedIndices: [],
    };
}

/**
 * Strictly validates aligned target words against their parent cue interval.
 *
 * Rejects the whole set on any violation. Overlap and ordering are checked in
 * addition to the range/monotonic rules used for ASR timing, because an aligner
 * working from separate tokens can otherwise emit crossing intervals.
 *
 * @param {Array<{ text?: string, start?: number, end?: number, confidence?: number, aligned?: boolean }>} words
 * @param {number} cueStart
 * @param {number} cueEnd
 * @returns {{ valid: boolean, errors: string[], unalignedIndices: number[] }}
 */
export function validateAlignedWords(words, cueStart, cueEnd) {
    const errors = [];
    const unalignedIndices = [];
    if (!Array.isArray(words) || words.length === 0) {
        return { valid: false, errors: ["Aligned words must be a non-empty array"], unalignedIndices };
    }
    const start = finiteOrNull(cueStart);
    const end = finiteOrNull(cueEnd);
    let previousEnd = null;

    for (let index = 0; index < words.length; index += 1) {
        const word = words[index];
        if (!word || typeof word !== "object") {
            errors.push(`Word ${index} must be an object`);
            continue;
        }
        if (typeof word.text !== "string" || !word.text) {
            errors.push(`Word ${index} must carry non-empty text`);
        }
        if (word.aligned === false) {
            // Explicitly unaligned words are legal input, but they cannot contribute
            // timing. Record them instead of inventing an interval.
            unalignedIndices.push(index);
            continue;
        }
        const wordStart = finiteOrNull(word.start);
        const wordEnd = finiteOrNull(word.end);
        if (wordStart === null || wordStart < 0) {
            errors.push(`Word ${index} start must be a finite non-negative number`);
            continue;
        }
        if (wordEnd === null || wordEnd < 0) {
            errors.push(`Word ${index} end must be a finite non-negative number`);
            continue;
        }
        if (wordEnd < wordStart) {
            errors.push(`Word ${index} end must not precede its start`);
            continue;
        }
        if (start !== null && wordStart < start - TIMING_TOLERANCE) {
            errors.push(`Word ${index} starts before the cue interval`);
        }
        if (end !== null && wordEnd > end + TIMING_TOLERANCE) {
            errors.push(`Word ${index} ends after the cue interval`);
        }
        if (previousEnd !== null) {
            if (wordStart < previousEnd - TIMING_TOLERANCE) {
                errors.push(`Word ${index} overlaps the previous word`);
            }
        }
        if (word.confidence !== undefined && word.confidence !== null) {
            const confidence = Number(word.confidence);
            if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
                errors.push(`Word ${index} confidence must be within 0..1`);
            }
        }
        previousEnd = wordEnd;
    }

    return { valid: errors.length === 0, errors, unalignedIndices };
}

/**
 * Reports whether a stored alignment record may drive karaoke.
 *
 * Requires every word to be aligned. A partially aligned cue would need the
 * renderer to skip word indices mid-line while `text` and `words` still map
 * one-to-one, which risks highlighting the wrong token. Withholding karaoke is
 * the honest outcome; the cue renders as plain phrases instead.
 *
 * @param {object} [alignment]
 * @param {number} [cueStart]
 * @param {number} [cueEnd]
 * @returns {boolean}
 */
export function isFullyAlignedForKaraoke(alignment, cueStart, cueEnd) {
    if (!alignment || alignment.aligned !== true || alignment.status !== "aligned") return false;
    const words = alignment.words;
    if (!Array.isArray(words) || words.length === 0) return false;
    if (Array.isArray(alignment.unalignedIndices) && alignment.unalignedIndices.length > 0) return false;
    return validateAlignedWords(words, cueStart, cueEnd).valid;
}

/**
 * Converts a target-language token list into the per-word skeleton an aligner
 * must fill. Intervals are left undefined, never guessed.
 *
 * @param {string[]} tokens
 * @returns {Array<{ text: string, start: null, end: null, aligned: false }>}
 */
export function createUnalignedWordSkeleton(tokens = []) {
    return tokens.map((text) => ({ text, start: null, end: null, aligned: false }));
}

/**
 * Normalizes and validates a raw aligner response into a stored alignment record.
 *
 * @param {object} raw - Aligner output
 * @param {object} options
 * @param {string[]} options.tokens - Target tokens in cue order
 * @param {number} options.cueStart
 * @param {number} options.cueEnd
 * @param {string} [options.provider]
 * @param {string} [options.language]
 * @returns {object} Alignment record
 */
export function normalizeAlignmentResult(raw, { tokens = [], cueStart, cueEnd, provider = null, language = null } = {}) {
    const detail = { provider: raw?.provider ?? provider, language: raw?.language ?? language };
    if (!raw || raw.aligned !== true || !Array.isArray(raw.words) || raw.words.length === 0) {
        return createUnavailableAlignment(raw?.reason ?? ALIGNMENT_UNAVAILABLE_REASONS.PROVIDER_FAILED, detail);
    }
    if (tokens.length !== raw.words.length) {
        return createUnavailableAlignment(ALIGNMENT_UNAVAILABLE_REASONS.WORD_COUNT_MISMATCH, detail);
    }
    const words = [];
    for (let index = 0; index < raw.words.length; index += 1) {
        const word = raw.words[index];
        const wordStart = finiteOrNull(word?.start);
        const wordEnd = finiteOrNull(word?.end);
        // An aligner may declare a word unaligned. That is legal, honest input.
        const unaligned = word?.aligned === false;
        // A malformed interval is not the same as an unaligned word. Treating it as
        // merely unaligned would smuggle an untrustworthy result through as valid.
        if (!unaligned && (wordStart === null || wordEnd === null)) {
            return createUnavailableAlignment(ALIGNMENT_UNAVAILABLE_REASONS.INVALID_RESULT, detail);
        }
        words.push({
            text: tokens[index],
            start: unaligned ? null : wordStart,
            end: unaligned ? null : wordEnd,
            confidence: finiteOrNull(word?.confidence),
            aligned: !unaligned,
        });
    }
    const unalignedIndices = words.reduce((list, word, index) => (word.aligned ? list : [...list, index]), []);
    const validation = validateAlignedWords(words, cueStart, cueEnd);
    if (!validation.valid) {
        return createUnavailableAlignment(ALIGNMENT_UNAVAILABLE_REASONS.INVALID_RESULT, detail);
    }
    return {
        status: "aligned",
        aligned: true,
        reason: null,
        provider: detail.provider,
        language: detail.language,
        words,
        unalignedIndices,
    };
}

/**
 * Attaches validated target timing to a cue without touching source timing.
 *
 * @param {object} cue
 * @param {object} alignment - Record produced by normalizeAlignmentResult
 * @returns {object} The same cue object when there is nothing to store
 */
export function attachAlignmentToCue(cue, alignment) {
    if (!cue || !alignment) return cue;
    if (alignment.aligned !== true || alignment.status !== "aligned") return cue;
    return {
        ...cue,
        alignedWords: alignment.words,
        wordAlignment: alignment,
        // Provenance is stamped here as well as during apply so a cue produced by
        // either path resolves identically in the shared karaoke selector.
        wordTimingSource: WORD_TIMING_SOURCES.TARGET_ALIGNMENT,
    };
}

/**
 * Returns the stored alignment record for a cue, if any.
 *
 * @param {object} [cue]
 * @returns {object|null}
 */
export function getCueAlignment(cue) {
    if (!cue || !cue.wordAlignment || typeof cue.wordAlignment !== "object") return null;
    return cue.wordAlignment;
}

/**
 * Produces human-readable copy explaining the unavailable state.
 *
 * Wording is deliberately factual: it states that no target-language alignment
 * exists and that source timing was not reused. It makes no accuracy claim.
 *
 * @param {object} [alignment]
 * @returns {string}
 */
export function describeAlignmentStatus(alignment) {
    if (!alignment || alignment.aligned !== true) {
        return "Translated karaoke is unavailable for this cue: no target-language word alignment exists for the translated text, and source-language timings are not reused. The cue renders as plain phrases.";
    }
    const unaligned = Array.isArray(alignment.unalignedIndices) ? alignment.unalignedIndices.length : 0;
    if (unaligned > 0) {
        return `Translated karaoke is unavailable for this cue: ${unaligned} translated word${unaligned === 1 ? "" : "s"} could not be aligned, and unaligned words are not given invented timings. The cue renders as plain phrases.`;
    }
    return `Translated karaoke uses genuine target-language word alignment from ${alignment.provider || "the configured aligner"}.`;
}

/**
 * Requests target-language alignment from an injected aligner.
 *
 * No aligner is bundled with this build: there is no local acoustic model for
 * Spanish audio and no alignment endpoint on the transcription provider. When
 * `aligner` is absent this returns an honest refusal instead of approximating.
 *
 * A test may inject a deterministic fixture aligner; fixture intervals prove the
 * plumbing and validation only and are never evidence of acoustic accuracy.
 *
 * @param {object} params
 * @param {Blob|null} params.audio - Source audio for the cue window
 * @param {string[]} params.tokens - Target-language tokens in cue order
 * @param {number} params.cueStart
 * @param {number} params.cueEnd
 * @param {string} [params.language]
 * @param {Function|null} [params.aligner] - async ({ audio, tokens, cueStart, cueEnd, language, signal }) => raw
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<object>} Alignment record
 */
export async function alignTranslatedWords({
    audio = null,
    tokens = [],
    cueStart,
    cueEnd,
    language = null,
    aligner = null,
    signal,
} = {}) {
    if (!Array.isArray(tokens) || tokens.length === 0) {
        return createUnavailableAlignment(ALIGNMENT_UNAVAILABLE_REASONS.EMPTY_TARGET, { language });
    }
    if (typeof aligner !== "function") {
        return createUnavailableAlignment(ALIGNMENT_UNAVAILABLE_REASONS.NO_PROVIDER, { language });
    }
    signal?.throwIfAborted?.();
    let raw;
    try {
        raw = await aligner({ audio, tokens, cueStart, cueEnd, language, signal });
    } catch (error) {
        if (signal?.aborted) return createUnavailableAlignment(ALIGNMENT_UNAVAILABLE_REASONS.PROVIDER_ABORTED, { language });
        if (error?.name === "TimeoutError" || error?.name === "AbortError") {
            return createUnavailableAlignment(ALIGNMENT_UNAVAILABLE_REASONS.PROVIDER_TIMEOUT, { language });
        }
        return createUnavailableAlignment(ALIGNMENT_UNAVAILABLE_REASONS.PROVIDER_FAILED, { language });
    }
    signal?.throwIfAborted?.();
    return normalizeAlignmentResult(raw, { tokens, cueStart, cueEnd, language });
}

/**
 * Reports whether this build can produce target-language alignment at all.
 *
 * @param {Function|null} [aligner]
 * @returns {{ available: boolean, reason: string|null, description: string }}
 */
export function getAlignmentCapability(aligner = null) {
    if (typeof aligner === "function") {
        return { available: true, reason: null, description: "A target-language aligner is configured." };
    }
    return {
        available: false,
        reason: ALIGNMENT_UNAVAILABLE_REASONS.NO_PROVIDER,
        description: "No target-language word aligner is available in this build. Local Whisper transcribes the spoken audio; it cannot align supplied translated text, and the translation provider returns no word timings. Translated karaoke therefore stays disabled instead of showing guessed timing.",
    };
}
