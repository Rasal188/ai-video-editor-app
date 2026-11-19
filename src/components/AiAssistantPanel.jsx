import { captureTranscriptionPreferences } from "../lib/transcriptionPreferences.js";
import { attachTranscriptionOutcome, getTranscriptionOutcome } from "../lib/transcriptionOutcome.js";
import { workflowTranscriptionOutcome, isTranscriptionCancellation } from "../lib/workflowTranscription.js";
import { editorTranscriptionStatus } from "../lib/editorTranscription.js";
import { useState, useRef, useEffect } from "react";
import {
  Sparkle,
  Minus,
  X,
  CaretRight,
  CaretLeft,
  CircleNotch,
  CheckCircle,
  Warning,
  Info,
  ArrowCounterClockwise,
  Play,
  Scissors,
  TextT,
  Crop,
  BookmarkSimple,
  Trash,
  PaperPlaneRight,
  FilmSlate,
  ImageSquare,
  VideoCamera,
  Sliders,
  Microphone,
  MusicNote,
  ClosedCaptioning,
} from "@phosphor-icons/react";
import { applyCommandPlan } from "../lib/projectCommandEngine.js";
import { extractMinimalProjectSummary } from "../lib/assistantSummary.js";
import { classifyUserIntent } from "../lib/intentClassifier.js";
import { parseNaturalLanguageEditingPlan, resolveTargetClipId } from "../lib/naturalLanguagePlanParser.js";
import { inspectPunchIns } from "../lib/smartZoom.js";
import { assertAssistantBase, captureAssistantBase, prepareAssistantProposal, assertDestructiveAssistantTargets, assertAssistantOperationUnlocked, assertAssistantChangedTracksUnlocked } from "../lib/assistantSafety.js";
function formatFileSize(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}
import "./AiAssistantPanel.css";

const MAX_IMAGE_SIZE = 15 * 1024 * 1024; // 15MB
const MAX_VIDEO_SIZE = 50 * 1024 * 1024; // 50MB
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime"];

const EMPTY_TIMELINE_SUGGESTIONS = [
  "Switch aspect ratio to 9:16 vertical",
  "Set canvas ratio to 1:1 square",
  "Set caption style to neon",
  "Add chapter marker at 2 seconds",
  "Set fit mode to contain",
];

const WITH_CLIPS_SUGGESTIONS = [
  "Switch aspect ratio to 9:16 vertical",
  "Set caption style to neon",
  "Add chapter marker at 2 seconds",
  "Split first clip at 3 seconds",
  "Trim first clip to 5 seconds",
];

export const AVAILABLE_MODELS = Object.freeze([
  { id: "gemini-3-flash", label: "Gemini 3 Flash", recommended: true },
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite" },
  { id: "gemma4", label: "Gemma 4" },
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  { id: "glm-5.2", label: "GLM 5.2" },
  { id: "glm-5.3", label: "GLM 5.3" },
  { id: "minimax-m3", label: "MiniMax M3" },
  { id: "nemotron-ultra", label: "Nemotron Ultra" },
  { id: "nemotron-super", label: "Nemotron Super" },
  { id: "kimi-k2.7-code", label: "Kimi K2.7 Code" },
  { id: "kimi-k2.6", label: "Kimi K2.6" },
  { id: "gpt-oss-120b", label: "GPT-OSS 120B" },
  { id: "gemini-3.1-flash-image", label: "Gemini 3.1 Flash Image (Vision)" },
]);

export { resolveTargetClipId };

export function formatActionType(type) {
  switch (type) {
    case "project.set_ratio":
      return { label: "Set Aspect Ratio", icon: Crop, color: "#6366f1" };
    case "project.set_fit":
      return { label: "Set Fit Mode", icon: Crop, color: "#6366f1" };
    case "visual.split":
      return { label: "Split Clip", icon: Scissors, color: "#ec4899" };
    case "visual.trim":
      return { label: "Trim Clip", icon: Scissors, color: "#f59e0b" };
    case "visual.delete":
      return { label: "Delete Clip", icon: Trash, color: "#ef4444" };
    case "visual.duplicate":
      return { label: "Duplicate Clip", icon: Play, color: "#3b82f6" };
    case "visual.reorder":
      return { label: "Reorder Clip", icon: Play, color: "#3b82f6" };
    case "transition.set":
      return { label: "Set Transition", icon: Sparkle, color: "#8b5cf6" };
    case "clip.set_speed":
      return { label: "Set Clip Speed", icon: Sliders, color: "#10b981" };
    case "clip.set_filter":
      return { label: "Apply Visual Filter", icon: Sparkle, color: "#8b5cf6" };
    case "clip.set_color_grade":
      return { label: "Color Grading", icon: Sliders, color: "#f59e0b" };
    case "clip.delete":
      return { label: "Delete Clip", icon: Trash, color: "#ef4444" };
    case "timed.move":
      return { label: "Move Segment", icon: Play, color: "#3b82f6" };
    case "timed.resize":
      return { label: "Resize Segment", icon: Scissors, color: "#f59e0b" };
    case "track.set_locked":
      return { label: "Lock/Unlock Track", icon: Sliders, color: "#64748b" };
    case "track.set_visibility":
      return { label: "Show/Hide Track", icon: Sliders, color: "#64748b" };
    case "overlay.set_transform":
      return { label: "Transform Overlay", icon: Crop, color: "#ec4899" };
    case "caption.add":
      return { label: "Add Caption", icon: TextT, color: "#10b981" };
    case "caption.update":
      return { label: "Update Caption", icon: TextT, color: "#10b981" };
    case "caption.delete":
      return { label: "Delete Caption", icon: Trash, color: "#ef4444" };
    case "caption.set_style":
      return { label: "Style Captions", icon: TextT, color: "#8b5cf6" };
    case "caption.set_position":
      return { label: "Position Captions", icon: TextT, color: "#8b5cf6" };
    case "marker.add":
      return { label: "Add Marker", icon: BookmarkSimple, color: "#06b6d4" };
    case "marker.update":
      return { label: "Update Marker", icon: BookmarkSimple, color: "#06b6d4" };
    case "marker.delete":
      return { label: "Delete Marker", icon: Trash, color: "#ef4444" };
    case "audio.delete":
      return { label: "Delete Voiceover", icon: Trash, color: "#ef4444" };
    case "music.delete":
      return { label: "Delete Background Music", icon: Trash, color: "#ef4444" };
    case "clip.set_muted":
      return { label: "Mute/Unmute Clip", icon: Microphone, color: "#ec4899" };
    case "clip.set_property":
      return { label: "Adjust Clip Property", icon: Sliders, color: "#3b82f6" };
    case "tool.scene_detection":
      return { label: "AI Scene Detection", icon: FilmSlate, color: "#8b5cf6" };
    case "tool.silence_removal":
      return { label: "AI Silence Removal", icon: Scissors, color: "#ef4444" };
    case "tool.rough_cut":
      return { label: "AI Rough Cut", icon: Scissors, color: "#f59e0b" };
    case "tool.smart_pipeline":
      return { label: "AI Smart Pipeline", icon: Sparkle, color: "#6366f1" };
    case "tool.generate_captions":
      return { label: "Generate Auto Captions", icon: ClosedCaptioning, color: "#10b981" };
    case "tool.smart_frame":
      return { label: "AI Smart Frame Re-centering", icon: Crop, color: "#06b6d4" };
    case "tool.export":
      return { label: "Export Video", icon: FilmSlate, color: "#3b82f6" };
    default:
      return { label: type, icon: Sparkle, color: "#71717a" };
  }
}

export function formatActionParams(type, params) {
  if (!params) return "";
  switch (type) {
    case "project.set_ratio":
      return `Ratio: ${params.ratioId || params.ratio}`;
    case "project.set_fit":
      return `Fit Mode: ${params.fitMode}`;
    case "visual.split":
      return `Clip: ${params.clipId || "selected"} at ${params.at}s`;
    case "visual.trim":
      return `Clip: ${params.clipId || "selected"} [${params.sourceIn ?? 0}s → ${params.sourceOut}s]`;
    case "visual.delete":
      return `Clip: ${params.clipId || "selected"}`;
    case "visual.duplicate":
      return `Clip: ${params.clipId || "selected"}${Number.isFinite(params.atIndex) ? ` → Index ${params.atIndex}` : ""}`;
    case "visual.reorder":
      return `Clip: ${params.clipId || "selected"} → Index ${params.toIndex}`;
    case "transition.set":
      return `Clip: ${params.clipId || "selected"} → Transition: ${params.transitionId || "none"}`;
    case "clip.set_speed":
      return `Clip: ${params.clipId || "selected"} → ${params.speed}x speed${params.preservePitch ? " (pitch preserved)" : ""}`;
    case "clip.set_filter":
      return `Filter: ${params.filterId} (${params.scope === "all" ? "all clips" : (params.clipId || "selected")})`;
    case "clip.set_color_grade":
      return Object.entries(params.colorGrade || {})
        .map(([k, v]) => `${k}: ${v > 0 ? `+${v}` : v}`)
        .join(", ");
    case "clip.delete":
      return `Clip: ${params.clipId || "selected"} (${params.track || "visuals"})`;
    case "timed.move":
      return `Clip: ${params.clipId || "selected"} (${params.track}) → Start: ${params.start}s`;
    case "timed.resize":
      return `Clip: ${params.clipId || "selected"} (${params.track}) → Duration: ${params.duration}s`;
    case "track.set_locked":
      return `Track: ${params.track} → ${params.locked ? "Locked" : "Unlocked"}`;
    case "track.set_visibility":
      return `Track: ${params.track} → ${params.visible ? "Visible" : "Hidden"}`;
    case "overlay.set_transform":
      return `Overlay: ${params.clipId || "selected"}`;
    case "audio.delete":
      return params.clipId ? `Voiceover clip: ${params.clipId}` : "Voiceover track";
    case "music.delete":
      return params.clipId ? `Music clip: ${params.clipId}` : "Background music";
    case "clip.set_muted":
      return `Clip: ${params.clipId || "selected"} → ${params.muted ? "Muted" : "Unmuted"}`;
    case "clip.set_property":
      return `Clip: ${params.clipId || "selected"} · ${params.property}: ${params.value}`;
    case "caption.add":
      return `"${params.text}" [${params.start}s – ${params.end}s]`;
    case "caption.set_style":
      return Object.entries(params.style || {})
        .map(([k, v]) => {
          if (k === "karaoke") return `karaoke: ${v ? "enabled" : "disabled"}`;
          if (k === "fontId") return `font: ${v}`;
          return `${k}: ${v}`;
        })
        .join(", ");
    case "caption.set_position":
      return `Position: ${params.position || "bottom"}`;
    case "marker.add":
      return `Time: ${params.time}s · Title: "${params.title || "Marker"}"`;
    case "tool.scene_detection":
      return params.clipId ? `Scan clip: ${params.clipId}` : "Scan video for scene changes";
    case "tool.silence_removal":
      return "Detect and trim pauses & silence";
    case "tool.rough_cut":
      return "Generate rough cut based on speech & energy";
    case "tool.smart_pipeline":
      return "Analyze speech, scenes, and transcript";
    case "tool.generate_captions":
      return "Transcribe audio & generate captions";
    case "tool.smart_frame":
      return "Toggle AI Smart Frame tracking";
    case "tool.export":
      return "Open export & rendering dialog";
    default:
      return JSON.stringify(params);
  }
}

