import express, { Router } from "express";
import { config } from "../config.js";
import { requireAuth } from "../middleware/auth.js";
import { createRateLimiter } from "../middleware/rateLimiter.js";
import { validateSubtitleTextRequest } from "../../src/lib/subtitleTextTools.js";
import { createOllalinkTextTools, SubtitleTextError } from "../services/transcription/ollalinkTextTools.js";

// Bounded adaptive client concurrency (see src/lib/subtitleTextTools.js) dispatches
// at most TEXT_TOOL_MAX_CONCURRENCY batches at once, so the per-process job gate
// must admit two complete concurrent jobs without returning TEXT_PROCESSING_BUSY.
export const SUBTITLE_TOOL_MAX_ACTIVE_JOBS = 8;
// The previous six-requests-per-minute limit sized for one request per user action
// is the dominant bottleneck for a 615-caption project (31 batches). Sixty per
// minute is still ten times below the conservative 500/min process dispatch
// ceiling and the documented 600/min provider key quota, and it remains a real
// authenticated, per-IP abuse control rather than being removed.
export const SUBTITLE_TOOL_REQUESTS_PER_MINUTE = 60;

export function createSubtitleToolsRouter({ processSubtitles = createOllalinkTextTools(config.ollalink) } = {}) {
    const router = Router();
    let active = 0;
    router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
    router.use(requireAuth);
    router.use(createRateLimiter({ max: SUBTITLE_TOOL_REQUESTS_PER_MINUTE, message: "Too many subtitle requests. Please try later." }));
    router.post("/", (req, res, next) => {
        let trusted = !req.headers.origin;
        if (req.headers.origin) {
            try {
                const origin = new URL(req.headers.origin).origin;
                trusted = origin === `${req.protocol}://${req.get("host")}` || (config.server.corsOrigin !== "*" && origin === config.server.corsOrigin);
            } catch { trusted = false; }
        }
        if (!trusted || req.headers["x-subtitle-tools-request"] !== "1" || req.headers["sec-fetch-site"] === "cross-site") return res.status(403).json({ ok: false, code: "FORBIDDEN", message: "Same-origin subtitle request required." });
        if (!req.is("application/json") || Object.keys(req.query).length) return res.status(400).json({ ok: false, code: "INVALID_TEXT_REQUEST", message: "A JSON subtitle request is required." });
        if (active >= SUBTITLE_TOOL_MAX_ACTIVE_JOBS) return res.status(503).json({ ok: false, code: "TEXT_PROCESSING_BUSY", message: "Subtitle processing is busy. Try again later." });
        active += 1;
        let released = false;
        const release = () => { if (!released) { active -= 1; released = true; } };
        // Keep slot until actual provider work settles, even after disconnect.
        res.locals.releaseSubtitleSlot = release;
        req.setTimeout(30000, () => req.destroy());
        req.once("aborted", release);
        next();
    }, express.json({ limit: 100000, inflate: false, strict: true }), async (req, res) => {
        req.setTimeout(0);
        const controller = new AbortController();
        const cancel = () => { if (!res.writableEnded) controller.abort(); };
        res.once("close", cancel);
        if (req.aborted || res.destroyed) controller.abort();
        try {
            try { validateSubtitleTextRequest(req.body); }
            catch (error) { throw new SubtitleTextError(error.code, error.code === "TEXT_LIMIT_EXCEEDED" ? 413 : 400); }
            const result = await processSubtitles(req.body, { signal: controller.signal });
            controller.signal.throwIfAborted();
            if (!res.destroyed) res.json({ ok: true, ...result });
        } catch (error) {
            const safe = error instanceof SubtitleTextError ? error : new SubtitleTextError();
            if (!controller.signal.aborted && !res.destroyed) res.status(safe.status).json({ ok: false, code: safe.code, message: safe.message });
        } finally {
            res.removeListener("close", cancel);
            res.locals.releaseSubtitleSlot?.();
        }
    });
    router.use((error, req, res, _next) => {
        req.setTimeout(0);
        res.locals.releaseSubtitleSlot?.();
        const oversized = error.type === "entity.too.large";
        res.status(oversized ? 413 : 400).json({ ok: false, code: oversized ? "TEXT_LIMIT_EXCEEDED" : "INVALID_TEXT_REQUEST", message: "Invalid or oversized subtitle request." });
    });
    return router;
}

export default createSubtitleToolsRouter();
