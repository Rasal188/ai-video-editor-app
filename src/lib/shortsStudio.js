/**
 * @file shortsStudio.js
 * AI Shorts Studio — Multi-Content Long-Form to Short-Form Video Generation Engine.
 *
 * Implements:
 * 1. Source media technical inspection (duration, dimensions, aspect ratio, audio/video streams).
 * 2. Multi-content highlight discovery:
 *    - Speech/Transcript Strategy: Thought boundary integrity, Q&A pairing, dead-air trimming.
 *    - Domain-tailored scoring across Podcasts, Tutorials, Gaming, Vlogs, Sports, Webinars, etc.
 *    - Visual/Action Strategy: Scene cut clustering and motion activity estimation.
 * 3. Intelligent title synthesis and explicit selection reasoning.
 * 4. Framing & Crop Engine:
 *    - Multi-strategy: AI Subject Tracking, Smart Zoom punch-ins, Center Crop, Safe Contain.
 *    - Horizontal pan position (`cropX`) and zoom control.
 *    - Synchronization between Canvas Preview, HTML5 player, and FFmpeg render plan.
 * 5. Candidate ranking & overlap deduplication (suppresses >40% temporal overlap).
 * 6. Timeline project conversion with re-anchored word timestamps and export plan generation.
 */

import { makeId } from "./timeline.js";
import { BUILTIN_CAPTION_STYLE_PRESETS, getCaptionStylePreset } from "./captionStyles.js";
import { detectScenesFromSignatures } from "./sceneDetection.js";
import { compilePunchInKeyframes } from "./smartZoom.js";
import { solveSmartFrameCrop, normalizeSmartFrame } from "./smartFrame.js";
import {
  selectPrimaryFace,
  solveFrameCrop,
  calculateTargetCropDimensions,
  buildDynamicReframingTrack,
  generateFallbackReframingTrack,
  applyDynamicReframingToCandidate,
  buildReframingFFmpegCropFilter,
  extractGenuineFaceDetections,
  isGenuineFaceDetection,
  hasAdequateCandidateDetections,
  needsTargetedSubjectAnalysis,
  isCandidateFallbackDueToMissingDetections,
} from "./shortsReframing.js";
import {
  scoreEmphasisWeight,
  resolveFaceAwarePunchInOffset,
  detectSpeechPacedPunchIns,
  buildSpeechPacedPunchInKeyframes,
  applySpeechPacedPunchInsToCandidate,
  SHORTS_PUNCHIN_DEFAULTS,
} from "./shortsPunchIns.js";
import {
  NARRATIVE_STAGES,
  classifySentenceNarrativeStage,
  computeThematicContinuity,
  clusterNarrativeArcs,
  evaluateNarrativeArcCompleteness,
  optimizeCandidateArcBoundaries,
} from "./shortsNarrativeClustering.js";

import {
  DEFAULT_AUDIO_ANALYSIS_OPTIONS,
  sanitizeAudioInput,
  analyzeAudioEnergy,
  estimatePitchAutocorrelation,
  alignAudioFeaturesWithTranscript,
  evaluateCandidateAcousticAlignment,
  checkVocalBoundarySafety,
} from "./shortsAudioEnergy.js";

import {
  DEFAULT_SHORTS_OVERLAY_OPTIONS,
  extractSalientKeywords,
  scoreAssetRelevance,
  generateCalloutSvgDataUrl,
  resolveOverlayPlacement,
  detectOverlayOpportunities,
  planShortOverlays,
  applyOverlaysToCandidate,
} from "./shortsOverlays.js";

import {
  DEFAULT_MOTION_TYPOGRAPHY_OPTIONS,
  MOTION_ANIMATION_STYLES,
  validateWordTimestamps,
  sanitizeWordTimestamps,
  scoreWordEmphasis,
  buildKineticWordTimeline,
  detectAnimatedCaptionCallouts,
  resolveSafeCaptionPlacement,
  resolveSoundAccents,
  planMotionTypography,
  applyMotionTypographyToCandidate,
} from "./shortsMotionTypography.js";

import {
  SUPPORTED_REPACKAGING_RATIOS,
  REPACKAGING_RATIO_DEFINITIONS,
  normalizeTargetRatio,
  getRepackagingRatioDefinition,
  resolvePlatformSafeArea,
  calculateRepackagingCrop,
  resolveTitleCardLayout,
  adaptPunchInsForTargetRatio,
  adaptOverlaysForTargetRatio,
  adaptCaptionsForTargetRatio,
  repackageShortCandidate,
  batchRepackageCandidate,
  buildMultiFormatExportSpecs,
} from "./shortsRepackaging.js";

import {
  DEFAULT_SHORTS_TRANSITION_OPTIONS,
  SHORTS_TRANSITION_TYPES,
  normalizeTransitionType,
  mapTransitionToFfmpegXfade,
  detectBrollCutawayOpportunities,
  scoreAndSelectBrollAsset,
  selectTransitionForContext,
  resolveTransitionCollisions,
  planShortTransitionsAndBroll,
  applyTransitionsAndBrollToCandidate,
  applyTransitionsToProject,
} from "./shortsTransitions.js";

export {
  selectPrimaryFace,
  solveFrameCrop,
  calculateTargetCropDimensions,
  buildDynamicReframingTrack,
  generateFallbackReframingTrack,
  applyDynamicReframingToCandidate,
  buildReframingFFmpegCropFilter,
  scoreEmphasisWeight,
  resolveFaceAwarePunchInOffset,
  detectSpeechPacedPunchIns,
  buildSpeechPacedPunchInKeyframes,
  applySpeechPacedPunchInsToCandidate,
  SHORTS_PUNCHIN_DEFAULTS,
  NARRATIVE_STAGES,
  classifySentenceNarrativeStage,
  computeThematicContinuity,
  clusterNarrativeArcs,
  evaluateNarrativeArcCompleteness,
  optimizeCandidateArcBoundaries,
  DEFAULT_AUDIO_ANALYSIS_OPTIONS,
  sanitizeAudioInput,
  analyzeAudioEnergy,
  estimatePitchAutocorrelation,
  alignAudioFeaturesWithTranscript,
  evaluateCandidateAcousticAlignment,
  checkVocalBoundarySafety,
  DEFAULT_SHORTS_OVERLAY_OPTIONS,
  extractSalientKeywords,
  scoreAssetRelevance,
  generateCalloutSvgDataUrl,
  resolveOverlayPlacement,
  detectOverlayOpportunities,
  planShortOverlays,
  applyOverlaysToCandidate,
  DEFAULT_MOTION_TYPOGRAPHY_OPTIONS,
  MOTION_ANIMATION_STYLES,
  validateWordTimestamps,
  sanitizeWordTimestamps,
  scoreWordEmphasis,
  buildKineticWordTimeline,
  detectAnimatedCaptionCallouts,
  resolveSafeCaptionPlacement,
  resolveSoundAccents,
  planMotionTypography,
  applyMotionTypographyToCandidate,
  SUPPORTED_REPACKAGING_RATIOS,
  REPACKAGING_RATIO_DEFINITIONS,
  normalizeTargetRatio,
  getRepackagingRatioDefinition,
  resolvePlatformSafeArea,
  calculateRepackagingCrop,
  resolveTitleCardLayout,
  adaptPunchInsForTargetRatio,
  adaptOverlaysForTargetRatio,
  adaptCaptionsForTargetRatio,
  repackageShortCandidate,
  batchRepackageCandidate,
  buildMultiFormatExportSpecs,
  DEFAULT_SHORTS_TRANSITION_OPTIONS,
  SHORTS_TRANSITION_TYPES,
  normalizeTransitionType,
  mapTransitionToFfmpegXfade,
  detectBrollCutawayOpportunities,
  scoreAndSelectBrollAsset,
  selectTransitionForContext,
  resolveTransitionCollisions,
  planShortTransitionsAndBroll,
  applyTransitionsAndBrollToCandidate,
  applyTransitionsToProject,
};

export const SHORTS_CONTENT_TYPES = Object.freeze([
  { id: "auto", label: "Auto-detect", description: "Automatically detect format from audio and visual cues" },
  { id: "podcast", label: "Podcast / Conversation", description: "Dialogue exchanges, discussions, and personal stories" },
  { id: "interview", label: "Interview / Q&A", description: "Host questions followed by substantive guest answers" },
  { id: "education", label: "Education / Deep-dive", description: "Clear explanations, key concepts, and takeaways" },
  { id: "tutorial", label: "Tutorial / How-to", description: "Step-by-step instructions, actionable tips, and outcomes" },
  { id: "gaming", label: "Gaming / Gameplay", description: "Fast-paced action, clutch plays, hype reactions, and commentary" },
  { id: "livestream", label: "Livestream / Highlights", description: "Chat interactions, funny moments, and stream highlights" },
  { id: "vlog", label: "Vlog / Lifestyle", description: "Personal stories, engaging moments, and travel highlights" },
  { id: "travel", label: "Travel / Exploration", description: "Scenic transitions, destination highlights, and discoveries" },
  { id: "cooking", label: "Cooking / Recipe", description: "Preparation steps, culinary tips, and final dish presentation" },
  { id: "fitness", label: "Fitness / Workout", description: "Exercise demonstrations, form tips, and motivation" },
  { id: "sports", label: "Sports / Action", description: "High-energy movement, scoring plays, and action peaks" },
  { id: "news_commentary", label: "Commentary / Opinion", description: "Bold thesis statements, arguments, and hot takes" },
  { id: "product_demo", label: "Product Demo", description: "Feature walk-throughs, problem-to-solution demonstrations" },
  { id: "webinar", label: "Webinar / Presentation", description: "Structured presentations, slides, and speaker keynotes" },
  { id: "other", label: "Other", description: "General long-form video content analysis" },
]);

export const SHORTS_ASPECT_RATIOS = Object.freeze([
  { id: "9:16", label: "Vertical 9:16", width: 1080, height: 1920, target: "YouTube Shorts / TikTok / Reels" },
  { id: "1:1", label: "Square 1:1", width: 1080, height: 1080, target: "Instagram Feed / LinkedIn" },
  { id: "4:5", label: "Portrait Feed 4:5", width: 1080, height: 1350, target: "Instagram Feed / Facebook" },
  { id: "16:9", label: "Landscape 16:9", width: 1920, height: 1080, target: "Standard Video" },
]);

export const SHORTS_DURATION_PRESETS = Object.freeze([
  { id: "15-30", label: "15–30 seconds", minDuration: 15, maxDuration: 30, idealDuration: 25 },
  { id: "30-60", label: "30–60 seconds", minDuration: 30, maxDuration: 60, idealDuration: 45 },
  { id: "60-90", label: "60–90 seconds", minDuration: 60, maxDuration: 90, idealDuration: 75 },
  { id: "custom", label: "Custom", minDuration: 10, maxDuration: 120, idealDuration: 45 },
]);

export const SHORTS_PREFERENCES = Object.freeze([
  { id: "best", label: "Best moments", description: "Highest overall impact, strong hooks, and complete payoff" },
  { id: "educational", label: "Educational", description: "Focus on informative explanations and clear takeaways" },
  { id: "funny", label: "Funny / Humorous", description: "High energy, punchlines, and reaction peaks" },
  { id: "storytelling", label: "Storytelling", description: "Narrative arc with setup, conflict, and resolution" },
  { id: "emotional", label: "Emotional", description: "Reflective and heartfelt moments" },
  { id: "opinion", label: "Strong opinions", description: "Bold claims, contrarian thoughts, and debates" },
  { id: "visual_highlights", label: "Visual highlights", description: "Significant visual change, motion, and action" },
  { id: "balanced", label: "Balanced selection", description: "A varied mix of candidate types" },
]);

export const SHORTS_FRAMING_MODES = Object.freeze([
  { id: "smart-subject", label: "AI Subject Tracking", description: "Automatically tracks and centers speaker face or subject in vertical view" },
  { id: "smart-zoom", label: "AI Smart Zoom & Punch-ins", description: "Rhythmic punch-in zooms at hook and emphasis moments" },
  { id: "center", label: "Center Crop", description: "Clean center crop preserving horizontal balance" },
  { id: "safe-contain", label: "Safe Contain (Blurred Fill)", description: "Full wide frame without cropping; ambient blurred background" },
]);

