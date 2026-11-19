/**
 * Playwright E2E: AI Assistant -> retained Remove Pauses / AI Rough Cut workflows.
 *
 * Planning is mocked to avoid external model calls. Media decoding, VAD analysis,
 * Smart review UI, timeline application, ripple editing, and undo use production code.
 */

import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const DEV_SERVER_URL = process.env.EDITOR_URL || "http://localhost:5187/?view=editor";
const VITE_ORIGIN = new URL(DEV_SERVER_URL).origin;
const SAMPLE_MEDIA_PATH = resolve("test-artifacts/silence-test-sample.mp4");
const NO_AUDIO_MEDIA_PATH = resolve("test-artifacts/no-audio-sample.mp4");
const ARTIFACTS_DIR = resolve("test-artifacts/playwright-assistant-smart-tools");

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function isServerRunning(url) {
    try {
        const response = await fetch(url, { method: "HEAD" });
        return response.ok || response.status < 500;
    } catch {
        return false;
    }
}

async function startViteIfNeeded() {
    if (await isServerRunning(VITE_ORIGIN)) return () => { };

    console.log("Starting Vite dev server...");
    const vite = spawn("npx", ["vite", "--port", new URL(VITE_ORIGIN).port || "5173", "--host", "localhost"], {
        stdio: "pipe",
        shell: true,
    });

    let output = "";
    vite.stdout?.on("data", (chunk) => { output += chunk.toString(); });
    vite.stderr?.on("data", (chunk) => { output += chunk.toString(); });

    for (let attempt = 0; attempt < 40; attempt += 1) {
        if (await isServerRunning(VITE_ORIGIN)) {
            return () => {
                try { vite.kill(); } catch { /* ignore */ }
            };
        }
        if (vite.exitCode !== null) throw new Error(`Vite exited before startup.\n${output}`);
        await sleep(500);
    }

    try { vite.kill(); } catch { /* ignore */ }
    throw new Error(`Timed out waiting for Vite.\n${output}`);
}

async function resolveBrowserLauncher() {
    const customExecutable = process.env.BROWSER_EXECUTABLE_PATH;
    if (customExecutable && existsSync(customExecutable)) return { executablePath: customExecutable };
    if (process.env.BROWSER_CHANNEL) return { channel: process.env.BROWSER_CHANNEL };

    for (const options of [{}, { channel: "chrome" }, { channel: "msedge" }]) {
        try {
            const browser = await chromium.launch({ ...options, headless: true });
            await browser.close();
            return options;
        } catch {
            // Try the next installed browser.
        }
    }
    return {};
}

async function submitPrompt(page, prompt) {
    const input = page.locator('[data-testid="ai-assistant-prompt-input"]');
    await input.fill(prompt);
    await page.locator('[data-testid="ai-assistant-generate-btn"]').click();
}

async function waitForLatestProposal(page) {
    const apply = page.locator('[data-testid="ai-assistant-apply-btn"]').last();
    await apply.waitFor({ state: "visible", timeout: 10000 });
    return apply;
}

async function waitForProjectStability(page, { stableFor = 2000, timeout = 20000 } = {}) {
    const startedAt = Date.now();
    let stableSince = 0;
    let previousToken = "";

    while (Date.now() - startedAt < timeout) {
        const token = await page.evaluate(() => {
            if (typeof window.__PROJECT_SNAPSHOT__ !== "function") return "";
            const snapshot = window.__PROJECT_SNAPSHOT__();
            const { commandState, timelineZoom: _timelineZoom, ...content } = snapshot || {};
            return JSON.stringify({
                revision: commandState?.revision ?? -1,
                changing: Boolean(commandState?.changing),
                content,
            });
        });

        if (token && token === previousToken) {
            if (!stableSince) stableSince = Date.now();
            if (Date.now() - stableSince >= stableFor) return;
        } else {
            previousToken = token;
            stableSince = token ? Date.now() : 0;
        }

        await page.waitForTimeout(250);
    }

    throw new Error("Project did not become stable before Assistant planning");
}

async function openNewProject(page) {
    await page.locator(".project-file-button").click();
    const newProject = page.locator(".file-menu-new");
    if (await newProject.isVisible({ timeout: 1500 }).catch(() => false)) await newProject.click();
    await page.waitForTimeout(500);
}

