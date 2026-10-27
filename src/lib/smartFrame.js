import { selectPrimaryFace, extractSpeechIntervals, isSpeechActiveAtTime } from "./shortsReframing.js";

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, Number(value) || 0));

export const SMART_FRAME_VERSION = 2;
export const SMART_FRAME_MOTIONS = Object.freeze({
  locked: { smoothing: 0.12, tolerance: 0.018 },
  smooth: { smoothing: 0.24, tolerance: 0.011 },
  responsive: { smoothing: 0.46, tolerance: 0.006 },
});

function normalizeBox(box) {
  if (!box) return null;
  const xMin = clamp(box.xMin ?? box.xmin);
  const yMin = clamp(box.yMin ?? box.ymin);
  const xMax = clamp(box.xMax ?? box.xmax);
  const yMax = clamp(box.yMax ?? box.ymax);
  if (xMax - xMin < 0.01 || yMax - yMin < 0.01) return null;
  return { xMin, yMin, xMax, yMax };
}

function normalizeSubject(subject) {
  const box = normalizeBox(subject?.box ?? subject);
  if (!box) return null;
  return {
    box,
    face: normalizeBox(subject?.face?.box ?? subject?.face),
    label: String(subject?.label || "object").toLowerCase(),
    score: clamp(subject?.score ?? 0),
  };
}

function inferHeadBox(subject) {
  if (!subject?.box || subject.label !== "person") return null;
  const box = subject.box;
  const width = box.xMax - box.xMin;
  const height = box.yMax - box.yMin;
  const centerX = (box.xMin + box.xMax) / 2;
  const headWidth = Math.max(width * 0.45, Math.min(width, height * 0.28));
  const headHeight = Math.min(height * 0.28, Math.max(0.08, height * 0.22));
  return normalizeBox({
    xMin: centerX - headWidth / 2,
    xMax: centerX + headWidth / 2,
    yMin: box.yMin,
    yMax: Math.min(box.yMax, box.yMin + headHeight),
  });
}

function getCompositionGuide(subjectInput) {
  const subject = normalizeSubject(subjectInput);
  if (!subject) return null;
  const head = subject.face || inferHeadBox(subject);
  const focus = head || subject.box;
  return {
    subject,
    head,
    focusX: (focus.xMin + focus.xMax) / 2,
    focusY: (focus.yMin + focus.yMax) / 2,
  };
}

function normalizeCrop(crop) {
  if (!crop) return null;
  const width = clamp(crop.width, 0.01, 1);
  const height = clamp(crop.height, 0.01, 1);
  return {
    x: clamp(crop.x, 0, 1 - width),
    y: clamp(crop.y, 0, 1 - height),
    width,
    height,
  };
}

function getLargestCrop(sourceSize, targetSize) {
  const sourceAspect = Math.max(0.01, Number(sourceSize?.width) || 1) / Math.max(0.01, Number(sourceSize?.height) || 1);
  const targetAspect = Math.max(0.01, Number(targetSize?.width) || 1) / Math.max(0.01, Number(targetSize?.height) || 1);
  const normalizedAspect = targetAspect / sourceAspect;
  if (normalizedAspect <= 1) return { width: normalizedAspect, height: 1 };
  return { width: 1, height: 1 / normalizedAspect };
}

function needsSmartStage(sourceSize, targetSize, subjectInput) {
  const guide = getCompositionGuide(subjectInput);
  if (!guide?.head || guide.subject.label !== "person") return false;
  const largest = getLargestCrop(sourceSize, targetSize);
  const headWidth = guide.head.xMax - guide.head.xMin;
  const headHeight = guide.head.yMax - guide.head.yMin;
  const subjectHeight = guide.subject.box.yMax - guide.subject.box.yMin;
  // Head estimates from a body detector do not include every hairstyle or piece
  // of headwear. Protect the complete person too when a wide target discards so
  // much source height that a subject-filling shot cannot be composed safely.
  const fullPersonNeedsStage = largest.height < 0.75 && subjectHeight > largest.height * 0.94;
  return fullPersonNeedsStage
    || headWidth > largest.width * 0.88
    || headHeight > largest.height * 0.6;
}

