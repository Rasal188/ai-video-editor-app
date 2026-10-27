import { MAX_TIMELINE_MARKER_SECONDS, TIMELINE_MARKER_COLORS, TIMELINE_MARKER_TYPES, normalizeTimelineMarkers } from "./timelineMarkers.js";
import { getCaptionTimeline, getTimedSegmentsEnd, hasExplicitCaptionTiming } from "./timeline.js";
import { CAPTION_FONT_CATALOG, findCaptionFontInCatalog } from "./captionFonts.js";
import { resolveColorToHex } from "./captionStyles.js";
import { normalizeColorGrade } from "./colorGrade.js";
import {
  compilePunchInKeyframes,
  detectSpeechPunchInMoments,
  normalizePunchIn,
  normalizePunchInScale,
  normalizePunchInTransition,
  resolvePunchInOffset,
  SMART_ZOOM_DEFAULTS,
} from "./smartZoom.js";


export const PROJECT_COMMAND_SCHEMA_VERSION = 1;

const COMMAND_STATE_KEY = "commandState";
const MIN_TIMED_CAPTION_SECONDS = 0.2;

export const CAPTION_STYLE_PROPERTY_SCHEMA = Object.freeze({
  fontId: { type: "string", enum: CAPTION_FONT_CATALOG.map((font) => font.id) },
  captionSize: { type: "number", minimum: 12, maximum: 42 },
  ...Object.fromEntries(["textColor", "backgroundColor", "borderColor", "textStrokeColor", "activeWordColor"].map((key) => [key, { type: "string", pattern: "^#[0-9a-fA-F]{6}$" }])),
  ...Object.fromEntries(Object.entries({ backgroundOpacity: 1, shadowOpacity: 1, textStrokeWidth: 6, borderWidth: 8, radius: 28, paddingX: 52, paddingY: 32 })
    .map(([key, maximum]) => [key, { type: "number", minimum: 0, maximum }])),
  effect: { type: "string", enum: ["normal", "neon"] },
  karaoke: { type: "boolean" },
});

const TIMED_COLLECTIONS = Object.freeze({ audio: "audioSegments", music: "musicSegments", overlay: "visualOverlaySegments", overlays: "visualOverlaySegments", sticker: "stickerSegments", stickers: "stickerSegments" });

function invalidArgument(message) {
  throw Object.assign(new Error(message), { code: "INVALID_ARGUMENT" });
}

function timedClip(project, operation) {
  const key = TIMED_COLLECTIONS[operation.track];
  if (!key) throw Object.assign(new Error(`Unsupported timed track: ${operation.track}`), { code: "UNSUPPORTED_TRACK" });
  return findById(project[key], operation.clipId, "Timed clip");
}

function shiftCaptionWords(words, delta, start, end) {
  return words.flatMap((word) => {
    if (!word || typeof word !== "object" || !Number.isFinite(word.start) || !Number.isFinite(word.end) || word.end <= word.start) return [];
    const wordStart = Math.max(start, word.start + delta);
    const wordEnd = Math.min(end, word.end + delta);
    return wordEnd > wordStart ? [{ ...word, start: wordStart, end: wordEnd }] : [];
  });
}

function updateLinkedCaptionTiming(project, audioId, delta, end, lowerBound) {
  project.captionSegments = (project.captionSegments || []).map((caption) => {
    if (caption.audioSegmentId !== audioId) return caption;
    const shiftedStart = (Number(caption.start) || 0) + delta;
    const start = finiteNonNegative(lowerBound === undefined ? shiftedStart : Math.max(lowerBound, shiftedStart), "caption start");
    const captionEnd = Math.min(end ?? Infinity, finiteNonNegative(Math.max(0, (Number(caption.end) || 0) + delta), "caption end"));
    requireCaptionRange(start, captionEnd);
    return { ...caption, start, end: captionEnd,
      ...(Array.isArray(caption.words) ? { words: shiftCaptionWords(caption.words, delta, start, captionEnd) } : {}),
    };
  });
}

function failure(code, message, operationId = "") {
  return { ok: false, code, message, ...(operationId ? { operationId } : {}) };
}

function finiteNonNegative(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw Object.assign(new Error(`${name} must be a finite non-negative number`), { code: "INVALID_ARGUMENT" });
  }
  return value;
}

function finitePositive(value, name) {
  const result = finiteNonNegative(value, name);
  if (result <= 0) throw Object.assign(new Error(`${name} must be greater than zero`), { code: "INVALID_ARGUMENT" });
  return result;
}

function requireCaptionRange(start, end) {
  finiteNonNegative(start, "caption start");
  finiteNonNegative(end, "caption end");
  const tolerance = Number.EPSILON * Math.max(1, start, end) * 4;
  if (end - start < MIN_TIMED_CAPTION_SECONDS - tolerance) {
    throw Object.assign(new Error("Captions must last at least 0.2 seconds"), { code: "INVALID_RANGE" });
  }
}

function resolveProjectCaptions(project) {
  const captions = Array.isArray(project?.captionSegments) ? project.captionSegments : [];
  const voiceDuration = getTimedSegmentsEnd(project?.audioSegments || []);
  const visualDuration = (project?.visualSegments || []).reduce((sum, clip) => sum + (Number(clip.duration) || 0), 0);
  const targetDuration = voiceDuration > 0 ? voiceDuration : (visualDuration > 0 ? visualDuration : (Number(project?.duration) || 0));
  const timeline = getCaptionTimeline(captions, targetDuration);
  return captions.map((caption, index) => ({ ...caption, start: timeline[index]?.start ?? 0, end: timeline[index]?.end ?? 0 }));
}

// Caption timing can be implicit in a saved project. Match the editor's
// voice-track clock before editing so inserting an explicit caption or adding
// voice media cannot rescale the existing subtitles behind the review. Reads
// use the same resolver without the editable-duration constraint.
export function materializeProjectCaptionTimings(project) {
  const captions = resolveProjectCaptions(project);
  for (const caption of captions) requireCaptionRange(caption.start, caption.end);
  return { ...project, captionSegments: captions };
}

function findById(items, id, kind) {
  const item = (Array.isArray(items) ? items : []).find((entry) => entry.id === id);
  if (!item) throw Object.assign(new Error(`${kind} not found: ${id}`), { code: "CLIP_NOT_FOUND" });
  return item;
}

function commandState(project) {
  const value = project?.[COMMAND_STATE_KEY];
  return {
    schemaVersion: PROJECT_COMMAND_SCHEMA_VERSION,
    revision: Number.isInteger(value?.revision) && value.revision >= 0 ? value.revision : 0,
    appliedOperationIds: Array.isArray(value?.appliedOperationIds) ? [...new Set(value.appliedOperationIds)] : [],
  };
}

function moveTimed(project, operation) {
  if (operation.track === "audio") project.captionSegments = materializeProjectCaptionTimings(project).captionSegments;
  const segment = timedClip(project, operation);
  const nextStart = finiteNonNegative(operation.start, "start");
  const previousStart = Number(segment.start) || 0;
  segment.start = nextStart;
  const delta = nextStart - previousStart;
  if (operation.layer !== undefined) {
    if (!["audio", "overlay", "overlays"].includes(operation.track) || !Number.isInteger(operation.layer) || operation.layer < 1 || operation.layer > 1000) invalidArgument("layer must identify an audio lane or overlay layer from 1 to 1000");
    segment[operation.track === "audio" ? "lane" : "layer"] = operation.track === "audio" ? operation.layer - 1 : operation.layer;
  }
  if (operation.track === "audio") {
    updateLinkedCaptionTiming(project, segment.id, delta);
    project.audioDuration = getTimedSegmentsEnd(project.audioSegments);
  }
}

function resizeTimed(project, operation) {
  if (operation.track === "audio") project.captionSegments = materializeProjectCaptionTimings(project).captionSegments;
  const segment = timedClip(project, operation);
  const previousStart = Number(segment.start) || 0;
  const start = Object.hasOwn(operation, "start") ? finiteNonNegative(operation.start, "start") : previousStart;
  const duration = finitePositive(operation.duration, "duration");
  const sourceBacked = ["audio", "music"].includes(operation.track) || segment.type === "video";
  if (sourceBacked) {
    if (segment.speedCurve?.enabled || segment.reversed || segment.reverse) throw Object.assign(new Error("Complex source timing cannot be resized"), { code: "UNSUPPORTED_TIMING" });
    const rate = visualPlaybackRate(segment);
    const retainedSourceDuration = Number(segment.sourceDuration) || Number(segment.duration) * rate;
    if (duration * rate > retainedSourceDuration + 0.000001) throw Object.assign(new Error("Resize exceeds the retained source range"), { code: "SOURCE_RANGE_EXCEEDED" });
    segment.sourceDuration = duration * rate;
  }
  segment.start = start;
  segment.duration = duration;
  if (Number.isFinite(segment.fadeIn)) segment.fadeIn = Math.min(segment.fadeIn, duration);
  if (Number.isFinite(segment.fadeOut)) segment.fadeOut = Math.min(segment.fadeOut, duration);
  if (Array.isArray(segment.keyframes)) segment.keyframes = remapKeyframes(segment.keyframes, 0, duration);
  if (segment.propertyKeyframes) segment.propertyKeyframes = Object.fromEntries(Object.entries(segment.propertyKeyframes).map(([key, frames]) => [key, remapKeyframes(frames, 0, duration)]));
  if (operation.track === "audio") {
    const delta = start - previousStart;
    updateLinkedCaptionTiming(project, segment.id, delta, start + duration);
    project.audioDuration = getTimedSegmentsEnd(project.audioSegments);
  }
}

function visualPlaybackRate(segment) {
  const value = Number(segment?.playbackRate) || 1;
  return Math.max(0.25, Math.min(4, value));
}

function remapKeyframes(keyframes, start, end) {
  return (Array.isArray(keyframes) ? keyframes : [])
    .filter((frame) => Number(frame?.time) >= start && Number(frame?.time) <= end)
    .map((frame) => ({ ...frame, time: Number(frame.time) - start }));
}

// Older projects identify source audio by asset ID. Resolve that implicit
// relationship before changing the sequence, so deleting the last explicitly
// mapped piece can never attach previously unmapped sibling clips.
function materializeSourceAudioMappings(project) {
  const visuals = project.visualSegments || [];
  const hasMapped = visuals.some((clip) => clip.type === "video" && Number.isFinite(clip.sourceAudioOffset));
  const candidates = [...new Set(visuals.filter((clip) => clip.type === "video" && clip.assetId).map((clip) => clip.assetId))];
  const legacyAssetId = project.sourceAudioAssetId || (candidates.length === 1 ? candidates[0] : "");
  if (!hasMapped && !(legacyAssetId && Number(project.sourceAudioDuration) > 0)) return;
  project.visualSegments = visuals.map((clip) => {
    if (clip.type !== "video" || clip.sourceAudioUnmapped || Number.isFinite(clip.sourceAudioOffset)) return clip;
    return !hasMapped && clip.assetId === legacyAssetId
      ? { ...clip, sourceAudioOffset: 0 }
      : { ...clip, sourceAudioUnmapped: true };
  });
}

