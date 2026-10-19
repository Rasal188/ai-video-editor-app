/**
 * Smart Zoom & Automatic Punch-ins Engine
 *
 * Provides:
 * - Speech-driven and timestamp-driven punch-in moment calculation.
 * - Face-anchored offset calculation reusing existing vision/face detections.
 * - Keyframe track generation for jump cuts and smooth push-in transitions.
 * - Parameter normalization and bounding rules.
 * - Inspection utilities for query and assistant responses.
 *
 * Requirements:
 * - NO MODEL DOWNLOADS: Reuses existing face detection/smartFrame coordinates.
 * - Real preview & export parity with linear keyframe interpolation and FFmpeg crop expressions.
 */

export const SMART_ZOOM_DEFAULTS = Object.freeze({
  scale: 1.25, // 25% punch in
  minScale: 1.05,
  maxScale: 2.5,
  duration: 3.0, // seconds
  minDuration: 0.5,
  maxDuration: 15.0,
  minSpacing: 2.0, // minimum seconds between punch-in start times
  transition: "jump", // "jump" | "smooth"
  transitionDuration: 0.3, // seconds for smooth push-in
  minTransitionDuration: 0.1,
  maxTransitionDuration: 1.5,
  faceAnchored: false,
});

/**
 * Normalizes punch-in scale.
 * Supports percentages (e.g. 20% -> 1.2, 120% -> 1.2, 1.25 -> 1.25).
 */
export function normalizePunchInScale(value, fallback = SMART_ZOOM_DEFAULTS.scale) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  // If user passed a percentage like 20 (meaning 20% zoom in)
  if (num > 0 && num <= 100 && num < 2.5) {
    // Already in scale range e.g. 1.2, 1.5, 2.0
    return Math.max(SMART_ZOOM_DEFAULTS.minScale, Math.min(SMART_ZOOM_DEFAULTS.maxScale, num));
  }
  if (num > 1 && num <= 100) {
    // e.g. 20 means 20% zoom -> 1.20
    const converted = 1 + num / 100;
    return Math.max(SMART_ZOOM_DEFAULTS.minScale, Math.min(SMART_ZOOM_DEFAULTS.maxScale, converted));
  }
  if (num > 100 && num <= 300) {
    // e.g. 125 means 125% -> 1.25
    const converted = num / 100;
    return Math.max(SMART_ZOOM_DEFAULTS.minScale, Math.min(SMART_ZOOM_DEFAULTS.maxScale, converted));
  }
  return Math.max(SMART_ZOOM_DEFAULTS.minScale, Math.min(SMART_ZOOM_DEFAULTS.maxScale, num));
}

/**
 * Normalizes punch-in duration.
 */
export function normalizePunchInDuration(value, clipDuration = Infinity) {
  const requested = Number.isFinite(Number(value)) ? Number(value) : SMART_ZOOM_DEFAULTS.duration;
  return Math.max(SMART_ZOOM_DEFAULTS.minDuration, Math.min(SMART_ZOOM_DEFAULTS.maxDuration, requested, clipDuration));
}

/**
 * Normalizes transition type.
 */
export function normalizePunchInTransition(value) {
  const str = String(value || "").toLowerCase().trim();
  if (str === "smooth" || str === "push" || str === "push-in" || str === "zoom") return "smooth";
  return "jump";
}

/**
 * Calculates max allowable camera offset percentages for scale S
 * so that no black borders or out-of-frame areas are exposed.
 */
export function getMaxAllowableOffset(scale) {
  const s = Math.max(1, Number(scale) || 1);
  // In preview canvas, image is scaled by s around center.
  // Viewport can move by at most (s - 1) / 2 of canvas dimensions in either direction.
  return Math.max(0, ((s - 1) / 2) * 100);
}

/**
 * Clamps X and Y offset percentages to keep image fully within frame.
 */
export function clampPunchInOffsets(x, y, scale) {
  const maxOffset = getMaxAllowableOffset(scale);
  const clampedX = Math.max(-maxOffset, Math.min(maxOffset, Number(x) || 0));
  const clampedY = Math.max(-maxOffset, Math.min(maxOffset, Number(y) || 0));
  return {
    x: Number(clampedX.toFixed(2)),
    y: Number(clampedY.toFixed(2)),
  };
}

