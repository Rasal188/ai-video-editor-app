/**
 * @file useShortsStudio.js
 * React hook managing the AI Shorts Studio lifecycle:
 * source selection, configuration, analysis orchestration,
 * candidate review, boundary adjustment, and export/timeline integration.
 */

import { useState, useRef, useEffect, useMemo } from "react";
import {
  DEFAULT_SHORTS_SETTINGS,
  normalizeShortsSettings,
  inspectSourceMetadata,
  discoverShortCandidates,
  convertCandidateToProject,
  buildShortExportSpec,
  resolveSourceCaptions,
  extractTranscriptExcerpt,
  buildDynamicReframingTrack,
  applyDynamicReframingToCandidate,
} from "../lib/shortsStudio.js";
import {
  exportShortCandidateVideo,
  exportShortCandidatesBatch,
  exportShortCandidateTimelinePackage,
} from "../lib/shortsExport.js";
import { transcribeAudioToCaptionSegments } from "../lib/asr.js";
import { extractAudioFromVideo } from "../lib/media.js";
import {
  extractGenuineFaceDetections,
  isGenuineFaceDetection,
  isCandidateFallbackDueToMissingDetections,
  hasAdequateCandidateDetections,
  needsTargetedSubjectAnalysis,
} from "../lib/shortsReframing.js";
import { sampleVideoFaceDetections } from "../lib/shortsFaceDetection.js";