export const DEFAULT_SHORTS_SETTINGS = Object.freeze({
  contentType: "auto",
  aspectRatio: "9:16",
  durationPreset: "30-60",
  customMinDuration: 20,
  customMaxDuration: 60,
  clipCount: 4,
  preference: "best",
  captionPresetId: "bold",
  autoReframing: "smart-zoom", // "smart-zoom" | "smart-subject" | "center" | "safe-contain" | "none"
  framingMode: "smart-zoom",
  cropX: 0.5,
  preserveAudio: true,
  removePauses: false,
});

/**
 * Validates and normalizes user shorts generation settings.
 */
export function normalizeShortsSettings(userSettings = {}) {
  const contentType = SHORTS_CONTENT_TYPES.some((c) => c.id === userSettings.contentType)
    ? userSettings.contentType
    : DEFAULT_SHORTS_SETTINGS.contentType;

  const aspectRatio = SHORTS_ASPECT_RATIOS.some((r) => r.id === userSettings.aspectRatio)
    ? userSettings.aspectRatio
    : DEFAULT_SHORTS_SETTINGS.aspectRatio;

  const durationPreset = SHORTS_DURATION_PRESETS.some((d) => d.id === userSettings.durationPreset)
    ? userSettings.durationPreset
    : DEFAULT_SHORTS_SETTINGS.durationPreset;

  const presetDef = SHORTS_DURATION_PRESETS.find((d) => d.id === durationPreset);
  let minDuration = presetDef ? presetDef.minDuration : 30;
  let maxDuration = presetDef ? presetDef.maxDuration : 60;

  if (durationPreset === "custom") {
    const customMin = Number(userSettings.customMinDuration);
    const customMax = Number(userSettings.customMaxDuration);
    minDuration = Number.isFinite(customMin) && customMin >= 5 ? Math.max(5, Math.min(180, customMin)) : 20;
    maxDuration = Number.isFinite(customMax) && customMax >= minDuration ? Math.max(minDuration, Math.min(300, customMax)) : Math.max(minDuration + 10, 60);
  }

  const rawCount = Number(userSettings.clipCount);
  const clipCount = Number.isFinite(rawCount) && rawCount >= 1 ? Math.min(12, Math.max(1, Math.round(rawCount))) : DEFAULT_SHORTS_SETTINGS.clipCount;

  const preference = SHORTS_PREFERENCES.some((p) => p.id === userSettings.preference)
    ? userSettings.preference
    : DEFAULT_SHORTS_SETTINGS.preference;

  const captionPresetId = typeof userSettings.captionPresetId === "string" ? userSettings.captionPresetId : DEFAULT_SHORTS_SETTINGS.captionPresetId;
  const autoReframing = ["smart-zoom", "smart-subject", "center", "safe-contain", "none"].includes(userSettings.autoReframing)
    ? userSettings.autoReframing
    : (userSettings.framingMode || DEFAULT_SHORTS_SETTINGS.autoReframing);

  const cropX = Number.isFinite(userSettings.cropX) ? Math.max(0, Math.min(1, userSettings.cropX)) : 0.5;

  return {
    contentType,
    aspectRatio,
    durationPreset,
    minDuration,
    maxDuration,
    clipCount,
    preference,
    captionPresetId,
    autoReframing,
    framingMode: autoReframing,
    cropX,
    preserveAudio: userSettings.preserveAudio !== false,
    removePauses: Boolean(userSettings.removePauses),
    ...(userSettings.faceDetections ? { faceDetections: userSettings.faceDetections } : {}),
    ...(userSettings.smartFrame ? { smartFrame: userSettings.smartFrame } : {}),
    ...(userSettings.sourceSize ? { sourceSize: userSettings.sourceSize } : {}),
  };
}

/**
 * Inspects a source video clip or asset to extract available technical metadata.
 */
export function inspectSourceMetadata(source) {
  if (!source) {
    return {
      valid: false,
      duration: 0,
      width: 0,
      height: 0,
      hasVideo: false,
      hasAudio: false,
      error: "MISSING_SOURCE_MEDIA",
    };
  }

  const duration = Number(source.duration || source.sourceDuration || 0);
  const width = Number(source.width || source.naturalWidth || source.videoWidth || 1920);
  const height = Number(source.height || source.naturalHeight || source.videoHeight || 1080);
  const hasVideo = Boolean(source.type === "video" || source.video || (source.name && /\.(mp4|webm|mov|mkv)$/i.test(source.name)) || source.src);
  const hasAudio = source.hasAudio !== false;

  return {
    valid: Number.isFinite(duration) && duration > 0,
    duration: Math.max(0, duration),
    width: Math.max(0, width),
    height: Math.max(0, height),
    aspectRatio: width && height ? width / height : 16 / 9,
    hasVideo,
    hasAudio,
    name: source.name || "source-video.mp4",
  };
}

/**
 * Extracts cohesive sentences and conversational thoughts from caption segments.
 * Groups word chunks into complete sentences by punctuation and timing pauses.
 */
export function groupTranscriptIntoSentences(captionSegments = []) {
  if (!Array.isArray(captionSegments) || !captionSegments.length) return [];

  const sentences = [];
  let currentGroup = [];
  let currentStart = null;
  let currentEnd = null;

  const sentenceTerminators = /[.!?。！？](\s|$)/;
  const commaOrPause = /[,，;；](\s|$)/;
  const leadingConjunctionRegex = /^(and\s+|so\s+|but\s+|because\s+|also\s+|or\s+|then\s+|因此|并且|但是|而且|然后)/i;

  for (let i = 0; i < captionSegments.length; i++) {
    const seg = captionSegments[i];
    const text = (seg.text || "").trim();
    if (!text) continue;

    const segStart = Number.isFinite(seg.start) ? seg.start : 0;
    const segEnd = Number.isFinite(seg.end) ? seg.end : segStart + 1;

    if (currentStart === null) currentStart = segStart;
    currentEnd = segEnd;
    currentGroup.push(seg);

    const isTerminated = sentenceTerminators.test(text);
    const nextSeg = captionSegments[i + 1];
    const pauseAfter = nextSeg && Number.isFinite(nextSeg.start) ? nextSeg.start - segEnd : 0;
    const isSignificantPause = pauseAfter >= 0.75;

    // Conclude sentence if punctuated or long pause or accumulated duration >= 11s
    if (isTerminated || isSignificantPause || (currentEnd - currentStart >= 11 && commaOrPause.test(text))) {
      const sentenceText = currentGroup.map((s) => s.text).join(" ").trim();
      sentences.push({
        id: `sent-${sentences.length + 1}`,
        text: sentenceText,
        start: currentStart,
        end: currentEnd,
        duration: Math.max(0.2, currentEnd - currentStart),
        segments: [...currentGroup],
        isQuestion: /\?|？/.test(sentenceText),
        hasPunctuation: isTerminated,
        hasLeadingConjunction: leadingConjunctionRegex.test(sentenceText),
        wordCount: sentenceText.split(/\s+/).length,
      });
      currentGroup = [];
      currentStart = null;
      currentEnd = null;
    }
  }

  // Flush remaining trailing segments as final thought
  if (currentGroup.length && currentStart !== null && currentEnd !== null) {
    const sentenceText = currentGroup.map((s) => s.text).join(" ").trim();
    sentences.push({
      id: `sent-${sentences.length + 1}`,
      text: sentenceText,
      start: currentStart,
      end: currentEnd,
      duration: Math.max(0.2, currentEnd - currentStart),
      segments: [...currentGroup],
      isQuestion: /\?|？/.test(sentenceText),
      hasPunctuation: sentenceTerminators.test(sentenceText),
      hasLeadingConjunction: leadingConjunctionRegex.test(sentenceText),
      wordCount: sentenceText.split(/\s+/).length,
    });
  }

  return sentences;
}

/**
 * Common English and conversational stop words ignored during semantic topic extraction.
 */
const COMMON_STOP_WORDS = new Set([
  "a", "about", "above", "after", "again", "against", "all", "am", "an", "and", "any", "are",
  "aren't", "as", "at", "be", "because", "been", "before", "being", "below", "between", "both",
  "but", "by", "can't", "cannot", "could", "couldn't", "did", "didn't", "do", "does", "doesn't",
  "doing", "don't", "down", "during", "each", "few", "for", "from", "further", "had", "hadn't",
  "has", "hasn't", "have", "haven't", "having", "he", "he'd", "he'll", "he's", "her", "here",
  "hers", "herself", "him", "himself", "his", "how", "i", "i'd", "i'll", "i'm", "i've", "if",
  "in", "into", "is", "isn't", "it", "it's", "its", "itself", "let's", "me", "more", "most",
  "mustn't", "my", "myself", "no", "nor", "not", "of", "off", "on", "once", "only", "or",
  "other", "ought", "our", "ours", "ourselves", "out", "over", "own", "same", "shan't", "she",
  "she'd", "she'll", "she's", "should", "shouldn't", "so", "some", "such", "than", "that",
  "that's", "the", "their", "theirs", "them", "themselves", "then", "there", "there's", "these",
  "they", "they'd", "they'll", "they're", "they've", "this", "those", "through", "to", "too",
  "under", "until", "up", "very", "was", "wasn't", "we", "we'd", "we'll", "we're", "we've",
  "were", "weren't", "what", "what's", "when", "when's", "where", "where's", "which", "while",
  "who", "who's", "whom", "why", "why's", "with", "won't", "would", "wouldn't", "you", "you'd",
  "you'll", "you're", "you've", "your", "yours", "yourself", "yourselves"
]);

/**
 * Extracts lowercase content terms (nouns, verbs, adjectives, domain keywords)
 * ignoring purely structural punctuation and grammatical stop-words.
 */
export function extractContentWords(text = "") {
  if (!text || typeof text !== "string") return [];
  return text
    .toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()?"'<>।，。！？、]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 2 && !COMMON_STOP_WORDS.has(w));
}

/**
 * Evaluates semantic opening hook qualities:
 * 1. Inquiry & Question Framing
 * 2. Bold Thesis & Principle Statements
 * 3. Counter-Intuitions & Contrasts
 * 4. Problem & Conflict Inciting Setups
 * 5. Curiosity Gaps & High-Stakes Revelations
 * 6. Checks against buzzword stuffing (incoherent concatenation of keywords)
 */
