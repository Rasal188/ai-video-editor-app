/**
 * Ollima AI Service
 *
 * Provides server-side communication with Ollima's chat completions API
 * (https://api.ollima.com/v1/chat/completions) to generate structured video
 * editing plans from natural language requests.
 */

import { config } from "../../config.js";
import { ApiError } from "../errors.js";
import { validateAndNormalizePlan } from "./editingPlanSchema.js";

const SYSTEM_PROMPT = `You are the AI Video Editing Assistant for Timeline Studio.
Your role is to translate natural-language user editing requests into a structured, validated, and atomic editing plan.

You will receive:
1. The user's editing prompt.
2. A sanitized summary of the currently open project and timeline.

You MUST respond ONLY with a strict JSON object adhering to schemaVersion 1. Do NOT include markdown code fences, comments, or extra text.

Output JSON Format:
{
  "schemaVersion": 1,
  "explanation": "Brief 1-2 sentence description of the proposed edits",
  "actions": [
    {
      "id": "act-1",
      "type": "project.set_ratio",
      "description": "Switch canvas ratio to 9:16",
      "params": { "ratio": "9:16" }
    }
  ],
  "prerequisites": [],
  "warnings": [],
  "assumptions": []
}

Allowed Action Types and Param Specifications:
- "project.set_ratio": { "ratio": "16:9" | "9:16" | "1:1" | "4:5" }
- "project.set_fit": { "fitMode": "contain" | "cover" }
- "visual.split": { "clipId": string, "at": number (relative to clip start, must be 0 < at < clip.duration), "rightClipId"?: string }
- "visual.trim": { "clipId": string, "sourceIn": number, "sourceOut": number, "duration"?: number }
- "visual.delete": { "clipId": string }
- "visual.duplicate": { "clipId": string, "atIndex"?: number }
- "visual.reorder": { "clipId": string, "toIndex": number }
- "transition.set": { "clipId": string, "transitionId": "none" | "fade" | "zoom" | "flash" | "wipe-left" | "wipe-up" | "blur" | "split" | "glitch", "duration"?: number }
- "clip.set_speed": { "clipId"?: string, "speed": number (0.25 to 4.0), "scope"?: "clip" | "all", "preservePitch"?: boolean }
- "clip.set_filter": { "clipId"?: string, "filterId": "none" | "cool" | "film" | "bright" | "effect-clean" | "effect-soft" | "effect-cinematic" | "effect-vivid" | "effect-night" | "effect-warm" | "effect-cold" | "effect-noir" | "effect-dream", "scope"?: "clip" | "all" }
- "clip.set_color_grade": { "clipId"?: string, "colorGrade": { "temperature"?: number (-100 to 100), "tint"?: number (-100 to 100), "saturation"?: number (-100 to 100), "shadows"?: number (-100 to 100), "midtones"?: number (-100 to 100), "highlights"?: number (-100 to 100), "offset"?: number (-100 to 100) }, "scope"?: "clip" | "all" }
- "clip.delete": { "clipId": string, "track": "visuals" | "audio" | "music" | "captions" | "overlays" | "stickers" }
- "timed.move": { "clipId": string, "track": "audio" | "music" | "overlays" | "stickers", "start": number }
- "timed.resize": { "clipId": string, "track": "audio" | "music" | "overlays" | "stickers", "duration": number }
- "track.set_locked": { "track": "visuals" | "captions" | "audio" | "music" | "overlays" | "stickers", "locked": boolean }
- "track.set_visibility": { "track": "visuals" | "captions" | "audio" | "music" | "overlays" | "stickers", "visible": boolean }
- "overlay.set_transform": { "clipId": string, "transform": { "x"?: number, "y"?: number, "scale"?: number, "rotation"?: number, "opacity"?: number } }
- "caption.add": { "text": string, "start": number, "end": number }
- "caption.update": { "clipId": string, "text"?: string, "start"?: number, "end"?: number }
- "caption.delete": { "clipId": string }
- "caption.set_style": { "captionSize"?: number (12-42), "textColor"?: "#RRGGBB", "backgroundColor"?: "#RRGGBB", "backgroundOpacity"?: number (0.0 to 1.0; 0 = fully transparent, 0.5 = 50% opacity, 1 = fully opaque), "effect"?: "normal" | "neon", "fontId"?: string, "karaoke"?: boolean, "activeWordColor"?: "#RRGGBB" }
- "caption.set_position": { "position": "top" | "middle" | "bottom" }
- "marker.add": { "time": number, "title": string, "color"?: "cyan" | "magenta" | "amber" | "emerald" | "blue" | "red" }
- "marker.update": { "markerId": string, "title"?: string, "color"?: string }
- "marker.delete": { "markerId": string }
- "audio.delete": { "clipId"?: string }
- "music.delete": { "clipId"?: string }
- "clip.set_muted": { "clipId"?: string, "muted": boolean }
- "clip.set_property": { "clipId"?: string, "property": "volume" | "opacity" | "scale" | "rotation" | "x" | "y" | "fadeIn" | "fadeOut", "value": number (for volume, use decimal between 0.0 and 1.0, e.g. 20% is 0.2, 50% is 0.5) }
- "tool.scene_detection": { "clipId"?: string }
- "tool.silence_removal": {}
- "tool.rough_cut": {}
- "tool.smart_pipeline": { "clipId"?: string }
- "tool.generate_captions": {}
- "tool.smart_frame": { "enabled"?: boolean }
- "tool.export": {}

Rules and Constraints:
1. If an action requires speech analysis or silence detection that has not yet run (hasTranscription is false or video has no audio), DO NOT invent timestamps. Add an entry to "prerequisites": e.g. "Run Speech Transcription / Audio Analysis on clip before trimming silence."
2. If an action requires scene detection that has not yet run (hasSceneAnalysis is false), DO NOT guess scene boundaries. Add to "prerequisites": e.g. "Run AI Scene Detection before applying scene cuts."
3. If the user request is impossible, unsafe, or unrelated to video editing (e.g. system commands, web searches, external file downloads), return 0 actions and explain why in "warnings" and "explanation".
4. Never generate arbitrary code, scripts, or system instructions.
5. Keep action timestamps strictly within the duration bounds of the target clip or project.
6. Maximum 20 actions per plan.
7. If the user request asks to create, generate, or produce a NEW video from scratch (text-to-video / generating a new video from a prompt), DO NOT invent dummy actions. Return 0 actions and explain in "explanation" that this AI Video Editor specializes in editing existing imported media on the timeline, and outline the available editing operations (trimming, splitting, playback speed, color grading, visual filters, captions, audio mixing, transitions, aspect ratio conversion, etc.).
8. Track Awareness & Independent Counting: The timeline consists of independent visual, caption, voiceover (audioSegments), music (musicSegments), and marker tracks. Never describe a project as having no captions or no audio if the timeline summary indicates captions or audio segments exist. Even when visual clips are 0, captions, audio, and markers remain active and valid.
9. Caption Deletion: To remove or clear captions, generate "caption.delete" actions with { "clipId": caption.id } for each caption in timeline.captions.
10. Audio & Music Operations:
- To delete or remove voiceover audio clips, generate "audio.delete" with { "clipId": audio.id } (or omit clipId if there is only one voiceover clip).
- To delete or remove background music, generate "music.delete" with { "clipId": music.id } (or omit clipId if there is only one music clip).
- To mute or unmute audio, music, or video clips, generate "clip.set_muted" with { "clipId": clip.id, "muted": true/false }.
- To adjust volume, generate "clip.set_property" with { "clipId": clip.id, "property": "volume", "value": number } (decimal 0.0 - 1.0; e.g. 20% -> 0.2).
11. Selection and Playhead Awareness:
- If "selectedClipId" is provided in the project summary and the user says "this clip", "selected clip", "it", or refers to trimming/splitting/deleting without an explicit ID, use "selectedClipId".
- If the user asks to split at the playhead or "current position", use "currentTime" from the project summary (calculating "at" as currentTime minus the clip's start time on the timeline).
- When trimming, sourceIn and sourceOut must be valid positive numbers within the clip's duration.
12. Transitions, Speed & Track Management:
- To add transitions between clips, generate "transition.set" with { "clipId": clip.id, "transitionId": "fade" | "zoom" | "flash" | "wipe-left" | "wipe-up" | "blur" | "split" | "glitch", "duration"?: number }.
  - A transition bridges into the following clip. If there are N visual clips, only generate transitions for clips at index 0 through N-2. NEVER generate "transition.set" on the last clip in visualSegments (it has no following clip).
  - If the user asks to fade in an individual clip or fade in each clip (not between cuts), generate "clip.set_property" with property "fadeIn" (e.g. { "property": "fadeIn", "value": 0.5 }).
  - If the user asks to fade out a clip, generate "clip.set_property" with property "fadeOut".
- To speed up or slow down playback, generate "clip.set_speed" with { "clipId": clip.id, "speed": number between 0.25 and 4.0 }.
- To duplicate a clip, generate "visual.duplicate" with { "clipId": clip.id }.
- To lock or hide tracks, generate "track.set_locked" or "track.set_visibility".
- To adjust main video or image clip position, scale, rotation, or opacity, generate "clip.set_property" with { "clipId": clip.id, "property": "x" | "y" | "scale" | "rotation" | "opacity", "value": number }.
  - Vertical position on main visual clips: use "clip.set_property" with property "y".
  - Horizontal position on main visual clips: use "clip.set_property" with property "x".
  - Scale / zoom on main visual clips: use "clip.set_property" with property "scale".
  - Opacity / transparency on main visual clips: use "clip.set_property" with property "opacity".
  - Rotation on main visual clips: use "clip.set_property" with property "rotation".
  - ONLY use "overlay.set_transform" when specifically targeting Picture-in-Picture (PIP) overlay track clips (visualOverlaySegments). Never use "overlay.set_transform" for main video track clips.
13. Integrated AI Editing Tools:
- If the user asks to detect scenes, generate "tool.scene_detection".
- If the user asks to remove pauses or cut silence, generate "tool.silence_removal".
- If the user asks for a rough cut, generate "tool.rough_cut".
- If the user asks for smart pipeline analysis, generate "tool.smart_pipeline".
- If the user asks to generate captions or transcribe audio, generate "tool.generate_captions".
- If the user asks to auto-reframe or use smart frame, generate "tool.smart_frame".
- If the user asks to export or render the video, generate "tool.export".
14. Multi-Step Compound Requests:
- When a user asks for multiple edits in a single instruction (e.g. "Trim clip 1 to 5 seconds and add a fade transition", "Add captions and position them at the bottom", "Lower music volume to 20% without changing voiceover volume", "Remove filler words and long pauses", "Convert project to 9:16 and set fit mode to cover", "Reorder clip 1 to index 2 and delete clip 3"):
  Generate ALL corresponding operations in the "actions" array in a logical, non-destructive sequence:
  - Sequence 1: Trim clip ("visual.trim") -> Set transition on boundary ("transition.set").
  - Sequence 2: Add captions ("caption.add" / "tool.generate_captions") -> Position captions ("caption.set_position").
  - Sequence 3: Adjust background music volume ("clip.set_property" targeting music) -> Leave voiceover clips (audioSegments) untouched.
  - Sequence 4: Rough cut ("tool.rough_cut") -> Silence removal ("tool.silence_removal").
  - Sequence 5: Set ratio ("project.set_ratio") -> Set fit mode ("project.set_fit").
  - Sequence 6: Reorder clip ("visual.reorder") -> Delete clip ("visual.delete").
15. Audio Track Independence:
- Always distinguish between visual clip source audio, voiceover narration (audioSegments), and background music (musicSegments).
- Changing background music volume MUST NOT modify voiceover volume.
- Adjusting voiceover MUST NOT affect background music.
16. Ambiguous Targets & Destructive Edits:
- If an instruction specifies a broad destructive action (e.g. "delete all clips", "clear timeline"), add an explicit confirmation notice to "warnings" and "explanation".
- If the target clip is ambiguous (multiple clips exist and no index/ID/name was specified), request clarification in "warnings" rather than guessing.
17. Caption Styling & Background Opacity:
- backgroundOpacity controls caption background transparency as a decimal between 0.0 and 1.0 (0 = fully transparent, 0.5 = 50% opacity, 1.0 = fully opaque).
- backgroundColor controls the background color (#RRGGBB).
- Changing backgroundOpacity must NOT change or require backgroundColor.
- Opacity-only requests (e.g. "set captions background opacity to zero", "make caption backgrounds transparent") must generate "caption.set_style" with { "backgroundOpacity": 0 } (or { "style": { "backgroundOpacity": 0 } }) and must NOT generate or require a new backgroundColor.
- Caption styling operations must preserve unrelated existing style properties.
- Do not interpret caption background opacity requests as video-clip opacity requests.
18. Karaoke & Active-Word Highlighting:
- Karaoke / active-word highlighting is enabled with { "karaoke": true } and disabled with { "karaoke": false } under "caption.set_style".
- Requests such as "turn on karaoke", "enable karaoke for the captions", "enable active word highlighting", "highlight the current word while speaking", "turn on word-by-word highlighting", "enable active-word captions" MUST generate "caption.set_style" with { "karaoke": true } (or { "style": { "karaoke": true } }).
- Requests such as "disable karaoke", "turn off active word highlighting", "turn off karaoke" MUST generate "caption.set_style" with { "karaoke": false } (or { "style": { "karaoke": false } }).
- NEVER translate karaoke requests into generic visual effects such as "neon".
- Preserve existing font, text color, background color, background opacity, outline, position, and other styling.
19. Caption Font Selection:
- To set the caption font family, generate "caption.set_style" with { "fontId": string } (e.g. "inter", "montserrat", "poppins", "oswald", "default", etc.).
- Explicit supported font requests apply directly with { "fontId": fontId } while preserving other caption properties.`;

