import { after, test } from "node:test";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";
import { createProjectArchive, readProjectArchive } from "../../src/lib/projectArchive.js";
import { encodeCloudWav } from "../../src/lib/cloudTranscriptionAudio.js";
import { proposeDiarization, applyDiarizationReview } from "../../src/lib/ollalinkDiarization.js";
import { serializeSrt, parseSrt } from "../../src/lib/subtitles.js";
import { materializeProjectCaptionTimings, inspectClip, inspectTranscript } from "../../src/lib/projectCommandEngine.js";
import { buildFfmpegRenderPlan } from "../../src/lib/projectRenderPlan.js";
import { buildShortExportSpec } from "../../src/lib/shortsStudio.js";
import {
    CANONICAL_TRACK_IDS, SUPPORTED_TIMELINE_EXPORT_FORMATS, packageEditableShortTimeline,
    serializeTimelineToNativeProject, deserializeNativeProjectToTimeline,
    exportTimelineToOtio, deserializeOtioToTimeline, createTimelinePackageZipBlob,
} from "../../src/lib/shortsTimelinePackaging.js";

// Pure production contract tests: fail any accidental network dispatch.
const fetchBefore = globalThis.fetch;
const requests = [];
globalThis.fetch = async url => { requests.push(String(url)); throw new Error("Network forbidden in persistence/export tests"); };
after(() => { globalThis.fetch = fetchBefore; assert.deepEqual(requests, []); });

const wav = encodeCloudWav(new Float32Array(96000));
const audio = { id: "audio-1", name: "fixture.wav", blob: wav, start: 10, sourceStart: 1, duration: 4, sourceDuration: 4, playbackRate: 1, volume: 0.7 };
const source = { segmentId: audio.id, track: "audio", blob: wav, start: 10, sourceStart: 1, duration: 4, playbackRate: 1 };
const captions = [
    { id: "a", text: "First speaker!", start: 10.5, end: 11.5, audioSegmentId: audio.id, fontId: "default", words: [{ text: "First", start: 10.5, end: 11 }, { text: "speaker!", start: 11, end: 11.5 }] },
    { id: "b", text: "Second speaker?", start: 12.5, end: 13.5, audioSegmentId: audio.id, fontId: "default" },
    { id: "manual", text: "Manual label.", start: 11, end: 11.5, audioSegmentId: audio.id, speaker: "Alice", speakerId: "manual-alice", fontId: "default" },
];
const result = { model: "nemotron-3-diarization", duration: 4, speakers: ["speaker_1", "speaker_2"], segments: [{ start: 0, end: 2, speaker: "speaker_1" }, { start: 2, end: 4, speaker: "speaker_2" }] };
const applied = applyDiarizationReview(captions, structuredClone(captions), proposeDiarization(captions, source, result), "persistence-request");
const { blob: _audioBlob, ...audioMetadata } = audio;
const project = { script: "Acceptance", captionSegments: applied, audioDuration: 14, visualSegments: [], audioSegments: [audioMetadata], captionStyle: { fontId: "default" }, captionSize: 22, captionsEnabled: true };
const shortSource = { id: "video-1", type: "video", name: "fixture.mp4", src: "fixture.mp4", width: 640, height: 360, duration: 20 };
const candidate = { id: "short-1", title: "Fixture", startTime: 10, endTime: 14, duration: 4, framingMode: "center" };
const shortOptions = { captionSegments: applied, autoReframing: "center", motionTypography: false, overlays: false, autoTransitions: false };
const subtitleClips = timeline => timeline.tracks.find(track => track.id === CANONICAL_TRACK_IDS.SUBTITLES).clips;
const cueFields = cues => cues.map(({ text, start, end, speaker, speakerId }) => ({ text, start, end, speaker, speakerId }));
const relative = applied.map(cue => ({ ...cue, start: cue.start - 10, end: cue.end - 10 }));

async function roundtrip(captionSegments) {
    const blob = await createProjectArchive({ project: { ...project, captionSegments }, audioSegments: [audio] });
    return readProjectArchive(blob);
}

