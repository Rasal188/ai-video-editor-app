/**
 * @file shortsRepackaging.js
 * AI Shorts Studio — Multi-Platform Aspect Ratio & Smart Repackaging Engine.
 *
 * Implements Phase 2 Priority 8:
 * 1. Multi-Platform Aspect Ratio Definitions:
 *    - 9:16 vertical (1080x1920) - YouTube Shorts, TikTok, Instagram Reels.
 *    - 1:1 square (1080x1080) - Instagram Feed, LinkedIn, Twitter/X.
 *    - 4:5 portrait feed (1080x1350) - Instagram Portrait Feed, Facebook Feed.
 *    - 16:9 landscape (1920x1080) - YouTube Standard, Desktop, TV.
 * 2. Smart Reframing & Crop Geometry:
 *    - Calculates target crop dimensions for any source/target aspect ratio pair.
 *    - Centers tracked faces with sensible headroom and framing stability.
 *    - Provides deterministic center-crop fallback when tracking data is unavailable.
 *    - Safely handles extreme aspect ratios (ultra-wide 32:9, ultra-tall 9:32) and invalid dimensions.
 * 3. Platform-Aware Safe Areas & Collisions:
 *    - Configurable safe-area profiles per format (protecting top/bottom social UI chrome).
 *    - Coordinates captions, animated callouts, Priority 6 overlays, and hook title cards.
 *    - Avoids visual collisions with tracked subjects.
 * 4. Smart Repackaging Pipeline:
 *    - Adapts an analyzed candidate to single or multiple target formats without re-running analysis.
 *    - Reuses semantic scores, narrative arcs, acoustic features, punch-ins, overlays, and transcript.
 *    - Preserves clip timing and source duration strictly across all target formats.
 *    - Pure, deterministic, and non-destructive (original project and candidate remain unmutated).
 * 5. Preview & Export Integration:
 *    - Generates standardized project representations and export specifications compatible with
 *      both Browser Canvas / WebCodecs export and headless FFmpeg render plans.
 */

import { makeId } from "./timeline.js";
import {
  calculateTargetCropDimensions,
  buildDynamicReframingTrack,
  generateFallbackReframingTrack,
  extractGenuineFaceDetections,
  isGenuineFaceDetection,
  REFRAMING_ASPECT_RATIOS,
} from "./shortsReframing.js";
import { resolveOverlayPlacement } from "./shortsOverlays.js";
import { resolveSafeCaptionPlacement } from "./shortsMotionTypography.js";

export const SUPPORTED_REPACKAGING_RATIOS = Object.freeze(["9:16", "1:1", "4:5", "16:9"]);

export const REPACKAGING_RATIO_DEFINITIONS = Object.freeze({
  "9:16": {
    id: "9:16",
    label: "Vertical 9:16",
    width: 1080,
    height: 1920,
    aspectRatio: 9 / 16,
    orientation: "portrait",
    platform: "YouTube Shorts / TikTok / Instagram Reels",
    safeArea: {
      top: 0.08, // 8% top header margin
      bottom: 0.22, // 22% bottom UI chrome margin (metadata, sound, action buttons)
      left: 0.06,
      right: 0.06,
    },
    titleCardSafeZone: { x: 50, y: 20, maxWidth: 0.82 },
    defaultCaptionPlacement: { x: 50, y: 78 },
  },
  "1:1": {
    id: "1:1",
    label: "Square 1:1",
    width: 1080,
    height: 1080,
    aspectRatio: 1.0,
    orientation: "square",
    platform: "Instagram Feed / LinkedIn / Twitter (X)",
    safeArea: {
      top: 0.06,
      bottom: 0.10,
      left: 0.06,
      right: 0.06,
    },
    titleCardSafeZone: { x: 50, y: 16, maxWidth: 0.84 },
    defaultCaptionPlacement: { x: 50, y: 82 },
  },
  "4:5": {
    id: "4:5",
    label: "Portrait Feed 4:5",
    width: 1080,
    height: 1350,
    aspectRatio: 4 / 5,
    orientation: "portrait",
    platform: "Instagram Portrait Feed / Facebook Feed",
    safeArea: {
      top: 0.06,
      bottom: 0.14,
      left: 0.06,
      right: 0.06,
    },
    titleCardSafeZone: { x: 50, y: 18, maxWidth: 0.84 },
    defaultCaptionPlacement: { x: 50, y: 80 },
  },
  "16:9": {
    id: "16:9",
    label: "Landscape 16:9",
    width: 1920,
    height: 1080,
    aspectRatio: 16 / 9,
    orientation: "landscape",
    platform: "YouTube Landscape / Desktop / TV",
    safeArea: {
      top: 0.05,
      bottom: 0.08,
      left: 0.05,
      right: 0.05,
    },
    titleCardSafeZone: { x: 50, y: 14, maxWidth: 0.88 },
    defaultCaptionPlacement: { x: 50, y: 84 },
  },
});

