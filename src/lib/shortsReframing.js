/**
 * @file shortsReframing.js
 * AI Shorts Studio Phase 2 Priority 2: Smart Face-Tracking and Dynamic Reframing.
 *
 * Implements a robust, resource-conscious automatic reframing pipeline:
 * - Selects sensible target subject when single or multiple faces are detected
 * - Uses timestamps to associate detections with correct frames
 * - Smooths crop movement with deadband and EMA to avoid camera jitter
 * - Handles scene cuts with instantaneous angle switches rather than cross-cut pans
 * - Handles occlusions / missing detections with coasting and gentle centering
 * - Strictly respects target aspect ratios (9:16, 1:1, 16:9) and valid crop boundaries
 * - Provides safe fallback to static / manual crop when detections are missing or fail
 * - Integrates with browser preview, offline WebCodecs export, and FFmpeg render plan
 * - Preserves manual user adjustments (cropX offsets)
 */

import { normalizeSmartFrame } from "./smartFrame.js";

const clamp = (val, min = 0, max = 1) => Math.max(min, Math.min(max, Number(val) || 0));

export const REFRAMING_ASPECT_RATIOS = Object.freeze({
  "9:16": { width: 9, height: 16, ratio: 9 / 16 },
  "1:1": { width: 1, height: 1, ratio: 1.0 },
  "4:5": { width: 4, height: 5, ratio: 4 / 5 },
  "16:9": { width: 16, height: 9, ratio: 16 / 9 },
});

export const REFRAMING_MOTIONS = Object.freeze({
  locked: { smoothing: 0.12, deadband: 0.035, maxVelocity: 0.6 },
  smooth: { smoothing: 0.25, deadband: 0.020, maxVelocity: 1.0 },
  responsive: { smoothing: 0.45, deadband: 0.010, maxVelocity: 1.5 },
});

export const NON_PERSON_LABELS = new Set([
  "vase", "chair", "table", "dining table", "cabinet", "cup", "bottle", "couch", "sofa",
  "plant", "potted plant", "tv", "tvmonitor", "laptop", "book", "clock", "bed", "furniture",
  "background", "desk", "shelf", "wardrobe", "door", "window", "curtain", "lamp", "wall",
  "car", "vehicle", "bicycle", "motorcycle", "airplane", "bus", "train", "truck", "boat",
  "dog", "cat", "bird", "horse", "sheep", "cow", "cell phone", "keyboard", "mouse", "sink",
  "refrigerator", "microwave", "oven", "toaster", "plate", "bowl"
]);

/**
 * Checks whether a bounding box represents a genuine face/person detection rather than
 * a full-viewport crop box (e.g. 9:16 crop window of width ~0.3164 and height 1.0).
 */
export function isGenuineFaceBox(box) {
  if (!box || typeof box !== "object") return false;
  if (box.panFactor !== undefined || box.cropX !== undefined || box.cropW !== undefined) return false;
  if (box.isCropKeyframe === true || box.isFallback === true) return false;

  const candidate = box.face?.box ?? box.face?.boundingBox ?? box.face ?? box.box ?? box.boundingBox ?? box;
  if (!candidate || typeof candidate !== "object") return false;
  if (candidate.panFactor !== undefined || candidate.cropX !== undefined || candidate.cropW !== undefined) return false;

  const rawLabel = String(box.label || candidate.label || "").toLowerCase().trim();
  if (NON_PERSON_LABELS.has(rawLabel)) return false;

  // Non-empty label must represent a genuine person or face
  if (
    rawLabel !== "" &&
    rawLabel !== "person" &&
    rawLabel !== "face" &&
    rawLabel !== "human" &&
    rawLabel !== "speaker" &&
    rawLabel !== "subject" &&
    rawLabel !== "actor" &&
    !rawLabel.includes("person") &&
    !rawLabel.includes("face") &&
    !rawLabel.includes("speaker") &&
    !rawLabel.includes("subject") &&
    !rawLabel.includes("actor")
  ) {
    return false;
  }

  // Check if candidate is an already-solved full-height crop viewport ([0, 1] with yMin ~ 0, h ~ 1)
  const rawH = candidate.height ?? (candidate.yMax !== undefined && candidate.yMin !== undefined ? candidate.yMax - candidate.yMin : undefined);
  const rawW = candidate.width ?? (candidate.xMax !== undefined && candidate.xMin !== undefined ? candidate.xMax - candidate.xMin : undefined);
  const rawY = candidate.yMin ?? candidate.y;
  if (rawH !== undefined) {
    const numH = Number(rawH);
    const numY = Number(rawY ?? 0);
    const numW = rawW !== undefined ? Number(rawW) : undefined;
    if (numH >= 0.95 && numY <= 0.05) return false;
    if (numH >= 0.88 && numW !== undefined && numW <= 0.55 && !rawLabel.includes("person")) return false;
  }

  return true;
}

/**
 * Checks whether an object represents a genuine face or person detection rather than
 * a solved crop viewport keyframe or fallback record.
 */
export function isGenuineFaceDetection(item) {
  if (!item || typeof item !== "object") return false;

  // Explicit crop keyframes or viewport representations
  if (
    item.panFactor !== undefined ||
    item.cropX !== undefined ||
    item.cropW !== undefined ||
    item.cropKeyframes !== undefined ||
    item.isCropKeyframe === true ||
    (item.crop && typeof item.crop === "object" && item.crop.width !== undefined)
  ) {
    if (!item.faces && !item.face && !item.subject) {
      return false;
    }
  }

  // Reject fallback records without actual faces
  if (item.isFallback === true || item.state === "fallback" || item.status === "fallback") {
    if (!item.faces && !item.face && !item.subject) {
      return false;
    }
  }

  if (Array.isArray(item.faces)) {
    return item.faces.length > 0 && item.faces.some((f) => isGenuineFaceBox(f));
  }
  if (item.subject) {
    return isGenuineFaceBox(item.subject.face ?? item.subject.box ?? item.subject);
  }
  if (item.face) {
    return isGenuineFaceBox(item.face.box ?? item.face);
  }
  if (item.box) {
    return isGenuineFaceBox(item.box);
  }

  return isGenuineFaceBox(item);
}

/**
 * Extracts only genuine face/person detections from a media source object or candidate.
 * Strictly ignores crop keyframes, fallback records, and full-viewport crop boxes.
 */
export function extractGenuineFaceDetections(source) {
  if (!source) return [];
  if (Array.isArray(source)) {
    return source.filter(isGenuineFaceDetection);
  }
  if (typeof source !== "object") return [];

  // 1. Explicit faceDetections array
  if (Array.isArray(source.faceDetections) && source.faceDetections.length > 0) {
    const valid = source.faceDetections.filter(isGenuineFaceDetection);
    if (valid.length > 0) return valid;
  }

  // 2. Vision faces
  if (Array.isArray(source.vision?.faces) && source.vision.faces.length > 0) {
    const valid = source.vision.faces.filter(isGenuineFaceDetection);
    if (valid.length > 0) return valid;
  }

  // 3. Smart frame detections (only if they contain real face boxes, not crop keyframes)
  if (Array.isArray(source.smartFrame?.detections) && source.smartFrame.detections.length > 0) {
    const valid = source.smartFrame.detections.filter(isGenuineFaceDetection);
    if (valid.length > 0) return valid;
  }
  if (Array.isArray(source.visualEffects?.smartFrame?.detections) && source.visualEffects.smartFrame.detections.length > 0) {
    const valid = source.visualEffects.smartFrame.detections.filter(isGenuineFaceDetection);
    if (valid.length > 0) return valid;
  }

  // 4. Analysis track samples (from smartFrameAnalysis)
  const analysisSamples = source.smartFrame?.analysisTrack?.samples || source.visualEffects?.smartFrame?.analysisTrack?.samples;
  if (Array.isArray(analysisSamples) && analysisSamples.length > 0) {
    const valid = analysisSamples
      .filter((s) => s && s.subject?.box && s.state !== "lost")
      .map((s) => ({
        time: s.time,
        faces: s.subject.face ? [s.subject.face] : (s.subject.box ? [{ ...s.subject.box, label: s.subject.label || "person" }] : []),
      }))
      .filter((d) => d.faces.length > 0);
    if (valid.length > 0) return valid;
  }

  return [];
}

/**
 * Normalizes a bounding box into 0..1 coordinates.
 * Accepts normalized [0, 1] boxes or absolute pixel boxes (normalized via sourceSize).
 */