export function AiAssistantPanel({
  isExpanded = true,
  onToggleCollapse,
  getProjectSnapshot,
  onApplyPlan,
  userAssets = [],
  projectId = null,
  notify,
  onUndo,
  onRedo,
  currentTime = 0,
  selectedVisualSegmentId = "",
  selectedVisualOverlayId = "",
  selectedAudioSegmentId = "",
  selectedSegmentId = "",
  selectedTrack = "",
  onOpenSceneDetection,
  onOpenSilenceRemoval,
  onOpenRoughCut,
  onOpenSmartPipeline,
  onGenerateCaptions,
  onToggleSmartFrame,
  onExportVideo,
}) {
  const [prompt, setPrompt] = useState("");
  const [selectedModel, setSelectedModel] = useState("gemini-3-flash");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [applyingPlanId, setApplyingPlanId] = useState(null);

  // Attachments in the unified composer
  const [attachments, setAttachments] = useState([]);
  const imageInputRef = useRef(null);
  const videoInputRef = useRef(null);

  // Chat conversation history: array of { id, role: "user"|"assistant", text, attachments?, plan, status, type? }
  const [messages, setMessages] = useState([]);
  const [activeClarification, setActiveClarification] = useState(null);
  const messageEndRef = useRef(null);
  const textareaRef = useRef(null);

  const planningRef = useRef(null);
  const executionRef = useRef(null);
  const attemptedApprovalsRef = useRef(new Set());
  const cancelPlanning = () => {
    planningRef.current?.controller.abort();
    planningRef.current = null;
    setLoading(false);
  };
  useEffect(() => () => {
    planningRef.current?.controller.abort();
    executionRef.current?.controller.abort();
  }, []);
  useEffect(() => {
    if (!isExpanded) {
      planningRef.current?.controller.abort();
      planningRef.current = null;
      setLoading(false);
    }
  }, [isExpanded]);

  const currentSnapshot = getProjectSnapshot ? getProjectSnapshot() : null;
  const projectSummary = currentSnapshot
    ? extractMinimalProjectSummary(currentSnapshot, {
      currentTime,
      selectedClipId: selectedVisualSegmentId || selectedAudioSegmentId || selectedSegmentId,
      selectedVisualSegmentId,
      selectedAudioSegmentId,
      selectedSegmentId,
      selectedTrack,
    })
    : null;
  const visualCount = projectSummary?.visualClips?.length || 0;
  const captionsCount = projectSummary?.captionsCount || 0;
  const audioCount = projectSummary?.audioCount || 0;
  const musicCount = projectSummary?.musicCount || 0;
  const markersCount = projectSummary?.markers?.length || 0;
  const hasClips = visualCount > 0;
  const hasOtherContent = captionsCount > 0 || audioCount > 0 || musicCount > 0 || markersCount > 0;
  const hasAnyContent = hasClips || hasOtherContent;

  const activeSuggestions = hasClips
    ? WITH_CLIPS_SUGGESTIONS
    : hasOtherContent
      ? [
        "Switch aspect ratio to 9:16 vertical",
        "Set caption style to neon",
        "Make captions larger",
        "Add chapter marker at 2 seconds",
        "Set fit mode to contain",
      ]
      : EMPTY_TIMELINE_SUGGESTIONS;

  // Auto scroll to latest message when new messages arrive
  useEffect(() => {
    if (isExpanded) {
      messageEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, loading, isExpanded]);

  const handleImageUpload = (e) => {
    const files = Array.from(e.target?.files || []);
    if (!files.length) return;

    const newAttachments = [];
    for (const file of files) {
      if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
        setError(`Unsupported image format "${file.name}". Please upload JPEG, PNG, or WebP.`);
        continue;
      }
      if (file.size > MAX_IMAGE_SIZE) {
        setError(`Image "${file.name}" exceeds size limit of 15MB (${formatFileSize(file.size)}).`);
        continue;
      }

      const blobUrl = URL.createObjectURL(file);
      newAttachments.push({
        id: `att-img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        file,
        name: file.name,
        size: file.size,
        type: file.type || "image/jpeg",
        kind: "image",
        blobUrl,
        role: "product",
      });
    }

    if (newAttachments.length > 0) {
      setAttachments((prev) => [...prev, ...newAttachments]);
      setError(null);
    }
    if (e.target) e.target.value = "";
  };

  const handleVideoUpload = (e) => {
    const files = Array.from(e.target?.files || []);
    if (!files.length) return;

    const newAttachments = [];
    for (const file of files) {
      if (!ALLOWED_VIDEO_TYPES.includes(file.type)) {
        setError(`Unsupported video format "${file.name}". Please upload MP4, WebM, or MOV.`);
        continue;
      }
      if (file.size > MAX_VIDEO_SIZE) {
        setError(`Video "${file.name}" exceeds size limit of 50MB (${formatFileSize(file.size)}).`);
        continue;
      }

      const blobUrl = URL.createObjectURL(file);
      newAttachments.push({
        id: `att-vid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        file,
        name: file.name,
        size: file.size,
        type: file.type || "video/mp4",
        kind: "video",
        blobUrl,
        role: "alongside",
        duration: 10,
      });
    }

    if (newAttachments.length > 0) {
      setAttachments((prev) => [...prev, ...newAttachments]);
      setError(null);
    }
    if (e.target) e.target.value = "";
  };

  const handleRemoveAttachment = (id) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target?.blobUrl) {
        try {
          URL.revokeObjectURL(target.blobUrl);
        } catch {
          // ignore
        }
      }
      return prev.filter((a) => a.id !== id);
    });
    setError(null);
  };

  const handleUpdateAttachmentRole = (id, newRole) => {
    setAttachments((prev) =>
      prev.map((a) => (a.id === id ? { ...a, role: newRole } : a))
    );
  };

  const handleExecuteEditingPlan = async (userPromptText, customContext = null) => {
    cancelPlanning();
    const request = { id: `assistant-${crypto.randomUUID()}`, controller: new AbortController() };
    planningRef.current = request;
    const base = captureAssistantBase(getProjectSnapshot());
    const isCurrent = () => planningRef.current === request && !request.controller.signal.aborted;
    setLoading(true);
    setError(null);

    const conversationContext = customContext || (activeClarification ? { activeClarification } : {});

    try {
      let data = null;
      let fetchFailed = false;

      try {
        const response = await fetch("/api/assistant/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          signal: request.controller.signal,
          body: JSON.stringify({
            prompt: userPromptText,
            projectId: projectId || undefined,
            projectSummary,
            model: selectedModel,
            conversationContext,
          }),
        });

        data = await response.json().catch(() => null);

        if (!response.ok) {
          fetchFailed = true;
        }
      } catch (networkErr) {
        fetchFailed = true;
      }

      // Abort alone is insufficient: transports may still resolve after abort.
      // Only the owning request may publish results, errors, or local fallbacks.
      if (!isCurrent()) return;
      assertAssistantBase(getProjectSnapshot(), base);
      if (data?.isInformational) {
        setMessages((prev) => [
          ...prev,
          {
            id: `asst-info-${Date.now()}`,
            role: "assistant",
            text: data.message,
            status: "info",
            timestamp: new Date(),
          },
        ]);
        return;
      }
      if (data?.isClarification) {
        setActiveClarification({
          category: data.category || data.ambiguityType,
          offset: data.offset || 0,
          lastShownOptions: data.options || [],
        });
        const assistantMessage = {
          id: `asst-clar-${Date.now()}`,
          role: "assistant",
          type: "clarification",
          category: data.category || data.ambiguityType,
          text: data.message,
          options: data.options || [],
          hasMore: Boolean(data.hasMore),
          offset: data.offset || 0,
          timestamp: new Date(),
        };
        setMessages((prev) => [...prev, assistantMessage]);
        return;
      }

      // If network/server failed or returned empty plan, try our deterministic natural language parser
      if (fetchFailed || !data?.plan || !Array.isArray(data.plan.actions) || data.plan.actions.length === 0) {
        const localIntent = classifyUserIntent(userPromptText, projectSummary, conversationContext);
        if (localIntent.type === "informational") {
          setMessages((prev) => [
            ...prev,
            {
              id: `asst-info-${Date.now()}`,
              role: "assistant",
              text: localIntent.message,
              status: "info",
              timestamp: new Date(),
            },
          ]);
          return;
        }
        if (["ambiguous", "exploration", "more_options", "unsupported_style", "unsupported_font", "unsupported_effect"].includes(localIntent.type)) {
          const opts = localIntent.clarification?.options || localIntent.options || [];
          const clarCategory = localIntent.category || (localIntent.ambiguityType === "caption_style" ? "style" : localIntent.ambiguityType === "caption_effect" ? "effect" : localIntent.ambiguityType === "active_word_color" ? "color" : "font");
          setActiveClarification({
            category: clarCategory,
            offset: localIntent.offset || 0,
            lastShownOptions: opts,
          });
          const assistantMessage = {
            id: `asst-clar-${Date.now()}`,
            role: "assistant",
            type: "clarification",
            category: clarCategory,
            text: localIntent.clarification?.message || localIntent.message,
            options: opts,
            hasMore: Boolean(localIntent.clarification?.hasMore ?? localIntent.hasMore),
            offset: localIntent.offset || 0,
            timestamp: new Date(),
          };
          setMessages((prev) => [...prev, assistantMessage]);
          return;
        }

        const localParsed = parseNaturalLanguageEditingPlan(userPromptText, projectSummary, conversationContext);
        if (localParsed && Array.isArray(localParsed.actions) && localParsed.actions.length > 0) {
          if (activeClarification) setActiveClarification(null);
          const assistantMessage = {
            id: `asst-${Date.now()}`,
            role: "assistant",
            text: localParsed.explanation || "I've prepared an editing plan for your project.",
            plan: prepareAssistantProposal(localParsed, base, request.id),
            status: "proposed",
            model: selectedModel || "natural-language-engine",
            timestamp: new Date(),
          };

          setMessages((prev) => [...prev, assistantMessage]);
          return;
        }

        if (fetchFailed) {
          const errorMsg =
            data?.error?.message ||
            data?.message ||
            "Failed to connect to AI Assistant. Please ensure the server is running.";
          throw new Error(errorMsg);
        }
      }

      if (data?.isHistoryCommand) {
        if (data.historyAction === "undo") {
          if (typeof onUndo === "function") {
            onUndo();
            notify?.("Undid last action");
            setMessages((prev) => [
              ...prev,
              {
                id: `asst-undo-${Date.now()}`,
                role: "assistant",
                text: "↺ Undid the last action.",
                status: "applied",
                timestamp: new Date(),
              },
            ]);
          } else {
            setError("Undo is not available.");
          }
        } else if (data.historyAction === "redo") {
          if (typeof onRedo === "function") {
            onRedo();
            notify?.("Redid last action");
            setMessages((prev) => [
              ...prev,
              {
                id: `asst-redo-${Date.now()}`,
                role: "assistant",
                text: "↻ Redid the last action.",
                status: "applied",
                timestamp: new Date(),
              },
            ]);
          } else {
            setError("Redo is not available.");
          }
        }
        return;
      }

      if (data?.isUnsupportedCreation) {
        setMessages((prev) => [
          ...prev,
          {
            id: `asst-${Date.now()}`,
            role: "assistant",
            text: data.message || "I am your video editing copilot for imported timeline media. Text-to-video generation from scratch is not supported.",
            status: "info",
            timestamp: new Date(),
          },
        ]);
        return;
      }

      if (data?.isUnsupportedSelectiveUndo) {
        setMessages((prev) => [
          ...prev,
          {
            id: `asst-${Date.now()}`,
            role: "assistant",
            text: data.message || "Selective undo for specific previous operations is not directly supported because timeline edits depend on chronological order. Use Undo to step back, or ask me to change the property to your desired value.",
            status: "info",
            timestamp: new Date(),
          },
        ]);
        return;
      }

      if (!data?.plan || !Array.isArray(data.plan.actions)) {
        throw new Error("Received malformed editing plan from server.");
      }

      const assistantMessage = {
        id: `asst-${Date.now()}`,
        role: "assistant",
        text: data.plan.explanation || "I've prepared an editing plan for your project.",
        plan: prepareAssistantProposal(data.plan, base, request.id),
        status: "proposed",
        model: selectedModel,
        timestamp: new Date(),
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (err) {
      if (!isCurrent()) return;
      const errorMsg = err.message || "Failed to generate plan.";
      setError(errorMsg);
      setMessages((prev) => [
        ...prev,
        {
          id: `asst-err-${Date.now()}`,
          role: "assistant",
          text: `Error: ${errorMsg}`,
          status: "error",
          timestamp: new Date(),
        },
      ]);
    } finally {
      if (planningRef.current === request) {
        planningRef.current = null;
        setLoading(false);
      }
    }
  };

  const handleSelectClarificationOption = async (option, category) => {
    setActiveClarification(null);
    if (!option) return;
    if (category === "style" || option.action === "select_style") {
      await handleExecuteEditingPlan(`Apply ${option.name || option.label} caption style`);
    } else if (category === "font" || option.action === "select_font") {
      await handleExecuteEditingPlan(`Change caption font to ${option.name || option.label || option.fontId}`);
    } else if (category === "effect" || option.action === "select_effect") {
      await handleExecuteEditingPlan(`Apply ${option.name || option.label || option.effect} caption effect`);
    } else if (category === "color" || option.action === "select_color") {
      await handleExecuteEditingPlan(`Change active word color to ${option.color || option.name || option.id}`);
    } else if (category === "filter" || option.action === "select_filter") {
      await handleExecuteEditingPlan(`Apply ${option.filterId || option.id || option.name} filter`);
    } else if (category === "speed_scope" || option.action === "select_speed_scope") {
      if (option.scope === "all") {
        await handleExecuteEditingPlan("Make all clips faster");
      } else {
        await handleExecuteEditingPlan("Make this clip faster");
      }
    } else if (option.prompt) {
      await handleExecuteEditingPlan(option.prompt);
    }
  };

  const handleShowMoreClarificationOptions = async (category) => {
    const text = category === "style" ? "Show more styles" : category === "font" ? "Show more fonts" : "Show more options";
    await handleExecuteEditingPlan(text);
  };

  const handleGeneratePlan = async (e) => {
    e?.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed && attachments.length === 0) {
      setError("Please enter a request or attach reference media.");
      return;
    }
    if (trimmed.length > 5000) {
      setError("Prompt exceeds maximum length of 5000 characters.");
      return;
    }

    cancelPlanning();
    const currentAttachments = [...attachments];
    const userMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      text: trimmed || (currentAttachments.length > 0 ? "Edit video using attached reference media" : ""),
      attachments: currentAttachments,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setPrompt("");
    setAttachments([]);
    setError(null);

    // Detect user intent safely
    const conversationContext = activeClarification ? { activeClarification } : {};
    const intent = classifyUserIntent(trimmed || "Edit video using attached reference media", projectSummary, conversationContext);

    // Explicit new video creation detection (retired feature)
    if (
      intent.type === "unsupported_creation" ||
      (!hasClips &&
        /\b(?:create|generate|make|produce|build)\b/i.test(trimmed) &&
        /\b(?:video|reel|short|documentary|story|promo|montage|film)\b/i.test(trimmed) &&
        !/\b(?:caption|marker|ratio|aspect|canvas)\b/i.test(trimmed))
    ) {
      const explanation =
        intent.message ||
        "I am your natural-language editing copilot for imported media on your timeline. I can split, trim, reorder, adjust playback speed, apply visual filters and color grades, duck audio, add transitions, and style captions on your existing clips. Text-to-video generation from scratch is not supported.";
      setMessages((prev) => [
        ...prev,
        {
          id: `asst-unsupported-${Date.now()}`,
          role: "assistant",
          text: explanation,
          status: "info",
          timestamp: new Date(),
        },
      ]);
      return;
    }

    if (intent.type === "unsupported_selective_undo") {
      setMessages((prev) => [
        ...prev,
        {
          id: `asst-undo-info-${Date.now()}`,
          role: "assistant",
          text:
            intent.message ||
            "Selective undo for individual previous operations is not supported directly, as timeline changes depend on chronological sequence. You can use standard Undo to step backward, or ask me to adjust the property to your preferred setting.",
          status: "info",
          timestamp: new Date(),
        },
      ]);
      return;
    }

    if (intent.type === "undo") {
      if (typeof onUndo === "function") {
        onUndo();
        notify?.("Undid last action");
        setMessages((prev) => [
          ...prev,
          {
            id: `asst-undo-${Date.now()}`,
            role: "assistant",
            text: "↺ Undid the last action.",
            status: "applied",
            timestamp: new Date(),
          },
        ]);
      } else {
        setError("Undo is not available.");
      }
      return;
    }

    if (intent.type === "redo") {
      if (typeof onRedo === "function") {
        onRedo();
        notify?.("Redid last action");
        setMessages((prev) => [
          ...prev,
          {
            id: `asst-redo-${Date.now()}`,
            role: "assistant",
            text: "↻ Redid the last action.",
            status: "applied",
            timestamp: new Date(),
          },
        ]);
      } else {
        setError("Redo is not available.");
      }
      return;
    }

    if (intent.type === "smart_zoom_inspection") {
      const snapshot = getProjectSnapshot();
      const report = inspectPunchIns(snapshot);
      let text = "";
      if (report.count === 0) {
        text = "No punch-ins have been added to the project yet. You can ask me to add punch-ins at speech moments or at specific timestamps.";
      } else {
        const details = report.punchIns.map((p, i) => `${i + 1}. Clip "${p.clipName || p.clipId}" at ${p.timelineTime}s (${Math.round((p.scale - 1) * 100)}% zoom, ${p.transition} cut${p.faceAnchored ? ", face-centered" : ""})`).join("\n");
        text = `Found ${report.count} punch-in${report.count === 1 ? "" : "s"} on the timeline:\n${details}`;
      }
      setMessages((prev) => [
        ...prev,
        {
          id: `asst-inspect-${Date.now()}`,
          role: "assistant",
          text,
          status: "info",
          timestamp: new Date(),
        },
      ]);
      return;
    }

    if (intent.type === "ambiguous") {
      if (
        intent.ambiguityType === "caption_style" ||
        intent.ambiguityType === "caption_effect" ||
        intent.ambiguityType === "caption_font" ||
        intent.ambiguityType === "cinematic_look" ||
        intent.ambiguityType === "speed_scope"
      ) {
        const opts = intent.clarification?.options || intent.options || [];
        const clarCategory =
          intent.category ||
          (intent.ambiguityType === "caption_style"
            ? "style"
            : intent.ambiguityType === "caption_effect"
              ? "effect"
              : intent.ambiguityType === "caption_font"
                ? "font"
                : intent.ambiguityType === "speed_scope"
                  ? "speed_scope"
                  : "filter");
        setActiveClarification({
          category: clarCategory,
          offset: intent.offset || 0,
          lastShownOptions: opts,
        });
        const assistantMessage = {
          id: `asst-clar-${Date.now()}`,
          role: "assistant",
          type: "clarification",
          category: clarCategory,
          text: intent.clarification?.message || intent.message || "Please choose one of the options below:",
          options: opts,
          hasMore: Boolean(intent.clarification?.hasMore ?? intent.hasMore),
          offset: intent.offset || 0,
          timestamp: new Date(),
        };
        setMessages((prev) => [...prev, assistantMessage]);
        return;
      }
      const clarificationText =
        (typeof intent.clarification === "string"
          ? intent.clarification
          : intent.clarification?.message) ||
        "Could you please clarify which clips or edits you'd like to apply?";

      const assistantMessage = {
        id: `asst-ambig-${Date.now()}`,
        role: "assistant",
        type: "ambiguous",
        ambiguityType: intent.ambiguityType || "editing_clarification",
        candidateClips: intent.candidateClips || [],
        promptText: trimmed,
        intentParams: intent.extractedParams || intent.params || {},
        attachments: currentAttachments,
        text: clarificationText,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, assistantMessage]);
      return;
    }

    if (intent.type === "option_selected") {
      setActiveClarification(null);
      const sel = intent.selectedOption;
      if (sel) {
        if (intent.category === "style" || sel.action === "select_style") {
          await handleExecuteEditingPlan(`Apply ${sel.name || sel.label} caption style`);
          return;
        }
        if (intent.category === "font" || sel.action === "select_font") {
          await handleExecuteEditingPlan(`Change caption font to ${sel.name || sel.label || sel.fontId}`);
          return;
        }
        if (intent.category === "filter" || sel.action === "select_filter") {
          await handleExecuteEditingPlan(`Apply ${sel.filterId || sel.id || sel.name} filter`);
          return;
        }
        if (intent.category === "speed_scope" || sel.action === "select_speed_scope") {
          if (sel.scope === "all") {
            await handleExecuteEditingPlan("Make all clips faster");
          } else {
            await handleExecuteEditingPlan("Make this clip faster");
          }
          return;
        }
      }
    }

    if (["exploration", "more_options", "unsupported_style", "unsupported_font"].includes(intent.type)) {
      await handleExecuteEditingPlan(trimmed);
      return;
    }

    // Default: editing intent
    await handleExecuteEditingPlan(trimmed);
  };

  const handleApplyApprovedPlan = async (msgId, plan) => {
    if (!plan || !plan.actions?.length || executionRef.current || attemptedApprovalsRef.current.has(plan.approvalId)) return;
    const execution = { controller: new AbortController(), transcription: captureTranscriptionPreferences() };
    executionRef.current = execution;
    attemptedApprovalsRef.current.add(plan.approvalId);
    setApplyingPlanId(msgId);
    setError(null);

    try {
      const rawActions = Array.isArray(plan.actions) ? plan.actions : [];
      const toolActions = rawActions.filter((a) => a.type?.startsWith("tool."));
      const timelineActions = rawActions.filter((a) => !a.type?.startsWith("tool."));

      const snapshot = getProjectSnapshot();
      assertAssistantBase(snapshot, plan);
      assertDestructiveAssistantTargets(rawActions, snapshot);
      const captionGenAction = rawActions.find((a) => a.type === "tool.generate_captions");
      const workflowActions = toolActions.filter(a => a.type !== "tool.generate_captions");
      if (rawActions.length > 1 && rawActions.some(action => action.type === "track.set_locked")) {
        throw new Error("Request lock changes separately from timeline edits.");
      }
      // Review workflows/export do not expose rollback. Never partially apply a
      // mixed plan containing one; ask for a separate, independently reviewed plan.
      if ((workflowActions.length && rawActions.length !== 1) || toolActions.filter(a => a.type === "tool.generate_captions").length > 1) {
        throw new Error("This plan combines nontransactional tools. Request each review/export workflow separately; no edits were applied.");
      }
      for (const action of rawActions) assertAssistantOperationUnlocked(snapshot, { ...action.params, type: action.type });
      if (captionGenAction && typeof onGenerateCaptions !== "function") throw new Error("Caption generation workflow is not available.");
      const assertCurrent = () => {
        if (execution.controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
        assertAssistantBase(getProjectSnapshot(), plan);
      };
      const stageCaptions = async () => {
        let result;
        try {
          result = await onGenerateCaptions({ ...execution.transcription, stageOnly: true, throwOnError: true, signal: execution.controller.signal });
        } catch (error) {
          execution.transcriptionOutcome = workflowTranscriptionOutcome(error, execution.transcription,
            isTranscriptionCancellation(error, execution.controller.signal) ? "cancelled" : "failed");
          throw error;
        }
        if (execution.controller.signal.aborted) execution.transcriptionOutcome = workflowTranscriptionOutcome(null, execution.transcription, "cancelled");
        assertCurrent();
        if (!result?.segments?.length) {
          execution.transcriptionOutcome = workflowTranscriptionOutcome(null, execution.transcription);
          throw new Error("No speech detected. No assistant edits were applied.");
        }
        execution.transcriptionOutcome = getTranscriptionOutcome(result);
        const captions = attachTranscriptionOutcome(result.segments, result);
        return { ...snapshot, captionSegments: captions, captionsEnabled: true, script: captions.map(c => c.text).join("\n") };
      };

      if (timelineActions.length > 0) {
        const mediaOrigins = {};
        const operations = timelineActions.map((action) => {
          const op = {
            ...action.params,
            id: action.id,
            type: action.type,
          };

          // Resolve target clipId if missing or shorthand
          let targetTrack = "visuals";
          if (
            action.type.startsWith("music.") ||
            action.params?.track === "music" ||
            action.params?.targetTrack === "music" ||
            (action.params?.property === "volume" && /music/i.test(String(action.params?.clipId || "")))
          ) {
            targetTrack = "music";
          } else if (
            action.type.startsWith("audio.") ||
            action.params?.track === "audio" ||
            action.params?.targetTrack === "audio" ||
            (action.params?.property === "volume" && /voice|audio/i.test(String(action.params?.clipId || "")))
          ) {
            targetTrack = "audio";
          }

          if (action.type.startsWith("visual.") || action.type === "transition.set" || action.type === "clip.set_speed") {
            if ((action.type === "visual.punch_in" || action.type === "visual.remove_punch_in" || action.type === "visual.reset_zoom") && (op.clipId === "all" || op.scope === "all" || op.mode === "auto")) {
              op.clipId = "all";
            } else {
              op.clipId = resolveTargetClipId(op.clipId, snapshot, selectedVisualSegmentId || selectedSegmentId || snapshot.visualSegments?.[0]?.id || "", "visuals");
            }
          } else if (action.type === "audio.delete") {
            op.clipId = op.clipId ? resolveTargetClipId(op.clipId, snapshot, op.clipId, "audio") : (selectedAudioSegmentId || selectedSegmentId || (snapshot.audioSegments?.length === 1 ? snapshot.audioSegments[0].id : ""));
          } else if (action.type === "music.delete") {
            op.clipId = op.clipId ? resolveTargetClipId(op.clipId, snapshot, op.clipId, "music") : (snapshot.musicSegments?.length === 1 ? snapshot.musicSegments[0].id : snapshot.musicSegments?.[0]?.id || "");
          } else if (action.type === "clip.set_muted" || action.type === "clip.set_property") {
            const defaultId =
              targetTrack === "music"
                ? (snapshot.musicSegments?.[0]?.id || "")
                : targetTrack === "audio"
                  ? (selectedAudioSegmentId || snapshot.audioSegments?.[0]?.id || "")
                  : (selectedVisualSegmentId || snapshot.visualSegments?.[0]?.id || "");
            op.clipId = resolveTargetClipId(op.clipId, snapshot, defaultId, targetTrack);
          } else if (action.type === "overlay.set_transform" && (!op.clipId || op.clipId === "selected" || op.clipId === "this" || op.clipId === "current")) {
            const overlayTarget =
              (selectedTrack === "overlay" && selectedVisualOverlayId)
                ? selectedVisualOverlayId
                : (snapshot.visualOverlaySegments?.some((o) => o.id === selectedVisualOverlayId) ? selectedVisualOverlayId : "")
                || (snapshot.visualOverlaySegments?.length === 1 ? snapshot.visualOverlaySegments[0].id : snapshot.visualOverlaySegments?.[0]?.id || "");
            op.clipId = overlayTarget;
          }

          if (action.type === "visual.duplicate") {
            if (!op.newClipId) {
              op.newClipId = `${op.clipId}-dup-${action.id}`;
            }
            if (op.newClipId && op.clipId) {
              mediaOrigins[op.newClipId] = { kind: "clip", id: op.clipId };
            }
          }

          if (action.type === "visual.split") {
            if (!op.rightClipId) {
              op.rightClipId = `${op.clipId}-split-${action.id}`;
            }
            if (op.rightClipId && op.clipId) {
              mediaOrigins[op.rightClipId] = { kind: "clip", id: op.clipId };
            }
            const visuals = Array.isArray(snapshot.visualSegments) ? snapshot.visualSegments : [];
            const clipIndex = visuals.findIndex((c) => c.id === op.clipId);
            if (clipIndex >= 0) {
              const targetClip = visuals[clipIndex];
              const clipStart = visuals.slice(0, clipIndex).reduce((sum, c) => sum + (Number(c.duration) || 0), 0);
              const clipDur = Number(targetClip.duration) || 0;
              // If 'at' is not positive finite, calculate relative playhead offset within target clip
              if (!Number.isFinite(op.at) || op.at <= 0) {
                if (Number.isFinite(currentTime) && currentTime > clipStart && currentTime < clipStart + clipDur) {
                  op.at = Number((currentTime - clipStart).toFixed(3));
                } else {
                  op.at = Number((clipDur / 2).toFixed(3));
                }
              } else if (clipStart > 0 && op.at >= clipStart && op.at < clipStart + clipDur && op.at >= clipDur) {
                // op.at was expressed in project/timeline coordinates (between clipStart and clipStart + clipDur)
                op.at = Number((op.at - clipStart).toFixed(3));
              }
            }
          }
          if (action.type === "overlay.add") {
            if (op.clipId && op.sourceClipId) {
              mediaOrigins[op.clipId] = { kind: "clip", id: op.sourceClipId };
            }
          }
          if (action.type === "asset.insert") {
            if (op.clipId && op.assetId) {
              mediaOrigins[op.clipId] = { kind: "asset", id: op.assetId };
            }
          }
          if (action.type === "visual.trim") {
            if (!Number.isFinite(op.sourceOut) && Number.isFinite(op.duration) && op.duration > 0) {
              const sIn = Number.isFinite(op.sourceIn) ? Number(op.sourceIn) : 0;
              op.sourceIn = sIn;
              op.sourceOut = sIn + Number(op.duration);
            }
          }
          if (action.type === "marker.add" && !op.markerId) {
            op.markerId = `marker-${action.id}`;
          }
          if (action.type === "caption.add") {
            const capId = op.clipId || op.captionId || `caption-${action.id}`;
            op.clipId = capId;
            op.captionId = capId;
          }
          if (action.type === "caption.set_position") {
            if (!op.scope) op.scope = op.clipId ? "current" : "default";
            if (op.scope === "default") delete op.clipId;
            if (!op.placement) {
              const placementMap = {
                top: { x: 50, y: 18 },
                middle: { x: 50, y: 50 },
                bottom: { x: 50, y: 78 },
              };
              op.placement = placementMap[op.position] || { x: 50, y: 78 };
            }
          }
          if (action.type === "caption.set_style") {
            if (!op.scope) op.scope = "default";
            if (op.scope === "default") {
              delete op.clipId;
            }
            if (!op.style) {
              op.style = {};
            }
            const styleKeys = [
              "fontId", "captionSize", "textColor", "backgroundColor", "backgroundOpacity",
              "effect", "karaoke", "activeWordColor", "borderColor", "textStrokeColor",
              "borderWidth", "textStrokeWidth", "radius", "paddingX", "paddingY", "shadowOpacity"
            ];
            for (const key of styleKeys) {
              if (op[key] !== undefined && op.style[key] === undefined) {
                op.style[key] = op[key];
              }
            }
          }
          if (action.type === "project.set_ratio") {
            op.ratio = op.ratio || op.ratioId;
          }
          if (action.type === "clip.set_property" && op.property === "volume" && typeof op.value === "number" && op.value > 4 && op.value <= 400) {
            op.value = Number((op.value / 100).toFixed(3));
          }
          return op;
        });

        // Robust batch validation for transitions: skip final clips, gaps, and duplicate transitions safely
        const skippedTransitionNotes = [];
        let appliedTransitionsCount = 0;
        const validOperations = [];

        for (const op of operations) {
          if (op.type === "transition.set") {
            const visuals = Array.isArray(snapshot.visualSegments) ? snapshot.visualSegments : [];
            if (!visuals.length) {
              skippedTransitionNotes.push("No visual clips on timeline");
              continue;
            }
            const clipIndex = visuals.findIndex((c) => c.id === op.clipId);
            if (clipIndex < 0) {
              skippedTransitionNotes.push(`Clip "${op.clipId}" was not found or was removed`);
              continue;
            }
            if (op.transitionId !== "none" && clipIndex >= visuals.length - 1) {
              const clipLabel = visuals[clipIndex].name || visuals[clipIndex].id;
              skippedTransitionNotes.push(`Skipped transition on final clip "${clipLabel}" (transitions require a following clip)`);
              continue;
            }
            if (op.transitionId !== "none" && clipIndex < visuals.length - 1) {
              const curr = visuals[clipIndex];
              const next = visuals[clipIndex + 1];
              if (Number.isFinite(curr.start) && Number.isFinite(next.start)) {
                const currEnd = curr.start + (Number(curr.duration) || 0);
                if (next.start > currEnd + 0.05) {
                  skippedTransitionNotes.push(`Skipped transition between "${curr.name || curr.id}" and "${next.name || next.id}" due to timeline gap`);
                  continue;
                }
              }
              // Prevent duplicate transitions on repeated requests
              if (curr.transition?.id === op.transitionId && (!op.duration || Math.abs((Number(curr.transition.duration) || 0.5) - Number(op.duration)) < 0.01)) {
                skippedTransitionNotes.push(`Skipped duplicate ${op.transitionId} transition on "${curr.name || curr.id}"`);
                continue;
              }
              // Clamp duration to valid maximum so range validation never fails
              const maxDur = Math.max(0.1, Math.min(2, (Number(curr.duration) || 1) / 2, (Number(next.duration) || 1) / 2));
              if (Number.isFinite(op.duration)) {
                op.duration = Number(Math.min(Number(op.duration), maxDur).toFixed(2));
              } else {
                op.duration = Number(Math.min(0.5, maxDur).toFixed(2));
              }
            }
            appliedTransitionsCount++;
            validOperations.push(op);
          } else {
            validOperations.push(op);
          }
        }

        if (captionGenAction && validOperations.length !== operations.length) {
          throw new Error("Caption plans require every timeline action to validate. No edits were applied.");
        }
        if (operations.length > 0 && validOperations.length === 0) {
          const feedbackMsg = skippedTransitionNotes.length
            ? `No transitions applied: ${skippedTransitionNotes.join("; ")}`
            : "No valid actions could be applied to the timeline.";
          notify?.(feedbackMsg);
          setMessages((prev) => [
            ...prev.map((m) => (m.id === msgId ? { ...m, status: "applied" } : m)),
            {
              id: `asst-note-${Date.now()}`,
              role: "assistant",
              text: feedbackMsg,
              status: "applied",
              timestamp: new Date(),
            },
          ]);
          return;
        }

        const commandPlan = {
          schemaVersion: 1,
          baseRevision: plan.baseRevision !== undefined ? plan.baseRevision : (snapshot.commandState?.revision || 0),
          operations: validOperations,
        };

        for (const operation of validOperations) assertAssistantOperationUnlocked(snapshot, operation);
        let testRun = applyCommandPlan(snapshot, commandPlan);
        if (!testRun.ok) {
          if (testRun.code === "REVISION_CONFLICT") {
            throw Object.assign(
              new Error("The project has been modified since this editing plan was proposed. Please review the updated timeline and try again."),
              { code: "BROWSER_EDIT_STALE_PLAN" }
            );
          }
          const isClipError = testRun.code === "CLIP_NOT_FOUND" || String(testRun.message || "").toLowerCase().includes("clip");
          const extraHelp = (!snapshot.visualSegments?.length && isClipError)
            ? " The timeline has no video clips yet. Please add a video clip first, or use project-level actions (e.g. aspect ratio, markers, captions)."
            : "";
          throw new Error(
            `Cannot apply plan: ${testRun.message || testRun.code || "Validation error"}.${extraHelp}`
          );
        }

        assertAssistantChangedTracksUnlocked(snapshot, testRun.project);
        // Reviewed transition no-ops retain their identities in the ledger.
        testRun.project.commandState.appliedOperationIds = [...new Set([...testRun.project.commandState.appliedOperationIds, ...operations.map(operation => operation.id)])];
        if (captionGenAction) {
          const staged = await stageCaptions();
          testRun = applyCommandPlan(staged, commandPlan);
          if (!testRun.ok) throw new Error(`Cannot apply staged caption plan: ${testRun.message || testRun.code}`);
          testRun.project.commandState.appliedOperationIds.push(captionGenAction.id);
          assertAssistantChangedTracksUnlocked(snapshot, testRun.project);
        }
        assertCurrent();
        await onApplyPlan(testRun.project, { ...plan, mediaOrigins }, mediaOrigins);

        if (skippedTransitionNotes.length > 0) {
          setMessages((prev) => [
            ...prev,
            {
              id: `asst-trans-note-${Date.now()}`,
              role: "assistant",
              text: `Applied ${appliedTransitionsCount} transition(s). Notice: ${skippedTransitionNotes.join("; ")}`,
              status: "applied",
              timestamp: new Date(),
            },
          ]);
        }
      }

      if (captionGenAction && timelineActions.length === 0) {
        const staged = await stageCaptions();
        staged.commandState = { ...snapshot.commandState, revision: snapshot.commandState.revision + 1, appliedOperationIds: [...snapshot.commandState.appliedOperationIds, captionGenAction.id] };
        assertAssistantChangedTracksUnlocked(snapshot, staged);
        assertCurrent();
        await onApplyPlan(staged, plan, {});
      }
      let reviewWorkflowResult = null;
      // Only a single nontransactional workflow can reach this dispatch.
      for (const toolAct of toolActions) {
        if (toolAct.type === "tool.generate_captions") {
          continue;
        }
        assertCurrent();
        const toolOp = { ...toolAct.params, type: toolAct.type };
        const callbacks = {
          "tool.scene_detection": onOpenSceneDetection, "tool.silence_removal": onOpenSilenceRemoval,
          "tool.rough_cut": onOpenRoughCut, "tool.smart_pipeline": onOpenSmartPipeline,
          "tool.smart_frame": onToggleSmartFrame, "tool.export": onExportVideo,
        };
        if (typeof callbacks[toolAct.type] !== "function") throw new Error(`Tool unavailable: ${toolAct.type}`);
        if (toolAct.type === "tool.scene_detection") {
          const clipId = resolveTargetClipId(toolOp.clipId, snapshot, selectedVisualSegmentId || snapshot.visualSegments?.[0]?.id);
          await onOpenSceneDetection(clipId);
        } else if (toolAct.type === "tool.silence_removal" || toolAct.type === "tool.rough_cut") {
          const clipId = resolveTargetClipId(toolOp.clipId, snapshot, selectedVisualSegmentId || snapshot.visualSegments?.[0]?.id);
          const label = toolAct.type === "tool.rough_cut" ? "AI Rough Cut" : "Remove Pauses";
          const onApplied = () => {
            setMessages((prev) => prev.map((message) => message.id === msgId ? {
              ...message,
              status: "applied",
              text: `${plan.explanation || message.text || label}\n${label} was applied to the timeline.`,
            } : message));
          };
          const onDismissed = () => {
            setMessages((prev) => prev.map((message) => message.id === msgId ? {
              ...message,
              status: "rejected",
              text: `${plan.explanation || message.text || label}\nReview dismissed. The timeline was not changed.`,
            } : message));
          };
          reviewWorkflowResult = await callbacks[toolAct.type]({
            clipId,
            signal: execution.controller.signal,
            settings: toolAct.type === "tool.rough_cut"
              ? { removeFillerWords: Boolean(toolOp.removeFillerWords) }
              : undefined,
            onApplied,
            onDismissed,
          });
          if (reviewWorkflowResult?.status === "cancelled") {
            const cancelledText = `${label} analysis was cancelled. The timeline was not changed.`;
            setMessages((prev) => prev.map((message) => message.id === msgId ? {
              ...message,
              status: "rejected",
              text: `${plan.explanation || message.text || label}\n${cancelledText}`,
            } : message));
            notify?.(cancelledText);
            return;
          }
          if (reviewWorkflowResult?.status !== "review-ready") {
            const workflowError = {
              busy: `${label} analysis is already running.`,
              locked: `${label} cannot run while the affected track is locked.`,
              unsupported: `${label} requires a supported video clip with usable source media.`,
            }[reviewWorkflowResult?.status] || `${label} analysis failed.`;
            throw new Error(workflowError);
          }
        } else if (toolAct.type === "tool.smart_pipeline") {
          const clipId = resolveTargetClipId(toolOp.clipId, snapshot, selectedVisualSegmentId || snapshot.visualSegments?.[0]?.id);
          await onOpenSmartPipeline(clipId, toolOp);
        } else if (toolAct.type === "tool.smart_frame") {
          await onToggleSmartFrame(toolOp.enabled);
        } else if (toolAct.type === "tool.export") {
          await onExportVideo(toolOp);
        }
      }

      if (reviewWorkflowResult) {
        const candidateText = reviewWorkflowResult.candidateCount === 1
          ? "1 candidate is ready"
          : `${reviewWorkflowResult.candidateCount || 0} candidates are ready`;
        const reviewText = `${candidateText} for review. The timeline is unchanged until you confirm Apply in the Smart panel.`;
        notify?.(reviewText);
        setMessages((prev) => prev.map((message) => message.id === msgId ? {
          ...message,
          status: "review-ready",
          text: `${plan.explanation || message.text || "Smart analysis complete."}\n${reviewText}`,
        } : message));
        return;
      }

      const captionCompletion = execution.transcriptionOutcome
        ? `Captions applied — ${editorTranscriptionStatus(execution.transcriptionOutcome)}` : null;
      notify?.(captionCompletion || plan.explanation || "Applied AI editing plan");

      setMessages((prev) =>
        prev.map((m) =>
          m.id === msgId ? {
            ...m, status: "applied", ...(captionCompletion ? {
              transcriptionOutcome: execution.transcriptionOutcome,
              text: `${m.text || plan.explanation || "Applied AI editing plan"}\n${captionCompletion}`,
            } : {})
          } : m
        )
      );
    } catch (err) {
      if (execution.controller.signal.aborted) {
        if (execution.transcriptionOutcome?.status === "cancelled") {
          const text = editorTranscriptionStatus(execution.transcriptionOutcome);
          setMessages(prev => prev.map(m => m.id === msgId ? { ...m, status: "error", text, transcriptionOutcome: execution.transcriptionOutcome } : m));
          notify?.(text);
        }
        return;
      }
      setMessages(prev => prev.map(m => m.id === msgId ? { ...m, status: "error" } : m));
      console.error("[AiAssistantPanel] Failed to apply plan:", err);
      const transcriptionFailure = execution.transcriptionOutcome && execution.transcriptionOutcome.status !== "succeeded"
        ? execution.transcriptionOutcome : null;
      const errorMsg = transcriptionFailure ? editorTranscriptionStatus(transcriptionFailure) : err.message || "Failed to apply plan to timeline.";
      setError(errorMsg);
      setMessages((prev) => [
        ...prev,
        {
          id: `asst-err-${Date.now()}`,
          role: "assistant",
          text: `Failed to apply plan: ${errorMsg}`,
          status: "error",
          ...(transcriptionFailure ? { transcriptionOutcome: transcriptionFailure } : {}),
          timestamp: new Date(),
        },
      ]);
      notify?.(`Error: ${errorMsg}`);
    } finally {
      if (executionRef.current === execution) executionRef.current = null;
      setApplyingPlanId(null);
    }
  };

  const handleRejectPlan = (msgId) => {
    const proposal = messages.find(message => message.id === msgId)?.plan;
    if (proposal) attemptedApprovalsRef.current.add(proposal.approvalId);
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId ? { ...m, status: "rejected" } : m
      )
    );
    notify?.("Editing plan discarded. Timeline remains unchanged.");
  };

  const handleClearHistory = () => {
    cancelPlanning();
    executionRef.current?.controller.abort();
    setActiveClarification(null);
    setMessages([]);
    setError(null);
    setPrompt("");
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleGeneratePlan(e);
    }
  };

  return (
    <aside
      id="ai-assistant-panel"
      className={`ai-assistant-panel ${isExpanded ? "is-expanded" : "is-collapsed"}`}
      aria-label="Natural-Language AI Assistant Workspace"
      aria-hidden={!isExpanded}
      data-testid="ai-assistant-panel"
      onKeyDown={(e) => {
        if (e.key === "Escape" && isExpanded) {
          e.stopPropagation();
          onToggleCollapse?.();
        }
      }}
    >
      {/* Compatibility container for modal queries */}
      <div
        data-testid="ai-assistant-modal"
        className="ai-assistant-modal-compat"
        style={{ display: "contents" }}
      >
        {/* Persistent Dock Header */}
        <div className="ai-assistant-panel-header">
          <div className="ai-assistant-panel-brand">
            <div className="ai-assistant-panel-sparkle">
              <Sparkle size={16} weight="fill" />
            </div>
            <div className="ai-assistant-panel-titles">
              <h3 className="ai-assistant-panel-title">AI Assistant</h3>
              <span className="ai-assistant-panel-subtitle">Natural-Language Editor</span>
            </div>
          </div>

          <div className="ai-assistant-panel-header-actions">
            {messages.length > 0 && (
              <button
                type="button"
                className="ai-assistant-panel-icon-btn"
                onClick={handleClearHistory}
                title="Clear Conversation"
                aria-label="Clear Conversation"
              >
                <ArrowCounterClockwise size={15} />
              </button>
            )}

            <button
              type="button"
              className="ai-assistant-panel-collapse-btn ai-assistant-panel-minimize-btn"
              onClick={onToggleCollapse}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onToggleCollapse?.();
                }
              }}
              aria-label={isExpanded ? "Minimize AI Assistant" : "Expand AI Assistant"}
              title={isExpanded ? "Minimize AI Assistant (Esc or Click)" : "Expand AI Assistant"}
              data-testid="ai-assistant-collapse-btn"
            >
              {isExpanded ? <Minus size={16} weight="bold" /> : <CaretLeft size={16} weight="bold" />}
            </button>
          </div>
        </div>

        <div className="ai-assistant-panel-body">
          {/* Model selection toolbar */}
          <div className="ai-assistant-model-strip">
            <label htmlFor="ai-assistant-model-select" className="ai-assistant-model-label">
              Model:
            </label>
            <select
              id="ai-assistant-model-select"
              className="ai-assistant-model-select"
              data-testid="ai-assistant-model-select"
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              disabled={loading}
            >
              {AVAILABLE_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} ({m.id}){m.recommended ? " — Recommended" : ""}
                </option>
              ))}
            </select>
          </div>

          {/* Context pill & Timeline guidance */}
          <div className="ai-assistant-context-banner" data-testid="ai-assistant-context-pill">
            <Info size={14} className="ai-assistant-context-icon" />
            <span className="ai-assistant-context-text">
              {(() => {
                if (!projectSummary || !hasAnyContent) {
                  return `Context: Empty timeline (0 clips) · ${projectSummary?.ratio || "16:9"}`;
                }
                const parts = [];
                if (visualCount > 0) {
                  parts.push(`${visualCount} clip${visualCount > 1 ? "s" : ""}`);
                } else {
                  parts.push("0 visual clips");
                }
                if (projectSummary.duration > 0) {
                  parts.push(`${projectSummary.duration}s`);
                }
                parts.push(projectSummary.ratio || "16:9");
                if (captionsCount > 0) {
                  parts.push(`${captionsCount} caption${captionsCount > 1 ? "s" : ""}`);
                }
                if (audioCount > 0) {
                  parts.push(`${audioCount} voiceover`);
                }
                if (musicCount > 0) {
                  parts.push(`${musicCount} music`);
                }
                if (markersCount > 0) {
                  parts.push(`${markersCount} marker${markersCount > 1 ? "s" : ""}`);
                }
                return `Context: ${parts.join(" · ")}`;
              })()}
            </span>
          </div>

          {!hasClips && (
            <div className="ai-assistant-empty-notice" data-testid="ai-assistant-empty-notice">
              <Sparkle size={13} className="ai-assistant-empty-icon" />
              <span>
                {hasOtherContent ? (
                  <>
                    <strong>Visual Track Empty:</strong> Timeline contains active{" "}
                    {[
                      captionsCount > 0 ? `${captionsCount} caption${captionsCount > 1 ? "s" : ""}` : "",
                      audioCount > 0 ? `${audioCount} voiceover clip${audioCount > 1 ? "s" : ""}` : "",
                      musicCount > 0 ? `${musicCount} background music track` : "",
                    ].filter(Boolean).join(" and ")}. You can style or edit captions, aspect ratio, or audio. Video clip editing (split, trim) requires video on the timeline.
                  </>
                ) : (
                  <>
                    <strong>Empty Project:</strong> Configure aspect ratio, caption styling, and markers. Clip editing (split, trim) requires video on the timeline.
                  </>
                )}
              </span>
            </div>
          )}

          {error && (
            <div className="ai-assistant-error-banner" role="alert">
              <Warning size={16} weight="bold" />
              <span>{error}</span>
            </div>
          )}

          {/* Chat Stream / Messages list */}
          <div className="ai-assistant-stream" data-testid="ai-assistant-messages">
            {messages.length === 0 ? (
              <div className="ai-assistant-empty-state">
                <div className="ai-assistant-empty-hero">
                  <div className="ai-assistant-hero-glow">
                    <Sparkle size={28} weight="fill" color="#818cf8" />
                  </div>
                  <h4>How can I help with your video?</h4>
                  <p>Describe cuts, aspect ratio changes, caption styles, filters, or markers in plain language.</p>
                </div>

                <div className="ai-assistant-suggestions-section">
                  <span className="ai-assistant-suggestions-header">Quick Suggestions:</span>
                  <div className="ai-assistant-chips">
                    {activeSuggestions.map((s, idx) => (
                      <button
                        key={idx}
                        type="button"
                        className="ai-assistant-chip"
                        onClick={() => {
                          setPrompt(s);
                          textareaRef.current?.focus();
                        }}
                        disabled={loading}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`ai-assistant-message is-${msg.role}`}
                >
                  {msg.role === "user" ? (
                    <div className="ai-assistant-user-bubble">
                      <p>{msg.text}</p>
                      {msg.attachments?.length > 0 && (
                        <div className="ai-assistant-msg-attachments">
                          {msg.attachments.map((att) => (
                            <div key={att.id} className="ai-assistant-msg-att-pill">
                              {att.kind === "video" ? <VideoCamera size={12} /> : <ImageSquare size={12} />}
                              <span className="ai-assistant-msg-att-name">{att.name}</span>
                              <span className="ai-assistant-msg-att-role">({att.role || "reference"})</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : msg.type === "clarification" ? (
                    <div className="ai-assistant-clarification-card" data-testid="ai-assistant-clarification-card">
                      <div className="ai-assistant-card-header">
                        <div
                          className="ai-assistant-card-badge"
                          style={{
                            background: "rgba(129, 140, 248, 0.15)",
                            color: "#818cf8",
                            borderColor: "rgba(129, 140, 248, 0.3)",
                          }}
                        >
                          <Sparkle size={14} weight="fill" />
                          <span>{msg.category === "font" ? "Font Options" : msg.category === "filter" ? "Filter Options" : msg.category === "speed_scope" ? "Speed Scope" : "Style Options"}</span>
                        </div>
                      </div>
                      <p className="ai-assistant-explanation-text">{msg.text}</p>
                      {Array.isArray(msg.options) && msg.options.length > 0 && (
                        <div className="ai-assistant-choice-buttons" data-testid="ai-assistant-clarification-options">
                          {msg.options.map((opt, idx) => (
                            <button
                              key={opt.id || idx}
                              type="button"
                              className="ai-assistant-btn-secondary"
                              onClick={() => handleSelectClarificationOption(opt, msg.category)}
                              data-testid={`ai-assistant-clarification-option-${idx + 1}`}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                padding: "8px 12px",
                                textAlign: "left",
                                fontSize: 13,
                              }}
                            >
                              <span style={{ fontWeight: 500, fontFamily: msg.category === "font" && opt.id !== "default" ? opt.name : "inherit" }}>
                                {idx + 1}. {opt.name || opt.label}
                              </span>
                              <span style={{ fontSize: 11, opacity: 0.6 }}>
                                Select
                              </span>
                            </button>
                          ))}
                          {msg.hasMore && (
                            <button
                              type="button"
                              className="ai-assistant-btn-secondary"
                              onClick={() => handleShowMoreClarificationOptions(msg.category)}
                              data-testid="ai-assistant-show-more-btn"
                              style={{
                                marginTop: 4,
                                padding: "6px 12px",
                                fontSize: 12,
                                color: "#818cf8",
                                borderColor: "rgba(129, 140, 248, 0.3)",
                              }}
                            >
                              <span>Show more {msg.category === "style" ? "styles" : "fonts"} →</span>
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  ) : msg.type === "ambiguous" ? (
                    <div className="ai-assistant-ambiguous-card" data-testid="ai-assistant-ambiguous-card">
                      <div className="ai-assistant-card-header">
                        <div
                          className="ai-assistant-card-badge"
                          style={{
                            background: "rgba(234, 179, 8, 0.15)",
                            color: "#eab308",
                            borderColor: "rgba(234, 179, 8, 0.3)",
                          }}
                        >
                          <Sparkle size={14} weight="fill" />
                          <span>Clarification Needed</span>
                        </div>
                      </div>
                      <p className="ai-assistant-explanation-text">{msg.text}</p>
                      {msg.ambiguityType === "clip_target" && msg.candidateClips?.length > 0 ? (
                        <div
                          className="ai-assistant-clip-target-choices"
                          data-testid="ai-assistant-clip-target-choices"
                          style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}
                        >
                          {msg.candidateClips.map((clip) => (
                            <button
                              key={clip.id}
                              type="button"
                              className="ai-assistant-btn-secondary"
                              onClick={() => handleExecuteEditingPlan(`${msg.promptText} on clip ${clip.index + 1}`)}
                              data-testid={`ai-assistant-clip-choice-${clip.id}`}
                              style={{ fontSize: 12, padding: "6px 10px" }}
                            >
                              Clip {clip.index + 1}{clip.name ? `: ${clip.name}` : ""} ({clip.duration?.toFixed(1) || "?"}s)
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="ai-assistant-choice-buttons">
                          <button
                            type="button"
                            className="ai-assistant-btn-primary"
                            onClick={() => handleExecuteEditingPlan(msg.promptText)}
                            data-testid="ai-assistant-choose-edit-btn"
                          >
                            <Scissors size={14} weight="fill" />
                            <span>Apply Edits to Timeline</span>
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="ai-assistant-card">
                      <div className="ai-assistant-card-header">
                        <div className="ai-assistant-card-badge">
                          <Sparkle size={14} weight="fill" />
                          <span>AI Plan</span>
                        </div>
                        {msg.model && (
                          <span className="ai-assistant-model-pill">{msg.model}</span>
                        )}
                      </div>

                      <p className="ai-assistant-explanation-text">{msg.text}</p>

                      {msg.plan && (
                        <div className="ai-assistant-plan-details">
                          {msg.plan.destructive && (
                            <div
                              className="ai-assistant-destructive-warning"
                              data-testid="ai-assistant-destructive-warning"
                              style={{
                                background: "rgba(239, 68, 68, 0.15)",
                                border: "1px solid rgba(239, 68, 68, 0.35)",
                                borderRadius: 8,
                                padding: "8px 12px",
                                color: "#fca5a5",
                                fontSize: 13,
                                marginBottom: 8,
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                              }}
                            >
                              <Warning size={16} weight="bold" color="#ef4444" />
                              <span>Caution: This plan contains destructive operations (deleting or replacing media). Please confirm before applying.</span>
                            </div>
                          )}

                          {msg.plan.prerequisites?.length > 0 && (
                            <div className="ai-assistant-prerequisites-banner">
                              <Warning size={14} weight="bold" />
                              <div>
                                <strong>Prerequisites:</strong>
                                <ul>
                                  {msg.plan.prerequisites.map((p, idx) => (
                                    <li key={idx}>{p}</li>
                                  ))}
                                </ul>
                              </div>
                            </div>
                          )}

                          {msg.plan.warnings?.length > 0 && (
                            <div className="ai-assistant-warnings-box">
                              <Warning size={14} />
                              <div>{msg.plan.warnings.join(" ")}</div>
                            </div>
                          )}

                          <div
                            className="ai-assistant-actions-list"
                            data-testid="ai-assistant-actions-list"
                          >
                            <span className="ai-assistant-actions-count">
                              Proposed Actions ({msg.plan.actions.length}):
                            </span>
                            {msg.plan.actions.length === 0 ? (
                              <p style={{ margin: "6px 0", fontSize: 13, color: "var(--text-muted, #94a3b8)" }}>
                                No timeline edits proposed for this request.
                              </p>
                            ) : (
                              msg.plan.actions.map((act, actIdx) => {
                                const meta = formatActionType(act.type);
                                const Icon = meta.icon;
                                return (
                                  <div key={actIdx} className="ai-assistant-action-row">
                                    <div
                                      className="ai-assistant-action-badge"
                                      style={{ color: meta.color }}
                                    >
                                      <Icon size={13} weight="bold" />
                                      <span>{meta.label}</span>
                                    </div>
                                    <div className="ai-assistant-action-params">
                                      {formatActionParams(act.type, act.params)}
                                    </div>
                                  </div>
                                );
                              })
                            )}
                          </div>

                          {/* Approval and Rejection Controls */}
                          {msg.status === "proposed" && (
                            <div className="ai-assistant-plan-actions">
                              {msg.plan.actions.length === 0 ? (
                                <button
                                  type="button"
                                  className="ai-assistant-btn-secondary"
                                  onClick={() => handleRejectPlan(msg.id)}
                                  data-testid="ai-assistant-reject-btn"
                                >
                                  Dismiss
                                </button>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    className="ai-assistant-btn-secondary"
                                    onClick={() => handleRejectPlan(msg.id)}
                                    disabled={Boolean(applyingPlanId)}
                                    data-testid="ai-assistant-reject-btn"
                                  >
                                    Reject
                                  </button>
                                  <button
                                    type="button"
                                    className="ai-assistant-btn-primary"
                                    onClick={() => handleApplyApprovedPlan(msg.id, msg.plan)}
                                    disabled={Boolean(applyingPlanId)}
                                    data-testid="ai-assistant-apply-btn"
                                  >
                                    {applyingPlanId === msg.id ? (
                                      <>
                                        <CircleNotch size={14} className="ai-assistant-spinner" />
                                        <span>Applying...</span>
                                      </>
                                    ) : msg.plan.destructive ? (
                                      <>
                                        <Warning size={14} weight="bold" color="#fca5a5" />
                                        <span>Confirm & Apply ({msg.plan.actions.length})</span>
                                      </>
                                    ) : (
                                      <>
                                        <CheckCircle size={14} weight="fill" />
                                        <span>Approve & Apply ({msg.plan.actions.length})</span>
                                      </>
                                    )}
                                  </button>
                                </>
                              )}
                            </div>
                          )}

                          {msg.status === "review-ready" && (
                            <div className="ai-assistant-status-tag is-review-ready">
                              <CheckCircle size={14} />
                              <span>Ready for review — timeline unchanged</span>
                            </div>
                          )}

                          {msg.status === "applied" && (
                            <div className="ai-assistant-status-tag is-applied">
                              <CheckCircle size={14} weight="fill" />
                              <span>Applied to timeline</span>
                            </div>
                          )}

                          {msg.status === "rejected" && (
                            <div className="ai-assistant-status-tag is-rejected">
                              <X size={14} />
                              <span>Plan discarded</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))
            )}

            {loading && (
              <div className="ai-assistant-message is-assistant">
                <div className="ai-assistant-card is-loading">
                  <div className="ai-assistant-loading-indicator">
                    <CircleNotch size={16} className="ai-assistant-spinner" />
                    <span>Analyzing project & preparing editing plan...</span>
                  </div>
                </div>
              </div>
            )}

            <div ref={messageEndRef} />
          </div>

          {/* Prompt Input Form at bottom of panel */}
          <form onSubmit={handleGeneratePlan} className="ai-assistant-input-tray">
            {/* Attachment Preview Tray if files are attached */}
            {attachments.length > 0 && (
              <div className="video-gen-attachments-tray ai-assistant-attachments-tray" data-testid="video-gen-attachments-tray">
                <div className="video-gen-attachments-label">
                  <span>Attached Media ({attachments.length}):</span>
                </div>
                <div className="video-gen-attachments-list">
                  {attachments.map((att) => (
                    <div
                      key={att.id}
                      className="video-gen-attachment-card"
                      data-testid="video-gen-attachment-item"
                    >
                      <div className="video-gen-attachment-thumb">
                        {att.kind === "video" ? (
                          <video src={att.blobUrl} className="video-gen-thumb-media" muted preload="metadata" />
                        ) : (
                          <img src={att.blobUrl} alt={att.name} className="video-gen-thumb-media" />
                        )}
                      </div>
                      <div className="video-gen-attachment-info">
                        <span className="video-gen-attachment-name" title={att.name}>
                          {att.name}
                        </span>
                        <div className="video-gen-attachment-meta">
                          <span>{formatFileSize(att.size)}</span>
                        </div>
                      </div>
                      <button
                        type="button"
                        className="video-gen-attachment-remove"
                        onClick={() => handleRemoveAttachment(att.id)}
                        title="Remove attachment"
                        data-testid="video-gen-attachment-remove"
                      >
                        <Trash size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Hidden File Inputs */}
            <input
              type="file"
              ref={imageInputRef}
              accept="image/jpeg,image/png,image/webp"
              multiple
              onChange={handleImageUpload}
              style={{ display: "none" }}
              data-testid="video-gen-image-file-input"
            />
            <input
              type="file"
              ref={videoInputRef}
              accept="video/mp4,video/webm,video/quicktime"
              onChange={handleVideoUpload}
              style={{ display: "none" }}
              data-testid="video-gen-video-file-input"
            />

            <div className="ai-assistant-textarea-wrapper">
              <textarea
                ref={textareaRef}
                id="ai-assistant-prompt-input"
                className="ai-assistant-textarea"
                rows={2}
                placeholder={
                  hasClips
                    ? "Ask to edit clips, adjust speed, color grade, add captions, duck audio, or add transitions..."
                    : hasOtherContent
                      ? "Ask to edit captions, audio volume, canvas format, or markers..."
                      : "Ask to configure canvas ratio, caption styles, markers, or import video clips..."
                }
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={Boolean(applyingPlanId)}
                maxLength={5000}
                data-testid="ai-assistant-prompt-input"
              />

              <div className="ai-assistant-tray-controls">
                <div className="ai-assistant-tray-tools">
                  <button
                    type="button"
                    className="ai-assistant-composer-tool-btn"
                    onClick={() => imageInputRef.current?.click()}
                    title="Attach reference image (JPEG, PNG, WebP up to 15MB)"
                    disabled={loading}
                    data-testid="video-gen-attach-image-btn"
                  >
                    <ImageSquare size={14} />
                    <span>Add Image</span>
                  </button>
                  <button
                    type="button"
                    className="ai-assistant-composer-tool-btn"
                    onClick={() => videoInputRef.current?.click()}
                    title="Attach reference video (MP4, WebM up to 50MB)"
                    disabled={loading}
                    data-testid="video-gen-attach-video-btn"
                  >
                    <VideoCamera size={14} />
                    <span>Add Video</span>
                  </button>
                </div>

                <div className="ai-assistant-tray-actions">
                  {loading && <button type="button" onClick={cancelPlanning} data-testid="ai-assistant-cancel-btn" title="Stop waiting for this plan; provider processing or billing may continue">Cancel planning</button>}
                  <span className="ai-assistant-char-counter">{prompt.length}/5000</span>
                  <button
                    type="submit"
                    className="ai-assistant-send-btn"
                    disabled={Boolean(applyingPlanId) || (!prompt.trim() && attachments.length === 0)}
                    data-testid="ai-assistant-generate-btn"
                    title="Send message (Enter)"
                  >
                    {loading ? (
                      <CircleNotch size={16} className="ai-assistant-spinner" />
                    ) : (
                      <PaperPlaneRight size={16} weight="fill" />
                    )}
                  </button>
                </div>
              </div>
            </div>
          </form>
        </div>
      </div>
    </aside>
  );
}
