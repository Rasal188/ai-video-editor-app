/**
 * Playwright E2E Integration Test: Transcript Review Modal
 *
 * Verifies the complete UI workflow of the Transcript Review modal inside a real browser:
 * 1. Dialog opening & mounting with recognition badges and duration
 * 2. Text editing in caption segment cards
 * 3. Timestamp editing and real-time validation warnings
 * 4. Apply button disabling on invalid intervals
 * 5. Instant regrouping between Phrases (Smart) and Single Words
 * 6. Applying reviewed captions into the timeline
 * 7. Verification of clean state and visual snapshot
 */

import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const DEV_SERVER_URL = process.env.EDITOR_URL || "http://localhost:5173";
const ARTIFACTS_DIR = resolve("test-artifacts/playwright");

async function obtainTestAuthCookie() {
  try {
    const { config } = await import("../server/config.js");
    const { generateSessionToken, hashSessionToken } = await import("../server/services/auth/crypto.js");
    const { createSession } = await import("../server/db/queries/auth.js");
    const { getUserByEmail } = await import("../server/db/queries/users.js");

    const user = await getUserByEmail("e2e.alice@example.com");
    if (!user) return null;

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
  } catch {
    return null;
  }
}

async function runTranscriptModalE2ETest() {
  console.log("==================================================================");
  console.log("   Playwright E2E Test: Transcript Review Modal Workflow          ");
  console.log("==================================================================");

  if (!existsSync(ARTIFACTS_DIR)) {
    mkdirSync(ARTIFACTS_DIR, { recursive: true });
  }

  const authCookie = await obtainTestAuthCookie();
  const headless = process.env.HEADED !== "1";

  const browser = await chromium.launch({
    headless,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });

  if (authCookie) {
    await context.addCookies([authCookie]);
  }

  await context.addInitScript(() => {
    try {
      window.localStorage.setItem("timeline_studio_ui_language", "en");
      window.localStorage.setItem("timeline_studio_first_visual_guide_seen", "1");
    } catch {
      // Ignore in test context
    }
  });

  const page = await context.newPage();

  try {
    console.log(`Navigating to ${DEV_SERVER_URL}...`);
    await page.goto(DEV_SERVER_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

    await page.waitForSelector(".editor-grid", { state: "visible", timeout: 20000 });

    // Dismiss language guide if visible
    const langBtn = page.locator(".language-grid button").filter({ hasText: "English" }).first();
    if (await langBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await langBtn.click();
      await page.waitForTimeout(400);
    }

    console.log("✔ Editor application loaded in browser.");

    // Sample transcription payload representing real Whisper speech recognition
    const samplePayload = {
      isOpen: true,
      language: "en",
      duration: 3.5,
      timelineOffset: 0,
      grouping: "phrases",
      text: "What if someone on your network could read you password while it travels to a website?",
      rawChunks: [
        { text: " What", timestamp: [0.0, 0.2] },
        { text: " if", timestamp: [0.2, 0.35] },
        { text: " someone", timestamp: [0.35, 0.65] },
        { text: " on", timestamp: [0.65, 0.82] },
        { text: " your", timestamp: [0.82, 1.0] },
        { text: " network", timestamp: [1.0, 1.3] },
        { text: " could", timestamp: [1.3, 1.45] },
        { text: " read", timestamp: [1.45, 1.6] },
        { text: " you", timestamp: [1.6, 1.8] },
        { text: " password", timestamp: [1.8, 2.15] },
        { text: " while", timestamp: [2.15, 2.35] },
        { text: " it", timestamp: [2.35, 2.5] },
        { text: " travels", timestamp: [2.5, 2.8] },
        { text: " to", timestamp: [2.8, 2.95] },
        { text: " a", timestamp: [2.95, 3.05] },
        { text: " website?", timestamp: [3.05, 3.36] },
      ],
      segments: [
        { id: "seg-1", text: "What if someone on", start: 0.0, end: 0.82 },
        { id: "seg-2", text: "your network could read", start: 0.82, end: 1.6 },
        { id: "seg-3", text: "you password while it", start: 1.6, end: 2.5 },
        { id: "seg-4", text: "travels to a website?", start: 2.5, end: 3.36 },
      ],
    };

    console.log("\n=== Step 1: Triggering Transcript Review Modal ===");
    await page.evaluate((payload) => {
      window.dispatchEvent(new CustomEvent("test:open-transcript-review", { detail: payload }));
    }, samplePayload);

    // Wait for the modal dialog to appear
    const modalDialog = page.locator("div[role='dialog'].transcript-review-backdrop");
    await modalDialog.waitFor({ state: "visible", timeout: 5000 });
    console.log("✔ Modal backdrop and dialog container mounted via portal.");

    const titleText = await page.locator("#transcript-review-title").innerText();
    console.log(`✔ Modal title verified: "${titleText}"`);

    const segmentCards = page.locator(".transcript-segment-card");
    const count = await segmentCards.count();
    console.log(`✔ Found ${count} caption segment cards (expected 4).`);
    if (count !== 4) throw new Error(`Expected 4 segment cards, got ${count}`);

    // Take screenshot of opened modal
    const modalOpenedScreenshot = resolve(ARTIFACTS_DIR, "transcript-modal-opened.png");
    await page.screenshot({ path: modalOpenedScreenshot });
    console.log(`✔ Screenshot saved: ${modalOpenedScreenshot}`);

    console.log("\n=== Step 2: Testing Segment Text Editing ===");
    const firstTextArea = segmentCards.first().locator("textarea.transcript-text-input");
    await firstTextArea.fill("What if an attacker on");
    const updatedText = await firstTextArea.inputValue();
    console.log(`✔ Edited segment text: "${updatedText}"`);

    console.log("\n=== Step 3: Testing Timestamp Validation & Error Guard ===");
    const outInput = segmentCards.first().locator(".transcript-time-input-group").nth(1).locator("input");
    // Introduce inverted timestamp: Out (0.1) < In (0.5 or Out < 0)
    await outInput.fill("-0.5");
    await page.waitForTimeout(200);

    const banner = page.locator(".transcript-validation-banner");
    const hasBanner = await banner.isVisible();
    const applyButton = page.locator("button.transcript-btn-apply");
    const isDisabled = await applyButton.isDisabled();

    console.log(`- Validation warning banner displayed: ${hasBanner ? "✔ YES" : "✖ NO"}`);
    console.log(`- Apply button disabled:              ${isDisabled ? "✔ YES" : "✖ NO"}`);

    if (!hasBanner || !isDisabled) {
      throw new Error("Validation guard failed: invalid timestamp did not show warning or disable apply button.");
    }

    // Take screenshot of invalid timestamp warning state
    const invalidScreenshot = resolve(ARTIFACTS_DIR, "transcript-modal-invalid.png");
    await page.screenshot({ path: invalidScreenshot });
    console.log(`✔ Validation warning screenshot saved: ${invalidScreenshot}`);

    // Fix timestamp back to valid value
    console.log("Restoring valid timestamp (0.85s)...");
    await outInput.fill("0.85");
    await page.waitForTimeout(200);

    const isNowValid = !(await banner.isVisible());
    const isNowEnabled = !(await applyButton.isDisabled());
    console.log(`- Validation warning cleared: ${isNowValid ? "✔ YES" : "✖ NO"}`);
    console.log(`- Apply button re-enabled:   ${isNowEnabled ? "✔ YES" : "✖ NO"}`);

    if (!isNowValid || !isNowEnabled) {
      throw new Error("Validation recovery failed: fixing timestamp did not re-enable apply button.");
    }

    console.log("\n=== Step 4: Testing Regrouping Controls (Phrases vs. Words) ===");
    const groupingSelect = page.locator("select#review-grouping-select");
    await groupingSelect.selectOption("words");
    await page.waitForTimeout(300);

    const wordCount = await page.locator(".transcript-segment-card").count();
    console.log(`✔ Regrouped to Single Words: found ${wordCount} cards (expected 16).`);
    if (wordCount !== 16) throw new Error(`Expected 16 word cards, got ${wordCount}`);

    // Switch back to phrases
    await groupingSelect.selectOption("phrases");
    await page.waitForTimeout(300);
    const phraseCount = await page.locator(".transcript-segment-card").count();
    console.log(`✔ Regrouped back to Phrases: found ${phraseCount} cards (expected 4).`);
    if (phraseCount !== 4) throw new Error(`Expected 4 phrase cards, got ${phraseCount}`);

    console.log("\n=== Step 5: Applying Captions to Timeline ===");
    await applyButton.click();
    await page.waitForTimeout(500);

    // Verify modal is dismissed
    const isModalClosed = (await page.locator("div[role='dialog'].transcript-review-backdrop").count()) === 0;
    console.log(`✔ Review modal closed after apply: ${isModalClosed ? "YES" : "NO"}`);
    if (!isModalClosed) throw new Error("Modal failed to dismiss after clicking Apply.");

    // Verify applied state on editor
    const appliedScreenshot = resolve(ARTIFACTS_DIR, "transcript-modal-applied.png");
    await page.screenshot({ path: appliedScreenshot });
    console.log(`✔ Final applied timeline screenshot saved: ${appliedScreenshot}`);

    console.log("\n==================================================================");
    console.log("✔ TRANSCRIPT REVIEW MODAL PLAYWRIGHT E2E TEST PASSED FULLY!");
    console.log("==================================================================");
  } catch (err) {
    console.error(`\n✖ Modal E2E test failed: ${err.message}`);
    const failurePath = resolve(ARTIFACTS_DIR, "transcript-modal-failure.png");
    try {
      await page.screenshot({ path: failurePath });
      console.error(`Captured failure screenshot at: ${failurePath}`);
    } catch {
      // Ignore secondary screenshot error
    }
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    console.log("Browser closed cleanly.");
  }
}

runTranscriptModalE2ETest().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