export function normalizeFaceBox(box, sourceSize = null) {
  if (!box || typeof box !== "object") return null;
  if (!isGenuineFaceBox(box)) return null;

  // Unwrap potential nested structures (e.g. subject.face, vision sample subject, native detector boundingBox)
  const candidate = box.face?.box ?? box.face?.boundingBox ?? box.face ?? box.box ?? box.boundingBox ?? box;
  if (!candidate || typeof candidate !== "object") return null;

  const rawX = candidate.xMin ?? candidate.xmin ?? candidate.x;
  const rawY = candidate.yMin ?? candidate.ymin ?? candidate.y;
  if (rawX === undefined || rawY === undefined) return null;

  let numX = Number(rawX);
  let numY = Number(rawY);
  if (!Number.isFinite(numX) || !Number.isFinite(numY)) return null;

  let rawXMax = candidate.xMax ?? candidate.xmax;
  let rawYMax = candidate.yMax ?? candidate.ymax;

  if (rawXMax === undefined && candidate.width !== undefined) {
    const numW = Number(candidate.width);
    if (!Number.isFinite(numW) || numW <= 0) return null;
    rawXMax = numX + numW;
  }
  if (rawYMax === undefined && candidate.height !== undefined) {
    const numH = Number(candidate.height);
    if (!Number.isFinite(numH) || numH <= 0) return null;
    rawYMax = numY + numH;
  }

  let numXMax = Number(rawXMax);
  let numYMax = Number(rawYMax);
  if (!Number.isFinite(numXMax) || !Number.isFinite(numYMax)) return null;

  // Handle pixel coordinates: if values exceed 1.0 or sourceSize is provided and coordinates look like pixels
  const sw = Math.max(1, Number(sourceSize?.width) || 1920);
  const sh = Math.max(1, Number(sourceSize?.height) || 1080);
  const looksLikePixels = numX > 1 || numY > 1 || numXMax > 1 || numYMax > 1;

  if (looksLikePixels) {
    numX /= sw;
    numY /= sh;
    numXMax /= sw;
    numYMax /= sh;
  }

  const xMin = clamp(numX);
  const yMin = clamp(numY);
  const xMax = clamp(numXMax);
  const yMax = clamp(numYMax);

  const width = xMax - xMin;
  const height = yMax - yMin;

  if (width < 0.005 || height < 0.005) return null;

  const rawLabel = String(box.label || candidate.label || "").toLowerCase().trim();
  const isNonPerson = NON_PERSON_LABELS.has(rawLabel);
  const isPerson = !isNonPerson && (
    rawLabel === "" ||
    rawLabel === "person" ||
    rawLabel === "face" ||
    rawLabel === "human" ||
    rawLabel.includes("person") ||
    rawLabel.includes("face") ||
    rawLabel.includes("speaker") ||
    rawLabel.includes("subject") ||
    rawLabel.includes("actor")
  );

  if (!isPerson) return null;

  return {
    xMin,
    yMin,
    xMax,
    yMax,
    x: xMin,
    y: yMin,
    width,
    height,
    label: rawLabel || (isNonPerson ? rawLabel : "person"),
    confidence: box.confidence ?? box.score ?? candidate.confidence ?? candidate.score ?? 1,
    isPerson,
    isFace: rawLabel.includes("face") || Boolean(box.face || candidate.face) || (height < 0.35 && width < 0.35),
    id: box.id || candidate.id || null,
  };
}

/**
 * Extracts, validates, sorts, and merges speech intervals from sentences, captions, or acoustic energy.
 * @param {object} params
 * @returns {Array<{ start: number, end: number }>}
 */
export function extractSpeechIntervals({ speechIntervals = [], sentences = [], captionSegments = [], acousticEnergy = null } = {}) {
  const intervals = [];
  if (Array.isArray(speechIntervals)) {
    speechIntervals.forEach((iv) => {
      const s = Number(iv?.start ?? iv?.[0]);
      const e = Number(iv?.end ?? iv?.[1]);
      if (Number.isFinite(s) && Number.isFinite(e) && e > s) {
        intervals.push({ start: s, end: e });
      }
    });
  }
  if (Array.isArray(sentences)) {
    sentences.forEach((sent) => {
      const s = Number(sent?.start);
      const e = Number(sent?.end);
      if (Number.isFinite(s) && Number.isFinite(e) && e > s) {
        intervals.push({ start: s, end: e });
      }
    });
  }
  if (Array.isArray(captionSegments)) {
    captionSegments.forEach((seg) => {
      const s = Number(seg?.start);
      const e = Number(seg?.end);
      if (Number.isFinite(s) && Number.isFinite(e) && e > s) {
        intervals.push({ start: s, end: e });
      }
    });
  }
  if (Array.isArray(acousticEnergy?.speechIntervals)) {
    acousticEnergy.speechIntervals.forEach((iv) => {
      const s = Number(iv?.start ?? iv?.[0]);
      const e = Number(iv?.end ?? iv?.[1]);
      if (Number.isFinite(s) && Number.isFinite(e) && e > s) {
        intervals.push({ start: s, end: e });
      }
    });
  }

  if (intervals.length === 0) return [];
  intervals.sort((a, b) => a.start - b.start);
  const merged = [intervals[0]];
  for (let i = 1; i < intervals.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = intervals[i];
    // Merge if overlapping or separated by a natural word pause under 0.35s
    if (curr.start <= prev.end + 0.35) {
      prev.end = Math.max(prev.end, curr.end);
    } else {
      merged.push({ start: curr.start, end: curr.end });
    }
  }
  return merged;
}

/**
 * Checks whether audio speech is active at a given timestamp.
 */
export function isSpeechActiveAtTime(time, intervals = [], pad = 0.25) {
  if (!Array.isArray(intervals) || intervals.length === 0) return false;
  const t = Number(time);
  if (!Number.isFinite(t)) return false;
  return intervals.some((iv) => t >= (iv.start - 0.05) && t <= (iv.end + pad));
}

function calculateBoxIoU(boxA, boxB) {
  if (!boxA || !boxB) return 0;
  const xA = Math.max(boxA.xMin, boxB.xMin);
  const yA = Math.max(boxA.yMin, boxB.yMin);
  const xB = Math.min(boxA.xMax, boxB.xMax);
  const yB = Math.min(boxA.yMax, boxB.yMax);
  const interW = Math.max(0, xB - xA);
  const interH = Math.max(0, yB - yA);
  const interArea = interW * interH;
  if (interArea <= 0) return 0;
  const areaA = (boxA.xMax - boxA.xMin) * (boxA.yMax - boxA.yMin);
  const areaB = (boxB.xMax - boxB.xMin) * (boxB.yMax - boxB.yMin);
  return interArea / Math.max(1e-6, areaA + areaB - interArea);
}

/**
 * Multi-person face/subject tracker across frames.
 * Tracks candidates over time, measures visual speaking motion (mouth motion, optical flow, displacement),
 * and performs speaker arbitration with temporal hysteresis & coasting.
 */
export class SubjectTracker {
  constructor(options = {}) {
    this.tracks = new Map();
    this.nextTrackId = 1;
    this.activeSpeakerId = null;
    this.lastSpeakerTime = -1;
    this.speakerCandidateId = null;
    this.speakerCandidateFrames = 0;
    this.lastFrameTime = -1;
    this.options = options;
  }

  reset() {
    this.tracks.clear();
    this.nextTrackId = 1;
    this.activeSpeakerId = null;
    this.lastSpeakerTime = -1;
    this.speakerCandidateId = null;
    this.speakerCandidateFrames = 0;
    this.lastFrameTime = -1;
  }

