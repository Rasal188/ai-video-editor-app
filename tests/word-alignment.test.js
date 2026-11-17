import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
    ALIGNMENT_UNAVAILABLE_REASONS,
    alignTranslatedWords,
    attachAlignmentToCue,
    createUnalignedWordSkeleton,
    createUnavailableAlignment,
    describeAlignmentStatus,
    getAlignmentCapability,
    isFullyAlignedForKaraoke,
    normalizeAlignmentResult,
    validateAlignedWords,
} from "../src/lib/wordAlignment.js";
import {
    createTargetWordTiming,
    getActiveWordIndex,
    hasKaraokeTiming,
    hasUsableWordTiming,
    isKaraokeEnabled,
    resolveKaraokeWordTiming,
} from "../src/lib/karaoke.js";
import { applySubtitleTextReview } from "../src/lib/subtitleTextTools.js";

// These fixtures are hand-written intervals. They prove the storage, selection,
// validation and refusal plumbing only. They are NOT evidence that any aligner
// produces acoustically correct timings - no aligner is bundled with this build.

const ENGLISH_CUE = {
    id: "cap-1",
    start: 10.0,
    end: 11.2,
    text: "Open the port now",
    words: [
        { text: "Open", start: 10.0, end: 10.3 },
        { text: "the", start: 10.3, end: 10.5 },
        { text: "port", start: 10.5, end: 10.8 },
        { text: "now", start: 10.8, end: 11.1 },
    ],
};

const UNTOUCHED_CUE = {
    id: "cap-2",
    start: 12.0,
    end: 13.0,
    text: "Second line",
    words: [
        { text: "Second", start: 12.0, end: 12.4 },
        { text: "line", start: 12.4, end: 12.9 },
    ],
};

const SPANISH_TEXT = "Abrir el puerto ahora";
const SPANISH_TOKENS = SPANISH_TEXT.split(" ");

// Deterministic fixture aligner. Values are chosen by hand, not measured.
const fixtureAlignedWords = (offset = 0) => [
    { start: 10.0 + offset, end: 10.3 + offset, confidence: 0.91 },
    { start: 10.3 + offset, end: 10.5 + offset, confidence: 0.88 },
    { start: 10.5 + offset, end: 10.8 + offset, confidence: 0.93 },
    { start: 10.8 + offset, end: 11.1 + offset, confidence: 0.9 },
];

const fixtureAligner = async ({ tokens, cueStart }) => ({
    aligned: true,
    provider: "fixture-aligner",
    language: "es",
    words: fixtureAlignedWords().slice(0, tokens.length).map((word) => ({ ...word, start: cueStart + (word.start - 10), end: cueStart + (word.end - 10) })),
});

async function alignedRecord({ tokens = SPANISH_TOKENS, cueStart = 10.0, cueEnd = 11.2 } = {}) {
    return alignTranslatedWords({
        audio: null,
        tokens,
        cueStart,
        cueEnd,
        language: "es",
        aligner: fixtureAligner,
    });
}

describe("Word alignment: capability is reported honestly", () => {
    it("refuses to align when no aligner is configured", async () => {
        const record = await alignTranslatedWords({ tokens: SPANISH_TOKENS, cueStart: 10, cueEnd: 11.2, language: "es" });
        assert.equal(record.aligned, false);
        assert.equal(record.status, "unavailable");
        assert.equal(record.reason, ALIGNMENT_UNAVAILABLE_REASONS.NO_PROVIDER);
        assert.equal(record.words, null);
    });

    it("reports the build capability without claiming acoustic accuracy", () => {
        const unavailable = getAlignmentCapability();
        assert.equal(unavailable.available, false);
        assert.equal(unavailable.reason, ALIGNMENT_UNAVAILABLE_REASONS.NO_PROVIDER);
        assert.match(unavailable.description, /no target-language word aligner/i);
        assert.equal(getAlignmentCapability(fixtureAligner).available, true);
    });

    it("never fabricates a reason or a message that implies success", () => {
        const record = createUnavailableAlignment(ALIGNMENT_UNAVAILABLE_REASONS.NO_PROVIDER);
        const message = describeAlignmentStatus(record);
        assert.match(message, /unavailable/i);
        assert.match(message, /not reused/i);
        assert.doesNotMatch(message, /synchroni[sz]ed|accurate/i);
    });

    it("builds an unaligned skeleton rather than spreading the cue duration", () => {
        const skeleton = createUnalignedWordSkeleton(SPANISH_TOKENS);
        assert.equal(skeleton.length, SPANISH_TOKENS.length);
        assert.ok(skeleton.every((word) => word.start === null && word.end === null && word.aligned === false));
    });
});

