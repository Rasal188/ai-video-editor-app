import { getCaptionDisplayText } from "./captionDisplayText.js";
import {
  DEFAULT_CAPTION_FONT_ID,
  resolveCaptionFontFamily,
  resolveCaptionFontWeight,
} from "./captionFonts.js";
import {
  DEFAULT_ACTIVE_WORD_COLOR,
  DEFAULT_KEYWORD_COLOR,
  isKeywordHighlightEnabled,
  resolveKeywordColor,
  resolveKeywords,
  splitLineIntoWordChunks,
} from "./karaoke.js";

const CAPTION_FONT_WEIGHT = 700;
const CAPTION_LINE_HEIGHT = 1.35;
const CAPTION_PADDING_X = 22;
const CAPTION_PADDING_Y = 12;
const CAPTION_MIN_HEIGHT = 44;
const CAPTION_MIN_WIDTH_RATIO = 0.32;
const CAPTION_MAX_WIDTH_RATIO = 0.68;
const CAPTION_MAX_WIDTH = 680;
const CAPTION_RADIUS = 7;
const CAPTION_SHADOW_BLUR = 6;
const CAPTION_SHADOW_OFFSET_Y = 1;
// Caption sizes are authored against a 360px-tall design frame. Subtitles are
// read across the horizontal baseline, so their perceived size should follow
// media height: a 9:16 canvas needs larger type than a 16:9 canvas shown at the
// same width. Width-based/short-edge scaling made portrait captions tiny.
export const CAPTION_DESIGN_HEIGHT = 360;

export const CAPTION_FONT_FAMILY =
  'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

function toPositiveNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizeFrameSize(size) {
  return {
    width: toPositiveNumber(size?.width),
    height: toPositiveNumber(size?.height),
  };
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function getCaptionScale(_referenceFrame, renderFrame) {
  const render = normalizeFrameSize(renderFrame);
  if (!render.height) {
    return 1;
  }
  return render.height / CAPTION_DESIGN_HEIGHT;
}

export function resolveCaptionMetrics({
  captionSize = 14,
  captionStyle = {},
  referenceFrame,
  renderFrame,
} = {}) {
  const frame = normalizeFrameSize(renderFrame);
  const scale = getCaptionScale(referenceFrame, frame);
  const fontSize = Math.max(1, toPositiveNumber(captionSize, 14) * scale);
  const paddingX = toPositiveNumber(captionStyle.paddingX, CAPTION_PADDING_X) * scale;
  const paddingY = toPositiveNumber(captionStyle.paddingY, CAPTION_PADDING_Y) * scale;
  const minWidth = frame.width * CAPTION_MIN_WIDTH_RATIO;
  const maxWidth = Math.max(
    minWidth,
    Math.min(frame.width * CAPTION_MAX_WIDTH_RATIO, CAPTION_MAX_WIDTH * scale),
  );
  const fontId = captionStyle.fontId || DEFAULT_CAPTION_FONT_ID;
  const fontFamily = resolveCaptionFontFamily(fontId);
  const fontWeight = resolveCaptionFontWeight(fontId);

  return {
    scale,
    fontSize,
    fontId,
    fontWeight,
    fontFamily,
    font: `${fontWeight} ${fontSize}px ${fontFamily}`,
    lineHeight: fontSize * CAPTION_LINE_HEIGHT,
    paddingX,
    paddingY,
    minHeight: CAPTION_MIN_HEIGHT * scale,
    minWidth,
    maxWidth,
    radius: toPositiveNumber(captionStyle.radius, CAPTION_RADIUS) * scale,
    shadowBlur: CAPTION_SHADOW_BLUR * scale,
    shadowOffsetY: CAPTION_SHADOW_OFFSET_Y * scale,
  };
}

let measurementContext = null;

export function getCaptionMeasurementContext() {
  if (measurementContext || typeof document === "undefined") {
    return measurementContext;
  }
  const canvas = document.createElement("canvas");
  measurementContext = canvas.getContext("2d");
  return measurementContext;
}

function getGraphemes(text) {
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(text), (item) => item.segment);
  }
  return Array.from(text);
}

function getWrapTokens(text) {
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
    return Array.from(segmenter.segment(text), (item) => item.segment);
  }
  return text.match(/\s+|[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]|[^\s\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+/gu) ?? [];
}

