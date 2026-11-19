export function getOverlayMediaPresentationLayout(visualSize, box, presentation = {}) {
    const sourceWidth = Math.max(1, Number(visualSize?.width) || 1);
    const sourceHeight = Math.max(1, Number(visualSize?.height) || 1);
    const boxWidth = Math.max(1, Number(box?.width) || 1);
    const boxHeight = Math.max(1, Number(box?.height) || 1);
    const fit = ["contain", "cover", "fill"].includes(presentation.fit)
        ? presentation.fit
        : "cover";
    const zoom = Math.max(0.01, Number(presentation.zoom) || 1);
    const rawPositionX = Number(presentation.positionX);
    const rawPositionY = Number(presentation.positionY);
    const positionX = Math.max(0, Math.min(100, Number.isFinite(rawPositionX) ? rawPositionX : 50)) / 100;
    const positionY = Math.max(0, Math.min(100, Number.isFinite(rawPositionY) ? rawPositionY : 50)) / 100;
    let fittedWidth = boxWidth;
    let fittedHeight = boxHeight;
    if (fit !== "fill") {
        const fitScale = fit === "cover"
            ? Math.max(boxWidth / sourceWidth, boxHeight / sourceHeight)
            : Math.min(boxWidth / sourceWidth, boxHeight / sourceHeight);
        fittedWidth = sourceWidth * fitScale;
        fittedHeight = sourceHeight * fitScale;
    }
    const boxX = Number(box?.x) || 0;
    const boxY = Number(box?.y) || 0;
    const fittedX = boxX + (boxWidth - fittedWidth) * positionX;
    const fittedY = boxY + (boxHeight - fittedHeight) * positionY;
    const centerX = boxX + boxWidth / 2;
    const centerY = boxY + boxHeight / 2;
    return {
        fit,
        zoom,
        // Match CSS object-fit/object-position followed by transform: scale(...)
        // around the media element's center, as used by Template Studio/preview.
        x: centerX + (fittedX - centerX) * zoom,
        y: centerY + (fittedY - centerY) * zoom,
        width: fittedWidth * zoom,
        height: fittedHeight * zoom,
    };
}
