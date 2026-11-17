import { NORMALIZATION_REVIEW_REASONS, preserveNormalization } from "./normalizationSafety.js";
import { createTargetWordTiming } from "./karaoke.js";
import { validateAlignedWords } from "./wordAlignment.js";
import { attachPhraseTimingToCue, derivePhraseTiming } from "./phraseTiming.js";
// Provider contract: https://ollalink.com/docs/translation/ (checked 2026-10-29).
export const TRANSLATION_LANGUAGES = Object.freeze({ en: "English", hi: "हिन्दी", es: "Español", fr: "Français", zh: "中文", de: "Deutsch", ar: "العربية", pt: "Português (Brasil)", ru: "Русский" });
export const NORMALIZATION_LANGUAGES = Object.freeze({ en: "English", hi: "हिन्दी" });
// Scheduling default, not a total-caption or backend cue-count restriction.
export const TEXT_TOOL_BATCH_SIZE = 20;
// Bounded adaptive concurrency. The provider documents 600 requests/60s per key
// but does not document a simultaneous-connection allowance, so the start is
// deliberately conservative and the ceiling stays far below the request quota.
export const TEXT_TOOL_INITIAL_CONCURRENCY = 2;
export const TEXT_TOOL_MAX_CONCURRENCY = 4;
// Mirror of the authenticated route limiter (SUBTITLE_TOOL_REQUESTS_PER_MINUTE in
// server/routes/subtitleTools.js). The client schedules against it instead of
// provoking avoidable 429 responses. Keep this in step with the server: a stale
// mirror would silently throttle long jobs far below the permitted rate.
export const TEXT_TOOL_ROUTE_REQUESTS_PER_MINUTE = 60;
export const TEXT_TOOL_MAX_CHARACTERS = 10000;
export const TEXT_TOOL_MAX_CUE_CHARACTERS = 5000;
export const textCharacterCount = text => Array.from(text).length;

export function validateSubtitleTextRequest(body) {
    const fail = (code = "INVALID_TEXT_REQUEST") => { const error = new Error("Invalid subtitle text request."); error.code = code; throw error; };
    if (!body || typeof body !== "object" || Array.isArray(body)) fail();
    const { operation, source, target, language, cues } = body;
    if (!["translate", "normalize"].includes(operation)) fail();
    const allowed = operation === "translate" ? ["operation", "source", "target", "cues"] : ["operation", "language", "cues"];
    if (Object.keys(body).some(key => !allowed.includes(key))) fail();
    const has = (list, code) => typeof code === "string" && Object.hasOwn(list, code);
    if (operation === "translate" ? !has(TRANSLATION_LANGUAGES, target) || (source !== undefined && !has(TRANSLATION_LANGUAGES, source)) : !has(NORMALIZATION_LANGUAGES, language)) fail("UNSUPPORTED_LANGUAGE");
    if (!Array.isArray(cues) || !cues.length) fail("TEXT_LIMIT_EXCEEDED");
    let total = 0;
    const ids = new Set();
    for (const cue of cues) {
        if (!cue || typeof cue !== "object" || Object.keys(cue).some(key => !["id", "text"].includes(key)) || typeof cue.id !== "string" || !cue.id || cue.id.length > 200 || ids.has(cue.id) || typeof cue.text !== "string" || !cue.text.trim()) fail();
        ids.add(cue.id);
        const count = textCharacterCount(cue.text);
        total += count;
        if (count > TEXT_TOOL_MAX_CUE_CHARACTERS || total > TEXT_TOOL_MAX_CHARACTERS) fail("TEXT_LIMIT_EXCEEDED");
    }
    return body;
}

