import { useCallback, useEffect, useMemo, useState } from "react";
import {
    ArrowsClockwise,
    CircleNotch,
    Copy,
    MagnifyingGlass,
    PencilSimple,
    Plus,
    Shapes,
    Trash,
    X,
} from "@phosphor-icons/react";

import {
    deleteOverlayTemplateRequest,
    duplicateOverlayTemplateRequest,
    getOverlayTemplateRequest,
    listOverlayTemplatesRequest,
    updateOverlayTemplateRequest,
} from "../lib/overlayTemplateApi.js";
import { listOverlayTemplateAssetsRequest } from "../lib/overlayTemplateAssetApi.js";
import { createStudioDocument } from "../lib/overlayTemplateStudio.js";
import { describeTemplate } from "../lib/shortsOverlayTemplates.js";
import { OverlayTemplateRenderer } from "./OverlayTemplateRenderer.jsx";
import { OverlayTemplateStudio } from "./OverlayTemplateStudio.jsx";

function getPortableMediaReference(asset) {
    return asset?.assetId
        || asset?.archiveMediaId
        || asset?.checksum
        || asset?.sha256
        || asset?.id
        || "";
}

function collectStudioAssets(...sources) {
    const assets = [];
    const seen = new Set();
    for (const source of sources) {
        for (const asset of Array.isArray(source) ? source : []) {
            const reference = getPortableMediaReference(asset);
            if (
                !reference
                || !["image", "video"].includes(asset?.type)
                || asset?.kind === "vector"
                || seen.has(reference)
            ) {
                continue;
            }
            seen.add(reference);
            assets.push(asset);
        }
    }
    return assets;
}

function formatDuration(seconds) {
    const value = Math.max(0, Number(seconds) || 0);
    return value < 10 ? `${value.toFixed(1)}s` : `${Math.round(value)}s`;
}

function formatUpdatedAt(value) {
    if (!value) return "Recently updated";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Recently updated";
    return date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    });
}

function getTemplateSummary(template) {
    try {
        return describeTemplate(template);
    } catch {
        const elements = Array.isArray(template?.elements) ? template.elements : [];
        const kinds = [...new Set(elements.map((element) => element?.kind).filter(Boolean))];
        return {
            id: template?.id || "",
            name: template?.name || "Untitled template",
            description: template?.description || "",
            aspectRatio: template?.canvas?.aspectRatio || "9:16",
            elementCount: elements.length,
            kinds,
            mediaCount: elements.filter((element) => element?.kind === "media").length,
            vectorCount: elements.filter((element) => element?.kind === "vector").length,
            duration: elements.reduce(
                (maximum, element) => Math.max(maximum, (Number(element?.start) || 0) + (Number(element?.duration) || 0)),
                0,
            ),
            updatedAt: template?.updatedAt,
        };
    }
}

function TemplatePreview({ template, assets }) {
    return (
        <div className="overlay-template-preview" aria-hidden="true">
            <OverlayTemplateRenderer
                template={template}
                assets={assets}
                className="overlay-template-card-renderer"
                ariaLabel=""
            />
        </div>
    );
}

function TemplateCard({ template, assets, busyAction, onApply, onEdit, onRename, onDuplicate, onDelete }) {
    const summary = useMemo(() => getTemplateSummary(template), [template]);
    const busy = busyAction?.id === template.id;

    return (
        <article className="overlay-template-card" data-testid={`overlay-template-card-${template.id}`}>
            <TemplatePreview template={template} assets={assets} />
            <div className="overlay-template-card-copy">
                <div className="overlay-template-card-heading">
                    <strong title={summary.name}>{summary.name}</strong>
                    <span>{summary.aspectRatio}</span>
                </div>
                <p>{summary.description || "Reusable global overlay template"}</p>
                <div className="overlay-template-card-meta">
                    <span>{summary.elementCount} {summary.elementCount === 1 ? "element" : "elements"}</span>
                    <span>{formatDuration(summary.duration)}</span>
                    <span>{formatUpdatedAt(summary.updatedAt)}</span>
                </div>
                <div className="overlay-template-card-actions">
                    <button className="is-primary" type="button" disabled={busy} onClick={() => onApply(template)} aria-label={`Apply ${summary.name} to timeline`}>
                        {busyAction?.type === "apply" && busy ? <CircleNotch className="is-spinning" size={15} /> : <Plus size={15} weight="bold" />}
                        <span>Apply to Timeline</span>
                    </button>
                    <button type="button" disabled={busy} onClick={() => onEdit(template)} aria-label={`Edit ${summary.name}`}>
                        {busyAction?.type === "edit" && busy ? <CircleNotch className="is-spinning" size={15} /> : <PencilSimple size={15} />}
                        <span>Edit</span>
                    </button>
                    <button type="button" disabled={busy} onClick={() => onRename(template)} aria-label={`Rename ${summary.name}`}>
                        <PencilSimple size={15} />
                        <span>Rename</span>
                    </button>
                    <button type="button" disabled={busy} onClick={() => onDuplicate(template)} aria-label={`Duplicate ${summary.name}`}>
                        {busyAction?.type === "duplicate" && busy ? <CircleNotch className="is-spinning" size={15} /> : <Copy size={15} />}
                        <span>Duplicate</span>
                    </button>
                    <button className="is-danger" type="button" disabled={busy} onClick={() => onDelete(template)} aria-label={`Delete ${summary.name}`}>
                        <Trash size={15} />
                        <span>Delete</span>
                    </button>
                </div>
            </div>
        </article>
    );
}

