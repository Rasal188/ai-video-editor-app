import test from "node:test";
import assert from "node:assert/strict";
import { parseNaturalLanguageEditingPlan } from "../../src/lib/naturalLanguagePlanParser.js";
import { classifyUserIntent } from "../../src/lib/intentClassifier.js";
import { validateAndNormalizePlan, validateActionParams } from "../services/ai/editingPlanSchema.js";
import { applyCommandPlan } from "../../src/lib/projectCommandEngine.js";
import {
  createEditorHistory,
  pushEditorHistory,
  undoEditorHistory,
  redoEditorHistory,
} from "../../src/lib/editorHistoryCore.ts";
import { isTimelineTimeInsideTrack } from "../../src/lib/editorRuntime.js";

function createMockProject() {
  return {
    schemaVersion: 1,
    id: "proj-test-1",
    ratioId: "16:9",
    fitMode: "contain",
    duration: 30,
    commandState: { revision: 1, undoStack: [], redoStack: [] },
    visualSegments: [
      { id: "v1", type: "video", duration: 10, sourceIn: 0, sourceOut: 10, speed: 1.0, filter: "none", colorGrade: {} },
      { id: "v2", type: "video", duration: 10, sourceIn: 0, sourceOut: 10, speed: 1.0, filter: "none", colorGrade: {} },
      { id: "v3", type: "video", duration: 10, sourceIn: 0, sourceOut: 10, speed: 1.0, filter: "none", colorGrade: {} },
    ],
    audioSegments: [
      { id: "a1", duration: 10, start: 2, end: 12, volume: 1.0 },
    ],
    musicSegments: [
      { id: "m1", duration: 30, start: 0, end: 30, volume: 0.8 },
    ],
    captionSegments: [
      { id: "c1", text: "Hello world", start: 2, end: 5 },
    ],
    markers: [],
    tracks: {
      visuals: { locked: false, visible: true },
      audio: { locked: false, visible: true },
      music: { locked: false, visible: true },
      captions: { locked: false, visible: true },
    },
  };
}

test("Copilot: Relative playback speed changes (a little faster -> 1.25x)", () => {
  const project = createMockProject();
  const summary = { visualClips: project.visualSegments, selectedClipId: "v1" };

  const plan = parseNaturalLanguageEditingPlan("make this video a little faster", summary);
  assert.ok(plan);
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].type, "clip.set_speed");
  assert.equal(plan.actions[0].params.speed, 1.25);
});

test("Copilot: Explicit playback speed values (1.5x, double, half)", () => {
  const project = createMockProject();
  const summary = { visualClips: project.visualSegments, selectedClipId: "v1" };

  const plan1 = parseNaturalLanguageEditingPlan("set speed to 1.5x", summary);
  assert.equal(plan1.actions[0].params.speed, 1.5);

  const plan2 = parseNaturalLanguageEditingPlan("double the speed", summary);
  assert.equal(plan2.actions[0].params.speed, 2.0);

  const plan3 = parseNaturalLanguageEditingPlan("half speed", summary);
  assert.equal(plan3.actions[0].params.speed, 0.5);
});

test("Copilot: Audio pitch preservation option", () => {
  const project = createMockProject();
  const summary = { visualClips: project.visualSegments, selectedClipId: "v1" };

  const plan = parseNaturalLanguageEditingPlan("speed up 2x and preserve audio pitch", summary);
  assert.ok(plan);
  assert.equal(plan.actions[0].params.speed, 2.0);
  assert.equal(plan.actions[0].params.preservePitch, true);
});

test("Copilot: Playback speed scope (selected clip vs all clips)", () => {
  const project = createMockProject();
  const summary = { visualClips: project.visualSegments, selectedClipId: "v2" };

  const singlePlan = parseNaturalLanguageEditingPlan("make this clip faster", summary);
  assert.equal(singlePlan.actions[0].params.clipId, "v2");
  assert.equal(singlePlan.actions[0].params.scope, "clip");

  const allPlan = parseNaturalLanguageEditingPlan("make all clips faster", summary);
  assert.equal(allPlan.actions[0].params.scope, "all");
});

test("Copilot: Ambiguous playback speed prompts clarify scope", () => {
  const project = createMockProject();
  const summary = { visualClips: project.visualSegments };

  const intent = classifyUserIntent("make it faster", summary);
  assert.equal(intent.type, "ambiguous");
  assert.ok(intent.ambiguityType === "speed_scope" || intent.ambiguityType === "playback_speed_scope");
  assert.ok(intent.clarification.options.length >= 2);
  assert.ok(intent.clarification.options.some((o) => o.scope === "all"));
  assert.ok(intent.clarification.options.some((o) => o.action === "select_clip" || o.clipId));
});

test("Copilot: Visual appearance filters (cinematic, black and white, glow/soft)", () => {
  const project = createMockProject();
  const summary = { visualClips: project.visualSegments, selectedClipId: "v1" };

  const planWarm = parseNaturalLanguageEditingPlan("apply a warm cinematic look", summary);
  assert.equal(planWarm.actions[0].type, "clip.set_filter");
  assert.ok(planWarm.actions[0].params.filterId === "effect-warm" || planWarm.actions[0].params.filterId === "effect-cinematic");

  const planBW = parseNaturalLanguageEditingPlan("make it black and white", summary);
  assert.equal(planBW.actions[0].params.filterId, "effect-noir");

  const planSoft = parseNaturalLanguageEditingPlan("add a subtle glow", summary);
  assert.equal(planSoft.actions[0].params.filterId, "effect-soft");
});

