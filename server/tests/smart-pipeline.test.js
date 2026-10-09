import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createSmartPipelinePlan,
  buildSmartPipelineReview,
  calculatePipelineMetrics,
  canRemovePauses,
} from "../../src/lib/smartPipeline.js";

describe("Smart Editing Pipeline Core Logic", () => {
  describe("calculatePipelineMetrics", () => {
    it("should compute correct metrics for empty candidates", () => {
      const metrics = calculatePipelineMetrics(10, []);
      assert.strictEqual(metrics.originalDuration, 10);
      assert.strictEqual(metrics.projectedDuration, 10);
      assert.strictEqual(metrics.timeSaved, 0);
      assert.strictEqual(metrics.percentageReduced, 0);
      assert.strictEqual(metrics.enabledCutsCount, 0);
    });

    it("should calculate time saved and percentage reduction accurately", () => {
      const candidates = [
        { id: "c1", start: 2, end: 4, type: "pause", enabled: true },
        { id: "c2", start: 6, end: 7, type: "filler", enabled: true },
        { id: "c3", start: 8, end: 9, type: "pause", enabled: false }, // Excluded
      ];
      const captions = [{ id: "cap1", start: 0, end: 2, text: "Hi" }];
      const metrics = calculatePipelineMetrics(10, candidates, captions);

      assert.strictEqual(metrics.originalDuration, 10);
      // 2s from c1 + 1s from c2 = 3s saved
      assert.strictEqual(metrics.timeSaved, 3);
      assert.strictEqual(metrics.projectedDuration, 7);
      assert.strictEqual(metrics.percentageReduced, 30);
      assert.strictEqual(metrics.totalCutsCount, 3);
      assert.strictEqual(metrics.enabledCutsCount, 2);
      assert.strictEqual(metrics.pauseCount, 2);
      assert.strictEqual(metrics.fillerCount, 1);
      assert.strictEqual(metrics.captionCount, 1);
    });
  });

  describe("createSmartPipelinePlan", () => {
    const clip = { id: "clip-1", duration: 8.0, name: "TestClip.mp4" };
    // 8 seconds total. Probabilities at 16kHz with 512 frame step = 0.032s per step
    // 250 steps for 8 seconds.
    // 0 to 1.5s: speech (0.9)
    // 1.5 to 3.5s: silence (0.05) -> 2.0s pause candidate
    // 3.5 to 5.0s: speech (0.9)
    // 5.0 to 6.5s: silence (0.05) -> 1.5s pause candidate
    // 6.5 to 8.0s: speech (0.9)
    const probs = new Float32Array(250);
    for (let i = 0; i < 250; i++) {
      const t = i * 0.032;
      if (t < 1.5 || (t >= 3.5 && t < 5.0) || t >= 6.5) {
        probs[i] = 0.9;
      } else {
        probs[i] = 0.05;
      }
    }

    const transcriptResult = {
      segments: [
        { id: "s1", start: 0.2, end: 1.2, text: "Welcome to the editor" },
        { id: "s2", start: 3.6, end: 4.8, text: "Let's check the cuts" },
        { id: "s3", start: 6.6, end: 7.8, text: "All done now" },
      ],
      rawChunks: [
        { text: "Welcome", timestamp: [0.2, 0.6] },
        { text: "to", timestamp: [0.6, 0.8] },
        { text: "the", timestamp: [0.8, 1.0] },
        { text: "editor", timestamp: [1.0, 1.2] },
        { text: "um", timestamp: [3.5, 3.6] },
      ],
      text: "Welcome to the editor\nLet's check the cuts\nAll done now",
    };

    it("should build a valid pipeline plan with cuts and captions", () => {
      const plan = createSmartPipelinePlan({
        clip,
        probabilities: probs,
        transcriptResult,
        settings: {
          threshold: 0.5,
          minimum: 0.8,
          keep: 0.3,
          removeFillerWords: true,
        },
      });

      assert.strictEqual(plan.clip.id, "clip-1");
      assert.ok(Array.isArray(plan.candidates));
      assert.ok(plan.candidates.length > 0);
      assert.strictEqual(plan.captionSegments.length, 3);
      assert.ok(plan.metrics.timeSaved > 0);
      assert.ok(plan.metrics.projectedDuration < 8.0);
    });

    it("should reject clips with non-positive duration", () => {
      assert.throws(() => {
        createSmartPipelinePlan({
          clip: { id: "bad", duration: 0 },
          probabilities: probs,
        });
      }, { code: "pipelineClipUnsupported" });
    });
  });

  describe("buildSmartPipelineReview", () => {
    const makeSnapshot = () => ({
      visualSegments: [
        { id: "clip-1", type: "video", duration: 6.0, sourceStart: 0, sourceDuration: 6.0, playbackRate: 1 },
      ],
      audioSegments: [
        { id: "aud-1", start: 0, duration: 6.0, sourceStart: 0, sourceDuration: 6.0, playbackRate: 1 },
      ],
      captionSegments: [],
      visualOverlaySegments: [],
      stickerSegments: [],
      musicSegments: [],
      trackLocks: {},
    });

    const runtime = {
      visualSegments: [
        { id: "clip-1", type: "video", duration: 6.0, playbackRate: 1 },
      ],
    };

    it("should synchronously apply cuts and align captions in one atomic review", () => {
      const snapshot = makeSnapshot();
      const approvedCuts = [
        { id: "cut-1", start: 1.5, end: 3.5, duration: 2.0, type: "pause", enabled: true },
      ];
      const approvedCaptions = [
        { id: "cap-1", start: 0.2, end: 1.2, text: "Before cut" },
        { id: "cap-2", start: 4.0, end: 5.5, text: "After cut" },
      ];

      const review = buildSmartPipelineReview({
        snapshot,
        runtime,
        clipId: "clip-1",
        approvedCuts,
        approvedCaptions,
        rippleEditing: true,
        includeCaptions: true,
        includeCuts: true,
      });

      assert.strictEqual(review.hasChanges, true);
      assert.strictEqual(review.isSmartPipeline, true);
      assert.strictEqual(review.appliedCutsCount, 1);
      assert.strictEqual(review.appliedCaptionsCount, 2);

      // Duration: 6.0s - 2.0s = 4.0s
      assert.strictEqual(review.duration, 4.0);
      assert.strictEqual(review.project.visualSegments.length, 2);

      // Captions: cap-1 (before cut) unchanged at 0.2-1.2
      assert.strictEqual(review.project.captionSegments[0].start, 0.2);
      assert.strictEqual(review.project.captionSegments[0].end, 1.2);
      assert.strictEqual(review.project.captionSegments[0].text, "Before cut");

      // Caption 2: originally 4.0-5.5, shifted left by 2.0s cut -> 2.0-3.5
      assert.strictEqual(review.project.captionSegments[1].start, 2.0);
      assert.strictEqual(review.project.captionSegments[1].end, 3.5);
      assert.strictEqual(review.project.captionSegments[1].text, "After cut");

      // Audio track sliced and collapsed
      assert.strictEqual(review.project.audioSegments.length, 2);
    });

    it("should allow applying only captions when cuts are unselected", () => {
      const snapshot = makeSnapshot();
      const approvedCaptions = [
        { id: "cap-1", start: 1.0, end: 3.0, text: "Captions only" },
      ];

      const review = buildSmartPipelineReview({
        snapshot,
        runtime,
        clipId: "clip-1",
        approvedCuts: [],
        approvedCaptions,
        rippleEditing: true,
        includeCaptions: true,
        includeCuts: false,
      });

      assert.strictEqual(review.hasChanges, true);
      assert.strictEqual(review.appliedCutsCount, 0);
      assert.strictEqual(review.appliedCaptionsCount, 1);
      // Visual segment duration untouched
      assert.strictEqual(review.duration, 6.0);
      assert.strictEqual(review.project.visualSegments.length, 1);
      // Caption added
      assert.strictEqual(review.project.captionSegments.length, 1);
      assert.strictEqual(review.project.captionSegments[0].text, "Captions only");
    });

    it("should allow applying only cuts when captions are unselected", () => {
      const snapshot = makeSnapshot();
      const approvedCuts = [
        { id: "cut-1", start: 2.0, end: 3.0, duration: 1.0, type: "pause", enabled: true },
      ];

      const review = buildSmartPipelineReview({
        snapshot,
        runtime,
        clipId: "clip-1",
        approvedCuts,
        approvedCaptions: [{ id: "c1", start: 0, end: 1, text: "Omitted" }],
        rippleEditing: true,
        includeCaptions: false, // EXCLUDED
        includeCuts: true,
      });

      assert.strictEqual(review.hasChanges, true);
      assert.strictEqual(review.appliedCutsCount, 1);
      assert.strictEqual(review.appliedCaptionsCount, 0);
      assert.strictEqual(review.duration, 5.0);
      assert.strictEqual(review.project.captionSegments.length, 0);
    });

    it("should respect candidate exclusion toggles", () => {
      const snapshot = makeSnapshot();
      const approvedCuts = [
        { id: "cut-1", start: 1.0, end: 2.0, duration: 1.0, enabled: false }, // Excluded
        { id: "cut-2", start: 3.0, end: 4.0, duration: 1.0, enabled: true }, // Included
      ];

      const review = buildSmartPipelineReview({
        snapshot,
        runtime,
        clipId: "clip-1",
        approvedCuts,
        approvedCaptions: [],
        rippleEditing: true,
        includeCaptions: false,
        includeCuts: true,
      });

      // Only 1 cut applied (1.0s removed: 6.0 -> 5.0s)
      assert.strictEqual(review.duration, 5.0);
      assert.strictEqual(review.appliedCutsCount, 1);
      assert.strictEqual(review.project.visualSegments.length, 2);
    });

    it("should throw pipelineNoSelection if neither cuts nor captions are approved", () => {
      const snapshot = makeSnapshot();
      assert.throws(() => {
        buildSmartPipelineReview({
          snapshot,
          runtime,
          clipId: "clip-1",
          approvedCuts: [],
          approvedCaptions: [],
          includeCaptions: false,
          includeCuts: false,
        });
      }, { code: "pipelineNoSelection" });
    });

    it("should throw pipelineLocked if visual track is locked", () => {
      const snapshot = makeSnapshot();
      snapshot.trackLocks = { image: true };
      assert.throws(() => {
        buildSmartPipelineReview({
          snapshot,
          runtime,
          clipId: "clip-1",
          approvedCuts: [{ id: "c1", start: 1, end: 2, enabled: true }],
        });
      }, { code: "pipelineLocked" });
    });

    it("should leave the input snapshot completely unmutated", () => {
      const snapshot = makeSnapshot();
      const snapshotJson = JSON.stringify(snapshot);
      const approvedCuts = [
        { id: "cut-1", start: 1.5, end: 2.5, duration: 1.0, enabled: true },
      ];

      buildSmartPipelineReview({
        snapshot,
        runtime,
        clipId: "clip-1",
        approvedCuts,
        approvedCaptions: [{ id: "cap-1", start: 0, end: 1, text: "Hi" }],
      });

      assert.strictEqual(JSON.stringify(snapshot), snapshotJson);
    });
  });
});
