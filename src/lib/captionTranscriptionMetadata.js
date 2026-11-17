import { createTranscriptionOutcome, getTranscriptionOutcome } from "./transcriptionOutcome.js";

const nullableString = { type: ["string", "null"] };
export const CAPTION_TRANSCRIPTION_SCHEMA = {
    words: {
        type: "array", maxItems: 10000, items: {
            type: "object", required: ["text", "start", "end"],
            properties: { text: { type: "string", maxLength: 20000 }, start: { type: "number", minimum: 0 }, end: { type: "number", minimum: 0 } },
            // Word-level ASR annotations are additive data, not edit parameters.
            additionalProperties: true,
        },
    },
    transcriptionProvider: { type: "string", enum: ["local-whisper", "ollalink-fast", "ollalink-hq"] },
    transcriptionOutcome: {
        type: "object", additionalProperties: false,
        properties: {
            status: { type: "string", enum: ["succeeded", "failed", "cancelled"] },
            requestedProvider: { enum: ["local", "ollalink", null] },
            provider: { enum: ["local-whisper", "ollalink-fast", "ollalink-hq", null] },
            fallbackAttempted: { type: "boolean" }, fallbackUsed: { type: "boolean" },
            fallbackFrom: { enum: ["ollalink", null] },
            fallbackReasonCode: nullableString, reasonCode: nullableString,
        },
        required: Object.keys(createTranscriptionOutcome()),
    },
};

export function validCaptionTranscriptionMetadata(operation) {
    if (Object.hasOwn(operation, "transcriptionProvider")
        && !CAPTION_TRANSCRIPTION_SCHEMA.transcriptionProvider.enum.includes(operation.transcriptionProvider)) return false;
    if (Object.hasOwn(operation, "transcriptionOutcome")) {
        const value = operation.transcriptionOutcome;
        const safe = getTranscriptionOutcome(value);
        if (!safe || Object.keys(value).length !== Object.keys(safe).length
            || Object.keys(safe).some(key => value[key] !== safe[key])) return false;
    }
    if (Object.hasOwn(operation, "words")) {
        if (!Array.isArray(operation.words) || operation.words.length > 10000) return false;
        if (operation.words.some(word => !word || typeof word !== "object" || Array.isArray(word)
            || typeof word.text !== "string" || word.text.length > 20000
            || !Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < 0 || word.end < word.start)) return false;
        try {
            // Bound additive annotations and reject non-JSON/cyclic runtime values.
            const data = JSON.stringify(operation.words, (_key, value) => {
                if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint"
                    || (typeof value === "number" && !Number.isFinite(value))) throw new Error("Invalid word metadata");
                return value;
            });
            if (data.length > 2000000) return false;
        } catch { return false; }
    }
    return true;
}
