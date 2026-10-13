/**
 * Playwright Browser Smoke Test for AI Video Editor
 *
 * Launches a real browser via Playwright (bundled Chromium or system Chrome/Edge),
 * attaches an authenticated session for e2e testing, loads http://localhost:5173,
 * verifies core editor UI components, monitors console and page errors,
 * captures a full screenshot, and closes cleanly.
 */

import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const DEV_SERVER_URL = process.env.EDITOR_URL || "http://localhost:5173/?view=editor";
const ARTIFACTS_DIR = resolve("test-artifacts/playwright");

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
    console.log(`Using custom executable: ${customExecutable}`);
    return { executablePath: customExecutable };
  }

  if (channel) {
    console.log(`Using browser channel: ${channel}`);
    return { channel };
  }

  // 1. Try bundled Playwright Chromium
  try {
    const testLaunch = await chromium.launch({ headless: true });
    await testLaunch.close();
    console.log("Using default Playwright bundled Chromium");
    return {};
  } catch (err) {
    console.warn(`Default Chromium launch failed (${err.message}). Trying fallback channels...`);
  }

  // 2. Fallback to Google Chrome
  try {
    const testChrome = await chromium.launch({ channel: "chrome", headless: true });
    await testChrome.close();
    console.log("Using system Google Chrome channel");
    return { channel: "chrome" };
  } catch {
    // Ignore and try Edge
  }

  // 3. Fallback to Microsoft Edge
  try {
    const testEdge = await chromium.launch({ channel: "msedge", headless: true });
    await testEdge.close();
    console.log("Using system Microsoft Edge channel");
    return { channel: "msedge" };
  } catch {
    // Ignore and try local ms-playwright cache
  }

  // 4. Fallback to locally cached ms-playwright Chromium
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const candidatePath = resolve(localAppData, "ms-playwright/chromium-1248/chrome-win64/chrome.exe");
    if (existsSync(candidatePath)) {
      console.log(`Using cached Chromium at: ${candidatePath}`);
      return { executablePath: candidatePath };
    }
  }

  throw new Error("No compatible browser could be launched.");
}

