import assert from "node:assert/strict";
import { after, test } from "node:test";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transcribeWithProvider } from "../src/lib/cloudAsr.js";
import { attachTranscriptionOutcome, createTranscriptionOutcome, getTranscriptionOutcome } from "../src/lib/transcriptionOutcome.js";
import { setTranscriptionPreferences } from "../src/lib/transcriptionPreferences.js";
import { workflowTranscriptionStatus } from "../src/lib/workflowTranscription.js";

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail("Live/model requests forbidden");
globalThis.document = { body: {} };
const blob = new Blob(["deterministic audio"]);
const deps = globalThis.__workflowDeps = {};
const codeUrl = (code) => `data:text/javascript,${encodeURIComponent(code)}`;
const stubs = {
    asr: codeUrl('export const transcribeAudioToCaptionSegments = (...args) => globalThis.__workflowDeps.asr(...args);'),
    media: codeUrl('export const sliceAudioBlob = async b => b; export const extractAudioFromVideo = async b => b;'),
    vad: codeUrl('export const analyzeVideoPauses = (...args) => globalThis.__workflowDeps.vad(...args);'),
    faces: codeUrl('export const sampleVideoFaceDetections = async () => ({ detections: [], supported: false });'),
    react: codeUrl('export const useState = (...a) => globalThis.__workflowHooks.useState(...a); export const useRef = (...a) => globalThis.__workflowHooks.useRef(...a); export const useEffect = () => {}; export const useMemo = f => f(); export const useCallback = f => f;'),
    portal: codeUrl('export const createPortal = children => children;'),
    css: codeUrl('export default {};'),
};
const loader = registerHooks({
    resolve(specifier, context, next) {
        const parent = context.parentURL || "";
        if (specifier === "react" && parent.includes("/src/hooks/")) return { url: stubs.react, shortCircuit: true };
        if (specifier === "react-dom" && parent.includes("/src/components/")) return { url: stubs.portal, shortCircuit: true };
        if (specifier.endsWith("/asr.js")) return { url: stubs.asr, shortCircuit: true };
        if (specifier.endsWith("/media.js")) return { url: stubs.media, shortCircuit: true };
        if (specifier.endsWith("/sileroVad.js")) return { url: stubs.vad, shortCircuit: true };
        if (specifier.endsWith("/shortsFaceDetection.js")) return { url: stubs.faces, shortCircuit: true };
        if (specifier.endsWith(".css")) return { url: stubs.css, shortCircuit: true };
        return next(specifier, context);
    },
    load(url, context, next) {
        if (url.endsWith(".jsx")) return { format: "module", source: transformSync(readFileSync(new URL(url), "utf8"), { loader: "jsx", jsx: "automatic", format: "esm" }).code, shortCircuit: true };
        return next(url, context);
    },
});
const { useRoughCut } = await import("../src/hooks/useRoughCut.js");
const { useSilenceRemoval } = await import("../src/hooks/useSilenceRemoval.js");
const { useSmartPipeline } = await import("../src/hooks/useSmartPipeline.js");
const { useShortsStudio } = await import("../src/hooks/useShortsStudio.js");
const { useAutoEdit } = await import("../src/hooks/useAutoEdit.js");
const { runAutoEditPipeline, buildAutoEditReview } = await import("../src/lib/autoEdit.js");
const { createSmartPipelinePlan, buildSmartPipelineReview } = await import("../src/lib/smartPipeline.js");
const { convertCandidateToProject } = await import("../src/lib/shortsStudio.js");
const { RoughCutPanel } = await import("../src/components/RoughCutPanel.jsx");
const { SmartPipelineModal } = await import("../src/components/SmartPipelineModal.jsx");
const { AiShortsStudioModal } = await import("../src/components/AiShortsStudioModal.jsx");
after(() => { loader.deregister(); globalThis.fetch = originalFetch; delete globalThis.__workflowDeps; delete globalThis.__workflowHooks; delete globalThis.document; });

