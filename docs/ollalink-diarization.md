# Phase 4: Ollalink speaker diarization

## Inspection and verified public contract (2026-10-29)

Read the Phase 1 transcription, Phase 2 subtitle-text, and Phase 3 TTS guides before implementation. Preservation baseline: 860 pre-existing paths, including substantial dirty/untracked work, hashed privately in the ignored Phase 4 scratch directory. No dependency or model changes are planned.

Official sources: https://ollalink.com/docs/models/ and https://ollalink.com/docs/authentication/ . Public HTML and extracted text are retained in the ignored Phase 4 scratch directory. The guessed public speaker-diarization documentation page returned 404; the actual contract is in the models page. No inference was used to retrieve documentation.

Documented endpoint: POST https://gpu-transcribe.ollalink.com/v1/audio/diarization . Authentication is the server-only X-NH-GPU-Key header, using the existing OLLALINK_API_KEY. Request is multipart with file (audio/video, up to 100 MB) and optional response_format (json default, or rttm). Do not send transcription language/model/count parameters or client-supplied upstream URLs.

The documented JSON example contains model nemotron-3-diarization, duration 60.0, speakers [speaker_1, speaker_2, speaker_3], segments containing numeric start/end and a speaker label, and seconds 1.0. The model supports up to eight speakers. It produces speaker turns only, no words. Documentation recommends combining with file transcription by time and warns that brief speakers can be missed (three detected in a four-person test).

On-demand models load on first use, unload after ten minutes idle, process sequentially, and share one loaded-model slot. Requests must finish within 100 seconds; busy model switching can return 503 with Retry-After. Documented errors include 400 undecodable/empty input, 401/403 authentication, 503 busy/unavailable; generic authentication documentation also lists 429 and 5xx. Do not automatically retry paid uploads.

Not established by these docs: diarization language accuracy/list, maximum duration other than byte cap, overlap/order guarantees, silent/empty-result shape, an exact label grammar, real identities, face-track correspondence, or word-level alignment. The numeric turn boundaries are treated as file-relative seconds, with strict duration/range checks; a live smoke, if performed, is evidence for its fixture only, not a universal accuracy guarantee. Transcription language matrices are not diarization guarantees.

## Existing workflows and safe integration boundary

Existing automatic captions resolve audio/video with possible fallback, crop source offsets, and open transcript review. Shorts reuses source captions or runs local Whisper, then performs local visual face/mouth-motion active-speaker tracking. Repository searches did not locate an acoustic diarization implementation or model. This integration does not invent one or describe visual tracking as audio diarization. Existing local workflows remain the default; cloud requires explicit selection and an explicit request. Switching back to local causes no cloud call and retains current local tools.

Selected audio tool targets expose timeline start, sourceStart, duration, playbackRate, and blob. The general caption resolver does not retain sufficient source identity/rate metadata for safe implicit diarization mapping. Therefore Phase 4 will initially accept only a selected ordinary audio-lane clip with an actual blob, finite nonnegative offsets, positive duration, normal forward playback, and no speed curve. It will not process an implicit fallback source, a mixed timeline, embedded video, music, linked source audio, reversed or retimed clips. This is an application safety restriction, not a claim about provider input support.

Application limits: 120 seconds per selected clip, 32 MB source blob before decoding, canonical mono PCM16 16 kHz WAV upload (about 3.84 MB), bounded JSON response and turn count, one active request per router, four authenticated attempts per IP per minute using the existing limiter, 30-second upload socket timeout, 110-second upstream deadline and 115-second client deadline. Native browser decoding/resampling is used; an unsupported codec fails without cloud dispatch. Decoded sources over ten minutes or eight channels are rejected, although native decoding necessarily allocates before that duration check. Browser decoding cannot be interrupted internally, so cancellation/staleness is checked after it settles and before upload; its operation slot stays owned until decoding settles. No paid retries.

Review rules: provider labels are anonymous and scoped to this request. A caption is eligible only when fully contained in one provider turn and no differently labeled turn overlaps it. Cues crossing turns, gaps, or source boundaries are omitted, never split or retimed. Captions already carrying a speaker or speakerId are never overwritten. A user must explicitly review and apply eligible proposals. Application changes only the speaker metadata of reviewed cues; text, IDs, order, times, words, styles, audio links, existing assignments, and timeline stay unchanged. No automatic Shorts face association or camera changes.

