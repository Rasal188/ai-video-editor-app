/**
 * @file shortsFaceDetection.js
 * In-browser local face and person detection for AI Shorts Studio.
 *
 * Responsibilities:
 * 1. Checks for local browser detection support (Chromium Shape Detection API / globalThis.FaceDetector).
 * 2. Samples video frames at controlled, bounded intervals to avoid UI lockup and memory exhaustion.
 * 3. Extracts normalized bounding boxes [0, 1] aligned with the shared reframing pipeline.
 * 4. Provides safe graceful fallback and explicit status when detection is unsupported.
 * 5. Supports AbortSignal cancellation, progress reporting, and deterministic test injection.
 */

import { analyzeVisualSubject } from "./vision.js";

const DEFAULT_SAMPLE_INTERVAL_SECONDS = 1.25;
const MIN_SAMPLE_INTERVAL_SECONDS = 0.5;
const MAX_SAMPLES_LIMIT = 48;
const DETECTION_CANVAS_MAX_DIMENSION = 360;

/**
 * Checks whether the browser natively supports the Shape Detection API (FaceDetector).
 * @returns {boolean}
 */
export function isNativeFaceDetectorSupported() {
  return typeof globalThis !== "undefined" && typeof globalThis.FaceDetector === "function";
}

/**
 * Checks whether the local Web Worker vision analysis pipeline is available.
 * @returns {boolean}
 */
export function isVisionSubjectAnalysisSupported() {
  return typeof Worker !== "undefined";
}

/**
 * Checks whether any local face or person detection mechanism is available.
 * @returns {boolean}
 */
export function isLocalDetectionSupported() {
  return isNativeFaceDetectorSupported() || isVisionSubjectAnalysisSupported();
}

let cachedDetector = undefined;

/**
 * Gets or initializes the cached native FaceDetector instance.
 * @returns {object|null}
 */
export function getNativeFaceDetector() {
  if (cachedDetector !== undefined) return cachedDetector;
  if (!isNativeFaceDetectorSupported()) {
    cachedDetector = null;
    return null;
  }
  try {
    cachedDetector = new globalThis.FaceDetector({ fastMode: true, maxDetectedFaces: 5 });
  } catch (err) {
    console.warn("[shortsFaceDetection] Could not instantiate native FaceDetector:", err?.message);
    cachedDetector = null;
  }
  return cachedDetector;
}

/**
 * Computes a bounded set of sample timestamps across the duration.
 *
 * @param {object} params
 * @param {number} [params.startTime=0] - Offset start time in seconds
 * @param {number} params.duration - Video duration in seconds
 * @param {number} [params.interval=1.25] - Target interval between sampled frames in seconds
 * @param {number} [params.maxSamples=48] - Hard cap on number of sampled frames
 * @returns {Array<number>} Array of ascending timestamps in seconds
 */
export function calculateSampleTimestamps({
  startTime = 0,
  duration = 0,
  interval = DEFAULT_SAMPLE_INTERVAL_SECONDS,
  maxSamples = MAX_SAMPLES_LIMIT,
  sceneCuts = [],
} = {}) {
  const safeStart = Number.isFinite(Number(startTime)) ? Math.max(0, Number(startTime)) : 0;
  const safeDuration = Number.isFinite(Number(duration)) ? Math.max(0, Number(duration)) : 0;
  if (safeDuration <= 0.05) return [Number(safeStart.toFixed(3))];

  const safeInterval = Math.max(MIN_SAMPLE_INTERVAL_SECONDS, Number(interval) || DEFAULT_SAMPLE_INTERVAL_SECONDS);
  const targetCount = Math.ceil(safeDuration / safeInterval) + 1;
  const count = Math.max(2, Math.min(maxSamples, targetCount));

  const times = [];
  const step = safeDuration / (count - 1);
  for (let i = 0; i < count; i++) {
    const t = i === count - 1 ? Math.max(safeStart, safeStart + safeDuration - 0.02) : safeStart + i * step;
    times.push(Number(t.toFixed(3)));
  }

  // If scene cut timestamps are provided, sample shortly after each cut (+0.08s)
  // to ensure the new shot has fresh detection data at the start of the cut.
  if (Array.isArray(sceneCuts)) {
    sceneCuts.forEach((cut) => {
      const c = Number(cut);
      if (Number.isFinite(c) && c >= safeStart && c < safeStart + safeDuration - 0.1) {
        times.push(Number((c + 0.08).toFixed(3)));
      }
    });
  }

  // Deduplicate and ensure ascending order
  return Array.from(new Set(times)).sort((a, b) => a - b);
}

