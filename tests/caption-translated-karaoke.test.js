// Translated-caption karaoke regression suite.
//
// Bug under test: after translating captions with the Ollalink subtitle text
// tools, enabling Karaoke (Active Word) showed no active-word highlight.
//
// Root cause established before any change:
//   1. /v1/translate returns only text, source, target and numbers_verified.
//      There is no translated-word timing and no alignment endpoint.
//   2. applySubtitleTextReview therefore deletes `words` for every changed cue
//      and marks timingSource "manual", so the renderer can never resolve a
//      word index for the new text.
//   3. getActiveWordIndex then returns -1 forever, while isKaraokeEnabled kept
//      reporting true, so the UI advertised karaoke it could not deliver.
//
// These tests lock the two halves of the fix: no fabricated or inherited
// timing, and an honest disable of the active-word path when timing is absent.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    areWordsValidForKaraoke,
    getActiveWordIndex,
    hasUsableWordTiming,
    isKaraokeEnabled,
    splitLineIntoWordChunks,
} from "../src/lib/karaoke.js";
import { applySubtitleTextReview } from "../src/lib/subtitleTextTools.js";

const englishWords = [
    { text: "Open", start: 10.125, end: 10.6 },
    { text: "the", start: 10.6, end: 10.75 },
    { text: "port", start: 10.75, end: 11.2 },
];

const englishCue = {
    id: "cap-1",
    text: "Open the port",
    start: 10.125,
    end: 11.6,
    hidden: false,
    audioSegmentId: "audio-1",
    fontId: "font-1",
    styleOverrides: { karaoke: true },
    words: englishWords.map((word) => ({ ...word })),
    timingSource: "asr-word",
};

// A second cue that the review leaves untouched, to prove unchanged cues keep
// their genuine karaoke timing when a sibling cue is translated.
const untouchedCue = {
    id: "cap-2",
    text: "Keep this",
    start: 12,
    end: 13.4,
    words: [
        { text: "Keep", start: 12, end: 12.6 },
        { text: "this", start: 12.6, end: 13.2 },
    ],
    timingSource: "asr-word",
};

const karaokeStyle = { karaoke: true };