Source identity/blob/timing, complete captions, and caption lock are captured; changes cancel pending work or invalidate review. Apply checks again inside the functional state update. Leaving the tool aborts its request. Failure/cancellation leaves existing local workflows and all editor data unchanged; there is no automatic paid or local inference fallback.

## Usage and limitations

Open the Audio tool and select an ordinary audio-lane clip with explicitly linked captions. Choose Ollalink cloud in Speaker detection provider, then Detect speakers with Ollalink. Merely selecting the provider makes no request. Review provider turns and eligible captions, then explicitly Apply reviewed speaker labels or discard. If no caption has an explicit link to this audio clip, the request is disabled; timeline overlap does not establish provenance. Imported/unlinked subtitles require a trustworthy existing audio link, not an invented association.

Applied anonymous labels are namespaced per request in the existing speaker metadata, preventing accidental identity reuse across recordings. This phase does not add visual speaker prefixes, speaker-aware subtitle text export, manual identity naming, or Shorts camera control. The controlled acceptance below exercises production hook/archive save/load in Chromium and the complete editor shell's Audio-tool detect/review/discard/apply and File-menu download/import paths, with native WAV decoding and mocked service responses. Live multi-speaker accuracy, deployed cloud storage, and the complete editor workflow against the live provider remain NOT VERIFIED; no additional paid call was made.

The Local tools choice is deliberately honest: this checkout has no confirmed acoustic diarization implementation to select. It retains the existing local caption and visual tracking workflows, not a new local speaker model or automatic inference fallback. No local model was removed or changed. Unsupported timeline mappings are rejected rather than approximated.

Empty/silent results are conservatively rejected because their response shape is undocumented. Numeric turn boundaries are accepted only within the submitted duration; up to 0.1 seconds difference in the returned overall duration is an application validation tolerance, not a documented provider guarantee. Turn order and overlap are not assumed. Existing assignments are never overwritten.

## Original implementation files (2026-10-29)

New production files:
- [Shared validation, transport and review mapping](../src/lib/ollalinkDiarization.js)
- [Native audio preparation and operation ownership](../src/lib/diarizationAudio.js)
- [Review component](../src/components/DiarizationPanel.jsx)
- [Authenticated bounded route](../server/routes/diarization.js)
- [Fixed-host server provider](../server/services/transcription/ollalinkDiarization.js)

The original implementation's only existing-file changes were two additive mounts; the later acceptance repair and test extensions are documented separately below:
- [Backend app](../server/app.js): import and route mount before broad parsing.
- [Audio tool panel](../src/components/panels.jsx): import and component mount using existing source/caption props.

New tests:
- [Backend contract/security suite](../server/tests/ollalink-diarization.test.js)
- [Frontend mapping/lifecycle suite](../tests/ollalink-phase4-frontend.test.js)
- [Mounted browser fixture](../tests/ollalink-phase4-harness.jsx)
- [Browser acceptance runner](../tests/ollalink-phase4-browser.mjs)

This guide and ignored scratch evidence are also new. No dependencies, manifests, lockfiles, environment files, local models, or completed Phase 1–3 implementation files were changed. The two shared mount files retained all their pre-existing work.

## Verification evidence (2026-10-29)

All automated provider-response tests below are MOCKED, not live accuracy evidence:
- New backend suite: 26 passed. Fixed host/multipart, validation, malformed JSON/MIME/size/labels/timestamps/duration, unsupported audio, missing key, auth failures, busy/rate/upstream errors, timeout, cancellation, authenticated route/security/parser bounds and disconnect concurrency ownership.
- Full backend regressions: 1,198 tests passed, zero failed/skipped/cancelled, across 267 suites.
- Frontend regression run: 35 passed (28 new Phase 4 plus seven existing Phase 3).
- Phase 4 mounted Chromium: PASS, zero page errors. Local default/explicit opt-in, real native WAV decode, duplicate suppression, review/apply preservation, caption/source/blob/lock changes, permanent lock invalidation after unlock, cancellation, stale pending results, unmount, failure, and return to local with no automatic inference.
- Existing Phase 3 mounted Chromium runner: PASS, including 14 late-work cancellation cases; no live provider calls.
- Production build: PASS after final production changes. Existing dependency eval, mixed import/chunk and bundle-size warnings remain; no unrelated optimization attempted.
- Focused lint on all five new production files: PASS with no findings. Broader new-test lint had one nonfatal refresh warning for the test-only fixture.
- Configured secret scan: zero hits across 69 built text assets; no credential value printed.

