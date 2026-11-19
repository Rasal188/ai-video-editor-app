import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { restoreProjectVisualSegmentSource } from "../src/lib/projectOverlayRestore.js";

describe("template overlay project restoration", () => {
    it("regenerates procedural text and shape SVG sources after snapshot src stripping", () => {
        const text = restoreProjectVisualSegmentSource({
            id: "text-overlay",
            kind: "text",
            name: "Headline",
            width: 600,
            height: 180,
            text: { content: "Restored headline", color: "#ffffff", fontSize: 64 },
        });
        const shape = restoreProjectVisualSegmentSource({
            id: "shape-overlay",
            kind: "shape",
            name: "Panel",
            width: 640,
            height: 240,
            shape: { shapeType: "rect", fill: "#101820", radius: 24 },
        });

        assert.ok(text.src.startsWith("data:image/svg+xml"));
        assert.match(decodeURIComponent(text.src), /Restored headline/);
        assert.ok(shape.src.startsWith("data:image/svg+xml"));
        assert.match(decodeURIComponent(shape.src), /<rect/);
    });

    it("keeps existing media sources and rejects unresolved source-less media", () => {
        const media = { id: "media-overlay", kind: "media", src: "blob:restored" };
        assert.equal(restoreProjectVisualSegmentSource(media), media);
        assert.equal(restoreProjectVisualSegmentSource({ id: "missing", kind: "media" }), null);
    });
});
