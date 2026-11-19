import assert from "node:assert/strict";
import { after, test } from "node:test";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { attachTranscriptionOutcome, attachTranscriptionErrorOutcome, createTranscriptionOutcome, getTranscriptionOutcome } from "../src/lib/transcriptionOutcome.js";
import { transcribeWithProvider } from "../src/lib/cloudAsr.js";
import { setTranscriptionPreferences } from "../src/lib/transcriptionPreferences.js";
import { captureAssistantBase, prepareAssistantProposal } from "../src/lib/assistantSafety.js";
import { buildBrowserOperationReview } from "../src/lib/browserEditPlan.js";
import { WEB_MCP_OPERATION_SCHEMA } from "../src/lib/webMcpOperationSchema.js";
import { applyCommandPlan } from "../src/lib/projectCommandEngine.js";

const saved = Object.fromEntries(["fetch", "AudioContext", "Worker", "document", "window"].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
globalThis.fetch = async () => assert.fail("Live/model requests forbidden");
globalThis.AudioContext = function () { };
globalThis.Worker = function () { };
globalThis.document = { body: {} };
globalThis.window = { addEventListener() { }, removeEventListener() { } };
const deps = globalThis.__editorProvenance = {};
const data = code => `data:text/javascript,${encodeURIComponent(code)}`;
const stubs = {
    react: data('export const useState=(...a)=>globalThis.__editorHooks.useState(...a); export const useRef=(...a)=>globalThis.__editorHooks.useRef(...a); export const useEffect=(...a)=>globalThis.__editorHooks.useEffect(...a); export const useMemo=f=>f(); export const useCallback=f=>f;'),
    asr: data('export const transcribeAudioToCaptionSegments=(...a)=>globalThis.__editorProvenance.asr(...a);'),
    media: data('export const sliceAudioBlob=async b=>b; export const extractAudioFromVideo=async b=>b;'),
    portal: data('export const createPortal=children=>children;'),
    exportJobs: data('export const WEB_MCP_EXPORT_SETTINGS_SCHEMA={}; export const createWebMcpExportJobs=()=>({isRunning:()=>false,close(){}});'),
    mediaSample: data('export const WEB_MCP_MEDIA_SAMPLE_SCHEMA={}; export const validateMediaSample=()=>{throw new Error("Media sampling outside transcription test scope")};'),
    css: data('export default {};'),
};
const loader = registerHooks({
    resolve(specifier, context, next) {
        const parent = context.parentURL || "";
        if (specifier === "react" && /\/(useAutoCaptions\.js|AiAssistantPanel\.jsx|TranscriptReviewModal\.jsx)$/.test(parent)) return { url: stubs.react, shortCircuit: true };
        if (specifier.endsWith("/asr.js")) return { url: stubs.asr, shortCircuit: true };
        if (specifier.endsWith("/media.js") && /\/(useAutoCaptions\.js|webMcpAiJobs\.js|captionSourceResolver\.js)$/.test(parent)) return { url: stubs.media, shortCircuit: true };
        if (specifier.endsWith("/webMcpExportJobs.js") && parent.endsWith("/webMcpEditor.js")) return { url: stubs.exportJobs, shortCircuit: true };
        if (specifier.endsWith("/webMcpMediaSample.js") && parent.endsWith("/webMcpEditor.js")) return { url: stubs.mediaSample, shortCircuit: true };
        if (specifier === "react-dom" && parent.endsWith("/TranscriptReviewModal.jsx")) return { url: stubs.portal, shortCircuit: true };
        if (specifier.endsWith(".css")) return { url: stubs.css, shortCircuit: true };
        return next(specifier, context);
    },
    load(url, context, next) {
        if (url.endsWith(".jsx")) {
            let source = readFileSync(new URL(url), "utf8");
            // Test-only exposure of real component closures; production source is unchanged.
            if (url.endsWith("/AiAssistantPanel.jsx")) {
                const anchor = "  return (\n    <aside";
                assert.ok(source.includes(anchor));
                source = source.replace(anchor, "  globalThis.__editorProvenance.assistant = { handleApplyApprovedPlan, handleRejectPlan, handleClearHistory, executionRef, messages, setMessages };\n" + anchor);
            }
            if (url.endsWith("/TranscriptReviewModal.jsx")) source = source.replace("  const firstError =", "  globalThis.__editorProvenance.review = { handleGroupingChange, handleTextChange, handleTimingChange, handleApplyClick, segments };\n  const firstError =");
            return { format: "module", source: transformSync(source, { loader: "jsx", jsx: "automatic", format: "esm" }).code, shortCircuit: true };
        }
        return next(url, context);
    },
});
const { useAutoCaptions } = await import("../src/hooks/useAutoCaptions.js");
const { AiAssistantPanel } = await import("../src/components/AiAssistantPanel.jsx");
const { TranscriptReviewModal } = await import("../src/components/TranscriptReviewModal.jsx");
const { createWebMcpAiJobs } = await import("../src/lib/webMcpAiJobs.js");
const { createWebMcpEditorSession } = await import("../src/lib/webMcpEditor.js");
after(() => {
    loader.deregister();
    for (const [key, descriptor] of Object.entries(saved)) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    delete globalThis.__editorHooks; delete globalThis.__editorProvenance;
});

function mount(component, props, effects = false) {
    const slots = []; let cursor = 0; let pending = [];
    const runtime = {
        useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
        useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial }; },
        useEffect(fn, dependencies) { const i = cursor++; if (effects && (!slots[i] || dependencies.some((v, n) => v !== slots[i][n]))) pending.push(fn); slots[i] = dependencies; },
    };
    return { render() { cursor = 0; pending = []; globalThis.__editorHooks = runtime; const result = component(props); for (const effect of pending) effect(); return result; } };
}
const blob = new Blob(["mock audio"]);
const t = (key, fallback) => fallback || ({ autoCaptionsComplete: "Generated {count} captions" }[key] || key);
const words = () => [{ text: "Hello", start: 0.2, end: 0.8, confidence: 0.97, speaker: "speaker-1", provider: "word-provider" }, { text: "world.", start: 0.9, end: 1.5, confidence: 0.91 }];
const success = (provider = "ollalink-fast", fallback = false) => createTranscriptionOutcome({ status: "succeeded", requestedProvider: provider === "local-whisper" && !fallback ? "local" : "ollalink", provider, fallbackAttempted: fallback, fallbackUsed: fallback, fallbackFrom: fallback ? "ollalink" : null, fallbackReasonCode: fallback ? "CLOUD_TIMEOUT" : null });
const transcript = outcome => attachTranscriptionOutcome({ text: "Hello world.", language: "en", duration: 2, rawChunks: words().map(w => ({ ...w, timestamp: [w.start, w.end] })), segments: [{ id: "new-caption", text: "Hello world.", start: 0.2, end: 1.5, words: words() }] }, outcome);
function setup(mode = "fast") {
    setTranscriptionPreferences({ provider: mode === "local" ? "local" : "ollalink", language: mode === "hq" ? "hi" : "en" });
    deps.calls = 0; deps.thrown = null;
    deps.asr = async (input, options) => {
        deps.calls++; deps.options = options;
        options.onProgress?.({ phase: "Transcribing", progress: 20 });
        if (mode === "deferred") return new Promise(resolve => { deps.complete = () => resolve(transcript(success())); });
        if (mode === "metadata") return transcript(success("ollalink-hq"));
        try {
            return await transcribeWithProvider(input, options, {
                decodeAudio: async () => ({ audio: new Float32Array(16000) }),
                cloudTranscribe: async () => {
                    if (["failure", "fallback", "fallback-failure"].includes(mode)) throw Object.assign(new Error("private diagnostic token"), { code: mode === "failure" ? "CLOUD_SIGN_IN_REQUIRED" : "CLOUD_TIMEOUT" });
                    if (mode === "cancelled") throw new DOMException("private cancellation", "AbortError");
                    return { ok: true, provider: mode === "hq" ? "ollalink-hq" : "ollalink-fast", language: options.language, duration: 2, output: { chunks: words().map(w => ({ ...w, timestamp: [w.start, w.end] })) } };
                },
                localTranscribe: async () => { if (mode === "fallback-failure") throw new Error("private local failure"); return transcript(success("local-whisper", mode === "fallback")); },
            });
        } catch (error) { deps.thrown = error; throw error; }
    };
}
function captionFixture() {
    const state = { captionSegments: [{ id: "old", text: "Existing", start: 3, end: 4 }], script: "Existing", trackVisibility: {} };
    const notifications = [];
    const d = { t, status: "idle", uiLanguage: "de", sourceAudioBlob: blob, notify: text => notifications.push(text), seekTo() { } };
    for (const key of ["Status", "StatusText", "Progress", "ActiveTool", "TranscriptReview", "CaptionSegments", "Script", "SelectedSegmentId", "SelectedTrack", "CaptionsEnabled", "TrackVisibility"]) {
        const field = key[0].toLowerCase() + key.slice(1);
        d[`set${key}`] = value => { state[field] = typeof value === "function" ? value(state[field]) : value; };
    }
    return { d, state, notifications };
}
const generateOptions = { probeAudio: async () => true };
for (const mode of ["fast", "hq", "local", "fallback"]) for (const delivery of ["stageOnly", "review", "apply"]) test(`shared caption hook: ${mode} ${delivery} preserves outcome and provider completion`, async () => {
    setup(mode); const { d, state } = captionFixture(); const tool = mount(useAutoCaptions, d).render();
    const result = await tool.generate({ ...generateOptions, stageOnly: delivery === "stageOnly", skipReview: delivery === "apply" });
    assert.equal(deps.calls, 1); assert.equal(deps.options.language, mode === "hq" ? "hi" : "en");
    const outcome = getTranscriptionOutcome(result);
    assert.equal(outcome.status, "succeeded"); assert.equal(outcome.fallbackUsed, mode === "fallback");
    assert.match(state.statusText, mode === "fast" ? /Ollalink fast/ : mode === "hq" ? /Ollalink HQ/ : mode === "local" ? /Local Whisper/ : /Local Whisper fallback.*CLOUD_TIMEOUT/);
    if (delivery === "apply") assert.deepEqual(getTranscriptionOutcome(state.captionSegments), outcome);
    else assert.equal(state.captionSegments[0].id, "old");
    if (delivery === "review") assert.deepEqual(getTranscriptionOutcome(state.transcriptReview), outcome);
    if (delivery === "stageOnly") assert.equal(state.transcriptReview, undefined);
});
for (const mode of ["failure", "fallback-failure", "cancelled"]) test(`shared caption hook: ${mode} preserves error identity and safe completion`, async () => {
    setup(mode); const { d, state } = captionFixture(); const tool = mount(useAutoCaptions, d).render();
    await assert.rejects(tool.generate({ ...generateOptions, stageOnly: true, throwOnError: true }), error => error === deps.thrown);
    assert.equal(getTranscriptionOutcome(deps.thrown).status, mode === "cancelled" ? "cancelled" : "failed");
    assert.match(state.statusText, mode === "cancelled" ? /cancelled/ : /failed/);
    if (mode === "fallback-failure") assert.match(state.statusText, /fallback also failed/);
    assert.doesNotMatch(state.statusText, /private|ready|complete/i); assert.equal(state.captionSegments[0].id, "old");
});
test("shared caption hook: cancel discards late success and ignores late progress", async () => {
    setup("deferred"); const { d, state } = captionFixture(); const tool = mount(useAutoCaptions, d).render();
    const task = tool.generate({ ...generateOptions, throwOnError: true });
    await until(() => deps.calls === 1); tool.cancel(); deps.complete();
    await assert.rejects(task, error => error.name === "AbortError" && getTranscriptionOutcome(error).status === "cancelled");
    const final = state.statusText; deps.options.onProgress({ phase: "late", progress: 99 });
    assert.equal(state.statusText, final); assert.match(final, /cancelled/); assert.equal(state.captionSegments[0].id, "old");
});

