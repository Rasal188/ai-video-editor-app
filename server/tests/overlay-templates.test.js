import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupTestEnvironment, withServer } from "./test-helpers.js";

const mediaElement = (overrides = {}) => ({
    id: "el-1",
    kind: "media",
    name: "Logo",
    baseTransform: { x: 27, y: -24, scale: 0.34, rotation: 0, opacity: 1 },
    keyframes: [],
    animation: { in: { id: "fade", duration: 0.6 }, out: { id: "none", duration: 0.6 } },
    layer: 2,
    start: 0,
    duration: null,
    media: {
        mediaKind: "image",
        assetId: "asset-abc",
        archiveMediaId: "archive-abc",
        filename: "logo.png",
        mimeType: "image/png",
        width: 512,
        height: 512,
    },
    ...overrides,
});

const validPayload = (overrides = {}) => ({
    name: "Lower Third Neon",
    description: "Bold lower third with logo",
    schemaVersion: 1,
    canvas: { aspectRatio: "9:16", width: 1080, height: 1920 },
    elements: [mediaElement()],
    ...overrides,
});

function jsonRequest(baseUrl, path, { method = "GET", cookie, body } = {}) {
    return fetch(`${baseUrl}${path}`, {
        method,
        headers: {
            "Content-Type": "application/json",
            ...(cookie ? { Cookie: cookie } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
}

describe("Overlay Templates API", () => {
    let env;
    let alice;
    let bob;

    before(async () => {
        env = await setupTestEnvironment();
        alice = await env.createSession("alice-overlay@example.com");
        bob = await env.createSession("bob-overlay@example.com");
    });

    after(async () => {
        await env.teardown();
    });

    describe("Authentication", () => {
        it("rejects unauthenticated create", async () => {
            await withServer(env.app, async (baseUrl) => {
                const res = await jsonRequest(baseUrl, "/api/overlay-templates", {
                    method: "POST",
                    body: validPayload(),
                });
                assert.equal(res.status, 401);
                const data = await res.json();
                assert.equal(data.ok, false);
                assert.equal(data.code, "UNAUTHORIZED");
            });
        });

        it("rejects unauthenticated list", async () => {
            await withServer(env.app, async (baseUrl) => {
                const res = await jsonRequest(baseUrl, "/api/overlay-templates");
                assert.equal(res.status, 401);
            });
        });
    });

    describe("Create and retrieve", () => {
        it("creates a template and returns the normalized schema", async () => {
            await withServer(env.app, async (baseUrl) => {
                const res = await jsonRequest(baseUrl, "/api/overlay-templates", {
                    method: "POST",
                    cookie: alice.cookie,
                    body: validPayload(),
                });
                assert.equal(res.status, 201);
                const data = await res.json();
                assert.equal(data.ok, true);
                assert.equal(data.template.format, "ai-shorts-overlay-template");
                assert.equal(data.template.schemaVersion, 1);
                assert.equal(data.template.name, "Lower Third Neon");
                assert.equal(data.template.elements.length, 1);
                assert.equal(data.template.elements[0].kind, "media");
                assert.equal(data.template.ownerId, alice.user.id);
                assert.ok(data.template.id);
                assert.ok(data.template.createdAt);
            });
        });

        it("round-trips a template through GET by id", async () => {
            await withServer(env.app, async (baseUrl) => {
                const created = await jsonRequest(baseUrl, "/api/overlay-templates", {
                    method: "POST",
                    cookie: alice.cookie,
                    body: validPayload({ name: "Round Trip" }),
                });
                const { template } = await created.json();

                const res = await jsonRequest(baseUrl, `/api/overlay-templates/${template.id}`, {
                    cookie: alice.cookie,
                });
                assert.equal(res.status, 200);
                const data = await res.json();
                assert.equal(data.template.id, template.id);
                assert.equal(data.template.name, "Round Trip");
                assert.deepEqual(data.template.canvas, { aspectRatio: "9:16", width: 1080, height: 1920 });
                assert.deepEqual(data.template.elements[0].baseTransform, {
                    x: 27, y: -24, scale: 0.34, rotation: 0, opacity: 1,
                });
            });
        });

        it("lists templates for the authenticated owner", async () => {
            await withServer(env.app, async (baseUrl) => {
                const res = await jsonRequest(baseUrl, "/api/overlay-templates", { cookie: alice.cookie });
                assert.equal(res.status, 200);
                const data = await res.json();
                assert.equal(data.ok, true);
                assert.ok(Array.isArray(data.templates));
                assert.ok(data.templates.length >= 1);
                for (const template of data.templates) {
                    assert.equal(template.ownerId, alice.user.id);
                }
            });
        });

        it("returns 404 for an unknown template id", async () => {
            await withServer(env.app, async (baseUrl) => {
                const res = await jsonRequest(baseUrl, "/api/overlay-templates/00000000-0000-4000-8000-000000000000", {
                    cookie: alice.cookie,
                });
                assert.equal(res.status, 404);
                const data = await res.json();
                assert.equal(data.code, "TEMPLATE_NOT_FOUND");
            });
        });

        it("returns 400 for a malformed template id", async () => {
            await withServer(env.app, async (baseUrl) => {
                const res = await jsonRequest(baseUrl, "/api/overlay-templates/not-a-uuid", {
                    cookie: alice.cookie,
                });
                assert.equal(res.status, 400);
                const data = await res.json();
                assert.equal(data.code, "INVALID_TEMPLATE_ID");
            });
        });
    });

    describe("Cross-user isolation", () => {
        let aliceTemplateId;

        before(async () => {
            await withServer(env.app, async (baseUrl) => {
                const res = await jsonRequest(baseUrl, "/api/overlay-templates", {
                    method: "POST",
                    cookie: alice.cookie,
                    body: validPayload({ name: "Alice Private" }),
                });
                const data = await res.json();
                aliceTemplateId = data.template.id;
            });
        });

        it("does not leak another user's template on GET", async () => {
            await withServer(env.app, async (baseUrl) => {
                const res = await jsonRequest(baseUrl, `/api/overlay-templates/${aliceTemplateId}`, {
                    cookie: bob.cookie,
                });
                assert.equal(res.status, 403);
                const data = await res.json();
                assert.equal(data.code, "FORBIDDEN");
            });
        });

        it("does not list another user's templates", async () => {
            await withServer(env.app, async (baseUrl) => {
                const res = await jsonRequest(baseUrl, "/api/overlay-templates", { cookie: bob.cookie });
                const data = await res.json();
                const ids = data.templates.map((t) => t.id);
                assert.ok(!ids.includes(aliceTemplateId));
            });
        });

        it("rejects cross-user update", async () => {
            await withServer(env.app, async (baseUrl) => {
                const res = await jsonRequest(baseUrl, `/api/overlay-templates/${aliceTemplateId}`, {
                    method: "PATCH",
                    cookie: bob.cookie,
                    body: { name: "Hijacked" },
                });
                assert.equal(res.status, 403);
            });
        });

        it("rejects cross-user duplicate", async () => {
            await withServer(env.app, async (baseUrl) => {
                const res = await jsonRequest(baseUrl, `/api/overlay-templates/${aliceTemplateId}/duplicate`, {
                    method: "POST",
                    cookie: bob.cookie,
                    body: {},
                });
                assert.equal(res.status, 403);
            });
        });

        it("rejects cross-user delete", async () => {
            await withServer(env.app, async (baseUrl) => {
                const res = await jsonRequest(baseUrl, `/api/overlay-templates/${aliceTemplateId}`, {
                    method: "DELETE",
                    cookie: bob.cookie,
                });
                assert.equal(res.status, 403);

                // Confirm the record still exists for Alice
                const check = await jsonRequest(baseUrl, `/api/overlay-templates/${aliceTemplateId}`, {
                    cookie: alice.cookie,
                });
                assert.equal(check.status, 200);
            });
        });
    });

    describe("Update, duplicate, delete", () => {
        it("updates metadata and definition", async () => {
            await withServer(env.app, async (baseUrl) => {
                const created = await jsonRequest(baseUrl, "/api/overlay-templates", {
                    method: "POST",
                    cookie: alice.cookie,
                    body: validPayload({ name: "Before Update" }),
                });
                const { template } = await created.json();

                const res = await jsonRequest(baseUrl, `/api/overlay-templates/${template.id}`, {
                    method: "PATCH",
                    cookie: alice.cookie,
                    body: {
                        name: "After Update",
                        description: "Edited",
                        elements: [mediaElement({ id: "el-1" }), mediaElement({ id: "el-2", layer: 3 })],
                    },
                });
                assert.equal(res.status, 200);
                const data = await res.json();
                assert.equal(data.template.name, "After Update");
                assert.equal(data.template.description, "Edited");
                assert.equal(data.template.elements.length, 2);
                assert.equal(data.template.elements[1].layer, 3);
            });
        });

        it("duplicates a template into an independent record", async () => {
            await withServer(env.app, async (baseUrl) => {
                const created = await jsonRequest(baseUrl, "/api/overlay-templates", {
                    method: "POST",
                    cookie: alice.cookie,
                    body: validPayload({ name: "Original" }),
                });
                const { template } = await created.json();

                const res = await jsonRequest(baseUrl, `/api/overlay-templates/${template.id}/duplicate`, {
                    method: "POST",
                    cookie: alice.cookie,
                    body: { name: "Original Copy" },
                });
                assert.equal(res.status, 201);
                const data = await res.json();
                assert.notEqual(data.template.id, template.id);
                assert.equal(data.template.name, "Original Copy");
                assert.deepEqual(data.template.elements, template.elements);
                assert.equal(data.template.metadata.duplicatedFrom, template.id);
            });
        });

        it("deletes an owned template", async () => {
            await withServer(env.app, async (baseUrl) => {
                const created = await jsonRequest(baseUrl, "/api/overlay-templates", {
                    method: "POST",
                    cookie: alice.cookie,
                    body: validPayload({ name: "To Delete" }),
                });
                const { template } = await created.json();

                const res = await jsonRequest(baseUrl, `/api/overlay-templates/${template.id}`, {
                    method: "DELETE",
                    cookie: alice.cookie,
                });
                assert.equal(res.status, 200);

                const check = await jsonRequest(baseUrl, `/api/overlay-templates/${template.id}`, {
                    cookie: alice.cookie,
                });
                assert.equal(check.status, 404);
            });
        });
    });

    describe("Validation and safety", () => {
        it("rejects a missing name", async () => {
            await withServer(env.app, async (baseUrl) => {
                const res = await jsonRequest(baseUrl, "/api/overlay-templates", {
                    method: "POST",
                    cookie: alice.cookie,
                    body: validPayload({ name: "   " }),
                });
                assert.equal(res.status, 400);
                const data = await res.json();
                assert.equal(data.code, "INVALID_TEMPLATE_NAME");
            });
        });

        it("rejects an unsupported schema version", async () => {
            await withServer(env.app, async (baseUrl) => {
                const res = await jsonRequest(baseUrl, "/api/overlay-templates", {
                    method: "POST",
                    cookie: alice.cookie,
                    body: validPayload({ schemaVersion: 99 }),
                });
                assert.equal(res.status, 400);
                const data = await res.json();
                assert.equal(data.code, "UNSUPPORTED_TEMPLATE_SCHEMA_VERSION");
            });
        });

        it("rejects flattened media fields on an element", async () => {
            await withServer(env.app, async (baseUrl) => {
                const res = await jsonRequest(baseUrl, "/api/overlay-templates", {
                    method: "POST",
                    cookie: alice.cookie,
                    body: validPayload({
                        elements: [mediaElement({ previewImage: "data:image/jpeg;base64,AAAA" })],
                    }),
                });
                assert.equal(res.status, 400);
                const data = await res.json();
                assert.equal(data.code, "TEMPLATE_FLATTENED_PAYLOAD_REJECTED");
            });
        });

        it("rejects an inline blob on a media reference", async () => {
            await withServer(env.app, async (baseUrl) => {
                const res = await jsonRequest(baseUrl, "/api/overlay-templates", {
                    method: "POST",
                    cookie: alice.cookie,
                    body: validPayload({
                        elements: [mediaElement({
                            media: { mediaKind: "image", assetId: "a", blob: "binary" },
                        })],
                    }),
                });
                assert.equal(res.status, 400);
                const data = await res.json();
                assert.equal(data.code, "TEMPLATE_FLATTENED_PAYLOAD_REJECTED");
            });
        });

        it("rejects an unknown element kind", async () => {
            await withServer(env.app, async (baseUrl) => {
                const res = await jsonRequest(baseUrl, "/api/overlay-templates", {
                    method: "POST",
                    cookie: alice.cookie,
                    body: validPayload({ elements: [mediaElement({ kind: "hologram" })] }),
                });
                assert.equal(res.status, 400);
                const data = await res.json();
                assert.equal(data.code, "INVALID_TEMPLATE_ELEMENT");
            });
        });

        it("rejects a media element without an asset reference", async () => {
            await withServer(env.app, async (baseUrl) => {
                const res = await jsonRequest(baseUrl, "/api/overlay-templates", {
                    method: "POST",
                    cookie: alice.cookie,
                    body: validPayload({
                        elements: [mediaElement({ media: { mediaKind: "image" } })],
                    }),
                });
                assert.equal(res.status, 400);
                const data = await res.json();
                assert.equal(data.code, "INVALID_TEMPLATE_MEDIA");
            });
        });

        it("accepts a vector element with self-contained document data", async () => {
            await withServer(env.app, async (baseUrl) => {
                const res = await jsonRequest(baseUrl, "/api/overlay-templates", {
                    method: "POST",
                    cookie: alice.cookie,
                    body: validPayload({
                        name: "Vector Badge",
                        elements: [{
                            id: "el-v1",
                            kind: "vector",
                            baseTransform: { x: 0, y: 0, scale: 0.4, rotation: 0, opacity: 1 },
                            vector: {
                                body: '<path d="M0 0 L100 0 L100 100 Z" fill="#ff0000"/>',
                                background: "transparent",
                                colorSlots: ["#ff0000"],
                            },
                        }],
                    }),
                });
                assert.equal(res.status, 201);
                const data = await res.json();
                assert.equal(data.template.elements[0].kind, "vector");
                assert.match(data.template.elements[0].vector.body, /<path/);
            });
        });
    });

    describe("Persistence across reloads", () => {
        it("keeps templates available after a new pool-independent request cycle", async () => {
            await withServer(env.app, async (baseUrl) => {
                const created = await jsonRequest(baseUrl, "/api/overlay-templates", {
                    method: "POST",
                    cookie: alice.cookie,
                    body: validPayload({ name: "Persisted" }),
                });
                const { template } = await created.json();

                // Second server instance sharing the same pool simulates an app restart.
                const { createApp } = await import("../app.js");
                const restartedApp = createApp();
                await withServer(restartedApp, async (restartUrl) => {
                    const res = await jsonRequest(restartUrl, `/api/overlay-templates/${template.id}`, {
                        cookie: alice.cookie,
                    });
                    assert.equal(res.status, 200);
                    const data = await res.json();
                    assert.equal(data.template.name, "Persisted");
                });
            });
        });
    });
});
