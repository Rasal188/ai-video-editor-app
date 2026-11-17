import { BadRequestError } from "../errors.js";

/**
 * Canonical server-side schema for `ai-shorts-overlay-template`.
 *
 * This is a *definition-only* format. It intentionally rejects rendered media,
 * flattened screenshots, SVG images with baked text, binary data URIs, blobs and
 * session-only object URLs so that a template stays editable after application.
 *
 * NOTE: the browser-side normalizer lives in `src/lib/shortsOverlayTemplates.js`.
 * The server re-validates independently so an unauthenticated/forged payload can
 * never reach the database in a shape the renderer cannot consume.
 */

export const OVERLAY_TEMPLATE_FORMAT = "ai-shorts-overlay-template";
export const OVERLAY_TEMPLATE_SCHEMA_VERSION = 1;
export const SUPPORTED_OVERLAY_TEMPLATE_VERSIONS = Object.freeze([1]);

export const OVERLAY_TEMPLATE_LIMITS = Object.freeze({
    nameMaxLength: 120,
    descriptionMaxLength: 2000,
    maxElements: 64,
    maxKeyframesPerElement: 400,
    maxVectorBodyLength: 200_000,
    maxPayloadBytes: 512 * 1024,
});

export const OVERLAY_ELEMENT_KINDS = Object.freeze(["media", "vector", "text", "shape"]);
export const OVERLAY_MEDIA_KINDS = Object.freeze(["image", "video"]);

/**
 * Fields that must never be persisted in a template. Their presence indicates the
 * caller is trying to store rendered output or session-scoped state as a template.
 */
const FORBIDDEN_ELEMENT_FIELDS = Object.freeze([
    "blob",
    "src",
    "objectUrl",
    "url",
    "dataUri",
    "dataURL",
    "thumbnail",
    "previewImage",
    "renderedFrame",
]);

const FORBIDDEN_MEDIA_FIELDS = Object.freeze([
    "blob",
    "src",
    "objectUrl",
    "url",
    "dataUri",
    "dataURL",
    "file",
    "buffer",
    "bytes",
]);

const DEFAULT_CANVAS = Object.freeze({ aspectRatio: "9:16", width: 1080, height: 1920 });

function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value, field, maxLength) {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string") {
        throw new BadRequestError(`Template ${field} must be a string.`, "INVALID_TEMPLATE_FIELD");
    }
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.length > maxLength) {
        throw new BadRequestError(
            `Template ${field} must be at most ${maxLength} characters.`,
            "INVALID_TEMPLATE_FIELD"
        );
    }
    return trimmed;
}

function finiteNumber(value, field, { min = -Infinity, max = Infinity, fallback = 0 } = {}) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
        if (fallback !== undefined && (value === undefined || value === null || value === "")) return fallback;
        throw new BadRequestError(`Template ${field} must be a finite number.`, "INVALID_TEMPLATE_FIELD");
    }
    if (num < min || num > max) {
        throw new BadRequestError(
            `Template ${field} must be between ${min} and ${max}.`,
            "INVALID_TEMPLATE_FIELD"
        );
    }
    return num;
}

function boundedInteger(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = min } = {}) {
    if (value === undefined || value === null || value === "") return fallback;
    const num = Number.parseInt(value, 10);
    if (Number.isNaN(num)) {
        throw new BadRequestError(`Template ${field} must be an integer.`, "INVALID_TEMPLATE_FIELD");
    }
    if (num < min || num > max) {
        throw new BadRequestError(
            `Template ${field} must be between ${min} and ${max}.`,
            "INVALID_TEMPLATE_FIELD"
        );
    }
    return num;
}

function assertNoForbiddenFields(object, forbidden, context) {
    for (const field of forbidden) {
        if (object[field] !== undefined && object[field] !== null) {
            throw new BadRequestError(
                `Template ${context} may not contain "${field}". Templates store editable configuration only.`,
                "TEMPLATE_FLATTENED_PAYLOAD_REJECTED"
            );
        }
    }
}

