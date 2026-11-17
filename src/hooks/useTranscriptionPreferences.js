import { useSyncExternalStore } from "react";
import { getTranscriptionPreferences, setTranscriptionPreferences, subscribeTranscriptionPreferences } from "../lib/transcriptionPreferences.js";

export function useTranscriptionPreferences() {
    const value = useSyncExternalStore(subscribeTranscriptionPreferences, getTranscriptionPreferences, getTranscriptionPreferences);
    return [value, setTranscriptionPreferences];
}