async function run() {
    if (!existsSync(SAMPLE_MEDIA_PATH)) throw new Error(`Missing fixture: ${SAMPLE_MEDIA_PATH}`);
    if (!existsSync(NO_AUDIO_MEDIA_PATH)) throw new Error(`Missing fixture: ${NO_AUDIO_MEDIA_PATH}`);
    mkdirSync(ARTIFACTS_DIR, { recursive: true });

    const stopVite = await startViteIfNeeded();
    const launcher = await resolveBrowserLauncher();
    const browser = await chromium.launch({
        ...launcher,
        headless: process.env.HEADED !== "1",
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
    await context.addInitScript(() => {
        localStorage.setItem("timeline_studio_ui_language", "en");
        localStorage.setItem("timeline-studio-ui-language", "en");
        localStorage.setItem("timeline-studio-first-visual-guide-seen-v1", "1");
        localStorage.setItem("timeline_studio_first_visual_guide_seen", "1");
        window.addEventListener("beforeunload", () => console.warn("[E2E] beforeunload fired"));
        window.addEventListener("unload", () => console.warn("[E2E] unload fired"));
    });

    const page = await context.newPage();
    page.on("pageerror", (error) => console.error(`[Browser PageError] ${error.message}`));
    page.on("console", (message) => {
        if (["error", "warning"].includes(message.type())) console.log(`[Browser ${message.type()}] ${message.text()}`);
    });
    page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) console.log(`[Browser Navigation] ${frame.url()}`);
    });
    page.on("requestfailed", (request) => console.log(`[Browser Request Failed] ${request.method()} ${request.url()} — ${request.failure()?.errorText || "unknown"}`));
    page.on("crash", () => console.error("[Browser Crash] Renderer crashed"));
    page.on("dialog", (dialog) => dialog.accept().catch(() => { }));

    await page.route("**/api/auth/me", (route) => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ user: { id: "assistant-smart-e2e", email: "assistant-smart@example.com" } }),
    }));

    await page.route("**/api/assistant/plan", async (route) => {
        const body = route.request().postDataJSON();
        const prompt = String(body?.prompt || "").toLowerCase();

        if (prompt.includes("how does remove pauses")) {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    ok: true,
                    isInformational: true,
                    message: "Remove Pauses analyzes silent gaps and opens a review. The timeline changes only after you confirm Apply.",
                }),
            });
            return;
        }

        const roughCut = prompt.includes("rough cut");
        const action = roughCut
            ? {
                id: `rough-${Date.now()}`,
                type: "tool.rough_cut",
                description: "Analyze pauses for AI Rough Cut review",
                params: { removeFillerWords: false },
            }
            : {
                id: `pauses-${Date.now()}`,
                type: "tool.silence_removal",
                description: "Analyze silent gaps for Remove Pauses review",
                params: {},
            };

        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                ok: true,
                plan: {
                    schemaVersion: 1,
                    explanation: roughCut ? "Create a clean rough cut from this footage." : "Remove silent gaps from this video.",
                    actions: [action],
                    prerequisites: [],
                    warnings: [],
                    assumptions: [],
                },
            }),
        });
    });

    try {
        console.log(`Navigating to ${DEV_SERVER_URL}`);
        await page.goto(DEV_SERVER_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.locator(".editor-grid").waitFor({ state: "visible", timeout: 25000 });

        const language = page.locator(".language-grid button, .language-intro button").filter({ hasText: "English" }).first();
        if (await language.isVisible({ timeout: 1500 }).catch(() => false)) await language.click();

        const fileInput = page.locator("input.sr-only[type='file']").first();
        await fileInput.setInputFiles(SAMPLE_MEDIA_PATH);
        await page.locator('[data-timeline-segment-track="image"]').waitFor({ state: "visible", timeout: 15000 });

        const guideDismiss = page.locator(".first-visual-guide-dismiss, .first-visual-guide button").first();
        if (await guideDismiss.isVisible({ timeout: 1000 }).catch(() => false)) await guideDismiss.click();

        await waitForProjectStability(page);
        const initialClips = await page.locator('[data-timeline-segment-track="image"]').count();
        if (initialClips !== 1) throw new Error(`Expected one initial clip, found ${initialClips}`);

        await page.locator('[data-testid="topbar-ai-assistant-btn"]').click();
        await page.locator('[data-testid="ai-assistant-panel"]').waitFor({ state: "visible", timeout: 5000 });

        console.log("Checking informational safety...");
        await submitPrompt(page, "How does Remove Pauses work?");
        await page.getByText(/timeline changes only after you confirm Apply/i).last().waitFor({ state: "visible", timeout: 10000 });
        if (await page.locator('[data-testid="ai-assistant-apply-btn"]').count()) {
            throw new Error("Informational Remove Pauses question unexpectedly created an actionable plan");
        }
        if (await page.locator('[data-timeline-segment-track="image"]').count() !== initialClips) {
            throw new Error("Informational question changed the timeline");
        }

        console.log("Running Assistant-initiated Remove Pauses analysis...");
        await submitPrompt(page, "Remove the silent gaps from this video.");
        await (await waitForLatestProposal(page)).click();

        const pauseReview = page.locator('[data-testid="pause-review"]');
        await pauseReview.waitFor({ state: "visible", timeout: 35000 });
        await page.locator(".ai-assistant-status-tag.is-review-ready").last().waitFor({ state: "visible", timeout: 5000 });
        const reviewText = await page.locator(".ai-assistant-message").last().innerText().catch(() => page.locator('[data-testid="ai-assistant-panel"]').innerText());
        if (!/timeline is unchanged until you confirm Apply/i.test(reviewText)) {
            throw new Error(`Missing non-destructive review message: ${reviewText}`);
        }
        if (await page.locator('[data-timeline-segment-track="image"]').count() !== initialClips) {
            throw new Error("Remove Pauses analysis mutated the timeline before Apply");
        }

        console.log("Dismissing Assistant-opened review...");
        await page.locator('[data-testid="pause-cancel-review-btn"]').click();
        await page.locator(".ai-assistant-status-tag.is-rejected").last().waitFor({ state: "visible", timeout: 5000 });
        if (await page.locator('[data-timeline-segment-track="image"]').count() !== initialClips) {
            throw new Error("Dismissed Remove Pauses review changed the timeline");
        }

        console.log("Re-running Remove Pauses and applying candidates...");
        await submitPrompt(page, "Remove dead air without cutting off any words.");
        await (await waitForLatestProposal(page)).click();
        await pauseReview.waitFor({ state: "visible", timeout: 35000 });
        await page.locator('[data-testid="pause-apply-btn"]').click();
        await page.locator(".ai-assistant-status-tag.is-applied").last().waitFor({ state: "visible", timeout: 5000 });
        await page.waitForTimeout(800);

        const clipsAfterApply = await page.locator('[data-timeline-segment-track="image"]').count();
        if (clipsAfterApply <= initialClips) throw new Error(`Expected cuts after Apply, found ${clipsAfterApply} clips`);

        console.log("Undoing applied Remove Pauses edit...");
        await page.keyboard.press("Control+z");
        await page.waitForTimeout(800);
        const clipsAfterUndo = await page.locator('[data-timeline-segment-track="image"]').count();
        if (clipsAfterUndo !== initialClips) throw new Error(`Undo did not restore the original clip count: ${clipsAfterUndo}`);

        console.log("Running Assistant-initiated AI Rough Cut analysis...");
        await submitPrompt(page, "Create a clean rough cut from this footage.");
        await (await waitForLatestProposal(page)).click();
        const roughReview = page.locator('[data-testid="rough-cut-review"]');
        await roughReview.waitFor({ state: "visible", timeout: 35000 });
        await page.locator(".ai-assistant-status-tag.is-review-ready").last().waitFor({ state: "visible", timeout: 5000 });
        if (await page.locator('[data-timeline-segment-track="image"]').count() !== initialClips) {
            throw new Error("Rough Cut analysis mutated the timeline before Apply");
        }
        await page.locator('[data-testid="rough-cut-cancel-btn"]').click();
        await page.locator(".ai-assistant-status-tag.is-rejected").last().waitFor({ state: "visible", timeout: 5000 });

        console.log("Checking unsupported no-audio safety through the Assistant...");
        await openNewProject(page);
        await fileInput.setInputFiles(NO_AUDIO_MEDIA_PATH);
        await page.locator('[data-timeline-segment-track="image"]').waitFor({ state: "visible", timeout: 15000 });
        await waitForProjectStability(page);
        await submitPrompt(page, "Remove the silent gaps from this video.");
        await (await waitForLatestProposal(page)).click();
        await page.locator(".ai-assistant-error-banner").filter({ hasText: /Remove Pauses analysis failed/i }).waitFor({ state: "visible", timeout: 15000 });
        const assistantText = await page.locator('[data-testid="ai-assistant-panel"]').innerText();
        if (!/analysis failed|supported video clip|usable source media/i.test(assistantText)) {
            throw new Error(`Expected safe unsupported/failed analysis message, got: ${assistantText}`);
        }

        const screenshot = resolve(ARTIFACTS_DIR, "assistant-smart-tools-success.png");
        await page.screenshot({ path: screenshot, fullPage: true });
        console.log(`Captured ${screenshot}`);
        console.log("Assistant Smart Tools browser E2E passed.");
    } catch (error) {
        const screenshot = resolve(ARTIFACTS_DIR, "assistant-smart-tools-failure.png");
        await page.screenshot({ path: screenshot, fullPage: true }).catch(() => { });
        console.error(`Failure screenshot: ${screenshot}`);
        throw error;
    } finally {
        await context.close().catch(() => { });
        await browser.close().catch(() => { });
        stopVite();
    }
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
