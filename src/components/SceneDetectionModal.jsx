import { useEffect } from "react";
import { createPortal } from "react-dom";
import {
  CaretLeft,
  CaretRight,
  Check,
  CircleNotch,
  Play,
  Scan,
  Scissors,
  X,
} from "@phosphor-icons/react";
import "./SceneDetectionModal.css";

const formatTime = (seconds) => {
  const safe = Math.max(0, Number(seconds) || 0);
  const mins = Math.floor(safe / 60);
  const secs = (safe % 60).toFixed(2).padStart(5, "0");
  return `${mins}:${secs}`;
};

export function SceneDetectionModal({
  isOpen,
  tool,
  t = (key, fallback) => fallback || key,
}) {
  const {
    close,
    cancel,
    supported,
    stale,
    locked = false,
    segment,
    settings,
    updateSettings,
    job,
    error,
    draft,
    selectedBoundaries,
    currentSceneIndex,
    run,
    toggleBoundary,
    toggleAll,
    previewTime,
    navigateToScene,
    prevScene,
    nextScene,
    apply,
    applyCuts,
  } = tool;

  // Keyboard shortcut: Escape closes or cancels
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        if (job?.running) {
          cancel();
        } else {
          close();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, job?.running, cancel, close]);

  if (!isOpen) return null;

  const scenes = draft?.scenes || [];
  const boundaries = draft?.boundaries || [];
  const currentScene = scenes[currentSceneIndex] || scenes[0] || null;

  const getErrorText = (code) => {
    if (!code) return "";
    if (code === "sceneDetectUnsupported") return t("sceneDetectUnsupported", "The selected video format or properties are not supported.");
    if (code === "sceneDetectLocked") return t("sceneDetectLocked", "A related track is locked. Unlock it first.");
    return t("sceneDetectFailed", "Scene detection failed. Please retry.");
  };

  const modalContent = (
    <div
      className="scene-detection-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="scene-detection-title"
      data-testid="scene-detection-modal"
    >
      <div className="scene-detection-container">
        {/* Header */}
        <header className="scene-detection-header">
          <div className="scene-detection-title-group">
            <div className="scene-detection-title-row">
              <Scan size={22} weight="duotone" className="scene-detection-icon" />
              <h2 id="scene-detection-title">{t("sceneDetectTitle", "AI Scene Detection")}</h2>
            </div>
            <p className="scene-detection-subtitle">
              {t("sceneDetectHint", "Detect visual cuts and scene boundaries")}
            </p>
          </div>
          <button
            type="button"
            className="scene-detection-close-btn"
            onClick={close}
            aria-label={t("sceneDetectDismiss", "Close")}
            data-testid="scene-detect-close-btn"
          >
            <X size={18} />
          </button>
        </header>

        {/* Body */}
        <div className="scene-detection-body">
          {/* Clip info banner */}
          <div className="scene-detection-clip-info">
            <span className="scene-detection-clip-name" data-testid="scene-detect-clip-name">
              {segment?.name || (segment ? t("video", "Video") : t("sceneDetectSelect", "Select a video on the main visual track."))}
            </span>
            {segment?.duration ? (
              <span className="scene-detection-clip-duration">
                {formatTime(segment.duration)}
              </span>
            ) : null}
          </div>

          {/* Settings Section */}
          <div className="scene-detection-settings" data-testid="scene-detect-settings">
            <div className="scene-detection-setting-item">
              <div className="scene-detection-setting-label">
                <span>{t("sceneDetectThreshold", "Sensitivity threshold")}</span>
                <span className="scene-detection-setting-value" data-testid="scene-detect-threshold-val">
                  {settings.threshold.toFixed(2)}
                </span>
              </div>
              <input
                type="range"
                min={0.10}
                max={0.90}
                step={0.05}
                value={settings.threshold}
                disabled={job?.running}
                className="scene-detection-slider"
                data-testid="scene-detect-threshold-slider"
                onChange={(e) => updateSettings({ threshold: Number(e.target.value) })}
              />
            </div>

            <div className="scene-detection-setting-item">
              <div className="scene-detection-setting-label">
                <span>{t("sceneDetectInterval", "Sample interval")}</span>
                <span className="scene-detection-setting-value" data-testid="scene-detect-interval-val">
                  {settings.sampleInterval.toFixed(2)}s
                </span>
              </div>
              <input
                type="range"
                min={0.10}
                max={2.00}
                step={0.10}
                value={settings.sampleInterval}
                disabled={job?.running}
                className="scene-detection-slider"
                data-testid="scene-detect-interval-slider"
                onChange={(e) => updateSettings({ sampleInterval: Number(e.target.value) })}
              />
            </div>

            <div className="scene-detection-setting-item">
              <div className="scene-detection-setting-label">
                <span>{t("sceneDetectMinDuration", "Minimum scene duration")}</span>
                <span className="scene-detection-setting-value" data-testid="scene-detect-min-duration-val">
                  {settings.minSceneDuration.toFixed(1)}s
                </span>
              </div>
              <input
                type="range"
                min={0.5}
                max={5.0}
                step={0.5}
                value={settings.minSceneDuration}
                disabled={job?.running}
                className="scene-detection-slider"
                data-testid="scene-detect-min-duration-slider"
                onChange={(e) => updateSettings({ minSceneDuration: Number(e.target.value) })}
              />
            </div>
          </div>

          {/* Action / Analyze button */}
          <div className="scene-detection-actions">
            <button
              type="button"
              className="scene-detection-run-btn"
              disabled={!supported || job?.running}
              data-testid="scene-detect-run-btn"
              onClick={() => run()}
            >
              {job?.running ? (
                <CircleNotch size={16} className="is-spinning" />
              ) : (
                <Scan size={16} />
              )}
              <span>
                {job?.running
                  ? t(job.phase || "sceneDetectAnalyzing", "Analyzing video frames…")
                  : t("sceneDetectAnalyze", "Detect scenes")}
              </span>
            </button>
          </div>

          {/* Progress bar */}
          {job?.running ? (
            <div className="scene-detection-progress" data-testid="scene-detect-progress">
              <div className="scene-detection-progress-bar">
                <div
                  className="scene-detection-progress-fill"
                  style={{ width: `${job.progress}%` }}
                />
              </div>
              <div className="scene-detection-progress-meta">
                <span>
                  {t(job.phase || "sceneDetectAnalyzing", "Analyzing video frames…")}{" "}
                  {job.progress > 0 ? `(${job.progress}%)` : ""}
                </span>
                <button
                  type="button"
                  className="scene-detection-cancel-job-btn"
                  data-testid="scene-detect-cancel-btn"
                  onClick={cancel}
                >
                  {t("sceneDetectCancel", "Cancel")}
                </button>
              </div>
            </div>
          ) : null}

          {/* Error Banner */}
          {error ? (
            <div className="scene-detection-error-banner" role="alert" data-testid="scene-detect-error">
              {getErrorText(error)}
            </div>
          ) : null}

          {/* Review Section */}
          {draft ? (
            <div className="scene-detection-review" data-testid="scene-detect-review">
              {stale ? (
                <div className="scene-detection-error-banner" role="alert">
                  {t("sceneDetectStale", "The project or clip changed. Analyze again.")}
                </div>
              ) : null}

              {/* Review summary & toggle-all */}
              <div className="scene-detection-review-header">
                <span className="scene-detection-summary" data-testid="scene-detect-summary">
                  {t("sceneDetectSummary", "{count} scenes detected · {selected} boundaries selected")
                    .replace("{count}", scenes.length)
                    .replace("{selected}", selectedBoundaries.length)}
                </span>
                {boundaries.length > 0 ? (
                  <button
                    type="button"
                    className="scene-detection-toggle-all-btn"
                    data-testid="scene-detect-toggle-all-btn"
                    onClick={() => toggleAll(selectedBoundaries.length < boundaries.length)}
                  >
                    {selectedBoundaries.length === boundaries.length
                      ? t("sceneDetectDeselectAll", "Deselect all")
                      : t("sceneDetectSelectAll", "Select all")}
                  </button>
                ) : null}
              </div>

              {/* Scene Navigator */}
              {scenes.length > 0 && currentScene ? (
                <div className="scene-detection-navigator" data-testid="scene-detect-navigator">
                  <button
                    type="button"
                    className="scene-detection-nav-btn"
                    disabled={currentSceneIndex <= 0}
                    data-testid="scene-detect-prev-scene-btn"
                    onClick={prevScene}
                    aria-label={t("sceneDetectPrev", "Previous scene")}
                  >
                    <CaretLeft size={16} />
                  </button>

                  <div className="scene-detection-current-scene">
                    <span className="scene-detection-scene-badge" data-testid="scene-detect-current-badge">
                      {t("sceneDetectSceneIndex", "Scene {index} of {total}")
                        .replace("{index}", currentSceneIndex + 1)
                        .replace("{total}", scenes.length)}
                    </span>
                    <span className="scene-detection-scene-times">
                      {formatTime(currentScene.start)} – {formatTime(currentScene.end)} ({currentScene.duration.toFixed(2)}s)
                    </span>
                  </div>

                  <div style={{ display: "flex", gap: "8px" }}>
                    <button
                      type="button"
                      className="scene-detection-nav-btn"
                      title={t("sceneDetectPreview", "Preview location")}
                      data-testid="scene-detect-preview-scene-btn"
                      onClick={() => previewTime(currentScene.start)}
                    >
                      <Play size={14} weight="fill" />
                    </button>
                    <button
                      type="button"
                      className="scene-detection-nav-btn"
                      disabled={currentSceneIndex >= scenes.length - 1}
                      data-testid="scene-detect-next-scene-btn"
                      onClick={nextScene}
                      aria-label={t("sceneDetectNext", "Next scene")}
                    >
                      <CaretRight size={16} />
                    </button>
                  </div>
                </div>
              ) : null}

              {/* Boundary List */}
              {boundaries.length === 0 ? (
                <p className="scene-detection-empty" data-testid="scene-detect-empty">
                  {t("sceneDetectEmpty", "No meaningful visual scene cuts detected.")}
                </p>
              ) : (
                <ul className="scene-detection-boundary-list" data-testid="scene-detect-boundaries-list">
                  {boundaries.map((b, idx) => {
                    const isSelected = selectedBoundaries.some(
                      (tVal) => Math.abs(tVal - b.time) < 0.005,
                    );
                    return (
                      <li
                        key={idx}
                        className={`scene-detection-boundary-item ${isSelected ? "is-selected" : ""}`}
                        data-testid={`scene-boundary-item-${idx}`}
                      >
                        <label className="scene-detection-boundary-left">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            data-testid={`scene-boundary-toggle-${idx}`}
                            onChange={() => toggleBoundary(b.time)}
                          />
                          <span className="scene-detection-boundary-time">
                            {formatTime(b.time)}
                          </span>
                        </label>

                        <div className="scene-detection-boundary-meta">
                          <span className="scene-detection-conf-badge">
                            {t("sceneDetectConfidence", "Confidence")}: {Math.round(b.confidence * 100)}%
                          </span>
                          <button
                            type="button"
                            className="scene-detection-preview-btn"
                            title={t("sceneDetectPreview", "Preview location")}
                            data-testid={`scene-boundary-preview-${idx}`}
                            onClick={() => previewTime(b.time)}
                          >
                            <Play size={13} weight="fill" />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <footer className="scene-detection-footer">
          <span className="scene-detection-footnote">
            {t("sceneDetectLocal", "Processed locally in browser · Non-destructive")}
          </span>
          <div className="scene-detection-footer-actions">
            <button
              type="button"
              className="scene-detection-dismiss-btn"
              data-testid="scene-detect-dismiss-btn"
              onClick={close}
            >
              {t("sceneDetectDismiss", "Dismiss / Cancel")}
            </button>
            <button
              type="button"
              className="scene-detection-apply-btn"
              data-testid="scene-detect-apply-btn"
              disabled={!draft || selectedBoundaries.length === 0}
              onClick={apply}
              title={t("sceneDetectApproved", "Approve scene boundaries without modifying timeline")}
            >
              <Check size={16} weight="bold" />
              <span>{t("sceneDetectApply", "Approve scene boundaries")}</span>
            </button>
            <button
              type="button"
              className="scene-detection-apply-cuts-btn"
              data-testid="scene-detect-apply-cuts-btn"
              disabled={!draft || selectedBoundaries.length === 0 || locked}
              onClick={applyCuts}
              title={locked ? t("sceneDetectClipLocked", "Visual track is locked. Unlock it to cut clips.") : t("sceneDetectApplyCuts", "Apply scene cuts")}
            >
              <Scissors size={16} weight="bold" />
              <span>{t("sceneDetectApplyCuts", "Apply scene cuts")}</span>
            </button>
          </div>
        </footer>
      </div>
    </div>
  );

  return typeof document !== "undefined"
    ? createPortal(modalContent, document.body)
    : modalContent;
}
