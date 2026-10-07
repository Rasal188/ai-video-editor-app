import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestPool, setPool, closePool } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import * as userQueries from "../db/queries/users.js";
import * as projectQueries from "../db/queries/projects.js";
import * as assetQueries from "../db/queries/assets.js";
import * as renderJobQueries from "../db/queries/renderJobs.js";

describe("Database Schema CRUD & Constraint Validation", () => {
  let pool;

  beforeEach(async () => {
    pool = await createTestPool();
    setPool(pool);
    await runMigrations(pool, { silent: true });
  });

  afterEach(async () => {
    await closePool();
  });

  describe("Users Table", () => {
    it("should create and retrieve users", async () => {
      const user = await userQueries.createUser({
        email: "test@example.com",
        name: "Test Editor",
      });

      assert.ok(user.id);
      assert.equal(user.email, "test@example.com");
      assert.equal(user.name, "Test Editor");

      const fetched = await userQueries.getUserById(user.id);
      assert.equal(fetched.id, user.id);
      assert.equal(fetched.email, "test@example.com");

      const fetchedByEmail = await userQueries.getUserByEmail("TEST@example.com");
      assert.equal(fetchedByEmail.id, user.id);
    });

    it("should enforce email uniqueness", async () => {
      await userQueries.createUser({ email: "unique@example.com", name: "User 1" });

      await assert.rejects(
        () => userQueries.createUser({ email: "unique@example.com", name: "User 2" }),
        /unique/i
      );
    });
  });

  describe("Projects & Project Versions", () => {
    it("should create a project and manage version snapshots", async () => {
      const user = await userQueries.createUser({ email: "proj-owner@example.com", name: "Project Owner" });

      const project = await projectQueries.createProject({
        ownerId: user.id,
        title: "Commercial Cut",
        duration: 15.5,
        ratio: "16:9",
        fps: 30,
        archiveStoragePath: "storage/projects/commercial.timeline",
        metadata: { visualClips: 2 },
      });

      assert.ok(project.id);
      assert.equal(project.title, "Commercial Cut");
      assert.equal(project.duration, 15.5);
      assert.equal(project.current_revision, 0);

      // Create version snapshot for revision 0
      const v0 = await projectQueries.createProjectVersion({
        projectId: project.id,
        revision: 0,
        archiveStoragePath: "storage/projects/commercial-v0.timeline",
        duration: 15.5,
        changeSummary: "Initial project archive",
      });
      assert.equal(v0.revision, 0);

      // Update project to revision 1
      const updated = await projectQueries.updateProject(project.id, {
        current_revision: 1,
        duration: 12.0,
        title: "Commercial Cut - Trimmed",
      });
      assert.equal(updated.current_revision, 1);
      assert.equal(updated.duration, 12.0);

      // Create version snapshot for revision 1
      const v1 = await projectQueries.createProjectVersion({
        projectId: project.id,
        revision: 1,
        archiveStoragePath: "storage/projects/commercial-v1.timeline",
        duration: 12.0,
        changeSummary: "Trimmed head by 3.5s",
      });
      assert.equal(v1.revision, 1);

      // Fetch versions
      const versions = await projectQueries.getProjectVersions(project.id);
      assert.equal(versions.length, 2);
      assert.equal(versions[0].revision, 1); // latest first
      assert.equal(versions[1].revision, 0);
    });

    it("should reject duplicate project revisions", async () => {
      const user = await userQueries.createUser({ email: "rev-test@example.com", name: "Rev User" });
      const project = await projectQueries.createProject({ ownerId: user.id, title: "Revision Test" });

      await projectQueries.createProjectVersion({
        projectId: project.id,
        revision: 1,
        archiveStoragePath: "path1",
      });

      await assert.rejects(
        () => projectQueries.createProjectVersion({
          projectId: project.id,
          revision: 1,
          archiveStoragePath: "path2",
        }),
        /unique/i
      );
    });
  });

  describe("Assets Table", () => {
    it("should create and query media assets", async () => {
      const user = await userQueries.createUser({ email: "asset-owner@example.com", name: "Asset Owner" });
      const project = await projectQueries.createProject({ ownerId: user.id, title: "Asset Project" });

      const asset = await assetQueries.createAsset({
        projectId: project.id,
        ownerId: user.id,
        filename: "b-roll.mp4",
        mediaType: "video",
        mimeType: "video/mp4",
        storagePath: "storage/assets/b-roll.mp4",
        sizeBytes: 15000000,
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        metadata: { width: 1920, height: 1080, duration: 10.0 },
      });

      assert.ok(asset.id);
      assert.equal(asset.filename, "b-roll.mp4");
      assert.equal(asset.media_type, "video");

      const assets = await assetQueries.listAssetsByProject(project.id);
      assert.equal(assets.length, 1);
      assert.equal(assets[0].id, asset.id);
    });
  });

  describe("Render Jobs Table", () => {
    it("should manage render job lifecycle and enforce status check constraint", async () => {
      const user = await userQueries.createUser({ email: "render-user@example.com", name: "Render User" });
      const project = await projectQueries.createProject({ ownerId: user.id, title: "Render Project" });

      const job = await renderJobQueries.createRenderJob({
        projectId: project.id,
        requestedRevision: 1,
        settings: { width: 1280, height: 720, frameRate: 30 },
      });

      assert.ok(job.id);
      assert.equal(job.status, "pending");

      // Transition to processing
      const processing = await renderJobQueries.updateRenderJobStatus(job.id, {
        status: "processing",
        startedAt: new Date().toISOString(),
      });
      assert.equal(processing.status, "processing");

      // Transition to completed
      const completed = await renderJobQueries.updateRenderJobStatus(job.id, {
        status: "completed",
        outputVideoPath: "storage/renders/output-123.mp4",
        verification: { width: 1280, height: 720, duration: 5.0 },
        completedAt: new Date().toISOString(),
      });
      assert.equal(completed.status, "completed");
      assert.equal(completed.output_video_path, "storage/renders/output-123.mp4");

      // Rejects invalid status outside allowed check constraint
      await assert.rejects(
        () => renderJobQueries.updateRenderJobStatus(job.id, { status: "invalid_status" }),
        /check/i
      );
    });
  });

  describe("Cascading Behavior", () => {
    it("should cascade project deletion to versions, assets, and render jobs", async () => {
      const user = await userQueries.createUser({ email: "cascade@example.com", name: "Cascade User" });
      const project = await projectQueries.createProject({ ownerId: user.id, title: "Doomed Project" });

      await projectQueries.createProjectVersion({
        projectId: project.id,
        revision: 0,
        archiveStoragePath: "storage/v0.timeline",
      });

      await assetQueries.createAsset({
        projectId: project.id,
        ownerId: user.id,
        filename: "clip.mp4",
        mediaType: "video",
        mimeType: "video/mp4",
        storagePath: "storage/clip.mp4",
        sizeBytes: 1000,
      });

      await renderJobQueries.createRenderJob({
        projectId: project.id,
        requestedRevision: 0,
      });

      // Delete project
      const deleted = await projectQueries.deleteProject(project.id);
      assert.equal(deleted, true);

      // Verify cascading removal
      const versions = await projectQueries.getProjectVersions(project.id);
      assert.equal(versions.length, 0);

      const assets = await assetQueries.listAssetsByProject(project.id);
      assert.equal(assets.length, 0);

      const jobs = await renderJobQueries.listRenderJobsByProject(project.id);
      assert.equal(jobs.length, 0);

      // User should still exist (not deleted)
      const userStillExists = await userQueries.getUserById(user.id);
      assert.ok(userStillExists);
    });

    it("should restrict user deletion if user owns projects", async () => {
      const user = await userQueries.createUser({ email: "restrict@example.com", name: "Owner User" });
      await projectQueries.createProject({ ownerId: user.id, title: "Protected Project" });

      // Deleting user must fail due to ON DELETE RESTRICT on projects.owner_id
      await assert.rejects(
        () => userQueries.deleteUser(user.id),
        /foreign key|restrict/i
      );
    });
  });
});
