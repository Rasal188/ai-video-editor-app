import { Router } from "express";
import { config } from "../config.js";
import { requireAuth } from "../middleware/auth.js";
import { createRateLimiter } from "../middleware/rateLimiter.js";
import { ApiError, BadRequestError } from "../services/errors.js";
import { getProject } from "../services/projects/projectService.js";
import { generateEditingPlan, SUPPORTED_OLLIMA_MODELS } from "../services/ai/ollimaService.js";
import { classifyUserIntent } from "../../src/lib/intentClassifier.js";

const router = Router();

// Apply rate limiter: 20 plan generation requests per minute per IP
const assistantLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  message: "Too many AI assistant requests. Please wait a moment before trying again.",
});

/**
 * GET /api/assistant/models
 * Returns available Ollima models for client selector.
 */
router.get("/models", requireAuth, (req, res) => {
  res.status(200).json({
    ok: true,
    defaultModel: config.ollima?.model || "gemini-3-flash",
    models: SUPPORTED_OLLIMA_MODELS,
  });
});

/**
 * POST /api/assistant/plan
 * Generates a structured editing plan from natural language prompt and timeline summary.
 */
router.post("/plan", requireAuth, assistantLimiter, async (req, res, next) => {
  try {
    const { prompt, projectId, projectSummary, model, conversationContext } = req.body || {};

    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      throw new BadRequestError("Prompt is required and must be a non-empty string.", "INVALID_PROMPT");
    }

    if (prompt.trim().length > 5000) {
      throw new BadRequestError("Prompt must not exceed 5000 characters.", "PROMPT_TOO_LONG");
    }

    // If an existing project ID was provided, verify ownership to ensure IDOR security
    if (projectId) {
      await getProject({ projectId, userId: req.user.id });
    }

    const trimmedPrompt = prompt.trim();
    const intent = classifyUserIntent(trimmedPrompt, projectSummary, conversationContext);

    // If an explicit undo or redo history command reaches /api/assistant/plan,
    // do not query Ollima to generate editing operations. Direct to editor history.
    if (intent.type === "undo" || intent.type === "redo") {
      return res.status(200).json({
        ok: true,
        isHistoryCommand: true,
        historyAction: intent.type,
        message: intent.type === "undo" ? "Undoing the last edit." : "Redoing the last edit.",
      });
    }

    // If an explicit brand-new video creation request reaches /api/assistant/plan:
    // Text-to-video generation has been retired. Return an explanation of editing features.
    if (intent.type === "unsupported_creation") {
      return res.status(200).json({
        ok: true,
        isUnsupportedCreation: true,
        message: intent.message || "This AI Video Editor is designed for editing timeline media. Text-to-video generation has been retired.",
        plan: {
          schemaVersion: 1,
          explanation: "Creating brand-new videos from scratch is not supported. You can edit existing imported media on the timeline using trimming, splitting, speed, color grading, visual filters, captions, audio mixing, transitions, and export formatting.",
          actions: [],
          prerequisites: [],
          warnings: ["Text-to-video generation is retired. Use the timeline editor to edit imported media."],
          assumptions: [],
        },
      });
    }

    if (intent.type === "unsupported_selective_undo") {
      return res.status(200).json({
        ok: true,
        message: intent.message,
        plan: {
          schemaVersion: 1,
          explanation: intent.message,
          actions: [],
          prerequisites: [],
          warnings: [intent.message],
          assumptions: [],
        },
      });
    }

    // Direct active-word color intent mapping to caption.set_style with activeWordColor (preserves karaoke state)
    if (intent.isActiveWordColor) {
      return res.status(200).json({
        ok: true,
        plan: {
          schemaVersion: 1,
          explanation: `Change active word highlight color to ${intent.color}.`,
          actions: [{
            id: "act-1",
            type: "caption.set_style",
            description: `Change active word highlight color to ${intent.color}`,
            params: { scope: "default", style: { activeWordColor: intent.color } },
          }],
          prerequisites: [],
          warnings: [],
          assumptions: [],
        },
      });
    }

    // Direct explicit caption effect intent mapping
    if (intent.isEffect) {
      return res.status(200).json({
        ok: true,
        plan: {
          schemaVersion: 1,
          explanation: `Apply ${intent.effect === "neon" ? "Neon" : "Normal"} caption effect.`,
          actions: [{
            id: "act-1",
            type: "caption.set_style",
            description: `Apply ${intent.effect === "neon" ? "Neon" : "Normal"} caption effect`,
            params: { scope: "default", style: { effect: intent.effect } },
          }],
          prerequisites: [],
          warnings: [],
          assumptions: [],
        },
      });
    }

    // Direct karaoke intent mapping to caption.set_style with karaoke: true/false (never neon!)
    if (intent.isKaraoke) {
      return res.status(200).json({
        ok: true,
        plan: {
          schemaVersion: 1,
          explanation: intent.enable ? "Enable karaoke highlighting." : "Disable karaoke highlighting.",
          actions: [{
            id: "act-1",
            type: "caption.set_style",
            description: intent.enable ? "Enable karaoke highlighting" : "Disable karaoke highlighting",
            params: { scope: "default", style: { karaoke: intent.enable } },
          }],
          prerequisites: [],
          warnings: [],
          assumptions: [],
        },
      });
    }

    // Clarification, exploration, more options, or unsupported style/font/effect
    if (["ambiguous", "exploration", "more_options", "unsupported_style", "unsupported_font", "unsupported_effect"].includes(intent.type)) {
      return res.status(200).json({
        ok: true,
        isClarification: true,
        clarificationType: intent.type,
        ambiguityType: intent.ambiguityType || intent.category,
        category: intent.category,
        message: intent.clarification?.message || intent.message,
        options: intent.clarification?.options || intent.options || [],
        hasMore: intent.clarification?.hasMore ?? intent.hasMore,
        offset: intent.offset ?? 0,
      });
    }

    // Option selected via conversation context (e.g. "the third one")
    if (intent.type === "option_selected") {
      const selected = intent.selectedOption;
      if (intent.category === "style" && selected?.style) {
        return res.status(200).json({
          ok: true,
          plan: {
            schemaVersion: 1,
            explanation: `Apply ${selected.name || selected.id} caption style.`,
            actions: [{
              id: "act-1",
              type: "caption.set_style",
              description: `Apply ${selected.name || selected.id} caption style`,
              params: { scope: "default", style: { ...selected.style } },
            }],
            prerequisites: [],
            warnings: [],
            assumptions: [],
          },
        });
      }
      if (intent.category === "font" && selected?.id) {
        return res.status(200).json({
          ok: true,
          plan: {
            schemaVersion: 1,
            explanation: `Change caption font to ${selected.name || selected.id}.`,
            actions: [{
              id: "act-1",
              type: "caption.set_style",
              description: `Change caption font to ${selected.name || selected.id}`,
              params: { scope: "default", style: { fontId: selected.id } },
            }],
            prerequisites: [],
            warnings: [],
            assumptions: [],
          },
        });
      }
      if (intent.category === "effect" && (selected?.effect || selected?.id)) {
        const effectVal = selected.effect || selected.id;
        return res.status(200).json({
          ok: true,
          plan: {
            schemaVersion: 1,
            explanation: `Apply ${selected.name || effectVal} caption effect.`,
            actions: [{
              id: "act-1",
              type: "caption.set_style",
              description: `Apply ${selected.name || effectVal} caption effect`,
              params: { scope: "default", style: { effect: effectVal } },
            }],
            prerequisites: [],
            warnings: [],
            assumptions: [],
          },
        });
      }
      if (intent.category === "color" && (selected?.color || selected?.id)) {
        const colorVal = selected.color || selected.id;
        return res.status(200).json({
          ok: true,
          plan: {
            schemaVersion: 1,
            explanation: `Change active word highlight color to ${colorVal}.`,
            actions: [{
              id: "act-1",
              type: "caption.set_style",
              description: `Change active word highlight color to ${colorVal}`,
              params: { scope: "default", style: { activeWordColor: colorVal } },
            }],
            prerequisites: [],
            warnings: [],
            assumptions: [],
          },
        });
      }
    }

    const plan = await generateEditingPlan({
      prompt: trimmedPrompt,
      projectSummary: projectSummary || {},
      model: typeof model === "string" && model.trim() ? model.trim() : undefined,
    });

    // If the editing plan returned 0 actions and indicates new video creation or generation, return unsupported creation
    if (
      plan &&
      Array.isArray(plan.actions) &&
      plan.actions.length === 0 &&
      (
        /new video/i.test(plan.explanation || "") ||
        /video generator/i.test(plan.explanation || "") ||
        (Array.isArray(plan.warnings) && plan.warnings.some((w) => /video generator/i.test(w) || /new video/i.test(w)))
      )
    ) {
      return res.status(200).json({
        ok: true,
        isUnsupportedCreation: true,
        message: "This AI Video Editor is designed for editing timeline media. Text-to-video generation has been retired. You can edit imported media on your timeline.",
        plan: {
          schemaVersion: 1,
          explanation: "Creating brand-new videos from scratch is not supported. You can edit existing imported media on the timeline using trimming, splitting, speed, color grading, visual filters, captions, audio ducking, transitions, and export formatting.",
          actions: [],
          prerequisites: [],
          warnings: ["Text-to-video generation is retired. Use the timeline editor to edit imported media."],
          assumptions: [],
        },
      });
    }

    return res.status(200).json({
      ok: true,
      plan,
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

export default router;
