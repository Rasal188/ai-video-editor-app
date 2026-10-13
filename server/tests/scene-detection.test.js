import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SCENE_DETECTION_SETTINGS,
  normalizeSceneDetectionSettings,
  computeFrameSignature,
  computeFrameDifference,
  computeConfidence,
  generateSampleTimes,
  detectScenesFromSignatures,
  detectScenesStream,
  detectVideoScenes,
} from "../../src/lib/sceneDetection.js";

/**
 * Creates a synthetic solid color RGBA frame buffer.
 */
function createSolidFrame(r, g, b, width = 64, height = 36) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const offset = i * 4;
    data[offset] = r;
    data[offset + 1] = g;
    data[offset + 2] = b;
    data[offset + 3] = 255;
  }
  return { data, width, height };
}

/**
 * Creates a synthetic frame with deterministic low-amplitude noise.
 */
function createSubtleShiftFrame(baseR, baseG, baseB, shift = 5, width = 64, height = 36) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const offset = i * 4;
    data[offset] = Math.min(255, Math.max(0, baseR + (i % 2 === 0 ? shift : -shift)));
    data[offset + 1] = Math.min(255, Math.max(0, baseG + (i % 3 === 0 ? shift : -shift)));
    data[offset + 2] = Math.min(255, Math.max(0, baseB + (i % 4 === 0 ? shift : -shift)));
    data[offset + 3] = 255;
  }
  return { data, width, height };
}

