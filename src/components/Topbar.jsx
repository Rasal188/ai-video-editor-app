import { useEffect, useRef, useState } from "react";
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  CaretDown,
  CircleNotch,
  Cloud,
  CloudArrowUp,
  Database,
  DiscordLogo,
  FileArrowDown,
  FileArrowUp,
  FilePlus,
  GearSix,
  GithubLogo,
  Pause,
  Play,
  ShieldCheck,
  SlidersHorizontal,
  SquaresFour,
  UserCircle,
  XLogo,
} from "@phosphor-icons/react";

import { RATIO_OPTIONS } from "../config/editor.js";
import { APP_LANGUAGES, saveLanguagePreference } from "../i18n.js";
import { getPrimaryShortcutModifier, releasePointerActivatedFocus } from "../lib/editorShortcuts.js";
import { formatStorageBytes, inspectModelCache } from "../lib/modelCacheInspection.js";
import { ExportSettingsPanel } from "./ExportSettingsPanel.jsx";
import { IconButton, Popover } from "./ui.jsx";
import { AuthModal } from "./AuthModal.jsx";
import { CloudProjectsModal } from "./CloudProjectsModal.jsx";

const COMMUNITY_LINKS = Object.freeze({
  discord: "https://discord.gg/uq2uvUTBr",
  github: "https://github.com/MartinDelophy/ai-video-editor",
  x: "https://x.com/marindeloph",
});