function trimVisual(project, operation) {
  materializeSourceAudioMappings(project);
  const segment = findById(project.visualSegments, operation.clipId, "Visual clip");
  if (segment.type !== "video") {
    if (segment.type === "image") {
      const sourceIn = Object.hasOwn(operation, "sourceIn") ? finiteNonNegative(operation.sourceIn, "sourceIn") : 0;
      const sourceOut = Object.hasOwn(operation, "sourceOut")
        ? finiteNonNegative(operation.sourceOut, "sourceOut")
        : (Object.hasOwn(operation, "duration") ? finitePositive(operation.duration, "duration") + sourceIn : 0);
      if (sourceOut <= sourceIn) throw Object.assign(new Error("sourceOut must be after sourceIn"), { code: "INVALID_RANGE" });
      const duration = sourceOut - sourceIn;
      segment.duration = duration;
      if (Array.isArray(segment.keyframes)) segment.keyframes = remapKeyframes(segment.keyframes, sourceIn, sourceOut);
      return { removedLocalTime: sourceIn, duration };
    }
    throw Object.assign(new Error("visual.trim currently supports video and image clips only"), { code: "UNSUPPORTED_MEDIA_TYPE" });
  }
  trimSourceRange(segment, operation);
}

function trimSourceRange(segment, operation) {
  const sourceIn = Object.hasOwn(operation, "sourceIn") ? finiteNonNegative(operation.sourceIn, "sourceIn") : 0;
  const sourceOut = Object.hasOwn(operation, "sourceOut")
    ? finiteNonNegative(operation.sourceOut, "sourceOut")
    : (Object.hasOwn(operation, "duration") ? finitePositive(operation.duration, "duration") + sourceIn : 0);
  if (sourceOut <= sourceIn) throw Object.assign(new Error("sourceOut must be after sourceIn"), { code: "INVALID_RANGE" });
  const previousSourceIn = Math.max(0, Number(segment.sourceStart) || 0);
  const previousSourceDuration = Math.max(0, Number(segment.sourceDuration) || (Number(segment.duration) || 0) * visualPlaybackRate(segment));
  const previousSourceOut = previousSourceIn + previousSourceDuration;
  if (sourceIn < previousSourceIn || sourceOut > previousSourceOut) {
    throw Object.assign(new Error(`Trim range must stay within ${previousSourceIn}-${previousSourceOut}`), { code: "SOURCE_RANGE_EXCEEDED" });
  }
  const rate = visualPlaybackRate(segment);
  const removedLocalTime = (sourceIn - previousSourceIn) / rate;
  const duration = (sourceOut - sourceIn) / rate;
  segment.sourceStart = sourceIn;
  segment.sourceDuration = sourceOut - sourceIn;
  segment.duration = duration;
  if (Array.isArray(segment.keyframes)) segment.keyframes = remapKeyframes(segment.keyframes, removedLocalTime, removedLocalTime + duration);
  if (segment.propertyKeyframes) segment.propertyKeyframes = Object.fromEntries(Object.entries(segment.propertyKeyframes)
    .map(([key, frames]) => [key, remapKeyframes(frames, removedLocalTime, removedLocalTime + duration)]));
  if (Number.isFinite(segment.fadeIn)) segment.fadeIn = Math.min(segment.fadeIn, duration);
  if (Number.isFinite(segment.fadeOut)) segment.fadeOut = Math.min(segment.fadeOut, duration);
  return { removedLocalTime, duration };
}

function trimTimed(project, operation) {
  if (operation.track === "audio") project.captionSegments = materializeProjectCaptionTimings(project).captionSegments;
  const segment = timedClip(project, operation);
  if (!["audio", "music", "overlay", "overlays"].includes(operation.track)
    || !["audio", "music"].includes(operation.track) && segment.type !== "video") {
    throw Object.assign(new Error("Source trimming requires audio or video media"), { code: "UNSUPPORTED_MEDIA_TYPE" });
  }
  if (segment.speedCurve?.enabled || segment.reversed || segment.reverse) throw Object.assign(new Error("Complex source timing cannot be trimmed"), { code: "UNSUPPORTED_TIMING" });
  const { removedLocalTime, duration } = trimSourceRange(segment, operation);
  if (operation.track === "audio") {
    const start = Number(segment.start) || 0;
    updateLinkedCaptionTiming(project, segment.id, -removedLocalTime, start + duration, start);
    project.audioDuration = getTimedSegmentsEnd(project.audioSegments);
  }
}

function splitVisual(project, operation) {
  materializeSourceAudioMappings(project);
  const visuals = Array.isArray(project.visualSegments) ? project.visualSegments : [];
  const index = visuals.findIndex((segment) => segment.id === operation.clipId);
  if (index < 0) throw Object.assign(new Error(`Visual clip not found: ${operation.clipId}`), { code: "CLIP_NOT_FOUND" });
  const segment = visuals[index];
  const at = finitePositive(operation.at, "at");
  const duration = finitePositive(Number(segment.duration), "clip duration");

  let targetSegment = segment;
  let targetIndex = index;
  let localAt = at;

  if (at >= duration) {
    // If the target clip was already split in a prior operation within the plan,
    // the split timestamp (relative to the original clip's start) falls into one of
    // the subsequent contiguous continuation segments sharing the same archiveMediaId.
    const archiveMediaId = segment.archiveMediaId || segment.id;
    let cumulative = duration;
    let found = false;
    for (let i = index + 1; i < visuals.length; i++) {
      const nextSeg = visuals[i];
      const nextArchiveId = nextSeg.archiveMediaId || nextSeg.id;
      if (nextArchiveId !== archiveMediaId) break;
      const nextDur = Number(nextSeg.duration) || 0;
      if (at < cumulative + nextDur - 0.000001) {
        targetSegment = nextSeg;
        targetIndex = i;
        localAt = Number((at - cumulative).toFixed(6));
        found = true;
        break;
      }
      cumulative += nextDur;
    }
    if (!found) {
      throw Object.assign(new Error("at must be inside the visual clip"), { code: "INVALID_RANGE" });
    }
  }

  const targetDuration = Number(targetSegment.duration);
  if (localAt <= 0.0001 || localAt >= targetDuration - 0.0001) {
    throw Object.assign(new Error("at must be inside the visual clip"), { code: "INVALID_RANGE" });
  }

  const rightClipId = (typeof operation.rightClipId === "string" && operation.rightClipId.trim())
    ? operation.rightClipId.trim()
    : `${operation.clipId}-split-${Date.now()}`;
  requireNewClipId(project, rightClipId);
  const rate = targetSegment.type === "video" ? visualPlaybackRate(targetSegment) : 1;
  const archiveMediaId = targetSegment.archiveMediaId || targetSegment.id;
  const left = { ...targetSegment, archiveMediaId, duration: localAt };
  const right = { ...targetSegment, id: rightClipId, archiveMediaId, duration: Number((targetDuration - localAt).toFixed(6)) };
  if (targetSegment.type === "video") {
    left.sourceDuration = localAt * rate;
    right.sourceStart = Math.max(0, Number(targetSegment.sourceStart) || 0) + localAt * rate;
    right.sourceDuration = (targetDuration - localAt) * rate;
  }
  if (Array.isArray(targetSegment.keyframes)) {
    left.keyframes = remapKeyframes(targetSegment.keyframes, 0, localAt);
    right.keyframes = remapKeyframes(targetSegment.keyframes, localAt, targetDuration);
  }
  project.visualSegments = [...visuals.slice(0, targetIndex), left, right, ...visuals.slice(targetIndex + 1)];
}

function reorderVisual(project, operation) {
  const visuals = Array.isArray(project.visualSegments) ? project.visualSegments : [];
  const from = visuals.findIndex((segment) => segment.id === operation.clipId);
  if (from < 0) throw Object.assign(new Error(`Visual clip not found: ${operation.clipId}`), { code: "CLIP_NOT_FOUND" });
  if (!Number.isInteger(operation.toIndex) || operation.toIndex < 0 || operation.toIndex >= visuals.length) {
    throw Object.assign(new Error("toIndex must identify an existing visual position"), { code: "INVALID_ARGUMENT" });
  }
  if (from === operation.toIndex) return;
  const next = [...visuals];
  const [moved] = next.splice(from, 1);
  next.splice(operation.toIndex, 0, moved);
  project.visualSegments = next;
}

function requireNewClipId(project, clipId) {
  const id = typeof clipId === "string" ? clipId.trim() : "";
  if (!id) throw Object.assign(new Error("clipId is required"), { code: "INVALID_ARGUMENT" });
  const exists = Object.values(TRACK_COLLECTIONS).some((key) => (project?.[key] || []).some((clip) => clip.id === id));
  if (exists) throw Object.assign(new Error(`Clip already exists: ${id}`), { code: "CLIP_ALREADY_EXISTS" });
  return id;
}

function findVisualSource(project, sourceClipId) {
  const source = [...(project.visualSegments || []), ...(project.visualOverlaySegments || [])].find((clip) => clip.id === sourceClipId);
  if (!source) throw Object.assign(new Error(`Visual source clip not found: ${sourceClipId}`), { code: "CLIP_NOT_FOUND" });
  return source;
}

function cloneVisualForSequence(project, operation) {
  const id = requireNewClipId(project, operation.clipId);
  const source = findVisualSource(project, operation.sourceClipId);
  const maximumDuration = finitePositive(Number(source.duration), "source clip duration");
  const duration = Object.hasOwn(operation, "duration") ? finitePositive(operation.duration, "duration") : maximumDuration;
  if (source.type === "video" && duration > maximumDuration) {
    throw Object.assign(new Error(`Video duration cannot exceed source clip duration ${maximumDuration}`), { code: "SOURCE_RANGE_EXCEEDED" });
  }
  const next = { ...source, id, archiveMediaId: source.archiveMediaId || source.id, duration };
  delete next.start;
  delete next.layer;
  delete next.baseTransform;
  delete next.transition;
  if (source.type === "video") next.sourceDuration = duration * visualPlaybackRate(source);
  if (Array.isArray(source.keyframes)) next.keyframes = remapKeyframes(source.keyframes, 0, duration);
  return next;
}

function appendVisual(project, operation) {
  materializeSourceAudioMappings(project);
  project.visualSegments = [...(project.visualSegments || []), cloneVisualForSequence(project, operation)];
}

function importAsset(project, operation) {
  const id = requireNewClipId(project, operation.clipId);
  if (!["visuals", "audio", "music"].includes(operation.track)) throw Object.assign(new Error("asset.import supports Visuals, Voiceover, or Music"), { code: "UNSUPPORTED_TRACK" });
  if (!operation.prepared || !["image", "video", "audio"].includes(operation.mediaType) || !operation.sha256 || !operation.archivePath) {
    throw Object.assign(new Error("asset.import must be prepared by an archive media service"), { code: "ASSET_NOT_PREPARED" });
  }
  const duration = finitePositive(operation.duration, "duration");
  const integrity = { sha256: operation.sha256, size: operation.size, mimeType: operation.mimeType, archivePath: operation.archivePath };
  if (operation.track === "audio" || operation.track === "music") {
    if (operation.mediaType !== "audio") throw Object.assign(new Error(`${operation.track} import requires audio media`), { code: "UNSUPPORTED_MEDIA_TYPE" });
    const start = Object.hasOwn(operation, "start") ? finiteNonNegative(operation.start, "start") : 0;
    const segment = { id, name: operation.name || id, start, duration, sourceStart: 0, sourceDuration: duration, playbackRate: 1, volume: operation.volume ?? (operation.track === "music" ? 0.35 : 1), fadeIn: 0, fadeOut: 0, muted: operation.muted === true, integrity };
    if (operation.track === "audio") {
      project.audioSegments = operation.replace === true ? [segment] : [...(project.audioSegments || []), segment];
      project.audioDuration = project.audioSegments.reduce((end, item) => Math.max(end, (Number(item.start) || 0) + (Number(item.duration) || 0)), 0);
    } else {
      project.musicSegments = [segment];
      project.musicName = segment.name;
      project.musicDuration = duration;
      project.musicStart = start;
      project.musicVolume = segment.volume;
    }
    return;
  }
  if (!["image", "video"].includes(operation.mediaType)) throw Object.assign(new Error("Visuals import requires image or video media"), { code: "UNSUPPORTED_MEDIA_TYPE" });
  materializeSourceAudioMappings(project);
  const segment = {
    id,
    assetId: operation.assetId || `asset-${operation.sha256.slice(0, 16)}`,
    archiveMediaId: id,
    name: operation.name || id,
    type: operation.mediaType,
    duration,
    width: Math.max(0, Number(operation.width) || 0),
    height: Math.max(0, Number(operation.height) || 0),
    sourceStart: 0,
    sourceDuration: operation.mediaType === "video" ? duration : 0,
    playbackRate: 1,
    muted: operation.muted === true,
    ...(operation.mediaType === "video" ? { sourceAudioUnmapped: true, sourceAudioDisabled: operation.muted === true } : {}),
    integrity,
  };
  project.visualSegments = [...(project.visualSegments || []), segment];
}