  update(faces = [], time = 0, isSpeechActive = false, sourceSize = null) {
    const rawTime = Number(time) || 0;
    const normalizedDetections = faces
      .map((f, idx) => {
        const box = normalizeFaceBox(f, sourceSize);
        if (!box) return null;
        const id = f?.id || box.id || null;
        return {
          id,
          box,
          confidence: clamp(f?.confidence ?? f?.score ?? box.confidence ?? 0.85),
          raw: f,
          isPerson: box.isPerson,
          mouthMotion: f?.mouthMotion ?? f?.mouth_motion ?? f?.raw?.mouthMotion,
          motion: f?.motion ?? f?.flow?.meanMotion ?? f?.raw?.motion,
          speakingScore: f?.speakingScore ?? f?.speaking_score ?? f?.raw?.speakingScore,
          isSpeaking: Boolean(f?.isSpeaking ?? f?.speaking ?? f?.raw?.isSpeaking),
        };
      })
      .filter((d) => d && d.isPerson);

    if (normalizedDetections.length === 0) {
      return {
        activeSpeakerId: (this.activeSpeakerId && rawTime - this.lastSpeakerTime < 1.2) ? this.activeSpeakerId : null,
        confidence: 0,
        isAmbiguous: true,
        isSpeechActive,
        matchedTracks: [],
      };
    }

    const matchedTracks = [];
    const unmatchedDetections = [];
    const usedTrackIds = new Set();

    for (const det of normalizedDetections) {
      let bestMatch = null;
      let bestScore = -Infinity;

      for (const [trackId, track] of this.tracks.entries()) {
        if (usedTrackIds.has(trackId)) continue;
        if (rawTime - track.lastSeen > 2.0) continue;

        let matchScore = -1;
        if (det.id && track.externalId && det.id === track.externalId) {
          matchScore = 100;
        } else {
          const detCx = (det.box.xMin + det.box.xMax) / 2;
          const detCy = (det.box.yMin + det.box.yMax) / 2;
          const trkCx = (track.box.xMin + track.box.xMax) / 2;
          const trkCy = (track.box.yMin + track.box.yMax) / 2;
          const dist = Math.hypot(detCx - trkCx, detCy - trkCy);

          const iou = calculateBoxIoU(det.box, track.box);
          if (iou > 0.25 || dist < 0.25) {
            matchScore = iou * 50 + (1 - dist / 0.25) * 50;
          }
        }

        if (matchScore > bestScore) {
          bestScore = matchScore;
          bestMatch = track;
        }
      }

      if (bestMatch && bestScore > 20) {
        usedTrackIds.add(bestMatch.id);
        const dt = Math.max(0.01, rawTime - bestMatch.lastSeen);
        const currCx = (det.box.xMin + det.box.xMax) / 2;
        const currCy = (det.box.yMin + det.box.yMax) / 2;
        const prevCx = (bestMatch.box.xMin + bestMatch.box.xMax) / 2;
        const prevCy = (bestMatch.box.yMin + bestMatch.box.yMax) / 2;
        const displacement = Math.hypot(currCx - prevCx, currCy - prevCy) / dt;

        let hasSpeakingEvidence = false;
        let measuredActivity = 0;
        if (typeof det.mouthMotion === "number" && !isNaN(det.mouthMotion)) {
          measuredActivity = det.mouthMotion * 2.5;
          hasSpeakingEvidence = true;
        } else if (typeof det.speakingScore === "number" && !isNaN(det.speakingScore)) {
          measuredActivity = det.speakingScore * 2.0;
          hasSpeakingEvidence = true;
        } else if (det.isSpeaking) {
          measuredActivity = 1.0;
          hasSpeakingEvidence = true;
        }

        // Only increase smoothedActivity if genuine visual/audio speaking evidence is present.
        // Detector jitter or spatial displacement must NEVER be disguised as speech activity.
        if (hasSpeakingEvidence) {
          bestMatch.smoothedActivity = 0.45 * measuredActivity + 0.55 * (bestMatch.smoothedActivity || 0);
        } else {
          bestMatch.smoothedActivity = 0.65 * (bestMatch.smoothedActivity || 0);
        }
        bestMatch.box = det.box;
        bestMatch.lastSeen = rawTime;
        bestMatch.isSpeaking = Boolean(det.isSpeaking);
        bestMatch.hasSpeakingEvidence = hasSpeakingEvidence;
        det.trackId = bestMatch.id;
        det.box.trackId = bestMatch.id;
        matchedTracks.push(bestMatch);
      } else {
        unmatchedDetections.push(det);
      }
    }

    for (const det of unmatchedDetections) {
      const newId = det.id || `track-${this.nextTrackId++}`;
      const hasSpeakingEvidence = Boolean(
        (typeof det.mouthMotion === "number" && !isNaN(det.mouthMotion)) ||
        (typeof det.speakingScore === "number" && !isNaN(det.speakingScore)) ||
        det.isSpeaking
      );
      let initialActivity = 0;
      if (typeof det.mouthMotion === "number" && !isNaN(det.mouthMotion)) {
        initialActivity = det.mouthMotion * 2.5;
      } else if (typeof det.speakingScore === "number" && !isNaN(det.speakingScore)) {
        initialActivity = det.speakingScore * 2.0;
      } else if (det.isSpeaking) {
        initialActivity = 1.0;
      }
      const newTrack = {
        id: newId,
        externalId: det.id,
        box: det.box,
        lastSeen: rawTime,
        smoothedActivity: initialActivity,
        isSpeaking: Boolean(det.isSpeaking),
        hasSpeakingEvidence,
      };
      this.tracks.set(newId, newTrack);
      det.trackId = newId;
      det.box.trackId = newId;
      matchedTracks.push(newTrack);
    }

    let activeSpeakerId = null;
    let confidence = 0;
    let isAmbiguous = false;

    if (!isSpeechActive) {
      if (this.activeSpeakerId && rawTime - this.lastSpeakerTime < 1.2) {
        activeSpeakerId = this.activeSpeakerId;
        confidence = Math.max(0.3, 0.7 * (1 - (rawTime - this.lastSpeakerTime) / 1.2));
      } else {
        activeSpeakerId = null;
        confidence = 0;
      }
      isAmbiguous = true;
    } else {
      if (matchedTracks.length === 1) {
        activeSpeakerId = matchedTracks[0].id;
        this.activeSpeakerId = activeSpeakerId;
        this.lastSpeakerTime = rawTime;
        confidence = 0.95;
        isAmbiguous = false;
      } else {
        const sorted = [...matchedTracks].sort((a, b) => {
          if (a.isSpeaking && !b.isSpeaking) return -1;
          if (!a.isSpeaking && b.isSpeaking) return 1;
          return (b.smoothedActivity || 0) - (a.smoothedActivity || 0);
        });
        const top = sorted[0];
        const runnerUp = sorted[1];
        const topAct = top.smoothedActivity || 0;
        const runAct = runnerUp.smoothedActivity || 0;

        const hasDirectSpeakingFlag = top.isSpeaking && !runnerUp.isSpeaking;
        // Require meaningful speaking evidence: activity must exceed baseline threshold (0.05)
        const hasSignificantActivityLead = (topAct > 0.05) && (topAct > runAct * 1.35 + 0.02);

        if (hasDirectSpeakingFlag || hasSignificantActivityLead) {
          const leadDiff = topAct - runAct;
          const confScore = hasDirectSpeakingFlag ? 0.95 : clamp(leadDiff / Math.max(0.04, topAct), 0.35, 1.0);

          if (this.activeSpeakerId && this.activeSpeakerId !== top.id) {
            if (this.speakerCandidateId === top.id) {
              this.speakerCandidateFrames += 1;
            } else {
              this.speakerCandidateId = top.id;
              this.speakerCandidateFrames = 1;
            }

            if (confScore >= 0.75 || this.speakerCandidateFrames >= 2) {
              this.activeSpeakerId = top.id;
              this.lastSpeakerTime = rawTime;
              this.speakerCandidateId = null;
              this.speakerCandidateFrames = 0;
            }
          } else {
            this.activeSpeakerId = top.id;
            this.lastSpeakerTime = rawTime;
            this.speakerCandidateId = null;
            this.speakerCandidateFrames = 0;
          }

          activeSpeakerId = this.activeSpeakerId;
          confidence = confScore;
          isAmbiguous = false;
        } else {
          // When reliable speaker evidence does not distinguish who is speaking,
          // retain previous tracked speaker for continuity if still fresh, but mark as ambiguous.
          if (this.activeSpeakerId && rawTime - this.lastSpeakerTime < 1.2) {
            activeSpeakerId = this.activeSpeakerId;
            confidence = 0.4;
          } else {
            activeSpeakerId = null;
            confidence = 0;
          }
          isAmbiguous = true;
        }
      }
    }

    return {
      activeSpeakerId,
      confidence,
      isAmbiguous,
      isSpeechActive,
      matchedTracks,
    };
  }
}

/**
 * Selects the primary subject face from candidate detections in a frame.
 *
 * Ranking & selection criteria:
 * 1. Label filtering: prioritizes person/face detections over non-person background objects (vase, chair, etc.)
 * 2. Explicit manual/user-selected subject preference if provided
 * 3. Active speaker prioritization: elevates verified active speaker with visual-audio evidence (+55 points)
 * 4. Group crop: when multiple people comfortably fit within the target crop and no single speaker is prioritized, keeps them together with padding
 * 5. Infeasible group crop: selects one primary person predictably instead of centering in the empty space between them
 * 6. Stable tracking & hysteresis: prevents erratic target swapping between two speakers across consecutive frames
 */
