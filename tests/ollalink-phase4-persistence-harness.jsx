import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { DiarizationPanel } from "../src/components/DiarizationPanel.jsx";
import { useProjectFiles } from "../src/hooks/useProjectFiles.js";
import { encodeCloudWav } from "../src/lib/cloudTranscriptionAudio.js";
import { readProjectArchive } from "../src/lib/projectArchive.js";
import { downloadCaptionSrt } from "../src/lib/captionSrtDownload.js";
import { inspectTranscript } from "../src/lib/projectCommandEngine.js";

// Only editor state/UI scaffolding is test-owned. Persistence, decoding, worker,
// diarization review/apply, and downloads below are unmodified production paths.
const wav = encodeCloudWav(Float32Array.from({ length: 96000 }, (_, i) => Math.sin(i * 0.09) * 0.1));
const initialCaptions = [
    { id: "a", text: "First speaker!", start: 10.5, end: 11.5, audioSegmentId: "audio-1", fontId: "default", styleOverrides: { color: "#ffcc00" }, words: [{ text: "First", start: 10.5, end: 11 }, { text: "speaker!", start: 11, end: 11.5 }] },
    { id: "b", text: "Second speaker?", start: 12.5, end: 13.5, audioSegmentId: "audio-1", fontId: "default" },
    { id: "manual", text: "Manual label.", start: 10.5, end: 11, audioSegmentId: "audio-1", fontId: "default", speaker: "Alice", speakerId: "manual-alice" },
    { id: "crossing", text: "Across a turn", start: 11.8, end: 12.2, audioSegmentId: "audio-1", fontId: "default" },
    { id: "unlinked", text: "Unlinked", start: 10.5, end: 11, fontId: "default" },
];
const initialState = {
    script: "Persistence acceptance", captionSegments: initialCaptions,
    audioSegments: [{ id: "audio-1", name: "real-native.wav", blob: wav, url: URL.createObjectURL(wav), start: 10, sourceStart: 1, sourceDuration: 4, duration: 4, playbackRate: 1, volume: 0.7 }],
    visualSegments: [], visualOverlaySegments: [], musicSegments: [], stickerSegments: [],
    captionStyle: { fontId: "default" }, captionSize: 22, captionPosition: "bottom", captionPlacement: { x: 50, y: 78 }, captionsEnabled: true,
    captionStylePresetId: "classic", captionStylePresets: [], selectedVoiceId: "", speed: 1, volume: 1, ratioId: "16:9", fitMode: "contain",
    trackLocks: {}, trackVisibility: {}, timelineMarkers: [{ id: "mark", time: 11, label: "Retain" }], timelineZoom: 1, audioDuration: 14,
    musicVolume: 0.35, sourceAudioVolume: 1, sourceAudioLinked: true,
};
const setterFields = [
    ...Object.keys(initialState), "selectedSegmentId", "timelineHorizon", "selectedFilterId", "selectedTransitionId", "selectedStickerId",
    "imageDuration", "imageClipCount", "currentVisualAsset", "selectedVisualOverlayId", "selectedAudioSegmentId", "musicStart",
    "sourceAudioSpatialEffect", "sourceAudioSpatialAmount", "sourceAudioAssetId", "currentTime", "showFileMenu", "isPlaying",
];
function Harness({ initialProject }) {
    const [state, setState] = useState(initialState);
    const [notifications, setNotifications] = useState([]);
    const [panel, setPanel] = useState(true);
    const projectFileInputRef = useRef(null);
    const imageUrlRefs = useRef(new Set());
    const setField = (key, value) => setState(current => ({ ...current, [key]: typeof value === "function" ? value(current[key]) : value }));
    const setters = Object.fromEntries(setterFields.map(key => [`set${key[0].toUpperCase()}${key.slice(1)}`, value => setField(key, value)]));
    const files = useProjectFiles({
        ...state, ...setters, initialProject, projectFileInputRef, imageUrlRefs, language: "en",
        notify: message => setNotifications(current => [...current, message]),
        clearSourceAudioTrack: () => setState(current => ({ ...current, sourceAudioBlob: null })),
        clearMusicTrack: () => setState(current => ({ ...current, musicBlob: null, musicSegments: [] })),
        clearAllVisionState: () => { }, pauseTimelineMedia: () => { },
    });
    const audio = state.audioSegments[0];
    const source = audio ? { segmentId: audio.id, track: "audio", name: audio.name, blob: audio.blob, start: audio.start, sourceStart: audio.sourceStart, duration: audio.duration, playbackRate: audio.playbackRate } : null;
    window.persistence = {
        state, files, notifications, setState, setPanel, initialCaptions,
        inspect: () => inspectTranscript(files.getProjectSnapshot()),
        archive: async () => {
            const blob = await files.createCurrentArchive();
            const archive = await readProjectArchive(blob);
            return { payload: archive.payload, audio: await Promise.all([...archive.audioSegmentMedia].map(async ([id, media]) => ({ id, type: media.blob.type, bytes: [...new Uint8Array(await media.blob.arrayBuffer())] }))) };
        },
    };
    return <>
        {panel ? <DiarizationPanel source={source} captions={state.captionSegments} locked={Boolean(state.trackLocks.caption)} setCaptions={setters.setCaptionSegments} /> : null}
        <button onClick={files.handleExportProject}>Download project</button>
        <button onClick={() => downloadCaptionSrt(state.captionSegments, 14)}>Download SRT</button>
        <button onClick={() => files.saveProjectToCloud("Acceptance fixture")}>Save cloud</button>
        <input aria-label="Import project" ref={projectFileInputRef} type="file" onChange={event => files.handleImportProject(event.target.files[0])} />
        <output aria-label="Import progress">{files.projectImportProgress?.phase || "idle"}</output>
        <output aria-label="Notifications">{notifications.join("\n")}</output>
    </>;
}
const cloud = new URLSearchParams(location.search).has("cloud");
createRoot(document.getElementById("root")).render(<Harness initialProject={cloud ? { id: "mock-project", title: "Acceptance fixture", ratio: "16:9", current_revision: 1 } : null} />);
