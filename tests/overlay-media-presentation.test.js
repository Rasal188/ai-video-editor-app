import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getOverlayMediaPresentationLayout } from "../src/lib/overlayMediaPresentation.js";

describe("overlay media presentation layout", () => {
    it("matches centered CSS contain sizing and zoom", () => {
        assert.deepEqual(
            getOverlayMediaPresentationLayout(
                { width: 400, height: 200 },
                { x: 10, y: 20, width: 200, height: 200 },
                { fit: "contain", positionX: 50, positionY: 50, zoom: 1.5 },
            ),
            {
                fit: "contain",
                zoom: 1.5,
                x: -40,
                y: 45,
                width: 300,
                height: 150,
            },
        );
    });

    it("matches cover object-position before centered zoom", () => {
        assert.deepEqual(
            getOverlayMediaPresentationLayout(
                { width: 400, height: 200 },
                { x: 10, y: 20, width: 200, height: 200 },
                { fit: "cover", positionX: 25, positionY: 75, zoom: 1.4 },
            ),
            {
                fit: "cover",
                zoom: 1.4,
                x: -100,
                y: -20,
                width: 560,
                height: 280,
            },
        );
    });

    it("uses centered defaults, clamps positions, and preserves fill", () => {
        assert.deepEqual(
            getOverlayMediaPresentationLayout(
                { width: 320, height: 180 },
                { x: 5, y: 7, width: 160, height: 90 },
                { fit: "fill", positionX: -20, positionY: 140 },
            ),
            {
                fit: "fill",
                zoom: 1,
                x: 5,
                y: 7,
                width: 160,
                height: 90,
            },
        );

        assert.deepEqual(
            getOverlayMediaPresentationLayout(
                { width: 100, height: 100 },
                { x: 0, y: 0, width: 200, height: 100 },
                {},
            ),
            {
                fit: "cover",
                zoom: 1,
                x: 0,
                y: -50,
                width: 200,
                height: 200,
            },
        );
    });
});