export function solveSmartFrameCrop(sourceSize, targetSize, subjectBox, options = {}) {
  const guide = getCompositionGuide(subjectBox);
  const subject = guide?.subject.box;
  const largest = getLargestCrop(sourceSize, targetSize);
  if (!subject) return { x: (1 - largest.width) / 2, y: (1 - largest.height) / 2, ...largest };

  const padding = clamp(options.padding ?? 0.16, 0.04, 0.4);
  const requestedMaxZoom = Math.max(1, Math.min(2, Number(options.maxZoom) || 1.45));
  const normalizedAspect = largest.width / largest.height;
  const subjectWidth = subject.xMax - subject.xMin;
  const subjectHeight = subject.yMax - subject.yMin;
  const headHeight = guide.head ? guide.head.yMax - guide.head.yMin : 0;
  const shot = headHeight > 0.3
    ? "close"
    : subjectHeight >= 0.68 ? "full" : subjectHeight >= 0.38 ? "medium" : "wide";
  const desiredHeightOccupancy = shot === "close" ? 0.78 : shot === "full" ? 0.86 : shot === "medium" ? 0.72 : 0.62;
  const desiredWidthOccupancy = shot === "close" ? 0.72 : 0.78;
  const paddedHeightOccupancy = Math.max(0.48, desiredHeightOccupancy - padding * 0.22);
  const paddedWidthOccupancy = Math.max(0.5, desiredWidthOccupancy - padding * 0.18);
  const shotZoomLimit = shot === "close" ? 1.08 : shot === "full" ? 1.2 : shot === "medium" ? 1.35 : 1.55;
  const maxZoom = Math.min(requestedMaxZoom, shotZoomLimit);

  let height = Math.max(
    largest.height / maxZoom,
    subjectHeight / paddedHeightOccupancy,
    (subjectWidth / paddedWidthOccupancy) / normalizedAspect,
  );

  // In narrow vertical reframing (e.g. 9:16 target where normalizedAspect < 0.6):
  // The source frame width is already discarded by ~68%. Over-zooming creates an excessively tight,
  // claustrophobic crop that slices off shoulders and ears. Prevent height from shrinking below 0.95
  // unless explicit forceTightZoom is requested.
  if (normalizedAspect < 0.65 && !options.forceTightZoom) {
    const minSafePortraitHeight = Math.max(0.92, subjectHeight / paddedHeightOccupancy);
    height = Math.max(height, minSafePortraitHeight);
  }

  let width = height * normalizedAspect;
  if (width > largest.width || height > largest.height) {
    width = largest.width;
    height = largest.height;
  }

  const crop = normalizeCrop({
    x: guide.focusX - width / 2 + (Number(options.leadX) || 0),
    // Anchor a person shot from the protected head top with natural headroom.
    y: guide.head ? Math.max(0, guide.head.yMin - height * 0.055) : guide.focusY - height / 2,
    width,
    height,
  });
  return keepSubjectInside(crop, guide.subject);
}