function insertVisual(project, operation) {
  materializeSourceAudioMappings(project);
  const visuals = Array.isArray(project.visualSegments) ? project.visualSegments : [];
  if (!Number.isInteger(operation.atIndex) || operation.atIndex < 0 || operation.atIndex > visuals.length) {
    throw Object.assign(new Error("atIndex must be a valid visual insertion position"), { code: "INVALID_ARGUMENT" });
  }
  const next = cloneVisualForSequence(project, operation);
  project.visualSegments = [...visuals.slice(0, operation.atIndex), next, ...visuals.slice(operation.atIndex)];
}

function deleteVisual(project, operation) {
  materializeSourceAudioMappings(project);
  findById(project.visualSegments, operation.clipId, "Visual clip");
  project.visualSegments = project.visualSegments.filter((clip) => clip.id !== operation.clipId);
}

function duplicateVisual(project, operation) {
  materializeSourceAudioMappings(project);
  const source = findById(project.visualSegments, operation.clipId, "Visual clip");
  let id = typeof operation.newClipId === "string" ? operation.newClipId.trim() : "";
  if (!id) {
    let suffix = 1;
    while (true) {
      const candidate = `${source.id}-dup-${suffix}`;
      const exists = Object.values(TRACK_COLLECTIONS).some((key) => (project?.[key] || []).some((clip) => clip.id === candidate));
      if (!exists) {
        id = candidate;
        break;
      }
      suffix++;
    }
  }
  requireNewClipId(project, id);
  const sourceIndex = project.visualSegments.indexOf(source);
  const atIndex = operation.atIndex === undefined ? sourceIndex + 1 : operation.atIndex;
  if (!Number.isInteger(atIndex) || atIndex < 0 || atIndex > project.visualSegments.length) {
    throw Object.assign(new Error("atIndex must be a valid visual insertion position"), { code: "INVALID_ARGUMENT" });
  }
  const copy = { ...structuredClone(source), id, archiveMediaId: source.archiveMediaId || source.id };
  // A transition belongs to a boundary, not to the duplicated media clip.
  delete copy.transition;
  project.visualSegments.splice(atIndex, 0, copy);
}

// The host prepares local asset metadata. Browser callers cannot supply this
// payload: the browser planner resolves an asset ID and constructs it itself.
function insertPreparedAsset(project, operation) {
  if (operation.track === "visuals") materializeSourceAudioMappings(project);
  const id = requireNewClipId(project, operation.clipId);
  const source = operation.preparedSource;
  if (operation.prepared !== true || !source || !["image", "video", "audio"].includes(source.type)) {
    throw Object.assign(new Error("asset.insert requires host-prepared media metadata"), { code: "ASSET_NOT_PREPARED" });
  }
  const duration = finitePositive(operation.duration, "duration");
  const segment = { ...structuredClone(source), id, duration };
  if (source.type !== "image") {
    const available = finitePositive(source.sourceDuration, "sourceDuration");
    if (duration > available) throw Object.assign(new Error("Asset duration exceeds its source"), { code: "SOURCE_RANGE_EXCEEDED" });
    segment.sourceDuration = duration;
  }
  if (operation.track === "visuals") {
    if (!["image", "video"].includes(source.type)) throw Object.assign(new Error("Visuals require image or video media"), { code: "UNSUPPORTED_MEDIA_TYPE" });
    if (!Number.isInteger(operation.atIndex) || operation.atIndex < 0 || operation.atIndex > (project.visualSegments || []).length) {
      throw Object.assign(new Error("atIndex must be a valid visual insertion position"), { code: "INVALID_ARGUMENT" });
    }
    delete segment.start;
    project.visualSegments.splice(operation.atIndex, 0, segment);
  } else if (operation.track === "overlays") {
    if (!["image", "video"].includes(source.type)) throw Object.assign(new Error("Overlays require image or video media"), { code: "UNSUPPORTED_MEDIA_TYPE" });
    segment.start = finiteNonNegative(operation.start, "start");
    segment.layer = operation.layer;
    segment.baseTransform = { x: 27, y: -24, scale: 0.34, rotation: 0, opacity: 1, ...operation.transform };
    project.visualOverlaySegments = [...(project.visualOverlaySegments || []), segment];
  } else if (["audio", "music"].includes(operation.track)) {
    if (source.type !== "audio") throw Object.assign(new Error("Audio tracks require audio media"), { code: "UNSUPPORTED_MEDIA_TYPE" });
    segment.start = finiteNonNegative(operation.start, "start");
    if (operation.lane !== undefined) segment.lane = operation.lane;
    const key = operation.track === "audio" ? "audioSegments" : "musicSegments";
    project[key] = [...(project[key] || []), segment];
    if (operation.track === "audio") project.audioDuration = project.audioSegments.reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0);
    else {
      project.musicName = source.name;
      project.musicDuration = source.sourceDuration;
      project.musicStart = Math.min(...project.musicSegments.map((clip) => clip.start));
    }
  } else throw Object.assign(new Error("Unknown asset track"), { code: "UNSUPPORTED_TRACK" });
}

function addOverlay(project, operation) {
  const id = requireNewClipId(project, operation.clipId);
  const source = findVisualSource(project, operation.sourceClipId);
  const start = finiteNonNegative(operation.start, "start");
  const sourceDuration = finitePositive(Number(source.duration), "source clip duration");
  const duration = Object.hasOwn(operation, "duration") ? finitePositive(operation.duration, "duration") : Math.min(5, sourceDuration);
  if (source.type === "video" && duration > sourceDuration) {
    throw Object.assign(new Error(`Overlay duration cannot exceed source clip duration ${sourceDuration}`), { code: "SOURCE_RANGE_EXCEEDED" });
  }
  const layer = Object.hasOwn(operation, "layer") ? finitePositive(operation.layer, "layer")
    : (project.visualOverlaySegments || []).reduce((maximum, clip) => Math.max(maximum, Number(clip.layer) || 1), 0) + 1;
  const transform = operation.transform || {};
  for (const key of ["x", "y", "scale", "rotation", "opacity"]) {
    if (Object.hasOwn(transform, key) && (typeof transform[key] !== "number" || !Number.isFinite(transform[key]))) {
      throw Object.assign(new Error(`transform.${key} must be finite`), { code: "INVALID_ARGUMENT" });
    }
  }
  const rate = visualPlaybackRate(source);
  const overlay = {
    id,
    assetId: source.assetId || "",
    archiveMediaId: source.archiveMediaId || source.id,
    name: source.name || "Overlay",
    type: source.type === "video" ? "video" : "image",
    width: Number(source.width) || 0,
    height: Number(source.height) || 0,
    sourceStart: Math.max(0, Number(source.sourceStart) || 0),
    sourceDuration: source.type === "video" ? duration * rate : Math.max(0, Number(source.sourceDuration) || 0),
    playbackRate: rate,
    start,
    duration,
    muted: operation.muted === true,
    layer,
    baseTransform: { x: 27, y: -24, scale: 0.34, rotation: 0, opacity: 1, ...transform },
    keyframes: [],
  };
  project.visualOverlaySegments = [...(project.visualOverlaySegments || []), overlay];
}

function setTransition(project, operation) {
  const transitions = new Set(["none", "fade", "zoom", "flash", "wipe-left", "wipe-up", "blur", "split", "glitch"]);
  if (!transitions.has(operation.transitionId)) throw Object.assign(new Error(`Unknown transition: ${operation.transitionId}`), { code: "INVALID_TRANSITION" });
  const visuals = Array.isArray(project.visualSegments) ? project.visualSegments : [];
  const index = visuals.findIndex((clip) => clip.id === operation.clipId);
  if (index < 0) throw Object.assign(new Error(`Visual clip not found: ${operation.clipId}`), { code: "CLIP_NOT_FOUND" });
  if (operation.transitionId !== "none" && index >= visuals.length - 1) {
    throw Object.assign(new Error("A transition requires a following visual clip"), { code: "INVALID_TRANSITION_TARGET" });
  }
  if (operation.transitionId !== "none" && index < visuals.length - 1) {
    const curr = visuals[index];
    const next = visuals[index + 1];
    if (Number.isFinite(curr.start) && Number.isFinite(next.start)) {
      const currEnd = curr.start + (Number(curr.duration) || 0);
      if (next.start > currEnd + 0.05) {
        throw Object.assign(new Error("A transition requires adjacent contiguous clips without gaps"), { code: "INVALID_TRANSITION_GAP" });
      }
    }
  }
  const maximum = index < visuals.length - 1
    ? Math.max(0.1, Math.min(2, Number(visuals[index].duration) / 2, Number(visuals[index + 1].duration) / 2))
    : 0.5;
  const duration = Object.hasOwn(operation, "duration") ? finitePositive(operation.duration, "duration") : 0.5;
  if (duration > maximum) throw Object.assign(new Error(`Transition duration cannot exceed ${maximum}`), { code: "INVALID_RANGE" });
  visuals[index].transition = { id: operation.transitionId, duration: Math.min(duration, maximum) };
}

function updateCaption(project, operation) {
  project.captionSegments = materializeProjectCaptionTimings(project).captionSegments;
  const caption = findById(project.captionSegments, operation.clipId, "Caption clip");
  if (Object.hasOwn(operation, "text")) {
    if (typeof operation.text !== "string") throw Object.assign(new Error("text must be a string"), { code: "INVALID_ARGUMENT" });
    caption.text = operation.text;
  }
  if (Object.hasOwn(operation, "start")) caption.start = finiteNonNegative(operation.start, "start");
  if (Object.hasOwn(operation, "end")) caption.end = finiteNonNegative(operation.end, "end");
  requireCaptionRange(caption.start, caption.end);
  project.script = (project.captionSegments || []).map((item) => item.text).join("\n");
}

