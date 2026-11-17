import assert from "node:assert/strict";
import { test } from "node:test";
import { isNumberOnlyNormalization, validateSubtitleTextResult } from "../src/lib/subtitleTextTools.js";
import { createOllalinkTextTools } from "../server/services/transcription/ollalinkTextTools.js";

const safe = [
    ["I have twenty five rupees", "I have 25 rupees"],
    ["The year is two thousand twenty six", "The year is 2026"],
    ["There are one hundred people", "There are 100 people"],
    ["My score is ninety nine", "My score is 99"],
    ["I bought three items", "I bought 3 items"],
    ["मेरे पास पच्चीस रुपये हैं", "मेरे पास 25 रुपये हैं"],
    ["The price is twenty five point five dollars", "The price is 25.5 dollars"],
    ["Call zero nine eight seven", "Call 0987"],
    ["Meet on twenty fifth May", "Meet on 25th May"],
    ["Item AB-25 costs five rupees", "Item AB-25 costs 5 rupees"],
    ["I have one hundred and five items", "I have 105 items"],
    ["Twenty-five rupees", "25 rupees"],
    ["We are one of a kind.", "We are one of a kind."],
    ["Phone 0987, date 2026-05-25, $25.50, IP 192.168.1.1", "Phone 0987, date 2026-05-25, $25.50, IP 192.168.1.1"],
];
for (const [input, output] of safe) test(`number-only structure permits fixture: ${input}`, async () => {
    assert.equal(isNumberOnlyNormalization(input, output), true);
    const run = createOllalinkTextTools({
        apiKey: "sk_fixture", fetchImpl: async (_url, options) => {
            const body = JSON.parse(options.body);
            return Response.json({ text: body.text, normalized: output, changed: input !== output, language: body.language, characters: Array.from(body.text).length });
        }
    });
    const request = { operation: "normalize", language: input.includes("मेरे") ? "hi" : "en", cues: [{ id: "c1", text: input }] };
    const result = await run(request);
    const retained = input.startsWith("Call ") || input.startsWith("Meet on ");
    assert.equal(validateSubtitleTextResult(result, request)[0].text, retained ? input : output);
    if (retained) assert.ok(result.results[0].reviewReasons.length);
});
for (const [input, output] of [
    ["I have twenty five rupees", "I own 25 coins"],
    ["I bought three items", "Compré 3 artículos"],
    ["My score is 99", "My score is 100"],
    ["Call 0987", "Call 987"],
    ["Price $25.50", "Price $25.5"],
    ["ID AB-25", "ID AB-26"],
    ["May 25, 2026", "May 26, 2026"],
    ["No numbers here", "No numbers here 3"],
    ["I have twenty five rupees", "I have 25 rupees!"],
]) test(`rejects rewriting or existing-number mutation: ${input}`, async () => {
    assert.equal(isNumberOnlyNormalization(input, output), false);
    const request = { operation: "normalize", language: "en", cues: [{ id: "c1", text: input }] };
    assert.throws(() => validateSubtitleTextResult({ operation: "normalize", results: [{ id: "c1", text: output, changed: true }] }, request));
    const run = createOllalinkTextTools({ apiKey: "sk_fixture", fetchImpl: async () => Response.json({ text: input, normalized: output, changed: true, language: "en", characters: Array.from(input).length }) });
    await assert.rejects(run(request), error => error.code === "OLLALINK_INVALID_RESPONSE");
});
test("frontend rejects inconsistent changed flag and missing, reordered, duplicate or incomplete cue results", () => {
    const request = { operation: "normalize", language: "en", cues: [{ id: "a", text: "three items" }, { id: "b", text: "five items" }] };
    const a = { id: "a", text: "3 items", changed: true };
    const b = { id: "b", text: "5 items", changed: true };
    for (const results of [[{ ...a, changed: false }, b], [a], [b, a], [a, a], [a, { ...b, text: "" }]]) assert.throws(() => validateSubtitleTextResult({ operation: "normalize", results }, request));
});
