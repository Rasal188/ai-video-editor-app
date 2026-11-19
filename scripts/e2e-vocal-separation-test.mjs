import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { chromium } from "playwright";

const DEV_SERVER_URL = process.env.EDITOR_URL || "http://localhost:5173/?view=editor";
const SAMPLE_MEDIA_PATH = resolve("test-artifacts/short-speech-sample.mp4");
const ARTIFACTS_DIR = resolve("test-artifacts/playwright");
const EXPORTED_PROJECT_PATH = resolve(ARTIFACTS_DIR, "vocal-separation-project.timeline");
const INFERENCE_TIMEOUT_MS = Number(process.env.VOCAL_SEPARATION_TIMEOUT_MS) || 10 * 60 * 1000;

async function obtainTestAuthCookie() {
    try {
        const { config } = await import("../server/config.js");
        const { generateSessionToken, hashSessionToken } = await import("../server/services/auth/crypto.js");
        const { createSession } = await import("../server/db/queries/auth.js");
        const { getUserByEmail } = await import("../server/db/queries/users.js");
        const user = await getUserByEmail("e2e.alice@example.com");
        if (!user) return null;
        const rawToken = generateSessionToken();
        await createSession({
            userId: user.id,
            tokenHash: hashSessionToken(rawToken, config.auth.salt),
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        });
        return {
            name: config.auth.sessionCookieName,
            value: rawToken,
            domain: "localhost",
            path: "/",
            httpOnly: true,
            sameSite: "Lax",
        };
    } catch (error) {
        console.warn(`Could not provision local E2E session: ${error.message}`);
        return null;
    }
}

async function resolveBrowserLauncher() {
    const channel = process.env.BROWSER_CHANNEL;
    const executablePath = process.env.BROWSER_EXECUTABLE_PATH;
    if (executablePath && existsSync(executablePath)) return { executablePath };
    if (channel) return { channel };
    try {
        const browser = await chromium.launch({ headless: true });
        await browser.close();
        return {};
    } catch {
        return { channel: "chrome" };
    }
}

function near(actual, expected, tolerance = 0.2) {
    return Math.abs(Number(actual) - Number(expected)) <= tolerance;
}

