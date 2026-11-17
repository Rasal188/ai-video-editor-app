import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createOllalinkTranscriber, normalizeOllalinkTranscript, OLLALINK_ENDPOINTS } from "../services/transcription/ollalinkTranscription.js";
import { CLOUD_FAST_LANGUAGES, CLOUD_HQ_LANGUAGES, cloudTranscriptionLane, encodeCloudWav, validateCloudWav } from "../../src/lib/cloudTranscriptionAudio.js";
import { requestCloudTranscript, transcribeWithProvider } from "../../src/lib/cloudAsr.js";
import { serializeSrt, parseSrt } from "../../src/lib/subtitles.js";
import { regroupReviewSegments } from "../../src/lib/transcriptReview.js";
import { getCaptionTimeline, moveTimedCaptionSegment } from "../../src/lib/timeline.js";

const audio = new Float32Array(32000);
const bytes = new Uint8Array(await encodeCloudWav(audio).arrayBuffer());
const words = [{ word: "Hello", start: 0.1, end: 0.5 }, { word: "world.", start: 0.6, end: 1.1 }];
const payload = (language = "en", lane = "fast") => ({
    text: "Hello world.", language, duration: 2,
    ...(lane === "fast" ? { words } : { segments: [{ id: 1, start: 0.1, end: 1.1, text: "Hello world.", words }] }),
});
const success = (language = "en", lane = "fast") => Response.json(payload(language, lane));
const normalized = () => normalizeOllalinkTranscript(payload(), { language: "en", duration: 2, lane: "fast" });
const errorCode = (code) => (error) => error.code === code;
const localResult = () => ({ segments: [{ id: "local", text: "Local", start: 0, end: 1 }], rawChunks: [], duration: 2, language: "en", text: "Local" });