const clamp = (val, min = 0, max = 1) => Math.max(min, Math.min(max, Number(val) || 0));

/**
 * Normalizes an aspect ratio string or object into a canonical ratio ID.
 */
export function normalizeTargetRatio(ratioInput) {
  if (!ratioInput) return "9:16";
  const id = typeof ratioInput === "string" ? ratioInput.trim() : String(ratioInput?.id || "").trim();
  if (REPACKAGING_RATIO_DEFINITIONS[id]) return id;

  // Support numeric aspects like 1, 0.5625, 0.8, 1.777
  const num = Number(ratioInput);
  if (Number.isFinite(num) && num > 0) {
    if (Math.abs(num - 9 / 16) < 0.05) return "9:16";
    if (Math.abs(num - 1.0) < 0.05) return "1:1";
    if (Math.abs(num - 4 / 5) < 0.05) return "4:5";
    if (Math.abs(num - 16 / 9) < 0.05) return "16:9";
  }

  return "9:16";
}

/**
 * Retrieves the complete configuration definition for a target aspect ratio.
 */
export function getRepackagingRatioDefinition(ratioInput) {
  const canonical = normalizeTargetRatio(ratioInput);
  return REPACKAGING_RATIO_DEFINITIONS[canonical] || REPACKAGING_RATIO_DEFINITIONS["9:16"];
}

/**
 * Resolves the platform-specific safe area margins for a target format.
 */
export function resolvePlatformSafeArea(targetRatio, customOverrides = null) {
  const def = getRepackagingRatioDefinition(targetRatio);
  const base = def.safeArea;
  if (!customOverrides || typeof customOverrides !== "object") {
    return { ...base };
  }
  return {
    top: Number.isFinite(Number(customOverrides.top)) ? Number(customOverrides.top) : base.top,
    bottom: Number.isFinite(Number(customOverrides.bottom)) ? Number(customOverrides.bottom) : base.bottom,
    left: Number.isFinite(Number(customOverrides.left)) ? Number(customOverrides.left) : base.left,
    right: Number.isFinite(Number(customOverrides.right)) ? Number(customOverrides.right) : base.right,
  };
}

/**
 * Calculates deterministic crop coordinates for a given source dimension and target ratio.
 * Incorporates face tracking, headroom preservation, and handles extreme/invalid source geometries.
 */
