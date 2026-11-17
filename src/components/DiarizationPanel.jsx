import { useEffect, useRef, useState } from "react";
import {
    DiarizationError, applyDiarizationReview, diarizationCaptionKey, diarizationSourceKey,
    proposeDiarization, requestDiarization, validateDiarizationSource,
} from "../lib/ollalinkDiarization.js";
import { createDiarizationOperation, runDiarizationOperation } from "../lib/diarizationAudio.js";

export function DiarizationPanel({ source, captions, locked, setCaptions, prepareAudio, request = requestDiarization }) {
    const [provider, setProvider] = useState("local");
    const [busy, setBusy] = useState(false);
    const [review, setReview] = useState(null);
    const [status, setStatus] = useState("");
    const operation = useRef(null);
    const active = useRef(null);
    const latest = useRef(null);
    const captionKey = diarizationCaptionKey(captions);
    const sourceKey = diarizationSourceKey(source);
    // Event handlers and deferred state updates consult the latest committed props.
    useEffect(() => { latest.current = { captionKey, sourceKey, source, locked, provider }; });
    useEffect(() => {
        active.current?.controller.abort();
        setReview(current => current ? { ...current, invalidated: true } : current);
    }, [captionKey, sourceKey, source?.blob, locked, provider]);
    useEffect(() => () => { active.current?.controller.abort(); active.current = null; }, []);
    let supported = true;
    try { validateDiarizationSource(source); } catch { supported = false; }
    const stale = review && (review.invalidated || review.captionKey !== captionKey || review.sourceKey !== sourceKey || review.blob !== source?.blob);
    const canRun = provider === "ollalink" && supported && !locked && !busy && !review && captions.some(cue =>
        cue.audioSegmentId === source.segmentId && !cue.speaker && !cue.speakerId);
    const run = async () => {
        if (!canRun || active.current) return;
        operation.current ??= createDiarizationOperation();
        const token = operation.current.begin();
        if (!token) return;
        active.current = token;
        const snapshot = structuredClone(captions);
        const capturedSource = source;
        const capturedKey = sourceKey;
        const capturedCaptionKey = captionKey;
        setBusy(true);
        setStatus("Preparing selected clip, then uploading to Ollalink cloud…");
        try {
            const result = await runDiarizationOperation(token, source, { prepare: prepareAudio, request });
            const current = latest.current;
            if (active.current !== token || token.controller.signal.aborted) return;
            if (current.locked || current.provider !== "ollalink" || current.captionKey !== capturedCaptionKey ||
                current.sourceKey !== capturedKey || current.source?.blob !== capturedSource.blob) throw new DiarizationError("STALE");
            const proposals = proposeDiarization(snapshot, capturedSource, result);
            setReview({
                snapshot, proposals, result, captionKey: capturedCaptionKey, sourceKey: capturedKey,
                blob: capturedSource.blob, requestId: crypto.randomUUID()
            });
            setStatus("Review ready. Nothing has changed.");
        } catch (error) {
            if (active.current === token) setStatus(new DiarizationError(token.controller.signal.aborted ? "CANCELLED" : error.code).message);
        } finally {
            if (active.current === token) { active.current = null; setBusy(false); }
        }
    };
    const apply = () => {
        if (!review || stale || locked || provider !== "ollalink" || !review.proposals.length) return;
        const captured = review;
        setCaptions(current => {
            const state = latest.current;
            if (state.locked || state.provider !== "ollalink" || state.sourceKey !== captured.sourceKey ||
                state.source?.blob !== captured.blob || diarizationCaptionKey(current) !== captured.captionKey) return current;
            return applyDiarizationReview(current, captured.snapshot, captured.proposals, captured.requestId);
        });
        setReview(null);
        setStatus("Reviewed speaker metadata applied. Text, timing and existing assignments preserved.");
    };
    return <section className="subtitle-text-tools" aria-label="Speaker diarization">
        <h3>Speaker labels</h3>
        <label>Speaker detection provider<select aria-label="Speaker detection provider" value={provider}
            onChange={event => { active.current?.controller.abort(); setProvider(event.target.value); setReview(null); }}>
            <option value="local">Local tools (default)</option><option value="ollalink">Ollalink cloud — opt in</option>
        </select></label>
        {provider === "local" ? <p>Existing local caption and Shorts tools are unchanged. Local Shorts tracks visible speakers, not acoustic speaker turns. No cloud request is made.</p> : <>
            <p>Uploads the selected audio-lane clip only (up to 120 seconds, source file up to 32 MB). Anonymous labels are not identities. Language accuracy is not documented; brief speakers can be missed.</p>
            <p>Only captions explicitly linked to this audio clip can be proposed. Cross-turn, overlapping, unlinked and already labeled captions are skipped. No automatic face matching or cue splitting.</p>
            {!supported ? <p role="note">Select a forward, normal-speed audio-lane clip. Source audio, embedded video, music, reverse and speed curves are not supported here.</p> : <p>Selected: {source.name || source.segmentId} · {source.start}–{source.start + source.duration} s on timeline</p>}
            {locked ? <p role="note">Unlock captions to request or apply labels.</p> : null}
            <button type="button" disabled={!canRun} onClick={run}>Detect speakers with Ollalink</button>
            {busy ? <button type="button" onClick={() => { active.current?.controller.abort(); setStatus("Cancellation requested. Captions are unchanged."); }}>Cancel speaker detection</button> : null}
        </>}
        <div role="status" aria-live="polite">{status}</div>
        {review ? <section aria-label="Review speaker labels">
            <h4>Review anonymous speaker turns</h4>
            <p>{review.result.speakers.length} anonymous speakers; {review.proposals.length} eligible captions. Labels are unique to this request, not reusable identities. All other captions remain unchanged.</p>
            {stale ? <p role="alert">Source or captions changed. Discard this review.</p> : null}
            <details><summary>Provider turns (clip-relative seconds)</summary><ul>{review.result.segments.map((turn, index) =>
                <li key={index}>{turn.start}–{turn.end} s: {turn.speaker}</li>)}</ul></details>
            <ul>{review.proposals.map(proposal => <li key={proposal.id}>
                {review.snapshot.find(cue => cue.id === proposal.id)?.text} → {proposal.speaker}
            </li>)}</ul>
            <button type="button" disabled={Boolean(stale) || locked || !review.proposals.length} onClick={apply}>Apply reviewed speaker labels</button>
            <button type="button" onClick={() => { setReview(null); setStatus("Review discarded. Captions are unchanged."); }}>Discard speaker review</button>
        </section> : null}
    </section>;
}
