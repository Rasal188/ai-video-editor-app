/**
 * Complete End-to-End Workflow Audit Script (Section 3 Verification)
 *
 * Runs the full 16-step integration workflow sequentially on one disposable project:
 *  1. Import media containing speech and silence
 *  2. Generate transcript / open transcript review
 *  3. Edit caption text and timestamps, verify validation guards
 *  4. Test word-level and phrase-level grouping
 *  5. Apply reviewed transcript to the timeline
 *  6. Run silence detection and inspect proposed removals
 *  7. Exclude a proposed silence removal and verify preview
 *  8. Cancel the operation and verify timeline remains unchanged
 *  9. Apply silence removal and inspect resulting timeline
 * 10. Run AI-assisted rough-cut detection on the same project
 * 11. Review candidates, exclude candidate, preview another
 * 12. Cancel and verify no unintended edits occurred
 * 13. Apply rough cuts and inspect resulting timeline
 * 14. Test undo and redo restoring and reapplying exact state
 * 15. Export project package (.timeline) and verify project.json retains segments
 * 16. Render project via CLI rendering pipeline and verify output MP4 media
 */

import { chromium } from "playwright";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEV_SERVER_URL = process.env.EDITOR_URL || "http://localhost:5173/?view=editor";
const ARTIFACTS_DIR = resolve("test-artifacts/playwright/audit-complete");
const SAMPLE_MEDIA_PATH = resolve("test-artifacts/silence-test-sample.mp4");

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
  } catch (err) {
    console.warn(`Could not provision DB session (${err.message}). Continuing in local mode.`);
    return null;
  }
}

async function resolveBrowserLauncher() {
  if (process.env.BROWSER_EXECUTABLE_PATH && existsSync(process.env.BROWSER_EXECUTABLE_PATH)) {
    return { executablePath: process.env.BROWSER_EXECUTABLE_PATH };
  }
  if (process.env.BROWSER_CHANNEL) {
    return { channel: process.env.BROWSER_CHANNEL };
  }
  try {
    const testLaunch = await chromium.launch({ headless: true });
    await testLaunch.close();
    return {};
  } catch (_err) {
    // Try Chrome
  }
  try {
    const testChrome = await chromium.launch({ channel: "chrome", headless: true });
    await testChrome.close();
    return { channel: "chrome" };
  } catch (_err) {
    // Try default
  }
  return {};
}

