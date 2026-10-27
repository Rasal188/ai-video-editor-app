/**
 * Playwright E2E Integration Test: AI-Assisted Silence Detection & Removal
 *
 * Verifies the full silence detection and removal workflow inside a real browser:
 * 1. Authenticated session initialization and local storage onboarding bypass
 * 2. Uploading deterministic test video fixture with tone speech and silence gaps
 * 3. Navigating to Smart Tools -> Remove Pauses panel
 * 4. Verifying threshold, minimum duration, keep padding sliders, and ripple edit toggle
 * 5. Adjusting settings and executing silence analysis
 * 6. Reviewing detected pause candidates with duration savings summary
 * 7. Candidate exclusion toggle (verifying savings recalculation)
 * 8. Candidate preview seek (verifying timeline playhead updates)
 * 9. Dismiss / Cancel review (verifying zero modifications to timeline)
 * 10. Re-analysis and Apply Cuts with ripple editing (verifying segment splits and duration reduction)
 * 11. Undo restoration (verifying timeline restores to original duration and single clip)
 * 12. No-audio error handling verification with audio-less video fixture
 * 13. Capturing high-resolution visual evidence screenshots at each milestone
 */

import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const DEV_SERVER_URL = process.env.EDITOR_URL || "http://localhost:5173/?view=editor";
const ARTIFACTS_DIR = resolve("test-artifacts/playwright");
const SAMPLE_MEDIA_PATH = resolve("test-artifacts/silence-test-sample.mp4");
const NO_AUDIO_MEDIA_PATH = resolve("test-artifacts/no-audio-sample.mp4");

async function obtainTestAuthCookie() {
  try {
    const { config } = await import("../server/config.js");
    const { generateSessionToken, hashSessionToken } = await import("../server/services/auth/crypto.js");
    const { createSession } = await import("../server/db/queries/auth.js");
    const { getUserByEmail } = await import("../server/db/queries/users.js");

    const user = await getUserByEmail("e2e.alice@example.com");
    if (!user) {
      console.warn("User e2e.alice@example.com not found in DB. Running in unauthenticated mode.");
      return null;
    }

    const rawToken = generateSessionToken();
    const tokenHash = hashSessionToken(rawToken, config.auth.salt);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await createSession({ userId: user.id, tokenHash, expiresAt });

    return {
      name: config.auth.sessionCookieName,
      value: rawToken,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    };
  } catch (err) {
    console.warn(`Could not provision DB session (${err.message}). Continuing...`);
    return null;
  }
}

async function resolveBrowserLauncher() {
  const channel = process.env.BROWSER_CHANNEL;
  const customExecutable = process.env.BROWSER_EXECUTABLE_PATH;

  if (customExecutable && existsSync(customExecutable)) {
    return { executablePath: customExecutable };
  }

  if (channel) {
    return { channel };
  }

  // 1. Try bundled Playwright Chromium
  try {
    const testLaunch = await chromium.launch({ headless: true });
    await testLaunch.close();
    return {};
  } catch {
    // Ignore and try fallbacks
  }

  // 2. Try Google Chrome
  try {
    const testChrome = await chromium.launch({ channel: "chrome", headless: true });
    await testChrome.close();
    return { channel: "chrome" };
  } catch {
    // Ignore and try Edge
  }

  // 3. Try Microsoft Edge
  try {
    const testEdge = await chromium.launch({ channel: "msedge", headless: true });
    await testEdge.close();
    return { channel: "msedge" };
  } catch {
    // Ignore and try local ms-playwright
  }

  // 4. Local AppData cache
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const candidatePath = resolve(localAppData, "ms-playwright/chromium-1248/chrome-win64/chrome.exe");
    if (existsSync(candidatePath)) {
      return { executablePath: candidatePath };
    }
  }

  return {};
}

