import { useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../src/App.jsx";
import { ShortsBackgroundNotification } from "../src/components/ShortsBackgroundNotification.jsx";
import "../src/styles.css";

// Test-only additional producers prove that cards share the same bounded region.
export function ExtraNotices() {
    const [count, setCount] = useState(0);
    window.__extraShortsNotices = setCount;
    return Array.from({ length: count }, (_, index) => <ShortsBackgroundNotification
        key={index} running={false} title={`Additional completion ${index + 1}`}
        phase="Candidate moments ready" transcriptionStatus="Transcript ready — Ollalink fast."
        onReview={() => { window.__extraReview = index; }} t={(_key, fallback) => fallback}
    />);
}

createRoot(document.getElementById("root")).render(<>
    <App currentUser={{ id: "shorts-notification-test", email: "test@example.invalid" }} />
    <ExtraNotices />
</>);