export function Topbar({
  t,
  compactRail,
  setCompactRail,
  lastSaved,
  undo,
  redo,
  ratio,
  ratioId,
  showRatioMenu,
  setShowRatioMenu,
  setRatioId,
  notify,
  isPlaying,
  handlePlayToggle,
  imageSrc,
  exporting,
  handleExportVideo,
  showExportMenu,
  setShowExportMenu,
  exportSettings,
  setExportSettings,
  timelineDuration,
  showSettings,
  setShowSettings,
  activeLanguage,
  setUiLanguage,
  captionsEnabled,
  setCaptionsEnabled,
  trackVisibility,
  toggleTrackVisibility,
  showFileMenu,
  setShowFileMenu,
  handleNewProject,
  handleExportProject,
  handleImportProject,
  projectFileInputRef,
  currentUser: propUser,
  onLogout: propOnLogout,
  onAuthSuccess: propOnAuthSuccess,
  currentCloudProject,
  savingToCloud,
  saveProjectToCloud,
  handleOpenCloudProject,
  handleCloudRender,
  onBackToDashboard,
}) {
  const exportAnchorRef = useRef(null);
  const ratioAnchorRef = useRef(null);
  const settingsAnchorRef = useRef(null);
  const modelCacheControlRef = useRef(null);
  const [modelCacheInspection, setModelCacheInspection] = useState({ state: "idle", result: null });
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [showCloudProjectsModal, setShowCloudProjectsModal] = useState(false);
  const [localUser, setLocalUser] = useState(null);
  const currentUser = propUser !== undefined ? propUser : localUser;

  useEffect(() => {
    if (propUser !== undefined) return;
    let isMounted = true;
    fetch("/api/auth/me", { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (isMounted && data?.user) {
          setLocalUser(data.user);
        }
      })
      .catch(() => {});
    return () => {
      isMounted = false;
    };
  }, [propUser]);

  const shortcutModifier = getPrimaryShortcutModifier();
  const shortcutRows = [
    ["markersAdd", "M"],
    ["markersTitle", "Shift+M"],
    ["shortcutPlayPause", "Space"],
    ["shortcutSplit", `${shortcutModifier}+B`],
    ["shortcutDuplicate", `${shortcutModifier}+D`],
    ["shortcutDelete", "Delete / Backspace"],
    ["shortcutUndo", `${shortcutModifier}+Z`],
    ["shortcutRedo", `${shortcutModifier}+Shift+Z`],
    ["shortcutZoomOut", "−"],
    ["shortcutZoomIn", "+"],
    ["shortcutFitTimeline", "Shift+Z"],
    ["shortcutSelectLeft", "["],
    ["shortcutSelectRight", "]"],
  ];
  const checkModelCache = async () => {
    setModelCacheInspection({ state: "checking", result: null });
    try {
      const result = await inspectModelCache();
      setModelCacheInspection({ state: "ready", result });
    } catch {
      setModelCacheInspection({ state: "unavailable", result: null });
    }
  };
  const modelCacheResult = modelCacheInspection.result;
  const modelCacheSummary = modelCacheResult?.entryCount > 0
    ? t("modelCacheFound")
      .replace("{groups}", String(modelCacheResult.cacheCount))
      .replace("{files}", String(modelCacheResult.entryCount))
    : t("modelCacheEmpty");
  const modelCacheStorage = modelCacheResult?.usage != null
    ? t("modelCacheStorage")
      .replace("{usage}", formatStorageBytes(modelCacheResult.usage))
      .replace("{quota}", modelCacheResult.quota ? formatStorageBytes(modelCacheResult.quota) : "—")
    : "";
  useEffect(() => {
    if (!showSettings || modelCacheInspection.state === "idle") return undefined;
    const frame = window.requestAnimationFrame(() => {
      modelCacheControlRef.current?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [modelCacheInspection.state, showSettings]);

  return (
    <header className="topbar">
      <div className="project-cluster">
        {onBackToDashboard && (
          <button
            type="button"
            className="topbar-dashboard-btn"
            onClick={onBackToDashboard}
            title="Return to Dashboard"
            data-testid="topbar-back-to-dashboard-btn"
          >
            <SquaresFour size={16} weight="bold" />
            <span>Dashboard</span>
          </button>
        )}
        <IconButton label={t("collapseSidebar")} active={compactRail} onClick={() => setCompactRail((v) => !v)}>
          <SlidersHorizontal size={19} />
        </IconButton>
        <div>
          <div className="project-title-row">
            <div className="project-title" title={currentCloudProject?.title || t("projectTitle")}>
              {currentCloudProject?.title || t("projectTitle")}
            </div>
            <div className="menu-anchor">
              <button className="project-file-button" type="button" onClick={() => setShowFileMenu((open) => !open)}>
                {t("fileMenu")} <CaretDown size={13} />
              </button>
              {showFileMenu ? (
                <Popover className="project-file-popover" closeLabel={t("close")} onClose={() => setShowFileMenu(false)}>
                  <div className="file-menu-card">
                    <div className="file-menu-heading">
                      <span>{t("projectMenuHeading")}</span>
                      <small>Timeline Studio</small>
                    </div>
                    {onBackToDashboard && (
                      <button
                        className="file-menu-action"
                        type="button"
                        onClick={() => {
                          setShowFileMenu(false);
                          onBackToDashboard();
                        }}
                      >
                        <span className="file-menu-icon"><SquaresFour size={17} /></span>
                        <span className="file-menu-copy"><strong>Projects Dashboard</strong><small>Back to dashboard</small></span>
                      </button>
                    )}
                    <button className="file-menu-action file-menu-new" type="button" onClick={handleNewProject}>
                      <span className="file-menu-icon"><FilePlus size={17} /></span>
                      <span className="file-menu-copy"><strong>{t("newProject")}</strong><small>{t("newProjectHint")}</small></span>
                    </button>
                    <div className="file-menu-divider" />
                    <button
                      className="file-menu-action"
                      type="button"
                      disabled={savingToCloud}
                      onClick={() => {
                        setShowFileMenu(false);
                        saveProjectToCloud?.();
                      }}
                    >
                      <span className="file-menu-icon"><CloudArrowUp size={17} /></span>
                      <span className="file-menu-copy">
                        <strong>Save to Cloud</strong>
                        <small>{currentCloudProject ? `Save Revision (Rev ${currentCloudProject.current_revision + 1})` : "Store project & version in DB"}</small>
                      </span>
                      <span className="file-menu-format">PostgreSQL</span>
                    </button>
                    <button
                      className="file-menu-action"
                      type="button"
                      onClick={() => {
                        setShowFileMenu(false);
                        setShowCloudProjectsModal(true);
                      }}
                    >
                      <span className="file-menu-icon"><Cloud size={17} /></span>
                      <span className="file-menu-copy">
                        <strong>Open from Cloud…</strong>
                        <small>Browse saved projects & revisions</small>
                      </span>
                      <span className="file-menu-format">PostgreSQL</span>
                    </button>
                    <div className="file-menu-divider" />
                    <button className="file-menu-action" type="button" onClick={() => handleImportProject()}>
                      <span className="file-menu-icon"><FileArrowUp size={17} /></span>
                      <span className="file-menu-copy"><strong>{t("importProject")}</strong><small>{t("importProjectHint")}</small></span>
                      <span className="file-menu-format">.timeline</span>
                    </button>
                    <button className="file-menu-action is-primary" type="button" onClick={handleExportProject}>
                      <span className="file-menu-icon"><FileArrowDown size={17} /></span>
                      <span className="file-menu-copy"><strong>{t("exportProject")}</strong><small>{t("exportProjectHint")}</small></span>
                      <span className="file-menu-format">.timeline</span>
                    </button>
                    <div className="file-menu-divider" />
                    <nav className="file-menu-resources" aria-label={t("resourceLinks")}>
                      <a href="/features/">{t("resourceFeatures")}</a>
                      <a href="/how-it-works/">{t("resourceGuide")}</a>
                      <a href="/faq/">{t("resourceFaq")}</a>
                      <a href="/privacy/">{t("resourcePrivacy")}</a>
                    </nav>
                  </div>
                </Popover>
              ) : null}
              <input ref={projectFileInputRef} className="project-file-input" type="file" accept="application/zip,.timeline" onChange={(event) => event.target.files?.[0] && handleImportProject(event.target.files[0])} />
            </div>
          </div>
          <div className="autosave">
            <ShieldCheck size={13} weight="fill" />
            {t("autosave")} · {lastSaved}
            {currentCloudProject && (
              <span style={{ marginLeft: 6, color: "#818cf8", fontWeight: 500 }}>
                · Cloud: {currentCloudProject.title} (Rev {currentCloudProject.current_revision})
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="topbar-center">
        <button className="ghost-action" type="button" title={`${t("undo")} · ${shortcutModifier}+Z`} onClick={(event) => { undo(); releasePointerActivatedFocus(event); }}>
          <ArrowCounterClockwise size={16} />
          {t("undo")}
        </button>
        <button className="ghost-action" type="button" title={`${t("redo")} · ${shortcutModifier}+Shift+Z`} onClick={(event) => { redo(); releasePointerActivatedFocus(event); }}>
          <ArrowClockwise size={16} />
          {t("redo")}
        </button>
        <span className="divider" />
        <div className="menu-anchor" ref={ratioAnchorRef}>
          <button
            className="ratio-select"
            type="button"
            onClick={() => setShowRatioMenu((open) => !open)}
          >
            {ratio.label} <CaretDown size={14} />
          </button>
          {showRatioMenu ? (
            <Popover anchorRef={ratioAnchorRef} closeLabel={t("close")} showClose={false} onClose={() => setShowRatioMenu(false)}>
              <div className="menu-list">
                {RATIO_OPTIONS.map((option) => (
                  <button
                    type="button"
                    className={option.id === ratioId ? "is-selected" : ""}
                    key={option.id}
                    onClick={() => {
                      setRatioId(option.id);
                      setShowRatioMenu(false);
                      notify(`画布比例已切换为 ${option.label}`);
                    }}
                  >
                    {option.label}
                    <span>
                      {option.width} x {option.height}
                    </span>
                  </button>
                ))}
              </div>
            </Popover>
          ) : null}
        </div>
      </div>

      <div className="topbar-actions">
        <nav className="topbar-community-links" aria-label={t("communityLinks", "社区链接")}>
          <a
            href={COMMUNITY_LINKS.discord}
            target="_blank"
            rel="noreferrer"
            aria-label={t("discordCommunity", "Discord 社区")}
            title={t("discordCommunity", "Discord 社区")}
          >
            <DiscordLogo size={19} weight="fill" aria-hidden="true" />
          </a>
          <a
            href={COMMUNITY_LINKS.github}
            target="_blank"
            rel="noreferrer"
            aria-label={t("githubRepository", "GitHub 仓库")}
            title={t("githubRepository", "GitHub 仓库")}
          >
            <GithubLogo size={19} weight="fill" aria-hidden="true" />
          </a>
          <a
            href={COMMUNITY_LINKS.x}
            target="_blank"
            rel="noreferrer"
            aria-label={t("xProfile", "X 个人主页")}
            title={t("xProfile", "X 个人主页")}
          >
            <XLogo size={19} weight="fill" aria-hidden="true" />
          </a>
        </nav>
        <button className="preview-button" type="button" title={`${t("shortcutPlayPause")} · Space`} onClick={(event) => { handlePlayToggle(); releasePointerActivatedFocus(event); }}>
          {isPlaying ? <Pause size={16} weight="fill" /> : <Play size={16} weight="fill" />}
          {t("preview")}
        </button>
        <div className="menu-anchor" ref={exportAnchorRef}>
          <button
            className="export-button"
            type="button"
            aria-expanded={showExportMenu}
            disabled={exporting}
            onClick={() => setShowExportMenu((open) => !open)}
          >
            <FileArrowDown size={17} weight="bold" />
            {exporting ? t("exporting") : t(exportSettings.mediaType === "audio" ? "audioExportTitle" : "exportVideo")}
            {!exporting ? <CaretDown size={13} weight="bold" /> : null}
          </button>
          {showExportMenu ? (
            <Popover anchorRef={exportAnchorRef} className="export-settings-popover" closeLabel={t("close")} onClose={() => setShowExportMenu(false)}>
              <ExportSettingsPanel
                t={t}
                ratio={ratio}
                imageSrc={imageSrc}
                timelineDuration={timelineDuration}
                exportSettings={exportSettings}
                setExportSettings={setExportSettings}
                handleExportVideo={handleExportVideo}
                handleCloudRender={handleCloudRender}
                onClose={() => setShowExportMenu(false)}
              />
            </Popover>
          ) : null}
        </div>
        <div className="menu-anchor" ref={settingsAnchorRef}>
          <IconButton label={t("settings")} active={showSettings} onClick={() => setShowSettings((open) => !open)}>
            <GearSix size={19} />
          </IconButton>
          {showSettings ? (
            <Popover anchorRef={settingsAnchorRef} closeLabel={t("close")} onClose={() => setShowSettings(false)}>
              <div className="settings-panel">
                <strong>{t("exportSettings")}</strong>
                <label>
                  <span>{t("language")}</span>
                  <select
                    value={activeLanguage}
                    onChange={(event) => {
                      const nextLanguage = event.target.value;
                      saveLanguagePreference(nextLanguage);
                      setUiLanguage(nextLanguage);
                    }}
                  >
                    {APP_LANGUAGES.map((language) => (
                      <option value={language.id} key={language.id}>
                        {language.nativeName}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={captionsEnabled}
                    onChange={(event) => setCaptionsEnabled(event.target.checked)}
                  />
                  {t("exportCaptions")}
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={trackVisibility.audio}
                    onChange={() => toggleTrackVisibility("audio")}
                  />
                  {t("enableAudioTrack")}
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={trackVisibility.source}
                    onChange={() => toggleTrackVisibility("source")}
                  />
                  {t("enableSourceTrack")}
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={trackVisibility.music}
                    onChange={() => toggleTrackVisibility("music")}
                  />
                  {t("enableMusicTrack")}
                </label>
                <section className="shortcut-guide" aria-labelledby="shortcut-guide-title">
                  <div className="shortcut-guide-heading">
                    <strong id="shortcut-guide-title">{t("keyboardShortcuts")}</strong>
                    <span>Timeline Studio</span>
                  </div>
                  <p>{t("keyboardShortcutsHint")}</p>
                  <dl>
                    {shortcutRows.map(([labelKey, shortcut]) => (
                      <div key={labelKey}>
                        <dt>{t(labelKey)}</dt>
                        <dd><kbd>{shortcut}</kbd></dd>
                      </div>
                    ))}
                  </dl>
                </section>
                <div ref={modelCacheControlRef} className="model-cache-control">
                  {modelCacheInspection.state !== "idle" ? (
                    <div className={`model-cache-result is-${modelCacheInspection.state}`} role="status" aria-live="polite">
                      <strong>{modelCacheInspection.state === "checking"
                        ? t("modelCacheChecking")
                        : modelCacheInspection.state === "unavailable"
                          ? t("modelCacheUnavailable")
                          : modelCacheSummary}</strong>
                      {modelCacheInspection.state === "ready" && modelCacheStorage ? <span>{modelCacheStorage}</span> : null}
                    </div>
                  ) : null}
                  <button type="button" disabled={modelCacheInspection.state === "checking"} onClick={checkModelCache}>
                    <span>{modelCacheInspection.state === "checking" ? t("modelCacheChecking") : t("checkModelCache")}</span>
                    {modelCacheInspection.state === "checking" ? <CircleNotch className="is-spinning" size={15} /> : <Database size={15} />}
                  </button>
                </div>
              </div>
            </Popover>
          ) : null}
        </div>
        <IconButton
          label={currentUser ? `Account: ${currentUser.displayName || currentUser.email}` : "Sign In / Account"}
          active={Boolean(currentUser) || showAuthModal}
          onClick={() => setShowAuthModal(true)}
        >
          <UserCircle size={19} weight={currentUser ? "fill" : "regular"} />
        </IconButton>
      </div>
      <AuthModal
        isOpen={showAuthModal}
        onClose={() => setShowAuthModal(false)}
        user={currentUser}
        onAuthSuccess={(user) => {
          setLocalUser(user);
          propOnAuthSuccess?.(user);
          notify?.(`Signed in as ${user.displayName || user.email}`);
        }}
        onLogout={() => {
          setLocalUser(null);
          propOnLogout?.();
          notify?.("Signed out.");
        }}
      />
      <CloudProjectsModal
        isOpen={showCloudProjectsModal}
        onClose={() => setShowCloudProjectsModal(false)}
        currentCloudProjectId={currentCloudProject?.id}
        onOpenProject={handleOpenCloudProject}
        notify={notify}
      />
    </header>
  );
}