export function selectPrimaryFace(faces = [], previousFace = null, options = {}) {
  if (!Array.isArray(faces) || faces.length === 0) return null;
  let resolvedOptions = options || {};
  let resolvedPrevFace = previousFace;
  const isPreviousFaceABox = Boolean(previousFace && typeof previousFace === "object" && (previousFace.xMin !== undefined || previousFace.x !== undefined || previousFace.box !== undefined));
  if (!isPreviousFaceABox && previousFace && (!options || Object.keys(options).length === 0) && typeof previousFace === "object" && (previousFace.activeSpeakerId !== undefined || previousFace.targetAspectRatio !== undefined || previousFace.targetRatio !== undefined || previousFace.sourceSize !== undefined)) {
    resolvedOptions = previousFace;
    resolvedPrevFace = null;
  }
  const sourceSize = resolvedOptions?.sourceSize || null;
  const cropDims = resolvedOptions?.cropDims || (resolvedOptions?.targetRatio ? calculateTargetCropDimensions(sourceSize, resolvedOptions.targetRatio) : (resolvedOptions?.targetAspectRatio ? calculateTargetCropDimensions(sourceSize, resolvedOptions.targetAspectRatio) : null));
  const targetCropWidth = cropDims?.width ?? cropDims?.cropW ?? 0.3164;

  const validDetections = faces
    .map((f, idx) => {
      const box = normalizeFaceBox(f, sourceSize);
      if (!box) return null;
      const confidence = clamp(f?.confidence ?? f?.score ?? box.confidence ?? 0.85);
      const id = f?.id || box.id || `face-${idx}`;
      return { id, box, confidence, raw: f, isPerson: box.isPerson };
    })
    .filter(Boolean);

  if (validDetections.length === 0) return null;

  // 1. Strictly require genuine person/face detections; reject background objects (vase, chair, wall, etc.)
  const candidates = validDetections.filter((d) => d.isPerson);
  if (candidates.length === 0) return null;

  // 2. Respect explicit manual / user-selected subject
  const userSelected = options?.userSelectedSubject;
  if (userSelected) {
    if (typeof userSelected === "string") {
      const matched = candidates.find((c) => c.id === userSelected || c.raw?.id === userSelected || c.raw?.trackId === userSelected);
      if (matched) return matched.box;
    } else if (typeof userSelected === "object") {
      const targetCenter = {
        x: userSelected.xMin !== undefined ? (userSelected.xMin + userSelected.xMax) / 2 : (userSelected.x ?? 0.5),
        y: userSelected.yMin !== undefined ? (userSelected.yMin + userSelected.yMax) / 2 : (userSelected.y ?? 0.5),
      };
      let bestMatch = null;
      let minDistance = Infinity;
      for (const cand of candidates) {
        const cX = (cand.box.xMin + cand.box.xMax) / 2;
        const cY = (cand.box.yMin + cand.box.yMax) / 2;
        const dist = Math.hypot(cX - targetCenter.x, cY - targetCenter.y);
        if (dist < minDistance) {
          minDistance = dist;
          bestMatch = cand;
        }
      }
      if (bestMatch && minDistance < 0.35) {
        return bestMatch.box;
      }
    }
  }

  if (candidates.length === 1) {
    return {
      ...candidates[0].box,
      id: candidates[0].id,
      trackId: candidates[0].raw?.trackId || candidates[0].box?.trackId || candidates[0].id,
    };
  }

  // Active speaker arbitration info
  const activeSpeakerId = resolvedOptions?.activeSpeakerId;
  const speakerConfidence = resolvedOptions?.speakerConfidence ?? (activeSpeakerId ? 1.0 : 0);
  const preferSpeakerOverGroup = resolvedOptions?.preferSpeakerOverGroup !== false;
  const hasConfidentSpeaker = Boolean(activeSpeakerId && speakerConfidence >= 0.5);

  // 3. Multi-person evaluation: Group crop is ONLY permitted when explicitly enabled via allowGroupCrop
  const allXMin = Math.min(...candidates.map((c) => c.box.xMin));
  const allXMax = Math.max(...candidates.map((c) => c.box.xMax));
  const allYMin = Math.min(...candidates.map((c) => c.box.yMin));
  const allYMax = Math.max(...candidates.map((c) => c.box.yMax));

  const groupSpanX = allXMax - allXMin;
  const paddingX = Math.min(0.04, Math.max(0, (targetCropWidth - groupSpanX) / 2));
  const canFitGroup = (groupSpanX + paddingX * 2) <= targetCropWidth + 0.001;

  if (resolvedOptions.allowGroupCrop && canFitGroup && (!hasConfidentSpeaker || !preferSpeakerOverGroup)) {
    // Both/all people fit comfortably inside the target aspect crop window AND group crop was explicitly allowed
    const paddedXMin = clamp(allXMin - paddingX);
    const paddedXMax = clamp(allXMax + paddingX);
    const finalXMin = (paddedXMax - paddedXMin) <= targetCropWidth ? paddedXMin : allXMin;
    const finalXMax = (paddedXMax - paddedXMin) <= targetCropWidth ? paddedXMax : allXMax;

    return {
      xMin: finalXMin,
      yMin: clamp(allYMin - 0.02),
      xMax: finalXMax,
      yMax: clamp(allYMax + 0.02),
      x: finalXMin,
      y: clamp(allYMin - 0.02),
      width: finalXMax - finalXMin,
      height: clamp(allYMax + 0.02) - clamp(allYMin - 0.02),
      isGroup: true,
      membersCount: candidates.length,
      label: "group",
      confidence: Math.max(...candidates.map((c) => c.confidence)),
      speakerIdentified: false,
    };
  }

  // 4. Select ONE primary person with active speaker priority and rock-solid tracking hysteresis.
  // Never center on the empty space between two people!
  const prevCenter = resolvedPrevFace
    ? { x: (resolvedPrevFace.xMin + resolvedPrevFace.xMax) / 2, y: (resolvedPrevFace.yMin + resolvedPrevFace.yMax) / 2 }
    : null;

  const scoredFaces = candidates.map((cand) => {
    const box = cand.box;
    const width = box.xMax - box.xMin;
    const height = box.yMax - box.yMin;
    const area = width * height;
    const centerX = (box.xMin + box.xMax) / 2;
    const centerY = (box.yMin + box.yMax) / 2;

    // Prominence score (capped at 15 points) - slight tie-breaker for face scale,
    // prevented from overpowering tracking continuity or active speaker evidence
    const prominenceScore = Math.min(15, area * 100);

    // Confidence score (up to 10 points)
    const confScore = cand.confidence * 10;

    // Centrality score (up to 5 points) - gentle tie-breaker only when no subject is tracked yet
    const distCenter = Math.hypot(centerX - 0.5, centerY - 0.45);
    const centralityScore = Math.max(0, 5 * (1 - distCenter));

    // Shot-level speaker focus bias (e.g. visual analysis determined active speaker is on "right" or "left")
    const speakerFocus = resolvedOptions.speakerFocus;
    const isFocusMatch = speakerFocus && (
      (speakerFocus === "left" && centerX < 0.45) ||
      (speakerFocus === "right" && centerX > 0.55) ||
      (speakerFocus === "center" && centerX >= 0.35 && centerX <= 0.65)
    );

    const isThisCandidateSpeaker = Boolean(
      (activeSpeakerId && (
        cand.id === activeSpeakerId ||
        cand.raw?.id === activeSpeakerId ||
        cand.raw?.trackId === activeSpeakerId ||
        cand.box.id === activeSpeakerId ||
        cand.box.trackId === activeSpeakerId
      )) || isFocusMatch
    );

    let speakerScore = 0;
    if (isThisCandidateSpeaker) {
      const conf = isFocusMatch ? (resolvedOptions.focusConfidence ?? 0.95) : (speakerConfidence || (resolvedOptions.speakerConfidence ?? 0.9));
      speakerScore = 65 * clamp(conf, 0.4, 1.0);
    } else if (typeof cand.raw?.speakingScore === "number" && cand.raw.speakingScore >= 0.3) {
      speakerScore = clamp(cand.raw.speakingScore) * 60;
    } else if (cand.raw?.isSpeaking) {
      speakerScore = 55;
    } else if (resolvedOptions.speakerScores) {
      const direct = resolvedOptions.speakerScores[cand.id] ?? resolvedOptions.speakerScores[cand.raw?.id];
      if (typeof direct === "number" && direct >= 0.3) speakerScore = clamp(direct) * 60;
    }

    // Temporal continuity bonus / Hysteresis (up to 75 points)
    // Ensures the tracked person cannot be stolen simply by a larger face or movement toward center
    let continuityBonus = 0;
    if (resolvedPrevFace) {
      const distPrev = prevCenter ? Math.hypot(centerX - prevCenter.x, centerY - prevCenter.y) : Infinity;
      const isSpatialMatch = distPrev < 0.28;
      const isSynthetic = (id) => typeof id === "string" && id.startsWith("face-");
      const isExplicitIdMatch = Boolean(
        cand.id && resolvedPrevFace.id &&
        !isSynthetic(cand.id) &&
        !isSynthetic(resolvedPrevFace.id) &&
        cand.id === resolvedPrevFace.id
      );
      const isTrackMatch = Boolean(
        cand.raw?.trackId && resolvedPrevFace.trackId &&
        !isSynthetic(cand.raw.trackId) &&
        !isSynthetic(resolvedPrevFace.trackId) &&
        cand.raw.trackId === resolvedPrevFace.trackId
      );

      if (isExplicitIdMatch || isTrackMatch) {
        continuityBonus += 40;
      }
      if (isSpatialMatch) {
        continuityBonus += 55 * (1 - distPrev / 0.28);
      }
    }

    // If active speaker evidence or speaker focus is verified on another person, damp continuity bonus on non-speakers
    const hasAnyVerifiedSpeaker = Boolean(
      hasConfidentSpeaker ||
      speakerFocus ||
      candidates.some((c) => c.raw?.isSpeaking || (typeof c.raw?.speakingScore === "number" && c.raw.speakingScore >= 0.35))
    );
    const isVerifiedSpeaker = Boolean(isThisCandidateSpeaker || speakerScore >= 45);

    if (hasAnyVerifiedSpeaker && !isVerifiedSpeaker) {
      continuityBonus *= 0.15;
    }

    // Manual offset preference bias (if manualCropX is biased left or right)
    let manualBias = 0;
    if (typeof options.manualCropX === "number" && options.manualCropX !== 0.5) {
      const prefX = options.manualCropX;
      manualBias = Math.max(0, 15 * (1 - Math.abs(centerX - prefX)));
    }

    const totalScore = prominenceScore + confScore + centralityScore + continuityBonus + speakerScore + manualBias;
    return {
      cand,
      box,
      score: totalScore,
      area,
      confidence: cand.confidence,
      centerX,
      isSpeaker: Boolean(isThisCandidateSpeaker || speakerScore > 35),
      speakerScore,
    };
  });

  // Sort descending: highest score first, then larger area, then confidence.
  // In ties, prefer centrality over arbitrary left-bias.
  scoredFaces.sort((a, b) => {
    if (Math.abs(b.score - a.score) > 0.05) {
      return b.score - a.score;
    }
    if (Math.abs(b.area - a.area) > 0.005) {
      return b.area - a.area;
    }
    if (Math.abs(b.confidence - a.confidence) > 0.05) {
      return b.confidence - a.confidence;
    }
    const aDistCenter = Math.abs(a.centerX - 0.5);
    const bDistCenter = Math.abs(b.centerX - 0.5);
    if (Math.abs(aDistCenter - bDistCenter) > 0.02) {
      return aDistCenter - bDistCenter;
    }
    return a.centerX - b.centerX;
  });

  const winner = scoredFaces[0];
  if (!winner) return null;

  return {
    ...winner.box,
    id: winner.cand.id,
    trackId: winner.cand.raw?.trackId || winner.cand.box?.trackId || winner.cand.id,
    activeSpeakerId: winner.isSpeaker ? winner.cand.id : null,
    speakerIdentified: winner.isSpeaker,
    speakerConfidence: winner.isSpeaker ? (options.speakerConfidence ?? 1.0) : 0,
  };
}

/**
 * Calculates normalized crop dimensions and initial position for a target aspect ratio.
 */
export function calculateTargetCropDimensions(sourceSize = {}, targetRatio = "9:16") {
  const sw = Math.max(1, Number(sourceSize?.width) || 1920);
  const sh = Math.max(1, Number(sourceSize?.height) || 1080);
  const sourceAspect = sw / sh;

  let targetAspect = 9 / 16;
  if (typeof targetRatio === "number" && Number.isFinite(targetRatio) && targetRatio > 0) {
    targetAspect = targetRatio;
  } else if (typeof targetRatio === "string" && REFRAMING_ASPECT_RATIOS[targetRatio]) {
    targetAspect = REFRAMING_ASPECT_RATIOS[targetRatio].ratio;
  } else if (typeof targetRatio === "string" && targetRatio.includes(":")) {
    const [rw, rh] = targetRatio.split(":").map(Number);
    if (rw > 0 && rh > 0) targetAspect = rw / rh;
  }

  let width = 1.0;
  let height = 1.0;

  if (targetAspect < sourceAspect) {
    // Narrower target (e.g. 16:9 source to 9:16 target): full height, cropped width
    width = clamp(targetAspect / sourceAspect, 0.05, 1.0);
    height = 1.0;
  } else {
    // Wider or taller target: full width, cropped height
    width = 1.0;
    height = clamp(sourceAspect / targetAspect, 0.05, 1.0);
  }

  const w = Number(width.toFixed(4));
  const h = Number(height.toFixed(4));
  return {
    width: w,
    height: h,
    cropW: w,
    cropH: h,
  };
}

/**
 * Solves a single frame's normalized crop coordinates given a subject box and target ratio.
 */
