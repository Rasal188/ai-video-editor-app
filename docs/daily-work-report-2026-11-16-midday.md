# AI Video Editor — Daily Work Report — November 16, 2026

**Repository:** `ai-video-editor`
**Branch:** `main` (HEAD `139e283`, dated 2026-10-28 — no commits made today)
**Report prepared:** 2026-11-16, ~15:45 IST
**Method:** All claims below were verified against file modification timestamps, `git diff`/`git status`, freshly executed test/lint/typecheck/build runs, and direct source inspection performed during today's session. Nothing is reported on the basis of earlier summaries alone.

---

## 1. Work Completed Today

Today's work falls into two clearly separated phases: **implementation** (captions/Karaoke work, morning and early afternoon) and **debug investigation** (late afternoon, read-only). File modification timestamps establish the ordering:

| Time (IST, 2026-11-16) | File | Phase |
|---|---|---|
| 09:45 | `tests/caption-translated-karaoke.test.js` | Implementation — translated Karaoke contract |
| 11:04 | `src/lib/media.js`, `src/components/CaptionOverlay.jsx` | Implementation — shared-resolver wiring |
| 11:06 | `tests/word-alignment.test.js` | Implementation — alignment contract tests |
| 12:23 | `src/lib/wordAlignment.js` *(new)* | Implementation — alignment contract |
| 12:24 | `src/lib/karaoke.js` | Implementation — strict resolver |
| 12:30 | `src/components/SubtitleTextTools.jsx` *(new)* | Implementation — translation UI |
| 12:35 | `src/lib/phraseTiming.js` *(new)* | Implementation — phrase timing derivation |
| 12:43 | `src/lib/subtitleTextTools.js` *(new)* | Implementation — review application |
| 12:44 | `tests/caption-phrase-karaoke.test.js` *(new)* | Implementation — phrase Karaoke suite |
| ~15:17–15:43 | none (read-only) | **Debug investigation — no product code changed** |

### Phase A — Implementation

#### A1. Translated-caption Karaoke fix (original symptom)

**Objective.** Translated captions rendered in preview but the active-word Karaoke highlight did not appear.

**Investigation.** Traced the whole chain: caption-style state (`panels.jsx`), preview caption selection (`useTimelineModel.js`), burned-in export (`media.js`), drawing (`captionLayout.js`), persistence (`useProjectFiles.js`).

**Implemented.** Both render paths were rewired onto a single shared resolver so preview and exported video can never disagree:

- [`media.js:1516`](ai-video-editor/src/lib/media.js:1516) — export now calls `resolveKaraokeWordTiming(captionSegment)`, derives `displayWords`, and gates the highlight on `isKaraokeEnabled(...) && wordTiming.usable`.
- [`CaptionOverlay.jsx:79`](ai-video-editor/src/components/CaptionOverlay.jsx:79) — preview uses the identical call and gates.
- Both pass `displayWords` (not `captionSegment.words`) into `getActiveWordIndex` and into `drawCaptionLayout`, so a withheld record can never produce a highlight.

**Technical decision.** The resolver, not the renderer, owns the decision "is this timing trustworthy?". Renderers only consume `{ usable, withheld, words }`. This removed the previous situation where a renderer could fall back to `captionSegment.words` that had already been deleted by translation.

**Outcome.** Translated cues no longer highlight on unverifiable data, and where genuine source word intervals exist the highlight works.

#### A2. Genuine word-level alignment contract

**Objective.** Make the distinction between *real target-language word alignment* and *approximation* explicit and machine-checkable, so no downstream code can mistake one for the other.

**Implemented.** New [`wordAlignment.js`](ai-video-editor/src/lib/wordAlignment.js) (366 lines) providing:
- `WORD_TIMING_SOURCES` including `SOURCE_WORD_DERIVED_PHRASE: "source-word-derived-phrase"` ([`wordAlignment.js:56`](ai-video-editor/src/lib/wordAlignment.js:56)).
- `ALIGNMENT_UNAVAILABLE_REASONS`, `createUnavailableAlignment()`, `validateAlignedWords()`, `isFullyAlignedForKaraoke()`, `normalizeAlignmentResult()`, `attachAlignmentToCue()`, `getCueAlignment()`, `describeAlignmentStatus()`, `alignTranslatedWords()`, `getAlignmentCapability()`.