test("review component: regroup, text/timing edit and Apply preserve outcome and word annotations", () => {
    const result = transcript(success("local-whisper", true)); let applied;
    const props = { isOpen: true, reviewData: { ...result, timelineOffset: 0 }, onApply: value => { applied = value; }, t };
    const h = mount(TranscriptReviewModal, props, true); h.render(); h.render();
    deps.review.handleGroupingChange("words"); h.render();
    assert.equal(deps.review.segments.flatMap(s => s.words).length, 2);
    assert.equal(deps.review.segments[0].words[0].confidence, 0.97);
    assert.equal(deps.review.segments[0].words[0].speaker, "speaker-1");
    const id = deps.review.segments[0].id;
    const editedText = deps.review.segments[0].words.map((word, index) => index === 0 ? "Hi" : word.text).join(" ");
    deps.review.handleTextChange(id, editedText); h.render(); deps.review.handleTimingChange(id, "start", "0.3"); h.render();
    deps.review.handleApplyClick();
    assert.deepEqual(getTranscriptionOutcome(applied), getTranscriptionOutcome(result));
    assert.equal(applied.segments[0].words[0].confidence, 0.97); assert.equal(applied.segments[0].words[0].text, "Hi");
    deps.review.handleTextChange(id, "An entirely different longer sentence"); h.render(); deps.review.handleApplyClick();
    assert.equal(applied.segments[0].words, undefined, "incompatible manual edits must invalidate ASR word timings");
    assert.deepEqual(getTranscriptionOutcome(applied), getTranscriptionOutcome(result));
});

