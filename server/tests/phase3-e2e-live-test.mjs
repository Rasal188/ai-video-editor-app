import fs from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { config } from "../config.js";
import { generateSessionToken, hashSessionToken } from "../services/auth/crypto.js";

async function runPhase3LiveVerification() {
  console.log("=================================================");
  console.log("   PHASE 3 END-TO-END LIVE INTEGRATION TEST      ");
  console.log("=================================================\n");

  const pool = new pg.Pool({ connectionString: config.db.url });
  const baseUrl = "http://localhost:3001";

  try {
    // -------------------------------------------------------------------------
    // Step 1: User authentication & session verification
    // -------------------------------------------------------------------------
    console.log("Step 1: Authenticating user and establishing session...");
    const userRes = await pool.query(
      `INSERT INTO users (email, name)
       VALUES ('phase3.creator@example.com', 'Phase3 Creator')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, email, name;`
    );
    const user = userRes.rows[0];

    const rawToken = generateSessionToken();
    const tokenHash = hashSessionToken(rawToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await pool.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3);`,
      [user.id, tokenHash, expiresAt]
    );

    const sessionCookie = `${config.auth.sessionCookieName}=${rawToken}`;

    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: sessionCookie },
    });
    if (!meRes.ok) throw new Error(`GET /api/auth/me failed with status ${meRes.status}`);
    const meData = await meRes.json();
    console.log(`✓ User authenticated as: ${meData.user.email} (ID: ${meData.user.id})\n`);

    // -------------------------------------------------------------------------
    // Step 2 & 3: Create project and save archive to backend
    // -------------------------------------------------------------------------
    console.log("Step 2 & 3: Creating project in PostgreSQL and uploading .timeline archive...");
    const createProjectRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify({
        title: "Phase 3 Showcase Video",
        fps: 30,
        duration: 10.5,
        ratio: "16:9",
        metadata: { phase: 3, engine: "TimelineStudio" },
      }),
    });
    if (!createProjectRes.ok) throw new Error(`POST /api/projects failed: ${createProjectRes.statusText}`);
    const { project } = await createProjectRes.json();
    console.log(`✓ Project metadata created in PostgreSQL: ID=${project.id}, Rev=${project.current_revision}`);

    // Load actual .timeline test archive
    const sampleArchivePath = resolve(process.cwd(), "storage/projects/project-trimmed.timeline");
    if (!fs.existsSync(sampleArchivePath)) {
      throw new Error(`Test archive not found at ${sampleArchivePath}`);
    }
    const archiveBuffer = fs.readFileSync(sampleArchivePath);

    const uploadArchiveRes = await fetch(
      `${baseUrl}/api/projects/${project.id}/archive?duration=10.5&changeSummary=Initial+cut`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream", Cookie: sessionCookie },
        body: archiveBuffer,
      }
    );
    if (!uploadArchiveRes.ok) throw new Error(`PUT /api/projects/:id/archive failed: ${uploadArchiveRes.statusText}`);
    const uploadData = await uploadArchiveRes.json();
    console.log(`✓ Archive stored to disk outside PostgreSQL: ${uploadData.project.archive_storage_path}`);
    console.log(`✓ Project revision incremented to: ${uploadData.project.current_revision}\n`);

    // -------------------------------------------------------------------------
    // Step 4: Verify records in PostgreSQL
    // -------------------------------------------------------------------------
    console.log("Step 4: Directly verifying PostgreSQL persistence...");
    const dbProject = await pool.query("SELECT * FROM projects WHERE id = $1;", [project.id]);
    const dbVersions = await pool.query("SELECT * FROM project_versions WHERE project_id = $1;", [project.id]);
    if (dbProject.rows.length === 0) throw new Error("Project not found in PostgreSQL!");
    if (dbVersions.rows.length === 0) throw new Error("Project version not found in PostgreSQL!");
    console.log(`✓ PostgreSQL projects table verified (1 record, current_revision=${dbProject.rows[0].current_revision})`);
    console.log(`✓ PostgreSQL project_versions table verified (${dbVersions.rows.length} versions recorded)\n`);

    // -------------------------------------------------------------------------
    // Step 5: Logout (session invalidation)
    // -------------------------------------------------------------------------
    console.log("Step 5: Logging out and invalidating session...");
    const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { Cookie: sessionCookie },
    });
    if (!logoutRes.ok) throw new Error("Logout failed");

    const meAfterLogout = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: sessionCookie },
    });
    if (meAfterLogout.status !== 401) throw new Error("Session was not invalidated after logout!");
    console.log(`✓ Session successfully invalidated. /api/auth/me returned 401 Unauthorized.\n`);

    // -------------------------------------------------------------------------
    // Step 6: Login again
    // -------------------------------------------------------------------------
    console.log("Step 6: Logging in again as user...");
    const rawToken2 = generateSessionToken();
    const tokenHash2 = hashSessionToken(rawToken2);
    await pool.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3);`,
      [user.id, tokenHash2, expiresAt]
    );
    const sessionCookie2 = `${config.auth.sessionCookieName}=${rawToken2}`;

    const meRes2 = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: sessionCookie2 },
    });
    if (!meRes2.ok) throw new Error("Second login session failed");
    console.log(`✓ User re-authenticated with new session cookie.\n`);

    // -------------------------------------------------------------------------
    // Step 7: Load the saved project from cloud
    // -------------------------------------------------------------------------
    console.log("Step 7: Retrieving saved project and downloading archive...");
    const getProjectRes = await fetch(`${baseUrl}/api/projects/${project.id}`, {
      headers: { Cookie: sessionCookie2 },
    });
    if (!getProjectRes.ok) throw new Error("Failed to retrieve project");
    const retrieved = await getProjectRes.json();
    console.log(`✓ Project metadata loaded: "${retrieved.project.title}" (Rev ${retrieved.project.current_revision})`);

    const downloadArchiveRes = await fetch(`${baseUrl}/api/projects/${project.id}/archive`, {
      headers: { Cookie: sessionCookie2 },
    });
    if (!downloadArchiveRes.ok) throw new Error("Failed to download project archive");
    const downloadedBytes = Buffer.from(await downloadArchiveRes.arrayBuffer());
    if (downloadedBytes.length !== archiveBuffer.length) {
      throw new Error(`Downloaded archive size mismatch: ${downloadedBytes.length} vs ${archiveBuffer.length}`);
    }
    console.log(`✓ .timeline archive downloaded successfully (${downloadedBytes.length} bytes verified)\n`);

    // -------------------------------------------------------------------------
    // Step 8 & 9: Make an edit and save Revision 2
    // -------------------------------------------------------------------------
    console.log("Step 8 & 9: Making edits and saving Revision 2...");
    const patchRes = await fetch(`${baseUrl}/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie2 },
      body: JSON.stringify({ title: "Phase 3 Showcase Video (Revised)", duration: 12.0 }),
    });
    if (!patchRes.ok) throw new Error("PATCH /api/projects/:id failed");

    const uploadRev2Res = await fetch(
      `${baseUrl}/api/projects/${project.id}/archive?duration=12.0&changeSummary=Added+transitions+and+grading`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream", Cookie: sessionCookie2 },
        body: archiveBuffer,
      }
    );
    if (!uploadRev2Res.ok) throw new Error("PUT archive rev 2 failed");
    const rev2Data = await uploadRev2Res.json();
    console.log(`✓ Project updated to Revision ${rev2Data.project.current_revision}`);
    console.log(`✓ Version 2 snapshot created with change summary: "${rev2Data.version.change_summary}"\n`);

    // -------------------------------------------------------------------------
    // Step 10: Start a backend render job
    // -------------------------------------------------------------------------
    console.log("Step 10: Dispatching backend headless render job (CLI + FFmpeg)...");
    const createRenderRes = await fetch(`${baseUrl}/api/renders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie2 },
      body: JSON.stringify({
        projectId: project.id,
        requestedRevision: rev2Data.project.current_revision,
        settings: { resolution: "360p", format: "mp4" },
      }),
    });
    if (!createRenderRes.ok) throw new Error("Failed to create render job");
    const { job } = await createRenderRes.json();
    console.log(`✓ Render job created in PostgreSQL: ID=${job.id}, Status=${job.status}`);

    // Trigger execution
    console.log("Executing CLI project.render via timeline-command.mjs...");
    const startRenderRes = await fetch(`${baseUrl}/api/renders/${job.id}/start`, {
      method: "POST",
      headers: { Cookie: sessionCookie2 },
    });
    if (!startRenderRes.ok) throw new Error(`Render start failed: ${startRenderRes.statusText}`);
    const startData = await startRenderRes.json();
    const completedJob = startData.job;

    // -------------------------------------------------------------------------
    // Step 11, 12, 13: Verify CLI/FFmpeg execution & FFprobe verification
    // -------------------------------------------------------------------------
    console.log("Step 11, 12 & 13: Verifying completed status and FFprobe verification metadata...");
    if (completedJob.status !== "completed") {
      throw new Error(`Render job failed with status: ${completedJob.status}, error: ${completedJob.error_message}`);
    }
    console.log(`✓ PostgreSQL status = ${completedJob.status}`);
    console.log(`✓ FFprobe Verification:`);
    console.log(`   - Resolution: ${completedJob.verification.width} x ${completedJob.verification.height}`);
    console.log(`   - Duration: ${completedJob.verification.duration}s`);
    console.log(`   - Video Codec: ${completedJob.verification.videoCodec}`);
    console.log(`   - Audio Codec: ${completedJob.verification.audioCodec || "None"}`);
    console.log(`   - Format: ${completedJob.verification.formatName}\n`);

    // -------------------------------------------------------------------------
    // Step 14: Verify output video file exists and can be downloaded
    // -------------------------------------------------------------------------
    console.log("Step 14: Verifying render output download via /api/renders/:id/output...");
    const downloadOutputRes = await fetch(`${baseUrl}/api/renders/${completedJob.id}/output`, {
      headers: { Cookie: sessionCookie2 },
    });
    if (!downloadOutputRes.ok) throw new Error(`Download output failed: ${downloadOutputRes.statusText}`);
    const outputBuffer = Buffer.from(await downloadOutputRes.arrayBuffer());
    if (outputBuffer.length === 0) throw new Error("Rendered output file is empty!");
    console.log(`✓ Rendered MP4 received (${outputBuffer.length} bytes, Content-Type: ${downloadOutputRes.headers.get("content-type")})`);

    console.log("\n=================================================");
    console.log("   ALL 14 PHASE 3 END-TO-END STEPS PASSED!       ");
    console.log("=================================================");
  } finally {
    await pool.end();
  }
}

runPhase3LiveVerification().catch((err) => {
  console.error("\n❌ E2E Verification Failed:", err);
  process.exit(1);
});
