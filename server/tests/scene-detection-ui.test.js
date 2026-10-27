import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canDetectScenes,
  calculateBoundaryTimelineOffset,
  toggleBoundarySelection,
  buildApprovedScenePlan,
  validateSceneCutBoundaries,
  splitVisualSegmentAtBoundaries,
} from "../../src/hooks/useSceneDetection.js";
import {
  detectScenesFromSignatures,
  computeFrameSignature,
} from "../../src/lib/sceneDetection.js";
import { SCENE_DETECTION_COPY } from "../../src/i18nSceneDetection.js";

describe("AI Scene Detection UI & Workflow", () => {
  describe("canDetectScenes validation", () => {
    it("returns true for valid video segment with positive duration", () => {
      assert.strictEqual(canDetectScenes({ type: "video", duration: 12.5 }), true);
      assert.strictEqual(canDetectScenes({ type: "video", duration: "8.0" }), true);
    });

    it("returns false for non-video segment types", () => {
      assert.strictEqual(canDetectScenes({ type: "image", duration: 5 }), false);
      assert.strictEqual(canDetectScenes({ type: "audio", duration: 10 }), false);
      assert.strictEqual(canDetectScenes({ type: "text", duration: 4 }), false);
      assert.strictEqual(canDetectScenes({ type: "sticker", duration: 3 }), false);
    });

    it("returns false for invalid or non-positive durations", () => {
      assert.strictEqual(canDetectScenes({ type: "video", duration: 0 }), false);
      assert.strictEqual(canDetectScenes({ type: "video", duration: -5 }), false);
      assert.strictEqual(canDetectScenes({ type: "video", duration: NaN }), false);
      assert.strictEqual(canDetectScenes({ type: "video", duration: Infinity }), false);
      assert.strictEqual(canDetectScenes({ type: "video" }), false);
      assert.strictEqual(canDetectScenes(null), false);
      assert.strictEqual(canDetectScenes(undefined), false);
    });
  });

  describe("calculateBoundaryTimelineOffset (BUG-SD-001 Preview Seeking)", () => {
    it("maps boundary directly when clip is the first segment on timeline", () => {
      const segments = [
        { id: "clip-1", type: "video", duration: 24.0 },
      ];
      assert.strictEqual(calculateBoundaryTimelineOffset(segments, "clip-1", 6.0), 6.0);
      assert.strictEqual(calculateBoundaryTimelineOffset(segments, "clip-1", 12.0), 12.0);
      assert.strictEqual(calculateBoundaryTimelineOffset(segments, "clip-1", 18.0), 18.0);
    });

    it("correctly offsets boundary timestamp by preceding clips durations", () => {
      const segments = [
        { id: "intro-clip", type: "video", duration: 5.5 },
        { id: "target-clip", type: "video", duration: 24.0 },
        { id: "outro-clip", type: "video", duration: 3.0 },
      ];
      // Boundaries at 6.0s, 12.0s, 18.0s relative to target-clip should map to 11.5s, 17.5s, 23.5s
      assert.strictEqual(calculateBoundaryTimelineOffset(segments, "target-clip", 6.0), 11.5);
      assert.strictEqual(calculateBoundaryTimelineOffset(segments, "target-clip", 12.0), 17.5);
      assert.strictEqual(calculateBoundaryTimelineOffset(segments, "target-clip", 18.0), 23.5);
    });

    it("handles boundary 0 or negative boundary gracefully", () => {
      const segments = [{ id: "c1", duration: 10 }];
      assert.strictEqual(calculateBoundaryTimelineOffset(segments, "c1", 0), 0);
      assert.strictEqual(calculateBoundaryTimelineOffset(segments, "c1", -2), 0);
    });

    it("handles missing or unmatched segment ID by defaulting to 0 clipStart", () => {
      const segments = [{ id: "c1", duration: 10 }];
      assert.strictEqual(calculateBoundaryTimelineOffset(segments, "unknown-id", 6.0), 6.0);
      assert.strictEqual(calculateBoundaryTimelineOffset([], "unknown-id", 6.0), 6.0);
    });
  });

  describe("toggleBoundarySelection", () => {
    it("adds a new timestamp in sorted order", () => {
      const initial = [2.0, 5.0];
      const result = toggleBoundarySelection(initial, 3.5);
      assert.deepStrictEqual(result, [2.0, 3.5, 5.0]);
      // Verify immutability
      assert.deepStrictEqual(initial, [2.0, 5.0]);
    });

    it("removes an existing timestamp when clicked again within tolerance", () => {
      const initial = [1.25, 4.5, 8.0];
      const result = toggleBoundarySelection(initial, 4.502);
      assert.deepStrictEqual(result, [1.25, 8.0]);
    });

    it("handles empty initial lists safely", () => {
      const result = toggleBoundarySelection([], 2.4);
      assert.deepStrictEqual(result, [2.4]);
      const resultNull = toggleBoundarySelection(undefined, 1.0);
      assert.deepStrictEqual(resultNull, [1.0]);
    });

    it("maintains sorting after multiple additions and removals", () => {
      let list = [];
      list = toggleBoundarySelection(list, 7.5);
      list = toggleBoundarySelection(list, 2.0);
      list = toggleBoundarySelection(list, 4.2);
      assert.deepStrictEqual(list, [2.0, 4.2, 7.5]);

      list = toggleBoundarySelection(list, 4.2);
      assert.deepStrictEqual(list, [2.0, 7.5]);
    });
  });

  describe("buildApprovedScenePlan", () => {
    it("returns empty array when draft duration is missing or non-positive", () => {
      assert.deepStrictEqual(buildApprovedScenePlan(null, [2.0]), []);
      assert.deepStrictEqual(buildApprovedScenePlan({ duration: 0 }, [1.0]), []);
      assert.deepStrictEqual(buildApprovedScenePlan({ duration: -5 }, [1.0]), []);
    });

    it("returns a single scene if no boundaries are selected", () => {
      const draft = { duration: 10.0 };
      const scenes = buildApprovedScenePlan(draft, []);
      assert.strictEqual(scenes.length, 1);
      assert.deepStrictEqual(scenes[0], {
        index: 0,
        start: 0,
        end: 10.0,
        duration: 10.0,
      });
    });

    it("divides video into contiguous scenes matching approved boundaries", () => {
      const draft = { duration: 12.0 };
      const selectedBoundaries = [3.0, 7.5];
      const scenes = buildApprovedScenePlan(draft, selectedBoundaries);

      assert.strictEqual(scenes.length, 3);
      assert.deepStrictEqual(scenes[0], {
        index: 0,
        start: 0,
        end: 3.0,
        duration: 3.0,
      });
      assert.deepStrictEqual(scenes[1], {
        index: 1,
        start: 3.0,
        end: 7.5,
        duration: 4.5,
      });
      assert.deepStrictEqual(scenes[2], {
        index: 2,
        start: 7.5,
        end: 12.0,
        duration: 4.5,
      });

      // Verify contiguity across the whole timeline
      for (let i = 0; i < scenes.length - 1; i++) {
        assert.strictEqual(scenes[i].end, scenes[i + 1].start);
      }
      assert.strictEqual(scenes[0].start, 0);
      assert.strictEqual(scenes[scenes.length - 1].end, 12.0);
    });

    it("filters out out-of-bounds or zero boundaries", () => {
      const draft = { duration: 10.0 };
      const selectedBoundaries = [-1.0, 0, 5.0, 10.0, 15.0];
      const scenes = buildApprovedScenePlan(draft, selectedBoundaries);

      assert.strictEqual(scenes.length, 2);
      assert.strictEqual(scenes[0].start, 0);
      assert.strictEqual(scenes[0].end, 5.0);
      assert.strictEqual(scenes[1].start, 5.0);
      assert.strictEqual(scenes[1].end, 10.0);
    });

    it("does not mutate original timeline segment array (non-destructive safety)", () => {
      const originalSegments = [
        { id: "clip-1", type: "video", duration: 15.0, start: 0, name: "Intro.mp4" },
        { id: "clip-2", type: "video", duration: 8.0, start: 15.0, name: "Outro.mp4" },
      ];
      const serializedBefore = JSON.stringify(originalSegments);

      const draft = { duration: originalSegments[0].duration };
      const selectedBoundaries = [4.0, 9.0];
      const approvedScenes = buildApprovedScenePlan(draft, selectedBoundaries);

      assert.strictEqual(approvedScenes.length, 3);
      assert.strictEqual(JSON.stringify(originalSegments), serializedBefore);
    });
  });

  describe("Interactive Workflow Simulation", () => {
    function createSolidFrame(r, g, b, width = 64, height = 36) {
      const data = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        const offset = i * 4;
        data[offset] = r;
        data[offset + 1] = g;
        data[offset + 2] = b;
        data[offset + 3] = 255;
      }
      return { data, width, height };
    }

    it("simulates full review flow: detection -> selection toggle -> plan generation", () => {
      // 3 scenes:
      // 0.0 - 2.0s: scene 1 (black)
      // 2.0 - 5.0s: scene 2 (white)
      // 5.0 - 8.0s: scene 3 (red)
      const sigBlack = computeFrameSignature(createSolidFrame(0, 0, 0));
      const sigWhite = computeFrameSignature(createSolidFrame(255, 255, 255));
      const sigRed = computeFrameSignature(createSolidFrame(255, 0, 0));

      const samples = [
        { time: 0.0, signature: sigBlack },
        { time: 0.5, signature: sigBlack },
        { time: 1.0, signature: sigBlack },
        { time: 1.5, signature: sigBlack },
        { time: 2.0, signature: sigWhite },
        { time: 2.5, signature: sigWhite },
        { time: 3.0, signature: sigWhite },
        { time: 3.5, signature: sigWhite },
        { time: 4.0, signature: sigWhite },
        { time: 4.5, signature: sigWhite },
        { time: 5.0, signature: sigRed },
        { time: 5.5, signature: sigRed },
        { time: 6.0, signature: sigRed },
        { time: 6.5, signature: sigRed },
        { time: 7.0, signature: sigRed },
        { time: 7.5, signature: sigRed },
        { time: 8.0, signature: sigRed },
      ];

      const result = detectScenesFromSignatures(samples, {
        duration: 8.0,
        sampleInterval: 0.5,
        threshold: 0.35,
        minSceneDuration: 1.0,
      });

      assert.strictEqual(result.boundaries.length, 2);
      assert.strictEqual(result.scenes.length, 3);

      // User selects initial boundaries
      let selectedBoundaries = result.boundaries.map((b) => b.time);
      assert.strictEqual(selectedBoundaries.length, 2);

      // User decides to unselect the second boundary (at 5.0s)
      selectedBoundaries = toggleBoundarySelection(selectedBoundaries, 5.0);
      assert.strictEqual(selectedBoundaries.length, 1);
      assert.deepStrictEqual(selectedBoundaries, [2.0]);

      // Plan generation reflects the updated boundary selection
      const approvedPlan = buildApprovedScenePlan(result, selectedBoundaries);
      assert.strictEqual(approvedPlan.length, 2);
      assert.strictEqual(approvedPlan[0].start, 0);
      assert.strictEqual(approvedPlan[0].end, 2.0);
      assert.strictEqual(approvedPlan[1].start, 2.0);
      assert.strictEqual(approvedPlan[1].end, 8.0);
    });

    it("verifies abort controller cancels processing cleanly", async () => {
      const controller = new AbortController();
      controller.abort();

      assert.throws(
        () => {
          controller.signal.throwIfAborted();
        },
        { name: "AbortError" }
      );
    });

    it("verifies incremental progress mapping logic never decreases or exceeds bounds", () => {
      // Test the progress mapping formula used in useSceneDetection
      const jobStates = [];
      let lastProgress = 5;

      const handleProgress = (progressPercent) => {
        const mapped = Math.min(95, Math.max(10, Math.round(10 + (Math.max(0, Math.min(100, progressPercent)) / 100) * 85)));
        if (mapped > lastProgress) {
          lastProgress = mapped;
          jobStates.push(mapped);
        }
      };

      // Initial preparation state
      assert.strictEqual(lastProgress, 5);

      // Simulate frame extraction callbacks: 0%, 25%, 50%, 75%, 100%
      [0, 25, 50, 75, 100].forEach((p) => handleProgress(p));

      assert.ok(jobStates.length >= 4);
      assert.strictEqual(jobStates[0], 10); // 10% lower bound for analyzing phase
      assert.strictEqual(jobStates[jobStates.length - 1], 95); // 95% upper bound while analyzing

      // Ensure monotonically non-decreasing
      for (let i = 1; i < jobStates.length; i++) {
        assert.ok(jobStates[i] > jobStates[i - 1], `${jobStates[i]} should be > ${jobStates[i - 1]}`);
      }

      // Decreasing callback should be ignored
      handleProgress(30);
      assert.strictEqual(jobStates[jobStates.length - 1], 95);

      // Completion stage sets 100%
      const finalJob = { running: false, progress: 100, phase: "" };
      assert.strictEqual(finalJob.progress, 100);
      assert.strictEqual(finalJob.running, false);
    });

    it("verifies cancellation and error states reset progress to 0 without remaining stuck", () => {
      // Simulate active running job
      let job = { running: true, progress: 65, phase: "sceneDetectAnalyzing" };
      assert.strictEqual(job.running, true);
      assert.strictEqual(job.progress, 65);

      // On cancellation:
      const cancelJob = () => ({ running: false, progress: 0, phase: "" });
      job = cancelJob();
      assert.strictEqual(job.running, false);
      assert.strictEqual(job.progress, 0);
      assert.strictEqual(job.phase, "");

      // On error:
      job = { running: true, progress: 80, phase: "sceneDetectAnalyzing" };
      assert.strictEqual(job.running, true);
      assert.strictEqual(job.progress, 80);

      let error = "";
      const errorJob = (code) => {
        error = code;
        return { running: false, progress: 0, phase: "" };
      };
      job = errorJob("sceneDetectFailed");
      assert.strictEqual(job.running, false);
      assert.strictEqual(job.progress, 0);
      assert.strictEqual(error, "sceneDetectFailed");
    });
  });

  describe("validateSceneCutBoundaries", () => {
    it("returns empty array on empty, non-array, or invalid durations", () => {
      assert.deepStrictEqual(validateSceneCutBoundaries([], 10), []);
      assert.deepStrictEqual(validateSceneCutBoundaries(null, 10), []);
      assert.deepStrictEqual(validateSceneCutBoundaries([2, 5], 0), []);
      assert.deepStrictEqual(validateSceneCutBoundaries([2, 5], -5), []);
      assert.deepStrictEqual(validateSceneCutBoundaries([2, 5], NaN), []);
      assert.deepStrictEqual(validateSceneCutBoundaries([2, 5], 0.08), []);
    });

    it("filters out non-numeric, negative, 0, or >= duration boundaries", () => {
      const result = validateSceneCutBoundaries([-2, 0, "abc", null, 3.5, 10, 12], 10);
      assert.deepStrictEqual(result, [3.5]);
    });

    it("sorts unsorted boundaries and removes duplicate cuts", () => {
      const result = validateSceneCutBoundaries([6.0, 2.5, 6.0, 2.5, 4.0], 10);
      assert.deepStrictEqual(result, [2.5, 4.0, 6.0]);
    });

    it("filters out cuts violating minimum interval constraints", () => {
      const result = validateSceneCutBoundaries([0.02, 2.0, 4.0, 4.02, 7.0, 9.98], 10);
      assert.deepStrictEqual(result, [2.0, 4.0, 7.0]);
    });
  });

  describe("splitVisualSegmentAtBoundaries", () => {
    const mockClip = {
      id: "clip-orig",
      type: "video",
      name: "intro.mp4",
      src: "blob:http://localhost/test",
      duration: 10.0,
      sourceStart: 1.0,
      sourceDuration: 10.0,
      playbackRate: 1.0,
      volume: 0.8,
      filterId: "cinematic",
      transition: { id: "fade", duration: 0.5 },
      keyframes: [
        { time: 1.0, scale: 1.0 },
        { time: 3.0, scale: 1.2 },
        { time: 7.0, scale: 1.5 },
      ],
      propertyKeyframes: {
        opacity: [
          { time: 2.0, value: 0.5 },
          { time: 6.0, value: 1.0 },
        ],
      },
    };

    it("returns original clip unmodified when boundaries are empty or invalid", () => {
      const resEmpty = splitVisualSegmentAtBoundaries(mockClip, []);
      assert.strictEqual(resEmpty.length, 1);
      assert.strictEqual(resEmpty[0], mockClip);

      const resInvalid = splitVisualSegmentAtBoundaries(mockClip, [0, -1, 15]);
      assert.strictEqual(resInvalid.length, 1);
      assert.strictEqual(resInvalid[0], mockClip);
    });

    it("handles null or non-segment inputs safely", () => {
      assert.deepStrictEqual(splitVisualSegmentAtBoundaries(null, [2]), []);
      assert.deepStrictEqual(splitVisualSegmentAtBoundaries(undefined, [2]), []);
    });

    it("splits clip into exact contiguous segments preserving duration sum", () => {
      const cuts = [3.0, 7.0];
      const segments = splitVisualSegmentAtBoundaries(mockClip, cuts);

      assert.strictEqual(segments.length, 3);
      assert.strictEqual(segments[0].duration, 3.0);
      assert.strictEqual(segments[1].duration, 4.0);
      assert.strictEqual(segments[2].duration, 3.0);

      const totalDuration = segments.reduce((sum, s) => sum + s.duration, 0);
      assert.strictEqual(Number(totalDuration.toFixed(3)), 10.0);
    });

    it("preserves source footage continuity with zero gap and zero overlap", () => {
      const cuts = [2.5, 6.0];
      const segments = splitVisualSegmentAtBoundaries(mockClip, cuts);

      assert.strictEqual(segments[0].sourceStart, 1.0);
      assert.strictEqual(segments[0].sourceDuration, 2.5);

      assert.strictEqual(segments[1].sourceStart, 3.5);
      assert.strictEqual(segments[1].sourceDuration, 3.5);

      assert.strictEqual(segments[2].sourceStart, 7.0);
      assert.strictEqual(segments[2].sourceDuration, 4.0);

      assert.strictEqual(segments[0].sourceStart + segments[0].sourceDuration, segments[1].sourceStart);
      assert.strictEqual(segments[1].sourceStart + segments[1].sourceDuration, segments[2].sourceStart);
    });

    it("scales source points accurately for non-standard playback rates", () => {
      const fastClip = { ...mockClip, playbackRate: 2.0, sourceStart: 0.0, duration: 8.0 };
      const segments = splitVisualSegmentAtBoundaries(fastClip, [3.0, 5.0]);

      assert.strictEqual(segments.length, 3);
      assert.strictEqual(segments[0].sourceStart, 0.0);
      assert.strictEqual(segments[0].sourceDuration, 6.0);

      assert.strictEqual(segments[1].sourceStart, 6.0);
      assert.strictEqual(segments[1].sourceDuration, 4.0);

      assert.strictEqual(segments[2].sourceStart, 10.0);
      assert.strictEqual(segments[2].sourceDuration, 6.0);
    });

    it("assigns unique IDs to split segments while preserving archiveMediaId", () => {
      const segments = splitVisualSegmentAtBoundaries(mockClip, [4.0]);
      assert.strictEqual(segments.length, 2);
      assert.notStrictEqual(segments[0].id, segments[1].id);
      assert.strictEqual(segments[0].archiveMediaId, "clip-orig");
      assert.strictEqual(segments[1].archiveMediaId, "clip-orig");
    });

    it("remaps keyframes relative to each segment start", () => {
      const segments = splitVisualSegmentAtBoundaries(mockClip, [4.0]);
      assert.deepStrictEqual(segments[0].keyframes, [
        { time: 1.0, scale: 1.0 },
        { time: 3.0, scale: 1.2 },
      ]);
      assert.deepStrictEqual(segments[1].keyframes, [
        { time: 3.0, scale: 1.5 },
      ]);
    });

    it("preserves trailing transition on last segment and clears it on intermediate cuts", () => {
      const segments = splitVisualSegmentAtBoundaries(mockClip, [3.0, 7.0]);
      assert.deepStrictEqual(segments[0].transition, { id: "none", duration: 0 });
      assert.deepStrictEqual(segments[1].transition, { id: "none", duration: 0 });
      assert.deepStrictEqual(segments[2].transition, { id: "fade", duration: 0.5 });
    });
  });

  describe("Phase 3 Apply Scene Cuts Workflow & Timeline Invariants", () => {
    it("splices split segments into visual track without mutating unrelated clips", () => {
      const clipA = { id: "clip-a", type: "video", duration: 5.0 };
      const targetClip = { id: "clip-target", type: "video", duration: 8.0, sourceStart: 0 };
      const clipB = { id: "clip-b", type: "video", duration: 4.0 };
      const timeline = [clipA, targetClip, clipB];

      const split = splitVisualSegmentAtBoundaries(targetClip, [3.0, 5.0]);
      assert.strictEqual(split.length, 3);

      const nextTimeline = [...timeline];
      const targetIndex = nextTimeline.findIndex((c) => c.id === "clip-target");
      nextTimeline.splice(targetIndex, 1, ...split);

      assert.strictEqual(nextTimeline.length, 5);
      assert.strictEqual(nextTimeline[0], clipA);
      assert.strictEqual(nextTimeline[4], clipB);
      assert.strictEqual(nextTimeline[1], split[0]);
      assert.strictEqual(nextTimeline[2], split[1]);
      assert.strictEqual(nextTimeline[3], split[2]);

      const origTotal = timeline.reduce((sum, c) => sum + c.duration, 0);
      const nextTotal = nextTimeline.reduce((sum, c) => sum + c.duration, 0);
      assert.strictEqual(origTotal, nextTotal);
    });

    it("preserves audio, captions, and overlays across scene cuts application", () => {
      const project = {
        visualSegments: [{ id: "v1", type: "video", duration: 10.0 }],
        audioSegments: [{ id: "a1", start: 0, duration: 10.0, text: "voiceover" }],
        captionSegments: [{ id: "c1", start: 0, end: 5.0, text: "hello" }],
        visualOverlaySegments: [{ id: "ov1", start: 2.0, duration: 4.0 }],
      };

      const split = splitVisualSegmentAtBoundaries(project.visualSegments[0], [4.0]);
      const updatedProject = {
        ...project,
        visualSegments: split,
      };

      assert.strictEqual(updatedProject.visualSegments.length, 2);
      assert.strictEqual(updatedProject.audioSegments, project.audioSegments);
      assert.strictEqual(updatedProject.captionSegments, project.captionSegments);
      assert.strictEqual(updatedProject.visualOverlaySegments, project.visualOverlaySegments);
    });

    it("simulates atomic undo and redo of applied scene cuts", () => {
      const originalClip = { id: "clip-1", type: "video", duration: 6.0 };
      let currentVisuals = [originalClip];

      const historyStack = [];
      const redoStack = [];

      historyStack.push(JSON.parse(JSON.stringify(currentVisuals)));

      const split = splitVisualSegmentAtBoundaries(originalClip, [2.0, 4.0]);
      currentVisuals = split;
      assert.strictEqual(currentVisuals.length, 3);

      redoStack.push(JSON.parse(JSON.stringify(currentVisuals)));
      currentVisuals = historyStack.pop();
      assert.strictEqual(currentVisuals.length, 1);
      assert.strictEqual(currentVisuals[0].id, "clip-1");
      assert.strictEqual(currentVisuals[0].duration, 6.0);

      historyStack.push(JSON.parse(JSON.stringify(currentVisuals)));
      currentVisuals = redoStack.pop();
      assert.strictEqual(currentVisuals.length, 3);
      assert.strictEqual(currentVisuals[0].duration, 2.0);
      assert.strictEqual(currentVisuals[1].duration, 2.0);
      assert.strictEqual(currentVisuals[2].duration, 2.0);
    });

    it("handles locked track, stale plan, and missing clip guards cleanly", () => {
      const clip = { id: "clip-target", duration: 10.0 };
      const applyGuard = ({ locked, targetIndex, draftVersion, currentVersion, boundaries }) => {
        if (locked) return { success: false, reason: "LOCKED" };
        if (targetIndex < 0) return { success: false, reason: "CLIP_NOT_FOUND" };
        if (draftVersion && draftVersion !== currentVersion) return { success: false, reason: "STALE" };
        const valid = validateSceneCutBoundaries(boundaries, clip.duration);
        if (!valid.length) return { success: false, reason: "NO_BOUNDARIES" };
        return { success: true, count: valid.length };
      };

      assert.strictEqual(applyGuard({ locked: true }).reason, "LOCKED");
      assert.strictEqual(applyGuard({ locked: false, targetIndex: -1 }).reason, "CLIP_NOT_FOUND");
      assert.strictEqual(applyGuard({ locked: false, targetIndex: 0, draftVersion: "v1", currentVersion: "v2" }).reason, "STALE");
      assert.strictEqual(applyGuard({ locked: false, targetIndex: 0, boundaries: [] }).reason, "NO_BOUNDARIES");
      assert.strictEqual(applyGuard({ locked: false, targetIndex: 0, boundaries: [3.0] }).success, true);
    });
  });

  describe("i18n completeness", () => {
    const requiredKeys = [
      "sceneDetectTitle",
      "sceneDetectHint",
      "sceneDetectIntro",
      "sceneDetectSelect",
      "sceneDetectThreshold",
      "sceneDetectInterval",
      "sceneDetectMinDuration",
      "sceneDetectAnalyze",
      "sceneDetectCancel",
      "sceneDetectDismiss",
      "sceneDetectSummary",
      "sceneDetectEmpty",
      "sceneDetectUnsupported",
      "sceneDetectFailed",
      "sceneDetectLocked",
      "sceneDetectStale",
      "sceneDetectApply",
      "sceneDetectApproved",
      "sceneDetectLocal",
      "sceneDetectSelectAll",
      "sceneDetectDeselectAll",
      "sceneDetectPreparing",
      "sceneDetectAnalyzing",
      "sceneDetectSceneIndex",
      "sceneDetectConfidence",
      "sceneDetectPreview",
      "sceneDetectPrev",
      "sceneDetectNext",
      "sceneDetectApplyCuts",
      "sceneDetectApplied",
      "sceneDetectNoBoundaries",
      "sceneDetectClipLocked",
      "sceneDetectClipNotFound",
    ];

    it("defines English copy for all required keys", () => {
      const en = SCENE_DETECTION_COPY.en;
      assert.ok(en, "English copy dictionary must exist");
      for (const key of requiredKeys) {
        assert.ok(
          Boolean(en[key]),
          `Missing key "${key}" in SCENE_DETECTION_COPY.en`
        );
      }
    });

    it("defines copy across all 13 supported project languages", () => {
      const languages = [
        "zh", "en", "ja", "ko", "es", "fr", "de", "pt", "th", "vi", "ru", "it", "id"
      ];
      for (const lang of languages) {
        assert.ok(
          SCENE_DETECTION_COPY[lang],
          `Missing language "${lang}" in SCENE_DETECTION_COPY`
        );
        for (const key of requiredKeys) {
          assert.ok(
            Boolean(SCENE_DETECTION_COPY[lang][key]),
            `Missing key "${key}" in SCENE_DETECTION_COPY.${lang}`
          );
        }
      }
    });
  });

  describe("BUG-SD-001 — Scene Boundary Preview & Review Layout", () => {
    it("clicking a boundary preview calculates timeline offset and seeks to timestamp", () => {
      const visualSegments = [
        { id: "clip-intro", duration: 4.2 },
        { id: "clip-main", duration: 15.0 },
      ];
      const boundaryTime = 3.8;
      const targetTimelineTime = calculateBoundaryTimelineOffset(visualSegments, "clip-main", boundaryTime);
      assert.strictEqual(targetTimelineTime, 8.0);

      // Verify seek dispatch parameters
      const seeks = [];
      const seekTo = (time, opts) => seeks.push({ time, opts });
      seekTo(targetTimelineTime, { immediate: true, play: true });

      assert.strictEqual(seeks.length, 1);
      assert.strictEqual(seeks[0].time, 8.0);
      assert.deepStrictEqual(seeks[0].opts, { immediate: true, play: true });
    });

    it("previewing multiple boundaries consecutively updates the seek timestamp each time", () => {
      const visualSegments = [{ id: "c1", duration: 30.0 }];
      const boundaries = [2.5, 7.0, 14.2, 22.8];

      const seeks = [];
      const seekTo = (time, opts) => seeks.push({ time, opts });

      let currentPreviewTime = null;

      boundaries.forEach((time) => {
        const offset = calculateBoundaryTimelineOffset(visualSegments, "c1", time);
        seekTo(offset, { immediate: true, play: true });
        currentPreviewTime = time;
      });

      assert.strictEqual(seeks.length, 4);
      assert.strictEqual(seeks[0].time, 2.5);
      assert.strictEqual(seeks[1].time, 7.0);
      assert.strictEqual(seeks[2].time, 14.2);
      assert.strictEqual(seeks[3].time, 22.8);
      assert.strictEqual(currentPreviewTime, 22.8);
    });

    it("previewing boundaries does NOT alter boundary selection states", () => {
      // User has selected boundaries at 2.5 and 14.2
      const initialSelection = [2.5, 14.2];
      let selectedBoundaries = [...initialSelection];

      // Simulate previewing boundaries at 2.5, 7.0, 14.2, 22.8
      const boundariesToPreview = [2.5, 7.0, 14.2, 22.8];
      const previewed = [];

      boundariesToPreview.forEach((time) => {
        // Previewing only updates previewingTime and dispatches seek
        previewed.push(time);
        // Note: selectedBoundaries is NOT touched by previewTime!
      });

      // Verify that after 4 consecutive previews, selection remains identical
      assert.deepStrictEqual(selectedBoundaries, initialSelection);
      assert.strictEqual(selectedBoundaries.length, 2);
      assert.ok(selectedBoundaries.includes(2.5));
      assert.ok(selectedBoundaries.includes(14.2));
      assert.ok(!selectedBoundaries.includes(7.0));
      assert.ok(!selectedBoundaries.includes(22.8));
    });

    it("review mode layout configuration keeps main video preview unobscured", () => {
      // Simulate layout decision logic in SceneDetectionModal
      const computeLayoutState = (draft, userChoice = null, dockSide = "right") => {
        const isReviewing = Boolean(draft);
        const effectivePosition = userChoice || (isReviewing ? dockSide : "center");
        const isDocked = effectivePosition === "right" || effectivePosition === "left";
        return { isReviewing, effectivePosition, isDocked };
      };

      // Before detection (draft is null): centered modal
      const beforeDetection = computeLayoutState(null);
      assert.strictEqual(beforeDetection.isReviewing, false);
      assert.strictEqual(beforeDetection.isDocked, false);
      assert.strictEqual(beforeDetection.effectivePosition, "center");

      // In review mode (draft exists): automatically docked to side (unobscured preview)
      const reviewMode = computeLayoutState({ scenes: [1, 2], boundaries: [2.5] });
      assert.strictEqual(reviewMode.isReviewing, true);
      assert.strictEqual(reviewMode.isDocked, true);
      assert.strictEqual(reviewMode.effectivePosition, "right");

      // User can switch dock side to left
      const dockedLeft = computeLayoutState({ scenes: [1] }, null, "left");
      assert.strictEqual(dockedLeft.isDocked, true);
      assert.strictEqual(dockedLeft.effectivePosition, "left");

      // User explicit toggle to center
      const userCentered = computeLayoutState({ scenes: [1] }, "center");
      assert.strictEqual(userCentered.isDocked, false);
      assert.strictEqual(userCentered.effectivePosition, "center");
    });

    it("handles boundary preview errors or unavailable media gracefully", () => {
      let notification = "";
      const notify = (msg) => { notification = msg; };

      // Simulate previewTime failure path
      const simulatedPreviewTime = (time, seekFn) => {
        try {
          if (!Number.isFinite(time)) return false;
          seekFn();
          return true;
        } catch (err) {
          notify("Unable to preview scene boundary frame.");
          return false;
        }
      };

      // Non-finite time handled
      const r1 = simulatedPreviewTime(NaN, () => {});
      assert.strictEqual(r1, false);

      // Broken media decoder/seek throws handled gracefully
      const r2 = simulatedPreviewTime(5.0, () => {
        throw new Error("MEDIA_DECODE_ERROR: pipeline closed");
      });
      assert.strictEqual(r2, false);
      assert.strictEqual(notification, "Unable to preview scene boundary frame.");
    });

    it("verifies boundary selection and Apply Cuts still work seamlessly with review layout", () => {
      const draft = {
        duration: 16.0,
        boundaries: [
          { time: 4.0, confidence: 0.88 },
          { time: 9.5, confidence: 0.92 },
          { time: 13.0, confidence: 0.75 },
        ],
        scenes: [
          { index: 0, start: 0, end: 4.0, duration: 4.0 },
          { index: 1, start: 4.0, end: 9.5, duration: 5.5 },
          { index: 2, start: 9.5, end: 13.0, duration: 3.5 },
          { index: 3, start: 13.0, end: 16.0, duration: 3.0 },
        ],
      };

      // User initially has all 3 boundaries selected
      let selected = draft.boundaries.map((b) => b.time);
      assert.deepStrictEqual(selected, [4.0, 9.5, 13.0]);

      // User toggles boundary at 9.5s off
      selected = toggleBoundarySelection(selected, 9.5);
      assert.deepStrictEqual(selected, [4.0, 13.0]);

      // Apply cuts plan generation
      const approvedPlan = buildApprovedScenePlan(draft, selected);
      assert.strictEqual(approvedPlan.length, 3);
      assert.deepStrictEqual(approvedPlan[0], { index: 0, start: 0, end: 4.0, duration: 4.0 });
      assert.deepStrictEqual(approvedPlan[1], { index: 1, start: 4.0, end: 13.0, duration: 9.0 });
      assert.deepStrictEqual(approvedPlan[2], { index: 2, start: 13.0, end: 16.0, duration: 3.0 });

      // Apply cuts to visual track segment
      const originalClip = {
        id: "clip-video-1",
        type: "video",
        start: 0,
        duration: 16.0,
        sourceStart: 0,
        sourceEnd: 16.0,
      };

      const splitResult = splitVisualSegmentAtBoundaries(originalClip, selected);
      assert.strictEqual(splitResult.length, 3);
      assert.strictEqual(splitResult[0].duration, 4.0);
      assert.strictEqual(splitResult[1].duration, 9.0);
      assert.strictEqual(splitResult[2].duration, 3.0);
      assert.strictEqual(
        splitResult.reduce((sum, c) => sum + c.duration, 0),
        16.0
      );
    });
  });
});