export function normalizeTemplateCanvas(canvas) {
    if (canvas === undefined || canvas === null) return { ...DEFAULT_CANVAS };
    if (!isPlainObject(canvas)) {
        throw new BadRequestError("Template canvas must be an object.", "INVALID_TEMPLATE_CANVAS");
    }
    const aspectRatio = optionalString(canvas.aspectRatio, "canvas.aspectRatio", 16) || DEFAULT_CANVAS.aspectRatio;
    return {
        aspectRatio,
        width: boundedInteger(canvas.width, "canvas.width", { min: 16, max: 10000, fallback: DEFAULT_CANVAS.width }),
        height: boundedInteger(canvas.height, "canvas.height", { min: 16, max: 10000, fallback: DEFAULT_CANVAS.height }),
    };
}

function normalizeBaseTransform(transform = {}, context = "baseTransform") {
    if (transform !== undefined && transform !== null && !isPlainObject(transform)) {
        throw new BadRequestError(`Template ${context} must be an object.`, "INVALID_TEMPLATE_FIELD");
    }
    const source = isPlainObject(transform) ? transform : {};
    return {
        x: finiteNumber(source.x, `${context}.x`, { min: -1000, max: 1000, fallback: 0 }),
        y: finiteNumber(source.y, `${context}.y`, { min: -1000, max: 1000, fallback: 0 }),
        scale: finiteNumber(source.scale, `${context}.scale`, { min: 0.01, max: 100, fallback: 1 }),
        rotation: finiteNumber(source.rotation, `${context}.rotation`, { min: -3600, max: 3600, fallback: 0 }),
        opacity: finiteNumber(source.opacity, `${context}.opacity`, { min: 0, max: 1, fallback: 1 }),
    };
}

export function normalizeTemplateKeyframes(keyframes = []) {
    if (keyframes === undefined || keyframes === null) return [];
    if (!Array.isArray(keyframes)) {
        throw new BadRequestError("Template keyframes must be an array.", "INVALID_TEMPLATE_KEYFRAMES");
    }
    if (keyframes.length > OVERLAY_TEMPLATE_LIMITS.maxKeyframesPerElement) {
        throw new BadRequestError(
            `Template elements may not exceed ${OVERLAY_TEMPLATE_LIMITS.maxKeyframesPerElement} keyframes.`,
            "TEMPLATE_TOO_LARGE"
        );
    }

    return keyframes
        .filter((keyframe) => isPlainObject(keyframe) && Number.isFinite(Number(keyframe.time)))
        .map((keyframe, index) => ({
            time: finiteNumber(keyframe.time, `keyframes[${index}].time`, { min: 0, max: 86400 }),
            ...normalizeBaseTransform(keyframe, `keyframes[${index}]`),
        }))
        .sort((left, right) => left.time - right.time);
}

function normalizeAnimationPhase(phase, context) {
    const source = isPlainObject(phase) ? phase : {};
    return {
        id: optionalString(source.id, `${context}.id`, 32) || "none",
        duration: finiteNumber(source.duration, `${context}.duration`, { min: 0.1, max: 3, fallback: 0.6 }),
    };
}

export function normalizeTemplateAnimation(animation = {}) {
    const source = isPlainObject(animation) ? animation : {};
    return {
        in: normalizeAnimationPhase(source.in, "animation.in"),
        out: normalizeAnimationPhase(source.out, "animation.out"),
    };
}

export function normalizeTemplateMask(mask = {}) {
    const source = isPlainObject(mask) ? mask : {};
    return {
        type: optionalString(source.type, "mask.type", 32) || "none",
        feather: finiteNumber(source.feather, "mask.feather", { min: 0, max: 1, fallback: 0 }),
        inverted: source.inverted === true,
    };
}

