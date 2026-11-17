import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  CaretLeft,
  CaretRight,
  Check,
  CheckCircle,
  ClosedCaptioning,
  Minus,
  Pause,
  Play,
  Scissors,
  Sparkle,
  WarningCircle,
  Waveform,
  X,
} from "@phosphor-icons/react";
import { formatTime } from "../lib/timeline.js";
import "./SmartPipelineModal.css";
import { workflowTranscriptionStatus } from "../lib/workflowTranscription.js";

const STAGES = [
  { id: "select", labelKey: "smartPipelineStepSelect" },
  { id: "analyzing", labelKey: "smartPipelineStepAnalyze" },
  { id: "captions", labelKey: "smartPipelineStepCaptions" },
  { id: "cuts", labelKey: "smartPipelineStepCuts" },
  { id: "review", labelKey: "smartPipelineStepReview" },
];

export function SmartPipelineModal({
  isOpen,
  pipeline,
  visualSegments = [],
  t = (key, fallback) => fallback || key,
}) {
  const [filterType, setFilterType] = useState("all"); // "all" | "pause" | "filler"
  const transcriptionStatus = workflowTranscriptionStatus(pipeline.job) || workflowTranscriptionStatus(pipeline.plan);

  // Keyboard shortcut: Escape to close / cancel
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        if (pipeline.job.running) {
          pipeline.cancel();
        } else {
          pipeline.close();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, pipeline]);

  if (!isOpen) return null;

  const {
    stage,
    setStage,
    activeClip,
    selectedClipId,
    setSelectedClipId,
    isSupported,
    settings,
    updateSettings,
    includeCaptions,
    setIncludeCaptions,
    includeCuts,
    setIncludeCuts,
    captionGrouping,
    updateCaptionGrouping,
    job,
    error,
    plan,
    close,
    cancel,
    isMinimized,
    minimize,
    restore,
    startAnalysis,
    toggleCut,
    toggleAllCuts,
    updateCaptionSegment,
    previewCut,
    previewCaption,
    apply,
  } = pipeline;

  const candidates = plan?.candidates || [];
  const captionSegments = plan?.captionSegments || [];
  const metrics = plan?.metrics || {
    originalDuration: activeClip?.duration || 0,
    projectedDuration: activeClip?.duration || 0,
    timeSaved: 0,
    percentageReduced: 0,
    totalCutsCount: 0,
    enabledCutsCount: 0,
    pauseCount: 0,
    fillerCount: 0,
    captionCount: 0,
  };

  const filteredCandidates = candidates.filter((cut) => {
    if (filterType === "pause") return cut.type === "pause" || cut.type === "merged";
    if (filterType === "filler") return cut.type === "filler";
    return true;
  });

  const getStageIndex = (s) => STAGES.findIndex((item) => item.id === s);
  const currentStageIdx = getStageIndex(stage);

  // Minimized Background Mode
  if (isMinimized) {
    const isJobActive = job.running;
    return createPortal(
      <aside
        className="smart-pipeline-minimized-floating-banner"
        role="status"
        aria-live="polite"
        data-testid="smart-pipeline-minimized-banner"
      >
        <div
          className="smart-pipeline-minimized-info"
          onClick={restore}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              restore();
            }
          }}
          title={t("smartPipelineRestoreTooltip", "Restore Smart Editing Pipeline modal")}
        >
          {isJobActive && <div className="smart-pipeline-mini-spinner" />}
          <div className="smart-pipeline-minimized-text">
            <strong>
              {job.running
                ? t("smartPipelineStepAnalyze", "Smart Editing Pipeline — Analyzing")
                : plan
                  ? t("smartPipelineReadyMini", "Smart Editing Pipeline")
                  : t("smartPipelineTitle", "Smart Editing Pipeline")}
            </strong>
            <span className="smart-pipeline-minimized-phase">
              {job.running
                ? `${t(job.phase || "smartPipelineStepAnalyze", job.phase || "Analyzing footage…")} (${Math.round(job.progress)}%)`
                : plan
                  ? t("smartPipelineCandidatesReady", `${candidates.length} candidates ready • ${captionSegments.length} captions`)
                  : error
                    ? t(error, error)
                    : t("smartPipelineComplete", "Analysis complete")}
            </span>
            {transcriptionStatus && <span role="status" aria-live="polite">{transcriptionStatus}</span>}
          </div>
        </div>
        <div className="smart-pipeline-minimized-actions">
          <button
            type="button"
            className="smart-pipeline-mini-btn smart-pipeline-mini-btn-primary"
            onClick={restore}
            data-testid="smart-pipeline-restore-btn"
            title={t("smartPipelineRestoreTooltip", "Restore Smart Editing Pipeline modal")}
          >
            {isJobActive ? t("smartPipelineViewProgress", "View Progress") : t("smartPipelineReview", "Review")}
          </button>
          {isJobActive ? (
            <button
              type="button"
              className="smart-pipeline-mini-btn smart-pipeline-mini-btn-danger"
              onClick={cancel}
              data-testid="smart-pipeline-minimized-cancel-btn"
            >
              {t("smartPipelineCancel", "Cancel")}
            </button>
          ) : (
            <button
              type="button"
              className="smart-pipeline-mini-btn smart-pipeline-mini-btn-ghost"
              onClick={close}
              data-testid="smart-pipeline-minimized-close-btn"
            >
              {t("smartPipelineClose", "Close")}
            </button>
          )}
        </div>
      </aside>,
      document.body
    );
  }

  return createPortal(
    <div
      className="smart-pipeline-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="smart-pipeline-title"
      data-testid="smart-pipeline-modal"
    >
      <div className="smart-pipeline-container">
        {/* Modal Header */}
        <header className="smart-pipeline-header">
          <div className="smart-pipeline-title-group">
            <div className="smart-pipeline-title-row">
              <Sparkle size={20} weight="fill" className="smart-pipeline-icon" />
              <h2 id="smart-pipeline-title">{t("smartPipelineTitle", "Smart Editing Pipeline")}</h2>
            </div>
            <p className="smart-pipeline-subtitle">
              {t("smartPipelineHint", "Guided end-to-end AI speech, pauses, cuts, and captions")}
            </p>
          </div>
          <div className="smart-pipeline-header-actions">
            <button
              type="button"
              className="smart-pipeline-header-btn smart-pipeline-minimize-btn"
              onClick={minimize}
              aria-label={t("smartPipelineMinimize", "Minimize")}
              title={t("smartPipelineRestoreTooltip", "Minimize pipeline (continues processing in background)")}
              data-testid="smart-pipeline-minimize-btn"
            >
              <Minus size={18} />
            </button>
            <button
              type="button"
              className="smart-pipeline-close-btn"
              onClick={close}
              aria-label={t("smartPipelineClose", "Close")}
              data-testid="smart-pipeline-close-btn"
            >
              <X size={18} />
            </button>
          </div>
        </header>

        {/* Stepper Navigation */}
        {stage !== "applied" && (
          <nav className="smart-pipeline-stepper" aria-label="Pipeline Stages">
            {STAGES.map((step, idx) => {
              const isPast = idx < currentStageIdx;
              const isCurrent = idx === currentStageIdx;
              const isClickable = plan && !job.running && idx > 1;

              return (
                <div
                  key={step.id}
                  className={`smart-pipeline-step ${isCurrent ? "is-current" : ""} ${isPast ? "is-past" : ""} ${isClickable ? "is-navigable" : ""}`}
                  onClick={() => {
                    if (isClickable) setStage(step.id);
                  }}
                  role={isClickable ? "button" : "presentation"}
                >
                  <span className="smart-pipeline-step-number">
                    {isPast ? <Check size={12} weight="bold" /> : idx + 1}
                  </span>
                  <span className="smart-pipeline-step-label">
                    {t(step.labelKey, step.id)}
                  </span>
                </div>
              );
            })}
          </nav>
        )}

        {transcriptionStatus && <p role="status" aria-live="polite">{transcriptionStatus}</p>}
        {/* Error Banner */}
        {error && (
          <div className="smart-pipeline-error-banner" role="alert">
            <WarningCircle size={18} weight="fill" />
            <span>{t(error, error)}</span>
          </div>
        )}

        {/* Stage Content */}
        <div className="smart-pipeline-body">
          {/* STAGE 1: SELECT FOOTAGE & SETTINGS */}
          {stage === "select" && (
            <div className="smart-pipeline-stage smart-pipeline-select-stage">
              <div className="smart-pipeline-section">
                <label className="smart-pipeline-section-title" htmlFor="clip-selector">
                  {t("smartPipelineSelectClip", "Target Video Clip")}
                </label>
                <div className="smart-pipeline-clip-selector-row">
                  <select
                    id="clip-selector"
                    className="smart-pipeline-select"
                    value={selectedClipId || activeClip?.id || ""}
                    onChange={(e) => setSelectedClipId(e.target.value)}
                    data-testid="smart-pipeline-clip-select"
                  >
                    {visualSegments.map((clip, i) => (
                      <option key={clip.id} value={clip.id}>
                        {clip.name || `Clip ${i + 1}`} ({formatTime(clip.duration)})
                      </option>
                    ))}
                  </select>
                  <div className="smart-pipeline-clip-meta">
                    <span>{formatTime(activeClip?.duration || 0)}</span>
                    {!isSupported && (
                      <span className="smart-pipeline-unsupported-tag">
                        {activeClip?.type !== "video"
                          ? t("smartPipelineRequiresVideo", "Requires Video Clip")
                          : t("smartPipelineClipUnsupported", "Not Trimmable")}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="smart-pipeline-section">
                <h3 className="smart-pipeline-section-title">
                  {t("smartPipelineOptionsTitle", "Pipeline Analysis Options")}
                </h3>
                <div className="smart-pipeline-options-grid">
                  {/* Captions Toggle */}
                  <label className="smart-pipeline-toggle-card">
                    <input
                      type="checkbox"
                      checked={settings.generateCaptions}
                      onChange={(e) => updateSettings({ generateCaptions: e.target.checked })}
                      data-testid="smart-pipeline-opt-captions"
                    />
                    <div className="smart-pipeline-toggle-info">
                      <div className="smart-pipeline-toggle-header">
                        <ClosedCaptioning size={18} weight="duotone" />
                        <strong>{t("smartPipelineOptCaptions", "Speech Recognition & Captions")}</strong>
                      </div>
                      <p>Transcribe spoken dialogue into aligned, editable captions.</p>
                    </div>
                  </label>

                  {/* Filler Words Toggle */}
                  <label className="smart-pipeline-toggle-card">
                    <input
                      type="checkbox"
                      checked={settings.removeFillerWords}
                      onChange={(e) => updateSettings({ removeFillerWords: e.target.checked })}
                      data-testid="smart-pipeline-opt-fillers"
                    />
                    <div className="smart-pipeline-toggle-info">
                      <div className="smart-pipeline-toggle-header">
                        <Scissors size={18} weight="duotone" />
                        <strong>{t("smartPipelineOptFillers", "Detect Filler Words")}</strong>
                      </div>
                      <p>Identify hesitation tokens (um, uh, er, etc.) from transcript timestamps.</p>
                    </div>
                  </label>

                  {/* Pause Detection Settings */}
                  <div className="smart-pipeline-slider-card">
                    <div className="smart-pipeline-slider-header">
                      <Waveform size={18} weight="duotone" />
                      <strong>{t("smartPipelineMinPause", "Minimum Pause Length")}</strong>
                      <span>{settings.minimum}s</span>
                    </div>
                    <input
                      type="range"
                      min="0.3"
                      max="2.5"
                      step="0.1"
                      value={settings.minimum}
                      onChange={(e) => updateSettings({ minimum: parseFloat(e.target.value) })}
                    />
                  </div>

                  {/* Speech Padding */}
                  <div className="smart-pipeline-slider-card">
                    <div className="smart-pipeline-slider-header">
                      <Waveform size={18} weight="duotone" />
                      <strong>{t("smartPipelineKeepMargin", "Speech Padding / Keep Margin")}</strong>
                      <span>{settings.keep}s</span>
                    </div>
                    <input
                      type="range"
                      min="0.1"
                      max="1.0"
                      step="0.05"
                      value={settings.keep}
                      onChange={(e) => updateSettings({ keep: parseFloat(e.target.value) })}
                    />
                  </div>
                </div>

                {/* Multi-Track Ripple */}
                <label className="smart-pipeline-checkbox-row">
                  <input
                    type="checkbox"
                    checked={Boolean(pipeline.rippleEditing)}
                    onChange={(e) => {
                      updateSettings({ rippleEditing: e.target.checked });
                      pipeline.setRippleEditing?.(e.target.checked);
                    }}
                    data-testid="smart-pipeline-opt-ripple"
                  />
                  <span>
                    {t(
                      "smartPipelineOptRipple",
                      "Ripple Multi-Track Timeline (Audio, Overlays, Stickers)"
                    )}
                  </span>
                </label>
              </div>
            </div>
          )}

          {/* STAGE 2: ANALYZING PROGRESS */}
          {stage === "analyzing" && (
            <div className="smart-pipeline-stage smart-pipeline-analyzing-stage">
              <div className="smart-pipeline-progress-box">
                <div className="smart-pipeline-spinner-ring">
                  <Sparkle size={32} weight="fill" className="smart-pipeline-pulsing-icon" />
                </div>
                <h3>{t(job.phase || "smartPipelineStepAnalyze", "Analyzing Footage...")}</h3>
                <div className="smart-pipeline-progress-bar-wrap">
                  <div
                    className="smart-pipeline-progress-bar"
                    style={{ width: `${Math.max(5, job.progress)}%` }}
                  />
                </div>
                <span className="smart-pipeline-progress-pct">{job.progress}%</span>
                <p className="smart-pipeline-progress-hint">
                  {t(
                    "smartPipelineAnalyzingHint",
                    "Pause detection runs on this device. Speech transcription defaults to Ollalink Cloud (uploads audio), with Local Whisper on this device as an alternative. You can minimize this window while it runs."
                  )}
                </p>
                <div className="smart-pipeline-analyzing-actions">
                  <button
                    type="button"
                    className="smart-pipeline-minimize-action-btn"
                    onClick={minimize}
                    data-testid="smart-pipeline-analyzing-minimize-btn"
                  >
                    <Minus size={14} />
                    {t("smartPipelineMinimize", "Minimize to Background")}
                  </button>
                  <button
                    type="button"
                    className="smart-pipeline-cancel-btn"
                    onClick={cancel}
                    data-testid="smart-pipeline-cancel-btn"
                  >
                    {t("smartPipelineCancel", "Cancel Analysis")}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* STAGE 3: REVIEW CAPTIONS */}
          {stage === "captions" && (
            <div className="smart-pipeline-stage smart-pipeline-captions-stage">
              <div className="smart-pipeline-toolbar">
                <div className="smart-pipeline-toolbar-left">
                  <label className="smart-pipeline-checkbox-row">
                    <input
                      type="checkbox"
                      checked={includeCaptions}
                      onChange={(e) => setIncludeCaptions(e.target.checked)}
                      data-testid="smart-pipeline-include-captions"
                    />
                    <strong>
                      {t("smartPipelineIncludeCaptions", "Include Captions in Timeline")}
                    </strong>
                  </label>
                  <span className="smart-pipeline-count-pill">
                    {captionSegments.length} {t("smartPipelineCaptionsCount", "captions")}
                  </span>
                </div>

                <div className="smart-pipeline-toolbar-right">
                  <label htmlFor="caption-grouping-select">
                    {t("smartPipelineRegroup", "Grouping:")}
                  </label>
                  <select
                    id="caption-grouping-select"
                    className="smart-pipeline-select-compact"
                    value={captionGrouping}
                    onChange={(e) => updateCaptionGrouping(e.target.value)}
                  >
                    <option value="phrases">
                      {t("smartPipelineGroupingPhrases", "Natural Phrases")}
                    </option>
                    <option value="sentences">
                      {t("smartPipelineGroupingSentences", "Full Sentences")}
                    </option>
                    <option value="words">
                      {t("smartPipelineGroupingWords", "Short Phrases")}
                    </option>
                  </select>
                </div>
              </div>

              <div className="smart-pipeline-caption-list" data-testid="smart-pipeline-caption-list">
                {captionSegments.length === 0 ? (
                  <div className="smart-pipeline-empty-state">
                    <p>{t("smartPipelineEmptyCaptions", "No spoken words transcribed.")}</p>
                  </div>
                ) : (
                  captionSegments.map((seg, idx) => {
                    const segKey = seg.id || `${seg.start}-${seg.end}`;
                    const isAuditioning = pipeline.auditioningCaptionId === segKey || pipeline.auditioningCaptionId === seg.id;
                    return (
                      <div key={seg.id || idx} className="smart-pipeline-caption-row">
                        <div className="smart-pipeline-time-badge">
                          <span>{formatTime(seg.start)}</span>
                          <span>→</span>
                          <span>{formatTime(seg.end)}</span>
                        </div>
                        <input
                          type="text"
                          className="smart-pipeline-caption-input"
                          value={seg.text || ""}
                          onChange={(e) => updateCaptionSegment(seg.id, { text: e.target.value })}
                          data-testid={`smart-pipeline-caption-text-${idx}`}
                        />
                        <button
                          type="button"
                          className={`smart-pipeline-icon-btn ${isAuditioning ? "is-playing" : ""}`}
                          onClick={() => previewCaption(seg)}
                          title={isAuditioning ? t("smartPipelinePause", "Pause") : t("smartPipelinePreview", "Preview")}
                          data-testid={`smart-pipeline-caption-preview-${idx}`}
                        >
                          {isAuditioning ? <Pause size={14} weight="fill" /> : <Play size={14} weight="fill" />}
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* STAGE 4: REVIEW ROUGH CUTS */}
          {stage === "cuts" && (
            <div className="smart-pipeline-stage smart-pipeline-cuts-stage">
              {/* Metrics Banner */}
              <div className="smart-pipeline-metrics-banner">
                <div className="smart-pipeline-metric">
                  <span className="smart-pipeline-metric-label">
                    {t("smartPipelineOriginalDur", "Original Duration")}
                  </span>
                  <span className="smart-pipeline-metric-value">
                    {formatTime(metrics.originalDuration)}
                  </span>
                </div>
                <div className="smart-pipeline-metric is-projected">
                  <span className="smart-pipeline-metric-label">
                    {t("smartPipelineProjectedDur", "Projected Duration")}
                  </span>
                  <span className="smart-pipeline-metric-value">
                    {formatTime(metrics.projectedDuration)}
                  </span>
                </div>
                <div className="smart-pipeline-metric is-saved">
                  <span className="smart-pipeline-metric-label">
                    {t("smartPipelineTimeSaved", "Time Saved")}
                  </span>
                  <span className="smart-pipeline-metric-value">
                    -{metrics.timeSaved.toFixed(1)}s ({metrics.percentageReduced}%)
                  </span>
                </div>
              </div>

              {/* Cuts Toolbar */}
              <div className="smart-pipeline-toolbar">
                <div className="smart-pipeline-toolbar-left">
                  <label className="smart-pipeline-checkbox-row">
                    <input
                      type="checkbox"
                      checked={includeCuts}
                      onChange={(e) => setIncludeCuts(e.target.checked)}
                      data-testid="smart-pipeline-include-cuts"
                    />
                    <strong>{t("smartPipelineIncludeCuts", "Include Cuts in Timeline")}</strong>
                  </label>

                  <div className="smart-pipeline-filter-tabs">
                    <button
                      type="button"
                      className={`smart-pipeline-tab ${filterType === "all" ? "is-active" : ""}`}
                      onClick={() => setFilterType("all")}
                    >
                      {t("smartPipelineFilterAll", "All")} ({candidates.length})
                    </button>
                    <button
                      type="button"
                      className={`smart-pipeline-tab ${filterType === "pause" ? "is-active" : ""}`}
                      onClick={() => setFilterType("pause")}
                    >
                      {t("smartPipelineFilterPauses", "Pauses")} ({metrics.pauseCount})
                    </button>
                    <button
                      type="button"
                      className={`smart-pipeline-tab ${filterType === "filler" ? "is-active" : ""}`}
                      onClick={() => setFilterType("filler")}
                    >
                      {t("smartPipelineFilterFillers", "Fillers")} ({metrics.fillerCount})
                    </button>
                  </div>
                </div>

                <div className="smart-pipeline-toolbar-right">
                  <button
                    type="button"
                    className="smart-pipeline-text-btn"
                    onClick={() => toggleAllCuts(true)}
                    data-testid="smart-pipeline-select-all"
                  >
                    {t("smartPipelineSelectAll", "Select All")}
                  </button>
                  <button
                    type="button"
                    className="smart-pipeline-text-btn"
                    onClick={() => toggleAllCuts(false)}
                    data-testid="smart-pipeline-deselect-all"
                  >
                    {t("smartPipelineDeselectAll", "Deselect All")}
                  </button>
                </div>
              </div>

              {/* Cuts List */}
              <div className="smart-pipeline-cut-list" data-testid="smart-pipeline-cut-list">
                {filteredCandidates.length === 0 ? (
                  <div className="smart-pipeline-empty-state">
                    <p>{t("smartPipelineEmptyCuts", "No removable pauses or filler words detected.")}</p>
                  </div>
                ) : (
                  filteredCandidates.map((cut) => (
                    <div
                      key={cut.id}
                      className={`smart-pipeline-cut-row ${(cut.enabled ?? cut.selected ?? true) ? "is-enabled" : "is-excluded"}`}
                    >
                      <label className="smart-pipeline-cut-checkbox-label">
                        <input
                          type="checkbox"
                          checked={Boolean(cut.enabled ?? cut.selected ?? true)}
                          onChange={() => toggleCut(cut.id)}
                          data-testid={`smart-pipeline-cut-toggle-${cut.id}`}
                        />
                        <span className={`smart-pipeline-type-badge is-${cut.type}`}>
                          {cut.type === "filler"
                            ? `Filler: "${cut.word}"`
                            : cut.type === "merged"
                            ? "Pause & Filler"
                            : "Pause"}
                        </span>
                      </label>

                      <div className="smart-pipeline-cut-times">
                        <span>{formatTime(cut.start)}</span>
                        <span>→</span>
                        <span>{formatTime(cut.end)}</span>
                        <span className="smart-pipeline-cut-duration">
                          ({cut.duration.toFixed(2)}s)
                        </span>
                      </div>

                      <button
                        type="button"
                        className="smart-pipeline-icon-btn"
                        onClick={() => previewCut(cut)}
                        title={t("smartPipelinePreview", "Preview")}
                        data-testid={`smart-pipeline-preview-${cut.id}`}
                      >
                        <Play size={14} weight="fill" />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* STAGE 5: SUMMARY & APPLY */}
          {stage === "review" && (
            <div className="smart-pipeline-stage smart-pipeline-review-stage">
              <div className="smart-pipeline-summary-card">
                <h3>{t("smartPipelineStepReview", "Summary of Approved Changes")}</h3>
                <div className="smart-pipeline-summary-grid">
                  <div className="smart-pipeline-summary-item">
                    <span className="smart-pipeline-summary-label">
                      {t("smartPipelineOriginalDur", "Original Duration")}
                    </span>
                    <strong className="smart-pipeline-summary-val">
                      {formatTime(metrics.originalDuration)}
                    </strong>
                  </div>

                  <div className="smart-pipeline-summary-item">
                    <span className="smart-pipeline-summary-label">
                      {t("smartPipelineProjectedDur", "Projected Duration")}
                    </span>
                    <strong className="smart-pipeline-summary-val is-highlight">
                      {includeCuts ? formatTime(metrics.projectedDuration) : formatTime(metrics.originalDuration)}
                    </strong>
                  </div>

                  <div className="smart-pipeline-summary-item">
                    <span className="smart-pipeline-summary-label">
                      {t("smartPipelineCutsCount", "Rough Cuts")}
                    </span>
                    <strong className="smart-pipeline-summary-val">
                      {includeCuts ? `${metrics.enabledCutsCount} cuts (${metrics.timeSaved.toFixed(1)}s)` : "Disabled"}
                    </strong>
                  </div>

                  <div className="smart-pipeline-summary-item">
                    <span className="smart-pipeline-summary-label">
                      {t("smartPipelineCaptionsCount", "Captions")}
                    </span>
                    <strong className="smart-pipeline-summary-val">
                      {includeCaptions ? `${captionSegments.length} segments` : "Disabled"}
                    </strong>
                  </div>
                </div>

                <div className="smart-pipeline-summary-notice">
                  <CheckCircle size={18} weight="fill" />
                  <span>
                    {t(
                      "smartPipelineUndoNotice",
                      "All changes are recorded as one atomic edit and can be undone with Undo (Ctrl+Z)."
                    )}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* STAGE 6: FINISHED / APPLIED */}
          {stage === "applied" && (
            <div className="smart-pipeline-stage smart-pipeline-applied-stage">
              <div className="smart-pipeline-success-card">
                <CheckCircle size={56} weight="fill" className="smart-pipeline-success-icon" />
                <h3>{t("smartPipelineApplied", "Smart Editing Applied!")}</h3>
                <p>
                  Your timeline has been updated with approved cuts and captions.
                  All synchronization and history checkpoints have been committed.
                </p>
                <button
                  type="button"
                  className="smart-pipeline-btn-primary"
                  onClick={close}
                  data-testid="smart-pipeline-continue-btn"
                >
                  <Check size={18} weight="bold" />
                  <span>{t("smartPipelineContinue", "Continue Editing")}</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer Controls */}
        {stage !== "applied" && (
          <footer className="smart-pipeline-footer">
            <div className="smart-pipeline-footer-left">
              {stage !== "select" && stage !== "analyzing" && (
                <button
                  type="button"
                  className="smart-pipeline-btn-secondary"
                  onClick={() => {
                    if (stage === "review") setStage("cuts");
                    else if (stage === "cuts") {
                      if (settings.generateCaptions && captionSegments.length > 0) setStage("captions");
                      else setStage("select");
                    } else if (stage === "captions") setStage("select");
                  }}
                  data-testid="smart-pipeline-prev-btn"
                >
                  <CaretLeft size={16} weight="bold" />
                  <span>{t("smartPipelinePrev", "Previous")}</span>
                </button>
              )}
            </div>

            <div className="smart-pipeline-footer-right">
              {stage === "select" && (
                <button
                  type="button"
                  className="smart-pipeline-btn-primary"
                  disabled={!isSupported}
                  onClick={startAnalysis}
                  data-testid="smart-pipeline-start-btn"
                >
                  <Sparkle size={18} weight="fill" />
                  <span>{t("smartPipelineStart", "Start Smart Analysis")}</span>
                </button>
              )}

              {stage === "captions" && (
                <button
                  type="button"
                  className="smart-pipeline-btn-primary"
                  onClick={() => setStage("cuts")}
                  data-testid="smart-pipeline-to-cuts-btn"
                >
                  <span>{t("smartPipelineNext", "Next: Review Cuts")}</span>
                  <CaretRight size={16} weight="bold" />
                </button>
              )}

              {stage === "cuts" && (
                <button
                  type="button"
                  className="smart-pipeline-btn-primary"
                  onClick={() => setStage("review")}
                  data-testid="smart-pipeline-to-review-btn"
                >
                  <span>{t("smartPipelineNext", "Next: Summary")}</span>
                  <CaretRight size={16} weight="bold" />
                </button>
              )}

              {stage === "review" && (
                <button
                  type="button"
                  className="smart-pipeline-btn-primary"
                  onClick={apply}
                  data-testid="smart-pipeline-apply-btn"
                >
                  <Sparkle size={18} weight="fill" />
                  <span>{t("smartPipelineApply", "Apply Approved Changes")}</span>
                </button>
              )}
            </div>
          </footer>
        )}
      </div>
    </div>,
    document.body
  );
}
