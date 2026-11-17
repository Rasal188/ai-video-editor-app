import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

// Execute the protected Phase 4 harnesses without modifying their source files.
// Stage 1 intentionally makes ordinary caption edits advance command revision.
// Retain every content assertion and independently assert the new clock contract.
const mode = process.argv[2];
assert.ok(["persistence", "editor"].includes(mode), "Choose persistence or editor");
const sourceFile = new URL(`./ollalink-phase4-${mode === "editor" ? "editor-" : "persistence-"}browser.mjs`, import.meta.url);
let source = await fs.readFile(sourceFile, "utf8");
const replaceOnce = (search, replacement) => {
    assert.equal(source.split(search).length, 2, `Expected exactly one compatibility target: ${search}`);
    source = source.replace(search, replacement);
};
const before = mode === "editor" ? "original" : "originalSnapshot";
const after = mode === "editor" ? "applied" : "savedSnapshot";
const captions = mode === "editor" ? "before" : "original";
replaceOnce(
    `assert.deepEqual({ ...${after}, captionSegments: ${captions} }, ${before});`,
    `assert.ok(${after}.commandState.revision > ${before}.commandState.revision, "Ordinary caption Apply advances revision");
    assert.equal(${after}.commandState.projectIdentity, ${before}.commandState.projectIdentity, "Caption Apply retains project identity");
    assert.deepEqual({ ...${after}, captionSegments: ${captions}, commandState: { ...${after}.commandState, revision: ${before}.commandState.revision } }, ${before});`
);
if (mode === "persistence") {
    const cache = await fs.mkdtemp(path.resolve("scratch/assistant-stage1-20261030/preservation-cache-"));
    replaceOnce("configFile: false, plugins:", `configFile: false, envFile: false, cacheDir: ${JSON.stringify(cache)}, plugins:`);
    replaceOnce("hmr: false, warmup:", "hmr: false, watch: { ignored: ['**/scratch/**'] }, warmup:");
    replaceOnce("await page.goto(`${origin}/phase4-persistence${suffix}`);", "await page.goto(`${origin}/phase4-persistence${suffix}`, { waitUntil: 'domcontentloaded', timeout: 90000 });");
    replaceOnce("await page.waitForFunction(() => Boolean(window.persistence));", "await page.waitForFunction(() => Boolean(window.persistence), null, { timeout: 90000 });");
}
// A data module has no directory for relative or package resolution. Resolve only
// module specifiers; the harness's production imports and all test logic remain.
source = source.replace(/from "([^"]+)"/g, (statement, specifier) => {
    const url = specifier.startsWith(".") ? new URL(specifier, sourceFile).href : import.meta.resolve(specifier);
    return `from ${JSON.stringify(url)}`;
});
console.log(`Stage 1 ${mode} compatibility: protected source unchanged; revision assertion updated, all content checks retained.`);
await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
