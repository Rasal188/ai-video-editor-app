// Language-independent synchronized phrase-level karaoke for translated captions.
//
// The translation provider returns text only: there are no translated-word
// timestamps and no alignment endpoint. What the cue *does* carry is genuine
// Ollalink source-language word intervals, which describe when the speaker was
// talking. Those intervals are language independent, so they can drive a
// phrase-level highlight for the translated line.
//
// This suite locks the whole contract, across every language in the Translation
// dropdown, and it deliberately asserts the limits as hard as the capability:
//
//   * chunk windows are real source word intervals (never a uniform slice of the
//     cue, never stretched to the cue bounds);
//   * the derived record lives in `phraseTiming`, never in `words`, and the
//     original provider timestamps are never written to;
//   * preview and export agree because both go through one resolver;
//   * scripts without whitespace word separation (Chinese) and right-to-left
//     scripts (Arabic) work without any per-language table;
//   * a cue with no usable source timing falls back to plain phrases instead of
//     showing a false highlight.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { getActiveWordIndex, resolveKaraokeWordTiming, splitLineIntoWordChunks } from "../src/lib/karaoke.js";
import { applySubtitleTextReview, TRANSLATION_LANGUAGES } from "../src/lib/subtitleTextTools.js";
import {
    MAX_PHRASE_GROUPS,
    derivePhraseTiming,
    describePhraseTimingStatus,
    getDerivedPhraseWords,
    hasPhraseTiming,
    normalizeSourceWordIntervals,
    segmentTokensWithOffsets,
    validatePhraseTiming,
} from "../src/lib/phraseTiming.js";
import { WORD_TIMING_SOURCES } from "../src/lib/wordAlignment.js";

const DERIVED = "source-word-derived-phrase";

// Genuine ASR intervals for "Open the port". Deliberately uneven: 0.475s,
// 0.15s, 0.45s. A uniform split of the cue would produce three equal 0.492s
// slices, so any test that passes here cannot be passing by uniform division.
const sourceWords = () => [
    { text: "Open", start: 10.125, end: 10.6 },
    { text: "the", start: 10.6, end: 10.75 },
    { text: "port", start: 10.75, end: 11.2 },
];

const sourceCue = () => ({
    id: "cap-1",
    text: "Open the port",
    start: 10.125,
    end: 11.6,
    hidden: false,
    audioSegmentId: "audio-1",
    fontId: "font-1",
    styleOverrides: { karaoke: true },
    words: sourceWords(),
    timingSource: "asr-word",
});

const untouchedCue = () => ({
    id: "cap-2",
    text: "Keep this",
    start: 12,
    end: 13.4,
    words: [
        { text: "Keep", start: 12, end: 12.6 },
        { text: "this", start: 12.6, end: 13.2 },
    ],
    timingSource: "asr-word",
});

// One translation per language in the dropdown. Each target is exactly three
// word-like units so the group-to-source-interval mapping is 1:1 and can be
// asserted exactly; Chinese is four characters that form three word-like
// segments, which is precisely the case a whitespace splitter gets wrong.
const translations = Object.freeze({
    en: "Open the harbour",
    hi: "अब बंदरगाह खोलो",
    es: "Abrir el puerto",
    fr: "Ouvrir le port",
    zh: "现在打开端口",
    de: "Öffne den Hafen",
    ar: "افتح الميناء الآن",
    pt: "Abrir o porto",
    ru: "Открой порт сейчас",
});

const translate = (text, target) =>
    applySubtitleTextReview(
        [sourceCue()],
        [sourceCue()],
        [{ id: "cap-1", text, numbersVerified: true }],
        null,
        { target },
    )[0];

// Verifies the chunk texts appear in the rendered line, in order, without
// rewriting any separator. This is what makes the highlight possible at all:
// the renderer matches word text as a literal substring of the drawn line.
function assertChunksFollowDisplayText(chunks, line) {
    let cursor = 0;
    for (const chunk of chunks) {
        const index = line.indexOf(chunk.text, cursor);
        assert.ok(index >= cursor, `chunk ${JSON.stringify(chunk.text)} must appear in order inside ${JSON.stringify(line)}`);
        cursor = index + chunk.text.length;
    }
}