describe("Translated captions: karaoke timing integrity", () => {
    it("original English captions still resolve active words at the expected times", () => {
        assert.equal(hasUsableWordTiming(englishCue), true);
        assert.equal(getActiveWordIndex(englishCue.words, 10.3, englishCue), 0);
        assert.equal(getActiveWordIndex(englishCue.words, 10.7, englishCue), 1);
        assert.equal(getActiveWordIndex(englishCue.words, 11.0, englishCue), 2);
        // Outside the cue / after the final word there is no active word, and
        // that is a normal pause, not a missing-alignment state.
        assert.equal(getActiveWordIndex(englishCue.words, 11.6, englishCue), -1);
        assert.equal(hasUsableWordTiming(englishCue), true);
    });

    it("a translated cue is marked as having no usable word timing", () => {
        const snapshot = structuredClone([englishCue, untouchedCue]);
        const results = [
            { id: "cap-1", text: "Abrir el puerto", numbersVerified: true },
            { id: "cap-2", text: untouchedCue.text, numbersVerified: true },
        ];

        const next = applySubtitleTextReview(snapshot, snapshot, results);
        const translated = next[0];

        assert.equal(translated.text, "Abrir el puerto");
        assert.equal(translated.words, undefined, "Translated text must not inherit source words");
        assert.equal(translated.timingSource, "manual");
        assert.equal(hasUsableWordTiming(translated), false);
        assert.equal(getActiveWordIndex(translated.words, 10.3, translated), -1);
    });

    it("never reuses English word timings as Spanish word timings", () => {
        const snapshot = structuredClone([englishCue, untouchedCue]);
        const results = [
            // Deliberately the same token count as the English cue. Equal word counts
            // do not establish alignment, so the timings must still be discarded.
            { id: "cap-1", text: "Abrir el puerto", numbersVerified: true },
            { id: "cap-2", text: untouchedCue.text, numbersVerified: true },
        ];

        const next = applySubtitleTextReview(snapshot, snapshot, results);
        const translated = next[0];

        assert.equal(translated.text.split(/\s+/).length, englishCue.words.length);
        assert.equal(translated.words, undefined);

        // No word-shaped payload may survive on the translated cue, and no English
        // word text may be carried onto the Spanish cue to justify old timings.
        assert.equal(Object.hasOwn(translated, "words"), false);
        const serialized = JSON.stringify(translated);
        for (const word of englishWords) {
            assert.equal(serialized.includes(`"${word.text}"`), false);
        }
    });

    it("does not distribute timing uniformly across translated words", () => {
        const snapshot = structuredClone([englishCue, untouchedCue]);
        const next = applySubtitleTextReview(snapshot, snapshot, [
            { id: "cap-1", text: "Abrir el puerto ahora mismo", numbersVerified: true },
            { id: "cap-2", text: untouchedCue.text, numbersVerified: true },
        ]);

        // A uniform split would produce one word per equal slice of 10.125-11.6.
        // None may exist, because that would be fabricated acoustic timing.
        assert.equal(next[0].words, undefined);
        assert.equal(hasUsableWordTiming(next[0]), false);
        for (const key of ["words", "wordTimings", "wordTimestamps", "alignment"]) {
            assert.equal(Object.hasOwn(next[0], key), false);
        }
    });

    it("unchanged cues keep genuine word timing while translated siblings do not", () => {
        const snapshot = structuredClone([englishCue, untouchedCue]);
        const next = applySubtitleTextReview(snapshot, snapshot, [
            { id: "cap-1", text: "Abrir el puerto", numbersVerified: true },
            { id: "cap-2", text: untouchedCue.text, numbersVerified: true },
        ]);

        // Unchanged cue is passed through by reference: nothing was rewritten.
        assert.equal(next[1], snapshot[1]);
        assert.deepEqual(next[1], untouchedCue);
        assert.equal(hasUsableWordTiming(next[1]), true);
        assert.equal(getActiveWordIndex(next[1].words, 12.3, next[1]), 0);
    });

    it("preserves ids, cue times, order and metadata across a translation", () => {
        const snapshot = structuredClone([englishCue, untouchedCue]);
        const next = applySubtitleTextReview(snapshot, snapshot, [
            { id: "cap-1", text: "Abrir el puerto", numbersVerified: true },
            { id: "cap-2", text: untouchedCue.text, numbersVerified: true },
        ]);

        assert.deepEqual(next.map((cue) => cue.id), ["cap-1", "cap-2"]);
        for (let i = 0; i < next.length; i++) {
            assert.equal(next[i].start, snapshot[i].start);
            assert.equal(next[i].end, snapshot[i].end);
            assert.deepEqual(next[i].styleOverrides, snapshot[i].styleOverrides);
        }
        assert.equal(next[0].audioSegmentId, "audio-1");
        assert.equal(next[0].fontId, "font-1");
        assert.equal(next[0].hidden, false);
        // Cue-level windows are untouched, so playback timing is unaffected.
        assert.ok(next[0].end > next[0].start);
    });

    it("reports karaoke availability honestly instead of advertising a dead highlight", () => {
        const translatedCue = {
            ...englishCue,
            text: "Abrir el puerto",
            timingSource: "manual",
        };
        delete translatedCue.words;

        // The style still requests karaoke; that preference is preserved.
        assert.equal(isKaraokeEnabled(karaokeStyle, translatedCue), true);
        // But no active word can ever resolve, which is what the renderer reports.
        assert.equal(hasUsableWordTiming(translatedCue), false);
        assert.equal(
            isKaraokeEnabled(karaokeStyle, translatedCue) && hasUsableWordTiming(translatedCue),
            false
        );

        // Same honest answer for other missing-alignment shapes.
        assert.equal(hasUsableWordTiming(null), false);
        assert.equal(hasUsableWordTiming(undefined), false);
        assert.equal(hasUsableWordTiming({ start: 0, end: 1 }), false);
        assert.equal(hasUsableWordTiming({ start: 0, end: 1, words: [] }), false);
        assert.equal(hasUsableWordTiming({ start: 0, end: 1, words: [{ text: "x" }] }), false);
    });

    it("a translated cue renders as plain phrase chunks, never as a stuck highlight", () => {
        const translatedCue = { ...englishCue, text: "Abrir el puerto", timingSource: "manual" };
        delete translatedCue.words;

        const { chunks } = splitLineIntoWordChunks("Abrir el puerto", translatedCue.words, 0, -1);
        assert.equal(chunks.length, 1);
        assert.equal(chunks[0].isWord, false);
        assert.equal(chunks[0].isActive, false);
        assert.equal(chunks[0].wordIndex, -1);
        assert.equal(chunks[0].text, "Abrir el puerto");
    });

    it("switching between original and translated captions does not corrupt timing", () => {
        const original = structuredClone([englishCue, untouchedCue]);
        const snapshot = structuredClone(original);
        const translated = applySubtitleTextReview(snapshot, snapshot, [
            { id: "cap-1", text: "Abrir el puerto", numbersVerified: true },
            { id: "cap-2", text: untouchedCue.text, numbersVerified: true },
        ]);

        // Applying a review must not mutate the snapshot the editor can fall back to.
        assert.deepEqual(snapshot, original);
        assert.equal(hasUsableWordTiming(snapshot[0]), true);
        assert.equal(getActiveWordIndex(snapshot[0].words, 10.3, snapshot[0]), 0);

        assert.equal(hasUsableWordTiming(translated[0]), false);

        // Flipping back and forth is idempotent: the original cue is untouched and
        // the translated cue stays without fabricated timing.
        assert.equal(hasUsableWordTiming(snapshot[0]), true);
        assert.equal(hasUsableWordTiming(translated[0]), false);
        assert.equal(translated[0].words, undefined);
    });

    it("keeps segment-relative word timing usable for real karaoke cues", () => {
        // Captions whose word offsets are relative to the cue start must still be
        // treated as having genuine timing, despite the cue starting far from zero.
        const relativeCue = {
            id: "cap-rel",
            text: "hello world",
            start: 10,
            end: 12,
            words: [
                { text: "hello", start: 0, end: 0.5 },
                { text: "world", start: 0.5, end: 1 },
            ],
        };

        assert.equal(hasUsableWordTiming(relativeCue), true);
        assert.equal(getActiveWordIndex(relativeCue.words, 10.4, relativeCue), 0);
        assert.equal(getActiveWordIndex(relativeCue.words, 10.8, relativeCue), 1);
    });
});

