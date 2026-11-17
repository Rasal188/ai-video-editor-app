import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
// Only replace browser-only media decoding; execute the actual commit implementation
// with its real timeline/config helpers. Chromium coverage exercises real WAV decode.
const actionSource = readFileSync(new URL("../src/lib/audioTrackActions.js", import.meta.url), "utf8")
    .replace('import { decodeWaveform } from "./media.js";', `async function decodeWaveform(blob) {
    const Context = globalThis.window.AudioContext;
    if (!Context) return { duration: 0, peaks: [] };
    const context = new Context();
    try { const decoded = await context.decodeAudioData(await blob.arrayBuffer()); return { duration: decoded.duration, peaks: [] }; }
    finally { context.close(); }
  }`)
    .replace(/from "([.][^"]+)"/g, (_match, path) => `from "${new URL(path, new URL("../src/lib/audioTrackActions.js", import.meta.url)).href}"`);
const { createAudioTrackActions } = await import(`data:text/javascript;base64,${Buffer.from(actionSource).toString("base64")}`);

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
    const state = { audio: [], captions: [{ id: "caption", text: "Original", start: 2, end: 3, detachedAudioSegmentId: "old" }], history: [], mutations: 0 };
    const d = {
        script: "Local script", selectedVoiceId: "local-id", selectedVoice: { name: "Local voice" },
        audioSegments: [], audioSegmentsRef: { current: [] }, audioSegmentRefs: { current: new Map() },
        generatedVoiceEndRef: { current: 0 }, currentTimeRef: { current: 0 }, t: key => key,
    };
    for (const [setter, key] of [["setAudioSegments", "audio"], ["setCaptionSegments", "captions"], ["setHistoryItems", "history"]]) {
        d[setter] = value => { state.mutations++; state[key] = typeof value === "function" ? value(state[key]) : value; };
    }
    for (const setter of ["setSelectedAudioSegmentId", "setSelectedTrack", "setCurrentTime", "setStatus", "setStatusText", "setProgress", "setSelectedSegmentId"]) d[setter] = () => state.mutations++;
    return { state, d, actions: createAudioTrackActions(d) };
}
const blob = new Blob(["fixture"], { type: "audio/wav" });

test("batch abort and snapshot guards run after delayed decode, before ANY mutation", async () => {
    const previous = globalThis.window;
    try {
        for (const mode of ["abort", "stale"]) {
            const pending = deferred(); let decoding = false; let current = true;
            globalThis.window = {
                AudioContext: class {
                    decodeAudioData() { decoding = true; return pending.promise; }
                    close() { }
                }
            };
            const { state, d, actions } = fixture();
            const controller = new AbortController();
            const task = actions.commitAudioBatch([{ blob, script: "Cloud script" }], "Cloud", {
                captionSegment: state.captions[0], signal: controller.signal, shouldCommit: () => current,
            });
            while (!decoding) await new Promise(r => setTimeout(r, 0));
            if (mode === "abort") controller.abort(); else current = false;
            pending.resolve({ duration: 1, getChannelData: () => new Float32Array(24000) });
            await assert.rejects(task, { name: "AbortError" });
            assert.equal(state.mutations, 0);
            assert.equal(d.generatedVoiceEndRef.current, 0);
            assert.equal(state.captions[0].text, "Original");
        }
    } finally { globalThis.window = previous; }
});

