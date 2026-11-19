import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    OverlayTemplateAssetApiError,
    isSupportedOverlayTemplateImage,
    listOverlayTemplateAssetsRequest,
    uploadOverlayTemplateAssetRequest,
} from "../src/lib/overlayTemplateAssetApi.js";

function response(body, { ok = true, status = 200 } = {}) {
    return {
        ok,
        status,
        json: async () => body,
    };
}

describe("overlay template asset API adapter", () => {
    it("accepts supported MIME types and extension-only browser files", () => {
        assert.equal(isSupportedOverlayTemplateImage({ name: "image.png", type: "image/png" }), true);
        assert.equal(isSupportedOverlayTemplateImage({ name: "photo.JPG", type: "" }), true);
        assert.equal(isSupportedOverlayTemplateImage({ name: "graphic.webp", type: "image/webp" }), true);
        assert.equal(isSupportedOverlayTemplateImage({ name: "mark.svg", type: "image/svg+xml" }), true);
        assert.equal(isSupportedOverlayTemplateImage({ name: "animation.gif", type: "image/gif" }), false);
        assert.equal(isSupportedOverlayTemplateImage({ name: "notes.txt", type: "" }), false);
    });

    it("lists only persistent overlay-template images and normalizes runtime sources", async () => {
        let captured = null;
        const result = await listOverlayTemplateAssetsRequest({
            fetchImpl: async (url, options) => {
                captured = { url, options };
                return response({
                    ok: true,
                    assets: [
                        {
                            id: "asset-persistent",
                            filename: "portrait.png",
                            media_type: "image",
                            mime_type: "image/png",
                            sha256: "abc123",
                            metadata: {
                                scope: "overlay-template",
                                width: 640,
                                height: 960,
                            },
                        },
                        {
                            id: "asset-project",
                            filename: "project.png",
                            media_type: "image",
                            mime_type: "image/png",
                            metadata: { scope: "project" },
                        },
                        {
                            id: "asset-audio",
                            filename: "song.mp3",
                            media_type: "audio",
                            mime_type: "audio/mpeg",
                            metadata: { scope: "overlay-template" },
                        },
                    ],
                });
            },
        });

        assert.deepEqual(captured, {
            url: "/api/assets?limit=100",
            options: { credentials: "include" },
        });
        assert.equal(result.length, 1);
        assert.deepEqual(result[0], {
            id: "asset-persistent",
            assetId: "asset-persistent",
            type: "image",
            kind: "image",
            mediaKind: "image",
            name: "portrait.png",
            filename: "portrait.png",
            mimeType: "image/png",
            width: 640,
            height: 960,
            checksum: "abc123",
            sha256: "abc123",
            src: "/api/assets/asset-persistent/content",
            thumbnail: "/api/assets/asset-persistent/content",
            provider: "Template Studio",
            storageScope: "overlay-template",
            persistent: true,
        });
    });

    it("uploads raw bytes with authenticated credentials and infers an extension-only MIME type", async () => {
        let captured = null;
        const file = {
            name: "portrait.JPEG",
            type: "",
            size: 4,
        };
        const result = await uploadOverlayTemplateAssetRequest(file, {
            fetchImpl: async (url, options) => {
                captured = { url, options };
                return response({
                    ok: true,
                    asset: {
                        id: "asset-uploaded",
                        filename: "portrait.JPEG",
                        media_type: "image",
                        mime_type: "image/jpeg",
                        sha256: "checksum-uploaded",
                        metadata: {
                            scope: "overlay-template",
                            width: 1,
                            height: 1,
                        },
                    },
                }, { status: 201 });
            },
        });

        assert.equal(captured.url, "/api/assets/upload");
        assert.equal(captured.options.method, "POST");
        assert.equal(captured.options.credentials, "include");
        assert.equal(captured.options.headers["Content-Type"], "image/jpeg");
        assert.equal(captured.options.headers["X-File-Name"], "portrait.JPEG");
        assert.equal(captured.options.headers["X-Image-Width"], "1");
        assert.equal(captured.options.headers["X-Image-Height"], "1");
        assert.equal(captured.options.body, file);
        assert.equal(result.assetId, "asset-uploaded");
        assert.equal(result.src, "/api/assets/asset-uploaded/content");
        assert.equal(result.persistent, true);
    });

    it("rejects unsupported files before issuing a request", async () => {
        let requested = false;
        await assert.rejects(
            () => uploadOverlayTemplateAssetRequest({ name: "animation.gif", type: "image/gif" }, {
                fetchImpl: async () => {
                    requested = true;
                    return response({ ok: true });
                },
            }),
            (error) => error instanceof OverlayTemplateAssetApiError
                && error.code === "UNSUPPORTED_TEMPLATE_IMAGE",
        );
        assert.equal(requested, false);
    });

    it("propagates backend upload errors with status and code", async () => {
        await assert.rejects(
            () => uploadOverlayTemplateAssetRequest({ name: "unsafe.svg", type: "image/svg+xml" }, {
                fetchImpl: async () => response({
                    ok: false,
                    code: "UNSAFE_SVG",
                    message: "SVG contains unsupported active content.",
                }, { ok: false, status: 400 }),
            }),
            (error) => error instanceof OverlayTemplateAssetApiError
                && error.code === "UNSAFE_SVG"
                && error.status === 400,
        );
    });
});
