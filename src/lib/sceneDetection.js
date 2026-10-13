/**
 * @file sceneDetection.js
 * AI Video Editor — Phase 1: Scene Detection Engine.
 *
 * Provides a deterministic, configurable scene detection engine based on
 * normalized 3D color histogram (with trilinear soft binning) and spatial color
 * difference metrics. Operates purely on frame signatures/pixel buffers in
 * headless environments, with a browser video extraction adapter for
 * HTMLVideoElement and media URLs.
 */

export const DEFAULT_SCENE_DETECTION_SETTINGS = {
  sampleInterval: 0.5,     // Sample interval in seconds (2 fps)
  threshold: 0.30,         // Visual difference score threshold [0.0 - 1.0]
  minSceneDuration: 1.0,   // Minimum duration of any detected scene in seconds
  startGuard: 0.5,         // Exclude cut boundaries within the first N seconds
  endGuard: 0.5,           // Exclude cut boundaries within the last N seconds
  maxSamples: 1200,        // Maximum number of sample frames to evaluate
};

export {
  validateSceneCutBoundaries,
  splitVisualSegmentAtBoundaries,
} from "./timelineCutActions.js";

/**
 * Normalizes and validates user-provided settings against defaults.
 *
 * @param {Object} [userSettings={}]
 * @returns {typeof DEFAULT_SCENE_DETECTION_SETTINGS}
 */
export function normalizeSceneDetectionSettings(userSettings = {}) {
  const rawInterval = Number(userSettings.sampleInterval);
  const sampleInterval = Number.isFinite(rawInterval) && rawInterval > 0
    ? Math.max(0.05, rawInterval)
    : DEFAULT_SCENE_DETECTION_SETTINGS.sampleInterval;

  const rawThreshold = Number(userSettings.threshold);
  const threshold = Number.isFinite(rawThreshold) && rawThreshold >= 0
    ? Math.min(1.0, Math.max(0.01, rawThreshold))
    : DEFAULT_SCENE_DETECTION_SETTINGS.threshold;

  const rawMinDuration = Number(userSettings.minSceneDuration);
  const minSceneDuration = Number.isFinite(rawMinDuration) && rawMinDuration > 0
    ? Math.max(0.1, rawMinDuration)
    : DEFAULT_SCENE_DETECTION_SETTINGS.minSceneDuration;

  const rawStartGuard = Number(userSettings.startGuard);
  const startGuard = Number.isFinite(rawStartGuard) && rawStartGuard >= 0
    ? rawStartGuard
    : DEFAULT_SCENE_DETECTION_SETTINGS.startGuard;

  const rawEndGuard = Number(userSettings.endGuard);
  const endGuard = Number.isFinite(rawEndGuard) && rawEndGuard >= 0
    ? rawEndGuard
    : DEFAULT_SCENE_DETECTION_SETTINGS.endGuard;

  const rawMaxSamples = Number(userSettings.maxSamples);
  const maxSamples = Number.isFinite(rawMaxSamples) && rawMaxSamples > 0
    ? Math.max(2, Math.floor(rawMaxSamples))
    : DEFAULT_SCENE_DETECTION_SETTINGS.maxSamples;

  return {
    sampleInterval,
    threshold,
    minSceneDuration,
    startGuard,
    endGuard,
    maxSamples,
  };
}

/**
 * Computes a lightweight visual signature for an image or pixel buffer.
 * Uses a 4x4x4 3D color histogram (64 bins) with trilinear soft binning
 * (to prevent discretization artifacts) and an 8x8 spatial color grid.
 *
 * @param {ImageData|Uint8Array|Uint8ClampedArray|Array|Object} imageDataOrPixels
 * @param {number} [width=64]
 * @param {number} [height=36]
 * @returns {{ histogram: Float64Array, spatialGrid: Float64Array, averageLuminance: number }}
 */
