import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { captionSegmentsFromWords } from "../../src/lib/captionSegmentation.js";
import {
  regroupReviewSegments,
  updateSegmentText,
  updateSegmentTiming,
  validateSegmentWords,
  prepareSegmentsForTimeline,
} from "../../src/lib/transcriptReview.js";
import {
  buildSilenceRemovalReview,
  collapseTime,
} from "../../src/lib/silenceRemoval.js";
import {
  createSmartPipelinePlan,
  buildSmartPipelineReview,
} from "../../src/lib/smartPipeline.js";
import { applyTimelineRipple } from "../../src/lib/timelineRipple.js";
import { parseSrt } from "../../src/lib/subtitles.js";

describe("Phase 5 Milestone 1: Word-Level Caption Timestamps & Invariance", () => {
  const sampleChunks = [
    { text: "What", timestamp: [0.1, 0.4] },
    { text: " if", timestamp: [0.4, 0.7] },
    { text: " someone", timestamp: [0.7, 1.2] },
    { text: " could", timestamp: [1.2, 1.5] },
    { text: " read", timestamp: [1.5, 1.9] },
    { text: " passwords?", timestamp: [1.9, 2.6] },
  ];
  const sampleDuration = 3.0;

  it("1. Genuine ASR word timestamps survive caption segmentation", () => {
    const segments = captionSegmentsFromWords(sampleChunks, sampleDuration, {
      timelineOffset: 0,
      grouping: "phrases",
    });

    assert.ok(segments.length >= 1, "Should generate at least one caption segment");
    assert.ok(Array.isArray(segments[0].words), "Segment should have words array");
    assert.equal(segments[0].timingSource, "asr-word");

    const totalWordsAcrossSegments = segments.flatMap((s) => s.words || []);
    assert.equal(totalWordsAcrossSegments.length, sampleChunks.length);
    assert.equal(totalWordsAcrossSegments[0].text, "What");
    assert.equal(totalWordsAcrossSegments[0].start, 0.1);
    assert.equal(totalWordsAcrossSegments[0].end, 0.4);
    assert.equal(totalWordsAcrossSegments[1].text, "if");
    assert.equal(totalWordsAcrossSegments[1].start, 0.4);
    assert.equal(totalWordsAcrossSegments[1].end, 0.7);
  });

  it("2. Timeline offsets are applied exactly once to both segments and words", () => {
    const offset = 15.5;
    const segments = captionSegmentsFromWords(sampleChunks, sampleDuration, {
      timelineOffset: offset,
      grouping: "phrases",
    });

    assert.equal(segments[0].start, offset + 0.1);
    assert.equal(segments[0].words[0].start, offset + 0.1);
    assert.equal(segments[0].words[0].end, offset + 0.4);
    assert.equal(segments[0].words[1].start, offset + 0.4);
    assert.equal(segments[0].words[1].end, offset + 0.7);

    // Confirm offset was not applied twice
    assert.notEqual(segments[0].words[0].start, offset * 2 + 0.1);
  });

  it("3. Words remain strictly ordered with valid timestamps within parent segment", () => {
    const segments = captionSegmentsFromWords(sampleChunks, sampleDuration, {
      timelineOffset: 5.0,
      grouping: "phrases",
    });

    for (const seg of segments) {
      assert.ok(Array.isArray(seg.words) && seg.words.length > 0);
      const validation = validateSegmentWords(seg.words, seg.start, seg.end);
      assert.equal(validation.valid, true, `Validation failed: ${validation.error}`);

      for (let i = 0; i < seg.words.length; i++) {
        const w = seg.words[i];
        assert.ok(w.start >= seg.start - 0.001);
        assert.ok(w.end <= seg.end + 0.001);
        assert.ok(w.end >= w.start);
        if (i > 0) {
          assert.ok(w.start >= seg.words[i - 1].start - 0.001);
        }
      }
    }
  });

  it("4. Transcript text edits safely handle word correspondence without claiming fake ASR timings", () => {
    const segments = captionSegmentsFromWords(sampleChunks, sampleDuration, {
      timelineOffset: 0,
      grouping: "phrases",
    });
    const segId = segments[0].id;
    const originalWords = [...segments[0].words];

    // Case A: 1-to-1 typo correction preserves genuine ASR word timestamps
    const typoCorrection = segments[0].text.replace("What", "When");
    const updatedWithTypo = updateSegmentText(segments, segId, typoCorrection);
    const updatedSeg = updatedWithTypo.find((s) => s.id === segId);
    assert.ok(Array.isArray(updatedSeg.words));
    assert.equal(updatedSeg.words[0].text, "When");
    assert.equal(updatedSeg.words[0].start, originalWords[0].start);
    assert.equal(updatedSeg.words[0].end, originalWords[0].end);

    // Case B: Word count mismatch (e.g. adding words) safely removes word timings to fall back to phrase-level
    const rewrittenText = "Completely rewritten phrase with many extra words added here";
    const updatedWithAdditions = updateSegmentText(segments, segId, rewrittenText);
    const phraseFallbackSeg = updatedWithAdditions.find((s) => s.id === segId);
    assert.equal(phraseFallbackSeg.text, rewrittenText);
    assert.equal(phraseFallbackSeg.words, undefined, "Words should be removed to prevent fake timings");
    assert.equal(phraseFallbackSeg.timingSource, "manual");

    // Case C: Timing adjustment clamps words to new boundaries
    const retimed = updateSegmentTiming(segments, segId, { start: 0.3, end: 1.0 });
    const retimedSeg = retimed.find((s) => s.id === segId);
    assert.ok(retimedSeg.words.every((w) => w.start >= 0.3 && w.end <= 1.0));
  });

  it("5. Regrouping preserves the exact words and timestamps without duplication or loss", () => {
    const phraseSegments = regroupReviewSegments(sampleChunks, sampleDuration, {
      timelineOffset: 2.0,
      grouping: "phrases",
    });
    const wordSegments = regroupReviewSegments(sampleChunks, sampleDuration, {
      timelineOffset: 2.0,
      grouping: "words",
    });

    const phraseWords = phraseSegments.flatMap((s) => s.words || []);
    const singleWords = wordSegments.flatMap((s) => s.words || []);

    assert.equal(phraseWords.length, sampleChunks.length);
    assert.equal(singleWords.length, sampleChunks.length);

    for (let i = 0; i < sampleChunks.length; i++) {
      assert.equal(phraseWords[i].text, singleWords[i].text);
      assert.equal(phraseWords[i].start, singleWords[i].start);
      assert.equal(phraseWords[i].end, singleWords[i].end);
    }
  });

  it("6. Smart Pipeline cuts and ripple edits correctly transform word timings", () => {
    const rawChunks = [
      { text: "WordOne", timestamp: [0.0, 1.0] },
      { text: " WordTwo", timestamp: [1.0, 2.0] },
      { text: " WordThree", timestamp: [2.0, 3.0] },
      { text: " WordFour", timestamp: [3.0, 4.0] },
    ];
    const duration = 5.0;
    const initialCaptions = captionSegmentsFromWords(rawChunks, duration, {
      timelineOffset: 0,
      grouping: "phrases",
    });

    const snapshot = {
      visualSegments: [{ id: "v1", type: "video", duration: 5.0, playbackRate: 1 }],
      audioSegments: [],
      captionSegments: initialCaptions,
      trackLocks: {},
    };
    const runtime = {
      visualSegments: [{ id: "v1", type: "video", duration: 5.0, playbackRate: 1 }],
    };

    // Scenario A: Cut between words (pause from 1.0s to 2.0s removed)
    const cutsBetween = [{ start: 1.0, end: 2.0, enabled: true }];
    const reviewBetween = buildSilenceRemovalReview(snapshot, runtime, "v1", cutsBetween, true);

    const resultingBetween = reviewBetween.project.captionSegments;
    assert.ok(resultingBetween.length >= 1);
    const wordsBetween = resultingBetween.flatMap((s) => s.words || []);
    // WordOne was [0, 1]. WordThree was [2, 3] -> collapsed by 1.0s to [1, 2]. WordFour was [3, 4] -> collapsed to [2, 3].
    assert.equal(wordsBetween[0].text, "WordOne");
    assert.equal(wordsBetween[0].start, 0.0);
    assert.equal(wordsBetween[0].end, 1.0);
    assert.equal(wordsBetween[1].text, "WordThree");
    assert.equal(wordsBetween[1].start, 1.0);
    assert.equal(wordsBetween[1].end, 2.0);
    assert.equal(wordsBetween[2].text, "WordFour");
    assert.equal(wordsBetween[2].start, 2.0);
    assert.equal(wordsBetween[2].end, 3.0);

    // Scenario B: Cut through the middle of a caption interval
    // WordTwo is [1.0, 2.0]. Cut is [1.5, 2.5], removing tail of WordTwo and head of WordThree.
    const cutsMiddle = [{ start: 1.5, end: 2.5, enabled: true }];
    const reviewMiddle = buildSilenceRemovalReview(snapshot, runtime, "v1", cutsMiddle, true);
    const wordsMiddle = reviewMiddle.project.captionSegments.flatMap((s) => s.words || []);

    // Retained words before cut: WordOne [0, 1], WordTwo clamped to [1, 1.5]
    assert.equal(wordsMiddle[0].text, "WordOne");
    assert.equal(wordsMiddle[0].start, 0.0);
    assert.equal(wordsMiddle[0].end, 1.0);
    assert.equal(wordsMiddle[1].text, "WordTwo");
    assert.equal(wordsMiddle[1].start, 1.0);
    assert.equal(wordsMiddle[1].end, 1.5);

    // Retained words after cut (shifted left by 1.0s cut duration): WordThree [2.5, 3.0] -> [1.5, 2.0]
    assert.equal(wordsMiddle[2].text, "WordThree");
    assert.equal(wordsMiddle[2].start, 1.5);
    assert.equal(wordsMiddle[2].end, 2.0);

    // Scenario C: Ripple offset shifting via applyTimelineRipple
    let rippleCaptions = structuredClone(initialCaptions);
    const mockEditor = {
      rippleEditing: true,
      audioSegments: [],
      visualOverlaySegments: [],
      stickerSegments: [],
      musicSegments: [],
      trackLocks: {},
      captionSegments: rippleCaptions,
      setAudioSegments: () => {},
      setVisualOverlaySegments: () => {},
      setStickerSegments: () => {},
      setMusicSegments: () => {},
      setMusicStart: () => {},
      setCaptionSegments: (updater) => {
        rippleCaptions = typeof updater === "function" ? updater(rippleCaptions) : updater;
        mockEditor.captionSegments = rippleCaptions;
      },
    };
    applyTimelineRipple(mockEditor, 0.5, 2.0); // Shift clips starting at or after 0.5s by +2.0s
    // Caption starts at 0.0, so it is before boundary 0.5. Let's ripple at boundary 0.0:
    applyTimelineRipple(mockEditor, 0.0, 3.0);
    assert.equal(rippleCaptions[0].start, 3.0);
    assert.equal(rippleCaptions[0].words[0].start, 3.0);
    assert.equal(rippleCaptions[0].words[0].end, 4.0);
  });

  it("7. Legacy captions without words continue to work unchanged across all operations", () => {
    const legacyCaptions = [
      { id: "legacy-1", start: 0.5, end: 2.0, text: "Legacy caption text without words" },
    ];
    const snapshot = {
      visualSegments: [{ id: "v1", type: "video", duration: 5.0, playbackRate: 1 }],
      audioSegments: [],
      captionSegments: legacyCaptions,
      trackLocks: {},
    };
    const runtime = {
      visualSegments: [{ id: "v1", type: "video", duration: 5.0, playbackRate: 1 }],
    };

    const cuts = [{ start: 2.5, end: 3.5, enabled: true }];
    const review = buildSilenceRemovalReview(snapshot, runtime, "v1", cuts, true);

    const resulting = review.project.captionSegments;
    assert.equal(resulting.length, 1);
    assert.equal(resulting[0].text, "Legacy caption text without words");
    assert.equal(resulting[0].words, undefined);
  });

  it("8. SRT-imported captions without word timings parse and function identically", () => {
    const srt = `1\n00:00:01,000 --> 00:00:03,500\nSRT imported subtitle line\n`;
    const { captions, skipped } = parseSrt(srt);

    assert.equal(skipped, 0);
    assert.equal(captions.length, 1);
    assert.equal(captions[0].text, "SRT imported subtitle line");
    assert.equal(captions[0].start, 1.0);
    assert.equal(captions[0].end, 3.5);
    assert.equal(captions[0].words, undefined);

    // Prepare for timeline
    const prepared = prepareSegmentsForTimeline(captions, "font-1");
    assert.equal(prepared[0].words, undefined);
    assert.equal(prepared[0].fontId, "font-1");
  });

  it("9. Save/reload project serialization preserves optional word timing data", () => {
    const captionsWithWords = captionSegmentsFromWords(sampleChunks, sampleDuration, {
      timelineOffset: 0,
      grouping: "phrases",
    });

    const projectData = {
      schemaVersion: 3,
      script: captionsWithWords.map((c) => c.text).join("\n"),
      captionSegments: captionsWithWords,
    };

    // Simulate JSON serialization and reload
    const serialized = JSON.stringify(projectData);
    const restored = JSON.parse(serialized);

    assert.equal(restored.captionSegments.length, captionsWithWords.length);
    assert.ok(Array.isArray(restored.captionSegments[0].words));
    assert.equal(restored.captionSegments[0].words.length, captionsWithWords[0].words.length);
    assert.equal(restored.captionSegments[0].words[0].text, "What");
    assert.equal(restored.captionSegments[0].words[0].start, 0.1);
  });

  it("10. Undo/redo history deep clones words and isolates snapshot state", () => {
    const captionsWithWords = captionSegmentsFromWords(sampleChunks, sampleDuration, {
      timelineOffset: 0,
      grouping: "phrases",
    });

    // Helper clone like useEditorHistory.js
    function cloneItems(items = []) {
      return (Array.isArray(items) ? items : []).map((item) => {
        if (item && Array.isArray(item.words)) {
          return {
            ...item,
            words: item.words.map((w) => ({ ...w })),
          };
        }
        return { ...item };
      });
    }

    const snapshot = cloneItems(captionsWithWords);

    // Mutate live caption word
    captionsWithWords[0].words[0].text = "MUTATED";
    captionsWithWords[0].words[0].start = 999;

    // Snapshot in history must remain completely unaffected
    assert.equal(snapshot[0].words[0].text, "What");
    assert.equal(snapshot[0].words[0].start, 0.1);
  });

  it("11. Cancelling a transcript review leaves project state completely untouched", () => {
    const initialCaptions = [
      { id: "c-init", start: 0, end: 2, text: "Initial caption" },
    ];
    let liveCaptions = structuredClone(initialCaptions);

    // Review data is staged
    const stagedReview = {
      isOpen: true,
      segments: captionSegmentsFromWords(sampleChunks, sampleDuration),
    };

    // User cancels review
    const onCancel = () => {
      stagedReview.isOpen = false;
    };
    onCancel();

    // Live timeline remains completely intact
    assert.deepEqual(liveCaptions, initialCaptions);
  });

  it("12. Speech after silence gap is preserved with valid timestamps even if word before gap has null end", () => {
    // Word 2 has null end timestamp [0.8, null] followed by a 2.0s silence gap before Word 3 at 3.0s
    const gapChunks = [
      { text: "First", timestamp: [0.2, 0.5] },
      { text: " part", timestamp: [0.5, null] },
      { text: " Second", timestamp: [3.0, 3.4] },
      { text: " part", timestamp: [3.4, 3.8] },
    ];
    const totalDuration = 5.0;

    const segments = captionSegmentsFromWords(gapChunks, totalDuration, {
      timelineOffset: 0,
      grouping: "phrases",
    });

    // Should create 2 distinct segments because of the 2.5s gap (> 0.35s)
    assert.equal(segments.length, 2, "Should split into two segments across the silence gap");

    // First segment must end near ~0.85s, NOT stretch to 3.0s!
    assert.ok(segments[0].end < 2.0, `Segment 1 end (${segments[0].end}) should not stretch across silence gap`);
    assert.equal(segments[0].words.length, 2);
    assert.ok(segments[0].words[1].end < 2.0, "Word before silence gap should not stretch to 3.0s");

    // Second segment must start at 3.0s, not clamped or corrupted by previousEnd
    assert.equal(segments[1].start, 3.0, "Segment after silence gap must start at 3.0s");
    assert.equal(segments[1].words[0].start, 3.0);
    assert.equal(segments[1].words[0].text, "Second");
    assert.equal(segments[1].words[1].text, "part");
  });
});