export function solveFrameCrop(targetBox, cropDims, options = {}) {
  const width = cropDims?.width ?? cropDims?.cropW ?? 1.0;
  const height = cropDims?.height ?? cropDims?.cropH ?? 1.0;
  const manualCropX = Number.isFinite(options.manualCropX) ? clamp(options.manualCropX) : 0.5;

  if (!targetBox) {
    // Fallback: centered or user manual offset
    const x = clamp(manualCropX * (1 - width), 0, 1 - width);
    const y = clamp(0.5 * (1 - height), 0, 1 - height);
    const xNum = Number(x.toFixed(4));
    const yNum = Number(y.toFixed(4));
    const panFactor = (1 - width) > 0.0001 ? Number((xNum / (1 - width)).toFixed(4)) : 0.5;
    return {
      x: xNum,
      y: yNum,
      width,
      height,
      cropX: xNum,
      cropY: yNum,
      cropW: width,
      cropH: height,
      panFactor,
      isFallback: true,
      state: "fallback",
    };
  }

  const faceCenter = targetBox.centerX !== undefined
    ? targetBox.centerX
    : (targetBox.head ? (targetBox.head.xMin + targetBox.head.xMax) / 2 : (targetBox.xMin + targetBox.xMax) / 2);
  const boxW = targetBox.xMax - targetBox.xMin;
  const leadX = Number(options.leadX) || 0;
  let idealX = faceCenter - width / 2 + leadX;

  // If user provided an explicit manualCropX bias
  if (options.manualCropX !== undefined && options.manualCropX !== 0.5) {
    idealX += (options.manualCropX - 0.5) * (1 - width) * 0.4;
  }

  // Anchor Y on protected headroom (so head isn't sliced off in portrait)
  const headTop = targetBox.yMin;
  const isFullBody = targetBox.height > 0.45 && !targetBox.isFace && !targetBox.isGroup;
  let idealY = 0;
  if (height < 0.999) {
    if (isFullBody) {
      idealY = Math.max(0, headTop - height * 0.08);
    } else {
      idealY = Math.max(0, headTop - height * 0.10);
    }
  }

  // Clamp within normalized bounds [0, 1 - width], [0, 1 - height]
  let x = clamp(idealX, 0, 1 - width);
  let y = clamp(idealY, 0, 1 - height);

  const isMultiPersonGroup = Boolean(
    targetBox.isGroup ||
    targetBox.label === "group" ||
    (boxW >= 0.65 && boxW > (targetBox.height || (targetBox.yMax - targetBox.yMin)) * 1.15 && faceCenter >= 0.40 && faceCenter <= 0.60)
  );

  // Guarantee that the subject is inside [x, x + width] if boxW <= width
  if (boxW <= width) {
    if (targetBox.xMin < x) {
      x = targetBox.xMin;
    } else if (targetBox.xMax > x + width) {
      x = targetBox.xMax - width;
    }
    x = clamp(x, 0, 1 - width);
  } else if (isMultiPersonGroup) {
    // Multi-person group span or wide composite box that exceeds target crop:
    // NEVER center in empty space between multiple people!
    const primaryAnchorX = targetBox.primaryXMin !== undefined
      ? targetBox.primaryXMin + (targetBox.primaryWidth || width) / 2
      : (targetBox.head ? (targetBox.head.xMin + targetBox.head.xMax) / 2
      : (targetBox.primarySubject ? (targetBox.primarySubject.xMin + targetBox.primarySubject.xMax) / 2 : null));

    if (primaryAnchorX !== null) {
      x = clamp(primaryAnchorX - width / 2 + leadX, 0, 1 - width);
    } else if (options.manualCropX !== undefined && options.manualCropX !== 0.5) {
      x = clamp(targetBox.xMin + (Number(options.manualCropX) || 0.5) * (boxW - width), 0, 1 - width);
    } else {
      // Predictably frame a real subject (anchoring on the first subject)
      // rather than floating in the center gap between subjects.
      x = clamp(targetBox.xMin, 0, 1 - width);
    }
  } else {
    // Single wide subject (e.g. seated with arms, close-up, or full body):
    // Center crop on the subject's faceCenter so their head and torso remain centered in portrait.
    // If head/face is present, ensure head is protected inside the crop window.
    if (targetBox.head) {
      const headCenter = (targetBox.head.xMin + targetBox.head.xMax) / 2;
      x = clamp(headCenter - width / 2 + leadX, 0, 1 - width);
    } else {
      x = clamp(idealX, 0, 1 - width);
    }
  }

  // Guarantee that head/face is protected vertically inside [y, y + height] if boxH <= height
  const boxH = targetBox.yMax - targetBox.yMin;
  if (boxH <= height) {
    if (targetBox.yMin < y) {
      y = Math.max(0, targetBox.yMin - height * 0.05);
    } else if (targetBox.yMax > y + height) {
      y = Math.min(1 - height, targetBox.yMax - height + height * 0.05);
    }
    y = clamp(y, 0, 1 - height);
  }

  const xNum = Number(x.toFixed(4));
  const yNum = Number(y.toFixed(4));
  const panFactor = (1 - width) > 0.0001 ? Number((xNum / (1 - width)).toFixed(4)) : 0.5;

  return {
    x: xNum,
    y: yNum,
    width,
    height,
    cropX: xNum,
    cropY: yNum,
    cropW: width,
    cropH: height,
    panFactor,
    isFallback: false,
    state: "tracked",
    isGroup: Boolean(targetBox.isGroup),
  };
}

/**
 * Compresses collinear/near-identical keyframes using tolerance.
 */
function compressCollinearKeyframes(frames, tolerance = 0.005) {
  if (frames.length <= 2) return frames;

  const result = [frames[0]];
  for (let i = 1; i < frames.length - 1; i++) {
    const prev = result[result.length - 1];
    const curr = frames[i];
    const next = frames[i + 1];

    // Always preserve cuts, hold keyframes immediately before cuts, state transitions (e.g. coast), and speaker/subject transitions
    if (
      curr.isCut || curr.cut || next.isCut || next.cut ||
      curr.state !== prev.state ||
      (curr.activeSpeakerId && curr.activeSpeakerId !== prev.activeSpeakerId) ||
      (curr.subjectId && curr.subjectId !== prev.subjectId) ||
      (curr.trackId && curr.trackId !== prev.trackId)
    ) {
      result.push(curr);
      continue;
    }

    // Check linear interpolation distance
    const span = Math.max(0.001, next.time - prev.time);
    const alpha = (curr.time - prev.time) / span;
    const expectedX = prev.x + (next.x - prev.x) * alpha;
    const expectedY = prev.y + (next.y - prev.y) * alpha;

    if (Math.abs(curr.x - expectedX) > tolerance || Math.abs(curr.y - expectedY) > tolerance) {
      result.push(curr);
    }
  }

  result.push(frames[frames.length - 1]);
  return result;
}

/**
 * Scans upcoming detections within the current shot to find the nearest valid face
 * for framing the beginning of a newly cut shot when detections are missing right at the cut.
 */
function findNearestShotCrop(currentIndex, detections, cuts, cropDims, options = {}) {
  const currentItem = detections[currentIndex];
  if (!currentItem) return null;
  const currentCutTime = cuts.find((c) => c <= currentItem.time) ?? 0;
  const nextCutTime = cuts.find((c) => c > currentCutTime) ?? Infinity;

  for (let j = currentIndex; j < detections.length; j++) {
    const d = detections[j];
    if (d.time >= nextCutTime) break;
    const face = selectPrimaryFace(d.faces, null, options);
    if (face) {
      return solveFrameCrop(face, cropDims, options);
    }
  }
  return null;
}

/**
 * Builds a dynamic reframing keyframe track from sampled face detections across time.
 * Supports active speaker tracking, multi-person arbitration, scene cut resets, and smooth transitions.
 *
 * @param {object} params
 * @param {Array} params.detections - Array of { time/timestamp, faces: [...], box?: object }
 * @param {number} params.duration - Total clip duration in seconds
 * @param {object} params.sourceSize - { width, height }
 * @param {string|number} params.targetRatio - "9:16", "1:1", "16:9" or ratio float
 * @param {Array<number>} params.sceneCuts - Timestamps of visual scene transitions
 * @param {string} params.motion - "smooth" | "locked" | "responsive"
 * @param {number} params.manualCropX - Manual offset override (0..1)
 * @param {Array} params.speechIntervals - Spoken audio intervals [{ start, end }]
 * @param {Array} params.sentences - Spoken sentence records
 * @param {Array} params.captionSegments - Caption records
 * @param {object} params.acousticEnergy - Audio energy features
 * @param {boolean} params.preferSpeakerOverGroup - Whether to prefer single active speaker crop over group crop
 * @returns {object} SmartFrame record with cropKeyframes
 */