// All provider traffic is injected/mocked. No credentials or inference downloads.
describe("Ollalink documented provider contract", () => {
    it("routes all nine documented languages, pins the spoken language and sends only the GPU header", async () => {
        for (const language of CLOUD_HQ_LANGUAGES) {
            const lane = CLOUD_FAST_LANGUAGES.includes(language) ? "fast" : "hq";
            let calls = 0;
            const transcribe = createOllalinkTranscriber({
                apiKey: "sk_mock_gpu", fetchImpl: async (url, options) => {
                    calls += 1;
                    assert.equal(url, OLLALINK_ENDPOINTS[lane]);
                    assert.equal(options.method, "POST");
                    assert.equal(options.redirect, "error");
                    assert.deepEqual(options.headers, { "X-NH-GPU-Key": "sk_mock_gpu" });
                    assert.equal(options.body.get("language"), language);
                    assert.equal(options.body.get("normalize_numbers"), "false");
                    assert.equal(options.body.get("file").type, "audio/wav");
                    assert.equal(options.body.get("file").size, bytes.byteLength);
                    assert.equal(options.body.get("response_format"), lane === "fast" ? "verbose_json" : null);
                    assert.equal(options.body.get("model"), lane === "hq" ? "asr-legacy" : null);
                    assert.equal(options.body.get("word_timestamps"), lane === "hq" ? "true" : null);
                    assert.equal(options.body.get("task"), null);
                    return success(language, lane);
                }
            });
            const result = await transcribe(bytes, { language });
            assert.equal(result.provider, `ollalink-${lane}`);
            assert.deepEqual(result.output.chunks[0], { text: "Hello", timestamp: [0.1, 0.5] });
            assert.deepEqual(result.output.chunks[1], { text: " world.", timestamp: [0.6, 1.1] });
            assert.equal(calls, 1);
        }
    });

    it("validates canonical WAV, sample data, languages and conservative HQ duration limits", async () => {
        assert.equal(validateCloudWav(bytes, "hi").duration, 2);
        assert.throws(() => cloudTranscriptionLane("ja"), errorCode("UNSUPPORTED_LANGUAGE"));
        assert.throws(() => cloudTranscriptionLane("auto"), errorCode("UNSUPPORTED_LANGUAGE"));
        assert.throws(() => encodeCloudWav(new Float32Array([NaN])), errorCode("INVALID_AUDIO"));
        const invalid = bytes.slice(); invalid[0] = 0;
        let calls = 0;
        const transcribe = createOllalinkTranscriber({ apiKey: "sk_mock_gpu", fetchImpl: async () => { calls++; return success(); } });
        for (const input of [new Uint8Array(), new Uint8Array([1, 2]), invalid, { url: "https://example.com" }]) {
            await assert.rejects(transcribe(input, { language: "en" }), errorCode("INVALID_AUDIO"));
        }
        await assert.rejects(transcribe(bytes, { language: "ur" }), errorCode("UNSUPPORTED_LANGUAGE"));
        const long = new Uint8Array(await encodeCloudWav(new Float32Array(16000 * 601)).arrayBuffer());
        await assert.rejects(transcribe(long, { language: "hi" }), errorCode("AUDIO_TOO_LONG"));
        assert.throws(() => validateCloudWav(new Uint8Array(32_000_001), "hi"), errorCode("AUDIO_TOO_LARGE"));
        assert.equal(calls, 0);
    });

    it("rejects absent, partner and malformed credentials without any network request", async () => {
        for (const apiKey of ["", "sk-nhpartner-not-a-gpu-key", "Bearer secret", "sk_bad\nheader"]) {
            const transcribe = createOllalinkTranscriber({ apiKey, fetchImpl: () => assert.fail("must not call network") });
            await assert.rejects(transcribe(bytes, { language: "en" }), errorCode("OLLALINK_NOT_CONFIGURED"));
        }
    });

    it("rejects malformed JSON, missing word alignment and invalid timestamp responses", async () => {
        const cases = [null, {}, { ...payload(), language: "hi" }, { ...payload(), duration: 2000 },
            { ...payload(), words: [] }, { ...payload(), words: [{ word: "x", start: null, end: 1 }] },
            { ...payload(), words: [{ word: "x", start: -1, end: 1 }] },
            { ...payload(), words: [{ word: "x", start: 1, end: 0.5 }] },
            { ...payload(), words: [{ word: "x", start: 0, end: 999 }] },
            { ...payload(), words: [{ word: "x", start: 0.8, end: 1 }, { word: "y", start: 0.2, end: 0.4 }] },
            { ...payload(), words: [{ word: "x", start: 0, end: 0 }] }];
        for (const data of cases) {
            const transcribe = createOllalinkTranscriber({ apiKey: "sk_mock_gpu", fetchImpl: async () => Response.json(data) });
            await assert.rejects(transcribe(bytes, { language: "en" }), errorCode("OLLALINK_INVALID_RESPONSE"));
        }
        for (const response of [new Response("not JSON"), new Response("x".repeat(8_000_001))]) {
            const transcribe = createOllalinkTranscriber({ apiKey: "sk_mock_gpu", fetchImpl: async () => response });
            await assert.rejects(transcribe(bytes, { language: "en" }), errorCode("OLLALINK_INVALID_RESPONSE"));
        }
        assert.throws(() => normalizeOllalinkTranscript({ ...payload("hi", "hq"), segments: [{ text: "No words" }] }, { language: "hi", duration: 2, lane: "hq" }), errorCode("OLLALINK_INVALID_RESPONSE"));
    });

    it("never retries auth failures or forwards upstream response text", async () => {
        for (const status of [400, 401, 403, 404, 500]) {
            let calls = 0;
            const transcribe = createOllalinkTranscriber({
                apiKey: "sk_mock_gpu", fetchImpl: async () => {
                    calls++; return new Response("sensitive upstream response", { status });
                }
            });
            await assert.rejects(transcribe(bytes, { language: "en" }), (error) => {
                assert.doesNotMatch(error.message, /sensitive|sk_mock/);
                return error.code === ([401, 403].includes(status) ? "OLLALINK_AUTH_FAILED" : status < 500 ? "OLLALINK_INVALID_REQUEST" : "OLLALINK_PROVIDER_FAILED");
            });
            assert.equal(calls, 1);
        }
    });

    it("never repeats potentially billable uploads, including transient and Retry-After responses", async () => {
        for (const status of [429, 502, 503, 504]) {
            for (const delay of ["1", "60"]) {
                let calls = 0;
                const transcribe = createOllalinkTranscriber({
                    apiKey: "sk_mock_gpu", fetchImpl: async () => {
                        calls++; return new Response(null, { status, headers: { "Retry-After": delay } });
                    }
                });
                await assert.rejects(transcribe(bytes, { language: "en" }), errorCode(status === 429 ? "OLLALINK_RATE_LIMITED" : "OLLALINK_PROVIDER_FAILED"));
                assert.equal(calls, 1);
            }
        }
    });

    it("times out headers/body reads, sanitizes network errors and respects cancellation", async () => {
        const pending = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        // Keep the event loop alive while Node's unref'd AbortSignal timeout fires.
        const keepAlive = setInterval(() => { }, 1000);
        try {
            const timeout = createOllalinkTranscriber({ apiKey: "sk_mock_gpu", timeoutMs: 10, fetchImpl: pending });
            await assert.rejects(timeout(bytes, { language: "en" }), errorCode("OLLALINK_TIMEOUT"));
            const bodyTimeout = createOllalinkTranscriber({
                apiKey: "sk_mock_gpu", timeoutMs: 10, fetchImpl: async (_url, { signal }) => new Response(new ReadableStream({
                    start(stream) { signal.addEventListener("abort", () => stream.error(signal.reason), { once: true }); },
                }))
            });
            await assert.rejects(bodyTimeout(bytes, { language: "en" }), errorCode("OLLALINK_TIMEOUT"));
            const network = createOllalinkTranscriber({ apiKey: "sk_mock_gpu", fetchImpl: async () => { throw new Error("secret network detail"); } });
            await assert.rejects(network(bytes, { language: "en" }), (error) => error.code === "OLLALINK_PROVIDER_FAILED" && !error.message.includes("secret"));
            const controller = new AbortController(); controller.abort();
            await assert.rejects(timeout(bytes, { language: "en", signal: controller.signal }), errorCode("TRANSCRIPTION_CANCELLED"));
        } finally { clearInterval(keepAlive); }
    });
});