**Important architectural finding.** No aligner exists in this build. `getAlignmentCapability()` returns unavailable, and the UI uses it only to decide whether to show explanatory copy ([`SubtitleTextTools.jsx:104-137`](ai-video-editor/src/components/SubtitleTextTools.jsx:104)). Therefore target-language acoustic word alignment is an **implemented contract with no provider**, not a delivered feature.

#### A3. Language-independent phrase-level Karaoke

**Objective.** Give translated captions synchronized highlighting without inventing target-language timestamps.

**Core insight, documented verbatim in the module header** ([`phraseTiming.js:4-12`](ai-video-editor/src/lib/phraseTiming.js:4)): the source ASR word intervals describe *when the speaker was talking*, which is language-independent — "the second spoken word occupies the same slice of audio whatever language the caption is displayed in."

**Implemented.** New [`phraseTiming.js`](ai-video-editor/src/lib/phraseTiming.js) (354 lines):

- `segmentTokensWithOffsets()` — deterministic tokenization via `Intl.Segmenter` word granularity, so Chinese (no spaces), Arabic (RTL), Hindi and Latin scripts all work without per-language tables. Chunk text is **sliced from the rendered display string by offset**, so separators, spacing direction and punctuation survive verbatim.
- `normalizeSourceWordIntervals()` — validates source intervals against cue bounds.
- `derivePhraseTiming()` — groups translated text into sequential phrase chunks, each window being the union of real source word intervals. `MAX_PHRASE_GROUPS = 8` ([`phraseTiming.js:45`](ai-video-editor/src/lib/phraseTiming.js:45)) caps flicker.
- `validatePhraseTiming()`, `toPhraseKaraokeWords()`, `getDerivedPhraseWords()`, `attachPhraseTimingToCue()`, `describePhraseTimingStatus()`.

**Five design rules enforced in the module** ([`phraseTiming.js:14-33`](ai-video-editor/src/lib/phraseTiming.js:14)):
1. Nothing invented — no uniform division of cue duration, no interpolation.
2. Not target-language alignment — explicitly marked `timingSource: "source-word-derived-phrase"`.
3. Source `words` never written to — derived data lives in a separate `phraseTiming` record, so switching back to the source language restores genuine word-level Karaoke untouched.
4. Deterministic, script-independent tokenization.
5. **No usable source timing ⇒ no record at all**; the caption renders as plain phrases rather than pretending to be synchronized.

**Wired into translation.** [`subtitleTextTools.js:178`](ai-video-editor/src/lib/subtitleTextTools.js:178) — `applySubtitleTextReview()` calls `derivePhraseTiming()` at the moment the source `words` are still available, attaches `phraseTiming` + `wordTimingSource`, then releases `words`.

**Outcome.** Translated captions get real, source-timed phrase highlighting; the feature degrades to plain phrases (no false highlight) when source timing is absent.

### Phase B — Debug investigation (no code change)

**Objective (verbatim framing).** "Do not assume that implementation works just because its unit tests pass. Investigate the actual running application and the current project data."

**Symptom.** Spanish translated captions visible; `Karaoke (Active Word)` enabled; no yellow highlight during playback.

**What was investigated.**

1. **Setting propagation.** [`panels.jsx:1195`](ai-video-editor/src/components/panels.jsx:1195) `updateCaptionStyleField` writes either `styleOverrides.karaoke` on the selected caption or `captionStyle.karaoke` globally — exactly the two branches `isKaraokeEnabled()` reads. **Correct.**
2. **Persistence.** `getProjectSnapshot()` copies `captionSegments` verbatim ([`useProjectFiles.js:35`](ai-video-editor/src/hooks/useProjectFiles.js:35)); import spreads only `fontId` ([`useProjectFiles.js:352`](ai-video-editor/src/hooks/useProjectFiles.js:352)). **No stripping.**
3. **Preview selection.** [`useTimelineModel.js:145-156`](ai-video-editor/src/hooks/useTimelineModel.js:145) returns `{...item.segment, laneIndex}` — the stored object, spread only. **Correct.**
4. **Export selection.** [`media.js:2053-2056`](ai-video-editor/src/lib/media.js:2053) uses `exportSegments[segmentIndex]` — the same stored object. **Correct.**
5. **Drawing.** [`captionLayout.js:388-421`](ai-video-editor/src/lib/captionLayout.js:388) genuinely paints per-chunk `fillStyle`. **Correct.**
6. **Real modules on real ASR data.** Executed the real `captionSegmentsFromWords`, `applySubtitleTextReview(..., null, {target:"es"})`, `resolveKaraokeWordTiming`, `isKaraokeEnabled`, `getActiveWordIndex`, `getSegmentIndexAtTime` against the genuine Whisper fixture [`server/tests/fixtures/real-inference-result.json`](ai-video-editor/server/tests/fixtures/real-inference-result.json) (4 cues / 16 words). Details in §3 and §4.
7. **Real project archives.** Parsed every `.timeline` archive (ZIP) under `storage/projects`, `test-artifacts`, `scripts` with a dependency-free ZIP reader, extracting each embedded `project.json`.