/**
 * Normalizes a detected face bounding box to [0, 1] coordinate range.
 *
 * @param {object} rawBox - { x, y, width, height }
 * @param {number} canvasWidth - Width of the detection canvas in pixels
 * @param {number} canvasHeight - Height of the detection canvas in pixels
 * @param {number} [index=0] - Face index in current frame
 * @returns {object|null}
 */
export function normalizeDetectedFace(rawBox, canvasWidth, canvasHeight, index = 0) {
  if (!rawBox || !canvasWidth || !canvasHeight) return null;
  const x = Number(rawBox.x ?? rawBox.left ?? 0);
  const y = Number(rawBox.y ?? rawBox.top ?? 0);
  const w = Number(rawBox.width ?? 0);
  const h = Number(rawBox.height ?? 0);

  if (w <= 0 || h <= 0) return null;

  const xMin = Math.max(0, Math.min(1, x / canvasWidth));
  const yMin = Math.max(0, Math.min(1, y / canvasHeight));
  const xMax = Math.max(0, Math.min(1, (x + w) / canvasWidth));
  const yMax = Math.max(0, Math.min(1, (y + h) / canvasHeight));

  if (xMax - xMin < 0.015 || yMax - yMin < 0.015) return null;

  const centerX = Number(((xMin + xMax) / 2).toFixed(4));
  const centerY = Number(((yMin + yMax) / 2).toFixed(4));
  const boxW = Number((xMax - xMin).toFixed(4));
  const boxH = Number((yMax - yMin).toFixed(4));

  return {
    xMin: Number(xMin.toFixed(4)),
    yMin: Number(yMin.toFixed(4)),
    xMax: Number(xMax.toFixed(4)),
    yMax: Number(yMax.toFixed(4)),
    x: Number(xMin.toFixed(4)),
    y: Number(yMin.toFixed(4)),
    width: boxW,
    height: boxH,
    centerX,
    centerY,
    area: Number((boxW * boxH).toFixed(5)),
    confidence: 0.92,
    id: `face-${index}-${Math.round(centerX * 100)}`,
    label: "face",
  };
}

/**
 * /**
 * Normalizes a detected person bounding box from vision worker output [0, 1].
 *
 * @param {object} rawDetection - { label, score, box: { xmin, ymin, xmax, ymax } }
 * @param {number} [index=0] - Subject index in frame
 * @returns {object|null}
 */
export function normalizeVisionPersonDetection(rawDetection, index = 0) {
  if (!rawDetection || typeof rawDetection !== "object") return null;
  const box = rawDetection.box || rawDetection.boundingBox || rawDetection;
  const rawXMin = box.xmin ?? box.xMin ?? box.left ?? box.x;
  const rawYMin = box.ymin ?? box.yMin ?? box.top ?? box.y;
  let rawXMax = box.xmax ?? box.xMax ?? box.right;
  let rawYMax = box.ymax ?? box.yMax ?? box.bottom;

  if (rawXMin === undefined || rawYMin === undefined) return null;
  if (rawXMax === undefined && box.width !== undefined) {
    rawXMax = Number(rawXMin) + Number(box.width);
  }
  if (rawYMax === undefined && box.height !== undefined) {
    rawYMax = Number(rawYMin) + Number(box.height);
  }
  if (rawXMax === undefined || rawYMax === undefined) return null;

  const xMin = Number(rawXMin);
  const yMin = Number(rawYMin);
  const xMax = Number(rawXMax);
  const yMax = Number(rawYMax);

  if (!Number.isFinite(xMin) || !Number.isFinite(yMin) || !Number.isFinite(xMax) || !Number.isFinite(yMax)) return null;
  if (xMax <= xMin || yMax <= yMin) return null;

  const clampedXMin = Math.max(0, Math.min(1, xMin));
  const clampedYMin = Math.max(0, Math.min(1, yMin));
  const clampedXMax = Math.max(0, Math.min(1, xMax));
  const clampedYMax = Math.max(0, Math.min(1, yMax));

  const width = Number((clampedXMax - clampedXMin).toFixed(4));
  const height = Number((clampedYMax - clampedYMin).toFixed(4));
  if (width < 0.015 || height < 0.015) return null;

  const centerX = Number(((clampedXMin + clampedXMax) / 2).toFixed(4));
  const centerY = Number(((clampedYMin + clampedYMax) / 2).toFixed(4));
  const confidence = Math.max(0, Math.min(1, Number(rawDetection.score ?? rawDetection.confidence ?? 0.85)));

  return {
    xMin: Number(clampedXMin.toFixed(4)),
    yMin: Number(clampedYMin.toFixed(4)),
    xMax: Number(clampedXMax.toFixed(4)),
    yMax: Number(clampedYMax.toFixed(4)),
    x: Number(clampedXMin.toFixed(4)),
    y: Number(clampedYMin.toFixed(4)),
    width,
    height,
    centerX,
    centerY,
    area: Number((width * height).toFixed(5)),
    confidence: Number(confidence.toFixed(4)),
    id: rawDetection.id || `person-${index}-${Math.round(centerX * 100)}`,
    label: "person",
    isPerson: true,
  };
}