function addCaption(project, operation) {
  const existingCaptions = Array.isArray(project.captionSegments) ? project.captionSegments : [];
  if (existingCaptions.some(hasExplicitCaptionTiming)) {
    project.captionSegments = materializeProjectCaptionTimings(project).captionSegments;
  } else {
    project.captionSegments = [];
  }
  const id = requireNewClipId(project, operation.clipId);
  const captions = project.captionSegments;
  if (captions.some((caption) => caption.id === id)) {
    throw Object.assign(new Error(`Caption clip already exists: ${id}`), { code: "CLIP_ALREADY_EXISTS" });
  }
  if (typeof operation.text !== "string") throw Object.assign(new Error("text must be a string"), { code: "INVALID_ARGUMENT" });
  const start = finiteNonNegative(operation.start, "start");
  const end = finiteNonNegative(operation.end, "end");
  requireCaptionRange(start, end);
  let audioSegmentId = "";
  if (operation.audioClipId) audioSegmentId = findById(project.audioSegments, operation.audioClipId, "Audio clip").id;
  const previousCaption = [...captions]
    .sort((left, right) => (Number(left.start) || 0) - (Number(right.start) || 0))
    .filter((caption) => (Number(caption.start) || 0) <= start)
    .at(-1);
  project.captionSegments = [...captions, {
    id,
    text: operation.text,
    start,
    end,
    fontId: operation.fontId || previousCaption?.fontId || project.captionStyle?.fontId || "default",
    ...(audioSegmentId ? { audioSegmentId } : {}),
  }].sort((left, right) => (Number(left.start) || 0) - (Number(right.start) || 0));
  project.script = project.captionSegments.map((item) => item.text).join("\n");
  project.captionsEnabled = true;
}

function deleteClip(project, operation) {
  const collections = { caption: "captionSegments", captions: "captionSegments", ...TIMED_COLLECTIONS };
  const key = collections[operation.track];
  if (!key) throw Object.assign(new Error(`Unsupported clip track: ${operation.track}`), { code: "UNSUPPORTED_TRACK" });
  if (key === "captionSegments") project.captionSegments = materializeProjectCaptionTimings(project).captionSegments;
  if (operation.track === "audio") project.captionSegments = materializeProjectCaptionTimings(project).captionSegments;
  const kind = operation.track === "caption" ? "Caption" : operation.track === "music" ? "Music" : "Audio";
  findById(project[key], operation.clipId, `${kind} clip`);
  project[key] = project[key].filter((item) => item.id !== operation.clipId);
  if (key === "captionSegments") {
    project.script = project.captionSegments.map((item) => item.text).join("\n");
  } else if (operation.track === "audio") {
    project.captionSegments = (project.captionSegments || []).map((caption) => (
      caption.audioSegmentId === operation.clipId || caption.detachedAudioSegmentId === operation.clipId
        ? { ...caption, audioSegmentId: "", detachedAudioSegmentId: "" }
        : caption
    ));
    project.audioDuration = getTimedSegmentsEnd(project.audioSegments);
  } else if (operation.track === "music" && !project.musicSegments.length) {
    project.musicName = "";
    project.musicDuration = 0;
    project.musicStart = 0;
    project.musicVolume = 0;
  }
}

function deleteAudio(project, operation) {
  project.captionSegments = materializeProjectCaptionTimings(project).captionSegments;
  const audioSegments = Array.isArray(project.audioSegments) ? project.audioSegments : [];
  let clipId = typeof operation.clipId === "string" ? operation.clipId.trim() : "";
  if (!clipId) {
    if (audioSegments.length === 0) {
      throw Object.assign(new Error("No audio clips found to delete"), { code: "CLIP_NOT_FOUND" });
    }
    if (audioSegments.length > 1) {
      throw Object.assign(new Error("Multiple audio clips exist; clipId is required to avoid ambiguity"), { code: "CLIP_ID_AMBIGUOUS" });
    }
    clipId = audioSegments[0].id;
  }
  deleteClip(project, { ...operation, track: "audio", clipId });
}

function deleteMusic(project, operation) {
  const musicSegments = Array.isArray(project.musicSegments) ? project.musicSegments : [];
  let clipId = typeof operation.clipId === "string" ? operation.clipId.trim() : "";
  if (!clipId) {
    if (musicSegments.length === 0) {
      throw Object.assign(new Error("No music clips found to delete"), { code: "CLIP_NOT_FOUND" });
    }
    if (musicSegments.length > 1) {
      throw Object.assign(new Error("Multiple music clips exist; clipId is required to avoid ambiguity"), { code: "CLIP_ID_AMBIGUOUS" });
    }
    clipId = musicSegments[0].id;
  }
  deleteClip(project, { ...operation, track: "music", clipId });
}

function duckMusic(project, operation) {
  if (project?.trackLocks?.music || project?.tracks?.music?.locked) {
    throw Object.assign(new Error("music track is locked"), { code: "TRACK_LOCKED" });
  }
  const musicSegments = Array.isArray(project.musicSegments) ? project.musicSegments : [];
  let clipId = typeof operation.clipId === "string" ? operation.clipId.trim() : "";
  if (!clipId) {
    if (musicSegments.length === 0) {
      throw Object.assign(new Error("No music clips found to duck"), { code: "CLIP_NOT_FOUND" });
    }
    clipId = musicSegments[0].id;
  }
  let clipIndex = musicSegments.findIndex((m) => m.id === clipId);
  if (clipIndex < 0 && clipId) {
    clipIndex = musicSegments.findIndex((m) => m.parentClipId === clipId || (m.id && m.id.startsWith(`${clipId}-`)));
  }
  if (clipIndex < 0) {
    throw Object.assign(new Error(`Music clip not found: ${clipId}`), { code: "CLIP_NOT_FOUND" });
  }
  const musicClip = musicSegments[clipIndex];
  // Check if music segments are already ducked and share a common parent
  let startIndex = clipIndex;
  let endIndex = clipIndex + 1;
  const parentId = musicClip.parentClipId || (musicClip.id.includes("-seg-") || musicClip.id.includes("-duck-") ? musicClip.id.split(/-(?:seg|duck)-/)[0] : "");
  let unifiedClip = musicClip;
  const matchingSegments = [];

  if (parentId) {
    const matchingIndices = [];
    musicSegments.forEach((m, idx) => {
      const mParent = m.parentClipId || (m.id.includes("-seg-") || m.id.includes("-duck-") ? m.id.split(/-(?:seg|duck)-/)[0] : "");
      if (mParent === parentId || m.id === parentId) {
        matchingIndices.push(idx);
        matchingSegments.push(m);
      }
    });
    if (matchingIndices.length > 1) {
      startIndex = Math.min(...matchingIndices);
      endIndex = Math.max(...matchingIndices) + 1;
      const firstSeg = musicSegments[startIndex];
      const lastSeg = musicSegments[endIndex - 1];
      const totalDur = (Number(lastSeg.start) || 0) + (Number(lastSeg.duration) || 0) - (Number(firstSeg.start) || 0);
      const unifiedRate = Number(firstSeg.playbackRate) || 1;
      unifiedClip = {
        ...firstSeg,
        id: parentId,
        parentClipId: parentId,
        start: Number(firstSeg.start) || 0,
        duration: Math.max(0.001, totalDur),
        sourceStart: Number(firstSeg.sourceStart) || 0,
        sourceDuration: totalDur * unifiedRate,
      };
    }
  }

  // Determine true original volume without assuming 0.8 or defaulting to a ducked volume
  let baseVolume = unifiedClip.originalVolume;
  if (!Number.isFinite(baseVolume)) {
    const segWithOrig = matchingSegments.find((m) => Number.isFinite(m.originalVolume));
    if (segWithOrig) {
      baseVolume = segWithOrig.originalVolume;
    } else {
      const normalSeg = matchingSegments.find((m) => m.id && m.id.includes("-seg-") && Number.isFinite(m.volume));
      if (normalSeg) {
        baseVolume = normalSeg.volume;
      } else if (Number.isFinite(musicClip.volume) && !musicClip.id.includes("-duck-")) {
        baseVolume = musicClip.volume;
      } else if (Number.isFinite(project.musicVolume)) {
        baseVolume = project.musicVolume;
      } else {
        baseVolume = 0.8;
      }
    }
  }

  const duckVolume = Number.isFinite(Number(operation.duckVolume)) ? Math.max(0, Math.min(1, Number(operation.duckVolume))) : 0.18;
  const normalVolume = Number.isFinite(Number(operation.normalVolume)) ? Math.max(0, Math.min(4, Number(operation.normalVolume))) : baseVolume;
  unifiedClip.volume = normalVolume;
  unifiedClip.originalVolume = baseVolume;

  // Gather speech intervals from audioSegments and captionSegments
  const speechIntervals = [];
  for (const a of project.audioSegments || []) {
    const s = Math.max(0, Number(a.start) || 0);
    const d = Math.max(0, Number(a.duration) || 0);
    if (d > 0) speechIntervals.push({ start: s, end: s + d });
  }
  for (const c of project.captionSegments || []) {
    const s = Math.max(0, Number(c.start) || 0);
    const e = Math.max(0, Number(c.end) || 0);
    if (e > s) speechIntervals.push({ start: s, end: e });
  }

  if (speechIntervals.length === 0) {
    throw Object.assign(new Error("No speech or captions found to duck music against"), { code: "NO_DIALOGUE_FOUND" });
  }

  // Sort and merge overlapping speech intervals
  speechIntervals.sort((a, b) => a.start - b.start);
  const mergedSpeech = [];
  for (const interval of speechIntervals) {
    if (!mergedSpeech.length) {
      mergedSpeech.push({ ...interval });
    } else {
      const last = mergedSpeech[mergedSpeech.length - 1];
      if (interval.start <= last.end + 0.1) {
        last.end = Math.max(last.end, interval.end);
      } else {
        mergedSpeech.push({ ...interval });
      }
    }
  }

  const musicStart = Math.max(0, Number(unifiedClip.start) || 0);
  const musicDuration = Math.max(0.001, Number(unifiedClip.duration) || 0);
  const musicEnd = musicStart + musicDuration;
  const rate = Math.max(0.25, Math.min(4, Number(unifiedClip.playbackRate) || 1));
  const baseSourceStart = Math.max(0, Number(unifiedClip.sourceStart) || 0);

  // Intersect merged speech with the music clip's timeline window
  const activeDucks = [];
  for (const sp of mergedSpeech) {
    const dStart = Math.max(musicStart, sp.start);
    const dEnd = Math.min(musicEnd, sp.end);
    if (dEnd > dStart + 0.05) {
      activeDucks.push({ start: dStart, end: dEnd });
    }
  }

  if (activeDucks.length === 0) {
    throw Object.assign(new Error("No speech overlap found within the music track timing"), { code: "NO_DIALOGUE_OVERLAP" });
  }

  // Create split segments covering [musicStart, musicEnd]
  const newSegments = [];
  let currentTime = musicStart;
  let segIndex = 0;
  const effectiveParentId = parentId || unifiedClip.id;

  for (const duck of activeDucks) {
    if (duck.start > currentTime + 0.05) {
      const dur = duck.start - currentTime;
      const sStart = baseSourceStart + (currentTime - musicStart) * rate;
      newSegments.push({
        ...unifiedClip,
        id: `${effectiveParentId}-seg-${segIndex++}`,
        parentClipId: effectiveParentId,
        archiveMediaId: unifiedClip.archiveMediaId || effectiveParentId,
        start: currentTime,
        duration: dur,
        sourceStart: sStart,
        sourceDuration: dur * rate,
        volume: normalVolume,
        originalVolume: baseVolume,
      });
    }
    const duckDur = duck.end - duck.start;
    const duckSourceStart = baseSourceStart + (duck.start - musicStart) * rate;
    newSegments.push({
      ...unifiedClip,
      id: `${effectiveParentId}-duck-${segIndex++}`,
      parentClipId: effectiveParentId,
      archiveMediaId: unifiedClip.archiveMediaId || effectiveParentId,
      start: duck.start,
      duration: duckDur,
      sourceStart: duckSourceStart,
      sourceDuration: duckDur * rate,
      volume: duckVolume,
      originalVolume: baseVolume,
    });
    currentTime = duck.end;
  }

  if (currentTime < musicEnd - 0.05) {
    const dur = musicEnd - currentTime;
    const sStart = baseSourceStart + (currentTime - musicStart) * rate;
    newSegments.push({
      ...unifiedClip,
      id: `${effectiveParentId}-seg-${segIndex}`,
      parentClipId: effectiveParentId,
      archiveMediaId: unifiedClip.archiveMediaId || effectiveParentId,
      start: currentTime,
      duration: dur,
      sourceStart: sStart,
      sourceDuration: dur * rate,
      volume: normalVolume,
      originalVolume: baseVolume,
    });
  }

  project.musicSegments = [
    ...musicSegments.slice(0, startIndex),
    ...newSegments,
    ...musicSegments.slice(endIndex),
  ];
}

