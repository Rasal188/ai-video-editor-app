import assert from "node:assert/strict";
import { test } from "node:test";
import {
    captureTranscriptionPreferences, DEFAULT_TRANSCRIPTION_PREFERENCES, getTranscriptionPreferences,
    normalizeTranscriptionPreferences, readSavedTranscriptionPreferences, restoreProjectTranscriptionPreferences,
    setTranscriptionPreferences, subscribeTranscriptionPreferences, TRANSCRIPTION_PREFERENCE_KEY
} from "../src/lib/transcriptionPreferences.js";
import { isCaptionSourceAvailable, resolveCaptionSourceMedia } from "../src/lib/captionSourceResolver.js";
import { requestCloudTranscript, transcribeWithProvider } from "../src/lib/cloudAsr.js";

import { createWebMcpAiJobs } from "../src/lib/webMcpAiJobs.js";

const localResult = () => ({
    text: "Local words", language: "es", duration: 2,
    segments: [{ id: "local", text: "Local words", start: 0, end: 2 }]
});
const cloudResult = (language = "en") => ({
    ok: true, provider: "ollalink-fast", language, duration: 2,
    output: { chunks: [{ text: "Cloud words", timestamp: [0, 2] }] }
});
const blob = new Blob(["mock media"], { type: "video/mp4" });
const probeAudio = async value => value === blob;
const noNetwork = globalThis.fetch;
// Every test must use an explicit mock. Any accidental real request is a failure.
globalThis.fetch = async () => { throw new Error("Live network forbidden in migration tests"); };
process.on("exit", () => { globalThis.fetch = noNetwork; });

test("no preference is cloud; explicit saved Local and project choices survive without overwriting browser settings", () => {
    const values = new Map();
    const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    assert.deepEqual(readSavedTranscriptionPreferences(storage), DEFAULT_TRANSCRIPTION_PREFERENCES);
    let updates = 0;
    const unsubscribe = subscribeTranscriptionPreferences(() => updates++);
    setTranscriptionPreferences({ provider: "local", language: "es" });
    assert.deepEqual(JSON.parse(storage.getItem(TRANSCRIPTION_PREFERENCE_KEY)), { provider: "local", language: "es" });
    assert.deepEqual(readSavedTranscriptionPreferences(storage), { provider: "local", language: "es" });
    restoreProjectTranscriptionPreferences({ transcription: { provider: "ollalink", language: "fr" } });
    assert.deepEqual(getTranscriptionPreferences(), { provider: "ollalink", language: "fr" });
    assert.equal(readSavedTranscriptionPreferences(storage).provider, "local");
    restoreProjectTranscriptionPreferences({});
    assert.deepEqual(getTranscriptionPreferences(), { provider: "local", language: "es" });
    const approved = captureTranscriptionPreferences({ stageOnly: true, requireWorker: true });
    setTranscriptionPreferences({ provider: "ollalink", language: "en" });
    assert.equal(approved.provider, "local"); assert.equal(approved.language, "es");
    assert.ok(Object.isFrozen(approved)); assert.equal(approved.requireWorker, true);
    assert.ok(updates >= 4); unsubscribe();
    assert.deepEqual(normalizeTranscriptionPreferences({ provider: "invalid" }), DEFAULT_TRANSCRIPTION_PREFERENCES);
});

