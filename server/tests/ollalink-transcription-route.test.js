import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { setupTestEnvironment, withServer } from "./test-helpers.js";
import { cookieParserMiddleware } from "../middleware/auth.js";
import { createTranscriptionRouter } from "../routes/transcription.js";
import { TranscriptionError } from "../services/transcription/ollalinkTranscription.js";
import { encodeCloudWav } from "../../src/lib/cloudTranscriptionAudio.js";

const wav = await encodeCloudWav(new Float32Array(16000)).arrayBuffer();
const headers = { "Content-Type": "audio/wav", "X-Transcription-Request": "1" };

describe("Authenticated Ollalink transcription route", () => {
    let env; let cookie;
    before(async () => {
        env = await setupTestEnvironment();
        ({ cookie } = await env.createSession("ollalink-route@example.com"));
    });
    after(async () => { await env?.teardown(); });

    const appFor = (transcribe) => {
        const app = express();
        app.use(cookieParserMiddleware);
        app.use("/api/transcription", createTranscriptionRouter({ transcribe }));
        return app;
    };

    it("mounts in the existing app and refuses unauthenticated uploads", async () => {
        await withServer(env.app, async (url) => {
            const response = await fetch(`${url}/api/transcription?language=en`, { method: "POST", headers, body: wav });
            assert.equal(response.status, 401);
            assert.equal((await response.json()).code, "UNAUTHORIZED");
        });
    });

    it("uses existing session auth and forwards only validated request fields", async () => {
        let calls = 0;
        await withServer(appFor(async (bytes, options) => {
            calls++;
            assert.equal(bytes.byteLength, wav.byteLength);
            assert.equal(options.language, "en");
            assert.ok(options.signal instanceof AbortSignal);
            return { provider: "ollalink-fast", output: { chunks: [] } };
        }), async (url) => {
            const response = await fetch(`${url}/api/transcription?language=en`, { method: "POST", headers: { ...headers, cookie, Origin: url }, body: wav });
            assert.equal(response.status, 200);
            assert.equal(response.headers.get("cache-control"), "no-store");
            assert.equal((await response.json()).provider, "ollalink-fast");
        });
        assert.equal(calls, 1);
    });

    it("accepts the same host when TLS terminates before the HTTP-facing app", async () => {
        let calls = 0;
        await withServer(appFor(async () => {
            calls++;
            return { provider: "ollalink-fast", output: { chunks: [] } };
        }), async (url) => {
            const requestUrl = new URL(url);
            const externalOrigin = `https://${requestUrl.host}`;
            const response = await fetch(`${url}/api/transcription?language=en`, {
                method: "POST",
                headers: {
                    ...headers,
                    cookie,
                    Origin: externalOrigin,
                    "Sec-Fetch-Site": "same-origin",
                },
                body: wav,
            });
            assert.equal(response.status, 200);
            assert.equal((await response.json()).provider, "ollalink-fast");
        });
        assert.equal(calls, 1);
    });

    it("rejects cross-origin, missing anti-CSRF header, wrong media types and unsupported languages", async () => {
        const requests = [
            { status: 403, headers: { ...headers, Origin: "https://untrusted.example" } },
            { status: 403, headers: { ...headers, "Sec-Fetch-Site": "cross-site" } },
            { status: 403, headers: { "Content-Type": "audio/wav" } },
            { status: 400, headers: { ...headers, "Content-Type": "text/plain" } },
            { status: 400, headers, query: "language=ja" },
            { status: 400, headers, query: "language=en&url=https://untrusted.example/audio.wav" },
        ];
        for (const item of requests) {
            await withServer(appFor(() => assert.fail("rejected before provider call")), async (url) => {
                const response = await fetch(`${url}/api/transcription?${item.query || "language=en"}`, {
                    method: "POST", headers: { ...item.headers, cookie }, body: wav,
                });
                assert.equal(response.status, item.status);
            });
        }
    });

    it("sanitizes unexpected errors and returns safe typed errors", async () => {
        for (const error of [new Error("secret audio/transcript/key"), new TranscriptionError("OLLALINK_TIMEOUT", 504)]) {
            await withServer(appFor(async () => { throw error; }), async (url) => {
                const response = await fetch(`${url}/api/transcription?language=en`, { method: "POST", headers: { ...headers, cookie }, body: wav });
                assert.equal(response.status, error instanceof TranscriptionError ? 504 : 502);
                assert.doesNotMatch(await response.text(), /secret audio|transcript\/key/);
            });
        }
    });

    it("rejects oversized and compressed uploads before provider calls", async () => {
        for (const item of [
            { headers: { ...headers, "Content-Length": "32000001" }, language: "hi", status: 413 },
            { headers: { ...headers, "Content-Encoding": "gzip" }, language: "en", status: 400 },
        ]) {
            // Raw node HTTP permits a declared oversized body without allocating it.
            const { request } = await import("node:http");
            await withServer(appFor(() => assert.fail("must not call provider")), async (url) => {
                const response = await new Promise((resolve, reject) => {
                    const req = request(`${url}/api/transcription?language=${item.language}`, { method: "POST", headers: { ...item.headers, cookie } }, (res) => {
                        let body = ""; res.on("data", (chunk) => { body += chunk; });
                        res.on("end", () => resolve({ status: res.statusCode, body }));
                    });
                    req.on("error", reject); req.end(Buffer.from(wav));
                });
                assert.equal(response.status, item.status);
                assert.doesNotMatch(response.body, /RIFF|secret/);
            });
        }
    });

    it("bounds simultaneous requests and releases slots after completion", async () => {
        let calls = 0; let started;
        const bothStarted = new Promise((resolve) => { started = resolve; });
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        await withServer(appFor(async () => {
            calls++;
            if (calls === 2) started();
            await gate;
            return { provider: "ollalink-fast" };
        }), async (url) => {
            const send = () => fetch(`${url}/api/transcription?language=en`, { method: "POST", headers: { ...headers, cookie }, body: wav });
            const pending = [send(), send()];
            try {
                await bothStarted;
                const busy = await send();
                assert.equal(busy.status, 503);
                assert.equal((await busy.json()).code, "TRANSCRIPTION_BUSY");
                assert.equal(calls, 2);
            } finally { release(); }
            for (const response of await Promise.all(pending)) {
                assert.equal(response.status, 200);
                await response.arrayBuffer();
            }
            const next = await send();
            assert.equal(next.status, 200);
            await next.arrayBuffer();
            assert.equal(calls, 3);
        });
    });

    it("aborts provider work when the authenticated client disconnects", async () => {
        const { request } = await import("node:http");
        let started; let aborted;
        const providerStarted = new Promise((resolve) => { started = resolve; });
        const providerAborted = new Promise((resolve) => { aborted = resolve; });
        await withServer(appFor(async (_bytes, { signal }) => {
            started();
            await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
            aborted();
            throw new TranscriptionError("TRANSCRIPTION_CANCELLED", 499);
        }), async (url) => {
            const req = request(`${url}/api/transcription?language=en`, { method: "POST", headers: { ...headers, cookie } });
            req.on("error", () => { });
            req.end(Buffer.from(wav));
            try { await providerStarted; }
            finally { req.destroy(); }
            await providerAborted;
        });
    });

    it("bounds request rate before provider calls", async () => {
        await withServer(appFor(async () => ({ provider: "ollalink-fast" })), async (url) => {
            for (let index = 0; index < 7; index++) {
                const response = await fetch(`${url}/api/transcription?language=en`, { method: "POST", headers: { ...headers, cookie }, body: wav });
                assert.equal(response.status, index === 6 ? 429 : 200);
                await response.arrayBuffer();
            }
        });
    });
});