function captionEditScope(project, operation) {
  if (!["default", "current"].includes(operation.scope)) invalidArgument("scope must be default or current");
  if (operation.scope === "default") {
    if (Object.hasOwn(operation, "clipId")) invalidArgument("Default caption edits must not specify clipId");
    return null;
  }
  return findById(project.captionSegments, operation.clipId, "Caption clip");
}

function setCaptionStyle(project, operation) {
  if (project?.trackLocks?.caption || project?.trackLocks?.captions) {
    throw Object.assign(new Error("Caption track is locked"), { code: "TRACK_LOCKED" });
  }
  const caption = captionEditScope(project, operation);
  const style = operation.style;
  if (!style || typeof style !== "object" || Array.isArray(style) || !Object.keys(style).length) invalidArgument("style must contain at least one supported property");

  // Normalize fontId to canonical lowercase catalog font id if provided as name, family, or mixed case
  if (Object.hasOwn(style, "fontId") && typeof style.fontId === "string") {
    const matched = findCaptionFontInCatalog(style.fontId);
    if (matched) {
      style.fontId = matched.id;
    }
  }

  // Normalize activeWordColor and other color properties if named color or shorthand hex
  const colorKeys = ["textColor", "backgroundColor", "borderColor", "textStrokeColor", "activeWordColor"];
  for (const cKey of colorKeys) {
    if (Object.hasOwn(style, cKey) && typeof style[cKey] === "string") {
      const val = style[cKey].trim();
      if (!/^#[0-9a-fA-F]{6}$/.test(val)) {
        const hex = resolveColorToHex(val);
        if (hex) {
          style[cKey] = hex;
        }
      }
    }
  }

  for (const [key, value] of Object.entries(style)) {
    const rule = CAPTION_STYLE_PROPERTY_SCHEMA[key];
    if (!rule || typeof value !== rule.type || rule.enum && !rule.enum.includes(value)
      || rule.type === "number" && (!Number.isFinite(value) || value < rule.minimum || value > rule.maximum)
      || rule.pattern && !new RegExp(rule.pattern).test(value)) invalidArgument(`Invalid caption style property: ${key}`);
  }
  if (caption) {
    caption.styleOverrides = { ...(caption.styleOverrides || {}), ...style };
    return;
  }
  const { captionSize, ...visualStyle } = style;
  project.captionStyle = {
    ...(project.captionStyle || {}),
    ...visualStyle,
    ...(captionSize !== undefined ? { captionSize } : {}),
  };
  if (captionSize !== undefined) project.captionSize = captionSize;
  project.captionStylePresetId = "modified";
  // Default-style edits have the same semantics as the editor inspector:
  // edited properties become shared; unrelated per-caption overrides survive.
  project.captionSegments = (project.captionSegments || []).map((item) => {
    const next = { ...item, styleOverrides: { ...(item.styleOverrides || {}) } };
    for (const key of Object.keys(style)) delete next.styleOverrides[key];
    if (Object.hasOwn(style, "fontId")) delete next.fontId;
    if (!Object.keys(next.styleOverrides).length) delete next.styleOverrides;
    return next;
  });
}

function captionPlacement(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !["x", "y"].includes(key))
    || [value.x, value.y].some((coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate) || coordinate < 10 || coordinate > 90)) {
    invalidArgument("Caption placement is a center point with x and y percentages from 10 to 90");
  }
  return { x: value.x, y: value.y };
}

function setSharedCaptionPlacement(project, placement) {
  project.captionPlacement = captionPlacement(placement);
  project.captionPosition = [["top", 18], ["middle", 50], ["bottom", 78]]
    .find(([, y]) => Math.abs(placement.x - 50) < 4 && Math.abs(placement.y - y) < 4)?.[0] || "custom";
  project.captionSegments = (project.captionSegments || []).map(({ placement: _placement, ...caption }) => caption);
}

function setCaptionPosition(project, operation) {
  const caption = captionEditScope(project, operation);
  const placement = captionPlacement(operation.placement);
  if (caption) caption.placement = placement;
  else setSharedCaptionPlacement(project, placement);
}

function syncCaptionPosition(project, operation) {
  const caption = findById(project.captionSegments, operation.clipId, "Caption clip");
  setSharedCaptionPlacement(project, caption.placement || project.captionPlacement || { x: 50, y: 78 });
}

function setOverlayTransform(project, operation) {
  const clip = findById(project.visualOverlaySegments, operation.clipId, "Overlay clip");
  const transform = operation.transform;
  if (!transform || typeof transform !== "object" || Array.isArray(transform) || !Object.keys(transform).length) invalidArgument("transform must contain at least one supported property");
  for (const [key, value] of Object.entries(transform)) {
    const limits = NUMERIC_CLIP_PROPERTIES[key];
    if (!["x", "y", "scale", "rotation", "opacity"].includes(key) || typeof value !== "number" || !Number.isFinite(value) || value < limits.min || value > limits.max) invalidArgument(`Invalid overlay transform property: ${key}`);
  }
  clip.baseTransform = { x: 27, y: -24, scale: 0.34, rotation: 0, opacity: 1, ...(clip.baseTransform || {}), ...transform };
}

function unlinkCaption(project, operation) {
  const caption = findById(project.captionSegments, operation.clipId, "Caption clip");
  if (caption.audioSegmentId) caption.detachedAudioSegmentId = caption.audioSegmentId;
  caption.audioSegmentId = "";
}

function linkCaption(project, operation) {
  const caption = findById(project.captionSegments, operation.clipId, "Caption clip");
  const audioId = operation.audioClipId || caption.detachedAudioSegmentId;
  if (!audioId) throw Object.assign(new Error("audioClipId is required"), { code: "INVALID_ARGUMENT" });
  const audio = findById(project.audioSegments, audioId, "Audio clip");
  caption.audioSegmentId = audio.id;
  caption.detachedAudioSegmentId = "";
  if (operation.align === true) {
    caption.start = Number(audio.start) || 0;
    caption.end = caption.start + finiteNonNegative(audio.duration, "audio duration");
  }
}

function findClipMatch(project, clipId) {
  const matches = Object.entries(TRACK_COLLECTIONS).flatMap(([track, key]) => {
    const clips = Array.isArray(project?.[key]) ? project[key] : [];
    return clips.flatMap((clip, index) => clip.id === clipId ? [{ track, key, clip, index }] : []);
  });
  if (!matches.length) throw Object.assign(new Error(`Clip not found: ${clipId}`), { code: "CLIP_NOT_FOUND" });
  if (matches.length > 1) throw Object.assign(new Error(`Clip ID is not globally unique: ${clipId}`), { code: "CLIP_ID_AMBIGUOUS" });
  return matches[0];
}

const NUMERIC_CLIP_PROPERTIES = Object.freeze({
  x: { min: -1000, max: 1000 },
  y: { min: -1000, max: 1000 },
  scale: { min: 0.1, max: 20 },
  rotation: { min: -36000, max: 36000 },
  opacity: { min: 0, max: 1 },
  volume: { min: 0, max: 4 },
  fadeIn: { min: 0, max: 1800 },
  fadeOut: { min: 0, max: 1800 },
  layer: { min: 0, max: 1000 },
});

