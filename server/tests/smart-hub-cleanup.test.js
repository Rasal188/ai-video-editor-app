import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

describe("Smart Hub Cleanup & Retained Tools Regression Verification", () => {
  const panelsPath = path.resolve(process.cwd(), "src/components/panels.jsx");
  const voicePanelPath = path.resolve(process.cwd(), "src/components/VoicePanel.jsx");
  const editorSidebarPath = path.resolve(process.cwd(), "src/components/EditorSidebar.jsx");
  const appPath = path.resolve(process.cwd(), "src/App.jsx");
  const vocalSeparationPath = path.resolve(process.cwd(), "src/lib/vocalSeparation.js");
  const vocalSeparationWorkerPath = path.resolve(process.cwd(), "src/workers/vocal-separation.worker.js");
  const vocalSeparationHookPath = path.resolve(process.cwd(), "src/hooks/useVocalSeparation.js");

  it("verifies Auto Edit and Digital Human cards are removed from Smart Hub in panels.jsx", () => {
    const panelsContent = fs.readFileSync(panelsPath, "utf8");

    // Must NOT contain auto-edit or avatar in smart tools list
    assert.strictEqual(panelsContent.includes('"auto-edit"'), false, "panels.jsx should not contain 'auto-edit' tool");
    assert.strictEqual(panelsContent.includes('data-testid="smart-tool-auto-edit"'), false, "panels.jsx should not have auto-edit test id");
    assert.strictEqual(panelsContent.includes('["avatar"'), false, "panels.jsx should not contain 'avatar' in smart tool array");
    assert.strictEqual(panelsContent.includes('openAvatarPanel'), false, "panels.jsx should not have openAvatarPanel");

    // Must contain all 6 retained tools
    assert.strictEqual(panelsContent.includes('"smart-pipeline"'), true, "panels.jsx must retain smart-pipeline");
    assert.strictEqual(panelsContent.includes('"scene-detect"'), true, "panels.jsx must retain scene-detect");
    assert.strictEqual(panelsContent.includes('"rough-cut"'), true, "panels.jsx must retain rough-cut");
    assert.strictEqual(panelsContent.includes('"remove-pauses"'), true, "panels.jsx must retain remove-pauses");
    assert.strictEqual(panelsContent.includes('"ai-music"'), true, "panels.jsx must retain ai-music");
    assert.strictEqual(panelsContent.includes('"smart-frame"'), true, "panels.jsx must retain smart-frame");
  });

  it("verifies VoicePanel does not expose AutoEditPanel or AutoEditReviewDialog", () => {
    const voiceContent = fs.readFileSync(voicePanelPath, "utf8");

    assert.strictEqual(voiceContent.includes("AutoEditPanel"), false, "VoicePanel should not contain AutoEditPanel");
    assert.strictEqual(voiceContent.includes("AutoEditReviewDialog"), false, "VoicePanel should not contain AutoEditReviewDialog");
    assert.strictEqual(voiceContent.includes("isSmartAutoContext"), false, "VoicePanel should not contain isSmartAutoContext");
    assert.strictEqual(voiceContent.includes("smartAutoEdit"), false, "VoicePanel should not reference smartAutoEdit");
    assert.strictEqual(voiceContent.includes("avatarPortingStatus"), false, "VoicePanel should not reference avatarPortingStatus");

    // Face Swap and audio synthesis must remain intact
    assert.strictEqual(voiceContent.includes("FaceSwapContextPanel"), true, "VoicePanel must retain FaceSwapContextPanel");
    assert.strictEqual(voiceContent.includes("VoiceSynthesisPanel"), true, "VoicePanel must retain VoiceSynthesisPanel");
  });

  it("verifies App.jsx does not instantiate or wire autoEdit or avatar generation", () => {
    const appContent = fs.readFileSync(appPath, "utf8");

    assert.strictEqual(appContent.includes("useAutoEdit"), false, "App.jsx should not import or call useAutoEdit");
    assert.strictEqual(appContent.includes("useAvatarGeneration"), false, "App.jsx should not import or call useAvatarGeneration");
    assert.strictEqual(appContent.includes("openAvatarPanel"), false, "App.jsx should not contain openAvatarPanel");
    assert.strictEqual(appContent.includes("avatarPanelOpen"), false, "App.jsx should not contain avatarPanelOpen");
    assert.strictEqual(appContent.includes("avatarJob"), false, "App.jsx should not contain avatarJob");
    assert.strictEqual(appContent.includes("autoEdit={autoEdit}"), false, "App.jsx should not pass autoEdit prop");

    // Must default smartMode to smart-pipeline
    assert.strictEqual(appContent.includes('useState("smart-pipeline")'), true, "smartMode must default to 'smart-pipeline'");
  });

  it("routes assistant gap-removal and rough-cut actions through retained Smart Tools", () => {
    const appContent = fs.readFileSync(appPath, "utf8");

    assert.strictEqual(
      appContent.includes("const openAssistantSmartReview = async (tool, mode, request = {}) =>"),
      true,
      "assistant Smart actions must use the shared target-aware review launcher",
    );
    assert.strictEqual(
      appContent.includes("return tool.run({ ...request, clipId });"),
      true,
      "assistant Smart actions must run real analysis rather than only navigate",
    );
    assert.match(
      appContent,
      /onOpenSilenceRemoval=\{\(request\)\s*=>\s*openAssistantSmartReview\(\s*silenceRemoval,\s*"remove-pauses",\s*request\s*\)\s*\}/,
      "assistant silence-removal actions must open and run the retained Remove Pauses tool",
    );
    assert.match(
      appContent,
      /onOpenRoughCut=\{\(request\)\s*=>\s*openAssistantSmartReview\(\s*roughCut,\s*"rough-cut",\s*request\s*\)\s*\}/,
      "assistant rough-cut actions must open and run the retained Rough Cut tool",
    );
    assert.strictEqual(appContent.includes("silenceRemoval.open()"), false, "App.jsx must not call a nonexistent silence-removal open method");
    assert.strictEqual(appContent.includes("roughCut.open()"), false, "App.jsx must not call a nonexistent rough-cut open method");
  });

  it("constructs a classic vocal-separation worker with a compatible runtime loader", () => {
    const vocalSeparationContent = fs.readFileSync(vocalSeparationPath, "utf8");
    const workerContent = fs.readFileSync(vocalSeparationWorkerPath, "utf8");

    assert.match(
      vocalSeparationContent,
      /new Worker\([\s\S]*vocal-separation\.worker\.js[\s\S]*\)/,
      "vocal separation must construct its worker",
    );
    assert.strictEqual(
      vocalSeparationContent.includes('{ type: "module" }'),
      false,
      "the importScripts-based TensorFlow loader requires a classic worker",
    );
    assert.strictEqual(
      /^\s*import\s/m.test(workerContent),
      false,
      "the classic vocal-separation worker must not contain static imports",
    );
    assert.strictEqual(
      workerContent.includes("cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0"),
      true,
      "missing local TensorFlow assets must fall back to a pinned runtime",
    );
    assert.strictEqual(
      workerContent.includes("loadFirstScript(TF_WEBGPU_URLS);"),
      true,
      "a successfully imported WebGPU bundle must not be loaded again when adapter initialization is unavailable",
    );
    assert.strictEqual(
      workerContent.includes('loadFirstScript(TF_WEBGPU_URLS, () => Boolean(self.tf?.findBackend?.("webgpu")))'),
      false,
      "WebGPU adapter readiness must not control mirror fallback and duplicate backend registration",
    );
  });

  it("mutes embedded source audio only after separated stems are placed", () => {
    const appContent = fs.readFileSync(appPath, "utf8");
    const hookContent = fs.readFileSync(vocalSeparationHookPath, "utf8");

    assert.strictEqual(hookContent.includes("markEmbeddedAudioSeparated?.(track, segmentId, vocalSegment.id)"), true);
    assert.strictEqual(appContent.includes("sourceAudioDisabled: true, audioSeparated: true"), true);
    assert.strictEqual(appContent.includes("muted: true, audioSeparated: true"), true);
  });

  it("verifies EditorSidebar does not pass avatar handlers", () => {
    const sidebarContent = fs.readFileSync(editorSidebarPath, "utf8");
    assert.strictEqual(sidebarContent.includes("openAvatarPanel"), false, "EditorSidebar must not pass openAvatarPanel");
  });
});
