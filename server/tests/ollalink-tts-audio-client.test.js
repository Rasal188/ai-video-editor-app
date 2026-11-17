import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import {
    OLLALINK_TTS_MAX_AUDIO_BYTES,
    OLLALINK_TTS_CLIENT_TIMEOUT_MS, OllalinkTtsError, validateOllalinkTtsRequest,
    validateOllalinkTtsWav, readBoundedTtsAudio, requestOllalinkSpeech,
} from "../../src/lib/ollalinkTts.js";
import { speechRequest, pcmWav, wavResponse, stalledResponse } from "./ollalink-tts-fixtures.js";

const code = expected => error => error instanceof OllalinkTtsError && error.code === expected;

describe("Ollalink public TTS contract", () => {
    it("accepts bounded syntactic IDs/languages; server independently checks catalog membership", () => {
        for (const [voice, language] of [["delia", "en"], ["noa", "es"], ["not-in-catalog", "pt-BR"]]) {
            const request = { ...speechRequest, voice, language };
            assert.deepEqual(validateOllalinkTtsRequest(request), request);
        }
    });
    it("rejects blank/malformed text, aliases, missing/unknown fields and non-WAV formats", () => {
        const invalid = [null, [], {}, { ...speechRequest, input: "  " }, { ...speechRequest, input: 5 },
            { ...speechRequest, input: "\ud800" }, { ...speechRequest, input: "\udfff" }, { ...speechRequest, input: "a\0b" },
            { ...speechRequest, voice: "" }, { ...speechRequest, voice: "DELIA" }, { ...speechRequest, voice: "x".repeat(65) },
            { ...speechRequest, language: "../en" }, { ...speechRequest, language: "" }, { ...speechRequest, language: "EN" },
            { ...speechRequest, response_format: "mp3" }, { ...speechRequest, response_format: undefined }];
        for (const field of ["text", "instructions", "speed", "model", "ref_audio", "ref_text", "url", "apiKey"]) invalid.push({ ...speechRequest, [field]: "private" });
        for (const request of invalid) assert.throws(() => validateOllalinkTtsRequest(request), code("INVALID_TTS_REQUEST"));
    });
    it("uses the conservative 4000 UTF-16 limit without modifying input", () => {
        for (const input of ["x".repeat(4000), "😀".repeat(2000), "  हिन्दी  "]) assert.equal(validateOllalinkTtsRequest({ ...speechRequest, input }).input, input);
        for (const input of ["x".repeat(4001), "😀".repeat(2001)]) assert.throws(() => validateOllalinkTtsRequest({ ...speechRequest, input }), code("TTS_TEXT_TOO_LONG"));
    });
});