export function computeFrameSignature(imageDataOrPixels, width = 64, height = 36) {
  if (!imageDataOrPixels) {
    throw new Error("INVALID_FRAME_DATA: Frame data must not be null or undefined");
  }

  let data;
  let w = width;
  let h = height;

  if (imageDataOrPixels.data && Number.isFinite(imageDataOrPixels.width)) {
    data = imageDataOrPixels.data;
    w = imageDataOrPixels.width;
    h = imageDataOrPixels.height;
  } else if (ArrayBuffer.isView(imageDataOrPixels) || Array.isArray(imageDataOrPixels)) {
    data = imageDataOrPixels;
  } else {
    throw new Error("INVALID_FRAME_DATA: Unsupported frame data format");
  }

  const totalPixels = Math.max(1, Math.floor(data.length / 4));
  const numBins = 4; // 4x4x4 = 64 color cube bins
  const histogram = new Float64Array(64);
  const gridRows = 8;
  const gridCols = 8;
  const spatialGrid = new Float64Array(gridRows * gridCols * 3);
  const cellCounts = new Int32Array(gridRows * gridCols);

  let totalLuminanceSum = 0;

  for (let i = 0; i < totalPixels; i++) {
    const offset = i * 4;
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];

    // Trilinear soft distribution into 4x4x4 color cube (bins 0..3 per channel)
    const rPos = (r / 255) * (numBins - 1);
    const rLow = Math.floor(rPos);
    const rHigh = Math.min(numBins - 1, rLow + 1);
    const rFrac = rPos - rLow;

    const gPos = (g / 255) * (numBins - 1);
    const gLow = Math.floor(gPos);
    const gHigh = Math.min(numBins - 1, gLow + 1);
    const gFrac = gPos - gLow;

    const bPos = (b / 255) * (numBins - 1);
    const bLow = Math.floor(bPos);
    const bHigh = Math.min(numBins - 1, bLow + 1);
    const bFrac = bPos - bLow;

    const w000 = (1 - rFrac) * (1 - gFrac) * (1 - bFrac);
    const w001 = (1 - rFrac) * (1 - gFrac) * bFrac;
    const w010 = (1 - rFrac) * gFrac * (1 - bFrac);
    const w011 = (1 - rFrac) * gFrac * bFrac;
    const w100 = rFrac * (1 - gFrac) * (1 - bFrac);
    const w101 = rFrac * (1 - gFrac) * bFrac;
    const w110 = rFrac * gFrac * (1 - bFrac);
    const w111 = rFrac * gFrac * bFrac;

    histogram[(rLow << 4) | (gLow << 2) | bLow] += w000;
    histogram[(rLow << 4) | (gLow << 2) | bHigh] += w001;
    histogram[(rLow << 4) | (gHigh << 2) | bLow] += w010;
    histogram[(rLow << 4) | (gHigh << 2) | bHigh] += w011;
    histogram[(rHigh << 4) | (gLow << 2) | bLow] += w100;
    histogram[(rHigh << 4) | (gLow << 2) | bHigh] += w101;
    histogram[(rHigh << 4) | (gHigh << 2) | bLow] += w110;
    histogram[(rHigh << 4) | (gHigh << 2) | bHigh] += w111;

    // Perceptual luminance (ITU-R BT.601) normalized to 0.0 - 1.0
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    totalLuminanceSum += lum;

    // Spatial grid mapping
    const pixelX = i % w;
    const pixelY = Math.floor(i / w);
    const col = Math.min(gridCols - 1, Math.floor((pixelX / w) * gridCols));
    const row = Math.min(gridRows - 1, Math.floor((pixelY / h) * gridRows));
    const cellIdx = row * gridCols + col;

    spatialGrid[cellIdx * 3] += r / 255;
    spatialGrid[cellIdx * 3 + 1] += g / 255;
    spatialGrid[cellIdx * 3 + 2] += b / 255;
    cellCounts[cellIdx]++;
  }

  // Normalize 3D histogram so sum(histogram) === 1.0
  for (let b = 0; b < 64; b++) {
    histogram[b] = histogram[b] / totalPixels;
  }

  // Normalize spatial grid cell averages
  for (let c = 0; c < gridRows * gridCols; c++) {
    const cnt = cellCounts[c] || 1;
    spatialGrid[c * 3] /= cnt;
    spatialGrid[c * 3 + 1] /= cnt;
    spatialGrid[c * 3 + 2] /= cnt;
  }

  const averageLuminance = totalLuminanceSum / totalPixels;

  return {
    histogram,
    spatialGrid,
    averageLuminance,
  };
}

/**
 * Computes the normalized visual difference between two frame signatures.
 * Returns a score between 0.0 (identical) and 1.0 (completely distinct).
 *
 * @param {Object} sigA
 * @param {Object} sigB
 * @returns {{ score: number, histDiff: number, spatialDiff: number }}
 */
