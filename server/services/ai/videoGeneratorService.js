/**
 * AI Video Generator Service
 *
 * Orchestrates the conversion of natural-language video prompts into
 * structured, validated video specifications with scenes, visual descriptions,
 * narration scripts, and timeline parameters.
 */

import { config } from "../../config.js";
import { ApiError } from "../errors.js";
import { validateAndNormalizeVideoSpec } from "./videoPlanSchema.js";
import { SUPPORTED_OLLIMA_MODELS } from "./ollimaService.js";

const GENERATOR_SYSTEM_PROMPT = `You are the Executive Video Director for Timeline Studio.
Your role is to translate a user's natural language concept into a structured, validated, and scenes-based video specification.

You will receive:
1. User prompt / creative vision.
2. Target duration (seconds).
3. Aspect ratio (e.g. 9:16, 16:9, 1:1).
4. Visual style (e.g. cinematic, tech, documentary, nature).

You MUST respond ONLY with a strict JSON object adhering to schemaVersion 1.
Do NOT output markdown fences, thinking logs, comments, or explanations outside the JSON.

JSON Structure:
{
  "schemaVersion": 1,
  "title": "Concise Engaging Title",
  "summary": "1-2 sentence overview of the video narrative arc",
  "targetDuration": 30,
  "aspectRatio": "9:16",
  "style": "cinematic",
  "narration": {
    "enabled": true,
    "voiceId": "af_heart",
    "language": "en",
    "script": "Complete spoken voiceover narration combining all scenes..."
  },
  "music": {
    "enabled": true,
    "mood": "inspirational modern ambient",
    "query": "cinematic ambient synth",
    "volume": 0.25
  },
  "captions": {
    "enabled": true,
    "stylePreset": "neon",
    "position": "bottom"
  },
  "scenes": [
    {
      "id": "scene-1",
      "title": "Opening Hook",
      "duration": 5.0,
      "visualDescription": "Detailed visual description of camera shot and action",
      "searchQuery": "stock footage search query 3-6 words",
      "narration": "Voiceover spoken during this exact scene",
      "caption": "Verbatim subtitle matching the exact spoken words in narration for this scene",
      "transition": "fade"
    }
  ]
}

Critical Directing Rules:
1. Scene Durations: Divide the target duration across 3 to 8 distinct, punchy scenes. The sum of scene durations MUST approximately equal targetDuration.
2. Transitions: Allowed: "fade", "zoom", "wipe-left", "split", "none".
3. Search Query & Visual Directives: Every scene's searchQuery and visualDescription MUST describe concrete, tangible physical subjects, environments, actions, and locations (e.g. "Bangalore skyline UB City high rise", "software engineers in modern office meeting room", "enterprise server rack glowing ethernet cables", "confident business leader portrait office"). NEVER use abstract metaphors, buzzwords, or slogans (e.g. NEVER use "Shaping the future", "Collaboration drives innovation", "Powering the digital economy", "Reaching new heights", "Tomorrow's world").
4. Closing Scene Resolution: The final closing scene MUST resolve the story with grounded, concrete imagery matching the domain (e.g. "modern tech glass campus architecture dusk sunset" or "confident business executive portrait"), NEVER agricultural, floral, or unrelated thematic jumps like wheat or landscapes.
5. Distinct Imagery: Every scene must have a distinct visual query. Avoid repeated images or identical subjects across multiple scenes.
6. Verbatim Subtitles: The caption field must contain the exact spoken narration words for that scene so subtitles never diverge from voiceover audio.
7. Safety: Never generate executable code, system commands, URLs, or harmful content.`;

/**
 * Converts abstract concepts, buzzwords, or slogans into concrete, tangible physical visual search queries.
 */
