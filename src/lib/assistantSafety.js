// Shared by the planner UI and the live editor commit boundary. No provider logic.
export function assistantProjectFingerprint(project) {
    const { commandState: _commands, timelineZoom: _zoom, ...content } = project || {};
    return JSON.stringify(content);
}

export function createAssistantProjectClock() {
    let identity = globalThis.crypto.randomUUID();
    let state = { schemaVersion: 1, revision: 0, appliedOperationIds: [] };
    let fingerprint;
    let media;
    let changing = false;
    return {
        observe(project, sources = []) {
            const next = assistantProjectFingerprint(project);
            if (fingerprint !== undefined && (next !== fingerprint || sources.length !== media?.length || sources.some((source, i) => source !== media?.[i]))) {
                state = { ...state, revision: state.revision + 1 };
            }
            fingerprint = next;
            media = sources;
            return { ...state, projectIdentity: identity, changing };
        },
        replace(imported) {
            identity = globalThis.crypto.randomUUID();
            state = { schemaVersion: 1, revision: state.revision + 1, appliedOperationIds: [...(imported?.appliedOperationIds || [])] };
            fingerprint = undefined;
        },
        setChanging(value) { changing = value; },
        commit(next) {
            state = { schemaVersion: 1, revision: next.revision, appliedOperationIds: [...next.appliedOperationIds] };
        },
    };
}

export function captureAssistantBase(project) {
    return {
        projectIdentity: project.commandState?.projectIdentity,
        baseRevision: project.commandState?.revision ?? 0,
        baseFingerprint: assistantProjectFingerprint(project),
    };
}

export function assertAssistantBase(project, plan) {
    if (project.commandState?.changing || !plan.projectIdentity ||
        project.commandState?.projectIdentity !== plan.projectIdentity ||
        project.commandState?.revision !== plan.baseRevision ||
        assistantProjectFingerprint(project) !== plan.baseFingerprint) {
        throw Object.assign(new Error("The project has changed since planning started. Request a new plan before applying edits."), { code: "BROWSER_EDIT_STALE_PLAN" });
    }
}

export const isDestructiveAssistantAction = type => /(?:\.delete|\.remove|\.clear)$/.test(type);

// Never infer a destructive target from the first clip or the current selection
// at approval time. Targets must already be explicit in the reviewed proposal.
export function assertDestructiveAssistantTargets(actions, project) {
    const collections = { visual: "visualSegments", audio: "audioSegments", music: "musicSegments", caption: "captionSegments", marker: "timelineMarkers", overlay: "visualOverlaySegments", sticker: "stickerSegments" };
    for (const action of actions) {
        if (!isDestructiveAssistantAction(action.type)) continue;
        const params = action.params || action;
        const id = params.clipId || params.captionId || params.markerId;
        const collection = collections[action.type.split(".")[0]] || collections[params.track] ||
            (action.type === "clip.delete" ? Object.values(collections).find(key => project[key]?.some(item => item.id === id)) : undefined);
        if (!collection || !id || !project[collection]?.some(item => item.id === id)) {
            throw new Error("Destructive edits require an explicit, existing target in the reviewed plan.");
        }
    }
}

const trackAliases = { visuals: "image", visual: "image", captions: "caption", overlays: "overlay", stickers: "sticker", sourceAudio: "source" };
export function assertAssistantOperationUnlocked(project, operation) {
    const type = operation.type;
    let tracks;
    if (type.startsWith("marker.") || type === "tool.export" || type === "track.set_locked") return;
    if (type.startsWith("project.")) tracks = ["image", "overlay", "caption", "sticker"];
    else if (type.startsWith("visual.") || type === "transition.set" || type === "clip.set_speed" || type === "tool.smart_frame" || type === "tool.scene_detection") tracks = ["image"];
    else if (type === "tool.generate_captions") tracks = ["caption"];
    else if (type.startsWith("tool.")) tracks = ["image", "overlay", "caption", "audio", "source", "music", "sticker"];
    else if (type.startsWith("caption.")) tracks = ["caption"];
    else if (type.startsWith("audio.")) tracks = ["audio"];
    else if (type.startsWith("music.")) tracks = ["music"];
    else if (type.startsWith("overlay.")) tracks = ["overlay"];
    else if (type.startsWith("sticker.")) tracks = ["sticker"];
    else if (type.startsWith("track.") || type.startsWith("timed.")) tracks = [trackAliases[operation.track] || operation.track];
    else if (type.startsWith("clip.")) {
        const id = operation.clipId;
        tracks = [project.audioSegments?.some(item => item.id === id) ? "audio" : project.musicSegments?.some(item => item.id === id) ? "music" : project.visualOverlaySegments?.some(item => item.id === id) ? "overlay" : "image"];
    } else tracks = ["image", "overlay", "caption", "audio", "source", "music", "sticker"];
    const collections = { image: "visualSegments", overlay: "visualOverlaySegments", caption: "captionSegments", audio: "audioSegments", music: "musicSegments", sticker: "stickerSegments" };
    const targetId = operation.clipId || operation.captionId;
    for (const track of tracks) {
        if ((project[collections[track]] || []).some(clip => clip.locked && (!targetId || targetId === "all" || clip.id === targetId))) {
            throw Object.assign(new Error("A targeted clip is locked. Unlock it manually before requesting this edit."), { code: "CLIP_LOCKED" });
        }
        // A lane lock is also a lock, not an assistant bypass. Conservatively guard
        // the collection because mutations can repack or ripple clips across lanes.
        if (Object.entries(project.trackLocks || {}).some(([key, locked]) => locked && (key === track || trackAliases[key] === track || key.startsWith(`${track}-`)))) {
            throw Object.assign(new Error(`The ${track} track is locked. Unlock it manually before requesting this edit.`), { code: "TRACK_LOCKED" });
        }
    }
}

export function assertAssistantChangedTracksUnlocked(before, after) {
    const fields = { image: ["visualSegments"], overlay: ["visualOverlaySegments"], caption: ["captionSegments", "script", "captionStyle", "captionPlacement", "captionSize", "captionsEnabled"], audio: ["audioSegments"], music: ["musicSegments", "musicVolume", "musicStart"], source: ["sourceAudioStart", "sourceAudioVolume"], sticker: ["stickerSegments"] };
    for (const [track, keys] of Object.entries(fields)) {
        if (keys.some(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]))) {
            // Check track/lane locks independently; unchanged locked siblings do not
            // block unrelated edits. Changed or removed locked clips always do.
            assertAssistantOperationUnlocked({ ...before, visualSegments: [], visualOverlaySegments: [], captionSegments: [], audioSegments: [], musicSegments: [], stickerSegments: [] }, { type: "track.set_visibility", track });
            for (const key of keys) {
                if (!Array.isArray(before[key])) continue;
                for (const clip of before[key]) {
                    if (clip.locked && JSON.stringify(clip) !== JSON.stringify(after[key]?.find(item => item.id === clip.id))) {
                        throw Object.assign(new Error("A changed clip is locked."), { code: "CLIP_LOCKED" });
                    }
                }
            }
        }
    }
}

export function prepareAssistantProposal(raw, base, requestId) {
    return {
        ...raw, ...base, approvalId: requestId,
        destructive: Boolean(raw.destructive || raw.actions.some(action => isDestructiveAssistantAction(action.type))),
        actions: raw.actions.map((action, index) => ({ ...action, id: `${requestId}-op-${index}` })),
    };
}
