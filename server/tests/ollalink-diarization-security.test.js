import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import express from "express";
import { encodeCloudWav } from "../../src/lib/cloudTranscriptionAudio.js";
import { DiarizationError, DIARIZATION_MAX_WAV_BYTES, requestDiarization } from "../../src/lib/ollalinkDiarization.js";
import { createOllalinkDiarizer, OLLALINK_DIARIZATION_ENDPOINT } from "../services/transcription/ollalinkDiarization.js";

// Configure only this isolated test process, before loading the frozen server config.
const previousOrigin = process.env.CORS_ORIGIN;
process.env.CORS_ORIGIN = "https://editor.example.test";
const { createDiarizationRouter } = await import("../routes/diarization.js");
const { cookieParserMiddleware } = await import("../middleware/auth.js");
const { setupTestEnvironment, withServer } = await import("./test-helpers.js");
const { config } = await import("../config.js");
if (previousOrigin === undefined) delete process.env.CORS_ORIGIN;
else process.env.CORS_ORIGIN = previousOrigin;

// Only loopback HTTP is real. Every diarize/provider call is explicitly mocked.
const wav = new Uint8Array(await encodeCloudWav(new Float32Array(16000)).arrayBuffer());
const fixture = () => ({ model: "nemotron-3-diarization", duration: 1, speakers: ["speaker_1"], segments: [{ start: 0, end: 1, speaker: "speaker_1" }] });
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};
let env, session, otherSession;
before(async () => {
    env = await setupTestEnvironment();
    session = await env.createSession("diarization-security@example.com");
    otherSession = await env.createSession("diarization-security-other@example.com");
});
after(async () => { await env?.teardown(); });

function appFor(diarize) {
    const app = express();
    app.use(cookieParserMiddleware);
    app.use("/api/diarization", createDiarizationRouter({ diarize }));
    return app;
}
function post(base, extra = {}, body = wav, options = {}) {
    return fetch(`${base}/api/diarization`, {
        method: "POST", ...options,
        headers: { Cookie: session.cookie, "Content-Type": "audio/wav", "X-Diarization-Request": "1", ...extra }, body,
    });
}
async function expectError(response, status, code) {
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, code);
    return body;
}

test("four sequential authenticated attempts per IP; fifth blocked across sessions and forged forwarding headers", async () => {
    let calls = 0;
    await withServer(appFor(async () => { calls++; return fixture(); }), async base => {
        for (let i = 0; i < 4; i++) {
            const response = await post(base, { Cookie: i % 2 ? otherSession.cookie : session.cookie, "X-Forwarded-For": `198.51.100.${i + 1}` });
            assert.equal(response.status, 200);
            assert.equal(response.headers.get("x-ratelimit-limit"), "4");
            assert.equal(response.headers.get("x-ratelimit-remaining"), String(3 - i));
            assert.ok(Number(response.headers.get("x-ratelimit-reset")) > Date.now() / 1000);
            await response.json();
        }
        const response = await post(base, { Cookie: otherSession.cookie, "X-Forwarded-For": "203.0.113.99" });
        await expectError(response, 429, "RATE_LIMIT_EXCEEDED");
        assert.equal(response.headers.get("x-ratelimit-remaining"), "0");
        assert.equal(calls, 4);
    });
});

test("concurrent authenticated requests cannot bypass either the active slot or the four-attempt limiter", async () => {
    const entered = deferred(), release = deferred();
    let calls = 0;
    await withServer(appFor(async () => { calls++; entered.resolve(); await release.promise; return fixture(); }), async base => {
        const first = post(base);
        try {
            await entered.promise;
            const responses = await Promise.all(Array.from({ length: 5 }, () => post(base)));
            const codes = await Promise.all(responses.map(async response => {
                assert.equal(response.status, 429);
                assert.equal(response.headers.get("cache-control"), "no-store");
                return (await response.json()).code;
            }));
            assert.equal(codes.filter(code => code === "BUSY").length, 3);
            assert.equal(codes.filter(code => code === "RATE_LIMIT_EXCEEDED").length, 2);
            assert.equal(calls, 1);
        } finally {
            release.resolve();
            const response = await first;
            assert.equal(response.status, 200);
            await response.json();
        }
        await expectError(await post(base), 429, "RATE_LIMIT_EXCEEDED");
        assert.equal(calls, 1);
    });
});

test("active slot is reusable after success, provider failure, invalid result and parser/validation rejection", async t => {
    for (const failure of ["success", "provider", "result", "audio", "parser"]) {
        await t.test(failure, async () => {
            let calls = 0;
            await withServer(appFor(async () => {
                calls++;
                if (calls === 1 && failure === "provider") throw new Error("private provider diagnostic");
                if (calls === 1 && failure === "result") return { ...fixture(), segments: [] };
                return fixture();
            }), async base => {
                const body = failure === "audio" ? new Uint8Array([1]) : failure === "parser" ? new Uint8Array(DIARIZATION_MAX_WAV_BYTES + 1) : wav;
                const first = await post(base, {}, body);
                assert.equal(first.status, failure === "success" ? 200 : ["provider", "result"].includes(failure) ? 502 : failure === "parser" ? 413 : 400);
                await first.json();
                const next = await post(base);
                assert.equal(next.status, 200);
                assert.deepEqual(await next.json(), fixture());
                assert.equal(calls, ["audio", "parser"].includes(failure) ? 1 : 2);
            });
        });
    }
});