**The discovery.** Every archive reports `phraseTiming=0` **and** `wts=0`. Filtered searches for `phraseTiming=\s*[1-9]`, `wts=\s*[1-9]` and `nonAscii=\s*[1-9]` all returned **no matches**. Representative rows:

| Archive | cues | words | phraseTiming | wts | karaoke |
|---|---|---|---|---|---|
| `storage\projects\0954a95b-…-rev1.timeline` | 47 | 47 | **0** | **0** | false |
| `test-artifacts\playwright\audit-complete\audit-exported-project.timeline` | 2 | 2 | **0** | **0** | false |
| `storage\projects\9977f140-…-rev1.timeline` | 6 | 0 | **0** | **0** | false |

Even the archive holding 47 ASR cues with 47 valid `words` has no derived phrase timing — those projects were saved with Karaoke off and never re-translated after `phraseTiming.js` existed.

**Why no product code change was made.** The failing stage is **data at rest**, not code. `applySubtitleTextReview()` deletes source `words` at translation time (required by the frozen contract in [`caption-translated-karaoke.test.js`](ai-video-editor/tests/caption-translated-karaoke.test.js)) and — only in the *current* code — attaches `phraseTiming` in the same pass. An already-translated cue from before that code therefore carries translated `text` with neither `words` nor `phraseTiming`. The resolver correctly returns `usable: false`, the active index is correctly `-1`, and the renderer correctly draws plain phrases. That is precisely the reported symptom, and it is correct behaviour.

Any of the candidate "fixes" would violate the stated restrictions: synthesising target-language timings breaks "do not invent target-language word timestamps"; relaxing `hasUsableWordTiming` breaks "do not weaken timing validation"; adding a new aligner breaks "do not introduce a new alignment service".

**Recommended recovery workflow.** Regenerate captions from source audio ([`panels.jsx:1593`](ai-video-editor/src/components/panels.jsx:1593) `generateCaptionsFromSourceAudio`) so cues regain ASR `words`, then re-apply the translation through the subtitle text tool. The current apply path then attaches `phraseTiming` automatically — verified at module level in §3. **This workflow has not yet been run in the user's live application** (see §5).

---

## 2. Files Changed

### 2.1 Changed or added **today** (verified by mtime 2026-11-16)

| File | Status | Diff | What changed / why |
|---|---|---|---|
| [`src/lib/phraseTiming.js`](ai-video-editor/src/lib/phraseTiming.js) | **new**, untracked | 354 lines | Source-word-derived phrase timing. Tasks A3. The heart of today's feature work. |
| [`src/lib/wordAlignment.js`](ai-video-editor/src/lib/wordAlignment.js) | **new**, untracked | 366 lines | Explicit alignment contract + `WORD_TIMING_SOURCES`. Task A2. |
| [`src/lib/subtitleTextTools.js`](ai-video-editor/src/lib/subtitleTextTools.js) | **new**, untracked | — | `applySubtitleTextReview()`; attaches `phraseTiming` at translation time. Tasks A1/A3. |
| [`src/components/SubtitleTextTools.jsx`](ai-video-editor/src/components/SubtitleTextTools.jsx) | **new**, untracked | — | Review UI calling apply with `alignments = null` and `{target}`. Tasks A1/A3. |
| [`src/lib/karaoke.js`](ai-video-editor/src/lib/karaoke.js) | modified | **+155 / −10** | Strict shared resolver: 4-level precedence, `withheld` semantics, phrase-chunk precedence. Task A1. |
| [`src/lib/media.js`](ai-video-editor/src/lib/media.js) | modified | **+113 / −103** | Export path switched from `captionSegment.words` to `resolveKaraokeWordTiming(...)` + `displayWords`. Substantive change is the resolver swap; the near-symmetric diff ratio indicates accompanying reformatting/line-ending normalisation. Task A1. |
| [`src/components/CaptionOverlay.jsx`](ai-video-editor/src/components/CaptionOverlay.jsx) | modified | **+25 / −11** | Preview path switched to the same shared resolver and gate. Task A1. |
| [`tests/caption-phrase-karaoke.test.js`](ai-video-editor/tests/caption-phrase-karaoke.test.js) | **new**, untracked | 31,060 bytes | 83 tests / 17 suites for phrase Karaoke. Task A3. |
| [`tests/caption-translated-karaoke.test.js`](ai-video-editor/tests/caption-translated-karaoke.test.js) | **new**, untracked | 13,172 bytes | 12 tests / 2 suites — freezes the translated-cue contract. Task A1. |
| [`tests/word-alignment.test.js`](ai-video-editor/tests/word-alignment.test.js) | **new**, untracked | 21,344 bytes | 32 tests / 10 suites — alignment contract. Task A2. |

