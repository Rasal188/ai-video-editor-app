import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const evidence = await fs.mkdtemp(path.resolve("scratch/shorts-notification-fix-20261102/browser-"));
const report = { simulatedJobs: true, realApp: true, liveProviderCalls: 0, checks: [], layouts: [], blocked: [], pageErrors: [] };
let vite;
let browser;
let page;
try {
    vite = await createServer({
        configFile: false, envFile: false, cacheDir: path.join(evidence, "vite-cache"),
        plugins: [react(), {
            name: "shorts-notification-test-boundary",
            transform(code, id) {
                const file = id.replaceAll("\\", "/");
                if (file.endsWith("/src/hooks/useEditorCatalog.js")) return code.replace("https://commons.wikimedia.org/w/api.php?", "/__catalog/commons?").replace("https://api.pexels.com/v1/", "/__catalog/pexels/").replace("https://api.openverse.org/v1/audio/?", "/__catalog/audio?");
                if (file.endsWith("/src/hooks/useShortsStudio.js")) {
                    const anchor = "  return {\n    isOpen,";
                    const normalized = code.replaceAll("\r\n", "\n");
                    assert.ok(normalized.includes(anchor), "test injection anchor unchanged");
                    return normalized.replace(anchor, `  window.__shortsTest = { setJob, setCandidates, setStage, setIsOpen, setIsMinimized, setActiveCandidateId, setSelectedCandidateIds, open, minimize, restore, close, cancelAnalysis };
${anchor}`);
                }
            },
            configureServer(server) {
                server.middlewares.use("/shorts-notification-test", async (_req, res) => {
                    res.setHeader("Content-Type", "text/html");
                    res.end(await server.transformIndexHtml("/shorts-notification-test", '<div id="root"></div><script type="module" src="/tests/shorts-notification-harness.jsx"></script>'));
                });
            },
        }],
        server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**/scratch/**"] } },
    });
    await vite.listen();
    const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, args: ["--disable-background-networking", "--disable-component-update", "--no-default-browser-check"] });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block" });
    await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) { report.blocked.push(url.href); return route.abort("blockedbyclient"); }
        if (url.pathname.startsWith("/__catalog/")) return route.fulfill({ json: { query: { pages: {} }, results: [], photos: [], videos: [] } });
        if (url.pathname === "/api/assistant/plan") {
            report.planRequests = (report.planRequests || 0) + 1;
            return route.fulfill({ json: { plan: { schemaVersion: 1, explanation: "Local notification regression proposal", actions: [{ type: "marker.add", params: { time: 1, title: "Notification regression" } }] } } });
        }
        if (url.pathname.startsWith("/api/") || (/\.(onnx|wasm|safetensors|bin)$/i.test(url.pathname) && !url.searchParams.has("url"))) { report.blocked.push(url.href); return route.abort("blockedbyclient"); }
        return route.continue();
    });
    await context.addInitScript(() => {
        localStorage.setItem("ai-voiceover-ui-language", "en");
        localStorage.setItem("timeline_studio_first_visual_guide_seen", "1");
    });
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on("pageerror", error => report.pageErrors.push(error.stack || error.message));
    await page.goto(`${origin}/shorts-notification-test`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.locator(".editor-grid").waitFor({ timeout: 90000 });
    await page.waitForFunction(() => Boolean(window.__shortsTest));
    await page.evaluate(() => window.dispatchEvent(new Event("test:open-ai-assistant")));
    const input = page.getByTestId("ai-assistant-prompt-input");
    const notice = page.getByTestId("shorts-background-notification");
    await input.waitFor();
    await page.clock.install();
    const complete = async (running = false) => {
        await page.evaluate(running => {
            const s = window.__shortsTest;
            s.setCandidates([{ id: "notification-candidate", title: "Retained review candidate", startTime: 0, endTime: 12, duration: 12, score: 90, reason: "UI fixture only", category: "highlight" }]);
            s.setSelectedCandidateIds(new Set(["notification-candidate"]));
            s.setActiveCandidateId("notification-candidate");
            s.setStage("review");
            s.setJob({ running, progress: running ? 50 : 100, phase: running ? "Discovering moments" : "", transcriptionOutcome: { status: "succeeded", requestedProvider: "ollalink", provider: "ollalink-fast", fallbackAttempted: false, fallbackUsed: false } });
            s.setIsOpen(true);
            s.setIsMinimized(true);
        }, running);
        await notice.first().waitFor();
        await page.waitForTimeout(100);
    };
    const geometry = async () => page.evaluate(() => {
        const selectors = ['[data-testid="ai-assistant-prompt-input"]', '[data-testid="ai-assistant-generate-btn"]', '[data-testid="video-gen-attach-image-btn"]', '[data-testid="video-gen-attach-video-btn"]'];
        const region = document.querySelector(".shorts-notification-region").getBoundingClientRect();
        return selectors.map(selector => {
            const element = document.querySelector(selector);
            const r = element.getBoundingClientRect();
            const points = [0.15, 0.5, 0.85].flatMap(x => [0.2, 0.5, 0.8].map(y => [r.x + x * r.width, r.y + y * r.height]));
            return { selector, rect: { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom }, inViewport: r.x >= 0 && r.y >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1, unobstructed: points.every(([x, y]) => element.contains(document.elementFromPoint(x, y))), overlapsNotice: r.left < region.right && r.right > region.left && r.top < region.bottom && r.bottom > region.top };
        });
    });
    const assertAccessible = async label => {
        const controls = await geometry();
        report.layouts.push({ label, viewport: page.viewportSize(), controls });
        for (const c of controls) {
            assert.ok(c.inViewport, `${label}: control stays in viewport: ${c.selector}`);
            assert.ok(c.unobstructed, `${label}: control hit-testable: ${c.selector}`);
            assert.equal(c.overlapsNotice, false, `${label}: no notification overlap: ${c.selector}`);
        }
    };
    await input.fill("Keep typing");
    await input.focus();
    await complete();
    assert.equal(await input.evaluate(el => document.activeElement === el), true);
    await input.pressSequentially(" while Shorts completes");
    assert.equal(await input.inputValue(), "Keep typing while Shorts completes");
    assert.match(await notice.innerText(), /Transcript ready — Ollalink fast\./);
    await assertAccessible("completion while typing");
    report.checks.push("completion preserves Assistant focus and draft; textarea and controls pass nine-point hit tests");

    // Reapply the original positioning in the browser to establish the obstruction,
    // without rewriting or reverting any pre-existing source work.
    const oldStyle = await page.addStyleTag({ content: '.shorts-notification-region .shorts-minimized-floating-banner {position:fixed!important;bottom:2rem!important;right:2rem!important;z-index:1300!important;min-width:320px!important;max-width:440px!important;width:auto!important;}' });
    const oldControls = await geometry();
    assert.ok(oldControls.some(c => !c.unobstructed), "original fixed placement obstructs composer controls");
    report.originalPositioningReproduced = oldControls;
    await oldStyle.evaluate(el => el.remove());
    await assertAccessible("fixed placement removed");
    report.checks.push("original fixed bottom-right placement reproduces obstruction; reserved-row placement removes it");

    for (const kind of ["image", "video"]) {
        const chooserPromise = page.waitForEvent("filechooser");
        await page.getByTestId(`video-gen-attach-${kind}-btn`).click();
        const chooser = await chooserPromise;
        assert.equal(await chooser.element().getAttribute("data-testid"), `video-gen-${kind}-file-input`);
    }
    await input.fill("Please suggest one chapter marker");
    await page.getByTestId("ai-assistant-generate-btn").click();
    await page.getByTestId("ai-assistant-apply-btn").last().waitFor();
    assert.equal(report.planRequests, 1);
    report.checks.push("both attachment buttons open their file choosers; Send reaches local mocked planning and review");
    await notice.getByRole("button", { name: "Review", exact: true }).click();
    await page.locator(".shorts-workspace-layout").waitFor();
    assert.match(await page.locator(".shorts-workspace-layout").innerText(), /Retained review candidate/);
    assert.equal(await notice.count(), 0);
    report.checks.push("Review restores existing Shorts workspace and retained candidate/selection");
    await page.evaluate(() => window.__shortsTest.minimize());
    await notice.waitFor();
    await notice.getByRole("button", { name: "Dismiss notification" }).click();
    assert.equal(await notice.count(), 0);
    await page.evaluate(() => window.__shortsTest.open());
    await page.locator(".shorts-workspace-layout").waitFor();
    assert.match(await page.locator(".shorts-workspace-layout").innerText(), /Retained review candidate/);
    report.checks.push("Dismiss hides only notice; topbar/open workflow retains candidates");

    await complete(true);
    await page.mouse.move(0, 300);
    await page.clock.runFor(12000);
    assert.equal(await notice.count(), 1, "running progress does not expire");
    await notice.getByRole("button", { name: "Dismiss notification" }).click();
    await complete(false);
    assert.equal(await notice.count(), 1, "completion reappears after dismissed running progress");
    await notice.hover();
    await page.clock.runFor(12000);
    assert.equal(await notice.count(), 1, "hover pauses expiry");
    await page.mouse.move(0, 300);
    await notice.getByRole("button", { name: "Review", exact: true }).focus();
    await page.clock.runFor(12000);
    assert.equal(await notice.count(), 1, "keyboard focus pauses expiry");
    await input.focus();
    await input.fill("Draft survives expiry");
    await page.clock.runFor(10050);
    await notice.waitFor({ state: "hidden" });
    assert.equal(await input.inputValue(), "Draft survives expiry");
    assert.equal(await input.evaluate(el => document.activeElement === el), true);
    report.checks.push("active progress persists; completion resurfaces, hover/focus pauses, and 10-second expiry preserves draft/focus");
    await complete(true);
    await notice.getByRole("button", { name: "Dismiss notification" }).click();
    await complete(false);
    await page.mouse.move(0, 300);
    await input.focus();
    await page.clock.runFor(10050);
    await notice.waitFor({ state: "hidden" });
    report.checks.push("dismissing active progress does not leave the next completion timer paused");

    await page.evaluate(() => window.__shortsTest.close());
    await complete();
    await page.evaluate(() => window.__extraShortsNotices(5));
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="shorts-background-notification"]').length === 6);
    assert.equal(await page.locator(".shorts-notification-region").evaluate(el => el.scrollHeight > el.clientHeight), true);
    for (const [width, height] of [[1600, 1000], [1366, 768], [1024, 768], [769, 700], [768, 700], [760, 700], [390, 844], [320, 568], [844, 390]]) {
        await page.setViewportSize({ width, height });
        await page.waitForTimeout(350);
        await assertAccessible(`stacked notices ${width}x${height}`);
        await input.fill(`Typing at ${width}x${height}`);
        assert.equal(await input.inputValue(), `Typing at ${width}x${height}`);
        if (width === 390 || width === 1366) await page.screenshot({ path: path.join(evidence, `stacked-${width}.png`) });
    }
    report.checks.push("six stacked notices scroll in bounded region; all composer controls accessible through nine responsive sizes");
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.waitForTimeout(350);
    await notice.last().getByRole("button", { name: "Review", exact: true }).click();
    assert.equal(await page.evaluate(() => window.__extraReview), 4);
    await notice.last().getByRole("button", { name: "Dismiss notification" }).click();
    assert.equal(await notice.count(), 5);
    await page.evaluate(() => window.__extraShortsNotices(0));
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="shorts-background-notification"]').length === 1);
    await notice.getByRole("button", { name: "Dismiss notification" }).click();
    await page.waitForTimeout(100);
    assert.equal(await page.locator(".shorts-notification-region").evaluate(el => el.getBoundingClientRect().height), 0);
    report.checks.push("stacked Review routes to its own producer, dismissal removes one card, empty region releases layout space");
    await complete(true);
    await notice.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="shorts-background-notification"]').textContent.includes("View Progress"));
    report.checks.push("existing active-job Cancel remains wired");
    assert.deepEqual(report.pageErrors, []);
    report.passed = true;
} catch (error) {
    report.passed = false;
    report.error = error.stack || String(error);
    if (page) report.layoutDebug = await page.evaluate(() => [".app-shell", ".ai-assistant-panel", ".ai-assistant-panel-body", ".ai-assistant-input-tray", ".shorts-notification-region"].map(selector => { const el = document.querySelector(selector); const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return { selector, height: r.height, top: r.top, rows: s.gridTemplateRows, columns: s.gridTemplateColumns, minHeight: s.minHeight, overflow: s.overflow, flex: s.flex }; }));
    if (page) await page.screenshot({ path: path.join(evidence, "failure.png") }).catch(() => { });
    process.exitCode = 1;
} finally {
    await fs.writeFile(path.join(evidence, "results.json"), JSON.stringify(report, null, 2));
    await browser?.close();
    await vite?.close();
    console.log(JSON.stringify({ evidence, ...report }, null, 2));
}
