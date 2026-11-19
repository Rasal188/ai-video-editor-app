import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const APP_URL = process.env.OVERLAY_TEMPLATE_APP_URL || "http://localhost:5173";
const TEMPLATE_NAME = process.env.OVERLAY_TEMPLATE_NAME || "test";
const ARTIFACTS_DIR = resolve("test-artifacts/overlay-template-real-app");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function loadRequiredConfiguration() {
    const requiredNames = ["TEST_USER_EMAIL", "TEST_PROJECT_ID", "TEST_TEMPLATE_ID"];
    const values = Object.fromEntries(requiredNames.map((name) => [name, process.env[name]?.trim() || ""]));
    const missingNames = requiredNames.filter((name) => !values[name]);

    if (missingNames.length > 0) {
        throw new Error(
            `Missing required overlay-template test configuration: ${missingNames.join(", ")}. `
            + "Set TEST_USER_EMAIL, TEST_PROJECT_ID, and TEST_TEMPLATE_ID in the process environment before running this script. "
            + "Configuration values are intentionally not printed.",
        );
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.TEST_USER_EMAIL)) {
        throw new Error("TEST_USER_EMAIL must be a valid email address. The configured value is intentionally not printed.");
    }
    for (const name of ["TEST_PROJECT_ID", "TEST_TEMPLATE_ID"]) {
        if (!UUID_PATTERN.test(values[name])) {
            throw new Error(`${name} must be a valid UUID. The configured value is intentionally not printed.`);
        }
    }

    return Object.freeze({
        testUserEmail: values.TEST_USER_EMAIL,
        projectId: values.TEST_PROJECT_ID,
        templateId: values.TEST_TEMPLATE_ID,
    });
}

const {
    testUserEmail: TEST_USER_EMAIL,
    projectId: PROJECT_ID,
    templateId: TEMPLATE_ID,
} = loadRequiredConfiguration();
const SENSITIVE_CONFIGURATION_VALUES = Object.freeze([TEST_USER_EMAIL, PROJECT_ID, TEMPLATE_ID]);

function redactSensitiveConfiguration(value) {
    if (typeof value === "string") {
        return SENSITIVE_CONFIGURATION_VALUES.reduce(
            (redacted, sensitiveValue) => redacted.split(sensitiveValue).join("[REDACTED]"),
            value,
        );
    }
    if (Array.isArray(value)) return value.map(redactSensitiveConfiguration);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([key, entryValue]) => [key, redactSensitiveConfiguration(entryValue)]),
        );
    }
    return value;
}

if (process.argv.includes("--validate-config-only")) {
    console.log("Overlay-template test configuration is valid; configured values were not printed.");
    process.exit(0);
}

await mkdir(ARTIFACTS_DIR, { recursive: true });

async function provisionAuthCookie() {
    const { config } = await import("../server/config.js");
    const { generateSessionToken, hashSessionToken } = await import("../server/services/auth/crypto.js");
    const { createSession } = await import("../server/db/queries/auth.js");
    const { getUserByEmail } = await import("../server/db/queries/users.js");

    const user = await getUserByEmail(TEST_USER_EMAIL);
    assert.ok(user, "The configured TEST_USER_EMAIL must identify an existing local test user.");

    const rawToken = generateSessionToken();
    const tokenHash = hashSessionToken(rawToken, config.auth.salt);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await createSession({ userId: user.id, tokenHash, expiresAt });

    return {
        user,
        cookie: {
            name: config.auth.sessionCookieName,
            value: rawToken,
            domain: "localhost",
            path: "/",
            httpOnly: true,
            sameSite: "Lax",
        },
    };
}

async function captureProjectPersistenceState() {
    const { getClient } = await import("../server/db/index.js");
    const client = await getClient();
    try {
        const projectResult = await client.query("SELECT * FROM projects WHERE id = $1", [PROJECT_ID]);
        const versionsResult = await client.query("SELECT id FROM project_versions WHERE project_id = $1 ORDER BY revision", [PROJECT_ID]);
        const assetsResult = await client.query("SELECT id FROM assets WHERE project_id = $1 ORDER BY created_at", [PROJECT_ID]);
        const project = projectResult.rows[0];
        assert.ok(project, "The configured TEST_PROJECT_ID must identify an existing project before persistence verification.");
        return {
            project,
            versionIds: versionsResult.rows.map((row) => row.id),
            assetIds: assetsResult.rows.map((row) => row.id),
        };
    } finally {
        client.release();
    }
}

