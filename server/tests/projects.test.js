import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestEnvironment, withServer } from "./test-helpers.js";

describe("Projects & Project Versions API", () => {
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
        const res = await fetch(`${baseUrl}/api/projects`);
        assert.equal(res.status, 401);
        const body = await res.json();
        assert.equal(body.code, "UNAUTHORIZED");
      });
    });

    it("should prevent cross-user project access (IDOR protection)", async () => {
      const userA = await env.createSession("alice@example.com");
      const userB = await env.createSession("bob@example.com");

      await withServer(env.app, async (baseUrl) => {
        // User A creates project
        const createRes = await fetch(`${baseUrl}/api/projects`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: userA.cookie,
          },
          body: JSON.stringify({ title: "Alice Secret Project" }),
        });
        assert.equal(createRes.status, 201);
        const { project } = await createRes.json();

        // User B attempts GET on Alice's project -> 403
        const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`, {
          headers: { Cookie: userB.cookie },
        });
        assert.equal(getRes.status, 403);
        const getBody = await getRes.json();
        assert.equal(getBody.code, "FORBIDDEN");

        // User B attempts PATCH on Alice's project -> 403
        const patchRes = await fetch(`${baseUrl}/api/projects/${project.id}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Cookie: userB.cookie,
          },
          body: JSON.stringify({ title: "Hacked Project" }),
        });
        assert.equal(patchRes.status, 403);

        // User B attempts DELETE on Alice's project -> 403
        const deleteRes = await fetch(`${baseUrl}/api/projects/${project.id}`, {
          method: "DELETE",
          headers: { Cookie: userB.cookie },
        });
        assert.equal(deleteRes.status, 403);

        // User B's project listing should NOT show Alice's project
        const listRes = await fetch(`${baseUrl}/api/projects`, {
          headers: { Cookie: userB.cookie },
        });
        const listBody = await listRes.json();
        assert.equal(listBody.projects.length, 0);
      });
    });
  });

  describe("CRUD Operations", () => {
    it("should create, list, retrieve, update, and delete projects", async () => {
      const session = await env.createSession("creator@example.com");

      await withServer(env.app, async (baseUrl) => {
        // 1. Create project
        const createRes = await fetch(`${baseUrl}/api/projects`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: session.cookie,
          },
          body: JSON.stringify({
            title: "Summer Vacation Vlog",
            fps: 60,
            duration: 120.5,
            ratio: "16:9",
            metadata: { tags: ["travel", "vlog"] },
          }),
        });
        assert.equal(createRes.status, 201);
        const createBody = await createRes.json();
        assert.equal(createBody.ok, true);
        assert.equal(createBody.project.title, "Summer Vacation Vlog");
        assert.equal(createBody.project.fps, 60);
        assert.equal(createBody.project.owner_id, session.user.id);

        const projectId = createBody.project.id;

        // 2. List projects
        const listRes = await fetch(`${baseUrl}/api/projects`, {
          headers: { Cookie: session.cookie },
        });
        assert.equal(listRes.status, 200);
        const listBody = await listRes.json();
        assert.equal(listBody.projects.length, 1);
        assert.equal(listBody.projects[0].id, projectId);

        // 3. Get single project
        const getRes = await fetch(`${baseUrl}/api/projects/${projectId}`, {
          headers: { Cookie: session.cookie },
        });
        assert.equal(getRes.status, 200);
        const getBody = await getRes.json();
        assert.equal(getBody.project.title, "Summer Vacation Vlog");

        // 4. Update project
        const patchRes = await fetch(`${baseUrl}/api/projects/${projectId}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Cookie: session.cookie,
          },
          body: JSON.stringify({
            title: "Summer Vacation Vlog (Final Cut)",
            duration: 135.0,
          }),
        });
        assert.equal(patchRes.status, 200);
        const patchBody = await patchRes.json();
        assert.equal(patchBody.project.title, "Summer Vacation Vlog (Final Cut)");
        assert.equal(patchBody.project.duration, 135.0);

        // 5. Delete project
        const deleteRes = await fetch(`${baseUrl}/api/projects/${projectId}`, {
          method: "DELETE",
          headers: { Cookie: session.cookie },
        });
        assert.equal(deleteRes.status, 200);

        // Verify project is gone
        const verifyRes = await fetch(`${baseUrl}/api/projects/${projectId}`, {
          headers: { Cookie: session.cookie },
        });
        assert.equal(verifyRes.status, 404);
      });
    });

    it("should reject invalid project payloads", async () => {
      const session = await env.createSession("validator@example.com");

      await withServer(env.app, async (baseUrl) => {
        // Empty title
        const emptyTitleRes = await fetch(`${baseUrl}/api/projects`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: session.cookie },
          body: JSON.stringify({ title: "" }),
        });
        assert.equal(emptyTitleRes.status, 400);

        // Invalid FPS
        const invalidFpsRes = await fetch(`${baseUrl}/api/projects`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: session.cookie },
          body: JSON.stringify({ fps: -5 }),
        });
        assert.equal(invalidFpsRes.status, 400);

        // Malformed UUID
        const badUuidRes = await fetch(`${baseUrl}/api/projects/not-a-uuid`, {
          headers: { Cookie: session.cookie },
        });
        assert.equal(badUuidRes.status, 400);
      });
    });
  });

  describe("Project Versions", () => {
    it("should create, list, and retrieve project versions", async () => {
      const session = await env.createSession("versioner@example.com");

      await withServer(env.app, async (baseUrl) => {
        const createProj = await fetch(`${baseUrl}/api/projects`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: session.cookie },
          body: JSON.stringify({ title: "Versioned Timeline" }),
        });
        const { project } = await createProj.json();

        // Create version 1
        const v1Res = await fetch(`${baseUrl}/api/projects/${project.id}/versions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: session.cookie },
          body: JSON.stringify({
            revision: 1,
            archiveStoragePath: "storage/projects/rev1.timeline",
            duration: 45.0,
            changeSummary: "Added title sequence and intro audio",
          }),
        });
        assert.equal(v1Res.status, 201);
        const v1Body = await v1Res.json();
        assert.equal(v1Body.version.revision, 1);
        assert.equal(v1Body.version.archive_storage_path, "storage/projects/rev1.timeline");

        // Create version 2
        const v2Res = await fetch(`${baseUrl}/api/projects/${project.id}/versions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: session.cookie },
          body: JSON.stringify({
            revision: 2,
            archiveStoragePath: "storage/projects/rev2.timeline",
            duration: 60.0,
            changeSummary: "Color grading and transitions",
          }),
        });
        assert.equal(v2Res.status, 201);

        // List versions
        const listVersionsRes = await fetch(`${baseUrl}/api/projects/${project.id}/versions`, {
          headers: { Cookie: session.cookie },
        });
        assert.equal(listVersionsRes.status, 200);
        const listVersionsBody = await listVersionsRes.json();
        assert.equal(listVersionsBody.versions.length, 2);

        // Retrieve single version by revision
        const getV1Res = await fetch(`${baseUrl}/api/projects/${project.id}/versions/1`, {
          headers: { Cookie: session.cookie },
        });
        assert.equal(getV1Res.status, 200);
        const getV1Body = await getV1Res.json();
        assert.equal(getV1Body.version.revision, 1);
        assert.equal(getV1Body.version.change_summary, "Added title sequence and intro audio");

        // Verify project current_revision was updated to latest revision
        const projRes = await fetch(`${baseUrl}/api/projects/${project.id}`, {
          headers: { Cookie: session.cookie },
        });
        const projBody = await projRes.json();
        assert.equal(projBody.project.current_revision, 2);
        assert.equal(projBody.project.archive_storage_path, "storage/projects/rev2.timeline");
      });
    });

    it("should upload binary .timeline archive, update project revision, and download archive", async () => {
      const session = await env.createSession("creator@example.com");
      const otherSession = await env.createSession("intruder@example.com");

      await withServer(env.app, async (baseUrl) => {
        // 1. Create project
        const createRes = await fetch(`${baseUrl}/api/projects`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: session.cookie },
          body: JSON.stringify({ title: "Archive Test Video", duration: 12.5 }),
        });
        assert.equal(createRes.status, 201);
        const { project } = await createRes.json();
        assert.equal(project.current_revision, 0);

        // 2. Reject empty archive upload
        const emptyUploadRes = await fetch(`${baseUrl}/api/projects/${project.id}/archive`, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream", Cookie: session.cookie },
          body: Buffer.alloc(0),
        });
        assert.equal(emptyUploadRes.status, 400);

        // 3. Reject upload from another user
        const fakeArchiveData = Buffer.from("PK\x03\x04mock-timeline-zip-data");
        const crossUploadRes = await fetch(`${baseUrl}/api/projects/${project.id}/archive`, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream", Cookie: otherSession.cookie },
          body: fakeArchiveData,
        });
        assert.equal(crossUploadRes.status, 403);

        // 4. Upload valid archive
        const uploadRes = await fetch(`${baseUrl}/api/projects/${project.id}/archive?duration=15.0&changeSummary=Initial+upload`, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream", Cookie: session.cookie },
          body: fakeArchiveData,
        });
        assert.equal(uploadRes.status, 200);
        const uploadBody = await uploadRes.json();
        assert.equal(uploadBody.ok, true);
        assert.equal(uploadBody.project.current_revision, 1);
        assert.ok(uploadBody.project.archive_storage_path.endsWith(".timeline"));
        assert.equal(uploadBody.version.revision, 1);

        // 5. Download current archive
        const downloadRes = await fetch(`${baseUrl}/api/projects/${project.id}/archive`, {
          headers: { Cookie: session.cookie },
        });
        assert.equal(downloadRes.status, 200);
        assert.equal(downloadRes.headers.get("content-type"), "application/zip");
        const downloadedBuffer = Buffer.from(await downloadRes.arrayBuffer());
        assert.deepEqual(downloadedBuffer, fakeArchiveData);

        // 6. Download specific revision archive
        const versionDownloadRes = await fetch(`${baseUrl}/api/projects/${project.id}/versions/1/archive`, {
          headers: { Cookie: session.cookie },
        });
        assert.equal(versionDownloadRes.status, 200);
        const versionBuffer = Buffer.from(await versionDownloadRes.arrayBuffer());
        assert.deepEqual(versionBuffer, fakeArchiveData);

        // 7. Reject download from other user
        const forbiddenDownload = await fetch(`${baseUrl}/api/projects/${project.id}/archive`, {
          headers: { Cookie: otherSession.cookie },
        });
        assert.equal(forbiddenDownload.status, 403);
      });
    });
  });
});
