import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

// Real production component/native WAV decoding. ALL provider traffic is mocked.
const vite = await createServer({
    server: { host: "127.0.0.1", port: 0, warmup: { clientFiles: [] } }, plugins: [{
        name: "phase4-test-page", configureServer(server) {
            server.middlewares.use("/phase4-test", async (_req, res) => {
                res.setHeader("Content-Type", "text/html");
                res.end(await server.transformIndexHtml("/phase4-test", '<div id="root"></div><script type="module" src="/tests/ollalink-phase4-harness.jsx"></script>'));
            });
        },
    }]
});
let browser;
const checks = [];
try {
    await vite.listen();
    browser = await chromium.launch({ headless: true });
    const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
    const context = await browser.newContext({ serviceWorkers: "block" });
    const networkLedger = [], fetchLedger = [], unexpected = [], errors = [], consoleErrors = [];
    const fsRoot = `/@fs/${fileURLToPath(new URL("../", import.meta.url)).replaceAll("\\", "/")}`;
    // Only this fixture and its local module graph may reach the network. No API
    // request (including a same-origin proxy) can escape the fetch mock.
    await context.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        const decodedPath = decodeURIComponent(url.pathname);
        const inProject = process.platform === "win32" ? decodedPath.toLowerCase().startsWith(fsRoot.toLowerCase()) : decodedPath.startsWith(fsRoot);
        const pathname = inProject ? `/${decodedPath.slice(fsRoot.length)}` : decodedPath;
        const allowed = url.origin === origin && request.method() === "GET" && (
            ["/phase4-test", "/tests/ollalink-phase4-harness.jsx", "/@vite/client", "/@react-refresh", "/favicon.ico"].includes(pathname) ||
            pathname.startsWith("/node_modules/") || pathname.startsWith("/src/lib/") ||
            pathname === "/src/components/DiarizationPanel.jsx"
        );
        const entry = { url: request.url(), method: request.method(), allowed };
        networkLedger.push(entry);
        if (allowed) return route.continue();
        unexpected.push(entry);
        return route.abort("blockedbyclient");
    });
    await context.routeWebSocket(/.*/, socket => {
        const url = new URL(socket.url());
        const allowed = url.origin === origin.replace("http:", "ws:") && url.pathname === "/";
        const entry = { url: socket.url(), method: "WEBSOCKET", allowed };
        networkLedger.push(entry);
        if (allowed) return socket.connectToServer();
        unexpected.push(entry);
        socket.close();
    });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
    await context.addInitScript(() => {
        window.fetchLedger = [];
        window.nativeDecodes = 0;
        const decode = AudioContext.prototype.decodeAudioData;
        AudioContext.prototype.decodeAudioData = function (...args) {
            window.nativeDecodes++;
            return decode.apply(this, args); // observe, never replace native decoding
        };
        window.calls = [];
        window.mode = "success";
        window.response = () => Response.json({
            model: "nemotron-3-diarization", duration: 4,
            speakers: ["speaker_1", "speaker_2"], segments: [{ start: 0, end: 2, speaker: "speaker_1" }, { start: 2, end: 4, speaker: "speaker_2" }]
        });
        window.fetch = (url, options) => {
            const entry = { url: String(url), method: options?.method || "GET", mode: window.mode, mocked: url === "/api/diarization" };
            window.fetchLedger.push(entry);
            if (!entry.mocked) {
                // Disallow even fetches that would otherwise bypass HTTP routing.
                return Promise.reject(new Error("Unexpected fetch blocked"));
            }
            window.calls.push(options.signal);
            if (window.mode === "pending") return new Promise(resolve => { window.finish = () => resolve(window.response()); });
            const raw = "RAW_PROVIDER_SECRET stack trace https://upstream.invalid/private";
            if (window.mode === "error") return Promise.resolve(new Response(raw, { status: 503 }));
            if (window.mode === "429" || window.mode === "504") return Promise.resolve(new Response(raw, { status: Number(window.mode) }));
            if (window.mode === "malformed") return Promise.resolve(new Response(`{${raw}`, { headers: { "Content-Type": "application/json" } }));
            if (window.mode === "network") return Promise.reject(new TypeError(raw));
            return Promise.resolve(window.response());
        };
    });
    const reset = async () => {
        if (page.url() !== "about:blank") fetchLedger.push(...await page.evaluate(() => window.fetchLedger));
        await page.goto(`${origin}/phase4-test`);
        try {
            await page.getByLabel("Speaker detection provider").waitFor();
        } catch (error) {
            console.error(JSON.stringify({ errors, consoleErrors, unexpected, networkLedger, fetchLedger: await page.evaluate(() => window.fetchLedger) }, null, 2));
            throw error;
        }
    };
    const cloud = () => page.getByLabel("Speaker detection provider").selectOption("ollalink");
    const detect = () => page.getByRole("button", { name: "Detect speakers with Ollalink", exact: true });
    const apply = () => page.getByRole("button", { name: "Apply reviewed speaker labels", exact: true });
    const state = () => page.evaluate(() => window.fixture.captions);
    await reset();
    assert.equal(await page.getByLabel("Speaker detection provider").inputValue(), "local");
    assert.equal(await page.evaluate(() => window.calls.length), 0);
    await cloud();
    assert.equal(await page.evaluate(() => window.calls.length), 0);
    const original = await state();
    await detect().dblclick();
    await apply().waitFor();
    assert.equal(await page.evaluate(() => window.calls.length), 1);
    assert.deepEqual(await state(), original);
    await apply().click();
    await page.waitForFunction(() => window.fixture.captions[0].speaker?.startsWith("ollalink:"));
    const applied = await state();
    assert.equal(applied[2].speaker, "Alice");
    assert.deepEqual(applied.map(({ speaker: _speaker, ...rest }) => rest), original.map(({ speaker: _speaker, ...rest }) => rest));
    assert.equal(await page.evaluate(() => window.nativeDecodes), 1);
    assert.equal(await page.evaluate(() => window.fixture.applyCalls.current), 1);
    checks.push("local default, explicit opt-in, native decode, duplicate protection, review/apply preserves timing/text/manual labels");

    await reset(); await cloud();
    const discardOriginal = await state();
    await detect().click(); await apply().waitFor();
    await page.getByRole("button", { name: "Discard speaker review", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Review discarded. Captions are unchanged." }).waitFor();
    assert.equal(await apply().count(), 0);
    await page.waitForTimeout(150);
    assert.deepEqual(await state(), discardOriginal);
    assert.equal(await page.evaluate(() => window.calls.length), 1);
    assert.equal(await page.evaluate(() => window.fixture.applyCalls.current), 0);
    assert.equal(await detect().isEnabled(), true);
    checks.push("explicit discard removes review, preserves all data and does not retry or apply");

    await reset(); await cloud();
    const switchOriginal = await state();
    await detect().click(); await apply().waitFor();
    await page.getByLabel("Speaker detection provider").selectOption("local");
    assert.equal(await apply().count(), 0);
    await cloud();
    await page.waitForTimeout(150);
    assert.equal(await apply().count(), 0);
    assert.deepEqual(await state(), switchOriginal);
    assert.equal(await page.evaluate(() => window.calls.length), 1);
    assert.equal(await page.evaluate(() => window.fixture.applyCalls.current), 0);
    assert.equal(await detect().isEnabled(), true);
    checks.push("completed review is permanently discarded by provider switch, including switch back");

    for (const mode of ["caption", "source", "lock", "blob"]) {
        await reset(); await cloud(); await detect().click(); await apply().waitFor();
        await page.evaluate(mode => {
            if (mode === "caption") window.fixture.setCaptions(items => items.map((item, i) => i ? item : { ...item, text: "Manual edit" }));
            if (mode === "source") window.fixture.setSource(item => ({ ...item, start: 20 }));
            if (mode === "lock") window.fixture.setLocked(true);
            if (mode === "blob") window.fixture.setSource(item => ({ ...item, blob: new Blob(["changed"]) }));
        }, mode);
        await page.waitForFunction(() => document.querySelector('button') !== null);
        assert.equal(await apply().isDisabled(), true);
        if (mode === "lock") {
            await page.evaluate(() => window.fixture.setLocked(false));
            await page.waitForTimeout(20);
            assert.equal(await apply().isDisabled(), true);
        }
        assert.equal((await state())[0].speaker, undefined);
    }
    checks.push("caption edits, source moves, lock and blob replacement invalidate review");
    for (const mode of ["cancel", "edit", "local", "unmount", "source", "lock", "blob"]) {
        await reset(); await cloud();
        const pendingOriginal = await state();
        await page.evaluate(() => { window.mode = "pending"; });
        await detect().click();
        await page.waitForFunction(() => window.calls.length === 1);
        if (mode === "cancel") await page.getByRole("button", { name: "Cancel speaker detection" }).click();
        if (mode === "local") await page.getByLabel("Speaker detection provider").selectOption("local");
        if (mode === "edit") await page.evaluate(() => window.fixture.setCaptions(items => items.map(item => ({ ...item, text: "Edited" }))));
        if (mode === "unmount") await page.evaluate(() => window.fixture.setMounted(false));
        if (mode === "source") await page.evaluate(() => window.fixture.setSource(item => ({ ...item, start: 20 })));
        if (mode === "blob") await page.evaluate(() => window.fixture.setSource(item => ({ ...item, blob: new Blob(["changed"]) })));
        if (mode === "lock") await page.evaluate(() => window.fixture.setLocked(true));
        await page.waitForFunction(() => window.calls[0].aborted);
        await page.evaluate(() => window.finish());
        if (mode === "lock") await page.evaluate(() => window.fixture.setLocked(false));
        await page.waitForTimeout(150);
        assert.equal(await apply().count(), 0);
        assert.deepEqual(await state(), mode === "edit" ? pendingOriginal.map(item => ({ ...item, text: "Edited" })) : pendingOriginal);
        assert.equal(await page.evaluate(() => window.fixture.applyCalls.current), 0);
        assert.equal(await page.evaluate(() => window.calls.length), 1);
        checks.push(`pending ${mode}: aborted signal, ignored late result, no mutation/apply/retry`);
    }
    for (const [mode, safeStatus] of [
        ["error", "Speaker detection failed. Existing captions are unchanged."],
        ["429", "Speaker detection is busy. Try later."],
        ["504", "Speaker detection timed out. Nothing was applied."],
        ["malformed", "The provider returned invalid speaker turns. Nothing was applied."],
        ["network", "Speaker detection failed. Existing captions are unchanged."],
    ]) {
        await reset(); await cloud();
        const beforeFailure = await state();
        await page.evaluate(mode => { window.mode = mode; }, mode);
        await detect().click();
        await page.getByRole("status").filter({ hasText: safeStatus }).waitFor();
        assert.equal(await page.getByRole("status").textContent(), safeStatus);
        assert.doesNotMatch(await page.locator("body").innerText(), /RAW_PROVIDER_SECRET|stack trace|upstream\.invalid/);
        assert.equal(await apply().count(), 0);
        assert.deepEqual(await state(), beforeFailure);
        assert.equal(await page.evaluate(() => window.fixture.applyCalls.current), 0);
        await page.waitForTimeout(200);
        assert.equal(await page.evaluate(() => window.calls.length), 1);
        await page.getByLabel("Speaker detection provider").selectOption("local");
        await cloud();
        await page.waitForTimeout(150);
        assert.equal(await page.evaluate(() => window.calls.length), 1);
        assert.deepEqual(await state(), beforeFailure);
        // Changing backend response or provider never retries; only this click does.
        await page.evaluate(() => { window.mode = "success"; });
        await detect().click(); await apply().waitFor();
        assert.equal(await page.evaluate(() => window.calls.length), 2);
        assert.equal(await page.evaluate(() => window.nativeDecodes), 2);
        assert.deepEqual(await state(), beforeFailure);
        assert.equal(await page.evaluate(() => window.fixture.applyCalls.current), 0);
        await apply().click();
        await page.waitForFunction(() => window.fixture.applyCalls.current === 1);
        const afterRetry = await state();
        assert.match(afterRetry[0].speaker, /^ollalink:[a-zA-Z0-9-]+:speaker_1$/);
        assert.equal(afterRetry[1].speaker, afterRetry[0].speaker.replace(/speaker_1$/, "speaker_2"));
        assert.deepEqual(afterRetry, beforeFailure.map((item, i) => i < 2 ? { ...item, speaker: afterRetry[i].speaker } : item));
        assert.equal(await apply().count(), 0);
        await page.waitForTimeout(150);
        assert.equal(await page.evaluate(() => window.fixture.applyCalls.current), 1);
        assert.equal(await page.evaluate(() => window.calls.length), 2);
        checks.push(`${mode}: exact safe status, no raw errors or automatic retry; explicit retry adds one call, no mutation before one apply`);
    }
    fetchLedger.push(...await page.evaluate(() => window.fetchLedger));
    assert.deepEqual(errors, []);
    assert.doesNotMatch(consoleErrors.join("\n"), /RAW_PROVIDER_SECRET|stack trace|upstream\.invalid/);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(fetchLedger.filter(entry => !entry.mocked), []);
    console.log(JSON.stringify({
        mocked: true, pass: true, checks, pageErrors: errors.length, consoleErrors,
        unexpectedRequests: unexpected.length, unexpectedFetches: fetchLedger.filter(entry => !entry.mocked).length,
        mockedBackendCalls: fetchLedger.length, networkLedger, fetchLedger,
    }, null, 2));
} finally {
    await browser?.close();
    await vite.close();
}
