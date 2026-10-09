import { CircleNotch, Play, Scissors, Sparkle, X } from "@phosphor-icons/react";
import "./RoughCutPanel.css";

const time = (seconds) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;

export function RoughCutPanel({ t, tool }) {
  const { segment, supported, locked, settings, draft, stale, job, error } = tool;
  const selected = draft?.candidates.filter((cut) => cut.enabled) || [];
  const savings = selected.reduce((sum, cut) => sum + cut.end - cut.start, 0);

  const getErrorText = (code) => {
    if (!code) return "";
    if (code === "roughCutNoAudio" || code === "pauseNoAudio" || code === "NO_AUDIO_STREAM") {
      return t("roughCutNoAudio", "This video has no audio track.");
    }
    if (code === "roughCutLocked" || code === "pauseLocked") {
      return t("roughCutLocked", "A related track is locked. Unlock it first.");
    }
    if (code === "roughCutStale" || code === "pauseStale") {
      return t("roughCutStale", "The project or clip changed. Analyze again.");
    }
    if (code === "roughCutNoSelection" || code === "pauseNoSelection") {
      return t("roughCutNoSelection", "Select at least one cut.");
    }
    if (code === "roughCutTooShort" || code === "pauseTooShort") {
      return t("roughCutTooShort", "A retained clip is too short. Select fewer cuts.");
    }
    return t("roughCutFailed", "Analysis failed. Please retry.");
  };

  const getTypeBadgeLabel = (type) => {
    if (type === "filler") return t("roughCutTypeFiller", "Filler word");
    if (type === "merged") return t("roughCutTypeMerged", "Pause & filler");
    return t("roughCutTypePause", "Pause");
  };

  return (
    <section className="rough-cut-panel" aria-label={t("roughCutTitle", "AI Rough Cut")} data-testid="rough-cut-panel">
      <div className="rough-cut-header">
        <Sparkle size={20} weight="duotone" className="rough-cut-icon" />
        <p className="rough-cut-intro">{t("roughCutIntro", "Analyze pauses and speech filler words to craft a tight first cut.")}</p>
      </div>

      {segment?.type === "video" ? (
        <strong className="rough-cut-clip" title={segment.name} data-testid="rough-cut-selected-clip">
          {segment.name || t("video")}
        </strong>
      ) : (
        <p className="rough-cut-select-prompt" data-testid="rough-cut-select-prompt">
          {t("roughCutSelect", "Select a video on the main visual track.")}
        </p>
      )}

      {segment?.type === "video" && !supported ? (
        <p className="rough-cut-notice" role="alert" data-testid="rough-cut-unsupported-notice">
          {t("roughCutUnsupported", "Speed curves, reverse, and transitions are not supported yet.")}
        </p>
      ) : null}

      {locked ? (
        <p className="rough-cut-notice" role="alert" data-testid="rough-cut-locked-notice">
          {t("roughCutLocked", "A related track is locked. Unlock it first.")}
        </p>
      ) : null}

      {/* Settings section */}
      <div className="rough-cut-settings" data-testid="rough-cut-settings">
        <label data-testid="rough-cut-label-threshold">
          <span>{t("roughCutThreshold", "Audio threshold")}</span>
          <output data-testid="rough-cut-output-threshold">{(settings.threshold ?? 0.5).toFixed(2)}</output>
          <input
            type="range"
            min={0.1}
            max={0.9}
            step={0.05}
            value={settings.threshold ?? 0.5}
            disabled={job.running}
            data-testid="rough-cut-threshold-slider"
            onChange={(e) => tool.updateSettings({ threshold: Number(e.target.value) })}
          />
        </label>

        <label data-testid="rough-cut-label-minimum">
          <span>{t("roughCutMinimum", "Minimum pause")}</span>
          <output data-testid="rough-cut-output-minimum">{(settings.minimum ?? 0.8).toFixed(2)} s</output>
          <input
            type="range"
            min={0.2}
            max={5.0}
            step={0.1}
            value={settings.minimum ?? 0.8}
            disabled={job.running}
            data-testid="rough-cut-minimum-slider"
            onChange={(e) => tool.updateSettings({ minimum: Number(e.target.value) })}
          />
        </label>

        <label data-testid="rough-cut-label-keep">
          <span>{t("roughCutKeep", "Speech padding")}</span>
          <output data-testid="rough-cut-output-keep">{(settings.keep ?? 0.3).toFixed(2)} s</output>
          <input
            type="range"
            min={0.0}
            max={1.0}
            step={0.05}
            value={settings.keep ?? 0.3}
            disabled={job.running}
            data-testid="rough-cut-keep-slider"
            onChange={(e) => tool.updateSettings({ keep: Number(e.target.value) })}
          />
        </label>
      </div>

      <div className="rough-cut-toggles">
        <label className="rough-cut-checkbox-label" data-testid="rough-cut-filler-label">
          <input
            type="checkbox"
            data-testid="rough-cut-filler-toggle"
            checked={Boolean(settings.removeFillerWords)}
            disabled={job.running}
            onChange={(e) => tool.updateSettings({ removeFillerWords: e.target.checked })}
          />
          <span>{t("roughCutFillerToggle", "Detect filler words (um, uh)")}</span>
        </label>

        <label className="rough-cut-checkbox-label" data-testid="rough-cut-ripple-label">
          <input
            type="checkbox"
            data-testid="rough-cut-ripple-toggle"
            checked={Boolean(tool.rippleEditing)}
            onChange={(e) => tool.setRippleEditing(e.target.checked)}
          />
          <span>{t("roughCutRipple", "Ripple editing")}</span>
        </label>
      </div>

      {/* Action / Analyze button */}
      <div className="rough-cut-actions">
        {job.running ? (
          <button
            type="button"
            className="rough-cut-cancel-job-btn"
            data-testid="rough-cut-cancel-analysis-btn"
            onClick={tool.cancel}
          >
            <CircleNotch className="is-spinning" size={16} />
            <span>{t("roughCutCancel", "Cancel analysis")}</span>
          </button>
        ) : (
          <button
            type="button"
            className="rough-cut-analyze-btn"
            data-testid="rough-cut-analyze-btn"
            disabled={!supported || locked || segment?.type !== "video"}
            onClick={tool.run}
          >
            <Scissors size={16} />
            <span>{t("roughCutAnalyze", "Analyze rough cut")}</span>
          </button>
        )}
      </div>

      {/* Progress status */}
      {job.running ? (
        <div className="rough-cut-progress" role="status" data-testid="rough-cut-progress">
          <div className="rough-cut-progress-bar">
            <div className="rough-cut-progress-fill" style={{ width: `${job.progress}%` }} />
          </div>
          <span className="rough-cut-progress-text">
            {t(job.phase || "roughCutPreparing", "Analyzing audio…")} {job.progress > 0 ? `(${job.progress}%)` : ""}
          </span>
        </div>
      ) : null}

      {/* Error display */}
      {error ? (
        <p className="rough-cut-error" role="alert" data-testid="rough-cut-error">
          {getErrorText(error)}
        </p>
      ) : null}

      {/* Review Candidates Section */}
      {draft ? (
        <div className="rough-cut-review" data-testid="rough-cut-review">
          {stale ? (
            <p className="rough-cut-notice" role="alert" data-testid="rough-cut-stale-notice">
              {t("roughCutStale", "The project or clip changed. Analyze again.")}
            </p>
          ) : null}

          <div className="rough-cut-review-header">
            <span className="rough-cut-summary" data-testid="rough-cut-summary">
              {t("roughCutSummary", "{count} selected · {seconds}s shorter")
                .replace("{count}", selected.length)
                .replace("{seconds}", savings.toFixed(2))}
            </span>
            <button
              type="button"
              className="rough-cut-toggle-all-btn"
              data-testid="rough-cut-toggle-all-btn"
              onClick={() => tool.toggleAll(selected.length < draft.candidates.length)}
            >
              {selected.length === draft.candidates.length
                ? t("roughCutDeselectAll", "Deselect all")
                : t("roughCutSelectAll", "Select all")}
            </button>
          </div>

          {draft.candidates.length === 0 ? (
            <p className="rough-cut-empty" data-testid="rough-cut-empty">
              {t("roughCutEmpty", "No removable pauses or filler words found.")}
            </p>
          ) : (
            <ul className="rough-cut-candidate-list" data-testid="rough-cut-candidates-list">
              {draft.candidates.map((cut, index) => (
                <li
                  key={cut.id || index}
                  className={`rough-cut-candidate-card ${cut.enabled ? "is-enabled" : "is-excluded"}`}
                  data-testid={`rough-cut-candidate-${index}`}
                >
                  <label className="rough-cut-candidate-checkbox">
                    <input
                      type="checkbox"
                      checked={cut.enabled}
                      data-testid={`rough-cut-candidate-toggle-${index}`}
                      onChange={() => tool.toggle(cut.id)}
                    />
                    <span className="rough-cut-candidate-time">
                      {time(cut.start)} – {time(cut.end)}
                    </span>
                  </label>

                  <div className="rough-cut-candidate-meta">
                    <span className={`rough-cut-badge rough-cut-badge-${cut.type}`}>
                      {getTypeBadgeLabel(cut.type)}
                    </span>
                    <span className="rough-cut-candidate-reason">
                      {cut.reason}
                    </span>
                  </div>

                  <button
                    type="button"
                    className="rough-cut-preview-btn"
                    title={t("roughCutPreview", "Preview location")}
                    data-testid={`rough-cut-preview-${index}`}
                    onClick={() => tool.preview(cut)}
                  >
                    <Play size={13} weight="fill" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Action commit buttons */}
          <div className="rough-cut-review-actions">
            <button
              type="button"
              className="rough-cut-cancel-btn"
              data-testid="rough-cut-cancel-btn"
              onClick={tool.dismiss}
            >
              <X size={15} />
              <span>{t("roughCutDismiss", "Dismiss / Cancel")}</span>
            </button>

            <button
              type="button"
              className="rough-cut-apply-btn"
              data-testid="rough-cut-apply-btn"
              disabled={stale || selected.length === 0}
              onClick={tool.apply}
            >
              <Scissors size={15} />
              <span>{t("roughCutApply", "Apply cuts")}</span>
            </button>
          </div>
        </div>
      ) : null}

      <footer className="rough-cut-footer">
        <span>{t("roughCutLocal", "Processed in your browser · Originals retained")}</span>
      </footer>
    </section>
  );
}
