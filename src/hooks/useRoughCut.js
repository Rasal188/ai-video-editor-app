import { useEffect, useRef, useState } from "react";
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
    abortRef.current?.abort();
    abortRef.current = null;
    setJob({ running: false, progress: 0, phase: "" });
  };

  const dismiss = () => {
    setDraft(null);
    setError("");
  };

  const run = async () => {
    if (abortRef.current || !supported || locked) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const captured = { ...segment };
    const snapshot = options.getSnapshot();
    const runtime = options.getRuntime();
    const fingerprint = browserProjectFingerprint(snapshot, false, runtime.visualSegments, runtime);

    setError("");
    setDraft(null);
    setJob({ running: true, progress: 0, phase: "roughCutPreparing" });

    try {
      // Step 1: Detect speech and pauses using Silero VAD / in-worker fallback
      setJob({ running: true, progress: 10, phase: "roughCutDetecting" });
      const probabilities = await analyzeVideoPauses(captured, {
        language: options.language,
        signal: controller.signal,
        onProgress: (progress, phase) => {
          if (!controller.signal.aborted) {
            setJob({ running: true, progress: Math.min(85, progress), phase: phase || "roughCutDetecting" });
          }
        },
      });

      controller.signal.throwIfAborted();

      // Step 2: If filler words are requested, check cache or run transcription
      let chunks = null;
      const cacheKey = captured.id || captured.src || captured.assetId;
      if (settings.removeFillerWords) {
        if (transcriptCache.current.has(cacheKey)) {
          chunks = transcriptCache.current.get(cacheKey);
        } else if (Array.isArray(captured.rawChunks) && captured.rawChunks.length > 0) {
          chunks = captured.rawChunks;
          transcriptCache.current.set(cacheKey, chunks);
        } else {
          // Attempt local transcription on the clip's audio
          try {
            setJob({ running: true, progress: 85, phase: "roughCutTranscribing" });
            const mediaBlob = captured.blob || (captured.src ? await fetch(captured.src, { signal: controller.signal }).then((r) => r.blob()) : null);
            if (mediaBlob) {
              const asrResult = await transcribeAudioToCaptionSegments(mediaBlob, {
                preferredLanguage: options.language,
                signal: controller.signal,
              });
              if (asrResult?.rawChunks?.length) {
                chunks = asrResult.rawChunks;
                transcriptCache.current.set(cacheKey, chunks);
              }
            }
          } catch (asrErr) {
            // Graceful fallback to silence-only cuts if transcription fails or is unavailable
            console.warn("[RoughCut] Transcription unavailable for filler detection, continuing with pause analysis:", asrErr);
          }
        }
      }

      controller.signal.throwIfAborted();

      // Step 3: Compute rough cut candidates
      const candidates = findRoughCutCandidates({
        probabilities,
        chunks,
        clip: captured,
        settings,
      });

      setDraft({
        clip: captured,
        fingerprint,
        probabilities,
        chunks,
        version: projectVersion,
        start: runtime.visualSegments.slice(0, index).reduce((sum, clip) => sum + clip.duration, 0),
        candidates,
      });
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure.code || "roughCutFailed");
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setJob({ running: false, progress: 0, phase: "" });
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