describe("Phrase karaoke: every dropdown language derives synchronized chunks", () => {
    it("covers exactly the nine languages in the Translation dropdown", () => {
        assert.deepEqual(Object.keys(TRANSLATION_LANGUAGES).sort(), ["ar", "de", "en", "es", "fr", "hi", "pt", "ru", "zh"]);
        assert.deepEqual(Object.keys(translations).sort(), Object.keys(TRANSLATION_LANGUAGES).sort());
    });

    for (const [code, text] of Object.entries(translations)) {
        describe(`${code} (${TRANSLATION_LANGUAGES[code]})`, () => {
            it("stores derived phrase timing separately and never as provider word timing", () => {
                const cue = translate(text, code);

                // The text changed, so the source words are gone...
                assert.equal(cue.text, text);
                assert.equal(cue.timingSource, "manual");
                assert.equal(Object.hasOwn(cue, "words"), false);
                // ...and the derived timing is clearly marked as derived.
                assert.ok(cue.phraseTiming, "derived phrase timing must be attached");
                assert.equal(cue.phraseTiming.timingSource, DERIVED);
                assert.equal(cue.wordTimingSource, DERIVED);

                // It must be impossible to mistake this for target-word alignment.
                assert.notEqual(cue.phraseTiming.timingSource, WORD_TIMING_SOURCES.TARGET_ALIGNMENT);
                assert.equal(Object.hasOwn(cue.phraseTiming, "alignedWords"), false);
                assert.equal(Object.hasOwn(cue.phraseTiming, "words"), false);
                for (const chunk of cue.phraseTiming.chunks) {
                    assert.equal(Object.hasOwn(chunk, "confidence"), false);
                    assert.equal(Object.hasOwn(chunk, "provider"), false);
                }
            });

            it("assigns each chunk a real source word window, not a uniform slice", () => {
                const cue = translate(text, code);
                const chunks = cue.phraseTiming.chunks;
                const expected = sourceWords();

                assert.equal(chunks.length, expected.length);
                for (let i = 0; i < chunks.length; i += 1) {
                    // Exactly the genuine provider interval, both edges.
                    assert.equal(chunks[i].start, expected[i].start);
                    assert.equal(chunks[i].end, expected[i].end);
                }

                // The last chunk stops at the last spoken word. It must not be
                // stretched to the cue end (11.6), which would be fabrication.
                assert.ok(chunks[chunks.length - 1].end < 11.6);
                // A uniform division would give equal 0.492s windows; these differ.
                const widths = chunks.map((chunk) => chunk.end - chunk.start);
                assert.notDeepEqual(widths, [0.492, 0.492, 0.492].map((n) => Number(n.toFixed(3))));
            });

            it("keeps chunk text a literal substring of the rendered line", () => {
                const cue = translate(text, code);
                assertChunksFollowDisplayText(cue.phraseTiming.chunks, cue.text);
            });

            it("advances the highlighted phrase at the source timestamp boundaries", () => {
                const cue = translate(text, code);
                const timing = resolveKaraokeWordTiming(cue);
                assert.equal(timing.usable, true);
                assert.equal(timing.withheld, false);
                assert.equal(timing.source, DERIVED);

                // [10.125, 10.6) -> 0, [10.6, 10.75) -> 1, [10.75, 11.2) -> 2.
                assert.equal(getActiveWordIndex(timing.words, 10.3, cue), 0);
                assert.equal(getActiveWordIndex(timing.words, 10.6, cue), 1);
                assert.equal(getActiveWordIndex(timing.words, 10.7, cue), 1);
                assert.equal(getActiveWordIndex(timing.words, 10.75, cue), 2);
                assert.equal(getActiveWordIndex(timing.words, 11.0, cue), 2);
                // After the last spoken word but still inside the cue: no stale
                // highlight. Before the cue begins: nothing active either.
                assert.equal(getActiveWordIndex(timing.words, 11.3, cue), -1);
                assert.equal(getActiveWordIndex(timing.words, 10.0, cue), -1);
                // The cue's first source word starts at the cue start, so there is
                // no silent pre-roll: 10.2 is already inside the first phrase.
                assert.equal(getActiveWordIndex(timing.words, 10.2, cue), 0);
            });

            it("highlights exactly one phrase in the renderer at a time", () => {
                const cue = translate(text, code);
                const words = resolveKaraokeWordTiming(cue).words;

                for (const [time, expectedIndex] of [[10.3, 0], [10.65, 1], [11.0, 2]]) {
                    const activeIndex = getActiveWordIndex(words, time, cue);
                    assert.equal(activeIndex, expectedIndex);

                    const { chunks } = splitLineIntoWordChunks(cue.text, words, 0, activeIndex);
                    // The renderer receives the untrimmed chunk text and trims it.
                    assert.equal(chunks.filter((chunk) => chunk.isActive).length, 1);
                    const active = chunks.find((chunk) => chunk.isActive);
                    assert.equal(active.wordIndex, expectedIndex);
                    assert.equal(active.text, words[expectedIndex].text.trim());
                    // Nothing is dropped or reordered while chunking the line.
                    assert.equal(chunks.map((chunk) => chunk.text).join(""), cue.text);
                }
            });

            it("records the target language as provenance only", () => {
                const cue = translate(text, code);
                assert.equal(cue.phraseTiming.language, code);
                assert.equal(cue.phraseTiming.sourceWordCount, 3);
            });
        });
    }
});

