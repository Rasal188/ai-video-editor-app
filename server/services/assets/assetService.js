import { createHash, randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import * as assetQueries from "../../db/queries/assets.js";
import { getProject } from "../projects/projectService.js";
import {
  resolveSafeStoragePath,
  validateStoragePath,
} from "../storage/storageSecurity.js";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  isValidUuid,
} from "../errors.js";

const TEMPLATE_IMAGE_TYPES = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
});

function safeUploadFilename(value = "") {
  let decoded = String(value || "").trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Preserve the original header when it is not URI encoded.
  }
  const basename = decoded.split(/[/\\]/).pop() || "template-image";
  return basename.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255) || "template-image";
}

function assertSafeSvg(buffer) {
  const svg = buffer.toString("utf8");
  if (!/<svg\b/i.test(svg)) {
    throw new BadRequestError("SVG uploads must contain an <svg> root element.", "INVALID_SVG");
  }
  const forbidden = [
    /<!doctype/i,
    /<!entity/i,
    /<\?xml-stylesheet/i,
    /<(script|foreignObject|iframe|object|embed|link|style)\b/i,
    /\son[a-z]+\s*=/i,
    /(?:href|xlink:href)\s*=\s*["']\s*(?!#)[^"']+/i,
    /url\(\s*["']?\s*(?:https?:|data:|javascript:)/i,
  ];
  if (forbidden.some((pattern) => pattern.test(svg))) {
    throw new BadRequestError(
      "SVG contains unsupported active or external content.",
      "UNSAFE_SVG"
    );
  }
}

function assertImageSignature(buffer, mimeType) {
  const valid = mimeType === "image/png"
    ? buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mimeType === "image/jpeg"
      ? buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
      : mimeType === "image/webp"
        ? buffer.length >= 12
        && buffer.toString("ascii", 0, 4) === "RIFF"
        && buffer.toString("ascii", 8, 12) === "WEBP"
        : true;
  if (!valid) {
    throw new BadRequestError(
      "Uploaded image content does not match its declared type.",
      "INVALID_IMAGE_SIGNATURE"
    );
  }
}

function imageDimension(value) {
  return Math.max(1, Math.min(20000, Number.parseInt(value, 10) || 1));
}

/**
 * Stores an owner-scoped Overlay Template Studio image and registers its metadata.
 */
export async function createUploadedTemplateImage({
  ownerId,
  filename,
  mimeType,
  bytes,
  width = 1,
  height = 1,
}) {
  if (!isValidUuid(ownerId)) {
    throw new BadRequestError("Invalid owner ID.", "INVALID_OWNER_ID");
  }
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new BadRequestError("Image upload must contain binary data.", "INVALID_ASSET_CONTENT");
  }

  const normalizedMimeType = String(mimeType || "").trim().toLowerCase().split(";", 1)[0];
  const extension = TEMPLATE_IMAGE_TYPES[normalizedMimeType];
  if (!extension) {
    throw new BadRequestError(
      "Only PNG, JPEG, WebP, and safe SVG images are supported.",
      "UNSUPPORTED_ASSET_TYPE"
    );
  }
  if (normalizedMimeType === "image/svg+xml") {
    assertSafeSvg(bytes);
  } else {
    assertImageSignature(bytes, normalizedMimeType);
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const storagePath = `assets/${ownerId}/${sha256}-${randomUUID()}.${extension}`;
  const absolutePath = resolveSafeStoragePath(storagePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, bytes);

  try {
    return await createAsset({
      ownerId,
      filename: safeUploadFilename(filename),
      mediaType: "image",
      mimeType: normalizedMimeType,
      storagePath,
      sizeBytes: bytes.length,
      sha256,
      metadata: {
        scope: "overlay-template",
        width: imageDimension(width),
        height: imageDimension(height),
      },
    });
  } catch (error) {
    await unlink(absolutePath).catch(() => null);
    throw error;
  }
}

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
 * Resolves owner-authorized asset content on disk.
 */
export async function getAssetContent({ assetId, userId }) {
  const asset = await getAsset({ assetId, userId });
  return {
    asset,
    absolutePath: resolveSafeStoragePath(asset.storage_path),
  };
}

/**
 * Deletes an asset after verifying ownership.
 */
export async function deleteAsset({ assetId, userId }) {
  const asset = await getAsset({ assetId, userId });
  const deleted = await assetQueries.deleteAsset(assetId);
  if (deleted && asset.metadata?.scope === "overlay-template") {
    const absolutePath = resolveSafeStoragePath(asset.storage_path);
    await unlink(absolutePath).catch(() => null);
  }
  return deleted;
}