function mount(hook, options) {
    const slots = []; const updates = []; let cursor;
    const runtime = {
        useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === "function" ? value(slots[i]) : value; updates.push(slots[i]); }]; },
        useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial }; },
    };
    return { updates, render() { cursor = 0; globalThis.__workflowHooks = runtime; return hook(options); } };
}
const t = (_key, fallback) => fallback || _key;
function fixture() {
    const clip = { id: "v1", type: "video", name: "Fixture", duration: 60, width: 1920, height: 1080, sourceStart: 0, playbackRate: 1, blob, audioBlob: blob };
    const snapshot = { visualSegments: [clip], captionSegments: [], audioSegments: [], overlaySegments: [], stickerSegments: [], trackLocks: {}, sourceAudioLinked: false };
    const notifications = [];
    const options = { selectedSegment: clip, visualSegments: [clip], projectVersion: 1, language: "de", getSnapshot: () => snapshot, getRuntime: () => ({ visualSegments: [clip] }), t, notify: text => notifications.push(text) };
    return { clip, snapshot, options, notifications };
}
const words = () => [
    { text: "Hello", start: 0.2, end: 0.8, confidence: 0.97, speaker: "speaker-1", provider: "fixture-word" },
    { text: "world.", start: 0.9, end: 1.5, confidence: 0.91, speaker: "speaker-1" },
];
function transcript(outcome) {
    return attachTranscriptionOutcome({ text: "Hello world.", rawChunks: words().map(w => ({ ...w, timestamp: [w.start, w.end] })), segments: [{ id: "cap", text: "Hello world.", start: 0.2, end: 1.5, words: words() }] }, outcome);
}
const success = (provider = "ollalink-fast", fallback = false) => createTranscriptionOutcome({ status: "succeeded", requestedProvider: fallback ? "ollalink" : provider === "local-whisper" ? "local" : "ollalink", provider, fallbackAttempted: fallback, fallbackUsed: fallback, fallbackFrom: fallback ? "ollalink" : null, fallbackReasonCode: fallback ? "CLOUD_TIMEOUT" : null });
function setup(mode = "cloud") {
    setTranscriptionPreferences({ provider: mode === "local" ? "local" : "ollalink", language: mode === "hq" ? "hi" : "en" });
    let calls = 0;
    deps.vad = async (_clip, { onProgress }) => { onProgress?.(undefined, "VAD phase"); return []; };
    deps.asr = async (input, options) => {
        calls++;
        options.onProgress?.({ phase: "ASR phase" });
        if (mode === "metadata") { options.onProgress?.({ phase: "ASR phase" }); return transcript(success("ollalink-hq")); }
        if (mode === "deferred-late") return new Promise(resolve => { deps.complete = () => resolve(transcript(success())); });
        if (mode === "deferred") return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
        return transcribeWithProvider(input, options, {
            decodeAudio: async () => ({ audio: new Float32Array(16000) }),
            cloudTranscribe: async () => {
                if (["failure", "fallback", "fallback-failure"].includes(mode)) throw Object.assign(new Error("private diagnostic"), { code: mode === "failure" ? "CLOUD_SIGN_IN_REQUIRED" : "CLOUD_TIMEOUT" });
                if (mode === "cancelled") throw new DOMException("private cancelled", "AbortError");
                return { ok: true, provider: options.language === "hi" ? "ollalink-hq" : "ollalink-fast", language: options.language, duration: 60, output: { chunks: [{ text: "Hello", timestamp: [0.2, 0.8] }, { text: " world.", timestamp: [0.9, 1.5] }] } };
            },
            localTranscribe: async () => {
                if (mode === "fallback-failure") throw new Error("private local failure");
                return transcript(success("local-whisper", mode === "fallback"));
            },
        });
    };
    return () => calls;
}
const workflows = [
    ["Rough Cut", useRoughCut, tool => tool.updateSettings({ removeFillerWords: true }), tool => tool.run(), tool => tool.draft, tool => tool.cancel()],
    ["Smart Pipeline", useSmartPipeline, () => { }, tool => tool.startAnalysis(), tool => tool.plan, tool => tool.cancel()],
    ["Shorts", useShortsStudio, tool => tool.updateSetting("autoReframing", "center"), tool => tool.startAnalysis(), tool => tool.candidates[0] || null, tool => tool.cancelAnalysis()],
    ["Auto Edit", useAutoEdit, () => { }, tool => tool.run(), tool => tool.review.metrics ? tool.review : null, tool => tool.cancel()],
];
for (const [name, hook, configure, run, result, cancel] of workflows) {
    for (const mode of ["cloud", "hq", "local", "fallback", "fallback-failure", "failure", "cancelled"]) {
        test(`${name}: real mocked dispatcher ${mode} reaches job/result without false provider success`, async () => {
            const calls = setup(mode); const { options } = fixture(); const h = mount(hook, options);
            configure(h.render()); await run(h.render()); const tool = h.render(); const outcome = getTranscriptionOutcome(tool.job);
            assert.equal(calls(), 1); assert.equal(tool.job.running, false); assert.ok(Number.isFinite(tool.job.progress));
            for (const update of h.updates) if (update && typeof update === "object" && "progress" in update) assert.ok(Number.isFinite(update.progress), `${name}: phase-only events must retain finite progress`);
            if (mode === "hq") assert.equal(outcome.provider, "ollalink-hq");
            if (mode === "local") assert.equal(outcome.provider, "local-whisper");
            assert.equal(outcome.status, ["failure", "fallback-failure"].includes(mode) ? "failed" : mode === "cancelled" ? "cancelled" : "succeeded");
            assert.equal(outcome.fallbackUsed, mode === "fallback");
            const text = workflowTranscriptionStatus(tool.job);
            assert.doesNotMatch(text, /private diagnostic|private cancelled|private local failure/);
            if (["failure", "fallback-failure", "cancelled"].includes(mode)) assert.doesNotMatch(text, /Transcript ready/);
            if (mode === "fallback-failure") { assert.equal(outcome.fallbackAttempted, true); assert.match(text, /fallback also failed/); }
            if (mode === "cancelled") assert.equal(result(tool), null);
            else { assert.ok(result(tool)); assert.deepEqual(getTranscriptionOutcome(result(tool)), outcome); }
            if (name === "Rough Cut") assert.match(renderToStaticMarkup(React.createElement(RoughCutPanel, { tool, t })), /Transcription failed|Transcription cancelled|Transcript ready/);
            if (name === "Smart Pipeline") for (const isMinimized of [false, true]) assert.match(renderToStaticMarkup(React.createElement(SmartPipelineModal, { isOpen: true, pipeline: { ...tool, isMinimized }, visualSegments: options.visualSegments, t })), /Transcription failed|Transcription cancelled|Transcript ready/);
            if (name === "Shorts") for (const isMinimized of [false, true]) assert.match(renderToStaticMarkup(React.createElement(AiShortsStudioModal, { isOpen: true, studio: { ...tool, isMinimized }, t })), /Transcription failed|Transcription cancelled|Transcript ready/);
        });
    }
    for (const cancellationMode of ["deferred", "deferred-late"]) test(`${name}: user cancellation (${cancellationMode}) retains disclosure and cannot publish late completion`, async () => {
        setup(cancellationMode); const { options } = fixture(); const h = mount(hook, options); configure(h.render());
        const task = run(h.render());
        for (let i = 0; i < 30 && !h.render().job.phase?.match(/Captions|Transcrib|speech|sentences/i); i++) await new Promise(resolve => setImmediate(resolve));
        // Await ASR entry, including dynamic media import in Rough Cut.
        for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
        cancel(h.render());
        if (cancellationMode === "deferred-late") deps.complete();
        await task; const tool = h.render();
        assert.equal(getTranscriptionOutcome(tool.job)?.status, "cancelled");
        assert.equal(result(tool), null); assert.equal(tool.job.running, false);
    });
}