export function computeFrameDifference(sigA, sigB) {
  if (!sigA || !sigB) {
    return { score: 0, histDiff: 0, spatialDiff: 0 };
  }

  // 1. Normalized Manhattan (L1) distance of 3D color histograms
  // sum(|ha - hb|) ranges from 0 to 2 for probability vectors, so multiply by 0.5
  let histDiffSum = 0;
  for (let i = 0; i < 64; i++) {
    histDiffSum += Math.abs(sigA.histogram[i] - sigB.histogram[i]);
  }
  const histDiff = Math.min(1.0, 0.5 * histDiffSum);

  // 2. Mean absolute difference of spatial color cells
  let spatialDiffSum = 0;
  const gridLen = sigA.spatialGrid.length;
  for (let j = 0; j < gridLen; j++) {
    spatialDiffSum += Math.abs(sigA.spatialGrid[j] - sigB.spatialGrid[j]);
  }
  const spatialDiff = Math.min(1.0, spatialDiffSum / gridLen);

  // 3. Combined weighted difference: 60% color distribution, 40% spatial layout
  const score = Math.min(1.0, Math.max(0.0, 0.60 * histDiff + 0.40 * spatialDiff));

  return {
    score: Number(score.toFixed(4)),
    histDiff: Number(histDiff.toFixed(4)),
    spatialDiff: Number(spatialDiff.toFixed(4)),
  };
}

/**
 * Calculates a heuristic confidence score based on the difference score relative to the threshold.
 * Note: This represents relative transition strength above the threshold, not a calibrated Bayesian probability.
 *
 * @param {number} score - Frame difference score [0.0 - 1.0]
 * @param {number} threshold - Detection threshold [0.0 - 1.0]
 * @returns {number} Confidence metric [0.0 - 1.0]
 */
export function computeConfidence(score, threshold) {
  if (score < threshold) return 0;
  const headroom = Math.max(0.001, 1.0 - threshold);
  const excess = (score - threshold) / headroom;
  // Baseline confidence 0.50 at the threshold, scaling up to 1.00 at maximum visual change
  const confidence = 0.50 + 0.50 * excess;
  return Number(Math.min(1.0, Math.max(0.0, confidence)).toFixed(3));
}

/**
 * Generates an array of sample timestamps in seconds for a given video duration.
 *
 * @param {number} duration - Video duration in seconds
 * @param {Object} [settings={}] - Configuration overrides
 * @returns {number[]} Array of timestamps in seconds
 */
export function generateSampleTimes(duration, settings = {}) {
  const safeDuration = Number(duration);
  if (!Number.isFinite(safeDuration) || safeDuration <= 0) {
    return [];
  }

  const { sampleInterval, maxSamples } = normalizeSceneDetectionSettings(settings);
  const count = Math.min(
    maxSamples,
    Math.max(1, Math.floor(safeDuration / sampleInterval) + 1),
  );

  const times = [];
  for (let i = 0; i < count; i++) {
    const t = Number((i * sampleInterval).toFixed(3));
    if (t > safeDuration) break;
    times.push(t);
  }

  // Ensure duration boundary is represented if space remains
  if (times.length > 0 && times[times.length - 1] < safeDuration && times.length < maxSamples) {
    times.push(Number(safeDuration.toFixed(3)));
  }

  return times;
}

/**
 * Pure analysis function: detects scene boundaries from pre-extracted frame signatures.
 *
 * @param {Array<{ time: number, signature: Object }>} samples - Array of timestamped frame signatures
 * @param {Object} options - Analysis options
 * @param {number} options.duration - Total video duration in seconds
 * @returns {Object} Scene detection result containing duration, scenes, boundaries, settings, and stats
 */
