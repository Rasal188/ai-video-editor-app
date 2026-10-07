import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  CircleNotch,
  Cloud,
  FolderOpen,
  Trash,
  X,
  FileArrowUp,
  Clock,
  ArrowsClockwise,
} from "@phosphor-icons/react";
import "./CloudProjectsModal.css";

export function CloudProjectsModal({
  isOpen,
  onClose,
  currentCloudProjectId = null,
  onOpenProject,
  notify,
}) {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(false);
  const [openingId, setOpeningId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [error, setError] = useState(null);

  const fetchProjects = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/projects", { credentials: "include" });
      if (!res.ok) {
        throw new Error(`Failed to load projects: ${res.statusText}`);
      }
      const data = await res.json();
      setProjects(data.projects || []);
    } catch (err) {
      setError(err.message || "Failed to load cloud projects.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchProjects();
    }
  }, [isOpen]);

  if (!isOpen) return null;
  if (typeof document === "undefined") return null;

  const handleOpen = async (project) => {
    setOpeningId(project.id);
    try {
      notify?.(`Downloading project "${project.title}" from cloud...`);
      const res = await fetch(`/api/projects/${project.id}/archive`, {
        credentials: "include",
      });
      if (!res.ok) {
        throw new Error(
          res.status === 404
            ? "No archive file found for this project in storage."
            : `Failed to download project: ${res.statusText}`
        );
      }
      const blob = await res.blob();
      const file = new File([blob], `${project.title || "project"}.timeline`, {
        type: "application/zip",
      });
      await onOpenProject(file, project);
      notify?.(`Project "${project.title}" loaded successfully.`);
      onClose();
    } catch (err) {
      notify?.(`Failed to open project: ${err.message}`);
    } finally {
      setOpeningId(null);
    }
  };

  const handleDelete = async (project) => {
    if (!window.confirm(`Are you sure you want to delete "${project.title}"?`)) {
      return;
    }
    setDeletingId(project.id);
    try {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        throw new Error(`Failed to delete project: ${res.statusText}`);
      }
      notify?.(`Project "${project.title}" deleted.`);
      setProjects((prev) => prev.filter((p) => p.id !== project.id));
    } catch (err) {
      notify?.(`Failed to delete project: ${err.message}`);
    } finally {
      setDeletingId(null);
    }
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return "";
    try {
      return new Date(dateStr).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return dateStr;
    }
  };

  return createPortal(
    <div className="cloud-modal-backdrop" onClick={onClose}>
      <div
        className="cloud-modal-container"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="cloud-modal-header">
          <h2 className="cloud-modal-title">
            <Cloud size={22} weight="fill" color="#6366f1" />
            Saved Cloud Projects
          </h2>
          <button className="cloud-modal-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <p className="cloud-modal-description">
          Open a saved project from your PostgreSQL database or restore historical revisions.
        </p>

        <div className="cloud-modal-body">
          {loading && projects.length === 0 ? (
            <div className="cloud-empty-state">
              <CircleNotch size={28} className="cloud-loading-spinner" color="#6366f1" />
              <span>Loading your projects from cloud...</span>
            </div>
          ) : error ? (
            <div className="cloud-empty-state" style={{ color: "#f87171" }}>
              <span>{error}</span>
              <button className="cloud-btn cloud-btn-ghost" onClick={fetchProjects}>
                <ArrowsClockwise size={14} /> Retry
              </button>
            </div>
          ) : projects.length === 0 ? (
            <div className="cloud-empty-state">
              <FileArrowUp size={36} color="#52525b" />
              <div>
                <strong>No cloud projects found</strong>
                <p style={{ margin: "4px 0 0", fontSize: "0.8rem", color: "#71717a" }}>
                  Save your current timeline using "Save to Cloud" in the File Menu.
                </p>
              </div>
            </div>
          ) : (
            <div className="cloud-projects-list">
              {projects.map((proj) => {
                const isCurrent = proj.id === currentCloudProjectId;
                const isOpening = openingId === proj.id;
                const isDeleting = deletingId === proj.id;

                return (
                  <div
                    key={proj.id}
                    className={`cloud-project-item ${isCurrent ? "is-current" : ""}`}
                  >
                    <div className="cloud-project-info">
                      <div className="cloud-project-title-row">
                        <span className="cloud-project-title">{proj.title}</span>
                        {isCurrent && (
                          <span className="cloud-project-badge is-active">Active</span>
                        )}
                        <span className="cloud-project-badge">
                          Rev {proj.current_revision}
                        </span>
                      </div>
                      <div className="cloud-project-meta">
                        <span>Ratio: {proj.ratio || "16:9"}</span>
                        <span>•</span>
                        <span>Duration: {Number(proj.duration || 0).toFixed(1)}s</span>
                        <span>•</span>
                        <span title={proj.updated_at}>
                          <Clock size={12} style={{ display: "inline", verticalAlign: "middle", marginRight: 2 }} />
                          {formatDate(proj.updated_at)}
                        </span>
                      </div>
                    </div>

                    <div className="cloud-project-actions">
                      <button
                        className="cloud-btn cloud-btn-primary"
                        onClick={() => handleOpen(proj)}
                        disabled={isOpening || isDeleting}
                      >
                        {isOpening ? (
                          <CircleNotch size={14} className="cloud-loading-spinner" />
                        ) : (
                          <FolderOpen size={14} />
                        )}
                        Open
                      </button>
                      <button
                        className="cloud-btn cloud-btn-danger"
                        onClick={() => handleDelete(proj)}
                        disabled={isOpening || isDeleting}
                        title="Delete project"
                        aria-label="Delete project"
                      >
                        {isDeleting ? (
                          <CircleNotch size={14} className="cloud-loading-spinner" />
                        ) : (
                          <Trash size={14} />
                        )}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