describe("Phrase karaoke: scripts and punctuation", () => {
    it("segments Chinese without any whitespace word separation", () => {
        const tokens = segmentTokensWithOffsets("现在打开端口");
        assert.ok(tokens.length > 1, "Chinese must yield multiple word-like segments");
        // Every offset must point at the real character, so slicing is verbatim.
        for (const token of tokens) {
            assert.equal("现在打开端口".slice(token.index, token.index + token.text.length), token.text);
        }

        const cue = translate(translations.zh, "zh");
        assert.ok(hasPhraseTiming(cue));
        assert.ok(cue.phraseTiming.chunks.length > 1);
        // No chunk text may contain a space, because the source line has none.
        for (const chunk of cue.phraseTiming.chunks) assert.equal(chunk.text.includes(" "), false);
    });

    it("segments Arabic and keeps right-to-left order intact", () => {
        const tokens = segmentTokensWithOffsets("افتح الميناء الآن");
        assert.equal(tokens.length, 3);
        // Word order in the string is the logical order the renderer draws.
        assert.deepEqual(tokens.map((token) => token.text), ["افتح", "الميناء", "الآن"]);
        assert.deepEqual(tokens.map((token) => token.index).length, 3);

        const cue = translate(translations.ar, "ar");
        const chunks = cue.phraseTiming.chunks;
        assert.deepEqual(chunks.map((chunk) => chunk.text), ["افتح", "الميناء", "الآن"]);
        // Timing still ascends even though the script is right to left.
        for (let i = 1; i < chunks.length; i += 1) assert.ok(chunks[i].start >= chunks[i - 1].start);
        assert.equal(getActiveWordIndex(resolveKaraokeWordTiming(cue).words, 10.65, cue), 1);
    });

    it("handles Devanagari and Cyrillic without special cases", () => {
        const hindi = translate(translations.hi, "hi");
        assert.deepEqual(hindi.phraseTiming.chunks.map((chunk) => chunk.text), ["अब", "बंदरगाह", "खोलो"]);

        const russian = translate(translations.ru, "ru");
        assert.deepEqual(russian.phraseTiming.chunks.map((chunk) => chunk.text), ["Открой", "порт", "сейчас"]);
    });

    it("slices against the display string so trailing punctuation is not captured", () => {
        // getCaptionDisplayText drops a trailing full stop for presentation. A
        // chunk must stay a substring of what is drawn, or it cannot highlight.
        const cue = translate("Abrir el puerto.", "es");
        assert.equal(cue.text, "Abrir el puerto.");
        const chunks = cue.phraseTiming.chunks;
        assert.equal(chunks[chunks.length - 1].text, "puerto");
        assertChunksFollowDisplayText(chunks, "Abrir el puerto");
    });

    it("keeps inner punctuation attached to the phrase that owns it", () => {
        const cue = translate("Abrir, el puerto ahora", "es");
        const chunks = cue.phraseTiming.chunks;
        // Commas and spacing survive verbatim inside the chunk they belong to.
        for (const chunk of chunks) {
            assert.ok(cue.text.includes(chunk.text));
        }
        assertChunksFollowDisplayText(chunks, "Abrir, el puerto ahora");
    });

    it("caps the number of highlight steps for long cues", () => {
        const many = Array.from({ length: 12 }, (_, index) => ({
            text: `w${index}`,
            start: 10 + index * 0.1,
            end: 10 + index * 0.1 + 0.1,
        }));
        const record = derivePhraseTiming({
            sourceWords: many,
            cueStart: 10,
            cueEnd: 12,
            targetText: "uno dos tres cuatro cinco seis siete ocho nueve diez once doce",
            language: "es",
        });
        assert.ok(record);
        assert.equal(record.chunks.length, MAX_PHRASE_GROUPS);
        assert.ok(record.chunks.length < many.length);
    });
});

