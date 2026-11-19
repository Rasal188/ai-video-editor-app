import { useCaptionSourceAvailability } from "./hooks/useCaptionSourceAvailability.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { assertAssistantBase, assertAssistantChangedTracksUnlocked, assertDestructiveAssistantTargets } from "./lib/assistantSafety.js";
import { X } from "@phosphor-icons/react";

import { LanguageIntro } from "./components/panels.jsx";
import { PreviewStage } from "./components/PreviewStage.jsx";
import { VoicePanel } from "./components/VoicePanel.jsx";
import { Timeline } from "./components/Timeline.jsx";
import { Topbar } from "./components/Topbar.jsx";
import { AssetDragPreview, ExportProgressOverlay } from "./components/EditorOverlays.jsx";
import { EditorSidebar } from "./components/EditorSidebar.jsx";
import { FirstVisualGuide } from "./components/FirstVisualGuide.jsx";
import { MiganRepairDialog } from "./components/MiganRepairDialog.jsx";
import { NanoVsrRestorationDialog } from "./components/NanoVsrRestorationDialog.jsx";
import { SmartDenoiseDialog } from "./components/SmartDenoiseDialog.jsx";
import { WebMcpReview, WebMcpAiStatus } from "./components/WebMcpReview.jsx";
import ProjectImportOverlay from "./components/ProjectImportOverlay.jsx";
import { CloudRenderModal } from "./components/CloudRenderModal.jsx";
import { TranscriptReviewModal } from "./components/TranscriptReviewModal.jsx";
import { SmartPipelineModal } from "./components/SmartPipelineModal.jsx";
import { SceneDetectionModal } from "./components/SceneDetectionModal.jsx";
import { AiShortsStudioModal } from "./components/AiShortsStudioModal.jsx";
import { ShortsNotificationRegion } from "./components/ShortsBackgroundNotification.jsx";
import { AiAssistantPanel } from "./components/AiAssistantPanel.jsx";
import {
  canShowFirstVisualGuide,
  FIRST_VISUAL_GUIDE_MOBILE_QUERY,
  hasSeenFirstVisualGuide,
  markFirstVisualGuideSeen,
} from "./lib/firstVisualGuide.js";
import { normalizeTrackLocks, normalizeTrackVisibility } from "./lib/projectTrackState.js";
import { useExportElapsed } from "./hooks/useExportElapsed.js";
import { usePreviewFrameSize } from "./hooks/usePreviewFrameSize.js";
import { useEditorCatalog } from "./hooks/useEditorCatalog.js";
import { useToast } from "./hooks/useToast.js";
import { useProjectFiles } from "./hooks/useProjectFiles.js";
import { useAutosaveTimestamp } from "./hooks/useAutosaveTimestamp.js";
import { useVisionAnalysis } from "./hooks/useVisionAnalysis.js";
import { useSmartFrame } from "./hooks/useSmartFrame.js";
import { useFileUpload } from "./hooks/useFileUpload.js";
import { useMediaSync } from "./hooks/useMediaSync.js";
import { useVideoExport } from "./hooks/useVideoExport.js";
import { useVoiceRecorder } from "./hooks/useVoiceRecorder.js";
import { useVoiceGeneration } from "./hooks/useVoiceGeneration.js";
import { useVoiceProfiles } from "./hooks/useVoiceProfiles.js";
import { preserveTranscriptionOutcome } from "./lib/transcriptionOutcome.js";
import { editorTranscriptionStatus } from "./lib/editorTranscription.js";
import { useAutoCaptions } from "./hooks/useAutoCaptions.js";
import { useSilenceRemoval } from "./hooks/useSilenceRemoval.js";
import { useRoughCut } from "./hooks/useRoughCut.js";
import { useSmartPipeline } from "./hooks/useSmartPipeline.js";
import { useSceneDetection } from "./hooks/useSceneDetection.js";
import { useShortsStudio } from "./hooks/useShortsStudio.js";
import { exportShortCandidateVideo } from "./lib/shortsExport.js";
import { useWebMcpEditor } from "./hooks/useWebMcpEditor.js";
import { sampleEditorMedia } from "./lib/webMcpMediaSample.js";
import { browserProjectFingerprint, restoreBrowserProjectMedia } from "./lib/browserEditPlan.js";
import { useSourceAudioExtraction } from "./hooks/useSourceAudioExtraction.js";
import { useVocalSeparation } from "./hooks/useVocalSeparation.js";
import { resolveAudioToolVideoTarget } from "./lib/audioToolTarget.js";
import { useFaceSwapGeneration } from "./hooks/useFaceSwapGeneration.js";
import { useDepthOfFieldAnalysis } from "./hooks/useDepthOfFieldAnalysis.js";
import { useCaptionState } from "./hooks/useCaptionState.js";
import { useAudioTrackState } from "./hooks/useAudioTrackState.js";
import { useVisualTrackState } from "./hooks/useVisualTrackState.js";
import { useEditorUiState } from "./hooks/useEditorUiState.js";
import { useTimelineModel } from "./hooks/useTimelineModel.js";
import { usePreviewModel } from "./hooks/usePreviewModel.js";
import { useEditorRefs } from "./hooks/useEditorRefs.js";
import { useEditorLifecycle } from "./hooks/useEditorLifecycle.js";
import { useEditorHistory } from "./hooks/useEditorHistory.js";
import { createVisionControls } from "./lib/visionControls.js";
import { createAssetDragControls, resolveVisualDropIntent } from "./lib/assetDragControls.js";
import { createAssetLibraryActions } from "./lib/assetLibraryActions.js";
import { createPlaybackControls } from "./lib/playbackControls.js";
import { createTimelineReorderControls } from "./lib/timelineReorderControls.js";
import { createTimelineMoveControls } from "./lib/timelineMoveControls.js";
import { createImageResizeControl } from "./lib/imageResizeControl.js";
import { createTimelineClipboardActions } from "./lib/timelineClipboardActions.js";
import { appendImportedCaptions } from "./lib/subtitles.js";
import {
  createTimelineCutActions,
  splitVisualSegmentAtBoundaries,
  validateSceneCutBoundaries,
} from "./lib/timelineCutActions.js";
import { createTimelineSegmentCountActions } from "./lib/timelineSegmentCountActions.js";
import { createTimelineDurationActions } from "./lib/timelineDurationActions.js";
import { createAudioClipActions, updateAudioSegmentPlaybackRate } from "./lib/audioClipActions.js";
import { createCaptionEditingActions } from "./lib/captionEditingActions.js";
import { createAudioTrackActions } from "./lib/audioTrackActions.js";
import { createVisualTimelineActions } from "./lib/visualTimelineActions.js";
import { createStickerTimelineActions } from "./lib/stickerTimelineActions.js";
import { createAssetDropActions } from "./lib/assetDropActions.js";
import { createEditorCommandActions } from "./lib/editorCommandActions.js";
import { useTimelineViewModel } from "./lib/timelineViewModel.js";
import { createTranslator, getStoredLanguage, translateOptionName } from "./i18n.js";
import { decodeWaveform, downloadBlob } from "./lib/media.js";
import { useAiMusicGeneration } from "./hooks/useAiMusicGeneration.js";
import { useMiganRepair } from "./hooks/useMiganRepair.js";
import { useNanoVsrRestoration } from "./hooks/useNanoVsrRestoration.js";
import { useSmartDenoise } from "./hooks/useSmartDenoise.js";
import { useGenerationPlugins } from "./hooks/useGenerationPlugins.js";
import { getVisualAssetPayload, getImageThumbnailCount, getVisualSegmentsTotal, normalizeTimedSegmentIds } from "./lib/timeline.js";
import { getVisualSourceTime, normalizeVisualTransform, removeVisualPropertyKeyframe, updateVisualSegmentPlaybackRate, upsertVisualKeyframe, upsertVisualPropertyKeyframe } from "./lib/visualEffects.js";
import { getVisualSpeedCurveTimelineProgress, updateVisualSegmentSpeedCurve } from "./lib/visualSpeedCurve.js";
import { getLinkedSourceAudioEnd, getLinkedSourceAudioSegments, shouldMuteEmbeddedVideoAudio, sliceSourceAudioPeaks } from "./lib/sourceAudioSync.js";
import { getTimelineInitialContentZoom } from "./lib/timelineScale.js";
import { getVisionKey } from "./lib/vision.js";
import { DEFAULT_SUBJECT_EFFECT, normalizeSubjectEffect } from "./lib/subjectEffects.js";
import { normalizeClickRippleEffect } from "./lib/clickRippleEffect.js";
import { normalizeCinematicDepth, resolveDepthAnalysisAtTime } from "./lib/depthOfField.js";
import { normalizePhotoParallax } from "./lib/photoParallax.js";
import {
  getExportContentDuration,
  getExportDimensions,
  getEffectiveExportBitrate,
  loadExportSettings,
  saveExportSettings,
} from "./lib/exportSettings.js";
import { createVisualOverlaySegment, getVisualOverlayPreset, updateVisualOverlayTransform } from "./lib/visualOverlayTimeline.js";
import { createTemplateFromOverlays, createTemplateOverlayRenderSource, instantiateTemplate } from "./lib/shortsOverlayTemplates.js";
import { createOverlayTemplateRequest } from "./lib/overlayTemplateApi.js";
import { getMobileClipPanelOrigin } from "./lib/mobileClipActions.js";
import { getVisualPropertyTabIds } from "./lib/visualPropertyTabs.js";
import { applyTimelineRipple } from "./lib/timelineRipple.js";
import { COMPACT_WORKSPACE_QUERY } from "./config/editor.js";

