import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { strToU8, zipSync } from "fflate";
import { setupTestEnvironment, withServer } from "./test-helpers.js";

const executeFile = promisify(execFile);

async function ensureTestArchive() {
  const archivePath = "test-artifacts/project-trimmed.timeline";
  if (existsSync(archivePath)) return archivePath;
  await mkdir("test-artifacts", { recursive: true });
  const tempSourceVideo = "test-artifacts/temp-test-source.mp4";
  await executeFile("ffmpeg", [
    "-hide_banner", "-y",
    "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=44100",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    tempSourceVideo,
  ]);
  const sourceBytes = await readFile(tempSourceVideo);
  const archiveFiles = {
    "project.json": strToU8(JSON.stringify({
      format: "timeline-studio-archive",
      version: 1,
      project: {
        ratioId: "16:9",
        visualSegments: [
          {
            id: "vis-test-1",
            type: "video",
            duration: 1.5,
            sourceStart: 0,
            playbackRate: 1,
            volume: 0.8,
          },
        ],
      },
      media: {
        visuals: [
          { id: "vis-test-1", path: "media/visuals/source.mp4" },
        ],
      },
    })),
    "media/visuals/source.mp4": new Uint8Array(sourceBytes),
  };
  await writeFile(archivePath, zipSync(archiveFiles, { level: 6 }));
  return archivePath;
}

