import express, { Router } from "express";
import { config } from "../config.js";
import { requireAuth } from "../middleware/auth.js";
import { createRateLimiter } from "../middleware/rateLimiter.js";
import { createOllalinkTts } from "../services/ai/ollalinkTts.js";
import { OllalinkTtsError, validateOllalinkTtsRequest, validateOllalinkTtsWav } from "../../src/lib/ollalinkTts.js";
import { sanitizeOllalinkTtsCatalog } from "../../src/lib/ollalinkTtsCatalog.js";

function sendError(res, error) {
    // Reconstruct from the closed code catalog; never trust mutable message/status.
    const safe = new OllalinkTtsError(error instanceof OllalinkTtsError ? error.code : "TTS_FAILED");
    if (!res.destroyed && !res.writableEnded) res.status(safe.status).json({ ok: false, code: safe.code, message: safe.message });
}

export function createTtsRouter({ synthesize = createOllalinkTts(config.ollalink), getCatalog = synthesize.getCatalog } = {}) {
    const router = Router();
    let active = 0;
    router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); next(); });
    router.use(requireAuth);
    const paidLimiter = createRateLimiter({ max: 6, message: "Too many speech requests. Please try later." });
    const catalogLimiter = createRateLimiter({ max: 30, message: "Too many catalog requests. Please try later." });
    router.use((req, res, next) => (req.method === "GET" ? catalogLimiter : paidLimiter)(req, res, next));
    router.use((req, res, next) => {
        let trusted = !req.headers.origin;
        if (req.headers.origin) {
            try {
                const url = new URL(req.headers.origin);
                const origin = url.origin;
                trusted = req.headers.origin === origin && (origin === `${req.protocol}://${req.get("host")}` ||
                    (config.server.corsOrigin !== "*" && origin === config.server.corsOrigin));
            } catch { trusted = false; }
        }
        if (!trusted || req.headers["x-tts-request"] !== "1" || req.headers["sec-fetch-site"] === "cross-site") return sendError(res, new OllalinkTtsError("TTS_FORBIDDEN"));
        if (Object.keys(req.query).length) return sendError(res, new OllalinkTtsError("INVALID_TTS_REQUEST"));
        next();
    });
    router.get("/voices", async (req, res) => {
        const controller = new AbortController();
        const cancel = () => { if (!res.writableEnded) controller.abort(); };
        res.once("close", cancel);
        try {
            if (!getCatalog) throw new OllalinkTtsError("TTS_CATALOG_UNAVAILABLE");
            const catalog = await getCatalog({ signal: controller.signal });
            if (!controller.signal.aborted && !res.destroyed) res.json(sanitizeOllalinkTtsCatalog(catalog));
        } catch (error) { if (!controller.signal.aborted) sendError(res, error); }
        finally { res.removeListener("close", cancel); }
    });
    router.post("/", (req, res, next) => {
        if (!req.is("application/json")) return sendError(res, new OllalinkTtsError("INVALID_TTS_REQUEST"));
        if (active >= 2) return sendError(res, new OllalinkTtsError("TTS_BUSY"));
        active++;
        const state = { controller: new AbortController(), started: false, released: false };
        const cancel = () => {
            if (!res.writableEnded) state.controller.abort();
            // Parsing has no provider work. Once started, only finally releases.
            if (!state.started) state.release();
        };
        state.release = () => {
            if (state.released) return;
            state.released = true;
            active--;
            req.setTimeout(0);
            req.removeListener("aborted", cancel);
            res.removeListener("close", cancel);
        };
        res.locals.ttsState = state;
        req.once("aborted", cancel);
        res.once("close", cancel);
        req.setTimeout(30000, () => req.destroy());
        next();
    }, express.json({ limit: 32 * 1024, inflate: false, strict: true }), async (req, res) => {
        const state = res.locals.ttsState;
        state.started = true;
        req.setTimeout(0);
        if (req.aborted || res.destroyed) state.controller.abort();
        try {
            state.controller.signal.throwIfAborted();
            const request = validateOllalinkTtsRequest(req.body);
            const result = await synthesize(request, { signal: state.controller.signal });
            state.controller.signal.throwIfAborted();
            // Apply the same policy to injected providers, not just the default.
            if (!result || result.voice !== request.voice) throw new OllalinkTtsError("TTS_VOICE_MISMATCH");
            if (result.language !== request.language || result.mimeType !== "audio/wav") throw new OllalinkTtsError("TTS_INVALID_AUDIO");
            validateOllalinkTtsWav(result.buffer);
            const bytes = Buffer.from(result.buffer);
            if (!res.destroyed) {
                res.setHeader("Content-Type", "audio/wav");
                res.setHeader("X-TTS-Voice", request.voice);
                res.setHeader("X-Audio-Sample-Rate", "24000");
                res.setHeader("X-Content-Type-Options", "nosniff");
                res.send(bytes);
            }
        } catch (error) {
            if (!state.controller.signal.aborted) sendError(res, error);
        } finally { state.release(); }
    });
    router.use((error, req, res, _next) => {
        res.locals.ttsState?.release();
        req.setTimeout(0);
        // Parser/auth failures must never leak submitted text, cookies, or internals.
        if (error.type === "entity.too.large") {
            if (!res.destroyed) res.status(413).json({ ok: false, code: "INVALID_TTS_REQUEST", message: "Speech request exceeds the 32 KiB JSON limit." });
        } else sendError(res, new OllalinkTtsError(error.type || error instanceof SyntaxError ? "INVALID_TTS_REQUEST" : "TTS_FAILED"));
    });
    return router;
}

export default createTtsRouter();