Live evidence is separate: exactly ONE guarded paid diarization POST, 18:40:07–18:40:09 UTC, reusing the retained Phase 3 single-voice synthetic speech WAV. No TTS or catalog request was made. Input was resampled from 24 kHz to canonical 16 kHz mono PCM16, 3.2 seconds. Upstream returned HTTP 200 application/json, model nemotron-3-diarization, duration 3.2, speakers [speaker_1], one turn 0–2.649 seconds. Strict production service validation passed. This demonstrates endpoint/auth/schema compatibility for that fixture only, NOT multi-speaker accuracy, language coverage, overlapping speech, or editor-wide live acceptance. Exclusive-create dispatch guard prevents accidental repeat billing.

Evidence is retained in the ignored [Phase 4 scratch directory](../scratch/ollalink-phase4/): [live report](../scratch/ollalink-phase4/live-report.json), [preservation](../scratch/ollalink-phase4/preservation.json), [backend regressions](../scratch/ollalink-phase4/backend-regressions.txt), [frontend final](../scratch/ollalink-phase4/frontend-final.txt), [browser final](../scratch/ollalink-phase4/browser-final2.txt), [Phase 3 browser regression](../scratch/ollalink-phase4/phase3-browser-regression.txt), [build](../scratch/ollalink-phase4/build-final.txt), and [lint](../scratch/ollalink-phase4/lint-final.txt).

Preservation: all 860 baseline paths checked. Exactly the two intended mount files differ; removing only the new lines in memory reproduces both original SHA-256 hashes. The other 858 paths, including credentials, manifests, completed-phase internals, local workflows/models and pre-existing user work, are byte-identical. No destructive Git, commits, pushes, deployment, or model downloads. Test browsers, Vite servers and temporary test databases were closed by their runners. Historical Phase 3 reports, failed attempts and retained live audio remain untouched.

## Controlled persistence/export acceptance (2026-10-30)

This is separate from the historical implementation/live evidence above. This subtask made **zero live/provider calls**. Its preservation baseline contains 902 paths; no dependencies, lockfiles, environment files, existing harnesses, or unrelated editor workflows were changed. Full backend, lint, build, and typecheck were deliberately not run in this subtask.

### Added acceptance files and demonstrated repair

- [Production-hook React fixture](../tests/ollalink-phase4-persistence-harness.jsx): mounts the production panel and project-files hook with actual React setters and a six-second PCM WAV; no replacement serializer, decoder, or archive worker.
- [Chromium persistence runner](../tests/ollalink-phase4-persistence-browser.mjs): actual project/SRT downloads, file-input import, and mocked cloud create/upload/initial-project download. All browser requests are recorded, non-origin requests and unexpected APIs are blocked, service workers are disabled, and runner fetch is forbidden.
- [Persistence/export contracts](../server/tests/ollalink-diarization-persistence.test.js): real archive, SRT, command inspection, Shorts render-spec/editable ZIP, native/OTIO roundtrips, FCPXML, and headless render arguments; fetch is blocked and asserted unused.
- Demonstrated defect: Shorts render-spec captions retained speaker metadata, but the canonical caption projection dropped it; native/OTIO package captions consequently lost it too. The smallest repair adds only optional own speaker and speaker-ID fields at [candidate conversion](../src/lib/shortsTimelinePackaging.js:254), [native serialization](../src/lib/shortsTimelinePackaging.js:540), and [native restoration](../src/lib/shortsTimelinePackaging.js:714). Absent fields remain absent; opaque present values are not normalized. No text prefixes, identity inference, schema migration, or unrelated packaging changes were added.

### Results and contracts

