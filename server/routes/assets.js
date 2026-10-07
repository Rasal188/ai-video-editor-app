import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { ApiError } from "../services/errors.js";
import * as assetService from "../services/assets/assetService.js";

const router = Router();

// Enforce authentication across all asset operations
router.use(requireAuth);

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
