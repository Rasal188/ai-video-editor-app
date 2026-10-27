import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  calculateTargetCropDimensions,
  solveFrameCrop,
  buildDynamicReframingTrack,
  buildReframingFFmpegCropFilter,
  extractGenuineFaceDetections,
  isGenuineFaceBox,
  isGenuineFaceDetection,
  REFRAMING_ASPECT_RATIOS,
} from "../../src/lib/shortsReframing.js";

import {
  normalizeSmartFrame,
  resolveSmartFrameCropAtTime,
  smartFrameCropToPixels,
} from "../../src/lib/smartFrame.js";

import {
  convertCandidateToProject,
  discoverShortCandidates,
} from "../../src/lib/shortsStudio.js";

import { getObjectPositionForCrop } from "../../src/lib/editorRuntime.js";

describe("Shorts Reframing & Smart Frame Pipeline Regression Suite", () => {
  // Test 1: Every supported aspect ratio produces the correct crop geometry (cropWidth / cropHeight = R)
  it("enforces exact target aspect ratio geometry for all supported aspect ratios", () => {
    const sourceSizes = [
      { width: 1920, height: 1080 }, // 16:9 landscape
      { width: 1080, height: 1920 }, // 9:16 portrait
      { width: 1080, height: 1080 }, // 1:1 square
      { width: 1280, height: 720 },  // 16:9 landscape
    ];

    const ratios = ["9:16", "1:1", "4:5", "16:9"];

    for (const size of sourceSizes) {
      for (const ratioKey of ratios) {
        const expectedRatio = REFRAMING_ASPECT_RATIOS[ratioKey].ratio;
        const cropDims = calculateTargetCropDimensions(size, ratioKey);

        const cropPixelW = cropDims.width * size.width;
        const cropPixelH = cropDims.height * size.height;
        const actualRatio = cropPixelW / cropPixelH;

        assert(
          Math.abs(actualRatio - expectedRatio) < 0.002,
          `Expected ratio ${expectedRatio} for ${ratioKey} with source ${size.width}x${size.height}, got ${actualRatio}`
        );
      }
    }
  });

  // Test 2: Crop rectangles stay within source bounds [0, 1 - width] and [0, 1 - height]
  it("keeps crop rectangles strictly within normalized [0, 1] source bounds", () => {
    const cropDims = calculateTargetCropDimensions({ width: 1920, height: 1080 }, "9:16");

    // Test extreme positions (far left, far right, above, below, center)
    const testCases = [
      { manualCropX: 0.0 },
      { manualCropX: 1.0 },
      { manualCropX: -0.5 },
      { manualCropX: 1.5 },
      { targetBox: { xMin: -0.2, xMax: 0.1, yMin: -0.1, yMax: 0.2 } },
      { targetBox: { xMin: 0.9, xMax: 1.2, yMin: 0.8, yMax: 1.1 } },
      { targetBox: { xMin: 0.45, xMax: 0.55, yMin: 0.2, yMax: 0.6 } },
    ];

    for (const tc of testCases) {
      const solved = solveFrameCrop(tc.targetBox, cropDims, { manualCropX: tc.manualCropX });
      assert(solved.x >= 0, `x must be >= 0, got ${solved.x}`);
      assert(solved.y >= 0, `y must be >= 0, got ${solved.y}`);
      assert(solved.x + solved.width <= 1.0001, `x + width must be <= 1.0, got ${solved.x + solved.width}`);
      assert(solved.y + solved.height <= 1.0001, `y + height must be <= 1.0, got ${solved.y + solved.height}`);
    }
  });

  // Test 3: Odd source dimensions and portrait, landscape, and square inputs are handled correctly
  it("handles odd source dimensions, portrait, square, and ultrawide inputs correctly", () => {
    const oddSizes = [
      { width: 1919, height: 1079 }, // Odd landscape
      { width: 1079, height: 1919 }, // Odd portrait
      { width: 1001, height: 1001 }, // Odd square
      { width: 2560, height: 1080 }, // Ultrawide 21:9
      { width: 720, height: 1281 },  // Odd vertical
    ];

    for (const size of oddSizes) {
      for (const ratioKey of ["9:16", "1:1", "16:9"]) {
        const cropDims = calculateTargetCropDimensions(size, ratioKey);
        assert(Number.isFinite(cropDims.width) && cropDims.width > 0 && cropDims.width <= 1.0);
        assert(Number.isFinite(cropDims.height) && cropDims.height > 0 && cropDims.height <= 1.0);

        const cropPixelW = cropDims.width * size.width;
        const cropPixelH = cropDims.height * size.height;
        const expectedRatio = REFRAMING_ASPECT_RATIOS[ratioKey].ratio;
        assert(
          Math.abs((cropPixelW / cropPixelH) - expectedRatio) < 0.005,
          `Odd size ${size.width}x${size.height} produced invalid ratio for ${ratioKey}`
        );
      }
    }
  });

  // Test 4: The subject stays within the valid crop when a feasible crop exists (including 2-person shot)
  it("keeps primary subject inside the crop window and does not center on gap in two-person shots", () => {
    const sourceSize = { width: 1920, height: 1080 };
    const cropDims = calculateTargetCropDimensions(sourceSize, "9:16");

    // Case A: Speaker on left side (e.g. at 16s in reproduction video: woman at xMin=0.18, xMax=0.40)
    const speakerOnLeft = {
      id: "face-woman",
      xMin: 0.18,
      xMax: 0.40,
      yMin: 0.20,
      yMax: 0.60,
      centerX: 0.29,
      isPerson: true,
      label: "person",
    };

    const cropLeft = solveFrameCrop(speakerOnLeft, cropDims);
    // Woman must be inside cropLeft
    assert(cropLeft.x <= speakerOnLeft.xMin, `Crop left edge (${cropLeft.x}) must be <= subject left (${speakerOnLeft.xMin})`);
    assert(cropLeft.x + cropLeft.width >= speakerOnLeft.xMax, `Crop right edge (${cropLeft.x + cropLeft.width}) must be >= subject right (${speakerOnLeft.xMax})`);

    // Case B: Two-person wide shot (at 27.8s in reproduction video: woman on left, man on right)
    // When dynamic reframing runs with active speaker (man on right: xMin=0.68, xMax=0.88),
    // it must frame the speaker, NOT center on the empty gap between them at x=0.3418!
    const speakerMan = {
      id: "face-man",
      xMin: 0.68,
      xMax: 0.88,
      yMin: 0.20,
      yMax: 0.60,
      centerX: 0.78,
      isPerson: true,
      label: "person",
    };

    const cropRight = solveFrameCrop(speakerMan, cropDims);
    assert(cropRight.x <= speakerMan.xMin, `Crop left edge (${cropRight.x}) must be <= subject left (${speakerMan.xMin})`);
    assert(cropRight.x + cropRight.width >= speakerMan.xMax, `Crop right edge (${cropRight.x + cropRight.width}) must be >= subject right (${speakerMan.xMax})`);
    assert(cropRight.x > 0.45, `Crop must be on the right side framing the speaker, not in the gap at 0.34! Got x=${cropRight.x}`);
  });

  // Test 5: Pan-factor and normalized crop coordinates agree: x = panFactor * (1 - width)
  it("enforces exact mathematical agreement between panFactor and normalized x coordinates", () => {
    const sourceSize = { width: 1920, height: 1080 };
    const cropDims = calculateTargetCropDimensions(sourceSize, "9:16");
    const span = 1 - cropDims.width;

    const panValues = [0.0, 0.2, 0.35, 0.5, 0.75, 1.0];
    for (const pan of panValues) {
      const solved = solveFrameCrop(null, cropDims, { manualCropX: pan });
      const expectedX = Number((pan * span).toFixed(4));
      assert(
        Math.abs(solved.x - expectedX) < 0.001,
        `Expected x=${expectedX} for pan=${pan}, got ${solved.x}`
      );
      assert(
        Math.abs(solved.panFactor - pan) < 0.001,
        `Expected panFactor=${pan}, got ${solved.panFactor}`
      );
    }
  });

  // Test 6: Scene-cut keyframes remain intact and hold previous framing across cuts
  it("preserves scene-cut keyframes and inserts hold keyframe to prevent cross-cut pans", () => {
    const sourceSize = { width: 1920, height: 1080 };
    const detections = [
      // Shot 1: Woman speaking on left
      { time: 0.0, faces: [{ id: "f1", xMin: 0.18, xMax: 0.38, yMin: 0.2, yMax: 0.6, isPerson: true }] },
      { time: 2.0, faces: [{ id: "f1", xMin: 0.18, xMax: 0.38, yMin: 0.2, yMax: 0.6, isPerson: true }] },
      { time: 4.0, faces: [{ id: "f1", xMin: 0.18, xMax: 0.38, yMin: 0.2, yMax: 0.6, isPerson: true }] },
      // Instantaneous cut / subject switch to man on right at 4.2s
      { time: 4.2, faces: [{ id: "f2", xMin: 0.68, xMax: 0.88, yMin: 0.2, yMax: 0.6, isPerson: true }] },
      { time: 6.0, faces: [{ id: "f2", xMin: 0.68, xMax: 0.88, yMin: 0.2, yMax: 0.6, isPerson: true }] },
    ];

    const track = buildDynamicReframingTrack({
      detections,
      duration: 6.0,
      sourceSize,
      targetRatio: "9:16",
    });

    assert(track && Array.isArray(track.cropKeyframes), "Should produce valid track");
    const kfs = track.cropKeyframes;

    // Check that a cut keyframe exists around 4.2s
    const cutKf = kfs.find((k) => k.time >= 4.15 && k.time <= 4.25 && (k.isCut || k.cut));
    assert(cutKf, "Must have an instantaneous cut keyframe at the subject switch (4.2s)");

    // Check that a hold keyframe was inserted prior to 4.2s holding the previous left framing
    const holdKf = kfs.find((k) => k.time >= 4.05 && k.time < 4.2);
    assert(holdKf, "Must insert a hold keyframe before the cut to prevent linear interpolation across the cut");
    assert(holdKf.x < 0.30, `Hold keyframe must hold left framing (x < 0.30), got x=${holdKf.x}`);

    // Verify resolveSmartFrameCropAtTime respects cut boundary
    const cropBeforeCut = resolveSmartFrameCropAtTime(track, 4.15);
    const cropAfterCut = resolveSmartFrameCropAtTime(track, 4.25);
    assert(cropBeforeCut.x < 0.30, "Frame immediately before cut must remain on speaker 1");
    assert(cropAfterCut.x > 0.50, "Frame immediately after cut must be on speaker 2");
  });

  // Test 7: Preview, timeline, and export use equivalent crop geometry
  it("verifies that preview, timeline, and export share equivalent crop geometry", () => {
    const sourceSize = { width: 1920, height: 1080 };
    const targetSize = { width: 1080, height: 1920 };
    const testPanFactor = 0.25;

    const cropDims = calculateTargetCropDimensions(sourceSize, "9:16");
    const solved = solveFrameCrop(null, cropDims, { manualCropX: testPanFactor });

    // 1. Modal preview uses objectPosition percentage
    const modalObjectPositionPct = (testPanFactor * 100).toFixed(1);

    // 2. Timeline Preview uses getObjectPositionForCrop
    const smartFrameObj = normalizeSmartFrame({
      version: 2,
      enabled: true,
      targetRatio: "9:16",
      sourceSize,
      cropKeyframes: [
        { time: 0, x: solved.x, y: solved.y, width: solved.width, height: solved.height, panFactor: testPanFactor },
        { time: 10, x: solved.x, y: solved.y, width: solved.width, height: solved.height, panFactor: testPanFactor },
      ],
    });

    const timelineCrop = resolveSmartFrameCropAtTime(smartFrameObj, 2.0);
    const timelinePixels = smartFrameCropToPixels(timelineCrop, sourceSize);
    const timelineObjectPosition = getObjectPositionForCrop(timelinePixels);

    // 3. WebCodecs canvas export scales smartFrameCropToPixels to target canvas
    const canvasCropX = timelinePixels.x;
    const canvasCropW = timelinePixels.width;

    // 4. FFmpeg crop filter generates crop expression
    const ffmpegFilter = buildReframingFFmpegCropFilter(smartFrameObj, targetSize.width, targetSize.height, 10);

    // Check equivalence:
    // Timeline object position percentage must match modal preview percentage
    assert(
      Math.abs(parseFloat(timelineObjectPosition) - parseFloat(modalObjectPositionPct)) < 0.1,
      `Timeline object-position (${timelineObjectPosition}) must match preview (${modalObjectPositionPct}%)`
    );

    // Normalized x from pixel crop must equal solved.x
    assert(Math.abs((canvasCropX / sourceSize.width) - solved.x) < 0.001);

    // FFmpeg crop filter must specify target dimensions and correct pan factor
    assert(ffmpegFilter.includes("crop=1080:1920"));
    assert(ffmpegFilter.includes(`(in_w-out_w)*${testPanFactor.toFixed(4)}`));
  });

  // Test 8: Missing detections and invalid dimensions cannot produce NaN, infinite, or out-of-bounds crop values
  it("handles missing detections and invalid dimensions without NaN, Infinity, or out-of-bounds values", () => {
    const invalidInputs = [
      { sourceSize: null, ratio: null },
      { sourceSize: { width: 0, height: 0 }, ratio: "invalid-ratio" },
      { sourceSize: { width: NaN, height: Infinity }, ratio: "9:16" },
      { sourceSize: { width: -100, height: -200 }, ratio: "1:1" },
    ];

    for (const inv of invalidInputs) {
      const dims = calculateTargetCropDimensions(inv.sourceSize, inv.ratio);
      assert(Number.isFinite(dims.width) && dims.width > 0 && dims.width <= 1.0);
      assert(Number.isFinite(dims.height) && dims.height > 0 && dims.height <= 1.0);

      const solved = solveFrameCrop(null, dims, { manualCropX: NaN });
      assert(Number.isFinite(solved.x) && solved.x >= 0 && solved.x <= 1.0);
      assert(Number.isFinite(solved.y) && solved.y >= 0 && solved.y <= 1.0);
      assert(Number.isFinite(solved.panFactor) && solved.panFactor >= 0 && solved.panFactor <= 1.0);
    }

    // Dynamic reframing with empty detections
    const emptyTrack = buildDynamicReframingTrack({
      detections: [],
      duration: 5.0,
      sourceSize: { width: 1920, height: 1080 },
      targetRatio: "9:16",
    });
    assert(emptyTrack.isFallback === true);
    assert(emptyTrack.cropKeyframes.length >= 2);
    for (const kf of emptyTrack.cropKeyframes) {
      assert(Number.isFinite(kf.x) && !Number.isNaN(kf.x));
      assert(Number.isFinite(kf.y) && !Number.isNaN(kf.y));
      assert(Number.isFinite(kf.panFactor) && !Number.isNaN(kf.panFactor));
    }
  });
});
