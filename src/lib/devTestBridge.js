/**
 * Development-only test bridge for local Playwright / E2E test inspection.
 * This module is only imported in DEV mode and is excluded from the production runtime.
 */
export function registerDevTestBridge({
  getProjectSnapshot,
  sceneDetection,
  handleApplySceneCuts,
  setIsAssistantExpanded,
  handleApplyAssistantPlan,
  handleApplyGeneratedProject,
}) {
  if (typeof window === "undefined" || !import.meta.env.DEV) {
    return () => {};
  }

  window.__PROJECT_SNAPSHOT__ = getProjectSnapshot;

  const handleTestOpenSceneDetection = (e) => {
    sceneDetection?.open?.(e?.detail?.result || e?.detail?.prefill);
  };
  const handleTestApplySceneCuts = (e) => {
    handleApplySceneCuts?.(e?.detail || {});
  };
  const handleTestOpenAssistant = () => {
    setIsAssistantExpanded?.(true);
  };
  const handleTestApplyAssistantPlan = (e) => {
    if (e?.detail?.project && e?.detail?.plan) {
      handleApplyAssistantPlan?.(e.detail.project, e.detail.plan, e.detail.mediaOrigins);
    }
  };
  const handleTestApplyProject = (e) => {
    if (e?.detail) {
      handleApplyGeneratedProject?.(e.detail);
    }
  };

  window.addEventListener("test:open-scene-detection", handleTestOpenSceneDetection);
  window.addEventListener("test:apply-scene-cuts", handleTestApplySceneCuts);
  window.addEventListener("test:open-ai-assistant", handleTestOpenAssistant);
  window.addEventListener("test:apply-ai-assistant-plan", handleTestApplyAssistantPlan);
  window.addEventListener("test:apply-project", handleTestApplyProject);
  window.addEventListener("test:apply-ai-generator-project", handleTestApplyProject);

  return () => {
    delete window.__PROJECT_SNAPSHOT__;
    window.removeEventListener("test:open-scene-detection", handleTestOpenSceneDetection);
    window.removeEventListener("test:apply-scene-cuts", handleTestApplySceneCuts);
    window.removeEventListener("test:open-ai-assistant", handleTestOpenAssistant);
    window.removeEventListener("test:apply-ai-assistant-plan", handleTestApplyAssistantPlan);
    window.removeEventListener("test:apply-project", handleTestApplyProject);
    window.removeEventListener("test:apply-ai-generator-project", handleTestApplyProject);
  };
}
