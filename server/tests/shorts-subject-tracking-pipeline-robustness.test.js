import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  calculateTargetCropDimensions,
  solveFrameCrop,
  buildDynamicReframingTrack,
  buildReframingFFmpegCropFilter,
  extractGenuineFaceDetections,
  isGenuineFaceDetection,
  hasAdequateCandidateDetections,
  needsTargetedSubjectAnalysis,
  isCandidateFallbackDueToMissingDetections,
  applyDynamicReframingToCandidate,
  generateFallbackReframingTrack,
  REFRAMING_ASPECT_RATIOS,
} from "../../src/lib/shortsReframing.js";

import {
  normalizeSmartFrame,
  resolveSmartFrameCropAtTime,
} from "../../src/lib/smartFrame.js";

import {
  convertCandidateToProject,
} from "../../src/lib/shortsStudio.js";

describe("Shorts Subject Tracking & Reframing Robustness Regression Suite", () => {
  const landscapeSize = { width: 1920, height: 1080 };
  const targetRatio = "9:16";

  // Scenario 1: One person at left, center, and right of the source frame
  it("reliably centers crop on one person at left, center, and right positions", () => {
    const positions = [
      { name: "left", cx: 0.18, expectedPanMax: 0.35 },
      { name: "center", cx: 0.50, expectedPanMin: 0.45, expectedPanMax: 0.55 },
      { name: "right", cx: 0.82, expectedPanMin: 0.65 },
    ];

    for (const pos of positions) {
      const detections = [
        { time: 0.0, box: { xMin: pos.cx - 0.08, yMin: 0.2, xMax: pos.cx + 0.08, yMax: 0.5, score: 0.95 } },
        { time: 1.0, box: { xMin: pos.cx - 0.08, yMin: 0.2, xMax: pos.cx + 0.08, yMax: 0.5, score: 0.95 } },
        { time: 2.0, box: { xMin: pos.cx - 0.08, yMin: 0.2, xMax: pos.cx + 0.08, yMax: 0.5, score: 0.95 } },
      ];

      const track = buildDynamicReframingTrack({
        detections,
        duration: 3.0,
        sourceSize: landscapeSize,
        targetRatio,
      });

      assert.strictEqual(track.isFallback, false);
      assert.strictEqual(track.state, "tracked");
      assert(track.cropKeyframes.length >= 2);

      const kf0 = track.cropKeyframes[0];
      const panFactor = kf0.panFactor;

      if (pos.expectedPanMin !== undefined) {
        assert(
          panFactor >= pos.expectedPanMin,
          `Position ${pos.name}: expected panFactor >= ${pos.expectedPanMin}, got ${panFactor}`
        );
      }
      if (pos.expectedPanMax !== undefined) {
        assert(
          panFactor <= pos.expectedPanMax,
          `Position ${pos.name}: expected panFactor <= ${pos.expectedPanMax}, got ${panFactor}`
        );
      }
    }
  });

  // Scenario 2: Two people with intended subject at different horizontal positions
  it("tracks intended subject in two-person framing without sweeping across empty space", () => {
    // Person A at left (cx = 0.25), Person B at right (cx = 0.75)
    const detectionsWithBoth = [
      {
        time: 0.0,
        box: { xMin: 0.17, yMin: 0.2, xMax: 0.33, yMax: 0.6, score: 0.95 },
        faces: [
          { xMin: 0.17, yMin: 0.2, xMax: 0.33, yMax: 0.6, score: 0.95, isSpeaking: true, activity: 0.8 },
          { xMin: 0.67, yMin: 0.2, xMax: 0.83, yMax: 0.6, score: 0.92, isSpeaking: false, activity: 0.1 },
        ],
      },
      {
        time: 1.0,
        box: { xMin: 0.17, yMin: 0.2, xMax: 0.33, yMax: 0.6, score: 0.95 },
        faces: [
          { xMin: 0.17, yMin: 0.2, xMax: 0.33, yMax: 0.6, score: 0.95, isSpeaking: true, activity: 0.8 },
          { xMin: 0.67, yMin: 0.2, xMax: 0.83, yMax: 0.6, score: 0.92, isSpeaking: false, activity: 0.1 },
        ],
      },
      {
        time: 2.0,
        box: { xMin: 0.17, yMin: 0.2, xMax: 0.33, yMax: 0.6, score: 0.95 },
        faces: [
          { xMin: 0.17, yMin: 0.2, xMax: 0.33, yMax: 0.6, score: 0.95, isSpeaking: true, activity: 0.8 },
          { xMin: 0.67, yMin: 0.2, xMax: 0.83, yMax: 0.6, score: 0.92, isSpeaking: false, activity: 0.1 },
        ],
      },
    ];

    const trackA = buildDynamicReframingTrack({
      detections: detectionsWithBoth,
      duration: 3.0,
      sourceSize: landscapeSize,
      targetRatio,
      speechIntervals: [{ start: 0, end: 3.0 }],
    });

    assert.strictEqual(trackA.isFallback, false);
    // Focus should be on Person A on the left (panFactor <= 0.35)
    assert(
      trackA.cropKeyframes[0].panFactor < 0.35,
      `Expected panFactor on Person A (< 0.35), got ${trackA.cropKeyframes[0].panFactor}`
    );
  });

  // Scenario 3: Empty initial detections followed by targeted analysis recovery
  it("detects when initial detections are inadequate and recovers via targeted analysis", () => {
    const candidate = {
      id: "cand-test-1",
      startTime: 100.0,
      endTime: 120.0,
      duration: 20.0,
      framingMode: "smart-subject",
      aspectRatio: "9:16",
      smartFrame: generateFallbackReframingTrack(landscapeSize, "9:16", 20.0, 0.5),
    };

    // Initial check: candidate has only fallback smartFrame with 0 detections
    assert.strictEqual(isCandidateFallbackDueToMissingDetections(candidate), true);
    assert.strictEqual(needsTargetedSubjectAnalysis(candidate, []), true);

    // Simulate coarse discovery pass with wide 14-second interval gap (only 1 sample at t=112)
    const sparseDetections = [
      { time: 112.0, box: { xMin: 0.2, yMin: 0.2, xMax: 0.4, yMax: 0.6, score: 0.9 } },
    ];
    // Sparse detections do NOT have start coverage (start is 100, first detection at 112 > 100 + 2.5)
    assert.strictEqual(hasAdequateCandidateDetections(candidate, sparseDetections), false);
    assert.strictEqual(needsTargetedSubjectAnalysis(candidate, sparseDetections), true);

    // Simulate targeted recovery pass with 1.0s interval detections from start to end
    const targetedDetections = [];
    for (let t = 100.5; t < 120.0; t += 1.0) {
      targetedDetections.push({
        time: t,
        box: { xMin: 0.25, yMin: 0.2, xMax: 0.45, yMax: 0.6, score: 0.94 },
      });
    }

    assert.strictEqual(hasAdequateCandidateDetections(candidate, targetedDetections), true);
    assert.strictEqual(needsTargetedSubjectAnalysis(candidate, targetedDetections), false);

    // Rebuild track with recovered detections
    const recoveredTrack = buildDynamicReframingTrack({
      detections: targetedDetections.map((d) => ({ ...d, time: d.time - candidate.startTime })),
      duration: candidate.duration,
      sourceSize: landscapeSize,
      targetRatio: "9:16",
    });

    assert.strictEqual(recoveredTrack.isFallback, false);
    assert.strictEqual(recoveredTrack.state, "tracked");
    assert(recoveredTrack.cropKeyframes.length >= 2);

    const updatedCandidate = applyDynamicReframingToCandidate(candidate, recoveredTrack);
    assert.strictEqual(isCandidateFallbackDueToMissingDetections(updatedCandidate), false);
  });

  // Scenario 4: Missing or temporarily lost detections handled smoothly
  it("maintains tracking continuity during temporary detection loss without falling back to center", () => {
    // Detections present from 0 to 3s, lost from 3 to 6s, present from 6 to 9s at subject cx = 0.25
    const intermittentDetections = [
      { time: 0.0, box: { xMin: 0.17, yMin: 0.2, xMax: 0.33, yMax: 0.6, score: 0.92 } },
      { time: 1.0, box: { xMin: 0.17, yMin: 0.2, xMax: 0.33, yMax: 0.6, score: 0.92 } },
      { time: 2.0, box: { xMin: 0.17, yMin: 0.2, xMax: 0.33, yMax: 0.6, score: 0.92 } },
      // gap: 3.0 to 6.0 has no detections
      { time: 6.0, box: { xMin: 0.17, yMin: 0.2, xMax: 0.33, yMax: 0.6, score: 0.92 } },
      { time: 7.0, box: { xMin: 0.17, yMin: 0.2, xMax: 0.33, yMax: 0.6, score: 0.92 } },
      { time: 8.0, box: { xMin: 0.17, yMin: 0.2, xMax: 0.33, yMax: 0.6, score: 0.92 } },
    ];

    const track = buildDynamicReframingTrack({
      detections: intermittentDetections,
      duration: 9.0,
      sourceSize: landscapeSize,
      targetRatio,
    });

    assert.strictEqual(track.isFallback, false);

    // During the gap (t = 4.5s), resolving the crop should stay centered on the subject's left position (< 0.40)
    const midCrop = resolveSmartFrameCropAtTime(track, 4.5);
    assert(midCrop !== null);
    const midPan = Number.isFinite(midCrop.panFactor)
      ? midCrop.panFactor
      : (midCrop.x / (1 - midCrop.width));

    assert(
      midPan < 0.40,
      `During detection gap, expected panFactor to remain near subject (< 0.40), got ${midPan}`
    );
  });

  // Scenario 5: Successful regeneration and transfer of crop keyframes to timeline project
  it("transfers recovered tracking data and keyframes into timeline project without regression", () => {
    const candidate = {
      id: "cand-transfer-test",
      startTime: 200.0,
      endTime: 215.0,
      duration: 15.0,
      framingMode: "smart-subject",
      aspectRatio: "9:16",
      cropX: 0.5, // initial default
    };

    const sourceClip = {
      id: "clip-src-1",
      width: 1920,
      height: 1080,
      duration: 400.0,
      src: "blob:http://localhost:5173/test",
    };

    // Recovered detections at cx = 0.30
    const sourceFaceDetections = [];
    for (let t = 200.0; t <= 215.0; t += 1.0) {
      sourceFaceDetections.push({
        time: t,
        box: { xMin: 0.22, yMin: 0.2, xMax: 0.38, yMax: 0.6, score: 0.95 },
      });
    }

    const project = convertCandidateToProject(sourceClip, candidate, {
      aspectRatio: "9:16",
      autoReframing: "smart-subject",
      faceDetections: sourceFaceDetections,
    });

    assert(project !== null);
    assert(Array.isArray(project.visualSegments));
    assert.strictEqual(project.visualSegments.length, 1);

    const segment = project.visualSegments[0];
    assert.strictEqual(segment.sourceStart, 200.0);
    assert.strictEqual(segment.duration, 15.0);

    // The segment's initial cropX must be derived from keyframe 0, NOT stuck at 0.5 center fallback!
    assert(
      segment.cropX < 0.40,
      `Expected segment cropX to follow subject (< 0.40), got ${segment.cropX}`
    );
    assert.strictEqual(segment.objectPosition, `${(segment.cropX * 100).toFixed(1)}% 50%`);

    // The segment smartFrame must be tracked and valid
    const sf = segment.smartFrame;
    assert(sf !== null);
    assert.strictEqual(sf.isFallback, false);
    assert.strictEqual(sf.state, "tracked");
    assert(sf.cropKeyframes.length >= 2);

    // Keyframes must have source timestamps properly mapped (start at 200.0)
    assert(sf.cropKeyframes[0].time >= 199.9 && sf.cropKeyframes[0].time <= 200.1);
    assert.strictEqual(sf.cropKeyframes[0].isFallback, false);
    assert.strictEqual(sf.cropKeyframes[0].state, "tracked");
  });

  // Scenario 6: Consistent source-time and clip-relative-time handling
  it("keeps crop geometry identical between candidate relative preview and timeline source time", () => {
    const candidateStart = 50.0;
    const candidateDuration = 10.0;
    const cx = 0.28;

    const candDetections = [
      { time: 0.0, box: { xMin: cx - 0.08, yMin: 0.2, xMax: cx + 0.08, yMax: 0.5, score: 0.95 } },
      { time: 5.0, box: { xMin: cx - 0.08, yMin: 0.2, xMax: cx + 0.08, yMax: 0.5, score: 0.95 } },
      { time: 10.0, box: { xMin: cx - 0.08, yMin: 0.2, xMax: cx + 0.08, yMax: 0.5, score: 0.95 } },
    ];

    const candTrack = buildDynamicReframingTrack({
      detections: candDetections,
      duration: candidateDuration,
      sourceSize: landscapeSize,
      targetRatio,
    });

    // In AI Shorts Studio, preview runs at relative time 2.5s
    const candCrop = resolveSmartFrameCropAtTime(candTrack, 2.5);

    // Convert candidate to timeline project
    const candidate = {
      id: "cand-time-test",
      startTime: candidateStart,
      endTime: candidateStart + candidateDuration,
      duration: candidateDuration,
      framingMode: "smart-subject",
      aspectRatio: "9:16",
      smartFrame: candTrack,
    };

    const project = convertCandidateToProject({ id: "src-1", width: 1920, height: 1080 }, candidate, {
      aspectRatio: "9:16",
      autoReframing: "smart-subject",
    });

    const timelineTrack = project.visualSegments[0].smartFrame;
    // In Timeline Studio, preview runs at timeline source time 52.5s (50.0 + 2.5)
    const timelineCrop = resolveSmartFrameCropAtTime(timelineTrack, candidateStart + 2.5);

    assert(candCrop !== null && timelineCrop !== null);
    assert(
      Math.abs(candCrop.x - timelineCrop.x) < 0.001,
      `Expected crop X to match: cand ${candCrop.x} vs timeline ${timelineCrop.x}`
    );
    assert(
      Math.abs(candCrop.width - timelineCrop.width) < 0.001,
      `Expected crop width to match: cand ${candCrop.width} vs timeline ${timelineCrop.width}`
    );
    assert(
      Math.abs(candCrop.panFactor - timelineCrop.panFactor) < 0.001,
      `Expected panFactor to match: cand ${candCrop.panFactor} vs timeline ${timelineCrop.panFactor}`
    );
  });

  // Scenario 7: Valid tracking data avoids redundant re-analysis
  it("avoids redundant re-analysis when dense valid detections already exist", () => {
    const candidate = {
      id: "cand-dense-test",
      startTime: 0.0,
      endTime: 10.0,
      duration: 10.0,
      framingMode: "smart-subject",
      aspectRatio: "9:16",
    };

    const denseDetections = [];
    for (let t = 0.5; t < 10.0; t += 1.0) {
      denseDetections.push({
        time: t,
        box: { xMin: 0.4, yMin: 0.2, xMax: 0.6, yMax: 0.6, score: 0.95 },
      });
    }

    assert.strictEqual(hasAdequateCandidateDetections(candidate, denseDetections), true);
    assert.strictEqual(needsTargetedSubjectAnalysis(candidate, denseDetections), false);
  });

  // Scenario 8: Fallback status detection and UI badge correctness
  it("correctly identifies fallback state so UI never displays false subject-aware crop", () => {
    const fallbackCandidate = {
      id: "cand-fallback-test",
      startTime: 10.0,
      endTime: 25.0,
      duration: 15.0,
      framingMode: "smart-subject",
      cropX: 0.5,
      smartFrame: {
        isFallback: true,
        state: "fallback",
        cropKeyframes: [
          { time: 0, x: 0.2188, y: 0, width: 0.5625, height: 1, confidence: 0, isFallback: true },
          { time: 15, x: 0.2188, y: 0, width: 0.5625, height: 1, confidence: 0, isFallback: true },
        ],
      },
    };

    assert.strictEqual(isCandidateFallbackDueToMissingDetections(fallbackCandidate), true);

    // In App.jsx: smartCropActive logic
    const previewSmartCropRect = fallbackCandidate.smartFrame.cropKeyframes[0];
    const smartCropActive = Boolean(
      previewSmartCropRect &&
      !previewSmartCropRect.isFallback &&
      previewSmartCropRect.state !== "fallback" &&
      (previewSmartCropRect.confidence ?? 1) > 0
    );

    assert.strictEqual(
      smartCropActive,
      false,
      "Fallback keyframe must not activate smartCropActive badge in UI"
    );
  });

  // Scenario 9: Preview and export use consistent reframing data and crop filter
  it("generates consistent FFmpeg crop filter matching dynamic smartFrame keyframes", () => {
    const keyframes = [
      { time: 0.0, x: 0.1, y: 0, width: 0.5625, height: 1, panFactor: 0.2286 },
      { time: 5.0, x: 0.1, y: 0, width: 0.5625, height: 1, panFactor: 0.2286 },
      { time: 5.05, x: 0.3, y: 0, width: 0.5625, height: 1, panFactor: 0.6857, cut: true },
      { time: 10.0, x: 0.3, y: 0, width: 0.5625, height: 1, panFactor: 0.6857 },
    ];

    const smartFrame = {
      version: 2,
      enabled: true,
      targetRatio: "9:16",
      cropKeyframes: keyframes,
    };

    const filter = buildReframingFFmpegCropFilter(smartFrame, 1080, 1920, 10.0);
    assert(filter.startsWith("crop=1080:1920:"));
    // Verify that cut expression does not sweep linearly across empty space
    assert(filter.includes("between(t,5.050,10.000)"));
  });

  // Scenario 10: Manual framing preserved and not overwritten
  it("preserves manual framing mode and explicit crop positions", () => {
    const candidate = {
      id: "cand-manual-test",
      startTime: 0.0,
      endTime: 10.0,
      duration: 10.0,
      framingMode: "center", // Intentional manual center crop
      cropX: 0.5,
    };

    // When framingMode is 'center', needsTargetedSubjectAnalysis must be false
    assert.strictEqual(needsTargetedSubjectAnalysis(candidate, []), false);
    assert.strictEqual(isCandidateFallbackDueToMissingDetections(candidate), false);
  });
});