test("Rough Cut: cache keys include provider/language/media window and retain fallback provenance", async () => {
    const calls = setup("fallback"); const { options, clip } = fixture(); const h = mount(useRoughCut, options);
    h.render().updateSettings({ removeFillerWords: true });
    await h.render().run(); await h.render().run(); assert.equal(calls(), 1);
    assert.equal(getTranscriptionOutcome(h.render().draft).fallbackUsed, true);
    assert.equal(getTranscriptionOutcome(h.render().draft.chunks).provider, "local-whisper");
    setTranscriptionPreferences({ provider: "local", language: "en" }); await h.render().run(); assert.equal(calls(), 2);
    setTranscriptionPreferences({ provider: "local", language: "hi" }); await h.render().run(); assert.equal(calls(), 3);
    clip.sourceStart = 2; await h.render().run(); assert.equal(calls(), 4);
    clip.blob = new Blob(["replacement"]); await h.render().run(); assert.equal(calls(), 5);
});

for (const [name, hook, configure, run, result] of workflows.slice(0, 3)) {
    test(`${name}: reused transcript keeps original provider despite current preference`, async () => {
        const calls = setup(); const { options, clip } = fixture(); const source = transcript(success("local-whisper", true));
        if (name === "Shorts") clip.captionSegments = source.segments;
        else { clip.rawChunks = source.rawChunks; clip.transcriptionOutcome = getTranscriptionOutcome(source); }
        const h = mount(hook, options); configure(h.render()); await run(h.render());
        assert.equal(calls(), 0); assert.equal(getTranscriptionOutcome(result(h.render())).provider, "local-whisper");
        assert.match(workflowTranscriptionStatus(h.render().job), /Local Whisper fallback/);
    });
}