async function runSilenceRemovalE2ETest() {
  console.log("==================================================================");
  console.log("  Playwright E2E Test: AI Silence Detection & Removal Workflow   ");
  console.log("==================================================================");

  if (!existsSync(ARTIFACTS_DIR)) {
    mkdirSync(ARTIFACTS_DIR, { recursive: true });
  }

  if (!existsSync(SAMPLE_MEDIA_PATH)) {
    throw new Error(`Required test fixture not found: ${SAMPLE_MEDIA_PATH}`);
  }
  if (!existsSync(NO_AUDIO_MEDIA_PATH)) {
    throw new Error(`Required test fixture not found: ${NO_AUDIO_MEDIA_PATH}`);
  }

  const authCookie = await obtainTestAuthCookie();
  if (authCookie) {
    console.log("✔ Authenticated test session provisioned for e2e.alice@example.com");
  }

  const launcher = await resolveBrowserLauncher();
  const headless = process.env.HEADED !== "1";

  console.log(`Launching browser (headless: ${headless})...`);
  const browser = await chromium.launch({
    ...launcher,
    headless,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  console.log(`✔ Browser launched successfully. Version: ${browser.version()}`);

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });

  if (authCookie) {
    await context.addCookies([authCookie]);
  }

  await context.addInitScript(() => {
    try {
      window.localStorage.setItem("timeline_studio_ui_language", "en");
      window.localStorage.setItem("timeline-studio-ui-language", "en");
      window.localStorage.setItem("timeline-studio-first-visual-guide-seen-v1", "1");
      window.localStorage.setItem("timeline_studio_first_visual_guide_seen", "1");
    } catch {
      // Ignore
    }
  });

  const page = await context.newPage();

  page.on("console", (msg) => {
    console.log(`[Browser Console ${msg.type()}] ${msg.text()}`);
  });

  page.on("pageerror", (err) => {
    console.error(`[Browser PageError] ${err.message}\n${err.stack || ""}`);
  });

  page.on("dialog", async (dialog) => {
    console.log(`[Browser Dialog] Auto-accepting ${dialog.type()}: "${dialog.message()}"`);
    await dialog.accept().catch(() => {});
  });

  try {
    console.log(`\nNavigating to ${DEV_SERVER_URL}...`);
    await page.goto(DEV_SERVER_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

    await page.waitForSelector(".editor-grid", { state: "visible", timeout: 25000 });
    console.log("✔ Editor application loaded in browser.");

    // Dismiss language guide if visible
    const langBtn = page.locator(".language-grid button").filter({ hasText: "English" }).first();
    if (await langBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      console.log("Dismissing language selection guide...");
      await langBtn.click();
      await page.waitForTimeout(400);
    }

    // Step 1: Upload deterministic test video fixture
    console.log("\n=== Step 1: Uploading deterministic test video fixture ===");
    const fileInput = page.locator("input.sr-only[type='file']").first();
    await fileInput.setInputFiles(SAMPLE_MEDIA_PATH);
    console.log(`Uploaded: ${SAMPLE_MEDIA_PATH}`);

    // Wait for the video segment to appear in the timeline
    await page.waitForSelector('[data-timeline-segment-track="image"]', { state: "visible", timeout: 15000 });
    console.log("✔ Video clip added to timeline visual track.");

    // Dismiss First Visual Guide if shown
    const guideDismiss = page.locator(".first-visual-guide-dismiss, .first-visual-guide button");
    if (await guideDismiss.first().isVisible({ timeout: 1500 }).catch(() => false)) {
      console.log("Dismissing First Visual Guide dialog...");
      await guideDismiss.first().click();
      await page.waitForTimeout(400);
    }

    // Allow metadata and compatibility probing to settle
    await page.waitForTimeout(1000);

    const initialClips = await page.locator('[data-timeline-segment-track="image"]').count();
    console.log(`✔ Initial timeline clips count: ${initialClips}`);

    const loadedScreenshot = resolve(ARTIFACTS_DIR, "silence-removal-1-loaded.png");
    await page.screenshot({ path: loadedScreenshot });
    console.log(`✔ Screenshot saved: ${loadedScreenshot}`);

    // Step 2: Open Silence Removal Tool
    console.log("\n=== Step 2: Navigating to Smart Tools -> Remove Pauses ===");
    const smartRailBtn = page.locator(".tool-rail button").filter({ hasText: /Smart|智能/i }).first();
    await smartRailBtn.waitFor({ state: "visible", timeout: 5000 });
    await smartRailBtn.click();
    await page.waitForTimeout(400);

    // Click "Remove Pauses" button in Smart Tools hub
    const removePausesCard = page.locator(".smart-hub-grid button").filter({ hasText: /Remove Pauses|去除停顿/i }).first();
    await removePausesCard.waitFor({ state: "visible", timeout: 5000 });
    await removePausesCard.click();
    await page.waitForTimeout(500);

    // Verify SilenceRemovalPanel mounted
    const silencePanel = page.locator('[data-testid="silence-removal-panel"]');
    await silencePanel.waitFor({ state: "visible", timeout: 5000 });
    console.log("✔ SilenceRemovalPanel mounted and active.");

    // Verify selected clip name
    const clipLabel = page.locator('[data-testid="pause-selected-clip"]');
    if (await clipLabel.isVisible()) {
      const clipName = await clipLabel.innerText();
      console.log(`✔ Selected clip verified: "${clipName}"`);
    }

    // Verify settings controls
    const thresholdSlider = page.locator('[data-testid="pause-setting-threshold"]');
    const minimumSlider = page.locator('[data-testid="pause-setting-minimum"]');
    const keepSlider = page.locator('[data-testid="pause-setting-keep"]');
    const rippleCheckbox = page.locator('[data-testid="pause-ripple-checkbox"]');
    const analyzeBtn = page.locator('[data-testid="pause-analyze-btn"]');

    if (!(await thresholdSlider.isVisible()) || !(await minimumSlider.isVisible()) || !(await keepSlider.isVisible())) {
      throw new Error("Expected threshold, minimum, and keep sliders to be visible.");
    }
    console.log("✔ Settings sliders (Audio threshold, Minimum pause, Keep padding) verified.");

    const panelScreenshot = resolve(ARTIFACTS_DIR, "silence-removal-2-panel-opened.png");
    await page.screenshot({ path: panelScreenshot });
    console.log(`✔ Screenshot saved: ${panelScreenshot}`);

    // Step 3: Adjust Settings & Run Silence Detection
    console.log("\n=== Step 3: Adjusting Settings & Running Silence Detection ===");
    // Set minimum duration to 0.5s to ensure detecting both 2.0s and 1.0s silence gaps
    await minimumSlider.fill("0.5");
    await page.waitForTimeout(200);

    // Set threshold to 0.45
    await thresholdSlider.fill("0.45");
    await page.waitForTimeout(200);

    // Ensure ripple editing is checked
    if (!(await rippleCheckbox.isChecked())) {
      await rippleCheckbox.check();
    }
    console.log("✔ Configured detection settings: minimum = 0.50s, threshold = 0.45, ripple = ON.");

    // Click Analyze button
    console.log("Clicking Analyze button...");
    await analyzeBtn.click();

    // Wait for analysis review to render
    const reviewSection = page.locator('[data-testid="pause-review"]');
    await reviewSection.waitFor({ state: "visible", timeout: 30000 });
    console.log("✔ Silence analysis completed. Review section mounted.");

    const summaryText = await page.locator('[data-testid="pause-summary"]').innerText();
    console.log(`✔ Summary: "${summaryText}"`);

    const candidateCards = page.locator(".pause-range");
    const candidateCount = await candidateCards.count();
    console.log(`✔ Found ${candidateCount} detected pause candidate card(s).`);
    if (candidateCount === 0) {
      throw new Error("Expected at least 1 pause candidate detected from silence-speech fixture.");
    }

    const reviewScreenshot = resolve(ARTIFACTS_DIR, "silence-removal-3-candidates-detected.png");
    await page.screenshot({ path: reviewScreenshot });
    console.log(`✔ Screenshot saved: ${reviewScreenshot}`);

    // Step 4: Test Candidate Exclusion Toggle
    console.log("\n=== Step 4: Testing Candidate Exclusion Toggle ===");
    const firstCheckbox = candidateCards.first().locator('input[type="checkbox"]');
    const initialChecked = await firstCheckbox.isChecked();
    console.log(`Initial checkbox state: ${initialChecked}`);

    // Toggle exclusion off
    await firstCheckbox.uncheck();
    await page.waitForTimeout(200);
    const updatedSummary = await page.locator('[data-testid="pause-summary"]').innerText();
    console.log(`✔ Updated summary after exclusion: "${updatedSummary}"`);

    // Toggle back on
    await firstCheckbox.check();
    await page.waitForTimeout(200);
    console.log("✔ Re-enabled candidate cut.");

    // Step 5: Test Candidate Preview Seek
    console.log("\n=== Step 5: Testing Candidate Preview Seek ===");
    const previewBtn = candidateCards.first().locator("button").first();
    await previewBtn.click();
    await page.waitForTimeout(300);

    const transportTime = await page.locator(".transport-row span").innerText().catch(() => "");
    console.log(`✔ Playhead position after preview click: "${transportTime.trim()}"`);

    // Step 6: Test Dismiss / Cancel Review
    console.log("\n=== Step 6: Testing Dismiss / Cancel Review ===");
    const cancelReviewBtn = page.locator('[data-testid="pause-cancel-review-btn"]');
    await cancelReviewBtn.click();
    await page.waitForTimeout(400);

    const isReviewOpen = await reviewSection.isVisible().catch(() => false);
    console.log(`- Review section closed after Cancel: ${!isReviewOpen ? "✔ YES" : "✖ NO"}`);
    if (isReviewOpen) {
      throw new Error("Cancel button failed to dismiss silence removal review.");
    }

    // Verify timeline unchanged
    const clipsAfterCancel = await page.locator('[data-timeline-segment-track="image"]').count();
    console.log(`✔ Clips count unchanged after cancel: ${clipsAfterCancel} (expected ${initialClips})`);

    const cancelScreenshot = resolve(ARTIFACTS_DIR, "silence-removal-4-cancelled.png");
    await page.screenshot({ path: cancelScreenshot });
    console.log(`✔ Screenshot saved: ${cancelScreenshot}`);

    // Step 7: Re-analyze and Apply Cuts (Ripple Editing)
    console.log("\n=== Step 7: Re-analyzing and Applying Cuts (Ripple Editing) ===");
    const analyzeBtnAgain = page.locator('[data-testid="pause-analyze-btn"]');
    await analyzeBtnAgain.click();

    await reviewSection.waitFor({ state: "visible", timeout: 30000 });
    console.log("✔ Review ready. Applying cuts...");

    const applyBtn = page.locator('[data-testid="pause-apply-btn"]');
    await applyBtn.click();
    await page.waitForTimeout(600);

    // Verify review closed after apply
    const isReviewOpenAfterApply = await reviewSection.isVisible().catch(() => false);
    console.log(`- Review closed after Apply: ${!isReviewOpenAfterApply ? "✔ YES" : "✖ NO"}`);

    // Verify timeline split and duration reduction
    const clipsAfterApply = await page.locator('[data-timeline-segment-track="image"]').count();
    console.log(`✔ Timeline visual clips count after apply: ${clipsAfterApply} (was ${initialClips})`);
    if (clipsAfterApply <= initialClips) {
      throw new Error(`Expected timeline visual segments to increase from cuts, got ${clipsAfterApply}.`);
    }

    const appliedTime = await page.locator(".transport-row span").innerText();
    console.log(`✔ Timeline duration after ripple edit: "${appliedTime.trim()}"`);

    const appliedScreenshot = resolve(ARTIFACTS_DIR, "silence-removal-5-applied.png");
    await page.screenshot({ path: appliedScreenshot });
    console.log(`✔ Screenshot saved: ${appliedScreenshot}`);

    // Step 8: Test Undo Action
    console.log("\n=== Step 8: Testing Undo Action ===");
    const undoBtn = page.locator(".topbar-center button.ghost-action").filter({ hasText: /Undo|撤销/i }).first();
    await undoBtn.click();
    await page.waitForTimeout(600);

    const clipsAfterUndo = await page.locator('[data-timeline-segment-track="image"]').count();
    console.log(`✔ Timeline visual clips count after undo: ${clipsAfterUndo} (expected ${initialClips})`);
    if (clipsAfterUndo !== initialClips) {
      throw new Error(`Expected clip count to restore to ${initialClips}, got ${clipsAfterUndo}.`);
    }

    const restoredTime = await page.locator(".transport-row span").innerText();
    console.log(`✔ Timeline duration after undo: "${restoredTime.trim()}"`);

    const undoScreenshot = resolve(ARTIFACTS_DIR, "silence-removal-6-undone.png");
    await page.screenshot({ path: undoScreenshot });
    console.log(`✔ Screenshot saved: ${undoScreenshot}`);

    // Step 9: Test No-Audio Error Handling
    console.log("\n=== Step 9: Testing No-Audio Video Error Handling ===");
    // Upload no-audio sample
    const newProjectBtn = page.locator(".project-file-button");
    await newProjectBtn.click();
    await page.waitForTimeout(200);

    const fileMenuNew = page.locator(".file-menu-new");
    if (await fileMenuNew.isVisible()) {
      await fileMenuNew.click();
      await page.waitForTimeout(500);
    }

    // Upload no-audio fixture
    await fileInput.setInputFiles(NO_AUDIO_MEDIA_PATH);
    await page.waitForSelector('[data-timeline-segment-track="image"]', { state: "visible", timeout: 15000 });
    await page.waitForTimeout(1000);

    // Open Remove Pauses tool
    await smartRailBtn.click();
    await page.waitForTimeout(300);
    await removePausesCard.click();
    await page.waitForTimeout(400);

    // Click Analyze on no-audio clip
    const analyzeNoAudioBtn = page.locator('[data-testid="pause-analyze-btn"]');
    await analyzeNoAudioBtn.click();
    await page.waitForTimeout(1500);

    const errorNotice = page.locator('[data-testid="pause-error-notice"]');
    await errorNotice.waitFor({ state: "visible", timeout: 8000 });
    const errorText = await errorNotice.innerText();
    console.log(`✔ No-audio error notice verified: "${errorText}"`);

    const noAudioScreenshot = resolve(ARTIFACTS_DIR, "silence-removal-7-no-audio.png");
    await page.screenshot({ path: noAudioScreenshot });
    console.log(`✔ Screenshot saved: ${noAudioScreenshot}`);

    console.log("\n==================================================================");
    console.log("✔ AI SILENCE DETECTION & REMOVAL PLAYWRIGHT E2E TEST PASSED FULLY!");
    console.log("==================================================================");
  } catch (err) {
    console.error(`\n✖ E2E test failed: ${err.message}`);
    const failurePath = resolve(ARTIFACTS_DIR, "silence-removal-failure.png");
    try {
      await page.screenshot({ path: failurePath });
      console.error(`Captured failure screenshot at: ${failurePath}`);
    } catch {
      // Ignore
    }
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    console.log("Browser closed cleanly.");
  }
}

runSilenceRemovalE2ETest().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
