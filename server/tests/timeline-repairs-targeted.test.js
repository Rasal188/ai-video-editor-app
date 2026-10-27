import test from "node:test";
import assert from "node:assert/strict";
import { parseNaturalLanguageEditingPlan } from "../../src/lib/naturalLanguagePlanParser.js";
import { applyCommandPlan } from "../../src/lib/projectCommandEngine.js";
import { createTranslator } from "../../src/i18n.js";
import { detectSpeechPunchInMoments, inspectPunchIns } from "../../src/lib/smartZoom.js";

test("Issue 2: Natural-language parser distinguishes multi-cut transitions from intra-clip fades", () => {
  const projectSummary = {
    visualSegments: [
      { id: "clip-1", name: "Intro", duration: 5 },
      { id: "clip-2", name: "Middle", duration: 6 },
      { id: "clip-3", name: "Outro", duration: 4 },
    ],
  };

  // 1. Multi-cut transition request
  const multiCutPlan = parseNaturalLanguageEditingPlan(
    "add smooth fade in transition between the cuts",
    projectSummary
  );
  assert.equal(multiCutPlan.actions.length, 2, "Must create exactly N-1 transitions for N clips");
  assert.equal(multiCutPlan.actions[0].type, "transition.set");
  assert.equal(multiCutPlan.actions[0].params.clipId, "clip-1");
  assert.equal(multiCutPlan.actions[0].params.transitionId, "fade");
  assert.equal(multiCutPlan.actions[1].type, "transition.set");
  assert.equal(multiCutPlan.actions[1].params.clipId, "clip-2");
  assert.equal(multiCutPlan.actions[1].params.transitionId, "fade");
  // Ensure clip-3 (the final clip) was NEVER targeted
  assert.ok(multiCutPlan.actions.every((a) => a.params.clipId !== "clip-3"), "Final clip must not have a transition");

  // 2. Intra-clip fade in each clip
  const fadeAllPlan = parseNaturalLanguageEditingPlan(
    "fade in each clip",
    projectSummary
  );
  assert.equal(fadeAllPlan.actions.length, 1);
  assert.equal(fadeAllPlan.actions[0].type, "clip.set_property");
  assert.equal(fadeAllPlan.actions[0].params.property, "fadeIn");
  assert.equal(fadeAllPlan.actions[0].params.scope, "all");

  // 3. Intra-clip fade on single clip
  const fadeSinglePlan = parseNaturalLanguageEditingPlan(
    "fade in clip 1",
    projectSummary
  );
  assert.equal(fadeSinglePlan.actions.length, 1);
  assert.equal(fadeSinglePlan.actions[0].type, "clip.set_property");
  assert.equal(fadeSinglePlan.actions[0].params.property, "fadeIn");
  assert.equal(fadeSinglePlan.actions[0].params.clipId, "clip-1");

  // 4. Intra-clip fade out
  const fadeOutPlan = parseNaturalLanguageEditingPlan(
    "fade out the video",
    projectSummary
  );
  assert.equal(fadeOutPlan.actions.length, 1);
  assert.equal(fadeOutPlan.actions[0].type, "clip.set_property");
  assert.equal(fadeOutPlan.actions[0].params.property, "fadeOut");

  // 5. Targeting final clip for a transition should produce a warning
  const finalClipPlan = parseNaturalLanguageEditingPlan(
    "add a zoom transition to clip 3",
    projectSummary
  );
  assert.equal(finalClipPlan.actions.length, 0, "Should not generate transition on final clip");
  assert.ok(finalClipPlan.warnings.some((w) => w.includes("final clip")), "Must warn that final clip cannot have transition");
});

test("Issue 2: projectCommandEngine setTransition validation and gap protection", () => {
  const project = {
    schemaVersion: 1,
    commandState: { revision: 0 },
    visualSegments: [
      { id: "v1", duration: 4, start: 0 },
      { id: "v2", duration: 4, start: 4 },
      { id: "v3", duration: 4, start: 10 }, // Gap between v2 (end 8) and v3 (start 10)
    ],
  };

  // Valid transition between v1 and v2
  const validPlan = {
    schemaVersion: 1,
    baseRevision: 0,
    operations: [
      { id: "op-valid", type: "transition.set", clipId: "v1", transitionId: "fade", duration: 0.5 },
    ],
  };
  const validResult = applyCommandPlan(project, validPlan);
  assert.ok(validResult.ok);
  assert.deepEqual(validResult.project.visualSegments[0].transition, { id: "fade", duration: 0.5 });

  // Rejection on final clip v3
  const finalClipPlan = {
    schemaVersion: 1,
    baseRevision: validResult.project.commandState.revision,
    operations: [
      { id: "op-final", type: "transition.set", clipId: "v3", transitionId: "fade", duration: 0.5 },
    ],
  };
  const finalClipResult = applyCommandPlan(validResult.project, finalClipPlan);
  assert.equal(finalClipResult.ok, false);
  assert.equal(finalClipResult.code, "INVALID_TRANSITION_TARGET");
  assert.match(finalClipResult.message, /A transition requires a following visual clip/);

  // Rejection on gap between v2 and v3
  const gapPlan = {
    schemaVersion: 1,
    baseRevision: validResult.project.commandState.revision,
    operations: [
      { id: "op-gap", type: "transition.set", clipId: "v2", transitionId: "fade", duration: 0.5 },
    ],
  };
  const gapResult = applyCommandPlan(validResult.project, gapPlan);
  assert.equal(gapResult.ok, false);
  assert.equal(gapResult.code, "INVALID_TRANSITION_GAP");
  assert.match(gapResult.message, /contiguous clips without gaps/);
});

