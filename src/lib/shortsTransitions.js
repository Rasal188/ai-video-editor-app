/**
 * @file shortsTransitions.js
 * AI Shorts Studio — Automated B-Roll Synthesis & Smart Transition Polish.
 *
 * Implements Phase 2 Priority 9:
 * 1. Intelligent B-Roll Cutaway Planning:
 *    - Detects monologue pacing fatigue (>4.5s without visual cut).
 *    - Aligns cutaways with narrative arc transitions and meaningful speech pauses.
 *    - Strictly protects opening hook (0–1.5s) and concluding payoff punchlines.
 *    - Enforces cadence spacing (>=4.0s) and duration bounds (1.5s–4.5s).
 * 2. Asset Availability & Strict Relevance Scoring:
 *    - Evaluates project assets against contextual keywords using Priority 6 token scoring.
 *    - Rejects low-confidence or unrelated assets (<0.25 threshold).
 *    - Emits structured asset requests and preserves original footage when no assets qualify.
 *    - Never hallucinates asset paths or fabricates mock metadata.
 * 3. Intelligent Transition Polish:
 *    - Defaults to restrained clean cuts ("none") to maintain professional pacing.
 *    - Selectively plans context-aware transitions:
 *      * Short dissolve ("fade") for B-roll cutaways.
 *      * Directional whip-style wipe ("wipe-left") for narrative stage shifts.
 *      * Subtle zoom cut ("zoom") on breath/thought pauses.
 *      * Glitch/flash accent ("flash") on high vocal intensity surges.
 *    - Enforces reduced-motion mode (restricts effects to clean cuts or gentle dissolves).
 *    - Resolves collisions with Priority 3 punch-in zooms to avoid visual whiplash.
 *    - Clamps transitions within clip duration and scene-cut boundaries.
 * 4. Multi-Platform & Rendering Parity:
 *    - Fully compatible with 9:16, 1:1, 4:5, and 16:9 project structures.
 *    - Generates headless FFmpeg render plans via SUPPORTED_HEADLESS_TRANSITIONS (xfade).
 *    - Pure, immutable transformations preserving candidate and source clip integrity.
 */

import { makeId } from "./timeline.js";
import { extractSalientKeywords, scoreAssetRelevance } from "./shortsOverlays.js";
import { normalizeTargetRatio, getRepackagingRatioDefinition } from "./shortsRepackaging.js";

export const SUPPORTED_HEADLESS_TRANSITIONS = Object.freeze({
  fade: "fade",
  "wipe-left": "wipeleft",
  "wipe-up": "wipeup",
  split: "horzopen",
  zoom: "zoomin",
  flash: "fadewhite",
  blur: "hblur",
});

export const DEFAULT_SHORTS_TRANSITION_OPTIONS = Object.freeze({
  enabled: true,
  defaultTransition: "none",
  preferCleanCuts: true,
  maxTransitionsPerClip: 3,
  minTransitionSpacing: 3.5, // Minimum seconds between consecutive transitions
  defaultDuration: 0.35, // Default transition duration in seconds
  minDuration: 0.15,
  maxDuration: 0.6,
  reducedMotion: false,
  protectHook: true,
  hookGuardDuration: 1.5, // Seconds at beginning protected from transitions
  protectPayoff: true,
  payoffGuardDuration: 2.0, // Seconds at end protected from transitions
  minMonologueGap: 4.5, // Seconds of speech without visual cut before considering monologue break
  minBrollDuration: 1.5,
  maxBrollDuration: 4.5,
  defaultBrollDuration: 3.0,
  minBrollSpacing: 4.0,
  relevanceThreshold: 0.25,
  suppressNearSceneCuts: 0.3,
  allowGlitchAccents: true,
});

export const SHORTS_TRANSITION_TYPES = Object.freeze({
  NONE: "none",
  FADE: "fade",
  ZOOM: "zoom",
  WIPE_LEFT: "wipe-left",
  WIPE_UP: "wipe-up",
  FLASH: "flash",
  BLUR: "blur",
  GLITCH: "glitch",
});

const VALID_TRANSITION_IDS = new Set([
  "none",
  "fade",
  "zoom",
  "wipe-left",
  "wipe-up",
  "flash",
  "blur",
  "glitch",
  "split",
]);

