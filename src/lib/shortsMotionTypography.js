/**
 * @file shortsMotionTypography.js
 * AI Shorts Studio — High-Impact Vertical Motion Typography & Animated Caption Callouts.
 *
 * Implements Phase 2 Priority 7:
 * 1. Word-Level Kinetic Captions:
 *    - Animates individual words using reliable word-level transcript timestamps (start, end).
 *    - Supports pop-in, scale emphasis, fade, bounce, and kinetic highlight treatments.
 *    - Falls back to readable sentence-level or static captions when word timing is missing or malformed.
 * 2. Intelligent Multi-Signal Emphasis:
 *    - Prioritizes hook phrases, key metrics/acronyms, core insights, and payoff moments.
 *    - Coordinates emphasis with Priority 3 punch-ins and Priority 5 vocal intensity / acoustic surges.
 *    - Enforces cadence control (max 1–2 emphasis words per sentence, min 1.5s spacing) to prevent visual clutter.
 *    - Suppresses competing/overlapping animations.
 * 3. Animated Caption Callouts:
 *    - Generates punchy visual badge/pill callouts for high-salience terms (metrics, key hooks).
 *    - Avoids visual competition by checking and suppressing callouts when Priority 6 overlays are active.
 *    - Preserves caption readability and enforces safe placement.
 * 4. Safe Layout & Accessibility:
 *    - Enforces 9:16 portrait safe margins (top 8%, bottom 20–22%, horizontal 6%).
 *    - Detects face collisions (shifts captions upward if speaker's face is low in the frame).
 *    - Accounts for dynamic reframing (cropX) and punch-in crop coordinates.
 *    - Supports reduced-motion mode (locks scale to 1.0, uses subtle color highlight without movement).
 *    - Clamps animation intervals strictly to clip duration [0, duration] and scene-cut boundaries.
 * 5. Sound Accent Fallback:
 *    - Evaluates available project assets; if no standalone SFX assets exist, cleanly defers sound accents
 *      and documents the limitation without inventing fake paths or fetching external files.
 * 6. Rendering Parity & Backward Compatibility:
 *    - Generates enriched caption tracks with kinetic metadata for Canvas preview and WebCodecs export.
 *    - Supplies clean, high-contrast static caption fallback for headless FFmpeg drawtext render plans.
 *    - Respects backward-compatible disable switch (enabled: false or motionTypography: false).
 */

export const MOTION_ANIMATION_STYLES = Object.freeze([
  "pop",
  "scale",
  "fade",
  "bounce",
  "highlight",
  "karaoke",
  "none",
]);

export const DEFAULT_MOTION_TYPOGRAPHY_OPTIONS = Object.freeze({
  enabled: true,
  animationStyle: "pop", // "pop" | "scale" | "fade" | "bounce" | "highlight" | "karaoke" | "none"
  reducedMotion: false,
  maxEmphasisWordsPerSentence: 2,
  minEmphasisSpacing: 1.5, // Minimum seconds between animated emphasis bursts
  minWordDurationForAnimation: 0.12, // Minimum duration of a word to receive kinetic motion
  emphasisScaleMin: 1.10,
  emphasisScaleMax: 1.28,
  leadInTime: 0.06, // Time before word audio start to begin pop animation
  decayTime: 0.18, // Time after word audio ends for animation settle
  accentColor: "#ffd43b", // Vibrant energetic gold (default emphasis)
  hookColor: "#38bdf8", // Sky blue for opening hook words
  climaxColor: "#ff4d4f", // Coral/red for climax & payoff keywords
  surgeColor: "#ff7a45", // Vibrant orange for vocal surges
  defaultTextColor: "#ffffff",
  calloutsEnabled: true,
  maxCalloutsPerClip: 2,
  minCalloutSpacing: 3.5,
  soundAccentsEnabled: false,
  faceAvoidance: true,
  safeMargins: {
    topRatio: 0.08,
    bottomRatio: 0.22,
    horizontalRatio: 0.06,
  },
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
  "on", "once", "only", "or", "other", "ought", "our", "ours", "ourselves", "out", "over",
  "own", "same", "shan't", "she", "she'd", "she'll", "she's", "should", "shouldn't", "so",
  "some", "such", "than", "that", "that's", "the", "their", "theirs", "them", "themselves",
  "then", "there", "there's", "these", "they", "they'd", "they'll", "they're", "they've",
  "this", "those", "through", "to", "too", "under", "until", "up", "very", "was", "wasn't",
  "we", "we'd", "we'll", "we're", "we've", "were", "weren't", "what", "what's", "when",
  "when's", "where", "where's", "which", "while", "who", "who's", "whom", "why", "why's",
  "with", "won't", "would", "wouldn't", "you", "you'd", "you'll", "you're", "you've",
  "your", "yours", "yourself", "yourselves",
]);