describe("Word alignment: English karaoke is unchanged", () => {
    it("still resolves source ASR timing for an untouched English cue", () => {
        const timing = resolveKaraokeWordTiming(ENGLISH_CUE);
        assert.equal(timing.usable, true);
        assert.equal(timing.source, "source-asr");
        assert.equal(timing.withheld, false);
        assert.equal(timing.words, ENGLISH_CUE.words);
        assert.equal(hasKaraokeTiming(ENGLISH_CUE), true);
        assert.equal(hasUsableWordTiming(ENGLISH_CUE), true);
        assert.equal(getActiveWordIndex(timing.words, 10.65, ENGLISH_CUE), 2);
    });

    it("keeps isKaraokeEnabled as a style-only predicate", () => {
        assert.equal(isKaraokeEnabled({ karaoke: true }, ENGLISH_CUE), true);
        assert.equal(isKaraokeEnabled({}, ENGLISH_CUE), false);
        // The frozen legacy contract: a style request is still reported even when
        // the cue carries no usable timing, so the UI can explain the mismatch.
        assert.equal(isKaraokeEnabled({ karaoke: true }, { start: 0, end: 1, words: undefined }), true);
    });
});

describe("Word alignment: translated cues use target timing only when genuine", () => {
    it("stores validated target timing separately from source words", async () => {
        const record = await alignedRecord();
        assert.equal(record.aligned, true);
        assert.equal(record.status, "aligned");
        assert.deepEqual(record.unalignedIndices, []);

        const cue = attachAlignmentToCue({ ...ENGLISH_CUE, text: SPANISH_TEXT, words: undefined }, record);
        assert.equal(cue.wordTimingSource, "target-alignment");
        assert.equal(cue.alignedWords.length, SPANISH_TOKENS.length);
        assert.equal(cue.alignedWords[0].text, "Abrir");
        assert.equal(cue.alignedWords[3].text, "ahora");

        const timing = resolveKaraokeWordTiming(cue);
        assert.equal(timing.source, "target-alignment");
        assert.equal(timing.usable, true);
        assert.equal(timing.words, cue.alignedWords);
    });

    it("follows the target word array at the reported times", async () => {
        const record = await alignedRecord();
        const cue = attachAlignmentToCue({ ...ENGLISH_CUE, text: SPANISH_TEXT, words: undefined }, record);
        const { words } = resolveKaraokeWordTiming(cue);
        assert.equal(getActiveWordIndex(words, 10.15, cue), 0);
        assert.equal(getActiveWordIndex(words, 10.4, cue), 1);
        assert.equal(getActiveWordIndex(words, 10.65, cue), 2);
        assert.equal(getActiveWordIndex(words, 11.0, cue), 3);
    });

    it("withholds karaoke for a translated cue with no alignment", () => {
        const translated = { ...ENGLISH_CUE, text: SPANISH_TEXT, words: undefined, timingSource: "manual" };
        const timing = resolveKaraokeWordTiming(translated);
        assert.equal(timing.usable, false);
        assert.equal(timing.source, null);
        // No timing at all is not the same as timing that failed validation.
        assert.equal(timing.withheld, false);
        assert.equal(hasKaraokeTiming(translated), false);
    });

    it("reports punctuation-preserving tokens", async () => {
        const tokens = ["Abrir,", "el", "puerto.", "¿Ahora?"];
        const record = await alignTranslatedWords({ tokens, cueStart: 10.0, cueEnd: 11.2, language: "es", aligner: fixtureAligner });
        assert.equal(record.aligned, true);
        assert.deepEqual(record.words.map((word) => word.text), tokens);
    });
});