function setClipProperty(project, operation) {
  if (operation.scope === "all" || operation.clipId === "all") {
    if (project?.trackLocks?.image) {
      throw Object.assign(new Error("Visual track is locked"), { code: "TRACK_LOCKED" });
    }
    const visuals = Array.isArray(project.visualSegments) ? project.visualSegments : [];
    for (const clip of visuals) {
      setClipProperty(project, { ...operation, scope: "single", clipId: clip.id });
    }
    return;
  }
  let clipId = typeof operation.clipId === "string" ? operation.clipId.trim() : "";
  if (!clipId || clipId === "music" || clipId === "background-music") {
    if (project.musicSegments?.length === 1) clipId = project.musicSegments[0].id;
  }
  if (!clipId || clipId === "audio" || clipId === "voiceover") {
    if (project.audioSegments?.length === 1) clipId = project.audioSegments[0].id;
  }
  const { track, clip } = findClipMatch(project, clipId);
  if (project?.trackLocks?.[track === "visuals" ? "image" : track]) {
    throw Object.assign(new Error(`${track} track is locked`), { code: "TRACK_LOCKED" });
  }
  const limits = NUMERIC_CLIP_PROPERTIES[operation.property];
  if (!limits) throw Object.assign(new Error(`Unsupported clip property: ${operation.property}`), { code: "UNSUPPORTED_PROPERTY" });
  let value = operation.value;
  if (operation.property === "volume" && typeof value === "number" && value > 4 && value <= 400) {
    value = Number((value / 100).toFixed(3));
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < limits.min || value > limits.max) {
    throw Object.assign(new Error(`${operation.property} must be between ${limits.min} and ${limits.max}`), { code: "INVALID_ARGUMENT" });
  }
  clip[operation.property] = value;
  if (["scale", "x", "y", "rotation", "opacity"].includes(operation.property) && (track === "visuals" || track === "overlays" || track === "stickers")) {
    const defaultTransform = track === "overlays"
      ? { x: 27, y: -24, scale: 0.34, rotation: 0, opacity: 1 }
      : { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
    clip.baseTransform = {
      ...defaultTransform,
      ...(clip.baseTransform || {}),
      [operation.property]: value,
    };
  }
  if (operation.property === "volume" && project.musicSegments?.some((m) => m.id === clip.id)) {
    project.musicVolume = value;
  }
}

function setClipSpeed(project, operation) {
  if (operation.scope === "all" || operation.clipId === "all") {
    if (project?.trackLocks?.image) {
      throw Object.assign(new Error("Visual track is locked"), { code: "TRACK_LOCKED" });
    }
    const visuals = Array.isArray(project.visualSegments) ? project.visualSegments : [];
    for (const clip of visuals) {
      if (clip.type === "video") {
        setClipSpeed(project, { ...operation, scope: "single", clipId: clip.id });
      }
    }
    return;
  }
  const match = findClipMatch(project, operation.clipId);
  const isLocked =
    project?.trackLocks?.[match.track === "visuals" ? "image" : match.track] ||
    project?.trackLocks?.[match.track] ||
    project?.tracks?.[match.track]?.locked;
  if (isLocked) {
    throw Object.assign(new Error(`${match.track} track is locked`), { code: "TRACK_LOCKED" });
  }
  if (match.track === "captions" || match.track === "stickers" || (match.track === "visuals" && match.clip.type !== "video") || (match.track === "overlays" && match.clip.type !== "video")) {
    throw Object.assign(new Error(`Speed is unsupported for ${match.track} clip ${operation.clipId}`), { code: "UNSUPPORTED_MEDIA_TYPE" });
  }
  const speed = finitePositive(operation.speed, "speed");
  if (speed < 0.25 || speed > 4) throw Object.assign(new Error("speed must be between 0.25 and 4"), { code: "INVALID_ARGUMENT" });
  const clip = match.clip;
  const previousDuration = finitePositive(Number(clip.duration), "clip duration");
  const previousRate = visualPlaybackRate(clip);
  const sourceDuration = Math.max(0.001, Number(clip.sourceDuration) || previousDuration * previousRate);
  const duration = sourceDuration / speed;
  clip.playbackRate = speed;
  clip.speed = speed;
  clip.sourceDuration = sourceDuration;
  clip.duration = duration;
  if (Array.isArray(clip.keyframes)) {
    const timeScale = duration / previousDuration;
    clip.keyframes = clip.keyframes.map((frame) => ({ ...frame, time: Math.max(0, Number(frame.time) || 0) * timeScale }));
  }
  if (match.track === "audio") {
    const clipEnd = (Number(clip.start) || 0) + duration;
    project.captionSegments = (project.captionSegments || []).map((caption) => caption.audioSegmentId === clip.id
      ? { ...caption, end: Math.max(Number(caption.start) || 0, Math.min(Number(caption.end) || 0, clipEnd)) }
      : caption);
  }
}

const SUPPORTED_CLIP_FILTERS = new Set([
  "none", "cool", "film", "bright",
  "effect-clean", "effect-soft", "effect-cinematic", "effect-vivid",
  "effect-night", "effect-warm", "effect-cold", "effect-noir", "effect-dream",
]);

function setClipFilter(project, operation) {
  if (project?.trackLocks?.image || project?.trackLocks?.visuals || project?.tracks?.visuals?.locked) {
    throw Object.assign(new Error("Visual track is locked"), { code: "TRACK_LOCKED" });
  }
  const filterId = typeof operation.filterId === "string" ? operation.filterId.trim().toLowerCase() : "";
  if (!SUPPORTED_CLIP_FILTERS.has(filterId)) {
    throw Object.assign(new Error(`Unsupported filter: ${operation.filterId}`), { code: "INVALID_FILTER" });
  }
  if (operation.scope === "all" || operation.clipId === "all" || !operation.clipId) {
    project.selectedFilterId = filterId;
    const visuals = Array.isArray(project.visualSegments) ? project.visualSegments : [];
    for (const clip of visuals) {
      clip.filterId = filterId;
      clip.filter = filterId;
    }
    return;
  }
  const match = findClipMatch(project, operation.clipId);
  match.clip.filterId = filterId;
  match.clip.filter = filterId;
}

function setClipColorGrade(project, operation) {
  if (project?.trackLocks?.image || project?.trackLocks?.visuals || project?.tracks?.visuals?.locked) {
    throw Object.assign(new Error("Visual track is locked"), { code: "TRACK_LOCKED" });
  }
  if (!operation.colorGrade || typeof operation.colorGrade !== "object" || Array.isArray(operation.colorGrade)) {
    throw Object.assign(new Error("colorGrade must be an object"), { code: "INVALID_ARGUMENT" });
  }
  const nextGrade = normalizeColorGrade(operation.colorGrade);
  if (operation.scope === "all" || operation.clipId === "all" || !operation.clipId) {
    const visuals = Array.isArray(project.visualSegments) ? project.visualSegments : [];
    for (const clip of visuals) {
      clip.colorGrade = { ...(clip.colorGrade || {}), ...nextGrade };
    }
    return;
  }
  const match = findClipMatch(project, operation.clipId);
  match.clip.colorGrade = { ...(match.clip.colorGrade || {}), ...nextGrade };
}

function setClipMuted(project, operation) {
  if (typeof operation.muted !== "boolean") throw Object.assign(new Error("muted must be a boolean"), { code: "INVALID_ARGUMENT" });
  let clipId = typeof operation.clipId === "string" ? operation.clipId.trim() : "";
  if (!clipId || clipId === "music" || clipId === "background-music") {
    if (project.musicSegments?.length === 1) clipId = project.musicSegments[0].id;
  }
  if (!clipId || clipId === "audio" || clipId === "voiceover") {
    if (project.audioSegments?.length === 1) clipId = project.audioSegments[0].id;
  }
  const { track, clip } = findClipMatch(project, clipId);
  if (!["visuals", "audio", "overlays", "music"].includes(track)) {
    throw Object.assign(new Error(`Mute is unsupported for ${track} clips`), { code: "UNSUPPORTED_TRACK" });
  }
  if ((track === "visuals" || track === "overlays") && clip.type !== "video") {
    throw Object.assign(new Error("Mute is supported only for video or audio clips"), { code: "UNSUPPORTED_MEDIA_TYPE" });
  }
  if (track === "visuals") clip.sourceAudioDisabled = operation.muted;
  clip.muted = operation.muted;
}

const TRACK_STATE_KEYS = Object.freeze({
  visuals: "image", image: "image",
  captions: "caption", caption: "caption",
  audio: "audio",
  stickers: "sticker", sticker: "sticker",
  overlays: "overlay", overlay: "overlay",
  source: "source",
  music: "music",
});

function setTrackState(project, operation, stateKey) {
  const track = TRACK_STATE_KEYS[operation.track];
  if (!track) throw Object.assign(new Error(`Unknown track: ${operation.track}`), { code: "TRACK_NOT_FOUND" });
  const value = operation[stateKey];
  if (typeof value !== "boolean") throw Object.assign(new Error(`${stateKey} must be a boolean`), { code: "INVALID_ARGUMENT" });
  const projectKey = stateKey === "visible" ? "trackVisibility" : "trackLocks";
  project[projectKey] = { ...(project[projectKey] || {}), [track]: value };
}

function setProjectRatio(project, operation) {
  const supportedRatios = new Set(["16:9", "9:16", "1:1", "4:5"]);
  if (!supportedRatios.has(operation.ratio)) throw Object.assign(new Error(`Unsupported project ratio: ${operation.ratio}`), { code: "INVALID_RATIO" });
  project.ratioId = operation.ratio;
}

function setProjectFit(project, operation) {
  if (!["contain", "cover"].includes(operation.fitMode)) invalidArgument("fitMode must be contain or cover");
  project.fitMode = operation.fitMode;
}

function requireMarkerId(value) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 160) {
    throw Object.assign(new Error("markerId must be a non-empty string of at most 160 characters without surrounding whitespace"), { code: "INVALID_ARGUMENT" });
  }
  return value;
}

function markerNumber(value, field) {
  const result = finiteNonNegative(value, field);
  if (result > MAX_TIMELINE_MARKER_SECONDS) {
    throw Object.assign(new Error(`${field} must not exceed ${MAX_TIMELINE_MARKER_SECONDS} seconds`), { code: "INVALID_ARGUMENT" });
  }
  return result;
}

function markerString(value, field, maximumLength) {
  if (typeof value !== "string" || value.length > maximumLength) {
    throw Object.assign(new Error(`${field} must be a string of at most ${maximumLength} characters`), { code: "INVALID_ARGUMENT" });
  }
  return value;
}

function markerKind(value) {
  if (!TIMELINE_MARKER_TYPES.includes(value)) {
    throw Object.assign(new Error(`markerType must be one of ${TIMELINE_MARKER_TYPES.join(", ")}`), { code: "INVALID_ARGUMENT" });
  }
  return value;
}

function markerColor(value) {
  if (!TIMELINE_MARKER_COLORS.includes(value)) {
    throw Object.assign(new Error(`color must be one of ${TIMELINE_MARKER_COLORS.join(", ")}`), { code: "INVALID_ARGUMENT" });
  }
  return value;
}

function markerEntries(project) {
  const raw = Array.isArray(project?.timelineMarkers) ? project.timelineMarkers : [];
  const indices = raw.flatMap((item, index) => item && typeof item === "object" && !Array.isArray(item) ? [index] : []);
  return normalizeTimelineMarkers(raw).map((marker, index) => ({ marker, index: indices[index] }));
}

function findMarkerEntry(project, markerId) {
  const markers = Array.isArray(project.timelineMarkers) ? project.timelineMarkers : [];
  const index = markers.findIndex((marker) => marker.id === markerId);
  if (index < 0) throw Object.assign(new Error(`Marker not found: ${markerId}`), { code: "MARKER_NOT_FOUND" });
  return { marker: markers[index], index };
}

function nextMarker(operation, markerId, previous = null) {
  const has = (field) => Object.hasOwn(operation, field);
  const type = has("markerType") ? markerKind(operation.markerType) : previous?.type || "marker";
  const time = has("time") ? markerNumber(operation.time, "time") : previous ? previous.time : markerNumber(undefined, "time");
  const marker = {
    id: markerId,
    type,
    time,
    title: has("title") ? markerString(operation.title, "title", 240) : previous?.title || "",
    notes: has("notes") ? markerString(operation.notes, "notes", 20000) : previous?.notes || "",
    color: has("color") ? markerColor(operation.color) : previous?.color || "cyan",
  };
  if (type === "range") {
    const endTime = has("endTime") ? markerNumber(operation.endTime, "endTime")
      : previous?.type === "range" ? markerNumber(has("time") ? time + Math.max(0.001, previous.endTime - previous.time) : previous.endTime, "endTime")
        : markerNumber(undefined, "endTime");
    const timeTolerance = Number.EPSILON * Math.max(1, time, endTime) * 4;
    if (endTime <= time || endTime - time < 0.001 - timeTolerance) {
      throw Object.assign(new Error("A range marker must span at least 0.001 seconds"), { code: "INVALID_RANGE" });
    }
    marker.endTime = endTime;
  } else if (has("endTime")) {
    throw Object.assign(new Error("endTime is supported only for range markers"), { code: "INVALID_ARGUMENT" });
  }
  return marker;
}

function addMarker(project, operation) {
  const markerId = requireMarkerId(operation.markerId);
  if ((project.timelineMarkers || []).some((marker) => marker.id === markerId)) {
    throw Object.assign(new Error(`Marker already exists: ${markerId}`), { code: "MARKER_ALREADY_EXISTS" });
  }
  const marker = nextMarker(operation, markerId);
  project.timelineMarkers = [...(Array.isArray(project.timelineMarkers) ? project.timelineMarkers : []), marker];
}

function updateMarker(project, operation) {
  const markerId = requireMarkerId(operation.markerId);
  const { marker, index } = findMarkerEntry(project, markerId);
  const updated = { ...project.timelineMarkers[index], ...nextMarker(operation, markerId, marker) };
  if (updated.type !== "range") delete updated.endTime;
  project.timelineMarkers[index] = updated;
}

function deleteMarker(project, operation) {
  const markerId = requireMarkerId(operation.markerId);
  const { index } = findMarkerEntry(project, markerId);
  project.timelineMarkers.splice(index, 1);
}

