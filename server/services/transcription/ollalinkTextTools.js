import { setTimeout as sleep } from "node:timers/promises";
import { isNumberOnlyNormalization, textCharacterCount, validateSubtitleTextRequest } from "../../../src/lib/subtitleTextTools.js";
import { preserveNormalization } from "../../../src/lib/normalizationSafety.js";

export const OLLALINK_TEXT_ENDPOINTS = Object.freeze({
    translate: "https://ai.ollalink.com/v1/translate",
    normalize: "https://ai.ollalink.com/v1/normalize",
});

export class SubtitleTextError extends Error {
    constructor(code = "TEXT_PROCESSING_FAILED", status = 502) {
        super("Ollalink subtitle processing is unavailable. Original captions are unchanged. Try again later.");
        this.name = "SubtitleTextError";
        this.code = code;
        this.status = status;
    }
}

async function readJson(response, signal) {
    if (!response.body || !response.headers.get("content-type")?.includes("application/json")) {
        await response.body?.cancel().catch(() => { });
        throw new SubtitleTextError("OLLALINK_INVALID_RESPONSE");
    }
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    const cancel = () => { void reader.cancel().catch(() => { }); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
        signal.throwIfAborted();
        for (; ;) {
            const { value, done } = await reader.read();
            signal.throwIfAborted();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > 256000) throw new SubtitleTextError("OLLALINK_INVALID_RESPONSE");
            chunks.push(Buffer.from(value));
        }
        try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { throw new SubtitleTextError("OLLALINK_INVALID_RESPONSE"); }
    } finally {
        signal.removeEventListener("abort", cancel);
        await reader.cancel().catch(() => { });
        reader.releaseLock();
    }
}

export function validateOllalinkTextResponse(data, request, cue) {
    const invalid = () => { throw new SubtitleTextError("OLLALINK_INVALID_RESPONSE"); };
    if (!data || typeof data !== "object" || !Number.isInteger(data.characters) || data.characters !== textCharacterCount(cue.text)) invalid();
    const text = request.operation === "translate" ? data.translation : data.normalized;
    if (typeof text !== "string" || !text.trim() || textCharacterCount(text) > 20000) invalid();
    if (request.operation === "translate") {
        if (data.source !== (request.source ?? null) || data.target !== request.target || typeof data.numbers_verified !== "boolean") invalid();
        return { id: cue.id, text, numbersVerified: data.numbers_verified };
    }
    if (data.text !== cue.text || data.language !== request.language || typeof data.changed !== "boolean" || data.changed !== (data.normalized !== data.text) || !isNumberOnlyNormalization(cue.text, text)) invalid();
    const safe = preserveNormalization(cue.text, text);
    return { id: cue.id, text: safe.text, changed: safe.text !== cue.text, ...(safe.reviewReasons.length ? { reviewReasons: safe.reviewReasons } : {}) };
}

export function createOllalinkTextTools({ apiKey = "", fetchImpl = globalThis.fetch, timeoutMs = 120000, sleepImpl = sleep } = {}) {
    // A conservative process-local dispatch ceiling below the documented 600/min.
    // Distributed deployments still require a shared quota for this GPU key.
    let windowStart = 0;
    let dispatches = 0;
    return async function processSubtitles(request, { signal } = {}) {
        try { validateSubtitleTextRequest(request); }
        catch (error) { throw new SubtitleTextError(error.code, error.code === "TEXT_LIMIT_EXCEEDED" ? 413 : 400); }
        if (!/^sk_[A-Za-z0-9_-]+$/.test(apiKey)) throw new SubtitleTextError("OLLALINK_NOT_CONFIGURED", 503);
        const deadline = AbortSignal.timeout(Number.isFinite(timeoutMs) ? Math.max(1, Math.min(120000, timeoutMs)) : 120000);
        const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
        const results = [];
        try {
            for (const cue of request.cues) {
                const body = request.operation === "translate"
                    ? { text: cue.text, target: request.target, ...(request.source ? { source: request.source } : {}) }
                    : { text: cue.text, language: request.language };
                for (let attempt = 0; attempt < 2; attempt += 1) {
                    combined.throwIfAborted();
                    if (Date.now() - windowStart >= 60000) { windowStart = Date.now(); dispatches = 0; }
                    if (dispatches >= 500) throw new SubtitleTextError("OLLALINK_RATE_LIMITED", 429);
                    dispatches += 1;
                    const response = await fetchImpl(OLLALINK_TEXT_ENDPOINTS[request.operation], {
                        method: "POST", headers: { "X-NH-GPU-Key": apiKey, "Content-Type": "application/json" },
                        body: JSON.stringify(body), signal: combined, redirect: "error",
                    });
                    combined.throwIfAborted();
                    if (response.ok) {
                        const data = await readJson(response, combined);
                        combined.throwIfAborted();
                        results.push(validateOllalinkTextResponse(data, request, cue));
                        break;
                    }
                    const status = response.status;
                    const retryAfter = response.headers.get("retry-after");
                    // Never consume or log failure bodies, which may contain text or secrets.
                    await response.body?.cancel().catch(() => { });
                    if (status === 401 || status === 403) throw new SubtitleTextError("OLLALINK_AUTH_FAILED", 503);
                    if (attempt || ![429, 502, 503, 504].includes(status)) throw new SubtitleTextError(status === 429 ? "OLLALINK_RATE_LIMITED" : "OLLALINK_PROVIDER_FAILED", status === 429 ? 429 : 502);
                    const seconds = Number(retryAfter);
                    const delay = retryAfter === null ? 500 : Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
                    if (!Number.isFinite(delay) || delay > 5000) throw new SubtitleTextError("OLLALINK_RETRY_LATER", 503);
                    await sleepImpl(Math.max(500, delay), undefined, { signal: combined });
                }
            }
            combined.throwIfAborted();
            return { operation: request.operation, results };
        } catch (error) {
            if (signal?.aborted) throw new SubtitleTextError("TEXT_PROCESSING_CANCELLED", 499);
            if (deadline.aborted) throw new SubtitleTextError("OLLALINK_TIMEOUT", 504);
            if (error instanceof SubtitleTextError) throw error;
            throw new SubtitleTextError();
        }
    };
}