export function detectScenesFromSignatures(samples = [], options = {}) {
  const startTime = Date.now();
  const rawDuration = Number(options?.duration);
  const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? Number(rawDuration.toFixed(3)) : 0;
  const settings = normalizeSceneDetectionSettings(options);

  if (duration <= 0 || !Array.isArray(samples) || samples.length === 0) {
    return {
      duration,
      scenes: duration > 0 ? [{ index: 0, start: 0, end: duration, duration }] : [],
      boundaries: [],
      settings,
      stats: {
        samplesAnalyzed: 0,
        durationProcessed: duration,
        processingTimeMs: Date.now() - startTime,
        cutsDetected: 0,
        maxDifferenceScore: 0,
        averageDifferenceScore: 0,
      },
    };
  }

  // Sort samples chronologically
  const sortedSamples = [...samples].sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0));

  if (sortedSamples.length < 2) {
    return {
      duration,
      scenes: [{ index: 0, start: 0, end: duration, duration }],
      boundaries: [],
      settings,
      stats: {
        samplesAnalyzed: sortedSamples.length,
        durationProcessed: duration,
        processingTimeMs: Date.now() - startTime,
        cutsDetected: 0,
        maxDifferenceScore: 0,
        averageDifferenceScore: 0,
      },
    };
  }

  let maxScore = 0;
  let totalScore = 0;
  const rawCandidates = [];

  for (let i = 1; i < sortedSamples.length; i++) {
    const prev = sortedSamples[i - 1];
    const curr = sortedSamples[i];
    const { score } = computeFrameDifference(prev.signature, curr.signature);

    if (score > maxScore) maxScore = score;
    totalScore += score;

    const transitionTime = Number(Number(curr.time).toFixed(3));

    if (score >= settings.threshold) {
      rawCandidates.push({
        time: transitionTime,
        score,
        prevTime: Number(Number(prev.time).toFixed(3)),
      });
    }
  }

  const comparisonsCount = sortedSamples.length - 1;
  const avgScore = comparisonsCount > 0 ? totalScore / comparisonsCount : 0;

  // 1. Exclude boundaries too close to video start or end
  const guardedCandidates = rawCandidates.filter((cand) => {
    const isAfterStartGuard = cand.time >= settings.startGuard;
    const isBeforeEndGuard = cand.time <= duration - settings.endGuard;
    return isAfterStartGuard && isBeforeEndGuard;
  });

  // 2. Non-maximum suppression / duplicate boundary debounce
  // Multiple samples spanning a cut or transition should not produce multiple duplicate cuts
  const debounceWindow = Math.max(0.4, settings.sampleInterval * 1.5);
  const deduplicated = [];

  if (guardedCandidates.length > 0) {
    let currentCluster = [guardedCandidates[0]];

    for (let i = 1; i < guardedCandidates.length; i++) {
      const cand = guardedCandidates[i];
      const prevCand = guardedCandidates[i - 1];

      if (cand.time - prevCand.time <= debounceWindow) {
        currentCluster.push(cand);
      } else {
        // Pick peak candidate in the cluster
        currentCluster.sort((a, b) => b.score - a.score);
        deduplicated.push(currentCluster[0]);
        currentCluster = [cand];
      }
    }

    if (currentCluster.length > 0) {
      currentCluster.sort((a, b) => b.score - a.score);
      deduplicated.push(currentCluster[0]);
    }
  }

  // 3. Enforce minimum scene duration
  // Greedily prioritize higher-confidence boundaries and discard any boundary
  // that would create an interval shorter than minSceneDuration
  const sortedByScore = [...deduplicated].sort((a, b) => b.score - a.score);
  const acceptedBoundaries = [];

  for (const cand of sortedByScore) {
    // Check distance from video start and end
    if (cand.time < settings.minSceneDuration) continue;
    if (duration - cand.time < settings.minSceneDuration) continue;

    // Check distance from all already-accepted boundaries
    const conflicts = acceptedBoundaries.some(
      (acc) => Math.abs(acc.time - cand.time) < settings.minSceneDuration,
    );

    if (!conflicts) {
      acceptedBoundaries.push(cand);
    }
  }

  // 4. Sort accepted boundaries chronologically
  acceptedBoundaries.sort((a, b) => a.time - b.time);

  const formattedBoundaries = acceptedBoundaries.map((b) => ({
    time: b.time,
    score: b.score,
    confidence: computeConfidence(b.score, settings.threshold),
    transitionType: "cut",
  }));

  // 5. Construct contiguous scene intervals
  const scenes = [];
  let currentStart = 0;

  for (let s = 0; s < formattedBoundaries.length; s++) {
    const boundaryTime = formattedBoundaries[s].time;
    scenes.push({
      index: s,
      start: currentStart,
      end: boundaryTime,
      duration: Number((boundaryTime - currentStart).toFixed(3)),
    });
    currentStart = boundaryTime;
  }

  scenes.push({
    index: scenes.length,
    start: currentStart,
    end: duration,
    duration: Number((duration - currentStart).toFixed(3)),
  });

  return {
    duration,
    scenes,
    boundaries: formattedBoundaries,
    settings,
    stats: {
      samplesAnalyzed: sortedSamples.length,
      durationProcessed: duration,
      processingTimeMs: Date.now() - startTime,
      cutsDetected: formattedBoundaries.length,
      maxDifferenceScore: Number(maxScore.toFixed(4)),
      averageDifferenceScore: Number(avgScore.toFixed(4)),
    },
  };
}

