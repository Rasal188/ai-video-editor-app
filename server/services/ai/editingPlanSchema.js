/**
 * Editing Plan Validation and Normalization Schema
 *
 * Enforces strict server-side allowlisting and parameter constraints
 * on model-generated editing plans.
 */

export const PLAN_SCHEMA_VERSION = 1;
export const MAX_ACTIONS_LIMIT = 20;

import { findCaptionFontInCatalog } from "../../../src/lib/captionFonts.js";
import { resolveColorToHex } from "../../../src/lib/captionStyles.js";
import {
  normalizePunchInScale,
  normalizePunchInTransition,
  SMART_ZOOM_DEFAULTS,
} from "../../../src/lib/smartZoom.js";

export const SUPPORTED_ACTION_TYPES = Object.freeze([
  "project.set_ratio",
  "project.set_fit",
  "visual.split",
  "visual.trim",
  "visual.delete",
  "visual.duplicate",
  "visual.reorder",
  "visual.punch_in",
  "visual.remove_punch_in",
  "visual.reset_zoom",
  "transition.set",
  "clip.set_speed",
  "clip.set_filter",
  "clip.set_color_grade",
  "clip.set_muted",
  "clip.set_property",
  "clip.delete",
  "timed.move",
  "timed.resize",
  "track.set_locked",
  "track.set_visibility",
  "overlay.set_transform",
  "caption.add",
  "caption.update",
  "caption.delete",
  "caption.set_style",
  "caption.set_position",
  "marker.add",
  "marker.update",
  "marker.delete",
  "audio.delete",
  "music.delete",
  "music.duck",
  "tool.scene_detection",
  "tool.silence_removal",
  "tool.rough_cut",
  "tool.smart_pipeline",
  "tool.generate_captions",
  "tool.smart_frame",
  "tool.export",
]);

export const SUPPORTED_RATIOS = Object.freeze(["16:9", "9:16", "1:1", "4:5"]);
export const SUPPORTED_FIT_MODES = Object.freeze(["contain", "cover"]);
export const SUPPORTED_CAPTION_POSITIONS = Object.freeze(["top", "middle", "bottom"]);
export const SUPPORTED_MARKER_COLORS = Object.freeze(["cyan", "magenta", "amber", "emerald", "blue", "red"]);
export const SUPPORTED_TRANSITIONS = Object.freeze(["none", "fade", "zoom", "flash", "wipe-left", "wipe-up", "blur", "split", "glitch"]);
export const SUPPORTED_CLIP_FILTERS = Object.freeze([
  "none", "cool", "film", "bright",
  "effect-clean", "effect-soft", "effect-cinematic", "effect-vivid",
  "effect-night", "effect-warm", "effect-cold", "effect-noir", "effect-dream"
]);
export const SUPPORTED_NUMERIC_CLIP_PROPERTIES = Object.freeze(["volume", "opacity", "scale", "rotation", "x", "y", "fadeIn", "fadeOut", "layer"]);

const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Validates a single action's parameters against its type definition.
 */
