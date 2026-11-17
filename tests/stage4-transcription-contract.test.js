import assert from "node:assert/strict";
import { after, test } from "node:test";
import { requestCloudTranscript, transcribeWithProvider } from "../src/lib/cloudAsr.js";
import {
    attachTranscriptionErrorOutcome, attachTranscriptionOutcome, CLOUD_FALLBACK_REASON_CODES,
    createTranscriptionOutcome, getTranscriptionOutcome, preserveTranscriptionOutcome, transcriptionProviderLabel,
} from "../src/lib/transcriptionOutcome.js";

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail("Live requests are forbidden");
after(() => { globalThis.fetch = originalFetch; });
const blob = new Blob(["fixture"]);
const audio = new Float32Array(16000);
const cloudResult = (language = "en") => ({
    ok: true, provider: language === "hi" ? "ollalink-hq" : "ollalink-fast", language, duration: 1,
    output: { chunks: [{ text: "Hello", timestamp: [0.1, 0.4] }, { text: " world.", timestamp: [0.5, 0.9] }] },
});
const localResult = () => ({
    text: "Local", segments: [{
        id: "local", text: "Local", start: 0, end: 1,
        words: [{ text: "Local", start: 0, end: 1 }]
    }]
});
const coded = (code, name = "Error") => Object.assign(new Error("sensitive fixture detail"), { code, name });
const options = { provider: "ollalink", language: "en" };
function harness(overrides = {}) {
    const calls = { cloud: 0, local: 0, decode: 0 };
    const deps = {
        decodeAudio: async () => { calls.decode++; return { audio }; },
        cloudTranscribe: async (_audio, language) => { calls.cloud++; return cloudResult(language); },
        localTranscribe: async () => { calls.local++; return localResult(); },
        ...overrides,
    };
    return { calls, deps };
}
async function rejection(task) {
    let failure;
    await assert.rejects(task, (error) => { failure = error; return true; });
    return failure;
}

for (const code of [undefined, "UNKNOWN", "CLOUD_SIGN_IN_REQUIRED", "CLOUD_INVALID_REQUEST", "CLOUD_INVALID_RESPONSE",
    "CLOUD_NOT_CONFIGURED", "UNSUPPORTED_LANGUAGE", "INVALID_AUDIO", "TRANSCRIPTION_CANCELLED"]) {
    test(`Cloud rejection ${code || "uncoded"} never falls back, preserves identity and has safe outcome`, async () => {
        const failure = code ? coded(code) : new Error("sensitive fixture detail");
        const { calls, deps } = harness();
        deps.cloudTranscribe = async () => { calls.cloud++; throw failure; };
        assert.equal(await rejection(transcribeWithProvider(blob, options, deps)), failure);
        assert.equal(failure.code, code);
        const outcome = getTranscriptionOutcome(failure);
        assert.equal(outcome.status, code === "TRANSCRIPTION_CANCELLED" ? "cancelled" : "failed");
        assert.equal(outcome.requestedProvider, "ollalink");
        assert.equal(outcome.fallbackAttempted, false);
        assert.equal(outcome.fallbackReasonCode, null);
        assert.doesNotMatch(JSON.stringify(outcome), /sensitive|UNKNOWN/);
        assert.deepEqual(calls, { cloud: 1, local: 0, decode: 1 });
    });
}

test("AbortError remains cancellation even with an eligible-looking code", async () => {
    const failure = coded("CLOUD_TIMEOUT", "AbortError");
    const { calls, deps } = harness({ cloudTranscribe: async () => { throw failure; } });
    assert.equal(await rejection(transcribeWithProvider(blob, options, deps)), failure);
    assert.equal(getTranscriptionOutcome(failure).status, "cancelled");
    assert.equal(calls.local, 0);
});

