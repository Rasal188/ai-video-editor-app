import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  getActiveWordIndex,
  isKaraokeEnabled,
  resolveActiveWordColor,
  splitLineIntoWordChunks,
} from "../../src/lib/karaoke.js";
import {
  getSegmentIndexAtTime,
  getCaptionTimeline,
} from "../../src/lib/timeline.js";
import {
  buildSmartPipelineReview,
  createSmartPipelinePlan,
} from "../../src/lib/smartPipeline.js";
import { applyTimelineRipple } from "../../src/lib/timelineRipple.js";
import { buildSilenceRemovalReview } from "../../src/lib/silenceRemoval.js";

function createOfflineFramePlan(duration, frameRate = 30) {
  const fps = Math.max(24, Math.min(60, Math.round(Number(frameRate) || 30)));
  const safeDuration = Math.max(1 / fps, Number(duration) || 0);
  const frameCount = Math.max(1, Math.ceil(safeDuration * fps));
  return Array.from({ length: frameCount }, (_, index) => ({
    index,
    timestamp: index / fps,
    duration: 1 / fps,
  }));
}

const fixturePath = [
  resolve(process.cwd(), "server", "tests", "fixtures", "real-inference-result.json"),
  resolve(process.cwd(), "test-artifacts", "transcription-e2e", "real-inference-result.json"),
].find((p) => existsSync(p));

const realInference = JSON.parse(readFileSync(fixturePath, "utf-8"));

