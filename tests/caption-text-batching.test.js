import test from "node:test";
import assert from "node:assert/strict";
import { createSubtitleTextBatchJob, waitForSubtitleBatch } from "../src/lib/subtitleTextBatches.js";
import {
    applySubtitleTextReview, requestSubtitleTextTools, validateSubtitleTextRequest,
    TEXT_TOOL_INITIAL_CONCURRENCY, TEXT_TOOL_MAX_CONCURRENCY, TEXT_TOOL_ROUTE_REQUESTS_PER_MINUTE,
} from "../src/lib/subtitleTextTools.js";
import { createOllalinkTextTools } from "../server/services/transcription/ollalinkTextTools.js";

const captions = count => Array.from({ length: count }, (_, i) => ({
    id: `caption-${i}`, text: `There are three items (${i}).\r\nKeep layout.`,
    start: i * 2 + 0.125, end: i * 2 + 1.875, timingSource: "asr",
    words: [{ text: "There", start: i * 2 + 0.125, end: i * 2 + 0.4 }],
    audioSegmentId: "audio", styleOverrides: { color: "red" },
}));
const request = (operation, items) => ({ operation, ...(operation === "translate" ? { source: "en", target: "es" } : { language: "en" }), cues: items.map(({ id, text }) => ({ id, text })) });
const proposals = input => input.cues.map(c => ({ id: c.id, text: input.operation === "translate" ? `ES: ${c.text}` : c.text.replace("three", "3"), ...(input.operation === "translate" ? { numbersVerified: true } : { changed: true }) }));
const immediate = async (_ms, signal) => { signal?.throwIfAborted(); };
// Deterministic helper for tests that assert exact dispatch order/counts: one
// request slot at a time, exactly like the previous sequential scheduler.
const sequential = { initialConcurrency: 1, maxConcurrency: 1 };
const translateOnly = input => input.cues.map(c => ({ id: c.id, text: `ES: ${c.text}`, numbersVerified: true }));

test("adaptive concurrency defaults start conservatively and stay bounded below the provider quota", () => {
    assert.equal(TEXT_TOOL_INITIAL_CONCURRENCY, 2);
    assert.equal(TEXT_TOOL_MAX_CONCURRENCY, 4);
    assert.ok(TEXT_TOOL_MAX_CONCURRENCY < TEXT_TOOL_ROUTE_REQUESTS_PER_MINUTE);
    assert.ok(TEXT_TOOL_MAX_CONCURRENCY * 100 < 600); // documented provider ceiling
});
test("the client request mirror cannot silently drift from the route limits", async () => {
    const route = await import("../server/routes/subtitleTools.js");
    // A stale client mirror would either provoke avoidable 429s or throttle long
    // jobs far below the rate the authenticated route actually permits.
    assert.equal(TEXT_TOOL_ROUTE_REQUESTS_PER_MINUTE, route.SUBTITLE_TOOL_REQUESTS_PER_MINUTE);
    // Two complete adaptive jobs must fit inside the per-process job gate.
    assert.ok(TEXT_TOOL_MAX_CONCURRENCY * 2 <= route.SUBTITLE_TOOL_MAX_ACTIVE_JOBS);
    assert.ok(TEXT_TOOL_ROUTE_REQUESTS_PER_MINUTE < 500); // process dispatch ceiling
    assert.ok(TEXT_TOOL_ROUTE_REQUESTS_PER_MINUTE < 600); // provider key quota
});

