import { useState } from "react";
import { createRoot } from "react-dom/client";

import { OverlayTemplateLibrary } from "../src/components/OverlayTemplateLibrary.jsx";
import { instantiateTemplate } from "../src/lib/shortsOverlayTemplates.js";
import "../src/styles.css";

const restoredProjectVisuals = [{
    id: "segment-restored-logo",
    assetId: "asset-restored-logo",
    archiveMediaId: "archive-restored-logo",
    name: "Restored project logo",
    type: "image",
    src: "/scripts/fixtures/test-reference-image.png",
    width: 320,
    height: 180,
    duration: 4,
}];

const initialOverlay = {
    id: "existing-overlay",
    name: "Existing overlay",
    kind: "vector",
    type: "image",
    src: "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2010%2010'%3E%3C/svg%3E",
    start: 1,
    duration: 8,
    lane: 0,
    width: 10,
    height: 10,
    baseTransform: { x: 0, y: 0, scale: 0.2, rotation: 0, opacity: 1 },
    keyframes: [],
};

function Harness() {
    const [project, setProject] = useState("project-a");
    const [notifications, setNotifications] = useState([]);
    const [visualOverlaySegments, setVisualOverlaySegments] = useState([initialOverlay]);
    const [overlayLocked, setOverlayLocked] = useState(false);

    const applyTemplate = (template) => {
        const result = instantiateTemplate({
            template,
            existingOverlays: visualOverlaySegments,
            assets: restoredProjectVisuals,
            startTime: 5,
            trackLocks: { overlay: overlayLocked },
        });
        if (result.applied) setVisualOverlaySegments(result.overlays);
        else setNotifications((items) => [...items, result.warnings[0]]);
        return result;
    };

    window.overlayTemplateFixture = {
        project,
        notifications,
        userAssets: [],
        visualSegments: restoredProjectVisuals,
        visualOverlaySegments,
        overlayLocked,
    };

    return (
        <main style={{ width: 320, height: 720, padding: 16, background: "#080d13" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
                <span data-testid="active-project">{project}</span>
                <button type="button" onClick={() => setProject((value) => value === "project-a" ? "project-b" : "project-a")}>
                    Switch project
                </button>
                <button type="button" onClick={() => setOverlayLocked((value) => !value)}>
                    {overlayLocked ? "Unlock overlay track" : "Lock overlay track"}
                </button>
            </div>
            <OverlayTemplateLibrary
                key={project}
                notify={(message) => setNotifications((items) => [...items, message])}
                userAssets={[]}
                visualSegments={restoredProjectVisuals}
                visualOverlaySegments={visualOverlaySegments}
                onApplyTemplate={applyTemplate}
            />
        </main>
    );
}

createRoot(document.getElementById("root")).render(<Harness />);
