import { useMemo } from "react";
import { FilmStrip, ImageSquare } from "@phosphor-icons/react";

import {
    buildOverlayTemplateAssetIndex,
    resolveOverlayTemplateMediaAsset,
} from "../lib/overlayTemplateRendererAssets.js";
import { normalizeStudioDocument } from "../lib/overlayTemplateStudio.js";
import { createVectorSvgDataUrl } from "../lib/vectorAssets.js";

const RESIZE_HANDLES = Object.freeze(["nw", "n", "ne", "e", "se", "s", "sw", "w"]);

function toPercent(value, total) {
    return `${(Number(value) / Math.max(1, Number(total))) * 100}%`;
}

function toCanvasWidthUnit(value, canvasWidth) {
    return `${(Number(value) / Math.max(1, Number(canvasWidth))) * 100}cqw`;
}

function verticalAlignment(value) {
    if (value === "top") return "flex-start";
    if (value === "bottom") return "flex-end";
    return "center";
}

function shapeStyle(shape, canvasWidth) {
    const common = {
        width: "100%",
        height: "100%",
        borderStyle: "solid",
        borderColor: shape.stroke || "transparent",
        borderWidth: toCanvasWidthUnit(shape.strokeWidth || 0, canvasWidth),
        background: shape.fill || "transparent",
    };

    if (shape.shapeType === "ellipse") {
        return { ...common, borderRadius: "50%" };
    }
    return {
        ...common,
        borderRadius: toCanvasWidthUnit(shape.radius || 0, canvasWidth),
    };
}

function TextElement({ element, canvas }) {
    const text = element.text || {};
    const shadowColor = text.shadowColor || "#000000";
    const shadowOpacity = Math.max(0, Math.min(1, Number(text.shadowOpacity) || 0));
    const shadow = shadowOpacity > 0
        ? `${toCanvasWidthUnit(text.shadowOffsetX || 0, canvas.width)} ${toCanvasWidthUnit(
            text.shadowOffsetY || 0,
            canvas.width,
        )} ${toCanvasWidthUnit(text.shadowBlur || 0, canvas.width)} color-mix(in srgb, ${shadowColor} ${shadowOpacity * 100}%, transparent)`
        : "none";

    return (
        <div
            className="overlay-template-renderer-text"
            style={{
                alignItems: verticalAlignment(text.verticalAlign),
                color: text.color || "#ffffff",
                fontFamily: text.fontFamily || "Inter, system-ui, sans-serif",
                fontSize: toCanvasWidthUnit(text.fontSize || 72, canvas.width),
                fontStyle: text.italic ? "italic" : "normal",
                fontWeight: text.fontWeight || 700,
                justifyContent: verticalAlignment(text.verticalAlign),
                letterSpacing: toCanvasWidthUnit(text.letterSpacing || 0, canvas.width),
                lineHeight: text.lineHeight || 1.1,
                textAlign: text.align || "center",
                textShadow: shadow,
                WebkitTextStroke: text.strokeWidth
                    ? `${toCanvasWidthUnit(text.strokeWidth, canvas.width)} ${text.strokeColor || "transparent"}`
                    : undefined,
            }}
        >
            <span>{text.content ?? "Text"}</span>
        </div>
    );
}

function ShapeElement({ element, canvas }) {
    const shape = element.shape || {};
    const stroke = shape.stroke || shape.fill || "#ffffff";
    const strokeWidth = toCanvasWidthUnit(
        Math.max(shape.shapeType === "line" ? 1 : 0, shape.strokeWidth || 0),
        canvas.width,
    );

    if (shape.shapeType === "triangle") {
        return (
            <svg
                className="overlay-template-renderer-shape is-triangle"
                viewBox="0 0 1000 1000"
                preserveAspectRatio="none"
                aria-hidden="true"
            >
                <polygon
                    points="500,18 982,982 18,982"
                    fill={shape.fill || "transparent"}
                    stroke={shape.stroke || "transparent"}
                    style={{ strokeWidth }}
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                />
            </svg>
        );
    }

    if (shape.shapeType === "line") {
        return (
            <svg
                className="overlay-template-renderer-shape is-line"
                viewBox="0 0 1000 1000"
                preserveAspectRatio="none"
                aria-hidden="true"
            >
                <line
                    x1="0"
                    y1="500"
                    x2="1000"
                    y2="500"
                    stroke={stroke}
                    style={{ strokeWidth }}
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                />
            </svg>
        );
    }

    return (
        <div
            className={`overlay-template-renderer-shape is-${shape.shapeType || "rect"}`}
            style={shapeStyle(shape, canvas.width)}
        />
    );
}

function VectorElement({ element }) {
    const vector = element.vector || {};
    const source = createVectorSvgDataUrl(
        vector.body || "",
        vector.background || "transparent",
    );
    return (
        <img
            className="overlay-template-renderer-vector"
            src={source}
            alt=""
            draggable={false}
        />
    );
}

function MissingMedia({ element }) {
    return (
        <div className="overlay-template-renderer-missing-media">
            <ImageSquare aria-hidden="true" />
            <span>{element.media?.filename || element.name || "Media unavailable"}</span>
        </div>
    );
}

function MediaElement({ element, asset }) {
    if (!asset) return <MissingMedia element={element} />;

    const media = element.media || {};
    const source = asset.thumbnail || asset.previewSrc || asset.src || asset.url || "";
    if (!source) return <MissingMedia element={element} />;

    const style = {
        objectFit: media.fit || "cover",
        objectPosition: `${media.positionX ?? 50}% ${media.positionY ?? 50}%`,
        transform: `scale(${media.zoom || 1})`,
    };

    if (media.mediaKind === "video" && !asset.thumbnail) {
        return (
            <video
                className="overlay-template-renderer-media"
                src={source}
                style={style}
                muted
                playsInline
                preload="metadata"
                draggable={false}
            />
        );
    }

    return (
        <img
            className="overlay-template-renderer-media"
            src={source}
            style={style}
            alt=""
            crossOrigin={/^https?:/i.test(source) ? "anonymous" : undefined}
            draggable={false}
        />
    );
}

