import { isAbsolute, normalize, resolve, sep } from "node:path";
import { config } from "../../config.js";
import { BadRequestError } from "../errors.js";

const WINDOWS_DRIVE_REGEX = /^[a-zA-Z]:/;

/**
 * Validates that a storage path is a relative path that strictly resolves
 * within the configured storage directory.
 * Prevents directory traversal, absolute paths, Windows drive paths, and null bytes.
 *
 * @param {string} inputPath - The storage path to validate
 * @returns {string} - The sanitized trimmed path
 */
export function validateStoragePath(inputPath) {
  if (typeof inputPath !== "string" || !inputPath.trim()) {
    throw new BadRequestError("Storage path is required.", "INVALID_STORAGE_PATH");
  }

  const trimmed = inputPath.trim();

  // Reject null bytes
  if (trimmed.includes("\0")) {
    throw new BadRequestError("Storage path contains invalid characters.", "INVALID_STORAGE_PATH");
  }

  // Reject absolute paths (POSIX or Windows)
  if (isAbsolute(trimmed) || trimmed.startsWith("/") || trimmed.startsWith("\\")) {
    throw new BadRequestError("Storage path must not be an absolute path.", "INVALID_STORAGE_PATH");
  }

  // Reject Windows drive paths (e.g., C: or D:\)
  if (WINDOWS_DRIVE_REGEX.test(trimmed)) {
    throw new BadRequestError("Storage path must not contain drive letters.", "INVALID_STORAGE_PATH");
  }

  // Reject path traversal segments (e.g. ..)
  const segments = trimmed.split(/[/\\]/);
  if (segments.includes("..")) {
    throw new BadRequestError("Storage path must not contain directory traversal segments.", "INVALID_STORAGE_PATH");
  }

  // Normalize storage root
  const storageRoot = resolve(config.storage.localDirectory);

  // If path starts with "storage/" or "storage\", resolve from process.cwd() or strip prefix
  let resolved;
  if (trimmed.startsWith("storage/") || trimmed.startsWith("storage\\")) {
    resolved = resolve(process.cwd(), trimmed);
  } else {
    resolved = resolve(storageRoot, trimmed);
  }

  // Check if resolved path is strictly inside storageRoot
  const normalizedResolved = normalize(resolved);
  const normalizedRoot = normalize(storageRoot);

  if (!normalizedResolved.startsWith(normalizedRoot + sep)) {
    throw new BadRequestError("Storage path must remain within the storage directory.", "INVALID_STORAGE_PATH");
  }

  return trimmed;
}

/**
 * Resolves an archive or asset path to an absolute filesystem path,
 * verifying that it resides safely inside the storage root.
 *
 * @param {string} inputPath
 * @returns {string}
 */
export function resolveSafeStoragePath(inputPath) {
  validateStoragePath(inputPath);
  const trimmed = inputPath.trim();
  const storageRoot = resolve(config.storage.localDirectory);

  let resolved;
  if (trimmed.startsWith("storage/") || trimmed.startsWith("storage\\")) {
    resolved = resolve(process.cwd(), trimmed);
  } else {
    resolved = resolve(storageRoot, trimmed);
  }

  return normalize(resolved);
}
