# Ollalink subtitle translation and number normalization (Phase 2)

## Documentation gate and contracts

The existing [Phase 1 integration](ollalink-transcription.md) and official public documentation were inspected before implementation on 2026-10-29:

- [Translation and normalization](https://voices.networkershome.com/docs/translation/) and its [canonical page](https://ollalink.com/docs/translation/).
- [Authentication](https://voices.networkershome.com/docs/authentication/).
- [Models and languages](https://voices.networkershome.com/docs/models-and-languages/).
- [Getting started](https://voices.networkershome.com/docs/getting-started/).

Both operations use POST, JSON, and the server-only X-NH-GPU-Key header with the existing approved GPU API key. They do not use Bearer authentication. No additional environment setting is required.

### Translation

Documented endpoint: https://ai.ollalink.com/v1/translate

Request fields:

| Field | Contract |
| --- | --- |
| text | Required string, at most 5,000 characters |
| target | Required supported language code |
| source | Optional supported language code; omit for auto-detection |
| stream | Optional, defaults to false; this integration omits it and uses non-streaming responses |

The documentation rejects additional request fields. Supported source/target languages are English (en), Hindi (hi), Spanish (es), French (fr), Chinese (zh), German (de), Arabic (ar), Brazilian Portuguese (pt), and Russian (ru).

Response fields used by the integration: translation (nonempty string), source (requested code or null for auto), target (requested code), numbers_verified (boolean), characters (source character count). The documented X-Translate-Chars usage header is not needed by the editor.

A false numbers_verified value produces a review warning. A true value is not proof of linguistic accuracy. The provider may also convert spoken numbers to digits during translation. Commands, names, numbers and placeholders still require human review. Documentation describes a provider-internal retry for number/placeholder preservation; it is separate from the bounded HTTP retry described below.

### Spoken-number normalization

Documented endpoint: https://ai.ollalink.com/v1/normalize

Request fields: text (required, at most 5,000 characters), language (en or hi; provider default en). The integration always sends the explicitly selected language.

Response fields: text (original string), normalized (output string), changed (boolean), language, characters (source character count). The integration checks the original echo and changed flag for consistency.

This is **spoken numbers to digits**, including technical/time/IP examples. It is not grammar correction or general rewriting. The documented tool can leave isolated ambiguous words such as one/two unchanged.

### Errors and provider limits

The docs describe bad_request / unsupported_language (400), unauthorized / not_approved / forbidden (401/403), too_long (413) and translation_unavailable (503). Text tools have a documented 600 requests per 60 seconds per key limit. Provider failure bodies are never returned to the browser or logged by this integration.

No unsupported contract was inferred. Saved public documentation text and HTML are local, ignored acceptance artifacts rather than production dependencies.

## Editor workflow

Open caption tools, import/create captions normally, then use **Translate subtitles** or **Normalize spoken numbers**:

1. Choose the selected caption or all captions. There is no total-caption limit in the workflow.
2. Choose translation source/target or normalization language.
3. Run the action. Only cue text and language choices leave the server; timestamps, audio, caption styling and other project metadata are not sent upstream.
4. Review original/proposed text side by side, paginated at 20 cues per page for long projects. Edit the proposal if needed.
5. **Apply reviewed text** explicitly commits it, or **Discard review** leaves the original captions unchanged.

Processing is split into automatic internal batches (20 cues and at most 10,000 Unicode codepoints per request). The batch size is an internal scheduling detail and is not user-configurable or exposed. Batches are dispatched by a bounded adaptive scheduler: it starts with two requests in flight, raises the allowance by one after each pair of consecutive successes up to a hard ceiling of four, and drops back to one on any rate-limit signal before resuming. Batches may therefore finish out of order, but results are stored per batch index and flattened in index order, so the aggregated review and the applied captions always follow the original caption order. Results from every successful batch accumulate into a single review session.

The component reports real caption counts and phases: **Preparing captions**, **Processing batch N of M** with "X of Y captions", **Waiting for an available request slot (N of M request slots in use)**, **Waiting for provider cooldown**, **Retrying the failed batch**, **Finalizing results** and **Ready for review**. A free concurrency slot is explicitly distinguished from a provider cooldown and is never described as a rate limit; with a single allowance the one in-flight request is reported as ordinary processing rather than as a blocked slot. It shows a determinate progress bar, a cancel action, safe failures and provider number-verification warnings. No partial job output is applied. If a batch fails, successful batches are retained temporarily, the failing batch is identified, and **Retry failed batch** resumes from that batch without re-dispatching earlier successful ones. A failed job is never reported as a success. Captions changed during processing cancel the pending operation; changing any caption after a review makes it stale and blocks application. Locked caption tracks cannot process or apply text. Switching tools/unmounting aborts pending browser work and ignores late results.

IDs, cue numbering/order, start/end timestamps, timeline offsets, audio links, per-cue styling and other metadata remain unchanged by application. Existing editing and standalone SRT export paths are reused without serializer changes.

**Karaoke fallback:** the `/v1/translate` and `/v1/normalize` responses contain only text, language and number-verification fields; [the provider contract](./ollalink-subtitle-text-tools.md:16) carries no target-word timing and offers no alignment endpoint, and the transcription lanes that do return word timestamps do so only for the source-language pass. Translated/normalized words therefore cannot inherit trustworthy source-word timestamps. Changed cues drop source word-alignment data, are marked manually timed and use the existing phrase-level rendering fallback. Even equal word counts do not establish alignment.

Because that cue can never advance an active word, [`hasUsableWordTiming`](../src/lib/karaoke.js:108) gates the renderer state instead of leaving karaoke advertised with a permanently `-1` active index. [`CaptionOverlay`](../src/components/CaptionOverlay.jsx:76) reports `data-karaoke="false"` and [`drawCaptionCanvas`](../src/lib/media.js:1512) disables the active-word path for such cues, so preview and burned export both render honest plain phrases. Unchanged cues retain their genuine word timing and karaoke data. The review explicitly explains this before application; no target-word timestamps are invented, rescaled or uniformly distributed.

## Security, reliability and operating limits

Implementation: [router](../server/routes/subtitleTools.js), [provider adapter](../server/services/transcription/ollalinkTextTools.js), [shared validation/client/apply helpers](../src/lib/subtitleTextTools.js), and [review UI](../src/components/SubtitleTextTools.jsx).

- Authenticated session, trusted origin, Sec-Fetch-Site and custom request-header checks before parsing/inference.
- Local authenticated endpoint: POST /api/subtitle-tools. No user-selected upstream URL or query parameters.
- Strict field/language/unique cue-ID validation; timestamps and unknown fields are rejected.
- Dedicated 100,000-byte JSON parser, no compressed request inflation, 30-second upload timeout; safe parser errors.
- At most eight active jobs and sixty authenticated requests/minute/IP (see [Why the limits were raised](#why-the-limits-were-raised)).
- Per request: at least one nonempty cue, maximum 5,000 Unicode codepoints per cue and 10,000 total. There is no total cue-count cap; the character bound is the editor policy that drives batching. Oversized cues are rejected rather than silently split/resegmented.
- Upstream requests are sequential per cue but batches may overlap: at most `TEXT_TOOL_MAX_CONCURRENCY` (4) batches are in flight at once. Each batch is dispatched exactly once - the scheduler skips both completed and in-flight batch indexes, which is what makes retry and out-of-order completion safe. A batch failure is surfaced with its batch index and retained successes; nothing is applied until the complete set succeeds and a human approves it.
- The client mirrors the route allowance (`TEXT_TOOL_ROUTE_REQUESTS_PER_MINUTE`, 60) and honours `Retry-After` and `X-RateLimit-*` headers by pausing before the next batch and reducing concurrency, so batching paces itself instead of provoking avoidable 429 responses.
- Provider response capped at 256,000 bytes, with required field/type/language/character-count validation and at most 20,000 codepoints of output per cue.
- Fixed upstream URLs, redirects rejected, key only in server request headers. No text, credential or raw failure-body logging was added.
- 120-second whole-job server deadline and 130-second client deadline. Browser cancellation/disconnect aborts outstanding HTTP work and prevents further cue dispatch. It does **not** guarantee GPU compute cancellation or avoid provider billing.
- One retry per cue only for HTTP 429/502/503/504, minimum 500 ms delay, Retry-After bounded to five seconds, within the same job deadline. No auth-error or malformed-success retry; network failures are not blindly retried.
- Conservative 500 upstream dispatches/minute/process. Multiple server instances and other consumers of the same key still need shared quota/rate coordination in production.
- No automatic Local Whisper fallback for text tools; Local Whisper remains the existing independent/default transcription workflow. No server-side caption-text persistence was added.
- The UI labels added for this feature are currently English. Linguistic correctness remains a human-review responsibility, particularly for names, numbers, placeholders and line lengths.

## Verification (2026-10-29)

### Deterministic tests

[Provider/client/review tests](../server/tests/ollalink-text-tools.test.js) and [authenticated route tests](../server/tests/ollalink-text-tools-route.test.js): **33 passed**. Mocked provider coverage includes all 81 documented source/target combinations, auto source, en/hi normalization contracts, unsupported codes, unknown fields, Unicode/size limits, malformed responses, mismatched IDs/metadata, timeouts, retries/failures, stalled bodies, disconnect cancellation, rate/concurrency controls, snapshot invalidation, word-data handling and SRT invariants. This matrix tests contracts, not language quality.

The selected Phase 1/caption/transcript/CLI/export-related regression run, including the new suites: **268 tests passed, zero failed/skipped**. Another **71 authentication, health, project API and security tests passed**, covering the existing application routes after parser ordering changed: **339 tests total across the two final runs**. Typecheck passed; full lint passed with **0 errors, 392 warnings**; production build passed (existing large-chunk warnings). New production/test files pass targeted lint without warnings.

### Automatic batching verification (2026-11-02)

[Batch scheduler tests](../tests/caption-text-batching.test.js) cover both operations at 1, 20, 21, 40, 100, 615, 2,000 and 10,001 captions with mocked provider responses: every eligible cue processed exactly once, flattened batch order equal to the original order, batch-boundary independence, exact progress counts, cancellation before a batch / during an active request / during a rate-limit cooldown, retry that re-dispatches only the failed and later batches, non-checkpointing of malformed batches, aggregate character-budget splitting and the absence of any cue-count rejection. The full browser matrix passed with zero live provider calls.

### Why the limits were raised

The six-requests-per-minute restriction was **not** a provider limit. It was an application-imposed authenticated route limiter in [`server/routes/subtitleTools.js`](../server/routes/subtitleTools.js) (`SUBTITLE_TOOL_REQUESTS_PER_MINUTE`), sized for one request per user action, and it dominated long jobs: 615 captions is 31 batches, so sequencing them against six per minute cost about five minutes of pure waiting.

| Limit | Before | After | Source |
| --- | --- | --- | --- |
| Authenticated route requests/IP | 6/minute | **60/minute** | Application (`subtitleTools.js`) |
| Active jobs per process | 2 | **8** | Application (`subtitleTools.js`) |
| Process-wide upstream dispatches | 500/minute | 500/minute (unchanged) | Application (`ollalinkTextTools.js`) |
| Provider request quota | 600 requests/60 s per key | 600 requests/60 s per key | **Provider-documented** |
| Provider simultaneous connections | not documented | not documented | **Unknown** - open dependency |

Sixty per minute is still ten times below both the conservative 500/minute process ceiling and the documented 600/minute provider key quota, and it remains a real authenticated per-IP abuse control: session, trusted origin, `Sec-Fetch-Site` and custom-header checks are untouched, and the limiter was raised rather than removed.

**Open dependency:** the provider documentation states a *request* quota but does **not** document a *simultaneous-connection* allowance, and no response header advertising one was observed. Maximum concurrency is therefore held at a deliberately modest **4**, roughly 150 times below the request quota, and any rate-limit response or `Retry-After`/`X-RateLimit-*` header still drops the allowance back to one. If the provider later publishes a parallelism limit, `TEXT_TOOL_MAX_CONCURRENCY` is the single internal knob to lower.

### Benchmark (simulated latency only)

Both schedulers were timed against the identical mocked provider with an identical fixed per-batch latency, so only the scheduling strategy differs:

```text
615 captions, 31 batches, 10 ms simulated latency per batch
  sequential, one request in flight:      477-488 ms
  adaptive, bounded 2 rising to 4:        138-152 ms
  speedup: 3.2-3.5x
```

The ratio tracks the bounded fan-out, not an unbounded burst. **These are mock-based numbers.** They show that the scheduler stops idling while a slot is free. They do **not** establish that live Ollalink processing is 3x faster, because live throughput is governed by provider latency and by the 600/minute key quota, neither of which is simulated. No live provider request was made for this measurement.

### Adaptive concurrency verification (2026-11-02)

[Adaptive scheduler tests](../tests/caption-text-batching.test.js): **47 passed**, including a client-mirror drift guard that imports the router module and fails if `TEXT_TOOL_ROUTE_REQUESTS_PER_MINUTE` no longer equals `SUBTITLE_TOOL_REQUESTS_PER_MINUTE`, or if two full adaptive jobs would not fit inside the job gate. Coverage includes ramp-up only after consecutive successes, backoff to one on rate-limit, `Retry-After`/`X-RateLimit-*` honouring, out-of-order completion with original-order aggregation, cancellation with several requests in flight, exactly-once retry, a stalled-fake-clock guard, capacity-versus-cooldown labelling, and the sequential-versus-adaptive benchmark above.

[Authenticated route tests](../server/tests/ollalink-text-tools-route.test.js): **8 passed**, asserting the raised gate and limiter values directly, that all eight slots are admitted before a 503 is returned, that disconnected requests abort while their slots stay reserved until work settles, and that request 61 is the first 429.

Browser matrix: **71 groups passed**, zero live provider calls, zero external attempts, zero page errors. New end-to-end coverage proves that several batches are genuinely in flight at once (two `fetch` calls outstanding before either resolves), that the status reads "Waiting for an available request slot (2 of 2 request slots in use)" and never claims a provider cooldown or rate limit while merely blocked on its own allowance, and that the deferred plus subsequently routed batches together cover every caption exactly once in original order.

### Real browser and live provider evidence

Real headless Chromium used normal UI OTP sign-in, normal SRT file import, caption controls and browser SRT download. Infrastructure used pg-mem and an in-memory mock email provider; it was not a production database/mail deployment.

Fresh live traffic used the existing server credential without displaying it:

- English → Spanish translation for two generic cues: HTTP 200 for both (1,472 ms and 239 ms upstream response latency in the successful run).
- English spoken numbers → 443: HTTP 200 (41 ms).
- Hindi spoken numbers → 443: HTTP 200 (43 ms).

The successful run used no success replay. It confirmed no source change before apply; editable proposals; explicit apply; unchanged IDs/order/timestamps; standalone SRT numbering, multiline text and millisecond offsets; normalization review/discard. Source/target language coverage beyond this live pair is mocked, not a live quality certification.

A separate Chromium follow-up used **simulated** provider failure, pending cancellation/late success and stale-review output, with **zero upstream requests**. It verified safe error visibility, unchanged originals, blocked stale apply, number-verification warning, real track-lock controls and unmount suppression. Both browser runs recorded zero page errors and zero React update warnings. Server deadlines, malformed output, all-or-nothing behavior and source word/karaoke preservation are deterministic tests, not claims of live-provider failure injection.

During browser harness development the first run stopped before any upstream call on an accessibility selector. A second run made two additional real translation calls (both 200) but stopped before application on a review-field accessibility selector. Explicit accessible names were added and the final workflow passed. **Total Phase 2 live upstream calls: six** (four translation, two normalization); no hidden retry or simulated response is counted as live success.

Local ignored evidence is under scratch/ollalink-phase2: public docs, original worktree status, test/lint/typecheck/build logs, browser reports/harness, browser screenshot and downloaded SRT. These artifacts do not contain the API key.

## Preservation and scope

Phase 2 adds the text-tool route, adapter, helpers, review UI/styles and tests, with narrow wiring in the application/sidebar/caption panel. The Phase 1 documentation receives a cross-link. Existing unrelated work was retained. The expanded file-by-file status comparison retains every baseline entry; no tracked files were deleted and dependency manifests are unchanged. A literal configured-key scan found zero matches in the built client and Phase 2 acceptance artifacts (only presence/counts were reported). No dependencies/manifests, Local Whisper code, model assets, model caches, TTS, diarization or video-export implementation were removed or migrated. No commit, push or deployment was performed.
