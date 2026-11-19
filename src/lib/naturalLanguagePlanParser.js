/**
 * Natural Language Editing Plan Parser
 *
 * Provides deterministic, schema-compliant parsing of natural-language
 * video editing instructions into atomic, structured command plans.
 *
 * Supports multi-step compound instructions:
 * - "Trim a clip and add a fade transition"
 * - "Add captions and position them at the bottom"
 * - "Lower music volume without changing voiceover volume"
 * - "Remove filler words and long pauses"
 * - "Convert the project to 9:16"
 * - "Reorder clip 1 to index 2 and delete clip 3"
 * - "Apply several compatible edits in one request"
 */

import { validateAndNormalizePlan } from "../../server/services/ai/editingPlanSchema.js";
import { findCaptionStylePreset, BUILTIN_CAPTION_STYLE_PRESETS } from "./captionStyles.js";
import { findCaptionFontInCatalog, CAPTION_FONT_CATALOG } from "./captionFonts.js";
import { isActiveWordColorCommand, extractActiveWordColor } from "./intentClassifier.js";
import {
  inspectPunchIns,
  normalizePunchInScale,
  SMART_ZOOM_DEFAULTS,
} from "./smartZoom.js";

/**
 * Extracts a timestamp in seconds from text like "00:00:08", "8s", "8 seconds", "at 5".
 */
export function parseTimestampFromText(text) {
  if (!text) return null;
  const timecodeMatch = text.match(/\b(?:(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2}))\b/);
  if (timecodeMatch) {
    const hours = timecodeMatch[1] ? parseInt(timecodeMatch[1], 10) : 0;
    const minutes = parseInt(timecodeMatch[2], 10);
    const seconds = parseInt(timecodeMatch[3], 10);
    return hours * 3600 + minutes * 60 + seconds;
  }
  const secMatch = text.match(/\b(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/i);
  if (secMatch) {
    return parseFloat(secMatch[1]);
  }
  const atMatch = text.match(/\bat\s+(\d+(?:\.\d+)?)\b/i);
  if (atMatch) {
    return parseFloat(atMatch[1]);
  }
  return null;
}


const ORDINAL_MAP = Object.freeze({
  first: 0,
  "1st": 0,
  second: 1,
  "2nd": 1,
  third: 2,
  "3rd": 2,
  fourth: 3,
  "4th": 3,
  fifth: 4,
  "5th": 4,
  sixth: 5,
  "6th": 5,
  seventh: 6,
  "7th": 6,
  eighth: 7,
  "8th": 7,
  ninth: 8,
  "9th": 8,
  tenth: 9,
  "10th": 9,
  eleventh: 10,
  "11th": 10,
  twelfth: 11,
  "12th": 11,
  last: -1,
  penultimate: -2,
  "second to last": -2,
});

/**
 * Resolves an ordinal or numbered reference to a 0-based index.
 * @param {string} text - e.g. "first", "2nd", "clip 3", "last"
 * @param {number} totalCount - Total items in collection
 * @returns {number|null} 0-based index or null
 */
