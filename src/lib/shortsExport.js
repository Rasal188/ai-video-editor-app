/**
 * @file shortsExport.js
 * AI Shorts Studio Dedicated Export Pipeline.
 *
 * Implements isolated, client-side rendering for AI Shorts candidates:
 * - Direct WebCodecs offline rendering (1080x1920 for 9:16, 1080x1080 for 1:1, 1920x1080 for 16:9)
 * - Exact candidate start and end time boundaries (never exports full video)
 * - Synchronized embedded audio extraction for the exact trimmed interval
 * - Burned portrait captions positioned within vertical safe areas
 * - Smart framing and pan offsets (cropX)
 * - Filesystem-safe sequential naming (e.g. short-01-title.mp4)
 * - Leaves user's editor timeline, visual segments, and project state 100% untouched
 * - Batch export orchestration with per-item progress and safe cancellation
 */

import { buildShortExportSpec, SHORTS_ASPECT_RATIOS } from "./shortsStudio.js";
import { throwIfExportAborted } from "./exportCancellation.js";
import {
  packageEditableShortTimeline,
  createTimelinePackageZipBlob,
} from "./shortsTimelinePackaging.js";

/**
 * Downloads a binary blob to the user's local disk with a designated filename.
 */
export function downloadBlob(blob, filename) {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 800);
}

/**
 * Generates a clean, filesystem-safe filename for an exported candidate short.
 * Format: short-01-sanitized-title.mp4
 *
 * @param {object} candidate
 * @param {number} index - 1-based index
 * @returns {string}
 */
export function getShortCandidateFileName(candidate, index = 1) {
  const padIndex = String(index).padStart(2, "0");
  const rawTitle = (candidate?.title || "")
    .replace(/#[a-z0-9_-]+/gi, "")
    .trim();
  const sanitized = rawTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36)
    .replace(/-+$/, "");

  return sanitized ? `short-${padIndex}-${sanitized}.mp4` : `short-${padIndex}.mp4`;
}

/**
 * Exports a single short candidate to MP4 via client-side WebCodecs offline render.
 *
 * @param {object} sourceMedia - Source video clip metadata and media
 * @param {object} candidate - Candidate moment with startTime, endTime, cropX, etc.
 * @param {object} options - Framing, aspect ratio, caption presets
 * @param {object} handlers - { onProgress, signal, index }
 * @returns {Promise<{ status: string, fileName: string, blob: Blob, duration: number, width: number, height: number }>}
 */
