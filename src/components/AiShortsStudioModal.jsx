/**
 * @file AiShortsStudioModal.jsx
 * AI Shorts Studio — Suggested Shorts Workspace & High-Quality Long-to-Short Generation.
 */

import { useEffect, useRef, useState, useMemo } from "react";
import {
  Sparkle,
  FilmSlate,
  X,
  Play,
  Pause,
  DownloadSimple,
  ArrowCounterClockwise,
  CheckCircle,
  SlidersHorizontal,
  DeviceMobile,
  Square,
  Monitor,
  Trash,
  Clock,
  ThumbsUp,
  MagicWand,
  UserFocus,
  Crop,
  MagnifyingGlassPlus,
  FrameCorners,
  WarningCircle,
  Check,
  Minus,
} from "@phosphor-icons/react";

import {
  SHORTS_CONTENT_TYPES,
  SHORTS_ASPECT_RATIOS,
  SHORTS_DURATION_PRESETS,
  SHORTS_PREFERENCES,
  SHORTS_FRAMING_MODES,
  isCandidateSmartFrameFallback,
} from "../lib/shortsStudio.js";
import { resolveSmartFrameCropAtTime } from "../lib/smartFrame.js";
import { isCandidateFallbackDueToMissingDetections } from "../lib/shortsReframing.js";
import { BUILTIN_CAPTION_STYLE_PRESETS } from "../lib/captionStyles.js";
import "./AiShortsStudioModal.css";