export function App({
  currentUser = null,
  onLogout,
  activeProject = null,
  initialImportFile = null,
  initialGeneratedProject = null,
  onBackToDashboard = null,
} = {}) {
  const [uiLanguage, setUiLanguage] = useState(() => getStoredLanguage());
  const [mobilePanel, setMobilePanel] = useState("");
  const [mobilePanelClosing, setMobilePanelClosing] = useState(false);
  const mobilePanelTimerRef = useRef(null);
  const [mobilePanelOrigin, setMobilePanelOrigin] = useState("");
  const [mobileInspectorSection, setMobileInspectorSection] = useState("");
  const [effectsPanelMode, setEffectsPanelMode] = useState("outline");
  const [isCompactViewport, setIsCompactViewport] = useState(() => (
    typeof window !== "undefined" && window.matchMedia?.(COMPACT_WORKSPACE_QUERY).matches
  ));
  useEffect(() => {
    const query = window.matchMedia?.(COMPACT_WORKSPACE_QUERY);
    if (!query) return undefined;
    const update = () => setIsCompactViewport(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [exportSettings, setExportSettings] = useState(() => loadExportSettings());
  useEffect(() => {
    saveExportSettings(exportSettings);
  }, [exportSettings]);
  const [captionVoiceFocusRequest, setCaptionVoiceFocusRequest] = useState(0);
  const [selectedSourceAudioSegmentId, setSelectedSourceAudioSegmentId] = useState("");
  const [selectedMusicSegmentId, setSelectedMusicSegmentId] = useState("");
  const [stickerTimelineDrag, setStickerTimelineDrag] = useState(null);
  const [canvasVisualTarget, setCanvasVisualTarget] = useState("");
  const [showFirstVisualGuide, setShowFirstVisualGuide] = useState(false);
  const firstVisualGuideShownRef = useRef(false);
  const timelineImportRestoreRef = useRef(false);
  const changeMobilePanel = (nextPanel) => {
    if (mobilePanelTimerRef.current) window.clearTimeout(mobilePanelTimerRef.current);
    if (!nextPanel && mobilePanel) {
      setMobilePanelClosing(true);
      mobilePanelTimerRef.current = window.setTimeout(() => {
        setMobilePanel("");
        setMobilePanelClosing(false);
        setMobilePanelOrigin("");
        setMobileInspectorSection("");
        mobilePanelTimerRef.current = null;
      }, 170);
      return;
    }
    setMobilePanelClosing(false);
    setMobilePanel(nextPanel);
  };
  const [introClosing, setIntroClosing] = useState(false);
  const {
    captionPlacement, captionPosition, captionSegments, captionSize, captionStyle,
    captionStylePresetId, captionStylePresets,
    captionsEnabled, script, selectedSegmentId, setCaptionPlacement,
    setCaptionPosition, setCaptionSegments, setCaptionSize, setCaptionStyle,
    setCaptionStylePresetId, setCaptionStylePresets,
    setCaptionsEnabled, setScript, setSelectedSegmentId,
  } = useCaptionState();
  const {
    audioSegments, audioSegmentsRef, favoriteVoiceIds, generatedVoiceEndRef, historyItems, musicBlob, musicDuration, musicName, musicSegments, musicStart,
    musicPeaks, musicUrl, musicVolume, recordedVoices, recordingElapsed, recordingState,
    selectedAudioSegmentId, selectedVoiceId, setAudioSegments, setFavoriteVoiceIds,
    setHistoryItems, setMusicBlob, setMusicDuration, setMusicName, setMusicPeaks, setMusicStart,
    setMusicSegments, setMusicUrl, setMusicVolume, setRecordedVoices, setRecordingElapsed,
    setRecordingState, setSelectedAudioSegmentId, setSelectedVoiceId, setSourceAudioBlob,
    setSourceAudioAssetId, setSourceAudioDuration, setSourceAudioLinked, setSourceAudioName, setSourceAudioPeaks, setSourceAudioStart,
    setSourceAudioUrl, setSourceAudioVolume, setSourceAudioSpatialEffect, setSourceAudioSpatialAmount, setSpeed, setTimelineHorizon, setVolume,
    sourceAudioAssetId, sourceAudioBlob, sourceAudioDuration, sourceAudioLinked, sourceAudioName, sourceAudioPeaks,
    sourceAudioStart, sourceAudioUrl, sourceAudioVolume, sourceAudioSpatialEffect, sourceAudioSpatialAmount, speed, timelineHorizon, volume,
  } = useAudioTrackState();
  const {
    fitMode, imageClipCount, imageDuration, imageMeta, imageName, imageSrc,
    selectedFilterId, selectedStickerId, selectedStickerSegmentId, selectedTransitionId,
    selectedVisualSegmentId, setFitMode, setImageClipCount, setImageDuration, setImageMeta,
    setImageName, setImageSrc, setSelectedFilterId, setSelectedStickerId,
    setSelectedStickerSegmentId, setSelectedTransitionId, setSelectedVisualSegmentId,
    setStickerSegments, setVisualSegments, setVisualType, stickerSegments, visualSegments,
    visualType, visualOverlaySegments, selectedVisualOverlayId,
    setVisualOverlaySegments, setSelectedVisualOverlayId,
  } = useVisualTrackState();
  const {
    activeTool, assetDragPreview, assetDropPosition, assetDropPulseTrack,
    assetDropTargetTrack, compactRail, currentTime, draggedAssetId, exporting, exportPhase,
    exportProgress, isDragging, isPlaying, mediaTab, progress, ratioId,
    selectedLibraryAssetId, selectedTrack, setActiveTool, setAssetDragPreview,
    setAssetDropPosition, setAssetDropPulseTrack, setAssetDropTargetTrack, setCompactRail,
    setCurrentTime, setDraggedAssetId, setExporting, setExportPhase, setExportProgress,
    setIsDragging, setIsPlaying, setMediaTab, setProgress, setRatioId,
    setSelectedLibraryAssetId, setSelectedTrack, setShowFileMenu, setShowRatioMenu,
    setShowSettings, setShowVoiceFilter, setSnapGuide, setStatus, setStatusText,
    rippleEditing, setRippleEditing, setTimelineClipDrag, setTimelineZoom, setTrackLocks, setTrackVisibility, setVoiceFilter,
    setVoiceTab, showFileMenu, showRatioMenu, showSettings, showVoiceFilter, snapGuide,
    status, statusText, timelineClipDrag, timelineZoom, trackLocks, trackVisibility,
    voiceFilter, voiceTab,
  } = useEditorUiState();
  const [exportError, setExportError] = useState(null);
  const [userAssets, setUserAssets] = useState([]);
  const [visualOverlayTemplateSaveState, setVisualOverlayTemplateSaveState] = useState({ status: "idle", message: "" });
  const [timelineMarkers, setTimelineMarkers] = useState([]);
  const timelineMarkerEnd = useMemo(() => timelineMarkers.reduce(
    (end, marker) => Math.max(end, marker.type === "range" ? marker.endTime : marker.time), 0,
  ), [timelineMarkers]);
  const { notify, toast } = useToast(2600, uiLanguage || "zh");
  const [previewVideoMediaTime, setPreviewVideoMediaTime] = useState(0);
  const [sourceAudioDragTargetLane, setSourceAudioDragTargetLane] = useState(null);
  const sourceVoiceColorOriginalRef = useRef(null);
  const [visionRecords, setVisionRecords] = useState({});
  const [depthRecords, setDepthRecords] = useState({});
  const [visionJob, setVisionJob] = useState({
    running: false,
    key: "",
    progress: 0,
    phase: "",
  });
  const [smartMode, setSmartMode] = useState("smart-pipeline");
  const lastSaved = useAutosaveTimestamp([
    script, imageSrc, visualType, imageDuration, captionPlacement, selectedVoiceId, speed,
    volume, musicName, musicDuration, musicStart, musicVolume, sourceAudioName, sourceAudioDuration,
    sourceAudioStart, sourceAudioVolume, sourceAudioSpatialEffect, sourceAudioSpatialAmount, ratioId, fitMode, selectedFilterId, selectedStickerId,
    captionSegments, visualSegments, visualOverlaySegments, visionRecords, timelineZoom, timelineMarkers,
  ]);

  const {
    assetDropPulseTimerRef, audioRef, audioSegmentRefs, audioUrlRef, autoRatioSourceKeyRef,
    currentTimeRef, draggedAssetIdRef, playbackSessionRef,
    exportAbortControllerRef, exportStartRef, fileInputRef, imageUrlRefs, musicRef, musicUrlRef, pointerAssetDragRef,
    previewCanvasRef, previewShellRef, previewVideoRef, projectFileInputRef, sourceAudioRef,
    sourceAudioUrlRef, suppressAssetClickRef, suppressTimelineClipClickRef,
    timelineClipDragRef, timelineDurationRef, trackScrollRef, visionAbortControllerRef,
    visionJobGenerationRef, visionObjectUrlsRef, visualPlaybackFrameRef,
    visualPlaybackLastUpdateRef, visualPlaybackStartedAtRef, visualPlaybackStartTimeRef,
    voiceRecorderChunksRef, voiceRecorderRef, voiceRecorderStartedAtRef,
    voiceRecorderStreamRef, voiceRecorderTimerRef,
  } = useEditorRefs();
  const activeLanguage = uiLanguage || "zh";
  const aiMusic = useAiMusicGeneration({
    activeLanguage,
    imageUrlRefs,
    setActiveTool,
    setMediaTab,
    setSelectedLibraryAssetId,
    setUserAssets,
  });
  const { redo, undo, checkpoint: checkpointHistory, signature: historySignature } = useEditorHistory({
    autoRatioSourceKeyRef,
    timelineMarkers, setTimelineMarkers, ratioId, setRatioId,
    captionStylePresetId, captionStylePresets, setCaptionStylePresetId, setCaptionStylePresets,
    audioSegments, captionPlacement, captionPosition, captionSegments, captionSize,
    captionStyle, captionsEnabled, currentTime, fitMode, imageClipCount, imageDuration,
    imageMeta, imageName, imageSrc, imageUrlRefs, musicBlob, musicDuration, musicName, musicSegments, musicStart,
    musicPeaks, musicUrl, musicUrlRef, musicVolume, notify, selectedAudioSegmentId,
    selectedFilterId, selectedSegmentId, selectedStickerId, selectedStickerSegmentId,
    selectedTrack, selectedTransitionId, selectedVisualSegmentId, script, setAudioSegments,
    setCaptionPlacement, setCaptionPosition, setCaptionSegments, setCaptionSize,
    setCaptionStyle, setCaptionsEnabled, setCurrentTime, setFitMode, setImageClipCount,
    setImageDuration, setImageMeta, setImageName, setImageSrc, setIsPlaying, setMusicBlob,
    setMusicDuration, setMusicName, setMusicPeaks, setMusicSegments, setMusicStart, setMusicUrl, setMusicVolume, setScript,
    setSelectedAudioSegmentId, setSelectedFilterId, setSelectedSegmentId,
    setSelectedStickerId, setSelectedStickerSegmentId, setSelectedTrack,
    setSelectedTransitionId, setSelectedVisualSegmentId, setSourceAudioBlob,
    setSourceAudioAssetId, setSourceAudioDuration, setSourceAudioLinked, setSourceAudioName, setSourceAudioPeaks, setSourceAudioStart,
    setSourceAudioUrl, setSourceAudioVolume, setStickerSegments, setTimelineHorizon,
    setTrackLocks, setTrackVisibility, setUserAssets, setVisualSegments, setVisualType,
    sourceAudioAssetId, sourceAudioBlob, sourceAudioDuration, sourceAudioLinked, sourceAudioName, sourceAudioPeaks,
    sourceAudioStart, sourceAudioUrl, sourceAudioUrlRef, sourceAudioVolume, stickerSegments,
    timelineHorizon, trackLocks, trackVisibility, userAssets, visualSegments, visualType,
    visualOverlaySegments, selectedVisualOverlayId, setVisualOverlaySegments, setSelectedVisualOverlayId,
  });
  const t = useMemo(() => createTranslator(activeLanguage), [activeLanguage]);
  const {
    addVoiceProfile, removeVoiceProfile, selectedVoiceProfileId, setSelectedVoiceProfileId,
    toggleVoiceProfileFavorite, voiceProfiles,
  } = useVoiceProfiles({ favoriteVoiceIds, setFavoriteVoiceIds, notify, t });
  const selectedVoiceProfile = voiceProfiles.find((profile) => profile.id === selectedVoiceProfileId) ?? null;
  const handleCancelExport = () => {
    const controller = exportAbortControllerRef.current;
    if (!controller || controller.signal.aborted) return;
    setExportPhase(t("exportCanceling"));
    controller.abort();
  };
  const trOption = (name, option) => {
    if (option?.kind === "stickerCategory") {
      return activeLanguage !== "zh" && option.nameEn ? option.nameEn : name;
    }

    return activeLanguage !== "zh" && option?.nameEn ? option.nameEn : translateOptionName(activeLanguage, name);
  };
  const shouldShowLanguageIntro = !uiLanguage;
  const requestFirstVisualGuide = () => {
    const isMobile = window.matchMedia?.(FIRST_VISUAL_GUIDE_MOBILE_QUERY).matches ?? false;
    if (!canShowFirstVisualGuide({
      isMobile,
      hasSeen: hasSeenFirstVisualGuide(),
      shownThisSession: firstVisualGuideShownRef.current,
    })) return;
    firstVisualGuideShownRef.current = true;
    setShowFirstVisualGuide(true);
  };

  const linkedSourceAudioSegments = useMemo(
    () => sourceAudioLinked && sourceAudioBlob
      ? getLinkedSourceAudioSegments(visualSegments, sourceAudioAssetId, sourceAudioDuration)
      : [],
    [sourceAudioAssetId, sourceAudioBlob, sourceAudioDuration, sourceAudioLinked, visualSegments],
  );
  const sourceAudioTimelineEnd = sourceAudioLinked && linkedSourceAudioSegments.length
    ? getLinkedSourceAudioEnd(linkedSourceAudioSegments)
    : sourceAudioStart + sourceAudioDuration;
  const musicTimelineEnd = musicSegments.length
    ? musicSegments.reduce((end, segment) => Math.max(end, segment.start + segment.duration), 0)
    : musicStart + musicDuration;

  const rippleTimelineAfter = (boundary, delta) => applyTimelineRipple({
    rippleEditing, audioSegments, captionSegments, musicBlob, musicSegments, musicStart,
    sourceAudioBlob, sourceAudioLinked, sourceAudioStart, stickerSegments, trackLocks,
    visualOverlaySegments, setAudioSegments, setCaptionSegments, setMusicSegments,
    setMusicStart, setSourceAudioStart, setStickerSegments, setVisualOverlaySegments,
  }, boundary, delta);

  const {
    activePreviewFilter, audioBlob, audioDuration, audioUrl, canPreview, captionDuration,
    captionTargetDuration, captionTimeline, currentCaption, currentCaptions, currentCaptionSegment,
    currentSegmentIndex, currentStickerSegment, currentStickerSegmentIndex,
    currentVisualRange, currentVisualSegment, currentVisualSegmentIndex, estimatedDuration,
    focusedSegmentIndex, getStickerDragAsset, peaks, previewSticker, previewStickers, previewVisualOverlays, previewTransition,
    previewVisionBaseAnalysis, previewVisionKey, previewVisionRecord, previewVisualLocalTime,
    previewVisualRange, previewVisualSegment, previewVisualSegmentIndex,
    previewVisualSourceTime, previewVisualSrc, previewVisualType, ratio, segments,
    selectedAudioSegment, selectedCaptionSegment, selectedFilter, selectedSegmentIndex,
    selectedSticker, selectedStickerSegmentIndex, selectedVisualSegmentIndex, selectedVoice,
    stickerDuration, timelineDuration, visualTimeline, voiceTrackDuration,
  } = useTimelineModel({
    timelineMarkers,
    audioSegments, captionSegments, currentTime, imageDuration, imageSrc, musicBlob,
    musicDuration, musicTimelineEnd, musicUrl, ratioId, script, selectedAudioSegmentId, selectedFilterId,
    selectedSegmentId, selectedStickerId, selectedStickerSegmentId,
    selectedVisualSegmentId, selectedVoiceId, sourceAudioBlob, sourceAudioDuration,
    sourceAudioTimelineEnd,
    sourceAudioStart, sourceAudioUrl, stickerSegments, timelineDurationRef, timelineHorizon,
    timelineZoom,
    trackVisibility, visionRecords, visualSegments, visualType, visualOverlaySegments,
  });
  const previousTimelineContentDurationRef = useRef(estimatedDuration);
  const initialDurationSettledRef = useRef(false);
  const hasPreparingVisual = visualSegments.some((v) => v.preparing);

  useEffect(() => {
    const previousDuration = previousTimelineContentDurationRef.current;
    const becameNonEmpty = previousDuration <= 0 && estimatedDuration > 0;
    const becameEmpty = previousDuration > 0 && estimatedDuration <= 0;

    if (becameEmpty) {
      timelineImportRestoreRef.current = false;
      initialDurationSettledRef.current = false;
      setTimelineHorizon(10);
      setTimelineZoom(getTimelineInitialContentZoom(0));
      setCurrentTime(0);
      if (trackScrollRef.current) trackScrollRef.current.scrollLeft = 0;
    } else if (becameNonEmpty || (!initialDurationSettledRef.current && estimatedDuration > 0 && !hasPreparingVisual)) {
      if (timelineImportRestoreRef.current) {
        timelineImportRestoreRef.current = false;
      } else if (!hasPreparingVisual) {
        setTimelineZoom(getTimelineInitialContentZoom(estimatedDuration));
        initialDurationSettledRef.current = true;
      }
      if (trackScrollRef.current) trackScrollRef.current.scrollLeft = 0;
    }

    previousTimelineContentDurationRef.current = estimatedDuration;
  }, [estimatedDuration, hasPreparingVisual, setCurrentTime, setTimelineHorizon, setTimelineZoom, trackScrollRef]);
  const previewFrameSize = usePreviewFrameSize(previewShellRef, ratio, compactRail);
  const selectedVisualSegment = visualSegments[selectedVisualSegmentIndex] ?? previewVisualSegment ?? null;
  const selectedVisualOverlay = visualOverlaySegments.find((item) => item.id === selectedVisualOverlayId) ?? null;
  const selectedEffectSegment = selectedTrack === "overlay" && selectedVisualOverlay
    ? selectedVisualOverlay
    : selectedVisualSegment;
  const effectVisionKey = getVisionKey(selectedEffectSegment);
  const effectVisionRecord = effectVisionKey ? visionRecords[effectVisionKey] ?? null : null;
  const effectAnalysis = effectVisionRecord?.analysis ?? null;
  const effectRunning = visionJob.running && visionJob.key === effectVisionKey;
  const effectProgress = visionJob.key === effectVisionKey ? visionJob.progress : (effectAnalysis?.complete ? 100 : 0);
  const effectPhase = visionJob.key === effectVisionKey ? visionJob.phase : "";
  const selectedVisualRange = visualTimeline[selectedVisualSegmentIndex] ?? previewVisualRange;
  const [visualAnimationPreview, setVisualAnimationPreview] = useState(null);
  const [visualCanvasEditMode, setVisualCanvasEditMode] = useState("transform");
  useEffect(() => {
    if (!isCompactViewport || mobilePanel !== "inspector" || !mobileInspectorSection) return;
    if (!["visual-clip", "overlay-clip"].includes(mobilePanelOrigin)) return;
    const segment = mobilePanelOrigin === "overlay-clip" ? selectedVisualOverlay : selectedVisualSegment;
    if (!segment) return;
    const isVector = segment.kind === "vector"
      || Boolean(segment.vectorBody)
      || String(segment.assetId || "").startsWith("vector-");
    const supportedSections = getVisualPropertyTabIds({
      isVector,
      isVideo: segment.type === "video",
      isOverlay: mobilePanelOrigin === "overlay-clip",
      hasVectorEditor: isVector,
      isMobile: true,
    });
    if (segment.type === "video") supportedSections.push("audio", "spatial");
    if (mobileInspectorSection !== "effects" && !supportedSections.includes(mobileInspectorSection)) setMobileInspectorSection(supportedSections[0] || "transform");
  }, [
    isCompactViewport,
    mobileInspectorSection,
    mobilePanel,
    mobilePanelOrigin,
    selectedVisualOverlay,
    selectedVisualSegment,
  ]);
  useEffect(() => {
    const clearCanvasVisualTarget = (event) => {
      if (event.target instanceof Element && event.target.closest(".preview-frame")) return;
      setCanvasVisualTarget("");
    };
    document.addEventListener("pointerdown", clearCanvasVisualTarget);
    return () => document.removeEventListener("pointerdown", clearCanvasVisualTarget);
  }, []);
  const visualLocalTime = Math.max(0, Math.min(
    selectedVisualSegment?.duration ?? 0,
    currentTime - (selectedVisualRange?.start ?? 0),
  ));
  const updateSelectedVisualEffects = (change) => {
    if (!selectedVisualSegment?.id || trackLocks.image) return notify("请先选择未锁定的 Visuals 片段");
    setVisualSegments((items) => {
      const nextItems = items.map((item) => {
        if (item.id !== selectedVisualSegment.id) return item;
        if (Number.isFinite(change.playbackRate) && item.type === "video") return updateVisualSegmentPlaybackRate(item, change.playbackRate);
        if (change.speedCurve && item.type === "video") return updateVisualSegmentSpeedCurve(item, change.speedCurve);
        if (change.baseTransform) return {
          ...item,
          baseTransform: normalizeVisualTransform({ ...item.baseTransform, ...change.baseTransform }),
        };
        if (change.keyframe) return { ...item, keyframes: upsertVisualKeyframe(item.keyframes, change.keyframe.time, change.keyframe) };
        if (change.propertyKeyframe) return { ...item, keyframes: upsertVisualPropertyKeyframe(item.keyframes, change.propertyKeyframe.time, change.propertyKeyframe.key, change.propertyKeyframe.value) };
        if (change.removePropertyKeyframe) return { ...item, keyframes: removeVisualPropertyKeyframe(item.keyframes, change.removePropertyKeyframe.time, change.removePropertyKeyframe.key) };
        if (Number.isFinite(change.removeKeyframeAt)) return { ...item, keyframes: (item.keyframes ?? []).filter((frame) => Math.abs(frame.time - change.removeKeyframeAt) > 0.04) };
        if (change.mask) return { ...item, mask: change.mask };
        if (change.animation) return { ...item, animation: change.animation };
        if (typeof change.filterId === "string") return { ...item, filterId: change.filterId };
        if (change.colorGrade) return { ...item, colorGrade: change.colorGrade };
        if (change.subjectEffect) return { ...item, subjectEffect: normalizeSubjectEffect(change.subjectEffect) };
        if (change.clickRipple) return { ...item, clickRipple: normalizeClickRippleEffect(change.clickRipple) };
        if (change.cinematicDepth) return { ...item, cinematicDepth: normalizeCinematicDepth(change.cinematicDepth) };
        if (change.photoParallax) return { ...item, photoParallax: normalizePhotoParallax(change.photoParallax) };
        if (change.cropX !== undefined) {
          const nextCropX = Math.max(0, Math.min(1, Number(change.cropX)));
          const updated = {
            ...item,
            cropX: nextCropX,
            fitMode: item.fitMode || "cover",
            cropOffset: { x: nextCropX, y: item.cropOffset?.y ?? 0 },
            objectPosition: `${(nextCropX * 100).toFixed(1)}% 50%`,
          };
          const activeSmartFrame = item.smartFrame || item.visualEffects?.smartFrame;
          if (activeSmartFrame && Array.isArray(activeSmartFrame.cropKeyframes) && activeSmartFrame.cropKeyframes.length > 0) {
            const isFallback = Boolean(
              activeSmartFrame.isFallback ||
              activeSmartFrame.state === "fallback" ||
              activeSmartFrame.metadata?.status === "fallback"
            );
            const updatedKeyframes = activeSmartFrame.cropKeyframes.map((kf) => {
              const width = kf.width || 1.0;
              if (isFallback || kf.isFallback || kf.state === "fallback") {
                const x = Math.max(0, Math.min(1 - width, nextCropX * (1 - width)));
                return {
                  ...kf,
                  x: Number(x.toFixed(4)),
                  cropX: Number(x.toFixed(4)),
                  panFactor: nextCropX,
                };
              }
              const baseX = Number.isFinite(kf.baseX) ? kf.baseX : kf.x;
              let idealX = baseX;
              if (nextCropX !== 0.5) {
                idealX += (nextCropX - 0.5) * (1 - width) * 0.4;
              }
              const clampedX = Math.max(0, Math.min(1 - width, idealX));
              const panFactor = (1 - width) > 0.0001 ? Number((clampedX / (1 - width)).toFixed(4)) : nextCropX;
              return {
                ...kf,
                baseX,
                x: Number(clampedX.toFixed(4)),
                cropX: Number(clampedX.toFixed(4)),
                panFactor,
              };
            });
            const nextSmartFrame = {
              ...activeSmartFrame,
              cropKeyframes: updatedKeyframes,
            };
            if (item.smartFrame) updated.smartFrame = nextSmartFrame;
            if (item.visualEffects?.smartFrame) {
              updated.visualEffects = { ...item.visualEffects, smartFrame: nextSmartFrame };
            }
          }
          return updated;
        }
        if (change.vectorPatch && (item.kind === "vector" || item.vectorBody)) return { ...item, ...change.vectorPatch };
        if (typeof change.enhancementEnabled === "boolean" && item.enhancement) {
          if (["remaster-drunet-full", "nanovsr-644k", "smart-denoise-drunet"].includes(item.enhancement.mode)) {
            const source = change.enhancementEnabled ? item.enhancement.processed : item.enhancement.original;
            if (!source?.src) return item;
            return {
              ...item,
              src: source.src,
              blob: source.blob,
              width: source.width,
              height: source.height,
              sourceStart: source.sourceStart,
              sourceDuration: source.sourceDuration,
              trackFrames: source.trackFrames ?? [],
              enhancement: { ...item.enhancement, enabled: change.enhancementEnabled },
            };
          }
          if (item.enhancement.previewUrl) return { ...item, enhancement: { ...item.enhancement, enabled: change.enhancementEnabled } };
        }
        if (typeof change.repairEnabled === "boolean" && item.repair) {
          const source = change.repairEnabled ? item.repair.processed : item.repair.original;
          if (!source?.src) return item;
          return {
            ...item,
            src: source.src,
            blob: source.blob,
            width: source.width,
            height: source.height,
            sourceStart: source.sourceStart,
            sourceDuration: source.sourceDuration,
            trackFrames: source.trackFrames ?? [],
            repair: { ...item.repair, enabled: change.repairEnabled },
          };
        }
        return item;
      });
      if (Number.isFinite(change.playbackRate) || change.speedCurve) {
        const nextSegment = nextItems.find((item) => item.id === selectedVisualSegment.id);
        const nextDuration = getVisualSegmentsTotal(nextItems);
        setImageDuration(nextDuration);
        setImageClipCount(getImageThumbnailCount(nextDuration));
        const previousSourceStart = Math.max(0, Number(selectedVisualSegment.sourceStart) || 0);
        const previousSourceDuration = Math.max(0.1, Number(selectedVisualSegment.sourceDuration)
          || (Number(selectedVisualSegment.duration) || 0.1) * (Number(selectedVisualSegment.playbackRate) || 1));
        const sourceProgress = Math.max(0, Math.min(
          1,
          (getVisualSourceTime(selectedVisualSegment, visualLocalTime) - previousSourceStart) / previousSourceDuration,
        ));
        const nextLocalTime = nextSegment?.speedCurve?.enabled
          ? getVisualSpeedCurveTimelineProgress(nextSegment.speedCurve, sourceProgress) * (nextSegment.duration || 0)
          : sourceProgress * (nextSegment?.duration || 0);
        setCurrentTime(() => Math.max(
          selectedVisualRange?.start ?? 0,
          Math.min(
            (selectedVisualRange?.start ?? 0) + (nextSegment?.duration ?? 0),
            (selectedVisualRange?.start ?? 0) + nextLocalTime,
          ),
        ));
      }
      return nextItems;
    });
  };
  const updateSelectedSubjectEffect = (nextEffect) => {
    if (!selectedEffectSegment?.id) return void notify(t("effectSelectClip"));
    const effect = normalizeSubjectEffect(nextEffect);
    if (selectedTrack === "overlay" && selectedVisualOverlay) {
      if (trackLocks.overlay) return void notify(t("effectClipLocked"));
      setVisualOverlaySegments((items) => items.map((item) => item.id === selectedVisualOverlay.id
        ? { ...item, subjectEffect: effect }
        : item));
      return;
    }
    updateSelectedVisualEffects({ subjectEffect: effect });
  };
  const removeSelectedSubjectEffect = () => {
    updateSelectedSubjectEffect(DEFAULT_SUBJECT_EFFECT);
    notify(t("effectRemoved"));
  };
  const updateSelectedClickRipple = (nextEffect) => {
    if (!selectedEffectSegment?.id) return void notify(t("effectSelectClip"));
    const clickRipple = normalizeClickRippleEffect(nextEffect);
    if (selectedTrack === "overlay" && selectedVisualOverlay) {
      if (trackLocks.overlay) return void notify(t("effectClipLocked"));
      setVisualOverlaySegments((items) => items.map((item) => item.id === selectedVisualOverlay.id
        ? { ...item, clickRipple }
        : item));
      return;
    }
    updateSelectedVisualEffects({ clickRipple });
  };
  const miganRepair = useMiganRepair({
    selectedSegment: selectedVisualSegment,
    imageUrlRefs,
    setVisualSegments,
    setUserAssets,
    notify,
    t,
  });
  const hdRestoration = useNanoVsrRestoration({
    selectedSegment: selectedVisualSegment,
    imageUrlRefs,
    setVisualSegments,
    setUserAssets,
    notify,
    t,
  });
  const smartDenoise = useSmartDenoise({
    selectedSegment: selectedVisualSegment,
    imageUrlRefs,
    setVisualSegments,
    setUserAssets,
    notify,
    t,
  });
  const setSmartFrameRatio = useCallback((nextRatioId) => {
    autoRatioSourceKeyRef.current = `locked:${nextRatioId}`;
    setRatioId(nextRatioId);
    if (nextRatioId !== ratioId) setFitMode("contain");
  }, [ratioId, setRatioId, setFitMode]);
  const smartFrame = useSmartFrame({
    selectedSegment: selectedVisualSegment,
    ratioId,
    setRatioId: setSmartFrameRatio,
    setVisualSegments,
    trackLocked: Boolean(trackLocks.image),
    notify,
  });
  const exportElapsedSeconds = useExportElapsed(exporting, exportStartRef);
  const {
    effectiveCaptionPlacement, previewSmartCropRect, previewVisionAnalysis,
    previewVisionMaskUrl, previewVisionOptions,
    previewSmartBackgroundPosition, previewVisualObjectFit, previewVisualObjectPosition,
    previewVisualRenderSrc,
  } = usePreviewModel({
    captionPlacement, captionSize, captionStyle, currentCaption, fitMode, previewFrameSize,
    previewVideoMediaTime, previewVisionBaseAnalysis, previewVisionRecord,
    previewVisualSourceTime, previewVisualSrc, previewVisualType, ratio,
    previewVisualSegment, previewSmartFrameOverride: smartFrame.previewOverride,
  });

  const { builtInAssets, filteredVoices, libraryType, libraryQuery, setLibraryQuery,
    selectLibraryType, libraryStatus, libraryError, libraryProvider, assetDownloadStates, prefetchLibraryAsset } = useEditorCatalog(voiceFilter);
  const generationPlugins = useGenerationPlugins({
    imageUrlRefs,
    notify,
    setActiveTool,
    setMediaTab,
    setSelectedLibraryAssetId,
    setUserAssets,
  });
  const handleGeneratedVector = (asset) => {
    setUserAssets((current) => [asset, ...current]);
    setSelectedLibraryAssetId(asset.id);
    setMediaTab("mine");
  };
  const depthReplacementLocksRef = useRef(trackLocks);
  useEffect(() => { depthReplacementLocksRef.current = trackLocks; }, [trackLocks]);
  const handleDepthMapAssetReady = (assetDraft, { sourceSegment } = {}) => {
    const id = crypto.randomUUID();
    const src = URL.createObjectURL(assetDraft.blob);
    imageUrlRefs.current.add(src);
    const asset = { ...assetDraft, id, src };
    setUserAssets((current) => [asset, ...current]);
    setSelectedLibraryAssetId(id);
    setActiveTool("media");
    setMediaTab("mine");
    if (sourceSegment) {
      const replace = (items) => items.map((item) => {
        // Never resurrect a deleted clip or overwrite a changed source range.
        if (item.id !== sourceSegment.id || item.src !== sourceSegment.src ||
          item.duration !== sourceSegment.duration || item.sourceStart !== sourceSegment.sourceStart ||
          item.sourceDuration !== sourceSegment.sourceDuration ||
          item.playbackRate !== sourceSegment.playbackRate ||
          JSON.stringify(item.speedCurve) !== JSON.stringify(sourceSegment.speedCurve)) return item;
        return {
          ...item, ...getVisualAssetPayload(asset), duration: item.duration,
          speedCurve: undefined, cinematicDepth: undefined, photoParallax: undefined,
          subjectEffect: undefined, repair: undefined, enhancement: undefined,
          volume: item.volume ?? 1, spatialEffect: item.spatialEffect, spatialAmount: item.spatialAmount,
          sourceAudioDisabled: item.sourceAudioDisabled === true, audioSeparated: item.audioSeparated === true,
          sourceAudioOriginAssetId: item.sourceAudioOriginAssetId || item.assetId,
          sourceAudioTiming: item.sourceAudioTiming || (Number.isFinite(item.sourceAudioOffset) || item.audioSeparated
            ? {
              sourceStart: item.sourceStart, sourceDuration: item.sourceDuration,
              playbackRate: item.playbackRate, speedCurve: item.speedCurve
            } : undefined),
          depthMapSourceAssetId: sourceSegment.assetId || "",
        };
      });
      if (!depthReplacementLocksRef.current.image) setVisualSegments(replace);
      // A picture-in-picture analysis replaces its own lane, never the main sequence.
      if (!depthReplacementLocksRef.current.overlay) setVisualOverlaySegments(replace);
      setIsPlaying(false);
    }
    return asset;
  };
  const handleOpticalFlowAssetReady = (assetDraft) => {
    const id = crypto.randomUUID();
    const src = URL.createObjectURL(assetDraft.blob);
    imageUrlRefs.current.add(src);
    const asset = { id, src, ...assetDraft };
    setUserAssets((current) => [asset, ...current]);
    setSelectedLibraryAssetId(id);
    setActiveTool("media");
    setMediaTab("mine");
    notify(t("effectFlowAddedToAssets"));
    return asset;
  };

  const {
    canDropAssetOnTrack, findAssetById, getActiveDraggedAsset, getDraggedAsset,
    getTimelineDropPercent, handleAssetClick, handleAssetDragEnd, handleAssetDragStart,
    confirmStickerSelection, handleAssetPointerDown, handleStickerClick, handleTrackAssetDragLeave,
    handleTrackAssetDragOver, triggerAssetDropPulse,
  } = createAssetDragControls({
    addStickerAssetToTimeline: (...args) => addStickerAssetToTimeline(...args), applyAssetToTrack: (...args) => applyAssetToTrack(...args), assetDropPulseTimerRef, builtInAssets, currentTime, draggedAssetId,
    draggedAssetIdRef, getStickerDragAsset, notify, pointerAssetDragRef, prefetchAsset: prefetchLibraryAsset,
    setAssetDragPreview, setAssetDropPosition, setAssetDropPulseTrack,
    setAssetDropTargetTrack, setDraggedAssetId, setSelectedLibraryAssetId,
    setSelectedStickerId, setSelectedStickerSegmentId, suppressAssetClickRef,
    t, timelineDuration, trackLocks, trackScrollRef, userAssets, visualSegments,
  });

  const analyzeCurrentVisual = useVisionAnalysis({
    activeTool,
    notify, previewVideoRef, previewVisionKey, previewVisualSegment, previewVisualSrc,
    previewVisualType, previewVisualRange, setCurrentTime, setPreviewVideoMediaTime,
    setVisionJob, setVisionRecords, visionAbortControllerRef,
    t, visionJob, visionJobGenerationRef, visionObjectUrlsRef,
  });
  const analyzeEffectVisual = useVisionAnalysis({
    activeTool: "effects",
    notify,
    previewVideoRef,
    previewVisionKey: effectVisionKey,
    previewVisualSegment: selectedEffectSegment,
    previewVisualSrc: selectedEffectSegment?.src || "",
    previewVisualType: selectedEffectSegment?.type || "image",
    previewVisualRange: selectedTrack === "overlay" && selectedVisualOverlay
      ? {
        start: selectedVisualOverlay.start || 0,
        end: (selectedVisualOverlay.start || 0) + (selectedVisualOverlay.duration || 0),
      }
      : selectedVisualRange,
    setCurrentTime,
    setPreviewVideoMediaTime,
    setVisionJob,
    setVisionRecords,
    t,
    visionAbortControllerRef,
    visionJob,
    visionJobGenerationRef,
    visionObjectUrlsRef,
  });

  const {
    removeVisionRecordsForAsset, setFitModeFromUser,
  } = createVisionControls({
    imageName, notify, previewVisionAnalysis, previewVisionBaseAnalysis, previewVisionKey,
    previewVisionOptions, previewVisionRecord, previewVisualSegment, previewVisualType,
    setFitMode, setVisionJob, setVisionRecords, visionAbortControllerRef,
    visionJob, visionJobGenerationRef, visionObjectUrlsRef,
  });

  const {
    alignAudioCaptions, alignCaptionToAudio, commitCaptionSegments, deleteCaptionSegment, handleCaptionPositionChange,
    linkAllCaptionAudio, linkAudioToCaption, linkCaptionAudio,
    startCaptionDrag, syncCaptionPositions, toggleCaptionSegmentHidden,
    unlinkAllCaptionAudio, unlinkAudioCaptions, unlinkCaptionAudio, updateCaptionSegmentText, updateScript,
  } = createCaptionEditingActions({
    audioSegments, captionPlacement, captionSegments, captionStyle, currentCaptionSegment, focusedSegmentIndex,
    notify, previewCanvasRef, previewVisionKey, previewVisionRecord, script,
    selectedSegmentId, setCaptionPlacement, setCaptionPosition, setCaptionSegments,
    setScript, setSelectedSegmentId, setSelectedTrack,
    setVisionRecords, t, trackLocks,
  });
  const importCaptionSegments = (importedSegments, mode, skipped = 0) => {
    const nextSegments = mode === "append"
      ? appendImportedCaptions(captionSegments, importedSegments)
      : importedSegments;
    const selectedIndex = nextSegments.findIndex((segment) => segment.id === importedSegments[0]?.id);
    commitCaptionSegments(
      nextSegments,
      t("srtImportComplete").replace("{count}", importedSegments.length).replace("{skipped}", skipped),
      Math.max(0, selectedIndex),
    );
    setCaptionsEnabled(true);
    setTrackVisibility((current) => ({ ...current, caption: true }));
  };
  const {
    clearAudioTrack, clearMusicTrack, clearSourceAudioTrack, commitAudio, commitAudioBatch,
    replaceAudio, replaceMusic, replaceSourceAudio,
  } = createAudioTrackActions({
    audioBlob, audioDuration, audioSegmentRefs, audioSegments, audioSegmentsRef, captionDuration, generatedVoiceEndRef,
    currentTimeRef, imageDuration, imageSrc, musicBlob, musicDuration, musicRef,
    musicUrlRef, notify, script, selectedVoice, selectedVoiceId, setActiveTool,
    setAudioSegments, setCaptionSegments, setCurrentTime, setHistoryItems,
    setIsPlaying, setMusicBlob, setMusicDuration, setMusicName, setMusicPeaks, setMusicSegments,
    setMusicStart, setMusicUrl, setProgress, setSelectedAudioSegmentId, setSelectedMusicSegmentId, setSelectedSegmentId,
    setSelectedTrack, setSourceAudioAssetId, setSourceAudioBlob, setSourceAudioDuration, setSourceAudioLinked, setSourceAudioName,
    setSourceAudioPeaks, setSourceAudioStart, setSourceAudioUrl, setSourceAudioVolume, setSourceAudioSpatialEffect, setSourceAudioSpatialAmount,
    setStatus, setStatusText, setTimelineHorizon, sourceAudioBlob, sourceAudioDuration,
    sourceAudioAssetId, sourceAudioRef, sourceAudioStart, sourceAudioUrlRef, t,
  });
  const moveSourceAudioToAudioLane = ({ segmentId = "source-audio", start = 0, lane = 0 } = {}) => {
    if (!(sourceAudioBlob instanceof Blob)) return false;
    const linkedPiece = sourceAudioLinked && segmentId !== "source-audio"
      ? linkedSourceAudioSegments.find((segment) => segment.id === segmentId) ?? null
      : null;
    const playbackRate = Math.max(0.25, Math.min(4, Number(linkedPiece?.playbackRate) || 1));
    const duration = Math.max(0, Number(linkedPiece?.duration ?? sourceAudioDuration) || 0);
    if (!(duration > 0)) return false;

    const nextId = crypto.randomUUID();
    const nextUrl = URL.createObjectURL(sourceAudioBlob);
    const sourceStart = Math.max(0, Number(linkedPiece?.sourceStart) || 0);
    const sourceDuration = Math.max(
      0,
      Number(linkedPiece?.sourceDuration) || Math.min(sourceAudioDuration - sourceStart, duration * playbackRate),
    );
    const nextSegment = {
      id: nextId,
      blob: sourceAudioBlob,
      url: nextUrl,
      start: Math.max(0, Number(start) || 0),
      duration,
      sourceStart,
      sourceDuration,
      playbackRate,
      peaks: linkedPiece
        ? sliceSourceAudioPeaks(sourceAudioPeaks, linkedPiece, sourceAudioDuration)
        : sourceAudioPeaks,
      volume: linkedPiece?.volume ?? sourceAudioVolume,
      ...(linkedPiece?.speedCurve ? { speedCurve: linkedPiece.speedCurve } : {}),
      fadeIn: 0,
      fadeOut: 0,
      reversed: false,
      spatialEffect: sourceAudioSpatialEffect,
      spatialAmount: sourceAudioSpatialAmount,
      lane: Math.max(0, Number(lane) || 0),
      name: sourceAudioName || t("sourceTrack"),
      sourceKind: "video-source",
      assetId: linkedPiece?.assetId || sourceAudioAssetId || "",
      sourceVisualSegmentId: linkedPiece?.id || "",
      sourceAudioWasLinked: Boolean(linkedPiece),
    };

    const hasExplicitSourceMappings = visualSegments.some((segment) => (
      segment.type === "video" && Number.isFinite(segment.sourceAudioOffset)
    ));
    const nextVisualSegments = visualSegments.map((segment) => {
      if (segment.type !== "video") return segment;
      const matchesPiece = linkedPiece
        ? segment.id === linkedPiece.id
        : hasExplicitSourceMappings
          ? Number.isFinite(segment.sourceAudioOffset)
          : Boolean(sourceAudioAssetId && segment.assetId === sourceAudioAssetId);
      return matchesPiece
        ? { ...segment, sourceAudioDisabled: true, sourceAudioRoutedToAudioSegmentId: nextId }
        : segment;
    });
    setVisualSegments(nextVisualSegments);
    setAudioSegments((segments) => [...segments, nextSegment]);

    const remainingLinkedPieces = sourceAudioLinked
      ? getLinkedSourceAudioSegments(nextVisualSegments, sourceAudioAssetId, sourceAudioDuration)
      : [];
    if (!sourceAudioLinked || !remainingLinkedPieces.length) {
      sourceAudioRef.current?.pause?.();
      if (sourceAudioUrlRef.current) URL.revokeObjectURL(sourceAudioUrlRef.current);
      sourceAudioUrlRef.current = "";
      setSourceAudioBlob(null);
      setSourceAudioUrl("");
      setSourceAudioName("");
      setSourceAudioDuration(0);
      setSourceAudioPeaks([]);
      setSourceAudioStart(0);
      setSourceAudioAssetId("");
      setSourceAudioLinked(true);
      setSourceAudioSpatialEffect("original");
      setSourceAudioSpatialAmount(1);
      sourceVoiceColorOriginalRef.current = null;
    }

    setSelectedSourceAudioSegmentId("");
    setSelectedAudioSegmentId(nextId);
    setSelectedTrack("audio");
    setActiveTool("audio");
    setTimelineHorizon((value) => Math.max(value, nextSegment.start + nextSegment.duration));
    notify(t("sourceAudioMovedToAudioTrack"));
    return true;
  };
  const markEmbeddedAudioSeparated = useCallback((track, segmentId, audioSegmentId) => {
    if (track === "image") {
      setVisualSegments((segments) => segments.map((segment) => (
        segment.id === segmentId
          ? { ...segment, sourceAudioDisabled: true, audioSeparated: true, sourceAudioRoutedToAudioSegmentId: audioSegmentId }
          : segment
      )));
      return;
    }
    if (track === "overlay") {
      setVisualOverlaySegments((segments) => segments.map((segment) => (
        segment.id === segmentId
          ? { ...segment, muted: true, audioSeparated: true, sourceAudioRoutedToAudioSegmentId: audioSegmentId }
          : segment
      )));
    }
  }, [setVisualOverlaySegments, setVisualSegments]);
  const { separateAudioClipVocals, separateSourceVocals, vocalSeparationJob } = useVocalSeparation({
    sourceAudioBlob, sourceAudioName, replaceAudio, replaceSourceAudio, replaceMusic,
    markEmbeddedAudioSeparated, notify, t,
  });
  const selectedSourceAudioPiece = linkedSourceAudioSegments.find((segment) => segment.id === selectedSourceAudioSegmentId) ?? null;
  const selectedMusicSegment = musicSegments.find((segment) => segment.id === selectedMusicSegmentId) ?? null;
  useEffect(() => {
    if (selectedMusicSegmentId && !selectedMusicSegment) setSelectedMusicSegmentId("");
  }, [selectedMusicSegment, selectedMusicSegmentId]);
  const selectedVideoAudioTarget = resolveAudioToolVideoTarget({
    selectedTrack,
    selectedVisualSegment: selectedVisualSegmentId ? selectedVisualSegment : null,
    selectedVisualRange: selectedVisualSegmentId ? selectedVisualRange : null,
    selectedVisualOverlay,
    previewVisualSegment,
    previewVisualRange,
  });
  const selectedAudioToolTarget = selectedTrack === "audio" && selectedAudioSegmentId && selectedAudioSegment
    ? { ...selectedAudioSegment, segmentId: selectedAudioSegment.id, track: "audio", canChangeSpeed: true }
    : selectedTrack === "music" && musicBlob
      ? { ...(selectedMusicSegment ?? musicSegments[0] ?? { id: "music-audio", start: musicStart, duration: musicDuration, sourceStart: 0, sourceDuration: musicDuration, playbackRate: 1 }), blob: musicBlob, name: musicName || t("musicTrack"), segmentId: selectedMusicSegment?.id || musicSegments[0]?.id || "music-audio", track: "music", volume: selectedMusicSegment?.volume ?? musicSegments[0]?.volume ?? musicVolume, canChangeSpeed: true }
      : selectedTrack === "source" && sourceAudioBlob
        ? { ...(selectedSourceAudioPiece ?? {}), blob: sourceAudioBlob, name: sourceAudioName, start: selectedSourceAudioPiece?.start ?? sourceAudioStart, sourceStart: selectedSourceAudioPiece?.sourceStart ?? 0, duration: selectedSourceAudioPiece?.duration ?? sourceAudioDuration, sourceDuration: selectedSourceAudioPiece?.sourceDuration ?? sourceAudioDuration, playbackRate: selectedSourceAudioPiece?.playbackRate ?? 1, segmentId: selectedSourceAudioSegmentId || "source-audio", track: "source", volume: selectedSourceAudioPiece?.volume ?? sourceAudioVolume, spatialEffect: sourceAudioSpatialEffect, spatialAmount: sourceAudioSpatialAmount, canChangeStart: !sourceAudioLinked, canChangeSpeed: Boolean(sourceAudioLinked && selectedSourceAudioPiece), voiceColorOriginalBlob: sourceVoiceColorOriginalRef.current?.blob || null }
        : selectedVideoAudioTarget;
  const separateSelectedAudioVocals = () => selectedAudioToolTarget?.track === "source"
    ? separateSourceVocals()
    : selectedAudioToolTarget && separateAudioClipVocals(selectedAudioToolTarget);

  const {
    chooseInterfaceLanguage, clearAllVisionState, selectTool, toggleTrackLock,
    toggleTrackVisibility, useHistoryItem,
  } = createEditorCommandActions({
    notify, replaceAudio, script, selectedTrack, selectedVisualSegment, selectedVisualOverlay, setActiveTool, setCaptionSegments,
    setIntroClosing, setScript, setSelectedSegmentId, setSelectedTrack,
    setSelectedVoiceId, setTrackLocks, setTrackVisibility, setUiLanguage,
    setVisionJob, setVisionRecords, setVoiceTab, visionAbortControllerRef,
    visionJobGenerationRef, visionObjectUrlsRef,
  });

  const {
    appendVisualAssetToTimeline, clearImageTrack, commitVisualSegments,
    getCurrentVisualAssetSnapshot, getVisualDurationForAsset, replaceVisualTimeline,
    setCurrentVisualAsset, updateVisualAssetInTimeline,
  } = createVisualTimelineActions({
    audioBlob, audioDuration, captionDuration,
    extractVideoSourceAudio: (...args) => extractVideoSourceAudio(...args),
    imageDuration, imageMeta, imageName, imageSrc, musicBlob, musicDuration, notify, rippleTimelineAfter,
    previewVisualSegment, script, seekTo: (...args) => seekTo(...args), setCurrentTime,
    setFitMode, setImageClipCount, setImageDuration, setImageMeta, setImageName,
    setImageSrc, setSelectedTrack, setSelectedVisualSegmentId, setVisualSegments,
    setTimelineZoom, setVisualType, sourceAudioBlob, sourceAudioDuration, sourceAudioStart, trackLocks,
    visualSegments, visualType,
  });

  const {
    addStickerAssetToTimeline, commitStickerSegments, getTimelineTimeFromDropPercent,
  } = createStickerTimelineActions({
    estimatedDuration, notify, seekTo: (...args) => seekTo(...args), setActiveTool,
    setSelectedStickerId, setSelectedStickerSegmentId, setSelectedTrack,
    setStickerSegments, stickerSegments, t, timelineDurationRef, trackLocks,
  });
  const selectedStickerSegment = stickerSegments.find((segment) => segment.id === selectedStickerSegmentId) ?? currentStickerSegment;
  useEffect(() => {
    const normalized = normalizeTimedSegmentIds(stickerSegments, "sticker");
    if (normalized !== stickerSegments) setStickerSegments(normalized);
  }, [setStickerSegments, stickerSegments]);
  const updateSelectedStickerSegment = (change) => {
    if (!selectedStickerSegment?.id) return;
    setStickerSegments((segments) => segments.map((segment) => segment.id === selectedStickerSegment.id ? { ...segment, ...change } : segment));
  };
  const updateCanvasStickerSegment = (segmentId, change) => {
    if (!segmentId) return;
    setStickerSegments((segments) => segments.map((segment) => segment.id === segmentId ? { ...segment, ...change } : segment));
  };
  const selectCanvasStickerSegment = (segmentId) => {
    if (!segmentId) return;
    setSelectedStickerSegmentId(segmentId);
    setSelectedTrack("sticker");
  };
  const deleteSelectedStickerSegment = () => {
    if (!selectedStickerSegment?.id) return;
    commitStickerSegments(stickerSegments.filter((segment) => segment.id !== selectedStickerSegment.id), "已删除贴纸片段");
  };

  const faceSwap = useFaceSwapGeneration({
    downloadBlob, imageDuration, imageUrlRefs, notify, previewVisualSegment, previewVisualSrc,
    previewVisualType, setActiveTool, setMediaTab, setSelectedLibraryAssetId,
    setUserAssets, t,
  });

  const { startVoiceRecording, stopVoiceRecording } = useVoiceRecorder({
    notify, recordingState, setActiveTool, setProgress,
    setRecordedVoices, setRecordingElapsed, setRecordingState,
    setStatus, setStatusText, setVoiceTab, t, voiceRecorderChunksRef,
    voiceRecorderRef, voiceRecorderStartedAtRef, voiceRecorderStreamRef,
    voiceRecorderTimerRef,
  });

  const generateVoiceover = useVoiceGeneration({
    addVoiceProfile, commitAudio, commitAudioBatch, notify, script, selectedVoice, setProgress, setStatus,
    setStatusText, setVoiceTab, speed, status, t, selectedVoiceProfile, volume,
  });

  const { deleteAudioSegment, toggleAudioSegmentReverse, updateAudioSegment } = createAudioClipActions({
    audioSegmentRefs, audioSegments, notify, setAudioSegments, setCaptionSegments,
    setSelectedAudioSegmentId, setTimelineHorizon, t,
  });
  const handleVoiceColorAssetReady = async ({ blob, decoded, profileName, sourceName }) => {
    const id = crypto.randomUUID(); const src = URL.createObjectURL(blob); imageUrlRefs.current.add(src);
    const asset = {
      id, type: "audio", kind: "voiceover", name: `${sourceName || t("audioClip")} · ${profileName}`,
      meta: `${t("voiceColorTab", "音色")} · ${decoded.duration.toFixed(1)}s`, src, previewSrc: src, blob,
      duration: decoded.duration, peaks: decoded.peaks, generated: true, provider: "OpenVoice V2 · ONNX"
    };
    setUserAssets((items) => [asset, ...items]); setSelectedLibraryAssetId(id);
    notify(t("voiceColorSavedToAssets", "音色迁移结果已保存到我的素材")); return asset;
  };
  const applyVoiceColorToSelectedAudio = ({ blob, decoded, profileName, segment }) => {
    const url = URL.createObjectURL(blob); imageUrlRefs.current.add(url);
    const target = audioSegments.find((item) => item.id === segment.id);
    const targetTrack = segment.track || (target ? "audio" : selectedTrack);
    if (targetTrack === "audio") {
      if (!target) { URL.revokeObjectURL(url); imageUrlRefs.current.delete(url); notify(t("audioClipMissing")); return false; }
      audioSegmentRefs.current.get(segment.id)?.pause?.();
      if (target.voiceColorOriginalBlob && target.url && target.url !== target.voiceColorOriginalUrl) {
        URL.revokeObjectURL(target.url); imageUrlRefs.current.delete(target.url);
      }
      setAudioSegments((items) => items.map((item) => item.id === segment.id ? {
        ...item,
        voiceColorOriginalBlob: item.voiceColorOriginalBlob || item.blob,
        voiceColorOriginalUrl: item.voiceColorOriginalUrl || item.url,
        voiceColorOriginalPeaks: item.voiceColorOriginalPeaks || item.peaks,
        voiceColorOriginalName: item.voiceColorOriginalName || item.name,
        voiceColorOriginalSourceKind: item.voiceColorOriginalSourceKind || item.sourceKind,
        blob, url, peaks: decoded.peaks, name: `${item.voiceColorOriginalName || item.name} · ${profileName}`,
        voiceName: profileName, sourceKind: "cloned-voiceover", cloneVoiceProfileName: profileName,
      } : item));
    } else if (targetTrack === "source") {
      sourceAudioRef.current?.pause?.();
      if (!sourceVoiceColorOriginalRef.current) sourceVoiceColorOriginalRef.current = {
        blob: sourceAudioBlob, url: sourceAudioUrl, peaks: sourceAudioPeaks, name: sourceAudioName, duration: sourceAudioDuration,
      };
      else if (sourceAudioUrl && sourceAudioUrl !== sourceVoiceColorOriginalRef.current.url) {
        URL.revokeObjectURL(sourceAudioUrl); imageUrlRefs.current.delete(sourceAudioUrl);
      }
      sourceAudioUrlRef.current = url; setSourceAudioBlob(blob); setSourceAudioUrl(url); setSourceAudioPeaks(decoded.peaks);
      setSourceAudioName(`${sourceVoiceColorOriginalRef.current.name || t("sourceTrack")} · ${profileName}`);
    } else { URL.revokeObjectURL(url); imageUrlRefs.current.delete(url); return false; }
    notify(t("voiceColorClipReplaced", "已替换当前片段，可随时恢复原始声音"));
    return true;
  };
  const restoreSelectedAudioVoiceColor = (segment) => {
    const target = audioSegments.find((item) => item.id === segment.id);
    const targetTrack = segment.track || (target ? "audio" : selectedTrack);
    if (targetTrack === "audio") {
      if (!target?.voiceColorOriginalBlob) return false;
      audioSegmentRefs.current.get(segment.id)?.pause?.();
      if (target.url && target.url !== target.voiceColorOriginalUrl) {
        URL.revokeObjectURL(target.url); imageUrlRefs.current.delete(target.url);
      }
      setAudioSegments((items) => items.map((item) => item.id === segment.id ? {
        ...item, blob: item.voiceColorOriginalBlob, url: item.voiceColorOriginalUrl,
        peaks: item.voiceColorOriginalPeaks, name: item.voiceColorOriginalName,
        sourceKind: item.voiceColorOriginalSourceKind, voiceColorOriginalBlob: null,
        voiceColorOriginalUrl: "", voiceColorOriginalPeaks: null, voiceColorOriginalName: "", voiceColorOriginalSourceKind: "",
      } : item));
    } else if (targetTrack === "source" && sourceVoiceColorOriginalRef.current) {
      sourceAudioRef.current?.pause?.();
      const original = sourceVoiceColorOriginalRef.current; sourceAudioUrlRef.current = original.url;
      if (sourceAudioUrl && sourceAudioUrl !== original.url) { URL.revokeObjectURL(sourceAudioUrl); imageUrlRefs.current.delete(sourceAudioUrl); }
      setSourceAudioBlob(original.blob); setSourceAudioUrl(original.url); setSourceAudioPeaks(original.peaks);
      setSourceAudioName(original.name); setSourceAudioDuration(original.duration); sourceVoiceColorOriginalRef.current = null;
    } else return false;
    notify(t("voiceColorOriginalRestored", "已恢复原始声音"));
    return true;
  };
  const updateSelectedTrackAudioSegment = (id, patch) => {
    if (["image", "overlay"].includes(selectedTrack)) {
      const lock = selectedTrack === "image" ? trackLocks.image : trackLocks.overlay;
      if (lock) return;
      const audioPatch = {};
      if (Number.isFinite(patch.volume)) audioPatch.volume = Math.max(0, Math.min(4, patch.volume));
      if (typeof patch.spatialEffect === "string") audioPatch.spatialEffect = patch.spatialEffect;
      if (Number.isFinite(patch.spatialAmount)) audioPatch.spatialAmount = Math.max(0, Math.min(1, patch.spatialAmount));
      const update = selectedTrack === "image" ? setVisualSegments : setVisualOverlaySegments;
      update(items => items.map(item => item.id === id && item.type === "video" ? { ...item, ...audioPatch } : item));
      return;
    }
    if (selectedTrack === "audio") return updateAudioSegment(id, patch);
    if (selectedTrack === "music") {
      setMusicSegments((segments) => {
        const source = segments.length ? segments : [{ id: "music-audio", start: musicStart, duration: musicDuration, sourceStart: 0, sourceDuration: musicDuration, playbackRate: 1, peaks: musicPeaks }];
        const next = source.map((segment) => {
          if (segment.id !== id) return segment;
          const normalizedPatch = Number.isFinite(patch.volume)
            ? { ...patch, volume: Math.max(0, Math.min(4, patch.volume)) }
            : patch;
          return Number.isFinite(normalizedPatch.playbackRate)
            ? { ...updateAudioSegmentPlaybackRate(segment, normalizedPatch.playbackRate), ...normalizedPatch }
            : { ...segment, ...normalizedPatch };
        });
        const nextStart = Math.min(...next.map((segment) => segment.start));
        setMusicStart(nextStart);
        return next;
      });
      return;
    }
    if (selectedTrack === "source") {
      if (Number.isFinite(patch.volume)) {
        const volume = Math.max(0, Math.min(4, patch.volume));
        if (sourceAudioLinked && id !== "source-audio") setVisualSegments((items) => items.map((item) => item.id === id ? { ...item, sourceAudioVolume: volume } : item));
        else setSourceAudioVolume(volume);
      }
      if (typeof patch.spatialEffect === "string") setSourceAudioSpatialEffect(patch.spatialEffect);
      if (Number.isFinite(patch.spatialAmount)) setSourceAudioSpatialAmount(Math.max(0, Math.min(1, patch.spatialAmount)));
      if (!sourceAudioLinked && Number.isFinite(patch.start)) setSourceAudioStart(Math.max(0, patch.start));
      if (sourceAudioLinked && id !== "source-audio" && Number.isFinite(patch.playbackRate)) {
        setVisualSegments((segments) => {
          const next = segments.map((segment) => segment.id === id ? updateVisualSegmentPlaybackRate(segment, patch.playbackRate) : segment);
          const nextDuration = getVisualSegmentsTotal(next);
          setImageDuration(nextDuration);
          setImageClipCount(getImageThumbnailCount(nextDuration));
          return next;
        });
      }
    }
  };

  const { handleAddCaptionSegment, handleAddSegment, handleRemoveSegment } = createTimelineSegmentCountActions({
    captionSegments, clearImageTrack, commitCaptionSegments, commitStickerSegments,
    commitVisualSegments, currentStickerSegmentIndex, currentTime, captionStyle,
    currentVisualSegmentIndex, deleteCaptionSegment, focusedSegmentIndex,
    getCurrentVisualAssetSnapshot, getStickerDragAsset, imageClipCount,
    imageDuration, imageSrc, notify, rippleTimelineAfter, selectedSegmentId, selectedSegmentIndex,
    selectedSticker, selectedStickerSegmentId, selectedTrack,
    selectedVisualSegmentId, selectedVisualSegmentIndex, stickerSegments,
    t, trackLocks, visualSegments,
  });

  const adjustSelectedSegmentWeight = createTimelineDurationActions({
    captionSegments, commitCaptionSegments, commitStickerSegments,
    commitVisualSegments, currentStickerSegmentIndex, currentVisualSegmentIndex,
    focusedSegmentIndex, getCurrentVisualAssetSnapshot, imageDuration, imageSrc,
    notify, selectedSegmentId, selectedSegmentIndex, selectedStickerSegmentId,
    selectedTrack, selectedVisualSegmentId, selectedVisualSegmentIndex,
    rippleTimelineAfter, stickerSegments, trackLocks, visualSegments,
  });

  const { handleDeleteTrack, handleDuplicateTrack } = createTimelineClipboardActions({
    audioBlob, audioSegments, captionSegments, clearImageTrack, clearMusicTrack, clearSourceAudioTrack,
    commitCaptionSegments, commitStickerSegments, commitVisualSegments,
    currentStickerSegmentIndex, currentVisualSegmentIndex, deleteAudioSegment,
    focusedSegmentIndex, getCurrentVisualAssetSnapshot, handleRemoveSegment,
    imageClipCount, imageDuration, imageMeta, imageName, imageSrc, musicBlob, musicDuration, musicName, musicPeaks, musicSegments, musicStart,
    notify, rippleTimelineAfter, selectedAudioSegment, selectedAudioSegmentId, selectedMusicSegmentId, selectedSegmentId,
    selectedSegmentIndex, selectedStickerSegmentId, selectedTrack,
    selectedVisualSegmentId, selectedVisualSegmentIndex, setAudioSegments,
    setCaptionSegments, setMusicSegments, setMusicStart, setSelectedAudioSegmentId, setSelectedMusicSegmentId, sourceAudioBlob,
    sourceAudioLinked, sourceAudioName, selectedSourceAudioSegmentId, linkedSourceAudioSegments,
    setSelectedSourceAudioSegmentId, stickerSegments, t, trackLocks, visualSegments, visualType,
    visualOverlaySegments, selectedVisualOverlayId, setVisualOverlaySegments, setSelectedVisualOverlayId,
  });

  useEditorLifecycle({
    activeLanguage, audioSegments, audioUrlRef, autoRatioSourceKeyRef,
    captionSegments, currentVisualSegment, handleDeleteTrack,
    imageUrlRefs, musicBlob, musicUrlRef, notify, ratioId, replaceAudio,
    replaceVisualTimeline, selectedAudioSegmentId, selectedSegmentId,
    selectedStickerSegmentId, selectedTrack, selectedVisualSegmentId, setCurrentVisualAsset,
    selectedVisualOverlayId, visualOverlaySegments,
    setFitMode, setRatioId, setSelectedSegmentId, setSelectedVisualSegmentId,
    setUserAssets, setVisualSegments, sourceAudioBlob, sourceAudioUrlRef, stickerSegments,
    setSelectedVisualOverlayId,
    visionAbortControllerRef, visionObjectUrlsRef, visualSegments,
    voiceRecorderStreamRef, voiceRecorderTimerRef,
  });

  const { handleCutTrack } = createTimelineCutActions({
    audioSegments, captionSegments, captionTargetDuration, commitCaptionSegments, commitStickerSegments, commitVisualSegments,
    currentStickerSegmentIndex, currentTime, focusedSegmentIndex,
    getCurrentVisualAssetSnapshot, imageDuration, imageSrc, notify,
    musicBlob, musicDuration, musicPeaks, musicSegments, musicStart,
    selectedAudioSegmentId, selectedMusicSegmentId, selectedSegmentId, selectedSegmentIndex, selectedStickerSegmentId,
    setAudioSegments, setCaptionSegments, setMusicSegments, setSelectedAudioSegmentId, setSelectedMusicSegmentId,
    selectedTrack, stickerSegments, t, trackLocks, visualSegments,
    visualOverlaySegments, selectedVisualOverlayId, setVisualOverlaySegments, setSelectedVisualOverlayId,
  });

  const { finishTimelinePlayback, getTimelineTimeFromClientX, handlePlayToggle, pauseTimelineMedia, seekTo, startTimelineSeek } = createPlaybackControls({
    playbackSessionRef,
    timelineMarkers, setSnapGuide,
    audioSegmentRefs, audioSegments, canPreview, currentTimeRef, currentVisualRange,
    estimatedDuration, isPlaying, musicDuration, musicSegments, musicRef, musicStart, musicUrl, notify,
    linkedSourceAudioSegments, previewVideoRef, previewVisualType, setCurrentTime, setIsPlaying, setPreviewVideoMediaTime, sourceAudioDuration,
    sourceAudioLinked,
    sourceAudioRef, sourceAudioStart, sourceAudioUrl, sourceAudioVolume, sourceAudioSpatialEffect, sourceAudioSpatialAmount, timelineDuration,
    timelineDurationRef, trackScrollRef, trackVisibility, visualSegments, visualTimeline, previewVisualSegment,
    visualPlaybackLastUpdateRef, visualPlaybackStartedAtRef, visualPlaybackStartTimeRef,
  });
  const pauseForTimelineEdit = () => {
    if (!isPlaying) return;
    pauseTimelineMedia();
    setIsPlaying(false);
  };

  useMediaSync({
    finishTimelinePlayback, playbackSessionRef,
    audioRef, audioSegmentRefs, audioSegments, currentTime, currentTimeRef, estimatedDuration,
    isPlaying, musicDuration, musicSegments, musicRef, musicStart, musicUrl, musicVolume, pauseTimelineMedia, previewVideoRef,
    previewVisualSegment, previewVisualSourceTime, previewVisualSrc, previewVisualType,
    previewVisualRange,
    linkedSourceAudioSegments, setCurrentTime, setIsPlaying, setPreviewVideoMediaTime, sourceAudioDuration,
    sourceAudioLinked,
    sourceAudioRef, sourceAudioStart, sourceAudioUrl, sourceAudioVolume, sourceAudioSpatialEffect, sourceAudioSpatialAmount, timelineDuration,
    trackVisibility, visualPlaybackFrameRef, visualPlaybackLastUpdateRef,
    visualPlaybackStartedAtRef, visualPlaybackStartTimeRef,
  });

  const { startAudioSegmentMove, startMusicMove, startSourceAudioMove, startStickerSegmentMove, startStickerSegmentResize } = createTimelineMoveControls({
    timelineMarkers, timelineDuration,
    audioSegments, captionSegments, captionTargetDuration, estimatedDuration, notify, seekTo, setActiveTool,
    setAudioSegments, setCaptionSegments, setSelectedAudioSegmentId, setSelectedStickerId,
    setSelectedStickerSegmentId, setSelectedTrack, setStickerSegments, setTimelineHorizon,
    setMusicStart, setSelectedMusicSegmentId, setSelectedSourceAudioSegmentId, setSourceAudioLinked, setSourceAudioStart, musicDuration, musicSegments, musicStart, setMusicSegments,
    linkedSourceAudioSegments, sourceAudioDuration, sourceAudioLinked, sourceAudioStart, stickerSegments, suppressTimelineClipClickRef, t, timelineDurationRef,
    trackLocks, trackVisibility, trackScrollRef, pauseForTimelineEdit, visualSegments, setVisualSegments, visualOverlaySegments, currentTime, setSnapGuide, commitStickerSegments,
    setStickerTimelineDrag, moveSourceAudioToAudioLane, setSourceAudioDragTargetLane,
  });

  const startImageResize = createImageResizeControl({
    timelineMarkers,
    audioBlob, audioDuration, captionDuration, getCurrentVisualAssetSnapshot,
    imageDuration, imageSrc, musicBlob, musicDuration, musicStart, notify, rippleTimelineAfter, script,
    setCurrentTime, setImageClipCount, setImageDuration, setSelectedTrack,
    setSelectedVisualSegmentId, setSnapGuide, setVisualSegments, sourceAudioBlob,
    sourceAudioDuration, sourceAudioStart, timelineDuration, timelineDurationRef,
    setTimelineHorizon, t, trackLocks, trackScrollRef, visualSegments, pauseForTimelineEdit,
  });

  const extractVideoSourceAudio = useSourceAudioExtraction({
    clearSourceAudioTrack, notify, replaceSourceAudio, setProgress, setStatus, setStatusText,
    replaceAudio, setVisualOverlaySegments, setVisualSegments, sourceAudioBlob, sourceAudioDuration, t,
  });

  const [transcriptReview, setTranscriptReview] = useState(null);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const handleTestOpen = (e) => {
      if (e.detail) {
        setTranscriptReview({
          isOpen: true,
          ...e.detail,
        });
      }
    };
    window.addEventListener("test:open-transcript-review", handleTestOpen);
    return () => {
      window.removeEventListener("test:open-transcript-review", handleTestOpen);
    };
  }, []);

  const handleApplyTranscriptReview = useCallback(({ segments, text: reviewedText }) => {
    const reviewedSegments = preserveTranscriptionOutcome(segments, transcriptReview);
    if (!reviewedSegments || !reviewedSegments.length) {
      setTranscriptReview(null);
      return;
    }
    const append = transcriptReview?.append;
    const timelineOffset = transcriptReview?.timelineOffset || 0;

    checkpointHistory();

    setCaptionSegments((prev) => {
      const combined = (append ? [...prev, ...reviewedSegments] : reviewedSegments)
        .sort((a, b) => (a.start || 0) - (b.start || 0));
      let inheritedFontId = captionStyle?.fontId || "default";
      return combined.map((segment) => {
        inheritedFontId = segment.fontId || inheritedFontId;
        return segment.fontId ? segment : { ...segment, fontId: inheritedFontId };
      });
    });

    setScript((prev) => (append && prev ? `${prev}\n${reviewedText}` : reviewedText));
    setSelectedSegmentId(reviewedSegments[0]?.id ?? "");
    setSelectedTrack("caption");
    setActiveTool("caption");
    setCaptionsEnabled(true);
    setTrackVisibility((v) => ({ ...v, caption: true }));
    const complete = `${t("autoCaptionsComplete").replace("{count}", reviewedSegments.length)} · ${editorTranscriptionStatus(transcriptReview)}`;
    setStatusText(complete);
    notify(complete);
    seekTo(reviewedSegments[0]?.start ?? timelineOffset);
    setTranscriptReview(null);
  }, [transcriptReview, captionStyle, checkpointHistory, notify, seekTo, setActiveTool, setCaptionSegments, setCaptionsEnabled, setScript, setSelectedSegmentId, setSelectedTrack, setTrackVisibility, setStatusText, t]);

  const captionSourceState = {
    sourceAudioBlob, sourceAudioStart, visualSegments, audioSegments, userAssets,
    selectedVisualSegmentId, selectedAudioSegmentId, selectedTrack, status, trackLocks
  };
  const canGenerateCaptions = useCaptionSourceAvailability(captionSourceState);
  const canGenerateAudioCaptions = useCaptionSourceAvailability(
    selectedAudioToolTarget ? captionSourceState : { status, trackLocks }, selectedAudioToolTarget || {});
  const { generate: generateCaptionsFromSourceAudio, cancel: cancelCaptionTranscription } = useAutoCaptions({
    notify, script, seekTo, setActiveTool, setCaptionSegments, captionStyle,
    setCaptionsEnabled, setProgress, setScript, setSelectedSegmentId,
    setSelectedTrack, setStatus, setStatusText, setTrackVisibility, sourceAudioBlob,
    sourceAudioStart, status, t, trackLocks, uiLanguage,
    setTranscriptReview, visualSegments, audioSegments, userAssets,
    selectedVisualSegmentId, selectedAudioSegmentId, selectedTrack,
  });

  const handleFiles = useFileUpload({
    appendVisualAssetToTimeline, imageUrlRefs, notify, setSelectedLibraryAssetId, setSelectedTrack, setUserAssets,
    updateVisualAssetInTimeline, visualSegments, t,
    onFirstVisualAutoAdded: requestFirstVisualGuide,
  });

  const { deleteUserAsset, selectAsset } = createAssetLibraryActions({
    clearImageTrack, clearMusicTrack, clearSourceAudioTrack, commitVisualSegments,
    extractVideoSourceAudio, getVisualDurationForAsset, imageSrc, imageUrlRefs,
    musicBlob, notify, removeVisionRecordsForAsset, replaceMusic, replaceVisualTimeline,
    selectedLibraryAssetId, setSelectedLibraryAssetId, setUserAssets, sourceAudioBlob,
    userAssets, visualSegments,
  });

  const { applyAssetToTrack, handleTrackAssetDrop, handleVisualStyleDrop } = createAssetDropActions({
    addStickerAssetToTimeline, addVisualOverlay: (...args) => addVisualOverlay(...args), appendVisualAssetToTimeline, canDropAssetOnTrack, clearImageTrack,
    draggedAssetIdRef, extractVideoSourceAudio, getDraggedAsset, getTimelineDropPercent, imageUrlRefs,
    notify, onFirstVisualDropped: requestFirstVisualGuide, replaceAudio, selectAsset, setActiveTool, setAssetDropPosition,
    setAssetDropTargetTrack, setDraggedAssetId, setSelectedFilterId,
    setSelectedLibraryAssetId, setSelectedTrack, setSelectedTransitionId,
    setSelectedVisualSegmentId, setVisualSegments, trackScrollRef, resolveVisualDropIntent, updateVisualAssetInTimeline,
    t, timelineDuration, triggerAssetDropPulse, visualSegments,
  });
  const addVisualOverlay = (asset, options = {}) => {
    if (!asset?.src || (asset.type !== "image" && asset.type !== "video")) return;
    const startTime = Number.isFinite(options.startTime)
      ? options.startTime
      : Number.isFinite(options.percent)
        ? options.percent / 100 * timelineDuration
        : currentTime;
    const targetLayer = Number.isFinite(Number(options.layer))
      ? Math.max(1, Number(options.layer))
      : visualOverlaySegments.length + 1;
    const overlay = createVisualOverlaySegment(asset, startTime, {
      layer: targetLayer,
      ...(Number.isFinite(Number(options.layer)) ? { lane: targetLayer - 1 } : {}),
    });
    setVisualOverlaySegments((items) => [...items, overlay]);
    setSelectedVisualOverlayId(overlay.id);
    setSelectedVisualSegmentId("");
    setSelectedTrack("overlay");
    notify("已添加为画中画，可在预览中拖动、缩放和旋转");
  };
  const applyOverlayTemplate = async (template) => {
    const result = instantiateTemplate({
      template,
      existingOverlays: visualOverlaySegments,
      assets: [...userAssets, ...visualSegments, ...visualOverlaySegments],
      startTime: currentTime,
      trackLocks,
    });
    if (!result.applied) {
      notify(result.warnings[0] || t("overlayTemplateApplyFailed", "Template could not be applied to the timeline."));
      return result;
    }
    const selectedCreatedOverlay = result.created.find((overlay) => overlay.id === result.selectedId)
      || result.created[0]
      || null;
    setVisualOverlaySegments(result.overlays);
    setSelectedVisualOverlayId(result.selectedId || "");
    setCanvasVisualTarget(result.selectedId ? `overlay:${result.selectedId}` : "");
    setSelectedVisualSegmentId("");
    setSelectedTrack("overlay");
    if (selectedCreatedOverlay) {
      seekTo(selectedCreatedOverlay.start, { immediate: true, pause: true });
    }
    const warningSuffix = result.warnings.length ? ` ${result.warnings.join(" ")}` : "";
    notify(`${result.created.length} overlay element${result.created.length === 1 ? "" : "s"} added at the playhead.${warningSuffix}`);
    return result;
  };
  const saveVisualOverlayTemplate = async ({ name, scope = "selected" } = {}) => {
    setVisualOverlayTemplateSaveState({
      status: "loading",
      message: t("overlayTemplateSaving", "Saving…"),
    });
    try {
      const template = createTemplateFromOverlays({
        overlays: visualOverlaySegments,
        selectedIds: scope === "selected" && selectedVisualOverlayId ? [selectedVisualOverlayId] : null,
        name,
        metadata: {
          source: "editor",
          saveScope: scope,
        },
      });
      const savedTemplate = await createOverlayTemplateRequest(template);
      const message = t("overlayTemplateSaved", "Template saved to your global library.");
      setVisualOverlayTemplateSaveState({ status: "success", message });
      notify(message);
      return savedTemplate;
    } catch (error) {
      const message = error?.message || t("overlayTemplateSaveFailed", "Template could not be saved.");
      setVisualOverlayTemplateSaveState({ status: "error", message });
      notify(message);
      return null;
    }
  };
  const updateVisualOverlayById = (overlayId, transform) => {
    if (!overlayId || trackLocks.overlay) return;
    setVisualOverlaySegments((items) => items.map((item) => {
      if (item.id !== overlayId) return item;
      const localTime = Math.max(0, currentTime - item.start);
      return item.keyframes?.length
        ? updateVisualOverlayTransform(item, localTime, transform)
        : { ...item, baseTransform: normalizeVisualTransform({ ...item.baseTransform, ...transform }) };
    }));
  };
  const updateSelectedVisualOverlay = (transform) => updateVisualOverlayById(selectedVisualOverlayId, transform);
  const updateSelectedVisualOverlayEffects = (change) => {
    const overlay = visualOverlaySegments.find((item) => item.id === selectedVisualOverlayId);
    if (!overlay || trackLocks.overlay) return;
    setVisualOverlaySegments((items) => items.map((item) => {
      if (item.id !== overlay.id) return item;
      if (Number.isFinite(change.playbackRate) && item.type === "video") return updateVisualSegmentPlaybackRate(item, change.playbackRate);
      if (change.baseTransform) return { ...item, baseTransform: normalizeVisualTransform({ ...item.baseTransform, ...change.baseTransform }) };
      if (change.keyframe) return { ...item, keyframes: upsertVisualKeyframe(item.keyframes, change.keyframe.time, change.keyframe) };
      if (change.propertyKeyframe) return { ...item, keyframes: upsertVisualPropertyKeyframe(item.keyframes, change.propertyKeyframe.time, change.propertyKeyframe.key, change.propertyKeyframe.value) };
      if (change.removePropertyKeyframe) return { ...item, keyframes: removeVisualPropertyKeyframe(item.keyframes, change.removePropertyKeyframe.time, change.removePropertyKeyframe.key) };
      if (Number.isFinite(change.removeKeyframeAt)) return { ...item, keyframes: (item.keyframes ?? []).filter((frame) => Math.abs(frame.time - change.removeKeyframeAt) > 0.04) };
      if (change.mask) return { ...item, mask: change.mask };
      if (change.animation) return { ...item, animation: change.animation };
      if (change.subjectEffect) return { ...item, subjectEffect: normalizeSubjectEffect(change.subjectEffect) };
      if (change.clickRipple) return { ...item, clickRipple: normalizeClickRippleEffect(change.clickRipple) };
      if (change.cinematicDepth) return { ...item, cinematicDepth: normalizeCinematicDepth(change.cinematicDepth) };
      if (change.photoParallax) return { ...item, photoParallax: normalizePhotoParallax(change.photoParallax) };
      if (change.cropX !== undefined) {
        const nextCropX = Math.max(0, Math.min(1, Number(change.cropX)));
        return {
          ...item,
          cropX: nextCropX,
          fitMode: item.fitMode || "cover",
          cropOffset: { x: nextCropX, y: item.cropOffset?.y ?? 0 },
          objectPosition: `${(nextCropX * 100).toFixed(1)}% 50%`,
        };
      }
      if (change.timing) return { ...item, ...change.timing };
      if (typeof change.filterId === "string") return { ...item, filterId: change.filterId };
      return item;
    }));
  };

  const updateSelectedCinematicDepth = (nextEffect) => {
    const cinematicDepth = normalizeCinematicDepth(nextEffect);
    if (selectedTrack === "overlay" && selectedVisualOverlay) {
      updateSelectedVisualOverlayEffects({ cinematicDepth });
      return;
    }
    updateSelectedVisualEffects({ cinematicDepth });
  };
  const updateSelectedPhotoParallax = (nextEffect) => {
    const photoParallax = normalizePhotoParallax(nextEffect);
    if (selectedTrack === "overlay" && selectedVisualOverlay) {
      updateSelectedVisualOverlayEffects({ photoParallax });
      return;
    }
    updateSelectedVisualEffects({ photoParallax });
  };
  const depthTimelineStart = selectedTrack === "overlay" && selectedVisualOverlay
    ? selectedVisualOverlay.start || 0
    : selectedVisualRange?.start || 0;
  const cinematicDepth = useDepthOfFieldAnalysis({
    segment: selectedEffectSegment,
    depthRecords,
    setDepthRecords,
    updateEffect: updateSelectedCinematicDepth,
    onAssetReady: handleDepthMapAssetReady,
    notify,
    setCurrentTime,
    timelineStart: depthTimelineStart,
    t,
  });
  const photoParallaxDepth = useDepthOfFieldAnalysis({
    segment: selectedEffectSegment,
    depthRecords,
    setDepthRecords,
    updateEffect: updateSelectedPhotoParallax,
    effectField: "photoParallax",
    readyToastKey: "parallaxReadyToast",
    notify,
    setCurrentTime,
    timelineStart: depthTimelineStart,
    t,
  });
  const previewDepthRecord = previewVisionKey ? depthRecords[previewVisionKey] || null : null;
  const previewDepthAnalysis = resolveDepthAnalysisAtTime(previewDepthRecord, previewVisualSourceTime);
  const previewVisualOverlaysWithDepth = useMemo(() => previewVisualOverlays.map((overlay) => {
    const depthRecord = depthRecords[getVisionKey(overlay)];
    if (!depthRecord) return overlay;
    const localTime = Math.max(0, currentTime - (overlay.start || 0));
    const sourceTime = overlay.type === "video" ? getVisualSourceTime(overlay, localTime) : localTime;
    return { ...overlay, depthAnalysis: resolveDepthAnalysisAtTime(depthRecord, sourceTime) };
  }), [currentTime, depthRecords, previewVisualOverlays]);

  const { projectImportProgress, getProjectSnapshot, commitProjectCommandState, createCurrentArchive, handleExportProject, handleImportProject, handleNewProject, currentCloudProject, savingToCloud, saveProjectToCloud, handleOpenCloudProject } = useProjectFiles({
    autoRatioSourceKeyRef,
    initialProject: activeProject,
    initialImportFile,
    previewCanvasRef,
    language: activeLanguage, pauseTimelineMedia, setIsPlaying,
    timelineMarkers, setTimelineMarkers,
    audioBlob, audioDuration, audioSegments, captionPlacement, captionPosition, captionSegments, captionSize,
    captionStyle, captionsEnabled, captionStyleFallback: captionStyle, clearAllVisionState,
    clearAudioTrack, clearImageTrack, clearMusicTrack, clearSourceAudioTrack, fitMode,
    imageUrlRefs, musicBlob, musicDuration, musicName, musicSegments, musicStart, musicVolume, notify, projectFileInputRef,
    ratioId, replaceAudio, replaceMusic, replaceSourceAudio, script, selectedFilterId,
    selectedStickerId, selectedTransitionId, selectedVoiceId, setCaptionPlacement,
    setCaptionPosition, setCaptionSegments, setCaptionSize, setCaptionStyle, setCaptionsEnabled,
    setAudioSegments, setCurrentTime, setFitMode, setImageClipCount, setImageDuration, setMusicSegments, setMusicStart, setMusicVolume, setSelectedAudioSegmentId,
    setRatioId, setScript, setSelectedFilterId, setSelectedSegmentId, setSelectedStickerId,
    setSelectedStickerSegmentId, setSelectedTransitionId, setSelectedVoiceId, setShowFileMenu,
    setSourceAudioAssetId, setSourceAudioLinked, setSourceAudioVolume, setSourceAudioSpatialEffect, setSourceAudioSpatialAmount, setSpeed, setStickerSegments, setTimelineZoom, setTrackLocks, setTrackVisibility,
    setTimelineHorizon,
    setVisualSegments, setVisualOverlaySegments, setSelectedVisualOverlayId, setVolume, setCurrentVisualAsset, sourceAudioBlob, sourceAudioDuration,
    markTimelineViewRestored: (hasContent) => { timelineImportRestoreRef.current = hasContent; },
    sourceAudioAssetId, sourceAudioLinked, sourceAudioName, sourceAudioStart, sourceAudioVolume, sourceAudioSpatialEffect, sourceAudioSpatialAmount, speed, stickerSegments,
    timelineZoom, trackLocks, trackVisibility, visualSegments, visualOverlaySegments, volume,
  });

  const {
    activeTimelineClipDrag, audioClipPercent, displayedCaptionSegments,
    displayedCaptionTimeline, displayedVisualSegments, exportPercent, musicClipPercent, musicStartPercent,
    playheadPercent, previewFrameStyle, previewRatio, progressPercent,
    renderedVisualSegments, renderedVisualTimeline, showStickerTrack,
    sourceAudioClipPercent, sourceAudioStartPercent,
  } = useTimelineViewModel({
    assetDragPreview, assetDropTargetTrack, audioBlob, audioDuration, captionSegments,
    captionTargetDuration, captionTimeline, currentTime, draggedAssetId, exportProgress,
    findAssetById, getCurrentVisualAssetSnapshot, imageDuration, imageSrc, musicBlob,
    musicDuration, musicStart, previewFrameSize, progress, ratio, selectedTrack, sourceAudioBlob,
    linkedSourceAudioSegments, sourceAudioDuration, sourceAudioLinked, sourceAudioStart, stickerSegments, timelineClipDrag,
    timelineDuration, visualSegments,
  });
  const exportContentDuration = useMemo(() => getExportContentDuration({
    visualDuration: imageDuration,
    voiceDuration: voiceTrackDuration,
    captionDuration,
    sourceAudioDuration: sourceAudioBlob ? sourceAudioTimelineEnd : 0,
    musicDuration: musicBlob ? musicTimelineEnd : 0,
    stickerDuration,
    overlaySegments: visualOverlaySegments,
  }), [
    captionDuration, imageDuration, musicBlob, musicTimelineEnd, sourceAudioBlob,
    sourceAudioTimelineEnd, stickerDuration, visualOverlaySegments, voiceTrackDuration,
  ]);
  const videoCompositionContext = {
    audioSegments, captionDuration, captionPlacement, captionPosition, captionSegments, captionTargetDuration,
    captionSize, captionStyle, captionsEnabled, exporting, exportAbortControllerRef, exportStartRef, fitMode,
    imageDuration, imageSrc, musicBlob, musicDuration, musicSegments, musicStart, musicTimelineEnd, musicVolume, notify,
    previewFrameSize, ratio, renderedVisualSegments, script, selectedFilter,
    selectedSticker, selectedTransitionId, setExporting, setExportError, setExportPhase,
    setExportProgress, setStatus, setStatusText, sourceAudioBlob, sourceAudioDuration,
    linkedSourceAudioSegments, sourceAudioAssetId, sourceAudioLinked, sourceAudioStart, sourceAudioTimelineEnd, sourceAudioVolume, sourceAudioSpatialEffect, sourceAudioSpatialAmount, stickerDuration, stickerSegments,
    trackVisibility, visionRecords, depthRecords, visualType, voiceTrackDuration, volume, exportSettings: {
      ...exportSettings,
      ...getExportDimensions(ratio, Number(exportSettings.resolution)),
      videoBitsPerSecond: getEffectiveExportBitrate(exportSettings),
    },
    visualOverlaySegments, t, language: activeLanguage,
  };
  const handleExportVideo = useVideoExport(videoCompositionContext);
  const [cloudRenderJob, setCloudRenderJob] = useState(null);
  const [showCloudRenderModal, setShowCloudRenderModal] = useState(false);

  const handleCloudRender = useCallback(async (renderOptions = {}) => {
    try {
      let projectToRender = currentCloudProject;
      // Ensure the project is saved and has an uploaded .timeline archive before requesting headless rendering
      if (!projectToRender || !projectToRender.archive_storage_path || Number(projectToRender.current_revision) === 0) {
        notify("正在将工程保存至云端…");
        projectToRender = await saveProjectToCloud();
      }

      if (!projectToRender?.id || !projectToRender?.archive_storage_path) {
        throw new Error("工程尚未保存至云端或未生成归档文件，请先点击「保存到云端」");
      }

      notify("正在创建云端渲染任务…");
      const res = await fetch("/api/renders?execute=true", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          projectId: projectToRender.id,
          requestedRevision: projectToRender.current_revision,
          settings: renderOptions.settings || {},
          autoStart: true,
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.message || `Render creation failed: ${res.statusText}`);
      }

      const { job } = await res.json();
      if (job.status === "failed") {
        throw new Error(job.error_message || "云端渲染启动失败");
      }
      setCloudRenderJob(job);
      setShowCloudRenderModal(true);
      notify("已提交云端渲染任务，正在执行 CLI FFmpeg 渲染…");
    } catch (err) {
      notify(`云端渲染发起失败: ${err.message}`);
    }
  }, [currentCloudProject, notify, saveProjectToCloud]);
  const { startCaptionResize, startTimelineClipDrag } = createTimelineReorderControls({
    timelineMarkers,
    audioSegments, captionSegments, captionTargetDuration, commitCaptionSegments, commitVisualSegments,
    notify, renderedVisualSegments, seekTo, setSelectedSegmentId, setSelectedTrack,
    setSelectedVisualSegmentId, setTimelineClipDrag, suppressTimelineClipClickRef,
    timelineClipDragRef, timelineDuration, trackLocks, visualSegments, pauseForTimelineEdit,
    setTimelineHorizon,
    stickerSegments, sourceAudioDuration, sourceAudioStart, musicDuration, musicStart, musicSegments, currentTime, setSnapGuide,
    visualOverlaySegments, setVisualOverlaySegments, setSelectedVisualOverlayId, trackScrollRef,
  });

  // Browser agents use the live editor action and normal undo history.
  const getBrowserRuntimeProject = () => ({
    ...getProjectSnapshot(), visualSegments, visualOverlaySegments, audioSegments, musicSegments,
    musicBlob, musicUrl, musicPeaks, sourceAudioBlob, sourceAudioUrl, audioBlob,
  });
  const applyBrowserReview = (review, message) => {
    if (!review.hasChanges) throw Object.assign(new Error(), { code: "NO_CHANGES" });
    const snapshot = getProjectSnapshot();
    const runtime = getBrowserRuntimeProject();
    const expectedRipple = review.rippleEditing !== undefined ? review.rippleEditing : rippleEditing;
    if (review.fingerprint !== browserProjectFingerprint(snapshot, expectedRipple, visualSegments, runtime)) {
      throw Object.assign(new Error(), { code: "BROWSER_EDIT_STALE_PLAN" });
    }
    const firstChanged = review.rows?.find((row) => row.changed);
    const next = restoreBrowserProjectMedia(review.project, runtime, review.mediaOrigins, userAssets);
    const nextVisuals = next.visualSegments;
    const visualsChanged = JSON.stringify(snapshot.visualSegments) !== JSON.stringify(review.project.visualSegments);
    checkpointHistory();
    // Reordering existing media keeps the reviewed canvas ratio. Auto-detection
    // remains available when the user uploads a new first source later.
    const ratioSource = nextVisuals.find((clip) => clip.width > 0 && clip.height > 0);
    if (ratioSource) autoRatioSourceKeyRef.current = `${ratioSource.assetId || ratioSource.id}:${ratioSource.width}x${ratioSource.height}`;
    pauseTimelineMedia();
    setIsPlaying(false);
    setScript(next.script);
    setAudioSegments(next.audioSegments);
    setCaptionSegments(next.captionSegments);
    setTimelineMarkers(next.timelineMarkers);
    setCaptionsEnabled(next.captionsEnabled);
    setCaptionStyle(next.captionStyle);
    setCaptionSize(next.captionSize);
    setCaptionStylePresetId(next.captionStylePresetId);
    setCaptionPlacement(next.captionPlacement);
    setCaptionPosition(next.captionPosition);
    setRatioId(next.ratioId);
    setFitMode(next.fitMode);
    setVisualOverlaySegments(next.visualOverlaySegments);
    setStickerSegments(next.stickerSegments);
    setMusicSegments(next.musicSegments);
    setMusicStart(next.musicStart);
    setMusicVolume(next.musicVolume);
    setMusicName(next.musicName || "");
    setMusicDuration(next.musicDuration || 0);
    if (next.musicBlob !== musicBlob) {
      const nextMusicUrl = next.musicUrl || (next.musicBlob ? URL.createObjectURL(next.musicBlob) : "");
      musicUrlRef.current = nextMusicUrl;
      setMusicBlob(next.musicBlob);
      setMusicUrl(nextMusicUrl);
      setMusicPeaks(next.musicPeaks || []);
    }
    setSourceAudioStart(next.sourceAudioStart);
    setTrackVisibility(next.trackVisibility);
    if (visualsChanged) {
      if (nextVisuals.length) commitVisualSegments(nextVisuals, message, firstChanged?.index ?? 0);
      else clearImageTrack(message);
    } else notify(message);
    const focusTime = Number.isFinite(review.focusTime) ? review.focusTime : firstChanged?.start ?? currentTime;
    const nextTime = Math.min(Math.max(0, focusTime), Math.max(0, review.duration));
    currentTimeRef.current = nextTime;
    setCurrentTime(nextTime);
  };
  const [isAssistantExpanded, setIsAssistantExpanded] = useState(false);
  const assistantCommitsRef = useRef(new Set());
  const handleApplyEditorPlan = useCallback((nextProject, plan, mediaOrigins, assistantApproval = false) => {
    const snapshot = getProjectSnapshot();
    if (assistantApproval) {
      if (!plan?.approvalId) throw new Error("Assistant approval identity is missing.");
      if (assistantCommitsRef.current.has(plan.approvalId)) return;
      assertAssistantBase(snapshot, plan);
      assertDestructiveAssistantTargets(plan.actions, snapshot);
      assertAssistantChangedTracksUnlocked(snapshot, nextProject);
      const expectedIds = plan.actions.map(action => action.id);
      if (!expectedIds.every(id => nextProject.commandState?.appliedOperationIds?.includes(id))) {
        throw new Error("Assistant operation ledger is incomplete. No edits were applied.");
      }
    }
    const runtime = getBrowserRuntimeProject();
    const origins = mediaOrigins || plan?.mediaOrigins || {};
    const next = restoreBrowserProjectMedia(nextProject, runtime, origins, userAssets);
    const nextVisuals = next.visualSegments;
    const visualsChanged = JSON.stringify(snapshot.visualSegments) !== JSON.stringify(nextProject.visualSegments);

    // Reserve assistant identity before setters; manual Smart Zoom retains its
    // existing editor path without requiring assistant proposal metadata.
    if (assistantApproval) {
      commitProjectCommandState(nextProject.commandState, plan);
      assistantCommitsRef.current.add(plan.approvalId);
    }
    checkpointHistory();
    const ratioSource = nextVisuals.find((clip) => clip.width > 0 && clip.height > 0);
    if (ratioSource) autoRatioSourceKeyRef.current = `${ratioSource.assetId || ratioSource.id}:${ratioSource.width}x${ratioSource.height}`;
    pauseTimelineMedia();
    setIsPlaying(false);

    if (next.script !== undefined) setScript(next.script);
    if (next.audioSegments !== undefined) {
      setAudioSegments(next.audioSegments);
      if (!next.audioSegments.length) {
        setSelectedAudioSegmentId("");
      }
    }
    if (next.captionSegments !== undefined) setCaptionSegments(next.captionSegments);
    if (next.timelineMarkers !== undefined) setTimelineMarkers(next.timelineMarkers);
    if (next.captionsEnabled !== undefined) setCaptionsEnabled(next.captionsEnabled);
    if (next.captionStyle !== undefined) setCaptionStyle(next.captionStyle);
    if (next.captionSize !== undefined) setCaptionSize(next.captionSize);
    if (next.captionStylePresetId !== undefined) setCaptionStylePresetId(next.captionStylePresetId);
    if (next.captionPlacement !== undefined) setCaptionPlacement(next.captionPlacement);
    if (next.captionPosition !== undefined) setCaptionPosition(next.captionPosition);
    if (next.ratioId !== undefined) setRatioId(next.ratioId);
    if (next.fitMode !== undefined) setFitMode(next.fitMode);
    if (next.visualOverlaySegments !== undefined) setVisualOverlaySegments(next.visualOverlaySegments);
    if (next.stickerSegments !== undefined) setStickerSegments(next.stickerSegments);
    if (next.musicSegments !== undefined) {
      setMusicSegments(next.musicSegments);
      if (!next.musicSegments.length) {
        setMusicBlob(null);
        setMusicUrl("");
        setMusicPeaks([]);
        setMusicDuration(0);
        setMusicName("");
        setMusicStart(0);
        setMusicVolume(0);
        setSelectedMusicSegmentId("");
      } else {
        const firstMusic = next.musicSegments[0];
        if (firstMusic) {
          if (firstMusic.blob) setMusicBlob(firstMusic.blob);
          if (firstMusic.url) setMusicUrl(firstMusic.url);
          if (firstMusic.name) setMusicName(firstMusic.name);
          if (typeof firstMusic.volume === "number") setMusicVolume(firstMusic.volume);
          if (typeof firstMusic.duration === "number") setMusicDuration(firstMusic.duration);
        }
      }
    }
    if (next.trackVisibility !== undefined) setTrackVisibility(next.trackVisibility);
    if (next.trackLocks !== undefined) setTrackLocks(next.trackLocks);

    const message = plan?.explanation || "Applied AI editing plan";
    if (visualsChanged) {
      if (nextVisuals.length) commitVisualSegments(nextVisuals, message, 0);
      else clearImageTrack(message);
    } else {
      notify(message);
    }
  }, [
    getProjectSnapshot,
    commitProjectCommandState,
    setTrackLocks,
    getBrowserRuntimeProject,
    userAssets,
    checkpointHistory,
    pauseTimelineMedia,
    setIsPlaying,
    setScript,
    setAudioSegments,
    setSelectedAudioSegmentId,
    setCaptionSegments,
    setTimelineMarkers,
    setCaptionsEnabled,
    setCaptionStyle,
    setCaptionSize,
    setCaptionStylePresetId,
    setCaptionPlacement,
    setCaptionPosition,
    setRatioId,
    setFitMode,
    setVisualOverlaySegments,
    setStickerSegments,
    setMusicSegments,
    setMusicBlob,
    setMusicUrl,
    setMusicPeaks,
    setMusicDuration,
    setMusicName,
    setMusicStart,
    setMusicVolume,
    setSelectedMusicSegmentId,
    setTrackVisibility,
    commitVisualSegments,
    clearImageTrack,
    notify,
  ]);
  const handleApplyAssistantPlan = useCallback((nextProject, plan, mediaOrigins) => {
    handleApplyEditorPlan(nextProject, plan, mediaOrigins, true);
  }, [handleApplyEditorPlan]);
  const initialGeneratedProjectLoadedRef = useRef(false);
  const isApplyingGeneratedProjectRef = useRef(false);

  const handleApplyGeneratedProject = useCallback((genProject) => {
    if (!genProject || !Array.isArray(genProject.visualSegments)) return;
    if (isApplyingGeneratedProjectRef.current) return;
    isApplyingGeneratedProjectRef.current = true;

    try {
      checkpointHistory();
      pauseTimelineMedia();
      setIsPlaying(false);

      if (genProject.visualSegments) {
        for (const seg of genProject.visualSegments) {
          if (seg.blob instanceof Blob && (!seg.src || typeof seg.src !== "string")) {
            seg.src = URL.createObjectURL(seg.blob);
          }
          if (seg.src?.startsWith("blob:")) {
            imageUrlRefs.current.add(seg.src);
          }
        }
      }

      if (genProject.musicSegments) {
        for (const seg of genProject.musicSegments) {
          if (seg.blob instanceof Blob && (!seg.url || typeof seg.url !== "string")) {
            seg.url = URL.createObjectURL(seg.blob);
          }
          if (seg.url?.startsWith("blob:")) {
            imageUrlRefs.current.add(seg.url);
          }
        }
      }

      if (genProject.audioSegments) {
        for (const seg of genProject.audioSegments) {
          if (seg.blob instanceof Blob && (!seg.url || typeof seg.url !== "string")) {
            seg.url = URL.createObjectURL(seg.blob);
          }
          if (seg.url?.startsWith("blob:")) {
            imageUrlRefs.current.add(seg.url);
          }
        }
      }

      const targetRatio = genProject.ratioId || "16:9";
      autoRatioSourceKeyRef.current = `locked:${targetRatio}`;
      setRatioId(targetRatio);
      if (genProject.fitMode) setFitMode(genProject.fitMode);
      if (genProject.script !== undefined) setScript(genProject.script);
      if (genProject.captionSegments !== undefined) setCaptionSegments(genProject.captionSegments);
      if (genProject.captionsEnabled !== undefined) setCaptionsEnabled(genProject.captionsEnabled);
      if (genProject.captionPosition !== undefined) setCaptionPosition(genProject.captionPosition);
      if (genProject.captionStylePresetId !== undefined) setCaptionStylePresetId(genProject.captionStylePresetId);
      if (genProject.timelineMarkers !== undefined) setTimelineMarkers(genProject.timelineMarkers);
      if (genProject.audioSegments !== undefined) setAudioSegments(genProject.audioSegments);
      if (genProject.selectedVoiceId) setSelectedVoiceId(genProject.selectedVoiceId);
      if (genProject.musicSegments !== undefined) {
        setMusicSegments(genProject.musicSegments);
        if (genProject.musicSegments[0]?.blob) {
          setMusicBlob(genProject.musicSegments[0].blob);
          if (genProject.musicSegments[0].url) {
            setMusicUrl(genProject.musicSegments[0].url);
          }
          if (typeof genProject.musicSegments[0].volume === "number") {
            setMusicVolume(genProject.musicSegments[0].volume);
          }
        }
      }
      setTrackVisibility((prev) => {
        const incoming = genProject.trackVisibility || {};
        return normalizeTrackVisibility({
          ...prev,
          ...incoming,
          image: true,
        });
      });
      setTrackLocks((prev) => {
        const incoming = genProject.trackLocks || {};
        return normalizeTrackLocks({
          ...prev,
          ...incoming,
          image: false,
        });
      });

      const message = `Generated video: "${genProject.title || "AI Video"}"`;
      if (genProject.visualSegments.length) {
        commitVisualSegments(genProject.visualSegments, message, 0);
      } else {
        clearImageTrack(message);
      }

      setCurrentTime(0);
      seekTo(0);
      notify(message);
    } finally {
      isApplyingGeneratedProjectRef.current = false;
    }
  }, [
    checkpointHistory,
    pauseTimelineMedia,
    setIsPlaying,
    imageUrlRefs,
    autoRatioSourceKeyRef,
    setRatioId,
    setFitMode,
    setScript,
    setCaptionSegments,
    setCaptionsEnabled,
    setCaptionPosition,
    setCaptionStylePresetId,
    setTimelineMarkers,
    setAudioSegments,
    setSelectedVoiceId,
    setMusicSegments,
    setTrackVisibility,
    setTrackLocks,
    commitVisualSegments,
    clearImageTrack,
    setCurrentTime,
    seekTo,
    notify,
  ]);

  useEffect(() => {
    if (initialGeneratedProject && !initialGeneratedProjectLoadedRef.current) {
      initialGeneratedProjectLoadedRef.current = true;
      handleApplyGeneratedProject(initialGeneratedProject);
    }
  }, [initialGeneratedProject, handleApplyGeneratedProject]);
  const silenceRemoval = useSilenceRemoval({
    language: activeLanguage, selectedSegment: selectedVisualSegment, visualSegments, projectVersion: historySignature,
    locked: Boolean(trackLocks.image || sourceAudioBlob && sourceAudioLinked !== false && trackLocks.source),
    getSnapshot: getProjectSnapshot, getRuntime: getBrowserRuntimeProject,
    applyReview: applyBrowserReview, rippleEditing, setRippleEditing, seekTo, t,
  });
  const roughCut = useRoughCut({
    language: activeLanguage, selectedSegment: selectedVisualSegment, visualSegments, projectVersion: historySignature,
    locked: Boolean(trackLocks.image || sourceAudioBlob && sourceAudioLinked !== false && trackLocks.source),
    getSnapshot: getProjectSnapshot, getRuntime: getBrowserRuntimeProject,
    applyReview: applyBrowserReview, rippleEditing, setRippleEditing, seekTo, t,
    captionSegments,
  });
  const openAssistantSmartReview = async (tool, mode, request = {}) => {
    const clipId = request.clipId || selectedVisualSegment?.id || visualSegments[0]?.id || "";
    if (clipId) setSelectedVisualSegmentId(clipId);
    setSelectedTrack("image");
    setActiveTool("smart");
    setSmartMode(mode);
    if (isCompactViewport) {
      setMobilePanelOrigin("");
      setMobileInspectorSection("");
      changeMobilePanel("inspector");
    }
    return tool.run({ ...request, clipId });
  };
  const smartPipeline = useSmartPipeline({
    language: activeLanguage,
    selectedSegment: selectedVisualSegment,
    visualSegments,
    projectVersion: historySignature,
    locked: Boolean(trackLocks.image || (sourceAudioBlob && sourceAudioLinked !== false && trackLocks.source)),
    getSnapshot: getProjectSnapshot,
    getRuntime: getBrowserRuntimeProject,
    applyReview: applyBrowserReview,
    rippleEditing,
    setRippleEditing,
    seekTo,
    handlePlayToggle,
    pauseTimelineMedia,
    isPlaying,
    setIsPlaying,
    t,
    notify,
  });
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const handleTestOpenPipeline = (e) => {
      smartPipeline.open(e?.detail?.clipId, e?.detail?.plan || e?.detail?.prefill);
    };
    window.addEventListener("test:open-smart-pipeline", handleTestOpenPipeline);
    return () => {
      window.removeEventListener("test:open-smart-pipeline", handleTestOpenPipeline);
    };
  }, [smartPipeline]);
  const handleApplySceneCuts = ({ clipId, boundaries, draft } = {}) => {
    if (trackLocks.image) {
      notify(t("sceneDetectClipLocked", "Visual track is locked. Unlock it to cut clips."));
      return { success: false, reason: "LOCKED" };
    }
    const currentVisuals = visualSegments.length ? visualSegments : [];
    const targetId = clipId || selectedVisualSegment?.id;
    const targetIndex = currentVisuals.findIndex((s) => s.id === targetId);
    if (targetIndex < 0) {
      notify(t("sceneDetectClipNotFound", "Target video clip not found on the timeline."));
      return { success: false, reason: "CLIP_NOT_FOUND" };
    }
    const targetClip = currentVisuals[targetIndex];
    if (draft && draft.version && draft.version !== historySignature) {
      notify(t("sceneDetectStale", "The project or clip changed. Analyze again."));
      return { success: false, reason: "STALE" };
    }
    const validCuts = validateSceneCutBoundaries(boundaries, targetClip.duration);
    if (!validCuts.length) {
      notify(t("sceneDetectNoBoundaries", "No valid scene boundaries selected"));
      return { success: false, reason: "NO_BOUNDARIES" };
    }

    const splitSegments = splitVisualSegmentAtBoundaries(targetClip, validCuts);
    if (splitSegments.length <= 1) {
      notify(t("sceneDetectNoBoundaries", "No valid scene boundaries selected"));
      return { success: false, reason: "NO_SPLIT" };
    }

    checkpointHistory();
    const nextVisuals = [...currentVisuals];
    nextVisuals.splice(targetIndex, 1, ...splitSegments);

    const message = t(
      "sceneDetectApplied",
      "Applied {count} scene cuts to timeline"
    ).replace("{count}", validCuts.length);

    commitVisualSegments(nextVisuals, message, targetIndex);
    return { success: true, count: validCuts.length, splitSegments };
  };

  const sceneDetection = useSceneDetection({
    selectedSegment: selectedVisualSegment,
    visualSegments,
    projectVersion: historySignature,
    locked: Boolean(trackLocks.image),
    seekTo,
    handlePlayToggle,
    pauseTimelineMedia,
    setIsPlaying,
    isPlaying,
    currentTime,
    notify,
    t,
    onApplyCuts: handleApplySceneCuts,
  });

  const handleApplyShortsProject = useCallback((project) => {
    if (!project) return;
    checkpointHistory();
    pauseTimelineMedia();
    setIsPlaying(false);
    const targetRatio = project.ratioId || project.aspectRatio || "9:16";
    autoRatioSourceKeyRef.current = `locked:${targetRatio}`;
    setRatioId(targetRatio);
    setFitMode(project.fitMode || "cover");
    if (project.visualSegments) setVisualSegments(project.visualSegments);
    if (project.visualOverlaySegments) setVisualOverlaySegments(project.visualOverlaySegments);
    if (project.captionSegments) setCaptionSegments(project.captionSegments);
    if (project.audioSegments) setAudioSegments(project.audioSegments);
    if (project.musicSegments) setMusicSegments(project.musicSegments);
    if (project.captionStylePresetId) setCaptionStylePresetId(project.captionStylePresetId);
    if (project.captionStyle) setCaptionStyle(project.captionStyle);
    if (project.captionSize) setCaptionSize(project.captionSize);
    if (project.captionsEnabled !== undefined) setCaptionsEnabled(project.captionsEnabled);
    if (project.visualSegments?.[0]?.id) {
      setSelectedVisualSegmentId(project.visualSegments[0].id);
      setSelectedTrack("image");
    }
    setCurrentTime(0);
    notify(t("shortsAppliedToTimeline", "Loaded candidate short into timeline"));
  }, [checkpointHistory, pauseTimelineMedia, setIsPlaying, setVisualSegments, setVisualOverlaySegments, setCaptionSegments, setAudioSegments, setMusicSegments, setRatioId, setFitMode, setCaptionStylePresetId, setCaptionStyle, setCaptionSize, setCaptionsEnabled, setSelectedVisualSegmentId, setSelectedTrack, setCurrentTime, notify, t]);

  const shortsStudio = useShortsStudio({
    visualSegments,
    userAssets,
    selectedSegment: selectedVisualSegment,
    captionSegments,
    currentTime,
    setCurrentTime,
    setIsPlaying,
    pauseTimelineMedia,
    onApplyProject: handleApplyShortsProject,
    onExportShort: async (spec, { candidate, sourceMedia, options, index, signal, onProgress } = {}) => {
      notify(t("shortsStartingExport", "Starting short video export…"));
      return exportShortCandidateVideo(sourceMedia, candidate, options, {
        signal,
        index,
        onProgress,
      });
    },
    notify,
    t,
  });
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let cleanup = null;
    import("./lib/devTestBridge.js")
      .then(({ registerDevTestBridge }) => {
        cleanup = registerDevTestBridge({
          getProjectSnapshot,
          sceneDetection,
          handleApplySceneCuts,
          setIsAssistantExpanded,
          handleApplyAssistantPlan,
          handleApplyGeneratedProject,
        });
      })
      .catch(() => { });
    return () => {
      cleanup?.();
    };
  }, [sceneDetection, handleApplySceneCuts, handleApplyAssistantPlan, handleApplyGeneratedProject, getProjectSnapshot]);
  const webMcp = useWebMcpEditor({
    language: activeLanguage, visualSegments, visualOverlaySegments, audioSegments, musicSegments,
    sourceAudioBlob, musicBlob, audioBlob, rippleEditing, getProjectSnapshot,
    assets: userAssets, getRuntimeProject: getBrowserRuntimeProject,
    currentTime, duration: exportContentDuration, historySignature,
    createArchive: createCurrentArchive, download: downloadBlob, notify,
    exportVideo: handleExportVideo, exportSettings, exportContentDuration, ratio, exporting,
    applyReview: applyBrowserReview,
    sampleMedia: (input, options) => sampleEditorMedia(videoCompositionContext, input, options),
    commitAiVoiceAssets: ({ items }, { signal } = {}) => {
      if (signal?.aborted) throw Object.assign(new Error("CANCELLED"), { name: "AbortError" });
      const assets = items.map((item) => {
        const id = crypto.randomUUID(); const src = URL.createObjectURL(item.blob);
        imageUrlRefs.current.add(src);
        return {
          id, type: "audio", kind: "voiceover", name: item.name, text: item.text,
          voiceId: item.voiceId, blob: item.blob, src, previewSrc: src, generated: true,
          duration: item.decoded.duration, peaks: item.decoded.peaks
        };
      });
      setUserAssets((current) => [...assets, ...current]);
      setActiveTool("media"); setMediaTab("mine");
      if (assets[0]) setSelectedLibraryAssetId(assets[0].id);
      return assets.map(({ id, duration }) => ({ id, duration }));
    },
    undo: () => { pauseTimelineMedia(); undo(); },
    seek: (time) => { pauseTimelineMedia(); setIsPlaying(false); seekTo(time, { immediate: true }); },
    isBusy: () => Boolean(projectImportProgress || exporting || timelineClipDragRef.current || pointerAssetDragRef.current ||
      isDragging || draggedAssetId || ["generating", "captioning"].includes(status) || visualSegments.some((clip) => clip.preparing) ||
      visualOverlaySegments.some((clip) => clip.preparing) || visionJob.running),
  });

  const guardAgentAi = (action) => (...args) => {
    if (webMcp.isAiRunning()) {
      notify(webMcp.t("busy"));
      const options = args[0];
      if (options && typeof options === "object" && options.throwOnError) {
        const err = new Error(webMcp.t("busy") || "AI is busy. Please wait for current task to finish.");
        err.code = "AI_BUSY";
        throw err;
      }
      return;
    }
    return action(...args);
  };
  // Cloud ownership is separate from the unchanged local generation hook. Refs are
  // refreshed during render so the post-decode guard never uses a stale closure.
  const ollalinkOwnerRef = useRef(null);
  const ollalinkCurrentRef = useRef(null);
  ollalinkCurrentRef.current = { script, captionSegments, selectedCaptionSegment, trackLocks, status, webMcp, commitAudioBatch };
  // The panel aborts its request on unmount. App teardown only invalidates the
  // owner: late end callbacks must not call App state setters after unmount.
  useEffect(() => () => { ollalinkOwnerRef.current = null; }, []);
  const beginOllalinkSpeech = guardAgentAi(({ input, captionSegment, signal, shouldCommit }) => {
    const snapshot = ollalinkCurrentRef.current;
    if (signal.aborted || ollalinkOwnerRef.current || ["generating", "captioning"].includes(snapshot.status)
      || snapshot.trackLocks.audio || snapshot.trackLocks.caption
      || (captionSegment ? snapshot.selectedCaptionSegment !== captionSegment || captionSegment.text !== input : snapshot.script !== input)) return null;
    const token = {};
    const end = (committed = false) => {
      signal.removeEventListener("abort", abort);
      if (ollalinkOwnerRef.current !== token) return;
      ollalinkOwnerRef.current = null;
      // Do not reset another operation's status if it has taken over.
      if (ollalinkCurrentRef.current.status === "generating") {
        ollalinkCurrentRef.current = { ...ollalinkCurrentRef.current, status: committed ? "done" : "ready" };
        setStatus(committed ? "done" : "ready");
        setStatusText(committed ? "Ollalink speech added to timeline" : "");
        setProgress(committed ? 100 : 0);
      }
    };
    const abort = () => end();
    ollalinkOwnerRef.current = token;
    signal.addEventListener("abort", abort, { once: true });
    ollalinkCurrentRef.current = { ...snapshot, status: "generating" };
    setStatus("generating");
    setStatusText("Generating Ollalink speech…");
    setProgress(0);
    const canCommit = () => {
      const now = ollalinkCurrentRef.current;
      return ollalinkOwnerRef.current === token && !signal.aborted && shouldCommit()
        && now.status === "generating" && !now.webMcp.isAiRunning()
        && !now.trackLocks.audio && !now.trackLocks.caption
        && now.script === snapshot.script && now.captionSegments === snapshot.captionSegments
        && now.selectedCaptionSegment === snapshot.selectedCaptionSegment;
    };
    let submitted = false;
    return {
      end,
      async commit(blob, result) {
        if (submitted || !canCommit()) return false;
        submitted = true;
        const name = `Ollalink · ${result.voice} (${result.language})`;
        const created = await ollalinkCurrentRef.current.commitAudioBatch([{ blob, script: input }], name, {
          captionSegment, gapSeconds: 0, signal, shouldCommit: canCommit,
          sourceKind: "ollalink-voiceover", voiceId: `ollalink:${result.voice}`, voiceName: name, name,
        });
        return created.length > 0;
      },
    };
  });
  const generateVoiceoverWhenIdle = guardAgentAi(generateVoiceover);
  const generateCaptionsWhenIdle = guardAgentAi(generateCaptionsFromSourceAudio);

  const handleSafeBackToDashboard = useCallback(async () => {
    const hasMedia = Boolean(
      visualSegments?.length ||
      visualOverlaySegments?.length ||
      audioSegments?.length ||
      musicSegments?.length ||
      sourceAudioBlob != null
    );
    if (hasMedia) {
      if (currentCloudProject) {
        const shouldSave = window.confirm(
          `Do you want to save latest changes to "${currentCloudProject.title}" before returning to Dashboard?\n\nClick OK to save and exit, or Cancel to continue without saving.`
        );
        if (shouldSave) {
          try {
            await saveProjectToCloud();
          } catch (e) {
            console.error("Auto-save before exit failed:", e);
          }
        }
      } else {
        const confirmExit = window.confirm(
          "You have media in your timeline that has not been saved to Cloud. Return to Dashboard anyway?"
        );
        if (!confirmExit) return;
      }
    }

    if (typeof onBackToDashboard === "function") {
      onBackToDashboard();
    } else {
      const url = new URL(window.location.href);
      url.searchParams.delete("view");
      url.searchParams.delete("project");
      window.history.pushState({}, "", url.pathname + (url.search ? url.search : ""));
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  }, [
    visualSegments,
    visualOverlaySegments,
    audioSegments,
    musicSegments,
    sourceAudioBlob,
    currentCloudProject,
    saveProjectToCloud,
    onBackToDashboard,
  ]);

  return (
    <main className={`app-shell ${!isAssistantExpanded ? "is-assistant-collapsed" : ""} ${isCompactViewport ? "is-compact-workspace" : ""} ${mobilePanel ? `mobile-panel-${mobilePanel}` : ""} ${isCompactViewport && mobileInspectorSection ? `mobile-section-${mobileInspectorSection}` : ""} ${isCompactViewport && mobileInspectorSection === "mask" && (selectedVisualOverlay || selectedVisualSegment)?.mask?.type && (selectedVisualOverlay || selectedVisualSegment).mask.type !== "none" ? "mobile-mask-active" : ""} ${mobilePanelClosing ? "is-mobile-panel-closing" : ""}`} lang={activeLanguage} onDragOver={(event) => {
      if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
    }} onDrop={async (event) => {
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (!files.length) return;
      event.preventDefault();
      const audioFile = files.find((file) => file.type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|ogg)$/i.test(file.name));
      const targetTrack = event.target.closest?.("[data-asset-drop-track]")?.dataset.assetDropTrack;
      if (audioFile && targetTrack === "music") {
        try {
          const decoded = await decodeWaveform(audioFile, 96);
          replaceMusic(audioFile, decoded.duration, decoded.peaks, audioFile.name, "音乐已安全加入时间线");
        } catch (error) {
          notify(error instanceof Error ? `无法读取该音频：${error.message}` : "无法读取该音频文件");
        }
        return;
      }
      handleFiles(files);
    }}>
      <input
        ref={fileInputRef}
        className="sr-only"
        type="file"
        accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime,video/x-matroska,.mkv,.mka,audio/mpeg,audio/wav,audio/mp4,audio/aac,audio/ogg,audio/flac,.ac3"
        multiple
        onChange={(event) => {
          handleFiles(event.target.files);
          event.target.value = "";
          event.target.blur();
        }}
      />
      <Topbar
        t={t}
        compactRail={compactRail}
        setCompactRail={setCompactRail}
        lastSaved={lastSaved}
        undo={undo}
        redo={redo}
        ratio={ratio}
        ratioId={ratioId}
        showRatioMenu={showRatioMenu}
        setShowRatioMenu={setShowRatioMenu}
        setRatioId={(nextRatioId) => {
          autoRatioSourceKeyRef.current = `locked:${nextRatioId}`;
          setRatioId(nextRatioId);
          setFitModeFromUser("contain");
        }}
        notify={notify}
        isPlaying={isPlaying}
        handlePlayToggle={handlePlayToggle}
        imageSrc={imageSrc}
        exporting={exporting}
        handleExportVideo={handleExportVideo}
        showExportMenu={showExportMenu}
        setShowExportMenu={setShowExportMenu}
        exportSettings={exportSettings}
        setExportSettings={setExportSettings}
        timelineDuration={exportContentDuration}
        showSettings={showSettings}
        setShowSettings={setShowSettings}
        activeLanguage={activeLanguage}
        setUiLanguage={setUiLanguage}
        captionsEnabled={captionsEnabled}
        setCaptionsEnabled={setCaptionsEnabled}
        trackVisibility={trackVisibility}
        toggleTrackVisibility={toggleTrackVisibility}
        showFileMenu={showFileMenu}
        setShowFileMenu={setShowFileMenu}
        handleNewProject={handleNewProject}
        handleExportProject={handleExportProject}
        handleImportProject={handleImportProject}
        projectFileInputRef={projectFileInputRef}
        currentUser={currentUser}
        onLogout={onLogout}
        currentCloudProject={currentCloudProject}
        savingToCloud={savingToCloud}
        saveProjectToCloud={saveProjectToCloud}
        handleOpenCloudProject={handleOpenCloudProject}
        handleCloudRender={handleCloudRender}
        onBackToDashboard={handleSafeBackToDashboard}
        onOpenAiAssistant={() => setIsAssistantExpanded((prev) => !prev)}
        isAssistantOpen={isAssistantExpanded}
        onOpenShortsStudio={() => shortsStudio.open()}
      />

      <ShortsNotificationRegion />
      <WebMcpReview agent={webMcp} language={activeLanguage} />
      <WebMcpAiStatus agent={webMcp} />
      <ProjectImportOverlay progress={projectImportProgress} language={activeLanguage} />
      <CloudRenderModal
        isOpen={showCloudRenderModal}
        onClose={() => setShowCloudRenderModal(false)}
        initialJob={cloudRenderJob}
        project={currentCloudProject}
        notify={notify}
      />
      <TranscriptReviewModal
        isOpen={Boolean(transcriptReview?.isOpen)}
        reviewData={transcriptReview}
        onApply={handleApplyTranscriptReview}
        onCancel={() => {
          setTranscriptReview(null);
          notify(t("reviewCaptionsCancelled", "Caption review cancelled. Timeline unchanged."));
        }}
        t={t}
      />
      <SmartPipelineModal
        isOpen={Boolean(smartPipeline.isOpen)}
        pipeline={smartPipeline}
        visualSegments={visualSegments}
        t={t}
      />
      <SceneDetectionModal
        isOpen={Boolean(sceneDetection.isOpen)}
        tool={sceneDetection}
        t={t}
      />
      <AiShortsStudioModal
        isOpen={Boolean(shortsStudio.isOpen)}
        studio={shortsStudio}
        t={t}
      />
      <AiAssistantPanel
        isExpanded={isAssistantExpanded}
        onToggleCollapse={() => setIsAssistantExpanded((prev) => !prev)}
        getProjectSnapshot={getProjectSnapshot}
        onApplyPlan={handleApplyAssistantPlan}
        userAssets={userAssets}
        projectId={currentCloudProject?.id || null}
        notify={notify}
        onUndo={undo}
        onRedo={redo}
        currentTime={currentTime}
        selectedVisualSegmentId={selectedVisualSegment?.id || ""}
        selectedVisualOverlayId={selectedVisualOverlayId}
        selectedAudioSegmentId={selectedAudioSegmentId}
        selectedSegmentId={selectedSegmentId}
        selectedTrack={selectedTrack}
        onOpenSceneDetection={(clipId) => sceneDetection.open(clipId)}
        onOpenSilenceRemoval={(request) => openAssistantSmartReview(silenceRemoval, "remove-pauses", request)}
        onOpenRoughCut={(request) => openAssistantSmartReview(roughCut, "rough-cut", request)}
        onOpenSmartPipeline={(clipId, plan) => smartPipeline.open(clipId, plan)}
        onGenerateCaptions={(options) => generateCaptionsWhenIdle(options)}
        onToggleSmartFrame={(enabled) => setSmartMode(enabled === false ? "smart-pipeline" : "smart-frame")}
        onExportVideo={() => handleExportVideo()}
      />
      <section className={`editor-grid ${compactRail ? "is-compact-rail" : ""}`}>
        <EditorSidebar model={{
          activeLanguage, activeTool, analyzeCurrentVisual, analyzeEffectVisual, audioBlob, audioDuration,
          builtInAssets, captionPosition, captionSegments, captionSize, captionStyle,
          captionStylePresetId, captionStylePresets,
          captionTargetDuration, captionsEnabled, clearMusicTrack, clearSourceAudioTrack,
          compactRail, currentSegmentIndex, deleteCaptionSegment,
          deleteUserAsset, downloadBlob, draggedAssetId,
          estimatedDuration, fileInputRef, generateCaptionsFromSourceAudio: generateCaptionsWhenIdle, canGenerateAudioCaptions, handleAssetClick,
          handleAssetPointerDown, handleCaptionPositionChange, handleFiles, handleStickerClick, confirmStickerSelection,
          imageSrc, isDragging, mediaTab, musicBlob, musicDuration, musicName, musicVolume,
          libraryType, libraryQuery, setLibraryQuery, selectLibraryType, libraryStatus, libraryError, libraryProvider,
          assetDownloadStates, prefetchLibraryAsset,
          notify, openSmartPipeline: () => smartPipeline.open(), openSceneDetection: () => sceneDetection.open(), openShortsStudio: () => shortsStudio.open(), previewVisionAnalysis, previewVisionKey, smartMode, setSmartMode,
          previewVisionOptions, previewVisualSrc, previewVisualType, progress, script, statusText, cancelCaptionTranscription,
          seekTo, segments, selectTool, selectedCaptionSegment, selectedFilterId,
          selectedLibraryAssetId, selectedSegmentId, selectedStickerId, selectedTransitionId,
          selectedVoice: selectedVoiceProfile ? { ...selectedVoice, name: selectedVoiceProfile.name } : selectedVoice,
          setCaptionSegments, setCaptionSize, setCaptionStyle, setCaptionStylePresetId, setCaptionStylePresets, setCaptionsEnabled, setIsDragging,
          setMediaTab, setMusicVolume, setSelectedAudioSegmentId, setSelectedFilterId, setSelectedSegmentId,
          setSelectedStickerId, setSelectedTrack, setSelectedTransitionId, setSourceAudioVolume, setVoiceTab,
          sourceAudioBlob, sourceAudioDuration, sourceAudioLinked, sourceAudioName, sourceAudioVolume, status, t,
          selectedAudioToolTarget, separateSelectedAudioVocals, separateSourceVocals, vocalSeparationJob,
          syncCaptionPositions, toggleCaptionSegmentHidden, trackLocks, trOption, updateCaptionSegmentText,
          updateScript, userAssets, visualSegments, visualOverlaySegments, visionJob, aiMusic, smartFrame, getProjectSnapshot,
          selectedVisualSegment, selectedEffectSegment, effectAnalysis, effectRunning, effectProgress, effectPhase,
          effectsPanelMode, setEffectsPanelMode, cinematicDepth, photoParallaxDepth,
          visualLocalTime, updateSelectedVisualEffects, updateSelectedSubjectEffect, updateSelectedClickRipple, removeSelectedSubjectEffect, miganRepair, hdRestoration, smartDenoise,
          mobilePanel, setMobilePanel: changeMobilePanel, applyAssetToTrack, applyOverlayTemplate, handleGeneratedVector, generationPlugins,
        }} />

        <PreviewStage
          t={t}
          previewShellRef={previewShellRef}
          previewCanvasRef={previewCanvasRef}
          previewVideoRef={previewVideoRef}
          onPreviewVideoTimeUpdate={previewVisionBaseAnalysis?.kind === "video-timeline" ? setPreviewVideoMediaTime : undefined}
          previewVisualSrc={previewVisualSrc}
          previewVisualRenderSrc={previewVisualRenderSrc}
          previewVisionMaskUrl={previewVisionMaskUrl}
          previewVisualType={previewVisualType}
          previewVisualMuted={shouldMuteEmbeddedVideoAudio(previewVisualSegment, {
            sourceAudioBlob,
            sourceAudioAssetId,
            sourceAudioLinked,
            linkedSegments: linkedSourceAudioSegments,
          })}
          previewTransition={previewTransition}
          visualEffects={visualAnimationPreview?.segmentId && visualAnimationPreview.segmentId === previewVisualSegment?.id
            ? { ...previewVisualSegment, animation: visualAnimationPreview.animation }
            : previewVisualSegment}
          subjectEffect={previewVisualSegment?.subjectEffect}
          subjectCutoutUrl={previewVisionAnalysis?.cutoutUrl || ""}
          cinematicDepth={previewVisualSegment?.cinematicDepth}
          photoParallax={previewVisualSegment?.photoParallax}
          depthAnalysis={previewDepthAnalysis}
          visualLocalTime={visualAnimationPreview?.segmentId && visualAnimationPreview.segmentId === previewVisualSegment?.id
            ? visualAnimationPreview.localTime
            : previewVisualLocalTime}
          visualMaskEditable={selectedTrack === "image" && Boolean(selectedVisualSegment) && visualCanvasEditMode === "mask"}
          onUpdateVisualMask={(mask) => updateSelectedVisualEffects({ mask })}
          visualTransformEditable={canvasVisualTarget === `visual:${previewVisualSegment?.id ?? ""}` && visualCanvasEditMode !== "mask" && !isPlaying}
          onSelectVisual={() => {
            if (!previewVisualSegment?.id) return;
            setSelectedVisualSegmentId(previewVisualSegment.id);
            setSelectedTrack("image");
            setCanvasVisualTarget(`visual:${previewVisualSegment.id}`);
          }}
          onDeselectVisuals={() => {
            setCanvasVisualTarget("");
          }}
          onUpdateVisualTransform={(transform) => updateSelectedVisualEffects({ baseTransform: transform })}
          previewRatio={previewRatio}
          previewFrameStyle={previewFrameStyle}
          previewFrameSize={previewFrameSize}
          trackVisibility={trackVisibility}
          fileInputRef={fileInputRef}
          selectedFilter={activePreviewFilter}
          fitMode={fitMode}
          ratioId={ratioId}
          setRatioId={(nextRatioId) => {
            autoRatioSourceKeyRef.current = `locked:${nextRatioId}`;
            setRatioId(nextRatioId);
            setFitModeFromUser("contain");
          }}
          visualObjectFit={previewVisualObjectFit}
          visualObjectPosition={previewVisualObjectPosition}
          backgroundRemoved={
            previewVisionOptions.removeBackground &&
            Boolean(previewVisionAnalysis?.cutoutUrl)
          }
          smartCropActive={Boolean(
            previewSmartCropRect &&
            !previewSmartCropRect.isFallback &&
            previewSmartCropRect.state !== "fallback" &&
            (previewSmartCropRect.confidence ?? 1) > 0
          )}
          smartFramePresentation={previewSmartCropRect?.presentation}
          smartFrameBackgroundPosition={previewSmartBackgroundPosition}
          setFitMode={setFitModeFromUser}
          captionsEnabled={captionsEnabled}
          currentCaption={currentCaption}
          currentCaptions={currentCaptions}
          captionSize={captionSize}
          captionStyle={captionStyle}
          captionPlacement={effectiveCaptionPlacement}
          startCaptionDrag={startCaptionDrag}
          setActiveTool={setActiveTool}
          selectedSticker={previewSticker}
          stickers={previewStickers}
          selectedStickerId={selectedStickerSegment?.id ?? ""}
          stickerEditable
          onSelectSticker={selectCanvasStickerSegment}
          onUpdateSticker={updateCanvasStickerSegment}
          isPlaying={isPlaying}
          canPreview={canPreview}
          handlePlayToggle={handlePlayToggle}
          estimatedDuration={estimatedDuration}
          currentTime={currentTime}
          seekTo={seekTo}
          notify={notify}
          getDraggedAsset={getDraggedAsset}
          applyAssetToTrack={applyAssetToTrack}
          addVisualOverlay={addVisualOverlay}
          visualOverlays={previewVisualOverlaysWithDepth}
          selectedVisualOverlayId={canvasVisualTarget === `overlay:${selectedVisualOverlayId}` ? selectedVisualOverlayId : ""}
          onSelectVisualOverlay={(id) => {
            setSelectedVisualOverlayId(id);
            setSelectedVisualSegmentId("");
            setSelectedTrack("overlay");
            setCanvasVisualTarget(`overlay:${id}`);
          }}
          onUpdateVisualOverlay={updateVisualOverlayById}
          visualOverlayMaskEditable={visualCanvasEditMode === "mask"}
          onUpdateVisualOverlayMask={(mask) => updateSelectedVisualOverlayEffects({ mask })}
          onReorderVisualOverlay={(id, direction) => setVisualOverlaySegments((items) => {
            const ordered = [...items].sort((a, b) => (a.layer || 1) - (b.layer || 1));
            const index = ordered.findIndex((item) => item.id === id);
            const target = Math.max(0, Math.min(ordered.length - 1, index + direction));
            if (index < 0 || index === target) return items;
            [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
            return ordered.map((item, layer) => ({ ...item, layer: layer + 1 }));
          })}
        />

        <VoicePanel
          t={t}
          activeTool={activeTool}
          captionVoiceFocusRequest={captionVoiceFocusRequest}
          status={status}
          statusText={statusText}
          voiceTab={voiceTab}
          setVoiceTab={setVoiceTab}
          script={script}
          updateScript={updateScript}
          selectedVoiceId={selectedVoiceId}
          setSelectedVoiceId={setSelectedVoiceId}
          selectedVoice={selectedVoice}
          filteredVoices={filteredVoices}
          voiceFilter={voiceFilter}
          setVoiceFilter={setVoiceFilter}
          showVoiceFilter={showVoiceFilter}
          setShowVoiceFilter={setShowVoiceFilter}
          speed={speed}
          setSpeed={setSpeed}
          volume={volume}
          setVolume={setVolume}
          progressPercent={progressPercent}
          audioBlob={audioBlob}
          generateVoiceover={generateVoiceoverWhenIdle}
          beginOllalinkSpeech={beginOllalinkSpeech}
          downloadBlob={downloadBlob}
          favoriteVoiceIds={favoriteVoiceIds}
          setFavoriteVoiceIds={setFavoriteVoiceIds}
          voiceProfiles={voiceProfiles}
          addVoiceProfile={addVoiceProfile}
          removeVoiceProfile={removeVoiceProfile}
          toggleVoiceProfileFavorite={toggleVoiceProfileFavorite}
          selectedVoiceProfileId={selectedVoiceProfileId}
          setSelectedVoiceProfileId={setSelectedVoiceProfileId}
          recordedVoices={recordedVoices}
          recordingState={recordingState}
          recordingElapsed={recordingElapsed}
          startVoiceRecording={startVoiceRecording}
          stopVoiceRecording={stopVoiceRecording}
          historyItems={historyItems}
          useHistoryItem={useHistoryItem}
          setHistoryItems={setHistoryItems}
          notify={notify}
          audioUrl={audioUrl}
          audioRef={audioRef}
          audioSegments={audioSegments}
          audioSegmentRefs={audioSegmentRefs}
          sourceAudioRef={sourceAudioRef}
          musicRef={musicRef}
          sourceAudioUrl={sourceAudioUrl}
          musicUrl={musicUrl}
          captionSegments={captionSegments}
          selectedCaptionSegment={selectedCaptionSegment}
          selectedSegmentId={selectedSegmentId}
          setSelectedSegmentId={setSelectedSegmentId}
          currentSegmentIndex={currentSegmentIndex}
          captionTargetDuration={captionTargetDuration}
          updateCaptionSegmentText={updateCaptionSegmentText}
          alignCaptionToAudio={alignCaptionToAudio}
          linkCaptionAudio={linkCaptionAudio}
          unlinkCaptionAudio={unlinkCaptionAudio}
          toggleCaptionSegmentHidden={toggleCaptionSegmentHidden}
          deleteCaptionSegment={deleteCaptionSegment}
          importCaptionSegments={importCaptionSegments}
          addCaptionSegment={handleAddCaptionSegment}
          currentTime={currentTime}
          seekTo={seekTo}
          sourceAudioBlob={sourceAudioBlob}
          sourceAudioLinked={sourceAudioLinked}
          canGenerateCaptions={canGenerateCaptions}
          generateCaptionsFromSourceAudio={generateCaptionsWhenIdle}
          cancelCaptionTranscription={cancelCaptionTranscription}
          isGeneratingCaptions={status === "captioning"}
          automaticCaptionProgress={status === "captioning" ? progress : 0}
          smartMode={smartMode}
          aiMusic={aiMusic}
          silenceRemoval={silenceRemoval}
          roughCut={roughCut}
          smartPipeline={smartPipeline}
          openSmartPipeline={() => smartPipeline.open()}
          sceneDetection={sceneDetection}
          openSceneDetection={() => sceneDetection.open()}
          uiLanguage={activeLanguage}
          captionStyle={captionStyle}
          setCaptionStyle={setCaptionStyle}
          setCaptionSegments={setCaptionSegments}
          smartFrame={smartFrame}
          getProjectSnapshot={getProjectSnapshot}
          onApplyPlan={handleApplyEditorPlan}
          visualSegments={visualSegments}
          analyzeCurrentVisual={analyzeCurrentVisual}
          analyzeEffectVisual={analyzeEffectVisual}
          hasVisual={Boolean(previewVisualSrc)}
          visualType={previewVisualType}
          audioDuration={audioDuration}
          faceSwap={faceSwap}
          selectedTrack={selectedTrack}
          selectedAudioSegment={selectedAudioSegment}
          selectedTrackAudioSegment={selectedAudioToolTarget}
          mobileInspectorOrigin={mobilePanel === "inspector" ? mobilePanelOrigin : ""}
          mobileInspectorSection={isCompactViewport && mobilePanel === "inspector" ? mobileInspectorSection : ""}
          onCloseMobileInspector={() => changeMobilePanel("")}
          updateSelectedTrackAudioSegment={updateSelectedTrackAudioSegment}
          deleteSelectedTrackAudioSegment={() => handleDeleteTrack()}
          updateAudioSegment={updateAudioSegment}
          toggleAudioSegmentReverse={toggleAudioSegmentReverse}
          deleteAudioSegment={deleteAudioSegment}
          onVoiceColorAssetReady={handleVoiceColorAssetReady}
          onApplyVoiceColor={applyVoiceColorToSelectedAudio}
          onRestoreVoiceColor={restoreSelectedAudioVoiceColor}
          selectedVisualSegment={selectedVisualSegment}
          selectedStickerSegment={selectedStickerSegment}
          updateStickerSegment={updateSelectedStickerSegment}
          deleteStickerSegment={deleteSelectedStickerSegment}
          visualLocalTime={visualLocalTime}
          visualTimelineStart={selectedVisualRange?.start ?? 0}
          updateSelectedVisualEffects={updateSelectedVisualEffects}
          miganRepair={miganRepair}
          hdRestoration={hdRestoration}
          smartDenoise={smartDenoise}
          onPreviewAnimation={setVisualAnimationPreview}
          selectedFilterId={selectedFilterId}
          setSelectedFilterId={setSelectedFilterId}
          trOption={trOption}
          selectedVisualOverlay={selectedVisualOverlay}
          visualOverlayCount={visualOverlaySegments.filter((overlay) => overlay?.hidden !== true).length}
          saveVisualOverlayTemplate={saveVisualOverlayTemplate}
          visualOverlayTemplateSaveState={visualOverlayTemplateSaveState}
          updateVisualOverlaySegment={(patch) => {
            if (trackLocks.overlay) return void notify(t("effectClipLocked"));
            setVisualOverlaySegments((items) => items.map((item) => {
              if (item.id !== selectedVisualOverlayId) return item;
              const updated = { ...item, ...patch };
              return patch.text || patch.shape
                ? { ...updated, src: createTemplateOverlayRenderSource(updated) }
                : updated;
            }));
          }}
          updateVisualOverlayEffects={updateSelectedVisualOverlayEffects}
          setVisualCanvasEditMode={setVisualCanvasEditMode}
          deleteVisualOverlay={() => handleDeleteTrack()}
          applyVisualOverlayPreset={(id) => {
            const preset = getVisualOverlayPreset(id);
            if (preset) updateSelectedVisualOverlay(preset);
          }}
          effectSegment={selectedEffectSegment}
          effectAnalysis={effectAnalysis}
          effectRunning={effectRunning}
          effectProgress={effectProgress}
          effectPhase={effectPhase}
          effectsPanelMode={effectsPanelMode}
          cinematicDepth={cinematicDepth}
          updateSelectedCinematicDepth={updateSelectedCinematicDepth}
          photoParallaxDepth={photoParallaxDepth}
          updateSelectedPhotoParallax={updateSelectedPhotoParallax}
          updateSelectedSubjectEffect={updateSelectedSubjectEffect}
          updateSelectedClickRipple={updateSelectedClickRipple}
          removeSelectedSubjectEffect={removeSelectedSubjectEffect}
          onOpticalFlowAssetReady={handleOpticalFlowAssetReady}
          generationPlugins={generationPlugins}
        />
      </section>

      <Timeline
        timelineMarkers={timelineMarkers}
        setTimelineMarkers={setTimelineMarkers}
        t={t}
        trOption={trOption}
        notify={notify}
        undo={undo}
        redo={redo}
        handleDeleteTrack={handleDeleteTrack}
        handleDuplicateTrack={handleDuplicateTrack}
        handleCutTrack={handleCutTrack}
        rippleEditing={rippleEditing}
        setRippleEditing={setRippleEditing}
        canPreview={canPreview}
        handlePlayToggle={handlePlayToggle}
        isPlaying={isPlaying}
        handleAddSegment={handleAddSegment}
        handleRemoveSegment={handleRemoveSegment}
        adjustSelectedSegmentWeight={adjustSelectedSegmentWeight}
        timelineZoom={timelineZoom}
        setTimelineZoom={setTimelineZoom}
        selectedTrack={selectedTrack}
        setSelectedTrack={setSelectedTrack}
        setActiveTool={setActiveTool}
        openMobileInspector={(track, section = "") => {
          setMobilePanelOrigin(getMobileClipPanelOrigin(track));
          setMobileInspectorSection(section);
          changeMobilePanel("inspector");
        }}
        openMobileTools={() => changeMobilePanel("tools")}
        openMobileFilePicker={() => fileInputRef.current?.click()}
        requestCaptionVoiceFocus={() => setCaptionVoiceFocusRequest((request) => request + 1)}
        alignCaptionToAudio={alignCaptionToAudio}
        linkCaptionAudio={linkCaptionAudio}
        unlinkCaptionAudio={unlinkCaptionAudio}
        linkAllCaptionAudio={linkAllCaptionAudio}
        unlinkAllCaptionAudio={unlinkAllCaptionAudio}
        alignAudioCaptions={alignAudioCaptions}
        linkAudioToCaption={linkAudioToCaption}
        unlinkAudioCaptions={unlinkAudioCaptions}
        trackVisibility={trackVisibility}
        toggleTrackVisibility={toggleTrackVisibility}
        trackLocks={trackLocks}
        toggleTrackLock={toggleTrackLock}
        trackScrollRef={trackScrollRef}
        startTimelineSeek={startTimelineSeek}
        timelineDuration={timelineDuration}
        timelineContentDuration={Math.max(estimatedDuration, timelineHorizon, timelineMarkerEnd)}
        setTimelineHorizon={setTimelineHorizon}
        currentTime={currentTime}
        currentTimeRef={currentTimeRef}
        visualPlaybackStartTimeRef={visualPlaybackStartTimeRef}
        visualPlaybackStartedAtRef={visualPlaybackStartedAtRef}
        playbackDuration={estimatedDuration}
        previewVideoMediaTime={previewVideoMediaTime}
        playheadPercent={playheadPercent}
        snapGuide={snapGuide}
        setSnapGuide={setSnapGuide}
        assetDropTargetTrack={assetDropTargetTrack}
        assetDropPosition={assetDropPosition}
        assetDropPulseTrack={assetDropPulseTrack}
        assetDragPreview={assetDragPreview}
        draggedAssetType={getActiveDraggedAsset()?.type || assetDragPreview?.type || ""}
        draggedAssetDuration={getActiveDraggedAsset()?.duration || assetDragPreview?.duration || 0}
        handleTrackAssetDragOver={handleTrackAssetDragOver}
        handleTrackAssetDragLeave={handleTrackAssetDragLeave}
        handleTrackAssetDrop={handleTrackAssetDrop}
        handleVisualStyleDrop={handleVisualStyleDrop}
        activeTimelineClipDrag={activeTimelineClipDrag}
        showStickerTrack={showStickerTrack}
        stickerSegments={stickerSegments}
        setStickerSegments={setStickerSegments}
        currentStickerSegment={currentStickerSegment}
        selectedStickerSegmentId={selectedStickerSegmentId}
        setSelectedStickerSegmentId={setSelectedStickerSegmentId}
        stickerTimelineDrag={stickerTimelineDrag}
        imageSrc={imageSrc}
        displayedVisualSegments={displayedVisualSegments}
        setVisualSegments={setVisualSegments}
        renderedVisualTimeline={renderedVisualTimeline}
        visualType={visualType}
        currentVisualSegment={currentVisualSegment}
        selectedVisualSegmentId={selectedVisualSegmentId}
        currentVisualSegmentIndex={currentVisualSegmentIndex}
        visualOverlaySegments={visualOverlaySegments}
        selectedVisualOverlayId={selectedVisualOverlayId}
        setSelectedVisualOverlayId={setSelectedVisualOverlayId}
        setVisualOverlaySegments={setVisualOverlaySegments}
        extractVideoSourceAudio={extractVideoSourceAudio}
        generateCaptionsFromAudioClip={generateCaptionsWhenIdle}
        separateAudioClipVocals={separateAudioClipVocals}
        audioProcessingBusy={vocalSeparationJob.running || status === "captioning"}
        setSelectedVisualSegmentId={setSelectedVisualSegmentId}
        seekTo={seekTo}
        suppressTimelineClipClickRef={suppressTimelineClipClickRef}
        startTimelineClipDrag={startTimelineClipDrag}
        startCaptionResize={startCaptionResize}
        startImageResize={startImageResize}
        startStickerSegmentMove={startStickerSegmentMove}
        startStickerSegmentResize={startStickerSegmentResize}
        displayedCaptionSegments={displayedCaptionSegments}
        displayedCaptionTimeline={displayedCaptionTimeline}
        setCaptionSegments={setCaptionSegments}
        currentCaptionSegment={currentCaptionSegment}
        selectedSegmentId={selectedSegmentId}
        setSelectedSegmentId={setSelectedSegmentId}
        captionTargetDuration={captionTargetDuration}
        sourceAudioVolume={sourceAudioVolume}
        setSourceAudioVolume={setSourceAudioVolume}
        musicVolume={musicVolume}
        setMusicVolume={setMusicVolume}
        sourceAudioLinked={sourceAudioLinked}
        linkedSourceAudioSegments={linkedSourceAudioSegments}
        sourceAudioBlob={sourceAudioBlob}
        sourceAudioPeaks={sourceAudioPeaks}
        sourceAudioClipPercent={sourceAudioClipPercent}
        sourceAudioStartPercent={sourceAudioStartPercent}
        sourceAudioDuration={sourceAudioDuration}
        sourceAudioDragTargetLane={sourceAudioDragTargetLane}
        setSourceAudioStart={setSourceAudioStart}
        selectedSourceAudioSegmentId={selectedSourceAudioSegmentId}
        setSelectedSourceAudioSegmentId={setSelectedSourceAudioSegmentId}
        audioBlob={audioBlob}
        peaks={peaks}
        audioClipPercent={audioClipPercent}
        audioDuration={audioDuration}
        audioSegments={audioSegments}
        setAudioSegments={setAudioSegments}
        selectedAudioSegmentId={selectedAudioSegmentId}
        setSelectedAudioSegmentId={setSelectedAudioSegmentId}
        startAudioSegmentMove={startAudioSegmentMove}
        startSourceAudioMove={startSourceAudioMove}
        musicBlob={musicBlob}
        musicSegments={musicSegments}
        setMusicSegments={setMusicSegments}
        setMusicStart={setMusicStart}
        selectedMusicSegmentId={selectedMusicSegmentId}
        setSelectedMusicSegmentId={setSelectedMusicSegmentId}
        musicPeaks={musicPeaks}
        musicStartPercent={musicStartPercent}
        musicDuration={musicDuration}
        startMusicMove={startMusicMove}
      />

      {mobilePanel && !(mobilePanel === "inspector" && isCompactViewport && mobileInspectorSection) ? (
        <header className="mobile-sheet-nav">
          <strong>{({
            transform: t("visualTabTransform"),
            mask: t("visualTabMask"),
            filters: t("visualTabEffects"),
            animation: t("visualTabAnimation"),
            speed: t("visualTabSpeed"),
            vector: t("vectorProperties", "矢量"),
            timing: t("overlayTiming", "层级与时长"),
            repair: t("repairTab"),
            effects: t("effects"),
            caption: t("caption"),
            voice: t("aiVoice"),
            audio: t("mobileClipAudio"),
            fade: t("mobileClipFade"),
            "voice-color": t("voiceColorTab", "音色"),
            sticker: t("stickerProperties"),
          }[mobileInspectorSection]) || (mobilePanelOrigin === "audio-clip"
            ? t("audioClipProperties")
            : mobilePanelOrigin === "sticker-clip"
              ? t("stickerProperties")
              : mobilePanelOrigin === "visual-clip"
                ? t("visualPanelTitle")
                : mobilePanelOrigin === "overlay-clip"
                  ? t("pictureInPicture", "画中画")
                  : mobilePanelOrigin === "caption-clip"
                    ? t("caption")
                    : t(activeTool))}</strong>
          <div className="mobile-sheet-nav-actions">
            {!mobilePanelOrigin.endsWith("-clip") ? <div className="mobile-sheet-tabs" role="tablist" aria-label={t("mobilePanelView")}>
              <button className={mobilePanel === "tools" ? "is-active" : ""} type="button" role="tab" aria-selected={mobilePanel === "tools"} onClick={() => changeMobilePanel("tools")}>{t("mobileDrawerTools")}</button>
              <button className={mobilePanel === "inspector" ? "is-active" : ""} type="button" role="tab" aria-selected={mobilePanel === "inspector"} onClick={() => changeMobilePanel("inspector")}>{t("properties")}</button>
            </div> : null}
            <button className="mobile-sheet-close" type="button" aria-label={t("close", "关闭")} onClick={() => changeMobilePanel("")}><X size={20} /></button>
          </div>
        </header>
      ) : null}
      {mobilePanel ? <button className="mobile-sheet-backdrop" type="button" aria-label={t("close", "关闭")} onClick={() => changeMobilePanel("")} /> : null}

      <AssetDragPreview preview={assetDragPreview} t={t} />
      <MiganRepairDialog
        repair={miganRepair}
        segment={selectedVisualSegment}
        t={t}
        onApplied={() => changeMobilePanel("")}
      />
      <NanoVsrRestorationDialog
        restoration={hdRestoration}
        segment={hdRestoration.sourceSegment || selectedVisualSegment}
        t={t}
        onApplied={() => changeMobilePanel("")}
      />
      <SmartDenoiseDialog
        denoise={smartDenoise}
        segment={smartDenoise.sourceSegment || selectedVisualSegment}
        t={t}
        onApplied={() => changeMobilePanel("")}
      />
      <ExportProgressOverlay
        exporting={exporting}
        error={exportError}
        language={activeLanguage}
        onClose={() => setExportError(null)}
        onRetry={() => { if (exportError?.settings) void handleExportVideo({ settings: exportError.settings }); }}
        percent={exportPercent}
        phase={exportPhase}
        elapsedSeconds={exportElapsedSeconds}
        onCancel={handleCancelExport}
        canceling={exportPhase === t("exportCanceling")}
        t={t}
      />
      {showFirstVisualGuide && !shouldShowLanguageIntro ? (
        <FirstVisualGuide
          language={activeLanguage}
          onClose={() => setShowFirstVisualGuide(false)}
          onComplete={() => {
            markFirstVisualGuideSeen();
            setShowFirstVisualGuide(false);
          }}
        />
      ) : null}
      {shouldShowLanguageIntro ? (
        <LanguageIntro t={t} closing={introClosing} onChoose={chooseInterfaceLanguage} />
      ) : null}
      {toast ? <div className="toast">{toast}</div> : null}
    </main>
  );
}
