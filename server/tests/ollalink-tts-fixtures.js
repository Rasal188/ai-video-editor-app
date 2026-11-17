export const speechRequest = Object.freeze({ input: "Open port 443.", voice: "delia", language: "en", response_format: "wav" });

export function pcmWav(samples = 240) {
    const bytes = new Uint8Array(44 + samples * 2);
    const view = new DataView(bytes.buffer);
    const tag = (offset, text) => bytes.set(new TextEncoder().encode(text), offset);
    tag(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); tag(8, "WAVE");
    tag(12, "fmt "); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 24000, true); view.setUint32(28, 48000, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    tag(36, "data"); view.setUint32(40, samples * 2, true);
    return bytes;
}

export function wavResponse(bytes = pcmWav(), extraHeaders = {}) {
    return new Response(bytes, { headers: { "Content-Type": "audio/wav", "X-TTS-Voice": "delia", "X-Audio-Sample-Rate": "24000", ...extraHeaders } });
}

export function stalledResponse() {
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "Content-Type": "audio/wav" } });
    return { response, wasCancelled: () => cancelled };
}

export function synthesisResult(request = speechRequest) {
    return { buffer: pcmWav(), voice: request.voice, language: request.language, mimeType: "audio/wav" };
}

export const deployedCatalog = { voices: [
    { id: "delia", name: "Delia", languages: ["en"], engine: "fixed", instructions: false },
    { id: "easton", name: "Easton", languages: ["en"], engine: "fixed", instructions: false },
    { id: "noa", name: "Noa", languages: ["es"], engine: "fixed", instructions: false },
] };
export const catalogResponse = () => Response.json(deployedCatalog);
