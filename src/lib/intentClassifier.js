/**
 * AI Assistant Intent Classifier
 *
 * Distinguishes between:
 * 1. "generation" - Explicit requests to create a brand-new video from scratch via AI Video Generator
 * 2. "editing" - Operations modifying the current project/timeline (trim, split, captions, markers, ratio, etc.)
 * 3. "ambiguous" - Requests where intent is unclear, prompting short user clarification
 */
import { getAvailableCaptionStyles, findCaptionStylePreset, resolveColorToHex, NAMED_COLOR_MAP, SUPPORTED_CAPTION_EFFECTS } from "./captionStyles.js";
import { getAvailableCaptionFontChoices, findCaptionFontInCatalog } from "./captionFonts.js";

/**
 * Detects if a text prompt is requesting an active-word/highlight color change.
 */
export function isActiveWordColorCommand(text) {
  if (!text || typeof text !== "string") return false;
  return (
    /\b(?:active[- ]word|highlighted[- ]word|current[- ]word|karaoke\s+(?:highlight|word|color))\s*(?:to\s+)?color\b/i.test(text) ||
    /\b(?:color|highlight)\s+(?:of|for)\s+(?:the\s+)?(?:active[- ]word|current[- ]word|highlighted[- ]word|karaoke)\b/i.test(text) ||
    /\b(?:change|set|make|update)\s+(?:the\s+)?(?:active[- ]word|current[- ]word|highlighted[- ]word|karaoke\s+highlight)\s+(?:color\s+)?(?:to\s+|as\s+)?/i.test(text) ||
    /\b(?:make|set|change)\s+(?:the\s+)?(?:karaoke\s+highlight|active[- ]word\s+highlight)\b/i.test(text) ||
    /\bactiveWordColor\b/i.test(text)
  );
}

/**
 * Extracts and resolves the target active-word highlight color to a 6-digit hex string (#RRGGBB).
 * Returns null if the color cannot be resolved confidently.
 */