describe("Word alignment: unaligned words never receive invented timing", () => {
    it("refuses the whole cue when any word is unaligned", async () => {
        const record = normalizeAlignmentResult(
            {
                aligned: true,
                provider: "fixture-aligner",
                words: [
                    { start: 10.0, end: 10.3 },
                    { start: 10.4, end: 10.6, aligned: false },
                    { start: 10.8, end: 11.1 },
                ],
            },
            { tokens: ["Abrir", "el", "ahora"], cueStart: 10.0, cueEnd: 11.2 },
        );
        assert.equal(record.aligned, true);
        assert.deepEqual(record.unalignedIndices, [1]);
        assert.equal(record.words[1].aligned, false);
        assert.equal(isFullyAlignedForKaraoke(record, 10.0, 11.2), false);

        const cue = { ...ENGLISH_CUE, text: "Abrir el ahora", words: undefined, alignedWords: record.words, wordAlignment: record };
        const timing = resolveKaraokeWordTiming(cue);
        assert.equal(timing.usable, false);
        assert.equal(timing.withheld, true);
        assert.match(describeAlignmentStatus(record), /could not be aligned/i);
    });

    it("keeps the translated text when alignment fails", async () => {
        const failing = async () => { throw new Error("aligner offline"); };
        const record = await alignTranslatedWords({ tokens: SPANISH_TOKENS, cueStart: 10, cueEnd: 11.2, aligner: failing });
        assert.equal(record.aligned, false);
        assert.equal(record.reason, ALIGNMENT_UNAVAILABLE_REASONS.PROVIDER_FAILED);

        const snapshot = structuredClone([ENGLISH_CUE]);
        const next = applySubtitleTextReview(snapshot, snapshot, [{ id: "cap-1", text: SPANISH_TEXT, numbersVerified: true }]);
        assert.equal(next[0].text, SPANISH_TEXT);
        assert.equal(next[0].words, undefined);
        assert.equal(next[0].alignedWords, undefined);
        assert.equal(next[0].wordAlignment, undefined);
        assert.equal(hasUsableWordTiming(next[0]), false);
    });
});

describe("Word alignment: invalid timings are rejected whole", () => {
    const cases = [
        ["out of cue range", [{ start: 9.0, end: 10.2 }]],
        ["overlapping intervals", [{ start: 10.0, end: 10.6 }, { start: 10.4, end: 10.8 }]],
        ["end before start", [{ start: 10.5, end: 10.2 }]],
        ["negative start", [{ start: -1, end: 10.2 }]],
        ["non-numeric interval", [{ start: "x", end: 10.2 }]],
        ["confidence outside 0..1", [{ start: 10.0, end: 10.3, confidence: 4 }]],
    ];

    for (const [label, words] of cases) {
        it(`rejects ${label}`, () => {
            const padded = words.map((word, index) => ({ text: index === 0 ? "Abrir" : "ahora", ...word }));
            assert.equal(validateAlignedWords(padded, 10.0, 11.2).valid, false);
            const record = normalizeAlignmentResult(
                { aligned: true, provider: "fixture-aligner", words },
                { tokens: padded.map((word) => word.text), cueStart: 10.0, cueEnd: 11.2 },
            );
            assert.equal(record.aligned, false);
            assert.equal(record.reason, ALIGNMENT_UNAVAILABLE_REASONS.INVALID_RESULT);
            assert.equal(record.words, null);
        });
    }

    it("rejects a word-count mismatch instead of pairing tokens by guess", () => {
        const record = normalizeAlignmentResult(
            { aligned: true, words: [{ start: 10.0, end: 10.3 }] },
            { tokens: SPANISH_TOKENS, cueStart: 10.0, cueEnd: 11.2 },
        );
        assert.equal(record.reason, ALIGNMENT_UNAVAILABLE_REASONS.WORD_COUNT_MISMATCH);
        assert.equal(record.words, null);
    });

    it("does not attach an invalid record during apply", () => {
        const snapshot = structuredClone([ENGLISH_CUE]);
        const invalid = { status: "aligned", aligned: true, words: [{ text: "Abrir", start: 9.0, end: 10.2 }], unalignedIndices: [] };
        const next = applySubtitleTextReview(
            snapshot,
            snapshot,
            [{ id: "cap-1", text: SPANISH_TEXT, numbersVerified: true }],
            new Map([["cap-1", invalid]]),
        );
        assert.equal(next[0].alignedWords, undefined);
        assert.equal(next[0].wordAlignment, undefined);
        assert.equal(hasKaraokeTiming(next[0]), false);
    });
});

