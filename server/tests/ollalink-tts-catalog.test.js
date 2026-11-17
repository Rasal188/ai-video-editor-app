import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createOllalinkTts, createOllalinkTtsCatalog } from "../services/ai/ollalinkTts.js";
import { sanitizeOllalinkTtsCatalog, hasOllalinkTtsPair, requestOllalinkTtsCatalog } from "../../src/lib/ollalinkTtsCatalog.js";
import { catalogResponse, deployedCatalog, speechRequest, wavResponse } from "./ollalink-tts-fixtures.js";
const apiKey = "sk_test_catalog_only";
const code = expected => error => error.code === expected;

describe("Authenticated dynamic fixed voice catalog (offline)", () => {
    it("sanitizes only actual explicit pairs; rejects malformed/unbounded/design catalogs", () => {
        const safe = sanitizeOllalinkTtsCatalog(deployedCatalog, { upstream: true });
        assert.deepEqual(Object.keys(safe.voices[0]), ["id", "name", "languages"]);
        assert.ok(hasOllalinkTtsPair(safe, "delia", "en"));
        assert.ok(!hasOllalinkTtsPair(safe, "delia", "es"));
        const base = deployedCatalog.voices[0];
        for (const voice of [{ ...base, id: "../delia" }, { ...base, id: "a".repeat(65) }, { ...base, name: "<script>" }, { ...base, name: "x".repeat(81) }, { ...base, name: "bad\nname" }, { ...base, languages: [] }, { ...base, languages: ["en", "en"] }, { ...base, languages: ["../en"] }, { ...base, engine: "design" }, { ...base, instructions: true }, { ...base, engine: undefined }]) {
            assert.throws(() => sanitizeOllalinkTtsCatalog({ voices: [voice] }, { upstream: true }), code("TTS_CATALOG_UNAVAILABLE"));
        }
        for (const voices of [[], Array(129).fill(base), [base, base]]) assert.throws(() => sanitizeOllalinkTtsCatalog({ voices }, { upstream: true }), code("TTS_CATALOG_UNAVAILABLE"));
    });
    it("uses only fixed authenticated GET, deduplicates in-flight requests and isolates consumer cancellation", async () => {
        let release, calls = 0, sharedSignal;
        const get = createOllalinkTtsCatalog({
            apiKey, fetchImpl: async (url, options) => {
                calls++; assert.equal(url, "https://gpu-tts.ollalink.com/voices");
                assert.equal(options.method, "GET"); assert.equal(options.redirect, "error");
                assert.equal(options.headers["X-NH-GPU-Key"], apiKey); sharedSignal = options.signal;
                return new Promise(resolve => { release = () => resolve(catalogResponse()); });
            }
        });
        const controller = new AbortController();
        const first = get({ signal: controller.signal }); const second = get();
        controller.abort(); await assert.rejects(first); assert.equal(sharedSignal.aborted, false);
        release(); const catalog = await second; assert.equal(calls, 1);
        assert.equal(await get(), catalog); assert.equal(calls, 1);
    });
    it("expires at 60 seconds; changed catalog/removal blocks POST and never maps old aliases", async () => {
        let time = 0, gets = 0, posts = 0;
        const synthesize = createOllalinkTts({
            apiKey, now: () => time, fetchImpl: async (_url, options) => {
                if (options.method === "GET") { gets++; return gets === 1 ? catalogResponse() : Response.json({ voices: [deployedCatalog.voices[2]] }); }
                posts++; return wavResponse();
            }
        });
        await synthesize(speechRequest); assert.equal(posts, 1);
        for (const request of [{ ...speechRequest, voice: "jason" }, { ...speechRequest, voice: "default" }, { ...speechRequest, voice: "design" }, { ...speechRequest, language: "es" }]) await assert.rejects(synthesize(request), code("TTS_CATALOG_MISMATCH"));
        time = 59999; await synthesize.getCatalog(); assert.equal(gets, 1);
        time = 60000; await assert.rejects(synthesize(speechRequest), code("TTS_CATALOG_MISMATCH"));
        assert.equal(gets, 2); assert.equal(posts, 1);
    });
    it("fails closed for malformed, oversized declared/streamed, wrong MIME and upstream failures; never POSTs", async () => {
        for (const make of [() => Response.json({ voices: [] }), () => new Response("{bad", { headers: { "Content-Type": "application/json" } }), () => new Response("x", { headers: { "Content-Type": "application/json", "Content-Length": String(256 * 1024 + 1) } }), () => new Response("x".repeat(256 * 1024 + 1), { headers: { "Content-Type": "application/json" } }), () => new Response("private", { status: 401 }), () => new Response("private", { status: 503 }), () => new Response("private")]) {
            let posts = 0;
            const synthesize = createOllalinkTts({ apiKey, fetchImpl: async (_url, options) => { if (options.method === "POST") posts++; return make(); } });
            await assert.rejects(synthesize(speechRequest), code("TTS_CATALOG_UNAVAILABLE")); assert.equal(posts, 0);
        }
    });
    it("times out catalog GET at 20 seconds, cancels late response and allows later recovery", async () => {
        mock.timers.enable({ apis: ["setTimeout"] });
        try {
            let release, calls = 0, cancelled = false;
            const get = createOllalinkTtsCatalog({ apiKey, fetchImpl: () => ++calls === 1 ? new Promise(resolve => { release = resolve; }) : catalogResponse() });
            const pending = get(); mock.timers.tick(20000);
            await assert.rejects(pending, code("TTS_CATALOG_UNAVAILABLE"));
            release(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
            await new Promise(resolve => setImmediate(resolve)); assert.ok(cancelled);
            assert.ok((await get()).voices.length); assert.equal(calls, 2);
        } finally { mock.timers.reset(); }
    });
    it("browser GET uses authenticated same-origin security header and returns safe subset", async () => {
        const result = await requestOllalinkTtsCatalog({
            fetchImpl: async (url, options) => {
                assert.equal(url, "/api/tts/voices"); assert.equal(options.method, "GET");
                assert.equal(options.credentials, "include"); assert.equal(options.headers["X-TTS-Request"], "1");
                return catalogResponse();
            }
        });
        assert.deepEqual(Object.keys(result.voices[0]), ["id", "name", "languages"]);
    });
});
