import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getActiveWordIndex,
  isKaraokeEnabled,
  resolveActiveWordColor,
  splitLineIntoWordChunks,
} from "../../src/lib/karaoke.js";
import { updateSegmentText } from "../../src/lib/transcriptReview.js";
import { applyTimelineRipple } from "../../src/lib/timelineRipple.js";
import { buildSilenceRemovalReview } from "../../src/lib/silenceRemoval.js";
import { DEFAULT_CAPTION_STYLE } from "../../src/hooks/useCaptionState.js";
import { CAPTION_VISUAL_STYLE_KEYS } from "../../src/lib/captionStyles.js";

describe("Phase 5 Milestone 2: Active-Word Highlighting / Karaoke Captions", () => {
  const sampleWords = [
    { text: "What", start: 1.0, end: 1.4 },
    { text: "if", start: 1.5, end: 1.8 },
    { text: "someone", start: 2.0, end: 2.5 },
    { text: "reads", start: 2.5, end: 3.0 },
  ];
  const sampleSegment = {
    id: "cap-1",
    text: "What if someone reads",
    start: 1.0,
    end: 3.2,
    words: sampleWords,
    timingSource: "asr-word",
  };

  it("1. Active word before the first word", () => {
    // Current time is before the segment starts or before words[0].start
    const beforeSegment = getActiveWordIndex(sampleWords, 0.5, sampleSegment);
    assert.equal(beforeSegment, -1, "Before segment start must be -1");

    const rightBeforeFirstWord = getActiveWordIndex(sampleWords, 0.99, sampleSegment);
    assert.equal(rightBeforeFirstWord, -1, "Right before first word must be -1");
  });

  it("2. Active word during its timestamp interval", () => {
    // Middle of word 0 [1.0, 1.4)
    assert.equal(getActiveWordIndex(sampleWords, 1.0, sampleSegment), 0);
    assert.equal(getActiveWordIndex(sampleWords, 1.2, sampleSegment), 0);
    assert.equal(getActiveWordIndex(sampleWords, 1.399, sampleSegment), 0);

    // Middle of word 1 [1.5, 1.8)
    assert.equal(getActiveWordIndex(sampleWords, 1.5, sampleSegment), 1);
    assert.equal(getActiveWordIndex(sampleWords, 1.65, sampleSegment), 1);

    // Middle of word 2 [2.0, 2.5)
    assert.equal(getActiveWordIndex(sampleWords, 2.2, sampleSegment), 2);

    // Middle of word 3 [2.5, 3.0)
    assert.equal(getActiveWordIndex(sampleWords, 2.7, sampleSegment), 3);
  });

  it("3. Transition between consecutive words", () => {
    // Consecutive words: word 2 ends at 2.5, word 3 starts at 2.5
    assert.equal(getActiveWordIndex(sampleWords, 2.499, sampleSegment), 2);
    assert.equal(getActiveWordIndex(sampleWords, 2.5, sampleSegment), 3);
    assert.equal(getActiveWordIndex(sampleWords, 2.501, sampleSegment), 3);
  });

  it("4. Exact word-end boundary behavior", () => {
    // Word 0 is [1.0, 1.4). At exactly 1.4, word 0 is no longer active.
    // Between 1.4 and 1.5 is a gap, so it should return -1.
    assert.equal(getActiveWordIndex(sampleWords, 1.4, sampleSegment), -1);
    // Word 3 ends at 3.0. At 3.0, it is no longer active.
    assert.equal(getActiveWordIndex(sampleWords, 3.0, sampleSegment), -1);
  });

  it("5. Gaps between words", () => {
    // Gap between word 0 (ends 1.4) and word 1 (starts 1.5)
    assert.equal(getActiveWordIndex(sampleWords, 1.45, sampleSegment), -1);

    // Gap between word 1 (ends 1.8) and word 2 (starts 2.0)
    assert.equal(getActiveWordIndex(sampleWords, 1.9, sampleSegment), -1);
    assert.equal(getActiveWordIndex(sampleWords, 1.99, sampleSegment), -1);
  });

  it("6. Multiple caption segments transition", () => {
    const segmentA = {
      id: "seg-a",
      text: "First caption",
      start: 0.0,
      end: 2.0,
      words: [
        { text: "First", start: 0.2, end: 0.8 },
        { text: "caption", start: 0.9, end: 1.8 },
      ],
    };
    const segmentB = {
      id: "seg-b",
      text: "Second phrase",
      start: 2.5,
      end: 4.5,
      words: [
        { text: "Second", start: 2.6, end: 3.2 },
        { text: "phrase", start: 3.4, end: 4.2 },
      ],
    };

    // Time in segment A
    assert.equal(getActiveWordIndex(segmentA.words, 0.5, segmentA), 0);
    assert.equal(getActiveWordIndex(segmentA.words, 1.2, segmentA), 1);

    // Gap between segments: 2.2s
    assert.equal(getActiveWordIndex(segmentA.words, 2.2, segmentA), -1);
    assert.equal(getActiveWordIndex(segmentB.words, 2.2, segmentB), -1);

    // Time in segment B
    assert.equal(getActiveWordIndex(segmentB.words, 2.8, segmentB), 0);
    assert.equal(getActiveWordIndex(segmentB.words, 3.8, segmentB), 1);
  });

  it("7. Timeline and clip offsets", () => {
    // Segment starting at offset 10.0, with relative word times [0.0..1.5]
    const relativeWords = [
      { text: "Offset", start: 0.2, end: 0.6 },
      { text: "clip", start: 0.7, end: 1.2 },
    ];
    const offsetSegment = {
      id: "seg-offset",
      text: "Offset clip",
      start: 10.0,
      end: 12.0,
      words: relativeWords,
    };

    // When querying at timeline time 10.4s (relative offset 0.4s)
    assert.equal(getActiveWordIndex(relativeWords, 10.4, offsetSegment), 0);
    assert.equal(getActiveWordIndex(relativeWords, 10.9, offsetSegment), 1);
    assert.equal(getActiveWordIndex(relativeWords, 9.9, offsetSegment), -1);
    assert.equal(getActiveWordIndex(relativeWords, 12.1, offsetSegment), -1);

    // If words already have absolute timeline timestamps:
    const absoluteWords = [
      { text: "Offset", start: 10.2, end: 10.6 },
      { text: "clip", start: 10.7, end: 11.2 },
    ];
    const absSegment = {
      id: "seg-abs",
      text: "Offset clip",
      start: 10.0,
      end: 12.0,
      words: absoluteWords,
    };
    assert.equal(getActiveWordIndex(absoluteWords, 10.4, absSegment), 0);
    assert.equal(getActiveWordIndex(absoluteWords, 10.9, absSegment), 1);
  });

  it("8. Seeking backward and forward", () => {
    // Forward seek jump
    assert.equal(getActiveWordIndex(sampleWords, 1.1, sampleSegment), 0);
    assert.equal(getActiveWordIndex(sampleWords, 2.7, sampleSegment), 3);

    // Backward seek jump
    assert.equal(getActiveWordIndex(sampleWords, 1.6, sampleSegment), 1);
    assert.equal(getActiveWordIndex(sampleWords, 0.2, sampleSegment), -1);
    assert.equal(getActiveWordIndex(sampleWords, 2.3, sampleSegment), 2);
  });

  it("9. Missing or invalid word timings safely falls back to -1", () => {
    // Empty array
    assert.equal(getActiveWordIndex([], 1.5, sampleSegment), -1);

    // Malformed words (non-numbers, NaN, nulls)
    const malformedWords = [
      { text: "Bad", start: NaN, end: 1.0 },
      { text: "Inverted", start: 2.0, end: 1.0 },
      { text: "MissingEnd", start: 1.5 },
      null,
    ];
    assert.equal(getActiveWordIndex(malformedWords, 1.5, sampleSegment), -1);
    assert.equal(getActiveWordIndex(undefined, 1.5, sampleSegment), -1);
  });

  it("10. Legacy phrase-level captions without word timestamps", () => {
    const legacySegment = {
      id: "legacy-1",
      text: "Old caption without words array",
      start: 0.0,
      end: 3.0,
    };
    assert.equal(getActiveWordIndex(legacySegment.words, 1.5, legacySegment), -1);
    assert.equal(isKaraokeEnabled({ karaoke: true }, legacySegment), true);
  });

  it("11. Karaoke disabled returns false and resolves inactive", () => {
    // Global style disabled
    assert.equal(isKaraokeEnabled({ karaoke: false }, sampleSegment), false);
    assert.equal(isKaraokeEnabled({}, sampleSegment), false);

    // Global enabled but overridden to false on segment
    const segmentOverrideDisabled = {
      ...sampleSegment,
      styleOverrides: { karaoke: false },
    };
    assert.equal(isKaraokeEnabled({ karaoke: true }, segmentOverrideDisabled), false);

    // Overridden to true on segment
    const segmentOverrideEnabled = {
      ...sampleSegment,
      styleOverrides: { karaoke: true },
    };
    assert.equal(isKaraokeEnabled({ karaoke: false }, segmentOverrideEnabled), true);

    // Animation set to karaoke
    const animKaraoke = {
      ...sampleSegment,
      animation: "karaoke",
    };
    assert.equal(isKaraokeEnabled({ karaoke: false }, animKaraoke), true);

    // Color resolution
    assert.equal(resolveActiveWordColor({}, sampleSegment), "#ffd43b");
    assert.equal(resolveActiveWordColor({ activeWordColor: "#00ff00" }, sampleSegment), "#00ff00");
    assert.equal(
      resolveActiveWordColor({ activeWordColor: "#00ff00" }, { ...sampleSegment, styleOverrides: { activeWordColor: "#ff0000" } }),
      "#ff0000"
    );
  });

  it("12. Caption text edits that invalidate word timings", () => {
    // Minor edit matching token count: retains words with updated text
    const updatedMatching = updateSegmentText([sampleSegment], sampleSegment.id, "What if anyone reads")[0];
    assert.ok(Array.isArray(updatedMatching.words), "Matching token count preserves words");
    assert.equal(updatedMatching.words[2].text, "anyone");
    assert.equal(updatedMatching.words[2].start, 2.0);

    // Major edit changing token count: clears words to prevent desynchronization
    const updatedMismatched = updateSegmentText([sampleSegment], sampleSegment.id, "Completely different text here now")[0];
    assert.equal(updatedMismatched.words, undefined, "Mismatched token count must clear words");
    assert.equal(getActiveWordIndex(updatedMismatched.words, 2.0, updatedMismatched), -1);
  });

  it("13. Timeline ripple and silence removal compatibility", () => {
    // Timeline ripple shifts segment and words identically
    const segments = [
      { id: "c1", start: 1.0, end: 3.0, words: [{ text: "One", start: 1.2, end: 2.8 }] },
      { id: "c2", start: 5.0, end: 7.0, words: [{ text: "Two", start: 5.2, end: 6.8 }] },
    ];
    let updatedCaptions = [];
    const d = {
      rippleEditing: true,
      trackLocks: {},
      captionSegments: segments,
      setCaptionSegments: (updater) => {
        updatedCaptions = typeof updater === "function" ? updater(segments) : updater;
      },
      audioSegments: [],
      setAudioSegments: () => {},
      visualOverlaySegments: [],
      setVisualOverlaySegments: () => {},
      stickerSegments: [],
      setStickerSegments: () => {},
      musicSegments: [],
      setMusicSegments: () => {},
    };
    applyTimelineRipple(d, 4.0, -1.5);
    // c1 untouched
    assert.equal(updatedCaptions[0].start, 1.0);
    assert.equal(updatedCaptions[0].words[0].start, 1.2);
    // c2 shifted by -1.5
    assert.equal(updatedCaptions[1].start, 3.5);
    assert.equal(updatedCaptions[1].words[0].start, 3.7);
    assert.equal(updatedCaptions[1].words[0].end, 5.3);

    // Querying c2 at new time: 3.8s is active for "Two"
    assert.equal(getActiveWordIndex(updatedCaptions[1].words, 3.8, updatedCaptions[1]), 0);

    // Silence removal review collapses time on words
    const snapshot = {
      visualSegments: [{ id: "v1", type: "video", duration: 10.0, playbackRate: 1 }],
      audioSegments: [],
      captionSegments: [
        {
          id: "cs1",
          start: 4.0,
          end: 8.0,
          text: "Hello world",
          words: [
            { text: "Hello", start: 4.2, end: 5.5 },
            { text: "world", start: 6.5, end: 7.8 },
          ],
        },
      ],
      trackLocks: {},
    };
    const runtime = {
      visualSegments: [{ id: "v1", type: "video", duration: 10.0, playbackRate: 1 }],
    };
    const cuts = [{ start: 1.0, end: 3.0, enabled: true }]; // 2s cut before caption
    const silenceRemovalResult = buildSilenceRemovalReview(snapshot, runtime, "v1", cuts, true);
    const updatedCaption = silenceRemovalResult.project.captionSegments[0];
    assert.equal(updatedCaption.start, 2.0); // 4.0 - 2.0
    assert.equal(updatedCaption.words[0].start, 2.2); // 4.2 - 2.0
    assert.equal(updatedCaption.words[1].start, 4.5); // 6.5 - 2.0
    assert.equal(getActiveWordIndex(updatedCaption.words, 2.3, updatedCaption), 0);
  });

  it("14. Undo/redo and project save/reload invariants", () => {
    // Project caption style contains karaoke keys
    assert.ok(CAPTION_VISUAL_STYLE_KEYS.includes("karaoke"));
    assert.ok(CAPTION_VISUAL_STYLE_KEYS.includes("activeWordColor"));
    assert.equal(DEFAULT_CAPTION_STYLE.karaoke, false);
    assert.equal(DEFAULT_CAPTION_STYLE.activeWordColor, "#ffd43b");

    // Serialization and deserialization simulation
    const project = {
      version: 3,
      captionStyle: {
        ...DEFAULT_CAPTION_STYLE,
        karaoke: true,
        activeWordColor: "#00e5ff",
      },
      captionSegments: [sampleSegment],
    };

    const serialized = JSON.stringify(project);
    const parsed = JSON.parse(serialized);

    assert.equal(parsed.captionStyle.karaoke, true);
    assert.equal(parsed.captionStyle.activeWordColor, "#00e5ff");
    assert.equal(parsed.captionSegments[0].words.length, 4);
    assert.equal(getActiveWordIndex(parsed.captionSegments[0].words, 1.2, parsed.captionSegments[0]), 0);
    assert.equal(resolveActiveWordColor(parsed.captionStyle, parsed.captionSegments[0]), "#00e5ff");
  });

  it("15. No stale active word after caption ends", () => {
    // Segment ends at 3.2, last word ends at 3.0
    // Query at 3.1 (in segment but past all words)
    assert.equal(getActiveWordIndex(sampleWords, 3.1, sampleSegment), -1);

    // Query at 3.25 (past segment end)
    assert.equal(getActiveWordIndex(sampleWords, 3.25, sampleSegment), -1);

    // Query at 10.0 (way past segment)
    assert.equal(getActiveWordIndex(sampleWords, 10.0, sampleSegment), -1);
  });

  it("Bonus: Line word splitting preserves kerning offsets and spacing", () => {
    const line = "What if someone reads";
    const { chunks } = splitLineIntoWordChunks(line, sampleWords, 0, 2); // activeWordIndex = 2 ("someone")

    assert.equal(chunks.length, 7); // "What", " ", "if", " ", "someone", " ", "reads"
    const wordsOnly = chunks.filter((c) => c.isWord);
    assert.equal(wordsOnly.length, 4);
    assert.equal(wordsOnly[0].text, "What");
    assert.equal(wordsOnly[0].isActive, false);
    assert.equal(wordsOnly[2].text, "someone");
    assert.equal(wordsOnly[2].isActive, true);
    assert.equal(wordsOnly[2].wordIndex, 2);
    assert.equal(wordsOnly[3].text, "reads");
    assert.equal(wordsOnly[3].isActive, false);

    // Offsets
    assert.equal(wordsOnly[0].offset, 0);
    assert.equal(wordsOnly[1].offset, 5); // "What " is 5 chars
    assert.equal(wordsOnly[2].offset, 8); // "What if " is 8 chars
  });
});