No files were **deleted** as part of today's product work. Four throwaway diagnostic scripts created during Phase B (`scratch/diagnose-phrase-karaoke.mjs`, `scratch/diagnose-real-asr-phrase-karaoke.mjs`, `scratch/probe-real-project.mjs`, `scratch/scan-project-archives.mjs`) and their log files were removed after use; they were never part of the product.

### 2.2 Present in the working tree but **NOT** changed today

`git status` reports 63 modified tracked files and 136 untracked entries. The majority predate today. Verified by mtime, these commonly-cited caption files were **read only** today and carry no today's edits:

| File | Last modified |
|---|---|
| `src/components/panels.jsx` | 2026-11-02 |
| `src/hooks/useProjectFiles.js` | 2026-10-30 |
| `server/tests/caption-karaoke-sync.test.js` | 2026-10-27 |
| `src/lib/captionSegmentation.js` | 2026-10-19 |
| `src/lib/captionLayout.js` | 2026-10-14 |
| `src/hooks/useTimelineModel.js` | 2026-10-07 |

The remaining modified/untracked entries (Ollalink provider migration, TTS/diarization/transcription routes, `scripts/*`, `docs/*`, i18n additions, dozens of `server/tests/*`) belong to earlier work streams in the same long-lived working tree. **They are not attributable to today** and are listed here only for accuracy.

---

## 3. Testing and Verification

All numbers below were produced by commands run **today during this reporting task**, not taken from prior summaries.

### 3.1 Tests executed today

| Suite | Command | Result | Duration |
|---|---|---|---|
| Karaoke trio (phrase + translated + alignment) | `node --test tests/caption-phrase-karaoke.test.js tests/caption-translated-karaoke.test.js tests/word-alignment.test.js` | **127 pass / 127, 0 fail**, 29 suites | 0.49 s |
| ↳ `caption-phrase-karaoke.test.js` | `node --test …` | **83 pass, 0 fail**, 17 suites | 0.20 s |
| ↳ `caption-translated-karaoke.test.js` | `node --test …` | **12 pass, 0 fail**, 2 suites | 0.18 s |
| ↳ `word-alignment.test.js` | `node --test …` | **32 pass, 0 fail**, 10 suites | 0.22 s |
| Frontend aggregate | `node --test "tests/**/*.test.js"` | **549 pass / 549, 0 fail**, 29 suites | 13.0 s |
| Backend aggregate | `npm run test:backend` | **1245 pass / 1245, 0 fail**, 267 suites | 27.6 s |

**Note on counts.** The frontend (549) and backend (1245) totals are materially larger than the figures quoted in earlier sessions (235 / 104) because the respective globs now cover the untracked `tests/` directory and the untracked `server/tests/` Ollalink suites that this working tree accumulated. Same commands, wider file set — not a change in behaviour.

### 3.2 Static gates

| Gate | Command | Result |
|---|---|---|
| Lint | `npm run lint` | **405 problems — 0 errors, 405 warnings.** One auto-fixable warning. Warnings are pre-existing `react-refresh/only-export-components` and similar; no errors. |
| Typecheck | `npm run typecheck` (`tsc --noEmit`) | **Clean** — no output, no diagnostics. |
| Production build | `npm run build` (`vite build`) | **`✓ built in 34.56s`**. Standard chunk-size advisory: `editor-DEhIkDJ2.js` 8,084 kB (gzip 2,156 kB), `kokoro` 1,332 kB, `transformers.web` 902 kB, `ort.min` 538 kB. Advisory only; build succeeded. |