test("disconnect retains the slot until cancelled provider settles, then releases it exactly once", async () => {
    const entered = deferred(), aborted = deferred(), release = deferred(), settled = deferred();
    let calls = 0;
    await withServer(appFor(async (_bytes, { signal }) => {
        calls++;
        if (calls === 1) {
            signal.addEventListener("abort", () => aborted.resolve(), { once: true });
            entered.resolve(signal);
            await release.promise;
            settled.resolve();
        }
        return fixture();
    }), async base => {
        const controller = new AbortController();
        const pending = post(base, {}, wav, { signal: controller.signal }).then(() => assert.fail("cancelled request unexpectedly completed"), error => assert.equal(error.name, "AbortError"));
        try {
            const signal = await entered.promise;
            controller.abort();
            await pending;
            await aborted.promise;
            assert.equal(signal.aborted, true);
            await expectError(await post(base), 429, "BUSY");
            assert.equal(calls, 1);
            release.resolve();
            await settled.promise;
            await nextTurn();
            // Both remaining attempts must succeed: catches leaked or double-released ownership.
            for (let i = 0; i < 2; i++) {
                const response = await post(base);
                assert.equal(response.status, 200);
                await response.json();
            }
            assert.equal(calls, 3);
        } finally {
            controller.abort();
            release.resolve();
            await pending;
        }
    });
});

test("origin, opt-in header, Fetch Metadata and content encoding policy", async t => {
    const cases = [
        ["absent origin", () => ({}), 200],
        ["same origin", base => ({ Origin: base }), 200],
        ["configured editor origin", () => ({ Origin: config.server.corsOrigin }), 200],
        ["same-origin Fetch Metadata", () => ({ "Sec-Fetch-Site": "same-origin" }), 200],
        ["same-site Fetch Metadata", () => ({ "Sec-Fetch-Site": "same-site" }), 200],
        ["navigation Fetch Metadata", () => ({ "Sec-Fetch-Site": "none" }), 200],
        ["untrusted origin", () => ({ Origin: "https://evil.invalid" }), 403],
        ["opaque origin", () => ({ Origin: "null" }), 403],
        ["malformed origin", () => ({ Origin: "not a URL" }), 403],
        ["noncanonical origin", base => ({ Origin: `${base}/` }), 403],
        ["cross-site even with trusted origin", base => ({ Origin: base, "Sec-Fetch-Site": "cross-site" }), 403],
        ["missing opt-in header", () => ({ "X-Diarization-Request": "" }), 403],
        ["wrong opt-in header", () => ({ "X-Diarization-Request": "true" }), 403],
        ["combined opt-in header", () => ({ "X-Diarization-Request": "1, 1" }), 403],
        ["gzip encoding", () => ({ "Content-Encoding": "gzip" }), 400],
        ["identity encoding", () => ({ "Content-Encoding": "identity" }), 400],
    ];
    assert.equal(config.server.corsOrigin, "https://editor.example.test");
    for (const [name, headers, status] of cases) {
        await t.test(name, async () => {
            let calls = 0;
            await withServer(appFor(async () => { calls++; return fixture(); }), async base => {
                const response = await post(base, headers(base));
                if (status === 200) {
                    assert.equal(response.status, 200);
                    assert.equal(response.headers.get("cache-control"), "no-store");
                    assert.deepEqual(await response.json(), fixture());
                } else await expectError(response, status, status === 403 ? "FORBIDDEN" : "INVALID_AUDIO");
                assert.equal(calls, status === 200 ? 1 : 0);
            });
        });
    }
});

test("authentication contract is unchanged and unauthenticated requests never spend authenticated rate budget", async () => {
    let calls = 0;
    await withServer(appFor(async () => { calls++; return fixture(); }), async base => {
        for (let i = 0; i < 5; i++) {
            const missing = await post(base, { Cookie: "", Authorization: "Bearer sk_mock_not_a_session", "X-NH-GPU-Key": "sk_mock_not_a_session" });
            assert.deepEqual(await expectError(missing, 401, "UNAUTHORIZED"), { ok: false, code: "UNAUTHORIZED", message: "Authentication required." });
            assert.equal(missing.headers.get("x-ratelimit-limit"), null);
            const invalid = await post(base, { Cookie: `${config.auth.sessionCookieName}=invalid-session` });
            assert.deepEqual(await expectError(invalid, 401, "INVALID_SESSION"), { ok: false, code: "INVALID_SESSION", message: "Session is invalid or has expired." });
            assert.match(invalid.headers.get("set-cookie"), new RegExp(`^${config.auth.sessionCookieName}=`));
            assert.equal(invalid.headers.get("x-ratelimit-limit"), null);
        }
        assert.equal(calls, 0);
        for (let i = 0; i < 4; i++) {
            const response = await post(base);
            assert.equal(response.status, 200);
            assert.equal(response.headers.get("set-cookie"), null);
            await response.json();
        }
        await expectError(await post(base), 429, "RATE_LIMIT_EXCEEDED");
        assert.equal(calls, 4);
    });
});

