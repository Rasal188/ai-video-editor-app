/**
 * @file shortsOverlays.js
 * AI Shorts Studio — Dynamic Visual B-Roll & Contextual Overlay Insertion.
 *
 * Implements Phase 2 Priority 6:
 * 1. Monologue & Narrative Opportunity Detection:
 *    - Identifies pacing fatigue during extended monologues (>5s without visual cut).
 *    - Aligns with narrative arc stages (Setup Hook, Core Insight, Climax).
 *    - Strictly preserves narrative payoff punchlines (safeguards ending from clutter).
 * 2. Salient Keyword Callout Synthesis:
 *    - Extracts high-impact metrics, acronyms, and key concepts from speech.
 *    - Generates standalone, responsive vector SVG callout badges.
 * 3. Asset Availability & Semantic Relevance Scoring:
 *    - Evaluates available project/user assets with tokenized relevance scoring.
 *    - Discards irrelevant assets (<0.25 threshold) to prevent hallucinated b-roll.
 *    - Emits structured asset requests and falls back to clean keyword callouts or raw footage.
 * 4. Face & Caption Avoidance Layout Composition:
 *    - Avoids lower-third portrait caption safe zone (bottom 30%).
 *    - Dynamically offsets PiP / supporting visuals opposite tracked face position (cropX).
 *    - Supports full-frame cutaway B-roll for descriptive conceptual explanations.
 * 5. Bounded Timing & Cadence Control:
 *    - Enforces duration bounds (1.5s – 4.5s), safe lead-in and tail-out padding.
 *    - Prevents straddling scene cuts.
 *    - Suppresses excessive frequency (>4s spacing) and overlapping overlays.
 * 6. Rendering Parity & Backward Compatibility:
 *    - Generates standardized visualOverlaySegments compatible with timeline, WebCodecs, and FFmpeg.
 *    - Fully non-destructive and backward-compatible when overlays are disabled.
 */

import { makeId } from "./timeline.js";

export const DEFAULT_SHORTS_OVERLAY_OPTIONS = Object.freeze({
  enabled: true,
  minDuration: 1.5,
  maxDuration: 4.5,
  defaultDuration: 3.0,
  minMonologueGap: 5.0, // Seconds of speech without visual cut before considering monologue break
  minSpacing: 4.0, // Minimum spacing between consecutive overlay events
  maxOverlaysPerClip: 3, // Upper bound for standard short (adaptive to duration)
  leadInPadding: 0.8, // Buffer from start of clip before first overlay
  tailOutPadding: 1.5, // Buffer before end of clip to preserve narrative payoff
  preferCalloutOnHook: true,
  preferBrollOnInsight: true,
  preferCalloutOnClimax: true,
  suppressNearSceneCuts: 0.3,
  faceAvoidance: true,
  captionAvoidance: true,
  fallbackMode: "callout", // "callout" | "none"
  relevanceThreshold: 0.25,
});

const STOP_WORDS = new Set([
  "a", "about", "above", "after", "again", "against", "all", "am", "an", "and", "any", "are",
  "aren't", "as", "at", "be", "because", "been", "before", "being", "below", "between", "both",
  "but", "by", "can", "can't", "cannot", "could", "couldn't", "did", "didn't", "do", "does",
  "doesn't", "doing", "don't", "down", "during", "each", "few", "for", "from", "further", "had",
  "hadn't", "has", "hasn't", "have", "haven't", "having", "he", "he'd", "he'll", "he's", "her",
  "here", "here's", "hers", "herself", "him", "himself", "his", "how", "how's", "i", "i'd",
  "i'll", "i'm", "i've", "if", "in", "into", "is", "isn't", "it", "it's", "its", "itself",
  "let's", "me", "more", "most", "mustn't", "my", "myself", "no", "nor", "not", "of", "off",
  "on", "once", "only", "or", "other", "ought", "our", "ours", "ourselves", "out", "over", "own",
  "same", "shan't", "she", "she'd", "she'll", "she's", "should", "shouldn't", "so", "some", "such",
  "than", "that", "that's", "the", "their", "theirs", "them", "themselves", "then", "there", "there's",
  "these", "they", "they'd", "they'll", "they're", "they've", "this", "those", "through", "to", "too",
  "under", "until", "up", "very", "was", "wasn't", "we", "we'd", "we'll", "we're", "we've", "were",
  "weren't", "what", "what's", "when", "when's", "where", "where's", "which", "while", "who", "who's",
  "whom", "why", "why's", "with", "won't", "would", "wouldn't", "you", "you'd", "you'll", "you're",
  "you've", "your", "yours", "yourself", "yourselves", "actually", "basically", "literally", "like",
  "just", "really", "going", "know", "think", "see", "well", "also", "even", "much", "many", "look",
]);