describe("Cloud ASR and existing caption integration", () => {
    it("sends audio only to authenticated same-origin backend, never a provider credential", async () => {
        const result = await requestCloudTranscript(audio, "en", {
            fetchImpl: async (url, options) => {
                assert.equal(url, "/api/transcription?language=en");
                assert.equal(options.credentials, "include");
                assert.deepEqual(options.headers, { "Content-Type": "audio/wav", "X-Transcription-Request": "1" });
                return Response.json({ ok: true, ...normalized() });
            }
        });
        assert.equal(result.provider, "ollalink-fast");
        for (const response of [new Response(null, { status: 401 }), Response.json({ ok: true })]) {
            await assert.rejects(requestCloudTranscript(audio, "en", { fetchImpl: async () => response }));
        }
    });

    it("preserves explicit Local and all existing worker/grouping options with captured preferences", async () => {
        const blob = new Blob(["local"]); const options = { provider: "local", language: "zh", requireWorker: true, preferredLanguage: "zh", grouping: "words" };
        const result = await transcribeWithProvider(blob, options, {
            localTranscribe: async (input, opts) => { assert.equal(input, blob); assert.deepEqual(opts, options); return localResult(); },
            decodeAudio: () => assert.fail("local must not use cloud decoding"), cloudTranscribe: () => assert.fail("local must not call cloud"),
        });
        assert.equal(result.provider, "local-whisper"); assert.equal(result.segments[0].transcriptionProvider, "local-whisper");
    });

    it("preserves word seconds, timeline offsets, review regrouping, editing and SRT export", async () => {
        const result = await transcribeWithProvider(new Blob(), { provider: "ollalink", language: "en", timelineOffset: 10 }, {
            localTranscribe: () => assert.fail("must use cloud"), decodeAudio: async () => ({ audio }), cloudTranscribe: async () => normalized(),
        });
        assert.equal(result.provider, "ollalink-fast");
        assert.equal(result.segments[0].text, "Hello world.");
        assert.equal(result.segments[0].words[0].start, 10.1);
        assert.equal(result.segments[0].words[1].end, 11.1);
        assert.equal(result.segments[0].timingSource, "asr-word");
        const regrouped = regroupReviewSegments(result.rawChunks, 2, { timelineOffset: 10, grouping: "words" });
        assert.equal(regrouped.length, 2);
        const edited = moveTimedCaptionSegment(result.segments, result.segments[0].id, 12, 13);
        assert.equal(edited[0].start, 12);
        assert.equal(getCaptionTimeline(result.segments)[0].start, 10.1);
        const srt = serializeSrt(result.segments);
        assert.match(srt, /00:00:10,100 --> 00:00:11,100/);
        // SRT uses the editor's existing display normalization (terminal punctuation removed).
        assert.equal(parseSrt(srt).captions[0].text, "Hello world");
    });

    it("falls back once on transient provider failure and rejects unsupported language", async () => {
        for (const language of ["en"]) {
            let localCalls = 0; let cloudCalls = 0; const phases = [];
            const options = { provider: "ollalink", language, requireWorker: true, onProgress: ({ phase }) => phases.push(phase) };
            const result = await transcribeWithProvider(new Blob(), options, {
                decodeAudio: async () => ({ audio }),
                cloudTranscribe: async () => { cloudCalls++; throw Object.assign(new Error("provider sensitive data"), { code: "CLOUD_TRANSCRIPTION_FAILED" }); },
                localTranscribe: async (_blob, received) => { localCalls++; assert.equal(received.requireWorker, true); return localResult(); },
            });
            assert.equal(localCalls, 1); assert.equal(cloudCalls, language === "en" ? 1 : 0);
            assert.equal(result.provider, "local-whisper"); assert.equal(result.fallbackFrom, "ollalink");
            assert.ok(phases.some((phase) => phase.includes("falling back")));
            assert.doesNotMatch(JSON.stringify({ phases, reason: result.fallbackReason }), /sensitive/);
        }
        await assert.rejects(transcribeWithProvider(new Blob(), { provider: "ollalink", language: "ja" }, {
            decodeAudio: () => assert.fail("unsupported language must fail before decode"),
            cloudTranscribe: () => assert.fail("unsupported language must not upload"),
            localTranscribe: () => assert.fail("unsupported language must not silently change provider"),
        }));
    });

    it("falls back locally through the real provider adapter for mocked upstream failures", async () => {
        for (const response of [new Response(null, { status: 429, headers: { "Retry-After": "60" } }),
        new Response(null, { status: 503 })]) {
            let localCalls = 0;
            const provider = createOllalinkTranscriber({
                apiKey: "sk_mock_gpu", sleepImpl: async () => { }, fetchImpl: async () => response.clone(),
            });
            const result = await transcribeWithProvider(new Blob(), { provider: "ollalink", language: "en", requireWorker: true }, {
                decodeAudio: async () => ({ audio }),
                cloudTranscribe: async (_audio, language, { signal }) => {
                    try { return await provider(bytes, { language, signal }); }
                    catch (error) { throw Object.assign(new Error("Mock route outage"), { code: ["OLLALINK_RATE_LIMITED", "OLLALINK_RETRY_LATER", "OLLALINK_PROVIDER_FAILED"].includes(error.code) ? "CLOUD_TRANSCRIPTION_FAILED" : error.code }); }
                },
                localTranscribe: async () => { localCalls++; return localResult(); },
            });
            assert.equal(localCalls, 1);
            assert.equal(result.provider, "local-whisper");
            assert.equal(result.fallbackFrom, "ollalink");
        }
    });

    it("does not turn user cancellation into local inference, and preserves local errors", async () => {
        const controller = new AbortController();
        await assert.rejects(transcribeWithProvider(new Blob(), { provider: "ollalink", language: "en", signal: controller.signal }, {
            decodeAudio: async () => ({ audio }), cloudTranscribe: async () => { controller.abort(); throw new Error(); },
            localTranscribe: () => assert.fail("cancellation must not fall through"),
        }), { name: "AbortError" });
        await assert.rejects(transcribeWithProvider(new Blob(), { provider: "local" }, { localTranscribe: async () => { throw new Error("LOCAL_ERROR"); } }), /LOCAL_ERROR/);
    });

    it("keeps cloud configuration server-only and default worker/main fallback code present", async () => {
        const source = await readFile(new URL("../../src/lib/asr.js", import.meta.url), "utf8");
        assert.match(source, /localTranscribe: runTranscription/);
        assert.match(source, /transcribeAudioInWorker/); assert.match(source, /transcribeAudioOnMainThread/);
        assert.doesNotMatch(source, /result\.output\);/);
        for (const file of ["../../src/lib/cloudAsr.js", "../../src/lib/cloudTranscriptionAudio.js", "../../src/components/TranscriptionProviderControl.jsx"]) {
            assert.doesNotMatch(await readFile(new URL(file, import.meta.url), "utf8"), /OLLALINK_API_KEY|X-NH-GPU-Key|sk_mock_gpu/);
        }
    });
});
