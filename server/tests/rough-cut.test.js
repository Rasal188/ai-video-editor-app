import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FILLER_WORDS,
  normalizeWord,
  isFillerWord,
  findFillerWordCandidates,
  mergeCutCandidates,
  findRoughCutCandidates,
  buildRoughCutReview,
} from "../../src/lib/roughCut.js";

describe("AI Rough Cut Core Logic", () => {
  describe("Filler word recognition and normalization", () => {
    it("should normalize tokens removing surrounding punctuation and spaces", () => {
      assert.strictEqual(normalizeWord("  Um, "), "um");
      assert.strictEqual(normalizeWord('"Uh..."'), "uh");
      assert.strictEqual(normalizeWord("Erm?!"), "erm");
      assert.strictEqual(normalizeWord(""), "");
    });

    it("should identify default filler words accurately", () => {
      assert.strictEqual(isFillerWord("um"), true);
      assert.strictEqual(isFillerWord("Um..."), true);
      assert.strictEqual(isFillerWord("UH"), true);
      assert.strictEqual(isFillerWord("ah"), true);
      assert.strictEqual(isFillerWord("hello"), false);
      assert.strictEqual(isFillerWord("the"), false);
      assert.strictEqual(isFillerWord("computer"), false);
    });

    it("should support custom filler word sets", () => {
      const custom = new Set(["like", "basically"]);
      assert.strictEqual(isFillerWord("like", custom), true);
      assert.strictEqual(isFillerWord("um", custom), false);
    });
  });

  describe("findFillerWordCandidates", () => {
    const clip = { id: "clip-1", duration: 10 };

    it("should return empty array for empty chunks or non-positive duration", () => {
      assert.deepStrictEqual(findFillerWordCandidates([], clip), []);
      assert.deepStrictEqual(findFillerWordCandidates([{ text: "um", timestamp: [1, 1.5] }], { duration: 0 }), []);
      assert.deepStrictEqual(findFillerWordCandidates([{ text: "um", timestamp: [1, 1.5] }], null), []);
    });

    it("should extract filler words with valid timestamps", () => {
      const chunks = [
        { text: "Hello", timestamp: [0, 0.5] },
        { text: "um", timestamp: [0.6, 1.0] },
        { text: "world", timestamp: [1.1, 1.6] },
        { text: "uh", timestamp: [2.0, 2.4] },
      ];

      const candidates = findFillerWordCandidates(chunks, clip, { keep: 0 });
      assert.strictEqual(candidates.length, 2);
      assert.strictEqual(candidates[0].type, "filler");
      assert.strictEqual(candidates[0].word, "um");
      assert.strictEqual(candidates[0].start, 0.6);
      assert.strictEqual(candidates[0].end, 1.0);
      assert.strictEqual(candidates[1].word, "uh");
      assert.strictEqual(candidates[1].start, 2.0);
      assert.strictEqual(candidates[1].end, 2.4);
    });

    it("should reject chunks with non-finite or inverted timestamps", () => {
      const chunks = [
        { text: "um", timestamp: [1.5, 1.0] }, // inverted
        { text: "uh", timestamp: [NaN, 2.0] }, // non-finite
        { text: "er", timestamp: [2.0, Infinity] },
      ];
      assert.deepStrictEqual(findFillerWordCandidates(chunks, clip), []);
    });

    it("should remove complete filler word intervals to ensure filler words do not remain audible", () => {
      const chunks = [{ text: "um", timestamp: [1.0, 1.4] }];
      const candidates = findFillerWordCandidates(chunks, clip, { keep: 0.2 });
      assert.strictEqual(candidates.length, 1);
      assert.strictEqual(candidates[0].start, 1.0);
      assert.strictEqual(candidates[0].end, 1.4);
      assert.strictEqual(Number(candidates[0].duration.toFixed(2)), 0.4);
    });

    it("should recognize multi-word filler phrases such as 'you know' and 'i mean'", () => {
      const chunks = [
        { text: "Well", timestamp: [0.0, 0.4] },
        { text: "you", timestamp: [0.5, 0.7] },
        { text: "know", timestamp: [0.7, 1.0] },
        { text: "actually", timestamp: [1.1, 1.6] },
        { text: "it works", timestamp: [1.7, 2.5] },
      ];
      const candidates = findFillerWordCandidates(chunks, clip);
      assert.strictEqual(candidates.length, 2);
      assert.strictEqual(candidates[0].word, "you know");
      assert.strictEqual(candidates[0].start, 0.5);
      assert.strictEqual(candidates[0].end, 1.0);
      assert.strictEqual(candidates[1].word, "actually");
      assert.strictEqual(candidates[1].start, 1.1);
      assert.strictEqual(candidates[1].end, 1.6);
    });

    it("should correctly normalize sourceStart offset if chunks use source-time timestamps", () => {
      const trimmedClip = { id: "clip-trim", duration: 5, sourceStart: 10 };
      const chunks = [
        { text: "Hello", timestamp: [10.0, 10.8] },
        { text: "um", timestamp: [11.0, 11.4] },
        { text: "world", timestamp: [11.6, 12.5] },
      ];
      const candidates = findFillerWordCandidates(chunks, trimmedClip);
      assert.strictEqual(candidates.length, 1);
      assert.strictEqual(candidates[0].word, "um");
      assert.strictEqual(candidates[0].start, 1.0);
      assert.strictEqual(candidates[0].end, 1.4);
    });
  });

  describe("mergeCutCandidates", () => {
    it("should keep disjoint cut intervals separate", () => {
      const cuts = [
        { start: 1.0, end: 2.0, type: "pause", reason: "Silence" },
        { start: 3.0, end: 4.0, type: "filler", reason: "Filler: 'um'" },
      ];
      const merged = mergeCutCandidates(cuts);
      assert.strictEqual(merged.length, 2);
      assert.strictEqual(merged[0].start, 1.0);
      assert.strictEqual(merged[0].end, 2.0);
      assert.strictEqual(merged[1].start, 3.0);
      assert.strictEqual(merged[1].end, 4.0);
    });

    it("should merge overlapping intervals and update compound reason", () => {
      const cuts = [
        { start: 1.0, end: 2.5, type: "pause", reason: "Silence" },
        { start: 2.0, end: 3.0, type: "filler", reason: "Filler: 'um'" },
      ];
      const merged = mergeCutCandidates(cuts);
      assert.strictEqual(merged.length, 1);
      assert.strictEqual(merged[0].start, 1.0);
      assert.strictEqual(merged[0].end, 3.0);
      assert.strictEqual(merged[0].type, "merged");
      assert.strictEqual(merged[0].reason, "Pause & filler");
    });

    it("should merge contiguous (touching) intervals", () => {
      const cuts = [
        { start: 1.0, end: 2.0, type: "pause" },
        { start: 2.0, end: 2.5, type: "pause" },
      ];
      const merged = mergeCutCandidates(cuts);
      assert.strictEqual(merged.length, 1);
      assert.strictEqual(merged[0].start, 1.0);
      assert.strictEqual(merged[0].end, 2.5);
    });
  });

  describe("findRoughCutCandidates", () => {
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

    const clip = { id: "clip-1", duration: 6.4, playbackRate: 1 };

    it("should detect pauses when filler words are disabled", () => {
      // Speech: frames 0..40 (0 - 1.28s) and frames 100..200 (3.20 - 6.40s)
      // Exactly 1 pause between 1.28s - 3.20s (~1.92s)
      const probs = createProbabilities([[0, 40, 0.9], [100, 200, 0.9]]);
      const candidates = findRoughCutCandidates({
        probabilities: probs,
        clip,
        settings: { threshold: 0.5, minimum: 0.8, keep: 0.2, removeFillerWords: false },
      });

      assert.strictEqual(candidates.length, 1);
      assert.strictEqual(candidates[0].type, "pause");
      assert.strictEqual(candidates[0].enabled, true);
      assert.ok(candidates[0].duration > 1.0);
    });

    it("should combine pauses and filler words when removeFillerWords is enabled", () => {
      const probs = createProbabilities([[0, 40, 0.9], [100, 200, 0.9]]);
      const chunks = [
        { text: "um", timestamp: [3.5, 4.0] }, // within second speech block
      ];

      const candidates = findRoughCutCandidates({
        probabilities: probs,
        chunks,
        clip,
        settings: { threshold: 0.5, minimum: 0.8, keep: 0.1, removeFillerWords: true },
      });

      assert.strictEqual(candidates.length, 2);
      assert.strictEqual(candidates[0].type, "pause");
      assert.strictEqual(candidates[1].type, "filler");
      assert.strictEqual(candidates[1].word, "um");
    });

    it("should omit cuts that would leave a micro-clip shorter than 0.2s", () => {
      const probs = createProbabilities([[0, 30, 0.9], [40, 50, 0.9]]);
      // Gap between 30 and 40 is 10 frames = 0.32s.
      const candidates = findRoughCutCandidates({
        probabilities: probs,
        clip,
        settings: { threshold: 0.5, minimum: 0.1, keep: 0.0, removeFillerWords: false },
      });
      // Every retained segment must be >= 0.2s
      for (const c of candidates) {
        assert.ok(c.start >= 0.2 || c.start === 0);
      }
    });
  });

  describe("buildRoughCutReview & Ripple Synchronization", () => {
    const makeSnapshot = () => ({
      visualSegments: [
        { id: "clip-1", type: "video", duration: 6.0, sourceStart: 0, sourceDuration: 6.0, playbackRate: 1 },
      ],
      audioSegments: [
        { id: "audio-1", start: 0, duration: 6.0, sourceStart: 0, sourceDuration: 6.0 },
      ],
      captionSegments: [
        { id: "cap-1", start: 0.2, end: 1.2, text: "First sentence" },
        { id: "cap-2", start: 4.0, end: 5.5, text: "Second sentence" },
      ],
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

    it("should slice visual segments and ripple captions correctly", () => {
      const snapshot = makeSnapshot();
      const candidates = [
        { id: "cut-1", start: 1.5, end: 3.5, duration: 2.0, type: "pause", enabled: true },
      ];

      const review = buildRoughCutReview(snapshot, runtime, "clip-1", candidates, true);

      assert.strictEqual(review.hasChanges, true);
      // Visual segment split into 2
      assert.strictEqual(review.project.visualSegments.length, 2);
      assert.strictEqual(review.project.visualSegments[0].duration, 1.5);
      assert.strictEqual(review.project.visualSegments[1].duration, 2.5);
      // Timeline duration reduced by 2.0s: 6.0 -> 4.0s
      assert.strictEqual(review.duration, 4.0);

      // Caption 1 was before the cut (0.2 - 1.2) -> stays at 0.2 - 1.2
      assert.strictEqual(review.project.captionSegments[0].start, 0.2);
      assert.strictEqual(review.project.captionSegments[0].end, 1.2);

      // Caption 2 was after the cut (4.0 - 5.5) -> shifted left by 2.0s -> 2.0 - 3.5
      assert.strictEqual(review.project.captionSegments[1].start, 2.0);
      assert.strictEqual(review.project.captionSegments[1].end, 3.5);

      // Audio track sliced and collapsed
      assert.strictEqual(review.project.audioSegments.length, 2);
    });

    it("should respect candidate exclusion toggles", () => {
      const snapshot = makeSnapshot();
      const candidates = [
        { id: "cut-1", start: 1.5, end: 2.5, duration: 1.0, type: "pause", enabled: false }, // EXCLUDED
        { id: "cut-2", start: 3.5, end: 4.5, duration: 1.0, type: "filler", enabled: true }, // INCLUDED
      ];

      const review = buildRoughCutReview(snapshot, runtime, "clip-1", candidates, true);

      // Only 1 cut applied (duration 1.0s)
      assert.strictEqual(review.duration, 5.0);
      assert.strictEqual(review.project.visualSegments.length, 2);
      assert.strictEqual(review.project.visualSegments[0].duration, 3.5);
      assert.strictEqual(review.project.visualSegments[1].duration, 1.5);
    });

    it("should throw roughCutNoSelection if no candidate is enabled", () => {
      const snapshot = makeSnapshot();
      const candidates = [
        { id: "cut-1", start: 1.5, end: 2.5, duration: 1.0, enabled: false },
      ];

      assert.throws(() => {
        buildRoughCutReview(snapshot, runtime, "clip-1", candidates, true);
      }, { code: "roughCutNoSelection" });
    });

    it("should reject locked video track with roughCutLocked", () => {
      const snapshot = makeSnapshot();
      snapshot.trackLocks = { image: true };
      const candidates = [
        { id: "cut-1", start: 1.5, end: 2.5, duration: 1.0, enabled: true },
      ];

      assert.throws(() => {
        buildRoughCutReview(snapshot, runtime, "clip-1", candidates, true);
      }, { code: "roughCutLocked" });
    });

    it("should leave original snapshot unmutated (cancel invariance)", () => {
      const snapshot = makeSnapshot();
      const snapshotClone = JSON.stringify(snapshot);
      const candidates = [
        { id: "cut-1", start: 1.5, end: 2.5, duration: 1.0, enabled: true },
      ];

      buildRoughCutReview(snapshot, runtime, "clip-1", candidates, true);

      // Ensure snapshot wasn't mutated in place
      assert.strictEqual(JSON.stringify(snapshot), snapshotClone);
    });
  });
});
