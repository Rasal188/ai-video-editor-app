import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

describe("Smart Hub Cleanup & Retained Tools Regression Verification", () => {
  const panelsPath = path.resolve(process.cwd(), "src/components/panels.jsx");
  const voicePanelPath = path.resolve(process.cwd(), "src/components/VoicePanel.jsx");
  const editorSidebarPath = path.resolve(process.cwd(), "src/components/EditorSidebar.jsx");
  const appPath = path.resolve(process.cwd(), "src/App.jsx");

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

  it("verifies EditorSidebar does not pass avatar handlers", () => {
    const sidebarContent = fs.readFileSync(editorSidebarPath, "utf8");
    assert.strictEqual(sidebarContent.includes("openAvatarPanel"), false, "EditorSidebar must not pass openAvatarPanel");
  });
});