test("production apply/archive v3 retains namespaced labels, manual speakerId, words, WAV bytes and placement", async () => {
    const before = structuredClone(project);
    const archive = await roundtrip(applied);
    assert.equal(archive.payload.version, 3);
    assert.deepEqual(archive.payload.project.captionSegments, applied);
    assert.deepEqual(archive.payload.project.audioSegments, project.audioSegments);
    assert.deepEqual(new Uint8Array(await archive.audioSegmentMedia.get(audio.id).blob.arrayBuffer()), new Uint8Array(await wav.arrayBuffer()));
    assert.deepEqual(project, before);
    assert.equal(applied[0].speaker, "ollalink:persistence-request:speaker_1");
    assert.equal(applied[1].speaker, "ollalink:persistence-request:speaker_2");
    assert.deepEqual(applied[2], captions[2]);
});

test("legacy speaker-free captions remain speaker-free through archive", async () => {
    const legacy = captions.map(({ speaker, speakerId, ...cue }) => cue);
    const archive = await roundtrip(legacy);
    assert.deepEqual(archive.payload.project.captionSegments, legacy);
    assert.ok(archive.payload.project.captionSegments.every(cue => !Object.hasOwn(cue, "speaker") && !Object.hasOwn(cue, "speakerId")));
});

test("opaque malformed metadata is preserved, not silently normalized or interpolated into SRT", async () => {
    for (const value of [null, 42, {}, ["bad"], "<img src=x onerror=alert(1)>\u0000"]) {
        const cues = [{ ...captions[0], speaker: value, speakerId: { opaque: true } }];
        assert.deepEqual((await roundtrip(cues)).payload.project.captionSegments, cues);
        assert.equal(serializeSrt(cues, 14, { preserveText: true }), serializeSrt([{ ...captions[0] }], 14, { preserveText: true }));
    }
});

test("SRT standalone preserveText and video-export display mode are metadata-independent with exact cue times", () => {
    for (const options of [{ preserveText: true }, {}]) {
        const srt = serializeSrt(applied, 14, options);
        assert.equal(srt, serializeSrt(captions, 14, options));
        assert.doesNotMatch(srt, /ollalink:|speaker_[12]|Alice|manual-alice/);
        const parsed = parseSrt(srt);
        assert.equal(parsed.skipped, 0);
        assert.deepEqual(parsed.captions.map(({ start, end }) => ({ start, end })), [...applied].sort((a, b) => a.start - b.start || a.end - b.end).map(({ start, end }) => ({ start, end })));
        if (options.preserveText) assert.deepEqual(parsed.captions.map(cue => cue.text), ["First speaker!", "Manual label.", "Second speaker?"]);
    }
});

test("project command materialization and JSON inspection preserve speaker fields without changing transcript text/times", () => {
    const materialized = materializeProjectCaptionTimings(project);
    assert.deepEqual(materialized.captionSegments, applied);
    const transcript = JSON.parse(JSON.stringify(inspectTranscript(project, audio.id)));
    assert.equal(transcript.text, "First speaker!\nManual label.\nSecond speaker?");
    assert.deepEqual(transcript.segments.map(({ id, text, start, end, speaker }) => ({ id, text, start, end, speaker })), [...applied].sort((a, b) => a.start - b.start).map(({ id, text, start, end, speaker }) => ({ id, text, start, end, speaker })));
    assert.equal(inspectClip(project, "manual").properties.speakerId, "manual-alice");
});

test("Shorts render-spec JSON preserves labels with deliberate trim-relative cue/word timestamps, no text prefixes", () => {
    const before = structuredClone(shortOptions);
    const spec = JSON.parse(JSON.stringify(buildShortExportSpec(shortSource, candidate, shortOptions)));
    assert.deepEqual(cueFields(spec.project.captionSegments), cueFields(relative));
    assert.deepEqual(spec.project.captionSegments[0].words.map(({ start, end }) => ({ start, end })), [{ start: 0.5, end: 1 }, { start: 1, end: 1.5 }]);
    assert.deepEqual(shortOptions, before);
});