test("App review apply callback: preserves provenance on new captions without relabeling appended captions", () => {
    // Execute the production callback verbatim without mounting unrelated editor/media services.
    const source = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const begin = source.indexOf("  const handleApplyTranscriptReview = useCallback(");
    const end = source.indexOf("\n\n  const captionSourceState", begin);
    assert.ok(begin > 0 && end > begin);
    const { d, state } = captionFixture();
    const outcome = success("local-whisper", true);
    const bindings = {
        ...d, useCallback: fn => fn, preserveTranscriptionOutcome: attachTranscriptionOutcome,
        editorTranscriptionStatus: () => "Local Whisper fallback (CLOUD_TIMEOUT)", transcriptReview: { append: true, transcriptionOutcome: outcome }, captionStyle: {}, checkpointHistory() { }, t
    };
    const apply = Function(...Object.keys(bindings), `${source.slice(begin, end)}; return handleApplyTranscriptReview;`)(...Object.values(bindings));
    apply({ segments: transcript(outcome).segments, text: "Hello world." });
    assert.equal(state.captionSegments.find(s => s.id === "old").transcriptionOutcome, undefined);
    assert.deepEqual(getTranscriptionOutcome(state.captionSegments.find(s => s.id === "new-caption")), outcome);
    assert.equal(state.captionSegments[0].words[0].confidence, 0.97);
});
function projectFixture() {
    return { visualSegments: [], captionSegments: [], audioSegments: [], musicSegments: [], visualOverlaySegments: [], stickerSegments: [], trackLocks: {}, script: "", commandState: { schemaVersion: 1, revision: 0, appliedOperationIds: [], projectIdentity: "project-A" } };
}
function assistantSmartFixture(type, callback, params = {}) {
    let project = {
        ...projectFixture(),
        visualSegments: [
            { id: "v1", type: "video", name: "Selected", duration: 5, blob },
            { id: "v2", type: "video", name: "Target", duration: 5, blob },
        ],
    };
    const commits = []; const notices = [];
    const props = {
        getProjectSnapshot: () => project,
        onApplyPlan: async next => { commits.push(next); project = next; },
        selectedVisualSegmentId: "v1",
        notify: text => notices.push(text),
        ...(type === "tool.silence_removal" ? { onOpenSilenceRemoval: callback } : { onOpenRoughCut: callback }),
    };
    const h = mount(AiAssistantPanel, props); h.render();
    const plan = prepareAssistantProposal({ actions: [{ type, params }], explanation: type === "tool.rough_cut" ? "Create a clean rough cut" : "Remove silent gaps" }, captureAssistantBase(project), `approval-${type}`);
    deps.assistant.setMessages([{ id: "proposal", text: "Review Smart edit", plan, status: "pending" }]); h.render();
    return { h, plan, commits, notices, approve: () => deps.assistant.handleApplyApprovedPlan("proposal", plan) };
}
function assistantFixture(generator, mixed = false) {
    let project = projectFixture(); const commits = []; const notices = [];
    const props = { getProjectSnapshot: () => project, onApplyPlan: async next => { commits.push(next); project = next; }, onGenerateCaptions: generator, notify: text => notices.push(text) };
    const h = mount(AiAssistantPanel, props); h.render();
    const actions = [{ type: "tool.generate_captions", params: {} }, ...(mixed ? [{ type: "project.set_ratio", params: { ratio: "9:16" } }] : [])];
    const plan = prepareAssistantProposal({ actions, explanation: "Generate captions" }, captureAssistantBase(project), "approval-1");
    deps.assistant.setMessages([{ id: "proposal", text: "Review captions", plan, status: "pending" }]); h.render();
    return { h, plan, commits, notices, project: () => project, approve: () => deps.assistant.handleApplyApprovedPlan("proposal", plan) };
}
for (const mode of ["fast", "hq", "local", "fallback", "failure", "fallback-failure", "cancelled"]) for (const mixed of [false, true]) test(`Assistant real approval handler: ${mode}, mixed=${mixed}`, async () => {
    setup(mode); const { d, state } = captionFixture(); const tool = mount(useAutoCaptions, d).render();
    const a = assistantFixture(options => tool.generate({ ...generateOptions, ...options }), mixed);
    await a.approve(); a.h.render();
    const failed = ["failure", "fallback-failure", "cancelled"].includes(mode);
    assert.equal(a.commits.length, failed ? 0 : 1);
    assert.equal(state.captionSegments[0].id, "old", "ASR must only stage");
    assert.equal(deps.options.signal instanceof AbortSignal, true);
    const messages = deps.assistant.messages;
    const disclosure = messages.find(m => m.transcriptionOutcome);
    assert.ok(disclosure); assert.equal(disclosure.transcriptionOutcome.status, mode === "cancelled" ? "cancelled" : failed ? "failed" : "succeeded");
    assert.doesNotMatch(disclosure.text, /private/);
    if (mode === "fallback") assert.match(disclosure.text, /Local Whisper fallback.*CLOUD_TIMEOUT/);
    if (!failed) { assert.deepEqual(getTranscriptionOutcome(a.commits[0].captionSegments), disclosure.transcriptionOutcome); if (mixed) assert.equal(a.commits[0].ratioId, "9:16"); }
    await a.approve(); assert.equal(deps.calls, 1, "duplicate approval must not rerun ASR");
});
test("Assistant Smart approval opens Remove Pauses review without committing and follows apply/dismiss lifecycle", async () => {
    const requests = [];
    const a = assistantSmartFixture("tool.silence_removal", async request => {
        requests.push(request);
        return { status: "review-ready", clipId: request.clipId, candidateCount: 2 };
    }, { clipId: "v2" });

    await a.approve(); a.h.render();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].clipId, "v2");
    assert.equal(requests[0].signal instanceof AbortSignal, true);
    assert.equal(requests[0].settings, undefined);
    assert.equal(a.commits.length, 0, "analysis/review must not commit a timeline plan");
    assert.equal(deps.assistant.messages[0].status, "review-ready");
    assert.match(deps.assistant.messages[0].text, /2 candidates are ready/i);
    assert.match(deps.assistant.messages[0].text, /timeline is unchanged until you confirm Apply/i);
    assert.match(a.notices.at(-1), /2 candidates are ready/i);

    requests[0].onApplied(); a.h.render();
    assert.equal(deps.assistant.messages[0].status, "applied");
    assert.match(deps.assistant.messages[0].text, /Remove Pauses was applied to the timeline/i);

    const dismissed = assistantSmartFixture("tool.silence_removal", async request => {
        requests.push(request);
        return { status: "review-ready", clipId: request.clipId, candidateCount: 1 };
    }, { clipId: "v2" });
    await dismissed.approve(); dismissed.h.render();
    requests.at(-1).onDismissed(); dismissed.h.render();
    assert.equal(deps.assistant.messages[0].status, "rejected");
    assert.match(deps.assistant.messages[0].text, /Review dismissed\. The timeline was not changed/i);
    assert.equal(dismissed.commits.length, 0);
});

