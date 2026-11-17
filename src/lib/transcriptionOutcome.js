// Serializable, additive provenance. Never copy exception messages or arbitrary codes.
export const CLOUD_FALLBACK_REASON_CODES = Object.freeze([
    "CLOUD_TRANSCRIPTION_FAILED", "CLOUD_TIMEOUT", "CLOUD_NETWORK_ERROR",
]);
const providers = new Set(["local-whisper", "ollalink-fast", "ollalink-hq"]);
const requestedProviders = new Set(["local", "ollalink"]);
const reasonCodes = new Set([
    ...CLOUD_FALLBACK_REASON_CODES, "CLOUD_SIGN_IN_REQUIRED", "CLOUD_INVALID_REQUEST",
    "CLOUD_INVALID_RESPONSE", "CLOUD_UNKNOWN_ERROR", "CLOUD_NOT_CONFIGURED",
    "INVALID_TRANSCRIPTION_PROVIDER", "UNSUPPORTED_LANGUAGE", "INVALID_AUDIO",
    "AUDIO_TOO_LONG", "AUDIO_TOO_LARGE", "EDITOR_BUSY", "TRANSCRIPTION_CANCELLED",
    "TRANSCRIPTION_FAILED",
]);
const errorOutcomes = new WeakMap();
const isObject = (value) => value !== null && (typeof value === "object" || typeof value === "function");

export function createTranscriptionOutcome({
    status = "failed", requestedProvider = null, provider = null,
    fallbackAttempted = false, fallbackUsed = false, fallbackFrom = null,
    fallbackReasonCode = null, reasonCode = null,
} = {}) {
    return Object.freeze({
        status: ["succeeded", "failed", "cancelled"].includes(status) ? status : "failed",
        requestedProvider: requestedProviders.has(requestedProvider) ? requestedProvider : null,
        provider: providers.has(provider) ? provider : null,
        fallbackAttempted: fallbackAttempted === true,
        fallbackUsed: fallbackUsed === true,
        fallbackFrom: fallbackFrom === "ollalink" ? "ollalink" : null,
        fallbackReasonCode: CLOUD_FALLBACK_REASON_CODES.includes(fallbackReasonCode) ? fallbackReasonCode : null,
        reasonCode: reasonCodes.has(reasonCode) ? reasonCode : null,
    });
}

// Accept a result, segment, error, segment array or an outcome itself.
export function getTranscriptionOutcome(source) {
    if (!isObject(source)) return null;
    const outcome = errorOutcomes.get(source) || source.transcriptionOutcome;
    if (outcome) return createTranscriptionOutcome(outcome);
    if (Array.isArray(source)) {
        for (const segment of source) {
            const found = getTranscriptionOutcome(segment);
            if (found) return found;
        }
        return null;
    }
    return ["succeeded", "failed", "cancelled"].includes(source.status)
        && Object.hasOwn(source, "requestedProvider") ? createTranscriptionOutcome(source) : null;
}

// Return copies; preserve every caption field, including word timing arrays.
export function attachTranscriptionOutcome(target, source) {
    const outcome = getTranscriptionOutcome(source);
    if (!outcome || !isObject(target)) return target;
    if (Array.isArray(target)) return target.map((segment) => attachTranscriptionOutcome(segment, outcome));
    return {
        ...target, transcriptionOutcome: outcome,
        ...(outcome.provider ? { transcriptionProvider: outcome.provider } : {}),
        ...(Array.isArray(target.segments) ? { segments: attachTranscriptionOutcome(target.segments, outcome) } : {}),
    };
}

// For regrouped/reviewed/downstream captions: preserve provenance explicitly.
export function preserveTranscriptionOutcome(captions, source) {
    return attachTranscriptionOutcome(captions, source);
}

// Do not wrap or rename errors. WeakMap also supports frozen/non-extensible errors.
export function attachTranscriptionErrorOutcome(error, source) {
    const outcome = getTranscriptionOutcome(source);
    if (isObject(error) && outcome) {
        errorOutcomes.set(error, outcome);
        try { error.transcriptionOutcome = outcome; } catch { /* Identity takes priority. */ }
    }
    return error;
}

export function transcriptionProviderLabel(source) {
    const outcome = getTranscriptionOutcome(source);
    const provider = outcome?.provider || (providers.has(source?.provider) ? source.provider
        : providers.has(source?.transcriptionProvider) ? source.transcriptionProvider : null);
    if (provider === "local-whisper") return outcome?.fallbackUsed || source?.fallbackFrom === "ollalink"
        ? "Local Whisper fallback" : "Local Whisper";
    if (provider === "ollalink-fast") return "Ollalink fast";
    if (provider === "ollalink-hq") return "Ollalink HQ";
    return null;
}
