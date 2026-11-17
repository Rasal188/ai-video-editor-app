import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "@phosphor-icons/react";
import "./ShortsBackgroundNotification.css";

const REGION_ID = "shorts-notification-region";
const COMPLETION_DURATION_MS = 10000;

// A reserved grid row, not a viewport overlay. Multiple cards stack and scroll
// inside the row; the observer also keeps the mobile Assistant drawer below it.
export function ShortsNotificationRegion() {
    const ref = useRef(null);
    useEffect(() => {
        const region = ref.current;
        const shell = region.parentElement;
        const topbar = shell.querySelector(".topbar");
        const update = () => shell.style.setProperty("--shorts-notification-bottom", `${region.getBoundingClientRect().bottom}px`);
        const observer = new ResizeObserver(update);
        observer.observe(region);
        if (topbar) observer.observe(topbar);
        update();
        return () => {
            observer.disconnect();
            shell.style.removeProperty("--shorts-notification-bottom");
        };
    }, []);
    return <section ref={ref} id={REGION_ID} className="shorts-notification-region" aria-label="AI Shorts Studio notifications" />;
}

export function ShortsBackgroundNotification({ running, title, phase, transcriptionStatus, onReview, onCancel, t }) {
    const [target, setTarget] = useState(null);
    const [dismissed, setDismissed] = useState(false);
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);
    const paused = hovered || focused;
    const dismiss = () => {
        setDismissed(true);
        setHovered(false);
        setFocused(false);
    };
    useEffect(() => setTarget(document.getElementById(REGION_ID)), []);
    // A new run/completion replaces the previous notice, rather than accumulating
    // progress messages. Dismissing a notice never closes/cancels the studio.
    useEffect(() => {
        setDismissed(false);
    }, [running]);
    useEffect(() => {
        if (running || dismissed || paused) return undefined;
        const timer = window.setTimeout(() => setDismissed(true), COMPLETION_DURATION_MS);
        return () => window.clearTimeout(timer);
    }, [running, dismissed, paused]);
    if (dismissed) return null;
    const content = (
        <div className="shorts-minimized-floating-banner" data-testid="shorts-background-notification"
            onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
            onFocus={() => setFocused(true)} onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
            }}>
            <div className="shorts-minimized-info" role="status" aria-live="polite" aria-atomic="true">
                {running && <div className="shorts-spinner-sm" aria-hidden="true" />}
                <div className="shorts-minimized-text">
                    <strong>{title}</strong>
                    <span className="shorts-minimized-phase">{phase}</span>
                    {transcriptionStatus && <span>{transcriptionStatus}</span>}
                </div>
            </div>
            <div className="shorts-minimized-actions">
                <button type="button" className="shorts-btn shorts-btn-ghost-sm" onClick={onReview}>
                    {running ? t("shortsViewProgress", "View Progress") : t("shortsReview", "Review")}
                </button>
                {running && <button type="button" className="shorts-btn shorts-btn-ghost-sm shorts-btn-danger-sm" onClick={onCancel}>
                    {t("cancel", "Cancel")}
                </button>}
                <button type="button" className="shorts-btn shorts-btn-ghost-sm" onClick={dismiss}
                    aria-label={t("dismissNotification", "Dismiss notification")} title={t("dismissNotification", "Dismiss notification")}>
                    <X size={16} aria-hidden="true" />
                </button>
            </div>
        </div>
    );
    // Static rendering retains the status disclosure; browsers mount only in the
    // reserved region, never briefly as an overlay at the modal's render site.
    return target ? createPortal(content, target) : typeof window === "undefined" ? content : null;
}
