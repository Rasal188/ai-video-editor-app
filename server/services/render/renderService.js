import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as renderJobQueries from "../../db/queries/renderJobs.js";
import * as projectQueries from "../../db/queries/projects.js";
import { config } from "../../config.js";
import { getProject } from "../projects/projectService.js";
import {
  BadRequestError,
  NotFoundError,
  isValidUuid,
} from "../errors.js";

const executeFile = promisify(execFile);

/**
 * Creates a render job for a project owned by the user.
 */
export async function createRenderJob({
  projectId,
  userId,
  requestedRevision = undefined,
  settings = {},
}) {
  const project = await getProject({ projectId, userId });

  const targetRevision = requestedRevision !== undefined
    ? Number.parseInt(requestedRevision, 10)
    : project.current_revision;

  if (Number.isNaN(targetRevision) || targetRevision < 0) {
    throw new BadRequestError("Requested revision must be a non-negative integer.", "INVALID_REVISION");
  }

  if (typeof settings !== "object" || settings === null) {
    throw new BadRequestError("Render settings must be an object.", "INVALID_SETTINGS");
  }

  const job = await renderJobQueries.createRenderJob({
    projectId: project.id,
    requestedRevision: targetRevision,
    settings,
  });

  return job;
}

/**
 * Retrieves a render job and verifies project ownership.
 */
export async function getRenderJob({ jobId, userId }) {
  if (!isValidUuid(jobId)) {
    throw new BadRequestError("Invalid render job ID.", "INVALID_JOB_ID");
  }

  const job = await renderJobQueries.getRenderJobById(jobId);
  if (!job) {
    throw new NotFoundError("Render job not found.", "JOB_NOT_FOUND");
  }

  // Verifies the user owns the parent project
  await getProject({ projectId: job.project_id, userId });

  return job;
}

/**
 * Lists render jobs for a specific project or all projects of the user.
 */
export async function listRenderJobs({ userId, projectId = null, limit = 50, offset = 0 }) {
  if (!isValidUuid(userId)) {
    throw new BadRequestError("Invalid user ID.", "INVALID_USER_ID");
  }

  const parsedLimit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 50));
  const parsedOffset = Math.max(0, Number.parseInt(offset, 10) || 0);

  if (projectId) {
    await getProject({ projectId, userId });
    return renderJobQueries.listRenderJobsByProject(projectId, {
      limit: parsedLimit,
      offset: parsedOffset,
    });
  }

  return renderJobQueries.listRenderJobsByOwner(userId, {
    limit: parsedLimit,
    offset: parsedOffset,
  });
}

/**
 * Cancels a pending or processing render job.
 */
export async function cancelRenderJob({ jobId, userId }) {
  const job = await getRenderJob({ jobId, userId });

  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
    throw new BadRequestError(`Cannot cancel a job with status '${job.status}'.`, "INVALID_STATE");
  }

  const updated = await renderJobQueries.updateRenderJobStatus(job.id, {
    status: renderJobQueries.RENDER_STATUS.CANCELLED,
    completedAt: new Date().toISOString(),
  });

  return updated;
}

/**
 * Executes a render job through the existing CLI render pipeline.
 * Connects PostgreSQL metadata -> Canonical .timeline file -> CLI -> Render output.
 */
export async function executeRenderJob({ jobId, userId }) {
  const job = await getRenderJob({ jobId, userId });

  if (job.status !== renderJobQueries.RENDER_STATUS.PENDING) {
    throw new BadRequestError(`Cannot start job with status '${job.status}'.`, "INVALID_STATE");
  }

  // Transition to processing
  await renderJobQueries.updateRenderJobStatus(job.id, {
    status: renderJobQueries.RENDER_STATUS.PROCESSING,
    startedAt: new Date().toISOString(),
  });

  // Resolve archive storage path
  const project = await getProject({ projectId: job.project_id, userId });
  let archivePath;

  if (job.requested_revision === project.current_revision) {
    archivePath = project.archive_storage_path;
  } else {
    const version = await projectQueries.getProjectVersionByRevision(project.id, job.requested_revision);
    archivePath = version?.archive_storage_path || null;
  }

  const resolvedArchive = archivePath ? resolve(process.cwd(), archivePath) : null;

  if (!resolvedArchive || !existsSync(resolvedArchive)) {
    return renderJobQueries.updateRenderJobStatus(job.id, {
      status: renderJobQueries.RENDER_STATUS.FAILED,
      errorMessage: `Project archive not found at: ${archivePath || "null"}`,
      completedAt: new Date().toISOString(),
    });
  }

  // Setup output paths
  const rendersDir = resolve(config.storage.localDirectory, "renders");
  await mkdir(rendersDir, { recursive: true });

  const outputPath = resolve(rendersDir, `${job.id}.mp4`);
  const planPath = resolve(rendersDir, `${job.id}-render-plan.json`);

  const renderPayload = {
    schemaVersion: 1,
    project: resolvedArchive,
    output: {
      video: outputPath,
    },
    render: job.settings || {},
  };

  try {
    await writeFile(planPath, JSON.stringify(renderPayload, null, 2), "utf8");

    const cliScript = resolve(process.cwd(), "scripts", "timeline-command.mjs");
    const { stdout } = await executeFile(process.execPath, [cliScript, "project.render", planPath]);
    const result = JSON.parse(stdout);

    if (!result.ok) {
      throw new Error(result.message || "Render command failed without error details.");
    }

    const completed = await renderJobQueries.updateRenderJobStatus(job.id, {
      status: renderJobQueries.RENDER_STATUS.COMPLETED,
      outputVideoPath: outputPath,
      verification: result.verification || {},
      completedAt: new Date().toISOString(),
    });

    return completed;
  } catch (error) {
    const failed = await renderJobQueries.updateRenderJobStatus(job.id, {
      status: renderJobQueries.RENDER_STATUS.FAILED,
      errorMessage: error.message || "Render execution failed.",
      completedAt: new Date().toISOString(),
    });

    return failed;
  } finally {
    await rm(planPath, { force: true }).catch(() => {});
  }
}
