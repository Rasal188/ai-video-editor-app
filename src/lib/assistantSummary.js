/**
 * Extracts a minimal, sanitized project summary for the AI assistant.
 * Omit media blobs, base64 data, audio buffers, and large object graphs.
 */
export function extractMinimalProjectSummary(project, options = {}) {
  const visuals = Array.isArray(project?.visualSegments) ? project.visualSegments : [];
  const captions = Array.isArray(project?.captionSegments) ? project.captionSegments : [];
  const audio = Array.isArray(project?.audioSegments) ? project.audioSegments : [];
  const music = Array.isArray(project?.musicSegments) ? project.musicSegments : [];
  const markers = Array.isArray(project?.timelineMarkers) ? project.timelineMarkers : [];

  const selectedClipId = options.selectedClipId
    || options.selectedVisualSegmentId
    || options.selectedAudioSegmentId
    || options.selectedSegmentId
    || project?.selectedClipId
    || "";
  const selectedTrack = options.selectedTrack || project?.selectedTrack || "";
  const currentTime = Number.isFinite(options.currentTime)
    ? Number(options.currentTime)
    : Number.isFinite(project?.currentTime)
    ? Number(project.currentTime)
    : 0;

  const overlays = Array.isArray(project?.visualOverlaySegments)
    ? project.visualOverlaySegments
    : Array.isArray(project?.overlays)
    ? project.overlays
    : [];
  const trackLocks = project?.trackLocks || {};
  const trackVisibility = project?.trackVisibility || {};

  let visualCursor = 0;
  const visualClips = visuals.map((clip, index) => {
    const duration = Math.max(0, Number(clip.duration) || 0);
    const start = visualCursor;
    visualCursor += duration;
    return {
      id: clip.id,
      index,
      name: clip.name || `clip-${index + 1}`,
      type: clip.type || "video",
      start: Number(start.toFixed(3)),
      end: Number((start + duration).toFixed(3)),
      duration: Number(duration.toFixed(3)),
      speed: Number(clip.playbackRate || clip.speed || 1),
      transition: clip.transition?.id || (typeof clip.transition === "string" ? clip.transition : null),
      muted: Boolean(clip.muted),
      volume: Number.isFinite(clip.volume) ? Number(clip.volume) : 1,
    };
  });

  const captionItems = captions.map((c, index) => {
    const start = Math.max(0, Number(c.start) || 0);
    const end = Math.max(start, Number(c.end) || 0);
    return {
      id: c.id || `cap-${index + 1}`,
      text: String(c.text || "").slice(0, 150),
      start: Number(start.toFixed(3)),
      end: Number((end.toFixed(3))),
      duration: Number((end - start).toFixed(3)),
    };
  });

  const audioItems = audio.map((a, index) => {
    const start = Math.max(0, Number(a.start) || 0);
    const duration = Math.max(0, Number(a.duration) || 0);
    return {
      id: a.id || `audio-${index + 1}`,
      name: a.name || `voiceover-${index + 1}`,
      start: Number(start.toFixed(3)),
      duration: Number(duration.toFixed(3)),
      end: Number((start + duration).toFixed(3)),
      muted: Boolean(a.muted),
      volume: Number.isFinite(a.volume) ? Number(a.volume) : 1,
    };
  });

  const musicItems = music.map((m, index) => {
    const start = Math.max(0, Number(m.start) || 0);
    const duration = Math.max(0, Number(m.duration) || 0);
    return {
      id: m.id || `music-${index + 1}`,
      name: m.name || project?.musicName || "background-music",
      start: Number(start.toFixed(3)),
      duration: Number(duration.toFixed(3)),
      end: Number((start + duration).toFixed(3)),
      muted: Boolean(m.muted),
      volume: Number.isFinite(m.volume) ? Number(m.volume) : (Number.isFinite(project?.musicVolume) ? Number(project.musicVolume) : 1),
    };
  });

  const overlayItems = overlays.map((o, index) => {
    const start = Math.max(0, Number(o.start) || 0);
    const duration = Math.max(0, Number(o.duration) || 0);
    return {
      id: o.id || `overlay-${index + 1}`,
      name: o.name || `overlay-${index + 1}`,
      type: o.type || "overlay",
      start: Number(start.toFixed(3)),
      duration: Number(duration.toFixed(3)),
      end: Number((start + duration).toFixed(3)),
    };
  });

  const markerItems = markers.map((m, index) => ({
    id: m.id || `m-${index + 1}`,
    time: Number((Number(m.time) || 0).toFixed(3)),
    type: m.type || "marker",
    title: (m.title || "").slice(0, 50),
    color: m.color || "cyan",
  }));

  const visualEnd = visualClips.reduce((acc, c) => Math.max(acc, c.end), 0);
  const captionEnd = captionItems.reduce((acc, c) => Math.max(acc, c.end), 0);
  const audioEnd = audioItems.reduce((acc, a) => Math.max(acc, a.end), 0);
  const musicEnd = musicItems.reduce((acc, m) => Math.max(acc, m.end), 0);
  const overlayEnd = overlayItems.reduce((acc, o) => Math.max(acc, o.end), 0);
  const explicitDuration = Math.max(
    0,
    Number(project?.duration) || 0,
    Number(project?.audioDuration) || 0,
    Number(project?.musicDuration) || 0
  );
  const totalDuration = Math.max(visualEnd, captionEnd, audioEnd, musicEnd, overlayEnd, explicitDuration);

  return {
    ratio: project?.ratioId || "16:9",
    fitMode: project?.fitMode || "cover",
    duration: Number(totalDuration.toFixed(2)),
    currentTime: Number(currentTime.toFixed(3)),
    selectedClipId,
    selectedTrack,
    visualClips,
    visuals: visualClips,
    visualsCount: visualClips.length,
    captions: captionItems,
    captionSegments: captionItems,
    captionsCount: captionItems.length,
    hasCaptions: captionItems.length > 0,
    hasTranscription: captionItems.length > 0,
    audioSegments: audioItems,
    audioCount: audioItems.length,
    voiceoverCount: audioItems.length,
    hasVoiceover: audioItems.length > 0 || Boolean(project?.audioDuration),
    musicSegments: musicItems,
    musicCount: musicItems.length,
    hasMusic: musicItems.length > 0 || Boolean(project?.musicDuration),
    hasAudio: audioItems.length > 0 || musicItems.length > 0 || Boolean(project?.audioDuration || project?.musicDuration),
    overlays: overlayItems,
    visualOverlaySegments: overlayItems,
    overlaysCount: overlayItems.length,
    markers: markerItems,
    markersCount: markerItems.length,
    trackLocks,
    trackVisibility,
  };
}
