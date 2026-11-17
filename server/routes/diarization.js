import express, { Router } from "express";
import { config } from "../config.js";
import { requireAuth } from "../middleware/auth.js";
import { createRateLimiter } from "../middleware/rateLimiter.js";
import { createOllalinkDiarizer } from "../services/transcription/ollalinkDiarization.js";
import { DiarizationError, DIARIZATION_MAX_WAV_BYTES, validateDiarizationWav, validateDiarizationResult } from "../../src/lib/ollalinkDiarization.js";

const sendError = (res, error) => {
    const safe = new DiarizationError(error instanceof DiarizationError ? error.code : "FAILED");
    if (!res.destroyed && !res.writableEnded) res.status(safe.status).json({ ok: false, code: safe.code, message: safe.message });
};
export function createDiarizationRouter({ diarize = createOllalinkDiarizer(config.ollalink) } = {}) {
    const router = Router();
    let active = 0;
    router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
    router.use(requireAuth);
    router.use(createRateLimiter({ max: 4, message: "Too many speaker detection requests. Try later." }));
    router.post("/", (req, res, next) => {
        let trusted = !req.headers.origin;
        if (req.headers.origin) {
            try {
                const origin = new URL(req.headers.origin).origin;
                trusted = origin === req.headers.origin && (origin === `${req.protocol}://${req.get("host")}` ||
                    (config.server.corsOrigin !== "*" && origin === config.server.corsOrigin));
            } catch { trusted = false; }
        }
        if (!trusted || req.headers["x-diarization-request"] !== "1" || req.headers["sec-fetch-site"] === "cross-site") return sendError(res, new DiarizationError("FORBIDDEN"));
        if (!req.is("audio/wav") || Object.keys(req.query).length || req.headers["content-encoding"]) return sendError(res, new DiarizationError("INVALID_AUDIO"));
        if (active >= 1) return sendError(res, new DiarizationError("BUSY"));
        active++;
        const state = { controller: new AbortController(), started: false, released: false };
        const cancel = () => {
            if (!res.writableEnded) state.controller.abort();
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
        res.locals.diarizationState = state;
        req.once("aborted", cancel);
        res.once("close", cancel);
        req.setTimeout(30000, () => req.destroy());
        next();
    }, express.raw({ type: "audio/wav", limit: DIARIZATION_MAX_WAV_BYTES, inflate: false }), async (req, res) => {
        const state = res.locals.diarizationState;
        state.started = true;
        req.setTimeout(0);
        if (req.aborted || res.destroyed) state.controller.abort();
        try {
            state.controller.signal.throwIfAborted();
            const duration = validateDiarizationWav(req.body);
            const result = await diarize(req.body, { signal: state.controller.signal });
            state.controller.signal.throwIfAborted();
            const validated = validateDiarizationResult(result, duration);
            if (!res.destroyed) res.json(validated);
        } catch (error) {
            if (!state.controller.signal.aborted) sendError(res, error);
        } finally { state.release(); }
    });
    router.use((error, req, res, _next) => {
        res.locals.diarizationState?.release();
        req.setTimeout(0);
        if (error.type === "entity.too.large") {
            if (!res.destroyed) res.status(413).json({ ok: false, code: "INVALID_AUDIO", message: "Audio exceeds the 120-second canonical WAV limit." });
        } else sendError(res, new DiarizationError(error.type ? "INVALID_AUDIO" : "FAILED"));
    });
    return router;
}
export default createDiarizationRouter();
