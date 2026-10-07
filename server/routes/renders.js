import { Router } from "express";
import { existsSync } from "node:fs";
import { normalize, resolve, sep } from "node:path";
import { config } from "../config.js";
import { requireAuth } from "../middleware/auth.js";
import { ApiError } from "../services/errors.js";
import * as renderService from "../services/render/renderService.js";

const router = Router();

// Enforce authentication across all render operations
router.use(requireAuth);

/**
 * POST /api/renders
 * Creates a render job for a project owned by the user.
 */
router.post("/", async (req, res, next) => {
  try {
    const { projectId, requestedRevision, settings, autoStart } = req.body || {};
    let job = await renderService.createRenderJob({
      projectId,
      userId: req.user.id,
      requestedRevision,
      settings,
    });

    // If autoStart requested, start execution asynchronously or synchronously
    if (autoStart === true || req.query.execute === "true") {
      job = await renderService.executeRenderJob({
        jobId: job.id,
        userId: req.user.id,
      });
    }

    return res.status(201).json({
      ok: true,
      job,
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
 * GET /api/renders
 * Lists render jobs for a specific project or all projects of the user.
 */
router.get("/", async (req, res, next) => {
  try {
    const { projectId, limit, offset } = req.query;
    const jobs = await renderService.listRenderJobs({
      userId: req.user.id,
      projectId,
      limit,
      offset,
    });
    return res.status(200).json({
      ok: true,
      jobs,
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
 * GET /api/renders/:id
 * Retrieves status and verification details for a render job.
 */
router.get("/:id", async (req, res, next) => {
  try {
    const job = await renderService.getRenderJob({
      jobId: req.params.id,
      userId: req.user.id,
    });
    return res.status(200).json({
      ok: true,
      job,
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
 * POST /api/renders/:id/start
 * Explicitly triggers headless CLI rendering for a pending job.
 */
router.post("/:id/start", async (req, res, next) => {
  try {
    const job = await renderService.executeRenderJob({
      jobId: req.params.id,
      userId: req.user.id,
    });
    return res.status(200).json({
      ok: true,
      job,
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
 * POST /api/renders/:id/cancel
 * Cancels a pending or processing render job.
 */
router.post("/:id/cancel", async (req, res, next) => {
  try {
    const job = await renderService.cancelRenderJob({
      jobId: req.params.id,
      userId: req.user.id,
    });
    return res.status(200).json({
      ok: true,
      job,
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
 * GET /api/renders/:id/output
 * Streams the rendered MP4 file for a completed job.
 */
router.get("/:id/output", async (req, res, next) => {
  try {
    const job = await renderService.getRenderJob({
      jobId: req.params.id,
      userId: req.user.id,
    });

    if (job.status !== "completed") {
      return res.status(400).json({
        ok: false,
        code: "RENDER_NOT_COMPLETED",
        message: `Cannot download output for job with status '${job.status}'.`,
      });
    }

    if (!job.output_video_path) {
      return res.status(404).json({
        ok: false,
        code: "OUTPUT_NOT_FOUND",
        message: "No output file recorded for this render job.",
      });
    }

    const storageRoot = resolve(config.storage.localDirectory);
    const absPath = resolve(job.output_video_path.startsWith("storage") ? process.cwd() : storageRoot, job.output_video_path);
    const normalized = normalize(absPath);
    const normalizedRoot = normalize(storageRoot);

    if (!normalized.startsWith(normalizedRoot + sep)) {
      return res.status(403).json({
        ok: false,
        code: "INVALID_OUTPUT_PATH",
        message: "Output path is outside the storage directory.",
      });
    }

    if (!existsSync(absPath)) {
      return res.status(404).json({
        ok: false,
        code: "OUTPUT_FILE_MISSING",
        message: "Rendered output file was not found on disk.",
      });
    }

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="render-${job.id}.mp4"`);
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