/**
 * Extracts salient keywords, statistics, acronyms, and concept entities from text.
 *
 * @param {string} text - Input sentence or thought
 * @returns {{ keywords: string[], metrics: string[], acronyms: string[], primaryLabel: string }}
 */
export function extractSalientKeywords(text = "") {
  if (typeof text !== "string" || !text.trim()) {
    return { keywords: [], metrics: [], acronyms: [], primaryLabel: "" };
  }

  const clean = text.replace(/["'’]/g, "").trim();

  // 1. Detect metrics, statistics, percentages, and numerical claims (e.g. 10x, 50%, 100ms, #1)
  const metricMatches = clean.match(/(?:\b\d+(?:\.\d+)?(?:x|%|ms|s|k|m|b|fps)?|\b#\d+)(?=[^a-z0-9]|$)/gi) || [];
  const metrics = [...new Set(metricMatches.map((m) => m.toUpperCase()))];

  // 2. Detect uppercase acronyms or technical concepts (e.g. DNS, API, AI, URL, HTTP, SSL, CPU, GPU)
  const acronymMatches = clean.match(/\b[A-Z]{2,6}\b/g) || [];
  const acronyms = [...new Set(acronymMatches.filter((w) => !STOP_WORDS.has(w.toLowerCase())))];

  // 3. Extract content nouns and verbs
  const rawTokens = clean
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  const keywords = [...new Set(rawTokens)];

  // 4. Synthesize a concise, high-visibility callout label (2-4 words)
  let primaryLabel = "";
  if (metrics.length > 0 && keywords.length > 0) {
    primaryLabel = `${metrics[0]} ${keywords[0].toUpperCase()}`;
  } else if (acronyms.length > 0) {
    const contextWord = keywords.find((k) => k.toUpperCase() !== acronyms[0]) || "";
    primaryLabel = contextWord ? `${acronyms[0]} ${contextWord.toUpperCase()}` : acronyms[0];
  } else if (keywords.length >= 2) {
    primaryLabel = `${keywords[0].toUpperCase()} ${keywords[1].toUpperCase()}`;
  } else if (keywords.length === 1) {
    primaryLabel = keywords[0].toUpperCase();
  } else {
    primaryLabel = "KEY POINT";
  }

  return {
    keywords,
    metrics,
    acronyms,
    primaryLabel: primaryLabel.slice(0, 24).trim(),
  };
}

/**
 * Scores relevance between an available asset and a target query or keyword set.
 *
 * @param {object} asset - Media asset ({ id, name, tags, description, ... })
 * @param {string[]|string} queryOrKeywords - Target keywords or query string
 * @returns {number} Normalized relevance score in [0, 1]
 */
export function scoreAssetRelevance(asset, queryOrKeywords) {
  if (!asset || typeof asset !== "object") return 0;

  const targetTokens = Array.isArray(queryOrKeywords)
    ? queryOrKeywords.map((k) => String(k).toLowerCase().trim()).filter(Boolean)
    : String(queryOrKeywords || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  if (targetTokens.length === 0) return 0;

  const assetName = String(asset.name || asset.id || "").toLowerCase();
  const assetTags = Array.isArray(asset.tags)
    ? asset.tags.map((t) => String(t).toLowerCase())
    : [];
  const assetDesc = String(asset.description || "").toLowerCase();

  let matches = 0;
  for (const token of targetTokens) {
    // Exact match in tags
    if (assetTags.includes(token)) {
      matches += 1.0;
    } else if (assetName.includes(token)) {
      matches += 0.8;
    } else if (assetTags.some((tag) => tag.includes(token))) {
      matches += 0.5;
    } else if (assetDesc.includes(token)) {
      matches += 0.4;
    }
  }

  const score = matches / Math.max(1, targetTokens.length);
  return Math.min(1, Number(score.toFixed(3)));
}

/**
 * Generates an SVG data URL for a modern, high-contrast keyword callout card.
 * Works seamlessly offline in browser, Node, and canvas rendering.
 *
 * @param {object} params
 * @param {string} params.text - Primary callout text
 * @param {string} [params.headline=""] - Optional eyebrow/headline (e.g. "KEY TAKEAWAY")
 * @param {object} [params.style={}] - Styling overrides
 * @returns {string} data:image/svg+xml data URL
 */
export function generateCalloutSvgDataUrl({ text = "KEY POINT", headline = "", style = {} } = {}) {
  const width = Math.max(300, Math.min(800, Number(style.width) || 480));
  const height = Math.max(100, Math.min(400, Number(style.height) || 160));
  const primaryColor = style.primaryColor || "#38bdf8"; // Sky-400
  const bgColor = style.bgColor || "rgba(15, 23, 42, 0.92)"; // Slate-900 glass
  const textColor = style.textColor || "#ffffff";
  const headlineColor = style.headlineColor || "#94a3b8"; // Slate-400

  const safeHeadline = String(headline || "").replace(/[<>&"']/g, "").toUpperCase();
  const safeText = String(text || "KEY POINT").replace(/[<>&"']/g, "");

  const hasHeadline = Boolean(safeHeadline);
  const textY = hasHeadline ? 104 : 94;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="calloutBorderGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${primaryColor}" stop-opacity="0.85"/>
      <stop offset="100%" stop-color="#818cf8" stop-opacity="0.4"/>
    </linearGradient>
    <filter id="cardGlow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="8" stdDeviation="16" flood-color="#000000" flood-opacity="0.55"/>
    </filter>
  </defs>
  <rect x="8" y="8" width="${width - 16}" height="${height - 16}" rx="20" fill="${bgColor}" stroke="url(#calloutBorderGrad)" stroke-width="2.5" filter="url(#cardGlow)"/>
  ${hasHeadline ? `<text x="${width / 2}" y="52" fill="${headlineColor}" font-family="system-ui, -apple-system, sans-serif" font-size="16" font-weight="700" letter-spacing="2" text-anchor="middle">${safeHeadline}</text>` : ""}
  <text x="${width / 2}" y="${textY}" fill="${textColor}" font-family="system-ui, -apple-system, sans-serif" font-size="28" font-weight="800" text-anchor="middle">${safeText}</text>
</svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * Resolves safe visual placement for an overlay to avoid covering portrait captions or speaker faces.
 *
 * @param {object} params
 * @param {string} params.kind - "callout" | "broll" | "supporting-visual"
 * @param {number} [params.cropX=0.5] - Tracked face or subject horizontal position (0..1)
 * @param {object} [params.faceBox=null] - Optional normalized face bounding box { x, y, width, height }
 * @param {string} [params.targetRatio="9:16"] - Target aspect ratio
 * @returns {object} Transform object { x, y, scale, rotation, opacity, placementPreset }
 */
export function resolveOverlayPlacement({
  kind = "callout",
  cropX = 0.5,
  faceBox = null,
  targetRatio = "9:16",
  presentation = "auto",
} = {}) {
  // 1. Full-bleed B-roll (covers talking head, sits beneath captions)
  if (kind === "broll" && (presentation === "full" || presentation === "auto")) {
    return {
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
      opacity: 1,
      placementPreset: "full",
      safeZone: "full-frame",
    };
  }

  // 2. Keyword Callouts: Always place in upper third (y: -30 to -34) to cleanly avoid
  // captions situated in the lower third (y: 20 to 40)
  if (kind === "callout") {
    // If face is high up in the center, shift slightly or keep top-center
    const faceY = faceBox ? faceBox.y + faceBox.height / 2 : 0.45;
    const yPos = faceY < 0.35 ? -38 : -30;

    return {
      x: 0,
      y: yPos,
      scale: targetRatio === "9:16" ? 0.88 : 0.75,
      rotation: 0,
      opacity: 1,
      placementPreset: "top-center",
      safeZone: "upper-third",
    };
  }

  // 3. Supporting Visual / PiP: Position on opposite side of tracked face
  // Face biased to the right (cropX > 0.55) -> place PiP on left
  // Face biased to the left (cropX < 0.45) -> place PiP on right
  const faceRight = cropX > 0.55;
  const targetX = faceRight ? -28 : 28;
  const targetY = -24; // Upper quadrant, well clear of bottom captions

  return {
    x: targetX,
    y: targetY,
    scale: targetRatio === "9:16" ? 0.36 : 0.32,
    rotation: 0,
    opacity: 1,
    placementPreset: faceRight ? "top-left" : "top-right",
    safeZone: faceRight ? "left-quadrant" : "right-quadrant",
  };
}

/**
 * Detects suitable moments for contextual overlays within a candidate short clip.
 *
 * @param {object} params
 * @param {object} params.candidate - Candidate short window ({ startTime, endTime, duration, cropX })
 * @param {Array} [params.sentences=[]] - Transcribed sentences
 * @param {Array} [params.sceneCuts=[]] - Detected scene cut timestamps
 * @param {Array} [params.faceDetections=[]] - Detected faces
 * @param {object} [params.acousticFeatures=null] - Audio energy / vocal intensity metadata
 * @param {object} [params.options={}] - Configuration options
 * @returns {Array} Array of candidate overlay opportunity descriptors
 */
export function detectOverlayOpportunities({
  candidate,
  sentences = [],
  sceneCuts = [],
  faceDetections = [],
  acousticFeatures = null,
  options = {},
} = {}) {
  if (!candidate || !Number.isFinite(Number(candidate.startTime))) {
    return [];
  }

  const opts = { ...DEFAULT_SHORTS_OVERLAY_OPTIONS, ...options };
  const cStart = Math.max(0, Number(candidate.startTime) || 0);
  const rawEnd = Number(candidate.endTime);
  const cEnd = Number.isFinite(rawEnd) && rawEnd > cStart ? rawEnd : cStart + (Number(candidate.duration) || 15);
  const cDuration = Math.max(1, cEnd - cStart);

  // If candidate is too short to safely place any overlay with padding
  if (cDuration < (opts.leadInPadding + opts.tailOutPadding + opts.minDuration)) {
    return [];
  }

  const earliestAllowed = cStart + opts.leadInPadding;
  const latestAllowed = cEnd - opts.tailOutPadding;

  // Filter sentences falling within this candidate's window
  const activeSentences = (Array.isArray(sentences) ? sentences : [])
    .filter((s) => s && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > cStart && s.start < cEnd)
    .sort((a, b) => a.start - b.start);

  // If no transcript sentences exist in this candidate, do not generate speech-dependent overlays
  if (activeSentences.length === 0) {
    return [];
  }

  const activeCuts = (Array.isArray(sceneCuts) ? sceneCuts : [])
    .filter((t) => Number.isFinite(t) && t > cStart && t < cEnd)
    .sort((a, b) => a - b);

  const opportunities = [];

  // ---------------------------------------------------------------------------
  // 1. Setup / Opening Hook Opportunity
  // ---------------------------------------------------------------------------
  if (opts.preferCalloutOnHook && activeSentences.length > 0) {
    const firstSentence = activeSentences[0];
    const isHookEligible = firstSentence.isQuestion || firstSentence.narrativeStage === "setup" || !firstSentence.narrativeStage;
    const sStart = Math.max(earliestAllowed, firstSentence.start);
    const sEnd = Math.min(latestAllowed, Math.max(sStart + opts.minDuration, firstSentence.end));

    if (isHookEligible && sEnd > sStart && (sEnd - sStart) >= opts.minDuration) {
      const { keywords, primaryLabel } = extractSalientKeywords(firstSentence.text);
      if (keywords.length > 0 || firstSentence.isQuestion) {
        opportunities.push({
          id: `opp-hook-${makeId("ov")}`,
          kind: "callout",
          narrativeStage: "setup",
          targetTime: sStart,
          duration: Math.min(opts.maxDuration, Math.max(opts.minDuration, sEnd - sStart)),
          targetText: primaryLabel,
          headline: firstSentence.isQuestion ? "CORE QUESTION" : "KEY TAKEAWAY",
          sentence: firstSentence,
          keywords,
          score: 88,
          reason: "Reinforce opening hook question or topic thesis with keyword callout badge",
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Extended Monologue Visual Break Opportunity
  // ---------------------------------------------------------------------------
  // Check intervals between scene cuts for continuous speaking stretches > minMonologueGap
  const boundaryPoints = [cStart, ...activeCuts, cEnd];
  for (let i = 0; i < boundaryPoints.length - 1; i++) {
    const segStart = boundaryPoints[i];
    const segEnd = boundaryPoints[i + 1];
    const segDur = segEnd - segStart;

    if (segDur >= opts.minMonologueGap) {
      // Find middle window of this monologue stretch
      const midPoint = segStart + segDur * 0.45;
      const targetStart = Math.max(earliestAllowed, midPoint - opts.defaultDuration / 2);
      const targetEnd = Math.min(latestAllowed, segEnd - opts.suppressNearSceneCuts, targetStart + opts.defaultDuration);

      if (targetEnd - targetStart >= opts.minDuration) {
        // Find sentence overlapping this window
        const matchingSentence = activeSentences.find(
          (s) => s.end > targetStart && s.start < targetEnd
        );

        const { keywords, primaryLabel } = extractSalientKeywords(matchingSentence?.text || "");

        opportunities.push({
          id: `opp-mono-${makeId("ov")}`,
          kind: "broll", // Prefers visual B-roll or supporting illustration to break monologue
          narrativeStage: matchingSentence?.narrativeStage || "monologue-break",
          targetTime: targetStart,
          duration: Number((targetEnd - targetStart).toFixed(2)),
          targetText: primaryLabel,
          headline: "INSIGHT",
          sentence: matchingSentence,
          keywords,
          score: 75,
          reason: `Pacing break during extended ${segDur.toFixed(1)}s monologue stretch`,
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Core Insight / Turning Point Opportunity
  // ---------------------------------------------------------------------------
  if (opts.preferBrollOnInsight) {
    const insightSentences = activeSentences.filter(
      (s) => s.narrativeStage === "turning-point" || s.narrativeStage === "climax"
    );

    for (const s of insightSentences) {
      const sStart = Math.max(earliestAllowed, s.start);
      const sEnd = Math.min(latestAllowed, s.end);

      // CRITICAL: Narrative Payoff Safeguard:
      // NEVER allow an overlay to cut into the final payoff sentence or tail-out window!
      if (s.narrativeStage === "payoff" || s.narrativeStage === "resolution") {
        continue;
      }

      if (sEnd > sStart && (sEnd - sStart) >= opts.minDuration) {
        const { keywords, primaryLabel } = extractSalientKeywords(s.text);
        if (keywords.length > 0) {
          opportunities.push({
            id: `opp-insight-${makeId("ov")}`,
            kind: "broll",
            narrativeStage: s.narrativeStage,
            targetTime: sStart,
            duration: Math.min(opts.maxDuration, Math.max(opts.minDuration, sEnd - sStart)),
            targetText: primaryLabel,
            headline: s.narrativeStage === "climax" ? "TURNING POINT" : "CORE PRINCIPLE",
            sentence: s,
            keywords,
            score: s.narrativeStage === "climax" ? 85 : 80,
            reason: `Visual illustration for ${s.narrativeStage} explanation`,
          });
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Acoustic Vocal Intensity Surge Alignment
  // ---------------------------------------------------------------------------
  if (opts.preferCalloutOnClimax && acousticFeatures?.surges?.length) {
    for (const surge of acousticFeatures.surges) {
      if (surge.time >= earliestAllowed && surge.time <= (latestAllowed - opts.minDuration)) {
        const matchingSentence = activeSentences.find(
          (s) => s.end > surge.time && s.start <= surge.time
        );

        // Safeguard payoff
        if (matchingSentence?.narrativeStage === "payoff" || matchingSentence?.narrativeStage === "resolution") {
          continue;
        }

        const { keywords, primaryLabel } = extractSalientKeywords(matchingSentence?.text || "");
        opportunities.push({
          id: `opp-surge-${makeId("ov")}`,
          kind: "callout",
          narrativeStage: "climax",
          targetTime: surge.time,
          duration: Math.min(opts.maxDuration, Math.max(opts.minDuration, opts.defaultDuration)),
          targetText: primaryLabel,
          headline: "KEY EMPHASIS",
          sentence: matchingSentence,
          keywords,
          score: 82,
          reason: "Reinforce vocal intensity surge with prominent emphasis badge",
        });
      }
    }
  }

  return opportunities;
}

/**
 * Plans and resolves concrete visual overlay segments for an AI Shorts candidate.
 *
 * @param {object} params
 * @param {object} params.candidate - Candidate short window ({ startTime, endTime, duration, cropX })
 * @param {Array} [params.sentences=[]] - Transcribed sentences
 * @param {Array} [params.availableAssets=[]] - Project/user media assets for B-roll selection
 * @param {Array} [params.sceneCuts=[]] - Scene cut timestamps
 * @param {Array} [params.faceDetections=[]] - Face detections
 * @param {object} [params.acousticFeatures=null] - Acoustic features
 * @param {object} [params.options={}] - Custom configuration
 * @returns {{ ok: boolean, overlays: Array, assetRequests: Array, stats: object }}
 */
export function planShortOverlays({
  candidate,
  sentences = [],
  availableAssets = [],
  sceneCuts = [],
  faceDetections = [],
  acousticFeatures = null,
  options = {},
} = {}) {
  const opts = { ...DEFAULT_SHORTS_OVERLAY_OPTIONS, ...options };

  // 1. Backward-compatible disabled check
  if (opts.enabled === false) {
    return {
      ok: true,
      overlays: [],
      assetRequests: [],
      stats: { totalPlanned: 0, brollCount: 0, calloutCount: 0, reason: "Overlays disabled" },
    };
  }

  // 2. Validate candidate
  if (!candidate || !Number.isFinite(Number(candidate.startTime))) {
    return {
      ok: false,
      overlays: [],
      assetRequests: [],
      stats: { totalPlanned: 0, error: "Invalid candidate definition" },
    };
  }

  const cStart = Math.max(0, Number(candidate.startTime) || 0);
  const rawEnd = Number(candidate.endTime);
  const cEnd = Number.isFinite(rawEnd) && rawEnd > cStart ? rawEnd : cStart + (Number(candidate.duration) || 15);
  const cDuration = Math.max(1, cEnd - cStart);
  const cropX = Number.isFinite(candidate.cropX) ? candidate.cropX : 0.5;

  // 3. Detect raw opportunities
  const rawOpportunities = detectOverlayOpportunities({
    candidate,
    sentences,
    sceneCuts,
    faceDetections,
    acousticFeatures,
    options: opts,
  });

  if (rawOpportunities.length === 0) {
    return {
      ok: true,
      overlays: [],
      assetRequests: [],
      stats: { totalPlanned: 0, brollCount: 0, calloutCount: 0, reason: "No suitable moments identified" },
    };
  }

  // 4. Sort opportunities by priority score
  const sortedOpportunities = [...rawOpportunities].sort((a, b) => (b.score || 0) - (a.score || 0));

  // Determine maximum overlay capacity adaptive to clip duration (e.g. 1 per ~10-12s)
  const maxAllowed = Math.max(1, Math.min(opts.maxOverlaysPerClip, Math.floor(cDuration / 9)));

  const plannedOverlays = [];
  const assetRequests = [];
  const occupiedRanges = []; // [{ start, end }]

  const cuts = (Array.isArray(sceneCuts) ? sceneCuts : []).filter((t) => t > cStart && t < cEnd);

  for (const opp of sortedOpportunities) {
    if (plannedOverlays.length >= maxAllowed) break;

    let targetStart = opp.targetTime;
    let targetEnd = targetStart + opp.duration;

    // A. Enforce boundary clamping
    targetStart = Math.max(cStart + opts.leadInPadding, targetStart);
    targetEnd = Math.min(cEnd - opts.tailOutPadding, targetEnd);

    // B. Enforce duration bounds
    let finalDur = targetEnd - targetStart;
    if (finalDur < opts.minDuration) {
      continue;
    }
    if (finalDur > opts.maxDuration) {
      finalDur = opts.maxDuration;
      targetEnd = targetStart + finalDur;
    }

    // C. Scene-cut collision safeguard:
    // If a scene cut falls within the overlay window, clamp before the cut
    const collidingCut = cuts.find((c) => c > targetStart + 0.2 && c < targetEnd);
    if (collidingCut) {
      targetEnd = Math.max(targetStart + opts.minDuration, collidingCut - opts.suppressNearSceneCuts);
      finalDur = targetEnd - targetStart;
      if (finalDur < opts.minDuration) {
        continue;
      }
    }

    // D. Spacing & Overlap Suppression:
    // Ensure at least minSpacing (e.g. 4.0s) between overlay events
    const collidesWithExisting = occupiedRanges.some(
      (range) =>
        Math.max(range.start - opts.minSpacing, cStart) < targetEnd &&
        Math.min(range.end + opts.minSpacing, cEnd) > targetStart
    );
    if (collidesWithExisting) {
      continue;
    }

    // E. Asset Matching or Keyword Callout Fallback
    let chosenAsset = null;
    let highestRelevance = 0;

    if (opp.kind === "broll" && Array.isArray(availableAssets) && availableAssets.length > 0) {
      for (const asset of availableAssets) {
        const rel = scoreAssetRelevance(asset, opp.keywords);
        if (rel > highestRelevance) {
          highestRelevance = rel;
          chosenAsset = asset;
        }
      }
    }

    let finalKind = opp.kind;
    let overlaySrc = "";
    let assetId = "";
    let overlayType = "image";

    if (chosenAsset && highestRelevance >= opts.relevanceThreshold) {
      // Verified asset match found
      finalKind = "broll";
      overlaySrc = chosenAsset.src || chosenAsset.path || "";
      assetId = chosenAsset.id;
      overlayType = chosenAsset.type === "video" ? "video" : "image";
    } else {
      // No suitable asset found: Emit asset request descriptor and fallback
      assetRequests.push({
        id: `req-${makeId("req")}`,
        query: opp.targetText || (opp.keywords || []).slice(0, 3).join(" "),
        narrativeStage: opp.narrativeStage,
        targetTime: Number(targetStart.toFixed(3)),
        duration: Number(finalDur.toFixed(3)),
        needed: true,
        reason: opp.reason,
      });

      if (opts.fallbackMode === "callout") {
        finalKind = "callout";
        overlayType = "image";
        overlaySrc = generateCalloutSvgDataUrl({
          text: opp.targetText || "KEY POINT",
          headline: opp.headline || "INSIGHT",
        });
      } else {
        // Fallback mode "none": retain original footage without overlay
        continue;
      }
    }

    // F. Layout & Positioning Composition
    const transform = resolveOverlayPlacement({
      kind: finalKind,
      cropX,
      targetRatio: options.aspectRatio || candidate.aspectRatio || "9:16",
    });

    // Re-anchor timestamps relative to candidate start (0-based for timeline)
    const relStart = Number((targetStart - cStart).toFixed(3));
    const relDuration = Number(finalDur.toFixed(3));

    const overlaySegment = {
      id: `ov-${makeId("ov")}`,
      assetId,
      name: finalKind === "broll" ? (chosenAsset?.name || "B-Roll Cutaway") : `Callout: ${opp.targetText}`,
      kind: finalKind,
      type: overlayType,
      src: overlaySrc,
      path: chosenAsset?.path || (overlaySrc.startsWith("data:") ? "" : overlaySrc),
      start: relStart, // 0-anchored relative to candidate short
      duration: relDuration,
      layer: 2, // Layer 2 sits cleanly above background video (layer 1) and beneath captions (layer 3)
      baseTransform: {
        x: transform.x,
        y: transform.y,
        scale: transform.scale,
        rotation: transform.rotation,
        opacity: transform.opacity,
      },
      placementPreset: transform.placementPreset,
      safeZone: transform.safeZone,
      narrativeStage: opp.narrativeStage,
      reason: opp.reason,
      absoluteStart: Number(targetStart.toFixed(3)),
      absoluteEnd: Number(targetEnd.toFixed(3)),
    };

    plannedOverlays.push(overlaySegment);
    occupiedRanges.push({ start: targetStart, end: targetEnd });
  }

  // Sort overlays chronologically by start time
  plannedOverlays.sort((a, b) => a.start - b.start);

  return {
    ok: true,
    overlays: plannedOverlays,
    assetRequests,
    stats: {
      totalPlanned: plannedOverlays.length,
      brollCount: plannedOverlays.filter((o) => o.kind === "broll").length,
      calloutCount: plannedOverlays.filter((o) => o.kind === "callout").length,
      assetRequestsCount: assetRequests.length,
    },
  };
}

/**
 * Attaches planned overlays directly onto a candidate highlight record.
 *
 * @param {object} candidate - Highlight candidate record
 * @param {Array} plannedOverlays - Result from planShortOverlays
 * @returns {object} Enriched candidate
 */
export function applyOverlaysToCandidate(candidate, plannedOverlays = []) {
  if (!candidate || typeof candidate !== "object") return candidate;
  return {
    ...candidate,
    overlays: Array.isArray(plannedOverlays) ? plannedOverlays : [],
    hasOverlays: Array.isArray(plannedOverlays) && plannedOverlays.length > 0,
  };
}
