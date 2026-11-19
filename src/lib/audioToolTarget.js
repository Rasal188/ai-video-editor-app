function embeddedVideoTarget(segment, track, start) {
    if (segment?.type !== "video" || !segment.blob) return null;
    return {
        ...segment,
        segmentId: segment.id,
        track,
        ...(Number.isFinite(start) ? { start } : {}),
        canChangeStart: false,
        canChangeSpeed: false,
        embeddedVideo: true,
    };
}

/**
 * Resolve embedded video audio for the Audio workspace without requiring a
 * duplicate source-audio extraction. Explicit visual/overlay focus wins. When
 * another workflow (for example captions) owns track focus, retain the chosen
 * visual video or use the video under the playhead.
 */
export function resolveAudioToolVideoTarget({
    selectedTrack = "",
    selectedVisualSegment = null,
    selectedVisualRange = null,
    selectedVisualOverlay = null,
    previewVisualSegment = null,
    previewVisualRange = null,
} = {}) {
    if (selectedTrack === "overlay") {
        return embeddedVideoTarget(
            selectedVisualOverlay,
            "overlay",
            selectedVisualOverlay?.start,
        );
    }

    if (selectedTrack === "image") {
        return embeddedVideoTarget(
            selectedVisualSegment,
            "image",
            selectedVisualRange?.start,
        );
    }

    const retainedVisualTarget = embeddedVideoTarget(
        selectedVisualSegment,
        "image",
        selectedVisualRange?.start,
    );
    if (retainedVisualTarget) return retainedVisualTarget;

    return embeddedVideoTarget(
        previewVisualSegment,
        "image",
        previewVisualRange?.start,
    );
}
