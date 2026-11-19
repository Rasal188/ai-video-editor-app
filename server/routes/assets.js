import express, { Router } from "express";
import { existsSync } from "node:fs";
import { config } from "../config.js";
import { requireAuth } from "../middleware/auth.js";
import { ApiError } from "../services/errors.js";
import * as assetService from "../services/assets/assetService.js";

const router = Router();

// Enforce authentication across all asset operations
router.use(requireAuth);

/**
 * POST /api/assets/upload
 * Stores a persistent, owner-scoped Overlay Template Studio image.
 */
router.post(
  "/upload",
  express.raw({ type: "image/*", limit: config.storage.maxUploadSizeBytes }),
  async (req, res, next) => {
    try {
      const asset = await assetService.createUploadedTemplateImage({
        ownerId: req.user.id,
        filename: req.get("X-File-Name") || "template-image",
        mimeType: req.get("Content-Type") || "",
        bytes: req.body,
        width: req.get("X-Image-Width"),
        height: req.get("X-Image-Height"),
      });
      return res.status(201).json({ ok: true, asset });
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
 * POST /api/assets
 * Registers asset metadata in PostgreSQL.
 */
router.post("/", async (req, res, next) => {
  try {
    const asset = await assetService.createAsset({
      ownerId: req.user.id,
      ...(req.body || {}),
    });
    return res.status(201).json({
      ok: true,
      asset,
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
 * GET /api/assets
 * Lists assets for a given project or all assets owned by user.
 */
router.get("/", async (req, res, next) => {
  try {
    const { projectId, limit, offset } = req.query;
    const assets = await assetService.listAssets({
      userId: req.user.id,
      projectId,
      limit,
      offset,
    });
    return res.status(200).json({
      ok: true,
      assets,
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
 * GET /api/assets/:id/content
 * Streams owner-authorized persistent asset content.
 */
router.get("/:id/content", async (req, res, next) => {
  try {
    const { asset, absolutePath } = await assetService.getAssetContent({
      assetId: req.params.id,
      userId: req.user.id,
    });
    if (!existsSync(absolutePath)) {
      return res.status(404).json({
        ok: false,
        code: "ASSET_CONTENT_NOT_FOUND",
        message: "The asset file was not found on disk.",
      });
    }
    res.setHeader("Content-Type", asset.mime_type);
    res.setHeader("Content-Length", String(asset.size_bytes));
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(asset.filename)}`);
    res.setHeader("Cache-Control", "private, max-age=3600");
    if (asset.mime_type === "image/svg+xml") {
      res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    }
    return res.sendFile(absolutePath);
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
 * GET /api/assets/:id
 * Retrieves metadata for a specific asset.
 */
router.get("/:id", async (req, res, next) => {
  try {
    const asset = await assetService.getAsset({
      assetId: req.params.id,
      userId: req.user.id,
    });
    return res.status(200).json({
      ok: true,
      asset,
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
 * DELETE /api/assets/:id
 * Deletes an asset record after verifying ownership.
 */
router.delete("/:id", async (req, res, next) => {
  try {
    await assetService.deleteAsset({
      assetId: req.params.id,
      userId: req.user.id,
    });
    return res.status(200).json({
      ok: true,
      message: "Asset deleted successfully.",
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

export default router;