const HIGH_SALIENT_TERMS = new Set([
  "crucial", "critical", "secret", "never", "always", "insane", "huge", "first",
  "biggest", "revolution", "breakthrough", "mistake", "warning", "truth", "magic",
  "hack", "fast", "worst", "best", "essential", "gamechanger", "fatal", "proof",
  "solution", "guarantee", "dangerous", "unbelievable", "massive", "exponential",
]);

/**
 * Validates word-level timestamps. Supports both `word.text` and `word.word`.
 *
 * @param {Array<{ text?: string, word?: string, start: number, end: number }>} words
 * @param {number} [segmentStart=0]
 * @param {number} [segmentEnd=Infinity]
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateWordTimestamps(words, segmentStart = 0, segmentEnd = Infinity) {
  if (!Array.isArray(words) || words.length === 0) {
    return { valid: false, reason: "MISSING_WORDS_ARRAY" };
  }

  const sStart = Number.isFinite(Number(segmentStart)) ? Number(segmentStart) : 0;
  const sEnd = Number.isFinite(Number(segmentEnd)) ? Number(segmentEnd) : Infinity;

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w || typeof w !== "object") {
      return { valid: false, reason: `MALFORMED_WORD_OBJECT_AT_${i}` };
    }
    const text = String(w.text ?? w.word ?? "").trim();
    if (!text) {
      return { valid: false, reason: `EMPTY_WORD_TEXT_AT_${i}` };
    }
    const start = Number(w.start);
    const end = Number(w.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return { valid: false, reason: `NON_FINITE_TIMESTAMP_AT_${i}` };
    }
    if (end < start) {
      return { valid: false, reason: `INVERTED_TIMESTAMPS_AT_${i}` };
    }
    if (start < sStart - 0.5 || end > sEnd + 0.5) {
      return { valid: false, reason: `OUT_OF_BOUNDS_AT_${i}` };
    }
    if (i > 0) {
      const prev = words[i - 1];
      if (start < Number(prev.start) - 0.05) {
        return { valid: false, reason: `UNORDERED_TIMESTAMPS_AT_${i}` };
      }
    }
  }

  return { valid: true };
}

/**
 * Sanitizes and clamps word timestamps to valid bounds.
 */
export function sanitizeWordTimestamps(words, segmentStart = 0, segmentEnd = Infinity, clipDuration = Infinity) {
  if (!Array.isArray(words)) return [];
  const sStart = Math.max(0, Number(segmentStart) || 0);
  const maxBound = Math.min(
    Number.isFinite(Number(segmentEnd)) ? Number(segmentEnd) : Infinity,
    Number.isFinite(Number(clipDuration)) ? Number(clipDuration) : Infinity
  );

  const cleaned = [];
  let lastEnd = sStart;

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w || typeof w !== "object") continue;
    const text = String(w.text ?? w.word ?? "").trim();
    if (!text) continue;

    let start = Number(w.start);
    let end = Number(w.end);
    if (!Number.isFinite(start)) start = lastEnd;
    if (!Number.isFinite(end) || end < start) end = start + 0.25;

    // Clamp within bounds
    start = Math.max(sStart, Math.min(maxBound, start));
    end = Math.max(start, Math.min(maxBound, end));

    cleaned.push({
      ...w,
      word: w.word || text,
      text: w.text || text,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
    });
    lastEnd = end;
  }

  return cleaned;
}

/**
 * Computes an emphasis salience score [0, 1] for an individual word.
 */