- New Node suite: **10 passed, 0 failed**. Run from the repository root with [node --test server/tests/ollalink-diarization-persistence.test.js](../server/tests/ollalink-diarization-persistence.test.js).
- Existing focused regressions: **265 passed, 0 failed/skipped/cancelled**, 40 suites: [caption timing](../server/tests/caption-timing-workflows.test.js), [render plans including local CLI/FFmpeg checks](../server/tests/projectRenderPlan.test.js), [Shorts Studio](../server/tests/shorts-studio.test.js), and [Phase 4 frontend](../tests/ollalink-phase4-frontend.test.js). Executed together with Node test runner and an import-time fetch rejection/logging guard; zero blocked fetch attempts.
- Chromium: **10 grouped checks passed**, **805 requests recorded**, **4 mocked diarization uploads**, **0 external attempts**, **0 page errors**. Run with [node tests/ollalink-phase4-persistence-browser.mjs](../tests/ollalink-phase4-persistence-browser.mjs). Native evidence sampled after cloud load confirms one real WAV decode and three production archive workers returning successful results without failures.
- Applied anonymous labels and manual assignments survive snapshots, v3 archives, browser download/import/re-export, and mocked cloud save/load. Full caption text/times/words/styles/audio links and exact embedded WAV bytes/source/timeline placement survive the ordinary project path. Unapplied, discarded, stale review, and stale pending proposals never enter saved/downloaded project state; intervening manual edits survive.
- Legacy import inherits the existing font default but invents no speaker fields. Five malformed/opaque metadata forms survive import/archive/download/reimport unchanged without page errors or script execution. This confirms the existing opaque persistence contract, not a new normalization or full-editor rendering guarantee.
- SRT standalone preserve-text and video-export display modes ignore speaker metadata: no speaker prefixes and no metadata-induced text/timing changes. Command inspection retains labels without changing transcript text/times. Headless FFmpeg arguments are identical with and without applied labels.
- Shorts render-spec JSON retains metadata with intentional candidate-relative cue/word timing. Canonical/native/OTIO metadata and actual editable ZIP retain both anonymous and manual labels after the repair. FCPXML remains text/timing-only for speakers. No production VTT or EDL exporter was found; none was invented.

### Evidence and remaining limits

Final [browser report and complete request ledger](../scratch/ollalink-phase4/acceptance-20261029/persistence-CQ3J0N/report.json), [new suite output](../scratch/ollalink-phase4/acceptance-20261029/persistence-contract-final.txt), [existing regression output](../scratch/ollalink-phase4/acceptance-20261029/persistence-existing-regressions.txt), and [preservation report](../scratch/ollalink-phase4/acceptance-20261029/persistence-preservation.json) are retained in ignored scratch storage. A final combined rerun against the whitespace-preserved source passed **275/275 tests**, 40 suites, zero failed/skipped/cancelled and zero fetch attempts: [final combined output](../scratch/ollalink-phase4/acceptance-20261029/persistence-focused-final2.txt) and [exact executable, arguments, working directory and exit status](../scratch/ollalink-phase4/acceptance-20261029/persistence-focused-command-final2.json). All 902 baseline paths remain present: 900 are byte-identical, and reversing only this subtask's guide edits and six production additions reproduces both remaining baseline hashes. The parent's security test is separate from the three new subtask tests. Actual downloaded archives/SRT and captured cloud-upload bytes are alongside the browser report. Failed attempts and pre-fix output remain retained; early test-only MIME/parser/worker-message/fixture/catalog expectations were corrected, not treated as production defects. Incidental editor formatting was removed; the final rerun also caught and corrected an intermediate misplaced-field restoration before completion.

This persistence fixture mounts the production panel and hook, not the complete editor shell; a separate complete-shell run is recorded below. Cloud transport/storage is mocked, not a deployed storage acceptance test. No live accuracy, paid upstream, third-party NLE import, diarization-labeled MP4 visual render, or full-editor malformed-metadata rendering claim is made. Render argument serialization and existing local FFmpeg regressions were checked; no new speaker display/render feature was introduced. Native worker/decode counters are a cloud-page sample, not totals across browser navigations. Historical live evidence above was not rerun.

## Acceptance and regression closure (2026-10-30)

**PASS for the controlled, mocked acceptance scope.** This is not a claim of live multi-speaker accuracy or deployed end-to-end service acceptance. The original one-request live report and dispatch guard remain unchanged. No additional live/provider request, dependency change, commit, push, or deployment occurred.

