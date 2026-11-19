import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

const TEST_PNG_BYTES = Buffer.from([
    137, 80, 78, 71, 13, 10, 26, 10,
    0, 0, 0, 13, 73, 72, 68, 82,
    0, 0, 0, 1, 0, 0, 0, 1,
    8, 6, 0, 0, 0, 31, 21, 196, 137,
    0, 0, 0, 13, 73, 68, 65, 84,
    8, 215, 99, 248, 207, 192, 240, 31,
    0, 5, 0, 1, 255, 137, 153, 93, 29,
    0, 0, 0, 0, 73, 69, 78, 68,
    174, 66, 96, 130,
]);

const vite = await createServer({
    server: { host: "127.0.0.1", port: 0, warmup: { clientFiles: [] } },
    plugins: [{
        name: "overlay-template-library-test-page",
        configureServer(server) {
            server.middlewares.use("/api/assets", (request, response, next) => {
                if (!request.url?.endsWith("/content")) {
                    next();
                    return;
                }
                response.statusCode = 200;
                response.setHeader("Content-Type", "image/png");
                response.setHeader("Content-Length", String(TEST_PNG_BYTES.length));
                response.end(TEST_PNG_BYTES);
            });
            server.middlewares.use("/overlay-template-library-test", async (_request, response) => {
                response.setHeader("Content-Type", "text/html");
                response.end(await server.transformIndexHtml(
                    "/overlay-template-library-test",
                    '<div id="root"></div><script type="module" src="/tests/overlay-template-library-harness.jsx"></script>',
                ));
            });
        },
    }],
});

