import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  Sparkle,
  X,
  CircleNotch,
  CheckCircle,
  Warning,
  FilmSlate,
  MusicNote,
  Microphone,
  ClosedCaptioning,
  ArrowRight,
  ArrowLeft,
  Sliders,
  ImageSquare,
  VideoCamera,
  Trash,
} from "@phosphor-icons/react";
import { VOICES } from "../config/editor.js";
import {
  extractDuration,
  extractAspectRatio,
  extractStyle,
} from "../lib/intentClassifier.js";
import {
  acquireSceneAssets,
  generateNarrationAudio,
  generateMusicAudio,
  assembleGeneratedProject,
} from "../lib/videoGeneratorAssembler.js";
import "./AiVideoGeneratorModal.css";

const MAX_IMAGE_SIZE = 15 * 1024 * 1024; // 15MB
const MAX_VIDEO_SIZE = 50 * 1024 * 1024; // 50MB
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime"];

export const EXAMPLE_PROMPTS = [
  {
    label: "☕ Specialty Coffee Ad",
    text: "Create a 30-second premium coffee advertisement using my product photo. Show coffee being poured, use warm cinematic lighting, include subtle background music, and finish with a clear product shot.",
    duration: 30,
    ratio: "9:16",
    style: "cinematic",
  },
  {
    label: "🏔️ Swiss Alps Travel Reel",
    text: "Create a 30-second cinematic travel video about the Swiss Alps for Instagram Reels, 9:16 vertical, with six scenic scenes, titles, music, and narration.",
    duration: 30,
    ratio: "9:16",
    style: "nature",
  },
  {
    label: "🚀 AI Tech Innovation",
    text: "Create a 30-second fast-paced futuristic tech video exploring artificial intelligence transforming creative work. 9:16 vertical, tech style, vibrant synth music, and neon captions.",
    duration: 30,
    ratio: "9:16",
    style: "tech",
  },
];

export function extractAudioPreferences(text) {
  if (!text) return { narration: true, music: true };
  const lower = text.toLowerCase();
  let narration = true;
  let music = true;
  if (/\b(?:no\s+voiceover|no\s+narration|without\s+voiceover|without\s+narration|silent\s+video)\b/i.test(lower)) {
    narration = false;
  }
  if (/\b(?:no\s+music|without\s+music|silent\s+background)\b/i.test(lower)) {
    music = false;
  }
  return { narration, music };
}

