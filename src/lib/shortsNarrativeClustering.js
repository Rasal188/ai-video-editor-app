/**
 * @file shortsNarrativeClustering.js
 * AI Shorts Studio Phase 2 Priority 4: Semantic Narrative Arc Clustering.
 *
 * Implements intelligent story arc clustering and candidate boundary optimization:
 * - Detects 3-act short-form narrative stages:
 *   1. Setup / Curiosity Hook / Problem Premise
 *   2. Climax / Core Insight / Turning Point / Struggle
 *   3. Resolution / Payoff / Practical Takeaway / Conclusion
 * - Computes thematic continuity and detects topic boundary shifts
 * - Groups sentences into coherent narrative arc clusters
 * - Optimizes candidate duration boundaries to keep full story arcs intact
 * - Prevents abrupt cutoffs before resolution and suppresses chimera candidates
 *   spanning multiple disjoint narrative arcs
 * - Operates fast, deterministically, and offline without mandatory external APIs
 */

import { extractContentWords } from "./shortsStudio.js";

export const NARRATIVE_STAGES = Object.freeze({
  SETUP: "setup",
  CLIMAX: "climax",
  RESOLUTION: "resolution",
  NEUTRAL: "neutral",
});

// Discourse markers indicating narrative Setup, Hook, or Problem Definition
const SETUP_MARKERS = [
  /\b(?:have you ever|did you know|what if|why does|how do|imagine|the problem is|most people (?:think|believe)|one day|when i (?:started|was|first)|years ago|here is why|the secret to|stop doing|we all know)\b/i,
  /\b(?:setup|premise|question|problem|mistake|myth|danger|mystery)\b/i,
];