/**
 * Creates an AbortError with consistent naming across browser and Node.js.
 *
 * @param {string} [message="Scene detection aborted"]
 * @returns {Error}
 */
function createAbortError(message = "Scene detection aborted") {
  if (typeof DOMException !== "undefined") {
    return new DOMException(message, "AbortError");
  }
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

/**
 * Streaming scene detection: processes frame-by-frame via a frame provider callback.
 * Ensures bounded memory consumption by retaining only the previous frame signature in memory.
 *
 * @param {Function} frameProvider - Async callback `async (timestamp, index) => FrameSignature|ImageData`
 * @param {Object} options - Analysis options
 * @param {number} options.duration - Video duration in seconds
 * @param {AbortSignal} [options.signal] - Cancellation signal
 * @param {Function} [options.onProgress] - Optional progress callback `(progressPercent, meta) => void`
 * @returns {Promise<Object>} Scene detection result
 */
export async function detectScenesStream(frameProvider, options = {}) {
  const startTime = Date.now();
  const signal = options?.signal;
  const onProgress = typeof options?.onProgress === "function" ? options.onProgress : null;

  if (signal?.aborted) {
    throw createAbortError();
  }

  const rawDuration = Number(options?.duration);
  const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? Number(rawDuration.toFixed(3)) : 0;
  const settings = normalizeSceneDetectionSettings(options);

  if (duration <= 0 || typeof frameProvider !== "function") {
    return {
      duration,
      scenes: duration > 0 ? [{ index: 0, start: 0, end: duration, duration }] : [],
      boundaries: [],
      settings,
      stats: {
        samplesAnalyzed: 0,
        durationProcessed: duration,
        processingTimeMs: Date.now() - startTime,
        cutsDetected: 0,
        maxDifferenceScore: 0,
        averageDifferenceScore: 0,
      },
    };
  }

  const sampleTimes = generateSampleTimes(duration, settings);
  const collectedSamples = [];
  let failedSamples = 0;

  for (let i = 0; i < sampleTimes.length; i++) {
    if (signal?.aborted) {
      throw createAbortError();
    }

    const t = sampleTimes[i];
    let rawFrame;

    try {
      rawFrame = await frameProvider(t, i);
    } catch {
      if (signal?.aborted) throw createAbortError();
      failedSamples++;
      if (onProgress) {
        const processed = i + 1;
        const total = sampleTimes.length;
        const progress = Math.min(100, Math.max(0, Math.round((processed / total) * 100)));
        try {
          onProgress(progress, { processed, total, time: t, failed: true });
        } catch {
          // Callback exceptions must not disrupt frame sampling
        }
      }
      continue;
    }

    if (!rawFrame) {
      failedSamples++;
      if (onProgress) {
        const processed = i + 1;
        const total = sampleTimes.length;
        const progress = Math.min(100, Math.max(0, Math.round((processed / total) * 100)));
        try {
          onProgress(progress, { processed, total, time: t, failed: true });
        } catch {
          // Callback exceptions must not disrupt frame sampling
        }
      }
      continue;
    }

    // Convert raw frame to signature if not already computed
    const signature = rawFrame.histogram && rawFrame.spatialGrid
      ? rawFrame
      : computeFrameSignature(rawFrame);

    collectedSamples.push({
      time: t,
      signature,
    });

    if (onProgress) {
      const processed = i + 1;
      const total = sampleTimes.length;
      const progress = Math.min(100, Math.max(0, Math.round((processed / total) * 100)));
      try {
        onProgress(progress, { processed, total, time: t, failed: false });
      } catch {
        // Callback exceptions must not disrupt frame sampling
      }
    }
  }

  const result = detectScenesFromSignatures(collectedSamples, {
    ...settings,
    duration,
  });

  result.stats.processingTimeMs = Date.now() - startTime;
  result.stats.failedSamples = failedSamples;

  return result;
}

/**
 * Browser frame extraction adapter.
 * Uses a small offscreen canvas (64x36) and sequential video seeking to analyze
 * videos with minimal CPU and memory overhead.
 *
 * @param {HTMLVideoElement|string|Blob|File} videoSource
 * @param {Object} options
 * @param {number} [options.duration] - Optional video duration in seconds (retrieved from video element if omitted)
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.onProgress] - Optional progress callback `(progressPercent, meta) => void`
 * @returns {Promise<Object>} Scene detection result
 */
export async function detectVideoScenes(videoSource, options = {}) {
  const signal = options?.signal;
  if (signal?.aborted) throw createAbortError();

  if (typeof document === "undefined") {
    throw new Error(
      "ENVIRONMENT_UNSUPPORTED: detectVideoScenes requires a browser DOM environment. " +
      "Use detectScenesFromSignatures or detectScenesStream for headless and server environments.",
    );
  }

  let videoElement = null;
  let createdVideo = false;
  let objectUrl = null;

  try {
    if (typeof HTMLVideoElement !== "undefined" && videoSource instanceof HTMLVideoElement) {
      videoElement = videoSource;
    } else {
      videoElement = document.createElement("video");
      createdVideo = true;
      videoElement.muted = true;
      videoElement.playsInline = true;
      videoElement.crossOrigin = "anonymous";
      videoElement.preload = "auto";

      if (typeof videoSource === "string") {
        videoElement.src = videoSource;
      } else if (typeof Blob !== "undefined" && videoSource instanceof Blob) {
        objectUrl = URL.createObjectURL(videoSource);
        videoElement.src = objectUrl;
      } else {
        throw new Error("UNSUPPORTED_VIDEO_SOURCE: Must be an HTMLVideoElement, media URL string, or Blob");
      }

      await new Promise((resolve, reject) => {
        const cleanup = () => {
          videoElement.removeEventListener("loadedmetadata", onLoaded);
          videoElement.removeEventListener("error", onError);
          signal?.removeEventListener("abort", onAbort);
        };
        const onLoaded = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); reject(new Error("VIDEO_LOAD_FAILED: Unable to load video metadata")); };
        const onAbort = () => { cleanup(); reject(createAbortError()); };

        videoElement.addEventListener("loadedmetadata", onLoaded, { once: true });
        videoElement.addEventListener("error", onError, { once: true });
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }

    if (signal?.aborted) throw createAbortError();

    const videoDuration = Number(options?.duration) || Number(videoElement.duration) || 0;
    if (!Number.isFinite(videoDuration) || videoDuration <= 0) {
      throw new Error("INVALID_DURATION: Video duration must be a finite positive number");
    }

    // Downscaled offscreen canvas for fast sampling
    const width = 64;
    const height = 36;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    if (!ctx) {
      throw new Error("CANVAS_CONTEXT_FAILED: Unable to create 2D canvas context");
    }

    const seekAndCapture = async (time) => {
      if (signal?.aborted) throw createAbortError();

      const target = Math.max(0, Math.min(time, Math.max(0, videoDuration - 0.005)));
      if (Math.abs(videoElement.currentTime - target) > 0.01) {
        await new Promise((resolve, reject) => {
          const cleanup = () => {
            videoElement.removeEventListener("seeked", onSeeked);
            videoElement.removeEventListener("error", onError);
            signal?.removeEventListener("abort", onAbort);
          };
          const onSeeked = () => { cleanup(); resolve(); };
          const onError = () => { cleanup(); reject(new Error("SEEK_FAILED")); };
          const onAbort = () => { cleanup(); reject(createAbortError()); };

          videoElement.addEventListener("seeked", onSeeked, { once: true });
          videoElement.addEventListener("error", onError, { once: true });
          signal?.addEventListener("abort", onAbort, { once: true });

          videoElement.currentTime = target;
        });
      }

      if (signal?.aborted) throw createAbortError();

      ctx.drawImage(videoElement, 0, 0, width, height);
      return ctx.getImageData(0, 0, width, height);
    };

    return await detectScenesStream(seekAndCapture, {
      ...options,
      duration: videoDuration,
    });
  } finally {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }
    if (createdVideo && videoElement) {
      videoElement.src = "";
      videoElement.load();
    }
  }
}
