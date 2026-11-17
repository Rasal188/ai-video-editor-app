# Ollalink-first transcription — Stage 4 contract remediation

Phase 2 subtitle translation and spoken-number normalization are documented separately in [Ollalink subtitle text tools](ollalink-subtitle-text-tools.md). They do not replace or change the Phase 1 transcription workflow described here.

## Scope and use

**Ollalink Cloud is the default when no preference exists.** Captions and Audio share persisted provider and **spoken recording language** controls. Assistant, rough cut, Shorts, Smart Pipeline, auto-edit and WebMCP use the same preferences. Explicit Local remains on-device and never calls the cloud route. Cloud mode uploads decoded audio to Ollalink and requires sign-in and a configured server key.

Browser preferences are saved independently from UI locale. Saved projects include their transcription choice; opening one restores that choice for the current project without replacing the browser preference. Older projects and New Project use the saved browser choice, or Cloud/English when absent. Explicit control changes update the browser preference. Assistant freezes provider/language when the proposal is approved, not when it is planned. Other workflows freeze at run start. WebMCP discloses provider/upload/fallback settings during preparation and requires re-preparation if preferences change before start; an explicit request language overrides the shared spoken-language default.

Only explicitly classified temporary Cloud outages, transport failures or timeouts may fall back once to Local Whisper on this device. Cancellation, authentication, missing server configuration, invalid input, invalid responses, unsupported Cloud languages and unknown errors stop without fallback or retry. Audio preparation, progress callbacks and caption processing cannot authorize fallback, even when an exception has a temporary-looking code. Existing local worker/main-thread behavior, worker-only requirements, model assets, subtitle review, grouping, editing, timeline synchronization, karaoke and SRT export remain in place.

Local inference receives the captured spoken language as a **preference** and retains its existing autodetect-first behavior, unlike Cloud's explicitly selected language. Hindi and Arabic now have fallback mappings in both Local implementations, so unavailable/failed detection no longer maps those choices to Chinese. Forcing Local inference to ignore a successfully detected language would require a separate product decision; Stage 4 does not change that behavior.

The standalone [headless timeline CLI](../scripts/timeline-command.mjs) remains **Local Whisper only**, using [Node transcription](../src/lib/headlessTranscription.js). Browser preferences and Cloud-default routing do not apply to that separate interface. CLI migration is outside this contract remediation.

Captions eligibility uses the same nonmutating source resolver as generation. Decodable embedded video audio and standalone audio qualify without source extraction/registration. Unsupported or known silent/muted media, caption locks and busy state disable generation.

Generation progress and completion report the actual provider, including a local-fallback notice. Results and generated caption segments carry an additive structured transcription outcome. Review regrouping, Assistant staging, rough-cut drafts/cache, Shorts candidates, Smart Pipeline plans/reviews, auto-edit output and WebMCP captions/operations retain provenance and available word metadata. Reusing an old transcript preserves its original provenance; legacy captions without metadata are not relabeled as newly generated Cloud results.

The [shared outcome helpers](../src/lib/transcriptionOutcome.js) distinguish succeeded, failed and cancelled work, the requested provider, the attempted/actual provider when known, fallback attempted/used, and safe allowlisted reason codes. A provider on a failed/cancelled outcome identifies an attempt, **not a successful transcript**; only succeeded outcomes identify the producer. Existing provider/result fields remain compatible. Workflow disclosures explicitly distinguish failure/cancellation from success, and raw error text or credentials are not copied into outcomes. SRT does not encode custom provenance; metadata retention applies to structured editor results/captions.

## Server setup