function RenameDialog({ template, busy, error, onCancel, onSubmit }) {
    const [name, setName] = useState(template.name || "");
    const [description, setDescription] = useState(template.description || "");

    return (
        <div className="overlay-template-dialog-backdrop" role="presentation" onMouseDown={onCancel}>
            <section
                className="overlay-template-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="overlay-template-rename-title"
                onMouseDown={(event) => event.stopPropagation()}
            >
                <header>
                    <div>
                        <span>Global template</span>
                        <h3 id="overlay-template-rename-title">Rename template</h3>
                    </div>
                    <button type="button" aria-label="Close rename dialog" onClick={onCancel} disabled={busy}><X size={18} /></button>
                </header>
                <form onSubmit={(event) => {
                    event.preventDefault();
                    onSubmit({ name: name.trim(), description: description.trim() });
                }}>
                    <label>
                        <span>Name</span>
                        <input autoFocus maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
                    </label>
                    <label>
                        <span>Description</span>
                        <textarea maxLength={500} rows={3} value={description} onChange={(event) => setDescription(event.target.value)} />
                    </label>
                    {error ? <p className="overlay-template-dialog-error" role="alert">{error}</p> : null}
                    <div className="overlay-template-dialog-actions">
                        <button className="panel-secondary" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
                        <button className="panel-primary" type="submit" disabled={busy || !name.trim()}>
                            {busy ? <CircleNotch className="is-spinning" size={16} /> : null}
                            Save changes
                        </button>
                    </div>
                </form>
            </section>
        </div>
    );
}

function DeleteDialog({ template, busy, error, onCancel, onConfirm }) {
    return (
        <div className="overlay-template-dialog-backdrop" role="presentation" onMouseDown={onCancel}>
            <section
                className="overlay-template-dialog"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="overlay-template-delete-title"
                aria-describedby="overlay-template-delete-description"
                onMouseDown={(event) => event.stopPropagation()}
            >
                <header>
                    <div>
                        <span>Permanent action</span>
                        <h3 id="overlay-template-delete-title">Delete template?</h3>
                    </div>
                    <button type="button" aria-label="Close delete dialog" onClick={onCancel} disabled={busy}><X size={18} /></button>
                </header>
                <p id="overlay-template-delete-description">
                    “{template.name}” will be removed from your global library. Existing projects are not changed.
                </p>
                {error ? <p className="overlay-template-dialog-error" role="alert">{error}</p> : null}
                <div className="overlay-template-dialog-actions">
                    <button className="panel-secondary" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
                    <button className="panel-danger" type="button" onClick={onConfirm} disabled={busy}>
                        {busy ? <CircleNotch className="is-spinning" size={16} /> : <Trash size={16} />}
                        Delete template
                    </button>
                </div>
            </section>
        </div>
    );
}

