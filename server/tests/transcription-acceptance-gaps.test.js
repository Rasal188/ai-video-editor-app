import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAutoCaptionOperationScope, captionProviderLabel } from "../../src/lib/autoCaptionOperation.js";
import { transcribeWithProvider, requestCloudTranscript } from "../../src/lib/cloudAsr.js";
import { downloadCaptionSrt } from "../../src/lib/captionSrtDownload.js";
import { serializeSrt } from "../../src/lib/subtitles.js";
import { resolveCaptionSourceMedia } from "../../src/lib/captionSourceResolver.js";

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const cloudResult = { provider: "ollalink-fast", language: "en", duration: 1, output: { chunks: [{ text: "fixture", timestamp: [0, 1] }] } };
const localResult = { segments: [{ text: "fixture", start: 0, end: 1 }] };

describe("Phase 1C cancellation and provider lifecycle", () => {
    it("invalidates cancelled, superseded and unmounted callbacks without old cleanup owning a new operation", () => {
        const scope = createAutoCaptionOperationScope();
        const first = scope.begin();
        assert.equal(scope.begin(), null);
        scope.cancel();
        assert.equal(first.signal.aborted, true);
        assert.equal(first.isCurrent(), false);
        first.finish();
        const next = scope.begin();
        first.finish();
        assert.equal(scope.active, true);
        assert.equal(next.isCurrent(), true);
        assert.equal(first.isOwner(), false);
        scope.dispose();
        assert.equal(next.signal.aborted, true);
        assert.equal(next.isOwner(), false);
        assert.equal(scope.active, false);
        assert.equal(scope.begin().isCurrent(), true); // React strict-effect remount
    });

    for (const outcome of ["resolve", "reject"]) it(`rejects cancelled late cloud ${outcome} with one request and zero local inference`, async () => {
        const controller = new AbortController();
        const pending = deferred();
        let cloudCalls = 0, localCalls = 0, observedSignal;
        const phases = [];
        const task = transcribeWithProvider(new Blob(), { provider: "ollalink", language: "en", signal: controller.signal, onProgress: event => phases.push(event) }, {
            decodeAudio: async () => ({ audio: new Float32Array(16000) }),
            cloudTranscribe: async (_a, _l, { signal }) => { cloudCalls++; observedSignal = signal; return pending.promise; },
            localTranscribe: async () => { localCalls++; return localResult; },
        });
        await Promise.resolve();
        controller.abort();
        const before = phases.length;
        pending[outcome](outcome === "resolve" ? cloudResult : new Error("fixture failure"));
        await assert.rejects(task, { name: "AbortError" });
        assert.equal(observedSignal.aborted, true);
        assert.equal(cloudCalls, 1);
        assert.equal(localCalls, 0);
        assert.equal(phases.length, before);
    });

    it("does not start decode or fallback when a progress callback cancels", async () => {
        const controller = new AbortController(); let calls = 0;
        await assert.rejects(transcribeWithProvider(new Blob(), { provider: "ollalink", language: "en", signal: controller.signal, onProgress: () => controller.abort() }, {
            decodeAudio: async () => { calls++; }, localTranscribe: async () => { calls++; },
        }), { name: "AbortError" });
        assert.equal(calls, 0);
    });

    it("labels local/fallback phases and completion; ignores post-settlement local messages", async () => {
        for (const fallback of [false, true]) {
            const events = []; let callback, calls = 0;
            const result = await transcribeWithProvider(new Blob(), { provider: fallback ? "ollalink" : "local", language: "en", onProgress: event => events.push(event) }, {
                decodeAudio: async () => ({ audio: new Float32Array(16000) }),
                cloudTranscribe: async () => { throw Object.assign(new Error("fixture outage"), { code: "CLOUD_TRANSCRIPTION_FAILED" }); },
                localTranscribe: async (_blob, options) => { calls++; callback = options.onProgress; callback({ progress: 74, phase: "Transcribing" }); return localResult; },
            });
            assert.equal(calls, 1);
            assert.equal(result.provider, "local-whisper");
            assert.match(captionProviderLabel(result), fallback ? /Local Whisper fallback/ : /^Local Whisper$/);
            assert.ok(events.some(e => e.phase.startsWith(fallback ? "Local Whisper fallback:" : "Local Whisper:")));
            assert.ok(events.every(e => e.progress === undefined));
            const before = events.length; callback({ phase: "late worker event" }); assert.equal(events.length, before);
        }
        assert.equal(captionProviderLabel(cloudResult), "Ollalink fast");
        assert.match(captionProviderLabel({ provider: "ollalink-hq" }), /Ollalink HQ/);
    });

    it("aborts source audio, video and asset fetches without consuming late bodies or selecting fallback media", async () => {
        const originalFetch = globalThis.fetch;
        try {
            for (const state of [
                { selectedTrack: "audio", audioSegments: [{ src: "https://fixture.invalid/audio" }] },
                { visualSegments: [{ type: "video", src: "https://fixture.invalid/video" }] },
                { userAssets: [{ type: "audio", src: "https://fixture.invalid/asset" }] },
            ]) {
                const controller = new AbortController();
                const pending = deferred(); let observed, bodies = 0, calls = 0;
                globalThis.fetch = (_url, { signal }) => { observed = signal; calls++; return pending.promise; };
                const task = resolveCaptionSourceMedia(state, { signal: controller.signal });
                await new Promise(resolve => setTimeout(resolve, 0));
                controller.abort();
                pending.resolve({ ok: true, blob: async () => { bodies++; return new Blob(["fixture"]); } });
                await assert.rejects(task, { name: "AbortError" });
                assert.equal(observed, controller.signal);
                assert.equal(calls, 1);
                assert.equal(bodies, 0);
            }
        } finally { globalThis.fetch = originalFetch; }
    });

    it("forwards browser abort to fetch and rejects a late JSON response", async () => {
        const controller = new AbortController(); const pending = deferred(); let observed;
        const task = requestCloudTranscript(new Float32Array(16000), "en", { signal: controller.signal, fetchImpl: async (_url, options) => { observed = options.signal; return { ok: true, json: () => pending.promise }; } });
        await new Promise(resolve => setTimeout(resolve, 0));
        controller.abort(); pending.resolve({ ok: true, ...cloudResult });
        await assert.rejects(task, { name: "AbortError" });
        assert.equal(observed.aborted, true);
    });
});

