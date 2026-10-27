import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createSmartPipelinePlan,
  buildSmartPipelineReview,
  calculatePipelineMetrics,
  canRemovePauses,
} from "../../src/lib/smartPipeline.js";
import { syncTimelineAudioElement } from "../../src/hooks/useMediaSync.js";
import { materializeProjectCaptionTimings } from "../../src/lib/projectCommandEngine.js";
import { restoreBrowserProjectMedia, browserProjectFingerprint } from "../../src/lib/browserEditPlan.js";
import { getCaptionTimeline } from "../../src/lib/timeline.js";

describe("Smart Editing Pipeline Core Logic", () => {
  describe("calculatePipelineMetrics", () => {
    it("should compute correct metrics for empty candidates", () => {
      const metrics = calculatePipelineMetrics(10, []);
      assert.strictEqual(metrics.originalDuration, 10);
      assert.strictEqual(metrics.projectedDuration, 10);
      assert.strictEqual(metrics.timeSaved, 0);
      assert.strictEqual(metrics.percentageReduced, 0);
      assert.strictEqual(metrics.enabledCutsCount, 0);
    });

    it("should calculate time saved and percentage reduction accurately", () => {
      const candidates = [
        { id: "c1", start: 2, end: 4, type: "pause", enabled: true },
        { id: "c2", start: 6, end: 7, type: "filler", enabled: true },
        { id: "c3", start: 8, end: 9, type: "pause", enabled: false }, // Excluded
      ];
      const captions = [{ id: "cap1", start: 0, end: 2, text: "Hi" }];
      const metrics = calculatePipelineMetrics(10, candidates, captions);

      assert.strictEqual(metrics.originalDuration, 10);
      // 2s from c1 + 1s from c2 = 3s saved
      assert.strictEqual(metrics.timeSaved, 3);
      assert.strictEqual(metrics.projectedDuration, 7);
      assert.strictEqual(metrics.percentageReduced, 30);
      assert.strictEqual(metrics.totalCutsCount, 3);
      assert.strictEqual(metrics.enabledCutsCount, 2);
      assert.strictEqual(metrics.pauseCount, 2);
      assert.strictEqual(metrics.fillerCount, 1);
      assert.strictEqual(metrics.captionCount, 1);
    });
  });

  describe("createSmartPipelinePlan", () => {
    const clip = { id: "clip-1", duration: 8.0, name: "TestClip.mp4" };
    // 8 seconds total. Probabilities at 16kHz with 512 frame step = 0.032s per step
    // 250 steps for 8 seconds.
    // 0 to 1.5s: speech (0.9)
    // 1.5 to 3.5s: silence (0.05) -> 2.0s pause candidate
    // 3.5 to 5.0s: speech (0.9)
    // 5.0 to 6.5s: silence (0.05) -> 1.5s pause candidate
    // 6.5 to 8.0s: speech (0.9)
    const probs = new Float32Array(250);
    for (let i = 0; i < 250; i++) {
      const t = i * 0.032;
      if (t < 1.5 || (t >= 3.5 && t < 5.0) || t >= 6.5) {
        probs[i] = 0.9;
      } else {
        probs[i] = 0.05;
      }
    }

    const transcriptResult = {
      segments: [
        { id: "s1", start: 0.2, end: 1.2, text: "Welcome to the editor" },
        { id: "s2", start: 3.6, end: 4.8, text: "Let's check the cuts" },
        { id: "s3", start: 6.6, end: 7.8, text: "All done now" },
      ],
      rawChunks: [
        { text: "Welcome", timestamp: [0.2, 0.6] },
        { text: "to", timestamp: [0.6, 0.8] },
        { text: "the", timestamp: [0.8, 1.0] },
        { text: "editor", timestamp: [1.0, 1.2] },
        { text: "um", timestamp: [3.5, 3.6] },
      ],
      text: "Welcome to the editor\nLet's check the cuts\nAll done now",
    };

    it("should build a valid pipeline plan with cuts and captions", () => {
      const plan = createSmartPipelinePlan({
        clip,
        probabilities: probs,
        transcriptResult,
        settings: {
          threshold: 0.5,
          minimum: 0.8,
          keep: 0.3,
          removeFillerWords: true,
        },
      });

      assert.strictEqual(plan.clip.id, "clip-1");
      assert.ok(Array.isArray(plan.candidates));
      assert.ok(plan.candidates.length > 0);
      assert.strictEqual(plan.captionSegments.length, 3);
      assert.ok(plan.metrics.timeSaved > 0);
      assert.ok(plan.metrics.projectedDuration < 8.0);
    });

    it("should reject clips with non-positive duration", () => {
      assert.throws(() => {
        createSmartPipelinePlan({
          clip: { id: "bad", duration: 0 },
          probabilities: probs,
        });
      }, { code: "pipelineClipUnsupported" });
    });
  });

  describe("buildSmartPipelineReview", () => {
    const makeSnapshot = () => ({
      visualSegments: [
        { id: "clip-1", type: "video", duration: 6.0, sourceStart: 0, sourceDuration: 6.0, playbackRate: 1 },
      ],
      audioSegments: [
        { id: "aud-1", start: 0, duration: 6.0, sourceStart: 0, sourceDuration: 6.0, playbackRate: 1 },
      ],
      captionSegments: [],
      visualOverlaySegments: [],
      stickerSegments: [],
      musicSegments: [],
      trackLocks: {},
    });

    const runtime = {
      visualSegments: [
        { id: "clip-1", type: "video", duration: 6.0, playbackRate: 1 },
      ],
    };

    it("should synchronously apply cuts and align captions in one atomic review", () => {
      const snapshot = makeSnapshot();
      const approvedCuts = [
        { id: "cut-1", start: 1.5, end: 3.5, duration: 2.0, type: "pause", enabled: true },
      ];
      const approvedCaptions = [
        { id: "cap-1", start: 0.2, end: 1.2, text: "Before cut" },
        { id: "cap-2", start: 4.0, end: 5.5, text: "After cut" },
      ];

      const review = buildSmartPipelineReview({
        snapshot,
        runtime,
        clipId: "clip-1",
        approvedCuts,
        approvedCaptions,
        rippleEditing: true,
        includeCaptions: true,
        includeCuts: true,
      });

      assert.strictEqual(review.hasChanges, true);
      assert.strictEqual(review.isSmartPipeline, true);
      assert.strictEqual(review.appliedCutsCount, 1);
      assert.strictEqual(review.appliedCaptionsCount, 2);

      // Duration: 6.0s - 2.0s = 4.0s
      assert.strictEqual(review.duration, 4.0);
      assert.strictEqual(review.project.visualSegments.length, 2);

      // Captions: cap-1 (before cut) unchanged at 0.2-1.2
      assert.strictEqual(review.project.captionSegments[0].start, 0.2);
      assert.strictEqual(review.project.captionSegments[0].end, 1.2);
      assert.strictEqual(review.project.captionSegments[0].text, "Before cut");

      // Caption 2: originally 4.0-5.5, shifted left by 2.0s cut -> 2.0-3.5
      assert.strictEqual(review.project.captionSegments[1].start, 2.0);
      assert.strictEqual(review.project.captionSegments[1].end, 3.5);
      assert.strictEqual(review.project.captionSegments[1].text, "After cut");

      // Audio track sliced and collapsed
      assert.strictEqual(review.project.audioSegments.length, 2);
    });

    it("should allow applying only captions when cuts are unselected", () => {
      const snapshot = makeSnapshot();
      const approvedCaptions = [
        { id: "cap-1", start: 1.0, end: 3.0, text: "Captions only" },
      ];

      const review = buildSmartPipelineReview({
        snapshot,
        runtime,
        clipId: "clip-1",
        approvedCuts: [],
        approvedCaptions,
        rippleEditing: true,
        includeCaptions: true,
        includeCuts: false,
      });

      assert.strictEqual(review.hasChanges, true);
      assert.strictEqual(review.appliedCutsCount, 0);
      assert.strictEqual(review.appliedCaptionsCount, 1);
      // Visual segment duration untouched
      assert.strictEqual(review.duration, 6.0);
      assert.strictEqual(review.project.visualSegments.length, 1);
      // Caption added
      assert.strictEqual(review.project.captionSegments.length, 1);
      assert.strictEqual(review.project.captionSegments[0].text, "Captions only");
    });

    it("should allow applying only cuts when captions are unselected", () => {
      const snapshot = makeSnapshot();
      const approvedCuts = [
        { id: "cut-1", start: 2.0, end: 3.0, duration: 1.0, type: "pause", enabled: true },
      ];

      const review = buildSmartPipelineReview({
        snapshot,
        runtime,
        clipId: "clip-1",
        approvedCuts,
        approvedCaptions: [{ id: "c1", start: 0, end: 1, text: "Omitted" }],
        rippleEditing: true,
        includeCaptions: false, // EXCLUDED
        includeCuts: true,
      });

      assert.strictEqual(review.hasChanges, true);
      assert.strictEqual(review.appliedCutsCount, 1);
      assert.strictEqual(review.appliedCaptionsCount, 0);
      assert.strictEqual(review.duration, 5.0);
      assert.strictEqual(review.project.captionSegments.length, 0);
    });

    it("should respect candidate exclusion toggles", () => {
      const snapshot = makeSnapshot();
      const approvedCuts = [
        { id: "cut-1", start: 1.0, end: 2.0, duration: 1.0, enabled: false }, // Excluded
        { id: "cut-2", start: 3.0, end: 4.0, duration: 1.0, enabled: true }, // Included
      ];

      const review = buildSmartPipelineReview({
        snapshot,
        runtime,
        clipId: "clip-1",
        approvedCuts,
        approvedCaptions: [],
        rippleEditing: true,
        includeCaptions: false,
        includeCuts: true,
      });

      // Only 1 cut applied (1.0s removed: 6.0 -> 5.0s)
      assert.strictEqual(review.duration, 5.0);
      assert.strictEqual(review.appliedCutsCount, 1);
      assert.strictEqual(review.project.visualSegments.length, 2);
    });

    it("should throw pipelineNoSelection if neither cuts nor captions are approved", () => {
      const snapshot = makeSnapshot();
      assert.throws(() => {
        buildSmartPipelineReview({
          snapshot,
          runtime,
          clipId: "clip-1",
          approvedCuts: [],
          approvedCaptions: [],
          includeCaptions: false,
          includeCuts: false,
        });
      }, { code: "pipelineNoSelection" });
    });

    it("should throw pipelineLocked if visual track is locked", () => {
      const snapshot = makeSnapshot();
      snapshot.trackLocks = { image: true };
      assert.throws(() => {
        buildSmartPipelineReview({
          snapshot,
          runtime,
          clipId: "clip-1",
          approvedCuts: [{ id: "c1", start: 1, end: 2, enabled: true }],
        });
      }, { code: "pipelineLocked" });
    });

    it("should leave the input snapshot completely unmutated", () => {
      const snapshot = makeSnapshot();
      const snapshotJson = JSON.stringify(snapshot);
      const approvedCuts = [
        { id: "cut-1", start: 1.5, end: 2.5, duration: 1.0, enabled: true },
      ];

      buildSmartPipelineReview({
        snapshot,
        runtime,
        clipId: "clip-1",
        approvedCuts,
        approvedCaptions: [{ id: "cap-1", start: 0, end: 1, text: "Hi" }],
      });

      assert.strictEqual(JSON.stringify(snapshot), snapshotJson);
    });
  });

  describe("Clip Support Validation & Selection Priority", () => {
    it("should correctly validate clean, trimmed, transitioned, speed-curved, and image clips", () => {
      const cleanVideo = { id: "v1", type: "video", duration: 5.0 };
      const trimmedVideo = { id: "v2", type: "video", duration: 3.0, sourceStart: 2.0 };
      const speedCurvedVideo = { id: "v3", type: "video", duration: 5.0, speedCurve: { enabled: true } };
      const transitionedVideo = { id: "v4", type: "video", duration: 5.0, transition: { id: "crossfade", duration: 0.5 } };
      const imageClip = { id: "img1", type: "image", duration: 4.0 };

      assert.strictEqual(canRemovePauses(cleanVideo, null), true, "Clean video should be supported");
      assert.strictEqual(canRemovePauses(trimmedVideo, null), true, "Trimmed video should be supported");
      assert.strictEqual(canRemovePauses(speedCurvedVideo, null), false, "Speed curved video should NOT be supported");
      assert.strictEqual(canRemovePauses(transitionedVideo, null), false, "Transitioned video should NOT be supported");
      assert.strictEqual(canRemovePauses(cleanVideo, transitionedVideo), false, "Video following transitioned clip should NOT be supported");
      assert.strictEqual(canRemovePauses(imageClip, null), false, "Image clip should NOT be supported");
    });

    it("should prioritize video clips over selected image clips for activeClip resolution", () => {
      const imageClip = { id: "img1", type: "image", duration: 3.0 };
      const videoClip = { id: "v1", type: "video", duration: 6.0 };
      const visualSegments = [imageClip, videoClip];

      const resolveActiveClip = (selectedSegment, selectedClipId = null) => {
        const isVideo = (c) => c?.type === "video";
        const explicitClip = selectedClipId ? visualSegments.find((c) => c.id === selectedClipId) : null;
        return explicitClip
          || (isVideo(selectedSegment) ? selectedSegment : null)
          || visualSegments.find(isVideo)
          || (selectedSegment ? visualSegments.find((c) => c.id === selectedSegment.id) : null)
          || visualSegments[0]
          || null;
      };

      // When image is selected on timeline, activeClip resolves to videoClip
      const activeWhenImageSelected = resolveActiveClip(imageClip);
      assert.strictEqual(activeWhenImageSelected.id, "v1", "Should auto-select video clip instead of image");
      assert.strictEqual(canRemovePauses(activeWhenImageSelected, null), true, "Active clip should be trimmable");

      // When video is selected on timeline, activeClip resolves to videoClip
      const activeWhenVideoSelected = resolveActiveClip(videoClip);
      assert.strictEqual(activeWhenVideoSelected.id, "v1");

      // When user explicitly picks imageClip in dropdown, explicit choice is honored
      const activeWhenExplicitImage = resolveActiveClip(videoClip, "img1");
      assert.strictEqual(activeWhenExplicitImage.id, "img1");
    });
  });

  describe("syncTimelineAudioElement Resync Across Boundaries", () => {
    it("should resync currentTime during active playback when crossing boundaries with drift > 0.15s", () => {
      let playRequested = false;
      const fakeMedia = {
        paused: false,
        currentTime: 4.8,
        playbackRate: 1,
        play: () => { playRequested = true; },
        pause: () => { fakeMedia.paused = true; },
      };

      // When drift is minimal (0.05s within same continuous segment), do NOT jolt
      syncTimelineAudioElement(fakeMedia, {
        active: true,
        shouldPlay: true,
        expectedTime: 4.85,
      });
      assert.strictEqual(fakeMedia.currentTime, 4.8, "Small playback drift should not cause seek jolt");

      // When crossing into next clip/transition where expectedTime jumps to 0.0s (drift 4.8s > 0.15s)
      syncTimelineAudioElement(fakeMedia, {
        active: true,
        shouldPlay: true,
        expectedTime: 0.0,
      });
      assert.strictEqual(fakeMedia.currentTime, 0.0, "Should immediately snap currentTime to new clip expectedTime");

      // When media is paused and drift > 0.04s, should seek and request play
      fakeMedia.paused = true;
      fakeMedia.currentTime = 1.0;
      syncTimelineAudioElement(fakeMedia, {
        active: true,
        shouldPlay: true,
        expectedTime: 2.5,
      });
      assert.strictEqual(fakeMedia.currentTime, 2.5, "Paused media should seek to expectedTime");
    });
  });

  describe("Regression: 207 Captions, Sub-0.2s Invariant, Track Locks and Stale-Plan Protection", () => {
    const totalDuration = 177.63;
    const clip = {
      id: "clip-rep",
      type: "video",
      duration: totalDuration,
      playbackRate: 1,
      sourceStart: 0,
      sourceDuration: totalDuration,
    };

    // Generate 207 caption segments with sub-0.2s utterances as produced by ASR
    const rawSegments = [];
    let t = 0.5;
    for (let i = 0; i < 207; i++) {
      const dur = (i % 7 === 0) ? 0.14 : (i % 5 === 0) ? 0.18 : 0.65;
      const start = Number(t.toFixed(2));
      const end = Number((start + dur).toFixed(2));
      rawSegments.push({
        id: `pipeline-cap-${i}`,
        start,
        end,
        text: (i % 7 === 0) ? "Okay." : (i % 5 === 0) ? "Yes," : `Segment text ${i}`,
        words: [
          { text: (i % 7 === 0) ? "Okay." : (i % 5 === 0) ? "Yes," : `Segment text ${i}`, start, end },
        ],
      });
      t = end + 0.15;
      if (t > 175) t = 175;
    }

    // 4 cuts totaling 2.7s
    const candidates = [
      { id: "cut-1", start: 12.0, end: 12.8, duration: 0.8, type: "pause", enabled: true },
      { id: "cut-2", start: 45.0, end: 45.7, duration: 0.7, type: "pause", enabled: true },
      { id: "cut-3", start: 88.0, end: 88.6, duration: 0.6, type: "filler", enabled: true },
      { id: "cut-4", start: 135.0, end: 135.6, duration: 0.6, type: "pause", enabled: true },
    ];

    const snapshot = {
      visualSegments: [clip],
      audioSegments: [{
        id: "aud-rep",
        start: 0,
        duration: totalDuration,
        sourceStart: 0,
        sourceDuration: totalDuration,
        playbackRate: 1,
      }],
      captionSegments: [],
      visualOverlaySegments: [],
      stickerSegments: [],
      musicSegments: [],
      trackLocks: {},
      sourceAudioBlob: null,
      sourceAudioLinked: true,
    };

    const runtime = { ...snapshot, visualSegments: [{ ...clip }] };

    it("should successfully plan, review, and materialize 207 captions with sub-0.2s segments and 4 cuts", () => {
      const plan = createSmartPipelinePlan({
        clip,
        transcriptResult: { segments: rawSegments },
      });

      assert.strictEqual(plan.captionSegments.length, 207);
      // All planned captions must have duration >= 0.2s
      for (const cap of plan.captionSegments) {
        assert.ok(cap.end - cap.start >= 0.2 - 0.0001, `Planned caption ${cap.id} duration < 0.2s: ${cap.end - cap.start}`);
      }

      const review = buildSmartPipelineReview({
        snapshot,
        runtime,
        clipId: "clip-rep",
        approvedCuts: candidates,
        approvedCaptions: plan.captionSegments,
        rippleEditing: true,
        includeCaptions: true,
        includeCuts: true,
      });

      assert.strictEqual(review.hasChanges, true);
      assert.strictEqual(review.isSmartPipeline, true);
      assert.strictEqual(review.appliedCutsCount, 4);
      assert.strictEqual(review.project.captionsEnabled, true);

      // Must materialize without throwing INVALID_RANGE
      assert.doesNotThrow(() => {
        materializeProjectCaptionTimings(review.project);
      });

      // Must restore media origins without throwing BROWSER_EDIT_STALE_PLAN
      const restored = restoreBrowserProjectMedia(review.project, runtime, review.mediaOrigins, []);
      assert.ok(restored.captionSegments.length > 0);
      assert.strictEqual(restored.captionsEnabled, true);
    });

    it("should clamp cut-sliced captions to >= 0.2s and drop wordless ghost slices", () => {
      const testClip = { id: "c-slice", type: "video", duration: 20, playbackRate: 1 };
      const testSnapshot = {
        visualSegments: [testClip],
        audioSegments: [],
        captionSegments: [],
        trackLocks: {},
      };
      const testRuntime = { ...testSnapshot, visualSegments: [testClip] };
      // Caption at [5.0, 6.0], cut at [5.0, 5.9] leaving 0.1s fragment
      const testCuts = [{ id: "cut-slice", start: 5.0, end: 5.9, duration: 0.9, enabled: true }];
      const testCaptions = [{
        id: "cap-slice",
        start: 5.0,
        end: 6.0,
        text: "Brief utterance",
        words: [
          { text: "Brief", start: 5.0, end: 5.4 },
          { text: "utterance", start: 5.92, end: 6.0 },
        ],
      }];

      const review = buildSmartPipelineReview({
        snapshot: testSnapshot,
        runtime: testRuntime,
        clipId: "c-slice",
        approvedCuts: testCuts,
        approvedCaptions: testCaptions,
        rippleEditing: true,
      });

      assert.ok(review.project.captionSegments.length > 0);
      for (const cap of review.project.captionSegments) {
        assert.ok(cap.end - cap.start >= 0.2 - 0.0001, `Sliced caption duration < 0.2s: ${cap.end - cap.start}`);
      }

      assert.doesNotThrow(() => {
        materializeProjectCaptionTimings(review.project);
      });
    });

    it("should reject with pipelineLocked when caption track is locked and captions are included", () => {
      const lockedSnapshot = {
        ...snapshot,
        trackLocks: { caption: true },
      };

      assert.throws(() => {
        buildSmartPipelineReview({
          snapshot: lockedSnapshot,
          runtime,
          clipId: "clip-rep",
          approvedCuts: candidates,
          approvedCaptions: rawSegments,
          includeCaptions: true,
          includeCuts: true,
        });
      }, (err) => err.code === "pipelineLocked");
    });

    it("should reject with pipelineLocked when source audio is locked and cuts are included with linked audio", () => {
      const lockedSnapshot = {
        ...snapshot,
        sourceAudioLinked: true,
        trackLocks: { source: true },
      };
      const lockedRuntime = {
        ...runtime,
        sourceAudioBlob: new Blob(["audio"]),
      };

      assert.throws(() => {
        buildSmartPipelineReview({
          snapshot: lockedSnapshot,
          runtime: lockedRuntime,
          clipId: "clip-rep",
          approvedCuts: candidates,
          approvedCaptions: rawSegments,
          includeCaptions: false,
          includeCuts: true,
        });
      }, (err) => err.code === "pipelineLocked");
    });

    it("should detect timeline fingerprint mismatch and preserve stale-plan protection", () => {
      const review = buildSmartPipelineReview({
        snapshot,
        runtime,
        clipId: "clip-rep",
        approvedCuts: candidates,
        approvedCaptions: rawSegments.slice(0, 10),
        rippleEditing: true,
      });

      // Modifying visual clip duration changes fingerprint
      const modifiedSnapshot = {
        ...snapshot,
        visualSegments: [{ ...clip, duration: 160.0 }],
      };
      const modifiedRuntime = { ...modifiedSnapshot, visualSegments: [{ ...clip, duration: 160.0 }] };
      const currentFp = browserProjectFingerprint(modifiedSnapshot, true, modifiedRuntime.visualSegments, modifiedRuntime);

      assert.notStrictEqual(review.fingerprint, currentFp, "Fingerprint should differ after timeline modification");
    });
  });

  describe("DeepSeek Bug 2 Regressions: Source-Time vs Timeline-Time Remapping (Cases A-G)", () => {
    it("Case A: First clip, sourceStart=2, transcript segment 2.2-3.0 -> expected timeline segment 0.2-1.0", () => {
      const clipA = {
        id: "clip-a",
        type: "video",
        duration: 5.0,
        sourceStart: 2.0,
        sourceDuration: 5.0,
        playbackRate: 1,
      };

      const planA = createSmartPipelinePlan({
        clip: clipA,
        transcriptResult: {
          segments: [
            { id: "seg-a", start: 2.2, end: 3.0, text: "Case A text" },
          ],
        },
      });

      // In plan (clip-local coordinates): 2.2 - 2.0 = 0.2, 3.0 - 2.0 = 1.0
      assert.strictEqual(planA.captionSegments.length, 1);
      assert.strictEqual(planA.captionSegments[0].start, 0.2);
      assert.strictEqual(planA.captionSegments[0].end, 1.0);
      assert.strictEqual(planA.captionSegments[0].text, "Case A text");

      const snapshotA = {
        visualSegments: [clipA],
        audioSegments: [],
        captionSegments: [],
        trackLocks: {},
      };
      const runtimeA = { visualSegments: [clipA] };

      const reviewA = buildSmartPipelineReview({
        snapshot: snapshotA,
        runtime: runtimeA,
        clipId: "clip-a",
        approvedCuts: [],
        approvedCaptions: planA.captionSegments,
        rippleEditing: false,
        includeCaptions: true,
        includeCuts: false,
      });

      // On timeline: offset is 0, so 0.2-1.0
      assert.strictEqual(reviewA.project.captionSegments.length, 1);
      assert.strictEqual(reviewA.project.captionSegments[0].start, 0.2);
      assert.strictEqual(reviewA.project.captionSegments[0].end, 1.0);
    });

    it("Case B: Later clip at timeline position 10, sourceStart=20, transcript segment 20.2-21.0 -> expected timeline segment 10.2-11.0", () => {
      const priorClip = { id: "clip-prior", type: "video", duration: 10.0 };
      const clipB = {
        id: "clip-b",
        type: "video",
        duration: 8.0,
        sourceStart: 20.0,
        sourceDuration: 8.0,
        playbackRate: 1,
      };

      const planB = createSmartPipelinePlan({
        clip: clipB,
        transcriptResult: {
          segments: [
            { id: "seg-b", start: 20.2, end: 21.0, text: "Case B text" },
          ],
        },
      });

      // In plan (clip-local coordinates): 20.2 - 20.0 = 0.2, 21.0 - 20.0 = 1.0
      assert.strictEqual(planB.captionSegments.length, 1);
      assert.strictEqual(planB.captionSegments[0].start, 0.2);
      assert.strictEqual(planB.captionSegments[0].end, 1.0);

      const snapshotB = {
        visualSegments: [priorClip, clipB],
        audioSegments: [],
        captionSegments: [],
        trackLocks: {},
      };
      const runtimeB = { visualSegments: [priorClip, clipB] };

      const reviewB = buildSmartPipelineReview({
        snapshot: snapshotB,
        runtime: runtimeB,
        clipId: "clip-b",
        approvedCuts: [],
        approvedCaptions: planB.captionSegments,
        rippleEditing: false,
        includeCaptions: true,
        includeCuts: false,
      });

      // Timeline position of clip-b is 10.0. Timeline segment must be 10.2 - 11.0
      assert.strictEqual(reviewB.project.captionSegments.length, 1);
      assert.strictEqual(reviewB.project.captionSegments[0].start, 10.2);
      assert.strictEqual(reviewB.project.captionSegments[0].end, 11.0);
      assert.strictEqual(reviewB.project.captionSegments[0].text, "Case B text");
    });

    it("Case C: Untrimmed first clip with a caption at time 0 correctly preserves zero", () => {
      const clipC = {
        id: "clip-c",
        type: "video",
        duration: 6.0,
        sourceStart: 0,
        sourceDuration: 6.0,
        playbackRate: 1,
      };

      const planC = createSmartPipelinePlan({
        clip: clipC,
        transcriptResult: {
          segments: [
            { id: "seg-c", start: 0, end: 1.2, text: "Starts at zero" },
          ],
        },
      });

      assert.strictEqual(planC.captionSegments.length, 1);
      assert.strictEqual(planC.captionSegments[0].start, 0);
      assert.strictEqual(planC.captionSegments[0].end, 1.2);

      const snapshotC = {
        visualSegments: [clipC],
        audioSegments: [],
        captionSegments: [],
        trackLocks: {},
      };
      const runtimeC = { visualSegments: [clipC] };

      const reviewC = buildSmartPipelineReview({
        snapshot: snapshotC,
        runtime: runtimeC,
        clipId: "clip-c",
        approvedCuts: [],
        approvedCaptions: planC.captionSegments,
        rippleEditing: false,
        includeCaptions: true,
        includeCuts: false,
      });

      assert.strictEqual(reviewC.project.captionSegments[0].start, 0);
      assert.strictEqual(reviewC.project.captionSegments[0].end, 1.2);
    });

    it("Case D: Trimmed and split clips keep captions aligned with visible media", () => {
      const clipD = {
        id: "clip-d",
        type: "video",
        duration: 10.0,
        sourceStart: 15.0,
        sourceDuration: 10.0,
        playbackRate: 1,
      };

      // Two spoken phrases in source time: [16.0, 17.5] -> clip-local [1.0, 2.5]
      // and [21.0, 23.0] -> clip-local [6.0, 8.0]
      const planD = createSmartPipelinePlan({
        clip: clipD,
        transcriptResult: {
          segments: [
            { id: "sd-1", start: 16.0, end: 17.5, text: "First phrase" },
            { id: "sd-2", start: 21.0, end: 23.0, text: "Second phrase" },
          ],
        },
      });

      assert.strictEqual(planD.captionSegments[0].start, 1.0);
      assert.strictEqual(planD.captionSegments[0].end, 2.5);
      assert.strictEqual(planD.captionSegments[1].start, 6.0);
      assert.strictEqual(planD.captionSegments[1].end, 8.0);

      // Perform a cut in the silence between them: clip-local [3.0, 5.0] (2.0s duration)
      const approvedCuts = [
        { id: "cut-d", start: 3.0, end: 5.0, duration: 2.0, type: "pause", enabled: true },
      ];

      const snapshotD = {
        visualSegments: [clipD],
        audioSegments: [],
        captionSegments: [],
        trackLocks: {},
      };
      const runtimeD = { visualSegments: [clipD] };

      const reviewD = buildSmartPipelineReview({
        snapshot: snapshotD,
        runtime: runtimeD,
        clipId: "clip-d",
        approvedCuts,
        approvedCaptions: planD.captionSegments,
        rippleEditing: true,
        includeCaptions: true,
        includeCuts: true,
      });

      // Split clip into 2 pieces
      assert.strictEqual(reviewD.project.visualSegments.length, 2);
      assert.strictEqual(reviewD.project.captionSegments.length, 2);

      // First caption remains at 1.0 - 2.5
      assert.strictEqual(reviewD.project.captionSegments[0].start, 1.0);
      assert.strictEqual(reviewD.project.captionSegments[0].end, 2.5);

      // Second caption was at 6.0-8.0, collapsed left by 2.0s cut -> 4.0 - 6.0
      assert.strictEqual(reviewD.project.captionSegments[1].start, 4.0);
      assert.strictEqual(reviewD.project.captionSegments[1].end, 6.0);
    });

    it("Case E: Caption timings cannot extend outside applicable clip range after remapping", () => {
      const clipE = {
        id: "clip-e",
        type: "video",
        duration: 6.0,
        sourceStart: 10.0,
        sourceDuration: 6.0,
        playbackRate: 1,
      };

      // Media transcript has segments before the clip window (start 2.0),
      // inside the window (start 11.0), and after the window (start 25.0)
      const planE = createSmartPipelinePlan({
        clip: clipE,
        transcriptResult: {
          segments: [
            { id: "early", start: 2.0, end: 4.0, text: "Too early" },
            { id: "inside", start: 11.0, end: 13.0, text: "Just right" },
            { id: "late", start: 25.0, end: 27.0, text: "Too late" },
          ],
        },
      });

      // Only the segment inside [10.0, 16.0] is kept, mapped to [1.0, 3.0]
      assert.strictEqual(planE.captionSegments.length, 1);
      assert.strictEqual(planE.captionSegments[0].text, "Just right");
      assert.strictEqual(planE.captionSegments[0].start, 1.0);
      assert.strictEqual(planE.captionSegments[0].end, 3.0);
    });

    it("Case F: Leading silence cut shifts early speech rather than accidentally discarding it", () => {
      const clipF = {
        id: "clip-f",
        type: "video",
        duration: 8.0,
        sourceStart: 5.0,
        sourceDuration: 8.0,
        playbackRate: 1,
      };

      // Spoken phrase at source time 6.5 - 8.0 -> clip-local [1.5, 3.0]
      // And filler word at source time 9.0 - 9.5 -> clip-local [4.0, 4.5]
      const planF = createSmartPipelinePlan({
        clip: clipF,
        transcriptResult: {
          segments: [
            { id: "early-speech", start: 6.5, end: 8.0, text: "Important speech" },
            { id: "filler-phrase", start: 9.0, end: 9.5, text: "Um like" },
          ],
        },
      });

      assert.strictEqual(planF.captionSegments[0].start, 1.5);
      assert.strictEqual(planF.captionSegments[0].end, 3.0);

      // Leading silence cut at clip-local 0.0 - 1.0, and filler cut at 4.0 - 4.5
      const cutsF = [
        { id: "lead-silence", start: 0.0, end: 1.0, duration: 1.0, type: "pause", enabled: true },
        { id: "filler-cut", start: 4.0, end: 4.5, duration: 0.5, type: "filler", enabled: true },
      ];

      const snapshotF = {
        visualSegments: [clipF],
        audioSegments: [],
        captionSegments: [],
        trackLocks: {},
      };
      const runtimeF = { visualSegments: [clipF] };

      const reviewF = buildSmartPipelineReview({
        snapshot: snapshotF,
        runtime: runtimeF,
        clipId: "clip-f",
        approvedCuts: cutsF,
        approvedCaptions: planF.captionSegments,
        rippleEditing: true,
        includeCaptions: true,
        includeCuts: true,
      });

      // The early speech was NOT discarded: its start shifted from 1.5 -> 0.5!
      const retainedCaption = reviewF.project.captionSegments.find((c) => c.text === "Important speech");
      assert.ok(retainedCaption, "Early speech must be preserved, not discarded");
      assert.strictEqual(retainedCaption.start, 0.5);
      assert.strictEqual(retainedCaption.end, 2.0);

      // The filler speech at 4.0-4.5 was genuinely cut and discarded
      const fillerCaption = reviewF.project.captionSegments.find((c) => c.text === "Um like");
      assert.strictEqual(fillerCaption, undefined, "Genuinely cut speech must be removed");
    });

    it("Case G: Preview and export use the same corrected caption timings", () => {
      const priorClip = { id: "c-pre", type: "video", duration: 7.0 };
      const mainClip = {
        id: "c-main",
        type: "video",
        duration: 10.0,
        sourceStart: 12.0,
        sourceDuration: 10.0,
        playbackRate: 1,
      };

      const planG = createSmartPipelinePlan({
        clip: mainClip,
        transcriptResult: {
          segments: [
            { id: "g1", start: 14.5, end: 17.0, text: "Synchronized captions" },
          ],
        },
      });

      const snapshotG = {
        visualSegments: [priorClip, mainClip],
        audioSegments: [],
        captionSegments: [],
        trackLocks: {},
      };
      const runtimeG = { visualSegments: [priorClip, mainClip] };

      const reviewG = buildSmartPipelineReview({
        snapshot: snapshotG,
        runtime: runtimeG,
        clipId: "c-main",
        approvedCuts: [],
        approvedCaptions: planG.captionSegments,
        rippleEditing: false,
        includeCaptions: true,
        includeCuts: false,
      });

      const projectCaptions = reviewG.project.captionSegments;
      // Timeline offset is 7.0 + (14.5 - 12.0) = 7.0 + 2.5 = 9.5
      assert.strictEqual(projectCaptions[0].start, 9.5);
      assert.strictEqual(projectCaptions[0].end, 12.0);

      // Both preview and export call getCaptionTimeline to calculate timing
      const timelineOutput = getCaptionTimeline(projectCaptions, reviewG.duration);
      assert.strictEqual(timelineOutput[0].start, 9.5);
      assert.strictEqual(timelineOutput[0].end, 12.0);
      assert.strictEqual(timelineOutput[0].duration, 2.5);

      // Materialized command engine output also agrees
      const materialized = materializeProjectCaptionTimings(reviewG.project);
      assert.strictEqual(materialized.captionSegments[0].start, 9.5);
      assert.strictEqual(materialized.captionSegments[0].end, 12.0);
    });
  });
});