function keepSubjectInside(crop, subjectBox, margin = 0.08) {
  const guide = getCompositionGuide(subjectBox);
  const subject = guide?.subject.box;
  if (!guide || !subject) return crop;
  const next = { ...crop };
  const subjectWidth = subject.xMax - subject.xMin;
  const subjectHeight = subject.yMax - subject.yMin;
  const marginX = next.width * margin;
  const marginY = next.height * margin;

  if (subjectWidth + marginX * 2 <= next.width) {
    if (subject.xMin < next.x + marginX) next.x = subject.xMin - marginX;
    if (subject.xMax > next.x + next.width - marginX) next.x = subject.xMax - next.width + marginX;
  } else {
    // When subject is wider than crop (e.g. multi-person span), anchor on head focus rather than empty midpoint
    if (guide.head) {
      next.x = (guide.head.xMin + guide.head.xMax) / 2 - next.width / 2;
    } else {
      next.x = guide.focusX - next.width / 2;
    }
  }

  if (subjectHeight + marginY * 2 <= next.height) {
    if (subject.yMin < next.y + marginY) next.y = subject.yMin - marginY;
    if (subject.yMax > next.y + next.height - marginY) next.y = subject.yMax - next.height + marginY;
  }

  const protectedHead = guide.head;
  if (protectedHead) {
    const headMarginX = Math.min(next.width * 0.08, Math.max(0, (next.width - (protectedHead.xMax - protectedHead.xMin)) / 2));
    const headMarginY = Math.min(next.height * 0.08, Math.max(0, (next.height - (protectedHead.yMax - protectedHead.yMin)) / 2));
    const headWidth = protectedHead.xMax - protectedHead.xMin;
    const headHeight = protectedHead.yMax - protectedHead.yMin;
    if (headWidth + headMarginX * 2 <= next.width) {
      if (protectedHead.xMin < next.x + headMarginX) next.x = protectedHead.xMin - headMarginX;
      if (protectedHead.xMax > next.x + next.width - headMarginX) next.x = protectedHead.xMax - next.width + headMarginX;
    } else {
      next.x = (protectedHead.xMin + protectedHead.xMax) / 2 - next.width / 2;
    }
    if (headHeight + headMarginY * 2 <= next.height) {
      if (protectedHead.yMin < next.y + headMarginY) next.y = protectedHead.yMin - headMarginY;
      if (protectedHead.yMax > next.y + next.height - headMarginY) next.y = protectedHead.yMax - next.height + headMarginY;
    } else {
      next.y = protectedHead.yMin - next.height * 0.055;
    }
  }
  next.x = clamp(next.x, 0, 1 - next.width);
  next.y = clamp(next.y, 0, 1 - next.height);
  return normalizeCrop(next);
}

function smoothPass(frames, amount, reverse = false) {
  const output = frames.map((frame) => ({ ...frame, crop: { ...frame.crop } }));
  const indexes = reverse
    ? Array.from({ length: output.length - 1 }, (_, index) => output.length - 2 - index)
    : Array.from({ length: output.length - 1 }, (_, index) => index + 1);
  indexes.forEach((index) => {
    const previous = output[index + (reverse ? 1 : -1)];
    const current = output[index];
    const deadX = previous.crop.width * 0.025;
    const deadY = previous.crop.height * 0.025;
    const isCut = Boolean(current.isCut || current.cut || Math.abs(current.crop.x - previous.crop.x) > 0.22);
    if (isCut) {
      current.isCut = true;
      current.cut = true;
      return;
    }
    ["x", "y", "width", "height"].forEach((key) => {
      const delta = current.crop[key] - previous.crop[key];
      const dead = key === "x" ? deadX : key === "y" ? deadY : 0.002;
      current.crop[key] = previous.crop[key] + (Math.abs(delta) <= dead ? 0 : delta * amount);
    });
    current.crop = keepSubjectInside(normalizeCrop(current.crop), current.subject);
  });
  return output;
}

function frameDistance(frame, start, end) {
  const span = Math.max(0.0001, end.time - start.time);
  const mix = clamp((frame.time - start.time) / span);
  return ["x", "y", "width", "height"].reduce((maximum, key) => {
    const expected = start.crop[key] + (end.crop[key] - start.crop[key]) * mix;
    return Math.max(maximum, Math.abs(frame.crop[key] - expected));
  }, 0);
}

