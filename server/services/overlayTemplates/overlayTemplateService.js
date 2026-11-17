import * as templateQueries from "../../db/queries/overlayTemplates.js";
import { ForbiddenError, NotFoundError, BadRequestError, isValidUuid } from "../errors.js";
import {
    normalizeCreateTemplatePayload,
    normalizeUpdateTemplatePayload,
    OVERLAY_TEMPLATE_FORMAT,
    OVERLAY_TEMPLATE_SCHEMA_VERSION,
} from "./overlayTemplateSchema.js";

/**
 * Shapes a database row into the public API template object.
 * Server-internal snake_case is mapped to the camelCase template contract.
 */
export function serializeTemplate(row) {
    if (!row) return null;
    return {
        id: row.id,
        ownerId: row.owner_id,
        format: OVERLAY_TEMPLATE_FORMAT,
        schemaVersion: row.schema_version,
        name: row.name,
        description: row.description ?? null,
        canvas: row.canvas || {},
        elements: Array.isArray(row.elements) ? row.elements : [],
        metadata: row.metadata || {},
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function requireUserId(userId) {
    if (!isValidUuid(userId)) {
        throw new BadRequestError("Invalid user ID.", "INVALID_USER_ID");
    }
}

/**
 * Creates a global, user-scoped overlay template.
 */
export async function createTemplate({ ownerId, payload }) {
    requireUserId(ownerId);
    const normalized = normalizeCreateTemplatePayload(payload);

    const row = await templateQueries.createOverlayTemplate({
        ownerId,
        name: normalized.name,
        description: normalized.description,
        schemaVersion: normalized.schemaVersion,
        canvas: normalized.canvas,
        elements: normalized.elements,
        metadata: normalized.metadata,
    });

    return serializeTemplate(row);
}

/**
 * Retrieves a single template with strict ownership enforcement.
 * Cross-user access surfaces as 403; unknown IDs as 404.
 */
export async function getTemplate({ templateId, userId }) {
    requireUserId(userId);
    if (!isValidUuid(templateId)) {
        throw new BadRequestError("Invalid template ID.", "INVALID_TEMPLATE_ID");
    }

    const row = await templateQueries.getOverlayTemplateById(templateId);
    if (!row) {
        throw new NotFoundError("Overlay template not found.", "TEMPLATE_NOT_FOUND");
    }
    if (row.owner_id !== userId) {
        throw new ForbiddenError("You do not have permission to access this template.", "FORBIDDEN");
    }

    return serializeTemplate(row);
}

/**
 * Lists every template owned by the authenticated user, across all projects.
 */
export async function listTemplates({ userId, limit = 50, offset = 0, search = null }) {
    requireUserId(userId);

    const parsedLimit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 50));
    const parsedOffset = Math.max(0, Number.parseInt(offset, 10) || 0);
    const cleanSearch = typeof search === "string" ? search.trim().slice(0, 120) : null;

    const rows = await templateQueries.listOverlayTemplatesByOwner(userId, {
        limit: parsedLimit,
        offset: parsedOffset,
        search: cleanSearch,
    });

    return rows.map(serializeTemplate);
}

/**
 * Updates template metadata and/or definition after verifying ownership.
 */
export async function updateTemplate({ templateId, userId, payload }) {
    const existing = await getTemplate({ templateId, userId });
    const updates = normalizeUpdateTemplatePayload(payload);

    const row = await templateQueries.updateOverlayTemplate(existing.id, updates);
    return serializeTemplate(row);
}

/**
 * Duplicates a template owned by the caller into a new independent record.
 */
export async function duplicateTemplate({ templateId, userId, name }) {
    const existing = await getTemplate({ templateId, userId });

    const requestedName = typeof name === "string" ? name.trim() : "";
    const baseName = `${existing.name} (copy)`;
    const nextName = (requestedName || baseName).slice(0, 120);

    const row = await templateQueries.createOverlayTemplate({
        ownerId: userId,
        name: nextName,
        description: existing.description,
        schemaVersion: OVERLAY_TEMPLATE_SCHEMA_VERSION,
        canvas: existing.canvas,
        elements: existing.elements,
        metadata: {
            ...(existing.metadata || {}),
            duplicatedFrom: existing.id,
        },
    });

    return serializeTemplate(row);
}

/**
 * Deletes a template after verifying ownership.
 */
export async function deleteTemplate({ templateId, userId }) {
    const existing = await getTemplate({ templateId, userId });
    await templateQueries.deleteOverlayTemplate(existing.id);
    return { id: existing.id };
}