async function run() {
    assert.ok(existsSync(SAMPLE_MEDIA_PATH), `Required fixture not found: ${SAMPLE_MEDIA_PATH}`);
    mkdirSync(ARTIFACTS_DIR, { recursive: true });

    const browser = await chromium.launch({
        ...(await resolveBrowserLauncher()),
        headless: process.env.HEADED !== "1",
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--enable-webgl",
            "--ignore-gpu-blocklist",
        ],
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const authCookie = await obtainTestAuthCookie();
    if (authCookie) await context.addCookies([authCookie]);
    await context.addInitScript(() => {
        localStorage.setItem("timeline_studio_ui_language", "en");
        localStorage.setItem("timeline-studio-ui-language", "en");
        localStorage.setItem("timeline-studio-first-visual-guide-seen-v1", "1");
        localStorage.setItem("timeline_studio_first_visual_guide_seen", "1");
    });

    const page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    page.on("pageerror", (error) => {
        pageErrors.push(error.message);
        console.error(`[Browser PageError] ${error.message}`);
    });
    page.on("console", (message) => {
        const text = message.text();
        if (message.type() === "error") consoleErrors.push(text);
        console.log(`[Browser ${message.type()}] ${text}`);
    });
    page.on("requestfailed", (request) => {
        console.warn(`[Request Failed] ${request.url()} ${request.failure()?.errorText || ""}`);
    });

    try {
        console.log(`Navigating to ${DEV_SERVER_URL}`);
        await page.goto(DEV_SERVER_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.locator(".editor-grid").waitFor({ state: "visible", timeout: 30_000 });
        await page.waitForFunction(() => typeof window.__PROJECT_SNAPSHOT__ === "function", null, { timeout: 30_000 });

        const languageButton = page.locator(".language-grid button").filter({ hasText: "English" }).first();
        if (await languageButton.isVisible({ timeout: 1_000 }).catch(() => false)) await languageButton.click();

        console.log(`Uploading ${SAMPLE_MEDIA_PATH}`);
        await page.locator("input.sr-only[type='file']").first().setInputFiles(SAMPLE_MEDIA_PATH);
        const visualClip = page.locator('[data-timeline-segment-track="image"]').first();
        await visualClip.waitFor({ state: "visible", timeout: 30_000 });
        await visualClip.click();
        await page.waitForTimeout(750);
        const beforeHandle = await page.waitForFunction(
            () => {
                const snapshot = window.__PROJECT_SNAPSHOT__?.();
                return snapshot?.visualSegments?.[0]?.id ? snapshot : false;
            },
            null,
            { timeout: 30_000 },
        );

        const before = await beforeHandle.jsonValue();
        const source = before.visualSegments?.[0];
        assert.ok(source?.id, "Uploaded visual segment must exist in the project snapshot");
        assert.ok(Number(source.duration) > 0, "Uploaded visual segment must have a positive duration");
        assert.notEqual(source.sourceAudioDisabled, true, "Embedded source audio must begin enabled");

        const captionRailButton = page.locator(".tool-rail button").filter({ hasText: /^Caption/i }).first();
        await captionRailButton.waitFor({ state: "visible", timeout: 10_000 });
        await captionRailButton.click();

        const audioRailButton = page.locator(".tool-rail button").filter({ hasText: /^Audio$/i }).first();
        await audioRailButton.waitFor({ state: "visible", timeout: 10_000 });
        await audioRailButton.click();

        const separationButton = page.locator(".separation-entry-card");
        await separationButton.waitFor({ state: "visible", timeout: 10_000 });
        assert.equal(
            await separationButton.isDisabled(),
            false,
            "Vocal separation must remain enabled for the imported video after caption workflow focus",
        );

        console.log("Starting real vocal-separation model download and inference");
        const startedAt = Date.now();
        await separationButton.click();

        const afterHandle = await page.waitForFunction(
            ({ visualId }) => {
                const snapshot = window.__PROJECT_SNAPSHOT__?.();
                const visual = snapshot?.visualSegments?.find((item) => item.id === visualId);
                const vocal = snapshot?.audioSegments?.find((item) => item.sourceKind === "separated");
                return visual?.sourceAudioDisabled === true
                    && visual?.audioSeparated === true
                    && vocal
                    && snapshot?.musicSegments?.length
                    ? snapshot
                    : false;
            },
            { visualId: source.id },
            { timeout: INFERENCE_TIMEOUT_MS },
        );

        const elapsedSeconds = (Date.now() - startedAt) / 1000;
        const after = await afterHandle.jsonValue();
        const visual = after.visualSegments.find((item) => item.id === source.id);
        const vocal = after.audioSegments.find((item) => item.sourceKind === "separated");
        const instrumental = after.musicSegments[0];

        assert.ok(vocal, "A separated vocal segment must be placed on the audio lane");
        assert.ok(instrumental, "An instrumental segment must be placed on the music lane");
        assert.ok(/\.wav$/i.test(vocal.name), "The vocal stem must be represented as a WAV asset");
        assert.ok(/\.wav$/i.test(after.musicName), "The instrumental stem must be represented as a WAV asset");
        assert.equal(visual.sourceAudioDisabled, true, "The original embedded audio must be muted after successful separation");
        assert.equal(visual.audioSeparated, true, "The visual segment must persist the separated-audio state");
        assert.equal(visual.sourceAudioRoutedToAudioSegmentId, vocal.id, "The visual must reference its generated vocal segment");
        assert.ok(near(vocal.start, 0), `Vocal stem start must remain at the selected clip start; got ${vocal.start}`);
        assert.ok(near(instrumental.start, vocal.start), "Both stems must begin at the same timeline position");
        assert.ok(near(vocal.duration, source.duration, 0.35), `Vocal duration ${vocal.duration} must match clip duration ${source.duration}`);
        assert.ok(near(instrumental.duration, vocal.duration, 0.2), "Vocal and instrumental durations must match");

        const audioClipCount = await page.locator('[data-timeline-segment-track="audio"]').count();
        const musicClipCount = await page.locator('[data-timeline-segment-track="music"]').count();
        assert.ok(audioClipCount >= 1, "The vocal stem must be visible on the audio timeline lane");
        assert.ok(musicClipCount >= 1, "The instrumental stem must be visible on the music timeline lane");

        const playButton = page.locator(".timeline-play-button");
        await playButton.waitFor({ state: "visible", timeout: 10_000 });
        assert.equal(await playButton.isEnabled(), true, "The timeline play control must be enabled after stem placement");

        const beforePlayback = await page.evaluate(() => {
            const video = document.querySelector(".preview-video");
            const audio = [...document.querySelectorAll("audio:not([controls])")];
            return {
                video: video ? {
                    currentTime: video.currentTime,
                    muted: video.muted,
                    paused: video.paused,
                } : null,
                audio: audio.map((element) => ({
                    src: element.currentSrc || element.src,
                    currentTime: element.currentTime,
                    paused: element.paused,
                })),
            };
        });

        assert.ok(beforePlayback.video, "The selected video must be rendered in the preview stage");
        assert.equal(beforePlayback.video.muted, true, "The original embedded video audio must remain muted during playback");
        assert.ok(beforePlayback.audio.length >= 2, "The vocal and instrumental media elements must both be mounted");

        await playButton.click();
        await page.waitForFunction(
            ({ initialVideoTime, initialAudio }) => {
                const video = document.querySelector(".preview-video");
                const audio = [...document.querySelectorAll("audio:not([controls])")];
                const videoAdvanced = Boolean(
                    video
                    && !video.paused
                    && video.currentTime > initialVideoTime + 0.15,
                );
                const advancingAudio = audio.filter((element) => {
                    const src = element.currentSrc || element.src;
                    const initial = initialAudio.find((item) => item.src === src)?.currentTime ?? 0;
                    return !element.paused && element.currentTime > initial + 0.15;
                });
                return videoAdvanced && advancingAudio.length >= 2;
            },
            {
                initialVideoTime: beforePlayback.video.currentTime,
                initialAudio: beforePlayback.audio,
            },
            { timeout: 10_000 },
        );

        const playback = await page.evaluate(() => {
            const video = document.querySelector(".preview-video");
            const audio = [...document.querySelectorAll("audio:not([controls])")];
            return {
                video: video ? {
                    currentTime: video.currentTime,
                    muted: video.muted,
                    paused: video.paused,
                } : null,
                audio: audio.map((element) => ({
                    src: element.currentSrc || element.src,
                    currentTime: element.currentTime,
                    paused: element.paused,
                })),
            };
        });
        const advancingAudio = playback.audio.filter((element) => !element.paused && element.currentTime > 0.15);
        assert.ok(playback.video.currentTime > beforePlayback.video.currentTime + 0.15, "Timeline video playback must advance after stem placement");
        assert.equal(playback.video.muted, true, "Playback must not re-enable the original embedded audio");
        assert.ok(advancingAudio.length >= 2, "Both generated stems must advance during timeline playback");
        await playButton.click();

        rmSync(EXPORTED_PROJECT_PATH, { force: true });
        await page.locator(".project-file-button").click();
        const exportProjectButton = page.locator(".file-menu-action.is-primary");
        const [download] = await Promise.all([
            page.waitForEvent("download", { timeout: 30_000 }),
            exportProjectButton.click(),
        ]);
        await download.saveAs(EXPORTED_PROJECT_PATH);

        const archive = unzipSync(new Uint8Array(readFileSync(EXPORTED_PROJECT_PATH)));
        assert.ok(archive["project.json"], "The exported project must include project.json");
        const payload = JSON.parse(strFromU8(archive["project.json"]));
        const archivedVisual = payload.project?.visualSegments?.find((item) => item.id === source.id);
        const archivedVocal = payload.project?.audioSegments?.find((item) => item.id === vocal.id);
        const archivedInstrumental = payload.project?.musicSegments?.[0];
        const archivedVocalMedia = payload.media?.audioSegments?.find((item) => item.id === vocal.id);

        assert.equal(archivedVisual?.sourceAudioDisabled, true, "The exported project must persist embedded-source suppression");
        assert.equal(archivedVisual?.audioSeparated, true, "The exported project must persist the separated-audio state");
        assert.equal(archivedVisual?.sourceAudioRoutedToAudioSegmentId, vocal.id, "The exported project must persist vocal routing metadata");
        assert.equal(archivedVocal?.sourceKind, "separated", "The exported project must retain the separated vocal segment");
        assert.ok(archivedInstrumental, "The exported project must retain the instrumental timeline segment");
        assert.ok(archivedVocalMedia?.path && archive[archivedVocalMedia.path], "The exported project must package the vocal WAV asset");
        assert.ok(payload.media?.music?.path && archive[payload.media.music.path], "The exported project must package the instrumental WAV asset");

        await page.locator("input.project-file-input").setInputFiles(EXPORTED_PROJECT_PATH);
        await page.locator(".project-import-overlay").waitFor({ state: "hidden", timeout: 60_000 }).catch(() => { });
        await page.waitForFunction(() => typeof window.__PROJECT_SNAPSHOT__ === "function", null, { timeout: 30_000 });
        const restoredHandle = await page.waitForFunction(
            ({ visualId, vocalId }) => {
                const snapshot = window.__PROJECT_SNAPSHOT__?.();
                const restoredVisual = snapshot?.visualSegments?.find((item) => item.id === visualId);
                const restoredVocal = snapshot?.audioSegments?.find((item) => item.id === vocalId);
                return restoredVisual?.sourceAudioDisabled === true
                    && restoredVisual?.audioSeparated === true
                    && restoredVisual?.sourceAudioRoutedToAudioSegmentId === vocalId
                    && restoredVocal?.sourceKind === "separated"
                    && snapshot?.musicSegments?.length
                    ? snapshot
                    : false;
            },
            { visualId: source.id, vocalId: vocal.id },
            { timeout: 60_000 },
        );

        const restored = await restoredHandle.jsonValue();
        const restoredVisual = restored.visualSegments.find((item) => item.id === source.id);
        const restoredVocal = restored.audioSegments.find((item) => item.id === vocal.id);
        assert.equal(restoredVisual.sourceAudioDisabled, true, "Reopened project must keep the original embedded audio muted");
        assert.equal(restoredVisual.audioSeparated, true, "Reopened project must keep separation metadata");
        assert.equal(restoredVisual.sourceAudioRoutedToAudioSegmentId, restoredVocal.id, "Reopened project must keep vocal routing metadata");
        assert.ok(near(restoredVocal.duration, vocal.duration, 0.2), "Reopened vocal duration must match the generated stem");
        assert.ok(near(restored.musicSegments[0]?.duration, instrumental.duration, 0.2), "Reopened instrumental duration must match the generated stem");
        assert.ok(await page.locator('[data-timeline-segment-track="audio"]').count(), "Reopened vocal stem must remain visible on the audio lane");
        assert.ok(await page.locator('[data-timeline-segment-track="music"]').count(), "Reopened instrumental stem must remain visible on the music lane");
        assert.equal(await page.locator(".preview-video").evaluate((element) => element.muted), true, "Reopened preview must keep embedded source audio muted");

        const screenshotPath = resolve(ARTIFACTS_DIR, "vocal-separation-complete.png");
        await page.screenshot({ path: screenshotPath, fullPage: true });

        assert.deepEqual(pageErrors, [], `Unexpected browser page errors: ${pageErrors.join(" | ")}`);
        const fatalConsoleErrors = consoleErrors.filter((message) => /VOCAL_|uncaught|syntaxerror|referenceerror/i.test(message));
        assert.deepEqual(fatalConsoleErrors, [], `Unexpected vocal-separation console errors: ${fatalConsoleErrors.join(" | ")}`);

        console.log("✔ Real worker runtime loaded and model inference completed");
        console.log(`✔ Vocal stem: ${vocal.name}, ${vocal.duration.toFixed(3)}s`);
        console.log(`✔ Instrumental stem: ${after.musicName}, ${instrumental.duration.toFixed(3)}s`);
        console.log("✔ Vocal and instrumental stems both advance during timeline playback");
        console.log("✔ Original embedded source audio is durably suppressed during playback");
        console.log("✔ Both stems and source-mute routing persist through project export and reopen");
        console.log(`✔ Separation completed in ${elapsedSeconds.toFixed(1)}s`);
        console.log(`✔ Screenshot: ${screenshotPath}`);
    } finally {
        await browser.close();
    }
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
