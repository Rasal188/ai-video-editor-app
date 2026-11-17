import { useMemo } from "react";

import {
  EMPTY_VISION_OPTIONS,
  getObjectPositionForCrop,
} from "../lib/editorRuntime.js";
import { resolveSmartFrameCropAtTime, smartFrameCropToPixels } from "../lib/smartFrame.js";
import { resolveVisionAnalysisAtTime } from "../lib/vision.js";

export function usePreviewModel(d) {
  const previewVisionAnalysis = useMemo(
    () => resolveVisionAnalysisAtTime(
      d.previewVisionBaseAnalysis,
      d.previewVisualType === "video" ? d.previewVideoMediaTime : d.previewVisualSourceTime,
    ),
    [
      d.previewVideoMediaTime, d.previewVisionBaseAnalysis, d.previewVisualSourceTime,
      d.previewVisualType,
    ],
  );
  const previewVisionOptions = d.previewVisionRecord?.options ?? EMPTY_VISION_OPTIONS;
  const previewVisionFrameSize = useMemo(() => ({
    width: d.previewFrameSize.width || d.ratio.width,
    height: d.previewFrameSize.height || d.ratio.height,
  }), [d.previewFrameSize.height, d.previewFrameSize.width, d.ratio.height, d.ratio.width]);
  const previewSmartCropRect = useMemo(() => {
    const smartFrame = d.previewSmartFrameOverride === false
      ? null
      : d.previewSmartFrameOverride || d.previewVisualSegment?.smartFrame || d.previewVisualSegment?.visualEffects?.smartFrame;
    const crop = resolveSmartFrameCropAtTime(smartFrame, d.previewVisualSourceTime);
    if (!crop) return null;
    const rect = smartFrameCropToPixels(crop, smartFrame?.sourceSize);
    if (rect) {
      const isFallback = Boolean(
        crop.isFallback ||
        smartFrame?.isFallback ||
        smartFrame?.metadata?.status === "fallback" ||
        smartFrame?.state === "fallback" ||
        crop.state === "fallback"
      );
      rect.isFallback = isFallback;
      rect.state = isFallback ? "fallback" : (crop.state || smartFrame?.state || "tracked");
      rect.confidence = crop.confidence ?? smartFrame?.confidence ?? (isFallback ? 0 : 1);

      console.info("[ShortsStudio Pipeline Diagnostic] Preview stage smart crop evaluated:", {
        isFallback: rect.isFallback,
        state: rect.state,
        confidence: rect.confidence,
        cropX: rect.x,
        normalizedXMin: rect.normalized?.xMin,
        normalizedWidth: rect.normalized?.width,
        smartCropActive: Boolean(!rect.isFallback && rect.state !== "fallback" && rect.confidence > 0),
      });
    }
    return rect;
  }, [d.previewSmartFrameOverride, d.previewVisualSegment?.smartFrame, d.previewVisualSegment?.visualEffects?.smartFrame, d.previewVisualSourceTime]);
  const effectiveCaptionPlacement = d.captionPlacement;
  const previewVisualRenderSrc =
    previewVisionOptions.removeBackground &&
    d.previewVisualType === "image" &&
    previewVisionAnalysis?.cutoutUrl
      ? previewVisionAnalysis.cutoutUrl
      : d.previewVisualSrc;
  const previewVisionMaskUrl =
    previewVisionOptions.removeBackground && d.previewVisualType === "video"
      ? previewVisionAnalysis?.cutoutUrl ?? ""
      : "";
  const previewVisualObjectFit = previewSmartCropRect?.presentation === "safe-contain"
    ? "contain"
    : previewSmartCropRect
      ? "cover"
      : (d.previewVisualSegment?.cropX !== undefined || d.previewVisualSegment?.fitMode === "cover" ? "cover" : d.fitMode);
  const defaultVisualPosition = d.previewVisualSegment?.objectPosition
    || (Number.isFinite(d.previewVisualSegment?.cropX) ? `${(Math.max(0, Math.min(1, d.previewVisualSegment.cropX)) * 100).toFixed(1)}% 50.0%` : "50% 50%");
  const previewVisualObjectPosition = previewSmartCropRect
    ? previewSmartCropRect.presentation === "safe-contain"
      ? "50% 50%"
      : getObjectPositionForCrop(previewSmartCropRect)
    : defaultVisualPosition;
  const previewSmartBackgroundPosition = previewSmartCropRect
    ? getObjectPositionForCrop(previewSmartCropRect)
    : defaultVisualPosition;

  return {
    effectiveCaptionPlacement, previewSmartCropRect, previewVisionAnalysis,
    previewVisionFrameSize, previewVisionMaskUrl, previewVisionOptions,
    previewSmartBackgroundPosition, previewVisualObjectFit, previewVisualObjectPosition,
    previewVisualRenderSrc,
  };
}
