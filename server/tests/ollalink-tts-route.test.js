import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { setupTestEnvironment, withServer } from "./test-helpers.js";
import { cookieParserMiddleware } from "../middleware/auth.js";
import { createTtsRouter } from "../routes/tts.js";
import { OllalinkTtsError, OLLALINK_TTS_MAX_AUDIO_BYTES } from "../../src/lib/ollalinkTts.js";
import { speechRequest, pcmWav, synthesisResult } from "./ollalink-tts-fixtures.js";

const headers = { "Content-Type": "application/json", "X-TTS-Request": "1" };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

describe("Authenticated TTS route (mocked synthesis only)", () => {
    let env; let cookie;
    before(async () => {
        env = await setupTestEnvironment();
        ({ cookie } = await env.createSession("tts-phase3@example.com"));
    });
    after(async () => { await env?.teardown(); });
    const appFor = (synthesize, getCatalog) => {
        const app = express(); app.use(cookieParserMiddleware);
        app.use("/api/tts", createTtsRouter({ synthesize, getCatalog }));
        return app;
    };
    const post = (url, options = {}) => fetch(`${url}/api/tts${options.query || ""}`, {
        method: "POST", headers: { ...headers, cookie, Origin: url, ...options.headers },
        body: options.raw ?? JSON.stringify(options.body ?? speechRequest), signal: options.signal,
    });
    it("mounts before the real global parser and authenticates before parsing", async () => {
        await withServer(env.app, async url => {
            for (const raw of ["{private malformed JSON", "private".repeat(10000)]) {
                const response = await post(url, { headers: { cookie: "" }, raw });
                assert.equal(response.status, 401); assert.equal(response.headers.get("cache-control"), "no-store");
                assert.equal((await response.json()).code, "UNAUTHORIZED");
            }
            const invalid = await post(url, { raw: "{private malformed JSON" });
            assert.equal(invalid.status, 400); assert.ok(!(await invalid.text()).includes("private"));
        });
    });
    it("requires a valid session and never dispatches unauthenticated work", async () => {
        await withServer(appFor(() => assert.fail("dispatch")), async url => {
            const response = await post(url, { headers: { cookie: "" } }); assert.equal(response.status, 401); await response.arrayBuffer();
        });
    });
    it("returns binary no-store WAV, resolved voice and a disconnect cancellation signal", async () => {
        let calls = 0;
        await withServer(appFor(async (input, { signal }) => {
            calls++; assert.deepEqual(input, speechRequest); assert.ok(signal instanceof AbortSignal);
            return synthesisResult(input);
        }), async url => {
            const response = await post(url); assert.equal(response.status, 200);
            assert.equal(response.headers.get("cache-control"), "no-store");
            assert.equal(response.headers.get("content-type"), "audio/wav");
            assert.equal(response.headers.get("x-tts-voice"), "delia");
            assert.equal(response.headers.get("x-audio-sample-rate"), "24000");
            assert.equal(response.headers.get("x-content-type-options"), "nosniff");
            assert.deepEqual(new Uint8Array(await response.arrayBuffer()), pcmWav());
        });
        assert.equal(calls, 1);
    });
    it("rejects hostile origins, fetch metadata, missing request header, queries and non-JSON", async () => {
        for (const options of [
            { headers: { Origin: "https://evil.example" }, status: 403 },
            { headers: { Origin: "null" }, status: 403 },
            { headers: { Origin: "not-a-url" }, status: 403 },
            { headers: { "Sec-Fetch-Site": "cross-site" }, status: 403 },
            { headers: { "X-TTS-Request": "" }, status: 403 },
            { headers: { "Content-Type": "text/plain" }, status: 400 },
            { query: "?url=https://evil.example", status: 400 },
        ]) await withServer(appFor(() => assert.fail("dispatch")), async url => {
            const response = await post(url, options); assert.equal(response.status, options.status); await response.arrayBuffer();
        });
    });
    it("rejects malformed/compressed/32KiB JSON and sanitizes parser errors", async () => {
        for (const options of [
            { raw: '{"private":}', status: 400 },
            { raw: JSON.stringify({ input: "private".repeat(6000) }), status: 413 },
            { raw: "private", headers: { "Content-Encoding": "gzip" }, status: 400 },
            { raw: "[]", status: 400 },
        ]) await withServer(appFor(() => assert.fail("dispatch")), async url => {
            const response = await post(url, options); assert.equal(response.status, options.status);
            assert.equal(response.headers.get("cache-control"), "no-store"); assert.ok(!(await response.text()).includes("private"));
        });
    });
    it("validates all contract fields before dispatch including the 4000 character limit", async () => {
        for (const body of [{ ...speechRequest, input: "" }, { ...speechRequest, input: "x".repeat(4001) },
        { ...speechRequest, voice: "../default" }, { ...speechRequest, language: "../en" }, { ...speechRequest, response_format: "mp3" },
        { ...speechRequest, instructions: "private" }, { ...speechRequest, speed: 1 }, { ...speechRequest, ref_audio: "private" }]) {
            await withServer(appFor(() => assert.fail("dispatch")), async url => {
                const response = await post(url, { body }); assert.equal(response.status, body.input.length > 4000 ? 413 : 400); await response.arrayBuffer();
            });
        }
    });
    it("validates injected synth audio/metadata and sanitizes exceptions and mutable error messages", async () => {
        const mutated = new OllalinkTtsError("TTS_TIMEOUT"); mutated.message = "private sk_secret"; mutated.status = 200;
        for (const [synthesize, status] of [
            [async () => { throw new Error("private sk_secret"); }, 502],
            [async () => { throw mutated; }, 504],
            [async () => ({ ...synthesisResult(), voice: "easton" }), 502],
            [async () => ({ ...synthesisResult(), language: "hi" }), 502],
            [async () => ({ ...synthesisResult(), mimeType: "audio/mpeg" }), 502],
            [async () => ({ ...synthesisResult(), buffer: new Uint8Array(44) }), 502],
            [async () => ({ ...synthesisResult(), buffer: new Uint8Array(OLLALINK_TTS_MAX_AUDIO_BYTES + 1) }), 502],
        ]) await withServer(appFor(synthesize), async url => {
            const response = await post(url); assert.equal(response.status, status); assert.ok(!(await response.text()).includes("private"));
        });
    });
    it("protects GET catalog with session, origin, request header, query rejection and no-store subset", async () => {
        const catalog = { voices: [{ id: "delia", name: "Delia", languages: ["en"], secret: "private", engine: "fixed", instructions: false }], defaults: { en: "delia" } };
        for (const [extra, query, status] of [[{}, "", 200], [{ cookie: "" }, "", 401], [{ Origin: "https://evil.example" }, "", 403], [{ "X-TTS-Request": "" }, "", 403], [{ "Sec-Fetch-Site": "cross-site" }, "", 403], [{}, "?url=https://evil.example", 400]]) {
            let calls = 0;
            await withServer(appFor(() => assert.fail("POST"), async () => { calls++; return catalog; }), async url => {
                const response = await fetch(`${url}/api/tts/voices${query}`, { headers: { cookie, Origin: url, "X-TTS-Request": "1", ...extra } });
                assert.equal(response.status, status);
                assert.equal(response.headers.get("cache-control"), "no-store");
                assert.equal(response.headers.get("x-content-type-options"), "nosniff");
                const body = await response.text(); assert.ok(!body.includes("private"));
                if (status === 200) assert.deepEqual(JSON.parse(body), { voices: [{ id: "delia", name: "Delia", languages: ["en"] }] });
            });
            assert.equal(calls, status === 200 ? 1 : 0);
        }
    });
    it("limits jobs to six per minute", async () => {
        let calls = 0;
        await withServer(appFor(async input => { calls++; return synthesisResult(input); }), async url => {
            for (let i = 0; i < 7; i++) {
                const response = await post(url); assert.equal(response.status, i === 6 ? 429 : 200); await response.arrayBuffer();
            }
        }); assert.equal(calls, 6);
    });
    it("holds both concurrency slots after disconnect until upstream settles, then releases them", async () => {
        const signals = []; const releases = [];
        await withServer(appFor(async (input, { signal }) => {
            signals.push(signal); await new Promise(resolve => releases.push(resolve)); return synthesisResult(input);
        }), async url => {
            const a = new AbortController(); const b = new AbortController();
            const first = post(url, { signal: a.signal }).catch(error => error.name);
            const second = post(url, { signal: b.signal }).catch(error => error.name);
            try {
                for (let i = 0; i < 100 && signals.length < 2; i++) await wait(5);
                assert.equal(signals.length, 2);
                const busy = await post(url); assert.equal(busy.status, 503); await busy.arrayBuffer();
                a.abort(); b.abort(); await Promise.all([first, second]);
                for (let i = 0; i < 100 && !signals.every(signal => signal.aborted); i++) await wait(5);
                assert.ok(signals.every(signal => signal.aborted));
                const stillBusy = await post(url); assert.equal(stillBusy.status, 503); await stillBusy.arrayBuffer();
                releases.forEach(resolve => resolve()); await wait(20);
                const third = post(url);
                for (let i = 0; i < 100 && releases.length < 3; i++) await wait(5);
                assert.equal(signals.length, 3); releases[2]();
                const success = await third; assert.equal(success.status, 200); await success.arrayBuffer();
            } finally { a.abort(); b.abort(); releases.forEach(resolve => resolve()); }
        });
    });
    it("releases slots after parsing and provider failures", async () => {
        let calls = 0;
        await withServer(appFor(async input => { calls++; if (calls <= 2) throw new Error("private"); return synthesisResult(input); }), async url => {
            for (let i = 0; i < 2; i++) { const response = await post(url, { raw: "{" }); assert.equal(response.status, 400); await response.arrayBuffer(); }
            for (let i = 0; i < 3; i++) { const response = await post(url); assert.equal(response.status, i < 2 ? 502 : 200); await response.arrayBuffer(); }
        });
    });
});