function compressFrames(frames, tolerance) {
  if (frames.length <= 2) return frames;
  const keep = new Set([0, frames.length - 1]);
  // Always preserve shot cuts and transitions
  frames.forEach((frame, idx) => {
    if (frame.isCut || frame.cut || frames[idx + 1]?.isCut || frames[idx + 1]?.cut) {
      keep.add(idx);
    }
  });
  const visit = (startIndex, endIndex) => {
    let maximum = 0;
    let maximumIndex = -1;
    for (let index = startIndex + 1; index < endIndex; index += 1) {
      const distance = frameDistance(frames[index], frames[startIndex], frames[endIndex]);
      if (distance > maximum) {
        maximum = distance;
        maximumIndex = index;
      }
    }
    if (maximumIndex < 0 || maximum <= tolerance) return;
    keep.add(maximumIndex);
    visit(startIndex, maximumIndex);
    visit(maximumIndex, endIndex);
  };
  visit(0, frames.length - 1);
  return [...keep].sort((left, right) => left - right).map((index) => frames[index]);
}

export function buildSmartFrameRecord({
  samples,
  sourceSize,
  targetSize,
  targetRatio,
  segment,
  settings = {},
  modelRevision = "",
  runtimeBackend = "unknown",
  analysisMs = 0,
}) {
  const motion = SMART_FRAME_MOTIONS[settings.motion] ? settings.motion : "smooth";
  const motionConfig = SMART_FRAME_MOTIONS[motion];
  const speechIntervals = extractSpeechIntervals({
    speechIntervals: segment?.speechIntervals,
    sentences: segment?.sentences,
    captionSegments: segment?.captionSegments,
  });

  const rawSamples = (Array.isArray(samples) ? samples : [])
    .filter((sample) => Number.isFinite(Number(sample?.time)))
    .map((sample) => ({
      time: Math.max(0, Number(sample.time)),
      subject: normalizeSubject(sample.subject),
      confidence: clamp(sample.subject?.score ?? sample.confidence ?? 0),
      state: sample.state || (sample.subject ? "tracked" : "lost"),
      source: sample.source || "detector",
      faces: Array.isArray(sample.faces) ? sample.faces : (sample.subject?.face ? [sample.subject.face] : []),
      subjects: Array.isArray(sample.subjects) ? sample.subjects : (sample.subject ? [sample.subject] : []),
    }))
    .sort((left, right) => left.time - right.time);
  let lastAcceptedSubject = null;
  const prepared = rawSamples.map((sample, index) => {
    let currentSubject = sample.subject;
    const candidates = Array.isArray(sample.faces) && sample.faces.length > 0
      ? sample.faces
      : (Array.isArray(sample.subjects) && sample.subjects.length > 0 ? sample.subjects : (sample.subject ? [sample.subject] : []));

    if (candidates.length > 1) {
      const isSpeechActive = isSpeechActiveAtTime(sample.time, speechIntervals);
      const selected = selectPrimaryFace(candidates, lastAcceptedSubject?.box || null, {
        sourceSize,
        time: sample.time,
        isSpeechActive,
        targetRatio,
      });
      if (selected) {
        currentSubject = normalizeSubject({ box: selected, label: selected.label || "person", score: selected.confidence ?? 0.9 });
      }
    }

    if (currentSubject) lastAcceptedSubject = currentSubject;
    const previousSubject = rawSamples[Math.max(0, index - 1)]?.subject;
    const activeSubject = currentSubject || lastAcceptedSubject;
    const previousCenterX = previousSubject
      ? (previousSubject.box.xMin + previousSubject.box.xMax) / 2
      : activeSubject ? (activeSubject.box.xMin + activeSubject.box.xMax) / 2 : 0.5;
    const currentCenterX = activeSubject
      ? (activeSubject.box.xMin + activeSubject.box.xMax) / 2
      : previousCenterX;
    const leadX = clamp((currentCenterX - previousCenterX) * 0.35, -0.055, 0.055);
    return {
      ...sample,
      crop: solveSmartFrameCrop(sourceSize, targetSize, activeSubject, { ...settings, leadX }),
    };
  });
  if (!prepared.length) throw new Error("没有可用于智能构图的主体轨迹");

  const forward = smoothPass(prepared, motionConfig.smoothing, false);
  const smoothed = smoothPass(forward, Math.min(0.7, motionConfig.smoothing * 1.35), true);
  const compressed = compressFrames(smoothed, motionConfig.tolerance);
  const personFrames = prepared.filter((frame) => frame.subject?.label === "person");
  const smartStageFrames = personFrames.filter((frame) => needsSmartStage(sourceSize, targetSize, frame.subject));
  const presentation = personFrames.length && smartStageFrames.length / personFrames.length >= 0.3
    ? "safe-contain"
    : "crop";
  return normalizeSmartFrame({
    version: SMART_FRAME_VERSION,
    enabled: true,
    targetRatio,
    presentation,
    settings: {
      motion,
      padding: clamp(settings.padding ?? 0.16, 0.04, 0.4),
      maxZoom: Math.max(1, Math.min(2, Number(settings.maxZoom) || 1.45)),
    },
    sourceSize,
    sourceSignature: {
      assetId: segment?.assetId || segment?.id || "",
      sourceStart: Math.max(0, Number(segment?.sourceStart) || 0),
      sourceDuration: Math.max(0, Number(segment?.sourceDuration) || Number(segment?.duration) || 0),
      playbackRate: Math.max(0.25, Math.min(4, Number(segment?.playbackRate) || 1)),
      modelRevision,
    },
    analysisTrack: {
      samples: rawSamples,
      sourceSize,
      modelRevision,
      runtimeBackend,
      analysisMs: Math.max(0, Number(analysisMs) || 0),
    },
    stats: {
      sampleCount: prepared.length,
      anchorCount: prepared.filter((sample) => sample.source === "detector").length,
      flowCount: prepared.filter((sample) => sample.source === "flow").length,
      lostCount: prepared.filter((sample) => sample.state === "lost").length,
      runtimeBackend: runtimeBackend === "webgpu" ? "webgpu" : runtimeBackend === "wasm" ? "wasm" : "unknown",
      analysisMs: Math.max(0, Number(analysisMs) || 0),
    },
    cropKeyframes: compressed.map((frame) => ({
      time: frame.time,
      ...frame.crop,
      confidence: frame.confidence,
      state: frame.state,
      isCut: Boolean(frame.isCut || frame.cut),
      cut: Boolean(frame.isCut || frame.cut),
    })),
  });
}

