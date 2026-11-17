import { useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../src/App.jsx";
import { SubtitleTextTools } from "../src/components/SubtitleTextTools.jsx";
import "../src/styles.css";

export function CaptionToolsHarness() {
    const [captions, setCaptions] = useState([]);
    const [selected, setSelected] = useState("c1");
    const [locked, setLocked] = useState(false);
    const [mounted, setMounted] = useState(true);
    const [identity, setIdentity] = useState("project-one");
    window.__captionHarness = { setCaptions, setSelected, setLocked, setMounted, setIdentity, captions };
    return mounted ? <SubtitleTextTools captions={captions} selectedCaptionId={selected} locked={locked}
        setCaptions={setCaptions} updateScript={text => { window.__captionScript = text; }}
        getProjectIdentity={() => identity} /> : null;
}

const editor = new URLSearchParams(location.search).has("editor");
if (editor) {
    const response = await fetch("/__caption_fixture.timeline");
    const file = new File([await response.blob()], "caption-fixture.timeline", { type: "application/zip" });
    createRoot(document.getElementById("root")).render(<App initialImportFile={file}
        currentUser={{ id: "caption-verification", email: "caption@example.invalid" }} />);
} else {
    createRoot(document.getElementById("root")).render(<CaptionToolsHarness />);
}
