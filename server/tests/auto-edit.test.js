import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  probeBuiltInAI,
  getAutoEditLanguage,
  getAutoEditPromptLanguage,
  canRunAutoEdit,
  calculateAutoEditMetrics,
  buildAutoEditReview,
} from "../../src/lib/autoEdit.js";
import { browserProjectFingerprint } from "../../src/lib/browserEditPlan.js";

function createMockProjectSnapshot() {
  return {
    visualSegments: [
      { id: "v1", type: "video", duration: 10.0, sourceStart: 0.0, playbackRate: 1 },
      { id: "v2", type: "video", duration: 8.0, sourceStart: 0.0, playbackRate: 1 },
    ],
    audioSegments: [],
    captionSegments: [
      { id: "cap-outside-1", start: 12.0, end: 15.0, text: "Existing caption on clip 2" },
    ],
    overlaySegments: [],
    stickerSegments: [],
    trackLocks: {
      image: false,
      caption: false,
      source: false,
      audio: false,
    },
    sourceAudioLinked: true,
  };
}

describe("Auto Edit Refactored Core Engine", () => {
  describe("AI Probe & Language Support", () => {
    it("should return immediate availability without requiring Chrome built-in AI", async () => {
      const probeEn = await probeBuiltInAI("en");
      assert.strictEqual(probeEn.availability, "available");
      assert.strictEqual(probeEn.language, "en");

      const probeZh = await probeBuiltInAI("zh");
      assert.strictEqual(probeZh.availability, "available");
      assert.strictEqual(probeZh.language, "zh-CN");
      assert.strictEqual(probeZh.promptLanguage, "zh-CN");
    });

    it("should normalize language codes correctly", () => {
      assert.strictEqual(getAutoEditLanguage("zh"), "zh-CN");
      assert.strictEqual(getAutoEditPromptLanguage("zh"), "zh-CN");
      assert.strictEqual(getAutoEditLanguage("ja"), "ja");
      assert.strictEqual(getAutoEditLanguage("ko"), "ko");
      assert.strictEqual(getAutoEditLanguage("pt"), "pt-BR");
      assert.strictEqual(getAutoEditLanguage("unknown"), "unknown");
      assert.strictEqual(getAutoEditLanguage(), "en");
    });
  });

  describe("canRunAutoEdit", () => {
    it("should allow valid video clip when track is unlocked", () => {
      const clip = { id: "clip-1", type: "video", duration: 12.5, playbackRate: 1 };
      assert.strictEqual(canRunAutoEdit(clip, null, {}), true);
    });

    it("should reject when video track is locked", () => {
      const clip = { id: "clip-1", type: "video", duration: 12.5, playbackRate: 1 };
      assert.strictEqual(canRunAutoEdit(clip, null, { image: true }), false);
    });

    it("should reject image clips or non-positive durations", () => {
      assert.strictEqual(canRunAutoEdit({ id: "c1", type: "image", duration: 5 }), false);
      assert.strictEqual(canRunAutoEdit({ id: "c2", type: "video", duration: 0 }), false);
      assert.strictEqual(canRunAutoEdit(null), false);
    });

    it("should reject clips with transitions or curve modifiers that prevent silence removal", () => {
      const clip = { id: "c2", type: "video", duration: 5, playbackRate: 1 };
      const prevWithFade = { id: "c1", transition: { id: "fade", duration: 1 } };
      assert.strictEqual(canRunAutoEdit(clip, prevWithFade), false);
    });
  });

  describe("calculateAutoEditMetrics", () => {
    it("should handle empty candidates and captions", () => {
      const metrics = calculateAutoEditMetrics(15, [], []);
      assert.strictEqual(metrics.originalDuration, 15);
      assert.strictEqual(metrics.projectedDuration, 15);
      assert.strictEqual(metrics.timeSaved, 0);
      assert.strictEqual(metrics.percentageReduced, 0);
      assert.strictEqual(metrics.enabledCutsCount, 0);
      assert.strictEqual(metrics.captionCount, 0);
    });

    it("should calculate time saved only from enabled cuts and categorize types accurately", () => {
      const candidates = [
        { id: "cut-1", start: 2.0, end: 4.0, type: "pause", enabled: true },
        { id: "cut-2", start: 5.0, end: 6.0, type: "filler", enabled: true },
        { id: "cut-3", start: 7.0, end: 8.5, type: "pause", enabled: false }, // disabled
      ];
      const captions = [
        { id: "cap-1", start: 0.5, end: 1.8, text: "Hello" },
        { id: "cap-2", start: 4.2, end: 4.9, text: "World" },
      ];

      const metrics = calculateAutoEditMetrics(10, candidates, captions);
      assert.strictEqual(metrics.originalDuration, 10);
      // 2s (cut-1) + 1s (cut-2) = 3s saved
      assert.strictEqual(metrics.timeSaved, 3);
      assert.strictEqual(metrics.projectedDuration, 7);
      assert.strictEqual(metrics.percentageReduced, 30);
      assert.strictEqual(metrics.totalCutsCount, 3);
      assert.strictEqual(metrics.enabledCutsCount, 2);
      assert.strictEqual(metrics.pauseCount, 2);
      assert.strictEqual(metrics.fillerCount, 1);
      assert.strictEqual(metrics.captionCount, 2);
    });
  });

  describe("buildAutoEditReview", () => {
    it("should reject if no cuts, captions, or scenes are selected", () => {
      const snapshot = createMockProjectSnapshot();
      const runtime = structuredClone(snapshot);

      assert.throws(
        () => buildAutoEditReview({
          snapshot,
          runtime,
          clipId: "v1",
          approvedCuts: [],
          approvedCaptions: [],
          includeCuts: true,
          includeCaptions: true,
        }),
        (err) => err.code === "autoEditNoSelection"
      );
    });

    it("should reject when image/video track is locked", () => {
      const snapshot = createMockProjectSnapshot();
      snapshot.trackLocks.image = true;
      const runtime = structuredClone(snapshot);

      assert.throws(
        () => buildAutoEditReview({
          snapshot,
          runtime,
          clipId: "v1",
          approvedCuts: [{ id: "c1", start: 2, end: 4, enabled: true }],
          includeCuts: true,
        }),
        (err) => err.code === "autoEditTrackLocked"
      );
    });

    it("should reject when caption track is locked and captions are being applied", () => {
      const snapshot = createMockProjectSnapshot();
      snapshot.trackLocks.caption = true;
      const runtime = structuredClone(snapshot);

      assert.throws(
        () => buildAutoEditReview({
          snapshot,
          runtime,
          clipId: "v1",
          approvedCaptions: [{ id: "cap-1", start: 0, end: 2, text: "Test" }],
          includeCuts: false,
          includeCaptions: true,
        }),
        (err) => err.code === "captionTrackLocked"
      );
    });

    it("should preserve existing timeline captions outside the clip by default", () => {
      const snapshot = createMockProjectSnapshot();
      // v1 is [0s, 10s]. Existing caption is at [12s, 15s] on v2.
      const runtime = structuredClone(snapshot);

      const approvedCaptions = [
        { id: "new-cap-1", start: 1.0, end: 3.0, text: "First segment speech" },
      ];

      const review = buildAutoEditReview({
        snapshot,
        runtime,
        clipId: "v1",
        approvedCaptions,
        includeCuts: false,
        includeCaptions: true,
        preserveCaptions: true,
      });

      assert.strictEqual(review.hasChanges, true);
      assert.strictEqual(review.project.captionSegments.length, 2);
      assert.strictEqual(review.project.captionSegments[0].id, "new-cap-1");
      assert.strictEqual(review.project.captionSegments[0].text, "First segment speech");
      assert.strictEqual(review.project.captionSegments[1].id, "cap-outside-1");
      assert.strictEqual(review.project.captionSegments[1].text, "Existing caption on clip 2");
    });

    it("should overwrite existing timeline captions when preserveCaptions is false", () => {
      const snapshot = createMockProjectSnapshot();
      const runtime = structuredClone(snapshot);

      const approvedCaptions = [
        { id: "new-cap-1", start: 1.0, end: 3.0, text: "Solo caption" },
      ];

      const review = buildAutoEditReview({
        snapshot,
        runtime,
        clipId: "v1",
        approvedCaptions,
        includeCuts: false,
        includeCaptions: true,
        preserveCaptions: false,
      });

      assert.strictEqual(review.project.captionSegments.length, 1);
      assert.strictEqual(review.project.captionSegments[0].id, "new-cap-1");
      assert.strictEqual(review.project.captionSegments[0].text, "Solo caption");
    });

    it("should atomically build cut review with ripple editing and accurate fingerprint", () => {
      const snapshot = createMockProjectSnapshot();
      const runtime = structuredClone(snapshot);

      const approvedCuts = [
        { id: "pause-1", start: 2.0, end: 5.0, enabled: true }, // remove 3 seconds from v1
      ];
      const approvedCaptions = [
        { id: "cap-1", start: 0.5, end: 1.5, text: "Before cut" },
        { id: "cap-2", start: 6.0, end: 8.0, text: "After cut" },
      ];

      const review = buildAutoEditReview({
        snapshot,
        runtime,
        clipId: "v1",
        approvedCuts,
        approvedCaptions,
        rippleEditing: true,
        preserveCaptions: true,
        includeCuts: true,
        includeCaptions: true,
      });

      assert.strictEqual(review.hasChanges, true);
      assert.strictEqual(review.isAutoEdit, true);
      assert.strictEqual(review.appliedCutsCount, 1);
      assert.strictEqual(review.appliedCaptionsCount, 2);

      // Clip v1 (10s) sliced into 2 pieces: [0..2] (2s) and [5..10] (5s) => total 7s
      // Plus v2 (8s) = total duration 15s (was 18s)
      assert.strictEqual(review.duration, 15.0);
      assert.strictEqual(review.project.visualSegments.length, 3);

      // Verify fingerprint matches browserProjectFingerprint for stale plan rejection
      const expectedFingerprint = browserProjectFingerprint(snapshot, true, runtime.visualSegments, runtime);
      assert.strictEqual(review.fingerprint, expectedFingerprint);

      // Verify captions shifted properly:
      // cap-1 (0.5..1.5) was before cut -> unaffected [0.5, 1.5]
      // cap-2 (6.0..8.0) was after 3s cut -> shifted to [3.0, 5.0]
      // cap-outside-1 (12.0..15.0 on v2) -> shifted by 3s cut to [9.0, 12.0]
      const caps = review.project.captionSegments;
      assert.strictEqual(caps.length, 3);
      assert.strictEqual(caps[0].id, "cap-1");
      assert.strictEqual(caps[0].start, 0.5);
      assert.strictEqual(caps[1].id, "cap-2");
      assert.strictEqual(caps[1].start, 3.0);
      assert.strictEqual(caps[2].id, "cap-outside-1");
      assert.strictEqual(caps[2].start, 9.0);
    });

    it("should invalidate fingerprint if timeline snapshot changes (stale plan protection)", () => {
      const snapshot = createMockProjectSnapshot();
      const runtime = structuredClone(snapshot);

      const review = buildAutoEditReview({
        snapshot,
        runtime,
        clipId: "v1",
        approvedCuts: [{ id: "pause-1", start: 2.0, end: 4.0, enabled: true }],
        includeCuts: true,
      });

      // Modify timeline state
      const alteredSnapshot = structuredClone(snapshot);
      alteredSnapshot.visualSegments[0].duration = 12.0;

      const alteredFingerprint = browserProjectFingerprint(
        alteredSnapshot,
        true,
        alteredSnapshot.visualSegments,
        alteredSnapshot
      );

      assert.notStrictEqual(review.fingerprint, alteredFingerprint);
    });
  });
});