describe("Phrase karaoke: preview and burned export share one resolver", () => {
    it("returns identical words, source and active phrase for both render paths", () => {
        for (const [code, text] of Object.entries(translations)) {
            const cue = translate(text, code);
            // CaptionOverlay (preview) and drawPreviewFrame (export) both call
            // resolveKaraokeWordTiming and feed its words to getActiveWordIndex.
            const preview = resolveKaraokeWordTiming(cue);
            const exported = resolveKaraokeWordTiming({ ...cue });

            assert.deepEqual(preview.words, exported.words);
            assert.equal(preview.source, exported.source);
            assert.equal(preview.usable, exported.usable);
            assert.equal(preview.withheld, exported.withheld);
            for (const time of [10.13, 10.3, 10.599, 10.6, 10.75, 11.0, 11.19]) {
                assert.equal(
                    getActiveWordIndex(preview.words, time, cue),
                    getActiveWordIndex(exported.words, time, cue),
                    `${code} preview and export must highlight the same phrase at ${time}`,
                );
            }
        }
    });

    it("wires the derived branch into the shared resolver, not a second path", () => {
        const resolver = readFileSync(new URL("../src/lib/karaoke.js", import.meta.url), "utf8");
        assert.match(resolver, /SOURCE_WORD_DERIVED_PHRASE/);
        assert.match(resolver, /getDerivedPhraseWords/);

        const overlay = readFileSync(new URL("../src/components/CaptionOverlay.jsx", import.meta.url), "utf8");
        const exporter = readFileSync(new URL("../src/lib/media.js", import.meta.url), "utf8");
        for (const source of [overlay, exporter]) {
            assert.match(source, /resolveKaraokeWordTiming/);
            assert.match(source, /wordTiming\.usable/);
            assert.match(source, /wordTiming\.withheld/);
        }
    });
});

describe("Phrase karaoke: original-language karaoke is unchanged", () => {
    it("keeps genuine word-level karaoke on the untranslated cue", () => {
        const cue = sourceCue();
        const timing = resolveKaraokeWordTiming(cue);
        assert.equal(timing.source, WORD_TIMING_SOURCES.SOURCE_ASR);
        assert.equal(timing.usable, true);
        assert.equal(timing.words, cue.words);
        assert.equal(getActiveWordIndex(timing.words, 10.3, cue), 0);
        assert.equal(getActiveWordIndex(timing.words, 10.7, cue), 1);
        assert.equal(getActiveWordIndex(timing.words, 11.0, cue), 2);
        // Word-by-word, not phrase-level: the original line keeps 3 highlight
        // steps bounded by its own word intervals.
        assert.equal(timing.words.length, 3);
        assert.equal(cue.phraseTiming, undefined);
    });

    it("leaves a translated sibling's source words and untranslated cues untouched", () => {
        const original = [sourceCue(), untouchedCue()];
        const snapshot = structuredClone(original);
        const next = applySubtitleTextReview(
            snapshot,
            snapshot,
            [
                { id: "cap-1", text: translations.es, numbersVerified: true },
                { id: "cap-2", text: "Keep this", numbersVerified: true },
            ],
            null,
            { target: "es" },
        );

        // The snapshot the editor can revert to is byte-identical.
        assert.deepEqual(snapshot, original);
        assert.deepEqual(snapshot[0].words, original[0].words);
        // An unchanged cue is passed through by reference.
        assert.equal(next[1], snapshot[1]);
        assert.equal(resolveKaraokeWordTiming(next[1]).source, WORD_TIMING_SOURCES.SOURCE_ASR);
    });
});