// A conservative structural guard, not a semantic number parser. Only spoken
// number spans may differ; existing numeric literals/identifiers must survive.
// Ambiguous number interpretation still requires the explicit human review.
const numberWords = new Set(("zero oh o one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million billion trillion lakh crore first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth twentieth thirtieth fortieth fiftieth sixtieth seventieth eightieth ninetieth hundredth thousandth " +
    "शून्य एक दो तीन चार पाँच पांच छह छः सात आठ नौ दस ग्यारह बारह तेरह चौदह पंद्रह पन्द्रह सोलह सत्रह अठारह उन्नीस बीस इक्कीस बाईस तेईस चौबीस पच्चीस छब्बीस सत्ताईस अट्ठाईस उनतीस तीस इकतीस बत्तीस तैंतीस चौंतीस पैंतीस छत्तीस सैंतीस अड़तीस उनतालीस चालीस इकतालीस बयालीस तैंतालीस चवालीस पैंतालीस छियालीस सैंतालीस अड़तालीस उनचास पचास इक्यावन बावन तिरपन चौवन पचपन छप्पन सत्तावन अट्ठावन उनसठ साठ इकसठ बासठ तिरसठ चौंसठ पैंसठ छियासठ सड़सठ अड़सठ उनहत्तर सत्तर इकहत्तर बहत्तर तिहत्तर चौहत्तर पचहत्तर छिहत्तर सतहत्तर अठहत्तर उन्नासी अस्सी इक्यासी बयासी तिरासी चौरासी पचासी छियासी सत्तासी अट्ठासी नवासी नब्बे इक्यानवे बानवे तिरानवे चौरानवे पंचानवे छियानवे सत्तानवे अट्ठानवे निन्यानवे सौ हज़ार हजार लाख करोड़").split(/\s+/));
const normalizationTokens = text => text.match(/[\p{L}\p{M}\p{N}]+(?:[.,:-][\p{L}\p{M}\p{N}]+)*|[^\s]/gu) || [];
export function isNumberOnlyNormalization(original, normalized) {
    if (original === normalized) return true;
    const numeric = token => /^\p{N}+(?:[.,:-]\p{N}+)*(?:st|nd|rd|th)?$/u.test(token);
    const spoken = token => token.split("-").every(word => numberWords.has(word.toLowerCase()));
    const skeleton = text => {
        const tokens = normalizationTokens(text);
        const isNumber = token => numeric(token) || spoken(token);
        return tokens.map((token, index) => isNumber(token) ||
            (["and", "point", "decimal", "दशमलव", "और"].includes(token.toLowerCase()) && isNumber(tokens[index - 1] || "") && isNumber(tokens[index + 1] || "")) ? "#" : token)
            .filter((token, index, all) => token !== "#" || all[index - 1] !== "#");
    };
    // Existing digits (including dates, decimals, phone strings and identifiers)
    // must remain byte-identical and in order. New digits may only be inserted.
    const existing = normalizationTokens(original).filter(token => /\p{N}/u.test(token));
    const output = normalizationTokens(normalized).filter(token => /\p{N}/u.test(token));
    let cursor = 0;
    for (const token of existing) {
        cursor = output.indexOf(token, cursor);
        if (cursor < 0) return false;
        cursor += 1;
    }
    return JSON.stringify(skeleton(original)) === JSON.stringify(skeleton(normalized));
}

export function validateSubtitleTextResult(data, request) {
    const invalid = () => { throw new Error("Invalid subtitle text response."); };
    if (!data || data.operation !== request.operation || !Array.isArray(data.results) || data.results.length !== request.cues.length) invalid();
    for (let i = 0; i < request.cues.length; i += 1) {
        const result = data.results[i];
        if (!result || result.id !== request.cues[i].id || typeof result.text !== "string" || !result.text.trim() || textCharacterCount(result.text) > 20000) invalid();
        if (request.operation === "translate" && typeof result.numbersVerified !== "boolean") invalid();
        if (request.operation === "normalize") {
            const original = request.cues[i].text;
            if (typeof result.changed !== "boolean" || result.changed !== (result.text !== original) || !isNumberOnlyNormalization(original, result.text)) invalid();
            if (result.reviewReasons !== undefined && (!Array.isArray(result.reviewReasons) || result.reviewReasons.length > NORMALIZATION_REVIEW_REASONS.length || result.reviewReasons.some(reason => !NORMALIZATION_REVIEW_REASONS.includes(reason)) || (result.reviewReasons.length && result.text !== original))) invalid();
            // Defense in depth: backend output must already have retained original
            // formatting and held back uncertain conversions before reaching review.
            if (preserveNormalization(original, result.text).text !== result.text) invalid();
        }
    }
    return data.results;
}

