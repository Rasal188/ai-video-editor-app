import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const RATIO_SIZES = Object.freeze({
  "16:9": { width: 1280, height: 720 },
  "9:16": { width: 720, height: 1280 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 864, height: 1080 },
});

export const SUPPORTED_HEADLESS_TRANSITIONS = Object.freeze({
  fade: "fade",
  "wipe-left": "wipeleft",
  "wipe-up": "wipeup",
  split: "horzopen",
  zoom: "zoomin",
  flash: "fadewhite",
  blur: "hblur",
});

function renderError(code, message) {
  return Object.assign(new Error(message), { code });
}

function evenDimension(value, fallback, name) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isFinite(number) || number < 2) throw renderError("INVALID_RENDER_SETTINGS", `${name} must be at least 2`);
  return Math.max(2, Math.round(number / 2) * 2);
}

function finitePositive(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw renderError("INVALID_PROJECT", `${name} must be greater than zero`);
  return number;
}

function atempoChain(rate) {
  const filters = [];
  let remaining = rate;
  while (remaining > 2) { filters.push("atempo=2"); remaining /= 2; }
  while (remaining < 0.5) { filters.push("atempo=0.5"); remaining /= 0.5; }
  filters.push(`atempo=${remaining.toFixed(6)}`);
  return filters.join(",");
}

function resolveCaptionFontPath(settings = {}) {
  if (settings.fontFile && typeof settings.fontFile === "string") {
    return settings.fontFile;
  }
  if (typeof process !== "undefined" && process.env?.TIMELINE_CAPTION_FONT_FILE) {
    return process.env.TIMELINE_CAPTION_FONT_FILE;
  }

  const isWin = typeof process !== "undefined" && process.platform === "win32";
  const winDir = (typeof process !== "undefined" && process.env?.WINDIR) || "C:/Windows";

  const candidates = isWin
    ? [
        `${winDir}/Fonts/segoeui.ttf`,
        `${winDir}/Fonts/arial.ttf`,
        `${winDir}/Fonts/msyh.ttc`,
        "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/arial.ttf",
        "C:/Windows/Fonts/msyh.ttc",
      ]
    : [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
        "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
      ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* font candidate not accessible, check next */
    }
  }

  return isWin ? "C:/Windows/Fonts/arial.ttf" : null;
}