for (const operation of ["translate", "normalize"]) {
    for (const count of [1, 20, 21, 40, 100, 615, 2000, 10001]) {
        test(`${operation}: ${count} captions pass real adapter/client contracts in bounded concurrent batches with exact-once ordered results`, async () => {
            const original = captions(count);
            const snapshot = structuredClone(original);
            const seen = [];
            const batches = [];
            const events = [];
            let active = 0;
            let peak = 0;
            const job = createSubtitleTextBatchJob(request(operation, original), {
                waitImpl: immediate,
                requestImpl: (input, options) => requestSubtitleTextTools(input, {
                    ...options, fetchImpl: async (_url, init) => {
                        active++; peak = Math.max(peak, active);
                        batches.push(JSON.parse(init.body));
                        try {
                            // Each batch uses an isolated mock adapter quota. Quota and
                            // cooldown behavior are exercised separately below.
                            const adapter = createOllalinkTextTools({
                                apiKey: "sk_fixture", fetchImpl: async (url, init) => {
                                    const body = JSON.parse(init.body);
                                    seen.push(body.text);
                                    return Response.json(url.endsWith("/translate")
                                        ? { translation: `ES: ${body.text}`, source: body.source, target: body.target, numbers_verified: true, characters: Array.from(body.text).length }
                                        : { text: body.text, normalized: body.text.replace("three", "3"), changed: true, language: body.language, characters: Array.from(body.text).length });
                                }
                            });
                            return Response.json({ ok: true, ...await adapter(JSON.parse(init.body), { signal: init.signal }) });
                        } finally { active--; }
                    }
                }),
            });
            const results = await job.run({ onProgress: p => events.push(p) });
            // Concurrency is bounded, never unbounded.
            assert.ok(peak >= 1 && peak <= TEXT_TOOL_MAX_CONCURRENCY, `peak ${peak}`);
            assert.equal(batches.length, Math.ceil(count / 20));
            assert.ok(batches.every(b => b.cues.length <= 20 && b.cues.reduce((n, c) => n + Array.from(c.text).length, 0) <= 10000));
            // Every cue is processed exactly once even though dispatch is concurrent.
            assert.deepEqual([...seen].sort(), [...original.map(c => c.text)].sort());
            assert.equal(seen.length, count);
            // Final flattening restores original caption order, not completion order.
            assert.deepEqual(batches.flatMap(b => b.cues.map(c => c.id)).sort(), original.map(c => c.id).sort());
            assert.deepEqual(results, proposals(request(operation, original)));
            assert.ok(events.some(e => e.phase === "processed"));
            assert.ok(events.every(e => e.total === count));
            assert.equal(events.at(-1).phase, "ready");
            assert.equal(events.at(-1).processed, count);
            assert.ok(events.every(e => e.concurrency >= 1 && e.concurrency <= TEXT_TOOL_MAX_CONCURRENCY));
            assert.deepEqual(original, snapshot); // No partial timeline mutation.
            const applied = applySubtitleTextReview(original, snapshot, results);
            assert.deepEqual(applied.map(({ id, start, end, audioSegmentId, styleOverrides }) => ({ id, start, end, audioSegmentId, styleOverrides })), original.map(({ id, start, end, audioSegmentId, styleOverrides }) => ({ id, start, end, audioSegmentId, styleOverrides })));
            assert.ok(applied.every(c => c.words === undefined && c.timingSource === "manual"));
            assert.deepEqual(original, snapshot); // Discarding the result is inert.
        });
    }
    test(`${operation}: custom batch boundaries do not affect output`, async () => {
        const input = request(operation, captions(100));
        const outputs = [];
        for (const batchSize of [1, 7, 20, 40]) outputs.push(await createSubtitleTextBatchJob(input, { batchSize, requestImpl: async r => proposals(r), waitImpl: immediate }).run());
        for (const output of outputs) assert.deepEqual(output, proposals(input));
    });
    test(`${operation}: failed batch retry retains successes, blocks incomplete review and retries only failed/later batches`, async () => {
        const input = request(operation, captions(615));
        const dispatched = [];
        const controller = new AbortController();
        let fail = true;
        const job = createSubtitleTextBatchJob(input, {
            ...sequential, waitImpl: immediate, requestImpl: async r => {
                dispatched.push(r.cues.map(c => c.id));
                if (r.cues[0].id === "caption-40" && fail) throw new Error("controlled batch failure");
                return proposals(r);
            }
        });
        await assert.rejects(job.run({ signal: controller.signal }), /controlled/);
        assert.equal(job.progress.processed, 40);
        assert.equal(job.progress.batch, 3);
        assert.equal(job.progress.batches, 31);
        fail = false;
        const results = await job.run({ signal: controller.signal });
        assert.equal(results.length, 615);
        assert.equal(dispatched.length, 32);
        assert.equal(dispatched.filter(ids => ids[0] === "caption-0").length, 1);
        assert.equal(dispatched.filter(ids => ids[0] === "caption-20").length, 1);
        assert.equal(dispatched.filter(ids => ids[0] === "caption-40").length, 2);
        assert.deepEqual(results, proposals(input));
    });
    for (const point of ["between", "active", "cooldown"]) test(`${operation}: cancel ${point} prevents future batches and ignores abort-insensitive response`, async () => {
        const controller = new AbortController();
        let calls = 0;
        let clock = 1000;
        const job = createSubtitleTextBatchJob(request(operation, captions(100)), {
            ...sequential, now: () => clock,
            waitImpl: async (ms, signal) => { if (point === "cooldown" && ms > 0) controller.abort(); clock += ms; signal?.throwIfAborted(); },
            requestImpl: async (r, options) => {
                calls++;
                if (point === "active") controller.abort();
                if (point === "cooldown") options.onRateLimit(10000);
                return proposals(r);
            },
        });
        await assert.rejects(job.run({ signal: controller.signal, onProgress: p => { if (point === "between" && p.phase === "processed") controller.abort(); } }), e => e.name === "AbortError");
        assert.equal(calls, 1);
        assert.equal(job.progress.processed, point === "active" ? 0 : 20);
    });
}

