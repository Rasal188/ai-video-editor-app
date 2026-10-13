import express, { Router } from "express";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "../config.js";
import { requireAuth } from "../middleware/auth.js";
import { ApiError } from "../services/errors.js";
import { resolveSafeStoragePath } from "../services/storage/storageSecurity.js";
import * as projectService from "../services/projects/projectService.js";

const router = Router();

// Enforce authentication across all project operations
router.use(requireAuth);

/**
 * POST /api/projects
 * Creates a new project owned by the authenticated user.
 */
router.post("/", async (req, res, next) => {
  try {
    const project = await projectService.createProject({
      ownerId: req.user.id,
      ...(req.body || {}),
    });
    return res.status(201).json({
      ok: true,
      project,
    });
  } catch (err) {
    if (err instanceof ApiError) {
      return res.status(err.status).json({
        ok: false,
        code: err.code,
        message: err.message,
      });
    }
    next(err);
  }
});

/**
 * GET /api/projects
 * Lists all projects owned by the authenticated user.
 */
router.get("/", async (req, res, next) => {
  try {
    const { limit, offset, search } = req.query;
    const projects = await projectService.listProjects({
      userId: req.user.id,
      limit,
      offset,
      search,
    });
    return res.status(200).json({
      ok: true,
      projects,
    });
  } catch (err) {
    if (err instanceof ApiError) {
      return res.status(err.status).json({
        ok: false,
        code: err.code,
        message: err.message,
      });
    }
    next(err);
  }
});

/**
 * GET /api/projects/:id
 * Retrieves a single project owned by the user.
 */
router.get("/:id", async (req, res, next) => {
  try {
    const project = await projectService.getProject({
      projectId: req.params.id,
      userId: req.user.id,
    });
    return res.status(200).json({
      ok: true,
      project,
    });
  } catch (err) {
    if (err instanceof ApiError) {
      return res.status(err.status).json({
        ok: false,
        code: err.code,
        message: err.message,
      });
    }
    next(err);
  }
});

/**
 * PATCH /api/projects/:id
 * Updates project metadata after verifying ownership.
 */
router.patch("/:id", async (req, res, next) => {
  try {
    const project = await projectService.updateProject({
      projectId: req.params.id,
      userId: req.user.id,
      updates: req.body || {},
    });
    return res.status(200).json({
      ok: true,
      project,
    });
  } catch (err) {
    if (err instanceof ApiError) {
      return res.status(err.status).json({
        ok: false,
        code: err.code,
        message: err.message,
      });
    }
    next(err);
  }
});

/**
 * DELETE /api/projects/:id
 * Deletes a project and cascades removal to associated records.
 */
router.delete("/:id", async (req, res, next) => {
  try {
    await projectService.deleteProject({
      projectId: req.params.id,
      userId: req.user.id,
    });
    return res.status(200).json({
      ok: true,
      message: "Project deleted successfully.",
    });
  } catch (err) {
    if (err instanceof ApiError) {
      return res.status(err.status).json({
        ok: false,
        code: err.code,
        message: err.message,
      });
    }
    next(err);
  }
});

/**
 * POST /api/projects/:id/duplicate
 * Duplicates an existing project with an independent archive and revision history.
 */
router.post("/:id/duplicate", async (req, res, next) => {
  try {
    const project = await projectService.duplicateProject({
      projectId: req.params.id,
      userId: req.user.id,
      newTitle: req.body?.title,
    });
    return res.status(201).json({
      ok: true,
      project,
    });
  } catch (err) {
    if (err instanceof ApiError) {
      return res.status(err.status).json({
        ok: false,
        code: err.code,
        message: err.message,
      });
    }
    next(err);
  }
});

/**
 * POST /api/projects/:id/versions
 * Creates a historical revision snapshot for the project.
 */
router.post("/:id/versions", async (req, res, next) => {
  try {
    const version = await projectService.createProjectVersion({
      projectId: req.params.id,
      userId: req.user.id,
      ...(req.body || {}),
    });
    return res.status(201).json({
      ok: true,
      version,
    });
  } catch (err) {
    if (err instanceof ApiError) {
      return res.status(err.status).json({
        ok: false,
        code: err.code,
        message: err.message,
      });
    }
    next(err);
  }
});

/**
 * GET /api/projects/:id/versions
 * Lists all revisions for the specified project.
 */
router.get("/:id/versions", async (req, res, next) => {
  try {
    const { limit, offset } = req.query;
    const versions = await projectService.listProjectVersions({
      projectId: req.params.id,
      userId: req.user.id,
      limit,
      offset,
    });
    return res.status(200).json({
      ok: true,
      versions,
    });
  } catch (err) {
    if (err instanceof ApiError) {
      return res.status(err.status).json({
        ok: false,
        code: err.code,
        message: err.message,
      });
    }
    next(err);
  }
});

