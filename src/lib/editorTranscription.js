import { getTranscriptionOutcome, transcriptionProviderLabel } from "./transcriptionOutcome.js";

// Editor completions describe only the safe dispatcher outcome, never raw errors
// or a provider inferred from the user's current preference.
export function editorTranscriptionStatus(source) {
    const outcome = getTranscriptionOutcome(source);
    const label = transcriptionProviderLabel(source);
    if (!outcome) return label || "Transcription provider unavailable";
    const reason = outcome.reasonCode ? ` (${outcome.reasonCode})` : "";
    if (outcome.status === "cancelled") return `Transcription cancelled${reason}. No new captions were applied.`;
    if (outcome.status === "failed") return `Transcription failed${reason}.${outcome.fallbackAttempted ? " Local Whisper fallback also failed." : ""} No new captions were applied.`;
    return `${label || "Transcription complete"}${outcome.fallbackUsed && outcome.fallbackReasonCode ? ` (${outcome.fallbackReasonCode})` : ""}`;
}
