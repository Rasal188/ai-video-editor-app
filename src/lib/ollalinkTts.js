// Public editor contract only. Provider credentials belong exclusively on the server.
// Voice/language syntax is bounded here; membership is independently checked by
// the server against its current authenticated catalog before any paid POST.
export const OLLALINK_TTS_MAX_CHARACTERS = 4000; // Conservative UTF-16 code units.
export const OLLALINK_TTS_MAX_AUDIO_BYTES = 32 * 1024 * 1024;
export const OLLALINK_TTS_MAX_AUDIO_SECONDS = 600;
export const OLLALINK_TTS_SAMPLE_RATE = 24000;
export const OLLALINK_TTS_CLIENT_TIMEOUT_MS = 130000;

const errors = Object.freeze({
    INVALID_TTS_REQUEST: [400, "Use text, a fixed voice, an explicit supported language, and WAV format only."],
    TTS_CATALOG_UNAVAILABLE: [503, "Cloud voice catalog could not be loaded. Refresh the catalog or explicitly use local TTS instead."],
    TTS_CATALOG_MISMATCH: [400, "This voice and language are no longer listed together. Refresh the catalog and explicitly choose a listed pair."],
    TTS_PROVIDER_REJECTED: [400, "The provider rejected this speech request. The catalog may have changed; refresh it and check your explicit voice and language selection."],
    TTS_TEXT_TOO_LONG: [413, "Speech text must not exceed 4,000 characters."],
    TTS_AUDIO_TOO_LARGE: [502, "Generated speech exceeds the editor audio limit."],
    TTS_INVALID_AUDIO: [502, "Speech must be a valid PCM16 mono 24 kHz WAV within the editor limits."],
    TTS_VOICE_MISMATCH: [502, "The speech provider returned a different voice."],
    TTS_NOT_CONFIGURED: [503, "Ollalink speech is not configured on the server."],
    TTS_AUTH_FAILED: [503, "Ollalink speech authentication failed."],
    TTS_RATE_LIMITED: [429, "Speech generation is busy. Try again later."],
    TTS_BUSY: [503, "Speech generation is busy. Try again later."],
    TTS_TIMEOUT: [504, "Speech generation timed out. Completion and billing may be uncertain; do not automatically resubmit."],
    TTS_CANCELLED: [499, "Speech generation was cancelled. Provider completion and billing may still occur."],
    TTS_SIGN_IN_REQUIRED: [401, "Sign in to generate speech."],
    TTS_FORBIDDEN: [403, "A same-origin speech request is required."],
    TTS_FAILED: [502, "Speech generation failed. Completion and billing may be uncertain; do not automatically resubmit."],
});

export class OllalinkTtsError extends Error {
    constructor(code = "TTS_FAILED") {
        const safeCode = Object.hasOwn(errors, code) ? code : "TTS_FAILED";
        super(errors[safeCode][1]);
        this.name = "OllalinkTtsError";
        this.code = safeCode;
        this.status = errors[safeCode][0];
    }
}

export function validateOllalinkTtsRequest(request) {
    const fail = code => { throw new OllalinkTtsError(code || "INVALID_TTS_REQUEST"); };
    if (!request || typeof request !== "object" || Array.isArray(request)) fail();
    const keys = Reflect.ownKeys(request);
    if (keys.length !== 4 || keys.some(key => !["input", "voice", "language", "response_format"].includes(key))) fail();
    const { input, voice, language, response_format } = request;
    if (typeof input !== "string" || !input.trim() || input.includes("\0")) fail();
    if (input.length > OLLALINK_TTS_MAX_CHARACTERS) fail("TTS_TEXT_TOO_LONG");
    // Reject malformed Unicode instead of silently replacing it on the wire.
    for (let i = 0; i < input.length; i++) {
        const unit = input.charCodeAt(i);
        if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = input.charCodeAt(++i);
            if (!(next >= 0xdc00 && next <= 0xdfff)) fail();
        } else if (unit >= 0xdc00 && unit <= 0xdfff) fail();
    }
    if (typeof voice !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(voice) ||
        typeof language !== "string" || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(language) || response_format !== "wav") fail();
    return { input, voice, language, response_format: "wav" };
}

// Race even injected implementations that ignore AbortSignal. No upstream error
// text is exposed by callers. The underlying promise remains rejection-handled.
export function awaitTtsAbortable(promise, signal) {
    if (!signal) return Promise.resolve(promise);
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason || new OllalinkTtsError("TTS_CANCELLED"));
        signal.addEventListener("abort", abort, { once: true });
        Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
        if (signal.aborted) abort();
    });
}