describe("Phrase karaoke: a failed alignment is not masked as phrase timing", () => {
    const invalidAlignment = () => ({
        status: "aligned",
        aligned: true,
        // Starts at 9.0, before the cue: rejected by validateAlignedWords.
        words: [{ text: "Abrir", start: 9.0, end: 10.2 }],
        unalignedIndices: [],
    });

    it("attaches nothing when an explicitly supplied alignment does not validate", () => {
        const cue = applySubtitleTextReview(
            [sourceCue()],
            [sourceCue()],
            [{ id: "cap-1", text: translations.es }],
            new Map([["cap-1", invalidAlignment()]]),
            { target: "es" },
        )[0];

        assert.equal(cue.alignedWords, undefined);
        assert.equal(cue.wordAlignment, undefined);
        // Degrading to a weaker phrase-level highlight would report a failed
        // word-level alignment as a success, so the cue stays plain.
        assert.equal(Object.hasOwn(cue, "phraseTiming"), false);
        assert.equal(resolveKaraokeWordTiming(cue).usable, false);
    });

    it("still derives phrase timing when alignment is simply not requested", () => {
        const cue = translate(translations.es, "es");
        assert.equal(resolveKaraokeWordTiming(cue).usable, true);
        assert.equal(cue.phraseTiming.language, "es");
    });

    it("prefers a valid alignment over derived phrase timing", () => {
        const aligned = {
            status: "aligned",
            aligned: true,
            provider: "fixture-aligner",
            words: [
                { text: "Abrir", start: 10.125, end: 10.6 },
                { text: "el", start: 10.6, end: 10.75 },
                { text: "puerto", start: 10.75, end: 11.2 },
            ],
            unalignedIndices: [],
        };
        const cue = applySubtitleTextReview(
            [sourceCue()],
            [sourceCue()],
            [{ id: "cap-1", text: translations.es }],
            new Map([["cap-1", aligned]]),
            { target: "es" },
        )[0];

        assert.equal(cue.wordTimingSource, WORD_TIMING_SOURCES.TARGET_ALIGNMENT);
        assert.equal(Object.hasOwn(cue, "phraseTiming"), false);
        assert.equal(resolveKaraokeWordTiming(cue).source, WORD_TIMING_SOURCES.TARGET_ALIGNMENT);
    });
});

describe("Phrase karaoke: switching languages stays stable", () => {
    it("does not corrupt timings when flipping between original and translated", () => {
        const original = [sourceCue()];
        const snapshot = structuredClone(original);
        const translated = applySubtitleTextReview(
            snapshot,
            snapshot,
            [{ id: "cap-1", text: translations.fr, numbersVerified: true }],
            null,
            { target: "fr" },
        );

        // Original still resolves its own word-level timing.
        assert.deepEqual(snapshot, original);
        assert.equal(getActiveWordIndex(snapshot[0].words, 10.3, snapshot[0]), 0);
        // Translated resolves phrase-level timing derived from the same intervals.
        assert.equal(getActiveWordIndex(resolveKaraokeWordTiming(translated[0]).words, 10.3, translated[0]), 0);
        // Neither cue borrowed the other's array.
        assert.equal(Object.hasOwn(translated[0], "words"), false);
        assert.equal(translated[0].phraseTiming.sourceWordCount, 3);
    });

    it("re-derives phrase timing on re-translation after the cue's words are gone", () => {
        let cues = [sourceCue()];
        cues = applySubtitleTextReview(
            structuredClone(cues),
            structuredClone(cues),
            [{ id: "cap-1", text: translations.es }],
            null,
            { target: "es" },
        );
        assert.equal(cues[0].phraseTiming.language, "es");

        // The cue no longer has `words`; the record's read-only copy of the
        // genuine source intervals keeps synchronization available.
        assert.equal(Object.hasOwn(cues[0], "words"), false);
        const retranslated = applySubtitleTextReview(
            structuredClone(cues),
            structuredClone(cues),
            [{ id: "cap-1", text: translations.de }],
            null,
            { target: "de" },
        );

        assert.equal(retranslated[0].text, translations.de);
        assert.equal(retranslated[0].phraseTiming.language, "de");
        assert.deepEqual(
            retranslated[0].phraseTiming.chunks.map((chunk) => [chunk.start, chunk.end]),
            [[10.125, 10.6], [10.6, 10.75], [10.75, 11.2]],
        );
        assert.equal(retranslated[0].wordTimingSource, DERIVED);
        assert.equal(Object.hasOwn(retranslated[0], "words"), false);
    });

    it("produces the same record for identical input", () => {
        const first = translate(translations.pt, "pt");
        const second = translate(translations.pt, "pt");
        assert.deepEqual(first.phraseTiming, second.phraseTiming);
    });
});