for (const code of [undefined, "CLOUD_TRANSCRIPTION_FAILED", "CLOUD_TIMEOUT", "CLOUD_NETWORK_ERROR"]) {
    for (const stage of ["decode", "preparation progress", "upload progress", "caption processing", "completion progress", "fallback progress"]) {
        test(`${stage} ${code || "uncoded"} error is never fallback-eligible`, async () => {
            const failure = code ? coded(code) : new Error("sensitive processing detail");
            const { calls, deps } = harness();
            let onProgress;
            if (stage === "decode") deps.decodeAudio = async () => { calls.decode++; throw failure; };
            if (stage === "caption processing") deps.cloudTranscribe = async () => {
                calls.cloud++;
                const result = cloudResult();
                Object.defineProperty(result.output, "chunks", { get() { throw failure; } });
                return result;
            };
            const phaseMatch = {
                "preparation progress": "Preparing", "upload progress": "Transcribing with",
                "completion progress": "Captions generated", "fallback progress": "Ollalink unavailable",
            }[stage];
            if (phaseMatch) onProgress = ({ phase }) => { if (phase.startsWith(phaseMatch)) throw failure; };
            if (stage === "fallback progress") deps.cloudTranscribe = async () => { calls.cloud++; throw coded("CLOUD_TIMEOUT"); };
            assert.equal(await rejection(transcribeWithProvider(blob, { ...options, onProgress }, deps)), failure);
            const outcome = getTranscriptionOutcome(failure);
            assert.equal(outcome.status, "failed");
            assert.equal(outcome.fallbackAttempted, false);
            assert.equal(calls.local, 0);
            assert.equal(calls.cloud, ["caption processing", "completion progress", "fallback progress"].includes(stage) ? 1 : 0);
            if (calls.cloud === 0) assert.equal(outcome.provider, null);
        });
    }
}

test("uncoded real caption timing failure does not fallback", async () => {
    const { calls, deps } = harness({ cloudTranscribe: async () => ({ ...cloudResult(), output: { chunks: [] } }) });
    const failure = await rejection(transcribeWithProvider(blob, options, deps));
    assert.match(failure.message, /ASR_WORD_TIMING_UNAVAILABLE/);
    assert.equal(getTranscriptionOutcome(failure).status, "failed");
    assert.equal(calls.local, 0);
});

for (const reason of CLOUD_FALLBACK_REASON_CODES) {
    test(`${reason} allows exactly one Cloud attempt and one Local fallback`, async () => {
        const { calls, deps } = harness();
        const local = localResult();
        deps.cloudTranscribe = async () => { calls.cloud++; throw coded(reason); };
        deps.localTranscribe = async (_blob, received) => {
            calls.local++;
            assert.equal(received.requireWorker, true);
            assert.equal(received.language, "en");
            return local;
        };
        const result = await transcribeWithProvider(blob, { ...options, requireWorker: true }, deps);
        assert.deepEqual(calls, { cloud: 1, local: 1, decode: 1 });
        assert.equal(result.provider, "local-whisper");
        assert.equal(result.fallbackFrom, "ollalink");
        assert.deepEqual(result.transcriptionOutcome, {
            status: "succeeded", requestedProvider: "ollalink", provider: "local-whisper",
            fallbackAttempted: true, fallbackUsed: true, fallbackFrom: "ollalink", fallbackReasonCode: reason, reasonCode: null,
        });
        assert.deepEqual(result.segments[0].transcriptionOutcome, result.transcriptionOutcome);
        assert.equal(result.segments[0].words, local.segments[0].words);
        assert.equal(local.transcriptionOutcome, undefined);
        assert.equal(transcriptionProviderLabel(result), "Local Whisper fallback");
        assert.doesNotMatch(JSON.stringify(result.transcriptionOutcome), /sensitive/);
    });
}

