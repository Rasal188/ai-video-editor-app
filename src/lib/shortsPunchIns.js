/**
 * @file shortsPunchIns.js
 * AI Shorts Studio Phase 2 Priority 3: Speech-Paced Visual Punch-Ins & Smart Zoom Enhancements.
 *
 * Provides:
 * - Deterministic speech-aware punch-in moment detection based on sentence emphasis,
 *   narrative transitions, question openings, and word-level timing.
 * - Anti-fatigue cadence control (prevents excessive or monotone zoom spamming).
 * - Word boundary snapping (avoids zooming mid-word).
 * - Face-aware zoom targeting integrated with Priority 2 reframing tracks.
 * - Headroom protection and boundary clamping.
 * - Scene-cut collision resolution (never interpolates zoom across scene transitions).
 * - Overlap merging and deduplication.
 * - Full parity with browser preview canvas and FFmpeg headless render plan.
 */

import {
  SMART_ZOOM_DEFAULTS,
  normalizePunchInScale,
  normalizePunchInDuration,
  normalizePunchInTransition,
  clampPunchInOffsets,
  compilePunchInKeyframes,
} from "./smartZoom.js";
import { resolveSmartFrameCropAtTime } from "./smartFrame.js";
import { extractGenuineFaceDetections, isGenuineFaceBox } from "./shortsReframing.js";

const clamp = (val, min = 0, max = 1) => Math.max(min, Math.min(max, Number(val) || 0));

export const SHORTS_PUNCHIN_DEFAULTS = Object.freeze({
  scale: 1.25,
  minScale: 1.12,
  maxScale: 1.45,
  duration: 2.8,
  minDuration: 1.0,
  maxDuration: 4.5,
  minSpacing: 3.2, // Minimum seconds between punch-in start times
  transition: "smooth",
  transitionDuration: 0.28,
  guardStart: 0.5, // Seconds from clip start before first punch-in allowed
  guardEnd: 0.8, // Seconds before clip end after which no punch-in may extend
});

// Keywords marking meaningful spoken transitions or explanatory emphasis
const TRANSITION_WORDS = new Set([
  "however", "because", "actually", "remember", "notice", "specifically",
  "importantly", "secret", "mistake", "crucial", "finally", "instead",
  "first", "second", "third", "look", "listen", "stop", "never", "always",
  "suddenly", "truth", "problem", "solution", "result", "why", "how", "what",
]);

/**
 * Evaluates whether a word or sentence possesses spoken emphasis or transitional weight.
 *
 * @param {object} sentence - Sentence record with { text, start, end, isQuestion, words }
 * @param {object|null} word - Word record with { word, start, end }
 * @param {object} context - { index, totalSentences, clipDuration }
 * @returns {number} Score from 0 to 100
 */
export function scoreEmphasisWeight(sentence, word = null, context = {}) {
  let score = 0;
  if (!sentence && !word) return 0;

  const text = String(word?.word || word?.text || sentence?.text || "").trim();
  const lower = text.toLowerCase().replace(/[^\w\s]/g, "");
  const wordsInText = lower.split(/\s+/).filter(Boolean);

  // 1. Opening sentence hook or question
  const isQ = Boolean(sentence?.isQuestion || text.includes("?"));
  if (isQ) {
    score += 35;
  }

  // 2. Meaningful transition word
  const hasTransition = wordsInText.some((w) => TRANSITION_WORDS.has(w));
  if (hasTransition) {
    score += 30;
  }

  // 3. Opening sentence hook: only if question, transition, or exclamatory
  if (context.index === 0 && context.totalSentences > 1) {
    if (isQ || hasTransition || text.includes("!")) {
      score += 20;
    }
  }

  // 4. Capitalization or exclamation emphasis (e.g. "NEVER", "WOW!", "STOP!")
  if (/[A-Z]{2,}/.test(text) && text.length >= 3) {
    score += 25;
  }
  if (text.includes("!")) {
    score += 15;
  }

  // 5. Syllable/length weight for explanatory terms
  if (lower.length >= 8 && hasTransition) {
    score += 10;
  }

  // 6. Multimodal vocal energy & acoustic emphasis from Phase 2 Priority 5
  if (sentence?.acousticEnergy?.hasEmphasisPeak) {
    score += 20;
  } else if (sentence?.acousticEnergy?.averageIntensity > 0.65) {
    score += 12;
  }

  // 7. Concluding statement payoff: only if has transition/payoff words or exclamation
  if (context.index > 0 && context.index === context.totalSentences - 1) {
    if (hasTransition || text.includes("!")) {
      score += 20;
    }
  }

  return Math.min(100, score);
}

