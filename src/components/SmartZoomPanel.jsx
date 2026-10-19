import { useState, useMemo, useCallback, Component } from "react";
import {
  MagnifyingGlassPlus,
  Trash,
  Plus,
  Sparkle,
  User,
  ArrowsInLineHorizontal,
  ArrowCounterClockwise,
  Warning,
} from "@phosphor-icons/react";
import { applyCommandPlan } from "../lib/projectCommandEngine.js";
import { detectSpeechPunchInMoments, inspectPunchIns } from "../lib/smartZoom.js";

function formatTimestamp(seconds) {
  if (typeof seconds !== "number" || isNaN(seconds)) return "0:00.00";
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(2).padStart(5, "0");
  return `${mins}:${secs}`;
}

class SmartZoomErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("[SmartZoomPanel] Error caught by boundary:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      const { t } = this.props;
      return (
        <div className="smart-zoom-panel" style={{ padding: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#f87171", marginBottom: 8 }}>
            <Warning size={20} weight="bold" />
            <strong>{t?.("smartZoomErrorTitle", "Smart Zoom unavailable") || "Smart Zoom unavailable"}</strong>
          </div>
          <p style={{ fontSize: 12, color: "#94a3b8", marginBottom: 12 }}>
            {t?.("smartZoomErrorDesc", "An unexpected error occurred while loading Smart Zoom.") || "An unexpected error occurred while loading Smart Zoom."}
          </p>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ fontSize: 12, padding: "6px 12px" }}
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            {t?.("retry", "Retry") || "Retry"}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function SmartZoomPanelInner({
  t,
  getProjectSnapshot,
  onApplyPlan,
  updateSelectedVisualEffects,
  currentTime = 0,
  captionSegments = [],
  selectedVisualSegment,
  visualSegments = [],
  notify,
}) {
  const [scope, setScope] = useState("clip"); // "clip" | "timeline"
  const [scale, setScale] = useState(1.2);
  const [duration, setDuration] = useState(2.5);
  const [isSmooth, setIsSmooth] = useState(true);
  const [transitionDuration, setTransitionDuration] = useState(0.35);
  const [anchorFace, setAnchorFace] = useState(true);

  const safeVisualSegments = Array.isArray(visualSegments) ? visualSegments : [];
  const activeClipId = selectedVisualSegment?.id || safeVisualSegments[0]?.id || "";
  const activeClip = safeVisualSegments.find((c) => c?.id === activeClipId) || selectedVisualSegment || null;

  // Compute active punch-ins from the current project snapshot or visualSegments
  const activePunchIns = useMemo(() => {
    try {
      const proj = (typeof getProjectSnapshot === "function" ? getProjectSnapshot() : null)
        || { visualSegments: safeVisualSegments.length ? safeVisualSegments : (activeClip ? [activeClip] : []) };
      const inspection = inspectPunchIns(proj);
      const punchInsList = Array.isArray(inspection)
        ? inspection
        : (Array.isArray(inspection?.punchIns) ? inspection.punchIns : []);
      if (scope === "clip") {
        return activeClipId ? punchInsList.filter((item) => item && item.clipId === activeClipId) : [];
      }
      return punchInsList;
    } catch (err) {
      console.error("[SmartZoomPanel] Failed to inspect punch-ins:", err);
      return [];
    }
  }, [getProjectSnapshot, safeVisualSegments, activeClip, scope, activeClipId]);

  const handleAddPunchIn = useCallback(() => {
    const currentProj = (getProjectSnapshot ? getProjectSnapshot() : null)
      || { visualSegments: visualSegments.length ? visualSegments : (activeClip ? [activeClip] : []) };
    const targetClip = (scope === "clip" && activeClip)
      ? activeClip
      : (visualSegments.find((c) => currentTime >= (c.start || 0) && currentTime < (c.start || 0) + (c.duration || 0)) || activeClip);

    if (!targetClip) {
      notify?.("Please select a visual clip first");
      return;
    }

    // Clip-relative timestamp
    const clipStart = targetClip.start || 0;
    const clipLocalTime = Math.max(0, Math.min(targetClip.duration || 0, currentTime - clipStart));

    const action = {
      id: `punch-in-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: "visual.punch_in",
      clipId: targetClip.id,
      time: Number(clipLocalTime.toFixed(2)),
      scale,
      duration,
      transition: isSmooth ? "smooth" : "jump",
      transitionDuration: isSmooth ? transitionDuration : 0.3,
      faceAnchored: anchorFace,
    };

    const rev = currentProj.commandState?.revision || 0;
    const plan = {
      schemaVersion: 1,
      baseRevision: rev,
      operations: [action],
    };

    const result = applyCommandPlan(currentProj, plan);
    if (result.ok) {
      if (onApplyPlan) {
        onApplyPlan(result.project, plan);
      } else if (updateSelectedVisualEffects) {
        const updated = result.project.visualSegments?.find((c) => c.id === targetClip.id);
        if (updated) {
          updateSelectedVisualEffects({ punchIns: updated.punchIns, keyframes: updated.keyframes });
        }
      }
      notify?.(`Punch-in added to ${targetClip.name || "clip"} at ${formatTimestamp(clipLocalTime)}`);
    } else {
      notify?.(result.message || "Failed to add punch-in");
    }
  }, [
    getProjectSnapshot,
    onApplyPlan,
    updateSelectedVisualEffects,
    scope,
    activeClip,
    visualSegments,
    currentTime,
    scale,
    duration,
    isSmooth,
    transitionDuration,
    anchorFace,
    notify,
  ]);

  const handleRemovePunchIn = useCallback((clipId, punchInId) => {
    const currentProj = (getProjectSnapshot ? getProjectSnapshot() : null)
      || { visualSegments: visualSegments.length ? visualSegments : (activeClip ? [activeClip] : []) };
    const rev = currentProj.commandState?.revision || 0;
    const plan = {
      schemaVersion: 1,
      baseRevision: rev,
      operations: [
        {
          id: `remove-punch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: "visual.remove_punch_in",
          clipId,
          punchInId,
        },
      ],
    };

    const result = applyCommandPlan(currentProj, plan);
    if (result.ok) {
      if (onApplyPlan) {
        onApplyPlan(result.project, plan);
      } else if (updateSelectedVisualEffects) {
        const updated = result.project.visualSegments?.find((c) => c.id === clipId);
        if (updated) {
          updateSelectedVisualEffects({ punchIns: updated.punchIns, keyframes: updated.keyframes });
        }
      }
      notify?.("Punch-in removed");
    } else {
      notify?.(result.message || "Failed to remove punch-in");
    }
  }, [getProjectSnapshot, onApplyPlan, updateSelectedVisualEffects, visualSegments, activeClip, notify]);

  const handleResetZoom = useCallback(() => {
    const currentProj = (getProjectSnapshot ? getProjectSnapshot() : null)
      || { visualSegments: visualSegments.length ? visualSegments : (activeClip ? [activeClip] : []) };
    const rev = currentProj.commandState?.revision || 0;
    const operations = [];

    if (scope === "clip" && activeClipId) {
      operations.push({
        id: `reset-zoom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: "visual.reset_zoom",
        clipId: activeClipId,
      });
    } else {
      const visuals = currentProj.visualSegments || [];
      visuals.forEach((c, idx) => {
        operations.push({
          id: `reset-zoom-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
          type: "visual.reset_zoom",
          clipId: c.id,
        });
      });
    }

    if (operations.length === 0) return;

    const plan = {
      schemaVersion: 1,
      baseRevision: rev,
      operations,
    };

    const result = applyCommandPlan(currentProj, plan);
    if (result.ok) {
      if (onApplyPlan) {
        onApplyPlan(result.project, plan);
      } else if (updateSelectedVisualEffects) {
        const updated = result.project.visualSegments?.find((c) => c.id === activeClipId);
        if (updated) {
          updateSelectedVisualEffects({ punchIns: [], keyframes: updated.keyframes });
        }
      }
      notify?.(scope === "clip" ? "Zoom reset for selected clip" : "All zooms reset across timeline");
    } else {
      notify?.(result.message || "Failed to reset zoom");
    }
  }, [getProjectSnapshot, onApplyPlan, updateSelectedVisualEffects, scope, activeClipId, visualSegments, activeClip, notify]);

  const handleGenerateFromSpeech = useCallback(() => {
    const currentProj = (getProjectSnapshot ? getProjectSnapshot() : null)
      || { visualSegments: visualSegments.length ? visualSegments : (activeClip ? [activeClip] : []) };

    const targetClips = (scope === "clip" && activeClip)
      ? [activeClip]
      : (visualSegments.length > 0 ? visualSegments : (activeClip ? [activeClip] : []));

    if (targetClips.length === 0) {
      notify?.("No visual clips available");
      return;
    }

    const actions = [];
    let totalGenerated = 0;

    for (const clip of targetClips) {
      // Find captions within this clip's time range
      const clipStart = clip.start || 0;
      const clipEnd = clipStart + (clip.duration || 0);
      const clipCaptions = captionSegments
        .filter((c) => (c.end || 0) > clipStart && (c.start || 0) < clipEnd)
        .map((c) => ({
          ...c,
          start: Math.max(0, (c.start || 0) - clipStart),
          end: Math.min(clip.duration || 0, (c.end || 0) - clipStart),
        }));

      const detected = detectSpeechPunchInMoments(clipCaptions, clip.duration || 0, {
        scale,
        duration,
        transitionDuration: isSmooth ? transitionDuration : 0,
        anchorFace,
      });

      for (const item of detected) {
        actions.push({
          id: `speech-punch-${Date.now()}-${totalGenerated}-${Math.random().toString(36).slice(2, 6)}`,
          type: "visual.punch_in",
          clipId: clip.id,
          time: item.time ?? item.timestamp,
          scale: item.scale,
          duration: item.duration,
          transition: isSmooth ? "smooth" : "jump",
          transitionDuration: item.transitionDuration,
          faceAnchored: item.faceAnchored ?? item.anchorFace,
        });
        totalGenerated++;
      }
    }

    if (actions.length === 0) {
      notify?.("No speech transition points detected in the selected range");
      return;
    }

    const rev = currentProj.commandState?.revision || 0;
    const plan = {
      schemaVersion: 1,
      baseRevision: rev,
      operations: actions,
    };

    const result = applyCommandPlan(currentProj, plan);
    if (result.ok) {
      if (onApplyPlan) {
        onApplyPlan(result.project, plan);
      } else if (updateSelectedVisualEffects && activeClip) {
        const updated = result.project.visualSegments?.find((c) => c.id === activeClip.id);
        if (updated) {
          updateSelectedVisualEffects({ punchIns: updated.punchIns, keyframes: updated.keyframes });
        }
      }
      notify?.(`Generated ${totalGenerated} smart punch-ins from speech!`);
    } else {
      notify?.(result.message || "Failed to apply smart punch-ins");
    }
  }, [
    getProjectSnapshot,
    onApplyPlan,
    updateSelectedVisualEffects,
    scope,
    activeClip,
    visualSegments,
    captionSegments,
    scale,
    duration,
    isSmooth,
    transitionDuration,
    anchorFace,
    notify,
  ]);


  return (
    <div className="smart-zoom-panel" data-testid="smart-zoom-panel">
      {/* Intro Header */}
      <section className="smart-frame-intro">
        <span className="smart-frame-intro-icon">
          <MagnifyingGlassPlus size={22} weight="duotone" />
        </span>
        <div>
          <strong>{t?.("smartZoomTitle", "AI 智能变焦与节奏特写") || "AI 智能变焦与节奏特写"}</strong>
          <p>{t?.("smartZoomHint", "在说话重点处自动推进或跳切，锚定人脸，永无黑边。") || "在说话重点处自动推进或跳切，锚定人脸，永无黑边。"}</p>
          <small className="smart-frame-acceleration">{t?.("smartZoomLocal", "本地极速处理 · 零模型下载") || "本地极速处理 · 零模型下载"}</small>
        </div>
      </section>

      {/* Scope Switcher */}
      <div className="smart-frame-section-heading">
        <strong>{t?.("smartZoomScope", "应用范围") || "应用范围"}</strong>
        <span>{scope === "clip" ? (activeClip?.name || "当前片段") : "整个时间线"}</span>
      </div>
      <div className="smart-frame-motion-options" role="radiogroup" aria-label="Scope">
        <button
          className={scope === "clip" ? "is-active" : ""}
          type="button"
          role="radio"
          aria-checked={scope === "clip"}
          onClick={() => setScope("clip")}
        >
          <strong>{t?.("smartZoomSelectedClip", "当前选中片段") || "当前选中片段"}</strong>
          <span>{activeClip ? activeClip.name || "Clip" : "无选中片段"}</span>
        </button>
        <button
          className={scope === "timeline" ? "is-active" : ""}
          type="button"
          role="radio"
          aria-checked={scope === "timeline"}
          onClick={() => setScope("timeline")}
        >
          <strong>{t?.("smartZoomAllClips", "整个时间线") || "整个时间线"}</strong>
          <span>{`${visualSegments.length} 个视频片段`}</span>
        </button>
      </div>

      {/* Automatic Generation from Speech */}
      <div className="smart-frame-section-heading">
        <strong>{t?.("smartZoomSpeechSync", "节奏自适应生成") || "节奏自适应生成"}</strong>
        <span>{`${captionSegments.length} 句字幕可用`}</span>
      </div>
      <button
        type="button"
        className="btn btn-primary"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          padding: "10px 16px",
          background: "linear-gradient(135deg, #2563eb, #38bdf8)",
          color: "#fff",
          border: "none",
          borderRadius: 8,
          cursor: "pointer",
          fontWeight: 600,
        }}
        onClick={handleGenerateFromSpeech}
        data-testid="smart-zoom-generate-btn"
      >
        <Sparkle size={18} weight="fill" />
        <span>{t?.("smartZoomGenerateSpeech", "根据字幕重点自动生成特写") || "根据字幕重点自动生成特写"}</span>
      </button>

      {/* Zoom Configuration Sliders */}
      <div className="smart-frame-section-heading" style={{ marginTop: 8 }}>
        <strong>{t?.("smartZoomParameters", "变焦参数设定") || "变焦参数设定"}</strong>
      </div>

      <label className="smart-frame-padding">
        <span>
          <strong>{t?.("smartZoomScale", "放大强度") || "放大强度"}</strong>
          <em>{`${scale.toFixed(2)}x (+${Math.round((scale - 1) * 100)}%)`}</em>
        </span>
        <input
          type="range"
          min="1.05"
          max="2.00"
          step="0.05"
          value={scale}
          onChange={(e) => setScale(Number(e.target.value))}
        />
      </label>

      <label className="smart-frame-padding">
        <span>
          <strong>{t?.("smartZoomDuration", "特写保持时长") || "特写保持时长"}</strong>
          <em>{`${duration.toFixed(1)}s`}</em>
        </span>
        <input
          type="range"
          min="0.5"
          max="8.0"
          step="0.5"
          value={duration}
          onChange={(e) => setDuration(Number(e.target.value))}
        />
      </label>

      {/* Transition Style: Jump Cut vs Smooth */}
      <div className="smart-frame-section-heading">
        <strong>{t?.("smartZoomTransition", "过渡模式") || "过渡模式"}</strong>
      </div>
      <div className="smart-frame-motion-options">
        <button
          className={isSmooth ? "is-active" : ""}
          type="button"
          onClick={() => setIsSmooth(true)}
        >
          <strong>{t?.("smartZoomSmooth", "平滑推进") || "平滑推进"}</strong>
          <span>自然呼吸感</span>
        </button>
        <button
          className={!isSmooth ? "is-active" : ""}
          type="button"
          onClick={() => setIsSmooth(false)}
        >
          <strong>{t?.("smartZoomJump", "跳切特写") || "跳切特写"}</strong>
          <span>干脆节奏感</span>
        </button>
      </div>

      {isSmooth ? (
        <label className="smart-frame-padding">
          <span>
            <strong>{t?.("smartZoomTransitionDuration", "推进过渡耗时") || "推进过渡耗时"}</strong>
            <em>{`${transitionDuration.toFixed(2)}s`}</em>
          </span>
          <input
            type="range"
            min="0.15"
            max="1.00"
            step="0.05"
            value={transitionDuration}
            onChange={(e) => setTransitionDuration(Number(e.target.value))}
          />
        </label>
      ) : null}

      {/* Face Anchoring Toggle */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 14px",
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 8,
          cursor: "pointer",
        }}
        onClick={() => setAnchorFace((prev) => !prev)}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <User size={18} color="#38bdf8" weight={anchorFace ? "fill" : "regular"} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 500, color: "#f1f5f8" }}>
              {t?.("smartZoomAnchorFace", "人脸智能居中") || "人脸智能居中"}
            </div>
            <div style={{ fontSize: 11, color: "#8e9ca8" }}>
              {t?.("smartZoomAnchorFaceHint", "自动跟踪演讲者面部，防边缘出界") || "自动跟踪演讲者面部，防边缘出界"}
            </div>
          </div>
        </div>
        <input
          type="checkbox"
          checked={anchorFace}
          onChange={(e) => setAnchorFace(e.target.checked)}
          style={{ cursor: "pointer", width: 16, height: 16 }}
        />
      </div>

      {/* Manual Add Punch-in at Playhead */}
      <button
        type="button"
        className="btn"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          padding: "9px 14px",
          background: "rgba(56, 189, 248, 0.15)",
          border: "1px solid rgba(56, 189, 248, 0.35)",
          color: "#38bdf8",
          borderRadius: 8,
          cursor: "pointer",
          fontWeight: 500,
        }}
        onClick={handleAddPunchIn}
        data-testid="smart-zoom-add-btn"
      >
        <Plus size={16} weight="bold" />
        <span>{`在当前播放位置添加特写 (${formatTimestamp(currentTime)})`}</span>
      </button>

      {/* Active Punch-Ins List */}
      <div className="smart-frame-section-heading" style={{ marginTop: 12 }}>
        <strong>{`当前特写列表 (${activePunchIns.length})`}</strong>
        {activePunchIns.length > 0 ? (
          <button
            type="button"
            style={{
              background: "none",
              border: "none",
              color: "#ef4444",
              cursor: "pointer",
              fontSize: 11,
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
            onClick={handleResetZoom}
            data-testid="smart-zoom-reset-btn"
          >
            <ArrowCounterClockwise size={13} />
            <span>重置所有特写</span>
          </button>
        ) : null}
      </div>

      {activePunchIns.length === 0 ? (
        <div className="smart-frame-empty">
          <ArrowsInLineHorizontal size={26} weight="duotone" />
          <strong>暂无特写效果</strong>
          <span>点击上方按钮自动根据字幕生成，或在播放位置手动添加。</span>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {activePunchIns.map((p) => (
            <div
              key={p.punchInId}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "8px 12px",
                background: "rgba(255,255,255,0.025)",
                border: "1px solid rgba(255,255,255,0.06)",
                borderRadius: 8,
                fontSize: 12,
              }}
            >
              <div>
                <div style={{ fontWeight: 600, color: "#e2e8f0" }}>
                  {`${formatTimestamp(p.timelineTime ?? p.time ?? p.timestamp ?? 0)} · ${(Number(p.scale) || 1).toFixed(2)}x`}
                  <span style={{ marginLeft: 6, fontSize: 10, color: "#38bdf8", background: "rgba(56,189,248,0.12)", padding: "2px 6px", borderRadius: 4 }}>
                    {(p.transition === "smooth" || (p.transitionDuration || 0) > 0) ? (t?.("smartZoomSmoothBadge", "平滑") || "平滑") : (t?.("smartZoomJumpBadge", "跳切") || "跳切")}
                  </span>
                </div>
                <div style={{ fontSize: 10, color: "#64748b", marginTop: 2 }}>
                  {`${t?.("smartZoomDurationLabel", "持续") || "持续"} ${(Number(p.duration) || 0).toFixed(1)}s · ${(p.faceAnchored ?? p.anchorFace) ? (t?.("smartZoomFaceAnchoredBadge", "人脸锚定") || "人脸锚定") : (t?.("smartZoomCenterBadge", "中心缩放") || "中心缩放")}`}
                </div>
              </div>
              <button
                type="button"
                style={{
                  background: "none",
                  border: "none",
                  color: "#94a3b8",
                  cursor: "pointer",
                  padding: 4,
                }}
                title={t?.("smartZoomDeletePunchIn", "删除此特写") || "删除此特写"}
                onClick={() => handleRemovePunchIn(p.clipId, p.punchInId)}
                onMouseEnter={(e) => (e.currentTarget.style.color = "#ef4444")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "#94a3b8")}
                data-testid={`smart-zoom-remove-${p.punchInId}`}
              >
                <Trash size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SmartZoomPanel(props) {
  return (
    <SmartZoomErrorBoundary t={props?.t}>
      <SmartZoomPanelInner {...props} />
    </SmartZoomErrorBoundary>
  );
}