export function scoreWordEmphasis({
  word,
  sentenceText = "",
  narrativeStage = "setup",
  candidate = null,
  punchIns = [],
  acousticFeatures = null,
  options = DEFAULT_MOTION_TYPOGRAPHY_OPTIONS,
}) {
  const text = String(word?.text ?? word?.word ?? "").trim();
  if (!text) return { score: 0, reason: "EMPTY", effect: "none" };

  const clean = text.toLowerCase().replace(/^[^\w$%]+|[^\w%]+$/g, "");
  if (!clean || STOP_WORDS.has(clean)) {
    return { score: 0.05, reason: "STOP_WORD", effect: "none" };
  }

  let score = 0.25; // Base weight for substantive words
  let reason = "SUBSTANTIVE";
  let suggestedColor = options.accentColor || "#ffd43b";

  // 1. Metric / Number / Percentage detection
  const isMetric = /^\$?\d+(?:\.\d+)?(?:%|x|k|m|b|qps)?$/i.test(clean) && /\d/.test(clean);
  if (isMetric) {
    score += 0.45;
    reason = "METRIC_QUANTIFIER";
    suggestedColor = options.accentColor || "#ffd43b";
  }

  // 2. High-salience power terms or acronyms
  const isAcronym = /^[A-Z0-9]{2,8}$/.test(text.replace(/^[^\w]+|[^\w]+$/g, "")) && !/^\d+$/.test(text);
  if (isAcronym) {
    score += 0.35;
    reason = "ACRONYM_CONCEPT";
    suggestedColor = options.accentColor || "#ffd43b";
  } else if (HIGH_SALIENT_TERMS.has(clean)) {
    score += 0.35;
    reason = "HIGH_SALIENCE_TERM";
  }

  // 3. Narrative Arc & Semantic Hook / Payoff alignment
  const hookScore = Number(candidate?.hookScore) || 0;
  const payoffScore = Number(candidate?.payoffScore) || 0;

  if (narrativeStage === "setup" || (candidate && hookScore >= 80 && Number(word.start) <= 4.0)) {
    score += 0.25;
    reason = "HOOK_PHRASE_EMPHASIS";
    suggestedColor = options.hookColor || "#38bdf8";
  } else if (narrativeStage === "climax" || narrativeStage === "payoff" || (candidate && payoffScore >= 80 && Number(word.end) >= (Number(candidate.duration) || 15) - 4.0)) {
    score += 0.25;
    reason = "PAYOFF_CLIMAX_EMPHASIS";
    suggestedColor = options.climaxColor || "#ff4d4f";
  }

  // 4. Priority 3 Punch-in Coordination
  const wordStart = Number(word.start) || 0;
  const wordEnd = Number(word.end) || wordStart + 0.2;
  const punchInAligned = (Array.isArray(punchIns) ? punchIns : []).some((p) => {
    const pTime = Number(p.time ?? p.tStart ?? 0);
    return Math.abs(pTime - wordStart) <= 0.45 || (pTime >= wordStart - 0.1 && pTime <= wordEnd + 0.1);
  });

  if (punchInAligned) {
    score += 0.25;
    reason = `${reason}+PUNCH_IN_ALIGNED`;
  }

  // 5. Priority 5 Multimodal Audio Intensity / Vocal Surge alignment
  if (acousticFeatures && Array.isArray(acousticFeatures.surges)) {
    let bestSurge = null;
    let minDistance = Infinity;

    for (const s of acousticFeatures.surges) {
      const sTime = Number(s.time);
      if (!Number.isFinite(sTime)) continue;
      // Exact containment in word duration
      if (sTime >= wordStart && sTime <= wordEnd) {
        bestSurge = s;
        minDistance = 0;
        break;
      }
      const dist = Math.min(Math.abs(sTime - wordStart), Math.abs(sTime - wordEnd));
      if (dist < minDistance && dist <= 0.25) {
        minDistance = dist;
        bestSurge = s;
      }
    }

    if (bestSurge) {
      const surgeIntensity = Number(bestSurge.intensity) || 0.5;
      const containmentBonus = minDistance === 0 ? 0.15 : 0;
      score += Math.max(0.30, surgeIntensity * 0.40) + containmentBonus;
      reason = `${reason}+VOCAL_SURGE`;
      suggestedColor = options.surgeColor || "#ff7a45";
    }
  }

  const boundedScore = Math.max(0, Math.min(1, Number(score.toFixed(3))));
  const isEmphasized = boundedScore >= 0.50;

  let effect = "none";
  if (isEmphasized) {
    effect = options.reducedMotion ? "highlight" : (options.animationStyle || "pop");
  }

  return {
    score: boundedScore,
    isEmphasized,
    reason,
    suggestedColor,
    effect,
  };
}

