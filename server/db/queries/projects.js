import { query as defaultQuery } from "../index.js";

export async function createProject({
  ownerId,
  title = "Untitled Project",
  currentRevision = 0,
  duration = 0,
  fps = 30,
  ratio = "16:9",
  archiveStoragePath = null,
  metadata = {},
}, executor = null) {
  const q = executor ? executor.query.bind(executor) : defaultQuery;
  const sql = `
    INSERT INTO projects (
      owner_id, title, current_revision, duration, fps, ratio, archive_storage_path, metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id, owner_id, title, current_revision, duration, fps, ratio, archive_storage_path, metadata, created_at, updated_at;
  `;
  const result = await q(sql, [
    ownerId,
    title.trim(),
    currentRevision,
    duration,
    fps,
    ratio,
    archiveStoragePath,
    JSON.stringify(metadata),
  ]);
  return result.rows[0];
}

export async function getProjectById(id, executor = null) {
  const q = executor ? executor.query.bind(executor) : defaultQuery;
  const sql = `
    SELECT id, owner_id, title, current_revision, duration, fps, ratio, archive_storage_path, metadata, created_at, updated_at
    FROM projects
    WHERE id = $1;
  `;
  const result = await q(sql, [id]);
  return result.rows[0] || null;
}

export async function listProjectsByOwner(ownerId, { limit = 50, offset = 0, search = null } = {}, executor = null) {
  const q = executor ? executor.query.bind(executor) : defaultQuery;
  const values = [ownerId, limit, offset];
  let searchClause = "";

  if (typeof search === "string" && search.trim()) {
    values.push(`%${search.trim()}%`);
    searchClause = `AND title ILIKE $${values.length}`;
  }

  const sql = `
    SELECT id, owner_id, title, current_revision, duration, fps, ratio, archive_storage_path, metadata, created_at, updated_at
    FROM projects
    WHERE owner_id = $1 ${searchClause}
    ORDER BY updated_at DESC
    LIMIT $2 OFFSET $3;
  `;
  const result = await q(sql, values);
  return result.rows;
}

export async function updateProject(id, updates = {}, executor = null) {
  const q = executor ? executor.query.bind(executor) : defaultQuery;
  const allowed = [
    "title", "current_revision", "duration", "fps", "ratio",
    "archive_storage_path", "metadata",
  ];
  const setClauses = [];
  const values = [id];
  let paramIndex = 2;

  for (const [key, value] of Object.entries(updates)) {
    if (!allowed.includes(key)) continue;
    setClauses.push(`${key} = $${paramIndex}`);
    values.push(key === "metadata" ? JSON.stringify(value) : value);
    paramIndex += 1;
  }

  if (setClauses.length === 0) return getProjectById(id, executor);

  setClauses.push("updated_at = NOW()");

  const sql = `
    UPDATE projects
    SET ${setClauses.join(", ")}
    WHERE id = $1
    RETURNING id, owner_id, title, current_revision, duration, fps, ratio, archive_storage_path, metadata, created_at, updated_at;
  `;
  const result = await q(sql, values);
  return result.rows[0] || null;
}

export async function deleteProject(id, executor = null) {
  const q = executor ? executor.query.bind(executor) : defaultQuery;
  const sql = `
    DELETE FROM projects
    WHERE id = $1
    RETURNING id;
  `;
  const result = await q(sql, [id]);
  return Boolean(result.rowCount);
}

// --- Project Versions ---

export async function createProjectVersion({
  projectId,
  revision,
  archiveStoragePath,
  duration = 0,
  changeSummary = null,
  metadata = {},
}, executor = null) {
  const q = executor ? executor.query.bind(executor) : defaultQuery;
  const sql = `
    INSERT INTO project_versions (
      project_id, revision, archive_storage_path, duration, change_summary, metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, project_id, revision, archive_storage_path, duration, change_summary, metadata, created_at;
  `;
  const result = await q(sql, [
    projectId,
    revision,
    archiveStoragePath,
    duration,
    changeSummary,
    JSON.stringify(metadata),
  ]);
  return result.rows[0];
}

export async function getProjectVersions(projectId, { limit = 50, offset = 0 } = {}, executor = null) {
  const q = executor ? executor.query.bind(executor) : defaultQuery;
  const sql = `
    SELECT id, project_id, revision, archive_storage_path, duration, change_summary, metadata, created_at
    FROM project_versions
    WHERE project_id = $1
    ORDER BY revision DESC
    LIMIT $2 OFFSET $3;
  `;
  const result = await q(sql, [projectId, limit, offset]);
  return result.rows;
}

export async function getProjectVersionByRevision(projectId, revision, executor = null) {
  const q = executor ? executor.query.bind(executor) : defaultQuery;
  const sql = `
    SELECT id, project_id, revision, archive_storage_path, duration, change_summary, metadata, created_at
    FROM project_versions
    WHERE project_id = $1 AND revision = $2;
  `;
  const result = await q(sql, [projectId, revision]);
  return result.rows[0] || null;
}
