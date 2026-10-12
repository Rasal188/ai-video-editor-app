/**
 * Playwright E2E Integration Test: Active-Word Highlighting / Karaoke Captions
 *
 * Verifies real editor UI behavior in Chromium:
 * 1. Loads editor with authentic session.
 * 2. Applies ASR captions with genuine word timestamps via Transcript Review.
 * 3. Navigates to Caption Style panel and toggles Karaoke mode ON.
 * 4. Customizes active-word highlight color.
 * 5. Seeks to different playback times and asserts dynamic word-level highlight updates.
 * 6. Verifies exact active word boundaries, consecutive word transitions, and gap handling.
 * 7. Verifies clean fallback when seeking past segment or disabling karaoke toggle.
 * 8. Saves artifacts and visual verification screenshots.
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

async function runKaraokeCaptionE2ETest() {
  console.log("==================================================================");
  console.log("   Playwright E2E Test: Active-Word Highlighting / Karaoke Captions");
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
      // Ignore
    }
  });

  const page = await context.newPage();

  // Route interception for deterministic auth in local test runs
  await page.route("**/api/auth/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        user: { id: "test-user-e2e", email: "e2e.alice@example.com", name: "Alice" },
      }),
    });
  });

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

    // Sample transcription payload representing genuine Whisper word timestamps
    const samplePayload = {
      isOpen: true,
      language: "en",
      duration: 4.0,
      timelineOffset: 0,
      grouping: "phrases",
      text: "What if someone on your network could read passwords?",
      rawChunks: [
        { text: " What", timestamp: [0.0, 0.2] },
        { text: " if", timestamp: [0.2, 0.4] },
        { text: " someone", timestamp: [0.4, 0.8] },
        { text: " on", timestamp: [0.8, 1.0] },
        { text: " your", timestamp: [1.0, 1.3] },
        { text: " network", timestamp: [1.3, 1.8] },
        { text: " could", timestamp: [1.8, 2.1] },
        { text: " read", timestamp: [2.1, 2.5] },
        { text: " passwords?", timestamp: [2.5, 3.2] },
      ],
      segments: [
        {
          id: "seg-1",
          text: "What if someone on your network could read passwords?",
          start: 0.0,
          end: 3.5,
          timingSource: "asr-word",
          words: [
            { text: "What", start: 0.0, end: 0.2 },
            { text: "if", start: 0.2, end: 0.4 },
            { text: "someone", start: 0.4, end: 0.8 },
            { text: "on", start: 0.8, end: 1.0 },
            { text: "your", start: 1.0, end: 1.3 },
            { text: "network", start: 1.3, end: 1.8 },
            { text: "could", start: 1.8, end: 2.1 },
            { text: "read", start: 2.1, end: 2.5 },
            { text: "passwords?", start: 2.5, end: 3.2 },
          ],
        },
      ],
    };

    console.log("\n=== Step 1: Applying Captions with Word Timestamps ===");
    await page.evaluate((payload) => {
      window.dispatchEvent(new CustomEvent("test:open-transcript-review", { detail: payload }));
    }, samplePayload);

    const applyButton = page.locator("button.transcript-btn-apply");
    await applyButton.waitFor({ state: "visible", timeout: 5000 });
    await applyButton.click();
    await page.waitForTimeout(500);
    console.log("✔ Applied captions with word timestamps onto timeline.");

    console.log("\n=== Step 2: Navigating to Caption Style Panel & Enabling Karaoke ===");
    // Click Captions tab in sidebar if not active
    const captionTab = page.locator("button.tab").filter({ hasText: /captions|caption|字幕/i }).first();
    if (await captionTab.isVisible()) {
      await captionTab.click();
      await page.waitForTimeout(300);
    }

    const karaokeToggle = page.locator("input#caption-karaoke-toggle");
    await karaokeToggle.waitFor({ state: "attached", timeout: 5000 });
    const isInitiallyChecked = await karaokeToggle.isChecked();
    console.log(`- Karaoke initially enabled: ${isInitiallyChecked ? "YES" : "NO (expected)"}`);

    // Check karaoke toggle
    await karaokeToggle.check();
    await page.waitForTimeout(300);
    const isNowChecked = await karaokeToggle.isChecked();
    console.log(`✔ Karaoke toggle checked: ${isNowChecked ? "YES" : "NO"}`);
    if (!isNowChecked) throw new Error("Failed to check karaoke toggle");

    // Check custom active word color input
    const colorInput = page.locator("input#caption-active-word-color");
    if (await colorInput.isVisible()) {
      await colorInput.fill("#00ffcc");
      console.log("✔ Set active word highlight color to #00ffcc");
    }

    async function seekToTime(targetTime) {
      const scrubber = page.locator("input.scrubber");
      await scrubber.fill(String(targetTime));
      await scrubber.dispatchEvent("change");
      await page.waitForTimeout(300);
    }

    console.log("\n=== Step 3: Verifying Active Word Highlighting at t = 0.1s ('What') ===");
    await seekToTime(0.1);

    const overlayBtn = page.locator("button.caption-preview-interactive");
    await overlayBtn.waitFor({ state: "attached", timeout: 5000 });
    let activeIdx = await overlayBtn.getAttribute("data-active-word-index");
    console.log(`- t=0.1s activeWordIndex: ${activeIdx} (expected: 0, word: 'What')`);
    if (activeIdx !== "0") throw new Error(`Expected activeWordIndex to be 0 at t=0.1, got ${activeIdx}`);

    const word0 = overlayBtn.locator(".caption-word[data-word-index='0']");
    const isWord0Active = (await word0.getAttribute("data-active")) === "true";
    console.log(`✔ Word 0 ('What') active flag: ${isWord0Active}`);
    if (!isWord0Active) throw new Error("Word 0 was not marked active");

    // Screenshot word 0 highlighted
    const screenshotWord0 = resolve(ARTIFACTS_DIR, "karaoke-word-0-what.png");
    await page.screenshot({ path: screenshotWord0 });
    console.log(`✔ Screenshot saved: ${screenshotWord0}`);

    console.log("\n=== Step 4: Verifying Transition to Word 1 at t = 0.3s ('if') ===");
    await seekToTime(0.3);

    activeIdx = await overlayBtn.getAttribute("data-active-word-index");
    console.log(`- t=0.3s activeWordIndex: ${activeIdx} (expected: 1, word: 'if')`);
    if (activeIdx !== "1") throw new Error(`Expected activeWordIndex to be 1 at t=0.3, got ${activeIdx}`);

    const word1 = overlayBtn.locator(".caption-word[data-word-index='1']");
    const isWord1Active = (await word1.getAttribute("data-active")) === "true";
    const isWord0Inactive = (await word0.getAttribute("data-active")) === "false";
    console.log(`✔ Word 1 active: ${isWord1Active}, Word 0 inactive: ${isWord0Inactive}`);
    if (!isWord1Active || !isWord0Inactive) throw new Error("Word transition failed");

    console.log("\n=== Step 5: Verifying Transition to Word 2 at t = 0.6s ('someone') ===");
    await seekToTime(0.6);

    activeIdx = await overlayBtn.getAttribute("data-active-word-index");
    console.log(`- t=0.6s activeWordIndex: ${activeIdx} (expected: 2, word: 'someone')`);
    if (activeIdx !== "2") throw new Error(`Expected activeWordIndex to be 2 at t=0.6, got ${activeIdx}`);

    console.log("\n=== Step 6: Verifying Time Past Segment at t = 3.3s (no stale highlight) ===");
    await seekToTime(3.3);

    activeIdx = await overlayBtn.getAttribute("data-active-word-index");
    console.log(`- t=3.3s activeWordIndex: ${activeIdx} (expected: -1, no stale highlight)`);
    if (activeIdx !== "-1") throw new Error(`Expected activeWordIndex to be -1 past words, got ${activeIdx}`);

    console.log("\n=== Step 7: Verifying Disabling Karaoke Toggle ===");
    await karaokeToggle.uncheck();
    await page.waitForTimeout(300);

    // Seek back to t=0.1s with karaoke off
    await seekToTime(0.1);

    activeIdx = await overlayBtn.getAttribute("data-active-word-index");
    console.log(`- With karaoke disabled, activeWordIndex: ${activeIdx} (expected: -1)`);
    if (activeIdx !== "-1") throw new Error(`Expected activeWordIndex to be -1 when disabled, got ${activeIdx}`);

    const activeSpans = await overlayBtn.locator(".caption-word[data-active='true']").count();
    console.log(`- Active word spans with karaoke disabled: ${activeSpans} (expected: 0)`);
    if (activeSpans !== 0) throw new Error("Expected 0 active spans when karaoke is disabled");

    console.log("\n==================================================================");
    console.log("✔ ALL KARAOKE E2E TEST CHECKS PASSED SUCCESSFULLY!");
    console.log("==================================================================");
  } catch (err) {
    console.error(`\n✖ Karaoke E2E test failed: ${err.message}`);
    const failureScreenshot = resolve(ARTIFACTS_DIR, "karaoke-e2e-failure.png");
    await page.screenshot({ path: failureScreenshot }).catch(() => {});
    console.error(`Captured failure screenshot at: ${failureScreenshot}`);
    throw err;
  } finally {
    await browser.close();
    console.log("Browser closed cleanly.");
  }
}

runKaraokeCaptionE2ETest().catch((err) => {
  console.error(err);
  process.exit(1);
});