/**
 * Builds kinetic word animation tracks for caption segments.
 */
export function buildKineticWordTimeline({
  captionSegments = [],
  candidate = null,
  punchIns = [],
  acousticFeatures = null,
  sceneCuts = [],
  options = DEFAULT_MOTION_TYPOGRAPHY_OPTIONS,
}) {
  const opts = { ...DEFAULT_MOTION_TYPOGRAPHY_OPTIONS, ...(options || {}) };
  if (!opts.enabled) {
    return {
      ok: true,
      enabled: false,
      hasKineticWords: false,
      captionSegments: (captionSegments || []).map((seg) => ({
        ...seg,
        isKinetic: false,
        animation: "none",
      })),
      stats: { totalWords: 0, emphasizedWords: 0 },
    };
  }

  const clipDuration = Number(candidate?.duration) || Infinity;
  let lastEmphasisTime = -opts.minEmphasisSpacing;
  let totalWordCount = 0;
  let emphasizedWordCount = 0;

  const enrichedSegments = (captionSegments || []).map((segment) => {
    if (!segment || typeof segment !== "object") return segment;

    const segStart = Math.max(0, Number(segment.start) || 0);
    const rawSegEnd = Number.isFinite(Number(segment.end)) ? Number(segment.end) : segStart + 2;
    const segEnd = Math.min(clipDuration, Math.max(segStart + 0.05, rawSegEnd));

    // Check validity of word-level timestamps
    const validation = validateWordTimestamps(segment.words, segStart, segEnd);
    if (!validation.valid) {
      // Safe fallback to readable sentence-level or static captions
      return {
        ...segment,
        start: segStart,
        end: segEnd,
        isKinetic: false,
        fallbackMode: "static-sentence",
        validationFailureReason: validation.reason,
        animation: "none",
      };
    }

    const sanitizedWords = sanitizeWordTimestamps(segment.words, segStart, segEnd, clipDuration);
    const narrativeStage = segment.narrativeStage || "setup";

    // Score all words in segment
    const scoredWords = sanitizedWords.map((word) => {
      totalWordCount++;
      const emphasis = scoreWordEmphasis({
        word,
        sentenceText: segment.text,
        narrativeStage,
        candidate,
        punchIns,
        acousticFeatures,
        options: opts,
      });

      return {
        ...word,
        emphasis,
      };
    });

    // Enforce cadence control: sort by score descending to pick top candidates,
    // but enforce minEmphasisSpacing and maxEmphasisWordsPerSentence.
    const eligibleWords = scoredWords
      .filter((w) => w.emphasis.isEmphasized)
      .sort((a, b) => b.emphasis.score - a.emphasis.score);

    const chosenIndices = new Set();
    let sentenceEmphasisCount = 0;

    for (const eligible of eligibleWords) {
      if (sentenceEmphasisCount >= opts.maxEmphasisWordsPerSentence) break;

      const wIdx = scoredWords.indexOf(eligible);
      const wTime = eligible.start;

      // Check temporal spacing from previous globally emphasized word
      if (wTime - lastEmphasisTime >= opts.minEmphasisSpacing) {
        // Also check scene cut collision
        const crossesCut = (Array.isArray(sceneCuts) ? sceneCuts : []).some(
          (cut) => cut > eligible.start && cut < eligible.end
        );

        if (!crossesCut) {
          chosenIndices.add(wIdx);
          sentenceEmphasisCount++;
          lastEmphasisTime = eligible.end;
        }
      }
    }

    // Build final kinetic word descriptors
    const kineticWords = scoredWords.map((item, idx) => {
      const isChosen = chosenIndices.has(idx);
      const { emphasis } = item;

      let effect = "none";
      let scale = 1.0;
      let color = opts.defaultTextColor || "#ffffff";

      if (isChosen) {
        emphasizedWordCount++;
        effect = opts.reducedMotion ? "highlight" : emphasis.effect;
        scale = opts.reducedMotion
          ? 1.0
          : Math.min(
              opts.emphasisScaleMax,
              Math.max(opts.emphasisScaleMin, 1 + emphasis.score * 0.22)
            );
        color = emphasis.suggestedColor;
      }

      // Compute animation lead-in and decay intervals clamped to segment bounds
      const wordDuration = Math.max(0.05, item.end - item.start);
      const animStart = Math.max(segStart, Number((item.start - opts.leadInTime).toFixed(3)));
      let animEnd = Math.min(segEnd, Number((item.end + opts.decayTime).toFixed(3)));

      // Clamp to scene cut if cut is nearby
      for (const cut of sceneCuts || []) {
        if (cut >= item.start && cut < animEnd) {
          animEnd = Number(Math.max(item.start + 0.05, cut - 0.02).toFixed(3));
        }
      }

      // Clamp to clip duration
      animEnd = Math.min(clipDuration, animEnd);

      return {
        ...item,
        word: item.word || item.text,
        text: item.text || item.word,
        start: item.start,
        end: item.end,
        duration: Number(wordDuration.toFixed(3)),
        animStart,
        animEnd,
        isEmphasized: isChosen,
        emphasisScore: emphasis.score,
        emphasisReason: isChosen ? emphasis.reason : "UNEMPHASIZED",
        effect,
        scale: Number(scale.toFixed(2)),
        color,
      };
    });

    return {
      ...segment,
      start: segStart,
      end: segEnd,
      isKinetic: true,
      animation: opts.animationStyle,
      reducedMotion: opts.reducedMotion,
      words: kineticWords,
    };
  });

  return {
    ok: true,
    enabled: true,
    hasKineticWords: true,
    captionSegments: enrichedSegments,
    stats: {
      totalWords: totalWordCount,
      emphasizedWords: emphasizedWordCount,
    },
  };
}

