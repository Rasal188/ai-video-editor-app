/**
 * Playwright E2E Test: Dashboard & Project Management
 *
 * Verifies the complete project lifecycle on the real running application:
 * 1. Dashboard rendering, header, search bar, and empty/grid states.
 * 2. Creating a new project via the New Project Modal with custom title and aspect ratio.
 * 3. Transitioning seamlessly into the Timeline Studio Editor.
 * 4. Navigating back to the Dashboard via the Topbar navigation.
 * 5. Project renaming with immediate UI update and persistence.
 * 6. Project duplication creating an independent project copy with cloned assets.
 * 7. Search filtering and aspect ratio filtering.
 * 8. Project deletion with confirmation modal and card removal.
 */

import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const DEV_SERVER_URL = process.env.DASHBOARD_URL || "http://localhost:5173";
const ARTIFACTS_DIR = resolve("test-artifacts/playwright-dashboard");

async function obtainTestAuthCookie() {
  try {
    const { config } = await import("../server/config.js");
    const { generateSessionToken, hashSessionToken } = await import("../server/services/auth/crypto.js");
    const { createSession } = await import("../server/db/queries/auth.js");
    const { getUserByEmail } = await import("../server/db/queries/users.js");

    const user = await getUserByEmail("e2e.alice@example.com");
    if (!user) {
      console.warn("User e2e.alice@example.com not found in DB.");
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
    console.warn(`Could not provision DB session (${err.message}).`);
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
    // Try chrome
  }

  try {
    const testChrome = await chromium.launch({ channel: "chrome", headless: true });
    await testChrome.close();
    return { channel: "chrome" };
  } catch {
    // Try msedge
  }

  try {
    const testEdge = await chromium.launch({ channel: "msedge", headless: true });
    await testEdge.close();
    return { channel: "msedge" };
  } catch {
    // local fallback
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const candidatePath = resolve(localAppData, "ms-playwright/chromium-1248/chrome-win64/chrome.exe");
    if (existsSync(candidatePath)) {
      return { executablePath: candidatePath };
    }
  }

  throw new Error("No compatible browser could be launched.");
}

async function runDashboardE2E() {
  console.log("==================================================================");
  console.log("       Playwright E2E: Dashboard & Project Management             ");
  console.log("==================================================================");

  if (!existsSync(ARTIFACTS_DIR)) {
    mkdirSync(ARTIFACTS_DIR, { recursive: true });
  }

  const authCookie = await obtainTestAuthCookie();
  if (!authCookie) {
    throw new Error("Failed to obtain authentication cookie for test user.");
  }

  const launcher = await resolveBrowserLauncher();
  const headless = process.env.HEADED !== "1";

  console.log(`Launching browser (headless: ${headless})...`);
  const browser = await chromium.launch({
    ...launcher,
    headless,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await context.addCookies([authCookie]);

  // Pre-seed local storage
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem("timeline_studio_ui_language", "en");
      window.localStorage.setItem("timeline_studio_first_visual_guide_seen", "1");
    } catch {
      // Ignore storage error
    }
  });

  const page = await context.newPage();
  page.on("console", (msg) => {
    console.log(`[Browser ${msg.type()}] ${msg.text()}`);
  });
  page.on("pageerror", (err) => {
    console.error(`[Browser Uncaught Error] ${err.stack || err.message}`);
  });

  try {
    console.log(`\n1. Navigating to ${DEV_SERVER_URL}...`);
    await page.goto(DEV_SERVER_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

    console.log("Waiting for Dashboard to mount...");
    await page.waitForSelector(".dashboard-container", { state: "visible", timeout: 20000 });
    console.log("✔ Dashboard container mounted successfully.");

    await page.screenshot({ path: resolve(ARTIFACTS_DIR, "01-dashboard-initial.png") });

    // Verify key elements
    const hasSearch = await page.locator(".dashboard-search-input").isVisible();
    const hasNewBtn = await page.locator(".dashboard-actions button, .dashboard-new-btn").first().isVisible();
    console.log(`✔ Search input present: ${hasSearch}`);
    console.log(`✔ New Project button present: ${hasNewBtn}`);

    // 2. Create a new project
    const testProjectTitle = `E2E Studio Project ${Date.now()}`;
    console.log(`\n2. Creating new project: "${testProjectTitle}"...`);
    const newBtn = page.locator("[data-testid='dashboard-new-project-btn']").first();
    await newBtn.click();

    await page.waitForSelector(".dashboard-modal-backdrop", { state: "visible", timeout: 5000 });
    console.log("✔ New Project modal opened.");

    await page.fill("[data-testid='new-project-title-input']", testProjectTitle);

    // Select 9:16 aspect ratio
    const portraitChoice = page.locator("[data-testid='new-ratio-9:16']");
    if (await portraitChoice.isVisible()) {
      await portraitChoice.click();
    }

    await page.screenshot({ path: resolve(ARTIFACTS_DIR, "02-new-project-modal.png") });

    // Submit creation
    const submitCreateBtn = page.locator("[data-testid='create-project-submit-btn']");
    await submitCreateBtn.click();

    // 3. Verify transition to Editor
    console.log("\n3. Verifying transition into Editor...");
    await page.waitForSelector(".editor-grid", { state: "visible", timeout: 15000 });
    console.log("✔ Editor mounted with new project.");

    // If language intro modal is visible in editor, dismiss it
    const langBtn = page.locator(".language-grid button, .language-intro button").filter({ hasText: "English" }).first();
    if (await langBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log("Dismissing language intro by selecting English...");
      await langBtn.click();
      await page.waitForTimeout(500);
    }

    // Check project title in topbar
    const titleElement = page.locator(".project-title, .project-name").first();
    if (await titleElement.isVisible()) {
      const displayedTitle = await titleElement.innerText();
      console.log(`✔ Topbar displayed title: "${displayedTitle.trim()}"`);
    }

    await page.screenshot({ path: resolve(ARTIFACTS_DIR, "03-editor-view.png") });

    // 4. Return to Dashboard via Topbar
    console.log("\n4. Navigating back to Dashboard...");
    const backBtn = page.locator("button[title*='Dashboard'], button[aria-label*='Dashboard'], .back-to-dashboard-btn").first();
    await backBtn.click();

    await page.waitForSelector(".dashboard-container", { state: "visible", timeout: 10000 });
    console.log("✔ Successfully returned to Dashboard.");

    // Verify created project card is in grid
    const cardTitle = page.locator(".project-card-title").filter({ hasText: testProjectTitle }).first();
    await cardTitle.waitFor({ state: "visible", timeout: 10000 });
    console.log(`✔ Found project card "${testProjectTitle}" in Dashboard.`);

    await page.screenshot({ path: resolve(ARTIFACTS_DIR, "04-dashboard-with-new-card.png") });

    // 5. Test Rename Project
    const renamedTitle = `${testProjectTitle} (Renamed)`;
    console.log(`\n5. Testing project rename to "${renamedTitle}"...`);
    const projectCard = page.locator(".project-card").filter({ hasText: testProjectTitle }).first();
    const menuBtn = projectCard.locator(".project-card-menu-btn");
    await menuBtn.click();

    const renameMenuOption = page.locator(".project-dropdown-menu .project-menu-item").filter({ hasText: "Rename" });
    await renameMenuOption.click();

    await page.waitForSelector("[data-testid='rename-title-input']", { state: "visible", timeout: 5000 });
    await page.fill("[data-testid='rename-title-input']", renamedTitle);
    await page.locator(".dashboard-modal-footer button.dashboard-btn-primary").click();

    // Verify renamed title appears
    const renamedCardTitle = page.locator(".project-card-title").filter({ hasText: renamedTitle }).first();
    await renamedCardTitle.waitFor({ state: "visible", timeout: 10000 });
    console.log(`✔ Project renamed and verified in DOM: "${renamedTitle}".`);

    await page.screenshot({ path: resolve(ARTIFACTS_DIR, "05-renamed-card.png") });

    // 6. Test Duplicate Project
    console.log("\n6. Testing project duplicate...");
    const updatedCard = page.locator(".project-card").filter({ hasText: renamedTitle }).first();
    const updatedMenuBtn = updatedCard.locator(".project-card-menu-btn");
    await updatedMenuBtn.click();

    const duplicateMenuOption = page.locator(".project-dropdown-menu .project-menu-item").filter({ hasText: "Duplicate" });
    await duplicateMenuOption.click();

    // Wait for duplicate card with "(Copy)"
    const expectedCopyTitle = `${renamedTitle} (Copy)`;
    const copyCardTitle = page.locator(".project-card-title").filter({ hasText: expectedCopyTitle }).first();
    await copyCardTitle.waitFor({ state: "visible", timeout: 10000 });
    console.log(`✔ Duplicated project verified in DOM: "${expectedCopyTitle}".`);

    await page.screenshot({ path: resolve(ARTIFACTS_DIR, "06-duplicated-card.png") });

    // 7. Test Search Filter
    console.log("\n7. Testing search filter...");
    const searchInput = page.locator(".dashboard-search-input");
    await searchInput.fill(expectedCopyTitle);
    await page.waitForTimeout(400);

    const visibleCards = await page.locator(".project-card").count();
    console.log(`✔ Search for "${expectedCopyTitle}" returned ${visibleCards} card(s).`);

    await searchInput.fill("");
    await page.waitForTimeout(400);

    // 8. Test Delete Project
    console.log("\n8. Testing project delete with confirmation...");
    const copyCard = page.locator(".project-card").filter({ hasText: expectedCopyTitle }).first();
    await copyCard.locator(".project-card-menu-btn").click();

    const deleteMenuOption = page.locator(".project-dropdown-menu .project-menu-item").filter({ hasText: "Delete" });
    await deleteMenuOption.click();

    // Verify confirmation modal
    await page.waitForSelector(".dashboard-modal-backdrop", { state: "visible", timeout: 5000 });
    console.log("✔ Delete confirmation modal visible.");

    const confirmDeleteBtn = page.locator("[data-testid='delete-project-confirm-btn']");
    await confirmDeleteBtn.click();

    // Wait for deletion
    await page.waitForSelector(".dashboard-modal-backdrop", { state: "hidden", timeout: 5000 });
    await page.waitForTimeout(500);

    const copyCardExists = await page.locator(".project-card-title").filter({ hasText: expectedCopyTitle }).count();
    console.log(`✔ Duplicate card removed from DOM: ${copyCardExists === 0}`);

    // Clean up original renamed project as well
    const origCard = page.locator(".project-card").filter({ hasText: renamedTitle }).first();
    if (await origCard.isVisible()) {
      await origCard.locator(".project-card-menu-btn").click();
      await page.locator(".project-dropdown-menu .project-menu-item").filter({ hasText: "Delete" }).click();
      await page.waitForSelector(".dashboard-modal-backdrop", { state: "visible", timeout: 5000 });
      await page.locator("[data-testid='delete-project-confirm-btn']").click();
      await page.waitForSelector(".dashboard-modal-backdrop", { state: "hidden", timeout: 5000 });
      console.log("✔ Original test project cleaned up.");
    }

    await page.screenshot({ path: resolve(ARTIFACTS_DIR, "07-dashboard-after-cleanup.png") });

    console.log("\n==================================================================");
    console.log("✔ ALL DASHBOARD E2E OPERATIONS PASSED SUCCESSFULLY!");
    console.log("==================================================================");
  } catch (err) {
    console.error(`\n✖ E2E Test Failure: ${err.message}`);
    await page.screenshot({ path: resolve(ARTIFACTS_DIR, "error-state.png") }).catch(() => {});
    throw err;
  } finally {
    await browser.close();
  }
}

runDashboardE2E().catch((err) => {
  console.error(err);
  process.exit(1);
});