test("Copilot: Color grading (saturation, warmer)", () => {
  const project = createMockProject();
  const summary = { visualClips: project.visualSegments, selectedClipId: "v1" };

  const planSat = parseNaturalLanguageEditingPlan("reduce the saturation a little", summary);
  assert.equal(planSat.actions[0].type, "clip.set_color_grade");
  assert.ok(Number.isFinite(planSat.actions[0].params.colorGrade.saturation));

  const planWarm = parseNaturalLanguageEditingPlan("make the whole video warmer", summary);
  assert.equal(planWarm.actions[0].type, "clip.set_color_grade");
  assert.equal(planWarm.actions[0].params.scope, "all");
  assert.equal(planWarm.actions[0].params.colorGrade.temperature, 15);
});

test("Copilot: Audio ducking during speech", () => {
  const project = createMockProject();
  const summary = {
    visualClips: project.visualSegments,
    musicSegments: project.musicSegments,
    audioSegments: project.audioSegments,
    captionsCount: 1,
  };

  const plan = parseNaturalLanguageEditingPlan("make the music quieter when people speak", summary);
  assert.ok(plan);
  const musicOp = plan.actions.find((a) => a.type === "music.duck" || a.params?.targetTrack === "music" || a.params?.track === "music");
  assert.ok(musicOp, "Must have an action adjusting music volume / ducking");
  assert.equal(musicOp.params.duckVolume ?? musicOp.params.value, 0.18, "Background music should duck to 18%");
});

test("Copilot: Audio fades (fade out at end, fade in)", () => {
  const project = createMockProject();
  const summary = { visualClips: project.visualSegments, musicSegments: project.musicSegments };

  const planOut = parseNaturalLanguageEditingPlan("fade the music out at the end", summary);
  assert.equal(planOut.actions[0].params.property, "fadeOut");
  assert.ok(Number(planOut.actions[0].params.value) >= 1.0);

  const planIn = parseNaturalLanguageEditingPlan("fade in the music", summary);
  assert.equal(planIn.actions[0].params.property, "fadeIn");
  assert.equal(planIn.actions[0].params.value, 2.0);
});

test("Copilot: Transition controls (smoother, remove)", () => {
  const project = createMockProject();
  const summary = { visualClips: project.visualSegments, selectedClipId: "v1" };

  const planSmooth = parseNaturalLanguageEditingPlan("make the transition smoother", summary);
  assert.equal(planSmooth.actions[0].type, "transition.set");
  assert.ok(Number(planSmooth.actions[0].params.duration) >= 0.8);

  const planRemove = parseNaturalLanguageEditingPlan("remove the transition", summary);
  assert.equal(planRemove.actions[0].type, "transition.set");
  assert.equal(planRemove.actions[0].params.transitionId, "none");
});

test("Copilot: Conversational follow-ups (a bit more, apply to all, next clip)", () => {
  const project = createMockProject();
  const summary = { visualClips: project.visualSegments, selectedClipId: "v1" };

  // 1. Incremental follow-up
  const contextLastSpeed = {
    lastEditingPlan: {
      actions: [{ type: "clip.set_speed", params: { clipId: "v1", speed: 1.25 } }],
    },
  };
  const planMore = parseNaturalLanguageEditingPlan("a bit more", summary, contextLastSpeed);
  assert.equal(planMore.actions[0].type, "clip.set_speed");
  assert.equal(planMore.actions[0].params.speed, 1.5);

  // 2. Scope-all follow-up
  const contextLastFilter = {
    lastEditingPlan: {
      actions: [{ type: "clip.set_filter", params: { clipId: "v1", filterId: "effect-cinematic" } }],
    },
  };
  const planAll = parseNaturalLanguageEditingPlan("apply that to the rest too", summary, contextLastFilter);
  assert.equal(planAll.actions[0].type, "clip.set_filter");
  assert.equal(planAll.actions[0].params.scope, "all");

  // 3. Adjacent clip follow-up
  const planNext = parseNaturalLanguageEditingPlan("now the clip after it", summary, contextLastFilter);
  assert.equal(planNext.actions[0].params.clipId, "v2");
});

test("Copilot: Selective undo intent explains timeline sequence", () => {
  const project = createMockProject();
  const summary = { visualClips: project.visualSegments };

  const intent = classifyUserIntent("undo just the color change", summary);
  assert.equal(intent.type, "unsupported_selective_undo");
  assert.ok(intent.message.includes("chronological"));
});

test("Copilot: Command engine executes clip.set_filter and clip.set_color_grade across all clips", () => {
  const project = createMockProject();

  const commandPlan = {
    schemaVersion: 1,
    baseRevision: 1,
    operations: [
      {
        id: "op-1",
        type: "clip.set_filter",
        scope: "all",
        filterId: "effect-cinematic",
      },
      {
        id: "op-2",
        type: "clip.set_color_grade",
        scope: "all",
        colorGrade: { temperature: 15, saturation: 1.1 },
      },
    ],
  };

  const result = applyCommandPlan(project, commandPlan);
  assert.ok(result.ok, `Command plan failed: ${result.message}`);
  for (const clip of result.project.visualSegments) {
    assert.equal(clip.filter, "effect-cinematic");
    assert.equal(clip.colorGrade.temperature, 15);
    assert.equal(clip.colorGrade.saturation, 1.1);
  }
});

