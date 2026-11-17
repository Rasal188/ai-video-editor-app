import test from "node:test";
import assert from "node:assert/strict";
import { encodeCloudWav } from "../src/lib/cloudTranscriptionAudio.js";
import { applyDiarizationReview, proposeDiarization, validateDiarizationSource, diarizationCaptionKey, diarizationSourceKey, requestDiarization } from "../src/lib/ollalinkDiarization.js";
import { createDiarizationOperation, prepareDiarizationAudio, runDiarizationOperation } from "../src/lib/diarizationAudio.js";

// Offline unit tests only: decoder and cloud responses are mocked.
const source = { segmentId: "audio-1", track: "audio", blob: new Blob(["mock"]), start: 10, sourceStart: 2, duration: 4, playbackRate: 1 };
const result = {
    model: "nemotron-3-diarization", duration: 4, speakers: ["speaker_1", "speaker_2"], segments: [
        { start: 0, end: 2, speaker: "speaker_1" }, { start: 2, end: 4, speaker: "speaker_2" },
    ]
};
const cue = (id, start, end, extra = {}) => ({ id, start, end, text: id, audioSegmentId: "audio-1", words: [{ text: id, start, end }], style: { color: "red" }, ...extra });
const captions = [cue("a", 10.5, 11), cue("b", 12.5, 13), cue("boundary", 11.5, 12.5), cue("outside", 9, 10.5), cue("manual", 10.5, 11, { speaker: "Alice" }), cue("manual-id", 10.5, 11, { speakerId: "person-id" }), cue("unlinked", 10.5, 11, { audioSegmentId: "" })];