describe("AI Scene Detection Engine — Phase 1", () => {
  describe("Configuration & Settings Normalization", () => {
    it("should export correct default settings", () => {
      assert.strictEqual(DEFAULT_SCENE_DETECTION_SETTINGS.sampleInterval, 0.5);
      assert.strictEqual(DEFAULT_SCENE_DETECTION_SETTINGS.threshold, 0.30);
      assert.strictEqual(DEFAULT_SCENE_DETECTION_SETTINGS.minSceneDuration, 1.0);
      assert.strictEqual(DEFAULT_SCENE_DETECTION_SETTINGS.startGuard, 0.5);
      assert.strictEqual(DEFAULT_SCENE_DETECTION_SETTINGS.endGuard, 0.5);
      assert.strictEqual(DEFAULT_SCENE_DETECTION_SETTINGS.maxSamples, 1200);
    });

    it("should normalize valid custom overrides and clamp unsafe values", () => {
      const normalized = normalizeSceneDetectionSettings({
        sampleInterval: 0.25,
        threshold: 0.45,
        minSceneDuration: 2.0,
        startGuard: 1.0,
        endGuard: 1.5,
        maxSamples: 500,
      });

      assert.strictEqual(normalized.sampleInterval, 0.25);
      assert.strictEqual(normalized.threshold, 0.45);
      assert.strictEqual(normalized.minSceneDuration, 2.0);
      assert.strictEqual(normalized.startGuard, 1.0);
      assert.strictEqual(normalized.endGuard, 1.5);
      assert.strictEqual(normalized.maxSamples, 500);
    });

    it("should fallback to defaults when invalid or NaN values are provided", () => {
      const normalized = normalizeSceneDetectionSettings({
        sampleInterval: -1,
        threshold: "invalid",
        minSceneDuration: null,
      });

      assert.strictEqual(normalized.sampleInterval, DEFAULT_SCENE_DETECTION_SETTINGS.sampleInterval);
      assert.strictEqual(normalized.threshold, DEFAULT_SCENE_DETECTION_SETTINGS.threshold);
      assert.strictEqual(normalized.minSceneDuration, DEFAULT_SCENE_DETECTION_SETTINGS.minSceneDuration);
    });
  });

  describe("Visual Signatures & Frame Difference Metrics", () => {
    it("should reject null or invalid frame data", () => {
      assert.throws(() => computeFrameSignature(null), /INVALID_FRAME_DATA/);
      assert.throws(() => computeFrameSignature("string"), /INVALID_FRAME_DATA/);
    });

    it("should compute normalized 3D color histogram and spatial grid", () => {
      const redFrame = createSolidFrame(255, 0, 0);
      const sig = computeFrameSignature(redFrame);

      assert.strictEqual(sig.histogram.length, 64);
      assert.strictEqual(sig.spatialGrid.length, 192);
      // Normalized sum should equal 1.0
      const sum = sig.histogram.reduce((acc, val) => acc + val, 0);
      assert.ok(Math.abs(sum - 1.0) < 0.0001);
      assert.ok(sig.averageLuminance > 0);
    });

    it("should return zero difference for identical frame signatures", () => {
      const frameA = createSolidFrame(100, 150, 200);
      const sigA = computeFrameSignature(frameA);
      const sigB = computeFrameSignature(frameA);

      const diff = computeFrameDifference(sigA, sigB);
      assert.strictEqual(diff.score, 0);
      assert.strictEqual(diff.histDiff, 0);
      assert.strictEqual(diff.spatialDiff, 0);
    });

    it("should return high difference score (close to 1.0) for completely distinct frames", () => {
      const blackFrame = createSolidFrame(0, 0, 0);
      const whiteFrame = createSolidFrame(255, 255, 255);

      const sigBlack = computeFrameSignature(blackFrame);
      const sigWhite = computeFrameSignature(whiteFrame);

      const diff = computeFrameDifference(sigBlack, sigWhite);
      assert.strictEqual(diff.histDiff, 1.0);
      assert.strictEqual(diff.spatialDiff, 1.0);
      assert.strictEqual(diff.score, 1.0);
    });

    it("should compute justified heuristic confidence above detection threshold", () => {
      assert.strictEqual(computeConfidence(0.20, 0.30), 0); // below threshold
      assert.strictEqual(computeConfidence(0.30, 0.30), 0.50); // exactly at threshold
      assert.strictEqual(computeConfidence(1.00, 0.30), 1.00); // maximum score
      assert.ok(computeConfidence(0.65, 0.30) > 0.50);
      assert.ok(computeConfidence(0.65, 0.30) < 1.00);
    });
  });

  describe("Sample Timestamp Generation", () => {
    it("should return empty array for non-positive or invalid duration", () => {
      assert.deepStrictEqual(generateSampleTimes(0), []);
      assert.deepStrictEqual(generateSampleTimes(-5), []);
      assert.deepStrictEqual(generateSampleTimes(NaN), []);
      assert.deepStrictEqual(generateSampleTimes(null), []);
    });

    it("should generate timestamps at configured intervals up to duration", () => {
      const times = generateSampleTimes(2.0, { sampleInterval: 0.5 });
      assert.deepStrictEqual(times, [0, 0.5, 1.0, 1.5, 2.0]);
    });

    it("should respect maxSamples limit on long durations", () => {
      const times = generateSampleTimes(1000, { sampleInterval: 0.5, maxSamples: 10 });
      assert.strictEqual(times.length, 10);
    });
  });

  describe("Scene Detection Core Logic (detectScenesFromSignatures)", () => {
    it("should handle empty or invalid inputs gracefully", () => {
      const res1 = detectScenesFromSignatures([], { duration: 0 });
      assert.strictEqual(res1.duration, 0);
      assert.deepStrictEqual(res1.scenes, []);
      assert.deepStrictEqual(res1.boundaries, []);

      const res2 = detectScenesFromSignatures(null, { duration: 5.0 });
      assert.strictEqual(res2.duration, 5.0);
      assert.strictEqual(res2.scenes.length, 1);
      assert.strictEqual(res2.scenes[0].start, 0);
      assert.strictEqual(res2.scenes[0].end, 5.0);
      assert.deepStrictEqual(res2.boundaries, []);
    });

    it("should detect no cuts in a video with no meaningful scene changes", () => {
      const duration = 5.0;
      const baseFrame = createSolidFrame(30, 140, 200);
      const samples = [
        { time: 0.0, signature: computeFrameSignature(baseFrame) },
        { time: 0.5, signature: computeFrameSignature(createSubtleShiftFrame(30, 140, 200, 2)) },
        { time: 1.0, signature: computeFrameSignature(createSubtleShiftFrame(30, 140, 200, 3)) },
        { time: 1.5, signature: computeFrameSignature(baseFrame) },
        { time: 2.0, signature: computeFrameSignature(createSubtleShiftFrame(30, 140, 200, 1)) },
      ];

      const result = detectScenesFromSignatures(samples, { duration, threshold: 0.30 });
      assert.strictEqual(result.boundaries.length, 0);
      assert.strictEqual(result.scenes.length, 1);
      assert.strictEqual(result.scenes[0].start, 0);
      assert.strictEqual(result.scenes[0].end, 5.0);
      assert.strictEqual(result.scenes[0].duration, 5.0);
    });

    it("should detect exactly one clear hard cut", () => {
      const duration = 6.0;
      const blackSig = computeFrameSignature(createSolidFrame(0, 0, 0));
      const redSig = computeFrameSignature(createSolidFrame(255, 0, 0));

      const samples = [
        { time: 0.0, signature: blackSig },
        { time: 0.5, signature: blackSig },
        { time: 1.0, signature: blackSig },
        { time: 1.5, signature: blackSig },
        { time: 2.0, signature: blackSig },
        { time: 2.5, signature: redSig }, // Clear cut at 2.5s
        { time: 3.0, signature: redSig },
        { time: 3.5, signature: redSig },
        { time: 4.0, signature: redSig },
      ];

      const result = detectScenesFromSignatures(samples, { duration });
      assert.strictEqual(result.boundaries.length, 1);
      assert.strictEqual(result.boundaries[0].time, 2.5);
      assert.strictEqual(result.boundaries[0].transitionType, "cut");
      assert.ok(result.boundaries[0].score >= 0.70);
      assert.ok(result.boundaries[0].confidence >= 0.75);

      // Verify contiguous scenes
      assert.strictEqual(result.scenes.length, 2);
      assert.deepStrictEqual(result.scenes[0], { index: 0, start: 0, end: 2.5, duration: 2.5 });
      assert.deepStrictEqual(result.scenes[1], { index: 1, start: 2.5, end: 6.0, duration: 3.5 });
    });

    it("should detect multiple distinct scene changes", () => {
      const duration = 10.0;
      const sigA = computeFrameSignature(createSolidFrame(20, 20, 20));     // Dark
      const sigB = computeFrameSignature(createSolidFrame(240, 20, 20));   // Bright Red
      const sigC = computeFrameSignature(createSolidFrame(20, 240, 20));   // Bright Green

      const samples = [
        { time: 0.0, signature: sigA },
        { time: 1.0, signature: sigA },
        { time: 2.0, signature: sigA },
        { time: 3.0, signature: sigB }, // Cut 1 at 3.0s
        { time: 4.0, signature: sigB },
        { time: 5.0, signature: sigB },
        { time: 6.0, signature: sigB },
        { time: 7.0, signature: sigC }, // Cut 2 at 7.0s
        { time: 8.0, signature: sigC },
        { time: 9.0, signature: sigC },
      ];

      const result = detectScenesFromSignatures(samples, { duration });
      assert.strictEqual(result.boundaries.length, 2);
      assert.strictEqual(result.boundaries[0].time, 3.0);
      assert.strictEqual(result.boundaries[1].time, 7.0);

      assert.strictEqual(result.scenes.length, 3);
      assert.deepStrictEqual(result.scenes[0], { index: 0, start: 0, end: 3.0, duration: 3.0 });
      assert.deepStrictEqual(result.scenes[1], { index: 1, start: 3.0, end: 7.0, duration: 4.0 });
      assert.deepStrictEqual(result.scenes[2], { index: 2, start: 7.0, end: 10.0, duration: 3.0 });
    });

    it("should suppress duplicate boundaries within temporal debounce window", () => {
      const duration = 8.0;
      const sigA = computeFrameSignature(createSolidFrame(10, 10, 10));
      const sigIntermediate = computeFrameSignature(createSolidFrame(120, 50, 50));
      const sigB = computeFrameSignature(createSolidFrame(255, 255, 255));

      // At 2.0s and 2.5s both adjacent steps show significant delta across a cut
      const samples = [
        { time: 0.0, signature: sigA },
        { time: 0.5, signature: sigA },
        { time: 1.0, signature: sigA },
        { time: 1.5, signature: sigA },
        { time: 2.0, signature: sigIntermediate }, // partial delta
        { time: 2.5, signature: sigB },            // larger peak delta
        { time: 3.0, signature: sigB },
        { time: 3.5, signature: sigB },
        { time: 4.0, signature: sigB },
      ];

      const result = detectScenesFromSignatures(samples, { duration, threshold: 0.25 });
      // Should suppress the lower cluster candidate and report only 1 peak boundary
      assert.strictEqual(result.boundaries.length, 1);
      assert.strictEqual(result.boundaries[0].time, 2.5);
    });

    it("should enforce minimum scene duration and avoid creating micro-scenes", () => {
      const duration = 6.0;
      const sigA = computeFrameSignature(createSolidFrame(0, 0, 0));
      const sigB = computeFrameSignature(createSolidFrame(255, 0, 0));
      const sigC = computeFrameSignature(createSolidFrame(0, 255, 0));

      // Cut 1 at 2.0s, cut 2 at 2.5s (only 0.5s apart).
      // With minSceneDuration = 1.0s, only the higher-confidence boundary should be accepted.
      const samples = [
        { time: 0.0, signature: sigA },
        { time: 1.0, signature: sigA },
        { time: 2.0, signature: sigB }, // High delta (black to red)
        { time: 2.5, signature: sigC }, // Slightly smaller or equal delta (red to green)
        { time: 4.0, signature: sigC },
        { time: 5.0, signature: sigC },
      ];

      const result = detectScenesFromSignatures(samples, {
        duration,
        minSceneDuration: 1.0,
      });

      assert.strictEqual(result.boundaries.length, 1);
      for (const scene of result.scenes) {
        assert.ok(scene.duration >= 1.0, `Scene duration ${scene.duration} must be >= minSceneDuration`);
      }
    });

    it("should exclude boundaries within startGuard and endGuard intervals", () => {
      const duration = 10.0;
      const sigA = computeFrameSignature(createSolidFrame(0, 0, 0));
      const sigB = computeFrameSignature(createSolidFrame(255, 255, 255));

      const samples = [
        { time: 0.0, signature: sigA },
        { time: 0.2, signature: sigB }, // Cut at 0.2s: within startGuard (0.5s)
        { time: 1.0, signature: sigB },
        { time: 5.0, signature: sigA }, // Cut at 5.0s: valid
        { time: 9.8, signature: sigB }, // Cut at 9.8s: within endGuard (0.5s, 10.0 - 0.5 = 9.5)
      ];

      const result = detectScenesFromSignatures(samples, {
        duration,
        startGuard: 0.5,
        endGuard: 0.5,
      });

      assert.strictEqual(result.boundaries.length, 1);
      assert.strictEqual(result.boundaries[0].time, 5.0);
    });

    it("should respect sensitivity threshold tuning", () => {
      const duration = 6.0;
      const frameA = createSolidFrame(50, 50, 50);
      const frameModerateShift = createSolidFrame(90, 90, 90); // moderate shift

      const samples = [
        { time: 0.0, signature: computeFrameSignature(frameA) },
        { time: 1.0, signature: computeFrameSignature(frameA) },
        { time: 2.0, signature: computeFrameSignature(frameModerateShift) },
        { time: 3.0, signature: computeFrameSignature(frameModerateShift) },
      ];

      // Low threshold catches the moderate shift
      const sensitiveResult = detectScenesFromSignatures(samples, { duration, threshold: 0.20 });
      assert.strictEqual(sensitiveResult.boundaries.length, 1);

      // High threshold rejects the moderate shift
      const strictResult = detectScenesFromSignatures(samples, { duration, threshold: 0.65 });
      assert.strictEqual(strictResult.boundaries.length, 0);
    });

    it("should return stable chronological ordering and valid contiguous intervals", () => {
      const duration = 12.0;
      const sig1 = computeFrameSignature(createSolidFrame(10, 10, 10));
      const sig2 = computeFrameSignature(createSolidFrame(200, 10, 10));
      const sig3 = computeFrameSignature(createSolidFrame(10, 200, 10));
      const sig4 = computeFrameSignature(createSolidFrame(10, 10, 200));

      const samples = [
        { time: 0.0, signature: sig1 },
        { time: 2.0, signature: sig2 },
        { time: 5.0, signature: sig3 },
        { time: 8.5, signature: sig4 },
        { time: 11.0, signature: sig4 },
      ];

      const result = detectScenesFromSignatures(samples, { duration });

      // Strict increasing order of boundaries
      for (let i = 1; i < result.boundaries.length; i++) {
        assert.ok(result.boundaries[i].time > result.boundaries[i - 1].time);
      }

      // Contiguous scene intervals spanning [0, duration]
      assert.strictEqual(result.scenes[0].start, 0);
      assert.strictEqual(result.scenes[result.scenes.length - 1].end, duration);
      for (let s = 0; s < result.scenes.length - 1; s++) {
        assert.strictEqual(result.scenes[s].end, result.scenes[s + 1].start);
      }
    });
  });

  describe("Streaming Frame Analysis & Failure Recovery (detectScenesStream)", () => {
    it("should stream frames sequentially without retaining raw buffers", async () => {
      const duration = 4.0;
      const sigBlack = computeFrameSignature(createSolidFrame(0, 0, 0));
      const sigWhite = computeFrameSignature(createSolidFrame(255, 255, 255));

      let callCount = 0;
      const provider = async (time) => {
        callCount++;
        return time < 2.0 ? sigBlack : sigWhite;
      };

      const result = await detectScenesStream(provider, { duration, sampleInterval: 0.5 });
      assert.ok(callCount > 0);
      assert.strictEqual(result.boundaries.length, 1);
      assert.strictEqual(result.boundaries[0].time, 2.0);
      assert.strictEqual(result.stats.failedSamples, 0);
    });

    it("should handle individual frame extraction failures gracefully", async () => {
      const duration = 4.0;
      const sigBlack = computeFrameSignature(createSolidFrame(0, 0, 0));
      const sigWhite = computeFrameSignature(createSolidFrame(255, 255, 255));

      const provider = async (time) => {
        if (Math.abs(time - 1.0) < 0.01) {
          throw new Error("DECODE_FAIL_SIMULATION");
        }
        if (Math.abs(time - 1.5) < 0.01) {
          return null; // Missing frame simulation
        }
        return time < 2.0 ? sigBlack : sigWhite;
      };

      const result = await detectScenesStream(provider, { duration, sampleInterval: 0.5 });
      assert.strictEqual(result.stats.failedSamples, 2);
      // Analysis still succeeds for remaining frames
      assert.ok(result.scenes.length >= 1);
    });

    it("should abort immediately when AbortSignal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        () => detectScenesStream(async () => createSolidFrame(0, 0, 0), {
          duration: 10,
          signal: controller.signal,
        }),
        (err) => err.name === "AbortError",
      );
    });

    it("should abort gracefully during mid-stream execution", async () => {
      const controller = new AbortController();
      let iteration = 0;

      const provider = async () => {
        iteration++;
        if (iteration === 3) {
          controller.abort();
        }
        return createSolidFrame(0, 0, 0);
      };

      await assert.rejects(
        () => detectScenesStream(provider, {
          duration: 10,
          signal: controller.signal,
        }),
        (err) => err.name === "AbortError",
      );
    });

    it("should invoke onProgress callback incrementally with valid percentages and metadata", async () => {
      const duration = 2.0;
      const progressUpdates = [];

      const provider = async () => createSolidFrame(0, 0, 0);
      const onProgress = (percent, meta) => {
        progressUpdates.push({ percent, meta });
      };

      const result = await detectScenesStream(provider, {
        duration,
        sampleInterval: 0.5,
        onProgress,
      });

      assert.ok(result.scenes.length >= 1);
      // With duration 2.0 and sampleInterval 0.5, sample times are [0.0, 0.5, 1.0, 1.5, 2.0] (5 samples)
      assert.strictEqual(progressUpdates.length, 5);

      // Verify progress increases monotonically
      let previousPercent = 0;
      for (let i = 0; i < progressUpdates.length; i++) {
        const { percent, meta } = progressUpdates[i];
        assert.ok(percent >= previousPercent, `Progress ${percent} must be >= previous ${previousPercent}`);
        assert.ok(percent >= 0 && percent <= 100, `Progress ${percent} must be within 0..100`);
        assert.strictEqual(meta.processed, i + 1);
        assert.strictEqual(meta.total, 5);
        assert.strictEqual(meta.failed, false);
        previousPercent = percent;
      }

      // Final progress must reach 100%
      assert.strictEqual(progressUpdates[progressUpdates.length - 1].percent, 100);
    });

    it("should continue progress reporting even when individual frames fail", async () => {
      const duration = 1.5; // [0.0, 0.5, 1.0, 1.5] -> 4 samples
      const progressUpdates = [];

      const provider = async (time) => {
        if (time === 0.5) throw new Error("FRAME_FAIL");
        if (time === 1.0) return null;
        return createSolidFrame(0, 0, 0);
      };

      await detectScenesStream(provider, {
        duration,
        sampleInterval: 0.5,
        onProgress: (percent, meta) => progressUpdates.push({ percent, meta }),
      });

      assert.strictEqual(progressUpdates.length, 4);
      assert.strictEqual(progressUpdates[1].meta.failed, true);
      assert.strictEqual(progressUpdates[2].meta.failed, true);
      assert.strictEqual(progressUpdates[3].percent, 100);
    });

    it("should handle buggy onProgress callbacks that throw without breaking analysis", async () => {
      const duration = 1.0;
      const buggyProgress = () => {
        throw new Error("CONSUMER_PROGRESS_CRASH");
      };

      const result = await detectScenesStream(async () => createSolidFrame(0, 0, 0), {
        duration,
        sampleInterval: 0.5,
        onProgress: buggyProgress,
      });

      assert.ok(result.scenes.length >= 1);
      assert.strictEqual(result.stats.failedSamples, 0);
    });
  });

  describe("Browser Frame Extraction Adapter Guard", () => {
    it("should reject safely when invoked outside browser DOM environment", async () => {
      await assert.rejects(
        () => detectVideoScenes("http://example.com/test.mp4", { duration: 10 }),
        /ENVIRONMENT_UNSUPPORTED/,
      );
    });
  });
});