export function OverlayTemplateLibrary({
    notify = null,
    onApplyTemplate = null,
    userAssets = [],
    visualSegments = [],
    visualOverlaySegments = [],
}) {
    const [templates, setTemplates] = useState([]);
    const [query, setQuery] = useState("");
    const [activeSearch, setActiveSearch] = useState("");
    const [status, setStatus] = useState("loading");
    const [error, setError] = useState("");
    const [busyAction, setBusyAction] = useState(null);
    const [renameTarget, setRenameTarget] = useState(null);
    const [deleteTarget, setDeleteTarget] = useState(null);
    const [dialogError, setDialogError] = useState("");
    const [studioTemplate, setStudioTemplate] = useState(null);
    const [draft, setDraft] = useState(null);
    const [templateAssets, setTemplateAssets] = useState([]);
    const studioAssets = useMemo(
        () => collectStudioAssets(
            templateAssets,
            userAssets,
            visualSegments,
            visualOverlaySegments,
        ),
        [templateAssets, userAssets, visualOverlaySegments, visualSegments],
    );

    const loadTemplates = useCallback(async (search = activeSearch) => {
        setStatus("loading");
        setError("");
        try {
            const result = await listOverlayTemplatesRequest({ search });
            setTemplates(result);
            setStatus("ready");
        } catch (loadError) {
            setError(loadError?.message || "Templates could not be loaded.");
            setStatus("error");
        }
    }, [activeSearch]);

    useEffect(() => {
        loadTemplates(activeSearch);
    }, [activeSearch, loadTemplates]);

    useEffect(() => {
        let active = true;
        listOverlayTemplateAssetsRequest()
            .then((result) => {
                if (active) setTemplateAssets(result);
            })
            .catch(() => {
                if (active) setTemplateAssets([]);
            });
        return () => {
            active = false;
        };
    }, []);

    const submitSearch = (event) => {
        event.preventDefault();
        const clean = query.trim();
        if (clean === activeSearch) {
            loadTemplates(clean);
            return;
        }
        setActiveSearch(clean);
    };

    const openNewStudio = () => {
        const blank = createStudioDocument({
            name: "Untitled Template",
            description: "",
        });
        setDraft(null);
        setStudioTemplate(blank);
    };

    const openTemplate = async (template) => {
        setBusyAction({ id: template.id, type: "edit" });
        setError("");
        try {
            const complete = await getOverlayTemplateRequest(template.id);
            setStudioTemplate(complete);
        } catch (actionError) {
            const message = actionError?.message || "Template could not be opened.";
            setError(message);
            notify?.(message);
        } finally {
            setBusyAction(null);
        }
    };

    const applyTemplate = async (template) => {
        if (typeof onApplyTemplate !== "function") {
            const message = "Template application is unavailable in this editor.";
            setError(message);
            notify?.(message);
            return;
        }
        setBusyAction({ id: template.id, type: "apply" });
        setError("");
        try {
            const complete = await getOverlayTemplateRequest(template.id);
            const result = await onApplyTemplate(complete);
            if (result?.applied === false) {
                setError(result.warnings?.[0] || "Template could not be applied to the timeline.");
            }
        } catch (actionError) {
            const message = actionError?.message || "Template could not be applied to the timeline.";
            setError(message);
            notify?.(message);
        } finally {
            setBusyAction(null);
        }
    };

    const upsertSavedTemplate = useCallback((saved) => {
        setTemplates((current) => {
            const exists = current.some((item) => item.id === saved.id);
            return exists
                ? current.map((item) => item.id === saved.id ? saved : item)
                : [saved, ...current];
        });
        setDraft(null);
        setStudioTemplate(saved);
    }, []);

    const duplicateTemplate = async (template) => {
        setBusyAction({ id: template.id, type: "duplicate" });
        try {
            const duplicated = await duplicateOverlayTemplateRequest(template.id);
            setTemplates((current) => [duplicated, ...current]);
            notify?.(`Duplicated as “${duplicated.name}”.`);
        } catch (actionError) {
            setError(actionError?.message || "Template could not be duplicated.");
            notify?.(actionError?.message || "Template could not be duplicated.");
        } finally {
            setBusyAction(null);
        }
    };

    const renameTemplate = async (updates) => {
        if (!renameTarget) return;
        setBusyAction({ id: renameTarget.id, type: "rename" });
        setDialogError("");
        try {
            const updated = await updateOverlayTemplateRequest(renameTarget.id, updates);
            setTemplates((current) => current.map((item) => item.id === updated.id ? updated : item));
            setRenameTarget(null);
            notify?.(`Renamed to “${updated.name}”.`);
        } catch (actionError) {
            setDialogError(actionError?.message || "Template could not be updated.");
        } finally {
            setBusyAction(null);
        }
    };

    const deleteTemplate = async () => {
        if (!deleteTarget) return;
        setBusyAction({ id: deleteTarget.id, type: "delete" });
        setDialogError("");
        try {
            await deleteOverlayTemplateRequest(deleteTarget.id);
            setTemplates((current) => current.filter((item) => item.id !== deleteTarget.id));
            notify?.(`Template “${deleteTarget.name}” deleted.`);
            setDeleteTarget(null);
        } catch (actionError) {
            setDialogError(actionError?.message || "Template could not be deleted.");
        } finally {
            setBusyAction(null);
        }
    };

    const clearSearch = () => {
        setQuery("");
        if (activeSearch) setActiveSearch("");
    };

    const handleStudioDraftChange = useCallback((document, state) => {
        if (!state.dirty) return;
        setDraft((current) => (
            current?.dirty && current.document === document
                ? current
                : { document, dirty: true }
        ));
    }, []);

    const handleStudioBack = useCallback(({ document, dirty }) => {
        setDraft(dirty ? { document, dirty: true } : null);
        setStudioTemplate(null);
    }, []);

    const handleTemplateAssetUploaded = useCallback((asset) => {
        setTemplateAssets((current) => collectStudioAssets([asset], current));
    }, []);

    if (studioTemplate) {
        return (
            <OverlayTemplateStudio
                key={studioTemplate.id || "new-template"}
                initialTemplate={studioTemplate}
                assets={studioAssets}
                notify={notify}
                onAssetUploaded={handleTemplateAssetUploaded}
                onSaved={upsertSavedTemplate}
                onDraftChange={handleStudioDraftChange}
                onBack={handleStudioBack}
            />
        );
    }

    return (
        <section className="tool-panel overlay-template-library" data-testid="overlay-template-library">
            <header className="overlay-template-library-header">
                <div>
                    <span>Global library</span>
                    <h2>Overlay Templates</h2>
                    <p>Available in every project for your account.</p>
                </div>
                <button
                    className="overlay-template-refresh"
                    type="button"
                    onClick={() => loadTemplates(activeSearch)}
                    disabled={status === "loading"}
                    aria-label="Refresh overlay templates"
                >
                    {status === "loading" ? <CircleNotch className="is-spinning" size={17} /> : <ArrowsClockwise size={17} />}
                </button>
            </header>

            <button className="overlay-template-create" type="button" onClick={openNewStudio}>
                <Plus size={17} weight="bold" />
                <span>Create Custom Template</span>
            </button>

            {draft ? (
                <div className="overlay-template-draft" role="status">
                    <div>
                        <strong>Unsaved Studio draft</strong>
                        <span>{draft.document.name || "Untitled Template"}</span>
                    </div>
                    <button type="button" onClick={() => setStudioTemplate(draft.document)}>Resume</button>
                    <button className="is-danger" type="button" onClick={() => setDraft(null)}>Discard</button>
                </div>
            ) : null}

            <form className="overlay-template-search" role="search" onSubmit={submitSearch}>
                <MagnifyingGlass size={16} />
                <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search templates"
                    aria-label="Search overlay templates"
                    maxLength={120}
                />
                {query ? <button type="button" onClick={clearSearch} aria-label="Clear template search"><X size={15} /></button> : null}
            </form>

            {activeSearch ? (
                <div className="overlay-template-search-summary">
                    <span>Results for “{activeSearch}”</span>
                    <button type="button" onClick={clearSearch}>Clear</button>
                </div>
            ) : null}

            {status === "loading" ? (
                <div className="overlay-template-library-state" role="status">
                    <CircleNotch className="is-spinning" size={22} />
                    <strong>Loading templates…</strong>
                    <span>Syncing your global library.</span>
                </div>
            ) : status === "error" ? (
                <div className="overlay-template-library-state is-error" role="alert">
                    <strong>Unable to load templates</strong>
                    <span>{error}</span>
                    <button className="panel-secondary" type="button" onClick={() => loadTemplates(activeSearch)}>Try again</button>
                </div>
            ) : templates.length === 0 ? (
                <div className="empty-state overlay-template-empty">
                    <Shapes size={25} />
                    <strong>{activeSearch ? "No matching templates" : "No templates yet"}</strong>
                    <span>{activeSearch ? "Try another search or clear the filter." : "Create a custom composition or save an overlay from the Effects panel."}</span>
                    {activeSearch ? <button className="panel-secondary" type="button" onClick={clearSearch}>Clear search</button> : <button className="panel-secondary" type="button" onClick={openNewStudio}>Create template</button>}
                </div>
            ) : (
                <div className="overlay-template-card-list" aria-live="polite">
                    {templates.map((template) => (
                        <TemplateCard
                            key={template.id}
                            template={template}
                            assets={studioAssets}
                            busyAction={busyAction}
                            onApply={applyTemplate}
                            onEdit={openTemplate}
                            onRename={(target) => {
                                setDialogError("");
                                setRenameTarget(target);
                            }}
                            onDuplicate={duplicateTemplate}
                            onDelete={(target) => {
                                setDialogError("");
                                setDeleteTarget(target);
                            }}
                        />
                    ))}
                </div>
            )}

            {status === "ready" && error ? <p className="overlay-template-inline-error" role="alert">{error}</p> : null}

            {renameTarget ? (
                <RenameDialog
                    key={renameTarget.id}
                    template={renameTarget}
                    busy={busyAction?.type === "rename"}
                    error={dialogError}
                    onCancel={() => {
                        if (busyAction?.type === "rename") return;
                        setRenameTarget(null);
                        setDialogError("");
                    }}
                    onSubmit={renameTemplate}
                />
            ) : null}

            {deleteTarget ? (
                <DeleteDialog
                    template={deleteTarget}
                    busy={busyAction?.type === "delete"}
                    error={dialogError}
                    onCancel={() => {
                        if (busyAction?.type === "delete") return;
                        setDeleteTarget(null);
                        setDialogError("");
                    }}
                    onConfirm={deleteTemplate}
                />
            ) : null}
        </section>
    );
}