function normalizeMediaReference(media, context) {
    if (!isPlainObject(media)) {
        throw new BadRequestError(
            `Template ${context}.media is required for media elements.`,
            "INVALID_TEMPLATE_MEDIA"
        );
    }
    assertNoForbiddenFields(media, FORBIDDEN_MEDIA_FIELDS, `${context}.media`);

    const mediaKind = optionalString(media.mediaKind || media.kind, `${context}.media.mediaKind`, 16);
    if (!mediaKind || !OVERLAY_MEDIA_KINDS.includes(mediaKind)) {
        throw new BadRequestError(
            `Template ${context}.media.mediaKind must be one of: ${OVERLAY_MEDIA_KINDS.join(", ")}.`,
            "INVALID_TEMPLATE_MEDIA"
        );
    }

    const assetId = optionalString(media.assetId, `${context}.media.assetId`, 64);
    const archiveMediaId = optionalString(media.archiveMediaId, `${context}.media.archiveMediaId`, 255);
    const checksum = optionalString(media.checksum || media.sha256, `${context}.media.checksum`, 64);

    if (!assetId && !archiveMediaId && !checksum) {
        throw new BadRequestError(
            `Template ${context}.media must reference an asset (assetId, archiveMediaId or checksum).`,
            "INVALID_TEMPLATE_MEDIA"
        );
    }

    return {
        mediaKind,
        assetId,
        archiveMediaId,
        checksum,
        filename: optionalString(media.filename || media.name, `${context}.media.filename`, 255),
        mimeType: optionalString(media.mimeType, `${context}.media.mimeType`, 128),
        width: boundedInteger(media.width, `${context}.media.width`, { min: 1, max: 20000, fallback: 1 }),
        height: boundedInteger(media.height, `${context}.media.height`, { min: 1, max: 20000, fallback: 1 }),
    };
}

function normalizeVectorPayload(vector, context) {
    if (!isPlainObject(vector)) {
        throw new BadRequestError(
            `Template ${context}.vector is required for vector elements.`,
            "INVALID_TEMPLATE_VECTOR"
        );
    }
    const body = optionalString(vector.body || vector.vectorBody, `${context}.vector.body`, OVERLAY_TEMPLATE_LIMITS.maxVectorBodyLength);
    if (!body) {
        throw new BadRequestError(
            `Template ${context}.vector.body is required for vector elements.`,
            "INVALID_TEMPLATE_VECTOR"
        );
    }
    return {
        body,
        background: optionalString(vector.background || vector.vectorBackground, `${context}.vector.background`, 128) || "transparent",
        colorSlots: Array.isArray(vector.colorSlots || vector.vectorColorSlots)
            ? [...(vector.colorSlots || vector.vectorColorSlots)].slice(0, 32).map((slot) => String(slot).slice(0, 32))
            : [],
        design: isPlainObject(vector.design || vector.vectorDesign) ? (vector.design || vector.vectorDesign) : null,
    };
}

function normalizeTextPayload(text, context) {
    if (!isPlainObject(text)) {
        throw new BadRequestError(
            `Template ${context}.text is required for text elements.`,
            "INVALID_TEMPLATE_TEXT"
        );
    }
    const content = optionalString(text.content, `${context}.text.content`, 500);
    if (!content) {
        throw new BadRequestError(
            `Template ${context}.text.content is required for text elements.`,
            "INVALID_TEMPLATE_TEXT"
        );
    }
    return {
        content,
        fontId: optionalString(text.fontId, `${context}.text.fontId`, 64),
        fontSize: boundedInteger(text.fontSize, `${context}.text.fontSize`, { min: 4, max: 500, fallback: 48 }),
        color: optionalString(text.color, `${context}.text.color`, 64) || "#ffffff",
        strokeColor: optionalString(text.strokeColor, `${context}.text.strokeColor`, 64),
        strokeWidth: finiteNumber(text.strokeWidth, `${context}.text.strokeWidth`, { min: 0, max: 40, fallback: 0 }),
        shadowOpacity: finiteNumber(text.shadowOpacity, `${context}.text.shadowOpacity`, { min: 0, max: 1, fallback: 0 }),
        align: optionalString(text.align, `${context}.text.align`, 16) || "center",
        maxWidthPct: finiteNumber(text.maxWidthPct, `${context}.text.maxWidthPct`, { min: 5, max: 100, fallback: 80 }),
    };
}

