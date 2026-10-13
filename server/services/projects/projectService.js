import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import * as projectQueries from "../../db/queries/projects.js";
import { resolveSafeStoragePath, validateStoragePath } from "../storage/storageSecurity.js";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  isValidUuid,
} from "../errors.js";

/**
 * Creates a new project owned by the authenticated user.
 */
export async function createProject({
  ownerId,
  title = "Untitled Project",
  currentRevision = 0,
  duration = 0,
  fps = 30,
  ratio = "16:9",
  archiveStoragePath = null,
  metadata = {},
}) {
  if (!isValidUuid(ownerId)) {
    throw new BadRequestError("Invalid user ID.", "INVALID_USER_ID");
  }

  const cleanTitle = typeof title === "string" ? title.trim() : "";
  if (!cleanTitle || cleanTitle.length > 255) {
    throw new BadRequestError("Project title must be between 1 and 255 characters.", "INVALID_TITLE");
  }

  const numFps = Number.parseInt(fps, 10);
  if (Number.isNaN(numFps) || numFps < 1 || numFps > 120) {
    throw new BadRequestError("Project fps must be between 1 and 120.", "INVALID_FPS");
  }

  const numDuration = Number(duration);
  if (Number.isNaN(numDuration) || numDuration < 0) {
    throw new BadRequestError("Project duration must be non-negative.", "INVALID_DURATION");
  }

  const cleanRatio = typeof ratio === "string" ? ratio.trim() : "16:9";
  if (!cleanRatio || cleanRatio.length > 16) {
    throw new BadRequestError("Project ratio must be between 1 and 16 characters.", "INVALID_RATIO");
  }

  if (archiveStoragePath) {
    validateStoragePath(archiveStoragePath);
  }

  const project = await projectQueries.createProject({
    ownerId,
    title: cleanTitle,
    currentRevision: Number.parseInt(currentRevision, 10) || 0,
    duration: numDuration,
    fps: numFps,
    ratio: cleanRatio,
    archiveStoragePath: archiveStoragePath ? String(archiveStoragePath).trim() : null,
    metadata: typeof metadata === "object" && metadata !== null ? metadata : {},
  });

  return project;
}

/**
 * Fetches a single project by ID with strict ownership validation.
 */
export async function getProject({ projectId, userId }) {
  if (!isValidUuid(projectId)) {
    throw new BadRequestError("Invalid project ID.", "INVALID_PROJECT_ID");
  }

  const project = await projectQueries.getProjectById(projectId);
  if (!project) {
    throw new NotFoundError("Project not found.", "PROJECT_NOT_FOUND");
  }

  if (project.owner_id !== userId) {
    throw new ForbiddenError("You do not have permission to access this project.", "FORBIDDEN");
  }

  return project;
}

/**
 * Lists all projects owned by the specified user with pagination.
 */
export async function listProjects({ userId, limit = 50, offset = 0, search = null }) {
  if (!isValidUuid(userId)) {
    throw new BadRequestError("Invalid user ID.", "INVALID_USER_ID");
  }

  const parsedLimit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 50));
  const parsedOffset = Math.max(0, Number.parseInt(offset, 10) || 0);
  const cleanSearch = typeof search === "string" ? search.trim().slice(0, 100) : null;

  return projectQueries.listProjectsByOwner(userId, {
    limit: parsedLimit,
    offset: parsedOffset,
    search: cleanSearch,
  });
}

/**
 * Updates project metadata after verifying ownership.
 */
export async function updateProject({ projectId, userId, updates = {} }) {
  const existing = await getProject({ projectId, userId });

  const sanitized = {};

  if (updates.title !== undefined) {
    const cleanTitle = typeof updates.title === "string" ? updates.title.trim() : "";
    if (!cleanTitle || cleanTitle.length > 255) {
      throw new BadRequestError("Project title must be between 1 and 255 characters.", "INVALID_TITLE");
    }
    sanitized.title = cleanTitle;
  }

  if (updates.fps !== undefined) {
    const numFps = Number.parseInt(updates.fps, 10);
    if (Number.isNaN(numFps) || numFps < 1 || numFps > 120) {
      throw new BadRequestError("Project fps must be between 1 and 120.", "INVALID_FPS");
    }
    sanitized.fps = numFps;
  }

  if (updates.duration !== undefined) {
    const numDuration = Number(updates.duration);
    if (Number.isNaN(numDuration) || numDuration < 0) {
      throw new BadRequestError("Project duration must be non-negative.", "INVALID_DURATION");
    }
    sanitized.duration = numDuration;
  }

  if (updates.ratio !== undefined) {
    const cleanRatio = typeof updates.ratio === "string" ? updates.ratio.trim() : "";
    if (!cleanRatio || cleanRatio.length > 16) {
      throw new BadRequestError("Project ratio must be between 1 and 16 characters.", "INVALID_RATIO");
    }
    sanitized.ratio = cleanRatio;
  }

  if (updates.current_revision !== undefined || updates.currentRevision !== undefined) {
    const rev = Number.parseInt(updates.current_revision ?? updates.currentRevision, 10);
    if (Number.isNaN(rev) || rev < 0) {
      throw new BadRequestError("Revision must be a non-negative integer.", "INVALID_REVISION");
    }
    sanitized.current_revision = rev;
  }

  if (updates.archive_storage_path !== undefined || updates.archiveStoragePath !== undefined) {
    const pathVal = updates.archive_storage_path ?? updates.archiveStoragePath;
    if (pathVal) {
      validateStoragePath(pathVal);
    }
    sanitized.archive_storage_path = pathVal ? String(pathVal).trim() : null;
  }

  if (updates.metadata !== undefined) {
    if (typeof updates.metadata !== "object" || updates.metadata === null) {
      throw new BadRequestError("Project metadata must be an object.", "INVALID_METADATA");
    }
    sanitized.metadata = updates.metadata;
  }

  const updated = await projectQueries.updateProject(existing.id, sanitized);
  return updated;
}

