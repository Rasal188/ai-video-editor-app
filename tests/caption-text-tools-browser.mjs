import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import { chromium } from "playwright";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { setupTestEnvironment } from "../server/tests/test-helpers.js";
import { cookieParserMiddleware } from "../server/middleware/auth.js";
import { createSubtitleToolsRouter } from "../server/routes/subtitleTools.js";
import { createOllalinkTextTools } from "../server/services/transcription/ollalinkTextTools.js";
import { createProjectArchive } from "../src/lib/projectArchive.js";

const evidence = await fs.mkdtemp(path.resolve("scratch/adaptive-concurrency-20261102/browser-"));
const report = { liveCalls: 0, externalProviderMocked: true, realComponent: true, realBackend: true, checks: [], failures: [], pageErrors: [], externalAttempts: [] };
const examples = [
    ["I have twenty five rupees", "I have 25 rupees"],
    ["The year is two thousand twenty six", "The year is 2026"],
    ["There are one hundred people", "There are 100 people"],
    ["My score is ninety nine", "My score is 99"],
    ["I bought three items", "I bought 3 items"],
    ["मेरे पास पच्चीस रुपये हैं", "मेरे पास 25 रुपये हैं"],
    ["The price is twenty five point five dollars", "The price is 25.5 dollars"],
    ["Call zero nine eight seven", "Call 0987"],
    ["Meet on twenty fifth May", "Meet on 25th May"],
    ["Item AB-25 costs five rupees", "Item AB-25 costs 5 rupees"],
];
const originals = () => [
    { id: "c1", text: examples[0][0], start: 0.125, end: 2.875, timingSource: "asr", words: [{ text: "I", start: 0.125, end: 0.3 }], audioSegmentId: "a1", styleOverrides: { color: "#ffffff" } },
    { id: "c2", text: "Keep this 99.", start: 3, end: 5, timingSource: "asr", words: [{ text: "Keep", start: 3, end: 3.4 }] },
];
let mode = "success";
let calls = [];
let upstream = [];
let backend;
let env;
let vite;
let browser;
let page;
const check = async (name, fn) => {
    try { await fn(); report.checks.push(name); }
    catch (error) { report.failures.push({ name, error: error.stack }); }
};
try {
    env = await setupTestEnvironment();
    const { cookie } = await env.createSession("caption-browser@example.invalid");
    const app = express();
    app.use(cookieParserMiddleware);
    // A fresh router per isolated browser request avoids the production request
    // limiter throttling a test matrix of hundreds of batches. The limiter itself,
    // and its raised allowance, are asserted in the route test.
    app.use("/api/subtitle-tools", (req, res, next) => createSubtitleToolsRouter({
        processSubtitles: createOllalinkTextTools({
            apiKey: "sk_fixture_only", fetchImpl: async (url, options) => {
                const body = JSON.parse(options.body);
                upstream.push({ url, body });
                if (mode === "network") throw new TypeError("Controlled external network failure");
                if (mode === "malformed" || (mode === "partial" && upstream.length % 2 === 0)) return Response.json({});
                if (url.endsWith("/translate")) return Response.json({ translation: body.target === "es" ? `ES: ${body.text}` : `EN: ${body.text}`, source: body.source ?? null, target: body.target, numbers_verified: mode !== "warning", characters: Array.from(body.text).length });
                const normalized = mode === "rewrite" ? "I own 25 coins" : mode === "flatten"
                    ? body.text.replaceAll("twenty five", "25").replaceAll("three", "3").replace(/\s+/g, " ").trim()
                    : new Map(examples).get(body.text) ?? body.text;
                return Response.json({ text: body.text, normalized, changed: normalized !== body.text, language: body.language, characters: Array.from(body.text).length });
            }
        }),
    })(req, res, next));
    backend = app.listen(0, "127.0.0.1");
    await new Promise(resolve => backend.once("listening", resolve));
    const backendOrigin = `http://127.0.0.1:${backend.address().port}`;
    const project = { script: originals().map(c => c.text).join("\n"), captionSegments: originals(), visualSegments: [], audioSegments: [], musicSegments: [], visualOverlaySegments: [], stickerSegments: [], timelineMarkers: [], trackLocks: {}, trackVisibility: {}, captionStyle: { fontId: "default" }, captionsEnabled: true, ratioId: "16:9", captionSize: 22, captionPosition: "bottom", captionStylePresets: [] };
    const fixture = Buffer.from(await (await createProjectArchive({ project, visualSegments: [], audioSegments: [] })).arrayBuffer());
    vite = await createServer({
        configFile: false, envFile: false, cacheDir: path.join(evidence, "vite-cache"), plugins: [react(), {
            name: "caption-verification-local-only",
            transform(code, id) {
                if (id.replaceAll("\\", "/").endsWith("/src/hooks/useEditorCatalog.js")) return code.replace("https://commons.wikimedia.org/w/api.php?", "/__catalog/commons?").replace("https://api.pexels.com/v1/", "/__catalog/pexels/").replace("https://api.openverse.org/v1/audio/?", "/__catalog/audio?");
            },
            configureServer(server) {
                server.middlewares.use("/caption-verification", async (_req, res) => {
                    res.setHeader("Content-Type", "text/html");
                    res.end(await server.transformIndexHtml("/caption-verification", '<div id="root"></div><script type="module" src="/tests/caption-text-tools-harness.jsx"></script>'));
                });
            },
        }], server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**/scratch/**"] } }
    });
    await vite.listen();
    const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, args: ["--disable-background-networking", "--disable-component-update", "--no-default-browser-check"] });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block" });
    await context.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) { report.externalAttempts.push(url.href); return route.abort("blockedbyclient"); }
        if (url.pathname === "/__caption_fixture.timeline") return route.fulfill({ body: fixture, contentType: "application/zip" });
        if (url.pathname.startsWith("/__catalog/")) return route.fulfill({ json: { query: { pages: {} }, results: [], photos: [], videos: [] } });
        if (url.pathname === "/api/subtitle-tools") {
            calls.push(JSON.parse(route.request().postData()));
            if (mode === "batch-fail" && calls.length === 3) return route.fulfill({ status: 503, json: { ok: false, code: "CONTROLLED_FAILURE" } });
            const response = await fetch(`${backendOrigin}/api/subtitle-tools`, { method: "POST", headers: { "Content-Type": "application/json", "X-Subtitle-Tools-Request": "1", Origin: backendOrigin, cookie }, body: route.request().postData() });
            return route.fulfill({ status: response.status, body: await response.text(), contentType: "application/json" });
        }
        if (url.pathname.startsWith("/api/") || (/\.(onnx|wasm|safetensors|bin)$/i.test(url.pathname) && !url.searchParams.has("url"))) return route.abort("blockedbyclient");
        return route.continue();
    });
    await context.addInitScript(() => {
        localStorage.setItem("ai-voiceover-ui-language", "en");
        localStorage.setItem("timeline_studio_first_visual_guide_seen", "1");
        window.__deferred = [];
        const nativeFetch = window.fetch;
        window.fetch = (input, options) => {
            if (input === "/api/subtitle-tools" && window.__deferCaptionRequests) return new Promise((resolve, reject) => window.__deferred.push({ request: JSON.parse(options.body), signal: options.signal, reject, resolve: data => resolve(Response.json(data)) }));
            return nativeFetch(input, options);
        };
    });
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on("pageerror", error => report.pageErrors.push(error.message));
    const tools = () => page.getByRole("region", { name: "Ollalink subtitle text tools", exact: true });
    const review = () => page.getByRole("region", { name: "Review subtitle text", exact: true });
    const button = name => tools().getByRole("button", { name, exact: true });
    const state = () => page.evaluate(() => window.__captionHarness.captions);
    const reset = async (captions = originals()) => {
        mode = "success"; calls = []; upstream = [];
        await page.goto(`${origin}/caption-verification`, { waitUntil: "domcontentloaded", timeout: 90000 });
        await page.waitForFunction(() => window.__captionHarness);
        await page.evaluate(c => window.__captionHarness.setCaptions(c), captions);
        await tools().waitFor();
        await page.waitForFunction(c => JSON.stringify(window.__captionHarness.captions) === JSON.stringify(c), captions);
    };
    // The client mirrors the authenticated route allowance (60 requests/minute), so a
    // 2,000-caption job legitimately paces its remaining batches past one minute.
    const run = async (operation, timeout) => {
        await button(operation === "translate" ? "Translate subtitles" : "Normalize spoken numbers").click();
        await review().waitFor(timeout ? { timeout } : undefined);
    };
    const defer = async () => page.evaluate(() => { window.__deferCaptionRequests = true; });
    const resolve = async () => page.evaluate(() => {
        const pending = window.__deferred[0];
        pending.resolve({ ok: true, operation: pending.request.operation, results: pending.request.cues.map(c => ({ id: c.id, text: `Proposal: ${c.text}`, numbersVerified: true, changed: true })) });
    });
    const resolveAll = async () => page.evaluate(() => {
        window.__deferCaptionRequests = false;
        const pending = window.__deferred.splice(0, window.__deferred.length);
        pending.forEach(p => p.resolve({ ok: true, operation: p.request.operation, results: p.request.cues.map(c => ({ id: c.id, text: `Proposal: ${c.text}`, numbersVerified: true, changed: true })) }));
        // Return the answered batch starts so coverage can be asserted end to end.
        return pending.map(p => p.request.cues[0].id);
    });
    const statusText = () => tools().getByRole("status").innerText();
    await check("selected English→Spanish; double click; explicit apply and complete metadata preservation", async () => {
        await reset(); const before = await state();
        await tools().getByLabel("Source language", { exact: true }).selectOption("en");
        await button("Translate subtitles").evaluate(b => { b.click(); b.click(); }); await review().waitFor();
        assert.equal(calls.length, 1); assert.deepEqual(calls[0], { operation: "translate", source: "en", target: "es", cues: [{ id: "c1", text: before[0].text }] });
        assert.deepEqual(upstream[0].body, { text: before[0].text, target: "es", source: "en" });
        assert.deepEqual(await state(), before);
        await button("Apply reviewed text").click();
        const after = await state(); const expected = { ...before[0], text: `ES: ${before[0].text}`, timingSource: "manual" }; delete expected.words;
        assert.deepEqual(after, [expected, before[1]]);
    });
    await check("all-caption scope, auto source, editable proposal, discard", async () => {
        await reset(); const before = await state();
        await tools().getByLabel("Caption scope").selectOption("all"); await run("translate");
        assert.equal(calls[0].cues.length, 2); assert.equal(upstream.length, 2); assert.ok(upstream.every(c => !Object.hasOwn(c.body, "source")));
        await review().getByLabel("Proposed text 1", { exact: true }).fill("Reviewed translation");
        await button("Discard review").click(); assert.deepEqual(await state(), before);
    });
    await check("Hindi→English language controls and result mapping", async () => {
        await reset([{ id: "c1", text: examples[5][0], start: 0, end: 2 }]);
        await tools().getByLabel("Source language", { exact: true }).selectOption("hi");
        await tools().getByLabel("Translation language", { exact: true }).selectOption("en"); await run("translate");
        assert.deepEqual(upstream[0].body, { text: examples[5][0], target: "en", source: "hi" });
        assert.equal(await review().getByLabel("Proposed text 1", { exact: true }).inputValue(), `EN: ${examples[5][0]}`);
    });
    for (const [index, [input, output]] of examples.entries()) await check(`normalization fixture ${index + 1}: ${input}`, async () => {
        await reset([{ ...originals()[0], text: input }]);
        if (index === 5) await tools().getByLabel("Normalization language", { exact: true }).selectOption("hi");
        const retained = index === 7 || index === 8;
        await run("normalize"); assert.equal(await review().getByLabel("Proposed text 1", { exact: true }).inputValue(), retained ? input : output);
        if (retained) await review().getByRole("alert").filter({ hasText: "Original text retained" }).waitFor();
        assert.equal((await state())[0].text, input); await button("Apply reviewed text").click();
        assert.equal((await state())[0].text, retained ? input : output); assert.equal((await state())[0].start, 0.125); assert.equal((await state())[0].end, 2.875);
    });
    for (const newline of ["\n", "\r\n"]) await check(`normalization flattened provider preserves ${JSON.stringify(newline)} through review/discard/apply and multiple cues`, async () => {
        const input = `  I have twenty five rupees.${newline}${newline}\tI bought three items.  `;
        const expected = `  I have 25 rupees.${newline}${newline}\tI bought 3 items.  `;
        const captions = [{ ...originals()[0], text: input }, { ...originals()[1], text: "Call three five" }];
        await reset(captions); const before = await state(); mode = "flatten";
        await tools().getByLabel("Caption scope").selectOption("all"); await run("normalize");
        assert.deepEqual(await state(), before);
        // DOM textareas use LF internally; application state must retain CRLF.
        assert.equal(await review().getByLabel("Proposed text 1", { exact: true }).inputValue(), expected.replaceAll("\r\n", "\n"));
        assert.equal(await review().getByLabel("Proposed text 2", { exact: true }).inputValue(), before[1].text);
        await review().getByRole("alert").filter({ hasText: "Original text retained" }).waitFor();
        await button("Discard review").click(); assert.deepEqual(await state(), before);
        await run("normalize"); await button("Apply reviewed text").click();
        const after = await state(); const changed = { ...before[0], text: expected, timingSource: "manual" }; delete changed.words;
        assert.deepEqual(after, [changed, before[1]]);
        assert.equal(calls.length, 2); assert.ok(calls.every(call => call.language === "en" && call.cues.length === 2));
    });
    for (const input of ["No numbers here.", "Already 25 and 99.5 rupees; ID AB-25; phone 0987.", "We are one of a kind."]) await check(`unchanged context fixture: ${input}`, async () => {
        await reset([{ ...originals()[0], text: input }]); const before = await state(); await run("normalize");
        await button("Apply reviewed text").click(); assert.deepEqual(await state(), before);
    });
    await check("5,000 Unicode codepoints/cue and exactly 10,000/action accepted", async () => {
        const cues = [0, 1].map(i => ({ id: `c${i + 1}`, text: "😀".repeat(5000), start: i * 2, end: i * 2 + 2 }));
        await reset(cues); await tools().getByLabel("Caption scope").selectOption("all"); await run("normalize");
        assert.equal(upstream.length, 2); assert.equal(Array.from(upstream[0].body.text).length, 5000);
    });
    for (const [name, captions] of [["empty set", []], ["blank cue", [{ id: "c1", text: "  ", start: 0, end: 2 }]], ["5,001 cue", [{ id: "c1", text: "x".repeat(5001), start: 0, end: 2 }]]]) await check(`reject ${name} without dispatch`, async () => {
        await reset(captions); await tools().getByLabel("Caption scope").selectOption("all");
        for (const label of ["Translate subtitles", "Normalize spoken numbers"]) { if (await button(label).isEnabled()) await button(label).click(); }
        assert.equal(calls.length, 0); assert.equal(upstream.length, 0); assert.deepEqual(await state(), captions);
    });
    for (const operation of ["translate", "normalize"]) for (const failure of ["network", "malformed", "partial"]) await check(`${operation}: ${failure} fails atomically`, async () => {
        await reset(); const before = await state(); mode = failure;
        await tools().getByLabel("Caption scope").selectOption("all");
        await button(operation === "translate" ? "Translate subtitles" : "Normalize spoken numbers").click();
        await tools().getByRole("status").filter({ hasText: "failed" }).waitFor();
        assert.equal(await review().count(), 0); assert.deepEqual(await state(), before);
    });
    await check("number verification warning and normalization ambiguity disclosure", async () => {
        await reset(); mode = "warning"; await run("translate"); await review().getByRole("alert").waitFor();
        await button("Discard review").click(); mode = "success"; await run("normalize");
        assert.match(await review().innerText(), /ambiguous|ambiguity/i);
    });
    await check("normalization rejects non-number rewriting", async () => {
        await reset(); mode = "rewrite"; await button("Normalize spoken numbers").click();
        await tools().getByRole("status").filter({ hasText: "failed" }).waitFor(); assert.equal(await review().count(), 0);
    });
    for (const mutation of ["edit", "timing", "lock", "selection", "project", "unmount", "cancel"]) await check(`pending ${mutation} suppresses abort-insensitive late response`, async () => {
        await reset(); await defer(); await button("Translate subtitles").click(); await page.waitForFunction(() => window.__deferred.length === 1);
        await page.evaluate(kind => {
            const h = window.__captionHarness;
            if (kind === "edit") h.setCaptions(c => c.map((x, i) => i ? x : { ...x, text: "User edit" }));
            if (kind === "timing") h.setCaptions(c => c.map((x, i) => i ? x : { ...x, start: 0.5 }));
            if (kind === "lock") h.setLocked(true);
            if (kind === "selection") h.setSelected("c2");
            if (kind === "project") h.setIdentity("project-two");
            if (kind === "unmount") h.setMounted(false);
        }, mutation);
        if (mutation === "cancel") await button("Cancel subtitle processing").click();
        await page.waitForTimeout(50); const before = await state(); await resolve(); await page.waitForTimeout(100);
        assert.equal(await review().count(), 0); assert.deepEqual(await state(), before);
        assert.equal(await page.evaluate(() => window.__deferred[0].signal.aborted), true);
    });
    for (const mutation of ["edit", "selection", "project"]) await check(`review ${mutation} blocks stale apply`, async () => {
        await reset(); await run("translate");
        await page.evaluate(kind => {
            const h = window.__captionHarness;
            if (kind === "edit") h.setCaptions(c => c.map((x, i) => i ? x : { ...x, text: "User edit" }));
            if (kind === "selection") h.setSelected("c2");
            if (kind === "project") h.setIdentity("project-two");
        }, mutation);
        await page.waitForTimeout(50); assert.equal(await button("Apply reviewed text").isDisabled(), true);
    });
    const manyCaptions = count => Array.from({ length: count }, (_, i) => ({ ...originals()[0], id: `c${i + 1}`, start: i * 3, end: i * 3 + 2 }));
    for (const operation of ["translate", "normalize"]) {
        for (const count of [1, 20, 21, 40, 100, 615, 2000]) await check(`${operation}: ${count} captions complete ordered batches and explicit review/discard/apply`, async () => {
            const captions = manyCaptions(count);
            await reset(captions);
            await tools().getByLabel("Caption scope").selectOption("all");
            assert.equal(await tools().getByLabel("Caption scope").locator('option[value="all"]').innerText(), "All captions");
            await run(operation, count >= 2000 ? 150000 : undefined);
            assert.equal(calls.length, Math.ceil(count / 20));
            assert.equal(upstream.length, count);
            // Batches may complete out of order, so the *dispatch* sequence is not
            // asserted. Every caption must appear exactly once and the aggregated
            // result below must still follow the original caption order.
            assert.deepEqual([...calls.flatMap(c => c.cues.map(c => c.id))].sort(), captions.map(c => c.id).sort());
            assert.deepEqual(await state(), captions);
            assert.match(await tools().getByRole("status").innerText(), new RegExp(`${count} of ${count}`));
            assert.equal(await review().getByLabel(/^Proposed text /).count(), Math.min(count, 20));
            if (count === 615) {
                await button("Next review page").click();
                assert.equal(await review().getByLabel("Proposed text 21", { exact: true }).inputValue(), operation === "translate" ? `ES: ${examples[0][0]}` : examples[0][1]);
                await review().getByLabel("Proposed text 21", { exact: true }).fill("Explicitly reviewed text");
                await button("Previous review page").click();
            }
            await button("Apply reviewed text").click();
            const after = await state();
            assert.equal(after.length, count);
            for (let i = 0; i < count; i++) {
                const expected = { ...captions[i], text: count === 615 && i === 20 ? "Explicitly reviewed text" : operation === "translate" ? `ES: ${captions[i].text}` : examples[0][1], timingSource: "manual" };
                delete expected.words;
                assert.deepEqual(after[i], expected);
            }
            // A second complete review can be discarded without mutating any cue.
            if (count === 615) {
                await reset(captions); await tools().getByLabel("Caption scope").selectOption("all"); await run(operation);
                await button("Discard review").click(); assert.deepEqual(await state(), captions);
            }
        });
        await check(`${operation}: a failed batch preserves already-succeeded batches and retry repeats none of them`, async () => {
            const captions = manyCaptions(615);
            await reset(captions); mode = "batch-fail";
            await tools().getByLabel("Caption scope").selectOption("all");
            await button(operation === "translate" ? "Translate subtitles" : "Normalize spoken numbers").click();
            await button("Retry failed batch").waitFor();
            // Which batch the injected failure lands on depends on concurrent
            // completion order, so the checkpointed count is read rather than fixed.
            const failedStatus = await statusText();
            const checkpointed = Number((failedStatus.match(/(\d+) of 615 captions processed/) ?? [])[1]);
            assert.ok(checkpointed > 0, `successful batches must be retained: ${failedStatus}`);
            assert.ok(checkpointed < 615, "the failed batch must not be reported successful");
            assert.equal(await review().count(), 0, "no review is offered until every batch succeeds");
            assert.deepEqual(await state(), captions, "nothing is applied after a failure");
            assert.equal(await tools().getByRole("progressbar").getAttribute("value"), String(checkpointed));
            mode = "success";
            await button("Retry failed batch").evaluate(b => { b.click(); b.click(); });
            await review().waitFor();
            // Every batch is dispatched exactly once, except the single failed one
            // that is retried exactly once.
            const starts = calls.map(c => c.cues[0].id);
            assert.equal(starts.length, 31 + 1);
            assert.equal(new Set(starts).size, 31);
            // A duplicated batch contributes two entries, so count distinct repeat ids.
            const repeated = [...new Set(starts.filter(id => starts.indexOf(id) !== starts.lastIndexOf(id)))];
            assert.equal(repeated.length, 1, `exactly one batch may be retried: ${repeated.join(", ")}`);
            assert.equal(upstream.length, 615, "each caption reaches the provider exactly once");
            assert.deepEqual(await state(), captions);
            await button("Apply reviewed text").click(); assert.equal((await state()).length, 615);
        });
        for (const mutation of ["cancel", "edit", "project", "lock", "unmount"]) await check(`${operation}: ${mutation} after a successful first batch suppresses late remaining batches`, async () => {
            const captions = manyCaptions(100);
            await reset(captions); await defer();
            await tools().getByLabel("Caption scope").selectOption("all");
            await button(operation === "translate" ? "Translate subtitles" : "Normalize spoken numbers").click();
            // With adaptive concurrency two batches are in flight immediately.
            await page.waitForFunction(() => window.__deferred.length === 2);
            // Playwright can only serialise plain data across the CDP boundary, so the
            // operation is passed as a string and the transform is built in the page.
            const settle = data => page.evaluate(payload => {
                const text = payload.operation === "translate" ? t => `ES: ${t}` : t => t.replace("twenty five", "25");
                const p = window.__deferred.find(x => !x.done && x.request.cues[0].id === payload.first);
                if (!p) return false;
                p.done = true;
                p.resolve({ ok: true, operation: p.request.operation, results: p.request.cues.map(c => ({ id: c.id, text: text(c.text), numbersVerified: true, changed: true })) });
                return true;
            }, { first: "c1", operation });
            assert.equal(await settle(), true);
            await page.waitForFunction(() => /20 of 100/.test(document.querySelector('[aria-label="Ollalink subtitle text tools"] [role="status"]')?.textContent ?? ""));
            assert.deepEqual(await state(), captions);
            await page.evaluate(kind => {
                const h = window.__captionHarness;
                if (kind === "edit") h.setCaptions(c => c.map((x, i) => i ? x : { ...x, text: "User edit" }));
                if (kind === "project") h.setIdentity("other-project");
                if (kind === "lock") h.setLocked(true);
                if (kind === "unmount") h.setMounted(false);
            }, mutation);
            if (mutation === "cancel") await button("Cancel subtitle processing").click();
            await page.waitForTimeout(50); const before = await state();
            // Every still-pending batch resolves late and must be ignored.
            await page.evaluate(() => window.__deferred.filter(p => !p.done).forEach(p => {
                p.done = true;
                p.resolve({ ok: true, operation: p.request.operation, results: p.request.cues.map(c => ({ id: c.id, text: c.text, numbersVerified: true, changed: false })) });
            }));
            await page.waitForTimeout(100);
            assert.equal(await review().count(), 0, "no late batch may publish a review");
            assert.deepEqual(await state(), before, "no late batch may mutate captions");
        });
        await check(`${operation}: failed batch checkpoint invalidated by identical-caption project switch`, async () => {
            await reset(manyCaptions(100)); mode = "batch-fail";
            await tools().getByLabel("Caption scope").selectOption("all");
            await button(operation === "translate" ? "Translate subtitles" : "Normalize spoken numbers").click();
            await button("Retry failed batch").waitFor();
            const dispatched = calls.length;
            assert.ok(dispatched > 0);
            await page.evaluate(() => window.__captionHarness.setIdentity("changed-project"));
            await button("Retry failed batch").waitFor({ state: "hidden" });
            assert.equal(calls.length, dispatched, "no retry is dispatched for a stale project");
            assert.equal(await review().count(), 0);
        });
    }
    await check("several batches really are in flight at once and a free-slot wait is never called a cooldown", async () => {
        const captions = manyCaptions(100);
        await reset(captions);
        await tools().getByLabel("Caption scope").selectOption("all");
        await defer();
        await button("Translate subtitles").click();
        // Two batches must be outstanding simultaneously: this is the real
        // end-to-end proof of concurrent dispatch, not a unit-level simulation.
        await page.waitForFunction(() => window.__deferred.length === 2);
        await page.waitForFunction(() => /Waiting for an available request slot/.test(document.querySelector('[aria-label="Ollalink subtitle text tools"] [role="status"]')?.textContent ?? ""));
        const blocked = await statusText();
        assert.match(blocked, /Waiting for an available request slot \(2 of 2 request slots in use\)/);
        // The scheduler is blocked on its own concurrency allowance, so it must not
        // claim the provider is cooling down.
        assert.doesNotMatch(blocked, /provider cooldown|rate limit/i);
        assert.match(await tools().getByRole("note").filter({ hasText: "Adaptive concurrency" }).innerText(), /2 of 2 request slots in use/);
        assert.deepEqual(await state(), captions);
        // Both slots answered the two deferred batches without touching the route.
        assert.deepEqual((await resolveAll()).sort(), ["c1", "c21"]);
        await review().waitFor();
        // Exactly two batches were held in flight at once, then the remaining three
        // went through the real route. Together they must cover every caption once.
        assert.equal(calls.length, 3);
        assert.deepEqual(calls.map(c => c.cues[0].id).sort(), ["c41", "c61", "c81"]);
        assert.deepEqual(calls.flatMap(c => c.cues.map(cue => cue.id)).sort(), captions.slice(40).map(c => c.id).sort());
        assert.equal(await review().getByLabel(/^Proposed text /).count(), 20);
        await button("Apply reviewed text").click();
        const after = await state();
        assert.equal(after.length, 100);
        assert.deepEqual(after.map(c => c.id), captions.map(c => c.id));
        assert.deepEqual(after.map(c => [c.start, c.end]), captions.map(c => [c.start, c.end]));
    });
    await check("aggregate character budget splits requests and blank cues remain untouched", async () => {
        const captions = [5000, 5000, 1, 0].map((n, i) => ({ id: `c${i + 1}`, text: n ? "x".repeat(n) : "  ", start: i, end: i + 1 }));
        await reset(captions); await tools().getByLabel("Caption scope").selectOption("all"); await run("translate");
        assert.deepEqual(calls.map(c => c.cues.length).sort(), [1, 2]);
        await button("Apply reviewed text").click(); assert.deepEqual((await state())[3], captions[3]);
    });
    await check("actual editor import and Captions panel execute both features through backend", async () => {
        mode = "success"; calls = []; upstream = [];
        // Return the snapshot from the guarded browser evaluation itself: the
        // development bridge can be re-registered between separate wait/read calls.
        const editorSnapshot = async () => {
            const handle = await page.waitForFunction(() => {
                const snapshot = window.__PROJECT_SNAPSHOT__?.();
                return snapshot?.captionSegments ? snapshot : false;
            }, null, { timeout: 90000 });
            try { return await handle.jsonValue(); }
            finally { await handle.dispose(); }
        };
        await page.goto(`${origin}/caption-verification?editor=1`, { waitUntil: "domcontentloaded", timeout: 90000 });
        await page.waitForFunction(() => window.__PROJECT_SNAPSHOT__?.().captionSegments.length === 2, null, { timeout: 90000 });
        await page.locator(".project-import-overlay").waitFor({ state: "hidden" });
        // Use the real caption rail control, not a substitute component.
        await page.locator('.tool-rail button').filter({ hasText: /Captions/ }).first().click();
        await tools().waitFor();
        await tools().getByLabel("Caption scope").selectOption("all");
        const before = (await editorSnapshot()).captionSegments;
        await run("translate"); assert.deepEqual((await editorSnapshot()).captionSegments, before);
        // Switch projects while the originals are still identical: content-only
        // invalidation cannot protect this review. The dev bridge is temporarily
        // removed during import, so wait for its registration as well as identity.
        const identity = (await editorSnapshot()).commandState.projectIdentity;
        await page.locator(".project-file-input").setInputFiles({ name: "same-caption-project.timeline", mimeType: "application/zip", buffer: fixture });
        await page.waitForFunction(old => {
            const snapshot = window.__PROJECT_SNAPSHOT__?.();
            return snapshot && snapshot.commandState.projectIdentity !== old;
        }, identity);
        await page.locator(".project-import-overlay").waitFor({ state: "hidden" });
        // Import may unmount the review entirely; otherwise it must be stale.
        if (await review().count()) {
            assert.equal(await button("Apply reviewed text").isDisabled(), true);
            await button("Discard review").click();
        }
        const imported = (await editorSnapshot()).captionSegments;
        assert.deepEqual(imported, before);
        await page.locator('.tool-rail button').filter({ hasText: /Captions/ }).first().click();
        await tools().waitFor();
        await tools().getByLabel("Caption scope").selectOption("all");
        await run("normalize"); await button("Apply reviewed text").click();
        const after = (await editorSnapshot()).captionSegments;
        assert.equal(after[0].text, examples[0][1]); assert.deepEqual(after[1], before[1]);
        assert.deepEqual(after.map(c => [c.id, c.start, c.end]), before.map(c => [c.id, c.start, c.end]));
        await page.screenshot({ path: path.join(evidence, "editor.png"), fullPage: true });
    });
} catch (error) { report.failures.push({ name: "harness", error: error.stack }); }
finally {
    await fs.writeFile(path.join(evidence, "results.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ evidence, passed: report.checks.length, failed: report.failures.length, failures: report.failures, pageErrors: report.pageErrors, liveCalls: 0 }, null, 2));
    await browser?.close(); await vite?.close();
    if (backend) await new Promise(resolve => backend.close(resolve));
    await env?.teardown();
}
if (report.failures.length || report.pageErrors.length || report.externalAttempts.length) process.exitCode = 1;