describe("Phrase karaoke: no usable source timing means no false highlight", () => {
    it("falls back to plain phrases when the cue has no word timing", () => {
        const bare = { ...sourceCue() };
        delete bare.words;

        const next = applySubtitleTextReview(
            [bare],
            [bare],
            [{ id: "cap-1", text: translations.es }],
            null,
            { target: "es" },
        );
        const cue = next[0];

        assert.equal(cue.text, translations.es);
        assert.equal(Object.hasOwn(cue, "phraseTiming"), false);
        assert.equal(Object.hasOwn(cue, "wordTimingSource"), false);
        assert.equal(hasPhraseTiming(cue), false);

        // The resolver reports honestly: not usable, and not "withheld" either,
        // because there was never any timing to withhold.
        const timing = resolveKaraokeWordTiming(cue);
        assert.equal(timing.usable, false);
        assert.equal(timing.withheld, false);
        assert.equal(timing.words, null);

        // The renderer draws one plain chunk with no active phrase.
        const { chunks } = splitLineIntoWordChunks(cue.text, timing.words, 0, -1);
        assert.equal(chunks.length, 1);
        assert.equal(chunks[0].isWord, false);
        assert.equal(chunks[0].isActive, false);
        assert.equal(chunks[0].text, translations.es);
    });

    it("refuses malformed or out-of-cue source intervals whole", () => {
        const cases = {
            "out of cue": [{ text: "a", start: 10.2, end: 11.2 }, { text: "b", start: 11.2, end: 11.9 }],
            "backwards": [{ text: "a", start: 10.8, end: 10.4 }, { text: "b", start: 10.8, end: 11.2 }],
            "non-monotonic": [{ text: "a", start: 10.9, end: 11.0 }, { text: "b", start: 10.2, end: 10.5 }],
            "non-numeric": [{ text: "a", start: "x", end: 10.6 }, { text: "b", start: 10.6, end: 11.2 }],
            "incomplete": [{ text: "a", start: Number.NaN, end: 10.6 }],
        };

        for (const [label, words] of Object.entries(cases)) {
            assert.equal(normalizeSourceWordIntervals(words, 10.125, 11.6), null, `${label} must be rejected`);
            const record = derivePhraseTiming({
                sourceWords: words,
                cueStart: 10.125,
                cueEnd: 11.6,
                targetText: translations.es,
                language: "es",
            });
            assert.equal(record, null, `${label} must not produce a derived record`);
        }
    });

    it("does not fake progression from a single source word", () => {
        const record = derivePhraseTiming({
            sourceWords: [{ text: "Open", start: 10.125, end: 11.2 }],
            cueStart: 10.125,
            cueEnd: 11.6,
            targetText: translations.es,
            language: "es",
        });
        // One interval cannot progress; a single full-line highlight would read
        // as a broken highlight rather than synchronization.
        assert.equal(record, null);
    });

    it("derives from two source words once progression is possible", () => {
        const record = derivePhraseTiming({
            sourceWords: [{ text: "Open", start: 10.125, end: 10.6 }, { text: "port", start: 10.6, end: 11.2 }],
            cueStart: 10.125,
            cueEnd: 11.6,
            targetText: translations.es,
            language: "es",
        });
        assert.ok(record);
        assert.equal(record.chunks.length, 2);
        assert.equal(record.chunks[0].start, 10.125);
        assert.equal(record.chunks[record.chunks.length - 1].end, 11.2);
    });

    it("withholds a stored record that no longer validates", () => {
        const cue = translate(translations.es, "es");
        cue.phraseTiming = {
            ...cue.phraseTiming,
            chunks: [{ text: "Abrir", start: 9.0, end: 10.2 }, { text: "el puerto", start: 10.6, end: 11.2 }],
        };
        const timing = resolveKaraokeWordTiming(cue);
        assert.equal(timing.usable, false);
        assert.equal(timing.withheld, true);
        assert.equal(timing.words, null);
    });
});