export function formatFileSize(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AiVideoGenerator({
  isOpen = true,
  embedded = false,
  initialPrompt = "",
  initialDuration = 30,
  initialAspectRatio = "16:9",
  initialStyle = "cinematic",
  initialAttachments = [],
  onClose,
  onBackToChat,
  onApplyGeneratedProject,
  onProjectReady,
  userAssets = [],
  notify,
}) {
  // Step: 1 (Conversational Brief & Chat) | 2 (Storyboard Review) | 3 (Assembling) | 4 (Ready)
  const [step, setStep] = useState(1);

  // Conversational Brief & Settings state
  const [prompt, setPrompt] = useState(initialPrompt || EXAMPLE_PROMPTS[0]?.prompt || "");
  const [targetDuration, setTargetDuration] = useState(initialDuration || 30);
  const [aspectRatio, setAspectRatio] = useState(initialAspectRatio || "16:9");
  const [hasExplicitRatioSelection, setHasExplicitRatioSelection] = useState(Boolean(initialAspectRatio && initialAspectRatio !== "16:9"));
  const [style, setStyle] = useState(initialStyle || "cinematic");
  const [voiceId, setVoiceId] = useState("af_heart");
  const [enableNarration, setEnableNarration] = useState(true);
  const [enableMusic, setEnableMusic] = useState(true);
  const [enableCaptions, setEnableCaptions] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [captionPreset] = useState("neon");
  const [defaultTransition] = useState("fade");

  // Reference Attachments (Images & Videos)
  const [attachments, setAttachments] = useState(initialAttachments || []);
  const imageInputRef = useRef(null);
  const videoInputRef = useRef(null);

  // Chat message history inside the creative assistant
  const [messages, setMessages] = useState([
    {
      id: "welcome-msg",
      role: "assistant",
      type: "welcome",
      text: "Hi! I'm your AI video creation partner. Tell me what video you'd like to create — describe your concept, attach product photos or reference footage, and I'll direct a complete storyboard with synchronized visuals, voiceover, and soundtrack.",
      timestamp: new Date(),
    },
  ]);
  const messagesEndRef = useRef(null);

  // Pipeline state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [generatedSpec, setGeneratedSpec] = useState(null);
  const [, setGeneratorConfig] = useState(null);
  const [, setConfigStatus] = useState("idle");
  const [assemblyProgress, setAssemblyProgress] = useState({ stage: "idle", progress: 0, message: "" });
  const [assembledProject, setAssembledProject] = useState(null);
  const [isOpeningInEditor, setIsOpeningInEditor] = useState(false);

  const abortControllerRef = useRef(null);
  const isOpeningRef = useRef(false);

  // Sync initial props and reset session state on new prompt
  const prevInitialPromptRef = useRef(initialPrompt);
  useEffect(() => {
    if (initialPrompt && initialPrompt !== prevInitialPromptRef.current) {
      prevInitialPromptRef.current = initialPrompt;
      setPrompt(initialPrompt);
      setGeneratedSpec(null);
      setAssembledProject(null);
      setStep(1);
      setError(null);
      setAssemblyProgress({ stage: "idle", progress: 0, message: "" });
    }
  }, [initialPrompt]);
  useEffect(() => {
    if (initialDuration) setTargetDuration(initialDuration);
  }, [initialDuration]);
  useEffect(() => {
    if (initialAspectRatio) setAspectRatio(initialAspectRatio);
  }, [initialAspectRatio]);
  useEffect(() => {
    if (initialStyle) setStyle(initialStyle);
  }, [initialStyle]);
  const prevAttachmentsRef = useRef(initialAttachments);
  useEffect(() => {
    if (Array.isArray(initialAttachments)) {
      const prev = prevAttachmentsRef.current;
      if (initialAttachments.length === 0 && (!prev || prev.length === 0)) {
        return;
      }
      if (initialAttachments !== prev) {
        prevAttachmentsRef.current = initialAttachments;
        setAttachments(initialAttachments);
      }
    }
  }, [initialAttachments]);

  // Scroll to bottom of chat
  useEffect(() => {
    if (step === 1) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, step, attachments]);

  // Probe generator config capabilities on mount
  useEffect(() => {
    if (!isOpen) return;
    let isMounted = true;
    setConfigStatus("loading");

    fetch("/api/generator/config", { credentials: "include" })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.ok) {
          if (res.status === 401) {
            throw new Error("Authentication required: Please sign in or refresh your session to generate videos.");
          }
          if (res.status === 404) {
            throw new Error("Backend route not found (/api/generator/config).");
          }
          throw new Error(data?.message || `Failed to fetch generator configuration (${res.status})`);
        }
        return data;
      })
      .then((data) => {
        if (isMounted) {
          setGeneratorConfig(data.capabilities || null);
          setConfigStatus("ready");
        }
      })
      .catch((err) => {
        if (isMounted) {
          setConfigStatus("error");
          console.warn("[AiVideoGeneratorModal] Config probe warning:", err.message);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen]);

  if (!isOpen) return null;
  if (!embedded && typeof document === "undefined") return null;

  // Handle image attachment
  const handleImageUpload = (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setError(null);

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
      const isProduct = /product|merch|coffee|bottle|shoe|watch|can|box/i.test(prompt);
      newAttachments.push({
        id: `att-img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        file,
        name: file.name,
        size: file.size,
        type: file.type || "image/png",
        kind: "image",
        blobUrl,
        role: isProduct ? "product" : "image",
      });
    }

    if (newAttachments.length > 0) {
      setAttachments((prev) => [...prev, ...newAttachments]);
    }
    if (e.target) e.target.value = "";
  };

  // Handle video attachment
  const handleVideoUpload = (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setError(null);

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
        role: "alongside", // default role: use alongside generated scenes
        duration: 10,
      });
    }

    if (newAttachments.length > 0) {
      setAttachments((prev) => [...prev, ...newAttachments]);
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

  const handleSelectExample = (ex) => {
    setPrompt(ex.text);
    setTargetDuration(ex.duration);
    setAspectRatio(ex.ratio);
    setHasExplicitRatioSelection(true);
    setStyle(ex.style);
    setError(null);
  };

  // Step 1 -> Step 2: Understand Brief & Generate Video Storyboard
  const handleGenerateSpec = async (e) => {
    e?.preventDefault();
    const cleanPrompt = prompt.trim() || (attachments.length > 0 ? "Create a video using attached media" : (EXAMPLE_PROMPTS[0]?.prompt || "Create a cinematic travel video showcasing natural wonders"));

    // Check for genuinely vague requests (e.g. single word like "video" without attachments)
    const words = cleanPrompt.split(/\s+/).filter(Boolean);
    if (words.length < 3 && attachments.length === 0 && !cleanPrompt.includes(":")) {
      setMessages((prev) => [
        ...prev,
        {
          id: `user-${Date.now()}`,
          role: "user",
          text: cleanPrompt,
          attachments: [],
          timestamp: new Date(),
        },
        {
          id: `asst-clarify-${Date.now()}`,
          role: "assistant",
          type: "clarification",
          text: "I'd love to help direct that video! Could you share a few more details about your concept, product, or target audience? You can also click an inspiration example below or attach reference media.",
          timestamp: new Date(),
        },
      ]);
      return;
    }

    // Extract supported parameters from creative brief
    const detectedDuration = extractDuration(cleanPrompt);
    const detectedRatio = extractAspectRatio(cleanPrompt);
    const detectedStyle = extractStyle(cleanPrompt);
    const audioPref = extractAudioPreferences(cleanPrompt);

    const effectiveDuration = detectedDuration || targetDuration || 30;
    // Explicit UI selection takes precedence over inferred settings.
    const effectiveRatio = hasExplicitRatioSelection
      ? (aspectRatio || "16:9")
      : (detectedRatio || aspectRatio || "16:9");
    const effectiveStyle = detectedStyle || style || "cinematic";
    const effectiveVoice = voiceId || "af_heart";

    // Synchronize to settings
    setTargetDuration(effectiveDuration);
    setAspectRatio(effectiveRatio);
    setStyle(effectiveStyle);
    if (!audioPref.narration) setEnableNarration(false);
    if (!audioPref.music) setEnableMusic(false);

    setLoading(true);
    setError(null);

    // Record user message into chat stream
    const userMsg = {
      id: `user-${Date.now()}`,
      role: "user",
      text: cleanPrompt || "(Created from attached reference assets)",
      attachments: [...attachments],
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, userMsg]);

    try {
      const response = await fetch("/api/generator/spec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          prompt: cleanPrompt || "Video project featuring attached assets",
          targetDuration: effectiveDuration,
          aspectRatio: effectiveRatio,
          style: effectiveStyle,
          voiceId: effectiveVoice,
          referenceAssets: attachments.map((a) => ({
            id: a.id,
            name: a.name,
            type: a.type,
            role: a.role,
          })),
        }),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok || !data?.ok || !data?.spec) {
        if (response.status === 401) {
          throw new Error("Authentication required: Please sign in or refresh your session to generate videos.");
        }
        if (response.status === 404) {
          throw new Error("Route not found (/api/generator/spec). Please ensure backend is running.");
        }
        if (response.status === 429) {
          throw new Error("Rate limit exceeded: Too many requests. Please wait a moment before trying again.");
        }
        throw new Error(data?.message || `Failed to generate video specification (${response.status})`);
      }

      setGeneratedSpec(data.spec);

      // Record assistant acknowledgement in chat stream
      setMessages((prev) => [
        ...prev,
        {
          id: `asst-${Date.now()}`,
          role: "assistant",
          type: "spec_ready",
          text: `I've prepared a ${data.spec.scenes?.length || 0}-scene storyboard for "${data.spec.title}". Format: ${effectiveRatio}, Duration: ${effectiveDuration}s, Style: ${effectiveStyle}. Review the scene breakdown below!`,
          spec: data.spec,
          timestamp: new Date(),
        },
      ]);

      setStep(2); // Move to Storyboard Review
    } catch (err) {
      if (err.name === "TypeError" && err.message?.toLowerCase().includes("fetch")) {
        setError("Network error: Unable to connect to backend server at /api/generator/spec.");
      } else {
        setError(err.message || "Failed to generate video storyboard.");
      }
    } finally {
      setLoading(false);
    }
  };

  // Step 2 -> Step 3: Run Full Pipeline Assembly
  const handleStartAssembly = async () => {
    if (!generatedSpec || loading) return;
    setStep(3); // Assembly Progress
    setLoading(true);
    setError(null);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      // 1. Stage B: Acquire Scene Visual Assets (user reference assets prioritized)
      setAssemblyProgress({
        stage: "acquiring_assets",
        progress: 15,
        message: "Acquiring visual scene footage & integrating references...",
      });

      const sceneAssets = await acquireSceneAssets(generatedSpec.scenes, {
        userAssets,
        referenceAssets: attachments,
        aspectRatio: generatedSpec.aspectRatio,
        style: generatedSpec.style,
        signal: controller.signal,
        onProgress: (p) => {
          setAssemblyProgress({
            stage: "acquiring_assets",
            progress: 15 + ((p.current || 1) / (p.total || 1)) * 35,
            message: p.message,
          });
        },
      });

      // 2. Stage C: Generate Narration Audio
      let narrationData = null;
      if (enableNarration) {
        setAssemblyProgress({
          stage: "generating_audio",
          progress: 55,
          message: "Generating voiceover narration audio...",
        });

        narrationData = await generateNarrationAudio(
          { ...generatedSpec, narration: { ...generatedSpec.narration, voiceId, enabled: true } },
          {
            signal: controller.signal,
            onProgress: (p) => setAssemblyProgress(p),
          }
        );
      }

      // 3. Stage C (Part 2): Generate / Fetch Background Music
      let musicData = null;
      if (enableMusic) {
        setAssemblyProgress({
          stage: "generating_audio",
          progress: 80,
          message: "Preparing background music soundtrack...",
        });

        musicData = await generateMusicAudio(
          { ...generatedSpec, music: { ...generatedSpec.music, enabled: true } },
          {
            signal: controller.signal,
            onProgress: (p) => setAssemblyProgress(p),
          }
        );
      }

      // 4. Verify voiceover generation succeeded when narration was enabled
      if (generatedSpec.narration?.enabled && enableNarration && (!narrationData || !narrationData.blob)) {
        throw new Error("Narration voiceover was enabled but no intelligible voiceover audio could be synthesized.");
      }

      // 5. Stage D & E: Assemble Timeline Tracks
      setAssemblyProgress({
        stage: "assembling",
        progress: 95,
        message: "Assembling timeline video clips, captions, and audio tracks...",
      });

      const assembled = assembleGeneratedProject(
        {
          ...generatedSpec,
          captions: { ...generatedSpec.captions, enabled: enableCaptions, stylePreset: captionPreset },
          scenes: generatedSpec.scenes.map((sc) => ({ ...sc, transition: defaultTransition })),
        },
        sceneAssets,
        narrationData,
        musicData
      );

      setAssembledProject(assembled);
      setStep(4); // Ready
      notify?.(`Generated complete video: "${generatedSpec.title}"`);
    } catch (err) {
      console.error("[AiVideoGeneratorModal] Assembly error:", err);
      if (err.name === "AbortError" || err.message === "Asset acquisition cancelled") {
        setStep(2);
      } else {
        setError(err.message || "Assembly pipeline encountered an error.");
        setStep(2);
      }
    } finally {
      setLoading(false);
      abortControllerRef.current = null;
    }
  };

  const handleOpenInEditor = async () => {
    if (!assembledProject || isOpeningRef.current) return;
    isOpeningRef.current = true;
    setIsOpeningInEditor(true);
    try {
      const applyFn = onApplyGeneratedProject || onProjectReady;
      if (typeof applyFn === "function") {
        await applyFn(assembledProject);
      }
      handleClose({ keepProjectAssets: true });
    } catch (err) {
      console.error("[AiVideoGeneratorModal] Failed to load project into editor:", err);
      setError(err.message || "Failed to load generated project into timeline.");
    } finally {
      isOpeningRef.current = false;
      setIsOpeningInEditor(false);
    }
  };

  const handleClose = (options = {}) => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    // Clean up created object URLs only if not transferred to timeline project
    if (!options?.keepProjectAssets) {
      for (const a of attachments) {
        if (a.blobUrl) {
          try {
            URL.revokeObjectURL(a.blobUrl);
          } catch {
            // ignore
          }
        }
      }
    }
    isOpeningRef.current = false;
    setIsOpeningInEditor(false);
    setStep(1);
    setGeneratedSpec(null);
    setAssembledProject(null);
    setError(null);
    setLoading(false);
    if (typeof onClose === "function") onClose();
  };

  const handleBack = () => {
    if (abortControllerRef.current && step === 3) {
      abortControllerRef.current.abort();
    }
    isOpeningRef.current = false;
    setIsOpeningInEditor(false);
    setError(null);
    setLoading(false);
    if (typeof onBackToChat === "function") {
      onBackToChat();
    } else if (typeof onClose === "function") {
      onClose();
    }
  };

  // Find reference asset thumbnail by scene
  const getSceneReferenceThumbnail = (scene, idx) => {
    if (scene.assignedAssetId) {
      const found = attachments.find((a) => a.id === scene.assignedAssetId);
      if (found) return found;
    }
    if (scene.useReferenceAsset && attachments.length > 0) {
      return attachments[idx % attachments.length];
    }
    if (attachments.length > 0 && idx === 0) {
      return attachments[0];
    }
    return null;
  };

  if (!isOpen && !embedded) {
    return null;
  }

  const generatorContent = (
    <div
      className={`video-gen-container ${embedded ? "is-embedded" : ""}`}
      onClick={(e) => e.stopPropagation()}
      data-testid="ai-video-generator-root"
    >
      {/* Header */}
      <div className="video-gen-header">
        <div className="video-gen-title-group">
          <div className="video-gen-badge">
            <Sparkle size={18} weight="fill" />
          </div>
          <div>
            <h2 className="video-gen-title">AI Video Creator</h2>
            <span className="video-gen-subtitle">Conversational Creative Assistant</span>
          </div>
        </div>

        {/* Action button */}
        {embedded ? (
          <button
            type="button"
            className="video-gen-back-btn"
            onClick={handleBack}
            title="Back to Assistant Chat"
            data-testid="ai-assistant-mode-chat-btn"
          >
            <ArrowLeft size={16} />
            <span>Chat</span>
          </button>
        ) : (
          <button
            type="button"
            className="video-gen-close"
            onClick={handleClose}
            aria-label="Close generator"
            data-testid="ai-generator-modal-close-btn"
          >
            <X size={18} />
          </button>
        )}
      </div>

      {/* Stepper Bar */}
      <div className="video-gen-stepper" role="navigation" aria-label="Generator Steps">
        <div
          className={`video-gen-step-item ${step === 1 ? "is-active" : step > 1 ? "is-complete" : ""}`}
          onClick={() => step > 1 && setStep(1)}
          style={{ cursor: step > 1 ? "pointer" : "default" }}
        >
          <span className="video-gen-step-num">1</span>
          <span>Brief & Chat</span>
        </div>
        <span className="video-gen-step-sep" />
        <div
          className={`video-gen-step-item ${step === 2 ? "is-active" : step > 2 ? "is-complete" : ""}`}
          onClick={() => generatedSpec && setStep(2)}
          style={{ cursor: generatedSpec ? "pointer" : "default" }}
        >
          <span className="video-gen-step-num">2</span>
          <span>Storyboard</span>
        </div>
        <span className="video-gen-step-sep" />
        <div className={`video-gen-step-item ${step === 3 ? "is-active" : step > 3 ? "is-complete" : ""}`}>
          <span className="video-gen-step-num">3</span>
          <span>Assembly</span>
        </div>
        <span className="video-gen-step-sep" />
        <div className={`video-gen-step-item ${step === 4 ? "is-active" : ""}`}>
          <span className="video-gen-step-num">4</span>
          <span>Ready</span>
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <div style={{ margin: "12px 20px 0" }}>
          <div className="video-gen-error-banner" role="alert">
            <Warning size={16} weight="bold" />
            <span>{error}</span>
          </div>
        </div>
      )}

      {/* Modal Body */}
      <div className="video-gen-body">
        {step === 1 && (
          /* Step 1: Conversational Chat-First Creative Assistant */
          <div className="video-gen-chat-wrap">
            {/* Conversation Thread */}
            <div className="video-gen-chat-thread" data-testid="video-gen-chat-thread">
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`video-gen-msg-row ${msg.role === "user" ? "is-user" : "is-assistant"}`}
                  data-testid="video-gen-chat-message"
                >
                  <div className="video-gen-msg-avatar">
                    {msg.role === "user" ? "You" : <Sparkle size={14} weight="fill" />}
                  </div>
                  <div className="video-gen-msg-bubble">
                    <p className="video-gen-msg-text">{msg.text}</p>

                    {/* Display message attachment previews if user sent any */}
                    {msg.attachments?.length > 0 && (
                      <div className="video-gen-msg-attachments">
                        {msg.attachments.map((att) => (
                          <div key={att.id} className="video-gen-msg-att-pill">
                            {att.kind === "video" ? <VideoCamera size={13} /> : <ImageSquare size={13} />}
                            <span className="video-gen-msg-att-name">{att.name}</span>
                            <span className="video-gen-msg-att-role">({att.role || "reference"})</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* If message has spec ready summary, show review button */}
                    {msg.type === "spec_ready" && (
                      <div className="video-gen-msg-spec-action">
                        <button
                          type="button"
                          className="video-gen-inline-btn"
                          onClick={() => setStep(2)}
                        >
                          <span>Review Storyboard</span>
                          <ArrowRight size={14} />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            {/* Inspiration Chips */}
            <div className="video-gen-examples">
              <span className="video-gen-examples-title">Inspiration:</span>
              {EXAMPLE_PROMPTS.map((ex, i) => (
                <button
                  key={i}
                  type="button"
                  className="video-gen-chip"
                  onClick={() => handleSelectExample(ex)}
                >
                  {ex.label}
                </button>
              ))}
            </div>

            {/* Attachment Preview Tray (if files attached) */}
            {attachments.length > 0 && (
              <div className="video-gen-attachments-tray" data-testid="video-gen-attachments-tray">
                <div className="video-gen-attachments-label">
                  <span>Attached Reference Media ({attachments.length}):</span>
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
                          <span>·</span>
                          {att.kind === "video" ? (
                            <select
                              className="video-gen-role-select"
                              value={att.role}
                              onChange={(e) => handleUpdateAttachmentRole(att.id, e.target.value)}
                              data-testid="video-gen-video-role-select"
                            >
                              <option value="alongside">Use in Timeline Sequence</option>
                              <option value="style_ref">Style Reference</option>
                              <option value="source_to_edit">Raw Footage to Edit</option>
                            </select>
                          ) : (
                            <select
                              className="video-gen-role-select"
                              value={att.role}
                              onChange={(e) => handleUpdateAttachmentRole(att.id, e.target.value)}
                            >
                              <option value="product">Product Photo</option>
                              <option value="image">Style / Scene Image</option>
                            </select>
                          )}
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

            {/* Chat Input Bar */}
            <form onSubmit={handleGenerateSpec} className="video-gen-chat-form">
              <div className="video-gen-input-box">
                <textarea
                  className="video-gen-textarea"
                  rows={3}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Describe your video brief in natural language (e.g. 'Create a 30-second premium coffee advertisement using my product photo with warm cinematic lighting and subtle background music...')"
                  maxLength={5000}
                  disabled={loading}
                  data-testid="video-gen-prompt-input"
                />

                <div className="video-gen-input-toolbar">
                  {/* Left attachment buttons & advanced toggle */}
                  <div className="video-gen-toolbar-left">
                    <button
                      type="button"
                      className="video-gen-tool-btn"
                      onClick={() => imageInputRef.current?.click()}
                      title="Attach reference image (JPEG, PNG, WebP up to 15MB)"
                      disabled={loading}
                      data-testid="video-gen-attach-image-btn"
                    >
                      <ImageSquare size={16} />
                      <span>Add Image</span>
                    </button>
                    <button
                      type="button"
                      className="video-gen-tool-btn"
                      onClick={() => videoInputRef.current?.click()}
                      title="Attach reference video (MP4, WebM up to 50MB)"
                      disabled={loading}
                      data-testid="video-gen-attach-video-btn"
                    >
                      <VideoCamera size={16} />
                      <span>Add Video</span>
                    </button>
                    <button
                      type="button"
                      className={`video-gen-tool-btn ${showAdvanced ? "is-active" : ""}`}
                      onClick={() => setShowAdvanced((v) => !v)}
                      title="Toggle optional advanced parameters"
                      data-testid="video-gen-advanced-toggle"
                    >
                      <Sliders size={15} />
                      <span>{showAdvanced ? "Hide Options" : "Advanced"}</span>
                    </button>
                  </div>

                  {/* Right: Character count & Send Button */}
                  <div className="video-gen-toolbar-right">
                    <span className="video-gen-char-count">{prompt.length} / 5000</span>
                    <button
                      type="submit"
                      className="video-gen-send-btn"
                      disabled={loading}
                      data-testid="video-gen-submit-btn"
                      title="Create Video Storyboard"
                    >
                      {loading ? (
                        <>
                          <CircleNotch size={15} className="is-spinning" />
                          <span>Directing...</span>
                        </>
                      ) : (
                        <>
                          <Sparkle size={15} weight="fill" />
                          <span>Create Storyboard</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>

              {/* Optional Advanced Settings Drawer */}
              <div
                className="video-gen-adv-drawer"
                data-testid="video-gen-advanced-drawer"
                style={{ display: showAdvanced ? "flex" : "none" }}
              >
                  <div className="video-gen-grid">
                    <div className="video-gen-field">
                      <label htmlFor="video-gen-format-select">Format / Aspect Ratio</label>
                      <select
                        id="video-gen-format-select"
                        className="video-gen-select"
                        value={aspectRatio}
                        onChange={(e) => {
                          setAspectRatio(e.target.value);
                          setHasExplicitRatioSelection(true);
                        }}
                        data-testid="video-gen-format-select"
                      >
                        <option value="16:9">16:9 Widescreen (YouTube, Standard)</option>
                        <option value="9:16">9:16 Portrait (TikTok, Shorts, Reels)</option>
                        <option value="1:1">1:1 Square (Instagram Feed)</option>
                        <option value="4:5">4:5 Social Portrait</option>
                      </select>
                    </div>

                    <div className="video-gen-field">
                      <label htmlFor="video-gen-duration-select">Target Duration</label>
                      <select
                        id="video-gen-duration-select"
                        className="video-gen-select"
                        value={targetDuration}
                        onChange={(e) => setTargetDuration(Number(e.target.value))}
                        data-testid="video-gen-duration-select"
                      >
                        <option value={15}>15 Seconds (Quick Hook)</option>
                        <option value={30}>30 Seconds (Standard)</option>
                        <option value={60}>60 Seconds (Full Short)</option>
                        <option value={90}>90 Seconds (Deep Dive)</option>
                      </select>
                    </div>

                    <div className="video-gen-field">
                      <label htmlFor="video-gen-style-select">Visual Style</label>
                      <select
                        id="video-gen-style-select"
                        className="video-gen-select"
                        value={style}
                        onChange={(e) => setStyle(e.target.value)}
                        data-testid="video-gen-style-select"
                      >
                        <option value="cinematic">Cinematic & Moody</option>
                        <option value="tech">Tech & Futuristic</option>
                        <option value="nature">Nature & Aerial</option>
                        <option value="documentary">Modern Documentary</option>
                        <option value="social">Social & Vibrant</option>
                        <option value="minimalist">Clean & Minimalist</option>
                      </select>
                    </div>

                    <div className="video-gen-field">
                      <label htmlFor="video-gen-voice-select">Narrator Voice</label>
                      <select
                        id="video-gen-voice-select"
                        className="video-gen-select"
                        value={voiceId}
                        onChange={(e) => setVoiceId(e.target.value)}
                        data-testid="video-gen-voice-select"
                      >
                        {VOICES.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.name} ({v.language} · {v.gender})
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="video-gen-toggles">
                    <label className="video-gen-toggle-item">
                      <input
                        type="checkbox"
                        checked={enableNarration}
                        onChange={(e) => setEnableNarration(e.target.checked)}
                      />
                      <Microphone size={15} />
                      <span>Voiceover Narration</span>
                    </label>

                    <label className="video-gen-toggle-item">
                      <input
                        type="checkbox"
                        checked={enableMusic}
                        onChange={(e) => setEnableMusic(e.target.checked)}
                      />
                      <MusicNote size={15} />
                      <span>Background Music</span>
                    </label>

                    <label className="video-gen-toggle-item">
                      <input
                        type="checkbox"
                        checked={enableCaptions}
                        onChange={(e) => setEnableCaptions(e.target.checked)}
                      />
                      <ClosedCaptioning size={15} />
                      <span>Auto Captions</span>
                    </label>
                  </div>
                </div>
            </form>
          </div>
        )}

        {step === 2 && generatedSpec && (
          /* Step 2: Storyboard Review & Customization */
          <div className="video-gen-storyboard-wrap">
            <div className="video-gen-spec-summary" data-testid="video-gen-spec-summary">
              <div className="video-gen-spec-title">{generatedSpec.title}</div>
              <div className="video-gen-spec-pills">
                <span className="video-gen-spec-pill">
                  ⏱ {generatedSpec.finalDuration || generatedSpec.targetDuration}s
                </span>
                <span className="video-gen-spec-pill">📐 {generatedSpec.aspectRatio}</span>
                <span className="video-gen-spec-pill">🎬 {generatedSpec.scenes.length} Scenes</span>
                <span className="video-gen-spec-pill">✨ {generatedSpec.style}</span>
                {attachments.length > 0 && (
                  <span className="video-gen-spec-pill is-ref">
                    📎 {attachments.length} Reference {attachments.length === 1 ? "Asset" : "Assets"}
                  </span>
                )}
              </div>
              <p style={{ margin: "8px 0 0", fontSize: "12.5px", color: "#94a3b8", lineHeight: 1.5, width: "100%" }}>
                {generatedSpec.summary}
              </p>
            </div>

            <div className="video-gen-scenes-list" data-testid="video-gen-scenes-list">
              {generatedSpec.scenes.map((scene, i) => {
                const refThumb = getSceneReferenceThumbnail(scene, i);
                return (
                  <div key={scene.id || i} className="video-gen-scene-card" data-testid="video-gen-scene-card">
                    <div className="video-gen-scene-header">
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span className="video-gen-scene-badge">
                          SCENE {i + 1}: {scene.title}
                        </span>
                        {refThumb && (
                          <span className="video-gen-ref-badge" title={`Using ${refThumb.name}`}>
                            {refThumb.kind === "video" ? "🎥 Attached Video" : "📸 Product Reference"}
                          </span>
                        )}
                      </div>
                      <span className="video-gen-scene-dur">{scene.duration}s</span>
                    </div>

                    {refThumb && (
                      <div className="video-gen-scene-ref-preview">
                        {refThumb.kind === "video" ? (
                          <video src={refThumb.blobUrl} className="video-gen-scene-ref-thumb" muted preload="metadata" />
                        ) : (
                          <img src={refThumb.blobUrl} alt={refThumb.name} className="video-gen-scene-ref-thumb" />
                        )}
                        <span className="video-gen-scene-ref-label">Reference Asset: {refThumb.name}</span>
                      </div>
                    )}

                    <div className="video-gen-scene-desc">{scene.visualDescription}</div>
                    {scene.narration && (
                      <div className="video-gen-scene-narration">“{scene.narration}”</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {step === 3 && (
          /* Step 3: Assembly Progress */
          <div className="video-gen-assembly-box">
            <CircleNotch size={38} className="is-spinning" style={{ color: "#818cf8" }} />
            <div className="video-gen-stage-status">{assemblyProgress.message || "Assembling video..."}</div>
            <div className="video-gen-progress-bar-wrap">
              <div
                className="video-gen-progress-bar"
                style={{ width: `${Math.max(5, Math.min(100, assemblyProgress.progress || 10))}%` }}
              />
            </div>
            <span style={{ fontSize: "12px", color: "#64748b" }}>
              Creating media clips, generating voiceover waveform, and aligning subtitle tracks...
            </span>
          </div>
        )}

        {step === 4 && assembledProject && (
          /* Step 4: Ready */
          <div style={{ display: "flex", flexDirection: "column", gap: 14, textAlign: "center", padding: "12px 0" }}>
            <div style={{ margin: "0 auto", color: "#10b981" }}>
              <CheckCircle size={44} weight="fill" />
            </div>
            <h3 style={{ margin: 0, fontSize: "18px", color: "#ffffff" }}>
              Video Project Ready!
            </h3>
            <p style={{ margin: 0, fontSize: "13px", color: "#94a3b8", lineHeight: 1.5 }}>
              Your video <strong>“{assembledProject.title}”</strong> has been assembled with{" "}
              {assembledProject.visualSegments?.length || 0} visual clips, dynamic camera motion, synchronized voiceover narration,
              background audio, and captions.
            </p>
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                gap: 12,
                marginTop: 2,
                fontSize: "12px",
                color: "#cbd5e1",
              }}
            >
              <span>Format: {assembledProject.ratioId}</span>
              <span>·</span>
              <span>Clips: {assembledProject.visualSegments?.length}</span>
              <span>·</span>
              <span>Captions: {assembledProject.captionSegments?.length}</span>
            </div>

            {/* Visual Quality Diagnostics Summary */}
            {assembledProject.diagnosticSummary && (
              <div className="video-gen-diagnostics-card" data-testid="video-gen-diagnostics-card">
                <div className="video-gen-diagnostics-header">
                  <div className="video-gen-diagnostics-title">
                    <FilmSlate size={16} />
                    <span>Visual Footage & Motion Diagnostics</span>
                  </div>
                  <div className="video-gen-diagnostics-badges">
                    <span
                      className={`video-gen-diagnostic-badge ${
                        assembledProject.diagnosticSummary.allRealMedia ? "is-success" : "is-warning"
                      }`}
                    >
                      {assembledProject.diagnosticSummary.realMediaCount}/
                      {assembledProject.diagnosticSummary.totalScenes} Real Photographic Assets
                    </span>
                    <span className="video-gen-diagnostic-badge is-success">
                      🎥 Ken Burns Motion Active
                    </span>
                  </div>
                </div>

                <div className="video-gen-diagnostics-list">
                  {assembledProject.diagnosticSummary.scenes.map((diag, sIdx) => (
                    <div
                      key={diag.sceneId || sIdx}
                      className={`video-gen-diagnostic-row ${diag.isFallback ? "is-fallback" : "is-real"}`}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <span style={{ fontWeight: 600, color: "#e2e8f0" }}>
                          Scene {sIdx + 1}:
                        </span>
                        <span style={{ color: "#94a3b8", overflow: "hidden", textOverflow: "ellipsis" }} title={diag.title}>
                          {diag.title}
                        </span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, fontSize: "11px" }}>
                        <span style={{ color: "#cbd5e1", background: "rgba(255,255,255,0.06)", padding: "1px 6px", borderRadius: 4 }}>
                          {diag.motionType}
                        </span>
                        <span
                          style={{
                            color: diag.isFallback ? "#f59e0b" : "#10b981",
                            fontWeight: 500,
                          }}
                        >
                          {diag.isFallback ? "Procedural Fallback" : diag.assetSource}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer Buttons for Navigation */}
      <div className="video-gen-footer">
        {step === 1 && (
          <div style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <button
              type="button"
              className="video-gen-btn-secondary"
              onClick={embedded ? handleBack : handleClose}
              disabled={loading}
            >
              {embedded ? "Back to Chat" : "Cancel"}
            </button>
            {generatedSpec && (
              <button
                type="button"
                className="video-gen-btn-secondary"
                onClick={() => setStep(2)}
              >
                <span>View Current Storyboard</span>
                <ArrowRight size={14} />
              </button>
            )}
          </div>
        )}

        {step === 2 && (
          <div style={{ width: "100%", display: "flex", justifyContent: "space-between", gap: 12 }}>
            <button
              type="button"
              className="video-gen-btn-secondary"
              onClick={() => setStep(1)}
              data-testid="video-gen-back-to-brief-btn"
            >
              <ArrowLeft size={15} />
              <span>Back to Conversation</span>
            </button>
            <button
              type="button"
              className="video-gen-btn-primary"
              onClick={handleStartAssembly}
              disabled={loading}
              data-testid="video-gen-assemble-btn"
            >
              <Sparkle size={16} weight="fill" />
              <span>Assemble Video Project</span>
            </button>
          </div>
        )}

        {step === 3 && (
          <div style={{ width: "100%", display: "flex", justifyContent: "center" }}>
            <button
              type="button"
              className="video-gen-btn-secondary"
              onClick={() => {
                if (abortControllerRef.current) abortControllerRef.current.abort();
                setStep(2);
              }}
            >
              Cancel Assembly
            </button>
          </div>
        )}

        {step === 4 && (
          <div style={{ width: "100%", display: "flex", justifyContent: "flex-end", gap: 12 }}>
            <button
              type="button"
              className="video-gen-btn-secondary"
              onClick={() => setStep(2)}
            >
              Back to Storyboard
            </button>
            <button
              type="button"
              className="video-gen-btn-primary"
              onClick={handleOpenInEditor}
              disabled={isOpeningInEditor}
              data-testid="video-gen-open-editor-btn"
            >
              {isOpeningInEditor ? (
                <>
                  <CircleNotch size={16} className="is-spinning" />
                  <span>Opening Project...</span>
                </>
              ) : (
                <>
                  <FilmSlate size={16} weight="fill" />
                  <span>Open in Timeline Studio</span>
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );

  if (embedded) {
    return generatorContent;
  }

  return createPortal(
    <div className="video-gen-backdrop" onClick={handleClose} data-testid="ai-video-generator-modal">
      {generatorContent}
    </div>,
    document.body
  );
}

export { AiVideoGenerator as AiVideoGeneratorModal };
export default AiVideoGenerator;
