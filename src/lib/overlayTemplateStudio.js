import {
    DEFAULT_TEMPLATE_CANVAS,
    normalizeOverlayTemplate,
} from "./shortsOverlayTemplates.js";

export const STUDIO_ASPECT_RATIO_PRESETS = Object.freeze([
    Object.freeze({ id: "16:9", label: "Landscape 16:9", width: 1920, height: 1080 }),
    Object.freeze({ id: "9:16", label: "Portrait 9:16", width: 1080, height: 1920 }),
    Object.freeze({ id: "1:1", label: "Square 1:1", width: 1080, height: 1080 }),
    Object.freeze({ id: "4:5", label: "Portrait 4:5", width: 1080, height: 1350 }),
    Object.freeze({ id: "4:3", label: "Landscape 4:3", width: 1440, height: 1080 }),
]);

export const STUDIO_CANVAS_ADAPTATION_MODES = Object.freeze([
    Object.freeze({ id: "fit", label: "Fit proportionally" }),
    Object.freeze({ id: "fill", label: "Fill canvas" }),
    Object.freeze({ id: "stretch", label: "Stretch layout" }),
    Object.freeze({ id: "reposition", label: "Reposition only" }),
]);

export const STUDIO_ELEMENT_KINDS = Object.freeze(["text", "shape", "vector", "media"]);
export const STUDIO_HISTORY_LIMIT = 80;

const DEFAULT_VECTOR_BODY = '<rect x="0" y="0" width="1200" height="1200" rx="180" fill="#7c3aed"/><path d="M310 650l190 190 390-470" fill="none" stroke="#fff" stroke-width="92" stroke-linecap="round" stroke-linejoin="round"/>';

function number(value, fallback = 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, number(value, min)));
}