function punchInVisual(project, operation) {
  if (project?.trackLocks?.image || project?.trackLocks?.visuals || project?.tracks?.visuals?.locked) {
    throw Object.assign(new Error("Visual track is locked"), { code: "TRACK_LOCKED" });
  }

  const visuals = Array.isArray(project.visualSegments) ? project.visualSegments : [];
  if (!visuals.length) {
    throw Object.assign(new Error("No visual clips available for Smart Zoom"), { code: "CLIP_NOT_FOUND" });
  }

  // Handle auto mode (speech/caption moment discovery)
  if (operation.mode === "auto") {
    const moments = detectSpeechPunchInMoments(project, operation);
    if (!moments.length) {
      throw Object.assign(new Error("No suitable speech moments found for Smart Zoom"), { code: "NO_MOMENTS_FOUND" });
    }
    const excludeIds = new Set(Array.isArray(operation.excludeClipIds) ? operation.excludeClipIds : []);
    for (const moment of moments) {
      if (excludeIds.has(moment.clipId)) continue;
      const clip = visuals.find((c) => c.id === moment.clipId);
      if (!clip || clip.locked) continue;

      const punchIns = Array.isArray(clip.punchIns) ? [...clip.punchIns] : [];
      const existingIdx = punchIns.findIndex((p) => Math.abs(p.time - moment.time) < 1.0);
      const normalized = normalizePunchIn({
        id: existingIdx >= 0 ? punchIns[existingIdx].id : moment.id,
        time: moment.time,
        duration: moment.duration,
        scale: moment.scale,
        transition: moment.transition,
        transitionDuration: moment.transitionDuration,
        faceAnchored: moment.faceAnchored,
        x: moment.x,
        y: moment.y,
      }, clip.duration);

      if (existingIdx >= 0) {
        punchIns[existingIdx] = normalized;
      } else {
        punchIns.push(normalized);
      }
      clip.punchIns = punchIns.sort((a, b) => a.time - b.time);
      clip.keyframes = compilePunchInKeyframes(clip.keyframes, clip.punchIns, clip.duration);
    }
    return;
  }

  // Handle targeted or all-clips punch-in
  const isAll = operation.scope === "all" || operation.clipId === "all";
  const targetClips = isAll ? visuals : [findById(visuals, operation.clipId, "Visual clip")];

  for (const clip of targetClips) {
    if (clip.locked) {
      if (!isAll) throw Object.assign(new Error(`Clip is locked: ${clip.id}`), { code: "CLIP_LOCKED" });
      continue;
    }

    const clipDuration = Math.max(0.1, Number(clip.duration) || 0);
    let localTime = 0;
    if (Number.isFinite(Number(operation.time))) {
      localTime = Number(operation.time);
      if (localTime >= clipDuration && !isAll) {
        const clipIdx = visuals.indexOf(clip);
        const clipStart = visuals.slice(0, clipIdx).reduce((sum, c) => sum + (Number(c.duration) || 0), 0);
        if (localTime >= clipStart && localTime < clipStart + clipDuration) {
          localTime = localTime - clipStart;
        }
      }
    } else if (Number.isFinite(Number(operation.timelineTime))) {
      const clipIdx = visuals.indexOf(clip);
      const clipStart = visuals.slice(0, clipIdx).reduce((sum, c) => sum + (Number(c.duration) || 0), 0);
      localTime = Math.max(0, Number(operation.timelineTime) - clipStart);
    }

    if (localTime < 0 || localTime >= clipDuration) {
      if (!isAll) throw Object.assign(new Error(`Punch-in timestamp ${localTime}s is outside clip boundaries (0s - ${clipDuration}s)`), { code: "INVALID_ARGUMENT" });
      continue;
    }

    const scale = normalizePunchInScale(operation.scale ?? operation.intensity);
    const duration = Math.min(
      Math.max(SMART_ZOOM_DEFAULTS.minDuration, Number(operation.duration) || SMART_ZOOM_DEFAULTS.duration),
      clipDuration - localTime
    );
    const transition = normalizePunchInTransition(operation.transition);
    const transitionDuration = Math.max(
      SMART_ZOOM_DEFAULTS.minTransitionDuration,
      Math.min(SMART_ZOOM_DEFAULTS.maxTransitionDuration, Number(operation.transitionDuration) || SMART_ZOOM_DEFAULTS.transitionDuration)
    );
    const faceAnchored = Boolean(operation.faceAnchored);

    const offset = resolvePunchInOffset({
      segment: clip,
      scale,
      faceAnchored,
      time: localTime,
      manualX: operation.x,
      manualY: operation.y,
    });

    const punchIns = Array.isArray(clip.punchIns) ? [...clip.punchIns] : [];
    const existingIdx = operation.punchInId
      ? punchIns.findIndex((p) => p.id === operation.punchInId)
      : punchIns.findIndex((p) => Math.abs(p.time - localTime) < 0.5);

    const newPunchIn = normalizePunchIn({
      id: existingIdx >= 0 ? punchIns[existingIdx].id : operation.punchInId,
      time: localTime,
      duration,
      scale,
      transition,
      transitionDuration,
      faceAnchored,
      x: offset.x,
      y: offset.y,
    }, clipDuration);

    if (existingIdx >= 0) {
      punchIns[existingIdx] = newPunchIn;
    } else {
      punchIns.push(newPunchIn);
    }

    clip.punchIns = punchIns.sort((a, b) => a.time - b.time);
    clip.keyframes = compilePunchInKeyframes(clip.keyframes, clip.punchIns, clipDuration);
  }
}

function removePunchInVisual(project, operation) {
  if (project?.trackLocks?.image || project?.trackLocks?.visuals || project?.tracks?.visuals?.locked) {
    throw Object.assign(new Error("Visual track is locked"), { code: "TRACK_LOCKED" });
  }

  const visuals = Array.isArray(project.visualSegments) ? project.visualSegments : [];
  const isAll = operation.scope === "all" || operation.clipId === "all" || !operation.clipId;
  const targetClips = isAll ? visuals : [findById(visuals, operation.clipId, "Visual clip")];

  let removedAny = false;
  for (const clip of targetClips) {
    if (clip.locked) {
      if (!isAll) throw Object.assign(new Error(`Clip is locked: ${clip.id}`), { code: "CLIP_LOCKED" });
      continue;
    }
    const current = Array.isArray(clip.punchIns) ? clip.punchIns : [];
    if (!current.length) continue;

    let next;
    if (operation.punchInId) {
      next = current.filter((p) => p.id !== operation.punchInId);
    } else if (Number.isFinite(Number(operation.time)) || Number.isFinite(Number(operation.timelineTime))) {
      let targetTime = Number.isFinite(Number(operation.time)) ? Number(operation.time) : Number(operation.timelineTime);
      const clipIdx = visuals.indexOf(clip);
      const clipStart = visuals.slice(0, clipIdx).reduce((sum, c) => sum + (Number(c.duration) || 0), 0);
      if (targetTime >= clipStart && targetTime < clipStart + (Number(clip.duration) || 0)) {
        targetTime -= clipStart;
      }
      next = current.filter((p) => Math.abs(p.time - targetTime) > 0.5);
    } else {
      next = current.slice(0, -1);
    }

    if (next.length !== current.length) {
      removedAny = true;
      clip.punchIns = next;
      clip.keyframes = compilePunchInKeyframes(clip.keyframes, clip.punchIns, clip.duration);
    }
  }

  if (!isAll && !removedAny) {
    throw Object.assign(new Error("Punch-in not found"), { code: "PUNCH_IN_NOT_FOUND" });
  }
}

function resetZoomVisual(project, operation) {
  if (project?.trackLocks?.image || project?.trackLocks?.visuals || project?.tracks?.visuals?.locked) {
    throw Object.assign(new Error("Visual track is locked"), { code: "TRACK_LOCKED" });
  }

  const visuals = Array.isArray(project.visualSegments) ? project.visualSegments : [];
  const isAll = operation.scope === "all" || operation.clipId === "all" || !operation.clipId;
  const targetClips = isAll ? visuals : [findById(visuals, operation.clipId, "Visual clip")];

  for (const clip of targetClips) {
    if (clip.locked) {
      if (!isAll) throw Object.assign(new Error(`Clip is locked: ${clip.id}`), { code: "CLIP_LOCKED" });
      continue;
    }
    clip.punchIns = [];
    clip.scale = 1;
    clip.x = 0;
    clip.y = 0;
    clip.keyframes = compilePunchInKeyframes(clip.keyframes, [], clip.duration);
  }
}

const reducers = {
  "asset.import": importAsset,
  "asset.insert": insertPreparedAsset,
  "timed.move": moveTimed,
  "timed.resize": resizeTimed,
  "timed.trim": trimTimed,
  "visual.trim": trimVisual,
  "visual.split": splitVisual,
  "visual.reorder": reorderVisual,
  "visual.append": appendVisual,
  "visual.insert": insertVisual,
  "visual.delete": deleteVisual,
  "visual.duplicate": duplicateVisual,
  "visual.punch_in": punchInVisual,
  "visual.remove_punch_in": removePunchInVisual,
  "visual.reset_zoom": resetZoomVisual,
  "overlay.add": addOverlay,
  "overlay.set_transform": setOverlayTransform,
  "transition.set": setTransition,
  "caption.add": addCaption,
  "caption.update": updateCaption,
  "caption.set_style": setCaptionStyle,
  "caption.set_position": setCaptionPosition,
  "caption.sync_position": syncCaptionPosition,
  "caption.delete": (project, operation) => deleteClip(project, { ...operation, track: "caption" }),
  "caption.unlink_audio": unlinkCaption,
  "caption.link_audio": linkCaption,
  "audio.delete": deleteAudio,
  "music.delete": deleteMusic,
  "music.duck": duckMusic,
  "marker.add": addMarker,
  "marker.update": updateMarker,
  "marker.delete": deleteMarker,
  "clip.delete": deleteClip,
  "clip.set_property": setClipProperty,
  "clip.set_speed": setClipSpeed,
  "clip.set_filter": setClipFilter,
  "clip.set_color_grade": setClipColorGrade,
  "clip.set_muted": setClipMuted,
  "track.set_visibility": (project, operation) => setTrackState(project, operation, "visible"),
  "track.set_locked": (project, operation) => setTrackState(project, operation, "locked"),
  "project.set_ratio": setProjectRatio,
  "project.set_fit": setProjectFit,
};

export function validateCommandPlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return failure("INVALID_PLAN", "Plan must be an object");
  if (plan.schemaVersion !== PROJECT_COMMAND_SCHEMA_VERSION) return failure("UNSUPPORTED_SCHEMA", "schemaVersion must be 1");
  if (!Number.isInteger(plan.baseRevision) || plan.baseRevision < 0) return failure("INVALID_PLAN", "baseRevision must be a non-negative integer");
  if (!Array.isArray(plan.operations) || plan.operations.length === 0) return failure("INVALID_PLAN", "operations must be a non-empty array");
  const ids = new Set();
  for (const operation of plan.operations) {
    if (!operation || typeof operation.id !== "string" || !operation.id.trim()) return failure("INVALID_PLAN", "Every operation requires an id");
    if (ids.has(operation.id)) return failure("DUPLICATE_OPERATION_ID", `Duplicate operation id: ${operation.id}`, operation.id);
    ids.add(operation.id);
    if (!Object.hasOwn(reducers, operation.type)) return failure("UNKNOWN_OPERATION", `Unknown operation type: ${operation.type}`, operation.id);
  }
  return { ok: true };
}

export function inspectProject(project) {
  const state = commandState(project);
  const captions = resolveProjectCaptions(project);
  const audio = Array.isArray(project?.audioSegments) ? project.audioSegments : [];
  const visuals = Array.isArray(project?.visualSegments) ? project.visualSegments : [];
  const stickers = Array.isArray(project?.stickerSegments) ? project.stickerSegments : [];
  const overlays = Array.isArray(project?.visualOverlaySegments) ? project.visualOverlaySegments : [];
  const music = Array.isArray(project?.musicSegments) ? project.musicSegments : [];
  const markers = normalizeTimelineMarkers(project?.timelineMarkers);
  const visualDuration = visuals.reduce((total, item) => total + Math.max(0, Number(item.duration) || 0), 0);
  const duration = [visualDuration, ...captions.map((item) => Number(item.end) || 0), ...audio.map((item) => (Number(item.start) || 0) + (Number(item.duration) || 0)),
    ...stickers.map((item) => (Number(item.start) || 0) + (Number(item.duration) || 0)),
    ...overlays.map((item) => (Number(item.start) || 0) + (Number(item.duration) || 0)),
    ...music.map((item) => (Number(item.start) || 0) + (Number(item.duration) || 0))]
    .reduce((maximum, value) => Math.max(maximum, value), 0);
  return {
    schemaVersion: PROJECT_COMMAND_SCHEMA_VERSION,
    revision: state.revision,
    duration,
    ratio: project?.ratioId || "16:9",
    tracks: { captions: captions.length, audio: audio.length, visuals: visuals.length, stickers: stickers.length, overlays: overlays.length, music: music.length },
    markers: { count: markers.length, byType: Object.fromEntries(TIMELINE_MARKER_TYPES.map((type) => [type, markers.filter((marker) => marker.type === type).length])) },
    appliedOperationIds: state.appliedOperationIds,
    warnings: audio.length ? [] : ["Project has no serialized voiceover clips"],
  };
}

