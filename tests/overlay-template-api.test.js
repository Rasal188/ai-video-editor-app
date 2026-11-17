import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    OverlayTemplateApiError,
    createOverlayTemplateRequest,
} from "../src/lib/overlayTemplateApi.js";
import { serializeOverlayTemplateForApi } from "../src/lib/shortsOverlayTemplates.js";

const template = {
    format: "ai-shorts-overlay-template",
    schemaVersion: 1,
    name: "Corner badge",
    description: "Reusable vector badge",
    canvas: { width: 1080, height: 1920, aspectRatio: "9:16" },
    elements: [{
        id: "el-1",
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
            body: "<svg viewBox=\"0 0 10 10\"><path d=\"M0 0h10v10H0z\"/></svg>",
            width: 10,
            height: 10,
        },
    }],
    metadata: { source: "editor" },
};

describe("overlay template API adapter", () => {
    it("posts the canonical payload with authenticated cookie credentials", async () => {
        let capturedUrl = "";
        let capturedOptions = null;
        const saved = { id: "template-1", name: template.name };

        const result = await createOverlayTemplateRequest(template, {
            fetchImpl: async (url, options) => {
                capturedUrl = url;
                capturedOptions = options;
                return {
                    ok: true,
                    status: 201,
                    json: async () => ({ ok: true, template: saved }),
                };
            },
        });

        assert.equal(capturedUrl, "/api/overlay-templates");
        assert.equal(capturedOptions.method, "POST");
        assert.equal(capturedOptions.credentials, "include");
        assert.deepEqual(capturedOptions.headers, { "Content-Type": "application/json" });
        assert.deepEqual(JSON.parse(capturedOptions.body), serializeOverlayTemplateForApi(template));
        assert.equal(result, saved);
    });

    it("propagates backend validation messages and codes", async () => {
        await assert.rejects(
            () => createOverlayTemplateRequest(template, {
                fetchImpl: async () => ({
                    ok: false,
                    status: 400,
                    json: async () => ({
                        ok: false,
                        code: "TEMPLATE_NO_ELIGIBLE_ELEMENTS",
                        message: "No portable overlays were found.",
                    }),
                }),
            }),
            (error) => {
                assert.ok(error instanceof OverlayTemplateApiError);
                assert.equal(error.code, "TEMPLATE_NO_ELIGIBLE_ELEMENTS");
                assert.equal(error.status, 400);
                assert.equal(error.message, "No portable overlays were found.");
                return true;
            },
        );
    });

    it("rejects malformed success envelopes", async () => {
        await assert.rejects(
            () => createOverlayTemplateRequest(template, {
                fetchImpl: async () => ({
                    ok: true,
                    status: 201,
                    json: async () => ({ ok: true }),
                }),
            }),
            (error) => error instanceof OverlayTemplateApiError
                && error.code === "OVERLAY_TEMPLATE_CREATE_FAILED",
        );
    });

    it("uses a safe fallback when the response body is not JSON", async () => {
        await assert.rejects(
            () => createOverlayTemplateRequest(template, {
                fetchImpl: async () => ({
                    ok: false,
                    status: 502,
                    json: async () => { throw new Error("invalid JSON"); },
                }),
            }),
            (error) => error instanceof OverlayTemplateApiError
                && error.status === 502
                && error.message === "Template could not be saved.",
        );
    });

    it("reports an unavailable fetch implementation", async () => {
        await assert.rejects(
            () => createOverlayTemplateRequest(template, { fetchImpl: null }),
            (error) => error instanceof OverlayTemplateApiError
                && error.code === "OVERLAY_TEMPLATE_FETCH_UNAVAILABLE",
        );
    });
});
