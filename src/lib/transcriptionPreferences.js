export const TRANSCRIPTION_PREFERENCE_KEY = "timeline-studio-transcription";
export const DEFAULT_TRANSCRIPTION_PREFERENCES = Object.freeze({ provider: "ollalink", language: "en" });

const listeners = new Set();
let current;

export function normalizeTranscriptionPreferences(value, fallback = DEFAULT_TRANSCRIPTION_PREFERENCES) {
    return Object.freeze({
        provider: value?.provider === "local" || value?.provider === "ollalink" ? value.provider : fallback.provider,
        // Spoken language is independent of the editor's display locale. Preserve
        // explicit local languages; the cloud boundary validates its supported set.
        language: typeof value?.language === "string" && /^[a-z]{2,3}(?:-[A-Za-z0-9]+)?$/.test(value.language)
            ? value.language : fallback.language,
    });
}

export function readSavedTranscriptionPreferences(storage) {
    try {
        storage ??= globalThis.localStorage;
        return normalizeTranscriptionPreferences(JSON.parse(storage?.getItem(TRANSCRIPTION_PREFERENCE_KEY) || "null"));
    } catch {
        return DEFAULT_TRANSCRIPTION_PREFERENCES;
    }
}

export function getTranscriptionPreferences() {
    current ??= readSavedTranscriptionPreferences();
    return current;
}

function publish(value) {
    current = value;
    listeners.forEach(listener => listener());
    return value;
}

export function setTranscriptionPreferences(value) {
    const next = normalizeTranscriptionPreferences(value, getTranscriptionPreferences());
    try { globalThis.localStorage?.setItem(TRANSCRIPTION_PREFERENCE_KEY, JSON.stringify(next)); } catch { /* Storage may be disabled. */ }
    return publish(next);
}

// Project choices take precedence while the project is open, but importing a
// project must never overwrite the user's separately saved browser preference.
export function restoreProjectTranscriptionPreferences(project) {
    return publish(project?.transcription
        ? normalizeTranscriptionPreferences(project.transcription, readSavedTranscriptionPreferences())
        : readSavedTranscriptionPreferences());
}

export function subscribeTranscriptionPreferences(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function captureTranscriptionPreferences(options = {}) {
    const selected = getTranscriptionPreferences();
    return Object.freeze({
        ...selected, ...options,
        provider: options.provider ?? selected.provider,
        language: options.language ?? selected.language,
    });
}