async function restoreProjectPersistenceState(baseline) {
    const { getClient } = await import("../server/db/index.js");
    const { resolveSafeStoragePath } = await import("../server/services/storage/storageSecurity.js");
    const client = await getClient();
    const temporaryArchivePaths = [];
    try {
        await client.query("BEGIN");
        const temporaryVersions = await client.query(
            "SELECT id, archive_storage_path FROM project_versions WHERE project_id = $1 AND NOT (id = ANY($2::uuid[]))",
            [PROJECT_ID, baseline.versionIds],
        );
        temporaryArchivePaths.push(...temporaryVersions.rows.map((row) => row.archive_storage_path).filter(Boolean));
        await client.query(
            "DELETE FROM assets WHERE project_id = $1 AND NOT (id = ANY($2::uuid[]))",
            [PROJECT_ID, baseline.assetIds],
        );
        await client.query(
            "DELETE FROM project_versions WHERE project_id = $1 AND NOT (id = ANY($2::uuid[]))",
            [PROJECT_ID, baseline.versionIds],
        );
        await client.query(
            `UPDATE projects
             SET title = $2,
                 current_revision = $3,
                 duration = $4,
                 fps = $5,
                 ratio = $6,
                 archive_storage_path = $7,
                 metadata = $8,
                 created_at = $9,
                 updated_at = $10
             WHERE id = $1`,
            [
                PROJECT_ID,
                baseline.project.title,
                baseline.project.current_revision,
                baseline.project.duration,
                baseline.project.fps,
                baseline.project.ratio,
                baseline.project.archive_storage_path,
                baseline.project.metadata,
                baseline.project.created_at,
                baseline.project.updated_at,
            ],
        );
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        throw error;
    } finally {
        client.release();
    }

    const removedArchivePaths = [];
    for (const archivePath of temporaryArchivePaths) {
        if (archivePath === baseline.project.archive_storage_path) continue;
        await rm(resolveSafeStoragePath(archivePath), { force: true });
        removedArchivePaths.push(archivePath);
    }

    const verificationClient = await getClient();
    try {
        const projectResult = await verificationClient.query("SELECT * FROM projects WHERE id = $1", [PROJECT_ID]);
        const versionsResult = await verificationClient.query("SELECT id FROM project_versions WHERE project_id = $1 ORDER BY revision", [PROJECT_ID]);
        const assetsResult = await verificationClient.query("SELECT id FROM assets WHERE project_id = $1 ORDER BY created_at", [PROJECT_ID]);
        const restoredProject = projectResult.rows[0];
        assert.deepEqual(
            {
                title: restoredProject.title,
                current_revision: restoredProject.current_revision,
                duration: restoredProject.duration,
                fps: restoredProject.fps,
                ratio: restoredProject.ratio,
                archive_storage_path: restoredProject.archive_storage_path,
                metadata: restoredProject.metadata,
                created_at: restoredProject.created_at,
                updated_at: restoredProject.updated_at,
            },
            {
                title: baseline.project.title,
                current_revision: baseline.project.current_revision,
                duration: baseline.project.duration,
                fps: baseline.project.fps,
                ratio: baseline.project.ratio,
                archive_storage_path: baseline.project.archive_storage_path,
                metadata: baseline.project.metadata,
                created_at: baseline.project.created_at,
                updated_at: baseline.project.updated_at,
            },
            "The real project record must be restored exactly after persistence verification.",
        );
        assert.deepEqual(
            versionsResult.rows.map((row) => row.id),
            baseline.versionIds,
            "Temporary persistence revisions must be removed after verification.",
        );
        assert.deepEqual(
            assetsResult.rows.map((row) => row.id),
            baseline.assetIds,
            "Temporary asset metadata rows must be removed after verification.",
        );
        return {
            restoredRevision: restoredProject.current_revision,
            restoredArchivePath: restoredProject.archive_storage_path,
            restoredVersionCount: versionsResult.rows.length,
            restoredAssetCount: assetsResult.rows.length,
            removedArchivePaths,
        };
    } finally {
        verificationClient.release();
    }
}

