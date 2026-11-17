import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { createProjectArchive } from "../src/lib/projectArchive.js";

// Real App/import/panel/caption hook/command reducer/commit callback. Only service
// boundaries are mocked. Deliberately abort-insensitive mocks prove ownership,
// rather than relying on transport abort behavior. No model or backend is run.
const evidence = await fs.mkdtemp(path.resolve("scratch/assistant-stage1-20261030/editor-"));
const report = { mocked: true, fullEditor: true, liveCalls: 0, checks: [], externalAttempts: [], unexpected: [], pageErrors: [] };
let browser;
let vite;
let page;
const originalFetch = globalThis.fetch;
globalThis.fetch = async input => { throw new Error(`Network forbidden: ${String(input)}`); };
try {
    const wav = Buffer.alloc(44 + 32000 * 4);
    wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
    const audioBlob = new Blob([wav], { type: "audio/wav" });
    const imageBlob = new Blob([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=", "base64")], { type: "image/png" });
    const project = {
        script: "Original captions", selectedVoiceId: "", speed: 1, volume: 1,
        ratioId: "16:9", fitMode: "contain", captionPosition: "bottom", captionPlacement: { x: 50, y: 78 }, captionSize: 22,
        captionStyle: { fontId: "default" }, captionStylePresetId: "classic", captionStylePresets: [], captionsEnabled: true,
        captionSegments: [{ id: "c1", text: "Original captions", start: 0, end: 2, fontId: "default" }],
        visualSegments: [{ id: "v1", name: "Opening", type: "image", duration: 4, width: 1, height: 1 }, { id: "v2", name: "Closing", type: "image", duration: 4, width: 1, height: 1 }],
        audioSegments: [{ id: "a1", name: "local.wav", start: 0, sourceStart: 0, sourceDuration: 4, duration: 4, volume: 1 }],
        musicSegments: [], visualOverlaySegments: [], stickerSegments: [], timelineMarkers: [], trackLocks: {}, trackVisibility: {}, timelineZoom: 1, audioDuration: 4, musicVolume: 0.35, sourceAudioVolume: 1,
    };
    const archive = await createProjectArchive({ project, visualSegments: project.visualSegments.map(item => ({ ...item, blob: imageBlob })), audioSegments: project.audioSegments.map(item => ({ ...item, blob: audioBlob })) });
    const fixture = Buffer.from(await archive.arrayBuffer());
    vite = await createServer({
        configFile: false, envFile: false, cacheDir: path.join(evidence, "vite-cache"),
        plugins: [react(), {
            name: "assistant-safety-local-services",
            transform(code, id) {
                const file = id.replaceAll("\\", "/");
                if (file.endsWith("/src/hooks/useEditorCatalog.js")) return code.replace("https://commons.wikimedia.org/w/api.php?", "/__catalog/commons?").replace("https://api.pexels.com/v1/", "/__catalog/pexels/").replace("https://api.openverse.org/v1/audio/?", "/__catalog/audio?");
                if (file.endsWith("/src/lib/asr.js")) return code.replace("export async function transcribeAudioToCaptionSegments(", "async function unusedRealTranscription(") + "\nexport async function transcribeAudioToCaptionSegments(blob, options) { return window.__safetyTranscribe(blob, options); }\n";
            },
            configureServer(server) {
                server.middlewares.use("/assistant-safety", async (_req, res) => {
                    res.setHeader("Content-Type", "text/html");
                    res.end(await server.transformIndexHtml("/assistant-safety", '<div id="root"></div><script type="module" src="/tests/assistant-stage1-editor-harness.jsx"></script>'));
                });
            },
        }],
        server: { host: "127.0.0.1", port: 0, hmr: false, warmup: { clientFiles: [] }, watch: { ignored: ["**/scratch/**"] } },
    });
    await vite.listen();
    const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, args: ["--disable-background-networking", "--disable-component-update", "--no-default-browser-check"] });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block" });
    await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) { report.externalAttempts.push(url.href); return route.abort("blockedbyclient"); }
        if (url.pathname === "/__stage1_fixture.timeline") return route.fulfill({ body: fixture, contentType: "application/zip" });
        if (url.pathname.startsWith("/__catalog/")) return route.fulfill({ json: { query: { pages: {} }, results: [], photos: [], videos: [] } });
        if (url.pathname.startsWith("/api/") || (/\.(onnx|wasm|safetensors|bin)$/i.test(url.pathname) && !url.searchParams.has("url"))) { report.unexpected.push(url.href); return route.abort("blockedbyclient"); }
        return route.continue();
    });
    await context.addInitScript(() => {
        localStorage.setItem("ai-voiceover-ui-language", "en");
        localStorage.setItem("timeline_studio_first_visual_guide_seen", "1");
        window.__plans = [];
        window.__asr = [];
        const nativeFetch = window.fetch;
        window.fetch = (input, options) => {
            if (input === "/api/assistant/plan") return new Promise((resolve, reject) => window.__plans.push({ body: JSON.parse(options.body), signal: options.signal, resolve: data => resolve(new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } })), reject }));
            return nativeFetch(input, options);
        };
        window.__safetyTranscribe = (blob, options) => new Promise((resolve, reject) => window.__asr.push({ blobSize: blob.size, options, resolve, reject }));
    });
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on("pageerror", error => report.pageErrors.push(error.stack || error.message));
    const snapshot = async () => {
        const handle = await page.waitForFunction(() => window.__PROJECT_SNAPSHOT__?.() || false);
        try { return await handle.jsonValue(); } finally { await handle.dispose(); }
    };
    const input = () => page.getByTestId("ai-assistant-prompt-input");
    const apply = () => page.getByTestId("ai-assistant-apply-btn").last();
    const clear = async () => { const button = page.getByRole("button", { name: "Clear Conversation", exact: true }); if (await button.count()) await button.click(); };
    const send = async (text = "Set project aspect ratio to 9:16") => { await input().fill(text); await page.getByTestId("ai-assistant-generate-btn").click(); };
    const planResponse = async (index, actions, explanation = "Safety test proposal") => page.evaluate(({ index, actions, explanation }) => window.__plans[index].resolve({ plan: { schemaVersion: 1, explanation, actions } }), { index, actions, explanation });
    const propose = async actions => {
        const index = await page.evaluate(() => window.__plans.length);
        await send();
        await page.waitForFunction(index => window.__plans.length > index, index);
        await planResponse(index, actions);
        await apply().waitFor();
    };
    const waitFinished = async () => { await page.waitForFunction(() => !document.querySelector('[data-testid="ai-assistant-prompt-input"]').disabled); await page.waitForTimeout(80); };
    const reset = async () => {
        await page.goto(`${origin}/assistant-safety`, { waitUntil: "domcontentloaded", timeout: 90000 });
        await page.locator(".editor-grid").waitFor({ timeout: 90000 });
        await page.waitForFunction(() => window.__PROJECT_SNAPSHOT__?.().visualSegments.length === 2, null, { timeout: 60000 });
        await page.locator(".project-import-overlay").waitFor({ state: "hidden" });
        await snapshot();
        await page.evaluate(() => window.dispatchEvent(new Event("test:open-ai-assistant")));
        await input().waitFor();
    };
    const unchanged = async before => assert.deepEqual(await snapshot(), before);
    const marker = title => ({ type: "marker.add", params: { time: 1, title } });
    await reset();
    const original = await snapshot();
    await propose([marker("one only")]);
    await apply().evaluate(button => { button.click(); button.click(); });
    await waitFinished();
    let current = await snapshot();
    assert.equal(current.timelineMarkers.filter(item => item.title === "one only").length, 1);
    assert.equal(current.commandState.appliedOperationIds.length, 1);
    assert.match(current.commandState.appliedOperationIds[0], /^assistant-.+-op-0$/);
    report.checks.push("real panel same-render double approval commits marker and stable operation ledger once");
    await clear();
    await propose([marker("must be stale")]);
    await send("undo");
    await page.waitForFunction(revision => window.__PROJECT_SNAPSHOT__().commandState.revision > revision, current.commandState.revision);
    const undone = await snapshot();
    await apply().click(); await waitFinished();
    await unchanged(undone);
    assert.ok((await page.getByTestId("ai-assistant-panel").innerText()).includes("changed since planning"));
    await clear(); await send("redo"); await page.waitForTimeout(150);
    assert.equal((await snapshot()).timelineMarkers.length, 1);
    report.checks.push("real editor undo/redo advances revision; approval after undo is rejected without changes");

    await reset();
    await page.evaluate(async () => {
        const { captureAssistantBase, prepareAssistantProposal } = await import("/src/lib/assistantSafety.js");
        const { applyCommandPlan } = await import("/src/lib/projectCommandEngine.js");
        const before = window.__PROJECT_SNAPSHOT__();
        const plan = prepareAssistantProposal({ actions: [{ type: "marker.add", params: { markerId: "direct-marker", time: 2, title: "direct duplicate" } }] }, captureAssistantBase(before), "direct-approval");
        const result = applyCommandPlan(before, { schemaVersion: 1, baseRevision: plan.baseRevision, operations: plan.actions.map(action => ({ ...action.params, type: action.type, id: action.id })) });
        if (!result.ok) throw new Error(result.message);
        // Capture the current production callback, not the asynchronously
        // re-registered DEV event listeners. No editor setter is substituted.
        const panel = document.querySelector('[data-testid="ai-assistant-panel"]');
        let fiber = panel[Object.keys(panel).find(key => key.startsWith("__reactFiber$"))];
        while (fiber && !(fiber.memoizedProps?.onApplyPlan && fiber.memoizedProps?.getProjectSnapshot)) fiber = fiber.return;
        if (!fiber) throw new Error("Current assistant callback unavailable");
        fiber.memoizedProps.onApplyPlan(result.project, plan, {});
        fiber.memoizedProps.onApplyPlan(result.project, plan, {});
    });
    await page.waitForFunction(() => window.__PROJECT_SNAPSHOT__?.().timelineMarkers.length === 1);
    assert.deepEqual((await snapshot()).commandState.appliedOperationIds, ["direct-approval-op-0"]);
    report.checks.push("actual App commit callback independently deduplicates same-render replay, with one persisted ledger entry");

    await reset();
    await propose([marker("old project")]);
    const oldIdentity = (await snapshot()).commandState.projectIdentity;
    await page.locator(".project-file-input").setInputFiles({ name: "replacement.timeline", mimeType: "application/zip", buffer: fixture });
    await page.waitForFunction(identity => window.__PROJECT_SNAPSHOT__?.().commandState.projectIdentity !== identity, oldIdentity);
    await page.locator(".project-import-overlay").waitFor({ state: "hidden" });
    const replaced = await snapshot();
    await apply().click(); await waitFinished(); await unchanged(replaced);
    report.checks.push("real project import replaces identity even for identical contents; prior approval cannot commit");

    await reset();
    await propose([{ type: "track.set_locked", params: { track: "image", locked: true } }]);
    await apply().click(); await waitFinished();
    assert.equal((await snapshot()).trackLocks.image, true);
    await clear();
    const locked = await snapshot();
    await propose([{ type: "visual.delete", params: { clipId: "v1" } }]);
    assert.equal(await page.getByTestId("ai-assistant-destructive-warning").count(), 1);
    await apply().click(); await waitFinished(); await unchanged(locked);
    report.checks.push("real App persists assistant lock state; confirmed explicit deletion cannot bypass locked visual track");
    await reset();
    for (const params of [{}, { clipId: "selected" }, { clipId: "missing" }]) {
        await clear(); const before = await snapshot();
        await propose([{ type: "visual.delete", params }]);
        await apply().click(); await waitFinished(); await unchanged(before);
    }
    await clear();
    await propose([{ type: "visual.delete", params: { clipId: "v2" } }]);
    await apply().click(); await waitFinished();
    assert.deepEqual((await snapshot()).visualSegments.map(item => item.id), ["v1"]);
    report.checks.push("destructive missing/selection/unknown targets rejected; explicit reviewed deletion succeeds");

    await reset();
    for (const actions of [
        [marker("not committed"), { type: "tool.export", params: {} }],
        [{ type: "tool.generate_captions", params: {} }, { type: "tool.rough_cut", params: {} }],
        [{ type: "tool.generate_captions", params: {} }, { type: "unknown.operation", params: {} }],
    ]) {
        await clear(); const before = await snapshot();
        await propose(actions); await apply().click(); await waitFinished(); await unchanged(before);
        assert.equal(await page.evaluate(() => window.__asr.length), 0);
    }
    report.checks.push("complete preflight rejects nontransactional mixtures and invalid caption plans before ASR or editor writes");
    await clear(); const beforeFailure = await snapshot();
    await propose([{ type: "tool.generate_captions", params: {} }, marker("caption transaction")]);
    await apply().click();
    await page.waitForFunction(() => window.__asr.length === 1);
    await unchanged(beforeFailure);
    await page.evaluate(() => window.__asr[0].reject(new Error("Controlled ASR failure")));
    await waitFinished(); await unchanged(beforeFailure);
    await clear();
    await propose([{ type: "tool.generate_captions", params: {} }, marker("caption transaction")]);
    await apply().click(); await page.waitForFunction(() => window.__asr.length === 2);
    const stagedResult = { segments: [{ id: "new-cue", text: "Staged captions", start: 0, end: 2, fontId: "default" }], text: "Staged captions", provider: "local" };
    await unchanged(beforeFailure);
    await page.evaluate(result => window.__asr[1].resolve(result), stagedResult);
    await waitFinished();
    current = await snapshot();
    assert.equal(current.captionSegments[0].id, "new-cue");
    assert.equal(current.timelineMarkers.length, 1);
    assert.equal(current.commandState.appliedOperationIds.length, 2);
    await clear();
    await propose([{ type: "tool.generate_captions", params: {} }]);
    await apply().click(); await page.waitForFunction(() => window.__asr.length === 3);
    await page.evaluate(result => window.__asr[2].resolve(result), stagedResult);
    await waitFinished();
    assert.equal((await snapshot()).commandState.appliedOperationIds.length, 3);
    report.checks.push("real caption hook failure leaves project intact; staged caption+marker commit together; generator is usable again");

    await reset();
    const beforeCancel = await snapshot();
    await propose([{ type: "tool.generate_captions", params: {} }, marker("cancelled")]);
    await apply().click(); await page.waitForFunction(() => window.__asr.length === 1);
    await clear();
    await page.evaluate(result => window.__asr[0].resolve(result), stagedResult);
    await waitFinished(); await unchanged(beforeCancel);
    assert.equal(await page.getByTestId("ai-assistant-apply-btn").count(), 0);
    report.checks.push("clear history aborts staged execution; abort-insensitive late ASR result cannot commit");

    await reset();
    await propose([{ type: "tool.generate_captions", params: {} }, marker("stale captions")]);
    await apply().click(); await page.waitForFunction(() => window.__asr.length === 1);
    const stagingIdentity = (await snapshot()).commandState.projectIdentity;
    await page.locator(".project-file-input").setInputFiles({ name: "replacement.timeline", mimeType: "application/zip", buffer: fixture });
    await page.waitForFunction(identity => window.__PROJECT_SNAPSHOT__?.().commandState.projectIdentity !== identity, stagingIdentity);
    await page.locator(".project-import-overlay").waitFor({ state: "hidden" });
    const duringStage = await snapshot();
    await page.evaluate(result => window.__asr[0].resolve(result), stagedResult);
    await waitFinished(); await unchanged(duringStage);
    report.checks.push("project replacement while caption work is staged rejects the entire late caption+timeline transaction");

    for (const kind of ["cancel", "clear", "supersede"]) {
        await reset();
        const before = await snapshot();
        await send(); await page.waitForFunction(() => window.__plans.length === 1);
        if (kind === "cancel") await page.getByTestId("ai-assistant-cancel-btn").click();
        if (kind === "clear") await clear();
        if (kind === "supersede") { await send("Set project aspect ratio to 1:1"); await page.waitForFunction(() => window.__plans.length === 2); }
        assert.equal(await page.evaluate(() => window.__plans[0].signal.aborted), true);
        await planResponse(0, [marker("obsolete")], "OBSOLETE RESPONSE");
        await page.waitForTimeout(100);
        assert.equal(await page.getByTestId("ai-assistant-apply-btn").count(), 0);
        assert.equal((await page.getByTestId("ai-assistant-panel").innerText()).includes("OBSOLETE RESPONSE"), false);
        await unchanged(before);
        if (kind === "supersede") {
            await planResponse(1, [marker("new owner")], "CURRENT RESPONSE");
            await apply().waitFor(); await apply().click(); await waitFinished();
            assert.deepEqual((await snapshot()).timelineMarkers.map(item => item.title), ["new owner"]);
        }
        report.checks.push(`${kind} invalidates planning owner; late abort-insensitive response ignored without fallback or writes`);
    }
    await reset();
    const beforeManualZoom = await snapshot();
    await page.locator('[data-timeline-segment-track="image"][data-timeline-segment-id="v1"]').click({ position: { x: 25, y: 25 } });
    await page.locator("#editor-tool-rail").getByRole("button", { name: "Smart", exact: true }).click();
    await page.getByTestId("smart-tool-smart-zoom").click();
    await page.getByTestId("smart-zoom-add-btn").click();
    await page.waitForFunction(() => window.__PROJECT_SNAPSHOT__?.().visualSegments.find(clip => clip.id === "v1")?.punchIns?.length === 1);
    const afterManualZoom = await snapshot();
    assert.ok(afterManualZoom.commandState.revision > beforeManualZoom.commandState.revision);
    assert.deepEqual(afterManualZoom.commandState.appliedOperationIds, beforeManualZoom.commandState.appliedOperationIds);
    assert.deepEqual(afterManualZoom.captionSegments, beforeManualZoom.captionSegments);
    assert.deepEqual(afterManualZoom.audioSegments, beforeManualZoom.audioSegments);
    report.checks.push("ordinary Smart Zoom UI still commits through its non-assistant editor path and advances the live revision");

    assert.deepEqual(report.externalAttempts, []);
    assert.deepEqual(report.unexpected, []);
    assert.deepEqual(report.pageErrors, []);
    report.pass = true;
    report.original = original;
    await page.screenshot({ path: path.join(evidence, "final-editor.png") });
} catch (error) {
    report.pass = false; report.error = error.stack;
    if (page) {
        await fs.writeFile(path.join(evidence, "failure.txt"), await page.locator("body").innerText().catch(() => "unavailable"));
        await page.screenshot({ path: path.join(evidence, "failure.png") }).catch(() => { });
    }
    process.exitCode = 1;
} finally {
    await browser?.close(); await vite?.close(); globalThis.fetch = originalFetch;
    await fs.writeFile(path.join(evidence, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ evidence, ...report }, null, 2));
}
