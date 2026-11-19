import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    adaptStudioDocumentCanvas,
    addStudioElement,
    createStudioDocument,
    createStudioElement,
    createStudioHistory,
    getStudioDocumentSignature,
    normalizeStudioDocument,
    pushStudioHistory,
    redoStudioHistory,
    resizeStudioLayout,
    snapStudioLayout,
    undoStudioHistory,
    updateStudioElement,
} from "../src/lib/overlayTemplateStudio.js";
import {
    buildOverlayTemplateAssetIndex,
    resolveOverlayTemplateMediaAsset,
} from "../src/lib/overlayTemplateRendererAssets.js";
import {
    normalizeOverlayTemplate,
    serializeOverlayTemplateForApi,
} from "../src/lib/shortsOverlayTemplates.js";

function documentWithShape() {
    const document = createStudioDocument({
        name: "Studio Card",
        canvas: { width: 1000, height: 500, background: "#111827" },
    });
    const shape = createStudioElement("shape", document.canvas, {
        name: "Panel",
        layout: { x: 100, y: 50, width: 400, height: 200 },
    });
    return addStudioElement(document, shape);
}

describe("Overlay Template Studio model", () => {
    it("creates a normalized blank definition document", () => {
        const document = createStudioDocument({
            name: "Blank Landscape",
            canvas: { width: 1920, height: 1080 },
        });

        assert.equal(document.name, "Blank Landscape");
        assert.deepEqual(document.canvas, {
            aspectRatio: "16:9",
            width: 1920,
            height: 1080,
            background: "#10131a",
        });
        assert.deepEqual(document.elements, []);
        assert.equal(document.metadata.studio, true);
        assert.equal(document.metadata.createdIn, "overlay-template-studio");
    });

    it("creates editable text, shape, vector, and portable media elements", () => {
        const canvas = { width: 1080, height: 1920 };
        const text = createStudioElement("text", canvas, { content: "Launch day" });
        const shape = createStudioElement("shape", canvas, { shapeType: "ellipse" });
        const vector = createStudioElement("vector", canvas, {
            assetId: "vector-badge",
            body: '<circle cx="600" cy="600" r="240"/>',
        });
        const media = createStudioElement("media", canvas, {
            asset: {
                id: "asset-1",
                name: "Portrait",
                type: "image",
                width: 800,
                height: 1200,
            },
        });

        assert.equal(text.text.content, "Launch day");
        assert.equal(text.text.fontWeight, 700);
        assert.equal(shape.shape.shapeType, "ellipse");
        assert.equal(vector.vector.assetId, "vector-badge");
        assert.match(vector.vector.body, /<circle/);
        assert.equal(media.media.assetId, "asset-1");
        assert.equal(media.media.fit, "cover");
        assert.equal("src" in media.media, false);
        assert.equal("blob" in media.media, false);
    });

    it("keeps empty and multiline text editable through history, save, and reopen", () => {
        const canvas = { width: 1080, height: 1920 };
        const text = createStudioElement("text", canvas, {
            content: "Your text",
            fontId: "poppins",
            fontFamily: '"Poppins", Inter, system-ui, sans-serif',
        });
        const initial = createStudioDocument({
            name: "Editable empty text",
            canvas,
            elements: [text],
        });
        const multiline = updateStudioElement(initial, text.id, (element) => ({
            text: { ...element.text, content: "  First line\nSecond line  " },
        }));
        const empty = updateStudioElement(multiline, text.id, (element) => ({
            text: { ...element.text, content: "" },
        }));

        assert.equal(multiline.elements[0].text.content, "  First line\nSecond line  ");
        assert.equal(empty.elements[0].text.content, "");
        assert.equal(empty.elements[0].text.fontId, "poppins");

        let history = createStudioHistory(initial);
        history = pushStudioHistory(history, multiline);
        history = pushStudioHistory(history, empty);
        const undone = undoStudioHistory(history);
        assert.equal(undone.document.elements[0].text.content, "  First line\nSecond line  ");
        const redone = redoStudioHistory(undone.history);
        assert.equal(redone.document.elements[0].text.content, "");

        const payload = serializeOverlayTemplateForApi(empty);
        const reloaded = normalizeStudioDocument(JSON.parse(JSON.stringify(payload)));
        assert.equal(reloaded.elements[0].text.content, "");
        assert.equal(reloaded.elements[0].text.fontId, "poppins");
        assert.equal(reloaded.elements[0].text.fontFamily, '"Poppins", Inter, system-ui, sans-serif');
        assert.equal(reloaded.elements[0].id, text.id);
    });

    it("preserves an explicitly empty value when creating a text element", () => {
        const text = createStudioElement("text", { width: 1080, height: 1920 }, { content: "" });
        assert.equal(text.text.content, "");
    });

    it("preserves significant whitespace in editable text content", () => {
        const content = "  First line\nSecond line  ";
        const normalized = normalizeOverlayTemplate({
            name: "Whitespace",
            elements: [{ id: "text-1", kind: "text", text: { content } }],
        });

        assert.equal(normalized.elements[0].text.content, content);
    });

    it("creates every supported shape with visible geometry and preserves editable properties", () => {
        const canvas = { width: 1080, height: 1920 };
        const shapeTypes = ["rect", "ellipse", "triangle", "line"];
        const elements = shapeTypes.map((shapeType, index) => createStudioElement(
            "shape",
            canvas,
            {
                shapeType,
                fill: `#00000${index}`,
                stroke: "#ffffff",
                strokeWidth: index + 1,
                radius: 20 + index,
            },
        ));

        assert.deepEqual(
            elements.map((element) => element.shape.shapeType),
            shapeTypes,
        );
        elements.forEach((element) => {
            assert.ok(element.layout.width > 0);
            assert.ok(element.layout.height > 0);
        });
        assert.ok(elements[3].layout.height < elements[0].layout.height);

        const document = createStudioDocument({
            name: "All shapes",
            canvas,
            elements,
        });
        const reloaded = normalizeStudioDocument(JSON.parse(JSON.stringify(
            serializeOverlayTemplateForApi(document),
        )));

        assert.deepEqual(
            reloaded.elements.map((element) => element.shape),
            document.elements.map((element) => element.shape),
        );
    });

    it("round-trips rounded rectangles as rectangle geometry with a stable corner radius", () => {
        const canvas = { width: 1080, height: 1920 };
        const roundedRectangle = createStudioElement("shape", canvas, {
            name: "Rounded rectangle",
            shapeType: "rect",
            radius: 64,
        });
        const document = createStudioDocument({
            name: "Rounded panel",
            canvas,
            elements: [roundedRectangle],
        });
        const reloaded = normalizeStudioDocument(JSON.parse(JSON.stringify(
            serializeOverlayTemplateForApi(document),
        )));

        assert.equal(reloaded.elements[0].shape.shapeType, "rect");
        assert.equal(reloaded.elements[0].shape.radius, 64);
        assert.ok(reloaded.elements[0].layout.width > 0);
        assert.ok(reloaded.elements[0].layout.height > 0);
    });

    it("preserves distinct stable vector identifiers through save and reopen", () => {
        const canvas = { width: 1080, height: 1920 };
        const vectors = [
            createStudioElement("vector", canvas, {
                assetId: "vector-star",
                body: '<path d="M600 40l150 360h390L825 625l120 375-345-220-345 220 120-375L60 400h390z"/>',
            }),
            createStudioElement("vector", canvas, {
                assetId: "vector-arrow-right",
                body: '<path d="M100 520h650L520 290l120-120 430 430-430 430-120-120 230-230H100z"/>',
            }),
        ];
        const document = createStudioDocument({
            name: "Exact vectors",
            canvas,
            elements: vectors,
        });
        const payload = serializeOverlayTemplateForApi(document);
        const reloaded = normalizeStudioDocument(JSON.parse(JSON.stringify(payload)));

        assert.deepEqual(
            reloaded.elements.map((element) => element.vector.assetId),
            ["vector-star", "vector-arrow-right"],
        );
        assert.match(reloaded.elements[0].vector.body, /M600 40/);
        assert.match(reloaded.elements[1].vector.body, /M100 520/);
    });

    it("derives editable layout for legacy Phase 3A templates without layout", () => {
        const document = normalizeStudioDocument({
            name: "Legacy",
            canvas: { width: 1000, height: 500, aspectRatio: "2:1" },
            elements: [{
                id: "legacy-shape",
                kind: "shape",
                baseTransform: { x: 10, y: -10, scale: 0.4, rotation: 12, opacity: 0.8 },
                shape: { shapeType: "rect", fill: "#fff" },
            }],
        });

        assert.deepEqual(document.elements[0].layout, {
            x: 400,
            y: 0,
            width: 400,
            height: 400,
        });
        assert.equal(document.elements[0].visible, true);
        assert.equal(document.elements[0].locked, false);
    });

    it("fits content proportionally when changing canvas", () => {
        const adapted = adaptStudioDocumentCanvas(
            documentWithShape(),
            { width: 1000, height: 1000 },
            "fit",
        );

        assert.deepEqual(adapted.elements[0].layout, {
            x: 100,
            y: 300,
            width: 400,
            height: 200,
        });
    });

    it("fills content proportionally when changing canvas", () => {
        const adapted = adaptStudioDocumentCanvas(
            documentWithShape(),
            { width: 1000, height: 1000 },
            "fill",
        );

        assert.deepEqual(adapted.elements[0].layout, {
            x: -300,
            y: 100,
            width: 800,
            height: 400,
        });
    });

    it("stretches content independently when changing canvas", () => {
        const adapted = adaptStudioDocumentCanvas(
            documentWithShape(),
            { width: 2000, height: 2000 },
            "stretch",
        );

        assert.deepEqual(adapted.elements[0].layout, {
            x: 200,
            y: 200,
            width: 800,
            height: 800,
        });
    });

    it("repositions content without resizing when changing canvas", () => {
        const adapted = adaptStudioDocumentCanvas(
            documentWithShape(),
            { width: 2000, height: 1000 },
            "reposition",
        );

        assert.deepEqual(adapted.elements[0].layout, {
            x: 400,
            y: 200,
            width: 400,
            height: 200,
        });
    });

    it("snaps to canvas guides and resizes from directional handles", () => {
        const snapped = snapStudioLayout(
            { x: 298, y: 199, width: 400, height: 200 },
            { width: 1000, height: 600 },
            { threshold: 4 },
        );
        assert.deepEqual(snapped.guides, ["center-x", "center-y"]);
        assert.deepEqual(snapped.layout, { x: 300, y: 200, width: 400, height: 200 });

        assert.deepEqual(
            resizeStudioLayout(snapped.layout, "se", { x: 50, y: 25 }),
            { x: 300, y: 200, width: 450, height: 225 },
        );
        assert.deepEqual(
            resizeStudioLayout(snapped.layout, "nw", { x: 500, y: 500 }, { minSize: 32 }),
            { x: 668, y: 368, width: 32, height: 32 },
        );
    });

    it("round-trips Studio fields through the existing API definition serializer", () => {
        let document = documentWithShape();
        document = updateStudioElement(document, document.elements[0].id, {
            visible: false,
            locked: true,
            baseTransform: {
                ...document.elements[0].baseTransform,
                rotation: 18,
                opacity: 0.75,
            },
        });

        const payload = serializeOverlayTemplateForApi(document);
        const reloaded = normalizeStudioDocument(normalizeOverlayTemplate(JSON.parse(JSON.stringify(payload))));

        assert.deepEqual(reloaded.canvas, document.canvas);
        assert.deepEqual(reloaded.elements, document.elements);
        assert.equal(JSON.stringify(payload).includes("blob:"), false);
        assert.equal(JSON.stringify(payload).includes("data:image"), false);
    });

    it("maintains an isolated immutable undo and redo stack", () => {
        const initial = documentWithShape();
        const changed = updateStudioElement(initial, initial.elements[0].id, (element) => ({
            layout: { ...element.layout, x: 250 },
        }));
        const initialSignature = getStudioDocumentSignature(initial);
        let history = createStudioHistory(initial);
        history = pushStudioHistory(history, changed);

        assert.equal(history.past.length, 1);
        assert.equal(history.current.elements[0].layout.x, 250);
        assert.equal(getStudioDocumentSignature(initial), initialSignature);

        const undone = undoStudioHistory(history);
        assert.equal(undone.changed, true);
        assert.equal(undone.document.elements[0].layout.x, 100);

        const redone = redoStudioHistory(undone.history);
        assert.equal(redone.changed, true);
        assert.equal(redone.document.elements[0].layout.x, 250);
    });

    it("resolves runtime media by portable identity without persisting sources", () => {
        const assets = [
            { id: "asset-a", src: "blob:asset-a" },
            { archiveMediaId: "archive-b", src: "blob:archive-b" },
            { integrity: { sha256: "checksum-c" }, src: "blob:checksum-c" },
        ];
        const index = buildOverlayTemplateAssetIndex(assets);

        assert.equal(resolveOverlayTemplateMediaAsset({ assetId: "asset-a" }, index), assets[0]);
        assert.equal(resolveOverlayTemplateMediaAsset({ archiveMediaId: "archive-b" }, index), assets[1]);
        assert.equal(resolveOverlayTemplateMediaAsset({ checksum: "checksum-c" }, index), assets[2]);
        assert.equal(resolveOverlayTemplateMediaAsset({ assetId: "missing" }, index), null);

        const document = createStudioDocument({
            name: "Portable media",
            elements: [createStudioElement("media", { width: 1080, height: 1920 }, {
                asset: {
                    id: "asset-a",
                    name: "Runtime portrait",
                    type: "image",
                    src: "/api/assets/asset-a/content",
                    thumbnail: "/api/assets/asset-a/content",
                    persistent: true,
                },
            })],
        });
        const payload = serializeOverlayTemplateForApi(document);
        const serialized = JSON.stringify(payload);
        assert.equal(payload.elements[0].media.assetId, "asset-a");
        assert.equal(serialized.includes("/api/assets/asset-a/content"), false);
        assert.equal(serialized.includes('"src"'), false);
        assert.equal(serialized.includes('"thumbnail"'), false);
        assert.equal(serialized.includes('"persistent"'), false);
    });
});