async function resolveLauncher() {
    const customExecutable = process.env.BROWSER_EXECUTABLE_PATH;
    if (customExecutable && existsSync(customExecutable)) return { executablePath: customExecutable };

    for (const options of [{}, { channel: "chrome" }, { channel: "msedge" }]) {
        try {
            const browser = await chromium.launch({ ...options, headless: true });
            await browser.close();
            return options;
        } catch {
            // Try the next installed browser.
        }
    }
    throw new Error("No compatible Chromium browser is available.");
}

async function dismissLanguageIntro(page) {
    const english = page.locator(".language-grid button, .language-intro button").filter({ hasText: "English" }).first();
    if (await english.isVisible({ timeout: 1500 }).catch(() => false)) {
        await english.click();
        await page.waitForTimeout(250);
    }
}

async function openProject(page) {
    await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector(".dashboard-container", { state: "visible", timeout: 30000 });

    const card = page.locator(`[data-testid="project-card-${PROJECT_ID}"]`);
    await card.waitFor({ state: "visible", timeout: 30000 });
    await card.click();
    await page.waitForSelector(".editor-grid", { state: "visible", timeout: 30000 });
    await dismissLanguageIntro(page);
    await page.waitForFunction(() => typeof window.__PROJECT_SNAPSHOT__ === "function", null, { timeout: 30000 });
}

async function openTemplates(page) {
    const button = page.locator(".rail-tool").filter({ hasText: /Templates/i }).first();
    await button.scrollIntoViewIfNeeded();
    await button.click();
    await page.waitForSelector('[data-testid="overlay-template-library"]', { state: "visible", timeout: 30000 });
}

async function findTemplateCard(page) {
    const exactIdCard = page.getByTestId(`overlay-template-card-${TEMPLATE_ID}`);
    if (await exactIdCard.isVisible({ timeout: 5000 }).catch(() => false)) return exactIdCard;

    const namedCard = page.locator(".overlay-template-card").filter({
        has: page.locator(".overlay-template-card-heading strong", { hasText: TEMPLATE_NAME }),
    }).first();
    await namedCard.waitFor({ state: "visible", timeout: 30000 });
    return namedCard;
}

async function getSnapshotSummary(page) {
    return page.evaluate(() => {
        const snapshot = window.__PROJECT_SNAPSHOT__?.();
        return {
            available: Boolean(snapshot),
            visualSegmentCount: snapshot?.visualSegments?.length || 0,
            visualSegmentIds: (snapshot?.visualSegments || []).map((segment) => segment.id),
            visualOverlaySegmentCount: snapshot?.visualOverlaySegments?.length || 0,
            overlayIds: (snapshot?.visualOverlaySegments || []).map((segment) => segment.id),
            overlays: (snapshot?.visualOverlaySegments || []).map((segment) => ({
                id: segment.id,
                start: segment.start,
                duration: segment.duration,
                lane: segment.lane,
                layer: segment.layer,
                templateId: segment.templateId,
                templateElementId: segment.templateElementId,
                templateName: segment.templateName,
                type: segment.type,
                kind: segment.kind,
                locked: segment.locked,
                hidden: segment.hidden,
                baseTransform: segment.baseTransform,
                keyframeCount: segment.keyframes?.length || 0,
                animation: segment.animation,
                mask: segment.mask,
                filterId: segment.filterId,
                text: segment.text,
                shape: segment.shape,
                mediaPresentation: segment.mediaPresentation,
            })),
            trackLocks: snapshot?.trackLocks || null,
            ratioId: snapshot?.ratioId || null,
            duration: snapshot?.duration ?? null,
        };
    });
}

async function waitForRestoredProject(page) {
    await page.waitForFunction(() => {
        const snapshot = window.__PROJECT_SNAPSHOT__?.();
        return Boolean(snapshot?.visualSegments?.length);
    }, null, { timeout: 30000 });

    let previous = "";
    let stableReads = 0;
    for (let attempt = 0; attempt < 30; attempt += 1) {
        const summary = await getSnapshotSummary(page);
        const signature = JSON.stringify({
            visualSegmentIds: summary.visualSegmentIds,
            overlayIds: summary.overlayIds,
            trackLocks: summary.trackLocks,
        });
        stableReads = signature === previous ? stableReads + 1 : 0;
        if (stableReads >= 3) return summary;
        previous = signature;
        await page.waitForTimeout(300);
    }
    throw new Error("The project archive did not reach a stable restored state.");
}