### 3.3 Runtime verification (executed today, then script removed)

A throwaway Node harness drove the **real** modules — real `captionSegmentsFromWords`, real `applySubtitleTextReview`, real `resolveKaraokeWordTiming` / `isKaraokeEnabled` / `getActiveWordIndex` / `getSegmentIndexAtTime` / `getCaptionTimeline` — against the genuine Whisper fixture. Results:

- **Cue generation:** 4 cues from 16 real words, all `valid=true`.
- **Pre-translation resolver:** `usable: true, source: "source-asr"`.
- **Post-translation cue keys:** `id, text, start, end, hidden, source, timingSource, phraseTiming, wordTimingSource`. `start`/`end` unchanged; `words` **absent**; `wordTimingSource: "source-word-derived-phrase"`.
- **Phrase timing (cue 1.60–2.50 s):** `sourceIntervals` `[{1.60,1.72},{1.72,2.02},{2.02,2.34},{2.34,2.50}]`; chunks `"tu"` 0.120 s, `"contraseña"` 0.300 s, `"mientras"` 0.320 s, `"viaja"` 0.160 s; `uniform?: false` — i.e. genuinely derived, **not** a uniform division of the cue.
- **Post-translation resolver:** `usable: true, source: "source-word-derived-phrase"`.
- **Active-index playback sweep:** `1.5→-1 1.6→0 1.7→0 1.8→1 1.9→1 2.0→1 2.1→2 2.2→2 2.3→2 2.4→3 2.5→-1 2.6→-1` — 9/12 samples highlighted, indices `[0,1,2,3]`, contiguous, no overlap, `-1` exactly outside the cue.
- **Preview vs export consistency:** **176 playback samples, 0 mismatches.**
- **Negative control A** (stale cue: translated text, no `words`, no `phraseTiming`): resolver `{words: null, source: null, usable: false, withheld: false}`, active index `-1` — **the reported symptom reproduced exactly**.
- **Negative control B** (single token "Hola"): no `phraseTiming` produced, unusable, safe fallback, no false highlight.
- **Negative control C** (over-long translated text): 4 phrase chunks (cap 8), usable.

### 3.4 Real project data verification

All `.timeline` archives scanned with a custom ZIP reader; every embedded `project.json` inspected. **Result: zero archives contain `phraseTiming` or any `wordTimingSource`.** Full detail in §1 Phase B.

### 3.5 Labelling of evidence types

- **Fixture-based / mocked-provider:** all unit and integration tests above. The translation provider is stubbed (no network, no live Ollalink call).
- **Real data, deterministic execution:** §3.3 used genuine Whisper ASR output and genuine archived project files, but ran in Node against the library modules — **not** in a browser.
- **Live application / end-to-end playback:** **NOT performed today.** No browser session, no canvas capture, no burned-video export was produced during today's verification.
- **Live provider verification:** **NOT performed today.** No real translation or transcription API call was made.

---

## 4. Important Technical Findings

### 4.1 The stale translated-caption data issue (root cause)

Cues translated before `phraseTiming.js` existed hold translated `text` with **neither `words` nor `phraseTiming`**. `applySubtitleTextReview()` deletes source `words` at translation time and only attaches derived timing in the current code version. Consequently the resolver's `usable: false` and the renderer's plain-phrase output are **correct**, and the Karaoke toggle legitimately appears inert.

### 4.2 Why old translated captions cannot safely recover deleted source word timings

Phrase timing is a *union of real source word intervals*. Once `words` is deleted, those intervals are gone. Reconstructing them from the translated text alone would require either (a) uniform division of cue duration — explicitly forbidden by design rule 1 and by the "no invented timings" restriction — or (b) an actual acoustic aligner, which does not exist in this build. **Therefore no in-place backfill is possible.** Recovery must come from regenerating the source ASR timing.

### 4.3 Why existing timing validation must remain strict

[`karaoke.js`](ai-video-editor/src/lib/karaoke.js) implements a 4-level precedence: target alignment → *invalid stored alignment withholds* → `source-word-derived-phrase` chunks → own `words` when valid. The governing rule, stated in the resolver header, is: **"An invalid record is withheld rather than degraded."** Loosening this would trade a harmless missing highlight for actively wrong highlighting — a strictly worse failure mode for a subtitle feature, because a mis-timed highlight is indistinguishable from a rendering bug to the user.

