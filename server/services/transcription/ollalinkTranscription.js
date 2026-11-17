import { validateCloudWav } from "../../../src/lib/cloudTranscriptionAudio.js";

export const OLLALINK_ENDPOINTS = Object.freeze({
    fast: "https://gpu-transcribe.ollalink.com/v1/audio/transcriptions",
    hq: "https://gpu-asrhq.ollalink.com/v1/audio/transcriptions",
});

export class TranscriptionError extends Error {
    constructor(code, status = 502) {
        super("Cloud transcription is unavailable. Use local transcription or try again later.");
        this.name = "TranscriptionError";
        this.code = code;
        this.status = status;
    }
}

export function normalizeOllalinkTranscript(data, { language, duration, lane }) {
    const invalid = () => { throw new TranscriptionError("OLLALINK_INVALID_RESPONSE"); };
    if (!data || typeof data !== "object" || typeof data.text !== "string" || !data.text.trim()
        || data.language !== language || typeof data.duration !== "number" || !Number.isFinite(data.duration)
        || data.duration <= 0 || Math.abs(data.duration - duration) > Math.max(1, duration * 0.02)) invalid();
    // Fast verbose_json provides words; HQ provides words inside each segment.
    let words;
    if (lane === "fast") {
        words = data.words;
    } else {
        if (!Array.isArray(data.segments) || !data.segments.length
            || data.segments.some((segment) => !Array.isArray(segment?.words) || !segment.words.length)) invalid();
        words = data.segments.flatMap((segment) => segment.words);
    }
    if (!Array.isArray(words) || !words.length || words.length > 100000) invalid();
    let previousStart = -1;
    const chunks = words.map((word, index) => {
        if (!word || typeof word.word !== "string" || !word.word.trim() || word.word.length > 1000
            || typeof word.start !== "number" || typeof word.end !== "number"
            || !Number.isFinite(word.start) || !Number.isFinite(word.end)
            || word.start < 0 || word.end < word.start || word.start < previousStart
            || word.end > duration + 0.25) invalid();
        previousStart = word.start;
        const text = word.word.trim();
        const separator = index && !/[\u3400-\u9fff]/u.test(text) && !/^[.,!?;:，。！？]/u.test(text) ? " " : "";
        return { text: separator + text, timestamp: [Math.min(duration, word.start), Math.min(duration, word.end)] };
    });
    if (!chunks.some((chunk) => chunk.timestamp[1] > chunk.timestamp[0])) invalid();
    return {
        output: { text: data.text, chunks }, duration, language, languageDetected: false,
        provider: lane === "fast" ? "ollalink-fast" : "ollalink-hq",
        modelId: lane === "hq" ? "asr-legacy" : null,
    };
}

async function readBoundedJson(response) {
    const limit = 8_000_000;
    const reader = response.body?.getReader();
    if (!reader) throw new TranscriptionError("OLLALINK_INVALID_RESPONSE");
    let size = 0;
    const parts = [];
    try {
        for (; ;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit) throw new TranscriptionError("OLLALINK_INVALID_RESPONSE");
            parts.push(Buffer.from(value));
        }
        try { return JSON.parse(Buffer.concat(parts).toString("utf8")); }
        catch { throw new TranscriptionError("OLLALINK_INVALID_RESPONSE"); }
    } finally {
        await reader.cancel().catch(() => { });
        reader.releaseLock();
    }
}

export function createOllalinkTranscriber({ apiKey = "", fetchImpl = globalThis.fetch, timeoutMs = 120000 } = {}) {
    return async function transcribe(bytes, { language, signal } = {}) {
        let audio;
        try { audio = validateCloudWav(bytes, language); }
        catch (error) { throw new TranscriptionError(error.code || "INVALID_AUDIO", error.code === "AUDIO_TOO_LARGE" ? 413 : 400); }
        // GPU keys are not dashboard/partner Bearer keys. Never echo any value.
        if (!/^sk_[A-Za-z0-9_-]+$/.test(apiKey)) throw new TranscriptionError("OLLALINK_NOT_CONFIGURED", 503);
        const budget = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(180000, timeoutMs)) : 120000;
        const deadline = AbortSignal.timeout(budget);
        const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
        const { lane, duration } = audio;
        try {
            // Exactly one upstream attempt: never repeat a potentially billable upload.
            {
                requestSignal.throwIfAborted();
                const form = new FormData();
                form.set("file", new Blob([bytes], { type: "audio/wav" }), "audio.wav");
                form.set("language", language);
                // Keep spoken numbers and word text aligned; no translation or prompts.
                form.set("normalize_numbers", "false");
                if (lane === "fast") form.set("response_format", "verbose_json");
                else {
                    form.set("model", "asr-legacy");
                    form.set("word_timestamps", "true");
                }
                const response = await fetchImpl(OLLALINK_ENDPOINTS[lane], {
                    method: "POST", headers: { "X-NH-GPU-Key": apiKey }, body: form,
                    signal: requestSignal, redirect: "error",
                });
                requestSignal.throwIfAborted();
                if (response.ok) {
                    const data = await readBoundedJson(response);
                    requestSignal.throwIfAborted();
                    return normalizeOllalinkTranscript(data, { language, duration, lane });
                }
                const status = response.status;
                // Do not parse or log upstream errors; they may echo request data.
                await response.body?.cancel().catch(() => { });
                if (status === 401 || status === 403) throw new TranscriptionError("OLLALINK_AUTH_FAILED", 503);
                throw new TranscriptionError(status === 429 ? "OLLALINK_RATE_LIMITED"
                    : status >= 400 && status < 500 ? "OLLALINK_INVALID_REQUEST" : "OLLALINK_PROVIDER_FAILED",
                    status === 429 ? 429 : status >= 400 && status < 500 ? 400 : 502);
            }
        } catch (error) {
            if (signal?.aborted) throw new TranscriptionError("TRANSCRIPTION_CANCELLED", 499);
            if (deadline.aborted) throw new TranscriptionError("OLLALINK_TIMEOUT", 504);
            if (error instanceof TranscriptionError) throw error;
            throw new TranscriptionError("OLLALINK_PROVIDER_FAILED");
        }
    };
}