export function normalizeSmartFrame(value) {
  const target = value?.cropKeyframes ? value : (value?.smartFrame?.cropKeyframes ? value.smartFrame : (value?.visualEffects?.smartFrame?.cropKeyframes ? value.visualEffects.smartFrame : value));
  if (!target || target.enabled === false || !Array.isArray(target.cropKeyframes) || !target.cropKeyframes.length) return null;
  const isFallback = Boolean(
    target.isFallback ||
    target.metadata?.isFallback ||
    target.metadata?.status === "fallback" ||
    target.state === "fallback" ||
    (target.cropKeyframes.length > 0 && target.cropKeyframes.every((f) => f.state === "fallback" || f.isFallback || f.confidence === 0)) ||
    (target.cropKeyframes.length <= 2 && target.cropKeyframes.every((f) => (f.confidence ?? 0) <= 0.5 && Math.abs((f.panFactor ?? 0.5) - 0.5) < 0.01))
  );
  const state = isFallback ? "fallback" : (target.state || "tracked");

  const cropKeyframes = target.cropKeyframes
    .map((frame) => ({
      time: Math.max(0, Number(frame.time) || 0),
      ...normalizeCrop(frame),
      confidence: isFallback ? 0 : clamp(frame.confidence ?? 0),
      state: isFallback ? "fallback" : (frame.state || state),
      isFallback,
      cut: Boolean(frame.cut || frame.isCut),
      isCut: Boolean(frame.cut || frame.isCut),
      ...(Number.isFinite(frame.panFactor) ? { panFactor: frame.panFactor } : {}),
    }))
    .sort((left, right) => left.time - right.time);
  const storedVersion = Math.max(1, Number(target.version) || 1);
  const analysisSamples = (Array.isArray(target.analysisTrack?.samples) ? target.analysisTrack.samples : [])
    .filter((sample) => Number.isFinite(Number(sample?.time)))
    .map((sample) => ({
      time: Math.max(0, Number(sample.time)),
      subject: normalizeSubject(sample.subject),
      confidence: clamp(sample.subject?.score ?? sample.confidence ?? 0),
      state: sample.state || (sample.subject ? "tracked" : "lost"),
      source: sample.source || "detector",
    }))
    .sort((left, right) => left.time - right.time);
  return {
    version: SMART_FRAME_VERSION,
    enabled: true,
    isFallback,
    state,
    confidence: isFallback ? 0 : clamp(target.confidence ?? 1),
    metadata: target.metadata || (isFallback ? { status: "fallback", isFallback: true } : {}),
    targetRatio: String(target.targetRatio || "16:9"),
    presentation: storedVersion >= 2 && target.presentation === "safe-contain" ? "safe-contain" : "crop",
    settings: {
      motion: SMART_FRAME_MOTIONS[target.settings?.motion] ? target.settings.motion : "smooth",
      padding: clamp(target.settings?.padding ?? 0.16, 0.04, 0.4),
      maxZoom: storedVersion < 2 ? 1.45 : Math.max(1, Math.min(2, Number(target.settings?.maxZoom) || 1.45)),
    },
    sourceSize: {
      width: Math.max(1, Number(target.sourceSize?.width) || 1),
      height: Math.max(1, Number(target.sourceSize?.height) || 1),
    },
    sourceSignature: target.sourceSignature || {},
    stats: target.stats || {},
    analysisTrack: analysisSamples.length ? {
      samples: analysisSamples,
      sourceSize: {
        width: Math.max(1, Number(target.analysisTrack?.sourceSize?.width) || Number(target.sourceSize?.width) || 1),
        height: Math.max(1, Number(target.analysisTrack?.sourceSize?.height) || Number(target.sourceSize?.height) || 1),
      },
      modelRevision: String(target.analysisTrack?.modelRevision || target.sourceSignature?.modelRevision || ""),
      runtimeBackend: String(target.analysisTrack?.runtimeBackend || target.stats?.runtimeBackend || "unknown"),
      analysisMs: Math.max(0, Number(target.analysisTrack?.analysisMs) || Number(target.stats?.analysisMs) || 0),
    } : null,
    cropKeyframes,
  };
}