describe("Render Jobs API", () => {
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
        const res = await fetch(`${baseUrl}/api/renders`);
        assert.equal(res.status, 401);
        const body = await res.json();
        assert.equal(body.code, "UNAUTHORIZED");
      });
    });

    it("should prevent cross-user render job access and unauthorized job creation", async () => {
      const userA = await env.createSession("alice.renders@example.com");
      const userB = await env.createSession("bob.renders@example.com");

      await withServer(env.app, async (baseUrl) => {
        // User A creates project
        const projRes = await fetch(`${baseUrl}/api/projects`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: userA.cookie },
          body: JSON.stringify({ title: "Alice Render Project" }),
        });
        const { project } = await projRes.json();

        // User B tries to trigger render job on Alice's project -> 403
        const unauthorizedCreate = await fetch(`${baseUrl}/api/renders`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: userB.cookie },
          body: JSON.stringify({
            projectId: project.id,
            requestedRevision: 0,
          }),
        });
        assert.equal(unauthorizedCreate.status, 403);
        const errBody = await unauthorizedCreate.json();
        assert.equal(errBody.code, "FORBIDDEN");

        // User A creates a legitimate render job
        const createRes = await fetch(`${baseUrl}/api/renders`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: userA.cookie },
          body: JSON.stringify({
            projectId: project.id,
            requestedRevision: 0,
            settings: { resolution: "1080p", fps: 30 },
          }),
        });
        assert.equal(createRes.status, 201);
        const { job } = await createRes.json();

        // User B tries to inspect Alice's render job -> 403
        const getRes = await fetch(`${baseUrl}/api/renders/${job.id}`, {
          headers: { Cookie: userB.cookie },
        });
        assert.equal(getRes.status, 403);

        // User B tries to cancel Alice's render job -> 403
        const cancelRes = await fetch(`${baseUrl}/api/renders/${job.id}/cancel`, {
          method: "POST",
          headers: { Cookie: userB.cookie },
        });
        assert.equal(cancelRes.status, 403);
      });
    });
  });

  describe("Lifecycle & Job Management", () => {
    it("should create, list, retrieve, and cancel render jobs", async () => {
      const session = await env.createSession("render.master@example.com");

      await withServer(env.app, async (baseUrl) => {
        // Create project
        const projRes = await fetch(`${baseUrl}/api/projects`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: session.cookie },
          body: JSON.stringify({ title: "Render Target", currentRevision: 1 }),
        });
        const { project } = await projRes.json();

        // 1. Create render job
        const createRes = await fetch(`${baseUrl}/api/renders`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: session.cookie },
          body: JSON.stringify({
            projectId: project.id,
            requestedRevision: 1,
            settings: { preset: "fast", crf: 23 },
          }),
        });
        assert.equal(createRes.status, 201);
        const { job } = await createRes.json();
        assert.equal(job.project_id, project.id);
        assert.equal(job.requested_revision, 1);
        assert.equal(job.status, "pending");
        assert.equal(job.settings.preset, "fast");

        // 2. Retrieve job by ID
        const getRes = await fetch(`${baseUrl}/api/renders/${job.id}`, {
          headers: { Cookie: session.cookie },
        });
        assert.equal(getRes.status, 200);
        const getBody = await getRes.json();
        assert.equal(getBody.job.id, job.id);
        assert.equal(getBody.job.status, "pending");

        // 3. List render jobs for project
        const listProjRes = await fetch(`${baseUrl}/api/renders?projectId=${project.id}`, {
          headers: { Cookie: session.cookie },
        });
        assert.equal(listProjRes.status, 200);
        const listProjBody = await listProjRes.json();
        assert.equal(listProjBody.jobs.length, 1);
        assert.equal(listProjBody.jobs[0].id, job.id);

        // 4. Cancel render job
        const cancelRes = await fetch(`${baseUrl}/api/renders/${job.id}/cancel`, {
          method: "POST",
          headers: { Cookie: session.cookie },
        });
        assert.equal(cancelRes.status, 200);
        const cancelBody = await cancelRes.json();
        assert.equal(cancelBody.job.status, "cancelled");

        // Attempting to cancel again should fail with 400
        const reCancelRes = await fetch(`${baseUrl}/api/renders/${job.id}/cancel`, {
          method: "POST",
          headers: { Cookie: session.cookie },
        });
        assert.equal(reCancelRes.status, 400);
      });
    });

    it("should reject invalid render job requests", async () => {
      const session = await env.createSession("invalid.render@example.com");

      await withServer(env.app, async (baseUrl) => {
        // Missing projectId
        const noProjRes = await fetch(`${baseUrl}/api/renders`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: session.cookie },
          body: JSON.stringify({ requestedRevision: 0 }),
        });
        assert.equal(noProjRes.status, 400);

        // Non-existent projectId
        const nonExistentProjRes = await fetch(`${baseUrl}/api/renders`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: session.cookie },
          body: JSON.stringify({
            projectId: "00000000-0000-0000-0000-000000000000",
            requestedRevision: 0,
          }),
        });
        assert.equal(nonExistentProjRes.status, 404);
      });
    });

    it("should handle missing archive path gracefully during render execution", async () => {
      const session = await env.createSession("missing.archive@example.com");

      await withServer(env.app, async (baseUrl) => {
        // Project with non-existent archive path
        const projRes = await fetch(`${baseUrl}/api/projects`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: session.cookie },
          body: JSON.stringify({
            title: "Ghost Project",
            archiveStoragePath: "storage/non-existent.timeline",
          }),
        });
        const { project } = await projRes.json();

        // Create render job
        const jobRes = await fetch(`${baseUrl}/api/renders`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: session.cookie },
          body: JSON.stringify({ projectId: project.id }),
        });
        const { job } = await jobRes.json();

        // Start render job
        const startRes = await fetch(`${baseUrl}/api/renders/${job.id}/start`, {
          method: "POST",
          headers: { Cookie: session.cookie },
        });
        assert.equal(startRes.status, 200);
        const startBody = await startRes.json();
        assert.equal(startBody.job.status, "failed");
        assert.ok(startBody.job.error_message.includes("Project archive not found"));
      });
    });

    it("should execute real CLI render for project with valid archive", async () => {
      const session = await env.createSession("real.render@example.com");
      const testArchivePath = await ensureTestArchive();

      await withServer(env.app, async (baseUrl) => {
        // Use the baseline verified test timeline archive
        const projRes = await fetch(`${baseUrl}/api/projects`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: session.cookie },
          body: JSON.stringify({
            title: "Real CLI Render Project",
            archiveStoragePath: testArchivePath,
          }),
        });
        const { project } = await projRes.json();

        // Create render job with render settings
        const jobRes = await fetch(`${baseUrl}/api/renders`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: session.cookie },
          body: JSON.stringify({
            projectId: project.id,
            settings: {
              width: 640,
              height: 360,
              frameRate: 30,
              preset: "ultrafast",
            },
          }),
        });
        const { job } = await jobRes.json();
        assert.equal(job.status, "pending");

        // Start render job via API
        const startRes = await fetch(`${baseUrl}/api/renders/${job.id}/start`, {
          method: "POST",
          headers: { Cookie: session.cookie },
        });
        assert.equal(startRes.status, 200);
        const startBody = await startRes.json();
        assert.equal(startBody.job.status, "completed");
        assert.ok(startBody.job.output_video_path);
        assert.equal(startBody.job.verification.width, 640);
        assert.equal(startBody.job.verification.height, 360);

        // Download rendered output video via API
        const outputRes = await fetch(`${baseUrl}/api/renders/${job.id}/output`, {
          headers: { Cookie: session.cookie },
        });
        assert.equal(outputRes.status, 200);
        assert.equal(outputRes.headers.get("content-type"), "video/mp4");
        const videoBuffer = Buffer.from(await outputRes.arrayBuffer());
        assert.ok(videoBuffer.length > 0);
      });
    });
  });
});