describe("Word alignment: short and long cues", () => {
    it("handles a single short word inside a short cue", async () => {
        const record = await alignTranslatedWords({
            tokens: ["Sí"],
            cueStart: 20.0,
            cueEnd: 20.3,
            aligner: async ({ cueStart, cueEnd }) => ({ aligned: true, provider: "fixture-aligner", words: [{ start: cueStart, end: cueEnd }] }),
        });
        assert.equal(record.aligned, true);
        assert.equal(record.words.length, 1);
    });

    it("handles a long cue without stretching the last word past it", async () => {
        const tokens = Array.from({ length: 9 }, (_, index) => `w${index}`);
        const record = await alignTranslatedWords({
            tokens,
            cueStart: 30.0,
            cueEnd: 36.0,
            aligner: async () => ({
                aligned: true,
                provider: "fixture-aligner",
                // Deliberately leaves a trailing pause: alignment must not extend words
                // to fill the cue.
                words: tokens.map((_, index) => ({ start: 30.0 + index * 0.4, end: 30.3 + index * 0.4 })),
            }),
        });
        assert.equal(record.aligned, true);
        assert.equal(record.words.at(-1).end, 33.5);
        assert.ok(record.words.at(-1).end < 36.0);
    });
});

describe("Word alignment: cancellation and repeated translation", () => {
    it("returns an abort record and applies nothing when cancelled", async () => {
        const controller = new AbortController();
        const record = await alignTranslatedWords({
            tokens: SPANISH_TOKENS,
            cueStart: 10,
            cueEnd: 11.2,
            signal: controller.signal,
            aligner: async ({ signal }) => {
                controller.abort();
                signal?.throwIfAborted?.();
                return { aligned: true, words: fixtureAlignedWords() };
            },
        });
        assert.equal(record.aligned, false);
        assert.equal(record.reason, ALIGNMENT_UNAVAILABLE_REASONS.PROVIDER_ABORTED);
    });

    it("classifies a timeout as unavailable instead of applying late timing", async () => {
        const record = await alignTranslatedWords({
            tokens: SPANISH_TOKENS,
            cueStart: 10,
            cueEnd: 11.2,
            aligner: async () => {
                const error = new Error("timed out");
                error.name = "TimeoutError";
                throw error;
            },
        });
        assert.equal(record.reason, ALIGNMENT_UNAVAILABLE_REASONS.PROVIDER_TIMEOUT);
    });

    it("repeated translation replaces timing instead of stacking it", async () => {
        const record = await alignedRecord();
        const first = applySubtitleTextReview(
            structuredClone([ENGLISH_CUE]),
            structuredClone([ENGLISH_CUE]),
            [{ id: "cap-1", text: SPANISH_TEXT, numbersVerified: true }],
            new Map([["cap-1", record]]),
        );
        assert.equal(first[0].alignedWords.length, 4);
        assert.equal(first[0].words, undefined);

        const second = applySubtitleTextReview(
            structuredClone(first),
            structuredClone(first),
            [{ id: "cap-1", text: SPANISH_TEXT, numbersVerified: true }],
            new Map([["cap-1", record]]),
        );
        assert.equal(second[0].alignedWords.length, 4);
        assert.deepEqual(second[0].alignedWords, first[0].alignedWords);
        assert.equal(second[0].words, undefined);
    });

    it("clears stale target timing when a later review has none", async () => {
        const record = await alignedRecord();
        const aligned = applySubtitleTextReview(
            structuredClone([ENGLISH_CUE]),
            structuredClone([ENGLISH_CUE]),
            [{ id: "cap-1", text: SPANISH_TEXT, numbersVerified: true }],
            new Map([["cap-1", record]]),
        );
        const retranslated = applySubtitleTextReview(
            structuredClone(aligned),
            structuredClone(aligned),
            [{ id: "cap-1", text: "Abrir el puerto ya", numbersVerified: true }],
        );
        assert.equal(retranslated[0].text, "Abrir el puerto ya");
        assert.equal(retranslated[0].alignedWords, undefined);
        assert.equal(retranslated[0].wordTimingSource, undefined);
        assert.equal(hasKaraokeTiming(retranslated[0]), false);
    });
});