function round(value, digits = 4) {
    const factor = 10 ** digits;
    return Math.round(number(value) * factor) / factor;
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function nextId(prefix = "element") {
    if (typeof globalThis.crypto?.randomUUID === "function") {
        return `${prefix}-${globalThis.crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function getStudioAspectRatioId(width, height) {
    const safeWidth = Math.max(1, number(width, DEFAULT_TEMPLATE_CANVAS.width));
    const safeHeight = Math.max(1, number(height, DEFAULT_TEMPLATE_CANVAS.height));
    const match = STUDIO_ASPECT_RATIO_PRESETS.find((preset) => (
        Math.abs(preset.width / preset.height - safeWidth / safeHeight) < 0.0001
    ));
    return match?.id || "custom";
}

export function normalizeStudioCanvas(canvas = DEFAULT_TEMPLATE_CANVAS) {
    const width = Math.round(clamp(canvas.width, 16, 10000));
    const height = Math.round(clamp(canvas.height, 16, 10000));
    return {
        aspectRatio: getStudioAspectRatioId(width, height),
        width,
        height,
        background: typeof canvas.background === "string" && canvas.background.trim()
            ? canvas.background.trim().slice(0, 64)
            : "#10131a",
    };
}

function defaultLayout(kind, canvas) {
    const width = kind === "text"
        ? canvas.width * 0.62
        : kind === "shape"
            ? canvas.width * 0.34
            : canvas.width * 0.28;
    const height = kind === "text"
        ? canvas.height * 0.13
        : kind === "shape"
            ? canvas.height * 0.2
            : width;
    return {
        x: round((canvas.width - width) / 2),
        y: round((canvas.height - height) / 2),
        width: round(width),
        height: round(height),
    };
}

function legacyLayout(element, canvas) {
    const transform = element.baseTransform || {};
    const scale = Math.max(0.01, number(transform.scale, 1));
    let aspect = 1;
    if (element.kind === "media") {
        aspect = Math.max(0.01, number(element.media?.width, 1) / Math.max(1, number(element.media?.height, 1)));
    }
    const width = canvas.width * scale;
    const height = element.kind === "text"
        ? canvas.height * Math.min(0.35, Math.max(0.08, scale * 0.2))
        : width / aspect;
    const centerX = canvas.width * (0.5 + number(transform.x) / 100);
    const centerY = canvas.height * (0.5 + number(transform.y) / 100);
    return {
        x: round(centerX - width / 2),
        y: round(centerY - height / 2),
        width: round(width),
        height: round(height),
    };
}

export function getStudioElementLayout(element, canvas) {
    const normalizedCanvas = normalizeStudioCanvas(canvas);
    const source = element?.layout;
    if (!source) return legacyLayout(element || {}, normalizedCanvas);
    return {
        x: round(clamp(source.x, -10000, 20000)),
        y: round(clamp(source.y, -10000, 20000)),
        width: round(clamp(source.width, 1, 20000)),
        height: round(clamp(source.height, 1, 20000)),
    };
}

function commonElement(kind, canvas, options = {}) {
    const layout = options.layout || defaultLayout(kind, canvas);
    return {
        id: options.id || nextId(kind),
        kind,
        name: options.name || `${kind[0].toUpperCase()}${kind.slice(1)}`,
        visible: options.visible !== false,
        locked: options.locked === true,
        layout,
        baseTransform: {
            x: 0,
            y: 0,
            scale: 1,
            rotation: number(options.rotation),
            opacity: clamp(options.opacity ?? 1, 0, 1),
        },
        keyframes: [],
        animation: {
            in: { id: "none", duration: 0.6 },
            out: { id: "none", duration: 0.6 },
        },
        mask: { type: "none", feather: 0, inverted: false },
        filterId: "none",
        layer: Math.max(1, Math.round(number(options.layer, 1))),
        lane: null,
        start: 0,
        duration: null,
    };
}

export function createStudioElement(kind, canvas = DEFAULT_TEMPLATE_CANVAS, options = {}) {
    if (!STUDIO_ELEMENT_KINDS.includes(kind)) {
        throw new TypeError(`Unsupported Studio element kind: ${kind}`);
    }
    const normalizedCanvas = normalizeStudioCanvas(canvas);
    const element = commonElement(kind, normalizedCanvas, options);

    if (kind === "text") {
        element.text = {
            content: typeof options.content === "string" ? options.content : "Your text",
            fontId: options.fontId || "inter",
            fontFamily: options.fontFamily || '"Inter", Inter, system-ui, sans-serif',
            fontSize: Math.round(clamp(options.fontSize ?? 72, 4, 500)),
            fontWeight: Math.round(clamp(options.fontWeight ?? 700, 100, 900)),
            italic: options.italic === true,
            lineHeight: clamp(options.lineHeight ?? 1.1, 0.5, 4),
            letterSpacing: clamp(options.letterSpacing ?? 0, -20, 100),
            color: options.color || "#ffffff",
            strokeColor: options.strokeColor || "",
            strokeWidth: clamp(options.strokeWidth ?? 0, 0, 40),
            shadowColor: options.shadowColor || "#000000",
            shadowBlur: clamp(options.shadowBlur ?? 0, 0, 100),
            shadowOffsetX: clamp(options.shadowOffsetX ?? 0, -200, 200),
            shadowOffsetY: clamp(options.shadowOffsetY ?? 0, -200, 200),
            shadowOpacity: clamp(options.shadowOpacity ?? 0, 0, 1),
            align: options.align || "center",
            verticalAlign: options.verticalAlign || "middle",
            maxWidthPct: 100,
        };
    } else if (kind === "shape") {
        const shapeType = options.shapeType || "rect";
        if (shapeType === "line" && !options.layout) {
            const height = Math.max(16, normalizedCanvas.height * 0.035);
            element.layout = {
                ...element.layout,
                y: round((normalizedCanvas.height - height) / 2),
                height: round(height),
            };
        }
        element.shape = {
            shapeType,
            fill: options.fill || "#7c3aed",
            stroke: options.stroke || "",
            strokeWidth: clamp(options.strokeWidth ?? 0, 0, 40),
            radius: clamp(options.radius ?? 48, 0, 2000),
        };
    } else if (kind === "vector") {
        element.vector = {
            assetId: String(options.assetId || "").slice(0, 64),
            body: options.body || DEFAULT_VECTOR_BODY,
            background: options.background || "transparent",
            colorSlots: [],
            design: null,
        };
    } else {
        const asset = options.asset || options.media || {};
        const assetId = String(asset.assetId || asset.id || "").slice(0, 64);
        const archiveMediaId = String(asset.archiveMediaId || "").slice(0, 255);
        const checksum = String(asset.checksum || asset.sha256 || "").slice(0, 64);
        if (!assetId && !archiveMediaId && !checksum) {
            throw new TypeError("Media elements require a portable asset reference.");
        }
        element.name = options.name || asset.name || "Media";
        element.media = {
            mediaKind: asset.mediaKind || asset.kind || (asset.type === "video" ? "video" : "image"),
            assetId,
            archiveMediaId,
            checksum,
            filename: asset.filename || asset.name || "",
            mimeType: asset.mimeType || asset.type || "",
            width: Math.max(1, Math.round(number(asset.width, 1))),
            height: Math.max(1, Math.round(number(asset.height, 1))),
            fit: options.fit || "cover",
            positionX: clamp(options.positionX ?? 50, 0, 100),
            positionY: clamp(options.positionY ?? 50, 0, 100),
            zoom: clamp(options.zoom ?? 1, 0.1, 10),
        };
    }

    return element;
}

export function normalizeStudioDocument(template = {}) {
    const canvas = normalizeStudioCanvas(template.canvas || DEFAULT_TEMPLATE_CANVAS);
    const normalized = normalizeOverlayTemplate({
        name: template.name || "Untitled Template",
        description: template.description ?? null,
        schemaVersion: template.schemaVersion ?? 1,
        canvas,
        elements: Array.isArray(template.elements) ? template.elements : [],
        metadata: {
            ...(template.metadata || {}),
            studio: true,
        },
        ...(template.id ? { id: template.id } : {}),
        ...(template.ownerId ? { ownerId: template.ownerId } : {}),
        ...(template.createdAt ? { createdAt: template.createdAt } : {}),
        ...(template.updatedAt ? { updatedAt: template.updatedAt } : {}),
    });

    const elements = normalized.elements.map((element, index) => ({
        ...element,
        visible: element.visible !== false,
        locked: element.locked === true,
        layout: getStudioElementLayout(element, canvas),
        layer: index + 1,
    }));

    return { ...normalized, canvas, elements };
}

export function createStudioDocument(options = {}) {
    return normalizeStudioDocument({
        name: options.name || "Untitled Template",
        description: options.description ?? null,
        canvas: normalizeStudioCanvas(options.canvas || DEFAULT_TEMPLATE_CANVAS),
        elements: options.elements || [],
        metadata: {
            createdIn: "overlay-template-studio",
            ...(options.metadata || {}),
        },
    });
}

export function updateStudioElement(document, elementId, updater) {
    const source = normalizeStudioDocument(document);
    const elements = source.elements.map((element) => {
        if (element.id !== elementId) return element;
        const patch = typeof updater === "function" ? updater(clone(element)) : updater;
        return { ...element, ...(patch || {}) };
    });
    return normalizeStudioDocument({ ...source, elements });
}

export function addStudioElement(document, element) {
    const source = normalizeStudioDocument(document);
    return normalizeStudioDocument({
        ...source,
        elements: [...source.elements, { ...element, layer: source.elements.length + 1 }],
    });
}

export function removeStudioElement(document, elementId) {
    const source = normalizeStudioDocument(document);
    return normalizeStudioDocument({
        ...source,
        elements: source.elements.filter((element) => element.id !== elementId),
    });
}

export function duplicateStudioElement(document, elementId) {
    const source = normalizeStudioDocument(document);
    const index = source.elements.findIndex((element) => element.id === elementId);
    if (index < 0) return source;
    const original = source.elements[index];
    const duplicate = clone(original);
    duplicate.id = nextId(original.kind);
    duplicate.name = `${original.name || "Element"} copy`;
    duplicate.layout = {
        ...duplicate.layout,
        x: round(duplicate.layout.x + source.canvas.width * 0.02),
        y: round(duplicate.layout.y + source.canvas.height * 0.02),
    };
    const elements = [...source.elements];
    elements.splice(index + 1, 0, duplicate);
    return normalizeStudioDocument({ ...source, elements });
}

export function reorderStudioElement(document, elementId, targetIndex) {
    const source = normalizeStudioDocument(document);
    const index = source.elements.findIndex((element) => element.id === elementId);
    if (index < 0) return source;
    const nextIndex = Math.round(clamp(targetIndex, 0, source.elements.length - 1));
    const elements = [...source.elements];
    const [element] = elements.splice(index, 1);
    elements.splice(nextIndex, 0, element);
    return normalizeStudioDocument({ ...source, elements });
}

export function adaptStudioDocumentCanvas(document, nextCanvas, mode = "fit") {
    const source = normalizeStudioDocument(document);
    const canvas = normalizeStudioCanvas(nextCanvas);
    if (!STUDIO_CANVAS_ADAPTATION_MODES.some((option) => option.id === mode)) {
        throw new TypeError(`Unsupported canvas adaptation mode: ${mode}`);
    }
    const scaleX = canvas.width / source.canvas.width;
    const scaleY = canvas.height / source.canvas.height;
    const uniform = mode === "fill" ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
    const offsetX = (canvas.width - source.canvas.width * uniform) / 2;
    const offsetY = (canvas.height - source.canvas.height * uniform) / 2;

    const elements = source.elements.map((element) => {
        const layout = getStudioElementLayout(element, source.canvas);
        let nextLayout;
        if (mode === "stretch") {
            nextLayout = {
                x: layout.x * scaleX,
                y: layout.y * scaleY,
                width: layout.width * scaleX,
                height: layout.height * scaleY,
            };
        } else if (mode === "reposition") {
            const centerX = (layout.x + layout.width / 2) / source.canvas.width;
            const centerY = (layout.y + layout.height / 2) / source.canvas.height;
            nextLayout = {
                x: centerX * canvas.width - layout.width / 2,
                y: centerY * canvas.height - layout.height / 2,
                width: layout.width,
                height: layout.height,
            };
        } else {
            nextLayout = {
                x: layout.x * uniform + offsetX,
                y: layout.y * uniform + offsetY,
                width: layout.width * uniform,
                height: layout.height * uniform,
            };
        }
        return {
            ...element,
            layout: Object.fromEntries(Object.entries(nextLayout).map(([key, value]) => [key, round(value)])),
        };
    });

    return normalizeStudioDocument({ ...source, canvas, elements });
}

export function snapStudioLayout(layout, canvas, options = {}) {
    const threshold = Math.max(0, number(options.threshold, 10));
    const safeCanvas = normalizeStudioCanvas(canvas);
    const candidate = { ...layout };
    const guides = [];
    const xTargets = [
        { value: 0, guide: "left" },
        { value: (safeCanvas.width - candidate.width) / 2, guide: "center-x" },
        { value: safeCanvas.width - candidate.width, guide: "right" },
    ];
    const yTargets = [
        { value: 0, guide: "top" },
        { value: (safeCanvas.height - candidate.height) / 2, guide: "center-y" },
        { value: safeCanvas.height - candidate.height, guide: "bottom" },
    ];
    for (const target of xTargets) {
        if (Math.abs(candidate.x - target.value) <= threshold) {
            candidate.x = target.value;
            guides.push(target.guide);
            break;
        }
    }
    for (const target of yTargets) {
        if (Math.abs(candidate.y - target.value) <= threshold) {
            candidate.y = target.value;
            guides.push(target.guide);
            break;
        }
    }
    return {
        layout: Object.fromEntries(Object.entries(candidate).map(([key, value]) => [key, round(value)])),
        guides,
    };
}

export function resizeStudioLayout(layout, handle, delta, options = {}) {
    const minSize = Math.max(1, number(options.minSize, 16));
    const preserveAspect = options.preserveAspect === true;
    const source = { ...layout };
    let left = source.x;
    let top = source.y;
    let right = source.x + source.width;
    let bottom = source.y + source.height;
    if (handle.includes("w")) left += number(delta.x);
    if (handle.includes("e")) right += number(delta.x);
    if (handle.includes("n")) top += number(delta.y);
    if (handle.includes("s")) bottom += number(delta.y);
    if (right - left < minSize) {
        if (handle.includes("w")) left = right - minSize;
        else right = left + minSize;
    }
    if (bottom - top < minSize) {
        if (handle.includes("n")) top = bottom - minSize;
        else bottom = top + minSize;
    }
    if (preserveAspect) {
        const aspect = Math.max(0.01, source.width / Math.max(1, source.height));
        const width = right - left;
        const height = bottom - top;
        if (Math.abs(number(delta.x)) >= Math.abs(number(delta.y))) {
            const nextHeight = width / aspect;
            if (handle.includes("n")) top = bottom - nextHeight;
            else bottom = top + nextHeight;
        } else {
            const nextWidth = height * aspect;
            if (handle.includes("w")) left = right - nextWidth;
            else right = left + nextWidth;
        }
    }
    return {
        x: round(left),
        y: round(top),
        width: round(right - left),
        height: round(bottom - top),
    };
}

export function getStudioDocumentSignature(document) {
    const source = normalizeStudioDocument(document);
    return JSON.stringify({
        name: source.name,
        description: source.description,
        canvas: source.canvas,
        elements: source.elements,
        metadata: source.metadata,
    });
}

export function createStudioHistory(document) {
    const current = normalizeStudioDocument(document);
    return { past: [], current, future: [] };
}

export function pushStudioHistory(history, document, limit = STUDIO_HISTORY_LIMIT) {
    const current = normalizeStudioDocument(document);
    if (getStudioDocumentSignature(history.current) === getStudioDocumentSignature(current)) return history;
    return {
        past: [...history.past, history.current].slice(-Math.max(1, Math.round(number(limit, STUDIO_HISTORY_LIMIT)))),
        current,
        future: [],
    };
}

export function undoStudioHistory(history) {
    const previous = history.past.at(-1);
    if (!previous) return { history, document: history.current, changed: false };
    return {
        history: {
            past: history.past.slice(0, -1),
            current: previous,
            future: [history.current, ...history.future],
        },
        document: previous,
        changed: true,
    };
}

export function redoStudioHistory(history) {
    const next = history.future[0];
    if (!next) return { history, document: history.current, changed: false };
    return {
        history: {
            past: [...history.past, history.current],
            current: next,
            future: history.future.slice(1),
        },
        document: next,
        changed: true,
    };
}