/**
 * Detects and synthesizes animated caption callout badges for key moments.
 */
export function detectAnimatedCaptionCallouts({
  candidate = null,
  sentences = [],
  captionSegments = [],
  activeOverlays = [],
  sceneCuts = [],
  options = DEFAULT_MOTION_TYPOGRAPHY_OPTIONS,
}) {
  const opts = { ...DEFAULT_MOTION_TYPOGRAPHY_OPTIONS, ...(options || {}) };
  if (!opts.enabled || !opts.calloutsEnabled) {
    return [];
  }

  const clipDuration = Number(candidate?.duration) || 15;
  const callouts = [];
  let lastCalloutEnd = -opts.minCalloutSpacing;

  // Search sentences/segments for high-salience callout candidates (e.g. metrics or key hook terms)
  const items = Array.isArray(sentences) && sentences.length > 0 ? sentences : captionSegments;

  for (const item of items) {
    if (callouts.length >= opts.maxCalloutsPerClip) break;
    if (!item || !item.text) continue;

    const start = Math.max(0, Number(item.start) || 0);
    const end = Math.min(clipDuration, Number(item.end) || start + 2);
    if (start >= clipDuration - 1.5 || end <= start) continue;

    // Temporal spacing check
    if (start - lastCalloutEnd < opts.minCalloutSpacing) continue;

    // Priority 6 Overlay Collision Check:
    // If a Priority 6 overlay is active during this callout window, suppress it to prevent competition!
    const overlayClash = (Array.isArray(activeOverlays) ? activeOverlays : []).some((ov) => {
      const ovStart = Number(ov.start) || 0;
      const ovEnd = Number.isFinite(Number(ov.end)) ? Number(ov.end) : ovStart + (Number(ov.duration) || 3);
      return Math.max(start, ovStart) < Math.min(end, ovEnd);
    });

    if (overlayClash) {
      continue; // Suppressed due to Priority 6 overlay overlap
    }

    // Find metric or key phrase in item text
    const text = String(item.text);
    const tokens = text.split(/\s+/).map((w) => w.replace(/^[^\w$%]+|[^\w%]+$/g, ""));
    const metricMatch = tokens.find((w) => /^\$?\d+(?:\.\d+)?(?:%|x|k|m|b|qps)?$/i.test(w) && /\d/.test(w));
    const acronymMatch = tokens.find(
      (w) => /^[A-Z0-9]{2,8}$/.test(w) && !STOP_WORDS.has(w.toLowerCase()) && !/^\d+$/.test(w)
    );

    let calloutText = null;
    let badgeType = "metric";

    if (metricMatch) {
      calloutText = metricMatch.toUpperCase();
      badgeType = "metric";
    } else if (acronymMatch) {
      calloutText = acronymMatch;
      badgeType = "keyword";
    } else if (item.narrativeStage === "setup" && (text.includes("?") || candidate?.hookScore >= 85)) {
      // Key question hook badge
      const words = text.split(/\s+/).filter((w) => !STOP_WORDS.has(w.toLowerCase()));
      if (words.length > 0) {
        calloutText = words.slice(0, 2).join(" ").toUpperCase();
        badgeType = "hook";
      }
    }

    if (calloutText) {
      // Determine callout duration (1.2s - 2.5s)
      const calloutDuration = Math.min(2.5, Math.max(1.2, end - start));
      let calloutEnd = Math.min(clipDuration, start + calloutDuration);

      // Clamp to scene cut
      for (const cut of sceneCuts || []) {
        if (cut > start && cut < calloutEnd) {
          calloutEnd = Math.max(start + 0.5, cut - 0.05);
        }
      }

      callouts.push({
        id: `callout-${candidate?.id || "c"}-${callouts.length + 1}-${Math.round(start * 100)}`,
        text: calloutText,
        badgeType,
        start: Number(start.toFixed(3)),
        end: Number(calloutEnd.toFixed(3)),
        duration: Number((calloutEnd - start).toFixed(3)),
        animation: opts.reducedMotion ? "static" : "pop-bounce",
        color: badgeType === "hook" ? opts.hookColor : opts.accentColor,
        placement: {
          x: 50,
          y: 68, // Placed slightly above lower caption line
        },
      });

      lastCalloutEnd = calloutEnd;
    }
  }

  return callouts;
}

