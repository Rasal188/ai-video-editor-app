# Ollalink cloud TTS — Phase 3

## Status and release boundary

Final offline verification completed on **2026-10-29**, after the dynamic catalog, no-POST-retry, and detached-cloud preview corrections. The final backend result is **1,172 passed / 0 failed, 267 suites**. Frontend tests, mounted Chromium checks, typecheck, lint, production build, and whitespace diff check passed. **Live normal-UI end-to-end acceptance remains incomplete.** A successful provider WAV response is not evidence of a completed live timeline/playback/download workflow.

This finalization added this guide and scratch verification artifacts only. It made **no further paid synthesis calls and no production-code, dependency, model, environment, or manifest edits**. User databases and storage were not reset or deleted. Do not interpret the older audit's pre-correction results or release recommendations as the final corrected implementation's results.

## Official contract and observed deployment drift

Official pages inspected and retained during the prior contract review:

- [Text-to-speech](https://ollalink.com/docs/text-to-speech/)
- [Voice catalog](https://ollalink.com/docs/voice-catalog/)
- [Authentication](https://ollalink.com/docs/authentication/)
- [Models and languages](https://ollalink.com/docs/models-and-languages/)

These are provider documentation, not a guarantee that every static example matches the deployed catalog. The saved [contract diagnosis](../scratch/ollalink-phase3/contract-diagnosis.json) records an authenticated, bounded GET returning HTTP 200, 2,373 bytes, and 14 deployed fixed voices covering English, Spanish, French, German, and Portuguese. Static documentation and the original Jason default did not match that deployment. The diagnosis found Delia/English listed and Jason not listed. The original 400 body was not retained, so catalog incompatibility is strong evidence, not a retrospective proof of every aspect of the original rejection.

Current support is **dynamic**, not the historical 14-voice list hardcoded into the editor. Never infer voice aliases, language aliases, defaults, or the cross-product of all voices and languages. No voice design, instructions, cloning, translation, romanization, or script conversion is performed. In particular, **do not offer or claim Hindi unless that exact language is listed for the explicitly chosen voice**. A catalog entry is a compatibility declaration, not a language-quality certification.

Saved source documents are available under [the scratch audit directory](../scratch/ollalink-phase3/), including [TTS](../scratch/ollalink-phase3/tts.txt), [voices](../scratch/ollalink-phase3/voices.txt), [authentication](../scratch/ollalink-phase3/authentication.txt), and [languages](../scratch/ollalink-phase3/languages.txt). No new external GET was needed for final verification.

## Endpoint and authentication contract

| Boundary | Method and fixed endpoint | Authentication / required headers |
| --- | --- | --- |
| Browser catalog | GET `/api/tts/voices` | Existing editor authenticated session; `credentials: include`; `X-TTS-Request: 1` |
| Browser synthesis | POST `/api/tts` | Existing editor authenticated session; `credentials: include`; `X-TTS-Request: 1`; `Content-Type: application/json` |
| Server catalog | GET `https://gpu-tts.ollalink.com/voices` | Server-only `X-NH-GPU-Key`; `Accept: application/json` |
| Server synthesis | POST `https://gpu-tts.ollalink.com/v1/audio/speech` | Server-only `X-NH-GPU-Key`; `Content-Type: application/json` |

The server uses the existing Ollalink configuration and existing `OLLALINK_API_KEY` credential. The credential is required to have the configured `sk_` key shape. No key is entered in the browser, sent to it, committed in this guide, or embedded in the client bundle. No new environment variable is required. Keep the existing environment configuration server-only; never add a frontend-prefixed credential.

The only synthesis JSON fields accepted are:

| Field | Requirement |
| --- | --- |
| `input` | Original nonblank string, preserved without normalization; at most 4,000 UTF-16 code units; NUL and malformed Unicode rejected by the shared validator |
| `voice` | Explicit canonical fixed voice ID; bounded syntax; must occur in the current catalog |
| `language` | Explicit bounded language tag listed on that exact voice |
| `response_format` | Exactly `wav` |

There are no model, speed, volume, gain, style/instructions, clone, arbitrary URL, or provider-key fields. Unknown fields, missing fields, query parameters, malformed JSON, compressed JSON, and non-JSON synthesis bodies are rejected. The browser sends the same four-field JSON the service serializes upstream.

### Dynamic catalog and server-side pair validation

The [catalog helper](../src/lib/ollalinkTtsCatalog.js) and [server service](../server/services/ai/ollalinkTts.js) implement:

- A server-side **60-second successful-result cache**, with a shared in-flight GET. Concurrent consumers share the bounded catalog work; one consumer's cancellation does not abort other consumers or poison the cache. Failure is not accepted as a usable catalog.
- A **20-second GET deadline** and **256 KiB body cap**, including streaming reads and strict JSON/content-type validation. Upstream redirects are rejected.
- A bounded schema: 1–128 unique voice IDs, bounded safe display names, 1–32 unique valid languages per voice. Every upstream entry must declare `engine: fixed` and `instructions: false`.
- Only sanitized IDs, names, and per-voice languages leave the server. Provider defaults, aliases, language aliases, and unrelated metadata are not forwarded as selectable behavior.
- The UI starts with **no cloud voice or language selected**. Both require explicit choices. Refresh/removal/incompatibility never silently picks another speaker. Generation stays disabled without a valid pair.
- Before any paid POST, the server independently validates the submitted pair against its current cached/refetched catalog. A forged UI request or stale pair cannot bypass this check. There can still be deployment drift inside the cache lifetime; a provider 400 invalidates the server cache and produces a safe refresh-and-reselect error, not a replay.

**Fail-closed limitation:** this parser accepts a fixed-engine-only catalog. If the live catalog changes shape, includes incompatible/design-engine entries, has invalid metadata, exceeds bounds, or is unavailable, the cloud catalog fails closed. The editor does not filter arbitrary incompatible entries into a guessed working subset, fall back to stale static voices, or auto-convert an unsupported choice. The refresh control reloads through the server; it does not promise to bypass the 60-second server cache.

## Audio and editor limits

The response must be a bounded, structurally valid **RIFF/WAVE, PCM16, mono, 24,000 Hz** file. The shared reader/validator checks MIME, relevant response headers, byte limits, RIFF/chunk consistency, PCM format, channel/sample/byte rates, and nonempty aligned audio data. The route revalidates even an injected provider result before returning bytes. A supplied mismatching voice header is rejected; absence of that header is not acoustic proof of speaker identity.

| Limit | Editor policy |
| --- | --- |
| Text | 4,000 UTF-16 code units, not Unicode graphemes or UTF-8 bytes |
| Browser-to-server JSON | 32 KiB; strict, uncompressed JSON |
| Returned WAV | 32 MiB maximum |
| Returned duration | At most 600 seconds |
| Catalog | 256 KiB; 20 seconds |
| Server synthesis deadline | At most 120 seconds, including catalog acquisition, headers and bounded response read |
| Browser synthesis deadline | 130 seconds |

These are conservative **editor validation and resource policies**, not claims about provider account quotas, supported maximum text, pricing, free allowances, or service-level guarantees. Unsupported audio is rejected, not resampled, transcoded, or silently repaired into an accepted cloud result.

## Security, concurrency, cancellation, and billing

The [dedicated route](../server/routes/tts.js) is mounted separately from the unchanged local TTS route. It enforces the existing authentication middleware and a custom request-header/origin defense:

- Both catalog and speech require `X-TTS-Request: 1`. An explicitly cross-site Fetch Metadata request is rejected. If Origin is present it must exactly match the request origin or the explicitly configured, non-wildcard CORS origin. Malformed/untrusted origins are rejected. Missing Origin alone is not rejected, but does not waive authentication or the custom header.
- Separate single-process, in-memory **per-IP 60-second limits: 30 GET requests and 6 POST requests**. These are not per-account or distributed quota guarantees. Correct trusted-proxy/IP deployment configuration remains an operator responsibility.
- At most **two active POST operations per router/process**, including bounded body parsing. Disconnection releases parsing-only work; once synthesis starts, its slot is held until work settles. This prevents early release from multiplying active provider work. Parsing has a 30-second socket timeout; provider work then has its own bounded deadline.
- Responses use `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. Successful browser audio is `audio/wav` with fixed audio metadata headers. Errors use a closed, sanitized code/message catalog, not arbitrary provider messages or failure bodies.

Upstream URLs are fixed constants. Neither browser input nor environment input selects an alternate host or arbitrary URL. Both GET and POST reject redirects, preventing credential forwarding to a redirect target.

**Paid synthesis is non-idempotent: exactly one upstream POST per explicit synthesis operation.** There is no automatic retry for 429, 502, 503, 504, Retry-After, network faults, timeouts, rejected audio, or ambiguous completion. There is no provider idempotency guarantee assumed. The old retry-risk artifact is historical pre-correction mock evidence, not current behavior and not proof that duplicate billing occurred.

Browser cancellation, provider switch/unmount, script/voice/language/selection changes, and disconnected HTTP clients invalidate the operation. Signals/deadlines abort owned waits and streaming reads; late responses are cancelled and late decoded work cannot mutate the timeline. Shared catalog GET cancellation is consumer-scoped as noted above. **Cancellation or timeout cannot guarantee the provider stopped work or that billing will not occur.** The UI explains uncertainty and does not auto-resubmit. A user must assess an ambiguous outcome before choosing another paid generation.

Do not log request text, audio bodies, credential/header values, raw provider errors, or sensitive account data. Existing audit artifacts retain counts, safe status/schema metadata, hashes, and generic fixtures rather than configured secret values. Application no-store headers do not override a provider's own retention policy; cloud opt-in still sends the selected text to the provider.

## UI, local preservation, and timeline behavior

1. Local TTS remains the default. Existing local voice/sample selection, speed, volume, and clone controls/state remain local and are preserved across switching providers. The local synthesis hook, base synthesis implementation, local models/runtime, and local backend route were not replaced.
2. Cloud is opt-in. The catalog is loaded through the authenticated backend, then the user explicitly chooses a listed fixed voice and one of that voice's languages. No cloud speed, cloning, instructions, or baked-in gain is offered or sent.
3. Generate starts one operation with synchronous duplicate-submission protection, visible pending state, and explicit cancellation. Failure does not launch local inference or another cloud request.
4. **Use local TTS instead** only selects the local provider. It does not synthesize, silently switch speakers, or commit a replacement. A separate user generation action is still required.
5. The cloud operation has separate application ownership from the unchanged local generation hook. It snapshots script, catalog/pair, selected caption/selection, and application state. Before committing, it checks cancellation, operation identity, script/caption/selection identity, track locks, and competing work.
6. The [audio batch commit](../src/lib/audioTrackActions.js) decodes first, then repeats its final guard **after the last asynchronous decode and before any URL/caption/history mutation**. The accepted mutation batch is synchronous, so a cancelled/stale result cannot partially commit after decode.
7. Cloud clips/history use `sourceKind: ollalink-voiceover`, names identifying the chosen voice/language, and `voiceId: ollalink:<chosen-id>`, not the currently selected local speaker or clone. Natural timing, playback rate 1, and unity gain are used. No local speed/volume is baked into the returned WAV.
8. Caption replacement preserves caption identity/text and start placement, links detached cloud audio by ID, and aligns the caption end to the decoded duration. General generation follows existing append/alignment behavior without cloud time-stretching to an old caption length.
9. Cloud caption preview resolves the specifically linked detached cloud clip; the local attached-audio resolver remains unchanged. Preview uses browser native audio controls. The ordinary WAV download preserves the returned WAV bytes; it does not rerun synthesis.

Mocked acceptance proves metadata and byte identity in the editor. It does not prove acoustic speaker identity, pronunciation, subjective quality, language fluency, human listening, or OS/device audio output.

## Final verification of the corrected code

The final run was **17:00:33–17:02:33 UTC on 2026-10-29**. Machine-readable commands, timings, counts, guards, and preservation results are in [final verification](../scratch/ollalink-phase3/final/verification.json).

| Check | Exact final result | Evidence |
| --- | --- | --- |
| Full backend, actual final source in default-layout scratch sandbox | **1,172 tests passed, 0 failed; 267 suites; 0 cancelled; 0 skipped test cases; 0 todo** | [summary](../scratch/ollalink-phase3/final/backend-full-summary.json), [log](../scratch/ollalink-phase3/final/backend-full.log) |
| Selected Phases 1/2, auth, caption, local/cloud TTS regressions | **269 passed, 0 failed; 53 suites**; overlaps full backend, not additive | [log](../scratch/ollalink-phase3/final/selected-regressions.log) |
| Phase 3 frontend tests | **7 passed, 0 failed** | [log](../scratch/ollalink-phase3/final/frontend.log) |
| Isolated mounted Chromium | **PASS**; synthetic WAV commit/identity, caption alignment, preview/download, local preservation, **14 late-work cancellation cases**, synchronous duplicate submit, safe failure/manual fallback, limits, locks, and dynamic catalog choice/removal/incompatibility/late cancellation | [log](../scratch/ollalink-phase3/final/mounted-browser.log), [browser network guard](../scratch/ollalink-phase3/final/browser-network-guard.json) |
| Typecheck | Exit **0** | [log](../scratch/ollalink-phase3/final/typecheck.log) |
| Lint | Exit **0**, **0 errors / 392 existing repository warnings**; same count as the prior corrected checks, not a claim of zero warnings | [log](../scratch/ollalink-phase3/final/lint.log) |
| Fresh production build | Exit **0**; **5,183 modules transformed** | [log](../scratch/ollalink-phase3/final/build.log) |
| Whitespace diff check | Exit **0**, no whitespace failures; **11 LF-to-CRLF notices** | [log](../scratch/ollalink-phase3/final/diffcheck.log) |
| Fresh bundle literal configured-secret scan | **190 files, 3 distinct configured credential values, 0 matching files / 0 occurrences**; values not printed | [verification](../scratch/ollalink-phase3/final/verification.json) |

The **Kokoro Live Neural Inference (Dedicated Integration Suite) remains explicitly skipped** with live testing disabled. Node's footer reports zero skipped *test cases*; that does not mean the live suite ran. The final full log retains the suite's SKIP marker. No local live neural inference/model download was added.

Typecheck uses the existing [TypeScript configuration](../tsconfig.json): its include is only TypeScript source and JavaScript checking is disabled. Passing it does **not** comprehensively typecheck the new JavaScript/JSX. Runtime/unit/browser tests and lint provide separate coverage.

The build retains **2 dependency eval notices, 9 mixed static/dynamic import notices, and 1 large-chunk warning**. These and the existing lint/line-ending notices are recorded, not hidden or fixed out of scope. Literal secret scanning does not establish absence of transformed/encoded unknown secrets; it checks the configured values, count-only, across every file of the freshly built output.

### Isolation and reproducibility

From the project root, the final scratch orchestrator is run with `node scratch/ollalink-phase3/run-final-verification.mjs`. It runs a fresh `npm run build`, the existing isolated backend runner using `npm run test:backend`, the recorded selected `node --test --test-reporter=tap` file list, `node --test --test-reporter=tap tests/ollalink-phase3-frontend.test.js`, the scratch browser guard around the mounted harness, `npm run typecheck`, `npm run lint`, and `git diff --check`. See [the final runner](../scratch/ollalink-phase3/run-final-verification.mjs) for exact ordering/environment and [the recorded command list](../scratch/ollalink-phase3/final/verification.json) for the expanded selected-regression arguments.

- Backend source is freshly copied unmodified into the existing [clean-source sandbox](../scratch/ollalink-phase3/backend-sandbox/), with its own default relative storage layout, current production build, default voice-sample/icon fixtures, and existing timeline fixture. It uses a junction to installed dependencies; no install, model copy, or real environment-file copy is performed.
- Test credentials are cleared; live Kokoro is disabled; email is mocked. The [existing Node network guard](../scratch/ollalink-phase3/offline-guard.mjs) blocks non-loopback HTTP/fetch, DNS, socket, and TLS destinations. Final guard counters record no blocked external attempts. The [browser wrapper](../scratch/ollalink-phase3/final-browser-guard.mjs) additionally blocks non-loopback page requests; all speech/catalog data in the mounted harness is synthetic.
- The old 8-failure run used the wrong custom storage root. The old 10-failure sandbox run lacked the built assets and MP3/icon fixtures. These were **scratch setup mistakes, not production defects**. The earlier 1,166-pass full run was pre-correction and is not the final result; the corrected final run is 1,172/1,172.
- The runner snapshots worktree status/hashes before testing, waits for its child commands to finish, and compares process snapshots. Browser/Vite resources close in the harness finally path. Final cleanup found **no new relevant Node/Chromium/FFmpeg/esbuild processes remaining**; preexisting processes were not killed. Generated storage/database files are confined to scratch test fixtures; user work/storage was not destroyed.

## Historical live evidence — explicitly not complete live E2E

Across the retained Phase 3 history there are **two total real synthesis POSTs** and **two total authenticated live catalog GETs**:

| Historical operation | Recorded outcome |
| --- | --- |
| Original normal-UI Jason/English synthesis | One upstream POST returned **400**; the original browser route mapped it to **502**. No accepted audio. [Original report](../scratch/ollalink-phase3/browser-report.json) and [diagnosis](../scratch/ollalink-phase3/contract-diagnosis.json) remain historical. |
| Contract diagnosis catalog | **One GET**, HTTP **200**, with no synthesis. [GET guard](../scratch/ollalink-phase3/catalog-get-guard.json). |
| Corrected normal-UI Delia/English attempt | **One catalog GET and one synthesis POST**. Route/provider returned **200** and the response validated as **3.2 seconds, 153,600 PCM data bytes, PCM16 mono at 24 kHz**. These are PCM payload bytes, not the complete WAV file size. [Corrected live report](../scratch/ollalink-phase3/correction/browser-report.json), [dispatch guard](../scratch/ollalink-phase3/correction/live-dispatch-guard.json). |
| Final verification in this guide | **Zero additional live GETs or synthesis POSTs**. Offline only. |

The corrected live browser run stopped **before timeline metadata, playback, and download evidence was recorded**. Its generic harness failure record does not identify the exact failed expression. A transient development snapshot bridge was suspected; that is **not a proven root cause**. A later mock run separately exposed a detached-cloud preview resolver issue, which was corrected and verified without another paid call. That later finding cannot establish why the earlier live harness stopped. Original live audio was not persisted for replay, and its browser was cleaned up.

Accordingly, the corrected [live report](../scratch/ollalink-phase3/correction/browser-report.json) retains **`pass: false`** and the [correction result](../scratch/ollalink-phase3/correction/final-result.json) retains **live acceptance incomplete**. Do not relabel either report because subsequent offline checks passed. That correction result explicitly predates the broad final checks; use this guide's final verification artifact for the fresh full-suite/build results.

The final corrected **mocked normal-UI** report is [browser-mock-success-report](../scratch/ollalink-phase3/correction/browser-mock-success-report.json): **0 live GETs / 0 live POSTs**, one mocked catalog GET and five mocked synthesis operations across success/failure/cancellation scenarios. It verifies normal sign-in/dashboard/editor/SRT selection; explicit Delia/English choice; cloud timeline metadata and caption identity/alignment; native control playback/current-time progression; **exact server-byte WAV download**; one-request safe 503 handling; select-only manual fallback; and cancel/voice-change/unmount late-result suppression. [Mock followups](../scratch/ollalink-phase3/correction/browser-followup-report.json) are separate evidence, not more live calls.

The final mounted Chromium rerun adds isolated component/timeline regression evidence. Neither mocked run certifies real language quality or acoustic speaker identity. **The remaining release gap is one complete, separately authorized live normal-UI timeline/playback/download acceptance workflow. No further synthesis was attempted in this finalization.**

## Phase 3 changed files and preservation

The dirty worktree contains substantial preexisting user work and Phases 1/2 files. It is not an accurate Phase 3 changed-file list by itself. Phase 3 implementation/test scope, including its corrections, is:

### New backend and shared contract files

- [Dedicated TTS route](../server/routes/tts.js)
- [Ollalink TTS service and catalog cache](../server/services/ai/ollalinkTts.js)
- [Shared request/audio/client helpers](../src/lib/ollalinkTts.js)
- [Dynamic catalog validation/client helpers](../src/lib/ollalinkTtsCatalog.js)

### New UI and test files

- [Cloud panel](../src/components/OllalinkTtsPanel.jsx)
- [Service tests](../server/tests/ollalink-tts.test.js)
- [Route tests](../server/tests/ollalink-tts-route.test.js)
- [Audio/client tests](../server/tests/ollalink-tts-audio-client.test.js)
- [Catalog tests](../server/tests/ollalink-tts-catalog.test.js)
- [Generic fixtures](../server/tests/ollalink-tts-fixtures.js)
- [Frontend tests](../tests/ollalink-phase3-frontend.test.js)
- [Mounted Chromium test](../tests/ollalink-phase3-browser.mjs)
- [Mounted browser fixture](../tests/ollalink-phase3-harness.jsx)
- [This production guide](ollalink-tts.md)

### Modified shared wiring

- [Server application](../server/app.js): dedicated route import/mount.
- [Editor application](../src/App.jsx): cloud ownership/commit guards and callback wiring, separate from local synthesis ownership.
- [Voice panel](../src/components/VoicePanel.jsx): cloud callback/selection wiring and lookup of detached cloud audio for preview; captured differences also include formatting-only hunks.
- [Provider panel](../src/components/panels.jsx): local-default/cloud opt-in switch, preserved local branch/controls, cloud result preview/download source.
- [Audio track actions](../src/lib/audioTrackActions.js): additive guarded batch commit and explicit cloud metadata, retaining local defaults for other callers. This file was not one of the original 45 baseline files; it was preserved unchanged by final verification.

Scratch acceptance/audit scripts, guards, screenshots, generic WAV fixtures, logs, hash snapshots, sandbox fixtures and JSON reports live under [the Phase 3 scratch directory](../scratch/ollalink-phase3/); they are evidence, not production routes or dependencies. This finalization's new scratch drivers are [run-final-verification](../scratch/ollalink-phase3/run-final-verification.mjs), [final-browser-guard](../scratch/ollalink-phase3/final-browser-guard.mjs), and [finalize-production-docs](../scratch/ollalink-phase3/finalize-production-docs.mjs); fresh results are grouped under [final](../scratch/ollalink-phase3/final/). Earlier artifacts were retained rather than reclassified as new final passes.

### Hash and worktree preservation

- **859 captured project/configuration paths: zero changed during final verification**, including privately hashed environment/configuration paths, manifests, lockfile, local base/runtime/hook files, Phase 1/2 routes/services/tests, caption helpers, and other captured user work. The new documentation is the sole intentional production-tree addition in this finalization.
- Original **45-file Phase 3 baseline: 41 identical, four existing Phase 3 exceptions**: [server app](../server/app.js), [editor app](../src/App.jsx), [voice panel](../src/components/VoicePanel.jsx), and [provider panel](../src/components/panels.jsx). These are reviewed cloud wiring/ownership/preview changes, not replacements of Phase 1/2 services. All four already existed at final-verification start.
- Phase 1/2 docs, transcription/text-tool routes/services/tests and shared helpers, local model/runtime/base synthesis/hook, API router, server configuration, environment files/example, package manifests, and lockfile were not changed by this finalization. Existing unrelated dirty-worktree deltas were preserved, not attributed wholesale to Phase 3 or reverted.
- See [before hashes](../scratch/ollalink-phase3/final/before-hashes.json), [after hashes](../scratch/ollalink-phase3/final/after-hashes.json), [status before](../scratch/ollalink-phase3/final/worktree-before.txt), [status after tests](../scratch/ollalink-phase3/final/worktree-after.txt), and [post-document validation](../scratch/ollalink-phase3/final/document-validation.json). Historical live/mock evidence hashes are checked separately without altering their original pass/fail flags.

## Remaining limitations

- Live provider WAV compatibility was observed for one corrected Delia/English response; a complete live editor workflow remains unverified.
- No acoustic speaker verification, human listening, subjective quality assessment, or language-quality certification was performed.
- Future catalog/schema drift intentionally fails closed; the catalog cache does not eliminate drift within its lifetime.
- Provider completion/billing can remain uncertain after cancellation or timeout; no automatic POST retry is allowed.
- Existing lint/build notices and limited-scope typecheck remain as recorded above; no extra code/dependency/model/environment work was undertaken to suppress them.