describe("Strict bounded PCM16 mono 24 kHz WAV policy", () => {
    it("accepts bytes, array buffers and offset views with consistent dimensions", () => {
        const bytes = pcmWav();
        const padded = new Uint8Array(bytes.length + 12); padded.set(bytes, 6);
        for (const input of [bytes, bytes.buffer, padded.subarray(6, 6 + bytes.length)]) {
            assert.deepEqual(validateOllalinkTtsWav(input), { durationSeconds: 0.01, sampleRate: 24000, channels: 1, bitsPerSample: 16, dataBytes: 480, mimeType: "audio/wav" });
        }
    });
    it("accepts bounded metadata chunks including RIFF odd-byte padding", () => {
        const original = pcmWav();
        const bytes = new Uint8Array(original.length + 10);
        bytes.set(original.subarray(0, 36));
        bytes.set(new TextEncoder().encode("JUNK"), 36);
        new DataView(bytes.buffer).setUint32(40, 1, true); bytes[44] = 4;
        bytes.set(original.subarray(36), 46);
        new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
        assert.equal(validateOllalinkTtsWav(bytes).durationSeconds, 0.01);
    });
    it("rejects malformed RIFF/chunks, empty data and unsupported codecs/dimensions", () => {
        const veastonnts = [new Uint8Array(), new TextEncoder().encode("not audio"), pcmWav(0), pcmWav().subarray(0, 43)];
        for (const [offset, value, width] of [[0, 0, 4], [8, 0, 4], [4, 999999, 4], [16, 15, 4], [16, 0xffffffff, 4],
        [20, 3, 2], [20, 0xfffe, 2], [22, 2, 2], [24, 44100, 4], [28, 1, 4], [32, 4, 2], [34, 32, 2], [40, 3, 4], [40, 999999, 4]]) {
            const bytes = pcmWav(); const view = new DataView(bytes.buffer);
            if (width === 2) view.setUint16(offset, value, true); else view.setUint32(offset, value, true);
            veastonnts.push(bytes);
        }
        // Missing fmt/data, duplicate data, trailing partial chunk, data before fmt.
        const missing = pcmWav(); missing.set(new TextEncoder().encode("JUNK"), 36); veastonnts.push(missing);
        const duplicate = new Uint8Array(pcmWav().length + 10); duplicate.set(pcmWav());
        duplicate.set(new TextEncoder().encode("data"), pcmWav().length); new DataView(duplicate.buffer).setUint32(pcmWav().length + 4, 2, true);
        new DataView(duplicate.buffer).setUint32(4, duplicate.length - 8, true); veastonnts.push(duplicate);
        const before = pcmWav(); before.set(new TextEncoder().encode("data"), 12); veastonnts.push(before);
        const trailing = new Uint8Array(pcmWav().length + 1); trailing.set(pcmWav()); new DataView(trailing.buffer).setUint32(4, trailing.length - 8, true); veastonnts.push(trailing);
        for (const bytes of veastonnts) assert.throws(() => validateOllalinkTtsWav(bytes), code("TTS_INVALID_AUDIO"));
    });
    it("enforces both 32 MiB and 10-minute policies", () => {
        assert.throws(() => validateOllalinkTtsWav(new Uint8Array(OLLALINK_TTS_MAX_AUDIO_BYTES + 1)), code("TTS_AUDIO_TOO_LARGE"));
        assert.equal(validateOllalinkTtsWav(pcmWav(24000 * 600)).durationSeconds, 600);
        assert.throws(() => validateOllalinkTtsWav(pcmWav(24000 * 600 + 1)), code("TTS_INVALID_AUDIO"));
    });
    it("bounds streaming reads regardless of content-length and cancels failures", async () => {
        for (const length of [String(OLLALINK_TTS_MAX_AUDIO_BYTES + 1), "broken", "-1"]) {
            let cancelled = false;
            const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "Content-Length": length } });
            await assert.rejects(readBoundedTtsAudio(response), code(length.startsWith("3") ? "TTS_AUDIO_TOO_LARGE" : "TTS_INVALID_AUDIO"));
            assert.ok(cancelled);
        }
        let cancelled = false;
        const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(9)); }, cancel() { cancelled = true; } });
        await assert.rejects(readBoundedTtsAudio(new Response(stream), { maxBytes: 8 }), code("TTS_AUDIO_TOO_LARGE"));
        assert.ok(cancelled);
        await assert.rejects(readBoundedTtsAudio(wavResponse(new Uint8Array())), code("TTS_INVALID_AUDIO"));
        await assert.rejects(readBoundedTtsAudio(wavResponse(pcmWav(), { "Content-Length": "1" })), code("TTS_INVALID_AUDIO"));
    });
});

