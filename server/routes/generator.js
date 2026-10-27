import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { createRateLimiter } from "../middleware/rateLimiter.js";
import { ApiError, BadRequestError } from "../services/errors.js";
import { config } from "../config.js";
import {
  generateVideoSpecification,
} from "../services/ai/videoGeneratorService.js";
import { synthesizeSpeech } from "../services/ai/ttsService.js";
import {
  SUPPORTED_ASPECT_RATIOS,
  SUPPORTED_STYLES,
  SUPPORTED_TRANSITIONS,
  SUPPORTED_CAPTION_STYLES,
} from "../services/ai/videoPlanSchema.js";
import { SUPPORTED_OLLIMA_MODELS } from "../services/ai/ollimaService.js";

const router = Router();

// Rate limiter: 15 generation requests per minute
export const generatorLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 15,
  message: "Too many video generator requests. Please wait a moment before trying again.",
});

/**
 * GET /api/generator/config
 * Returns generator capabilities, provider statuses, and supported options.
 */
router.get("/config", requireAuth, (req, res) => {
  res.status(200).json({
    ok: true,
    capabilities: {
      ollimaAvailable: Boolean(config.ollima?.apiKey),
      ollimaModel: config.ollima?.model || "gemini-3-flash",
      supportedModels: SUPPORTED_OLLIMA_MODELS,
      aspectRatios: SUPPORTED_ASPECT_RATIOS,
      styles: SUPPORTED_STYLES,
      transitions: SUPPORTED_TRANSITIONS,
      captionStyles: SUPPORTED_CAPTION_STYLES,
      durations: [15, 30, 60, 90],
    },
  });
});

/**
 * POST /api/generator/spec
 * Generates a structured, validated video specification from user prompt.
 */
router.post("/spec", requireAuth, generatorLimiter, async (req, res, next) => {
  try {
    const {
      prompt,
      targetDuration = 30,
      aspectRatio = "16:9",
      style = "cinematic",
      voiceId = "af_heart",
      model,
      referenceAssets = [],
    } = req.body || {};

    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      throw new BadRequestError("Prompt is required and must be a non-empty string.", "INVALID_PROMPT");
    }

    if (prompt.trim().length > 5000) {
      throw new BadRequestError("Prompt must not exceed 5000 characters.", "PROMPT_TOO_LONG");
    }

    const spec = await generateVideoSpecification({
      prompt: prompt.trim(),
      targetDuration: Number(targetDuration) || 30,
      aspectRatio: String(aspectRatio || "16:9"),
      style: String(style || "cinematic"),
      voiceId: String(voiceId || "af_heart"),
      model: typeof model === "string" && model.trim() ? model.trim() : undefined,
      referenceAssets: Array.isArray(referenceAssets) ? referenceAssets : [],
    });

    return res.status(200).json({
      ok: true,
      spec,
    });
  } catch (err) {
    if (err instanceof ApiError) {
      return res.status(err.status).json({
        ok: false,
        code: err.code,
        message: err.message,
      });
    }
    next(err);
  }
});

router.post("/tts", requireAuth, generatorLimiter, async (req, res, next) => {
  try {
    const { text, scenes, voiceId = "af_heart", speed = 1 } = req.body || {};
    const hasScenes = Array.isArray(scenes) && scenes.some((s) => (typeof s === "string" ? s.trim() : (s?.narration || s?.text || "").trim()));
    const hasText = typeof text === "string" && text.trim().length > 0;

    if (!hasText && !hasScenes) {
      throw new BadRequestError("Narration text is required and must be a non-empty string.", "INVALID_TEXT");
    }

    const { buffer, duration, sampleRate, voiceId: usedVoice, sceneTimings } = await synthesizeSpeech({
      text: hasText ? text.trim() : "",
      scenes: hasScenes ? scenes : undefined,
      voiceId: String(voiceId || "af_heart"),
      speed: Number(speed) || 1,
    });

    const headers = {
      "Content-Type": "audio/wav",
      "Content-Length": buffer.length,
      "X-Audio-Duration": String(duration),
      "X-Audio-Sample-Rate": String(sampleRate),
      "X-Audio-Voice": usedVoice,
      "Access-Control-Expose-Headers": "Content-Type, Content-Length, X-Audio-Duration, X-Audio-Sample-Rate, X-Audio-Voice, X-Audio-Scene-Timings",
    };
    if (sceneTimings && Array.isArray(sceneTimings)) {
      headers["X-Audio-Scene-Timings"] = JSON.stringify(sceneTimings);
    }

    res.set(headers);
    return res.status(200).send(buffer);
  } catch (err) {
    if (err instanceof ApiError) {
      return res.status(err.status).json({
        ok: false,
        code: err.code,
        message: err.message,
      });
    }
    next(err);
  }
});

export default router;