/**
 * Extracts a Blob from an HTMLCanvasElement asynchronously.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {string} [type="image/jpeg"]
 * @param {number} [quality=0.85]
 * @returns {Promise<Blob|null>}
 */
export async function getCanvasBlob(canvas, type = "image/jpeg", quality = 0.85) {
  if (!canvas) return null;
  if (typeof canvas.toBlob === "function") {
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  }
  if (typeof canvas.convertToBlob === "function") {
    return await canvas.convertToBlob({ type, quality });
  }
  return null;
}

/**
 * Detects faces on a 2D canvas using the provided or native detector.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} [detector] - Optional injected detector for testing
 * @returns {Promise<Array<object>>} Array of normalized face objects
 */
export async function detectFacesOnCanvas(canvas, detector = null) {
  const activeDetector = detector || getNativeFaceDetector();
  if (!activeDetector || typeof activeDetector.detect !== "function" || !canvas) {
    return [];
  }

  try {
    const rawFaces = await activeDetector.detect(canvas);
    if (!Array.isArray(rawFaces) || rawFaces.length === 0) return [];

    const width = canvas.width || 1;
    const height = canvas.height || 1;

    return rawFaces
      .map((face, idx) => normalizeDetectedFace(face?.boundingBox || face, width, height, idx))
      .filter(Boolean);
  } catch (err) {
    console.warn("[shortsFaceDetection] detectFacesOnCanvas error:", err?.message);
    return [];
  }
}

function waitForVideoEvent(target, eventName, errorName, signal) {
  if (signal?.aborted) {
    const err = new Error("Video seek aborted");
    err.name = "AbortError";
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      target.removeEventListener(eventName, onSuccess);
      target.removeEventListener(errorName, onError);
      signal?.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
    };
    const onSuccess = () => { cleanup(); resolve(); };
    const onError = (e) => { cleanup(); reject(new Error("Video media read error")); };
    const onAbort = () => {
      cleanup();
      const err = new Error("Video seek aborted");
      err.name = "AbortError";
      reject(err);
    };

    target.addEventListener(eventName, onSuccess, { once: true });
    target.addEventListener(errorName, onError, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });

    // Safety timeout: 4.5 seconds max per seek
    timer = setTimeout(() => {
      cleanup();
      resolve(); // proceed gracefully rather than freezing
    }, 4500);
  });
}

/**
 * Samples video frames at controlled intervals and extracts local face/person detections.
 * Uses native FaceDetector when available; cleanly falls back to local vision worker (analyzeVisualSubject)
 * running YOLOS-tiny in Web Worker when FaceDetector is unavailable.
 *
 * @param {object} params
 * @param {object|Blob|string} params.source - Video media asset, segment, Blob, or URL
 * @param {number} [params.duration] - Video duration in seconds
 * @param {number} [params.interval=1.25] - Target sampling interval in seconds
 * @param {number} [params.maxSamples=48] - Max samples cap
 * @param {AbortSignal} [params.signal] - Abort controller signal for user cancellation
 * @param {Function} [params.onProgress] - Progress callback (0..100)
 * @param {object} [params.detector] - Optional injected detector for deterministic testing
 * @param {Function} [params.visionAnalyzer] - Optional injected vision analyzer for deterministic testing
 * @returns {Promise<{ supported: boolean, status: string, detections: Array, sampledFramesCount: number, error?: string }>}
 */