1. Create an approved **GPU API key** at https://login.ollalink.com under Platform → GPU API keys. A pending workspace/key can return 403. Dashboard/partner keys are not substitutes.
2. Configure the server-only [OLLALINK_API_KEY](../server/config.js) setting using the deployment secret manager or the existing local environment mechanism. See the blank entry in [.env.example](../.env.example). Never give it a Vite prefix, place it in browser storage, or paste it into client configuration. Restart the backend after changing it.
3. Run the existing backend and database/session setup. The user must sign in: cloud transcription uses the existing session cookie. A static frontend alone cannot provide this feature.
4. Route browser API requests through the same application origin. Configure the existing [CORS_ORIGIN](../server/config.js) setting to the exact frontend origin when a reverse proxy changes the Host header. For Vite development this is normally http://localhost:5173, but use the port actually selected by Vite. Do not use a wildcard for this paid route. The existing [Vite proxy](../vite.config.mjs) changes the upstream Host header, so an explicit frontend origin is important.
5. Use the existing [server and development scripts](../package.json). Node must support built-in fetch, multipart FormData, Blob and combined abort signals; implementation verification used Node 24.19.0.

The key is sent only from the backend using the documented **X-NH-GPU-Key** header, not Bearer authentication. The browser sends no provider credential. Credentials and raw upstream errors/transcripts are not logged by the new adapter.

## Documented provider contract

Documentation consulted:
- https://voices.networkershome.com/docs/speech-to-text/
- https://voices.networkershome.com/docs/getting-started/
- https://voices.networkershome.com/docs/authentication/

Both lanes use POST multipart uploads to fixed hosts. The backend constructs the multipart body; callers cannot supply an upstream URL, filename, model, prompt or authentication header. Redirects are rejected.

| Spoken languages | Upstream endpoint | Requested response/timing |
| --- | --- | --- |
| English, Spanish, French, German, Portuguese, Russian | https://gpu-transcribe.ollalink.com/v1/audio/transcriptions | Verbose JSON with top-level words and timestamps in seconds |
| Hindi, Chinese, Arabic | https://gpu-asrhq.ollalink.com/v1/audio/transcriptions | Legacy ASR model with per-segment word timestamps in seconds |

The exact [multipart fields and model selection](../server/services/transcription/ollalinkTranscription.js:89) are pinned in the adapter. Both lanes request number normalization disabled to retain spoken-word alignment. The HQ accuracy/fast Hindi models do not provide the required word timestamps; this integration deliberately requests the documented legacy model rather than claiming accuracy-model word alignment. Hindi is explicitly pinned to avoid auto-detection as Urdu. At that historical Phase 1 checkpoint, no provider translation, diarization, TTS or additional assistant migration was implemented.

The editor sends a deliberately narrow, validated subset of the provider's supported formats: canonical mono PCM16 WAV at 16 kHz, generated from the existing audio decoder. Upload limits are **100,000,000 bytes for fast** and **32,000,000 bytes plus 10 minutes for HQ**. These are editor policy limits; the conservative HQ restriction is not a broader guarantee about legacy-model limits. No chunked long-job transcription has been added.

The [normalizer](../server/services/transcription/ollalinkTranscription.js:18) requires a nonempty transcript, matching language, plausible duration and valid monotonic word starts within the audio duration. Missing or malformed word alignment is rejected rather than synthesizing timings from segment durations. Word chunks flow into the existing [caption grouping](../src/lib/captionSegmentation.js), with timeline offset applied once. Existing video-export serialization retains display normalization; the standalone SRT action preserves current edited caption punctuation and multiline text.

## Security and operational bounds

The [authenticated route](../server/routes/transcription.js) requires a session, a custom anti-CSRF request header, and a trusted origin when Origin is supplied. Cross-site browser requests are rejected even if the global CORS configuration is permissive. Raw uploads are bounded, compressed requests are rejected, and the upload inactivity timeout is 30 seconds.

Each backend process permits at most two active transcription uploads/provider jobs and six requests per minute per IP. These are in-memory safeguards, not a distributed billing quota. A multi-instance deployment needs shared throttling/quotas and appropriate reverse-proxy limits. Authenticated users can consume the configured account's paid service; operators remain responsible for account access and spending controls.