export function resolveSmartFrameCropAtTime(value, requestedTime = 0) {
  const smartFrame = normalizeSmartFrame(value);
  if (!smartFrame) return null;
  const rawTime = Math.max(0, Number(requestedTime) || 0);
  const frames = smartFrame.cropKeyframes;
  if (!Array.isArray(frames) || frames.length === 0) return null;
  const isFallback = Boolean(smartFrame.isFallback || smartFrame.metadata?.status === "fallback" || smartFrame.state === "fallback");
  const state = isFallback ? "fallback" : (smartFrame.state || "tracked");

  let time = rawTime;
  const firstTime = frames[0].time;
  const lastTime = frames.at(-1).time;
  const trackSpan = lastTime - firstTime;
  const sourceStart = Number(smartFrame.sourceSignature?.sourceStart ?? smartFrame.sourceStart ?? 0);

  // If keyframes are relative to 0 ([0, duration]) but requestedTime was passed in source time (>= sourceStart)
  if (firstTime === 0 && sourceStart > 0 && time >= sourceStart - 0.2) {
    time = time - sourceStart;
  } else if (firstTime > 0 && time < firstTime && (sourceStart === 0 || Math.abs(firstTime - sourceStart) < 0.5)) {
    // Keyframes are in source time ([sourceStart, sourceEnd]) but requestedTime was passed in local time ([0, duration])
    if (time <= trackSpan + 0.5) {
      time = time + firstTime;
    }
  }

  const toPanFactor = (c, origKf) => {
    if (origKf && Number.isFinite(origKf.panFactor)) return origKf.panFactor;
    if (!c) return 0.5;
    return (1 - c.width) > 0.0001 ? Number((c.x / (1 - c.width)).toFixed(4)) : 0.5;
  };

  if (time <= frames[0].time) {
    const norm = normalizeCrop(frames[0]);
    return {
      ...norm,
      panFactor: toPanFactor(norm, frames[0]),
      presentation: smartFrame.presentation,
      isFallback,
      state,
      confidence: frames[0].confidence ?? (isFallback ? 0 : 1),
    };
  }
  if (time >= frames.at(-1).time) {
    const last = frames.at(-1);
    const norm = normalizeCrop(last);
    return {
      ...norm,
      panFactor: toPanFactor(norm, last),
      presentation: smartFrame.presentation,
      isFallback,
      state,
      confidence: last.confidence ?? (isFallback ? 0 : 1),
    };
  }
  const nextIndex = frames.findIndex((frame) => frame.time >= time);
  const previous = frames[Math.max(0, nextIndex - 1)];
  const next = frames[nextIndex];

  // If next keyframe represents a camera shot change or subject cut,
  // do not interpolate across the boundary: hold previous until next.time
  if (next.cut || next.isCut) {
    if (time < next.time) {
      const norm = normalizeCrop(previous);
      return {
        ...norm,
        panFactor: toPanFactor(norm, previous),
        presentation: smartFrame.presentation,
        isFallback,
        state: previous.state || state,
        confidence: previous.confidence !== undefined ? previous.confidence : (isFallback ? 0 : 1),
      };
    }
    const norm = normalizeCrop(next);
    return {
      ...norm,
      panFactor: toPanFactor(norm, next),
      presentation: smartFrame.presentation,
      isFallback,
      state: next.state || state,
      confidence: next.confidence !== undefined ? next.confidence : (isFallback ? 0 : 1),
    };
  }

  const mix = clamp((time - previous.time) / Math.max(0.0001, next.time - previous.time));
  const interpolated = normalizeCrop({
    x: previous.x + (next.x - previous.x) * mix,
    y: previous.y + (next.y - previous.y) * mix,
    width: previous.width + (next.width - previous.width) * mix,
    height: previous.height + (next.height - previous.height) * mix,
  });
  return {
    ...interpolated,
    panFactor: toPanFactor(interpolated),
    presentation: smartFrame.presentation,
    isFallback,
    state: (previous.state === "coast" || next.state === "coast") ? "coast" : (previous.state || state),
    confidence: previous.confidence !== undefined ? previous.confidence : (isFallback ? 0 : 1),
  };
}

export function smartFrameCropToPixels(crop, sourceSize) {
  const normalized = normalizeCrop(crop);
  if (!normalized) return null;
  const width = Math.max(1, Number(sourceSize?.width) || 1);
  const height = Math.max(1, Number(sourceSize?.height) || 1);
  return {
    x: normalized.x * width,
    y: normalized.y * height,
    width: normalized.width * width,
    height: normalized.height * height,
    normalized: {
      xMin: normalized.x,
      yMin: normalized.y,
      xMax: normalized.x + normalized.width,
      yMax: normalized.y + normalized.height,
      width: normalized.width,
      height: normalized.height,
    },
    presentation: crop?.presentation === "safe-contain" ? "safe-contain" : "crop",
    isFallback: Boolean(crop?.isFallback || crop?.state === "fallback"),
    state: crop?.state || "tracked",
    confidence: crop?.confidence ?? 1,
  };
}
