import { encodeCloudWav } from "./cloudTranscriptionAudio.js";
import { DiarizationError, awaitDiarization, validateDiarizationSource } from "./ollalinkDiarization.js";

export async function prepareDiarizationAudio(source, { signal, AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext } = {}) {
    validateDiarizationSource(source);
    signal?.throwIfAborted();
    if (!AudioContextClass) throw new DiarizationError("INVALID_AUDIO");
    const context = new AudioContextClass({ sampleRate: 16000 });
    try {
        const bytes = await source.blob.arrayBuffer();
        signal?.throwIfAborted();
        // Native decoding is not interruptible. This function retains ownership
        // until it settles and never uploads after cancellation.
        const decoded = await context.decodeAudioData(bytes);
        signal?.throwIfAborted();
        if (decoded.sampleRate !== 16000 || !decoded.numberOfChannels || decoded.numberOfChannels > 8 || decoded.duration > 600) throw new DiarizationError("INVALID_AUDIO");
        const start = Math.round((source.sourceStart ?? 0) * 16000);
        const frames = Math.round(source.duration * 16000);
        if (frames < 1 || start + frames > decoded.length) throw new DiarizationError("INVALID_AUDIO");
        const mono = new Float32Array(frames);
        for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
            const samples = decoded.getChannelData(channel);
            for (let index = 0; index < frames; index++) mono[index] += samples[start + index] / decoded.numberOfChannels;
        }
        signal?.throwIfAborted();
        return encodeCloudWav(mono);
    } catch (error) {
        if (signal?.aborted) throw new DiarizationError("CANCELLED");
        throw error instanceof DiarizationError ? error : new DiarizationError("INVALID_AUDIO");
    } finally { await context.close().catch(() => { }); }
}

// Own the whole preparation/request operation, including after non-abortable
// native decode. A second invocation cannot dispatch concurrently.
export function createDiarizationOperation() {
    let active = null;
    return {
        begin() {
            if (active) return null;
            const controller = new AbortController();
            const token = {
                controller,
                current: () => active === token && !controller.signal.aborted,
                release: () => { if (active === token) active = null; },
            };
            active = token;
            return token;
        },
        cancel() { active?.controller.abort(); },
    };
}

export async function runDiarizationOperation(token, source, { prepare = prepareDiarizationAudio, request, timeoutMs = 115000 } = {}) {
    const deadline = AbortSignal.timeout(Math.max(1, Math.min(115000, timeoutMs)));
    const signal = AbortSignal.any([token.controller.signal, deadline]);
    let preparation;
    let preparationSettled = false;
    try {
        signal.throwIfAborted();
        preparation = Promise.resolve(prepare(source, { signal }));
        preparation.then(() => { preparationSettled = true; }, () => { preparationSettled = true; });
        const wav = await awaitDiarization(preparation, signal);
        signal.throwIfAborted();
        return await awaitDiarization(request(wav, { signal }), signal);
    } catch (error) {
        throw new DiarizationError(token.controller.signal.aborted ? "CANCELLED" : deadline.aborted ? "TIMEOUT" : error instanceof DiarizationError ? error.code : "FAILED");
    } finally {
        if (preparation && !preparationSettled) preparation.then(token.release, token.release);
        else token.release();
    }
}
