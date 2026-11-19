import test from "node:test";
import assert from "node:assert/strict";

import { resolveAudioToolVideoTarget } from "../../src/lib/audioToolTarget.js";

function video(id, overrides = {}) {
    return {
        id,
        type: "video",
        blob: new Blob([id], { type: "video/mp4" }),
        duration: 8,
        sourceStart: 0,
        ...overrides,
    };
}

test("keeps an imported selected video eligible after caption workflow takes track focus", () => {
    const selected = video("visual-selected");
    const target = resolveAudioToolVideoTarget({
        selectedTrack: "caption",
        selectedVisualSegment: selected,
        selectedVisualRange: { start: 12, end: 20 },
        previewVisualSegment: video("visual-preview"),
        previewVisualRange: { start: 20, end: 28 },
    });

    assert.equal(target.segmentId, selected.id);
    assert.equal(target.blob, selected.blob);
    assert.equal(target.track, "image");
    assert.equal(target.start, 12);
    assert.equal(target.embeddedVideo, true);
    assert.equal(target.canChangeStart, false);
    assert.equal(target.canChangeSpeed, false);
});

test("uses the video under the playhead when caption selection cleared visual clip focus", () => {
    const preview = video("visual-at-playhead");
    const target = resolveAudioToolVideoTarget({
        selectedTrack: "caption",
        selectedVisualSegment: null,
        selectedVisualRange: null,
        previewVisualSegment: preview,
        previewVisualRange: { start: 30, end: 38 },
    });

    assert.equal(target.segmentId, preview.id);
    assert.equal(target.blob, preview.blob);
    assert.equal(target.track, "image");
    assert.equal(target.start, 30);
});

test("preserves an explicitly selected video overlay as the separation target", () => {
    const overlay = video("overlay-video", { start: 4 });
    const target = resolveAudioToolVideoTarget({
        selectedTrack: "overlay",
        selectedVisualOverlay: overlay,
        selectedVisualSegment: video("visual-selected"),
        selectedVisualRange: { start: 0, end: 8 },
    });

    assert.equal(target.segmentId, overlay.id);
    assert.equal(target.blob, overlay.blob);
    assert.equal(target.track, "overlay");
    assert.equal(target.start, 4);
});

test("does not advertise image-only or blobless media for vocal separation", () => {
    assert.equal(resolveAudioToolVideoTarget({
        selectedTrack: "caption",
        selectedVisualSegment: { id: "still", type: "image", blob: new Blob(["image"]) },
        previewVisualSegment: { id: "remote-video", type: "video", src: "blob:fixture" },
    }), null);
});