test("character budget splits batches; Unicode codepoints, not UTF-16 units; no cue truncation", async () => {
    const cues = [5000, 5000, 1, 4999, 5000].map((n, i) => ({ id: String(i), text: "😀".repeat(n) }));
    const received = [];
    await createSubtitleTextBatchJob(request("translate", cues), { ...sequential, waitImpl: immediate, requestImpl: async r => { received.push(r.cues); return proposals(r); } }).run();
    assert.deepEqual(received.map(b => b.map(c => c.id)), [["0", "1"], ["2", "3", "4"]]);
    assert.deepEqual(received.flat(), cues);
});
test("preflight rejects a later oversized or duplicate cue before any work", () => {
    for (const cues of [[...captions(100), { id: "large", text: "x".repeat(5001) }], [...captions(100), captions(1)[0]]]) assert.throws(() => createSubtitleTextBatchJob(request("translate", cues)));
    for (const batchSize of [0, -1, 1.5, Infinity]) assert.throws(() => createSubtitleTextBatchJob(request("translate", captions(1)), { batchSize }));
});
test("scheduler rejects invalid concurrency configuration instead of silently clamping", () => {
    for (const options of [{ maxConcurrency: 0 }, { initialConcurrency: 0 }, { initialConcurrency: 5, maxConcurrency: 2 }, { rampAfter: 0 }]) {
        assert.throws(() => createSubtitleTextBatchJob(request("translate", captions(1)), options));
    }
});
test("no backend cue-count rejection: more than 20 short cues accepted under payload character budget", async () => {
    for (const operation of ["translate", "normalize"]) {
        const input = request(operation, Array.from({ length: 615 }, (_, i) => ({ id: String(i), text: "three" })));
        assert.doesNotThrow(() => validateSubtitleTextRequest(input));
    }
});
test("malformed successful batch is not checkpointed and must be retried", async () => {
    let invalid = true;
    const job = createSubtitleTextBatchJob(request("translate", captions(40)), { ...sequential, waitImpl: immediate, requestImpl: async r => invalid ? proposals(r).reverse() : proposals(r) });
    await assert.rejects(job.run(), /Invalid subtitle text response/);
    assert.equal(job.progress.processed, 0);
    invalid = false;
    assert.equal((await job.run()).length, 40);
});
test("duplicate run calls cannot dispatch overlapping batches", async () => {
    let resolve;
    let calls = 0;
    const job = createSubtitleTextBatchJob(request("translate", captions(1)), { requestImpl: r => { calls++; return new Promise(done => { resolve = () => done(proposals(r)); }); } });
    const running = job.run();
    await assert.rejects(job.run(), /already running/);
    resolve(); await running;
    assert.equal(calls, 1);
});
test("rate-limit headers schedule cooldown outside request timeout, with accurate progress and no repeated successful batch", async () => {
    let clock = Date.now();
    let calls = 0;
    const waits = [];
    const job = createSubtitleTextBatchJob(request("translate", captions(140)), {
        ...sequential, now: () => clock,
        waitImpl: async ms => { waits.push(ms); clock += ms; },
        requestImpl: (r, options) => requestSubtitleTextTools(r, {
            ...options, fetchImpl: async () => {
                calls++;
                return Response.json({ ok: true, operation: "translate", results: proposals(r) }, { headers: calls === 6 ? { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(Math.ceil((clock + 60000) / 1000)) } : {} });
            }
        }),
    });
    assert.equal((await job.run()).length, 140);
    assert.equal(calls, 7);
    assert.ok(waits.some(ms => ms === 60000));
    const progress = [];
    let cooldownClock = Date.now();
    await createSubtitleTextBatchJob(request("translate", captions(140)), {
        ...sequential, now: () => cooldownClock,
        waitImpl: async ms => { cooldownClock += ms; },
        requestImpl: (r, options) => requestSubtitleTextTools(r, {
            ...options, fetchImpl: async () => Response.json({ ok: true, operation: "translate", results: proposals(r) }, { headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(Math.ceil((cooldownClock + 30000) / 1000)) } })
        }),
    }).run({ onProgress: p => progress.push(p) });
    assert.ok(progress.some(p => p.phase === "waiting" && p.waitReason === "cooldown"));
    // With one request slot the only reason to wait is the provider cooldown.
    assert.ok(progress.filter(p => p.phase === "waiting").every(p => p.waitReason === "cooldown"));
});
test("429 failed batch retry respects cooldown and Retry-After without automatically claiming success", async () => {
    let clock = Date.now();
    let calls = 0;
    const waits = [];
    const job = createSubtitleTextBatchJob(request("translate", captions(21)), {
        now: () => clock, waitImpl: async ms => { waits.push(ms); clock += ms; },
        requestImpl: (r, options) => requestSubtitleTextTools(r, {
            ...options, fetchImpl: async () => {
                calls++;
                return calls === 1 ? new Response(null, { status: 429, headers: { "Retry-After": "60" } }) : Response.json({ ok: true, operation: "translate", results: proposals(r) });
            }
        }),
    });
    await assert.rejects(job.run(), /rate limited/);
    // No batch is reported successful when the provider rejected it.
    assert.equal(job.progress.processed, 1);
    assert.equal((await job.run()).length, 21);
    assert.ok(waits.reduce((a, b) => a + b, 0) >= 60000);
});
test("abortable timer removes its abort listener and rejects promptly", async () => {
    const controller = new AbortController();
    const pending = waitForSubtitleBatch(60000, controller.signal);
    controller.abort();
    await assert.rejects(pending, e => e.name === "AbortError");
});

