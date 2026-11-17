import { captureTranscriptionPreferences } from "./transcriptionPreferences.js";
import { captionSegmentsFromWords } from "./captionSegmentation.js";
import { cloudTranscriptionLane, encodeCloudWav, validateCloudWav } from "./cloudTranscriptionAudio.js";
import {
    attachTranscriptionErrorOutcome, attachTranscriptionOutcome,
    CLOUD_FALLBACK_REASON_CODES, createTranscriptionOutcome,
} from "./transcriptionOutcome.js";

const safeError = (code) => Object.assign(new Error("Cloud transcription unavailable; local transcription can be used."), { code });
const cancelled = (signal) => { if (signal?.aborted) throw new DOMException("Cancelled", "AbortError"); };
// Preserve preparation error identities/codes without allowing a misleading code
// from WAV preparation to cross the dispatcher fallback boundary.
const preparationErrors = new WeakSet();

export async function requestCloudTranscript(audio, language, { signal, fetchImpl = globalThis.fetch, timeoutMs = 130000 } = {}) {
    cancelled(signal);
    cloudTranscriptionLane(language);
    let wav;
    try {
        wav = encodeCloudWav(audio);
        validateCloudWav(new Uint8Array(await wav.arrayBuffer()), language);
    } catch (error) {
        if (error && (typeof error === "object" || typeof error === "function")) preparationErrors.add(error);
        throw error;
    }
    cancelled(signal);
    const deadline = AbortSignal.timeout(Number.isFinite(timeoutMs) ? Math.max(1, Math.min(130000, timeoutMs)) : 130000);
    const combinedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    // Only fetch/body-read failures are transport failures. Preparation and response
    // validation are outside this boundary, and no upload is ever repeated.
    const transportFailure = (error) => {
        if (error?.name === "AbortError") throw error;
        cancelled(signal);
        throw safeError(deadline.aborted ? "CLOUD_TIMEOUT"
            : error instanceof TypeError && !error.code ? "CLOUD_NETWORK_ERROR" : "CLOUD_UNKNOWN_ERROR");
    };
    let response;
    try {
        response = await fetchImpl(`/api/transcription?language=${encodeURIComponent(language)}`, {
            method: "POST", credentials: "include", redirect: "error", signal: combinedSignal,
            headers: { "Content-Type": "audio/wav", "X-Transcription-Request": "1" }, body: wav,
        });
    } catch (error) {
        if (deadline.aborted && !signal?.aborted) throw safeError("CLOUD_TIMEOUT");
        transportFailure(error);
    }
    cancelled(signal);
    if (deadline.aborted) throw safeError("CLOUD_TIMEOUT");
    if (!response || typeof response.ok !== "boolean" || typeof response.json !== "function") throw safeError("CLOUD_INVALID_RESPONSE");
    // Authentication/validation status wins even when its error body is unreadable.
    if (response.status === 401 || response.status === 403) throw safeError("CLOUD_SIGN_IN_REQUIRED");
    if (!response.ok && response.status < 500 && response.status !== 429) throw safeError("CLOUD_INVALID_REQUEST");
    let result;
    try { result = await response.json(); }
    catch (error) {
        if (error?.name === "AbortError" && !deadline.aborted) throw error;
        cancelled(signal);
        // An unreadable error response is not an explicit eligible outage.
        if (!response.ok) throw safeError("CLOUD_INVALID_RESPONSE");
        if (deadline.aborted) throw safeError("CLOUD_TIMEOUT");
        if (error instanceof SyntaxError) throw safeError("CLOUD_INVALID_RESPONSE");
        transportFailure(error);
    }
    cancelled(signal);
    if (deadline.aborted) throw safeError("CLOUD_TIMEOUT");
    if (!response.ok) {
        // Only documented temporary failures authorize Local, never an unknown 5xx.
        const code = result?.code;
        throw safeError(response.status === 401 || response.status === 403 || code === "OLLALINK_AUTH_FAILED" ? "CLOUD_SIGN_IN_REQUIRED"
            : code === "OLLALINK_INVALID_RESPONSE" ? "CLOUD_INVALID_RESPONSE"
                : code === "OLLALINK_NOT_CONFIGURED" ? "CLOUD_NOT_CONFIGURED"
                    : ["OLLALINK_INVALID_REQUEST", "INVALID_TRANSCRIPTION_REQUEST", "INVALID_AUDIO", "AUDIO_TOO_LONG", "AUDIO_TOO_LARGE", "UNSUPPORTED_LANGUAGE"].includes(code)
                        || (response.status < 500 && response.status !== 429) ? "CLOUD_INVALID_REQUEST"
                        : code === "TRANSCRIPTION_CANCELLED" ? "TRANSCRIPTION_CANCELLED"
                            : code === "OLLALINK_TIMEOUT" ? "CLOUD_TIMEOUT"
                                : ["OLLALINK_RATE_LIMITED", "OLLALINK_RETRY_LATER", "OLLALINK_PROVIDER_FAILED", "TRANSCRIPTION_BUSY"].includes(code)
                                    || (response.status === 429 && !code) ? "CLOUD_TRANSCRIPTION_FAILED"
                                    : "CLOUD_UNKNOWN_ERROR");
    }
    const expected = cloudTranscriptionLane(language) === "fast" ? "ollalink-fast" : "ollalink-hq";
    if (result?.ok !== true || result.provider !== expected || result.language !== language
        || !Number.isFinite(result.duration) || result.duration <= 0 || !Array.isArray(result.output?.chunks)
        || !result.output.chunks.length || result.output.chunks.some((chunk) => typeof chunk?.text !== "string"
            || !Array.isArray(chunk.timestamp) || chunk.timestamp.length !== 2
            || chunk.timestamp.some((time) => typeof time !== "number" || !Number.isFinite(time) || time < 0 || time > result.duration)
            || chunk.timestamp[1] < chunk.timestamp[0])) throw safeError("CLOUD_INVALID_RESPONSE");
    return result;
}