test("Assistant Smart approval forwards Rough Cut filler settings and resolved default target", async () => {
    let request;
    const a = assistantSmartFixture("tool.rough_cut", async value => {
        request = value;
        return { status: "review-ready", clipId: value.clipId, candidateCount: 0 };
    }, { removeFillerWords: true });

    await a.approve(); a.h.render();
    assert.equal(request.clipId, "v1");
    assert.equal(request.signal instanceof AbortSignal, true);
    assert.deepEqual(request.settings, { removeFillerWords: true });
    assert.equal(a.commits.length, 0);
    assert.equal(deps.assistant.messages[0].status, "review-ready");
    assert.match(deps.assistant.messages[0].text, /0 candidates are ready/i);
});

for (const status of ["cancelled", "busy", "locked", "unsupported", "failed"]) test(`Assistant Smart approval handles ${status} without timeline commits`, async () => {
    const a = assistantSmartFixture("tool.rough_cut", async () => status === "failed" ? { status, code: "vadUnavailable" } : { status });
    await a.approve(); a.h.render();

    assert.equal(a.commits.length, 0);
    if (status === "cancelled") {
        assert.equal(deps.assistant.messages[0].status, "rejected");
        assert.match(deps.assistant.messages[0].text, /analysis was cancelled.*timeline was not changed/is);
        assert.match(a.notices.at(-1), /analysis was cancelled/i);
    } else {
        assert.equal(deps.assistant.messages[0].status, "error");
        assert.equal(deps.assistant.messages.at(-1).status, "error");
        const expected = {
            busy: /analysis is already running/i,
            locked: /cannot run while the affected track is locked/i,
            unsupported: /requires a supported video clip/i,
            failed: /analysis failed/i,
        }[status];
        assert.match(deps.assistant.messages.at(-1).text, expected);
        assert.match(a.notices.at(-1), expected);
    }
});

