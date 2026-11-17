import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    TRANSLATION_LANGUAGES, NORMALIZATION_LANGUAGES, validateSubtitleTextRequest,
    validateSubtitleTextResult, requestSubtitleTextTools, applySubtitleTextReview,
} from "../../src/lib/subtitleTextTools.js";
import { createOllalinkTextTools, OLLALINK_TEXT_ENDPOINTS } from "../services/transcription/ollalinkTextTools.js";
import { serializeSrt, parseSrt } from "../../src/lib/subtitles.js";
import { updateSegmentText } from "../../src/lib/transcriptReview.js";
import { areWordsValidForKaraoke } from "../../src/lib/karaoke.js";

const cue = { id: "cue-1", text: "Open port four forty three." };
const request = (extra = {}) => ({ operation: "translate", source: "en", target: "es", cues: [cue], ...extra });
const translated = (body, extra = {}) => ({ translation: "Abra el puerto 443.", source: body.source ?? null, target: body.target, numbers_verified: true, characters: Array.from(body.text).length, ...extra });
const normalized = (body, extra = {}) => ({ text: body.text, normalized: "Open port 443.", changed: true, language: body.language, characters: Array.from(body.text).length, ...extra });
const response = data => Response.json(data);
const make = (fetchImpl, extra = {}) => createOllalinkTextTools({ apiKey: "sk_test_only", fetchImpl, sleepImpl: async () => { }, ...extra });
const fails = (task, code) => assert.rejects(task, error => error.code === code);