export function useShortsStudio({
  visualSegments = [],
  userAssets = [],
  selectedSegment = null,
  captionSegments = [],
  currentTime = 0,
  setCurrentTime,
  setIsPlaying,
  pauseTimelineMedia,
  onApplyProject,
  onExportShort,
  notify,
  t = (k, f) => f || k,
} = {}) {
  const [isOpen, setIsOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [stage, setStage] = useState("configure"); // "configure" | "analyzing" | "review" | "exporting"
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [settings, setSettings] = useState({ ...DEFAULT_SHORTS_SETTINGS });
  const [job, setJob] = useState({ running: false, progress: 0, phase: "" });
  const [exportJob, setExportJob] = useState({
    running: false,
    progress: 0,
    current: 0,
    total: 0,
    title: "",
    phase: "",
    error: null,
  });
  const [error, setError] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [activeCandidateId, setActiveCandidateId] = useState("");
  const [selectedCandidateIds, setSelectedCandidateIds] = useState(new Set());
  const [auditioningCandidateId, setAuditioningCandidateId] = useState(null);
  const [activeSourceCaptions, setActiveSourceCaptions] = useState([]);
  const [pendingTimelineCandidate, setPendingTimelineCandidate] = useState(null);

  const [targetedAnalysis, setTargetedAnalysis] = useState({
    candidateId: null,
    running: false,
    status: "idle",
    error: null,
  });

  const abortRef = useRef(null);
  const exportAbortRef = useRef(null);
  const auditionTimerRef = useRef(null);
  const analyzingCandidatesRef = useRef(new Set());
  const attemptedAnalysisRef = useRef(new Set());
  const targetedAbortControllersRef = useRef(new Map());
  const targetedAnalysisPromisesRef = useRef(new Map());
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;

  const getAvailableSourceDetections = (candidate = null) => {
    const genuineFromActive = extractGenuineFaceDetections(activeSource?.source);
    const genuineFromCandidate = candidate ? extractGenuineFaceDetections(candidate) : [];
    const genuineFromSettings = Array.isArray(settings.faceDetections)
      ? settings.faceDetections.filter(isGenuineFaceDetection)
      : [];
    return genuineFromActive.length > 0
      ? genuineFromActive
      : (genuineFromCandidate.length > 0 ? genuineFromCandidate : genuineFromSettings);
  };

  // Available source video clips
  const availableSources = useMemo(() => {
    const timelineVideos = visualSegments
      .filter((s) => s.type === "video" || s.video || s.src)
      .map((s) => ({
        id: s.id,
        name: s.name || "Timeline Video",
        duration: s.duration || s.sourceDuration || 0,
        src: s.src,
        blob: s.blob,
        source: s,
        isTimelineClip: true,
      }));

    const assetVideos = userAssets
      .filter((a) => a.type === "video" || (a.name && /\.(mp4|webm|mov|mkv)$/i.test(a.name)))
      .map((a) => ({
        id: a.id,
        name: a.name || "Uploaded Media",
        duration: a.duration || 0,
        src: a.src,
        blob: a.blob,
        source: a,
        isTimelineClip: false,
      }));

    return [...timelineVideos, ...assetVideos];
  }, [visualSegments, userAssets]);

  // Currently active source
  const activeSource = useMemo(() => {
    if (selectedSourceId) {
      const found = availableSources.find((s) => s.id === selectedSourceId);
      if (found) return found;
    }
    if (selectedSegment && (selectedSegment.type === "video" || selectedSegment.video || selectedSegment.src)) {
      const found = availableSources.find((s) => s.id === selectedSegment.id);
      if (found) return found;
    }
    return availableSources[0] || null;
  }, [availableSources, selectedSourceId, selectedSegment]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      exportAbortRef.current?.abort();
      targetedAbortControllersRef.current?.forEach((ctrl) => ctrl.abort());
      targetedAbortControllersRef.current?.clear();
      if (auditionTimerRef.current) clearTimeout(auditionTimerRef.current);
    };
  }, []);

  const open = (sourceId) => {
    if (sourceId) setSelectedSourceId(sourceId);
    else if (!selectedSourceId && activeSource) setSelectedSourceId(activeSource.id);
    setError(null);
    setIsMinimized(false);
    setStage(candidates.length ? "review" : "configure");
    setIsOpen(true);
  };

  const close = () => {
    stopAudition();
    abortRef.current?.abort();
    exportAbortRef.current?.abort();
    targetedAbortControllersRef.current?.forEach((ctrl) => ctrl.abort());
    targetedAbortControllersRef.current?.clear();
    analyzingCandidatesRef.current?.clear();
    setTargetedAnalysis({ candidateId: null, running: false, status: "idle", error: null });
    setJob({ running: false, progress: 0, phase: "" });
    setExportJob({ running: false, progress: 0, current: 0, total: 0, title: "", phase: "", error: null });
    setIsMinimized(false);
    setIsOpen(false);
  };

  const minimize = () => {
    setIsMinimized(true);
  };

  const restore = () => {
    setIsMinimized(false);
    setIsOpen(true);
  };

  const cancelAnalysis = () => {
    abortRef.current?.abort();
    setJob({ running: false, progress: 0, phase: "" });
    setStage(candidates.length ? "review" : "configure");
    notify?.(t("shortsAnalysisCancelled", "Analysis cancelled."));
  };

  const cancelExport = () => {
    exportAbortRef.current?.abort();
    setExportJob({ running: false, progress: 0, current: 0, total: 0, title: "", phase: "", error: null });
    setStage("review");
    notify?.(t("shortsExportCancelled", "Export cancelled."));
  };

  const stopAudition = () => {
    if (auditionTimerRef.current) {
      clearTimeout(auditionTimerRef.current);
      auditionTimerRef.current = null;
    }
    pauseTimelineMedia?.();
    setIsPlaying?.(false);
    setAuditioningCandidateId(null);
  };

  const auditionCandidate = (candidate) => {
    if (!candidate) return;
    if (auditioningCandidateId === candidate.id) {
      stopAudition();
      return;
    }

    stopAudition();
    setAuditioningCandidateId(candidate.id);
    setCurrentTime?.(candidate.startTime);
    setIsPlaying?.(true);

    const playDuration = Math.max(1, candidate.endTime - candidate.startTime);
    auditionTimerRef.current = setTimeout(() => {
      stopAudition();
      setCurrentTime?.(candidate.startTime);
    }, playDuration * 1000);
  };

  const updateSetting = (key, value) => {
    setSettings((prev) => normalizeShortsSettings({ ...prev, [key]: value }));
  };

  // Sync active source captions whenever activeSource changes
  useEffect(() => {
    if (activeSource) {
      setActiveSourceCaptions(
        resolveSourceCaptions({
          activeSource,
          timelineVisualSegments: visualSegments,
          timelineCaptionSegments: captionSegments,
        })
      );
    } else {
      setActiveSourceCaptions([]);
    }
  }, [activeSource?.id, visualSegments, captionSegments]);

  // Start analysis pipeline
  const startAnalysis = async () => {
    console.log("[ShortsStudio] startAnalysis called. activeSource:", activeSource?.id, "sources:", availableSources.length);
    if (!activeSource) {
      setError(t("shortsNoMediaSelected", "No video media selected. Please select or import a video."));
      return;
    }

    abortRef.current?.abort();
    const abortController = new AbortController();
    abortRef.current = abortController;

    setError(null);
    setStage("analyzing");
    setJob({ running: true, progress: 5, phase: t("shortsInspectingSource", "Inspecting video technical metadata…") });

    try {
      const metadata = inspectSourceMetadata(activeSource.source);
      if (!metadata.valid) {
        throw new Error(t("shortsInvalidMedia", "Invalid source video. Could not read video duration or dimensions."));
      }

      // FIX 1: Resolve captions strictly belonging to the active source
      let sourceCaptions = resolveSourceCaptions({
        activeSource,
        timelineVisualSegments: visualSegments,
        timelineCaptionSegments: captionSegments,
      });

      // If speech transcript is empty, attempt audio extraction and transcription if speech is preferred
      if (!sourceCaptions.length && activeSource.source.blob && settings.contentType !== "gaming" && settings.contentType !== "sports") {
        setJob({ running: true, progress: 20, phase: t("shortsExtractingAudio", "Extracting source audio for speech recognition…") });
        try {
          // FIX 2: Safe audio extraction - reuse existing pre-extracted audio blobs or guard against memory exhaustion
          let audioBlob = null;
          if (activeSource.source.compatibilityAudioBlob instanceof Blob) {
            audioBlob = activeSource.source.compatibilityAudioBlob;
          } else if (activeSource.source.audioBlob instanceof Blob) {
            audioBlob = activeSource.source.audioBlob;
          } else if (activeSource.source.sourceAudioBlob instanceof Blob) {
            audioBlob = activeSource.source.sourceAudioBlob;
          } else {
            const blobSize = activeSource.source.blob.size || 0;
            const MAX_SAFE_EXTRACT_BYTES = 500 * 1024 * 1024; // 500MB safety threshold
            if (blobSize > MAX_SAFE_EXTRACT_BYTES) {
              console.warn(
                `Source video (${(blobSize / (1024 * 1024)).toFixed(1)}MB) exceeds safe memory limit for in-browser audio extraction. Falling back to visual analysis.`
              );
            } else {
              audioBlob = await extractAudioFromVideo(activeSource.source.blob, activeSource.name);
            }
          }

          if (abortController.signal.aborted) {
            return;
          }

          if (audioBlob) {
            setJob({ running: true, progress: 35, phase: t("shortsTranscribing", "Analyzing speech sentences and timestamps (Whisper ASR)…") });
            const asrRes = await transcribeAudioToCaptionSegments(audioBlob, {
              signal: abortController.signal,
              onProgress: ({ progress }) => {
                setJob((j) => ({ ...j, progress: Math.min(65, 35 + (progress || 0) * 0.3) }));
              },
            });
            if (asrRes?.segments?.length) {
              sourceCaptions = asrRes.segments;
            }
          }
        } catch (err) {
          if (abortController.signal.aborted) return;
          console.warn("Speech transcription fallback skipped:", err?.message);
        }
      }

      setActiveSourceCaptions(sourceCaptions);

      const genuineFromSource = extractGenuineFaceDetections(activeSource.source);
      let sourceFaceDetections = genuineFromSource.length > 0
        ? genuineFromSource
        : (Array.isArray(settings.faceDetections) && settings.faceDetections.length > 0
          ? settings.faceDetections.filter(isGenuineFaceDetection)
          : null);

      console.info("[ShortsStudio Pipeline Diagnostic] Pre-existing detections on source:", {
        count: genuineFromSource.length,
        settingsCount: Array.isArray(settings.faceDetections) ? settings.faceDetections.length : 0,
      });

      // Perform local face detection pass on source video if no detections are pre-computed
      if (!sourceFaceDetections && ["smart-subject", "smart-zoom"].includes(settings.autoReframing)) {
        setJob({ running: true, progress: 72, phase: t("shortsDetectingFaces", "Detecting subjects locally on video footage…") });
        try {
          const sampleResult = await sampleVideoFaceDetections({
            source: activeSource.source,
            duration: metadata.duration || activeSource.duration,
            signal: abortController.signal,
            onProgress: (p) => {
              setJob((j) => ({ ...j, progress: Math.min(84, 72 + Math.round((p || 0) * 0.12)) }));
            },
          });

          console.info("[ShortsStudio Pipeline Diagnostic] Local face detection pass result:", {
            supported: sampleResult?.supported,
            status: sampleResult?.status,
            sampledFramesCount: sampleResult?.sampledFramesCount,
            detectionsCount: sampleResult?.detections?.length || 0,
            reason: sampleResult?.reason,
          });

          if (sampleResult?.detections?.length > 0) {
            sourceFaceDetections = sampleResult.detections;
            setSettings((s) => ({ ...s, faceDetections: sourceFaceDetections }));
            if (activeSource.source && typeof activeSource.source === "object") {
              activeSource.source.faceDetections = sourceFaceDetections;
            }
          }
        } catch (err) {
          if (abortController.signal.aborted) return;
          console.warn("[ShortsStudio] Local face detection pass skipped:", err?.message);
        }
      }

      setJob({ running: true, progress: 85, phase: t("shortsFindingMoments", "Evaluating hooks, conversational bounds, and visual action…") });

      const discovery = discoverShortCandidates({
        sourceMedia: activeSource.source,
        transcriptResult: sourceCaptions,
        settings: {
          ...settings,
          ...(sourceFaceDetections ? { faceDetections: sourceFaceDetections } : {}),
        },
      });

      if (!discovery.ok) {
        throw new Error(discovery.message || t("shortsNoMomentsFound", "Could not discover candidate moments matching criteria."));
      }

      setCandidates(discovery.candidates);
      setActiveCandidateId(discovery.candidates[0]?.id || "");
      setSelectedCandidateIds(new Set(discovery.candidates.map((c) => c.id)));
      setStage("review");
      setJob({ running: false, progress: 100, phase: "" });
      notify?.(t("shortsDiscoveredSuccess", `Discovered ${discovery.candidates.length} candidate shorts!`));
    } catch (err) {
      console.error("[ShortsStudio] startAnalysis caught error:", err);
      if (err?.name === "AbortError" || abortController.signal.aborted) {
        setJob({ running: false, progress: 0, phase: "" });
        setStage("configure");
        return;
      }
      setError(err?.message || String(err));
      setStage("configure");
      setJob({ running: false, progress: 0, phase: "" });
    }
  };

  const updateCandidate = (candidateId, updates) => {
    setCandidates((prev) =>
      prev.map((c) => {
        if (c.id !== candidateId) return c;
        const maxMediaDur = activeSource?.duration || 99999;
        let newStart = c.startTime;
        let newEnd = c.endTime;

        if (updates.startTime !== undefined) {
          const val = Number(updates.startTime);
          newStart = Math.max(0, Math.min(Number.isFinite(val) ? val : 0, maxMediaDur - 0.5));
          if (newStart >= newEnd) {
            newEnd = Math.min(maxMediaDur, newStart + 3.0);
          }
        }

        if (updates.endTime !== undefined) {
          const val = Number(updates.endTime);
          newEnd = Math.max(newStart + 0.5, Math.min(Number.isFinite(val) ? val : (newStart + 0.5), maxMediaDur));
          if (newEnd <= newStart) {
            newStart = Math.max(0, newEnd - 3.0);
          }
        }

        const duration = Number(Math.max(0.5, newEnd - newStart).toFixed(2));
        const updated = {
          ...c,
          ...updates,
          startTime: Number(newStart.toFixed(2)),
          endTime: Number(newEnd.toFixed(2)),
          duration,
        };

        // FIX 4: Recompute transcriptExcerpt from the active source captions
        if (updates.startTime !== undefined || updates.endTime !== undefined) {
          updated.transcriptExcerpt = extractTranscriptExcerpt(
            activeSourceCaptions,
            updated.startTime,
            updated.endTime,
            updated.strategy
          );
        }

        // If target ratio or cropX or framingMode changed, adapt smartFrame & cropX
        if ((updates.aspectRatio && updates.aspectRatio !== c.aspectRatio) || updates.cropX !== undefined || updates.framingMode !== undefined) {
          const targetRatio = updates.aspectRatio || updated.aspectRatio || "9:16";
          const genuineFromActive = extractGenuineFaceDetections(activeSource?.source);
          const genuineFromCandidate = extractGenuineFaceDetections(c);
          const sourceDetections = genuineFromActive.length > 0
            ? genuineFromActive
            : (genuineFromCandidate.length > 0
              ? genuineFromCandidate
              : (Array.isArray(settings.faceDetections) ? settings.faceDetections.filter(isGenuineFaceDetection) : []));
          const sourceSize = {
            width: activeSource?.source?.width || 1920,
            height: activeSource?.source?.height || 1080,
          };

          const hasDetections = Array.isArray(sourceDetections) && sourceDetections.length > 0;
          const framingMode = updates.framingMode || updated.framingMode || "smart-zoom";
          const userSelectedSubject = updated.userSelectedSubject ?? updated.targetSubject ?? null;

          if (["smart-subject", "smart-zoom"].includes(framingMode)) {
            let candDetections = [];
            if (hasDetections) {
              candDetections = sourceDetections
                .filter((d) => d && Number.isFinite(Number(d.time ?? d.timestamp)) && (d.time ?? d.timestamp) >= updated.startTime && (d.time ?? d.timestamp) <= updated.endTime)
                .map((d) => ({ ...d, time: Number(((d.time ?? d.timestamp) - updated.startTime).toFixed(3)) }));
            }
            const reframingTrack = buildDynamicReframingTrack({
              detections: candDetections,
              duration: updated.duration,
              startTime: updated.startTime,
              sourceStart: updated.startTime,
              sourceSize,
              targetRatio,
              sceneCuts: updated.sceneCuts,
              manualCropX: updated.cropX ?? 0.5,
              userSelectedSubject,
              speechIntervals: (updated.sentences || []).map((s) => ({
                start: Math.max(0, s.start - updated.startTime),
                end: Math.max(0, s.end - updated.startTime),
              })),
              sentences: (updated.sentences || []).map((s) => ({
                ...s,
                start: Math.max(0, s.start - updated.startTime),
                end: Math.max(0, s.end - updated.startTime),
              })),
            });
            const reframed = applyDynamicReframingToCandidate(updated, reframingTrack, { userSelectedSubject });
            Object.assign(updated, reframed);
          } else if (framingMode === "center" || framingMode === "safe-contain") {
            const fallbackTrack = generateFallbackReframingTrack(sourceSize, targetRatio, updated.duration, updated.cropX ?? 0.5);
            if (framingMode === "safe-contain") fallbackTrack.presentation = "safe-contain";
            const reframed = applyDynamicReframingToCandidate(updated, fallbackTrack, { userSelectedSubject });
            Object.assign(updated, reframed);
          }
        }

        return updated;
      })
    );

    if (updates.framingMode && ["smart-subject", "smart-zoom"].includes(updates.framingMode)) {
      setTimeout(() => {
        runTargetedCandidateAnalysis(candidateId);
      }, 0);
    }
  };

  /**
   * Executes targeted subject detection for a single candidate short moment,
   * avoiding full-source re-sampling and recovering from empty initial discovery passes.
   */
  /**
   * Executes targeted subject detection for a single candidate short moment,
   * avoiding full-source re-sampling and recovering from empty initial discovery passes.
   */
  const runTargetedCandidateAnalysis = (
    candidateId,
    { force = false, detector = null, visionAnalyzer = null } = {}
  ) => {
    if (!candidateId || !activeSource) return Promise.resolve(null);
    const candidate = candidatesRef.current.find((c) => c.id === candidateId);
    if (!candidate) return Promise.resolve(null);

    const framingMode = candidate.framingMode || settings.autoReframing || "smart-zoom";
    if (!["smart-subject", "smart-zoom"].includes(framingMode)) {
      return Promise.resolve(null);
    }

    if (targetedAnalysisPromisesRef.current.has(candidate.id)) {
      return targetedAnalysisPromisesRef.current.get(candidate.id);
    }

    const cacheKey = `${candidate.id}_${candidate.startTime}_${candidate.endTime}_${candidate.aspectRatio || settings.aspectRatio || "9:16"}`;
    if (!force && attemptedAnalysisRef.current.has(cacheKey)) {
      return Promise.resolve(null);
    }

    if (analyzingCandidatesRef.current.has(candidate.id)) {
      return Promise.resolve(null);
    }

    // Check if genuine detections already exist in activeSource, candidate, or settings
    const sourceDetections = getAvailableSourceDetections(candidate);
    const matchingDetections = sourceDetections.filter((d) => {
      const t = Number(d.time ?? d.timestamp);
      return Number.isFinite(t) && t >= candidate.startTime - 0.15 && t <= candidate.endTime + 0.15;
    });

    const targetRatio = candidate.aspectRatio || settings.aspectRatio || "9:16";
    const sourceSize = {
      width: activeSource.source?.width || 1920,
      height: activeSource.source?.height || 1080,
    };
    const userSelectedSubject = candidate.userSelectedSubject ?? candidate.targetSubject ?? null;

    if (matchingDetections.length > 0 && hasAdequateCandidateDetections(candidate, matchingDetections)) {
      attemptedAnalysisRef.current.add(cacheKey);
      const candDetections = matchingDetections.map((d) => ({
        ...d,
        time: Number(((d.time ?? d.timestamp) - candidate.startTime).toFixed(3)),
      }));

      const reframingTrack = buildDynamicReframingTrack({
        detections: candDetections,
        duration: candidate.duration,
        startTime: candidate.startTime,
        sourceStart: candidate.startTime,
        sourceSize,
        targetRatio,
        sceneCuts: candidate.sceneCuts,
        manualCropX: candidate.cropX ?? 0.5,
        userSelectedSubject,
        speechIntervals: (candidate.sentences || []).map((s) => ({
          start: Math.max(0, s.start - candidate.startTime),
          end: Math.max(0, s.end - candidate.startTime),
        })),
        sentences: (candidate.sentences || []).map((s) => ({
          ...s,
          start: Math.max(0, s.start - candidate.startTime),
          end: Math.max(0, s.end - candidate.startTime),
        })),
      });

      const reframed = applyDynamicReframingToCandidate(candidate, reframingTrack, { userSelectedSubject });
      let updatedCand = null;
      setCandidates((prev) =>
        prev.map((c) => {
          if (c.id === candidate.id) {
            updatedCand = { ...c, ...reframed, trackingStatus: "tracked", trackingReason: null };
            return updatedCand;
          }
          return c;
        })
      );
      setTargetedAnalysis({ candidateId: candidate.id, running: false, status: "tracked", error: null });
      return Promise.resolve(updatedCand || { ...candidate, ...reframed });
    }

    // Launch targeted sampling pass for this candidate moment
    analyzingCandidatesRef.current.add(candidate.id);
    const controller = new AbortController();
    targetedAbortControllersRef.current.set(candidate.id, controller);

    setTargetedAnalysis({ candidateId: candidate.id, running: true, status: "analyzing", error: null });
    setCandidates((prev) =>
      prev.map((c) => (c.id === candidate.id ? { ...c, trackingStatus: "analyzing" } : c))
    );

    const promise = (async () => {
      try {
        const handlePartialDetections = (partialList) => {
          if (!partialList || !partialList.length || controller.signal.aborted) return;
          const combined = [...sourceDetections, ...partialList];
          const candDetections = combined
            .filter((d) => d && Number.isFinite(Number(d.time ?? d.timestamp)) && (d.time ?? d.timestamp) >= candidate.startTime - 0.15 && (d.time ?? d.timestamp) <= candidate.endTime + 0.15)
            .sort((a, b) => Number(a.time ?? a.timestamp) - Number(b.time ?? b.timestamp))
            .map((d) => ({
              ...d,
              time: Number(((d.time ?? d.timestamp) - candidate.startTime).toFixed(3)),
            }));

          if (candDetections.length === 0) return;

          const partialTrack = buildDynamicReframingTrack({
            detections: candDetections,
            duration: candidate.duration,
            startTime: candidate.startTime,
            sourceStart: candidate.startTime,
            sourceSize,
            targetRatio,
            sceneCuts: candidate.sceneCuts,
            manualCropX: candidate.cropX ?? 0.5,
            userSelectedSubject,
            speechIntervals: (candidate.sentences || []).map((s) => ({
              start: Math.max(0, s.start - candidate.startTime),
              end: Math.max(0, s.end - candidate.startTime),
            })),
            sentences: (candidate.sentences || []).map((s) => ({
              ...s,
              start: Math.max(0, s.start - candidate.startTime),
              end: Math.max(0, s.end - candidate.startTime),
            })),
          });

          const partialReframed = applyDynamicReframingToCandidate(candidate, partialTrack, { userSelectedSubject });
          setCandidates((prev) =>
            prev.map((c) => {
              if (c.id === candidate.id) {
                return {
                  ...c,
                  ...partialReframed,
                  faceDetections: partialList,
                  trackingStatus: "analyzing",
                  trackingReason: null,
                };
              }
              return c;
            })
          );
        };

        const sampleResult = await sampleVideoFaceDetections({
          source: activeSource.source,
          startTime: candidate.startTime,
          duration: candidate.duration,
          interval: 1.0,
          maxSamples: 32,
          signal: controller.signal,
          onPartialDetections: handlePartialDetections,
          detector,
          visionAnalyzer,
          sceneCuts: candidate.sceneCuts,
        });

        if (controller.signal.aborted) return null;
        attemptedAnalysisRef.current.add(cacheKey);

        if (sampleResult?.detections?.length > 0) {
          const newDetections = sampleResult.detections;
          if (activeSource.source && typeof activeSource.source === "object") {
            activeSource.source.faceDetections = [
              ...(Array.isArray(activeSource.source.faceDetections) ? activeSource.source.faceDetections : []),
              ...newDetections,
            ];
          }
          setSettings((s) => ({
            ...s,
            faceDetections: [
              ...(Array.isArray(s.faceDetections) ? s.faceDetections : []),
              ...newDetections,
            ],
          }));

          const combinedDetections = [...sourceDetections, ...newDetections];
          const candDetections = combinedDetections
            .filter((d) => d && Number.isFinite(Number(d.time ?? d.timestamp)) && (d.time ?? d.timestamp) >= candidate.startTime - 0.15 && (d.time ?? d.timestamp) <= candidate.endTime + 0.15)
            .sort((a, b) => Number(a.time ?? a.timestamp) - Number(b.time ?? b.timestamp))
            .map((d) => ({
              ...d,
              time: Number(((d.time ?? d.timestamp) - candidate.startTime).toFixed(3)),
            }));

          const reframingTrack = buildDynamicReframingTrack({
            detections: candDetections,
            duration: candidate.duration,
            startTime: candidate.startTime,
            sourceStart: candidate.startTime,
            sourceSize,
            targetRatio,
            sceneCuts: candidate.sceneCuts,
            manualCropX: candidate.cropX ?? 0.5,
            userSelectedSubject,
            speechIntervals: (candidate.sentences || []).map((s) => ({
              start: Math.max(0, s.start - candidate.startTime),
              end: Math.max(0, s.end - candidate.startTime),
            })),
            sentences: (candidate.sentences || []).map((s) => ({
              ...s,
              start: Math.max(0, s.start - candidate.startTime),
              end: Math.max(0, s.end - candidate.startTime),
            })),
          });

          const reframed = applyDynamicReframingToCandidate(candidate, reframingTrack, { userSelectedSubject });
          let resolvedCandidate = null;
          setCandidates((prev) =>
            prev.map((c) => {
              if (c.id === candidate.id) {
                resolvedCandidate = {
                  ...c,
                  ...reframed,
                  faceDetections: newDetections,
                  trackingStatus: "tracked",
                  trackingReason: null,
                };
                return resolvedCandidate;
              }
              return c;
            })
          );
          setTargetedAnalysis({ candidateId: candidate.id, running: false, status: "tracked", error: null });
          return resolvedCandidate || { ...candidate, ...reframed };
        } else {
          const status = sampleResult?.status === "unsupported" ? "unsupported" : "no_subjects_found";
          const reason = sampleResult?.reason || (status === "unsupported" ? "Local detection unsupported in this browser" : "No subjects detected in clip");
          let fallbackCand = null;
          setCandidates((prev) =>
            prev.map((c) => {
              if (c.id === candidate.id) {
                fallbackCand = {
                  ...c,
                  trackingStatus: status,
                  trackingReason: reason,
                  smartFrame: {
                    ...(c.smartFrame || {}),
                    isFallback: true,
                    state: "fallback",
                    fallbackReason: status,
                  },
                };
                return fallbackCand;
              }
              return c;
            })
          );
          setTargetedAnalysis({ candidateId: candidate.id, running: false, status, error: reason });
          return fallbackCand || candidate;
        }
      } catch (err) {
        if (err?.name === "AbortError" || controller.signal.aborted) {
          return null;
        }
        console.warn("[ShortsStudio] Targeted candidate detection failed:", err?.message);
        attemptedAnalysisRef.current.add(cacheKey);
        setCandidates((prev) =>
          prev.map((c) =>
            c.id === candidate.id
              ? {
                  ...c,
                  trackingStatus: "error",
                  trackingReason: err?.message || "Detection failed",
                  smartFrame: {
                    ...(c.smartFrame || {}),
                    isFallback: true,
                    state: "fallback",
                    fallbackReason: "error",
                  },
                }
              : c
          )
        );
        setTargetedAnalysis({ candidateId: candidate.id, running: false, status: "error", error: err?.message });
        return null;
      } finally {
        analyzingCandidatesRef.current.delete(candidate.id);
        targetedAbortControllersRef.current.delete(candidate.id);
        targetedAnalysisPromisesRef.current.delete(candidate.id);
        setTargetedAnalysis((curr) => (curr.candidateId === candidate.id ? { ...curr, running: false } : curr));
      }
    })();

    targetedAnalysisPromisesRef.current.set(candidate.id, promise);
    return promise;
  };

  const retryCandidateAnalysis = (candidateId, options = {}) => {
    if (!candidateId) return;
    const candidate = candidatesRef.current.find((c) => c.id === candidateId);
    if (candidate) {
      const cacheKey = `${candidate.id}_${candidate.startTime}_${candidate.endTime}_${candidate.aspectRatio || settings.aspectRatio || "9:16"}`;
      attemptedAnalysisRef.current.delete(cacheKey);
      runTargetedCandidateAnalysis(candidateId, { force: true, ...options });
    }
  };

  // Auto-recovery: when active candidate is selected in review stage, detect if it needs targeted subject analysis
  useEffect(() => {
    if (stage !== "review" || !activeCandidateId || !candidates.length) return;
    const active = candidates.find((c) => c.id === activeCandidateId);
    if (!active) return;
    const framingMode = active.framingMode || settings.autoReframing || "smart-zoom";
    if (!["smart-subject", "smart-zoom"].includes(framingMode)) return;

    const sourceDetections = getAvailableSourceDetections(active);
    if (needsTargetedSubjectAnalysis(active, sourceDetections)) {
      const cacheKey = `${active.id}_${active.startTime}_${active.endTime}_${active.aspectRatio || settings.aspectRatio || "9:16"}`;
      if (!attemptedAnalysisRef.current.has(cacheKey) && !analyzingCandidatesRef.current.has(active.id)) {
        runTargetedCandidateAnalysis(active.id);
      }
    }
  }, [activeCandidateId, stage, candidates.length]);

  const removeCandidate = (candidateId) => {
    targetedAbortControllersRef.current?.get(candidateId)?.abort();
    targetedAbortControllersRef.current?.delete(candidateId);
    analyzingCandidatesRef.current?.delete(candidateId);
    setCandidates((prev) => prev.filter((c) => c.id !== candidateId));
    setSelectedCandidateIds((prev) => {
      const next = new Set(prev);
      next.delete(candidateId);
      return next;
    });
    if (activeCandidateId === candidateId) {
      setActiveCandidateId(candidates.find((c) => c.id !== candidateId)?.id || "");
    }
  };

  const toggleSelectCandidate = (candidateId) => {
    setSelectedCandidateIds((prev) => {
      const next = new Set(prev);
      if (next.has(candidateId)) next.delete(candidateId);
      else next.add(candidateId);
      return next;
    });
  };

  const selectAllCandidates = () => {
    setSelectedCandidateIds(new Set(candidates.map((c) => c.id)));
  };

  const deselectAllCandidates = () => {
    setSelectedCandidateIds(new Set());
  };

  // Load a candidate directly into the editor timeline
  const applyCandidateToTimeline = (candidate) => {
    if (!candidate || !activeSource) return;

    // FIX 3: If timeline already contains user clips, require explicit confirmation
    if (visualSegments.length > 0) {
      setPendingTimelineCandidate(candidate);
      return;
    }

    confirmApplyCandidateToTimeline(candidate);
  };

  const confirmApplyCandidateToTimeline = async (candidateToApply = pendingTimelineCandidate) => {
    if (!candidateToApply || !activeSource) return;

    let targetCandidate = candidatesRef.current.find((c) => c.id === candidateToApply.id) || candidateToApply;
    const framingMode = targetCandidate.framingMode || settings.autoReframing || "smart-zoom";

    if (["smart-subject", "smart-zoom"].includes(framingMode)) {
      const sourceDetections = getAvailableSourceDetections(targetCandidate);
      if (targetedAnalysisPromisesRef.current.has(targetCandidate.id)) {
        await targetedAnalysisPromisesRef.current.get(targetCandidate.id);
        targetCandidate = candidatesRef.current.find((c) => c.id === targetCandidate.id) || targetCandidate;
      } else if (needsTargetedSubjectAnalysis(targetCandidate, sourceDetections)) {
        await runTargetedCandidateAnalysis(targetCandidate.id);
        targetCandidate = candidatesRef.current.find((c) => c.id === targetCandidate.id) || targetCandidate;
      }
    }

    const sourceFaceDetections = getAvailableSourceDetections(targetCandidate);
    const candidateWithDetections = {
      ...targetCandidate,
      ...(sourceFaceDetections && sourceFaceDetections.length > 0 ? { faceDetections: sourceFaceDetections } : {}),
    };

    const project = convertCandidateToProject(activeSource.source, candidateWithDetections, {
      aspectRatio: targetCandidate.aspectRatio || settings.aspectRatio,
      captionPresetId: settings.captionPresetId,
      autoReframing: targetCandidate.framingMode || settings.autoReframing,
      cropX: targetCandidate.cropX ?? settings.cropX ?? 0.5,
      captionSegments: activeSourceCaptions,
      faceDetections: sourceFaceDetections,
    });
    if (!project) return;

    console.info("[ShortsStudio Pipeline Diagnostic] confirmApplyCandidateToTimeline:", {
      candidateId: targetCandidate.id,
      title: targetCandidate.title,
      aspectRatio: targetCandidate.aspectRatio || settings.aspectRatio,
      framingMode: targetCandidate.framingMode || settings.autoReframing,
      appliedSmartFrame: {
        isFallback: project.visualSegments?.[0]?.smartFrame?.isFallback,
        state: project.visualSegments?.[0]?.smartFrame?.state,
        keyframesCount: project.visualSegments?.[0]?.smartFrame?.cropKeyframes?.length,
        firstKeyframe: project.visualSegments?.[0]?.smartFrame?.cropKeyframes?.[0],
      },
    });

    onApplyProject?.(project);
    notify?.(t("shortsLoadedInTimeline", `Loaded "${targetCandidate.title}" into the timeline!`));
    setPendingTimelineCandidate(null);
    close();
  };

  const cancelApplyCandidateToTimeline = () => {
    setPendingTimelineCandidate(null);
  };

  // Export selected candidate short
  const exportCandidate = async (candidate, index = 1) => {
    if (!candidate || !activeSource) return;

    let targetCandidate = candidatesRef.current.find((c) => c.id === candidate.id) || candidate;
    const framingMode = targetCandidate.framingMode || settings.autoReframing || "smart-zoom";

    if (["smart-subject", "smart-zoom"].includes(framingMode)) {
      const sourceDetections = getAvailableSourceDetections(targetCandidate);
      if (targetedAnalysisPromisesRef.current.has(targetCandidate.id)) {
        await targetedAnalysisPromisesRef.current.get(targetCandidate.id);
        targetCandidate = candidatesRef.current.find((c) => c.id === targetCandidate.id) || targetCandidate;
      } else if (needsTargetedSubjectAnalysis(targetCandidate, sourceDetections)) {
        await runTargetedCandidateAnalysis(targetCandidate.id);
        targetCandidate = candidatesRef.current.find((c) => c.id === targetCandidate.id) || targetCandidate;
      }
    }

    exportAbortRef.current?.abort();
    const abortController = new AbortController();
    exportAbortRef.current = abortController;

    const sourceFaceDetections = getAvailableSourceDetections(targetCandidate);
    const exportOptions = {
      aspectRatio: targetCandidate.aspectRatio || settings.aspectRatio,
      captionPresetId: settings.captionPresetId,
      autoReframing: targetCandidate.framingMode || settings.autoReframing,
      cropX: targetCandidate.cropX ?? settings.cropX ?? 0.5,
      captionSegments: activeSourceCaptions,
      faceDetections: sourceFaceDetections,
    };

    setStage("exporting");
    setExportJob({
      running: true,
      progress: 2,
      current: 1,
      total: 1,
      title: targetCandidate.title,
      phase: t("shortsExportPreparing", "Preparing short video export…"),
      error: null,
    });

    try {
      if (onExportShort) {
        // If external custom exporter is provided
        const spec = buildShortExportSpec(activeSource.source, targetCandidate, exportOptions);
        await onExportShort(spec, {
          candidate: targetCandidate,
          sourceMedia: activeSource.source,
          options: exportOptions,
          index,
          signal: abortController.signal,
          onProgress: (p) => {
            setExportJob((prev) => ({
              ...prev,
              progress: p.progress ?? prev.progress,
              phase: p.phase ?? prev.phase,
            }));
          },
        });
      } else {
        // Default: direct offline WebCodecs export
        await exportShortCandidateVideo(activeSource.source, targetCandidate, exportOptions, {
          signal: abortController.signal,
          index,
          onProgress: (p) => {
            setExportJob((prev) => ({
              ...prev,
              progress: p.progress ?? prev.progress,
              phase: p.phase ?? prev.phase,
            }));
          },
        });
      }

      setExportJob({ running: false, progress: 100, current: 1, total: 1, title: targetCandidate.title, phase: "", error: null });
      setStage("review");
      notify?.(t("shortsExportSuccess", `Successfully exported "${targetCandidate.title}"!`));
    } catch (err) {
      if (err?.name === "AbortError" || abortController.signal.aborted) {
        setExportJob({ running: false, progress: 0, current: 0, total: 0, title: "", phase: "", error: null });
        setStage("review");
        return;
      }
      const errMsg = err?.message || String(err);
      setError(errMsg);
      setExportJob({ running: false, progress: 0, current: 0, total: 0, title: "", phase: "", error: errMsg });
      setStage("review");
    }
  };

  // Batch export selected candidate shorts
  const exportSelectedCandidates = async () => {
    const selected = candidates.filter((c) => selectedCandidateIds.has(c.id));
    if (!selected.length || !activeSource) return;

    exportAbortRef.current?.abort();
    const abortController = new AbortController();
    exportAbortRef.current = abortController;

    const total = selected.length;
    setStage("exporting");
    setExportJob({
      running: true,
      progress: 0,
      current: 1,
      total,
      title: selected[0]?.title || "",
      phase: t("shortsBatchExportStarting", `Starting batch export of ${total} shorts…`),
      error: null,
    });

    const genuineFromActive = extractGenuineFaceDetections(activeSource.source);
    const sourceFaceDetections = genuineFromActive.length > 0
      ? genuineFromActive
      : (Array.isArray(settings.faceDetections) && settings.faceDetections.length > 0
        ? settings.faceDetections.filter(isGenuineFaceDetection)
        : null);

    const exportOptions = {
      aspectRatio: settings.aspectRatio,
      captionPresetId: settings.captionPresetId,
      autoReframing: settings.autoReframing,
      cropX: settings.cropX ?? 0.5,
      captionSegments: activeSourceCaptions,
      faceDetections: sourceFaceDetections,
    };

    try {
      const batchResult = await exportShortCandidatesBatch(
        activeSource.source,
        selected,
        exportOptions,
        {
          signal: abortController.signal,
          onProgress: (prog) => {
            setExportJob((prev) => ({
              ...prev,
              progress: prog.progress ?? prev.progress,
              current: prog.current ?? prev.current,
              total: prog.total ?? prev.total,
              title: prog.title ?? prev.title,
            }));
          },
          onItemProgress: (item) => {
            setExportJob((prev) => ({
              ...prev,
              current: item.current,
              total: item.total,
              title: item.title,
              phase: item.phase,
            }));
          },
        }
      );

      setExportJob({ running: false, progress: 100, current: total, total, title: "", phase: "", error: null });
      setStage("review");

      if (batchResult.errors?.length > 0) {
        notify?.(t("shortsBatchPartial", `Exported ${batchResult.exported.length} of ${total} shorts (${batchResult.errors.length} failed).`));
      } else {
        notify?.(t("shortsBatchSuccess", `Successfully exported all ${total} shorts!`));
      }
    } catch (err) {
      if (err?.name === "AbortError" || abortController.signal.aborted) {
        setExportJob({ running: false, progress: 0, current: 0, total: 0, title: "", phase: "", error: null });
        setStage("review");
        return;
      }
      const errMsg = err?.message || String(err);
      setError(errMsg);
      setExportJob({ running: false, progress: 0, current: 0, total: 0, title: "", phase: "", error: errMsg });
      setStage("review");
    }
  };

  // Export editable timeline package for candidate short (Priority 10)
  const exportCandidateTimeline = async (candidate, format = "all", index = 1) => {
    if (!candidate || !activeSource) return;

    const exportOptions = {
      aspectRatio: candidate.aspectRatio || settings.aspectRatio,
      captionPresetId: settings.captionPresetId,
      autoReframing: candidate.framingMode || settings.autoReframing,
      cropX: candidate.cropX ?? settings.cropX ?? 0.5,
      captionSegments: activeSourceCaptions,
      availableAssets: userAssets,
      autoTransitions: settings.autoTransitions ?? true,
    };

    try {
      notify?.(t("shortsPackagingTimeline", `Exporting editable timeline package for "${candidate.title}"…`));
      const res = await exportShortCandidateTimelinePackage(
        activeSource.source,
        candidate,
        exportOptions,
        { format, autoDownload: true, index }
      );
      notify?.(t("shortsTimelineExportSuccess", `Successfully exported "${res.fileName}"!`));
      return res;
    } catch (err) {
      const errMsg = err?.message || String(err);
      setError(errMsg);
      notify?.(t("shortsTimelineExportFailed", `Failed to export timeline: ${errMsg}`));
    }
  };

  return {
    isOpen,
    isMinimized,
    minimize,
    restore,
    open,
    close,
    stage,
    setStage,
    availableSources,
    selectedSourceId,
    setSelectedSourceId,
    activeSource,
    settings,
    updateSetting,
    job,
    exportJob,
    error,
    setError,
    candidates,
    activeCandidateId,
    setActiveCandidateId,
    selectedCandidateIds,
    toggleSelectCandidate,
    selectAllCandidates,
    deselectAllCandidates,
    auditioningCandidateId,
    auditionCandidate,
    stopAudition,
    startAnalysis,
    cancelAnalysis,
    cancelExport,
    updateCandidate,
    removeCandidate,
    applyCandidateToTimeline,
    pendingTimelineCandidate,
    confirmApplyCandidateToTimeline,
    cancelApplyCandidateToTimeline,
    activeSourceCaptions,
    exportCandidate,
    exportSelectedCandidates,
    exportCandidateTimeline,
    targetedAnalysis,
    runTargetedCandidateAnalysis,
    retryCandidateAnalysis,
  };
}

export { isCandidateFallbackDueToMissingDetections };