export function calculateRepackagingCrop(params = {}) {
  const sourceSize = params.sourceSize || {
    width: params.sourceWidth,
    height: params.sourceHeight,
  };
  const targetRatio = params.targetRatio || "9:16";
  const cropX = params.cropX;
  const options = params.options || {};

  // Extract faceBox from params.faceBox, params.faceDetections, or options
  let faceBox = params.faceBox || null;
  if (!faceBox && Array.isArray(params.faceDetections) && params.faceDetections.length > 0) {
    for (const d of params.faceDetections) {
      if (Array.isArray(d?.faces) && d.faces.length > 0) {
        const f = d.faces[0];
        if (f && typeof f === "object") {
          faceBox = f;
          break;
        }
      }
    }
  }

  // Normalize faceBox coordinates if present
  let normalizedFace = null;
  if (faceBox) {
    const rawX = faceBox.x ?? faceBox.xMin ?? faceBox.xmin;
    const rawY = faceBox.y ?? faceBox.yMin ?? faceBox.ymin;
    let rawW = faceBox.width ?? faceBox.w;
    let rawH = faceBox.height ?? faceBox.h;
    if (rawW === undefined && faceBox.xMax !== undefined && rawX !== undefined) {
      rawW = faceBox.xMax - rawX;
    }
    if (rawH === undefined && faceBox.yMax !== undefined && rawY !== undefined) {
      rawH = faceBox.yMax - rawY;
    }
    if (Number.isFinite(Number(rawX)) && Number.isFinite(Number(rawY)) && Number.isFinite(Number(rawW)) && Number(rawW) > 0) {
      normalizedFace = {
        x: Number(rawX),
        y: Number(rawY),
        width: Number(rawW),
        height: Number(rawH) || 0.15,
      };
    }
  }

  const canonicalRatio = normalizeTargetRatio(targetRatio);
  const ratioDef = getRepackagingRatioDefinition(canonicalRatio);

  // Sanitize source size (guarantee positive numbers, default 1920x1080)
  const rawW = Number(sourceSize?.width);
  const rawH = Number(sourceSize?.height);
  const sw = Number.isFinite(rawW) && rawW > 0 ? rawW : 1920;
  const sh = Number.isFinite(rawH) && rawH > 0 ? rawH : 1080;
  const sourceAspect = sw / sh;
  const targetAspect = ratioDef.aspectRatio;

  // Calculate normalized crop window dimensions (cropW, cropH in 0..1 relative to source)
  let cropW = 1.0;
  let cropH = 1.0;

  if (targetAspect < sourceAspect) {
    // Target is narrower than source (e.g. 16:9 source to 9:16, 4:5, or 1:1 target)
    cropW = clamp(targetAspect / sourceAspect, 0.05, 1.0);
    cropH = 1.0;
  } else {
    // Target is wider than source (e.g. 9:16 source to 16:9 or 1:1 target)
    cropW = 1.0;
    cropH = clamp(sourceAspect / targetAspect, 0.05, 1.0);
  }

  cropW = Number(cropW.toFixed(4));
  cropH = Number(cropH.toFixed(4));

  // Determine horizontal positioning (cropX)
  let x = 0;
  let y = 0;
  let trackingUsed = false;

  if (normalizedFace) {
    // Center crop on tracked face center
    const faceCenter = normalizedFace.x + normalizedFace.width / 2;
    const leadX = Number(options.leadX) || 0;
    let idealX = faceCenter - cropW / 2 + leadX;

    // Keep face within crop window if it fits
    if (normalizedFace.width <= cropW) {
      if (normalizedFace.x < idealX) idealX = normalizedFace.x;
      else if (normalizedFace.x + normalizedFace.width > idealX + cropW) idealX = normalizedFace.x + normalizedFace.width - cropW;
    }
    x = clamp(idealX, 0, 1 - cropW);

    // Headroom preservation: ensure top of face doesn't collide with upper edge
    if (cropH < 0.999) {
      const idealY = Math.max(0, normalizedFace.y - 0.10); // Maintain 10% headroom above face
      y = clamp(idealY, 0, 1 - cropH);
    } else {
      y = clamp(0.5 - cropH / 2, 0, 1 - cropH);
    }
    trackingUsed = true;
  } else {
    // Center-crop fallback using manual cropX or default 0.5
    const manualX = Number.isFinite(cropX) ? clamp(cropX) : 0.5;
    x = clamp(manualX * (1 - cropW), 0, 1 - cropW);
    y = clamp(0.5 - cropH / 2, 0, 1 - cropH);
  }

  x = Number(x.toFixed(4));
  y = Number(y.toFixed(4));
  const panFactor = (1 - cropW) > 0.0001 ? Number((x / (1 - cropW)).toFixed(4)) : 0.5;

  const pixelCrop = {
    x: Math.round(x * sw),
    y: Math.round(y * sh),
    width: Math.max(2, Math.round(cropW * sw)),
    height: Math.max(2, Math.round(cropH * sh)),
  };

  const presentation = trackingUsed ? "face-tracked" : "center-fallback";

  return {
    targetRatio: canonicalRatio,
    sourceSize: { width: sw, height: sh },
    normalized: { x, y, width: cropW, height: cropH },
    cropWidth: cropW,
    cropHeight: cropH,
    cropX: x,
    cropY: y,
    cropXMin: x,
    panFactor,
    pixels: pixelCrop,
    outputDimensions: { width: ratioDef.width, height: ratioDef.height },
    presentation,
    trackingUsed,
    isCenterFallback: !trackingUsed,
  };
}

/**
 * Resolves a safe layout for an opening title hook card tailored for targetRatio.
 */
