import { OllalinkTtsError, awaitTtsAbortable, cancelTtsBody, createTtsDeadline, readBoundedTtsAudio } from "./ollalinkTts.js";

export const OLLALINK_TTS_CATALOG_MAX_BYTES = 256 * 1024;
export const OLLALINK_TTS_CATALOG_TIMEOUT_MS = 20000;
export const isTtsVoiceId = value => typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
export const isTtsLanguage = value => typeof value === "string" && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(value);

// Fail closed, never infer aliases, language cross-products, defaults, or design voices.
export function sanitizeOllalinkTtsCatalog(value, { upstream = false } = {}) {
    const fail = () => { throw new OllalinkTtsError("TTS_CATALOG_UNAVAILABLE"); };
    if (!value || !Array.isArray(value.voices) || !value.voices.length || value.voices.length > 128) fail();
    const ids = new Set();
    const voices = value.voices.map(voice => {
        if (!voice || !isTtsVoiceId(voice.id) || ids.has(voice.id) ||
            typeof voice.name !== "string" || !voice.name.trim() || voice.name.length > 80 ||
            !/^[\p{L}\p{N} .,'’()_-]+$/u.test(voice.name) ||
            !Array.isArray(voice.languages) || !voice.languages.length || voice.languages.length > 32 ||
            voice.languages.some(language => !isTtsLanguage(language)) ||
            new Set(voice.languages).size !== voice.languages.length ||
            (upstream && (voice.engine !== "fixed" || voice.instructions !== false))) fail();
        ids.add(voice.id);
        return Object.freeze({ id: voice.id, name: voice.name, languages: Object.freeze([...voice.languages]) });
    });
    return Object.freeze({ voices: Object.freeze(voices) });
}

export function hasOllalinkTtsPair(catalog, voice, language) {
    return !!catalog?.voices.some(item => item.id === voice && item.languages.includes(language));
}

export async function readOllalinkTtsCatalog(response, { signal, upstream = false } = {}) {
    try {
        if (!response.ok || (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase() !== "application/json") throw new Error();
        const bytes = await readBoundedTtsAudio(response, { signal, maxBytes: OLLALINK_TTS_CATALOG_MAX_BYTES });
        return sanitizeOllalinkTtsCatalog(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), { upstream });
    } catch {
        cancelTtsBody(response);
        signal?.throwIfAborted();
        throw new OllalinkTtsError("TTS_CATALOG_UNAVAILABLE");
    }
}

export async function requestOllalinkTtsCatalog({ signal, fetchImpl = globalThis.fetch } = {}) {
    const deadline = createTtsDeadline(OLLALINK_TTS_CATALOG_TIMEOUT_MS, signal);
    let response;
    try {
        deadline.signal.throwIfAborted();
        const pending = Promise.resolve(fetchImpl("/api/tts/voices", {
            method: "GET", credentials: "include", redirect: "error", cache: "no-store",
            headers: { "X-TTS-Request": "1" }, signal: deadline.signal,
        }));
        pending.then(late => { if (deadline.signal.aborted) cancelTtsBody(late); }, () => { });
        response = await awaitTtsAbortable(pending, deadline.signal);
        return await readOllalinkTtsCatalog(response, { signal: deadline.signal });
    } catch {
        cancelTtsBody(response);
        throw new OllalinkTtsError(signal?.aborted ? "TTS_CANCELLED" : "TTS_CATALOG_UNAVAILABLE");
    } finally { deadline.dispose(); }
}
