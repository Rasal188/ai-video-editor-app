import test from "node:test";
import assert from "node:assert/strict";
import { createTranslator } from "../../src/i18n.js";
import { SMART_FRAME_COPY } from "../../src/i18nSmartFrame.js";

const SMART_FRAME_KEYS = [
  "smartFrameCurrentClip",
  "smartFrameCurrentClipHint",
  "smartFrameGpuPreferred",
  "smartFrameSelectClip",
  "smartFrameSelectClipHint",
  "smartFrameTargetRatio",
  "smartFrameSelectedClip",
  "smartFrameMotion",
  "smartFrameMotionHint",
  "smartFrameMotion_locked",
  "smartFrameMotionHint_locked",
  "smartFrameMotion_smooth",
  "smartFrameMotionHint_smooth",
  "smartFrameMotion_responsive",
  "smartFrameMotionHint_responsive",
  "smartFramePadding",
  "smartFrameCancelAnalysis",
  "smartFrameAnalyzeAgain",
  "smartFrameAnalyzeClip",
  "smartFrameModelSetup",
  "smartFrameClipAnalysis",
  "smartFrameCompare",
  "smartFrameBefore",
  "smartFrameAfter",
  "smartFrameAnchors",
  "smartFrameFlowFrames",
  "smartFramePathPoints",
  "smartFrameWebGpuRuntime",
  "smartFrameWasmRuntime",
  "smartFrameLegacyRuntime",
  "smartFrameSafeContain",
  "smartFrameRemove",
  "smartFrameLocalNote",
];

const CHINESE_CHAR_REGEX = /[\u4e00-\u9fa5]/;

test("SMART_FRAME_COPY covers all expected keys in both en and zh", () => {
  assert.ok(SMART_FRAME_COPY.en, "English copy dictionary must exist");
  assert.ok(SMART_FRAME_COPY.zh, "Chinese copy dictionary must exist");

  for (const key of SMART_FRAME_KEYS) {
    assert.ok(SMART_FRAME_COPY.en[key], `Missing English key in SMART_FRAME_COPY: ${key}`);
    assert.ok(SMART_FRAME_COPY.zh[key], `Missing Chinese key in SMART_FRAME_COPY: ${key}`);
  }
});

test("createTranslator('en') resolves all smartFrame keys to valid English with no Chinese characters", () => {
  const t = createTranslator("en");

  for (const key of SMART_FRAME_KEYS) {
    const text = t(key);
    assert.ok(text, `Translation for ${key} must not be empty`);
    assert.notEqual(text, key, `Translation for ${key} must not return the key literal`);
    assert.ok(
      !CHINESE_CHAR_REGEX.test(text),
      `English translation for ${key} must not contain Chinese characters, got: "${text}"`
    );
  }
});

test("createTranslator('zh') resolves all smartFrame keys to valid Chinese", () => {
  const t = createTranslator("zh");

  for (const key of SMART_FRAME_KEYS) {
    const text = t(key);
    assert.ok(text, `Translation for ${key} must not be empty`);
    assert.notEqual(text, key, `Translation for ${key} must not return the key literal`);
    assert.ok(
      CHINESE_CHAR_REGEX.test(text),
      `Chinese translation for ${key} must contain Chinese characters, got: "${text}"`
    );
  }
});

test("createTranslator motion keys resolve properly in both languages", () => {
  const tEn = createTranslator("en");
  const tZh = createTranslator("zh");

  assert.equal(tEn("smartFrameMotion_locked"), "Locked");
  assert.equal(tZh("smartFrameMotion_locked"), "稳镜");

  assert.equal(tEn("smartFrameMotion_smooth"), "Smooth");
  assert.equal(tZh("smartFrameMotion_smooth"), "平滑");

  assert.equal(tEn("smartFrameMotion_responsive"), "Responsive");
  assert.equal(tZh("smartFrameMotion_responsive"), "灵敏");
});