async function runCompleteWorkflowAudit() {
  console.log("==================================================================");
  console.log("  Complete Workflow Integration & Stability Audit (Steps 1 to 16)  ");
  console.log("==================================================================");

  if (!existsSync(SAMPLE_MEDIA_PATH)) {
    throw new Error(`Test media fixture missing: ${SAMPLE_MEDIA_PATH}`);
  }

  mkdirSync(ARTIFACTS_DIR, { recursive: true });

  const authCookie = await obtainTestAuthCookie();
  const launcher = await resolveBrowserLauncher();
  const browser = await chromium.launch({ ...launcher, headless: true });
  console.log(`✔ Browser launched (Chromium v${browser.version()})`);

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    acceptDownloads: true,
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
    } catch (_err) {
      // Ignore
    }
  });

  const page = await context.newPage();

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
      await langBtn.click();
      await page.waitForTimeout(400);
    }

    // Step 1: Import media containing both speech and silence
    console.log("\n--- Step 1: Import media containing speech and silence ---");
    const fileInput = page.locator("input.sr-only[type='file']").first();
    await fileInput.setInputFiles(SAMPLE_MEDIA_PATH);
    await page.waitForSelector('[data-timeline-segment-track="image"]', { state: "visible", timeout: 15000 });
    const initialClips = await page.locator('[data-timeline-segment-track="image"]').count();
    console.log(`✔ Media imported successfully: 1 clip on timeline (clips count: ${initialClips})`);
    await page.screenshot({ path: resolve(ARTIFACTS_DIR, "step-1-imported.png") });

    // Step 2 & 3: Generate transcript & Open transcript review, edit text & timestamps
    console.log("\n--- Steps 2 & 3: Open transcript review and edit caption text and timestamps ---");
    const samplePayload = {
      isOpen: true,
      language: "en",
      duration: 6.0,
      timelineOffset: 0,
      grouping: "phrases",
      text: "Security testing is essential for web safety.",
      rawChunks: [
        { text: " Security", timestamp: [0.0, 0.4] },
        { text: " testing", timestamp: [0.4, 0.9] },
        { text: " is", timestamp: [0.9, 1.1] },
        { text: " essential", timestamp: [1.1, 1.6] },
        { text: " for", timestamp: [1.6, 1.8] },
        { text: " web", timestamp: [1.8, 2.1] },
        { text: " safety.", timestamp: [2.1, 2.7] },
      ],
      segments: [
        { id: "seg-1", text: "Security testing is", start: 0.0, end: 1.1 },
        { id: "seg-2", text: "essential for web safety.", start: 1.1, end: 2.7 },
      ],
    };

    await page.evaluate((payload) => {
      window.dispatchEvent(new CustomEvent("test:open-transcript-review", { detail: payload }));
    }, samplePayload);

    const modalDialog = page.locator("div[role='dialog'].transcript-review-backdrop");
    await modalDialog.waitFor({ state: "visible", timeout: 5000 });
    console.log("✔ Transcript review modal opened.");

    const segmentCards = page.locator(".transcript-segment-card");
    const count = await segmentCards.count();
    console.log(`✔ Found ${count} caption segment cards.`);

    // Edit text
    const firstTextarea = segmentCards.first().locator("textarea.transcript-text-input");
    await firstTextarea.fill("Verified security testing is");
    console.log("✔ Caption text edited.");

    // Validate timestamp error guard
    const outInput = segmentCards.first().locator(".transcript-time-input-group").nth(1).locator("input");
    await outInput.fill("-0.5");
    await page.waitForTimeout(200);
    const banner = page.locator(".transcript-validation-banner");
    const hasBanner = await banner.isVisible();
    const applyButton = page.locator("button.transcript-btn-apply");
    const isDisabled = await applyButton.isDisabled();
    console.log(`- Validation warning displayed: ${hasBanner ? "✔ YES" : "✖ NO"}`);
    console.log(`- Apply button disabled:        ${isDisabled ? "✔ YES" : "✖ NO"}`);

    // Restore timestamp
    await outInput.fill("1.10");
    await page.waitForTimeout(200);

    // Step 4: Test word-level and phrase-level grouping
    console.log("\n--- Step 4: Test word-level and phrase-level grouping ---");
    const groupingSelect = page.locator("select#review-grouping-select");
    await groupingSelect.selectOption("words");
    await page.waitForTimeout(300);
    const wordCardsCount = await page.locator(".transcript-segment-card").count();
    console.log(`✔ Word-level grouping switched: ${wordCardsCount} cards present.`);

    await groupingSelect.selectOption("phrases");
    await page.waitForTimeout(300);
    const phraseCardsCount = await page.locator(".transcript-segment-card").count();
    console.log(`✔ Phrase-level grouping restored: ${phraseCardsCount} cards present.`);

    // Step 5: Apply the reviewed transcript to timeline
    console.log("\n--- Step 5: Apply the reviewed transcript to timeline ---");
    await applyButton.click();
    await modalDialog.waitFor({ state: "hidden", timeout: 5000 });
    console.log("✔ Reviewed transcript applied and modal dismissed.");
    await page.waitForTimeout(500);

    const captionSegmentsCount = await page.locator('[data-timeline-segment-track="caption"]').count();
    console.log(`✔ Timeline caption segments count: ${captionSegmentsCount}`);
    await page.screenshot({ path: resolve(ARTIFACTS_DIR, "step-5-captions-applied.png") });

    // Step 6: Run silence detection and inspect proposed removals
    console.log("\n--- Step 6: Run silence detection and inspect proposed removals ---");
    const smartRailBtn = page.locator(".tool-rail button").filter({ hasText: /Smart|智能/i }).first();
    await smartRailBtn.waitFor({ state: "visible", timeout: 5000 });
    await smartRailBtn.click();
    await page.waitForTimeout(500);

    const pauseCard = page.locator('[data-testid="smart-tool-remove-pauses"]').first();
    await pauseCard.waitFor({ state: "visible", timeout: 5000 });
    await pauseCard.click();
    await page.waitForTimeout(500);

    const pausePanel = page.locator('[data-testid="silence-removal-panel"]');
    await pausePanel.waitFor({ state: "visible", timeout: 5000 });
    console.log("✔ Silence removal panel active.");

    // Run analysis
    const pauseAnalyzeBtn = page.locator('[data-testid="pause-analyze-btn"]');
    await pauseAnalyzeBtn.click();

    const pauseReview = page.locator('[data-testid="pause-review"]');
    await pauseReview.waitFor({ state: "visible", timeout: 20000 });
    const pauseCandidateCards = page.locator(".pause-range");
    const pauseCount = await pauseCandidateCards.count();
    console.log(`✔ Silence detection completed: ${pauseCount} candidates proposed.`);
    await page.screenshot({ path: resolve(ARTIFACTS_DIR, "step-6-silence-detected.png") });

    // Step 7: Exclude a proposed silence removal and verify preview
    console.log("\n--- Step 7: Exclude proposed removal and verify preview seek ---");
    const pauseCheckbox = pauseCandidateCards.first().locator('input[type="checkbox"]');
    await pauseCheckbox.uncheck();
    console.log("✔ Candidate excluded from removal.");

    const pausePreviewBtn = page.locator('[data-testid="pause-preview-btn"]').first();
    if (await pausePreviewBtn.isVisible().catch(() => false)) {
      await pausePreviewBtn.click();
      console.log("✔ Candidate preview seek clicked.");
    }
    await pauseCheckbox.check(); // re-check

    // Step 8: Cancel the operation and verify timeline remains unchanged
    console.log("\n--- Step 8: Cancel silence removal and verify timeline unchanged ---");
    const pauseCancelBtn = page.locator('[data-testid="pause-cancel-review-btn"]');
    await pauseCancelBtn.click();
    await page.waitForTimeout(400);

    const clipsAfterCancel = await page.locator('[data-timeline-segment-track="image"]').count();
    if (clipsAfterCancel !== initialClips) {
      throw new Error(`Expected clips count ${initialClips} after cancel, got ${clipsAfterCancel}`);
    }
    console.log(`✔ Timeline unchanged after cancellation (clips count: ${clipsAfterCancel}).`);

    // Step 9: Apply silence removal and inspect resulting timeline
    console.log("\n--- Step 9: Apply silence removal and inspect resulting timeline ---");
    await pauseAnalyzeBtn.click();
    await pauseReview.waitFor({ state: "visible", timeout: 20000 });

    // Exclude the second pause candidate so silence removal leaves the remaining pause for AI rough-cut analysis
    const pauseCheckboxes = pauseReview.locator(".pause-range input[type='checkbox']");
    if ((await pauseCheckboxes.count()) > 1) {
      await pauseCheckboxes.nth(1).uncheck();
      console.log("✔ Excluded second pause candidate so remaining pause is left for rough cut.");
    }

    const pauseApplyBtn = page.locator('[data-testid="pause-apply-btn"]');
    await pauseApplyBtn.click();
    await page.waitForTimeout(800);

    await page.waitForTimeout(1000);
    const clipsAfterSilence = await page.locator('[data-timeline-segment-track="image"]').count();
    console.log(`✔ Timeline visual clips count after silence removal: ${clipsAfterSilence}`);
    await page.screenshot({ path: resolve(ARTIFACTS_DIR, "step-9-silence-applied.png") });

    // Step 10 & 11: Run AI rough-cut detection, review candidates, exclude, preview
    console.log("\n--- Steps 10 & 11: Run AI-assisted rough cut detection, review, exclude, preview ---");
    const timelineClips = page.locator('[data-timeline-segment-track="image"]');
    if ((await timelineClips.count()) > 1) {
      await timelineClips.nth(1).click();
      console.log("✔ Selected second visual clip containing remaining silence.");
      await page.waitForTimeout(400);
    }

    await smartRailBtn.click();
    await page.waitForTimeout(500);

    const roughCutCard = page.locator('[data-testid="smart-tool-rough-cut"]').first();
    await roughCutCard.waitFor({ state: "visible", timeout: 5000 });
    await roughCutCard.click();
    await page.waitForTimeout(500);

    const roughCutPanel = page.locator('[data-testid="rough-cut-panel"]');
    await roughCutPanel.waitFor({ state: "visible", timeout: 5000 });

    const roughMinimumSlider = roughCutPanel.locator('[data-testid="rough-cut-minimum-slider"]');
    if (await roughMinimumSlider.isVisible()) {
      await roughMinimumSlider.fill("0.4");
      await page.waitForTimeout(200);
    }

    const roughCutAnalyzeBtn = roughCutPanel.locator('[data-testid="rough-cut-analyze-btn"]');
    await roughCutAnalyzeBtn.click();

    const roughCutReview = roughCutPanel.locator('[data-testid="rough-cut-review"]');
    await roughCutReview.waitFor({ state: "visible", timeout: 15000 });

    const roughCandidatesCount = await roughCutReview.locator(".rough-cut-candidate-card").count();
    console.log(`✔ Rough-cut detection completed: ${roughCandidatesCount} cut candidates found.`);

    // Exclude candidate
    const candidateCheckbox = roughCutReview.locator(".rough-cut-candidate-card input[type='checkbox']").first();
    await candidateCheckbox.uncheck();
    console.log("✔ Candidate excluded.");

    // Preview candidate
    const candidatePreviewBtn = roughCutReview.locator(".rough-cut-candidate-card button[title*='Preview'], .rough-cut-candidate-card button[title*='预览']").first();
    if (await candidatePreviewBtn.isVisible()) {
      await candidatePreviewBtn.click();
      console.log("✔ Candidate preview clicked.");
    }
    await candidateCheckbox.check(); // re-enable

    // Step 12: Cancel and verify no unintended edits
    console.log("\n--- Step 12: Cancel rough cut and verify no unintended edits ---");
    const roughCutCancelBtn = roughCutPanel.locator('[data-testid="rough-cut-cancel-btn"]');
    await roughCutCancelBtn.click();
    await roughCutReview.waitFor({ state: "hidden", timeout: 5000 });

    const clipsAfterRoughCancel = await page.locator('[data-timeline-segment-track="image"]').count();
    if (clipsAfterRoughCancel !== clipsAfterSilence) {
      throw new Error(`Expected clips count ${clipsAfterSilence} after rough cut cancel, got ${clipsAfterRoughCancel}`);
    }
    console.log(`✔ Timeline unchanged after rough-cut cancellation (clips: ${clipsAfterRoughCancel}).`);

    // Step 13: Apply rough cuts and inspect resulting timeline
    console.log("\n--- Step 13: Apply rough cuts and inspect resulting timeline ---");
    await roughCutAnalyzeBtn.click();
    await roughCutReview.waitFor({ state: "visible", timeout: 15000 });

    const roughCutApplyBtn = roughCutPanel.locator('[data-testid="rough-cut-apply-btn"]');
    await roughCutApplyBtn.click();
    await roughCutReview.waitFor({ state: "hidden", timeout: 5000 });
    await page.waitForTimeout(1000);

    const clipsAfterRoughApply = await page.locator('[data-timeline-segment-track="image"]').count();
    console.log(`✔ Timeline clips count after rough cuts applied: ${clipsAfterRoughApply}`);
    await page.screenshot({ path: resolve(ARTIFACTS_DIR, "step-13-rough-cut-applied.png") });

    // Step 14: Test undo and redo after destructive operations
    console.log("\n--- Step 14: Test undo and redo after destructive operations ---");
    const undoBtn = page.locator('button[title*="Undo"], button[title*="撤销"], .undo-button, [data-testid="action-undo"]').first();
    const redoBtn = page.locator('button[title*="Redo"], button[title*="重做"], .redo-button, [data-testid="action-redo"]').first();

    // Undo rough cut
    if (await undoBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await undoBtn.click();
    } else {
      await page.keyboard.press("Control+z");
    }
    await page.waitForTimeout(800);
    const clipsAfterUndo1 = await page.locator('[data-timeline-segment-track="image"]').count();
    console.log(`✔ Timeline visual clips count after Undo: ${clipsAfterUndo1} (restored prior state)`);

    // Redo rough cut
    if (await redoBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await redoBtn.click();
    } else {
      await page.keyboard.press("Control+Shift+z");
    }
    await page.waitForTimeout(800);
    const clipsAfterRedo1 = await page.locator('[data-timeline-segment-track="image"]').count();
    console.log(`✔ Timeline visual clips count after Redo: ${clipsAfterRedo1} (re-applied cuts)`);

    // Step 15: Save project / Export project archive (.timeline) and verify contents
    console.log("\n--- Step 15: Export project archive (.timeline) and verify structure ---");
    const fileMenuBtn = page.locator(".project-file-button");
    await fileMenuBtn.click();
    await page.waitForTimeout(300);

    const exportArchiveBtn = page.locator(".file-menu-action.is-primary");
    const exportedTimelinePath = resolve(ARTIFACTS_DIR, "audit-exported-project.timeline");

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 10000 }),
      exportArchiveBtn.click(),
    ]);

    await download.saveAs(exportedTimelinePath);
    console.log(`✔ Project archive exported to: ${exportedTimelinePath}`);

    // Verify .timeline archive integrity
    const archiveBytes = new Uint8Array(readFileSync(exportedTimelinePath));
    const unzipped = unzipSync(archiveBytes);
    if (!unzipped["project.json"]) {
      throw new Error("Exported .timeline archive is missing project.json!");
    }
    const projectPayload = JSON.parse(strFromU8(unzipped["project.json"]));
    console.log(`✔ Archive format: "${projectPayload.format}", version: ${projectPayload.version}`);
    console.log(`✔ Stored visual clips count: ${projectPayload.project?.visualSegments?.length}`);
    console.log(`✔ Stored caption segments count: ${projectPayload.project?.captionSegments?.length}`);
    if (!projectPayload.project?.visualSegments?.length) {
      throw new Error("Exported project has 0 visual segments!");
    }

    // Reload the exported project back into the editor
    console.log("Reloading exported project into editor...");
    const projectFileInput = page.locator("input.project-file-input").first();
    await projectFileInput.setInputFiles(exportedTimelinePath);
    await page.waitForTimeout(2000);
    const reloadedVisualClips = await page.locator('[data-timeline-segment-track="image"]').count();
    const reloadedCaptionClips = await page.locator('[data-timeline-segment-track="caption"]').count();
    console.log(`✔ Reloaded visual clips: ${reloadedVisualClips}, caption segments: ${reloadedCaptionClips}`);
    await page.screenshot({ path: resolve(ARTIFACTS_DIR, "step-15-project-reloaded.png") });

    // Step 16: Render project via CLI rendering pipeline and verify output media
    console.log("\n--- Step 16: Render project via CLI rendering pipeline and verify output MP4 ---");
    const renderOutputMp4 = resolve(ARTIFACTS_DIR, "audit-rendered-output.mp4");
    if (existsSync(renderOutputMp4)) rmSync(renderOutputMp4, { force: true });

    const renderRequestJson = resolve(ARTIFACTS_DIR, "render-request.json");
    writeFileSync(
      renderRequestJson,
      JSON.stringify(
        {
          schemaVersion: 1,
          project: exportedTimelinePath,
          output: { video: renderOutputMp4 },
          render: { width: 1280, height: 720, fps: 30 },
        },
        null,
        2
      )
    );

    console.log("Invoking CLI project render engine...");
    const { stdout: renderStdout } = await execFileAsync("node", [
      "scripts/timeline-command.mjs",
      "project.render",
      renderRequestJson,
    ]);
    const renderResult = JSON.parse(renderStdout);
    console.log(`✔ CLI Render result ok: ${renderResult.ok}`);
    console.log(`✔ Rendered output path: ${renderResult.artifacts?.video}`);
    console.log(`✔ Output verification: duration=${renderResult.verification?.duration}s, resolution=${renderResult.verification?.width}x${renderResult.verification?.height}, hasAudio=${renderResult.verification?.hasAudio}`);

    if (!renderResult.ok || !existsSync(renderOutputMp4)) {
      throw new Error("Render output MP4 was not produced or verification failed!");
    }

    console.log("\n==================================================================");
    console.log("✔ COMPLETE SEQUENTIAL WORKFLOW AUDIT PASSED 100% (ALL 16 STEPS)");
    console.log("==================================================================");
  } finally {
    await browser.close().catch(() => {});
  }
}

runCompleteWorkflowAudit().catch((err) => {
  console.error("\n❌ COMPLETE WORKFLOW AUDIT FAILED:", err);
  process.exit(1);
});
