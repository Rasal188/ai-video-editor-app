import { useEffect, useRef, useState } from "react";
import { browserProjectFingerprint } from "../lib/browserEditPlan.js";
import { buildSilenceRemovalReview, canRemovePauses, findPauseCandidates } from "../lib/silenceRemoval.js";
import { analyzeVideoPauses } from "../lib/sileroVad.js";

export function useSilenceRemoval(options) {
  const [settings, setSettings] = useState({ threshold: 0.5, minimum: 0.8, keep: 0.5 });
  const [draft, setDraft] = useState(null);
  const [job, setJob] = useState({ running: false, progress: 0, phase: "" });
  const [error, setError] = useState("");
  const abortRef = useRef(null);
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => () => abortRef.current?.abort(), []);
  const { selectedSegment: segment, visualSegments, rippleEditing, locked, projectVersion } = options;
  const index = visualSegments.findIndex((clip) => clip.id === segment?.id);
  const supported = segment?.type === "video" && canRemovePauses(segment, visualSegments[index - 1]);
  const stale = Boolean(draft && (draft.version !== projectVersion || draft.clip.id !== segment?.id));

  const cancel = () => {
    abortRef.current?.abort(); abortRef.current = null;
    setJob({ running: false, progress: 0, phase: "" });
  };
  const dismiss = () => {
    draft?.onDismissed?.();
    setDraft(null);
    setError("");
  };
  const run = async (request = {}) => {
    const current = latest.current;
    if (abortRef.current) return { status: "busy" };
    if (current.locked) return { status: "locked", code: "pauseLocked" };
    const runtime = current.getRuntime();
    const targetId = request.clipId || current.selectedSegment?.id;
    const targetIndex = runtime.visualSegments.findIndex((clip) => clip.id === targetId);
    const target = runtime.visualSegments[targetIndex];
    if (target?.type !== "video" || !canRemovePauses(target, runtime.visualSegments[targetIndex - 1])) {
      return { status: "unsupported", code: "pauseUnsupported" };
    }
    const effectiveSettings = { ...settings, ...(request.settings || {}) };
    if (request.settings) setSettings(effectiveSettings);
    const controller = new AbortController(); abortRef.current = controller;
    const abortFromRequest = () => controller.abort();
    if (request.signal?.aborted) controller.abort();
    else request.signal?.addEventListener?.("abort", abortFromRequest, { once: true });
    const captured = { ...target };
    const snapshot = current.getSnapshot();
    const fingerprint = browserProjectFingerprint(snapshot, false, runtime.visualSegments, runtime);
    setError(""); setDraft(null); setJob({ running: true, progress: 0, phase: "pauseDownloading" });
    try {
      const probabilities = await analyzeVideoPauses(captured, {
        language: current.language, signal: controller.signal,
        onProgress: (progress, phase) => {
          if (!controller.signal.aborted) setJob({ running: true, progress, phase });
        },
      });
      controller.signal.throwIfAborted();
      const candidates = findPauseCandidates(probabilities, captured, effectiveSettings);
      setDraft({
        clip: captured, fingerprint, probabilities, version: current.projectVersion,
        start: runtime.visualSegments.slice(0, targetIndex).reduce((sum, clip) => sum + clip.duration, 0),
        candidates, onApplied: request.onApplied, onDismissed: request.onDismissed
      });
      return { status: "review-ready", clipId: captured.id, candidateCount: candidates.length };
    } catch (failure) {
      if (controller.signal.aborted) return { status: "cancelled" };
      const code = failure.code || "pauseFailed";
      setError(code);
      return { status: "failed", code };
    } finally {
      request.signal?.removeEventListener?.("abort", abortFromRequest);
      if (abortRef.current === controller) {
        abortRef.current = null; setJob({ running: false, progress: 0, phase: "" });
      }
    }
  };
  const updateSettings = (patch) => {
    const next = { ...settings, ...patch };
    setSettings(next); setError("");
    if (draft && !stale) setDraft({ ...draft, candidates: findPauseCandidates(draft.probabilities, draft.clip, next) });
  };
  const toggle = (id) => {
    setError("");
    setDraft((current) => (current ? { ...current, candidates: current.candidates.map((cut) => cut.id === id ? { ...cut, enabled: !cut.enabled } : cut) } : null));
  };
  const toggleAll = (enabled) => {
    setError("");
    setDraft((current) => (current ? { ...current, candidates: current.candidates.map((cut) => ({ ...cut, enabled })) } : null));
  };
  const apply = () => {
    if (!draft || job.running) return;
    const current = latest.current;
    const now = current.getSnapshot(); const live = current.getRuntime();
    if (current.selectedSegment?.id !== draft.clip.id
      || browserProjectFingerprint(now, false, live.visualSegments, live) !== draft.fingerprint) {
      setError("pauseStale"); return;
    }
    try {
      const selectedCuts = draft.candidates.filter((cut) => cut.enabled);
      const review = buildSilenceRemovalReview(now, live, draft.clip.id, selectedCuts, current.rippleEditing);
      current.applyReview(review, current.t("pauseApplied"));
      draft.onApplied?.({ clipId: draft.clip.id, candidateCount: selectedCuts.length });
      setDraft(null); setError("");
    } catch (failure) { setError(failure.code?.startsWith("pause") ? failure.code : "pauseStale"); }
  };
  return {
    segment, supported, locked, settings, updateSettings, draft, stale, job, error, run, cancel, dismiss, toggle, toggleAll, apply,
    rippleEditing, setRippleEditing: options.setRippleEditing,
    preview: (cut) => { if (!stale) options.seekTo(draft.start + Math.max(0, cut.start - 0.25)); },
  };
}