describe("Karaoke Caption Timing / Audio Synchronization Regression Suite", () => {
  // Use real Whisper output words from real-inference-result.json:
  // "What if someone on" [0, 0.82]
  // "your network could read" [0.82, 1.60]
  // "you password while it" [1.60, 2.50]
  // "travels to a website?" [2.50, 3.36]
  const genuineSegments = realInference.segments.map((seg) => {
    const segWords = realInference.words.filter(
      (w) => w.start >= seg.start - 0.001 && w.end <= seg.end + 0.001
    );
    return {
      ...seg,
      words: segWords,
    };
  });

  describe("1. Word Start and End Boundaries with Sub-Millisecond Precision", () => {
    const segment = genuineSegments[0]; // "What" [0, 0.3], "if" [0.3, 0.38], "someone" [0.38, 0.64], "on" [0.64, 0.82]

    it("evaluates exact word starts correctly", () => {
      // Exactly at start of each word
      assert.equal(getActiveWordIndex(segment.words, 0.0, segment), 0, "t=0.0 -> 'What'");
      assert.equal(getActiveWordIndex(segment.words, 0.3, segment), 1, "t=0.3 -> 'if'");
      assert.equal(getActiveWordIndex(segment.words, 0.38, segment), 2, "t=0.38 -> 'someone'");
      assert.equal(getActiveWordIndex(segment.words, 0.64, segment), 3, "t=0.64 -> 'on'");
    });

    it("evaluates interior word times correctly", () => {
      assert.equal(getActiveWordIndex(segment.words, 0.15, segment), 0, "t=0.15 -> 'What'");
      assert.equal(getActiveWordIndex(segment.words, 0.34, segment), 1, "t=0.34 -> 'if'");
      assert.equal(getActiveWordIndex(segment.words, 0.50, segment), 2, "t=0.50 -> 'someone'");
      assert.equal(getActiveWordIndex(segment.words, 0.73, segment), 3, "t=0.73 -> 'on'");
    });

    it("evaluates exact word end boundaries as half-open [start, end)", () => {
      // At 0.30, word 0 ends and word 1 starts -> word 1 must be active
      assert.equal(getActiveWordIndex(segment.words, 0.299, segment), 0);
      assert.equal(getActiveWordIndex(segment.words, 0.30, segment), 1);

      // At 0.38, word 1 ends and word 2 starts -> word 2 must be active
      assert.equal(getActiveWordIndex(segment.words, 0.379, segment), 1);
      assert.equal(getActiveWordIndex(segment.words, 0.38, segment), 2);

      // At 0.82, word 3 ends and segment ends -> no word active
      assert.equal(getActiveWordIndex(segment.words, 0.819, segment), 3);
      assert.equal(getActiveWordIndex(segment.words, 0.82, segment), -1);
    });
  });

  describe("2. Caption Segments Starting at Nonzero Times & Later on Timeline", () => {
    // Nonzero segment: e.g. clip placed at timeline t = 5.0s
    const clipOffset = 5.0;
    const shiftedSegments = genuineSegments.map((seg) => ({
      ...seg,
      start: seg.start + clipOffset,
      end: seg.end + clipOffset,
      words: seg.words.map((w) => ({
        ...w,
        start: w.start + clipOffset,
        end: w.end + clipOffset,
      })),
    }));

    it("identifies correct active segment at timeline offset", () => {
      // Segment 0: [5.0, 5.82]
      assert.equal(getSegmentIndexAtTime(shiftedSegments, 4.99), -1);
      assert.equal(getSegmentIndexAtTime(shiftedSegments, 5.0), 0);
      assert.equal(getSegmentIndexAtTime(shiftedSegments, 5.5), 0);
      // Segment 1: [5.82, 6.60]
      assert.equal(getSegmentIndexAtTime(shiftedSegments, 5.82), 1);
      assert.equal(getSegmentIndexAtTime(shiftedSegments, 6.20), 1);
      // Segment 2: [6.60, 7.50]
      assert.equal(getSegmentIndexAtTime(shiftedSegments, 6.60), 2);
    });

    it("identifies correct active word within shifted segment", () => {
      const seg0 = shiftedSegments[0]; // "What" [5.0, 5.3], "if" [5.3, 5.38], "someone" [5.38, 5.64], "on" [5.64, 5.82]
      assert.equal(getActiveWordIndex(seg0.words, 5.15, seg0), 0, "t=5.15 -> 'What'");
      assert.equal(getActiveWordIndex(seg0.words, 5.50, seg0), 2, "t=5.50 -> 'someone'");

      const seg2 = shiftedSegments[2]; // "you password while it" [6.60, 7.50]
      // "you" [6.60, 6.72], "password" [6.72, 7.02], "while" [7.02, 7.34], "it" [7.34, 7.50]
      assert.equal(getActiveWordIndex(seg2.words, 6.85, seg2), 1, "t=6.85 -> 'password'");
      assert.equal(getActiveWordIndex(seg2.words, 7.15, seg2), 2, "t=7.15 -> 'while'");
    });

    it("handles segment-relative word representation transparently", () => {
      // Word timestamps are 0-based relative to segment.start
      const relSeg = {
        id: "rel-seg",
        start: 10.0,
        end: 12.0,
        words: [
          { text: "hello", start: 0.0, end: 0.8 },
          { text: "world", start: 0.8, end: 1.5 },
        ],
      };
      assert.equal(getActiveWordIndex(relSeg.words, 9.9, relSeg), -1);
      assert.equal(getActiveWordIndex(relSeg.words, 10.4, relSeg), 0, "t=10.4 -> 'hello'");
      assert.equal(getActiveWordIndex(relSeg.words, 11.2, relSeg), 1, "t=11.2 -> 'world'");
      assert.equal(getActiveWordIndex(relSeg.words, 11.9, relSeg), -1);
    });
  });

  describe("3. Consecutive Caption Segments Boundary Handover", () => {
    // Seg 0 ends at 0.82, Seg 1 starts at 0.82
    // Seg 1 ends at 1.60, Seg 2 starts at 1.60
    // Seg 2 ends at 2.50, Seg 3 starts at 2.50
    it("transitions cleanly at exact segment boundary timestamps without gaps", () => {
      // At 0.819s: Seg 0 is active
      const idxBefore = getSegmentIndexAtTime(genuineSegments, 0.819);
      assert.equal(idxBefore, 0);

      // At 0.820s: Seg 1 is active, and its first word ('your' [0.82, 0.94]) is active
      const idxAt = getSegmentIndexAtTime(genuineSegments, 0.82);
      assert.equal(idxAt, 1);
      const activeWord = getActiveWordIndex(genuineSegments[1].words, 0.82, genuineSegments[1]);
      assert.equal(activeWord, 0, "Word 0 ('your') must be active at boundary start");

      // At 1.600s: Seg 2 is active, and its first word ('you' [1.60, 1.72]) is active
      const idxAt2 = getSegmentIndexAtTime(genuineSegments, 1.60);
      assert.equal(idxAt2, 2);
      const activeWord2 = getActiveWordIndex(genuineSegments[2].words, 1.60, genuineSegments[2]);
      assert.equal(activeWord2, 0, "Word 0 ('you') must be active at boundary start");

      // At 2.500s: Seg 3 is active, and its first word ('travels' [2.50, 2.74]) is active
      const idxAt3 = getSegmentIndexAtTime(genuineSegments, 2.50);
      assert.equal(idxAt3, 3);
      const activeWord3 = getActiveWordIndex(genuineSegments[3].words, 2.50, genuineSegments[3]);
      assert.equal(activeWord3, 0, "Word 0 ('travels') must be active at boundary start");
    });
  });

  describe("4. Seeking Forward, Backward, Pause and Resume (Time Invariance)", () => {
    it("returns identical active word regardless of seek direction or pause state", () => {
      const times = [0.15, 0.50, 1.10, 1.85, 2.15, 2.60, 3.20];
      const expectedWords = [
        { segIdx: 0, wordIdx: 0, text: "What" },
        { segIdx: 0, wordIdx: 2, text: "someone" },
        { segIdx: 1, wordIdx: 1, text: "network" },
        { segIdx: 2, wordIdx: 1, text: "password" },
        { segIdx: 2, wordIdx: 2, text: "while" },
        { segIdx: 3, wordIdx: 0, text: "travels" },
        { segIdx: 3, wordIdx: 3, text: "website?" },
      ];

      // Forward sweep
      for (let i = 0; i < times.length; i++) {
        const t = times[i];
        const segIdx = getSegmentIndexAtTime(genuineSegments, t);
        assert.equal(segIdx, expectedWords[i].segIdx);
        const wIdx = getActiveWordIndex(genuineSegments[segIdx].words, t, genuineSegments[segIdx]);
        assert.equal(wIdx, expectedWords[i].wordIdx);
        assert.equal(genuineSegments[segIdx].words[wIdx].text, expectedWords[i].text);
      }

      // Backward sweep (seeking backwards)
      for (let i = times.length - 1; i >= 0; i--) {
        const t = times[i];
        const segIdx = getSegmentIndexAtTime(genuineSegments, t);
        assert.equal(segIdx, expectedWords[i].segIdx);
        const wIdx = getActiveWordIndex(genuineSegments[segIdx].words, t, genuineSegments[segIdx]);
        assert.equal(wIdx, expectedWords[i].wordIdx);
        assert.equal(genuineSegments[segIdx].words[wIdx].text, expectedWords[i].text);
      }

      // Random access seeks
      const randomIndices = [4, 1, 6, 0, 3, 5, 2];
      for (const idx of randomIndices) {
        const t = times[idx];
        const segIdx = getSegmentIndexAtTime(genuineSegments, t);
        assert.equal(segIdx, expectedWords[idx].segIdx);
        const wIdx = getActiveWordIndex(genuineSegments[segIdx].words, t, genuineSegments[segIdx]);
        assert.equal(wIdx, expectedWords[idx].wordIdx);
        assert.equal(genuineSegments[segIdx].words[wIdx].text, expectedWords[idx].text);
      }
    });
  });

  describe("5. Offline Video Export Frame Timestamps Synchronization", () => {
    it("evaluates captions against exact exported frame timestamps at 30 fps", () => {
      const fps = 30;
      const duration = 3.57;
      const frames = createOfflineFramePlan(duration, fps);
      assert.equal(frames.length, Math.ceil(duration * fps));

      // Check frame timestamp progression
      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        const expectedTime = i / fps;
        assert.ok(Math.abs(frame.timestamp - expectedTime) < 1e-6);

        // Active segment and word at this frame timestamp
        const segIdx = getSegmentIndexAtTime(genuineSegments, frame.timestamp);
        if (segIdx >= 0) {
          const seg = genuineSegments[segIdx];
          const wIdx = getActiveWordIndex(seg.words, frame.timestamp, seg);
          if (wIdx >= 0) {
            const word = seg.words[wIdx];
            assert.ok(
              frame.timestamp >= word.start && frame.timestamp < word.end,
              `Frame ${i} (t=${frame.timestamp.toFixed(4)}) word '${word.text}' [${word.start}, ${word.end}) must cover timestamp`
            );
          }
        }
      }
    });

    it("verifies key speech frame timestamps match genuine audio spoken words", () => {
      // Audio peak checkpoints:
      // t=0.15s: "What" (word 0)
      // t=0.50s: "someone" (word 2)
      // t=1.10s: "network" (word 5 -> seg 1 word 1)
      // t=1.85s: "password" (word 9 -> seg 2 word 1)
      // t=2.15s: "while" (word 10 -> seg 2 word 2)
      // t=2.60s: "travels" (word 12 -> seg 3 word 0)
      // t=3.20s: "website?" (word 15 -> seg 3 word 3)
      const checkpoints = [
        { time: 0.15, expectedText: "What" },
        { time: 0.50, expectedText: "someone" },
        { time: 1.10, expectedText: "network" },
        { time: 1.85, expectedText: "password" },
        { time: 2.15, expectedText: "while" },
        { time: 2.60, expectedText: "travels" },
        { time: 3.20, expectedText: "website?" },
      ];

      for (const cp of checkpoints) {
        const segIdx = getSegmentIndexAtTime(genuineSegments, cp.time);
        assert.ok(segIdx >= 0, `Segment must be found for t=${cp.time}`);
        const seg = genuineSegments[segIdx];
        const wIdx = getActiveWordIndex(seg.words, cp.time, seg);
        assert.ok(wIdx >= 0, `Active word must be found for t=${cp.time}`);
        assert.equal(seg.words[wIdx].text, cp.expectedText);
      }
    });
  });

  describe("6. Smart Pipeline and Single-Offset Enforcement", () => {
    it("does not apply clipStartOffset twice when captions already have timeline offset", () => {
      const clipStartOffset = 4.0;
      const clipDuration = 4.0;
      const snapshot = {
        captionSegments: [],
        visualSegments: [
          { id: "clip-0", duration: clipStartOffset, type: "video" },
          { id: "clip-1", duration: clipDuration, type: "video" },
        ],
        trackLocks: {},
      };
      const runtime = {
        visualSegments: snapshot.visualSegments,
      };

      // Captions that ALREADY possess timeline offset [4.0, 7.36]
      const timelineCaptions = genuineSegments.map((seg) => ({
        ...seg,
        start: seg.start + clipStartOffset,
        end: seg.end + clipStartOffset,
        words: seg.words.map((w) => ({
          ...w,
          start: w.start + clipStartOffset,
          end: w.end + clipStartOffset,
        })),
      }));

      const review = buildSmartPipelineReview({
        snapshot,
        runtime,
        clipId: "clip-1",
        approvedCuts: [],
        approvedCaptions: timelineCaptions,
        rippleEditing: false,
        includeCaptions: true,
        includeCuts: false,
      });

      const resultCaptions = review.project.captionSegments;
      assert.equal(resultCaptions.length, 4);

      // Verify start of first segment is NOT 4.0 + 4.0 = 8.0, but remains 4.0!
      assert.equal(resultCaptions[0].start, 4.0);
      assert.equal(resultCaptions[0].words[0].start, 4.0);
      assert.equal(resultCaptions[0].words[0].end, 4.3);
    });

    it("applies clipStartOffset once when captions are 0-based relative to clip", () => {
      const clipStartOffset = 4.0;
      const clipDuration = 4.0;
      const snapshot = {
        captionSegments: [],
        visualSegments: [
          { id: "clip-0", duration: clipStartOffset, type: "video" },
          { id: "clip-1", duration: clipDuration, type: "video" },
        ],
        trackLocks: {},
      };
      const runtime = {
        visualSegments: snapshot.visualSegments,
      };

      // Captions that are 0-based relative to clip
      const review = buildSmartPipelineReview({
        snapshot,
        runtime,
        clipId: "clip-1",
        approvedCuts: [],
        approvedCaptions: genuineSegments,
        rippleEditing: false,
        includeCaptions: true,
        includeCuts: false,
      });

      const resultCaptions = review.project.captionSegments;
      assert.equal(resultCaptions.length, 4);
      assert.equal(resultCaptions[0].start, 4.0);
      assert.equal(resultCaptions[0].words[0].start, 4.0);
      assert.equal(resultCaptions[0].words[0].end, 4.3);
    });
  });

  describe("7. Silence Removal and Timeline Ripple Preservation", () => {
    it("shifts word timestamps accurately during timeline ripple edit", () => {
      let captions = structuredClone(genuineSegments);
      const state = {
        rippleEditing: true,
        trackLocks: {},
        captionSegments: captions,
        setCaptionSegments: (next) => { captions = next; },
        audioSegments: [],
        setAudioSegments: () => {},
        visualOverlaySegments: [],
        setVisualOverlaySegments: () => {},
        stickerSegments: [],
        setStickerSegments: () => {},
        musicSegments: [],
        setMusicSegments: () => {},
      };

      // Ripple shift +1.5s starting at boundary t = 1.0s
      // Seg 0 is [0, 0.82] -> stays unchanged
      // Seg 1 [0.82, 1.6] -> starts at 0.82 < 1.0 -> stays unchanged
      // Seg 2 [1.60, 2.5] -> starts at 1.60 >= 1.0 -> shifted by +1.5s to [3.10, 4.00]
      // Seg 3 [2.50, 3.36] -> starts at 2.50 >= 1.0 -> shifted by +1.5s to [4.00, 4.86]
      const result = applyTimelineRipple(state, 1.0, 1.5);
      assert.equal(result.moved, 2);

      assert.equal(captions[0].start, 0.0);
      assert.equal(captions[1].start, 0.82);

      assert.equal(captions[2].start, 3.10);
      assert.equal(captions[2].end, 4.00);
      assert.equal(captions[2].words[0].text, "you");
      assert.equal(captions[2].words[0].start, 1.60 + 1.5);
      assert.equal(captions[2].words[0].end, 1.72 + 1.5);

      assert.equal(captions[3].start, 4.00);
      assert.equal(captions[3].words[0].text, "travels");
      assert.equal(captions[3].words[0].start, 2.50 + 1.5);
    });

    it("collapses word timestamps accurately during silence removal", () => {
      const snapshot = {
        captionSegments: structuredClone(genuineSegments),
        visualSegments: [{ id: "main-clip", duration: 3.57, type: "video" }],
        trackLocks: {},
      };
      const runtime = {
        visualSegments: snapshot.visualSegments,
      };

      // Cut 0.2s from t=1.0 to t=1.2 (inside segment 1: "your network could read")
      // Word "network" is [0.94, 1.24]. Cut is [1.0, 1.2]
      const candidates = [
        { id: "pause-0", start: 1.0, end: 1.2, enabled: true },
      ];

      const review = buildSilenceRemovalReview(
        snapshot,
        runtime,
        "main-clip",
        candidates,
        true
      );

      const modifiedCaptions = review.project.captionSegments;
      assert.ok(modifiedCaptions.length >= 4);

      // Segment 0 was before 1.0s, completely unaffected
      assert.equal(modifiedCaptions[0].start, 0.0);
      assert.equal(modifiedCaptions[0].end, 0.82);

      // Segments after 1.2s are shifted left by 0.2s
      const seg2 = modifiedCaptions.find((s) => s.text.includes("password"));
      assert.ok(seg2);
      assert.equal(seg2.start, 1.60 - 0.2);
      assert.equal(seg2.end, 2.50 - 0.2);
      assert.equal(seg2.words[0].start, 1.60 - 0.2);
    });
  });

  describe("8. Karaoke Enabled vs Disabled and Legacy Captions", () => {
    it("returns -1 for active word when karaoke is disabled", () => {
      const seg = genuineSegments[0];
      const disabledStyle = { karaoke: false };
      assert.equal(isKaraokeEnabled(disabledStyle, seg), false);

      const enabledStyle = { karaoke: true };
      assert.equal(isKaraokeEnabled(enabledStyle, seg), true);
    });

    it("handles legacy caption segments without words gracefully", () => {
      const legacySeg = {
        id: "legacy-1",
        text: "Legacy caption without word timestamps",
        start: 0.0,
        end: 3.0,
        words: undefined, // no words array
      };
      assert.equal(getActiveWordIndex(legacySeg.words, 1.5, legacySeg), -1);
      assert.equal(isKaraokeEnabled({ karaoke: true }, legacySeg), true);

      // splitLineIntoWordChunks handles words=undefined without throwing
      const chunksResult = splitLineIntoWordChunks(legacySeg.text, undefined, 0, -1);
      assert.ok(chunksResult.chunks.length > 0);
      assert.equal(chunksResult.chunks[0].isActive, false);
    });
  });
});