### 4.4 Phrase-level approximation vs genuine acoustic alignment

These are deliberately distinct and must not be conflated:

| | Source-timed phrase Karaoke (today's work) | Genuine target-language word alignment |
|---|---|---|
| Provider | None required — derives from existing ASR intervals | Requires a real aligner |
| Granularity | Phrase chunks (≤ 8 per cue) | Individual target words |
| Marker | `timingSource: "source-word-derived-phrase"` | Target alignment record |
| Status in this build | **Delivered and tested** | **Contract only — no provider exists** |
| Honesty guarantee | Never invents a window | Would be acoustically derived |

The marker exists specifically so downstream code and future maintainers cannot mistake one for the other.

### 4.5 Additional findings

- **`captionSegmentation.js:79` joins ASR chunk text with `""`**, making Whisper's leading spaces load-bearing. A tokens-only fixture collapses all words into one cue. This was discovered by a failing diagnostic today (one merged cue, then a `TypeError` from an out-of-range cue index) and fixed in the harness, not in product code.
- **Preview and export are byte-identical in timing logic** — same stored segment object, same resolver, same painter. Verified over 176 samples.
- **The Karaoke toggle has two legitimate destinations** (`captionStyle.karaoke` when no caption is selected, `styleOverrides.karaoke` when one is). Both are read by `isKaraokeEnabled()`. There is no third path.
- **`getAlignmentCapability()` is used only for UI copy**, confirming no silent aligner invocation exists.

---

## 5. Current Project Status

| Task | Status |
|---|---|
| A1 — Translated-caption Karaoke fix (shared resolver in preview + export) | **Completed** — code + tests green |
| A2 — Word-level alignment contract (`wordAlignment.js`) | **Completed as a contract.** No provider; `getAlignmentCapability()` reports unavailable |
| A3 — Language-independent phrase-level Karaoke (`phraseTiming.js`) | **Completed** — 83 tests green, runtime-verified on real ASR data |
| B — Debug investigation of non-highlighting Spanish project | **Investigated; no code change required.** Root cause = stale data |
| B1 — Regenerate captions → re-apply translation → verify Karaoke in the **running app** | **Pending / blocked on user action.** *Not verified.* Module-level behaviour is proven; the end-to-end workflow has **not** been exercised in the user's live browser |
| — | No task is currently blocked on a technical unknown. B1 requires a running app session and, if desired, the user's own project to operate on |
| — | Nothing is committed, pushed, or deployed |

**Explicit limitation.** The recovery workflow described in §1 Phase B is a recommendation backed by module-level proof and real-archive evidence. It has **not** been demonstrated in the running application, and must not be treated as verified until the manual test in §7 is completed.

---

## 6. Git and Repository Safety

| Item | Value |
|---|---|
| Branch | **`main`** |
| HEAD | `139e283` — `fix(deploy): use SSH origin and deploy key in deploy-release.sh`, 2026-10-28 20:32:33 +0530 |
| Staged changes | **None** (`git diff --cached --stat` empty) |
| Modified tracked files | 63 (includes today's `karaoke.js`, `media.js`, `CaptionOverlay.jsx` plus ~60 pre-existing from earlier work streams) |
| Untracked entries | 136 (includes today's `phraseTiming.js`, `wordAlignment.js`, `subtitleTextTools.js`, `SubtitleTextTools.jsx`, `tests/`; the remainder are pre-existing scripts, server routes, docs, i18n and test files) |
| Unrelated pre-existing changes | Present and untouched — Ollalink provider migration, TTS/diarization/transcription, `scripts/*`, `docs/*`, i18n additions |
| Committed today | **No** |
| Pushed today | **No** |
| Deployed today | **No** |
| User work preserved | **Yes** — no reset, stash, restore, or cleanup of tracked work; the only deletions were four self-created throwaway scripts and their log files under `scratch/` |
| Line-ending advisory | Git warns `LF will be replaced by CRLF` for several files — working-tree configuration only, no content change |

This report itself added one untracked file, `docs/daily-work-report-2026-11-16.md`, which is the requested deliverable.

---

## 7. Remaining Work and Next Steps

Priority order:

1. **Manual Karaoke recovery test in the running application (highest priority).** This is the one piece of Phase B not yet verified.
   1. **Back up or duplicate** the existing Spanish project before changing anything.
   2. **Regenerate captions from source audio** (`generateCaptionsFromSourceAudio`) so cues regain ASR `words` with `timingSource: "asr-word"`.
   3. **Re-apply the translation** through the subtitle text tool. Confirm the resulting cues carry `phraseTiming` and `wordTimingSource: "source-word-derived-phrase"` and that `words` is absent.
   4. **Enable `Karaoke (Active Word)`** — both globally and, as a second case, per selected caption.
   5. **Verify phrase highlighting during playback**, including boundaries: the highlight should advance once per derived phrase and vanish outside the cue.
   6. **Export a short video** and compare the burned-in highlight against the preview frame-by-frame at the same timestamps.
2. **Capture the runtime values from the live project** (one translated cue's `phraseTiming`, plus the observed active index over time) and check them against the module-level figures in §3.3. This converts the diagnosis from "evidence-based inference" to "directly observed in situ".
3. **Consider a "refresh phrase timing" command** that automates steps 2–3 of the recovery workflow, so existing translated projects can be repaired without manual transcription. This is new feature work, not a bug fix, and would need its own approval.
4. **Consider surfacing `describePhraseTimingStatus()`** in the caption panel so an enabled Karaoke toggle over inert data explains itself instead of appearing broken.
5. **Document the stale-data boundary** in the caption docs: projects translated before `phraseTiming.js` will not highlight until re-translated from regenerated captions.
6. **Pre-existing, unrelated:** the large untracked/modified backlog in the working tree should be reviewed and committed in coherent batches by its owner. It is outside today's scope and was deliberately left untouched.

---

## 8. Final Summary

**Executive summary.** Today delivered a complete, language-independent phrase-level Karaoke capability for translated captions, backed by an explicit timing contract, and then — in a second, separate phase — diagnosed why an existing Spanish project still showed no highlight. The diagnosis concluded, on evidence, that the code is correct and the project data is stale.

**Major technical improvements.**
- One shared resolver ([`karaoke.js`](ai-video-editor/src/lib/karaoke.js)) now governs both preview and burned-in export, eliminating any possibility of divergence between them.
- [`phraseTiming.js`](ai-video-editor/src/lib/phraseTiming.js) derives phrase windows from real source-word intervals using `Intl.Segmenter` offset-slicing — no invented timings, no per-language tables, separators and RTL punctuation preserved.
- A separate `phraseTiming` record with an explicit `source-word-derived-phrase` marker keeps approximation permanently distinguishable from genuine acoustic alignment, and leaves source `words` untouched for lossless language round-tripping.
- Invalid timing is **withheld, not degraded** — no false highlights.

**Confirmed results.**
- Karaoke suites: **127/127 pass** (83 phrase, 12 translated, 32 alignment), 0 failures.
- Frontend: **549/549 pass**, 29 suites, 0 failures, 13.0 s.
- Backend: **1245/1245 pass**, 267 suites, 0 failures, 27.6 s.
- Lint **0 errors** (405 warnings); typecheck **clean**; production build **`✓ built in 34.56s`**.
- Preview vs export: **176 samples, 0 mismatches**.
- Real ASR execution produced genuine non-uniform phrase timing (`uniform?: false`) and a correct active-index sweep across all four phrase chunks.
- **All 47-cue project archives on disk contain `phraseTiming = 0` and `wts = 0`** — the root cause is confirmed by direct evidence, not inference.

**Remaining risks and limitations.**
- The recovery workflow is **proven at module level only** and has not been run in the live application. Until §7 item 1 is done, "translated Karaoke works in production" remains unverified.
- Existing translated projects **cannot be repaired in place** — the source intervals were deleted at translation time. Only regeneration + retranslation restores them.
- Genuine target-language acoustic word alignment remains a **contract without a provider**; it must never be presented as delivered.
- Lint carries 405 pre-existing warnings, and the working tree carries a large pre-existing uncommitted backlog — both untouched today.
- The build emits a chunk-size advisory for the 8.1 MB editor bundle (pre-existing).

**Next recommended task.** Perform the manual recovery test in §7 item 1 on a duplicated copy of the Spanish project, then compare the live `phraseTiming` values and highlight behaviour against §3.3 and export a short clip to confirm preview/export parity.
