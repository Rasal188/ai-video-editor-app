import {
    attachTranscriptionOutcome,
    createTranscriptionOutcome,
    getTranscriptionOutcome,
    transcriptionProviderLabel,
} from "./transcriptionOutcome.js";

import { regroupReviewSegments } from "./transcriptReview.js";

// The shared grouper rebuilds word objects. Restore additive ASR fields without
// replacing its sanitized timing/text or modifying the shared caption mapper.
export function regroupWorkflowTranscript(chunks, duration, options = {}, previousCaptions = []) {
    const originals = previousCaptions.flatMap((caption) => caption.words || []);
    const sources = originals.length ? originals : chunks;
    let cursor = 0;
    const captions = regroupReviewSegments(chunks, duration, options).map((caption) => ({
        ...caption,
        words: (caption.words || []).map((word) => {
            const index = sources.findIndex((source, i) => i >= cursor
                && String(source.text || "").trim() === String(word.text || "").trim());
            if (index < 0) return word;
            cursor = index + 1;
            return { ...sources[index], ...word };
        }),
    }));
    return attachTranscriptionOutcome(captions, getTranscriptionOutcome(previousCaptions) || getTranscriptionOutcome(chunks));
}

// Workflow failures may occur before the dispatcher (for example, missing audio).
// Never expose raw error messages or infer a successful provider from preferences.
export function workflowTranscriptionOutcome(source, preferences, status = "failed") {
    return getTranscriptionOutcome(source) || createTranscriptionOutcome({
        status,
        requestedProvider: preferences?.provider,
        reasonCode: status === "cancelled" ? "TRANSCRIPTION_CANCELLED" : "TRANSCRIPTION_FAILED",
    });
}

export function isTranscriptionCancellation(error, signal) {
    return signal?.aborted || error?.name === "AbortError"
        || getTranscriptionOutcome(error)?.status === "cancelled";
}

// Cancelling later analysis must not relabel an already completed transcript.
export function cancelledWorkflowTranscription(controller, preferences) {
    return controller?.transcriptionOutcome || (controller?.transcriptionStarted
        ? workflowTranscriptionOutcome(null, preferences, "cancelled") : null);
}

export function workflowTranscriptionStatus(source) {
    const outcome = getTranscriptionOutcome(source);
    if (!outcome) return "";
    const reason = outcome.reasonCode ? ` (${outcome.reasonCode})` : "";
    if (outcome.status === "cancelled") return `Transcription cancelled${reason}. No new transcript was generated.`;
    if (outcome.status === "failed") {
        const attempt = outcome.fallbackAttempted ? " Local Whisper fallback also failed." : "";
        return `Transcription failed${reason}.${attempt} Speech captions and filler detection are unavailable; any remaining results use non-transcript analysis.`;
    }
    const label = transcriptionProviderLabel(outcome) || "Speech recognition";
    const fallback = outcome.fallbackUsed && outcome.fallbackReasonCode
        ? ` (${outcome.fallbackReasonCode})` : "";
    return `Transcript ready — ${label}${fallback}.`;
}