describe("Translated captions: validation rejects unusable timing", () => {
    it("treats out-of-cue and malformed word timings as unusable", () => {
        const base = { id: "cap-x", text: "text", start: 0.5, end: 2 };
        // Word interval ends outside the cue window.
        assert.equal(hasUsableWordTiming({ ...base, words: [{ text: "a", start: 1, end: 3 }] }), false);
        // Backwards word interval.
        assert.equal(hasUsableWordTiming({ ...base, words: [{ text: "a", start: 1.5, end: 1.2 }] }), false);
        // Non-monotonic word starts.
        assert.equal(hasUsableWordTiming({ ...base, words: [{ text: "a", start: 1.4, end: 1.6 }, { text: "b", start: 1.0, end: 1.3 }] }), false);
        // Non-finite timestamp.
        assert.equal(hasUsableWordTiming({ ...base, words: [{ text: "a", start: Number.NaN, end: 1.5 }] }), false);
        // A well-formed cue-absolute interval is usable.
        assert.equal(hasUsableWordTiming({ ...base, words: [{ text: "a", start: 0.8, end: 1.2 }] }), true);

        // Existing design: a word array that begins before the cue start is read as
        // cue-relative by getActiveWordIndex. The gate must agree with the renderer
        // rather than inventing a second, stricter rule that would disable karaoke
        // for captions whose renderer already highlights them correctly.
        const relativeCue = { id: "cap-rel2", text: "ab", start: 5, end: 7 };
        const relativeWords = [{ text: "a", start: 1, end: 1.5 }];
        assert.equal(hasUsableWordTiming({ ...relativeCue, words: relativeWords }), true);
        assert.equal(getActiveWordIndex(relativeWords, 6.2, relativeCue), 0);
    });

    it("keeps areWordsValidForKaraoke semantics unchanged", () => {
        assert.equal(areWordsValidForKaraoke([], 0, 10), false);
        assert.equal(areWordsValidForKaraoke(null, 0, 10), false);
        assert.equal(areWordsValidForKaraoke([{ text: "a", start: 1, end: 2 }], 0, 10), true);
        assert.equal(areWordsValidForKaraoke([{ text: "a", start: 1, end: 2 }], 0, 1.5), false);
    });
});