describe("Word alignment: original timing survives a round trip", () => {
    it("keeps source words intact across translations and back", async () => {
        const original = structuredClone([ENGLISH_CUE, UNTOUCHED_CUE]);
        const record = await alignedRecord();
        const translated = applySubtitleTextReview(
            structuredClone(original),
            structuredClone(original),
            [{ id: "cap-1", text: SPANISH_TEXT, numbersVerified: true }],
            new Map([["cap-1", record]]),
        );
        // The source snapshot is never mutated, so the original language keeps its
        // genuine ASR timing.
        assert.deepEqual(original[0].words, ENGLISH_CUE.words);
        assert.equal(hasUsableWordTiming(original[0]), true);
        assert.equal(getActiveWordIndex(original[0].words, 10.65, original[0]), 2);

        // The translated cue carries the target timing separately.
        assert.equal(translated[0].wordTimingSource, "target-alignment");
        assert.equal(translated[0].words, undefined);
        assert.equal(getActiveWordIndex(resolveKaraokeWordTiming(translated[0]).words, 10.65, translated[0]), 2);

        // Restoring the original cue restores source-driven karaoke exactly.
        const restored = original.map((cue, index) => (index === 0 ? { ...cue } : translated[index]));
        const timing = resolveKaraokeWordTiming(restored[0]);
        assert.equal(timing.source, "source-asr");
        assert.equal(getActiveWordIndex(timing.words, 10.65, restored[0]), 2);
    });

    it("preserves ids, cue times, order and metadata", async () => {
        const cue = { ...ENGLISH_CUE, styleOverrides: { karaoke: true }, audioSegmentId: "audio-1" };
        const snapshot = structuredClone([cue, UNTOUCHED_CUE]);
        const record = await alignedRecord();
        const next = applySubtitleTextReview(snapshot, snapshot, [{ id: "cap-1", text: SPANISH_TEXT, numbersVerified: true }], new Map([["cap-1", record]]));
        assert.deepEqual(next.map((item) => item.id), ["cap-1", "cap-2"]);
        assert.deepEqual(next.map((item) => [item.start, item.end]), [[10.0, 11.2], [12.0, 13.0]]);
        assert.deepEqual(next[0].styleOverrides, { karaoke: true });
        assert.equal(next[0].audioSegmentId, "audio-1");
        assert.equal(next[1], snapshot[1]);
    });
});

describe("Word alignment: preview and export share one timing source", () => {
    it("resolves the same words and active index for both render paths", async () => {
        const record = await alignedRecord();
        const cue = attachAlignmentToCue({ ...ENGLISH_CUE, text: SPANISH_TEXT, words: undefined }, record);
        // CaptionOverlay and drawPreviewFrame both call resolveKaraokeWordTiming and
        // feed its result to getActiveWordIndex.
        const previewTiming = resolveKaraokeWordTiming(cue);
        const exportTiming = resolveKaraokeWordTiming(cue);
        for (const time of [10.15, 10.4, 10.65, 11.0, 11.15]) {
            assert.equal(
                getActiveWordIndex(previewTiming.words, time, cue),
                getActiveWordIndex(exportTiming.words, time, cue),
            );
        }
        assert.equal(previewTiming.source, exportTiming.source);
    });

    it("wires both renderers to the shared selector", () => {
        const overlay = readFileSync(new URL("../src/components/CaptionOverlay.jsx", import.meta.url), "utf8");
        const preview = readFileSync(new URL("../src/lib/media.js", import.meta.url), "utf8");
        for (const source of [overlay, preview]) {
            assert.match(source, /resolveKaraokeWordTiming/);
            assert.match(source, /wordTiming\.usable/);
            assert.match(source, /wordTiming\.withheld/);
        }
    });
});

describe("Word alignment: target timing storage is explicit", () => {
    it("createTargetWordTiming copies nothing when there are no words", () => {
        assert.deepEqual(createTargetWordTiming([]), {});
        assert.deepEqual(createTargetWordTiming(null), {});
    });

    it("marks the stored provenance so switching language is unambiguous", () => {
        const stored = createTargetWordTiming([{ text: "Sí", start: 1, end: 2 }]);
        assert.equal(stored.wordTimingSource, "target-alignment");
        assert.equal(stored.alignedWords[0].text, "Sí");
    });
});