/**
 * GET /api/projects/:id/versions/:revision
 * Retrieves a specific historical revision for the project.
 */
router.get("/:id/versions/:revision", async (req, res, next) => {
  try {
    const version = await projectService.getProjectVersion({
      projectId: req.params.id,
      userId: req.user.id,
      revision: req.params.revision,
    });
    return res.status(200).json({
      ok: true,
      version,
    });
  } catch (err) {
    if (err instanceof ApiError) {
      return res.status(err.status).json({
        ok: false,
        code: err.code,
        message: err.message,
      });
    }
    next(err);
  }
});

/**
 * PUT /api/projects/:id/archive
 * Saves or updates a project's .timeline archive on the server.
 * Increments revision and registers a new project version snapshot in PostgreSQL.
 */
router.put(
  "/:id/archive",
  express.raw({ type: "*/*", limit: config.storage.maxUploadSizeBytes }),
  async (req, res, next) => {
    try {
      if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({
          ok: false,
          code: "INVALID_ARCHIVE",
          message: "Request body must contain non-empty archive binary data.",
        });
      }

      const project = await projectService.getProject({
        projectId: req.params.id,
        userId: req.user.id,
      });

      const nextRev = (project.current_revision || 0) + 1;
      const relativePath = `storage/projects/${project.id}-rev${nextRev}.timeline`;
      const absPath = resolveSafeStoragePath(relativePath);

      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, req.body);

      const duration = req.query.duration ? Number(req.query.duration) : project.duration;
      const changeSummary = req.query.changeSummary
        ? String(req.query.changeSummary).trim()
        : `Revision ${nextRev}`;

      const version = await projectService.createProjectVersion({
        projectId: project.id,
        userId: req.user.id,
        revision: nextRev,
        archiveStoragePath: relativePath,
        duration: Number.isNaN(duration) ? project.duration : duration,
        changeSummary,
      });

      const updatedProject = await projectService.getProject({
        projectId: project.id,
        userId: req.user.id,
      });

      return res.status(200).json({
        ok: true,
        project: updatedProject,
        version,
      });
    } catch (err) {
      if (err instanceof ApiError) {
        return res.status(err.status).json({
          ok: false,
          code: err.code,
          message: err.message,
        });
      }
      next(err);
    }
  }
);

/**
 * GET /api/projects/:id/archive
 * Streams the latest .timeline archive file for the project.
 */
router.get("/:id/archive", async (req, res, next) => {
  try {
    const project = await projectService.getProject({
      projectId: req.params.id,
      userId: req.user.id,
    });

    if (!project.archive_storage_path) {
      return res.status(404).json({
        ok: false,
        code: "ARCHIVE_NOT_FOUND",
        message: "No archive has been uploaded for this project yet.",
      });
    }

    const absPath = resolveSafeStoragePath(project.archive_storage_path);
    if (!existsSync(absPath)) {
      return res.status(404).json({
        ok: false,
        code: "ARCHIVE_FILE_MISSING",
        message: "The archive file was not found on disk.",
      });
    }

    const safeFilename = encodeURIComponent((project.title || "project").replace(/[^\w\s.-]/g, "_"));
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}.timeline"`);
    return res.sendFile(absPath);
  } catch (err) {
    if (err instanceof ApiError) {
      return res.status(err.status).json({
        ok: false,
        code: err.code,
        message: err.message,
      });
    }
    next(err);
  }
});

/**
 * GET /api/projects/:id/versions/:revision/archive
 * Streams the .timeline archive file for a specific project version.
 */
router.get("/:id/versions/:revision/archive", async (req, res, next) => {
  try {
    const version = await projectService.getProjectVersion({
      projectId: req.params.id,
      userId: req.user.id,
      revision: req.params.revision,
    });

    if (!version.archive_storage_path) {
      return res.status(404).json({
        ok: false,
        code: "ARCHIVE_NOT_FOUND",
        message: `No archive found for version ${req.params.revision}.`,
      });
    }

    const absPath = resolveSafeStoragePath(version.archive_storage_path);
    if (!existsSync(absPath)) {
      return res.status(404).json({
        ok: false,
        code: "ARCHIVE_FILE_MISSING",
        message: "The version archive file was not found on disk.",
      });
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${req.params.id}-rev${version.revision}.timeline"`
    );
    return res.sendFile(absPath);
  } catch (err) {
    if (err instanceof ApiError) {
      return res.status(err.status).json({
        ok: false,
        code: err.code,
        message: err.message,
      });
    }
    next(err);
  }
});

export default router;