export async function requestSubtitleTextTools(request, { signal, fetchImpl = globalThis.fetch, onRateLimit } = {}) {
    signal?.throwIfAborted();
    validateSubtitleTextRequest(request);
    const deadline = AbortSignal.timeout(130000);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
        const response = await fetchImpl("/api/subtitle-tools", {
            method: "POST", credentials: "include", signal: combined,
            headers: { "Content-Type": "application/json", "X-Subtitle-Tools-Request": "1" },
            body: JSON.stringify(request),
        });
        combined.throwIfAborted();
        const retryAfter = response.headers?.get("retry-after") ?? null;
        const reset = Number(response.headers?.get("x-ratelimit-reset")) * 1000;
        const retryAt = retryAfter === null ? 0 : Number.isFinite(Number(retryAfter)) ? Date.now() + Math.max(0, Number(retryAfter)) * 1000 : Date.parse(retryAfter);
        const rateLimited = response.status === 429 || response.headers?.get("x-ratelimit-remaining") === "0";
        if (rateLimited) onRateLimit?.(Math.max(Date.now() + (response.status === 429 ? 1000 : 0), retryAt || 0, reset || 0) + 1000);
        if (!response.ok) throw new Error(response.status === 401 ? "Sign in to use Ollalink subtitle tools." : response.status === 429 ? "Subtitle tools are rate limited. Retry after the cooldown." : "Ollalink subtitle processing failed. Original captions are unchanged.");
        const data = await response.json();
        combined.throwIfAborted();
        if (data.ok !== true) throw new Error("Ollalink subtitle processing failed.");
        return validateSubtitleTextResult(data, request);
    } catch (error) {
        if (signal?.aborted) signal.throwIfAborted();
        if (deadline.aborted) throw new Error("Subtitle processing timed out. Original captions are unchanged.", { cause: error });
        throw error;
    }
}

// Compare the complete snapshot, not just text: timeline edits, project switches,
// deletion, reordering and word edits must invalidate a pending review as well.
export const subtitleSnapshotKey = captions => JSON.stringify(captions);

export function applySubtitleTextReview(current, snapshot, results, alignments = null, options = {}) {
    if (subtitleSnapshotKey(current) !== subtitleSnapshotKey(snapshot)) throw new Error("Captions changed. Discard this review and run the action again.");
    if (!Array.isArray(results) || !results.length || new Set(results.map(result => result.id)).size !== results.length) throw new Error("Invalid subtitle review.");
    const byId = new Map(results.map(result => [result.id, result]));
    const snapshotIds = new Set(snapshot.map(cue => cue.id));
    for (const result of results) {
        if (!snapshotIds.has(result.id) || typeof result.text !== "string" || !result.text.trim() || textCharacterCount(result.text) > 20000) throw new Error("Invalid subtitle review.");
    }
    // Target-language alignment is optional and always second-hand: it must come
    // from a real aligner, be validated against this cue's own interval, and be
    // stored separately from the source-language `words` array.
    const suppliedAlignment = cue => {
        if (!alignments) return null;
        const record = alignments instanceof Map ? alignments.get(cue.id) : alignments[cue.id];
        return record ?? null;
    };
    const alignmentFor = cue => {
        const record = suppliedAlignment(cue);
        if (!record || record.aligned !== true || record.status !== "aligned") return null;
        const validation = validateAlignedWords(record.words, cue.start, cue.end);
        if (!validation.valid) return null;
        if (Array.isArray(record.unalignedIndices) && record.unalignedIndices.length) return null;
        return record;
    };
    return current.map(cue => {
        const result = byId.get(cue.id);
        if (!result || result.text === cue.text) return cue;
        const next = { ...cue, text: result.text, timingSource: "manual" };
        // Translation and number collapsing do not provide target-word alignment.
        // Use existing phrase rendering instead of attaching source words to new text.
        delete next.words;
        delete next.alignedWords;
        delete next.wordTimingSource;
        delete next.wordAlignment;
        delete next.phraseTiming;
        const alignment = alignmentFor(cue);
        // Only a fully validated, genuinely aligned record may drive translated
        // karaoke. Anything else leaves the cue on plain phrase rendering.
        if (alignment) {
            Object.assign(next, createTargetWordTiming(alignment.words), { wordAlignment: alignment });
            return next;
        }
        // A word-level alignment was explicitly supplied for this cue and did
        // not validate. Silently degrading to a weaker phrase-level highlight
        // would mask a failed alignment as a success, so nothing is attached.
        if (suppliedAlignment(cue)) return next;
        // No aligner available: derive phrase-level synchronization from this
        // cue's own genuine source word intervals. The source `words` array is
        // read only, never rewritten, and the derived record is stored under
        // `phraseTiming` so it can never be mistaken for target-word alignment.
        const phraseTiming = derivePhraseTiming({
            sourceWords: cue.words,
            cueStart: cue.start,
            cueEnd: cue.end,
            targetText: result.text,
            language: typeof options.target === "string" ? options.target : null,
            previousRecord: cue.phraseTiming,
        });
        if (phraseTiming) {
            return attachPhraseTimingToCue(next, phraseTiming);
        }
        return next;
    });
}
