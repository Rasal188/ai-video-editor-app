import { CircleNotch, Play, Scissors, X } from "@phosphor-icons/react";
import "./SilenceRemovalPanel.css";

const time = (seconds) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;

export function SilenceRemovalPanel({ t, tool }) {
  const { segment, supported, locked, settings, draft, stale, job, error } = tool;
  const selected = draft?.candidates.filter((cut) => cut.enabled) || [];
  const savings = selected.reduce((sum, cut) => sum + cut.end - cut.start, 0);
  const setup = ["pauseDownloading", "pauseStarting"].includes(job.phase);

  return (
    <section className="pause-panel" aria-label={t("pauseTitle")} data-testid="silence-removal-panel">
      <p className="pause-intro">{t("pauseIntro")}</p>
      {segment?.type === "video" ? (
        <strong className="pause-clip" title={segment.name} data-testid="pause-selected-clip">
          {segment.name || t("video")}
        </strong>
      ) : (
        <p className="pause-select-prompt" data-testid="pause-select-prompt">{t("pauseSelect")}</p>
      )}
      {segment?.preparing ? (
        <p role="status">{t("timelineMediaPreparing")}</p>
      ) : segment?.type === "video" && !supported ? (
        <p className="pause-notice" role="alert" data-testid="pause-unsupported-notice">{t("pauseUnsupported")}</p>
      ) : null}
      {locked ? <p className="pause-notice" role="alert" data-testid="pause-locked-notice">{t("pauseLocked")}</p> : null}

      <div className="pause-settings" data-testid="pause-settings">
        {[
          ["threshold", "pauseThreshold", 0.1, 0.9, 0.05, ""],
          ["minimum", "pauseMinimum", 0.2, 5, 0.1, " s"],
          ["keep", "pauseKeep", 0.0, 1.5, 0.05, " s"],
        ].map(([key, label, min, max, step, unit]) => (
          <label key={key} data-testid={`pause-label-${key}`}>
            <span>{t(label, key === "threshold" ? "Audio threshold" : label)}</span>
            <output data-testid={`pause-output-${key}`}>
              {(settings[key] ?? (key === "threshold" ? 0.5 : 0.8)).toFixed(2)}
              {unit}
            </output>
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={settings[key] ?? (key === "threshold" ? 0.5 : 0.8)}
              disabled={job.running}
              data-testid={`pause-setting-${key}`}
              onChange={(event) => tool.updateSettings({ [key]: Number(event.target.value) })}
            />
          </label>
        ))}
      </div>

      <label className="pause-ripple" data-testid="pause-ripple-label">
        <input
          type="checkbox"
          data-testid="pause-ripple-checkbox"
          checked={tool.rippleEditing}
          onChange={(event) => tool.setRippleEditing(event.target.checked)}
        />
        {t("pauseRipple")}
      </label>
      <p className="pause-note">{t(tool.rippleEditing ? "pauseRippleOn" : "pauseRippleOff")}</p>

      <button
        type="button"
        className={job.running ? "panel-secondary" : "panel-primary"}
        data-testid={job.running ? "pause-cancel-btn" : "pause-analyze-btn"}
        disabled={!job.running && (!supported || locked)}
        onClick={job.running ? tool.cancel : tool.run}
      >
        {job.running ? <CircleNotch size={16} className="pause-spinner" /> : <Scissors size={16} />}
        {t(job.running ? "pauseCancel" : "pauseAnalyze")}
      </button>

      {job.running ? (
        <div className="pause-progress" role="status" data-testid="pause-progress">
          <span>{t(job.phase)}</span>
          {!setup ? <output data-testid="pause-progress-pct">{Math.round(job.progress * 100)}%</output> : null}
          <progress max="1" data-testid="pause-progress-bar" {...(!setup ? { value: job.progress } : {})} />
        </div>
      ) : null}

      {stale ? <p className="pause-notice" role="status" data-testid="pause-stale-notice">{t("pauseStale")}</p> : null}
      {error ? <p className="pause-notice" role="alert" data-testid="pause-error-notice">{t(error)}</p> : null}

      {draft && !stale ? (
        <div className="pause-review" data-testid="pause-review">
          {draft.candidates.length ? (
            <>
              <strong aria-live="polite" className="pause-summary" data-testid="pause-summary">
                {t("pauseSummary")
                  .replace("{count}", selected.length)
                  .replace("{seconds}", savings.toFixed(2))}
              </strong>
              <div className="pause-ranges" data-testid="pause-ranges">
                {draft.candidates.map((cut) => (
                  <div className="pause-range" key={cut.id} data-testid={`pause-candidate-${cut.id}`}>
                    <label>
                      <input
                        type="checkbox"
                        data-testid={`pause-checkbox-${cut.id}`}
                        checked={cut.enabled}
                        onChange={() => tool.toggle(cut.id)}
                      />
                      <span>
                        {time(draft.start + cut.start)} – {time(draft.start + cut.end)}
                        <small>−{(cut.end - cut.start).toFixed(2)} s</small>
                      </span>
                    </label>
                    <button
                      type="button"
                      data-testid={`pause-preview-${cut.id}`}
                      aria-label={`${t("pausePreview")} ${time(draft.start + cut.start)}`}
                      title={t("pausePreview")}
                      onClick={() => tool.preview(cut)}
                    >
                      <Play size={15} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="pause-actions">
                <button
                  type="button"
                  className="panel-secondary"
                  data-testid="pause-cancel-review-btn"
                  onClick={tool.dismiss}
                >
                  <X size={16} />
                  {t("cancel", "Cancel")}
                </button>
                <button
                  type="button"
                  className="panel-primary"
                  data-testid="pause-apply-btn"
                  disabled={!selected.length || locked}
                  onClick={tool.apply}
                >
                  <Scissors size={16} />
                  {t("pauseApply")}
                </button>
              </div>
            </>
          ) : (
            <p role="status" data-testid="pause-empty-notice">{t("pauseEmpty")}</p>
          )}
        </div>
      ) : null}

      <small className="pause-note">{t("pauseLocal")}</small>
    </section>
  );
}
