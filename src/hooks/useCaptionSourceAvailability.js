import { useEffect, useState } from "react";
import { isCaptionSourceAvailable } from "../lib/captionSourceResolver.js";

export function useCaptionSourceAvailability(d, options = {}) {
    const [result, setResult] = useState(null);
    const { sourceAudioBlob, sourceAudioStart, visualSegments, audioSegments, userAssets,
        selectedVisualSegmentId, selectedAudioSegmentId, selectedTrack, status, trackLocks } = d;
    const { blob, mediaBlob, mediaFile, src, sourceUrl, url, start, sourceStart, duration, hasAudio, isMuted, volume } = options;
    // A source change immediately invalidates the old result, before the effect
    // runs. Late metadata results from a previous project cannot enable this one.
    const sources = [sourceAudioBlob, sourceAudioStart, visualSegments, audioSegments, userAssets,
        selectedVisualSegmentId, selectedAudioSegmentId, selectedTrack, blob, mediaBlob, mediaFile, src, sourceUrl, url, start, sourceStart, duration, hasAudio, isMuted, volume];
    useEffect(() => {
        const controller = new AbortController();
        const state = {
            sourceAudioBlob, sourceAudioStart, visualSegments, audioSegments, userAssets,
            selectedVisualSegmentId, selectedAudioSegmentId, selectedTrack
        };
        const inputs = [sourceAudioBlob, sourceAudioStart, visualSegments, audioSegments, userAssets,
            selectedVisualSegmentId, selectedAudioSegmentId, selectedTrack, blob, mediaBlob, mediaFile, src, sourceUrl, url, start, sourceStart, duration, hasAudio, isMuted, volume];
        isCaptionSourceAvailable(state, { blob, mediaBlob, mediaFile, src, sourceUrl, url, start, sourceStart, duration, hasAudio, isMuted, volume, signal: controller.signal })
            .then(available => { if (!controller.signal.aborted) setResult({ inputs, available }); })
            .catch(() => { if (!controller.signal.aborted) setResult({ inputs, available: false }); });
        return () => controller.abort();
    }, [sourceAudioBlob, sourceAudioStart, visualSegments, audioSegments, userAssets,
        selectedVisualSegmentId, selectedAudioSegmentId, selectedTrack, blob, mediaBlob, mediaFile, src, sourceUrl, url, start, sourceStart, duration, hasAudio, isMuted, volume]);
    return Boolean(result?.available && result.inputs.every((value, index) => value === sources[index])
        && status !== "generating" && status !== "captioning" && !trackLocks?.caption && !trackLocks?.captions);
}