test("Smart and Auto Edit remapping, regrouping, and atomic review preserve word metadata and provenance", async () => {
    setup("metadata"); const { options, clip, snapshot } = fixture();
    const h = mount(useSmartPipeline, options); await h.render().startAnalysis();
    h.render().updateCaptionGrouping("words"); const plan = h.render().plan;
    assert.equal(plan.captionSegments[0].words[0].confidence, 0.97);
    assert.equal(plan.captionSegments[0].words[0].speaker, "speaker-1");
    assert.equal(getTranscriptionOutcome(plan.captionSegments[0]).provider, "ollalink-hq");
    const auto = await runAutoEditPipeline({ clip, settings: { removePauses: false }, onProgress: progress => assert.ok(Number.isFinite(progress)) });
    assert.equal(auto.captions[0].words[0].confidence, 0.97);
    for (const [builder, captions] of [[buildSmartPipelineReview, plan.captionSegments], [buildAutoEditReview, auto.captions]]) {
        const review = builder({ snapshot, runtime: { visualSegments: [clip] }, clipId: clip.id, approvedCaptions: captions, includeCuts: false });
        assert.equal(review.project.captionSegments[0].words[0].confidence, 0.97);
        assert.equal(getTranscriptionOutcome(review.project.captionSegments[0]).provider, "ollalink-hq");
    }
    const chunksOnly = transcript(success("ollalink-hq")); delete chunksOnly.segments;
    const grouped = createSmartPipelinePlan({ clip, transcriptResult: chunksOnly });
    assert.equal(grouped.captionSegments[0].words[0].confidence, 0.97);
});

test("Shorts: conversion reanchors word timings without dropping provider/speaker/confidence", () => {
    const { clip } = fixture(); const source = transcript(success("ollalink-hq"));
    const candidate = { id: "short", startTime: 0.5, endTime: 20, duration: 19.5, title: "Fixture", framingMode: "center" };
    const project = convertCandidateToProject(clip, candidate, { captionSegments: source.segments, motionTypography: false, autoTransitions: false });
    assert.equal(project.captionSegments[0].words[0].start, 0);
    assert.equal(project.captionSegments[0].words[0].confidence, 0.97);
    assert.equal(project.captionSegments[0].words[0].speaker, "speaker-1");
    assert.equal(getTranscriptionOutcome(project).provider, "ollalink-hq");
    assert.equal(getTranscriptionOutcome(project.captionSegments[0]).provider, "ollalink-hq");
});

function assistantSmartFixture() {
    const first = { id: "v1", type: "video", name: "First", duration: 5, sourceStart: 0, sourceDuration: 5, playbackRate: 1, blob };
    const target = { id: "v2", type: "video", name: "Target", duration: 5, sourceStart: 0, sourceDuration: 5, playbackRate: 1, blob };
    const snapshot = {
        visualSegments: [first, target], captionSegments: [], audioSegments: [], musicSegments: [],
        visualOverlaySegments: [], stickerSegments: [], trackLocks: {}, sourceAudioLinked: false,
        musicStart: 0, musicDuration: 0,
    };
    const runtime = { visualSegments: [first, target] };
    const reviews = [];
    const options = {
        selectedSegment: first, visualSegments: runtime.visualSegments, projectVersion: 1,
        language: "en", rippleEditing: true, locked: false,
        getSnapshot: () => snapshot, getRuntime: () => runtime,
        applyReview: (review, message) => reviews.push({ review, message }),
        setRippleEditing: () => { }, seekTo: () => { }, t,
    };
    return { first, target, snapshot, runtime, reviews, options };
}

