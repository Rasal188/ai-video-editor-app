// Phase 4 policy is deliberately narrower than the provider's upload support.
export const DIARIZATION_MAX_SECONDS = 120;
export const DIARIZATION_MAX_SOURCE_BYTES = 32_000_000;
export const DIARIZATION_MAX_WAV_BYTES = 44 + 16000 * 2 * DIARIZATION_MAX_SECONDS;
export const DIARIZATION_MAX_JSON_BYTES = 512 * 1024;
const catalog = Object.freeze({
    INVALID_AUDIO: [400, "Use a supported normal-speed audio clip, at most 120 seconds."],
    INVALID_RESULT: [502, "The provider returned invalid speaker turns. Nothing was applied."],
    NOT_CONFIGURED: [503, "Cloud speaker detection is not configured."],
    AUTH_FAILED: [502, "Cloud authentication failed. Contact the server administrator."],
    FORBIDDEN: [403, "Speaker detection request was not permitted."],
    BUSY: [429, "Speaker detection is busy. Try later."],
    TIMEOUT: [504, "Speaker detection timed out. Nothing was applied."],
    CANCELLED: [499, "Speaker detection cancelled. Nothing was applied."],
    FAILED: [502, "Speaker detection failed. Existing captions are unchanged."],
    STALE: [409, "Source, captions or lock changed. Discard and run again."],
});
export class DiarizationError extends Error {
    constructor(code = "FAILED") {
        const safe = Object.hasOwn(catalog, code) ? code : "FAILED";
        super(catalog[safe][1]);
        this.code = safe;
        this.status = catalog[safe][0];
    }
}
export function validateDiarizationWav(bytes) {
    const fail = () => { throw new DiarizationError("INVALID_AUDIO"); };
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 46 || bytes.byteLength > DIARIZATION_MAX_WAV_BYTES) fail();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const text = (offset, count) => String.fromCharCode(...bytes.subarray(offset, offset + count));
    if (text(0, 4) !== "RIFF" || text(8, 4) !== "WAVE" || text(12, 4) !== "fmt " || text(36, 4) !== "data" ||
        view.getUint32(4, true) !== bytes.length - 8 || view.getUint32(16, true) !== 16 ||
        view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 || view.getUint32(24, true) !== 16000 ||
        view.getUint32(28, true) !== 32000 || view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16 ||
        view.getUint32(40, true) !== bytes.length - 44 || (bytes.length - 44) % 2) fail();
    return (bytes.length - 44) / 32000;
}
export function validateDiarizationResult(data, duration) {
    const fail = () => { throw new DiarizationError("INVALID_RESULT"); };
    const label = value => typeof value === "string" && value.length > 0 && value.length <= 80 &&
        value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value);
    if (!Number.isFinite(duration) || duration <= 0 || duration > DIARIZATION_MAX_SECONDS ||
        !data || data.model !== "nemotron-3-diarization" || !Number.isFinite(data.duration) || data.duration <= 0 ||
        Math.abs(data.duration - duration) > 0.1 || !Array.isArray(data.speakers) || !data.speakers.length ||
        data.speakers.length > 8 || !data.speakers.every(label) || new Set(data.speakers).size !== data.speakers.length ||
        !Array.isArray(data.segments) || !data.segments.length || data.segments.length > 5000) fail();
    const speakers = new Set(data.speakers);
    const segments = data.segments.map(turn => {
        if (!turn || !Number.isFinite(turn.start) || !Number.isFinite(turn.end) || turn.start < 0 ||
            turn.end <= turn.start || turn.end > duration || turn.end > data.duration || !speakers.has(turn.speaker)) fail();
        return { start: turn.start, end: turn.end, speaker: turn.speaker };
    });
    return { model: data.model, duration: data.duration, speakers: [...data.speakers], segments };
}
export function awaitDiarization(promise, signal) {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
}
export async function readDiarizationJson(response, signal) {
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") || "")) throw new DiarizationError("INVALID_RESULT");
    const length = response.headers.get("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > DIARIZATION_MAX_JSON_BYTES)) throw new DiarizationError("INVALID_RESULT");
    if (!response.body?.getReader) throw new DiarizationError("INVALID_RESULT");
    const reader = response.body.getReader();
    let size = 0;
    const chunks = [];
    try {
        while (true) {
            const { done, value } = await awaitDiarization(reader.read(), signal);
            if (done) break;
            size += value.byteLength;
            if (size > DIARIZATION_MAX_JSON_BYTES) throw new DiarizationError("INVALID_RESULT");
            chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (error) {
        throw signal.aborted ? signal.reason : new DiarizationError(error instanceof DiarizationError ? error.code : "INVALID_RESULT");
    } finally {
        Promise.resolve(reader.cancel()).catch(() => { });
    }
}
export function validateDiarizationSource(source) {
    if (!source || source.track !== "audio" || typeof source.segmentId !== "string" || !source.segmentId ||
        !(source.blob instanceof Blob) || !source.blob.size || source.blob.size > DIARIZATION_MAX_SOURCE_BYTES ||
        !Number.isFinite(source.start) || source.start < 0 || !Number.isFinite(source.sourceStart ?? 0) || (source.sourceStart ?? 0) < 0 ||
        !Number.isFinite(source.duration) || source.duration <= 0 || source.duration > DIARIZATION_MAX_SECONDS ||
        (source.playbackRate ?? 1) !== 1 || source.reversed || source.reversing || source.speedCurve || source.reverse) {
        throw new DiarizationError("INVALID_AUDIO");
    }
    return source;
}
export const diarizationCaptionKey = captions => JSON.stringify(captions);
export const diarizationSourceKey = source => source ? JSON.stringify(Object.fromEntries(
    Object.entries(source).filter(([key]) => !["blob", "peaks", "originalBlob", "originalPeaks"].includes(key))
)) : "null";
export function proposeDiarization(captions, source, result) {
    validateDiarizationSource(source);
    const validated = validateDiarizationResult(result, source.duration);
    const ids = new Set();
    for (const cue of captions) {
        if (typeof cue.id !== "string" || !cue.id || ids.has(cue.id)) throw new DiarizationError("STALE");
        ids.add(cue.id);
    }
    return captions.flatMap(cue => {
        // A timeline overlap alone does not establish that a cue belongs to this audio.
        if (cue.audioSegmentId !== source.segmentId || cue.speaker || cue.speakerId ||
            !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.end <= cue.start ||
            cue.start < source.start || cue.end > source.start + source.duration) return [];
        const start = cue.start - source.start, end = cue.end - source.start;
        const containing = validated.segments.filter(turn => turn.start <= start && turn.end >= end);
        if (!containing.length) return [];
        const speaker = containing[0].speaker;
        if (containing.some(turn => turn.speaker !== speaker) || validated.segments.some(turn =>
            turn.start < end && turn.end > start && turn.speaker !== speaker)) return [];
        return [{ id: cue.id, speaker }];
    });
}
export function applyDiarizationReview(current, snapshot, proposals, requestId) {
    if (diarizationCaptionKey(current) !== diarizationCaptionKey(snapshot) ||
        typeof requestId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(requestId)) throw new DiarizationError("STALE");
    const updates = new Map();
    for (const proposal of proposals) {
        const cue = current.find(item => item.id === proposal.id);
        if (!cue || cue.speaker || cue.speakerId || updates.has(proposal.id) || typeof proposal.speaker !== "string" ||
            !proposal.speaker || proposal.speaker.length > 80 || /[\p{Cc}\p{Cf}]/u.test(proposal.speaker)) throw new DiarizationError("STALE");
        // Namespace anonymous labels per inference; never merge people across recordings.
        updates.set(proposal.id, `ollalink:${requestId}:${proposal.speaker}`);
    }
    return current.map(cue => updates.has(cue.id) ? { ...cue, speaker: updates.get(cue.id) } : cue);
}
export async function requestDiarization(wav, { signal, fetchImpl = globalThis.fetch, timeoutMs = 115000 } = {}) {
    const duration = validateDiarizationWav(new Uint8Array(await wav.arrayBuffer()));
    const deadline = AbortSignal.timeout(Math.max(1, Math.min(115000, timeoutMs)));
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let response;
    try {
        combined.throwIfAborted();
        const pending = Promise.resolve(fetchImpl("/api/diarization", {
            method: "POST", credentials: "same-origin", redirect: "error", signal: combined,
            headers: { "Content-Type": "audio/wav", "X-Diarization-Request": "1" }, body: wav,
        }));
        pending.then(late => { if (combined.aborted) late.body?.cancel().catch(() => { }); }, () => { });
        response = await awaitDiarization(pending, combined);
        if (!response.ok) throw new DiarizationError(response.status === 429 ? "BUSY" : response.status === 504 ? "TIMEOUT" : "FAILED");
        return validateDiarizationResult(await readDiarizationJson(response, combined), duration);
    } catch (error) {
        throw new DiarizationError(signal?.aborted ? "CANCELLED" : deadline.aborted ? "TIMEOUT" : error instanceof DiarizationError ? error.code : "FAILED");
    } finally { response?.body?.cancel().catch(() => { }); }
}