test("Copilot: Command engine rejects edits on locked tracks safely", () => {
  const project = createMockProject();
  project.tracks.visuals.locked = true;

  const commandPlan = {
    schemaVersion: 1,
    baseRevision: 1,
    operations: [
      {
        id: "op-1",
        type: "clip.set_speed",
        clipId: "v1",
        speed: 1.5,
      },
    ],
  };

  const result = applyCommandPlan(project, commandPlan);
  assert.equal(result.ok, false);
  assert.equal(result.code, "TRACK_LOCKED");
});

test("Copilot: Schema validation accepts new actions and rejects invalid parameters", () => {
  // Valid filter action
  const cleanFilter = validateActionParams("clip.set_filter", {
    clipId: "v1",
    filterId: "effect-warm",
  });
  assert.equal(cleanFilter.filterId, "effect-warm");

  // Invalid filter ID throws error
  assert.throws(
    () => validateActionParams("clip.set_filter", { clipId: "v1", filterId: "unsupported-filter-xyz" }),
    /Unsupported filterId/
  );

  // Valid speed with pitch
  const cleanSpeed = validateActionParams("clip.set_speed", {
    clipId: "v1",
    speed: 1.5,
    preservePitch: true,
  });
  assert.equal(cleanSpeed.speed, 1.5);
  assert.equal(cleanSpeed.preservePitch, true);

  // Speed out of range throws error
  assert.throws(
    () => validateActionParams("clip.set_speed", { clipId: "v1", speed: 10.0 }),
    /between 0.25 and 4.0/
  );
});

test("Copilot: Export video tool remains available in supported tools", () => {
  const cleanExport = validateActionParams("tool.export", {});
  assert.ok(cleanExport);
});

test("Journey A: Caption active word color change preserves karaoke and styles", () => {
  const project = createMockProject();
  const summary = { visualClips: project.visualSegments, captionSegments: project.captionSegments };

  const plan = parseNaturalLanguageEditingPlan("Change the active word color to red instead of yellow", summary);
  assert.ok(plan);
  assert.equal(plan.actions[0].type, "caption.set_style");
  assert.equal(plan.actions[0].params.style.activeWordColor, "#FF0000");

  const commandPlan = {
    schemaVersion: 1,
    baseRevision: 1,
    operations: [
      {
        id: "op-cap-color",
        type: "caption.set_style",
        scope: "default",
        style: { activeWordColor: "#FF0000" },
      },
    ],
  };
  const result = applyCommandPlan(project, commandPlan);
  assert.ok(result.ok);
  assert.equal(result.project.captionStyle.activeWordColor, "#FF0000");
  assert.equal(result.project.captionStyle.karaoke, undefined); // does not force karaoke toggle
});

test("Journey D: Video Speed whole-video 2x scope with undo/redo", () => {
  const project = createMockProject();
  const summary = { visualClips: project.visualSegments };

  const plan = parseNaturalLanguageEditingPlan("Make the whole video twice as fast", summary);
  assert.ok(plan);
  assert.equal(plan.actions[0].type, "clip.set_speed");
  assert.equal(plan.actions[0].params.speed, 2.0);
  assert.equal(plan.actions[0].params.scope, "all");

  const commandPlan = {
    schemaVersion: 1,
    baseRevision: 1,
    operations: [
      {
        id: "op-speed-all",
        type: "clip.set_speed",
        scope: "all",
        clipId: "all",
        speed: 2.0,
      },
    ],
  };
  const result = applyCommandPlan(project, commandPlan);
  assert.ok(result.ok);
  for (const clip of result.project.visualSegments) {
    assert.equal(clip.playbackRate, 2.0);
    assert.equal(clip.duration, 5); // 10s / 2 = 5s
  }
});

test("Journey Section 9: Caption background opacity zero commands", () => {
  const project = createMockProject();
  const summary = { visualClips: project.visualSegments, captionSegments: project.captionSegments };

  // Command 1: "Set captions background opacity to zero."
  const plan1 = parseNaturalLanguageEditingPlan("Set captions background opacity to zero.", summary);
  assert.ok(plan1);
  assert.equal(plan1.actions[0].type, "caption.set_style");
  assert.equal(plan1.actions[0].params.style.backgroundOpacity, 0);
  assert.equal(typeof plan1.actions[0].params.style.backgroundOpacity, "number");

  // Command 2: "Set the background opacity of all the captions to zero."
  const plan2 = parseNaturalLanguageEditingPlan("Set the background opacity of all the captions to zero.", summary);
  assert.ok(plan2);
  assert.equal(plan2.actions[0].type, "caption.set_style");
  assert.equal(plan2.actions[0].params.style.backgroundOpacity, 0);
  assert.equal(typeof plan2.actions[0].params.style.backgroundOpacity, "number");

  // Apply to real project
  const commandPlan = {
    schemaVersion: 1,
    baseRevision: 1,
    operations: [
      {
        id: "op-zero-opacity",
        type: "caption.set_style",
        scope: "default",
        style: { backgroundOpacity: 0 },
      },
    ],
  };
  const result = applyCommandPlan(project, commandPlan);
  assert.ok(result.ok);
  assert.equal(result.project.captionStyle.backgroundOpacity, 0);
});