export function createTtsDeadline(timeoutMs, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort(new OllalinkTtsError("TTS_CANCELLED"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new OllalinkTtsError("TTS_TIMEOUT")), timeoutMs);
    return {
        signal: controller.signal,
        dispose() { clearTimeout(timer); signal?.removeEventListener("abort", abort); },
    };
}

// Cancellation is best effort and never awaited: an upstream cancel hook may stall.
export function cancelTtsBody(response) {
    try { Promise.resolve(response?.body?.cancel()).catch(() => { }); } catch { /* locked/closed stream */ }
}

export async function readBoundedTtsAudio(response, { signal, maxBytes = OLLALINK_TTS_MAX_AUDIO_BYTES } = {}) {
    const limit = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? Math.min(maxBytes, OLLALINK_TTS_MAX_AUDIO_BYTES) : OLLALINK_TTS_MAX_AUDIO_BYTES;
    let reader;
    let completed = false;
    const cancel = () => { try { Promise.resolve(reader?.cancel()).catch(() => { }); } catch { /* closed stream */ } };
    try {
        signal?.throwIfAborted();
        const length = response.headers.get("content-length");
        if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) throw new OllalinkTtsError("TTS_INVALID_AUDIO");
        if (length !== null && Number(length) > limit) throw new OllalinkTtsError("TTS_AUDIO_TOO_LARGE");
        if (!response.body?.getReader) throw new OllalinkTtsError("TTS_INVALID_AUDIO");
        reader = response.body.getReader();
        signal?.addEventListener("abort", cancel, { once: true });
        // Geometric storage bounds overhead even for millions of tiny chunks.
        let bytes = new Uint8Array(Math.min(limit, 65536));
        let total = 0;
        for (; ;) {
            signal?.throwIfAborted();
            const { done, value } = await awaitTtsAbortable(reader.read(), signal);
            signal?.throwIfAborted();
            if (done) break;
            if (!(value instanceof Uint8Array)) throw new OllalinkTtsError("TTS_INVALID_AUDIO");
            const nextTotal = total + value.byteLength;
            if (nextTotal > limit) throw new OllalinkTtsError("TTS_AUDIO_TOO_LARGE");
            if (nextTotal > bytes.length) {
                const grown = new Uint8Array(Math.min(limit, Math.max(nextTotal, bytes.length * 2)));
                grown.set(bytes.subarray(0, total));
                bytes = grown;
            }
            bytes.set(value, total);
            total = nextTotal;
        }
        if (!total || (length !== null && total !== Number(length))) throw new OllalinkTtsError("TTS_INVALID_AUDIO");
        completed = true;
        return bytes.slice(0, total);
    } finally {
        signal?.removeEventListener("abort", cancel);
        if (!completed) { if (reader) cancel(); else cancelTtsBody(response); }
        try { reader?.releaseLock(); } catch { /* pending read after cancellation */ }
    }
}

export function validateOllalinkTtsHeaders(headers, voice) {
    const mime = (headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!["audio/wav", "audio/wave", "audio/x-wav"].includes(mime)) throw new OllalinkTtsError("TTS_INVALID_AUDIO");
    const encoding = headers.get("content-encoding");
    if (encoding && encoding.toLowerCase() !== "identity") throw new OllalinkTtsError("TTS_INVALID_AUDIO");
    const resolved = headers.get("x-tts-voice");
    if (resolved !== null && resolved !== voice) throw new OllalinkTtsError("TTS_VOICE_MISMATCH");
    const rate = headers.get("x-audio-sample-rate");
    if (rate !== null && rate !== String(OLLALINK_TTS_SAMPLE_RATE)) throw new OllalinkTtsError("TTS_INVALID_AUDIO");
}

