import { createTemplateOverlayRenderSource } from "./shortsOverlayTemplates.js";

export function restoreProjectVisualSegmentSource(segment) {
    if (["text", "shape"].includes(segment?.kind) && (segment.text || segment.shape)) {
        return {
            ...segment,
            src: createTemplateOverlayRenderSource(segment),
        };
    }
    return segment?.src ? segment : null;
}
