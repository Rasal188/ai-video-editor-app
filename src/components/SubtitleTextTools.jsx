import { useEffect, useMemo, useRef, useState } from "react";
import { getCaptionScript } from "../lib/timeline.js";
import {
    TRANSLATION_LANGUAGES, NORMALIZATION_LANGUAGES,
    applySubtitleTextReview, subtitleSnapshotKey,
} from "../lib/subtitleTextTools.js";
import { createSubtitleTextBatchJob } from "../lib/subtitleTextBatches.js";
import { getAlignmentCapability } from "../lib/wordAlignment.js";

const REVIEW_PAGE_SIZE = 20;
import "./SubtitleTextTools.css";

export function SubtitleTextTools({ captions, selectedCaptionId, locked, setCaptions, updateScript, getProjectIdentity }) {
    const [source, setSource] = useState("");
    const [target, setTarget] = useState("es");
    const [language, setLanguage] = useState("en");
    const [scope, setScope] = useState("selected");
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState("");
    const [review, setReview] = useState(null);
    const [progress, setProgress] = useState(null);
    const [failed, setFailed] = useState(false);
    const [reviewPage, setReviewPage] = useState(0);
    const active = useRef(null);
    const pending = useRef(null);
    const latest = useRef({ captions, locked });
    const key = useMemo(() => subtitleSnapshotKey(captions), [captions]);
    const alignmentCapability = useMemo(() => getAlignmentCapability(), []);
    const reviewOriginals = useMemo(() => new Map(review?.snapshot.map((cue, index) => [cue.id, { cue, index }]) || []), [review?.snapshot]);
    const projectIdentity = getProjectIdentity?.();
    const contextKey = JSON.stringify([scope === "selected" ? selectedCaptionId : null, projectIdentity]);
    const context = useRef(contextKey);
    useEffect(() => { context.current = contextKey; }, [contextKey]);
    useEffect(() => { latest.current = { captions, locked }; }, [captions, locked]);
    useEffect(() => () => { active.current?.abort(); active.current = null; pending.current = null; }, []);
    useEffect(() => {
        if (active.current || pending.current) {
            active.current?.abort();
            active.current = null;
            pending.current = null;
            setBusy(false);
            setFailed(false);
            setProgress(null);
            setStatus("Captions, selection, project or lock changed. Processing cancelled; original captions are unchanged.");
        }
    }, [key, locked, contextKey]);

    const selected = captions.find(cue => cue.id === selectedCaptionId);
    const stale = review && (key !== review.snapshotKey || contextKey !== review.contextKey);
    const candidates = (scope === "selected" ? (selected ? [selected] : []) : captions).filter(cue => typeof cue.text === "string" && cue.text.trim());
    const canStart = !busy && !review && !failed && !locked && candidates.length > 0;
    const reviewValid = review?.results.every(result => result.text.trim() && Array.from(result.text).length <= 20000);

    const cancel = () => {
        active.current?.abort();
        active.current = null;
        pending.current = null;
        setBusy(false);
        setFailed(false);
        setProgress(null);
        setStatus("Subtitle processing cancelled. Original captions are unchanged.");
    };
    const sessionCurrent = session => !latest.current.locked && context.current === session.contextKey && getProjectIdentity?.() === session.projectIdentity && subtitleSnapshotKey(latest.current.captions) === session.snapshotKey;
    const execute = async session => {
        if (active.current || !sessionCurrent(session)) { if (!active.current) cancel(); return; }
        const controller = new AbortController();
        active.current = controller;
        setBusy(true);
        setFailed(false);
        try {
            const results = await session.job.run({
                signal: controller.signal, onProgress: value => {
                    if (active.current !== controller || controller.signal.aborted) return;
                    setProgress(value);
                    const counts = `${value.processed} of ${value.total} captions`;
                    const slots = `${value.activeBatches ?? 0} of ${value.concurrency ?? 1} request slots in use`;
                    // A free-slot wait is not a provider cooldown and must not be
                    // described as one.
                    setStatus(value.phase === "preparing" ? `Preparing captions… ${counts}.`
                        : value.phase === "retrying" ? `Retrying the failed batch… ${counts}.`
                            : value.phase === "waiting" && value.waitReason === "capacity" ? `Waiting for an available request slot (${slots})… ${counts}.`
                                : value.phase === "waiting" ? `Waiting for provider cooldown… ${counts}.`
                                    : value.phase === "finalizing" ? `Finalizing results… ${counts}.`
                                        : `Processing batch ${value.batch} of ${value.batches}… ${counts}.`);
                }
            });
            if (active.current !== controller || controller.signal.aborted) return;
            if (!sessionCurrent(session)) { pending.current = null; setStatus("Captions changed. Run the action again; nothing was applied."); return; }
            pending.current = null;
            setReviewPage(0);
            setReview({ ...session, job: undefined, results });
            setStatus(`Ready for review. ${results.length} of ${results.length} captions processed. Original captions are unchanged until you apply.`);
        } catch (error) {
            if (active.current === controller && !controller.signal.aborted) {
                if (!sessionCurrent(session)) { pending.current = null; setStatus("Captions changed. Run the action again; nothing was applied."); return; }
                const value = session.job.progress;
                setFailed(true);
                setStatus(`Batch ${value.batch} of ${value.batches} failed. ${value.processed} of ${value.total} captions processed; successful batches are retained temporarily. ${error.message} Retry the failed batch or cancel. Original captions are unchanged.`);
            }
        } finally {
            if (active.current === controller) { active.current = null; setBusy(false); }
        }
    };
    const run = operation => {
        if (!canStart || active.current || pending.current) return;
        const request = {
            operation, cues: candidates.map(({ id, text }) => ({ id, text })),
            ...(operation === "translate" ? { target, ...(source ? { source } : {}) } : { language }),
        };
        let job;
        try { job = createSubtitleTextBatchJob(request); }
        catch { setStatus("Choose supported languages and nonempty captions with unique IDs, at most 5,000 characters per cue. Nothing was processed."); return; }
        // `target` is carried so an applied translation records the language the
        // derived phrase timing was produced for. It is metadata only.
        const session = {
            job, operation, snapshot: structuredClone(captions), snapshotKey: key, contextKey, projectIdentity,
            ...(operation === "translate" ? { target } : {}),
        };
        pending.current = session;
        void execute(session);
    };
    const apply = () => {
        if (!review || stale || locked || !reviewValid || getProjectIdentity?.() !== review.projectIdentity) return;
        // Guard again inside React's functional update against deferred updates/races.
        const snapshot = review.snapshot;
        const results = review.results;
        setCaptions(current => {
            if (latest.current.locked || context.current !== review.contextKey || getProjectIdentity?.() !== review.projectIdentity || subtitleSnapshotKey(current) !== subtitleSnapshotKey(snapshot)) return current;
            const next = applySubtitleTextReview(current, snapshot, results, null, {
                target: review.operation === "translate" ? review.target : null,
            });
            updateScript(getCaptionScript(next));
            return next;
        });
        setReview(null);
        setStatus("Reviewed subtitle text applied. Cue timing and order were preserved.");
    };
    const languageSelect = (label, value, setter, languages, auto = false) => (
        <label>{label}<select aria-label={label} value={value} disabled={busy || failed || Boolean(review)} onChange={event => setter(event.target.value)}>
            {auto ? <option value="">Auto-detect</option> : null}
            {Object.entries(languages).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
        </select></label>
    );
    return <section className="subtitle-text-tools" aria-label="Ollalink subtitle text tools">
        <h3>Translate and normalize subtitles</h3>
        <p>Ollalink cloud processes the selected text. Nothing changes until you review and apply.</p>
        <label>Caption scope<select aria-label="Caption scope" value={scope} disabled={busy || failed || Boolean(review)} onChange={event => setScope(event.target.value)}>
            <option value="selected">Selected caption</option><option value="all">All captions</option>
        </select></label>
        {locked ? <p role="note">Unlock the caption track to process or apply text.</p> : null}
        <div className="subtitle-text-language-row">
            {languageSelect("Source language", source, setSource, TRANSLATION_LANGUAGES, true)}
            {languageSelect("Translation language", target, setTarget, TRANSLATION_LANGUAGES)}
        </div>
        <button type="button" className="secondary-button" disabled={!canStart} onClick={() => run("translate")}>Translate subtitles</button>
        {languageSelect("Normalization language", language, setLanguage, NORMALIZATION_LANGUAGES)}
        <button type="button" className="secondary-button" disabled={!canStart} onClick={() => run("normalize")}>Normalize spoken numbers</button>
        <p>Number normalization only (English/Hindi), not rewriting or grammar correction. All nonempty captions are processed in automatic batches; maximum 5,000 characters per cue. Blank captions are left unchanged.</p>
        <div role="status" aria-live="polite">{status}</div>
        {busy || failed ? <>
            <progress aria-label="Ollalink subtitle processing" value={progress?.processed ?? 0} max={progress?.total || candidates.length || 1} />
            {progress?.concurrency > 1 ? <p role="note">Adaptive concurrency: {progress.activeBatches ?? 0} of {progress.concurrency} request slots in use.</p> : null}
            {failed ? <button type="button" disabled={locked} onClick={() => { if (pending.current) void execute(pending.current); }}>Retry failed batch</button> : null}
            <button type="button" onClick={cancel}>Cancel subtitle processing</button>
        </> : null}
        {review ? <section aria-label="Review subtitle text">
            <h4>Review {review.operation === "translate" ? "translation" : "normalization"}</h4>
            <p>Cue timestamps and order stay unchanged. {alignmentCapability.available
                ? "Changed cues use the configured target-language aligner; only words it genuinely aligns keep an Active Word highlight."
                : "The translation provider returns no word timings for the new text, so changed cues fall back to phrase-level rendering and their Active Word highlight is removed rather than guessed from source-language timing."} Unchanged cues keep their original word timing and karaoke.</p>
            {alignmentCapability.available ? null : <p role="note">{alignmentCapability.description}</p>}
            {review.operation === "normalize" ? <p role="alert">Check ambiguous numbers before applying: dates, identifiers, phone digit sequences, currency and decimals can have multiple interpretations. Number-only validation does not prove meaning or numeric accuracy. Edit or discard any uncertain conversion.</p> : null}
            {stale ? <p role="alert">Captions, selection or project changed since this review. Discard and run the action again.</p> : null}
            <p>{review.results.length} captions ready for review. Showing {reviewPage * REVIEW_PAGE_SIZE + 1}–{Math.min((reviewPage + 1) * REVIEW_PAGE_SIZE, review.results.length)}.</p>
            {review.results.length > REVIEW_PAGE_SIZE ? <nav aria-label="Caption review pages">
                <button type="button" disabled={reviewPage === 0} onClick={() => setReviewPage(page => page - 1)}>Previous review page</button>
                <button type="button" disabled={(reviewPage + 1) * REVIEW_PAGE_SIZE >= review.results.length} onClick={() => setReviewPage(page => page + 1)}>Next review page</button>
            </nav> : null}
            {review.results.slice(reviewPage * REVIEW_PAGE_SIZE, (reviewPage + 1) * REVIEW_PAGE_SIZE).map((result, pageIndex) => {
                const index = reviewPage * REVIEW_PAGE_SIZE + pageIndex;
                const { cue: original, index: originalIndex } = reviewOriginals.get(result.id);
                return <div className="subtitle-text-review-cue" key={result.id}>
                    <strong>Caption {originalIndex + 1} · {original.start}–{original.end} s</strong>
                    <label>Original text<textarea aria-label={`Original text ${index + 1}`} readOnly value={original.text} /></label>
                    {result.numbersVerified === false ? <p role="alert">Provider could not verify all numbers/placeholders. Check them carefully before applying.</p> : null}
                    {result.reviewReasons?.length ? <p role="alert">Original text retained for review: this caption contains an ambiguous or unverified number expression. Check dates, phone sequences, identifiers and numeric meaning; edit explicitly or leave unchanged.</p> : null}
                    <label>Proposed text {index + 1}<textarea aria-label={`Proposed text ${index + 1}`} value={result.text} maxLength={20000} onChange={event => {
                        const text = event.target.value;
                        setReview(current => ({ ...current, results: current.results.map((item, i) => i === index ? { ...item, text } : item) }));
                    }} /></label>
                </div>;
            })}
            <button type="button" disabled={Boolean(stale) || locked || !reviewValid} onClick={apply}>Apply reviewed text</button>
            <button type="button" onClick={() => { setReview(null); setStatus("Review discarded. Original captions are unchanged."); }}>Discard review</button>
        </section> : null}
    </section>;
}