test("Local fallback failure is not retried and preserves its identity/code/name", async () => {
    const failure = coded("CLOUD_TIMEOUT", "LocalFixtureError");
    const { calls, deps } = harness();
    deps.cloudTranscribe = async () => { calls.cloud++; throw coded("CLOUD_NETWORK_ERROR"); };
    deps.localTranscribe = async () => { calls.local++; throw failure; };
    assert.equal(await rejection(transcribeWithProvider(blob, options, deps)), failure);
    assert.equal(failure.name, "LocalFixtureError");
    assert.equal(failure.code, "CLOUD_TIMEOUT");
    assert.deepEqual(calls, { cloud: 1, local: 1, decode: 1 });
    const outcome = getTranscriptionOutcome(failure);
    assert.equal(outcome.status, "failed"); assert.equal(outcome.provider, "local-whisper");
    assert.equal(outcome.fallbackAttempted, true); assert.equal(outcome.fallbackUsed, false);
    assert.equal(outcome.fallbackReasonCode, "CLOUD_NETWORK_ERROR");
});

test("explicit Local preserves options, word arrays, late-event suppression and never uses Cloud", async () => {
    const controller = new AbortController(); const events = []; let callback;
    const local = localResult();
    const { calls, deps } = harness({
        localTranscribe: async (input, received) => {
            assert.equal(input, blob); assert.equal(received.signal, controller.signal);
            assert.equal(received.requireWorker, true); assert.equal(received.grouping, "words");
            assert.equal(received.language, "ja"); assert.equal(received.timelineOffset, 7);
            callback = received.onProgress; callback({ phase: "fixture", progress: 83 }); return local;
        }
    });
    const result = await transcribeWithProvider(blob, {
        provider: "local", language: "ja", requireWorker: true,
        grouping: "words", timelineOffset: 7, signal: controller.signal, onProgress: event => events.push(event)
    }, deps);
    callback({ phase: "late" });
    assert.equal(events.length, 1); assert.equal(events[0].progress, undefined);
    assert.equal(calls.decode, 0); assert.equal(calls.cloud, 0);
    assert.equal(result.segments[0].words, local.segments[0].words);
    assert.equal(result.transcriptionOutcome.requestedProvider, "local");
    assert.equal(result.transcriptionOutcome.status, "succeeded");
    assert.equal(result.transcriptionOutcome.fallbackUsed, false);
    assert.equal(transcriptionProviderLabel(result), "Local Whisper");
});

for (const language of ["en", "hi"]) test(`Cloud ${language} success attaches provenance without losing words`, async () => {
    const { calls, deps } = harness();
    const result = await transcribeWithProvider(blob, { ...options, language, timelineOffset: 7 }, deps);
    assert.equal(result.transcriptionOutcome.provider, language === "en" ? "ollalink-fast" : "ollalink-hq");
    assert.equal(result.transcriptionOutcome.status, "succeeded");
    assert.equal(result.transcriptionOutcome.fallbackUsed, false);
    assert.equal(result.segments[0].words[0].start, 7.1);
    assert.equal(result.segments[0].words[1].end, 7.9);
    assert.deepEqual(result.segments[0].transcriptionOutcome, result.transcriptionOutcome);
    assert.equal(result.segments[0].transcriptionProvider, result.provider);
    assert.equal(transcriptionProviderLabel(result), language === "en" ? "Ollalink fast" : "Ollalink HQ");
    assert.deepEqual(calls, { cloud: 1, local: 0, decode: 1 });
});

for (const provider of ["local", "ollalink"]) {
    test(`${provider} pre-cancel outcome has no actual provider and starts no work`, async () => {
        const controller = new AbortController(); controller.abort();
        const { calls, deps } = harness();
        const failure = await rejection(transcribeWithProvider(blob, { ...options, provider, signal: controller.signal }, deps));
        assert.equal(failure.name, "AbortError");
        assert.equal(getTranscriptionOutcome(failure).status, "cancelled");
        assert.equal(getTranscriptionOutcome(failure).provider, null);
        assert.equal(getTranscriptionOutcome(failure).requestedProvider, provider);
        assert.deepEqual(calls, { cloud: 0, local: 0, decode: 0 });
    });
    test(`${provider} failures preserve even frozen errors and arbitrary codes stay out of provenance`, async () => {
        const failure = Object.freeze(coded("sensitive-code", "FixtureError"));
        const { deps } = harness({ localTranscribe: async () => { throw failure; }, cloudTranscribe: async () => { throw failure; } });
        assert.equal(await rejection(transcribeWithProvider(blob, { ...options, provider }, deps)), failure);
        const outcome = getTranscriptionOutcome(failure);
        assert.equal(outcome.status, "failed"); assert.equal(outcome.reasonCode, null);
        assert.doesNotMatch(JSON.stringify(outcome), /sensitive/);
        assert.equal(failure.name, "FixtureError"); assert.equal(failure.code, "sensitive-code");
    });
}

