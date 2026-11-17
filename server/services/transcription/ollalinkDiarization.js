import {
    DiarizationError, awaitDiarization, readDiarizationJson,
    validateDiarizationResult, validateDiarizationWav,
} from "../../../src/lib/ollalinkDiarization.js";

export const OLLALINK_DIARIZATION_ENDPOINT = "https://gpu-transcribe.ollalink.com/v1/audio/diarization";

export function createOllalinkDiarizer({ apiKey = "", fetchImpl = globalThis.fetch, timeoutMs = 110000 } = {}) {
    return async (bytes, { signal } = {}) => {
        const duration = validateDiarizationWav(bytes);
        if (typeof apiKey !== "string" || !/^sk_[A-Za-z0-9_-]+$/.test(apiKey)) throw new DiarizationError("NOT_CONFIGURED");
        const deadline = AbortSignal.timeout(Number.isFinite(timeoutMs) ? Math.max(1, Math.min(110000, timeoutMs)) : 110000);
        const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
        let response;
        try {
            combined.throwIfAborted();
            const form = new FormData();
            form.append("file", new Blob([bytes], { type: "audio/wav" }), "clip.wav");
            form.append("response_format", "json");
            // One paid POST; no retries, redirects or client-controlled upstream.
            const pending = Promise.resolve(fetchImpl(OLLALINK_DIARIZATION_ENDPOINT, {
                method: "POST", redirect: "error", signal: combined,
                headers: { "X-NH-GPU-Key": apiKey, Accept: "application/json" }, body: form,
            }));
            pending.then(late => { if (combined.aborted) late.body?.cancel().catch(() => { }); }, () => { });
            response = await awaitDiarization(pending, combined);
            if (!response.ok) throw new DiarizationError([401, 403].includes(response.status) ? "AUTH_FAILED" :
                [429, 503].includes(response.status) ? "BUSY" : response.status === 504 ? "TIMEOUT" :
                    response.status === 400 ? "INVALID_AUDIO" : "FAILED");
            return validateDiarizationResult(await readDiarizationJson(response, combined), duration);
        } catch (error) {
            // Never expose upstream body, errors, audio, key or headers.
            throw new DiarizationError(signal?.aborted ? "CANCELLED" : deadline.aborted ? "TIMEOUT" :
                error instanceof DiarizationError ? error.code : "FAILED");
        } finally { response?.body?.cancel().catch(() => { }); }
    };
}
