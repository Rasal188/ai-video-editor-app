/**
 * @file shorts-face-detection.test.js
 * Comprehensive tests for AI Shorts Studio Phase 2 local face detection:
 * 1. calculateSampleTimestamps: controlled sampling intervals, bounds, and deduplication.
 * 2. normalizeDetectedFace: normalized bounding boxes, area, and center calculations.
 * 3. detectFacesOnCanvas: canvas detection with mock detector and coordinate bounds.
 * 4. sampleVideoFaceDetections:
 *    - Graceful handling of unsupported browser environments (no FaceDetector).
 *    - Injected detector simulating real multi-person video sampling.
 *    - Cancellation via AbortSignal.
 *    - Invalid source handling.
 * 5. Full pipeline integration from new detection -> discoverShortCandidates -> convertCandidateToProject -> timeline transfer.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  calculateSampleTimestamps,
  normalizeDetectedFace,
  normalizeVisionPersonDetection,
  getCanvasBlob,
  detectFacesOnCanvas,
  sampleVideoFaceDetections,
  isNativeFaceDetectorSupported,
  isVisionSubjectAnalysisSupported,
  isLocalDetectionSupported,
} from "../../src/lib/shortsFaceDetection.js";

import {
  discoverShortCandidates,
  convertCandidateToProject,
} from "../../src/lib/shortsStudio.js";

import {
  resolveSmartFrameCropAtTime,
  smartFrameCropToPixels,
} from "../../src/lib/smartFrame.js";

describe("AI Shorts Studio — Local Face Detection & Pipeline Integration", () => {
  describe("1. Timestamp Calculation & Sampling Bounds", () => {
    it("bounds sample timestamps evenly across duration without exceeding maxSamples", () => {
      const times = calculateSampleTimestamps({ duration: 30, interval: 1.0, maxSamples: 15 });
      assert.ok(times.length <= 15, `Length ${times.length} should be <= 15`);
      assert.equal(times[0], 0, "First sample should be at 0");
      assert.ok(Math.abs(times[times.length - 1] - 29.98) < 0.1, "Last sample should be near end");
      // Check ascending order
      for (let i = 1; i < times.length; i++) {
        assert.ok(times[i] > times[i - 1], `Time at ${i} (${times[i]}) must be greater than previous (${times[i-1]})`);
      }
    });

    it("handles zero or negative duration safely", () => {
      assert.deepEqual(calculateSampleTimestamps({ duration: 0 }), [0]);
      assert.deepEqual(calculateSampleTimestamps({ duration: -5 }), [0]);
    });

    it("respects minimum interval to avoid overloading CPU on short clips", () => {
      const times = calculateSampleTimestamps({ duration: 2, interval: 0.1 });
      // Should clamp interval to at least 0.5s
      assert.ok(times.length <= 6, `Should have <= 6 samples for 2s, got ${times.length}`);
    });
  });

  describe("2. Coordinate Normalization & Bounding Box Validation", () => {
    it("normalizes pixel coordinates to [0, 1] range", () => {
      const raw = { x: 192, y: 108, width: 384, height: 432 };
      const norm = normalizeDetectedFace(raw, 1920, 1080, 0);

      assert.ok(norm);
      assert.equal(norm.xMin, 0.1);
      assert.equal(norm.yMin, 0.1);
      assert.equal(norm.xMax, 0.3);
      assert.equal(norm.yMax, 0.5);
      assert.equal(norm.width, 0.2);
      assert.equal(norm.height, 0.4);
      assert.equal(norm.centerX, 0.2);
      assert.equal(norm.centerY, 0.3);
      assert.equal(norm.label, "face");
      assert.equal(norm.confidence, 0.92);
    });

    it("rejects tiny, inverted, or zero-dimension boxes", () => {
      assert.equal(normalizeDetectedFace({ x: 10, y: 10, width: 0, height: 100 }, 1920, 1080), null);
      assert.equal(normalizeDetectedFace({ x: 10, y: 10, width: 2, height: 2 }, 1920, 1080), null);
      assert.equal(normalizeDetectedFace(null, 1920, 1080), null);
    });

    it("normalizes vision worker person detections [0, 1] with center and confidence", () => {
      const rawVision = {
        label: "person",
        score: 0.942,
        box: { xmin: 0.15, ymin: 0.12, xmax: 0.35, ymax: 0.46 },
      };
      const norm = normalizeVisionPersonDetection(rawVision, 0);

      assert.ok(norm);
      assert.equal(norm.xMin, 0.15);
      assert.equal(norm.yMin, 0.12);
      assert.equal(norm.xMax, 0.35);
      assert.equal(norm.yMax, 0.46);
      assert.equal(norm.width, 0.2);
      assert.equal(norm.height, 0.34);
      assert.equal(norm.centerX, 0.25);
      assert.equal(norm.centerY, 0.29);
      assert.equal(norm.confidence, 0.942);
      assert.equal(norm.label, "person");
      assert.equal(norm.isPerson, true);
      assert.equal(norm.id, "person-0-25");
    });

    it("handles alternative vision box keys (xMin/xMax, width/height) and rejects invalid coordinates", () => {
      const altBox = {
        label: "person",
        score: 0.88,
        box: { xMin: 0.6, yMin: 0.1, width: 0.2, height: 0.4 },
      };
      const norm = normalizeVisionPersonDetection(altBox, 1);
      assert.ok(norm);
      assert.equal(norm.xMin, 0.6);
      assert.equal(norm.xMax, 0.8);
      assert.equal(norm.centerX, 0.7);

      assert.equal(normalizeVisionPersonDetection(null), null);
      assert.equal(normalizeVisionPersonDetection({ box: { xmin: 0.5, ymin: 0.5, xmax: 0.4, ymax: 0.8 } }), null);
      assert.equal(normalizeVisionPersonDetection({ box: { xmin: "invalid" } }), null);
    });
  });

  describe("3. Face Detection Execution & Fallback Support", () => {
    it("reports unsupported status cleanly when native FaceDetector is unavailable in Node", async () => {
      // In Node.js environment, globalThis.FaceDetector is undefined
      assert.equal(isNativeFaceDetectorSupported(), false);

      const result = await sampleVideoFaceDetections({
        source: "dummy.mp4",
        duration: 30,
      });

      assert.equal(result.supported, false);
      assert.equal(result.status, "unsupported");
      assert.deepEqual(result.detections, []);
    });

    it("runs detection on canvas with an injected mock detector", async () => {
      const mockDetector = {
        detect: async (canvas) => [
          { boundingBox: { x: 100, y: 50, width: 80, height: 100 } },
          { boundingBox: { x: 300, y: 60, width: 70, height: 90 } },
        ],
      };

      const mockCanvas = { width: 500, height: 500 };
      const faces = await detectFacesOnCanvas(mockCanvas, mockDetector);

      assert.equal(faces.length, 2);
      assert.equal(faces[0].xMin, 0.2);
      assert.equal(faces[1].xMin, 0.6);
    });

    it("executes local vision worker fallback when visionAnalyzer is provided", async () => {
      // Setup mock DOM environment for video/canvas sampling
      const mockVideo = {
        readyState: 4,
        duration: 10,
        videoWidth: 1920,
        videoHeight: 1080,
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
        getContext() {
          return { drawImage() {} };
        },
        toBlob(callback) {
          callback(new Blob(["mock-jpeg-frame"], { type: "image/jpeg" }));
        },
      };

      const originalDoc = globalThis.document;
      globalThis.document = {
        createElement(tag) {
          if (tag === "video") return mockVideo;
          if (tag === "canvas") return mockCanvas;
          return {};
        },
      };

      try {
        const mockVisionAnalyzer = async ({ blob }) => {
          assert.ok(blob instanceof Blob, "Must receive frame Blob");
          return {
            sourceSize: { width: 360, height: 203 },
            detections: [
              { label: "person", score: 0.96, box: { xmin: 0.15, ymin: 0.12, xmax: 0.35, ymax: 0.45 } },
              { label: "person", score: 0.92, box: { xmin: 0.65, ymin: 0.14, xmax: 0.85, ymax: 0.44 } },
              { label: "chair", score: 0.80, box: { xmin: 0.40, ymin: 0.60, xmax: 0.60, ymax: 0.90 } },
            ],
            subject: { label: "person", score: 0.96, box: { xmin: 0.15, ymin: 0.12, xmax: 0.35, ymax: 0.45 } },
          };
        };

        const result = await sampleVideoFaceDetections({
          source: "blob:http://localhost:5173/test-video",
          duration: 3,
          interval: 1.5,
          visionAnalyzer: mockVisionAnalyzer,
        });

        assert.equal(result.supported, true);
        assert.equal(result.status, "faces_found");
        assert.equal(result.strategy, "injected_vision");
        assert.ok(result.detections.length >= 2, `Expected >= 2 sampled frames, got ${result.detections.length}`);

        // Verify that only the 2 person detections were normalized, rejecting chair
        const frame0 = result.detections[0];
        assert.equal(frame0.faces.length, 2);
        assert.equal(frame0.faces[0].label, "person");
        assert.equal(frame0.faces[0].isPerson, true);
        assert.equal(frame0.faces[0].xMin, 0.15);
        assert.equal(frame0.faces[1].xMin, 0.65);
      } finally {
        if (originalDoc !== undefined) {
          globalThis.document = originalDoc;
        } else {
          delete globalThis.document;
        }
      }
    });

    it("gracefully catches vision analyzer errors and returns honest error status without throwing", async () => {
      const mockVideo = {
        readyState: 4,
        duration: 10,
        videoWidth: 1920,
        videoHeight: 1080,
        currentTime: 0,
        pause() {},
        removeAttribute() {},
        load() {},
        addEventListener(event, fn) { setTimeout(fn, 0); },
        removeEventListener() {},
      };
      const mockCanvas = {
        width: 360,
        height: 203,
        getContext() { return { drawImage() {} }; },
        toBlob(callback) { callback(new Blob(["mock-frame"], { type: "image/jpeg" })); },
      };

      const originalDoc = globalThis.document;
      globalThis.document = {
        createElement(tag) {
          if (tag === "video") return mockVideo;
          if (tag === "canvas") return mockCanvas;
          return {};
        },
      };

      try {
        const failingVisionAnalyzer = async () => {
          throw new Error("HuggingFace ONNX model fetch failed (offline mode)");
        };

        const result = await sampleVideoFaceDetections({
          source: "blob:http://localhost:5173/test-video",
          duration: 5,
          visionAnalyzer: failingVisionAnalyzer,
        });

        assert.equal(result.supported, true);
        assert.equal(result.status, "error");
        assert.ok(result.reason.includes("model fetch failed"));
        assert.deepEqual(result.detections, []);
      } finally {
        if (originalDoc !== undefined) {
          globalThis.document = originalDoc;
        } else {
          delete globalThis.document;
        }
      }
    });

    it("handles detector cancellation with AbortSignal", async () => {
      const controller = new AbortController();
      controller.abort();

      const mockDetector = { detect: async () => [] };
      await assert.rejects(
        sampleVideoFaceDetections({
          source: "dummy.mp4",
          signal: controller.signal,
          detector: mockDetector,
        }),
        (err) => err.name === "AbortError"
      );
    });
  });

  describe("4. End-to-End Pipeline: New Detections -> AI Shorts Studio -> Timeline Transfer", () => {
    const dummySource = {
      id: "raw-interview",
      name: "podcast.mp4",
      width: 1920,
      height: 1080,
      duration: 60,
      type: "video",
    };

    it("successfully creates 9:16 portrait keyframes when new local detections are discovered", () => {
      // Synthetic detections simulating output of sampleVideoFaceDetections
      // Two people: Left speaker at x: 0.15-0.35, Right listener at x: 0.65-0.85
      const newDetections = [
        {
          time: 0,
          faces: [
            { xMin: 0.15, xMax: 0.35, yMin: 0.1, yMax: 0.45, confidence: 0.95, id: "person-left" },
            { xMin: 0.65, xMax: 0.85, yMin: 0.12, yMax: 0.44, confidence: 0.92, id: "person-right" },
          ],
        },
        {
          time: 15,
          faces: [
            { xMin: 0.16, xMax: 0.36, yMin: 0.1, yMax: 0.45, confidence: 0.95, id: "person-left" },
            { xMin: 0.64, xMax: 0.84, yMin: 0.12, yMax: 0.44, confidence: 0.92, id: "person-right" },
          ],
        },
      ];

      // 1. Discover candidates with new detections
      const discovery = discoverShortCandidates({
        sourceMedia: dummySource,
        settings: {
          aspectRatio: "9:16",
          autoReframing: "smart-subject",
          faceDetections: newDetections,
        },
      });

      assert.ok(discovery.ok);
      const cand = discovery.candidates[0];
      assert.ok(cand.smartFrame, "Candidate must receive dynamic smartFrame track");
      assert.equal(cand.smartFrame.state, "tracked");
      assert.equal(cand.smartFrame.isFallback, false);

      // Verify that candidate crop centers on the left person, NOT the center wall
      const kf0 = cand.smartFrame.cropKeyframes[0];
      assert.ok(kf0.x < 0.25, `Expected crop x to frame left person, got ${kf0.x}`);
      assert.notEqual(kf0.x, 0.3418, "Must not equal empty center x=0.3418");

      // 2. Transfer candidate to timeline project
      const project = convertCandidateToProject(dummySource, cand, {
        aspectRatio: "9:16",
        autoReframing: "smart-subject",
        faceDetections: newDetections,
      });

      assert.ok(project);
      const segment = project.visualSegments[0];
      assert.ok(segment.smartFrame);
      assert.equal(segment.smartFrame.state, "tracked");
      assert.equal(segment.smartFrame.isFallback, false);

      // 3. Verify preview model evaluation at sample time
      const crop = resolveSmartFrameCropAtTime(segment.smartFrame, cand.startTime + 2);
      assert.ok(crop);
      assert.equal(crop.isFallback, false);
      assert.equal(crop.state, "tracked");
      assert.ok(crop.x < 0.25);

      // Verify pixel crop encloses the person
      const pixels = smartFrameCropToPixels(crop, segment.smartFrame.sourceSize);
      assert.ok(pixels);
      // Left person is at 0.15 * 1920 = 288px to 0.35 * 1920 = 672px
      assert.ok(pixels.x <= 288, `Crop x (${pixels.x}px) must start at or before person left edge (288px)`);
      assert.ok(pixels.x + pixels.width >= 672, `Crop right (${pixels.x + pixels.width}px) must extend past person right edge (672px)`);
    });

    it("maintains honest fallback when detection finds no faces", () => {
      // 1. Discover candidates with NO detections
      const discovery = discoverShortCandidates({
        sourceMedia: dummySource,
        settings: {
          aspectRatio: "9:16",
          autoReframing: "smart-subject",
          faceDetections: [], // 0 detections found
        },
      });

      assert.ok(discovery.ok);
      const cand = discovery.candidates[0];
      assert.ok(cand.smartFrame);
      assert.equal(cand.smartFrame.state, "fallback");
      assert.equal(cand.smartFrame.isFallback, true);
      assert.equal(cand.smartFrame.confidence, 0);

      // 2. Transfer candidate to timeline project
      const project = convertCandidateToProject(dummySource, cand, {
        aspectRatio: "9:16",
        autoReframing: "smart-subject",
        faceDetections: [],
      });

      const segment = project.visualSegments[0];
      assert.equal(segment.smartFrame.state, "fallback");
      assert.equal(segment.smartFrame.isFallback, true);
      assert.equal(segment.smartFrame.confidence, 0);

      const crop = resolveSmartFrameCropAtTime(segment.smartFrame, 5);
      assert.equal(crop.isFallback, true);
      assert.equal(crop.state, "fallback");
    });

    it("strictly enforces state 'fallback' in normalizeSmartFrame when isFallback is true, even if target.state was 'tracked'", async () => {
      const { normalizeSmartFrame } = await import("../../src/lib/smartFrame.js");
      const normalized = normalizeSmartFrame({
        isFallback: true,
        state: "tracked",
        cropKeyframes: [
          { time: 0, x: 0.3418, y: 0, width: 0.3164, height: 1, state: "tracked" },
          { time: 10, x: 0.3418, y: 0, width: 0.3164, height: 1, state: "tracked" },
        ],
      });

      assert.equal(normalized.isFallback, true);
      assert.equal(normalized.state, "fallback", "state must be 'fallback' when isFallback is true");
      assert.equal(normalized.confidence, 0);
      assert.equal(normalized.cropKeyframes[0].state, "fallback");
      assert.equal(normalized.cropKeyframes[0].isFallback, true);
    });
  });
});