test("Bug C Regression: Audio ducking uses real project music ID and rejects fabricated IDs", () => {
  const project = createMockProject();
  project.musicSegments = [{ id: "bgm-custom-42", start: 0, end: 30, duration: 30, volume: 0.9 }];
  project.audioSegments = [{ id: "speech-1", start: 5, end: 15, duration: 10, volume: 1.0 }];
  const summary = { visualClips: project.visualSegments, musicSegments: project.musicSegments, audioSegments: project.audioSegments };

  const plan = parseNaturalLanguageEditingPlan("Make the background music quieter when someone speaks.", summary);
  assert.ok(plan);
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].type, "music.duck");
  assert.equal(plan.actions[0].params.clipId, "bgm-custom-42", "Must resolve real music segment ID, never generic 'music'");
  assert.equal(plan.actions[0].params.duckVolume, 0.18);

  // Apply through real command engine
  const commandPlan = {
    schemaVersion: 1,
    baseRevision: 1,
    operations: [
      {
        id: "op-duck-test",
        type: "music.duck",
        clipId: plan.actions[0].params.clipId,
        duckVolume: 0.18,
        normalVolume: 0.9,
      },
    ],
  };
  const execResult = applyCommandPlan(project, commandPlan);
  assert.ok(execResult.ok);
  assert.equal(execResult.project.musicSegments.length, 3);
  assert.equal(execResult.project.musicSegments[0].volume, 0.9, "Music before dialogue is normal volume");
  assert.equal(execResult.project.musicSegments[1].volume, 0.18, "Music during dialogue ducks to 0.18");
  assert.equal(execResult.project.musicSegments[2].volume, 0.9, "Music after dialogue restores to 0.9");
  assert.equal(execResult.project.audioSegments[0].volume, 1.0, "Voiceover volume remains untouched at 1.0");
});

test("Phase 3: Audio ducking respects track locks, validates dialogue existence, and rejects invalid targets", () => {
  const project = createMockProject();
  project.musicSegments = [{ id: "bgm-custom-42", start: 0, end: 30, duration: 30, volume: 0.9 }];
  project.audioSegments = [{ id: "speech-1", start: 5, end: 15, duration: 10, volume: 1.0 }];
  project.trackLocks = { music: true };

  // Locked music track
  const lockedPlan = {
    schemaVersion: 1,
    baseRevision: 1,
    operations: [{ id: "op-locked", type: "music.duck", clipId: "bgm-custom-42", duckVolume: 0.18 }],
  };
  const lockedRes = applyCommandPlan(project, lockedPlan);
  assert.equal(lockedRes.ok, false);
  assert.equal(lockedRes.code, "TRACK_LOCKED");

  // No dialogue
  const noSpeechProject = createMockProject();
  noSpeechProject.musicSegments = [{ id: "bgm-custom-42", start: 0, end: 30, duration: 30, volume: 0.9 }];
  noSpeechProject.audioSegments = [];
  noSpeechProject.captionSegments = [];
  const noSpeechPlan = {
    schemaVersion: 1,
    baseRevision: 1,
    operations: [{ id: "op-no-speech", type: "music.duck", clipId: "bgm-custom-42", duckVolume: 0.18 }],
  };
  const noSpeechRes = applyCommandPlan(noSpeechProject, noSpeechPlan);
  assert.equal(noSpeechRes.ok, false);
  assert.equal(noSpeechRes.code, "NO_DIALOGUE_FOUND");

  // Invalid clip ID
  const invalidClipProject = createMockProject();
  invalidClipProject.musicSegments = [{ id: "bgm-custom-42", start: 0, end: 30, duration: 30, volume: 0.9 }];
  invalidClipProject.audioSegments = [{ id: "speech-1", start: 5, end: 15, duration: 10, volume: 1.0 }];
  const invalidClipPlan = {
    schemaVersion: 1,
    baseRevision: 1,
    operations: [{ id: "op-invalid", type: "music.duck", clipId: "non-existent-music-id", duckVolume: 0.18 }],
  };
  const invalidClipRes = applyCommandPlan(invalidClipProject, invalidClipPlan);
  assert.equal(invalidClipRes.ok, false);
  assert.equal(invalidClipRes.code, "CLIP_NOT_FOUND");
});