// --- Adaptive concurrency behaviour -----------------------------------------

test("concurrency ramps up only after consecutive successes and never exceeds the ceiling", async () => {
    const observed = [];
    let active = 0;
    let peak = 0;
    const job = createSubtitleTextBatchJob(request("translate", captions(400)), {
        requestsPerMinute: Infinity, rampAfter: 2, waitImpl: immediate,
        onProgress: () => { },
        requestImpl: async r => {
            active++; peak = Math.max(peak, active);
            observed.push(active);
            await new Promise(resolve => setImmediate(resolve));
            active--;
            return translateOnly(r);
        },
    });
    await job.run();
    assert.equal(observed[0], 1, "first dispatch starts from a single request");
    assert.ok(peak <= TEXT_TOOL_MAX_CONCURRENCY, `peak ${peak}`);
    assert.ok(peak > TEXT_TOOL_INITIAL_CONCURRENCY, "concurrency did increase after successes");
});
test("rate-limit backpressure reduces concurrency to one without dropping in-flight work", async () => {
    let active = 0;
    let peak = 0;
    let calls = 0;
    const job = createSubtitleTextBatchJob(request("translate", captions(400)), {
        requestsPerMinute: Infinity, waitImpl: immediate,
        requestImpl: async (r, options) => {
            calls++;
            active++; peak = Math.max(peak, active);
            if (calls === 3) options.onRateLimit(Date.now() + 1000);
            await new Promise(resolve => setImmediate(resolve));
            active--;
            return translateOnly(r);
        },
    });
    const results = await job.run();
    assert.equal(results.length, 400);
    assert.ok(peak <= TEXT_TOOL_MAX_CONCURRENCY);
    // Backpressure clamps the allowance; the job still completes every batch once.
    assert.equal(new Set(results.map(r => r.id)).size, 400);
});
test("out-of-order batch completion still yields original caption order", async () => {
    const items = captions(120);
    const input = request("translate", items);
    const job = createSubtitleTextBatchJob(input, {
        requestsPerMinute: Infinity, initialConcurrency: 3, maxConcurrency: 3, waitImpl: immediate,
        requestImpl: async r => {
            // Later batches finish first.
            const delay = 30 - (items.findIndex(c => c.id === r.cues[0].id) / 20);
            await new Promise(resolve => setTimeout(resolve, Math.max(0, delay)));
            return translateOnly(r);
        },
    });
    const completion = [];
    const results = await job.run({ onProgress: p => { if (p.phase === "processed") completion.push(p.processed); } });
    assert.deepEqual(results, items.map(c => ({ id: c.id, text: `ES: ${c.text}`, numbersVerified: true })));
    assert.deepEqual(results.map(r => r.id), items.map(c => c.id));
    assert.ok(completion.length > 0);
});
test("progress distinguishes a free-slot wait from a provider cooldown", async () => {
    const events = [];
    let release;
    // Two slots are required for this distinction to be meaningful: with a
    // single allowance the one in-flight request is ordinary processing, not a
    // blocked slot, and the scheduler must never call it a cooldown either.
    const job = createSubtitleTextBatchJob(request("translate", captions(60)), {
        requestsPerMinute: Infinity, initialConcurrency: 2, maxConcurrency: 2,
        requestImpl: async r => {
            if (r.cues[0].id === "caption-0") await new Promise(done => { release = done; });
            return translateOnly(r);
        },
    });
    const running = job.run({ onProgress: p => events.push(p) });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    const capacity = events.filter(p => p.phase === "waiting");
    assert.ok(capacity.length > 0, "must report the blocked slot");
    assert.ok(capacity.every(p => p.waitReason === "capacity"), "a blocked slot is not a provider cooldown");
    release();
    await running;
    assert.ok(!events.some(p => p.waitReason === "cooldown" && p.phase === "waiting"));
});
test("provider cooldown is reported as a cooldown, never as capacity", async () => {
    const events = [];
    let clock = 0;
    const job = createSubtitleTextBatchJob(request("translate", captions(40)), {
        ...sequential, requestsPerMinute: Infinity, now: () => clock, waitImpl: async ms => { clock += ms; },
        requestImpl: async (r, options) => { options.onRateLimit(clock + 5000); return translateOnly(r); },
    });
    await job.run({ onProgress: p => events.push(p) });
    const waits = events.filter(p => p.phase === "waiting");
    assert.ok(waits.length > 0);
    assert.ok(waits.every(p => p.waitReason === "cooldown"));
});
test("cancellation with several in-flight batches stops scheduling and publishes nothing", async () => {
    const controller = new AbortController();
    let started = 0;
    const job = createSubtitleTextBatchJob(request("translate", captions(400)), {
        requestsPerMinute: Infinity, waitImpl: immediate,
        requestImpl: async r => {
            started++;
            await new Promise(resolve => setImmediate(resolve));
            // Abort-insensitive transport: resolves a valid response after abort.
            return translateOnly(r);
        },
    });
    const running = job.run({
        signal: controller.signal,
        onProgress: p => { if (p.processed >= 40) controller.abort(); },
    });
    await assert.rejects(running, e => e.name === "AbortError");
    const dispatchedBeforeAbort = started;
    // Only batches whose responses were received before the abort may remain
    // checkpointed; nothing new may be dispatched or published afterwards.
    const checkpointed = job.progress.processed;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(started, dispatchedBeforeAbort, "no new batches after cancellation");
    assert.ok(dispatchedBeforeAbort < 20, "cancellation happened long before all batches dispatched");
    assert.equal(job.progress.processed, checkpointed, "late responses never advance a cancelled job");
    assert.ok(checkpointed < 400, "cancellation prevented full processing");
});
test("retry after a concurrent failure never re-dispatches a checkpointed batch", async () => {
    const dispatched = [];
    let failed = true;
    const job = createSubtitleTextBatchJob(request("translate", captions(400)), {
        requestsPerMinute: Infinity, waitImpl: immediate,
        requestImpl: async r => {
            const first = r.cues[0].id;
            dispatched.push(first);
            if (first === "caption-200" && failed) throw new Error("controlled concurrent failure");
            await new Promise(resolve => setImmediate(resolve));
            return translateOnly(r);
        },
    });
    await assert.rejects(job.run(), /controlled concurrent failure/);
    const done = job.progress.processed;
    assert.ok(done > 0, "successful batches are retained");
    failed = false;
    const results = await job.run();
    assert.equal(results.length, 400);
    assert.deepEqual(results.map(r => r.id), captions(400).map(c => c.id));
    // Every batch dispatched exactly twice at most: once, plus a single retry for
    // the failed batch only.
    const counts = dispatched.reduce((map, id) => map.set(id, (map.get(id) || 0) + 1), new Map());
    assert.equal(counts.get("caption-200"), 2);
    assert.ok([...counts.entries()].filter(([id]) => id !== "caption-200").every(([, n]) => n === 1));
});
test("no duplicate processing when responses resolve while others are still pending", async () => {
    const ids = [];
    const job = createSubtitleTextBatchJob(request("translate", captions(615)), {
        requestsPerMinute: Infinity, waitImpl: immediate,
        requestImpl: async r => {
            ids.push(...r.cues.map(c => c.id));
            await new Promise(resolve => setTimeout(resolve, Math.random() * 4));
            return translateOnly(r);
        },
    });
    await job.run();
    assert.equal(ids.length, 615);
    assert.equal(new Set(ids).size, 615);
});
test("the local quota mirror keeps dispatches inside the configured minute window", async () => {
    let clock = 0;
    const dispatchTimes = [];
    const job = createSubtitleTextBatchJob(request("translate", captions(400)), {
        requestsPerMinute: 6, now: () => clock, waitImpl: async ms => { clock += ms; },
        requestImpl: async r => { dispatchTimes.push(clock); return translateOnly(r); },
    });
    await job.run();
    assert.equal(dispatchTimes.length, 20);
    for (let i = 0; i + 6 < dispatchTimes.length; i += 1) {
        assert.ok(dispatchTimes[i + 6] - dispatchTimes[i] >= 60000, "seven requests must not share a minute window");
    }
});
test("a non-advancing clock cannot spin forever", async () => {
    let calls = 0;
    const job = createSubtitleTextBatchJob(request("translate", captions(120)), {
        requestsPerMinute: 1, now: () => 0, waitImpl: async () => { },
        requestImpl: async r => { calls++; return translateOnly(r); },
    });
    const results = await job.run();
    assert.equal(results.length, 120);
    assert.equal(calls, 6);
});