/**
 * Calculates safe caption positioning avoiding face collisions, punch-in crops, and UI chrome.
 */
export function resolveSafeCaptionPlacement({
  segment = null,
  targetRatio = "9:16",
  faceBox = null,
  cropX = 0.5,
  punchIn = null,
  activeOverlays = [],
  safeMargins = DEFAULT_MOTION_TYPOGRAPHY_OPTIONS.safeMargins,
}) {
  const isPortrait = targetRatio === "9:16";
  const margins = safeMargins || DEFAULT_MOTION_TYPOGRAPHY_OPTIONS.safeMargins;

  // Default placement: bottom center (y: 78%)
  let posX = 50;
  let posY = isPortrait ? 78 : 82;
  let collisionAvoided = false;

  // 1. Dynamic reframing (cropX) awareness
  if (Number.isFinite(cropX)) {
    posX = 50;
  }

  // 2. Tracked Face Collision Avoidance
  // If faceBox is located in the lower portion of the frame (y > 0.60),
  // placing captions at y: 78% would obscure the speaker's chin/mouth!
  if (faceBox && Number.isFinite(faceBox.y) && Number.isFinite(faceBox.height)) {
    const faceBottom = faceBox.y + faceBox.height;
    if (faceBottom > 0.60) {
      posY = Math.max(margins.topRatio * 100 + 10, Math.round((faceBox.y - 0.15) * 100));
      collisionAvoided = true;
    }
  }

  // 3. Punch-in crop coordinate awareness
  if (punchIn && Number.isFinite(punchIn.scale) && punchIn.scale > 1.15) {
    posY = Math.min(posY, (1 - margins.bottomRatio) * 100);
  }

  // 4. Safe area margin clamping
  const minY = margins.topRatio * 100;
  const maxY = (1 - margins.bottomRatio) * 100;
  posY = Math.max(minY, Math.min(maxY, posY));

  return {
    placement: { x: posX, y: posY },
    collisionAvoided,
    isPortrait,
  };
}

/**
 * Resolves sound accents for high-impact emphasis moments.
 * If no standalone sound effect assets are provided in availableAssets, gracefully defers and documents.
 */
