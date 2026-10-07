import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  CheckCircle,
  CircleNotch,
  DownloadSimple,
  FilmStrip,
  WarningCircle,
  X,
  XCircle,
} from "@phosphor-icons/react";
import "./CloudRenderModal.css";

export function CloudRenderModal({
  isOpen,
  onClose,
  initialJob = null,
  project = null,
  notify,
}) {
  const [job, setJob] = useState(initialJob);
  const [canceling, setCanceling] = useState(false);

  useEffect(() => {
    setJob(initialJob);
  }, [initialJob]);

  // Polling while pending or processing
  useEffect(() => {
    if (!isOpen || !job?.id) return;
    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      return;
    }

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/renders/${job.id}`, {
          credentials: "include",
        });
        if (res.ok) {
          const data = await res.json();
          if (data.job) {
            setJob(data.job);
            if (data.job.status === "completed") {
              notify?.("Cloud render completed successfully!");
            } else if (data.job.status === "failed") {
              notify?.(`Cloud render failed: ${data.job.error_message || "Unknown error"}`);
            }
          }
        }
      } catch {
        // Silently continue polling on network glitch
      }
    }, 1500);

    return () => clearInterval(interval);
  }, [isOpen, job?.id, job?.status, notify]);

  if (!isOpen || !job) return null;

  const handleCancel = async () => {
    setCanceling(true);
    try {
      const res = await fetch(`/api/renders/${job.id}/cancel`, {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) {
        const data = await res.json();
        setJob(data.job);
        notify?.("Render job cancelled.");
      }
    } catch (err) {
      notify?.(`Failed to cancel render: ${err.message}`);
    } finally {
      setCanceling(false);
    }
  };

  const handleDownload = () => {
    window.location.href = `/api/renders/${job.id}/output`;
  };

  const verification = job.verification || {};

  if (!isOpen || !job) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="render-modal-backdrop" onClick={onClose}>
      <div
        className="render-modal-container"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="render-modal-header">
          <h2 className="render-modal-title">
            <FilmStrip size={22} weight="fill" color="#6366f1" />
            Backend Headless Render
          </h2>
          <button className="render-modal-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <p className="cloud-modal-description">
          Server-side CLI rendering pipeline executed via FFmpeg with FFprobe verification.
        </p>

        <div className="render-status-card">
          <div className="render-status-row">
            <div>
              <strong>{project?.title || "Project Render"}</strong>
              <div style={{ fontSize: "0.775rem", color: "#71717a" }}>
                Target Revision: {job.requested_revision}
              </div>
            </div>
            <span className={`render-status-badge status-${job.status}`}>
              {job.status}
            </span>
          </div>

          {(job.status === "pending" || job.status === "processing") && (
            <div className="render-progress-indicator">
              <CircleNotch size={20} className="cloud-loading-spinner" color="#6366f1" />
              <span>
                {job.status === "pending"
                  ? "Queued in PostgreSQL, preparing CLI pipeline..."
                  : "Rendering video through FFmpeg engine..."}
              </span>
            </div>
          )}

          {job.status === "completed" && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#4ade80", fontSize: "0.9rem" }}>
                <CheckCircle size={18} weight="fill" />
                <span>FFmpeg render output verified by FFprobe:</span>
              </div>
              <div className="render-verification-grid">
                <div className="render-verification-item">
                  <span className="render-verification-label">Resolution</span>
                  <span className="render-verification-value">
                    {verification.width && verification.height
                      ? `${verification.width} × ${verification.height}`
                      : "Standard"}
                  </span>
                </div>
                <div className="render-verification-item">
                  <span className="render-verification-label">Duration</span>
                  <span className="render-verification-value">
                    {verification.duration ? `${Number(verification.duration).toFixed(2)}s` : "N/A"}
                  </span>
                </div>
                <div className="render-verification-item">
                  <span className="render-verification-label">Video Format</span>
                  <span className="render-verification-value">
                    {verification.formatName || "mp4"} ({verification.videoCodec || "h264"})
                  </span>
                </div>
                <div className="render-verification-item">
                  <span className="render-verification-label">Audio Stream</span>
                  <span className="render-verification-value">
                    {verification.audioCodec ? `${verification.audioCodec} stereo` : "Silent / none"}
                  </span>
                </div>
              </div>
            </>
          )}

          {job.status === "failed" && (
            <div className="render-error-box">
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <WarningCircle size={16} />
                <strong>Render Failed</strong>
              </div>
              <span>{job.error_message || "Execution encountered an error."}</span>
            </div>
          )}

          {job.status === "cancelled" && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#f87171" }}>
              <XCircle size={18} weight="fill" />
              <span>Job cancelled by user.</span>
            </div>
          )}
        </div>

        <div className="render-modal-actions">
          {(job.status === "pending" || job.status === "processing") && (
            <button
              className="cloud-btn cloud-btn-danger"
              onClick={handleCancel}
              disabled={canceling}
            >
              {canceling ? <CircleNotch size={14} className="cloud-loading-spinner" /> : null}
              Cancel Render
            </button>
          )}

          {job.status === "completed" && (
            <button
              className="cloud-btn cloud-btn-primary"
              onClick={handleDownload}
            >
              <DownloadSimple size={16} weight="bold" />
              Download Video (.mp4)
            </button>
          )}

          <button className="cloud-btn cloud-btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
