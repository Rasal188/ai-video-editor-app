import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createOllalinkTts } from "../services/ai/ollalinkTts.js";
import { OllalinkTtsError, OLLALINK_TTS_MAX_AUDIO_BYTES } from "../../src/lib/ollalinkTts.js";
import { speechRequest, pcmWav, wavResponse, stalledResponse, catalogResponse } from "./ollalink-tts-fixtures.js";

const code = expected => error => error instanceof OllalinkTtsError && error.code === expected;
const service = options => createOllalinkTts({ apiKey: "sk_test_not_real", ...options, fetchImpl: (url, init) => init.method === "GET" ? catalogResponse() : options.fetchImpl(url, init) });

describe("Ollalink paid TTS service (offline mocked provider)", () => {
    it("uses the fixed HTTPS endpoint, secret server header, explicit WAV body and rejects redirects", async () => {
        const result = await service({
            fetchImpl: async (url, options) => {
                assert.equal(url, "https://gpu-tts.ollalink.com/v1/audio/speech");
                assert.equal(options.method, "POST"); assert.equal(options.redirect, "error");
                assert.equal(options.headers["X-NH-GPU-Key"], "sk_test_not_real");
                assert.deepEqual(JSON.parse(options.body), speechRequest);
                assert.ok(options.signal instanceof AbortSignal);
                return wavResponse();
            }
        })(speechRequest);
        assert.ok(Buffer.isBuffer(result.buffer)); assert.deepEqual(new Uint8Array(result.buffer), pcmWav());
        assert.deepEqual({ ...result, buffer: null }, { buffer: null, voice: "delia", language: "en", mimeType: "audio/wav" });
    });
    it("rejects invalid requests/config before any provider dispatch", async () => {
        for (const apiKey of ["", "bad", "sk_bad\r\nsecret", null]) await assert.rejects(service({ apiKey, fetchImpl: () => assert.fail("dispatch") })(speechRequest), code("TTS_NOT_CONFIGURED"));
        for (const input of [{ ...speechRequest, input: "" }, { ...speechRequest, input: "x".repeat(4001) }, { ...speechRequest, speed: 1 }, { ...speechRequest, response_format: "pcm" }]) {
            await assert.rejects(service({ fetchImpl: () => assert.fail("dispatch") })(input), OllalinkTtsError);
        }
    });
    it("never retries any paid POST, including explicit 429/502/503 Retry-After", async () => {
        for (const status of [429, 502, 503, 504]) for (const retry of ["0", "2", new Date(Date.now() + 4000).toUTCString()]) {
            let posts = 0;
            await assert.rejects(service({ fetchImpl: async () => { posts++; return new Response("private", { status, headers: { "Retry-After": retry } }); } })(speechRequest), code(status === 429 ? "TTS_RATE_LIMITED" : status === 504 ? "TTS_TIMEOUT" : "TTS_FAILED"));
            assert.equal(posts, 1);
        }
    });
    it("does not retry missing/malformed/long Retry-After, auth, 504 or other statuses", async () => {
        for (const [status, retry] of [[429, null], [502, null], [503, null], [503, "6"], [503, "-1"], [503, "garbage"], [503, "1.5"], [503, ""], [503, "99999999999999999999"], [503, "Thu, 01 Jan 1970 00:00:00 GMT"], [401, "0"], [403, "0"], [504, "0"], [400, "0"], [500, "0"], [302, "0"]]) {
            let calls = 0;
            await assert.rejects(service({ fetchImpl: async () => { calls++; return new Response("private sk_secret", { status, headers: retry === null ? {} : { "Retry-After": retry } }); }, sleepImpl: () => assert.fail("sleep") })(speechRequest), error => {
                assert.ok(!error.message.includes("private"));
                return error.code === ([401, 403].includes(status) ? "TTS_AUTH_FAILED" : status === 429 ? "TTS_RATE_LIMITED" : status === 400 ? "TTS_PROVIDER_REJECTED" : status === 504 ? "TTS_TIMEOUT" : "TTS_FAILED");
            });
            assert.equal(calls, 1);
        }
    });
    it("never reads error bodies or retries ambiguous network failures", async () => {
        let cancelled = false;
        await assert.rejects(service({ fetchImpl: async () => ({ ok: false, status: 401, headers: new Headers(), body: { cancel() { cancelled = true; return new Promise(() => { }); } }, text() { assert.fail("body read"); } }) })(speechRequest), code("TTS_AUTH_FAILED"));
        assert.ok(cancelled);
        let calls = 0;
        await assert.rejects(service({ fetchImpl: async () => { calls++; throw new Error("private input sk_secret"); } })(speechRequest), error => error.code === "TTS_FAILED" && !error.message.includes("private") && !error.cause);
        assert.equal(calls, 1);
    });
    it("rejects voice substitution, invalid audio, unsupported formats/rates and oversized replies", async () => {
        for (const extra of [{ "X-TTS-Voice": "easton" }, { "Content-Type": "application/json" }, { "X-Audio-Sample-Rate": "48000" }, { "Content-Length": String(OLLALINK_TTS_MAX_AUDIO_BYTES + 1) }]) {
            await assert.rejects(service({ fetchImpl: async () => wavResponse(pcmWav(), extra) })(speechRequest), OllalinkTtsError);
        }
        await assert.rejects(service({ fetchImpl: async () => wavResponse(new Uint8Array()) })(speechRequest), code("TTS_INVALID_AUDIO"));
        const float = pcmWav(); new DataView(float.buffer).setUint16(20, 3, true);
        await assert.rejects(service({ fetchImpl: async () => wavResponse(float) })(speechRequest), code("TTS_INVALID_AUDIO"));
    });
    it("permits absent optional voice header but still validates actual WAV dimensions", async () => {
        const response = wavResponse(); response.headers.delete("X-TTS-Voice");
        assert.equal((await service({ fetchImpl: async () => response })(speechRequest)).voice, "delia");
    });
    it("times out stalled fetches, bodies and retries under one deadline without retrying", async () => {
        for (const stage of ["fetch", "body"]) {
            let calls = 0; const stalled = stalledResponse();
            const synthesize = service({ timeoutMs: 20, fetchImpl: async () => { calls++; return stage === "fetch" ? new Promise(() => { }) : stage === "body" ? stalled.response : new Response(null, { status: 503, headers: { "Retry-After": "0" } }); }, sleepImpl: () => new Promise(() => { }) });
            await assert.rejects(synthesize(speechRequest), code("TTS_TIMEOUT")); assert.equal(calls, 1);
            if (stage === "body") assert.ok(stalled.wasCancelled());
        }
    });
    it("caps the configurable deadline at 120 seconds", async () => {
        mock.timers.enable({ apis: ["setTimeout"] });
        try {
            const pending = service({ timeoutMs: 999999, fetchImpl: () => new Promise(() => { }) })(speechRequest);
            await new Promise(resolve => setImmediate(resolve));
            mock.timers.tick(120000);
            await assert.rejects(pending, code("TTS_TIMEOUT"));
        } finally { mock.timers.reset(); }
    });
    it("honors pre-abort, mid-fetch/body/retry cancellation and cancels late responses", async () => {
        await assert.rejects(service({ fetchImpl: () => assert.fail("dispatch") })(speechRequest, { signal: AbortSignal.abort() }), code("TTS_CANCELLED"));
        for (const stage of ["fetch", "body"]) {
            const controller = new AbortController(); const stalled = stalledResponse(); let calls = 0; let resolveFetch;
            const pending = service({ fetchImpl: async () => { calls++; return stage === "fetch" ? new Promise(resolve => { resolveFetch = resolve; }) : stage === "body" ? stalled.response : new Response(null, { status: 429, headers: { "Retry-After": "1" } }); }, sleepImpl: () => new Promise(() => { }) })(speechRequest, { signal: controller.signal });
            await new Promise(resolve => setTimeout(resolve, 10)); controller.abort("private");
            await assert.rejects(pending, code("TTS_CANCELLED")); assert.equal(calls, 1);
            if (stage === "fetch") { resolveFetch(stalled.response); await new Promise(resolve => setImmediate(resolve)); }
            if (stage !== "sleep") assert.ok(stalled.wasCancelled());
        }
    });
});