export function concretizeVisualSearchQuery(queryOrConcept, domain = "tech", isFinale = false) {
  const clean = (queryOrConcept || "").trim();
  if (!clean) return isFinale ? "modern architecture building sunset" : "modern office workplace";

  // Specific city / location mappings
  if (/\b(bengaluru|bangalore)\b/i.test(clean)) {
    if (/\b(vidhana|soudha|palace|landmark)\b/i.test(clean)) {
      return "Bangalore Vidhana Soudha illuminated";
    }
    return "Bangalore skyline UB City architecture";
  }

  // Software engineering / reliable systems / development / coding
  if (/\b(reliable systems|complex ideas|software engineer|software development|coding|programming|source code|systems engineer|devops|algorithm)\b/i.test(clean)) {
    return "software engineers coding at computer workstations in modern tech office";
  }

  // Hardware engineering / microchips / electronics / cleanrooms / precision
  if (
    /\b(precision|cleanroom|microchip|semiconductor|circuit board|motherboard|pcb|hardware components|electronic assembly)\b/i.test(clean) ||
    (/\b(connection|performance|hardware)\b/i.test(clean) && (domain === "tech" || /\b(tech|digital|system|engineer|network)\b/i.test(clean)))
  ) {
    return "electronics circuit board soldering cleanroom manufacturing";
  }

  // Collaboration / teamwork / meetings
  if (/\b(collaboration|collaborat|teamwork|cooperation|synergy|brainstorm|people and technology|moving forward|solutions that move)\b/i.test(clean)) {
    if (domain === "tech" || /\b(engineer|code|software|tech|developer|digital|it|business|enterprise)\b/i.test(clean)) {
      return "software engineers in tech office meeting room";
    }
    return "creative team collaborating in modern office";
  }

  // Future / finale / next chapter / closing
  if (/\b(shaping the future|next chapter|tomorrow|future|horizons|legacy|enduring|closing|outro|finale|only the beginning|connected future)\b/i.test(clean)) {
    if (domain === "tech" || /\b(tech|network|data|digital)\b/i.test(clean)) {
      return "modern tech campus glass building dusk sunset";
    }
    if (domain === "nature" || /\b(mountain|alps|lake|nature|travel)\b/i.test(clean)) {
      return "majestic mountain summit sunset horizon";
    }
    return "modern architecture city skyline sunset horizon";
  }

  // Alpine villages / chalets
  if (/\b(village|villages|chalet|chalets|town)\b/i.test(clean)) {
    return "picturesque Swiss alpine village wooden chalets";
  }

  // Networking / servers / infrastructure
  if (/\b(network|transmitting|infrastructure|server|data cent|datacenter|cisco|ccie|router|switch|fiber)\b/i.test(clean)) {
    return "data center server rack glowing ethernet cables";
  }

  // Technical education / labs / students / training / placements
  if (/\b(lab|labs|training|placement|placements|career|student|students|classroom|doors opened|theory into practice)\b/i.test(clean)) {
    return "computer lab students engineering classroom";
  }

  // Founder / leadership / executive portrait
  if (/\b(founder|ceo|leader|leadership|mastery|vikas|executive|creator|author)\b/i.test(clean)) {
    return "confident business executive portrait modern office";
  }

  // Abstract digital economy / power / transmission
  if (/\b(powering the digital|digital economy|connectivity|transmitting)\b/i.test(clean)) {
    return "data center fiber optic cables server";
  }

  return clean;
}

/**
 * Intelligent deterministic fallback generator used when Ollima API key
 * is not configured or in offline/test environments.
 */