describe("Standalone edited-caption SRT download", () => {
    const captions = [{ text: "Edited sentence.\nSecond line!", start: 1.125, end: 3.5 }, { text: "Next?", start: 4, end: 5 }];
    function browser(fail = false) {
        const state = { removed: 0, revoked: 0, clicked: 0, timers: [] };
        const anchor = { remove: () => state.removed++, click: () => { state.clicked++; if (fail) throw new Error("blocked download"); } };
        return {
            state, options: {
                documentImpl: { body: { appendChild: () => { } }, createElement: () => anchor },
                urlImpl: { createObjectURL: blob => { state.blob = blob; state.anchor = anchor; return "blob:fixture"; }, revokeObjectURL: () => state.revoked++ },
                schedule: fn => state.timers.push(fn),
            }
        };
    }
    it("requests a proper MIME/filename and preserves edited text, multiline, timestamps and sequential numbering", async () => {
        const { state, options } = browser();
        assert.equal(downloadCaptionSrt(captions, 5, options), true);
        const text = await state.blob.text();
        assert.match(text, /1\r\n00:00:01,125 --> 00:00:03,500\r\nEdited sentence\.\nSecond line!/);
        assert.match(text, /2\r\n00:00:04,000 --> 00:00:05,000\r\nNext\?/);
        assert.equal(state.blob.type, "application/x-subrip;charset=utf-8");
        assert.equal(state.anchor.download, "captions.srt");
        assert.equal(state.removed, 1); state.timers[0](); assert.equal(state.revoked, 1);
        const period = [{ text: "Edited.", start: 0, end: 1 }];
        assert.notEqual(serializeSrt(period), serializeSrt(period, 0, { preserveText: true }));
    });
    it("returns empty without allocating resources", () => {
        const { state, options } = browser();
        assert.equal(downloadCaptionSrt([], 0, options), false);
        assert.equal(state.blob, undefined);
    });
    it("cleans URL and element when click fails and exposes the failure to UI", () => {
        const { state, options } = browser(true);
        assert.throws(() => downloadCaptionSrt(captions, 0, options), /blocked download/);
        assert.equal(state.revoked, 1); assert.equal(state.removed, 1); assert.equal(state.timers.length, 0);
    });
});