test("only source-linked, fully covered, unassigned cues are proposed; nothing mutated", () => {
    const before = structuredClone(captions);
    assert.deepEqual(proposeDiarization(captions, source, result), [{ id: "a", speaker: "speaker_1" }, { id: "b", speaker: "speaker_2" }]);
    assert.deepEqual(captions, before);
});
test("different-speaker overlap and gaps are not guessed; unsorted turns remain safe", () => {
    const overlap = { ...result, segments: [...result.segments, { start: 0.7, end: 1.5, speaker: "speaker_2" }] };
    assert.deepEqual(proposeDiarization(captions, source, overlap), [{ id: "b", speaker: "speaker_2" }]);
    assert.deepEqual(proposeDiarization(captions, source, { ...result, segments: [...result.segments].reverse() }), proposeDiarization(captions, source, result));
    assert.deepEqual(proposeDiarization([cue("gap", 11.8, 12.2)], source, { ...result, segments: [{ start: 0, end: 1, speaker: "speaker_1" }] }), []);
});
test("apply changes only speaker metadata and namespaces labels per request", () => {
    const proposals = proposeDiarization(captions, source, result);
    const next = applyDiarizationReview(captions, structuredClone(captions), proposals, "request-1");
    assert.equal(next[0].speaker, "ollalink:request-1:speaker_1");
    next.forEach((item, i) => {
        const { speaker: _speaker, ...rest } = item;
        const { speaker: _original, ...original } = captions[i];
        assert.deepEqual(rest, original);
    });
    assert.equal(next[4], captions[4]);
    assert.equal(next[5], captions[5]);
    assert.notEqual(applyDiarizationReview(captions, captions, proposals, "request-2")[0].speaker, next[0].speaker);
});
for (const field of ["text", "start", "end", "speaker", "speakerId", "words", "style", "audioSegmentId"]) test(`stale ${field} prevents apply`, () => {
    const edited = structuredClone(captions); edited[0][field] = field;
    assert.throws(() => applyDiarizationReview(edited, captions, [{ id: "a", speaker: "speaker_1" }], "request"), { code: "STALE" });
});
test("duplicate cue IDs and duplicate proposals rejected atomically", () => {
    assert.throws(() => proposeDiarization([captions[0], captions[0]], source, result), { code: "STALE" });
    assert.throws(() => applyDiarizationReview(captions, captions, [{ id: "a", speaker: "s" }, { id: "a", speaker: "s" }], "request"), { code: "STALE" });
});
for (const patch of [{ track: "source" }, { track: "image" }, { playbackRate: 2 }, { reversed: true }, { reversing: true }, { speedCurve: {} }, { sourceStart: -1 }, { duration: 121 }, { start: NaN }, { blob: new Blob() }, { blob: null }]) test(`unsupported source ${JSON.stringify(patch)}`, () => {
    assert.throws(() => validateDiarizationSource({ ...source, ...patch }), { code: "INVALID_AUDIO" });
});
test("source key includes selection, timeline offsets, rate and source metadata", () => {
    for (const patch of [{ start: 11 }, { sourceStart: 3 }, { duration: 3 }, { segmentId: "other" }, { playbackRate: 2 }]) assert.notEqual(diarizationSourceKey(source), diarizationSourceKey({ ...source, ...patch }));
    assert.notEqual(diarizationCaptionKey(captions), diarizationCaptionKey([...captions].reverse()));
});
test("mock decoder crops source offset and downmixes at 16 kHz; closes context", async () => {
    let closed = 0;
    class Decoder {
        constructor(options) { assert.equal(options.sampleRate, 16000); }
        async decodeAudioData() { return { sampleRate: 16000, duration: 6, length: 96000, numberOfChannels: 2, getChannelData: c => new Float32Array(96000).fill(c ? 0.5 : 0) }; }
        async close() { closed++; }
    }
    const blob = await prepareDiarizationAudio(source, { AudioContextClass: Decoder });
    assert.equal(blob.size, 128044); assert.equal(closed, 1);
    const view = new DataView(await blob.arrayBuffer());
    assert.ok(view.getInt16(44, true) > 8000);
});
test("cancel during native decode closes context and never dispatches", async () => {
    let finish, requests = 0, closed = 0;
    class Decoder {
        decodeAudioData() { return new Promise(resolve => { finish = resolve; }); }
        async close() { closed++; }
    }
    const operation = createDiarizationOperation();
    const token = operation.begin(); assert.equal(operation.begin(), null);
    const pending = runDiarizationOperation(token, source, {
        prepare: (input, options) => prepareDiarizationAudio(input, { ...options, AudioContextClass: Decoder }),
        request: () => { requests++; },
    });
    await new Promise(resolve => setImmediate(resolve));
    operation.cancel();
    await assert.rejects(pending, { code: "CANCELLED" });
    assert.equal(operation.begin(), null);
    finish({}); await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests, 0); assert.equal(closed, 1);
    assert.ok(operation.begin());
});
test("cancelled and timed-out pending requests cannot become usable results", async () => {
    const operation = createDiarizationOperation(); const token = operation.begin();
    let finish;
    const pending = runDiarizationOperation(token, source, { prepare: async () => new Blob(), request: () => new Promise(resolve => { finish = resolve; }) });
    await new Promise(resolve => setImmediate(resolve)); operation.cancel();
    await assert.rejects(pending, { code: "CANCELLED" }); finish(result);
    const keepalive = setInterval(() => { }, 100);
    try {
        await assert.rejects(runDiarizationOperation(operation.begin(), source, { prepare: () => new Promise(() => { }), request: () => { throw new Error("must not run"); }, timeoutMs: 10 }), { code: "TIMEOUT" });
    } finally { clearInterval(keepalive); }
});
test("mock browser transport success and cancelled input; local fallback never auto-dispatches", async () => {
    const wav = encodeCloudWav(new Float32Array(64000)); let calls = 0;
    const fetchImpl = async (url, options) => { calls++; assert.equal(url, "/api/diarization"); assert.equal(options.headers["X-Diarization-Request"], "1"); return Response.json(result); };
    assert.deepEqual(await requestDiarization(wav, { fetchImpl }), result);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(requestDiarization(wav, { signal: controller.signal, fetchImpl }), { code: "CANCELLED" });
    assert.equal(calls, 1);
});
