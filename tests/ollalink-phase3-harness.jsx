import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { VoiceSynthesisPanel } from "../src/components/panels.jsx";
import { createAudioTrackActions } from "../src/lib/audioTrackActions.js";

export function Harness() {
    const [script, setScript] = useState("Hello cloud.");
    const [status, setStatus] = useState("ready");
    const [speed, setSpeed] = useState(1.2);
    const [volume, setVolume] = useState(2);
    const [selected, setSelected] = useState("one");
    const [captionMode, setCaptionMode] = useState(false);
    const [mounted, setMounted] = useState(true);
    const [audio, setAudio] = useState([]);
    const [captions, setCaptions] = useState([{ id: "one", text: "Hello cloud.", start: 2, end: 3 }]);
    const [history, setHistory] = useState([]);
    const [locked, setLocked] = useState(false);
    const owner = useRef(null);
    const latest = useRef(null);
    latest.current = { script, selected, locked, captions };
    const endRef = useRef(0);
    const caption = captionMode ? captions.find(item => item.id === selected) : undefined;
    const voice = { id: "local", name: "Local voice", engine: "piper", detail: "Local", language: "English" };
    const actions = createAudioTrackActions({
        selectedVoiceId: "local", selectedVoice: voice, script, audioSegments: audio,
        audioSegmentRefs: { current: new Map() }, currentTimeRef: { current: 0 }, generatedVoiceEndRef: endRef,
        setAudioSegments: setAudio, setCaptionSegments: setCaptions, setHistoryItems: setHistory,
        setSelectedAudioSegmentId() { }, setSelectedTrack() { }, setCurrentTime() { },
        setStatus, setStatusText() { }, setProgress() { }, setSelectedSegmentId: setSelected, t: key => key,
    });
    const begin = ({ input, signal, shouldCommit }) => {
        if (owner.current || locked) return null;
        const token = {};
        const snapshot = latest.current;
        owner.current = token;
        setStatus("generating");
        const end = () => { if (owner.current === token) { owner.current = null; setStatus("ready"); } };
        return {
            end,
            async commit(blob, result) {
                const name = `Ollalink · ${result.voice} (${result.language})`;
                const guard = () => shouldCommit() && owner.current === token && !latest.current.locked
                    && latest.current.script === snapshot.script && latest.current.selected === snapshot.selected;
                if (!guard()) return false;
                await actions.commitAudioBatch([{ blob, script: input }], name, {
                    signal, shouldCommit: guard, captionSegment: caption, gapSeconds: 0,
                    sourceKind: "ollalink-voiceover", voiceId: `ollalink:${result.voice}`, voiceName: name, name,
                });
                return true;
            },
        };
    };
    window.fixture = {
        setScript, setSelected, setMounted, setLocked, setCaptionMode,
        state: { status, speed, volume, audio: audio.map(({ blob: _blob, ...rest }) => rest), captions, history: history.map(({ blob: _blob, ...rest }) => rest) },
    };
    return <>
        <button onClick={() => setMounted(value => !value)}>Toggle mount</button>
        {mounted ? <VoiceSynthesisPanel script={caption?.text ?? script} updateScript={setScript}
            selectedVoiceId="local" setSelectedVoiceId={() => { }} selectedVoice={voice} filteredVoices={[voice]}
            voiceFilter="all" setVoiceFilter={() => { }} showVoiceFilter={false} setShowVoiceFilter={() => { }}
            speed={speed} setSpeed={setSpeed} volume={volume} setVolume={setVolume} status={status}
            progressPercent={0} audioBlob={audio.at(-1)?.blob} audioUrl={audio.at(-1)?.url}
            generateVoiceover={() => { window.localCalls = (window.localCalls || 0) + 1; }} downloadBlob={() => { window.downloads = (window.downloads || 0) + 1; }}
            favoriteVoiceIds={[]} setFavoriteVoiceIds={() => { }} voiceProfiles={[]}
            toggleVoiceProfileFavorite={() => { }} setSelectedVoiceProfileId={() => { }}
            selectedVoiceProfile={{ id: "saved-clone", name: "Saved clone" }} clearSelectedVoiceProfile={() => { }}
            beginOllalinkSpeech={begin} selectionKey={selected} captionSegment={caption} t={(key, fallback) => fallback || key}
        /> : null}
    </>;
}
createRoot(document.getElementById("root")).render(<Harness />);