export function buildDynamicReframingTrack({
  detections = [],
  duration = 15,
  startTime = 0,
  sourceStart = undefined,
  sourceSize = { width: 1920, height: 1080 },
  targetRatio = "9:16",
  sceneCuts = [],
  motion = "smooth",
  manualCropX = 0.5,
  userSelectedSubject = null,
  speechIntervals = [],
  sentences = [],
  captionSegments = [],
  acousticEnergy = null,
  preferSpeakerOverGroup = true,
  framingMode = "auto",
  speakerFocus = null,
  speakerFocusMap = null,
} = {}) {
  const safeDuration = Math.max(0.5, Number(duration) || 15);
  const cropDims = calculateTargetCropDimensions(sourceSize, targetRatio);
  const motionConfig = REFRAMING_MOTIONS[motion] || REFRAMING_MOTIONS.smooth;

  // 1. Sanitize, filter, and sort detections by time
  const rawList = Array.isArray(detections) ? detections : [];
  const rawTimes = rawList
    .map((d) => Number(d?.time ?? d?.timestamp))
    .filter((t) => Number.isFinite(t));

  let detectedStartTime = Number.isFinite(Number(sourceStart ?? startTime)) && Number(sourceStart ?? startTime) > 0
    ? Number(sourceStart ?? startTime)
    : 0;

  if (detectedStartTime === 0 && rawTimes.length > 0) {
    const minTime = Math.min(...rawTimes);
    const maxTime = Math.max(...rawTimes);
    if (minTime >= safeDuration * 0.75 && maxTime > safeDuration) {
      detectedStartTime = minTime;
    }
  }

  const validDetections = rawList
    .filter((d) => {
      if (!d) return false;
      const rawTime = d.time ?? d.timestamp;
      if (typeof rawTime !== "number" || isNaN(rawTime) || rawTime < 0) return false;
      if (Array.isArray(d.faces)) return true;
      if (d.state === "lost" || d.state === "coast") return true;
      return isGenuineFaceDetection(d);
    })
    .map((d) => {
      const rawTime = Number(d.time ?? d.timestamp);
      // Only offset by detectedStartTime if timestamps are in source time (>= detectedStartTime - 0.5)
      // and not already relative (<= safeDuration + 0.5 when detectedStartTime > safeDuration)
      const isAlreadyRelative = rawTime <= safeDuration + 0.5 && detectedStartTime > safeDuration;
      const relTime = (detectedStartTime > 0 && !isAlreadyRelative && rawTime >= detectedStartTime - 0.5)
        ? (rawTime - detectedStartTime)
        : rawTime;
      const time = clamp(Number(relTime.toFixed(3)), 0, safeDuration);
      const facesList = Array.isArray(d.faces)
        ? d.faces.filter(isGenuineFaceBox)
        : (d.box && isGenuineFaceBox(d.box) ? [d.box] : (d.subject && isGenuineFaceBox(d.subject) ? [d.subject] : (isGenuineFaceBox(d) ? [d] : [])));
      return { time, faces: facesList, state: d.state };
    })
    .sort((a, b) => a.time - b.time);

  const hasAnyValidFace = validDetections.some((d) =>
    (d.faces || []).some((f) => normalizeFaceBox(f?.box ?? f, sourceSize) !== null)
  );

  if (validDetections.length === 0 || !hasAnyValidFace) {
    console.info(`[ShortsStudio Pipeline Diagnostic] buildDynamicReframingTrack: No valid detections (validDetections=${validDetections.length}, hasAnyValidFace=${hasAnyValidFace}), generating fallback track.`);
    return generateFallbackReframingTrack(sourceSize, targetRatio, safeDuration, manualCropX);
  }

  console.info(`[ShortsStudio Pipeline Diagnostic] buildDynamicReframingTrack: Processing ${validDetections.length} valid frames for target ratio ${targetRatio}`);

  // Set of scene cut timestamps for quick lookup (normalized to clip relative time)
  const cuts = (Array.isArray(sceneCuts) ? sceneCuts : [])
    .map((c) => {
      const num = Number(c);
      if (!Number.isFinite(num)) return null;
      if (detectedStartTime > 0 && num >= detectedStartTime) {
        return num - detectedStartTime;
      }
      return num;
    })
    .filter((c) => c !== null && c > 0.05 && c < safeDuration - 0.05)
    .sort((a, b) => a - b);

  const tracker = new SubjectTracker();

  // Normalize speech intervals by detectedStartTime if in source timestamps
  const normalizeIntervals = (arr) => (Array.isArray(arr) ? arr : []).map((item) => {
    const s = Number(item.start ?? item.startTime ?? 0);
    const e = Number(item.end ?? item.endTime ?? s);
    if (detectedStartTime > 0 && s >= detectedStartTime - 0.1) {
      return {
        ...item,
        start: Math.max(0, s - detectedStartTime),
        end: Math.max(0, e - detectedStartTime),
      };
    }
    return item;
  });

  const mergedSpeech = extractSpeechIntervals({
    speechIntervals: normalizeIntervals(speechIntervals),
    sentences: normalizeIntervals(sentences),
    captionSegments: normalizeIntervals(captionSegments),
    acousticEnergy,
  });

  const rawFrames = [];
  let previousSelectedFace = null;
  let previousCrop = null;
  let lastDetectedTime = -1;

  for (let i = 0; i < validDetections.length; i++) {
    const item = validDetections[i];
    const time = item.time;

    // Check if a scene cut occurred between previous sample and current sample
    const prevTime = validDetections[i - 1]?.time ?? -1;
    const cutsInSegment = cuts.filter((cut) => cut > prevTime && cut <= time);
    const isCutTransition = Boolean(previousCrop && cutsInSegment.length > 0);
    const activeCutTime = isCutTransition ? cutsInSegment[0] : null;

    if (isCutTransition) {
      // Scene cut: reset tracker motion state so velocity smoothing doesn't pan across cuts,
      // but retain previousSelectedFace for identity continuity across camera angles during dialogue.
      tracker.reset();
    }

    const isSpeechActive = isSpeechActiveAtTime(time, mergedSpeech);
    const speakerStatus = tracker.update(item.faces, time, isSpeechActive, sourceSize);

    // Resolve shot-level speaker focus if provided
    let currentSpeakerFocus = null;
    if (Array.isArray(speakerFocusMap)) {
      const match = speakerFocusMap.find((s) => time >= s.start && time <= s.end);
      if (match) currentSpeakerFocus = match.focus;
    } else if (typeof speakerFocus === "string") {
      currentSpeakerFocus = speakerFocus;
    }

    const primaryFace = selectPrimaryFace(item.faces, previousSelectedFace, {
      sourceSize,
      cropDims,
      targetRatio,
      manualCropX,
      userSelectedSubject,
      time,
      isSpeechActive,
      activeSpeakerId: speakerStatus.activeSpeakerId,
      speakerConfidence: speakerStatus.confidence,
      speakerFocus: currentSpeakerFocus,
      isAmbiguous: speakerStatus.isAmbiguous,
      preferSpeakerOverGroup,
      framingMode,
    });
    let targetCrop;

    if (primaryFace) {
      lastDetectedTime = time;
      targetCrop = solveFrameCrop(primaryFace, cropDims, {
        manualCropX,
        sourceSize,
        userSelectedSubject,
      });

      console.info(`[ShortsStudio Pipeline Diagnostic] Frame @ ${time.toFixed(2)}s: selected subject:`, {
        id: primaryFace.id,
        isPerson: primaryFace.isPerson,
        activeSpeakerId: speakerStatus.activeSpeakerId,
        speakerConfidence: speakerStatus.confidence,
        crop: { x: targetCrop.x, y: targetCrop.y, width: targetCrop.width, height: targetCrop.height, panFactor: targetCrop.panFactor },
      });
    } else {
      // Occlusion / missing detection handling:
      // Within the SAME continuous shot (!isCutTransition):
      // If a valid subject crop was previously tracked, coast and preserve that subject framing (state: "coast")
      // rather than collapsing into the neutral center between subjects.
      // Across a genuine scene cut (isCutTransition): DO NOT coast on the previous shot's crop!
      // Instead, find the nearest valid detection in the new shot, or fall back to neutral framing.
      const hasValidPreviousCrop = Boolean(
        previousCrop &&
        !previousCrop.isFallback &&
        previousCrop.state !== "fallback"
      );

      if (!isCutTransition && hasValidPreviousCrop) {
        targetCrop = {
          ...previousCrop,
          state: "coast",
          isFallback: false,
          confidence: Math.max(0.4, (previousCrop.confidence || 0.75) * 0.95),
        };
      } else {
        targetCrop = findNearestShotCrop(i, validDetections, cuts, cropDims, { manualCropX, sourceSize })
          || solveFrameCrop(null, cropDims, { manualCropX, sourceSize });
      }
    }

    // Apply smoothing and deadband
    const isSubjectSwitch = Boolean(
      !isCutTransition &&
      previousSelectedFace &&
      primaryFace &&
      previousCrop &&
      (
        (previousSelectedFace.id && primaryFace.id && previousSelectedFace.id !== primaryFace.id) ||
        (previousSelectedFace.trackId && primaryFace.trackId && previousSelectedFace.trackId !== primaryFace.trackId)
      ) &&
      Math.abs(targetCrop.x - previousCrop.x) > 0.04
    );
    const isTransitionFromFallback = Boolean(
      previousCrop && (previousCrop.state === "fallback" || previousCrop.isFallback)
    );
    const isCutOrSwitch = Boolean(isCutTransition || isSubjectSwitch);

    // Keyframe placement at shot cuts and subject switches:
    // 1. When a camera shot cut occurred between detections, terminate previous shot at cutTime - 0.03s
    //    and place the new shot's keyframe directly at cutTime.
    // 2. When an in-shot subject switch occurred, hold previous subject until time - 0.03s.
    if (isCutTransition && activeCutTime !== null && previousCrop) {
      const holdTime = Number(Math.max(prevTime + 0.005, activeCutTime - 0.03).toFixed(3));
      if (holdTime > prevTime && (!rawFrames.length || rawFrames.at(-1).time < holdTime)) {
        rawFrames.push({
          time: holdTime,
          ...previousCrop,
          confidence: previousCrop.confidence ?? 1,
          isCut: false,
          cut: false,
          activeSpeakerId: previousCrop.activeSpeakerId ?? null,
          subjectId: previousSelectedFace?.id || null,
          trackId: previousSelectedFace?.trackId || null,
        });
      }

      const cutKfTime = Number(activeCutTime.toFixed(3));
      if (!rawFrames.length || rawFrames.at(-1).time < cutKfTime) {
        rawFrames.push({
          time: cutKfTime,
          ...targetCrop,
          confidence: primaryFace ? 1 : 0.75,
          isCut: true,
          cut: true,
          activeSpeakerId: primaryFace?.activeSpeakerId || (speakerStatus.activeSpeakerId ? speakerStatus.activeSpeakerId : null),
          speakerIdentified: Boolean(speakerStatus.activeSpeakerId && !speakerStatus.isAmbiguous),
          isGroup: Boolean(primaryFace?.isGroup),
          subjectId: primaryFace?.id || null,
          trackId: primaryFace?.trackId || null,
        });
      }
    } else if (isSubjectSwitch && previousCrop && prevTime >= 0 && time - prevTime > 0.05) {
      const holdTime = Number(Math.max(prevTime + 0.005, time - 0.03).toFixed(3));
      if (holdTime > prevTime && (!rawFrames.length || rawFrames.at(-1).time < holdTime)) {
        rawFrames.push({
          time: holdTime,
          ...previousCrop,
          confidence: previousCrop.confidence ?? 1,
          isCut: false,
          cut: false,
          activeSpeakerId: previousCrop.activeSpeakerId ?? null,
          subjectId: previousSelectedFace?.id || null,
          trackId: previousSelectedFace?.trackId || null,
        });
      }
    }

    let smoothedCrop;
    if (!previousCrop || isCutOrSwitch || isTransitionFromFallback || targetCrop.state === "coast") {
      smoothedCrop = targetCrop;
    } else {
      const deltaX = targetCrop.x - previousCrop.x;
      const deltaY = targetCrop.y - previousCrop.y;

      // Deadband check: suppress micro-jitter
      const applyX = Math.abs(deltaX) > motionConfig.deadband
        ? previousCrop.x + deltaX * motionConfig.smoothing
        : previousCrop.x;
      const applyY = Math.abs(deltaY) > motionConfig.deadband
        ? previousCrop.y + deltaY * motionConfig.smoothing
        : previousCrop.y;

      // Velocity limiting
      const dt = Math.max(0.01, time - (validDetections[i - 1]?.time || 0));
      const maxStep = motionConfig.maxVelocity * dt;
      const clampedX = clamp(applyX, previousCrop.x - maxStep, previousCrop.x + maxStep);
      const clampedY = clamp(applyY, previousCrop.y - maxStep, previousCrop.y + maxStep);

      let finalX = Number(clamp(clampedX, 0, 1 - cropDims.width).toFixed(4));
      let finalY = Number(clamp(clampedY, 0, 1 - cropDims.height).toFixed(4));

      // Guarantee the primary face/subject remains inside the crop frame after smoothing
      if (primaryFace) {
        const boxW = primaryFace.xMax - primaryFace.xMin;
        if (boxW <= cropDims.width) {
          if (primaryFace.xMin < finalX) finalX = primaryFace.xMin;
          if (primaryFace.xMax > finalX + cropDims.width) finalX = primaryFace.xMax - cropDims.width;
        } else {
          // If the person/subject is wider than the crop window (e.g. seated with arms or close-up),
          // ensure the crop is centered on their head/torso center, never leaving them stranded outside.
          const subjectCenterX = primaryFace.centerX ?? ((primaryFace.xMin + primaryFace.xMax) / 2);
          const desiredX = subjectCenterX - cropDims.width / 2;
          finalX = clamp(desiredX, primaryFace.xMin, primaryFace.xMax - cropDims.width);
        }
        finalX = Number(clamp(finalX, 0, 1 - cropDims.width).toFixed(4));
      }

      const panFactor = (1 - cropDims.width) > 0.0001 ? Number((finalX / (1 - cropDims.width)).toFixed(4)) : 0.5;

      smoothedCrop = {
        x: finalX,
        y: finalY,
        width: cropDims.width,
        height: cropDims.height,
        cropX: finalX,
        cropY: finalY,
        cropW: cropDims.width,
        cropH: cropDims.height,
        panFactor,
        state: primaryFace ? "tracked" : (targetCrop.state || previousCrop?.state || "fallback"),
      };
    }

    // For cut transitions, the cut keyframe was already inserted at cutTime.
    // Only push a keyframe at time if it is meaningfully after the cut.
    const isCutKeyframe = Boolean(isSubjectSwitch);
    const shouldPushDetectionKf = !isCutTransition || (activeCutTime !== null && time > activeCutTime + 0.04);

    if (shouldPushDetectionKf && (!rawFrames.length || rawFrames.at(-1).time < Number(time.toFixed(3)))) {
      rawFrames.push({
        time: Number(time.toFixed(3)),
        ...smoothedCrop,
        confidence: primaryFace ? 1 : (smoothedCrop.state === "coast" ? 0.75 : 0.5),
        isCut: isCutKeyframe,
        cut: isCutKeyframe,
        activeSpeakerId: primaryFace?.activeSpeakerId || (speakerStatus.activeSpeakerId ? speakerStatus.activeSpeakerId : null),
        speakerIdentified: Boolean(speakerStatus.activeSpeakerId && !speakerStatus.isAmbiguous),
        isGroup: Boolean(primaryFace?.isGroup),
        subjectId: primaryFace?.id || null,
        trackId: primaryFace?.trackId || null,
      });
    }

    previousCrop = smoothedCrop;
    if (primaryFace) {
      previousSelectedFace = primaryFace;
    }
  }

  // 1.5 Handle scene cuts that occurred after the last detection frame:
  // When a genuine scene cut happens after detections cease, reset framing to neutral at the cut
  // rather than blindly coasting the previous shot's subject crop across the cut.
  const lastDetectionTime = validDetections.length > 0 ? validDetections[validDetections.length - 1].time : 0;
  const remainingCuts = cuts.filter((c) => c > lastDetectionTime && (!rawFrames.length || c > rawFrames.at(-1).time));

  for (const remainingCut of remainingCuts) {
    const prevFrame = rawFrames.at(-1);
    if (prevFrame) {
      const holdTime = Number(Math.max(prevFrame.time + 0.005, remainingCut - 0.03).toFixed(3));
      if (holdTime > prevFrame.time && rawFrames.at(-1).time < holdTime) {
        rawFrames.push({
          time: holdTime,
          ...prevFrame,
          isCut: false,
          cut: false,
        });
      }
    }

    const neutralCrop = solveFrameCrop(null, cropDims, { manualCropX, sourceSize });
    const cutTime = Number(remainingCut.toFixed(3));
    if (!rawFrames.length || rawFrames.at(-1).time < cutTime) {
      rawFrames.push({
        time: cutTime,
        ...neutralCrop,
        confidence: 0.5,
        isCut: true,
        cut: true,
        state: "fallback",
        isFallback: true,
        activeSpeakerId: null,
        speakerIdentified: false,
        isGroup: false,
        subjectId: null,
        trackId: null,
      });
    }
  }

  // 2. Ensure bounding keyframes exist at t = 0 and t = duration
  if (rawFrames[0].time > 0) {
    rawFrames.unshift({
      time: 0,
      ...rawFrames[0],
      time: 0,
      isCut: false,
      cut: false,
    });
  }

  const lastFrame = rawFrames[rawFrames.length - 1];
  if (lastFrame.time < safeDuration) {
    rawFrames.push({
      ...lastFrame,
      time: Number(safeDuration.toFixed(3)),
      isCut: false,
      cut: false,
    });
  }

  // 3. Compress redundant collinear keyframes
  const compressedKeyframes = compressCollinearKeyframes(rawFrames, 0.005);

  const formattedKeyframes = compressedKeyframes.map((kf) => ({
    time: kf.time,
    x: kf.x,
    y: kf.y,
    width: kf.width,
    height: kf.height,
    panFactor: Number.isFinite(kf.panFactor)
      ? kf.panFactor
      : ((1 - kf.width) > 0.0001 ? Number((kf.x / (1 - kf.width)).toFixed(4)) : 0.5),
    cropX: kf.x,
    cropY: kf.y,
    cropW: kf.width,
    cropH: kf.height,
    isCut: Boolean(kf.isCut || kf.cut),
    cut: Boolean(kf.isCut || kf.cut),
    confidence: kf.confidence ?? 1,
    state: kf.state || "tracked",
    activeSpeakerId: kf.activeSpeakerId ?? null,
    speakerIdentified: Boolean(kf.speakerIdentified),
    isGroup: Boolean(kf.isGroup),
    subjectId: kf.subjectId ?? null,
    trackId: kf.trackId ?? null,
  }));

  const norm = normalizeSmartFrame({
    version: 2,
    enabled: true,
    targetRatio: typeof targetRatio === "string" ? targetRatio : "9:16",
    presentation: "crop",
    sourceSize: {
      width: Number(sourceSize?.width) || 1920,
      height: Number(sourceSize?.height) || 1080,
    },
    cropKeyframes: formattedKeyframes,
    motion,
    metadata: {
      detectionsCount: validDetections.length,
      keyframesCount: formattedKeyframes.length,
      sceneCutsHandled: cuts.length,
      status: "tracked",
      speakerIdentified: formattedKeyframes.some((k) => k.speakerIdentified),
      activeSpeakerIds: Array.from(new Set(formattedKeyframes.map((k) => k.activeSpeakerId).filter(Boolean))),
    },
  });

  return {
    ...(norm || {}),
    mode: "face-track",
    isFallback: false,
    state: "tracked",
    confidence: 1,
    sourceStart: detectedStartTime,
    sourceSignature: {
      sourceStart: detectedStartTime,
      sourceDuration: safeDuration,
    },
    detectionCount: validDetections.length,
    cropDims,
    cropKeyframes: formattedKeyframes,
  };
}

