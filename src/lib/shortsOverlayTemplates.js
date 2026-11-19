/**
 * Global Shorts Overlay Template Library - template engine.
 *
 * This module is intentionally pure and dependency-light so it can run in the
 * browser *and* under `node --test` without a DOM. It never renders anything:
 * preview and export keep flowing through the existing `drawPreviewFrame`
 * render path in `media.js`.
 *
 * Responsibilities:
 *  - normalize/validate the versioned `ai-shorts-overlay-template` document
 *  - build a template from live editor overlays (Save as Template)
 *  - instantiate a template into new overlays (apply to a project timeline)
 *  - duplicate a template definition
 *
 * Design rules enforced here:
 *  - A template stores *definitions only*. Flattened render artifacts (blobs,
 *    object URLs, data URIs, screenshots) are rejected outright.
 *  - Applying a template is purely additive. Existing project content is never
 *    replaced or reordered.
 *  - `trackLocks.overlay` is always respected.
 */

import { makeId, packTimedSegmentsIntoLanes } from "./timeline.js";
import { normalizeVisualClipAnimation } from "./visualClipAnimations.js";
import { DEFAULT_OVERLAY_SECONDS, createVisualOverlaySegment } from "./visualOverlayTimeline.js";
import { VECTOR_VIEWBOX_SIZE, createVectorSvgDataUrl } from "./vectorAssets.js";

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

/** Element kinds this engine can turn into ordinary timeline overlays. */
export const APPLICABLE_ELEMENT_KINDS = Object.freeze([...OVERLAY_ELEMENT_KINDS]);

export const DEFAULT_TEMPLATE_CANVAS = Object.freeze({
    aspectRatio: "9:16",
    width: 1080,
    height: 1920,
});

/** Reasons reported by {@link instantiateTemplate}. */
export const TEMPLATE_APPLY_REASONS = Object.freeze({
    applied: "APPLIED",
    trackLocked: "TRACK_LOCKED",
    nothingToApply: "NOTHING_TO_APPLY",
});

/** Per-element skip reasons surfaced to the UI. Never a silent drop. */
export const TEMPLATE_ELEMENT_SKIP_REASONS = Object.freeze({
    missingAsset: "MISSING_ASSET",
    unsupportedKind: "UNSUPPORTED_ELEMENT_KIND",
    invalidElement: "INVALID_ELEMENT",
    unportableOverlay: "UNPORTABLE_OVERLAY",
});

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

