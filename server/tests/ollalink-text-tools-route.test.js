import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { setupTestEnvironment, withServer } from "./test-helpers.js";
import { cookieParserMiddleware } from "../middleware/auth.js";
import { createSubtitleToolsRouter, SUBTITLE_TOOL_MAX_ACTIVE_JOBS, SUBTITLE_TOOL_REQUESTS_PER_MINUTE } from "../routes/subtitleTools.js";
import { SubtitleTextError } from "../services/transcription/ollalinkTextTools.js";

const headers = { "Content-Type": "application/json", "X-Subtitle-Tools-Request": "1" };
const body = { operation: "translate", source: "en", target: "es", cues: [{ id: "first", text: "Open port 443." }] };
const success = input => ({ operation: input.operation, results: input.cues.map(cue => ({ id: cue.id, text: "Puerto 443.", numbersVerified: true })) });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

describe("Authenticated subtitle text routes (mocked provider)", () => {
    let env; let cookie;
    before(async () => {
        env = await setupTestEnvironment();
        ({ cookie } = await env.createSession("subtitle-tools@example.com"));
    });
    after(async () => { await env?.teardown(); });
    const appFor = processSubtitles => {
        const app = express();
        app.use(cookieParserMiddleware);
        app.use("/api/subtitle-tools", createSubtitleToolsRouter({ processSubtitles }));
        return app;
    };
    const post = (url, options = {}) => fetch(`${url}/api/subtitle-tools${options.query || ""}`, {
        method: "POST", headers: { ...headers, cookie, Origin: url, ...options.headers },
        body: options.raw ?? JSON.stringify(options.body ?? body), signal: options.signal,
    });
    it("mounts in the real application before the broad parser and requires authentication", async () => {
        await withServer(env.app, async url => {
            const r = await post(url, { headers: { cookie: "" }, raw: "{private invalid JSON" });
            assert.equal(r.status, 401);
            assert.equal((await r.json()).code, "UNAUTHORIZED");
        });
    });
    it("uses session auth, no-store, validated text only and a cancellation signal", async () => {
        let calls = 0;
        await withServer(appFor(async (input, { signal }) => {
            calls++;
            assert.deepEqual(input, body);
            assert.ok(signal instanceof AbortSignal);
            return success(input);
        }), async url => {
            const r = await post(url);
            assert.equal(r.status, 200);
            assert.equal(r.headers.get("cache-control"), "no-store");
            assert.deepEqual(await r.json(), { ok: true, ...success(body) });
        });
        assert.equal(calls, 1);
    });
    it("rejects origin, CSRF, content-type and query violations before processing", async () => {
        for (const options of [
            { headers: { Origin: "https://evil.example" }, status: 403 },
            { headers: { "Sec-Fetch-Site": "cross-site" }, status: 403 },
            { headers: { "X-Subtitle-Tools-Request": "" }, status: 403 },
            { headers: { "Content-Type": "text/plain" }, status: 400 },
            { query: "?url=https://evil.example", status: 400 },
        ]) await withServer(appFor(async () => assert.fail("must not dispatch")), async url => {
            const r = await post(url, options); assert.equal(r.status, options.status); await r.arrayBuffer();
        });
    });
    it("rejects unknown fields, timing fields and unsupported languages", async () => {
        for (const input of [{ ...body, target: "ja" }, { ...body, source: "xx" }, { ...body, prompt: "private" }, { ...body, cues: [{ ...body.cues[0], start: 1 }] }, { operation: "normalize", language: "fr", cues: body.cues }]) await withServer(appFor(async () => assert.fail("must not dispatch")), async url => {
            const r = await post(url, { body: input }); assert.equal(r.status, 400); await r.arrayBuffer();
        });
    });
    it("sanitizes malformed JSON, oversized/compressed input and provider exceptions", async () => {
        for (const options of [
            { raw: '{"private sensitive text":}', status: 400 },
            { raw: JSON.stringify({ text: "x".repeat(100001) }), status: 413 },
            { headers: { "Content-Encoding": "gzip" }, raw: "private sensitive text", status: 400 },
        ]) await withServer(appFor(async () => assert.fail("must not dispatch")), async url => {
            const r = await post(url, options); assert.equal(r.status, options.status);
            assert.equal((await r.text()).includes("sensitive"), false);
        });
        for (const error of [new Error("private sensitive text"), new SubtitleTextError("OLLALINK_TIMEOUT", 504)]) await withServer(appFor(async () => { throw error; }), async url => {
            const r = await post(url); assert.equal(r.status, error.status || 502);
            assert.equal((await r.text()).includes("sensitive"), false);
        });
    });
    it("exposes the raised limits as documented, still-abuse-limiting constants", () => {
        // The gate must admit the whole bounded adaptive client fan-out: at most
        // TEXT_TOOL_MAX_CONCURRENCY batches for each of two concurrent jobs.
        assert.equal(SUBTITLE_TOOL_MAX_ACTIVE_JOBS, 8);
        // Raised from six per minute, but still an order of magnitude below the
        // conservative 500/minute process dispatch ceiling and the documented
        // 600/minute provider key quota.
        assert.equal(SUBTITLE_TOOL_REQUESTS_PER_MINUTE, 60);
        assert.ok(SUBTITLE_TOOL_REQUESTS_PER_MINUTE < 500);
        assert.ok(SUBTITLE_TOOL_REQUESTS_PER_MINUTE < 600);
    });
    it("caps concurrent work at the job gate, aborts disconnected requests, and retains slots until work settles", async () => {
        const signals = []; const releases = [];
        await withServer(appFor(async (input, { signal }) => {
            signals.push(signal);
            await new Promise(resolve => releases.push(resolve));
            return success(input);
        }), async url => {
            const controllers = Array.from({ length: SUBTITLE_TOOL_MAX_ACTIVE_JOBS }, () => new AbortController());
            const pending = controllers.map(controller => post(url, { signal: controller.signal }).catch(error => error.name));
            for (let i = 0; i < 400 && signals.length < SUBTITLE_TOOL_MAX_ACTIVE_JOBS; i++) await wait(5);
            assert.equal(signals.length, SUBTITLE_TOOL_MAX_ACTIVE_JOBS, "every permitted slot is admitted");
            const busy = await post(url); assert.equal(busy.status, 503); await busy.arrayBuffer();
            controllers.forEach(controller => controller.abort());
            await Promise.all(pending);
            for (let i = 0; i < 200 && !signals.every(signal => signal.aborted); i++) await wait(5);
            assert.ok(signals.every(signal => signal.aborted));
            const stillBusy = await post(url); assert.equal(stillBusy.status, 503); await stillBusy.arrayBuffer();
            releases.forEach(release => release());
            await wait(20);
        });
    });
    it("limits authenticated jobs per IP", async () => {
        await withServer(appFor(async input => success(input)), async url => {
            for (let i = 0; i < SUBTITLE_TOOL_REQUESTS_PER_MINUTE + 1; i++) {
                const r = await post(url);
                assert.equal(r.status, i === SUBTITLE_TOOL_REQUESTS_PER_MINUTE ? 429 : 200, `request ${i + 1}`);
                await r.arrayBuffer();
            }
        });
    });
});