export function validateActionParams(type, rawParams) {
  const params = rawParams && typeof rawParams === "object" && !Array.isArray(rawParams) ? rawParams : {};
  if (!rawParams && !type.startsWith("tool.") && !["audio.delete", "music.delete"].includes(type)) {
    throw new Error(`Action "${type}" params must be an object.`);
  }

  const clean = {};

  switch (type) {
    case "project.set_ratio": {
      const ratio = String(params.ratio || params.ratioId || "").trim();
      if (!SUPPORTED_RATIOS.includes(ratio)) {
        throw new Error(`Unsupported ratio: "${ratio}". Must be one of: ${SUPPORTED_RATIOS.join(", ")}.`);
      }
      clean.ratio = ratio;
      clean.ratioId = ratio;
      break;
    }

    case "project.set_fit": {
      const fitMode = String(params.fitMode || "").trim().toLowerCase();
      if (!SUPPORTED_FIT_MODES.includes(fitMode)) {
        throw new Error(`Unsupported fitMode: "${fitMode}". Must be one of: ${SUPPORTED_FIT_MODES.join(", ")}.`);
      }
      clean.fitMode = fitMode;
      break;
    }

    case "visual.split": {
      const clipId = String(params.clipId || "").trim();
      if (!clipId) throw new Error("visual.split requires a valid clipId.");
      const at = Number(params.at);
      if (!Number.isFinite(at) || at <= 0) {
        throw new Error("visual.split 'at' timestamp must be a positive finite number.");
      }
      clean.clipId = clipId;
      clean.at = Number(at.toFixed(3));
      clean.rightClipId =
        params.rightClipId && typeof params.rightClipId === "string" && params.rightClipId.trim()
          ? params.rightClipId.trim().slice(0, 64)
          : `${clipId}-split-${Date.now()}`;
      break;
    }

    case "visual.trim": {
      const clipId = String(params.clipId || "").trim();
      if (!clipId) throw new Error("visual.trim requires a valid clipId.");
      let sourceIn = Number(params.sourceIn);
      let sourceOut = Number(params.sourceOut);
      if (!Number.isFinite(sourceOut) && Number.isFinite(params.duration) && Number(params.duration) > 0) {
        sourceIn = Number.isFinite(sourceIn) && sourceIn >= 0 ? sourceIn : 0;
        sourceOut = sourceIn + Number(params.duration);
      }
      if (!Number.isFinite(sourceIn) || sourceIn < 0) {
        throw new Error("visual.trim sourceIn must be a non-negative finite number.");
      }
      if (!Number.isFinite(sourceOut) || sourceOut <= sourceIn) {
        throw new Error("visual.trim sourceOut must be greater than sourceIn.");
      }
      clean.clipId = clipId;
      clean.sourceIn = Number(sourceIn.toFixed(3));
      clean.sourceOut = Number(sourceOut.toFixed(3));
      clean.duration = Number((clean.sourceOut - clean.sourceIn).toFixed(3));
      break;
    }

    case "visual.delete": {
      const clipId = String(params.clipId || "").trim();
      if (!clipId) throw new Error("visual.delete requires a valid clipId.");
      clean.clipId = clipId;
      break;
    }

    case "visual.duplicate": {
      const clipId = String(params.clipId || "").trim();
      if (!clipId) throw new Error("visual.duplicate requires a valid clipId.");
      clean.clipId = clipId;
      if (params.atIndex !== undefined) {
        const atIndex = Number.parseInt(params.atIndex, 10);
        if (!Number.isNaN(atIndex) && atIndex >= 0) clean.atIndex = atIndex;
      }
      clean.newClipId =
        params.newClipId && typeof params.newClipId === "string" && params.newClipId.trim()
          ? params.newClipId.trim().slice(0, 64)
          : `${clipId}-dup-${Date.now()}`;
      break;
    }

    case "visual.punch_in": {
      const clipId = String(params.clipId || "").trim();
      const scope = params.scope && typeof params.scope === "string" ? params.scope.trim().toLowerCase() : (clipId === "all" ? "all" : "clip");
      const mode = params.mode === "auto" ? "auto" : "manual";
      if (!clipId && scope !== "all" && mode !== "auto") {
        clean.clipId = "selected";
      } else {
        clean.clipId = clipId || "all";
      }
      clean.scope = scope;
      clean.mode = mode;

      if (params.time !== undefined) {
        const t = Number(params.time);
        if (!Number.isFinite(t) || t < 0) {
          throw new Error("visual.punch_in requires non-negative 'time'.");
        }
        clean.time = Number(t.toFixed(3));
      }
      if (params.timestamp !== undefined) {
        const t = Number(params.timestamp);
        if (!Number.isFinite(t) || t < 0) {
          throw new Error("visual.punch_in requires non-negative 'timestamp'.");
        }
        clean.time = Number(t.toFixed(3));
      }
      if (params.timelineTime !== undefined && Number.isFinite(Number(params.timelineTime))) {
        clean.timelineTime = Math.max(0, Number(Number(params.timelineTime).toFixed(3)));
      }
      if (params.duration !== undefined && Number.isFinite(Number(params.duration))) {
        clean.duration = Math.max(SMART_ZOOM_DEFAULTS.minDuration, Math.min(SMART_ZOOM_DEFAULTS.maxDuration, Number(Number(params.duration).toFixed(3))));
      } else {
        clean.duration = SMART_ZOOM_DEFAULTS.duration;
      }
      if (params.scale !== undefined || params.intensity !== undefined) {
        const s = Number(params.scale ?? params.intensity);
        if (!Number.isFinite(s) || s < 1.0 || s > 3.0) {
          throw new Error("visual.punch_in requires 'scale' between 1.0 and 3.0.");
        }
        clean.scale = normalizePunchInScale(s);
      } else {
        clean.scale = SMART_ZOOM_DEFAULTS.scale;
      }
      clean.transition = normalizePunchInTransition(params.transition);
      if (params.transitionDuration !== undefined && Number.isFinite(Number(params.transitionDuration))) {
        clean.transitionDuration = Math.max(SMART_ZOOM_DEFAULTS.minTransitionDuration, Math.min(SMART_ZOOM_DEFAULTS.maxTransitionDuration, Number(Number(params.transitionDuration).toFixed(3))));
      } else {
        clean.transitionDuration = SMART_ZOOM_DEFAULTS.transitionDuration;
      }
      if (params.faceAnchored !== undefined) {
        clean.faceAnchored = Boolean(params.faceAnchored);
      }
      if (params.punchInId) {
        clean.punchInId = String(params.punchInId).trim();
      }
      if (Array.isArray(params.excludeClipIds)) {
        clean.excludeClipIds = params.excludeClipIds.map(String);
      }
      if (Number.isFinite(Number(params.x))) clean.x = Number(params.x);
      if (Number.isFinite(Number(params.y))) clean.y = Number(params.y);
      break;
    }

    case "visual.remove_punch_in": {
      const clipId = String(params.clipId || "").trim();
      clean.clipId = clipId || "all";
      if (params.punchInId) clean.punchInId = String(params.punchInId).trim();
      if (params.time !== undefined && Number.isFinite(Number(params.time))) {
        clean.time = Math.max(0, Number(Number(params.time).toFixed(3)));
      }
      if (params.timelineTime !== undefined && Number.isFinite(Number(params.timelineTime))) {
        clean.timelineTime = Math.max(0, Number(Number(params.timelineTime).toFixed(3)));
      }
      break;
    }

    case "visual.reset_zoom": {
      const clipId = String(params.clipId || "").trim();
      clean.clipId = clipId || "all";
      clean.scope = params.scope === "all" || clipId === "all" ? "all" : "clip";
      break;
    }

    case "transition.set": {
      const clipId = String(params.clipId || "").trim();
      if (!clipId) throw new Error("transition.set requires a valid clipId.");
      const transitionId = String(params.transitionId || params.transition || "fade").trim().toLowerCase();
      if (!SUPPORTED_TRANSITIONS.includes(transitionId)) {
        throw new Error(`Unsupported transition: "${transitionId}". Must be one of: ${SUPPORTED_TRANSITIONS.join(", ")}.`);
      }
      clean.clipId = clipId;
      clean.transitionId = transitionId;
      if (params.duration !== undefined) {
        const dur = Number(params.duration);
        if (Number.isFinite(dur) && dur > 0) clean.duration = Number(dur.toFixed(2));
      }
      break;
    }

    case "clip.set_speed": {
      const clipId = String(params.clipId || "").trim();
      const scope = params.scope && typeof params.scope === "string" ? params.scope.trim().toLowerCase() : (clipId === "all" ? "all" : "clip");
      if (!clipId && scope !== "all") {
        throw new Error("clip.set_speed requires a valid clipId or scope: 'all'.");
      }
      const speed = Number(params.speed);
      if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) {
        throw new Error("clip.set_speed requires 'speed' between 0.25 and 4.0.");
      }
      clean.clipId = clipId || (scope === "all" ? "all" : "");
      clean.speed = Number(speed.toFixed(2));
      clean.scope = scope;
      if (typeof params.preservePitch === "boolean") {
        clean.preservePitch = params.preservePitch;
      }
      break;
    }

    case "clip.set_filter": {
      const clipId = String(params.clipId || "").trim();
      const scope = params.scope && typeof params.scope === "string" ? params.scope.trim().toLowerCase() : (clipId === "all" ? "all" : "clip");
      const filterId = String(params.filterId || "").trim().toLowerCase();
      if (!SUPPORTED_CLIP_FILTERS.includes(filterId)) {
        throw new Error(`Unsupported filterId: "${filterId}". Must be one of: ${SUPPORTED_CLIP_FILTERS.join(", ")}.`);
      }
      clean.clipId = clipId || (scope === "all" ? "all" : "");
      clean.filterId = filterId;
      clean.scope = scope;
      break;
    }

    case "clip.set_color_grade": {
      const clipId = String(params.clipId || "").trim();
      const scope = params.scope && typeof params.scope === "string" ? params.scope.trim().toLowerCase() : (clipId === "all" ? "all" : "clip");
      const grade = params.colorGrade && typeof params.colorGrade === "object" ? params.colorGrade : (params.grade || {});
      const cleanGrade = {};
      for (const field of ["temperature", "tint", "saturation"]) {
        if (grade[field] === undefined || grade[field] === null) continue;
        const num = Number(grade[field]);
        if (!Number.isFinite(num) || num < -100 || num > 100) {
          throw new Error(`clip.set_color_grade ${field} must be a number between -100 and 100.`);
        }
        cleanGrade[field] = Math.round(num);
      }
      for (const wheel of ["shadows", "midtones", "highlights", "offset"]) {
        if (grade[wheel] === undefined || grade[wheel] === null) continue;
        if (typeof grade[wheel] !== "object" || Array.isArray(grade[wheel])) {
          throw new Error(`clip.set_color_grade ${wheel} must be a color-wheel object.`);
        }
        const cleanWheel = {};
        for (const component of ["hue", "saturation", "luminance"]) {
          if (grade[wheel][component] === undefined || grade[wheel][component] === null) continue;
          const num = Number(grade[wheel][component]);
          const minimum = component === "hue" ? 0 : component === "saturation" ? 0 : -100;
          const maximum = component === "hue" ? 360 : 100;
          if (!Number.isFinite(num) || num < minimum || num > maximum) {
            throw new Error(`clip.set_color_grade ${wheel}.${component} must be a number between ${minimum} and ${maximum}.`);
          }
          cleanWheel[component] = Math.round(num);
        }
        cleanGrade[wheel] = cleanWheel;
      }
      clean.clipId = clipId || (scope === "all" ? "all" : "");
      clean.colorGrade = cleanGrade;
      clean.scope = scope;
      break;
    }

    case "clip.delete": {
      const clipId = String(params.clipId || "").trim();
      if (!clipId) throw new Error("clip.delete requires a valid clipId.");
      const track = String(params.track || "visuals").trim().toLowerCase();
      clean.clipId = clipId;
      clean.track = track;
      break;
    }

    case "timed.move": {
      const clipId = String(params.clipId || "").trim();
      if (!clipId) throw new Error("timed.move requires a valid clipId.");
      const start = Number(params.start);
      if (!Number.isFinite(start) || start < 0) {
        throw new Error("timed.move requires non-negative 'start' timestamp.");
      }
      clean.clipId = clipId;
      clean.start = Number(start.toFixed(3));
      clean.track = String(params.track || "audio").trim().toLowerCase();
      break;
    }

    case "timed.resize": {
      const clipId = String(params.clipId || "").trim();
      if (!clipId) throw new Error("timed.resize requires a valid clipId.");
      const duration = Number(params.duration);
      if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error("timed.resize requires positive 'duration'.");
      }
      clean.clipId = clipId;
      clean.duration = Number(duration.toFixed(3));
      clean.track = String(params.track || "audio").trim().toLowerCase();
      break;
    }

    case "track.set_locked": {
      const track = String(params.track || "").trim().toLowerCase();
      if (!track) throw new Error("track.set_locked requires 'track' name.");
      if (typeof params.locked !== "boolean") {
        throw new Error("track.set_locked requires boolean 'locked'.");
      }
      clean.track = track;
      clean.locked = params.locked;
      break;
    }

    case "track.set_visibility": {
      const track = String(params.track || "").trim().toLowerCase();
      if (!track) throw new Error("track.set_visibility requires 'track' name.");
      if (typeof params.visible !== "boolean") {
        throw new Error("track.set_visibility requires boolean 'visible'.");
      }
      clean.track = track;
      clean.visible = params.visible;
      break;
    }

    case "overlay.set_transform": {
      const clipId = String(params.clipId || "").trim();
      if (!clipId) throw new Error("overlay.set_transform requires a valid clipId.");
      clean.clipId = clipId;
      clean.transform = {};
      if (params.transform && typeof params.transform === "object") {
        for (const [k, v] of Object.entries(params.transform)) {
          if (typeof v === "number" && Number.isFinite(v)) clean.transform[k] = v;
        }
      }
      break;
    }

    case "audio.delete": {
      clean.clipId = params.clipId && typeof params.clipId === "string" ? params.clipId.trim() : "";
      break;
    }

    case "music.delete": {
      clean.clipId = params.clipId && typeof params.clipId === "string" ? params.clipId.trim() : "";
      break;
    }

    case "music.duck": {
      const clipId = String(params.clipId || "").trim();
      if (!clipId) throw new Error("music.duck requires a valid 'clipId'.");
      clean.clipId = clipId;
      clean.duckVolume = Number.isFinite(Number(params.duckVolume)) ? Math.max(0, Math.min(1, Number(params.duckVolume))) : 0.18;
      clean.normalVolume = Number.isFinite(Number(params.normalVolume)) ? Math.max(0, Math.min(4, Number(params.normalVolume))) : 0.8;
      break;
    }

    case "clip.set_muted": {
      clean.clipId = params.clipId && typeof params.clipId === "string" ? params.clipId.trim() : "";
      if (typeof params.muted !== "boolean") {
        throw new Error("clip.set_muted requires a boolean 'muted' property.");
      }
      clean.muted = params.muted;
      break;
    }

    case "clip.set_property": {
      const scope = params.scope && typeof params.scope === "string" ? params.scope.trim().toLowerCase() : (params.clipId === "all" ? "all" : undefined);
      if (scope) clean.scope = scope;
      clean.clipId = params.clipId && typeof params.clipId === "string" ? params.clipId.trim() : (scope === "all" ? "all" : "");
      const property = String(params.property || "").trim();
      if (!property) throw new Error("clip.set_property requires 'property' name.");
      if (!SUPPORTED_NUMERIC_CLIP_PROPERTIES.includes(property)) {
        throw new Error(`Unsupported clip property: "${property}". Supported: ${SUPPORTED_NUMERIC_CLIP_PROPERTIES.join(", ")}.`);
      }
      let value = Number(params.value);
      if (!Number.isFinite(value)) throw new Error("clip.set_property requires a numeric 'value'.");
      if (property === "volume" && value > 4 && value <= 400) {
        value = Number((value / 100).toFixed(3));
      }
      clean.property = property;
      clean.value = value;
      if (params.targetTrack) clean.targetTrack = String(params.targetTrack);
      if (params.track) clean.track = String(params.track);
      break;
    }

    case "tool.scene_detection": {
      clean.clipId = params.clipId && typeof params.clipId === "string" ? params.clipId.trim() : "";
      break;
    }

    case "tool.silence_removal": {
      clean.clipId = params.clipId && typeof params.clipId === "string" ? params.clipId.trim() : "";
      break;
    }

    case "tool.rough_cut": {
      clean.clipId = params.clipId && typeof params.clipId === "string" ? params.clipId.trim() : "";
      clean.removeFillerWords = typeof params.removeFillerWords === "boolean" ? params.removeFillerWords : false;
      break;
    }

    case "tool.smart_pipeline": {
      clean.clipId = params.clipId && typeof params.clipId === "string" ? params.clipId.trim() : "";
      break;
    }

    case "tool.generate_captions": {
      break;
    }

    case "tool.smart_frame": {
      clean.enabled = typeof params.enabled === "boolean" ? params.enabled : true;
      break;
    }

    case "tool.export": {
      break;
    }

    case "visual.reorder": {
      const clipId = String(params.clipId || "").trim();
      if (!clipId) throw new Error("visual.reorder requires a valid clipId.");
      const toIndex = Number.parseInt(params.toIndex, 10);
      if (Number.isNaN(toIndex) || toIndex < 0) {
        throw new Error("visual.reorder toIndex must be a non-negative integer.");
      }
      clean.clipId = clipId;
      clean.toIndex = toIndex;
      break;
    }

    case "caption.add": {
      const text = String(params.text || "").trim();
      if (!text || text.length > 500) {
        throw new Error("caption.add text must be between 1 and 500 characters.");
      }
      const start = Number(params.start);
      const end = Number(params.end);
      if (!Number.isFinite(start) || start < 0) {
        throw new Error("caption.add start must be a non-negative finite number.");
      }
      if (!Number.isFinite(end) || end <= start) {
        throw new Error("caption.add end must be greater than start.");
      }
      const clipId = params.clipId || params.captionId;
      clean.captionId = clipId && typeof clipId === "string" && clipId.trim()
        ? clipId.trim()
        : `cap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      clean.clipId = clean.captionId;
      clean.text = text;
      clean.start = Number(start.toFixed(3));
      clean.end = Number(end.toFixed(3));
      break;
    }

    case "caption.update": {
      const clipId = String(params.clipId || params.captionId || "").trim();
      if (!clipId) throw new Error("caption.update requires a valid clipId.");
      clean.clipId = clipId;
      clean.captionId = clipId;
      if (params.text !== undefined) {
        const text = String(params.text || "").trim();
        if (!text || text.length > 500) {
          throw new Error("caption.update text must be between 1 and 500 characters.");
        }
        clean.text = text;
      }
      if (params.start !== undefined) {
        const start = Number(params.start);
        if (!Number.isFinite(start) || start < 0) {
          throw new Error("caption.update start must be non-negative.");
        }
        clean.start = Number(start.toFixed(3));
      }
      if (params.end !== undefined) {
        const end = Number(params.end);
        if (!Number.isFinite(end) || end < 0) {
          throw new Error("caption.update end must be non-negative.");
        }
        clean.end = Number(end.toFixed(3));
      }
      break;
    }

    case "caption.delete": {
      const clipId = String(params.clipId || params.captionId || "").trim();
      if (!clipId) throw new Error("caption.delete requires a valid clipId.");
      clean.clipId = clipId;
      clean.captionId = clipId;
      break;
    }

    case "caption.set_style": {
      clean.scope = params.scope && ["default", "current"].includes(params.scope)
        ? params.scope
        : params.clipId ? "current" : "default";
      if (params.clipId && clean.scope === "current") {
        clean.clipId = String(params.clipId).trim();
      }
      const rawStyle = params.style && typeof params.style === "object" ? params.style : params;
      const style = {};
      if (rawStyle.captionSize !== undefined) {
        const size = Number.parseInt(rawStyle.captionSize, 10);
        if (Number.isNaN(size) || size < 12 || size > 42) {
          throw new Error("captionSize must be an integer between 12 and 42.");
        }
        style.captionSize = size;
        clean.captionSize = size;
      }
      if (rawStyle.textColor !== undefined) {
        const col = String(rawStyle.textColor).trim();
        if (!HEX_COLOR_REGEX.test(col)) throw new Error("textColor must be a valid hex color (#RRGGBB).");
        style.textColor = col;
        clean.textColor = col;
      }
      if (rawStyle.backgroundColor !== undefined) {
        const col = String(rawStyle.backgroundColor).trim();
        if (!HEX_COLOR_REGEX.test(col)) throw new Error("backgroundColor must be a valid hex color (#RRGGBB).");
        style.backgroundColor = col;
        clean.backgroundColor = col;
      }
      if (rawStyle.backgroundOpacity !== undefined) {
        if (
          typeof rawStyle.backgroundOpacity !== "number" ||
          !Number.isFinite(rawStyle.backgroundOpacity) ||
          rawStyle.backgroundOpacity < 0 ||
          rawStyle.backgroundOpacity > 1
        ) {
          throw new Error("backgroundOpacity must be a finite number between 0 and 1.");
        }
        style.backgroundOpacity = rawStyle.backgroundOpacity;
        clean.backgroundOpacity = rawStyle.backgroundOpacity;
      }
      if (rawStyle.effect !== undefined) {
        const effect = String(rawStyle.effect).trim().toLowerCase();
        if (!["normal", "neon"].includes(effect)) throw new Error("effect must be 'normal' or 'neon'.");
        style.effect = effect;
        clean.effect = effect;
      }
      if (rawStyle.fontId !== undefined) {
        const rawFont = String(rawStyle.fontId).trim();
        if (!rawFont) throw new Error("fontId must be a non-empty string.");
        const matched = findCaptionFontInCatalog(rawFont);
        if (!matched) {
          throw new Error(`Unsupported font: "${rawFont}".`);
        }
        style.fontId = matched.id;
        clean.fontId = matched.id;
      }
      if (rawStyle.karaoke !== undefined) {
        const karaoke = typeof rawStyle.karaoke === "boolean" ? rawStyle.karaoke : String(rawStyle.karaoke).toLowerCase() === "true";
        style.karaoke = karaoke;
        clean.karaoke = karaoke;
      }
      if (rawStyle.activeWordColor !== undefined) {
        const col = String(rawStyle.activeWordColor).trim();
        const hex = resolveColorToHex(col);
        if (!hex) throw new Error("activeWordColor must be a valid hex color (#RRGGBB).");
        style.activeWordColor = hex;
        clean.activeWordColor = hex;
      }
      if (rawStyle.borderColor !== undefined) {
        const col = String(rawStyle.borderColor).trim();
        if (!HEX_COLOR_REGEX.test(col)) throw new Error("borderColor must be a valid hex color (#RRGGBB).");
        style.borderColor = col;
        clean.borderColor = col;
      }
      if (rawStyle.textStrokeColor !== undefined) {
        const col = String(rawStyle.textStrokeColor).trim();
        if (!HEX_COLOR_REGEX.test(col)) throw new Error("textStrokeColor must be a valid hex color (#RRGGBB).");
        style.textStrokeColor = col;
        clean.textStrokeColor = col;
      }
      if (rawStyle.borderWidth !== undefined && Number.isFinite(Number(rawStyle.borderWidth))) {
        style.borderWidth = Math.max(0, Math.min(8, Number(rawStyle.borderWidth)));
        clean.borderWidth = style.borderWidth;
      }
      if (rawStyle.textStrokeWidth !== undefined && Number.isFinite(Number(rawStyle.textStrokeWidth))) {
        style.textStrokeWidth = Math.max(0, Math.min(6, Number(rawStyle.textStrokeWidth)));
        clean.textStrokeWidth = style.textStrokeWidth;
      }
      if (rawStyle.radius !== undefined && Number.isFinite(Number(rawStyle.radius))) {
        style.radius = Math.max(0, Math.min(28, Number(rawStyle.radius)));
        clean.radius = style.radius;
      }
      if (rawStyle.paddingX !== undefined && Number.isFinite(Number(rawStyle.paddingX))) {
        style.paddingX = Math.max(0, Math.min(52, Number(rawStyle.paddingX)));
        clean.paddingX = style.paddingX;
      }
      if (rawStyle.paddingY !== undefined && Number.isFinite(Number(rawStyle.paddingY))) {
        style.paddingY = Math.max(0, Math.min(32, Number(rawStyle.paddingY)));
        clean.paddingY = style.paddingY;
      }
      if (rawStyle.shadowOpacity !== undefined && Number.isFinite(Number(rawStyle.shadowOpacity))) {
        style.shadowOpacity = Math.max(0, Math.min(1, Number(rawStyle.shadowOpacity)));
        clean.shadowOpacity = style.shadowOpacity;
      }
      if (!Object.keys(style).length) {
        throw new Error("caption.set_style requires at least one valid style property.");
      }
      clean.style = style;
      break;
    }

    case "caption.set_position": {
      const pos = String(params.position || "").trim().toLowerCase();
      if (!SUPPORTED_CAPTION_POSITIONS.includes(pos)) {
        throw new Error(`Unsupported caption position: "${pos}". Must be: ${SUPPORTED_CAPTION_POSITIONS.join(", ")}.`);
      }
      clean.scope = params.scope && ["default", "current"].includes(params.scope)
        ? params.scope
        : params.clipId ? "current" : "default";
      if (params.clipId && clean.scope === "current") {
        clean.clipId = String(params.clipId).trim();
      }
      clean.position = pos;
      const placementMap = {
        top: { x: 50, y: 18 },
        middle: { x: 50, y: 50 },
        bottom: { x: 50, y: 78 },
      };
      clean.placement = params.placement && typeof params.placement === "object" ? params.placement : placementMap[pos];
      break;
    }

    case "marker.add": {
      const time = Number(params.time);
      if (!Number.isFinite(time) || time < 0) {
        throw new Error("marker.add time must be a non-negative finite number.");
      }
      const title = String(params.title || "").trim();
      if (!title || title.length > 120) {
        throw new Error("marker.add title must be between 1 and 120 characters.");
      }
      clean.markerId = params.markerId && typeof params.markerId === "string" && params.markerId.trim()
        ? params.markerId.trim()
        : `marker-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      clean.time = Number(time.toFixed(3));
      clean.title = title;
      if (params.color) {
        const color = String(params.color).trim().toLowerCase();
        if (SUPPORTED_MARKER_COLORS.includes(color)) clean.color = color;
      }
      break;
    }

    case "marker.update": {
      const markerId = String(params.markerId || "").trim();
      if (!markerId) throw new Error("marker.update requires markerId.");
      clean.markerId = markerId;
      if (params.title !== undefined) {
        const title = String(params.title || "").trim();
        if (!title || title.length > 120) throw new Error("marker.update title must be 1-120 characters.");
        clean.title = title;
      }
      if (params.color !== undefined) {
        const color = String(params.color).trim().toLowerCase();
        if (SUPPORTED_MARKER_COLORS.includes(color)) clean.color = color;
      }
      break;
    }

    case "marker.delete": {
      const markerId = String(params.markerId || "").trim();
      if (!markerId) throw new Error("marker.delete requires markerId.");
      clean.markerId = markerId;
      break;
    }

    default:
      throw new Error(`Unsupported action type: "${type}".`);
  }

  return clean;
}

