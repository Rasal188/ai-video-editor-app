import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canRemovePauses,
  findPauseCandidates,
  retainedRanges,
  collapseTime,
  buildSilenceRemovalReview,
} from "../../src/lib/silenceRemoval.js";

describe("Silence Detection & Removal Core Logic", () => {
  describe("canRemovePauses validation", () => {
    it("should accept valid video clip with playbackRate 1 and no offset", () => {
      const clip = { id: "clip-1", type: "video", duration: 10, playbackRate: 1 };
      assert.strictEqual(canRemovePauses(clip), true);
    });

    it("should reject clip with active transition on previous clip", () => {
      const clip = { id: "clip-2", type: "video", duration: 10, playbackRate: 1 };
      const prev = { id: "clip-1", transition: { id: "fade", duration: 0.5 } };
      assert.strictEqual(canRemovePauses(clip, prev), false);
    });

    it("should accept clip when previous transition id is 'none'", () => {
      const clip = { id: "clip-2", type: "video", duration: 10, playbackRate: 1 };
      const prev = { id: "clip-1", transition: { id: "none" } };
      assert.strictEqual(canRemovePauses(clip, prev), true);
    });

    it("should reject clip with non-zero sourceAudioTimelineOffset", () => {
      const clip = { id: "clip-1", type: "video", duration: 10, sourceAudioTimelineOffset: 0.5 };
      assert.strictEqual(canRemovePauses(clip), false);
    });

    it("should reject image clips", () => {
      const clip = { id: "clip-1", type: "image", duration: 5 };
      assert.strictEqual(canRemovePauses(clip), false);
    });

    it("should reject clip with reverse or speed curves", () => {
      const reversedClip = { id: "clip-1", type: "video", duration: 10, reverse: true };
      assert.strictEqual(canRemovePauses(reversedClip), false);
      const curveClip = { id: "clip-2", type: "video", duration: 10, speedCurve: { enabled: true } };
      assert.strictEqual(canRemovePauses(curveClip), false);
    });
  });

  describe("findPauseCandidates", () => {
    // 512 / 16000 = 0.032s per frame. 100 frames = 3.2 seconds.
    const createProbabilities = (spec, totalFrames = 200) => {
      const probs = new Float32Array(totalFrames);
      for (const [startFrame, endFrame, value] of spec) {
        for (let i = startFrame; i < Math.min(totalFrames, endFrame); i++) {
          probs[i] = value;
        }
      }
      return probs;
    };

    it("should return empty array for empty probabilities or non-positive duration", () => {
      assert.deepStrictEqual(findPauseCandidates(new Float32Array(0), { duration: 5 }), []);
      assert.deepStrictEqual(findPauseCandidates(null, { duration: 5 }), []);
      assert.deepStrictEqual(findPauseCandidates(new Float32Array(100), { duration: 0 }), []);
      assert.deepStrictEqual(findPauseCandidates(new Float32Array(100), { duration: -2 }), []);
    });

    it("should return empty array for pure silence without speech", () => {
      // All 0s: no speech range >= 0.1s
      const probs = new Float32Array(150);
      const candidates = findPauseCandidates(probs, { duration: 4.8 });
      assert.strictEqual(candidates.length, 0);
    });

    it("should detect pause between two speech intervals", () => {
      // 0.0s to 1.0s (frames 0-31): speech (prob 0.9)
      // 1.0s to 3.0s (frames 32-93): silence (prob 0.05) -> 2.0s pause
      // 3.0s to 4.5s (frames 94-140): speech (prob 0.9)
      // 4.5s to 5.0s (frames 141-156): end
      const probs = createProbabilities([
        [0, 31, 0.9],
        [32, 93, 0.05],
        [94, 140, 0.9],
      ], 160);

      const clip = { duration: 5.0, playbackRate: 1 };
      const candidates = findPauseCandidates(probs, clip, {
        threshold: 0.5,
        minimum: 0.8,
        keep: 0.4,
      });

      assert.strictEqual(candidates.length, 1);
      const cut = candidates[0];
      assert.strictEqual(cut.enabled, true);
      assert.strictEqual(cut.id, "pause-0");
      // Gap was ~1.0s to ~3.0s. With keep = 0.4, padding is 0.2s on each side:
      // cut.start ~= 1.2s, cut.end ~= 2.8s
      assert.ok(cut.start >= 1.0 && cut.start <= 1.4, `Cut start ${cut.start} should be near 1.2s`);
      assert.ok(cut.end >= 2.6 && cut.end <= 3.1, `Cut end ${cut.end} should be near 2.8s`);
      assert.ok(cut.end > cut.start);
    });

    it("should filter out pauses shorter than the minimum duration", () => {
      // Speech -> 0.5s pause -> Speech to end. With minimum = 0.8, this pause should be ignored.
      const probs = createProbabilities([
        [0, 31, 0.9],
        [32, 47, 0.05], // ~0.5s pause
        [48, 125, 0.9], // speech runs to end of 4.0s clip
      ], 125);

      const clip = { duration: 4.0, playbackRate: 1 };
      const candidates = findPauseCandidates(probs, clip, { minimum: 0.8 });
      assert.strictEqual(candidates.length, 0);

      // But with minimum = 0.4, it should be detected!
      const candidatesShort = findPauseCandidates(probs, clip, { minimum: 0.4, keep: 0.1 });
      assert.strictEqual(candidatesShort.length, 1);
    });

    it("should respect threshold setting to distinguish speech from noise", () => {
      // Speech with medium probability (0.4)
      const probs = createProbabilities([
        [0, 31, 0.4],
        [32, 93, 0.05],
        [94, 140, 0.4],
      ], 160);

      const clip = { duration: 5.0 };
      // With threshold = 0.6: 0.4 is below threshold -> no speech detected -> 0 candidates
      const highThresh = findPauseCandidates(probs, clip, { threshold: 0.6 });
      assert.strictEqual(highThresh.length, 0);

      // With threshold = 0.35: 0.4 is above threshold -> speech detected -> pause candidate found!
      const lowThresh = findPauseCandidates(probs, clip, { threshold: 0.35, minimum: 0.8 });
      assert.strictEqual(lowThresh.length, 1);
    });

    it("should adjust boundaries based on keep padding", () => {
      const probs = createProbabilities([
        [0, 31, 0.9],
        [32, 93, 0.05],
        [94, 140, 0.9],
      ], 160);

      const clip = { duration: 5.0 };
      const tighter = findPauseCandidates(probs, clip, { keep: 0.1 });
      const padded = findPauseCandidates(probs, clip, { keep: 0.6 });

      assert.strictEqual(tighter.length, 1);
      assert.strictEqual(padded.length, 1);

      // Tighter padding keeps less gap, removing MORE silence (wider cut duration)
      const tighterDuration = tighter[0].end - tighter[0].start;
      const paddedDuration = padded[0].end - padded[0].start;
      assert.ok(tighterDuration > paddedDuration, "Tighter padding should yield longer cut duration");
    });
  });

  describe("retainedRanges and collapseTime", () => {
    it("should compute retained ranges between cuts", () => {
      const cuts = [
        { start: 2.0, end: 3.5 },
        { start: 6.0, end: 7.0 },
      ];
      const ranges = retainedRanges(0.0, 10.0, cuts);
      assert.deepStrictEqual(ranges, [
        { start: 0.0, end: 2.0 },
        { start: 3.5, end: 6.0 },
        { start: 7.0, end: 10.0 },
      ]);
    });

    it("should collapse time correctly based on earlier cuts", () => {
      const cuts = [
        { start: 2.0, end: 4.0 }, // 2s removed
        { start: 6.0, end: 7.5 }, // 1.5s removed
      ];
      assert.strictEqual(collapseTime(1.0, cuts), 1.0); // before cut
      assert.strictEqual(collapseTime(3.0, cuts), 2.0); // inside first cut
      assert.strictEqual(collapseTime(5.0, cuts), 3.0); // after first cut: 5 - 2 = 3
      assert.strictEqual(collapseTime(8.0, cuts), 4.5); // after both cuts: 8 - (2 + 1.5) = 4.5
    });
  });

  describe("buildSilenceRemovalReview", () => {
    const createProjectSnapshot = () => ({
      version: 1,
      visualSegments: [
        { id: "v1", type: "video", duration: 10.0, sourceStart: 0, sourceDuration: 10.0, playbackRate: 1 },
      ],
      audioSegments: [
        { id: "a1", start: 0.0, duration: 10.0, sourceStart: 0, sourceDuration: 10.0 },
      ],
      captionSegments: [
        { id: "c1", start: 0.5, end: 1.8, text: "Welcome to editor" },
        { id: "c2", start: 4.5, end: 6.0, text: "Second sentence" },
        { id: "c3", start: 7.5, end: 9.0, text: "Final remarks" },
      ],
      visualOverlaySegments: [
        { id: "o1", start: 4.0, duration: 3.0, type: "video", playbackRate: 1 },
      ],
      stickerSegments: [],
      trackLocks: {},
    });

    it("should slice visual segment and shift timeline duration on ripple edit", () => {
      const snapshot = createProjectSnapshot();
      const runtime = structuredClone(snapshot);
      const candidates = [
        { id: "pause-0", start: 2.0, end: 4.0, enabled: true }, // remove 2s
      ];

      const review = buildSilenceRemovalReview(snapshot, runtime, "v1", candidates, true);
      assert.strictEqual(review.hasChanges, true);
      assert.strictEqual(review.project.visualSegments.length, 2);

      const piece1 = review.project.visualSegments[0];
      const piece2 = review.project.visualSegments[1];

      assert.strictEqual(piece1.duration, 2.0);
      assert.strictEqual(piece1.sourceStart, 0.0);
      assert.strictEqual(piece2.duration, 6.0);
      assert.strictEqual(piece2.sourceStart, 4.0);

      // Total new duration is 8.0s (10.0 - 2.0)
      assert.strictEqual(review.duration, 8.0);

      // Verify captions synchronization after ripple edit:
      // c1 was [0.5, 1.8] -> before cut -> remains [0.5, 1.8]
      // c2 was [4.5, 6.0] -> after 2s cut -> collapses to [2.5, 4.0]
      // c3 was [7.5, 9.0] -> collapses to [5.5, 7.0]
      const caps = review.project.captionSegments;
      assert.strictEqual(caps.length, 3);
      assert.strictEqual(caps[0].start, 0.5);
      assert.strictEqual(caps[0].end, 1.8);
      assert.strictEqual(caps[1].start, 2.5);
      assert.strictEqual(caps[1].end, 4.0);
      assert.strictEqual(caps[2].start, 5.5);
      assert.strictEqual(caps[2].end, 7.0);

      // Script matches joined captions
      assert.strictEqual(review.project.script, "Welcome to editor\nSecond sentence\nFinal remarks");
    });

    it("should respect excluded candidate intervals", () => {
      const snapshot = createProjectSnapshot();
      const runtime = structuredClone(snapshot);
      const candidates = [
        { id: "pause-0", start: 2.0, end: 4.0, enabled: false }, // Excluded!
        { id: "pause-1", start: 6.0, end: 7.0, enabled: true },  // 1s cut
      ];

      const review = buildSilenceRemovalReview(snapshot, runtime, "v1", candidates, true);
      assert.strictEqual(review.duration, 9.0); // 10.0 - 1.0 = 9.0s
      assert.strictEqual(review.project.visualSegments.length, 2);
    });

    it("should throw pauseNoSelection if no candidate is enabled", () => {
      const snapshot = createProjectSnapshot();
      const runtime = structuredClone(snapshot);
      const candidates = [
        { id: "pause-0", start: 2.0, end: 4.0, enabled: false },
      ];

      assert.throws(
        () => buildSilenceRemovalReview(snapshot, runtime, "v1", candidates, true),
        (err) => err.code === "pauseNoSelection"
      );
    });

    it("should reject locked video track with pauseLocked", () => {
      const snapshot = createProjectSnapshot();
      snapshot.trackLocks = { image: true };
      const runtime = structuredClone(snapshot);
      const candidates = [
        { id: "pause-0", start: 2.0, end: 4.0, enabled: true },
      ];

      assert.throws(
        () => buildSilenceRemovalReview(snapshot, runtime, "v1", candidates, true),
        (err) => err.code === "pauseLocked"
      );
    });
  });
});