- **Persistence/export:** production archive/download/import and mocked cloud hook paths pass, including unapplied/discarded/stale proposal exclusion, legacy projects, opaque metadata fixtures, and exact embedded audio preservation. The six-line optional-metadata repair above is the only production change in this follow-up. SRT and FCPXML remain text/timing-only for speaker information; no unsupported format feature or prefix was invented.
- **Multi-speaker/mapping:** [deterministic multi-turn tests](../tests/ollalink-phase4-multispeaker.test.js) add 18 passing cases. Alternation, consecutive same-speaker turns, gaps, partial coverage, overlap/cross-talk, invalid timestamps/labels, and empty/single results retain strict single-turn containment. Adjacent same-label turns are not merged to guess a mapping.
- **Mounted lifecycle:** the [extended browser runner](../tests/ollalink-phase4-browser.mjs) passes 19 scenario executions in 16 check groups, including discard, pending/review invalidation, cancellation, provider/source/blob/lock changes, unmount, safe rate/timeout/malformed/network errors, and explicit retry without duplicate application. Its final run recorded 24 mocked uploads, no unexpected/external requests, and no page/console errors. Existing local workflows and Shorts regressions remain covered; no automatic paid retry or inference fallback was added.
- **Actual editor shell:** the [new editor runner](../tests/ollalink-phase4-editor-browser.mjs) and [shell fixture](../tests/ollalink-phase4-editor-harness.jsx) mount the production editor, select an imported clip through the timeline, and exercise real Audio-tool review/discard/Apply plus File-menu archive download and import restoration. Review/discard do not mutate data; Apply changes only eligible metadata; all other snapshot fields and exact WAV bytes survive. Final evidence records 397 same-origin requests, two mocked uploads, five native decodes, four archive workers, and zero external attempts, unexpected API/model payloads, or page/console errors. Authentication is supplied through the supported editor prop and catalog responses are empty local mocks. Two cancelled local voice-sample preloads are disclosed in the ledger; no model inference occurred.
- **Security/resources:** [36 additional security tests](../server/tests/ollalink-diarization-security.test.js) pass with real isolated session middleware and mocked upstream. Coverage includes sequential/concurrent rate budgets, one-active ownership, per-IP behavior, origin/opt-in/Fetch Metadata/encoding checks, auth-before-budget, slot release after errors/disconnect, safe errors, redirects, cancellation, response disposal, and no retries. No security-control production defect was demonstrated; existing limits and controls remain unchanged.

### Fresh verification, not inherited results

The [exact command/exit ledger](../scratch/ollalink-phase4/acceptance-20261029/closure-commands.json) records all eleven commands with exit zero: combined focused tests **118/118**, complete backend **1,244/1,244** across **267 suites**, relevant Phase 3/4 frontend **53/53**, Phase 4/persistence/Phase 3 browsers, production and acceptance-test lint, repository lint, typecheck, and production build. Test runs have zero failures/skips/cancellations. Compared with the retained implementation baseline, backend count increased by 46 (36 security + 10 persistence) and frontend by 18 multi-speaker cases; no historical result was substituted for a fresh run. The separate editor browser and its [focused lint](../scratch/ollalink-phase4/acceptance-20261029/closure-editor-lint.json) also exit zero.

Lint is **not warning-free**: repository lint reported 401 warnings, focused production lint 10, acceptance-test lint nine, and later editor-test lint two; all have zero errors. Unused-variable and test-only refresh warnings are retained, not disabled. Build retains dependency eval, mixed static/dynamic import and large-chunk warnings. No unrelated lint cleanup or bundle rewrite was attempted.

The current [bounded secret scan](../scratch/ollalink-phase4/acceptance-20261029/closure-secret-scan.json) checks actual configured credential values without printing them, private-key blocks, and server-only provider identifiers in built text assets. It found zero matches across **80 built text assets** and the scanned acceptance evidence. This differs from the historical 69-asset count and is not a universal secret-detection guarantee.

Final [preservation evidence](../scratch/ollalink-phase4/acceptance-20261029/closure-preservation.json) checks all **902** fresh baseline paths: **898 byte-identical**, none missing, and only this guide, the six-line packaging repair, and the two existing Phase 4 browser fixture files changed. Reversing only the six production additions reproduces the original file hash, including all pre-existing packaging work. Seven new acceptance test files were added. Historical evidence, environment/manifests/lockfiles, completed Phase 1–3 internals, local models, and staged work remain unchanged.

The [consolidated acceptance report](../scratch/ollalink-phase4/acceptance-20261029/acceptance-report.md) records closure gates, file reasons, exact evidence references, failed fixture attempts, fresh results, and remaining NOT VERIFIED boundaries. Scratch evidence is ignored local storage, not committed or deployed.
