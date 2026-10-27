import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  ArrowsClockwise,
  CircleNotch,
  Clock,
  Copy,
  DotsThreeVertical,
  DownloadSimple,
  FileArrowUp,
  FilmSlate,
  FolderOpen,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  SignOut,
  Sparkle,
  Trash,
  VideoCamera,
  X,
} from "@phosphor-icons/react";
import "./Dashboard.css";

const RATIO_OPTIONS = [
  { id: "16:9", label: "16:9 Widescreen", sub: "YouTube, Landscape" },
  { id: "9:16", label: "9:16 Portrait", sub: "TikTok, Shorts, Reels" },
  { id: "1:1", label: "1:1 Square", sub: "Instagram, Social Feed" },
  { id: "4:5", label: "4:5 Portrait", sub: "Instagram Post" },
];

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  const remainingS = s % 60;
  return `${String(m).padStart(2, "0")}:${String(remainingS).padStart(2, "0")}`;
}

function formatRelativeTime(dateStr) {
  if (!dateStr) return "Recently";
  try {
    const date = new Date(dateStr);
    const now = new Date();
    const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (diffSec < 60) return "Just now";
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d ago`;

    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    });
  } catch {
    return "Recently";
  }
}

export function Dashboard({
  currentUser,
  onLogout,
  onOpenProject,
  onCreateProject,
  onImportArchive,
  onOpenGeneratedProject,
  notify,
}) {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Filter & Search states
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState("updated"); // "updated" | "title" | "duration"
  const [filterRatio, setFilterRatio] = useState("all");

  // Active menu dropdown
  const [activeMenuId, setActiveMenuId] = useState(null);
  const menuContainerRef = useRef(null);

  // Modals
  const [showNewModal, setShowNewModal] = useState(false);
  const [newTitle, setNewTitle] = useState("Untitled Project");
  const [newRatio, setNewRatio] = useState("16:9");
  const [newFps, setNewFps] = useState(30);

  const [renameTarget, setRenameTarget] = useState(null);
  const [renameTitle, setRenameTitle] = useState("");

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [actionLoading, setActionLoading] = useState(false);

  // Hidden file input for importing .timeline package
  const fileInputRef = useRef(null);

  // Close card action menus when clicking outside
  useEffect(() => {
    function handleClickOutside(e) {
      if (menuContainerRef.current && !menuContainerRef.current.contains(e.target)) {
        setActiveMenuId(null);
      }
    }
    if (activeMenuId) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [activeMenuId]);

  // Fetch projects from backend
  const fetchProjects = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/projects", { credentials: "include" });
      if (!res.ok) {
        if (res.status === 401) {
          onLogout?.();
          return;
        }
        throw new Error(`Failed to load projects (${res.status})`);
      }
      const data = await res.json();
      setProjects(data.projects || []);
    } catch (err) {
      setError(err.message || "Unable to reach server to fetch projects.");
    } finally {
      setLoading(false);
    }
  }, [onLogout]);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  // Client-side filtering and sorting
  const filteredProjects = useMemo(() => {
    let list = [...projects];

    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter((p) => p.title.toLowerCase().includes(q));
    }

    if (filterRatio !== "all") {
      list = list.filter((p) => (p.ratio || "16:9") === filterRatio);
    }

    list.sort((a, b) => {
      if (sortBy === "title") {
        return a.title.localeCompare(b.title);
      }
      if (sortBy === "duration") {
        return (Number(b.duration) || 0) - (Number(a.duration) || 0);
      }
      // default "updated"
      const dateA = new Date(a.updated_at || a.created_at || 0).getTime();
      const dateB = new Date(b.updated_at || b.created_at || 0).getTime();
      return dateB - dateA;
    });

    return list;
  }, [projects, searchQuery, filterRatio, sortBy]);

  // Create Project handler
  const handleCreateSubmit = async (e) => {
    e?.preventDefault();
    if (actionLoading) return;
    const title = newTitle.trim() || "Untitled Project";
    setActionLoading(true);

    try {
      if (onCreateProject) {
        await onCreateProject({ title, ratio: newRatio, fps: newFps });
        setShowNewModal(false);
        return;
      }

      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          title,
          ratio: newRatio,
          fps: Number(newFps) || 30,
          duration: 0,
        }),
      });

      if (!res.ok) {
        throw new Error("Failed to create project on server.");
      }

      const data = await res.json();
      notify?.(`Project "${title}" created.`);
      setShowNewModal(false);
      onOpenProject?.(data.project);
    } catch (err) {
      notify?.(`Error: ${err.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  // Rename Project handler
  const handleRenameSubmit = async (e) => {
    e?.preventDefault();
    if (!renameTarget || actionLoading) return;
    const clean = renameTitle.trim();
    if (!clean) return;

    setActionLoading(true);
    try {
      const res = await fetch(`/api/projects/${renameTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ title: clean }),
      });

      if (!res.ok) {
        throw new Error("Failed to update project title.");
      }

      const data = await res.json();
      setProjects((prev) =>
        prev.map((p) => (p.id === renameTarget.id ? { ...p, title: data.project.title } : p))
      );
      notify?.(`Renamed to "${clean}".`);
      setRenameTarget(null);
    } catch (err) {
      notify?.(`Rename failed: ${err.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  // Duplicate Project handler
  const handleDuplicate = async (project) => {
    setActiveMenuId(null);
    setActionLoading(true);
    notify?.(`Duplicating "${project.title}"...`);

    try {
      const res = await fetch(`/api/projects/${project.id}/duplicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ title: `${project.title} (Copy)` }),
      });

      if (!res.ok) {
        throw new Error("Failed to duplicate project.");
      }

      const data = await res.json();
      setProjects((prev) => [data.project, ...prev]);
      notify?.(`Duplicated as "${data.project.title}".`);
    } catch (err) {
      notify?.(`Duplicate failed: ${err.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  // Delete Project handler
  const handleDeleteConfirm = async () => {
    if (!deleteTarget || actionLoading) return;
    setActionLoading(true);

    try {
      const res = await fetch(`/api/projects/${deleteTarget.id}`, {
        method: "DELETE",
        credentials: "include",
      });

      if (!res.ok) {
        throw new Error("Failed to delete project.");
      }

      setProjects((prev) => prev.filter((p) => p.id !== deleteTarget.id));
      notify?.(`Project "${deleteTarget.title}" deleted.`);
      setDeleteTarget(null);
    } catch (err) {
      notify?.(`Delete failed: ${err.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  // Export .timeline archive handler
  const handleExportArchive = async (project) => {
    setActiveMenuId(null);
    if (!project.archive_storage_path) {
      notify?.("No saved media archive exists for this project yet.");
      return;
    }
    notify?.(`Downloading archive for "${project.title}"...`);

    try {
      const res = await fetch(`/api/projects/${project.id}/archive`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Archive download failed.");

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${project.title || "project"}.timeline`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      notify?.("Archive downloaded successfully.");
    } catch (err) {
      notify?.(`Export error: ${err.message}`);
    }
  };

  // Import local package file
  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      onImportArchive?.(file);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div className="dashboard-container" data-testid="dashboard-root">
      {/* Top Header Navigation */}
      <header className="dashboard-header">
        <div className="dashboard-brand">
          <div className="dashboard-logo-icon">
            <FilmSlate size={22} weight="duotone" />
          </div>
          <div className="dashboard-brand-copy">
            <h1 className="dashboard-title">Timeline Studio</h1>
            <span className="dashboard-badge">Dashboard</span>
          </div>
        </div>

        <div className="dashboard-header-actions">
          <button
            type="button"
            className="dashboard-btn dashboard-btn-outline"
            onClick={() => fileInputRef.current?.click()}
            title="Import an existing .timeline archive"
            data-testid="dashboard-import-btn"
          >
            <FileArrowUp size={16} />
            <span>Import .timeline</span>
          </button>
          <input
            type="file"
            ref={fileInputRef}
            style={{ display: "none" }}
            accept=".timeline,.zip"
            onChange={handleFileChange}
          />


          <button
            type="button"
            className="dashboard-btn dashboard-btn-primary"
            onClick={() => {
              setNewTitle("Untitled Project");
              setNewRatio("16:9");
              setNewFps(30);
              setShowNewModal(true);
            }}
            data-testid="dashboard-new-project-btn"
          >
            <Plus size={16} weight="bold" />
            <span>New Project</span>
          </button>

          <div className="dashboard-user-menu">
            <div className="dashboard-user-badge" title={currentUser?.email || "User"}>
              <span className="dashboard-avatar-initial">
                {(currentUser?.name || currentUser?.email || "U")[0].toUpperCase()}
              </span>
              <span className="dashboard-user-email">{currentUser?.email || "Account"}</span>
            </div>
            <button
              type="button"
              className="dashboard-btn-icon"
              onClick={onLogout}
              title="Sign Out"
              aria-label="Sign Out"
              data-testid="dashboard-logout-btn"
            >
              <SignOut size={16} />
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="dashboard-main">
        {/* Welcome Section */}
        <section className="dashboard-hero">
          <div className="dashboard-hero-content">
            <h2 className="dashboard-hero-title">
              Welcome back, <span>{currentUser?.name || currentUser?.email?.split("@")[0] || "Creator"}</span>
            </h2>
            <p className="dashboard-hero-desc">
              Manage your video timeline projects, revisions, and intelligent automated cuts.
            </p>
          </div>
        </section>

        {/* Toolbar & Filters */}
        <section className="dashboard-toolbar">
          <div className="dashboard-search-wrap">
            <MagnifyingGlass size={16} className="dashboard-search-icon" />
            <input
              type="text"
              className="dashboard-search-input"
              placeholder="Search projects..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              data-testid="dashboard-search-input"
            />
            {searchQuery && (
              <button
                type="button"
                className="dashboard-search-clear"
                onClick={() => setSearchQuery("")}
                aria-label="Clear search"
              >
                <X size={14} />
              </button>
            )}
          </div>

          <div className="dashboard-filters">
            {/* Aspect Ratio Filter Chips */}
            <div className="dashboard-chips" role="tablist" aria-label="Filter by aspect ratio">
              {["all", "16:9", "9:16", "1:1"].map((r) => (
                <button
                  key={r}
                  type="button"
                  className={`dashboard-chip ${filterRatio === r ? "is-active" : ""}`}
                  onClick={() => setFilterRatio(r)}
                  data-testid={`filter-ratio-${r}`}
                >
                  {r === "all" ? "All Formats" : r}
                </button>
              ))}
            </div>

            {/* Sort Selector */}
            <div className="dashboard-sort-wrap">
              <label htmlFor="dashboard-sort-select" className="dashboard-sort-label">Sort:</label>
              <select
                id="dashboard-sort-select"
                className="dashboard-sort-select"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                data-testid="dashboard-sort-select"
              >
                <option value="updated">Last Modified</option>
                <option value="title">Title (A–Z)</option>
                <option value="duration">Duration</option>
              </select>
            </div>

            {/* Refresh Button */}
            <button
              type="button"
              className="dashboard-btn-icon"
              onClick={fetchProjects}
              title="Refresh project list"
              aria-label="Refresh"
            >
              <ArrowsClockwise size={16} className={loading ? "is-spinning" : ""} />
            </button>
          </div>
        </section>

        {/* Project Grid / States */}
        {loading && projects.length === 0 ? (
          <div className="dashboard-loading" data-testid="dashboard-loading">
            <CircleNotch size={32} className="is-spinning" color="#00e5bf" />
            <span>Loading projects from studio database...</span>
          </div>
        ) : error ? (
          <div className="dashboard-error" data-testid="dashboard-error">
            <p>{error}</p>
            <button
              type="button"
              className="dashboard-btn dashboard-btn-outline"
              onClick={fetchProjects}
            >
              <ArrowsClockwise size={16} /> Retry
            </button>
          </div>
        ) : projects.length === 0 ? (
          /* Empty Database State */
          <div className="dashboard-empty" data-testid="dashboard-empty-state">
            <div className="dashboard-empty-icon">
              <FilmSlate size={48} weight="duotone" color="#00e5bf" />
            </div>
            <h3 className="dashboard-empty-title">No projects yet</h3>
            <p className="dashboard-empty-desc">
              Create your first project or import a .timeline package to start editing.
            </p>
            <div className="dashboard-empty-actions">
              <button
                type="button"
                className="dashboard-btn dashboard-btn-primary"
                onClick={() => setShowNewModal(true)}
              >
                <Plus size={16} weight="bold" /> New Project
              </button>
              <button
                type="button"
                className="dashboard-btn dashboard-btn-outline"
                onClick={() => fileInputRef.current?.click()}
              >
                <FileArrowUp size={16} /> Import .timeline
              </button>
            </div>
          </div>
        ) : filteredProjects.length === 0 ? (
          /* Filtered Empty State */
          <div className="dashboard-empty" data-testid="dashboard-no-results">
            <h3 className="dashboard-empty-title">No matching projects</h3>
            <p className="dashboard-empty-desc">
              No projects matched your search &ldquo;{searchQuery}&rdquo;.
            </p>
            <button
              type="button"
              className="dashboard-btn dashboard-btn-outline"
              onClick={() => {
                setSearchQuery("");
                setFilterRatio("all");
              }}
            >
              Clear filters
            </button>
          </div>
        ) : (
          /* Projects Grid */
          <div
            className="dashboard-grid"
            ref={menuContainerRef}
            data-testid="dashboard-projects-grid"
          >
            {filteredProjects.map((project) => {
              const ratio = project.ratio || "16:9";
              const durationFormatted = formatDuration(project.duration);
              const relativeTime = formatRelativeTime(project.updated_at);
              const isMenuOpen = activeMenuId === project.id;

              return (
                <div
                  key={project.id}
                  className="project-card"
                  onClick={() => onOpenProject?.(project)}
                  data-testid={`project-card-${project.id}`}
                >
                  {/* Card Visual Header / Preview */}
                  <div className={`project-card-preview ratio-${ratio.replace(":", "-")}`}>
                    {project.metadata?.thumbnail ? (
                      <img
                        src={project.metadata.thumbnail}
                        alt={project.title}
                        className="project-card-thumb"
                      />
                    ) : (
                      <div className="project-card-placeholder">
                        <VideoCamera size={32} weight="duotone" className="project-placeholder-icon" />
                        <Sparkle size={14} className="project-placeholder-sparkle" />
                      </div>
                    )}

                    {/* Ratio Badge */}
                    <span className="project-badge project-badge-ratio">{ratio}</span>

                    {/* Revision Badge */}
                    <span className="project-badge project-badge-rev">
                      {project.current_revision ? `Rev ${project.current_revision}` : "Draft"}
                    </span>

                    {/* Duration Badge */}
                    {Number(project.duration) > 0 && (
                      <span className="project-badge project-badge-duration">
                        {durationFormatted}
                      </span>
                    )}

                    {/* Hover Play/Open Prompt */}
                    <div className="project-card-hover-overlay">
                      <FolderOpen size={24} weight="fill" />
                      <span>Open in Editor</span>
                    </div>
                  </div>

                  {/* Card Info & Meta */}
                  <div className="project-card-body">
                    <div className="project-card-title-row">
                      <h4 className="project-card-title" title={project.title}>
                        {project.title}
                      </h4>

                      {/* Dropdown Menu Trigger */}
                      <div className="project-card-menu-anchor" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="project-card-menu-btn"
                          aria-label="Project actions"
                          aria-expanded={isMenuOpen}
                          onClick={() => setActiveMenuId(isMenuOpen ? null : project.id)}
                          data-testid={`project-actions-btn-${project.id}`}
                        >
                          <DotsThreeVertical size={18} weight="bold" />
                        </button>

                        {/* Dropdown Menu Popover */}
                        {isMenuOpen && (
                          <div
                            className="project-dropdown-menu"
                            role="menu"
                            data-testid={`project-menu-${project.id}`}
                          >
                            <button
                              type="button"
                              className="project-menu-item"
                              role="menuitem"
                              onClick={() => {
                                setActiveMenuId(null);
                                onOpenProject?.(project);
                              }}
                            >
                              <FolderOpen size={16} /> Open in Editor
                            </button>

                            <button
                              type="button"
                              className="project-menu-item"
                              role="menuitem"
                              onClick={() => {
                                setActiveMenuId(null);
                                setRenameTarget(project);
                                setRenameTitle(project.title);
                              }}
                              data-testid={`project-rename-action-${project.id}`}
                            >
                              <PencilSimple size={16} /> Rename
                            </button>

                            <button
                              type="button"
                              className="project-menu-item"
                              role="menuitem"
                              onClick={() => handleDuplicate(project)}
                              data-testid={`project-duplicate-action-${project.id}`}
                            >
                              <Copy size={16} /> Duplicate
                            </button>

                            <button
                              type="button"
                              className="project-menu-item"
                              role="menuitem"
                              onClick={() => handleExportArchive(project)}
                            >
                              <DownloadSimple size={16} /> Export .timeline
                            </button>

                            <div className="project-menu-divider" />

                            <button
                              type="button"
                              className="project-menu-item is-danger"
                              role="menuitem"
                              onClick={() => {
                                setActiveMenuId(null);
                                setDeleteTarget(project);
                              }}
                              data-testid={`project-delete-action-${project.id}`}
                            >
                              <Trash size={16} /> Delete
                            </button>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="project-card-meta">
                      <span className="project-meta-item">
                        <Clock size={13} />
                        {relativeTime}
                      </span>
                      <span className="project-meta-dot">•</span>
                      <span className="project-meta-item">{project.fps || 30} fps</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {/* MODAL: New Project */}
      {showNewModal && (
        <div className="dashboard-modal-backdrop" onClick={() => setShowNewModal(false)}>
          <div
            className="dashboard-modal-container"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            data-testid="modal-new-project"
          >
            <div className="dashboard-modal-header">
              <h3 className="dashboard-modal-title">
                <Plus size={20} weight="bold" color="#00e5bf" />
                Create New Project
              </h3>
              <button
                type="button"
                className="dashboard-modal-close"
                onClick={() => setShowNewModal(false)}
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>

            <form onSubmit={handleCreateSubmit}>
              <div className="dashboard-modal-body">
                <div className="form-field">
                  <label htmlFor="new-project-title-input" className="form-label">Project Title</label>
                  <input
                    id="new-project-title-input"
                    type="text"
                    className="form-input"
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    placeholder="e.g. Summer Vlog, TikTok Promo"
                    maxLength={255}
                    required
                    autoFocus
                    data-testid="new-project-title-input"
                  />
                </div>

                <div className="form-field">
                  <label className="form-label">Aspect Ratio</label>
                  <div className="ratio-cards-grid">
                    {RATIO_OPTIONS.map((opt) => (
                      <div
                        key={opt.id}
                        className={`ratio-choice-card ${newRatio === opt.id ? "is-selected" : ""}`}
                        onClick={() => setNewRatio(opt.id)}
                        role="button"
                        tabIndex={0}
                        data-testid={`new-ratio-${opt.id}`}
                      >
                        <div className={`ratio-box-preview ratio-box-${opt.id.replace(":", "-")}`} />
                        <div className="ratio-choice-copy">
                          <strong>{opt.label}</strong>
                          <small>{opt.sub}</small>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="form-field">
                  <label htmlFor="new-project-fps-select" className="form-label">Frame Rate (FPS)</label>
                  <select
                    id="new-project-fps-select"
                    className="form-select"
                    value={newFps}
                    onChange={(e) => setNewFps(Number(e.target.value))}
                  >
                    <option value={30}>30 fps (Standard)</option>
                    <option value={60}>60 fps (Smooth / Gaming)</option>
                    <option value={24}>24 fps (Cinematic)</option>
                  </select>
                </div>
              </div>

              <div className="dashboard-modal-footer">
                <button
                  type="button"
                  className="dashboard-btn dashboard-btn-outline"
                  onClick={() => setShowNewModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="dashboard-btn dashboard-btn-primary"
                  disabled={actionLoading || !newTitle.trim()}
                  data-testid="create-project-submit-btn"
                >
                  {actionLoading ? <CircleNotch size={16} className="is-spinning" /> : <Plus size={16} />}
                  <span>Create Project</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: Rename Project */}
      {renameTarget && (
        <div className="dashboard-modal-backdrop" onClick={() => setRenameTarget(null)}>
          <div
            className="dashboard-modal-container"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            data-testid="modal-rename-project"
          >
            <div className="dashboard-modal-header">
              <h3 className="dashboard-modal-title">
                <PencilSimple size={20} color="#00e5bf" />
                Rename Project
              </h3>
              <button
                type="button"
                className="dashboard-modal-close"
                onClick={() => setRenameTarget(null)}
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>

            <form onSubmit={handleRenameSubmit}>
              <div className="dashboard-modal-body">
                <div className="form-field">
                  <label htmlFor="rename-project-input" className="form-label">New Title</label>
                  <input
                    id="rename-project-input"
                    type="text"
                    className="form-input"
                    value={renameTitle}
                    onChange={(e) => setRenameTitle(e.target.value)}
                    maxLength={255}
                    required
                    autoFocus
                    data-testid="rename-title-input"
                  />
                </div>
              </div>

              <div className="dashboard-modal-footer">
                <button
                  type="button"
                  className="dashboard-btn dashboard-btn-outline"
                  onClick={() => setRenameTarget(null)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="dashboard-btn dashboard-btn-primary"
                  disabled={actionLoading || !renameTitle.trim()}
                  data-testid="rename-project-submit-btn"
                >
                  {actionLoading ? <CircleNotch size={16} className="is-spinning" /> : null}
                  <span>Save Changes</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: Delete Project Confirmation */}
      {deleteTarget && (
        <div className="dashboard-modal-backdrop" onClick={() => setDeleteTarget(null)}>
          <div
            className="dashboard-modal-container is-danger"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            data-testid="modal-delete-project"
          >
            <div className="dashboard-modal-header">
              <h3 className="dashboard-modal-title" style={{ color: "#ef4444" }}>
                <Trash size={20} color="#ef4444" weight="fill" />
                Delete Project
              </h3>
              <button
                type="button"
                className="dashboard-modal-close"
                onClick={() => setDeleteTarget(null)}
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>

            <div className="dashboard-modal-body">
              <p className="delete-modal-warning">
                Are you sure you want to permanently delete <strong>&ldquo;{deleteTarget.title}&rdquo;</strong>?
              </p>
              <p className="delete-modal-subwarning">
                This action cannot be undone. All timeline edits, historical version snapshots, and attached assets will be removed.
              </p>
            </div>

            <div className="dashboard-modal-footer">
              <button
                type="button"
                className="dashboard-btn dashboard-btn-outline"
                onClick={() => setDeleteTarget(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="dashboard-btn dashboard-btn-danger"
                onClick={handleDeleteConfirm}
                disabled={actionLoading}
                data-testid="delete-project-confirm-btn"
              >
                {actionLoading ? <CircleNotch size={16} className="is-spinning" /> : <Trash size={16} />}
                <span>Delete Permanently</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