function escapeFfmpegFilterPath(filePath) {
  if (!filePath) return "";
  return filePath
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

function escapeDrawtextText(text) {
  return String(text ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "’")
    .replace(/:/g, "\\:");
}

function wrapCaptionTextForFfmpeg(text, maxCharsPerLine) {
  if (!text || typeof text !== "string") return "";
  if (text.includes("\n")) return text;
  const words = text.split(/\s+/);
  if (words.length <= 1) return text;

  const lines = [];
  let currentLine = "";

  for (const word of words) {
    if (!currentLine) {
      currentLine = word;
    } else if (currentLine.length + 1 + word.length <= maxCharsPerLine) {
      currentLine += ` ${word}`;
    } else {
      lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines.join("\n");
}

function normalizeFfmpegColor(colorHex, fallback = "white") {
  if (!colorHex || typeof colorHex !== "string") return fallback;
  const hex = colorHex.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
    return `0x${hex.slice(1)}`;
  }
  return hex;
}

function resolvePlacementCoords(placement) {
  if (typeof placement === "string") {
    if (placement === "top") return { x: 50, y: 18 };
    if (placement === "middle" || placement === "center") return { x: 50, y: 50 };
    return { x: 50, y: 78 };
  }
  if (placement && typeof placement === "object") {
    const x = Number.isFinite(Number(placement.x)) ? Number(placement.x) : 50;
    const y = Number.isFinite(Number(placement.y)) ? Number(placement.y) : 78;
    return { x, y };
  }
  return { x: 50, y: 78 };
}

function assertSupportedProject(project) {
  const unsupported = [];
  const visibleCaptions = (project.captionSegments || []).filter((item) => !item.hidden);
  const isKaraokeProject = Boolean(project.captionStyle?.karaoke);
  if (visibleCaptions.some((item) => (item.animation === "karaoke" || item.styleOverrides?.karaoke || (isKaraokeProject && item.styleOverrides?.karaoke !== false)) && Array.isArray(item.words) && item.words.length > 1)) {
    unsupported.push("karaoke caption animation");
  }
  const visibleOverlays = (project.visualOverlaySegments || []).filter((item) => !item.hidden);
  for (const item of visibleOverlays) {
    if (item.keyframes?.length) unsupported.push("overlay keyframes");
    if (item.animation && item.animation !== "none") unsupported.push("overlay animation");
    if (item.mask?.type && item.mask.type !== "none") unsupported.push("overlay masks");
    if (item.vision || item.depth || item.subjectEffect) unsupported.push("overlay AI effects");
    if (item.clickRipple?.enabled) unsupported.push("overlay click ripples");
  }
  const visibleStickers = (project.stickerSegments || []).filter((item) => !item.hidden);
  for (const item of visibleStickers) {
    if (item.keyframes?.length) unsupported.push("sticker keyframes");
    if (item.animation && item.animation !== "none") unsupported.push("sticker animation");
  }
  if (project.trackVisibility?.source !== false && (project.sourceAudioSegments || []).length) unsupported.push("source audio");
  const visuals = project.visualSegments || [];
  visuals.forEach((item, index) => {
    const junction = item.transition;
    if (junction?.id && junction.id !== "none") {
      if (index >= visuals.length - 1) return;
      if (!SUPPORTED_HEADLESS_TRANSITIONS[junction.id]) {
        unsupported.push(`transition "${junction.id}"`);
      }
    }
  });
  if ((project.visualSegments || []).some((item) => item.keyframes?.length || item.mask?.type || item.filter || item.effects?.length || item.vision || item.speedCurve?.enabled)) unsupported.push("visual effects");
  if (unsupported.length) {
    throw renderError("UNSUPPORTED_RENDER_FEATURE", `Headless render does not yet support: ${[...new Set(unsupported)].join(", ")}`);
  }
}

function resolveVisualPath(segment, media, extractedFiles) {
  const entry = (media.visuals || []).find((item) => [segment.id, segment.archiveMediaId, segment.assetId].includes(item.id));
  const path = entry?.path ? extractedFiles.get(entry.path) : null;
  if (!path) throw renderError("MISSING_MEDIA", `Portable media is missing for visual clip: ${segment.id}`);
  return path;
}

function resolveOverlayPath(segment, media = {}, extractedFiles) {
  const candidates = [
    segment.id,
    segment.archiveMediaId,
    segment.assetId,
    segment.stickerId,
    segment.sourceClipId,
  ].filter(Boolean);

  const allEntries = [
    ...(media.visuals || []),
    ...(media.stickers || []),
    ...(media.overlays || []),
    ...(media.visual ? [media.visual] : []),
    ...(media.sticker ? [media.sticker] : []),
    ...(media.overlay ? [media.overlay] : []),
  ];

  const entry = allEntries.find((item) => candidates.includes(item.id));
  if (entry?.path && extractedFiles?.has(entry.path)) {
    return extractedFiles.get(entry.path);
  }
  if (entry?.path && fs.existsSync(entry.path)) {
    return entry.path;
  }
  for (const c of candidates) {
    if (extractedFiles?.has(c)) return extractedFiles.get(c);
  }
  if (segment.src && extractedFiles?.has(segment.src)) {
    return extractedFiles.get(segment.src);
  }
  if (segment.path && extractedFiles?.has(segment.path)) {
    return extractedFiles.get(segment.path);
  }
  if (segment.src && typeof segment.src === "string" && fs.existsSync(segment.src)) {
    return segment.src;
  }
  if (segment.path && typeof segment.path === "string" && fs.existsSync(segment.path)) {
    return segment.path;
  }
  if (segment.src && typeof segment.src === "string") {
    const localPublic = path.resolve(process.cwd(), segment.src.startsWith("/") ? `.${segment.src}` : segment.src);
    if (fs.existsSync(localPublic)) return localPublic;
    const directPath = path.resolve(process.cwd(), "public", segment.src.startsWith("/") ? segment.src.slice(1) : segment.src);
    if (fs.existsSync(directPath)) return directPath;
  }
  if (extractedFiles instanceof Map) {
    for (const [archivePath, extractedPath] of extractedFiles.entries()) {
      if (candidates.some((c) => archivePath.includes(c))) return extractedPath;
    }
  }
  throw renderError("MISSING_MEDIA", `Portable media is missing for overlay clip: ${segment.id}`);
}

function resolveSourceDimensions(segment, filePath, mediaProbes) {
  const probe = mediaProbes instanceof Map ? mediaProbes.get(filePath) : null;
  let w = Number(segment.width) || probe?.width || 0;
  let h = Number(segment.height) || probe?.height || 0;
  if (!w || !h) {
    try {
      if (filePath && fs.existsSync(filePath)) {
        const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "json", filePath], { encoding: "utf8" });
        const data = JSON.parse(out);
        const stream = data.streams?.[0];
        if (stream?.width && stream?.height) {
          w = stream.width;
          h = stream.height;
        }
      }
    } catch {
      // fallback
    }
  }
  return { width: Math.max(1, w || 512), height: Math.max(1, h || 512) };
}

