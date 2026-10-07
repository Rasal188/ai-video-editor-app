import * as assetQueries from "../../db/queries/assets.js";
import { getProject } from "../projects/projectService.js";
import { validateStoragePath } from "../storage/storageSecurity.js";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  isValidUuid,
} from "../errors.js";

/**
 * Registers an asset's metadata in PostgreSQL.
 */
export async function createAsset({
  ownerId,
  projectId = null,
  filename,
  mediaType,
  mimeType,
  storagePath,
  sizeBytes,
  sha256 = null,
  metadata = {},
}) {
  if (!isValidUuid(ownerId)) {
    throw new BadRequestError("Invalid owner ID.", "INVALID_OWNER_ID");
  }

  // If associated with a project, ensure the project exists and belongs to this user
  if (projectId) {
    await getProject({ projectId, userId: ownerId });
  }

  const cleanFilename = typeof filename === "string" ? filename.trim() : "";
  if (!cleanFilename || cleanFilename.length > 255) {
    throw new BadRequestError("Asset filename must be between 1 and 255 characters.", "INVALID_FILENAME");
  }

  const cleanMediaType = typeof mediaType === "string" ? mediaType.trim().toLowerCase() : "";
  if (!cleanMediaType || cleanMediaType.length > 32) {
    throw new BadRequestError("Asset mediaType is required.", "INVALID_MEDIA_TYPE");
  }

  const cleanMimeType = typeof mimeType === "string" ? mimeType.trim().toLowerCase() : "";
  if (!cleanMimeType || cleanMimeType.length > 128) {
    throw new BadRequestError("Asset mimeType is required.", "INVALID_MIME_TYPE");
  }

  const cleanStoragePath = typeof storagePath === "string" ? storagePath.trim() : "";
  if (!cleanStoragePath) {
    throw new BadRequestError("Asset storagePath is required.", "INVALID_STORAGE_PATH");
  }
  validateStoragePath(cleanStoragePath);

  const parsedSize = Number.parseInt(sizeBytes, 10);
  if (Number.isNaN(parsedSize) || parsedSize < 0) {
    throw new BadRequestError("Asset sizeBytes must be a non-negative integer.", "INVALID_SIZE");
  }

  const asset = await assetQueries.createAsset({
    ownerId,
    projectId: projectId || null,
    filename: cleanFilename,
    mediaType: cleanMediaType,
    mimeType: cleanMimeType,
    storagePath: cleanStoragePath,
    sizeBytes: parsedSize,
    sha256: sha256 ? String(sha256).trim() : null,
    metadata: typeof metadata === "object" && metadata !== null ? metadata : {},
  });

  return asset;
}

/**
 * Retrieves a single asset with strict ownership verification.
 */
export async function getAsset({ assetId, userId }) {
  if (!isValidUuid(assetId)) {
    throw new BadRequestError("Invalid asset ID.", "INVALID_ASSET_ID");
  }

  const asset = await assetQueries.getAssetById(assetId);
  if (!asset) {
    throw new NotFoundError("Asset not found.", "ASSET_NOT_FOUND");
  }

  if (asset.owner_id !== userId) {
    throw new ForbiddenError("You do not have permission to access this asset.", "FORBIDDEN");
  }

  return asset;
}

/**
 * Lists assets for a project or all assets owned by the user.
 */
export async function listAssets({ userId, projectId = null, limit = 50, offset = 0 }) {
  if (!isValidUuid(userId)) {
    throw new BadRequestError("Invalid user ID.", "INVALID_USER_ID");
  }

  if (projectId) {
    // Verifies project exists and belongs to user
    await getProject({ projectId, userId });
    return assetQueries.listAssetsByProject(projectId);
  }

  const parsedLimit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 50));
  const parsedOffset = Math.max(0, Number.parseInt(offset, 10) || 0);

  return assetQueries.listAssetsByOwner(userId, {
    limit: parsedLimit,
    offset: parsedOffset,
  });
}

/**
 * Deletes an asset after verifying ownership.
 */
export async function deleteAsset({ assetId, userId }) {
  await getAsset({ assetId, userId });
  return assetQueries.deleteAsset(assetId);
}