export async function exportShortCandidateVideo(
  sourceMedia,
  candidate,
  options = {},
  { onProgress, signal, index = 1, autoDownload = true } = {}
) {
  throwIfExportAborted(signal);

  const reportProgress = (val) => {
    try {
      onProgress?.(val);
    } catch {
      // Observer errors should not interrupt export
    }
  };

  reportProgress({ progress: 2, phase: "Preparing short video specification…" });

  // 1. Build candidate export specification
  const spec = buildShortExportSpec(sourceMedia, candidate, options);
  if (!spec || !spec.project) {
    throw new Error("Could not construct export specification for candidate short.");
  }

  const safeFileName = getShortCandidateFileName(candidate, index);

  // Dynamically load browser-only export dependencies
  const [
    { exportOfflineVideo },
    { prepareEmbeddedVideoAudio },
    { ensureCaptionFontLoaded, resolveCaptionStyleForSegment },
  ] = await Promise.all([
    import("./offlineVideoExport.js"),
    import("./embeddedVideoAudioExport.js"),
    import("./captionFonts.js"),
  ]);

  throwIfExportAborted(signal);

  // 2. Load caption fonts if captions are enabled
  if (spec.project.captionsEnabled && spec.project.captionSegments?.length) {
    reportProgress({ progress: 5, phase: "Loading caption typography styles…" });
    const captionsByFont = new Map();
    spec.project.captionSegments.forEach((segment) => {
      const fontId = resolveCaptionStyleForSegment(spec.project.captionStyle, segment).fontId;
      captionsByFont.set(fontId, `${captionsByFont.get(fontId) || ""} ${segment.text || ""}`.trim());
    });
    await Promise.all(
      [...captionsByFont].map(([fontId, text]) => ensureCaptionFontLoaded(fontId, text))
    );
    throwIfExportAborted(signal);
  }

  // 3. Extract embedded video audio for the trimmed interval
  reportProgress({ progress: 8, phase: "Extracting audio for short segment…" });
  const embeddedAudio = await prepareEmbeddedVideoAudio(
    spec.project.visualSegments,
    (audioProg) => {
      reportProgress({
        progress: 8 + Math.round((audioProg?.progress || 0) * 0.12),
        phase: "Extracting source audio…",
      });
    },
    signal
  );
  throwIfExportAborted(signal);

  // 4. Configure offline WebCodecs composition
  const exportSettings = {
    width: spec.width,
    height: spec.height,
    frameRate: 30,
    videoBitsPerSecond: 8_000_000,
    audio: "mix",
    captions: spec.project.captionsEnabled ? "burned" : "none",
    fileName: safeFileName,
    format: "mp4",
  };

  const compositionOptions = {
    exportSettings,
    ratio: { id: spec.aspectRatio, width: spec.width, height: spec.height },
    fitMode: spec.project.fitMode || "cover",
    visualSegments: spec.project.visualSegments,
    duration: spec.duration,
    timelineOffset: 0,
    captionSegments: spec.project.captionSegments,
    captionsEnabled: spec.project.captionsEnabled,
    captionStyle: spec.project.captionStyle,
    captionSize: spec.project.captionSize,
    captionPosition: { x: 0.5, y: 0.8 },
    captionPlacement: "bottom",
    captionReferenceSize: { width: spec.width, height: spec.height },
    trackVisibility: { visual: true, caption: true, source: true },
    selectedFilter: { css: "none" },
    stickerSegments: Array.isArray(spec.project?.stickerSegments) ? spec.project.stickerSegments : [],
    visualOverlaySegments: Array.isArray(spec.project?.visualOverlaySegments) ? spec.project.visualOverlaySegments : [],
    sourceAudioBlob: embeddedAudio.blob,
    sourceAudioSegments: embeddedAudio.segments,
    sourceAudioVolume: 1,
    signal,
    onProgress: (p) => {
      reportProgress({
        progress: 20 + Math.round((p.progress || 0) * 0.75),
        phase: p.phase || "Rendering vertical video frames…",
        phaseKey: p.phaseKey,
      });
    },
  };

  // 5. Render offline video frames & mix audio
  const result = await exportOfflineVideo(compositionOptions);
  throwIfExportAborted(signal);

  reportProgress({ progress: 99, phase: "Finalizing and downloading MP4…" });

  // 6. Download the generated MP4 if autoDownload is enabled
  if (result?.blob && autoDownload) {
    downloadBlob(result.blob, safeFileName);
  }

  reportProgress({ progress: 100, phase: "Short export complete!" });

  return {
    status: "success",
    fileName: safeFileName,
    blob: result.blob,
    duration: spec.duration,
    width: spec.width,
    height: spec.height,
    aspectRatio: spec.aspectRatio,
  };
}

/**
 * Packages multiple exported short candidate blobs into a single ZIP archive.
 *
 * @param {Array<{ fileName: string, blob: Blob }>} exportedClips
 * @returns {Promise<Blob>} ZIP archive blob
 */
export async function createShortsBatchZip(exportedClips = []) {
  const { zipSync } = await import("fflate");
  const filesToZip = {};
  for (const item of exportedClips) {
    if (item?.blob && item.fileName) {
      const buffer = typeof item.blob.arrayBuffer === "function"
        ? await item.blob.arrayBuffer()
        : Buffer.from(item.blob);
      filesToZip[item.fileName] = new Uint8Array(buffer);
    }
  }
  const zipData = zipSync(filesToZip, { level: 0 });
  return new Blob([zipData], { type: "application/zip" });
}

/**
 * Batch exports multiple selected candidate shorts sequentially.
 *
 * @param {object} sourceMedia - Source video clip
 * @param {Array<object>} candidates - List of candidate shorts to export
 * @param {object} options - Shared export options (aspectRatio, etc.)
 * @param {object} handlers - { onProgress, onItemProgress, signal }
 * @returns {Promise<{ status: string, total: number, exported: Array<object>, errors: Array<object>, zipName?: string }>}
 */
