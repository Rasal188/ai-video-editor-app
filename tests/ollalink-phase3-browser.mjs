import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

// Isolated, mounted production panel + real timeline actions. All speech is synthetic;
// fetch is intercepted in-browser, including deliberately abort-ignoring late work.
const vite = await createServer({
    server: { host: "127.0.0.1", port: 0, warmup: { clientFiles: [] } },
    plugins: [{
        name: "phase3-test-page", configureServer(server) {
            server.middlewares.use("/phase3-test", async (_req, res) => {
                res.setHeader("Content-Type", "text/html");
                res.end(await server.transformIndexHtml("/phase3-test", '<div id="root"></div><script type="module" src="/tests/ollalink-phase3-harness.jsx"></script>'));
            });
        }
    }],
});
let browser;
try {
    await vite.listen();
    const port = vite.httpServer.address().port;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
        const fetchOriginal = window.fetch;
        window.requests = [];
        window.mode = "success";
        window.makeResponse = () => {
            const buffer = new ArrayBuffer(48044); const view = new DataView(buffer);
            const tag = (offset, text) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
            tag(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true); tag(8, "WAVE"); tag(12, "fmt ");
            view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
            view.setUint32(24, 24000, true); view.setUint32(28, 48000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
            tag(36, "data"); view.setUint32(40, 48000, true);
            for (let i = 0; i < 24000; i++) view.setInt16(44 + i * 2, Math.sin(i / 10) * 4000, true);
            return new Response(buffer, { headers: { "Content-Type": "audio/wav" } });
        };
        window.fetch = (url, options) => {
            if (url === "/api/tts/voices") {
                window.catalogGets = (window.catalogGets || 0) + 1;
                if (window.catalogMode === "error") return Promise.resolve(new Response(null, { status: 503 }));
                const voices = window.catalogMode === "removed" ? [{ id: "noa", name: "Noa", languages: ["es"] }] : [
                    { id: "delia", name: "Delia", languages: ["en"] }, { id: "easton", name: "Easton", languages: ["en"] }, { id: "noa", name: "Noa", languages: ["es"] }
                ];
                if (window.catalogMode === "pending") return new Promise(resolve => { window.resolveCatalog = () => resolve(Response.json({ voices })); });
                return Promise.resolve(Response.json({ voices }));
            }
            if (url !== "/api/tts") return fetchOriginal(url, options);
            window.requests.push({ body: JSON.parse(options.body), signal: options.signal });
            if (window.mode === "pending") return new Promise((resolve, reject) => { window.resolveSpeech = () => resolve(window.makeResponse()); window.rejectSpeech = () => reject(new Error("SECRET upstream")); });
            if (window.mode === "error") return Promise.resolve(new Response("SECRET upstream", { status: 500 }));
            return Promise.resolve(window.makeResponse());
        };
    });
    const reset = async () => {
        await page.goto(`http://127.0.0.1:${port}/phase3-test`);
        await page.getByLabel("Speech provider").waitFor();
    };
    const cloud = async () => {
        await page.getByLabel("Speech provider").selectOption("ollalink");
        await page.waitForFunction(() => document.querySelector('[aria-label="Cloud voice"] option[value="delia"]'));
        assert.equal(await page.getByLabel("Cloud voice", { exact: true }).inputValue(), "");
        assert.equal(await generate().isDisabled(), true);
        await page.getByLabel("Cloud voice", { exact: true }).selectOption("delia");
        assert.equal(await generate().isDisabled(), true);
        await page.getByLabel("Speech language", { exact: true }).selectOption("en");
    };
    const generate = () => page.getByRole("button", { name: "Generate Ollalink speech", exact: true });
    const state = () => page.evaluate(() => window.fixture.state);

    await reset();
    assert.equal(await page.getByLabel("Speech provider").inputValue(), "local");
    assert.equal(await page.locator("#speed").inputValue(), "1.2");
    assert.equal(await page.locator("#volume").inputValue(), "2");
    await cloud();
    assert.equal(await page.locator("#speed").count(), 0);
    assert.match(await page.getByTestId("ollalink-tts-panel").innerText(), /Natural speed only/);
    await page.getByLabel("Cloud voice", { exact: true }).selectOption("easton");
    await page.getByLabel("Speech language", { exact: true }).selectOption("en");
    await generate().click();
    await page.waitForFunction(() => window.fixture.state.audio.length === 1);
    await page.getByText("Ollalink speech added to timeline. Preview or download below.", { exact: true }).waitFor();
    let result = await state();
    assert.equal(result.audio[0].sourceKind, "ollalink-voiceover");
    assert.equal(result.audio[0].voiceId, "ollalink:easton");
    assert.equal(result.audio[0].name, "Ollalink · easton (en)");
    assert.equal(result.audio[0].duration, 1);
    assert.equal(result.audio[0].volume, 1);
    assert.equal(result.audio[0].playbackRate, 1);
    assert.equal(result.history[0].voiceName, result.audio[0].name);
    assert.equal(await page.locator(".generated-voice-result audio").count(), 1);
    await page.locator(".secondary-download").click();
    assert.equal(await page.evaluate(() => window.downloads), 1);
    assert.deepEqual(await page.evaluate(() => window.requests[0].body), { input: "Hello cloud.", voice: "easton", language: "en", response_format: "wav" });
    await page.getByLabel("Speech provider").selectOption("local");
    assert.equal(await page.locator("#speed").inputValue(), "1.2");
    assert.equal(await page.locator("#volume").inputValue(), "2");

    for (const invalidate of ["cancel", "script", "voice", "language", "selection", "provider", "unmount"]) {
        for (const outcome of ["resolve", "reject"]) {
            await reset(); await cloud();
            await page.evaluate(() => { window.mode = "pending"; });
            await generate().evaluate(button => { button.click(); button.click(); });
            await page.waitForFunction(() => window.requests.length === 1);
            if (invalidate === "cancel") await page.getByRole("button", { name: "Cancel speech" }).click();
            if (invalidate === "script") await page.locator("#script-input").fill("Changed script");
            if (invalidate === "voice") await page.getByLabel("Cloud voice", { exact: true }).selectOption("easton");
            if (invalidate === "language") await page.getByLabel("Speech language", { exact: true }).selectOption("");
            if (invalidate === "selection") await page.evaluate(() => window.fixture.setSelected("other"));
            if (invalidate === "provider") await page.getByLabel("Speech provider").selectOption("local");
            if (invalidate === "unmount") await page.getByRole("button", { name: "Toggle mount" }).click();
            await page.waitForFunction(() => window.fixture.state.status === "ready");
            assert.equal(await page.evaluate(() => window.requests[0].signal.aborted), true);
            await page.evaluate(outcome => outcome === "resolve" ? window.resolveSpeech() : window.rejectSpeech(), outcome);
            await page.waitForTimeout(60);
            assert.equal((await state()).audio.length, 0, `${invalidate}/${outcome}`);
            assert.equal(await page.evaluate(() => window.localCalls || 0), 0);
        }
    }

    await reset(); await cloud();
    await page.evaluate(() => { window.mode = "error"; });
    await generate().click();
    await page.getByRole("button", { name: "Use local TTS instead" }).waitFor();
    assert.doesNotMatch(await page.locator("body").innerText(), /SECRET/);
    await page.getByRole("button", { name: "Use local TTS instead" }).click();
    assert.equal(await page.getByLabel("Speech provider").inputValue(), "local");
    assert.equal(await page.evaluate(() => window.localCalls || 0), 0);
    await cloud();
    await page.evaluate(() => window.fixture.setScript("a".repeat(4001)));
    assert.equal(await generate().isDisabled(), true);
    assert.equal(await page.evaluate(() => window.requests.length), 1);

    await reset();
    await page.evaluate(() => window.fixture.setCaptionMode(true));
    await cloud(); await generate().click();
    await page.waitForFunction(() => window.fixture.state.audio.length === 1);
    result = await state();
    assert.equal(result.audio[0].start, 2);
    assert.equal(result.captions.length, 1);
    assert.equal(result.captions[0].id, "one");
    assert.equal(result.captions[0].detachedAudioSegmentId, result.audio[0].id);

    await reset(); await cloud();
    await page.evaluate(() => { window.mode = "pending"; });
    await generate().click();
    await page.waitForFunction(() => window.requests.length === 1);
    await page.evaluate(() => { window.fixture.setLocked(true); });
    await page.evaluate(() => window.resolveSpeech());
    await page.getByRole("button", { name: "Use local TTS instead" }).waitFor();
    assert.equal((await state()).audio.length, 0);
    await reset(); await cloud();
    await page.evaluate(() => { window.catalogMode = "removed"; });
    await page.getByRole("button", { name: "Refresh cloud voice catalog" }).click();
    await page.getByText("This selected pair is no longer available.", { exact: false }).waitFor();
    assert.equal(await page.getByLabel("Cloud voice", { exact: true }).inputValue(), "delia");
    assert.equal(await generate().isDisabled(), true);
    assert.equal(await page.evaluate(() => window.requests.length), 0);
    await page.getByLabel("Cloud voice", { exact: true }).selectOption("noa");
    assert.equal(await page.getByLabel("Speech language", { exact: true }).inputValue(), "en");
    assert.equal(await generate().isDisabled(), true);
    await page.getByLabel("Speech language", { exact: true }).selectOption("es");
    assert.equal(await generate().isDisabled(), false);

    await reset(); await cloud();
    await page.evaluate(() => { window.catalogMode = "error"; });
    await page.getByRole("button", { name: "Refresh cloud voice catalog" }).click();
    await page.getByRole("button", { name: "Use local TTS instead" }).waitFor();
    assert.equal(await generate().isDisabled(), true);
    assert.equal(await page.evaluate(() => window.requests.length), 0);

    await reset(); await cloud();
    await page.evaluate(() => { window.catalogMode = "pending"; });
    await page.getByRole("button", { name: "Refresh cloud voice catalog" }).click();
    await page.waitForFunction(() => !!window.resolveCatalog);
    await page.getByLabel("Speech provider").selectOption("local");
    await page.evaluate(() => window.resolveCatalog());
    await page.waitForTimeout(60);
    assert.equal(await page.getByTestId("ollalink-tts-panel").count(), 0);
    assert.equal(await page.evaluate(() => window.requests.length), 0);
    assert.deepEqual(errors, []);
    console.log("PASS mounted Chromium: natural WAV commit/identity, caption alignment, preview/download, local preservation, 14 late-work cancellation cases, duplicate sync submit, safe failure/manual fallback, limit, locked commit. No live upstream calls.");
} finally {
    await browser?.close();
    await vite.close();
}