export function resolveTitleCardLayout(firstArg, secondArg = null, thirdArg = {}) {
  let title = "";
  let targetRatio = "9:16";
  let safeArea = null;
  let faceBox = null;
  let options = {};

  if (typeof firstArg === "string") {
    targetRatio = firstArg;
    faceBox = secondArg;
    options = thirdArg || {};
    title = options.title || "";
    safeArea = options.safeArea || null;
  } else if (firstArg && typeof firstArg === "object") {
    title = firstArg.title || "";
    targetRatio = firstArg.targetRatio || "9:16";
    safeArea = firstArg.safeArea || null;
    faceBox = firstArg.faceBox || null;
    options = firstArg.options || {};
  }

  const canonicalRatio = normalizeTargetRatio(targetRatio);
  const ratioDef = getRepackagingRatioDefinition(canonicalRatio);
  const safe = safeArea || resolvePlatformSafeArea(canonicalRatio);

  const baseZone = ratioDef.titleCardSafeZone;
  let posY = baseZone.y;
  let posX = baseZone.x;

  // Collision avoidance with tracked face in upper-third
  let faceCollisionAvoided = false;
  if (faceBox) {
    const rawY = faceBox.y ?? faceBox.yMin ?? faceBox.ymin;
    const rawH = faceBox.height ?? (faceBox.yMax && rawY !== undefined ? faceBox.yMax - rawY : 0.15);
    if (Number.isFinite(Number(rawY))) {
      const yVal = Number(rawY);
      if (yVal < 0.28) {
        posY = Math.min(65, Math.round((yVal + (Number(rawH) || 0.15) + 0.08) * 100));
        faceCollisionAvoided = true;
      }
    }
  }

  // Clamping within safe area bounds
  const minY = safe.top * 100 + 2;
  const maxY = (1 - safe.bottom) * 100 - 15;
  posY = Math.max(minY, Math.min(maxY, posY));

  const fontSize = canonicalRatio === "9:16" ? 28 : (canonicalRatio === "4:5" ? 26 : (canonicalRatio === "1:1" ? 24 : 32));
  const position = faceCollisionAvoided ? "upper-middle" : "top-center";

  return {
    title: String(title || "").trim(),
    targetRatio: canonicalRatio,
    position,
    placement: { x: posX, y: posY },
    x: posX,
    y: posY,
    maxWidthRatio: baseZone.maxWidth,
    fontSize,
    faceCollisionAvoided,
    collisionAvoided: faceCollisionAvoided,
  };
}

/**
 * Adapts punch-in keyframes from a source ratio to a target aspect ratio.
 */
export function adaptPunchInsForTargetRatio(firstArg, secondArg = null, thirdArg = null) {
  let punchIns = [];
  let targetRatio = "9:16";
  let cropDims = null;

  if (Array.isArray(firstArg)) {
    punchIns = firstArg;
    targetRatio = secondArg || "9:16";
    cropDims = thirdArg;
  } else if (firstArg && typeof firstArg === "object") {
    punchIns = firstArg.punchIns || [];
    targetRatio = firstArg.targetRatio || "9:16";
    cropDims = firstArg.cropDims || null;
  }

  if (!Array.isArray(punchIns) || punchIns.length === 0) return [];
  const canonicalRatio = normalizeTargetRatio(targetRatio);

  const scaleFactor = canonicalRatio === "16:9" ? 0.50 : (canonicalRatio === "1:1" ? 0.75 : (canonicalRatio === "4:5" ? 0.85 : 1.0));

  return punchIns.map((p) => {
    if (!p) return p;
    let xOffset = (Number(p.x) || 0) * scaleFactor;
    const safeScale = Math.max(1.05, Math.min(1.40, Number(p.scale) || 1.25));

    return {
      ...p,
      x: Number(xOffset.toFixed(2)),
      scale: Number(safeScale.toFixed(2)),
      targetRatio: canonicalRatio,
    };
  });
}

/**
 * Adapts visual overlays (Priority 6) for a target aspect ratio.
 */