const clamp = (val, min, max) => Math.max(min, Math.min(max, Number(val) || 0));

/**
 * Normalizes a transition type string with reduced-motion and headless support checks.
 */
export function normalizeTransitionType(type, options = {}) {
  if (!type || typeof type !== "string") return "none";
  const clean = type.trim().toLowerCase();

  if (!VALID_TRANSITION_IDS.has(clean)) {
    return "none";
  }

  // When reduced motion is requested, eliminate energetic zooms, wipes, flashes, and glitches
  const isReduced = options.reducedMotion === true;
  if (isReduced) {
    if (clean === "fade") return "fade";
    return "none";
  }

  // Glitch maps to flash for rendering parity if engine lacks shader glitch
  if (clean === "glitch") {
    return options.allowGlitchAccents === false ? "fade" : "flash";
  }

  return clean;
}

/**
 * Maps transition ID to FFmpeg xfade transition name.
 */
export function mapTransitionToFfmpegXfade(transitionId) {
  const norm = normalizeTransitionType(transitionId);
  if (norm === "none") return null;
  return SUPPORTED_HEADLESS_TRANSITIONS[norm] || "fade";
}

/**
 * Detects opportunities for B-roll cutaways within a candidate's trimmed window.
 */
export function detectBrollCutawayOpportunities({
  candidate = null,
  sentences = [],
  sceneCuts = [],
  acousticFeatures = null,
  narrativeArc = null,
  options = {},
} = {}) {
  if (!candidate || typeof candidate !== "object" || !Number.isFinite(Number(candidate.duration))) {
    return [];
  }

  const candidateDuration = Number(candidate.duration);
  const candidateStart = Number(candidate.startTime) || 0;
  const candidateEnd = Number(candidate.endTime) || candidateStart + candidateDuration;

  const minGap = Number(options.minMonologueGap) || DEFAULT_SHORTS_TRANSITION_OPTIONS.minMonologueGap;
  const minDur = Number(options.minBrollDuration) || DEFAULT_SHORTS_TRANSITION_OPTIONS.minBrollDuration;
  const maxDur = Number(options.maxBrollDuration) || DEFAULT_SHORTS_TRANSITION_OPTIONS.maxBrollDuration;
  const defDur = Number(options.defaultBrollDuration) || DEFAULT_SHORTS_TRANSITION_OPTIONS.defaultBrollDuration;
  const minSpacing = Number(options.minBrollSpacing) || DEFAULT_SHORTS_TRANSITION_OPTIONS.minBrollSpacing;
  const hookGuard = Number(options.hookGuardDuration) || DEFAULT_SHORTS_TRANSITION_OPTIONS.hookGuardDuration;
  const payoffGuard = Number(options.payoffGuardDuration) || DEFAULT_SHORTS_TRANSITION_OPTIONS.payoffGuardDuration;

  const candidateSentences = Array.isArray(sentences)
    ? sentences.filter((s) => s && s.end > candidateStart && s.start < candidateEnd)
    : [];

  const normalizedSceneCuts = Array.isArray(sceneCuts)
    ? sceneCuts
        .map(Number)
        .filter((t) => t >= candidateStart && t <= candidateEnd)
        .map((t) => Number((t - candidateStart).toFixed(3)))
    : [];

  const rawOpportunities = [];

  // 1. Monologue & Thought Gap Analysis
  if (candidateSentences.length > 0) {
    for (let i = 0; i < candidateSentences.length; i++) {
      const curr = candidateSentences[i];
      const relStart = Math.max(0, Number((curr.start - candidateStart).toFixed(3)));
      const relEnd = Math.min(candidateDuration, Number((curr.end - candidateStart).toFixed(3)));
      const sentDuration = relEnd - relStart;

      // Extract context and salient keywords
      const salient = extractSalientKeywords(curr.text || "");

      // A. Long Monologue sentence (> minGap)
      if (sentDuration >= minGap) {
        // Place cutaway in middle third of the monologue to keep pacing fresh
        const midTime = Number((relStart + sentDuration * 0.35).toFixed(3));
        const dur = clamp(sentDuration * 0.5, minDur, maxDur);

        rawOpportunities.push({
          type: "monologue_cutaway",
          time: midTime,
          start: midTime,
          duration: Number(dur.toFixed(3)),
          end: Number((midTime + dur).toFixed(3)),
          text: curr.text || "",
          keywords: salient.keywords,
          primaryLabel: salient.primaryLabel,
          reason: `Pacing relief for extended ${sentDuration.toFixed(1)}s monologue`,
          confidence: 0.85,
        });
      }

      // B. Inter-sentence speech pause / thought boundary
      if (i < candidateSentences.length - 1) {
        const next = candidateSentences[i + 1];
        const nextRelStart = Math.max(0, Number((next.start - candidateStart).toFixed(3)));
        const pauseGap = Number((nextRelStart - relEnd).toFixed(3));

        if (pauseGap >= 0.25) {
          const dur = clamp(defDur, minDur, maxDur);
          rawOpportunities.push({
            type: "speech_pause_cutaway",
            time: relEnd,
            start: relEnd,
            duration: Number(dur.toFixed(3)),
            end: Number((relEnd + dur).toFixed(3)),
            text: next.text || curr.text || "",
            keywords: salient.keywords,
            primaryLabel: salient.primaryLabel,
            reason: `Visual transition at ${pauseGap.toFixed(2)}s inter-thought pause`,
            confidence: 0.80,
          });
        }
      }
    }
  }

  // 2. Narrative Arc Boundary Shifts (Setup -> Climax)
  if (narrativeArc && Array.isArray(narrativeArc.stages)) {
    for (const stage of narrativeArc.stages) {
      if (stage.type === "climax" || stage.type === "insight") {
        const stageStart = Math.max(0, Number((stage.startTime - candidateStart).toFixed(3)));
        if (stageStart > hookGuard && stageStart < candidateDuration - payoffGuard) {
          rawOpportunities.push({
            type: "narrative_shift_cutaway",
            time: stageStart,
            start: stageStart,
            duration: defDur,
            end: Number((stageStart + defDur).toFixed(3)),
            text: stage.text || "",
            keywords: stage.keywords || [],
            primaryLabel: stage.label || "CORE INSIGHT",
            reason: `Visual cutaway emphasizing narrative ${stage.type} transition`,
            confidence: 0.90,
          });
        }
      }
    }
  }

  // 3. Fallback for visual scenes with no speech transcript
  if (rawOpportunities.length === 0 && candidateDuration >= 10) {
    const midPoint = Number((candidateDuration * 0.45).toFixed(3));
    rawOpportunities.push({
      type: "pacing_cutaway",
      time: midPoint,
      start: midPoint,
      duration: defDur,
      end: Number((midPoint + defDur).toFixed(3)),
      text: candidate.title || "",
      keywords: extractSalientKeywords(candidate.title || "").keywords,
      primaryLabel: "HIGHLIGHT",
      reason: "Mid-clip pacing refresh for visual segment",
      confidence: 0.70,
    });
  }

  // 4. Hook & Payoff Protection + Scene Cut Avoidance
  const validOpportunities = [];

  for (const opp of rawOpportunities) {
    // Hook Protection: Avoid cutting away during the initial hook
    if (opp.start < hookGuard) {
      continue;
    }

    // Payoff Protection: Avoid cutting away during final payoff punchline
    if (opp.end > candidateDuration - payoffGuard) {
      continue;
    }

    // Scene Cut Protection: Don't cross or clash with existing hard scene cuts
    const nearCut = normalizedSceneCuts.some(
      (cut) => cut >= opp.start - 0.3 && cut <= opp.end + 0.3
    );
    if (nearCut) {
      continue;
    }

    // Ensure valid bounds within clip
    const clampedEnd = Math.min(candidateDuration - 0.2, opp.end);
    const clampedDur = Number((clampedEnd - opp.start).toFixed(3));
    if (clampedDur >= minDur) {
      validOpportunities.push({
        ...opp,
        duration: clampedDur,
        end: clampedEnd,
      });
    }
  }

  // 5. Greedy Selection by Confidence with Minimum Spacing Enforcement
  // Narrative shifts (0.90) prioritize over monologues (0.85) and pauses (0.80)
  const sortedByConfidence = [...validOpportunities].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  const accepted = [];

  for (const opp of sortedByConfidence) {
    const spacingConflict = accepted.some((acc) => {
      // Overlap or less than minSpacing apart
      return !(opp.start >= acc.end + minSpacing || opp.end <= acc.start - minSpacing);
    });

    if (!spacingConflict) {
      accepted.push(opp);
    }
  }

  // Sort final opportunities chronologically and assign deterministic IDs
  accepted.sort((a, b) => a.start - b.start);

  const candPrefix = candidate.id || "clip";
  return accepted.map((opp, idx) => ({
    ...opp,
    id: `broll-${candPrefix}-${Math.round(opp.start * 100)}`,
    index: idx + 1,
  }));
}

