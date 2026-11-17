import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { readProjectArchive } from "../src/lib/projectArchive.js";
import { parseSrt } from "../src/lib/subtitles.js";

// No backend, credentials, upstream, transcription, or model server is started.
const evidenceRoot = path.resolve("scratch/ollalink-phase4/acceptance-20261029");
await fs.mkdir(evidenceRoot, { recursive: true });
const evidence = await fs.mkdtemp(path.join(evidenceRoot, "persistence-"));
const report = { mocked: true, liveCalls: 0, checks: [], requests: [], blocked: [], pageErrors: [], workerErrors: [], evidence };
const originalFetch = globalThis.fetch;
globalThis.fetch = async input => { report.blocked.push({ source: "node-fetch", url: String(input) }); throw new Error("External fetch forbidden in acceptance runner"); };
const vite = await createServer({
    configFile: false, plugins: [react(), {
        name: "phase4-persistence-page", configureServer(server) {
            server.middlewares.use("/phase4-persistence", async (_req, res) => {
                res.setHeader("Content-Type", "text/html");
                res.end(await server.transformIndexHtml("/phase4-persistence", '<div id="root"></div><script type="module" src="/tests/ollalink-phase4-persistence-harness.jsx"></script>'));
            });
        },
    }], server: { host: "127.0.0.1", port: 0, hmr: false, warmup: { clientFiles: [] } },
});
let browser;
let cloudArchive;
let pending;
let mode = "success";
let diarizationCalls = 0;
const diarizationResponse = { model: "nemotron-3-diarization", duration: 4, speakers: ["speaker_1", "speaker_2"], segments: [{ start: 0, end: 2, speaker: "speaker_1" }, { start: 2, end: 4, speaker: "speaker_2" }] };
const projectRecord = { id: "mock-project", title: "Acceptance fixture", ratio: "16:9", current_revision: 1 };
try {
    await vite.listen();
    const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: "block" });
    await context.route("**/*", async route => {
        const request = route.request();
        const url = new URL(request.url());
        report.requests.push({ url: request.url(), method: request.method(), type: request.resourceType() });
        if (url.origin !== origin) {
            report.blocked.push({ source: "browser", url: request.url() });
            return route.abort("blockedbyclient");
        }
        if (!url.pathname.startsWith("/api/")) return route.continue();
        if (url.pathname === "/api/diarization" && request.method() === "POST") {
            diarizationCalls++;
            assert.equal(request.headers()["content-type"], "audio/wav");
            assert.equal(request.headers()["x-diarization-request"], "1");
            const body = request.postDataBuffer();
            assert.ok(body.includes(Buffer.from("RIFF")), "production preparation submitted real WAV");
            assert.ok(body.includes(Buffer.from("WAVE")));
            if (mode === "pending") await new Promise(resolve => { pending = resolve; });
            await route.fulfill({ json: diarizationResponse }).catch(() => { }); // Deliberately allow late response after abort.
            return;
        }
        if (url.pathname === "/api/projects" && request.method() === "POST") {
            assert.equal(request.postDataJSON().title, "Acceptance fixture");
            return route.fulfill({ json: { project: { ...projectRecord, current_revision: 0 } } });
        }
        if (url.pathname === "/api/projects/mock-project/archive") {
            if (request.method() === "PUT") {
                cloudArchive = request.postDataBuffer();
                assert.match(request.headers()["content-type"], /application\/octet-stream/);
                await fs.writeFile(path.join(evidence, "cloud-upload.timeline"), cloudArchive);
                return route.fulfill({ json: { project: projectRecord } });
            }
            if (request.method() === "GET" && cloudArchive) return route.fulfill({ body: cloudArchive, contentType: "application/zip" });
        }
        report.blocked.push({ source: "unexpected-local-api", url: request.url(), method: request.method() });
        return route.abort("blockedbyclient");
    });
    await context.addInitScript(() => {
        window.nativeEvidence = { decodes: 0, workers: [], workerFailures: [] };
        const decode = BaseAudioContext.prototype.decodeAudioData;
        BaseAudioContext.prototype.decodeAudioData = function (...args) {
            window.nativeEvidence.decodes++;
            return decode.apply(this, args);
        };
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
            constructor(...args) {
                super(...args);
                const record = { url: String(args[0]), messages: [] };
                window.nativeEvidence.workers.push(record);
                this.addEventListener("message", event => record.messages.push({ type: event.data.type || null, hasResult: Object.hasOwn(event.data, "result"), error: event.data.error || null }));
                this.addEventListener("error", event => window.nativeEvidence.workerFailures.push(event.message));
            }
        };
    });
    const page = await context.newPage();
    page.on("pageerror", error => report.pageErrors.push(error.message));
    page.on("worker", worker => worker.on("close", () => { }));
    const reset = async (suffix = "") => {
        mode = "success"; pending = null;
        await page.goto(`${origin}/phase4-persistence${suffix}`);
        await page.waitForFunction(() => Boolean(window.persistence));
    };
    const captions = () => page.evaluate(() => window.persistence.state.captionSegments);
    const snapshot = () => page.evaluate(() => window.persistence.files.getProjectSnapshot());
    const archive = () => page.evaluate(() => window.persistence.archive());
    const apply = () => page.getByRole("button", { name: "Apply reviewed speaker labels", exact: true });
    const review = async () => {
        await page.getByLabel("Speaker detection provider").selectOption("ollalink");
        await page.getByRole("button", { name: "Detect speakers with Ollalink", exact: true }).click();
        await apply().waitFor();
    };
    const download = async (label, name) => {
        const waiting = page.waitForEvent("download");
        await page.getByRole("button", { name: label, exact: true }).click();
        const item = await waiting;
        const destination = path.join(evidence, name);
        await item.saveAs(destination);
        assert.equal(await item.failure(), null);
        return { destination, suggestedFilename: item.suggestedFilename() };
    };
    const importFile = async file => {
        const before = await page.evaluate(() => window.persistence.notifications.length);
        await page.getByLabel("Import project", { exact: true }).setInputFiles(file);
        await page.waitForFunction(count => window.persistence.notifications.length > count && !window.persistence.files.projectImportProgress, before);
        assert.match(await page.getByLabel("Notifications").textContent(), /已导入/);
    };
    await reset();
    const original = await captions();
    const originalSnapshot = await snapshot();
    const initialArchive = await archive();
    assert.equal(initialArchive.payload.version, 3);
    assert.equal(initialArchive.audio.length, 1);
    assert.ok(initialArchive.audio[0].bytes.length > 190000);
    assert.equal(Buffer.from(initialArchive.audio[0].bytes).subarray(0, 4).toString(), "RIFF");
    assert.equal(diarizationCalls, 0);
    await review();
    assert.deepEqual(await captions(), original);
    assert.deepEqual((await archive()).payload.project.captionSegments, original);
    report.checks.push("unapplied review excluded from actual hook snapshot/archive");
    await apply().click();
    await page.waitForFunction(() => window.persistence.state.captionSegments[0].speaker?.startsWith("ollalink:"));
    const applied = await captions();
    assert.match(applied[0].speaker, /^ollalink:.+:speaker_1$/);
    assert.match(applied[1].speaker, /^ollalink:.+:speaker_2$/);
    assert.deepEqual(applied[2], original[2]);
    assert.deepEqual(applied.slice(3), original.slice(3));
    assert.deepEqual(applied.map(({ speaker, ...rest }) => rest), original.map(({ speaker, ...rest }) => rest));
    const savedSnapshot = await snapshot();
    assert.deepEqual({ ...savedSnapshot, captionSegments: original }, originalSnapshot);
    const savedArchive = await archive();
    assert.deepEqual(savedArchive.payload.project.captionSegments, applied);
    assert.deepEqual(savedArchive.audio, initialArchive.audio);
    assert.deepEqual(savedArchive.payload.project.audioSegments, originalSnapshot.audioSegments);
    report.checks.push("explicit panel Apply changes only eligible speaker metadata; hook archive retains WAV and source/timeline placement");

    const local = await download("Download project", "applied-local.timeline");
    assert.match(local.suggestedFilename, /\.timeline$/);
    const diskArchive = await readProjectArchive(new Blob([await fs.readFile(local.destination)]));
    assert.deepEqual(diskArchive.payload.project.captionSegments, applied);
    const srt = await download("Download SRT", "applied-captions.srt");
    const srtText = await fs.readFile(srt.destination, "utf8");
    const { captions: parsed, skipped } = parseSrt(srtText);
    assert.equal(skipped, 0);
    assert.equal(parsed.length, applied.length);
    assert.deepEqual(parsed.map(({ text, start, end }) => ({ text, start, end })), [...applied].sort((a, b) => a.start - b.start || a.end - b.end).map(({ text, start, end }) => ({ text, start, end })));
    assert.doesNotMatch(srtText, /ollalink:|speaker_[12]|Alice|manual-alice/);
    report.checks.push("real browser project/SRT downloads: exact caption text/times, no invented speaker prefixes");
    await reset();
    await importFile(local.destination);
    assert.deepEqual(await captions(), applied);
    assert.deepEqual((await snapshot()).audioSegments, originalSnapshot.audioSegments);
    const restoredAudio = await page.evaluate(async () => {
        const a = window.persistence.state.audioSegments[0];
        return { bytes: [...new Uint8Array(await a.blob.arrayBuffer())], peaks: a.peaks, url: a.url };
    });
    assert.deepEqual(restoredAudio.bytes, initialArchive.audio[0].bytes);
    assert.ok(restoredAudio.peaks.length > 0);
    assert.match(restoredAudio.url, /^blob:/);
    assert.deepEqual((await archive()).payload.project.captionSegments, applied);
    assert.equal((await page.evaluate(() => window.persistence.inspect())).segments.find(cue => cue.id === "manual").speaker, "Alice");
    report.checks.push("local download/import via hook with native WAV waveform decode preserves full captions, manual fields, audio bytes/placement and re-export");

    await page.getByRole("button", { name: "Save cloud", exact: true }).click();
    await page.waitForFunction(() => window.persistence.files.currentCloudProject?.current_revision === 1 && !window.persistence.files.savingToCloud);
    assert.deepEqual((await readProjectArchive(new Blob([cloudArchive]))).payload.project.captionSegments, applied);
    await reset("?cloud=1");
    await page.waitForFunction(() => window.persistence.notifications.some(note => note.includes("媒体素材已恢复")) && !window.persistence.files.projectImportProgress);
    assert.deepEqual(await captions(), applied);
    assert.deepEqual((await snapshot()).audioSegments, originalSnapshot.audioSegments);
    assert.deepEqual((await archive()).audio, initialArchive.audio);
    report.checks.push("mocked cloud create/PUT archive and initialProject GET auto-load use the actual hook/worker/native decoder");
    const native = await page.evaluate(() => window.nativeEvidence);
    assert.ok(native.decodes > 0);
    assert.ok(native.workers.length >= 3);
    assert.ok(native.workers.every(worker => /project-archive.worker/.test(worker.url) && worker.messages.some(message => message.hasResult && !message.error)));
    assert.deepEqual(native.workerFailures, []);
    report.nativeEvidence = native;

    for (const scenario of ["discard", "stale-review", "stale-pending"]) {
        await reset();
        const before = diarizationCalls;
        if (scenario === "stale-pending") {
            mode = "pending";
            await page.getByLabel("Speaker detection provider").selectOption("ollalink");
            await page.getByRole("button", { name: "Detect speakers with Ollalink", exact: true }).click();
            await page.waitForFunction(() => document.body.textContent.includes("Preparing selected clip"));
            for (let i = 0; i < 200 && !pending; i++) await new Promise(resolve => setTimeout(resolve, 10));
            assert.ok(pending, "real native preparation reached mocked upload");
        } else await review();
        if (scenario === "discard") await page.getByRole("button", { name: "Discard speaker review", exact: true }).click();
        else {
            await page.evaluate(() => window.persistence.setState(current => ({ ...current, captionSegments: current.captionSegments.map((cue, i) => i ? cue : { ...cue, text: "Manual stale edit!" }) })));
            await page.waitForFunction(() => window.persistence.state.captionSegments[0].text === "Manual stale edit!");
            if (scenario === "stale-review") {
                assert.equal(await apply().isDisabled(), true);
            } else { pending(); await page.waitForTimeout(100); assert.equal(await apply().count(), 0); }
        }
        const expected = await captions();
        assert.equal(expected[0].speaker, undefined);
        assert.deepEqual((await snapshot()).captionSegments, expected);
        assert.deepEqual((await archive()).payload.project.captionSegments, expected);
        const file = await download("Download project", `${scenario}.timeline`);
        assert.deepEqual((await readProjectArchive(new Blob([await fs.readFile(file.destination)]))).payload.project.captionSegments, expected);
        assert.equal(diarizationCalls, before + 1);
        report.checks.push(`${scenario}: proposals never enter snapshot/archive/download; manual edits retained`);
    }

    await reset();
    const legacy = { format: "timeline-studio-project", project: { ...originalSnapshot, captionStyle: { fontId: "default" }, captionSegments: original.filter(cue => cue.id !== "manual").map(({ fontId, ...cue }) => cue), audioSegments: [] } };
    await importFile({ name: "legacy.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(legacy)) });
    assert.deepEqual(await captions(), legacy.project.captionSegments.map(cue => ({ ...cue, fontId: "default" })));
    assert.ok((await captions()).every(cue => !Object.hasOwn(cue, "speaker") && !Object.hasOwn(cue, "speakerId")));
    report.checks.push("legacy JSON import inherits font but does not invent speaker metadata");

    const malformed = [null, 42, { unexpected: "<img src=x onerror=alert(1)>" }, ["bad"], "<script>window.pwned=1</script>\u0000"];
    for (let i = 0; i < malformed.length; i++) {
        const cues = [{ ...original[0], speaker: malformed[i], speakerId: { opaque: true } }];
        await importFile({ name: `opaque-${i}.json`, mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ ...legacy, project: { ...legacy.project, captionSegments: cues } })) });
        assert.deepEqual(await captions(), cues);
        assert.deepEqual((await archive()).payload.project.captionSegments, cues);
        const file = await download("Download project", `opaque-${i}.timeline`);
        await importFile(file.destination);
        assert.deepEqual(await captions(), cues);
        assert.equal(await page.evaluate(() => window.pwned), undefined);
    }
    report.checks.push("five malformed/opaque metadata forms import/archive/re-import unchanged, no crash or script execution (not a new normalization contract)");
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.blocked, []);
    report.diarizationCalls = diarizationCalls;
    report.pass = true;
} catch (error) {
    report.pass = false;
    report.failure = error.stack;
    throw error;
} finally {
    pending?.();
    await browser?.close();
    await vite.close();
    globalThis.fetch = originalFetch;
    await fs.writeFile(path.join(evidence, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, requests: `${report.requests.length} requests recorded in report.json` }, null, 2));
}
