import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_SCRIPT, DEFAULT_TIMELINE_DURATION_SECONDS, normalizeVoiceId, RATIO_OPTIONS, VOICES } from "../config/editor.js";
import { decodeWaveform, downloadBlob } from "../lib/media.js";
import { createProjectArchive, readProjectArchive, readProjectFileAsText, resolveProjectVisualMedia } from "../lib/projectArchive.js";
import { createCaptionSegments, getImageThumbnailCount, getVisualSegmentsTotal } from "../lib/timeline.js";
import { normalizeSmartFrame } from "../lib/smartFrame.js";
import { normalizeTrackLocks, normalizeTrackVisibility } from "../lib/projectTrackState.js";
import { normalizeTimelineMarkers } from "../lib/timelineMarkers.js";
import { PROJECT_IMPORT_COPY } from "../i18nProjectImport.js";

const waitForProjectPaint = () => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(resolve));
});

export function useProjectFiles(deps) {
  const [projectImportProgress, setProjectImportProgress] = useState(null);
  const importingRef = useRef(false);
  const commandStateRef = useRef({ schemaVersion: 1, revision: 0, appliedOperationIds: [] });
  const [currentCloudProject, setCurrentCloudProject] = useState(deps.initialProject || null);
  const [savingToCloud, setSavingToCloud] = useState(false);
  const initialLoadedRef = useRef(false);


  const getProjectSnapshot = useCallback(() => {
    const visualSegments = deps.visualSegments.map(({ blob, trackFrames, src, cutoutVisual, enhancement: _enhancement, ...segment }) => segment);
    const visualOverlaySegments = deps.visualOverlaySegments.map(({ blob, src, ...segment }) => segment);
    const audioSegments = deps.audioSegments.map(({ blob, url, peaks, ...segment }) => segment);
    const musicSegments = deps.musicSegments.map(({ blob: _blob, src: _src, url: _url, peaks: _peaks, ...segment }) => segment);
    return {
      script: deps.script, commandState: commandStateRef.current, selectedVoiceId: deps.selectedVoiceId, speed: deps.speed, volume: deps.volume,
      ratioId: deps.ratioId, fitMode: deps.fitMode, captionPosition: deps.captionPosition,
      captionPlacement: deps.captionPlacement, captionSize: deps.captionSize, captionStyle: deps.captionStyle,
      captionStylePresetId: deps.captionStylePresetId, captionStylePresets: deps.captionStylePresets,
      captionsEnabled: deps.captionsEnabled, captionSegments: deps.captionSegments, audioSegments, musicSegments, visualSegments, visualOverlaySegments,
      stickerSegments: deps.stickerSegments, selectedFilterId: deps.selectedFilterId,
      timelineMarkers: normalizeTimelineMarkers(deps.timelineMarkers),
      selectedTransitionId: deps.selectedTransitionId, selectedStickerId: deps.selectedStickerId,
      trackVisibility: deps.trackVisibility, trackLocks: deps.trackLocks, timelineZoom: deps.timelineZoom, audioDuration: deps.audioDuration,
      musicName: deps.musicName, musicDuration: deps.musicDuration, musicVolume: deps.musicVolume,
      sourceAudioName: deps.sourceAudioName, sourceAudioDuration: deps.sourceAudioDuration,
      sourceAudioStart: deps.sourceAudioStart, sourceAudioVolume: deps.sourceAudioVolume,
      sourceAudioSpatialEffect: deps.sourceAudioSpatialEffect, sourceAudioSpatialAmount: deps.sourceAudioSpatialAmount,
      musicStart: deps.musicStart,
      sourceAudioAssetId: deps.sourceAudioAssetId, sourceAudioLinked: deps.sourceAudioLinked,
    };
  }, [deps]);

  const createCurrentArchive = useCallback(() => createProjectArchive({
    project: getProjectSnapshot(), visualSegments: [...deps.visualSegments, ...deps.visualOverlaySegments],
    audioSegments: deps.audioSegments,
    audio: deps.audioBlob ? { blob: deps.audioBlob, name: "ai-voiceover" } : null,
    sourceAudio: deps.sourceAudioBlob ? { blob: deps.sourceAudioBlob, name: deps.sourceAudioName || "source-audio" } : null,
    music: deps.musicBlob ? { blob: deps.musicBlob, name: deps.musicName || "background-music" } : null,
  }), [deps, getProjectSnapshot]);

  const saveProjectToCloud = useCallback(async (customTitle) => {
    if (savingToCloud) return null;
    setSavingToCloud(true);
    try {
      deps.notify("正在打包工程素材准备保存至云端…");
      const archiveBlob = await createCurrentArchive();

      let projectRecord = currentCloudProject;
      const titleToUse = customTitle || projectRecord?.title || deps.script?.slice(0, 30)?.trim() || "Untitled Project";

      // Capture preview thumbnail if canvas is available
      let thumbnail = null;
      try {
        const canvas = deps.previewCanvasRef?.current;
        if (canvas && canvas.width > 0 && canvas.height > 0) {
          thumbnail = canvas.toDataURL("image/jpeg", 0.65);
        }
      } catch {
        // Thumbnail capture non-fatal
      }

      if (!projectRecord) {
        const createRes = await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            title: titleToUse,
            ratio: deps.ratioId || "16:9",
            duration: Number(deps.audioDuration || 0),
            fps: 30,
            metadata: thumbnail ? { thumbnail } : {},
          }),
        });
        if (!createRes.ok) {
          throw new Error("无法在 PostgreSQL 中创建工程记录");
        }
        const createData = await createRes.json();
        projectRecord = createData.project;
      } else if (thumbnail) {
        fetch(`/api/projects/${projectRecord.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            metadata: {
              ...(typeof projectRecord.metadata === "object" && projectRecord.metadata ? projectRecord.metadata : {}),
              thumbnail,
            },
          }),
        }).catch(() => {});
      }

      deps.notify(`正在上传工程版本并存储至云端 (${titleToUse})…`);
      const uploadRes = await fetch(
        `/api/projects/${projectRecord.id}/archive?duration=${deps.audioDuration || 0}&changeSummary=${encodeURIComponent("Web editor revision")}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          credentials: "include",
          body: archiveBlob,
        }
      );
      if (!uploadRes.ok) {
        throw new Error("工程归档文件上传失败");
      }

      const uploadData = await uploadRes.json();
      const updatedProject = uploadData.project;
      setCurrentCloudProject(updatedProject);

      // Register asset metadata in PostgreSQL
      try {
        const visualMedia = [...(deps.visualSegments || []), ...(deps.visualOverlaySegments || [])];
        for (const seg of visualMedia) {
          if (seg.blob || seg.name) {
            const fname = seg.name || `visual-${seg.id || "clip"}.mp4`;
            fetch("/api/assets", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({
                projectId: updatedProject.id,
                filename: fname,
                mediaType: seg.type || "video",
                mimeType: seg.blob?.type || "video/mp4",
                storagePath: `storage/assets/${fname}`,
                sizeBytes: seg.blob?.size || 1024,
              }),
            }).catch(() => {});
          }
        }
      } catch {
        // Non-blocking
      }

      deps.notify(`工程已成功保存至云端 (版本 ${updatedProject.current_revision})`);
      return updatedProject;
    } catch (err) {
      deps.notify(`云端保存失败: ${err.message}`);
      throw err;
    } finally {
      setSavingToCloud(false);
    }
  }, [deps, createCurrentArchive, currentCloudProject, savingToCloud]);

  const handleExportProject = useCallback(async () => {
    if (importingRef.current) return;
    deps.setShowFileMenu(false);
    try {
      deps.notify("正在打包工程与媒体素材…");
      const archive = await createCurrentArchive();
      downloadBlob(archive, "AI-配音项目.timeline");
      deps.notify("工程包已导出（含媒体素材）");
    } catch (error) { deps.notify(error instanceof Error ? `工程导出失败：${error.message}` : "工程导出失败"); }
  }, [deps, createCurrentArchive]);

  const handleNewProject = useCallback(() => {
    if (importingRef.current) return;
    if (!window.confirm("新建工程将清空当前时间线，是否继续？")) return;
    commandStateRef.current = { schemaVersion: 1, revision: 0, appliedOperationIds: [] };
    setCurrentCloudProject(null);
    deps.setScript(DEFAULT_SCRIPT); deps.setCaptionSegments(createCaptionSegments(DEFAULT_SCRIPT));
    deps.setSelectedSegmentId(""); deps.clearImageTrack(""); deps.clearAudioTrack("");
    deps.setVisualOverlaySegments([]); deps.setSelectedVisualOverlayId("");
    deps.clearSourceAudioTrack(""); deps.clearMusicTrack(""); deps.setStickerSegments([]);
    deps.setTimelineMarkers?.([]);
    deps.setSelectedStickerSegmentId(""); deps.clearAllVisionState(); deps.setCurrentTime(0);
    deps.setTimelineHorizon(DEFAULT_TIMELINE_DURATION_SECONDS); deps.setTimelineZoom(1);
    deps.setShowFileMenu(false); deps.notify("已新建空白工程");
  }, [deps]);

  const handleImportProject = useCallback(async (file) => {
    if (importingRef.current) return;
    if (!file) { deps.projectFileInputRef.current?.click(); return; }
    importingRef.current = true;
    const createdUrls = new Set();
    let committed = false;
    let importAudioContext = null;
    const reportProgress = (phase, completed = 0, total = 0) => {
      setProjectImportProgress({ phase, fileName: file.name, completed, total });
    };
    const createImportedUrl = (blob) => {
      const url = URL.createObjectURL(blob);
      createdUrls.add(url);
      return url;
    };
    deps.pauseTimelineMedia?.();
    deps.setIsPlaying?.(false);
    deps.setShowFileMenu(false);
    reportProgress("archive", 0, file.size);
    try {
      // Let the modal paint before starting any decoding or fallback work.
      await waitForProjectPaint();
      let archive;
      try { archive = await readProjectArchive(file, {
        onProgress: ({ loaded, total }) => reportProgress("archive", loaded, total),
      }); }
      catch (archiveError) {
        // A damaged ZIP must not be copied into a hundreds-of-MB UTF-16
        // string just to discover that it is not a legacy JSON project.
        let legacyJsonFound = false;
        const prefixChunkBytes = 4096;
        for (let offset = 0; offset < file.size; offset += prefixChunkBytes) {
          const prefix = (await readProjectFileAsText(file.slice(offset, offset + prefixChunkBytes))).trimStart();
          if (!prefix) continue;
          if (!prefix.startsWith("{")) throw archiveError;
          legacyJsonFound = true;
          break;
        }
        if (!legacyJsonFound) throw archiveError;
        const legacy = JSON.parse(await readProjectFileAsText(file));
        if (legacy?.format !== "timeline-studio-project" || !legacy.project) throw archiveError;
        archive = { payload: { ...legacy, media: { visuals: [] } }, visualMedia: new Map(), audio: null, sourceAudio: null, music: null, legacy: true };
      }
      const { payload, visualMedia, audioSegmentMedia, audio, sourceAudio, music } = archive;
      const data = payload.project;
      const markers = normalizeTimelineMarkers(data.timelineMarkers);
      const visualUrls = new Map();
      const restoreVisualMedia = (segment) => {
        const media = resolveProjectVisualMedia(visualMedia, segment);
        if (!media?.blob) {
          return segment?.src ? segment : null;
        }
        if (!visualUrls.has(media.blob)) {
          const src = createImportedUrl(media.blob);
          visualUrls.set(media.blob, src);
        }
        return { ...segment, src: visualUrls.get(media.blob), blob: media.blob };
      };
      const restoredVisuals = Array.isArray(data.visualSegments) ? data.visualSegments.map((segment) => {
        const restored = restoreVisualMedia(segment);
        if (!restored) return null;
        const smartFrame = normalizeSmartFrame(restored.smartFrame || restored.visualEffects?.smartFrame);
        if (!smartFrame) {
          const { smartFrame: _smartFrame, visualEffects, ...withoutSmartFrame } = restored;
          if (visualEffects?.smartFrame) {
            const { smartFrame: _vSmartFrame, ...restVisualEffects } = visualEffects;
            return { ...withoutSmartFrame, visualEffects: restVisualEffects };
          }
          return withoutSmartFrame;
        }
        return { ...restored, smartFrame };
      }).filter(Boolean) : [];
      const restoredOverlays = Array.isArray(data.visualOverlaySegments) ? data.visualOverlaySegments.map(restoreVisualMedia).filter(Boolean) : [];
      // Restored Blobs are ready for native playback. Do not make opening a
      // project wait for every video's decoded filmstrip: the timeline refines
      // those progressively, prioritizing the viewport and exact playhead.
      const visuals = restoredVisuals;
      const overlays = restoredOverlays;
      reportProgress("visuals", visualUrls.size, visualUrls.size);
      const hasAudioSegments = Array.isArray(data.audioSegments) && data.audioSegments.length && (audioSegmentMedia?.size || audio);
      const audioBlobs = new Set([sourceAudio, music].filter(Boolean));
      if (hasAudioSegments) {
        for (const segment of data.audioSegments) {
          const blob = audioSegmentMedia?.get(segment.id)?.blob || audio;
          if (blob) audioBlobs.add(blob);
        }
      } else if (audio) audioBlobs.add(audio);
      let audioCompleted = 0;
      reportProgress("audio", 0, audioBlobs.size);
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (audioBlobs.size && AudioContextClass) importAudioContext = new AudioContextClass();
      const decodedAudio = new Map();
      const decodeImportedAudio = (blob) => {
        if (!decodedAudio.has(blob)) decodedAudio.set(blob, decodeWaveform(blob, 118, { audioContext: importAudioContext }).then((decoded) => {
          reportProgress("audio", ++audioCompleted, audioBlobs.size);
          return decoded;
        }));
        return decodedAudio.get(blob);
      };
      let restoredAudioSegments = null;
      let standaloneAudio = null;
      if (hasAudioSegments) {
        const restoredAudio = new Array(data.audioSegments.length);
        let nextAudioIndex = 0;
        // Full native decodes can allocate many times the compressed size.
        // Share one decoder context, with only two complete PCM allocations
        // in flight at once even for projects containing many audio clips.
        let decodeFailure = null;
        const audioResults = await Promise.allSettled(Array.from({ length: Math.min(2, data.audioSegments.length) }, async () => {
          while (!decodeFailure && nextAudioIndex < data.audioSegments.length) {
            const index = nextAudioIndex++;
            const segment = data.audioSegments[index];
            const blob = audioSegmentMedia?.get(segment.id)?.blob || audio;
            if (!blob) continue;
            try {
              const decoded = await decodeImportedAudio(blob);
              restoredAudio[index] = { ...segment, blob, url: createImportedUrl(blob), peaks: decoded.peaks };
            } catch (error) { decodeFailure = error; throw error; }
          }
        }));
        const failedAudio = audioResults.find((result) => result.status === "rejected");
        if (failedAudio) throw failedAudio.reason;
        restoredAudioSegments = restoredAudio.filter(Boolean);
      } else if (audio) {
        standaloneAudio = await decodeImportedAudio(audio);
      } else restoredAudioSegments = [];
      const decodedSource = sourceAudio ? await decodeImportedAudio(sourceAudio) : null;
      const decodedMusic = music ? await decodeImportedAudio(music) : null;
      if (importAudioContext) {
        await importAudioContext.close().catch(() => {});
        importAudioContext = null;
      }

      // Publish one complete project only after media restoration and waveforms
      // have succeeded. Failed imports leave the previous timeline intact.
      reportProgress("ready");
      await waitForProjectPaint();
      commandStateRef.current = data.commandState || { schemaVersion: 1, revision: 0, appliedOperationIds: [] };
      deps.setTimelineHorizon(DEFAULT_TIMELINE_DURATION_SECONDS);
      deps.setScript(typeof data.script === "string" ? data.script : DEFAULT_SCRIPT);
      const legacyFontId = data.captionStyle?.fontId || "default";
      let inheritedCaptionFontId = legacyFontId;
      const captions = (Array.isArray(data.captionSegments) ? data.captionSegments : createCaptionSegments(data.script || DEFAULT_SCRIPT))
        .map((segment) => {
          inheritedCaptionFontId = segment.fontId || inheritedCaptionFontId;
          return segment.fontId ? segment : { ...segment, fontId: inheritedCaptionFontId };
        });
      deps.markTimelineViewRestored?.(Boolean(captions.length || data.visualSegments?.length || markers.length || audio || sourceAudio || music));
      deps.setCaptionSegments(captions); deps.setSelectedSegmentId(captions[0]?.id ?? "");
      deps.setTimelineMarkers?.(markers);
      const importedVoice = VOICES.find((voice) => voice.id === normalizeVoiceId(data.selectedVoiceId)) ?? VOICES[0];
      deps.setSelectedVoiceId(importedVoice.id);
      deps.setSpeed(Number.isFinite(Number(data.speed)) && Number(data.speed) > 0
        ? Number(data.speed)
        : importedVoice.defaultSpeed ?? 1);
      deps.setVolume(Number(data.volume) || 1);
      const importedRatio = RATIO_OPTIONS.some((option) => option.id === data.ratioId) ? data.ratioId : "16:9";
      if (deps.autoRatioSourceKeyRef) deps.autoRatioSourceKeyRef.current = `locked:${importedRatio}`;
      deps.setRatioId(importedRatio);
      deps.setFitMode(data.fitMode || "contain"); deps.setCaptionPosition(data.captionPosition || "bottom");
      deps.setCaptionPlacement(data.captionPlacement || { x: 50, y: 78 }); deps.setCaptionSize(Number(data.captionSize) || 14);
      deps.setCaptionStyle(data.captionStyle || deps.captionStyle);
      deps.setCaptionStylePresetId?.(data.captionStylePresetId || "classic");
      deps.setCaptionStylePresets?.(Array.isArray(data.captionStylePresets) ? data.captionStylePresets : []);
      deps.setCaptionsEnabled(data.captionsEnabled !== false);
      deps.setTrackVisibility(normalizeTrackVisibility(data.trackVisibility)); deps.setTrackLocks(normalizeTrackLocks(data.trackLocks)); deps.setTimelineZoom(Number(data.timelineZoom) || 1);
      deps.setSelectedFilterId(data.selectedFilterId || "none"); deps.setSelectedTransitionId(data.selectedTransitionId || "none");
      deps.setSelectedStickerId(data.selectedStickerId || "none"); deps.setStickerSegments(Array.isArray(data.stickerSegments) ? data.stickerSegments : []);
      for (const url of visualUrls.values()) deps.imageUrlRefs.current.add(url);
      for (const segment of [...visuals, ...overlays]) {
        if (segment.src?.startsWith("blob:")) deps.imageUrlRefs.current.add(segment.src);
      }
      deps.setVisualSegments(visuals); deps.setImageDuration(getVisualSegmentsTotal(visuals));
      deps.setVisualOverlaySegments(overlays); deps.setSelectedVisualOverlayId("");
      deps.setImageClipCount(getImageThumbnailCount(getVisualSegmentsTotal(visuals))); deps.setCurrentVisualAsset(visuals[0] || null);
      deps.audioSegments.forEach((segment) => { if (segment.url?.startsWith("blob:")) URL.revokeObjectURL(segment.url); });
      if (restoredAudioSegments) {
        deps.setAudioSegments(restoredAudioSegments);
        deps.setSelectedAudioSegmentId(restoredAudioSegments[0]?.id || "");
      } else if (standaloneAudio) {
        deps.replaceAudio(audio, Number(data.audioDuration) || standaloneAudio.duration, standaloneAudio.peaks, "");
      }
      if (decodedSource) deps.replaceSourceAudio(sourceAudio, Number(data.sourceAudioDuration) || decodedSource.duration, decodedSource.peaks, data.sourceAudioName || "source-audio", "", Number(data.sourceAudioStart) || 0, data.sourceAudioAssetId || "", { focusAudio: false });
      else deps.clearSourceAudioTrack("");
      if (decodedMusic) {
        deps.replaceMusic(music, Number(data.musicDuration) || decodedMusic.duration, decodedMusic.peaks, data.musicName || "background-music", "");
        deps.setMusicStart(Math.max(0, Number(data.musicStart) || 0));
        if (Array.isArray(data.musicSegments) && data.musicSegments.length) deps.setMusicSegments(data.musicSegments.map((segment) => ({ ...segment, peaks: decodedMusic.peaks })));
      } else deps.clearMusicTrack("");
      deps.setMusicVolume(Number(data.musicVolume) || 0.35); deps.setSourceAudioVolume(Number(data.sourceAudioVolume) || 1);
      deps.setSourceAudioSpatialEffect(data.sourceAudioSpatialEffect || "original"); deps.setSourceAudioSpatialAmount(Number.isFinite(Number(data.sourceAudioSpatialAmount)) ? Number(data.sourceAudioSpatialAmount) : 1);
      deps.setSourceAudioAssetId(data.sourceAudioAssetId || ""); deps.setSourceAudioLinked(data.sourceAudioLinked !== false);
      deps.setCurrentTime(0); deps.clearAllVisionState(); deps.setShowFileMenu(false);
      committed = true;
      // Dismiss loading in the same commit as the complete project, before
      // newly mounted clips start their background filmstrip refinement.
      deps.notify(archive.legacy ? "旧版工程已导入；请重新添加未嵌入的本地媒体，然后导出为 .timeline 工程包" : "工程包已导入，媒体素材已恢复");
    } catch (error) {
      console.error("Project import failed", error);
      deps.notify((PROJECT_IMPORT_COPY[deps.language] || PROJECT_IMPORT_COPY.en).error);
    } finally {
      if (importAudioContext) await importAudioContext.close().catch(() => {});
      if (!committed) createdUrls.forEach((url) => URL.revokeObjectURL(url));
      if (deps.projectFileInputRef.current) deps.projectFileInputRef.current.value = "";
      importingRef.current = false;
      setProjectImportProgress(null);
    }
  }, [deps]);

  const handleOpenCloudProject = useCallback(async (file, projectRecord) => {
    setCurrentCloudProject(projectRecord);
    await handleImportProject(file);
  }, [handleImportProject]);

  const { initialProject, initialImportFile, setRatioId, notify } = deps;

  useEffect(() => {
    if (initialLoadedRef.current) return;
    if (initialProject) {
      initialLoadedRef.current = true;
      setCurrentCloudProject(initialProject);
      if (initialProject.ratio && setRatioId) {
        setRatioId(initialProject.ratio);
      }
      if (initialProject.current_revision > 0) {
        notify?.(`Loading project "${initialProject.title}"...`);
        fetch(`/api/projects/${initialProject.id}/archive`, { credentials: "include" })
          .then((res) => {
            if (!res.ok) throw new Error(`Archive download failed (${res.status})`);
            return res.blob();
          })
          .then((blob) => {
            const file = new File([blob], `${initialProject.title || "project"}.timeline`, {
              type: "application/zip",
            });
            return handleImportProject(file);
          })
          .catch((err) => {
            console.error("Auto load archive error:", err);
          });
      }
    } else if (initialImportFile) {
      initialLoadedRef.current = true;
      handleImportProject(initialImportFile);
    }
  }, [initialProject, initialImportFile, setRatioId, notify, handleImportProject]);

  return { projectImportProgress, handleExportProject, handleImportProject, handleNewProject, getProjectSnapshot, createCurrentArchive, currentCloudProject, savingToCloud, saveProjectToCloud, handleOpenCloudProject };
}
