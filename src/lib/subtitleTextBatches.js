import {
    TEXT_TOOL_BATCH_SIZE, TEXT_TOOL_MAX_CHARACTERS, TEXT_TOOL_MAX_CONCURRENCY,
    TEXT_TOOL_INITIAL_CONCURRENCY, TEXT_TOOL_ROUTE_REQUESTS_PER_MINUTE,
    textCharacterCount, validateSubtitleTextRequest, validateSubtitleTextResult,
    requestSubtitleTextTools,
} from "./subtitleTextTools.js";

const RATE_WINDOW_MS = 60000;
// Chunk long waits so browser timers never overflow.
const MAX_WAIT_CHUNK_MS = 60000;
// A scheduling wait is expected to advance the caller's clock. Fake clocks that
// return immediately must not spin forever, so after this many stalled waits the
// scheduler stops honouring its own blocks and lets the route answer instead.
const MAX_STALLED_WAITS = 3;

// Abortable scheduling waits are outside the existing per-request deadline.
export function waitForSubtitleBatch(ms, signal) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, ms);
        signal?.addEventListener("abort", cancel, { once: true });
    });
}

const positiveInteger = (value, name) => {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid caption scheduling ${name}.`);
    return value;
};

export function createSubtitleTextBatchJob(request, {
    batchSize = TEXT_TOOL_BATCH_SIZE, requestImpl = requestSubtitleTextTools,
    now = Date.now, waitImpl = waitForSubtitleBatch,
    initialConcurrency = TEXT_TOOL_INITIAL_CONCURRENCY,
    maxConcurrency = TEXT_TOOL_MAX_CONCURRENCY,
    rampAfter = 2,
    requestsPerMinute = TEXT_TOOL_ROUTE_REQUESTS_PER_MINUTE,
} = {}) {
    positiveInteger(batchSize, "batch size");
    positiveInteger(maxConcurrency, "maximum concurrency");
    positiveInteger(initialConcurrency, "initial concurrency");
    positiveInteger(rampAfter, "ramp threshold");
    if (initialConcurrency > maxConcurrency) throw new Error("Invalid caption scheduling initial concurrency.");
    // Infinity disables the local quota mirror entirely.
    if (requestsPerMinute !== Infinity) positiveInteger(requestsPerMinute, "request quota");
    if (!Array.isArray(request?.cues) || !request.cues.length) throw new Error("No eligible captions to process.");
    const { cues, ...options } = request;
    const ids = new Set();
    const batches = [];
    let batch = [];
    let characters = 0;
    for (const cue of cues) {
        // Validate every cue before dispatching anything. No truncation or partial
        // operation is allowed when a later cue is invalid or oversized.
        validateSubtitleTextRequest({ ...options, cues: [cue] });
        if (ids.has(cue.id)) throw new Error("Duplicate caption ID.");
        ids.add(cue.id);
        const count = textCharacterCount(cue.text);
        if (batch.length && (batch.length >= batchSize || characters + count > TEXT_TOOL_MAX_CHARACTERS)) {
            batches.push(batch); batch = []; characters = 0;
        }
        batch.push({ id: cue.id, text: cue.text });
        characters += count;
    }
    if (batch.length) batches.push(batch);

    let running = false;
    let attempts = 0;
    let phase = null;
    let waitReason = null;
    let limit = initialConcurrency;
    let successfulInARow = 0;
    let nextAllowedAt = 0;
    let quota = requestsPerMinute;
    let processed = 0;
    // Results are keyed by batch index so batches may finish out of order while the
    // final flattening still follows the original caption order.
    const results = [];
    const completed = new Set();
    const inFlight = new Map();
    const dispatchTimes = [];

    const firstIncomplete = () => {
        let index = 0;
        while (index < batches.length && completed.has(index)) index += 1;
        return index;
    };
    // Never re-dispatch a batch that already succeeded or is already running. This
    // is what makes retries and out-of-order completion safe.
    const nextDispatchIndex = () => {
        let index = 0;
        while (index < batches.length && (completed.has(index) || inFlight.has(index))) index += 1;
        return index;
    };
    const progress = (nextPhase, reason = null) => ({
        phase: nextPhase, processed, total: cues.length,
        batch: Math.min(firstIncomplete() + 1, batches.length), batches: batches.length,
        concurrency: limit, activeBatches: inFlight.size,
        ...(nextPhase === "waiting" ? { waitReason: reason ?? "capacity" } : {}),
    });

    return {
        get progress() {
            const done = completed.size >= batches.length;
            return progress(running && phase ? phase : done ? "ready" : "paused", waitReason);
        },
        async run({ signal, onProgress = () => { } } = {}) {
            if (running) throw new Error("Caption batch processing is already running.");
            running = true;
            inFlight.clear();
            dispatchTimes.length = 0;
            // A resumed run keeps successful batches and re-dispatches only what is
            // still incomplete.
            const resumed = attempts > 0 && completed.size > 0;
            attempts += 1;
            let retrying = resumed;
            let failure = null;
            let stopping = false;
            let stalls = 0;
            const emit = (nextPhase, reason = null) => {
                phase = nextPhase; waitReason = reason;
                onProgress(progress(nextPhase, reason));
            };
            const stalled = before => {
                if (now() > before) { stalls = 0; return false; }
                stalls += 1;
                if (stalls < MAX_STALLED_WAITS) return false;
                // The caller's clock is not advancing, so local scheduling blocks
                // can never be satisfied. Degrade to letting the route respond.
                stalls = 0; nextAllowedAt = 0; quota = Infinity;
                return true;
            };
            const dispatch = index => {
                const batchRequest = { ...options, cues: batches[index] };
                const promise = (async () => {
                    const received = await requestImpl(batchRequest, {
                        signal,
                        onRateLimit: at => {
                            // Provider or route backpressure: pause new dispatches and
                            // step the concurrency allowance back down. In-flight batches
                            // keep running so their results are still checkpointed.
                            limit = Math.max(1, limit - 1);
                            successfulInARow = 0;
                            if (Number.isFinite(at)) nextAllowedAt = Math.max(nextAllowedAt, at);
                        },
                    });
                    // Abort-insensitive transports must not publish late results or
                    // advance the job after cancellation.
                    signal?.throwIfAborted();
                    validateSubtitleTextResult({ operation: options.operation, results: received }, batchRequest);
                    return received;
                })();
                inFlight.set(index, promise);
            };
            // Race every outstanding batch so completion order never matters.
            const settle = async () => {
                const outcome = await Promise.race([...inFlight.entries()].map(([index, promise]) =>
                    promise.then(value => ({ index, value, error: null }), error => ({ index, error }))));
                inFlight.delete(outcome.index);
                return outcome;
            };
            const checkpoint = outcome => {
                results[outcome.index] = outcome.value;
                completed.add(outcome.index);
                processed += outcome.value.length;
                successfulInARow += 1;
                // Gradual, bounded increase after consecutive successes so a single
                // fast response cannot immediately widen the request window.
                if (successfulInARow >= rampAfter && limit < maxConcurrency) { limit += 1; successfulInARow = 0; }
            };
            const fail = outcome => {
                failure = failure ?? { index: outcome.index, error: outcome.error };
                stopping = true;
            };
            try {
                signal?.throwIfAborted();
                emit("preparing");
                if (resumed) emit("retrying");
                while (completed.size < batches.length && !stopping) {
                    signal?.throwIfAborted();
                    const at = now();
                    if (Number.isFinite(quota)) {
                        // Local mirror of the authenticated route quota so the client
                        // does not deliberately bounce off a 429.
                        while (dispatchTimes.length && at - dispatchTimes[0] >= RATE_WINDOW_MS) dispatchTimes.shift();
                        if (dispatchTimes.length >= quota) nextAllowedAt = Math.max(nextAllowedAt, dispatchTimes[0] + RATE_WINDOW_MS);
                    }
                    while (inFlight.size < limit && nextAllowedAt <= at) {
                        const index = nextDispatchIndex();
                        if (index >= batches.length) break;
                        if (Number.isFinite(quota)) dispatchTimes.push(at);
                        dispatch(index);
                    }
                    if (!inFlight.size) {
                        // Nothing running: either the work is done or capacity is
                        // blocked by a cooldown/quota window.
                        if (nextDispatchIndex() >= batches.length) break;
                        const before = now();
                        emit("waiting", "cooldown");
                        await waitImpl(Math.min(Math.max(nextAllowedAt - before, 0), MAX_WAIT_CHUNK_MS), signal);
                        signal?.throwIfAborted();
                        stalled(before);
                        continue;
                    }
                    // Requests are outstanding. "capacity" only makes sense once more
                    // than one slot exists: with a single allowance the one in-flight
                    // request is ordinary processing, not a blocked slot. It must never
                    // be reported as a provider cooldown either.
                    if (retrying) emit("retrying");
                    else if (limit > 1 && inFlight.size >= limit && nextDispatchIndex() < batches.length) emit("waiting", "capacity");
                    else emit("processing");
                    const outcome = await settle();
                    signal?.throwIfAborted();
                    if (outcome.error) { fail(outcome); continue; }
                    checkpoint(outcome);
                    retrying = false;
                    emit("processed");
                }
                // Let already-dispatched batches settle so successes stay checkpointed
                // and no promise is left unobserved.
                while (inFlight.size) {
                    const outcome = await settle();
                    if (signal?.aborted) continue;
                    if (outcome.error) { fail(outcome); continue; }
                    checkpoint(outcome);
                }
                signal?.throwIfAborted();
                if (failure) throw failure.error;
                emit("finalizing");
                emit("ready");
                // Batches are contiguous slices of the original cue order, so index
                // order restores the original caption order exactly.
                return results.flat();
            } catch (error) {
                if (!signal?.aborted) { phase = "failed"; waitReason = null; onProgress(progress("failed")); }
                throw error;
            } finally { running = false; }
        },
    };
}
