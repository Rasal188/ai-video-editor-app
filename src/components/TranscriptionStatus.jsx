// A separate live region keeps selected-clip duration visible in the header.
export function TranscriptionStatus({ active, statusText, progress, onCancel, t }) {
    if (!active && !/Ollalink|Local Whisper|Transcription cancelled/.test(statusText || "")) return null;
    const determinate = Number.isFinite(progress);
    return (
        <section className="transcription-status" aria-label={t("transcriptionStatus", "Transcription status")}>
            <div role="status" aria-live="polite" aria-atomic="true">{statusText}</div>
            {active ? <>
                <progress aria-label={t("transcriptionProgress", "Transcription progress")} max="100" value={determinate ? progress : undefined} />
                <button type="button" onClick={onCancel} disabled={!onCancel}>{t("cancelTranscription", "Cancel transcription")}</button>
            </> : null}
        </section>
    );
}
