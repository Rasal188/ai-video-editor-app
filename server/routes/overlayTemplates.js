import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { ApiError } from "../services/errors.js";
import { OVERLAY_TEMPLATE_LIMITS } from "../services/overlayTemplates/overlayTemplateSchema.js";
import * as templateService from "../services/overlayTemplates/overlayTemplateService.js";

const router = Router();

// Enforce authentication across all overlay template operations
router.use(requireAuth);

/**
 * Guards the create/update body before it reaches the service so an oversized
 * definition is rejected early instead of being buffered by the JSON parser.
 */
function enforceTemplatePayloadSize(req, res, next) {
    const body = req.body;
    if (body === undefined || body === null) return next();

    let serialized;
    try {
        serialized = JSON.stringify(body);
    } catch {
        return res.status(400).json({
            ok: false,
            code: "INVALID_TEMPLATE_PAYLOAD",
            message: "Template payload could not be serialized.",
        });
    }

    if (serialized.length > OVERLAY_TEMPLATE_LIMITS.maxPayloadBytes) {
        return res.status(413).json({
            ok: false,
            code: "TEMPLATE_TOO_LARGE",
            message: `Template payload exceeds the ${OVERLAY_TEMPLATE_LIMITS.maxPayloadBytes} byte limit.`,
        });
    }

    return next();
}

function sendError(err, res, next) {
    if (err instanceof ApiError) {
        return res.status(err.status).json({
            ok: false,
            code: err.code,
            message: err.message,
        });
    }
    return next(err);
}

/**
 * POST /api/overlay-templates
 * Creates a global template owned by the authenticated user.
 */
router.post("/", enforceTemplatePayloadSize, async (req, res, next) => {
    try {
        const template = await templateService.createTemplate({
            ownerId: req.user.id,
            payload: req.body || {},
        });
        return res.status(201).json({ ok: true, template });
    } catch (err) {
        return sendError(err, res, next);
    }
});

/**
 * GET /api/overlay-templates
 * Lists all templates owned by the authenticated user (across all projects).
 */
router.get("/", async (req, res, next) => {
    try {
        const { limit, offset, search } = req.query;
        const templates = await templateService.listTemplates({
            userId: req.user.id,
            limit,
            offset,
            search,
        });
        return res.status(200).json({ ok: true, templates });
    } catch (err) {
        return sendError(err, res, next);
    }
});

/**
 * GET /api/overlay-templates/:id
 * Retrieves a single template after ownership verification.
 */
router.get("/:id", async (req, res, next) => {
    try {
        const template = await templateService.getTemplate({
            templateId: req.params.id,
            userId: req.user.id,
        });
        return res.status(200).json({ ok: true, template });
    } catch (err) {
        return sendError(err, res, next);
    }
});

/**
 * PATCH /api/overlay-templates/:id
 * Updates template metadata and/or definition after ownership verification.
 */
router.patch("/:id", enforceTemplatePayloadSize, async (req, res, next) => {
    try {
        const template = await templateService.updateTemplate({
            templateId: req.params.id,
            userId: req.user.id,
            payload: req.body || {},
        });
        return res.status(200).json({ ok: true, template });
    } catch (err) {
        return sendError(err, res, next);
    }
});

/**
 * POST /api/overlay-templates/:id/duplicate
 * Duplicates a template owned by the caller.
 */
router.post("/:id/duplicate", async (req, res, next) => {
    try {
        const template = await templateService.duplicateTemplate({
            templateId: req.params.id,
            userId: req.user.id,
            name: req.body?.name,
        });
        return res.status(201).json({ ok: true, template });
    } catch (err) {
        return sendError(err, res, next);
    }
});

/**
 * DELETE /api/overlay-templates/:id
 * Deletes a template after ownership verification.
 */
router.delete("/:id", async (req, res, next) => {
    try {
        const deleted = await templateService.deleteTemplate({
            templateId: req.params.id,
            userId: req.user.id,
        });
        return res.status(200).json({
            ok: true,
            id: deleted.id,
            message: "Overlay template deleted successfully.",
        });
    } catch (err) {
        return sendError(err, res, next);
    }
});

export default router;
