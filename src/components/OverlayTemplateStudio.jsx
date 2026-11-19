import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import {
    ArrowClockwise,
    ArrowCounterClockwise,
    ArrowDown,
    ArrowLeft,
    ArrowUp,
    CircleNotch,
    Copy,
    Eye,
    EyeSlash,
    FilmStrip,
    FloppyDisk,
    ImageSquare,
    LockKey,
    LockKeyOpen,
    MagnifyingGlassMinus,
    MagnifyingGlassPlus,
    Play,
    Shapes,
    Stack,
    TextT,
    Trash,
    UploadSimple,
    X,
} from "@phosphor-icons/react";

import {
    createOverlayTemplateRequest,
    updateOverlayTemplateRequest,
} from "../lib/overlayTemplateApi.js";
import {
    isSupportedOverlayTemplateImage,
    uploadOverlayTemplateAssetRequest,
} from "../lib/overlayTemplateAssetApi.js";
import {
    ensureCaptionFontLoaded,
    getCaptionFont,
    resolveCaptionFontFamily,
} from "../lib/captionFonts.js";
import {
    adaptStudioDocumentCanvas,
    addStudioElement,
    createStudioElement,
    createStudioHistory,
    duplicateStudioElement,
    getStudioDocumentSignature,
    pushStudioHistory,
    redoStudioHistory,
    removeStudioElement,
    reorderStudioElement,
    resizeStudioLayout,
    snapStudioLayout,
    STUDIO_ASPECT_RATIO_PRESETS,
    STUDIO_CANVAS_ADAPTATION_MODES,
    undoStudioHistory,
    updateStudioElement,
} from "../lib/overlayTemplateStudio.js";
import { serializeOverlayTemplateForApi } from "../lib/shortsOverlayTemplates.js";
import { getVectorAssetById, VECTOR_ASSETS } from "../lib/vectorAssets.js";
import { VISUAL_CLIP_ANIMATION_OPTIONS } from "../lib/visualClipAnimations.js";
import { OverlayTemplateRenderer } from "./OverlayTemplateRenderer.jsx";

const NUMBER_FIELDS = Object.freeze(["x", "y", "width", "height"]);
const STUDIO_FONT_IDS = Object.freeze([
    "default",
    "inter",
    "montserrat",
    "poppins",
    "oswald",
    "playfair-display",
    "merriweather",
    "bebas-neue",
    "noto-sans",
]);
const STUDIO_FONT_CHOICES = Object.freeze(STUDIO_FONT_IDS.map((id) => getCaptionFont(id)));
const SHAPE_TYPES = Object.freeze([
    { id: "rect", label: "Rectangle", shapeType: "rect", radius: 0 },
    { id: "rounded-rect", label: "Rounded rectangle", shapeType: "rect", radius: 64 },
    { id: "ellipse", label: "Ellipse", shapeType: "ellipse", radius: 0 },
    { id: "triangle", label: "Triangle", shapeType: "triangle", radius: 0 },
    { id: "line", label: "Line", shapeType: "line", radius: 0 },
]);
const TEMPLATE_IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/svg+xml,.png,.jpg,.jpeg,.webp,.svg";
const DEFAULT_ZOOM = 100;

function clamp(value, min, max) {
    const numeric = Number(value);
    return Math.min(max, Math.max(min, Number.isFinite(numeric) ? numeric : min));
}

