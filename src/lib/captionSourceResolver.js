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

  if (d.sourceAudioBlob) {
    return {
      blob: d.sourceAudioBlob,
      start: Number.isFinite(options.start) ? options.start : (d.sourceAudioStart ?? 0),
      sourceStart: Number.isFinite(options.sourceStart) ? options.sourceStart : 0,
      duration: Number.isFinite(options.duration) ? options.duration : undefined,
    };
  }

  // 1. Check visualSegments for video clips with embedded audio
  const visualSegments = Array.isArray(d.visualSegments) ? d.visualSegments : [];
  const videoClips = visualSegments.filter((seg) => seg && (seg.type === "video" || !seg.type));
  if (videoClips.length > 0) {
    const targetVideo = (d.selectedVisualSegmentId && videoClips.find((c) => c.id === d.selectedVisualSegmentId)) || videoClips[0];
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
      return {
        blob: candidateBlob,
        start: Number.isFinite(options.start) ? options.start : (Number(targetVideo.start) || 0),
        sourceStart: Number.isFinite(options.sourceStart) ? options.sourceStart : (Number(targetVideo.sourceStart) || 0),
        duration: Number.isFinite(options.duration) ? options.duration : (Number(targetVideo.duration) || targetVideo.sourceDuration || undefined),
      };
    }
  }

  // 2. Check standalone audioSegments
  const audioSegments = Array.isArray(d.audioSegments) ? d.audioSegments : [];
  if (audioSegments.length > 0) {
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
  }

  // 3. Check userAssets directly if any video or audio asset exists
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
