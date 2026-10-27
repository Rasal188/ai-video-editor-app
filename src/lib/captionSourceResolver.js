/**
 * Caption Source Media Resolver
 * Resolves the appropriate media blob/track for caption generation
 * from timeline clips (video clips with embedded audio, audio clips, user assets, or source audio).
 */

export async function resolveCaptionSourceMedia(d, options = {}) {
  if (!d) return null;

  if (options.blob) {
    return {
      blob: options.blob,
      start: Number.isFinite(options.start) ? options.start : 0,
      sourceStart: Number.isFinite(options.sourceStart) ? options.sourceStart : 0,
      duration: Number.isFinite(options.duration) ? options.duration : undefined,
    };
  }


  const visualSegments = Array.isArray(d.visualSegments) ? d.visualSegments : [];
  const videoClips = visualSegments.filter((seg) => seg && (seg.type === "video" || !seg.type));
  const audioSegments = Array.isArray(d.audioSegments) ? d.audioSegments : [];

  const resolveAudioCandidate = async () => {
    if (audioSegments.length === 0) return null;
    const targetAudio = (d.selectedAudioSegmentId && audioSegments.find((c) => c.id === d.selectedAudioSegmentId)) || audioSegments[0];
    let candidateBlob = targetAudio.blob || targetAudio.mediaBlob || targetAudio.mediaFile || null;
    if (!candidateBlob && targetAudio.assetId && Array.isArray(d.userAssets)) {
      const asset = d.userAssets.find((a) => a.id === targetAudio.assetId);
      candidateBlob = asset?.blob || asset?.file || null;
    }
    const audioSrc = targetAudio.src || targetAudio.sourceUrl || targetAudio.url;
    if (!candidateBlob && audioSrc && typeof fetch === "function") {
      try {
        const resp = await fetch(audioSrc);
        if (resp.ok) candidateBlob = await resp.blob();
      } catch {
        // ignore fetch failure
      }
    }
    if (candidateBlob) {
      return {
        blob: candidateBlob,
        start: Number.isFinite(options.start) ? options.start : (Number(targetAudio.start) || 0),
        sourceStart: Number.isFinite(options.sourceStart) ? options.sourceStart : (Number(targetAudio.sourceStart) || 0),
        duration: Number.isFinite(options.duration) ? options.duration : (Number(targetAudio.duration) || targetAudio.sourceDuration || undefined),
      };
    }
    return null;
  };

  const resolveVideoCandidate = async () => {
    if (videoClips.length === 0) return null;
    const targetVideo = (d.selectedVisualSegmentId && videoClips.find((c) => c.id === d.selectedVisualSegmentId)) || videoClips[0];
    const isSilent = targetVideo.hasAudio === false || targetVideo.isMuted === true || targetVideo.volume === 0;

    let candidateBlob = targetVideo.blob || targetVideo.mediaBlob || targetVideo.mediaFile || null;
    if (!candidateBlob && targetVideo.assetId && Array.isArray(d.userAssets)) {
      const asset = d.userAssets.find((a) => a.id === targetVideo.assetId);
      candidateBlob = asset?.blob || asset?.file || null;
    }
    const videoSrc = targetVideo.src || targetVideo.sourceUrl || targetVideo.url;
    if (!candidateBlob && videoSrc && typeof fetch === "function") {
      try {
        const resp = await fetch(videoSrc);
        if (resp.ok) candidateBlob = await resp.blob();
      } catch {
        // ignore fetch failure
      }
    }
    if (candidateBlob) {
      const visualIndex = visualSegments.indexOf(targetVideo);
      const derivedTimelineStart = visualSegments
        .slice(0, visualIndex >= 0 ? visualIndex : 0)
        .reduce((sum, seg) => sum + Math.max(0, Number(seg.duration) || 0), 0);
      const clipStart = Number.isFinite(targetVideo.start) ? targetVideo.start : derivedTimelineStart;

      return {
        blob: candidateBlob,
        start: Number.isFinite(options.start) ? options.start : clipStart,
        sourceStart: Number.isFinite(options.sourceStart) ? options.sourceStart : (Number(targetVideo.sourceStart) || 0),
        duration: Number.isFinite(options.duration) ? options.duration : (Number(targetVideo.duration) || targetVideo.sourceDuration || undefined),
        isSilent,
      };
    }
    return null;
  };

  const preferAudio =
    options.track === "audio" ||
    d.selectedTrack === "audio" ||
    (Boolean(d.selectedAudioSegmentId) && !d.selectedVisualSegmentId);

  // If user explicitly preferred audio, or selected an audio segment, try audio first
  if (preferAudio) {
    const audioRes = await resolveAudioCandidate();
    if (audioRes) return audioRes;
  }

  // Next, if there's a sourceAudioBlob (project-level source audio) and no video clips
  if (d.sourceAudioBlob && !preferAudio && videoClips.length === 0) {
    return {
      blob: d.sourceAudioBlob,
      start: Number.isFinite(options.start) ? options.start : (d.sourceAudioStart ?? 0),
      sourceStart: Number.isFinite(options.sourceStart) ? options.sourceStart : 0,
      duration: Number.isFinite(options.duration) ? options.duration : undefined,
    };
  }

  // Try video candidate
  const videoRes = await resolveVideoCandidate();
  if (videoRes) {
    // If video is known to be silent and audio segments exist, fall back to audio
    if (videoRes.isSilent && audioSegments.length > 0) {
      const audioFallback = await resolveAudioCandidate();
      if (audioFallback) return audioFallback;
    }
    const { isSilent, ...cleanVideoRes } = videoRes;
    return cleanVideoRes;
  }

  // Try audio if not tried yet
  if (!preferAudio) {
    const audioRes = await resolveAudioCandidate();
    if (audioRes) return audioRes;
  }

  // Next check sourceAudioBlob if not already checked
  if (d.sourceAudioBlob) {
    return {
      blob: d.sourceAudioBlob,
      start: Number.isFinite(options.start) ? options.start : (d.sourceAudioStart ?? 0),
      sourceStart: Number.isFinite(options.sourceStart) ? options.sourceStart : 0,
      duration: Number.isFinite(options.duration) ? options.duration : undefined,
    };
  }

  // Check userAssets directly if any video or audio asset exists
  if (Array.isArray(d.userAssets)) {
    const mediaAsset = d.userAssets.find((a) => a && (a.type === "video" || a.type === "audio") && (a.blob || a.file || a.src || a.url));
    if (mediaAsset) {
      let candidateBlob = mediaAsset.blob || mediaAsset.file || null;
      const assetSrc = mediaAsset.src || mediaAsset.url;
      if (!candidateBlob && assetSrc && typeof fetch === "function") {
        try {
          const resp = await fetch(assetSrc);
          if (resp.ok) candidateBlob = await resp.blob();
        } catch {
          // ignore
        }
      }
      if (candidateBlob) {
        return {
          blob: candidateBlob,
          start: Number.isFinite(options.start) ? options.start : 0,
          sourceStart: Number.isFinite(options.sourceStart) ? options.sourceStart : 0,
          duration: Number.isFinite(options.duration) ? options.duration : mediaAsset.duration,
        };
      }
    }
  }

  return null;
}