describe("Documented Ollalink subtitle text contracts (mocked HTTP)", () => {
    for (const source of Object.keys(TRANSLATION_LANGUAGES)) {
        it(`validates all nine targets from ${source}, with exact fields and fixed authentication`, async () => {
            for (const target of Object.keys(TRANSLATION_LANGUAGES)) {
                const run = make(async (url, options) => {
                    assert.equal(url, OLLALINK_TEXT_ENDPOINTS.translate);
                    assert.equal(options.redirect, "error");
                    assert.equal(options.headers["X-NH-GPU-Key"], "sk_test_only");
                    const body = JSON.parse(options.body);
                    assert.deepEqual(body, { text: cue.text, source, target });
                    return response(translated(body));
                });
                const result = await run(request({ source, target }));
                assert.equal(result.results[0].id, cue.id);
                assert.equal(result.results[0].numbersVerified, true);
            }
        });
    }
    it("omits auto source and preserves numbers_verified false for explicit review", async () => {
        const input = request(); delete input.source;
        const result = await make(async (_url, options) => {
            const body = JSON.parse(options.body);
            assert.equal(Object.hasOwn(body, "source"), false);
            return response(translated(body, { numbers_verified: false }));
        })(input);
        assert.equal(result.results[0].numbersVerified, false);
    });
    for (const language of Object.keys(NORMALIZATION_LANGUAGES)) {
        it(`normalizes ${language} with the documented schema`, async () => {
            const result = await make(async (url, options) => {
                assert.equal(url, OLLALINK_TEXT_ENDPOINTS.normalize);
                const body = JSON.parse(options.body);
                assert.deepEqual(body, { text: cue.text, language });
                return response(normalized(body));
            })({ operation: "normalize", language, cues: [cue] });
            // The provider schema is valid, but "four forty three" is not a
            // confidently parsed quantity; retain the port expression for review.
            assert.equal(result.results[0].changed, false);
            assert.equal(result.results[0].text, cue.text);
            assert.ok(result.results[0].reviewReasons.length);
        });
    }
    it("rejects unsupported languages, unknown fields, duplicate IDs and limits before dispatch", async () => {
        let calls = 0;
        const run = make(async () => { calls++; });
        for (const input of [request({ target: "ja" }), request({ source: "it" }), { operation: "normalize", language: "es", cues: [cue] }]) await fails(run(input), "UNSUPPORTED_LANGUAGE");
        for (const input of [request({ url: "https://invalid.example" }), request({ stream: true }), request({ cues: [cue, cue] }), request({ cues: [{ ...cue, start: 1 }] }), null]) await fails(run(input), "INVALID_TEXT_REQUEST");
        for (const input of [request({ cues: [] }), request({ cues: [{ ...cue, text: "x".repeat(5001) }] }), request({ cues: [0, 1, 2].map(id => ({ id: String(id), text: "x".repeat(4000) })) })]) await fails(run(input), "TEXT_LIMIT_EXCEEDED");
        assert.equal(calls, 0);
    });
    it("counts Unicode codepoints, not UTF-16 units, and accepts the exact cue boundary", async () => {
        const text = "😀".repeat(5000);
        const input = request({ cues: [{ ...cue, text }] });
        validateSubtitleTextRequest(input);
        await make(async (_url, options) => response(translated(JSON.parse(options.body))))(input);
    });
    it("rejects malformed or mismatched translation responses", async () => {
        for (const data of [null, {}, translated({ ...cue, target: "es", source: "en" }, { translation: "" }), translated({ ...cue, target: "es", source: "en" }, { target: "fr" }), translated({ ...cue, target: "es", source: "en" }, { source: null }), translated({ ...cue, target: "es", source: "en" }, { characters: 0 }), translated({ ...cue, target: "es", source: "en" }, { numbers_verified: "true" }), translated({ ...cue, target: "es", source: "en" }, { translation: "x".repeat(20001) })]) await fails(make(async () => response(data))(request()), "OLLALINK_INVALID_RESPONSE");
    });
    it("rejects malformed normalization responses and accepts unchanged text", async () => {
        const input = { operation: "normalize", language: "hi", cues: [cue] };
        for (const extra of [{ text: "wrong" }, { language: "en" }, { changed: false }, { normalized: null }]) await fails(make(async () => response(normalized({ text: cue.text, language: "hi" }, extra)))(input), "OLLALINK_INVALID_RESPONSE");
        const result = await make(async () => response(normalized({ text: cue.text, language: "hi" }, { normalized: cue.text, changed: false })))(input);
        assert.equal(result.results[0].changed, false);
    });
    it("rejects oversized bodies, non-JSON content and malformed JSON", async () => {
        for (const r of [new Response("x".repeat(256001), { headers: { "Content-Type": "application/json" } }), new Response("private upstream text"), new Response("{bad", { headers: { "Content-Type": "application/json" } })]) await fails(make(async () => r)(request()), "OLLALINK_INVALID_RESPONSE");
    });
    it("bounds transient retries and does not leak raw provider failure bodies", async () => {
        let calls = 0;
        const run = make(async () => { calls++; return new Response("secret raw text", { status: 503 }); });
        await assert.rejects(run(request()), error => error.code === "OLLALINK_PROVIDER_FAILED" && !error.message.includes("secret"));
        assert.equal(calls, 2);
        for (const status of [401, 403, 400, 413]) {
            calls = 0;
            await assert.rejects(make(async () => { calls++; return new Response("private", { status }); })(request()));
            assert.equal(calls, 1);
        }
        calls = 0;
        await fails(make(async () => { calls++; return new Response(null, { status: 429, headers: { "Retry-After": "60" } }); })(request()), "OLLALINK_RETRY_LATER");
        assert.equal(calls, 1);
    });
    it("recovers once from transient failure and preserves cue order", async () => {
        let calls = 0;
        const result = await make(async (_url, options) => {
            calls++;
            return calls === 1 ? new Response(null, { status: 503 }) : response(translated(JSON.parse(options.body)));
        })(request({ cues: [cue, { id: "second", text: "second cue" }] }));
        assert.equal(calls, 3);
        assert.deepEqual(result.results.map(item => item.id), [cue.id, "second"]);
    });
    it("handles total deadline, caller cancellation and late fetch success without next-cue work", async () => {
        const abortingFetch = async (_url, { signal }) => new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        const hold = setTimeout(() => { }, 200);
        try { await fails(make(abortingFetch, { timeoutMs: 5 })(request()), "OLLALINK_TIMEOUT"); }
        finally { clearTimeout(hold); }
        const controller = new AbortController();
        let calls = 0;
        await fails(make(async (_url, options) => { calls++; controller.abort(); return response(translated(JSON.parse(options.body))); })(request({ cues: [cue, { id: "second", text: "hello" }] }), { signal: controller.signal }), "TEXT_PROCESSING_CANCELLED");
        assert.equal(calls, 1);
        const cancelled = new AbortController(); cancelled.abort();
        await fails(make(async () => { assert.fail("must not dispatch"); })(request(), { signal: cancelled.signal }), "TEXT_PROCESSING_CANCELLED");
    });
    it("times out stalled response consumption and rejects partial cue results", async () => {
        const hold = setTimeout(() => { }, 200);
        try {
            await fails(make(async () => new Response(new ReadableStream({ start() { } }), { headers: { "Content-Type": "application/json" } }), { timeoutMs: 5 })(request()), "OLLALINK_TIMEOUT");
        } finally { clearTimeout(hold); }
        let calls = 0;
        await assert.rejects(make(async (_url, options) => {
            calls++;
            if (calls > 1) return response({});
            return response(translated(JSON.parse(options.body)));
        })(request({ cues: [cue, { id: "second", text: "hello" }] })));
        assert.equal(calls, 2);
    });
    it("requires configured credentials without exposing values", async () => {
        await fails(createOllalinkTextTools({})(request()), "OLLALINK_NOT_CONFIGURED");
    });
});