for (const stage of ["decode", "cloud", "fallback progress", "local fallback"]) test(`cancellation during ${stage} prevents later work`, async () => {
    const controller = new AbortController();
    const { calls, deps } = harness();
    if (stage === "decode") deps.decodeAudio = async () => { calls.decode++; controller.abort(); return { audio }; };
    if (stage === "cloud") deps.cloudTranscribe = async () => { calls.cloud++; controller.abort(); return cloudResult(); };
    if (stage.includes("fallback")) deps.cloudTranscribe = async () => { calls.cloud++; throw coded("CLOUD_TIMEOUT"); };
    if (stage === "local fallback") deps.localTranscribe = async () => { calls.local++; controller.abort(); throw coded("CLOUD_TIMEOUT"); };
    const onProgress = ({ phase }) => { if (stage === "fallback progress" && phase.startsWith("Ollalink unavailable")) controller.abort(); };
    const failure = await rejection(transcribeWithProvider(blob, { ...options, signal: controller.signal, onProgress }, deps));
    assert.equal(failure.name, "AbortError");
    const outcome = getTranscriptionOutcome(failure);
    assert.equal(outcome.status, "cancelled");
    assert.equal(outcome.fallbackAttempted, stage === "local fallback");
    assert.equal(outcome.fallbackUsed, false);
    assert.equal(calls.local, stage === "local fallback" ? 1 : 0);
    assert.equal(calls.cloud, stage === "decode" ? 0 : 1);
});

test("unsupported Cloud language fails before any work with null actual provider", async () => {
    const { calls, deps } = harness();
    const failure = await rejection(transcribeWithProvider(blob, { ...options, language: "ja" }, deps));
    assert.equal(failure.code, "UNSUPPORTED_LANGUAGE");
    assert.equal(getTranscriptionOutcome(failure).provider, null);
    assert.deepEqual(calls, { cloud: 0, local: 0, decode: 0 });
});

test("provenance helpers preserve regrouped caption fields and sanitize untrusted outcome fields", () => {
    const outcome = createTranscriptionOutcome({ status: "succeeded", requestedProvider: "ollalink", provider: "ollalink-hq" });
    const captions = localResult().segments;
    const result = attachTranscriptionOutcome({ segments: captions, rawChunks: ["fixture"] }, outcome);
    const regrouped = [{ ...captions[0], text: "Reviewed" }];
    for (const source of [result, result.segments, result.segments[0], outcome]) {
        const preserved = preserveTranscriptionOutcome(regrouped, source);
        assert.deepEqual(preserved[0].transcriptionOutcome, outcome);
        assert.equal(preserved[0].words, regrouped[0].words);
        assert.equal(preserved[0].text, "Reviewed");
        assert.equal(regrouped[0].transcriptionOutcome, undefined);
    }
    const unsafe = createTranscriptionOutcome({
        provider: "secret", requestedProvider: "secret", reasonCode: "secret",
        fallbackReasonCode: "secret", fallbackFrom: "secret", message: "secret"
    });
    assert.doesNotMatch(JSON.stringify(unsafe), /secret/);
    assert.equal(getTranscriptionOutcome(new Error()), null);
    assert.equal(transcriptionProviderLabel({ provider: "secret" }), null);
    const abort = new DOMException("Cancelled", "AbortError");
    assert.equal(attachTranscriptionErrorOutcome(abort, createTranscriptionOutcome({ status: "cancelled" })), abort);
    assert.equal(getTranscriptionOutcome(abort).status, "cancelled");
});