async function seekToTimelineTime(page, time, duration) {
    const rulerViewport = page.locator(".timeline-ruler-viewport");
    const trackSurface = page.locator(".track-scroll");
    await rulerViewport.waitFor({ state: "visible", timeout: 30000 });
    await trackSurface.waitFor({ state: "visible", timeout: 30000 });
    const viewportBox = await rulerViewport.boundingBox();
    const trackBox = await trackSurface.boundingBox();
    assert.ok(viewportBox?.width > 0, "The real timeline ruler viewport must have measurable width.");
    assert.ok(trackBox?.width > 0, "The real timeline track surface must have measurable width.");
    const playhead = page.locator('.playhead[role="slider"]');
    const renderedDuration = Number(await playhead.getAttribute("aria-valuemax"));
    const effectiveDuration = Number.isFinite(Number(duration)) && Number(duration) > 0
        ? Number(duration)
        : renderedDuration;
    const ratio = Math.max(0, Math.min(1, Number(time) / Math.max(0.001, effectiveDuration)));
    const clientX = trackBox.x + trackBox.width * ratio;
    assert.ok(
        clientX >= viewportBox.x && clientX <= viewportBox.x + viewportBox.width,
        `Timeline time ${time} must be inside the visible real ruler viewport.`,
    );
    await page.mouse.click(clientX, viewportBox.y + Math.min(12, viewportBox.height / 2));
    await page.waitForTimeout(120);
    return { time, duration: effectiveDuration, ratio, clientX, viewportBox, trackBox };
}

async function seekWithRealTimelineRuler(page, fraction = 0.35) {
    const rulerViewport = page.locator(".timeline-ruler-viewport");
    const trackSurface = page.locator(".track-scroll");
    await rulerViewport.waitFor({ state: "visible", timeout: 30000 });
    await trackSurface.waitFor({ state: "visible", timeout: 30000 });
    const viewportBox = await rulerViewport.boundingBox();
    const trackBox = await trackSurface.boundingBox();
    assert.ok(viewportBox?.width > 0, "The real timeline ruler viewport must have measurable width.");
    assert.ok(trackBox?.width > 0, "The real timeline track surface must have measurable width.");
    const targetFraction = Math.max(0.1, Math.min(0.8, fraction));
    const clientX = viewportBox.x + viewportBox.width * targetFraction;
    const clientY = viewportBox.y + Math.min(12, viewportBox.height / 2);
    await page.mouse.click(clientX, clientY);
    const playhead = page.locator('.playhead[role="slider"]');
    await playhead.waitFor({ state: "visible", timeout: 10000 });
    await page.waitForFunction(() => Number(
        document.querySelector('.playhead[role="slider"]')?.getAttribute("aria-valuenow"),
    ) > 0, null, { timeout: 10000 });
    return {
        targetFraction,
        clientX,
        clientY,
        viewportBox,
        trackBox,
        ariaValueNow: Number(await playhead.getAttribute("aria-valuenow")),
        ariaValueMax: Number(await playhead.getAttribute("aria-valuemax")),
    };
}

async function getVisibleToast(page) {
    const toast = page.locator(".toast:visible").last();
    if (!await toast.isVisible({ timeout: 3000 }).catch(() => false)) return "";
    return (await toast.innerText()).trim();
}

async function applyRenderedTemplate(page, previousCount) {
    const card = await findTemplateCard(page);
    const button = card.getByRole("button", { name: /apply .* to timeline/i }).first();
    await button.waitFor({ state: "visible", timeout: 10000 });
    const accessibleName = await button.getAttribute("aria-label");
    const visibleText = (await button.innerText()).trim();
    await button.click();
    await page.waitForFunction((count) => {
        const snapshot = window.__PROJECT_SNAPSHOT__?.();
        return (snapshot?.visualOverlaySegments?.length || 0) > count;
    }, previousCount, { timeout: 15000 });
    await page.waitForTimeout(150);
    return {
        accessibleName,
        visibleText,
        toast: await getVisibleToast(page),
        snapshot: await getSnapshotSummary(page),
        timelineClipCount: await page.locator('.visual-overlay-clip[data-timeline-segment-track="overlay"]').count(),
        selectedTimelineClipCount: await page.locator('.visual-overlay-clip.is-selected-segment[data-timeline-segment-track="overlay"]').count(),
        previewOverlayCount: await page.locator(".visual-overlay-layer:not(.visual-overlay-controls)").count(),
        selectedPreviewControlCount: await page.locator(".visual-overlay-controls.is-selected").count(),
    };
}

