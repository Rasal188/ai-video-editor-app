import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  solveFrameCrop,
  calculateTargetCropDimensions,
  buildDynamicReframingTrack,
  applyDynamicReframingToCandidate,
  selectPrimaryFace,
  buildReframingFFmpegCropFilter,
} from "../../src/lib/shortsReframing.js";

import {
  resolveSmartFrameCropAtTime,
  normalizeSmartFrame,
} from "../../src/lib/smartFrame.js";

import {
  convertCandidateToProject,
  isCandidateSmartFrameFallback,
} from "../../src/lib/shortsStudio.js";

describe("AI Shorts Studio — Actual Subject Framing Failure Root Cause Regression Suite", () => {
  const source16x9 = { width: 1280, height: 720 };
  const cropDims916 = calculateTargetCropDimensions(source16x9, "9:16"); // width = 0.3164, height = 1.0

  describe("1. Single person seated in armchair (Wide bounding box, centered speaker)", () => {
    // Ground truth from candidate 212.92s: single intern seated in armchair with arms extended
    const seatedInternArmchair = {
      id: "person-intern-armchair",
      isPerson: true,
      score: 0.82,
      confidence: 0.82,
      xMin: 0.1898,
      yMin: 0.1514,
      xMax: 0.8789,
      yMax: 0.9639,
      width: 0.6891,
      height: 0.8125,
      centerX: 0.5343,
      centerY: 0.5576,
    };

    it("centers the 9:16 portrait crop on the speaker rather than anchoring on the armchair / lamp on the left", () => {
      const crop = solveFrameCrop(seatedInternArmchair, cropDims916, { sourceSize: source16x9 });

      // Target crop width is 0.3164.
      // Ideal centered X = 0.5343 - 0.3164 / 2 = 0.3761
      // Expected panFactor = 0.3761 / (1 - 0.3164) ≈ 0.5502
      assert.ok(
        Math.abs(crop.x - 0.3761) < 0.02,
        `Expected crop.x ~ 0.3761, got ${crop.x}`
      );
      assert.ok(
        Math.abs(crop.panFactor - 0.5502) < 0.03,
        `Expected panFactor ~ 0.5502, got ${crop.panFactor}`
      );

      // Verify speaker center (0.5343) is safely inside the crop window [crop.x, crop.x + crop.width]
      const cropRight = crop.x + crop.width;
      assert.ok(
        crop.x <= 0.5343 && cropRight >= 0.5343,
        `Speaker center (0.5343) must be inside crop [${crop.x}, ${cropRight}]`
      );

      // Verify the crop does NOT anchor on the far-left edge (0.1898 = lamp and wall)
      assert.ok(
        crop.x > 0.30,
        `Crop X (${crop.x}) must NOT be anchored to armchair/lamp edge (0.1898)`
      );
    });

    it("distinguishes a single seated person from an actual two-person group span", () => {
      // True two-person interview shot: combined composite box spanning both individuals with empty center
      const twoPersonGroup = {
        id: "group-interview",
        isPerson: true,
        isGroup: true,
        xMin: 0.15,
        yMin: 0.20,
        xMax: 0.85,
        yMax: 0.65,
        width: 0.70,
        height: 0.45,
        centerX: 0.50,
      };

      const groupCrop = solveFrameCrop(twoPersonGroup, cropDims916, { sourceSize: source16x9 });
      const groupCenter = groupCrop.x + groupCrop.width / 2;

      // Group crop must NOT be centered in the empty dead space [0.45, 0.55] between two people
      const isInEmptyGap = groupCenter >= 0.45 && groupCenter <= 0.55;
      assert.equal(isInEmptyGap, false, "Two-person group crop must avoid the empty gap between subjects");

      // While single person crop MUST center on the speaker
      const singleCrop = solveFrameCrop(seatedInternArmchair, cropDims916, { sourceSize: source16x9 });
      const singleCenter = singleCrop.x + singleCrop.width / 2;
      assert.ok(
        Math.abs(singleCenter - 0.5343) < 0.02,
        "Single person crop must center directly on the individual"
      );
    });
  });

  describe("2. Source-to-Clip Timestamp Mapping & Playback Keyframe Distribution", () => {
    it("handles detections passed with absolute source timestamps without collapsing to safeDuration", () => {
      // Detections with source timestamps 212.92 to 248.80
      const sourceDetections = [
        {
          time: 212.92,
          faces: [{ id: "f0", isPerson: true, xMin: 0.20, yMin: 0.15, xMax: 0.86, yMax: 0.95, centerX: 0.53, confidence: 0.9 }],
        },
        {
          time: 220.00,
          faces: [{ id: "f1", isPerson: true, xMin: 0.22, yMin: 0.15, xMax: 0.88, yMax: 0.95, centerX: 0.55, confidence: 0.9 }],
        },
        {
          time: 232.00,
          faces: [{ id: "f2", isPerson: true, xMin: 0.35, yMin: 0.15, xMax: 0.95, yMax: 0.95, centerX: 0.65, confidence: 0.9 }],
        },
        {
          time: 248.80,
          faces: [{ id: "f3", isPerson: true, xMin: 0.15, yMin: 0.15, xMax: 0.75, yMax: 0.95, centerX: 0.45, confidence: 0.9 }],
        },
      ];

      const track = buildDynamicReframingTrack({
        detections: sourceDetections,
        duration: 35.88,
        startTime: 212.92,
        sourceSize: source16x9,
        targetRatio: "9:16",
      });

      assert.ok(Array.isArray(track.cropKeyframes), "Track has cropKeyframes");
      assert.ok(track.cropKeyframes.length >= 4, `Track should have multiple keyframes across duration, got ${track.cropKeyframes.length}`);

      // Verify keyframes span from t = 0 to t = 35.88, NOT all clamped at 35.88
      const times = track.cropKeyframes.map((k) => k.time);
      assert.equal(times[0], 0, "First keyframe at 0s");
      assert.ok(times.includes(Number((220.00 - 212.92).toFixed(3))), "Contains intermediate keyframe at ~7.08s");
      assert.ok(times.includes(Number((232.00 - 212.92).toFixed(3))), "Contains intermediate keyframe at ~19.08s");
      assert.equal(times[times.length - 1], 35.88, "Last keyframe at 35.88s");

      // Verify panFactor changes over playback time instead of staying stuck
      const kf0 = resolveSmartFrameCropAtTime(track, 0.0);
      const kfMid = resolveSmartFrameCropAtTime(track, 19.08);
      const kfEnd = resolveSmartFrameCropAtTime(track, 35.88);

      assert.notEqual(kf0.panFactor, kfMid.panFactor, "Pan factor must change between t=0 and t=19.08s");
      assert.notEqual(kfMid.panFactor, kfEnd.panFactor, "Pan factor must change between t=19.08s and t=35.88s");
    });
  });

  describe("3. Multi-Person Candidate Arbitration & Dialogue Continuity", () => {
    it("does NOT arbitrarily favor the leftmost person in two-person wide shots", () => {
      const interviewerLeft = {
        id: "interviewer-left",
        isPerson: true,
        confidence: 0.95,
        xMin: 0.15,
        yMin: 0.35,
        xMax: 0.45,
        yMax: 0.85,
        width: 0.30,
        height: 0.50,
        centerX: 0.30,
        centerY: 0.60,
      };

      const internRight = {
        id: "intern-right",
        isPerson: true,
        confidence: 0.95,
        xMin: 0.55,
        yMin: 0.35,
        xMax: 0.85,
        yMax: 0.85,
        width: 0.30,
        height: 0.50,
        centerX: 0.70,
        centerY: 0.60,
      };

      // Previous frame was tracking the intern (centerX = 0.55)
      const prevFace = {
        id: "intern-closeup",
        isPerson: true,
        xMin: 0.20,
        yMin: 0.15,
        xMax: 0.90,
        yMax: 0.95,
        centerX: 0.55,
        centerY: 0.55,
      };

      const selected = selectPrimaryFace([interviewerLeft, internRight], prevFace, {
        sourceSize: source16x9,
        cropDims: cropDims916,
        targetRatio: "9:16",
      });

      assert.equal(selected.id, "intern-right", "Should maintain continuity with intern rather than jumping to interviewer on the left");
    });
  });

  describe("4. End-to-End Propagation: Preview, Timeline, and Export", () => {
    it("ensures resolveSmartFrameCropAtTime evaluates equivalent framing in local preview and source-time timeline", () => {
      const detections = [
        { time: 0, faces: [{ id: "f0", isPerson: true, centerX: 0.53, xMin: 0.20, xMax: 0.86, yMin: 0.15, yMax: 0.95 }] },
        { time: 10, faces: [{ id: "f1", isPerson: true, centerX: 0.65, xMin: 0.35, xMax: 0.95, yMin: 0.15, yMax: 0.95 }] },
        { time: 35.88, faces: [{ id: "f2", isPerson: true, centerX: 0.53, xMin: 0.20, xMax: 0.86, yMin: 0.15, yMax: 0.95 }] },
      ];

      const track = buildDynamicReframingTrack({
        detections,
        duration: 35.88,
        startTime: 212.92,
        sourceSize: source16x9,
        targetRatio: "9:16",
      });

      const candidate = {
        id: "cand-212",
        startTime: 212.92,
        endTime: 248.80,
        duration: 35.88,
        aspectRatio: "9:16",
        smartFrame: track,
      };

      // In Modal Preview: local relative time = 10.0s
      const modalCrop = resolveSmartFrameCropAtTime(candidate.smartFrame, 10.0);

      // In Timeline: converted to project with sourceStart
      const sourceClip = { id: "media-1", width: 1280, height: 720, duration: 700 };
      const project = convertCandidateToProject(candidate, sourceClip, { aspectRatio: "9:16" });
      const visualSegment = project.visualSegments[0];

      // In Timeline Preview / Export: evaluated at source time = 212.92 + 10.0 = 222.92s
      const timelineCrop = resolveSmartFrameCropAtTime(visualSegment.smartFrame, 222.92);

      assert.ok(modalCrop, "Modal crop exists");
      assert.ok(timelineCrop, "Timeline crop exists");
      assert.ok(
        Math.abs(modalCrop.panFactor - timelineCrop.panFactor) < 0.01,
        `Modal panFactor (${modalCrop.panFactor}) and Timeline panFactor (${timelineCrop.panFactor}) must match`
      );
      assert.ok(
        Math.abs(modalCrop.x - timelineCrop.x) < 0.01,
        `Modal crop.x (${modalCrop.x}) and Timeline crop.x (${timelineCrop.x}) must match`
      );

      // Export FFmpeg crop filter generates valid crop syntax
      const filter = buildReframingFFmpegCropFilter(visualSegment.smartFrame, 1080, 1920, 35.88);
      assert.ok(filter.startsWith("crop="), `Filter must start with crop=, got: ${filter}`);
      assert.ok(filter.includes(":"), "Filter contains dimensions and offsets");
    });
  });

  describe("5. Generalization: Extreme Positions, Moving Subjects, Multi-Aspect Ratios & Manual Overrides", () => {
    it("correctly frames a speaker positioned near the far-left edge without clipping", () => {
      const farLeftSpeaker = {
        id: "speaker-far-left",
        isPerson: true,
        xMin: 0.05,
        yMin: 0.20,
        xMax: 0.25,
        yMax: 0.70,
        width: 0.20,
        height: 0.50,
        centerX: 0.15,
      };

      const crop = solveFrameCrop(farLeftSpeaker, cropDims916, { sourceSize: source16x9 });
      assert.equal(crop.x, 0, "Should clamp at left edge (0) for far-left subject");
      assert.ok(crop.x <= 0.05 && (crop.x + crop.width) >= 0.25, "Speaker must be fully inside crop window");
    });

    it("correctly frames a speaker positioned near the far-right edge without clipping", () => {
      const farRightSpeaker = {
        id: "speaker-far-right",
        isPerson: true,
        xMin: 0.75,
        yMin: 0.20,
        xMax: 0.95,
        yMax: 0.70,
        width: 0.20,
        height: 0.50,
        centerX: 0.85,
      };

      const crop = solveFrameCrop(farRightSpeaker, cropDims916, { sourceSize: source16x9 });
      const maxExpectedX = Number((1 - cropDims916.width).toFixed(4));
      assert.equal(crop.x, maxExpectedX, "Should clamp at right edge for far-right subject");
      assert.ok(crop.x <= 0.75 && (crop.x + crop.width) >= 0.95, "Speaker must be fully inside crop window");
    });

    it("dynamically tracks a moving subject traveling across the horizontal frame", () => {
      const movingDetections = [
        { time: 0, faces: [{ id: "m0", isPerson: true, xMin: 0.10, xMax: 0.30, yMin: 0.2, yMax: 0.7, centerX: 0.20 }] },
        { time: 5, faces: [{ id: "m1", isPerson: true, xMin: 0.40, xMax: 0.60, yMin: 0.2, yMax: 0.7, centerX: 0.50 }] },
        { time: 10, faces: [{ id: "m2", isPerson: true, xMin: 0.70, xMax: 0.90, yMin: 0.2, yMax: 0.7, centerX: 0.80 }] },
      ];

      const track = buildDynamicReframingTrack({
        detections: movingDetections,
        duration: 10.0,
        sourceSize: source16x9,
        targetRatio: "9:16",
      });

      const cropStart = resolveSmartFrameCropAtTime(track, 0.0);
      const cropMid = resolveSmartFrameCropAtTime(track, 5.0);
      const cropEnd = resolveSmartFrameCropAtTime(track, 10.0);

      assert.ok(cropStart.x < cropMid.x, "Crop must travel rightwards from start to mid");
      assert.ok(cropMid.x < cropEnd.x, "Crop must travel rightwards from mid to end");
      assert.ok(cropStart.panFactor < 0.3, `Start panFactor (${cropStart.panFactor}) must be on left`);
      assert.ok(Math.abs(cropMid.panFactor - 0.5) < 0.1, `Mid panFactor (${cropMid.panFactor}) must be near center`);
      assert.ok(cropEnd.panFactor > 0.7, `End panFactor (${cropEnd.panFactor}) must be on right`);
    });

    it("correctly calculates framing for 1:1 square and 4:5 aspect ratios", () => {
      const speaker = {
        id: "speaker-center",
        isPerson: true,
        xMin: 0.40,
        xMax: 0.60,
        yMin: 0.20,
        yMax: 0.70,
        centerX: 0.50,
      };

      const crop11 = solveFrameCrop(speaker, calculateTargetCropDimensions(source16x9, "1:1"), { sourceSize: source16x9 });
      assert.ok(Math.abs(crop11.panFactor - 0.5) < 0.02, `1:1 panFactor must be centered, got: ${crop11.panFactor}`);

      const crop45 = solveFrameCrop(speaker, calculateTargetCropDimensions(source16x9, "4:5"), { sourceSize: source16x9 });
      assert.ok(Math.abs(crop45.panFactor - 0.5) < 0.02, `4:5 panFactor must be centered, got: ${crop45.panFactor}`);
    });

    it("preserves intentional manualCropX adjustments", () => {
      const speaker = {
        id: "speaker-center",
        isPerson: true,
        xMin: 0.40,
        xMax: 0.60,
        yMin: 0.20,
        yMax: 0.70,
        centerX: 0.50,
      };

      const cropNeutral = solveFrameCrop(speaker, cropDims916, { manualCropX: 0.5 });
      const cropLeftShift = solveFrameCrop(speaker, cropDims916, { manualCropX: 0.2 });
      const cropRightShift = solveFrameCrop(speaker, cropDims916, { manualCropX: 0.8 });

      assert.ok(cropLeftShift.x < cropNeutral.x, "manualCropX: 0.2 must shift crop to the left");
      assert.ok(cropRightShift.x > cropNeutral.x, "manualCropX: 0.8 must shift crop to the right");
    });

    it("honestly reports isFallback: true and state: 'fallback' when no detections exist", () => {
      const fallbackTrack = buildDynamicReframingTrack({
        detections: [],
        duration: 20.0,
        sourceSize: source16x9,
        targetRatio: "9:16",
      });

      assert.equal(fallbackTrack.isFallback, true, "Must flag isFallback: true when empty detections");
      assert.equal(fallbackTrack.state, "fallback", "Must report state: 'fallback'");
      assert.equal(fallbackTrack.confidence, 0, "Confidence must be 0 for unanalyzed fallback");
    });
  });
});