for (const [label, fetchFailure, expected] of [
    ["browser network", new TypeError("sensitive network detail"), "CLOUD_NETWORK_ERROR"],
    ["unknown exception", new Error("sensitive unknown detail"), "CLOUD_UNKNOWN_ERROR"],
    ["misleading code", coded("CLOUD_TIMEOUT"), "CLOUD_UNKNOWN_ERROR"],
]) test(`browser adapter classifies ${label} explicitly with one attempt`, async () => {
    let fetchCalls = 0, localCalls = 0;
    const deps = {
        decodeAudio: async () => ({ audio }),
        cloudTranscribe: (value, language, opts) => requestCloudTranscript(value, language, {
            ...opts, fetchImpl: async () => { fetchCalls++; throw fetchFailure; },
        }),
        localTranscribe: async () => { localCalls++; return localResult(); },
    };
    if (expected === "CLOUD_NETWORK_ERROR") {
        const result = await transcribeWithProvider(blob, options, deps);
        assert.equal(result.transcriptionOutcome.fallbackReasonCode, expected);
        assert.equal(localCalls, 1);
    } else {
        const failure = await rejection(transcribeWithProvider(blob, options, deps));
        assert.equal(failure.code, expected); assert.equal(localCalls, 0);
        assert.doesNotMatch(failure.message, /sensitive/);
    }
    assert.equal(fetchCalls, 1);
});

for (const body of [false, true]) test(`browser deadline during ${body ? "body" : "headers"} allows one fallback`, async () => {
    let fetchCalls = 0, localCalls = 0;
    const keepAlive = setInterval(() => { }, 1000);
    try {
        const result = await transcribeWithProvider(blob, options, {
            decodeAudio: async () => ({ audio }),
            cloudTranscribe: (value, language, opts) => requestCloudTranscript(value, language, {
                ...opts, timeoutMs: 5, fetchImpl: async (_url, { signal }) => {
                    fetchCalls++;
                    const pending = () => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
                    return body ? { ok: true, json: pending } : pending();
                },
            }),
            localTranscribe: async () => { localCalls++; return localResult(); },
        });
        assert.equal(result.transcriptionOutcome.fallbackReasonCode, "CLOUD_TIMEOUT");
        assert.equal(fetchCalls, 1); assert.equal(localCalls, 1);
    } finally { clearInterval(keepAlive); }
});

for (const [status, code, expected] of [
    [401, "OLLALINK_TIMEOUT", "CLOUD_SIGN_IN_REQUIRED"], [403, "OLLALINK_PROVIDER_FAILED", "CLOUD_SIGN_IN_REQUIRED"],
    [400, "OLLALINK_PROVIDER_FAILED", "CLOUD_INVALID_REQUEST"], [503, "OLLALINK_AUTH_FAILED", "CLOUD_SIGN_IN_REQUIRED"],
    [502, "OLLALINK_INVALID_RESPONSE", "CLOUD_INVALID_RESPONSE"], [503, "OLLALINK_INVALID_REQUEST", "CLOUD_INVALID_REQUEST"],
    [503, "OLLALINK_NOT_CONFIGURED", "CLOUD_NOT_CONFIGURED"], [503, "UNSUPPORTED_LANGUAGE", "CLOUD_INVALID_REQUEST"],
    [503, "UNKNOWN", "CLOUD_UNKNOWN_ERROR"], [503, undefined, "CLOUD_UNKNOWN_ERROR"],
    [503, "TRANSCRIPTION_CANCELLED", "TRANSCRIPTION_CANCELLED"],
    [429, "OLLALINK_RATE_LIMITED", "CLOUD_TRANSCRIPTION_FAILED"], [503, "TRANSCRIPTION_BUSY", "CLOUD_TRANSCRIPTION_FAILED"],
    [502, "OLLALINK_PROVIDER_FAILED", "CLOUD_TRANSCRIPTION_FAILED"], [504, "OLLALINK_TIMEOUT", "CLOUD_TIMEOUT"],
]) test(`HTTP ${status}/${code || "unknown"} maps safely without retries`, async () => {
    let fetchCalls = 0, localCalls = 0;
    const task = transcribeWithProvider(blob, options, {
        decodeAudio: async () => ({ audio }),
        cloudTranscribe: (value, language, opts) => requestCloudTranscript(value, language, {
            ...opts, fetchImpl: async () => { fetchCalls++; return Response.json({ code, message: "sensitive detail" }, { status }); },
        }),
        localTranscribe: async () => { localCalls++; return localResult(); },
    });
    if (CLOUD_FALLBACK_REASON_CODES.includes(expected)) {
        const result = await task;
        assert.equal(result.transcriptionOutcome.fallbackReasonCode, expected);
        assert.equal(localCalls, 1);
    } else {
        const failure = await rejection(task);
        assert.equal(failure.code, expected); assert.equal(localCalls, 0);
        assert.doesNotMatch(failure.message, /sensitive/);
    }
    assert.equal(fetchCalls, 1);
});