The adapter has a total 120-second provider budget, an 8 MB response-body bound and **exactly one upstream attempt**. It does not retry potentially billable uploads, including 429/5xx responses with Retry-After. Eligible outage fallback happens once in the browser using Local Whisper, not another paid request. The browser budget is 130 seconds; disconnect/cancellation signals the backend and upstream HTTP request to abort. This does not prove remote GPU compute stopped. A timed-out or cancelled remote request might already have incurred provider charges.

The route does not persist uploaded audio. Selected cloud audio is nevertheless processed by the external provider under its policies; this implementation makes no new retention/privacy guarantees about that provider. Responses are marked no-store. Errors are sanitized before reaching the browser. No provider key or raw failure body should be included in support logs.

## Verification and limitations

Deterministic automated provider tests use mocked traffic. The [provider/client tests](../server/tests/ollalink-transcription.test.js) and [route tests](../server/tests/ollalink-transcription-route.test.js) cover routing, fields/authentication, WAV limits, word timestamps, malformed responses, authentication errors, single-attempt billing safety, rate limiting, timeout, cancellation, upload restrictions, concurrency and local fallback. [Stage 2 migration tests](../tests/caption-stage2-migration.test.js) cover shared preferences, eligibility, frozen routing and WebMCP disclosure. Existing transcription/extraction, review, word-caption, karaoke and caption-timing suites provide downstream regression coverage. Stage 2 implementation uses mocked inference only; live/paid inference requires separate explicit authorization.

Type checking only covers the repository's configured TypeScript inputs; the new JavaScript is covered by tests and lint, not strict TypeScript checking. Production build success is not proof of provider inference or browser acceptance.

The original Phase 1 implementation verification had no configured key or live/browser inference evidence. Subsequent acceptance recorded live English fast-lane success; that historical evidence is not a fresh verification of later code. Phase 1C reran real Chromium with a saved real cloud response replay, simulated pending HTTP cancellation and outage, and real local Whisper inference (including fallback). No new live cloud request or live HQ-language verification was performed in Phase 1C. See the [Phase 1C acceptance summary](../scratch/ollalink-phase1c-20261029/acceptance-summary.md) for exact commands, evidence labels and limitations. The provider control currently uses English labels alongside native language names.

For a separately authorized live acceptance check after securely configuring the approved key: sign in, confirm the Cloud provider, choose a short recording's actual language, generate captions, verify the reported provider, inspect word timing against speech, edit/regroup and export SRT. Repeat with a Hindi recording for the HQ legacy-word path. Use an explicitly classified mocked temporary upstream failure to confirm the visible Local fallback without another paid request; missing server configuration must stop without fallback. Cancel a mocked pending request to confirm no Local fallback starts. Use non-sensitive test audio; never print credentials or raw provider errors. Stage 4 runs deterministic mocked regression tests only, not new live/provider or Local model inference, and does not establish full migration acceptance.

## Phase 1C normal-UI behavior

- Selected-audio transcription has a separate accessible status region and **Cancel transcription** action. Clip duration stays visible. Ollalink, Local Whisper loading/transcription and cloud-to-local fallback identify the actual provider. Phases without measured percentages use an indeterminate progress indicator.
- Cancel aborts source fetches and applicable HTTP/worker work, suppresses late progress/results/errors/notifications, and never starts cloud-failure fallback. Worker inference can be stopped by terminating its worker. Main-thread model loading/inference cannot be forcibly interrupted: cancellation discards late output and prevents subsequent processing, while the operation stays busy until the outstanding work settles. A subsequent operation is then allowed. Unmount removes operation ownership and abort listeners.
- In caption controls, **Download SRT** directly requests a browser download of current edited captions, without rendering video or enabling burn-in. It preserves cue order, numbering, timestamps, punctuation and multiline text using the existing serializer's opt-in text-preservation mode. Empty captions show a notice; preparation failures show a retry notice. Temporary download elements and object URLs are cleaned up.
- The browser action requests a download; it cannot confirm durable disk delivery. Simplified video-export defaults remain burned captions and are independent of this action. No model, worker asset, cache or dependency was removed or replaced.