function markProvider(result, outcome) {
    return attachTranscriptionOutcome({
        ...result, provider: outcome.provider,
        ...(outcome.fallbackUsed ? {
            fallbackFrom: "ollalink", fallbackReason: "Cloud transcription temporarily unavailable; used local Whisper.",
        } : {}),
    }, outcome);
}

// All callers share saved spoken-language/provider preferences. No preference
// means Ollalink Cloud; an explicit Local Whisper choice is never overridden.
export async function transcribeWithProvider(blob, options = {}, { localTranscribe, decodeAudio, cloudTranscribe = requestCloudTranscript }) {
    options = captureTranscriptionPreferences(options);
    const { provider, language, signal, onProgress, timelineOffset = 0, grouping = "phrases" } = options;
    let actualProvider = null;
    let fallbackAttempted = false;
    let fallbackReasonCode = null;
    const outcome = (status, reasonCode = null) => createTranscriptionOutcome({
        status, requestedProvider: provider, provider: actualProvider,
        fallbackAttempted, fallbackUsed: fallbackAttempted && status === "succeeded",
        fallbackFrom: fallbackReasonCode ? "ollalink" : null, fallbackReasonCode, reasonCode,
    });
    const runLocal = async (fallback = false) => {
        cancelled(signal);
        const prefix = fallback ? "Local Whisper fallback" : "Local Whisper";
        let settled = false;
        let result;
        try {
            actualProvider = "local-whisper";
            fallbackAttempted = fallback;
            result = await localTranscribe(blob, onProgress ? {
                ...options, onProgress: (event) => {
                    // Local stage markers are not measured inference percentages.
                    if (!settled && !signal?.aborted) onProgress({ phase: `${prefix}: ${event.phase || "Transcribing"}` });
                }
            } : options);
        } finally {
            settled = true;
        }
        cancelled(signal);
        return markProvider(result, outcome("succeeded"));
    };
    try {
        cancelled(signal);
        if (provider === "local") return await runLocal();
        if (provider !== "ollalink") throw safeError("INVALID_TRANSCRIPTION_PROVIDER");
        const lane = cloudTranscriptionLane(language);
        onProgress?.({ phase: "Preparing audio for Ollalink cloud transcription" });
        cancelled(signal);
        const { audio } = await decodeAudio(blob);
        cancelled(signal);
        onProgress?.({ phase: "Transcribing with Ollalink cloud" });
        cancelled(signal);
        let result;
        try {
            actualProvider = lane === "fast" ? "ollalink-fast" : "ollalink-hq";
            result = await cloudTranscribe(audio, language, { signal });
        } catch (error) {
            if (error?.name === "AbortError") throw error;
            cancelled(signal);
            if (preparationErrors.has(error)) {
                actualProvider = null;
                throw error;
            }
            if (!CLOUD_FALLBACK_REASON_CODES.includes(error?.code)) throw error;
            fallbackReasonCode = error.code;
        }
        // This is deliberately outside the eligible Cloud catch: callback and
        // Local errors must not be mistaken for another outage or retried.
        if (fallbackReasonCode) {
            onProgress?.({ phase: "Ollalink unavailable; falling back to Local Whisper" });
            cancelled(signal);
            return await runLocal(true);
        }
        cancelled(signal);
        const segments = captionSegmentsFromWords(result.output.chunks, result.duration, { timelineOffset, grouping });
        onProgress?.({ phase: `Captions generated by ${result.provider}` });
        cancelled(signal);
        return markProvider({
            segments, text: segments.map((segment) => segment.text).join("\n"),
            duration: result.duration, language: result.language, languageDetected: false,
            rawChunks: result.output.chunks, modelId: result.modelId,
        }, outcome("succeeded"));
    } catch (error) {
        const isCancelled = signal?.aborted || error?.name === "AbortError" || error?.code === "TRANSCRIPTION_CANCELLED";
        const failure = signal?.aborted && error?.name !== "AbortError" ? new DOMException("Cancelled", "AbortError") : error;
        throw attachTranscriptionErrorOutcome(failure, outcome(isCancelled ? "cancelled" : "failed",
            isCancelled ? "TRANSCRIPTION_CANCELLED" : error?.code || "TRANSCRIPTION_FAILED"));
    }
}
