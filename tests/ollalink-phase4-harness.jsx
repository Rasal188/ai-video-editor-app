import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { DiarizationPanel } from "../src/components/DiarizationPanel.jsx";
import { encodeCloudWav } from "../src/lib/cloudTranscriptionAudio.js";

const blob = encodeCloudWav(new Float32Array(64000));
function Harness() {
    const [source, setSource] = useState({ segmentId: "audio-1", track: "audio", blob, start: 10, sourceStart: 0, duration: 4, playbackRate: 1 });
    const [captions, setCaptions] = useState([
        { id: "a", text: "First speaker", start: 10.5, end: 11.5, audioSegmentId: "audio-1", words: [{ text: "First", start: 10.5, end: 11 }] },
        { id: "b", text: "Second speaker", start: 12.5, end: 13.5, audioSegmentId: "audio-1" },
        { id: "manual", text: "Manual", start: 10.5, end: 11, audioSegmentId: "audio-1", speaker: "Alice" },
    ]);
    const [locked, setLocked] = useState(false);
    const [mounted, setMounted] = useState(true);
    const applyCalls = useRef(0);
    const applyCaptions = update => { applyCalls.current++; setCaptions(update); };
    window.fixture = { source, captions, setCaptions, setSource, setLocked, setMounted, applyCalls };
    return <>{mounted ? <DiarizationPanel source={source} captions={captions} locked={locked} setCaptions={applyCaptions} /> : null}</>;
}
createRoot(document.getElementById("root")).render(<Harness />);