const TRACK_COLLECTIONS = Object.freeze({
  visuals: "visualSegments",
  captions: "captionSegments",
  audio: "audioSegments",
  stickers: "stickerSegments",
  overlays: "visualOverlaySegments",
  music: "musicSegments",
});

function clipSummary(track, clip, index, visualStart = 0) {
  if (track === "visuals") {
    const duration = Math.max(0, Number(clip.duration) || 0);
    return { id: clip.id, index, type: clip.type || "image", start: visualStart, end: visualStart + duration, duration,
      assetId: clip.assetId || "", name: clip.name || "" };
  }
  if (track === "captions") {
    const start = Math.max(0, Number(clip.start) || 0);
    const end = Math.max(start, Number(clip.end) || start);
    return { id: clip.id, index, start, end, duration: end - start, text: clip.text || "", audioSegmentId: clip.audioSegmentId || "" };
  }
  const start = Math.max(0, Number(clip.start) || 0);
  const duration = Math.max(0, Number(clip.duration) || 0);
  return { id: clip.id, index, start, end: start + duration, duration, name: clip.name || "" };
}

export function inspectTrack(project, track) {
  const key = TRACK_COLLECTIONS[track];
  if (!key) throw Object.assign(new Error(`Unknown track: ${track}`), { code: "TRACK_NOT_FOUND" });
  const clips = track === "captions" ? resolveProjectCaptions(project) : Array.isArray(project?.[key]) ? project[key] : [];
  let visualCursor = 0;
  const summaries = clips.map((clip, index) => {
    const summary = clipSummary(track, clip, index, visualCursor);
    if (track === "visuals") visualCursor = summary.end;
    return summary;
  }).sort((left, right) => left.start - right.start || left.index - right.index);
  return {
    schemaVersion: PROJECT_COMMAND_SCHEMA_VERSION,
    revision: commandState(project).revision,
    track,
    visible: project?.trackVisibility?.[TRACK_STATE_KEYS[track]] ?? true,
    locked: project?.trackLocks?.[TRACK_STATE_KEYS[track]] ?? false,
    clipCount: summaries.length,
    duration: summaries.reduce((maximum, clip) => Math.max(maximum, clip.end), 0),
    clips: summaries,
  };
}

export function inspectClip(project, clipId) {
  const { track, clip: storedClip, index } = findClipMatch(project, clipId);
  const clip = track === "captions" ? resolveProjectCaptions(project)[index] : storedClip;
  const visualStart = track === "visuals"
    ? project.visualSegments.slice(0, index).reduce((total, item) => total + Math.max(0, Number(item.duration) || 0), 0)
    : 0;
  return {
    schemaVersion: PROJECT_COMMAND_SCHEMA_VERSION,
    revision: commandState(project).revision,
    track,
    summary: clipSummary(track, clip, index, visualStart),
    source: {
      assetId: clip.assetId || "",
      archiveMediaId: clip.archiveMediaId || clip.id,
      sourceStart: Math.max(0, Number(clip.sourceStart) || 0),
      sourceDuration: Math.max(0, Number(clip.sourceDuration) || 0),
      playbackRate: visualPlaybackRate(clip),
    },
    links: { audioSegmentId: clip.audioSegmentId || "", detachedAudioSegmentId: clip.detachedAudioSegmentId || "" },
    properties: Object.fromEntries(Object.entries(clip).filter(([key]) => !["id", "assetId", "archiveMediaId", "sourceStart", "sourceDuration", "playbackRate", "audioSegmentId", "detachedAudioSegmentId"].includes(key))),
  };
}

export function inspectTranscript(project, audioClipId = "") {
  const captions = resolveProjectCaptions(project)
    .map((caption, index) => {
      const start = Math.max(0, Number(caption.start) || 0);
      const end = Math.max(start, Number(caption.end) || start);
      const words = (Array.isArray(caption.words) ? caption.words : []).map((word) => ({
        text: String(word?.text ?? word?.word ?? ""),
        start: Math.max(start, Number(word?.start) || start),
        end: Math.max(start, Number(word?.end) || Number(word?.start) || start),
        ...(Number.isFinite(Number(word?.confidence)) ? { confidence: Number(word.confidence) } : {}),
      }));
      return {
        id: caption.id,
        index,
        text: caption.text || "",
        start,
        end,
        duration: end - start,
        speaker: caption.speaker || caption.speakerId || "",
        audioClipId: caption.audioSegmentId || "",
        detachedAudioClipId: caption.detachedAudioSegmentId || "",
        words,
      };
    }).filter((caption) => !audioClipId || (caption.audioClipId || caption.detachedAudioClipId) === audioClipId)
    .sort((left, right) => left.start - right.start || left.index - right.index);
  return {
    schemaVersion: PROJECT_COMMAND_SCHEMA_VERSION,
    revision: commandState(project).revision,
    audioClipId,
    segmentCount: captions.length,
    wordCount: captions.reduce((total, caption) => total + caption.words.length, 0),
    duration: captions.reduce((maximum, caption) => Math.max(maximum, caption.end), 0),
    text: captions.map((caption) => caption.text).join("\n"),
    segments: captions,
  };
}

export function inspectMarkers(project, markerId = "") {
  const entries = markerEntries(project).sort((left, right) => left.marker.time - right.marker.time || left.index - right.index);
  const markers = entries.filter(({ marker }) => markerId === "" || marker.id === markerId).map(({ marker }) => marker);
  if (markerId !== "" && !markers.length) throw Object.assign(new Error(`Marker not found: ${markerId}`), { code: "MARKER_NOT_FOUND" });
  return {
    schemaVersion: PROJECT_COMMAND_SCHEMA_VERSION,
    revision: commandState(project).revision,
    markerCount: markers.length,
    markers,
  };
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function diffProjects(beforeProject, afterProject) {
  const projectFields = ["ratioId", "fitMode", "selectedFilterId", "trackVisibility", "trackLocks", "script", "captionsEnabled", "captionStyle", "captionSize", "captionStylePresetId", "captionPlacement", "captionPosition"]
    .flatMap((field) => sameValue(beforeProject?.[field], afterProject?.[field]) ? [] : [{ field, before: beforeProject?.[field] ?? null, after: afterProject?.[field] ?? null }]);
  const tracks = Object.fromEntries(Object.entries(TRACK_COLLECTIONS).flatMap(([track, key]) => {
    const before = Array.isArray(beforeProject?.[key]) ? beforeProject[key] : [];
    const after = Array.isArray(afterProject?.[key]) ? afterProject[key] : [];
    const beforeById = new Map(before.map((clip) => [clip.id, clip]));
    const afterById = new Map(after.map((clip) => [clip.id, clip]));
    const added = after.filter((clip) => !beforeById.has(clip.id)).map((clip) => clip.id);
    const removed = before.filter((clip) => !afterById.has(clip.id)).map((clip) => clip.id);
    const modified = after.flatMap((clip) => {
      const previous = beforeById.get(clip.id);
      if (!previous || sameValue(previous, clip)) return [];
      const fields = [...new Set([...Object.keys(previous), ...Object.keys(clip)])]
        .filter((field) => !sameValue(previous[field], clip[field]));
      return [{ id: clip.id, fields, before: Object.fromEntries(fields.map((field) => [field, previous[field] ?? null])), after: Object.fromEntries(fields.map((field) => [field, clip[field] ?? null])) }];
    });
    const orderBefore = before.map((clip) => clip.id);
    const orderAfter = after.map((clip) => clip.id);
    if (!added.length && !removed.length && !modified.length && sameValue(orderBefore, orderAfter)) return [];
    return [[track, { added, removed, modified, ...(sameValue(orderBefore, orderAfter) ? {} : { orderBefore, orderAfter }) }]];
  }));
  const beforeMarkers = inspectMarkers(beforeProject).markers;
  const afterMarkers = inspectMarkers(afterProject).markers;
  const beforeMarkersById = new Map(beforeMarkers.map((marker) => [marker.id, marker]));
  const afterMarkersById = new Map(afterMarkers.map((marker) => [marker.id, marker]));
  const markers = {
    added: afterMarkers.filter((marker) => !beforeMarkersById.has(marker.id)),
    removed: beforeMarkers.filter((marker) => !afterMarkersById.has(marker.id)),
    modified: afterMarkers.flatMap((marker) => {
      const previous = beforeMarkersById.get(marker.id);
      if (!previous || sameValue(previous, marker)) return [];
      const fields = [...new Set([...Object.keys(previous), ...Object.keys(marker)])]
        .filter((field) => !sameValue(previous[field], marker[field]));
      return [{ id: marker.id, fields, before: previous, after: marker }];
    }),
  };
  return { projectFields, tracks, ...(markers.added.length || markers.removed.length || markers.modified.length ? { markers } : {}) };
}

export function applyCommandPlan(project, plan) {
  const validity = validateCommandPlan(plan);
  if (!validity.ok) return validity;
  const current = commandState(project);
  const alreadyApplied = new Set(current.appliedOperationIds);
  if (plan.operations.every((operation) => alreadyApplied.has(operation.id))) {
    return {
      ok: true,
      revision: current.revision,
      appliedOperationIds: [],
      warnings: [],
      project: structuredClone(project),
      before: inspectProject(project),
      after: inspectProject(project),
      changes: { projectFields: [], tracks: {} },
    };
  }
  if (plan.baseRevision !== current.revision) {
    return failure("REVISION_CONFLICT", `Expected revision ${plan.baseRevision}, found ${current.revision}`);
  }
  const next = structuredClone(project);
  const appliedOperationIds = [];
  let operationId = "";
  try {
    // Resolve imported/missing/duplicate IDs once before any marker mutations.
    // Deleting an earlier entry must not reassign a later annotation's identity.
    if (plan.operations.some((operation) => !alreadyApplied.has(operation.id) && operation.type.startsWith("marker."))) {
      next.timelineMarkers = normalizeTimelineMarkers(next.timelineMarkers);
    }
    for (const operation of plan.operations) {
      if (alreadyApplied.has(operation.id)) continue;
      operationId = operation.id;
      reducers[operation.type](next, operation);
      appliedOperationIds.push(operation.id);
    }
  } catch (error) {
    return failure(error?.code || "OPERATION_FAILED", error instanceof Error ? error.message : "Operation failed", operationId);
  }
  const revision = appliedOperationIds.length ? current.revision + 1 : current.revision;
  next[COMMAND_STATE_KEY] = {
    schemaVersion: PROJECT_COMMAND_SCHEMA_VERSION,
    revision,
    appliedOperationIds: [...current.appliedOperationIds, ...appliedOperationIds],
  };
  return {
    ok: true,
    revision,
    appliedOperationIds,
    warnings: [],
    project: next,
    before: inspectProject(project),
    after: inspectProject(next),
    changes: diffProjects(project, next),
  };
}

export { inspectPunchIns } from "./smartZoom.js";