for (const condition of ["stale", "locked", "rejected", "invalid-mixed", "changed-during-asr", "cancelled-during-asr"]) test(`Assistant approval guard unchanged: ${condition}`, async () => {
    setup(condition.includes("during") ? "deferred" : "fast");
    const a = assistantFixture(options => deps.asr(blob, options), true);
    if (condition === "stale") a.project().commandState.revision++;
    if (condition === "locked") { a.project().trackLocks.caption = true; Object.assign(a.plan, captureAssistantBase(a.project())); }
    if (condition === "rejected") deps.assistant.handleRejectPlan("proposal");
    if (condition === "invalid-mixed") a.plan.actions[1] = { id: "bad", type: "visual.delete", params: { clipId: "missing" } };
    const task = a.approve();
    if (condition.includes("during")) {
        await until(() => deps.calls === 1);
        if (condition === "changed-during-asr") a.project().commandState.revision++;
        else deps.assistant.executionRef.current.controller.abort();
        deps.complete();
    }
    await task; a.h.render(); assert.equal(a.commits.length, 0);
    assert.equal(deps.calls, condition.includes("during") ? 1 : 0);
    if (condition === "cancelled-during-asr") assert.match(deps.assistant.messages[0].text, /cancelled/);
});
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); } assert.fail("Mock operation did not settle"); }
function jobsFixture() {
    const updates = []; let id = 0;
    const jobs = createWebMcpAiJobs(() => ({ assets: [{ id: "audio", type: "audio", blob, duration: 2 }] }), { makeId: () => `job-${++id}`, onUpdate: update => updates.push(update) });
    const start = () => jobs.start({ stateToken: "state", requestId: "request", request: { kind: "transcription", assetId: "audio" }, allowModelDownload: true });
    return { jobs, start, updates };
}
for (const mode of ["fast", "hq", "local", "fallback", "failure", "fallback-failure", "cancelled", "metadata"]) test(`WebMCP job lifecycle: ${mode} retains safe outcome and compatible caption operations`, async () => {
    setup(mode); const { jobs, start, updates } = jobsFixture(); const initial = start();
    await until(() => jobs.inspect({ jobId: initial.jobId }).status !== "running");
    const job = jobs.inspect({ jobId: initial.jobId });
    const failed = ["failure", "fallback-failure", "cancelled"].includes(mode);
    assert.equal(job.status, mode === "cancelled" ? "cancelled" : failed ? "failed" : "succeeded");
    assert.equal(job.transcriptionOutcome.status, job.status); assert.equal(job.phaseKey, failed ? mode === "cancelled" ? "aiCancelled" : "aiFailed" : "aiComplete");
    assert.doesNotMatch(job.transcriptionStatus, /private/); assert.deepEqual(updates.at(-1).transcriptionOutcome, job.transcriptionOutcome);
    if (failed) { assert.equal(job.result, undefined); if (mode !== "cancelled") assert.equal(job.error.code, "AI_FAILED"); }
    else {
        assert.deepEqual(job.result.transcriptionOutcome, job.transcriptionOutcome);
        assert.deepEqual(job.result.operations[0].transcriptionOutcome, job.transcriptionOutcome);
        assert.ok(job.result.captions[0].words.length);
        const schema = WEB_MCP_OPERATION_SCHEMA.oneOf.find(entry => entry.properties.type.const === "caption.add");
        for (const operation of job.result.operations) for (const key of Object.keys(operation)) assert.ok(key in schema.properties, key);
        const review = buildBrowserOperationReview(projectFixture(), { operations: job.result.operations });
        assert.deepEqual(getTranscriptionOutcome(review.project.captionSegments), job.transcriptionOutcome);
        assert.deepEqual(review.project.captionSegments[0].words, job.result.captions[0].words);
        if (mode === "metadata") assert.equal(job.result.captions[0].words[0].confidence, 0.97);
    }
    jobs.close();
});
test("WebMCP cancellation discards late transcription success", async () => {
    setup("deferred"); const { jobs, start } = jobsFixture(); const initial = start(); await until(() => deps.calls === 1);
    jobs.cancel({ jobId: initial.jobId }); deps.complete(); await until(() => jobs.inspect({ jobId: initial.jobId }).status !== "running");
    const job = jobs.inspect({ jobId: initial.jobId }); assert.equal(job.status, "cancelled"); assert.equal(job.transcriptionOutcome.status, "cancelled"); assert.equal(job.result, undefined); jobs.close();
});
test("WebMCP fragment merge retains all words and annotations", async () => {
    setup(); deps.asr = async () => attachTranscriptionOutcome({ ...transcript(success()), segments: [{ text: "Hello", start: 0.2, end: 0.3, words: [words()[0]] }, { text: "world.", start: 0.3, end: 1.5, words: [words()[1]] }] }, success());
    const { jobs, start } = jobsFixture(); const initial = start(); await until(() => jobs.inspect({ jobId: initial.jobId }).status !== "running");
    const result = jobs.inspect({ jobId: initial.jobId }).result; assert.equal(result.captions.length, 1); assert.deepEqual(result.captions[0].words, words()); jobs.close();
});
test("caption.add compatibility: legacy inputs work; malformed additive metadata is rejected atomically", () => {
    const legacy = { type: "caption.add", clipId: "caption", text: "Hi", start: 0, end: 1 };
    assert.equal(buildBrowserOperationReview(projectFixture(), { operations: [legacy] }).project.captionSegments[0].text, "Hi");
    for (const extra of [{ words: [{ text: "bad", start: 1, end: 0 }] }, { transcriptionOutcome: { ...success(), reasonCode: "PRIVATE" } }, { transcriptionProvider: "unknown" }, { unexpected: true }]) {
        assert.throws(() => buildBrowserOperationReview(projectFixture(), { operations: [{ ...legacy, ...extra }] }));
    }
    const result = applyCommandPlan(projectFixture(), { schemaVersion: 1, baseRevision: 0, operations: [{ ...legacy, id: "op", words: [{ start: 0, end: 1 }] }] });
    assert.equal(result.ok, false);
});

