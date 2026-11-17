// One operation owns callbacks until it settles. Aborted or superseded callbacks
// are inert, including deferred React state updaters and unmount cleanup.
export function createAutoCaptionOperationScope() {
    let current = null;
    let active = false;
    return {
        get active() { return active; },
        begin() {
            if (active) return null;
            const controller = new AbortController();
            const operation = {
                signal: controller.signal,
                abort: () => controller.abort(),
                isCurrent: () => current === operation && !controller.signal.aborted,
                isOwner: () => current === operation,
                finish: () => { if (current === operation) active = false; },
            };
            current = operation;
            active = true;
            return operation;
        },
        cancel() { if (active) current?.abort(); },
        dispose() { current?.abort(); current = null; active = false; },
    };
}

export function captionProviderLabel(result) {
    if (result?.fallbackFrom) return "Ollalink unavailable — Local Whisper fallback";
    if (result?.provider === "ollalink-fast") return "Ollalink fast";
    if (result?.provider === "ollalink-hq") return "Ollalink HQ (word timestamps)";
    return "Local Whisper";
}