function addAudioTrack({ args, filters, inputs, segments, mediaEntry, mediaEntries = [], extractedFiles, duration, prefix, defaultVolume = 1 }) {
  if (!segments.length) return [];
  return segments.map((segment, index) => {
    const segmentEntry = mediaEntries.find((entry) => [segment.id, segment.archiveMediaId].includes(entry.id)) || mediaEntry;
    const path = segmentEntry?.path ? extractedFiles.get(segmentEntry.path) : null;
    if (!path) throw renderError("MISSING_MEDIA", `Portable media is missing for ${prefix} clip: ${segment.id}`);
    const inputIndex = inputs.count++;
    args.push("-i", path);
    const rate = Math.max(0.25, Math.min(4, Number(segment.playbackRate) || 1));
    const sourceStart = Math.max(0, Number(segment.sourceStart) || 0);
    const sourceDuration = Math.max(0.001, Number(segment.sourceDuration) || finitePositive(segment.duration, `${prefix} duration`) * rate);
    const start = Math.max(0, Number(segment.start) || 0);
    const volume = Number.isFinite(Number(segment.volume)) ? Number(segment.volume) : defaultVolume;
    const label = `${prefix}${index}`;
    const tempo = Math.abs(rate - 1) < 1e-6 ? "" : `${atempoChain(rate)},`;
    filters.push(`[${inputIndex}:a]atrim=start=${sourceStart}:duration=${sourceDuration},asetpts=PTS-STARTPTS,${tempo}volume=${volume},adelay=${Math.round(start * 1000)}:all=1,apad,atrim=duration=${duration}[${label}]`);
    return `[${label}]`;
  });
}