describe("Browser speech client (mocked, no synthesis)", () => {
    it("posts only the public contract with auth/CSRF header and returns validated bytes", async () => {
        const result = await requestOllalinkSpeech(speechRequest, {
            fetchImpl: async (url, options) => {
                assert.equal(url, "/api/tts"); assert.equal(options.credentials, "include"); assert.equal(options.redirect, "error");
                assert.equal(options.headers["X-TTS-Request"], "1"); assert.equal(options.headers["X-NH-GPU-Key"], undefined);
                assert.deepEqual(JSON.parse(options.body), speechRequest); assert.ok(options.signal instanceof AbortSignal);
                return wavResponse();
            }
        });
        assert.deepEqual(result.bytes, pcmWav()); assert.equal(result.voice, "delia"); assert.equal(result.language, "en"); assert.equal(result.durationSeconds, 0.01);
    });
    it("never dispatches invalid or pre-cancelled requests", async () => {
        const fetchImpl = () => assert.fail("dispatch");
        await assert.rejects(requestOllalinkSpeech({ ...speechRequest, speed: 2 }, { fetchImpl }), code("INVALID_TTS_REQUEST"));
        await assert.rejects(requestOllalinkSpeech(speechRequest, { fetchImpl, signal: AbortSignal.abort("private") }), code("TTS_CANCELLED"));
    });
    it("uses safe status messages, ignores error bodies, and never retries", async () => {
        for (const [status, expected] of [[401, "TTS_SIGN_IN_REQUIRED"], [403, "TTS_FORBIDDEN"], [429, "TTS_RATE_LIMITED"], [504, "TTS_TIMEOUT"], [502, "TTS_FAILED"], [503, "TTS_FAILED"]]) {
            let calls = 0;
            await assert.rejects(requestOllalinkSpeech(speechRequest, { fetchImpl: async () => { calls++; return new Response("private sk_secret", { status }); } }), code(expected));
            assert.equal(calls, 1);
        }
        await assert.rejects(requestOllalinkSpeech(speechRequest, { fetchImpl: async () => { throw new Error("private sk_secret"); } }), error => error.code === "TTS_FAILED" && !error.message.includes("private"));
    });
    it("rejects unexpected voice/MIME/rate/encoding and malformed/oversized audio", async () => {
        for (const extra of [{ "X-TTS-Voice": "easton" }, { "Content-Type": "audio/mpeg" }, { "X-Audio-Sample-Rate": "48000" }, { "Content-Encoding": "gzip" }, { "Content-Length": String(OLLALINK_TTS_MAX_AUDIO_BYTES + 1) }]) {
            await assert.rejects(requestOllalinkSpeech(speechRequest, { fetchImpl: async () => wavResponse(pcmWav(), extra) }), OllalinkTtsError);
        }
        await assert.rejects(requestOllalinkSpeech(speechRequest, { fetchImpl: async () => wavResponse(new Uint8Array(44)) }), code("TTS_INVALID_AUDIO"));
    });
    it("cancels stalled headers and body even when the injected fetch ignores abort", async () => {
        for (const body of [false, true]) {
            const controller = new AbortController(); const stalled = stalledResponse();
            const promise = requestOllalinkSpeech(speechRequest, { signal: controller.signal, fetchImpl: async () => body ? stalled.response : new Promise(() => { }) });
            setTimeout(() => controller.abort("private"), 10);
            await assert.rejects(promise, code("TTS_CANCELLED"));
            if (body) assert.ok(stalled.wasCancelled());
        }
    });
    it("cancels a late fetch response after cancellation and ignores zero-byte stream chunks", async () => {
        const controller = new AbortController(); const stalled = stalledResponse(); let resolveFetch;
        const pending = requestOllalinkSpeech(speechRequest, { signal: controller.signal, fetchImpl: () => new Promise(resolve => { resolveFetch = resolve; }) });
        controller.abort(); await assert.rejects(pending, code("TTS_CANCELLED"));
        resolveFetch(stalled.response); await new Promise(resolve => setImmediate(resolve));
        assert.ok(stalled.wasCancelled());
        const bytes = pcmWav();
        const stream = new ReadableStream({
            start(output) {
                output.enqueue(new Uint8Array()); output.enqueue(bytes.subarray(0, 11));
                output.enqueue(new Uint8Array()); output.enqueue(bytes.subarray(11)); output.close();
            }
        });
        assert.deepEqual(await readBoundedTtsAudio(new Response(stream)), bytes);
    });
    it("enforces the complete 130-second browser deadline including a stalled body", async () => {
        mock.timers.enable({ apis: ["setTimeout"] });
        try {
            const stalled = stalledResponse();
            const pending = requestOllalinkSpeech(speechRequest, { fetchImpl: async () => stalled.response });
            await new Promise(resolve => setImmediate(resolve));
            mock.timers.tick(OLLALINK_TTS_CLIENT_TIMEOUT_MS);
            await assert.rejects(pending, code("TTS_TIMEOUT"));
            assert.ok(stalled.wasCancelled());
        } finally { mock.timers.reset(); }
    });
});
