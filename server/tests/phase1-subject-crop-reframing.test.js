/**
 * @file phase1-subject-crop-reframing.test.js
 * Comprehensive Phase 1 Verification Tests:
 * 1. Crop keyframes cannot be interpreted as face detections (sanitation & rejection).
 * 2. Two-person interview wide-group framing frames a real person, never empty center gap.
 * 3. Portrait crop boundaries, coordinate normalization, and source dimensions.
 * 4. Subject continuity and active-speaker transitions using explicit speaker signals.
 * 5. Consistent framing semantics across AI Shorts Studio, Smart Frame, and Smart Zoom.
 * 6. Preview (CSS panFactor) and export (FFmpeg crop filter) parity.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isGenuineFaceBox,
  isGenuineFaceDetection,
  extractGenuineFaceDetections,
  normalizeFaceBox,
  selectPrimaryFace,
  solveFrameCrop,
  calculateTargetCropDimensions,
  buildDynamicReframingTrack,
  buildReframingFFmpegCropFilter,
} from "../../src/lib/shortsReframing.js";

import {
  solveSmartFrameCrop,
  resolveSmartFrameCropAtTime,
  smartFrameCropToPixels,
} from "../../src/lib/smartFrame.js";

import {
  resolveFaceAwarePunchInOffset,
  detectSpeechPacedPunchIns,
} from "../../src/lib/shortsPunchIns.js";

import {
  getObjectPositionForCrop,
} from "../../src/lib/editorRuntime.js";

describe("Phase 1: Deterministic Crop Geometry, Detection Sanitation & Tracking", () => {
  const SOURCE_16X9 = { width: 1920, height: 1080 };
  const SOURCE_4K = { width: 3840, height: 2160 };

  // =========================================================================
  // Requirement 1: Crop keyframes cannot be interpreted as face detections
  // =========================================================================
  describe("Requirement 1: Crop Keyframe Detection Sanitation", () => {
    it("isGenuineFaceBox rejects full-height viewport crops and crop keyframes", () => {
      // Typical 9:16 crop keyframe generated inside 16:9 source
      const cropKeyframe = {
        x: 0.3418,
        y: 0,
        width: 0.3164,
        height: 1,
        time: 2.5,
      };

      assert.equal(isGenuineFaceBox(cropKeyframe), false, "Full-height crop keyframe must not be a face box");
      assert.equal(isGenuineFaceBox({ ...cropKeyframe, isCropKeyframe: true }), false);
      assert.equal(isGenuineFaceBox({ ...cropKeyframe, type: "cropKeyframe" }), false);
      assert.equal(isGenuineFaceBox({ ...cropKeyframe, height: 0.96 }), false, "Height >= 0.95 must be rejected");
      assert.equal(isGenuineFaceBox({ x: 0.2, y: 0, width: 0.35, height: 0.90 }), false, "Height >= 0.88 with width <= 0.55 must be rejected");
    });

    it("isGenuineFaceBox accepts real face and head bounding boxes", () => {
      const realFace = {
        xMin: 0.72,
        yMin: 0.18,
        xMax: 0.84,
        yMax: 0.38,
        confidence: 0.92,
      };
      assert.equal(isGenuineFaceBox(realFace), true, "Realistic face detection box should be accepted");

      const realFaceWH = {
        x: 0.20,
        y: 0.15,
        width: 0.12,
        height: 0.22,
        confidence: 0.88,
      };
      assert.equal(isGenuineFaceBox(realFaceWH), true, "Realistic width/height face box should be accepted");
    });

    it("extractGenuineFaceDetections strips crop keyframes while preserving genuine faces", () => {
      const mixedInputs = [
        // A crop keyframe erroneously placed in detections
        {
          time: 0,
          x: 0.3418,
          y: 0,
          width: 0.3164,
          height: 1,
        },
        // A sample with a cropKeyframe inside faces
        {
          time: 1.0,
          faces: [
            { x: 0.3418, y: 0, width: 0.3164, height: 1 },
          ],
        },
        // A valid face detection sample
        {
          time: 2.0,
          faces: [
            { id: "person-1", xMin: 0.75, yMin: 0.15, xMax: 0.85, yMax: 0.35, confidence: 0.95 },
          ],
        },
      ];

      const sanitized = extractGenuineFaceDetections(mixedInputs);
      assert.equal(sanitized.length, 1, "Only the sample with a genuine face should survive");
      assert.equal(sanitized[0].time, 2.0);
      assert.equal(sanitized[0].faces.length, 1);
      assert.equal(sanitized[0].faces[0].id, "person-1");
    });

    it("normalizeFaceBox returns null for crop keyframes to prevent downstream corruption", () => {
      const cropKeyframe = { x: 0.3418, y: 0, width: 0.3164, height: 1 };
      const normalized = normalizeFaceBox(cropKeyframe, SOURCE_16X9);
      assert.equal(normalized, null, "Normalizing a crop keyframe as a face must return null");
    });

    it("buildDynamicReframingTrack gracefully falls back to safe framing if only crop keyframes are provided", () => {
      const fakeCropKeyframesAsDetections = [
        { time: 0, x: 0.3418, y: 0, width: 0.3164, height: 1 },
        { time: 1.0, x: 0.3418, y: 0, width: 0.3164, height: 1 },
      ];

      const track = buildDynamicReframingTrack({
        sourceSize: SOURCE_16X9,
        targetAspectRatio: "9:16",
        detections: fakeCropKeyframesAsDetections,
        clipDuration: 10,
      });

      assert.equal(track.isFallback, true, "Must flag isFallback=true when no genuine faces exist");
      assert.equal(track.detectionCount, 0, "detectionCount must be 0, not treating crop keyframes as faces");
    });
  });

  // =========================================================================
  // Requirement 2: Two-person interview wide-group framing
  // =========================================================================
  describe("Requirement 2: Two-Person Interview Wide-Group Framing", () => {
    const twoPersonBoundingBox = {
      // In 16:9, Person A is at x=0.2, Person B is at x=0.8
      // A combined wide group bounding box spanning from 0.15 to 0.85 (width = 0.70)
      xMin: 0.15,
      yMin: 0.12,
      xMax: 0.85,
      yMax: 0.65,
      width: 0.70,
      height: 0.53,
      label: "person",
      confidence: 0.94,
    };

    const cropDims916 = calculateTargetCropDimensions(SOURCE_16X9, "9:16");
    // cropDims916.cropW ≈ 0.3164

    it("does NOT center a 9:16 crop on the empty space between two people", () => {
      const crop = solveFrameCrop(twoPersonBoundingBox, cropDims916, { sourceSize: SOURCE_16X9 });

      const cropLeft = crop.x;
      const cropRight = crop.x + crop.width;
      const cropCenter = crop.x + crop.width / 2;

      // The empty center between the two people is [0.40, 0.60] (dead center is 0.50)
      // The crop center MUST NOT be trapped in the dead center empty gap [0.45, 0.55]
      const isInEmptyDeadCenter = cropCenter >= 0.45 && cropCenter <= 0.55;
      assert.equal(isInEmptyDeadCenter, false, `Crop center (${cropCenter}) must NOT be in the empty gap [0.45, 0.55]`);

      // It must anchor on a real person: either Person A on the left (x ~ 0.15..0.35) or Person B on the right (x ~ 0.65..0.85)
      const framesPersonA = cropLeft <= 0.20 && cropRight >= 0.25;
      const framesPersonB = cropRight >= 0.80 && cropLeft <= 0.75;
      assert.ok(framesPersonA || framesPersonB, `Crop [${cropLeft}, ${cropRight}] must frame Person A or Person B`);
    });

    it("selects the prioritized or prominent speaker rather than centering the gap", () => {
      const candidates = [
        { id: "host", xMin: 0.12, yMin: 0.15, xMax: 0.26, yMax: 0.38, confidence: 0.95 },
        { id: "guest", xMin: 0.74, yMin: 0.15, xMax: 0.88, yMax: 0.38, confidence: 0.90 },
      ];

      // With guest specified as active speaker
      const selectedGuest = selectPrimaryFace(candidates, null, {
        activeSpeakerId: "guest",
        targetAspectRatio: "9:16",
        sourceSize: SOURCE_16X9,
      });
      assert.equal(selectedGuest.id, "guest", "Should select active speaker 'guest'");

      const guestCrop = solveFrameCrop(selectedGuest, cropDims916, { sourceSize: SOURCE_16X9 });
      assert.ok(guestCrop.x + guestCrop.width >= 0.80, "Guest crop must frame the right-side speaker");

      // With host specified as active speaker
      const selectedHost = selectPrimaryFace(candidates, null, {
        activeSpeakerId: "host",
        targetAspectRatio: "9:16",
        sourceSize: SOURCE_16X9,
      });
      assert.equal(selectedHost.id, "host", "Should select active speaker 'host'");

      const hostCrop = solveFrameCrop(selectedHost, cropDims916, { sourceSize: SOURCE_16X9 });
      assert.ok(hostCrop.x <= 0.15, "Host crop must frame the left-side speaker");
    });
  });

  // =========================================================================
  // Requirement 3: Portrait crop boundaries, normalized coords & source dims
  // =========================================================================
  describe("Requirement 3: Portrait Crop Boundaries, Coordinates and Dimensions", () => {
    it("strictly clamps crop within [0, 1] for all extreme subject positions", () => {
      const cropDims916 = calculateTargetCropDimensions(SOURCE_16X9, "9:16");

      const edgeCases = [
        { name: "Extreme Left", xMin: 0.001, yMin: 0.2, xMax: 0.05, yMax: 0.4 },
        { name: "Extreme Right", xMin: 0.95, yMin: 0.2, xMax: 0.999, yMax: 0.4 },
        { name: "Extreme Top", xMin: 0.45, yMin: 0.001, xMax: 0.55, yMax: 0.08 },
        { name: "Extreme Bottom", xMin: 0.45, yMin: 0.92, xMax: 0.55, yMax: 0.999 },
      ];

      for (const tc of edgeCases) {
        const crop = solveFrameCrop(tc, cropDims916, { sourceSize: SOURCE_16X9 });

        assert.ok(crop.x >= 0, `${tc.name}: crop.x (${crop.x}) must be >= 0`);
        assert.ok(crop.y >= 0, `${tc.name}: crop.y (${crop.y}) must be >= 0`);
        assert.ok(crop.x + crop.width <= 1.0001, `${tc.name}: crop.x + width (${crop.x + crop.width}) must be <= 1.0`);
        assert.ok(crop.y + crop.height <= 1.0001, `${tc.name}: crop.y + height (${crop.y + crop.height}) must be <= 1.0`);
      }
    });

    it("correctly converts normalized coordinates to exact pixel values for 1080p and 4K", () => {
      const normalizedCrop = { x: 0.25, y: 0.10, width: 0.3164, height: 0.80 };

      const pixels1080p = smartFrameCropToPixels(normalizedCrop, SOURCE_16X9);
      assert.equal(Math.round(pixels1080p.x), Math.round(0.25 * 1920));
      assert.equal(Math.round(pixels1080p.y), Math.round(0.10 * 1080));
      assert.equal(Math.round(pixels1080p.width), Math.round(0.3164 * 1920));
      assert.equal(Math.round(pixels1080p.height), Math.round(0.80 * 1080));

      const pixels4K = smartFrameCropToPixels(normalizedCrop, SOURCE_4K);
      assert.equal(Math.round(pixels4K.x), Math.round(0.25 * 3840));
      assert.equal(Math.round(pixels4K.y), Math.round(0.10 * 2160));
      assert.equal(Math.round(pixels4K.width), Math.round(0.3164 * 3840));
      assert.equal(Math.round(pixels4K.height), Math.round(0.80 * 2160));
    });
  });

  // =========================================================================
  // Requirement 4: Subject continuity & transitions with explicit signals
  // =========================================================================
  describe("Requirement 4: Subject Continuity & Active-Speaker Transitions", () => {
    it("smoothly transitions camera framing when active speaker turns change with explicit signals", () => {
      // Timeline: 0s to 6s.
      // 0s-2s: Speaker A (x=0.15) speaks.
      // 3s-6s: Speaker B (x=0.85) speaks.
      const multiPersonDetections = [
        {
          time: 0.0,
          faces: [
            { id: "speaker-a", xMin: 0.10, yMin: 0.20, xMax: 0.20, yMax: 0.45, mouthMotion: 0.9, isSpeaking: true },
            { id: "speaker-b", xMin: 0.80, yMin: 0.20, xMax: 0.90, yMax: 0.45, mouthMotion: 0.0, isSpeaking: false },
          ],
        },
        {
          time: 1.0,
          faces: [
            { id: "speaker-a", xMin: 0.10, yMin: 0.20, xMax: 0.20, yMax: 0.45, mouthMotion: 0.85, isSpeaking: true },
            { id: "speaker-b", xMin: 0.80, yMin: 0.20, xMax: 0.90, yMax: 0.45, mouthMotion: 0.0, isSpeaking: false },
          ],
        },
        {
          time: 2.0,
          faces: [
            { id: "speaker-a", xMin: 0.10, yMin: 0.20, xMax: 0.20, yMax: 0.45, mouthMotion: 0.8, isSpeaking: true },
            { id: "speaker-b", xMin: 0.80, yMin: 0.20, xMax: 0.90, yMax: 0.45, mouthMotion: 0.0, isSpeaking: false },
          ],
        },
        // Turn switch to Speaker B
        {
          time: 3.0,
          faces: [
            { id: "speaker-a", xMin: 0.10, yMin: 0.20, xMax: 0.20, yMax: 0.45, mouthMotion: 0.0, isSpeaking: false },
            { id: "speaker-b", xMin: 0.80, yMin: 0.20, xMax: 0.90, yMax: 0.45, mouthMotion: 0.95, isSpeaking: true },
          ],
        },
        {
          time: 4.0,
          faces: [
            { id: "speaker-a", xMin: 0.10, yMin: 0.20, xMax: 0.20, yMax: 0.45, mouthMotion: 0.0, isSpeaking: false },
            { id: "speaker-b", xMin: 0.80, yMin: 0.20, xMax: 0.90, yMax: 0.45, mouthMotion: 0.9, isSpeaking: true },
          ],
        },
        {
          time: 5.0,
          faces: [
            { id: "speaker-a", xMin: 0.10, yMin: 0.20, xMax: 0.20, yMax: 0.45, mouthMotion: 0.0, isSpeaking: false },
            { id: "speaker-b", xMin: 0.80, yMin: 0.20, xMax: 0.90, yMax: 0.45, mouthMotion: 0.85, isSpeaking: true },
          ],
        },
      ];

      const track = buildDynamicReframingTrack({
        sourceSize: SOURCE_16X9,
        targetAspectRatio: "9:16",
        detections: multiPersonDetections,
        clipDuration: 5.0,
        speechIntervals: [{ start: 0, end: 5.0 }],
      });

      // Query crop at time 0.5 (Speaker A active)
      const cropAtStart = resolveSmartFrameCropAtTime(track, 0.5);
      assert.ok(cropAtStart.x < 0.30, `At t=0.5, crop.x (${cropAtStart.x}) should frame Speaker A on the left`);

      // Query crop at time 4.5 (Speaker B active)
      const cropAtEnd = resolveSmartFrameCropAtTime(track, 4.5);
      assert.ok(cropAtEnd.x > 0.50, `At t=4.5, crop.x (${cropAtEnd.x}) should frame Speaker B on the right`);

      // Verify intermediate time 3.2 transitions smoothly without abrupt teleportation
      const cropMid = resolveSmartFrameCropAtTime(track, 3.2);
      assert.ok(
        cropMid.x >= cropAtStart.x && cropMid.x <= cropAtEnd.x,
        `Intermediate crop.x (${cropMid.x}) should transition smoothly between ${cropAtStart.x} and ${cropAtEnd.x}`,
      );
    });

    it("does NOT claim active speaker detection when no audio/speaker signals are provided", () => {
      const silentDetections = [
        {
          time: 0,
          faces: [
            { id: "person-1", xMin: 0.2, yMin: 0.2, xMax: 0.3, yMax: 0.4, confidence: 0.9 },
            { id: "person-2", xMin: 0.7, yMin: 0.2, xMax: 0.8, yMax: 0.4, confidence: 0.9 },
          ],
        },
      ];

      const track = buildDynamicReframingTrack({
        sourceSize: SOURCE_16X9,
        targetAspectRatio: "9:16",
        detections: silentDetections,
        clipDuration: 5.0,
      });

      // Metadata or track should not claim an active speaker was detected
      const speakerId = track.cropKeyframes[0].activeSpeakerId;
      assert.ok(!speakerId, "Must not invent an active speaker ID without signal");
    });
  });

  // =========================================================================
  // Requirement 5: Consistent framing semantics across Studio, Smart Frame, and Smart Zoom
  // =========================================================================
  describe("Requirement 5: Consistent Framing Semantics Across Modules", () => {
    it("produces consistent horizontal framing across AI Shorts Studio, Smart Frame, and Smart Zoom", () => {
      const rightSubject = {
        id: "subject-right",
        xMin: 0.75,
        yMin: 0.20,
        xMax: 0.85,
        yMax: 0.40,
        confidence: 0.95,
      };

      const detections = [
        {
          time: 0,
          faces: [rightSubject],
        },
        {
          time: 5.0,
          faces: [rightSubject],
        },
      ];

      // 1. AI Shorts Studio track
      const track = buildDynamicReframingTrack({
        sourceSize: SOURCE_16X9,
        targetAspectRatio: "9:16",
        detections,
        clipDuration: 10.0,
      });
      const studioCrop = resolveSmartFrameCropAtTime(track, 2.5);

      // 2. Smart Frame direct crop (sourceSize, targetSize, subjectBox)
      const smartFrameCrop = solveSmartFrameCrop(
        SOURCE_16X9,
        { width: 1080, height: 1920 },
        rightSubject,
      );

      // 3. Smart Zoom offset resolution
      const punchInOffset = resolveFaceAwarePunchInOffset({
        reframingTrack: track,
        time: 2.5,
        scale: 1.25,
        faceDetections: detections,
      });

      // Studio crop and Smart Frame crop must both center on the right side
      assert.ok(studioCrop.x > 0.5, `Studio crop (${studioCrop.x}) must frame right side`);
      assert.ok(smartFrameCrop.x > 0.5, `SmartFrame crop (${smartFrameCrop.x}) must frame right side`);
      assert.ok(
        Math.abs(studioCrop.x - smartFrameCrop.x) < 0.15,
        `Studio crop (${studioCrop.x}) and SmartFrame crop (${smartFrameCrop.x}) must be consistent within tolerance`,
      );

      // Smart Zoom must anchor on face
      assert.equal(punchInOffset.faceAnchored, true, "Smart zoom must report faceAnchored=true");
    });
  });

  // =========================================================================
  // Requirement 6: Preview (CSS panFactor) and Export (FFmpeg) Parity
  // =========================================================================
  describe("Requirement 6: Preview and Export Parity", () => {
    it("ensures preview getObjectPositionForCrop matches FFmpeg crop filter center", () => {
      const crop = {
        time: 0,
        x: 0.65,
        y: 0,
        width: 0.3164,
        height: 1.0,
        panFactor: 0.9508,
      };

      // CSS preview object position via smartFrameCropToPixels
      const rect = smartFrameCropToPixels(crop, SOURCE_16X9);
      const cssPos = getObjectPositionForCrop(rect);
      assert.ok(Math.abs(parseFloat(cssPos) - 95.08) < 0.2, `Preview CSS must reflect pan position (got ${cssPos})`);

      // FFmpeg crop filter from smartFrame track with keyframes
      const filter = buildReframingFFmpegCropFilter({ cropKeyframes: [crop] }, 1080, 1920);
      assert.ok(filter.includes("crop="), "FFmpeg filter must include crop=");
      assert.ok(filter.includes("in_w-out_w"), "FFmpeg filter must compute crop offset using (in_w-out_w)");
      assert.ok(filter.includes(crop.panFactor.toFixed(4)), `FFmpeg filter must use same panFactor (${crop.panFactor.toFixed(4)}) as CSS preview`);
    });
  });
});
