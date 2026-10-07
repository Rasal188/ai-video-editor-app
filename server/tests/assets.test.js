import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestEnvironment, withServer } from "./test-helpers.js";

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
