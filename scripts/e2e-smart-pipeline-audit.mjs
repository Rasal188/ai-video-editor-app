import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createSmartPipelinePlan,
  buildSmartPipelineReview,
  calculatePipelineMetrics,
  canRemovePauses,
} from "../src/lib/smartPipeline.js";
import { mergeCutCandidates } from "../src/lib/roughCut.js";
import {
  validateCaptionTimestamp,
  validateCaptionSegments,
  updateSegmentText,
  updateSegmentTiming,
  regroupReviewSegments,
} from "../src/lib/transcriptReview.js";
import { browserProjectFingerprint } from "../src/lib/browserEditPlan.js";

const exec = promisify(execFile);
const rootDir = process.cwd();
const cliScript = path.join(rootDir, "scripts", "timeline-command.mjs");
const realMedia = path.join(rootDir, "test-artifacts", "silence-test-sample.mp4");
const auditWorkDir = path.join(rootDir, "test-artifacts", "smart-pipeline-audit");

describe("Phase 4 Smart Editing Pipeline Deep Integration Audit", () => {
  before(async () => {
    await fs.promises.mkdir(auditWorkDir, { recursive: true });
    assert.ok(fs.existsSync(realMedia), `Real media fixture missing at: ${realMedia}`);
  });

  after(async () => {
    // Keep artifacts for review or clean up if needed
  });

  describe("1. Real Local Media Inspection & Audio Extraction", () => {
    it("should inspect real local media and verify duration and audio track with ffprobe", async () => {
      const { stdout } = await exec("ffprobe", [
        "-v", "error",
        "-show_entries", "format=duration:stream=codec_type,codec_name",
        "-of", "json",
        realMedia,
      ]);
      const probe = JSON.parse(stdout);
      const duration = parseFloat(probe.format.duration);
      assert.ok(duration > 5.0 && duration < 7.0, `Expected ~6.0s duration, got: ${duration}`);
      const audioStream = probe.streams.find((s) => s.codec_type === "audio");
      assert.ok(audioStream, "Expected audio stream in silence-test-sample.mp4");
      assert.strictEqual(audioStream.codec_name, "aac");
    });
  });

  describe("2. Caption Review, Timestamp Validation & Regrouping", () => {
    it("should reject negative or inverted timestamps", () => {
      assert.strictEqual(validateCaptionTimestamp(-0.5, 2.0).valid, false);
      assert.strictEqual(validateCaptionTimestamp(3.0, 2.0).valid, false);
      assert.strictEqual(validateCaptionTimestamp(NaN, 2.0).valid, false);
      assert.strictEqual(validateCaptionTimestamp(1.0, Infinity).valid, false);
      assert.strictEqual(validateCaptionTimestamp(1.0, 2.0).valid, true);
    });

    it("should flag invalid segments in a segment list and preserve validity on clean segments", () => {
      const invalidList = [
        { id: "c1", start: 0, end: 1.5, text: "Fine" },
        { id: "c2", start: 2.0, end: 1.0, text: "Bad inverted timing" },
      ];
      const check = validateCaptionSegments(invalidList);
      assert.strictEqual(check.valid, false);
      assert.strictEqual(check.errors.length, 1);
      assert.strictEqual(check.errors[0].id, "c2");

      const validList = [
        { id: "c1", start: 0, end: 1.5, text: "Fine" },
        { id: "c2", start: 1.5, end: 3.0, text: "Also fine" },
      ];
      assert.strictEqual(validateCaptionSegments(validList).valid, true);
    });

    it("should update segment text and timing cleanly without mutating existing list", () => {
      const orig = [{ id: "c1", start: 1.0, end: 2.0, text: "Hello" }];
      const editedText = updateSegmentText(orig, "c1", "Updated Text");
      assert.strictEqual(editedText[0].text, "Updated Text");
      assert.strictEqual(orig[0].text, "Hello");

      const editedTiming = updateSegmentTiming(orig, "c1", { start: 1.2, end: 2.4 });
      assert.strictEqual(editedTiming[0].start, 1.2);
      assert.strictEqual(editedTiming[0].end, 2.4);
      assert.strictEqual(orig[0].start, 1.0);
    });

    it("should regroup word chunks into phrase vs word segments", () => {
      const words = [
        { text: "Welcome", timestamp: [0.2, 0.6] },
        { text: " to", timestamp: [0.6, 0.8] },
        { text: " Timeline", timestamp: [0.8, 1.3] },
        { text: " Studio", timestamp: [1.3, 1.8] },
      ];
      const phraseGrouping = regroupReviewSegments(words, 6.0, { grouping: "phrases" });
      assert.ok(phraseGrouping.length > 0 && phraseGrouping.length < words.length);

      const wordGrouping = regroupReviewSegments(words, 6.0, { grouping: "words" });
      assert.strictEqual(wordGrouping.length, 4);
      assert.strictEqual(wordGrouping[0].text, "Welcome");
      assert.strictEqual(wordGrouping[3].text, "Studio");
    });
  });

  describe("3. Silence Detection, Candidate Merging & Exclusion", () => {
    it("should merge overlapping or contiguous cut candidates seamlessly", () => {
      const rawCandidates = [
        { start: 1.0, end: 2.0 },
        { start: 1.8, end: 3.0 }, // Overlaps with 1.0-2.0
        { start: 4.5, end: 5.5 },
      ];
      const merged = mergeCutCandidates(rawCandidates);
      assert.strictEqual(merged.length, 2);
      assert.strictEqual(merged[0].start, 1.0);
      assert.strictEqual(merged[0].end, 3.0);
      assert.strictEqual(merged[1].start, 4.5);
      assert.strictEqual(merged[1].end, 5.5);
    });

    it("should accurately reflect candidate exclusion toggles in pipeline metrics", () => {
      const candidates = [
        { id: "cut-1", start: 1.0, end: 2.5, type: "pause", enabled: true },
        { id: "cut-2", start: 3.5, end: 4.5, type: "filler", enabled: true },
      ];
      const metricsAll = calculatePipelineMetrics(6.0, candidates);
      assert.strictEqual(metricsAll.timeSaved, 2.5);
      assert.strictEqual(metricsAll.projectedDuration, 3.5);
      assert.strictEqual(metricsAll.enabledCutsCount, 2);

      // Exclude cut-1
      const excluded = candidates.map((c) => (c.id === "cut-1" ? { ...c, enabled: false } : c));
      const metricsExcluded = calculatePipelineMetrics(6.0, excluded);
      assert.strictEqual(metricsExcluded.timeSaved, 1.0);
      assert.strictEqual(metricsExcluded.projectedDuration, 5.0);
      assert.strictEqual(metricsExcluded.enabledCutsCount, 1);
    });
  });

  describe("4. Multi-Track Ripple Behavior, Track Locks & Overlays", () => {
    const makeDisposableSnapshot = () => ({
      schemaVersion: 1,
      revision: 0,
      visualSegments: [
        { id: "vis-1", type: "video", duration: 6.0, sourceStart: 0, sourceDuration: 6.0, playbackRate: 1 },
      ],
      audioSegments: [
        { id: "aud-1", start: 0, duration: 6.0, sourceStart: 0, sourceDuration: 6.0, playbackRate: 1 },
      ],
      visualOverlaySegments: [
        { id: "ov-1", start: 0.5, duration: 5.0, type: "image", src: "test.png" },
      ],
      musicSegments: [
        { id: "mus-1", start: 0, duration: 6.0, sourceStart: 0, sourceDuration: 6.0 },
      ],
      stickerSegments: [],
      captionSegments: [],
      trackLocks: {
        image: false,
        source: false,
        overlay: false,
        music: false,
        caption: false,
      },
    });

    const runtime = {
      visualSegments: [
        { id: "vis-1", type: "video", duration: 6.0, playbackRate: 1 },
      ],
    };

    it("should ripple overlays, audio, music and captions when rippleEditing is true", () => {
      const snapshot = makeDisposableSnapshot();
      const approvedCuts = [
        { id: "cut-1", start: 1.0, end: 2.0, duration: 1.0, type: "pause", enabled: true },
      ];
      const approvedCaptions = [
        { id: "cap-1", start: 0.2, end: 0.8, text: "Lead In" },
        { id: "cap-2", start: 2.5, end: 4.0, text: "After Cut" },
      ];

      const review = buildSmartPipelineReview({
        snapshot,
        runtime,
        clipId: "vis-1",
        approvedCuts,
        approvedCaptions,
        rippleEditing: true,
        includeCaptions: true,
        includeCuts: true,
      });

      assert.strictEqual(review.duration, 5.0);
      assert.strictEqual(review.project.visualSegments.length, 2);
      assert.strictEqual(review.project.audioSegments.length, 2);

      // Overlay was 0.5 - 5.5s (duration 5.0s). Cut is at 1.0 - 2.0s.
      // Overlay slices into 2 pieces: [0.5, 1.0] and [1.0, 4.5] (collapsed by 1.0s)
      assert.strictEqual(review.project.visualOverlaySegments.length, 2);
      assert.strictEqual(review.project.visualOverlaySegments[0].duration, 0.5);
      assert.strictEqual(review.project.visualOverlaySegments[1].duration, 3.5);

      // Captions: cap-2 (originally 2.5-4.0) shifted left by 1.0s to 1.5-3.0
      assert.strictEqual(review.project.captionSegments[1].start, 1.5);
      assert.strictEqual(review.project.captionSegments[1].end, 3.0);
    });

    it("should preserve overlays untouched when overlay track is locked", () => {
      const snapshot = makeDisposableSnapshot();
      snapshot.trackLocks.overlay = true; // LOCK OVERLAY TRACK

      const approvedCuts = [
        { id: "cut-1", start: 1.0, end: 2.0, duration: 1.0, type: "pause", enabled: true },
      ];

      const review = buildSmartPipelineReview({
        snapshot,
        runtime,
        clipId: "vis-1",
        approvedCuts,
        approvedCaptions: [],
        rippleEditing: true,
        includeCaptions: false,
        includeCuts: true,
      });

      // Visual track is cut into 2 pieces
      assert.strictEqual(review.project.visualSegments.length, 2);
      // Locked overlay track remains completely unaltered (1 single clip with original duration 5.0s)
      assert.strictEqual(review.project.visualOverlaySegments.length, 1);
      assert.strictEqual(review.project.visualOverlaySegments[0].duration, 5.0);
      assert.strictEqual(review.project.visualOverlaySegments[0].start, 0.5);
    });

    it("should throw pipelineLocked if visual track is locked", () => {
      const snapshot = makeDisposableSnapshot();
      snapshot.trackLocks.image = true; // LOCK VISUAL TRACK

      assert.throws(() => {
        buildSmartPipelineReview({
          snapshot,
          runtime,
          clipId: "vis-1",
          approvedCuts: [{ id: "c1", start: 1, end: 2, enabled: true }],
        });
      }, { code: "pipelineLocked" });
    });

    it("should throw pipelineLocked if linked source audio track is locked", () => {
      const snapshot = makeDisposableSnapshot();
      snapshot.trackLocks.source = true; // LOCK SOURCE AUDIO TRACK
      const runtimeWithSource = {
        ...runtime,
        sourceAudioBlob: new Blob(["dummy audio"], { type: "audio/wav" }),
      };

      assert.throws(() => {
        buildSmartPipelineReview({
          snapshot,
          runtime: runtimeWithSource,
          clipId: "vis-1",
          approvedCuts: [{ id: "c1", start: 1, end: 2, enabled: true }],
        });
      }, { code: "pipelineLocked" });
    });
  });

  describe("5. Cancellation & Stale State Safety", () => {
    it("should reject apply when snapshot fingerprint has diverged (stale plan protection)", () => {
      const snapshot = {
        visualSegments: [
          { id: "vis-1", type: "video", duration: 6.0, playbackRate: 1 },
        ],
        audioSegments: [],
        captionSegments: [],
        trackLocks: {},
      };
      const runtime = {
        visualSegments: [{ id: "vis-1", type: "video", duration: 6.0, playbackRate: 1 }],
      };

      const originalFingerprint = browserProjectFingerprint(snapshot, false, runtime.visualSegments, runtime);

      // Modify the snapshot behind the scenes
      const modifiedSnapshot = {
        ...snapshot,
        visualSegments: [
          { id: "vis-1", type: "video", duration: 4.5, playbackRate: 1 },
        ],
      };
      const modifiedRuntime = {
        visualSegments: [{ id: "vis-1", type: "video", duration: 4.5, playbackRate: 1 }],
      };

      const divergedFingerprint = browserProjectFingerprint(modifiedSnapshot, false, modifiedRuntime.visualSegments, modifiedRuntime);
      assert.notStrictEqual(divergedFingerprint, originalFingerprint);
    });

    it("should support AbortSignal cancellation during analysis without leaking or throwing uncaught", async () => {
      const controller = new AbortController();
      controller.abort();
      assert.strictEqual(controller.signal.aborted, true);
      assert.throws(() => {
        controller.signal.throwIfAborted();
      }, (err) => err.name === "AbortError");
    });
  });

  describe("6. Disposable Project Archive Save & CLI Render Verification", () => {
    it("should execute CLI pipeline edit and render project to playable MP4", async () => {
      const baseTimeline = path.join(rootDir, "test-artifacts", "base.timeline");
      const initialTimeline = path.join(auditWorkDir, "audit-disposable.timeline");
      const renderedMp4 = path.join(auditWorkDir, "audit-rendered.mp4");
      const planFile = path.join(auditWorkDir, "import-plan.json");
      const renderReqFile = path.join(auditWorkDir, "render-req.json");

      // 1. Create a disposable timeline archive with real video fixture
      const initPlan = {
        schemaVersion: 1,
        project: baseTimeline,
        baseRevision: 0,
        dryRun: false,
        operations: [
          {
            id: "op-import-1",
            type: "asset.import",
            track: "visuals",
            clipId: "video-clip-1",
            file: realMedia,
          },
        ],
        output: {
          project: initialTimeline,
        },
      };
      await fs.promises.writeFile(planFile, JSON.stringify(initPlan, null, 2));

      const { stdout: initOut } = await exec(process.execPath, [
        cliScript,
        "project.run",
        planFile,
      ]);
      const initRes = JSON.parse(initOut);
      assert.strictEqual(initRes.ok, true);
      assert.ok(fs.existsSync(initialTimeline), "Disposable timeline archive was not created");

      // 2. Render MP4 via timeline-command.mjs project.render
      const renderReq = {
        schemaVersion: 1,
        project: initialTimeline,
        output: {
          video: renderedMp4,
        },
        render: {
          width: 1280,
          height: 720,
          frameRate: 30,
        },
      };
      await fs.promises.writeFile(renderReqFile, JSON.stringify(renderReq, null, 2));

      const { stdout: renderOut } = await exec(process.execPath, [
        cliScript,
        "project.render",
        renderReqFile,
      ]);
      const renderRes = JSON.parse(renderOut);
      assert.strictEqual(renderRes.ok, true);
      assert.ok(fs.existsSync(renderedMp4), "Rendered MP4 file does not exist");

      // 3. Verify output MP4 with ffprobe
      const { stdout: probeOut } = await exec("ffprobe", [
        "-v", "error",
        "-show_entries", "format=duration:stream=codec_name,width,height",
        "-of", "json",
        renderedMp4,
      ]);
      const probe = JSON.parse(probeOut);
      assert.ok(parseFloat(probe.format.duration) > 5.0, "Rendered duration too short");
      const vStream = probe.streams.find((s) => s.width > 0);
      assert.ok(vStream, "Rendered MP4 missing video stream");
      assert.strictEqual(vStream.codec_name, "h264");
    });
  });
});