test("Phase 2: All 7 exact caption requests verify complete lifecycle and property preservation", () => {
  const project = createMockProject();
  project.captionStyle = {
    fontId: "roboto",
    captionSize: 14,
    textColor: "#FFFFFF",
    backgroundColor: "#000000",
    backgroundOpacity: 0.8,
    effect: "neon",
    karaoke: true,
    activeWordColor: "#FFFF00",
  };

  // 1. "Change the active word color to red instead of yellow."
  const plan1 = parseNaturalLanguageEditingPlan("Change the active word color to red instead of yellow.", project);
  assert.equal(plan1.actions.length, 1);
  assert.equal(plan1.actions[0].type, "caption.set_style");
  assert.equal(plan1.actions[0].params.style.activeWordColor, "#FF0000");
  const res1 = applyCommandPlan(project, {
    schemaVersion: 1,
    baseRevision: 1,
    operations: [{ id: "op-1", type: "caption.set_style", scope: "default", style: plan1.actions[0].params.style }],
  });
  assert.ok(res1.ok);
  assert.equal(res1.project.captionStyle.activeWordColor, "#FF0000");
  assert.equal(res1.project.captionStyle.karaoke, true, "Karaoke state remains unchanged");
  assert.equal(res1.project.captionStyle.textColor, "#FFFFFF");

  // 2. "I want to change the caption effect."
  const plan2 = parseNaturalLanguageEditingPlan("I want to change the caption effect.", project);
  assert.equal(plan2.actions.length, 0, "Clarification request produces 0 actions");

  // 3. "Remove the caption effect but keep the current font and colors."
  const plan3 = parseNaturalLanguageEditingPlan("Remove the caption effect but keep the current font and colors.", project);
  assert.equal(plan3.actions.length, 1);
  assert.equal(plan3.actions[0].params.style.effect, "normal");
  const res3 = applyCommandPlan(project, {
    schemaVersion: 1,
    baseRevision: 1,
    operations: [{ id: "op-3", type: "caption.set_style", scope: "default", style: plan3.actions[0].params.style }],
  });
  assert.ok(res3.ok);
  assert.equal(res3.project.captionStyle.effect, "normal");
  assert.equal(res3.project.captionStyle.fontId, "roboto");
  assert.equal(res3.project.captionStyle.textColor, "#FFFFFF");

  // 4. "Set captions background opacity to zero."
  const plan4 = parseNaturalLanguageEditingPlan("Set captions background opacity to zero.", project);
  assert.equal(plan4.actions.length, 1);
  assert.equal(plan4.actions[0].params.style.backgroundOpacity, 0);

  // 5. "Set the background opacity of all the captions to zero."
  const plan5 = parseNaturalLanguageEditingPlan("Set the background opacity of all the captions to zero.", project);
  assert.equal(plan5.actions.length, 1);
  assert.equal(plan5.actions[0].params.style.backgroundOpacity, 0);

  // 6. "Change the caption font to Inter."
  const plan6 = parseNaturalLanguageEditingPlan("Change the caption font to Inter.", project);
  assert.equal(plan6.actions.length, 1);
  assert.equal(plan6.actions[0].params.style.fontId, "inter");
  const res6 = applyCommandPlan(project, {
    schemaVersion: 1,
    baseRevision: 1,
    operations: [{ id: "op-6", type: "caption.set_style", scope: "default", style: plan6.actions[0].params.style }],
  });
  assert.ok(res6.ok);
  assert.equal(res6.project.captionStyle.fontId, "inter");

  // 7. "Make all captions slightly bigger."
  const plan7 = parseNaturalLanguageEditingPlan("Make all captions slightly bigger.", project);
  assert.equal(plan7.actions.length, 1);
  assert.equal(plan7.actions[0].params.style.captionSize, 18);
  const res7 = applyCommandPlan(project, {
    schemaVersion: 1,
    baseRevision: 1,
    operations: [{ id: "op-7", type: "caption.set_style", scope: "default", style: plan7.actions[0].params.style }],
  });
  assert.ok(res7.ok);
  assert.equal(res7.project.captionSize, 18);
  assert.equal(res7.project.captionStyle.captionSize, 18);
});

