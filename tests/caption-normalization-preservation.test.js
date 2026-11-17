import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { createOllalinkTextTools } from "../server/services/transcription/ollalinkTextTools.js";
import { createSubtitleToolsRouter } from "../server/routes/subtitleTools.js";
import { cookieParserMiddleware } from "../server/middleware/auth.js";
import { setupTestEnvironment, withServer } from "../server/tests/test-helpers.js";
import { applySubtitleTextReview, requestSubtitleTextTools, validateSubtitleTextResult } from "../src/lib/subtitleTextTools.js";

const safe = [
    ["I have twenty five rupees", "I have 25 rupees"],
    ["  I have twenty-five rupees.  ", "I have 25 rupees."],
    ["Three dollars; three point five kilograms", "3 dollars; 3.5 kilograms"],
    ["The year is two thousand twenty six", "The year is 2026"],
    ["There are one hundred and five people", "There are 105 people"],
    ["Item AB-25 costs five rupees", "Item AB-25 costs 5 rupees"],
    ["Keep 03/04/2026 and 0987, buy three items", "Keep 03/04/2026 and 0987, buy 3 items", true],
    ["Price $25.50 plus three dollars", "Price $25.50 plus 3 dollars"],
    ["मेरे पास पच्चीस रुपये हैं", "मेरे पास 25 रुपये हैं"],
];
const retained = [
    ["Meet March fourth", "Meet March 4th"],
    ["Date 03/04/2026", "Date 03/04/2026"],
    ["Call zero nine eight seven", "Call 0987"],
    ["Phone 0987", "Phone 0987"],
    ["Reference twenty five", "Reference 25"],
    ["Account one two three", "Account 123"],
    ["Code AB twenty five", "Code AB 25"],
    ["AB twenty five", "AB 25"],
    ["zero nine eight seven", "0987"],
    ["We are one of a kind", "We are 1 of a kind"],
    ["I have twenty five rupees", "I have 26 rupees"],
    ["Measure three point five meters", "Measure 35 meters"],
    ["Meet on twenty fifth May", "Meet on 25th May"],
    ["three\nfive items", "35 items"],
    ["It is four forty three", "It is 443"],
    ["zero nine eight seven", "zero nine eight seven"],
    ["Keep 0987", "Keep 0987"],
    ["Reach 212-555-0199", "Reach 212-555-0199"],
    ["It is four forty three", "It is four forty three"],
];
const adapter = proposed => createOllalinkTextTools({
    apiKey: "sk_fixture", fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        const normalized = typeof proposed === "function" ? proposed(body.text) : proposed;
        return Response.json({ text: body.text, normalized, changed: normalized !== body.text, language: body.language, characters: Array.from(body.text).length });
    }
});
const request = text => ({ operation: "normalize", language: text.includes("मेरे") ? "hi" : "en", cues: [{ id: "caption-1", text }] });
for (const [input, output, hold] of safe) test(`safe proposal preserves formatting/context: ${input}`, async () => {
    const result = await adapter(output)(request(input));
    const expected = hold ? input : input.includes("  ") ? "  I have 25 rupees.  " : output;
    assert.equal(result.results[0].text, expected);
    assert.equal(Boolean(result.results[0].reviewReasons?.length), Boolean(hold));
    validateSubtitleTextResult(result, request(input));
});
for (const [input, output] of retained) test(`retains and flags uncertain expression: ${input}`, async () => {
    const result = await adapter(output)(request(input));
    assert.equal(result.results[0].text, input);
    assert.equal(result.results[0].changed, false);
    assert.ok(result.results[0].reviewReasons.length);
    validateSubtitleTextResult(result, request(input));
});
for (const newline of ["\n", "\r\n", "\r"]) test(`flattened provider response preserves ${JSON.stringify(newline)} and paragraph spacing`, async () => {
    const input = `  I have twenty five rupees.${newline}${newline}\tI bought three items.  `;
    const output = "I have 25 rupees. I bought 3 items.";
    const result = await adapter(output)(request(input));
    assert.equal(result.results[0].text, `  I have 25 rupees.${newline}${newline}\tI bought 3 items.  `);
    validateSubtitleTextResult(result, request(input));
});
test("ordinary repeated spacing, punctuation and unchanged numeric literals survive provider whitespace changes", async () => {
    const input = "I  bought three items; price $25.50,  quantity 99.";
    const result = await adapter("I bought 3 items; price $25.50, quantity 99.")(request(input));
    assert.equal(result.results[0].text, "I  bought 3 items; price $25.50,  quantity 99.");
});
test("whitespace-only provider output is not treated as a text edit", async () => {
    const input = "No numbers.\r\n\r\n  Keep this.";
    const result = await adapter("No numbers. Keep this.")(request(input));
    assert.equal(result.results[0].text, input);
    assert.equal(result.results[0].changed, false);
});
test("existing numeric literals and identifiers cannot be changed", async () => {
    for (const [input, output] of [["Phone 0987", "Phone 987"], ["03/04/2026", "04/03/2026"], ["Price $25.50", "Price $25.5"], ["ID AB-25", "ID AB-26"]]) {
        await assert.rejects(adapter(output)(request(input)), error => error.code === "OLLALINK_INVALID_RESPONSE");
    }
});
test("client rejects flattened, uncertain or malformed review flags", () => {
    const input = request("three items\nfive people");
    for (const result of [
        { id: "caption-1", text: "3 items 5 people", changed: true },
        { id: "caption-1", text: input.cues[0].text, changed: false, reviewReasons: "date" },
        { id: "caption-1", text: input.cues[0].text, changed: false, reviewReasons: ["untrusted"] },
        { id: "caption-1", text: "3 items\n5 people", changed: true, reviewReasons: ["ambiguous-context"] }
    ]) assert.throws(() => validateSubtitleTextResult({ operation: "normalize", results: [result] }, input));
});
test("complete authenticated handler → adapter → client → explicit apply preserves multiple cues and CRLF", async () => {
    const env = await setupTestEnvironment();
    try {
        const { cookie } = await env.createSession("normalization-format@example.invalid");
        const app = express();
        app.use(cookieParserMiddleware);
        app.use("/api/subtitle-tools", createSubtitleToolsRouter({ processSubtitles: adapter(text => text.replaceAll("three", "3").replaceAll("five", "5").replace(/\s+/g, " ").trim()) }));
        const captions = [
            { id: "a", text: "three items\r\n\r\n  five people", start: 0.125, end: 2.875, audioSegmentId: "audio", styleOverrides: { color: "red" }, words: [{ text: "three", start: 0.125, end: 1 }], timingSource: "asr" },
            { id: "b", text: "Call three five", start: 3, end: 5, words: [{ text: "Call", start: 3, end: 4 }], timingSource: "asr" },
            { id: "c", text: "Unrelated", start: 6, end: 7 }
        ];
        const snapshot = structuredClone(captions);
        const input = { operation: "normalize", language: "en", cues: captions.slice(0, 2).map(({ id, text }) => ({ id, text })) };
        await withServer(app, async url => {
            const results = await requestSubtitleTextTools(input, { fetchImpl: (_path, options) => fetch(`${url}/api/subtitle-tools`, { ...options, headers: { ...options.headers, cookie, Origin: url } }) });
            assert.deepEqual(captions, snapshot); // Review/discard cannot mutate originals.
            assert.equal(results[0].text, "3 items\r\n\r\n  5 people");
            assert.equal(results[1].text, snapshot[1].text);
            assert.ok(results[1].reviewReasons.length);
            const after = applySubtitleTextReview(captions, snapshot, results);
            assert.deepEqual(after.map(({ id, start, end }) => ({ id, start, end })), snapshot.map(({ id, start, end }) => ({ id, start, end })));
            assert.deepEqual(after[0].styleOverrides, snapshot[0].styleOverrides);
            assert.equal(after[0].audioSegmentId, "audio");
            assert.equal(after[0].words, undefined); // Existing changed-text alignment policy.
            assert.equal(after[0].timingSource, "manual");
            assert.equal(after[1], captions[1]);
            assert.equal(after[2], captions[2]);
            assert.throws(() => applySubtitleTextReview(captions.map(c => ({ ...c, start: c.start + 1 })), snapshot, results));
        });
    } finally { await env.teardown(); }
});