/**
 * Resolves face-aware zoom offsets relative to the reframed view.
 * Ensures the subject's face is centered in the punched-in canvas while protecting headroom.
 *
 * @param {object} params
 * @param {object} params.reframingTrack - SmartFrame object from Priority 2
 * @param {number} params.time - Local clip time in seconds
 * @param {number} params.scale - Punch-in scale (e.g. 1.25)
 * @param {Array} params.faceDetections - Array of { time, faces }
 * @param {number} params.manualCropX - User manual crop offset override (0..1)
 * @returns {{ x: number, y: number, faceAnchored: boolean }}
 */
export function resolveFaceAwarePunchInOffset({
  reframingTrack = null,
  time = 0,
  scale = 1.25,
  faceDetections = [],
  manualCropX = 0.5,
} = {}) {
  const normScale = normalizePunchInScale(scale, SHORTS_PUNCHIN_DEFAULTS.scale);

  // If no reframing track exists, check if user provided a manual crop offset
  if (!reframingTrack || !Array.isArray(reframingTrack.cropKeyframes) || reframingTrack.isFallback) {
    if (Number.isFinite(manualCropX) && Math.abs(manualCropX - 0.5) > 0.01) {
      const x = -(manualCropX - 0.5) * 15 * normScale;
      return {
        ...clampPunchInOffsets(x, 0, normScale),
        faceAnchored: false,
      };
    }
    return { x: 0, y: 0, faceAnchored: false };
  }

  // Resolve active crop window at time t
  const crop = resolveSmartFrameCropAtTime(reframingTrack, time);
  if (!crop || !Number.isFinite(crop.x) || !Number.isFinite(crop.width)) {
    return { x: 0, y: 0, faceAnchored: false };
  }

  // Find face detection nearest to this timestamp
  let faceCenter = null;
  const detections = extractGenuineFaceDetections(faceDetections);
  if (detections.length > 0) {
    const validDetections = detections.filter((d) => d && Number.isFinite(Number(d.time ?? d.timestamp)));
    if (validDetections.length > 0) {
      const closest = validDetections.reduce((prev, curr) => {
        const currT = Number(curr.time ?? curr.timestamp);
        const prevT = Number(prev.time ?? prev.timestamp);
        return Math.abs(currT - time) < Math.abs(prevT - time) ? curr : prev;
      }, validDetections[0]);

      const faces = (Array.isArray(closest.faces) ? closest.faces : []).filter((f) => isGenuineFaceBox(f?.box || f));
      if (faces.length > 0) {
        let primary = faces[0];
        if (faces.length > 1) {
          const targetSpk = crop?.activeSpeakerId || reframingTrack?.metadata?.activeSpeakerIds?.[0];
          const matchedSpeaker = targetSpk ? faces.find((f) => (f.id || f.box?.id || f.raw?.id) === targetSpk) : null;
          if (matchedSpeaker) {
            primary = matchedSpeaker;
          } else {
            const cropCenterX = crop.x + crop.width / 2;
            let closestDist = Infinity;
            for (const f of faces) {
              const b = f.box || f;
              const fx = Number(b.xMin ?? b.x ?? 0.5);
              const fw = Number(b.width ?? (Number(b.xMax ?? fx) - fx));
              const cx = fx + fw / 2;
              const dist = Math.abs(cx - cropCenterX);
              if (dist < closestDist) {
                closestDist = dist;
                primary = f;
              }
            }
          }
        }
        const box = primary.box || primary;
        const fx = Number.isFinite(box.x) ? box.x : (Number.isFinite(box.xMin) ? box.xMin : 0.5);
        const fw = Number.isFinite(box.width) ? box.width : (Number.isFinite(box.xMax) ? box.xMax - fx : 0.15);
        const fy = Number.isFinite(box.y) ? box.y : (Number.isFinite(box.yMin) ? box.yMin : 0.3);
        const fh = Number.isFinite(box.height) ? box.height : (Number.isFinite(box.yMax) ? box.yMax - fy : 0.2);
        faceCenter = {
          x: fx + fw / 2,
          y: fy + fh * 0.35, // Eye level
        };
      }
    }
  }

  // If no explicit raw detections supplied, infer face location from the crop itself
  if (!faceCenter) {
    if (reframingTrack.detectionCount === 0 || reframingTrack.isFallback) {
      return { x: 0, y: 0, faceAnchored: false };
    }
    faceCenter = {
      x: crop.x + crop.width / 2,
      y: crop.y + crop.height * 0.35,
    };
  }

  // Calculate face position relative to the reframed 9:16 crop window:
  // localX, localY in [0, 1] relative to the active crop
  const localX = clamp((faceCenter.x - crop.x) / Math.max(0.001, crop.width), 0, 1);
  const localY = clamp((faceCenter.y - crop.y) / Math.max(0.001, crop.height), 0, 1);

  // Shift viewport so that face is framed at target (x: 0.5, y: 0.35 upper third headroom)
  const targetX = 0.5;
  const targetY = 0.35;
  const rawX = -(localX - targetX) * 100 * normScale;
  const rawY = -(localY - targetY) * 100 * normScale;

  const clamped = clampPunchInOffsets(rawX, rawY, normScale);

  return {
    ...clamped,
    faceAnchored: true,
  };
}