/**
 * Generates a safe fallback reframing track centered on manualCropX.
 */
export function generateFallbackReframingTrack(sourceSize, targetRatio, duration, manualCropX = 0.5) {
  const safeDuration = Math.max(0.5, Number(duration) || 15);
  const cropDims = calculateTargetCropDimensions(sourceSize, targetRatio);
  const fallback = solveFrameCrop(null, cropDims, { manualCropX });

  const rawKeyframes = [
    { time: 0, ...fallback, confidence: 0, state: "fallback", cut: false },
    { time: Number(safeDuration.toFixed(3)), ...fallback, confidence: 0, state: "fallback", cut: false },
  ];

  const formattedKeyframes = rawKeyframes.map((kf) => ({
    time: kf.time,
    x: kf.x,
    y: kf.y,
    width: kf.width,
    height: kf.height,
    panFactor: kf.panFactor,
    cropX: kf.x,
    cropY: kf.y,
    cropW: kf.width,
    cropH: kf.height,
    cut: false,
    confidence: 0,
    state: "fallback",
  }));

  const norm = normalizeSmartFrame({
    version: 2,
    enabled: true,
    targetRatio: typeof targetRatio === "string" ? targetRatio : "9:16",
    presentation: "crop",
    state: "fallback",
    confidence: 0,
    sourceSize: {
      width: Number(sourceSize?.width) || 1920,
      height: Number(sourceSize?.height) || 1080,
    },
    cropKeyframes: formattedKeyframes,
    motion: "smooth",
    metadata: {
      detectionsCount: 0,
      keyframesCount: formattedKeyframes.length,
      sceneCutsHandled: 0,
      status: "fallback",
      isFallback: true,
    },
  });

  return {
    ...(norm || {}),
    mode: "center",
    isFallback: true,
    state: "fallback",
    confidence: 0,
    detectionCount: 0,
    cropDims,
    cropKeyframes: formattedKeyframes,
  };
}