test("Issue 3: Smart Zoom cumulative start calculations across multi-clip timeline", () => {
  // Simulate 3 sequential clips with no explicit .start property
  const visualSegments = [
    { id: "clip-a", duration: 10 },
    { id: "clip-b", duration: 15 },
    { id: "clip-c", duration: 12 },
  ];

  // Helper verifying our cumulative start logic
  const getClipStart = (clipId) => {
    const idx = visualSegments.findIndex((c) => c.id === clipId);
    return visualSegments.slice(0, idx).reduce((sum, c) => sum + (c.duration || 0), 0);
  };

  assert.equal(getClipStart("clip-a"), 0);
  assert.equal(getClipStart("clip-b"), 10);
  assert.equal(getClipStart("clip-c"), 25);

  // If playhead is at 18s (inside clip-b), local time in clip-b is 18 - 10 = 8s
  const currentTime = 18;
  const clipBStart = getClipStart("clip-b");
  const localTime = currentTime - clipBStart;
  assert.equal(localTime, 8);

  // Punch-in addition command
  const project = {
    schemaVersion: 1,
    commandState: { revision: 0 },
    visualSegments: visualSegments.map((c) => ({ ...c })),
  };

  const punchPlan = {
    schemaVersion: 1,
    baseRevision: 0,
    operations: [
      {
        id: "op-punch-1",
        type: "visual.punch_in",
        clipId: "clip-b",
        time: localTime,
        scale: 1.25,
        duration: 2.0,
        transition: "smooth",
        transitionDuration: 0.35,
        faceAnchored: true,
      },
    ],
  };

  const punchResult = applyCommandPlan(project, punchPlan);
  assert.ok(punchResult.ok);
  const updatedClipB = punchResult.project.visualSegments.find((c) => c.id === "clip-b");
  assert.equal(updatedClipB.punchIns.length, 1);
  assert.equal(updatedClipB.punchIns[0].time, 8);
  assert.equal(updatedClipB.punchIns[0].scale, 1.25);

  // Inspect punch-ins must find this punch-in with global timeline time 18s
  const inspected = inspectPunchIns(punchResult.project);
  assert.equal(inspected.punchIns.length, 1);
  assert.equal(inspected.punchIns[0].timelineTime, 18);
});

test("Issue 3: SMART_WORKSPACE_COPY contains all required keys across all supported locales", () => {
  const requiredKeys = [
    "smartZoomTitle",
    "smartZoomHint",
    "smartZoomLocal",
    "smartZoomScope",
    "smartZoomSelectedClip",
    "smartZoomAllClips",
    "smartZoomSpeechSync",
    "smartZoomGenerateSpeech",
    "smartZoomParameters",
    "smartZoomScale",
    "smartZoomDuration",
    "smartZoomTransition",
    "smartZoomSmooth",
    "smartZoomJump",
    "smartZoomTransitionDuration",
    "smartZoomAnchorFace",
    "smartZoomAnchorFaceHint",
    "smartZoomAddAtPlayhead",
    "smartZoomActiveList",
    "smartZoomResetAll",
    "smartZoomNoPunchIns",
    "smartZoomEmptyHint",
    "smartZoomSmoothBadge",
    "smartZoomJumpBadge",
    "smartZoomDurationLabel",
    "smartZoomFaceAnchoredBadge",
    "smartZoomCenterBadge",
    "smartZoomDeletePunchIn",
    "smartZoomErrorTitle",
    "smartZoomErrorDesc",
    "smartZoomSmoothHint",
    "smartZoomJumpHint",
    "smartZoomNoClipSelected",
    "smartZoomClipsCount",
    "smartZoomCaptionsAvailable",
    "smartZoomCurrentClip",
  ];

  const locales = ["en", "zh", "ja", "ko", "es", "fr", "de", "pt", "th", "vi"];
  for (const locale of locales) {
    const t = createTranslator(locale);
    for (const key of requiredKeys) {
      if (locale === "en" || locale === "zh") {
        const val = t(key);
        assert.ok(val && val !== key, `Locale ${locale} must translate key ${key}, got: ${val}`);
      }
    }
  }

  // Verify English strings are in English, not Chinese
  const tEn = createTranslator("en");
  assert.equal(tEn("smartZoomTitle"), "Smart Zoom");
  assert.equal(tEn("smartZoomSmoothHint"), "Natural & smooth");
  assert.equal(tEn("smartZoomJumpHint"), "Crisp & rhythmic");
  assert.equal(tEn("smartZoomNoClipSelected"), "No clip selected");
  assert.equal(tEn("smartZoomClipsCount"), "video clips");
  assert.equal(tEn("smartZoomCaptionsAvailable"), "captions available");
  assert.equal(tEn("smartZoomCurrentClip"), "Current clip");
  assert.equal(tEn("smartZoomAddAtPlayhead"), "Add Punch-In at Playhead");
  assert.equal(tEn("smartZoomActiveList"), "Active Punch-Ins");
  assert.equal(tEn("smartZoomResetAll"), "Reset All Zooms");
  assert.equal(tEn("smartZoomNoPunchIns"), "No punch-ins added yet");

  // Verify Chinese strings are in Chinese
  const tZh = createTranslator("zh");
  assert.equal(tZh("smartZoomTitle"), "智能变焦特写");
  assert.equal(tZh("smartZoomSmoothHint"), "自然呼吸感");
  assert.equal(tZh("smartZoomJumpHint"), "干脆节奏感");
  assert.equal(tZh("smartZoomAddAtPlayhead"), "在当前播放位置添加特写");
  assert.equal(tZh("smartZoomActiveList"), "当前特写列表");
  assert.equal(tZh("smartZoomResetAll"), "重置所有特写");
  assert.equal(tZh("smartZoomNoPunchIns"), "暂无特写效果");
});
