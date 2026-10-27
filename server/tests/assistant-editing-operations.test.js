import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyCommandPlan, inspectProject, inspectTrack } from "../../src/lib/projectCommandEngine.js";
import { validateAndNormalizePlan } from "../services/ai/editingPlanSchema.js";
import { sanitizeProjectSummary } from "../services/ai/ollimaService.js";
import { extractMinimalProjectSummary } from "../../src/lib/assistantSummary.js";
import { classifyUserIntent } from "../../src/lib/intentClassifier.js";

describe("Assistant Editing Operations & Project Command Engine Regressions", () => {
  const createBaseProject = () => ({
    commandState: { schemaVersion: 1, revision: 0, appliedOperationIds: [] },
    ratioId: "16:9",
    fitMode: "contain",
    visualSegments: [
      { id: "vis-1", type: "video", duration: 10, sourceStart: 0, sourceDuration: 10, playbackRate: 1, name: "Intro Video" },
      { id: "vis-2", type: "image", duration: 5, width: 1920, height: 1080, name: "Slide Image" },
    ],
    audioSegments: [
      { id: "aud-1", name: "Voiceover 1", start: 0, duration: 8, sourceStart: 0, sourceDuration: 8, volume: 1 },
      { id: "aud-2", name: "Voiceover 2", start: 10, duration: 4, sourceStart: 0, sourceDuration: 4, volume: 0.9 },
    ],
    musicSegments: [
      { id: "mus-1", name: "Background Beats", start: 0, duration: 25, sourceStart: 0, sourceDuration: 25, volume: 0.4 },
    ],
    musicName: "Background Beats",
    musicDuration: 25,
    musicStart: 0,
    musicVolume: 0.4,
    captionSegments: [
      { id: "cap-1", text: "Welcome to our video", start: 0, end: 5, audioSegmentId: "aud-1" },
      { id: "cap-2", text: "Here is the second part", start: 10, end: 14, audioSegmentId: "aud-2" },
    ],
    timelineMarkers: [
      { id: "m-1", time: 3.5, title: "Key moment", color: "cyan", type: "marker" },
    ],
    script: "Welcome to our video\nHere is the second part",
    captionsEnabled: true,
  });

  describe("audio.delete and music.delete operations", () => {
    it("should delete only the targeted audio clip and unlink associated captions while preserving other tracks", () => {
      const project = createBaseProject();
      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-del-aud-1", type: "audio.delete", clipId: "aud-1" },
        ],
      };

      const result = applyCommandPlan(project, plan);
      assert.equal(result.ok, true);

      // Verify audioSegments state
      assert.equal(result.project.audioSegments.length, 1);
      assert.equal(result.project.audioSegments[0].id, "aud-2", "Unrelated audio clip aud-2 preserved");

      // Verify associated caption unlinked
      const cap1 = result.project.captionSegments.find((c) => c.id === "cap-1");
      assert.equal(cap1.audioSegmentId, "", "cap-1 audioSegmentId should be cleared");
      const cap2 = result.project.captionSegments.find((c) => c.id === "cap-2");
      assert.equal(cap2.audioSegmentId, "aud-2", "cap-2 audio link should remain intact");

      // Verify unrelated tracks preserved
      assert.equal(result.project.visualSegments.length, 2, "Visual clips intact");
      assert.equal(result.project.musicSegments.length, 1, "Music track intact");
      assert.equal(result.project.musicSegments[0].id, "mus-1");
      assert.equal(result.project.timelineMarkers.length, 1, "Markers intact");
      assert.equal(result.project.captionSegments.length, 2, "Captions intact");
    });

    it("should resolve single audio clip when clipId is omitted, or fail with CLIP_ID_AMBIGUOUS if multiple exist", () => {
      const project = createBaseProject();

      // When 2 audio clips exist and clipId is omitted, should throw CLIP_ID_AMBIGUOUS
      const ambiguousPlan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [{ id: "op-ambig", type: "audio.delete", clipId: "" }],
      };
      const ambiguousResult = applyCommandPlan(project, ambiguousPlan);
      assert.equal(ambiguousResult.ok, false);
      assert.equal(ambiguousResult.code, "CLIP_ID_AMBIGUOUS");

      // With only 1 audio clip, omitting clipId targets it unambiguously
      const singleAudioProject = {
        ...createBaseProject(),
        audioSegments: [{ id: "solo-aud", name: "Solo", start: 0, duration: 5 }],
      };
      const soloPlan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [{ id: "op-solo", type: "audio.delete", clipId: "" }],
      };
      const soloResult = applyCommandPlan(singleAudioProject, soloPlan);
      assert.equal(soloResult.ok, true);
      assert.equal(soloResult.project.audioSegments.length, 0);
    });

    it("should fail with CLIP_NOT_FOUND when audio target does not exist", () => {
      const project = createBaseProject();
      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [{ id: "op-missing", type: "audio.delete", clipId: "nonexistent-audio" }],
      };
      const result = applyCommandPlan(project, plan);
      assert.equal(result.ok, false);
      assert.equal(result.code, "CLIP_NOT_FOUND");
    });

    it("should delete background music and reset music project properties when empty", () => {
      const project = createBaseProject();
      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [{ id: "op-del-mus", type: "music.delete", clipId: "mus-1" }],
      };

      const result = applyCommandPlan(project, plan);
      assert.equal(result.ok, true);

      // Verify musicSegments is empty
      assert.equal(result.project.musicSegments.length, 0);

      // Verify project music properties reset
      assert.equal(result.project.musicName, "");
      assert.equal(result.project.musicDuration, 0);
      assert.equal(result.project.musicStart, 0);
      assert.equal(result.project.musicVolume, 0);

      // Verify visual and audio tracks remain untouched
      assert.equal(result.project.visualSegments.length, 2);
      assert.equal(result.project.audioSegments.length, 2);
      assert.equal(result.project.captionSegments.length, 2);
    });

    it("should resolve single music clip when clipId is empty or shorthand 'music'", () => {
      const project = createBaseProject();
      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [{ id: "op-del-mus-auto", type: "music.delete" }],
      };

      const result = applyCommandPlan(project, plan);
      assert.equal(result.ok, true);
      assert.equal(result.project.musicSegments.length, 0);
    });
  });

  describe("Clip Trimming and Splitting", () => {
    it("should split a visual clip at specified timestamp and generate valid rightClipId", () => {
      const project = createBaseProject();
      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-split", type: "visual.split", clipId: "vis-1", at: 4 },
        ],
      };

      const result = applyCommandPlan(project, plan);
      assert.equal(result.ok, true);

      // Visuals count should now be 3 (left, right, and vis-2)
      assert.equal(result.project.visualSegments.length, 3);
      const left = result.project.visualSegments[0];
      const right = result.project.visualSegments[1];

      assert.equal(left.id, "vis-1");
      assert.equal(left.duration, 4);
      assert.equal(left.sourceDuration, 4);

      assert.ok(right.id.startsWith("vis-1-split-"));
      assert.equal(right.duration, 6);
      assert.equal(right.sourceStart, 4);
      assert.equal(right.sourceDuration, 6);

      // vis-2 unaffected
      assert.equal(result.project.visualSegments[2].id, "vis-2");
      assert.equal(result.project.visualSegments[2].duration, 5);
    });

    it("should trim visual video clip within source bounds", () => {
      const project = createBaseProject();
      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-trim-vid", type: "visual.trim", clipId: "vis-1", sourceIn: 2, sourceOut: 7 },
        ],
      };

      const result = applyCommandPlan(project, plan);
      assert.equal(result.ok, true);
      const trimmed = result.project.visualSegments[0];
      assert.equal(trimmed.id, "vis-1");
      assert.equal(trimmed.sourceStart, 2);
      assert.equal(trimmed.sourceDuration, 5);
      assert.equal(trimmed.duration, 5);
    });

    it("should trim visual image clip by updating duration", () => {
      const project = createBaseProject();
      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-trim-img", type: "visual.trim", clipId: "vis-2", sourceIn: 0, sourceOut: 3 },
        ],
      };

      const result = applyCommandPlan(project, plan);
      assert.equal(result.ok, true);
      const trimmedImage = result.project.visualSegments[1];
      assert.equal(trimmedImage.id, "vis-2");
      assert.equal(trimmedImage.duration, 3);
    });

    it("should reject invalid trim ranges (sourceOut <= sourceIn)", () => {
      const project = createBaseProject();
      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-trim-bad", type: "visual.trim", clipId: "vis-1", sourceIn: 5, sourceOut: 3 },
        ],
      };

      const result = applyCommandPlan(project, plan);
      assert.equal(result.ok, false);
      assert.equal(result.code, "INVALID_RANGE");
    });

    it("should accurately handle two valid splits at 59.211s and 118.422s on the same visual clip", () => {
      const longVideoProject = {
        ...createBaseProject(),
        visualSegments: [
          {
            id: "vis-long",
            type: "video",
            duration: 180,
            sourceStart: 0,
            sourceDuration: 180,
            playbackRate: 1,
          },
        ],
      };

      const multiSplitPlan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-split-1", type: "visual.split", clipId: "vis-long", at: 59.211, rightClipId: "vis-long-part2" },
          { id: "op-split-2", type: "visual.split", clipId: "vis-long", at: 118.422, rightClipId: "vis-long-part3" },
        ],
      };

      const result = applyCommandPlan(longVideoProject, multiSplitPlan);
      assert.equal(result.ok, true, `Plan should succeed: ${result.message}`);
      assert.equal(result.project.visualSegments.length, 3);

      const [part1, part2, part3] = result.project.visualSegments;

      // Part 1
      assert.equal(part1.id, "vis-long");
      assert.equal(part1.duration, 59.211);
      assert.equal(part1.sourceStart, 0);
      assert.equal(part1.sourceDuration, 59.211);

      // Part 2
      assert.equal(part2.id, "vis-long-part2");
      assert.equal(part2.duration, 59.211);
      assert.equal(part2.sourceStart, 59.211);
      assert.equal(part2.sourceDuration, 59.211);

      // Part 3
      assert.equal(part3.id, "vis-long-part3");
      assert.equal(part3.duration, 61.578);
      assert.equal(part3.sourceStart, 118.422);
      assert.equal(part3.sourceDuration, 61.578);

      // Total timeline duration must be preserved without gaps or overlaps
      const totalDuration = result.project.visualSegments.reduce((sum, c) => sum + c.duration, 0);
      assert.equal(Number(totalDuration.toFixed(3)), 180);
    });

    it("should handle three or more sequential splits on the same clip with consistent source timing", () => {
      const project = {
        ...createBaseProject(),
        visualSegments: [
          {
            id: "vis-cut-test",
            type: "video",
            duration: 120,
            sourceStart: 10,
            sourceDuration: 120,
            playbackRate: 1,
          },
        ],
      };

      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-s1", type: "visual.split", clipId: "vis-cut-test", at: 30, rightClipId: "vis-p2" },
          { id: "op-s2", type: "visual.split", clipId: "vis-cut-test", at: 60, rightClipId: "vis-p3" },
          { id: "op-s3", type: "visual.split", clipId: "vis-cut-test", at: 90, rightClipId: "vis-p4" },
        ],
      };

      const result = applyCommandPlan(project, plan);
      assert.equal(result.ok, true);
      assert.equal(result.project.visualSegments.length, 4);

      const segments = result.project.visualSegments;
      assert.equal(segments[0].id, "vis-cut-test");
      assert.equal(segments[0].duration, 30);
      assert.equal(segments[0].sourceStart, 10);

      assert.equal(segments[1].id, "vis-p2");
      assert.equal(segments[1].duration, 30);
      assert.equal(segments[1].sourceStart, 40);

      assert.equal(segments[2].id, "vis-p3");
      assert.equal(segments[2].duration, 30);
      assert.equal(segments[2].sourceStart, 70);

      assert.equal(segments[3].id, "vis-p4");
      assert.equal(segments[3].duration, 30);
      assert.equal(segments[3].sourceStart, 100);
    });

    it("should atomically reject and rollback multi-action plans when any split position is invalid", () => {
      const project = {
        ...createBaseProject(),
        visualSegments: [
          {
            id: "vis-rollback",
            type: "video",
            duration: 50,
            sourceStart: 0,
            sourceDuration: 50,
          },
        ],
      };

      // Second split is beyond duration (at: 999)
      const invalidPlan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-valid", type: "visual.split", clipId: "vis-rollback", at: 20, rightClipId: "vis-rb-2" },
          { id: "op-invalid", type: "visual.split", clipId: "vis-rollback", at: 999, rightClipId: "vis-rb-3" },
        ],
      };

      const result = applyCommandPlan(project, invalidPlan);
      assert.equal(result.ok, false);
      assert.equal(result.code, "INVALID_RANGE");

      // Verify the input project was completely untouched
      assert.equal(project.visualSegments.length, 1);
      assert.equal(project.visualSegments[0].id, "vis-rollback");
      assert.equal(project.visualSegments[0].duration, 50);
    });

    it("should correctly support undo and redo across multi-split command plans", () => {
      const project = {
        ...createBaseProject(),
        visualSegments: [
          {
            id: "vis-undo-test",
            type: "video",
            duration: 100,
            sourceStart: 0,
            sourceDuration: 100,
          },
        ],
      };

      const snapshotBefore = structuredClone(project);

      const splitPlan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-u1", type: "visual.split", clipId: "vis-undo-test", at: 40, rightClipId: "vis-u2" },
          { id: "op-u2", type: "visual.split", clipId: "vis-undo-test", at: 70, rightClipId: "vis-u3" },
        ],
      };

      const applied = applyCommandPlan(project, splitPlan);
      assert.equal(applied.ok, true);
      assert.equal(applied.project.visualSegments.length, 3);

      // Simulate editor undo: restore previous snapshot
      const undoneProject = structuredClone(snapshotBefore);
      assert.equal(undoneProject.visualSegments.length, 1);
      assert.equal(undoneProject.visualSegments[0].id, "vis-undo-test");
      assert.equal(undoneProject.visualSegments[0].duration, 100);

      // Simulate editor redo: re-apply the plan from the restored snapshot
      const redone = applyCommandPlan(undoneProject, splitPlan);
      assert.equal(redone.ok, true);
      assert.equal(redone.project.visualSegments.length, 3);
      assert.equal(redone.project.visualSegments[0].duration, 40);
      assert.equal(redone.project.visualSegments[1].duration, 30);
      assert.equal(redone.project.visualSegments[2].duration, 30);
    });
  });

  describe("Clip Muting and Property Adjustments", () => {
    it("should mute and unmute a video visual clip", () => {
      const project = createBaseProject();
      const mutePlan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [{ id: "op-mute", type: "clip.set_muted", clipId: "vis-1", muted: true }],
      };

      const muteResult = applyCommandPlan(project, mutePlan);
      assert.equal(muteResult.ok, true);
      assert.equal(muteResult.project.visualSegments[0].muted, true);
      assert.equal(muteResult.project.visualSegments[0].sourceAudioDisabled, true);

      const unmutePlan = {
        schemaVersion: 1,
        baseRevision: 1,
        operations: [{ id: "op-unmute", type: "clip.set_muted", clipId: "vis-1", muted: false }],
      };
      const unmuteResult = applyCommandPlan(muteResult.project, unmutePlan);
      assert.equal(unmuteResult.ok, true);
      assert.equal(unmuteResult.project.visualSegments[0].muted, false);
      assert.equal(unmuteResult.project.visualSegments[0].sourceAudioDisabled, false);
    });

    it("should adjust audio and music volume via clip.set_property", () => {
      const project = createBaseProject();
      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-vol-aud", type: "clip.set_property", clipId: "aud-1", property: "volume", value: 1.5 },
          { id: "op-vol-mus", type: "clip.set_property", clipId: "mus-1", property: "volume", value: 0.2 },
        ],
      };

      const result = applyCommandPlan(project, plan);
      assert.equal(result.ok, true);
      assert.equal(result.project.audioSegments[0].volume, 1.5);
      assert.equal(result.project.musicSegments[0].volume, 0.2);
      assert.equal(result.project.musicVolume, 0.2, "project.musicVolume synchronized with music clip volume");
    });

    it("should resolve shorthand 'music' and 'audio' in setClipProperty and setClipMuted", () => {
      const project = createBaseProject();
      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-shorthand-mus", type: "clip.set_property", clipId: "music", property: "volume", value: 0.6 },
          { id: "op-shorthand-mute", type: "clip.set_muted", clipId: "music", muted: true },
        ],
      };

      const result = applyCommandPlan(project, plan);
      assert.equal(result.ok, true);
      assert.equal(result.project.musicSegments[0].volume, 0.6);
      assert.equal(result.project.musicSegments[0].muted, true);
    });

    it("should update scale, x, y, rotation, and opacity on main visual clips while synchronizing canonical baseTransform", () => {
      const project = createBaseProject();
      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-scale", type: "clip.set_property", clipId: "vis-1", property: "scale", value: 1.5 },
          { id: "op-x", type: "clip.set_property", clipId: "vis-1", property: "x", value: 25 },
          { id: "op-y", type: "clip.set_property", clipId: "vis-1", property: "y", value: -15 },
          { id: "op-rot", type: "clip.set_property", clipId: "vis-1", property: "rotation", value: 45 },
          { id: "op-opac", type: "clip.set_property", clipId: "vis-1", property: "opacity", value: 0.75 },
        ],
      };

      const result = applyCommandPlan(project, plan);
      assert.equal(result.ok, true);

      const clip = result.project.visualSegments[0];
      // Top-level properties updated
      assert.equal(clip.scale, 1.5);
      assert.equal(clip.x, 25);
      assert.equal(clip.y, -15);
      assert.equal(clip.rotation, 45);
      assert.equal(clip.opacity, 0.75);

      // Canonical baseTransform synchronized for preview and rendering engines
      assert.deepEqual(clip.baseTransform, {
        x: 25,
        y: -15,
        scale: 1.5,
        rotation: 45,
        opacity: 0.75,
      });
    });

    it("should preserve existing transform values when updating a single transform property", () => {
      const project = createBaseProject();
      project.visualSegments[0].baseTransform = { x: 10, y: 20, scale: 1.2, rotation: 30, opacity: 0.9 };

      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-only-scale", type: "clip.set_property", clipId: "vis-1", property: "scale", value: 2.0 },
        ],
      };

      const result = applyCommandPlan(project, plan);
      assert.equal(result.ok, true);

      const clip = result.project.visualSegments[0];
      assert.equal(clip.scale, 2.0);
      assert.equal(clip.baseTransform.scale, 2.0);
      // Other transform properties must remain strictly preserved
      assert.equal(clip.baseTransform.x, 10);
      assert.equal(clip.baseTransform.y, 20);
      assert.equal(clip.baseTransform.rotation, 30);
      assert.equal(clip.baseTransform.opacity, 0.9);
    });

    it("should handle main visual clips separately from overlay clips without cross-contamination", () => {
      const project = {
        ...createBaseProject(),
        visualOverlaySegments: [
          {
            id: "overlay-1",
            name: "PIP Video",
            start: 0,
            duration: 5,
            baseTransform: { x: 27, y: -24, scale: 0.34, rotation: 0, opacity: 1 },
          },
        ],
      };

      // 1. Updating main visual clip via clip.set_property (y positioning)
      const visualPlan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-vis-y", type: "clip.set_property", clipId: "vis-1", property: "y", value: 30 },
        ],
      };
      const visualRes = applyCommandPlan(project, visualPlan);
      assert.equal(visualRes.ok, true);
      assert.equal(visualRes.project.visualSegments[0].baseTransform.y, 30);
      assert.equal(visualRes.project.visualOverlaySegments[0].baseTransform.y, -24, "Overlay transform unaffected");

      // 2. Updating overlay clip via overlay.set_transform
      const overlayPlan = {
        schemaVersion: 1,
        baseRevision: 1,
        operations: [
          { id: "op-ovl-trans", type: "overlay.set_transform", clipId: "overlay-1", transform: { y: 15, scale: 0.5 } },
        ],
      };
      const overlayRes = applyCommandPlan(visualRes.project, overlayPlan);
      assert.equal(overlayRes.ok, true);
      assert.equal(overlayRes.project.visualOverlaySegments[0].baseTransform.y, 15);
      assert.equal(overlayRes.project.visualOverlaySegments[0].baseTransform.scale, 0.5);
      assert.equal(overlayRes.project.visualSegments[0].baseTransform.y, 30, "Main visual transform unaffected");

      // 3. overlay.set_transform fails when targeting nonexistent overlay and does NOT silently alter main visual clips
      const invalidOverlayPlan = {
        schemaVersion: 1,
        baseRevision: 2,
        operations: [
          { id: "op-ovl-missing", type: "overlay.set_transform", clipId: "nonexistent-overlay", transform: { y: 50 } },
        ],
      };
      const invalidRes = applyCommandPlan(overlayRes.project, invalidOverlayPlan);
      assert.equal(invalidRes.ok, false);
      assert.equal(invalidRes.code, "CLIP_NOT_FOUND");
    });

    it("should allow editing transform and undoing to restore the exact previous transform state", () => {
      // Test the deep cloning logic used by editor history
      function cloneItems(items = []) {
        return (Array.isArray(items) ? items : []).map((item) => {
          if (!item || typeof item !== "object") return item;
          return {
            ...item,
            words: Array.isArray(item.words) ? item.words.map((w) => ({ ...w })) : undefined,
            baseTransform: item.baseTransform ? { ...item.baseTransform } : undefined,
            keyframes: Array.isArray(item.keyframes) ? item.keyframes.map((k) => ({ ...k })) : undefined,
            colorGrade: item.colorGrade ? { ...item.colorGrade } : undefined,
            mask: item.mask ? { ...item.mask } : undefined,
            animation: item.animation ? { ...item.animation } : undefined,
          };
        });
      }

      const initialVisuals = [
        {
          id: "vis-1",
          type: "video",
          duration: 10,
          baseTransform: { x: 0, y: 0, scale: 1.0, rotation: 0, opacity: 1 },
          keyframes: [{ time: 0, scale: 1.0 }],
          colorGrade: { temperature: 10 },
        },
      ];

      // Create snapshot (as done in useEditorHistory createSnapshot)
      const snapshotVisuals = cloneItems(initialVisuals);

      // Mutate the active project clip
      const project = {
        ...createBaseProject(),
        visualSegments: initialVisuals,
      };

      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-edit-scale", type: "clip.set_property", clipId: "vis-1", property: "scale", value: 1.75 },
          { id: "op-edit-x", type: "clip.set_property", clipId: "vis-1", property: "x", value: 40 },
        ],
      };

      const result = applyCommandPlan(project, plan);
      assert.equal(result.ok, true);
      assert.equal(result.project.visualSegments[0].baseTransform.scale, 1.75);
      assert.equal(result.project.visualSegments[0].baseTransform.x, 40);

      // Snapshot MUST retain the exact pristine values (not mutated by reference)
      assert.equal(snapshotVisuals[0].baseTransform.scale, 1.0);
      assert.equal(snapshotVisuals[0].baseTransform.x, 0);

      // Restoring snapshot restores exact previous transform values
      const restoredVisuals = cloneItems(snapshotVisuals);
      assert.deepEqual(restoredVisuals[0].baseTransform, {
        x: 0,
        y: 0,
        scale: 1.0,
        rotation: 0,
        opacity: 1,
      });
    });
  });

  describe("Caption editing and styling", () => {
    it("should update caption text and recompute project.script", () => {
      const project = createBaseProject();
      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-upd-cap", type: "caption.update", clipId: "cap-1", text: "Updated line one" },
        ],
      };

      const result = applyCommandPlan(project, plan);
      assert.equal(result.ok, true);
      assert.equal(result.project.captionSegments[0].text, "Updated line one");
      assert.ok(result.project.script.includes("Updated line one"));
    });

    it("should update caption style and placement", () => {
      const project = createBaseProject();
      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-cap-style", type: "caption.set_style", scope: "default", style: { captionSize: 28, effect: "neon" } },
          { id: "op-cap-pos", type: "caption.set_position", scope: "default", placement: { x: 50, y: 78 } },
        ],
      };

      const result = applyCommandPlan(project, plan);
      assert.equal(result.ok, true);
      assert.equal(result.project.captionSize, 28);
      assert.equal(result.project.captionStyle.effect, "neon");
      assert.deepEqual(result.project.captionPlacement, { x: 50, y: 78 });
    });
  });

  describe("Schema and Ollima Service Validation", () => {
    it("should validate and normalize plans containing audio.delete, music.delete, clip.set_muted, clip.set_property", () => {
      const rawPlan = {
        schemaVersion: 1,
        explanation: "Clean up audio and mute intro",
        actions: [
          { id: "a1", type: "audio.delete", params: { clipId: "aud-1" } },
          { id: "a2", type: "music.delete", params: { clipId: "mus-1" } },
          { id: "a3", type: "clip.set_muted", params: { clipId: "vis-1", muted: true } },
          { id: "a4", type: "clip.set_property", params: { clipId: "vis-1", property: "volume", value: 0.8 } },
          { id: "a5", type: "visual.trim", params: { clipId: "vis-1", sourceIn: 1, duration: 4 } },
        ],
      };

      const normalized = validateAndNormalizePlan(rawPlan);
      assert.equal(normalized.actions.length, 5);
      assert.equal(normalized.actions[0].type, "audio.delete");
      assert.equal(normalized.actions[1].type, "music.delete");
      assert.equal(normalized.actions[2].type, "clip.set_muted");
      assert.equal(normalized.actions[2].params.muted, true);
      assert.equal(normalized.actions[3].type, "clip.set_property");
      assert.equal(normalized.actions[3].params.property, "volume");
      assert.equal(normalized.actions[4].type, "visual.trim");
      assert.equal(normalized.actions[4].params.sourceIn, 1);
      assert.equal(normalized.actions[4].params.sourceOut, 5, "duration converted to sourceOut");
    });

    it("should retain selection and playhead in sanitizeProjectSummary and extractMinimalProjectSummary", () => {
      const project = createBaseProject();
      const summary = extractMinimalProjectSummary(project, {
        currentTime: 7.25,
        selectedClipId: "vis-1",
        selectedTrack: "visuals",
      });

      assert.equal(summary.currentTime, 7.25);
      assert.equal(summary.selectedClipId, "vis-1");
      assert.equal(summary.selectedTrack, "visuals");

      const sanitized = sanitizeProjectSummary(summary);
      assert.equal(sanitized.currentTime, 7.25);
      assert.equal(sanitized.selectedClipId, "vis-1");
      assert.equal(sanitized.selectedTrack, "visuals");
    });
  });

  describe("Atomic Execution and Undo Safety", () => {
    it("should atomically roll back when any operation in a multi-action plan fails", () => {
      const project = createBaseProject();
      const multiPlan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-valid-1", type: "caption.update", clipId: "cap-1", text: "New text" },
          { id: "op-fail-2", type: "visual.split", clipId: "vis-1", at: 999 }, // Out of range!
          { id: "op-valid-3", type: "audio.delete", clipId: "aud-1" },
        ],
      };

      const result = applyCommandPlan(project, multiPlan);
      assert.equal(result.ok, false);
      assert.equal(result.code, "INVALID_RANGE");

      // Verify no partial mutations persisted into original project
      assert.equal(project.captionSegments[0].text, "Welcome to our video");
      assert.equal(project.audioSegments.length, 2);
    });

    it("should accurately recalculate total project duration across tracks after deletion", () => {
      const project = createBaseProject();
      const inspectionBefore = inspectProject(project);
      assert.equal(inspectionBefore.duration, 25, "Music is longest track at 25s");

      // Delete music track
      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [{ id: "op-del-mus", type: "music.delete", clipId: "mus-1" }],
      };
      const result = applyCommandPlan(project, plan);
      assert.equal(result.ok, true);

      const inspectionAfter = inspectProject(result.project);
      // Now visual track is 10 + 5 = 15s, captions end at 14s, audio ends at 14s
      assert.equal(inspectionAfter.duration, 15, "New duration reflects remaining longest track");
    });
  });

  describe("Intent Classification for Editing vs Generation", () => {
    it("should classify undo and redo requests cleanly", () => {
      assert.equal(classifyUserIntent("undo").type, "undo");
      assert.equal(classifyUserIntent("undo that").type, "undo");
      assert.equal(classifyUserIntent("undo last edit").type, "undo");
      assert.equal(classifyUserIntent("redo").type, "redo");
      assert.equal(classifyUserIntent("redo that").type, "redo");
    });

    it("should classify audio and music operations as editing", () => {
      assert.equal(classifyUserIntent("delete voiceover").type, "editing");
      assert.equal(classifyUserIntent("remove the background music").type, "editing");
      assert.equal(classifyUserIntent("mute audio").type, "editing");
      assert.equal(classifyUserIntent("unmute the video clip").type, "editing");
      assert.equal(classifyUserIntent("turn down the music volume").type, "editing");
    });

    it("should classify timeline trim and split commands as editing", () => {
      assert.equal(classifyUserIntent("split clip at playhead").type, "editing");
      assert.equal(classifyUserIntent("split the first clip at 3 seconds").type, "editing");
      assert.equal(classifyUserIntent("trim the video to 5 seconds").type, "editing");
      assert.equal(classifyUserIntent("delete this clip").type, "editing");
    });

    it("should route new video generation requests to unsupported_creation with guidance", () => {
      const res = classifyUserIntent("Create a 30-second cinematic travel video about Japan");
      assert.equal(res.type, "unsupported_creation");
      assert.ok(res.message);
    });

    it("should classify transition, speed, duplicate, track control, and tool triggers as editing", () => {
      assert.equal(classifyUserIntent("add a fade transition").type, "editing");
      assert.equal(classifyUserIntent("set transition to glitch").type, "editing");
      assert.equal(classifyUserIntent("speed up the clip to 2x").type, "editing");
      assert.equal(classifyUserIntent("slow down playback").type, "editing");
      assert.equal(classifyUserIntent("duplicate this clip").type, "editing");
      assert.equal(classifyUserIntent("lock the visual track").type, "editing");
      assert.equal(classifyUserIntent("hide audio track").type, "editing");
      assert.equal(classifyUserIntent("detect scenes in the video").type, "editing");
      assert.equal(classifyUserIntent("remove silence and pauses").type, "editing");
      assert.equal(classifyUserIntent("generate auto captions").type, "editing");
      assert.equal(classifyUserIntent("toggle smart frame").type, "editing");
      assert.equal(classifyUserIntent("export video").type, "editing");
    });
  });

  describe("Transitions, Speed, Duplication, and Track Controls", () => {
    it("should duplicate visual clip and insert into timeline", () => {
      const project = createBaseProject();
      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-dup", type: "visual.duplicate", clipId: "vis-1", atIndex: 1 },
        ],
      };
      const result = applyCommandPlan(project, plan);
      assert.equal(result.ok, true);
      assert.equal(result.project.visualSegments.length, 3);
      assert.equal(result.project.visualSegments[1].name, "Intro Video");
      assert.notEqual(result.project.visualSegments[1].id, "vis-1");
    });

    it("should set transition on clip", () => {
      const project = createBaseProject();
      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-trans", type: "transition.set", clipId: "vis-1", transitionId: "fade", duration: 0.8 },
        ],
      };
      const result = applyCommandPlan(project, plan);
      assert.equal(result.ok, true);
      assert.equal(result.project.visualSegments[0].transition.id, "fade");
      assert.equal(result.project.visualSegments[0].transition.duration, 0.8);
    });

    it("should set playback rate and recalculate duration on video clip", () => {
      const project = createBaseProject();
      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-spd", type: "clip.set_speed", clipId: "vis-1", speed: 2.0 },
        ],
      };
      const result = applyCommandPlan(project, plan);
      assert.equal(result.ok, true);
      assert.equal(result.project.visualSegments[0].playbackRate, 2.0);
      assert.equal(result.project.visualSegments[0].duration, 5.0, "10s source / 2x speed = 5s duration");
    });

    it("should lock and unlock tracks", () => {
      const project = createBaseProject();
      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-lock", type: "track.set_locked", track: "visuals", locked: true },
        ],
      };
      const result = applyCommandPlan(project, plan);
      assert.equal(result.ok, true);
      assert.equal(result.project.trackLocks.image, true);
    });

    it("should set track visibility", () => {
      const project = createBaseProject();
      const plan = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [
          { id: "op-vis", type: "track.set_visibility", track: "captions", visible: false },
        ],
      };
      const result = applyCommandPlan(project, plan);
      assert.equal(result.ok, true);
      assert.equal(result.project.trackVisibility.caption, false);
    });

    it("should validate and normalize integrated AI tool action plans in editingPlanSchema", () => {
      const toolPlan = {
        schemaVersion: 1,
        explanation: "Analyze scenes and remove silence",
        actions: [
          { id: "act-1", type: "tool.scene_detection", params: { clipId: "vis-1" } },
          { id: "act-2", type: "tool.silence_removal", params: {} },
          { id: "act-3", type: "tool.export", params: {} },
        ],
      };
      const validated = validateAndNormalizePlan(toolPlan);
      assert.equal(validated.schemaVersion, 1);
      assert.equal(validated.actions.length, 3);
      assert.equal(validated.actions[0].type, "tool.scene_detection");
      assert.equal(validated.actions[1].type, "tool.silence_removal");
      assert.equal(validated.actions[2].type, "tool.export");
    });
  });
});

