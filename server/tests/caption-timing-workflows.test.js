import { encodeCloudWav } from "../../src/lib/cloudTranscriptionAudio.js";
// Stage 2 capability checks require real decodable media, not size/type stubs.
const captionMediaFixture = () => encodeCloudWav(new Float32Array(16000));
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { captionSegmentsFromWords } from "../../src/lib/captionSegmentation.js";
import { resolveCaptionSourceMedia } from "../../src/lib/captionSourceResolver.js";
import {
  getCaptionTimeline,
  getSegmentIndexAtTime,
  hasExplicitCaptionTiming,
} from "../../src/lib/timeline.js";
import {
  getTimelineInitialContentZoom,
  getTimelineVisibleDuration,
  getTimelineTrackWidthPercent,
} from "../../src/lib/timelineScale.js";
import { serializeSrt } from "../../src/lib/subtitles.js";
import {
  applyCommandPlan,
  materializeProjectCaptionTimings,
} from "../../src/lib/projectCommandEngine.js";
import {
  createSmartPipelinePlan,
  buildSmartPipelineReview,
} from "../../src/lib/smartPipeline.js";
import { regroupReviewSegments } from "../../src/lib/transcriptReview.js";

describe("Caption Timing Across All Workflows (Deterministic Regression Suite)", () => {
  // Test helper: mock word tokens from ASR Whisper output
  const makeMockWord = (text, start, end) => ({
    text,
    timestamp: [start, end],
  });

  const createBaseProject = (overrides = {}) => ({
    schemaVersion: 1,
    duration: 56.58,
    captionsEnabled: false,
    captionSegments: [
      { id: "default-1", text: "在时间的长河里", fontId: "default" },
      { id: "default-2", text: "留下属于你的声音", fontId: "default" },
    ],
    script: "在时间的长河里\n留下属于你的声音",
    captionStyle: { fontId: "default", captionSize: 24 },
    captionPlacement: { x: 50, y: 78 },
    captionPosition: "bottom",
    visualSegments: [
      {
        id: "video-clip-1",
        type: "video",
        start: 0,
        duration: 56.58,
        sourceStart: 0,
        sourceDuration: 56.58,
        playbackRate: 1,
        hasAudio: true,
        isMuted: false,
        volume: 1,
        blob: new Blob(["mock-video"], { type: "video/mp4" }),
      },
    ],
    audioSegments: [],
    musicSegments: [],
    visualOverlaySegments: [],
    stickerSegments: [],
    timelineMarkers: [],
    commandState: { revision: 1, appliedOperationIds: [] },
    ...overrides,
  });

  // -------------------------------------------------------------------------
  // 1. A 56.58-SECOND VIDEO WITH SPEECH NEAR THE BEGINNING
  // -------------------------------------------------------------------------
  describe("1. 56.58s video with speech near the beginning", () => {
    it("generates caption starting at 1.2s and NEVER scales to 28.29s (00:28-00:29)", () => {
      const duration = 56.58;
      // Speech occurs at 1.2s - 3.5s
      const chunks = [
        makeMockWord("Welcome", 1.2, 1.8),
        makeMockWord("to", 1.85, 2.1),
        makeMockWord("the", 2.15, 2.5),
        makeMockWord("video", 2.55, 3.5),
      ];

      const segments = captionSegmentsFromWords(chunks, duration, { timelineOffset: 0 });
      assert.strictEqual(segments.length, 1);
      assert.strictEqual(segments[0].start, 1.2);
      assert.strictEqual(segments[0].end, 3.5);
      assert.strictEqual(hasExplicitCaptionTiming(segments[0]), true);

      // Verify getCaptionTimeline preserves exact start at 1.2s and does not scale across 56.58s
      const timeline = getCaptionTimeline(segments, duration);
      assert.strictEqual(timeline[0].start, 1.2);
      assert.strictEqual(timeline[0].end, 3.5);
      assert.notStrictEqual(Math.round(timeline[0].start), 28);
      assert.notStrictEqual(Math.round(timeline[0].start), 29);

      // Verify preview playback query at time 0.5s (before speech), 2.0s (speaking), and 28.29s (quiet)
      assert.strictEqual(getSegmentIndexAtTime(segments, 0.5, duration), -1);
      assert.strictEqual(getSegmentIndexAtTime(segments, 2.0, duration), 0);
      assert.strictEqual(getSegmentIndexAtTime(segments, 28.29, duration), -1);
    });
  });

  // -------------------------------------------------------------------------
  // 2. SPEECH NEAR THE MIDDLE AND END
  // -------------------------------------------------------------------------
  describe("2. Speech near the middle and end of 56.58s video", () => {
    it("keeps distinct, non-overlapping intervals for middle and end dialogue", () => {
      const duration = 56.58;
      const chunks = [
        makeMockWord("Middle", 25.0, 26.0),
        makeMockWord("section", 26.1, 28.0),
        makeMockWord("Ending", 50.0, 52.0),
        makeMockWord("outro", 52.2, 54.5),
      ];

      const segments = captionSegmentsFromWords(chunks, duration, { timelineOffset: 0 });
      assert.strictEqual(segments.length, 2);
      assert.strictEqual(segments[0].start, 25.0);
      assert.strictEqual(segments[0].end, 28.0);
      assert.strictEqual(segments[1].start, 50.0);
      assert.strictEqual(segments[1].end, 54.5);

      const timeline = getCaptionTimeline(segments, duration);
      assert.strictEqual(timeline[0].start, 25.0);
      assert.strictEqual(timeline[0].end, 28.0);
      assert.strictEqual(timeline[1].start, 50.0);
      assert.strictEqual(timeline[1].end, 54.5);

      // Preview queries
      assert.strictEqual(getSegmentIndexAtTime(segments, 10.0, duration), -1);
      assert.strictEqual(getSegmentIndexAtTime(segments, 26.5, duration), 0);
      assert.strictEqual(getSegmentIndexAtTime(segments, 35.0, duration), -1);
      assert.strictEqual(getSegmentIndexAtTime(segments, 52.5, duration), 1);
      assert.strictEqual(getSegmentIndexAtTime(segments, 56.0, duration), -1);
    });
  });

  // -------------------------------------------------------------------------
  // 3. LEADING SILENCE
  // -------------------------------------------------------------------------
  describe("3. Leading silence preservation", () => {
    it("preserves leading silence of 6.5s and does not clamp speech start to 0", () => {
      const duration = 56.58;
      // 0 to 6.5s is complete silence
      const chunks = [
        makeMockWord("Speech", 6.5, 7.5),
        makeMockWord("begins", 7.6, 8.8),
      ];

      const segments = captionSegmentsFromWords(chunks, duration, { timelineOffset: 0 });
      assert.strictEqual(segments[0].start, 6.5);
      assert.strictEqual(segments[0].end, 8.8);

      const timeline = getCaptionTimeline(segments, duration);
      assert.strictEqual(timeline[0].start, 6.5);
      assert.strictEqual(timeline[0].end, 8.8);

      // During leading silence (0.0 to 6.49s), no caption should be active
      for (const t of [0, 1.0, 3.0, 5.0, 6.4]) {
        assert.strictEqual(getSegmentIndexAtTime(segments, t, duration), -1);
      }
      assert.strictEqual(getSegmentIndexAtTime(segments, 6.5, duration), 0);
      assert.strictEqual(getSegmentIndexAtTime(segments, 8.0, duration), 0);
    });
  });

  // -------------------------------------------------------------------------
  // 4. SOURCE CLIP STARTING LATER IN THE TIMELINE
  // -------------------------------------------------------------------------
  describe("4. Source clip starting later in the timeline", () => {
    it("correctly offsets captions for a clip starting at 15.0s on the timeline", () => {
      const timelineStart = 15.0;
      const clipDuration = 20.0;
      // Speech occurs at 2.0s into the clip
      const chunks = [
        makeMockWord("Second", 2.0, 2.8),
        makeMockWord("clip", 2.9, 4.0),
      ];

      const segments = captionSegmentsFromWords(chunks, clipDuration, {
        timelineOffset: timelineStart,
      });

      assert.strictEqual(segments[0].start, 17.0); // 15.0 + 2.0
      assert.strictEqual(segments[0].end, 19.0);   // 15.0 + 4.0
      assert.strictEqual(segments[0].words[0].start, 17.0);
      assert.strictEqual(segments[0].words[0].end, 17.8);
    });
  });

  // -------------------------------------------------------------------------
  // 5. AI ASSISTANT CAPTION GENERATION AND PLAN APPLICATION
  // -------------------------------------------------------------------------
  describe("5. AI Assistant caption generation and plan application", () => {
    it("updates snapshot with generated ASR captions and preserves timing through multi-action plan", () => {
      const project = createBaseProject();
      assert.strictEqual(project.captionSegments.length, 2);
      // Untimed default script segments
      assert.strictEqual(hasExplicitCaptionTiming(project.captionSegments[0]), false);

      // ASR generates timed captions for the speech near beginning
      const asrCaptions = [
        {
          id: "cap-asr-1",
          text: "Welcome to this tutorial",
          start: 1.2,
          end: 3.5,
          words: [
            { text: "Welcome", start: 1.2, end: 1.8 },
            { text: "to", start: 1.85, end: 2.1 },
            { text: "this", start: 2.15, end: 2.5 },
            { text: "tutorial", start: 2.55, end: 3.5 },
          ],
        },
      ];

      // Simulate AiAssistantPanel workflow:
      // When tool.generate_captions finishes, snapshot.captionSegments is populated with generatedCaptions
      const snapshot = structuredClone(project);
      snapshot.captionSegments = asrCaptions;
      snapshot.captionsEnabled = true;
      snapshot.script = asrCaptions.map((c) => c.text).join("\n");

      // Follow-up timeline action: e.g. caption.set_position bottom
      const commandPlan = {
        schemaVersion: 1,
        baseRevision: 1,
        operations: [
          {
            id: "op-1",
            type: "caption.set_position",
            scope: "default",
            placement: { x: 50, y: 78 },
          },
        ],
      };

      const result = applyCommandPlan(snapshot, commandPlan);
      assert.strictEqual(result.ok, true);

      // Verify that the resulting project has the ASR captions with EXACT timestamps
      const appliedCaptions = result.project.captionSegments;
      assert.strictEqual(appliedCaptions.length, 1);
      assert.strictEqual(appliedCaptions[0].text, "Welcome to this tutorial");
      assert.strictEqual(appliedCaptions[0].start, 1.2);
      assert.strictEqual(appliedCaptions[0].end, 3.5);
      assert.strictEqual(appliedCaptions[0].words.length, 4);
      assert.strictEqual(appliedCaptions[0].words[0].start, 1.2);

      // Verify preview timeline calculates exact 1.2s start, NOT 28.29s
      const timeline = getCaptionTimeline(appliedCaptions, project.duration);
      assert.strictEqual(timeline[0].start, 1.2);
      assert.strictEqual(timeline[0].end, 3.5);
    });

    it("clears untimed default placeholder script when caption.add adds first real timed caption", () => {
      const project = createBaseProject();
      const commandPlan = {
        schemaVersion: 1,
        baseRevision: 1,
        operations: [
          {
            id: "op-add-1",
            type: "caption.add",
            clipId: "new-cap-1",
            start: 1.5,
            end: 4.0,
            text: "Hello world",
          },
        ],
      };

      const result = applyCommandPlan(project, commandPlan);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.project.captionSegments.length, 1);
      assert.strictEqual(result.project.captionSegments[0].id, "new-cap-1");
      assert.strictEqual(result.project.captionSegments[0].start, 1.5);
      assert.strictEqual(result.project.captionSegments[0].end, 4.0);
    });
  });

  // -------------------------------------------------------------------------
  // 6. SMART PIPELINE CAPTION GENERATION AND APPLICATION
  // -------------------------------------------------------------------------
  describe("6. Smart Pipeline caption generation and review application", () => {
    it("creates clip-local captions and maps them accurately to timeline on apply", () => {
      const clip = {
        id: "video-1",
        duration: 56.58,
        sourceStart: 0,
        playbackRate: 1,
      };

      const rawChunks = [
        makeMockWord("Smart ", 1.2, 1.8),
        makeMockWord("pipeline ", 1.9, 2.7),
        makeMockWord("speech", 2.8, 3.5),
      ];

      const rawSegments = [
        {
          id: "seg-1",
          text: "Smart pipeline speech",
          start: 1.2,
          end: 3.5,
          words: [
            { text: "Smart", start: 1.2, end: 1.8 },
            { text: "pipeline", start: 1.9, end: 2.7 },
            { text: "speech", start: 2.8, end: 3.5 },
          ],
        },
      ];

      const plan = createSmartPipelinePlan({
        clip,
        probabilities: new Float32Array(100),
        transcriptResult: {
          segments: rawSegments,
          rawChunks,
          duration: 56.58,
        },
        settings: { generateCaptions: true },
      });

      assert.strictEqual(plan.captionSegments.length, 1);
      assert.strictEqual(plan.captionSegments[0].start, 1.2);
      assert.strictEqual(plan.captionSegments[0].end, 3.5);
      assert.strictEqual(plan.rawChunks.length, 3);
      assert.strictEqual(plan.rawChunks[0].timestamp[0], 1.2);

      // Verify that regroupReviewSegments using plan.rawChunks works cleanly
      const regrouped = regroupReviewSegments(plan.rawChunks, clip.duration, {
        grouping: "words",
      });
      assert.strictEqual(regrouped.length, 3);
      assert.strictEqual(regrouped[0].start, 1.2);

      // Build and apply review to timeline
      const snapshot = createBaseProject({
        visualSegments: [
          {
            id: "video-1",
            type: "video",
            duration: 56.58,
            sourceStart: 0,
            start: 0,
          },
        ],
        captionSegments: [],
      });
      const runtime = {
        visualSegments: snapshot.visualSegments,
      };

      const review = buildSmartPipelineReview({
        snapshot,
        runtime,
        clipId: "video-1",
        approvedCuts: [],
        approvedCaptions: plan.captionSegments,
        includeCaptions: true,
        includeCuts: false,
      });

      assert.strictEqual(review.project.captionSegments.length, 1);
      assert.strictEqual(review.project.captionSegments[0].start, 1.2);
      assert.strictEqual(review.project.captionSegments[0].end, 3.5);
    });

    it("preserves existing captions from other clips when applying to a multi-clip timeline", () => {
      const clip0Captions = [
        { id: "cap-c0", start: 2.0, end: 4.0, text: "Clip 0 intro" },
      ];
      const snapshot = createBaseProject({
        duration: 40.0,
        visualSegments: [
          { id: "c0", type: "video", duration: 20.0, sourceStart: 0, start: 0 },
          { id: "c1", type: "video", duration: 20.0, sourceStart: 0, start: 20.0 },
        ],
        captionSegments: clip0Captions,
      });
      const runtime = { visualSegments: snapshot.visualSegments };

      const c1ApprovedCaptions = [
        { id: "cap-c1", start: 3.0, end: 6.0, text: "Clip 1 speech" },
      ];

      const review = buildSmartPipelineReview({
        snapshot,
        runtime,
        clipId: "c1",
        approvedCuts: [],
        approvedCaptions: c1ApprovedCaptions,
        includeCaptions: true,
        includeCuts: false,
      });

      // Clip 0 captions (2.0 - 4.0s) MUST be preserved!
      // Clip 1 captions must start at 20.0 + 3.0 = 23.0s!
      assert.strictEqual(review.project.captionSegments.length, 2);
      assert.strictEqual(review.project.captionSegments[0].text, "Clip 0 intro");
      assert.strictEqual(review.project.captionSegments[0].start, 2.0);
      assert.strictEqual(review.project.captionSegments[1].text, "Clip 1 speech");
      assert.strictEqual(review.project.captionSegments[1].start, 23.0);
      assert.strictEqual(review.project.captionSegments[1].end, 26.0);
    });
  });

  // -------------------------------------------------------------------------
  // 7. NORMAL AUTO CAPTIONS RESOLUTION
  // -------------------------------------------------------------------------
  describe("7. Normal Auto Captions source resolution", () => {
    it("resolves target video clip properly and is not hijacked by sourceAudioBlob", async () => {
      const mockVideoBlob = captionMediaFixture();
      const mockSourceAudioBlob = captionMediaFixture();

      const d = {
        visualSegments: [
          {
            id: "vid-target",
            type: "video",
            start: 10.0,
            sourceStart: 4.5,
            duration: 15.0,
            hasAudio: true,
            isMuted: false,
            volume: 1,
            blob: mockVideoBlob,
          },
        ],
        audioSegments: [],
        sourceAudioBlob: mockSourceAudioBlob,
        sourceAudioStart: 28.29, // Project audio start previously set to 28.29s
      };

      const resolved = await resolveCaptionSourceMedia(d);
      assert.ok(resolved);
      // Must resolve the VIDEO candidate, NOT sourceAudioBlob!
      assert.strictEqual(resolved.blob, mockVideoBlob);
      assert.strictEqual(resolved.start, 10.0);
      assert.strictEqual(resolved.sourceStart, 4.5);
      assert.strictEqual(resolved.duration, 15.0);
    });
  });

  // -------------------------------------------------------------------------
  // 8. PREVIEW AND TIMELINE TIMESTAMP CONSISTENCY
  // -------------------------------------------------------------------------
  describe("8. Preview/timeline timestamp consistency", () => {
    it("produces identical timestamps across getCaptionTimeline, getSegmentIndexAtTime, and serializeSrt", () => {
      const duration = 56.58;
      const captions = [
        { id: "c1", start: 1.2, end: 3.5, text: "Early dialogue" },
        { id: "c2", start: 25.0, end: 28.0, text: "Middle dialogue" },
        { id: "c3", start: 50.0, end: 54.0, text: "Closing dialogue" },
      ];

      const timeline = getCaptionTimeline(captions, duration);
      assert.strictEqual(timeline[0].start, 1.2);
      assert.strictEqual(timeline[0].end, 3.5);
      assert.strictEqual(timeline[1].start, 25.0);
      assert.strictEqual(timeline[1].end, 28.0);
      assert.strictEqual(timeline[2].start, 50.0);
      assert.strictEqual(timeline[2].end, 54.0);

      // Verify getSegmentIndexAtTime consistency
      assert.strictEqual(getSegmentIndexAtTime(captions, 0.0, duration), -1);
      assert.strictEqual(getSegmentIndexAtTime(captions, 2.0, duration), 0);
      assert.strictEqual(getSegmentIndexAtTime(captions, 15.0, duration), -1);
      assert.strictEqual(getSegmentIndexAtTime(captions, 26.0, duration), 1);
      assert.strictEqual(getSegmentIndexAtTime(captions, 40.0, duration), -1);
      assert.strictEqual(getSegmentIndexAtTime(captions, 51.0, duration), 2);
      assert.strictEqual(getSegmentIndexAtTime(captions, 55.0, duration), -1);

      // Verify SRT serialization
      const srt = serializeSrt(captions, duration);
      assert.ok(srt.includes("00:00:01,200 --> 00:00:03,500\r\nEarly dialogue"));
      assert.ok(srt.includes("00:00:25,000 --> 00:00:28,000\r\nMiddle dialogue"));
      assert.ok(srt.includes("00:00:50,000 --> 00:00:54,000\r\nClosing dialogue"));
      // Must NOT contain 00:00:28 for Early dialogue!
      assert.strictEqual(srt.includes("00:00:28,290 -->"), false);
    });
  });

  // -------------------------------------------------------------------------
  // 9. REPRODUCTION FIX: ASR DTW BOUNDARY WARPING & BACKWARD CHUNK DRIFT
  // -------------------------------------------------------------------------
  describe("9. ASR DTW Boundary Warping and Backward Chunk Drift Sanitization", () => {
    it("corrects early captions warped to 28.9s back to 0.0s and preserves middle (20s) and late (54s) speech", () => {
      const duration = 56.58;
      // Exact sequence observed from Whisper ONNX DTW on 56.58s video:
      // Chunk 1 tokens (0s-1s speech with 19s trailing silence) warped by DTW to 28.9s-29.44s
      // Chunk 2 tokens beginning at 20.0s
      // Chunk 3 tokens ending at 56.0s
      const rawChunks = [
        makeMockWord(" Say", 28.9, 28.9),
        makeMockWord(" that", 28.9, 29.4),
        makeMockWord(" again,", 29.4, 29.4),
        makeMockWord(" Jay.", 29.4, 29.44),
        makeMockWord(" people's", 20.0, 20.38),
        makeMockWord(" problems", 20.38, 20.86),
        makeMockWord(" to", 20.86, 21.6),
        makeMockWord(" become", 21.6, 21.92),
        makeMockWord(" better.", 21.92, 22.36),
        makeMockWord(" focus", 54.0, 54.5),
        makeMockWord(" on.", 54.5, 55.7),
      ];

      const segments = captionSegmentsFromWords(rawChunks, duration, { timelineOffset: 0 });

      // 1. Early caption: MUST start at 0.0s (not 28.9s!)
      assert.strictEqual(segments[0].start, 0.0);
      assert.strictEqual(segments[0].text, "Say that again,");
      assert.strictEqual(segments[1].text, "Jay.");
      assert.strictEqual(segments[1].end, 0.7);

      // 2. Middle caption: MUST start at 20.0s (not clamped forward to 29.44s!)
      assert.strictEqual(segments[2].start, 20.0);
      assert.ok(segments[2].text.includes("people's"));

      // 3. Late caption: MUST align with 54.0s - 55.7s
      const last = segments.at(-1);
      assert.strictEqual(last.start, 54.0);
      assert.strictEqual(last.end, 55.7);

      // 4. Timeline consistency: getCaptionTimeline must keep exact early, middle, late timings
      const timeline = getCaptionTimeline(segments, duration);
      assert.strictEqual(timeline[0].start, 0.0);
      assert.strictEqual(timeline[2].start, 20.0);
      assert.strictEqual(timeline.at(-1).start, 54.0);

      // 5. Querying time 0.2s must hit early caption; time 10s (music/silence) must hit -1; time 20.5s hits middle
      assert.strictEqual(getSegmentIndexAtTime(segments, 0.2, duration), 0);
      assert.strictEqual(getSegmentIndexAtTime(segments, 10.0, duration), -1);
      assert.strictEqual(getSegmentIndexAtTime(segments, 20.5, duration), 2);
      assert.strictEqual(getSegmentIndexAtTime(segments, 54.2, duration), segments.length - 1);
    });

    it("correctly clears placeholder captions and commits sanitized segments to canonical project state", () => {
      const duration = 56.58;
      const project = createBaseProject();
      assert.strictEqual(project.captionSegments.length, 2); // Default placeholders

      const rawChunks = [
        makeMockWord(" Say", 28.9, 28.9),
        makeMockWord(" that", 28.9, 29.4),
        makeMockWord(" again,", 29.4, 29.4),
        makeMockWord(" Jay.", 29.4, 29.44),
        makeMockWord(" people's", 20.0, 20.38),
        makeMockWord(" problems", 20.38, 20.86),
      ];

      const segments = captionSegmentsFromWords(rawChunks, duration, { timelineOffset: 0 });

      // Apply via project command engine as done by Assistant / Auto Captions
      const plan = {
        schemaVersion: 1,
        baseRevision: 1,
        operations: segments.map((seg, idx) => ({
          id: `op-add-${idx}`,
          type: "caption.add",
          clipId: seg.id,
          start: seg.start,
          end: seg.end,
          text: seg.text,
          words: seg.words,
        })),
      };

      const result = applyCommandPlan(project, plan);
      assert.strictEqual(result.ok, true);
      const updated = result.project;

      // Default placeholders must be gone
      assert.strictEqual(
        updated.captionSegments.some((s) => s.id === "default-1" || s.id === "default-2"),
        false
      );

      // First caption segment must start at 0.0s
      assert.strictEqual(updated.captionSegments[0].start, 0.0);
      assert.strictEqual(updated.captionSegments[0].text, "Say that again,");

      // Middle segment must start at 20.0s
      const middle = updated.captionSegments.find((s) => s.text.includes("people's"));
      assert.ok(middle);
      assert.strictEqual(middle.start, 20.0);
    });

    it("correctly offsets sanitized captions for a clip whose timeline start differs from source start", () => {
      const duration = 56.58;
      // Clip starts at timeline position 12.0s
      const timelineOffset = 12.0;
      const rawChunks = [
        makeMockWord(" Say", 28.9, 28.9),
        makeMockWord(" that", 28.9, 29.4),
        makeMockWord(" again,", 29.4, 29.4),
        makeMockWord(" Jay.", 29.4, 29.44),
        makeMockWord(" people's", 20.0, 20.38),
      ];

      const segments = captionSegmentsFromWords(rawChunks, duration, { timelineOffset });

      // Early caption should be offset by timelineOffset (12.0 + 0.0 = 12.0s)
      assert.strictEqual(segments[0].start, 12.0);
      assert.strictEqual(segments[0].end, 12.5);

      // Middle caption should be offset by timelineOffset (12.0 + 20.0 = 32.0s)
      assert.strictEqual(segments[2].start, 32.0);
    });

    it("ensures timeline initial zoom settles to fit the full probed video duration rather than placeholder duration", () => {
      // 1. When a video is imported, it temporarily starts with a 4-second placeholder while preparing
      const placeholderDuration = 4.0;
      const placeholderZoom = getTimelineInitialContentZoom(placeholderDuration);
      const placeholderVisibleDuration = getTimelineVisibleDuration(placeholderZoom);
      // Placeholder zoom shows only 5 seconds of the timeline
      assert.ok(placeholderVisibleDuration <= 5.1, "Placeholder zoom must be clamped to ~5s visible");

      // 2. Probed video metadata resolves the real 56.58-second video duration
      const realProbedDuration = 56.58;
      const settledZoom = getTimelineInitialContentZoom(realProbedDuration);
      const settledVisibleDuration = getTimelineVisibleDuration(settledZoom);

      // Settled zoom must comfortably encompass the entire 56.58s duration so all captions (up to 55.74s) are visible
      assert.ok(
        settledVisibleDuration >= realProbedDuration,
        `Settled visible duration (${settledVisibleDuration}s) must fit the entire video (${realProbedDuration}s)`
      );

      // Verify track width percentage at settled zoom is 100% (fits within standard viewport without overflow)
      const trackWidthPercent = getTimelineTrackWidthPercent(realProbedDuration, settledZoom);
      assert.strictEqual(Math.round(trackWidthPercent), 100);
    });

    it("preserves continuous speech throughout the video without dropping dialogue or creating artificial gaps", () => {
      const duration = 56.58;
      // Realistic ASR tokens spanning the entire 56.58s video (including the previously omitted 1s-20s section)
      const fullVideoWords = [
        makeMockWord(" Say", 0.0, 0.4),
        makeMockWord(" that", 0.4, 0.54),
        makeMockWord(" again,", 0.54, 0.76),
        makeMockWord(" Jay.", 0.8, 1.0),
        // Previously dropped dialogue between 1s and 20s:
        makeMockWord(" Weak", 2.18, 2.68),
        makeMockWord(" people", 2.68, 3.0),
        makeMockWord(" notice", 3.0, 3.88),
        makeMockWord(" other", 3.88, 4.42),
        makeMockWord(" people's", 4.42, 4.86),
        makeMockWord(" mistakes", 4.86, 5.3),
        makeMockWord(" and", 5.3, 6.26),
        makeMockWord(" laugh.", 6.26, 6.64),
        makeMockWord(" Strong", 7.4, 7.98),
        makeMockWord(" people", 7.98, 8.42),
        makeMockWord(" notice", 8.42, 9.16),
        makeMockWord(" other", 9.16, 9.5),
        makeMockWord(" people's", 9.5, 9.94),
        makeMockWord(" mistakes", 9.94, 10.38),
        makeMockWord(" and", 10.38, 11.32),
        makeMockWord(" learn.", 11.32, 11.64),
        makeMockWord(" Weak", 12.78, 13.44),
        makeMockWord(" people", 13.44, 13.74),
        makeMockWord(" talk", 13.74, 14.88),
        makeMockWord(" about", 14.88, 15.14),
        makeMockWord(" other", 15.14, 15.36),
        makeMockWord(" people's", 15.36, 15.7),
        makeMockWord(" problems", 15.7, 16.12),
        makeMockWord(" to", 16.12, 17.12),
        makeMockWord(" feel", 17.12, 17.34),
        makeMockWord(" better.", 17.34, 17.72),
        makeMockWord(" Strong", 18.34, 18.88),
        makeMockWord(" people", 18.88, 19.26),
        makeMockWord(" talk", 19.26, 19.6),
        makeMockWord(" about", 19.6, 19.82),
        makeMockWord(" other", 19.82, 20.04),
        makeMockWord(" people's", 20.04, 20.38),
        makeMockWord(" problems", 20.38, 20.84),
        makeMockWord(" to", 20.84, 21.6),
        makeMockWord(" become", 21.6, 21.92),
        makeMockWord(" better.", 21.92, 22.36),
        // Middle dialogue (23s - 45s):
        makeMockWord(" Weak", 23.36, 23.8),
        makeMockWord(" people", 23.8, 24.12),
        makeMockWord(" gossip", 24.12, 24.8),
        makeMockWord(" about", 24.8, 25.12),
        makeMockWord(" others", 25.12, 25.6),
        makeMockWord(" to", 25.6, 26.54),
        makeMockWord(" build", 26.54, 26.78),
        makeMockWord(" fake", 26.78, 27.06),
        makeMockWord(" connections.", 27.06, 27.7),
        makeMockWord(" Strong", 28.36, 28.88),
        makeMockWord(" people", 28.88, 29.56),
        makeMockWord(" express", 29.56, 31.0),
        makeMockWord(" vulnerability", 31.0, 31.58),
        makeMockWord(" to", 31.58, 32.2),
        makeMockWord(" build", 32.2, 32.8),
        makeMockWord(" real", 32.8, 33.1),
        makeMockWord(" ones.", 33.1, 33.36),
        makeMockWord(" And", 34.26, 34.5),
        makeMockWord(" this", 34.5, 34.7),
        makeMockWord(" one's", 34.7, 34.82),
        makeMockWord(" the", 34.82, 35.0),
        makeMockWord(" kicker", 35.0, 35.2),
        makeMockWord(" that", 35.2, 35.3),
        makeMockWord(" you", 35.3, 35.4),
        makeMockWord(" were", 35.4, 35.44),
        makeMockWord(" just", 35.44, 35.7),
        makeMockWord(" talking", 35.7, 36.0),
        makeMockWord(" about.", 36.0, 36.2),
        makeMockWord(" Weak", 36.82, 37.5),
        makeMockWord(" people", 37.5, 38.0),
        makeMockWord(" envy", 38.0, 38.5),
        makeMockWord(" people", 38.5, 39.18),
        makeMockWord(" ahead", 39.18, 39.5),
        makeMockWord(" of", 39.5, 39.7),
        makeMockWord(" them.", 39.7, 39.9),
        makeMockWord(" Strong", 40.32, 41.0),
        makeMockWord(" people", 41.0, 41.5),
        makeMockWord(" study", 41.5, 42.0),
        makeMockWord(" people", 42.0, 42.78),
        makeMockWord(" ahead", 42.78, 43.1),
        makeMockWord(" of", 43.1, 43.3),
        makeMockWord(" them.", 43.3, 43.46),
        makeMockWord(" And", 44.24, 44.5),
        makeMockWord(" the", 44.5, 44.7),
        makeMockWord(" interesting", 44.7, 45.0),
        makeMockWord(" thing", 45.0, 45.2),
        makeMockWord(" is,", 45.2, 45.64),
        makeMockWord(" both", 46.22, 46.5),
        makeMockWord(" people", 46.5, 47.0),
        makeMockWord(" are", 47.0, 47.2),
        makeMockWord(" looking", 47.2, 47.54),
        makeMockWord(" at", 47.54, 47.8),
        makeMockWord(" the", 47.8, 48.0),
        makeMockWord(" same", 48.0, 48.2),
        makeMockWord(" thing.", 48.2, 48.46),
        makeMockWord(" But", 49.04, 49.3),
        makeMockWord(" they're", 49.3, 49.6),
        makeMockWord(" seeing", 49.6, 50.0),
        makeMockWord(" different", 50.0, 50.2),
        makeMockWord(" things.", 50.2, 50.48),
        // Ending dialogue (51s - 56s):
        makeMockWord(" Because", 51.12, 51.5),
        makeMockWord(" no", 51.5, 51.8),
        makeMockWord(" one", 51.8, 52.0),
        makeMockWord(" is", 52.0, 52.32),
        makeMockWord(" a", 52.32, 52.5),
        makeMockWord(" weak", 52.5, 52.8),
        makeMockWord(" or", 52.8, 53.0),
        makeMockWord(" strong", 53.0, 53.2),
        makeMockWord(" person.", 53.2, 53.7),
        makeMockWord(" It's", 54.18, 54.4),
        makeMockWord(" just", 54.4, 54.7),
        makeMockWord(" what", 54.7, 54.9),
        makeMockWord(" you", 54.9, 55.12),
        makeMockWord(" focus", 55.12, 55.4),
        makeMockWord(" on.", 55.4, 55.72),
      ];

      const segments = captionSegmentsFromWords(fullVideoWords, duration);

      // Verify opening caption covers the start
      assert.strictEqual(segments[0].start, 0.0);
      assert.ok(segments[0].text.includes("Say that again"));

      // Verify the previously missing 1s - 20s interval is present and properly sequenced
      const earlySpeechSeg = segments.find((s) => s.text.includes("Weak people notice"));
      assert.ok(earlySpeechSeg, "Early speech segment must be present");
      assert.ok(earlySpeechSeg.start >= 2.0 && earlySpeechSeg.start <= 2.5);

      const learnSeg = segments.find((s) => s.text.includes("mistakes and learn"));
      assert.ok(learnSeg, "Segment around 11s must be present");
      assert.ok(learnSeg.start >= 9.0 && learnSeg.start <= 12.0);

      const feelBetterSeg = segments.find((s) => s.text.includes("feel better"));
      assert.ok(feelBetterSeg, "Segment around 17s must be present");
      assert.ok(feelBetterSeg.start >= 15.0 && feelBetterSeg.start <= 18.0);

      // Verify end caption reaches the end of the spoken audio
      const lastSeg = segments[segments.length - 1];
      assert.ok(lastSeg.text.includes("focus on"));
      assert.ok(lastSeg.end >= 55.0 && lastSeg.end <= 56.58);

      // Verify no artificial gaps > 3.0s in this dialogue
      for (let i = 1; i < segments.length; i++) {
        const gap = segments[i].start - segments[i - 1].end;
        assert.ok(
          gap <= 3.0,
          `Unexpected large gap of ${gap.toFixed(2)}s between "${segments[i - 1].text}" and "${segments[i].text}"`
        );
      }
    });
  });
});