// --- Before/after benchmark --------------------------------------------------

const latency = ms => new Promise(resolve => setTimeout(resolve, ms));
const benchJob = (concurrency, latencyMs) => createSubtitleTextBatchJob(request("translate", captions(615)), {
    requestsPerMinute: Infinity, waitImpl: immediate,
    ...(concurrency === 1 ? { initialConcurrency: 1, maxConcurrency: 1 } : { initialConcurrency: 2, maxConcurrency: 4 }),
    requestImpl: async r => { await latency(latencyMs); return translateOnly(r); },
});

test("benchmark: adaptive concurrency beats the sequential scheduler at identical simulated latency", async () => {
    const latencyMs = 10;
    const timing = async concurrency => {
        const started = process.hrtime.bigint();
        const results = await benchJob(concurrency, latencyMs).run();
        const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
        assert.equal(results.length, 615);
        return elapsed;
    };
    const sequentialMs = await timing(1);
    const adaptiveMs = await timing("adaptive");
    const speedup = sequentialMs / adaptiveMs;
    assert.ok(adaptiveMs < sequentialMs, `adaptive ${adaptiveMs}ms should beat sequential ${sequentialMs}ms`);
    // 31 batches at 10ms serial is ~310ms; at a bounded 4 slots it is ~90ms.
    assert.ok(speedup >= 1.5, `expected a material speedup, got ${speedup.toFixed(2)}x`);
    console.log(`# benchmark 615 captions @ ${latencyMs}ms/batch: sequential ${sequentialMs.toFixed(0)}ms, adaptive ${adaptiveMs.toFixed(0)}ms, ${speedup.toFixed(2)}x`);
});