/**
 * Discovers speech-paced visual punch-in moments for an AI Shorts Studio candidate.
 *
 * Coordinates:
 * - Sentence boundaries and word-level timestamps (snaps to word start, never mid-word).
 * - Spoken emphasis and transition scoring (no arbitrary time-based zooms).
 * - Cadence control & minimum spacing (prevents fatigue from rapid zooming).
 * - Priority 2 dynamic reframing track (centers on active face and preserves headroom).
 * - Scene-cut collision resolution (clamps duration so zooms never cross cuts).
 * - Overlap merging.
 *
 * @param {object} params
 * @param {object} params.candidate - Short candidate object
 * @param {Array} params.sentences - Array of sentence objects from groupTranscriptIntoSentences
 * @param {Array} params.captionSegments - Array of caption segments
 * @param {object} params.reframingTrack - Dynamic SmartFrame reframing track
 * @param {Array} params.sceneCuts - Scene cut timestamps in absolute media time
 * @param {Array} params.faceDetections - Raw face detection samples
 * @param {object} params.options - User settings override
 * @returns {Array<object>} Normalized punch-in moments
 */
export function detectSpeechPacedPunchIns({
  candidate = {},
  sentences = [],
  captionSegments = [],
  reframingTrack = null,
  sceneCuts = [],
  faceDetections = [],
  options = {},
} = {}) {
  const clipStart = Math.max(0, Number(candidate?.startTime) || 0);
  const rawEnd = Number(candidate?.endTime);
  const clipEnd = Number.isFinite(rawEnd) && rawEnd > clipStart
    ? rawEnd
    : clipStart + Math.max(1, Number(candidate?.duration) || 15);
  const clipDuration = Math.max(0.5, Number((clipEnd - clipStart).toFixed(3)));

  // If clip is very short (< 6s), punch-ins create visual chaos; return empty
  if (clipDuration < 6.0) {
    return [];
  }

  const scale = normalizePunchInScale(options.scale, SHORTS_PUNCHIN_DEFAULTS.scale);
  const defaultDuration = normalizePunchInDuration(options.duration, clipDuration);
  const minSpacing = Math.max(2.5, Number(options.minSpacing) || SHORTS_PUNCHIN_DEFAULTS.minSpacing);
  const transition = normalizePunchInTransition(options.transition || SHORTS_PUNCHIN_DEFAULTS.transition);
  const transitionDuration = Number.isFinite(Number(options.transitionDuration))
    ? Number(options.transitionDuration)
    : SHORTS_PUNCHIN_DEFAULTS.transitionDuration;

  // Re-anchor scene cuts relative to candidate start (0..clipDuration)
  const localCuts = (Array.isArray(sceneCuts) ? sceneCuts : [])
    .map((c) => {
      const cutTime = Number(c?.timestamp ?? c?.time ?? c);
      return Number.isFinite(cutTime) ? Number((cutTime - clipStart).toFixed(3)) : NaN;
    })
    .filter((c) => Number.isFinite(c) && c > 0.2 && c < clipDuration - 0.2)
    .sort((a, b) => a - b);

  // Filter and re-anchor sentences inside candidate interval
  const candidateSentences = (Array.isArray(sentences) ? sentences : [])
    .filter((s) => s && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > clipStart && s.start < clipEnd)
    .map((s) => ({
      ...s,
      localStart: Math.max(0, Number((s.start - clipStart).toFixed(3))),
      localEnd: Math.min(clipDuration, Number((s.end - clipStart).toFixed(3))),
      words: Array.isArray(s.words)
        ? s.words
            .filter((w) => w && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > clipStart && w.start < clipEnd)
            .map((w) => ({
              ...w,
              localStart: Math.max(0, Number((w.start - clipStart).toFixed(3))),
              localEnd: Math.min(clipDuration, Number((w.end - clipStart).toFixed(3))),
            }))
        : [],
    }))
    .sort((a, b) => a.localStart - b.localStart);

  // Filter and re-anchor captions inside candidate interval
  const candidateCaptions = (Array.isArray(captionSegments) ? captionSegments : [])
    .filter((c) => c && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > clipStart && c.start < clipEnd)
    .map((c) => ({
      ...c,
      localStart: Math.max(0, Number((c.start - clipStart).toFixed(3))),
      localEnd: Math.min(clipDuration, Number((c.end - clipStart).toFixed(3))),
      words: Array.isArray(c.words)
        ? c.words
            .filter((w) => w && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > clipStart && w.start < clipEnd)
            .map((w) => ({
              ...w,
              localStart: Math.max(0, Number((w.start - clipStart).toFixed(3))),
              localEnd: Math.min(clipDuration, Number((w.end - clipStart).toFixed(3))),
            }))
        : [],
    }))
    .sort((a, b) => a.localStart - b.localStart);

  const rawCandidateMoments = [];

  // =========================================================================
  // Strategy A: Speech-Driven Emphasis Detection
  // =========================================================================
  if (candidateSentences.length > 0 || candidateCaptions.length > 0) {
    // 1. Evaluate sentences for emphasis
    for (let i = 0; i < candidateSentences.length; i++) {
      const sentence = candidateSentences[i];
      const sScore = scoreEmphasisWeight(sentence, null, {
        index: i,
        totalSentences: candidateSentences.length,
        clipDuration,
      });

      if (sScore >= 35) {
        let punchInTime = sentence.localStart;

        // If word-level timing is available, locate the exact emphasized word
        // and ensure the punch-in begins cleanly at the start of that word
        const wordsList = (sentence.words && sentence.words.length > 0)
          ? sentence.words
          : (candidateCaptions.find(
              (c) => Math.abs(c.localStart - sentence.localStart) < 1.0 && c.words?.length
            )?.words || []);

        if (wordsList.length > 0) {
          const emphasizedWord = wordsList.find(
            (w) => scoreEmphasisWeight(sentence, w, { index: i, totalSentences: candidateSentences.length }) >= 25
          );
          if (emphasizedWord && Number.isFinite(emphasizedWord.localStart)) {
            punchInTime = emphasizedWord.localStart;
          }
        }

        rawCandidateMoments.push({
          time: punchInTime,
          score: sScore,
          reason: sentence.isQuestion ? "question_opening" : (i === 0 ? "hook" : "transition"),
        });
      }
    }

    // 2. Scan captions for word-level emphasis with post-pause delivery
    for (const cap of candidateCaptions) {
      if (!Array.isArray(cap.words)) continue;
      for (let w = 1; w < cap.words.length; w++) {
        const prevWord = cap.words[w - 1];
        const currWord = cap.words[w];
        const pauseBefore = currWord.localStart - prevWord.localEnd;

        // A deliberate pause (>= 0.35s) before an explanatory word indicates vocal emphasis
        if (pauseBefore >= 0.35 && currWord.localStart >= SHORTS_PUNCHIN_DEFAULTS.guardStart) {
          const wScore = scoreEmphasisWeight(null, currWord);
          if (wScore >= 25) {
            rawCandidateMoments.push({
              time: currWord.localStart,
              score: wScore + 15,
              reason: "vocal_pause_emphasis",
            });
          }
        }
      }
    }
  }

  // =========================================================================
  // Strategy B: Fallback for Visual / Transcript-Free Clips ONLY
  // (Do not invent arbitrary zooms if speech is present but monotone)
  // =========================================================================
  if (candidateSentences.length === 0 && candidateCaptions.length === 0) {
    if (clipDuration >= 8.0) {
      const fallbackTime = Math.max(SHORTS_PUNCHIN_DEFAULTS.guardStart, Number((clipDuration * 0.28).toFixed(3)));
      rawCandidateMoments.push({
        time: fallbackTime,
        score: 50,
        reason: "visual_cadence_fallback",
      });
    }
  }

  // =========================================================================
  // Cadence, Spacing, Guard Bands, and Deduplication
  // =========================================================================
  // Rank moments by score descending to pick the most impactful moments first
  const sortedByScore = [...rawCandidateMoments].sort((a, b) => b.score - a.score);

  // Maximum punch-ins allowed per clip to prevent visual fatigue
  const maxEvents = clipDuration <= 20 ? 1 : (clipDuration <= 40 ? 2 : 3);
  const pickedMoments = [];

  for (const moment of sortedByScore) {
    let tStart = moment.time;

    // Enforce guard start (don't punch in during opening 0.5s)
    if (tStart < SHORTS_PUNCHIN_DEFAULTS.guardStart) {
      tStart = SHORTS_PUNCHIN_DEFAULTS.guardStart;
    }

    // Enforce guard end (don't start punch-in within last 1.2s)
    if (tStart >= clipDuration - 1.2) {
      continue;
    }

    // Check spacing against already picked moments
    const conflicts = pickedMoments.some((p) => Math.abs(p.time - tStart) < minSpacing);
    if (conflicts) {
      continue;
    }

    pickedMoments.push({
      ...moment,
      time: tStart,
    });

    if (pickedMoments.length >= maxEvents) {
      break;
    }
  }

  // Sort picked moments chronologically
  pickedMoments.sort((a, b) => a.time - b.time);

  const selectedMoments = [];
  let lastPunchInEnd = -Infinity;

  for (const moment of pickedMoments) {
    let tStart = moment.time;

    // Default duration
    let dur = Math.min(defaultDuration, clipDuration - tStart - SHORTS_PUNCHIN_DEFAULTS.guardEnd);
    if (dur < SHORTS_PUNCHIN_DEFAULTS.minDuration) {
      continue;
    }

    // Scene cut collision resolution:
    // If a visual cut occurs inside [tStart, tStart + dur], clamp duration
    // so punch-in ends cleanly before the shot changes!
    const cutInside = localCuts.find((cut) => cut > tStart && cut < tStart + dur);
    if (cutInside) {
      const clampedDuration = Number((cutInside - tStart - 0.12).toFixed(3));
      if (clampedDuration >= SHORTS_PUNCHIN_DEFAULTS.minDuration) {
        dur = clampedDuration;
      } else {
        // Cut happens too soon; shift punch-in to start right after the cut
        tStart = Number((cutInside + 0.15).toFixed(3));
        dur = Math.min(defaultDuration, clipDuration - tStart - SHORTS_PUNCHIN_DEFAULTS.guardEnd);
        if (dur < SHORTS_PUNCHIN_DEFAULTS.minDuration || tStart >= clipDuration - 1.2) {
          continue;
        }
      }
    }

    // Re-check spacing after any cut adjustments
    if (tStart - lastPunchInEnd < minSpacing) {
      continue;
    }

    // Face-aware focus resolution
    const offset = resolveFaceAwarePunchInOffset({
      reframingTrack,
      time: tStart + dur * 0.3, // Sample near peak of punch-in
      scale,
      faceDetections,
      manualCropX: candidate?.cropX ?? 0.5,
    });

    selectedMoments.push({
      id: `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      time: Number(tStart.toFixed(3)),
      tStart: Number(tStart.toFixed(3)),
      duration: Number(dur.toFixed(3)),
      scale,
      transition,
      transitionDuration,
      faceAnchored: offset.faceAnchored,
      x: offset.x,
      y: offset.y,
      reason: moment.reason,
    });

    lastPunchInEnd = tStart + dur;
  }

  return selectedMoments;
}

/**
 * Builds keyframes from punch-ins and attaches them to candidate project segments.
 *
 * @param {Array} punchIns - Array of punch-in objects
 * @param {number} clipDuration - Duration in seconds
 * @returns {Array<object>} Compiled transform keyframes
 */
export function buildSpeechPacedPunchInKeyframes(punchIns = [], clipDuration = 15) {
  return compilePunchInKeyframes([], punchIns, clipDuration);
}

/**
 * Applies speech-paced punch-ins to an AI Shorts candidate.
 *
 * @param {object} candidate - Short candidate object
 * @param {Array} punchIns - Array of punch-in objects
 * @returns {object} Updated candidate with punchIns and smartZoom attached
 */
export function applySpeechPacedPunchInsToCandidate(candidate, punchIns = []) {
  if (!candidate) return candidate;

  const validPunchIns = Array.isArray(punchIns) ? punchIns : [];
  const duration = Math.max(0.5, Number(candidate.duration) || 15);
  const keyframes = compilePunchInKeyframes([], validPunchIns, duration);

  return {
    ...candidate,
    punchIns: validPunchIns,
    keyframes,
    smartZoom: {
      enabled: validPunchIns.length > 0,
      punchIns: validPunchIns,
    },
  };
}