test("shared caption hook: frozen transcription error retains identity", async () => {
    setup(); const error = Object.freeze(new Error("private frozen failure"));
    attachTranscriptionErrorOutcome(error, createTranscriptionOutcome({ status: "failed", requestedProvider: "ollalink", reasonCode: "TRANSCRIPTION_FAILED" }));
    deps.asr = async () => { throw error; };
    const { d, state } = captionFixture(); const tool = mount(useAutoCaptions, d).render();
    await assert.rejects(tool.generate({ ...generateOptions, throwOnError: true }), actual => actual === error);
    assert.match(state.statusText, /Transcription failed/); assert.doesNotMatch(state.statusText, /private/);
});

for (const mode of ["metadata", "fallback-failure", "deferred"]) test(`WebMCP public session: ${mode} prepare/start/inspect and caption preview/apply`, async () => {
    setup(mode); let project = projectFixture(); let id = 0; let commits = 0;
    const editor = {
        t, assets: [{ id: "audio", type: "audio", blob, duration: 2 }], duration: 2, currentTime: 0,
        getProjectSnapshot: () => project, applyReview(review) { commits++; project = review.project; }
    };
    const session = createWebMcpEditorSession(() => editor, { makeId: () => `session-${++id}` });
    const state = await session.run("timeline_project_inspect"); assert.equal(state.ok, true);
    const prepared = await session.run("timeline_ai_prepare", { stateToken: state.stateToken, request: { kind: "transcription", assetId: "audio" } }); assert.equal(prepared.ok, true);
    const input = { aiId: prepared.aiId, requestId: "session-request", allowModelDownload: true };
    const started = await session.run("timeline_ai_start", input); assert.equal(started.ok, true);
    if (mode === "deferred") {
        await until(() => deps.calls === 1);
        const cancelled = await session.run("timeline_ai_cancel", { jobId: started.jobId }); assert.equal(cancelled.ok, true);
        deps.complete();
    }
    await until(() => !session.isAiRunning());
    const job = await session.run("timeline_ai_inspect", { jobId: started.jobId }); assert.equal(job.ok, true);
    assert.equal(job.transcriptionOutcome.status, mode === "metadata" ? "succeeded" : mode === "deferred" ? "cancelled" : "failed");
    const duplicate = await session.run("timeline_ai_start", input); assert.equal(duplicate.alreadyStarted, true); assert.equal(deps.calls, 1);
    assert.equal(commits, 0, "transcription never inserts captions without preview/apply");
    if (mode === "metadata") {
        const current = await session.run("timeline_project_inspect");
        const preview = await session.run("timeline_edit_preview", { stateToken: current.stateToken, operations: job.result.operations }); assert.equal(preview.ok, true);
        const applied = await session.run("timeline_edit_apply", { previewId: preview.previewId }); assert.equal(applied.ok, true);
        assert.equal(commits, 1); assert.equal(project.captionSegments[0].words[0].confidence, 0.97);
        assert.deepEqual(getTranscriptionOutcome(project.captionSegments), job.transcriptionOutcome);
        const again = await session.run("timeline_edit_apply", { previewId: preview.previewId }); assert.equal(again.alreadyApplied, true); assert.equal(commits, 1);
    } else { assert.equal(job.result, undefined); assert.doesNotMatch(job.transcriptionStatus, /private/); }
    session.close();
});