/**
 * Distinguishes whether a candidate is genuinely on a fallback framing track
 * due to missing detections rather than an intentional user crop (e.g. center, safe-contain).
 */
export function isCandidateFallbackDueToMissingDetections(candidate, options = {}) {
  if (!candidate) return false;
  const framingMode = candidate.framingMode || options.settings?.autoReframing || "smart-zoom";
  if (!["smart-subject", "smart-zoom"].includes(framingMode)) {
    return false;
  }
  const sf = candidate.smartFrame;
  const isFallback = !sf ||
    sf.isFallback === true ||
    sf.state === "fallback" ||
    sf.metadata?.isFallback === true ||
    sf.metadata?.status === "fallback" ||
    candidate.trackingStatus === "fallback" ||
    candidate.trackingStatus === "no_subjects_found" ||
    candidate.trackingStatus === "unsupported" ||
    candidate.trackingStatus === "error";

  if (!isFallback) {
    const detectionsCount = sf?.metadata?.detectionsCount ?? sf?.detectionCount ?? 0;
    if (detectionsCount === 0 && Array.isArray(sf?.cropKeyframes)) {
      if (sf.cropKeyframes.every((k) => k.isFallback || k.state === "fallback" || ((k.confidence ?? 0) <= 0.5 && Math.abs((k.panFactor ?? 0.5) - 0.5) < 0.005))) {
        return true;
      }
    }
    return false;
  }

  const detections = [
    ...(Array.isArray(candidate.faceDetections) ? candidate.faceDetections : []),
    ...(Array.isArray(options.faceDetections) ? options.faceDetections : []),
    ...(Array.isArray(options.sourceDetections) ? options.sourceDetections : []),
  ];

  if (detections.length > 0 && hasAdequateCandidateDetections(candidate, detections)) {
    return false;
  }

  return true;
}

/**
 * Evaluates whether a set of detections provides adequate temporal density and start-coverage
 * for tracking a candidate short, preventing coarse 10+ second discovery samples from masquerading
 * as dense per-second tracking data.
 */
export function hasAdequateCandidateDetections(candidate, detections = []) {
  if (!candidate || !Array.isArray(detections) || detections.length === 0) return false;
  const start = Math.max(0, Number(candidate.startTime) || 0);
  const end = Math.max(start + 0.1, Number(candidate.endTime) || (start + (Number(candidate.duration) || 0)));
  const duration = end - start;

  const inWindow = detections
    .filter((d) => {
      if (!isGenuineFaceDetection(d)) return false;
      const t = Number(d?.time ?? d?.timestamp);
      return Number.isFinite(t) && t >= start - 0.15 && t <= end + 0.15;
    })
    .sort((a, b) => Number(a.time ?? a.timestamp) - Number(b.time ?? b.timestamp));

  if (inWindow.length === 0) return false;

  // Must have detection coverage near the start of the candidate
  const firstTime = Number(inWindow[0].time ?? inWindow[0].timestamp);
  if (firstTime > start + 2.5) {
    return false;
  }

  // Minimum required count based on duration (at least 1 detection per ~3.0s, min 3)
  const minRequiredCount = Math.min(8, Math.max(3, Math.ceil(duration / 3.0)));
  if (inWindow.length < minRequiredCount) {
    return false;
  }

  // Maximum gap between consecutive detections should not exceed 4.5s
  for (let i = 1; i < inWindow.length; i++) {
    const prevT = Number(inWindow[i - 1].time ?? inWindow[i - 1].timestamp);
    const currT = Number(inWindow[i].time ?? inWindow[i].timestamp);
    if (currT - prevT > 4.5) {
      return false;
    }
  }

  return true;
}

/**
 * Checks whether a candidate short needs a targeted subject detection pass.
 */
export function needsTargetedSubjectAnalysis(candidate, sourceDetections = [], options = {}) {
  if (!candidate) return false;
  const framingMode = candidate.framingMode || options.settings?.autoReframing || "smart-zoom";
  if (!["smart-subject", "smart-zoom"].includes(framingMode)) {
    return false;
  }
  const allDetections = [
    ...(Array.isArray(candidate.faceDetections) ? candidate.faceDetections : []),
    ...(Array.isArray(sourceDetections) ? sourceDetections : []),
    ...(Array.isArray(options.faceDetections) ? options.faceDetections : []),
  ];
  if (hasAdequateCandidateDetections(candidate, allDetections)) {
    return false;
  }
  return true;
}

/**
 * Applies a reframing track to an AI Shorts Studio candidate.
 */
export function applyDynamicReframingToCandidate(candidate, reframingTrackOrDetections, options = {}) {
  if (!candidate) return candidate;

  let track = reframingTrackOrDetections;
  if (!track || Array.isArray(track) || !track.cropKeyframes) {
    const detections = Array.isArray(track) ? track : [];
    const candidateStart = Number(candidate.startTime) || 0;
    const duration = Math.max(0.5, (Number(candidate.endTime) || 0) - candidateStart || 15);
    track = buildDynamicReframingTrack({
      detections,
      duration,
      startTime: candidateStart,
      sourceStart: candidateStart,
      sourceSize: options.sourceSize || { width: 1920, height: 1080 },
      targetRatio: options.targetRatio || candidate.aspectRatio || "9:16",
      sceneCuts: options.sceneCuts || candidate.sceneCuts || [],
      motion: options.motion || "smooth",
      manualCropX: candidate.cropX ?? 0.5,
      userSelectedSubject: options.userSelectedSubject ?? candidate.userSelectedSubject ?? candidate.targetSubject,
    });
  }

  const keyframes = track?.cropKeyframes || [];
  let avgCropX = 0.5;

  if (keyframes.length > 0) {
    const first = keyframes[0];
    const w = first.width || 1.0;
    avgCropX = (1 - w) > 0.0001 ? Number((first.x / (1 - w)).toFixed(3)) : 0.5;
  }

  return {
    ...candidate,
    cropX: avgCropX,
    smartFrame: track,
    cropKeyframes: keyframes,
  };
}

/**
 * Builds an FFmpeg dynamic crop filter expression from a smartFrame record.
 * Falls back to static crop offset if only static crop coordinates exist.
 */
export function buildReframingFFmpegCropFilter(smartFrame, width = 1080, height = 1920, clipDuration = 15) {
  let targetW = width;
  let targetH = height;

  const frames = smartFrame?.cropKeyframes;
  if (!Array.isArray(frames) || frames.length === 0) return "";

  // Check if single keyframe or all keyframes share the exact same x and y (static crop)
  const first = frames[0];
  const isStatic = frames.length === 1 || frames.every((f) => Math.abs(f.x - first.x) < 0.002 && Math.abs(f.y - first.y) < 0.002);
  if (isStatic) {
    const w0 = first.width || 1.0;
    const h0 = first.height || 1.0;
    const pan0 = Number.isFinite(first.panFactor)
      ? first.panFactor
      : ((1 - w0) > 0.0001 ? first.x / (1 - w0) : 0.5);
    const panY0 = Number.isFinite(first.panY)
      ? first.panY
      : ((1 - h0) > 0.0001 ? first.y / (1 - h0) : 0.5);
    return `crop=${targetW}:${targetH}:(in_w-out_w)*${pan0.toFixed(4)}:(in_h-out_h)*${panY0.toFixed(4)},`;
  }

  // Dynamic pan expression in FFmpeg (normalize against base timestamp if keyframes are source-offset)
  const baseTime = first.time > 0.05 ? first.time : 0;
  const xExpressions = [];
  const yExpressions = [];
  for (let i = 0; i < frames.length - 1; i++) {
    const f0 = frames[i];
    const f1 = frames[i + 1];
    const t0 = Math.max(0, f0.time - baseTime).toFixed(3);
    const t1 = Math.max(0, f1.time - baseTime).toFixed(3);
    const dt = (f1.time - f0.time).toFixed(3);

    if (f1.time - f0.time <= 0.001) continue;

    const w0 = f0.width || 1.0;
    const w1 = f1.width || 1.0;
    const h0 = f0.height || 1.0;
    const h1 = f1.height || 1.0;
    const pan0 = (1 - w0) > 0.0001 ? f0.x / (1 - w0) : 0.5;
    const pan1 = (1 - w1) > 0.0001 ? f1.x / (1 - w1) : 0.5;
    const panY0 = (1 - h0) > 0.0001 ? f0.y / (1 - h0) : 0.5;
    const panY1 = (1 - h1) > 0.0001 ? f1.y / (1 - h1) : 0.5;
    const p0Str = pan0.toFixed(4);
    const p1Str = pan1.toFixed(4);
    const py0Str = panY0.toFixed(4);
    const py1Str = panY1.toFixed(4);

    // If f1 is a shot cut or subject switch, hold p0 until t1 instead of linearly sweeping through the space between people!
    const isCut = Boolean(f1.cut || f1.isCut);
    const termX = isCut
      ? `between(t,${t0},${t1})*(${p0Str}*(in_w-out_w))`
      : `between(t,${t0},${t1})*((${p0Str}+(${p1Str}-${p0Str})*(t-${t0})/${dt})*(in_w-out_w))`;
    xExpressions.push(termX);

    const termY = isCut
      ? `between(t,${t0},${t1})*(${py0Str}*(in_h-out_h))`
      : `between(t,${t0},${t1})*((${py0Str}+(${py1Str}-${py0Str})*(t-${t0})/${dt})*(in_h-out_h))`;
    yExpressions.push(termY);
  }

  if (!xExpressions.length) return "";

  const finalExprX = xExpressions.join("+");
  const finalExprY = yExpressions.length ? yExpressions.join("+") : "(in_h-out_h)/2";
  return `crop=${targetW}:${targetH}:'${finalExprX}':'${finalExprY}',`;
}
