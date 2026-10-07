import { query as defaultQuery } from "../index.js";

export const RENDER_STATUS = Object.freeze({
  PENDING: "pending",
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

export async function createRenderJob({
  projectId,
  requestedRevision,
  settings = {},
}, executor = null) {
  const q = executor ? executor.query.bind(executor) : defaultQuery;
  const sql = `
    INSERT INTO render_jobs (
      project_id, requested_revision, status, settings
    )
    VALUES ($1, $2, 'pending', $3)
    RETURNING id, project_id, requested_revision, status, output_video_path, error_message, settings, verification, started_at, completed_at, created_at, updated_at;
  `;
  const result = await q(sql, [
    projectId,
    requestedRevision,
    JSON.stringify(settings),
  ]);
  return result.rows[0];
}

export async function getRenderJobById(id, executor = null) {
  const q = executor ? executor.query.bind(executor) : defaultQuery;
  const sql = `
    SELECT id, project_id, requested_revision, status, output_video_path, error_message, settings, verification, started_at, completed_at, created_at, updated_at
    FROM render_jobs
    WHERE id = $1;
  `;
  const result = await q(sql, [id]);
  return result.rows[0] || null;
}

export async function updateRenderJobStatus(id, {
  status,
  outputVideoPath = null,
  errorMessage = null,
  verification = null,
  startedAt = null,
  completedAt = null,
}, executor = null) {
  const q = executor ? executor.query.bind(executor) : defaultQuery;
  const setClauses = ["status = $2", "updated_at = NOW()"];
  const values = [id, status];
  let paramIndex = 3;

  if (outputVideoPath !== undefined) {
    setClauses.push(`output_video_path = $${paramIndex}`);
    values.push(outputVideoPath);
    paramIndex += 1;
  }
  if (errorMessage !== undefined) {
    setClauses.push(`error_message = $${paramIndex}`);
    values.push(errorMessage);
    paramIndex += 1;
  }
  if (verification !== undefined) {
    setClauses.push(`verification = $${paramIndex}`);
    values.push(verification ? JSON.stringify(verification) : "{}");
    paramIndex += 1;
  }
  if (startedAt !== undefined) {
    setClauses.push(`started_at = $${paramIndex}`);
    values.push(startedAt);
    paramIndex += 1;
  }
  if (completedAt !== undefined) {
    setClauses.push(`completed_at = $${paramIndex}`);
    values.push(completedAt);
  }

  const sql = `
    UPDATE render_jobs
    SET ${setClauses.join(", ")}
    WHERE id = $1
    RETURNING id, project_id, requested_revision, status, output_video_path, error_message, settings, verification, started_at, completed_at, created_at, updated_at;
  `;
  const result = await q(sql, values);
  return result.rows[0] || null;
}

export async function listRenderJobsByProject(projectId, { limit = 50, offset = 0 } = {}, executor = null) {
  const q = executor ? executor.query.bind(executor) : defaultQuery;
  const sql = `
    SELECT id, project_id, requested_revision, status, output_video_path, error_message, settings, verification, started_at, completed_at, created_at, updated_at
    FROM render_jobs
    WHERE project_id = $1
    ORDER BY created_at DESC
    LIMIT $2 OFFSET $3;
  `;
  const result = await q(sql, [projectId, limit, offset]);
  return result.rows;
}

export async function listRenderJobsByOwner(ownerId, { limit = 50, offset = 0 } = {}, executor = null) {
  const q = executor ? executor.query.bind(executor) : defaultQuery;
  const sql = `
    SELECT r.id, r.project_id, r.requested_revision, r.status, r.output_video_path, r.error_message, r.settings, r.verification, r.started_at, r.completed_at, r.created_at, r.updated_at
    FROM render_jobs r
    JOIN projects p ON r.project_id = p.id
    WHERE p.owner_id = $1
    ORDER BY r.created_at DESC
    LIMIT $2 OFFSET $3;
  `;
  const result = await q(sql, [ownerId, limit, offset]);
  return result.rows;
}