describe("Phrase karaoke: validation mirrors what the renderer accepts", () => {
    const record = () => derivePhraseTiming({
        sourceWords: sourceWords(),
        cueStart: 10.125,
        cueEnd: 11.6,
        targetText: translations.es,
        language: "es",
    });

    it("accepts a well formed record", () => {
        assert.equal(validatePhraseTiming(record(), sourceCue()), true);
        assert.equal(hasPhraseTiming(translate(translations.es, "es")), true);
    });

    it("requires the derived provenance marker", () => {
        const forged = { ...record(), timingSource: "target-alignment" };
        assert.equal(validatePhraseTiming(forged, sourceCue()), false);
        // A cue carrying a phrase record without the marker must not resolve.
        const cue = { ...sourceCue(), phraseTiming: forged, wordTimingSource: DERIVED };
        assert.equal(getDerivedPhraseWords(cue), null);
    });

    it("rejects empty chunks, empty text and out-of-cue windows", () => {
        const base = record();
        assert.equal(validatePhraseTiming({ ...base, chunks: [] }, sourceCue()), false);
        assert.equal(validatePhraseTiming({ ...base, chunks: [{ text: "  ", start: 10.2, end: 10.5 }] }, sourceCue()), false);
        assert.equal(validatePhraseTiming({ ...base, chunks: [{ text: "a", start: 9.0, end: 10.2 }] }, sourceCue()), false);
        assert.equal(validatePhraseTiming({ ...base, chunks: [{ text: "a", start: 10.2, end: 12.0 }] }, sourceCue()), false);
        assert.equal(validatePhraseTiming({ ...base, chunks: [{ text: "a", start: 10.8, end: 10.4 }] }, sourceCue()), false);
        assert.equal(validatePhraseTiming(null, sourceCue()), false);
    });

    it("rejects non-monotonic chunk starts", () => {
        const base = record();
        const backwards = {
            ...base,
            chunks: [{ text: "Abrir", start: 10.75, end: 11.2 }, { text: "el puerto", start: 10.6, end: 11.0 }],
        };
        assert.equal(validatePhraseTiming(backwards, sourceCue()), false);
    });

    it("allows overlapping windows, because real ASR intervals overlap", () => {
        // validateSegmentWords only requires monotonic non-decreasing starts, so a
        // stricter rule here would silently discard timing the renderer can use.
        const overlapping = {
            timingSource: DERIVED,
            cueStart: 10.125,
            cueEnd: 11.6,
            chunks: [
                { text: "Abrir", start: 10.0, end: 10.6 },
                { text: "el puerto", start: 10.4, end: 11.2 },
            ],
        };
        assert.equal(validatePhraseTiming(overlapping, { start: 10, end: 11.6 }), true);
    });

    it("never copies source word text into the derived record", () => {
        const base = record();
        assert.deepEqual(Object.keys(base.sourceIntervals[0]).sort(), ["end", "start"]);
        assert.equal(JSON.stringify(base).includes("Open"), false);
        assert.equal(JSON.stringify(base).includes("\"the\""), false);
    });

    it("describes the limitation without claiming word alignment", () => {
        const text = describePhraseTimingStatus(record());
        assert.match(text, /phrase/i);
        assert.match(text, /not target-language word alignment/i);
        assert.equal(/genuine word-level/i.test(text), false);
        assert.match(describePhraseTimingStatus(null), /unavailable/i);
    });
});
