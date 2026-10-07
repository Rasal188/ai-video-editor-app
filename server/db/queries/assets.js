import { query as defaultQuery } from "../index.js";

export async function createAsset({
  projectId = null,
  ownerId,
  filename,
  mediaType,
  mimeType,
  storagePath,
  sizeBytes,
  sha256 = null,
  metadata = {},
}, executor = null) {
  const q = executor ? executor.query.bind(executor) : defaultQuery;
  const sql = `
    INSERT INTO assets (
      project_id, owner_id, filename, media_type, mime_type, storage_path, size_bytes, sha256, metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING id, project_id, owner_id, filename, media_type, mime_type, storage_path, size_bytes, sha256, metadata, created_at, updated_at;
  `;
  const result = await q(sql, [
    projectId,
    ownerId,
    filename,
    mediaType,
    mimeType,
    storagePath,
    sizeBytes,
    sha256,
    JSON.stringify(metadata),
  ]);
  return result.rows[0];
}

export async function getAssetById(id, executor = null) {
  const q = executor ? executor.query.bind(executor) : defaultQuery;
  const sql = `
    SELECT id, project_id, owner_id, filename, media_type, mime_type, storage_path, size_bytes, sha256, metadata, created_at, updated_at
    FROM assets
    WHERE id = $1;
  `;
  const result = await q(sql, [id]);
  return result.rows[0] || null;
}

export async function listAssetsByProject(projectId, executor = null) {
  const q = executor ? executor.query.bind(executor) : defaultQuery;
  const sql = `
    SELECT id, project_id, owner_id, filename, media_type, mime_type, storage_path, size_bytes, sha256, metadata, created_at, updated_at
    FROM assets
    WHERE project_id = $1
    ORDER BY created_at DESC;
  `;
  const result = await q(sql, [projectId]);
  return result.rows;
}

export async function listAssetsByOwner(ownerId, { limit = 50, offset = 0 } = {}, executor = null) {
  const q = executor ? executor.query.bind(executor) : defaultQuery;
  const sql = `
    SELECT id, project_id, owner_id, filename, media_type, mime_type, storage_path, size_bytes, sha256, metadata, created_at, updated_at
    FROM assets
    WHERE owner_id = $1
    ORDER BY created_at DESC
    LIMIT $2 OFFSET $3;
  `;
  const result = await q(sql, [ownerId, limit, offset]);
  return result.rows;
}

export async function deleteAsset(id, executor = null) {
  const q = executor ? executor.query.bind(executor) : defaultQuery;
  const sql = `
    DELETE FROM assets
    WHERE id = $1
    RETURNING id;
  `;
  const result = await q(sql, [id]);
  return Boolean(result.rowCount);
}