function inputNumber(value, fallback = 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

function studioFontId(text = {}) {
    if (STUDIO_FONT_IDS.includes(text.fontId)) return text.fontId;
    const family = String(text.fontFamily || "").toLowerCase();
    return STUDIO_FONT_CHOICES.find(
        (font) => font.id !== "default" && family.includes(font.family.toLowerCase()),
    )?.id || "default";
}

function isTypingTarget(target) {
    return target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || target?.isContentEditable;
}

function Field({ label, children, className = "" }) {
    return (
        <label className={`overlay-template-studio-field ${className}`.trim()}>
            <span>{label}</span>
            {children}
        </label>
    );
}

function NumberField({ label, value, min, max, step = 1, onChange }) {
    return (
        <Field label={label}>
            <input
                type="number"
                value={Number.isFinite(Number(value)) ? Number(value) : 0}
                min={min}
                max={max}
                step={step}
                onChange={(event) => onChange(inputNumber(event.target.value, value))}
            />
        </Field>
    );
}

function ToggleButton({ active, label, onClick, children }) {
    return (
        <button
            className={active ? "is-active" : ""}
            type="button"
            aria-pressed={active}
            onClick={onClick}
        >
            {children}
            <span>{label}</span>
        </button>
    );
}

function InspectorSection({ title, children }) {
    return (
        <section className="overlay-template-studio-inspector-section">
            <h3>{title}</h3>
            {children}
        </section>
    );
}

function iconForKind(kind) {
    if (kind === "text") return TextT;
    if (kind === "media") return ImageSquare;
    if (kind === "vector") return Stack;
    return Shapes;
}

function animationLabel(id) {
    const labels = {
        none: "None",
        fade: "Fade",
        zoom: "Zoom",
        "slide-left": "Slide left",
        "slide-up": "Slide up",
    };
    return labels[id] || id;
}

export function OverlayTemplateStudio({
    initialTemplate,
    assets = [],
    onBack,
    onSaved,
    onDraftChange,
    onAssetUploaded,
    notify = null,
}) {
    const rootRef = useRef(null);
    const canvasShellRef = useRef(null);
    const interactionRef = useRef(null);
    const mediaInputRef = useRef(null);
    const initialDocument = useMemo(
        () => initialTemplate,
        [initialTemplate],
    );
    const [history, setHistory] = useState(
        () => createStudioHistory(initialDocument),
    );
    const [document, setDocument] = useState(history.current);
    const [savedSignature, setSavedSignature] = useState(
        () => getStudioDocumentSignature(history.current),
    );
    const [selectedElementId, setSelectedElementId] = useState(
        history.current.elements.at(-1)?.id || "",
    );
    const [adaptationMode, setAdaptationMode] = useState("fit");
    const [zoom, setZoom] = useState(DEFAULT_ZOOM);
    const [guides, setGuides] = useState([]);
    const [previewOpen, setPreviewOpen] = useState(false);
    const [saving, setSaving] = useState("");
    const [saveError, setSaveError] = useState("");
    const [fontStatus, setFontStatus] = useState("ready");
    const [uploadingMedia, setUploadingMedia] = useState(false);
    const [importedAssets, setImportedAssets] = useState([]);
    const [selectedVectorId, setSelectedVectorId] = useState("");
    const [selectedShapeType, setSelectedShapeType] = useState("");

    const selectedElement = useMemo(
        () => document.elements.find((element) => element.id === selectedElementId) || null,
        [document.elements, selectedElementId],
    );
    const resolvedAssets = useMemo(() => {
        const combined = [];
        const seen = new Set();
        for (const asset of [...importedAssets, ...(Array.isArray(assets) ? assets : [])]) {
            const reference = asset?.assetId
                || asset?.archiveMediaId
                || asset?.checksum
                || asset?.sha256
                || asset?.id;
            if (!reference || seen.has(reference)) continue;
            seen.add(reference);
            combined.push(asset);
        }
        return combined;
    }, [assets, importedAssets]);
    const visualAssets = useMemo(
        () => resolvedAssets.filter(
            (asset) => asset && ["image", "video"].includes(asset.type),
        ),
        [resolvedAssets],
    );
    const dirty = useMemo(
        () => getStudioDocumentSignature(document) !== savedSignature,
        [document, savedSignature],
    );
    const canUndo = history.past.length > 0;
    const canRedo = history.future.length > 0;

    const commitDocument = useCallback((nextValue) => {
        setDocument((current) => {
            const next = typeof nextValue === "function"
                ? nextValue(current)
                : nextValue;
            setHistory((currentHistory) => pushStudioHistory(currentHistory, next));
            return next;
        });
    }, []);

    const patchElement = useCallback((elementId, patch) => {
        if (!elementId) return;
        commitDocument((current) => updateStudioElement(
            current,
            elementId,
            (element) => (
                typeof patch === "function"
                    ? patch(element)
                    : { ...element, ...patch }
            ),
        ));
    }, [commitDocument]);

    const patchSelected = useCallback((patch) => {
        patchElement(selectedElementId, patch);
    }, [patchElement, selectedElementId]);

    const selectStudioFont = useCallback(async (fontId) => {
        if (!selectedElement || selectedElement.kind !== "text") return;
        const font = getCaptionFont(fontId);
        const previousText = selectedElement.text;
        const nextText = {
            ...previousText,
            fontId: font.id,
            fontFamily: resolveCaptionFontFamily(font.id),
        };
        patchSelected({ text: nextText });
        setFontStatus(font.id === "default" ? "ready" : "loading");
        try {
            await ensureCaptionFontLoaded(font.id, previousText.content);
            setFontStatus("ready");
        } catch {
            patchElement(selectedElement.id, (element) => (
                element.text?.fontId === font.id ? { text: previousText } : element
            ));
            setFontStatus("failed");
            setSaveError(`${font.label} could not be loaded. The previous font was restored.`);
        }
    }, [patchElement, patchSelected, selectedElement]);

    const undo = useCallback(() => {
        setHistory((current) => {
            const transition = undoStudioHistory(current);
            if (transition.changed) {
                setDocument(transition.document);
                setGuides([]);
            }
            return transition.history;
        });
    }, []);

    const redo = useCallback(() => {
        setHistory((current) => {
            const transition = redoStudioHistory(current);
            if (transition.changed) {
                setDocument(transition.document);
                setGuides([]);
            }
            return transition.history;
        });
    }, []);

    const deleteSelected = useCallback(() => {
        if (!selectedElementId) return;
        commitDocument((current) => removeStudioElement(current, selectedElementId));
        setSelectedElementId("");
    }, [commitDocument, selectedElementId]);

    const addElement = useCallback((kind, options = {}) => {
        try {
            if (document.elements.length >= 64) {
                setSaveError("Templates can contain up to 64 elements.");
                return null;
            }
            const element = createStudioElement(kind, document.canvas, options);
            commitDocument((current) => addStudioElement(current, element));
            setSelectedElementId(element.id);
            setSaveError("");
            return element;
        } catch (error) {
            setSaveError(error?.message || "Element could not be added.");
            return null;
        }
    }, [commitDocument, document.canvas, document.elements.length]);

    const addVector = useCallback((vectorId) => {
        const vector = getVectorAssetById(vectorId);
        if (!vector) {
            setSaveError("Choose a valid vector design first.");
            return;
        }
        setSelectedVectorId(vector.id);
        addElement("vector", {
            assetId: vector.id,
            name: vector.name,
            body: vector.vectorBody,
            background: vector.vectorBackground,
        });
    }, [addElement]);

    const addShape = useCallback((shapeId) => {
        const shape = SHAPE_TYPES.find((item) => item.id === shapeId);
        if (!shape) {
            setSaveError("Choose a valid shape first.");
            return;
        }
        setSelectedShapeType(shape.id);
        addElement("shape", {
            shapeType: shape.shapeType,
            radius: shape.radius,
            name: shape.label,
            stroke: shape.shapeType === "line" ? "#7c3aed" : "",
            strokeWidth: shape.shapeType === "line" ? 12 : 0,
        });
    }, [addElement]);

    const addMediaAsset = useCallback((asset) => {
        if (!asset) return null;
        return addElement("media", { asset });
    }, [addElement]);

    const importMediaFiles = useCallback(async (fileList) => {
        const files = Array.from(fileList || []);
        if (!files.length) return;
        const unsupported = files.filter((file) => !isSupportedOverlayTemplateImage(file));
        const supported = files.filter(isSupportedOverlayTemplateImage);
        if (!supported.length) {
            setSaveError("Choose PNG, JPEG, WebP, or safe SVG image files.");
            return;
        }

        const availableSlots = Math.max(0, 64 - document.elements.length);
        const filesToImport = supported.slice(0, availableSlots);
        const capacitySkipped = supported.length - filesToImport.length;
        if (!filesToImport.length) {
            setSaveError("Templates can contain up to 64 elements.");
            return;
        }

        setUploadingMedia(true);
        const failures = [];
        try {
            for (const file of filesToImport) {
                try {
                    const asset = await uploadOverlayTemplateAssetRequest(file);
                    setImportedAssets((current) => [
                        asset,
                        ...current.filter((item) => item.assetId !== asset.assetId),
                    ]);
                    onAssetUploaded?.(asset);
                    addMediaAsset(asset);
                } catch (error) {
                    failures.push(`${file.name}: ${error?.message || "upload failed"}`);
                }
            }
        } finally {
            setUploadingMedia(false);
        }

        const notices = [];
        if (unsupported.length) {
            notices.push(`${unsupported.length} unsupported file${unsupported.length === 1 ? " was" : "s were"} skipped.`);
        }
        if (capacitySkipped) {
            notices.push(`${capacitySkipped} image${capacitySkipped === 1 ? " was" : "s were"} skipped because templates can contain up to 64 elements.`);
        }
        if (failures.length) notices.push(failures.join(" "));
        setSaveError(notices.join(" "));
    }, [addMediaAsset, document.elements.length, onAssetUploaded]);

    const duplicateSelected = useCallback(() => {
        if (!selectedElementId) return;
        let nextSelectedId = "";
        commitDocument((current) => {
            const next = duplicateStudioElement(current, selectedElementId);
            const sourceIndex = current.elements.findIndex(
                (element) => element.id === selectedElementId,
            );
            nextSelectedId = next.elements[sourceIndex + 1]?.id || "";
            return next;
        });
        window.requestAnimationFrame(() => setSelectedElementId(nextSelectedId));
    }, [commitDocument, selectedElementId]);

    const applyRatio = useCallback((ratioId) => {
        const preset = STUDIO_ASPECT_RATIO_PRESETS.find(
            (option) => option.id === ratioId,
        );
        if (!preset) return;
        commitDocument((current) => adaptStudioDocumentCanvas(
            current,
            {
                ...current.canvas,
                width: preset.width,
                height: preset.height,
            },
            adaptationMode,
        ));
    }, [adaptationMode, commitDocument]);

    const applyCustomCanvas = useCallback((patch) => {
        commitDocument((current) => adaptStudioDocumentCanvas(
            current,
            { ...current.canvas, ...patch },
            adaptationMode,
        ));
    }, [adaptationMode, commitDocument]);

    const save = useCallback(async (duplicate = false) => {
        if (saving) return;
        setSaving(duplicate ? "duplicate" : "save");
        setSaveError("");
        try {
            let saved;
            if (!duplicate && document.id) {
                saved = await updateOverlayTemplateRequest(
                    document.id,
                    serializeOverlayTemplateForApi(document),
                );
            } else {
                saved = await createOverlayTemplateRequest({
                    ...document,
                    id: "",
                    ownerId: "",
                    createdAt: "",
                    updatedAt: "",
                    name: duplicate ? `${document.name} Copy` : document.name,
                });
            }
            const nextHistory = createStudioHistory(saved);
            setHistory(nextHistory);
            setDocument(nextHistory.current);
            setSavedSignature(getStudioDocumentSignature(nextHistory.current));
            setSelectedElementId(
                nextHistory.current.elements.find(
                    (element) => element.id === selectedElementId,
                )?.id || nextHistory.current.elements.at(-1)?.id || "",
            );
            onSaved?.(saved, { duplicate });
            notify?.(duplicate
                ? `Saved duplicate “${saved.name}”.`
                : `Saved “${saved.name}”.`);
        } catch (error) {
            const message = error?.message || "Template could not be saved.";
            setSaveError(message);
            notify?.(message);
        } finally {
            setSaving("");
        }
    }, [document, notify, onSaved, saving, selectedElementId]);

    useEffect(() => {
        onDraftChange?.(document, { dirty });
    }, [dirty, document, onDraftChange]);

    useEffect(() => {
        if (!selectedElement || selectedElement.kind !== "text") {
            setFontStatus("ready");
            return undefined;
        }
        const fontId = studioFontId(selectedElement.text);
        if (fontId === "default") {
            setFontStatus("ready");
            return undefined;
        }
        let canceled = false;
        setFontStatus("loading");
        ensureCaptionFontLoaded(fontId, selectedElement.text.content)
            .then(() => {
                if (!canceled) setFontStatus("ready");
            })
            .catch(() => {
                if (!canceled) setFontStatus("failed");
            });
        return () => {
            canceled = true;
        };
    }, [selectedElement]);

    useEffect(() => {
        if (!dirty) return undefined;
        const warn = (event) => {
            event.preventDefault();
            event.returnValue = "";
        };
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [dirty]);

    useEffect(() => {
        const handleKeyDown = (event) => {
            if (!rootRef.current) return;
            const targetInStudio = rootRef.current.contains(event.target)
                || previewOpen;
            if (!targetInStudio) return;

            const modifier = event.ctrlKey || event.metaKey;
            if (modifier && event.key.toLowerCase() === "z") {
                event.preventDefault();
                event.stopImmediatePropagation();
                if (event.shiftKey) redo();
                else undo();
                return;
            }
            if (modifier && event.key.toLowerCase() === "s") {
                event.preventDefault();
                event.stopImmediatePropagation();
                save(event.shiftKey);
                return;
            }
            if (event.key === "Escape" && previewOpen) {
                event.preventDefault();
                event.stopImmediatePropagation();
                setPreviewOpen(false);
                return;
            }
            if (
                (event.key === "Delete" || event.key === "Backspace")
                && !isTypingTarget(event.target)
            ) {
                event.preventDefault();
                event.stopImmediatePropagation();
                deleteSelected();
            }
        };
        window.addEventListener("keydown", handleKeyDown, true);
        return () => window.removeEventListener("keydown", handleKeyDown, true);
    }, [deleteSelected, previewOpen, redo, save, undo]);

    useEffect(() => () => {
        const interaction = interactionRef.current;
        if (interaction) {
            window.removeEventListener("pointermove", interaction.move);
            window.removeEventListener("pointerup", interaction.end);
            window.removeEventListener("pointercancel", interaction.end);
        }
    }, []);

    const beginInteraction = useCallback((event, element, type, handle = "") => {
        if (event.button !== 0 || element.locked) return;
        const canvas = canvasShellRef.current?.querySelector(
            ".overlay-template-renderer",
        );
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const scaleX = document.canvas.width / Math.max(1, rect.width);
        const scaleY = document.canvas.height / Math.max(1, rect.height);
        const startPointer = { x: event.clientX, y: event.clientY };
        const startDocument = document;
        const startLayout = { ...element.layout };
        const startRotation = Number(element.baseTransform?.rotation) || 0;
        const center = {
            x: rect.left + ((element.layout.x + element.layout.width / 2) / document.canvas.width) * rect.width,
            y: rect.top + ((element.layout.y + element.layout.height / 2) / document.canvas.height) * rect.height,
        };
        const startAngle = Math.atan2(
            event.clientY - center.y,
            event.clientX - center.x,
        );
        const interaction = {
            lastDocument: startDocument,
            move: null,
            end: null,
        };

        interaction.move = (moveEvent) => {
            const delta = {
                x: (moveEvent.clientX - startPointer.x) * scaleX,
                y: (moveEvent.clientY - startPointer.y) * scaleY,
            };
            let next;
            if (type === "move") {
                const snapped = snapStudioLayout(
                    {
                        ...startLayout,
                        x: startLayout.x + delta.x,
                        y: startLayout.y + delta.y,
                    },
                    document.canvas,
                    { threshold: 8 * Math.max(scaleX, scaleY) },
                );
                setGuides(snapped.guides);
                next = updateStudioElement(
                    startDocument,
                    element.id,
                    { layout: snapped.layout },
                );
            } else if (type === "resize") {
                next = updateStudioElement(
                    startDocument,
                    element.id,
                    {
                        layout: resizeStudioLayout(
                            startLayout,
                            handle,
                            delta,
                            {
                                preserveAspect: moveEvent.shiftKey,
                                minSize: 16 * Math.max(scaleX, scaleY),
                            },
                        ),
                    },
                );
            } else {
                const angle = Math.atan2(
                    moveEvent.clientY - center.y,
                    moveEvent.clientX - center.x,
                );
                const rotation = startRotation
                    + ((angle - startAngle) * 180) / Math.PI;
                next = updateStudioElement(
                    startDocument,
                    element.id,
                    (current) => ({
                        baseTransform: {
                            ...current.baseTransform,
                            rotation: Math.round(rotation * 10) / 10,
                        },
                    }),
                );
            }
            interaction.lastDocument = next;
            setDocument(next);
        };

        interaction.end = () => {
            window.removeEventListener("pointermove", interaction.move);
            window.removeEventListener("pointerup", interaction.end);
            window.removeEventListener("pointercancel", interaction.end);
            interactionRef.current = null;
            setGuides([]);
            setHistory((current) => pushStudioHistory(
                current,
                interaction.lastDocument,
            ));
        };

        interactionRef.current = interaction;
        window.addEventListener("pointermove", interaction.move);
        window.addEventListener("pointerup", interaction.end);
        window.addEventListener("pointercancel", interaction.end);
        event.preventDefault();
    }, [document]);

    const ratio = document.canvas.width / document.canvas.height;
    const baseCanvasWidth = ratio >= 1 ? 640 : 360;
    const renderedCanvasWidth = Math.round(baseCanvasWidth * zoom / 100);

    return (
        <div
            ref={rootRef}
            className="overlay-template-studio"
            data-testid="overlay-template-studio"
        >
            <header className="overlay-template-studio-toolbar">
                <button
                    className="overlay-template-studio-back"
                    type="button"
                    onClick={() => onBack?.({ document, dirty })}
                    aria-label="Back to template library"
                >
                    <ArrowLeft size={18} />
                    <span>Templates</span>
                </button>

                <label className="overlay-template-studio-name">
                    <span className="sr-only">Template name</span>
                    <input
                        value={document.name}
                        maxLength={120}
                        onChange={(event) => commitDocument({
                            ...document,
                            name: event.target.value,
                        })}
                        aria-label="Template name"
                    />
                    {dirty ? <i title="Unsaved changes" /> : null}
                </label>

                <div className="overlay-template-studio-ratio-controls">
                    <select
                        value={document.canvas.aspectRatio}
                        onChange={(event) => applyRatio(event.target.value)}
                        aria-label="Canvas aspect ratio"
                    >
                        {STUDIO_ASPECT_RATIO_PRESETS.map((preset) => (
                            <option key={preset.id} value={preset.id}>
                                {preset.id}
                            </option>
                        ))}
                        {document.canvas.aspectRatio === "custom" ? (
                            <option value="custom">Custom</option>
                        ) : null}
                    </select>
                    <select
                        value={adaptationMode}
                        onChange={(event) => setAdaptationMode(event.target.value)}
                        aria-label="Aspect ratio adaptation mode"
                    >
                        {STUDIO_CANVAS_ADAPTATION_MODES.map((mode) => (
                            <option key={mode.id} value={mode.id}>
                                {mode.label}
                            </option>
                        ))}
                    </select>
                </div>

                <div className="overlay-template-studio-history">
                    <button type="button" disabled={!canUndo} onClick={undo} aria-label="Undo Studio edit">
                        <ArrowCounterClockwise size={17} />
                    </button>
                    <button type="button" disabled={!canRedo} onClick={redo} aria-label="Redo Studio edit">
                        <ArrowClockwise size={17} />
                    </button>
                </div>

                <div className="overlay-template-studio-save-actions">
                    <button type="button" onClick={() => setPreviewOpen(true)}>
                        <Play size={16} />
                        <span>Preview</span>
                    </button>
                    <button type="button" disabled={Boolean(saving)} onClick={() => save(true)}>
                        {saving === "duplicate" ? <CircleNotch className="is-spinning" size={16} /> : <Copy size={16} />}
                        <span>Save duplicate</span>
                    </button>
                    <button className="is-primary" type="button" disabled={Boolean(saving) || !document.name.trim()} onClick={() => save(false)}>
                        {saving === "save" ? <CircleNotch className="is-spinning" size={16} /> : <FloppyDisk size={16} />}
                        <span>Save</span>
                    </button>
                </div>
            </header>

            <div className="overlay-template-studio-body">
                <aside className="overlay-template-studio-left">
                    <section className="overlay-template-studio-palette">
                        <div className="overlay-template-studio-panel-title">
                            <strong>Add elements</strong>
                            <span>{document.elements.length}/64</span>
                        </div>
                        <div className="overlay-template-studio-palette-grid">
                            <button type="button" onClick={() => addElement("text")}>
                                <TextT size={19} />
                                <span>Text</span>
                            </button>
                            <button
                                type="button"
                                disabled={uploadingMedia}
                                onClick={() => mediaInputRef.current?.click()}
                            >
                                {uploadingMedia
                                    ? <CircleNotch className="is-spinning" size={19} />
                                    : <UploadSimple size={19} />}
                                <span>Media</span>
                            </button>
                            <input
                                ref={mediaInputRef}
                                className="sr-only"
                                type="file"
                                accept={TEMPLATE_IMAGE_ACCEPT}
                                multiple
                                onChange={(event) => {
                                    importMediaFiles(event.target.files);
                                    event.target.value = "";
                                }}
                                aria-label="Import template media"
                            />
                        </div>

                        <div className="overlay-template-studio-picker-section">
                            <strong>Shapes</strong>
                            <div className="overlay-template-studio-shape-grid" role="group" aria-label="Insert shape">
                                {SHAPE_TYPES.map((shape) => (
                                    <button
                                        key={shape.id}
                                        className={selectedShapeType === shape.id ? "is-selected" : ""}
                                        type="button"
                                        aria-label={`Insert ${shape.label}`}
                                        aria-pressed={selectedShapeType === shape.id}
                                        onClick={() => addShape(shape.id)}
                                    >
                                        <span className={`overlay-template-studio-shape-preview is-${shape.id}`} aria-hidden="true" />
                                        <span>{shape.label}</span>
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="overlay-template-studio-picker-section">
                            <strong>Vectors</strong>
                            <div className="overlay-template-studio-vector-grid" role="group" aria-label="Insert vector">
                                {VECTOR_ASSETS.map((asset) => (
                                    <button
                                        key={asset.id}
                                        className={selectedVectorId === asset.id ? "is-selected" : ""}
                                        type="button"
                                        aria-label={`Insert ${asset.name}`}
                                        aria-pressed={selectedVectorId === asset.id}
                                        onClick={() => addVector(asset.id)}
                                    >
                                        <img src={asset.thumbnail} alt="" draggable={false} />
                                        <span>{asset.name}</span>
                                    </button>
                                ))}
                            </div>
                        </div>

                        {visualAssets.length ? (
                            <div className="overlay-template-studio-picker-section">
                                <strong>Available media</strong>
                                <div className="overlay-template-studio-media-grid" role="group" aria-label="Insert available media">
                                    {visualAssets.map((asset) => {
                                        const referenceId = asset.assetId
                                            || asset.archiveMediaId
                                            || asset.checksum
                                            || asset.sha256
                                            || asset.id;
                                        const source = asset.thumbnail || asset.previewSrc || asset.src || asset.url;
                                        return (
                                            <button
                                                key={referenceId}
                                                type="button"
                                                aria-label={`Insert ${asset.name || asset.filename || "media"}`}
                                                onClick={() => addMediaAsset(asset)}
                                            >
                                                {source ? <img src={source} alt="" draggable={false} /> : <ImageSquare size={22} />}
                                                <span>{asset.name || asset.filename || "Media"}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        ) : (
                            <p className="overlay-template-studio-picker-empty">
                                Import PNG, JPEG, WebP, or safe SVG images. Files are saved to your account, not the active project.
                            </p>
                        )}
                    </section>

                    <section className="overlay-template-studio-layers">
                        <div className="overlay-template-studio-panel-title">
                            <strong>Layers</strong>
                            <Stack size={15} />
                        </div>
                        <div className="overlay-template-studio-layer-list">
                            {[...document.elements].reverse().map((element) => {
                                const Icon = iconForKind(element.kind);
                                const index = document.elements.findIndex((item) => item.id === element.id);
                                return (
                                    <div
                                        key={element.id}
                                        className={element.id === selectedElementId ? "is-selected" : ""}
                                    >
                                        <button
                                            className="overlay-template-studio-layer-main"
                                            type="button"
                                            onClick={() => setSelectedElementId(element.id)}
                                        >
                                            <Icon size={15} />
                                            <span>{element.name || element.kind}</span>
                                        </button>
                                        <button
                                            type="button"
                                            aria-label={element.visible === false ? "Show layer" : "Hide layer"}
                                            onClick={() => patchElement(element.id, { visible: element.visible === false })}
                                        >
                                            {element.visible === false ? <EyeSlash size={14} /> : <Eye size={14} />}
                                        </button>
                                        <button
                                            type="button"
                                            aria-label={element.locked ? "Unlock layer" : "Lock layer"}
                                            onClick={() => patchElement(element.id, { locked: !element.locked })}
                                        >
                                            {element.locked ? <LockKey size={14} /> : <LockKeyOpen size={14} />}
                                        </button>
                                        <span className="overlay-template-studio-layer-order">
                                            <button
                                                type="button"
                                                disabled={index >= document.elements.length - 1}
                                                aria-label="Move layer up"
                                                onClick={() => commitDocument((current) => reorderStudioElement(current, element.id, index + 1))}
                                            >
                                                <ArrowUp size={12} />
                                            </button>
                                            <button
                                                type="button"
                                                disabled={index <= 0}
                                                aria-label="Move layer down"
                                                onClick={() => commitDocument((current) => reorderStudioElement(current, element.id, index - 1))}
                                            >
                                                <ArrowDown size={12} />
                                            </button>
                                        </span>
                                    </div>
                                );
                            })}
                            {!document.elements.length ? (
                                <p>Add text, shapes, vectors, or imported media.</p>
                            ) : null}
                        </div>
                    </section>
                </aside>

                <main className="overlay-template-studio-workspace">
                    <div className="overlay-template-studio-workspace-toolbar">
                        <span>{document.canvas.width} × {document.canvas.height}</span>
                        <div>
                            <button type="button" onClick={() => setZoom((value) => clamp(value - 10, 25, 200))} aria-label="Zoom out">
                                <MagnifyingGlassMinus size={15} />
                            </button>
                            <strong>{zoom}%</strong>
                            <button type="button" onClick={() => setZoom((value) => clamp(value + 10, 25, 200))} aria-label="Zoom in">
                                <MagnifyingGlassPlus size={15} />
                            </button>
                            <button type="button" onClick={() => setZoom(DEFAULT_ZOOM)}>Reset</button>
                        </div>
                    </div>
                    <div
                        ref={canvasShellRef}
                        className="overlay-template-studio-canvas-shell"
                        onWheel={(event) => {
                            if (!event.ctrlKey && !event.metaKey) return;
                            event.preventDefault();
                            setZoom((value) => clamp(value + (event.deltaY > 0 ? -5 : 5), 25, 200));
                        }}
                    >
                        <div className="overlay-template-studio-canvas-size" style={{ width: renderedCanvasWidth }}>
                            <OverlayTemplateRenderer
                                template={document}
                                assets={resolvedAssets}
                                selectedElementId={selectedElementId}
                                interactive
                                guides={guides}
                                ariaLabel={`Editing ${document.name}`}
                                onSelectElement={setSelectedElementId}
                                onCanvasPointerDown={() => setSelectedElementId("")}
                                onElementPointerDown={(event, element) => beginInteraction(event, element, "move")}
                                onResizePointerDown={(event, handle, element) => beginInteraction(event, element, "resize", handle)}
                                onRotatePointerDown={(event, element) => beginInteraction(event, element, "rotate")}
                            />
                        </div>
                    </div>
                    {saveError ? <p className="overlay-template-studio-error" role="alert">{saveError}</p> : null}
                    <p className="overlay-template-studio-hint">Drag to move. Drag handles to resize. Hold Shift to preserve aspect ratio. Ctrl/Cmd + wheel zooms.</p>
                </main>

                <aside className="overlay-template-studio-inspector">
                    <InspectorSection title="Canvas">
                        <div className="overlay-template-studio-field-grid">
                            <NumberField label="Width" value={document.canvas.width} min={16} max={10000} onChange={(value) => applyCustomCanvas({ width: value })} />
                            <NumberField label="Height" value={document.canvas.height} min={16} max={10000} onChange={(value) => applyCustomCanvas({ height: value })} />
                        </div>
                        <Field label="Background">
                            <div className="overlay-template-studio-color-field">
                                <input
                                    type="color"
                                    value={/^#[0-9a-f]{6}$/i.test(document.canvas.background) ? document.canvas.background : "#10131a"}
                                    onChange={(event) => commitDocument({
                                        ...document,
                                        canvas: { ...document.canvas, background: event.target.value },
                                    })}
                                />
                                <input
                                    value={document.canvas.background}
                                    maxLength={64}
                                    onChange={(event) => commitDocument({
                                        ...document,
                                        canvas: { ...document.canvas, background: event.target.value },
                                    })}
                                />
                            </div>
                        </Field>
                        <Field label="Description">
                            <textarea
                                rows={2}
                                maxLength={500}
                                value={document.description || ""}
                                onChange={(event) => commitDocument({
                                    ...document,
                                    description: event.target.value,
                                })}
                            />
                        </Field>
                    </InspectorSection>

                    {selectedElement ? (
                        <>
                            <InspectorSection title="Transform">
                                <Field label="Layer name">
                                    <input
                                        value={selectedElement.name || ""}
                                        maxLength={120}
                                        onChange={(event) => patchSelected({ name: event.target.value })}
                                    />
                                </Field>
                                <div className="overlay-template-studio-field-grid">
                                    {NUMBER_FIELDS.map((field) => (
                                        <NumberField
                                            key={field}
                                            label={field[0].toUpperCase() + field.slice(1)}
                                            value={selectedElement.layout[field]}
                                            min={field === "width" || field === "height" ? 1 : -10000}
                                            max={20000}
                                            onChange={(value) => patchSelected({
                                                layout: {
                                                    ...selectedElement.layout,
                                                    [field]: value,
                                                },
                                            })}
                                        />
                                    ))}
                                    <NumberField
                                        label="Rotation"
                                        value={selectedElement.baseTransform.rotation}
                                        min={-3600}
                                        max={3600}
                                        step={0.1}
                                        onChange={(value) => patchSelected({
                                            baseTransform: {
                                                ...selectedElement.baseTransform,
                                                rotation: value,
                                            },
                                        })}
                                    />
                                    <NumberField
                                        label="Opacity"
                                        value={selectedElement.baseTransform.opacity}
                                        min={0}
                                        max={1}
                                        step={0.05}
                                        onChange={(value) => patchSelected({
                                            baseTransform: {
                                                ...selectedElement.baseTransform,
                                                opacity: clamp(value, 0, 1),
                                            },
                                        })}
                                    />
                                </div>
                                <div className="overlay-template-studio-toggle-row">
                                    <ToggleButton
                                        active={selectedElement.visible !== false}
                                        label="Visible"
                                        onClick={() => patchSelected({ visible: selectedElement.visible === false })}
                                    >
                                        {selectedElement.visible === false ? <EyeSlash size={15} /> : <Eye size={15} />}
                                    </ToggleButton>
                                    <ToggleButton
                                        active={selectedElement.locked}
                                        label="Locked"
                                        onClick={() => patchSelected({ locked: !selectedElement.locked })}
                                    >
                                        {selectedElement.locked ? <LockKey size={15} /> : <LockKeyOpen size={15} />}
                                    </ToggleButton>
                                </div>
                            </InspectorSection>

                            {selectedElement.kind === "text" ? (
                                <InspectorSection title="Text">
                                    <Field label="Content">
                                        <textarea
                                            rows={3}
                                            maxLength={500}
                                            value={selectedElement.text.content}
                                            onChange={(event) => patchSelected({
                                                text: { ...selectedElement.text, content: event.target.value },
                                            })}
                                        />
                                    </Field>
                                    <Field label="Font family">
                                        <select
                                            value={studioFontId(selectedElement.text)}
                                            disabled={fontStatus === "loading"}
                                            style={{ fontFamily: selectedElement.text.fontFamily }}
                                            onChange={(event) => selectStudioFont(event.target.value)}
                                        >
                                            {STUDIO_FONT_CHOICES.map((font) => (
                                                <option
                                                    key={font.id}
                                                    value={font.id}
                                                    style={{ fontFamily: resolveCaptionFontFamily(font.id) }}
                                                >
                                                    {font.id === "default" ? "Default (system)" : font.label}
                                                </option>
                                            ))}
                                        </select>
                                        {fontStatus === "loading" ? <small>Loading font…</small> : null}
                                        {fontStatus === "failed" ? <small role="alert">Font unavailable; using the previous or fallback font.</small> : null}
                                    </Field>
                                    <div className="overlay-template-studio-field-grid">
                                        <NumberField label="Size" value={selectedElement.text.fontSize} min={4} max={500} onChange={(value) => patchSelected({ text: { ...selectedElement.text, fontSize: value } })} />
                                        <NumberField label="Weight" value={selectedElement.text.fontWeight} min={100} max={900} step={100} onChange={(value) => patchSelected({ text: { ...selectedElement.text, fontWeight: value } })} />
                                        <NumberField label="Line height" value={selectedElement.text.lineHeight} min={0.5} max={4} step={0.05} onChange={(value) => patchSelected({ text: { ...selectedElement.text, lineHeight: value } })} />
                                        <NumberField label="Tracking" value={selectedElement.text.letterSpacing} min={-20} max={100} step={0.5} onChange={(value) => patchSelected({ text: { ...selectedElement.text, letterSpacing: value } })} />
                                    </div>
                                    <Field label="Color">
                                        <input type="color" value={selectedElement.text.color || "#ffffff"} onChange={(event) => patchSelected({ text: { ...selectedElement.text, color: event.target.value } })} />
                                    </Field>
                                    <div className="overlay-template-studio-toggle-row">
                                        <ToggleButton active={selectedElement.text.italic} label="Italic" onClick={() => patchSelected({ text: { ...selectedElement.text, italic: !selectedElement.text.italic } })}>
                                            <TextT size={15} />
                                        </ToggleButton>
                                    </div>
                                    <Field label="Alignment">
                                        <select value={selectedElement.text.align} onChange={(event) => patchSelected({ text: { ...selectedElement.text, align: event.target.value } })}>
                                            <option value="left">Left</option>
                                            <option value="center">Center</option>
                                            <option value="right">Right</option>
                                        </select>
                                    </Field>
                                </InspectorSection>
                            ) : null}

                            {selectedElement.kind === "shape" ? (
                                <InspectorSection title="Shape">
                                    <Field label="Type">
                                        <select value={selectedElement.shape.shapeType} onChange={(event) => patchSelected({ shape: { ...selectedElement.shape, shapeType: event.target.value } })}>
                                            <option value="rect">Rectangle</option>
                                            <option value="ellipse">Ellipse</option>
                                            <option value="triangle">Triangle</option>
                                            <option value="line">Line</option>
                                        </select>
                                    </Field>
                                    <div className="overlay-template-studio-field-grid">
                                        <Field label="Fill"><input type="color" value={selectedElement.shape.fill || "#7c3aed"} onChange={(event) => patchSelected({ shape: { ...selectedElement.shape, fill: event.target.value } })} /></Field>
                                        <Field label="Stroke"><input type="color" value={selectedElement.shape.stroke || "#ffffff"} onChange={(event) => patchSelected({ shape: { ...selectedElement.shape, stroke: event.target.value } })} /></Field>
                                        <NumberField label="Stroke width" value={selectedElement.shape.strokeWidth} min={0} max={40} onChange={(value) => patchSelected({ shape: { ...selectedElement.shape, strokeWidth: value } })} />
                                        <NumberField label="Radius" value={selectedElement.shape.radius} min={0} max={2000} onChange={(value) => patchSelected({ shape: { ...selectedElement.shape, radius: value } })} />
                                    </div>
                                </InspectorSection>
                            ) : null}

                            {selectedElement.kind === "vector" ? (
                                <InspectorSection title="Vector">
                                    <Field label="Background">
                                        <input
                                            value={selectedElement.vector.background || "transparent"}
                                            onChange={(event) => patchSelected({
                                                vector: { ...selectedElement.vector, background: event.target.value },
                                            })}
                                        />
                                    </Field>
                                    <p className="overlay-template-studio-inspector-note">SVG remains self-contained and is converted to a data URL only while rendering.</p>
                                </InspectorSection>
                            ) : null}

                            {selectedElement.kind === "media" ? (
                                <InspectorSection title="Media">
                                    <Field label="Fit">
                                        <select value={selectedElement.media.fit} onChange={(event) => patchSelected({ media: { ...selectedElement.media, fit: event.target.value } })}>
                                            <option value="cover">Cover</option>
                                            <option value="contain">Contain</option>
                                            <option value="fill">Fill</option>
                                        </select>
                                    </Field>
                                    <div className="overlay-template-studio-field-grid">
                                        <NumberField label="Position X" value={selectedElement.media.positionX} min={0} max={100} onChange={(value) => patchSelected({ media: { ...selectedElement.media, positionX: value } })} />
                                        <NumberField label="Position Y" value={selectedElement.media.positionY} min={0} max={100} onChange={(value) => patchSelected({ media: { ...selectedElement.media, positionY: value } })} />
                                        <NumberField label="Zoom" value={selectedElement.media.zoom} min={0.1} max={10} step={0.1} onChange={(value) => patchSelected({ media: { ...selectedElement.media, zoom: value } })} />
                                    </div>
                                    <p className="overlay-template-studio-inspector-note">Saved by portable asset reference only. Runtime URLs and blobs are never stored in the template.</p>
                                </InspectorSection>
                            ) : null}

                            <InspectorSection title="Animation">
                                <div className="overlay-template-studio-field-grid">
                                    {[
                                        ["in", "Animate in"],
                                        ["out", "Animate out"],
                                    ].map(([phase, label]) => (
                                        <Field key={phase} label={label}>
                                            <select
                                                value={selectedElement.animation[phase].id}
                                                onChange={(event) => patchSelected({
                                                    animation: {
                                                        ...selectedElement.animation,
                                                        [phase]: {
                                                            ...selectedElement.animation[phase],
                                                            id: event.target.value,
                                                        },
                                                    },
                                                })}
                                            >
                                                {VISUAL_CLIP_ANIMATION_OPTIONS.map((option) => (
                                                    <option key={option.id} value={option.id}>{animationLabel(option.id)}</option>
                                                ))}
                                            </select>
                                        </Field>
                                    ))}
                                </div>
                            </InspectorSection>

                            <div className="overlay-template-studio-element-actions">
                                <button type="button" onClick={duplicateSelected}><Copy size={15} />Duplicate</button>
                                <button className="is-danger" type="button" onClick={deleteSelected}><Trash size={15} />Delete</button>
                            </div>
                        </>
                    ) : (
                        <div className="overlay-template-studio-no-selection">
                            <FilmStrip size={28} />
                            <strong>No element selected</strong>
                            <span>Select an element on the canvas or in Layers.</span>
                        </div>
                    )}
                </aside>
            </div>

            {previewOpen ? (
                <div className="overlay-template-studio-preview" role="dialog" aria-modal="true" aria-label="Template preview">
                    <header>
                        <div>
                            <span>Preview</span>
                            <strong>{document.name}</strong>
                        </div>
                        <button type="button" onClick={() => setPreviewOpen(false)} aria-label="Close preview"><X size={20} /></button>
                    </header>
                    <div>
                        <OverlayTemplateRenderer
                            template={document}
                            assets={resolvedAssets}
                            preview
                            ariaLabel={`Preview of ${document.name}`}
                        />
                    </div>
                </div>
            ) : null}
        </div>
    );
}