export function adaptOverlaysForTargetRatio(firstArg, secondArg = null, thirdArg = 0.5, fourthArg = null) {
  let overlays = [];
  let targetRatio = "9:16";
  let cropX = 0.5;
  let faceBox = null;

  if (Array.isArray(firstArg)) {
    overlays = firstArg;
    targetRatio = secondArg || "9:16";
    cropX = thirdArg ?? 0.5;
    faceBox = fourthArg;
  } else if (firstArg && typeof firstArg === "object") {
    overlays = firstArg.overlays || [];
    targetRatio = firstArg.targetRatio || "9:16";
    cropX = firstArg.cropX ?? 0.5;
    faceBox = firstArg.faceBox || null;
  }

  if (!Array.isArray(overlays) || overlays.length === 0) return [];
  const canonicalRatio = normalizeTargetRatio(targetRatio);
  const safeArea = resolvePlatformSafeArea(canonicalRatio);

  return overlays.map((ov) => {
    if (!ov) return ov;
    const kind = ov.kind || (ov.type === "video" ? "broll" : "callout");
    const adaptedPlacement = resolveOverlayPlacement(kind, canonicalRatio, cropX, faceBox);

    return {
      ...ov,
      targetRatio: canonicalRatio,
      safeArea,
      baseTransform: {
        ...(ov.baseTransform || {}),
        x: adaptedPlacement.x,
        y: adaptedPlacement.y,
        scale: adaptedPlacement.scale,
      },
    };
  });
}

/**
 * Adapts caption segments for target aspect ratio safe margins and face avoidance.
 */
export function adaptCaptionsForTargetRatio(firstArg, secondArg = null, thirdArg = null, fourthArg = 0.5) {
  let captionSegments = [];
  let targetRatio = "9:16";
  let faceBox = null;
  let cropX = 0.5;

  if (Array.isArray(firstArg)) {
    captionSegments = firstArg;
    targetRatio = secondArg || "9:16";
    faceBox = thirdArg;
    cropX = fourthArg ?? 0.5;
  } else if (firstArg && typeof firstArg === "object") {
    captionSegments = firstArg.captionSegments || [];
    targetRatio = firstArg.targetRatio || "9:16";
    faceBox = firstArg.faceBox || null;
    cropX = firstArg.cropX ?? 0.5;
  }

  if (!Array.isArray(captionSegments)) return [];
  const canonicalRatio = normalizeTargetRatio(targetRatio);
  const ratioDef = getRepackagingRatioDefinition(canonicalRatio);
  const safeArea = ratioDef.safeArea;

  const defaultPlacement = ratioDef.defaultCaptionPlacement;
  const safeRes = resolveSafeCaptionPlacement({
    targetRatio: canonicalRatio,
    faceBox,
    cropX,
    safeMargins: {
      topRatio: safeArea.top,
      bottomRatio: safeArea.bottom,
      horizontalRatio: safeArea.left,
    },
  });

  return captionSegments.map((cap) => {
    if (!cap) return cap;
    return {
      ...cap,
      placement: safeRes.placement || defaultPlacement,
      targetRatio: canonicalRatio,
    };
  });
}

/**
 * Repackages an existing candidate short into a specific target aspect ratio.
 * Pure function: Does not mutate the input candidate or project.
 */