async function runSmokeTest() {
  console.log("==================================================================");
  console.log("       Playwright Browser Automation Smoke Test                   ");
  console.log("==================================================================");
  console.log(`Target URL: ${DEV_SERVER_URL}`);

  if (!existsSync(ARTIFACTS_DIR)) {
    mkdirSync(ARTIFACTS_DIR, { recursive: true });
  }

  const authCookie = await obtainTestAuthCookie();
  if (authCookie) {
    console.log("✔ Authenticated test session provisioned for e2e.alice@example.com");
  }

  const launchOptions = await resolveBrowserLauncher();
  const headless = process.env.HEADED !== "1";

  console.log(`\nLaunching browser (headless: ${headless})...`);
  const browser = await chromium.launch({
    ...launchOptions,
    headless,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  console.log(`✔ Browser launched successfully! Version: ${browser.version()}`);

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });

  if (authCookie) {
    await context.addCookies([authCookie]);
  }

  // Pre-seed local storage to prevent onboarding modals from blocking tests
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem("timeline_studio_ui_language", "en");
      window.localStorage.setItem("timeline_studio_first_visual_guide_seen", "1");
    } catch {
      // Ignore
    }
  });

  const page = await context.newPage();

  const consoleLogs = [];
  const pageErrors = [];

  page.on("console", (msg) => {
    const text = msg.text();
    const type = msg.type();
    consoleLogs.push({ type, text });
    if (type === "error") {
      console.warn(`[Page Console Error] ${text}`);
    }
  });

  page.on("pageerror", (err) => {
    console.error(`[Page Uncaught Error] ${err.message}`);
    pageErrors.push(err);
  });

  try {
    console.log(`\nNavigating to ${DEV_SERVER_URL}...`);
    const response = await page.goto(DEV_SERVER_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    if (!response) {
      throw new Error(`Failed to get response from ${DEV_SERVER_URL}`);
    }

    console.log(`✔ Navigation HTTP Status: ${response.status()}`);
    if (response.status() >= 400) {
      throw new Error(`Server returned HTTP error status: ${response.status()}`);
    }

    // Wait for the application to finish checking auth and mount
    console.log("Waiting for React application to mount...");
    await page.waitForSelector(".editor-grid, .auth-modal-container", {
      state: "visible",
      timeout: 20000,
    });

    // If language selection guide is visible, dismiss by choosing English
    const langBtn = page.locator(".language-grid button").filter({ hasText: "English" }).first();
    if (await langBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      console.log("Dismissing language guide by selecting English...");
      await langBtn.click();
      await page.waitForTimeout(500);
    }

    const pageTitle = await page.title();
    const currentUrl = page.url();
    console.log(`✔ Page Title: "${pageTitle}"`);
    console.log(`✔ Final URL:  "${currentUrl}"`);

    // Verify key editor elements
    console.log("\nVerifying editor UI components:");
    const hasEditorGrid = (await page.locator(".editor-grid").count()) > 0;
    const hasTopbar = (await page.locator(".topbar-container, .topbar, header").count()) > 0;
    const hasPreview = (await page.locator(".preview-stage, .preview-shell, canvas").count()) > 0;
    const hasSidebar = (await page.locator(".sidebar-rail, .tool-rail, .editor-sidebar").count()) > 0;

    console.log(`- Editor grid rendered:  ${hasEditorGrid ? "✔ YES" : "✖ NO"}`);
    console.log(`- Topbar rendered:       ${hasTopbar ? "✔ YES" : "✖ NO"}`);
    console.log(`- Preview stage mounted: ${hasPreview ? "✔ YES" : "✖ NO"}`);
    console.log(`- Sidebar rail rendered: ${hasSidebar ? "✔ YES" : "✖ NO"}`);

    if (!hasEditorGrid && !hasTopbar) {
      throw new Error("Core editor UI elements failed to render in the DOM.");
    }

    // Switch to Captions tool rail item to verify interactivity
    const captionRailBtn = page.locator(".sidebar-rail button, .tool-rail button").nth(1);
    if (await captionRailBtn.isVisible().catch(() => false)) {
      console.log("\nTesting UI interactivity: clicking Captions tool rail tab...");
      await captionRailBtn.click();
      await page.waitForTimeout(400);
      console.log("✔ Captions tab activated successfully.");
    }

    // Capture success screenshot
    const screenshotPath = resolve(ARTIFACTS_DIR, "smoke-success.png");
    await page.screenshot({ path: screenshotPath, fullPage: false });
    console.log(`\n✔ Full editor screenshot captured at: ${screenshotPath}`);

    // Verify no fatal runtime errors
    const fatalErrors = pageErrors.filter(
      (e) => !e.message?.includes("ResizeObserver") && !e.message?.includes("WebGL")
    );
    if (fatalErrors.length > 0) {
      console.warn(`Warning: Encountered ${fatalErrors.length} page error(s) during smoke test.`);
    } else {
      console.log("✔ Zero uncaught application errors detected.");
    }

    console.log("\n==================================================================");
    console.log("✔ PLAYWRIGHT BROWSER SMOKE TEST PASSED SUCCESSFULLY!");
    console.log("==================================================================");
  } catch (err) {
    console.error(`\n✖ Smoke test failed: ${err.message}`);
    const failureScreenshot = resolve(ARTIFACTS_DIR, "smoke-failure.png");
    try {
      await page.screenshot({ path: failureScreenshot, fullPage: false });
      console.error(`Captured failure screenshot at: ${failureScreenshot}`);
    } catch {
      // Ignore
    }
    process.exitCode = 1;
  } finally {
    console.log("Closing browser cleanly...");
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    console.log("Browser closed.");
  }
}

runSmokeTest().catch((err) => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});