export function generateLocalFallbackSpec({
  prompt,
  targetDuration = 30,
  aspectRatio = "9:16",
  style = "cinematic",
  voiceId = "af_heart",
  referenceAssets = [],
}) {
  const cleanPrompt = prompt.trim();
  const dur = Number(targetDuration) || 30;

  // Filter image and video reference assets
  const refImages = referenceAssets.filter((a) => !a.type || a.type.startsWith("image"));
  const refVideos = referenceAssets.filter((a) => a.type && a.type.startsWith("video"));

  // Determine scene count based on duration (approx 5-7s per scene)
  const numScenes = Math.max(3, Math.min(8, Math.round(dur / 6)));
  const baseSceneDur = Number((dur / numScenes).toFixed(1));

  // Extract clean primary topic and subtopics from prompt
  const STOP_WORDS = new Set([
    "create", "make", "generate", "produce", "build", "render", "video", "short", "shorts",
    "clip", "clips", "film", "movie", "reel", "reels", "about", "exploring", "showcasing",
    "celebrating", "featuring", "with", "from", "using", "that", "this", "these", "those",
    "second", "seconds", "minute", "minutes", "cinematic", "vertical", "horizontal", "square",
    "portrait", "landscape", "youtube", "tiktok", "format", "engaging", "visuals", "footage",
    "visual", "natural", "english", "voiceover", "voice", "background", "music", "soundtrack",
    "ambient", "animated", "captions", "caption", "subtitles", "subtitle", "smooth", "transitions",
    "transition", "strong", "ending", "outro", "intro", "breathtaking", "stunning", "modern",
    "aesthetic", "inspirational", "high", "detail", "resolution", "quality", "please", "want",
  ]);

  const topicMatch = cleanPrompt.match(/\b(?:about|exploring|showcasing|celebrating|featuring|on)\s+([^,.:;]+)/i);
  let detectedSubject = "";
  if (topicMatch && topicMatch[1]) {
    const rawSubjectWords = topicMatch[1]
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w.toLowerCase()));
    if (rawSubjectWords.length > 0) {
      detectedSubject = rawSubjectWords.slice(0, 3).join(" ");
    }
  }

  // Extract explicit brief concepts from punctuation- or conjunction-separated phrases
  const rawClauses = cleanPrompt
    .split(/[:;,.\n]+|\s+and\s+|\s+with\s+/i)
    .map((c) => c.trim())
    .filter(Boolean);

  const promptConcepts = [];
  for (const clause of rawClauses) {
    const words = clause.split(/\s+/).filter((w) => w.length > 2);
    const contentWords = words.filter((w) => !STOP_WORDS.has(w.toLowerCase()));
    if (contentWords.length >= 1 && contentWords.length <= 6) {
      const phrase = contentWords.join(" ");
      if (phrase.length >= 3 && !promptConcepts.some((c) => c.toLowerCase() === phrase.toLowerCase())) {
        promptConcepts.push(phrase);
      }
    }
  }

  const allWords = cleanPrompt
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w.toLowerCase()));

  const rawTopic = detectedSubject || (promptConcepts[0] ? promptConcepts[0].split(" ").slice(0, 2).join(" ") : "") || allWords.slice(0, 3).join(" ") || "Creative Showcase";
  const primaryTopic = rawTopic
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");

  // Motion directives for scenes
  const MOTION_PRESETS = [
    "slow_push_in",
    "pan_right",
    "slow_pull_back",
    "pan_left",
    "tilt_up_drift",
    "dramatic_zoom_out",
  ];

  // Domain-specific concept arcs when prompt does not supply enough explicit clauses
  const DOMAIN_ARCS = {
    tech: [
      { name: "Vision & Architecture", query: "Bangalore skyline UB City architecture", desc: "Establishing view of modern technology hub with futuristic glass high-rise towers", narration: `At the cutting edge of ${primaryTopic}, visionary architecture meets precision execution.` },
      { name: "Core Infrastructure", query: "data center server rack glowing ethernet cables", desc: "High-density enterprise server racks, fiber optic cabling, and live network routing", narration: `Resilient infrastructure powers seamless data flow and distributed computing.` },
      { name: "Technical Research & Labs", query: "computer lab students engineering classroom", desc: "Engineers and researchers collaborating inside an advanced development laboratory", narration: `Inside engineering labs, researchers collaborate to push technological frontiers.` },
      { name: "Team & Career Growth", query: "software engineers in tech office meeting room", desc: "Engineers and professionals engaged in team collaboration, mentorship, and review", narration: `Empowering professional careers through mentorship, shared goals, and collaborative innovation.` },
      { name: "Scaled Impact", query: "modern corporate office glass building", desc: "Metropolitan skyline illuminated at dusk, representing global connected scale", narration: `Connecting enterprises, cities, and communities across an interconnected world.` },
      { name: "Future Horizons", query: "modern tech campus glass building dusk sunset", desc: "Forward-looking technology leaders charting future innovations and new horizons", narration: `Driving forward with confidence, craftsmanship, and a commitment to enduring impact.` },
    ],
    nature: [
      { name: "Alpine Summits", query: "aerial Swiss Alps sunrise", desc: "Sweeping aerial panoramic view over snow-capped mountain peaks at sunrise", narration: `High above the valleys of ${primaryTopic}, majestic peaks rise into the morning sky.` },
      { name: "Glacial Waters", query: "turquoise alpine lake Switzerland", desc: "Serene turquoise alpine lake reflecting towering pine slopes and distant peaks", narration: `Crystal-clear glacial waters mirror the dramatic grandeur of surrounding summits.` },
      { name: "Scenic Mountain Railway", query: "Swiss train viaduct", desc: "Iconic red train crossing a stone viaduct across deep valleys and alpine passes", narration: `Historic scenic railways wind through rugged mountain passes and ancient forests.` },
      { name: "Chalet Villages", query: "Swiss alpine village chalets", desc: "Traditional wooden chalets nestled in picturesque green mountain valleys", narration: `Historic alpine villages preserve timeless charm nestled between towering rock faces.` },
      { name: "Alpine Meadow Trails", query: "hiking alpine meadow Switzerland", desc: "Hikers traversing colorful alpine wildflower meadows with panoramic mountain vistas", narration: `Scenic mountain trails guide travelers through vibrant wildflower meadows.` },
      { name: "Sunset Alpenglow", query: "Swiss Alps sunset alpenglow", desc: "Golden sunset casting warm pink and gold alpenglow across dramatic mountain ridges", narration: `As day gives way to evening, golden alpenglow crowns the peaks in peaceful tranquility.` },
    ],
    social: [
      { name: "The Craft", query: "artisan craft preparation", desc: "Careful preparation of ingredients and artisanal tools in a warm creative studio", narration: `The journey of ${primaryTopic} begins with dedicated hands and meticulous craft.` },
      { name: "Precision Technique", query: "detailed espresso brewing", desc: "Dynamic close-up capturing focused craftsmanship and specialized technique", narration: `Every step demands patience, precision, and an eye for subtle perfection.` },
      { name: "The Creation", query: "artisan product showcase", desc: "Beautifully presented finished creation highlighted under soft natural light", narration: `From raw concept to finished reality, craftsmanship speaks through quality.` },
      { name: "Shared Experience", query: "people coffee cafe conversation", desc: "Community enjoying the experience together in a warm, welcoming atmosphere", narration: `Great craftsmanship brings people together to share memorable moments.` },
      { name: "Detail & Texture", query: "craft details texture", desc: "Macro camera glide over rich textures, colors, and authentic materials", narration: `Every fine detail reflects devotion to quality and genuine expression.` },
      { name: "Enduring Community", query: "creative team cafe workshop", desc: "Warm and inviting finale celebrating community, creativity, and lasting tradition", narration: `A celebration of craft and community that continues to inspire everyday life.` },
    ],
    cinematic: [
      { name: "Establishing Panorama", query: `${primaryTopic} skyline architecture`, desc: `Dramatic cinematic wide shot establishing the visual atmosphere of ${primaryTopic}`, narration: `A cinematic journey into ${primaryTopic}, where vision and atmosphere intertwine.` },
      { name: "Focused Perspective", query: `${primaryTopic} detailed close up`, desc: `Dynamic camera glide capturing intricate detail and authentic essence`, narration: `Examining the subtle textures and core elements that define this unique space.` },
      { name: "Active Dynamics", query: `${primaryTopic} action movement`, desc: `Atmospheric tracking shot illustrating dynamic momentum and purposeful action`, narration: `Momentum builds as energy and purpose drive the narrative forward.` },
      { name: "Human Element", query: `${primaryTopic} professional portrait`, desc: `Inspiring perspective highlighting human connection, dedication, and expression`, narration: `At the center of the story are dedicated minds creating real change.` },
      { name: "Expansive Horizon", query: `${primaryTopic} modern building dusk`, desc: `Sweeping elevated perspective revealing the scale and horizon of the journey`, narration: `Looking out across expansive horizons with clarity and bold ambition.` },
      { name: "Enduring Legacy", query: `${primaryTopic} sunset horizon`, desc: `Poignant concluding visual reflecting lasting impact and memorable visual poetry`, narration: `Leaving a lasting legacy that continues to resonate and inspire.` },
    ],
  };

  const domainArc = DOMAIN_ARCS[style] || DOMAIN_ARCS.cinematic;

  // Build brief-specific scenes
  const scenes = [];
  let remainingDur = dur;

  // Filter out any concept that is simply the title of the video itself
  const usableConcepts = promptConcepts.filter(
    (c) => c.toLowerCase() !== primaryTopic.toLowerCase() && c.length >= 3
  );

  // Check if reference asset is person/founder portrait
  let usedReferenceAsset = false;
  const portraitRef = refImages.find(
    (r) => r.role === "portrait" || r.role === "founder" || r.role === "person" || /portrait|founder|person|face|ceo|profile/i.test(r.name || "")
  ) || (refImages.length > 0 ? refImages[0] : null);

  for (let i = 0; i < numScenes; i++) {
    const isLast = i === numScenes - 1;
    const sceneDur = isLast ? Number(remainingDur.toFixed(1)) : Math.min(remainingDur - (numScenes - i - 1) * 2, baseSceneDur);
    remainingDur -= sceneDur;

    const motionPreset = MOTION_PRESETS[i % MOTION_PRESETS.length];
    let sceneTitle;
    let visualDescription;
    let searchQuery;
    let sceneNarration;
    let sceneCaption;

    if (usableConcepts.length > 0 && i < usableConcepts.length) {
      // Direct mapping from user's explicit brief concept
      const concept = usableConcepts[i];
      const capConcept = concept.split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
      sceneTitle = `${primaryTopic}: ${capConcept}`;

      // Smart stock query extraction: convert abstract phrases to concrete visual targets
      searchQuery = concretizeVisualSearchQuery(concept, style, isLast);

      visualDescription = `Cinematic ${style} camera sequence capturing ${searchQuery} in vivid detail, featuring ${primaryTopic} with dynamic lighting and camera movement.`;
      sceneNarration = isLast
        ? `Bringing ${concept} to life, ${primaryTopic} continues to inspire with vision and enduring dedication.`
        : `Focusing on ${concept}, ${primaryTopic} demonstrates dedication, craftsmanship, and leadership.`;
      sceneCaption = sceneNarration;
    } else {
      // Use domain arc
      const arc = domainArc[i % domainArc.length];
      sceneTitle = `${primaryTopic}: ${arc.name}`;
      visualDescription = `${arc.desc} associated with ${primaryTopic}, shot with ${style} visual framing.`;
      searchQuery = concretizeVisualSearchQuery(arc.query, style, isLast);
      sceneNarration = arc.narration;
      sceneCaption = sceneNarration;
    }

    let assignedAssetId = undefined;
    let useReferenceAsset = false;
    let referenceRole = undefined;

    // Check if this scene should use an attached reference image or video:
    // IMPORTANT: Never attach a founder/person reference photo to Scene 0 (establishing city/landscape shot)!
    // Attach to the founder/portrait scene (or Scene 1 if no explicit founder scene).
    const isPersonScene = /\b(founder|portrait|person|ceo|author|leader|profile|meet)\b/i.test(`${sceneTitle} ${sceneNarration}`);
    if (portraitRef && !usedReferenceAsset && (isPersonScene || (i === 1 && !usableConcepts.some(c => /\b(founder|portrait)\b/i.test(c))))) {
      assignedAssetId = portraitRef.id;
      useReferenceAsset = true;
      referenceRole = portraitRef.role || "portrait";
      usedReferenceAsset = true;
      sceneTitle = `${primaryTopic}: Executive Portrait`;
      visualDescription = `High-definition authentic portrait showcase featuring ${portraitRef.name || "founder"} in a modern professional setting.`;
    } else if (refVideos.length > 0 && (i === 1 || refVideos[0].role === "alongside")) {
      const ref = refVideos[0];
      assignedAssetId = ref.id;
      useReferenceAsset = true;
      referenceRole = ref.role || "alongside";
      sceneTitle = `${primaryTopic}: Attached Footage`;
      visualDescription = `Footage from attached reference video ${ref.name || "clip"} integrated into sequence.`;
    }

    const sceneKeywords = Array.from(
      new Set([
        ...searchQuery.split(/\s+/).filter((w) => w.length > 2),
        ...primaryTopic.split(/\s+/).filter((w) => w.length > 2),
        style,
      ])
    ).slice(0, 5);

    scenes.push({
      id: `scene-${i + 1}`,
      title: sceneTitle,
      duration: Math.max(2, sceneDur),
      visualDescription,
      searchQuery: searchQuery || `${primaryTopic} ${style}`,
      searchKeywords: sceneKeywords,
      narration: sceneNarration,
      caption: sceneCaption,
      transition: i % 2 === 0 ? "fade" : "zoom",
      motion: motionPreset,
      assignedAssetId,
      useReferenceAsset,
      referenceRole,
    });
  }

  const fullScript = scenes.map((s) => s.narration).join(" ");

  const rawSpec = {
    schemaVersion: 1,
    title: primaryTopic.length <= 25 ? `${primaryTopic}: Journey` : primaryTopic,
    summary: `A ${dur}-second ${style} video exploring ${primaryTopic}.`,
    targetDuration: dur,
    aspectRatio,
    style,
    narration: {
      enabled: true,
      voiceId,
      language: "en",
      script: fullScript,
    },
    music: {
      enabled: true,
      mood: `${style} ambient soundtrack`,
      query: `${style} ambient`,
      volume: 0.25,
    },
    captions: {
      enabled: true,
      stylePreset: "neon",
      position: "bottom",
    },
    scenes,
  };

  return validateAndNormalizeVideoSpec(rawSpec, { targetDuration: dur, aspectRatio, style, voiceId });
}

