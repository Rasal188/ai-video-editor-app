import {
    OllalinkTtsError, validateOllalinkTtsRequest, validateOllalinkTtsHeaders,
    readBoundedTtsAudio, validateOllalinkTtsWav, awaitTtsAbortable,
    createTtsDeadline, cancelTtsBody,
} from "../../../src/lib/ollalinkTts.js";
import {
    hasOllalinkTtsPair, readOllalinkTtsCatalog, OLLALINK_TTS_CATALOG_TIMEOUT_MS,
} from "../../../src/lib/ollalinkTtsCatalog.js";

const SPEECH_URL = "https://gpu-tts.ollalink.com/v1/audio/speech";
const VOICES_URL = "https://gpu-tts.ollalink.com/voices";
const checkKey = apiKey => {
    if (typeof apiKey !== "string" || !/^sk_[A-Za-z0-9_-]+$/.test(apiKey)) throw new OllalinkTtsError("TTS_NOT_CONFIGURED");
};

export function createOllalinkTtsCatalog({ apiKey = "", fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    let cached, expires = 0, inflight;
    const getCatalog = async ({ signal } = {}) => {
        checkKey(apiKey);
        signal?.throwIfAborted();
        if (cached && now() < expires) return cached;
        if (!inflight) {
            // Shared GET owns its own bounded deadline. Cancelling one consumer
            // must not abort another consumer's catalog or poison its cache.
            inflight = (async () => {
                const deadline = createTtsDeadline(OLLALINK_TTS_CATALOG_TIMEOUT_MS);
                let response;
                try {
                    const pending = Promise.resolve(fetchImpl(VOICES_URL, {
                        method: "GET", redirect: "error", signal: deadline.signal,
                        headers: { "X-NH-GPU-Key": apiKey, Accept: "application/json" },
                    }));
                    pending.then(late => { if (deadline.signal.aborted) cancelTtsBody(late); }, () => { });
                    response = await awaitTtsAbortable(pending, deadline.signal);
                    const catalog = await readOllalinkTtsCatalog(response, { signal: deadline.signal, upstream: true });
                    deadline.signal.throwIfAborted();
                    cached = catalog;
                    expires = now() + 60000;
                    return catalog;
                } catch {
                    cancelTtsBody(response);
                    throw new OllalinkTtsError("TTS_CATALOG_UNAVAILABLE");
                } finally { deadline.dispose(); }
            })().finally(() => { inflight = undefined; });
        }
        return awaitTtsAbortable(inflight, signal);
    };
    getCatalog.invalidate = () => { cached = undefined; expires = 0; };
    return getCatalog;
}

export function createOllalinkTts({ apiKey = "", fetchImpl = globalThis.fetch, timeoutMs = 120000, now = Date.now } = {}) {
    const getCatalog = createOllalinkTtsCatalog({ apiKey, fetchImpl, now });
    const synthesize = async (request, { signal } = {}) => {
        const body = validateOllalinkTtsRequest(request);
        checkKey(apiKey);
        const timeout = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(120000, timeoutMs)) : 120000;
        const deadline = createTtsDeadline(timeout, signal);
        let response;
        try {
            deadline.signal.throwIfAborted();
            const catalog = await getCatalog({ signal: deadline.signal });
            if (!hasOllalinkTtsPair(catalog, body.voice, body.language)) throw new OllalinkTtsError("TTS_CATALOG_MISMATCH");
            deadline.signal.throwIfAborted();
            // Paid, non-idempotent work: exactly ONE POST. No automatic retries,
            // including 429, gateways, network faults, timeouts or Retry-After.
            const pending = Promise.resolve(fetchImpl(SPEECH_URL, {
                method: "POST", redirect: "error", signal: deadline.signal,
                headers: { "X-NH-GPU-Key": apiKey, "Content-Type": "application/json" },
                body: JSON.stringify(body),
            }));
            pending.then(late => { if (deadline.signal.aborted) cancelTtsBody(late); }, () => { });
            response = await awaitTtsAbortable(pending, deadline.signal);
            deadline.signal.throwIfAborted();
            if (!response.ok) {
                const status = response.status;
                // Never read/log upstream failure bodies, text, or credentials.
                if (status === 400) getCatalog.invalidate();
                throw new OllalinkTtsError(status === 400 ? "TTS_PROVIDER_REJECTED" :
                    [401, 403].includes(status) ? "TTS_AUTH_FAILED" : status === 429 ? "TTS_RATE_LIMITED" :
                        status === 504 ? "TTS_TIMEOUT" : "TTS_FAILED");
            }
            validateOllalinkTtsHeaders(response.headers, body.voice);
            const bytes = await readBoundedTtsAudio(response, { signal: deadline.signal });
            validateOllalinkTtsWav(bytes);
            deadline.signal.throwIfAborted();
            return { buffer: Buffer.from(bytes), voice: body.voice, language: body.language, mimeType: "audio/wav" };
        } catch (error) {
            cancelTtsBody(response);
            if (signal?.aborted) throw new OllalinkTtsError("TTS_CANCELLED");
            if (deadline.signal.aborted) throw new OllalinkTtsError("TTS_TIMEOUT");
            throw error instanceof OllalinkTtsError ? new OllalinkTtsError(error.code) : new OllalinkTtsError();
        } finally { deadline.dispose(); }
    };
    synthesize.getCatalog = getCatalog;
    return synthesize;
}