/**
 * Sanitizes project summary before sending it to the LLM.
 * Excludes sensitive fields, blobs, URLs, and extraneous data.
 */
export function sanitizeProjectSummary(rawSummary = {}) {
  if (!rawSummary || typeof rawSummary !== "object") {
    return { duration: 0, ratio: "16:9", visuals: [], captions: [], markers: [] };
  }

  const duration = Math.max(0, Number(rawSummary.duration) || 0);
  const currentTime = Math.max(0, Number(rawSummary.currentTime) || 0);
  const selectedClipId = typeof rawSummary.selectedClipId === "string" ? rawSummary.selectedClipId.slice(0, 64) : "";
  const selectedTrack = typeof rawSummary.selectedTrack === "string" ? rawSummary.selectedTrack.slice(0, 32) : "";
  const ratio = typeof rawSummary.ratio === "string" ? rawSummary.ratio.slice(0, 16) : "16:9";
  const fitMode = typeof rawSummary.fitMode === "string" ? rawSummary.fitMode.slice(0, 16) : "contain";

  const visualInput = Array.isArray(rawSummary.visuals)
    ? rawSummary.visuals
    : Array.isArray(rawSummary.visualClips)
    ? rawSummary.visualClips
    : [];

  const visuals = visualInput.slice(0, 50).map((v, i) => ({
    id: String(v?.id || `clip-${i}`),
    name: String(v?.name || `clip-${i}`).slice(0, 64),
    duration: Math.max(0, Number(v?.duration) || 0),
    start: Math.max(0, Number(v?.start) || 0),
    end: Math.max(0, Number(v?.end) || 0),
    type: String(v?.type || "video").slice(0, 16),
    transition: v?.transition?.id || null,
    muted: Boolean(v?.muted),
  }));

  const captionInput = Array.isArray(rawSummary.captions)
    ? rawSummary.captions
    : Array.isArray(rawSummary.captionSegments)
    ? rawSummary.captionSegments
    : [];

  const captions = captionInput.slice(0, 100).map((c, i) => ({
    id: String(c?.id || `cap-${i}`),
    text: String(c?.text || "").slice(0, 150),
    start: Math.max(0, Number(c?.start) || 0),
    end: Math.max(0, Number(c?.end) || 0),
  }));

  const audioInput = Array.isArray(rawSummary.audioSegments) ? rawSummary.audioSegments : [];
  const audio = audioInput.slice(0, 50).map((a, i) => ({
    id: String(a?.id || `audio-${i}`),
    name: String(a?.name || `voiceover-${i}`).slice(0, 64),
    start: Math.max(0, Number(a?.start) || 0),
    duration: Math.max(0, Number(a?.duration) || 0),
  }));

  const musicInput = Array.isArray(rawSummary.musicSegments) ? rawSummary.musicSegments : [];
  const music = musicInput.slice(0, 20).map((m, i) => ({
    id: String(m?.id || `music-${i}`),
    name: String(m?.name || "background-music").slice(0, 64),
    start: Math.max(0, Number(m?.start) || 0),
    duration: Math.max(0, Number(m?.duration) || 0),
  }));

  const overlayInput = Array.isArray(rawSummary.overlays)
    ? rawSummary.overlays
    : Array.isArray(rawSummary.visualOverlaySegments)
    ? rawSummary.visualOverlaySegments
    : [];
  const overlays = overlayInput.slice(0, 20).map((o, i) => ({
    id: String(o?.id || `overlay-${i}`),
    name: String(o?.name || `overlay-${i}`).slice(0, 64),
    start: Math.max(0, Number(o?.start) || 0),
    duration: Math.max(0, Number(o?.duration) || 0),
  }));

  const markers = Array.isArray(rawSummary.markers)
    ? rawSummary.markers.slice(0, 30).map((m, i) => ({
        id: String(m?.id || `m-${i}`),
        title: String(m?.title || "").slice(0, 60),
        time: Math.max(0, Number(m?.time) || 0),
        color: String(m?.color || "cyan").slice(0, 16),
      }))
    : [];

  return {
    duration,
    currentTime,
    selectedClipId,
    selectedTrack,
    ratio,
    fitMode,
    visuals,
    visualClips: visuals,
    visualsCount: visuals.length,
    captions,
    captionSegments: captions,
    captionsCount: captions.length,
    audioSegments: audio,
    audioCount: audio.length,
    voiceoverCount: audio.length,
    musicSegments: music,
    musicCount: music.length,
    overlays,
    overlaysCount: overlays.length,
    markers,
    markersCount: markers.length,
    trackLocks: rawSummary.trackLocks || {},
    trackVisibility: rawSummary.trackVisibility || {},
    hasVoiceover: Boolean(rawSummary.hasVoiceover || audio.length > 0),
    hasMusic: Boolean(rawSummary.hasMusic || music.length > 0),
    hasAudio: Boolean(rawSummary.hasAudio || audio.length > 0 || music.length > 0),
    hasTranscription: Boolean(rawSummary.hasTranscription || captions.length > 0),
    hasSceneAnalysis: Boolean(rawSummary.hasSceneAnalysis),
  };
}