let customFetchFn = null;

export function setGeneratorFetch(fn) {
  customFetchFn = fn;
}

export function resetGeneratorFetch() {
  customFetchFn = null;
}

/**
 * Generates a structured video specification from a user's creative prompt.
 *
 * @param {Object} options
 * @param {string} options.prompt - Natural-language prompt
 * @param {number} [options.targetDuration=30] - Target duration in seconds (15, 30, 60, 90)
 * @param {string} [options.aspectRatio="9:16"] - Target aspect ratio (9:16, 16:9, 1:1)
 * @param {string} [options.style="cinematic"] - Visual style
 * @param {string} [options.voiceId="af_heart"] - Narrator voice identifier
 * @param {string} [options.model] - Ollima model override
 * @param {Object} [options.overrides] - Test injection overrides ({ apiKey, baseUrl, fetchFn })
 * @returns {Promise<Object>} Validated Video Specification
 */
export async function generateVideoSpecification({
  prompt,
  targetDuration = 30,
  aspectRatio = "9:16",
  style = "cinematic",
  voiceId = "af_heart",
  model: requestedModel,
  overrides = {},
  referenceAssets = [],
}) {
  const cleanPrompt = typeof prompt === "string" ? prompt.trim() : "";
  if (!cleanPrompt) {
    throw new ApiError(400, "INVALID_PROMPT", "Prompt must be a non-empty string.");
  }
  if (cleanPrompt.length > 5000) {
    throw new ApiError(400, "PROMPT_TOO_LONG", "Prompt exceeds maximum allowed length of 5000 characters.");
  }

  const dur = Number(targetDuration) || 30;
  const ratio = aspectRatio || "16:9";

  const apiKey = overrides.apiKey ?? config.ollima.apiKey;
  const baseUrl = (overrides.baseUrl ?? config.ollima.baseUrl).replace(/\/+$/, "");
  const timeoutMs = overrides.timeoutMs ?? config.ollima.timeoutMs;
  const fetchFn = overrides.fetchFn ?? customFetchFn ?? globalThis.fetch;
  const model = overrides.model ?? requestedModel ?? config.ollima.model ?? "gemini-3-flash";

  console.info(`[VideoGenerator] Generating spec: duration=${dur}s, ratio=${ratio}, style=${style}, requestedModel=${requestedModel || "default"}, effectiveModel=${model}`);

  // If Ollima API is not configured or in fallback mode, use intelligent deterministic planner
  if (!apiKey) {
    console.info("[VideoGenerator] Ollima API key not configured. Using local deterministic planner.");
    const fallback = generateLocalFallbackSpec({
      prompt: cleanPrompt,
      targetDuration: dur,
      aspectRatio: ratio,
      style,
      voiceId,
      referenceAssets,
    });
    fallback.effectiveModel = "local-deterministic-planner";
    fallback.requestedModel = requestedModel || model;
    fallback.isFallbackSpec = true;
    fallback.fallbackReason = "OLLIMA_API_KEY_NOT_CONFIGURED";
    return fallback;
  }

  // Model validation
  if (!SUPPORTED_OLLIMA_MODELS.includes(model)) {
    throw new ApiError(
      400,
      "UNSUPPORTED_MODEL",
      `Model '${model}' is not in the supported models allowlist.`
    );
  }

  const userPayload = {
    creativePrompt: cleanPrompt,
    targetDuration: dur,
    aspectRatio: ratio,
    style,
    voiceId,
    referenceAssets: referenceAssets.map((r) => ({ id: r.id, name: r.name, role: r.role, type: r.type })),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: GENERATOR_SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(userPayload) },
        ],
        temperature: 0.2,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      console.warn(`[VideoGenerator] Ollima returned HTTP ${response.status}. Using high-fidelity local fallback.`);
      const fallback = generateLocalFallbackSpec({
        prompt: cleanPrompt,
        targetDuration: dur,
        aspectRatio: ratio,
        style,
        voiceId,
        referenceAssets,
      });
      fallback.effectiveModel = "local-deterministic-planner";
      fallback.requestedModel = requestedModel || model;
      fallback.isFallbackSpec = true;
      fallback.fallbackReason = `OLLIMA_HTTP_${response.status}`;
      return fallback;
    }

    const data = await response.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content?.trim();
    if (!content) {
      console.warn("[VideoGenerator] Ollima returned empty message content. Using local fallback.");
      const fallback = generateLocalFallbackSpec({
        prompt: cleanPrompt,
        targetDuration: dur,
        aspectRatio: ratio,
        style,
        voiceId,
        referenceAssets,
      });
      fallback.effectiveModel = "local-deterministic-planner";
      fallback.requestedModel = requestedModel || model;
      fallback.isFallbackSpec = true;
      fallback.fallbackReason = "EMPTY_MODEL_RESPONSE";
      return fallback;
    }

    // Clean any markdown fences if present
    const cleaned = content.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```$/, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      console.warn("[VideoGenerator] Model output was not valid JSON. Using local fallback.");
      const fallback = generateLocalFallbackSpec({
        prompt: cleanPrompt,
        targetDuration: dur,
        aspectRatio: ratio,
        style,
        voiceId,
        referenceAssets,
      });
      fallback.effectiveModel = "local-deterministic-planner";
      fallback.requestedModel = requestedModel || model;
      fallback.isFallbackSpec = true;
      fallback.fallbackReason = "INVALID_JSON_RESPONSE";
      return fallback;
    }

    const spec = validateAndNormalizeVideoSpec(parsed, {
      targetDuration: dur,
      aspectRatio: ratio,
      style,
      voiceId,
    });
    spec.effectiveModel = model;
    spec.requestedModel = requestedModel || model;
    spec.isFallbackSpec = false;
    console.info(`[VideoGenerator] Spec generated successfully using effectiveModel: ${model}`);
    return spec;
  } catch (err) {
    clearTimeout(timer);
    console.warn(`[VideoGenerator] Connection error or timeout (${err.message}). Using high-fidelity local fallback.`);
    const fallback = generateLocalFallbackSpec({
      prompt: cleanPrompt,
      targetDuration: dur,
      aspectRatio: ratio,
      style,
      voiceId,
      referenceAssets,
    });
    fallback.effectiveModel = "local-deterministic-planner";
    fallback.requestedModel = requestedModel || model;
    fallback.isFallbackSpec = true;
    fallback.fallbackReason = `CONNECTION_ERROR: ${err.message}`;
    return fallback;
  }
}
