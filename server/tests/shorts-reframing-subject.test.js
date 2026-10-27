/**
 * @file shorts-reframing-subject.test.js
 * Regression tests for Subject-Aware Reframing in AI Shorts Studio.
 * Verifies that subjects positioned across the source frame (left, center, right, boundaries)
 * are accurately contained within the target aspect ratios (9:16, 1:1, 4:5, 16:9)
 * and that CSS preview, project snapshots, and FFmpeg render plans remain strictly synchronized.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  selectPrimaryFace,
  solveFrameCrop,
  calculateTargetCropDimensions,
  buildDynamicReframingTrack,
  generateFallbackReframingTrack,
  applyDynamicReframingToCandidate,
  buildReframingFFmpegCropFilter,
  normalizeFaceBox,
  SubjectTracker,
} from "../../src/lib/shortsReframing.js";

import {
  normalizeShortsSettings,
  discoverShortCandidates,
  convertCandidateToProject,
} from "../../src/lib/shortsStudio.js";

import {
  calculateRepackagingCrop,
  repackageShortCandidate,
} from "../../src/lib/shortsRepackaging.js";

import {
  normalizeSmartFrame,
  resolveSmartFrameCropAtTime,
  smartFrameCropToPixels,
} from "../../src/lib/smartFrame.js";

describe("Subject-Aware Reframing Regression Test Suite", () => {
  const SOURCE_1080P = { width: 1920, height: 1080 };

  // --------------------------------------------------------------------------
  // 1. Subject Placement Tests (Woman on the right / left / center)
  // --------------------------------------------------------------------------
  describe("Subject Position Preservation (16:9 to 9:16)", () => {
    it("preserves subject on the right (x = 0.8) inside 9:16 crop window", () => {
      // Represents the user issue: woman on the right side of a 16:9 frame
      const womanFace = {
        xMin: 0.75,
        yMin: 0.15,
        xMax: 0.85,
        yMax: 0.35,
        confidence: 0.95,
      };

      const cropDims = calculateTargetCropDimensions(SOURCE_1080P, "9:16");
      // 9:16 crop width in normalized coordinates is (1080 * 9/16) / 1920 = 607.5 / 1920 ≈ 0.3164
      assert.ok(cropDims.cropW < 0.35, "9:16 crop width is roughly 31.6% of 16:9 width");

      const crop = solveFrameCrop(womanFace, cropDims, { sourceSize: SOURCE_1080P });

      // Crop window must contain the subject
      const cropLeft = crop.x;
      const cropRight = crop.x + crop.width;
      assert.ok(cropLeft <= womanFace.xMin, `Crop left (${cropLeft}) must be <= subject left (${womanFace.xMin})`);
      assert.ok(cropRight >= womanFace.xMax, `Crop right (${cropRight}) must be >= subject right (${womanFace.xMax})`);

      // Subject center is at 0.8; crop should be shifted far to the right
      assert.ok(crop.x > 0.5, `Crop x (${crop.x}) must be shifted right (> 0.5)`);
      assert.ok(crop.panFactor > 0.7, `panFactor (${crop.panFactor}) must be > 0.7 for subject on right`);
      assert.equal(crop.isFallback, false);
      assert.equal(crop.state, "tracked");
    });

    it("preserves subject on the left (x = 0.2) inside 9:16 crop window", () => {
      const subjectLeft = {
        xMin: 0.15,
        yMin: 0.2,
        xMax: 0.25,
        yMax: 0.4,
        confidence: 0.9,
      };

      const cropDims = calculateTargetCropDimensions(SOURCE_1080P, "9:16");
      const crop = solveFrameCrop(subjectLeft, cropDims, { sourceSize: SOURCE_1080P });

      const cropLeft = crop.x;
      const cropRight = crop.x + crop.width;
      assert.ok(cropLeft <= subjectLeft.xMin, `Crop left (${cropLeft}) must be <= subject left (${subjectLeft.xMin})`);
      assert.ok(cropRight >= subjectLeft.xMax, `Crop right (${cropRight}) must be >= subject right (${subjectLeft.xMax})`);

      assert.ok(crop.x < 0.2, `Crop x (${crop.x}) must be shifted left (< 0.2)`);
      assert.ok(crop.panFactor < 0.3, `panFactor (${crop.panFactor}) must be < 0.3 for subject on left`);
      assert.equal(crop.isFallback, false);
      assert.equal(crop.state, "tracked");
    });

    it("centers crop when subject is in the middle (x = 0.5)", () => {
      const subjectCenter = {
        xMin: 0.45,
        yMin: 0.2,
        xMax: 0.55,
        yMax: 0.4,
        confidence: 0.95,
      };

      const cropDims = calculateTargetCropDimensions(SOURCE_1080P, "9:16");
      const crop = solveFrameCrop(subjectCenter, cropDims, { sourceSize: SOURCE_1080P });

      const expectedCenterX = (1 - cropDims.cropW) / 2;
      assert.ok(Math.abs(crop.x - expectedCenterX) < 0.05, `Crop x (${crop.x}) should be centered near ${expectedCenterX}`);
      assert.ok(Math.abs(crop.panFactor - 0.5) < 0.05, `panFactor (${crop.panFactor}) should be near 0.5`);
    });

    it("clamps safely at boundary without out-of-bounds coordinates (x = 0.95)", () => {
      const subjectExtremeRight = {
        xMin: 0.92,
        yMin: 0.2,
        xMax: 0.98,
        yMax: 0.4,
        confidence: 0.85,
      };

      const cropDims = calculateTargetCropDimensions(SOURCE_1080P, "9:16");
      const crop = solveFrameCrop(subjectExtremeRight, cropDims, { sourceSize: SOURCE_1080P });

      assert.ok(crop.x >= 0 && crop.x <= 1 - crop.width, "Crop x stays within valid bounds");
      assert.ok(crop.x + crop.width <= 1.0001, "Crop right does not exceed 1.0");
      assert.equal(crop.panFactor, 1, "panFactor is clamped to 1.0 at right edge");
    });

    it("clamps safely at left boundary (x = 0.02)", () => {
      const subjectExtremeLeft = {
        xMin: 0.01,
        yMin: 0.2,
        xMax: 0.08,
        yMax: 0.4,
        confidence: 0.85,
      };

      const cropDims = calculateTargetCropDimensions(SOURCE_1080P, "9:16");
      const crop = solveFrameCrop(subjectExtremeLeft, cropDims, { sourceSize: SOURCE_1080P });

      assert.ok(crop.x >= 0, "Crop x does not go negative");
      assert.equal(crop.panFactor, 0, "panFactor is clamped to 0.0 at left edge");
    });
  });

  // --------------------------------------------------------------------------
  // 2. Multi-Aspect Ratio Matrix (9:16, 1:1, 4:5, 16:9)
  // --------------------------------------------------------------------------
  describe("Aspect Ratio Matrix Compatibility", () => {
    const subjectRight = { xMin: 0.72, yMin: 0.2, xMax: 0.82, yMax: 0.45 };

    const ratios = ["9:16", "1:1", "4:5", "16:9"];

    ratios.forEach((ratio) => {
      it(`evaluates subject containment correctly for ratio ${ratio}`, () => {
        const cropDims = calculateTargetCropDimensions(SOURCE_1080P, ratio);
        const crop = solveFrameCrop(subjectRight, cropDims, { sourceSize: SOURCE_1080P });

        // Geometry checks
        assert.ok(crop.x >= 0, `crop.x >= 0 for ${ratio}`);
        assert.ok(crop.y >= 0, `crop.y >= 0 for ${ratio}`);
        assert.ok(crop.x + crop.width <= 1.0001, `crop.x + width <= 1 for ${ratio}`);
        assert.ok(crop.y + crop.height <= 1.0001, `crop.y + height <= 1 for ${ratio}`);

        if (ratio !== "16:9") {
          // If crop is narrower than source, it should be shifted toward the subject on the right
          assert.ok(crop.x > 0.1, `crop.x is shifted right for ${ratio}`);
          assert.ok(crop.panFactor > 0.5, `panFactor > 0.5 for ${ratio}`);
        } else {
          // 16:9 source to 16:9 target: full frame
          assert.equal(crop.x, 0);
          assert.equal(crop.width, 1);
        }
      });
    });
  });

  // --------------------------------------------------------------------------
  // 3. Coordinate Normalization Formats
  // --------------------------------------------------------------------------
  describe("Coordinate Normalization Robustness", () => {
    it("handles pixel coordinates and normalizes them correctly using sourceSize", () => {
      // 1920x1080 source: woman at x=1440..1632 (which is 0.75..0.85)
      const pixelBox = {
        xMin: 1440,
        yMin: 162,
        xMax: 1632,
        yMax: 378,
      };

      const normalized = normalizeFaceBox(pixelBox, SOURCE_1080P);
      assert.ok(Math.abs(normalized.xMin - 0.75) < 0.01, `xMin should be 0.75, got ${normalized.xMin}`);
      assert.ok(Math.abs(normalized.xMax - 0.85) < 0.01, `xMax should be 0.85, got ${normalized.xMax}`);
      assert.ok(Math.abs(normalized.yMin - 0.15) < 0.01, `yMin should be 0.15, got ${normalized.yMin}`);
    });

    it("unwraps nested detector structures ({ label, box, face })", () => {
      const nested = {
        label: "person",
        score: 0.92,
        box: {
          xMin: 0.7,
          yMin: 0.2,
          xMax: 0.85,
          yMax: 0.5,
        },
      };

      const normalized = normalizeFaceBox(nested, SOURCE_1080P);
      assert.equal(normalized.xMin, 0.7);
      assert.equal(normalized.xMax, 0.85);
      assert.equal(normalized.label, "person");
    });
  });

  // --------------------------------------------------------------------------
  // 4. Dynamic Reframing Track & Velocity Limit
  // --------------------------------------------------------------------------
  describe("Dynamic Reframing Track Generation", () => {
    it("generates reframing track that preserves right-side subject throughout clip", () => {
      const detections = [
        { time: 0, xMin: 0.75, yMin: 0.2, xMax: 0.85, yMax: 0.4 },
        { time: 2, xMin: 0.76, yMin: 0.2, xMax: 0.86, yMax: 0.4 },
        { time: 5, xMin: 0.74, yMin: 0.2, xMax: 0.84, yMax: 0.4 },
      ];

      const track = buildDynamicReframingTrack({
        detections,
        duration: 5,
        sourceSize: SOURCE_1080P,
        targetRatio: "9:16",
        manualCropX: 0.5,
      });

      assert.ok(track.cropKeyframes.length >= 2, "Has crop keyframes");
      track.cropKeyframes.forEach((kf) => {
        assert.ok(kf.x > 0.5, `Keyframe at t=${kf.time} has crop.x > 0.5`);
        assert.ok(kf.panFactor > 0.7, `Keyframe panFactor > 0.7`);
        assert.equal(kf.state, "tracked");
      });
      assert.equal(track.isFallback, false);
      assert.equal(track.state, "tracked");
    });

    it("clamps smoothed velocity so rapid subject movement never pushes subject outside frame", () => {
      // Rapid step from 0.4 to 0.85
      const detections = [
        { time: 0, xMin: 0.4, yMin: 0.2, xMax: 0.5, yMax: 0.4 },
        { time: 0.2, xMin: 0.8, yMin: 0.2, xMax: 0.9, yMax: 0.4 },
      ];

      const track = buildDynamicReframingTrack({
        detections,
        duration: 1,
        sourceSize: SOURCE_1080P,
        targetRatio: "9:16",
      });

      const kfLast = track.cropKeyframes[track.cropKeyframes.length - 1];
      const cropW = track.cropDims.cropW;
      // Even with smoothing lag, containment clamping ensures kfLast covers the subject
      assert.ok(kfLast.x + cropW >= 0.85, "Crop covers right subject despite fast pan");
    });
  });

  // --------------------------------------------------------------------------
  // 5. Fallback Handling and Badge Suppression
  // --------------------------------------------------------------------------
  describe("Fallback Reframing & 'Subject-aware crop' Badge Behavior", () => {
    it("marks fallback track with isFallback=true, state='fallback', confidence=0 when detections are missing", () => {
      const fallbackTrack = generateFallbackReframingTrack(
        SOURCE_1080P,
        "9:16",
        15,
        0.5
      );

      assert.equal(fallbackTrack.isFallback, true);
      assert.equal(fallbackTrack.state, "fallback");
      assert.equal(fallbackTrack.confidence, 0);
      assert.equal(fallbackTrack.cropKeyframes[0].state, "fallback");
      assert.equal(fallbackTrack.cropKeyframes[0].confidence, 0);
    });

    it("normalizeSmartFrame propagates isFallback and state correctly", () => {
      const fallbackSmartFrame = normalizeSmartFrame({
        version: 2,
        enabled: true,
        targetRatio: "9:16",
        state: "fallback",
        confidence: 0,
        metadata: { status: "fallback", isFallback: true },
        sourceSize: SOURCE_1080P,
        cropKeyframes: [
          { time: 0, x: 0.34, y: 0, width: 0.32, height: 1, state: "fallback", confidence: 0 },
        ],
      });

      assert.equal(fallbackSmartFrame.isFallback, true);
      assert.equal(fallbackSmartFrame.state, "fallback");
      assert.equal(fallbackSmartFrame.confidence, 0);

      const resolved = resolveSmartFrameCropAtTime(fallbackSmartFrame, 0);
      assert.equal(resolved.isFallback, true);
      assert.equal(resolved.state, "fallback");

      const pixelCrop = smartFrameCropToPixels(resolved, SOURCE_1080P);
      assert.equal(pixelCrop.isFallback, true);
      assert.equal(pixelCrop.state, "fallback");

      // Verifies the exact condition checked in App.jsx for smartCropActive
      const smartCropActive = Boolean(pixelCrop && !pixelCrop.isFallback && pixelCrop.state !== "fallback");
      assert.equal(smartCropActive, false, "Subject-aware crop badge is NOT active for fallback");
    });

    it("activates badge when tracked detections are present", () => {
      const trackedSmartFrame = normalizeSmartFrame({
        version: 2,
        enabled: true,
        targetRatio: "9:16",
        state: "tracked",
        confidence: 0.9,
        sourceSize: SOURCE_1080P,
        cropKeyframes: [
          { time: 0, x: 0.54, y: 0, width: 0.32, height: 1, state: "tracked", confidence: 0.9 },
        ],
      });

      assert.equal(trackedSmartFrame.isFallback, false);
      assert.equal(trackedSmartFrame.state, "tracked");

      const resolved = resolveSmartFrameCropAtTime(trackedSmartFrame, 0);
      const pixelCrop = smartFrameCropToPixels(resolved, SOURCE_1080P);
      const smartCropActive = Boolean(pixelCrop && !pixelCrop.isFallback && pixelCrop.state !== "fallback");
      assert.equal(smartCropActive, true, "Subject-aware crop badge is active when tracking succeeded");
    });
  });

  // --------------------------------------------------------------------------
  // 6. End-to-End Pipeline Integration (Discovery -> Convert to Project)
  // --------------------------------------------------------------------------
  describe("AI Shorts Studio End-to-End Discovery and Project Conversion", () => {
    it("discovers candidate and attaches right-side subject reframing in 9:16", () => {
      const sourceMedia = {
        id: "media-right-subject",
        duration: 30,
        width: 1920,
        height: 1080,
        faceDetections: [
          { time: 5, xMin: 0.75, yMin: 0.2, xMax: 0.85, yMax: 0.4 },
          { time: 10, xMin: 0.76, yMin: 0.2, xMax: 0.86, yMax: 0.4 },
          { time: 15, xMin: 0.74, yMin: 0.2, xMax: 0.84, yMax: 0.4 },
        ],
      };

      const discovery = discoverShortCandidates({
        sourceMedia,
        transcriptResult: [
          { start: 2, end: 18, text: "Here is an amazing showcase of our new products and ideas." },
        ],
        settings: {
          aspectRatio: "9:16",
          autoReframing: "smart-zoom",
        },
      });

      assert.ok(discovery.ok, "Discovery succeeded");
      assert.ok(discovery.candidates.length > 0, "Discovered candidates");

      const cand = discovery.candidates[0];
      assert.ok(cand.smartFrame, "Candidate has smartFrame attached");
      assert.equal(cand.smartFrame.isFallback, false);
      assert.ok(cand.cropX > 0.65, `Candidate cropX (${cand.cropX}) represents panFactor shifted right`);

      // Convert candidate to project
      const project = convertCandidateToProject(sourceMedia, cand, {
        aspectRatio: "9:16",
      });

      assert.ok(project, "Project successfully generated");
      const visual = project.visualSegments[0];
      assert.ok(visual, "Has visual segment");
      assert.ok(visual.cropX > 0.65, `visual.cropX (${visual.cropX}) matches candidate panFactor`);
      assert.ok(visual.objectPosition.includes("%"), "visual.objectPosition is defined");

      // Verify clampedX in smartFrame keyframes contains the subject
      const kf0 = visual.smartFrame.cropKeyframes[0];
      const cropW = kf0.width;
      assert.ok(kf0.x <= 0.75, `Crop start (${kf0.x}) <= subject start (0.75)`);
      assert.ok(kf0.x + cropW >= 0.85, `Crop end (${kf0.x + cropW}) >= subject end (0.85)`);
    });

    it("synchronizes FFmpeg crop filter plan with CSS preview panFactor", () => {
      const faceRight = { xMin: 0.75, yMin: 0.2, xMax: 0.85, yMax: 0.4 };
      const track = buildDynamicReframingTrack({
        detections: [{ time: 0, ...faceRight }],
        duration: 10,
        sourceSize: SOURCE_1080P,
        targetRatio: "9:16",
      });

      const ffmpegFilter = buildReframingFFmpegCropFilter(track);
      assert.ok(ffmpegFilter, "Generated FFmpeg filter");

      // Verify filter contains out_w and out_h calculation
      assert.ok(ffmpegFilter.includes("crop="), "Contains crop directive");
      assert.ok(ffmpegFilter.includes("in_w-out_w"), "Uses normalized excess width multiplier");

      // In 9:16, for subject at 0.8:
      // panFactor = kf0.panFactor ≈ 0.8
      // Expected CSS objectPosition: `${(panFactor * 100).toFixed(1)}% 50%`
      const panFactor = track.cropKeyframes[0].panFactor;
      assert.ok(panFactor > 0.7, `panFactor (${panFactor}) is > 0.7`);

      // In FFmpeg, panFactor * (in_w - out_w) matches CSS object-position P% * (in_w - out_w)
      assert.ok(ffmpegFilter.includes(panFactor.toFixed(4)), `FFmpeg filter uses panFactor ${panFactor.toFixed(4)}`);
    });
  });

  // --------------------------------------------------------------------------
  // 7. Multi-Person Subject Selection & Background Object Filtering
  // --------------------------------------------------------------------------
  describe("Multi-Person Subject Selection & Background Object Rejection", () => {
    it("rejects central background objects (vase, cabinet, chair) in favor of side-positioned people", () => {
      // Scene reproduces user problem: people on left and right, vase and cabinet in the center
      const detections = [
        { id: "person-left", label: "person", confidence: 0.90, box: { xMin: 0.10, yMin: 0.20, xMax: 0.22, yMax: 0.50 } },
        { id: "person-right", label: "person", confidence: 0.88, box: { xMin: 0.78, yMin: 0.20, xMax: 0.90, yMax: 0.50 } },
        { id: "vase-center", label: "vase", confidence: 0.98, box: { xMin: 0.46, yMin: 0.35, xMax: 0.54, yMax: 0.65 } },
        { id: "cabinet-center", label: "cabinet", confidence: 0.95, box: { xMin: 0.40, yMin: 0.25, xMax: 0.60, yMax: 0.85 } },
      ];

      const cropDims = calculateTargetCropDimensions(SOURCE_1080P, "9:16");
      const selected = selectPrimaryFace(detections, null, { sourceSize: SOURCE_1080P, cropDims });

      assert.ok(selected, "A subject was selected");
      assert.notEqual(selected.label, "vase", "Vase was rejected");
      assert.notEqual(selected.label, "cabinet", "Cabinet was rejected");
      assert.ok(selected.isPerson, "Selected subject is a person");

      const crop = solveFrameCrop(selected, cropDims, { sourceSize: SOURCE_1080P });
      // The crop must contain the selected person, NOT center around the vase at 0.5
      assert.ok(
        (crop.x <= 0.10 && crop.x + crop.width >= 0.22) || (crop.x <= 0.78 && crop.x + crop.width >= 0.90),
        `Crop window [${crop.x}, ${crop.x + crop.width}] must cleanly contain one of the people, not the center void`
      );
      assert.ok(crop.panFactor < 0.25 || crop.panFactor > 0.75, "panFactor is focused on one side, not centered at 0.5");
    });

    it("creates a feasible group crop when multiple people fit comfortably inside the target crop", () => {
      // Two people standing side-by-side near center (span 0.42 to 0.62 = 0.20 width <= 0.3164 9:16 crop width)
      const people = [
        { id: "person-1", label: "person", confidence: 0.92, box: { xMin: 0.42, yMin: 0.20, xMax: 0.50, yMax: 0.50 } },
        { id: "person-2", label: "person", confidence: 0.91, box: { xMin: 0.54, yMin: 0.20, xMax: 0.62, yMax: 0.50 } },
      ];

      const cropDims = calculateTargetCropDimensions(SOURCE_1080P, "9:16");
      const selected = selectPrimaryFace(people, null, { sourceSize: SOURCE_1080P, cropDims, allowGroupCrop: true });

      assert.ok(selected, "Subject selected");
      assert.equal(selected.isGroup, true, "Group crop identified");
      assert.equal(selected.membersCount, 2, "Both group members counted");

      const crop = solveFrameCrop(selected, cropDims, { sourceSize: SOURCE_1080P });
      // Both people must be contained in the resulting crop
      assert.ok(crop.x <= 0.42, `Crop left (${crop.x}) covers Person 1 left (0.42)`);
      assert.ok(crop.x + crop.width >= 0.62, `Crop right (${crop.x + crop.width}) covers Person 2 right (0.62)`);
      assert.equal(crop.isGroup, true);
    });

    it("chooses one primary person predictably when a group crop is infeasible (too wide to fit)", () => {
      // Two people at opposite ends: Person 1 at x=0.15, Person 2 at x=0.85
      const people = [
        { id: "person-left", label: "person", confidence: 0.92, box: { xMin: 0.10, yMin: 0.20, xMax: 0.20, yMax: 0.50 } },
        { id: "person-right", label: "person", confidence: 0.90, box: { xMin: 0.80, yMin: 0.20, xMax: 0.90, yMax: 0.50 } },
      ];

      const cropDims = calculateTargetCropDimensions(SOURCE_1080P, "9:16");
      const selected = selectPrimaryFace(people, null, { sourceSize: SOURCE_1080P, cropDims });

      assert.ok(selected, "Selected primary person");
      assert.equal(Boolean(selected.isGroup), false, "Did not create impossible group crop");

      const crop = solveFrameCrop(selected, cropDims, { sourceSize: SOURCE_1080P });
      // Must focus on one person, NEVER in the middle
      const onLeft = crop.x <= 0.10 && crop.x + crop.width >= 0.20;
      const onRight = crop.x <= 0.80 && crop.x + crop.width >= 0.90;
      assert.ok(onLeft || onRight, `Crop [${crop.x}, ${crop.x + crop.width}] covers one person cleanly`);
      assert.ok(Math.abs(crop.panFactor - 0.5) > 0.2, "panFactor is not centered in the middle void");
    });

    it("maintains stable tracking continuity and hysteresis across consecutive frames", () => {
      // Frame 1: Person A has slightly higher score
      const frame1People = [
        { id: "pA", label: "person", confidence: 0.91, box: { xMin: 0.10, yMin: 0.20, xMax: 0.20, yMax: 0.50 } },
        { id: "pB", label: "person", confidence: 0.90, box: { xMin: 0.80, yMin: 0.20, xMax: 0.90, yMax: 0.50 } },
      ];
      const cropDims = calculateTargetCropDimensions(SOURCE_1080P, "9:16");
      const selectedF1 = selectPrimaryFace(frame1People, null, { sourceSize: SOURCE_1080P, cropDims });
      assert.ok(selectedF1.xMin < 0.3, "Person A (left) was initially selected");

      // Frame 2: Person B gets a slight temporary boost in confidence (0.94 vs 0.90)
      const frame2People = [
        { id: "pA", label: "person", confidence: 0.89, box: { xMin: 0.10, yMin: 0.20, xMax: 0.20, yMax: 0.50 } },
        { id: "pB", label: "person", confidence: 0.94, box: { xMin: 0.80, yMin: 0.20, xMax: 0.90, yMax: 0.50 } },
      ];
      const selectedF2 = selectPrimaryFace(frame2People, selectedF1, { sourceSize: SOURCE_1080P, cropDims });
      // Hysteresis continuity bonus must keep tracking Person A!
      assert.ok(selectedF2.xMin < 0.3, "Hysteresis prevents jumping to Person B on minor confidence changes");
    });

    it("respects explicit manual / userSelectedSubject overrides", () => {
      const people = [
        { id: "person-left", label: "person", confidence: 0.95, box: { xMin: 0.10, yMin: 0.20, xMax: 0.20, yMax: 0.50 } },
        { id: "person-right", label: "person", confidence: 0.85, box: { xMin: 0.80, yMin: 0.20, xMax: 0.90, yMax: 0.50 } },
      ];

      const cropDims = calculateTargetCropDimensions(SOURCE_1080P, "9:16");
      // Explicitly override to target person-right
      const selected = selectPrimaryFace(people, null, {
        sourceSize: SOURCE_1080P,
        cropDims,
        userSelectedSubject: "person-right",
      });

      assert.ok(selected, "Subject selected");
      assert.ok(selected.xMin >= 0.75, "Explicit user selection for person-right honored");

      const crop = solveFrameCrop(selected, cropDims, { sourceSize: SOURCE_1080P, userSelectedSubject: "person-right" });
      assert.ok(crop.x + crop.width >= 0.90, "Crop frames right person based on user selection");
      assert.ok(crop.panFactor > 0.7, "panFactor is shifted right");
    });

    it("coasts through temporary occlusion / missing detections without snapping to center", () => {
      // 5-second track: person at x=0.82 detected at t=0, 1; missing at t=2; reappears at t=3, 4
      const detections = [
        { time: 0, xMin: 0.80, yMin: 0.2, xMax: 0.90, yMax: 0.4 },
        { time: 1, xMin: 0.81, yMin: 0.2, xMax: 0.91, yMax: 0.4 },
        { time: 2, faces: [] }, // temporary occlusion / detection loss
        { time: 3, xMin: 0.80, yMin: 0.2, xMax: 0.90, yMax: 0.4 },
        { time: 4, xMin: 0.82, yMin: 0.2, xMax: 0.92, yMax: 0.4 },
      ];

      const track = buildDynamicReframingTrack({
        detections,
        duration: 5,
        sourceSize: SOURCE_1080P,
        targetRatio: "9:16",
      });

      assert.ok(track.cropKeyframes.length >= 2, "Keyframes generated");
      // Keyframes must remain shifted to the right (panFactor > 0.6) throughout without snapping to center
      track.cropKeyframes.forEach((kf) => {
        assert.ok(kf.panFactor > 0.6, `Keyframe at t=${kf.time} stays on right (panFactor=${kf.panFactor}) rather than snapping to center`);
      });
    });

    it("adjusts headroom safely for full-body person detections", () => {
      const fullPerson = {
        label: "person",
        xMin: 0.40,
        yMin: 0.15,
        xMax: 0.60,
        yMax: 0.95, // height = 0.80
        confidence: 0.95,
      };

      const cropDims = calculateTargetCropDimensions(SOURCE_1080P, "9:16");
      const normalized = normalizeFaceBox(fullPerson, SOURCE_1080P);
      assert.equal(normalized.isFace, false, "Correctly marked as not just a face");

      const crop = solveFrameCrop(normalized, cropDims, { sourceSize: SOURCE_1080P });
      // Head is at yMin = 0.15. In portrait 9:16, height = 1.0, idealY = Math.max(0, 0.15 - 0.08) = 0.07.
      // Head must not be clipped!
      assert.ok(crop.y <= fullPerson.yMin, `Crop y (${crop.y}) protects head top (${fullPerson.yMin})`);
      assert.ok(crop.y >= 0, "Crop y stays non-negative");
    });
  });

  // --------------------------------------------------------------------------
  // 8 Target Regression Scenarios for Stable Tracking & Keyframe Preservation
  // --------------------------------------------------------------------------
  describe("Target Regression Scenarios: Tracking, Boundary, Cuts & Keyframe Preservation", () => {
    const cropDims916 = calculateTargetCropDimensions(SOURCE_1080P, "9:16");

    // 1. A person near the left or right boundary
    it("Scenario 1: Person near the left or right boundary is clamped safely within valid source bounds", () => {
      const leftBoundaryPerson = {
        label: "person",
        xMin: 0.005,
        yMin: 0.20,
        xMax: 0.18,
        yMax: 0.60,
        confidence: 0.95,
      };
      const rightBoundaryPerson = {
        label: "person",
        xMin: 0.85,
        yMin: 0.20,
        xMax: 0.995,
        yMax: 0.60,
        confidence: 0.95,
      };

      const cropLeft = solveFrameCrop(leftBoundaryPerson, cropDims916, { sourceSize: SOURCE_1080P });
      assert.ok(cropLeft.x >= 0, `Left boundary crop x (${cropLeft.x}) must be >= 0`);
      assert.ok(cropLeft.x + cropLeft.width <= 1.0001, `Left boundary crop right must be <= 1`);
      assert.ok(cropLeft.x <= leftBoundaryPerson.xMin, "Left boundary subject remains inside crop");

      const cropRight = solveFrameCrop(rightBoundaryPerson, cropDims916, { sourceSize: SOURCE_1080P });
      assert.ok(cropRight.x >= 0, `Right boundary crop x (${cropRight.x}) must be >= 0`);
      assert.ok(cropRight.x + cropRight.width <= 1.0001, `Right boundary crop right must be <= 1`);
      assert.ok(cropRight.x + cropRight.width >= rightBoundaryPerson.xMax, "Right boundary subject remains inside crop");
    });

    // 2. A moving person
    it("Scenario 2: Moving person is tracked smoothly and smoothing lag never leaves the subject outside frame", () => {
      // Person moving across from x=0.20 to x=0.75 over 5 seconds
      const detections = [
        { time: 0, xMin: 0.15, yMin: 0.2, xMax: 0.25, yMax: 0.5 },
        { time: 1, xMin: 0.28, yMin: 0.2, xMax: 0.38, yMax: 0.5 },
        { time: 2, xMin: 0.42, yMin: 0.2, xMax: 0.52, yMax: 0.5 },
        { time: 3, xMin: 0.55, yMin: 0.2, xMax: 0.65, yMax: 0.5 },
        { time: 4, xMin: 0.68, yMin: 0.2, xMax: 0.78, yMax: 0.5 },
      ];

      const track = buildDynamicReframingTrack({
        detections,
        duration: 5,
        sourceSize: SOURCE_1080P,
        targetRatio: "9:16",
        motion: "smooth",
      });

      assert.ok(track.cropKeyframes.length >= 4, "Track generated smooth keyframes");
      // Verify every sampled time has subject inside the crop window
      for (const det of detections) {
        const cropAtTime = resolveSmartFrameCropAtTime(track, det.time);
        const cropLeft = cropAtTime.x;
        const cropRight = cropAtTime.x + cropAtTime.width;
        assert.ok(
          cropLeft <= det.xMin + 0.02 && cropRight >= det.xMax - 0.02,
          `Subject at t=${det.time} [${det.xMin}, ${det.xMax}] must remain inside crop [${cropLeft.toFixed(3)}, ${cropRight.toFixed(3)}]`
        );
      }
    });

    // 3. Two people in the same shot
    it("Scenario 3: Two people in the same shot selects a real subject and never centers in the empty gap", () => {
      const candidates = [
        { id: "person-left", label: "person", confidence: 0.95, box: { xMin: 0.05, yMin: 0.15, xMax: 0.25, yMax: 0.55 } },
        { id: "person-right", label: "person", confidence: 0.94, box: { xMin: 0.75, yMin: 0.15, xMax: 0.95, yMax: 0.55 } },
      ];

      const selected = selectPrimaryFace(candidates, null, {
        sourceSize: SOURCE_1080P,
        cropDims: cropDims916,
      });
      assert.ok(selected, "Selected a primary person");

      const crop = solveFrameCrop(selected, cropDims916, { sourceSize: SOURCE_1080P });
      const cropCenter = crop.x + crop.width / 2;
      const isInEmptyDeadCenter = cropCenter >= 0.45 && cropCenter <= 0.55;
      assert.equal(isInEmptyDeadCenter, false, `Crop center (${cropCenter}) must NOT be in the empty gap [0.45, 0.55]`);
      assert.ok(crop.x + crop.width >= 0.85 || crop.x <= 0.15, "Frames one of the real people");
    });

    // 4. A shot change
    it("Scenario 4: Shot change inserts hold frame before cut and resolveSmartFrameCropAtTime does NOT pan across cut", () => {
      // Shot 1: person at x=0.20 (t=0, 2s). Cut at t=4s. Shot 2: person at x=0.75 (t=4, 6s)
      const detections = [
        { time: 0, xMin: 0.15, yMin: 0.2, xMax: 0.25, yMax: 0.5 },
        { time: 2, xMin: 0.15, yMin: 0.2, xMax: 0.25, yMax: 0.5 },
        { time: 4, xMin: 0.70, yMin: 0.2, xMax: 0.80, yMax: 0.5 },
        { time: 6, xMin: 0.70, yMin: 0.2, xMax: 0.80, yMax: 0.5 },
      ];

      const track = buildDynamicReframingTrack({
        detections,
        duration: 6,
        sourceSize: SOURCE_1080P,
        targetRatio: "9:16",
        sceneCuts: [4.0],
      });

      // Keyframes should contain hold frame before 4.0s and cut keyframe at 4.0s
      const cutKf = track.cropKeyframes.find((kf) => Math.abs(kf.time - 4.0) < 0.01);
      const holdKf = track.cropKeyframes.find((kf) => Math.abs(kf.time - 3.96) < 0.02);
      assert.ok(holdKf, "Hold keyframe placed immediately before cut");
      assert.ok(cutKf, "Cut keyframe found at t=4.0s");
      assert.equal(Boolean(cutKf.cut || cutKf.isCut), true, "Cut flag preserved on cut keyframe");

      // Verify that at t=3.5s (before cut), framing is still on Shot 1 (left side)
      const cropAt35 = resolveSmartFrameCropAtTime(track, 3.5);
      assert.ok(cropAt35.x < 0.25, `Crop at t=3.5s (${cropAt35.x}) holds Shot 1 and does NOT pan to empty center`);

      // Verify that at t=4.0s (after cut), framing jumps immediately to Shot 2 (right side)
      const cropAt40 = resolveSmartFrameCropAtTime(track, 4.0);
      assert.ok(cropAt40.x > 0.50, `Crop at t=4.0s (${cropAt40.x}) switches immediately to Shot 2`);
    });

    // 5. Temporary detection loss
    it("Scenario 5: Temporary detection loss enters coasting and avoids snapping to center", () => {
      const detections = [
        { time: 0, xMin: 0.75, yMin: 0.2, xMax: 0.85, yMax: 0.5 },
        { time: 1, xMin: 0.75, yMin: 0.2, xMax: 0.85, yMax: 0.5 },
        { time: 2.5, faces: [] }, // detection temporarily lost
        { time: 4, xMin: 0.75, yMin: 0.2, xMax: 0.85, yMax: 0.5 },
      ];

      const track = buildDynamicReframingTrack({
        detections,
        duration: 5,
        sourceSize: SOURCE_1080P,
        targetRatio: "9:16",
      });

      const cropAtLoss = resolveSmartFrameCropAtTime(track, 2.5);
      assert.ok(cropAtLoss.x > 0.50, `Crop during temporary loss at t=2.5s (${cropAtLoss.x}) maintains coasting on right`);
      assert.equal(cropAtLoss.state, "coast", "State marks coast during occlusion");
    });

    // 6. A person wider than the portrait crop
    it("Scenario 6: Person wider than the portrait crop is centered on head/torso without being cut out", () => {
      const widePerson = {
        label: "person",
        xMin: 0.10,
        yMin: 0.15,
        xMax: 0.70, // width = 0.60, wider than cropDims916.width (0.3164)
        yMax: 0.85,
        confidence: 0.95,
      };

      const crop = solveFrameCrop(widePerson, cropDims916, { sourceSize: SOURCE_1080P });
      const cropCenter = crop.x + crop.width / 2;
      const personCenter = (widePerson.xMin + widePerson.xMax) / 2; // 0.40
      assert.ok(
        Math.abs(cropCenter - personCenter) < 0.05,
        `Crop center (${cropCenter}) should be centered on wide person's torso (${personCenter})`
      );
      assert.ok(crop.x >= 0 && crop.x + crop.width <= 1.0001, "Coordinates are within valid bounds");
    });

    // 7. Crop bounds and subject visibility
    it("Scenario 7: Clamps all crop coordinates to valid source bounds and preserves headroom", () => {
      const person = {
        label: "person",
        xMin: 0.40,
        yMin: 0.05,
        xMax: 0.60,
        yMax: 0.75,
        confidence: 0.95,
      };

      const crop = solveFrameCrop(person, cropDims916, { sourceSize: SOURCE_1080P });
      assert.ok(crop.x >= 0, "x >= 0");
      assert.ok(crop.y >= 0, "y >= 0");
      assert.ok(crop.x + crop.width <= 1.0001, "x + width <= 1");
      assert.ok(crop.y + crop.height <= 1.0001, "y + height <= 1");
      assert.ok(crop.y <= person.yMin, "Headroom preserved above person's top");
    });

    // 8. Timeline preservation of crop keyframes
    it("Scenario 8: Timeline project conversion preserves subject tracking metadata and does not overwrite with centered crop", () => {
      const dummyClip = {
        id: "clip-1",
        width: 1920,
        height: 1080,
        duration: 15,
      };
      const candidateWithTrack = {
        id: "cand-1",
        title: "Subject Aware Clip",
        startTime: 0,
        endTime: 15,
        duration: 15,
        aspectRatio: "9:16",
        framingMode: "smart-subject",
        smartFrame: {
          version: 2,
          enabled: true,
          targetRatio: "9:16",
          presentation: "crop",
          isFallback: false,
          state: "tracked",
          cropKeyframes: [
            { time: 0, x: 0.65, y: 0, width: 0.3164, height: 1, panFactor: 0.95, confidence: 1, state: "tracked" },
            { time: 15, x: 0.65, y: 0, width: 0.3164, height: 1, panFactor: 0.95, confidence: 1, state: "tracked" },
          ],
        },
      };

      const project = convertCandidateToProject(dummyClip, candidateWithTrack, {
        aspectRatio: "9:16",
        autoReframing: "smart-subject",
      });

      assert.ok(project.visualSegments?.[0]?.smartFrame, "Timeline visualSegment has smartFrame");
      const sf = project.visualSegments[0].smartFrame;
      assert.equal(sf.isFallback, false, "Not marked as fallback");
      assert.equal(sf.state, "tracked", "Preserved tracked state");
      assert.ok(sf.cropKeyframes?.length >= 2, "Crop keyframes transferred to timeline");
      assert.ok(sf.cropKeyframes[0].x > 0.5, "Track coordinates preserved without being reset to 0.5 center");
    });
  });

  describe("Regression Requirements Suite: Automatic Reframing & Subject Selection", () => {
    // 1. Two people are detected, but the crop follows the selected person rather than their midpoint.
    it("Requirement 1: Two people are detected, but the crop follows the selected person rather than their midpoint", () => {
      const people = [
        { id: "person-left", label: "person", confidence: 0.95, box: { xMin: 0.15, yMin: 0.20, xMax: 0.25, yMax: 0.50 } },
        { id: "person-right", label: "person", confidence: 0.95, box: { xMin: 0.70, yMin: 0.20, xMax: 0.80, yMax: 0.50 } },
      ];
      const cropDims = calculateTargetCropDimensions(SOURCE_1080P, "9:16");
      const selected = selectPrimaryFace(people, null, { sourceSize: SOURCE_1080P, cropDims });

      assert.ok(selected, "Subject selected");
      assert.notEqual(selected.isGroup, true, "Must NOT produce a group crop");
      assert.ok(selected.id === "person-left" || selected.id === "person-right", "Must select one specific person");

      const crop = solveFrameCrop(selected, cropDims, { sourceSize: SOURCE_1080P });
      const midpoint = (0.20 + 0.75) / 2; // 0.475
      const cropCenter = crop.x + crop.width / 2;
      assert.ok(
        Math.abs(cropCenter - midpoint) > 0.15,
        `Crop center (${cropCenter.toFixed(3)}) must NOT center on the empty space/midpoint between people (${midpoint})`
      );
    });

    // 2. The selected person moves left and right, and the crop follows their stable track ID.
    it("Requirement 2: The selected person moves left and right, and the crop follows their stable track ID", () => {
      const tracker = new SubjectTracker();
      const frames = [
        { time: 0.0, faces: [{ id: "actor-1", label: "person", confidence: 0.95, box: { xMin: 0.20, yMin: 0.20, xMax: 0.30, yMax: 0.50 } }] },
        { time: 1.0, faces: [{ id: "actor-1", label: "person", confidence: 0.95, box: { xMin: 0.40, yMin: 0.20, xMax: 0.50, yMax: 0.50 } }] },
        { time: 2.0, faces: [{ id: "actor-1", label: "person", confidence: 0.95, box: { xMin: 0.60, yMin: 0.20, xMax: 0.70, yMax: 0.50 } }] },
      ];

      const cropDims = calculateTargetCropDimensions(SOURCE_1080P, "9:16");
      let prevSelected = null;
      const cropPositions = [];

      for (const f of frames) {
        const status = tracker.update(f.faces, f.time, false, SOURCE_1080P);
        const sel = selectPrimaryFace(f.faces, prevSelected, { sourceSize: SOURCE_1080P, cropDims, activeSpeakerId: status.activeSpeakerId });
        assert.equal(sel.id, "actor-1", "Stable track ID preserved");
        const crop = solveFrameCrop(sel, cropDims, { sourceSize: SOURCE_1080P });
        cropPositions.push(crop.x);
        prevSelected = sel;
      }

      assert.ok(cropPositions[1] > cropPositions[0], "Crop followed person moving right from 0 to 1s");
      assert.ok(cropPositions[2] > cropPositions[1], "Crop followed person moving further right from 1 to 2s");
    });

    // 3. A speaker change selects the new speaker without interpolating through the space between people.
    it("Requirement 3: A speaker change selects the new speaker without interpolating through the space between people", () => {
      const detections = [
        {
          time: 0.0,
          faces: [
            { id: "speaker-a", label: "person", confidence: 0.95, speakingScore: 0.9, isSpeaking: true, box: { xMin: 0.10, yMin: 0.20, xMax: 0.20, yMax: 0.50 } },
            { id: "speaker-b", label: "person", confidence: 0.95, speakingScore: 0.0, isSpeaking: false, box: { xMin: 0.75, yMin: 0.20, xMax: 0.85, yMax: 0.50 } },
          ],
        },
        {
          time: 1.0,
          faces: [
            { id: "speaker-a", label: "person", confidence: 0.95, speakingScore: 0.9, isSpeaking: true, box: { xMin: 0.10, yMin: 0.20, xMax: 0.20, yMax: 0.50 } },
            { id: "speaker-b", label: "person", confidence: 0.95, speakingScore: 0.0, isSpeaking: false, box: { xMin: 0.75, yMin: 0.20, xMax: 0.85, yMax: 0.50 } },
          ],
        },
        {
          time: 2.0,
          faces: [
            { id: "speaker-a", label: "person", confidence: 0.95, speakingScore: 0.0, isSpeaking: false, box: { xMin: 0.10, yMin: 0.20, xMax: 0.20, yMax: 0.50 } },
            { id: "speaker-b", label: "person", confidence: 0.95, speakingScore: 0.95, isSpeaking: true, box: { xMin: 0.75, yMin: 0.20, xMax: 0.85, yMax: 0.50 } },
          ],
        },
        {
          time: 3.0,
          faces: [
            { id: "speaker-a", label: "person", confidence: 0.95, speakingScore: 0.0, isSpeaking: false, box: { xMin: 0.10, yMin: 0.20, xMax: 0.20, yMax: 0.50 } },
            { id: "speaker-b", label: "person", confidence: 0.95, speakingScore: 0.95, isSpeaking: true, box: { xMin: 0.75, yMin: 0.20, xMax: 0.85, yMax: 0.50 } },
          ],
        },
      ];

      const track = buildDynamicReframingTrack({
        detections,
        duration: 4,
        sourceSize: SOURCE_1080P,
        targetRatio: "9:16",
        speechIntervals: [{ start: 0, end: 4 }],
      });

      assert.ok(track.cropKeyframes.length >= 3, "Generated keyframes across speaker change");

      // Verify at t = 1.0 (before switch), crop is on speaker-a (x ~ 0)
      const cropAt1 = resolveSmartFrameCropAtTime(track, 1.0);
      assert.ok(cropAt1.x < 0.20, `Crop at 1.0s (${cropAt1.x}) frames speaker-a on left`);

      // Verify at t = 1.95 (immediately before cut), crop HOLDS on speaker-a rather than floating between them
      const cropAtJustBeforeCut = resolveSmartFrameCropAtTime(track, 1.95);
      assert.ok(cropAtJustBeforeCut.x < 0.20, `Crop at 1.95s (${cropAtJustBeforeCut.x}) holds on speaker-a`);

      // Verify at t = 2.05 (after switch), crop cleanly frames speaker-b on right
      const cropAt2 = resolveSmartFrameCropAtTime(track, 2.05);
      assert.ok(cropAt2.x > 0.50, `Crop at 2.05s (${cropAt2.x}) frames speaker-b on right`);

      // Verify FFmpeg filter expression holds position across cut rather than interpolating
      const ffmpegFilter = buildReframingFFmpegCropFilter(track);
      assert.ok(ffmpegFilter.includes("crop="), "Generated FFmpeg crop filter");
      assert.ok(!ffmpegFilter.includes("NaN"), "FFmpeg filter contains no NaNs");
    });

    // 4. A larger non-speaking face does not automatically steal selection.
    it("Requirement 4: A larger non-speaking face does not automatically steal selection", () => {
      const cropDims = calculateTargetCropDimensions(SOURCE_1080P, "9:16");
      const person1 = { id: "person-tracked", label: "person", confidence: 0.90, box: { xMin: 0.15, yMin: 0.20, xMax: 0.25, yMax: 0.45 } };
      const person2Larger = { id: "person-larger", label: "person", confidence: 0.95, box: { xMin: 0.50, yMin: 0.10, xMax: 0.75, yMax: 0.65 } }; // Much larger face

      // Person 1 is currently tracked from previous frame
      const prevFace = { ...person1.box, id: person1.id };
      const selected = selectPrimaryFace([person1, person2Larger], prevFace, { sourceSize: SOURCE_1080P, cropDims });

      assert.equal(selected.id, "person-tracked", "Tracked person retains selection despite presence of larger face");
    });

    // 5. Background objects and invalid detections cannot become crop targets.
    it("Requirement 5: Background objects and invalid detections cannot become crop targets", () => {
      const cropDims = calculateTargetCropDimensions(SOURCE_1080P, "9:16");
      const detectionsWithVaseAndChair = [
        { id: "vase-1", label: "vase", confidence: 0.99, box: { xMin: 0.40, yMin: 0.40, xMax: 0.60, yMax: 0.80 } },
        { id: "chair-1", label: "chair", confidence: 0.98, box: { xMin: 0.10, yMin: 0.30, xMax: 0.35, yMax: 0.85 } },
      ];

      const selected = selectPrimaryFace(detectionsWithVaseAndChair, null, { sourceSize: SOURCE_1080P, cropDims });
      assert.equal(selected, null, "Background objects (vase, chair) are rejected; selectPrimaryFace returns null");

      // Verify buildDynamicReframingTrack falls back to explicit scene-center fallback
      const track = buildDynamicReframingTrack({
        detections: [{ time: 0, faces: detectionsWithVaseAndChair }, { time: 5, faces: detectionsWithVaseAndChair }],
        duration: 5,
        sourceSize: SOURCE_1080P,
        targetRatio: "9:16",
      });

      assert.equal(track.isFallback, true, "Marked as fallback");
      assert.equal(track.state, "fallback", "State is fallback");
      assert.equal(track.confidence, 0, "Confidence is 0 for non-person objects");
    });

    // 6. Missing detections do not cause arbitrary jumps to empty space.
    it("Requirement 6: Missing detections do not cause arbitrary jumps to empty space (coasting)", () => {
      const detections = [
        { time: 0.0, faces: [{ id: "person-1", label: "person", confidence: 0.95, box: { xMin: 0.65, yMin: 0.20, xMax: 0.75, yMax: 0.50 } }] },
        { time: 1.0, faces: [{ id: "person-1", label: "person", confidence: 0.95, box: { xMin: 0.65, yMin: 0.20, xMax: 0.75, yMax: 0.50 } }] },
        { time: 2.0, faces: [] }, // Temporary occlusion / missing detection
        { time: 2.5, faces: [] },
        { time: 3.5, faces: [{ id: "person-1", label: "person", confidence: 0.95, box: { xMin: 0.65, yMin: 0.20, xMax: 0.75, yMax: 0.50 } }] },
      ];

      const track = buildDynamicReframingTrack({
        detections,
        duration: 5,
        sourceSize: SOURCE_1080P,
        targetRatio: "9:16",
      });

      // At t = 2.0 (missing detection), the track must coast at person-1's position rather than snapping to center 0.5
      const cropAt2 = resolveSmartFrameCropAtTime(track, 2.0);
      assert.ok(cropAt2.x > 0.50, `During temporary occlusion at 2.0s, crop (${cropAt2.x}) coasts at person's position`);
      assert.notEqual(cropAt2.x, 0.3418, "Did not snap to default scene center");
    });

    // 7. Timestamps and frame indices are mapped correctly.
    it("Requirement 7: Timestamps and frame indices are mapped correctly", () => {
      const detections = [
        { time: 0.0, faces: [{ id: "p1", label: "person", box: { xMin: 0.1, yMin: 0.2, xMax: 0.2, yMax: 0.4 } }] },
        { time: 2.5, faces: [{ id: "p1", label: "person", box: { xMin: 0.3, yMin: 0.2, xMax: 0.4, yMax: 0.4 } }] },
        { time: 5.0, faces: [{ id: "p1", label: "person", box: { xMin: 0.5, yMin: 0.2, xMax: 0.6, yMax: 0.4 } }] },
      ];

      const track = buildDynamicReframingTrack({
        detections,
        duration: 5.0,
        sourceSize: SOURCE_1080P,
        targetRatio: "9:16",
      });

      assert.equal(track.cropKeyframes[0].time, 0, "First keyframe starts at t = 0");
      assert.equal(track.cropKeyframes.at(-1).time, 5.0, "Last keyframe ends at t = duration");
      for (let i = 1; i < track.cropKeyframes.length; i++) {
        assert.ok(track.cropKeyframes[i].time >= track.cropKeyframes[i - 1].time, "Keyframes are strictly monotonically non-decreasing");
      }
    });

    // 8. Preview, timeline, and export use consistent target coordinates.
    it("Requirement 8: Preview, timeline, and export use consistent target coordinates", () => {
      const track = buildDynamicReframingTrack({
        detections: [
          { time: 0, faces: [{ id: "p1", label: "person", box: { xMin: 0.70, yMin: 0.20, xMax: 0.80, yMax: 0.50 } }] },
          { time: 4, faces: [{ id: "p1", label: "person", box: { xMin: 0.70, yMin: 0.20, xMax: 0.80, yMax: 0.50 } }] },
        ],
        duration: 4,
        sourceSize: SOURCE_1080P,
        targetRatio: "9:16",
      });

      // Preview coordinate
      const previewCrop = resolveSmartFrameCropAtTime(track, 2.0);

      // FFmpeg export filter
      const ffmpegFilter = buildReframingFFmpegCropFilter(track, 1080, 1920);

      // Verify that the pan factor matches between preview and export
      const expectedPan = (previewCrop.x / (1 - previewCrop.width)).toFixed(4);
      assert.ok(ffmpegFilter.includes(expectedPan), `FFmpeg filter includes preview panFactor (${expectedPan})`);
    });

    // 9. A true no-person case uses an explicitly identified fallback.
    it("Requirement 9: A true no-person case uses an explicitly identified fallback", () => {
      const track = buildDynamicReframingTrack({
        detections: [],
        duration: 10,
        sourceSize: SOURCE_1080P,
        targetRatio: "9:16",
        manualCropX: 0.5,
      });

      assert.equal(track.isFallback, true, "isFallback is true");
      assert.equal(track.state, "fallback", "state is 'fallback'");
      assert.equal(track.confidence, 0, "confidence is 0");
      assert.equal(track.mode, "center", "mode is 'center'");
      assert.ok(track.cropKeyframes.every((kf) => kf.state === "fallback" || kf.confidence === 0), "All keyframes marked as fallback");
    });
  });
});