export function extractActiveWordColor(text) {
  if (!text || typeof text !== "string") return null;

  // 1. Check for explicit hex color: #RRGGBB or #RGB
  const hexMatch = text.match(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/);
  if (hexMatch) {
    const resolved = resolveColorToHex(hexMatch[0]);
    if (resolved) return resolved;
  }

  // 2. Pattern: "<color> instead of <color>" or "to <color> instead of <color>"
  const insteadMatch = text.match(/\b([a-zA-Z]+)\s+instead\s+of\s+[a-zA-Z]+\b/i);
  if (insteadMatch) {
    const resolved = resolveColorToHex(insteadMatch[1]);
    if (resolved) return resolved;
  }

  // 3. Pattern: "to <color>", "as <color>", "into <color>", "color <color>"
  const targetMatch = text.match(/\b(?:to|as|into|color\s+(?:is|to)?|highlight\s+(?:is|to)?)\s+([a-zA-Z]+)\b/i);
  if (targetMatch) {
    const resolved = resolveColorToHex(targetMatch[1]);
    if (resolved) return resolved;
  }

  // 4. Pattern: "make ... highlight <color>"
  const makeHighlightMatch = text.match(/\bhighlight\s+([a-zA-Z]+)\b/i);
  if (makeHighlightMatch) {
    const resolved = resolveColorToHex(makeHighlightMatch[1]);
    if (resolved) return resolved;
  }

  // 5. Scan words for any named color in NAMED_COLOR_MAP
  const words = text.toLowerCase().split(/[^a-zA-Z0-9#]+/);
  const colorWords = words.filter((w) => Boolean(resolveColorToHex(w)));
  if (colorWords.length === 1) {
    return resolveColorToHex(colorWords[0]);
  }

  return null;
}
// 1. Explicit generation intent patterns
// Matches phrases where the user directs the creation of a new video/reel/short/film/documentary/promo
const EXPLICIT_GENERATION_PATTERNS = [
  // Creation verb + (optional adjectives/duration/qualifiers) + video noun
  // e.g., "Create a 30-second cinematic travel video about...", "Generate a vertical video about coffee roasting", "Start a new video project about..."
  /\b(?:create|generate|make|produce|build|direct|compose|start)\s+(?:a|an\s+)?(?:brand[- ]new\s+|new\s+)?(?:[\w-,\s]{0,80}?)\b(?:video|reel|shorts?|documentary|film|movie|teaser|promo|montage|trailer)\b/i,

  // "Prompt to video:" or "New video:" prefix
  /^(?:prompt\s*(?:to|->)\s*video|new\s+video|generate\s+video)\s*:/i,

  // Direct video creation request for platforms: "create a video for TikTok", "generate a reel for Instagram"
  /\b(?:create|generate|make|produce|start)\s+(?:a|an\s+)?(?:[\w-,\s]{0,40}?)\s+for\s+(?:youtube\s+shorts?|tiktok|instagram(?:\s+reels?)?|reels?)\b/i,

  // Video briefs with scene breakdowns or storyboard specifications
  /(?:^|\n)\s*(?:scene\s+\d+|\[scene\s+\d+\]|storyboard:|scenes:)/i,

  // "Create/Make a [duration] [style] video"
  /\b(?:create|generate|make|produce|start)\s+(?:a|an\s+)?(?:\d+\s*(?:second|sec|s|minute|min)\b|\d+-second)\s*(?:[\w-,\s]{0,40}?)\b(?:video|reel|short|documentary)\b/i,

  // Creative video brief format: e.g. "Vikas Swami founder film: real founder portrait..." or "Swiss Alps travel film: ..."
  /\b[\w\s-]+\s+(?:film|video|movie|documentary|reel|short|promo)\s*:/i,
];

// Indicators that explicitly signify the user is directing edits to their CURRENT / EXISTING timeline project
const EXISTING_PROJECT_INDICATORS = [
  /\b(?:this|current|existing|my)\s+(?:project|timeline|canvas|draft)\b/i,
  /\b(?:my\s+current\s+video|this\s+video's|this\s+project's)\b/i,
  /\b(?:the|this)\s+generated\s+(?:video|project|timeline|result)\b/i,
  /\b(?:in|on|from|to)\s+(?:this|my|the)\s+(?:project|timeline)\b/i,
];

// Timeline and project editing operation patterns
const EDITING_OPERATIONS = [
  // Silence / rough cut / pause removal
  /\b(?:remove|cut|delete|clear|strip)\s+(?:long\s+)?(?:pauses?|silence|dead\s+air|filler\s+words?)\b/i,
  /\brough\s+cut\b/i,

  // Clip manipulation (split, trim, cut, slice, delete, reorder)
  /\b(?:split|slice|cut)\s+(?:the\s+)?(?:first|second|third|last|selected|\d+(?:st|nd|rd|th)?)?\s*(?:clip|segment|track)\b/i,
  /\bsplit\s+(?:the\s+clip\s+)?(?:at\s+)?(?:playhead|current\s+time|current\s+position|here)\b/i,
  /\bsplit\s+at\s+\d+(?:\.\d+)?\s*(?:s|sec|seconds?)?\b/i,
  /\btrim\s+(?:the\s+)?(?:first|second|third|last|selected|\d+(?:st|nd|rd|th)?)?\s*(?:clip|segment|video)\b/i,
  /\btrim\s+(?:clip|video)?\s*(?:to|at|by)\s+\d+(?:\.\d+)?\s*(?:s|sec|seconds?)?\b/i,
  /\bdelete\s+(?:the\s+)?(?:first|second|third|last|selected|\d+(?:st|nd|rd|th)?)?\s*(?:clip|segment|track)\b/i,
  /\bdelete\s+(?:this|selected)\s+(?:clip|video|segment)\b/i,
  /\b(?:delete|clear|remove|wipe)\s+(?:all|everything|the\s+entire|the\s+whole)\s*(?:timeline|clips?|tracks?|project)?\b/i,
  /\breorder\s+(?:the\s+)?(?:clips?|segments?)\b/i,

  // Audio & Music operations (delete, clear, mute, adjust)
  /\b(?:delete|remove|clear)\s+(?:the\s+)?(?:voiceover|voice|audio|music|soundtrack|bgm|background\s+music)\b/i,
  /\b(?:delete|remove|clear)\s+(?:selected|this)?\s*(?:audio|music)\b/i,
  /\b(?:mute|unmute)\s+(?:the\s+)?(?:clip|video|audio|voiceover|music|soundtrack|source)\b/i,
  /\b(?:mute|unmute)\b/i,

  // Captions & Subtitles modifications on current project
  /\b(?:add|generate|create|align|sync|style|position|set|remove|delete|make)\s+(?:all\s+)?(?:the\s+)?(?:captions?|subtitles?)\b/i,
  /\b(?:make|set|change|edit|update)\s+(?:the\s+)?(?:captions?|subtitles?)\s+(?:text|larger|smaller|bigger|huge|tiny|neon|classic|bold)\b/i,
  /\b(?:larger|smaller|bigger)\s+(?:captions?|subtitles?)\b/i,
  /\bcaption\s+(?:style|text)\b/i,
  /\b(?:neon|classic|bold)\s+caption\b/i,
  /\bposition\s+captions?\b/i,

  // Markers
  /\b(?:add|set|create|remove|delete)\s+(?:a\s+)?(?:chapter\s+)?marker\b/i,
  /\bchapter\s+point\b/i,

  // Project canvas properties (aspect ratio, fit mode)
  /\b(?:change|set|switch|update|convert|make)\s+(?:this\s+project'?s?\s+)?(?:canvas\s+)?(?:aspect\s+)?ratio\b/i,
  /\b(?:switch|set|change|convert|make)\s+(?:canvas\s+)?(?:the\s+video\s+|video\s+|project\s+)?(?:ratio\s+to\s+|to\s+)?(?:9:16|16:9|1:1|4:5)\b/i,
  /\bset\s+fit\s+mode\b/i,
  /\b(?:contain|cover)\s+fit\s+mode\b/i,

  // Track & Audio adjustments on current project
  /\b(?:mute|unmute|adjust|lower|boost|raise|reduce|decrease|increase|turn\s+(?:down|up)|set)\s+(?:the\s+)?(?:background\s+)?(?:music|voice|audio|soundtrack|source)(?:\s+volume)?\b/i,
  /\b(?:music|audio|voice)\s+volume\b/i,
  /\breduce\s+(?:the\s+)?(?:background\s+)?music\b/i,
  /\bwithout\s+(?:changing|affecting|muting|altering)\s+(?:the\s+)?(?:voiceover|voice|audio|music)\b/i,

  // Video visual appearance, filters & color grading
  /\b(?:cinematic|noir|vintage|warm(?:er)?|cool(?:er)?|black\s+and\s+white|bright(?:er)?|dark(?:er)?|saturation|contrast|temperature|tint|exposure|shadows|highlights)\b/i,
  /\b(?:visual\s+filter|filter|color\s+grade|color\s+grading|cinematic\s+look|film\s+look|vivid\s+look|look)\b/i,
  /\b(?:zoom\s+in|zoom\s+out|scale\s+up|scale\s+down)\b/i,
  /\bgive\s+(?:this|the|it)?\s*(?:a\s+)?subtle\s+glow\b/i,
  /\bmake\s+(?:this|the|it)?\s*(?:footage|video|clip)?\s*(?:a\s+little\s+|a\s+bit\s+)?(?:brighter|warmer|cooler|darker)\b/i,
  /\breduce\s+(?:the\s+)?saturation\b/i,

  // Speed and playback rate with pitch preservation
  /\b(?:speed\s*up|slow\s*down|change\s+speed|playback\s+rate|\d+(?:\.\d+)?x\s+speed|fast\s+forward|slow\s*mo(?:tion)?)\b/i,
  /\b(?:faster|slower|double\s+the\s+speed|half\s+speed|preserve(?:\s+the)?\s+audio\s+pitch|without\s+making\s+(?:the\s+)?voices\s+sound\s+strange)\b/i,
  /\b(?:speed\s+up\s+the\s+whole\s+video|make\s+this\s+video\s+a\s+little\s+faster|set\s+the\s+selected\s+clip\s+to\s+\d+(?:\.\d+)?x)\b/i,

  // Audio ducking, mixing & fades
  /\b(?:duck(?:ing)?|lower\s+(?:the\s+)?(?:background\s+)?music\s+(?:while|when)\s+(?:someone|people|voice|anybody|somebody)\s+(?:is\s+)?(?:talking|speaks?)|(?:make\s+(?:the\s+)?(?:background\s+)?music\s+)?quieter\s+(?:when|while)\s+(?:someone|people|anybody|somebody|voice)\s+(?:speaks?|talks?|is\s+talking)|quieter\s+during\s+(?:dialogue|speech)|louder\s+than\s+(?:the\s+)?music)\b/i,
  /\b(?:fade\s+(?:the\s+)?music\s+out|fade\s+in|fade\s+out)\b/i,

  // Transitions
  /\b(?:add|apply|set|change|remove|insert)\s+(?:a\s+)?(?:fade|zoom|flash|wipe|blur|split|glitch|transition)\b/i,
  /\btransitions?\b/i,
  /\b(?:smoother\s+transition|transition\s+shorter|remove\s+the\s+transition)\b/i,

  // Multi-turn contextual follow-ups & fitting
  /\b(?:a\s+bit\s+more|a\s+little\s+more|even\s+more|a\s+bit\s+less|apply\s+(?:that|the\s+same(?:\s+treatment)?)\s+to\s+(?:the\s+rest|all(?:\s+clips)?)|the\s+clip\s+after\s+it|the\s+clip\s+before\s+it)\b/i,
  /\bmake\s+everything\s+fit\s+(?:a\s+)?\d+[- ]second\s+video\b/i,

  // Duplication
  /\bduplicate\s+(?:the\s+)?(?:clip|segment|video|image|overlay|it)\b/i,

  // Track locks and visibility
  /\b(?:lock|unlock|hide|show)\s+(?:the\s+)?(?:visual|image|video|audio|music|caption|overlay|sticker|track)\s*(?:track)?\b/i,
  /\b(?:track\s+(?:lock|visibility))\b/i,

  // Integrated AI editing tools & export
  /\b(?:detect\s+scenes|scene\s+detection|smart\s+pipeline|auto\s+captions?|transcribe(?:\s+audio)?|smart\s+frame|auto[- ]reframe|export\s+video|render\s+video)\b/i,

  // Overlay / PIP transformations
  /\b(?:scale|rotate|move|resize)\s+(?:the\s+)?(?:overlay|sticker|pip|image)\b/i,

  // Undo / Redo
  /\b(?:undo|redo|revert)\b/i,
];

// Ambiguous patterns (contains video keywords with topic but missing explicit verbs or context)
const AMBIGUOUS_PATTERNS = [
  /^(?:a\s+)?(?:video|reel|short|documentary)\s+(?:about|on|of)\s+[\w\s-]+$/i,
  /^[\w\s-]+\s+(?:video|reel|short)$/i,
  /^(?:can\s+you\s+)?(?:make|create|do)\s+(?:something\s+with\s+)?(?:this\s+)?video\??$/i,
  /^make\s+it\s+\d+\s*(?:seconds?|s|mins?|minutes?)$/i,
  /^(?:new\s+video|create\s+video|generate\s+video)$/i,
  /^(?:video\s+prompt|video\s+idea):\s*[\w\s-]+$/i,
];

/**
 * Extracts target duration (in seconds) from text if present.
 */
export function extractDuration(text) {
  if (!text) return null;
  // Match e.g. "30-second", "30 seconds", "30s" (avoid matching FPS like "30 FPS")
  const secMatch =
    text.match(/\b(\d+)-second\b/i) ||
    text.match(/\b(\d+)\s*(?:seconds?|secs?)\b/i) ||
    text.match(/\b(\d+)\s*s\b(?!\s*fps)(?!\w)/i);
  if (secMatch) {
    const val = parseInt(secMatch[1], 10);
    if ([15, 30, 60, 90].includes(val)) return val;
    if (val <= 20) return 15;
    if (val <= 45) return 30;
    if (val <= 75) return 60;
    return 90;
  }
  const minMatch = text.match(/\b(\d+)\s*(?:minutes?|mins?|m)\b/i);
  if (minMatch) {
    const min = parseInt(minMatch[1], 10);
    return min === 1 ? 60 : 90;
  }
  return null;
}

/**
 * Extracts aspect ratio from text if present.
 * Supports aspect ratio tags, resolutions (1080x1920, 1920x1080), and platform formats.
 */
export function extractAspectRatio(text) {
  if (!text) return null;
  // 4:5 Social Portrait
  if (/\b(?:4:5|social\s+portrait)\b/i.test(text)) {
    return "4:5";
  }
  // 1:1 Square
  if (
    /\b(?:1:1|square|instagram\s+feed)\b/i.test(text) ||
    /\b1080\s*[×x*]\s*1080\b/i.test(text)
  ) {
    return "1:1";
  }
  // 16:9 Horizontal / Widescreen / YouTube (explicit landscape takes priority)
  if (
    /\b(?:16:9|horizontal|landscape|widescreen|desktop|youtube(?!\s*shorts?))\b/i.test(text) ||
    /\b1920\s*[×x*]\s*1080\b/i.test(text)
  ) {
    return "16:9";
  }
  // 9:16 Vertical (must be qualified format or mobile platform tag, not bare portrait subject)
  if (
    /\b(?:9:16|vertical|portrait\s+(?:format|orientation|mode|video|clip|aspect|ratio|view)|(?:vertical|mobile)\s+portrait|shorts?|reels?|tiktok)\b/i.test(text) ||
    /\b1080\s*[×x*]\s*1920\b/i.test(text)
  ) {
    return "9:16";
  }
  return null;
}

/**
 * Extracts visual style from text if present.
 */
export function extractStyle(text) {
  if (!text) return null;
  if (/\bcinematic\b/i.test(text)) return "cinematic";
  if (/\b(?:nature|aerial|wildlife|outdoors?|landscape|travel)\b/i.test(text)) return "nature";
  if (/\b(?:tech|technology|futuristic|cyberpunk|ai|digital)\b/i.test(text)) return "tech";
  if (/\b(?:documentary|historic|history|educational)\b/i.test(text)) return "documentary";
  if (/\b(?:social|vibrant|fun|energetic|trendy|tiktok|reels?|instagram|shorts)\b/i.test(text)) return "social";
  if (/\b(?:minimal|minimalist|clean|calm|peaceful)\b/i.test(text)) return "minimalist";
  return null;
}

/**
 * Classifies user prompt into "generation", "editing", or "ambiguous".
 *
 * Evaluation order:
 * 1. Explicit generation intent (new video creation requests & detailed video briefs)
 * 2. Ambiguous requests (short topic-only queries lacking actions)
 * 3. Existing project editing intent (timeline modifications)
 * 4. Fallbacks
 *
 * @param {string} prompt - Raw user input
 * @param {object} [_projectSummary] - Active project context (clips, duration, etc.)
 * @returns {object} { type, confidence, params, clarification, reason }
 */
export function classifyUserIntent(prompt, _projectSummary = null, conversationContext = {}) {
  const text = String(prompt || "").trim();
  if (!text) {
    return { type: "editing", confidence: 0 };
  }

  // Check for explicit undo/redo requests (e.g. "undo the last edit", "please undo", "undo that", "revert last change")
  const isSelectiveUndo =
    /\b(?:undo|revert)\s+(?:that|last|the\s+change|this)\s*,?\s*but\s+keep\b/i.test(text) ||
    /\b(?:undo|revert)\s+(?:just|only)\s+(?:the\s+)?[\w\s-]+\b/i.test(text) ||
    /\b(?:undo|revert)\s+(?:the\s+)?(?:color|speed|filter|transition|volume|caption)\s*(?:change|edit)?\s*(?:only|just)?\b/i.test(text);
  if (isSelectiveUndo) {
    return {
      type: "unsupported_selective_undo",
      confidence: 1.0,
      message: "The timeline project history operates as a chronological sequence of edits. Selective undo of one earlier property while retaining subsequent changes is not supported in this chronological stack. You can either perform a full Undo to revert the last edit, or ask to adjust a specific property directly (e.g. 'change the font to X').",
      reason: "Selective undo is not supported by the timeline history engine.",
    };
  }

  const isUndo = /^(?:(?:can\s+you\s+|could\s+you\s+)?(?:please\s+)?(?:undo|revert)(?:\s+(?:the|my|that|this))?(?:\s+last)?(?:\s+(?:edit|action|change|step|one))?)$/i.test(text);
  if (isUndo) {
    return {
      type: "undo",
      confidence: 1.0,
      isHistoryCommand: true,
      historyAction: "undo",
      reason: "Matched explicit undo request.",
    };
  }
  const isRedo = /^(?:(?:can\s+you\s+|could\s+you\s+)?(?:please\s+)?(?:redo)(?:\s+(?:the|my|that|this))?(?:\s+last)?(?:\s+(?:edit|action|change|step|one))?)$/i.test(text);
  if (isRedo) {
    return {
      type: "redo",
      confidence: 1.0,
      isHistoryCommand: true,
      historyAction: "redo",
      reason: "Matched explicit redo request.",
    };
  }

  // Incremental follow-up: "a bit more", "a little more", "even more"
  const isIncrementalFollowup = /^(?:a\s+bit\s+more|a\s+little\s+more|even\s+more|more|a\s+bit\s+less|a\s+little\s+less|further)\.?$/i.test(text);
  if (isIncrementalFollowup) {
    return {
      type: "editing",
      isFollowUp: true,
      followUpType: "incremental",
      direction: /less/i.test(text) ? "decrease" : "increase",
      confidence: 1.0,
      reason: "Follow-up request adjusting previous operation further.",
    };
  }

  // Apply to all clips follow-up: "apply that to the rest too", "apply the same treatment to all clips"
  const isScopeAllFollowup = /\b(?:apply\s+(?:that|the\s+same(?:\s+treatment)?)\s+to\s+(?:the\s+rest|all(?:\s+clips)?|everything)|same\s+for\s+(?:all|the\s+rest))\b/i.test(text);
  if (isScopeAllFollowup) {
    return {
      type: "editing",
      isFollowUp: true,
      followUpType: "apply_to_all",
      confidence: 1.0,
      reason: "Follow-up request applying previous operation across all clips.",
    };
  }

  // Adjacent clip follow-up: "no, not that one. the clip after it", "the clip before it"
  const isAdjacentClipFollowup = /\b(?:the\s+clip\s+after\s+(?:it|that|this)|next\s+clip|the\s+clip\s+before\s+(?:it|that|this)|previous\s+clip)\b/i.test(text);
  if (isAdjacentClipFollowup) {
    return {
      type: "editing",
      isFollowUp: true,
      followUpType: "adjacent_clip",
      direction: /\bafter|next\b/i.test(text) ? "next" : "previous",
      confidence: 1.0,
      reason: "Follow-up targeting adjacent clip on timeline.",
    };
  }

  // Ambiguous Cinematic Look Request: "make it look cinematic", "give this a cinematic look"
  const isAmbiguousCinematic =
    /\b(?:make\s+(?:it|this|video|clip)?\s*(?:look\s+)?cinematic|give\s+(?:this|it)?\s*(?:a\s+)?cinematic\s+look)\b/i.test(text) &&
    !/\b(?:filter|effect|style|preset)\s*(?:to\s+|as\s+)?([a-z0-9_-]+)/i.test(text);

  if (isAmbiguousCinematic) {
    const options = [
      { id: "effect-cinematic", name: "Warm Cinematic", label: "Warm Cinematic (Rich contrast & golden warmth)", filterId: "effect-cinematic", action: "select_filter" },
      { id: "effect-noir", name: "Noir Film", label: "Noir Film (Dramatic monochrome black & white)", filterId: "effect-noir", action: "select_filter" },
      { id: "effect-dream", name: "Dreamy Cinematic", label: "Dreamy Cinematic (Soft glow & atmospheric tones)", filterId: "effect-dream", action: "select_filter" },
      { id: "film", name: "Classic Film", label: "Classic Film (Vintage celluloid analog aesthetic)", filterId: "film", action: "select_filter" },
    ];
    return {
      type: "ambiguous",
      ambiguityType: "cinematic_treatment",
      category: "filter",
      options,
      hasMore: false,
      clarification: {
        message: "Which cinematic treatment would you like to apply?",
        options,
        hasMore: false,
      },
      confidence: 0.95,
      reason: "Multiple cinematic treatments are possible: prompting user for clarification.",
    };
  }

  // Ambiguous Playback Speed Scope clarification: "make this faster", "speed up", without clip or all
  const visualsListForSpeed = _projectSummary?.visualClips || _projectSummary?.visuals || [];
  const isSpeedAmbiguous =
    /\b(?:make\s+(?:it|this|video|clip)?\s*(?:a\s+little\s+|a\s+bit\s+)?(?:faster|slower)|speed\s*up|slow\s*down|change\s+speed)\b/i.test(text) &&
    !/\b(?:all|whole|entire|every)\b/i.test(text) &&
    !/\b(?:first|second|third|fourth|fifth|last|\d+(?:st|nd|rd|th)?|clip\s*[-#]?\s*\d+)\b/i.test(text) &&
    visualsListForSpeed.length > 1 &&
    !_projectSummary?.selectedClipId;

  if (isSpeedAmbiguous) {
    const options = [
      { id: "scope_all", label: "Speed up whole video (all clips)", name: "Whole video (all clips)", action: "select_speed_scope", scope: "all" },
      ...visualsListForSpeed.map((c, i) => ({
        id: c.id || `clip-${i + 1}`,
        label: `Clip ${i + 1}${c.name ? ` (${c.name})` : ""}`,
        name: `Clip ${i + 1}`,
        action: "select_clip",
        clipId: c.id,
      })),
    ];
    return {
      type: "ambiguous",
      ambiguityType: "playback_speed_scope",
      category: "scope",
      options,
      hasMore: false,
      clarification: {
        message: "Would you like to change playback speed for the entire video (all clips) or a specific clip?",
        options,
        hasMore: false,
      },
      confidence: 0.95,
      reason: "Ambiguous playback speed target: multiple clips present on timeline and none selected.",
    };
  }

  // Contextual Ordinal Selection (e.g. "the third one", "option 2", "3")
  const ordinalMatch = text.match(/^(?:the\s+)?(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|6th|seventh|7th|eighth|8th|ninth|9th|tenth|10th|[1-9]|10)(?:\s+(?:one|option|choice|style|font|effect))?$/i);
  if (ordinalMatch && conversationContext?.activeClarification?.lastShownOptions?.length) {
    const rawOrdinal = ordinalMatch[1].toLowerCase();
    const ORDINAL_MAP = {
      first: 0, "1st": 0, "1": 0,
      second: 1, "2nd": 1, "2": 1,
      third: 2, "3rd": 2, "3": 2,
      fourth: 3, "4th": 3, "4": 3,
      fifth: 4, "5th": 4, "5": 4,
      sixth: 5, "6th": 5, "6": 5,
      seventh: 6, "7th": 6, "7": 6,
      eighth: 7, "8th": 7, "8": 7,
      ninth: 8, "9th": 8, "9": 8,
      tenth: 9, "10th": 9, "10": 9,
    };
    const idx = ORDINAL_MAP[rawOrdinal];
    const options = conversationContext.activeClarification.lastShownOptions;
    if (idx !== undefined && idx >= 0 && idx < options.length) {
      const selectedOption = options[idx];
      return {
        type: "option_selected",
        category: conversationContext.activeClarification.category,
        selectedOption,
        confidence: 1.0,
        reason: `Selected option ${idx + 1}: ${selectedOption.name || selectedOption.label || selectedOption.id}`,
      };
    }
  }

  // Active-word highlight color command (must precede generic karaoke enable/disable toggle)
  if (isActiveWordColorCommand(text)) {
    const color = extractActiveWordColor(text);
    if (color) {
      return {
        type: "editing",
        actionType: "caption.set_style",
        isActiveWordColor: true,
        color,
        confidence: 1.0,
        reason: `Change active word highlight color to ${color}.`,
      };
    }
    // Ambiguous / unresolved color: prompt user for clarification rather than guessing
    const options = [
      { id: "red", name: "Red", label: "Red", color: "#FF0000", action: "select_color" },
      { id: "blue", name: "Blue", label: "Blue", color: "#0000FF", action: "select_color" },
      { id: "green", name: "Green", label: "Green", color: "#00FF00", action: "select_color" },
      { id: "yellow", name: "Yellow", label: "Yellow", color: "#FFFF00", action: "select_color" },
    ];
    return {
      type: "ambiguous",
      ambiguityType: "active_word_color",
      category: "color",
      options,
      hasMore: false,
      clarification: {
        message: "Which color would you like for the active word highlight? (e.g., Red, Blue, Green, Yellow, or a hex color like #FF0000)",
        options,
        hasMore: false,
      },
      confidence: 0.95,
      reason: "Unresolved color for active word highlight; asking user for clarification.",
    };
  }

  // Karaoke / Active-Word Highlighting (explicit editing request - never neon!)
  const isKaraoke =
    /\b(?:karaoke|active[- ]word|word[- ]by[- ]word|highlight\s+(?:the\s+)?current\s+word)\b/i.test(text);
  if (isKaraoke) {
    const isDisable = /\b(?:turn\s+off|disable|stop|deactivate|remove|off)\b/i.test(text);
    return {
      type: "editing",
      actionType: "caption.set_style",
      isKaraoke: true,
      enable: !isDisable,
      confidence: 1.0,
      reason: isDisable ? "Disable karaoke highlighting." : "Enable karaoke highlighting.",
    };
  }

  // Punch-in / Smart Zoom inspection queries ("Show me where you added punch-ins", "Where are the punch-ins?")
  const isPunchInInspection = /\b(?:show\s+(?:me\s+)?(?:where\s+you\s+added\s+punch[- ]ins|where\s+are\s+the\s+punch[- ]ins|the\s+punch[- ]ins)|where\s+(?:did\s+you\s+add\s+zooms?|are\s+the\s+zooms?|are\s+the\s+punch[- ]ins)|list\s+(?:all\s+)?punch[- ]ins?|inspect\s+punch[- ]ins?)\b/i.test(text);
  if (isPunchInInspection) {
    return {
      type: "smart_zoom_inspection",
      intent: "smart_zoom_inspection",
      confidence: 1.0,
      reason: "Inspect active punch-ins on timeline.",
    };
  }

  // More Options ("show more styles", "show more fonts", "show more")
  const isMoreStyles = /\b(?:show\s+)?more\s+styles?\b/i.test(text);
  const isMoreFonts = /\b(?:show\s+)?more\s+fonts?\b/i.test(text);
  const isGenericShowMore = /^(?:show\s+more|more(?:\s+options)?|next(?:\s+options)?)$/i.test(text);

  if (isMoreStyles || (isGenericShowMore && conversationContext?.activeClarification?.category === "style")) {
    const currentOffset = (conversationContext?.activeClarification?.category === "style" ? conversationContext.activeClarification.offset || 0 : 0) + 5;
    const result = getAvailableCaptionStyles(currentOffset, 5);
    const options = result.items.map((s) => ({ id: s.id, label: s.name, name: s.name, action: "select_style", style: s.style }));
    return {
      type: "more_options",
      category: "style",
      offset: currentOffset,
      options,
      hasMore: result.hasMore,
      clarification: {
        message: options.length > 0
          ? "Here are additional available caption styles:"
          : "No more styles available. Here are the first options again:",
        options: options.length > 0 ? options : getAvailableCaptionStyles(0, 5).items.map((s) => ({ id: s.id, label: s.name, name: s.name, action: "select_style", style: s.style })),
        hasMore: result.hasMore,
      },
      confidence: 1.0,
      reason: "Requested more caption styles.",
    };
  }

  if (isMoreFonts || (isGenericShowMore && conversationContext?.activeClarification?.category === "font")) {
    const currentOffset = (conversationContext?.activeClarification?.category === "font" ? conversationContext.activeClarification.offset || 0 : 0) + 5;
    const result = getAvailableCaptionFontChoices("en", currentOffset, 5);
    const options = result.items.map((f) => ({ id: f.id, label: f.name, name: f.name, action: "select_font", fontId: f.id }));
    return {
      type: "more_options",
      category: "font",
      offset: currentOffset,
      options,
      hasMore: result.hasMore,
      clarification: {
        message: options.length > 0
          ? "Here are additional available fonts:"
          : "No more fonts available. Here are the first options again:",
        options: options.length > 0 ? options : getAvailableCaptionFontChoices("en", 0, 5).items.map((f) => ({ id: f.id, label: f.name, name: f.name, action: "select_font", fontId: f.id })),
        hasMore: result.hasMore,
      },
      confidence: 1.0,
      reason: "Requested more caption fonts.",
    };
  }

  // Exploration requests: "Show me the available caption styles", "Show me available fonts"
  const isStyleExploration =
    /\b(?:show|list|display|what(?:\s+are)?|view)?\s*(?:all\s+)?(?:the\s+)?(?:available\s+)?caption\s+styles?\b/i.test(text) &&
    !/\b(?:change|set|apply|make|switch|to)\b/i.test(text);

  if (isStyleExploration) {
    const result = getAvailableCaptionStyles(0, 5);
    const options = result.items.map((s) => ({ id: s.id, label: s.name, name: s.name, action: "select_style", style: s.style }));
    return {
      type: "exploration",
      category: "style",
      offset: 0,
      options,
      hasMore: result.hasMore,
      clarification: {
        message: "Here are the available caption styles:",
        options,
        hasMore: result.hasMore,
      },
      confidence: 1.0,
      reason: "Exploration request for available caption styles.",
    };
  }

  const isFontExploration =
    /\b(?:show|list|display|what(?:\s+are)?|view)?\s*(?:all\s+)?(?:the\s+)?(?:available\s+)?(?:caption\s+)?fonts?\b/i.test(text) &&
    !/\b(?:change|set|apply|make|switch|to)\b/i.test(text);

  if (isFontExploration) {
    const result = getAvailableCaptionFontChoices("en", 0, 5);
    const options = result.items.map((f) => ({ id: f.id, label: f.name, name: f.name, action: "select_font", fontId: f.id }));
    return {
      type: "exploration",
      category: "font",
      offset: 0,
      options,
      hasMore: result.hasMore,
      clarification: {
        message: "Here are the available caption fonts:",
        options,
        hasMore: result.hasMore,
      },
      confidence: 1.0,
      reason: "Exploration request for available caption fonts.",
    };
  }

  // Explicit Caption Effect Requests: "Apply the neon effect", "Set caption effect to normal", "Apply neon caption effect"
  const explicitEffectMatch =
    text.match(/\b(?:apply|set|make|use|change\s+to)?\s*(?:the\s+)?(?:caption\s+)?effect\s*(?:to\s+|as\s+)?(normal|neon)\b/i) ||
    text.match(/\b(?:apply|set|make|use|change\s+to)?\s*(?:the\s+)?(normal|neon)\s+(?:caption\s+)?effect\b/i) ||
    text.match(/\b(normal|neon)\s+(?:caption\s+)?effect\b/i);

  if (explicitEffectMatch) {
    const effect = explicitEffectMatch[1].toLowerCase();
    return {
      type: "editing",
      actionType: "caption.set_style",
      isEffect: true,
      effect,
      confidence: 1.0,
      reason: `Apply ${effect === "neon" ? "Neon" : "Normal"} caption effect.`,
    };
  }

  // Remove / disable caption effect: "Remove the caption effect but keep the current font and colors", "Remove caption effect"
  const isRemoveCaptionEffect = /\b(?:remove|disable|turn\s+off|clear|without)\s+(?:the\s+)?(?:current\s+)?caption\s+effect\b/i.test(text);
  if (isRemoveCaptionEffect) {
    return {
      type: "editing",
      actionType: "caption.set_style",
      isEffect: true,
      effect: "normal",
      confidence: 1.0,
      reason: "Remove caption effect (set to Normal), preserving font, colors, and other styling.",
    };
  }

  // Ambiguous Caption Effect Request: "I want change caption effect", "change caption effect"
  const isAmbiguousEffect =
    /\b(?:change|switch|update|pick|choose|set|want\s+to\s+change|want\s+change)\s+(?:the\s+)?(?:caption\s+)?effect\b/i.test(text) &&
    !/\b(neon|normal)\b/i.test(text);

  if (isAmbiguousEffect) {
    const options = [
      { id: "normal", name: "Normal", label: "Normal", effect: "normal", action: "select_effect" },
      { id: "neon", name: "Neon", label: "Neon", effect: "neon", action: "select_effect" },
    ];
    return {
      type: "ambiguous",
      ambiguityType: "caption_effect",
      category: "effect",
      offset: 0,
      options,
      hasMore: false,
      clarification: {
        message: "Which caption effect would you like?",
        options,
        hasMore: false,
      },
      confidence: 0.95,
      reason: "Ambiguous caption effect request: prompting user to choose between Normal and Neon effects.",
    };
  }

  // Unsupported Caption Effect Request (e.g. "change caption effect to fire")
  const unsupportedEffectMatch = text.match(/\b(?:change|set|switch|apply|use)\s+(?:the\s+)?(?:caption\s+)?effect\s*(?:to\s+|as\s+)?([a-zA-Z0-9\s-]+)\b/i);
  if (unsupportedEffectMatch && !isAmbiguousEffect) {
    const requested = unsupportedEffectMatch[1].trim().toLowerCase();
    if (!["normal", "neon"].includes(requested) && !/^(?:larger|smaller|default|the|a|an)$/i.test(requested)) {
      const options = [
        { id: "normal", name: "Normal", label: "Normal", effect: "normal", action: "select_effect" },
        { id: "neon", name: "Neon", label: "Neon", effect: "neon", action: "select_effect" },
      ];
      return {
        type: "unsupported_effect",
        category: "effect",
        requestedEffect: requested,
        options,
        hasMore: false,
        clarification: {
          message: `The caption effect "${requested}" is not supported. Supported effects are Normal and Neon. Which would you like?`,
          options,
          hasMore: false,
        },
        confidence: 0.95,
        reason: `Requested effect "${requested}" is not supported.`,
      };
    }
  }

  // Ambiguous Caption Style Request: "Change the caption style."
  const isAmbiguousStyle =
    /\b(?:change|switch|update|pick|choose)\s+(?:the\s+)?caption\s+style\b/i.test(text) &&
    !/\b(neon|classic|bold|karaoke|minimal|social|plain|outline|translucent)\b/i.test(text);

  if (isAmbiguousStyle) {
    const result = getAvailableCaptionStyles(0, 5);
    const options = result.items.map((s) => ({ id: s.id, label: s.name, name: s.name, action: "select_style", style: s.style }));
    return {
      type: "ambiguous",
      ambiguityType: "caption_style",
      category: "style",
      offset: 0,
      options,
      hasMore: result.hasMore,
      clarification: {
        message: "Which caption style would you like?",
        options,
        hasMore: result.hasMore,
      },
      confidence: 0.95,
      reason: "Ambiguous caption style request: prompting user to choose from supported presets.",
    };
  }

  // Unsupported Font Request (e.g. "change caption font to Comic Sans")
  const unsupportedFontMatch = text.match(/\b(?:change|set|switch|use)?\s*(?:the\s+)?(?:captions?|subtitles?)?\s*font(?:\s+family)?\s*(?:to\s+|as\s+)([a-zA-Z0-9\s-]+)\b/i);
  if (unsupportedFontMatch) {
    const requested = unsupportedFontMatch[1].trim();
    if (!findCaptionFontInCatalog(requested) && !/^(?:larger|smaller|default|current|the)$/i.test(requested)) {
      const result = getAvailableCaptionFontChoices("en", 0, 5);
      const options = result.items.map((f) => ({ id: f.id, label: f.name, name: f.name, action: "select_font", fontId: f.id }));
      return {
        type: "unsupported_font",
        category: "font",
        requestedFont: requested,
        options,
        hasMore: result.hasMore,
        clarification: {
          message: `The font "${requested}" is not available. Which of our supported fonts would you like?`,
          options,
          hasMore: result.hasMore,
        },
        confidence: 0.95,
        reason: `Requested font "${requested}" does not exist in font catalog.`,
      };
    }
  }

  // Ambiguous Caption Font Request: "Change the caption font." / "Change the font."
  const isAmbiguousFont =
    /\b(?:change|switch|update|pick|choose)\s+(?:the\s+)?(?:caption\s+)?font\b/i.test(text) &&
    !/\b(?:to|as)\b/i.test(text) &&
    !findCaptionFontInCatalog(text.replace(/\b(?:change|switch|update|pick|choose|the|caption|font|to|as)\b/gi, "").trim());

  if (isAmbiguousFont) {
    const result = getAvailableCaptionFontChoices("en", 0, 5);
    const options = result.items.map((f) => ({ id: f.id, label: f.name, name: f.name, action: "select_font", fontId: f.id }));
    return {
      type: "ambiguous",
      ambiguityType: "caption_font",
      category: "font",
      offset: 0,
      options,
      hasMore: result.hasMore,
      clarification: {
        message: "Which font would you like?",
        options,
        hasMore: result.hasMore,
      },
      confidence: 0.95,
      reason: "Ambiguous font request: prompting user to choose from supported font registry.",
    };
  }

  // Unsupported Style Request (e.g. "apply gothic cyberpunk caption style")
  const hasSupportedStyleWord = /\b(?:neon|classic|bold|karaoke|minimal|social|plain|outline|translucent)\b/i.test(text);
  if (!hasSupportedStyleWord) {
    const unsupportedStyleMatch =
      text.match(/\b(?:apply|use)\s+(?:the\s+)?([a-zA-Z0-9\s-]+?)\s+(?:caption\s+)?style\b/i) ||
      text.match(/\b(?:set|change|switch)\s+(?:the\s+)?caption\s+style\s+(?:to|as)\s+([a-zA-Z0-9\s-]+?)(?:\s+(?:and|on|for|at|\.|\?|$)|$)/i);
    if (unsupportedStyleMatch) {
      const requested = unsupportedStyleMatch[1].trim();
      if (!findCaptionStylePreset(requested) && !/\b(?:larger|smaller|current|default)\b/i.test(requested)) {
        const result = getAvailableCaptionStyles(0, 5);
        const options = result.items.map((s) => ({ id: s.id, label: s.name, name: s.name, action: "select_style", style: s.style }));
        return {
          type: "unsupported_style",
          category: "style",
          requestedStyle: requested,
          options,
          hasMore: result.hasMore,
          clarification: {
            message: `The caption style "${requested}" is not supported. Which of our available styles would you like?`,
            options,
            hasMore: result.hasMore,
          },
          confidence: 0.95,
          reason: `Requested style "${requested}" does not exist in project presets.`,
        };
      }
    }
  }

  // Check if prompt specifically targets the current project/timeline (e.g., "in this project", "my current video")
  const hasExistingProjectTarget = EXISTING_PROJECT_INDICATORS.some((pat) => pat.test(text));

  // Determine if the timeline is empty (0 visual clips and 0 duration)
  const visualsCount = _projectSummary
    ? (Array.isArray(_projectSummary.visualClips)
        ? _projectSummary.visualClips.length
        : Array.isArray(_projectSummary.visuals)
        ? _projectSummary.visuals.length
        : Number(_projectSummary.visualsCount) || 0)
    : null;
  const isTimelineEmpty = visualsCount === 0;

  // 1. Check for explicit generation signals FIRST
  // Any prompt explicitly asking to create/generate a brand-new video or supplying a detailed video brief
  const isGenerationMatch = EXPLICIT_GENERATION_PATTERNS.some((pat) => pat.test(text));
  const isEditingMatch = EDITING_OPERATIONS.some((pat) => pat.test(text));

  const isExplicitNewVideo =
    /\b(?:brand[- ]new|new|separate|another)\s+(?:video|reel|short|documentary|film|movie|project)\b/i.test(text) ||
    /\bfrom\s+scratch\b/i.test(text) ||
    /^(?:prompt\s*(?:to|->)\s*video|new\s+video|generate\s+video)\s*:/i.test(text) ||
    /(?:^|\n)\s*(?:scene\s+\d+|\[scene\s+\d+\]|storyboard:|scenes:)/i.test(text) ||
    /\b(?:video|reel|short|film|documentary)\s+about\b/i.test(text) ||
    /\bfor\s+(?:instagram(?:\s+reels?)?|youtube\s+shorts?|tiktok)\b/i.test(text);

  // If prompt explicitly directs new video creation:
  // Text-to-video generation has been retired. Explain the editor's capabilities without launching generator.
  if (isGenerationMatch && (!isEditingMatch || isExplicitNewVideo) && (!hasExistingProjectTarget || isTimelineEmpty)) {
    return {
      type: "unsupported_creation",
      confidence: 0.95,
      params: { prompt: text },
      message: "This AI Video Editor is designed for editing timeline media. Text-to-video generation has been retired. You can edit imported media using playback speed, trimming, splitting, visual filters, color grading, captions, audio ducking, transitions, and export formatting.",
      reason: "Brand-new video creation from text prompt is retired in this editor.",
    };
  }

  // 2. Check for ambiguous patterns before general editing fallback
  const isAmbiguousMatch = AMBIGUOUS_PATTERNS.some((pat) => pat.test(text));
  if (isAmbiguousMatch && !isEditingMatch && (!hasExistingProjectTarget || isTimelineEmpty)) {
    return {
      type: "ambiguous",
      confidence: 0.85,
      clarification: {
        message: "How would you like to edit your video project? Choose a timeline operation below or describe your edit:",
        options: [
          {
            id: "opt_captions",
            label: "Add or Style Captions",
            action: "caption_edit",
            icon: "ClosedCaptioning",
          },
          {
            id: "opt_ratio",
            label: "Change Aspect Ratio (9:16, 16:9, 1:1)",
            action: "ratio_edit",
            icon: "Crop",
          },
          {
            id: "opt_speed",
            label: "Adjust Playback Speed",
            action: "speed_edit",
            icon: "Sliders",
          },
          {
            id: "opt_filter",
            label: "Apply Cinematic Filter / Color Grade",
            action: "filter_edit",
            icon: "Sparkle",
          },
        ],
      },
      reason: "Matched ambiguous video request phrase.",
    };
  }

  // 3. Check for editing operations
  if (isEditingMatch) {
    const isBroadDestructive = /\b(?:delete|clear|remove|wipe)\s+(?:all|everything|the\s+entire|the\s+whole)\s*(?:timeline|clips?|tracks?|project)?\b/i.test(text);

    const isGenericClipAction = /\b(?:delete|trim|split|slice|cut|duplicate|speed\s*up|slow\s*down)\s+(?:the|this|that)?\s*(?:clip|segment|video)\b/i.test(text);
    const mentionsSpecificClip = /\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+(?:st|nd|rd|th)?|last|clip\s*[-#]?\s*\d+|segment\s*[-#]?\s*\d+)\b/i.test(text);
    const visualsList = _projectSummary?.visualClips || _projectSummary?.visuals || [];

    if (isGenericClipAction && !mentionsSpecificClip && visualsList.length > 1 && !_projectSummary?.selectedClipId) {
      return {
        type: "ambiguous",
        ambiguityType: "clip_target",
        confidence: 0.9,
        candidateClips: visualsList.map((c, i) => ({
          id: c.id || `clip-${i + 1}`,
          index: i,
          name: c.name || `Clip ${i + 1}`,
          duration: c.duration,
        })),
        clarification: {
          message: "Multiple clips exist on your timeline. Which clip would you like to edit? Please select a clip below or specify by number (e.g., Clip 1, Clip 2, or last clip):",
          options: visualsList.map((c, i) => ({
            id: c.id || `clip-${i + 1}`,
            label: `Clip ${i + 1}${c.name ? ` (${c.name})` : ""}`,
            action: "select_clip",
            clipId: c.id,
          })),
        },
        reason: "Ambiguous clip target: multiple clips present on timeline and none specified.",
      };
    }

    return {
      type: "editing",
      confidence: 0.95,
      ...(isBroadDestructive ? { requiresConfirmation: true, destructive: true, isBroadDestructive: true } : {}),
      reason: isBroadDestructive
        ? "Destructive action: requires explicit confirmation."
        : "Matched explicit timeline/project editing operation pattern.",
    };
  }

  // 4. Secondary generation fallback:
  // If the prompt mentions creation verb combined with video noun, or on an empty timeline asks to create something
  if (
    (/\b(?:create|generate|make|produce|build|direct)\b/i.test(text) &&
      /\b(?:video|reel|short|documentary|clip|story|promo|montage|film|movie)\b/i.test(text) &&
      (!hasExistingProjectTarget || isTimelineEmpty || !isEditingMatch)) ||
    (isTimelineEmpty && /\b(?:create|generate|make|produce|build)\b/i.test(text) && !isEditingMatch)
  ) {
    return {
      type: "unsupported_creation",
      confidence: 0.85,
      params: { prompt: text },
      message: "This AI Video Editor is designed for editing timeline media. Text-to-video generation has been retired. You can edit imported media using playback speed, trimming, splitting, visual filters, color grading, captions, audio ducking, transitions, and export formatting.",
      reason: "Creation verb and video entity without project-edit target.",
    };
  }

  // Default to standard project editing
  return {
    type: "editing",
    confidence: 0.7,
    reason: "Defaulting to standard assistant project editing.",
  };
}
