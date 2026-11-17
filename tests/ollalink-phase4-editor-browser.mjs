import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { readProjectArchive } from "../src/lib/projectArchive.js";

// Focused full-App acceptance only. No backend, model server, auth session,
// provider credentials, production edits, shared Vite cache, or full-suite runs.
const evidence = await fs.mkdtemp(path.resolve("scratch/ollalink-phase4/acceptance-editor-"));
const report = {
    command: "node tests/ollalink-phase4-editor-browser.mjs", cwd: process.cwd(), evidence,
    mocked: true, fullShell: true, liveCalls: 0, checks: [], requests: [],
    externalAttempts: [], unexpected: [], pageErrors: [], consoleErrors: [], requestFailures: [],
    mocks: ["App currentUser prop", "empty media catalog at test-local service URLs", "POST /api/diarization"],
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async input => {
    report.externalAttempts.push({ source: "node-fetch", url: String(input) });
    throw new Error("Network fetch forbidden in editor acceptance runner");
};
let browser;
let vite;
let page;
let fixture;
let diarizationCalls = 0;
try {
    const root = path.resolve("scratch/ollalink-phase4/acceptance-20261029");
    for (const directory of (await fs.readdir(root)).filter(name => name.startsWith("persistence-"))) {
        try {
            const candidate = path.join(root, directory);
            const result = JSON.parse(await fs.readFile(path.join(candidate, "report.json"), "utf8"));
            if (result.pass) {
                fixture = await fs.readFile(path.join(candidate, "discard.timeline"));
                report.fixtureSource = path.join(candidate, "discard.timeline");
                break;
            }
        } catch { /* Incomplete historical evidence is not a fixture. */ }
    }
    assert.ok(fixture, "A passing existing persistence discard.timeline archive is required");
    await fs.writeFile(path.join(evidence, "input.timeline"), fixture);
    const input = await readProjectArchive(new Blob([fixture]));
    assert.equal(input.payload.project.captionSegments.find(cue => cue.id === "a").speaker, undefined);
    const inputAudio = input.audioSegmentMedia.get("audio-1").blob;
    report.fixtureBytes = inputAudio.size;
    vite = await createServer({
        configFile: false, envFile: false, cacheDir: path.join(evidence, "vite-cache"),
        plugins: [react(), {
            name: "phase4-editor-local-services",
            // Production catalog automatically searches on mount. Substitute only
            // its service URL literals, not editor state/UI or diarization logic.
            transform(code, id) {
                if (!id.replaceAll("\\", "/").endsWith("/src/hooks/useEditorCatalog.js")) return;
                return code
                    .replace("https://commons.wikimedia.org/w/api.php?", "/__phase4_catalog/commons?")
                    .replace("https://api.pexels.com/v1/", "/__phase4_catalog/pexels/")
                    .replace("https://api.openverse.org/v1/audio/?", "/__phase4_catalog/audio?");
            },
            configureServer(server) {
                server.middlewares.use("/phase4-editor", async (_req, res) => {
                    res.setHeader("Content-Type", "text/html");
                    res.end(await server.transformIndexHtml("/phase4-editor", '<div id="root"></div><script type="module" src="/tests/ollalink-phase4-editor-harness.jsx"></script>'));
                });
            },
        }],
        server: { host: "127.0.0.1", port: 0, hmr: false, warmup: { clientFiles: [] }, watch: { ignored: ["**/scratch/**"] } },
    });
    await vite.listen();
    const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
    report.origin = origin;
    browser = await chromium.launch({ headless: true, args: ["--disable-background-networking", "--disable-component-update", "--no-default-browser-check"] });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true, serviceWorkers: "block" });
    await context.route("**/*", async route => {
        const request = route.request();
        const url = new URL(request.url());
        const entry = { url: request.url(), method: request.method(), type: request.resourceType() };
        report.requests.push(entry);
        if (url.origin !== origin) {
            report.externalAttempts.push(entry);
            return route.abort("blockedbyclient");
        }
        if (url.pathname === "/__phase4_fixture.timeline") return route.fulfill({ body: fixture, contentType: "application/zip" });
        if (url.pathname.startsWith("/__phase4_catalog/")) return route.fulfill({ json: { query: { pages: {} }, results: [], photos: [], videos: [] } });
        if (url.pathname === "/api/diarization" && request.method() === "POST") {
            diarizationCalls++;
            assert.equal(request.headers()["content-type"], "audio/wav");
            assert.equal(request.headers()["x-diarization-request"], "1");
            assert.equal(request.postDataBuffer().subarray(0, 4).toString(), "RIFF");
            assert.ok(request.postDataBuffer().includes(Buffer.from("WAVE")));
            return route.fulfill({ json: { model: "nemotron-3-diarization", duration: 4, speakers: ["speaker_1", "speaker_2"], segments: [{ start: 0, end: 2, speaker: "speaker_1" }, { start: 2, end: 4, speaker: "speaker_2" }] } });
        }
        const viteAssetUrlModule = request.resourceType() === "script" && url.searchParams.has("url");
        if (url.pathname.startsWith("/api/") || (/\.(onnx|wasm|safetensors|bin)$/i.test(url.pathname) && !viteAssetUrlModule)) {
            report.unexpected.push(entry);
            return route.abort("blockedbyclient");
        }
        // A dedicated origin with no proxy: only local Vite modules/styles/assets.
        return route.continue();
    });
    await context.addInitScript(() => {
        localStorage.setItem("ai-voiceover-ui-language", "en");
        localStorage.setItem("timeline_studio_first_visual_guide_seen", "1");
        window.nativeEditorEvidence = { decodes: 0, workers: [], workerErrors: [] };
        const decode = BaseAudioContext.prototype.decodeAudioData;
        BaseAudioContext.prototype.decodeAudioData = function (...args) {
            window.nativeEditorEvidence.decodes++;
            return decode.apply(this, args);
        };
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
            constructor(...args) {
                super(...args);
                window.nativeEditorEvidence.workers.push(String(args[0]));
                this.addEventListener("error", event => window.nativeEditorEvidence.workerErrors.push(event.message));
            }
        };
    });
    page = await context.newPage();
    page.on("pageerror", error => report.pageErrors.push(error.message));
    page.on("console", message => { if (message.type() === "error") report.consoleErrors.push(message.text()); });
    page.on("requestfailed", request => report.requestFailures.push({ url: request.url(), failure: request.failure() }));
    page.setDefaultTimeout(20000);
    await page.goto(`${origin}/phase4-editor`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.locator(".editor-grid").waitFor({ timeout: 90000 });
    await page.waitForFunction(() => window.__PROJECT_SNAPSHOT__?.().captionSegments.some(cue => cue.id === "a"), null, { timeout: 60000 });
    await page.locator(".project-import-overlay").waitFor({ state: "hidden" });
    const snapshot = async () => {
        // Capture in the same browser task as the availability check: App's
        // DEV bridge effect cleans up/re-registers during ordinary renders.
        const handle = await page.waitForFunction(() => window.__PROJECT_SNAPSHOT__?.() || false);
        try { return await handle.jsonValue(); } finally { await handle.dispose(); }
    };
    const original = await snapshot();
    assert.deepEqual(original.captionSegments, input.payload.project.captionSegments);
    assert.equal(await page.locator(".topbar").count(), 1);
    assert.equal(await page.locator("#editor-tool-rail").count(), 1);
    const clip = page.locator('[data-timeline-segment-track="audio"][data-timeline-segment-id="audio-1"]');
    await clip.click({ position: { x: 30, y: 30 } });
    await page.locator("#editor-tool-rail").getByRole("button", { name: "Audio", exact: true }).click();
    await page.locator(".audio-tool-panel").waitFor();
    assert.equal(await clip.evaluate(element => element.classList.contains("is-selected")), true);
    report.checks.push("production App/topbar/sidebar/timeline mounted; existing .timeline imported by App initialImportFile; ordinary audio selected using timeline UI");
    const apply = () => page.getByRole("button", { name: "Apply reviewed speaker labels", exact: true });
    const detect = async () => {
        await page.getByLabel("Speaker detection provider").selectOption("ollalink");
        await page.getByRole("button", { name: "Detect speakers with Ollalink", exact: true }).click();
        await apply().waitFor();
    };
    await detect();
    assert.deepEqual((await snapshot()).captionSegments, original.captionSegments);
    await page.screenshot({ path: path.join(evidence, "01-review.png") });
    await page.getByRole("button", { name: "Discard speaker review", exact: true }).click();
    assert.equal(await apply().count(), 0);
    assert.deepEqual((await snapshot()).captionSegments, original.captionSegments);
    report.checks.push("actual ToolPanel Audio detect/review/discard leaves App snapshot captions unchanged");
    await detect();
    assert.deepEqual((await snapshot()).captionSegments, original.captionSegments);
    await apply().click();
    await page.waitForFunction(() => window.__PROJECT_SNAPSHOT__().captionSegments.find(cue => cue.id === "a").speaker?.startsWith("ollalink:"));
    const applied = await snapshot();
    const before = original.captionSegments;
    const after = applied.captionSegments;
    assert.match(after.find(cue => cue.id === "a").speaker, /^ollalink:.+:speaker_1$/);
    assert.match(after.find(cue => cue.id === "b").speaker, /^ollalink:.+:speaker_2$/);
    assert.deepEqual(after.map(({ speaker, ...rest }) => rest), before.map(({ speaker, ...rest }) => rest));
    for (const id of ["manual", "crossing", "unlinked"]) assert.deepEqual(after.find(cue => cue.id === id), before.find(cue => cue.id === id));
    assert.deepEqual({ ...applied, captionSegments: before }, original);
    await fs.writeFile(path.join(evidence, "snapshots.json"), JSON.stringify({ original, applied }, null, 2));
    await page.screenshot({ path: path.join(evidence, "02-applied.png") });
    report.checks.push("only real UI Apply commits eligible speaker metadata to App state; all other snapshot fields/manual/unlinked/crossing captions unchanged");
    await page.locator(".project-file-button").click();
    const downloading = page.waitForEvent("download");
    await page.locator(".file-menu-action.is-primary").click();
    const download = await downloading;
    const saved = path.join(evidence, "editor-applied.timeline");
    await download.saveAs(saved);
    assert.equal(await download.failure(), null);
    const savedArchive = await readProjectArchive(new Blob([await fs.readFile(saved)]));
    assert.deepEqual(savedArchive.payload.project.captionSegments, after);
    assert.deepEqual(Buffer.from(await savedArchive.audioSegmentMedia.get("audio-1").blob.arrayBuffer()), Buffer.from(await inputAudio.arrayBuffer()));
    await page.locator("input.project-file-input").setInputFiles(path.join(evidence, "input.timeline"));
    await page.waitForFunction(() => {
        const cue = window.__PROJECT_SNAPSHOT__?.().captionSegments.find(item => item.id === "a");
        return Boolean(cue) && cue.speaker === undefined;
    });
    await page.locator("input.project-file-input").setInputFiles(saved);
    await page.waitForFunction(() => window.__PROJECT_SNAPSHOT__?.().captionSegments.find(cue => cue.id === "a")?.speaker?.startsWith("ollalink:"));
    assert.deepEqual((await snapshot()).captionSegments, after);
    assert.deepEqual((await snapshot()).audioSegments, original.audioSegments);
    report.checks.push("production File menu downloads portable archive with original WAV; production file input restores baseline then applied speaker metadata/audio placement");
    report.native = await page.evaluate(() => window.nativeEditorEvidence);
    assert.ok(report.native.decodes > 0);
    assert.ok(report.native.workers.length > 0);
    assert.ok(report.native.workers.every(url => url.includes("project-archive.worker")), "no inference/model worker started");
    assert.deepEqual(report.native.workerErrors, []);
    assert.equal(diarizationCalls, 2);
    assert.deepEqual(report.externalAttempts, []);
    assert.deepEqual(report.unexpected, []);
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.consoleErrors, []);
    // Chromium may cancel a same-origin preload when App changes the selected
    // voice during import. Preserve that ledger, but reject all other failures.
    assert.deepEqual(report.requestFailures.filter(entry => !(entry.url.includes("/assets/voice-samples/") && entry.failure?.errorText === "net::ERR_ABORTED")), []);
    report.pass = true;
} catch (error) {
    report.pass = false;
    report.failure = error.stack;
    if (page) {
        await page.screenshot({ path: path.join(evidence, "failure.png") }).catch(() => { });
        await fs.writeFile(path.join(evidence, "failure-body.txt"), await page.locator("body").innerText().catch(() => "unavailable"));
    }
    process.exitCode = 1;
} finally {
    report.diarizationCalls = diarizationCalls;
    await browser?.close();
    await vite?.close();
    globalThis.fetch = originalFetch;
    await fs.writeFile(path.join(evidence, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, requests: `${report.requests.length} recorded in report.json` }, null, 2));
}
