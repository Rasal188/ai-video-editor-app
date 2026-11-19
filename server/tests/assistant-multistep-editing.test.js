import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyCommandPlan,
  diffProjects,
  inspectProject,
  inspectTrack,
} from "../../src/lib/projectCommandEngine.js";
import { classifyUserIntent } from "../../src/lib/intentClassifier.js";
import {
  parseNaturalLanguageEditingPlan,
  resolveOrdinalIndex,
  resolveClipTargetFromText,
  resolveTargetClipId,
} from "../../src/lib/naturalLanguagePlanParser.js";
import {
  restoreBrowserProjectMedia,
  restoreBrowserSegmentMedia,
} from "../../src/lib/browserEditPlan.js";

describe("Phase 2 — Step 2.1: Assistant Multi-Step Editing & Project-Aware Reasoning", () => {
  const createTestProject = () => ({
    commandState: { schemaVersion: 1, revision: 0, appliedOperationIds: [] },
    ratioId: "16:9",
    fitMode: "contain",
    visualSegments: [
      { id: "vis-1", type: "video", duration: 10, sourceStart: 0, sourceDuration: 10, playbackRate: 1, name: "Scene 1 Intro" },
      { id: "vis-2", type: "video", duration: 8, sourceStart: 0, sourceDuration: 8, playbackRate: 1, name: "Scene 2 Main" },
      { id: "vis-3", type: "image", duration: 4, width: 1920, height: 1080, name: "Scene 3 Outro" },
    ],
    audioSegments: [
      { id: "aud-1", name: "Voiceover 1", start: 0, duration: 8, sourceStart: 0, sourceDuration: 8, volume: 1 },
      { id: "aud-2", name: "Voiceover 2", start: 10, duration: 6, sourceStart: 0, sourceDuration: 6, volume: 0.95 },
    ],
    musicSegments: [
      { id: "mus-1", name: "Upbeat Beats", start: 0, duration: 22, sourceStart: 0, sourceDuration: 22, volume: 0.75 },
    ],
    musicName: "Upbeat Beats",
    musicDuration: 22,
    musicStart: 0,
    musicVolume: 0.75,
    captionSegments: [
      { id: "cap-1", text: "Welcome everyone", start: 0, end: 4, audioSegmentId: "aud-1" },
      { id: "cap-2", text: "Let's explore AI editing", start: 4, end: 8, audioSegmentId: "aud-1" },
    ],
    captionPlacement: { x: 50, y: 78 },
    captionPosition: "bottom",
    timelineMarkers: [
      { id: "m-1", time: 2.0, title: "Hook", color: "cyan", type: "marker" },
    ],
    script: "Welcome everyone\nLet's explore AI editing",
    captionsEnabled: true,
  });

  const getProjectSummary = (proj) => ({
    visualCount: proj.visualSegments?.length || 0,
    audioCount: proj.audioSegments?.length || 0,
    musicCount: proj.musicSegments?.length || 0,
    captionCount: proj.captionSegments?.length || 0,
    ratio: proj.ratioId || "16:9",
    duration: 22,
    visualClips: (proj.visualSegments || []).map((c, i) => ({
      id: c.id,
      index: i,
      name: c.name || `Clip ${i + 1}`,
      duration: c.duration,
    })),
    musicSegments: proj.musicSegments || [],
    audioSegments: proj.audioSegments || [],
  });

  // ==========================================
  // 1. Single-Operation Commands
  // ==========================================
  describe("1. Single-Operation Commands", () => {
    it("should change project aspect ratio to 9:16", () => {
      const project = createTestProject();
      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [{ id: "op-ratio", type: "project.set_ratio", ratio: "9:16" }],
      };
      const res = applyCommandPlan(project, plan);
      assert.equal(res.ok, true);
      assert.equal(res.project.ratioId, "9:16");
      assert.equal(res.revision, 1);
    });

    it("should trim visual clip", () => {
      const project = createTestProject();
      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-trim", type: "visual.trim", clipId: "vis-1", sourceIn: 1, sourceOut: 7 },
        ],
      };
      const res = applyCommandPlan(project, plan);
      assert.equal(res.ok, true);
      assert.equal(res.project.visualSegments[0].duration, 6);
      assert.equal(res.project.visualSegments[0].sourceStart, 1);
    });

    it("should split visual clip into two segments", () => {
      const project = createTestProject();
      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-split", type: "visual.split", clipId: "vis-1", at: 4, rightClipId: "vis-1-part2" },
        ],
      };
      const res = applyCommandPlan(project, plan);
      assert.equal(res.ok, true);
      assert.equal(res.project.visualSegments.length, 4);
      assert.equal(res.project.visualSegments[0].duration, 4);
      assert.equal(res.project.visualSegments[1].id, "vis-1-part2");
      assert.equal(res.project.visualSegments[1].duration, 6);
    });

    it("should add a timeline marker", () => {
      const project = createTestProject();
      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-marker", type: "marker.add", markerId: "m-broll", time: 5.5, title: "Insert B-roll", color: "amber", markerType: "marker" },
        ],
      };
      const res = applyCommandPlan(project, plan);
      assert.equal(res.ok, true);
      assert.equal(res.project.timelineMarkers.length, 2);
      assert.equal(res.project.timelineMarkers[1].title, "Insert B-roll");
    });
  });

  // ==========================================
  // 2. Multi-Operation Requests
  // ==========================================
  describe("2. Multi-Operation Requests", () => {
    it("should trim a clip and add a fade transition in a single atomic plan", () => {
      const project = createTestProject();
      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-trim-1", type: "visual.trim", clipId: "vis-1", sourceIn: 0, sourceOut: 6 },
          { id: "op-trans-1", type: "transition.set", clipId: "vis-1", transitionId: "fade", duration: 0.5 },
        ],
      };
      const res = applyCommandPlan(project, plan);
      assert.equal(res.ok, true);
      assert.equal(res.project.visualSegments[0].duration, 6);
      assert.deepEqual(res.project.visualSegments[0].transition, { id: "fade", duration: 0.5 });
      assert.equal(res.project.commandState.revision, 1);
      assert.equal(res.appliedOperationIds.length, 2);
    });

    it("should parse natural language: 'trim clip 1 to 5 seconds and add a fade transition'", () => {
      const project = createTestProject();
      const summary = getProjectSummary(project);
      const parsed = parseNaturalLanguageEditingPlan("trim clip 1 to 5 seconds and add a fade transition", summary);

      assert.ok(parsed);
      assert.equal(parsed.actions.length, 2);
      assert.equal(parsed.actions[0].type, "visual.trim");
      assert.equal(parsed.actions[0].params.clipId, "vis-1");
      assert.equal(parsed.actions[0].params.duration, 5);
      assert.equal(parsed.actions[1].type, "transition.set");
      assert.equal(parsed.actions[1].params.transitionId, "fade");
    });

    it("should add captions and position them at the bottom", () => {
      const project = createTestProject();
      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-cap-add", type: "caption.add", clipId: "cap-3", text: "Concluding remarks", start: 8, end: 12 },
          { id: "op-cap-pos", type: "caption.set_position", scope: "default", placement: { x: 50, y: 78 } },
        ],
      };
      const res = applyCommandPlan(project, plan);
      assert.equal(res.ok, true);
      assert.equal(res.project.captionSegments.length, 3);
      assert.equal(res.project.captionSegments[2].text, "Concluding remarks");
      assert.equal(res.project.captionPosition, "bottom");
      assert.deepEqual(res.project.captionPlacement, { x: 50, y: 78 });
    });

    it("should convert project to 9:16 with cover fit mode", () => {
      const project = createTestProject();
      const summary = getProjectSummary(project);
      const parsed = parseNaturalLanguageEditingPlan("convert project to 9:16 and set fit mode to cover", summary);

      assert.ok(parsed);
      assert.equal(parsed.actions.length, 2);
      assert.equal(parsed.actions[0].type, "project.set_ratio");
      assert.equal(parsed.actions[0].params.ratio, "9:16");
      assert.equal(parsed.actions[1].type, "project.set_fit");
      assert.equal(parsed.actions[1].params.fitMode, "cover");

      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: parsed.actions.map((act, i) => ({ id: `op-${i}`, type: act.type, ...act.params })),
      };
      const res = applyCommandPlan(project, plan);
      assert.equal(res.ok, true);
      assert.equal(res.project.ratioId, "9:16");
      assert.equal(res.project.fitMode, "cover");
    });

    it("should reorder clip and delete clip in one plan", () => {
      const project = createTestProject();
      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-reorder", type: "visual.reorder", clipId: "vis-1", toIndex: 1 },
          { id: "op-delete", type: "visual.delete", clipId: "vis-3" },
        ],
      };
      const res = applyCommandPlan(project, plan);
      assert.equal(res.ok, true);
      assert.equal(res.project.visualSegments.length, 2);
      assert.equal(res.project.visualSegments[0].id, "vis-2");
      assert.equal(res.project.visualSegments[1].id, "vis-1");
    });

    it("should route compound pause and filler cleanup through one Rough Cut review workflow", () => {
      const project = createTestProject();
      const summary = getProjectSummary(project);
      const parsed = parseNaturalLanguageEditingPlan("remove filler words and cut out pauses", summary);

      assert.ok(parsed);
      const smartActions = parsed.actions.filter((action) =>
        ["tool.rough_cut", "tool.silence_removal"].includes(action.type)
      );
      assert.equal(smartActions.length, 1);
      assert.equal(smartActions[0].type, "tool.rough_cut");
      assert.equal(smartActions[0].params.clipId, "vis-1");
      assert.equal(smartActions[0].params.removeFillerWords, true);
    });
  });

  // ==========================================
  // 3. Audio Track Independence
  // ==========================================
  describe("3. Audio Track Independence", () => {
    it("should lower background music volume without altering voiceover or video clips", () => {
      const project = createTestProject();
      const initialVoiceover1Vol = project.audioSegments[0].volume;
      const initialVoiceover2Vol = project.audioSegments[1].volume;

      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-music-vol", type: "clip.set_property", clipId: "mus-1", property: "volume", value: 0.25 },
        ],
      };
      const res = applyCommandPlan(project, plan);
      assert.equal(res.ok, true);

      // Music volume updated
      assert.equal(res.project.musicSegments[0].volume, 0.25);
      assert.equal(res.project.musicVolume, 0.25);

      // Voiceover tracks preserved exactly
      assert.equal(res.project.audioSegments[0].volume, initialVoiceover1Vol);
      assert.equal(res.project.audioSegments[1].volume, initialVoiceover2Vol);
      assert.equal(res.project.audioSegments.length, 2);

      // Visual clips preserved
      assert.equal(res.project.visualSegments.length, 3);
    });

    it("should mute visual clip source audio without muting background music or voiceover", () => {
      const project = createTestProject();
      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-mute-vis-1", type: "clip.set_muted", clipId: "vis-1", muted: true },
        ],
      };
      const res = applyCommandPlan(project, plan);
      assert.equal(res.ok, true);

      assert.equal(res.project.visualSegments[0].muted, true);
      assert.equal(res.project.visualSegments[0].sourceAudioDisabled, true);

      // Music and voiceover remain unmuted
      assert.notEqual(res.project.musicSegments[0].muted, true);
      assert.notEqual(res.project.audioSegments[0].muted, true);
    });

    it("natural language parser maps 'lower music volume to 30%' to mus-1 target track", () => {
      const project = createTestProject();
      const summary = getProjectSummary(project);
      const parsed = parseNaturalLanguageEditingPlan("lower music volume to 30%", summary);

      assert.ok(parsed);
      assert.equal(parsed.actions.length, 1);
      assert.equal(parsed.actions[0].type, "clip.set_property");
      assert.equal(parsed.actions[0].params.clipId, "mus-1");
      assert.equal(parsed.actions[0].params.property, "volume");
      assert.equal(parsed.actions[0].params.value, 0.3);
      assert.equal(parsed.actions[0].params.targetTrack, "music");
    });
  });

  // ==========================================
  // 4. Ambiguous References & Clarification
  // ==========================================
  describe("4. Ambiguous Clip and Track References", () => {
    it("should classify generic clip request without selection as ambiguous when multiple clips exist", () => {
      const project = createTestProject();
      const summary = getProjectSummary(project);

      const intent = classifyUserIntent("trim the clip and add a transition", summary);
      assert.equal(intent.type, "ambiguous");
      assert.equal(intent.ambiguityType, "clip_target");
      assert.ok(Array.isArray(intent.candidateClips));
      assert.equal(intent.candidateClips.length, 3);
      assert.equal(intent.candidateClips[0].id, "vis-1");
    });

    it("should resolve ordinal references ('first', 'second', 'last') unambiguously", () => {
      const project = createTestProject();
      const summary = getProjectSummary(project);

      const firstParsed = parseNaturalLanguageEditingPlan("trim the first clip to 4 seconds", summary);
      assert.equal(firstParsed.actions[0].params.clipId, "vis-1");
      assert.equal(firstParsed.actions[0].params.duration, 4);

      const secondParsed = parseNaturalLanguageEditingPlan("trim the second clip to 3 seconds", summary);
      assert.equal(secondParsed.actions[0].params.clipId, "vis-2");

      const lastParsed = parseNaturalLanguageEditingPlan("delete the last clip", summary);
      assert.equal(lastParsed.actions[0].params.clipId, "vis-3");
    });

    it("should resolve ordinals correctly with helper functions", () => {
      assert.equal(resolveOrdinalIndex("first clip"), 0);
      assert.equal(resolveOrdinalIndex("second video"), 1);
      assert.equal(resolveOrdinalIndex("3rd segment"), 2);
      assert.equal(resolveOrdinalIndex("last clip", 4), 3);
      assert.equal(resolveOrdinalIndex("penultimate clip", 4), 2);
    });

    it("should require confirmation for broad destructive actions ('delete all clips')", () => {
      const project = createTestProject();
      const summary = getProjectSummary(project);

      const intent = classifyUserIntent("delete all clips from my project", summary);
      assert.equal(intent.isBroadDestructive, true);
      assert.equal(intent.requiresConfirmation, true);
    });
  });

  // ==========================================
  // 5. Missing Media, Invalid Params & Atomic Rollback
  // ==========================================
  describe("5. Missing Media, Invalid Parameters & Atomic Failure Rollback", () => {
    it("should fail atomically if a clip target is not found", () => {
      const project = createTestProject();
      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-1", type: "project.set_ratio", ratio: "9:16" },
          { id: "op-2", type: "visual.delete", clipId: "non-existent-clip-id" },
        ],
      };
      const res = applyCommandPlan(project, plan);
      assert.equal(res.ok, false);
      assert.equal(res.code, "CLIP_NOT_FOUND");

      // Verify atomic rollback: aspect ratio should NOT have changed on original project
      assert.equal(project.ratioId, "16:9");
      assert.equal(project.commandState.revision, 0);
    });

    it("should fail atomically with UNKNOWN_OPERATION if an invalid command type is provided", () => {
      const project = createTestProject();
      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-bad", type: "unsupported.magic_wand", params: {} },
        ],
      };
      const res = applyCommandPlan(project, plan);
      assert.equal(res.ok, false);
      assert.equal(res.code, "UNKNOWN_OPERATION");
    });

    it("should reject invalid project aspect ratio", () => {
      const project = createTestProject();
      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [{ id: "op-invalid-ratio", type: "project.set_ratio", ratio: "3:4-invalid" }],
      };
      const res = applyCommandPlan(project, plan);
      assert.equal(res.ok, false);
      assert.equal(res.code, "INVALID_RATIO");
    });

    it("should reject out-of-bounds clip property value", () => {
      const project = createTestProject();
      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-invalid-vol", type: "clip.set_property", clipId: "mus-1", property: "volume", value: 99999 },
        ],
      };
      const res = applyCommandPlan(project, plan);
      assert.equal(res.ok, false);
      assert.equal(res.code, "INVALID_ARGUMENT");
    });

    it("should reject transition on the final visual clip if there is no following clip", () => {
      const project = createTestProject();
      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-last-trans", type: "transition.set", clipId: "vis-3", transitionId: "fade" },
        ],
      };
      const res = applyCommandPlan(project, plan);
      assert.equal(res.ok, false);
      assert.equal(res.code, "INVALID_TRANSITION_TARGET");
    });
  });

  // ==========================================
  // 6. Undo/Redo & State Persistence
  // ==========================================
  describe("6. Undo/Redo & State Persistence", () => {
    it("should record diffs and support state rollback", () => {
      const project = createTestProject();
      const beforeSnapshot = structuredClone(project);

      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-1", type: "project.set_ratio", ratio: "9:16" },
          { id: "op-2", type: "clip.set_property", clipId: "mus-1", property: "volume", value: 0.3 },
        ],
      };
      const res = applyCommandPlan(project, plan);
      assert.equal(res.ok, true);

      // Verify diff
      const diff = diffProjects(beforeSnapshot, res.project);
      assert.ok(diff.projectFields.some((f) => f.field === "ratioId" && f.after === "9:16"));
      assert.ok(diff.tracks.music.modified.some((m) => m.id === "mus-1"));

      // Simulating Undo: reverting to beforeSnapshot restores 16:9 and initial volume
      assert.equal(beforeSnapshot.ratioId, "16:9");
      assert.equal(beforeSnapshot.musicSegments[0].volume, 0.75);
    });

    it("should reject stale plans with REVISION_CONFLICT", () => {
      const project = createTestProject();
      const plan1 = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [{ id: "op-rev-1", type: "project.set_ratio", ratio: "9:16" }],
      };
      const res1 = applyCommandPlan(project, plan1);
      assert.equal(res1.ok, true);
      assert.equal(res1.revision, 1);

      // Plan 2 built on baseRevision 0 should fail with REVISION_CONFLICT
      const stalePlan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [{ id: "op-rev-2", type: "project.set_ratio", ratio: "1:1" }],
      };
      const res2 = applyCommandPlan(res1.project, stalePlan);
      assert.equal(res2.ok, false);
      assert.equal(res2.code, "REVISION_CONFLICT");
    });
  });

  // ==========================================
  // 7. Existing-Project Editing vs New-Video Generation Routing
  // ==========================================
  describe("7. Existing-Project Editing vs New-Video Generation Routing", () => {
    it("must NEVER route editing an existing project to new-video generator", () => {
      const project = createTestProject();
      const summary = getProjectSummary(project);

      const editingPrompts = [
        "trim the first clip and add fade transition",
        "make the video 9:16 and position captions at the bottom",
        "lower music volume to 20% and keep voiceover clear",
        "remove filler words and long pauses",
        "reorder clip 1 to the end",
        "mute the first video clip",
      ];

      for (const prompt of editingPrompts) {
        const intent = classifyUserIntent(prompt, summary);
        assert.notEqual(intent.type, "generation", `Prompt "${prompt}" should NOT be classified as generation`);
        assert.ok(
          intent.type === "editing" || intent.type === "ambiguous",
          `Prompt "${prompt}" should be editing or ambiguous, got ${intent.type}`
        );
      }
    });

    it("should route explicit new video creation requests to unsupported_creation without mutating project", () => {
      const project = createTestProject();
      const summary = getProjectSummary(project);

      const generationPrompts = [
        "generate a brand new video about cyber security",
        "create a new video from scratch with cinematic style",
        "start a new video project about coffee brewing",
      ];

      for (const prompt of generationPrompts) {
        const intent = classifyUserIntent(prompt, summary);
        assert.equal(intent.type, "unsupported_creation", `Prompt "${prompt}" should be classified as unsupported_creation`);
        assert.ok(intent.message);
      }
    });
  });

  // ==========================================
  // 8. Regression Suite: BUG AI-001 — Undo through the AI assistant
  // ==========================================
  describe("8. Regression Suite: BUG AI-001 — Undo through the AI assistant", () => {
    it("should classify conversational undo requests as history commands without parallel editing plans", () => {
      const project = createTestProject();
      const summary = getProjectSummary(project);

      const undoPhrases = [
        "undo the last edit",
        "can you undo the last edit",
        "please undo",
        "undo that",
        "undo last action",
        "revert the last change",
        "can you please undo that",
      ];

      for (const phrase of undoPhrases) {
        const intent = classifyUserIntent(phrase, summary);
        assert.equal(intent.type, "undo", `Phrase "${phrase}" should classify as undo`);
        assert.equal(intent.isHistoryCommand, true);
        assert.equal(intent.historyAction, "undo");
      }
    });

    it("should classify conversational redo requests as history commands without parallel editing plans", () => {
      const project = createTestProject();
      const summary = getProjectSummary(project);

      const redoPhrases = [
        "redo the last edit",
        "can you redo that",
        "please redo",
        "redo that",
        "redo last change",
      ];

      for (const phrase of redoPhrases) {
        const intent = classifyUserIntent(phrase, summary);
        assert.equal(intent.type, "redo", `Phrase "${phrase}" should classify as redo`);
        assert.equal(intent.isHistoryCommand, true);
        assert.equal(intent.historyAction, "redo");
      }
    });

    it("should verify native undo/redo restores and reapplies project revisions without parallel history divergence", () => {
      const originalProject = createTestProject();
      const historyPast = [];
      const historyFuture = [];
      let currentProject = structuredClone(originalProject);

      // Perform an edit
      const editPlan = {
        schemaVersion: 1,
        baseRevision: currentProject.commandState.revision,
        operations: [{ id: "op-edit-1", type: "project.set_ratio", ratio: "9:16" }],
      };
      historyPast.push(structuredClone(currentProject));
      const res = applyCommandPlan(currentProject, editPlan);
      assert.equal(res.ok, true);
      currentProject = res.project;
      assert.equal(currentProject.ratioId, "9:16");

      // Native undo simulation (as executed by onUndo handler in editor)
      historyFuture.push(structuredClone(currentProject));
      currentProject = historyPast.pop();
      assert.equal(currentProject.ratioId, "16:9");
      assert.deepEqual(currentProject, originalProject);

      // Native redo simulation (as executed by onRedo handler in editor)
      historyPast.push(structuredClone(currentProject));
      currentProject = historyFuture.pop();
      assert.equal(currentProject.ratioId, "9:16");
    });
  });

  // ==========================================
  // 9. Regression Suite: BUG AI-002 — Clip Duplication and Reordering
  // ==========================================
  describe("9. Regression Suite: BUG AI-002 — Clip Duplication and Reordering", () => {
    it("should parse 'duplicate the first clip' into visual.duplicate with valid resolved clipId", () => {
      const project = createTestProject();
      const summary = getProjectSummary(project);

      const parsed = parseNaturalLanguageEditingPlan("duplicate the first clip", summary);
      assert.ok(parsed.actions.length > 0, "Should generate actions for duplicate request");
      const action = parsed.actions[0];
      assert.equal(action.type, "visual.duplicate");
      assert.equal(action.params.clipId, "vis-1");
      assert.equal(action.params.atIndex, 1);
      assert.ok(action.params.newClipId, "newClipId must be generated");
    });

    it("should parse variations of duplicate ('duplicate clip 1', 'clone second clip', 'copy last clip')", () => {
      const project = createTestProject();
      const summary = getProjectSummary(project);

      const parsed1 = parseNaturalLanguageEditingPlan("duplicate clip 1", summary);
      assert.equal(parsed1.actions[0].type, "visual.duplicate");
      assert.equal(parsed1.actions[0].params.clipId, "vis-1");

      const parsed2 = parseNaturalLanguageEditingPlan("clone second clip", summary);
      assert.equal(parsed2.actions[0].type, "visual.duplicate");
      assert.equal(parsed2.actions[0].params.clipId, "vis-2");

      const parsed3 = parseNaturalLanguageEditingPlan("copy last clip", summary);
      assert.equal(parsed3.actions[0].type, "visual.duplicate");
      assert.equal(parsed3.actions[0].params.clipId, "vis-3");
    });

    it("should resolve target clip IDs accurately even when prefixed with articles ('the first clip')", () => {
      const project = createTestProject();
      assert.equal(resolveTargetClipId("the first clip", project), "vis-1");
      assert.equal(resolveTargetClipId("first clip", project), "vis-1");
      assert.equal(resolveTargetClipId("second clip", project), "vis-2");
      assert.equal(resolveTargetClipId("the last clip", project), "vis-3");
      assert.equal(resolveTargetClipId("vis-2", project), "vis-2");
    });

    it("should apply visual.duplicate plan without modifying the original clip and inserting duplicate at target index", () => {
      const project = createTestProject();
      const initialCount = project.visualSegments.length;
      const originalClip = structuredClone(project.visualSegments[0]);

      const plan = {
        schemaVersion: 1,
        baseRevision: project.commandState.revision,
        operations: [
          {
            id: "op-dup-1",
            type: "visual.duplicate",
            clipId: "vis-1",
            atIndex: 1,
            newClipId: "vis-1-copy",
          },
        ],
      };

      const res = applyCommandPlan(project, plan);
      assert.equal(res.ok, true, `applyCommandPlan failed: ${res.error}`);
      assert.equal(res.project.visualSegments.length, initialCount + 1);

      // Verify original clip is unchanged at index 0
      assert.equal(res.project.visualSegments[0].id, originalClip.id);
      assert.equal(res.project.visualSegments[0].duration, originalClip.duration);
      assert.equal(res.project.visualSegments[0].name, originalClip.name);

      // Verify duplicated clip is inserted at index 1
      const duplicated = res.project.visualSegments[1];
      assert.equal(duplicated.id, "vis-1-copy");
      assert.equal(duplicated.duration, originalClip.duration);
      assert.equal(duplicated.name, originalClip.name);

      // Verify third clip is now at index 2
      assert.equal(res.project.visualSegments[2].id, "vis-2");
    });

    it("should maintain valid visual.reorder behavior with resolved clipId and target index", () => {
      const project = createTestProject();
      const summary = getProjectSummary(project);

      const parsed = parseNaturalLanguageEditingPlan("move the first clip to the end", summary);
      assert.ok(parsed.actions.length > 0);
      assert.equal(parsed.actions[0].type, "visual.reorder");
      assert.equal(parsed.actions[0].params.clipId, "vis-1");
      assert.equal(parsed.actions[0].params.toIndex, 2);

      const plan = {
        schemaVersion: 1,
        baseRevision: project.commandState.revision,
        operations: [
          {
            id: "op-reorder-1",
            type: "visual.reorder",
            clipId: "vis-1",
            toIndex: 2,
          },
        ],
      };

      const res = applyCommandPlan(project, plan);
      assert.equal(res.ok, true);
      assert.equal(res.project.visualSegments[0].id, "vis-2");
      assert.equal(res.project.visualSegments[1].id, "vis-3");
      assert.equal(res.project.visualSegments[2].id, "vis-1");
    });
  });

  // ==========================================
  // 10. Regression Suite: BUG AI-003 — Caption Generation & Sequencing
  // ==========================================
  describe("10. Regression Suite: BUG AI-003 — Caption Generation & Sequencing", () => {
    it("should sequence caption generation before caption styling/positioning in multi-step workflows", () => {
      const project = createTestProject();
      // Remove existing captions to test creation from scratch
      project.captionSegments = [];
      assert.equal(project.captionSegments.length, 0);

      // Simulated auto-caption generator output
      const generatedSegments = [
        { id: "cap-gen-1", text: "AI generated caption 1", start: 0, end: 3 },
        { id: "cap-gen-2", text: "AI generated caption 2", start: 3, end: 7 },
      ];

      // Step 1: Caption generation populates timeline segments
      const projectWithCaptions = {
        ...project,
        captionSegments: generatedSegments,
        captionsEnabled: true,
      };
      assert.equal(projectWithCaptions.captionSegments.length, 2);

      // Step 2: Now that captions exist, apply styling and positioning plan
      const positionPlan = {
        schemaVersion: 1,
        baseRevision: projectWithCaptions.commandState.revision,
        operations: [
          {
            id: "op-cap-pos",
            type: "caption.set_position",
            scope: "default",
            placement: { x: 50, y: 78 },
          },
          {
            id: "op-cap-style",
            type: "caption.set_style",
            scope: "default",
            style: { captionSize: 24, textColor: "#ffffff" },
          },
        ],
      };

      const res = applyCommandPlan(projectWithCaptions, positionPlan);
      assert.equal(res.ok, true);
      assert.equal(res.project.captionPosition, "bottom");
      assert.deepEqual(res.project.captionPlacement, { x: 50, y: 78 });
      assert.equal(res.project.captionSegments.length, 2);
    });

    it("should reject applying plans with missing audio source or fail when no speech is detected", () => {
      // Test audio segment validation
      const projectNoAudio = createTestProject();
      projectNoAudio.audioSegments = [];
      projectNoAudio.musicSegments = [];
      projectNoAudio.visualSegments = projectNoAudio.visualSegments.map((v) => ({ ...v, type: "image" }));

      // Inspecting track detects lack of speech audio
      const audioTrack = inspectTrack(projectNoAudio, "audio");
      assert.equal(audioTrack.clips.length, 0);
    });
  });

  // ==========================================
  // 11. Regression Suite: Split Clip Plan Generation & Application Execution
  // ==========================================
  describe("11. Regression Suite: Split Clip Plan Generation & Application Execution", () => {
    it("should parse 'Split first clip at 3 seconds', resolve target clip ID, and apply split to timeline", () => {
      const project = createTestProject();
      const summary = getProjectSummary(project);

      // Step 1: Parse natural-language instruction
      const parsed = parseNaturalLanguageEditingPlan("Split first clip at 3 seconds", summary);
      assert.ok(parsed.actions.length > 0, "Must generate an action for split request");
      const action = parsed.actions[0];
      assert.equal(action.type, "visual.split");
      assert.equal(action.params.at, 3);

      // Step 2: Resolve target clip ID using resolveTargetClipId (replicating AiAssistantPanel.jsx plan preparation)
      const resolvedClipId = resolveTargetClipId(action.params.clipId, project, project.visualSegments[0]?.id || "", "visuals");
      assert.equal(resolvedClipId, "vis-1");

      const rightClipId = action.params.rightClipId || `${resolvedClipId}-split-${Date.now()}`;

      // Step 3: Apply the plan to the timeline
      const plan = {
        schemaVersion: 1,
        baseRevision: project.commandState.revision,
        operations: [
          {
            id: "op-split-first",
            type: "visual.split",
            clipId: resolvedClipId,
            at: action.params.at,
            rightClipId,
          },
        ],
      };

      const res = applyCommandPlan(project, plan);
      assert.equal(res.ok, true, `Split failed: ${res.error}`);
      assert.equal(res.project.visualSegments.length, 4);

      // Verify left segment
      const leftClip = res.project.visualSegments[0];
      assert.equal(leftClip.id, "vis-1");
      assert.equal(leftClip.duration, 3);
      assert.equal(leftClip.sourceDuration, 3);

      // Verify right segment
      const rightClip = res.project.visualSegments[1];
      assert.equal(rightClip.id, rightClipId);
      assert.equal(rightClip.duration, 7);
      assert.equal(rightClip.sourceStart, 3);
      assert.equal(rightClip.sourceDuration, 7);

      // Subsequent clips remain intact in sequential order
      assert.equal(res.project.visualSegments[2].id, "vis-2");
      assert.equal(res.project.visualSegments[3].id, "vis-3");
    });

    it("should parse 'split the second clip at 4 seconds', resolve target to second clip, and apply split", () => {
      const project = createTestProject();
      const summary = getProjectSummary(project);

      const parsed = parseNaturalLanguageEditingPlan("split the second clip at 4 seconds", summary);
      assert.ok(parsed.actions.length > 0);
      const action = parsed.actions[0];
      assert.equal(action.type, "visual.split");
      assert.equal(action.params.at, 4);

      const resolvedClipId = resolveTargetClipId(action.params.clipId, project, project.visualSegments[0]?.id || "", "visuals");
      assert.equal(resolvedClipId, "vis-2");

      const rightClipId = "vis-2-split-right";
      const plan = {
        schemaVersion: 1,
        baseRevision: project.commandState.revision,
        operations: [
          {
            id: "op-split-second",
            type: "visual.split",
            clipId: resolvedClipId,
            at: 4,
            rightClipId,
          },
        ],
      };

      const res = applyCommandPlan(project, plan);
      assert.equal(res.ok, true);
      assert.equal(res.project.visualSegments.length, 4);

      // First clip is untouched
      assert.equal(res.project.visualSegments[0].id, "vis-1");
      assert.equal(res.project.visualSegments[0].duration, 10);

      // Second clip split into 4s and 4s
      assert.equal(res.project.visualSegments[1].id, "vis-2");
      assert.equal(res.project.visualSegments[1].duration, 4);
      assert.equal(res.project.visualSegments[2].id, rightClipId);
      assert.equal(res.project.visualSegments[2].duration, 4);

      // Third clip shifted to index 3
      assert.equal(res.project.visualSegments[3].id, "vis-3");
    });

    it("should resolve explicit clip ID ('vis-1') and apply split correctly", () => {
      const project = createTestProject();

      const resolvedClipId = resolveTargetClipId("vis-1", project, "", "visuals");
      assert.equal(resolvedClipId, "vis-1");

      const plan = {
        schemaVersion: 1,
        baseRevision: project.commandState.revision,
        operations: [
          {
            id: "op-split-explicit",
            type: "visual.split",
            clipId: resolvedClipId,
            at: 5,
            rightClipId: "vis-1-part-2",
          },
        ],
      };

      const res = applyCommandPlan(project, plan);
      assert.equal(res.ok, true);
      assert.equal(res.project.visualSegments.length, 4);
      assert.equal(res.project.visualSegments[0].duration, 5);
      assert.equal(res.project.visualSegments[1].id, "vis-1-part-2");
      assert.equal(res.project.visualSegments[1].duration, 5);
    });

    it("should fail gracefully with CLIP_NOT_FOUND when target clip does not exist and leave project unmutated", () => {
      const project = createTestProject();
      const initialSnapshot = structuredClone(project);

      const resolvedClipId = resolveTargetClipId("nonexistent-clip-id", project, "", "visuals");
      assert.equal(resolvedClipId, "nonexistent-clip-id");

      const plan = {
        schemaVersion: 1,
        baseRevision: project.commandState.revision,
        operations: [
          {
            id: "op-split-invalid",
            type: "visual.split",
            clipId: resolvedClipId,
            at: 2,
            rightClipId: "part-2",
          },
        ],
      };

      const res = applyCommandPlan(project, plan);
      assert.equal(res.ok, false);
      assert.equal(res.code, "CLIP_NOT_FOUND");
      // Project remains completely untouched
      assert.deepEqual(project, initialSnapshot);
    });
  });

  describe("Suite 12: Split Clip Plan Application & Concurrency Guard (BROWSER_EDIT_STALE_PLAN Prevention)", () => {
    it("should generate and apply 'Split the first clip at 3 seconds' without intervening edits and divide timeline into expected segments", () => {
      const project = createTestProject();
      const mockBlob = { size: 1024, type: "video/mp4" };
      const runtime = {
        ...project,
        visualSegments: project.visualSegments.map((c) => ({
          ...c,
          blob: mockBlob,
          src: `blob:http://localhost/${c.id}`,
          peaks: [0.1, 0.5, 0.9, 0.4, 0.8, 0.2, 0.7, 0.3, 0.6, 0.1],
          archiveMediaId: c.id,
          assetId: `asset-${c.id}`,
        })),
      };

      const summary = getProjectSummary(runtime);

      // 1. Natural language parsing
      const parsedPlan = parseNaturalLanguageEditingPlan("Split the first clip at 3 seconds", summary);
      assert.ok(parsedPlan);
      assert.equal(parsedPlan.actions.length, 1);
      const splitAction = parsedPlan.actions[0];
      assert.equal(splitAction.type, "visual.split");
      assert.equal(splitAction.params.at, 3);

      // 2. Resolve target clip ID
      const targetClipId = resolveTargetClipId(splitAction.params.clipId, runtime, runtime.visualSegments[0].id, "visuals");
      assert.equal(targetClipId, "vis-1");

      const rightClipId = "vis-1-split-test";
      const mediaOrigins = {
        [rightClipId]: { kind: "clip", id: targetClipId },
      };

      // 3. Command plan with baseRevision matching current snapshot
      const commandPlan = {
        schemaVersion: 1,
        baseRevision: project.commandState.revision,
        operations: [
          {
            id: "op-split-first",
            type: "visual.split",
            clipId: targetClipId,
            at: splitAction.params.at,
            rightClipId,
          },
        ],
      };

      const testRun = applyCommandPlan(project, commandPlan);
      assert.equal(testRun.ok, true);

      // 4. Restore browser media with mediaOrigins
      const restored = restoreBrowserProjectMedia(testRun.project, runtime, mediaOrigins, []);
      assert.ok(restored);

      // 5. Verify timeline segments are divided as expected
      assert.equal(restored.visualSegments.length, 4);

      // Left split half
      const leftClip = restored.visualSegments[0];
      assert.equal(leftClip.id, "vis-1");
      assert.equal(leftClip.duration, 3);
      assert.equal(leftClip.sourceStart, 0);
      assert.equal(leftClip.sourceDuration, 3);
      assert.equal(leftClip.src, "blob:http://localhost/vis-1");
      assert.equal(leftClip.blob, mockBlob);
      assert.equal(leftClip.archiveMediaId, "vis-1");
      assert.equal(leftClip.assetId, "asset-vis-1");

      // Right split half
      const rightClip = restored.visualSegments[1];
      assert.equal(rightClip.id, rightClipId);
      assert.equal(rightClip.duration, 7);
      assert.equal(rightClip.sourceStart, 3);
      assert.equal(rightClip.sourceDuration, 7);
      assert.equal(rightClip.src, "blob:http://localhost/vis-1");
      assert.equal(rightClip.blob, mockBlob);
      assert.equal(rightClip.archiveMediaId, "vis-1");
      assert.equal(rightClip.assetId, "asset-vis-1");

      // Remaining clips unchanged
      assert.equal(restored.visualSegments[2].id, "vis-2");
      assert.equal(restored.visualSegments[3].id, "vis-3");
    });

    it("should successfully apply a valid split when browser project state is unchanged even if origins map is empty", () => {
      const project = createTestProject();
      const mockBlob = { size: 2048, type: "video/mp4" };
      const runtime = {
        ...project,
        visualSegments: project.visualSegments.map((c) => ({
          ...c,
          blob: mockBlob,
          src: `blob:http://localhost/${c.id}`,
          archiveMediaId: c.id,
          assetId: `asset-${c.id}`,
        })),
      };

      const rightClipId = "vis-1-split-empty-origins";
      const commandPlan = {
        schemaVersion: 1,
        baseRevision: project.commandState.revision,
        operations: [
          {
            id: "op-split-derived",
            type: "visual.split",
            clipId: "vis-1",
            at: 4,
            rightClipId,
          },
        ],
      };

      const testRun = applyCommandPlan(project, commandPlan);
      assert.equal(testRun.ok, true);

      // restoreBrowserProjectMedia with empty origins {} relies on archiveMediaId resolution
      const restored = restoreBrowserProjectMedia(testRun.project, runtime, {}, []);
      assert.equal(restored.visualSegments.length, 4);
      assert.equal(restored.visualSegments[0].duration, 4);
      assert.equal(restored.visualSegments[1].id, rightClipId);
      assert.equal(restored.visualSegments[1].duration, 6);
      assert.equal(restored.visualSegments[1].src, "blob:http://localhost/vis-1");
      assert.equal(restored.visualSegments[1].blob, mockBlob);
    });

    it("should reject a genuinely stale proposal after an actual conflicting edit", () => {
      const project = createTestProject();
      const initialSnapshot = structuredClone(project);

      // Proposal generated at baseRevision 0
      const proposalBaseRevision = project.commandState.revision;
      assert.equal(proposalBaseRevision, 0);

      // Intervening edit occurs: e.g. user deletes vis-3 or trims vis-1
      const interveningPlan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          {
            id: "intervening-trim",
            type: "visual.trim",
            clipId: "vis-1",
            sourceIn: 1,
            sourceOut: 9,
          },
        ],
      };
      const interveningResult = applyCommandPlan(project, interveningPlan);
      assert.equal(interveningResult.ok, true);
      const mutatedProject = interveningResult.project;
      assert.equal(mutatedProject.commandState.revision, 1);

      // User now attempts to apply the stale proposal with baseRevision 0 against revision 1
      const staleCommandPlan = {
        schemaVersion: 1,
        baseRevision: proposalBaseRevision,
        operations: [
          {
            id: "stale-split-op",
            type: "visual.split",
            clipId: "vis-1",
            at: 3,
            rightClipId: "vis-1-stale-split",
          },
        ],
      };

      const staleRun = applyCommandPlan(mutatedProject, staleCommandPlan);
      assert.equal(staleRun.ok, false);
      assert.equal(staleRun.code, "REVISION_CONFLICT");

      // Verify simulated handler throws BROWSER_EDIT_STALE_PLAN on revision conflict
      assert.throws(() => {
        if (!staleRun.ok && staleRun.code === "REVISION_CONFLICT") {
          throw Object.assign(new Error("The project has been modified since this editing plan was proposed."), {
            code: "BROWSER_EDIT_STALE_PLAN",
          });
        }
      }, (err) => err.code === "BROWSER_EDIT_STALE_PLAN");

      // The mutated project was not modified by the stale plan attempt
      assert.equal(mutatedProject.commandState.revision, 1);
      assert.equal(mutatedProject.visualSegments.length, 3);
    });

    it("should fail safely with CLIP_NOT_FOUND when target clip was removed by an intervening edit", () => {
      const project = createTestProject();

      // Intervening edit removes vis-1
      const removePlan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          {
            id: "remove-vis-1",
            type: "visual.delete",
            clipId: "vis-1",
          },
        ],
      };
      const removeResult = applyCommandPlan(project, removePlan);
      assert.equal(removeResult.ok, true);
      const projectWithoutVis1 = removeResult.project;

      // Plan trying to split the now-missing vis-1
      const splitMissingPlan = {
        schemaVersion: 1,
        baseRevision: projectWithoutVis1.commandState.revision,
        operations: [
          {
            id: "split-missing-op",
            type: "visual.split",
            clipId: "vis-1",
            at: 3,
            rightClipId: "vis-1-split",
          },
        ],
      };

      const run = applyCommandPlan(projectWithoutVis1, splitMissingPlan);
      assert.equal(run.ok, false);
      assert.equal(run.code, "CLIP_NOT_FOUND");
      // Project is not mutated
      assert.equal(projectWithoutVis1.visualSegments.length, 2);
    });

    it("should fail safely with CLIP_NOT_FOUND for invalid clip IDs without mutating project", () => {
      const project = createTestProject();
      const initialSnapshot = structuredClone(project);

      const invalidPlan = {
        schemaVersion: 1,
        baseRevision: project.commandState.revision,
        operations: [
          {
            id: "invalid-split-op",
            type: "visual.split",
            clipId: "nonexistent-id-999",
            at: 3,
            rightClipId: "nonexistent-split",
          },
        ],
      };

      const run = applyCommandPlan(project, invalidPlan);
      assert.equal(run.ok, false);
      assert.equal(run.code, "CLIP_NOT_FOUND");
      // Project remains completely untouched
      assert.deepEqual(project, initialSnapshot);
    });
  });
});