describe("Subtitle text review, client and export invariants", () => {
    const captions = [
        { ...cue, start: 10.125, end: 12.875, hidden: false, audioSegmentId: "audio-1", fontId: "font-1", styleOverrides: { karaoke: true }, words: [{ text: "Open", start: 10.125, end: 10.8 }], timingSource: "asr" },
        { id: "keep", text: "Keep this.", start: 13, end: 14.5, words: [{ text: "Keep", start: 13, end: 13.5 }] },
    ];
    it("only explicit apply changes text; preserves IDs, numbering, timings, links, order and offsets", () => {
        const snapshot = structuredClone(captions);
        const before = serializeSrt(captions, 20, { preserveText: true });
        const result = [{ id: cue.id, text: "Puerto 443.\nNo abrir." }];
        assert.deepEqual(captions, snapshot);
        const next = applySubtitleTextReview(captions, snapshot, result);
        assert.deepEqual(captions, snapshot);
        const { text: _text, words: _words, timingSource: _timing, ...metadata } = next[0];
        const { text: _oldText, words: _oldWords, timingSource: _oldTiming, ...oldMetadata } = captions[0];
        assert.deepEqual(metadata, oldMetadata);
        assert.equal(next[1], captions[1]);
        assert.equal(next[0].words, undefined);
        assert.equal(areWordsValidForKaraoke(next[0].words, next[0].start, next[0].end), false);
        const after = serializeSrt(next, 20, { preserveText: true });
        assert.deepEqual([...after.matchAll(/\d{2}:\d{2}:\d{2},\d{3} --> .*/g)].map(x => x[0]), [...before.matchAll(/\d{2}:\d{2}:\d{2},\d{3} --> .*/g)].map(x => x[0]));
        assert.match(after, /1\r\n00:00:10,125 --> 00:00:12,875/);
        assert.match(after, /2\r\n00:00:13,000 --> 00:00:14,500/);
        assert.equal(parseSrt(after).captions[0].text, result[0].text);
        const edited = updateSegmentText(next, cue.id, "Further edit!");
        assert.equal(edited[0].start, captions[0].start);
        assert.match(serializeSrt(edited, 20, { preserveText: true }), /Further edit!/);
    });
    it("unchanged results retain genuine karaoke data and reject all stale review variants", () => {
        const snapshot = structuredClone(captions);
        const results = [{ id: cue.id, text: cue.text }];
        assert.equal(applySubtitleTextReview(captions, snapshot, results)[0], captions[0]);
        for (const current of [captions.slice(1), [...captions].reverse(), captions.map((c, i) => i ? c : { ...c, start: 11 }), captions.map((c, i) => i ? c : { ...c, text: "new" })]) assert.throws(() => applySubtitleTextReview(current, snapshot, results), /changed/);
        for (const invalid of [[{ id: "unknown", text: "hello" }], [{ id: cue.id, text: "" }], [results[0], results[0]]]) assert.throws(() => applySubtitleTextReview(captions, snapshot, invalid));
    });
    it("client sends only same-origin credentialed JSON and rejects mismatched cue responses", async () => {
        await requestSubtitleTextTools(request(), {
            fetchImpl: async (url, options) => {
                assert.equal(url, "/api/subtitle-tools"); assert.equal(options.credentials, "include");
                assert.equal(options.headers["X-Subtitle-Tools-Request"], "1");
                assert.equal(options.headers["X-NH-GPU-Key"], undefined);
                return response({ ok: true, operation: "translate", results: [{ id: cue.id, text: "Hola", numbersVerified: true }] });
            }
        });
        for (const data of [{ operation: "normalize", results: [] }, { operation: "translate", results: [{ id: "wrong", text: "Hola", numbersVerified: true }] }, { operation: "translate", results: [{ id: cue.id, text: "Hola" }] }]) assert.throws(() => validateSubtitleTextResult(data, request()));
        await assert.rejects(requestSubtitleTextTools(request(), { fetchImpl: async () => new Response("private", { status: 401 }) }), /Sign in/);
    });
    it("client cancellation suppresses late JSON responses", async () => {
        const controller = new AbortController();
        await assert.rejects(requestSubtitleTextTools(request(), { signal: controller.signal, fetchImpl: async () => ({ ok: true, json: async () => { controller.abort(); return { ok: true }; } }) }), error => error.name === "AbortError");
    });
});
