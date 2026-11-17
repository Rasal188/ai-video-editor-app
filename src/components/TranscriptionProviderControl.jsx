const LANGUAGES = [
    ["en", "English"], ["es", "Español"], ["fr", "Français"], ["de", "Deutsch"],
    ["pt", "Português"], ["ru", "Русский"], ["hi", "हिन्दी"], ["zh", "中文"], ["ar", "العربية"],
];
const LOCAL_LANGUAGES = [
    ["ja", "日本語"], ["ko", "한국어"], ["it", "Italiano"], ["th", "ไทย"],
    ["vi", "Tiếng Việt"], ["id", "Bahasa Indonesia"],
];

export function TranscriptionProviderControl({ value, onChange, disabled }) {
    const languages = value.provider === "local" ? [...LANGUAGES, ...LOCAL_LANGUAGES] : LANGUAGES;
    return (
        <div className="caption-grouping-control">
            <label>
                <span>Transcription provider</span>
                <select aria-label="Transcription provider" value={value.provider} disabled={disabled}
                    onChange={(event) => onChange({ ...value, provider: event.target.value })}>
                    <option value="local">Local Whisper (on device)</option>
                    <option value="ollalink">Ollalink Cloud (on-device outage fallback)</option>
                </select>
            </label>
            <>
                <label>
                    <span>Spoken audio language</span>
                    <select aria-label="Spoken audio language" value={value.language} disabled={disabled}
                        onChange={(event) => onChange({ ...value, language: event.target.value })}>
                        {!languages.some(([code]) => code === value.language)
                            && <option value={value.language}>{value.language} (not supported by selected provider)</option>}
                        {languages.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
                    </select>
                </label>
                <p>Ollalink Cloud uploads audio to Ollalink. Temporary cloud outages fall back once to Local Whisper on this device; cancellation, sign-in and invalid input do not. Local Whisper never uploads audio. Sign-in and a server-configured GPU key are required. Choose the recording’s language, not the UI language. Hindi, Chinese and Arabic use the word-timestamp model (10-minute limit).</p>
            </>
        </div>
    );
}