/**
 * Extracts head/face focus coordinates from existing detection data
 * (from segment.vision, segment.smartFrame, or visionAnalysis).
 * Returns normalized focus center { focusX, focusY } in [0, 1] range,
 * or null if no reliable face detection is available.
 */
export function extractFaceFocus(segment, requestedTime = 0) {
  if (!segment) return null;

  // 1. Check existing segment.vision detections
  const vision = segment.vision;
  if (vision) {
    // If faces array is present
    const faces = Array.isArray(vision.faces) ? vision.faces : [];
    if (faces.length === 1) {
      const face = faces[0];
      const box = face.box || face;
      if (Number.isFinite(box.x) && Number.isFinite(box.y) && Number.isFinite(box.width) && Number.isFinite(box.height)) {
        return {
          focusX: box.x + box.width / 2,
          focusY: box.y + box.height * 0.35, // Eye/face level
        };
      }
    } else if (faces.length > 1) {
      // Multiple faces fallback: choose the largest prominent face or center
      const sorted = [...faces].sort((a, b) => {
        const areaA = (a.box?.width || a.width || 0) * (a.box?.height || a.height || 0);
        const areaB = (b.box?.width || b.width || 0) * (b.box?.height || b.height || 0);
        return areaB - areaA;
      });
      const primary = sorted[0];
      const box = primary.box || primary;
      if (box && Number.isFinite(box.x) && Number.isFinite(box.width)) {
        return {
          focusX: box.x + box.width / 2,
          focusY: box.y + box.height * 0.35,
        };
      }
    }

    // If subjects or person boxes
    const subjects = Array.isArray(vision.subjects) ? vision.subjects : [];
    if (subjects.length > 0) {
      const primary = subjects[0];
      const box = primary.box || primary;
      if (box && Number.isFinite(box.x) && Number.isFinite(box.width)) {
        return {
          focusX: box.x + box.width / 2,
          focusY: box.y + box.height * 0.3,
        };
      }
    }
  }

  // 2. Check existing smartFrame crop keyframes
  const smartFrame = segment.smartFrame || segment.visualEffects?.smartFrame;
  if (smartFrame && Array.isArray(smartFrame.cropKeyframes) && smartFrame.cropKeyframes.length > 0) {
    const frames = smartFrame.cropKeyframes;
    const time = Math.max(0, Number(requestedTime) || 0);
    const closest = frames.reduce((prev, curr) =>
      Math.abs(curr.time - time) < Math.abs(prev.time - time) ? curr : prev,
    frames[0]);
    if (closest && Number.isFinite(closest.x) && Number.isFinite(closest.width)) {
      return {
        focusX: closest.x + closest.width / 2,
        focusY: closest.y + (closest.height || closest.width) * 0.35,
      };
    }
  }

  return null;
}

/**
 * Resolves punch-in offset percentages { x, y } for a given scale and segment.
 * If faceAnchored is true and reliable face coordinates exist, centers the face.
 * Otherwise returns { x: 0, y: 0 } (centered punch-in).
 */
export function resolvePunchInOffset({ segment, scale, faceAnchored, time, manualX, manualY }) {
  if (Number.isFinite(manualX) || Number.isFinite(manualY)) {
    return clampPunchInOffsets(manualX ?? 0, manualY ?? 0, scale);
  }

  if (faceAnchored && segment) {
    const faceFocus = extractFaceFocus(segment, time);
    if (faceFocus && Number.isFinite(faceFocus.focusX) && Number.isFinite(faceFocus.focusY)) {
      // In canvas transform:
      // Positive X shifts image right (reveals left side).
      // To center an object at normalized focusX in [0, 1], we shift by -(focusX - 0.5) * 100 * scale.
      const rawX = -(faceFocus.focusX - 0.5) * 100 * scale;
      const rawY = -(faceFocus.focusY - 0.5) * 100 * scale;
      return clampPunchInOffsets(rawX, rawY, scale);
    }
  }

  return { x: 0, y: 0 };
}