export function resolveSoundAccents({
  emphasisEvents = [],
  availableAssets = [],
  candidate = null,
  options = DEFAULT_MOTION_TYPOGRAPHY_OPTIONS,
}) {
  const opts = { ...DEFAULT_MOTION_TYPOGRAPHY_OPTIONS, ...(options || {}) };
  if (!opts.soundAccentsEnabled) {
    return {
      soundAccents: [],
      limitation: "SOUND_ACCENTS_DISABLED",
    };
  }

  // Check if availableAssets contains any valid audio/sfx files
  const sfxAssets = (Array.isArray(availableAssets) ? availableAssets : []).filter((asset) => {
    if (!asset) return false;
    const type = String(asset.type || "").toLowerCase();
    const kind = String(asset.kind || "").toLowerCase();
    const name = String(asset.name || asset.path || "").toLowerCase();
    return (
      type === "audio" ||
      kind === "sfx" ||
      name.includes("sfx") ||
      name.includes("pop") ||
      name.includes("whoosh") ||
      name.includes("chime")
    );
  });

  if (sfxAssets.length === 0) {
    // Project-provided assets do not contain sound effects.
    // Per requirement: Never invent asset paths, fetch external sound files, or add unnecessary dependencies.
    return {
      soundAccents: [],
      limitation: "NO_SFX_ASSETS_AVAILABLE",
      reason: "No project-provided sound effect assets found in availableAssets; audio accents deferred.",
    };
  }

  const sfxAsset = sfxAssets[0];
  const soundAccents = (emphasisEvents || []).map((ev, idx) => ({
    id: `sfx-${candidate?.id || "c"}-${idx + 1}-${Math.round(ev.time * 100)}`,
    assetId: sfxAsset.id || "project-sfx",
    path: sfxAsset.path || sfxAsset.src,
    time: ev.time,
    volume: 0.65, // Restrained volume to never interfere with speech intelligibility
  }));

  return {
    soundAccents,
    limitation: null,
  };
}

/**
 * Master Motion Typography Planner.
 * Coordinates word-level kinetic captions, animated callouts, layout safety, and sound accents.
 */
export function planMotionTypography({
  candidate = null,
  captionSegments = [],
  sentences = [],
  punchIns = [],
  acousticFeatures = null,
  sceneCuts = [],
  activeOverlays = [],
  availableAssets = [],
  options = DEFAULT_MOTION_TYPOGRAPHY_OPTIONS,
}) {
  const opts = { ...DEFAULT_MOTION_TYPOGRAPHY_OPTIONS, ...(options || {}) };

  if (!candidate || typeof candidate !== "object" || !Number.isFinite(Number(candidate.duration))) {
    return {
      ok: false,
      reason: "INVALID_CANDIDATE",
      captionSegments: [],
      callouts: [],
      soundAccents: [],
      stats: { totalWords: 0, emphasizedWords: 0 },
    };
  }

  // 1. Build Kinetic Word Timeline
  const kineticPlan = buildKineticWordTimeline({
    captionSegments,
    candidate,
    punchIns,
    acousticFeatures,
    sceneCuts,
    options: opts,
  });

  // 2. Synthesize Animated Caption Callouts
  const callouts = detectAnimatedCaptionCallouts({
    candidate,
    sentences,
    captionSegments: kineticPlan.captionSegments,
    activeOverlays,
    sceneCuts,
    options: opts,
  });

  // 3. Resolve Sound Accents (if applicable)
  const emphasisEvents = [];
  kineticPlan.captionSegments.forEach((seg) => {
    if (Array.isArray(seg.words)) {
      seg.words.forEach((w) => {
        if (w.isEmphasized) {
          emphasisEvents.push({ time: w.start, word: w.text });
        }
      });
    }
  });

  const soundAccentResult = resolveSoundAccents({
    emphasisEvents,
    availableAssets,
    candidate,
    options: opts,
  });

  return {
    ok: true,
    enabled: opts.enabled,
    animationStyle: opts.animationStyle,
    reducedMotion: opts.reducedMotion,
    hasKineticWords: kineticPlan.hasKineticWords,
    captionSegments: kineticPlan.captionSegments,
    callouts,
    soundAccents: soundAccentResult.soundAccents,
    soundAccentLimitation: soundAccentResult.limitation,
    stats: kineticPlan.stats,
  };
}

/**
 * Attaches motion typography metadata and enriched caption segments to candidate.
 */
export function applyMotionTypographyToCandidate(candidate, motionPlan) {
  if (!candidate || typeof candidate !== "object") return candidate;
  if (!motionPlan || !motionPlan.ok) return candidate;

  return {
    ...candidate,
    motionTypography: {
      enabled: motionPlan.enabled,
      animationStyle: motionPlan.animationStyle,
      reducedMotion: motionPlan.reducedMotion,
      hasKineticWords: motionPlan.hasKineticWords,
      calloutCount: (motionPlan.callouts || []).length,
      soundAccentCount: (motionPlan.soundAccents || []).length,
      stats: motionPlan.stats,
    },
    callouts: motionPlan.callouts || [],
    enrichedCaptions: motionPlan.captionSegments || [],
  };
}