function pauseProbabilities() {
    const probabilities = new Float32Array(160);
    probabilities.fill(0.05);
    probabilities.fill(0.9, 0, 30);
    probabilities.fill(0.9, 105, 155);
    return probabilities;
}

test("Remove Pauses Assistant contract targets the requested clip and reports review/apply/dismiss states", async () => {
    const fixture = assistantSmartFixture();
    const analyzed = [];
    deps.vad = async (clip, { onProgress }) => {
        analyzed.push(clip.id);
        onProgress?.(50, "pauseDetecting");
        return pauseProbabilities();
    };
    const applied = [];
    const dismissed = [];
    const h = mount(useSilenceRemoval, fixture.options);

    const result = await h.render().run({
        clipId: fixture.target.id,
        settings: { minimum: 0.5, keep: 0.1 },
        onApplied: value => applied.push(value),
        onDismissed: () => dismissed.push(true),
    });
    assert.equal(result.status, "review-ready");
    assert.equal(result.clipId, fixture.target.id);
    assert.ok(result.candidateCount > 0);
    assert.deepEqual(analyzed, [fixture.target.id]);
    assert.equal(fixture.reviews.length, 0, "analysis must not mutate the timeline");

    fixture.options.selectedSegment = fixture.target;
    h.render().apply();
    assert.equal(fixture.reviews.length, 1);
    assert.ok(fixture.reviews[0].review.duration < 10);
    assert.deepEqual(applied, [{ clipId: fixture.target.id, candidateCount: result.candidateCount }]);

    await h.render().run({ clipId: fixture.target.id, onDismissed: () => dismissed.push(true) });
    h.render().dismiss();
    assert.deepEqual(dismissed, [true]);
});

test("AI Rough Cut Assistant contract forwards filler settings and applies only after review confirmation", async () => {
    const fixture = assistantSmartFixture();
    let asrCalls = 0;
    deps.vad = async () => pauseProbabilities();
    deps.asr = async () => {
        asrCalls++;
        return transcript(success("ollalink-fast"));
    };
    const applied = [];
    const h = mount(useRoughCut, fixture.options);
    const result = await h.render().run({
        clipId: fixture.target.id,
        settings: { removeFillerWords: true, minimum: 0.5, keep: 0.1 },
        onApplied: value => applied.push(value),
    });

    assert.equal(result.status, "review-ready");
    assert.equal(result.clipId, fixture.target.id);
    assert.ok(result.candidateCount > 0);
    assert.equal(asrCalls, 1);
    assert.equal(h.render().settings.removeFillerWords, true);
    assert.equal(fixture.reviews.length, 0, "analysis must leave the timeline unchanged");

    fixture.options.selectedSegment = fixture.target;
    h.render().apply();
    assert.equal(fixture.reviews.length, 1);
    assert.ok(fixture.reviews[0].review.duration < 10);
    assert.deepEqual(applied, [{ clipId: fixture.target.id, candidateCount: result.candidateCount }]);
});

test("Smart hook Assistant contract reports locked, unsupported, busy, cancelled, and failed analysis", async () => {
    const lockedFixture = assistantSmartFixture();
    lockedFixture.options.locked = true;
    assert.deepEqual(await mount(useSilenceRemoval, lockedFixture.options).render().run({ clipId: "v2" }), { status: "locked", code: "pauseLocked" });

    const unsupportedFixture = assistantSmartFixture();
    assert.deepEqual(await mount(useRoughCut, unsupportedFixture.options).render().run({ clipId: "missing" }), { status: "unsupported", code: "roughCutUnsupported" });

    const busyFixture = assistantSmartFixture();
    deps.vad = async (_clip, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
    const busyHook = mount(useSilenceRemoval, busyFixture.options);
    const controller = new AbortController();
    const pending = busyHook.render().run({ clipId: "v2", signal: controller.signal });
    assert.deepEqual(await busyHook.render().run({ clipId: "v2" }), { status: "busy" });
    controller.abort();
    assert.deepEqual(await pending, { status: "cancelled" });

    const failedFixture = assistantSmartFixture();
    deps.vad = async () => { throw Object.assign(new Error("private failure"), { code: "vadUnavailable" }); };
    assert.deepEqual(await mount(useSilenceRemoval, failedFixture.options).render().run({ clipId: "v2" }), { status: "failed", code: "vadUnavailable" });
});