export async function sampleVideoFaceDetections({
  source,
  startTime = 0,
  duration = 0,
  interval = DEFAULT_SAMPLE_INTERVAL_SECONDS,
  maxSamples = MAX_SAMPLES_LIMIT,
  signal = null,
  onProgress = null,
  onPartialDetections = null,
  detector = null,
  visionAnalyzer = null,
  sceneCuts = [],
} = {}) {
  const isDev = Boolean(typeof import.meta !== "undefined" && import.meta.env?.DEV);

  const hasInjectedDetector = Boolean(detector && typeof detector.detect === "function");
  const hasInjectedAnalyzer = typeof visionAnalyzer === "function";
  const hasNativeDetector = isNativeFaceDetectorSupported();
  const hasVisionWorker = isVisionSubjectAnalysisSupported();

  const isNativeSupported = hasInjectedDetector || hasNativeDetector;
  const isVisionSupported = hasInjectedAnalyzer || hasVisionWorker;
  const supported = isNativeSupported || isVisionSupported;

  const strategy = hasInjectedDetector
    ? "injected_detector"
    : (hasInjectedAnalyzer
        ? "injected_vision"
        : (hasNativeDetector
            ? "native_FaceDetector"
            : (hasVisionWorker ? "local_vision_worker" : "none")));

  if (isDev) {
    console.info("[ShortsStudio Detection Diagnostic] Checking face/person detection support:", {
      nativeSupported: hasNativeDetector,
      visionWorkerSupported: hasVisionWorker,
      strategy,
      supported,
    });
  }

  if (!supported || strategy === "none") {
    if (isDev) {
      console.warn("[ShortsStudio Detection Diagnostic] Local detection unavailable: Neither native FaceDetector API nor local Vision Worker is available in this environment.");
    }
    return {
      supported: false,
      status: "unsupported",
      reason: "Neither native FaceDetector API nor local Vision Worker is available in this environment",
      detections: [],
      sampledFramesCount: 0,
      diagnostics: {
        apiSupported: false,
        nativeSupported: false,
        visionWorkerSupported: false,
        reason: "Local detection requires Shape Detection API or Web Worker vision support",
      },
    };
  }

  const activeDetector = strategy === "injected_detector"
    ? detector
    : (strategy === "native_FaceDetector" ? getNativeFaceDetector() : null);

  const useVisionAnalyzer = strategy === "injected_vision" || strategy === "local_vision_worker";
  const analyzerFn = visionAnalyzer || (useVisionAnalyzer ? analyzeVisualSubject : null);

  // Resolve source media resource
  let mediaSrc = "";
  let objectUrlToRevoke = null;

  if (typeof source === "string") {
    mediaSrc = source;
  } else if (source instanceof Blob) {
    objectUrlToRevoke = URL.createObjectURL(source);
    mediaSrc = objectUrlToRevoke;
  } else if (source && typeof source === "object") {
    if (source.blob instanceof Blob) {
      objectUrlToRevoke = URL.createObjectURL(source.blob);
      mediaSrc = objectUrlToRevoke;
    } else if (source.src) {
      mediaSrc = source.src;
    } else if (source.url) {
      mediaSrc = source.url;
    } else if (source.mediaUrl) {
      mediaSrc = source.mediaUrl;
    }
  }

  if (!mediaSrc) {
    return {
      supported: true,
      status: "invalid_source",
      reason: "No decodable video source URL or Blob provided",
      detections: [],
      sampledFramesCount: 0,
    };
  }

  if (signal?.aborted) {
    if (objectUrlToRevoke) URL.revokeObjectURL(objectUrlToRevoke);
    const err = new Error("Face detection aborted");
    err.name = "AbortError";
    throw err;
  }

  // Create lightweight headless video element
  const video = typeof document !== "undefined" ? document.createElement("video") : null;
  if (!video) {
    if (objectUrlToRevoke) URL.revokeObjectURL(objectUrlToRevoke);
    return {
      supported: true,
      status: "no_dom",
      detections: [],
      sampledFramesCount: 0,
    };
  }

  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  // Only set crossOrigin for remote http/https URLs. Never set for blob: or data: schemes to avoid browser CORS rejection.
  if (mediaSrc.startsWith("http://") || mediaSrc.startsWith("https://")) {
    video.crossOrigin = "anonymous";
  }
  video.src = mediaSrc;

  let canvas = null;
  let context = null;

  try {
    if (video.readyState < 1) {
      await waitForVideoEvent(video, "loadedmetadata", "error", signal);
    }
    if (video.readyState < 2) {
      try {
        await waitForVideoEvent(video, "loadeddata", "error", signal);
      } catch {
        // Fall back gracefully if loadeddata does not fire promptly
      }
    }

    const startOffset = Number.isFinite(Number(startTime)) ? Math.max(0, Number(startTime)) : 0;
    const videoDuration = Number(video.duration) || Number(duration) || 0;
    const effectiveDuration = Number(duration) > 0
      ? Number(duration)
      : Math.max(0, videoDuration - startOffset);

    const timestamps = calculateSampleTimestamps({
      startTime: startOffset,
      duration: effectiveDuration,
      interval,
      maxSamples,
      sceneCuts,
    });

    const srcW = video.videoWidth || 1920;
    const srcH = video.videoHeight || 1080;
    const scale = Math.min(1, DETECTION_CANVAS_MAX_DIMENSION / Math.max(srcW, srcH));
    const width = Math.max(16, Math.round(srcW * scale));
    const height = Math.max(16, Math.round(srcH * scale));

    canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });

    if (!context) {
      throw new Error("Could not initialize detection canvas context");
    }

    const detections = [];
    const maxSeekLimit = videoDuration > 0 ? videoDuration : (startOffset + effectiveDuration);

    for (let i = 0; i < timestamps.length; i++) {
      if (signal?.aborted) {
        const err = new Error("Face detection aborted");
        err.name = "AbortError";
        throw err;
      }

      const time = timestamps[i];
      const targetTime = Math.max(0, Math.min(time, Math.max(0, maxSeekLimit - 0.02)));

      if (Math.abs(video.currentTime - targetTime) > 0.05) {
        const seekPromise = waitForVideoEvent(video, "seeked", "error", signal);
        video.currentTime = targetTime;
        await seekPromise;
      }

      context.drawImage(video, 0, 0, width, height);

      let faces = [];

      if (useVisionAnalyzer && analyzerFn) {
        const frameBlob = await getCanvasBlob(canvas, "image/jpeg", 0.85);
        if (!frameBlob) {
          throw new Error("Failed to extract frame Blob from detection canvas");
        }

        try {
          const visionResult = await analyzerFn({
            blob: frameBlob,
            includeMatting: false,
            threshold: 0.25,
            preferredLabels: ["person"],
            signal,
          });

          if (visionResult) {
            const rawList = Array.isArray(visionResult.detections) ? visionResult.detections : [];
            const personList = rawList.filter((d) => String(d?.label || "").toLowerCase() === "person");
            const candidates = personList.length > 0
              ? personList
              : (visionResult.subject && String(visionResult.subject.label || "").toLowerCase() === "person" ? [visionResult.subject] : []);

            faces = candidates
              .map((c, idx) => normalizeVisionPersonDetection(c, idx))
              .filter(Boolean);
          }
        } catch (visionErr) {
          if (visionErr?.name === "AbortError" || signal?.aborted) {
            throw visionErr;
          }
          if (isDev) {
            console.warn(`[shortsFaceDetection] Vision analyzer error at frame ${i + 1}/${timestamps.length} (${time}s):`, visionErr?.message);
          }
          if (i === 0 && timestamps.length > 1) {
            // First frame initialization/model failure: stop early rather than repeating errors
            throw visionErr;
          }
        }
      } else if (activeDetector) {
        faces = await detectFacesOnCanvas(canvas, activeDetector);
      }

      if (isDev && faces.length > 0) {
        console.info(`[ShortsStudio Detection Diagnostic] Frame ${i + 1}/${timestamps.length} @ ${time.toFixed(2)}s (${strategy}): ${faces.length} subjects detected:`, faces.map((f) => ({ id: f.id, x: f.xMin, y: f.yMin, w: f.width, h: f.height, conf: f.confidence })));
      }

      if (faces.length > 0) {
        detections.push({
          time: Number(time.toFixed(3)),
          faces,
        });
        if (typeof onPartialDetections === "function") {
          try {
            onPartialDetections([...detections]);
          } catch {
            /* ignore callback errors */
          }
        }
      }

      onProgress?.(Math.round(((i + 1) / timestamps.length) * 100));
    }

    if (isDev) {
      console.info(`[ShortsStudio Detection Diagnostic] Completed sampling: ${timestamps.length} frames decoded, ${detections.length} frames with subjects found, strategy: ${strategy}`);
    }

    return {
      supported: true,
      status: detections.length > 0 ? "faces_found" : "no_faces_found",
      strategy,
      detections,
      sampledFramesCount: timestamps.length,
    };
  } catch (err) {
    if (err?.name === "AbortError" || signal?.aborted) {
      throw err;
    }
    console.warn("[shortsFaceDetection] sampleVideoFaceDetections failure:", err?.message);
    return {
      supported: true,
      status: "error",
      reason: err?.message || "Local video subject detection failed",
      strategy,
      detections: [],
      sampledFramesCount: 0,
    };
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    if (objectUrlToRevoke) {
      URL.revokeObjectURL(objectUrlToRevoke);
    }
    canvas = null;
    context = null;
  }
}
