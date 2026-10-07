const RATIO_SIZES = Object.freeze({
  "16:9": { width: 1280, height: 720 },
  "9:16": { width: 720, height: 1280 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 864, height: 1080 },
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

function assertSupportedProject(project) {
  const unsupported = [];
  if ((project.captionSegments || []).some((item) => !item.hidden)) unsupported.push("captions");
  if ((project.stickerSegments || []).length) unsupported.push("stickers");
  if ((project.visualOverlaySegments || []).length) unsupported.push("overlays");
  if (project.trackVisibility?.source !== false && (project.sourceAudioSegments || []).length) unsupported.push("source audio");
  if ((project.visualSegments || []).some((item) => item.transition?.id && item.transition.id !== "none")) unsupported.push("transitions");
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
  const duration = visuals.reduce((sum, segment) => sum + finitePositive(segment.duration, `Visual clip ${segment.id} duration`), 0);
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
    filters.push(`[${inputIndex}:v]${trim}scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,fps=${frameRate},setsar=1,format=yuv420p[v${index}]`);

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

  if (hasVisualAudio) {
    const concatPairs = visuals.map((_, index) => `[v${index}][a${index}]`).join("");
    filters.push(`${concatPairs}concat=n=${visuals.length}:v=1:a=1[vout][vaout]`);
  } else {
    const videoLabels = visuals.map((_, index) => `[v${index}]`).join("");
    filters.push(`${videoLabels}concat=n=${visuals.length}:v=1:a=0[vout]`);
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

  args.push("-filter_complex", filters.join(";"), "-map", "[vout]");
  if (audioLabels.length) {
    args.push("-map", "[aout]", "-c:a", "aac", "-b:a", "192k");
  } else {
    args.push("-an");
  }
  args.push("-c:v", "libx264", "-preset", settings.preset || "medium", "-crf", String(Number(settings.crf) || 18), "-pix_fmt", "yuv420p", "-r", String(frameRate), "-t", String(duration), "-movflags", "+faststart");
  return { args, duration, width, height, frameRate, hasAudio: audioLabels.length > 0 };
}
