import { serializeSrt } from "./subtitles.js";

// A successful click requests a browser download; it does not confirm disk delivery.
export function downloadCaptionSrt(captions, duration = 0, {
    documentImpl = globalThis.document,
    urlImpl = globalThis.URL,
    schedule = globalThis.setTimeout,
} = {}) {
    const srt = serializeSrt(captions, duration, { preserveText: true });
    if (!srt) return false;
    const blob = new Blob(["\uFEFF", srt], { type: "application/x-subrip;charset=utf-8" });
    const url = urlImpl.createObjectURL(blob);
    let anchor;
    try {
        anchor = documentImpl.createElement("a");
        anchor.href = url;
        anchor.download = "captions.srt";
        anchor.hidden = true;
        documentImpl.body.appendChild(anchor);
        anchor.click();
    } catch (error) {
        urlImpl.revokeObjectURL(url);
        throw error;
    } finally {
        anchor?.remove();
    }
    schedule(() => urlImpl.revokeObjectURL(url), 800);
    return true;
}