async function moveSelectedOverlayWithRealPointer(page, overlayId) {
    const before = await getSnapshotSummary(page);
    const beforeOverlay = before.overlays.find((overlay) => overlay.id === overlayId);
    assert.ok(beforeOverlay, `Overlay ${overlayId} must exist before the preview move gesture.`);
    const layer = page.locator(".visual-overlay-layer:not(.visual-overlay-controls)").first();
    await layer.waitFor({ state: "visible", timeout: 10000 });
    const box = await layer.boundingBox();
    assert.ok(box?.width > 0 && box?.height > 0, "The real preview overlay body must be measurable.");
    const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const end = { x: start.x + 32, y: start.y - 28 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(({ id, initial }) => {
        const overlay = window.__PROJECT_SNAPSHOT__?.().visualOverlaySegments?.find((item) => item.id === id);
        if (!overlay) return false;
        return JSON.stringify(overlay.baseTransform) !== JSON.stringify(initial);
    }, { id: overlayId, initial: beforeOverlay.baseTransform }, { timeout: 10000 });
    const after = await getSnapshotSummary(page);
    const afterOverlay = after.overlays.find((overlay) => overlay.id === overlayId);
    return {
        overlayBox: box,
        pointerStart: start,
        pointerEnd: end,
        before: beforeOverlay.baseTransform,
        after: afterOverlay.baseTransform,
        changed: JSON.stringify(beforeOverlay.baseTransform) !== JSON.stringify(afterOverlay.baseTransform),
    };
}

async function saveProjectThroughRealFileMenu(page, priorRevision) {
    await page.locator(".project-file-button").click();
    const saveButton = page.getByRole("button", { name: /Save to Cloud/i }).first();
    await saveButton.waitFor({ state: "visible", timeout: 10000 });
    const responsePromise = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.request().method() === "PUT"
            && url.pathname === `/api/projects/${PROJECT_ID}/archive`;
    }, { timeout: 30000 });
    await saveButton.click();
    const response = await responsePromise;
    assert.equal(response.ok(), true, `The real Save to Cloud archive request must succeed (${response.status()}).`);
    const expectedRevision = priorRevision + 1;
    await page.waitForFunction((revision) => document.body.innerText.includes(`Cloud:`)
        && document.body.innerText.includes(`Rev ${revision}`), expectedRevision, { timeout: 15000 });
    await page.waitForTimeout(1500);

    const { getClient } = await import("../server/db/index.js");
    const client = await getClient();
    try {
        const result = await client.query(
            "SELECT current_revision, archive_storage_path FROM projects WHERE id = $1",
            [PROJECT_ID],
        );
        const project = result.rows[0];
        assert.equal(project.current_revision, expectedRevision, "The real save must create exactly one temporary revision.");
        return {
            status: response.status(),
            revision: project.current_revision,
            archivePath: project.archive_storage_path,
            toast: await getVisibleToast(page),
        };
    } finally {
        client.release();
    }
}

async function returnToDashboardWithoutAnotherSave(page) {
    page.once("dialog", async (dialog) => {
        await dialog.dismiss();
    });
    await page.getByTestId("topbar-back-to-dashboard-btn").click();
    await page.waitForSelector(".dashboard-container", { state: "visible", timeout: 30000 });
}

