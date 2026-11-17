import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
    OLLALINK_TTS_MAX_CHARACTERS,
    OllalinkTtsError, requestOllalinkSpeech, validateOllalinkTtsRequest,
} from "../lib/ollalinkTts.js";
import { hasOllalinkTtsPair, requestOllalinkTtsCatalog } from "../lib/ollalinkTtsCatalog.js";

// This subtree owns cloud work only. It never reads local speed/gain/clone settings.
export function OllalinkTtsPanel({ script, captionSegment, selectionKey, status, beginOllalinkSpeech, useLocal }) {
    const [voice, setVoice] = useState("");
    const [language, setLanguage] = useState("");
    const [catalog, setCatalog] = useState(null);
    const [catalogState, setCatalogState] = useState("loading");
    const [catalogVersion, setCatalogVersion] = useState(0);
    useEffect(() => {
        const controller = new AbortController();
        setCatalogState("loading");
        setCatalog(null);
        requestOllalinkTtsCatalog({ signal: controller.signal }).then(value => {
            if (!controller.signal.aborted) { setCatalog(value); setCatalogState("ready"); }
        }, () => { if (!controller.signal.aborted) setCatalogState("error"); });
        return () => controller.abort();
    }, [catalogVersion]);
    const [state, setState] = useState("idle");
    const [message, setMessage] = useState("");
    const operation = useRef(null);
    const current = useRef(null);
    current.current = { script, voice, language, captionSegment, selectionKey, catalog };

    useLayoutEffect(() => {
        // A successful commit changes caption timing/selection too; keep its success
        // notice. Only an interrupted in-flight operation needs its busy UI cleared.
        setState(value => value === "generating" ? "idle" : value);
        return () => {
            const active = operation.current;
            operation.current = null;
            active?.controller.abort();
            active?.session?.end();
        };
    }, [script, voice, language, captionSegment, selectionKey, catalogVersion]);

    const cancel = () => {
        const active = operation.current;
        operation.current = null;
        active?.controller.abort();
        active?.session?.end();
        setState("cancelled");
        setMessage(new OllalinkTtsError("TTS_CANCELLED").message);
    };

    const generate = async () => {
        // Ref lock is synchronous: two clicks in the same render cannot submit twice.
        if (operation.current || status === "generating" || status === "captioning" ||
            catalogState !== "ready" || !hasOllalinkTtsPair(catalog, voice, language)) return;
        const snapshot = current.current;
        const active = { controller: new AbortController(), session: null };
        const isCurrent = () => operation.current === active && !active.controller.signal.aborted
            && current.current.script === snapshot.script && current.current.voice === snapshot.voice
            && current.current.language === snapshot.language && current.current.captionSegment === snapshot.captionSegment
            && current.current.selectionKey === snapshot.selectionKey && current.current.catalog === snapshot.catalog;
        operation.current = active;
        let committed = false;
        try {
            const request = validateOllalinkTtsRequest({ input: script, voice, language, response_format: "wav" });
            active.session = beginOllalinkSpeech?.({
                input: script, captionSegment, signal: active.controller.signal, shouldCommit: isCurrent,
            });
            if (!active.session) throw new Error("Unavailable");
            setState("generating");
            setMessage("Generating speech…");
            const result = await requestOllalinkSpeech(request, { signal: active.controller.signal });
            if (!isCurrent()) return;
            setMessage("Decoding audio and adding to timeline…");
            committed = await active.session.commit(new Blob([result.bytes], { type: result.mimeType }), result);
            // The successful synchronous commit itself updates caption identity/timing.
            if (operation.current !== active || active.controller.signal.aborted) return;
            if (!committed) throw new Error("Commit rejected");
            setState("success");
            setMessage("Ollalink speech added to timeline. Preview or download below.");
        } catch (error) {
            if (!isCurrent()) return;
            setState("error");
            setMessage(error instanceof OllalinkTtsError ? error.message
                : "Speech could not be added. Check track locks and current selection, then try again explicitly. No automatic retry was made.");
        } finally {
            active.session?.end(committed);
            if (operation.current === active) operation.current = null;
        }
    };

    const validPair = hasOllalinkTtsPair(catalog, voice, language);
    const languages = catalog?.voices.find(item => item.id === voice)?.languages || [];
    const invalid = !script.trim() || script.length > OLLALINK_TTS_MAX_CHARACTERS || catalogState !== "ready" || !validPair;
    return (
        <section aria-label="Ollalink speech" data-testid="ollalink-tts-panel">
            <label className="field-label">Cloud voice
                <select aria-label="Cloud voice" value={voice} onChange={event => setVoice(event.target.value)}>
                    <option value="">Choose a cloud voice</option>
                    {voice && !catalog?.voices.some(item => item.id === voice) ? <option value={voice} disabled>Previously selected voice unavailable</option> : null}
                    {catalog?.voices.map(item => <option key={item.id} value={item.id}>{item.name} ({item.id})</option>)}
                </select>
            </label>
            <label className="field-label">Speech language
                <select aria-label="Speech language" value={language} onChange={event => setLanguage(event.target.value)}>
                    <option value="">Choose a speech language</option>
                    {language && !languages.includes(language) ? <option value={language} disabled>Previously selected language incompatible</option> : null}
                    {languages.map(value => <option key={value} value={value}>{value}</option>)}
                </select>
            </label>
            <p>Opt-in cloud speech: your script is sent to the server and Ollalink. Maximum 4,000 UTF-16 code units. WAV · PCM16 · mono · 24 kHz.</p>
            <p>Natural speed only. No voice cloning or baked-in gain. Your local voice, speed, volume and clone settings are preserved but are not used here.</p>
            <p>The live catalog may differ from static documentation. Only listed voice/language pairs are offered. No speaker is chosen or switched automatically.</p>
            {catalogState === "loading" ? <p role="status">Loading cloud voice catalog…</p> : null}
            {catalogState === "error" ? <p role="alert">{new OllalinkTtsError("TTS_CATALOG_UNAVAILABLE").message}</p> : null}
            {catalogState === "ready" && voice && language && !validPair ? <p role="alert">This selected pair is no longer available. Explicitly choose a listed voice and compatible language.</p> : null}
            <button type="button" onClick={() => { setCatalog(null); setCatalogState("loading"); setCatalogVersion(value => value + 1); }}>Refresh cloud voice catalog</button>
            {script.length > OLLALINK_TTS_MAX_CHARACTERS ? <p role="alert">Shorten the script to 4,000 UTF-16 code units before generating.</p> : null}
            {message && state !== "idle" ? <p role={state === "error" ? "alert" : "status"} aria-live="polite">{message}</p> : null}
            {state === "generating" ? <><progress aria-label="Cloud speech progress" /><button type="button" onClick={cancel}>Cancel speech</button></> : null}
            <button className="generate-button" type="button" onClick={generate}
                disabled={invalid || state === "generating" || status === "generating" || status === "captioning"}>
                Generate Ollalink speech
            </button>
            {state === "error" || catalogState === "error" ? <button type="button" onClick={useLocal}>Use local TTS instead</button> : null}
        </section>
    );
}