export async function exportShortCandidatesBatch(
  sourceMedia,
  candidates = [],
  options = {},
  { onProgress, onItemProgress, signal } = {}
) {
  throwIfExportAborted(signal);
  if (!candidates.length) {
    return { status: "empty", total: 0, exported: [], errors: [] };
  }

  const exported = [];
  const errors = [];
  const total = candidates.length;

  for (let i = 0; i < total; i++) {
    throwIfExportAborted(signal);
    const candidate = candidates[i];
    const index = i + 1;

    onItemProgress?.({
      current: index,
      total,
      title: candidate.title,
      progress: 0,
      phase: `Starting short ${index} of ${total}…`,
    });

    onProgress?.({
      progress: Math.round((i / total) * 100),
      current: index,
      total,
      title: candidate.title,
    });

    try {
      const res = await exportShortCandidateVideo(sourceMedia, candidate, options, {
        signal,
        index,
        autoDownload: false, // Prevent immediate browser multi-download blocking
        onProgress: (p) => {
          const itemPct = p.progress || 0;
          const overallPct = Math.round(((i + itemPct / 100) / total) * 100);
          onItemProgress?.({
            current: index,
            total,
            title: candidate.title,
            progress: itemPct,
            phase: p.phase || `Rendering short ${index} of ${total}…`,
          });
          onProgress?.({
            progress: overallPct,
            current: index,
            total,
            title: candidate.title,
          });
        },
      });

      exported.push(res);
    } catch (err) {
      if (err?.name === "AbortError" || signal?.aborted) {
        throw err;
      }
      errors.push({ candidateId: candidate.id, title: candidate.title, error: err.message });
      console.error(`Export failed for candidate "${candidate.title}":`, err);
    }
  }

  // Single predictable download delivery:
  let zipName = null;
  if (exported.length === 1) {
    // Single short completed: download directly
    downloadBlob(exported[0].blob, exported[0].fileName);
  } else if (exported.length > 1) {
    // Multiple shorts: package into a single ZIP archive to prevent multi-download blocks
    try {
      onProgress?.({ progress: 99, current: total, total, phase: "Packaging shorts into single ZIP archive…" });
      const zipBlob = await createShortsBatchZip(exported);
      const padCount = String(exported.length).padStart(2, "0");
      zipName = `shorts-batch-${padCount}-clips.zip`;
      downloadBlob(zipBlob, zipName);
    } catch (zipErr) {
      console.warn("Failed to create ZIP package for shorts batch, falling back to sequential downloads:", zipErr);
      for (const item of exported) {
        downloadBlob(item.blob, item.fileName);
      }
    }
  }

  onProgress?.({ progress: 100, current: total, total });

  return {
    status: errors.length === 0 ? "success" : "partial",
    total,
    exported,
    errors,
    zipName,
  };
}

/**
 * Exports an editable multi-track timeline package (native project, OTIO, FCPXML).
 *
 * @param {object} sourceMedia - Source video clip metadata
 * @param {object} candidate - Candidate short
 * @param {object} options - Framing, aspect ratio, transitions, overlays
 * @param {object} exportOptions - { format: "all"|"native"|"otio"|"fcpxml", autoDownload: boolean, index: number }
 * @returns {Promise<{ status: string, fileName: string, blob: Blob, package: object }>}
 */
export async function exportShortCandidateTimelinePackage(
  sourceMedia,
  candidate,
  options = {},
  { format = "all", autoDownload = true, index = 1 } = {}
) {
  const baseName = getShortCandidateFileName(candidate, index).replace(/\.mp4$/i, "");
  const pkg = packageEditableShortTimeline(sourceMedia, candidate, options);

  let blob = null;
  let fileName = "";

  if (format === "otio") {
    blob = new Blob([JSON.stringify(pkg.otio, null, 2)], { type: "application/json" });
    fileName = `${baseName}.otio`;
  } else if (format === "fcpxml") {
    blob = new Blob([pkg.fcpxml], { type: "application/xml" });
    fileName = `${baseName}.fcpxml`;
  } else if (format === "native") {
    blob = new Blob([JSON.stringify(pkg.nativeProject, null, 2)], { type: "application/json" });
    fileName = `${baseName}.timeline.json`;
  } else {
    // "all" or "zip": package all supported formats into ZIP
    blob = await createTimelinePackageZipBlob(pkg);
    fileName = `${baseName}-timeline-package.zip`;
  }

  if (autoDownload && blob) {
    downloadBlob(blob, fileName);
  }

  return {
    status: "success",
    fileName,
    blob,
    package: pkg,
  };
}