export function evaluateSentenceHookSemantic(sentence, contentType = "auto") {
  if (!sentence) return { score: 0, factors: [], isSemanticHook: false };
  const sentenceObj = typeof sentence === "string" ? { text: sentence, isQuestion: sentence.includes("?") } : sentence;
  const rawText = (sentenceObj.text || "").trim();
  const text = rawText.toLowerCase();

  let score = 50;
  const factors = [];

  // 1. Direct or Indirect Question
  const isDirectQuestion = Boolean(sentenceObj.isQuestion || /[?？]/.test(rawText));
  const isIndirectQuestion = /\b(?:wondered if|wonder whether|question is|ask yourself|people ask why|wanted to know)\b/i.test(text);

  if (isDirectQuestion) {
    const wordCount = rawText.split(/\s+/).length;
    if (wordCount >= 4) {
      score += 24;
      factors.push("Substantive opening inquiry");
    } else {
      score += 10;
      factors.push("Short opening question");
    }
  } else if (isIndirectQuestion) {
    score += 18;
    factors.push("Indirect curiosity inquiry");
  }

  // 2. Bold Thesis, Core Principle, or Insight Statement
  const thesisPatterns = [
    /\b(?:there is|there's) (?:one|a) (?:fundamental|critical|massive|huge|single|key) (?:difference|reason|rule|principle|flaw)\b/i,
    /\bthe (?:single )?(?:hardest|biggest|greatest|toughest|best|most (?:important|critical|common|effective|overlooked|powerful|valuable)) (?:thing|lesson|reason|habit|rule|mistake|concept|challenge|part|advice)\b/i,
    /\b(?:if you want to|before you (?:start|buy|build|hire|learn)|to truly understand)\b/i,
    /\b(?:the secret to|the truth about|the real problem with|the key to)\b/i,
    /\b(?:rule number one|golden rule|fundamental law|core principle)\b/i,
    /\b(?:nobody talks about|what most creators get wrong|what people don't realize)\b/i,
    /\b(?:核心秘密|根本区别|最重要的原则|大多数人不知道|关键在于|黄金法则)\b/
  ];
  for (const pat of thesisPatterns) {
    if (pat.test(text)) {
      score += 20;
      factors.push("Bold thesis or core principle");
      break;
    }
  }

  // 3. Contrast & Counter-Intuitive Paradox
  const contrastPatterns = [
    /\b(?:most people (?:think|assume|believe|do)|everyone (?:thinks|assumes)|you might think)\b.*?\b(?:but|however|in reality|actually|instead|in fact)\b/i,
    /\b(?:contrary to|instead of|rather than|while everyone is)\b/i,
    /\b(?:it sounds (?:crazy|counterintuitive|strange),? but)\b/i,
    /\b(?:看似|大家都以为|其实并不是|反而)\b/
  ];
  for (const pat of contrastPatterns) {
    if (pat.test(text)) {
      score += 18;
      factors.push("Counter-intuitive contrast or paradox");
      break;
    }
  }

  // 4. Inciting Narrative or High-Stakes Incident Setup
  const narrativeIncidentPatterns = [
    /\b(?:the moment (?:we|i|they)|everything changed when|it all started when|we were right in the middle of)\b/i,
    /\b(?:we (?:lost|crashed|discovered|broke|faced|spent months))\b/i,
    /\b(?:suddenly|all of a sudden|out of nowhere|within seconds)\b/i,
    /\b(?:就在那一刻|事情发生改变|我们当时遇到了|突然间)\b/
  ];
  for (const pat of narrativeIncidentPatterns) {
    if (pat.test(text)) {
      score += 16;
      factors.push("High-stakes narrative inciting incident");
      break;
    }
  }

  // 5. Quantifiable List or Actionable Guide Framing
  if (/\b\d+\s+(?:ways|reasons|things|steps|tips|mistakes|rules|secrets|lessons)\b/i.test(text) || /\d+个(技巧|方法|坑|原因|要点)/.test(text)) {
    score += 16;
    factors.push("Numbered framework or step-by-step hook");
  }

  // 6. Category-specific semantic signals
  if (contentType === "education" || contentType === "tutorial") {
    if (/\b(?:lesson|mastering|pacing|technique|step\s+\d+|here's how|first thing|how to|in this video|let's break down|tutorial|guide)\b/i.test(text)) {
      score += 14;
      factors.push("Educational actionable tutorial opening");
    }
  } else if (contentType === "gaming" || contentType === "livestream") {
    if (/\b(?:clutch|insane|watch this play|no way|what a moment|clip that|gg|unbelievable)\b/i.test(text)) {
      score += 16;
      factors.push("Gaming action peak");
    }
  } else if (contentType === "podcast" || contentType === "interview") {
    if (/\b(?:tell me about|in your experience|what was it like|the moment you realized|my guest today)\b/i.test(text)) {
      score += 14;
      factors.push("Conversational dialogue exchange setup");
    }
  }

  // 7. General curiosity triggers (lexical reinforcement)
  const lexicalTriggers = ["why", "how", "secret", "never", "always", "mistake", "truth", "revealed", "stop doing", "unbelievable"];
  const matchedTriggers = lexicalTriggers.filter((t) => text.includes(t));
  if (matchedTriggers.length > 0 && matchedTriggers.length <= 3) {
    score += 8;
  }

  // 8. Buzzword Stuffing & Word-Salad Penalty:
  // If sentence has 4+ hook buzzwords packed together without substantive content words
  if (matchedTriggers.length >= 4) {
    const contentWords = extractContentWords(rawText);
    if (contentWords.length <= matchedTriggers.length + 1) {
      score -= 28;
      factors.push("Incoherent keyword-stuffing penalty");
    }
  }

  // 9. Sentence syntax and punctuation
  if (sentenceObj.hasPunctuation) {
    score += 5;
  }

  // 10. Penalize filler beginnings
  if (/^(?:um|uh|so yeah|like|you know|basically|well|ah|eh|嗯|那个|然后呢)\b/i.test(text)) {
    score -= 16;
    factors.push("Hesitant filler opening");
  }

  // 11. Penalize isolated dangling connectives
  if (sentenceObj.hasLeadingConjunction) {
    score -= 10;
    factors.push("Dangling connective opening");
  }

  const finalScore = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score: finalScore,
    factors,
    isSemanticHook: finalScore >= 68,
  };
}

/**
 * Evaluates semantic and narrative coherence across a window of sentences:
 * 1. Thematic vocabulary continuity (shared entities and concepts).
 * 2. Discourse progression (causal, elaborative, and sequential links).
 * 3. Detection of disjointed topic jumps or keyword-salad passages.
 */
export function evaluateNarrativeCoherence(candidateSentences = []) {
  if (!Array.isArray(candidateSentences) || candidateSentences.length === 0) {
    return { score: 70, factors: ["Default single-segment baseline"] };
  }

  if (candidateSentences.length === 1) {
    const single = candidateSentences[0];
    const text = (single.text || "").trim();
    const words = extractContentWords(text);
    const score = words.length >= 3 && single.hasPunctuation ? 80 : 70;
    return { score, factors: ["Single complete thought unit"] };
  }

  let coherenceScore = 70;
  const factors = [];

  // Extract content words for each sentence
  const sentenceWordSets = candidateSentences.map((s) => new Set(extractContentWords(s.text || "")));

  // 1. Thematic continuity between consecutive sentences
  let sharedPairsCount = 0;
  let totalTransitions = candidateSentences.length - 1;

  for (let k = 0; k < totalTransitions; k++) {
    const setA = sentenceWordSets[k];
    const setB = sentenceWordSets[k + 1];

    let shared = 0;
    for (const w of setA) {
      if (setB.has(w)) shared++;
    }

    if (shared > 0) {
      sharedPairsCount++;
    }
  }

  const isQAOpening = Boolean(candidateSentences[0]?.isQuestion);
  const fullText = candidateSentences.map((s) => s?.text || "").join(" ").toLowerCase();
  const discourseMarkers = [
    /\b(?:because|therefore|as a result|which means|so that|that's why|consequently|if|when|once|in order to)\b/i, // causal & conditional
    /\b(?:for example|for instance|specifically|in fact|in particular|such as)\b/i,       // elaborative
    /\b(?:however|on the other hand|instead|but actually|in reality)\b/i,                 // contrastive
    /\b(?:first|second|then|next|finally|step\s+\d+|after that|setting your|before|requires|preserves)\b/i // sequential & practical
  ];

  let matchedDiscourseTypes = 0;
  for (const dm of discourseMarkers) {
    if (dm.test(fullText)) matchedDiscourseTypes++;
  }

  const transitionContinuityRatio = totalTransitions > 0 ? sharedPairsCount / totalTransitions : 1;
  if (transitionContinuityRatio >= 0.5) {
    coherenceScore += 16;
    factors.push("High thematic continuity between sentences");
  } else if (isQAOpening) {
    coherenceScore += 10;
    factors.push("Conversational Q&A progression structure");
  } else if (transitionContinuityRatio === 0 && candidateSentences.length >= 3 && matchedDiscourseTypes === 0) {
    // 3 or more sentences with completely disjoint topics and no logical progression
    coherenceScore -= 20;
    factors.push("Disjointed vocabulary across sentences");
  }

  // 2. Setup-to-body persistence: Do subsequent sentences develop concepts from the opening hook?
  const hookWords = sentenceWordSets[0];
  let hookRelevanceCount = 0;
  for (let k = 1; k < candidateSentences.length; k++) {
    const currentSet = sentenceWordSets[k];
    for (const hw of hookWords) {
      if (currentSet.has(hw)) {
        hookRelevanceCount++;
        break;
      }
    }
  }

  if (hookRelevanceCount > 0) {
    coherenceScore += 12;
    factors.push("Opening topic sustained throughout passage");
  }

  // 3. Discourse progression markers
  if (matchedDiscourseTypes >= 2) {
    coherenceScore += 14;
    factors.push("Strong structured discourse progression");
  } else if (matchedDiscourseTypes === 1) {
    coherenceScore += 8;
    factors.push("Clear logical progression marker");
  }

  // 4. Keyword salad / repetitiveness penalty
  const totalWords = fullText.split(/\s+/).filter(Boolean);
  const contentWords = extractContentWords(fullText);
  const uniqueContentWords = new Set(contentWords);

  if (contentWords.length >= 10 && uniqueContentWords.size / contentWords.length < 0.35) {
    coherenceScore -= 18;
    factors.push("Excessive repetitiveness / low lexical variety");
  }

  const finalScore = Math.max(0, Math.min(100, Math.round(coherenceScore)));
  return {
    score: finalScore,
    factors,
  };
}

/**
 * Evaluates whether a candidate delivers a satisfying payoff:
 * 1. Question followed by a concrete answer / explanation.
 * 2. Problem or curiosity gap resolved with a clear takeaway or conclusion.
 * 3. Penalties for cliffhangers, trailing conjunctions, or unresolved questions.
 * 4. Topical congruence between the opening setup and the closing resolution.
 * 5. Penalties for abrupt topic divergence or trailing buzzword phrases.
 */
export function evaluatePayoff(startSentence, candidateEndSentence, candidateSentences = []) {
  if (!candidateEndSentence) {
    return { score: 50, factors: ["Missing ending thought"], hasClearPayoff: false };
  }

  let payoffScore = 60;
  const factors = [];

  const endText = (candidateEndSentence.text || "").trim();
  const lowerEnd = endText.toLowerCase();
  const startIsQuestion = Boolean(startSentence?.isQuestion || /[?？]/.test(startSentence?.text || ""));
  const endIsQuestion = Boolean(candidateEndSentence.isQuestion || /[?？]/.test(endText));

  // 1. Question-Answer Resolution
  if (startIsQuestion) {
    if (endIsQuestion) {
      payoffScore -= 22;
      factors.push("Unresolved opening question (ended on question)");
    } else if (candidateEndSentence.hasPunctuation) {
      payoffScore += 26;
      factors.push("Opening question resolved with declarative answer");

      if (/\b(?:because|is to|means that|by doing|the answer is|that's why|result|solution)\b/i.test(lowerEnd)) {
        payoffScore += 8;
        factors.push("Explanatory conclusion resolving question premise");
      }
    }
  } else {
    if (endIsQuestion) {
      payoffScore -= 10;
      factors.push("Abruptly ends on unresolved question");
    } else if (candidateEndSentence.hasPunctuation) {
      payoffScore += 12;
      factors.push("Complete declarative ending thought");
    }
  }

  // 2. Concluding & Takeaway Signals
  const conclusionPatterns = [
    /\b(?:that's how|that is how|in the end|and that's why|the result was|turns out|now you know|always remember)\b/i,
    /\b(?:which means|the key takeaway|the bottom line|ultimately|all it takes)\b/i,
    /\b(?:creates|delivers|preserves|ensures|produces|yields|results in|prevents)\b/i,
    /\b(?:这就完成了|这就是为什么|最终|记住这一点|结果证明)\b/
  ];
  for (const cp of conclusionPatterns) {
    if (cp.test(lowerEnd)) {
      payoffScore += 14;
      factors.push("Strong conclusive payoff statement");
      break;
    }
  }

  // 3. Trailing Conjunction / Cliffhanger Penalty
  const trailingConjunctionRegex = /\b(?:and|but|so|because|then|or|if|when|although|while|however|因此|但是|而且|因为)$/i;
  if (trailingConjunctionRegex.test(lowerEnd.replace(/[.,/#!$%^&*;:{}=\-_`~()?"'<>]/g, ""))) {
    payoffScore -= 35;
    factors.push("Severe cliffhanger / ends on dangling connective");
  }

  // 4. Hook-to-Payoff Semantic Congruence
  if (startSentence && startSentence !== candidateEndSentence) {
    const startWords = new Set(extractContentWords(startSentence.text || ""));
    const endWords = new Set(extractContentWords(endText));

    let overlap = 0;
    for (const w of startWords) {
      if (endWords.has(w)) overlap++;
    }

    if (overlap > 0) {
      payoffScore += 10;
      factors.push("Direct semantic congruence between hook and payoff");
    }
  }

  // 5. Ending Topic Divergence (Topic Jump detection)
  if (candidateSentences.length >= 3 && !startIsQuestion) {
    const priorText = candidateSentences.slice(0, -1).map((s) => s?.text || "").join(" ");
    const priorWords = new Set(extractContentWords(priorText));
    const endWords = extractContentWords(endText);

    let priorOverlap = 0;
    for (const w of endWords) {
      if (priorWords.has(w)) priorOverlap++;
    }

    const hasConclusiveMarker = conclusionPatterns.some((cp) => cp.test(lowerEnd));
    if (priorOverlap === 0 && !hasConclusiveMarker) {
      payoffScore -= 18;
      factors.push("Ending abruptly diverges from passage topic");
    }
  }

  // 6. Clickbait Buzzword Ending Penalty
  const buzzwords = ["insane", "viral", "unbelievable", "hype", "crazy", "secret", "never knew", "watch this"];
  const buzzCount = buzzwords.filter((b) => lowerEnd.includes(b)).length;
  if (buzzCount >= 2 && extractContentWords(endText).length < 6) {
    payoffScore -= 16;
    factors.push("Ending consists of clickbait buzzwords rather than substantive conclusion");
  }

  const finalScore = Math.max(0, Math.min(100, Math.round(payoffScore)));
  return {
    score: finalScore,
    factors,
    hasClearPayoff: finalScore >= 70,
  };
}

/**
 * Evaluates composite candidate semantic quality:
 * Combines semantic opening hook, narrative coherence, and resolution payoff.
 */
export function evaluateCandidateSemantics(candidateSentences = [], contentType = "auto") {
  if (!Array.isArray(candidateSentences) || !candidateSentences.length) {
    return {
      hookScore: 50,
      coherenceScore: 70,
      payoffScore: 60,
      semanticScore: 60,
      reasons: [],
      warnings: ["Empty candidate sentence sequence"],
    };
  }

  const startSentence = candidateSentences[0];
  const endSentence = candidateSentences[candidateSentences.length - 1];

  const hookEval = evaluateSentenceHookSemantic(startSentence, contentType);
  const coherenceEval = evaluateNarrativeCoherence(candidateSentences);
  const payoffEval = evaluatePayoff(startSentence, endSentence, candidateSentences);

  const hookScore = hookEval.score;
  const coherenceScore = coherenceEval.score;
  const payoffScore = payoffEval.score;

  // Composite semantic score
  const semanticScore = Math.round(
    hookScore * 0.35 +
    coherenceScore * 0.35 +
    payoffScore * 0.30
  );

  const reasons = [];
  if (hookEval.factors.length) reasons.push(hookEval.factors[0]);
  if (payoffEval.factors.length) reasons.push(payoffEval.factors[0]);
  if (coherenceEval.factors.length) reasons.push(coherenceEval.factors[0]);

  const warnings = [];
  if (hookScore < 45) warnings.push("Weak or hesitant opening hook");
  if (coherenceScore < 50) warnings.push("Low thematic continuity across candidate thoughts");
  if (payoffScore < 50) warnings.push("Ending thought lacks clear resolution or ends abruptly");

  return {
    hookScore,
    coherenceScore,
    payoffScore,
    semanticScore,
    reasons,
    warnings,
  };
}

/**
 * Scores an opening sentence or thought based on content type and hook potential.
 * (Maintained for full backwards compatibility with legacy callers)
 */
export function scoreSentenceHook(sentence, index = 0, totalSentences = 1, contentType = "auto") {
  if (!sentence) return 0;
  if (typeof index === "string") {
    contentType = index;
    index = 0;
    totalSentences = 1;
  }
  return evaluateSentenceHookSemantic(sentence, contentType).score;
}

/**
 * Synthesizes an informative, catchy short title from candidate sentences.
 */
export function synthesizeShortTitle(sentences = [], contentType = "auto") {
  if (!sentences) return "Engaging Short Moment";
  const sentenceList = typeof sentences === "string"
    ? [{ text: sentences, isQuestion: sentences.includes("?") }]
    : (Array.isArray(sentences) ? sentences : [sentences]);
  if (!sentenceList.length) return "Engaging Short Moment";

  const firstSentence = sentenceList[0];
  const firstText = (firstSentence.text || "").trim();

  // If opening is a question, use it directly as the title (up to 70 chars, trimmed of trailing question mark)
  if (firstSentence.isQuestion && firstText.length <= 70) {
    return firstText.replace(/[?？!！]+$/, "").trim();
  }

  // Check for numbered list or "How to" pattern
  const howToMatch = firstText.match(/(how to [^.!?,\n]{8,40})/i);
  if (howToMatch) {
    return howToMatch[1].charAt(0).toUpperCase() + howToMatch[1].slice(1);
  }

  const numberMatch = firstText.match(/(\d+\s+(?:ways|reasons|steps|tips|mistakes)[^.!?,\n]{4,35})/i);
  if (numberMatch) {
    return numberMatch[1].charAt(0).toUpperCase() + numberMatch[1].slice(1);
  }

  // Strip leading filler and conjunctions
  let cleanTitle = firstText.replace(/^(and\s+|so\s+|but\s+|because\s+|also\s+|well\s+|um\s+|uh\s+|因此|并且|但是|而且|然后)+/i, "").trim();

  // If still long, take first 46 characters ending on a word boundary
  if (cleanTitle.length > 46) {
    const truncated = cleanTitle.slice(0, 46);
    const lastSpace = truncated.lastIndexOf(" ");
    cleanTitle = (lastSpace > 24 ? truncated.slice(0, lastSpace) : truncated) + "…";
  }

  return cleanTitle || "Featured Highlight";
}

/**
 * Discovers candidate moments based on speech transcript, natural sentence bounds,
 * question-answer preservation, and content type adaptation.
 */
export function discoverSpeechCandidates({
  sentences,
  mediaDuration,
  settings = {},
  sceneCuts = [],
  audioData = null,
  audioEnergy = null,
  availableAssets = [],
  options = {},
}) {
  if (!sentences || !sentences.length) return [];

  const candidates = [];
  const { minDuration = 15, maxDuration = 60, preference = "best", clipCount = 3, contentType = "general" } = settings || {};

  // Phase 2 Priority 5: Multimodal Audio Energy & Vocal Intensity
  const energyTimeline =
    settings?.audioEnergy !== false
      ? (audioEnergy || (audioData ? analyzeAudioEnergy(audioData) : (settings?.audioData ? analyzeAudioEnergy(settings.audioData) : null)))
      : null;

  // Enrich sentences with acoustic energy and vocal delivery metrics
  const targetSentences = energyTimeline?.valid
    ? alignAudioFeaturesWithTranscript(sentences, energyTimeline)
    : sentences;

  // Discover macro narrative arcs across transcript
  const narrativeArcs = settings?.narrativeClustering !== false
    ? clusterNarrativeArcs(targetSentences, { minArcDuration: Math.min(minDuration, 10), maxArcDuration: Math.max(maxDuration, 75) })
    : [];

  for (let i = 0; i < targetSentences.length; i++) {
    const startSentence = targetSentences[i];

    // Skip starting on dangling connectives if another sentence follows
    if (startSentence.hasLeadingConjunction && i + 1 < sentences.length && sentences[i + 1].start - startSentence.end < 0.5) {
      // Allow it only if the previous thought was too distant
    }

    let candidateEndSentence = startSentence;
    let accumulatedDuration = Number.isFinite(startSentence.duration)
      ? startSentence.duration
      : (Number.isFinite(startSentence.end - startSentence.start) ? startSentence.end - startSentence.start : 5);
    let sentenceCount = 1;

    if (settings?.narrativeClustering !== false) {
      const opt = optimizeCandidateArcBoundaries({
        startIndex: i,
        sentences: targetSentences,
        minDuration,
        maxDuration,
        mediaDuration,
      });
      candidateEndSentence = opt.endSentence || startSentence;
      sentenceCount = Math.max(1, opt.endIndex - i + 1);
      accumulatedDuration = opt.duration;
    } else {
      // Accumulate consecutive sentences to reach target duration without breaking thoughts
      for (let j = i + 1; j < targetSentences.length; j++) {
        const nextSentence = targetSentences[j];
        const startVal = Number.isFinite(startSentence.start) ? startSentence.start : 0;
        const endVal = Number.isFinite(nextSentence.end) ? nextSentence.end : (startVal + (Number.isFinite(nextSentence.duration) ? nextSentence.duration : 5));
        const proposedDuration = Math.max(0.5, endVal - startVal);

        if (proposedDuration > maxDuration && sentenceCount >= 2) {
          break;
        }

        candidateEndSentence = nextSentence;
        accumulatedDuration = proposedDuration;
        sentenceCount++;

        // If we've reached target minimum duration:
        if (accumulatedDuration >= minDuration) {
          // If candidate opened with a question, ensure the question has been answered!
          if (startSentence.isQuestion) {
            if (!candidateEndSentence.isQuestion && candidateEndSentence.hasPunctuation) {
              break;
            }
          } else if (candidateEndSentence.hasPunctuation) {
            // If we reached a natural punctuated sentence end within range
            break;
          }
        }
      }
    }

    if (accumulatedDuration < Math.min(minDuration, 10)) {
      continue;
    }

    let startTime = Number.isFinite(startSentence?.start) ? Math.max(0, startSentence.start) : 0;
    const safeDuration = Number.isFinite(accumulatedDuration) && accumulatedDuration > 0 ? accumulatedDuration : 15;
    let endTime = Number.isFinite(candidateEndSentence?.end)
      ? Math.min(mediaDuration, candidateEndSentence.end)
      : Math.min(mediaDuration, startTime + safeDuration);
    if (!Number.isFinite(endTime) || endTime <= startTime) {
      endTime = Math.min(mediaDuration, startTime + safeDuration);
    }

    // Dead air check: trim initial silence before speech starts
    const firstWordSeg = startSentence.segments?.[0];
    if (firstWordSeg && Number.isFinite(firstWordSeg.start) && firstWordSeg.start - startTime > 1.2) {
      startTime = Math.max(0, firstWordSeg.start - 0.2);
    }
    const lastWordSeg = candidateEndSentence.segments?.at(-1);
    if (lastWordSeg && Number.isFinite(lastWordSeg.end) && endTime - lastWordSeg.end > 1.2) {
      endTime = Math.min(mediaDuration, lastWordSeg.end + 0.3);
    }

    // Phase 2 Priority 5: Vocal boundary safety check (avoids cutting mid vocal surge)
    if (energyTimeline?.valid) {
      const boundarySafety = checkVocalBoundarySafety(endTime, energyTimeline);
      if (!boundarySafety.isSafeToCut && boundarySafety.suggestedEndTime <= mediaDuration && boundarySafety.suggestedEndTime - startTime <= maxDuration) {
        endTime = boundarySafety.suggestedEndTime;
      }
    }

    const duration = Math.max(0.5, endTime - startTime);
    if (duration < 5) continue;

    const candidateSentences = targetSentences.slice(i, i + sentenceCount);
    const combinedText = candidateSentences.map((s) => s?.text || "").filter(Boolean).join(" ");
    const lowerText = combinedText.toLowerCase();

    // Semantic hook, narrative coherence, and payoff evaluation
    const semanticEval = evaluateCandidateSemantics(candidateSentences, contentType);
    const {
      hookScore,
      coherenceScore,
      payoffScore,
      semanticScore,
      reasons: semanticReasons,
      warnings: semanticWarnings,
    } = semanticEval;

    // Semantic Narrative Arc evaluation
    const arcEval = settings?.narrativeClustering !== false
      ? evaluateNarrativeArcCompleteness(candidateSentences, narrativeArcs)
      : null;

    // Content relevance scoring based on content type and user preference
    let contentScore = 65;
    if (contentType === "podcast" || contentType === "interview") {
      if (startSentence.isQuestion && !candidateEndSentence.isQuestion) contentScore += 25;
      if (/agree|disagree|perspective|experience|story|conversation|观点|经历|故事/i.test(lowerText)) contentScore += 15;
    } else if (contentType === "education" || contentType === "tutorial") {
      if (/step|how to|because|explain|guide|remember|result|也就是说|步骤|关键|学会/i.test(lowerText)) contentScore += 25;
    } else if (contentType === "gaming" || contentType === "livestream") {
      if (/win|clutch|insane|fail|gg|moment|hype|极限|绝了|逆风/i.test(lowerText)) contentScore += 25;
    } else if (contentType === "sports") {
      if (/score|point|goal|run|speed|champion|winner|得分|进球|胜利/i.test(lowerText)) contentScore += 25;
    }

    // Additional preference weighting
    if (preference === "educational" && /how to|explain|step|guide|原因|教学|原理/i.test(lowerText)) contentScore += 15;
    if (preference === "funny" && /haha|lol|funny|joke|fail|omg|爆笑|搞笑|翻车/i.test(lowerText)) contentScore += 15;
    if (preference === "storytelling" && /one day|then|suddenly|happened|story|后来|结果|当时/i.test(lowerText)) contentScore += 15;
    if (preference === "opinion" && /believe|think|wrong|truth|honestly|我认为|其实|千万别/i.test(lowerText)) contentScore += 15;

    // Context completeness score
    const hasClearPayoff = payoffScore >= 70;
    const contextScore = hasClearPayoff ? 92 : 68;

    // Visual scene alignment score
    let visualAlignmentScore = 50;
    if (sceneCuts.length) {
      const closeStart = sceneCuts.some((cut) => Math.abs(cut - startTime) <= 1.2);
      const closeEnd = sceneCuts.some((cut) => Math.abs(cut - endTime) <= 1.2);
      if (closeStart) visualAlignmentScore += 20;
      if (closeEnd) visualAlignmentScore += 20;
    }

    // Phase 2 Priority 5: Acoustic alignment evaluation
    const acousticAlignment = energyTimeline?.valid
      ? evaluateCandidateAcousticAlignment({ startTime, endTime }, targetSentences, energyTimeline)
      : null;

    const hasAcousticData = Boolean(acousticAlignment?.metrics?.hasAcousticData);
    const acousticScore = hasAcousticData ? acousticAlignment.acousticScore : null;

    const arcCompletenessScore = arcEval ? arcEval.arcScore : 75;
    const overallScore = hasAcousticData
      ? Math.round(
          semanticScore * 0.30 +
          arcCompletenessScore * 0.15 +
          acousticScore * 0.12 +
          contentScore * 0.18 +
          contextScore * 0.15 +
          visualAlignmentScore * 0.10
        )
      : Math.round(
          semanticScore * 0.35 +
          arcCompletenessScore * 0.15 +
          contentScore * 0.20 +
          contextScore * 0.18 +
          visualAlignmentScore * 0.12
        );

    // Synthesize meaningful short title
    const title = synthesizeShortTitle(candidateSentences, contentType);

    // Formulate reason
    const reasons = [];
    if (startSentence.isQuestion && hasClearPayoff) reasons.push("Engaging opening question with complete answer payoff");
    else if (hookScore >= 70) reasons.push("Strong hook statement capturing viewer curiosity");
    if (semanticReasons.length) reasons.push(semanticReasons.join("; "));
    if (hasClearPayoff && !reasons.includes("Engaging opening question with complete answer payoff")) {
      reasons.push("Cohesive thought without mid-sentence cutoff");
    }
    if (arcEval?.isCompleteArc) {
      reasons.push("Complete narrative arc with setup, core insight, and payoff");
    }
    if (acousticAlignment?.reasons?.length) {
      reasons.push(...acousticAlignment.reasons);
    }
    if (visualAlignmentScore > 65) reasons.push("Aligns naturally with camera scene cuts");
    const reasonText = Array.from(new Set(reasons)).join("; ") || "Cohesive speech moment fitting requested short duration.";

    // Determine category label
    let category = "Dialogue Moment";
    if (startSentence.isQuestion) category = "Q&A Highlight";
    else if (contentType === "education" || contentType === "tutorial") category = "Key Takeaway";
    else if (contentType === "gaming") category = "Gameplay Moment";
    else if (contentType === "vlog" || contentType === "travel") category = "Story Beat";
    else if (preference && preference !== "best") category = `${preference.charAt(0).toUpperCase() + preference.slice(1)} Clip`;

    // Quality warnings
    const warnings = [];
    if (duration > maxDuration) warnings.push("Extended slightly to preserve sentence completion");
    if (!hasClearPayoff) warnings.push("Ending sentence may feel unresolved");
    if (startSentence.hasLeadingConjunction) warnings.push("Starts on connective phrase");
    if (semanticWarnings.length) warnings.push(...semanticWarnings);
    if (arcEval?.warnings?.length) warnings.push(...arcEval.warnings);
    if (acousticAlignment?.warnings?.length) warnings.push(...acousticAlignment.warnings);

    let plannedOverlays = [];
    let assetRequests = [];
    if (options.planOverlays || settings.planOverlays) {
      const overlayPlan = planShortOverlays({
        candidate: { startTime, endTime, duration, cropX: settings.cropX ?? 0.5, aspectRatio: settings.aspectRatio || "9:16" },
        sentences: candidateSentences,
        availableAssets: options.availableAssets || [],
        sceneCuts,
        faceDetections: options.faceDetections || [],
        acousticFeatures: acousticAlignment?.metrics,
        options: options.overlayOptions || {},
      });
      plannedOverlays = overlayPlan.overlays;
      assetRequests = overlayPlan.assetRequests;
    }

    candidates.push({
      id: `short-cand-${candidates.length + 1}-${makeId("cand")}`,
      startTime: Number(startTime.toFixed(2)),
      endTime: Number(endTime.toFixed(2)),
      duration: Number(duration.toFixed(2)),
      title,
      category,
      reason: reasonText,
      reasons: Array.from(new Set(reasons)),
      transcriptExcerpt: combinedText.slice(0, 160) + (combinedText.length > 160 ? "…" : ""),
      score: overallScore,
      hookScore,
      coherenceScore,
      payoffScore,
      semanticScore,
      contextScore,
      visualScore: visualAlignmentScore,
      narrativeArc: arcEval ? {
        arcId: arcEval.arcId,
        arcScore: arcEval.arcScore,
        stages: arcEval.stagesPresent,
        isComplete: arcEval.isCompleteArc,
      } : null,
      acousticScore,
      acousticFeatures: hasAcousticData ? {
        averageIntensity: acousticAlignment.metrics.averageIntensity,
        peakIntensity: acousticAlignment.metrics.peakIntensity,
        totalPeaks: acousticAlignment.metrics.totalPeaks,
        totalSurges: acousticAlignment.metrics.totalSurges,
        alignmentBonus: acousticAlignment.metrics.alignmentBonus,
        hasPitchData: Boolean(energyTimeline?.statistics?.hasPitchData),
      } : null,
      overlays: plannedOverlays,
      assetRequests,
      warnings,
      strategy: "speech-centric",
      framingMode: settings.autoReframing,
      cropX: settings.cropX ?? 0.5,
    });
  }

  return candidates;
}

/**
 * Discovers candidate moments based on visual scene transitions and action density.
 */
export function discoverVisualCandidates({
  mediaDuration,
  sceneCuts = [],
  settings,
}) {
  if (!Number.isFinite(mediaDuration) || mediaDuration <= 5) return [];

  const candidates = [];
  const { minDuration, maxDuration, clipCount, preference, contentType } = settings;

  const cuts = [0, ...sceneCuts.filter((c) => c > 0 && c < mediaDuration).sort((a, b) => a - b), mediaDuration];

  for (let i = 0; i < cuts.length - 1; i++) {
    const startCut = cuts[i];
    let endCut = cuts[i + 1];

    for (let j = i + 1; j < cuts.length; j++) {
      const candidateDur = cuts[j] - startCut;
      if (candidateDur >= minDuration && candidateDur <= maxDuration) {
        endCut = cuts[j];
        break;
      }
      if (candidateDur > maxDuration) break;
    }

    const duration = endCut - startCut;
    if (duration >= minDuration && duration <= maxDuration + 5) {
      const internalCutCount = cuts.filter((c) => c > startCut && c < endCut).length;
      const visualPacingScore = Math.min(95, 60 + internalCutCount * 10);

      candidates.push({
        id: `short-cand-vis-${candidates.length + 1}-${makeId("vis")}`,
        startTime: Number(startCut.toFixed(2)),
        endTime: Number(endCut.toFixed(2)),
        duration: Number(duration.toFixed(2)),
        title: `Visual Highlight (${Math.round(startCut)}s–${Math.round(endCut)}s)`,
        category: contentType === "gaming" ? "Action Sequence" : "Visual Scene",
        reason: internalCutCount > 0
          ? `Dynamic visual sequence with ${internalCutCount + 1} scene changes.`
          : "Continuous visual scene fitting short duration.",
        transcriptExcerpt: `[Visual Scene: ${startCut.toFixed(1)}s to ${endCut.toFixed(1)}s]`,
        score: visualPacingScore,
        hookScore: 65,
        coherenceScore: 70,
        payoffScore: 70,
        semanticScore: 68,
        contextScore: 75,
        visualScore: visualPacingScore,
        warnings: [
          "Visual-only analysis: speech context not evaluated",
          ...(internalCutCount === 0 ? ["Static shot without scene changes"] : []),
        ],
        strategy: "visual-centric",
        framingMode: settings.autoReframing,
        cropX: settings.cropX ?? 0.5,
      });
    }
  }

  // Fallback: If no scene cuts could be detected, generate uniform sequential high-interest blocks
  if (!candidates.length && mediaDuration >= minDuration) {
    const targetDur = Math.min(maxDuration, Math.max(minDuration, 30));
    const step = Math.max(targetDur * 0.75, (mediaDuration - targetDur) / Math.max(1, clipCount));
    let t = 0;
    let idx = 1;
    while (t + targetDur <= mediaDuration + 2 && idx <= clipCount * 2) {
      const start = Number(t.toFixed(2));
      const end = Number(Math.min(mediaDuration, t + targetDur).toFixed(2));
      candidates.push({
        id: `short-cand-seq-${idx}-${makeId("seq")}`,
        startTime: start,
        endTime: end,
        duration: Number((end - start).toFixed(2)),
        title: `Visual Highlight Sequence ${idx}`,
        category: "Visual Sequence",
        reason: "Evenly paced visual duration window preserving continuous motion.",
        transcriptExcerpt: `[Visual Sequence: ${Math.round(start)}s to ${Math.round(end)}s]`,
        score: 70 - idx * 2,
        hookScore: 60,
        coherenceScore: 70,
        payoffScore: 70,
        semanticScore: 65,
        contextScore: 70,
        visualScore: 65,
        warnings: ["Generated from video timeline without transcript or scene cut markers"],
        strategy: "visual-uniform",
        framingMode: settings.autoReframing,
        cropX: settings.cropX ?? 0.5,
      });
      t += step;
      idx++;
    }
  }

  return candidates;
}

/**
 * Deduplicates overlapping candidates. If two candidates overlap by more than 40%
 * of their respective durations, suppresses the lower-scoring candidate.
 */
export function deduplicateAndRankCandidates(candidates = [], maxCount = 4) {
  if (!Array.isArray(candidates) || !candidates.length) return [];

  const sorted = [...candidates].sort((a, b) => (b.score || 0) - (a.score || 0));
  const accepted = [];

  for (const candidate of sorted) {
    let hasExcessiveOverlap = false;

    for (const chosen of accepted) {
      const overlapStart = Math.max(candidate.startTime, chosen.startTime);
      const overlapEnd = Math.min(candidate.endTime, chosen.endTime);
      const overlapDuration = Math.max(0, overlapEnd - overlapStart);

      const minDur = Math.min(candidate.duration, chosen.duration);
      const overlapRatio = minDur > 0 ? overlapDuration / minDur : 0;

      if (overlapRatio > 0.40) {
        hasExcessiveOverlap = true;
        break;
      }
    }

    if (!hasExcessiveOverlap) {
      accepted.push(candidate);
      if (accepted.length >= maxCount) break;
    }
  }

  return accepted.sort((a, b) => a.startTime - b.startTime);
}

/**
 * Main discovery pipeline: inspects media, analyzes transcripts/scenes,
 * discovers moments, scores, and returns ranked candidates.
 */
export function discoverShortCandidates({
  sourceMedia,
  transcriptResult = null,
  sceneSignatures = null,
  sceneCuts = null,
  audioData = null,
  settings = {},
  aiEvaluator = null,
}) {
  const normSettings = normalizeShortsSettings(settings);
  const metadata = inspectSourceMetadata(sourceMedia);
  const audioInput = audioData || sourceMedia?.audioData || sourceMedia?.audioBuffer || sourceMedia?.peaks || sourceMedia?.waveform || null;

  if (!metadata.valid) {
    return {
      ok: false,
      error: "INVALID_SOURCE_MEDIA",
      message: "Please select or upload a valid long-form video file.",
      candidates: [],
    };
  }

  if (metadata.duration < 10) {
    return {
      ok: false,
      error: "SOURCE_TOO_SHORT",
      message: `Source video duration (${metadata.duration.toFixed(1)}s) is too short. AI Shorts Studio requires videos at least 10 seconds long.`,
      candidates: [],
    };
  }

  // 1. Detect or reuse scene cuts
  let computedSceneCuts = Array.isArray(sceneCuts) ? sceneCuts : [];
  if (!computedSceneCuts.length && Array.isArray(sceneSignatures) && sceneSignatures.length > 2) {
    try {
      const sceneResult = detectScenesFromSignatures(sceneSignatures, {
        threshold: 0.28,
        minSceneDuration: 1.0,
      });
      if (sceneResult?.cuts?.length) {
        computedSceneCuts = sceneResult.cuts;
      }
    } catch {
      // Graceful fallback
    }
  }

  // 2. Discover moments based on transcript if available
  let rawCandidates = [];
  const captionSegments = transcriptResult?.segments || (Array.isArray(transcriptResult) ? transcriptResult : []);

  if (captionSegments.length > 0) {
    const sentences = groupTranscriptIntoSentences(captionSegments);
    rawCandidates = discoverSpeechCandidates({
      sentences,
      mediaDuration: metadata.duration,
      settings: normSettings,
      sceneCuts: computedSceneCuts,
      audioData: audioInput,
    });
  }

  // 3. Fallback to visual analysis if transcript is empty or visual preference requested
  if (!rawCandidates.length || normSettings.preference === "visual_highlights" || normSettings.contentType === "gaming" || normSettings.contentType === "sports") {
    const visualCandidates = discoverVisualCandidates({
      mediaDuration: metadata.duration,
      sceneCuts: computedSceneCuts,
      settings: normSettings,
    });

    if (!rawCandidates.length) {
      rawCandidates = visualCandidates;
    } else {
      rawCandidates = [...rawCandidates, ...visualCandidates];
    }
  }

  // 4. Optional AI refinement hook (safe, resilient, non-blocking)
  if (typeof aiEvaluator === "function" && rawCandidates.length > 0) {
    try {
      const refined = aiEvaluator(rawCandidates, { transcriptResult, settings: normSettings });
      if (Array.isArray(refined) && refined.length > 0) {
        rawCandidates = refined;
      }
    } catch (err) {
      // Safe fallback: AI failure, timeout, or malformed return never crashes discovery
      console.warn("[ShortsStudio] Optional AI evaluator failed, retaining deterministic local candidates:", err?.message);
    }
  }

  const rankedCandidates = deduplicateAndRankCandidates(rawCandidates, normSettings.clipCount);

  // 5. Dynamic face-tracking & reframing attachment
  const availableFaceDetections = (Array.isArray(normSettings.faceDetections) && normSettings.faceDetections.length > 0)
    ? normSettings.faceDetections.filter(isGenuineFaceDetection)
    : extractGenuineFaceDetections(sourceMedia);

  const isSmartReframing = ["smart-subject", "smart-zoom"].includes(normSettings.autoReframing);
  if (isSmartReframing) {
    if (availableFaceDetections.length > 0) {
      rankedCandidates.forEach((cand) => {
        const candDetections = availableFaceDetections
          .filter((d) => {
            const t = Number(d?.time ?? d?.timestamp);
            return Number.isFinite(t) && t >= cand.startTime && t <= cand.endTime;
          })
          .map((d) => {
            const t = Number(d?.time ?? d?.timestamp);
            return { ...d, time: Number((t - cand.startTime).toFixed(3)) };
          });

        const userSelectedSubject = cand.userSelectedSubject ?? normSettings.userSelectedSubject ?? null;
        const reframingTrack = buildDynamicReframingTrack({
          detections: candDetections,
          duration: cand.duration,
          startTime: cand.startTime,
          sourceStart: cand.startTime,
          sourceSize: { width: metadata.width || 1920, height: metadata.height || 1080 },
          targetRatio: normSettings.aspectRatio || "9:16",
          sceneCuts: computedSceneCuts.map((c) => c - cand.startTime).filter((c) => c > 0 && c < cand.duration),
          manualCropX: cand.cropX ?? normSettings.cropX ?? 0.5,
          userSelectedSubject,
          speechIntervals: (cand.sentences || []).map((s) => ({
            start: Math.max(0, s.start - cand.startTime),
            end: Math.max(0, s.end - cand.startTime),
          })),
          sentences: (cand.sentences || []).map((s) => ({
            ...s,
            start: Math.max(0, s.start - cand.startTime),
            end: Math.max(0, s.end - cand.startTime),
          })),
          captionSegments: (captionSegments || []).map((seg) => ({
            ...seg,
            start: Math.max(0, seg.start - cand.startTime),
            end: Math.max(0, seg.end - cand.startTime),
          })),
          acousticEnergy: cand.acousticEnergy,
        });

        const reframed = applyDynamicReframingToCandidate(cand, reframingTrack, { userSelectedSubject });
        Object.assign(cand, reframed);
      });
    } else {
      // Deterministic honest fallback when no face detections exist
      rankedCandidates.forEach((cand) => {
        const fallbackTrack = generateFallbackReframingTrack(
          { width: metadata.width || 1920, height: metadata.height || 1080 },
          normSettings.aspectRatio || "9:16",
          cand.duration,
          cand.cropX ?? normSettings.cropX ?? 0.5
        );
        const reframed = applyDynamicReframingToCandidate(cand, fallbackTrack);
        Object.assign(cand, reframed);
      });
    }
  }

  // 6. Speech-paced visual punch-in attachment
  if (normSettings.speechPunchIns !== false) {
    rankedCandidates.forEach((cand) => {
      const punchIns = detectSpeechPacedPunchIns({
        candidate: cand,
        sentences: cand.sentences || [],
        captionSegments,
        reframingTrack: cand.smartFrame,
        sceneCuts: computedSceneCuts,
        faceDetections: normSettings.faceDetections || [],
        options: {
          scale: normSettings.zoomScale || 1.25,
          minSpacing: normSettings.minZoomSpacing || 3.2,
        },
      });

      if (punchIns.length > 0) {
        const punched = applySpeechPacedPunchInsToCandidate(cand, punchIns);
        Object.assign(cand, punched);
      }
    });
  }

  return {
    ok: true,
    metadata,
    settings: normSettings,
    totalDiscovered: rawCandidates.length,
    candidates: rankedCandidates,
  };
}

/**
 * Accurately determines if a candidate's smartFrame track is an unanalyzed default / fallback track,
 * while distinguishing genuine analyzed tracks (including intentionally centered single-subject shots)
 * and respecting explicit user manual framing.
 *
 * @param {object} track - Candidate smartFrame track
 * @param {object} [candidate=null] - Candidate object containing metadata / trackingStatus
 * @returns {boolean} True if track is an unanalyzed default or explicit fallback
 */
export function isCandidateSmartFrameFallback(track, candidate = null) {
  if (!track || typeof track !== "object") return true;
  if (!Array.isArray(track.cropKeyframes) || track.cropKeyframes.length === 0) return true;

  // 1. Explicit fallback indicators in track or metadata
  if (track.isFallback === true || track.state === "fallback") return true;
  if (track.metadata?.isFallback === true || track.metadata?.status === "fallback") return true;

  // 2. Candidate tracking status explicitly reports fallback/missing
  if (
    candidate?.trackingStatus === "fallback" ||
    candidate?.trackingStatus === "no_subjects_found" ||
    candidate?.trackingStatus === "unsupported" ||
    candidate?.trackingStatus === "error"
  ) {
    return true;
  }

  const keyframes = track.cropKeyframes;

  // 3. All keyframes explicitly marked as fallback / confidence 0
  const allKeyframesFallback = keyframes.every(
    (k) => k.isFallback === true || k.state === "fallback" || k.confidence === 0
  );
  if (allKeyframesFallback) return true;

  // 4. Distinguish genuine 2-keyframe tracks from unanalyzed discovery defaults:
  // Discovery defaults have no face detections and no analysis provenance.
  // Genuine analyzed tracks have detection evidence or explicit user manual intent.
  if (keyframes.length <= 2) {
    const hasAnalysisEvidence = Boolean(
      (Number(track.metadata?.detectionsCount) > 0) ||
      (Number(track.detectionCount) > 0) ||
      track.metadata?.status === "tracked" ||
      candidate?.trackingStatus === "tracked" ||
      (Array.isArray(candidate?.faceDetections) && candidate.faceDetections.length > 0)
    );
    const hasIntentionalUserFraming = Boolean(
      candidate?.userSelectedSubject ||
      track.metadata?.provenance === "manual" ||
      track.mode === "manual" ||
      (candidate?.cropX !== undefined && candidate?.cropX !== 0.5)
    );

    // If it has neither detection/analysis evidence nor user manual intent,
    // and all keyframes are centered defaults without genuine detection provenance, it is a fallback
    if (!hasAnalysisEvidence && !hasIntentionalUserFraming) {
      const isDefaultCenter = keyframes.every(
        (k) => Math.abs((k.panFactor ?? 0.5) - 0.5) < 0.01 && (k.confidence === undefined || k.confidence <= 0.5 || k.confidence === 1)
      );
      if (isDefaultCenter) return true;
    }
  }

  return false;
}

/**
 * Converts a selected candidate into a complete timeline project snapshot
 * configured for immediate editing, preview, and export.
 */
export function convertCandidateToProject(sourceClipOrOptions, candidateArg, optionsArg = {}) {
  let sourceClip = sourceClipOrOptions;
  let candidate = candidateArg;
  let options = optionsArg;

  if (sourceClipOrOptions && !candidateArg && (sourceClipOrOptions.sourceClip || sourceClipOrOptions.sourceMedia) && sourceClipOrOptions.candidate) {
    sourceClip = sourceClipOrOptions.sourceClip || sourceClipOrOptions.sourceMedia;
    candidate = sourceClipOrOptions.candidate;
    options = sourceClipOrOptions;
  } else if (sourceClip && candidate && (candidate.width || candidate.url || candidate.type === "video") && candidate.startTime === undefined && sourceClip.startTime !== undefined) {
    const temp = sourceClip;
    sourceClip = candidate;
    candidate = temp;
  }

  if (!sourceClip || !candidate) return null;

  const targetRatio = options.aspectRatio || candidate.aspectRatio || "9:16";
  const validStartTime = Math.max(0, Number(candidate.startTime) || 0);
  const rawEndTime = Number(candidate.endTime);
  const validEndTime = Number.isFinite(rawEndTime) && rawEndTime > validStartTime
    ? rawEndTime
    : validStartTime + Math.max(1, Number(candidate.duration) || 15);
  const candidateDuration = Math.max(0.5, Number((validEndTime - validStartTime).toFixed(3)));
  const framingMode = candidate.framingMode || options.autoReframing || "smart-zoom";
  const cropX = Number.isFinite(candidate.cropX) ? Math.max(0, Math.min(1, candidate.cropX)) : (Number.isFinite(options.cropX) ? options.cropX : 0.5);

  // Slice captions belonging to this candidate's window and re-anchor timestamps to 0
  const sourceCaptions = Array.isArray(options.captionSegments) ? options.captionSegments : [];
  const candidateCaptions = sourceCaptions
    .filter((c) => c.end > candidate.startTime && c.start < candidate.endTime)
    .map((c) => {
      const segStart = Math.max(0, Number((c.start - candidate.startTime).toFixed(3)));
      const segEnd = Math.min(candidateDuration, Number((c.end - candidate.startTime).toFixed(3)));

      // Re-anchor word-level timestamps if present so karaoke highlights start at 0
      const words = Array.isArray(c.words)
        ? c.words
            .filter((w) => w.end > candidate.startTime && w.start < candidate.endTime)
            .map((w) => ({
              ...w,
              start: Math.max(0, Number((w.start - candidate.startTime).toFixed(3))),
              end: Math.min(candidateDuration, Number((w.end - candidate.startTime).toFixed(3))),
            }))
        : c.words;

      return {
        ...c,
        id: `cap-${makeId("cap")}`,
        start: segStart,
        end: segEnd,
        words,
      };
    });

  // Resolve caption style preset
  const presetId = options.captionPresetId || "bold";
  const preset = getCaptionStylePreset(presetId) || BUILTIN_CAPTION_STYLE_PRESETS[0];

  const targetDef = getRepackagingRatioDefinition(targetRatio) || REPACKAGING_RATIO_DEFINITIONS["9:16"];
  const targetDims = calculateTargetCropDimensions(
    { width: sourceClip.width || 1920, height: sourceClip.height || 1080 },
    targetRatio
  );
  const targetCropW = targetDims.cropW;
  const targetCropH = targetDims.cropH;
  const halfTargetW = targetCropW / 2;
  const halfTargetH = targetCropH / 2;

  // Resolve available genuine face detections for this candidate
  const rawDetections = Array.isArray(options.faceDetections) && options.faceDetections.length > 0
    ? options.faceDetections.filter(isGenuineFaceDetection)
    : (Array.isArray(candidate.faceDetections) && candidate.faceDetections.length > 0
        ? candidate.faceDetections.filter(isGenuineFaceDetection)
        : extractGenuineFaceDetections(sourceClip));
  const candDetections = rawDetections
    .filter((d) => {
      const t = Number(d?.time ?? d?.timestamp);
      return Number.isFinite(t) && t >= validStartTime - 0.15 && t <= validEndTime + 0.15;
    })
    .map((d) => {
      const t = Number(d?.time ?? d?.timestamp);
      return { ...d, time: Number((t - validStartTime).toFixed(3)) };
    });

  let trackToUse = candidate.smartFrame;
  const isFallbackTrack = isCandidateSmartFrameFallback(trackToUse, candidate);

  if (["smart-subject", "smart-zoom"].includes(framingMode)) {
    if (isFallbackTrack && candDetections.length > 0) {
      trackToUse = buildDynamicReframingTrack({
        detections: candDetections,
        duration: candidateDuration,
        startTime: validStartTime,
        sourceStart: validStartTime,
        sourceSize: { width: sourceClip.width || 1920, height: sourceClip.height || 1080 },
        targetRatio,
        sceneCuts: candidate.sceneCuts,
        manualCropX: Number.isFinite(options.cropX) ? options.cropX : (candidate.cropX ?? 0.5),
        userSelectedSubject: candidate.userSelectedSubject ?? candidate.targetSubject,
        speechIntervals: (candidate.sentences || []).map((s) => ({
          start: Math.max(0, s.start - validStartTime),
          end: Math.max(0, s.end - validStartTime),
        })),
        sentences: (candidate.sentences || []).map((s) => ({
          ...s,
          start: Math.max(0, s.start - validStartTime),
          end: Math.max(0, s.end - validStartTime),
        })),
      });
    }
  }

  let resolvedCropX = Number.isFinite(options.cropX) ? options.cropX : (Number.isFinite(candidate.cropX) ? candidate.cropX : cropX);
  const trackIsReal = trackToUse &&
    !trackToUse.isFallback &&
    trackToUse.state !== "fallback" &&
    Array.isArray(trackToUse.cropKeyframes) &&
    trackToUse.cropKeyframes.length > 0;

  if (trackIsReal) {
    const kf0 = trackToUse.cropKeyframes[0];
    if (Number.isFinite(kf0.panFactor)) {
      resolvedCropX = kf0.panFactor;
    } else if (Number.isFinite(kf0.x) && Number.isFinite(kf0.width) && (1 - kf0.width) > 0.0001) {
      resolvedCropX = Math.max(0, Math.min(1, kf0.x / (1 - kf0.width)));
    }
  }

  const clampedX = Math.max(0, Math.min(1 - targetCropW, Number((resolvedCropX * (1 - targetCropW)).toFixed(4))));
  const clampedY = Math.max(0, Math.min(1 - targetCropH, Number((0.5 - halfTargetH).toFixed(4))));

  const isVerticalOrSquare = targetRatio === "9:16" || targetRatio === "1:1" || targetRatio === "4:5";
  const fitMode = framingMode === "safe-contain" ? "contain" : (isVerticalOrSquare ? "cover" : "contain");

  // Configure trimmed visual segment
  const trimmedVisualSegment = {
    ...sourceClip,
    id: `vis-${makeId("vis")}`,
    archiveMediaId: sourceClip.id,
    assetId: sourceClip.id,
    sourceStart: validStartTime,
    sourceDuration: candidateDuration,
    duration: candidateDuration,
    fitMode,
    cropX: resolvedCropX,
    cropY: 0.5,
    cropOffset: { x: resolvedCropX, y: 0 },
    objectPosition: `${(resolvedCropX * 100).toFixed(1)}% 50%`,
  };

  // Configure smartFrame or punchIns based on framing mode
  if (isVerticalOrSquare || framingMode === "smart-subject" || framingMode === "smart-zoom") {

    if (framingMode === "safe-contain") {
      trimmedVisualSegment.smartFrame = normalizeSmartFrame({
        version: 2,
        enabled: true,
        targetRatio,
        presentation: "safe-contain",
        sourceSize: {
          width: sourceClip.width || 1920,
          height: sourceClip.height || 1080,
        },
        sourceSignature: {
          assetId: sourceClip.id,
          sourceStart: validStartTime,
          sourceDuration: candidateDuration,
        },
        cropKeyframes: [
          { time: validStartTime, x: 0, y: 0, width: 1, height: 1, confidence: 1 },
          { time: Number((validStartTime + candidateDuration).toFixed(3)), x: 0, y: 0, width: 1, height: 1, confidence: 1 },
        ],
      });
    } else if (trackToUse && Array.isArray(trackToUse.cropKeyframes) && trackToUse.cropKeyframes.length > 0) {
      const firstKfTime = trackToUse.cropKeyframes[0]?.time ?? 0;
      const needsOffset = validStartTime > 0 && firstKfTime < validStartTime - 0.5;
      const isTrackFallback = isCandidateSmartFrameFallback(trackToUse, candidate);
      const mappedKeyframes = trackToUse.cropKeyframes.map((kf) => ({
        ...kf,
        time: Number((needsOffset ? validStartTime + (kf.time || 0) : kf.time).toFixed(3)),
        panFactor: Number.isFinite(kf.panFactor)
          ? kf.panFactor
          : ((1 - kf.width) > 0.0001 ? Number((kf.x / (1 - kf.width)).toFixed(4)) : 0.5),
        state: kf.state || (isTrackFallback ? "fallback" : "tracked"),
        isFallback: Boolean(kf.isFallback ?? isTrackFallback),
        cut: Boolean(kf.cut || kf.isCut),
      }));

      trimmedVisualSegment.smartFrame = normalizeSmartFrame({
        ...trackToUse,
        version: 2,
        enabled: true,
        targetRatio,
        presentation: trackToUse.presentation || "crop",
        state: isTrackFallback ? "fallback" : (trackToUse.state || "tracked"),
        confidence: isTrackFallback ? 0 : (trackToUse.confidence ?? 1),
        isFallback: isTrackFallback,
        sourceSize: {
          width: sourceClip.width || 1920,
          height: sourceClip.height || 1080,
        },
        sourceSignature: {
          assetId: sourceClip.id,
          sourceStart: validStartTime,
          sourceDuration: candidateDuration,
        },
        metadata: {
          status: isTrackFallback ? "fallback" : "tracked",
          isFallback: isTrackFallback,
          framingMode,
          keyframesCount: mappedKeyframes.length,
        },
        cropKeyframes: mappedKeyframes,
      });
    } else {
      trimmedVisualSegment.smartFrame = normalizeSmartFrame({
        version: 2,
        enabled: true,
        targetRatio,
        presentation: "crop",
        state: "fallback",
        confidence: 0,
        isFallback: true,
        sourceSize: {
          width: sourceClip.width || 1920,
          height: sourceClip.height || 1080,
        },
        sourceSignature: {
          assetId: sourceClip.id,
          sourceStart: validStartTime,
          sourceDuration: candidateDuration,
        },
        metadata: {
          status: "fallback",
          isFallback: true,
          framingMode,
        },
        cropKeyframes: [
          { time: validStartTime, x: clampedX, y: clampedY, width: targetCropW, height: targetCropH, panFactor: resolvedCropX, confidence: 0, state: "fallback", isFallback: true },
          { time: Number((validStartTime + candidateDuration).toFixed(3)), x: clampedX, y: clampedY, width: targetCropW, height: targetCropH, panFactor: resolvedCropX, confidence: 0, state: "fallback", isFallback: true },
        ],
      });
    }

    if (framingMode === "smart-subject") {
      // Attach speech-paced punch-ins if present on candidate
      if (Array.isArray(candidate.punchIns) && candidate.punchIns.length > 0) {
        trimmedVisualSegment.punchIns = candidate.punchIns;
        trimmedVisualSegment.keyframes = compilePunchInKeyframes([], candidate.punchIns, candidateDuration);
        trimmedVisualSegment.smartZoom = { enabled: true, punchIns: candidate.punchIns };
      }
    } else if (framingMode === "smart-zoom") {
      const punchInsEnabled = options.speechPunchIns !== false && candidate.speechPunchIns !== false;
      let punchIns = [];

      if (punchInsEnabled) {
        punchIns = Array.isArray(candidate.punchIns) && candidate.punchIns.length > 0
          ? candidate.punchIns
          : detectSpeechPacedPunchIns({
              candidate,
              sentences: options.sentences || [],
              captionSegments: options.captionSegments || sourceCaptions,
              reframingTrack: candidate.smartFrame || trimmedVisualSegment.smartFrame,
              sceneCuts: options.sceneCuts || [],
              faceDetections: options.faceDetections || [],
              options: {
                scale: options.zoomScale || 1.25,
                transition: options.zoomTransition || "smooth",
              },
            });

        // Backward-compatible fallback if candidate is smart-zoom and speechPunchIns wasn't explicitly disabled
        if (!punchIns || punchIns.length === 0) {
          punchIns = [
            {
              id: `p-${makeId("pz")}`,
              time: 0.8,
              tStart: 0.8,
              scale: 1.25,
              duration: Math.min(candidateDuration - 1.2, 3.5),
              transition: "smooth",
              transitionDuration: 0.3,
              x: (resolvedCropX - 0.5) * 20,
              y: 0,
            },
          ];
          if (candidateDuration >= 18) {
            punchIns.push({
              id: `p-${makeId("pz")}`,
              time: Math.round(candidateDuration * 0.55),
              tStart: Math.round(candidateDuration * 0.55),
              scale: 1.22,
              duration: 3.0,
              transition: "smooth",
              transitionDuration: 0.3,
              x: (resolvedCropX - 0.5) * 20,
              y: 0,
            });
          }
        }
      }

      trimmedVisualSegment.punchIns = punchIns;
      trimmedVisualSegment.keyframes = punchIns.length > 0
        ? compilePunchInKeyframes([], punchIns, candidateDuration)
        : [];
      trimmedVisualSegment.smartZoom = { enabled: punchInsEnabled, punchIns };
    }
  }

  // Resolve visual overlay segments if present on candidate or options
  let overlaySegments = [];
  const overlaysEnabled = options.overlays === true || (options.overlays !== false && candidate.enableOverlays === true);
  if (overlaysEnabled || options.includeOverlays === true) {
    if (Array.isArray(candidate.overlays) && candidate.overlays.length > 0) {
      overlaySegments = candidate.overlays;
    } else if (Array.isArray(options.visualOverlaySegments)) {
      overlaySegments = options.visualOverlaySegments;
    } else if (Array.isArray(options.overlays)) {
      overlaySegments = options.overlays;
    }
  } else if (Array.isArray(options.visualOverlaySegments)) {
    overlaySegments = options.visualOverlaySegments;
  }

  // Apply motion typography planning to candidate captions if enabled
  let finalCaptions = candidateCaptions;
  let captionCallouts = [];
  let motionTypographyMeta = null;
  const motionTypographyEnabled = options.motionTypography !== false && candidate.motionTypography !== false;

  if (motionTypographyEnabled && candidateCaptions.length > 0) {
    const motionPlan = planMotionTypography({
      candidate: {
        ...candidate,
        duration: candidateDuration,
      },
      captionSegments: candidateCaptions,
      sentences: options.sentences || [],
      punchIns: trimmedVisualSegment.punchIns || candidate.punchIns || [],
      acousticFeatures: candidate.acousticFeatures || options.acousticFeatures || null,
      sceneCuts: options.sceneCuts || [],
      activeOverlays: overlaySegments,
      availableAssets: options.availableAssets || [],
      options: {
        ...(options.motionTypographyOptions || {}),
        reducedMotion: options.reducedMotion === true || candidate.reducedMotion === true,
        animationStyle: options.captionAnimationStyle || candidate.captionAnimationStyle || "pop",
      },
    });

    if (motionPlan.ok) {
      finalCaptions = motionPlan.captionSegments;
      captionCallouts = motionPlan.callouts || [];
      motionTypographyMeta = {
        enabled: true,
        animationStyle: motionPlan.animationStyle,
        reducedMotion: motionPlan.reducedMotion,
        hasKineticWords: motionPlan.hasKineticWords,
        calloutCount: captionCallouts.length,
        soundAccentCount: (motionPlan.soundAccents || []).length,
        stats: motionPlan.stats,
      };
    }
  } else {
    motionTypographyMeta = {
      enabled: false,
      animationStyle: "none",
      reducedMotion: Boolean(options.reducedMotion),
      hasKineticWords: false,
      calloutCount: 0,
      soundAccentCount: 0,
    };
  }

  // Resolve transitions and b-roll cutaways if present or enabled
  let projectTransitions = Array.isArray(candidate.transitions)
    ? candidate.transitions
    : (Array.isArray(options.transitions) ? options.transitions : []);
  let brollCutaways = Array.isArray(candidate.brollCutaways) ? candidate.brollCutaways : [];
  let assetRequests = Array.isArray(candidate.assetRequests) ? candidate.assetRequests : [];

  if (
    (options.autoTransitions === true || candidate.autoTransitions === true) &&
    projectTransitions.length === 0 &&
    brollCutaways.length === 0
  ) {
    const autoPlan = planShortTransitionsAndBroll({
      candidate,
      sourceClip,
      availableAssets: options.availableAssets || [],
      sentences: options.sentences || options.candidateSentences || [],
      sceneCuts: options.sceneCuts || [],
      options,
    });
    if (autoPlan && autoPlan.ok) {
      projectTransitions = autoPlan.transitions || [];
      brollCutaways = autoPlan.cutaways || [];
      assetRequests = autoPlan.assetRequests || [];
    }
  }

  // If candidate has planned B-roll cutaways with real assets, integrate them into visualOverlaySegments
  if (brollCutaways.length > 0) {
    for (const cutaway of brollCutaways) {
      if (!cutaway.asset) continue;
      const cutawayId = cutaway.id
        ? `vis-${cutaway.id}`
        : `vis-cutaway-${cutaway.asset?.id || cutaway.assetId || "broll"}-${Math.round((cutaway.start || 0) * 100)}`;
      const overlaySeg = {
        id: cutawayId,
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
      overlaySegments.push(overlaySeg);
    }
  }

  return {
    ratioId: targetRatio,
    fitMode,
    visualSegments: [trimmedVisualSegment],
    visualOverlaySegments: overlaySegments,
    segments: [trimmedVisualSegment],
    captionSegments: finalCaptions,
    captionCallouts,
    motionTypography: motionTypographyMeta,
    transitions: projectTransitions,
    brollCutaways,
    assetRequests,
    captionStylePresetId: preset.id,
    captionStyle: { ...preset.style },
    captionSize: preset.captionSize || 22,
    captionsEnabled: candidateCaptions.length > 0,
    audioSegments: Array.isArray(options.audioSegments) ? options.audioSegments : [],
    musicSegments: Array.isArray(options.musicSegments) ? options.musicSegments : [],
    timelineDuration: candidateDuration,
    meta: {
      sourceClipId: sourceClip.id,
      candidateId: candidate.id,
      candidateTitle: candidate.title,
      strategy: candidate.strategy,
      framingMode,
      cropX,
    },
  };
}

/**
 * Builds an export specification payload for offline or headless rendering.
 */
export function buildShortExportSpec(sourceClip, candidate, options = {}) {
  const project = convertCandidateToProject(sourceClip, candidate, options);
  if (!project) return null;

  const ratioDef = SHORTS_ASPECT_RATIOS.find((r) => r.id === project.ratioId) || SHORTS_ASPECT_RATIOS[0];

  return {
    id: `export-${candidate.id}`,
    candidateId: candidate.id,
    title: candidate.title || "AI Short",
    startTime: candidate.startTime,
    endTime: candidate.endTime,
    duration: candidate.duration,
    width: ratioDef.width,
    height: ratioDef.height,
    aspectRatio: ratioDef.id,
    framingMode: candidate.framingMode || options.autoReframing || "smart-zoom",
    cropX: candidate.cropX ?? options.cropX ?? 0.5,
    motionTypography: project.motionTypography,
    captionCallouts: project.captionCallouts,
    transitions: project.transitions || [],
    brollCutaways: project.brollCutaways || [],
    assetRequests: project.assetRequests || [],
    project,
    format: "mp4",
    videoBitrate: "8000k",
    audioBitrate: "192k",
  };
}

/**
 * Resolves captions strictly belonging to the active source media.
 * Prevents timeline captions from leaking into independent uploaded media assets.
 *
 * @param {object} params
 * @param {object} params.activeSource - The active source item ({ id, isTimelineClip, source })
 * @param {Array} [params.timelineVisualSegments=[]] - Editor timeline visual segments
 * @param {Array} [params.timelineCaptionSegments=[]] - Editor timeline global captions
 * @returns {Array} Array of captions strictly belonging to this source
 */
export function resolveSourceCaptions({
  activeSource = null,
  timelineVisualSegments = [],
  timelineCaptionSegments = [],
} = {}) {
  if (!activeSource || !activeSource.source) return [];

  // 1. If source has explicit captions attached to it, use them
  if (Array.isArray(activeSource.source.captionSegments) && activeSource.source.captionSegments.length > 0) {
    return activeSource.source.captionSegments;
  }
  if (Array.isArray(activeSource.source.captions) && activeSource.source.captions.length > 0) {
    return activeSource.source.captions;
  }

  // 2. Uploaded media assets MUST NEVER inherit unrelated timeline captions
  if (!activeSource.isTimelineClip) {
    return [];
  }

  // 3. For timeline clips: only reuse timeline captions if they demonstrably belong to this clip
  if (!Array.isArray(timelineCaptionSegments) || timelineCaptionSegments.length === 0) {
    return [];
  }

  // If there is only one visual segment on timeline and it matches activeSource
  if (timelineVisualSegments.length === 1 && timelineVisualSegments[0].id === activeSource.id) {
    return timelineCaptionSegments;
  }

  // If multiple clips exist, find the clip on the timeline and filter captions within its boundary
  const segment = timelineVisualSegments.find((s) => s.id === activeSource.id);
  if (!segment) return [];

  const segStart = Number(segment.start) || 0;
  const segDur = Number(segment.duration) || 0;
  const segEnd = segStart + segDur;
  const clipSourceStart = Number(segment.sourceStart) || 0;

  return timelineCaptionSegments
    .filter((c) => c && typeof c.start === "number" && typeof c.end === "number" && c.end > segStart && c.start < segEnd)
    .map((c) => {
      const offset = segStart - clipSourceStart;
      const reanchoredStart = Math.max(0, Number((c.start - offset).toFixed(3)));
      const reanchoredEnd = Math.max(reanchoredStart + 0.1, Number((c.end - offset).toFixed(3)));
      const words = Array.isArray(c.words)
        ? c.words.map((w) => ({
            ...w,
            start: Math.max(0, Number((w.start - offset).toFixed(3))),
            end: Math.max(0, Number((w.end - offset).toFixed(3))),
          }))
        : [];
      return {
        ...c,
        start: reanchoredStart,
        end: reanchoredEnd,
        words,
      };
    });
}

/**
 * Computes a synchronized transcript excerpt for a candidate's trimmed window.
 *
 * @param {Array} captions - Captions belonging to the source
 * @param {number} startTime - Start time in seconds
 * @param {number} endTime - End time in seconds
 * @param {string} [strategy="speech-centric"] - Discovery strategy
 * @returns {string} Truncated excerpt or visual scene fallback
 */
export function extractTranscriptExcerpt(captions = [], startTime = 0, endTime = 0, strategy = "speech-centric") {
  const start = Math.max(0, Number(startTime) || 0);
  const end = Math.max(start + 0.5, Number(endTime) || (start + 0.5));

  if (Array.isArray(captions) && captions.length > 0) {
    const overlapping = captions.filter(
      (c) => c && typeof c.start === "number" && typeof c.end === "number" && c.end > start && c.start < end
    );

    if (overlapping.length > 0) {
      const text = overlapping
        .map((c) => (c.text || "").trim())
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      if (text) {
        return text.slice(0, 160) + (text.length > 160 ? "…" : "");
      }
    }
  }

  // Fallback for visual scenes or intervals with no speech
  return `[Visual Scene: ${start.toFixed(1)}s to ${end.toFixed(1)}s]`;
}

// Phase 2 Priority 10: Multi-Track Timeline Orchestration & Production Export Packaging
export {
  TIMELINE_PACKAGE_FORMAT,
  TIMELINE_PACKAGE_VERSION,
  CANONICAL_TRACK_KINDS,
  CANONICAL_TRACK_IDS,
  SUPPORTED_TIMELINE_EXPORT_FORMATS,
  candidateToCanonicalTimeline,
  serializeTimelineToNativeProject,
  deserializeNativeProjectToTimeline,
  exportTimelineToOtio,
  deserializeOtioToTimeline,
  exportTimelineToFcpxml,
  packageEditableShortTimeline,
  createTimelinePackageZipBlob,
} from "./shortsTimelinePackaging.js";

