import { useEffect, useMemo, useState } from "react";
import { attachTranscriptionOutcome, preserveTranscriptionOutcome } from "../lib/transcriptionOutcome.js";
import { regroupWorkflowTranscript } from "../lib/workflowTranscription.js";
import { editorTranscriptionStatus } from "../lib/editorTranscription.js";
import { createPortal } from "react-dom";
import {
  Check,
  ClosedCaptioning,
  ListBullets,
  Plus,
  TextT,
  Trash,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import {
  addSegment,
  deleteSegment,
  updateSegmentText,
  updateSegmentTiming,
  validateCaptionSegments,
  validateCaptionTimestamp,
} from "../lib/transcriptReview.js";
import "./TranscriptReviewModal.css";

export function TranscriptReviewModal({
  isOpen,
  reviewData,
  onApply,
  onCancel,
  t = (key, fallback) => fallback || key,
}) {
  const [segments, setSegments] = useState([]);
  const [fullText, setFullText] = useState("");
  const [activeTab, setActiveTab] = useState("segments"); // "segments" | "script"
  const [currentGrouping, setCurrentGrouping] = useState("phrases");

  // Sync state whenever reviewData changes
  useEffect(() => {
    if (!isOpen || !reviewData) return;
    setSegments(preserveTranscriptionOutcome(Array.isArray(reviewData.segments) ? reviewData.segments : [], reviewData));
    setFullText(reviewData.text || "");
    setCurrentGrouping(reviewData.grouping || "phrases");
    setActiveTab("segments");
  }, [isOpen, reviewData]);

  // Keyboard shortcut: Escape to cancel
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        onCancel?.();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onCancel]);

  // Real-time validation
  const validation = useMemo(() => {
    return validateCaptionSegments(segments);
  }, [segments]);

  if (!isOpen || !reviewData) return null;

  const rawChunks = reviewData.rawChunks;
  const canRegroup = Array.isArray(rawChunks) && rawChunks.length > 0;
  const duration = reviewData.duration || 0;
  const timelineOffset = reviewData.timelineOffset || 0;

  const handleGroupingChange = (newGrouping) => {
    setCurrentGrouping(newGrouping);
    if (!canRegroup) return;
    try {
      const regrouped = preserveTranscriptionOutcome(regroupWorkflowTranscript(rawChunks, duration, {
        timelineOffset,
        grouping: newGrouping,
      }, reviewData.segments || []), reviewData);
      if (regrouped.length) {
        setSegments(regrouped);
        setFullText(regrouped.map((s) => s.text).join("\n"));
      }
    } catch (err) {
      console.warn("Failed to regroup caption segments:", err);
    }
  };

  const handleTextChange = (id, newText) => {
    const updated = updateSegmentText(segments, id, newText);
    setSegments(updated);
    setFullText(updated.map((s) => s.text).join("\n"));
  };

  const handleTimingChange = (id, field, value) => {
    const num = Number(value);
    const updated = updateSegmentTiming(segments, id, { [field]: num });
    setSegments(updated);
  };

  const handleDelete = (id) => {
    const updated = deleteSegment(segments, id);
    setSegments(updated);
    setFullText(updated.map((s) => s.text).join("\n"));
  };

  const handleAdd = () => {
    const updated = addSegment(segments, null, {
      text: "",
      start: segments.length ? Math.max(0, segments[segments.length - 1].end) : 0,
      end: segments.length ? Math.max(0, segments[segments.length - 1].end + 2) : 2,
    });
    setSegments(updated);
  };

  const handleApplyClick = () => {
    if (!validation.valid) return;
    onApply?.(attachTranscriptionOutcome({
      segments,
      text: fullText,
    }, reviewData));
  };

  const firstError = validation.errors[0];

  return createPortal(
    <div
      className="transcript-review-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="transcript-review-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel?.();
      }}
    >
      <div className="transcript-review-container">
        {/* Header */}
        <div className="transcript-review-header">
          <div className="transcript-review-title-group">
            <div className="transcript-review-title-row">
              <h2 id="transcript-review-title" className="transcript-review-title">
                <ClosedCaptioning size={22} weight="duotone" />
                {t("reviewCaptionsTitle", "Review Auto Captions")}
              </h2>
              {reviewData.language ? (
                <span className="transcript-review-badge">
                  {reviewData.language}
                </span>
              ) : null}
              {duration > 0 ? (
                <span className="transcript-review-badge">
                  {duration.toFixed(1)}s
                </span>
              ) : null}
            </div>
            <p className="transcript-review-desc">
              {t("reviewCaptionsDesc", "Review and adjust recognizing captions before applying to timeline")}
            </p>
            <p className="transcript-review-desc" role="status">{editorTranscriptionStatus(reviewData)}</p>
          </div>
          <button
            className="transcript-review-close"
            type="button"
            onClick={onCancel}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Controls Bar */}
        <div className="transcript-review-controls">
          <div className="transcript-review-tabs">
            <button
              className={`transcript-review-tab-btn ${activeTab === "segments" ? "active" : ""}`}
              type="button"
              onClick={() => setActiveTab("segments")}
            >
              <ListBullets size={15} />
              {t("captionSegmentsCount", "Segments ({count})").replace("{count}", segments.length)}
            </button>
            <button
              className={`transcript-review-tab-btn ${activeTab === "script" ? "active" : ""}`}
              type="button"
              onClick={() => setActiveTab("script")}
            >
              <TextT size={15} />
              {t("fullTranscript", "Full Script")}
            </button>
          </div>

          <div className="transcript-review-tools">
            {canRegroup ? (
              <div className="transcript-grouping-select-wrap">
                <label htmlFor="review-grouping-select">
                  {t("groupingLabel", "Grouping:")}
                </label>
                <select
                  id="review-grouping-select"
                  className="transcript-grouping-select"
                  value={currentGrouping}
                  onChange={(e) => handleGroupingChange(e.target.value)}
                >
                  <option value="phrases">{t("captionGroupingPhrases", "Phrases (Smart)")}</option>
                  <option value="words">{t("captionGroupingWords", "Single Words")}</option>
                </select>
              </div>
            ) : null}

            {activeTab === "segments" ? (
              <button
                className="transcript-add-btn"
                type="button"
                onClick={handleAdd}
              >
                <Plus size={14} weight="bold" />
                {t("addSegment", "Add Segment")}
              </button>
            ) : null}
          </div>
        </div>

        {/* Content Body */}
        <div className="transcript-review-body">
          {activeTab === "segments" ? (
            segments.length === 0 ? (
              <div className="transcript-empty-state">
                <ClosedCaptioning size={40} weight="thin" />
                <p>{t("noCaptionsDetected", "No speech detected in this audio clip.")}</p>
                <button
                  className="transcript-add-btn"
                  type="button"
                  onClick={handleAdd}
                >
                  <Plus size={14} weight="bold" />
                  {t("addFirstSegment", "Add caption manually")}
                </button>
              </div>
            ) : (
              <div className="transcript-segments-list">
                {segments.map((segment, index) => {
                  const check = validateCaptionTimestamp(segment.start, segment.end);
                  const isInvalid = !check.valid;
                  const dur = Math.max(0, (Number(segment.end) || 0) - (Number(segment.start) || 0));

                  return (
                    <div
                      key={segment.id || `seg-${index}`}
                      className={`transcript-segment-card ${isInvalid ? "has-error" : ""}`}
                    >
                      <div className="transcript-segment-meta">
                        <span className="transcript-segment-badge">#{index + 1}</span>

                        <div className="transcript-timing-controls">
                          <div className="transcript-time-input-group">
                            <label>In</label>
                            <input
                              className={`transcript-time-input ${Number(segment.start) < 0 || !Number.isFinite(Number(segment.start)) ? "invalid" : ""}`}
                              type="number"
                              step="0.05"
                              value={segment.start ?? 0}
                              onChange={(e) => handleTimingChange(segment.id, "start", e.target.value)}
                            />
                            <span>s</span>
                          </div>

                          <span className="transcript-timing-arrow">→</span>

                          <div className="transcript-time-input-group">
                            <label>Out</label>
                            <input
                              className={`transcript-time-input ${Number(segment.end) < Number(segment.start) || !Number.isFinite(Number(segment.end)) ? "invalid" : ""}`}
                              type="number"
                              step="0.05"
                              value={segment.end ?? 0}
                              onChange={(e) => handleTimingChange(segment.id, "end", e.target.value)}
                            />
                            <span>s</span>
                          </div>

                          <span className="transcript-duration-pill">
                            {dur.toFixed(2)}s
                          </span>
                        </div>

                        <div className="transcript-segment-actions">
                          <button
                            className="transcript-delete-btn"
                            type="button"
                            title={t("deleteCaption", "Delete Segment")}
                            onClick={() => handleDelete(segment.id)}
                          >
                            <Trash size={15} />
                          </button>
                        </div>
                      </div>

                      <textarea
                        className="transcript-text-input"
                        rows={1}
                        value={segment.text ?? ""}
                        placeholder={t("captionPlaceholder", "Caption text...")}
                        onChange={(e) => handleTextChange(segment.id, e.target.value)}
                      />

                      {isInvalid ? (
                        <span className="transcript-segment-error-text">
                          <WarningCircle size={14} />
                          {check.error}
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )
          ) : (
            <div className="transcript-full-script-container">
              <textarea
                className="transcript-full-script-textarea"
                value={fullText}
                onChange={(e) => setFullText(e.target.value)}
                placeholder={t("scriptPlaceholder", "Full recognized transcript text...")}
              />
              <div className="transcript-full-script-meta">
                <span>{t("wordCountLabel", "Words: {count}").replace("{count}", fullText.trim() ? fullText.trim().split(/\s+/).length : 0)}</span>
                <span>{t("charCountLabel", "Characters: {count}").replace("{count}", fullText.length)}</span>
              </div>
            </div>
          )}
        </div>

        {/* Global Validation Warning Banner */}
        {!validation.valid && firstError ? (
          <div className="transcript-validation-banner">
            <WarningCircle size={16} weight="bold" />
            <span>
              {t("invalidTimestampsWarning", "Please fix invalid timestamps before applying: Segment #{index} ({error})")
                .replace("{index}", firstError.index + 1)
                .replace("{error}", firstError.error)}
            </span>
          </div>
        ) : null}

        {/* Footer */}
        <div className="transcript-review-footer">
          <button
            className="transcript-btn-cancel"
            type="button"
            onClick={onCancel}
          >
            {t("cancel", "Cancel")}
          </button>

          <button
            className="transcript-btn-apply"
            type="button"
            disabled={!validation.valid || segments.length === 0}
            onClick={handleApplyClick}
          >
            <Check size={16} weight="bold" />
            {t("applyToTimeline", "Apply to Timeline")}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