/**
 * Validates and normalizes an entire editing plan object.
 *
 * @param {any} rawPlan
 * @returns {Object} Normalized plan
 * @throws {Error} if validation fails
 */
export function validateAndNormalizePlan(rawPlan) {
  if (!rawPlan || typeof rawPlan !== "object" || Array.isArray(rawPlan)) {
    throw new Error("Plan payload must be a non-null object.");
  }

  const schemaVersion = Number(rawPlan.schemaVersion) || PLAN_SCHEMA_VERSION;
  if (schemaVersion !== PLAN_SCHEMA_VERSION) {
    throw new Error(`Unsupported plan schemaVersion: ${schemaVersion}. Expected ${PLAN_SCHEMA_VERSION}.`);
  }

  const explanation = typeof rawPlan.explanation === "string"
    ? rawPlan.explanation.trim().slice(0, 1000)
    : "Proposed editing plan";

  if (!Array.isArray(rawPlan.actions)) {
    throw new Error("Plan 'actions' must be an array.");
  }

  if (rawPlan.actions.length > MAX_ACTIONS_LIMIT) {
    throw new Error(`Plan action count (${rawPlan.actions.length}) exceeds maximum limit (${MAX_ACTIONS_LIMIT}).`);
  }

  const actions = [];
  const seenActionIds = new Set();

  for (let i = 0; i < rawPlan.actions.length; i++) {
    const rawAction = rawPlan.actions[i];
    if (!rawAction || typeof rawAction !== "object") {
      throw new Error(`Action at index ${i} is not a valid object.`);
    }

    const type = String(rawAction.type || "").trim();
    if (!SUPPORTED_ACTION_TYPES.includes(type)) {
      throw new Error(`Action at index ${i} has unsupported type: "${type}".`);
    }

    let id = typeof rawAction.id === "string" && rawAction.id.trim()
      ? rawAction.id.trim().slice(0, 64)
      : `act-${i + 1}`;

    if (seenActionIds.has(id)) {
      id = `${id}-${i + 1}`;
    }
    seenActionIds.add(id);

    const description = typeof rawAction.description === "string"
      ? rawAction.description.trim().slice(0, 300)
      : `Action: ${type}`;

    const params = validateActionParams(type, rawAction.params);

    actions.push({
      id,
      type,
      description,
      params,
    });
  }

  const roughCutAction = actions.find((action) => action.type === "tool.rough_cut");
  const silenceActionIndex = actions.findIndex((action) => action.type === "tool.silence_removal");
  if (roughCutAction && silenceActionIndex >= 0) {
    roughCutAction.params.removeFillerWords = true;
    if (!roughCutAction.params.clipId) roughCutAction.params.clipId = actions[silenceActionIndex].params.clipId;
    actions.splice(silenceActionIndex, 1);
  }

  const prerequisites = Array.isArray(rawPlan.prerequisites)
    ? rawPlan.prerequisites.map((p) => String(p).trim()).filter(Boolean).slice(0, 10)
    : [];

  const warnings = Array.isArray(rawPlan.warnings)
    ? rawPlan.warnings.map((w) => String(w).trim()).filter(Boolean).slice(0, 10)
    : [];

  const assumptions = Array.isArray(rawPlan.assumptions)
    ? rawPlan.assumptions.map((a) => String(a).trim()).filter(Boolean).slice(0, 10)
    : [];

  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    explanation,
    actions,
    prerequisites,
    warnings,
    assumptions,
  };
}