export function repackageShortCandidate(params = {}) {
  const candidate = params.candidate;
  if (!candidate || typeof candidate !== "object" || !Number.isFinite(Number(candidate.duration))) {
    return {
      ok: false,
      reason: "INVALID_CANDIDATE",
      targetRatio: normalizeTargetRatio(params.targetRatio),
      project: null,
      exportSpec: null,
    };
  }

  const sourceMedia = params.sourceClip || params.sourceMedia || {};
  const targetRatio = params.targetRatio || "9:16";
  const options = params.options || {};
  const captionSegments = params.captionSegments || options.captionSegments || [];

  const canonicalRatio = normalizeTargetRatio(targetRatio);
  const ratioDef = getRepackagingRatioDefinition(canonicalRatio);
  const safeArea = resolvePlatformSafeArea(canonicalRatio, options.safeArea);

  const sourceSize = {
    width: Number(sourceMedia?.width) || 1920,
    height: Number(sourceMedia?.height) || 1080,
  };

  const candidateDuration = Number(candidate.duration) || 15;
  const candidateStartTime = Number(candidate.startTime) || 0;
  const candidateEndTime = Number(candidate.endTime) || candidateStartTime + candidateDuration;

  // 1. Calculate target-specific crop geometry
  const faceBox = candidate.primaryFace || options.faceBox || null;
  const manualCropX = Number.isFinite(candidate.cropX) ? candidate.cropX : 0.5;
  const cropResult = calculateRepackagingCrop({
    sourceSize,
    targetRatio: canonicalRatio,
    faceBox,
    cropX: manualCropX,
    options,
  });

  // 2. Build target-specific reframing track
  let smartFrameTrack = null;
  const genuineFromOptions = Array.isArray(options.faceDetections) ? options.faceDetections.filter(isGenuineFaceDetection) : [];
  const genuineFromCandidate = extractGenuineFaceDetections(candidate);
  const genuineFromSource = extractGenuineFaceDetections(sourceMedia);
  const detectionsToUse = genuineFromOptions.length > 0
    ? genuineFromOptions
    : (genuineFromCandidate.length > 0 ? genuineFromCandidate : genuineFromSource);

  if (detectionsToUse.length > 0) {
    smartFrameTrack = buildDynamicReframingTrack({
      detections: detectionsToUse,
      duration: candidateDuration,
      sourceSize,
      targetRatio: canonicalRatio,
      sceneCuts: options.sceneCuts || [],
      motion: options.reframingMotion || "smooth",
      manualCropX,
      userSelectedSubject: options.userSelectedSubject ?? candidate.userSelectedSubject ?? candidate.targetSubject,
      speechIntervals: (candidate.sentences || []).map((s) => ({
        start: Math.max(0, s.start - (candidate.startTime || 0)),
        end: Math.max(0, s.end - (candidate.startTime || 0)),
      })),
      sentences: (candidate.sentences || []).map((s) => ({
        ...s,
        start: Math.max(0, s.start - (candidate.startTime || 0)),
        end: Math.max(0, s.end - (candidate.startTime || 0)),
      })),
    });
  } else {
    smartFrameTrack = generateFallbackReframingTrack(
      sourceSize,
      canonicalRatio,
      candidateDuration,
      manualCropX
    );
  }

  // 3. Adapt visual punch-ins
  const adaptedPunchIns = adaptPunchInsForTargetRatio({
    punchIns: candidate.punchIns || options.punchIns || [],
    targetRatio: canonicalRatio,
    cropDims: cropResult.normalized,
  });

  // 4. Adapt overlays
  const finalPan = cropResult.panFactor ?? ((1 - cropResult.normalized.width) > 0.0001 ? cropResult.normalized.x / (1 - cropResult.normalized.width) : 0.5);
  const adaptedOverlays = adaptOverlaysForTargetRatio({
    overlays: candidate.overlays || options.overlays || [],
    targetRatio: canonicalRatio,
    cropX: finalPan,
    faceBox,
  });

  // 5. Adapt captions
  const sourceCaptions = Array.isArray(captionSegments) && captionSegments.length > 0
    ? captionSegments
    : (Array.isArray(candidate.captionSegments) ? candidate.captionSegments : []);
  const adaptedCaptions = adaptCaptionsForTargetRatio({
    captionSegments: sourceCaptions,
    targetRatio: canonicalRatio,
    faceBox,
    cropX: finalPan,
  });

  // 6. Build Title Hook Card
  const titleCard = resolveTitleCardLayout({
    title: candidate.title || "AI Short",
    targetRatio: canonicalRatio,
    safeArea,
    faceBox,
    options,
  });

  // 7. Compose Repackaged Project
  const fitMode = options.fitMode || (canonicalRatio === "16:9" && sourceSize.width >= sourceSize.height ? "contain" : "cover");
  const trimmedVisualSegment = {
    ...sourceMedia,
    id: `vis-${makeId("vis")}`,
    archiveMediaId: sourceMedia.id,
    assetId: sourceMedia.id,
    sourceStart: candidateStartTime,
    sourceDuration: candidateDuration,
    duration: candidateDuration,
    fitMode,
    cropX: Number(finalPan.toFixed(3)),
    cropY: 0.5,
    cropOffset: { x: cropResult.normalized.x, y: cropResult.normalized.y },
    objectPosition: `${(finalPan * 100).toFixed(1)}% 50%`,
    smartFrame: smartFrameTrack,
    punchIns: adaptedPunchIns,
    smartZoom: { enabled: adaptedPunchIns.length > 0, punchIns: adaptedPunchIns },
  };

  const repackagedProject = {
    ratioId: canonicalRatio,
    fitMode,
    visualSegments: [trimmedVisualSegment],
    visualOverlaySegments: adaptedOverlays,
    segments: [trimmedVisualSegment],
    captionSegments: adaptedCaptions,
    captionCallouts: candidate.captionCallouts || [],
    motionTypography: candidate.motionTypography || { enabled: true },
    titleCard,
    captionStylePresetId: options.captionPresetId || "bold",
    captionStyle: options.captionStyle || { textColor: "#ffffff", backgroundColor: "#000000" },
    captionSize: options.captionSize || (canonicalRatio === "9:16" ? 22 : 18),
    captionsEnabled: adaptedCaptions.length > 0,
    transitions: candidate.transitions || [],
    brollCutaways: candidate.brollCutaways || [],
    assetRequests: candidate.assetRequests || [],
    audioSegments: [],
    musicSegments: [],
    timelineDuration: candidateDuration,
    meta: {
      sourceClipId: sourceMedia.id,
      candidateId: candidate.id,
      candidateTitle: candidate.title,
      strategy: candidate.strategy,
      targetRatio: canonicalRatio,
      framingMode: candidate.framingMode || "smart-zoom",
      cropX: cropResult.normalized.x + cropResult.normalized.width / 2,
      platform: ratioDef.platform,
    },
  };

  // 8. Build Repackaged Export Specification
  const exportSpec = {
    id: `export-${candidate.id}-${canonicalRatio.replace(":", "-")}`,
    candidateId: candidate.id,
    title: candidate.title || "AI Short",
    startTime: candidateStartTime,
    endTime: candidateEndTime,
    duration: candidateDuration,
    width: ratioDef.width,
    height: ratioDef.height,
    aspectRatio: canonicalRatio,
    platform: ratioDef.platform,
    framingMode: candidate.framingMode || "smart-zoom",
    cropX: cropResult.normalized.x + cropResult.normalized.width / 2,
    cropDimensions: cropResult,
    safeArea,
    titleCard,
    transitions: candidate.transitions || [],
    brollCutaways: candidate.brollCutaways || [],
    assetRequests: candidate.assetRequests || [],
    project: repackagedProject,
    format: "mp4",
    videoBitrate: "8000k",
    audioBitrate: "192k",
  };

  return {
    ok: true,
    candidateId: candidate.id,
    targetRatio: canonicalRatio,
    definition: ratioDef,
    dimensions: { width: ratioDef.width, height: ratioDef.height },
    cropGeometry: cropResult.normalized,
    cropDimensions: cropResult,
    safeArea,
    titleCardLayout: titleCard,
    titleCard,
    project: repackagedProject,
    exportSpec,
  };
}