test("explicit URL and media aliases resolve only the requested target, including failure and abort", async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    const state = { sourceAudioBlob: blob };
    const options = { src: "blob:requested-target", start: 7, sourceStart: 2, duration: 3, probeAudio };
    globalThis.fetch = async (url, init) => {
        calls.push([url, init]);
        return { ok: true, blob: async () => blob };
    };
    try {
        assert.equal(await isCaptionSourceAvailable(state, options), true);
        assert.deepEqual(await resolveCaptionSourceMedia(state, options), { blob, start: 7, sourceStart: 2, duration: 3 });
        assert.ok(calls.every(([url]) => url === options.src));
        assert.equal((await resolveCaptionSourceMedia({}, { mediaBlob: blob, probeAudio })).blob, blob);
        assert.equal((await resolveCaptionSourceMedia({}, { mediaFile: blob, probeAudio })).blob, blob);
        const before = calls.length;
        assert.equal(await isCaptionSourceAvailable(state, { ...options, hasAudio: false }), false);
        assert.equal(calls.length, before);
        globalThis.fetch = async () => ({ ok: false });
        assert.equal(await resolveCaptionSourceMedia(state, options), null);
        globalThis.fetch = async () => ({ ok: true, blob: async () => new Blob(["unsupported"]) });
        assert.equal(await isCaptionSourceAvailable(state, options), false);
        const controller = new AbortController();
        globalThis.fetch = async (_url, init) => {
            assert.equal(init.signal, controller.signal);
            controller.abort();
            throw new DOMException("Cancelled", "AbortError");
        };
        await assert.rejects(resolveCaptionSourceMedia(state, { ...options, signal: controller.signal }), { name: "AbortError" });
        assert.equal(state.sourceAudioBlob, blob);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("embedded audio without project source blob qualifies nonmutating, preserving clip timing", async () => {
    const clip = Object.freeze({ id: "v", type: "video", blob, duration: 3, sourceStart: 2 });
    const d = { sourceAudioBlob: null, visualSegments: [{ type: "image", duration: 4 }, clip] };
    assert.equal(await isCaptionSourceAvailable(d, { probeAudio }), true);
    assert.deepEqual(await resolveCaptionSourceMedia(d, { probeAudio }), { blob, start: 4, sourceStart: 2, duration: 3 });
    assert.equal(d.sourceAudioBlob, null);
});

test("standalone/source audio qualify; unsupported, missing, silent, muted, locked and busy sources do not", async () => {
    assert.equal(await isCaptionSourceAvailable({ audioSegments: [{ blob, start: 5, duration: 2 }] }, { probeAudio }), true);
    assert.equal(await isCaptionSourceAvailable({ sourceAudioBlob: blob }, { probeAudio }), true);
    assert.equal(await isCaptionSourceAvailable({}, { probeAudio }), false);
    assert.equal(await isCaptionSourceAvailable({ visualSegments: [{ type: "image", blob }] }, { probeAudio }), false);
    assert.equal(await isCaptionSourceAvailable({ visualSegments: [{ type: "video", blob }] }, { probeAudio: async () => false }), false);
    for (const silent of [{ hasAudio: false }, { isMuted: true }, { volume: 0 }]) {
        assert.equal(await isCaptionSourceAvailable({ visualSegments: [{ type: "video", blob, ...silent }] }, { probeAudio }), false);
        assert.equal(await isCaptionSourceAvailable({}, { blob, ...silent, probeAudio }), false);
    }
    for (const state of [{ status: "captioning" }, { status: "generating" }, { trackLocks: { caption: true } }, { trackLocks: { captions: true } }]) {
        assert.equal(await isCaptionSourceAvailable({ sourceAudioBlob: blob, ...state }, { probeAudio }), false);
    }
    const d = { visualSegments: [{ type: "video", blob, hasAudio: false }], audioSegments: [{ blob, start: 8 }] };
    assert.equal((await resolveCaptionSourceMedia(d, { probeAudio })).start, 8);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(resolveCaptionSourceMedia(d, { probeAudio, signal: controller.signal }), { name: "AbortError" });
});

test("default and explicit cloud use one cloud call; Local remains explicit and preserves worker/options/language", async () => {
    setTranscriptionPreferences(DEFAULT_TRANSCRIPTION_PREFERENCES);
    let cloud = 0, local = 0;
    const deps = {
        decodeAudio: async () => ({ audio: new Float32Array(32000) }),
        cloudTranscribe: async (_audio, language) => { cloud++; return cloudResult(language); },
        localTranscribe: async (_blob, options) => { local++; assert.equal(options.language, "es"); assert.equal(options.requireWorker, true); return localResult(); }
    };
    assert.equal((await transcribeWithProvider(blob, {}, deps)).provider, "ollalink-fast");
    assert.equal((await transcribeWithProvider(blob, { provider: "ollalink", language: "es" }, deps)).provider, "ollalink-fast");
    const localOutput = await transcribeWithProvider(blob, { provider: "local", language: "es", requireWorker: true }, deps);
    assert.equal(localOutput.provider, "local-whisper");
    assert.equal(localOutput.segments[0].transcriptionProvider, "local-whisper");
    assert.equal(cloud, 2); assert.equal(local, 1);
});

test("approved cloud/language remains frozen if preference changes during decoding", async () => {
    setTranscriptionPreferences({ provider: "ollalink", language: "es" });
    let release;
    const decode = new Promise(resolve => { release = resolve; });
    const seen = [];
    const pending = transcribeWithProvider(blob, {}, {
        decodeAudio: () => decode,
        localTranscribe: async () => { throw new Error("Unexpected local call"); },
        cloudTranscribe: async (_audio, language) => { seen.push(language); return cloudResult(language); }
    });
    setTranscriptionPreferences({ provider: "local", language: "fr" });
    release({ audio: new Float32Array(32000) });
    assert.equal((await pending).provider, "ollalink-fast"); assert.deepEqual(seen, ["es"]);
});

test("eligible cloud outage falls back once, with no duplicate cloud request and honest metadata", async () => {
    let cloud = 0, local = 0;
    const result = await transcribeWithProvider(blob, { provider: "ollalink", language: "en" }, {
        decodeAudio: async () => ({ audio: new Float32Array(32000) }),
        cloudTranscribe: async () => { cloud++; throw Object.assign(new Error("Unavailable"), { code: "CLOUD_TRANSCRIPTION_FAILED" }); },
        localTranscribe: async () => { local++; return localResult(); },
    });
    assert.equal(cloud, 1); assert.equal(local, 1);
    assert.equal(result.provider, "local-whisper"); assert.equal(result.fallbackFrom, "ollalink");
});

test("cancellation before or during cloud never triggers Local fallback", async () => {
    for (const pre of [true, false]) {
        const controller = new AbortController(); if (pre) controller.abort();
        let local = 0, cloud = 0;
        await assert.rejects(transcribeWithProvider(blob, { provider: "ollalink", language: "en", signal: controller.signal }, {
            decodeAudio: async () => ({ audio: new Float32Array(32000) }),
            cloudTranscribe: async () => { cloud++; controller.abort(); throw new Error("Transport cancelled"); },
            localTranscribe: async () => { local++; return localResult(); },
        }), { name: "AbortError" });
        assert.equal(local, 0); assert.equal(cloud, pre ? 0 : 1);
    }
});

test("auth, validation, unsupported languages and invalid responses stop without fallback/retries", async () => {
    for (const status of [400, 401, 403, 413, 422]) {
        let local = 0, calls = 0;
        await assert.rejects(transcribeWithProvider(blob, { provider: "ollalink", language: "en" }, {
            decodeAudio: async () => ({ audio: new Float32Array(32000) }),
            cloudTranscribe: (audio, language, options) => requestCloudTranscript(audio, language, {
                ...options,
                fetchImpl: async () => { calls++; return new Response("{}", { status }); }
            }),
            localTranscribe: async () => { local++; return localResult(); },
        }), error => ["CLOUD_SIGN_IN_REQUIRED", "CLOUD_INVALID_REQUEST"].includes(error.code));
        assert.equal(local, 0); assert.equal(calls, 1);
    }
    for (const [body, status] of [["not-json", 200], ["{}", 200], [JSON.stringify({ code: "OLLALINK_AUTH_FAILED" }), 503], [JSON.stringify({ code: "OLLALINK_INVALID_RESPONSE" }), 502]]) {
        let local = 0, calls = 0;
        await assert.rejects(transcribeWithProvider(blob, { provider: "ollalink", language: "en" }, {
            decodeAudio: async () => ({ audio: new Float32Array(32000) }),
            cloudTranscribe: (audio, language, options) => requestCloudTranscript(audio, language, {
                ...options, fetchImpl: async () => { calls++; return new Response(body, { status }); },
            }),
            localTranscribe: async () => { local++; return localResult(); },
        }), error => ["CLOUD_INVALID_RESPONSE", "CLOUD_SIGN_IN_REQUIRED"].includes(error.code));
        assert.equal(local, 0); assert.equal(calls, 1);
    }
    for (const language of ["xx", "auto"]) {
        let calls = 0;
        await assert.rejects(transcribeWithProvider(blob, { provider: "ollalink", language }, {
            decodeAudio: async () => { calls++; }, cloudTranscribe: async () => { calls++; }, localTranscribe: async () => { calls++; },
        }), { code: "UNSUPPORTED_LANGUAGE" });
        assert.equal(calls, 0);
    }
});

test("WebMCP previews disclose Cloud uploads, honor shared/explicit spoken language and reject changed prepared preferences", () => {
    const descriptors = Object.fromEntries(["AudioContext", "Worker"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    globalThis.AudioContext = function () { };
    globalThis.Worker = function () { };
    const jobs = createWebMcpAiJobs(() => ({ language: "zh", assets: [{ id: "audio", type: "audio", blob, duration: 2 }] }));
    try {
        setTranscriptionPreferences({ provider: "ollalink", language: "fr" });
        const request = { kind: "transcription", assetId: "audio" };
        const cloud = jobs.prepare({ request });
        assert.equal(cloud.request.language, "fr");
        assert.equal(cloud.transcription.provider, "ollalink");
        assert.equal(cloud.uploadPolicy.uploadsAudio, true);
        assert.equal(cloud.uploadPolicy.fallback, "local-on-temporary-outage-once");
        assert.equal(jobs.prepare({ request: { ...request, language: "hi" } }).transcription.language, "hi");
        assert.throws(() => jobs.prepare({ request: { ...request, language: "ja" } }), { code: "INVALID_ARGUMENT" });
        assert.equal(jobs.capabilities().execution, "provider-dependent");
        setTranscriptionPreferences({ provider: "local", language: "es" });
        assert.throws(() => jobs.start({
            stateToken: "state", requestId: "request", request: cloud.request,
            preparedPreferences: cloud.preferenceSnapshot, allowModelDownload: true
        }), { code: "STALE_STATE" });
        const local = jobs.prepare({ request });
        assert.equal(local.transcription.provider, "local");
        assert.equal(local.request.language, "es");
        assert.equal(local.uploadPolicy.uploadsAudio, false);
        assert.equal(jobs.prepare({ request: { ...request, language: "ja" } }).transcription.language, "ja");
    } finally {
        jobs.close();
        for (const key of Object.keys(descriptors)) {
            if (descriptors[key]) Object.defineProperty(globalThis, key, descriptors[key]);
            else delete globalThis[key];
        }
    }
});