export function AiShortsStudioModal({
  isOpen,
  studio,
  t = (k, f) => f || k,
}) {
  const videoPreviewRef = useRef(null);
  const [isPlayingPreview, setIsPlayingPreview] = useState(false);
  const [previewTime, setPreviewTime] = useState(0);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === "Escape") studio.close();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, studio]);

  const {
    isMinimized,
    minimize,
    restore,
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
    candidates,
    activeCandidateId,
    setActiveCandidateId,
    selectedCandidateIds,
    toggleSelectCandidate,
    selectAllCandidates,
    deselectAllCandidates,
    startAnalysis,
    cancelAnalysis,
    cancelExport,
    updateCandidate,
    removeCandidate,
    applyCandidateToTimeline,
    pendingTimelineCandidate,
    confirmApplyCandidateToTimeline,
    cancelApplyCandidateToTimeline,
    exportCandidate,
    exportSelectedCandidates,
    exportCandidateTimeline,
    targetedAnalysis,
    retryCandidateAnalysis,
    close,
  } = studio;

  const activeCandidate = candidates.find((c) => c.id === activeCandidateId) || candidates[0] || null;

  const isSubjectTracking = ["smart-subject", "smart-zoom"].includes(activeCandidate?.framingMode || settings.autoReframing);
  const isAnalyzingTarget = Boolean(
    targetedAnalysis?.running && targetedAnalysis?.candidateId === activeCandidate?.id
  );
  const isFallbackTrack = Boolean(
    isCandidateSmartFrameFallback(activeCandidate?.smartFrame, activeCandidate) ||
    isCandidateFallbackDueToMissingDetections(activeCandidate)
  );
  const showSubjectFallbackWarning = isSubjectTracking && isFallbackTrack && !isAnalyzingTarget;

  const currentPreviewPanFactor = useMemo(() => {
    if (!activeCandidate) return 0.5;
    if (activeCandidate.smartFrame && Array.isArray(activeCandidate.smartFrame.cropKeyframes) && activeCandidate.smartFrame.cropKeyframes.length > 0) {
      const relTime = Math.max(0, (previewTime || activeCandidate.startTime) - activeCandidate.startTime);
      const crop = resolveSmartFrameCropAtTime(activeCandidate.smartFrame, relTime);
      if (crop) {
        if (Number.isFinite(crop.panFactor)) return crop.panFactor;
        if (Number.isFinite(crop.width) && (1 - crop.width) > 0.0001) {
          return Math.max(0, Math.min(1, crop.x / (1 - crop.width)));
        }
      }
    }
    return activeCandidate.cropX ?? 0.5;
  }, [activeCandidate, previewTime]);

  // Sync video preview when active candidate changes
  useEffect(() => {
    if (!activeCandidate || !videoPreviewRef.current) return;
    const video = videoPreviewRef.current;
    video.currentTime = activeCandidate.startTime;
    setPreviewTime(activeCandidate.startTime);
    setIsPlayingPreview(false);
    video.pause();
  }, [activeCandidate?.id]);

  // Handle preview time update to loop candidate bounds
  const handlePreviewTimeUpdate = () => {
    if (!videoPreviewRef.current || !activeCandidate) return;
    const currentTime = videoPreviewRef.current.currentTime;
    setPreviewTime(currentTime);

    if (currentTime >= activeCandidate.endTime) {
      videoPreviewRef.current.currentTime = activeCandidate.startTime;
      setPreviewTime(activeCandidate.startTime);
    }
  };

  const togglePreviewPlay = () => {
    if (!videoPreviewRef.current || !activeCandidate) return;
    const video = videoPreviewRef.current;
    if (isPlayingPreview) {
      video.pause();
      setIsPlayingPreview(false);
    } else {
      if (video.currentTime < activeCandidate.startTime || video.currentTime >= activeCandidate.endTime) {
        video.currentTime = activeCandidate.startTime;
      }
      video.play().then(() => setIsPlayingPreview(true)).catch(() => {});
    }
  };

  if (!isOpen) return null;

  // Minimized Background Mode (Requirement 7)
  if (isMinimized) {
    const isJobActive = job.running || exportJob?.running;
    return (
      <div className="shorts-minimized-floating-banner" role="status" aria-live="polite">
        <div className="shorts-minimized-info">
          {isJobActive && <div className="shorts-spinner-sm" />}
          <div className="shorts-minimized-text">
            <strong>
              {job.running
                ? t("shortsAnalyzingMini", "AI Shorts Studio — Analyzing")
                : exportJob?.running
                  ? t("shortsExportingMini", `Exporting Short (${exportJob.current}/${exportJob.total})`)
                  : t("shortsReadyMini", "AI Shorts Studio")}
            </strong>
            <span className="shorts-minimized-phase">
              {job.running
                ? `${job.phase || "Discovering moments…"} (${Math.round(job.progress)}%)`
                : exportJob?.running
                  ? `${exportJob.title ? `"${exportJob.title}" — ` : ""}${exportJob.phase || "Rendering"} (${Math.round(exportJob.progress)}%)`
                  : t("shortsCandidatesReady", `${candidates.length} candidate moments ready`)}
            </span>
          </div>
        </div>
        <div className="shorts-minimized-actions">
          <button
            type="button"
            className="shorts-btn shorts-btn-ghost-sm"
            onClick={restore}
          >
            {isJobActive ? t("shortsViewProgress", "View Progress") : t("shortsReview", "Review")}
          </button>
          {isJobActive && (
            <button
              type="button"
              className="shorts-btn shorts-btn-ghost-sm shorts-btn-danger-sm"
              onClick={job.running ? cancelAnalysis : cancelExport}
            >
              {t("cancel", "Cancel")}
            </button>
          )}
        </div>
      </div>
    );
  }
  const renderConfigStage = () => (
    <div className="shorts-config-grid">
      {/* Source Video Selection */}
      <div className="shorts-form-group full-width">
        <label className="shorts-form-label">
          <span>{t("shortsSourceVideo", "Source Long-Form Video")}</span>
          <span style={{ fontWeight: "normal", color: "#64748b" }}>
            {activeSource ? `${activeSource.name} (${activeSource.duration.toFixed(1)}s)` : t("shortsNoMediaFound", "No media")}
          </span>
        </label>
        <select
          className="shorts-select"
          value={selectedSourceId || activeSource?.id || ""}
          onChange={(e) => setSelectedSourceId(e.target.value)}
        >
          {availableSources.length ? (
            availableSources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.duration.toFixed(1)}s) {s.isTimelineClip ? "— Timeline" : "— Media Asset"}
              </option>
            ))
          ) : (
            <option value="" disabled>
              {t("shortsNoMediaHint", "No video clips found in project")}
            </option>
          )}
        </select>
      </div>

      {/* Content Type */}
      <div className="shorts-form-group full-width">
        <label className="shorts-form-label">
          {t("shortsContentType", "Content Format")}
        </label>
        <div className="shorts-chips-row">
          {SHORTS_CONTENT_TYPES.map((type) => (
            <button
              key={type.id}
              type="button"
              className={`shorts-chip ${settings.contentType === type.id ? "is-active" : ""}`}
              onClick={() => updateSetting("contentType", type.id)}
              title={type.description}
            >
              {type.label}
            </button>
          ))}
        </div>
      </div>

      {/* Target Aspect Ratio */}
      <div className="shorts-form-group">
        <label className="shorts-form-label">
          {t("shortsAspectRatio", "Output Aspect Ratio")}
        </label>
        <div className="shorts-ratio-cards">
          {SHORTS_ASPECT_RATIOS.map((ratio) => (
            <button
              key={ratio.id}
              type="button"
              className={`shorts-ratio-card ${settings.aspectRatio === ratio.id ? "is-active" : ""}`}
              onClick={() => updateSetting("aspectRatio", ratio.id)}
            >
              {ratio.id === "9:16" ? <DeviceMobile size={18} /> : ratio.id === "1:1" ? <Square size={18} /> : <Monitor size={18} />}
              <span>{ratio.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Target Duration */}
      <div className="shorts-form-group">
        <label className="shorts-form-label">
          {t("shortsDuration", "Target Duration")}
        </label>
        <div className="shorts-chips-row">
          {SHORTS_DURATION_PRESETS.map((dur) => (
            <button
              key={dur.id}
              type="button"
              className={`shorts-chip ${settings.durationPreset === dur.id ? "is-active" : ""}`}
              onClick={() => updateSetting("durationPreset", dur.id)}
            >
              <Clock size={13} style={{ marginRight: 4 }} />
              {dur.label}
            </button>
          ))}
        </div>
      </div>

      {/* Custom Duration Slider */}
      {settings.durationPreset === "custom" && (
        <div className="shorts-form-group full-width" style={{ marginTop: "-0.5rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem", color: "#94a3b8" }}>
            <span>Min: {settings.minDuration}s</span>
            <span>Max: {settings.maxDuration}s</span>
          </div>
          <input
            type="range"
            min="10"
            max="180"
            step="5"
            className="shorts-range-slider"
            value={settings.maxDuration}
            onChange={(e) => updateSetting("customMaxDuration", Number(e.target.value))}
          />
        </div>
      )}

      {/* Number of Candidates */}
      <div className="shorts-form-group">
        <label className="shorts-form-label">
          <span>{t("shortsClipCount", "Number of Candidates")}</span>
          <span style={{ color: "#818cf8" }}>{settings.clipCount} CLIPS</span>
        </label>
        <input
          type="range"
          min="1"
          max="8"
          step="1"
          className="shorts-range-slider"
          value={settings.clipCount}
          onChange={(e) => updateSetting("clipCount", Number(e.target.value))}
        />
      </div>

      {/* Moment Preference */}
      <div className="shorts-form-group">
        <label className="shorts-form-label">
          {t("shortsPreference", "Moment Preference")}
        </label>
        <select
          className="shorts-select"
          value={settings.preference}
          onChange={(e) => updateSetting("preference", e.target.value)}
        >
          {SHORTS_PREFERENCES.map((pref) => (
            <option key={pref.id} value={pref.id}>
              {pref.label} — {pref.description}
            </option>
          ))}
        </select>
      </div>

      {/* Caption Style Preset */}
      <div className="shorts-form-group">
        <label className="shorts-form-label">
          {t("shortsCaptionPreset", "Caption Preset")}
        </label>
        <select
          className="shorts-select"
          value={settings.captionPresetId}
          onChange={(e) => updateSetting("captionPresetId", e.target.value)}
        >
          {BUILTIN_CAPTION_STYLE_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name} ({preset.category})
            </option>
          ))}
        </select>
      </div>

      {/* Framing & Reframing Strategy */}
      <div className="shorts-form-group">
        <label className="shorts-form-label">
          {t("shortsFramingStrategy", "Reframing Strategy")}
        </label>
        <select
          className="shorts-select"
          value={settings.autoReframing}
          onChange={(e) => updateSetting("autoReframing", e.target.value)}
        >
          {SHORTS_FRAMING_MODES.map((mode) => (
            <option key={mode.id} value={mode.id}>
              {mode.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );

  // Render Analyzing Stage
  const renderAnalyzingStage = () => (
    <div className="shorts-analyzing-card">
      <div className="shorts-analyzing-spinner-wrap">
        <div className="shorts-spinner" />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <strong style={{ fontSize: "1.1rem", color: "#f8fafc" }}>
          {t("shortsAnalyzingTitle", "Discovering Engaging Short Moments…")}
        </strong>
        <span className="shorts-analyzing-phase">{job.phase || "Processing video…"}</span>
      </div>
      <div className="shorts-progress-bar-wrap">
        <div className="shorts-progress-bar-fill" style={{ width: `${job.progress}%` }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", maxWidth: 360, marginTop: "0.25rem" }}>
        <span style={{ fontSize: "0.85rem", color: "#64748b" }}>
          {Math.round(job.progress)}% completed
        </span>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button
            type="button"
            className="shorts-btn shorts-btn-ghost-sm"
            onClick={minimize}
          >
            <Minus size={13} />
            {t("shortsBackground", "Run in background")}
          </button>
          <button
            type="button"
            className="shorts-btn shorts-btn-ghost-sm shorts-btn-danger-sm"
            onClick={cancelAnalysis}
          >
            {t("cancel", "Cancel")}
          </button>
        </div>
      </div>
    </div>
  );

  // Render Exporting Stage
  const renderExportingStage = () => (
    <div className="shorts-analyzing-card">
      <div className="shorts-analyzing-spinner-wrap">
        <div className="shorts-spinner" />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <strong style={{ fontSize: "1.1rem", color: "#f8fafc" }}>
          {exportJob.total > 1
            ? t("shortsBatchExportingTitle", `Exporting Shorts (${exportJob.current} of ${exportJob.total})…`)
            : t("shortsExportingTitle", "Rendering AI Short Video…")}
        </strong>
        <span className="shorts-analyzing-phase">
          {exportJob.title ? `"${exportJob.title}" — ` : ""}
          {exportJob.phase || "Rendering video frames…"}
        </span>
      </div>
      <div className="shorts-progress-bar-wrap">
        <div className="shorts-progress-bar-fill" style={{ width: `${exportJob.progress}%` }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", maxWidth: 360, marginTop: "0.25rem" }}>
        <span style={{ fontSize: "0.85rem", color: "#64748b" }}>
          {Math.round(exportJob.progress)}% completed
        </span>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button
            type="button"
            className="shorts-btn shorts-btn-ghost-sm"
            onClick={minimize}
          >
            <Minus size={13} />
            {t("shortsBackground", "Run in background")}
          </button>
          <button
            type="button"
            className="shorts-btn shorts-btn-ghost-sm shorts-btn-danger-sm"
            onClick={cancelExport}
          >
            {t("cancel", "Cancel")}
          </button>
        </div>
      </div>
    </div>
  );

  // Render Suggested Shorts Workspace (Phase 4)
  const renderReviewStage = () => (
    <div className="shorts-workspace-layout">
      {/* Left Column: Candidate Moments List */}
      <div className="shorts-queue-column">
        <div className="shorts-queue-header">
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <FilmSlate size={18} color="#818cf8" />
            <strong>{candidates.length} {t("shortsDiscoveredMoments", "Suggested Moments")}</strong>
          </div>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              type="button"
              className="shorts-btn shorts-btn-ghost-sm"
              onClick={selectedCandidateIds.size === candidates.length ? deselectAllCandidates : selectAllCandidates}
            >
              {selectedCandidateIds.size === candidates.length ? t("deselectAll", "Deselect") : t("selectAll", "Select All")}
            </button>
            <button
              type="button"
              className="shorts-btn shorts-btn-ghost-sm"
              onClick={() => setStage("configure")}
            >
              <SlidersHorizontal size={14} />
              {t("settings", "Settings")}
            </button>
          </div>
        </div>

        <div className="shorts-queue-list">
          {candidates.map((candidate, idx) => {
            const isSelected = selectedCandidateIds.has(candidate.id);
            const isActive = activeCandidate?.id === candidate.id;
            const scoreClass = candidate.score >= 80 ? "shorts-score-high" : "shorts-score-mid";

            return (
              <div
                key={candidate.id}
                className={`shorts-queue-card ${isActive ? "is-active" : ""}`}
                onClick={() => setActiveCandidateId(candidate.id)}
              >
                <div className="shorts-queue-card-top">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelectCandidate(candidate.id)}
                    aria-label="Select short for export"
                    onClick={(e) => e.stopPropagation()}
                  />
                  <div className="shorts-queue-card-heading">
                    <span className="shorts-queue-card-title">{candidate.title}</span>
                    <div className="shorts-queue-card-badges">
                      <span className={`shorts-score-badge ${scoreClass}`}>★ {candidate.score}</span>
                      <span className="shorts-category-badge">{candidate.category}</span>
                      <span className="shorts-time-badge">⏱ {candidate.duration.toFixed(1)}s</span>
                    </div>
                  </div>
                </div>

                <div className="shorts-queue-card-reason">
                  💡 {candidate.reason}
                </div>

                {candidate.warnings?.length > 0 && (
                  <div className="shorts-queue-card-warning">
                    <WarningCircle size={13} />
                    <span>{candidate.warnings[0]}</span>
                  </div>
                )}

                {["smart-subject", "smart-zoom"].includes(candidate.framingMode || settings.autoReframing) && (
                  candidate.trackingStatus === "analyzing" ? (
                    <div className="shorts-queue-card-status analyzing" style={{ background: "rgba(99, 102, 241, 0.08)", borderColor: "rgba(99, 102, 241, 0.2)", color: "#a5b4fc", display: "flex", alignItems: "center", gap: "0.35rem", fontSize: "0.74rem", padding: "0.25rem 0.5rem", borderRadius: "6px", marginTop: "0.35rem" }}>
                      <div className="shorts-spinner-sm" style={{ width: 10, height: 10 }} />
                      <span>{t("shortsTrackingAnalyzingCard", "Analyzing subject…")}</span>
                    </div>
                  ) : (
                    isCandidateSmartFrameFallback(candidate.smartFrame, candidate) ||
                    candidate.trackingStatus === "no_subjects_found" ||
                    candidate.trackingStatus === "error" ||
                    candidate.trackingStatus === "fallback" ||
                    isCandidateFallbackDueToMissingDetections(candidate)
                  ) ? (
                    <div className="shorts-queue-card-warning" style={{ background: "rgba(245, 158, 11, 0.08)", borderColor: "rgba(245, 158, 11, 0.2)" }}>
                      <WarningCircle size={13} />
                      <span>{candidate.trackingStatus === "no_subjects_found" ? t("shortsNoSubjectsCard", "No subject found (Centered)") : t("shortsTrackingFallbackCard", "Tracking fallback (Centered)")}</span>
                    </div>
                  ) : candidate.trackingStatus === "tracked" ? (
                    <div className="shorts-queue-card-status tracked" style={{ background: "rgba(16, 185, 129, 0.08)", borderColor: "rgba(16, 185, 129, 0.2)", color: "#34d399", display: "flex", alignItems: "center", gap: "0.35rem", fontSize: "0.74rem", padding: "0.25rem 0.5rem", borderRadius: "6px", marginTop: "0.35rem" }}>
                      <UserFocus size={13} />
                      <span>{t("shortsTrackingActiveCard", "AI Subject Tracked")}</span>
                    </div>
                  ) : null
                )}

                <div className="shorts-queue-card-footer">
                  <span style={{ fontSize: "0.78rem", color: "#64748b" }}>
                    {candidate.startTime.toFixed(1)}s → {candidate.endTime.toFixed(1)}s
                  </span>
                  <div style={{ display: "flex", gap: "0.3rem" }}>
                    <button
                      type="button"
                      className="shorts-btn-icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        applyCandidateToTimeline(candidate);
                      }}
                      title="Load into Timeline"
                    >
                      <MagicWand size={14} />
                    </button>
                    <button
                      type="button"
                      className="shorts-btn-icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeCandidate(candidate.id);
                      }}
                      title="Dismiss"
                    >
                      <Trash size={14} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Right Column: Interactive Candidate Studio & Live Reframing */}
      {activeCandidate && (
        <div className="shorts-preview-studio-column">
          <div className="shorts-studio-preview-card">
            {/* Aspect Ratio Phone/Window Bezel */}
            <div className={`shorts-preview-bezel ratio-${(activeCandidate.aspectRatio || settings.aspectRatio).replace(":", "-")}`}>
              {activeSource?.src ? (
                <video
                  ref={videoPreviewRef}
                  src={activeSource.src}
                  playsInline
                  crossOrigin="anonymous"
                  onTimeUpdate={handlePreviewTimeUpdate}
                  className="shorts-preview-video"
                  style={{
                    objectFit: activeCandidate.framingMode === "safe-contain" ? "contain" : "cover",
                    objectPosition: activeCandidate.framingMode === "safe-contain"
                      ? "50% 50%"
                      : `${((currentPreviewPanFactor ?? activeCandidate.cropX ?? 0.5) * 100).toFixed(1)}% 50%`,
                  }}
                />
              ) : (
                <div className="shorts-preview-placeholder">
                  <FilmSlate size={36} color="#64748b" />
                  <span>Media Preview</span>
                </div>
              )}

              {/* Subject Tracking Mode Indicator Pill */}
              {isSubjectTracking && (
                <div
                  className={`shorts-preview-status-pill ${
                    isAnalyzingTarget ? "analyzing" : (isFallbackTrack ? "fallback" : "tracked")
                  }`}
                  role="status"
                  aria-label="Tracking state"
                >
                  {isAnalyzingTarget ? (
                    <>
                      <div className="shorts-spinner-sm" style={{ width: 10, height: 10 }} />
                      <span>{t("shortsTrackingAnalyzingPill", "Tracking Subject…")}</span>
                    </>
                  ) : isFallbackTrack ? (
                    <>
                      <WarningCircle size={12} color="#fbbf24" />
                      <span>{t("shortsTrackingFallbackPill", "Centered Fallback")}</span>
                    </>
                  ) : (
                    <>
                      <UserFocus size={12} color="#34d399" />
                      <span>{t("shortsTrackingActivePill", "Subject Tracked")}</span>
                    </>
                  )}
                </div>
              )}

              {/* Playback Overlay Controls */}
              <div className="shorts-preview-playback-overlay">
                <button
                  type="button"
                  className="shorts-preview-play-btn"
                  onClick={togglePreviewPlay}
                  aria-label={isPlayingPreview ? "Pause" : "Play"}
                >
                  {isPlayingPreview ? <Pause size={20} weight="fill" /> : <Play size={20} weight="fill" />}
                </button>
                <div className="shorts-preview-time-chip">
                  {Math.max(0, previewTime - activeCandidate.startTime).toFixed(1)}s / {activeCandidate.duration.toFixed(1)}s
                </div>
              </div>

              {/* In-Frame Live Caption Excerpt Overlay */}
              {activeCandidate.transcriptExcerpt && (
                <div className="shorts-preview-caption-bubble">
                  {activeCandidate.transcriptExcerpt}
                </div>
              )}
            </div>

            {/* Candidate Controls & Framing Studio */}
            <div className="shorts-candidate-editor-pane">
              {/* Title & Category Editor */}
              <div className="shorts-form-group">
                <label className="shorts-form-label">{t("candidateTitle", "Short Title & Hook")}</label>
                <input
                  type="text"
                  className="shorts-candidate-title-input"
                  value={activeCandidate.title}
                  onChange={(e) => updateCandidate(activeCandidate.id, { title: e.target.value })}
                />
              </div>

              {/* Per-Candidate Aspect Ratio Selector */}
              <div className="shorts-form-group">
                <label className="shorts-form-label">
                  <span>{t("shortsAspectRatio", "Target Aspect Ratio")}</span>
                  <span style={{ color: "#a5b4fc", fontSize: "0.8rem" }}>
                    {activeCandidate.aspectRatio || settings.aspectRatio}
                  </span>
                </label>
                <div className="shorts-ratio-cards" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
                  {SHORTS_ASPECT_RATIOS.map((ratio) => (
                    <button
                      key={ratio.id}
                      type="button"
                      className={`shorts-ratio-card ${(activeCandidate.aspectRatio || settings.aspectRatio) === ratio.id ? "is-active" : ""}`}
                      onClick={() => {
                        updateCandidate(activeCandidate.id, { aspectRatio: ratio.id });
                        updateSetting("aspectRatio", ratio.id);
                      }}
                    >
                      {ratio.id === "9:16" ? <DeviceMobile size={16} /> : ratio.id === "1:1" ? <Square size={16} /> : <Monitor size={16} />}
                      <span style={{ fontSize: "0.78rem" }}>{ratio.id}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Live Framing Mode Selector */}
              <div className="shorts-form-group">
                <label className="shorts-form-label">
                  <span>{t("shortsFramingMode", "Framing Strategy")}</span>
                  <span
                    style={{
                      color: showSubjectFallbackWarning ? "#fbbf24" : "#a5b4fc",
                      fontSize: "0.8rem",
                      fontWeight: showSubjectFallbackWarning ? 600 : 500,
                    }}
                  >
                    {activeCandidate.framingMode || settings.autoReframing}
                    {showSubjectFallbackWarning && " (Fallback — Center)"}
                  </span>
                </label>
                <div className="shorts-framing-chips">
                  {SHORTS_FRAMING_MODES.map((mode) => (
                    <button
                      key={mode.id}
                      type="button"
                      className={`shorts-framing-chip ${(activeCandidate.framingMode || settings.autoReframing) === mode.id ? "is-active" : ""}`}
                      onClick={() => {
                        updateCandidate(activeCandidate.id, { framingMode: mode.id });
                        updateSetting("autoReframing", mode.id);
                      }}
                      title={mode.description}
                    >
                      {mode.id === "smart-subject" && <UserFocus size={14} />}
                      {mode.id === "smart-zoom" && <MagnifyingGlassPlus size={14} />}
                      {mode.id === "center" && <Crop size={14} />}
                      {mode.id === "safe-contain" && <FrameCorners size={14} />}
                      <span>{mode.label}</span>
                    </button>
                  ))}
                </div>

                {/* Targeted Subject Analysis In-Flight State */}
                {isAnalyzingTarget && (
                  <div className="shorts-tracking-status-banner" role="status">
                    <div className="shorts-spinner-sm" style={{ width: 14, height: 14 }} />
                    <span>{t("shortsAnalyzingClipSubjects", "Analyzing clip for subjects…")}</span>
                  </div>
                )}

                {/* Visible Fallback Warning Banner when Subject Tracking cannot establish real tracking */}
                {showSubjectFallbackWarning && (
                  <div className="shorts-fallback-warning-banner" role="alert">
                    <WarningCircle size={16} color="#fbbf24" style={{ flexShrink: 0 }} />
                    <div className="shorts-fallback-warning-content">
                      <span className="shorts-fallback-warning-title">
                        {activeCandidate.trackingStatus === "unsupported"
                          ? t("shortsTrackingUnsupported", "Subject tracking unavailable in this browser")
                          : activeCandidate.trackingStatus === "no_subjects_found"
                            ? t("shortsNoSubjectsFound", "No subjects detected in this clip")
                            : activeCandidate.trackingStatus === "error"
                              ? t("shortsTrackingError", "Subject detection failed")
                              : t("shortsSubjectFallback", "Subject tracking unavailable — using centered fallback")}
                      </span>
                      <span className="shorts-fallback-warning-desc">
                        {activeCandidate.trackingStatus === "no_subjects_found"
                          ? t("shortsNoSubjectsDesc", "Using centered framing. Adjust horizontal framing using the Pan slider below.")
                          : t("shortsFallbackDesc", "Using centered framing. You can retry analysis or adjust framing with the Pan slider below.")}
                      </span>
                    </div>
                    {retryCandidateAnalysis && activeCandidate.trackingStatus !== "unsupported" && (
                      <button
                        type="button"
                        className="shorts-btn-icon"
                        onClick={() => retryCandidateAnalysis(activeCandidate.id)}
                        title={t("retrySubjectAnalysis", "Retry Subject Analysis")}
                        aria-label="Retry Subject Analysis"
                      >
                        <ArrowCounterClockwise size={14} />
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Horizontal Crop Pan Control */}
              <div className="shorts-form-group">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <label className="shorts-form-label">{t("shortsPanPosition", "Horizontal Pan Offset")}</label>
                  <div style={{ display: "flex", gap: "0.3rem" }}>
                    <button
                      type="button"
                      className="shorts-quick-pan-btn"
                      onClick={() => updateCandidate(activeCandidate.id, { cropX: 0.2 })}
                    >
                      Left
                    </button>
                    <button
                      type="button"
                      className="shorts-quick-pan-btn"
                      onClick={() => updateCandidate(activeCandidate.id, { cropX: 0.5 })}
                    >
                      Center
                    </button>
                    <button
                      type="button"
                      className="shorts-quick-pan-btn"
                      onClick={() => updateCandidate(activeCandidate.id, { cropX: 0.8 })}
                    >
                      Right
                    </button>
                  </div>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  className="shorts-range-slider"
                  value={activeCandidate.cropX ?? 0.5}
                  onChange={(e) => updateCandidate(activeCandidate.id, { cropX: Number(e.target.value) })}
                />
              </div>

              {/* Boundary Trimming Controls */}
              <div className="shorts-timing-editor-grid">
                <div className="shorts-form-group">
                  <label className="shorts-form-label">Start Time (s)</label>
                  <div className="shorts-nudge-input-wrap">
                    <button
                      type="button"
                      className="shorts-nudge-btn"
                      onClick={() => updateCandidate(activeCandidate.id, { startTime: Math.max(0, activeCandidate.startTime - 0.5) })}
                    >
                      -0.5
                    </button>
                    <input
                      type="number"
                      step="0.5"
                      min="0"
                      className="shorts-time-input"
                      value={activeCandidate.startTime}
                      onChange={(e) => updateCandidate(activeCandidate.id, { startTime: Number(e.target.value) })}
                    />
                    <button
                      type="button"
                      className="shorts-nudge-btn"
                      onClick={() => updateCandidate(activeCandidate.id, { startTime: Math.min(activeCandidate.endTime - 3, activeCandidate.startTime + 0.5) })}
                    >
                      +0.5
                    </button>
                  </div>
                </div>

                <div className="shorts-form-group">
                  <label className="shorts-form-label">End Time (s)</label>
                  <div className="shorts-nudge-input-wrap">
                    <button
                      type="button"
                      className="shorts-nudge-btn"
                      onClick={() => updateCandidate(activeCandidate.id, { endTime: Math.max(activeCandidate.startTime + 3, activeCandidate.endTime - 0.5) })}
                    >
                      -0.5
                    </button>
                    <input
                      type="number"
                      step="0.5"
                      min={activeCandidate.startTime + 3}
                      max={activeSource ? activeSource.duration : 9999}
                      className="shorts-time-input"
                      value={activeCandidate.endTime}
                      onChange={(e) => updateCandidate(activeCandidate.id, { endTime: Number(e.target.value) })}
                    />
                    <button
                      type="button"
                      className="shorts-nudge-btn"
                      onClick={() => updateCandidate(activeCandidate.id, { endTime: Math.min(activeSource ? activeSource.duration : 9999, activeCandidate.endTime + 0.5) })}
                    >
                      +0.5
                    </button>
                  </div>
                </div>
              </div>

              {/* Primary Candidate Action Buttons */}
              <div className="shorts-candidate-actions-row">
                <button
                  type="button"
                  className="shorts-btn shorts-btn-primary"
                  onClick={() => exportCandidate(activeCandidate)}
                >
                  <DownloadSimple size={16} />
                  {t("shortsExportThis", "Export Video")}
                </button>
                <button
                  type="button"
                  className="shorts-btn shorts-btn-secondary"
                  onClick={() => exportCandidateTimeline && exportCandidateTimeline(activeCandidate)}
                  title={t("shortsExportTimelineHint", "Export editable multi-track timeline package (.timeline, OTIO, FCPXML)")}
                >
                  <DownloadSimple size={16} />
                  {t("shortsExportTimeline", "Export Timeline Package")}
                </button>
                <button
                  type="button"
                  className="shorts-btn shorts-btn-secondary"
                  onClick={() => applyCandidateToTimeline(activeCandidate)}
                >
                  <MagicWand size={16} />
                  {t("shortsLoadTimeline", "Edit in Timeline")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="shorts-studio-backdrop" onClick={close}>
      <div
        className="shorts-studio-window"
        role="dialog"
        aria-modal="true"
        aria-label="AI Shorts Studio"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="shorts-studio-header">
          <div className="shorts-studio-title-wrap">
            <span className="shorts-studio-badge">
              <Sparkle size={14} weight="fill" />
              AI Studio
            </span>
            <h2>{t("shortsStudioTitle", "AI Shorts Studio")}</h2>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
            <button
              type="button"
              className="shorts-studio-header-btn"
              onClick={minimize}
              aria-label={t("minimize", "Minimize")}
              title={t("shortsMinimizeHint", "Minimize to background")}
            >
              <Minus size={18} />
            </button>
            <button
              type="button"
              className="shorts-studio-close-btn"
              onClick={close}
              aria-label="Close"
            >
              <X size={20} />
            </button>
          </div>
        </header>

        <div className="shorts-studio-content">
          {error && <div className="shorts-error-banner">{error}</div>}
          {stage === "configure" && renderConfigStage()}
          {stage === "analyzing" && renderAnalyzingStage()}
          {stage === "review" && renderReviewStage()}
          {stage === "exporting" && renderExportingStage()}
        </div>

        {/* Timeline Replacement Confirmation Modal (Fix 3) */}
        {pendingTimelineCandidate && (
          <div className="shorts-confirm-overlay" role="alertdialog" aria-modal="true">
            <div className="shorts-confirm-card">
              <div className="shorts-confirm-header">
                <WarningCircle size={24} color="#f59e0b" weight="fill" />
                <h3>{t("shortsConfirmTimelineTitle", "Replace Timeline Content?")}</h3>
              </div>
              <p className="shorts-confirm-message">
                {t(
                  "shortsConfirmTimelineMsg",
                  `Loading "${pendingTimelineCandidate.title}" will replace the existing clips on your timeline. You can undo this change with Undo (Ctrl+Z) in the editor.`
                )}
              </p>
              <div className="shorts-confirm-actions">
                <button
                  type="button"
                  className="shorts-btn shorts-btn-ghost"
                  onClick={cancelApplyCandidateToTimeline}
                >
                  {t("cancel", "Cancel")}
                </button>
                <button
                  type="button"
                  className="shorts-btn shorts-btn-danger"
                  onClick={() => confirmApplyCandidateToTimeline(pendingTimelineCandidate)}
                >
                  <Check size={16} />
                  {t("shortsConfirmReplace", "Replace Timeline")}
                </button>
              </div>
            </div>
          </div>
        )}

        <footer className="shorts-studio-footer">
          <div>
            {stage === "review" && (
              <button
                type="button"
                className="shorts-btn shorts-btn-ghost"
                onClick={startAnalysis}
              >
                <ArrowCounterClockwise size={15} />
                {t("shortsReanalyze", "Re-discover Moments")}
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: "0.75rem" }}>
            <button
              type="button"
              className="shorts-btn shorts-btn-ghost"
              onClick={close}
            >
              {t("cancel", "Close")}
            </button>
            {stage === "configure" && (
              <button
                type="button"
                className="shorts-btn shorts-btn-primary"
                onClick={startAnalysis}
                disabled={!activeSource}
              >
                <Sparkle size={16} weight="fill" />
                {t("shortsStartDiscovery", "Find Shorts Moments")}
              </button>
            )}
            {stage === "review" && selectedCandidateIds.size > 0 && (
              <button
                type="button"
                className="shorts-btn shorts-btn-primary"
                onClick={exportSelectedCandidates}
              >
                <DownloadSimple size={16} />
                {t("shortsExportSelected", `Export Selected (${selectedCandidateIds.size})`)}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