const DEFAULT_BASE_TRANSFORM = Object.freeze({
    x: 0,
    y: 0,
    scale: 1,
    rotation: 0,
    opacity: 1,
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class OverlayTemplateError extends Error {
    constructor(code, message, details = null) {
        super(message);
        this.name = "OverlayTemplateError";
        this.code = code;
        this.details = details;
    }
}

function templateError(code, message, details = null) {
    return new OverlayTemplateError(code, message, details);
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function round(value, digits = 6) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

function boundedNumber(value, { min, max, fallback }) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(max, Math.max(min, numeric));
}

function boundedInteger(value, { min, max, fallback }) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(max, Math.max(min, Math.round(numeric)));
}

function optionalString(value, maxLength) {
    if (typeof value !== "string") return "";
    return value.trim().slice(0, maxLength);
}

function editableTextContent(value, context, maxLength) {
    if (typeof value !== "string") {
        throw templateError(
            "INVALID_TEMPLATE_TEXT",
            `Template ${context}.text.content must be a string.`,
        );
    }
    return value.slice(0, maxLength);
}

function assertNoForbiddenFields(source, forbidden, context) {
    const found = forbidden.find((field) => source[field] !== undefined && source[field] !== null);
    if (found) {
        throw templateError(
            "TEMPLATE_FLATTENED_PAYLOAD_REJECTED",
            `Template ${context}.${found} is not allowed. Templates store editable definitions, not rendered media.`,
            { context, field: found },
        );
    }
}

// ---------------------------------------------------------------------------
// Canvas / transform / keyframes / animation / mask
// ---------------------------------------------------------------------------

export function normalizeTemplateCanvas(canvas) {
    if (canvas === undefined || canvas === null) return { ...DEFAULT_TEMPLATE_CANVAS };
    if (!isPlainObject(canvas)) {
        throw templateError("INVALID_TEMPLATE_CANVAS", "Template canvas must be an object.");
    }
    const normalized = {
        aspectRatio: optionalString(canvas.aspectRatio, 16) || DEFAULT_TEMPLATE_CANVAS.aspectRatio,
        width: boundedInteger(canvas.width, { min: 16, max: 10000, fallback: DEFAULT_TEMPLATE_CANVAS.width }),
        height: boundedInteger(canvas.height, { min: 16, max: 10000, fallback: DEFAULT_TEMPLATE_CANVAS.height }),
    };
    const background = optionalString(canvas.background, 64);
    if (background) normalized.background = background;
    return normalized;
}

function normalizeTemplateBaseTransform(transform, context = "baseTransform") {
    if (transform !== undefined && transform !== null && !isPlainObject(transform)) {
        throw templateError("INVALID_TEMPLATE_FIELD", `Template ${context} must be an object.`);
    }
    const source = isPlainObject(transform) ? transform : {};
    return {
        x: boundedNumber(source.x, { min: -1000, max: 1000, fallback: DEFAULT_BASE_TRANSFORM.x }),
        y: boundedNumber(source.y, { min: -1000, max: 1000, fallback: DEFAULT_BASE_TRANSFORM.y }),
        scale: boundedNumber(source.scale, { min: 0.01, max: 100, fallback: DEFAULT_BASE_TRANSFORM.scale }),
        rotation: boundedNumber(source.rotation, { min: -3600, max: 3600, fallback: DEFAULT_BASE_TRANSFORM.rotation }),
        opacity: boundedNumber(source.opacity, { min: 0, max: 1, fallback: DEFAULT_BASE_TRANSFORM.opacity }),
    };
}

export function normalizeTemplateKeyframes(keyframes = []) {
    if (keyframes === undefined || keyframes === null) return [];
    if (!Array.isArray(keyframes)) {
        throw templateError("INVALID_TEMPLATE_KEYFRAMES", "Template keyframes must be an array.");
    }
    if (keyframes.length > OVERLAY_TEMPLATE_LIMITS.maxKeyframesPerElement) {
        throw templateError(
            "TEMPLATE_TOO_LARGE",
            `Template elements may not exceed ${OVERLAY_TEMPLATE_LIMITS.maxKeyframesPerElement} keyframes.`,
        );
    }
    return keyframes
        .filter((keyframe) => isPlainObject(keyframe) && Number.isFinite(Number(keyframe.time)))
        .map((keyframe) => ({
            time: boundedNumber(keyframe.time, { min: 0, max: 86400, fallback: 0 }),
            ...normalizeTemplateBaseTransform(keyframe, "keyframes[]"),
        }))
        .sort((left, right) => left.time - right.time);
}

export function normalizeTemplateAnimation(animation = {}) {
    const normalized = normalizeVisualClipAnimation(isPlainObject(animation) ? animation : {});
    return {
        in: { id: optionalString(normalized.in?.id, 32) || "none", duration: normalized.in.duration },
        out: { id: optionalString(normalized.out?.id, 32) || "none", duration: normalized.out.duration },
    };
}

export function normalizeTemplateMask(mask = {}) {
    const source = isPlainObject(mask) ? mask : {};
    return {
        type: optionalString(source.type, 32) || "none",
        feather: boundedNumber(source.feather, { min: 0, max: 1, fallback: 0 }),
        inverted: source.inverted === true,
    };
}

// ---------------------------------------------------------------------------
// Element payloads
// ---------------------------------------------------------------------------

function normalizeElementLayout(layout, context) {
    if (layout === undefined || layout === null) return null;
    if (!isPlainObject(layout)) {
        throw templateError("INVALID_TEMPLATE_FIELD", `Template ${context}.layout must be an object.`);
    }
    return {
        x: boundedNumber(layout.x, { min: -10000, max: 20000, fallback: 0 }),
        y: boundedNumber(layout.y, { min: -10000, max: 20000, fallback: 0 }),
        width: boundedNumber(layout.width, { min: 1, max: 20000, fallback: 100 }),
        height: boundedNumber(layout.height, { min: 1, max: 20000, fallback: 100 }),
    };
}

function normalizeMediaReference(media, context) {
    if (!isPlainObject(media)) {
        throw templateError("INVALID_TEMPLATE_MEDIA", `Template ${context}.media is required for media elements.`);
    }
    assertNoForbiddenFields(media, FORBIDDEN_MEDIA_FIELDS, `${context}.media`);

    const mediaKind = optionalString(media.mediaKind || media.kind, 16);
    if (!OVERLAY_MEDIA_KINDS.includes(mediaKind)) {
        throw templateError(
            "INVALID_TEMPLATE_MEDIA",
            `Template ${context}.media.mediaKind must be one of: ${OVERLAY_MEDIA_KINDS.join(", ")}.`,
        );
    }

    const assetId = optionalString(media.assetId, 64);
    const archiveMediaId = optionalString(media.archiveMediaId, 255);
    const checksum = optionalString(media.checksum || media.sha256, 64);

    if (!assetId && !archiveMediaId && !checksum) {
        throw templateError(
            "INVALID_TEMPLATE_MEDIA",
            `Template ${context}.media must reference an asset (assetId, archiveMediaId or checksum).`,
        );
    }

    return {
        mediaKind,
        assetId,
        archiveMediaId,
        checksum,
        filename: optionalString(media.filename || media.name, 255),
        mimeType: optionalString(media.mimeType, 128),
        width: boundedInteger(media.width, { min: 1, max: 20000, fallback: 1 }),
        height: boundedInteger(media.height, { min: 1, max: 20000, fallback: 1 }),
        fit: ["contain", "cover", "fill"].includes(media.fit) ? media.fit : "cover",
        positionX: boundedNumber(media.positionX, { min: 0, max: 100, fallback: 50 }),
        positionY: boundedNumber(media.positionY, { min: 0, max: 100, fallback: 50 }),
        zoom: boundedNumber(media.zoom, { min: 0.1, max: 10, fallback: 1 }),
    };
}

function normalizeVectorPayload(vector, context) {
    if (!isPlainObject(vector)) {
        throw templateError("INVALID_TEMPLATE_VECTOR", `Template ${context}.vector is required for vector elements.`);
    }
    const body = optionalString(vector.body || vector.vectorBody, OVERLAY_TEMPLATE_LIMITS.maxVectorBodyLength);
    if (!body) {
        throw templateError("INVALID_TEMPLATE_VECTOR", `Template ${context}.vector.body is required for vector elements.`);
    }
    const rawSlots = vector.colorSlots || vector.vectorColorSlots;
    const design = vector.design || vector.vectorDesign;
    return {
        assetId: optionalString(vector.assetId || vector.vectorAssetId, 64),
        body,
        background: optionalString(vector.background || vector.vectorBackground, 128) || "transparent",
        colorSlots: Array.isArray(rawSlots) ? rawSlots.slice(0, 32).map((slot) => String(slot).slice(0, 32)) : [],
        design: isPlainObject(design) ? { ...design } : null,
    };
}

function normalizeTextPayload(text, context) {
    if (!isPlainObject(text)) {
        throw templateError("INVALID_TEMPLATE_TEXT", `Template ${context}.text is required for text elements.`);
    }
    const content = editableTextContent(text.content, context, 500);
    return {
        content,
        fontId: optionalString(text.fontId, 64),
        fontFamily: optionalString(text.fontFamily, 120) || "Inter, system-ui, sans-serif",
        fontSize: boundedInteger(text.fontSize, { min: 4, max: 500, fallback: 48 }),
        fontWeight: boundedInteger(text.fontWeight, { min: 100, max: 900, fallback: 700 }),
        italic: text.italic === true,
        lineHeight: boundedNumber(text.lineHeight, { min: 0.5, max: 4, fallback: 1.1 }),
        letterSpacing: boundedNumber(text.letterSpacing, { min: -20, max: 100, fallback: 0 }),
        color: optionalString(text.color, 64) || "#ffffff",
        strokeColor: optionalString(text.strokeColor, 64),
        strokeWidth: boundedNumber(text.strokeWidth, { min: 0, max: 40, fallback: 0 }),
        shadowColor: optionalString(text.shadowColor, 64) || "#000000",
        shadowBlur: boundedNumber(text.shadowBlur, { min: 0, max: 100, fallback: 0 }),
        shadowOffsetX: boundedNumber(text.shadowOffsetX, { min: -200, max: 200, fallback: 0 }),
        shadowOffsetY: boundedNumber(text.shadowOffsetY, { min: -200, max: 200, fallback: 0 }),
        shadowOpacity: boundedNumber(text.shadowOpacity, { min: 0, max: 1, fallback: 0 }),
        align: ["left", "center", "right"].includes(text.align) ? text.align : "center",
        verticalAlign: ["top", "middle", "bottom"].includes(text.verticalAlign) ? text.verticalAlign : "middle",
        maxWidthPct: boundedNumber(text.maxWidthPct, { min: 5, max: 100, fallback: 80 }),
    };
}

function normalizeShapePayload(shape, context) {
    if (!isPlainObject(shape)) {
        throw templateError("INVALID_TEMPLATE_SHAPE", `Template ${context}.shape is required for shape elements.`);
    }
    return {
        shapeType: ["rect", "ellipse", "triangle", "line"].includes(shape.shapeType || shape.type)
            ? (shape.shapeType || shape.type)
            : "rect",
        fill: optionalString(shape.fill, 64) || "#ffffff",
        stroke: optionalString(shape.stroke, 64),
        strokeWidth: boundedNumber(shape.strokeWidth, { min: 0, max: 40, fallback: 0 }),
        radius: boundedNumber(shape.radius, { min: 0, max: 2000, fallback: 0 }),
    };
}

export function normalizeTemplateElement(element, index = 0) {
    const context = `elements[${index}]`;
    if (!isPlainObject(element)) {
        throw templateError("INVALID_TEMPLATE_ELEMENT", `Template ${context} must be an object.`);
    }
    assertNoForbiddenFields(element, FORBIDDEN_ELEMENT_FIELDS, context);

    const kind = optionalString(element.kind || element.type, 16);
    if (!OVERLAY_ELEMENT_KINDS.includes(kind)) {
        throw templateError(
            "INVALID_TEMPLATE_ELEMENT",
            `Template ${context}.kind must be one of: ${OVERLAY_ELEMENT_KINDS.join(", ")}.`,
        );
    }

    const rawDuration = element.duration;
    const duration = rawDuration === null || rawDuration === undefined || rawDuration === ""
        ? null
        : boundedNumber(rawDuration, { min: 0, max: 86400, fallback: 0 });

    const normalized = {
        id: optionalString(element.id, 64) || `el-${index + 1}`,
        kind,
        name: optionalString(element.name, 120),
        baseTransform: normalizeTemplateBaseTransform(element.baseTransform, `${context}.baseTransform`),
        keyframes: normalizeTemplateKeyframes(element.keyframes),
        animation: normalizeTemplateAnimation(element.animation),
        mask: normalizeTemplateMask(element.mask),
        filterId: optionalString(element.filterId, 64),
        layer: boundedInteger(element.layer, { min: 1, max: 64, fallback: 2 }),
        lane: element.lane === undefined || element.lane === null
            ? null
            : boundedInteger(element.lane, { min: 0, max: 99, fallback: 0 }),
        start: boundedNumber(element.start, { min: 0, max: 86400, fallback: 0 }),
        duration,
    };
    const layout = normalizeElementLayout(element.layout, context);
    if (layout) normalized.layout = layout;
    if (typeof element.visible === "boolean") normalized.visible = element.visible;
    if (typeof element.locked === "boolean") normalized.locked = element.locked;

    if (kind === "media") normalized.media = normalizeMediaReference(element.media, context);
    else if (kind === "vector") normalized.vector = normalizeVectorPayload(element.vector, context);
    else if (kind === "text") normalized.text = normalizeTextPayload(element.text, context);
    else normalized.shape = normalizeShapePayload(element.shape, context);

    return normalized;
}

export function normalizeTemplateElements(elements) {
    if (elements === undefined || elements === null) return [];
    if (!Array.isArray(elements)) {
        throw templateError("INVALID_TEMPLATE_ELEMENTS", "Template elements must be an array.");
    }
    if (elements.length > OVERLAY_TEMPLATE_LIMITS.maxElements) {
        throw templateError(
            "TEMPLATE_TOO_LARGE",
            `Template may not exceed ${OVERLAY_TEMPLATE_LIMITS.maxElements} elements.`,
        );
    }
    return elements.map((element, index) => normalizeTemplateElement(element, index));
}

// ---------------------------------------------------------------------------
// Document-level normalization / validation
// ---------------------------------------------------------------------------

export function assertSupportedTemplateVersion(version) {
    if (version === undefined || version === null || version === "") {
        return OVERLAY_TEMPLATE_SCHEMA_VERSION;
    }
    const parsed = Number.parseInt(version, 10);
    if (Number.isNaN(parsed) || !SUPPORTED_OVERLAY_TEMPLATE_VERSIONS.includes(parsed)) {
        throw templateError(
            "UNSUPPORTED_TEMPLATE_SCHEMA_VERSION",
            `Unsupported overlay template schema version. Supported versions: ${SUPPORTED_OVERLAY_TEMPLATE_VERSIONS.join(", ")}.`,
            { supported: [...SUPPORTED_OVERLAY_TEMPLATE_VERSIONS], received: version },
        );
    }
    return parsed;
}

export function normalizeTemplateName(name) {
    const clean = typeof name === "string" ? name.trim() : "";
    if (!clean) throw templateError("INVALID_TEMPLATE_NAME", "Template name is required.");
    if (clean.length > OVERLAY_TEMPLATE_LIMITS.nameMaxLength) {
        throw templateError(
            "INVALID_TEMPLATE_NAME",
            `Template name must be at most ${OVERLAY_TEMPLATE_LIMITS.nameMaxLength} characters.`,
        );
    }
    return clean;
}

export function normalizeTemplateDescription(description) {
    if (description === undefined || description === null) return null;
    if (typeof description !== "string") {
        throw templateError("INVALID_TEMPLATE_DESCRIPTION", "Template description must be a string.");
    }
    const clean = description.trim();
    if (!clean) return null;
    if (clean.length > OVERLAY_TEMPLATE_LIMITS.descriptionMaxLength) {
        throw templateError(
            "INVALID_TEMPLATE_DESCRIPTION",
            `Template description must be at most ${OVERLAY_TEMPLATE_LIMITS.descriptionMaxLength} characters.`,
        );
    }
    return clean;
}

function assertPayloadWithinSizeLimit(canvas, elements, metadata) {
    const size = JSON.stringify({ canvas, elements, metadata }).length;
    if (size > OVERLAY_TEMPLATE_LIMITS.maxPayloadBytes) {
        throw templateError(
            "TEMPLATE_TOO_LARGE",
            `Template payload exceeds the ${OVERLAY_TEMPLATE_LIMITS.maxPayloadBytes} byte limit. Media belongs in the asset library, not the template.`,
            { size },
        );
    }
}

/**
 * Validates and normalizes a template document of any origin (local editor
 * state, API response, or imported JSON).
 */
export function normalizeOverlayTemplate(template = {}, { requireName = true } = {}) {
    if (!isPlainObject(template)) {
        throw templateError("INVALID_TEMPLATE_PAYLOAD", "Template payload must be an object.");
    }

    const schemaVersion = assertSupportedTemplateVersion(template.schemaVersion ?? template.version);
    const canvas = normalizeTemplateCanvas(template.canvas);
    const elements = normalizeTemplateElements(template.elements);
    const metadata = isPlainObject(template.metadata) ? { ...template.metadata } : {};

    if (requireName) normalizeTemplateName(template.name);
    const description = normalizeTemplateDescription(template.description);

    assertPayloadWithinSizeLimit(canvas, elements, metadata);

    return {
        format: OVERLAY_TEMPLATE_FORMAT,
        schemaVersion,
        id: optionalString(template.id, 64),
        name: typeof template.name === "string" ? template.name.trim() : "",
        description,
        canvas,
        elements,
        metadata,
        createdAt: template.createdAt ?? null,
        updatedAt: template.updatedAt ?? null,
    };
}

/**
 * Non-throwing validation used by UI surfaces (badges, disabled states).
 * @returns {{ok: boolean, code: string|null, message: string, template: object|null}}
 */
export function validateOverlayTemplate(template) {
    try {
        return { ok: true, code: null, message: "", template: normalizeOverlayTemplate(template) };
    } catch (error) {
        return {
            ok: false,
            code: error?.code || "INVALID_TEMPLATE_PAYLOAD",
            message: error?.message || "Template is not valid.",
            template: null,
        };
    }
}

export function isOverlayTemplateCompatible(template) {
    return validateOverlayTemplate(template).ok;
}

export function isSupportedTemplateVersion(version) {
    const parsed = Number.parseInt(version, 10);
    return SUPPORTED_OVERLAY_TEMPLATE_VERSIONS.includes(parsed);
}

// ---------------------------------------------------------------------------
// Save as Template
// ---------------------------------------------------------------------------

function readOverlayChecksum(overlay) {
    return optionalString(
        overlay?.integrity?.sha256 || overlay?.sha256 || overlay?.checksum,
        64,
    );
}

/**
 * Maps one live overlay segment onto a portable template element.
 * Returns `null` when the overlay cannot be referenced portably.
 */
export function overlayToTemplateElement(overlay, index = 0) {
    if (!isPlainObject(overlay)) return null;

    const baseTransform = normalizeTemplateBaseTransform(overlay.baseTransform, "overlay.baseTransform");
    const keyframes = normalizeTemplateKeyframes(overlay.keyframes);
    const animation = normalizeTemplateAnimation(overlay.animation);
    const mask = normalizeTemplateMask(overlay.mask);
    const rawDuration = Number(overlay.duration);
    const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? round(rawDuration) : null;

    const common = {
        id: `el-${index + 1}`,
        name: optionalString(overlay.name, 120),
        baseTransform,
        keyframes,
        animation,
        mask,
        filterId: optionalString(overlay.filterId, 64),
        layer: boundedInteger(overlay.layer, { min: 1, max: 10, fallback: 2 }),
        // Lanes are assigned at apply time so a template never collides across projects.
        lane: null,
        start: Math.max(0, Number(overlay.start) || 0),
        duration,
    };

    const vectorBody = optionalString(overlay.vectorBody, OVERLAY_TEMPLATE_LIMITS.maxVectorBodyLength);
    if (vectorBody) {
        return {
            ...common,
            kind: "vector",
            vector: normalizeVectorPayload({
                assetId: overlay.assetId || overlay.vectorAssetId,
                body: vectorBody,
                background: overlay.vectorBackground,
                colorSlots: overlay.vectorColorSlots,
                design: overlay.vectorDesign,
            }, "overlay"),
        };
    }

    const assetId = optionalString(overlay.assetId, 64);
    const archiveMediaId = optionalString(overlay.archiveMediaId, 255);
    const checksum = readOverlayChecksum(overlay);
    if (!assetId && !archiveMediaId && !checksum) {
        // A data-URL-only or blob-only overlay has no portable identity.
        return null;
    }

    return {
        ...common,
        kind: "media",
        media: normalizeMediaReference({
            mediaKind: overlay.type === "video" ? "video" : "image",
            assetId,
            archiveMediaId,
            checksum,
            filename: overlay.name,
            mimeType: overlay.mimeType,
            width: overlay.width,
            height: overlay.height,
        }, "overlay"),
    };
}

/**
 * Builds a template document from live editor overlays.
 *
 * @param {object} input
 * @param {object[]} input.overlays all overlay segments in the current project
 * @param {string[]|null} input.selectedIds restrict to specific overlays
 * @param {string} input.name
 * @param {string} [input.description]
 * @param {object} [input.canvas]
 * @param {object} [input.metadata]
 */
export function createTemplateFromOverlays({
    overlays = [],
    selectedIds = null,
    name = "",
    description = "",
    canvas = null,
    metadata = {},
} = {}) {
    const selection = Array.isArray(selectedIds) && selectedIds.length
        ? new Set(selectedIds.map(String))
        : null;

    const source = (Array.isArray(overlays) ? overlays : []).filter((overlay) => (
        isPlainObject(overlay)
        && overlay.hidden !== true
        && (selection ? selection.has(String(overlay.id)) : true)
    ));

    const skipped = [];
    const elements = [];
    source.forEach((overlay) => {
        const element = overlayToTemplateElement(overlay, elements.length);
        if (!element) {
            skipped.push({
                overlayId: overlay.id || "",
                overlayName: overlay.name || "",
                reason: TEMPLATE_ELEMENT_SKIP_REASONS.unportableOverlay,
            });
            return;
        }
        elements.push(element);
    });

    if (!elements.length) {
        throw templateError(
            "TEMPLATE_NO_ELIGIBLE_ELEMENTS",
            "No selected overlay can be saved as a portable template. Add an overlay from the asset library or a vector design.",
            { skipped },
        );
    }
    if (elements.length > OVERLAY_TEMPLATE_LIMITS.maxElements) {
        throw templateError(
            "TEMPLATE_TOO_LARGE",
            `Template may not exceed ${OVERLAY_TEMPLATE_LIMITS.maxElements} elements.`,
        );
    }

    // Rebase timing to the template origin so the design is project-independent.
    const origin = elements.reduce((min, element) => Math.min(min, element.start), elements[0].start);
    const rebased = elements
        .map((element, index) => ({
            ...element,
            id: `el-${index + 1}`,
            start: round(Math.max(0, element.start - origin)),
        }))
        .sort((left, right) => (left.start - right.start) || (left.layer - right.layer));

    return normalizeOverlayTemplate({
        name: normalizeTemplateName(name || "Overlay Template"),
        description,
        schemaVersion: OVERLAY_TEMPLATE_SCHEMA_VERSION,
        canvas: canvas || DEFAULT_TEMPLATE_CANVAS,
        elements: rebased,
        metadata: { ...(isPlainObject(metadata) ? metadata : {}), sourceElementCount: source.length },
    }, { requireName: true });
}

// ---------------------------------------------------------------------------
// Duplicate
// ---------------------------------------------------------------------------

export function duplicateOverlayTemplate(template, { name = "", id = "" } = {}) {
    const normalized = normalizeOverlayTemplate(template);
    const nextName = normalizeTemplateName(
        (typeof name === "string" && name.trim())
        || `${normalized.name} (copy)`.slice(0, OVERLAY_TEMPLATE_LIMITS.nameMaxLength),
    );

    const metadata = { ...normalized.metadata };
    const sourceId = normalized.id || optionalString(normalized.metadata?.duplicatedFrom, 64);
    if (sourceId) metadata.duplicatedFrom = sourceId;

    return {
        ...normalized,
        id: id || makeId("tpl"),
        name: nextName,
        metadata,
        createdAt: null,
        updatedAt: null,
    };
}

/**
 * Strips local-only envelope fields so the payload matches the backend CRUD API.
 */
export function serializeOverlayTemplateForApi(template) {
    const normalized = normalizeOverlayTemplate(template);
    return {
        name: normalized.name,
        description: normalized.description,
        schemaVersion: normalized.schemaVersion,
        canvas: normalized.canvas,
        elements: normalized.elements,
        metadata: normalized.metadata,
    };
}

// ---------------------------------------------------------------------------
// Instantiate / apply
// ---------------------------------------------------------------------------

function buildAssetIndex(assets = []) {
    const byAssetId = new Map();
    const byArchiveMediaId = new Map();
    const byChecksum = new Map();
    (Array.isArray(assets) ? assets : []).forEach((asset) => {
        if (!isPlainObject(asset)) return;
        if (asset.id) byAssetId.set(String(asset.id), asset);
        if (asset.assetId) byAssetId.set(String(asset.assetId), asset);
        if (asset.archiveMediaId) byArchiveMediaId.set(String(asset.archiveMediaId), asset);
        const checksum = readOverlayChecksum(asset);
        if (checksum) byChecksum.set(checksum, asset);
    });
    return { byAssetId, byArchiveMediaId, byChecksum };
}

function resolveMediaAsset(media, index) {
    if (media.assetId && index.byAssetId.has(media.assetId)) return index.byAssetId.get(media.assetId);
    if (media.archiveMediaId && index.byArchiveMediaId.has(media.archiveMediaId)) {
        return index.byArchiveMediaId.get(media.archiveMediaId);
    }
    if (media.checksum && index.byChecksum.has(media.checksum)) return index.byChecksum.get(media.checksum);
    return null;
}

function resolveElementDuration(element, resolvedAsset) {
    if (Number.isFinite(element.duration) && element.duration > 0) return element.duration;
    const assetDuration = Number(resolvedAsset?.duration ?? resolvedAsset?.sourceDuration);
    if (Number.isFinite(assetDuration) && assetDuration > 0) return round(assetDuration);
    return DEFAULT_OVERLAY_SECONDS;
}

function buildMediaOverlayAsset(media, resolvedAsset, element) {
    const layoutWidth = Number(element.layout?.width);
    const layoutHeight = Number(element.layout?.height);
    return {
        id: media.assetId || resolvedAsset?.id || "",
        name: resolvedAsset?.name || element.name || media.filename || "Overlay",
        type: media.mediaKind === "video" ? "video" : "image",
        kind: resolvedAsset?.kind || "",
        src: resolvedAsset?.src || resolvedAsset?.url || "",
        blob: resolvedAsset?.blob,
        // Timeline overlay geometry describes the Studio element box, while the
        // source dimensions remain available for media relinking/diagnostics.
        // This lets cover/contain/fill render inside the exact saved layout.
        width: layoutWidth > 0 ? layoutWidth : (Number(resolvedAsset?.width) || media.width),
        height: layoutHeight > 0 ? layoutHeight : (Number(resolvedAsset?.height) || media.height),
        mediaSourceWidth: Number(resolvedAsset?.width) || media.width,
        mediaSourceHeight: Number(resolvedAsset?.height) || media.height,
        duration: resolvedAsset?.duration,
        trackFrames: resolvedAsset?.trackFrames,
        trackFrameDuration: resolvedAsset?.trackFrameDuration,
    };
}

function buildVectorOverlayAsset(element) {
    const vector = element.vector;
    // The data URL is derived fresh at apply time. It is never persisted as a
    // template identity, so templates stay self-contained and relinkable.
    const src = createVectorSvgDataUrl(vector.body, vector.background || "transparent");
    return {
        id: vector.assetId || "",
        name: element.name || "Vector",
        type: "image",
        kind: "vector",
        src,
        width: VECTOR_VIEWBOX_SIZE,
        height: VECTOR_VIEWBOX_SIZE,
        vectorAssetId: vector.assetId || "",
        vectorBody: vector.body,
        vectorBackground: vector.background,
        vectorColorSlots: vector.colorSlots,
        vectorDesign: vector.design || undefined,
    };
}

function escapeSvgText(value) {
    return String(value ?? "")
        .replaceAll("&", "\u0026amp;")
        .replaceAll("<", "\u0026lt;")
        .replaceAll(">", "\u0026gt;")
        .replaceAll('"', "\u0026quot;")
        .replaceAll("'", "\u0026apos;");
}

function svgDataUrl(body, width, height) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function buildTextOverlayAsset(element) {
    const text = element.text;
    const layout = element.layout || { width: 1000, height: 400 };
    const width = Math.max(1, Number(layout.width) || 1000);
    const height = Math.max(1, Number(layout.height) || 400);
    const fontSize = Math.max(4, Number(text.fontSize) || 48);
    const lineHeight = fontSize * (Number(text.lineHeight) || 1.1);
    const lines = String(text.content ?? "Text").split(/\r?\n/);
    const blockHeight = Math.max(lineHeight, lines.length * lineHeight);
    const anchor = text.align === "left" ? "start" : text.align === "right" ? "end" : "middle";
    const x = text.align === "left" ? 0 : text.align === "right" ? width : width / 2;
    const blockTop = text.verticalAlign === "top"
        ? 0
        : text.verticalAlign === "bottom"
            ? height - blockHeight
            : (height - blockHeight) / 2;
    const shadowOpacity = Math.max(0, Math.min(1, Number(text.shadowOpacity) || 0));
    const filter = shadowOpacity > 0
        ? `<filter id="shadow" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="${Number(text.shadowOffsetX) || 0}" dy="${Number(text.shadowOffsetY) || 0}" stdDeviation="${Math.max(0, Number(text.shadowBlur) || 0) / 2}" flood-color="${escapeSvgText(text.shadowColor || "#000000")}" flood-opacity="${shadowOpacity}"/></filter>`
        : "";
    const tspans = lines.map((line, index) => (
        `<tspan x="${x}" y="${blockTop + fontSize + index * lineHeight}">${escapeSvgText(line || " ")}</tspan>`
    )).join("");
    const body = `${filter}<text text-anchor="${anchor}" fill="${escapeSvgText(text.color || "#ffffff")}" stroke="${escapeSvgText(text.strokeColor || "transparent")}" stroke-width="${Math.max(0, Number(text.strokeWidth) || 0)}" paint-order="stroke fill" font-family="${escapeSvgText(text.fontFamily || "Inter, system-ui, sans-serif")}" font-size="${fontSize}" font-weight="${Number(text.fontWeight) || 700}" font-style="${text.italic ? "italic" : "normal"}" letter-spacing="${Number(text.letterSpacing) || 0}"${filter ? ' filter="url(#shadow)"' : ""}>${tspans}</text>`;
    return {
        id: "",
        name: element.name || "Text",
        type: "image",
        kind: "text",
        src: svgDataUrl(body, width, height),
        width,
        height,
        text: { ...text },
    };
}

function buildShapeOverlayAsset(element) {
    const shape = element.shape;
    const layout = element.layout || { width: 1000, height: 1000 };
    const width = Math.max(1, Number(layout.width) || 1000);
    const height = Math.max(1, Number(layout.height) || 1000);
    const stroke = escapeSvgText(shape.stroke || "transparent");
    const fill = escapeSvgText(shape.fill || "transparent");
    const strokeWidth = Math.max(shape.shapeType === "line" ? 1 : 0, Number(shape.strokeWidth) || 0);
    const inset = strokeWidth / 2;
    let body;
    if (shape.shapeType === "ellipse") {
        body = `<ellipse cx="${width / 2}" cy="${height / 2}" rx="${Math.max(0, width / 2 - inset)}" ry="${Math.max(0, height / 2 - inset)}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
    } else if (shape.shapeType === "triangle") {
        body = `<polygon points="${width / 2},${inset} ${width - inset},${height - inset} ${inset},${height - inset}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round"/>`;
    } else if (shape.shapeType === "line") {
        body = `<line x1="${inset}" y1="${height / 2}" x2="${width - inset}" y2="${height / 2}" stroke="${escapeSvgText(shape.stroke || shape.fill || "#ffffff")}" stroke-width="${strokeWidth}" stroke-linecap="round"/>`;
    } else {
        body = `<rect x="${inset}" y="${inset}" width="${Math.max(0, width - strokeWidth)}" height="${Math.max(0, height - strokeWidth)}" rx="${Math.max(0, Number(shape.radius) || 0)}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
    }
    return {
        id: "",
        name: element.name || "Shape",
        type: "image",
        kind: "shape",
        src: svgDataUrl(body, width, height),
        width,
        height,
        shape: { ...shape },
    };
}

export function createTemplateOverlayRenderSource(overlay) {
    if (overlay?.kind === "text" && overlay.text) {
        return buildTextOverlayAsset({
            kind: "text",
            name: overlay.name,
            text: overlay.text,
            layout: overlay.templateLayout || { width: overlay.width, height: overlay.height },
        }).src;
    }
    if (overlay?.kind === "shape" && overlay.shape) {
        return buildShapeOverlayAsset({
            kind: "shape",
            name: overlay.name,
            shape: overlay.shape,
            layout: overlay.templateLayout || { width: overlay.width, height: overlay.height },
        }).src;
    }
    return overlay?.src || "";
}

export function mapTemplateLayoutToOverlayTransform(layout, canvas, transform = DEFAULT_BASE_TRANSFORM) {
    if (!layout) return { ...transform };
    const canvasWidth = Math.max(1, Number(canvas?.width) || DEFAULT_TEMPLATE_CANVAS.width);
    const canvasHeight = Math.max(1, Number(canvas?.height) || DEFAULT_TEMPLATE_CANVAS.height);
    const width = Math.max(1, Number(layout.width) || 1);
    const height = Math.max(1, Number(layout.height) || 1);
    const sourceRatio = width / height;
    const canvasRatio = canvasWidth / canvasHeight;
    const containWidth = sourceRatio >= canvasRatio ? canvasWidth : canvasHeight * sourceRatio;
    const layoutScale = width / Math.max(1, containWidth);
    return {
        ...transform,
        x: round((((Number(layout.x) || 0) + width / 2) / canvasWidth - 0.5) * 100 + (Number(transform.x) || 0)),
        y: round((((Number(layout.y) || 0) + height / 2) / canvasHeight - 0.5) * 100 + (Number(transform.y) || 0)),
        scale: round(layoutScale * (Number(transform.scale) || 1)),
    };
}

/**
 * Instantiates a template into new overlay segments.
 *
 * Additive only: the returned `overlays` array is `existingOverlays` plus the
 * newly created segments. Nothing existing is removed, reordered or replaced.
 *
 * @param {object} input
 * @param {object} input.template template document (any schema-compatible shape)
 * @param {object[]} [input.existingOverlays] current `visualOverlaySegments`
 * @param {object[]} [input.assets] candidate assets for media relinking
 * @param {number|null} [input.startTime] desired start; defaults to the end of existing overlays
 * @param {object|null} [input.trackLocks] editor track locks (`{ overlay: boolean }`)
 */
export function instantiateTemplate({
    template,
    existingOverlays = [],
    assets = [],
    startTime = null,
    trackLocks = null,
} = {}) {
    const normalized = normalizeOverlayTemplate(template);
    const existing = Array.isArray(existingOverlays) ? existingOverlays : [];

    if (trackLocks?.overlay) {
        return {
            applied: false,
            reason: TEMPLATE_APPLY_REASONS.trackLocked,
            template: normalized,
            overlays: existing,
            created: [],
            skipped: [],
            unresolved: [],
            selectedId: null,
            warnings: ["The overlay track is locked."],
        };
    }

    const index = buildAssetIndex(assets);
    // `Number(null)` is 0, so an omitted startTime must be detected explicitly.
    const hasExplicitStart = startTime !== null
        && startTime !== undefined
        && startTime !== ""
        && Number.isFinite(Number(startTime))
        && Number(startTime) >= 0;
    const baseStart = hasExplicitStart
        ? Number(startTime)
        : existing.reduce(
            (max, overlay) => Math.max(max, (Number(overlay?.start) || 0) + (Number(overlay?.duration) || 0)),
            0,
        );

    const created = [];
    const skipped = [];
    const unresolved = [];

    normalized.elements.forEach((element) => {
        if (!APPLICABLE_ELEMENT_KINDS.includes(element.kind)) {
            skipped.push({
                elementId: element.id,
                kind: element.kind,
                reason: TEMPLATE_ELEMENT_SKIP_REASONS.unsupportedKind,
            });
            return;
        }

        const start = round(Math.max(0, baseStart + element.start));
        let overlayAsset;
        let archiveMediaId = "";

        if (element.kind === "vector") {
            overlayAsset = buildVectorOverlayAsset(element);
        } else if (element.kind === "text") {
            overlayAsset = buildTextOverlayAsset(element);
        } else if (element.kind === "shape") {
            overlayAsset = buildShapeOverlayAsset(element);
        } else {
            const resolved = resolveMediaAsset(element.media, index);
            if (!resolved) {
                // Preserved provenance so the UI can offer a relink action.
                unresolved.push({
                    elementId: element.id,
                    kind: element.kind,
                    reason: TEMPLATE_ELEMENT_SKIP_REASONS.missingAsset,
                    media: { ...element.media },
                });
                return;
            }
            overlayAsset = buildMediaOverlayAsset(element.media, resolved, element);
            archiveMediaId = element.media.archiveMediaId
                || resolved.archiveMediaId
                || resolved.id
                || "";
        }

        if (!overlayAsset?.src) {
            unresolved.push({
                elementId: element.id,
                kind: element.kind,
                reason: TEMPLATE_ELEMENT_SKIP_REASONS.missingAsset,
                media: element.media ? { ...element.media } : null,
            });
            return;
        }

        const duration = resolveElementDuration(element, overlayAsset);
        const baseTransform = mapTemplateLayoutToOverlayTransform(
            element.layout,
            normalized.canvas,
            element.baseTransform,
        );
        const keyframes = element.layout
            ? element.keyframes.map((keyframe) => ({
                time: keyframe.time,
                ...mapTemplateLayoutToOverlayTransform(element.layout, normalized.canvas, keyframe),
            }))
            : element.keyframes;
        const overlay = createVisualOverlaySegment(overlayAsset, start, {
            id: makeId("overlay"),
            duration,
            baseTransform,
            keyframes,
            animation: element.animation,
            mask: element.mask,
            // `createVisualOverlaySegment` accepts any string, so an empty
            // filterId would override its "none" default and change rendering.
            filterId: element.filterId || "none",
            layer: element.layer,
            ...(Number.isInteger(element.lane) ? { lane: element.lane } : {}),
        });

        created.push({
            ...overlay,
            ...(archiveMediaId ? { archiveMediaId } : {}),
            ...(overlayAsset.mediaSourceWidth > 0 ? {
                mediaSourceWidth: overlayAsset.mediaSourceWidth,
            } : {}),
            ...(overlayAsset.mediaSourceHeight > 0 ? {
                mediaSourceHeight: overlayAsset.mediaSourceHeight,
            } : {}),
            ...(element.layout ? { templateLayout: { ...element.layout } } : {}),
            ...(element.text ? { text: { ...element.text } } : {}),
            ...(element.shape ? { shape: { ...element.shape } } : {}),
            ...(element.media ? {
                mediaPresentation: {
                    fit: element.media.fit,
                    positionX: element.media.positionX,
                    positionY: element.media.positionY,
                    zoom: element.media.zoom,
                }
            } : {}),
            hidden: element.visible === false,
            locked: element.locked === true,
            templateCanvas: { ...normalized.canvas },
            templateId: normalized.id || "",
            templateElementId: element.id,
            templateName: normalized.name,
        });
    });

    if (!created.length) {
        return {
            applied: false,
            reason: TEMPLATE_APPLY_REASONS.nothingToApply,
            template: normalized,
            overlays: existing,
            created: [],
            skipped,
            unresolved,
            selectedId: null,
            warnings: buildApplyWarnings(normalized, skipped, unresolved),
        };
    }

    // Lane assignment via the existing lane-packing helper. Existing overlays
    // keep their current lane unless it is genuinely taken.
    const combined = [...existing, ...created];
    const lanes = packTimedSegmentsIntoLanes(combined, { preferredLaneKey: "lane" });
    const laneById = new Map();
    lanes.forEach((lane, laneIndex) => {
        lane.forEach((segment) => laneById.set(segment.id, laneIndex));
    });
    const overlays = combined.map((segment) => {
        const lane = laneById.get(segment.id);
        if (!Number.isInteger(lane)) return segment;
        return segment.lane === lane ? segment : { ...segment, lane };
    });

    // Surface the lane assignment on the created segments too, so callers that
    // select `created[0]` see the same lane that landed on the timeline.
    const createdIds = new Set(created.map((segment) => segment.id));
    const createdWithLanes = overlays.filter((segment) => createdIds.has(segment.id));

    return {
        applied: true,
        reason: TEMPLATE_APPLY_REASONS.applied,
        template: normalized,
        overlays,
        created: createdWithLanes,
        skipped,
        unresolved,
        selectedId: created[0].id,
        warnings: buildApplyWarnings(normalized, skipped, unresolved),
    };
}

function buildApplyWarnings(template, skipped, unresolved) {
    const warnings = [];
    const missing = unresolved.filter((item) => item.reason === TEMPLATE_ELEMENT_SKIP_REASONS.missingAsset);
    if (missing.length) {
        warnings.push(
            `${missing.length} element(s) from "${template.name}" reference media that is not in this project. Relink the asset and apply again.`,
        );
    }
    const unsupported = skipped.filter((item) => item.reason === TEMPLATE_ELEMENT_SKIP_REASONS.unsupportedKind);
    if (unsupported.length) {
        const kinds = [...new Set(unsupported.map((item) => item.kind))].join(", ");
        warnings.push(`${unsupported.length} element(s) of unsupported kind (${kinds}) were not applied.`);
    }
    return warnings;
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

/**
 * Summary used by the template library cards.
 */
export function describeTemplate(template) {
    const normalized = normalizeOverlayTemplate(template);
    const kinds = [...new Set(normalized.elements.map((element) => element.kind))];
    const duration = normalized.elements.reduce(
        (max, element) => Math.max(max, element.start + (element.duration ?? 0)),
        0,
    );
    return {
        id: normalized.id,
        name: normalized.name,
        description: normalized.description,
        schemaVersion: normalized.schemaVersion,
        aspectRatio: normalized.canvas.aspectRatio,
        canvas: normalized.canvas,
        elementCount: normalized.elements.length,
        kinds,
        mediaCount: normalized.elements.filter((element) => element.kind === "media").length,
        vectorCount: normalized.elements.filter((element) => element.kind === "vector").length,
        duration: round(duration),
        updatedAt: normalized.updatedAt,
    };
}
