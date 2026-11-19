import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { resolveSafeStoragePath } from "../services/storage/storageSecurity.js";
import { setupTestEnvironment, withServer } from "./test-helpers.js";

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
]);

async function uploadImage(baseUrl, cookie, {
  bytes = PNG_BYTES,
  contentType = "image/png",
  filename = "template-image.png",
  width = 320,
  height = 180,
} = {}) {
  return fetch(`${baseUrl}/api/assets/upload`, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      "X-File-Name": encodeURIComponent(filename),
      "X-Image-Width": String(width),
      "X-Image-Height": String(height),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: bytes,
  });
}

describe("Assets API", () => {
  let env;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.teardown();
  });

  describe("Authentication & Ownership Enforcement", () => {
    it("should reject unauthenticated requests with 401", async () => {
      await withServer(env.app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/assets`);
        assert.equal(res.status, 401);
        const body = await res.json();
        assert.equal(body.code, "UNAUTHORIZED");
      });
    });

    it("should prevent cross-user asset access and cross-user project linking", async () => {
      const userA = await env.createSession("alice.assets@example.com");
      const userB = await env.createSession("bob.assets@example.com");

      await withServer(env.app, async (baseUrl) => {
        // User A creates an asset
        const createRes = await fetch(`${baseUrl}/api/assets`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: userA.cookie,
          },
          body: JSON.stringify({
            filename: "drone-shot.mp4",
            mediaType: "video",
            mimeType: "video/mp4",
            storagePath: "storage/assets/drone-shot.mp4",
            sizeBytes: 25000000,
          }),
        });
        assert.equal(createRes.status, 201);
        const { asset } = await createRes.json();

        // User B attempts to access User A's asset -> 403
        const getRes = await fetch(`${baseUrl}/api/assets/${asset.id}`, {
          headers: { Cookie: userB.cookie },
        });
        assert.equal(getRes.status, 403);
        const getBody = await getRes.json();
        assert.equal(getBody.code, "FORBIDDEN");

        // User B attempts to delete User A's asset -> 403
        const deleteRes = await fetch(`${baseUrl}/api/assets/${asset.id}`, {
          method: "DELETE",
          headers: { Cookie: userB.cookie },
        });
        assert.equal(deleteRes.status, 403);

        // User A creates a project
        const projRes = await fetch(`${baseUrl}/api/projects`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: userA.cookie },
          body: JSON.stringify({ title: "Alice Project" }),
        });
        const { project } = await projRes.json();

        // User B attempts to attach an asset to Alice's project -> 403
        const linkRes = await fetch(`${baseUrl}/api/assets`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: userB.cookie },
          body: JSON.stringify({
            projectId: project.id,
            filename: "exploit.mp4",
            mediaType: "video",
            mimeType: "video/mp4",
            storagePath: "storage/assets/exploit.mp4",
            sizeBytes: 100,
          }),
        });
        assert.equal(linkRes.status, 403);
      });
    });
  });

  describe("Persistent Overlay Template Images", () => {
    it("should reject unauthenticated binary uploads", async () => {
      await withServer(env.app, async (baseUrl) => {
        const response = await uploadImage(baseUrl, "");
        assert.equal(response.status, 401);
        const body = await response.json();
        assert.equal(body.code, "UNAUTHORIZED");
      });
    });

    it("should persist, list, serve, and delete owner-scoped image content", async () => {
      const owner = await env.createSession("template.asset.owner@example.com");
      const other = await env.createSession("template.asset.other@example.com");

      await withServer(env.app, async (baseUrl) => {
        const uploadResponse = await uploadImage(baseUrl, owner.cookie, {
          filename: "My Overlay.png",
          width: 640,
          height: 360,
        });
        assert.equal(uploadResponse.status, 201);
        const { asset } = await uploadResponse.json();
        assert.equal(asset.owner_id, owner.user.id);
        assert.equal(asset.project_id, null);
        assert.equal(asset.filename, "My Overlay.png");
        assert.equal(asset.media_type, "image");
        assert.equal(asset.mime_type, "image/png");
        assert.equal(asset.metadata.scope, "overlay-template");
        assert.equal(asset.metadata.width, 640);
        assert.equal(asset.metadata.height, 360);
        assert.match(asset.sha256, /^[a-f0-9]{64}$/);
        assert.match(asset.storage_path, /^assets\//);

        const absolutePath = resolveSafeStoragePath(asset.storage_path);
        assert.equal(existsSync(absolutePath), true);
        assert.deepEqual(await readFile(absolutePath), PNG_BYTES);

        const listResponse = await fetch(`${baseUrl}/api/assets?limit=100`, {
          headers: { Cookie: owner.cookie },
        });
        assert.equal(listResponse.status, 200);
        const listBody = await listResponse.json();
        assert.equal(listBody.assets.some((item) => item.id === asset.id), true);

        const contentResponse = await fetch(`${baseUrl}/api/assets/${asset.id}/content`, {
          headers: { Cookie: owner.cookie },
        });
        assert.equal(contentResponse.status, 200);
        assert.equal(contentResponse.headers.get("content-type"), "image/png");
        assert.deepEqual(Buffer.from(await contentResponse.arrayBuffer()), PNG_BYTES);

        const forbiddenResponse = await fetch(`${baseUrl}/api/assets/${asset.id}/content`, {
          headers: { Cookie: other.cookie },
        });
        assert.equal(forbiddenResponse.status, 403);

        const deleteResponse = await fetch(`${baseUrl}/api/assets/${asset.id}`, {
          method: "DELETE",
          headers: { Cookie: owner.cookie },
        });
        assert.equal(deleteResponse.status, 200);
        assert.equal(existsSync(absolutePath), false);
      });
    });

    it("should keep duplicate-content records isolated when one is deleted", async () => {
      const session = await env.createSession("template.asset.duplicates@example.com");

      await withServer(env.app, async (baseUrl) => {
        const firstResponse = await uploadImage(baseUrl, session.cookie, { filename: "first.png" });
        const secondResponse = await uploadImage(baseUrl, session.cookie, { filename: "second.png" });
        assert.equal(firstResponse.status, 201);
        assert.equal(secondResponse.status, 201);
        const first = (await firstResponse.json()).asset;
        const second = (await secondResponse.json()).asset;
        assert.equal(first.sha256, second.sha256);
        assert.notEqual(first.storage_path, second.storage_path);

        const deleteFirst = await fetch(`${baseUrl}/api/assets/${first.id}`, {
          method: "DELETE",
          headers: { Cookie: session.cookie },
        });
        assert.equal(deleteFirst.status, 200);

        const secondContent = await fetch(`${baseUrl}/api/assets/${second.id}/content`, {
          headers: { Cookie: session.cookie },
        });
        assert.equal(secondContent.status, 200);
        assert.deepEqual(Buffer.from(await secondContent.arrayBuffer()), PNG_BYTES);

        const secondPath = resolveSafeStoragePath(second.storage_path);
        const deleteSecond = await fetch(`${baseUrl}/api/assets/${second.id}`, {
          method: "DELETE",
          headers: { Cookie: session.cookie },
        });
        assert.equal(deleteSecond.status, 200);
        assert.equal(existsSync(secondPath), false);
      });
    });

    it("should reject unsupported types, invalid signatures, and active SVG content", async () => {
      const session = await env.createSession("template.asset.validation@example.com");

      await withServer(env.app, async (baseUrl) => {
        const unsupported = await uploadImage(baseUrl, session.cookie, {
          contentType: "image/gif",
          filename: "animation.gif",
          bytes: Buffer.from("GIF89a"),
        });
        assert.equal(unsupported.status, 400);
        assert.equal((await unsupported.json()).code, "UNSUPPORTED_ASSET_TYPE");

        const invalidSignature = await uploadImage(baseUrl, session.cookie, {
          bytes: Buffer.from("not a png"),
        });
        assert.equal(invalidSignature.status, 400);
        assert.equal((await invalidSignature.json()).code, "INVALID_IMAGE_SIGNATURE");

        const unsafeSvg = await uploadImage(baseUrl, session.cookie, {
          contentType: "image/svg+xml",
          filename: "unsafe.svg",
          bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
        });
        assert.equal(unsafeSvg.status, 400);
        assert.equal((await unsafeSvg.json()).code, "UNSAFE_SVG");

        const safeSvgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path fill="#7c3aed" d="M0 0h10v10H0z"/></svg>');
        const safeSvg = await uploadImage(baseUrl, session.cookie, {
          contentType: "image/svg+xml",
          filename: "safe.svg",
          bytes: safeSvgBytes,
          width: 10,
          height: 10,
        });
        assert.equal(safeSvg.status, 201);
        const asset = (await safeSvg.json()).asset;

        const content = await fetch(`${baseUrl}/api/assets/${asset.id}/content`, {
          headers: { Cookie: session.cookie },
        });
        assert.equal(content.status, 200);
        assert.equal(content.headers.get("content-type"), "image/svg+xml");
        assert.match(content.headers.get("content-security-policy"), /default-src 'none'/);
        assert.deepEqual(Buffer.from(await content.arrayBuffer()), safeSvgBytes);

        await fetch(`${baseUrl}/api/assets/${asset.id}`, {
          method: "DELETE",
          headers: { Cookie: session.cookie },
        });
      });
    });

    it("should return a stable 404 when persisted metadata points to a missing file", async () => {
      const session = await env.createSession("template.asset.missing@example.com");

      await withServer(env.app, async (baseUrl) => {
        const uploadResponse = await uploadImage(baseUrl, session.cookie);
        assert.equal(uploadResponse.status, 201);
        const asset = (await uploadResponse.json()).asset;
        await unlink(resolveSafeStoragePath(asset.storage_path));

        const contentResponse = await fetch(`${baseUrl}/api/assets/${asset.id}/content`, {
          headers: { Cookie: session.cookie },
        });
        assert.equal(contentResponse.status, 404);
        assert.equal((await contentResponse.json()).code, "ASSET_CONTENT_NOT_FOUND");

        const deleteResponse = await fetch(`${baseUrl}/api/assets/${asset.id}`, {
          method: "DELETE",
          headers: { Cookie: session.cookie },
        });
        assert.equal(deleteResponse.status, 200);
      });
    });
  });

  describe("CRUD Operations", () => {
    it("should register, list, retrieve, and delete asset metadata", async () => {
      const session = await env.createSession("media.editor@example.com");

      await withServer(env.app, async (baseUrl) => {
        // Create project first
        const projRes = await fetch(`${baseUrl}/api/projects`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: session.cookie },
          body: JSON.stringify({ title: "Documentary Film" }),
        });
        const { project } = await projRes.json();

        // 1. Register asset linked to project
        const createRes = await fetch(`${baseUrl}/api/assets`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: session.cookie },
          body: JSON.stringify({
            projectId: project.id,
            filename: "interview-take-1.mp4",
            mediaType: "video",
            mimeType: "video/mp4",
            storagePath: "storage/assets/interview-take-1.mp4",
            sizeBytes: 52428800,
            sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            metadata: { duration: 120.4, width: 1920, height: 1080 },
          }),
        });
        assert.equal(createRes.status, 201);
        const { asset } = await createRes.json();
        assert.equal(asset.filename, "interview-take-1.mp4");
        assert.equal(asset.project_id, project.id);
        assert.equal(asset.owner_id, session.user.id);
        assert.equal(Number(asset.size_bytes), 52428800);

        // 2. Register global library asset (projectId = null)
        const globalRes = await fetch(`${baseUrl}/api/assets`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: session.cookie },
          body: JSON.stringify({
            filename: "background-music.mp3",
            mediaType: "audio",
            mimeType: "audio/mpeg",
            storagePath: "storage/assets/bgm.mp3",
            sizeBytes: 4000000,
          }),
        });
        assert.equal(globalRes.status, 201);

        // 3. List all owner assets
        const listAllRes = await fetch(`${baseUrl}/api/assets`, {
          headers: { Cookie: session.cookie },
        });
        assert.equal(listAllRes.status, 200);
        const listAllBody = await listAllRes.json();
        assert.equal(listAllBody.assets.length, 2);

        // 4. List assets filtered by project
        const listProjRes = await fetch(`${baseUrl}/api/assets?projectId=${project.id}`, {
          headers: { Cookie: session.cookie },
        });
        assert.equal(listProjRes.status, 200);
        const listProjBody = await listProjRes.json();
        assert.equal(listProjBody.assets.length, 1);
        assert.equal(listProjBody.assets[0].id, asset.id);

        // 5. Get asset by ID
        const getRes = await fetch(`${baseUrl}/api/assets/${asset.id}`, {
          headers: { Cookie: session.cookie },
        });
        assert.equal(getRes.status, 200);
        const getBody = await getRes.json();
        assert.equal(getBody.asset.filename, "interview-take-1.mp4");

        // 6. Delete asset
        const deleteRes = await fetch(`${baseUrl}/api/assets/${asset.id}`, {
          method: "DELETE",
          headers: { Cookie: session.cookie },
        });
        assert.equal(deleteRes.status, 200);

        // Verify asset is deleted
        const verifyRes = await fetch(`${baseUrl}/api/assets/${asset.id}`, {
          headers: { Cookie: session.cookie },
        });
        assert.equal(verifyRes.status, 404);
      });
    });

    it("should reject invalid asset payloads", async () => {
      const session = await env.createSession("asset.val@example.com");

      await withServer(env.app, async (baseUrl) => {
        // Missing filename
        const noNameRes = await fetch(`${baseUrl}/api/assets`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: session.cookie },
          body: JSON.stringify({
            mediaType: "video",
            mimeType: "video/mp4",
            storagePath: "path",
            sizeBytes: 100,
          }),
        });
        assert.equal(noNameRes.status, 400);

        // Missing storagePath
        const noPathRes = await fetch(`${baseUrl}/api/assets`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: session.cookie },
          body: JSON.stringify({
            filename: "file.mp4",
            mediaType: "video",
            mimeType: "video/mp4",
            sizeBytes: 100,
          }),
        });
        assert.equal(noPathRes.status, 400);

        // Invalid sizeBytes
        const badSizeRes = await fetch(`${baseUrl}/api/assets`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: session.cookie },
          body: JSON.stringify({
            filename: "file.mp4",
            mediaType: "video",
            mimeType: "video/mp4",
            storagePath: "path",
            sizeBytes: -10,
          }),
        });
        assert.equal(badSizeRes.status, 400);
      });
    });
  });
});
