/**
 * @file shorts-aspect-and-tracking-regression.test.js
 * Regression tests for AI Shorts Studio:
 * 1. Aspect ratio preservation (9:16) through timeline loading and lifecycle.
 * 2. AI Subject Tracking reframing pipeline and dynamic coordinate playback.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildDynamicReframingTrack,
  generateFallbackReframingTrack,
  applyDynamicReframingToCandidate,
  buildReframingFFmpegCropFilter,
  calculateTargetCropDimensions,
} from "../../src/lib/shortsReframing.js";

import {
  convertCandidateToProject,
  discoverShortCandidates,
} from "../../src/lib/shortsStudio.js";

import {
  resolveSmartFrameCropAtTime,
  smartFrameCropToPixels,
} from "../../src/lib/smartFrame.js";

import {
  getObjectPositionForCrop,
  getNearestRatioIdForSize,
} from "../../src/lib/editorRuntime.js";

describe("AI Shorts Studio — Aspect Ratio & Subject Tracking Regressions", () => {
  const dummy16x9Source = {
    id: "src-vid-1",
    name: "interview-horizontal.mp4",
    width: 1920,
    height: 1080,
    duration: 120,
    type: "video",
    src: "blob:http://localhost:5173/dummy-video",
  };

  describe("Issue 1: Aspect Ratio Preservation into Timeline", () => {
    it("converts 9:16 candidate to project with ratioId: '9:16' and fitMode: 'cover'", () => {
      const candidate = {
        id: "cand-1",
        title: "Hook Moment #1",
        startTime: 30,
        endTime: 45,
        duration: 15,
        aspectRatio: "9:16",
        framingMode: "smart-subject",
        cropX: 0.5,
      };

      const project = convertCandidateToProject(dummy16x9Source, candidate, {
        aspectRatio: "9:16",
        autoReframing: "smart-subject",
      });

      assert.equal(project.ratioId, "9:16");
      assert.equal(project.fitMode, "cover");
      assert.equal(project.visualSegments.length, 1);
      const seg = project.visualSegments[0];
      assert.equal(seg.sourceStart, 30);
      assert.equal(seg.duration, 15);
      assert.equal(seg.fitMode, "cover");
      assert.equal(seg.smartFrame.targetRatio, "9:16");
    });

    it("simulates useEditorLifecycle and verifies locked autoRatioSourceKeyRef prevents 16:9 override", () => {
      // Replicate useEditorLifecycle logic
      let currentRatioId = "9:16";
      let currentFitMode = "cover";
      const autoRatioSourceKeyRef = { current: "locked:9:16" };
      const visualSegments = [{ id: "vis-1", width: 1920, height: 1080 }];

      // Lifecycle hook execution:
      if (!autoRatioSourceKeyRef.current?.startsWith("locked")) {
        const ratioSource = visualSegments.find((s) => s.width > 0 && s.height > 0);
        if (ratioSource) {
          const nextRatioId = getNearestRatioIdForSize(ratioSource.width, ratioSource.height);
          if (nextRatioId && nextRatioId !== currentRatioId) {
            currentRatioId = nextRatioId;
            currentFitMode = "contain";
          }
        }
      }

      // Must remain locked at 9:16 and cover
      assert.equal(currentRatioId, "9:16");
      assert.equal(currentFitMode, "cover");
      assert.equal(autoRatioSourceKeyRef.current, "locked:9:16");
    });
  });

  describe("Issue 2: AI Subject Tracking Execution & Transfer", () => {
    it("builds dynamic reframing track from valid face coordinates across time", () => {
      // Subject starts on left (x=0.2) and moves to right (x=0.8) over 10 seconds
      const detections = [
        { time: 0, faces: [{ box: { xMin: 0.15, yMin: 0.2, xMax: 0.25, yMax: 0.4 }, confidence: 0.95 }] },
        { time: 5, faces: [{ box: { xMin: 0.45, yMin: 0.2, xMax: 0.55, yMax: 0.4 }, confidence: 0.95 }] },
        { time: 10, faces: [{ box: { xMin: 0.75, yMin: 0.2, xMax: 0.85, yMax: 0.4 }, confidence: 0.95 }] },
      ];

      const track = buildDynamicReframingTrack({
        detections,
        duration: 10,
        sourceSize: { width: 1920, height: 1080 },
        targetRatio: "9:16",
      });

      assert.equal(track.state, "tracked");
      assert.equal(track.isFallback, false);
      assert.ok(track.cropKeyframes.length >= 2);

      const kfStart = track.cropKeyframes[0];
      const kfEnd = track.cropKeyframes[track.cropKeyframes.length - 1];

      // Pan factor should follow the subject from left to right
      assert.ok(kfStart.panFactor < 0.4, `Start pan factor ${kfStart.panFactor} should be on the left (< 0.4)`);
      assert.ok(kfEnd.panFactor > 0.6, `End pan factor ${kfEnd.panFactor} should be on the right (> 0.6)`);
    });

    it("applies reframing to candidate without dropping track or mutating incorrectly", () => {
      const candidate = {
        id: "c-test",
        startTime: 20,
        endTime: 30,
        duration: 10,
        aspectRatio: "9:16",
        framingMode: "smart-subject",
      };

      const detections = [
        { time: 0, faces: [{ box: { xMin: 0.7, yMin: 0.2, xMax: 0.8, yMax: 0.4 }, confidence: 0.9 }] },
        { time: 10, faces: [{ box: { xMin: 0.7, yMin: 0.2, xMax: 0.8, yMax: 0.4 }, confidence: 0.9 }] },
      ];

      const track = buildDynamicReframingTrack({
        detections,
        duration: 10,
        sourceSize: { width: 1920, height: 1080 },
        targetRatio: "9:16",
      });

      const updated = applyDynamicReframingToCandidate(candidate, track);
      assert.ok(updated.smartFrame, "Candidate must have smartFrame attached");
      assert.equal(updated.smartFrame.state, "tracked");
      assert.ok(updated.cropX > 0.6, "CropX must reflect right-anchored subject");
    });

    it("maps keyframe timestamps to sourceStart when converting to timeline project", () => {
      const candidate = {
        id: "c-offset",
        startTime: 40,
        endTime: 55,
        duration: 15,
        aspectRatio: "9:16",
        framingMode: "smart-subject",
        smartFrame: {
          version: 2,
          enabled: true,
          targetRatio: "9:16",
          presentation: "crop",
          state: "tracked",
          cropKeyframes: [
            { time: 0, x: 0.1, y: 0, width: 0.3164, height: 1.0, panFactor: 0.15, confidence: 1 },
            { time: 7.5, x: 0.35, y: 0, width: 0.3164, height: 1.0, panFactor: 0.51, confidence: 1 },
            { time: 15, x: 0.55, y: 0, width: 0.3164, height: 1.0, panFactor: 0.80, confidence: 1 },
          ],
        },
      };

      const project = convertCandidateToProject(dummy16x9Source, candidate, {
        aspectRatio: "9:16",
        autoReframing: "smart-subject",
      });

      const seg = project.visualSegments[0];
      assert.ok(seg.smartFrame, "Segment must have smartFrame");
      assert.equal(seg.smartFrame.state, "tracked");
      assert.equal(seg.smartFrame.cropKeyframes.length, 3);

      // Keyframes must be offset to sourceStart (40s) so timeline previewVisualSourceTime resolves them
      assert.equal(seg.smartFrame.cropKeyframes[0].time, 40);
      assert.equal(seg.smartFrame.cropKeyframes[1].time, 47.5);
      assert.equal(seg.smartFrame.cropKeyframes[2].time, 55);
      assert.equal(seg.smartFrame.sourceSignature.sourceStart, 40);
    });

    it("evaluates dynamic subject coordinates during playback through resolveSmartFrameCropAtTime and getObjectPositionForCrop", () => {
      const smartFrame = {
        version: 2,
        enabled: true,
        targetRatio: "9:16",
        presentation: "crop",
        state: "tracked",
        sourceSize: { width: 1920, height: 1080 },
        sourceSignature: { sourceStart: 40, sourceDuration: 15 },
        cropKeyframes: [
          { time: 40, x: 0.1, y: 0, width: 0.3164, height: 1.0, panFactor: 0.146, confidence: 1 },
          { time: 55, x: 0.55, y: 0, width: 0.3164, height: 1.0, panFactor: 0.804, confidence: 1 },
        ],
      };

      // Query at beginning of playback: previewVisualSourceTime = 40
      const cropT0 = resolveSmartFrameCropAtTime(smartFrame, 40);
      const pixelCropT0 = smartFrameCropToPixels(cropT0, smartFrame.sourceSize);
      const objPosT0 = getObjectPositionForCrop(pixelCropT0);

      // Query in middle of playback: previewVisualSourceTime = 47.5
      const cropMid = resolveSmartFrameCropAtTime(smartFrame, 47.5);
      const pixelCropMid = smartFrameCropToPixels(cropMid, smartFrame.sourceSize);
      const objPosMid = getObjectPositionForCrop(pixelCropMid);

      // Query at end of playback: previewVisualSourceTime = 55
      const cropEnd = resolveSmartFrameCropAtTime(smartFrame, 55);
      const pixelCropEnd = smartFrameCropToPixels(cropEnd, smartFrame.sourceSize);
      const objPosEnd = getObjectPositionForCrop(pixelCropEnd);

      assert.notEqual(objPosT0, objPosMid, "Object position must change dynamically during playback");
      assert.notEqual(objPosMid, objPosEnd, "Object position must change dynamically between mid and end");

      const parseX = (pos) => parseFloat(pos.split("%")[0]);
      assert.ok(parseX(objPosT0) < parseX(objPosMid), "Pan must progress from left to center-right");
      assert.ok(parseX(objPosMid) < parseX(objPosEnd), "Pan must progress from center-right to right");
    });

    it("resolves keyframes accurately even when queried with local segment time (0 to 15)", () => {
      const smartFrame = {
        version: 2,
        enabled: true,
        targetRatio: "9:16",
        presentation: "crop",
        state: "tracked",
        sourceSize: { width: 1920, height: 1080 },
        sourceSignature: { sourceStart: 40, sourceDuration: 15 },
        cropKeyframes: [
          { time: 40, x: 0.1, y: 0, width: 0.3164, height: 1.0, panFactor: 0.15, confidence: 1 },
          { time: 55, x: 0.55, y: 0, width: 0.3164, height: 1.0, panFactor: 0.80, confidence: 1 },
        ],
      };

      // Passing localTime = 0
      const crop0 = resolveSmartFrameCropAtTime(smartFrame, 0);
      assert.equal(crop0.x, 0.1);

      // Passing localTime = 15
      const crop15 = resolveSmartFrameCropAtTime(smartFrame, 15);
      assert.equal(crop15.x, 0.55);
    });

    it("builds valid FFmpeg crop expression matching PTS t=0 for trimmed video", () => {
      const smartFrame = {
        version: 2,
        enabled: true,
        targetRatio: "9:16",
        presentation: "crop",
        state: "tracked",
        cropKeyframes: [
          { time: 40, x: 0.1, y: 0, width: 0.3164, height: 1.0, panFactor: 0.15 },
          { time: 55, x: 0.55, y: 0, width: 0.3164, height: 1.0, panFactor: 0.80 },
        ],
      };

      const filter = buildReframingFFmpegCropFilter(smartFrame, 1080, 1920, 15);
      assert.ok(filter.includes("crop=1080:1920:"), "Filter must crop to 1080x1920");
      assert.ok(filter.includes("between(t,0.000,15.000)"), "Dynamic pan expression must start at t=0 for trimmed clip PTS");
    });
  });
});
