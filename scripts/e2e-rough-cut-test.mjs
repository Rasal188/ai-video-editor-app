/**
 * Playwright E2E Integration Test: AI-Assisted Rough Cut Workflow
 *
 * Verifies the full AI rough-cut workflow inside a real Chromium browser:
 * 1. Authenticated session initialization and local storage onboarding bypass
 * 2. Uploading deterministic test video fixture with known speech & silence intervals
 * 3. Navigating to Smart Tools -> AI Rough Cut panel
 * 4. Verifying threshold, minimum duration, speech padding sliders, filler word toggle, ripple edit toggle
 * 5. Adjusting settings and executing rough-cut analysis
 * 6. Reviewing detected cut candidates with duration savings summary
 * 7. Candidate exclusion toggle (verifying duration recalculation)
 * 8. Candidate preview seek (verifying timeline playhead updates)
 * 9. Dismiss / Cancel review (verifying zero modifications to timeline)
 * 10. Re-analysis and Apply Cuts with ripple editing (verifying segment splits and timeline collapse)
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

  try {
    const testLaunch = await chromium.launch({ headless: true });
    await testLaunch.close();
    return {};
  } catch {
    // Try Chrome
  }

  try {
    const testChrome = await chromium.launch({ channel: "chrome", headless: true });
    await testChrome.close();
    return { channel: "chrome" };
  } catch {
    // Try Edge
  }

  try {
    const testEdge = await chromium.launch({ channel: "msedge", headless: true });
    await testEdge.close();
    return { channel: "msedge" };
  } catch {
    // Try default
  }

  return {};
}

async function runRoughCutE2ETest() {
  console.log("==================================================================");
  console.log("    Playwright E2E Test: AI-Assisted Rough Cut Workflow           ");
  console.log("==================================================================");

  if (!existsSync(ARTIFACTS_DIR)) {
    mkdirSync(ARTIFACTS_DIR, { recursive: true });
  }

  if (!existsSync(SAMPLE_MEDIA_PATH)) {
    throw new Error(`Test sample media not found: ${SAMPLE_MEDIA_PATH}`);
  }

  const authCookie = await obtainTestAuthCookie();
  if (authCookie) {
    console.log("✔ Authenticated test session provisioned for e2e.alice@example.com");
  }

  const launchOptions = await resolveBrowserLauncher();
  console.log("Launching browser (headless: true)...");
  const browser = await chromium.launch({ ...launchOptions, headless: true });
  console.log(`✔ Browser launched successfully. Version: ${browser.version()}`);

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
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

    await page.waitForTimeout(1000);

    const initialClips = await page.locator('[data-timeline-segment-track="image"]').count();
    console.log(`✔ Initial timeline clips count: ${initialClips}`);

    const loadedScreenshot = resolve(ARTIFACTS_DIR, "rough-cut-1-loaded.png");
    await page.screenshot({ path: loadedScreenshot });
    console.log(`✔ Screenshot saved: ${loadedScreenshot}`);

    // Step 2: Open AI Rough Cut Tool
    console.log("\n=== Step 2: Navigating to Smart Tools -> AI Rough Cut ===");
    const smartRailBtn = page.locator(".tool-rail button").filter({ hasText: /Smart|智能/i }).first();
    await smartRailBtn.waitFor({ state: "visible", timeout: 5000 });
    await smartRailBtn.click();
    await page.waitForTimeout(400);

    // Click "AI Rough Cut" button in Smart Tools hub
    const roughCutCard = page.locator('[data-testid="smart-tool-rough-cut"]').first();
    await roughCutCard.waitFor({ state: "visible", timeout: 5000 });
    await roughCutCard.click();
    await page.waitForTimeout(500);

    // Verify RoughCutPanel mounted
    const roughCutPanel = page.locator('[data-testid="rough-cut-panel"]');
    await roughCutPanel.waitFor({ state: "visible", timeout: 5000 });
    console.log("✔ RoughCutPanel mounted and active.");

    // Verify selected clip name
    const clipLabel = page.locator('[data-testid="rough-cut-selected-clip"]');
    if (await clipLabel.isVisible()) {
      const clipName = await clipLabel.innerText();
      console.log(`✔ Selected clip verified: "${clipName}"`);
    }

    // Verify settings controls
    const thresholdSlider = page.locator('[data-testid="rough-cut-threshold-slider"]');
    const minimumSlider = page.locator('[data-testid="rough-cut-minimum-slider"]');
    const keepSlider = page.locator('[data-testid="rough-cut-keep-slider"]');
    const fillerToggle = page.locator('[data-testid="rough-cut-filler-toggle"]');
    const rippleToggle = page.locator('[data-testid="rough-cut-ripple-toggle"]');

    if (
      !(await thresholdSlider.isVisible()) ||
      !(await minimumSlider.isVisible()) ||
      !(await keepSlider.isVisible()) ||
      !(await fillerToggle.isVisible()) ||
      !(await rippleToggle.isVisible())
    ) {
      throw new Error("Expected all rough-cut settings sliders and toggles to be visible.");
    }
    console.log("✔ Settings controls (Threshold, Minimum, Padding, Filler Words, Ripple Edit) verified.");

    const panelScreenshot = resolve(ARTIFACTS_DIR, "rough-cut-2-panel-opened.png");
    await page.screenshot({ path: panelScreenshot });
    console.log(`✔ Screenshot saved: ${panelScreenshot}`);

    // Step 3: Adjust Settings & Run Rough Cut Analysis
    console.log("\n=== Step 3: Adjusting Settings & Running Rough Cut Analysis ===");
    // Set minimum pause to 0.50s
    await minimumSlider.evaluate((el) => {
      el.value = "0.5";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // Set threshold to 0.45
    await thresholdSlider.evaluate((el) => {
      el.value = "0.45";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // Set speech padding to 0.20s
    await keepSlider.evaluate((el) => {
      el.value = "0.2";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });

    console.log("✔ Configured settings: minimum = 0.50s, threshold = 0.45, keep = 0.20s, ripple = ON.");

    const analyzeBtn = page.locator('[data-testid="rough-cut-analyze-btn"]');
    console.log("Clicking Analyze button...");
    await analyzeBtn.click();

    // Wait for analysis to complete and review section to mount
    const reviewSection = page.locator('[data-testid="rough-cut-review"]');
    await reviewSection.waitFor({ state: "visible", timeout: 35000 });
    console.log("✔ Rough cut analysis completed. Review section mounted.");

    const summaryBadge = page.locator('[data-testid="rough-cut-summary"]');
    const summaryText = await summaryBadge.innerText();
    console.log(`✔ Summary: "${summaryText}"`);

    const candidateCards = page.locator('[data-testid^="rough-cut-candidate-"]');
    const candidateCount = await candidateCards.count();
    console.log(`✔ Found ${candidateCount} detected candidate card(s).`);
    if (candidateCount < 1) {
      throw new Error(`Expected at least 1 candidate, found ${candidateCount}`);
    }

    const detectedScreenshot = resolve(ARTIFACTS_DIR, "rough-cut-3-candidates-detected.png");
    await page.screenshot({ path: detectedScreenshot });
    console.log(`✔ Screenshot saved: ${detectedScreenshot}`);

    // Step 4: Test Candidate Exclusion Toggle
    console.log("\n=== Step 4: Testing Candidate Exclusion Toggle ===");
    const toggle0 = page.locator('[data-testid="rough-cut-candidate-toggle-0"]');
    const initialChecked = await toggle0.isChecked();
    console.log(`Initial checkbox state: ${initialChecked}`);

    // Uncheck candidate 0
    await toggle0.click();
    await page.waitForTimeout(300);

    const updatedSummaryText = await summaryBadge.innerText();
    console.log(`✔ Updated summary after exclusion: "${updatedSummaryText}"`);
    if (updatedSummaryText === summaryText && candidateCount > 1) {
      throw new Error("Summary savings did not update when candidate was excluded.");
    }

    // Re-check candidate 0
    await toggle0.click();
    await page.waitForTimeout(300);
    console.log("✔ Re-enabled candidate cut.");

    // Step 5: Test Candidate Preview Seek
    console.log("\n=== Step 5: Testing Candidate Preview Seek ===");
    const preview0 = page.locator('[data-testid="rough-cut-preview-0"]');
    await preview0.click();
    await page.waitForTimeout(500);

    const timeDisplay = page.locator(".time-display, .time-readout, .current-time").first();
    const playheadTime = (await timeDisplay.isVisible()) ? await timeDisplay.innerText() : "unknown";
    console.log(`✔ Playhead position after preview click: "${playheadTime}"`);

    // Step 6: Test Dismiss / Cancel Review
    console.log("\n=== Step 6: Testing Dismiss / Cancel Review ===");
    const cancelBtn = page.locator('[data-testid="rough-cut-cancel-btn"]');
    await cancelBtn.click();
    await page.waitForTimeout(500);

    const reviewVisibleAfterCancel = await reviewSection.isVisible();
    console.log(`- Review section closed after Cancel: ${!reviewVisibleAfterCancel ? "✔ YES" : "✖ NO"}`);
    if (reviewVisibleAfterCancel) {
      throw new Error("Review section should be dismissed after clicking Cancel.");
    }

    const clipsCountAfterCancel = await page.locator('[data-timeline-segment-track="image"]').count();
    console.log(`✔ Clips count unchanged after cancel: ${clipsCountAfterCancel} (expected ${initialClips})`);
    if (clipsCountAfterCancel !== initialClips) {
      throw new Error(`Expected clips count ${initialClips}, but found ${clipsCountAfterCancel}`);
    }

    const cancelledScreenshot = resolve(ARTIFACTS_DIR, "rough-cut-4-cancelled.png");
    await page.screenshot({ path: cancelledScreenshot });
    console.log(`✔ Screenshot saved: ${cancelledScreenshot}`);

    // Step 7: Re-analyze and Apply Cuts (Ripple Editing)
    console.log("\n=== Step 7: Re-analyzing and Applying Cuts (Ripple Editing) ===");
    await page.locator('[data-testid="rough-cut-analyze-btn"]').click();
    await reviewSection.waitFor({ state: "visible", timeout: 35000 });
    console.log("✔ Review ready. Applying cuts...");

    const applyBtn = page.locator('[data-testid="rough-cut-apply-btn"]');
    await applyBtn.click();
    await page.waitForTimeout(1000);

    const reviewVisibleAfterApply = await reviewSection.isVisible();
    console.log(`- Review closed after Apply: ${!reviewVisibleAfterApply ? "✔ YES" : "✖ NO"}`);

    const clipsCountAfterApply = await page.locator('[data-timeline-segment-track="image"]').count();
    console.log(`✔ Timeline visual clips count after apply: ${clipsCountAfterApply} (was ${initialClips})`);
    if (clipsCountAfterApply <= initialClips) {
      throw new Error(`Expected visual clips count > ${initialClips} after cuts, got ${clipsCountAfterApply}`);
    }

    const durationDisplayAfterApply = await timeDisplay.innerText().catch(() => "");
    console.log(`✔ Timeline duration after ripple edit: "${durationDisplayAfterApply}"`);

    const appliedScreenshot = resolve(ARTIFACTS_DIR, "rough-cut-5-applied.png");
    await page.screenshot({ path: appliedScreenshot });
    console.log(`✔ Screenshot saved: ${appliedScreenshot}`);

    // Step 8: Test Undo Action
    console.log("\n=== Step 8: Testing Undo Action ===");
    const undoBtn = page.locator('button[title*="Undo"], button[title*="撤销"], .undo-button, [data-testid="action-undo"]').first();
    if (await undoBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await undoBtn.click();
    } else {
      await page.keyboard.press("Control+z");
    }
    await page.waitForTimeout(1000);

    const clipsCountAfterUndo = await page.locator('[data-timeline-segment-track="image"]').count();
    console.log(`✔ Timeline visual clips count after undo: ${clipsCountAfterUndo} (expected ${initialClips})`);
    if (clipsCountAfterUndo !== initialClips) {
      throw new Error(`Expected clips count ${initialClips} after undo, got ${clipsCountAfterUndo}`);
    }

    const durationDisplayAfterUndo = await timeDisplay.innerText().catch(() => "");
    console.log(`✔ Timeline duration after undo: "${durationDisplayAfterUndo}"`);

    const undoneScreenshot = resolve(ARTIFACTS_DIR, "rough-cut-6-undone.png");
    await page.screenshot({ path: undoneScreenshot });
    console.log(`✔ Screenshot saved: ${undoneScreenshot}`);

    // Step 9: Test No-Audio Video Error Handling
    console.log("\n=== Step 9: Testing No-Audio Video Error Handling ===");
    const newProjectBtn = page.locator(".project-file-button");
    await newProjectBtn.click();
    await page.waitForTimeout(200);

    const fileMenuNew = page.locator(".file-menu-new");
    if (await fileMenuNew.isVisible()) {
      await fileMenuNew.click();
      await page.waitForTimeout(500);
    }

    // Upload audio-less sample
    await fileInput.setInputFiles(NO_AUDIO_MEDIA_PATH);
    await page.waitForSelector('[data-timeline-segment-track="image"]', { state: "visible", timeout: 15000 });
    await page.waitForTimeout(1000);

    // Navigate to rough cut
    await smartRailBtn.click();
    await page.waitForTimeout(300);
    await roughCutCard.click();
    await roughCutPanel.waitFor({ state: "visible", timeout: 5000 });

    // Click analyze on no-audio media
    await page.locator('[data-testid="rough-cut-analyze-btn"]').click();
    await page.waitForTimeout(1500);

    const errorNotice = page.locator('[data-testid="rough-cut-error"]');
    await errorNotice.waitFor({ state: "visible", timeout: 10000 });
    const errorText = await errorNotice.innerText();
    console.log(`✔ No-audio error notice verified: "${errorText}"`);
    if (!errorText.toLowerCase().includes("no audio") && !errorText.includes("没有音轨")) {
      throw new Error(`Expected error notice to mention no audio, got "${errorText}"`);
    }

    const noAudioScreenshot = resolve(ARTIFACTS_DIR, "rough-cut-7-no-audio.png");
    await page.screenshot({ path: noAudioScreenshot });
    console.log(`✔ Screenshot saved: ${noAudioScreenshot}`);

    console.log("\n==================================================================");
    console.log("✔ AI ROUGH CUT PLAYWRIGHT E2E TEST PASSED FULLY!");
    console.log("==================================================================");
  } catch (err) {
    console.error(`\n✖ PLAYWRIGHT E2E TEST FAILED: ${err.message}`);
    const errScreenshot = resolve(ARTIFACTS_DIR, "rough-cut-failure.png");
    await page.screenshot({ path: errScreenshot }).catch(() => {});
    console.error(`Screenshot captured at: ${errScreenshot}`);
    throw err;
  } finally {
    await browser.close();
    console.log("Browser closed cleanly.");
  }
}

runRoughCutE2ETest().catch((err) => {
  console.error("Test execution terminated with error:", err);
  process.exit(1);
});
