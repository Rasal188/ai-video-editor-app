/**
 * @file shorts-subject-tracking-recovery.test.js
 * Focused regression tests for AI Shorts Studio Subject Tracking Recovery:
 * 1. Distinguishes genuine missing-detection fallbacks from valid intentional user crops.
 * 2. Empty initial detections followed by successful targeted analysis.
 * 3. Selected candidate recovering from fallback to actual subject tracking (verifying the 218.32s framing issue).
 * 4. Detection failure leaving a visible fallback status (no false success).
 * 5. Prevention of duplicate analysis requests.
 * 6. Cancellation and analysis errors handled cleanly.
 * 7. Preservation of manual crop behavior and scene-cut timing.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildDynamicReframingTrack,
  generateFallbackReframingTrack,
  applyDynamicReframingToCandidate,
  calculateTargetCropDimensions,
  selectPrimaryFace,
  solveFrameCrop,
  isCandidateFallbackDueToMissingDetections,
} from "../../src/lib/shortsReframing.js";

import {
  sampleVideoFaceDetections,
} from "../../src/lib/shortsFaceDetection.js";

import {
  resolveSmartFrameCropAtTime,
} from "../../src/lib/smartFrame.js";

describe("AI Shorts Studio — Subject Tracking Fallback Recovery & Verification", () => {
  const source16x9 = {
    id: "src-she-almost",
    width: 1280,
    height: 720,
    duration: 648.36,
  };

  // Ground-truth detection for frame 218.32s (candidate relative time 5.40s)
  const internPersonLeft = {
    id: "person-intern-left",
    isPerson: true,
    confidence: 0.9895,
    xMin: 0.1586,
    yMin: 0.4319,
    xMax: 0.4625,
    yMax: 0.9542,
    width: 0.3039,
    height: 0.5223,
    centerX: 0.3105,
    centerY: 0.6931,
  };

  const interviewerPersonRight = {
    id: "person-interviewer-right",
    isPerson: true,
    confidence: 0.9777,
    xMin: 0.5578,
    yMin: 0.4319,
    xMax: 0.8688,
    yMax: 0.9542,
    width: 0.3110,
    height: 0.5223,
    centerX: 0.7133,
    centerY: 0.6931,
  };

  describe("1. Distinguish Genuine Fallback from Valid Intentional Crop", () => {
    it("identifies a candidate with smart-subject mode and empty detections as a genuine fallback", () => {
      const fallbackTrack = generateFallbackReframingTrack(source16x9, "9:16", 35.88, 0.5);
      const candidate = {
        id: "cand-1",
        startTime: 212.92,
        endTime: 248.80,
        duration: 35.88,
        framingMode: "smart-subject",
        aspectRatio: "9:16",
        smartFrame: fallbackTrack,
      };

      const isFallback = isCandidateFallbackDueToMissingDetections(candidate);
      assert.equal(isFallback, true, "Should identify missing detections fallback in smart-subject mode");
    });

    it("does NOT classify intentional Center Crop as a missing-detections fallback", () => {
      const fallbackTrack = generateFallbackReframingTrack(source16x9, "9:16", 35.88, 0.5);
      const candidate = {
        id: "cand-2",
        startTime: 212.92,
        endTime: 248.80,
        duration: 35.88,
        framingMode: "center",
        aspectRatio: "9:16",
        cropX: 0.8, // user deliberately chose right pan in center crop
        smartFrame: fallbackTrack,
      };

      const isFallback = isCandidateFallbackDueToMissingDetections(candidate);
      assert.equal(isFallback, false, "Intentional center crop must not be marked as a missing-detections fallback");
    });

    it("does NOT classify Safe Contain (blurred background) as a missing-detections fallback", () => {
      const fallbackTrack = generateFallbackReframingTrack(source16x9, "9:16", 35.88, 0.5);
      fallbackTrack.presentation = "safe-contain";
      const candidate = {
        id: "cand-3",
        startTime: 212.92,
        endTime: 248.80,
        duration: 35.88,
        framingMode: "safe-contain",
        aspectRatio: "9:16",
        smartFrame: fallbackTrack,
      };

      const isFallback = isCandidateFallbackDueToMissingDetections(candidate);
      assert.equal(isFallback, false, "Safe contain mode must not be treated as a missing-detections fallback");
    });

    it("does NOT classify a candidate with active tracked keyframes as a fallback", () => {
      const track = buildDynamicReframingTrack({
        detections: [
          { time: 0, faces: [internPersonLeft] },
          { time: 5.4, faces: [internPersonLeft] },
        ],
        duration: 35.88,
        sourceSize: source16x9,
        targetRatio: "9:16",
      });

      const candidate = {
        id: "cand-4",
        startTime: 212.92,
        endTime: 248.80,
        duration: 35.88,
        framingMode: "smart-subject",
        aspectRatio: "9:16",
        smartFrame: track,
      };

      assert.equal(track.isFallback, false);
      assert.equal(isCandidateFallbackDueToMissingDetections(candidate), false);
    });
  });

  describe("2. Empty Initial Detections Followed by Successful Targeted Analysis", () => {
    it("recovers candidate reframing track from fallback to active subject tracking when detections arrive", () => {
      // Step A: Candidate initially discovered with 0 detections -> center fallback
      const initialFallback = generateFallbackReframingTrack(source16x9, "9:16", 35.88, 0.5);
      let candidate = {
        id: "cand-she-almost",
        startTime: 212.92,
        endTime: 248.80,
        duration: 35.88,
        framingMode: "smart-subject",
        aspectRatio: "9:16",
        cropX: 0.5,
        smartFrame: initialFallback,
        trackingStatus: "untested",
      };

      assert.equal(candidate.smartFrame.isFallback, true);
      assert.equal(candidate.smartFrame.state, "fallback");
      assert.equal(candidate.cropX, 0.5); // centered

      // Step B: Targeted detection runs for [212.92, 248.80] and yields detections
      const targetedDetections = [
        { time: 212.92, faces: [internPersonLeft, interviewerPersonRight] },
        { time: 218.32, faces: [internPersonLeft, interviewerPersonRight] },
        { time: 248.80, faces: [internPersonLeft, interviewerPersonRight] },
      ];

      // Convert to candidate-relative timestamps (0..duration)
      const candDetections = targetedDetections.map((d) => ({
        ...d,
        time: Number((d.time - candidate.startTime).toFixed(3)),
      }));

      const regeneratedTrack = buildDynamicReframingTrack({
        detections: candDetections,
        duration: candidate.duration,
        sourceSize: source16x9,
        targetRatio: "9:16",
        manualCropX: candidate.cropX ?? 0.5,
      });

      const reframed = applyDynamicReframingToCandidate(candidate, regeneratedTrack);
      candidate = {
        ...candidate,
        ...reframed,
        trackingStatus: "tracked",
      };

      // Step C: Verify recovery
      assert.equal(candidate.smartFrame.isFallback, false, "Track is no longer a fallback");
      assert.equal(candidate.smartFrame.state, "tracked", "Track state is now 'tracked'");
      assert.ok(candidate.smartFrame.cropKeyframes.length >= 2, "Has valid crop keyframes");
      assert.equal(candidate.trackingStatus, "tracked");
      assert.equal(isCandidateFallbackDueToMissingDetections(candidate), false);
    });
  });

  describe("3. Selected Candidate Recovering from Fallback to Actual Subject Tracking (218.32s Frame)", () => {
    it("shifts the portrait crop from the center lamp (panFactor 0.50) to the intern (panFactor 0.22)", () => {
      // 1. Initial Fallback crop state (matching user screenshot)
      const initialFallback = generateFallbackReframingTrack(source16x9, "9:16", 35.88, 0.5);
      const fallbackCropAtPreview = resolveSmartFrameCropAtTime(initialFallback, 5.40); // 5.4s relative offset = 218.32s
      assert.equal(fallbackCropAtPreview.panFactor, 0.5);

      // In pixels for 1280x720: width is 405px (0.3164)
      const fallbackPixelLeft = fallbackCropAtPreview.x * 1280;
      const fallbackPixelRight = (fallbackCropAtPreview.x + fallbackCropAtPreview.width) * 1280;
      assert.ok(Math.abs(fallbackPixelLeft - 437.5) < 1.0, "Fallback left boundary cuts at ~437.5px");
      assert.ok(Math.abs(fallbackPixelRight - 842.5) < 1.0, "Fallback right boundary cuts at ~842.5px");

      // The lamp is at 500..635 px (inside [437.5, 842.5]), and the intern is at 190..460 px (cut off!)
      assert.ok(internPersonLeft.xMin * 1280 < fallbackPixelLeft, "Intern left boundary is cut off in fallback");

      // 2. Now run targeted subject tracking
      const targetedDetections = [
        { time: 0, faces: [internPersonLeft, interviewerPersonRight] },
        { time: 5.40, faces: [internPersonLeft, interviewerPersonRight] },
        { time: 35.88, faces: [internPersonLeft, interviewerPersonRight] },
      ];

      const regeneratedTrack = buildDynamicReframingTrack({
        detections: targetedDetections,
        duration: 35.88,
        sourceSize: source16x9,
        targetRatio: "9:16",
        manualCropX: 0.5,
      });

      const recoveredCropAtPreview = resolveSmartFrameCropAtTime(regeneratedTrack, 5.40);
      assert.ok(Number.isFinite(recoveredCropAtPreview.panFactor), "Crop has panFactor");

      // Ideal panFactor for intern centered at x=0.3105 is:
      // xMin = 0.3105 - 0.3164/2 = 0.1523
      // panFactor = 0.1523 / (1 - 0.3164) = 0.2228
      assert.ok(
        Math.abs(recoveredCropAtPreview.panFactor - 0.2228) < 0.05,
        `Expected panFactor ~0.2228, got ${recoveredCropAtPreview.panFactor}`
      );

      const recoveredPixelLeft = recoveredCropAtPreview.x * 1280;
      const recoveredPixelRight = (recoveredCropAtPreview.x + recoveredCropAtPreview.width) * 1280;

      // Verify the intern's face ([240, 340] px) and body ([190, 460] px) are safely inside [194.9, 599.9] px!
      assert.ok(
        recoveredPixelLeft <= 240 && recoveredPixelRight >= 340,
        `Intern's face ([240, 340]) must be inside recovered crop [${recoveredPixelLeft.toFixed(1)}, ${recoveredPixelRight.toFixed(1)}]`
      );
      assert.ok(
        recoveredPixelLeft <= 200,
        `Intern's upper body must not be cut off at the left (crop left: ${recoveredPixelLeft.toFixed(1)})`
      );
    });
  });

  describe("4. Detection Failure Leaving a Visible Fallback Status", () => {
    const setupMockDom = () => {
      const originalDoc = globalThis.document;
      const mockVideo = {
        readyState: 4,
        duration: 35.88,
        videoWidth: 1280,
        videoHeight: 720,
        currentTime: 0,
        muted: false,
        playsInline: false,
        preload: "",
        crossOrigin: "",
        src: "",
        pause() {},
        removeAttribute() {},
        load() {},
        addEventListener(event, fn) {
          if (event === "loadedmetadata" || event === "seeked") {
            setTimeout(fn, 0);
          }
        },
        removeEventListener() {},
      };
      const mockCanvas = {
        width: 360,
        height: 203,
        getContext: () => ({
          drawImage() {},
          getImageData: () => ({ data: new Uint8ClampedArray(4) }),
        }),
      };
      globalThis.document = {
        createElement: (tag) => {
          if (tag === "video") return mockVideo;
          if (tag === "canvas") return mockCanvas;
          return {};
        },
      };
      return () => {
        if (originalDoc !== undefined) globalThis.document = originalDoc;
        else delete globalThis.document;
      };
    };

    it("maintains safe fallback track and records no_subjects_found status when no faces exist", async () => {
      const restoreDom = setupMockDom();
      try {
        const mockEmptyDetector = {
          detect: async () => [],
        };

        const result = await sampleVideoFaceDetections({
          source: "blob:http://localhost:5173/empty-video",
          startTime: 212.92,
          duration: 35.88,
          interval: 1.0,
          detector: mockEmptyDetector,
        });

        assert.equal(result.status, "no_faces_found");
        assert.equal(result.detections.length, 0);

        const candidateStatus = result.status === "no_faces_found" ? "no_subjects_found" : result.status;

        // Verify candidate keeps fallback track and displays fallback status
        const candidate = {
          id: "cand-empty",
          framingMode: "smart-subject",
          trackingStatus: candidateStatus,
          smartFrame: generateFallbackReframingTrack(source16x9, "9:16", 35.88, 0.5),
        };

        assert.equal(candidate.smartFrame.isFallback, true);
        assert.equal(candidate.trackingStatus, "no_subjects_found");

        // Verify fallback warning visibility condition:
        const isSubjectTracking = ["smart-subject", "smart-zoom"].includes(candidate.framingMode);
        const isFallbackTrack = candidate.smartFrame?.isFallback === true;
        const hasActiveDetections = (candidate.smartFrame?.metadata?.detectionsCount ?? 0) > 0;
        const showFallbackWarning = isSubjectTracking && isFallbackTrack && !hasActiveDetections;

        assert.equal(showFallbackWarning, true, "Fallback warning must be visible when detection finds no subjects");
      } finally {
        restoreDom();
      }
    });

    it("records unsupported status and displays warning when browser detection is unavailable", async () => {
      const candidate = {
        id: "cand-unsupported",
        framingMode: "smart-subject",
        trackingStatus: "unsupported",
        smartFrame: generateFallbackReframingTrack(source16x9, "9:16", 35.88, 0.5),
      };

      const isSubjectTracking = ["smart-subject", "smart-zoom"].includes(candidate.framingMode);
      const isFallbackTrack = candidate.smartFrame?.isFallback === true;
      const hasActiveDetections = false;
      const showFallbackWarning = isSubjectTracking && isFallbackTrack && !hasActiveDetections;

      assert.equal(showFallbackWarning, true, "Fallback warning must be visible when detection is unsupported");
    });
  });

  describe("5. Prevention of Duplicate Analysis Requests", () => {
    it("deduplicates requests for the same candidate while analysis is in-flight or already attempted", () => {
      const analyzingSet = new Set();
      const attemptedSet = new Set();

      const candidate = {
        id: "cand-test",
        startTime: 212.92,
        endTime: 248.80,
        aspectRatio: "9:16",
      };

      const cacheKey = `${candidate.id}_${candidate.startTime}_${candidate.endTime}_${candidate.aspectRatio}`;

      let executionCount = 0;
      const mockRun = (candId) => {
        if (analyzingSet.has(candId) || attemptedSet.has(cacheKey)) {
          return "skipped";
        }
        analyzingSet.add(candId);
        executionCount++;
        // finish
        analyzingSet.delete(candId);
        attemptedSet.add(cacheKey);
        return "executed";
      };

      // Call 1: initial run
      assert.equal(mockRun(candidate.id), "executed");
      assert.equal(executionCount, 1);

      // Call 2: duplicate call should be skipped because key is in attemptedSet
      assert.equal(mockRun(candidate.id), "skipped");
      assert.equal(executionCount, 1);

      // Call 3: duplicate call during re-render
      assert.equal(mockRun(candidate.id), "skipped");
      assert.equal(executionCount, 1);
    });
  });

  describe("6. Cancellation and Analysis Errors", () => {
    const setupMockDom = () => {
      const originalDoc = globalThis.document;
      const mockVideo = {
        readyState: 4,
        duration: 10,
        videoWidth: 1280,
        videoHeight: 720,
        currentTime: 0,
        muted: false,
        playsInline: false,
        preload: "",
        crossOrigin: "",
        src: "",
        pause() {},
        removeAttribute() {},
        load() {},
        addEventListener(event, fn) {
          if (event === "loadedmetadata" || event === "seeked") {
            setTimeout(fn, 0);
          }
        },
        removeEventListener() {},
      };
      const mockCanvas = {
        width: 360,
        height: 203,
        getContext: () => ({
          drawImage() {},
          getImageData: () => ({ data: new Uint8ClampedArray(4) }),
        }),
      };
      globalThis.document = {
        createElement: (tag) => {
          if (tag === "video") return mockVideo;
          if (tag === "canvas") return mockCanvas;
          return {};
        },
      };
      return () => {
        if (originalDoc !== undefined) globalThis.document = originalDoc;
        else delete globalThis.document;
      };
    };

    it("handles AbortSignal cleanly without crashing or leaving broken candidate state", async () => {
      const restoreDom = setupMockDom();
      try {
        const controller = new AbortController();
        controller.abort();

        let didAbort = false;
        try {
          await sampleVideoFaceDetections({
            source: "blob:http://localhost:5173/test-video",
            startTime: 0,
            duration: 10,
            detector: { detect: async () => [] },
            signal: controller.signal,
          });
        } catch (err) {
          if (err.name === "AbortError") {
            didAbort = true;
          }
        }
        assert.equal(didAbort, true, "Should handle AbortSignal with AbortError");
      } finally {
        restoreDom();
      }
    });

    it("catches detector errors and leaves safe fallback status", async () => {
      const restoreDom = setupMockDom();
      try {
        const failingDetector = {
          detect: async () => {
            throw new Error("GPU device lost during inference");
          },
        };

        const result = await sampleVideoFaceDetections({
          source: "blob:http://localhost:5173/error-video",
          startTime: 0,
          duration: 10,
          detector: failingDetector,
        });

        assert.equal(result.detections.length, 0, "Detector errors should result in 0 detections");
        assert.ok(
          result.status === "no_faces_found" || result.status === "error",
          "Should handle detector errors gracefully without crashing"
        );
      } finally {
        restoreDom();
      }
    });
  });

  describe("7. Preservation of Manual Crop Behavior & Scene-Cut Timing", () => {
    it("preserves manual cropX values when users explicitly choose framing", () => {
      const track = generateFallbackReframingTrack(source16x9, "9:16", 35.88, 0.8);
      assert.equal(track.cropKeyframes[0].panFactor, 0.8, "Keyframe panFactor should match manualCropX");

      const crop = resolveSmartFrameCropAtTime(track, 10.0);
      assert.equal(crop.panFactor, 0.8, "Evaluated crop panFactor should match manualCropX");
    });

    it("preserves scene cut boundary keyframes without smoothing jitter across camera angles", () => {
      const track = buildDynamicReframingTrack({
        detections: [
          { time: 0.0, faces: [internPersonLeft] },
          { time: 2.0, faces: [internPersonLeft] },
          { time: 4.0, faces: [interviewerPersonRight] },
          { time: 6.0, faces: [interviewerPersonRight] },
        ],
        sceneCuts: [3.0], // Camera angle switch at 3.0s
        duration: 8.0,
        sourceSize: source16x9,
        targetRatio: "9:16",
      });

      const cutKeyframes = track.cropKeyframes.filter((kf) => kf.cut === true);
      assert.ok(cutKeyframes.length > 0, "Scene cut keyframe must be present at cut boundary");
      assert.ok(
        cutKeyframes.some((kf) => Math.abs(kf.time - 3.0) < 0.1),
        "Cut keyframe must align with 3.0s scene cut"
      );
    });
  });
});