/**
 * Deletes a project after verifying ownership.
 */
export async function deleteProject({ projectId, userId }) {
  await getProject({ projectId, userId });
  return projectQueries.deleteProject(projectId);
}

/**
 * Duplicates a project without sharing mutable state or corrupting media references.
 */
export async function duplicateProject({ projectId, userId, newTitle = null }) {
  const source = await getProject({ projectId, userId });

  const titleToUse = typeof newTitle === "string" && newTitle.trim()
    ? newTitle.trim().slice(0, 255)
    : `${source.title} (Copy)`.slice(0, 255);

  const sourceArchiveRelPath = source.archive_storage_path;

  // 1. Create the new project record in PostgreSQL
  const duplicated = await projectQueries.createProject({
    ownerId: userId,
    title: titleToUse,
    currentRevision: source.current_revision ? 1 : 0,
    duration: source.duration,
    fps: source.fps,
    ratio: source.ratio,
    archiveStoragePath: null,
    metadata: {
      ...(typeof source.metadata === "object" && source.metadata ? source.metadata : {}),
      duplicatedFrom: source.id,
    },
  });

  // 2. If source project has an archive file, copy it safely to an independent file
  if (sourceArchiveRelPath) {
    try {
      const sourceAbsPath = resolveSafeStoragePath(sourceArchiveRelPath);
      if (existsSync(sourceAbsPath)) {
        const newArchiveRelPath = `storage/projects/${duplicated.id}-rev1.timeline`;
        const newAbsPath = resolveSafeStoragePath(newArchiveRelPath);
        await mkdir(dirname(newAbsPath), { recursive: true });
        await copyFile(sourceAbsPath, newAbsPath);

        // Create initial revision for the duplicate
        await projectQueries.createProjectVersion({
          projectId: duplicated.id,
          revision: 1,
          archiveStoragePath: newArchiveRelPath,
          duration: source.duration,
          changeSummary: `Duplicated from ${source.title}`,
          metadata: { duplicatedFromRevision: source.current_revision },
        });

        // Update duplicated project with the archive path
        await projectQueries.updateProject(duplicated.id, {
          archive_storage_path: newArchiveRelPath,
          current_revision: 1,
        });

        duplicated.archive_storage_path = newArchiveRelPath;
        duplicated.current_revision = 1;
      }
    } catch (copyErr) {
      console.warn("Failed to copy project archive on duplicate:", copyErr.message);
    }
  }

  return duplicated;
}

/**
 * Creates a historical project version snapshot.
 */
export async function createProjectVersion({
  projectId,
  userId,
  revision,
  archiveStoragePath,
  duration,
  changeSummary = null,
  metadata = {},
}) {
  const project = await getProject({ projectId, userId });

  if (!archiveStoragePath || typeof archiveStoragePath !== "string" || !archiveStoragePath.trim()) {
    throw new BadRequestError("Archive storage path is required.", "INVALID_STORAGE_PATH");
  }

  validateStoragePath(archiveStoragePath);

  const targetRevision = revision !== undefined
    ? Number.parseInt(revision, 10)
    : project.current_revision + 1;

  if (Number.isNaN(targetRevision) || targetRevision < 0) {
    throw new BadRequestError("Version revision must be a non-negative integer.", "INVALID_REVISION");
  }

  const targetDuration = duration !== undefined ? Number(duration) : project.duration;
  if (Number.isNaN(targetDuration) || targetDuration < 0) {
    throw new BadRequestError("Version duration must be non-negative.", "INVALID_DURATION");
  }

  const version = await projectQueries.createProjectVersion({
    projectId: project.id,
    revision: targetRevision,
    archiveStoragePath: archiveStoragePath.trim(),
    duration: targetDuration,
    changeSummary: changeSummary ? String(changeSummary).trim() : null,
    metadata: typeof metadata === "object" && metadata !== null ? metadata : {},
  });

  // Automatically update project current revision if this version is newer or equal
  if (targetRevision >= project.current_revision) {
    await projectQueries.updateProject(project.id, {
      current_revision: targetRevision,
      archive_storage_path: archiveStoragePath.trim(),
      duration: targetDuration,
    });
  }

  return version;
}

/**
 * Lists all versions for a project.
 */
export async function listProjectVersions({ projectId, userId, limit = 50, offset = 0 }) {
  const project = await getProject({ projectId, userId });
  const parsedLimit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 50));
  const parsedOffset = Math.max(0, Number.parseInt(offset, 10) || 0);

  return projectQueries.getProjectVersions(project.id, {
    limit: parsedLimit,
    offset: parsedOffset,
  });
}

/**
 * Retrieves a specific revision for a project.
 */
export async function getProjectVersion({ projectId, userId, revision }) {
  const project = await getProject({ projectId, userId });
  const revNum = Number.parseInt(revision, 10);
  if (Number.isNaN(revNum) || revNum < 0) {
    throw new BadRequestError("Revision must be a non-negative integer.", "INVALID_REVISION");
  }

  const version = await projectQueries.getProjectVersionByRevision(project.id, revNum);
  if (!version) {
    throw new NotFoundError(`Project version ${revNum} not found.`, "VERSION_NOT_FOUND");
  }

  return version;
}