function ElementContent({ element, canvas, assetIndex }) {
    if (element.kind === "text") {
        return <TextElement element={element} canvas={canvas} />;
    }
    if (element.kind === "shape") {
        return <ShapeElement element={element} canvas={canvas} />;
    }
    if (element.kind === "vector") {
        return <VectorElement element={element} />;
    }
    if (element.kind === "media") {
        return (
            <MediaElement
                element={element}
                asset={resolveOverlayTemplateMediaAsset(element.media, assetIndex)}
            />
        );
    }
    return null;
}

function SelectionControls({ element, onResizePointerDown, onRotatePointerDown }) {
    return (
        <>
            <button
                className="overlay-template-renderer-rotate"
                type="button"
                aria-label={`Rotate ${element.name || "element"}`}
                onPointerDown={(event) => {
                    event.stopPropagation();
                    onRotatePointerDown?.(event, element);
                }}
            />
            {RESIZE_HANDLES.map((handle) => (
                <button
                    key={handle}
                    className={`overlay-template-renderer-handle is-${handle}`}
                    type="button"
                    aria-label={`Resize ${element.name || "element"} ${handle}`}
                    onPointerDown={(event) => {
                        event.stopPropagation();
                        onResizePointerDown?.(event, handle, element);
                    }}
                />
            ))}
        </>
    );
}

export function OverlayTemplateRenderer({
    template,
    assets = [],
    selectedElementId = "",
    interactive = false,
    preview = false,
    guides = [],
    className = "",
    ariaLabel = "Overlay template canvas",
    onSelectElement = null,
    onElementPointerDown = null,
    onResizePointerDown = null,
    onRotatePointerDown = null,
    onCanvasPointerDown = null,
}) {
    const document = useMemo(
        () => normalizeStudioDocument(template || {}),
        [template],
    );
    const assetIndex = useMemo(
        () => buildOverlayTemplateAssetIndex(assets),
        [assets],
    );
    const visibleElements = document.elements.filter(
        (element) => element.visible !== false,
    );

    return (
        <div
            className={`overlay-template-renderer ${preview ? "is-preview" : ""} ${className}`.trim()}
            style={{
                aspectRatio: `${document.canvas.width} / ${document.canvas.height}`,
                background: document.canvas.background,
            }}
            role="img"
            aria-label={ariaLabel}
            data-canvas-width={document.canvas.width}
            data-canvas-height={document.canvas.height}
            onPointerDown={(event) => {
                if (event.target === event.currentTarget) {
                    onCanvasPointerDown?.(event);
                }
            }}
        >
            {visibleElements.map((element) => {
                const selected = interactive && element.id === selectedElementId;
                const rotation = Number(element.baseTransform?.rotation) || 0;
                const opacity = Math.max(
                    0,
                    Math.min(1, Number(element.baseTransform?.opacity) || 0),
                );
                return (
                    <div
                        key={element.id}
                        className={`overlay-template-renderer-element is-${element.kind} ${selected ? "is-selected" : ""} ${element.locked ? "is-locked" : ""}`}
                        style={{
                            left: toPercent(element.layout.x, document.canvas.width),
                            top: toPercent(element.layout.y, document.canvas.height),
                            width: toPercent(element.layout.width, document.canvas.width),
                            height: toPercent(element.layout.height, document.canvas.height),
                            opacity,
                            transform: `rotate(${rotation}deg)`,
                            zIndex: element.layer || 1,
                        }}
                        role={interactive ? "button" : undefined}
                        tabIndex={interactive ? 0 : undefined}
                        aria-label={interactive ? `${element.name || element.kind}${element.locked ? ", locked" : ""}` : undefined}
                        data-element-id={element.id}
                        onClick={(event) => {
                            if (!interactive) return;
                            event.stopPropagation();
                            onSelectElement?.(element.id);
                        }}
                        onKeyDown={(event) => {
                            if (!interactive) return;
                            if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                onSelectElement?.(element.id);
                            }
                        }}
                        onPointerDown={(event) => {
                            if (!interactive) return;
                            event.stopPropagation();
                            onSelectElement?.(element.id);
                            if (!element.locked) {
                                onElementPointerDown?.(event, element);
                            }
                        }}
                    >
                        <ElementContent
                            element={element}
                            canvas={document.canvas}
                            assetIndex={assetIndex}
                        />
                        {selected && !element.locked ? (
                            <SelectionControls
                                element={element}
                                onResizePointerDown={onResizePointerDown}
                                onRotatePointerDown={onRotatePointerDown}
                            />
                        ) : null}
                    </div>
                );
            })}

            {guides.includes("center-x") ? <span className="overlay-template-renderer-guide is-center-x" /> : null}
            {guides.includes("center-y") ? <span className="overlay-template-renderer-guide is-center-y" /> : null}
            {guides.includes("left") ? <span className="overlay-template-renderer-guide is-left" /> : null}
            {guides.includes("right") ? <span className="overlay-template-renderer-guide is-right" /> : null}
            {guides.includes("top") ? <span className="overlay-template-renderer-guide is-top" /> : null}
            {guides.includes("bottom") ? <span className="overlay-template-renderer-guide is-bottom" /> : null}

            {visibleElements.length === 0 ? (
                <div className="overlay-template-renderer-empty" aria-hidden="true">
                    <FilmStrip />
                    <span>Blank canvas</span>
                </div>
            ) : null}
        </div>
    );
}
