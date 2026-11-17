// The cloud integration deliberately accepts only this narrow, verifiable subset
// of Ollalink's documented common audio/video formats. Local ASR is unaffected.
export const CLOUD_SAMPLE_RATE = 16000;
export const CLOUD_FAST_LANGUAGES = Object.freeze(["en", "es", "fr", "de", "pt", "ru"]);
export const CLOUD_HQ_LANGUAGES = Object.freeze([...CLOUD_FAST_LANGUAGES, "hi", "zh", "ar"]);
export const CLOUD_FAST_MAX_BYTES = 100_000_000;
export const CLOUD_HQ_MAX_BYTES = 32_000_000;

export function cloudTranscriptionLane(language) {
    if (!CLOUD_HQ_LANGUAGES.includes(language)) {
        throw Object.assign(new Error("Unsupported Ollalink transcription language."), { code: "UNSUPPORTED_LANGUAGE" });
    }
    return CLOUD_FAST_LANGUAGES.includes(language) ? "fast" : "hq";
}

export function encodeCloudWav(audio) {
    if (!(audio instanceof Float32Array) || !audio.length || audio.byteLength / 2 + 44 > CLOUD_FAST_MAX_BYTES) {
        throw Object.assign(new Error("Audio is empty or exceeds the cloud upload limit."), { code: "INVALID_AUDIO" });
    }
    const buffer = new ArrayBuffer(44 + audio.length * 2);
    const view = new DataView(buffer);
    const tag = (offset, text) => Array.from(text).forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
    tag(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true); tag(8, "WAVE");
    tag(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, CLOUD_SAMPLE_RATE, true);
    view.setUint32(28, CLOUD_SAMPLE_RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    tag(36, "data"); view.setUint32(40, audio.length * 2, true);
    for (let index = 0; index < audio.length; index += 1) {
        if (!Number.isFinite(audio[index])) throw Object.assign(new Error("Invalid audio sample."), { code: "INVALID_AUDIO" });
        const sample = Math.max(-1, Math.min(1, audio[index]));
        view.setInt16(44 + index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
    }
    return new Blob([buffer], { type: "audio/wav" });
}

export function validateCloudWav(bytes, language) {
    const lane = cloudTranscriptionLane(language);
    const fail = (code = "INVALID_AUDIO") => { throw Object.assign(new Error("Invalid or oversized cloud transcription audio."), { code }); };
    const max = lane === "fast" ? CLOUD_FAST_MAX_BYTES : CLOUD_HQ_MAX_BYTES;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 46) fail();
    if (bytes.byteLength > max) fail("AUDIO_TOO_LARGE");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = (offset, text) => Array.from(text).every((char, index) => view.getUint8(offset + index) === char.charCodeAt(0));
    // Fixed canonical header produced by encodeCloudWav; no filenames, paths or URLs.
    if (!tag(0, "RIFF") || !tag(8, "WAVE") || !tag(12, "fmt ") || !tag(36, "data")
        || view.getUint32(4, true) !== bytes.byteLength - 8 || view.getUint32(16, true) !== 16
        || view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1
        || view.getUint32(24, true) !== CLOUD_SAMPLE_RATE || view.getUint32(28, true) !== CLOUD_SAMPLE_RATE * 2
        || view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16
        || view.getUint32(40, true) !== bytes.byteLength - 44 || (bytes.byteLength - 44) % 2) fail();
    const duration = (bytes.byteLength - 44) / (CLOUD_SAMPLE_RATE * 2);
    // Conservative editor limit for HQ; do not infer longer-job guarantees.
    if (lane === "hq" && duration > 600) fail("AUDIO_TOO_LONG");
    return { lane, duration };
}