export function buildFfmpegRenderPlan({ project, media = {}, extractedFiles, mediaProbes = new Map(), settings = {} }) {
  if (!(extractedFiles instanceof Map)) throw renderError("INVALID_ARGUMENT", "extractedFiles must be a Map");
  assertSupportedProject(project || {});
  const visuals = project.visualSegments || [];
  if (!visuals.length) throw renderError("EMPTY_TIMELINE", "Headless render requires at least one visual clip");
  const ratio = RATIO_SIZES[project.ratioId] || RATIO_SIZES["16:9"];
  const width = evenDimension(settings.width, ratio.width, "width");
  const height = evenDimension(settings.height, ratio.height, "height");
  const frameRate = Math.max(1, Math.min(60, Math.round(Number(settings.frameRate) || 30)));
  const rawVisualDuration = visuals.reduce((sum, segment) => sum + finitePositive(segment.duration, `Visual clip ${segment.id} duration`), 0);
  let activeTransitionOverlap = 0;
  for (let i = 0; i < visuals.length - 1; i++) {
    const junction = visuals[i].transition;
    if (junction?.id && junction.id !== "none") {
      const tDuration = Number(junction.duration) || 0.5;
      if (tDuration <= 0) {
        throw renderError("INVALID_TRANSITION", `Transition duration must be positive`);
      }
      const durA = finitePositive(visuals[i].duration, `Visual clip ${visuals[i].id} duration`);
      const durB = finitePositive(visuals[i + 1].duration, `Visual clip ${visuals[i + 1].id} duration`);
      if (tDuration >= durA || tDuration >= durB) {
        throw renderError("INVALID_TRANSITION", `Transition duration ${tDuration}s must be less than adjacent clip durations (${durA}s, ${durB}s)`);
      }
      activeTransitionOverlap += tDuration;
    }
  }
  const duration = Math.max(0.001, rawVisualDuration - activeTransitionOverlap);
  const args = ["-hide_banner", "-y"];
  const filters = [];
  const inputs = { count: 0 };

  const visible = project.trackVisibility || {};
  const isSourceAudioVisible = visible.source !== false && visible.image !== false && visible.visuals !== false;

  const visualAudioStates = visuals.map((segment) => {
    const path = resolveVisualPath(segment, media, extractedFiles);
    const isVideo = segment.type === "video";
    const audioDisabled = segment.sourceAudioDisabled === true;
    const probe = mediaProbes instanceof Map
      ? (mediaProbes.get(path) ?? mediaProbes.get(segment.id) ?? mediaProbes.get(segment.archiveMediaId))
      : null;
    const probeHasAudio = probe ? Boolean(probe.hasAudio) : true;
    const hasAudio = isSourceAudioVisible && isVideo && !audioDisabled && probeHasAudio;
    return { path, hasAudio };
  });

  const hasVisualAudio = visualAudioStates.some((s) => s.hasAudio);

  visuals.forEach((segment, index) => {
    const { path, hasAudio } = visualAudioStates[index];
    const clipDuration = Number(segment.duration);
    const inputIndex = inputs.count++;
    if (segment.type === "image") args.push("-loop", "1", "-t", String(clipDuration), "-i", path);
    else args.push("-i", path);
    const sourceStart = Math.max(0, Number(segment.sourceStart) || 0);
    const rate = Math.max(0.25, Math.min(4, Number(segment.playbackRate) || 1));
    const trim = segment.type === "video" ? `trim=start=${sourceStart}:duration=${clipDuration * rate},setpts=(PTS-STARTPTS)/${rate},` : "";
    filters.push(`[${inputIndex}:v]${trim}scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,fps=${frameRate},settb=1/${frameRate},setsar=1,format=yuv420p[v${index}]`);

    if (hasVisualAudio) {
      if (hasAudio) {
        const sourceDuration = clipDuration * rate;
        const volume = Number.isFinite(Number(segment.volume)) ? Math.max(0, Number(segment.volume)) : 1;
        const tempo = Math.abs(rate - 1) < 1e-6 ? "" : `${atempoChain(rate)},`;
        filters.push(`[${inputIndex}:a]atrim=start=${sourceStart}:duration=${sourceDuration},asetpts=PTS-STARTPTS,${tempo}volume=${volume},aresample=44100,aformat=channel_layouts=stereo,apad,atrim=duration=${clipDuration}[a${index}]`);
      } else {
        filters.push(`anullsrc=channel_layout=stereo:sample_rate=44100,atrim=duration=${clipDuration},aformat=channel_layouts=stereo[a${index}]`);
      }
    }
  });

  if (activeTransitionOverlap === 0) {
    if (hasVisualAudio) {
      const concatPairs = visuals.map((_, index) => `[v${index}][a${index}]`).join("");
      filters.push(`${concatPairs}concat=n=${visuals.length}:v=1:a=1[vout][vaout]`);
    } else {
      const videoLabels = visuals.map((_, index) => `[v${index}]`).join("");
      filters.push(`${videoLabels}concat=n=${visuals.length}:v=1:a=0[vout]`);
    }
  } else {
    let currentV = "[v0]";
    let currentA = "[a0]";
    let currentDuration = Number(visuals[0].duration);

    for (let i = 0; i < visuals.length - 1; i++) {
      const nextV = `[v${i + 1}]`;
      const nextA = `[a${i + 1}]`;
      const nextDuration = Number(visuals[i + 1].duration);
      const junction = visuals[i].transition;
      const isTransition = Boolean(junction?.id && junction.id !== "none" && Number(junction.duration) > 0);

      const outV = i === visuals.length - 2 ? "[vout]" : `[vx_${i}]`;
      const outA = i === visuals.length - 2 ? "[vaout]" : `[ax_${i}]`;

      if (isTransition) {
        const tDuration = Number(junction.duration) || 0.5;
        const offset = currentDuration - tDuration;
        const xfadeType = SUPPORTED_HEADLESS_TRANSITIONS[junction.id];
        filters.push(`${currentV}${nextV}xfade=transition=${xfadeType}:duration=${tDuration}:offset=${offset.toFixed(4)},settb=1/${frameRate}${outV}`);
        currentV = outV;
        if (hasVisualAudio) {
          filters.push(`${currentA}${nextA}acrossfade=d=${tDuration}:c1=tri:c2=tri${outA}`);
          currentA = outA;
        }
        currentDuration = currentDuration + nextDuration - tDuration;
      } else {
        filters.push(`${currentV}${nextV}concat=n=2:v=1:a=0,settb=1/${frameRate}${outV}`);
        currentV = outV;
        if (hasVisualAudio) {
          filters.push(`${currentA}${nextA}concat=n=2:v=0:a=1${outA}`);
          currentA = outA;
        }
        currentDuration = currentDuration + nextDuration;
      }
    }
  }

  const audioLabels = [];
  if (hasVisualAudio) {
    audioLabels.push("[vaout]");
  }
  if (visible.audio !== false) {
    audioLabels.push(...addAudioTrack({ args, filters, inputs, segments: project.audioSegments || [], mediaEntry: media.audio, mediaEntries: media.audioSegments || [], extractedFiles, duration, prefix: "voice" }));
  }
  if (visible.music !== false) {
    audioLabels.push(...addAudioTrack({ args, filters, inputs, segments: project.musicSegments || [], mediaEntry: media.music, extractedFiles, duration, prefix: "music", defaultVolume: Number(project.musicVolume) || 0.35 }));
  }
  if (audioLabels.length) {
    filters.push(`${audioLabels.join("")}amix=inputs=${audioLabels.length}:duration=longest:normalize=0,atrim=duration=${duration}[aout]`);
  }

  const areOverlaysVisible = visible.overlay !== false;
  const overlaySegments = (areOverlaysVisible && Array.isArray(project.visualOverlaySegments))
    ? project.visualOverlaySegments
        .filter((s) => !s.hidden)
        .sort((a, b) => (Number(a.layer) || 1) - (Number(b.layer) || 1))
    : [];

  const areStickersVisible = visible.sticker !== false;
  const stickerSegments = (areStickersVisible && (project.stickerSegments?.length || project.sticker))
    ? (project.stickerSegments?.length ? project.stickerSegments : [project.sticker]).filter((s) => !s.hidden)
    : [];

  let currentVideoLabel = "[vout]";
  let overlayCount = 0;

  for (const segment of overlaySegments) {
    const overlayPath = resolveOverlayPath(segment, media, extractedFiles);
    const start = Math.max(0, Number(segment.start) || 0);
    const rawEnd = Number.isFinite(Number(segment.end))
      ? Number(segment.end)
      : start + (Number(segment.duration) || 5);
    const end = Math.min(duration, Math.max(start + 0.05, rawEnd));
    if (start >= duration || end <= start) continue;

    const { width: sw, height: sh } = resolveSourceDimensions(segment, overlayPath, mediaProbes);
    const transform = {
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
      opacity: 1,
      ...(segment.baseTransform || {}),
      ...(segment.transform || {}),
    };
    if (Number.isFinite(Number(segment.x))) transform.x = Number(segment.x);
    if (Number.isFinite(Number(segment.y))) transform.y = Number(segment.y);
    if (Number.isFinite(Number(segment.scale))) transform.scale = Number(segment.scale);
    if (Number.isFinite(Number(segment.rotation))) transform.rotation = Number(segment.rotation);
    if (Number.isFinite(Number(segment.opacity))) transform.opacity = Number(segment.opacity);

    const scaleVal = Math.max(0.01, Math.min(10, Number(transform.scale) || 1));
    const sourceAspect = sw / sh;
    const frameAspect = width / height;
    const useWidth = sourceAspect > frameAspect;
    const fitWidth = useWidth ? width : height * sourceAspect;
    const fitHeight = useWidth ? width / sourceAspect : height;
    const targetW = Math.max(2, Math.round((fitWidth * scaleVal) / 2) * 2);
    const targetH = Math.max(2, Math.round((fitHeight * scaleVal) / 2) * 2);

    const centerX = Math.round(width / 2 + (transform.x / 100) * width);
    const centerY = Math.round(height / 2 + (transform.y / 100) * height);

    const inputIndex = inputs.count++;
    args.push("-i", overlayPath);

    const prepSteps = [];
    if (segment.type === "video") {
      const sourceStart = Math.max(0, Number(segment.sourceStart) || 0);
      const rate = Math.max(0.25, Math.min(4, Number(segment.playbackRate) || 1));
      prepSteps.push(`trim=start=${sourceStart}:duration=${(end - start) * rate},setpts=(PTS-STARTPTS)/${rate}+${start}/TB`);
    }
    prepSteps.push(`scale=${targetW}:${targetH}:flags=lanczos,format=rgba`);
    const opacity = Number.isFinite(Number(transform.opacity)) ? Math.max(0, Math.min(1, Number(transform.opacity))) : 1;
    if (opacity < 0.999) {
      prepSteps.push(`colorchannelmixer=aa=${opacity.toFixed(3)}`);
    }
    const rotation = Number(transform.rotation) || 0;
    if (Math.abs(rotation) > 0.01) {
      const rad = (rotation * Math.PI) / 180;
      prepSteps.push(`rotate=${rad.toFixed(4)}:c=none:ow='rotw(${rad.toFixed(4)})':oh='roth(${rad.toFixed(4)})'`);
    }
    const prepLabel = `[ov_prep_${overlayCount}]`;
    filters.push(`[${inputIndex}:v]${prepSteps.join(",")}${prepLabel}`);

    const nextVideoLabel = `[v_ov_${overlayCount}]`;
    const xExpr = `${centerX}-w/2`;
    const yExpr = `${centerY}-h/2`;
    const enableExpr = `between(t,${start.toFixed(3)},${end.toFixed(3)})`;
    filters.push(`${currentVideoLabel}${prepLabel}overlay=x='${xExpr}':y='${yExpr}':enable='${enableExpr}':eof_action=repeat${nextVideoLabel}`);
    currentVideoLabel = nextVideoLabel;
    overlayCount++;
  }

  for (const segment of stickerSegments) {
    const stickerPath = resolveOverlayPath(segment, media, extractedFiles);
    const start = Math.max(0, Number(segment.start) || 0);
    const rawEnd = Number.isFinite(Number(segment.end))
      ? Number(segment.end)
      : start + (Number(segment.duration) || 5);
    const end = Math.min(duration, Math.max(start + 0.05, rawEnd));
    if (start >= duration || end <= start) continue;

    const { width: sw, height: sh } = resolveSourceDimensions(segment, stickerPath, mediaProbes);
    const ratio = sw / sh;
    const scale = Math.max(0.2, Math.min(3, Number(segment.scale) || 1));
    const boxSize = Math.max(1, Math.min(width, height) * 0.22) * scale;
    const stickerW = Math.max(2, Math.round((ratio >= 1 ? boxSize : boxSize * ratio) / 2) * 2);
    const stickerH = Math.max(2, Math.round((ratio >= 1 ? boxSize / ratio : boxSize) / 2) * 2);
    const centerX = Math.round(((Number.isFinite(Number(segment.x)) ? Number(segment.x) : 82) / 100) * width);
    const centerY = Math.round(((Number.isFinite(Number(segment.y)) ? Number(segment.y) : 20) / 100) * height);
    const opacity = Math.max(0, Math.min(1, Number.isFinite(Number(segment.opacity)) ? Number(segment.opacity) : 1));
    const rotation = Number(segment.rotation) || 0;

    const inputIndex = inputs.count++;
    args.push("-i", stickerPath);

    const prepSteps = [`scale=${stickerW}:${stickerH}:flags=lanczos,format=rgba`];
    if (opacity < 0.999) {
      prepSteps.push(`colorchannelmixer=aa=${opacity.toFixed(3)}`);
    }
    if (Math.abs(rotation) > 0.01) {
      const rad = (rotation * Math.PI) / 180;
      prepSteps.push(`rotate=${rad.toFixed(4)}:c=none:ow='rotw(${rad.toFixed(4)})':oh='roth(${rad.toFixed(4)})'`);
    }
    const prepLabel = `[st_prep_${overlayCount}]`;
    filters.push(`[${inputIndex}:v]${prepSteps.join(",")}${prepLabel}`);

    const nextVideoLabel = `[v_ov_${overlayCount}]`;
    const xExpr = `${centerX}-w/2`;
    const yExpr = `${centerY}-h/2`;
    const enableExpr = `between(t,${start.toFixed(3)},${end.toFixed(3)})`;
    filters.push(`${currentVideoLabel}${prepLabel}overlay=x='${xExpr}':y='${yExpr}':enable='${enableExpr}':eof_action=repeat${nextVideoLabel}`);
    currentVideoLabel = nextVideoLabel;
    overlayCount++;
  }

  const captionFilters = [];
  const areCaptionsVisible = visible.caption !== false && project.captionsEnabled !== false;
  if (areCaptionsVisible && Array.isArray(project.captionSegments)) {
    const fontPath = resolveCaptionFontPath(settings);
    const escapedFont = fontPath ? escapeFfmpegFilterPath(fontPath) : "";
    const fontOpt = escapedFont ? `fontfile='${escapedFont}':` : "";
    const scale = height / 360;

    for (const segment of project.captionSegments) {
      if (segment.hidden || typeof segment.text !== "string" || !segment.text.trim()) continue;
      const start = Math.max(0, Number(segment.start) || 0);
      const rawEnd = Number.isFinite(Number(segment.end))
        ? Number(segment.end)
        : start + (Number(segment.duration) || 2);
      const end = Math.min(duration, Math.max(start + 0.05, rawEnd));
      if (start >= duration || end <= start) continue;

      const style = { ...(project.captionStyle || {}), ...(segment.styleOverrides || {}) };
      const captionSize = Number(segment.captionSize || style.captionSize || project.captionSize) || 14;
      const fontSize = Math.max(10, Math.round(captionSize * scale));
      const textColor = normalizeFfmpegColor(style.textColor, "white");

      const opacity = Number.isFinite(Number(style.backgroundOpacity))
        ? Math.max(0, Math.min(1, Number(style.backgroundOpacity)))
        : 0.62;
      let boxOption = "";
      if (opacity > 0) {
        const boxColor = normalizeFfmpegColor(style.backgroundColor || "#05080d", "0x05080d");
        const paddingY = Math.round((Number(style.paddingY) || 12) * scale * 0.6);
        const boxBorderW = Math.max(4, paddingY);
        boxOption = `:box=1:boxcolor='${boxColor}@${opacity.toFixed(2)}':boxborderw=${boxBorderW}`;
      }

      let borderOption = "";
      if (Number(style.textStrokeWidth) > 0) {
        const strokeW = Math.max(1, Math.round(Number(style.textStrokeWidth) * scale));
        const strokeColor = normalizeFfmpegColor(style.textStrokeColor || "#000000", "black");
        borderOption = `:borderw=${strokeW}:bordercolor='${strokeColor}'`;
      }

      const placement = segment.placement || project.captionPlacement || project.captionPosition || "bottom";
      const { x: px, y: py } = resolvePlacementCoords(placement);
      const xExpr = `(w*${px}/100)-(text_w/2)`;
      const yExpr = `(h*${py}/100)-(text_h/2)`;

      const maxChars = Math.max(16, Math.floor((width * 0.84) / Math.max(1, fontSize * 0.58)));
      const wrappedText = wrapCaptionTextForFfmpeg(segment.text, maxChars);
      const escapedText = escapeDrawtextText(wrappedText);
      captionFilters.push(
        `drawtext=${fontOpt}text='${escapedText}':expansion=none:fontsize=${fontSize}:fontcolor='${textColor}'${boxOption}${borderOption}:x='${xExpr}':y='${yExpr}':enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'`
      );
    }
  }

  if (captionFilters.length > 0) {
    captionFilters.forEach((filterText, index) => {
      const nextLabel = index === captionFilters.length - 1 ? "[vfinal]" : `[vc${index}]`;
      filters.push(`${currentVideoLabel}${filterText}${nextLabel}`);
      currentVideoLabel = nextLabel;
    });
  }

  args.push("-filter_complex", filters.join(";"), "-map", currentVideoLabel);
  if (audioLabels.length) {
    args.push("-map", "[aout]", "-c:a", "aac", "-b:a", "192k");
  } else {
    args.push("-an");
  }
  args.push("-c:v", "libx264", "-preset", settings.preset || "medium", "-crf", String(Number(settings.crf) || 18), "-pix_fmt", "yuv420p", "-r", String(frameRate), "-t", String(duration), "-movflags", "+faststart");
  return { args, duration, width, height, frameRate, hasAudio: audioLabels.length > 0 };
}