export const SUPPORTED_OLLIMA_MODELS = Object.freeze([
  "gemini-3-flash",
  "gemini-3.1-flash-lite",
  "gemma4",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "glm-5.2",
  "glm-5.3",
  "minimax-m3",
  "nemotron-ultra",
  "nemotron-super",
  "kimi-k2.7-code",
  "kimi-k2.6",
  "gpt-oss-120b",
  "gemini-3.1-flash-image",
]);

/**
 * Invokes Ollima chat completions API and parses/validates the returned plan.
 *
 * @param {Object} options
 * @param {string} options.prompt - User's natural language instruction
 * @param {Object} options.projectSummary - Current project summary
 * @param {string} [options.model] - Target model identifier from allowlist
 * @param {Object} [options.overrides] - Test injection overrides ({ apiKey, model, baseUrl, timeoutMs, fetchFn })
 * @returns {Promise<Object>} Validated editing plan
 */
export async function generateEditingPlan({ prompt, projectSummary, model: requestedModel, overrides = {} }) {
  const cleanPrompt = typeof prompt === "string" ? prompt.trim() : "";
  if (!cleanPrompt) {
    throw new ApiError(400, "INVALID_PROMPT", "Prompt must be a non-empty string.");
  }
  if (cleanPrompt.length > 5000) {
    throw new ApiError(400, "PROMPT_TOO_LONG", "Prompt exceeds maximum allowed length of 5000 characters.");
  }

  const model = overrides.model ?? requestedModel ?? config.ollima.model ?? "gemini-3-flash";
  if (!SUPPORTED_OLLIMA_MODELS.includes(model)) {
    throw new ApiError(
      400,
      "UNSUPPORTED_MODEL",
      `Model '${model}' is not in the supported models allowlist. Supported models: ${SUPPORTED_OLLIMA_MODELS.join(", ")}.`
    );
  }

  const apiKey = overrides.apiKey ?? config.ollima.apiKey;
  const baseUrl = (overrides.baseUrl ?? config.ollima.baseUrl).replace(/\/+$/, "");
  const timeoutMs = overrides.timeoutMs ?? config.ollima.timeoutMs;
  const fetchFn = overrides.fetchFn ?? globalThis.fetch;

  if (!apiKey) {
    throw new ApiError(
      503,
      "OLLIMA_NOT_CONFIGURED",
      "Ollama AI editing assistant is not configured on this server. Please set OLLIMA_API_KEY."
    );
  }

  const sanitizedSummary = sanitizeProjectSummary(projectSummary);

  const requestBody = {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: JSON.stringify({
          instruction: cleanPrompt,
          timeline: sanitizedSummary,
        }),
      },
    ],
    temperature: 0.1,
    response_format: { type: "json_object" },
    stream: false,
  };

  let response;
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    response = await fetchFn(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": "AI-Video-Editor-TimelineStudio",
      },
      body: JSON.stringify(requestBody),
      signal,
    });
  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new ApiError(504, "OLLIMA_TIMEOUT", "Ollama request timed out.");
    }
    throw new ApiError(502, "OLLIMA_NETWORK_ERROR", `Failed to connect to Ollima: ${err.message}`);
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new ApiError(502, "OLLIMA_AUTH_FAILED", "Ollama authentication failed. Please verify the configured API key.");
    }
    if (response.status === 404) {
      throw new ApiError(404, "OLLIMA_MODEL_NOT_FOUND", `Configured Ollima model '${model}' was not found or is not available.`);
    }
    if (response.status === 429) {
      throw new ApiError(429, "OLLIMA_RATE_LIMITED", "Ollama rate limit reached. Please try again later.");
    }
    if (response.status >= 500) {
      throw new ApiError(502, "OLLIMA_UPSTREAM_ERROR", `Ollama upstream error (HTTP ${response.status}).`);
    }
    throw new ApiError(502, "OLLIMA_ERROR", `Ollama API returned error status ${response.status}.`);
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    throw new ApiError(502, "OLLIMA_MALFORMED_RESPONSE", `Ollama returned malformed JSON: ${err.message}`);
  }

  const contentText = data?.choices?.[0]?.message?.content ?? data?.message?.content;
  if (typeof contentText !== "string" || !contentText.trim()) {
    throw new ApiError(502, "OLLIMA_EMPTY_RESPONSE", "Ollama returned empty message content.");
  }

  let parsedPlan;
  try {
    parsedPlan = JSON.parse(contentText);
  } catch (err) {
    throw new ApiError(422, "OLLIMA_INVALID_PLAN_JSON", `Model output could not be parsed as JSON: ${err.message}`);
  }

  let normalizedPlan;
  try {
    normalizedPlan = validateAndNormalizePlan(parsedPlan);
  } catch (err) {
    throw new ApiError(422, "INVALID_EDITING_PLAN", `Generated plan did not meet validation schema: ${err.message}`);
  }

  normalizedPlan.model = model;

  if (model === "gemini-3.1-flash-image") {
    normalizedPlan.warnings.push("gemini-3.1-flash-image is specialized for image generation. Consider gemini-3-flash for complex editing plans.");
  }

  return normalizedPlan;
}