test("Shorts canonical/native/OTIO packaging retains anonymous and manual speaker metadata", () => {
    const pkg = packageEditableShortTimeline(shortSource, candidate, shortOptions);
    assert.deepEqual(cueFields(subtitleClips(pkg.timeline)), cueFields(relative));
    assert.deepEqual(cueFields(pkg.nativeProject.project.captionSegments), cueFields(relative));
    assert.deepEqual(cueFields(pkg.otio.metadata.ai_shorts_studio.captions), cueFields(relative));
    const nativeRoundtrip = deserializeNativeProjectToTimeline(JSON.parse(JSON.stringify(pkg.nativeProject)));
    assert.deepEqual(cueFields(subtitleClips(nativeRoundtrip)), cueFields(relative));
    assert.deepEqual(cueFields(serializeTimelineToNativeProject(nativeRoundtrip).project.captionSegments), cueFields(relative));
    const otioRoundtrip = deserializeOtioToTimeline(JSON.parse(JSON.stringify(exportTimelineToOtio(pkg.timeline))));
    assert.deepEqual(cueFields(subtitleClips(otioRoundtrip)), cueFields(relative));
});

test("Shorts legacy packaging adds no optional speaker keys; metadata is opaque when present", () => {
    const legacy = captions.map(({ speaker, speakerId, ...cue }) => cue);
    const pkg = packageEditableShortTimeline(shortSource, candidate, { ...shortOptions, captionSegments: legacy });
    for (const cue of [...subtitleClips(pkg.timeline), ...pkg.nativeProject.project.captionSegments]) {
        assert.equal(Object.hasOwn(cue, "speaker"), false);
        assert.equal(Object.hasOwn(cue, "speakerId"), false);
    }
    const opaque = [{ ...captions[0], speaker: { unexpected: true }, speakerId: null }];
    const opaquePkg = packageEditableShortTimeline(shortSource, candidate, { ...shortOptions, captionSegments: opaque });
    assert.deepEqual(opaquePkg.nativeProject.project.captionSegments[0].speaker, opaque[0].speaker);
    assert.equal(opaquePkg.nativeProject.project.captionSegments[0].speakerId, null);
});

test("actual editable package ZIP includes native JSON/OTIO/FCPXML, preserving labels only as metadata", async () => {
    const pkg = packageEditableShortTimeline(shortSource, candidate, shortOptions);
    const zip = unzipSync(new Uint8Array(await (await createTimelinePackageZipBlob(pkg)).arrayBuffer()));
    assert.ok(zip["project.json"] && zip["timeline.otio"] && zip["timeline.fcpxml"] && zip["manifest.json"]);
    assert.deepEqual(cueFields(JSON.parse(strFromU8(zip["project.json"])).project.captionSegments), cueFields(relative));
    assert.deepEqual(cueFields(JSON.parse(strFromU8(zip["timeline.otio"])).metadata.ai_shorts_studio.captions), cueFields(relative));
    const xml = strFromU8(zip["timeline.fcpxml"]);
    for (const cue of applied) assert.ok(xml.includes(cue.text));
    assert.match(xml, /offset="15\/30s" duration="30\/30s"/);
    assert.doesNotMatch(xml, /ollalink:|speaker_[12]|Alice|manual-alice/);
    assert.deepEqual(Object.values(SUPPORTED_TIMELINE_EXPORT_FORMATS), ["native", "otio", "fcpxml"]);
});

test("headless render command serialization ignores speaker metadata, preserving text and drawtext time gates", () => {
    const visuals = [{ id: "image", type: "image", duration: 14, sourceStart: 0, width: 640, height: 360 }];
    const argsFor = cues => buildFfmpegRenderPlan({
        project: { ...project, visualSegments: visuals, audioSegments: [], captionSegments: cues },
        media: { visuals: [{ id: "image", path: "media/fixture.png" }] },
        extractedFiles: new Map([["media/fixture.png", "fixture.png"]]),
        mediaProbes: new Map([["media/fixture.png", { width: 640, height: 360, hasAudio: false }]]),
        settings: { captions: "burned", fontFile: "fixture-font.ttf" },
    }).args;
    const args = argsFor(applied);
    assert.deepEqual(args, argsFor(captions));
    const command = JSON.stringify(args);
    assert.match(command, /First speaker!/);
    assert.match(command, /between\(t,10\.500,11\.500\)/);
    assert.doesNotMatch(command, /ollalink:|speaker_[12]|Alice|manual-alice/);
});
