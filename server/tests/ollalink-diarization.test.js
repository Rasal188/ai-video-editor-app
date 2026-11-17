import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { encodeCloudWav } from "../../src/lib/cloudTranscriptionAudio.js";
import { DiarizationError, validateDiarizationResult, validateDiarizationWav, requestDiarization, DIARIZATION_MAX_JSON_BYTES } from "../../src/lib/ollalinkDiarization.js";
import { createOllalinkDiarizer, OLLALINK_DIARIZATION_ENDPOINT } from "../services/transcription/ollalinkDiarization.js";
import { createDiarizationRouter } from "../routes/diarization.js";
import { cookieParserMiddleware } from "../middleware/auth.js";
import { setupTestEnvironment, withServer } from "./test-helpers.js";

// All provider responses in this suite are MOCKED; no paid network requests.
const wav = new Uint8Array(await encodeCloudWav(new Float32Array(16000)).arrayBuffer());
const fixture = () => ({ model: "nemotron-3-diarization", duration: 1, speakers: ["speaker_1"], segments: [{ start: 0, end: 1, speaker: "speaker_1" }], seconds: 0.1 });
const json = value => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const code = expected => error => error instanceof DiarizationError && error.code === expected;

test("mock contract: exact fixed endpoint, multipart only and sanitized response", async () => {
    let calls = 0;
    const diarize = createOllalinkDiarizer({
        apiKey: "sk_mock", fetchImpl: async (url, options) => {
            calls++;
            assert.equal(url, OLLALINK_DIARIZATION_ENDPOINT);
            assert.equal(options.redirect, "error");
            assert.equal(options.headers["X-NH-GPU-Key"], "sk_mock");
            assert.deepEqual([...options.body.keys()], ["file", "response_format"]);
            assert.equal(options.body.get("response_format"), "json");
            assert.deepEqual(new Uint8Array(await options.body.get("file").arrayBuffer()), wav);
            return json({ ...fixture(), secret: "do not return" });
        }
    });
    const result = await diarize(wav);
    assert.equal(calls, 1);
    assert.equal(result.secret, undefined);
    assert.equal(result.segments[0].speaker, "speaker_1");
});
for (const [name, mutate] of [
    ["negative", x => x.segments[0].start = -1], ["reverse", x => x.segments[0].end = 0],
    ["beyond duration", x => x.segments[0].end = 1.01], ["nonfinite", x => x.segments[0].start = NaN],
    ["string timestamp", x => x.segments[0].start = "0"], ["unknown speaker", x => x.segments[0].speaker = "other"],
    ["control label", x => x.speakers = ["bad\nlabel"]], ["duplicate speakers", x => x.speakers.push("speaker_1")],
    ["too many speakers", x => x.speakers = Array.from({ length: 9 }, (_, i) => `s${i}`)],
    ["duration mismatch", x => x.duration = 2], ["wrong model", x => x.model = "transcription"],
    ["empty turns", x => x.segments = []], ["too many turns", x => x.segments = Array(5001).fill(x.segments[0])],
]) test(`mock malformed output: ${name}`, () => {
    const data = fixture(); mutate(data);
    assert.throws(() => validateDiarizationResult(data, 1), code("INVALID_RESULT"));
});
test("canonical WAV validation rejects unsupported or malformed audio before dispatch", async () => {
    let calls = 0;
    const diarize = createOllalinkDiarizer({ apiKey: "sk_mock", fetchImpl: () => { calls++; } });
    for (const bytes of [new Uint8Array(), new Uint8Array([1, 2]), wav.subarray(0, 50), Uint8Array.from(wav, (v, i) => i === 22 ? 2 : v)]) {
        await assert.rejects(diarize(bytes), code("INVALID_AUDIO"));
    }
    assert.equal(calls, 0);
    assert.equal(validateDiarizationWav(wav), 1);
});
for (const [status, expected] of [[400, "INVALID_AUDIO"], [401, "AUTH_FAILED"], [403, "AUTH_FAILED"], [429, "BUSY"], [503, "BUSY"], [504, "TIMEOUT"], [500, "FAILED"]]) {
    test(`mock upstream ${status}: sanitized and never retried`, async () => {
        let calls = 0;
        const diarize = createOllalinkDiarizer({ apiKey: "sk_mock", fetchImpl: async () => { calls++; return new Response("secret upstream", { status }); } });
        await assert.rejects(diarize(wav), error => code(expected)(error) && !error.message.includes("secret"));
        assert.equal(calls, 1);
    });
}
test("missing credential never dispatches", async () => {
    await assert.rejects(createOllalinkDiarizer({ apiKey: "" })(wav), code("NOT_CONFIGURED"));
});
test("mock malformed JSON, MIME, overflow and network errors", async () => {
    for (const response of [new Response("{", { headers: { "Content-Type": "application/json" } }), new Response("{}"),
    new Response("{}", { headers: { "Content-Type": "application/json", "Content-Length": String(DIARIZATION_MAX_JSON_BYTES + 1) } }),
    new Response(" ".repeat(DIARIZATION_MAX_JSON_BYTES + 1), { headers: { "Content-Type": "application/json" } })]) {
        await assert.rejects(createOllalinkDiarizer({ apiKey: "sk_mock", fetchImpl: async () => response })(wav), code("INVALID_RESULT"));
    }
    await assert.rejects(createOllalinkDiarizer({ apiKey: "sk_mock", fetchImpl: async () => { throw new Error("secret"); } })(wav), code("FAILED"));
});
test("mock timeouts bound fetch/body even when transport ignores abort; cancellation never retries", async () => {
    // Keep event loop alive because AbortSignal.timeout deliberately uses unref timers.
    const keepalive = setInterval(() => { }, 100);
    try {
        await assert.rejects(createOllalinkDiarizer({ apiKey: "sk_mock", timeoutMs: 15, fetchImpl: () => new Promise(() => { }) })(wav), code("TIMEOUT"));
        await assert.rejects(createOllalinkDiarizer({ apiKey: "sk_mock", timeoutMs: 15, fetchImpl: async () => new Response(new ReadableStream({ start() { } }), { headers: { "Content-Type": "application/json" } }) })(wav), code("TIMEOUT"));
        const controller = new AbortController();
        const pending = createOllalinkDiarizer({ apiKey: "sk_mock", fetchImpl: () => new Promise(() => { }) })(wav, { signal: controller.signal });
        controller.abort();
        await assert.rejects(pending, code("CANCELLED"));
        await assert.rejects(requestDiarization(new Blob([wav]), { timeoutMs: 15, fetchImpl: () => new Promise(() => { }) }), code("TIMEOUT"));
    } finally { clearInterval(keepalive); }
});
test("mock authenticated backend: auth/header/origin/parser/concurrency/validation", async () => {
    const env = await setupTestEnvironment();
    try {
        const session = await env.createSession("diarization-test@example.com");
        let calls = 0;
        const makeApp = (diarize = async () => { calls++; return fixture(); }) => {
            const app = express(); app.use(cookieParserMiddleware); app.use("/api/diarization", createDiarizationRouter({ diarize })); return app;
        };
        const headers = { Cookie: session.cookie, "Content-Type": "audio/wav", "X-Diarization-Request": "1" };
        await withServer(makeApp(), async base => {
            assert.equal((await fetch(`${base}/api/diarization`, { method: "POST", body: wav })).status, 401);
            assert.equal((await fetch(`${base}/api/diarization`, { method: "POST", headers: { Cookie: session.cookie }, body: wav })).status, 403);
            assert.equal((await fetch(`${base}/api/diarization`, { method: "POST", headers: { ...headers, Origin: "https://evil.invalid" }, body: wav })).status, 403);
            const response = await fetch(`${base}/api/diarization`, { method: "POST", headers, body: wav });
            assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
            assert.equal((await response.json()).segments.length, 1);
        });
        assert.equal(calls, 1);
        for (const [suffix, extra, body, expected] of [["?url=https://evil.invalid", {}, wav, 400], ["", { "Content-Type": "application/json" }, "secret", 400], ["", {}, new Uint8Array([1]), 400], ["", {}, new Uint8Array(4_000_000), 413]]) {
            await withServer(makeApp(), async base => assert.equal((await fetch(`${base}/api/diarization${suffix}`, { method: "POST", headers: { ...headers, ...extra }, body })).status, expected));
        }
        await withServer(makeApp(async () => ({ ...fixture(), segments: [{ start: -1, end: 1, speaker: "speaker_1" }] })), async base => {
            assert.equal((await fetch(`${base}/api/diarization`, { method: "POST", headers, body: wav })).status, 502);
        });
        let release, entered;
        const started = new Promise(resolve => { entered = resolve; });
        await withServer(makeApp(async (_bytes, { signal }) => { entered(signal); await new Promise(resolve => { release = resolve; }); return fixture(); }), async base => {
            const controller = new AbortController();
            const pending = fetch(`${base}/api/diarization`, { method: "POST", headers, body: wav, signal: controller.signal }).catch(() => null);
            const signal = await started;
            controller.abort(); await pending;
            await new Promise(resolve => setTimeout(resolve, 30));
            assert.equal(signal.aborted, true);
            // Disconnect must not free the slot while upstream is still settling.
            assert.equal((await fetch(`${base}/api/diarization`, { method: "POST", headers, body: wav })).status, 429);
            release();
        });
    } finally { await env.teardown(); }
});