function splitOversizedToken(context, token, maxWidth) {
  const chunks = [];
  let current = "";
  getGraphemes(token).forEach((grapheme) => {
    const candidate = current + grapheme;
    if (current && context.measureText(candidate).width > maxWidth) {
      chunks.push(current);
      current = grapheme;
    } else {
      current = candidate;
    }
  });
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

export function wrapCaptionText(context, text, maxWidth) {
  const safeText = String(text ?? "");
  const paragraphs = safeText.split(/\r?\n/);
  const lines = [];

  paragraphs.forEach((paragraph) => {
    if (!paragraph) {
      lines.push("");
      return;
    }

    let current = "";
    getWrapTokens(paragraph).forEach((token) => {
      const candidate = current + token;
      if (context.measureText(candidate).width <= maxWidth) {
        current = candidate;
        return;
      }

      if (current) {
        lines.push(current.trimEnd());
      }
      const nextToken = token.trimStart();
      if (!nextToken) {
        current = "";
        return;
      }

      if (context.measureText(nextToken).width <= maxWidth) {
        current = nextToken;
        return;
      }

      const chunks = splitOversizedToken(context, nextToken, maxWidth);
      lines.push(...chunks.slice(0, -1));
      current = chunks.at(-1) ?? "";
    });

    lines.push(current.trimEnd());
  });

  return lines.length ? lines : [""];
}

function getFallbackTextWidth(text, fontSize) {
  return getGraphemes(String(text ?? "")).reduce(
    (width, grapheme) => width + (/^[\u0000-\u00ff]$/.test(grapheme) ? fontSize * 0.58 : fontSize),
    0,
  );
}

export function getCaptionTextLayout({
  context = getCaptionMeasurementContext(),
  text = "",
  captionSize = 14,
  captionStyle = {},
  words = null,
  referenceFrame,
  renderFrame,
} = {}) {
  text = getCaptionDisplayText(text);
  const frame = normalizeFrameSize(renderFrame);
  const metrics = resolveCaptionMetrics({ captionSize, captionStyle, referenceFrame, renderFrame: frame });
  if (context) {
    context.font = metrics.font;
  }

  const paragraphWidths = String(text ?? "")
    .split(/\r?\n/)
    .map((paragraph) =>
      context ? context.measureText(paragraph).width : getFallbackTextWidth(paragraph, metrics.fontSize),
    );
  const preferredTextWidth = Math.max(0, ...paragraphWidths);
  const width = clamp(
    preferredTextWidth + metrics.paddingX * 2,
    metrics.minWidth,
    metrics.maxWidth,
  );
  const contentWidth = Math.max(1, width - metrics.paddingX * 2);
  const lines = context
    ? wrapCaptionText(context, text, contentWidth)
    : String(text ?? "").split(/\r?\n/);
  const height = Math.max(
    metrics.minHeight,
    lines.length * metrics.lineHeight + metrics.paddingY * 2,
  );

  return {
    text: String(text ?? ""),
    frame,
    metrics,
    width,
    height,
    contentWidth,
    lines,
    style: captionStyle,
    words: Array.isArray(words) ? words : null,
  };
}

function normalizePlacement(placement) {
  if (typeof placement === "string") {
    const placements = {
      top: { x: 50, y: 18 },
      middle: { x: 50, y: 50 },
      bottom: { x: 50, y: 78 },
    };
    return placements[placement] ?? placements.bottom;
  }
  return {
    x: Number.isFinite(Number(placement?.x)) ? Number(placement.x) : 50,
    y: Number.isFinite(Number(placement?.y)) ? Number(placement.y) : 78,
  };
}

export function resolveCaptionSegmentPlacement(segment, fallbackPlacement = "bottom") {
  return segment?.placement ?? fallbackPlacement;
}

export function positionCaptionLayout(layout, placement) {
  const point = normalizePlacement(placement);
  const frameWidth = Number(layout?.frame?.width) || 0;
  const frameHeight = Number(layout?.frame?.height) || 0;
  const layoutWidth = Number(layout?.width) || 0;
  const layoutHeight = Number(layout?.height) || 0;

  const rawX = (frameWidth * point.x) / 100 - layoutWidth / 2;
  const rawY = (frameHeight * point.y) / 100 - layoutHeight / 2;

  // Portrait 9:16 video layouts require safe-area margins to avoid clipping
  // caption text against display edges or top/bottom mobile UI zones.
  const isPortrait = frameHeight > frameWidth;
  const safeMarginTop = isPortrait
    ? Math.max(16, Math.round(frameHeight * 0.05))
    : Math.max(8, Math.round(frameHeight * 0.03));
  const safeMarginBottom = isPortrait
    ? Math.max(20, Math.round(frameHeight * 0.06))
    : Math.max(8, Math.round(frameHeight * 0.04));
  const safeMarginX = Math.max(8, Math.round(frameWidth * 0.02));

  let x = rawX;
  let y = rawY;

  if (frameWidth > 0 && layoutWidth > 0) {
    const minX = safeMarginX;
    const maxX = frameWidth - layoutWidth - safeMarginX;
    if (maxX >= minX) {
      x = Math.max(minX, Math.min(x, maxX));
    }
  }

  if (frameHeight > 0 && layoutHeight > 0) {
    const minY = safeMarginTop;
    const maxY = frameHeight - layoutHeight - safeMarginBottom;
    if (maxY >= minY) {
      y = Math.max(minY, Math.min(y, maxY));
    } else {
      y = safeMarginTop;
    }
  }

  return {
    x,
    y,
    centerX: x + layoutWidth / 2,
    centerY: y + layoutHeight / 2,
  };
}

function roundedRectPath(context, x, y, width, height, radius) {
  const safeRadius = Math.max(0, Math.min(radius, width / 2, height / 2));
  context.beginPath();
  if (typeof context.roundRect === "function") {
    context.roundRect(x, y, width, height, safeRadius);
    return;
  }
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
  context.closePath();
}

export function drawCaptionLayout(context, layout, position = { x: 0, y: 0 }, options = {}) {
  const { metrics } = layout;
  const style = layout.style ?? {};
  const {
    activeWordIndex = -1,
    activeWordColor = style.activeWordColor || DEFAULT_ACTIVE_WORD_COLOR,
    words = layout.words || null,
  } = options;
  const opacity = Math.max(0, Math.min(1, Number(style.backgroundOpacity ?? 0.62)));
  const borderWidth = Math.max(0, Number(style.borderWidth ?? 0)) * metrics.scale;
  context.save();
  roundedRectPath(context, position.x, position.y, layout.width, layout.height, metrics.radius);
  context.fillStyle = style.backgroundColor || "#05080d";
  context.globalAlpha = opacity;
  context.fill();
  context.globalAlpha = 1;
  if (borderWidth) {
    context.lineWidth = borderWidth;
    context.strokeStyle = style.borderColor || "#ffffff";
    context.stroke();
  }

  context.font = metrics.font;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = style.textColor || "#f5fbff";
  context.shadowColor = style.effect === "neon" ? (style.borderColor || "#35f0dd") : `rgba(0, 0, 0, ${Math.max(0, Math.min(1, Number(style.shadowOpacity ?? 0.45)))})`;
  context.shadowBlur = style.effect === "neon" ? metrics.shadowBlur * 2.6 : metrics.shadowBlur;
  context.shadowOffsetX = 0;
  context.shadowOffsetY = metrics.shadowOffsetY;
  const blockHeight = layout.lines.length * metrics.lineHeight;
  const firstLineY = position.y + (layout.height - blockHeight) / 2 + metrics.lineHeight / 2;

  const isKeywordActive = isKeywordHighlightEnabled(style, options.captionSegment);
  const keywords = isKeywordActive ? resolveKeywords(style, options.captionSegment) : [];
  const keywordColor = resolveKeywordColor(style, options.captionSegment, DEFAULT_KEYWORD_COLOR);
  const defaultTextColor = style.textColor || "#f5fbff";

  let wordCursor = 0;
  layout.lines.forEach((line, index) => {
    const textX = position.x + layout.width / 2;
    const textY = firstLineY + index * metrics.lineHeight;
    const strokeWidth = Math.max(0, Number(style.textStrokeWidth ?? 0)) * metrics.scale;
    if (strokeWidth) {
      context.save();
      context.shadowColor = "transparent";
      context.lineJoin = "round";
      context.miterLimit = 2;
      context.lineWidth = strokeWidth * 2;
      context.strokeStyle = style.textStrokeColor || "#05080d";
      context.strokeText(line, textX, textY, layout.contentWidth);
      context.restore();
    }

    const hasKaraokeHighlight = activeWordIndex >= 0 && Array.isArray(words) && words.length > 0;
    const hasKeywordHighlight = isKeywordActive && keywords.length > 0;

    if (hasKaraokeHighlight || hasKeywordHighlight) {
      const { chunks, nextWordCursor } = splitLineIntoWordChunks(
        line,
        words,
        wordCursor,
        activeWordIndex,
        {
          keywords,
          keywordHighlight: isKeywordActive,
          keywordColor,
          activeWordColor,
          textColor: defaultTextColor,
        }
      );
      wordCursor = nextWordCursor;
      const hasColoredChunk = chunks.some((c) => c.color && c.color !== defaultTextColor);
      if (!hasColoredChunk) {
        context.fillText(line, textX, textY, layout.contentWidth);
      } else {
        const lineWidth = context.measureText(line).width;
        const startX = textX - lineWidth / 2;
        context.textAlign = "left";
        for (const chunk of chunks) {
          if (!chunk.text) continue;
          const chunkStartX = startX + context.measureText(line.slice(0, chunk.offset)).width;
          context.fillStyle = chunk.color || defaultTextColor;
          context.fillText(chunk.text, chunkStartX, textY);
        }
        context.textAlign = "center";
        context.fillStyle = defaultTextColor;
      }
    } else {
      context.fillText(
        line,
        textX,
        textY,
        layout.contentWidth,
      );
    }
  });
  context.restore();
}