test("batch keeps identical local defaults and explicit cloud identity in timeline/history", async () => {
    const previous = globalThis.window;
    globalThis.window = {};
    try {
        for (const caption of [false, true]) for (const cloud of [false, true]) {
            const { state, actions } = fixture();
            const name = "Ollalink · easton (en)";
            const options = {
                ...(caption ? { captionSegment: state.captions[0] } : {}),
                ...(cloud ? { sourceKind: "ollalink-voiceover", voiceId: "ollalink:easton", voiceName: name, name } : {}),
            };
            const [audio] = await actions.commitAudioBatch([{ blob, script: "A sentence." }], "Ready", options);
            assert.equal(audio.voiceId, cloud ? "ollalink:easton" : "local-id");
            assert.equal(audio.name, cloud ? name : "Local voice");
            assert.equal(audio.voiceName, cloud ? name : "Local voice");
            assert.equal(audio.sourceKind, cloud ? "ollalink-voiceover" : "ai-voice");
            assert.equal(state.history[0].voiceId, audio.voiceId);
            assert.equal(state.history[0].voiceName, audio.voiceName);
            assert.equal(audio.volume, 1); assert.equal(audio.playbackRate, 1);
            assert.equal(audio.cloneVoiceProfileId, "");
            assert.ok(state.captions.some(item => item.detachedAudioSegmentId === audio.id));
            if (caption) assert.equal(audio.start, 2);
        }
    } finally { globalThis.window = previous; }
});

// Execute the actual App callback with controlled refs, rather than a reimplementation.
function appBoundary(overrides = {}) {
    const source = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
    const start = source.indexOf("guardAgentAi(({ input, captionSegment, signal, shouldCommit }) => {");
    const end = source.indexOf("\n  const generateVoiceoverWhenIdle", start);
    const expression = source.slice(start, end).replace(/;\s*$/, "");
    const calls = [];
    const current = { current: { script: "Script", captionSegments: [], selectedCaptionSegment: null, trackLocks: {}, status: "ready", webMcp: { isAiRunning: () => false }, commitAudioBatch: async (_items, _text, options) => { options.signal.throwIfAborted(); assert.equal(options.shouldCommit(), true); return [{}]; }, ...overrides } };
    const owner = { current: null };
    const begin = Function("guardAgentAi", "ollalinkOwnerRef", "ollalinkCurrentRef", "setStatus", "setStatusText", "setProgress", `return (${expression});`)(
        action => (...args) => current.current.webMcp.isAiRunning() ? undefined : action(...args), owner, current,
        value => calls.push(value), () => { }, () => { },
    );
    return { begin, current, owner, calls };
}

test("App owns status, rejects duplicate/busy/locked starts and stale commits", async () => {
    for (const overrides of [{ status: "generating" }, { status: "captioning" }, { trackLocks: { audio: true } }, { trackLocks: { caption: true } }, { webMcp: { isAiRunning: () => true } }]) {
        const { begin } = appBoundary(overrides);
        assert.ok(!begin({ input: "Script", signal: new AbortController().signal, shouldCommit: () => true }));
    }
    for (const change of [s => { s.script = "Edited"; }, s => { s.captionSegments = []; }, s => { s.trackLocks = { caption: true }; }, s => { s.selectedCaptionSegment = { id: "other" }; }, s => { s.webMcp = { isAiRunning: () => true }; }, s => { s.status = "captioning"; }]) {
        const { begin, current, owner, calls } = appBoundary();
        const controller = new AbortController();
        const args = { input: "Script", signal: controller.signal, shouldCommit: () => true };
        const session = begin(args);
        assert.ok(session); assert.equal(begin(args), null);
        change(current.current);
        assert.equal(await session.commit(blob, { voice: "easton", language: "en" }), false);
        controller.abort();
        assert.equal(owner.current, null);
        if (current.current.status !== "captioning") assert.notEqual(calls.at(-1), "generating");
    }
});