/**
 * Batch-repackages a single candidate into multiple target aspect ratios.
 */
export function batchRepackageCandidate(params = {}) {
  const candidate = params.candidate;
  if (!candidate || typeof candidate !== "object") {
    return {
      ok: false,
      reason: "INVALID_CANDIDATE",
      targetRatios: [],
      repackaged: {},
      formats: {},
    };
  }

  const sourceMedia = params.sourceClip || params.sourceMedia || {};
  const targetRatios = params.targetRatios || SUPPORTED_REPACKAGING_RATIOS;
  const ratios = Array.isArray(targetRatios) && targetRatios.length > 0
    ? targetRatios.map(normalizeTargetRatio)
    : SUPPORTED_REPACKAGING_RATIOS;

  const uniqueRatios = [...new Set(ratios)];
  const formats = {};

  for (const ratio of uniqueRatios) {
    formats[ratio] = repackageShortCandidate({
      sourceMedia,
      sourceClip: sourceMedia,
      candidate,
      targetRatio: ratio,
      captionSegments: params.captionSegments,
      options: params.options,
    });
  }

  return {
    ok: true,
    candidateId: candidate.id,
    targetRatios: uniqueRatios,
    formatCount: Object.keys(formats).length,
    repackaged: formats,
    formats,
  };
}

/**
 * Generates an array of format-specific export specifications from one source candidate.
 */
export function buildMultiFormatExportSpecs(params = {}) {
  const batch = batchRepackageCandidate(params);

  if (!batch.ok) return [];

  return Object.values(batch.formats)
    .filter((f) => f && f.ok && f.exportSpec)
    .map((f) => f.exportSpec);
}
