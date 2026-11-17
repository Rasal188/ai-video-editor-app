import express, { Router } from "express";
import { config } from "../config.js";
import { requireAuth } from "../middleware/auth.js";
import { createRateLimiter } from "../middleware/rateLimiter.js";
import { createOllalinkTranscriber, TranscriptionError } from "../services/transcription/ollalinkTranscription.js";
import { CLOUD_FAST_MAX_BYTES, CLOUD_HQ_MAX_BYTES, cloudTranscriptionLane } from "../../src/lib/cloudTranscriptionAudio.js";

export function createTranscriptionRouter({ transcribe = createOllalinkTranscriber(config.ollalink) } = {}) {
    const router = Router();
    let active = 0;
    router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
    router.use(requireAuth);
    router.use(createRateLimiter({ max: 6, message: "Too many transcription requests. Please try later." }));
    router.post("/", (req, res, next) => {
        // A custom same-origin header prevents cross-origin simple-request CSRF.
        let trustedOrigin = !req.headers.origin;
        if (req.headers.origin) {
            try {
                const origin = new URL(req.headers.origin);
                trustedOrigin = origin.origin === `${req.protocol}://${req.get("host")}`
                    || (config.server.corsOrigin !== "*" && origin.origin === config.server.corsOrigin);
            } catch { trustedOrigin = false; }
        }
        if (!trustedOrigin || req.headers["x-transcription-request"] !== "1" || req.headers["sec-fetch-site"] === "cross-site") {
            return res.status(403).json({ ok: false, code: "FORBIDDEN", message: "Same-origin transcription request required." });
        }
        if (!req.is("audio/wav") || typeof req.query.language !== "string" || Object.keys(req.query).some((key) => key !== "language")) {
            return res.status(400).json({ ok: false, code: "INVALID_TRANSCRIPTION_REQUEST", message: "A WAV upload and explicit supported language are required." });
        }
        try { cloudTranscriptionLane(req.query.language); }
        catch { return res.status(400).json({ ok: false, code: "UNSUPPORTED_LANGUAGE", message: "Unsupported cloud transcription language." }); }
        if (active >= 2) return res.status(503).json({ ok: false, code: "TRANSCRIPTION_BUSY", message: "Transcription is busy. Try again later." });
        active += 1;
        let released = false;
        const release = () => { if (!released) { active -= 1; released = true; } };
        res.once("finish", release);
        res.once("close", release);
        next();
    }, (req, res, next) => {
        const limit = cloudTranscriptionLane(req.query.language) === "fast" ? CLOUD_FAST_MAX_BYTES : CLOUD_HQ_MAX_BYTES;
        if (Number(req.headers["content-length"]) > limit) {
            res.setHeader("Connection", "close");
            return res.status(413).json({ ok: false, code: "AUDIO_TOO_LARGE", message: "Audio upload exceeds the cloud limit." });
        }
        req.setTimeout(30000, () => req.destroy());
        express.raw({ type: "audio/wav", limit, inflate: false })(req, res, (error) => {
            req.setTimeout(0);
            next(error);
        });
    }, async (req, res) => {
        const controller = new AbortController();
        const cancel = () => { if (!res.writableEnded) controller.abort(); };
        res.once("close", cancel);
        try {
            const result = await transcribe(req.body, { language: req.query.language, signal: controller.signal });
            if (!controller.signal.aborted && !res.destroyed) return res.json({ ok: true, ...result });
        } catch (error) {
            const safe = error instanceof TranscriptionError ? error : new TranscriptionError("TRANSCRIPTION_FAILED");
            if (!res.destroyed) return res.status(safe.status).json({ ok: false, code: safe.code, message: safe.message });
        } finally {
            res.removeListener("close", cancel);
        }
    });
    router.use((err, _req, res, _next) => {
        // Never send parser exception text, which can include uploaded content.
        const oversized = err.type === "entity.too.large";
        res.status(oversized ? 413 : 400).json({ ok: false, code: oversized ? "AUDIO_TOO_LARGE" : "INVALID_AUDIO", message: "Invalid or oversized audio upload." });
    });
    return router;
}

export default createTranscriptionRouter();