for (const [status, expected] of [[401, "CLOUD_SIGN_IN_REQUIRED"], [403, "CLOUD_SIGN_IN_REQUIRED"],
[422, "CLOUD_INVALID_REQUEST"], [503, "CLOUD_INVALID_RESPONSE"]]) {
    test(`unreadable HTTP ${status} error body cannot authorize fallback`, async () => {
        let bodies = 0;
        const failure = await rejection(requestCloudTranscript(audio, "en", {
            fetchImpl: async () => ({
                ok: false, status, json: async () => { bodies++; throw new TypeError("sensitive transport detail"); },
            })
        }));
        assert.equal(failure.code, expected);
        assert.equal(bodies, status === 503 ? 1 : 0);
        assert.doesNotMatch(failure.message, /sensitive/);
    });
}

for (const response of [null, {}, { ok: true }]) test("malformed fetch response cannot become network fallback", async () => {
    const failure = await rejection(requestCloudTranscript(audio, "en", { fetchImpl: async () => response }));
    assert.equal(failure.code, "CLOUD_INVALID_RESPONSE");
});

for (const code of [undefined, ...CLOUD_FALLBACK_REASON_CODES]) test(`browser WAV preparation ${code || "uncoded"} failure never falls back`, async () => {
    const failure = code ? coded(code) : new Error("sensitive WAV detail");
    const invalidAudio = new (class extends Float32Array {
        get length() { throw failure; }
    })(1);
    let localCalls = 0, fetchCalls = 0;
    const thrown = await rejection(transcribeWithProvider(blob, options, {
        decodeAudio: async () => ({ audio: invalidAudio }),
        cloudTranscribe: (value, language, opts) => requestCloudTranscript(value, language, {
            ...opts, fetchImpl: async () => { fetchCalls++; assert.fail("Preparation must precede fetch"); },
        }),
        localTranscribe: async () => { localCalls++; return localResult(); },
    }));
    assert.equal(thrown, failure);
    assert.equal(getTranscriptionOutcome(thrown).provider, null);
    assert.equal(getTranscriptionOutcome(thrown).fallbackAttempted, false);
    assert.equal(localCalls, 0); assert.equal(fetchCalls, 0);
});

test("browser transport invalid audio is rejected without upload or Local inference", async () => {
    let fetchCalls = 0, localCalls = 0;
    const failure = await rejection(transcribeWithProvider(blob, options, {
        decodeAudio: async () => ({ audio: new Float32Array([NaN]) }),
        cloudTranscribe: (value, language, opts) => requestCloudTranscript(value, language, {
            ...opts, fetchImpl: async () => { fetchCalls++; },
        }),
        localTranscribe: async () => { localCalls++; },
    }));
    assert.equal(failure.code, "INVALID_AUDIO");
    assert.equal(getTranscriptionOutcome(failure).provider, null);
    assert.equal(fetchCalls, 0); assert.equal(localCalls, 0);
});

