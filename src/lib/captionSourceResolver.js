/**
 * Caption Source Media Resolver
 * Resolves the appropriate media blob/track for caption generation
 * from timeline clips (video clips with embedded audio, audio clips, user assets, or source audio).
 */

async function resolveCaptionSourceCandidate(d, options = {}) {
  options.signal?.throwIfAborted();
  if (!d) return null;
  const eligible = async blob => {
    const available = await (options.probeAudio || hasDecodableCaptionAudio)(blob);
    options.signal?.throwIfAborted();
    return available;
  };

  const explicitSrc = options.src || options.sourceUrl || options.url;
  if (options.blob || options.mediaBlob || options.mediaFile || explicitSrc) {
    if (options.hasAudio === false || options.isMuted === true || options.volume === 0) return null;
    let blob = options.blob || options.mediaBlob || options.mediaFile;
    if (!blob && explicitSrc) {
      try {
        const response = await fetch(explicitSrc, { signal: options.signal });
        if (response.ok) blob = await response.blob();
      } catch { options.signal?.throwIfAborted(); }
    }
    if (!blob || !await eligible(blob)) return null;
    return {
      blob,
      start: Number.isFinite(options.start) ? options.start : 0,
      sourceStart: Number.isFinite(options.sourceStart) ? options.sourceStart : 0,
      duration: Number.isFinite(options.duration) ? options.duration : undefined,
    };
  }


  const visualSegments = Array.isArray(d.visualSegments) ? d.visualSegments : [];
  const videoClips = visualSegments.filter((seg) => seg && (seg.type === "video" || !seg.type));
  const audioSegments = Array.isArray(d.audioSegments) ? d.audioSegments : [];

  const resolveAudioCandidate = async () => {
    options.signal?.throwIfAborted();
    if (audioSegments.length === 0) return null;
    const targetAudio = (d.selectedAudioSegmentId && audioSegments.find((c) => c.id === d.selectedAudioSegmentId)) || audioSegments[0];
    if (targetAudio.hasAudio === false || targetAudio.isMuted === true || targetAudio.volume === 0) return null;
    let candidateBlob = targetAudio.blob || targetAudio.mediaBlob || targetAudio.mediaFile || null;
    if (!candidateBlob && targetAudio.assetId && Array.isArray(d.userAssets)) {
      const asset = d.userAssets.find((a) => a.id === targetAudio.assetId);
      candidateBlob = asset?.blob || asset?.file || null;
    }
    const audioSrc = targetAudio.src || targetAudio.sourceUrl || targetAudio.url;
    if (!candidateBlob && audioSrc && typeof fetch === "function") {
      try {
        const resp = await fetch(audioSrc, { signal: options.signal });
        options.signal?.throwIfAborted();
        if (resp.ok) candidateBlob = await resp.blob();
        options.signal?.throwIfAborted();
      } catch {
        options.signal?.throwIfAborted();
        // ignore fetch failure
      }
    }
    if (candidateBlob && await eligible(candidateBlob)) {
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
    options.signal?.throwIfAborted();
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
        const resp = await fetch(videoSrc, { signal: options.signal });
        options.signal?.throwIfAborted();
        if (resp.ok) candidateBlob = await resp.blob();
        options.signal?.throwIfAborted();
      } catch {
        options.signal?.throwIfAborted();
        // ignore fetch failure
      }
    }
    if (!isSilent && candidateBlob && await eligible(candidateBlob)) {
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
  if (d.sourceAudioBlob && !preferAudio && videoClips.length === 0 && await eligible(d.sourceAudioBlob)) {
    return {
      blob: d.sourceAudioBlob,
      start: Number.isFinite(options.start) ? options.start : (d.sourceAudioStart ?? 0),
      sourceStart: Number.isFinite(options.sourceStart) ? options.sourceStart : 0,
      duration: Number.isFinite(options.duration) ? options.duration : undefined,
    };
  }

  // Try video candidate
  const videoRes = await resolveVideoCandidate();
  if (videoRes && !videoRes.isSilent) {
    const { isSilent, ...cleanVideoRes } = videoRes;
    return cleanVideoRes;
  }

  // Try audio if not tried yet
  if (!preferAudio) {
    const audioRes = await resolveAudioCandidate();
    if (audioRes) return audioRes;
  }

  // Next check sourceAudioBlob if not already checked
  if (d.sourceAudioBlob && await eligible(d.sourceAudioBlob)) {
    return {
      blob: d.sourceAudioBlob,
      start: Number.isFinite(options.start) ? options.start : (d.sourceAudioStart ?? 0),
      sourceStart: Number.isFinite(options.sourceStart) ? options.sourceStart : 0,
      duration: Number.isFinite(options.duration) ? options.duration : undefined,
    };
  }

  // Check userAssets directly if any video or audio asset exists
  if (Array.isArray(d.userAssets)) {
    const mediaAssets = d.userAssets.filter((a) => a && (a.type === "video" || a.type === "audio") && a.hasAudio !== false && !a.isMuted && a.volume !== 0 && (a.blob || a.file || a.src || a.url)
      && !visualSegments.some(clip => clip.assetId === a.id && (clip.hasAudio === false || clip.isMuted || clip.volume === 0)));
    for (const mediaAsset of mediaAssets) {
      let candidateBlob = mediaAsset.blob || mediaAsset.file || null;
      const assetSrc = mediaAsset.src || mediaAsset.url;
      if (!candidateBlob && assetSrc && typeof fetch === "function") {
        try {
          const resp = await fetch(assetSrc, { signal: options.signal });
          options.signal?.throwIfAborted();
          if (resp.ok) candidateBlob = await resp.blob();
          options.signal?.throwIfAborted();
        } catch {
          options.signal?.throwIfAborted();
          // ignore
        }
      }
      if (candidateBlob && await eligible(candidateBlob)) {
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

// Metadata only: no PCM extraction, source-track registration, or inference.
// Weak keys avoid retaining large imported media after a project is closed.
const audioCapabilityCache = new WeakMap();
export function hasDecodableCaptionAudio(blob) {
  if (!(blob instanceof Blob) || !blob.size) return Promise.resolve(false);
  if (!audioCapabilityCache.has(blob)) {
    audioCapabilityCache.set(blob, (async () => {
      const { Input, BlobSource, ALL_FORMATS } = await import("mediabunny");
      const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
      try {
        const track = await input.getPrimaryAudioTrack();
        return Boolean(track && await track.canDecode());
      } finally { input.dispose(); }
    })().catch(() => false));
  }
  return audioCapabilityCache.get(blob);
}

export async function resolveCaptionSourceMedia(d, options = {}) {
  const source = await resolveCaptionSourceCandidate(d, options);
  options.signal?.throwIfAborted();
  if (!source) return null;
  return source;
}

export async function isCaptionSourceAvailable(d, options = {}) {
  if (!d || d.status === "generating" || d.status === "captioning"
    || d.trackLocks?.caption || d.trackLocks?.captions) return false;
  return Boolean(await resolveCaptionSourceMedia(d, options));
}