function normalizeShapePayload(shape, context) {
    if (!isPlainObject(shape)) {
        throw new BadRequestError(
            `Template ${context}.shape is required for shape elements.`,
            "INVALID_TEMPLATE_SHAPE"
        );
    }
    return {
        shapeType: optionalString(shape.shapeType || shape.type, `${context}.shape.shapeType`, 32) || "rect",
        fill: optionalString(shape.fill, `${context}.shape.fill`, 64) || "#ffffff",
        stroke: optionalString(shape.stroke, `${context}.shape.stroke`, 64),
        strokeWidth: finiteNumber(shape.strokeWidth, `${context}.shape.strokeWidth`, { min: 0, max: 40, fallback: 0 }),
        radius: finiteNumber(shape.radius, `${context}.shape.radius`, { min: 0, max: 2000, fallback: 0 }),
    };
}

export function normalizeTemplateElement(element, index = 0) {
    const context = `elements[${index}]`;
    if (!isPlainObject(element)) {
        throw new BadRequestError(`Template ${context} must be an object.`, "INVALID_TEMPLATE_ELEMENT");
    }

    assertNoForbiddenFields(element, FORBIDDEN_ELEMENT_FIELDS, context);

    const kind = optionalString(element.kind || element.type, `${context}.kind`, 16);
    if (!kind || !OVERLAY_ELEMENT_KINDS.includes(kind)) {
        throw new BadRequestError(
            `Template ${context}.kind must be one of: ${OVERLAY_ELEMENT_KINDS.join(", ")}.`,
            "INVALID_TEMPLATE_ELEMENT"
        );
    }

    const durationValue = element.duration;
    const duration = durationValue === null || durationValue === undefined || durationValue === ""
        ? null
        : finiteNumber(durationValue, `${context}.duration`, { min: 0, max: 86400 });

    const normalized = {
        id: optionalString(element.id, `${context}.id`, 64) || `el-${index + 1}`,
        kind,
        name: optionalString(element.name, `${context}.name`, 120),
        baseTransform: normalizeBaseTransform(element.baseTransform, `${context}.baseTransform`),
        keyframes: normalizeTemplateKeyframes(element.keyframes),
        animation: normalizeTemplateAnimation(element.animation),
        mask: normalizeTemplateMask(element.mask),
        filterId: optionalString(element.filterId, `${context}.filterId`, 64),
        layer: boundedInteger(element.layer, `${context}.layer`, { min: 1, max: 10, fallback: 2 }),
        lane: element.lane === undefined || element.lane === null
            ? null
            : boundedInteger(element.lane, `${context}.lane`, { min: 0, max: 99, fallback: 0 }),
        start: finiteNumber(element.start, `${context}.start`, { min: 0, max: 86400, fallback: 0 }),
        duration,
    };

    if (isPlainObject(element.subjectEffect) || typeof element.subjectEffect === "string") {
        normalized.subjectEffect = element.subjectEffect;
    }

    if (kind === "media") {
        normalized.media = normalizeMediaReference(element.media, context);
    } else if (kind === "vector") {
        normalized.vector = normalizeVectorPayload(element.vector, context);
    } else if (kind === "text") {
        normalized.text = normalizeTextPayload(element.text, context);
    } else if (kind === "shape") {
        normalized.shape = normalizeShapePayload(element.shape, context);
    }

    return normalized;
}

export function normalizeTemplateElements(elements) {
    if (elements === undefined || elements === null) return [];
    if (!Array.isArray(elements)) {
        throw new BadRequestError("Template elements must be an array.", "INVALID_TEMPLATE_ELEMENTS");
    }
    if (elements.length > OVERLAY_TEMPLATE_LIMITS.maxElements) {
        throw new BadRequestError(
            `Template may not exceed ${OVERLAY_TEMPLATE_LIMITS.maxElements} elements.`,
            "TEMPLATE_TOO_LARGE"
        );
    }
    return elements.map((element, index) => normalizeTemplateElement(element, index));
}

export function normalizeTemplateName(name) {
    const clean = typeof name === "string" ? name.trim() : "";
    if (!clean) {
        throw new BadRequestError("Template name is required.", "INVALID_TEMPLATE_NAME");
    }
    if (clean.length > OVERLAY_TEMPLATE_LIMITS.nameMaxLength) {
        throw new BadRequestError(
            `Template name must be at most ${OVERLAY_TEMPLATE_LIMITS.nameMaxLength} characters.`,
            "INVALID_TEMPLATE_NAME"
        );
    }
    return clean;
}