let browser;
try {
    await vite.listen();
    const port = vite.httpServer.address().port;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
    });

    await page.addInitScript(() => {
        const vectorElement = (id) => ({
            id,
            kind: "vector",
            name: "Badge",
            start: 0,
            duration: 3,
            layer: 1,
            baseTransform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
            keyframes: [],
            animation: {
                in: { id: "none", duration: 0.4 },
                out: { id: "none", duration: 0.4 },
            },
            mask: { type: "none", feather: 0, inverted: false },
            vector: {
                body: '<svg viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>',
                width: 10,
                height: 10,
            },
        });
        const makeTemplate = (id, name, description, updatedAt) => ({
            id,
            ownerId: "owner-a",
            format: "ai-shorts-overlay-template",
            schemaVersion: 1,
            name,
            description,
            canvas: { width: 1080, height: 1920, aspectRatio: "9:16" },
            elements: [vectorElement(`${id}-element`)],
            metadata: { source: "editor" },
            createdAt: updatedAt,
            updatedAt,
        });

        window.timelineUndoCount = 0;
        window.addEventListener("keydown", (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
                window.timelineUndoCount += 1;
            }
        });

        window.templateApi = {
            mode: "pending",
            requests: [],
            templates: [
                makeTemplate("template-1", "Corner badge", "Reusable corner badge", "2026-11-16T10:00:00.000Z"),
                makeTemplate("template-2", "Sale banner", "Seasonal sale banner", "2026-11-15T10:00:00.000Z"),
            ],
            assets: [{
                id: "asset-template-global",
                owner_id: "owner-a",
                project_id: null,
                filename: "Account overlay.png",
                media_type: "image",
                mime_type: "image/png",
                byte_size: 70,
                sha256: "global-overlay-checksum",
                metadata: {
                    scope: "overlay-template",
                    width: 320,
                    height: 180,
                },
            }],
            uploadCount: 0,
            foreignTemplate: makeTemplate("foreign-template", "Private foreign template", "Must never appear", "2026-11-17T10:00:00.000Z"),
            resolveInitial: null,
        };

        window.fetch = async (input, options = {}) => {
            const url = String(input);
            const method = options.method || "GET";
            const headers = options.headers || {};
            const requestBody = typeof options.body === "string" ? options.body : "";
            const bodyName = options.body instanceof File ? options.body.name : "";
            const api = window.templateApi;
            api.requests.push({
                url,
                method,
                credentials: options.credentials,
                body: requestBody,
                bodyName,
                contentType: headers["Content-Type"] || "",
                fileName: headers["X-File-Name"] || "",
            });

            if (url.startsWith("/api/assets")) {
                const parsedAssetUrl = new URL(url, window.location.origin);
                if (method === "GET" && parsedAssetUrl.pathname === "/api/assets") {
                    return Response.json({ ok: true, assets: api.assets });
                }
                if (method === "POST" && parsedAssetUrl.pathname === "/api/assets/upload") {
                    api.uploadCount += 1;
                    const filename = decodeURIComponent(headers["X-File-Name"] || `upload-${api.uploadCount}.png`);
                    const asset = {
                        id: `asset-upload-${api.uploadCount}`,
                        owner_id: "owner-a",
                        project_id: null,
                        filename,
                        media_type: "image",
                        mime_type: headers["Content-Type"] || "image/png",
                        byte_size: Number(options.body?.size) || 70,
                        sha256: `uploaded-checksum-${api.uploadCount}`,
                        metadata: {
                            scope: "overlay-template",
                            width: Number(headers["X-Image-Width"]) || 1,
                            height: Number(headers["X-Image-Height"]) || 1,
                        },
                    };
                    api.assets.unshift(asset);
                    return Response.json({ ok: true, asset }, { status: 201 });
                }
                throw new Error(`Unexpected asset request: ${method} ${url}`);
            }
            if (!url.startsWith("/api/overlay-templates")) {
                throw new Error(`Unexpected request: ${url}`);
            }
            if (api.mode === "pending" && (options.method || "GET") === "GET") {
                return new Promise((resolve) => {
                    api.resolveInitial = () => {
                        api.mode = "success";
                        resolve(Response.json({ ok: true, templates: api.templates }));
                    };
                });
            }
            if (api.mode === "error") {
                return Response.json({ ok: false, code: "OVERLAY_TEMPLATE_LIST_FAILED", message: "Library unavailable." }, { status: 503 });
            }

            const parsed = new URL(url, window.location.origin);
            const segments = parsed.pathname.split("/").filter(Boolean);
            const templateId = segments[2] || "";

            if (method === "GET") {
                if (templateId) {
                    const template = api.templates.find((item) => item.id === templateId);
                    return template
                        ? Response.json({ ok: true, template })
                        : Response.json({ ok: false, code: "NOT_FOUND", message: "Not found." }, { status: 404 });
                }
                if (api.mode === "empty") return Response.json({ ok: true, templates: [] });
                const search = (parsed.searchParams.get("search") || "").toLowerCase();
                const templates = search
                    ? api.templates.filter((template) => template.name.toLowerCase().includes(search))
                    : api.templates;
                return Response.json({ ok: true, templates });
            }

            const payload = options.body ? JSON.parse(options.body) : {};
            if (method === "POST" && !templateId) {
                const created = {
                    ...payload,
                    id: `template-${api.templates.length + 1}`,
                    ownerId: "owner-a",
                    createdAt: "2026-11-17T12:30:00.000Z",
                    updatedAt: "2026-11-17T12:30:00.000Z",
                };
                api.templates.unshift(created);
                return Response.json({ ok: true, template: created }, { status: 201 });
            }
            if (method === "PATCH") {
                const index = api.templates.findIndex((template) => template.id === templateId);
                api.templates[index] = {
                    ...api.templates[index],
                    ...payload,
                    updatedAt: "2026-11-17T11:00:00.000Z",
                };
                return Response.json({ ok: true, template: api.templates[index] });
            }
            if (method === "POST" && segments[3] === "duplicate") {
                const original = api.templates.find((template) => template.id === templateId);
                const duplicate = {
                    ...structuredClone(original),
                    id: `template-${api.templates.length + 1}`,
                    name: payload.name || `${original.name} (copy)`,
                    updatedAt: "2026-11-17T12:00:00.000Z",
                };
                api.templates.unshift(duplicate);
                return Response.json({ ok: true, template: duplicate }, { status: 201 });
            }
            if (method === "DELETE") {
                api.templates = api.templates.filter((template) => template.id !== templateId);
                return Response.json({ ok: true, id: templateId, message: "Overlay template deleted successfully." });
            }

            return Response.json({ ok: false, code: "NOT_FOUND", message: "Not found." }, { status: 404 });
        };
    });

    await page.goto(`http://127.0.0.1:${port}/overlay-template-library-test`);
    await page.getByText("Loading templates…", { exact: true }).waitFor();
    await page.evaluate(() => window.templateApi.resolveInitial());
    await page.getByText("Corner badge", { exact: true }).waitFor();
    assert.equal(await page.locator(".overlay-template-card").count(), 2);
    assert.equal(await page.getByText("Private foreign template", { exact: true }).count(), 0);

    const applyCornerBadge = page.getByRole("button", { name: "Apply Corner badge to timeline" });
    assert.equal(await applyCornerBadge.getByText("Apply to Timeline", { exact: true }).count(), 1);
    await applyCornerBadge.click();
    await page.waitForFunction(() => window.overlayTemplateFixture.visualOverlaySegments.length === 2);
    let appliedOverlays = await page.evaluate(() => window.overlayTemplateFixture.visualOverlaySegments);
    assert.equal(appliedOverlays[0].id, "existing-overlay");
    assert.equal(appliedOverlays[1].start, 5);
    assert.equal(appliedOverlays[1].templateId, "template-1");

    await applyCornerBadge.click();
    await page.waitForFunction(() => window.overlayTemplateFixture.visualOverlaySegments.length === 3);
    appliedOverlays = await page.evaluate(() => window.overlayTemplateFixture.visualOverlaySegments);
    assert.equal(new Set(appliedOverlays.map((overlay) => overlay.id)).size, 3);
    assert.deepEqual(appliedOverlays.slice(1).map((overlay) => overlay.start), [5, 5]);
    assert.deepEqual(appliedOverlays.slice(1).map((overlay) => overlay.lane), [1, 2]);

    await page.getByRole("button", { name: "Lock overlay track" }).click();
    await page.getByRole("button", { name: "Apply Sale banner to timeline" }).click();
    await page.waitForFunction(() => window.overlayTemplateFixture.notifications.includes("The overlay track is locked."));
    await page.getByRole("alert").getByText("The overlay track is locked.", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.overlayTemplateFixture.visualOverlaySegments.length), 3);
    await page.getByRole("button", { name: "Unlock overlay track" }).click();

    await page.getByRole("button", { name: "Switch project" }).click();
    await page.getByTestId("active-project").getByText("project-b", { exact: true }).waitFor();
    await page.getByText("Corner badge", { exact: true }).waitFor();
    assert.equal(await page.locator(".overlay-template-card").count(), 2);

    const projectSnapshotBeforeStudio = await page.evaluate(() => JSON.stringify(
        window.overlayTemplateFixture.visualSegments,
    ));
    await page.getByRole("button", { name: "Create Custom Template" }).click();
    await page.getByTestId("overlay-template-studio").waitFor();
    const studioName = page.getByRole("textbox", { name: "Template name" });
    const elementPalette = page.locator(".overlay-template-studio-palette");
    await studioName.fill("Studio announcement");
    await elementPalette.getByRole("button", { name: "Text", exact: true }).click();
    await page.keyboard.press("Control+z");
    assert.equal(await page.evaluate(() => window.timelineUndoCount), 0);

    const mediaButton = elementPalette.getByRole("button", { name: "Media", exact: true });
    const mediaInput = page.getByLabel("Import template media");
    assert.equal(await mediaButton.isEnabled(), true);
    assert.equal(await mediaInput.getAttribute("multiple"), "");
    assert.match(await mediaInput.getAttribute("accept"), /image\/png/);
    await mediaInput.setInputFiles([
        {
            name: "first-template-image.png",
            mimeType: "image/png",
            buffer: TEST_PNG_BYTES,
        },
        {
            name: "second-template-image.png",
            mimeType: "image/png",
            buffer: TEST_PNG_BYTES,
        },
        {
            name: "unsupported-template-file.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("not an image"),
        },
    ]);
    await page.getByText("1 unsupported file was skipped.", { exact: true }).waitFor();
    assert.equal(await page.locator(".overlay-template-renderer-element.is-media").count(), 2);
    assert.equal(await page.getByRole("button", { name: "Insert first-template-image.png" }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "Insert second-template-image.png" }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "Insert Account overlay.png" }).count(), 1);
    await page.getByLabel("Fit").selectOption("fill");

    await page.getByRole("button", { name: "Insert Focus arrow" }).click();
    await page.getByRole("button", { name: "Insert Highlight circle" }).click();

    for (const shape of ["Rectangle", "Rounded rectangle", "Ellipse", "Triangle", "Line"]) {
        await page.getByRole("button", { name: `Insert ${shape}`, exact: true }).click();
    }

    const shapeElements = page.locator(".overlay-template-renderer-element.is-shape");
    assert.equal(await shapeElements.count(), 5);
    assert.equal(await page.locator(".overlay-template-renderer-shape.is-triangle polygon").count(), 1);
    assert.equal(await page.locator(".overlay-template-renderer-shape.is-line line").count(), 1);

    const selectedLine = shapeElements.last();
    await selectedLine.click();
    assert.equal(await selectedLine.getAttribute("class").then((value) => value.includes("is-selected")), true);
    assert.equal(await page.getByRole("button", { name: "Resize Line se" }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "Rotate Line" }).count(), 1);

    await page.getByLabel("Opacity", { exact: true }).fill("0.65");
    await page.getByLabel("Opacity", { exact: true }).press("Enter");
    await page.getByLabel("Stroke width", { exact: true }).fill("8");
    await page.getByLabel("Stroke width", { exact: true }).press("Enter");
    await page.getByLabel("Rotation", { exact: true }).fill("15");
    await page.getByLabel("Rotation", { exact: true }).press("Enter");

    const beforeMove = await selectedLine.boundingBox();
    await page.mouse.move(beforeMove.x + beforeMove.width / 2, beforeMove.y + beforeMove.height / 2);
    await page.mouse.down();
    await page.mouse.move(beforeMove.x + beforeMove.width / 2 + 24, beforeMove.y + beforeMove.height / 2 + 12);
    await page.mouse.up();
    const afterMove = await selectedLine.boundingBox();
    assert.ok(afterMove.x > beforeMove.x + 8);

    const beforeResize = await selectedLine.boundingBox();
    const resizeHandle = page.getByRole("button", { name: "Resize Line se" });
    const resizeBox = await resizeHandle.boundingBox();
    await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + resizeBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(resizeBox.x + resizeBox.width / 2 + 28, resizeBox.y + resizeBox.height / 2 + 12);
    await page.mouse.up();
    const afterResize = await selectedLine.boundingBox();
    assert.ok(afterResize.width > beforeResize.width + 8);

    const rotationBeforePointer = await page.getByLabel("Rotation", { exact: true }).inputValue();
    const rotateHandle = page.getByRole("button", { name: "Rotate Line" });
    const rotateBox = await rotateHandle.boundingBox();
    await page.mouse.move(rotateBox.x + rotateBox.width / 2, rotateBox.y + rotateBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(rotateBox.x + rotateBox.width / 2 + 36, rotateBox.y + rotateBox.height / 2 + 18);
    await page.mouse.up();
    const rotationAfterPointer = await page.getByLabel("Rotation", { exact: true }).inputValue();
    assert.notEqual(rotationAfterPointer, rotationBeforePointer);

    await page.getByRole("button", { name: "Save", exact: true }).click();
    const createRequest = await page.evaluate(() => window.templateApi.requests.find(
        (request) => request.method === "POST" && request.url === "/api/overlay-templates",
    ));
    const uploadRequests = await page.evaluate(() => window.templateApi.requests.filter(
        (request) => request.method === "POST" && request.url === "/api/assets/upload",
    ));
    assert.equal(uploadRequests.length, 2);
    assert.deepEqual(uploadRequests.map((request) => request.bodyName), [
        "first-template-image.png",
        "second-template-image.png",
    ]);
    assert.ok(uploadRequests.every((request) => request.credentials === "include"));
    assert.ok(uploadRequests.every((request) => request.contentType === "image/png"));

    const savedPayload = JSON.parse(createRequest.body);
    assert.equal(savedPayload.elements.length, 9);
    assert.deepEqual(
        savedPayload.elements.filter((element) => element.kind === "vector").map((element) => element.vector.assetId),
        ["vector-focus-arrow", "vector-highlight-circle"],
    );
    assert.deepEqual(
        savedPayload.elements.filter((element) => element.kind === "shape").map((element) => element.shape.shapeType),
        ["rect", "rect", "ellipse", "triangle", "line"],
    );
    const savedShapes = savedPayload.elements.filter((element) => element.kind === "shape");
    assert.equal(savedShapes[0].shape.radius, 0);
    assert.equal(savedShapes[1].shape.radius, 64);
    assert.ok(savedShapes.find((element) => element.shape.shapeType === "line").layout.height > 0);
    const savedMedia = savedPayload.elements.filter((element) => element.kind === "media").map((element) => element.media);
    assert.deepEqual(savedMedia.map((media) => media.assetId), ["asset-upload-1", "asset-upload-2"]);
    assert.equal(savedMedia[1].fit, "fill");
    assert.equal(createRequest.body.includes("/api/assets/"), false);
    assert.equal(createRequest.body.includes("blob:"), false);
    assert.equal(createRequest.body.includes("data:image"), false);
    assert.equal(createRequest.body.includes("test-reference-image.png"), false);
    assert.equal(
        await page.evaluate(() => JSON.stringify(window.overlayTemplateFixture.visualSegments)),
        projectSnapshotBeforeStudio,
    );

    await page.getByRole("button", { name: "Back to template library" }).click();
    await page.getByText("Studio announcement", { exact: true }).waitFor();
    assert.equal(await page.locator(".overlay-template-card").count(), 3);

    await page.getByRole("button", { name: "Switch project" }).click();
    await page.getByTestId("active-project").getByText("project-a", { exact: true }).waitFor();
    await page.getByText("Studio announcement", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Edit Studio announcement" }).click();
    await page.getByTestId("overlay-template-studio").waitFor();
    assert.equal(await page.getByRole("button", { name: "Insert first-template-image.png" }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "Insert second-template-image.png" }).count(), 1);
    assert.equal(await page.locator(".overlay-template-renderer-element.is-media").count(), 2);
    assert.equal(await page.locator(".overlay-template-renderer-element.is-vector").count(), 2);
    assert.equal(await page.locator(".overlay-template-renderer-element.is-shape").count(), 5);
    assert.equal(await page.locator(".overlay-template-renderer-shape.is-triangle polygon").count(), 1);
    assert.equal(await page.locator(".overlay-template-renderer-shape.is-line line").count(), 1);
    assert.equal(
        await page.evaluate(() => JSON.stringify(window.overlayTemplateFixture.visualSegments)),
        projectSnapshotBeforeStudio,
    );
    await page.getByRole("button", { name: "Back to template library" }).click();

    await page.getByRole("button", { name: "Edit Studio announcement" }).click();
    await page.getByTestId("overlay-template-studio").waitFor();
    await page.getByRole("textbox", { name: "Template name" }).fill("Studio announcement draft");
    await page.getByRole("button", { name: "Back to template library" }).click();
    await page.getByText("Unsaved Studio draft", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Resume" }).click();
    await page.getByTestId("overlay-template-studio").waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Template name" }).inputValue(), "Studio announcement draft");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("button", { name: "Back to template library" }).click();
    await page.getByText("Studio announcement draft", { exact: true }).waitFor();

    const search = page.getByRole("searchbox", { name: "Search overlay templates" });
    await search.fill("sale");
    await search.press("Enter");
    await page.getByText("Sale banner", { exact: true }).waitFor();
    await page.getByText("Corner badge", { exact: true }).waitFor({ state: "detached" });
    assert.equal(await page.locator(".overlay-template-card").count(), 1);
    await page.getByRole("button", { name: "Clear template search" }).click();
    await page.getByText("Corner badge", { exact: true }).waitFor();

    const requestCountBeforeRefresh = await page.evaluate(() => window.templateApi.requests.length);
    await page.getByRole("button", { name: "Refresh overlay templates" }).click();
    await page.waitForFunction((count) => window.templateApi.requests.length > count, requestCountBeforeRefresh);

    await page.getByRole("button", { name: "Rename Corner badge" }).click();
    const renameDialog = page.getByRole("dialog", { name: "Rename template" });
    await renameDialog.getByRole("textbox", { name: "Name", exact: true }).fill("Corner badge updated");
    await renameDialog.getByRole("textbox", { name: "Description", exact: true }).fill("Updated global badge");
    await renameDialog.getByRole("button", { name: "Save changes" }).click();
    await page.getByText("Corner badge updated", { exact: true }).waitFor();

    await page.getByRole("button", { name: "Duplicate Corner badge updated" }).click();
    await page.getByText("Corner badge updated (copy)", { exact: true }).waitFor();
    assert.equal(await page.locator(".overlay-template-card").count(), 4);

    const originalCard = page.getByTestId("overlay-template-card-template-1");
    await originalCard.getByRole("button", { name: "Delete Corner badge updated", exact: true }).click();
    const deleteDialog = page.getByRole("alertdialog", { name: "Delete template?" });
    await deleteDialog.getByRole("button", { name: "Cancel" }).click();
    assert.equal(await page.getByText("Corner badge updated", { exact: true }).count(), 1);
    await originalCard.getByRole("button", { name: "Delete Corner badge updated", exact: true }).click();
    await page.getByRole("alertdialog", { name: "Delete template?" }).getByRole("button", { name: "Delete template" }).click();
    await originalCard.waitFor({ state: "detached" });
    assert.equal(await page.locator(".overlay-template-card").count(), 3);

    await page.evaluate(() => { window.templateApi.mode = "empty"; });
    await page.getByRole("button", { name: "Refresh overlay templates" }).click();
    await page.getByText("No templates yet", { exact: true }).waitFor();

    await page.evaluate(() => { window.templateApi.mode = "error"; });
    await page.getByRole("button", { name: "Refresh overlay templates" }).click();
    await page.getByText("Library unavailable.", { exact: true }).waitFor();
    await page.evaluate(() => { window.templateApi.mode = "success"; });
    await page.getByRole("button", { name: "Try again" }).click();
    await page.getByText("Sale banner", { exact: true }).waitFor();

    const requests = await page.evaluate(() => window.templateApi.requests);
    assert.ok(requests.length >= 17);
    assert.deepEqual(
        requests
            .filter((request) => request.url.startsWith("/api/"))
            .filter((request) => request.credentials !== "include")
            .map(({ method, url }) => ({ method, url })),
        [],
        "Every template and asset API request must include authenticated cookie credentials",
    );
    assert.ok(requests.some((request) => request.method === "GET" && request.url === "/api/assets?limit=100"));
    assert.equal(requests.filter((request) => request.method === "POST" && request.url === "/api/assets/upload").length, 2);
    assert.ok(requests.some((request) => request.url.includes("search=sale")));
    assert.ok(requests.some((request) => request.method === "GET" && /\/api\/overlay-templates\/template-\d+$/.test(request.url)));
    assert.ok(requests.some((request) => request.method === "POST" && request.url === "/api/overlay-templates"));
    assert.ok(requests.some((request) => request.method === "PATCH"));
    assert.ok(requests.some((request) => request.method === "POST" && request.url.endsWith("/duplicate")));
    assert.ok(requests.some((request) => request.method === "DELETE"));
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(consoleErrors, []);

    console.log("PASS mounted Chromium: visible Apply to Timeline action, additive/repeated application, lane packing, visible overlay-track lock rejection, native multi-file persistent media import, unsupported-file handling, direct vector/shape insertion, rounded rectangle identity, Studio create/save/reopen/draft resume, isolated undo, owner-only listing, cross-project global access, search, refresh, rename, duplicate, delete confirmation, empty/error recovery, and authenticated requests.");
} finally {
    await browser?.close();
    await vite.close();
}