/**
 * Normalizes a single punch-in object.
 */
export function normalizePunchIn(punchIn, clipDuration = Infinity) {
  if (!punchIn || typeof punchIn !== "object") return null;

  const id = String(punchIn.id || `pi-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const time = Math.max(0, Number(punchIn.time) || 0);
  const scale = normalizePunchInScale(punchIn.scale);
  const maxPossibleDuration = Math.max(0.1, clipDuration - time);
  const requestedDuration = Number.isFinite(Number(punchIn.duration))
    ? Number(punchIn.duration)
    : SMART_ZOOM_DEFAULTS.duration;
  const duration = Math.max(SMART_ZOOM_DEFAULTS.minDuration, Math.min(requestedDuration, maxPossibleDuration));
  const transition = normalizePunchInTransition(punchIn.transition);
  const transitionDuration = Math.max(
    SMART_ZOOM_DEFAULTS.minTransitionDuration,
    Math.min(
      SMART_ZOOM_DEFAULTS.maxTransitionDuration,
      Number(punchIn.transitionDuration) || SMART_ZOOM_DEFAULTS.transitionDuration,
      duration / 2,
    ),
  );
  const faceAnchored = Boolean(punchIn.faceAnchored);
  const { x, y } = clampPunchInOffsets(punchIn.x, punchIn.y, scale);

  return {
    id,
    time: Number(time.toFixed(3)),
    duration: Number(duration.toFixed(3)),
    scale: Number(scale.toFixed(3)),
    transition,
    transitionDuration: Number(transitionDuration.toFixed(3)),
    faceAnchored,
    x,
    y,
  };
}

/**
 * Generates an array of visual keyframes from a list of punch-ins on a clip.
 * Preserves existing non-punch-in keyframes (e.g. rotation, opacity, or user keyframes outside punch-in intervals).
 */
export function compilePunchInKeyframes(existingKeyframes = [], punchIns = [], clipDuration = 10) {
  const safeDuration = Math.max(0.1, Number(clipDuration) || 10);
  const normalizedPunchIns = (Array.isArray(punchIns) ? punchIns : [])
    .map((p) => normalizePunchIn(p, safeDuration))
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);

  // If no punch-ins, remove punch-in specific transform keyframes and return cleanly
  if (!normalizedPunchIns.length) {
    return (existingKeyframes || []).filter((kf) => !kf.isPunchIn);
  }

  // Collect non-punch-in existing keyframes
  const preservedFrames = (existingKeyframes || []).filter((kf) => !kf.isPunchIn);

  const generated = [];

  for (const pi of normalizedPunchIns) {
    const tStart = pi.time;
    const tEnd = Math.min(safeDuration, pi.time + pi.duration);
    const transDur = pi.transition === "smooth" ? pi.transitionDuration : 0.05;

    // 1. Pre-zoom keyframe (baseline scale 1, x: 0, y: 0)
    const tPre = Math.max(0, tStart - transDur);
    if (tPre >= 0 && Math.abs(tPre - tStart) > 0.01) {
      generated.push({
        time: Number(tPre.toFixed(3)),
        scale: 1,
        x: 0,
        y: 0,
        isPunchIn: true,
      });
    }

    // 2. Punch-in start keyframe (scale: S, x: X, y: Y)
    generated.push({
      time: Number(tStart.toFixed(3)),
      scale: pi.scale,
      x: pi.x,
      y: pi.y,
      isPunchIn: true,
    });

    // 3. Punch-in hold end keyframe (scale: S, x: X, y: Y)
    generated.push({
      time: Number(tEnd.toFixed(3)),
      scale: pi.scale,
      x: pi.x,
      y: pi.y,
      isPunchIn: true,
    });

    // 4. Post-zoom return keyframe (baseline scale 1, x: 0, y: 0)
    const tPost = Math.min(safeDuration, tEnd + transDur);
    if (tPost <= safeDuration && Math.abs(tPost - tEnd) > 0.01) {
      generated.push({
        time: Number(tPost.toFixed(3)),
        scale: 1,
        x: 0,
        y: 0,
        isPunchIn: true,
      });
    }
  }

  // Merge preserved frames with generated punch-in frames
  const allFrames = [...preservedFrames, ...generated]
    .filter((f) => Number.isFinite(f.time))
    .sort((a, b) => a.time - b.time);

  // Deduplicate and collapse keyframes closer than 0.04s
  const result = [];
  for (const frame of allFrames) {
    const prev = result.at(-1);
    if (!prev || Math.abs(prev.time - frame.time) > 0.04) {
      result.push(frame);
    } else {
      // Merge properties into previous
      result[result.length - 1] = { ...prev, ...frame };
    }
  }

  return result;
}

/**
 * Automatically discovers punch-in moments from caption/speech timing across the project.
 *
 * Rules:
 * - Uses caption segment start times.
 * - Minimum spacing between punch-ins (default 3s).
 * - Avoids intro (first 1s) and outro (last 1s) if possible.
 * - Fits within target visual clip bounds.
 * - Does not overlap or place punch-ins during silence.
 */
export function detectSpeechPunchInMoments(project, options = {}) {
  const visuals = Array.isArray(project?.visualSegments) ? project.visualSegments : [];
  if (!visuals.length) return [];

  const captions = Array.isArray(project?.captionSegments) ? project.captionSegments : [];
  const minSpacing = Math.max(1.5, Number(options.minSpacing) || SMART_ZOOM_DEFAULTS.minSpacing);
  const defaultDuration = Math.max(1.0, Number(options.duration) || SMART_ZOOM_DEFAULTS.duration);
  const scale = normalizePunchInScale(options.scale);
  const transition = normalizePunchInTransition(options.transition);
  const faceAnchored = Boolean(options.faceAnchored);

  // Compute visual clip timeline offsets
  let visualCursor = 0;
  const clipRanges = visuals.map((clip) => {
    const duration = Math.max(0.1, Number(clip.duration) || 0);
    const range = { clip, start: visualCursor, end: visualCursor + duration, duration };
    visualCursor += duration;
    return range;
  });

  const targetClipId = options.clipId;
  const candidateRanges = targetClipId && targetClipId !== "all"
    ? clipRanges.filter((r) => r.clip.id === targetClipId)
    : clipRanges;

  const moments = [];
  let lastMomentTime = -Infinity;

  if (captions.length > 0) {
    // Sort captions chronologically
    const sortedCaptions = [...captions]
      .filter((c) => Number.isFinite(Number(c.start)) && Number.isFinite(Number(c.end)))
      .sort((a, b) => a.start - b.start);

    for (const caption of sortedCaptions) {
      const capStart = Number(caption.start);
      if (capStart - lastMomentTime < minSpacing) continue;

      // Find which visual clip contains this caption
      const matchingRange = candidateRanges.find((r) => capStart >= r.start && capStart < r.end - 1.0);
      if (!matchingRange) continue;

      const clipLocalTime = capStart - matchingRange.start;
      // Skip if too close to the end of the clip
      if (clipLocalTime + 1.0 >= matchingRange.duration) continue;

      const duration = Math.min(defaultDuration, matchingRange.duration - clipLocalTime - 0.2);
      if (duration < SMART_ZOOM_DEFAULTS.minDuration) continue;

      const offset = resolvePunchInOffset({
        segment: matchingRange.clip,
        scale,
        faceAnchored,
        time: clipLocalTime,
      });

      moments.push({
        clipId: matchingRange.clip.id,
        time: Number(clipLocalTime.toFixed(3)),
        timelineTime: Number(capStart.toFixed(3)),
        duration: Number(duration.toFixed(3)),
        scale,
        transition,
        transitionDuration: options.transitionDuration || SMART_ZOOM_DEFAULTS.transitionDuration,
        faceAnchored,
        x: offset.x,
        y: offset.y,
      });

      lastMomentTime = capStart + duration;
    }
  } else {
    // Conservative fallback when no captions exist:
    // Place a tasteful punch-in on clips that are sufficiently long (> 4 seconds)
    for (const range of candidateRanges) {
      if (range.duration >= 4.5) {
        const clipLocalTime = Math.max(1.0, range.duration * 0.25);
        const duration = Math.min(defaultDuration, range.duration - clipLocalTime - 1.0);
        if (duration >= SMART_ZOOM_DEFAULTS.minDuration) {
          const offset = resolvePunchInOffset({
            segment: range.clip,
            scale,
            faceAnchored,
            time: clipLocalTime,
          });

          moments.push({
            clipId: range.clip.id,
            time: Number(clipLocalTime.toFixed(3)),
            timelineTime: Number((range.start + clipLocalTime).toFixed(3)),
            duration: Number(duration.toFixed(3)),
            scale,
            transition,
            transitionDuration: options.transitionDuration || SMART_ZOOM_DEFAULTS.transitionDuration,
            faceAnchored,
            x: offset.x,
            y: offset.y,
          });
        }
      }
    }
  }

  return moments;
}

/**
 * Inspects all active punch-ins across the project.
 */
export function inspectPunchIns(project, filterClipId = "") {
  const visuals = Array.isArray(project?.visualSegments) ? project.visualSegments : [];
  let visualCursor = 0;
  const allPunchIns = [];

  for (const clip of visuals) {
    const duration = Math.max(0.1, Number(clip.duration) || 0);
    const clipStart = visualCursor;
    visualCursor += duration;

    if (filterClipId && clip.id !== filterClipId) continue;

    const punchIns = Array.isArray(clip.punchIns) ? clip.punchIns : [];
    for (const pi of punchIns) {
      allPunchIns.push({
        clipId: clip.id,
        clipName: clip.name || "",
        punchInId: pi.id,
        time: pi.time,
        timelineTime: Number((clipStart + pi.time).toFixed(3)),
        duration: pi.duration,
        scale: pi.scale,
        transition: pi.transition,
        transitionDuration: pi.transitionDuration,
        faceAnchored: Boolean(pi.faceAnchored),
        x: pi.x || 0,
        y: pi.y || 0,
      });
    }
  }

  allPunchIns.sort((a, b) => a.timelineTime - b.timelineTime);

  return {
    count: allPunchIns.length,
    punchIns: allPunchIns,
  };
}

/**
 * Builds dynamic FFmpeg crop filter expression for a clip's punch-ins.
 * Returns empty string if no punch-ins exist, preserving untouched FFmpeg filter pipeline.
 */
export function buildSmartZoomCropFilter(punchIns = [], width = 1280, height = 720, clipDuration = 10) {
  if (!Array.isArray(punchIns) || !punchIns.length) return "";

  const validPunchIns = punchIns
    .map((p) => normalizePunchIn(p, clipDuration))
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);

  if (!validPunchIns.length) return "";

  const wTerms = [];
  const hTerms = [];
  const xTerms = [];
  const yTerms = [];

  for (const pi of validPunchIns) {
    const s = pi.scale;
    const dur = pi.duration;
    const tStart = pi.time;
    const tEnd = Math.min(clipDuration, tStart + dur);

    if (pi.transition === "smooth") {
      const transDur = pi.transitionDuration || 0.3;
      const tInStart = Math.max(0, tStart - transDur);
      const tOutEnd = Math.min(clipDuration, tEnd + transDur);

      // In push: tInStart <= t < tStart
      if (tStart > tInStart) {
        const inScale = `(1+(${s}-1)*(t-${tInStart.toFixed(3)})/${(tStart - tInStart).toFixed(3)})`;
        wTerms.push({ cond: `between(t,${tInStart.toFixed(3)},${tStart.toFixed(3)})`, expr: `${width}/${inScale}` });
        hTerms.push({ cond: `between(t,${tInStart.toFixed(3)},${tStart.toFixed(3)})`, expr: `${height}/${inScale}` });
        if (pi.x) xTerms.push({ cond: `between(t,${tInStart.toFixed(3)},${tStart.toFixed(3)})`, expr: `(${pi.x}*(t-${tInStart.toFixed(3)})/${(tStart - tInStart).toFixed(3)})` });
        if (pi.y) yTerms.push({ cond: `between(t,${tInStart.toFixed(3)},${tStart.toFixed(3)})`, expr: `(${pi.y}*(t-${tInStart.toFixed(3)})/${(tStart - tInStart).toFixed(3)})` });
      }

      // Hold: tStart <= t <= tEnd
      wTerms.push({ cond: `between(t,${tStart.toFixed(3)},${tEnd.toFixed(3)})`, expr: `${width}/${s}` });
      hTerms.push({ cond: `between(t,${tStart.toFixed(3)},${tEnd.toFixed(3)})`, expr: `${height}/${s}` });
      if (pi.x) xTerms.push({ cond: `between(t,${tStart.toFixed(3)},${tEnd.toFixed(3)})`, expr: `${pi.x}` });
      if (pi.y) yTerms.push({ cond: `between(t,${tStart.toFixed(3)},${tEnd.toFixed(3)})`, expr: `${pi.y}` });

      // Out pull: tEnd < t <= tOutEnd
      if (tOutEnd > tEnd) {
        const outScale = `(1+(${s}-1)*(${tOutEnd.toFixed(3)}-t)/${(tOutEnd - tEnd).toFixed(3)})`;
        wTerms.push({ cond: `between(t,${tEnd.toFixed(3)},${tOutEnd.toFixed(3)})`, expr: `${width}/${outScale}` });
        hTerms.push({ cond: `between(t,${tEnd.toFixed(3)},${tOutEnd.toFixed(3)})`, expr: `${height}/${outScale}` });
        if (pi.x) xTerms.push({ cond: `between(t,${tEnd.toFixed(3)},${tOutEnd.toFixed(3)})`, expr: `(${pi.x}*(${tOutEnd.toFixed(3)}-t)/${(tOutEnd - tEnd).toFixed(3)})` });
        if (pi.y) yTerms.push({ cond: `between(t,${tEnd.toFixed(3)},${tOutEnd.toFixed(3)})`, expr: `(${pi.y}*(${tOutEnd.toFixed(3)}-t)/${(tOutEnd - tEnd).toFixed(3)})` });
      }
    } else {
      // Jump cut
      wTerms.push({ cond: `between(t,${tStart.toFixed(3)},${tEnd.toFixed(3)})`, expr: `${width}/${s}` });
      hTerms.push({ cond: `between(t,${tStart.toFixed(3)},${tEnd.toFixed(3)})`, expr: `${height}/${s}` });
      if (pi.x) xTerms.push({ cond: `between(t,${tStart.toFixed(3)},${tEnd.toFixed(3)})`, expr: `${pi.x}` });
      if (pi.y) yTerms.push({ cond: `between(t,${tStart.toFixed(3)},${tEnd.toFixed(3)})`, expr: `${pi.y}` });
    }
  }

  const buildNestedIf = (terms, defaultVal) => {
    let result = String(defaultVal);
    for (let i = terms.length - 1; i >= 0; i--) {
      result = `if(${terms[i].cond},${terms[i].expr},${result})`;
    }
    return result;
  };

  const wExpr = buildNestedIf(wTerms, width);
  const hExpr = buildNestedIf(hTerms, height);
  const xPctExpr = xTerms.length ? buildNestedIf(xTerms, "0") : "0";
  const yPctExpr = yTerms.length ? buildNestedIf(yTerms, "0") : "0";

  const xExpr = xTerms.length
    ? `min(max(0,(${width}-out_w)/2-(${xPctExpr}/100)*${width}),${width}-out_w)`
    : `(${width}-out_w)/2`;
  const yExpr = yTerms.length
    ? `min(max(0,(${height}-out_h)/2-(${yPctExpr}/100)*${height}),${height}-out_h)`
    : `(${height}-out_h)/2`;

  return `crop=w='${wExpr}':h='${hExpr}':x='${xExpr}':y='${yExpr}':exact=1,scale=${width}:${height},`;
}