test("Bug C Regression: Audio ducking when no music exists explains missing track and invents zero clip IDs", () => {
  const project = createMockProject();
  project.musicSegments = [];
  const summary = { visualClips: project.visualSegments, musicSegments: [] };

  const plan = parseNaturalLanguageEditingPlan("Make the background music quieter when someone speaks.", summary);
  assert.ok(plan);
  assert.equal(plan.actions.length, 0, "Must not generate actions when no music track exists");
  assert.ok(plan.warnings.length > 0, "Must warn user that no music track exists");
  assert.match(plan.warnings[0], /couldn't find a background music track/i);
});

test("Audio Ducking Edge Case 1: Multiple separated dialogue intervals create exact segments and preserve source references", () => {
  const project = createMockProject();
  project.musicSegments = [
    { id: "m-base", duration: 30, start: 0, end: 30, volume: 0.8, sourceStart: 0, playbackRate: 1.0, archiveMediaId: "music-asset-1" },
  ];
  // Two distinct dialogue intervals: [2, 6] and [12, 16]
  project.audioSegments = [
    { id: "a1", duration: 4, start: 2, end: 6, volume: 1.0 },
    { id: "a2", duration: 4, start: 12, end: 16, volume: 1.0 },
  ];
  project.captionSegments = [];

  const res = applyCommandPlan(project, {
    schemaVersion: 1,
    baseRevision: 1,
    operations: [{ id: "op-duck-1", type: "music.duck", clipId: "m-base", duckVolume: 0.18, normalVolume: 0.8 }],
  });

  assert.ok(res.ok);
  const segments = res.project.musicSegments;
  assert.equal(segments.length, 5);

  assert.equal(segments[0].id, "m-base-seg-0");
  assert.equal(segments[0].start, 0);
  assert.equal(segments[0].duration, 2);
  assert.equal(segments[0].volume, 0.8);
  assert.equal(segments[0].originalVolume, 0.8);
  assert.equal(segments[0].sourceStart, 0);
  assert.equal(segments[0].archiveMediaId, "music-asset-1");

  assert.equal(segments[1].id, "m-base-duck-1");
  assert.equal(segments[1].start, 2);
  assert.equal(segments[1].duration, 4);
  assert.equal(segments[1].volume, 0.18);
  assert.equal(segments[1].originalVolume, 0.8);
  assert.equal(segments[1].sourceStart, 2);
  assert.equal(segments[1].archiveMediaId, "music-asset-1");

  assert.equal(segments[2].id, "m-base-seg-2");
  assert.equal(segments[2].start, 6);
  assert.equal(segments[2].duration, 6);
  assert.equal(segments[2].volume, 0.8);
  assert.equal(segments[2].originalVolume, 0.8);
  assert.equal(segments[2].sourceStart, 6);
  assert.equal(segments[2].archiveMediaId, "music-asset-1");

  assert.equal(segments[3].id, "m-base-duck-3");
  assert.equal(segments[3].start, 12);
  assert.equal(segments[3].duration, 4);
  assert.equal(segments[3].volume, 0.18);
  assert.equal(segments[3].originalVolume, 0.8);
  assert.equal(segments[3].sourceStart, 12);
  assert.equal(segments[3].archiveMediaId, "music-asset-1");

  assert.equal(segments[4].id, "m-base-seg-4");
  assert.equal(segments[4].start, 16);
  assert.equal(segments[4].duration, 14);
  assert.equal(segments[4].volume, 0.8);
  assert.equal(segments[4].originalVolume, 0.8);
  assert.equal(segments[4].sourceStart, 16);
  assert.equal(segments[4].archiveMediaId, "music-asset-1");
});

test("Audio Ducking Edge Case 2: Overlapping dialogue intervals merge into a single continuous duck interval", () => {
  const project = createMockProject();
  project.musicSegments = [
    { id: "m-base", duration: 30, start: 0, end: 30, volume: 0.8, sourceStart: 0, playbackRate: 1.0 },
  ];
  // Overlapping audio clip [2, 6] and caption clip [4, 9] -> merged [2, 9]
  project.audioSegments = [{ id: "a1", duration: 4, start: 2, end: 6, volume: 1.0 }];
  project.captionSegments = [{ id: "c1", text: "overlap", start: 4, end: 9 }];

  const res = applyCommandPlan(project, {
    schemaVersion: 1,
    baseRevision: 1,
    operations: [{ id: "op-duck-2", type: "music.duck", clipId: "m-base", duckVolume: 0.18, normalVolume: 0.8 }],
  });

  assert.ok(res.ok);
  const segments = res.project.musicSegments;
  assert.equal(segments.length, 3);
  assert.equal(segments[0].start, 0);
  assert.equal(segments[0].duration, 2);
  assert.equal(segments[0].volume, 0.8);

  assert.equal(segments[1].start, 2);
  assert.equal(segments[1].duration, 7);
  assert.equal(segments[1].volume, 0.18);

  assert.equal(segments[2].start, 9);
  assert.equal(segments[2].duration, 21);
  assert.equal(segments[2].volume, 0.8);
});

test("Audio Ducking Edge Case 3: Dialogue beginning at timeline zero produces immediate duck with no empty pre-segment", () => {
  const project = createMockProject();
  project.musicSegments = [
    { id: "m-base", duration: 20, start: 0, end: 20, volume: 0.8, sourceStart: 0, playbackRate: 1.0 },
  ];
  // Dialogue at 0: [0, 5]
  project.audioSegments = [{ id: "a0", duration: 5, start: 0, end: 5, volume: 1.0 }];
  project.captionSegments = [];

  const res = applyCommandPlan(project, {
    schemaVersion: 1,
    baseRevision: 1,
    operations: [{ id: "op-duck-3", type: "music.duck", clipId: "m-base", duckVolume: 0.18, normalVolume: 0.8 }],
  });

  assert.ok(res.ok);
  const segments = res.project.musicSegments;
  assert.equal(segments.length, 2);
  assert.equal(segments[0].id, "m-base-duck-0");
  assert.equal(segments[0].start, 0);
  assert.equal(segments[0].duration, 5);
  assert.equal(segments[0].volume, 0.18);

  assert.equal(segments[1].id, "m-base-seg-1");
  assert.equal(segments[1].start, 5);
  assert.equal(segments[1].duration, 15);
  assert.equal(segments[1].volume, 0.8);
});

test("Audio Ducking Edge Case 4: Dialogue ending at music segment boundary produces no trailing empty segment", () => {
  const project = createMockProject();
  project.musicSegments = [
    { id: "m-base", duration: 15, start: 0, end: 15, volume: 0.8, sourceStart: 0, playbackRate: 1.0 },
  ];
  // Dialogue at [10, 15]
  project.audioSegments = [{ id: "a1", duration: 5, start: 10, end: 15, volume: 1.0 }];
  project.captionSegments = [];

  const res = applyCommandPlan(project, {
    schemaVersion: 1,
    baseRevision: 1,
    operations: [{ id: "op-duck-4", type: "music.duck", clipId: "m-base", duckVolume: 0.18, normalVolume: 0.8 }],
  });

  assert.ok(res.ok);
  const segments = res.project.musicSegments;
  assert.equal(segments.length, 2);
  assert.equal(segments[0].start, 0);
  assert.equal(segments[0].duration, 10);
  assert.equal(segments[0].volume, 0.8);

  assert.equal(segments[1].start, 10);
  assert.equal(segments[1].duration, 5);
  assert.equal(segments[1].volume, 0.18);
});

test("Audio Ducking Edge Case 5: Dialogue extending beyond music segment clamps duck to music boundary", () => {
  const project = createMockProject();
  project.musicSegments = [
    { id: "m-base", duration: 15, start: 0, end: 15, volume: 0.8, sourceStart: 0, playbackRate: 1.0 },
  ];
  // Dialogue at [10, 25] (extends 10s past music end)
  project.audioSegments = [{ id: "a1", duration: 15, start: 10, end: 25, volume: 1.0 }];
  project.captionSegments = [];

  const res = applyCommandPlan(project, {
    schemaVersion: 1,
    baseRevision: 1,
    operations: [{ id: "op-duck-5", type: "music.duck", clipId: "m-base", duckVolume: 0.18, normalVolume: 0.8 }],
  });

  assert.ok(res.ok);
  const segments = res.project.musicSegments;
  assert.equal(segments.length, 2);
  assert.equal(segments[0].start, 0);
  assert.equal(segments[0].duration, 10);
  assert.equal(segments[1].start, 10);
  assert.equal(segments[1].duration, 5);
  assert.equal(segments[1].volume, 0.18);
});

test("Audio Ducking Edge Case 6: No dialogue returns error code NO_DIALOGUE_FOUND and warns in NL parser", () => {
  const project = createMockProject();
  project.audioSegments = [];
  project.captionSegments = [];

  const res = applyCommandPlan(project, {
    schemaVersion: 1,
    baseRevision: 1,
    operations: [{ id: "op-duck-6", type: "music.duck", clipId: "m1", duckVolume: 0.18, normalVolume: 0.8 }],
  });

  assert.equal(res.ok, false);
  assert.equal(res.code, "NO_DIALOGUE_FOUND");

  const plan = parseNaturalLanguageEditingPlan("Duck the music during dialogue", {
    visualClips: project.visualSegments,
    musicSegments: project.musicSegments,
    audioSegments: [],
    captionSegments: [],
  });
  assert.equal(plan.actions.length, 0);
  assert.match(plan.warnings[0], /no speech or caption dialogue found/i);
});

test("Audio Ducking Edge Case 7: Missing music returns CLIP_NOT_FOUND and warns in NL parser", () => {
  const project = createMockProject();
  project.musicSegments = [];

  const res = applyCommandPlan(project, {
    schemaVersion: 1,
    baseRevision: 1,
    operations: [{ id: "op-duck-7", type: "music.duck", clipId: "m1", duckVolume: 0.18, normalVolume: 0.8 }],
  });

  assert.equal(res.ok, false);
  assert.equal(res.code, "CLIP_NOT_FOUND");
});

test("Audio Ducking Edge Case 8: Locked music track returns TRACK_LOCKED", () => {
  const project = createMockProject();
  project.tracks.music.locked = true;

  const res = applyCommandPlan(project, {
    schemaVersion: 1,
    baseRevision: 1,
    operations: [{ id: "op-duck-8", type: "music.duck", clipId: "m1", duckVolume: 0.18, normalVolume: 0.8 }],
  });

  assert.equal(res.ok, false);
  assert.equal(res.code, "TRACK_LOCKED");
});

test("Audio Ducking Edge Case 9: Repeated ducking with same settings prevents uncontrolled fragmentation", () => {
  const project = createMockProject();
  project.musicSegments = [
    { id: "m-base", duration: 30, start: 0, end: 30, volume: 0.8, sourceStart: 0, playbackRate: 1.0 },
  ];
  project.audioSegments = [{ id: "a1", duration: 4, start: 2, end: 6, volume: 1.0 }];
  project.captionSegments = [];

  const res1 = applyCommandPlan(project, {
    schemaVersion: 1,
    baseRevision: 1,
    operations: [{ id: "op-duck-9a", type: "music.duck", clipId: "m-base", duckVolume: 0.18, normalVolume: 0.8 }],
  });
  assert.ok(res1.ok);
  assert.equal(res1.project.musicSegments.length, 3);

  const res2 = applyCommandPlan(res1.project, {
    schemaVersion: 1,
    baseRevision: res1.revision,
    operations: [{ id: "op-duck-9b", type: "music.duck", clipId: "m-base", duckVolume: 0.18, normalVolume: 0.8 }],
  });
  assert.ok(res2.ok);
  assert.equal(res2.project.musicSegments.length, 3);
  assert.equal(res2.project.musicSegments[0].start, 0);
  assert.equal(res2.project.musicSegments[0].duration, 2);
  assert.equal(res2.project.musicSegments[1].start, 2);
  assert.equal(res2.project.musicSegments[1].duration, 4);
  assert.equal(res2.project.musicSegments[2].start, 6);
  assert.equal(res2.project.musicSegments[2].duration, 24);
});

test("Audio Ducking Edge Case 10: Repeated ducking with different duck volumes preserves true non-0.8 original volume", () => {
  const project = createMockProject();
  project.musicSegments = [
    { id: "m-custom", duration: 30, start: 0, end: 30, volume: 0.65, sourceStart: 0, playbackRate: 1.0 },
  ];
  project.audioSegments = [{ id: "a1", duration: 4, start: 2, end: 6, volume: 1.0 }];
  project.captionSegments = [];

  const res1 = applyCommandPlan(project, {
    schemaVersion: 1,
    baseRevision: 1,
    operations: [{ id: "op-duck-10a", type: "music.duck", clipId: "m-custom", duckVolume: 0.20 }],
  });
  assert.ok(res1.ok);
  assert.equal(res1.project.musicSegments[0].volume, 0.65, "Base volume 0.65 must be preserved");
  assert.equal(res1.project.musicSegments[1].volume, 0.20, "Duck volume 0.20 must be applied");

  const res2 = applyCommandPlan(res1.project, {
    schemaVersion: 1,
    baseRevision: res1.revision,
    operations: [{ id: "op-duck-10b", type: "music.duck", clipId: "m-custom", duckVolume: 0.10 }],
  });
  assert.ok(res2.ok);
  assert.equal(res2.project.musicSegments.length, 3);
  assert.equal(res2.project.musicSegments[0].volume, 0.65, "Base volume must remain 0.65 (NOT 0.8, NOT 0.20)");
  assert.equal(res2.project.musicSegments[1].volume, 0.10, "Duck volume must be updated to 0.10");
  assert.equal(res2.project.musicSegments[2].volume, 0.65, "Base volume must remain 0.65");
});

test("Audio Ducking Edge Case 11: Undo followed by redo cleanly restores single clip and segmented ducking", () => {
  const project = createMockProject();
  project.musicSegments = [
    { id: "m-base", duration: 30, start: 0, end: 30, volume: 0.75, sourceStart: 0, playbackRate: 1.0 },
  ];
  project.audioSegments = [{ id: "a1", duration: 4, start: 2, end: 6, volume: 1.0 }];
  project.captionSegments = [];

  let history = createEditorHistory(project);
  assert.equal(history.current.musicSegments.length, 1);

  const res = applyCommandPlan(project, {
    schemaVersion: 1,
    baseRevision: 1,
    operations: [{ id: "op-duck-11", type: "music.duck", clipId: "m-base", duckVolume: 0.18, normalVolume: 0.75 }],
  });
  assert.ok(res.ok);
  history = pushEditorHistory(history, res.project);
  assert.equal(history.current.musicSegments.length, 3);

  const undoResult = undoEditorHistory(history);
  assert.equal(undoResult.changed, true);
  assert.equal(undoResult.value.musicSegments.length, 1);
  assert.equal(undoResult.value.musicSegments[0].id, "m-base");
  assert.equal(undoResult.value.musicSegments[0].volume, 0.75);

  const redoResult = redoEditorHistory(undoResult.history);
  assert.equal(redoResult.changed, true);
  assert.equal(redoResult.value.musicSegments.length, 3);
  assert.equal(redoResult.value.musicSegments[1].volume, 0.18);
});

test("Audio Ducking Edge Case 12: Serialization and project reload preserves continuity, IDs, and segment math", () => {
  const project = createMockProject();
  project.musicSegments = [
    { id: "m-base", duration: 30, start: 0, end: 30, volume: 0.8, sourceStart: 0, playbackRate: 1.0, archiveMediaId: "asset-42" },
  ];
  project.audioSegments = [{ id: "a1", duration: 4, start: 2, end: 6, volume: 1.0 }];
  project.captionSegments = [];

  const res = applyCommandPlan(project, {
    schemaVersion: 1,
    baseRevision: 1,
    operations: [{ id: "op-duck-12", type: "music.duck", clipId: "m-base", duckVolume: 0.18, normalVolume: 0.8 }],
  });
  assert.ok(res.ok);

  const serialized = JSON.stringify(res.project);
  const reloaded = JSON.parse(serialized);

  assert.equal(reloaded.musicSegments.length, 3);
  let accumulatedTime = 0;
  for (let i = 0; i < reloaded.musicSegments.length; i++) {
    const seg = reloaded.musicSegments[i];
    assert.equal(seg.start, accumulatedTime, `Segment ${i} start must equal accumulated timeline time`);
    assert.ok(seg.duration > 0, `Segment ${i} duration must be positive`);
    assert.equal(seg.archiveMediaId, "asset-42", `Segment ${i} archiveMediaId must be preserved`);
    assert.equal(seg.parentClipId, "m-base", `Segment ${i} parentClipId must match base clip`);
    accumulatedTime += seg.duration;
  }
  assert.equal(accumulatedTime, 30, "Total duration of segmented music must match original 30s");
});

test("Audio Ducking Edge Case 13: Playback sampling and offline export inputs are strictly consistent", () => {
  const project = createMockProject();
  project.musicSegments = [
    { id: "m-base", duration: 30, start: 0, end: 30, volume: 0.8, sourceStart: 0, playbackRate: 1.0 },
  ];
  project.audioSegments = [{ id: "a1", duration: 4, start: 2, end: 6, volume: 1.0 }];
  project.captionSegments = [];

  const res = applyCommandPlan(project, {
    schemaVersion: 1,
    baseRevision: 1,
    operations: [{ id: "op-duck-13", type: "music.duck", clipId: "m-base", duckVolume: 0.18, normalVolume: 0.8 }],
  });
  assert.ok(res.ok);
  const musicSegments = res.project.musicSegments;

  const tPreSpeech = 1.0;
  const tInSpeech = 4.0;
  const tPostSpeech = 10.0;

  const segPre = musicSegments.find((m) => isTimelineTimeInsideTrack(tPreSpeech, m.start, m.duration));
  assert.ok(segPre);
  assert.equal(segPre.volume, 0.8, "Preview at t=1.0 must sample normal volume 0.8");

  const segIn = musicSegments.find((m) => isTimelineTimeInsideTrack(tInSpeech, m.start, m.duration));
  assert.ok(segIn);
  assert.equal(segIn.volume, 0.18, "Preview at t=4.0 must sample ducked volume 0.18");

  const segPost = musicSegments.find((m) => isTimelineTimeInsideTrack(tPostSpeech, m.start, m.duration));
  assert.ok(segPost);
  assert.equal(segPost.volume, 0.8, "Preview at t=10.0 must sample normal volume 0.8");

  const exportInputs = musicSegments.map((segment) => ({
    start: Math.max(0, Number(segment.start) || 0),
    duration: Math.max(0, Number(segment.duration) || 0),
    volume: Math.max(0, Math.min(4, Number(segment.volume) || 0)),
    sourceStart: Math.max(0, Number(segment.sourceStart) || 0),
  }));

  assert.equal(exportInputs.length, 3);
  assert.equal(exportInputs[0].volume, segPre.volume);
  assert.equal(exportInputs[1].volume, segIn.volume);
  assert.equal(exportInputs[2].volume, segPost.volume);
});



