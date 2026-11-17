import test from "node:test";
import assert from "node:assert/strict";
import { applyDiarizationReview, proposeDiarization } from "../src/lib/ollalinkDiarization.js";

// Deterministic, offline conversation; all times below are clip-relative.
// A trimmed source starts later in the file, but provider times start at zero.
const source = { segmentId: "interview", track: "audio", blob: new Blob(["fixture"]), start: 30, sourceStart: 7, duration: 18, playbackRate: 1 };
const turn = (start, end, speaker) => ({ start, end, speaker });
const result = {
    model: "nemotron-3-diarization", duration: 18, speakers: ["speaker_1", "speaker_2", "speaker_3"],
    segments: [
        turn(0, 2, "speaker_1"), turn(2, 4, "speaker_1"), // consecutive, not merged
        turn(4, 6.5, "speaker_2"), turn(7, 9, "speaker_1"), // half-second gap
        turn(9, 11, "speaker_3"), turn(10.5, 12, "speaker_2"), // crosstalk
        turn(12, 15, "speaker_2"), turn(15, 18, "speaker_1"),
    ],
};
const cue = (id, start, end, extra = {}) => ({
    id, text: id, start: 30 + start, end: 30 + end, audioSegmentId: "interview",
    words: [{ text: id, start: 30 + start, end: 30 + end }], style: { color: "#abcdef" }, ...extra,
});
const expected = (id, speaker) => ({ id, speaker });
const freeze = value => {
    if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
};

test("three-speaker multi-turn conversation preserves order, repeated labels and all non-speaker data", () => {
    const captions = freeze([
        cue("intro", 0.2, 1.8), cue("followup", 2.2, 3.8), cue("answer", 4.2, 6.2),
        cue("question", 7.2, 8.8), cue("third", 9.2, 10.4), cue("reply", 12.2, 14.8), cue("closing", 15.2, 17.8),
        cue("manual", 0.2, 1, { speaker: "Alice" }), cue("identity", 2.2, 3, { speakerId: "person-7" }),
        cue("other-clip", 4.2, 5, { audioSegmentId: "other" }), cue("unlinked", 7.2, 8, { audioSegmentId: "" }),
    ]);
    const before = structuredClone(captions), providerBefore = structuredClone(result);
    const proposals = proposeDiarization(captions, source, freeze(structuredClone(result)));
    assert.deepEqual(proposals, [
        expected("intro", "speaker_1"), expected("followup", "speaker_1"), expected("answer", "speaker_2"),
        expected("question", "speaker_1"), expected("third", "speaker_3"), expected("reply", "speaker_2"), expected("closing", "speaker_1"),
    ]);
    const applied = applyDiarizationReview(captions, before, proposals, "conversation-1");
    assert.deepEqual(applied, before.map((item, index) => index < 7 ? { ...item, speaker: `ollalink:conversation-1:${proposals[index].speaker}` } : item));
    for (let index = 7; index < captions.length; index++) assert.equal(applied[index], captions[index]);
    assert.deepEqual(captions, before);
    assert.deepEqual(result, providerBefore);
    assert.deepEqual(proposeDiarization(captions, source, { ...result, segments: [...result.segments].reverse() }), proposals);
});

test("a cue spanning consecutive same-label turns is skipped despite continuous total coverage", () => {
    const captions = [cue("spans-same-label", 1, 3), cue("left", 0, 2), cue("right", 2, 4)];
    assert.deepEqual(proposeDiarization(captions, source, result), [expected("left", "speaker_1"), expected("right", "speaker_1")]);
});

test("consecutive same-label span is eligible only when one turn independently contains it", () => {
    const captions = [cue("contained", 1, 3)];
    assert.deepEqual(proposeDiarization(captions, source, { ...result, segments: [...result.segments, turn(0, 4, "speaker_1")] }), [expected("contained", "speaker_1")]);
});

test("partial coverage, silent gaps and different-speaker crosstalk are never guessed", () => {
    const captions = [
        cue("partial-tail", 6.2, 6.8), cue("partial-head", 6.8, 7.2), cue("in-gap", 6.6, 6.9),
        cue("across-gap", 6, 7.5), cue("cross-speakers", 3.8, 4.2),
        cue("overlap", 10.6, 10.9), cue("overlap-tail", 10.4, 10.6), cue("overlap-head", 10.9, 11.2),
        cue("touch-before", 9, 10.5), cue("touch-after", 11, 12),
    ];
    assert.deepEqual(proposeDiarization(captions, source, result), [expected("touch-before", "speaker_3"), expected("touch-after", "speaker_2")]);
});

for (const [name, patch] of [
    ["missing start", { start: undefined }], ["missing end", { end: undefined }],
    ["null start", { start: null }], ["string end", { end: "31" }],
    ["nonfinite start", { start: NaN }], ["zero length", { start: 31, end: 31 }],
]) test(`invalid cue timestamp (${name}) skips only that cue`, () => {
    assert.deepEqual(proposeDiarization([cue("invalid", 0.2, 1, patch), cue("valid", 4.2, 5)], source, result), [expected("valid", "speaker_2")]);
});

for (const [name, mutate] of [
    ["missing start", data => { delete data.segments[0].start; }],
    ["missing end", data => { delete data.segments[0].end; }],
    ["unknown label", data => { data.segments[0].speaker = "speaker_99"; }],
    ["missing label", data => { delete data.segments[0].speaker; }],
    ["empty labels", data => { data.speakers = []; }],
    ["empty turns", data => { data.segments = []; }],
]) test(`invalid provider conversation (${name}) rejects atomically`, () => {
    const data = structuredClone(result), captions = [cue("first", 0.2, 1), cue("later", 12.2, 13)];
    const before = structuredClone(captions);
    mutate(data);
    assert.throws(() => proposeDiarization(captions, source, data), { code: "INVALID_RESULT" });
    assert.deepEqual(captions, before);
});

test("empty caption collection has no proposals", () => {
    assert.deepEqual(proposeDiarization([], source, result), []);
});

test("single-speaker multi-turn result still requires single-turn containment", () => {
    const data = { ...result, speakers: ["speaker_1"], segments: [turn(0, 9, "speaker_1"), turn(9, 18, "speaker_1")] };
    assert.deepEqual(proposeDiarization([cue("first", 1, 2), cue("span", 8, 10), cue("last", 17, 18)], source, data), [expected("first", "speaker_1"), expected("last", "speaker_1")]);
});