test("route rebuilds public errors without leaking injected messages, keys, stacks or headers", async () => {
    const secret = "sk_mock_security_canary";
    let calls = 0;
    await withServer(appFor(async () => {
        calls++;
        const error = calls === 1 ? new Error(secret) : new DiarizationError("AUTH_FAILED");
        error.message = `private upstream ${secret}`;
        error.stack = `private stack ${secret}`;
        error.headers = { "X-NH-GPU-Key": secret };
        throw error;
    }), async base => {
        for (const code of ["FAILED", "AUTH_FAILED"]) {
            const response = await post(base);
            const publicError = new DiarizationError(code);
            const body = await expectError(response, publicError.status, code);
            assert.deepEqual(body, { ok: false, code, message: publicError.message });
            assert.ok(!JSON.stringify({ body, headers: [...response.headers] }).includes(secret));
        }
        assert.equal(calls, 2, "one provider invocation per explicit request, no retry");
    });
});

test("mock provider cancels response bodies, strips secrets and never retries failures or follows redirects", async t => {
    const secret = "sk_mock_security_canary";
    for (const scenario of ["success", "busy", "redirect", "invalid MIME", "network"]) {
        await t.test(scenario, async () => {
            let calls = 0, cancelled = 0;
            const diarize = createOllalinkDiarizer({
                apiKey: secret, fetchImpl: async (url, options) => {
                    calls++;
                    assert.equal(url, OLLALINK_DIARIZATION_ENDPOINT);
                    assert.equal(options.redirect, "error");
                    assert.equal(options.headers["X-NH-GPU-Key"], secret);
                    if (scenario === "network") throw new Error(`private network ${secret}`);
                    const status = scenario === "busy" ? 503 : scenario === "redirect" ? 307 : 200;
                    const body = scenario === "success" ? { ...fixture(), key: secret, segments: [{ ...fixture().segments[0], key: secret }] } : { private: secret };
                    return new Response(new ReadableStream({
                        start(controller) {
                            controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
                            if (scenario === "success") controller.close();
                        },
                        cancel() { cancelled++; },
                    }), { status, headers: { "Content-Type": scenario === "invalid MIME" ? "text/plain" : "application/json", Location: "https://evil.invalid", "Retry-After": "1" } });
                }
            });
            if (scenario === "success") assert.deepEqual(await diarize(wav), fixture());
            else {
                const code = scenario === "busy" ? "BUSY" : scenario === "invalid MIME" ? "INVALID_RESULT" : "FAILED";
                await assert.rejects(diarize(wav), error => {
                    assert.ok(error instanceof DiarizationError);
                    assert.equal(error.code, code);
                    assert.equal(error.message, new DiarizationError(code).message);
                    assert.ok(!String(error.stack).includes(secret));
                    return true;
                });
                if (scenario !== "network") assert.equal(cancelled, 1, "unread upstream body must be cancelled");
            }
            assert.equal(calls, 1);
        });
    }
});

test("late provider response after cancellation is disposed; pre-cancelled requests do not dispatch", async () => {
    const controller = new AbortController(), late = deferred();
    let calls = 0, cancelled = 0;
    const diarize = createOllalinkDiarizer({ apiKey: "sk_mock_security", fetchImpl: () => { calls++; return late.promise; } });
    const pending = diarize(wav, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, error => error.code === "CANCELLED");
    late.resolve(new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { "Content-Type": "application/json" } }));
    await nextTurn();
    assert.equal(cancelled, 1);
    await assert.rejects(diarize(wav, { signal: controller.signal }), error => error.code === "CANCELLED");
    assert.equal(calls, 1);
});

test("browser transport uses same-origin credentials, rejects redirects and sanitizes errors without retry", async () => {
    let calls = 0, cancelled = 0;
    await assert.rejects(requestDiarization(new Blob([wav]), {
        fetchImpl: async (url, options) => {
            calls++;
            assert.equal(url, "/api/diarization");
            assert.equal(options.credentials, "same-origin");
            assert.equal(options.redirect, "error");
            assert.deepEqual(options.headers, { "Content-Type": "audio/wav", "X-Diarization-Request": "1" });
            return new Response(new ReadableStream({
                start(controller) { controller.enqueue(new TextEncoder().encode("sk_mock_private_server_error")); },
                cancel() { cancelled++; },
            }), { status: 503 });
        }
    }), error => error instanceof DiarizationError && error.code === "FAILED" && !error.message.includes("sk_mock"));
    assert.equal(calls, 1);
    assert.equal(cancelled, 1);
});