/**
 * Scores and selects the best available B-roll asset for an opportunity.
 * Pure function: Rejects low-confidence assets and never invents asset paths.
 */
export function scoreAndSelectBrollAsset({
  opportunity = null,
  availableAssets = [],
  options = {},
} = {}) {
  if (!opportunity || !Array.isArray(availableAssets) || availableAssets.length === 0) {
    return {
      selectedAsset: null,
      relevanceScore: 0,
      reason: "NO_ASSETS_PROVIDED",
      assetRequest: opportunity ? {
        query: opportunity.primaryLabel || (opportunity.keywords || []).join(" ") || "supporting footage",
        start: opportunity.start,
        duration: opportunity.duration,
        type: "broll_video",
      } : null,
    };
  }

  const threshold = Number.isFinite(Number(options.relevanceThreshold))
    ? Number(options.relevanceThreshold)
    : DEFAULT_SHORTS_TRANSITION_OPTIONS.relevanceThreshold;

  const targetTokens = Array.isArray(opportunity.keywords) && opportunity.keywords.length > 0
    ? opportunity.keywords.map((k) => String(k).toLowerCase().trim()).filter(Boolean)
    : String(opportunity.text || opportunity.primaryLabel || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2);

  const scoredAssets = availableAssets
    .map((asset) => {
      if (!asset || typeof asset !== "object") return null;

      let score = 0;
      if (targetTokens.length > 0) {
        score = Math.max(score, scoreAssetRelevance(asset, targetTokens));
      }
      if (opportunity.text) {
        score = Math.max(score, scoreAssetRelevance(asset, opportunity.text));
      }
      if (opportunity.primaryLabel) {
        score = Math.max(score, scoreAssetRelevance(asset, opportunity.primaryLabel));
      }

      // Compute matched tokens for debug / metadata reporting
      const assetTags = Array.isArray(asset.tags) ? asset.tags.map((t) => String(t).toLowerCase()) : [];
      const assetName = String(asset.name || asset.id || "").toLowerCase();
      const matchedTokens = targetTokens.filter((t) => assetTags.includes(t) || assetName.includes(t));

      return {
        asset,
        relevance: Number(score.toFixed(3)),
        matches: matchedTokens,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.relevance - a.relevance);

  if (scoredAssets.length === 0 || scoredAssets[0].relevance < threshold) {
    return {
      selectedAsset: null,
      relevanceScore: scoredAssets[0]?.relevance || 0,
      reason: "NO_RELEVANT_ASSETS",
      bestCandidateScore: scoredAssets[0]?.relevance || 0,
      assetRequest: {
        query: opportunity.primaryLabel || (opportunity.keywords || []).join(" ") || "supporting footage",
        start: opportunity.start,
        duration: opportunity.duration,
        type: "broll_video",
        keywords: opportunity.keywords || [],
      },
    };
  }

  const topMatch = scoredAssets[0];
  return {
    selectedAsset: topMatch.asset,
    relevanceScore: topMatch.relevance,
    matches: topMatch.matches,
    reason: "ASSET_SELECTED",
    assetRequest: null,
  };
}

/**
 * Intelligently selects a transition type for a specific point in the short.
 */
export function selectTransitionForContext({
  time = 0,
  candidateDuration = 15,
  isBrollCutaway = false,
  isNarrativeBoundary = false,
  isSpeechPause = false,
  vocalSurge = false,
  hasConflictingPunchIn = false,
  options = {},
} = {}) {
  const normTime = Number(time) || 0;
  const dur = Number(candidateDuration) || 15;
  const isReduced = options.reducedMotion === true;

  // 1. Hook Protection: Always clean cut near start
  const hookGuard = Number(options.hookGuardDuration) || DEFAULT_SHORTS_TRANSITION_OPTIONS.hookGuardDuration;
  if (normTime < hookGuard) {
    return {
      type: "none",
      duration: 0,
      reason: "HOOK_PROTECTED",
      cleanCut: true,
    };
  }

  // 2. Payoff Protection: Always clean cut near end
  const payoffGuard = Number(options.payoffGuardDuration) || DEFAULT_SHORTS_TRANSITION_OPTIONS.payoffGuardDuration;
  if (normTime > dur - payoffGuard) {
    return {
      type: "none",
      duration: 0,
      reason: "PAYOFF_PROTECTED",
      cleanCut: true,
    };
  }

  // 3. Punch-In Conflict: Never clash with a smart-zoom camera punch-in
  if (hasConflictingPunchIn) {
    return {
      type: "none",
      duration: 0,
      reason: "PUNCHIN_CONFLICT_AVOIDED",
      cleanCut: true,
    };
  }

  // 4. Reduced Motion: Restrict to none or gentle dissolve
  if (isReduced) {
    const type = isBrollCutaway ? "fade" : "none";
    return {
      type,
      duration: type === "none" ? 0 : 0.3,
      reason: "REDUCED_MOTION_ENFORCED",
      cleanCut: type === "none",
    };
  }

  // 5. Context-driven selection
  if (isBrollCutaway) {
    return {
      type: "fade",
      duration: 0.35,
      reason: "BROLL_DISSOLVE",
      cleanCut: false,
    };
  }

  if (isNarrativeBoundary) {
    return {
      type: "wipe-left",
      duration: 0.30,
      reason: "NARRATIVE_STAGE_SHIFT",
      cleanCut: false,
    };
  }

  if (vocalSurge && options.allowGlitchAccents !== false) {
    return {
      type: "flash",
      duration: 0.20,
      reason: "VOCAL_SURGE_ACCENT",
      cleanCut: false,
    };
  }

  if (isSpeechPause) {
    return {
      type: "zoom",
      duration: 0.25,
      reason: "SPEECH_PAUSE_PUSH",
      cleanCut: false,
    };
  }

  // Default clean cut
  return {
    type: "none",
    duration: 0,
    reason: "DEFAULT_CLEAN_CUT",
    cleanCut: true,
  };
}

/**
 * Resolves collisions and enforces spacing between transition events.
 */
export function resolveTransitionCollisions({
  transitions = [],
  punchIns = [],
  sceneCuts = [],
  clipDuration = 15,
  options = {},
} = {}) {
  if (!Array.isArray(transitions) || transitions.length === 0) return [];

  const minSpacing = Number(options.minTransitionSpacing) || DEFAULT_SHORTS_TRANSITION_OPTIONS.minTransitionSpacing;
  const maxTransitions = Number(options.maxTransitionsPerClip) || DEFAULT_SHORTS_TRANSITION_OPTIONS.maxTransitionsPerClip;

  const validTransitions = transitions
    .filter((t) => t && Number.isFinite(Number(t.time)))
    .map((t) => ({
      ...t,
      time: clamp(t.time, 0, clipDuration),
      duration: clamp(t.duration || 0, 0, DEFAULT_SHORTS_TRANSITION_OPTIONS.maxDuration),
    }))
    .sort((a, b) => a.time - b.time);

  const resolved = [];

  for (const tr of validTransitions) {
    if (resolved.length >= maxTransitions) break;

    // Check punch-in proximity (<0.5s)
    const hasPunchInConflict = Array.isArray(punchIns) && punchIns.some((p) => {
      const pTime = Number(p.time || p.tStart || 0);
      return Math.abs(pTime - tr.time) < 0.5;
    });

    if (hasPunchInConflict && tr.type !== "none") {
      // Downgrade to clean cut to avoid collision
      resolved.push({
        ...tr,
        type: "none",
        duration: 0,
        collisionResolved: true,
        reason: "PUNCHIN_COLLISION_RESOLVED",
      });
      continue;
    }

    // Check spacing against previously accepted transition
    if (resolved.length > 0) {
      const prev = resolved[resolved.length - 1];
      if (tr.time - prev.time < minSpacing) {
        continue;
      }
    }

    // Check boundary clamping against clip duration
    const safeDur = Math.min(tr.duration, Math.max(0, clipDuration - tr.time));

    resolved.push({
      ...tr,
      duration: tr.type === "none" ? 0 : Number(safeDur.toFixed(2)),
      collisionResolved: false,
    });
  }

  return resolved;
}

/**
 * Plans automated B-roll synthesis and intelligent transition polish for a candidate short.
 */
export function planShortTransitionsAndBroll({
  candidate = null,
  sourceClip = {},
  availableAssets = [],
  sentences = [],
  sceneCuts = [],
  punchIns = [],
  acousticFeatures = null,
  options = {},
} = {}) {
  if (!candidate || typeof candidate !== "object" || !Number.isFinite(Number(candidate.duration))) {
    return {
      ok: false,
      reason: "INVALID_CANDIDATE",
      cutaways: [],
      transitions: [],
      assetRequests: [],
      metrics: { cutawayCount: 0, transitionCount: 0, cleanCutCount: 0 },
    };
  }

  const enabled = options.enabled !== false && candidate.autoTransitions !== false;
  if (!enabled) {
    return {
      ok: true,
      enabled: false,
      cutaways: [],
      transitions: [],
      assetRequests: [],
      metrics: { cutawayCount: 0, transitionCount: 0, cleanCutCount: 0, disabled: true },
    };
  }

  const candidateDuration = Number(candidate.duration);
  const candidatePunchIns = Array.isArray(punchIns) && punchIns.length > 0
    ? punchIns
    : (Array.isArray(candidate.punchIns) ? candidate.punchIns : []);

  // 1. Detect B-roll Cutaway Opportunities
  const opportunities = detectBrollCutawayOpportunities({
    candidate,
    sentences,
    sceneCuts,
    acousticFeatures,
    narrativeArc: candidate.narrativeArc,
    options,
  });

  const plannedCutaways = [];
  const assetRequests = [];
  const rawTransitions = [];

  // 2. Score and Match Assets
  for (const opp of opportunities) {
    const selection = scoreAndSelectBrollAsset({
      opportunity: opp,
      availableAssets,
      options,
    });

    if (selection.selectedAsset) {
      plannedCutaways.push({
        id: `cutaway-${opp.id}`,
        opportunityId: opp.id,
        type: "broll_cutaway",
        start: opp.start,
        duration: opp.duration,
        end: opp.end,
        asset: selection.selectedAsset,
        assetId: selection.selectedAsset.id,
        assetPath: selection.selectedAsset.path || selection.selectedAsset.src,
        relevanceScore: selection.relevanceScore,
        matchedTokens: selection.matches,
        reason: opp.reason,
        transitionIn: "fade",
        transitionOut: "fade",
      });

      // Entry transition into B-roll cutaway
      rawTransitions.push({
        id: `tr-in-${opp.id}`,
        time: opp.start,
        type: "fade",
        duration: 0.3,
        context: "broll_cutaway_in",
      });

      // Exit transition returning to primary footage
      rawTransitions.push({
        id: `tr-out-${opp.id}`,
        time: opp.end,
        type: "fade",
        duration: 0.3,
        context: "broll_cutaway_out",
      });
    } else if (selection.assetRequest) {
      // Explicit fallback request: keep primary footage clean, do not inject hallucinations
      assetRequests.push(selection.assetRequest);
    }
  }

  // 3. Plan Narrative & Rhythm Transitions for Primary Footage
  if (candidate.narrativeArc && Array.isArray(candidate.narrativeArc.stages)) {
    for (const stage of candidate.narrativeArc.stages) {
      const stageStart = Math.max(0, Number((stage.startTime - (candidate.startTime || 0)).toFixed(3)));
      const trResult = selectTransitionForContext({
        time: stageStart,
        candidateDuration,
        isNarrativeBoundary: true,
        options,
      });

      if (!trResult.cleanCut) {
        rawTransitions.push({
          id: `tr-stage-${stage.type}`,
          time: stageStart,
          type: trResult.type,
          duration: trResult.duration,
          context: `narrative_${stage.type}`,
          reason: trResult.reason,
        });
      }
    }
  }

  // 4. Resolve Collisions, Punch-In Conflicts, and Spacing
  const finalTransitions = resolveTransitionCollisions({
    transitions: rawTransitions,
    punchIns: candidatePunchIns,
    sceneCuts,
    clipDuration: candidateDuration,
    options,
  });

  const cleanCutCount = finalTransitions.filter((t) => t.type === "none").length;
  const activeTransitionCount = finalTransitions.filter((t) => t.type !== "none").length;

  return {
    ok: true,
    candidateId: candidate.id,
    enabled: true,
    cutaways: plannedCutaways,
    transitions: finalTransitions,
    assetRequests,
    metrics: {
      cutawayCount: plannedCutaways.length,
      transitionCount: activeTransitionCount,
      cleanCutCount,
      assetRequestCount: assetRequests.length,
      reducedMotion: Boolean(options.reducedMotion),
    },
  };
}

/**
 * Pure function: applies transition and B-roll cutaway metadata to a candidate object.
 */
export function applyTransitionsAndBrollToCandidate(candidate = {}, plan = {}) {
  if (!candidate || typeof candidate !== "object") return candidate;

  return {
    ...candidate,
    brollCutaways: Array.isArray(plan?.cutaways) ? [...plan.cutaways] : [],
    transitions: Array.isArray(plan?.transitions) ? [...plan.transitions] : [],
    assetRequests: Array.isArray(plan?.assetRequests) ? [...plan.assetRequests] : [],
    transitionMetrics: plan?.metrics || null,
  };
}

/**
 * Pure function: integrates B-roll cutaways and transition junctions into an editor timeline project.
 */
export function applyTransitionsToProject(project = {}, plan = {}, options = {}) {
  if (!project || typeof project !== "object") return project;
  if (!plan || !plan.ok || (!plan.cutaways?.length && !plan.transitions?.length)) {
    return project;
  }

  const existingVisuals = Array.isArray(project.visualSegments) ? [...project.visualSegments] : [];
  const existingOverlays = Array.isArray(project.visualOverlaySegments) ? [...project.visualOverlaySegments] : [];
  const newOverlays = [...existingOverlays];

  // Convert planned cutaways into full-frame visual overlay segments
  if (Array.isArray(plan.cutaways) && plan.cutaways.length > 0) {
    for (const cutaway of plan.cutaways) {
      if (!cutaway.asset) continue;

      const overlaySeg = {
        id: `vis-cutaway-${makeId("broll")}`,
        type: cutaway.asset.type === "image" ? "image" : "video",
        kind: "broll",
        name: cutaway.asset.name || "B-Roll Cutaway",
        src: cutaway.asset.path || cutaway.asset.src,
        path: cutaway.asset.path || cutaway.asset.src,
        assetId: cutaway.asset.id,
        archiveMediaId: cutaway.asset.id,
        start: cutaway.start,
        duration: cutaway.duration,
        sourceStart: 0,
        sourceDuration: cutaway.duration,
        fitMode: "cover",
        cropX: 0.5,
        cropY: 0.5,
        objectPosition: "50% 50%",
        opacity: 1.0,
        transition: {
          id: cutaway.transitionIn || "fade",
          duration: 0.3,
        },
        meta: {
          relevanceScore: cutaway.relevanceScore,
          matchedTokens: cutaway.matchedTokens,
          reason: cutaway.reason,
        },
      };

      newOverlays.push(overlaySeg);
    }
  }

  // Attach primary transitions to project
  const projectTransitions = Array.isArray(plan.transitions) ? [...plan.transitions] : [];

  // If primary visual segment exists, attach primary junction transition if planned
  const updatedVisuals = existingVisuals.map((vis, idx) => {
    const matchingTrans = projectTransitions.find((t) => Math.abs(t.time - (vis.sourceStart || 0)) < 0.2);
    if (matchingTrans && matchingTrans.type !== "none") {
      return {
        ...vis,
        transition: {
          id: matchingTrans.type,
          duration: matchingTrans.duration,
        },
      };
    }
    return vis;
  });

  return {
    ...project,
    visualSegments: updatedVisuals,
    visualOverlaySegments: newOverlays,
    transitions: projectTransitions,
    brollCutaways: plan.cutaways || [],
    assetRequests: plan.assetRequests || [],
  };
}