export function normalizeTemplateDescription(description) {
    if (description === undefined || description === null) return null;
    if (typeof description !== "string") {
        throw new BadRequestError("Template description must be a string.", "INVALID_TEMPLATE_DESCRIPTION");
    }
    const clean = description.trim();
    if (!clean) return null;
    if (clean.length > OVERLAY_TEMPLATE_LIMITS.descriptionMaxLength) {
        throw new BadRequestError(
            `Template description must be at most ${OVERLAY_TEMPLATE_LIMITS.descriptionMaxLength} characters.`,
            "INVALID_TEMPLATE_DESCRIPTION"
        );
    }
    return clean;
}

export function assertSupportedTemplateVersion(version) {
    if (version === undefined || version === null || version === "") {
        return OVERLAY_TEMPLATE_SCHEMA_VERSION;
    }
    const parsed = Number.parseInt(version, 10);
    if (Number.isNaN(parsed) || !SUPPORTED_OVERLAY_TEMPLATE_VERSIONS.includes(parsed)) {
        throw new BadRequestError(
            `Unsupported overlay template schema version. Supported versions: ${SUPPORTED_OVERLAY_TEMPLATE_VERSIONS.join(", ")}.`,
            "UNSUPPORTED_TEMPLATE_SCHEMA_VERSION"
        );
    }
    return parsed;
}

function assertPayloadWithinSizeLimit(canvas, elements, metadata) {
    const size = JSON.stringify({ canvas, elements, metadata }).length;
    if (size > OVERLAY_TEMPLATE_LIMITS.maxPayloadBytes) {
        throw new BadRequestError(
            `Template payload exceeds the ${OVERLAY_TEMPLATE_LIMITS.maxPayloadBytes} byte limit. Store media in the asset library instead of the template.`,
            "TEMPLATE_TOO_LARGE"
        );
    }
}

/**
 * Validates and normalizes a full create payload.
 */
export function normalizeCreateTemplatePayload(payload = {}) {
    if (!isPlainObject(payload)) {
        throw new BadRequestError("Template payload must be an object.", "INVALID_TEMPLATE_PAYLOAD");
    }

    const schemaVersion = assertSupportedTemplateVersion(payload.schemaVersion ?? payload.version);
    const canvas = normalizeTemplateCanvas(payload.canvas);
    const elements = normalizeTemplateElements(payload.elements);
    const metadata = isPlainObject(payload.metadata) ? payload.metadata : {};

    assertPayloadWithinSizeLimit(canvas, elements, metadata);

    return {
        name: normalizeTemplateName(payload.name),
        description: normalizeTemplateDescription(payload.description),
        schemaVersion,
        canvas,
        elements,
        metadata,
    };
}

/**
 * Validates and normalizes a partial update payload. Only provided keys are returned.
 */
export function normalizeUpdateTemplatePayload(payload = {}) {
    if (!isPlainObject(payload)) {
        throw new BadRequestError("Template payload must be an object.", "INVALID_TEMPLATE_PAYLOAD");
    }

    const updates = {};

    if (payload.name !== undefined) updates.name = normalizeTemplateName(payload.name);
    if (payload.description !== undefined) updates.description = normalizeTemplateDescription(payload.description);
    if (payload.schemaVersion !== undefined || payload.version !== undefined) {
        updates.schema_version = assertSupportedTemplateVersion(payload.schemaVersion ?? payload.version);
    }
    if (payload.canvas !== undefined) updates.canvas = normalizeTemplateCanvas(payload.canvas);
    if (payload.elements !== undefined) updates.elements = normalizeTemplateElements(payload.elements);
    if (payload.metadata !== undefined) {
        if (!isPlainObject(payload.metadata)) {
            throw new BadRequestError("Template metadata must be an object.", "INVALID_TEMPLATE_METADATA");
        }
        updates.metadata = payload.metadata;
    }

    if (updates.canvas || updates.elements) {
        assertPayloadWithinSizeLimit(updates.canvas || {}, updates.elements || [], updates.metadata || {});
    }

    return updates;
}
