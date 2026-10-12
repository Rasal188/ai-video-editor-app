import { useEffect, useMemo, useRef, useState } from "react";

import { ensureCaptionFontLoaded } from "../lib/captionFonts.js";
import { drawCaptionLayout, getCaptionTextLayout, positionCaptionLayout } from "../lib/captionLayout.js";
import {
  getActiveWordIndex,
  isKaraokeEnabled,
  isKeywordHighlightEnabled,
  isWordMatchingKeywords,
  resolveActiveWordColor,
  resolveKeywordColor,
  resolveKeywords,
} from "../lib/karaoke.js";

const FALLBACK_PREVIEW_FRAME = { width: 640, height: 360 };

function getCaptionRasterScale() {
  if (typeof window === "undefined") return 2;
  // Canvas text on Windows uses grayscale antialiasing instead of ClearType.
  // A 2x minimum backing store keeps downloaded fonts crisp at 100–150% OS
  // scaling, while the upper bound avoids waste at extreme browser zoom.
  return Math.max(2, Math.min(4, Number(window.devicePixelRatio) || 1));
}

function snapToPhysicalPixel(value, devicePixelRatio) {
  const ratio = Math.max(1, Number(devicePixelRatio) || 1);
  return Math.round(value * ratio) / ratio;
}

export function CaptionOverlay({
  caption = null,
  text,
  captionSize,
  captionStyle,
  placement,
  frameSize,
  currentTime = 0,
  onPointerDown,
  onDoubleClick,
}) {
  const canvasRef = useRef(null);
  const [fontRevision, setFontRevision] = useState(0);
  const [fontStatus, setFontStatus] = useState("ready");
  const renderFrame =
    frameSize?.width > 0 && frameSize?.height > 0 ? frameSize : FALLBACK_PREVIEW_FRAME;
  useEffect(() => {
    let canceled = false;
    const fontId = captionStyle?.fontId || "default";
    if (fontId === "default") {
      setFontStatus("ready");
      return undefined;
    }
    setFontStatus("loading");
    ensureCaptionFontLoaded(captionStyle?.fontId, text)
      .then(() => {
        if (!canceled) {
          setFontStatus("ready");
          setFontRevision((value) => value + 1);
        }
      })
      .catch(() => {
        if (!canceled) {
          setFontStatus("failed");
          setFontRevision((value) => value + 1);
        }
      });
    return () => {
      canceled = true;
    };
  }, [captionStyle?.fontId, text]);
  const isKaraoke = isKaraokeEnabled(captionStyle, caption);
  const isKeywordActive = isKeywordHighlightEnabled(captionStyle, caption);
  const keywords = useMemo(() => (
    isKeywordActive ? resolveKeywords(captionStyle, caption) : []
  ), [isKeywordActive, captionStyle, caption]);
  const keywordColor = resolveKeywordColor(captionStyle, caption);
  const activeWordIndex = useMemo(() => {
    if (!isKaraoke) return -1;
    return getActiveWordIndex(caption?.words, currentTime, caption);
  }, [isKaraoke, caption, currentTime]);

  const layout = useMemo(
    () => {
      // Font pixels change after the asynchronous face load even when the
      // selected font id and text stay the same, so this revision deliberately
      // invalidates the cached measurements.
      void fontRevision;
      return getCaptionTextLayout({
        text,
        captionSize,
        captionStyle,
        words: caption?.words,
        referenceFrame: renderFrame,
        renderFrame,
      });
    },
    [caption?.words, captionSize, captionStyle, fontRevision, renderFrame, text],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !layout.width || !layout.height) {
      return;
    }

    const rasterScale = getCaptionRasterScale();
    canvas.width = Math.max(1, Math.round(layout.width * rasterScale));
    canvas.height = Math.max(1, Math.round(layout.height * rasterScale));
    canvas.style.width = `${layout.width}px`;
    canvas.style.height = `${layout.height}px`;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) {
      return;
    }
    // Use the real backing-store ratio after integer rounding. Scaling by the
    // requested ratio can leave a fractional unused strip that the browser
    // resamples across the complete canvas, softening glyph edges.
    context.setTransform(canvas.width / layout.width, 0, 0, canvas.height / layout.height, 0, 0);
    if ("fontKerning" in context) context.fontKerning = "normal";
    if ("textRendering" in context) context.textRendering = "optimizeLegibility";
    drawCaptionLayout(context, layout, { x: 0, y: 0 }, {
      activeWordIndex,
      activeWordColor: resolveActiveWordColor(captionStyle, caption),
      words: caption?.words,
      captionSegment: caption,
    });
  }, [layout, activeWordIndex, captionStyle, caption]);

  const devicePixelRatio = typeof window === "undefined" ? 1 : Math.max(1, Number(window.devicePixelRatio) || 1);
  const position = positionCaptionLayout(layout, placement);
  const left = `${snapToPhysicalPixel(position.centerX, devicePixelRatio)}px`;
  const top = `${snapToPhysicalPixel(position.centerY, devicePixelRatio)}px`;

  return (
    <button
      className={`caption-overlay caption-preview-interactive ${fontStatus === "loading" ? "is-font-loading" : ""} ${isKaraoke ? "is-karaoke" : ""} ${isKeywordActive ? "is-keyword-highlight" : ""}`}
      type="button"
      aria-label={text}
      aria-busy={fontStatus === "loading"}
      data-active-word-index={activeWordIndex}
      data-karaoke={isKaraoke ? "true" : "false"}
      data-keyword-highlight={isKeywordActive ? "true" : "false"}
      style={{
        width: `${layout.width}px`,
        height: `${layout.height}px`,
        borderRadius: `${layout.metrics.radius}px`,
        left,
        top,
      }}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
    >
      <canvas ref={canvasRef} aria-hidden="true" />
      {Array.isArray(caption?.words) && caption.words.length > 0 ? (
        <div className="caption-words-sr" aria-hidden="true">
          {caption.words.map((w, idx) => {
            const isWordKeyword = isKeywordActive && isWordMatchingKeywords(w.text, keywords);
            const isActive = idx === activeWordIndex;
            return (
              <span
                key={idx}
                className={`caption-word ${isActive ? "is-active" : ""} ${isWordKeyword ? "is-keyword" : ""}`}
                data-word-index={idx}
                data-active={isActive ? "true" : "false"}
                data-keyword={isWordKeyword ? "true" : "false"}
                data-start={w.start}
                data-end={w.end}
                style={
                  isActive
                    ? { color: resolveActiveWordColor(captionStyle, caption) }
                    : isWordKeyword
                    ? { color: keywordColor }
                    : undefined
                }
              >
                {w.text}
              </span>
            );
          })}
        </div>
      ) : null}
      {fontStatus === "loading" ? <span className="caption-font-loading-indicator" aria-hidden="true" /> : null}
    </button>
  );
}