test("App snapshot guard remains active through real batch decode until mutations", async () => {
    const previous = globalThis.window;
    try {
        for (const kind of ["script", "caption", "lock", "status", "agent", "signal"]) {
            const pending = deferred(); let decoding = false;
            globalThis.window = {
                AudioContext: class {
                    decodeAudioData() { decoding = true; return pending.promise; }
                    close() { }
                }
            };
            const { state, actions } = fixture();
            const { begin, current } = appBoundary({ commitAudioBatch: actions.commitAudioBatch });
            const controller = new AbortController();
            const session = begin({ input: "Script", signal: controller.signal, shouldCommit: () => true });
            const task = session.commit(blob, { voice: "easton", language: "en" });
            while (!decoding) await new Promise(resolve => setTimeout(resolve, 0));
            if (kind === "script") current.current.script = "Changed";
            if (kind === "caption") current.current.captionSegments = [{ id: "edited" }];
            if (kind === "lock") current.current.trackLocks = { caption: true };
            if (kind === "status") current.current.status = "captioning";
            if (kind === "agent") current.current.webMcp = { isAiRunning: () => true };
            if (kind === "signal") controller.abort();
            pending.resolve({ duration: 1 });
            await assert.rejects(task, { name: "AbortError" });
            assert.equal(state.mutations, 0, kind);
            session.end();
        }
    } finally { globalThis.window = previous; }
});

test("App success uses batch callback once; end cannot reset a newer owner", async () => {
    const { begin, current, calls } = appBoundary();
    const args = () => ({ input: "Script", signal: new AbortController().signal, shouldCommit: () => true });
    const first = begin(args());
    assert.equal(await first.commit(blob, { voice: "delia", language: "en" }), true);
    assert.equal(await first.commit(blob, { voice: "delia", language: "en" }), false);
    first.end(true); assert.equal(calls.at(-1), "done");
    current.current.status = "ready";
    const second = begin(args()); first.end();
    assert.equal(current.current.status, "generating");
    second.end(); assert.equal(calls.at(-1), "ready");
});

test("local generation hook and base runtime remain byte-identical to git originals", async () => {
    const { execFileSync } = await import("node:child_process");
    for (const file of ["src/hooks/useVoiceGeneration.js", "src/lib/baseVoiceSynthesis.js"]) {
        // Tracked local originals were not changed by this frontend task.
        const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
        const original = execFileSync("git", ["show", `HEAD:${file}`], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
        assert.equal(source.replaceAll("\r\n", "\n"), original.replaceAll("\r\n", "\n"));
    }
    const panel = readFileSync(new URL("../src/components/VoicePanel.jsx", import.meta.url), "utf8");
    assert.equal((panel.match(/beginOllalinkSpeech=\{beginOllalinkSpeech\}/g) || []).length, 2);
});

test("detached cloud caption preview resolves only cloud output; local result selection is unchanged", () => {
    const voicePanel = readFileSync(new URL("../src/components/VoicePanel.jsx", import.meta.url), "utf8");
    const expression = voicePanel.match(/const selectedCaptionCloudAudioSegment = ([\s\S]*?);/)[1];
    const resolve = Function("audioSegments", "selectedCaptionSegment", `return (${expression});`);
    const cloud = { id: "cloud", sourceKind: "ollalink-voiceover", blob: "cloud-blob", url: "cloud-url" };
    const local = { id: "local", sourceKind: "ai-voice", blob: "local-blob", url: "local-url" };
    assert.equal(resolve([cloud, local], { detachedAudioSegmentId: "cloud" }), cloud);
    assert.equal(resolve([cloud, local], { detachedAudioSegmentId: "local" }), null);
    assert.equal(resolve([cloud, local], null), null);
    const panel = readFileSync(new URL("../src/components/panels.jsx", import.meta.url), "utf8");
    for (const [name, field, fallback] of [["resultBlob", "blob", "audioBlob"], ["resultUrl", "url", "audioUrl"]]) {
        const expr = panel.match(new RegExp(`const ${name} = ([^;]+);`))[1];
        const select = Function("provider", "cloudAudioSegment", fallback, `return (${expr});`);
        assert.equal(select("ollalink", cloud, local[field]), cloud[field]);
        assert.equal(select("local", cloud, local[field]), local[field]);
        assert.equal(select("ollalink", null, local[field]), local[field]);
    }
});
