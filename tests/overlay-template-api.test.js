import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    OverlayTemplateApiError,
    createOverlayTemplateRequest,
    deleteOverlayTemplateRequest,
    duplicateOverlayTemplateRequest,
    getOverlayTemplateRequest,
    listOverlayTemplatesRequest,
    updateOverlayTemplateRequest,
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
            assetId: "vector-highlight-box",
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
        const payload = JSON.parse(capturedOptions.body);
        assert.deepEqual(payload, serializeOverlayTemplateForApi(template));
        assert.equal(payload.elements[0].vector.assetId, "vector-highlight-box");
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

    it("lists and searches owner templates with authenticated credentials", async () => {
        const requests = [];
        const templates = [{ id: "template-1", name: "Corner badge" }];
        const result = await listOverlayTemplatesRequest({
            search: " corner badge ",
            limit: 25,
            offset: 5,
            fetchImpl: async (url, options) => {
                requests.push({ url, options });
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ ok: true, templates }),
                };
            },
        });

        assert.deepEqual(result, templates);
        assert.equal(requests[0].url, "/api/overlay-templates?search=corner+badge&limit=25&offset=5");
        assert.deepEqual(requests[0].options, { credentials: "include" });
    });

    it("rejects malformed list envelopes", async () => {
        await assert.rejects(
            () => listOverlayTemplatesRequest({
                fetchImpl: async () => ({
                    ok: true,
                    status: 200,
                    json: async () => ({ ok: true, templates: null }),
                }),
            }),
            (error) => error instanceof OverlayTemplateApiError
                && error.code === "OVERLAY_TEMPLATE_LIST_FAILED",
        );
    });

    it("gets template details with authenticated credentials", async () => {
        let captured = null;
        const result = await getOverlayTemplateRequest("template/id", {
            fetchImpl: async (url, options) => {
                captured = { url, options };
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ ok: true, template }),
                };
            },
        });

        assert.equal(result, template);
        assert.equal(captured.url, "/api/overlay-templates/template%2Fid");
        assert.deepEqual(captured.options, { credentials: "include" });
    });

    it("updates template metadata without replacing its definition", async () => {
        let captured = null;
        const updated = { ...template, name: "Renamed badge", description: "Updated" };
        const result = await updateOverlayTemplateRequest("template-1", {
            name: updated.name,
            description: updated.description,
        }, {
            fetchImpl: async (url, options) => {
                captured = { url, options };
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ ok: true, template: updated }),
                };
            },
        });

        assert.equal(result, updated);
        assert.equal(captured.url, "/api/overlay-templates/template-1");
        assert.equal(captured.options.method, "PATCH");
        assert.equal(captured.options.credentials, "include");
        assert.deepEqual(JSON.parse(captured.options.body), {
            name: "Renamed badge",
            description: "Updated",
        });
    });

    it("duplicates templates with an optional custom name", async () => {
        let captured = null;
        const duplicated = { ...template, id: "template-2", name: "Badge copy" };
        const result = await duplicateOverlayTemplateRequest("template-1", {
            name: " Badge copy ",
            fetchImpl: async (url, options) => {
                captured = { url, options };
                return {
                    ok: true,
                    status: 201,
                    json: async () => ({ ok: true, template: duplicated }),
                };
            },
        });

        assert.equal(result, duplicated);
        assert.equal(captured.url, "/api/overlay-templates/template-1/duplicate");
        assert.equal(captured.options.method, "POST");
        assert.equal(captured.options.credentials, "include");
        assert.deepEqual(JSON.parse(captured.options.body), { name: "Badge copy" });
    });

    it("deletes templates and returns the backend confirmation", async () => {
        let captured = null;
        const result = await deleteOverlayTemplateRequest("template-1", {
            fetchImpl: async (url, options) => {
                captured = { url, options };
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        ok: true,
                        id: "template-1",
                        message: "Overlay template deleted successfully.",
                    }),
                };
            },
        });

        assert.deepEqual(result, {
            id: "template-1",
            message: "Overlay template deleted successfully.",
        });
        assert.equal(captured.url, "/api/overlay-templates/template-1");
        assert.deepEqual(captured.options, {
            method: "DELETE",
            credentials: "include",
        });
    });

    it("propagates authentication and ownership failures across library operations", async () => {
        const unauthorized = async () => ({
            ok: false,
            status: 401,
            json: async () => ({ ok: false, code: "AUTH_REQUIRED", message: "Authentication required." }),
        });
        const forbidden = async () => ({
            ok: false,
            status: 403,
            json: async () => ({ ok: false, code: "FORBIDDEN", message: "Access denied." }),
        });

        await assert.rejects(
            () => listOverlayTemplatesRequest({ fetchImpl: unauthorized }),
            (error) => error instanceof OverlayTemplateApiError
                && error.status === 401
                && error.code === "AUTH_REQUIRED",
        );
        await assert.rejects(
            () => updateOverlayTemplateRequest("template-1", { name: "Nope" }, { fetchImpl: forbidden }),
            (error) => error instanceof OverlayTemplateApiError
                && error.status === 403
                && error.code === "FORBIDDEN",
        );
    });
});