const persistenceBaseline = await captureProjectPersistenceState();
const { cookie } = await provisionAuthCookie();
const launcher = await resolveLauncher();
const browser = await chromium.launch({
    ...launcher,
    headless: process.env.HEADED !== "1",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await context.addCookies([cookie]);
await context.addInitScript(() => {
    localStorage.setItem("timeline_studio_ui_language", "en");
    localStorage.setItem("timeline_studio_first_visual_guide_seen", "1");
});

const page = await context.newPage();
const browserErrors = [];
const consoleMessages = [];
page.on("pageerror", (error) => browserErrors.push(error.stack || error.message));
page.on("console", (message) => {
    consoleMessages.push({ type: message.type(), text: message.text() });
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
});

const report = {
    checkedAt: new Date().toISOString(),
    configuration: {
        testUserEmailConfigured: true,
        testProjectIdConfigured: true,
        testTemplateIdConfigured: true,
    },
    persistenceBaseline: {
        revision: persistenceBaseline.project.current_revision,
        archivePath: persistenceBaseline.project.archive_storage_path,
        versionCount: persistenceBaseline.versionIds.length,
        assetCount: persistenceBaseline.assetIds.length,
    },
};

try {
    await openProject(page);
    report.snapshotImmediatelyAfterEditorOpen = await getSnapshotSummary(page);
    report.stableRestoredBaseline = await waitForRestoredProject(page);
    const baselineVisualIds = [...report.stableRestoredBaseline.visualSegmentIds];
    const baselineOverlayCount = report.stableRestoredBaseline.visualOverlaySegmentCount;
    report.playheadBeforeApply = await seekWithRealTimelineRuler(page);

    await openTemplates(page);
    const card = await findTemplateCard(page);
    await card.scrollIntoViewIfNeeded();

    report.card = await card.evaluate((element) => ({
        text: element.innerText,
        html: element.outerHTML,
        rect: element.getBoundingClientRect().toJSON(),
        buttons: [...element.querySelectorAll("button")].map((button) => ({
            text: button.innerText.trim(),
            ariaLabel: button.getAttribute("aria-label"),
            disabled: button.disabled,
            className: button.className,
        })),
        draggableElements: [...element.querySelectorAll("[draggable]")].map((item) => ({
            tagName: item.tagName,
            draggable: item.getAttribute("draggable"),
            className: item.className,
        })),
    }));

    report.applyButtonCounts = {
        visibleApplyText: await card.getByText("Apply to Timeline", { exact: true }).count(),
        accessibleApplyName: await card.getByRole("button", { name: /apply .* to timeline/i }).count(),
        visibleAddText: await card.getByText("Add to Timeline", { exact: true }).count(),
        accessibleAddName: await card.getByRole("button", { name: /add .* to timeline/i }).count(),
    };
    assert.equal(report.applyButtonCounts.visibleApplyText, 1, "The real template card must visibly say Apply to Timeline.");
    assert.equal(report.applyButtonCounts.accessibleApplyName, 1, "The real template card must expose a template-specific Apply accessible name.");
    assert.equal(report.applyButtonCounts.visibleAddText, 0, "The obsolete Add to Timeline card copy must not remain.");

    await page.screenshot({ path: resolve(ARTIFACTS_DIR, "01-real-template-card.png"), fullPage: true });
    await card.screenshot({ path: resolve(ARTIFACTS_DIR, "02-test-template-card.png") });

    report.snapshotWithLibraryOpen = await getSnapshotSummary(page);
    report.timelineOverlayClipCountBeforeApply = await page.locator('.visual-overlay-clip[data-timeline-segment-track="overlay"]').count();
    report.libraryCardCount = await page.locator(".overlay-template-card").count();

    report.firstApply = await applyRenderedTemplate(page, baselineOverlayCount);
    const firstCreated = report.firstApply.snapshot.overlays.filter(
        (overlay) => !report.stableRestoredBaseline.overlayIds.includes(overlay.id),
    );
    report.firstApply.created = firstCreated;
    report.firstApply.mainVisualsPreserved = JSON.stringify(report.firstApply.snapshot.visualSegmentIds) === JSON.stringify(baselineVisualIds);
    report.firstApply.startsAtPlayhead = firstCreated.every(
        (overlay) => Math.abs(Number(overlay.start) - report.playheadBeforeApply.ariaValueNow) <= 0.6,
    );
    assert.ok(firstCreated.length > 0, "The first real card click must create overlay segments.");
    assert.equal(report.firstApply.mainVisualsPreserved, true, "Applying a template must preserve the restored main visual content.");
    assert.equal(report.firstApply.timelineClipCount, report.firstApply.snapshot.visualOverlaySegmentCount, "Every applied overlay must render as a real timeline clip.");
    assert.ok(report.firstApply.previewOverlayCount > 0, "Applied overlays must render in the real preview.");
    assert.ok(report.firstApply.selectedTimelineClipCount > 0, "A newly applied overlay must be selected on the real timeline.");
    report.firstApply.previewEditControlsVisible = report.firstApply.selectedPreviewControlCount > 0;
    assert.equal(report.firstApply.previewEditControlsVisible, true, "A newly applied overlay must expose real preview transform controls.");
    report.firstApply.transformGesture = await moveSelectedOverlayWithRealPointer(page, firstCreated[0].id);
    assert.equal(report.firstApply.transformGesture.changed, true, "Dragging the real preview overlay body must update the created overlay transform.");

    await page.screenshot({ path: resolve(ARTIFACTS_DIR, "03-first-real-apply.png"), fullPage: true });

    report.secondApply = await applyRenderedTemplate(page, report.firstApply.snapshot.visualOverlaySegmentCount);
    const firstIds = new Set(report.firstApply.snapshot.overlayIds);
    report.secondApply.created = report.secondApply.snapshot.overlays.filter((overlay) => !firstIds.has(overlay.id));
    report.secondApply.additive = report.firstApply.snapshot.overlayIds.every((id) => report.secondApply.snapshot.overlayIds.includes(id));
    report.secondApply.freshIds = report.secondApply.created.every((overlay) => !firstIds.has(overlay.id));
    assert.equal(report.secondApply.additive, true, "Repeated application must retain every prior overlay.");
    assert.ok(report.secondApply.created.length > 0, "Repeated application must create fresh overlay segments.");
    assert.equal(report.secondApply.freshIds, true, "Repeated application must use fresh overlay IDs.");

    const overlayRow = page.locator(".track-labels > div").filter({ hasText: /Overlay 1/i }).first();
    await overlayRow.waitFor({ state: "visible", timeout: 10000 });
    const overlayLockButton = overlayRow.locator('button[aria-pressed]').first();
    report.lockBeforeClick = {
        ariaLabel: await overlayLockButton.getAttribute("aria-label"),
        ariaPressed: await overlayLockButton.getAttribute("aria-pressed"),
    };
    await overlayLockButton.click();
    await page.waitForFunction(() => {
        const snapshot = window.__PROJECT_SNAPSHOT__?.();
        return snapshot?.trackLocks?.["overlay-0"] === true || snapshot?.trackLocks?.overlay === true;
    }, null, { timeout: 10000 });
    report.snapshotAfterVisibleOverlayLock = await getSnapshotSummary(page);

    const beforeLockedAttemptCount = report.snapshotAfterVisibleOverlayLock.visualOverlaySegmentCount;
    const lockedCard = await findTemplateCard(page);
    const lockedApplyButton = lockedCard.getByRole("button", { name: /apply .* to timeline/i }).first();
    await lockedApplyButton.click();
    await page.waitForTimeout(1200);
    report.lockedAttempt = {
        toast: await getVisibleToast(page),
        snapshot: await getSnapshotSummary(page),
    };
    report.lockedAttempt.blocked = report.lockedAttempt.snapshot.visualOverlaySegmentCount === beforeLockedAttemptCount;
    report.lockedAttempt.createdCount = report.lockedAttempt.snapshot.visualOverlaySegmentCount - beforeLockedAttemptCount;
    assert.equal(report.lockedAttempt.blocked, true, "The visible overlay-track lock must reject the real card application.");
    assert.match(report.lockedAttempt.toast, /overlay track is locked/i, "Locked-track rejection must be visible to the user.");
    await page.screenshot({ path: resolve(ARTIFACTS_DIR, "04-visible-overlay-lock-attempt.png"), fullPage: true });

    await overlayLockButton.click();
    await page.waitForFunction(() => window.__PROJECT_SNAPSHOT__?.().trackLocks?.overlay !== true, null, { timeout: 10000 });
    report.persistenceSnapshotBeforeSave = await getSnapshotSummary(page);
    const persistedOverlayIds = [...report.persistenceSnapshotBeforeSave.overlayIds];
    const transformedOverlay = report.persistenceSnapshotBeforeSave.overlays.find((overlay) => overlay.id === firstCreated[0].id);
    assert.ok(transformedOverlay, "The transformed overlay must still exist before persistence verification.");

    report.persistenceSave = await saveProjectThroughRealFileMenu(
        page,
        persistenceBaseline.project.current_revision,
    );
    await page.screenshot({ path: resolve(ARTIFACTS_DIR, "05-real-cloud-save.png"), fullPage: true });

    await returnToDashboardWithoutAnotherSave(page);
    const reopenedCard = page.locator(`[data-testid="project-card-${PROJECT_ID}"]`);
    await reopenedCard.waitFor({ state: "visible", timeout: 30000 });
    await reopenedCard.click();
    await page.waitForSelector(".editor-grid", { state: "visible", timeout: 30000 });
    await dismissLanguageIntro(page);
    await page.waitForFunction(() => typeof window.__PROJECT_SNAPSHOT__ === "function", null, { timeout: 30000 });
    report.persistenceReopen = await waitForRestoredProject(page);
    report.persistenceReopen.mainVisualsPreserved = JSON.stringify(report.persistenceReopen.visualSegmentIds) === JSON.stringify(baselineVisualIds);
    report.persistenceReopen.appliedOverlayIdsPreserved = persistedOverlayIds.every((id) => report.persistenceReopen.overlayIds.includes(id));
    const reopenedTransformedOverlay = report.persistenceReopen.overlays.find((overlay) => overlay.id === transformedOverlay.id);
    report.persistenceReopen.transformPreserved = JSON.stringify(reopenedTransformedOverlay?.baseTransform)
        === JSON.stringify(transformedOverlay.baseTransform);
    report.persistenceReopen.timelineClipCount = await page.locator('.visual-overlay-clip[data-timeline-segment-track="overlay"]').count();
    assert.equal(report.persistenceReopen.mainVisualsPreserved, true, "The existing main video must survive save and reopen.");
    assert.equal(report.persistenceReopen.appliedOverlayIdsPreserved, true, "Every applied overlay ID must survive save and reopen.");
    assert.equal(report.persistenceReopen.transformPreserved, true, "The pointer-edited overlay transform must survive save and reopen.");
    assert.equal(
        report.persistenceReopen.timelineClipCount,
        report.persistenceReopen.visualOverlaySegmentCount,
        "Reopened overlays must render as real timeline clips.",
    );
    const previewSeekOverlay = report.persistenceReopen.overlays.find((overlay) => persistedOverlayIds.includes(overlay.id));
    assert.ok(previewSeekOverlay, "A persisted overlay must be available for reopened preview verification.");
    report.persistenceReopen.previewSeek = await seekToTimelineTime(
        page,
        previewSeekOverlay.start + Math.min(0.25, previewSeekOverlay.duration / 2),
        report.persistenceReopen.duration,
    );
    await page.waitForFunction(() => document.querySelectorAll(".visual-overlay-layer:not(.visual-overlay-controls)").length > 0, null, { timeout: 10000 });
    report.persistenceReopen.previewOverlayCount = await page.locator(".visual-overlay-layer:not(.visual-overlay-controls)").count();
    assert.ok(report.persistenceReopen.previewOverlayCount > 0, "A persisted overlay must render in preview after reopen.");
    await page.screenshot({ path: resolve(ARTIFACTS_DIR, "06-reopened-persisted-overlay.png"), fullPage: true });

    report.servedModule = await page.evaluate(async () => {
        const response = await fetch(`/src/components/OverlayTemplateLibrary.jsx?diagnostic=${Date.now()}`, { cache: "no-store" });
        const source = await response.text();
        return {
            ok: response.ok,
            status: response.status,
            hasAddToTimelineText: source.includes("Add to Timeline"),
            hasApplyToTimelineText: source.includes("Apply to Timeline"),
            hasOnApplyTemplate: source.includes("onApplyTemplate"),
            sourceLength: source.length,
        };
    });

    console.log("PASS real authenticated overlay-template interaction and persistence diagnostic");
} finally {
    report.browserErrors = browserErrors;
    report.consoleMessages = consoleMessages;
    await context.close().catch(() => { });
    await browser.close().catch(() => { });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    report.persistenceCleanup = await restoreProjectPersistenceState(persistenceBaseline);
    const redactedReport = redactSensitiveConfiguration(report);
    await writeFile(resolve(ARTIFACTS_DIR, "baseline-report.json"), `${JSON.stringify(redactedReport, null, 2)}\n`);
    console.log("Overlay-template diagnostic report written; configured environment values were not printed.");
}
