import { captureTranscriptionPreferences } from "../lib/transcriptionPreferences.js";
import { useEffect, useRef, useState } from "react";
import { attachTranscriptionOutcome, getTranscriptionOutcome } from "../lib/transcriptionOutcome.js";
import { cancelledWorkflowTranscription, isTranscriptionCancellation, workflowTranscriptionOutcome } from "../lib/workflowTranscription.js";
import { browserProjectFingerprint } from "../lib/browserEditPlan.js";
import {
  canRemovePauses,
  findRoughCutCandidates,
  buildRoughCutReview,
} from "../lib/roughCut.js";
import { analyzeVideoPauses } from "../lib/sileroVad.js";
import { transcribeAudioToCaptionSegments } from "../lib/asr.js";

export function useRoughCut(options) {
  const [settings, setSettings] = useState({
    threshold: 0.5,
    minimum: 0.8,
    keep: 0.3,
    removeFillerWords: false,
  });
  const [draft, setDraft] = useState(null);
  const [job, setJob] = useState({ running: false, progress: 0, phase: "" });
  const [error, setError] = useState("");
  const abortRef = useRef(null);
  const transcriptCache = useRef(new Map());
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => () => abortRef.current?.abort(), []);

  const {
    selectedSegment: segment,
    visualSegments,
    rippleEditing,
    locked,
    projectVersion,
  } = options;

  const index = visualSegments.findIndex((clip) => clip.id === segment?.id);
  const supported = segment?.type === "video" && canRemovePauses(segment, visualSegments[index - 1]);
  const stale = Boolean(draft && (draft.version !== projectVersion || draft.clip.id !== segment?.id));

  const cancel = () => {
    const controller = abortRef.current;
    controller?.abort();
    abortRef.current = null;
    setJob((current) => attachTranscriptionOutcome(
      { ...current, running: false, progress: 0, phase: "" },
      cancelledWorkflowTranscription(controller, controller?.transcriptionPreferences)
    ));
  };

  const dismiss = () => {
    draft?.onDismissed?.();
    setDraft(null);
    setError("");
  };

  const run = async (request = {}) => {
    const current = latest.current;
    if (abortRef.current) return { status: "busy" };
    if (current.locked) return { status: "locked", code: "roughCutLocked" };
    const runtime = current.getRuntime();
    const targetId = request.clipId || current.selectedSegment?.id;
    const targetIndex = runtime.visualSegments.findIndex((clip) => clip.id === targetId);
    const target = runtime.visualSegments[targetIndex];
    if (target?.type !== "video" || !canRemovePauses(target, runtime.visualSegments[targetIndex - 1])) {
      return { status: "unsupported", code: "roughCutUnsupported" };
    }
    const effectiveSettings = { ...settings, ...(request.settings || {}) };
    if (request.settings) setSettings(effectiveSettings);
    const controller = new AbortController();
    abortRef.current = controller;
    const abortFromRequest = () => controller.abort();
    if (request.signal?.aborted) controller.abort();
    else request.signal?.addEventListener?.("abort", abortFromRequest, { once: true });
    const captured = { ...target };
    const transcription = captureTranscriptionPreferences();
    controller.transcriptionPreferences = transcription;
    let outcome = null;
    const snapshot = current.getSnapshot();
    const fingerprint = browserProjectFingerprint(snapshot, false, runtime.visualSegments, runtime);

    setError("");
    setDraft(null);
    setJob({ running: true, progress: 0, phase: "roughCutPreparing" });

    try {
      // Step 1: Detect speech and pauses using Silero VAD / in-worker fallback
      setJob({ running: true, progress: 10, phase: "roughCutDetecting" });
      const probabilities = await analyzeVideoPauses(captured, {
        language: current.language,
        signal: controller.signal,
        onProgress: (progress, phase) => {
          if (!controller.signal.aborted) {
            setJob({ running: true, progress: Number.isFinite(progress) ? Math.min(85, progress) : 10, phase: phase || "roughCutDetecting" });
          }
        },
      });

      controller.signal.throwIfAborted();

      // Step 2: If filler words are requested, check cache or run transcription
      let chunks = null;
      const cacheKey = JSON.stringify([
        captured.id, captured.src, captured.assetId, captured.sourceStart, captured.duration,
        captured.playbackRate, transcription.provider, transcription.language,
      ]);
      if (effectiveSettings.removeFillerWords) {
        if (transcriptCache.current.has(cacheKey)) {
          const cached = transcriptCache.current.get(cacheKey);
          if (cached.blob === captured.blob) {
            chunks = cached.chunks;
            outcome = getTranscriptionOutcome(cached);
          } else {
            transcriptCache.current.delete(cacheKey);
          }
        }
        if (!chunks && Array.isArray(captured.rawChunks) && captured.rawChunks.length > 0) {
          // Attached transcripts are explicit reuse, not success by the selected provider.
          outcome = getTranscriptionOutcome(captured.rawChunks) || getTranscriptionOutcome(captured);
          chunks = attachTranscriptionOutcome(captured.rawChunks, outcome);
          transcriptCache.current.set(cacheKey, attachTranscriptionOutcome({ chunks, blob: captured.blob }, outcome));
        }
        if (!chunks) {
          // Transcribe with the provider/language captured when analysis began.
          try {
            controller.transcriptionStarted = true;
            setJob({ running: true, progress: 85, phase: "roughCutTranscribing" });
            const mediaBlob = captured.blob || (captured.src ? await fetch(captured.src, { signal: controller.signal }).then((r) => r.blob()) : null);
            if (mediaBlob) {
              const { sliceAudioBlob } = await import("../lib/media.js");
              const sourceStart = Number(captured.sourceStart) || 0;
              const clipDuration = Number(captured.duration) || Infinity;
              const clipBlob = (sourceStart > 0 || Number.isFinite(clipDuration))
                ? await sliceAudioBlob(mediaBlob, sourceStart, clipDuration)
                : mediaBlob;

              const asrResult = await transcribeAudioToCaptionSegments(clipBlob, {
                preferredLanguage: current.language,
                ...transcription,
                signal: controller.signal,
              });
              controller.signal.throwIfAborted();
              outcome = getTranscriptionOutcome(asrResult);
              if (asrResult?.rawChunks?.length) {
                chunks = attachTranscriptionOutcome(asrResult.rawChunks, outcome);
                transcriptCache.current.set(cacheKey, attachTranscriptionOutcome({ chunks, blob: captured.blob }, outcome));
              }
            } else {
              outcome = workflowTranscriptionOutcome(null, transcription);
            }
          } catch (asrErr) {
            outcome = workflowTranscriptionOutcome(asrErr, transcription,
              isTranscriptionCancellation(asrErr, controller.signal) ? "cancelled" : "failed");
            controller.transcriptionOutcome = outcome;
            if (isTranscriptionCancellation(asrErr, controller.signal)) throw asrErr;
            // Graceful fallback to silence-only cuts if transcription fails or is unavailable
            console.warn("[RoughCut] Transcription unavailable for filler detection, continuing with pause analysis:", asrErr);
          }
        }
      }

      controller.transcriptionOutcome = outcome;
      controller.signal.throwIfAborted();

      // Step 3: Compute rough cut candidates
      const candidates = findRoughCutCandidates({
        probabilities,
        chunks,
        clip: captured,
        settings: effectiveSettings,
      });

      setDraft(attachTranscriptionOutcome({
        clip: captured,
        fingerprint,
        probabilities,
        chunks,
        version: current.projectVersion,
        start: runtime.visualSegments.slice(0, targetIndex).reduce((sum, clip) => sum + clip.duration, 0),
        candidates,
        onApplied: request.onApplied,
        onDismissed: request.onDismissed,
      }, outcome));
      return { status: "review-ready", clipId: captured.id, candidateCount: candidates.length, transcriptionOutcome: outcome };
    } catch (failure) {
      outcome = getTranscriptionOutcome(failure) || outcome;
      if (isTranscriptionCancellation(failure, controller.signal)) {
        return { status: "cancelled", transcriptionOutcome: outcome };
      }
      const code = failure.code || "roughCutFailed";
      setError(code);
      return { status: "failed", code, transcriptionOutcome: outcome };
    } finally {
      request.signal?.removeEventListener?.("abort", abortFromRequest);
      if (abortRef.current === controller) {
        abortRef.current = null;
        setJob(attachTranscriptionOutcome({ running: false, progress: 0, phase: "" }, outcome));
      }
    }
  };

  const updateSettings = (patch) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    setError("");
    if (draft && !stale) {
      setDraft({
        ...draft,
        candidates: findRoughCutCandidates({
          probabilities: draft.probabilities,
          chunks: draft.chunks,
          clip: draft.clip,
          settings: next,
        }),
      });
    }
  };

  const toggle = (id) => {
    setError("");
    setDraft((current) =>
      current
        ? {
          ...current,
          candidates: current.candidates.map((cut) =>
            cut.id === id ? { ...cut, enabled: !cut.enabled } : cut
          ),
        }
        : null
    );
  };

  const toggleAll = (enabled) => {
    setError("");
    setDraft((current) =>
      current
        ? {
          ...current,
          candidates: current.candidates.map((cut) => ({ ...cut, enabled })),
        }
        : null
    );
  };

  const apply = () => {
    if (!draft || job.running) return;
    const current = latest.current;
    const now = current.getSnapshot();
    const live = current.getRuntime();

    if (
      current.selectedSegment?.id !== draft.clip.id ||
      browserProjectFingerprint(now, false, live.visualSegments, live) !== draft.fingerprint
    ) {
      setError("roughCutStale");
      return;
    }

    try {
      const selectedCuts = draft.candidates.filter((cut) => cut.enabled);
      const review = buildRoughCutReview(
        now,
        live,
        draft.clip.id,
        selectedCuts,
        current.rippleEditing
      );
      current.applyReview(review, current.t("roughCutApplied"));
      draft.onApplied?.({ clipId: draft.clip.id, candidateCount: selectedCuts.length });
      setDraft(null);
      setError("");
    } catch (failure) {
      setError(failure.code?.startsWith("roughCut") || failure.code?.startsWith("pause") ? failure.code : "roughCutStale");
    }
  };

  return {
    segment,
    supported,
    locked,
    settings,
    updateSettings,
    draft,
    stale,
    job,
    error,
    run,
    cancel,
    dismiss,
    toggle,
    toggleAll,
    apply,
    rippleEditing,
    setRippleEditing: options.setRippleEditing,
    preview: (cut) => {
      if (!stale) {
        options.seekTo(draft.start + Math.max(0, cut.start - 0.25));
      }
    },
  };
}