// Discourse markers indicating narrative Climax, Conflict, Turning Point, or Core Insight
const CLIMAX_MARKERS = [
  /\b(?:suddenly|however|but then|in reality|what actually happened|the truth is|that's when|the real problem|notice that|crucial|turning point|all of a sudden|unexpectedly|the key insight|breakthrough|realize|realizing|game changer|the real secret|revelation|instead)\b/i,
  /\b(?:climax|conflict|struggle|twist|surprise|shock|discovery|challenge|action)\b/i,
];

// Discourse markers indicating narrative Resolution, Payoff, Moral, or Actionable Takeaway
const RESOLUTION_MARKERS = [
  /\b(?:therefore|that's why|in the end|as a result|so remember|the solution is|now you know|and that is how|finally|to sum up|always remember|never forget|which means|lesson learned)\b/i,
  /\b(?:result|solution|takeaway|payoff|conclusion|outcome|moral|advice|answer)\b/i,
];

// Markers indicating abrupt topic transition to an unrelated subject
const TOPIC_SHIFT_MARKERS = [
  /\b(?:moving on|in other news|next topic|by the way|on a different note|anyway|switching gears|let's talk about something else)\b/i,
];

/**
 * Classifies an individual sentence into a narrative stage.
 *
 * @param {object} sentence - Sentence object with { text, start, end, isQuestion }
 * @param {object} [context] - Context with relative position, surrounding sentences
 * @returns {{ stage: string, confidence: number, signals: string[] }}
 */
export function classifySentenceNarrativeStage(sentence, context = {}) {
  if (!sentence || typeof sentence !== "object") {
    return { stage: NARRATIVE_STAGES.NEUTRAL, confidence: 0, signals: [] };
  }

  // Honor pre-assigned narrativeStage if already present
  if (sentence.narrativeStage && Object.values(NARRATIVE_STAGES).includes(sentence.narrativeStage)) {
    return {
      stage: sentence.narrativeStage,
      confidence: 1.0,
      signals: ["explicit_stage_property"],
    };
  }

  const text = String(sentence.text || "").trim();
  if (!text) {
    return { stage: NARRATIVE_STAGES.NEUTRAL, confidence: 0, signals: [] };
  }

  const signals = [];
  let setupScore = 0;
  let climaxScore = 0;
  let resolutionScore = 0;

  // 1. Check for Question opening (strong Setup indicator)
  if (sentence.isQuestion || text.includes("?")) {
    setupScore += 35;
    signals.push("question_hook");
  }

  // 2. Evaluate Setup markers
  for (const regex of SETUP_MARKERS) {
    if (regex.test(text)) {
      setupScore += 30;
      signals.push("setup_lexical_marker");
      break;
    }
  }

  // 3. Evaluate Climax / Turning Point markers
  for (const regex of CLIMAX_MARKERS) {
    if (regex.test(text)) {
      climaxScore += 35;
      signals.push("climax_lexical_marker");
      break;
    }
  }

  // 4. Evaluate Resolution / Payoff markers
  for (const regex of RESOLUTION_MARKERS) {
    if (regex.test(text)) {
      resolutionScore += 35;
      signals.push("resolution_lexical_marker");
      break;
    }
  }

  // 5. Exclamatory / Imperative emphasis
  if (text.includes("!") || /[A-Z]{3,}/.test(text)) {
    climaxScore += 15;
    signals.push("emotional_emphasis");
  }

  // 6. Positional Bayesian priors if context is provided
  const relPos = Number.isFinite(context.relativePosition)
    ? context.relativePosition
    : Number.isFinite(context.positionRatio)
    ? context.positionRatio
    : (context.totalSentences > 1 && Number.isFinite(context.index)
        ? context.index / (context.totalSentences - 1)
        : null);

  if (relPos !== null) {
    if (relPos < 0.25) {
      setupScore += 20;
    } else if (relPos >= 0.25 && relPos < 0.70) {
      climaxScore += 15;
    } else {
      resolutionScore += 20;
    }
  }

  // Select dominant stage
  const maxScore = Math.max(setupScore, climaxScore, resolutionScore);
  if (maxScore < 20) {
    return { stage: NARRATIVE_STAGES.NEUTRAL, confidence: 0.3, signals };
  }

  let stage = NARRATIVE_STAGES.NEUTRAL;
  if (maxScore === setupScore) stage = NARRATIVE_STAGES.SETUP;
  else if (maxScore === climaxScore) stage = NARRATIVE_STAGES.CLIMAX;
  else stage = NARRATIVE_STAGES.RESOLUTION;

  const confidence = Math.min(1.0, Number((maxScore / 70).toFixed(2)));
  return { stage, confidence, signals };
}

/**
 * Computes thematic continuity between two consecutive sentences.
 * Returns a score between 0.0 (completely disjoint / topic shift) and 1.0 (continuous thought).
 *
 * @param {object} sentenceA - First sentence
 * @param {object} sentenceB - Second sentence
 * @returns {{ continuityScore: number, isTopicShift: boolean, sharedWords: string[], gapSeconds: number }}
 */
export function computeThematicContinuity(sentenceA, sentenceB) {
  if (!sentenceA || !sentenceB) {
    return { continuityScore: 0.5, isTopicShift: false, sharedWords: [], gapSeconds: 0 };
  }

  const textA = String(sentenceA.text || "");
  const textB = String(sentenceB.text || "");

  const wordsA = extractContentWords(textA);
  const wordsB = extractContentWords(textB);

  const setA = new Set(wordsA);
  const sharedWords = wordsB.filter((w) => setA.has(w));

  const unionSize = new Set([...wordsA, ...wordsB]).size;
  const lexicalOverlap = unionSize > 0 ? sharedWords.length / unionSize : 0;

  // Inter-sentence silence gap
  const gapSeconds = Math.max(0, Number((sentenceB.start - sentenceA.end).toFixed(2)));

  // Explicit topic shift phrase check
  const hasTopicShiftMarker = TOPIC_SHIFT_MARKERS.some((rx) => rx.test(textB));

  // If there's an explicit topic shift phrase or a massive conversational pause (> 2.5s)
  const isTopicShift = hasTopicShiftMarker || (gapSeconds > 2.5 && lexicalOverlap < 0.1);

  let continuity = 0.5;
  if (isTopicShift) {
    continuity = 0.1;
  } else {
    // Discourse marker continuation bonus
    const hasConnective = /^(?:and|so|but|because|then|now|however|which|while|meanwhile)\b/i.test(textB.trim());
    const connectiveBonus = hasConnective ? 0.25 : 0;
    const overlapBonus = Math.min(0.35, lexicalOverlap * 1.5);
    const gapPenalty = Math.min(0.25, gapSeconds * 0.12);

    continuity = Math.max(0, Math.min(1.0, 0.4 + connectiveBonus + overlapBonus - gapPenalty));
  }

  return {
    continuityScore: Number(continuity.toFixed(2)),
    thematicScore: Math.round(continuity * 100),
    isTopicShift,
    topicShift: isTopicShift,
    sharedWords,
    gapSeconds,
  };
}

/**
 * Clusters an array of transcript sentences into coherent narrative arcs.
 * Each arc represents an autonomous mini-story or complete thought with setup, climax, and resolution.
 *
 * @param {Array<object>} sentences - Ordered list of transcript sentences
 * @param {object} [options] - Clustering settings
 * @param {number} [options.maxArcDuration=75] - Upper threshold for a single narrative arc
 * @param {number} [options.minArcDuration=10] - Lower threshold for a standalone arc
 * @returns {Array<object>} Array of narrative arc cluster objects
 */
export function clusterNarrativeArcs(sentences = [], options = {}) {
  const safeSentences = Array.isArray(sentences) ? sentences.filter((s) => s && typeof s === "object") : [];
  if (safeSentences.length === 0) return [];

  const maxArcDuration = Number(options.maxArcDuration) || 75;
  const minArcDuration = Number(options.minArcDuration) || 10;

  const arcs = [];
  let currentArcSentences = [safeSentences[0]];
  let arcStartIndex = 0;

  for (let i = 1; i < safeSentences.length; i++) {
    const prev = safeSentences[i - 1];
    const curr = safeSentences[i];

    const { continuityScore, isTopicShift } = computeThematicContinuity(prev, curr);
    const currentDuration = curr.end - safeSentences[arcStartIndex].start;

    // Determine if a new arc should be initiated:
    // 1. Explicit topic shift
    // 2. Very low continuity (< 0.2) and current arc has already met minimum duration
    // 3. Current arc would exceed maxArcDuration
    // 4. Current sentence is a strong setup/question hook and previous was a clear resolution
    const prevClass = classifySentenceNarrativeStage(prev);
    const currClass = classifySentenceNarrativeStage(curr);
    const isNewSetup = currClass.stage === NARRATIVE_STAGES.SETUP && prevClass.stage === NARRATIVE_STAGES.RESOLUTION;

    const shouldSplit =
      isTopicShift ||
      currentDuration > maxArcDuration ||
      (currentDuration >= minArcDuration && (continuityScore < 0.25 || isNewSetup));

    if (shouldSplit) {
      // Finalize current arc
      arcs.push(buildArcCluster(currentArcSentences, arcStartIndex, i - 1, arcs.length + 1));
      currentArcSentences = [curr];
      arcStartIndex = i;
    } else {
      currentArcSentences.push(curr);
    }
  }

  // Finalize last arc
  if (currentArcSentences.length > 0) {
    arcs.push(buildArcCluster(currentArcSentences, arcStartIndex, safeSentences.length - 1, arcs.length + 1));
  }

  return arcs;
}

/**
 * Builds a structured narrative arc object with stage distribution and completeness metrics.
 */
function buildArcCluster(arcSentences, startIndex, endIndex, index) {
  const start = Math.max(0, Number(arcSentences[0]?.start) || 0);
  const end = Math.max(start, Number(arcSentences.at(-1)?.end) || start + 10);
  const duration = Number((end - start).toFixed(2));

  // Classify stages of member sentences
  const stageClassifications = arcSentences.map((s, idx) =>
    classifySentenceNarrativeStage(s, { relativePosition: arcSentences.length > 1 ? idx / (arcSentences.length - 1) : 0.5 })
  );

  const hasSetup = stageClassifications.some((c) => c.stage === NARRATIVE_STAGES.SETUP) || arcSentences[0]?.isQuestion;
  const hasClimax = stageClassifications.some((c) => c.stage === NARRATIVE_STAGES.CLIMAX);
  const hasResolution = stageClassifications.some((c) => c.stage === NARRATIVE_STAGES.RESOLUTION) || !arcSentences.at(-1)?.isQuestion;

  let completenessScore = 40;
  if (hasSetup) completenessScore += 20;
  if (hasClimax) completenessScore += 20;
  if (hasResolution) completenessScore += 20;

  // Arc label synthesis
  const setupSentence = arcSentences.find((s) => s.isQuestion) || arcSentences[0];
  const arcTitle = setupSentence?.text
    ? setupSentence.text.slice(0, 60).replace(/[^\w\s?]/g, "") + (setupSentence.text.length > 60 ? "…" : "")
    : `Narrative Arc ${index}`;

  return {
    id: `arc-${index}`,
    index,
    startIndex,
    endIndex,
    startSentenceIndex: startIndex,
    endSentenceIndex: endIndex,
    startTime: start,
    endTime: end,
    duration,
    sentenceCount: arcSentences.length,
    sentences: arcSentences,
    stages: {
      hasSetup: Boolean(hasSetup),
      hasClimax: Boolean(hasClimax),
      hasResolution: Boolean(hasResolution),
    },
    completenessScore: Math.min(100, completenessScore),
    arcCompletenessScore: Math.min(100, completenessScore),
    arcTitle,
  };
}

/**
 * Evaluates the narrative arc completeness of a candidate window.
 * Checks whether the candidate preserves the setup, core insight, and payoff.
 *
 * @param {Array<object>} candidateSentences - Sentences within candidate window
 * @param {Array<object>} [narrativeArcs] - Global narrative arcs from clusterNarrativeArcs
 * @returns {{ arcScore: number, stagesPresent: string[], isCompleteArc: boolean, warnings: string[], arcId: string|null }}
 */
export function evaluateNarrativeArcCompleteness(candidateSentences = [], narrativeArcs = []) {
  if (!Array.isArray(candidateSentences) || candidateSentences.length === 0) {
    return {
      arcScore: 50,
      stagesPresent: [],
      isCompleteArc: false,
      warnings: ["No sentences present in candidate interval"],
      arcId: null,
    };
  }

  const warnings = [];
  const stagesPresent = [];

  const startSentence = candidateSentences[0];
  const endSentence = candidateSentences.at(-1);

  // Classify candidate opening, middle, and closing
  const startClass = classifySentenceNarrativeStage(startSentence, { relativePosition: 0.1 });
  const endClass = classifySentenceNarrativeStage(endSentence, { relativePosition: 0.9 });

  const middleSentences = candidateSentences.slice(1, -1);
  const hasMidClimax = middleSentences.some((s, idx) => {
    const c = classifySentenceNarrativeStage(s, { relativePosition: (idx + 1) / candidateSentences.length });
    return c.stage === NARRATIVE_STAGES.CLIMAX;
  });

  // 1. Setup detection
  const hasSetup = startClass.stage === NARRATIVE_STAGES.SETUP || startSentence.isQuestion;
  if (hasSetup) {
    stagesPresent.push(NARRATIVE_STAGES.SETUP);
  } else if (startSentence.hasLeadingConjunction) {
    warnings.push("Candidate starts on a connective phrase without setup context");
  }

  // 2. Climax / Core insight detection
  const hasClimax = hasMidClimax || startClass.stage === NARRATIVE_STAGES.CLIMAX || endClass.stage === NARRATIVE_STAGES.CLIMAX;
  if (hasClimax) {
    stagesPresent.push(NARRATIVE_STAGES.CLIMAX);
  }

  // 3. Resolution / Payoff detection
  const endHasPunct =
    endSentence.hasPunctuation !== false &&
    (endSentence.hasPunctuation === true || /[.?!]$/.test(String(endSentence.text || "").trim()));

  const hasResolution =
    endClass.stage === NARRATIVE_STAGES.RESOLUTION ||
    (endClass.stage === NARRATIVE_STAGES.NEUTRAL && !endSentence.isQuestion && endHasPunct);

  if (hasResolution) {
    stagesPresent.push(NARRATIVE_STAGES.RESOLUTION);
  } else if (endSentence.isQuestion) {
    warnings.push("Candidate ends on an unanswered question without payoff");
  } else {
    warnings.push("Candidate boundary lacks a clear resolution payoff");
  }

  // 4. Arc collision detection against global narrative arcs
  let parentArc = null;
  const distinctArcIds = new Set();
  for (const s of candidateSentences) {
    if (s.narrativeArcId) distinctArcIds.add(s.narrativeArcId);
  }

  if (Array.isArray(narrativeArcs) && narrativeArcs.length > 0) {
    // Find arc that covers the candidate's start
    const startArc = narrativeArcs.find(
      (a) => Number.isFinite(startSentence.start) && startSentence.start >= a.startTime - 0.5 && startSentence.start <= a.endTime
    );
    const endArc = narrativeArcs.find(
      (a) => Number.isFinite(endSentence.end) && endSentence.end >= a.startTime && endSentence.end <= a.endTime + 0.5
    );

    if (startArc && endArc && startArc.id !== endArc.id) {
      distinctArcIds.add(startArc.id);
      distinctArcIds.add(endArc.id);
    }
    parentArc = startArc || endArc || null;
  }

  if (distinctArcIds.size > 1) {
    warnings.push("Candidate boundary spans across multiple narrative stories");
  }

  // Score calculation
  let arcScore = 40;
  if (hasSetup) arcScore += 20;
  if (hasClimax) arcScore += 20;
  if (hasResolution) arcScore += 20;

  if (warnings.length > 0) {
    arcScore = Math.max(30, arcScore - warnings.length * 10);
  }

  const isCompleteArc = hasSetup && hasClimax && hasResolution && warnings.length === 0;

  return {
    arcScore: Math.min(100, Math.max(0, arcScore)),
    completenessScore: Math.min(100, Math.max(0, arcScore)),
    stagesPresent,
    isComplete: isCompleteArc,
    isCompleteArc,
    warnings,
    arcId: parentArc?.id || Array.from(distinctArcIds)[0] || null,
  };
}

/**
 * Optimizes candidate end boundary by seeking complete narrative payoff.
 * Prevents premature termination when a resolution is just ahead within maxDuration.
 *
 * @param {object} params
 * @param {number} params.startIndex - Index of start sentence
 * @param {Array<object>} params.sentences - Full transcript sentences array
 * @param {number} params.minDuration - Target minimum duration in seconds
 * @param {number} params.maxDuration - Target maximum duration in seconds
 * @param {number} params.mediaDuration - Total duration of source video
 * @returns {{ endIndex: number, endSentence: object, duration: number, isArcComplete: boolean }}
 */
export function optimizeCandidateArcBoundaries({
  startIndex = 0,
  sentences = [],
  minDuration = 15,
  maxDuration = 60,
  mediaDuration = Infinity,
} = {}) {
  const safeSentences = Array.isArray(sentences) ? sentences : [];
  if (safeSentences.length === 0 || startIndex >= safeSentences.length) {
    return { endIndex: startIndex, endSentence: null, duration: 0, isArcComplete: false };
  }

  const startSentence = safeSentences[startIndex];
  const startTime = Number.isFinite(startSentence.start) ? startSentence.start : 0;

  let bestEndIndex = startIndex;
  let bestScore = -1;
  let accumulatedDuration = 0;

  for (let j = startIndex; j < safeSentences.length; j++) {
    const candidateEnd = safeSentences[j];
    const endTime = Number.isFinite(candidateEnd.end) ? candidateEnd.end : (startTime + (j - startIndex + 1) * 4);
    const dur = Math.max(0.5, endTime - startTime);

    if (dur > maxDuration && j > startIndex) {
      break;
    }

    accumulatedDuration = dur;

    // Once minDuration is met, evaluate whether candidateEnd provides a satisfying payoff
    if (dur >= minDuration) {
      const windowSentences = safeSentences.slice(startIndex, j + 1);
      const { arcScore, isCompleteArc, warnings } = evaluateNarrativeArcCompleteness(windowSentences);

      let selectionScore = arcScore;

      // Penalize ending on questions or trailing conjunctions
      if (candidateEnd.isQuestion) selectionScore -= 30;
      if (candidateEnd.hasLeadingConjunction && j + 1 < safeSentences.length) selectionScore -= 10;
      if (candidateEnd.hasPunctuation) selectionScore += 10;

      // Check if next sentence would initiate a topic shift
      if (j + 1 < safeSentences.length) {
        const nextSent = safeSentences[j + 1];
        const { isTopicShift } = computeThematicContinuity(candidateEnd, nextSent);
        if (isTopicShift) selectionScore += 25; // Perfect place to close!
      }

      if (selectionScore > bestScore) {
        bestScore = selectionScore;
        bestEndIndex = j;

        // If we found an ideal, fully resolved arc with punctuation, we can break early
        if (isCompleteArc && candidateEnd.hasPunctuation && !candidateEnd.isQuestion) {
          break;
        }
      }
    } else {
      bestEndIndex = j;
    }
  }

  const selectedEndSentence = safeSentences[bestEndIndex];
  const finalDuration = Math.max(0.5, (selectedEndSentence?.end || startTime + 15) - startTime);
  const finalWindow = safeSentences.slice(startIndex, bestEndIndex + 1);
  const arcEval = evaluateNarrativeArcCompleteness(finalWindow);

  return {
    endIndex: bestEndIndex,
    endSentence: selectedEndSentence,
    duration: Number(finalDuration.toFixed(2)),
    isComplete: Boolean(arcEval.isComplete),
    isArcComplete: Boolean(arcEval.isComplete),
    arcCompletenessScore: arcEval.arcScore,
    narrativeArc: arcEval,
  };
}