export function resolveOrdinalIndex(text, totalCount = 1) {
  if (!text) return null;
  const str = String(text).trim().toLowerCase();

  for (const [key, idx] of Object.entries(ORDINAL_MAP)) {
    const pat = new RegExp(`\\b${key}\\b`, "i");
    if (pat.test(str)) {
      return idx < 0 ? Math.max(0, totalCount + idx) : idx;
    }
  }

  const numMatch = str.match(/\b(?:clip|segment|video|item)?\s*[-#]?\s*(\d+)\b/i);
  if (numMatch) {
    const parsed = parseInt(numMatch[1], 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed - 1;
    }
  }

  return null;
}

/**
 * Resolves clip target ID from text reference and project summary.
 */
export function resolveClipTargetFromText(text, projectSummary, defaultId = "", allowFallback = true) {
  const visuals = projectSummary?.visualSegments || projectSummary?.visualClips || projectSummary?.visuals || [];
  if (!visuals.length) return defaultId;

  const str = String(text || "").toLowerCase();

  // Explicit ID match
  const exactClip = visuals.find((c) => c.id && str.includes(c.id.toLowerCase()));
  if (exactClip) return exactClip.id;

  // Name match
  const nameClip = visuals.find((c) => c.name && str.includes(c.name.toLowerCase()));
  if (nameClip) return nameClip.id;

  // Ordinal / number match
  for (const [word, idx] of Object.entries(ORDINAL_MAP)) {
    const pat = new RegExp(`\\b${word}(?:\\s+(?:clip|segment|video))?\\b`, "i");
    if (pat.test(str)) {
      const targetIdx = idx < 0 ? Math.max(0, visuals.length + idx) : idx;
      if (visuals[targetIdx]) return visuals[targetIdx].id;
    }
  }

  const numMatch = str.match(/\b(?:clip|segment|video)\s*[-#]?\s*(\d+)\b/i);
  if (numMatch) {
    const targetIdx = parseInt(numMatch[1], 10) - 1;
    if (visuals[targetIdx]) return visuals[targetIdx].id;
  }

  // Selected clip
  if (projectSummary?.selectedClipId && /\b(?:selected|this|current|it)\b/i.test(str)) {
    return projectSummary.selectedClipId;
  }

  return allowFallback ? (defaultId || visuals[0]?.id || "") : "";
}

/**
 * Resolves a raw target clip reference (ID, name, ordinal, or descriptive phrase)
 * to an existing clip ID from a project snapshot.
 */
export function resolveTargetClipId(rawId, snapshot, defaultId = "", targetTrack = "visuals") {
  if (!rawId || rawId === "selected" || rawId === "this" || rawId === "current") {
    return defaultId;
  }
  let str = String(rawId).trim().toLowerCase().replace(/^(?:the|my|that|this)\s+/i, "");

  // If targeting music track
  if (targetTrack === "music" || str === "music" || str === "background music" || str === "bgm") {
    const music = Array.isArray(snapshot?.musicSegments) ? snapshot.musicSegments : [];
    if (music.length > 0) {
      if (str === "music" || str === "background music" || str === "bgm") return music[0].id;
      const found = music.find((m) => m.id === rawId || (m.name && m.name.toLowerCase().includes(str)));
      if (found) return found.id;
      return music[0].id;
    }
    return defaultId || "music";
  }

  // If targeting audio / voiceover track
  if (targetTrack === "audio" || str === "audio" || str === "voice" || str === "voiceover" || str === "narration") {
    const audio = Array.isArray(snapshot?.audioSegments) ? snapshot.audioSegments : [];
    if (audio.length > 0) {
      if (str === "audio" || str === "voice" || str === "voiceover" || str === "narration") return audio[0].id;
      const found = audio.find((a) => a.id === rawId || (a.name && a.name.toLowerCase().includes(str)));
      if (found) return found.id;
      return audio[0].id;
    }
    return defaultId || "audio";
  }

  const visuals = Array.isArray(snapshot?.visualSegments)
    ? snapshot.visualSegments
    : Array.isArray(snapshot?.visualClips)
      ? snapshot.visualClips
      : Array.isArray(snapshot?.visuals)
        ? snapshot.visuals
        : Array.isArray(snapshot?.clips)
          ? snapshot.clips
          : [];
  if (!visuals.length) return defaultId || rawId;

  // Exact ID match
  const exact = visuals.find((c) => c.id === rawId || c.id === str);
  if (exact) return exact.id;

  // Name match
  const byName = visuals.find((c) => c.name && c.name.toLowerCase().includes(str));
  if (byName) return byName.id;

  // Ordinal mappings
  const cleanOrdinal = str.replace(/\s+(?:clip|segment|video)$/i, "").trim();
  const ORDINAL_LOOKUP = {
    first: 0, "1st": 0, "clip 1": 0, "clip-1": 0, "clip #1": 0,
    second: 1, "2nd": 1, "clip 2": 1, "clip-2": 1, "clip #2": 1,
    third: 2, "3rd": 2, "clip 3": 2, "clip-3": 2, "clip #3": 2,
    fourth: 3, "4th": 3, "clip 4": 3, "clip-4": 3, "clip #4": 3,
    fifth: 4, "5th": 4, "clip 5": 4, "clip-5": 4, "clip #5": 4,
    sixth: 5, "6th": 5, "clip 6": 5, "clip-6": 5, "clip #6": 5,
    seventh: 6, "7th": 6, "clip 7": 6, "clip-7": 6, "clip #7": 6,
    eighth: 7, "8th": 7, "clip 8": 7, "clip-8": 7, "clip #8": 7,
    ninth: 8, "9th": 8, "clip 9": 8, "clip-9": 8, "clip #9": 8,
    tenth: 9, "10th": 9, "clip 10": 9, "clip-10": 9, "clip #10": 9,
    last: visuals.length - 1,
    penultimate: Math.max(0, visuals.length - 2),
    "second to last": Math.max(0, visuals.length - 2),
  };

  if (ORDINAL_LOOKUP[cleanOrdinal] !== undefined) {
    const idx = ORDINAL_LOOKUP[cleanOrdinal];
    if (visuals[idx]) return visuals[idx].id;
  }

  if (ORDINAL_LOOKUP[str] !== undefined) {
    const idx = ORDINAL_LOOKUP[str];
    if (visuals[idx]) return visuals[idx].id;
  }

  const numMatch = str.match(/\b(?:clip|segment|video)?\s*[-#]?\s*(\d+)\b/i);
  if (numMatch) {
    const idx = parseInt(numMatch[1], 10) - 1;
    if (visuals[idx]) return visuals[idx].id;
  }

  return rawId || defaultId || "";
}

/**
 * Parses a natural language editing instruction into a structured editing plan.
 *
 * @param {string} prompt - User instruction
 * @param {object} projectSummary - Sanitized timeline summary
 * @returns {object} Validated schemaVersion 1 editing plan
 */
export function parseNaturalLanguageEditingPlan(prompt, projectSummary = {}, conversationContext = {}) {
  const text = String(prompt || "").trim();
  const visuals = Array.isArray(projectSummary?.visualSegments)
    ? projectSummary.visualSegments
    : Array.isArray(projectSummary?.visualClips)
      ? projectSummary.visualClips
      : Array.isArray(projectSummary?.visuals)
        ? projectSummary.visuals
        : Array.isArray(projectSummary?.clips)
          ? projectSummary.clips
          : [];
  const audioSegments = projectSummary?.audioSegments || [];
  const musicSegments = projectSummary?.musicSegments || [];
  const captionSegments = projectSummary?.captionSegments || projectSummary?.captions || [];

  const actions = [];
  const warnings = [];
  const assumptions = [];
  const descriptions = [];
  let customExplanation = "";
  const smartFeatureQuestion = /^(?:how\s+(?:does|do|would)|what\s+(?:does|is|are)|tell\s+me\s+(?:about|how))\s+(?:the\s+)?(?:remove\s+pauses?|silence\s+removal|ai\s+rough\s+cut|rough\s+cut)\b/i.test(text);

  let opCounter = 1;
  const nextId = () => `act-${opCounter++}`;

  // 0a. Incremental follow-up: "a bit more", "a little more", "even more"
  if (/^(?:a\s+bit\s+more|a\s+little\s+more|even\s+more|more|further)\.?$/i.test(text)) {
    const prevAction =
      conversationContext?.previousPlan?.actions?.[0] ||
      conversationContext?.lastEditingPlan?.actions?.[0] ||
      conversationContext?.lastConfirmedAction;
    if (prevAction) {
      if (prevAction.type === "clip.set_speed") {
        const nextSpeed = Math.min(4.0, Number(((Number(prevAction.params?.speed) || 1.25) + 0.25).toFixed(2)));
        actions.push({
          id: nextId(),
          type: "clip.set_speed",
          description: `Further increase speed to ${nextSpeed}x`,
          params: { ...prevAction.params, speed: nextSpeed },
        });
        descriptions.push(`Increase speed further to ${nextSpeed}x`);
      } else if (prevAction.type === "clip.set_color_grade") {
        const currentGrade = prevAction.params?.colorGrade || {};
        const nextGrade = { ...currentGrade };
        if (nextGrade.temperature !== undefined) nextGrade.temperature = Math.min(100, nextGrade.temperature + 20);
        if (nextGrade.saturation !== undefined) nextGrade.saturation = Math.max(-100, Math.min(100, nextGrade.saturation + (nextGrade.saturation < 0 ? -15 : 20)));
        for (const wheel of ["shadows", "midtones", "highlights", "offset"]) {
          if (nextGrade[wheel]?.luminance !== undefined) {
            nextGrade[wheel] = {
              ...nextGrade[wheel],
              luminance: Math.min(100, nextGrade[wheel].luminance + 15),
            };
          }
        }
        actions.push({
          id: nextId(),
          type: "clip.set_color_grade",
          description: "Further adjust color grade",
          params: { ...prevAction.params, colorGrade: nextGrade },
        });
        descriptions.push("Further adjust color grading");
      } else if (prevAction.type === "clip.set_property" && prevAction.params?.property === "volume") {
        const nextVol = Math.max(0.05, Number(((Number(prevAction.params?.value) || 0.2) - 0.05).toFixed(2)));
        actions.push({
          id: nextId(),
          type: "clip.set_property",
          description: `Further lower volume to ${Math.round(nextVol * 100)}%`,
          params: { ...prevAction.params, value: nextVol },
        });
        descriptions.push(`Lower volume further to ${Math.round(nextVol * 100)}%`);
      }
    }
  }

  // 0b. Apply that to the rest too / Apply the same treatment to all clips
  if (/\b(?:apply\s+(?:that|the\s+same(?:\s+treatment)?)\s+to\s+(?:the\s+rest|all(?:\s+clips)?|everything)|same\s+for\s+(?:all|the\s+rest))\b/i.test(text)) {
    const prevAction =
      conversationContext?.previousPlan?.actions?.[0] ||
      conversationContext?.lastEditingPlan?.actions?.[0] ||
      conversationContext?.lastConfirmedAction;
    if (prevAction) {
      actions.push({
        id: nextId(),
        type: prevAction.type,
        description: `Apply ${prevAction.type} across all clips`,
        params: { ...prevAction.params, scope: "all", clipId: "all" },
      });
      descriptions.push(`Apply ${prevAction.type} to all clips`);
    }
  }

  // 0c. Adjacent clip: "no, not that one. the clip after it"
  if (/\b(?:the\s+clip\s+after\s+(?:it|that|this)|next\s+clip|now\s+the\s+clip\s+after\s+it)\b/i.test(text)) {
    const prevAction =
      conversationContext?.previousPlan?.actions?.[0] ||
      conversationContext?.lastEditingPlan?.actions?.[0] ||
      conversationContext?.lastConfirmedAction;
    const prevClipId = prevAction?.params?.clipId || conversationContext?.previousTargetClipId;
    const prevIdx = visuals.findIndex((c) => c.id === prevClipId);
    const targetIdx = prevIdx >= 0 ? Math.min(visuals.length - 1, prevIdx + 1) : 1;
    const targetClip = visuals[targetIdx];
    if (targetClip && prevAction) {
      actions.push({
        id: nextId(),
        type: prevAction.type,
        description: `Apply ${prevAction.type} to clip ${targetClip.id} (the clip after)`,
        params: { ...prevAction.params, clipId: targetClip.id, scope: "clip" },
      });
      descriptions.push(`Apply ${prevAction.type} to clip ${targetClip.id}`);
    }
  }

  // 0d. Fit to target duration: "make everything fit a 30-second video"
  const fitDurationMatch = text.match(/\bmake\s+everything\s+fit\s+(?:a\s+)?(\d+)[- ]second\s+video\b/i);
  if (fitDurationMatch) {
    const targetSec = parseInt(fitDurationMatch[1], 10);
    const currentDur = projectSummary?.duration || visuals.reduce((acc, c) => acc + (Number(c.duration) || 0), 0) || 30;
    if (currentDur > 0 && Number.isFinite(targetSec)) {
      const neededSpeed = Math.max(0.25, Math.min(4.0, Number((currentDur / targetSec).toFixed(2))));
      actions.push({
        id: nextId(),
        type: "clip.set_speed",
        description: `Adjust speed of all clips to ${neededSpeed}x to fit ${targetSec}s target duration`,
        params: { clipId: "all", speed: neededSpeed, scope: "all" },
      });
      descriptions.push(`Fit video to ${targetSec} seconds`);
    }
  }

  // 1. Aspect Ratio changes
  const ratioMatch =
    text.match(/\b(?:convert|switch|make|change|set)\s+(?:the\s+)?(?:project|video|canvas)?\s*(?:ratio\s+to\s+|to\s+)?(9:16|16:9|1:1|4:5)\b/i) ||
    text.match(/\b(9:16|16:9|1:1|4:5)\s*(?:vertical|portrait|landscape|square|social\s+portrait)?\b/i) ||
    (text.match(/\b(?:vertical|mobile\s+portrait)\b/i) ? [null, "9:16"] : null) ||
    (text.match(/\b(?:landscape|widescreen)\b/i) ? [null, "16:9"] : null) ||
    (text.match(/\b(?:square|instagram\s+feed)\b/i) ? [null, "1:1"] : null);

  if (ratioMatch && ratioMatch[1]) {
    const ratio = ratioMatch[1];
    actions.push({
      id: nextId(),
      type: "project.set_ratio",
      description: `Switch project canvas aspect ratio to ${ratio}`,
      params: { ratio, ratioId: ratio },
    });
    descriptions.push(`Convert project to ${ratio}`);
  }

  // 2. Fit Mode changes
  const fitMatch = text.match(/\b(?:set\s+)?fit\s+mode\s+(?:to\s+)?(contain|cover)\b/i) ||
    text.match(/\b(contain|cover)\s+fit\s+mode\b/i);
  if (fitMatch && fitMatch[1]) {
    const fitMode = fitMatch[1].toLowerCase();
    actions.push({
      id: nextId(),
      type: "project.set_fit",
      description: `Set canvas fit mode to ${fitMode}`,
      params: { fitMode },
    });
    descriptions.push(`Set fit mode to ${fitMode}`);
  }

  // 3. Trimming
  // Matches e.g. "trim first clip to 5 seconds", "trim clip 1 to 5s", "trim the video to 8 seconds"
  const trimMatch = text.match(/\btrim\s+(?:the\s+)?([\w\s-#]+?)\s+(?:to|at|by)\s+(\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)\b/i);
  if (trimMatch) {
    const targetRef = trimMatch[1].trim();
    const targetDur = parseFloat(trimMatch[2]);
    const clipId = resolveClipTargetFromText(targetRef, projectSummary, visuals[0]?.id || "");
    const targetClip = visuals.find((c) => c.id === clipId);

    if (clipId) {
      const sourceIn = targetClip?.sourceStart || 0;
      const sourceOut = sourceIn + targetDur;
      actions.push({
        id: nextId(),
        type: "visual.trim",
        description: `Trim clip ${clipId} to ${targetDur}s [${sourceIn}s → ${sourceOut}s]`,
        params: {
          clipId,
          sourceIn: Number(sourceIn.toFixed(3)),
          sourceOut: Number(sourceOut.toFixed(3)),
          duration: targetDur,
        },
      });
      descriptions.push(`Trim clip to ${targetDur}s`);
    } else {
      warnings.push("Target clip for trimming was not found on the timeline.");
    }
  }

  // 4. Transitions
  // Matches e.g. "add a fade transition", "add a smooth transition between these clips", "make the transition smoother", "remove the transition", "make the transition shorter", "add smooth fade in transition between the cuts"
  const isTransitionRequest = /\b(?:transition|transitions|crossfade|cross-fade)\b/i.test(text)
    && !/\bpunch[- ]in\s+transition/i.test(text)
    && !/\b(?:make\s+(?:the\s+)?zoom\s+transitions?|zoom\s+transitions?\s+(?:slower|faster)|(?:slower|faster)\s+zoom\s+transitions?)\b/i.test(text);
  if (isTransitionRequest) {
    const isRemove = /\b(?:remove|delete|clear|none)\b/i.test(text);
    const isShorter = /\b(?:shorter|faster|quick(?:er)?)\b/i.test(text);
    const isSmoother = /\b(?:smooth(?:er)?|soft(?:er)?)\b/i.test(text);
    const transMatch = text.match(/\b(fade|crossfade|cross-fade|zoom|flash|wipe-left|wipe-up|blur|split|glitch)\b/i);
    const matchedType = transMatch ? transMatch[1].toLowerCase() : "fade";
    const transType = isRemove ? "none" : (matchedType.startsWith("cross") ? "fade" : matchedType);
    const reqDuration = isRemove ? 0 : (isShorter ? 0.3 : (isSmoother ? 1.0 : 0.5));
    const isMultiCut = /\b(?:between\s+(?:the\s+)?(?:cuts|clips)|all\s+cuts|every\s+cut|all\s+clips|each\s+cut|across\s+(?:the\s+)?cuts)\b/i.test(text);

    if (isMultiCut) {
      if (visuals.length < 2) {
        warnings.push("Transitions require at least two adjacent visual clips on the timeline.");
      } else {
        // Apply transitions only to valid adjacent boundaries (index 0 through visuals.length - 2). Never target the final clip.
        let addedCount = 0;
        for (let i = 0; i < visuals.length - 1; i++) {
          const curr = visuals[i];
          const next = visuals[i + 1];
          // Check for timeline gaps if explicit starts exist
          if (Number.isFinite(curr.start) && Number.isFinite(next.start)) {
            const currEnd = curr.start + (Number(curr.duration) || 0);
            if (next.start > currEnd + 0.05) {
              warnings.push(`Skipped transition between clip ${curr.id} and ${next.id} due to a timeline gap.`);
              continue;
            }
          }
          const maxDur = Math.max(0.1, Math.min(2, (Number(curr.duration) || 1) / 2, (Number(next.duration) || 1) / 2));
          const effDur = isRemove ? 0 : Math.min(reqDuration, Number(maxDur.toFixed(2)));
          actions.push({
            id: nextId(),
            type: "transition.set",
            description: isRemove
              ? `Remove transition between ${curr.name || curr.id} and ${next.name || next.id}`
              : `Apply ${transType} transition (${effDur}s) between ${curr.name || curr.id} and ${next.name || next.id}`,
            params: {
              clipId: curr.id,
              transitionId: transType,
              duration: effDur,
            },
          });
          addedCount++;
        }
        if (addedCount > 0) {
          descriptions.push(isRemove ? `Remove transitions from ${addedCount} cut(s)` : `Add ${transType} transitions across ${addedCount} cut(s)`);
        }
      }
    } else {
      const clipId = resolveClipTargetFromText(text, projectSummary, visuals[0]?.id || "");
      if (clipId) {
        const targetIdx = visuals.findIndex((c) => c.id === clipId);
        if (targetIdx >= visuals.length - 1 && !isRemove) {
          warnings.push(`Cannot apply a transition to the final clip (${clipId}) because a transition requires a following visual clip.`);
        } else {
          const next = visuals[targetIdx + 1];
          const maxDur = next ? Math.max(0.1, Math.min(2, (Number(visuals[targetIdx].duration) || 1) / 2, (Number(next.duration) || 1) / 2)) : 0.5;
          const effDur = isRemove ? 0 : Math.min(reqDuration, Number(maxDur.toFixed(2)));
          actions.push({
            id: nextId(),
            type: "transition.set",
            description: isRemove ? `Remove transition from clip ${clipId}` : `Apply ${transType} transition (${effDur}s) to clip ${clipId}`,
            params: {
              clipId,
              transitionId: transType,
              duration: effDur,
            },
          });
          descriptions.push(isRemove ? "Remove transition" : `Add ${transType} transition (${effDur}s)`);
        }
      } else {
        warnings.push("No visual clip found to attach transition to.");
      }
    }
  }

  // 4b. Intra-clip Visual Fades (Fade In / Fade Out)
  // Distinguish intra-clip entry/exit fade from cross-clip transitions
  const isClipFadeRequest = /\b(?:fade\s*in|fade\s*out)\b/i.test(text) &&
    !isTransitionRequest &&
    !/\b(?:between\s+(?:the\s+)?(?:cuts|clips))\b/i.test(text) &&
    !/\b(?:music|song|soundtrack|audio|dialogue|voiceover)\b/i.test(text);

  if (isClipFadeRequest) {
    const isOut = /\bfade\s*out\b/i.test(text);
    const isAllClips = /\b(?:each\s+clip|all\s+clips|every\s+clip|all\s+visuals|whole\s+video|entire\s+video)\b/i.test(text);
    const durMatch = text.match(/\b(\d+(?:\.\d+)?)\s*(?:s|sec|second(?:s)?)?\b/i);
    const fadeDuration = durMatch ? Math.min(10, Math.max(0.1, parseFloat(durMatch[1]))) : 0.5;

    if (isAllClips) {
      actions.push({
        id: nextId(),
        type: "clip.set_property",
        description: `Apply visual ${isOut ? "fade out" : "fade in"} (${fadeDuration}s) to all visual clips`,
        params: {
          scope: "all",
          property: isOut ? "fadeOut" : "fadeIn",
          value: fadeDuration,
        },
      });
      descriptions.push(`Visual ${isOut ? "fade out" : "fade in"} across all clips`);
    } else {
      const clipId = resolveClipTargetFromText(text, projectSummary, visuals[0]?.id || "");
      if (clipId) {
        actions.push({
          id: nextId(),
          type: "clip.set_property",
          description: `Apply visual ${isOut ? "fade out" : "fade in"} (${fadeDuration}s) to clip ${clipId}`,
          params: {
            clipId,
            property: isOut ? "fadeOut" : "fadeIn",
            value: fadeDuration,
          },
        });
        descriptions.push(`Visual ${isOut ? "fade out" : "fade in"} on clip ${clipId}`);
      } else {
        warnings.push("No visual clip found to apply fade to.");
      }
    }
  }

  // 5. Clip Speed (Relative & Explicit, Whole-project vs Selected vs Single Clip, Audio Pitch Preservation)
  // Matches: "make this video a little faster", "speed this up", "double the speed", "slow this down to half speed",
  // "set the selected clip to 1.5x", "speed up the whole video", "apply the same speed to all selected clips", "preserve audio pitch"
  const isSpeedPrompt = /\b(?:speed\s*up|slow\s*down|change\s+speed|set\s+speed|faster|slower|double\s+the\s+speed|twice\s+as\s+fast|half\s+speed|playback\s+rate|\d+(?:\.\d+)?x\s+speed)\b/i.test(text)
    && !/\b(?:transition|transitions)\b/i.test(text)
    && !/\b(?:punch[- ]in|zoom\s+animation|zoom\s+transition)\b/i.test(text);
  if (isSpeedPrompt) {
    let speed = 1.25; // Default sensible increment
    if (/\b(?:double\s+the\s+speed|twice\s+as\s+fast|2x\s+speed|to\s+2x)\b/i.test(text)) {
      speed = 2.0;
    } else if (/\b(?:half\s+speed|half\s+as\s+fast|0\.5x)\b/i.test(text)) {
      speed = 0.5;
    } else if (/\b(?:a\s+little\s+slower|a\s+bit\s+slower|slow\s*down)\b/i.test(text) && !/\d+(?:\.\d+)?x/i.test(text)) {
      speed = 0.8;
    } else {
      const explicitNumMatch = text.match(/\b(\d+(?:\.\d+)?)\s*x\b/i) || text.match(/\bto\s+(\d+(?:\.\d+)?)\b/i);
      if (explicitNumMatch) {
        const parsed = parseFloat(explicitNumMatch[1]);
        if (Number.isFinite(parsed) && parsed >= 0.25 && parsed <= 4.0) {
          speed = parsed;
        }
      }
    }

    const isScopeAll = /\b(?:whole\s+video|entire\s+video|all\s+clips|all\s+selected\s+clips|project|everything)\b/i.test(text);
    const preservePitch = /\b(?:preserve(?:\s+the)?\s+audio\s+pitch|without\s+making\s+(?:the\s+)?voices\s+sound\s+strange|pitch\s+preserv)\b/i.test(text);

    const targetClipId = isScopeAll
      ? "all"
      : (projectSummary?.selectedClipId || resolveClipTargetFromText(text, projectSummary, visuals[0]?.id || ""));

    if (targetClipId) {
      actions.push({
        id: nextId(),
        type: "clip.set_speed",
        description: isScopeAll
          ? `Set playback speed of all clips to ${speed}x${preservePitch ? " (preserve pitch)" : ""}`
          : `Set playback speed of clip ${targetClipId} to ${speed}x${preservePitch ? " (preserve pitch)" : ""}`,
        params: {
          clipId: targetClipId,
          speed,
          scope: isScopeAll ? "all" : "clip",
          ...(preservePitch ? { preservePitch: true } : {}),
        },
      });
      descriptions.push(`Set speed to ${speed}x${isScopeAll ? " for all clips" : ""}`);
    }
  }

  // 5b. Video Appearance: Visual Filters, Color Grading & Zoom
  // Matches e.g. "give this a warm cinematic look", "make this clip black and white", "make the footage brighter",
  // "reduce the saturation a little", "make the whole video warmer", "zoom in slightly", "give this clip a subtle glow"
  const isAppearancePrompt = /\b(?:cinematic|noir|vintage|warm(?:er)?|cool(?:er)?|black\s+and\s+white|bright(?:er)?|saturation|contrast|zoom\s+in|scale\s+up|subtle\s+glow|film\s+look|vivid)\b/i.test(text);
  if (isAppearancePrompt) {
    const isScopeAll = /\b(?:whole\s+video|entire\s+video|all\s+clips|project|everything)\b/i.test(text);
    const clipId = isScopeAll ? "all" : (projectSummary?.selectedClipId || resolveClipTargetFromText(text, projectSummary, visuals[0]?.id || ""));

    // Check for Visual Filter mappings
    let filterId = null;
    if (/\b(?:cinematic|film)\b/i.test(text) && /\b(?:warm|warmth|golden)\b/i.test(text)) {
      filterId = "effect-cinematic";
    } else if (/\b(?:black\s+and\s+white|noir|monochrome)\b/i.test(text)) {
      filterId = "effect-noir";
    } else if (/\b(?:subtle\s+glow|soft\s+glow|glow)\b/i.test(text)) {
      filterId = "effect-soft";
    } else if (/\b(?:vintage\s+film|film\s+look|analog)\b/i.test(text)) {
      filterId = "film";
    } else if (/\b(?:cool\s+look|cool\s+tone|cool\s+filter)\b/i.test(text)) {
      filterId = "cool";
    } else if (/\b(?:vivid|vibrant\s+filter)\b/i.test(text)) {
      filterId = "effect-vivid";
    } else if (/\b(?:bright\s+filter|brighten\s+filter)\b/i.test(text)) {
      filterId = "bright";
    }

    if (filterId) {
      actions.push({
        id: nextId(),
        type: "clip.set_filter",
        description: `Apply ${filterId} filter${isScopeAll ? " to all clips" : ` to clip ${clipId}`}`,
        params: {
          clipId: clipId || "all",
          filterId,
          scope: isScopeAll ? "all" : "clip",
        },
      });
      descriptions.push(`Apply ${filterId} filter`);
    }

    // Check for Color Grading: saturation, warmth/temperature, brightness
    const hasSaturation = /\bsaturation\b/i.test(text);
    const hasWarmth = /\b(?:warmer|warmth|temperature|cool(?:er)?)\b/i.test(text) && !filterId;
    const hasBrighter = /\b(?:make\s+(?:the\s+)?footage\s+brighter|brighter|lighter)\b/i.test(text) && !filterId;

    if (hasSaturation || hasWarmth || hasBrighter) {
      const colorGrade = {};
      if (hasSaturation) {
        colorGrade.saturation = /\b(?:reduce|decrease|lower|less)\b/i.test(text) ? -25 : 25;
      }
      if (hasWarmth) {
        colorGrade.temperature = /\b(?:cool|cooler|blue)\b/i.test(text) ? -15 : 15;
      }
      if (hasBrighter) {
        colorGrade.highlights = { luminance: 20 };
        colorGrade.shadows = { luminance: 20 };
      }
      actions.push({
        id: nextId(),
        type: "clip.set_color_grade",
        description: `Apply color grade adjustments${isScopeAll ? " to all clips" : ` to clip ${clipId}`}`,
        params: {
          clipId: clipId || "all",
          colorGrade,
          scope: isScopeAll ? "all" : "clip",
        },
      });
      descriptions.push("Apply color grading adjustments");
    }

    // Check for Zoom / Scale: e.g. "zoom in slightly"
    if (/\b(?:zoom\s+in\s+slightly|scale\s+up\s+slightly)\b/i.test(text)) {
      const scaleVal = 1.15;
      actions.push({
        id: nextId(),
        type: "clip.set_property",
        description: `Zoom in slightly (scale ${scaleVal}x) on clip ${clipId || "selected"}`,
        params: {
          clipId: clipId || (visuals[0]?.id || ""),
          property: "scale",
          value: scaleVal,
        },
      });
      descriptions.push("Zoom in slightly");
    }
  }

  // 6. Split Clip
  // Matches e.g. "split first clip at 3 seconds", "split clip at 5s"
  const splitMatch = text.match(/\bsplit\s+(?:the\s+)?([\w\s-#]+?)?\s*at\s+(\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)?\b/i);
  if (splitMatch) {
    const targetRef = splitMatch[1] || "";
    const splitAt = parseFloat(splitMatch[2]);
    const clipId = resolveClipTargetFromText(targetRef, projectSummary, visuals[0]?.id || "");
    if (clipId && Number.isFinite(splitAt) && splitAt > 0) {
      actions.push({
        id: nextId(),
        type: "visual.split",
        description: `Split clip ${clipId} at ${splitAt}s`,
        params: {
          clipId,
          at: splitAt,
          rightClipId: `${clipId}-split-${Date.now()}`,
        },
      });
      descriptions.push(`Split clip at ${splitAt}s`);
    }
  }

  // 7. Captions positioning
  const captionPosMatch = text.match(/\b(?:position\s+captions?\s+(?:at\s+(?:the\s+)?)?|place\s+captions?\s+(?:at\s+(?:the\s+)?)?)(top|bottom|middle)\b/i);
  if (captionPosMatch) {
    const position = captionPosMatch[1].toLowerCase();
    actions.push({
      id: nextId(),
      type: "caption.set_position",
      description: `Position captions at the ${position}`,
      params: { position },
    });
    descriptions.push(`Position captions at ${position}`);
  }

  // 8a. Active-Word Highlight Color Command (must precede generic karaoke toggle)
  const isColorRequest = isActiveWordColorCommand(text);
  if (isColorRequest) {
    const color = extractActiveWordColor(text);
    if (color) {
      actions.push({
        id: nextId(),
        type: "caption.set_style",
        description: `Change active word highlight color to ${color}`,
        params: { scope: "default", style: { activeWordColor: color } },
      });
      descriptions.push(`Change active word highlight color to ${color}`);
    }
  }

  // 8b. Karaoke / Active-Word Highlighting (toggle enable/disable; never produce neon!)
  const isKaraokeRequest = !isColorRequest &&
    /\b(?:karaoke|active[- ]word|word[- ]by[- ]word|highlight\s+(?:the\s+)?current\s+word)\b/i.test(text);

  if (isKaraokeRequest) {
    const isDisable = /\b(?:turn\s+off|disable|stop|deactivate|remove|off)\b/i.test(text);
    actions.push({
      id: nextId(),
      type: "caption.set_style",
      description: isDisable ? "Disable karaoke highlighting" : "Enable karaoke highlighting",
      params: { scope: "default", style: { karaoke: !isDisable } },
    });
    descriptions.push(isDisable ? "Disable karaoke highlighting" : "Enable karaoke highlighting");
  }

  // 8c. Contextual Ordinal Selection (e.g. "the third one", "option 2")
  const ordinalChoiceMatch = text.match(/^(?:the\s+)?(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|6th|seventh|7th|eighth|8th|ninth|9th|tenth|10th|[1-9]|10)(?:\s+(?:one|choice|option|style|font|effect))?$/i);
  if (ordinalChoiceMatch && conversationContext?.activeClarification?.lastShownOptions?.length) {
    const rawOrdinal = ordinalChoiceMatch[1].toLowerCase();
    const idx = Number.isInteger(Number(rawOrdinal)) ? Number(rawOrdinal) - 1 : (ORDINAL_MAP[rawOrdinal] ?? -1);
    const optionsList = conversationContext.activeClarification.lastShownOptions;
    if (idx >= 0 && idx < optionsList.length) {
      const selected = optionsList[idx];
      if (conversationContext.activeClarification.category === "style" && selected.style) {
        actions.push({
          id: nextId(),
          type: "caption.set_style",
          description: `Apply ${selected.name || selected.id} caption style`,
          params: { scope: "default", style: { ...selected.style } },
        });
        descriptions.push(`Apply ${selected.name || selected.id} caption style`);
      } else if (conversationContext.activeClarification.category === "font" && selected.id) {
        actions.push({
          id: nextId(),
          type: "caption.set_style",
          description: `Change caption font to ${selected.name || selected.id}`,
          params: { scope: "default", style: { fontId: selected.id } },
        });
        descriptions.push(`Change caption font to ${selected.name || selected.id}`);
      } else if (conversationContext.activeClarification.category === "effect" && (selected.effect || selected.id)) {
        const effectVal = selected.effect || selected.id;
        actions.push({
          id: nextId(),
          type: "caption.set_style",
          description: `Apply ${selected.name || effectVal} caption effect`,
          params: { scope: "default", style: { effect: effectVal } },
        });
        descriptions.push(`Apply ${selected.name || effectVal} caption effect`);
      }
    }
  }

  // 8d. Explicit Caption Effect (e.g. "Apply neon effect", "Set caption effect to normal", "Apply Neon caption effect")
  const explicitEffectMatch =
    text.match(/\b(?:apply|set|make|use|change\s+to)?\s*(?:the\s+)?(?:caption\s+)?effect\s*(?:to\s+|as\s+)?(normal|neon)\b/i) ||
    text.match(/\b(?:apply|set|make|use|change\s+to)?\s*(?:the\s+)?(normal|neon)\s+(?:caption\s+)?effect\b/i) ||
    text.match(/\b(normal|neon)\s+(?:caption\s+)?effect\b/i);

  if (explicitEffectMatch && !isKaraokeRequest && !isColorRequest && !ordinalChoiceMatch) {
    const effect = explicitEffectMatch[1].toLowerCase();
    actions.push({
      id: nextId(),
      type: "caption.set_style",
      description: `Apply ${effect === "neon" ? "Neon" : "Normal"} caption effect`,
      params: { scope: "default", style: { effect } },
    });
    descriptions.push(`Apply ${effect === "neon" ? "Neon" : "Normal"} caption effect`);
  }

  // Remove / disable caption effect: "Remove the caption effect but keep the current font and colors"
  const isRemoveCaptionEffect = /\b(?:remove|disable|turn\s+off|clear|without)\s+(?:the\s+)?(?:current\s+)?caption\s+effect\b/i.test(text);
  if (isRemoveCaptionEffect && !explicitEffectMatch) {
    actions.push({
      id: nextId(),
      type: "caption.set_style",
      description: "Remove caption effect (set to Normal)",
      params: { scope: "default", style: { effect: "normal" } },
    });
    descriptions.push("Remove caption effect (Normal)");
  }

  // 8e. Explicit Font Selection
  const explicitFontMatch =
    text.match(/\b(?:change|set|switch|use)?\s*(?:the\s+)?(?:captions?|subtitles?)?\s*font(?:\s+family)?\s*(?:to\s+|as\s+)?([a-zA-Z0-9\s-]+)\b/i) ||
    text.match(/\b(?:change|set|switch|use)\s+([a-zA-Z0-9\s-]+)\s+font\s+(?:for\s+captions?|on\s+captions?)?\b/i);

  if (explicitFontMatch && !isKaraokeRequest && !ordinalChoiceMatch && !isColorRequest && !explicitEffectMatch && !isRemoveCaptionEffect) {
    const rawFontName = explicitFontMatch[1].trim();
    const foundFont = findCaptionFontInCatalog(rawFontName);
    if (foundFont) {
      actions.push({
        id: nextId(),
        type: "caption.set_style",
        description: `Change caption font to ${foundFont.label || foundFont.family}`,
        params: { scope: "default", style: { fontId: foundFont.id } },
      });
      descriptions.push(`Change caption font to ${foundFont.label || foundFont.family}`);
    }
  }

  // 8f. Explicit Style Preset or Relative Size (do not confuse caption effects with full caption-style presets!)
  if (!isKaraokeRequest && !ordinalChoiceMatch && !isColorRequest && !explicitEffectMatch && !isRemoveCaptionEffect && !/\beffect\b/i.test(text)) {
    // Check if user explicitly asked for a preset like Neon, Classic, Bold, Minimal, Social, Plain, Outline, Translucent
    const explicitPresetMatch =
      text.match(/\b(?:apply|set|make|use|change\s+to)?\s*(?:the\s+)?(?:existing\s+)?(neon|classic|bold|karaoke|minimal|social|plain|outline|translucent)\s+(?:caption\s+)?style\b/i) ||
      text.match(/\b(neon|classic|bold|minimal|social|plain|outline|translucent)\s+captions?\b/i);

    if (explicitPresetMatch) {
      const presetName = explicitPresetMatch[1].toLowerCase();
      const preset = findCaptionStylePreset(presetName);
      if (preset) {
        actions.push({
          id: nextId(),
          type: "caption.set_style",
          description: `Apply ${preset.name || preset.id} caption style`,
          params: { scope: "default", style: { ...preset.style } },
        });
        descriptions.push(`Apply ${preset.name || preset.id} caption style`);
      }
    } else {
      // Relative size changes e.g. "make all captions slightly bigger", "make captions larger"
      const sizeMatch = text.match(/\b(?:make\s+(?:all\s+)?(?:the\s+)?captions?|caption\s+size\s+(?:to|as)?)\s*(?:a\s+little\s+|a\s+bit\s+|slightly\s+)?(larger|smaller|bigger|tiny|huge)\b/i);
      if (sizeMatch) {
        const val = sizeMatch[1].toLowerCase();
        const isSlight = /\b(?:slightly|a\s+bit|a\s+little)\b/i.test(text);
        const currentSize = Number(projectSummary?.captionStyle?.captionSize) || Number(projectSummary?.captionSize) || 14;
        let size;
        if (val === "larger" || val === "bigger") {
          size = isSlight ? Math.min(42, Math.max(16, currentSize + 4)) : 22;
        } else if (val === "huge") {
          size = 32;
        } else if (val === "smaller" || val === "tiny") {
          size = isSlight ? Math.max(12, currentSize - 2) : 12;
        } else {
          size = 18;
        }
        actions.push({
          id: nextId(),
          type: "caption.set_style",
          description: `Set caption size (${isSlight ? "slightly " : ""}${val})`,
          params: { scope: "default", style: { captionSize: size } },
        });
        descriptions.push(`Set caption size to ${size}`);
      }
    }
  }

  // 8b. Caption Background Opacity
  const captionBgOpacityMatch =
    text.match(/\b(?:set|make|change)?\s*(?:the\s+)?(?:all\s+)?captions?\s*(?:backgrounds?|bg)?\s*(?:background\s+opacity|bg\s+opacity|opacity)\s*(?:to|of|as|at)?\s*([0-9.]+%?|zero|transparent|opaque|full)\b/i) ||
    text.match(/\b(?:set|make|change)?\s*(?:the\s+)?(?:background\s+opacity|bg\s+opacity)\s*(?:of\s+)?(?:all\s+)?(?:the\s+)?captions?\s*(?:to|as|at)?\s*([0-9.]+%?|zero|transparent|opaque|full)\b/i) ||
    text.match(/\bmake\s+(?:all\s+)?(?:the\s+)?captions?\s+backgrounds?\s+([0-9.]+%?)\s*opaque\b/i) ||
    text.match(/\b(?:set|make)\s+(?:all\s+)?(?:the\s+)?captions?\s+backgrounds?\s+(transparent|opaque)\b/i);
  if (captionBgOpacityMatch) {
    const rawVal = captionBgOpacityMatch[1].toLowerCase().trim();
    let opacity;
    if (rawVal === "zero" || rawVal === "transparent") {
      opacity = 0;
    } else if (rawVal === "opaque" || rawVal === "full") {
      opacity = 1;
    } else if (rawVal.endsWith("%")) {
      const pct = Number.parseFloat(rawVal);
      if (Number.isFinite(pct)) opacity = Math.max(0, Math.min(1, Number((pct / 100).toFixed(3))));
    } else {
      const num = Number.parseFloat(rawVal);
      if (Number.isFinite(num)) opacity = Math.max(0, Math.min(1, num));
    }

    if (opacity !== undefined && Number.isFinite(opacity)) {
      actions.push({
        id: nextId(),
        type: "caption.set_style",
        description: `Set caption background opacity to ${opacity}`,
        params: { scope: "default", style: { backgroundOpacity: opacity } },
      });
      descriptions.push(`Set caption background opacity to ${opacity}`);
    }
  }

  // 9. Add Captions
  // Matches e.g. "add captions", "generate captions", "create captions"
  const addCaptionsMatch = text.match(/\b(?:add|generate|create)\s+(?:all\s+)?captions?\b/i);
  if (addCaptionsMatch && !captionPosMatch && !captionBgOpacityMatch) {
    actions.push({
      id: nextId(),
      type: "tool.generate_captions",
      description: "Transcribe audio and generate subtitles",
      params: {},
    });
    descriptions.push("Generate captions");
  }

  // 10. Background Music Volume & Audio Ducking & Fades
  const isAudioDucking = /\b(?:duck(?:ing)?|lower\s+(?:the\s+)?(?:background\s+)?music\s+(?:while|when)\s+(?:someone|people|voice|anybody|somebody)\s+(?:is\s+)?(?:talking|speaks?)|(?:make\s+(?:the\s+)?(?:background\s+)?music\s+)?quieter\s+(?:when|while)\s+(?:someone|people|anybody|somebody|voice)\s+(?:speaks?|talks?|is\s+talking)|quieter\s+during\s+(?:dialogue|speech)|voiceover\s+louder\s+than\s+(?:the\s+)?music)\b/i.test(text);
  const isMusicFade = /\b(?:fade\s+(?:the\s+)?music\s+(?:in|out)|fade\s+(?:in|out)(?:\s+(?:the\s+)?music)?)\b/i.test(text);
  let musicVolMatch = null;

  if (isAudioDucking) {
    if (musicSegments.length === 0) {
      const msg = "I couldn't find a background music track in this project. Add a music clip first, or tell me which existing audio track you want to adjust.";
      warnings.push(msg);
      customExplanation = msg;
    } else {
      const hasDialogue = (audioSegments && audioSegments.length > 0) || (captionSegments && captionSegments.length > 0);
      if (!hasDialogue) {
        const msg = "No speech or caption dialogue found to duck music against. Add dialogue or captions first, or tell me if you want to lower the overall music volume.";
        warnings.push(msg);
        customExplanation = msg;
      } else {
        const musicClipId = musicSegments[0].id;
        actions.push({
          id: nextId(),
          type: "music.duck",
          description: "Audio ducking: reduce background music to 18% during dialogue and restore between speech segments",
          params: {
            clipId: musicClipId,
            duckVolume: 0.18,
            normalVolume: Number(musicSegments[0]?.volume) || 0.8,
          },
        });
        descriptions.push("Apply time-dependent audio ducking (music to 18% during dialogue, restored otherwise)");
        assumptions.push("Voiceover audio track volume remains untouched at 100% while music ducks during dialogue.");
        if (musicSegments.length > 1) {
          assumptions.push(`Ducking applied to primary music clip: ${musicClipId}.`);
        }
      }
    }
  } else if (isMusicFade) {
    if (musicSegments.length === 0) {
      const msg = "I couldn't find a background music track in this project. Add a music clip first.";
      warnings.push(msg);
      customExplanation = msg;
    } else {
      const isOut = /\bout\b/i.test(text);
      const musicClipId = musicSegments[0].id;
      actions.push({
        id: nextId(),
        type: "clip.set_property",
        description: `Fade ${isOut ? "out" : "in"} background music (2.0s)`,
        params: {
          clipId: musicClipId,
          property: isOut ? "fadeOut" : "fadeIn",
          value: 2.0,
          track: "music",
          targetTrack: "music",
        },
      });
      descriptions.push(`Fade ${isOut ? "out" : "in"} music`);
    }
  } else {
    // Normal music volume adjustment
    musicVolMatch = text.match(/\b(?:lower|reduce|decrease|drop|turn\s+down|set|make)\s+(?:the\s+)?(?:background\s+)?music(?:\s+volume)?\s*(?:to\s+(\d+)%?|\s+by\s+\d+%?|quieter)?\b/i);
    if (musicVolMatch) {
      if (musicSegments.length === 0) {
        const msg = "I couldn't find a background music track in this project. Add a music clip first, or tell me which existing audio track you want to adjust.";
        warnings.push(msg);
        customExplanation = msg;
      } else {
        const rawVal = musicVolMatch[1] ? parseInt(musicVolMatch[1], 10) : 20;
        const volume = rawVal > 1 ? Number((rawVal / 100).toFixed(2)) : rawVal;
        const musicClipId = musicSegments[0].id;

        actions.push({
          id: nextId(),
          type: "clip.set_property",
          description: `Set background music volume to ${Math.round(volume * 100)}% (voiceover preserved)`,
          params: {
            clipId: musicClipId,
            property: "volume",
            value: volume,
            track: "music",
            targetTrack: "music",
          },
        });
        descriptions.push(`Set music volume to ${Math.round(volume * 100)}%`);
        if (/without\s+(?:changing|affecting|muting|altering)\s+(?:the\s+)?(?:voiceover|voice|audio)/i.test(text)) {
          assumptions.push("Voiceover audio track volume remains untouched at 100%.");
        }
      }
    }
  }

  // 11. Mute Clip
  const muteMatch = text.match(/\b(mute|unmute)\s+(?:the\s+)?([\w\s-#]+?)(?:\s+clip)?\b/i);
  if (muteMatch && !musicVolMatch) {
    const isMute = muteMatch[1].toLowerCase() === "mute";
    const targetRef = muteMatch[2] || "";
    let clipId = "";
    if (/music|soundtrack|bgm/i.test(targetRef)) {
      if (musicSegments.length === 0) {
        warnings.push("No music clip found in project to mute.");
      } else {
        clipId = musicSegments[0].id;
      }
    } else if (/voice|voiceover|narration/i.test(targetRef)) {
      if (audioSegments.length === 0) {
        warnings.push("No voiceover audio clip found in project to mute.");
      } else {
        clipId = audioSegments[0].id;
      }
    } else {
      clipId = resolveClipTargetFromText(targetRef, projectSummary, visuals[0]?.id || "");
    }
    if (clipId) {
      actions.push({
        id: nextId(),
        type: "clip.set_muted",
        description: `${isMute ? "Mute" : "Unmute"} ${clipId}`,
        params: { clipId, muted: isMute },
      });
      descriptions.push(`${isMute ? "Mute" : "Unmute"} ${clipId}`);
    }
  }

  // 12. Smart Features: Rough Cut & Silence Removal
  const requestsFillerRemoval = /\b(?:remove|cut|delete|strip)\s+(?:the\s+)?filler(?:\s+words?)?\b/i.test(text);
  const requestsRoughCut = /\b(?:make|create|apply)?\s*(?:a\s+|this\s+|the\s+)?(?:basic\s+|clean\s+)?rough\s+cut\b/i.test(text)
    || /\bmake\s+(?:this\s+)?(?:video|interview|footage)\s+tighter\b/i.test(text)
    || requestsFillerRemoval;
  const requestsPauseRemoval = /\b(?:silence\s+removal|(?:remove|cut(?:\s*out)?|delete|clear|clean\s+up)\s+(?:the\s+)?(?:long\s+|unnecessary\s+)?(?:pauses?|silence|silent\s+gaps?|gaps?|dead\s+air)|cut\s+silence)\b/i.test(text);
  const smartClipId = resolveClipTargetFromText(text, projectSummary, projectSummary?.selectedClipId || visuals[0]?.id || "");
  if (!smartFeatureQuestion && requestsRoughCut) {
    actions.push({
      id: nextId(),
      type: "tool.rough_cut",
      description: requestsFillerRemoval
        ? "Analyze pauses and filler words for AI Rough Cut review"
        : "Analyze pauses for AI Rough Cut review",
      params: { clipId: smartClipId, removeFillerWords: requestsFillerRemoval },
    });
    descriptions.push("AI Rough Cut review");
  } else if (!smartFeatureQuestion && requestsPauseRemoval) {
    actions.push({
      id: nextId(),
      type: "tool.silence_removal",
      description: "Analyze silent gaps for Remove Pauses review",
      params: { clipId: smartClipId },
    });
    descriptions.push("Remove Pauses review");
  }
  if (/\b(?:detect\s+scenes|scene\s+detection)\b/i.test(text)) {
    actions.push({
      id: nextId(),
      type: "tool.scene_detection",
      description: "Scan video for visual scene changes",
      params: { clipId: visuals[0]?.id || "" },
    });
    descriptions.push("Scene Detection");
  }
  if (/\b(?:smart\s+frame|auto[- ]reframe)\b/i.test(text)) {
    actions.push({
      id: nextId(),
      type: "tool.smart_frame",
      description: "Enable AI Smart Frame 9:16 speaker tracking",
      params: { enabled: true },
    });
    descriptions.push("Smart Frame");
  }

  // 12b. AI Smart Zoom & Automatic Punch-ins
  // 12b.1 Inspection query ("Show me where you added punch-ins")
  const isPunchInInspection = /\b(?:show\s+(?:me\s+)?(?:where\s+you\s+added\s+punch[- ]ins|where\s+are\s+the\s+punch[- ]ins|the\s+punch[- ]ins)|where\s+(?:did\s+you\s+add\s+zooms?|are\s+the\s+zooms?|are\s+the\s+punch[- ]ins)|list\s+(?:all\s+)?punch[- ]ins?|inspect\s+punch[- ]ins?)\b/i.test(text);
  if (isPunchInInspection) {
    const report = inspectPunchIns(projectSummary);
    if (report.count === 0) {
      customExplanation = "No punch-ins have been added to the project yet. You can ask me to add punch-ins at speech moments or at specific timestamps.";
    } else {
      const details = report.punchIns.map((p, i) => `${i + 1}. Clip "${p.clipName || p.clipId}" at ${p.timelineTime}s (scale ${p.scale}x, ${p.transition} cut${p.faceAnchored ? ", face-centered" : ""})`).join("; ");
      customExplanation = `Found ${report.count} punch-in${report.count === 1 ? "" : "s"} on your timeline: ${details}.`;
    }
  }

  // 12b.2 Reset Zoom ("Reset zoom on the selected clip", "Reset zoom on all clips", "Reset zooms")
  const isResetZoom = /\b(?:reset\s+zoom(?:s)?|remove\s+all\s+zooms?|clear\s+zooms?|reset\s+punch[- ]ins?|original\s+framing)\b/i.test(text);
  if (isResetZoom) {
    const isSelectedOnly = /\b(?:selected(?:\s+clip)?|this\s+clip|current\s+clip)\b/i.test(text);
    const isAll = /\b(?:all(?:\s+clips)?|whole\s+timeline|entire\s+timeline|project)\b/i.test(text) || !isSelectedOnly;
    const clipId = isSelectedOnly ? (projectSummary?.selectedClipId || visuals[0]?.id || "selected") : "all";
    actions.push({
      id: nextId(),
      type: "visual.reset_zoom",
      description: `Reset zoom to original framing on ${isAll ? "all clips" : clipId}`,
      params: {
        scope: isAll ? "all" : "clip",
        clipId,
      },
    });
    descriptions.push(`Reset zoom on ${isAll ? "all clips" : clipId}`);
  }

  // 12b.3 Remove individual punch-in ("Remove the punch-in at 00:00:08")
  const removePunchInMatch = text.match(/\b(?:remove|delete)\s+(?:the\s+)?punch[- ]in\b/i);
  if (removePunchInMatch && !isResetZoom) {
    const targetTimestamp = parseTimestampFromText(text);
    actions.push({
      id: nextId(),
      type: "visual.remove_punch_in",
      description: targetTimestamp !== null
        ? `Remove punch-in at ${targetTimestamp}s`
        : "Remove punch-in",
      params: {
        time: targetTimestamp !== null ? targetTimestamp : undefined,
        scope: "all",
        clipId: "all",
      },
    });
    descriptions.push(targetTimestamp !== null ? `Remove punch-in at ${targetTimestamp}s` : "Remove punch-in");
  }

  // 12b.4 Zoom intensity adjustment follow-up ("Make all zooms 30% less intense", "Make zoom more intense", "Make the zoom stronger")
  const isLessIntense = /\b(?:make\s+(?:all\s+)?(?:the\s+)?zooms?\s+(?:(\d+)%?\s*)?(?:less\s+intense|weaker|subtler|gentler)|(?:less\s+intense|weaker|subtler|gentler)\s+zoom)\b/i.test(text);
  const isMoreIntense = /\b(?:make\s+(?:all\s+)?(?:the\s+)?zooms?\s+(?:(\d+)%?\s*)?(?:more\s+intense|stronger|deeper|bigger)|(?:more\s+intense|stronger|deeper|bigger)\s+zoom)\b/i.test(text);
  if ((isLessIntense || isMoreIntense) && !isResetZoom && !removePunchInMatch) {
    const pctMatch = text.match(/(\d+)%/);
    const pct = pctMatch ? parseInt(pctMatch[1], 10) : 30;
    // Base 1.25 -> 30% less of the 0.25 delta is ~0.175 (1.17)
    const nextScale = isLessIntense
      ? Math.max(1.05, Number((1 + (0.25 * (1 - pct / 100))).toFixed(3)))
      : Math.min(2.0, Number((1 + (0.25 * (1 + pct / 100))).toFixed(3)));

    actions.push({
      id: nextId(),
      type: "visual.punch_in",
      description: `Adjust zoom intensity across all punch-ins to ${nextScale}x`,
      params: {
        scale: nextScale,
        scope: "all",
        clipId: "all",
      },
    });
    descriptions.push(`Adjust zoom intensity to ${nextScale}x`);
  }

  // 12b.5 Transition style follow-up ("Use a smooth push-in instead of jump cuts", "Make the zoom transitions slower", "Slow down the punch-in animation")
  const isSmoothFollowup = /\b(?:use\s+a\s+smooth\s+push[- ]in(?:\s+instead\s+of\s+jump\s+cuts?)?|smooth\s+push[- ]in\s+instead|make\s+(?:it\s+)?smooth\s+zooms?)\b/i.test(text);
  const isSlowerTransition = /\b(?:make\s+(?:the\s+)?(?:zoom\s+transitions?|punch[- ]in(?:\s+animations?|\s+transitions?)?)\s+slower|slower\s+(?:zoom\s+transitions?|punch[- ]ins?)|slow\s*down\s+(?:the\s+)?(?:punch[- ]in(?:\s+animations?|\s+transitions?)?|zoom\s+transitions?))\b/i.test(text);
  const isFasterTransition = /\b(?:make\s+(?:the\s+)?(?:zoom\s+transitions?|punch[- ]in(?:\s+animations?|\s+transitions?)?)\s+faster|faster\s+(?:zoom\s+transitions?|punch[- ]ins?)|speed\s*up\s+(?:the\s+)?(?:punch[- ]in(?:\s+animations?|\s+transitions?)?|zoom\s+transitions?))\b/i.test(text);
  const isFaceCenteringFollowup = /\b(?:keep\s+(?:the\s+)?speaker\s+centered(?:\s+during\s+each\s+punch[- ]in)?|center\s+speaker\s+during\s+zooms?|face\s+anchored\s+zoom)\b/i.test(text);

  if ((isSmoothFollowup || isSlowerTransition || isFasterTransition || isFaceCenteringFollowup) && !isResetZoom && !removePunchInMatch && !isLessIntense && !isMoreIntense) {
    const transition = (isSmoothFollowup || isSlowerTransition || isFasterTransition) ? "smooth" : undefined;
    const transitionDuration = isSlowerTransition ? 0.6 : isFasterTransition ? 0.15 : (isSmoothFollowup ? 0.35 : undefined);
    const faceAnchored = isFaceCenteringFollowup ? true : undefined;

    actions.push({
      id: nextId(),
      type: "visual.punch_in",
      description: `Update Smart Zoom style (${[transition, transitionDuration ? `${transitionDuration}s` : "", faceAnchored ? "face-centered" : ""].filter(Boolean).join(", ")})`,
      params: {
        ...(transition ? { transition } : {}),
        ...(transitionDuration ? { transitionDuration } : {}),
        ...(faceAnchored !== undefined ? { faceAnchored } : {}),
        scope: "all",
        clipId: "all",
      },
    });
    descriptions.push("Update Smart Zoom transition and anchoring style");
  }

  // 12b.6 Add Smart Zoom / Punch-in ("Add subtle punch-ins at important moments", "Add punch-ins during speech", "Zoom in 20% at 00:00:08")
  const isAddPunchIn = /\b(?:add|apply|create)\s+(?:subtle\s+)?punch[- ]ins?|smart\s+zoom|zoom\s+in(?:\s+\d+%?)?\b/i.test(text) &&
    !isResetZoom && !removePunchInMatch && !isLessIntense && !isMoreIntense && !isSmoothFollowup && !isSlowerTransition && !isFasterTransition && !isFaceCenteringFollowup && !isPunchInInspection;

  if (isAddPunchIn) {
    const targetTimestamp = parseTimestampFromText(text);
    const isSubtle = /\bsubtle\b/i.test(text);
    const pctMatch = text.match(/(\d+)%\s*(?:zoom|in)?/i);
    const scale = pctMatch
      ? normalizePunchInScale(parseInt(pctMatch[1], 10))
      : (isSubtle ? 1.15 : SMART_ZOOM_DEFAULTS.scale);

    const transition = /\bsmooth|push[- ]in\b/i.test(text) ? "smooth" : "jump";
    const faceAnchored = /\b(?:face|speaker|centered|center)\b/i.test(text);
    const isSelectedOnly = /\b(?:selected(?:\s+clip)?(?:\s+only)?|this\s+clip(?:\s+only)?)\b/i.test(text);
    const isWholeTimeline = /\b(?:whole\s+timeline|entire\s+timeline|all\s+clips)\b/i.test(text);
    const excludeIntro = /\b(?:exclude|except)\s+(?:the\s+)?(?:intro|introduction|first\s+clip)\b/i.test(text);
    const introClip = visuals.find((c) => c.name && /intro/i.test(c.name)) || visuals[0];
    const excludeClipIds = excludeIntro && introClip?.id ? [introClip.id] : [];

    if (targetTimestamp !== null) {
      // User-specified timestamp punch-in
      const targetClipId = isSelectedOnly
        ? (projectSummary?.selectedClipId || visuals[0]?.id || "selected")
        : resolveClipTargetFromText(text, projectSummary, visuals[0]?.id || "vis-1");

      actions.push({
        id: nextId(),
        type: "visual.punch_in",
        description: `Zoom in ${Math.round((scale - 1) * 100)}% at ${targetTimestamp}s (${transition} transition)`,
        params: {
          clipId: targetClipId,
          time: targetTimestamp,
          timelineTime: targetTimestamp,
          scale,
          transition,
          faceAnchored,
        },
      });
      descriptions.push(`Zoom in ${Math.round((scale - 1) * 100)}% at ${targetTimestamp}s`);
    } else {
      // Automatic moment selection based on speech / caption timing
      actions.push({
        id: nextId(),
        type: "visual.punch_in",
        description: `Add ${isSubtle ? "subtle " : ""}punch-ins at speech moments (${Math.round((scale - 1) * 100)}% zoom, ${transition} cut)`,
        params: {
          mode: "auto",
          scale,
          transition,
          faceAnchored,
          scope: isWholeTimeline ? "all" : (isSelectedOnly ? "clip" : "all"),
          clipId: isSelectedOnly ? (projectSummary?.selectedClipId || visuals[0]?.id || "selected") : "all",
          excludeClipIds,
        },
      });
      descriptions.push(`Add ${isSubtle ? "subtle " : ""}Smart Zoom punch-ins at speech moments`);
      if (excludeIntro) {
        assumptions.push("Introduction clip excluded from punch-in placement.");
      }
    }
  }

  // 13. Duplicate Clip
  // Matches e.g. "duplicate the first clip", "duplicate clip 1", "clone second clip", "copy last clip"
  const duplicateMatch = text.match(/\b(?:duplicate|clone|copy)\s+(?:the\s+)?([\w\s-#]+?)(?:\s+clip)?\b/i);
  if (duplicateMatch && !/audio|voice|music|caption/i.test(duplicateMatch[1])) {
    const targetRef = duplicateMatch[1].trim();
    const clipId = resolveClipTargetFromText(targetRef, projectSummary, visuals[0]?.id || "");
    if (clipId) {
      const targetClip = visuals.find((c) => c.id === clipId);
      const targetIdx = visuals.indexOf(targetClip);
      const atIndex = targetIdx >= 0 ? targetIdx + 1 : visuals.length;
      const newClipId = `${clipId}-dup-${Date.now()}`;
      actions.push({
        id: nextId(),
        type: "visual.duplicate",
        description: `Duplicate visual clip ${clipId} to position ${atIndex + 1}`,
        params: {
          clipId,
          atIndex,
          newClipId,
        },
      });
      descriptions.push(`Duplicate clip ${clipId}`);
    } else {
      warnings.push("Target clip for duplication was not found on the timeline.");
    }
  }

  // 14. Reorder Clip
  const reorderMatch = text.match(/\b(?:reorder|move)\s+(?:the\s+)?([\w\s-#]+?)\s+to\s+(?:(?:the\s+)?end|(?:index\s+|position\s+)?(\d+))\b/i);
  if (reorderMatch) {
    const targetRef = reorderMatch[1];
    const isEnd = /end/i.test(reorderMatch[0].split(/\s+to\s+/i)[1] || "");
    const toIndex = isEnd
      ? Math.max(0, visuals.length - 1)
      : Math.max(0, parseInt(reorderMatch[2], 10) - (reorderMatch[0].includes("index") ? 0 : 1));
    const clipId = resolveClipTargetFromText(targetRef, projectSummary, visuals[0]?.id || "");
    if (clipId) {
      actions.push({
        id: nextId(),
        type: "visual.reorder",
        description: `Reorder clip ${clipId} to index ${toIndex}`,
        params: { clipId, toIndex },
      });
      descriptions.push(`Reorder clip to index ${toIndex}`);
    } else {
      warnings.push("Target clip for reordering was not found on the timeline.");
    }
  }

  // 14. Delete Clip
  const deleteMatch = text.match(/\b(?:delete|remove)\s+(?:the\s+)?([^,.;]+?)(?=\s+(?:and|then)\b|[,.;]|$)/i);
  if (deleteMatch && !/caption|music|audio|voice|pause|silence|filler|word|background|noise|punch|zoom|effect|filter/i.test(deleteMatch[1])) {
    const targetRef = deleteMatch[1].trim();
    const clipId = resolveClipTargetFromText(targetRef, projectSummary, "", false);
    if (clipId) {
      actions.push({
        id: nextId(),
        type: "visual.delete",
        description: `Delete clip ${clipId} from timeline`,
        params: { clipId },
      });
      descriptions.push(`Delete clip ${clipId}`);
    }
  }

  // Deduplicate and validate
  const rawPlan = {
    schemaVersion: 1,
    explanation: customExplanation || (descriptions.length > 0
      ? `I've prepared an editing plan: ${descriptions.join(", ")}.`
      : "I've analyzed your project and prepared editing operations."),
    actions,
    prerequisites: [],
    warnings,
    assumptions,
  };

  return validateAndNormalizePlan(rawPlan);
}