test("body transport failure on successful HTTP response is explicitly network-classified", async () => {
    const failure = await rejection(requestCloudTranscript(audio, "en", {
        fetchImpl: async () => ({
            ok: true, json: async () => { throw new TypeError("sensitive body detail"); },
        })
    }));
    assert.equal(failure.code, "CLOUD_NETWORK_ERROR");
    assert.doesNotMatch(failure.message, /sensitive/);
});

test("completion callback cancellation cannot publish a successful result", async () => {
    const controller = new AbortController();
    const { deps, calls } = harness();
    const failure = await rejection(transcribeWithProvider(blob, {
        ...options, signal: controller.signal,
        onProgress: ({ phase }) => { if (phase.startsWith("Captions generated")) controller.abort(); },
    }, deps));
    assert.equal(getTranscriptionOutcome(failure).status, "cancelled");
    assert.equal(calls.local, 0);
});

test("already-aborted Cloud rejection preserves the original AbortError identity", async () => {
    const controller = new AbortController();
    const abort = new DOMException("fixture abort", "AbortError");
    const { deps } = harness({ cloudTranscribe: async () => { controller.abort(); throw abort; } });
    assert.equal(await rejection(transcribeWithProvider(blob, { ...options, signal: controller.signal }, deps)), abort);
    assert.equal(getTranscriptionOutcome(abort).status, "cancelled");
});

for (const body of ["not-json", "{}", JSON.stringify({ ...cloudResult(), provider: "unknown" }), JSON.stringify({ ...cloudResult(), output: { chunks: [] } })]) {
    test("invalid browser response never falls back", async () => {
        let localCalls = 0, fetchCalls = 0;
        const failure = await rejection(transcribeWithProvider(blob, options, {
            decodeAudio: async () => ({ audio }),
            cloudTranscribe: (value, language, opts) => requestCloudTranscript(value, language, {
                ...opts, fetchImpl: async () => { fetchCalls++; return new Response(body); },
            }),
            localTranscribe: async () => { localCalls++; return localResult(); },
        }));
        assert.equal(failure.code, "CLOUD_INVALID_RESPONSE");
        assert.equal(localCalls, 0); assert.equal(fetchCalls, 1);
    });
}

test("browser abort identity is preserved, never sanitized into an outage", async () => {
    const abort = new DOMException("fixture abort", "AbortError");
    const failure = await rejection(requestCloudTranscript(audio, "en", { fetchImpl: async () => { throw abort; } }));
    assert.equal(failure, abort);
});

test("real shared ASR duplicate guard rejects concurrent work and releases ownership after cancel", async () => {
    const { transcribeAudioToCaptionSegments } = await import("../src/lib/asr.js");
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    let releaseDecode, startedDecode;
    const started = new Promise(resolve => { startedDecode = resolve; });
    const decoding = new Promise(resolve => { releaseDecode = resolve; });
    let contexts = 0, closed = 0;
    Object.defineProperty(globalThis, "window", {
        configurable: true, value: {
            AudioContext: class {
                constructor() { contexts++; }
                decodeAudioData() { startedDecode(); return decoding; }
                async close() { closed++; }
            }
        }
    });
    const controller = new AbortController();
    try {
        const first = transcribeAudioToCaptionSegments(blob, { ...options, signal: controller.signal });
        await started;
        const duplicate = await rejection(transcribeAudioToCaptionSegments(blob, options));
        assert.equal(duplicate.code, "EDITOR_BUSY"); assert.equal(contexts, 1);
        controller.abort();
        releaseDecode({ duration: 1, numberOfChannels: 1, getChannelData: () => audio });
        const failure = await rejection(first);
        assert.equal(getTranscriptionOutcome(failure).status, "cancelled");
        assert.equal(getTranscriptionOutcome(failure).provider, null);
        assert.equal(closed, 1);
        const afterRelease = await rejection(transcribeAudioToCaptionSegments(blob, { ...options, signal: controller.signal }));
        assert.equal(afterRelease.name, "AbortError");
        assert.notEqual(afterRelease.code, "EDITOR_BUSY");
    } finally {
        if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
        else delete globalThis.window;
    }
});