// Deliberately narrow editor policy: RIFF/WAVE, PCM16, mono, 24 kHz only.
// Float/extensible/compressed WAV and RF64 are NOT supported in this phase.
export function validateOllalinkTtsWav(audio) {
    const invalid = () => { throw new OllalinkTtsError("TTS_INVALID_AUDIO"); };
    const bytes = audio instanceof Uint8Array ? audio : audio instanceof ArrayBuffer ? new Uint8Array(audio) : null;
    if (!bytes || bytes.byteLength < 44) invalid();
    if (bytes.byteLength > OLLALINK_TTS_MAX_AUDIO_BYTES) throw new OllalinkTtsError("TTS_AUDIO_TOO_LARGE");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = offset => String.fromCharCode(...bytes.subarray(offset, offset + 4));
    if (tag(0) !== "RIFF" || tag(8) !== "WAVE" || view.getUint32(4, true) + 8 !== bytes.length) invalid();
    let offset = 12;
    let format = false;
    let dataBytes = 0;
    while (offset < bytes.length) {
        if (offset + 8 > bytes.length) invalid();
        const id = tag(offset);
        const size = view.getUint32(offset + 4, true);
        const start = offset + 8;
        const end = start + size;
        const paddedEnd = end + (size % 2);
        if (paddedEnd > bytes.length) invalid();
        if (id === "fmt ") {
            if (format || dataBytes || ![16, 18].includes(size)) invalid();
            if (view.getUint16(start, true) !== 1 || view.getUint16(start + 2, true) !== 1 ||
                view.getUint32(start + 4, true) !== OLLALINK_TTS_SAMPLE_RATE ||
                view.getUint32(start + 8, true) !== OLLALINK_TTS_SAMPLE_RATE * 2 ||
                view.getUint16(start + 12, true) !== 2 || view.getUint16(start + 14, true) !== 16 ||
                (size === 18 && view.getUint16(start + 16, true) !== 0)) invalid();
            format = true;
        } else if (id === "data") {
            if (!format || dataBytes || !size || size % 2) invalid();
            dataBytes = size;
        }
        offset = paddedEnd;
    }
    if (!format || !dataBytes || offset !== bytes.length) invalid();
    const durationSeconds = dataBytes / (OLLALINK_TTS_SAMPLE_RATE * 2);
    if (durationSeconds > OLLALINK_TTS_MAX_AUDIO_SECONDS) invalid();
    return { durationSeconds, sampleRate: OLLALINK_TTS_SAMPLE_RATE, channels: 1, bitsPerSample: 16, dataBytes, mimeType: "audio/wav" };
}

// Returns browser-safe bytes and validated dimensions; never retries paid work.
export async function requestOllalinkSpeech(request, { signal, fetchImpl = globalThis.fetch } = {}) {
    const body = validateOllalinkTtsRequest(request);
    const deadline = createTtsDeadline(OLLALINK_TTS_CLIENT_TIMEOUT_MS, signal);
    let response;
    try {
        deadline.signal.throwIfAborted();
        const pending = Promise.resolve(fetchImpl("/api/tts", {
            method: "POST", credentials: "include", redirect: "error", signal: deadline.signal,
            headers: { "Content-Type": "application/json", "X-TTS-Request": "1" },
            body: JSON.stringify(body),
        }));
        pending.then(late => { if (deadline.signal.aborted) cancelTtsBody(late); }, () => { });
        response = await awaitTtsAbortable(pending, deadline.signal);
        deadline.signal.throwIfAborted();
        if (!response.ok) {
            let code = response.status === 401 ? "TTS_SIGN_IN_REQUIRED" : response.status === 403 ? "TTS_FORBIDDEN" : response.status === 429 ? "TTS_RATE_LIMITED" : response.status === 504 ? "TTS_TIMEOUT" : "TTS_FAILED";
            // Only our backend's bounded closed codes, never provider text/messages.
            if (response.status === 400) {
                try {
                    const bytes = await readBoundedTtsAudio(response, { signal: deadline.signal, maxBytes: 4096 });
                    const own = JSON.parse(new TextDecoder().decode(bytes));
                    if (["TTS_PROVIDER_REJECTED", "TTS_CATALOG_MISMATCH"].includes(own.code)) code = own.code;
                } catch { deadline.signal.throwIfAborted(); }
            }
            throw new OllalinkTtsError(code);
        }
        validateOllalinkTtsHeaders(response.headers, body.voice);
        const bytes = await readBoundedTtsAudio(response, { signal: deadline.signal });
        const audio = validateOllalinkTtsWav(bytes);
        deadline.signal.throwIfAborted();
        return { bytes, voice: body.voice, language: body.language, ...audio };
    } catch (error) {
        cancelTtsBody(response);
        if (signal?.aborted) throw new OllalinkTtsError("TTS_CANCELLED");
        if (deadline.signal.aborted) throw new OllalinkTtsError("TTS_TIMEOUT");
        throw error instanceof OllalinkTtsError ? new OllalinkTtsError(error.code) : new OllalinkTtsError();
    } finally { deadline.dispose(); }
}
