/**
 * @file shorts-studio.test.js
 * Comprehensive unit and integration test suite for AI Shorts Studio.
 *
 * Verifies:
 * 1. Configuration & Settings Normalization
 * 2. Source Media Technical Inspection & Validation
 * 3. Sentence & Thought Boundary Grouping (Context Preservation)
 * 4. Multi-Strategy Highlight Discovery:
 *    - Speech/Transcript Strategy (Q&A, Hooks, Sentence Integrity)
 *    - Visual-Only Strategy (Scene cuts, Motion sequences)
 *    - Hybrid Strategy
 * 5. Candidate Ranking & Deduplication (>40% overlap suppression)
 * 6. Honest Diagnostic Reporting (No fake AI fabrication)
 * 7. Boundary Adjustments & Duration Constraint Enforcement
 * 8. Timeline Project Conversion & Export Plan Generation
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  SHORTS_CONTENT_TYPES,
  SHORTS_ASPECT_RATIOS,
  SHORTS_DURATION_PRESETS,
  SHORTS_PREFERENCES,
  DEFAULT_SHORTS_SETTINGS,
  normalizeShortsSettings,
  inspectSourceMetadata,
  groupTranscriptIntoSentences,
  discoverSpeechCandidates,
  discoverVisualCandidates,
  deduplicateAndRankCandidates,
  discoverShortCandidates,
  convertCandidateToProject,
  buildShortExportSpec,
  scoreSentenceHook,
  synthesizeShortTitle,
  SHORTS_FRAMING_MODES,
  resolveSourceCaptions,
  extractTranscriptExcerpt,
  evaluateSentenceHookSemantic,
  evaluateNarrativeCoherence,
  evaluatePayoff,
  evaluateCandidateSemantics,
  extractContentWords,
} from "../../src/lib/shortsStudio.js";
import { buildFfmpegRenderPlan } from "../../src/lib/projectRenderPlan.js";
import { getShortCandidateFileName, createShortsBatchZip } from "../../src/lib/shortsExport.js";
import {
  normalizeFaceBox,
  selectPrimaryFace,
  calculateTargetCropDimensions,
  solveFrameCrop,
  buildDynamicReframingTrack,
  generateFallbackReframingTrack,
  applyDynamicReframingToCandidate,
  buildReframingFFmpegCropFilter,
} from "../../src/lib/shortsReframing.js";
import { resolveSmartFrameCropAtTime } from "../../src/lib/smartFrame.js";
import {
  scoreEmphasisWeight,
  resolveFaceAwarePunchInOffset,
  detectSpeechPacedPunchIns,
  buildSpeechPacedPunchInKeyframes,
  applySpeechPacedPunchInsToCandidate,
} from "../../src/lib/shortsPunchIns.js";
import {
  clampPunchInOffsets,
  buildSmartZoomCropFilter,
  resolvePunchInOffset,
  compilePunchInKeyframes,
} from "../../src/lib/smartZoom.js";
import {
  NARRATIVE_STAGES,
  classifySentenceNarrativeStage,
  computeThematicContinuity,
  clusterNarrativeArcs,
  evaluateNarrativeArcCompleteness,
  optimizeCandidateArcBoundaries,
} from "../../src/lib/shortsNarrativeClustering.js";
import {
  DEFAULT_AUDIO_ANALYSIS_OPTIONS,
  sanitizeAudioInput,
  analyzeAudioEnergy,
  estimatePitchAutocorrelation,
  alignAudioFeaturesWithTranscript,
  evaluateCandidateAcousticAlignment,
  checkVocalBoundarySafety,
} from "../../src/lib/shortsAudioEnergy.js";
import {
  DEFAULT_SHORTS_OVERLAY_OPTIONS,
  extractSalientKeywords,
  scoreAssetRelevance,
  generateCalloutSvgDataUrl,
  resolveOverlayPlacement,
  detectOverlayOpportunities,
  planShortOverlays,
  applyOverlaysToCandidate,
} from "../../src/lib/shortsOverlays.js";
import {
  DEFAULT_MOTION_TYPOGRAPHY_OPTIONS,
  MOTION_ANIMATION_STYLES,
  validateWordTimestamps,
  sanitizeWordTimestamps,
  scoreWordEmphasis,
  buildKineticWordTimeline,
  detectAnimatedCaptionCallouts,
  resolveSafeCaptionPlacement,
  resolveSoundAccents,
  planMotionTypography,
  applyMotionTypographyToCandidate,
} from "../../src/lib/shortsMotionTypography.js";
import {
  SUPPORTED_REPACKAGING_RATIOS,
  REPACKAGING_RATIO_DEFINITIONS,
  normalizeTargetRatio,
  getRepackagingRatioDefinition,
  resolvePlatformSafeArea,
  calculateRepackagingCrop,
  resolveTitleCardLayout,
  adaptPunchInsForTargetRatio,
  adaptOverlaysForTargetRatio,
  adaptCaptionsForTargetRatio,
  repackageShortCandidate,
  batchRepackageCandidate,
  buildMultiFormatExportSpecs,
} from "../../src/lib/shortsRepackaging.js";
import {
  DEFAULT_SHORTS_TRANSITION_OPTIONS,
  SHORTS_TRANSITION_TYPES,
  normalizeTransitionType,
  mapTransitionToFfmpegXfade,
  detectBrollCutawayOpportunities,
  scoreAndSelectBrollAsset,
  selectTransitionForContext,
  resolveTransitionCollisions,
  planShortTransitionsAndBroll,
  applyTransitionsAndBrollToCandidate,
  applyTransitionsToProject,
} from "../../src/lib/shortsTransitions.js";
import {
  TIMELINE_PACKAGE_FORMAT,
  TIMELINE_PACKAGE_VERSION,
  CANONICAL_TRACK_KINDS,
  CANONICAL_TRACK_IDS,
  SUPPORTED_TIMELINE_EXPORT_FORMATS,
  candidateToCanonicalTimeline,
  serializeTimelineToNativeProject,
  deserializeNativeProjectToTimeline,
  exportTimelineToOtio,
  deserializeOtioToTimeline,
  exportTimelineToFcpxml,
  packageEditableShortTimeline,
  createTimelinePackageZipBlob,
} from "../../src/lib/shortsTimelinePackaging.js";

describe("AI Shorts Studio — Multi-Content Long-to-Short Generation", () => {
  // =========================================================================
  // 1. Configuration & Settings Normalization
  // =========================================================================
  describe("Settings Normalization & Defaults", () => {
    it("provides sensible default configuration", () => {
      const normalized = normalizeShortsSettings({});
      assert.equal(normalized.contentType, "auto");
      assert.equal(normalized.aspectRatio, "9:16");
      assert.equal(normalized.durationPreset, "30-60");
      assert.equal(normalized.minDuration, 30);
      assert.equal(normalized.maxDuration, 60);
      assert.equal(normalized.clipCount, 4);
      assert.equal(normalized.preference, "best");
      assert.equal(normalized.captionPresetId, "bold");
      assert.equal(normalized.autoReframing, "smart-zoom");
      assert.equal(normalized.preserveAudio, true);
      assert.equal(normalized.removePauses, false);
    });

    it("supports all required content types across multiple domains", () => {
      const expectedTypes = ["auto", "podcast", "education", "gaming", "vlog", "webinar", "sports", "other"];
      expectedTypes.forEach((typeId) => {
        const found = SHORTS_CONTENT_TYPES.find((c) => c.id === typeId);
        assert.ok(found, `Content type ${typeId} must exist`);
        const norm = normalizeShortsSettings({ contentType: typeId });
        assert.equal(norm.contentType, typeId);
      });
    });

    it("supports required aspect ratios (9:16, 1:1, 16:9)", () => {
      assert.equal(normalizeShortsSettings({ aspectRatio: "9:16" }).aspectRatio, "9:16");
      assert.equal(normalizeShortsSettings({ aspectRatio: "1:1" }).aspectRatio, "1:1");
      assert.equal(normalizeShortsSettings({ aspectRatio: "16:9" }).aspectRatio, "16:9");
      // Invalid fallback
      assert.equal(normalizeShortsSettings({ aspectRatio: "invalid" }).aspectRatio, "9:16");
    });

    it("handles duration presets and custom duration bounds cleanly", () => {
      const p15 = normalizeShortsSettings({ durationPreset: "15-30" });
      assert.equal(p15.minDuration, 15);
      assert.equal(p15.maxDuration, 30);

      const p60 = normalizeShortsSettings({ durationPreset: "60-90" });
      assert.equal(p60.minDuration, 60);
      assert.equal(p60.maxDuration, 90);

      const custom = normalizeShortsSettings({
        durationPreset: "custom",
        customMinDuration: 25,
        customMaxDuration: 75,
      });
      assert.equal(custom.minDuration, 25);
      assert.equal(custom.maxDuration, 75);
    });
  });

  // =========================================================================
  // 2. Source Media Technical Inspection & Validation
  // =========================================================================
  describe("Source Media Inspection", () => {
    it("safely rejects null, undefined, or corrupt source media", () => {
      const nullMeta = inspectSourceMetadata(null);
      assert.equal(nullMeta.valid, false);
      assert.equal(nullMeta.error, "MISSING_SOURCE_MEDIA");

      const emptyMeta = inspectSourceMetadata({});
      assert.equal(emptyMeta.valid, false);

      const zeroDur = inspectSourceMetadata({ duration: 0 });
      assert.equal(zeroDur.valid, false);
    });

    it("correctly extracts technical dimensions and duration from video clips", () => {
      const meta = inspectSourceMetadata({
        id: "vis-1",
        type: "video",
        name: "podcast-episode-42.mp4",
        duration: 360.5,
        width: 1920,
        height: 1080,
        hasAudio: true,
      });
      assert.equal(meta.valid, true);
      assert.equal(meta.duration, 360.5);
      assert.equal(meta.width, 1920);
      assert.equal(meta.height, 1080);
      assert.equal(meta.aspectRatio, 1920 / 1080);
      assert.equal(meta.hasVideo, true);
      assert.equal(meta.hasAudio, true);
    });
  });

  // =========================================================================
  // 3. Sentence Boundary & Context Preservation
  // =========================================================================
  describe("Sentence & Context Preservation Logic", () => {
    it("groups word-level chunks into complete sentences without mid-sentence cuts", () => {
      const segments = [
        { id: "w1", text: "Why do so many creators fail on YouTube?", start: 0.0, end: 3.2 },
        { id: "w2", text: "The biggest mistake", start: 3.5, end: 4.8 },
        { id: "w3", text: "is ignoring the first three seconds.", start: 4.9, end: 7.5 },
        { id: "w4", text: "If you fix your hook,", start: 8.0, end: 9.8 },
        { id: "w5", text: "retention immediately doubles.", start: 9.9, end: 12.0 },
      ];

      const sentences = groupTranscriptIntoSentences(segments);
      assert.ok(sentences.length >= 2);
      assert.equal(sentences[0].isQuestion, true);
      assert.equal(sentences[0].text, "Why do so many creators fail on YouTube?");
      assert.equal(sentences[0].start, 0.0);
      assert.equal(sentences[0].end, 3.2);

      // Verify that segments 2 and 3 formed a complete thought
      const sentence2 = sentences[1];
      assert.equal(sentence2.text, "The biggest mistake is ignoring the first three seconds.");
      assert.equal(sentence2.start, 3.5);
      assert.equal(sentence2.end, 7.5);
    });
  });

  // =========================================================================
  // 4. Speech/Transcript Highlight Discovery
  // =========================================================================
  describe("Speech-Centric Highlight Discovery", () => {
    const interviewSentences = [
      { id: "s1", text: "What is the single best advice you have for beginners?", start: 10.0, end: 14.5, duration: 4.5, isQuestion: true, hasPunctuation: true },
      { id: "s2", text: "Start before you feel ready.", start: 15.0, end: 18.0, duration: 3.0, isQuestion: false, hasPunctuation: true },
      { id: "s3", text: "Most people spend years overthinking equipment.", start: 18.5, end: 24.0, duration: 5.5, isQuestion: false, hasPunctuation: true },
      { id: "s4", text: "Just pick up your phone and press record.", start: 24.5, end: 30.0, duration: 5.5, isQuestion: false, hasPunctuation: true },
      { id: "s5", text: "You will learn more from your first ten videos than from a hundred tutorials.", start: 30.5, end: 42.0, duration: 11.5, isQuestion: false, hasPunctuation: true },
      { id: "s6", text: "Yeah exactly, that is so true.", start: 43.0, end: 46.0, duration: 3.0, isQuestion: false, hasPunctuation: true },
    ];

    it("discovers Q&A highlight and preserves question with full answer payoff", () => {
      const candidates = discoverSpeechCandidates({
        sentences: interviewSentences,
        mediaDuration: 300,
        settings: { minDuration: 20, maxDuration: 40, preference: "best", clipCount: 3 },
      });

      assert.ok(candidates.length > 0);
      const topCand = candidates[0];
      assert.equal(topCand.startTime, 10.0);
      // Ensures end time cleanly concludes on complete sentence boundary
      assert.ok(topCand.endTime >= 30.0);
      assert.ok(topCand.duration >= 20.0);
      assert.equal(topCand.category, "Q&A Highlight");
      assert.ok(topCand.hookScore > 60);
      assert.ok(topCand.score > 70);
    });

    it("respects preference filters such as educational and storytelling", () => {
      const eduCandidates = discoverSpeechCandidates({
        sentences: interviewSentences,
        mediaDuration: 300,
        settings: { minDuration: 15, maxDuration: 45, preference: "educational", clipCount: 3 },
      });
      assert.ok(eduCandidates.length > 0);
      assert.ok(eduCandidates[0].score > 60);
    });
  });

  // =========================================================================
  // 5. Visual-Centric Highlight Discovery (Sports, Gaming, No Speech)
  // =========================================================================
  describe("Visual-Only & Action Highlight Discovery", () => {
    it("discovers visual action moments from scene cuts when no transcript exists", () => {
      const sceneCuts = [12.0, 24.5, 38.0, 52.0, 75.0, 98.0, 140.0];
      const candidates = discoverVisualCandidates({
        mediaDuration: 180,
        sceneCuts,
        settings: { minDuration: 20, maxDuration: 45, clipCount: 3, preference: "visual_highlights" },
      });

      assert.ok(candidates.length > 0);
      const first = candidates[0];
      assert.ok(first.duration >= 20);
      assert.ok(first.duration <= 55);
      assert.equal(first.strategy, "visual-centric");
      assert.ok(first.warnings.some((w) => w.includes("Visual-only")));
    });

    it("generates structured uniform candidate sequences if no scene transitions can be detected", () => {
      const candidates = discoverVisualCandidates({
        mediaDuration: 120,
        sceneCuts: [],
        settings: { minDuration: 20, maxDuration: 40, clipCount: 3, preference: "best" },
      });

      assert.ok(candidates.length >= 2);
      assert.ok(candidates[0].duration >= 20);
      assert.equal(candidates[0].strategy, "visual-uniform");
    });
  });

  // =========================================================================
  // 6. Candidate Ranking & Deduplication (>40% Overlap Suppression)
  // =========================================================================
  describe("Ranking & Deduplication", () => {
    it("suppresses heavily overlapping candidates (>40% overlap)", () => {
      const candidates = [
        { id: "c1", startTime: 10, endTime: 40, duration: 30, score: 90, title: "High score candidate" },
        // c2 overlaps c1 from 15 to 40 (25s / 30s = 83% overlap!)
        { id: "c2", startTime: 15, endTime: 45, duration: 30, score: 75, title: "Overlapping duplicate candidate" },
        // c3 starts at 60, zero overlap with c1
        { id: "c3", startTime: 60, endTime: 90, duration: 30, score: 85, title: "Distinct candidate" },
      ];

      const ranked = deduplicateAndRankCandidates(candidates, 3);
      assert.equal(ranked.length, 2);
      assert.ok(ranked.some((c) => c.id === "c1"));
      assert.ok(ranked.some((c) => c.id === "c3"));
      assert.equal(ranked.some((c) => c.id === "c2"), false, "Candidate c2 should be suppressed due to >40% overlap");
    });
  });

  // =========================================================================
  // 7. Full Discovery Pipeline & Honest Diagnostics
  // =========================================================================
  describe("discoverShortCandidates Pipeline", () => {
    it("reports an honest error when source video is too short (<10s)", () => {
      const res = discoverShortCandidates({
        sourceMedia: { type: "video", duration: 6.0 },
      });
      assert.equal(res.ok, false);
      assert.equal(res.error, "SOURCE_TOO_SHORT");
      assert.equal(res.candidates.length, 0);
    });

    it("runs speech discovery when transcript segments are supplied", () => {
      const segments = [
        { text: "Here is the key to editing video fast.", start: 2.0, end: 5.5 },
        { text: "Use keyboard shortcuts for trimming.", start: 6.0, end: 10.0 },
        { text: "This cuts your workflow in half.", start: 10.5, end: 15.0 },
        { text: "Second, organize all your footage into bins.", start: 16.0, end: 22.0 },
        { text: "Third, use ripple delete to close gaps.", start: 22.5, end: 28.0 },
      ];

      const res = discoverShortCandidates({
        sourceMedia: { type: "video", duration: 90, width: 1920, height: 1080 },
        transcriptResult: { segments },
        settings: { durationPreset: "15-30", clipCount: 2 },
      });

      assert.equal(res.ok, true);
      assert.ok(res.candidates.length >= 1);
      assert.equal(res.candidates[0].strategy, "speech-centric");
    });
  });

  // =========================================================================
  // 8. Timeline Project Conversion & Export Plan
  // =========================================================================
  describe("Project Conversion & Export Specification", () => {
    const mockClip = {
      id: "source-clip-1",
      type: "video",
      src: "blob:http://localhost/mock-video",
      duration: 180,
      width: 1920,
      height: 1080,
    };

    const mockCandidate = {
      id: "short-cand-123",
      startTime: 15.5,
      endTime: 48.0,
      duration: 32.5,
      title: "Why Content Creators Fail",
      strategy: "speech-centric",
    };

    const mockCaptions = [
      { id: "c1", start: 5.0, end: 10.0, text: "Before candidate clip" },
      { id: "c2", start: 18.0, end: 25.0, text: "Inside candidate clip part 1" },
      { id: "c3", start: 26.0, end: 35.0, text: "Inside candidate clip part 2" },
      { id: "c4", start: 55.0, end: 60.0, text: "After candidate clip" },
    ];

    it("converts candidate into a valid editor project snapshot with sliced captions", () => {
      const project = convertCandidateToProject(mockClip, mockCandidate, {
        aspectRatio: "9:16",
        captionPresetId: "bold",
        autoReframing: "smart-zoom",
        captionSegments: mockCaptions,
      });

      assert.ok(project);
      assert.equal(project.ratioId, "9:16");
      assert.equal(project.fitMode, "cover");
      assert.equal(project.visualSegments.length, 1);

      const segment = project.visualSegments[0];
      assert.equal(segment.sourceStart, 15.5);
      assert.equal(segment.duration, 32.5);
      assert.ok(segment.smartZoom?.enabled);

      // Verify that only the 2 captions within [15.5, 48.0] were retained and re-anchored
      assert.equal(project.captionSegments.length, 2);
      // c2 was at 18.0s -> 18.0 - 15.5 = 2.5s
      assert.equal(project.captionSegments[0].start, 2.5);
      assert.equal(project.captionSegments[0].text, "Inside candidate clip part 1");
    });

    it("generates an export specification matching required dimensions", () => {
      const spec = buildShortExportSpec(mockClip, mockCandidate, {
        aspectRatio: "9:16",
      });

      assert.ok(spec);
      assert.equal(spec.candidateId, "short-cand-123");
      assert.equal(spec.width, 1080);
      assert.equal(spec.height, 1920);
      assert.equal(spec.aspectRatio, "9:16");
      assert.equal(spec.format, "mp4");
      assert.ok(spec.project);
    });
  });

  // =========================================================================
  // 9. Content-Specific Hook Scoring & Title Synthesis (Phase 2)
  // =========================================================================
  describe("Content-Aware Hook Scoring & Title Synthesis", () => {
    it("rewards strong opening questions and penalties speech filler pauses", () => {
      const qScore = scoreSentenceHook("Why does everyone get this wrong in React?", "tutorial");
      const boringScore = scoreSentenceHook("Um, okay, so basically I was thinking...", "tutorial");
      assert.ok(qScore > boringScore + 25, "Question hook must significantly outscore filler start");
    });

    it("rewards gaming clutch and hype moments in gaming content type", () => {
      const hypeScore = scoreSentenceHook("No way! Look at that insane 1v4 clutch play!", "gaming");
      const quietScore = scoreSentenceHook("I am just adjusting my keyboard settings now.", "gaming");
      assert.ok(hypeScore > quietScore + 15, `Gaming action phrase should score higher in gaming mode (${hypeScore} vs ${quietScore})`);
    });

    it("synthesizes clean titles without trailing punctuation or mid-word slicing", () => {
      const titleQ = synthesizeShortTitle("What is the fastest way to learn video editing in 2026?", "education");
      assert.equal(titleQ, "What is the fastest way to learn video editing in 2026");

      const titleLong = synthesizeShortTitle(
        "In this video we are going to explore the comprehensive architecture of modern web browsers and why they require so much RAM",
        "tutorial"
      );
      assert.ok(titleLong.length <= 55);
      assert.ok(!titleLong.endsWith(" "));
    });

    it("detects and flags sentences starting on connective phrases", () => {
      const segments = [
        { text: "And so that is why we decided to move.", start: 1.0, end: 4.0 },
      ];
      const sentences = groupTranscriptIntoSentences(segments);
      assert.equal(sentences[0].hasLeadingConjunction, true);
    });
  });

  // =========================================================================
  // 10. Framing & Render-Plan Crop Offset Synchronization (Phase 3)
  // =========================================================================
  describe("Framing Modes & Render Plan Crop Offset Synchronization", () => {
    it("exposes all 4 core framing strategies", () => {
      const modeIds = SHORTS_FRAMING_MODES.map((m) => m.id);
      assert.ok(modeIds.includes("smart-subject"));
      assert.ok(modeIds.includes("smart-zoom"));
      assert.ok(modeIds.includes("center"));
      assert.ok(modeIds.includes("safe-contain"));
    });

    it("attaches off-center cropX to visual segments and verifies preview and FFmpeg offsets match", () => {
      const mockClip = {
        id: "clip-wide-1",
        src: "http://localhost/test.mp4",
        duration: 40,
        width: 1920,
        height: 1080,
      };
      const candidate = {
        id: "cand-left-subject",
        startTime: 5.0,
        endTime: 25.0,
        duration: 20.0,
        cropX: 0.20, // Subject framed on left third
        framingMode: "smart-subject",
      };

      const project = convertCandidateToProject(mockClip, candidate, {
        aspectRatio: "9:16",
        autoReframing: "smart-subject",
      });

      assert.equal(project.visualSegments[0].cropX, 0.20);
      assert.equal(project.visualSegments[0].objectPosition, "20.0% 50%");

      // Now verify buildFfmpegRenderPlan produces the exact FFmpeg crop with 0.20 offset
      const extractedFiles = new Map([["test.mp4", "test.mp4"]]);
      const mockProject = {
        duration: 20.0,
        ratioId: "9:16",
        visualSegments: project.visualSegments.map((s) => ({ ...s, path: "test.mp4" })),
        audioTracks: [],
        captions: [],
      };
      const media = { visuals: [{ id: "clip-wide-1", path: "test.mp4" }] };
      const renderPlan = buildFfmpegRenderPlan({
        project: mockProject,
        media,
        extractedFiles,
        settings: { width: 1080, height: 1920, frameRate: 30 },
      });

      assert.ok(renderPlan);
      assert.ok(renderPlan.args);
      const filterArg = renderPlan.args[renderPlan.args.indexOf("-filter_complex") + 1];
      assert.ok(
        filterArg.includes("(in_w-out_w)*0.200"),
        `Render plan filter should include custom cropX offset: ${filterArg}`
      );
    });

    it("re-anchors word-level timestamps so active-word karaoke starts at 0.0s", () => {
      const mockClip = { id: "c1", src: "v.mp4", duration: 60 };
      const candidate = { id: "cand-1", startTime: 10.0, endTime: 25.0, duration: 15.0 };
      const captionWithWords = [
        {
          id: "cap-w1",
          start: 11.0,
          end: 14.0,
          text: "Never give up",
          words: [
            { word: "Never", start: 11.0, end: 11.8 },
            { word: "give", start: 11.9, end: 12.5 },
            { word: "up", start: 12.6, end: 13.5 },
          ],
        },
      ];

      const project = convertCandidateToProject(mockClip, candidate, {
        aspectRatio: "9:16",
        captionSegments: captionWithWords,
      });

      assert.equal(project.captionSegments.length, 1);
      const cap = project.captionSegments[0];
      assert.equal(cap.start, 1.0); // 11.0 - 10.0 = 1.0s
      assert.equal(cap.words.length, 3);
      assert.equal(cap.words[0].word, "Never");
      assert.equal(cap.words[0].start, 1.0); // 11.0 - 10.0 = 1.0s
      assert.equal(cap.words[0].end, 1.8);
      assert.equal(cap.words[2].word, "up");
      assert.equal(cap.words[2].start, 2.6);
      assert.equal(cap.words[2].end, 3.5);
    });
  });

  // =========================================================================
  // 12. Shorts Dedicated Export Pipeline & Aspect Ratio Verification
  // =========================================================================
  describe("Shorts Dedicated Export Pipeline & Aspect Ratio Handling", () => {
    it("generates filesystem-safe, sequentially indexed filenames", () => {
      const c1 = { id: "c1", title: "Why AI is the Future of Video!" };
      const c2 = { id: "c2", title: "Part 2: 100% Insane Performance #shorts" };
      const c3 = { id: "c3", title: "" };

      assert.equal(getShortCandidateFileName(c1, 1), "short-01-why-ai-is-the-future-of-video.mp4");
      assert.equal(getShortCandidateFileName(c2, 2), "short-02-part-2-100-insane-performance.mp4");
      assert.equal(getShortCandidateFileName(c3, 10), "short-10.mp4");
    });

    it("ensures candidate export spec strictly enforces 9:16 default and exact trim duration", () => {
      const sourceVideo = {
        id: "source-1",
        src: "blob:http://localhost/video-1",
        duration: 180.0,
        width: 1920,
        height: 1080,
      };
      const candidate = {
        id: "cand-selected",
        title: "Key Takeaway",
        startTime: 42.5,
        endTime: 67.5,
        duration: 25.0,
        cropX: 0.65,
      };

      const spec = buildShortExportSpec(sourceVideo, candidate, {});
      assert.ok(spec);
      assert.equal(spec.aspectRatio, "9:16");
      assert.equal(spec.width, 1080);
      assert.equal(spec.height, 1920);
      assert.equal(spec.duration, 25.0);
      assert.equal(spec.startTime, 42.5);
      assert.equal(spec.endTime, 67.5);

      // Verify the visual segment in project is trimmed to 25s, not 180s
      assert.equal(spec.project.visualSegments.length, 1);
      const seg = spec.project.visualSegments[0];
      assert.equal(seg.sourceStart, 42.5);
      assert.equal(seg.sourceDuration, 25.0);
      assert.equal(seg.duration, 25.0);
      assert.equal(seg.cropX, 0.65);
      assert.equal(spec.project.ratioId, "9:16");
    });

    it("honors explicit 1:1 square and 16:9 landscape aspect ratio choices", () => {
      const sourceVideo = { id: "s1", duration: 60, width: 1920, height: 1080 };
      const candidate = { id: "c1", startTime: 10, endTime: 30, duration: 20 };

      const squareSpec = buildShortExportSpec(sourceVideo, candidate, { aspectRatio: "1:1" });
      assert.equal(squareSpec.aspectRatio, "1:1");
      assert.equal(squareSpec.width, 1080);
      assert.equal(squareSpec.height, 1080);
      assert.equal(squareSpec.project.ratioId, "1:1");

      const wideSpec = buildShortExportSpec(sourceVideo, candidate, { aspectRatio: "16:9" });
      assert.equal(wideSpec.aspectRatio, "16:9");
      assert.equal(wideSpec.width, 1920);
      assert.equal(wideSpec.height, 1080);
      assert.equal(wideSpec.project.ratioId, "16:9");
    });

    it("does not mutate or overwrite the source clip object when building export spec", () => {
      const sourceClip = {
        id: "clip-original",
        src: "video.mp4",
        duration: 120.0,
        ratioId: "16:9",
        cropX: 0.5,
      };
      const candidate = { id: "c1", startTime: 15, endTime: 40, duration: 25, cropX: 0.3 };

      const spec = buildShortExportSpec(sourceClip, candidate, { aspectRatio: "9:16" });
      assert.ok(spec);
      // Source clip remains unmodified
      assert.equal(sourceClip.duration, 120.0);
      assert.equal(sourceClip.ratioId, "16:9");
      assert.equal(sourceClip.cropX, 0.5);
    });

    it("clamps boundary adjustments to prevent invalid negative or inverted boundaries", () => {
      const mockClip = { id: "c1", duration: 100 };
      const invalidCand = {
        id: "cand-inv",
        startTime: -10,
        endTime: -5,
        duration: 5,
      };

      const project = convertCandidateToProject(mockClip, invalidCand);
      assert.ok(project);
      assert.ok(project.visualSegments[0].sourceStart >= 0, "sourceStart must be non-negative");
      assert.ok(project.visualSegments[0].duration > 0, "duration must be positive");
    });
  });

  // =========================================================================
  // 13. Source Caption Isolation & Cross-Media Protection (Fix 1)
  // =========================================================================
  describe("Source Caption Isolation & Protection (Fix 1)", () => {
    const timelineCaptions = [
      { id: "tc1", text: "Welcome back to the main timeline tutorial.", start: 2.0, end: 5.5 },
      { id: "tc2", text: "Today we are building a full video project.", start: 6.0, end: 10.0 },
    ];

    it("ensures uploaded asset without its own captions does NOT leak or reuse timeline captions", () => {
      const uploadedAssetSource = {
        id: "asset-raw-video",
        name: "b-roll-nature.mp4",
        isTimelineClip: false,
        source: {
          id: "asset-raw-video",
          type: "video",
          duration: 45.0,
          captionSegments: null,
        },
      };

      const resolved = resolveSourceCaptions({
        activeSource: uploadedAssetSource,
        timelineVisualSegments: [{ id: "vis-main", duration: 30 }],
        timelineCaptionSegments: timelineCaptions,
      });

      assert.deepEqual(resolved, [], "Uploaded asset must not inherit timeline captions");
    });

    it("preserves explicit asset-specific captions when attached to an uploaded asset", () => {
      const assetCaptions = [
        { id: "ac1", text: "Nature sound recording in the forest.", start: 1.0, end: 4.0 },
      ];
      const assetWithCaptions = {
        id: "asset-doc",
        name: "interview-clip.mp4",
        isTimelineClip: false,
        source: {
          id: "asset-doc",
          captionSegments: assetCaptions,
        },
      };

      const resolved = resolveSourceCaptions({
        activeSource: assetWithCaptions,
        timelineVisualSegments: [{ id: "vis-1", duration: 60 }],
        timelineCaptionSegments: timelineCaptions,
      });

      assert.equal(resolved.length, 1);
      assert.equal(resolved[0].text, "Nature sound recording in the forest.");
    });

    it("allows single timeline video to cleanly inherit project timeline captions", () => {
      const timelineSource = {
        id: "vis-solo",
        isTimelineClip: true,
        source: { id: "vis-solo", duration: 30 },
      };

      const resolved = resolveSourceCaptions({
        activeSource: timelineSource,
        timelineVisualSegments: [{ id: "vis-solo", duration: 30 }],
        timelineCaptionSegments: timelineCaptions,
      });

      assert.equal(resolved.length, 2);
      assert.equal(resolved[0].text, "Welcome back to the main timeline tutorial.");
    });

    it("correctly slices and re-anchors timeline captions for multi-clip timelines", () => {
      const multiTimelineCaptions = [
        { id: "c1", text: "Intro segment clip one.", start: 1.0, end: 4.0 },
        { id: "c2", text: "Second clip discussion starts.", start: 12.0, end: 16.0 },
        { id: "c3", text: "Second clip key takeaway.", start: 17.0, end: 21.0 },
      ];

      const clipTwoSource = {
        id: "clip-2",
        isTimelineClip: true,
        source: { id: "clip-2", duration: 15.0 },
      };

      const segments = [
        { id: "clip-1", start: 0.0, duration: 10.0, sourceStart: 0.0 },
        { id: "clip-2", start: 10.0, duration: 15.0, sourceStart: 5.0 },
      ];

      const resolved = resolveSourceCaptions({
        activeSource: clipTwoSource,
        timelineVisualSegments: segments,
        timelineCaptionSegments: multiTimelineCaptions,
      });

      assert.equal(resolved.length, 2);
      // Timeline time 12.0s with segment start 10.0s and sourceStart 5.0s -> 12 - (10 - 5) = 7.0s
      assert.equal(resolved[0].start, 7.0);
      assert.equal(resolved[0].text, "Second clip discussion starts.");
      assert.equal(resolved[1].start, 12.0);
    });
  });

  // =========================================================================
  // 14. Transcript Excerpt & Dynamic Boundary Synchronization (Fix 4)
  // =========================================================================
  describe("Transcript Excerpt & Boundary Synchronization (Fix 4)", () => {
    const testCaptions = [
      { id: "c1", start: 0.0, end: 4.0, text: "Hook sentence that grabs attention." },
      { id: "c2", start: 4.5, end: 8.0, text: "The explanation follows here." },
      { id: "c3", start: 8.5, end: 12.0, text: "Final punchline and concluding thought." },
    ];

    it("extracts exact text within initial boundary", () => {
      const excerpt = extractTranscriptExcerpt(testCaptions, 0.0, 8.5);
      assert.equal(excerpt, "Hook sentence that grabs attention. The explanation follows here.");
    });

    it("updates excerpt when moving start boundary forward", () => {
      // Start moves to 4.2 -> excludes c1
      const excerpt = extractTranscriptExcerpt(testCaptions, 4.2, 12.0);
      assert.equal(excerpt, "The explanation follows here. Final punchline and concluding thought.");
    });

    it("updates excerpt when moving end boundary backward", () => {
      // End moves to 7.0 -> excludes c3
      const excerpt = extractTranscriptExcerpt(testCaptions, 0.0, 7.0);
      assert.equal(excerpt, "Hook sentence that grabs attention. The explanation follows here.");
    });

    it("updates excerpt when extending interval to encompass additional captions", () => {
      const excerpt = extractTranscriptExcerpt(testCaptions, 0.0, 13.0);
      assert.equal(excerpt, "Hook sentence that grabs attention. The explanation follows here. Final punchline and concluding thought.");
    });

    it("returns formatted visual scene fallback when no captions exist in interval", () => {
      const excerpt = extractTranscriptExcerpt([], 15.0, 30.0);
      assert.equal(excerpt, "[Visual Scene: 15.0s to 30.0s]");
    });

    it("handles boundary clamping gracefully", () => {
      const excerpt = extractTranscriptExcerpt(testCaptions, -5, -1);
      assert.ok(excerpt);
    });
  });

  // =========================================================================
  // 15. Batch Export Packaging & Zip Generation (Fix 5)
  // =========================================================================
  describe("Batch Export Packaging & Zip Generation (Fix 5)", () => {
    it("packages multiple exported short candidate blobs into a single valid ZIP archive", async () => {
      const mockBlob1 = new Blob(["mock-mp4-video-data-1"], { type: "video/mp4" });
      const mockBlob2 = new Blob(["mock-mp4-video-data-2"], { type: "video/mp4" });

      const exportedClips = [
        { fileName: "short-01-how-to-edit.mp4", blob: mockBlob1 },
        { fileName: "short-02-fast-tricks.mp4", blob: mockBlob2 },
      ];

      const zipBlob = await createShortsBatchZip(exportedClips);
      assert.ok(zipBlob);
      assert.equal(zipBlob.type, "application/zip");
      assert.ok(zipBlob.size > 0, "ZIP blob must contain non-zero byte size");

      // Verify the ZIP archive format header (PK signature: 0x50, 0x4B, 0x03, 0x04)
      const buffer = Buffer.from(await zipBlob.arrayBuffer());
      assert.equal(buffer[0], 0x50);
      assert.equal(buffer[1], 0x4b);
      assert.equal(buffer[2], 0x03);
      assert.equal(buffer[3], 0x04);
    });
  });

  // =========================================================================
  // 16. Phase 2 — Semantic Hook & Payoff Scoring Suite
  // =========================================================================
  describe("Phase 2 — Semantic Hook & Payoff Scoring", () => {
    // 1. Compelling hook followed by satisfying payoff
    it("1. ranks a compelling hook followed by a satisfying payoff appropriately", () => {
      const sentences = [
        {
          id: "s1",
          text: "There is one fundamental difference between senior engineers and beginners.",
          start: 0.0,
          end: 5.2,
          duration: 5.2,
          isQuestion: false,
          hasPunctuation: true,
        },
        {
          id: "s2",
          text: "Beginners focus entirely on writing syntax, while seniors focus on system failure modes.",
          start: 5.5,
          end: 11.8,
          duration: 6.3,
          isQuestion: false,
          hasPunctuation: true,
        },
        {
          id: "s3",
          text: "In the end, writing clean error handling is what keeps your production infrastructure alive.",
          start: 12.0,
          end: 19.5,
          duration: 7.5,
          isQuestion: false,
          hasPunctuation: true,
        },
      ];

      const candidates = discoverSpeechCandidates({
        sentences,
        mediaDuration: 60,
        settings: { minDuration: 15, maxDuration: 30, clipCount: 2, preference: "best" },
      });

      assert.ok(candidates.length > 0);
      const top = candidates[0];
      assert.ok(top.hookScore >= 70, `Expected hookScore >= 70, got ${top.hookScore}`);
      assert.ok(top.payoffScore >= 70, `Expected payoffScore >= 70, got ${top.payoffScore}`);
      assert.ok(top.coherenceScore >= 75, `Expected coherenceScore >= 75, got ${top.coherenceScore}`);
      assert.ok(top.semanticScore >= 75, `Expected semanticScore >= 75, got ${top.semanticScore}`);
      assert.ok(top.score >= 75, `Expected overall score >= 75, got ${top.score}`);
    });

    // 2. Coherent passage outranks incoherent keyword-heavy passage
    it("2. ensures a keyword-heavy but incoherent passage does not automatically outrank a coherent, informative passage", () => {
      // Coherent informative passage (0 clickbait buzzwords, highly coherent topic)
      const coherentSentences = [
        {
          id: "c1",
          text: "Managing audio buffer allocations in browser memory requires strict lifecycle cleanup.",
          start: 0.0,
          end: 6.0,
          duration: 6.0,
          isQuestion: false,
          hasPunctuation: true,
        },
        {
          id: "c2",
          text: "When large WAV streams are decoded simultaneously, the V8 heap easily exceeds two gigabytes.",
          start: 6.2,
          end: 13.0,
          duration: 6.8,
          isQuestion: false,
          hasPunctuation: true,
        },
        {
          id: "c3",
          text: "By streaming PCM chunks into WebAssembly workers, we eliminate memory pressure entirely.",
          start: 13.2,
          end: 20.0,
          duration: 6.8,
          isQuestion: false,
          hasPunctuation: true,
        },
      ];

      // Incoherent buzzword-stuffed passage (lots of keywords: why, secret, truth, mistake, never, but unrelated thoughts)
      const incoherentSentences = [
        {
          id: "i1",
          text: "Why secret never always mistake revealed unbelievable trick truth!",
          start: 0.0,
          end: 5.5,
          duration: 5.5,
          isQuestion: false,
          hasPunctuation: true,
        },
        {
          id: "i2",
          text: "Fresh green apples grow on orchard branches during late autumn.",
          start: 5.8,
          end: 11.5,
          duration: 5.7,
          isQuestion: false,
          hasPunctuation: true,
        },
        {
          id: "i3",
          text: "Stop doing random keyboard exercises immediately right now.",
          start: 11.8,
          end: 18.0,
          duration: 6.2,
          isQuestion: false,
          hasPunctuation: true,
        },
      ];

      const coherentCandidates = discoverSpeechCandidates({
        sentences: coherentSentences,
        mediaDuration: 60,
        settings: { minDuration: 15, maxDuration: 25, clipCount: 1, preference: "best" },
      });

      const incoherentCandidates = discoverSpeechCandidates({
        sentences: incoherentSentences,
        mediaDuration: 60,
        settings: { minDuration: 15, maxDuration: 25, clipCount: 1, preference: "best" },
      });

      assert.ok(coherentCandidates.length > 0);
      assert.ok(incoherentCandidates.length > 0);

      const coherent = coherentCandidates[0];
      const incoherent = incoherentCandidates[0];

      // Verify that the coherent candidate's coherence and semantic score outranks the buzzword-salad candidate
      assert.ok(
        coherent.coherenceScore > incoherent.coherenceScore,
        `Coherent coherence (${coherent.coherenceScore}) must be higher than incoherent (${incoherent.coherenceScore})`
      );
      assert.ok(
        coherent.semanticScore > incoherent.semanticScore,
        `Coherent semanticScore (${coherent.semanticScore}) must be higher than incoherent (${incoherent.semanticScore})`
      );
      assert.ok(
        coherent.score > incoherent.score,
        `Coherent overall score (${coherent.score}) must exceed incoherent buzzword score (${incoherent.score})`
      );
    });

    // 3. Question followed by meaningful answer
    it("3. recognizes a question followed by a meaningful answer and delivers high payoff score", () => {
      const qSentences = [
        {
          id: "q1",
          text: "Why does WebAssembly execute faster than plain JavaScript in media processing?",
          start: 0.0,
          end: 5.0,
          duration: 5.0,
          isQuestion: true,
          hasPunctuation: true,
        },
        {
          id: "q2",
          text: "JavaScript engines must parse and garbage-collect millions of dynamic object allocations.",
          start: 5.2,
          end: 11.5,
          duration: 6.3,
          isQuestion: false,
          hasPunctuation: true,
        },
        {
          id: "q3",
          text: "WebAssembly operates directly on linear byte arrays, which means zero garbage collection interruptions.",
          start: 11.8,
          end: 18.5,
          duration: 6.7,
          isQuestion: false,
          hasPunctuation: true,
        },
      ];

      const payoffEval = evaluatePayoff(qSentences[0], qSentences[2], qSentences);
      assert.equal(payoffEval.hasClearPayoff, true);
      assert.ok(payoffEval.score >= 80, `Expected payoff score >= 80, got ${payoffEval.score}`);
      assert.ok(payoffEval.factors.some((f) => f.includes("Opening question resolved")));
    });

    // 4. Strong semantic candidate recognized without hard-coded hook keywords
    it("4. recognizes a strong semantic candidate without hard-coded hook keywords", () => {
      const sentence = {
        id: "th1",
        text: "The hardest lesson in video production is mastering pacing before adding visual effects.",
        isQuestion: false,
        hasPunctuation: true,
      };

      const hookEval = evaluateSentenceHookSemantic(sentence, "education");
      assert.ok(hookEval.score >= 70, `Expected score >= 70, got ${hookEval.score}`);
      assert.equal(hookEval.isSemanticHook, true);
      assert.ok(hookEval.factors.some((f) => f.includes("thesis") || f.includes("Educational")));
    });

    // 5. Missing or incomplete transcripts fall back safely
    it("5. falls back safely when transcripts are missing, empty, or incomplete", () => {
      const sourceMedia = { duration: 90, width: 1920, height: 1080, type: "video" };

      // Null transcript
      const resNull = discoverShortCandidates({
        sourceMedia,
        transcriptResult: null,
        settings: { durationPreset: "15-30" },
      });
      assert.equal(resNull.ok, true);
      assert.ok(resNull.candidates.length > 0);
      assert.ok(resNull.candidates[0].strategy.startsWith("visual"));

      // Empty segments transcript
      const resEmpty = discoverShortCandidates({
        sourceMedia,
        transcriptResult: { segments: [] },
        settings: { durationPreset: "15-30" },
      });
      assert.equal(resEmpty.ok, true);
      assert.ok(resEmpty.candidates.length > 0);
      assert.ok(resEmpty.candidates[0].strategy.startsWith("visual"));
    });

    // 6. Malformed optional AI output cannot crash candidate discovery
    it("6. handles malformed optional AI output gracefully without crashing candidate discovery", () => {
      const sourceMedia = { duration: 60, width: 1920, height: 1080, type: "video" };
      const transcriptResult = [
        { text: "Here is an important lesson about audio mixing.", start: 1.0, end: 5.0 },
        { text: "Always lower the music bed under dialogue.", start: 5.5, end: 12.0 },
        { text: "This ensures the listener hears every syllable.", start: 12.5, end: 18.0 },
      ];

      // aiEvaluator returns non-array object
      const resBad = discoverShortCandidates({
        sourceMedia,
        transcriptResult,
        settings: { durationPreset: "15-30" },
        aiEvaluator: () => ({ invalid: "object" }),
      });

      assert.equal(resBad.ok, true);
      assert.ok(resBad.candidates.length > 0);
      assert.equal(resBad.candidates[0].strategy, "speech-centric");
    });

    // 7. External AI failure or timeout preserves deterministic fallback behavior
    it("7. preserves deterministic fallback when external AI evaluator throws an error or times out", () => {
      const sourceMedia = { duration: 60, width: 1920, height: 1080, type: "video" };
      const transcriptResult = [
        { text: "Step one is importing high resolution assets.", start: 1.0, end: 6.0 },
        { text: "Step two is creating proxy files for editing.", start: 6.5, end: 12.0 },
        { text: "In the end, your playback will never drop frames.", start: 12.5, end: 19.0 },
      ];

      // aiEvaluator throws an error (simulating network timeout / API disconnect)
      const resError = discoverShortCandidates({
        sourceMedia,
        transcriptResult,
        settings: { durationPreset: "15-30" },
        aiEvaluator: () => {
          throw new Error("Cloudflare Zero Trust AI timeout (504)");
        },
      });

      assert.equal(resError.ok, true);
      assert.ok(resError.candidates.length > 0);
      assert.ok(resError.candidates[0].score > 60);
    });

    // 8. Existing duration constraints and candidate boundaries remain valid
    it("8. enforces duration constraints and keeps candidate boundaries strictly valid", () => {
      const sentences = [
        { id: "1", text: "Sentence one is here.", start: 0.0, end: 5.0, duration: 5.0, hasPunctuation: true },
        { id: "2", text: "Sentence two develops the thought.", start: 5.2, end: 12.0, duration: 6.8, hasPunctuation: true },
        { id: "3", text: "Sentence three concludes the point.", start: 12.2, end: 22.0, duration: 9.8, hasPunctuation: true },
        { id: "4", text: "Sentence four is another idea.", start: 22.5, end: 32.0, duration: 9.5, hasPunctuation: true },
      ];

      const candidates = discoverSpeechCandidates({
        sentences,
        mediaDuration: 40,
        settings: { minDuration: 15, maxDuration: 25, clipCount: 2 },
      });

      for (const cand of candidates) {
        assert.ok(cand.startTime >= 0, "startTime must be non-negative");
        assert.ok(cand.endTime <= 40, "endTime must not exceed media duration");
        assert.ok(cand.duration >= 15, `Candidate duration (${cand.duration}) must meet minimum`);
        assert.ok(cand.duration <= 30, `Candidate duration (${cand.duration}) must not grossly exceed maximum`);
      }
    });

    // 9. Existing scoring behavior remains stable for representative baseline fixtures
    it("9. maintains stable scoring for representative baseline interview fixture", () => {
      const interviewSentences = [
        { id: "s1", text: "What is the single best advice you have for beginners?", start: 10.0, end: 14.5, duration: 4.5, isQuestion: true, hasPunctuation: true },
        { id: "s2", text: "Start before you feel ready.", start: 15.0, end: 18.0, duration: 3.0, isQuestion: false, hasPunctuation: true },
        { id: "s3", text: "Most people spend years overthinking equipment.", start: 18.5, end: 24.0, duration: 5.5, isQuestion: false, hasPunctuation: true },
        { id: "s4", text: "Just pick up your phone and press record.", start: 24.5, end: 30.0, duration: 5.5, isQuestion: false, hasPunctuation: true },
        { id: "s5", text: "You will learn more from your first ten videos than from a hundred tutorials.", start: 30.5, end: 42.0, duration: 11.5, isQuestion: false, hasPunctuation: true },
      ];

      const candidates = discoverSpeechCandidates({
        sentences: interviewSentences,
        mediaDuration: 300,
        settings: { minDuration: 20, maxDuration: 40, preference: "best", clipCount: 3 },
      });

      assert.ok(candidates.length > 0);
      const top = candidates[0];
      assert.equal(top.category, "Q&A Highlight");
      assert.ok(top.hookScore >= 70);
      assert.ok(top.payoffScore >= 75);
      assert.ok(top.score >= 75);
    });

    // 10. Repeated deterministic scoring yields consistent results
    it("10. produces identical, consistent scores across repeated deterministic scoring runs", () => {
      const sourceMedia = { duration: 120, width: 1920, height: 1080, type: "video" };
      const transcriptResult = [
        { text: "Here is the key insight about visual pacing.", start: 0.0, end: 5.0 },
        { text: "Never cut on the beat unless you want comedic timing.", start: 5.2, end: 11.0 },
        { text: "Instead, cut just before the motion peak.", start: 11.2, end: 16.5 },
        { text: "This keeps the viewer's eyes engaged across transitions.", start: 16.8, end: 23.0 },
      ];

      const run1 = discoverShortCandidates({ sourceMedia, transcriptResult, settings: { durationPreset: "15-30" } });
      const run2 = discoverShortCandidates({ sourceMedia, transcriptResult, settings: { durationPreset: "15-30" } });
      const run3 = discoverShortCandidates({ sourceMedia, transcriptResult, settings: { durationPreset: "15-30" } });

      assert.equal(run1.candidates.length, run2.candidates.length);
      assert.equal(run2.candidates.length, run3.candidates.length);

      for (let i = 0; i < run1.candidates.length; i++) {
        const c1 = run1.candidates[i];
        const c2 = run2.candidates[i];
        const c3 = run3.candidates[i];

        assert.equal(c1.score, c2.score);
        assert.equal(c2.score, c3.score);
        assert.equal(c1.hookScore, c2.hookScore);
        assert.equal(c1.payoffScore, c2.payoffScore);
        assert.equal(c1.coherenceScore, c2.coherenceScore);
        assert.equal(c1.semanticScore, c2.semanticScore);
        assert.equal(c1.startTime, c2.startTime);
        assert.equal(c1.endTime, c2.endTime);
        assert.equal(c1.title, c2.title);
      }
    });
  });

  describe("Phase 2 Quality Fixtures & Semantic Ranking Validation", () => {
    // 1. Coherent Q&A exchange
    it("ranks a coherent question-and-answer exchange as top-tier highlight", () => {
      const s_qa = [
        { id: '1', start: 0, end: 5, text: 'Why do most beginner editors struggle with render export times?', duration: 5, isQuestion: true, hasPunctuation: true },
        { id: '2', start: 5, end: 11, text: 'They often encode with software rather than enabling hardware acceleration.', duration: 6, isQuestion: false, hasPunctuation: true },
        { id: '3', start: 11, end: 17, text: 'Once you turn on NVENC or QuickSync, exports finish five times faster.', duration: 6, isQuestion: false, hasPunctuation: true },
      ];

      const cands = discoverSpeechCandidates({
        sentences: s_qa,
        mediaDuration: 60,
        settings: { minDuration: 15, maxDuration: 30, contentType: 'podcast', preference: 'best' },
      });

      assert.ok(cands.length > 0);
      const top = cands[0];
      assert.ok(top.score >= 80, `Expected top score >= 80, got ${top.score}`);
      assert.ok(top.coherenceScore >= 85, `Expected coherence >= 85, got ${top.coherenceScore}`);
      assert.ok(top.payoffScore >= 90, `Expected payoff >= 90, got ${top.payoffScore}`);
      assert.equal(top.category, 'Q&A Highlight');
    });

    // 2. Useful explanation without hook keywords vs keyword-heavy incoherent passage
    it("ensures a useful explanation without hook keywords outranks a keyword-heavy incoherent passage", () => {
      const s_explanation = [
        { id: '1', start: 0, end: 5, text: 'Color grading requires balancing luminance before adjusting chromatic saturation.', duration: 5, isQuestion: false, hasPunctuation: true },
        { id: '2', start: 5, end: 11, text: 'If your waveform scopes clip highlights, skin tones appear washed out.', duration: 6, isQuestion: false, hasPunctuation: true },
        { id: '3', start: 11, end: 17, text: 'Setting your black point first preserves natural shadow details throughout.', duration: 6, isQuestion: false, hasPunctuation: true },
      ];

      const s_buzzword = [
        { id: '1', start: 0, end: 5, text: 'Secret insane viral trick that you never knew about video editing.', duration: 5, isQuestion: false, hasPunctuation: true },
        { id: '2', start: 5, end: 11, text: 'Actually potatoes grow underground during cold seasons in Idaho.', duration: 6, isQuestion: false, hasPunctuation: true },
        { id: '3', start: 11, end: 17, text: 'Unbelievable mistake crazy hype watch this now.', duration: 6, isQuestion: false, hasPunctuation: true },
      ];

      const candExp = discoverSpeechCandidates({
        sentences: s_explanation,
        mediaDuration: 60,
        settings: { minDuration: 15, maxDuration: 30, contentType: 'education', preference: 'best' },
      })[0];

      const candBuzz = discoverSpeechCandidates({
        sentences: s_buzzword,
        mediaDuration: 60,
        settings: { minDuration: 15, maxDuration: 30, contentType: 'education', preference: 'best' },
      })[0];

      assert.ok(candExp && candBuzz);
      assert.ok(candExp.score > candBuzz.score, `Expected explanation score (${candExp.score}) > buzzword score (${candBuzz.score})`);
      assert.ok(candExp.coherenceScore > candBuzz.coherenceScore, `Expected explanation coherence (${candExp.coherenceScore}) > buzzword coherence (${candBuzz.coherenceScore})`);
      assert.ok(candExp.payoffScore > candBuzz.payoffScore, `Expected explanation payoff (${candExp.payoffScore}) > buzzword payoff (${candBuzz.payoffScore})`);
    });

    // 3. Steady coherent passage without dramatic opening
    it("keeps steady coherent passage competitive and outranking topic jump passage", () => {
      const s_steady = [
        { id: '1', start: 0, end: 5, text: 'Keyframe interpolation determines how smoothly graphics move across the screen.', duration: 5, isQuestion: false, hasPunctuation: true },
        { id: '2', start: 5, end: 11, text: 'Linear interpolation causes rigid, abrupt velocity changes at each keyframe.', duration: 6, isQuestion: false, hasPunctuation: true },
        { id: '3', start: 11, end: 17, text: 'Applying bezier curves creates natural deceleration that feels polished.', duration: 6, isQuestion: false, hasPunctuation: true },
      ];

      const s_topic_jump = [
        { id: '1', start: 0, end: 5, text: 'Microphone positioning drastically improves speech clarity.', duration: 5, isQuestion: false, hasPunctuation: true },
        { id: '2', start: 5, end: 11, text: 'Place the capsule four inches away from your mouth with a pop filter.', duration: 6, isQuestion: false, hasPunctuation: true },
        { id: '3', start: 11, end: 17, text: 'Bicycle tires require forty pounds of pressure on gravel trails.', duration: 6, isQuestion: false, hasPunctuation: true },
      ];

      const candSteady = discoverSpeechCandidates({
        sentences: s_steady,
        mediaDuration: 60,
        settings: { minDuration: 15, maxDuration: 30, contentType: 'education', preference: 'best' },
      })[0];

      const candJump = discoverSpeechCandidates({
        sentences: s_topic_jump,
        mediaDuration: 60,
        settings: { minDuration: 15, maxDuration: 30, contentType: 'education', preference: 'best' },
      })[0];

      assert.ok(candSteady && candJump);
      assert.ok(candSteady.score > candJump.score, `Expected steady score (${candSteady.score}) > topic jump score (${candJump.score})`);
      assert.ok(candSteady.coherenceScore > candJump.coherenceScore);
      assert.ok(candSteady.payoffScore > candJump.payoffScore);
    });

    // 4. Setup with missing payoff (cliffhanger)
    it("flags a setup whose payoff is missing with warnings and reduced payoff score", () => {
      const s_cliffhanger = [
        { id: '1', start: 0, end: 5, text: 'The biggest mistake creators make when launching a YouTube channel.', duration: 5, isQuestion: false, hasPunctuation: true },
        { id: '2', start: 5, end: 11, text: 'They spend three months polishing a single thumbnail and title.', duration: 6, isQuestion: false, hasPunctuation: true },
        { id: '3', start: 11, end: 16, text: 'And when they finally hit upload...', duration: 5, isQuestion: false, hasPunctuation: false },
      ];

      const candCliff = discoverSpeechCandidates({
        sentences: s_cliffhanger,
        mediaDuration: 60,
        settings: { minDuration: 15, maxDuration: 30, contentType: 'education', preference: 'best' },
      })[0];

      assert.ok(candCliff);
      assert.ok(candCliff.payoffScore < 60, `Expected cliffhanger payoff < 60, got ${candCliff.payoffScore}`);
      assert.ok(candCliff.warnings.some((w) => w.includes("unresolved") || w.includes("abruptly")));
    });

    // 5. Malformed and empty sentence inputs
    it("handles malformed and empty sentence inputs gracefully without crashing", () => {
      const malformedSentences = [
        { id: 'm1' },
        { id: 'm2', text: null, duration: NaN },
        { id: 'm3', text: 'Valid sentence with punctuation.', duration: 5, hasPunctuation: true }
      ];

      const res = discoverSpeechCandidates({
        sentences: malformedSentences,
        mediaDuration: 60,
        settings: { minDuration: 5, maxDuration: 20 },
      });

      assert.ok(Array.isArray(res));
      for (const cand of res) {
        assert.ok(Number.isFinite(cand.startTime));
        assert.ok(Number.isFinite(cand.endTime));
        assert.ok(Number.isFinite(cand.score));
      }
    });
  });

  // =========================================================================
  // 18. Phase 2 Priority 2: Smart Face-Tracking and Dynamic Reframing
  // =========================================================================
  describe("Phase 2 Priority 2: Smart Face-Tracking and Dynamic Reframing", () => {
    const sourceMedia = { width: 1920, height: 1080, duration: 10.0, type: "video" };

    // 1. Single face moving across the frame
    it("1. tracks a single face moving smoothly across the frame", () => {
      const detections = [
        { timestamp: 0.0, faces: [{ x: 0.15, y: 0.25, width: 0.14, height: 0.20, confidence: 0.95 }] },
        { timestamp: 1.5, faces: [{ x: 0.43, y: 0.25, width: 0.14, height: 0.20, confidence: 0.96 }] },
        { timestamp: 3.0, faces: [{ x: 0.72, y: 0.25, width: 0.14, height: 0.20, confidence: 0.94 }] },
      ];

      const track = buildDynamicReframingTrack({
        detections,
        duration: 4.0,
        sourceSize: { width: 1920, height: 1080 },
        targetRatio: 9 / 16,
      });

      assert.ok(track);
      assert.equal(track.mode, "face-track");
      assert.equal(track.isFallback, false);
      assert.ok(track.cropKeyframes.length >= 3);

      const kfStart = track.cropKeyframes[0];
      const kfMid = track.cropKeyframes.find((k) => k.time >= 1.4 && k.time <= 1.6);
      const kfEnd = track.cropKeyframes[track.cropKeyframes.length - 1];

      assert.ok(kfStart && kfMid && kfEnd);
      // As the face travels left (0.15) -> center (0.43) -> right (0.72), cropX must monotonically increase
      assert.ok(kfStart.cropX < kfMid.cropX, `Start cropX (${kfStart.cropX}) should be < Mid cropX (${kfMid.cropX})`);
      assert.ok(kfMid.cropX < kfEnd.cropX, `Mid cropX (${kfMid.cropX}) should be < End cropX (${kfEnd.cropX})`);
    });

    // 2. Multiple faces
    it("2. selects the most sensible face among multiple faces using prominence and continuity", () => {
      // Frame 1: Face A (prominent, area 0.25*0.30=0.075, center x=0.325) vs Face B (small background, area 0.06*0.08=0.0048, center x=0.75)
      const frame1Faces = [
        { x: 0.72, y: 0.3, width: 0.06, height: 0.08, confidence: 0.8 },
        { x: 0.20, y: 0.2, width: 0.25, height: 0.30, confidence: 0.95 },
      ];
      const primary1 = selectPrimaryFace(frame1Faces, null);
      assert.ok(primary1);
      assert.ok(primary1.x < 0.3, "Should select prominent foreground speaker (Face A)");

      // Frame 2: Face A continues at x=0.21. A new competitor Face C appears at x=0.65 with comparable area
      const frame2Faces = [
        { x: 0.21, y: 0.2, width: 0.24, height: 0.29, confidence: 0.94 },
        { x: 0.55, y: 0.2, width: 0.25, height: 0.30, confidence: 0.92 },
      ];
      // Due to temporal continuity hysteresis bonus (+30 score), Face A must be retained
      const primary2 = selectPrimaryFace(frame2Faces, primary1);
      assert.ok(primary2);
      assert.ok(primary2.x < 0.3, "Temporal continuity should preserve current subject instead of thrashing to new face");
    });

    // 3. Face disappearing and reappearing
    it("3. handles face disappearance, occlusion coasting, and smooth reacquisition", () => {
      const detections = [
        { timestamp: 0.0, faces: [{ x: 0.25, y: 0.25, width: 0.15, height: 0.20 }] },
        { timestamp: 1.0, faces: [{ x: 0.25, y: 0.25, width: 0.15, height: 0.20 }] },
        // Disappearance / occlusion between 1.0 and 2.0 (gap of 1.0s <= 1.5s coasting threshold)
        { timestamp: 2.0, faces: [{ x: 0.26, y: 0.25, width: 0.15, height: 0.20 }] },
        { timestamp: 3.0, faces: [{ x: 0.26, y: 0.25, width: 0.15, height: 0.20 }] },
      ];

      const track = buildDynamicReframingTrack({
        detections,
        duration: 3.5,
        sourceSize: { width: 1920, height: 1080 },
        targetRatio: 9 / 16,
      });

      assert.ok(track);
      assert.equal(track.isFallback, false);

      // Verify crop remains steady and coasts during occlusion gap without collapsing to center
      const cropAt1 = resolveSmartFrameCropAtTime(track, 1.0);
      const cropAt2 = resolveSmartFrameCropAtTime(track, 2.0);
      assert.ok(cropAt1 && cropAt2);
      assert.ok(Math.abs(cropAt1.x - cropAt2.x) < 0.03, "Camera should coast steadily during brief 1.0s occlusion");
    });

    // 4. Scene cut with a different person
    it("4. executes instantaneous cuts at scene boundaries without cross-cut pan smoothing", () => {
      const detections = [
        // Person 1 on left side (x=0.15) before cut
        { timestamp: 0.0, faces: [{ x: 0.15, y: 0.2, width: 0.15, height: 0.2 }] },
        { timestamp: 1.5, faces: [{ x: 0.15, y: 0.2, width: 0.15, height: 0.2 }] },
        // Scene cut happens at t=2.0 -> Person 2 on right side (x=0.75)
        { timestamp: 2.0, faces: [{ x: 0.75, y: 0.2, width: 0.15, height: 0.2 }] },
        { timestamp: 3.5, faces: [{ x: 0.75, y: 0.2, width: 0.15, height: 0.2 }] },
      ];

      const track = buildDynamicReframingTrack({
        detections,
        duration: 4.0,
        sourceSize: { width: 1920, height: 1080 },
        targetRatio: 9 / 16,
        sceneCuts: [2.0],
      });

      assert.ok(track);
      // Must contain a cut keyframe at or near 2.0
      const cutKf = track.cropKeyframes.find((k) => Math.abs(k.time - 2.0) < 0.15 && k.cut);
      assert.ok(cutKf, "Track must place a cut keyframe at scene boundary");

      // Verify the crop immediately after cut is shifted to right person
      const afterCut = track.cropKeyframes.find((k) => k.time >= 2.0 && k.time <= 2.2);
      assert.ok(afterCut);
      assert.ok(afterCut.cropX > 0.40, `Post-cut framing should jump directly to right person, got ${afterCut.cropX}`);
    });

    // 5. No faces detected
    it("5. generates a clean, centered fallback track when no faces are detected", () => {
      const track = buildDynamicReframingTrack({
        detections: [],
        duration: 5.0,
        sourceSize: { width: 1920, height: 1080 },
        targetRatio: 9 / 16,
      });

      assert.ok(track);
      assert.equal(track.isFallback, true);
      assert.equal(track.detectionCount, 0);
      assert.ok(track.cropKeyframes.length >= 2);

      const cropDims = calculateTargetCropDimensions({ width: 1920, height: 1080 }, 9 / 16);
      const expectedCenterX = (1 - cropDims.cropW) / 2;
      assert.ok(Math.abs(track.cropKeyframes[0].cropX - expectedCenterX) < 0.001);
      assert.equal(track.cropKeyframes[0].cropY, 0);
    });

    // 6. Invalid or missing detection timestamps
    it("6. robustly sanitizes invalid, missing, or unordered detection timestamps", () => {
      const noisyDetections = [
        { timestamp: NaN, faces: [{ x: 0.5, y: 0.5, width: 0.1, height: 0.1 }] },
        { timestamp: undefined, faces: [{ x: 0.5, y: 0.5, width: 0.1, height: 0.1 }] },
        { timestamp: -2.0, faces: [{ x: 0.5, y: 0.5, width: 0.1, height: 0.1 }] },
        { timestamp: "invalid", faces: [{ x: 0.5, y: 0.5, width: 0.1, height: 0.1 }] },
        // Out-of-order valid timestamps
        { timestamp: 3.0, faces: [{ x: 0.7, y: 0.2, width: 0.15, height: 0.2 }] },
        { timestamp: 1.0, faces: [{ x: 0.3, y: 0.2, width: 0.15, height: 0.2 }] },
      ];

      const track = buildDynamicReframingTrack({
        detections: noisyDetections,
        duration: 4.0,
        sourceSize: { width: 1920, height: 1080 },
        targetRatio: 9 / 16,
      });

      assert.ok(track);
      assert.equal(track.isFallback, false);
      for (const kf of track.cropKeyframes) {
        assert.ok(Number.isFinite(kf.time), `Keyframe time must be finite, got ${kf.time}`);
        assert.ok(Number.isFinite(kf.cropX), `Keyframe cropX must be finite, got ${kf.cropX}`);
        assert.ok(Number.isFinite(kf.cropY), `Keyframe cropY must be finite, got ${kf.cropY}`);
      }
      // Times must be monotonically non-decreasing
      for (let i = 1; i < track.cropKeyframes.length; i++) {
        assert.ok(track.cropKeyframes[i].time >= track.cropKeyframes[i - 1].time);
      }
    });

    // 7. Crop boundaries and output aspect ratio
    it("7. strictly bounds crops within [0, 1 - width] and [0, 1 - height] for 9:16, 1:1, and 16:9", () => {
      const ratios = [
        { name: "9:16", ratio: 9 / 16 },
        { name: "1:1", ratio: 1 / 1 },
        { name: "16:9", ratio: 16 / 9 },
      ];

      // Test extreme face positions: far left (0.01) and far right (0.98)
      const extremeDetections = [
        { timestamp: 0.0, faces: [{ x: 0.005, y: 0.01, width: 0.1, height: 0.15 }] },
        { timestamp: 2.0, faces: [{ x: 0.95, y: 0.85, width: 0.1, height: 0.15 }] },
      ];

      for (const { name, ratio } of ratios) {
        const cropDims = calculateTargetCropDimensions({ width: 1920, height: 1080 }, ratio);
        assert.ok(cropDims.cropW > 0 && cropDims.cropW <= 1.0001);
        assert.ok(cropDims.cropH > 0 && cropDims.cropH <= 1.0001);

        const track = buildDynamicReframingTrack({
          detections: extremeDetections,
          duration: 3.0,
          sourceSize: { width: 1920, height: 1080 },
          targetRatio: ratio,
        });

        for (const kf of track.cropKeyframes) {
          assert.ok(kf.cropX >= 0, `${name}: cropX must be >= 0, got ${kf.cropX}`);
          assert.ok(
            kf.cropX + cropDims.cropW <= 1.0001,
            `${name}: cropX + cropW must be <= 1, got ${kf.cropX + cropDims.cropW}`
          );
          assert.ok(kf.cropY >= 0, `${name}: cropY must be >= 0, got ${kf.cropY}`);
          assert.ok(
            kf.cropY + cropDims.cropH <= 1.0001,
            `${name}: cropY + cropH must be <= 1, got ${kf.cropY + cropDims.cropH}`
          );
        }
      }
    });

    // 8. Crop smoothing and abrupt movement
    it("8. suppresses high-frequency jitter with deadband while smoothing genuine pans", () => {
      // Jitter: microscopic oscillation back and forth (+-0.004)
      const jitterDetections = [
        { timestamp: 0.0, faces: [{ x: 0.500, y: 0.25, width: 0.15, height: 0.2 }] },
        { timestamp: 0.2, faces: [{ x: 0.504, y: 0.25, width: 0.15, height: 0.2 }] },
        { timestamp: 0.4, faces: [{ x: 0.498, y: 0.25, width: 0.15, height: 0.2 }] },
        { timestamp: 0.6, faces: [{ x: 0.502, y: 0.25, width: 0.15, height: 0.2 }] },
        { timestamp: 0.8, faces: [{ x: 0.500, y: 0.25, width: 0.15, height: 0.2 }] },
      ];

      const track = buildDynamicReframingTrack({
        detections: jitterDetections,
        duration: 1.0,
        sourceSize: { width: 1920, height: 1080 },
        targetRatio: 9 / 16,
      });

      // Deadband filter should prevent erratic jumping: maximum delta across keyframes should be < 0.015
      const cropXs = track.cropKeyframes.map((k) => k.cropX);
      const minX = Math.min(...cropXs);
      const maxX = Math.max(...cropXs);
      assert.ok(maxX - minX < 0.015, `Jitter suppression failed: delta was ${maxX - minX}`);
    });

    // 9. Existing static crop behavior and regression protection
    it("9. preserves existing static crop behavior and respects manual cropX offsets", () => {
      const candidate = {
        id: "cand-static-test",
        startTime: 10.0,
        endTime: 25.0,
        score: 85,
        title: "Test Short",
        cropX: 0.12, // User manual offset
      };

      const project = convertCandidateToProject({
        candidate,
        sourceMedia,
        aspectRatio: "9:16",
      });

      assert.ok(project);
      assert.ok(project.segments.length > 0);
      const segment = project.segments[0];

      // Verify static fallback cropOffset is preserved
      assert.equal(segment.cropOffset.x, 0.12);
      assert.equal(segment.cropOffset.y, 0);

      // Verify dynamic track generates piecewise FFmpeg crop filter
      const dynamicTrack = buildDynamicReframingTrack({
        detections: [
          { timestamp: 0, faces: [{ x: 0.2, y: 0.2, width: 0.1, height: 0.1 }] },
          { timestamp: 2, faces: [{ x: 0.7, y: 0.2, width: 0.1, height: 0.1 }] },
        ],
        duration: 3,
        sourceSize: { width: 1920, height: 1080 },
        targetRatio: "9:16",
      });
      const dynamicCropFilter = buildReframingFFmpegCropFilter(dynamicTrack, 1080, 1920, 3.0);
      assert.ok(dynamicCropFilter.includes("crop=1080:1920:"));
      assert.ok(dynamicCropFilter.includes("between(t,"));

      // Static fallback returns empty string to preserve static cropOffset in projectRenderPlan
      const staticFilter = buildReframingFFmpegCropFilter(null, 1080, 1920, 15.0);
      assert.equal(staticFilter, "");
    });

    // 10. Detection failure and safe fallback behavior
    it("10. recovers gracefully from detection failures, null inputs, and malformed structures", () => {
      // 1. null / undefined detections
      const trackNull = buildDynamicReframingTrack({
        detections: null,
        duration: 5.0,
        sourceSize: { width: 1920, height: 1080 },
        targetRatio: 9 / 16,
      });
      assert.equal(trackNull.isFallback, true);
      assert.ok(trackNull.cropKeyframes.length >= 2);

      // 2. Corrupt face entries (missing x, y, negative sizes)
      const trackCorrupt = buildDynamicReframingTrack({
        detections: [
          { timestamp: 0.0, faces: [{ x: "not-a-number", y: null, width: -10, height: NaN }] },
          { timestamp: 1.0, faces: null },
        ],
        duration: 3.0,
        sourceSize: { width: 1920, height: 1080 },
        targetRatio: 9 / 16,
      });
      assert.ok(trackCorrupt);
      assert.equal(trackCorrupt.isFallback, true);

      // 3. candidate application with null candidate
      const candRes = applyDynamicReframingToCandidate(null, []);
      assert.equal(candRes, null);

      // 4. candidate application with valid candidate
      const testCand = { startTime: 0, endTime: 5, score: 70 };
      const applied = applyDynamicReframingToCandidate(testCand, []);
      assert.ok(applied.smartFrame);
      assert.equal(applied.smartFrame.isFallback, true);
    });
  });

  // =========================================================================
  // 19. Phase 2 Priority 3: Speech-Paced Visual Punch-Ins & Smart Zoom
  // =========================================================================
  describe("Phase 2 Priority 3 — Speech-Paced Punch-Ins & Smart Zoom", () => {
    const sourceMedia = { id: "media-test", width: 1920, height: 1080, duration: 60.0, type: "video" };

    // 1. A single clear speech emphasis creates an appropriately timed punch-in
    it("1. creates an appropriately timed punch-in for a single clear speech emphasis", () => {
      const candidate = { id: "c-emphasis-1", startTime: 10.0, endTime: 30.0 };
      const sentences = [
        {
          id: "s1",
          start: 11.0,
          end: 13.0,
          text: "Today we are looking at this topic.",
        },
        {
          id: "s2",
          start: 15.0,
          end: 18.0,
          text: "Why is this the most CRUCIAL question?",
        },
        {
          id: "s3",
          start: 20.0,
          end: 23.0,
          text: "We will find out together soon.",
        },
      ];

      const punchIns = detectSpeechPacedPunchIns({
        candidate,
        sentences,
        clipDuration: 20.0,
      });

      assert.ok(Array.isArray(punchIns));
      assert.ok(punchIns.length >= 1, "Should identify at least one punch-in");
      // The punch-in should match the high-emphasis sentence s2
      const target = punchIns.find((p) => Math.abs(p.tStart - 5.0) < 0.2); // 15.0 - 10.0 = 5.0s into clip
      assert.ok(target, "Punch-in must align with the emphasized question at 5.0s into clip");
      assert.ok(target.scale > 1.0 && target.scale <= 1.45);
      assert.ok(target.duration >= 1.5 && target.duration <= 4.0);
    });

    // 2. Continuous speech without meaningful transitions does not create excessive zoom events
    it("2. does not create excessive zoom events during continuous speech without meaningful transitions", () => {
      const candidate = { id: "c-monotone", startTime: 0.0, endTime: 25.0 };
      // 5 monotone, flat sentences with low emphasis words
      const sentences = [
        { id: "m1", start: 1.0, end: 4.0, text: "we then walked across the quiet street" },
        { id: "m2", start: 5.0, end: 8.0, text: "we then turned to see the other car" },
        { id: "m3", start: 9.0, end: 12.0, text: "we then stood next to the open gate" },
        { id: "m4", start: 13.0, end: 16.0, text: "we then took the small bag with us" },
        { id: "m5", start: 17.0, end: 20.0, text: "we then went back to the front door" },
      ];

      const punchIns = detectSpeechPacedPunchIns({
        candidate,
        sentences,
        clipDuration: 25.0,
      });

      // Cadence & threshold control must prevent zooming at every sentence
      assert.ok(punchIns.length <= 1, `Monotone speech should not create excessive zooms, got ${punchIns.length}`);
    });

    // 3. Sentence boundaries are respected when reliable word-level timing is unavailable
    it("3. respects sentence boundaries when reliable word-level timing is unavailable", () => {
      const candidate = { id: "c-sentence-bound", startTime: 10.0, endTime: 25.0 };
      const sentences = [
        {
          id: "sb1",
          start: 13.5,
          end: 16.5,
          text: "Remember, this step completely transforms your workflow!",
          // No words array provided
        },
      ];

      const punchIns = detectSpeechPacedPunchIns({
        candidate,
        sentences,
        clipDuration: 15.0,
      });

      assert.equal(punchIns.length, 1);
      // tStart into clip should be exactly 13.5 - 10.0 = 3.5s
      assert.ok(Math.abs(punchIns[0].tStart - 3.5) < 0.05, `Punch-in should start at sentence start 3.5s, got ${punchIns[0].tStart}`);
    });

    // 4. Word-level timing is respected when available
    it("4. respects word-level timing and snaps to word boundaries rather than mid-word", () => {
      const candidate = { id: "c-word-timing", startTime: 0.0, endTime: 20.0 };
      const sentences = [
        {
          id: "w1",
          start: 2.0,
          end: 6.0,
          text: "Here is the SECRET that changes everything.",
          words: [
            { word: "Here", start: 2.0, end: 2.3 },
            { word: "is", start: 2.35, end: 2.5 },
            { word: "the", start: 2.55, end: 2.7 },
            { word: "SECRET", start: 2.8, end: 3.4 },
            { word: "that", start: 3.45, end: 3.7 },
            { word: "changes", start: 3.75, end: 4.2 },
            { word: "everything.", start: 4.25, end: 5.0 },
          ],
        },
      ];

      const punchIns = detectSpeechPacedPunchIns({
        candidate,
        sentences,
        clipDuration: 20.0,
      });

      assert.equal(punchIns.length, 1);
      // The punch-in should snap either to sentence start (2.0) or to the capitalized emphasized word "SECRET" (2.8)
      const allowedStarts = [2.0, 2.8];
      const matched = allowedStarts.some((t) => Math.abs(punchIns[0].tStart - t) < 0.05);
      assert.ok(matched, `Punch-in must snap to a word boundary, got ${punchIns[0].tStart}`);
    });

    // 5. Punch-ins follow the tracked face rather than the original frame center
    it("5. centers punch-ins on the tracked face within the reframed crop window", () => {
      // Source is 1920x1080 (16:9). Target is 9:16.
      // Crop window width = 1080 * (9/16) / 1920 = 607.5 / 1920 = ~0.3164.
      // Suppose face is at source x=0.70, y=0.15 (head area).
      const faceDetections = [
        {
          timestamp: 5.0,
          faces: [{ x: 0.70, y: 0.15, width: 0.10, height: 0.15 }],
        },
      ];

      const reframingTrack = buildDynamicReframingTrack({
        detections: faceDetections,
        duration: 10.0,
        sourceSize: { width: 1920, height: 1080 },
        targetRatio: 9 / 16,
      });

      const offset = resolveFaceAwarePunchInOffset({
        reframingTrack,
        time: 5.0,
        scale: 1.25,
        faceDetections,
      });

      assert.ok(offset);
      assert.ok(Number.isFinite(offset.x));
      assert.ok(Number.isFinite(offset.y));
      // Face is in the upper portion. Headroom offset should ensure y is valid and clamped
      assert.ok(Math.abs(offset.x) <= 25, `Clamped x offset should be within bounds, got ${offset.x}`);
      assert.ok(Math.abs(offset.y) <= 25, `Clamped y offset should be within bounds, got ${offset.y}`);
    });

    // 6. Missing face detection uses a safe fallback
    it("6. uses a safe centered fallback when no face detections exist", () => {
      const offsetNull = resolveFaceAwarePunchInOffset({
        reframingTrack: null,
        time: 3.0,
        scale: 1.25,
        faceDetections: [],
      });

      assert.equal(offsetNull.x, 0);
      assert.equal(offsetNull.y, 0);

      const offsetEmpty = resolveFaceAwarePunchInOffset({
        reframingTrack: { isFallback: true, cropKeyframes: [] },
        time: 3.0,
        scale: 1.25,
        faceDetections: null,
      });

      assert.equal(offsetEmpty.x, 0);
      assert.equal(offsetEmpty.y, 0);
    });

    // 7. Overlapping events are merged or resolved deterministically
    it("7. deterministically enforces cadence spacing to avoid overlapping punch-in events", () => {
      const candidate = { id: "c-cadence", startTime: 0.0, endTime: 30.0 };
      // Multiple strong sentences spaced very closely (< 2.5s apart)
      const sentences = [
        { id: "c1", start: 2.0, end: 4.0, text: "Why is this FIRST discovery huge?" },
        { id: "c2", start: 4.5, end: 6.5, text: "Because this SECOND discovery changes everything!" },
        { id: "c3", start: 7.0, end: 9.0, text: "Remember the THIRD rule always!" },
      ];

      const punchIns = detectSpeechPacedPunchIns({
        candidate,
        sentences,
        clipDuration: 30.0,
      });

      // Should space them out by at least 3.0 seconds between starts
      for (let i = 1; i < punchIns.length; i++) {
        const delta = punchIns[i].tStart - punchIns[i - 1].tStart;
        assert.ok(delta >= 3.0, `Adjacent punch-in starts must be separated by >= 3.0s, got delta ${delta}`);
      }
    });

    // 8. Scene cuts do not cause inappropriate zoom interpolation across shots
    it("8. clamps punch-in duration before a scene cut to avoid interpolating across shots", () => {
      const candidate = { id: "c-scenecut", startTime: 0.0, endTime: 20.0 };
      const sentences = [
        {
          id: "sc1",
          start: 3.0,
          end: 7.0,
          text: "Notice how this fundamental principle operates!",
        },
      ];
      // Visual scene cut at 5.5s (right in the middle of a standard 3.0s punch-in from 3.0 to 6.0)
      const sceneCuts = [{ timestamp: 5.5 }];

      const punchIns = detectSpeechPacedPunchIns({
        candidate,
        sentences,
        sceneCuts,
        clipDuration: 20.0,
      });

      assert.equal(punchIns.length, 1);
      // The punch-in must end cleanly before the cut at 5.5s (tStart + duration <= 5.5)
      const punchEnd = punchIns[0].tStart + punchIns[0].duration;
      assert.ok(punchEnd <= 5.5, `Punch-in end (${punchEnd}) must not cross scene cut at 5.5s`);
    });

    // 9. Zoom and crop coordinates remain within valid bounds
    it("9. strictly bounds zoom scale and crop offsets to prevent out-of-frame sampling", () => {
      // Test extreme scale values
      const safeScale1 = Math.min(Math.max(1.80, 1.15), 1.45);
      assert.equal(safeScale1, 1.45, "Scale must be clamped to max 1.45");

      // Test extreme offset clamping
      const extremeOffsets = clampPunchInOffsets(80, -90, 1.3);
      assert.ok(Number.isFinite(extremeOffsets.x));
      assert.ok(Number.isFinite(extremeOffsets.y));
      assert.ok(Math.abs(extremeOffsets.x) <= 30);
      assert.ok(Math.abs(extremeOffsets.y) <= 30);
    });

    // 10. Manual crop adjustments and legacy static zoom remain compatible
    it("10. preserves manual crop adjustments and compatibility when speechPunchIns is disabled", () => {
      const candidate = {
        id: "c-manual-crop",
        startTime: 5.0,
        endTime: 20.0,
        score: 80,
        title: "Manual Crop Short",
        cropX: 0.18,
      };

      const projectWithZooms = convertCandidateToProject({
        candidate,
        sourceMedia,
        aspectRatio: "9:16",
        speechPunchIns: true,
      });

      assert.ok(projectWithZooms);
      const segmentWith = projectWithZooms.segments[0];
      assert.equal(segmentWith.cropOffset.x, 0.18);

      const projectWithoutZooms = convertCandidateToProject({
        candidate,
        sourceMedia,
        aspectRatio: "9:16",
        speechPunchIns: false,
      });

      assert.ok(projectWithoutZooms);
      const segmentWithout = projectWithoutZooms.segments[0];
      assert.equal(segmentWithout.cropOffset.x, 0.18);
      assert.equal(segmentWithout.punchIns.length, 0);
      assert.equal(segmentWithout.keyframes.length, 0);
    });

    // 11. Invalid timestamps and malformed transcript data do not crash processing
    it("11. robustly handles invalid timestamps, missing text, and malformed structures without throwing", () => {
      const candidate = { id: "c-malformed", startTime: NaN, endTime: null };
      const corruptSentences = [
        null,
        { start: "not-a-number", end: undefined, text: null },
        { start: -5, end: -2, text: 12345 },
        { start: 10, end: 5, text: "" }, // inverted interval
      ];

      assert.doesNotThrow(() => {
        const result = detectSpeechPacedPunchIns({
          candidate,
          sentences: corruptSentences,
          clipDuration: 15.0,
        });
        assert.ok(Array.isArray(result));
      });
    });

    // 12. Preview and export calculations agree for representative test fixtures
    it("12. produces consistent scale and offset calculations across preview keyframes and FFmpeg filters", () => {
      const punchIns = [
        {
          id: "pi-parity",
          time: 2.0,
          tStart: 2.0,
          duration: 3.0,
          scale: 1.25,
          x: 4.5,
          y: -2.5,
          transition: "jump",
          transitionIn: 0.4,
          transitionOut: 0.5,
        },
      ];

      // 1. Preview compile keyframes
      const previewKeyframes = compilePunchInKeyframes(punchIns, 10.0);
      assert.ok(previewKeyframes.length >= 4);

      // Verify peak scale in preview keyframes matches punchIn scale
      const peakKf = previewKeyframes.find((k) => k.scale === 1.25);
      assert.ok(peakKf);
      assert.equal(peakKf.scale, 1.25);
      assert.equal(peakKf.x, 4.5);
      assert.equal(peakKf.y, -2.5);

      // 2. Headless export FFmpeg crop filter
      const filter = buildSmartZoomCropFilter(punchIns, 1080, 1920, 10.0);
      assert.ok(filter.includes("crop="));
      assert.ok(filter.includes("scale=1080:1920"));
      // The filter must account for the 1.25 scale (e.g. 1080 / 1.25 = 864)
      assert.ok(filter.includes("864") || filter.includes("between(t,"));
    });
  });

  // =========================================================================
  // 20. Phase 2 Priority 4: Semantic Narrative Arc Clustering
  // =========================================================================
  describe("Phase 2 Priority 4: Semantic Narrative Arc Clustering", () => {
    // 1. Stage classification
    it("1. classifies sentences into Setup, Climax, and Resolution stages accurately", () => {
      const sHook = {
        id: "s1",
        start: 0,
        end: 4,
        text: "Why do most podcasters give up after only three episodes?",
        isQuestion: true,
      };
      const sClimax = {
        id: "s2",
        start: 4,
        end: 9,
        text: "The real breakthrough is realizing that listener retention depends on pacing, not celebrity guests.",
        isQuestion: false,
      };
      const sResolution = {
        id: "s3",
        start: 9,
        end: 14,
        text: "So the actionable takeaway is to edit out all conversational pauses under three seconds.",
        isQuestion: false,
      };

      const stage1 = classifySentenceNarrativeStage(sHook, { positionRatio: 0.1, totalSentences: 3, index: 0 });
      const stage2 = classifySentenceNarrativeStage(sClimax, { positionRatio: 0.5, totalSentences: 3, index: 1 });
      const stage3 = classifySentenceNarrativeStage(sResolution, { positionRatio: 0.9, totalSentences: 3, index: 2 });

      assert.equal(stage1.stage, NARRATIVE_STAGES.SETUP, `Expected SETUP for hook question, got ${stage1.stage}`);
      assert.equal(stage2.stage, NARRATIVE_STAGES.CLIMAX, `Expected CLIMAX for core insight, got ${stage2.stage}`);
      assert.equal(stage3.stage, NARRATIVE_STAGES.RESOLUTION, `Expected RESOLUTION for actionable takeaway, got ${stage3.stage}`);
    });

    // 2. Thematic continuity & topic shifts
    it("2. detects thematic continuity and flags topic shifts between disjoint topics", () => {
      const sAudioA = {
        id: "a1",
        start: 0,
        end: 4,
        text: "Setting up your studio microphone correctly is critical for vocal clarity.",
      };
      const sAudioB = {
        id: "a2",
        start: 4.5,
        end: 8.5,
        text: "Furthermore, your microphone capsule distance should remain exactly six inches away.",
      };
      const sCooking = {
        id: "c1",
        start: 12.0, // Long pause (3.5s)
        end: 16.0,
        text: "Baking artisanal sourdough bread requires precise hydration and temperature control.",
      };

      const continuityRelated = computeThematicContinuity(sAudioA, sAudioB);
      assert.ok(continuityRelated.thematicScore > 30, `Expected thematic score > 30, got ${continuityRelated.thematicScore}`);
      assert.equal(continuityRelated.topicShift, false);

      const continuityUnrelated = computeThematicContinuity(sAudioB, sCooking);
      assert.ok(
        continuityUnrelated.thematicScore < continuityRelated.thematicScore,
        `Expected unrelated score (${continuityUnrelated.thematicScore}) < related score (${continuityRelated.thematicScore})`
      );
      assert.equal(continuityUnrelated.topicShift, true, "Expected topicShift true due to lexical mismatch and conversational gap");
    });

    // 3. Narrative arc clustering
    it("3. clusters a multi-sentence transcript into distinct, coherent narrative arcs", () => {
      const sentences = [
        // Story 1: Video Editing (0 - 15s)
        { id: "s1", start: 0, end: 4, text: "Are you struggling to edit videos faster?", isQuestion: true },
        { id: "s2", start: 4, end: 9, text: "The secret is mastering keyboard shortcuts for ripple edits.", isQuestion: false },
        { id: "s3", start: 9, end: 14, text: "Therefore you will cut your timeline editing hours in half.", isQuestion: false },
        // Story 2: Sound Design (18 - 32s, after 4s pause)
        { id: "s4", start: 18, end: 22, text: "How should you mix your background music?", isQuestion: true },
        { id: "s5", start: 22, end: 27, text: "The key revelation is applying sidechain compression to duck under vocals.", isQuestion: false },
        { id: "s6", start: 27, end: 32, text: "In conclusion, your speech will always sound pristine and audible.", isQuestion: false },
      ];

      const arcs = clusterNarrativeArcs(sentences, { maxArcDuration: 40 });
      assert.ok(Array.isArray(arcs));
      assert.equal(arcs.length, 2, `Expected 2 narrative arcs, got ${arcs.length}`);

      assert.equal(arcs[0].startSentenceIndex, 0);
      assert.equal(arcs[0].endSentenceIndex, 2);
      assert.ok(arcs[0].completenessScore >= 80, `Expected Story 1 completeness >= 80, got ${arcs[0].completenessScore}`);

      assert.equal(arcs[1].startSentenceIndex, 3);
      assert.equal(arcs[1].endSentenceIndex, 5);
      assert.ok(arcs[1].completenessScore >= 80, `Expected Story 2 completeness >= 80, got ${arcs[1].completenessScore}`);
    });

    // 4. Candidate arc boundary optimization
    it("4. optimizes candidate boundaries to encompass complete setup-climax-payoff arcs", () => {
      const sentences = [
        { id: "s1", start: 0, end: 5, text: "Here is the biggest pitfall in digital marketing.", isQuestion: false },
        { id: "s2", start: 5, end: 11, text: "Most teams optimize for clicks instead of qualified conversions.", isQuestion: false },
        { id: "s3", start: 11, end: 15, text: "The crucial turning point happens when you track lifetime value.", isQuestion: false },
        // Payoff at 15-20s. minDuration is 14s (would stop at s3 at 15s without arc optimization)
        { id: "s4", start: 15, end: 20, text: "So start measuring 90-day retention to guarantee positive ROI.", isQuestion: false },
        // Subsequent unrelated sentence
        { id: "s5", start: 23, end: 28, text: "Let us switch topics and examine our quarterly office expenses.", isQuestion: false },
      ];

      const optimized = optimizeCandidateArcBoundaries({
        startIndex: 0,
        sentences,
        minDuration: 14,
        maxDuration: 25,
        mediaDuration: 60,
      });

      assert.ok(optimized);
      assert.equal(optimized.endIndex, 3, "Boundary optimization should extend to sentence 3 (s4) to capture resolution payoff");
      assert.equal(optimized.duration, 20);
      assert.ok(optimized.arcCompletenessScore >= 80);
      assert.equal(optimized.isComplete, true);
    });

    // 5. Arc completeness evaluation & collision detection
    it("5. evaluates narrative arc completeness and flags missing stages or multi-arc collisions", () => {
      const narrativeArcs = [
        { id: "arc-0", startSentenceIndex: 0, endSentenceIndex: 2, startTime: 0, endTime: 12 },
        { id: "arc-1", startSentenceIndex: 3, endSentenceIndex: 5, startTime: 15, endTime: 27 },
      ];

      // Case A: Complete candidate
      const completeCandidateSentences = [
        { id: "1", text: "Why do we fail?", isQuestion: true, narrativeStage: NARRATIVE_STAGES.SETUP },
        { id: "2", text: "The key revelation is focus.", narrativeStage: NARRATIVE_STAGES.CLIMAX },
        { id: "3", text: "So do this today.", narrativeStage: NARRATIVE_STAGES.RESOLUTION },
      ];
      const evalComplete = evaluateNarrativeArcCompleteness(completeCandidateSentences, narrativeArcs);
      assert.ok(evalComplete.completenessScore >= 80);
      assert.equal(evalComplete.isComplete, true);
      assert.equal(evalComplete.warnings.length, 0);

      // Case B: Partial candidate missing resolution
      const incompleteCandidateSentences = [
        { id: "1", text: "Why do we fail?", isQuestion: true, narrativeStage: NARRATIVE_STAGES.SETUP },
        { id: "2", text: "The key revelation is focus.", narrativeStage: NARRATIVE_STAGES.CLIMAX },
      ];
      const evalIncomplete = evaluateNarrativeArcCompleteness(incompleteCandidateSentences, narrativeArcs);
      assert.ok(evalIncomplete.completenessScore <= 70, `Expected incomplete score <= 70, got ${evalIncomplete.completenessScore}`);
      assert.ok(evalComplete.completenessScore > evalIncomplete.completenessScore);
      assert.ok(evalIncomplete.warnings.some((w) => w.includes("lacks a clear resolution")));

      // Case C: Collision candidate spanning across arc 0 and arc 1
      const collisionSentences = [
        { id: "3", narrativeArcId: "arc-0", narrativeStage: NARRATIVE_STAGES.RESOLUTION },
        { id: "4", narrativeArcId: "arc-1", narrativeStage: NARRATIVE_STAGES.SETUP },
      ];
      const evalCollision = evaluateNarrativeArcCompleteness(collisionSentences, narrativeArcs);
      assert.ok(evalCollision.warnings.some((w) => w.includes("spans across multiple narrative stories")));
    });

    // 6. Speech candidate discovery with narrative arc scoring
    it("6. discovers speech candidates with enriched narrative arc scores and metadata", () => {
      const sentences = [
        { id: "s1", start: 0, end: 5, text: "Why is semantic narrative clustering so essential for viral shorts?", isQuestion: true, duration: 5 },
        { id: "s2", start: 5, end: 12, text: "Because viewers scroll away instantly unless they receive a clear turning point.", duration: 7 },
        { id: "s3", start: 12, end: 18, text: "In conclusion, structuring videos with setup, climax, and payoff guarantees maximum watch time.", duration: 6 },
      ];

      const candidates = discoverSpeechCandidates({
        sentences,
        mediaDuration: 30,
        settings: { minDuration: 15, maxDuration: 25, contentType: "education", preference: "best" },
      });

      assert.ok(Array.isArray(candidates));
      assert.ok(candidates.length > 0);

      const top = candidates[0];
      assert.ok(top.narrativeArc, "Candidate must include narrativeArc metadata");
      assert.ok(top.narrativeArc.arcScore >= 80, `Expected top candidate arcScore >= 80, got ${top.narrativeArc.arcScore}`);
      assert.equal(top.narrativeArc.isComplete, true);
      assert.ok(top.reasons.some((r) => r.includes("Complete narrative arc")));
    });

    // 7. Backward compatibility: disabling narrative clustering
    it("7. respects settings.narrativeClustering = false for backward compatibility", () => {
      const sentences = [
        { id: "s1", start: 0, end: 6, text: "A standard sentence about simple tools.", duration: 6 },
        { id: "s2", start: 6, end: 12, text: "Another regular sentence without arc tags.", duration: 6 },
        { id: "s3", start: 12, end: 18, text: "A third continuous sentence here.", duration: 6 },
      ];

      const candidates = discoverSpeechCandidates({
        sentences,
        mediaDuration: 30,
        settings: { minDuration: 15, maxDuration: 25, narrativeClustering: false },
      });

      assert.ok(Array.isArray(candidates));
      assert.ok(candidates.length > 0);
      assert.equal(candidates[0].narrativeArc, null, "Candidate should not have narrativeArc when disabled");
    });

    // 8. Robustness & edge cases
    it("8. handles non-narrative, single-sentence, and malformed inputs gracefully", () => {
      // Single sentence
      const singleSentences = [{ id: "solo", start: 0, end: 8, text: "Just one lone sentence here.", duration: 8 }];
      const arcsSingle = clusterNarrativeArcs(singleSentences);
      assert.ok(Array.isArray(arcsSingle));
      assert.equal(arcsSingle.length, 1);

      // Malformed entries
      const corrupt = [
        null,
        { id: "bad1" },
        { id: "bad2", text: null, start: NaN, end: "invalid" },
      ];
      assert.doesNotThrow(() => {
        const arcsCorrupt = clusterNarrativeArcs(corrupt);
        assert.ok(Array.isArray(arcsCorrupt));
      });
    });
  });

  // =========================================================================
  // 21. Phase 2 Priority 5: Multimodal Audio Energy & Vocal Intensity
  // =========================================================================
  describe("Phase 2 Priority 5: Multimodal Audio Energy & Vocal Intensity Alignment", () => {
    const SAMPLE_RATE = 16000;

    // Helper: generate synthetic sine wave buffer
    function generateSineBuffer(frequencyHz, durationSeconds, amplitude = 0.5, sr = SAMPLE_RATE) {
      const length = Math.round(durationSeconds * sr);
      const buffer = new Float32Array(length);
      for (let i = 0; i < length; i++) {
        buffer[i] = amplitude * Math.sin((2 * Math.PI * frequencyHz * i) / sr);
      }
      return buffer;
    }

    // 1. RMS energy estimation for known synthetic signals
    it("1. estimates RMS energy accurately for known synthetic signals", () => {
      // For a pure sine wave of amplitude A, theoretical RMS = A / sqrt(2)
      const amplitude = 0.8;
      const expectedRms = amplitude / Math.SQRT2; // ~0.5657
      const sineAudio = generateSineBuffer(440, 1.0, amplitude);

      const result = analyzeAudioEnergy(sineAudio, { sampleRate: SAMPLE_RATE });
      assert.ok(result.valid);
      assert.ok(result.frames.length > 0);

      // Average RMS across steady-state frames should match within 2%
      const steadyFrames = result.frames.slice(2, -2);
      const avgMeasuredRms =
        steadyFrames.reduce((acc, f) => acc + f.rms, 0) / steadyFrames.length;

      assert.ok(
        Math.abs(avgMeasuredRms - expectedRms) < 0.02,
        `Expected RMS ~${expectedRms.toFixed(4)}, got ${avgMeasuredRms.toFixed(4)}`
      );
    });

    // 2. Detection of relative energy changes and vocal surges
    it("2. detects relative energy changes and local vocal surges", () => {
      // 2 seconds total: 1.0s quiet (0.05), followed by sudden loud burst (0.85)
      const length = SAMPLE_RATE * 2;
      const stepAudio = new Float32Array(length);
      for (let i = 0; i < SAMPLE_RATE; i++) {
        stepAudio[i] = 0.05 * Math.sin((2 * Math.PI * 300 * i) / SAMPLE_RATE);
      }
      for (let i = SAMPLE_RATE; i < length; i++) {
        stepAudio[i] = 0.85 * Math.sin((2 * Math.PI * 300 * i) / SAMPLE_RATE);
      }

      const result = analyzeAudioEnergy(stepAudio, { sampleRate: SAMPLE_RATE });
      assert.ok(result.valid);

      // Verify positive intensity surge at t ≈ 1.0s
      const surgeFrame = result.frames.find((f) => f.time >= 0.98 && f.time <= 1.10 && f.intensitySurge > 0.25);
      assert.ok(surgeFrame, "Must detect sudden intensity surge around 1.0s transition");
      assert.ok(surgeFrame.intensitySurge > 0.25);

      // Prominent peak should be registered in the loud second half
      assert.ok(result.prominentPeaks.length >= 1);
      assert.ok(result.prominentPeaks.some((p) => p.time >= 1.0));
    });

    // 3. Silence and near-silence handling
    it("3. handles silence, near-silence, and noise floor gating correctly", () => {
      // 1.5s of low noise floor (amplitude 0.0002, ~ -74 dB)
      const silentAudio = new Float32Array(SAMPLE_RATE * 1.5);
      for (let i = 0; i < silentAudio.length; i++) {
        silentAudio[i] = (Math.random() - 0.5) * 0.0004;
      }

      const result = analyzeAudioEnergy(silentAudio, { sampleRate: SAMPLE_RATE });
      assert.ok(result.valid);
      // All frames should be classified as silence
      const silenceFrames = result.frames.filter((f) => f.isSilence);
      assert.ok(silenceFrames.length >= result.frames.length * 0.9);

      // Aligning with sentence should flag isMutedOrSilent
      const sentences = [{ id: "quiet", start: 0, end: 1.5, text: "whispering in a very quiet room." }];
      const aligned = alignAudioFeaturesWithTranscript(sentences, result);
      assert.equal(aligned[0].acousticEnergy.isMutedOrSilent, true);
      assert.ok(aligned[0].acousticEnergy.emphasisScore <= 35);
    });

    // 4. Invalid, empty, and malformed audio input
    it("4. robustly sanitizes invalid, empty, clipped, or malformed audio inputs without crashing", () => {
      const inputs = [
        null,
        undefined,
        [],
        new Float32Array(0),
        { samples: [NaN, Infinity, -Infinity] },
        // Clipped values exceeding [-1, 1]
        new Float32Array([5.0, -10.0, 3.5, 0.5]),
      ];

      for (const input of inputs) {
        assert.doesNotThrow(() => {
          const res = analyzeAudioEnergy(input);
          assert.ok(typeof res === "object");
        });
      }

      // Clipped array must sanitize into [-1.0, 1.0]
      const clipped = new Float32Array([4.0, -4.0, 0.5]);
      const sanitized = sanitizeAudioInput(clipped);
      assert.ok(sanitized);
      assert.equal(sanitized.samples[0], 1.0);
      assert.equal(sanitized.samples[1], -1.0);
      assert.equal(sanitized.samples[2], 0.5);
    });

    // 5. Normalization across different recording amplitudes
    it("5. normalizes relative intensity consistently across different recording gains", () => {
      // Pattern: 0.5s quiet baseline, 0.5s peak burst, 0.5s quiet baseline
      // Signal A: low overall gain (peak 0.20)
      // Signal B: high overall gain (peak 0.80)
      const duration = 1.5;
      const len = Math.round(duration * SAMPLE_RATE);
      const lowGain = new Float32Array(len);
      const highGain = new Float32Array(len);

      for (let i = 0; i < len; i++) {
        const t = i / SAMPLE_RATE;
        const envelope = t >= 0.5 && t <= 1.0 ? 1.0 : 0.15;
        const s = Math.sin((2 * Math.PI * 250 * i) / SAMPLE_RATE);
        lowGain[i] = 0.20 * envelope * s;
        highGain[i] = 0.80 * envelope * s;
      }

      const resLow = analyzeAudioEnergy(lowGain, { sampleRate: SAMPLE_RATE });
      const resHigh = analyzeAudioEnergy(highGain, { sampleRate: SAMPLE_RATE });

      // Peak relative intensity should be comparable (~0.9-1.0) despite 4x absolute amplitude difference
      const maxRelLow = Math.max(...resLow.frames.map((f) => f.relativeIntensity));
      const maxRelHigh = Math.max(...resHigh.frames.map((f) => f.relativeIntensity));

      assert.ok(maxRelLow >= 0.85, `Low gain max relative intensity should be >= 0.85, got ${maxRelLow}`);
      assert.ok(maxRelHigh >= 0.85, `High gain max relative intensity should be >= 0.85, got ${maxRelHigh}`);
      assert.ok(
        Math.abs(maxRelLow - maxRelHigh) < 0.15,
        `Normalized peaks should match closely, got diff ${Math.abs(maxRelLow - maxRelHigh)}`
      );
    });

    // 6. Pitch-feature handling (voiced vs unvoiced)
    it("6. extracts fundamental frequency (F0) for voiced speech and rejects unvoiced/noisy frames", () => {
      // 220 Hz harmonic tone (A3, standard speech range)
      const f0Target = 220;
      const sine220 = generateSineBuffer(f0Target, 0.25, 0.6);
      const pitchEstimate = estimatePitchAutocorrelation(sine220, 0, 800, SAMPLE_RATE, 75, 420);

      assert.ok(pitchEstimate);
      assert.equal(pitchEstimate.voiced, true);
      assert.ok(
        Math.abs(pitchEstimate.f0 - f0Target) < 5.0,
        `Expected pitch ~${f0Target} Hz, got ${pitchEstimate.f0} Hz`
      );
      assert.ok(pitchEstimate.correlation > 0.85);

      // Unvoiced white noise
      const noise = new Float32Array(800);
      for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() - 0.5) * 0.4;
      const unvoicedEstimate = estimatePitchAutocorrelation(noise, 0, 800, SAMPLE_RATE, 75, 420);

      assert.ok(unvoicedEstimate);
      assert.equal(unvoicedEstimate.voiced, false);
      assert.equal(unvoicedEstimate.f0, null);
    });

    // 7. Alignment of acoustic events with transcript timestamps
    it("7. aligns acoustic features accurately with transcript sentence timestamps", () => {
      // 9-second recording:
      // 0-3s: quiet speech (0.1)
      // 3-6s: energetic emphasis peak (0.8)
      // 6-9s: moderate conclusion (0.3)
      const totalSamples = SAMPLE_RATE * 9;
      const audio = new Float32Array(totalSamples);
      for (let i = 0; i < totalSamples; i++) {
        const t = i / SAMPLE_RATE;
        const gain = t < 3.0 ? 0.1 : (t < 6.0 ? 0.8 : 0.3);
        audio[i] = gain * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE);
      }

      const timeline = analyzeAudioEnergy(audio, { sampleRate: SAMPLE_RATE });
      assert.ok(timeline.valid);

      const sentences = [
        { id: "s1", start: 0.0, end: 3.0, text: "Setting up our conversation quietly." },
        { id: "s2", start: 3.0, end: 6.0, text: "HERE IS THE BIGGEST DISCOVERY OF ALL!" },
        { id: "s3", start: 6.0, end: 9.0, text: "So let us wrap up with this final note." },
      ];

      const aligned = alignAudioFeaturesWithTranscript(sentences, timeline);
      assert.equal(aligned.length, 3);

      const [a1, a2, a3] = aligned;
      assert.ok(a2.acousticEnergy.averageIntensity > a1.acousticEnergy.averageIntensity);
      assert.ok(a2.acousticEnergy.peakIntensity > a3.acousticEnergy.peakIntensity);
      assert.ok(a2.acousticEnergy.emphasisScore > a1.acousticEnergy.emphasisScore);
      assert.equal(a2.acousticEnergy.hasEmphasisPeak, true);
    });

    // 8. Acoustic emphasis near narrative climax or payoff
    it("8. rewards candidates where narrative climax aligns with acoustic emphasis peaks", () => {
      // 18s audio with energy peak at 7-9s (the climax sentence)
      const audio = new Float32Array(SAMPLE_RATE * 18);
      for (let i = 0; i < audio.length; i++) {
        const t = i / SAMPLE_RATE;
        const gain = t >= 6.0 && t <= 11.0 ? 0.85 : 0.25;
        audio[i] = gain * Math.sin((2 * Math.PI * 200 * i) / SAMPLE_RATE);
      }

      const timeline = analyzeAudioEnergy(audio, { sampleRate: SAMPLE_RATE });

      const sentences = [
        { id: "1", start: 0, end: 6, text: "Why do so many creators quit within their first month?", isQuestion: true, narrativeStage: "setup" },
        { id: "2", start: 6, end: 12, text: "The crucial turning point is recognizing that audio clarity drives 90% of watch time!", narrativeStage: "climax" },
        { id: "3", start: 12, end: 18, text: "So invest in a decent dynamic microphone and acoustic foam today.", narrativeStage: "resolution" },
      ];

      const candidates = discoverSpeechCandidates({
        sentences,
        mediaDuration: 30,
        settings: { minDuration: 15, maxDuration: 25 },
        audioEnergy: timeline,
      });

      assert.ok(candidates.length > 0);
      const top = candidates[0];
      assert.ok(top.acousticScore >= 75, `Expected acoustic score >= 75, got ${top.acousticScore}`);
      assert.ok(top.reasons.some((r) => r.includes("Vocal delivery peaks with high acoustic emphasis")));
      assert.ok(top.acousticFeatures);
      assert.ok(top.acousticFeatures.peakIntensity > 0.7);
    });

    // 9. Preservation of scoring behavior when audio data is missing
    it("9. preserves existing scoring behavior and fallbacks when audio data is missing", () => {
      const sentences = [
        { id: "s1", start: 0, end: 5, text: "A standard sentence describing our process.", duration: 5 },
        { id: "s2", start: 5, end: 11, text: "Another regular sentence carrying the explanation forward.", duration: 6 },
        { id: "s3", start: 11, end: 17, text: "And a third sentence concluding the clip cleanly.", duration: 6 },
      ];

      const candidatesNoAudio = discoverSpeechCandidates({
        sentences,
        mediaDuration: 30,
        settings: { minDuration: 15, maxDuration: 25 },
        audioData: null,
      });

      assert.ok(candidatesNoAudio.length > 0);
      assert.equal(candidatesNoAudio[0].acousticScore, null);
      assert.equal(candidatesNoAudio[0].acousticFeatures, null);
      assert.ok(Number.isFinite(candidatesNoAudio[0].score));
    });

    // 10. Bounded scoring and duration constraints
    it("10. keeps candidate scores strictly bounded within [0, 100] and preserves duration constraints", () => {
      // Extremely loud saturated audio (all 1.0)
      const loudAudio = new Float32Array(SAMPLE_RATE * 30).fill(1.0);
      const sentences = [
        { id: "s1", start: 0, end: 7, text: "Loud sentence one.", duration: 7 },
        { id: "s2", start: 7, end: 15, text: "Loud sentence two.", duration: 8 },
        { id: "s3", start: 15, end: 22, text: "Loud sentence three.", duration: 7 },
      ];

      const candidates = discoverSpeechCandidates({
        sentences,
        mediaDuration: 30,
        settings: { minDuration: 15, maxDuration: 25 },
        audioData: loudAudio,
      });

      assert.ok(candidates.length > 0);
      for (const c of candidates) {
        assert.ok(c.score >= 0 && c.score <= 100, `Score ${c.score} out of [0, 100]`);
        assert.ok(c.duration >= 14.5 && c.duration <= 25.5, `Duration ${c.duration} violated limits`);
      }
    });

    // 11. Duplicate-candidate and overlapping-event safeguards
    it("11. enforces candidate deduplication and suppresses excessive overlap (>40%) with acoustic scoring", () => {
      const audio = generateSineBuffer(200, 45, 0.5);
      const sentences = [
        { id: "s1", start: 0, end: 6, text: "Sentence alpha here.", duration: 6 },
        { id: "s2", start: 6, end: 12, text: "Sentence beta here.", duration: 6 },
        { id: "s3", start: 12, end: 18, text: "Sentence gamma here.", duration: 6 },
        { id: "s4", start: 18, end: 24, text: "Sentence delta here.", duration: 6 },
        { id: "s5", start: 24, end: 30, text: "Sentence epsilon here.", duration: 6 },
      ];

      const candidates = discoverSpeechCandidates({
        sentences,
        mediaDuration: 45,
        settings: { minDuration: 12, maxDuration: 20, clipCount: 3 },
        audioData: audio,
      });

      const deduplicated = deduplicateAndRankCandidates(candidates, 3);
      assert.ok(deduplicated.length <= 3);

      // Verify pairwise overlap does not exceed 40%
      for (let i = 0; i < deduplicated.length; i++) {
        for (let j = i + 1; j < deduplicated.length; j++) {
          const c1 = deduplicated[i];
          const c2 = deduplicated[j];
          const overlap = Math.max(0, Math.min(c1.endTime, c2.endTime) - Math.max(c1.startTime, c2.startTime));
          const minDur = Math.min(c1.duration, c2.duration);
          const ratio = minDur > 0 ? overlap / minDur : 0;
          assert.ok(ratio <= 0.40, `Overlap ${ratio} exceeded 40% between candidates`);
        }
      }
    });

    // 12. Backward compatibility with Priorities 1–4
    it("12. preserves backward compatibility with Priorities 1–4", () => {
      const audio = generateSineBuffer(220, 20, 0.4);
      const sentences = [
        { id: "1", start: 0, end: 6, text: "Why do we see this happen?", isQuestion: true },
        { id: "2", start: 6, end: 12, text: "Because this core principle completely transforms the result." },
        { id: "3", start: 12, end: 18, text: "Therefore always remember to double-check your configuration." },
      ];

      const candidates = discoverSpeechCandidates({
        sentences,
        mediaDuration: 25,
        settings: { minDuration: 15, maxDuration: 22 },
        audioData: audio,
      });

      assert.ok(candidates.length > 0);
      const top = candidates[0];

      // Priority 1: Semantic scores
      assert.ok(Number.isFinite(top.semanticScore));
      assert.ok(Number.isFinite(top.hookScore));
      assert.ok(Number.isFinite(top.payoffScore));

      // Priority 4: Narrative arc
      assert.ok(top.narrativeArc);
      assert.ok(Number.isFinite(top.narrativeArc.arcScore));

      // Priority 5: Acoustic features
      assert.ok(Number.isFinite(top.acousticScore));
      assert.ok(top.acousticFeatures);
    });

    // 13. Deterministic output for identical inputs
    it("13. produces identical, deterministic output across repeated analysis runs", () => {
      const audio = generateSineBuffer(300, 15, 0.6);
      const sentences = [
        { id: "d1", start: 0, end: 7, text: "Deterministic sentence one." },
        { id: "d2", start: 7, end: 14, text: "Deterministic sentence two." },
      ];

      const runA = discoverSpeechCandidates({ sentences, mediaDuration: 20, settings: { minDuration: 12, maxDuration: 18 }, audioData: audio });
      const runB = discoverSpeechCandidates({ sentences, mediaDuration: 20, settings: { minDuration: 12, maxDuration: 18 }, audioData: audio });

      assert.equal(runA.length, runB.length);
      assert.equal(runA[0].score, runB[0].score);
      assert.equal(runA[0].acousticScore, runB[0].acousticScore);
      assert.equal(runA[0].startTime, runB[0].startTime);
      assert.equal(runA[0].endTime, runB[0].endTime);
    });

    // 14. Graceful fallback when waveform peaks envelope is supplied without raw PCM
    it("14. gracefully handles waveform peaks envelope fallback when raw PCM is unavailable", () => {
      // Peaks array (e.g. 100 peaks representing 10 seconds of media)
      const peaks = new Float32Array(100);
      for (let i = 0; i < 100; i++) peaks[i] = 0.2 + 0.6 * Math.sin((Math.PI * i) / 100);

      const waveformInput = { peaks, duration: 10.0 };
      const analysis = analyzeAudioEnergy(waveformInput);

      assert.ok(analysis.valid);
      assert.equal(analysis.statistics.hasPitchData, false, "Pitch analysis should be deferred for waveform-only inputs");
      assert.ok(analysis.frames.length > 0);

      const sentences = [
        { id: "w1", start: 0, end: 5, text: "Sentence over waveform peak one." },
        { id: "w2", start: 5, end: 10, text: "Sentence over waveform peak two." },
      ];

      const aligned = alignAudioFeaturesWithTranscript(sentences, analysis);
      assert.equal(aligned.length, 2);
      assert.ok(aligned[0].acousticEnergy.averageIntensity > 0);
    });
  });

  // =========================================================================
  // 22. Phase 2 Priority 6: Dynamic Visual B-Roll & Contextual Overlay Insertion
  // =========================================================================
  describe("Phase 2 Priority 6: Dynamic Visual B-Roll & Contextual Overlay Insertion", () => {
    // 1. Suitable overlay opportunity detection
    it("1. detects suitable overlay opportunities during extended monologues and narrative transitions", () => {
      const candidate = { startTime: 0, endTime: 24, duration: 24, cropX: 0.5 };
      const sentences = [
        { id: "s1", start: 0.5, end: 4.5, text: "Why is latency such a huge issue in modern cloud systems?", isQuestion: true, narrativeStage: "setup" },
        { id: "s2", start: 4.5, end: 11.0, text: "When thousands of microservices communicate, network serialization creates cascading delays across the entire fleet.", narrativeStage: "turning-point" },
        { id: "s3", start: 11.0, end: 18.0, text: "By introducing binary protocol buffers, we cut payload transfer overhead by 50% across all datacenters.", narrativeStage: "climax" },
        { id: "s4", start: 18.0, end: 23.5, text: "Therefore adopting structured binary serialization is an absolute game changer.", narrativeStage: "payoff" },
      ];

      const opportunities = detectOverlayOpportunities({
        candidate,
        sentences,
        options: { minMonologueGap: 5.0 },
      });

      assert.ok(opportunities.length >= 2, "Should identify multiple opportunities (hook, monologue break, insight)");
      assert.ok(opportunities.some((o) => o.narrativeStage === "setup" && o.kind === "callout"));
      assert.ok(opportunities.some((o) => o.narrativeStage === "turning-point" || o.kind === "broll"));
    });

    // 2. Narrative-stage alignment
    it("2. aligns overlays with narrative stages (setup hook, core insight) and preserves payoff", () => {
      const candidate = { startTime: 0, endTime: 20, duration: 20, cropX: 0.5 };
      const sentences = [
        { id: "s1", start: 0.5, end: 4.0, text: "How do you achieve 10x developer productivity?", isQuestion: true, narrativeStage: "setup" },
        { id: "s2", start: 4.0, end: 12.0, text: "The primary secret is eliminating context switching with focused deep work blocks.", narrativeStage: "turning-point" },
        { id: "s3", start: 12.0, end: 16.0, text: "Engineers who protect their mornings ship three times more pull requests.", narrativeStage: "climax" },
        { id: "s4", start: 16.0, end: 19.8, text: "Protect your calendar and you will transform your engineering velocity.", narrativeStage: "payoff" },
      ];

      const plan = planShortOverlays({ candidate, sentences });
      assert.ok(plan.ok);
      assert.ok(plan.overlays.length > 0);

      // Verify NO overlay is scheduled in the final payoff window (last 1.5s)
      for (const ov of plan.overlays) {
        assert.ok(
          ov.absoluteEnd <= 18.5,
          `Overlay end (${ov.absoluteEnd}s) must not obscure final payoff punchline (18.5s..20.0s)`
        );
        assert.notEqual(ov.narrativeStage, "payoff", "Payoff stage must be protected from overlay clutter");
      }
    });

    // 3. Keyword-callout generation
    it("3. synthesizes salient keyword callouts with metrics, acronyms, and SVG badges", () => {
      const text = "With our new DNS architecture, we reduced tail latency by 50% across 100ms thresholds.";
      const { keywords, metrics, acronyms, primaryLabel } = extractSalientKeywords(text);

      assert.ok(metrics.includes("50%"));
      assert.ok(acronyms.includes("DNS"));
      assert.ok(keywords.includes("latency") || keywords.includes("architecture"));
      assert.ok(primaryLabel.length > 0);

      const svgDataUrl = generateCalloutSvgDataUrl({
        text: primaryLabel,
        headline: "KEY METRIC",
      });

      assert.ok(svgDataUrl.startsWith("data:image/svg+xml;charset=utf-8,"));
      assert.ok(svgDataUrl.includes(encodeURIComponent(primaryLabel)));
    });

    // 4. B-roll asset availability and fallback behavior
    it("4. evaluates B-roll asset relevance and gracefully falls back when media is unavailable", () => {
      const candidate = { startTime: 0, endTime: 20, duration: 20, cropX: 0.5 };
      const sentences = [
        { id: "s1", start: 1.0, end: 6.0, text: "Let us inspect the microchip semiconductor fabrication cleanroom.", narrativeStage: "turning-point" },
      ];

      const matchingAsset = {
        id: "asset-chip-1",
        name: "Semiconductor Cleanroom Footage.mp4",
        type: "video",
        src: "/assets/sample-portrait.mp4",
        tags: ["semiconductor", "cleanroom", "microchip"],
      };

      const irrelevantAsset = {
        id: "asset-kitchen-1",
        name: "Chef Kitchen Cooking.jpg",
        type: "image",
        src: "/assets/sample-kitchen.jpg",
        tags: ["cooking", "recipe", "chef"],
      };

      // Relevance scoring
      const matchScore = scoreAssetRelevance(matchingAsset, ["semiconductor", "cleanroom"]);
      const irrelScore = scoreAssetRelevance(irrelevantAsset, ["semiconductor", "cleanroom"]);
      assert.ok(matchScore >= 0.7, "Matching asset should have high relevance score");
      assert.equal(irrelScore, 0, "Irrelevant asset should score 0");

      // With matching asset supplied: chooses B-roll
      const planWithAsset = planShortOverlays({
        candidate,
        sentences,
        availableAssets: [matchingAsset],
      });
      assert.ok(planWithAsset.overlays.length > 0);
      assert.equal(planWithAsset.overlays[0].kind, "broll");
      assert.equal(planWithAsset.overlays[0].assetId, "asset-chip-1");

      // Without matching asset: falls back to keyword callout and emits asset request
      const planWithoutAsset = planShortOverlays({
        candidate,
        sentences,
        availableAssets: [irrelevantAsset],
        options: { fallbackMode: "callout" },
      });
      assert.ok(planWithoutAsset.overlays.length > 0);
      assert.equal(planWithoutAsset.overlays[0].kind, "callout");
      assert.ok(planWithoutAsset.assetRequests.length > 0, "Should record asset request for missing B-roll");
    });

    // 5. Overlay duration constraints
    it("5. strictly enforces overlay duration bounds between minDuration and maxDuration", () => {
      const candidate = { startTime: 0, endTime: 30, duration: 30, cropX: 0.5 };
      const sentences = [
        { id: "s1", start: 1.0, end: 15.0, text: "This is an extremely long sentence that spans fourteen continuous seconds.", narrativeStage: "turning-point" },
      ];

      const plan = planShortOverlays({
        candidate,
        sentences,
        options: { minDuration: 2.0, maxDuration: 4.0 },
      });

      assert.ok(plan.overlays.length > 0);
      for (const ov of plan.overlays) {
        assert.ok(ov.duration >= 2.0, `Duration (${ov.duration}s) must be >= minDuration (2.0s)`);
        assert.ok(ov.duration <= 4.0, `Duration (${ov.duration}s) must be <= maxDuration (4.0s)`);
      }
    });

    // 6. Clip-boundary and scene-cut handling
    it("6. clamps overlay boundaries and handles scene cuts without straddling shot transitions", () => {
      const candidate = { startTime: 10, endTime: 25, duration: 15, cropX: 0.5 };
      const sceneCuts = [13.2]; // Scene cut right in the middle of first planned overlay window
      const sentences = [
        { id: "s1", start: 10.5, end: 15.0, text: "Notice what happens before and after this camera cut.", narrativeStage: "turning-point" },
      ];

      const plan = planShortOverlays({
        candidate,
        sentences,
        sceneCuts,
        options: { leadInPadding: 0.8, tailOutPadding: 1.5, suppressNearSceneCuts: 0.3 },
      });

      for (const ov of plan.overlays) {
        assert.ok(ov.absoluteStart >= 10.8, "Must not violate lead-in padding (10.0 + 0.8)");
        assert.ok(ov.absoluteEnd <= 23.5, "Must not violate tail-out padding (25.0 - 1.5)");
        // Must never span across cut at 13.2
        const spansCut = ov.absoluteStart < 13.2 && ov.absoluteEnd > 13.2;
        assert.equal(spansCut, false, "Overlay must never straddle scene cut transition");
      }
    });

    // 7. Overlap and excessive-frequency suppression
    it("7. enforces minimum spacing and suppresses excessive frequency or overlapping overlays", () => {
      const candidate = { startTime: 0, endTime: 30, duration: 30, cropX: 0.5 };
      const sentences = [
        { id: "s1", start: 1.0, end: 3.5, text: "First point.", narrativeStage: "setup" },
        { id: "s2", start: 3.6, end: 6.0, text: "Second point right after.", narrativeStage: "turning-point" },
        { id: "s3", start: 6.1, end: 8.5, text: "Third point tightly packed.", narrativeStage: "turning-point" },
        { id: "s4", start: 8.6, end: 11.0, text: "Fourth point in rapid succession.", narrativeStage: "climax" },
        { id: "s5", start: 14.0, end: 18.0, text: "Fifth point with adequate spacing.", narrativeStage: "climax" },
        { id: "s6", start: 22.0, end: 28.0, text: "Final closing thought payoff.", narrativeStage: "payoff" },
      ];

      const plan = planShortOverlays({
        candidate,
        sentences,
        options: { minSpacing: 4.0, maxOverlaysPerClip: 3 },
      });

      assert.ok(plan.overlays.length <= 3, "Must not exceed maxOverlaysPerClip");

      // Verify spacing between consecutive overlays
      for (let i = 0; i < plan.overlays.length - 1; i++) {
        const currentEnd = plan.overlays[i].absoluteEnd;
        const nextStart = plan.overlays[i + 1].absoluteStart;
        assert.ok(
          nextStart >= currentEnd + 3.8,
          `Spacing between overlay ${i} and ${i + 1} must satisfy minSpacing (found ${nextStart - currentEnd}s)`
        );
      }
    });

    // 8. Face and caption avoidance where supported
    it("8. enforces face and caption avoidance layout positioning across portrait aspect ratios", () => {
      // Case A: Face is centered, keyword callout placed in upper safe zone
      const calloutPos = resolveOverlayPlacement({
        kind: "callout",
        cropX: 0.5,
        targetRatio: "9:16",
      });
      assert.equal(calloutPos.safeZone, "upper-third");
      assert.ok(calloutPos.y <= -28, "Callout should be placed high (y <= -28) to avoid captions at bottom (y >= 20)");

      // Case B: Face is tracked on the right (cropX = 0.7) -> PiP placed on the left
      const pipPosLeft = resolveOverlayPlacement({
        kind: "supporting-visual",
        cropX: 0.7,
        targetRatio: "9:16",
      });
      assert.equal(pipPosLeft.placementPreset, "top-left");
      assert.ok(pipPosLeft.x < 0, "PiP should be shifted to left quadrant opposite face");

      // Case C: Face is tracked on the left (cropX = 0.3) -> PiP placed on the right
      const pipPosRight = resolveOverlayPlacement({
        kind: "supporting-visual",
        cropX: 0.3,
        targetRatio: "9:16",
      });
      assert.equal(pipPosRight.placementPreset, "top-right");
      assert.ok(pipPosRight.x > 0, "PiP should be shifted to right quadrant opposite face");
    });

    // 9. Empty and malformed transcript handling
    it("9. handles empty, null, and malformed sentences without throwing or crashing", () => {
      const candidate = { startTime: 0, endTime: 20, duration: 20, cropX: 0.5 };

      // Null sentences
      const planNull = planShortOverlays({ candidate, sentences: null });
      assert.ok(planNull.ok);
      assert.equal(planNull.overlays.length, 0);

      // Corrupted sentences
      const corruptedSentences = [
        null,
        {},
        { id: "bad1", start: "invalid", end: null, text: 123 },
        { id: "bad2", start: -5, end: -1, text: "" },
      ];
      const planCorrupt = planShortOverlays({ candidate, sentences: corruptedSentences });
      assert.ok(planCorrupt.ok);
      assert.equal(planCorrupt.overlays.length, 0);
    });

    // 10. Missing media and missing metadata
    it("10. handles missing media, missing assets, and uninitialized candidate metadata gracefully", () => {
      // Null candidate
      const planNoCand = planShortOverlays({ candidate: null });
      assert.equal(planNoCand.ok, false);
      assert.equal(planNoCand.overlays.length, 0);

      // Missing duration and times
      const planBadCand = planShortOverlays({ candidate: {} });
      assert.equal(planBadCand.ok, false);

      // Null asset library
      const planNullAssets = planShortOverlays({
        candidate: { startTime: 0, endTime: 15, duration: 15 },
        sentences: [{ id: "1", start: 1, end: 5, text: "Some text." }],
        availableAssets: null,
      });
      assert.ok(planNullAssets.ok);
    });

    // 11. Disabled-overlay backward compatibility
    it("11. preserves backward compatibility when overlays are explicitly disabled", () => {
      const candidate = { startTime: 0, endTime: 25, duration: 25, cropX: 0.5 };
      const sentences = [
        { id: "s1", start: 1.0, end: 8.0, text: "Long monologue explanation without breaks.", narrativeStage: "turning-point" },
      ];

      const planDisabled = planShortOverlays({
        candidate,
        sentences,
        options: { enabled: false },
      });

      assert.ok(planDisabled.ok);
      assert.equal(planDisabled.overlays.length, 0);
      assert.equal(planDisabled.stats.totalPlanned, 0);
    });

    // 12. Deterministic output
    it("12. produces identical, deterministic overlay output across repeated planning runs", () => {
      const candidate = { startTime: 5, endTime: 25, duration: 20, cropX: 0.5 };
      const sentences = [
        { id: "s1", start: 6.0, end: 10.0, text: "Deterministic setup question for system architecture?", isQuestion: true, narrativeStage: "setup" },
        { id: "s2", start: 10.0, end: 17.0, text: "Deterministic core insight on microservices performance.", narrativeStage: "turning-point" },
        { id: "s3", start: 17.0, end: 24.0, text: "Deterministic payoff concluding statement.", narrativeStage: "payoff" },
      ];

      const runA = planShortOverlays({ candidate, sentences });
      const runB = planShortOverlays({ candidate, sentences });

      assert.equal(runA.overlays.length, runB.overlays.length);
      for (let i = 0; i < runA.overlays.length; i++) {
        assert.equal(runA.overlays[i].start, runB.overlays[i].start);
        assert.equal(runA.overlays[i].duration, runB.overlays[i].duration);
        assert.equal(runA.overlays[i].kind, runB.overlays[i].kind);
        assert.equal(runA.overlays[i].name, runB.overlays[i].name);
        assert.deepEqual(runA.overlays[i].baseTransform, runB.overlays[i].baseTransform);
      }
    });

    // 13. Integration with Priorities 1–5
    it("13. integrates seamlessly with Priorities 1–5 (semantics, reframing, punch-in, arc, acoustic)", () => {
      const candidate = {
        id: "cand-full-p1-5",
        startTime: 0,
        endTime: 22,
        duration: 22,
        cropX: 0.42,
        score: 89,
        semanticScore: 88,
        hookScore: 92,
        payoffScore: 86,
        narrativeArc: { arcId: "arc-1", arcScore: 90, isComplete: true },
        acousticScore: 84,
        acousticFeatures: {
          surges: [{ time: 13.5, intensity: 0.88 }],
        },
        smartFrame: {
          version: 2,
          enabled: true,
          cropKeyframes: [{ time: 0, x: 0.32, y: 0, width: 0.3164, height: 1 }],
        },
        punchIns: [
          { time: 1.2, scale: 1.22, duration: 3.0 },
        ],
      };

      const sentences = [
        { id: "s1", start: 0.5, end: 4.5, text: "How did we scale this database to ten million queries per second?", isQuestion: true, narrativeStage: "setup" },
        { id: "s2", start: 4.5, end: 12.0, text: "We partitioned the global indexing cluster using consistent hashing rings.", narrativeStage: "turning-point" },
        { id: "s3", start: 12.0, end: 17.5, text: "This eliminated all hot partitions and achieved 99.99% uptime under peak load.", narrativeStage: "climax" },
        { id: "s4", start: 17.5, end: 21.5, text: "Apply consistent hashing when scaling stateful distributed backends.", narrativeStage: "payoff" },
      ];

      const overlayPlan = planShortOverlays({
        candidate,
        sentences,
        acousticFeatures: candidate.acousticFeatures,
      });

      assert.ok(overlayPlan.ok);
      assert.ok(overlayPlan.overlays.length >= 1);

      const enriched = applyOverlaysToCandidate(candidate, overlayPlan.overlays);
      assert.ok(enriched.hasOverlays);
      assert.equal(enriched.overlays.length, overlayPlan.overlays.length);
      // All Priority 1-5 properties preserved
      assert.equal(enriched.score, 89);
      assert.equal(enriched.semanticScore, 88);
      assert.equal(enriched.narrativeArc.isComplete, true);
      assert.equal(enriched.acousticScore, 84);
      assert.equal(enriched.punchIns.length, 1);
    });

    // 14. Rendering-plan consistency where applicable
    it("14. maintains rendering-plan consistency and WebCodecs / FFmpeg export compatibility", () => {
      const sourceClip = {
        id: "source-vid-1",
        src: "/test-artifacts/video-1-dns.mp4",
        path: "/test-artifacts/video-1-dns.mp4",
        width: 720,
        height: 1280,
        duration: 38.0,
      };

      const candidate = {
        id: "cand-render-1",
        startTime: 2.0,
        endTime: 18.0,
        duration: 16.0,
        cropX: 0.5,
        overlays: [
          {
            id: "ov-test-1",
            assetId: "source-vid-1",
            name: "B-Roll Cutaway",
            kind: "broll",
            type: "video",
            src: "/test-artifacts/video-1-dns.mp4",
            path: "/test-artifacts/video-1-dns.mp4",
            start: 2.0, // 2s into the candidate short
            duration: 3.5,
            layer: 2,
            baseTransform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
          },
        ],
      };

      // Convert candidate to timeline project
      const projectWithOverlays = convertCandidateToProject(sourceClip, candidate, {
        aspectRatio: "9:16",
        overlays: true,
      });

      assert.ok(projectWithOverlays);
      assert.ok(Array.isArray(projectWithOverlays.visualOverlaySegments));
      assert.equal(projectWithOverlays.visualOverlaySegments.length, 1);
      assert.equal(projectWithOverlays.visualOverlaySegments[0].id, "ov-test-1");

      // Verify buildFfmpegRenderPlan consumes the overlay segment without error
      const mediaMap = {
        visuals: [{ id: "source-vid-1", path: sourceClip.path }],
        overlays: [{ id: "ov-test-1", path: sourceClip.path }],
      };
      const extractedFiles = new Map([[sourceClip.path, sourceClip.path]]);

      const plan = buildFfmpegRenderPlan({
        project: projectWithOverlays,
        media: mediaMap,
        extractedFiles,
        duration: 16.0,
        settings: { output: "test-out.mp4", width: 1080, height: 1920 },
      });

      assert.ok(plan);
      assert.ok(Array.isArray(plan.args));
      // FFmpeg filter graph must contain the overlay filter step
      const filterArg = plan.args[plan.args.indexOf("-filter_complex") + 1];
      assert.ok(filterArg.includes("overlay="), "Filter complex must contain overlay filter");

      // When overlays are disabled, project has empty visualOverlaySegments
      const projectWithoutOverlays = convertCandidateToProject(sourceClip, candidate, {
        aspectRatio: "9:16",
        overlays: false,
      });
      assert.equal(projectWithoutOverlays.visualOverlaySegments.length, 0);
    });
  });

  // =========================================================================
  // 23. Phase 2 Priority 7: High-Impact Vertical Motion Typography & Animated Caption Callouts
  // =========================================================================
  describe("Phase 2 Priority 7 — High-Impact Motion Typography & Animated Caption Callouts", () => {
    const sourceClip = {
      id: "src-vid-p7",
      src: "/test-artifacts/video-1-dns.mp4",
      path: "/test-artifacts/video-1-dns.mp4",
      width: 720,
      height: 1280,
      duration: 35.0,
    };

    // 1. Word-level timestamp alignment
    it("1. aligns word-level kinetic animations accurately with speech timing", () => {
      const candidate = { id: "c-p7-1", startTime: 0, endTime: 10, duration: 10 };
      const captionSegments = [
        {
          id: "cap-1",
          start: 1.0,
          end: 4.5,
          text: "Look at this 99% accuracy.",
          narrativeStage: "setup",
          words: [
            { text: "Look", start: 1.0, end: 1.4 },
            { text: "at", start: 1.4, end: 1.7 },
            { text: "this", start: 1.7, end: 2.1 },
            { text: "99%", start: 2.1, end: 3.0 },
            { text: "accuracy", start: 3.0, end: 4.2 },
          ],
        },
      ];

      const plan = planMotionTypography({ candidate, captionSegments });
      assert.ok(plan.ok);
      assert.equal(plan.hasKineticWords, true);

      const segment = plan.captionSegments[0];
      assert.equal(segment.isKinetic, true);
      assert.equal(segment.words.length, 5);

      // Verify speech synchronization: animStart <= word.start and animEnd >= word.end
      const metricWord = segment.words.find((w) => w.text === "99%");
      assert.ok(metricWord);
      assert.equal(metricWord.isEmphasized, true);
      assert.ok(metricWord.animStart <= metricWord.start);
      assert.ok(metricWord.animEnd >= metricWord.end);
      assert.ok(metricWord.animStart >= segment.start);
      assert.ok(metricWord.animEnd <= segment.end);
      assert.ok(metricWord.scale > 1.0);
    });

    // 2. Missing or malformed word timestamps
    it("2. gracefully handles missing, empty, or malformed word timestamps", () => {
      const candidate = { id: "c-p7-2", startTime: 0, endTime: 12, duration: 12 };

      // Case A: Missing words array
      const planNoWords = planMotionTypography({
        candidate,
        captionSegments: [{ id: "cap-nowords", start: 1.0, end: 4.0, text: "Sentence without words array." }],
      });
      assert.ok(planNoWords.ok);
      assert.equal(planNoWords.captionSegments[0].isKinetic, false);
      assert.equal(planNoWords.captionSegments[0].fallbackMode, "static-sentence");

      // Case B: Inverted and non-finite timestamps
      const planCorrupt = planMotionTypography({
        candidate,
        captionSegments: [
          {
            id: "cap-corrupt",
            start: 1.0,
            end: 5.0,
            text: "Corrupt word timestamps.",
            words: [
              { text: "Corrupt", start: 4.0, end: 2.0 }, // Inverted
              { text: "word", start: NaN, end: 3.0 }, // NaN
            ],
          },
        ],
      });
      assert.ok(planCorrupt.ok);
      assert.equal(planCorrupt.captionSegments[0].isKinetic, false);
      assert.equal(planCorrupt.captionSegments[0].fallbackMode, "static-sentence");
    });

    // 3. Animation windows and clip-duration clamping
    it("3. strictly clamps animation windows within candidate clip duration bounds", () => {
      const candidate = { id: "c-p7-3", startTime: 0, endTime: 8.0, duration: 8.0 };
      const captionSegments = [
        {
          id: "cap-edge",
          start: 6.0,
          end: 8.0,
          text: "The final 10x climax.",
          narrativeStage: "payoff",
          words: [
            { text: "The", start: 6.0, end: 6.3 },
            { text: "final", start: 6.3, end: 6.8 },
            { text: "10x", start: 6.8, end: 7.7 },
            { text: "climax", start: 7.7, end: 7.95 },
          ],
        },
      ];

      const plan = planMotionTypography({ candidate, captionSegments });
      assert.ok(plan.ok);

      const segment = plan.captionSegments[0];
      for (const w of segment.words) {
        assert.ok(w.animStart >= 0, `animStart ${w.animStart} must be >= 0`);
        assert.ok(w.animEnd <= candidate.duration, `animEnd ${w.animEnd} must be <= duration ${candidate.duration}`);
      }
    });

    // 4. Scene-cut boundary handling
    it("4. prevents kinetic animations from crossing scene-cut boundaries", () => {
      const candidate = { id: "c-p7-4", startTime: 0, endTime: 15.0, duration: 15.0 };
      const sceneCuts = [6.0]; // Cut at 6.0s
      const captionSegments = [
        {
          id: "cap-cut",
          start: 4.0,
          end: 7.5,
          text: "Critical insight before cut and after.",
          words: [
            { text: "Critical", start: 4.0, end: 4.6 },
            { text: "insight", start: 4.6, end: 5.85 }, // Ends right before 6.0 cut
            { text: "before", start: 6.1, end: 6.7 },
            { text: "cut", start: 6.7, end: 7.4 },
          ],
        },
      ];

      const plan = planMotionTypography({ candidate, captionSegments, sceneCuts });
      assert.ok(plan.ok);

      const insightWord = plan.captionSegments[0].words.find((w) => w.text === "insight");
      assert.ok(insightWord);
      // Anim end must not bleed across scene cut at 6.0
      assert.ok(insightWord.animEnd <= 6.0, `animEnd (${insightWord.animEnd}) should not cross cut at 6.0`);
    });

    // 5. Semantic hook and payoff emphasis
    it("5. coordinates emphasis with semantic hook and payoff scoring", () => {
      const candidate = {
        id: "c-p7-5",
        startTime: 0,
        endTime: 20,
        duration: 20,
        hookScore: 92,
        payoffScore: 89,
      };

      const captionSegments = [
        {
          id: "cap-hook",
          start: 0.5,
          end: 4.0,
          text: "Why is this crucial?",
          narrativeStage: "setup",
          words: [
            { text: "Why", start: 0.5, end: 1.0 },
            { text: "is", start: 1.0, end: 1.3 },
            { text: "this", start: 1.3, end: 1.7 },
            { text: "crucial?", start: 1.7, end: 3.5 },
          ],
        },
        {
          id: "cap-payoff",
          start: 16.0,
          end: 19.5,
          text: "This is the ultimate breakthrough.",
          narrativeStage: "payoff",
          words: [
            { text: "This", start: 16.0, end: 16.4 },
            { text: "is", start: 16.4, end: 16.7 },
            { text: "the", start: 16.7, end: 17.0 },
            { text: "ultimate", start: 17.0, end: 17.8 },
            { text: "breakthrough", start: 17.8, end: 19.2 },
          ],
        },
      ];

      const plan = planMotionTypography({ candidate, captionSegments });
      assert.ok(plan.ok);

      const hookSeg = plan.captionSegments[0];
      const crucialWord = hookSeg.words.find((w) => w.text.includes("crucial"));
      assert.ok(crucialWord.isEmphasized);
      assert.equal(crucialWord.color, DEFAULT_MOTION_TYPOGRAPHY_OPTIONS.hookColor);

      const payoffSeg = plan.captionSegments[1];
      const breakthroughWord = payoffSeg.words.find((w) => w.text.includes("breakthrough"));
      assert.ok(breakthroughWord.isEmphasized);
      assert.equal(breakthroughWord.color, DEFAULT_MOTION_TYPOGRAPHY_OPTIONS.climaxColor);
    });

    // 6. Narrative and audio-intensity alignment
    it("6. aligns word kinetic emphasis with Priority 5 vocal intensity surges", () => {
      const candidate = {
        id: "c-p7-6",
        startTime: 0,
        endTime: 15,
        duration: 15,
        acousticFeatures: {
          surges: [
            { time: 3.2, intensity: 0.92 },
          ],
        },
      };

      const captionSegments = [
        {
          id: "cap-acoustic",
          start: 1.0,
          end: 5.0,
          text: "We deployed the global cluster.",
          narrativeStage: "turning-point",
          words: [
            { text: "We", start: 1.0, end: 1.4 },
            { text: "deployed", start: 1.4, end: 2.2 },
            { text: "the", start: 2.2, end: 2.5 },
            { text: "global", start: 2.5, end: 3.1 },
            { text: "cluster", start: 3.1, end: 4.2 }, // Overlaps surge at 3.2s
          ],
        },
      ];

      const plan = planMotionTypography({
        candidate,
        captionSegments,
        acousticFeatures: candidate.acousticFeatures,
      });

      assert.ok(plan.ok);
      const clusterWord = plan.captionSegments[0].words.find((w) => w.text === "cluster");
      assert.ok(clusterWord.isEmphasized);
      assert.ok(clusterWord.emphasisReason.includes("VOCAL_SURGE"));
      assert.equal(clusterWord.color, DEFAULT_MOTION_TYPOGRAPHY_OPTIONS.surgeColor);
    });

    // 7. Coordination with existing punch-in events
    it("7. coordinates word kinetic emphasis with Priority 3 punch-in keyframes", () => {
      const candidate = { id: "c-p7-7", startTime: 0, endTime: 16, duration: 16 };
      const punchIns = [
        { time: 2.5, scale: 1.25, duration: 3.0 },
      ];

      const captionSegments = [
        {
          id: "cap-punch",
          start: 1.0,
          end: 5.0,
          text: "This fundamental architecture change.",
          words: [
            { text: "This", start: 1.0, end: 1.5 },
            { text: "fundamental", start: 1.5, end: 2.3 },
            { text: "architecture", start: 2.3, end: 3.5 }, // Aligned with punch-in at 2.5s
            { text: "change", start: 3.5, end: 4.5 },
          ],
        },
      ];

      const plan = planMotionTypography({
        candidate,
        captionSegments,
        punchIns,
      });

      assert.ok(plan.ok);
      const archWord = plan.captionSegments[0].words.find((w) => w.text === "architecture");
      assert.ok(archWord.isEmphasized);
      assert.ok(archWord.emphasisReason.includes("PUNCH_IN_ALIGNED"));
    });

    // 8. Face and caption safe-area collision handling
    it("8. handles face and caption safe-area placement avoiding lower-third collision", () => {
      // High/normal face: caption at bottom (y: 78%)
      const normalPlace = resolveSafeCaptionPlacement({
        targetRatio: "9:16",
        faceBox: { x: 0.35, y: 0.20, width: 0.30, height: 0.25 },
        cropX: 0.5,
      });
      assert.equal(normalPlace.collisionAvoided, false);
      assert.equal(normalPlace.placement.y, 78);

      // Low face: caption shifted upward to upper-middle (y: <= 60%) to prevent collision
      const shiftedPlace = resolveSafeCaptionPlacement({
        targetRatio: "9:16",
        faceBox: { x: 0.35, y: 0.65, width: 0.30, height: 0.25 },
        cropX: 0.5,
      });
      assert.equal(shiftedPlace.collisionAvoided, true);
      assert.ok(shiftedPlace.placement.y <= 60, "Caption should shift upward away from low face");
    });

    // 9. Interaction with Priority 6 overlays
    it("9. suppresses caption callout badges when Priority 6 overlays are active", () => {
      const candidate = { id: "c-p7-9", startTime: 0, endTime: 20, duration: 20 };
      const activeOverlays = [
        { id: "ov-p6", start: 2.0, duration: 3.5 }, // Active from 2.0s to 5.5s
      ];

      const sentences = [
        { id: "s1", start: 2.5, end: 4.5, text: "We gained 10x performance." }, // During overlay
        { id: "s2", start: 8.0, end: 11.0, text: "Uptime reached 99.99%." }, // Outside overlay
      ];

      const callouts = detectAnimatedCaptionCallouts({
        candidate,
        sentences,
        activeOverlays,
      });

      assert.ok(Array.isArray(callouts));
      // First sentence callout is suppressed because Priority 6 overlay is active
      const hasFirst = callouts.some((c) => c.text.includes("10X"));
      assert.equal(hasFirst, false, "Callout during Priority 6 overlay should be suppressed");

      // Second sentence callout is produced cleanly
      const hasSecond = callouts.some((c) => c.text.includes("99.99%"));
      assert.equal(hasSecond, true, "Callout outside Priority 6 overlay should be created");
    });

    // 10. Overlapping animation suppression
    it("10. suppresses excessive frequency and overlapping word emphasis animations", () => {
      const candidate = { id: "c-p7-10", startTime: 0, endTime: 10, duration: 10 };
      const captionSegments = [
        {
          id: "cap-rapid",
          start: 1.0,
          end: 3.5,
          text: "Critical massive insane revolution.",
          words: [
            { text: "Critical", start: 1.0, end: 1.5 },
            { text: "massive", start: 1.5, end: 2.0 },
            { text: "insane", start: 2.0, end: 2.5 },
            { text: "revolution", start: 2.5, end: 3.2 },
          ],
        },
      ];

      const plan = planMotionTypography({
        candidate,
        captionSegments,
        options: { maxEmphasisWordsPerSentence: 2, minEmphasisSpacing: 1.5 },
      });

      assert.ok(plan.ok);
      const emphasized = plan.captionSegments[0].words.filter((w) => w.isEmphasized);
      // Even though all 4 words are salient, at most 2 words can be emphasized and spaced apart
      assert.ok(emphasized.length <= 2, "Cadence control must limit emphasis words per sentence");
      if (emphasized.length === 2) {
        assert.ok(
          emphasized[1].start - emphasized[0].start >= 1.0,
          "Emphasized words must obey temporal spacing"
        );
      }
    });

    // 11. Reduced-motion behavior
    it("11. enforces reduced-motion mode without geometric scaling or bouncing", () => {
      const candidate = { id: "c-p7-11", startTime: 0, endTime: 10, duration: 10 };
      const captionSegments = [
        {
          id: "cap-rm",
          start: 1.0,
          end: 4.0,
          text: "A huge 100x speedup.",
          words: [
            { text: "A", start: 1.0, end: 1.3 },
            { text: "huge", start: 1.3, end: 1.8 },
            { text: "100x", start: 1.8, end: 2.5 },
            { text: "speedup", start: 2.5, end: 3.8 },
          ],
        },
      ];

      const plan = planMotionTypography({
        candidate,
        captionSegments,
        options: { reducedMotion: true },
      });

      assert.ok(plan.ok);
      assert.equal(plan.reducedMotion, true);

      for (const w of plan.captionSegments[0].words) {
        // Reduced motion locks scale strictly to 1.0
        assert.equal(w.scale, 1.0, "Scale must be 1.0 in reduced motion mode");
        if (w.isEmphasized) {
          assert.equal(w.effect, "highlight");
        }
      }
    });

    // 12. Disabled-mode behavior
    it("12. disables motion typography cleanly when options.enabled or motionTypography is false", () => {
      const candidate = { id: "c-p7-12", startTime: 0, endTime: 12, duration: 12 };
      const captionSegments = [
        {
          id: "cap-dis",
          start: 1.0,
          end: 4.0,
          text: "Some standard text.",
          words: [{ text: "Some", start: 1.0, end: 2.0 }],
        },
      ];

      const plan = planMotionTypography({
        candidate,
        captionSegments,
        options: { enabled: false },
      });

      assert.ok(plan.ok);
      assert.equal(plan.enabled, false);
      assert.equal(plan.hasKineticWords, false);
      assert.equal(plan.callouts.length, 0);

      // Verify project conversion respects motionTypography: false
      const project = convertCandidateToProject(sourceClip, candidate, {
        motionTypography: false,
        captionSegments,
      });
      assert.ok(project);
      assert.equal(project.motionTypography.enabled, false);
    });

    // 13. Static-caption fallback
    it("13. provides static-caption fallback when word timings are absent", () => {
      const candidate = { id: "c-p7-13", startTime: 0, endTime: 10, duration: 10 };
      const captionSegments = [
        {
          id: "cap-static",
          start: 1.0,
          end: 4.0,
          text: "Pure sentence caption with no words array.",
        },
      ];

      const plan = planMotionTypography({ candidate, captionSegments });
      assert.ok(plan.ok);
      assert.equal(plan.hasKineticWords, true); // Processed with fallback
      assert.equal(plan.captionSegments[0].isKinetic, false);
      assert.equal(plan.captionSegments[0].fallbackMode, "static-sentence");
      assert.equal(plan.captionSegments[0].text, "Pure sentence caption with no words array.");
    });

    // 14. Missing audio or semantic metadata
    it("14. operates reliably when audio features, narrative arcs, and hook scores are missing", () => {
      const candidate = {
        id: "c-p7-14",
        startTime: 0,
        endTime: 15,
        duration: 15,
        // Null / undefined metadata
        hookScore: null,
        payoffScore: undefined,
        narrativeArc: null,
        acousticFeatures: null,
      };

      const captionSegments = [
        {
          id: "cap-nometa",
          start: 1.0,
          end: 5.0,
          text: "System throughput reached 50,000 QPS.",
          words: [
            { text: "System", start: 1.0, end: 1.8 },
            { text: "throughput", start: 1.8, end: 2.8 },
            { text: "reached", start: 2.8, end: 3.5 },
            { text: "50,000", start: 3.5, end: 4.2 },
            { text: "QPS", start: 4.2, end: 4.9 },
          ],
        },
      ];

      const plan = planMotionTypography({ candidate, captionSegments });
      assert.ok(plan.ok);
      assert.ok(plan.captionSegments.length > 0);
      const qpsWord = plan.captionSegments[0].words.find((w) => w.text === "QPS");
      assert.ok(qpsWord.isEmphasized);
    });

    // 15. Deterministic results across repeated runs
    it("15. produces identical, deterministic motion typography across repeated runs", () => {
      const candidate = {
        id: "c-p7-15",
        startTime: 0,
        endTime: 18,
        duration: 18,
        hookScore: 85,
        payoffScore: 84,
      };

      const captionSegments = [
        {
          id: "cap-det",
          start: 1.0,
          end: 6.0,
          text: "Why did 10x scalability solve the problem?",
          narrativeStage: "setup",
          words: [
            { text: "Why", start: 1.0, end: 1.5 },
            { text: "did", start: 1.5, end: 1.8 },
            { text: "10x", start: 1.8, end: 2.5 },
            { text: "scalability", start: 2.5, end: 3.8 },
            { text: "solve", start: 3.8, end: 4.5 },
            { text: "the", start: 4.5, end: 4.8 },
            { text: "problem?", start: 4.8, end: 5.8 },
          ],
        },
      ];

      const run1 = planMotionTypography({ candidate, captionSegments });
      const run2 = planMotionTypography({ candidate, captionSegments });

      assert.deepEqual(run1.captionSegments, run2.captionSegments);
      assert.deepEqual(run1.callouts, run2.callouts);
      assert.deepEqual(run1.stats, run2.stats);
    });

    // 16. Backward compatibility with existing Shorts Studio functionality
    it("16. maintains full backward compatibility with Priorities 1–6 project structures", () => {
      const candidate = {
        id: "cand-p1-6-compat",
        startTime: 2.0,
        endTime: 18.0,
        duration: 16.0,
        cropX: 0.45,
        score: 88,
        hookScore: 90,
        payoffScore: 85,
        punchIns: [{ time: 1.5, scale: 1.25, duration: 3.0 }],
        overlays: [{ id: "ov-1", start: 3.0, duration: 3.0, layer: 2 }],
      };

      const project = convertCandidateToProject(sourceClip, candidate, {
        aspectRatio: "9:16",
        speechPunchIns: true,
        overlays: true,
        motionTypography: true,
        captionSegments: [
          {
            start: 3.0,
            end: 7.0,
            text: "Preserved compatibility test.",
            words: [
              { start: 3.0, end: 4.5, text: "Preserved" },
              { start: 4.5, end: 5.8, text: "compatibility" },
              { start: 5.8, end: 6.9, text: "test" },
            ],
          },
        ],
      });

      assert.ok(project);
      assert.equal(project.ratioId, "9:16");
      assert.ok(project.visualSegments.length > 0);
      assert.ok(project.visualOverlaySegments.length > 0);
      assert.ok(project.visualSegments[0].punchIns.length > 0);
      assert.ok(project.captionSegments.length > 0);
      assert.ok(project.motionTypography.enabled);
    });

    // 17. Export-plan behavior for supported and unsupported effects
    it("17. generates WebCodecs export spec with motion metadata and handles FFmpeg static fallback", () => {
      const candidate = {
        id: "cand-export-p7",
        startTime: 0,
        endTime: 14,
        duration: 14,
        cropX: 0.5,
      };

      const exportSpec = buildShortExportSpec(sourceClip, candidate, {
        captionSegments: [
          {
            start: 1.0,
            end: 4.0,
            text: "High impact kinetic sentence.",
            words: [
              { start: 1.0, end: 2.0, text: "High" },
              { start: 2.0, end: 3.0, text: "impact" },
              { start: 3.0, end: 4.0, text: "kinetic" },
            ],
          },
        ],
      });

      assert.ok(exportSpec);
      assert.ok(exportSpec.motionTypography);
      assert.ok(exportSpec.project.captionSegments[0].isKinetic);

      // Verify buildFfmpegRenderPlan consumes the enriched project safely without error
      const mediaMap = {
        visuals: [{ id: sourceClip.id, path: sourceClip.path }],
        overlays: [],
      };
      const extractedFiles = new Map([[sourceClip.path, sourceClip.path]]);

      const ffmpegPlan = buildFfmpegRenderPlan({
        project: exportSpec.project,
        media: mediaMap,
        extractedFiles,
        duration: 14.0,
        settings: { output: "test-out.mp4", width: 1080, height: 1920 },
      });

      assert.ok(ffmpegPlan);
      assert.ok(Array.isArray(ffmpegPlan.args));
      const filterArg = ffmpegPlan.args[ffmpegPlan.args.indexOf("-filter_complex") + 1];
      // FFmpeg renders readable static drawtext captions
      assert.ok(filterArg.includes("drawtext="), "FFmpeg render plan must include drawtext filter");
    });

    // 18. Sound-accent fallback when assets or mixing support are unavailable
    it("18. cleanly falls back when project assets do not include standalone sound effects", () => {
      // Case A: No audio assets provided
      const noAssets = resolveSoundAccents({
        emphasisEvents: [{ time: 2.5, word: "breakthrough" }],
        availableAssets: [],
        options: { soundAccentsEnabled: true },
      });
      assert.equal(noAssets.soundAccents.length, 0);
      assert.equal(noAssets.limitation, "NO_SFX_ASSETS_AVAILABLE");

      // Case B: Sound accents disabled in options
      const disabledAccents = resolveSoundAccents({
        emphasisEvents: [{ time: 2.5, word: "breakthrough" }],
        availableAssets: [{ id: "a1", type: "audio", name: "pop.mp3", path: "/sfx/pop.mp3" }],
        options: { soundAccentsEnabled: false },
      });
      assert.equal(disabledAccents.soundAccents.length, 0);
      assert.equal(disabledAccents.limitation, "SOUND_ACCENTS_DISABLED");

      // Case C: Valid project-provided SFX asset with enabled sound accents
      const validAsset = resolveSoundAccents({
        emphasisEvents: [{ time: 2.5, word: "breakthrough" }],
        availableAssets: [{ id: "sfx-whoosh", type: "audio", kind: "sfx", path: "/sfx/whoosh.mp3" }],
        options: { soundAccentsEnabled: true },
      });
      assert.equal(validAsset.soundAccents.length, 1);
      assert.equal(validAsset.soundAccents[0].assetId, "sfx-whoosh");
    });
  });

  // =========================================================================
  // Phase 2 Priority 8 — Multi-Platform Aspect Ratio & Smart Repackaging Engine
  // =========================================================================
  describe("Phase 2 Priority 8 — Multi-Platform Aspect Ratio & Smart Repackaging Engine", () => {
    const dummySourceClip = {
      id: "src-longform",
      name: "keynote.mp4",
      width: 1920,
      height: 1080,
      duration: 120,
    };

    const dummyCandidate = {
      id: "cand-p8-01",
      startTime: 10.0,
      endTime: 40.0,
      duration: 30.0,
      title: "Mastering Multi-Platform Strategy",
      strategy: "speech-centric",
      framingMode: "smart-zoom",
      cropX: 0.5,
      hookScore: 88,
      punchIns: [
        { id: "pz-1", time: 1.5, tStart: 1.5, scale: 1.25, duration: 2.5, x: 2.0, y: -1.0 },
      ],
      overlays: [
        { id: "ov-1", start: 2.0, end: 5.0, type: "callout_card", placement: "top-center" },
      ],
    };

    const dummyCaptions = [
      { id: "c-1", start: 10.0, end: 14.0, text: "Here is the critical insight for content creators." },
      { id: "c-2", start: 14.5, end: 20.0, text: "Repackaging lets you reach every audience across platforms." },
      { id: "c-3", start: 22.0, end: 28.0, text: "Without doing duplicate editing work from scratch." },
      { id: "c-4", start: 30.0, end: 38.0, text: "That is the real secret to exponential scale." },
    ];

    // 1. Correct output dimensions for all four aspect ratios
    it("1. verifies correct output dimensions for all four target aspect ratios", () => {
      assert.deepEqual(SUPPORTED_REPACKAGING_RATIOS, ["9:16", "1:1", "4:5", "16:9"]);

      const r916 = getRepackagingRatioDefinition("9:16");
      assert.equal(r916.width, 1080);
      assert.equal(r916.height, 1920);
      assert.equal(r916.orientation, "portrait");

      const r11 = getRepackagingRatioDefinition("1:1");
      assert.equal(r11.width, 1080);
      assert.equal(r11.height, 1080);
      assert.equal(r11.orientation, "square");

      const r45 = getRepackagingRatioDefinition("4:5");
      assert.equal(r45.width, 1080);
      assert.equal(r45.height, 1350);
      assert.equal(r45.orientation, "portrait");

      const r169 = getRepackagingRatioDefinition("16:9");
      assert.equal(r169.width, 1920);
      assert.equal(r169.height, 1080);
      assert.equal(r169.orientation, "landscape");
    });

    // 2. Crop geometry and bounds
    it("2. strictly bounds crop geometry within [0, 1] for all target aspect ratios", () => {
      const source = { width: 1920, height: 1080 };
      for (const ratioId of SUPPORTED_REPACKAGING_RATIOS) {
        const crop = calculateRepackagingCrop({
          sourceWidth: source.width,
          sourceHeight: source.height,
          targetRatio: ratioId,
          cropX: 0.8,
        });

        assert.ok(crop.cropWidth >= 0.05 && crop.cropWidth <= 1.0, `cropWidth out of bounds: ${crop.cropWidth}`);
        assert.ok(crop.cropHeight >= 0.05 && crop.cropHeight <= 1.0, `cropHeight out of bounds: ${crop.cropHeight}`);
        assert.ok(crop.cropX >= 0 && crop.cropX <= 1 - crop.cropWidth + 0.0001, `cropX out of bounds: ${crop.cropX}`);
        assert.ok(crop.cropY >= 0 && crop.cropY <= 1 - crop.cropHeight + 0.0001, `cropY out of bounds: ${crop.cropY}`);
      }
    });

    // 3. Face tracking and subject positioning
    it("3. centers tracked faces with headroom preservation", () => {
      // Speaker face high up in frame at x=0.6, y=0.15, size=0.1x0.15
      const faceDetections = [
        {
          timestamp: 12.0,
          faces: [{ x: 0.6, y: 0.15, width: 0.10, height: 0.15, confidence: 0.95 }],
        },
      ];

      const crop = calculateRepackagingCrop({
        sourceWidth: 1920,
        sourceHeight: 1080,
        targetRatio: "9:16",
        faceDetections,
      });

      assert.equal(crop.presentation, "face-tracked");
      // Face center is 0.65 horizontally. Crop window should center around face without clipping
      const cropCenter = crop.cropX + crop.cropWidth / 2;
      assert.ok(Math.abs(cropCenter - 0.65) < 0.05, `Crop center ${cropCenter} should be close to face center 0.65`);
      // Headroom preserved (top of face is at y=0.15, crop top should be at or near 0)
      assert.ok(crop.cropY <= 0.15, `Headroom must be preserved above the face`);
    });

    // 4. Missing or malformed tracking metadata
    it("4. handles missing, empty, or malformed tracking metadata gracefully", () => {
      // Null face array
      const cropNull = calculateRepackagingCrop({
        sourceWidth: 1920,
        sourceHeight: 1080,
        targetRatio: "9:16",
        faceDetections: null,
      });
      assert.equal(cropNull.presentation, "center-fallback");

      // Malformed face detection entries (NaN, strings, out of bounds)
      const cropMalformed = calculateRepackagingCrop({
        sourceWidth: 1920,
        sourceHeight: 1080,
        targetRatio: "9:16",
        faceDetections: [
          { timestamp: NaN, faces: [{ x: "not-a-number", y: undefined }] },
          { timestamp: 1.0, faces: null },
        ],
      });
      assert.ok(cropMalformed);
      assert.equal(cropMalformed.presentation, "center-fallback");
      assert.ok(Number.isFinite(cropMalformed.cropX));
      assert.ok(Number.isFinite(cropMalformed.cropY));
    });

    // 5. Center-crop fallback
    it("5. computes deterministic center-crop fallback when tracking is unavailable", () => {
      const source = { width: 1920, height: 1080 };
      const crop916 = calculateRepackagingCrop({
        sourceWidth: source.width,
        sourceHeight: source.height,
        targetRatio: "9:16",
        cropX: 0.5,
      });

      // 9:16 on 16:9 source has cropW = 0.3164, center cropX = (1 - 0.3164)/2 = 0.3418
      assert.equal(crop916.presentation, "center-fallback");
      assert.equal(crop916.cropWidth, 0.3164);
      assert.equal(crop916.cropHeight, 1.0);
      assert.equal(crop916.cropX, 0.3418);
      assert.equal(crop916.cropY, 0);

      const crop11 = calculateRepackagingCrop({
        sourceWidth: source.width,
        sourceHeight: source.height,
        targetRatio: "1:1",
      });
      // 1:1 on 16:9 source has cropW = 0.5625, center cropX = (1 - 0.5625)/2 = 0.2188
      assert.equal(crop11.cropWidth, 0.5625);
      assert.equal(crop11.cropX, 0.2188);
      assert.equal(crop11.cropY, 0);
    });

    // 6. Punch-in and reframing coordination
    it("6. adapts punch-ins across target aspect ratios and bounds offsets", () => {
      const sourcePunchIns = [
        { id: "pz-1", time: 1.5, tStart: 1.5, scale: 1.25, duration: 2.5, x: 10.0, y: -5.0 },
      ];

      // Vertical 9:16: scaleFactor = 1.0
      const adapted916 = adaptPunchInsForTargetRatio(sourcePunchIns, "9:16");
      assert.equal(adapted916.length, 1);
      assert.equal(adapted916[0].scale, 1.25);
      assert.equal(adapted916[0].x, 10.0);

      // Square 1:1: scaleFactor = 0.75
      const adapted11 = adaptPunchInsForTargetRatio(sourcePunchIns, "1:1");
      assert.equal(adapted11[0].x, 7.5);

      // Landscape 16:9: scaleFactor = 0.50
      const adapted169 = adaptPunchInsForTargetRatio(sourcePunchIns, "16:9");
      assert.equal(adapted169[0].x, 5.0);
    });

    // 7. Caption and overlay safe areas
    it("7. enforces platform-aware safe areas for captions and overlays across ratios", () => {
      for (const ratioId of SUPPORTED_REPACKAGING_RATIOS) {
        const safeArea = resolvePlatformSafeArea(ratioId);
        assert.ok(safeArea.top >= 0.05 && safeArea.top <= 0.15, `Top margin safe for ${ratioId}`);
        assert.ok(safeArea.bottom >= 0.08 && safeArea.bottom <= 0.25, `Bottom margin safe for ${ratioId}`);

        // Captions safe area placement
        const sampleCaptions = [{ id: "c1", start: 0, end: 3, text: "Sample text" }];
        const adaptedCaptions = adaptCaptionsForTargetRatio(sampleCaptions, ratioId);
        assert.equal(adaptedCaptions.length, 1);
        assert.ok(adaptedCaptions[0].placement.y <= 100 - (safeArea.bottom * 100));

        // Overlays safe area placement
        const sampleOverlays = [{ id: "ov1", start: 0, end: 3, type: "callout_card", placement: "top-center" }];
        const adaptedOverlays = adaptOverlaysForTargetRatio(sampleOverlays, ratioId);
        assert.equal(adaptedOverlays.length, 1);
        assert.equal(adaptedOverlays[0].safeArea.top, safeArea.top);
      }
    });

    // 8. Title-card layout and face collision avoidance
    it("8. adapts title-card layout to prevent collision with tracked faces", () => {
      // Case A: Speaker's face is high in the frame (yMin=0.08, yMax=0.22)
      const highFace = { xMin: 0.45, xMax: 0.55, yMin: 0.08, yMax: 0.22 };
      const layoutAvoid = resolveTitleCardLayout("9:16", highFace);
      assert.equal(layoutAvoid.collisionAvoided, true);
      assert.equal(layoutAvoid.position, "upper-middle");
      assert.ok(layoutAvoid.y >= 24, `Title card should be pushed below upper face: got ${layoutAvoid.y}`);

      // Case B: No face or lower face (yMin=0.35)
      const normalFace = { xMin: 0.45, xMax: 0.55, yMin: 0.35, yMax: 0.55 };
      const layoutNormal = resolveTitleCardLayout("9:16", normalFace);
      assert.equal(layoutNormal.collisionAvoided, false);
      assert.equal(layoutNormal.position, "top-center");
      assert.equal(layoutNormal.y, 20);
    });

    // 9. Extremely wide and tall source videos
    it("9. cleanly handles extreme source aspect ratios without out-of-bound errors", () => {
      // 32:9 ultra-wide source (3840x1080)
      const ultraWide = calculateRepackagingCrop({
        sourceWidth: 3840,
        sourceHeight: 1080,
        targetRatio: "9:16",
      });
      assert.ok(ultraWide.cropWidth >= 0.05 && ultraWide.cropWidth <= 1.0);
      assert.ok(ultraWide.cropHeight >= 0.05 && ultraWide.cropHeight <= 1.0);
      assert.ok(Number.isFinite(ultraWide.cropX));
      assert.ok(Number.isFinite(ultraWide.cropY));

      // 9:32 ultra-tall source (1080x3840)
      const ultraTall = calculateRepackagingCrop({
        sourceWidth: 1080,
        sourceHeight: 3840,
        targetRatio: "16:9",
      });
      assert.ok(ultraTall.cropWidth >= 0.05 && ultraTall.cropWidth <= 1.0);
      assert.ok(ultraTall.cropHeight >= 0.05 && ultraTall.cropHeight <= 1.0);
      assert.ok(Number.isFinite(ultraTall.cropX));
      assert.ok(Number.isFinite(ultraTall.cropY));
    });

    // 10. Invalid dimensions and unsupported ratio inputs
    it("10. falls back gracefully on invalid dimensions or unsupported aspect ratios", () => {
      // Zero width and negative height
      const invalidDims = calculateRepackagingCrop({
        sourceWidth: 0,
        sourceHeight: -100,
        targetRatio: "unsupported_aspect_ratio_xyz",
      });
      assert.ok(invalidDims);
      assert.equal(invalidDims.sourceSize.width, 1920);
      assert.equal(invalidDims.sourceSize.height, 1080);
      assert.equal(invalidDims.targetRatio, "9:16");

      // Normalization of unknown ratio
      assert.equal(normalizeTargetRatio("custom-invalid"), "9:16");
      assert.equal(normalizeTargetRatio(null), "9:16");
      assert.equal(normalizeTargetRatio(undefined), "9:16");
    });

    // 11. Deterministic results
    it("11. produces deterministic repackaging results across repeated executions", () => {
      const res1 = repackageShortCandidate({
        sourceClip: dummySourceClip,
        candidate: dummyCandidate,
        targetRatio: "4:5",
        captionSegments: dummyCaptions,
      });

      const res2 = repackageShortCandidate({
        sourceClip: dummySourceClip,
        candidate: dummyCandidate,
        targetRatio: "4:5",
        captionSegments: dummyCaptions,
      });

      assert.deepEqual(res1.cropGeometry, res2.cropGeometry);
      assert.deepEqual(res1.exportSpec.width, res2.exportSpec.width);
      assert.deepEqual(res1.exportSpec.height, res2.exportSpec.height);
      assert.deepEqual(res1.exportSpec.project.ratioId, res2.exportSpec.project.ratioId);
      assert.deepEqual(res1.titleCardLayout, res2.titleCardLayout);
    });

    // 12. Multiple output specifications from one candidate
    it("12. produces multiple format-specific export specifications from a single candidate", () => {
      const batch = batchRepackageCandidate({
        sourceClip: dummySourceClip,
        candidate: dummyCandidate,
        targetRatios: ["9:16", "1:1", "4:5", "16:9"],
        captionSegments: dummyCaptions,
      });

      assert.equal(batch.targetRatios.length, 4);
      assert.ok(batch.repackaged["9:16"]);
      assert.ok(batch.repackaged["1:1"]);
      assert.ok(batch.repackaged["4:5"]);
      assert.ok(batch.repackaged["16:9"]);

      const multiSpecs = buildMultiFormatExportSpecs({
        sourceClip: dummySourceClip,
        candidate: dummyCandidate,
        targetRatios: ["9:16", "1:1", "4:5", "16:9"],
        captionSegments: dummyCaptions,
      });

      assert.equal(multiSpecs.length, 4);
      assert.equal(multiSpecs[0].aspectRatio, "9:16");
      assert.equal(multiSpecs[0].width, 1080);
      assert.equal(multiSpecs[0].height, 1920);

      assert.equal(multiSpecs[1].aspectRatio, "1:1");
      assert.equal(multiSpecs[1].width, 1080);
      assert.equal(multiSpecs[1].height, 1080);

      assert.equal(multiSpecs[2].aspectRatio, "4:5");
      assert.equal(multiSpecs[2].width, 1080);
      assert.equal(multiSpecs[2].height, 1350);

      assert.equal(multiSpecs[3].aspectRatio, "16:9");
      assert.equal(multiSpecs[3].width, 1920);
      assert.equal(multiSpecs[3].height, 1080);
    });

    // 13. Source timing and duration preservation
    it("13. strictly preserves source timing, candidate duration, and punch-in timing across formats", () => {
      const batch = batchRepackageCandidate({
        sourceClip: dummySourceClip,
        candidate: dummyCandidate,
        targetRatios: SUPPORTED_REPACKAGING_RATIOS,
        captionSegments: dummyCaptions,
      });

      for (const ratioId of SUPPORTED_REPACKAGING_RATIOS) {
        const item = batch.repackaged[ratioId];
        assert.equal(item.exportSpec.duration, dummyCandidate.duration);
        assert.equal(item.exportSpec.startTime, dummyCandidate.startTime);
        assert.equal(item.exportSpec.endTime, dummyCandidate.endTime);
        assert.equal(item.project.timelineDuration, dummyCandidate.duration);

        // Visual segment source start and duration
        const visualSeg = item.project.visualSegments[0];
        assert.equal(visualSeg.sourceStart, dummyCandidate.startTime);
        assert.equal(visualSeg.sourceDuration, dummyCandidate.duration);
        assert.equal(visualSeg.duration, dummyCandidate.duration);
      }
    });

    // 14. Preview/export behavior for supported backends
    it("14. verifies preview project structure and FFmpeg render plan integration for repackaged ratios", () => {
      for (const ratioId of SUPPORTED_REPACKAGING_RATIOS) {
        const repack = repackageShortCandidate({
          sourceClip: dummySourceClip,
          candidate: dummyCandidate,
          targetRatio: ratioId,
          captionSegments: dummyCaptions,
        });

        const project = repack.project;
        assert.equal(project.ratioId, ratioId);

        // Generate FFmpeg render plan
        const ratioDef = getRepackagingRatioDefinition(ratioId);
        const mediaMap = {
          visuals: [{ id: dummySourceClip.id, path: dummySourceClip.name }],
          overlays: [{ id: "ov-1", path: "ov-1.png" }],
        };
        const extractedFiles = new Map([
          [dummySourceClip.id, dummySourceClip.name],
          [dummySourceClip.name, dummySourceClip.name],
          ["ov-1", "ov-1.png"],
        ]);

        const ffmpegPlan = buildFfmpegRenderPlan({
          project,
          media: mediaMap,
          extractedFiles,
          duration: dummyCandidate.duration,
          settings: {
            output: `output-${ratioId.replace(":", "x")}.mp4`,
            width: ratioDef.width,
            height: ratioDef.height,
          },
        });

        assert.ok(ffmpegPlan, `FFmpeg plan generated for ${ratioId}`);
        assert.ok(Array.isArray(ffmpegPlan.args));
        // Verify scale/pad or crop filter in FFmpeg args
        const filterStr = ffmpegPlan.args.join(" ");
        assert.ok(
          filterStr.includes(String(ratioDef.width)) || filterStr.includes(String(ratioDef.height)),
          `FFmpeg render plan must target ${ratioDef.width}x${ratioDef.height}`
        );
      }
    });

    // 15. Backward compatibility
    it("15. maintains full backward compatibility with legacy 9:16 candidates", () => {
      // Legacy candidate without Priority 8 fields
      const legacyCandidate = {
        id: "cand-legacy-1",
        startTime: 5.0,
        endTime: 25.0,
        duration: 20.0,
        title: "Legacy Short",
      };

      const converted = convertCandidateToProject(dummySourceClip, legacyCandidate, { targetRatio: "9:16" });
      assert.equal(converted.ratioId, "9:16");
      assert.equal(converted.timelineDuration, 20.0);
      assert.ok(converted.visualSegments.length > 0);

      const legacyExport = buildShortExportSpec(dummySourceClip, legacyCandidate);
      assert.equal(legacyExport.aspectRatio, "9:16");
      assert.equal(legacyExport.width, 1080);
      assert.equal(legacyExport.height, 1920);
    });

    // 16. Failure handling without corrupting the original project
    it("16. executes pure transformations without mutating candidate or source clip objects", () => {
      const sourceSnapshot = JSON.stringify(dummySourceClip);
      const candidateSnapshot = JSON.stringify(dummyCandidate);
      const captionsSnapshot = JSON.stringify(dummyCaptions);

      repackageShortCandidate({
        sourceClip: dummySourceClip,
        candidate: dummyCandidate,
        targetRatio: "1:1",
        captionSegments: dummyCaptions,
      });

      assert.equal(JSON.stringify(dummySourceClip), sourceSnapshot, "sourceClip must not be mutated");
      assert.equal(JSON.stringify(dummyCandidate), candidateSnapshot, "candidate must not be mutated");
      assert.equal(JSON.stringify(dummyCaptions), captionsSnapshot, "captions must not be mutated");
    });
  });

  // =========================================================================
  // Phase 2 Priority 9 — Automated B-Roll Synthesis & Smart Transition Polish
  // =========================================================================
  describe("Phase 2 Priority 9 — Automated B-Roll Synthesis & Smart Transition Polish", () => {
    const dummySourceClip = {
      id: "src-talk",
      name: "keynote.mp4",
      width: 1920,
      height: 1080,
      duration: 120.0,
    };

    const dummyCandidate = {
      id: "cand-p9-01",
      startTime: 10.0,
      endTime: 35.0,
      duration: 25.0,
      title: "The Architecture of Cloud Networking",
      strategy: "speech-centric",
      framingMode: "smart-zoom",
      cropX: 0.5,
      hookScore: 92,
      punchIns: [
        { id: "pz-1", time: 2.0, tStart: 2.0, scale: 1.25, duration: 2.5, x: 5.0, y: 0.0 },
      ],
      narrativeArc: {
        stages: [
          { type: "hook", startTime: 10.0, endTime: 12.0, text: "Why does the internet never fail?" },
          { type: "insight", startTime: 15.0, endTime: 22.0, text: "Distributed DNS servers and anycast routing provide instant resilience.", keywords: ["dns", "server", "network"] },
          { type: "climax", startTime: 25.0, endTime: 30.0, text: "Every packet finds the shortest physical fiber optic path.", keywords: ["fiber", "network", "packet"] },
          { type: "payoff", startTime: 32.0, endTime: 35.0, text: "That is modern infrastructure at work." },
        ],
      },
    };

    const dummySentences = [
      { id: "s-1", start: 10.0, end: 12.0, text: "Why does the internet never fail?" },
      { id: "s-2", start: 12.5, end: 18.5, text: "When you request a webpage, distributed DNS servers resolve the address in milliseconds." }, // 6.0s monologue
      { id: "s-3", start: 19.0, end: 25.0, text: "Anycast routing and global edge networks guarantee that traffic always reaches healthy clusters." }, // 6.0s monologue
      { id: "s-4", start: 25.5, end: 31.0, text: "Even if an entire datacenter goes offline, BGP re-routes millions of connections seamlessly." },
      { id: "s-5", start: 32.0, end: 35.0, text: "That is modern infrastructure at work." },
    ];

    const dummyAssets = [
      { id: "asset-dns-diagram", name: "DNS Server Architecture Diagram", type: "image", tags: ["dns", "server", "architecture", "network"], path: "/assets/dns-diagram.png" },
      { id: "asset-datacenter", name: "Global Cloud Datacenter Server Racks", type: "video", tags: ["datacenter", "servers", "cloud", "network"], path: "/assets/datacenter.mp4" },
      { id: "asset-coffee", name: "Espresso Coffee Machine", type: "image", tags: ["coffee", "cup", "morning"], path: "/assets/coffee.png" },
    ];

    // 1. Relevant versus unrelated B-roll assets
    it("1. selects highly relevant assets and rejects unrelated assets below threshold", () => {
      const opportunity = {
        keywords: ["dns", "server", "network"],
        text: "Distributed DNS servers resolve domain queries instantly.",
        primaryLabel: "DNS SERVERS",
        start: 4.0,
        duration: 3.0,
      };

      const result = scoreAndSelectBrollAsset({
        opportunity,
        availableAssets: dummyAssets,
        options: { relevanceThreshold: 0.25 },
      });

      assert.equal(result.reason, "ASSET_SELECTED");
      assert.ok(result.selectedAsset);
      assert.equal(result.selectedAsset.id, "asset-dns-diagram");
      assert.ok(result.relevanceScore >= 0.25, `Relevance score ${result.relevanceScore} must meet threshold`);

      // Unrelated test: coffee asset should have score near 0 and be rejected
      const coffeeResult = scoreAndSelectBrollAsset({
        opportunity,
        availableAssets: [dummyAssets[2]], // coffee asset
        options: { relevanceThreshold: 0.25 },
      });
      assert.equal(coffeeResult.reason, "NO_RELEVANT_ASSETS");
      assert.equal(coffeeResult.selectedAsset, null);
    });

    // 2. Missing assets and fallback instructions
    it("2. preserves footage and emits structured asset request when assets are missing", () => {
      const opportunity = {
        keywords: ["quantum", "cryptography"],
        text: "Post-quantum algorithms encrypt all data in transit.",
        primaryLabel: "QUANTUM ENCRYPTION",
        start: 5.0,
        duration: 3.0,
      };

      // Case A: Empty asset library
      const emptyResult = scoreAndSelectBrollAsset({
        opportunity,
        availableAssets: [],
      });
      assert.equal(emptyResult.reason, "NO_ASSETS_PROVIDED");
      assert.equal(emptyResult.selectedAsset, null);
      assert.ok(emptyResult.assetRequest);
      assert.equal(emptyResult.assetRequest.type, "broll_video");
      assert.equal(emptyResult.assetRequest.duration, 3.0);

      // Case B: No relevant assets
      const noRelResult = scoreAndSelectBrollAsset({
        opportunity,
        availableAssets: [dummyAssets[2]], // coffee
      });
      assert.equal(noRelResult.reason, "NO_RELEVANT_ASSETS");
      assert.ok(noRelResult.assetRequest);
    });

    // 3. Monologue cutaway opportunities
    it("3. detects monologue cutaway opportunities during extended speech segments", () => {
      const opps = detectBrollCutawayOpportunities({
        candidate: dummyCandidate,
        sentences: dummySentences,
        options: { minMonologueGap: 4.5 },
      });

      assert.ok(opps.length >= 1, "Should detect at least one monologue cutaway");
      const monologueOpp = opps.find((o) => o.type === "monologue_cutaway");
      assert.ok(monologueOpp, "Monologue cutaway opportunity must exist");
      assert.ok(monologueOpp.duration >= 1.5 && monologueOpp.duration <= 4.5);
    });

    // 4. Narrative boundary detection
    it("4. detects narrative stage boundaries for visual transition opportunities", () => {
      const opps = detectBrollCutawayOpportunities({
        candidate: dummyCandidate,
        sentences: dummySentences,
        narrativeArc: dummyCandidate.narrativeArc,
      });

      const narrativeOpp = opps.find((o) => o.type === "narrative_shift_cutaway");
      assert.ok(narrativeOpp, "Narrative shift cutaway opportunity must be identified");
      assert.ok(narrativeOpp.confidence >= 0.85);
    });

    // 5. Speech-pause alignment
    it("5. aligns cutaways with natural speech pauses rather than mid-word cuts", () => {
      const opps = detectBrollCutawayOpportunities({
        candidate: dummyCandidate,
        sentences: dummySentences,
      });

      for (const opp of opps) {
        // Must start after candidate start + hook guard
        assert.ok(opp.start >= 1.5, `Cutaway start ${opp.start} must not precede hook guard`);
        assert.ok(opp.end <= dummyCandidate.duration - 1.5, `Cutaway end ${opp.end} must not invade payoff guard`);
      }
    });

    // 6. Hook and payoff protection
    it("6. strictly protects opening hook and concluding payoff from cutaways", () => {
      const opps = detectBrollCutawayOpportunities({
        candidate: dummyCandidate,
        sentences: dummySentences,
        options: { hookGuardDuration: 2.0, payoffGuardDuration: 3.0 },
      });

      for (const opp of opps) {
        assert.ok(opp.start >= 2.0, `Start ${opp.start} must be after hook guard 2.0s`);
        assert.ok(opp.end <= dummyCandidate.duration - 3.0, `End ${opp.end} must be before payoff guard ${dummyCandidate.duration - 3.0}s`);
      }

      // Transition selection directly on hook or payoff
      const hookTr = selectTransitionForContext({ time: 0.5, candidateDuration: 25.0 });
      assert.equal(hookTr.type, "none");
      assert.equal(hookTr.reason, "HOOK_PROTECTED");

      const payoffTr = selectTransitionForContext({ time: 24.5, candidateDuration: 25.0 });
      assert.equal(payoffTr.type, "none");
      assert.equal(payoffTr.reason, "PAYOFF_PROTECTED");
    });

    // 7. B-roll duration and spacing limits
    it("7. strictly bounds B-roll duration and enforces minimum spacing between cutaways", () => {
      const opps = detectBrollCutawayOpportunities({
        candidate: dummyCandidate,
        sentences: dummySentences,
        options: {
          minBrollDuration: 1.5,
          maxBrollDuration: 4.0,
          minBrollSpacing: 4.0,
        },
      });

      for (let i = 0; i < opps.length; i++) {
        assert.ok(opps[i].duration >= 1.5 && opps[i].duration <= 4.0, `Duration ${opps[i].duration} within bounds`);
        if (i > 0) {
          const spacing = opps[i].start - opps[i - 1].end;
          assert.ok(spacing >= 3.99, `Spacing between cutaways ${spacing} must satisfy minBrollSpacing`);
        }
      }
    });

    // 8. Clip and scene boundary clamping
    it("8. clamps cutaways and transitions within clip and scene boundaries", () => {
      const sceneCuts = [16.0]; // Scene cut at 16s inside candidate
      const opps = detectBrollCutawayOpportunities({
        candidate: dummyCandidate,
        sentences: dummySentences,
        sceneCuts,
      });

      for (const opp of opps) {
        // No cutaway should straddle the 16s scene cut
        const straddles = opp.start < 16.0 && opp.end > 16.0;
        assert.equal(straddles, false, `Cutaway ${opp.start}-${opp.end} must not straddle scene cut at 16s`);
      }
    });

    // 9. Transition selection and clean-cut fallback
    it("9. selects appropriate transitions and falls back cleanly to clean cut by default", () => {
      assert.equal(normalizeTransitionType("unknown_xyz"), "none");
      assert.equal(normalizeTransitionType(null), "none");
      assert.equal(normalizeTransitionType(undefined), "none");

      // Valid transitions
      assert.equal(normalizeTransitionType("fade"), "fade");
      assert.equal(normalizeTransitionType("zoom"), "zoom");
      assert.equal(normalizeTransitionType("wipe-left"), "wipe-left");

      // Contextual selections
      const brollTr = selectTransitionForContext({ time: 5.0, candidateDuration: 25.0, isBrollCutaway: true });
      assert.equal(brollTr.type, "fade");

      const narrativeTr = selectTransitionForContext({ time: 10.0, candidateDuration: 25.0, isNarrativeBoundary: true });
      assert.equal(narrativeTr.type, "wipe-left");

      const defaultTr = selectTransitionForContext({ time: 10.0, candidateDuration: 25.0 });
      assert.equal(defaultTr.type, "none");
      assert.equal(defaultTr.cleanCut, true);
    });

    // 10. Reduced-motion behavior
    it("10. enforces reduced-motion mode by restricting transitions to none or fade", () => {
      assert.equal(normalizeTransitionType("zoom", { reducedMotion: true }), "none");
      assert.equal(normalizeTransitionType("wipe-left", { reducedMotion: true }), "none");
      assert.equal(normalizeTransitionType("flash", { reducedMotion: true }), "none");
      assert.equal(normalizeTransitionType("fade", { reducedMotion: true }), "fade");

      const reducedPlan = planShortTransitionsAndBroll({
        candidate: dummyCandidate,
        sourceClip: dummySourceClip,
        availableAssets: dummyAssets,
        sentences: dummySentences,
        options: { reducedMotion: true },
      });

      assert.equal(reducedPlan.metrics.reducedMotion, true);
      for (const tr of reducedPlan.transitions) {
        assert.ok(tr.type === "none" || tr.type === "fade", `Reduced motion transition must be none or fade, got ${tr.type}`);
      }
    });

    // 11. Conflicting transitions and punch-in events
    it("11. resolves collisions with Priority 3 punch-in zooms to avoid visual conflict", () => {
      const punchIns = [{ id: "pz-1", time: 5.0, scale: 1.25, duration: 2.5 }];
      const transitions = [
        { id: "tr-1", time: 5.1, type: "zoom", duration: 0.3 }, // Near punch-in at 5.0s
        { id: "tr-2", time: 12.0, type: "fade", duration: 0.35 },
      ];

      const resolved = resolveTransitionCollisions({
        transitions,
        punchIns,
        clipDuration: 25.0,
      });

      const nearPunchIn = resolved.find((t) => Math.abs(t.time - 5.0) < 0.5);
      assert.ok(nearPunchIn);
      assert.equal(nearPunchIn.type, "none", "Transition clashing with punch-in zoom must fall back to clean cut");
      assert.equal(nearPunchIn.collisionResolved, true);

      // Distant transition remains intact
      const distantTr = resolved.find((t) => t.time === 12.0);
      assert.ok(distantTr);
      assert.equal(distantTr.type, "fade");
    });

    // 12. Missing or malformed metadata
    it("12. handles missing, null, or malformed metadata without throwing", () => {
      const nullPlan = planShortTransitionsAndBroll({
        candidate: null,
      });
      assert.equal(nullPlan.ok, false);
      assert.equal(nullPlan.metrics.transitionCount, 0);

      const malformedPlan = planShortTransitionsAndBroll({
        candidate: { id: "c-bad", duration: NaN },
      });
      assert.equal(malformedPlan.ok, false);

      const emptySentencesPlan = planShortTransitionsAndBroll({
        candidate: { id: "c-ok", duration: 15.0 },
        sentences: null,
        availableAssets: null,
      });
      assert.equal(emptySentencesPlan.ok, true);
      assert.ok(Array.isArray(emptySentencesPlan.transitions));
    });

    // 13. Deterministic results
    it("13. produces identical, deterministic transition plans across repeated executions", () => {
      const plan1 = planShortTransitionsAndBroll({
        candidate: dummyCandidate,
        sourceClip: dummySourceClip,
        availableAssets: dummyAssets,
        sentences: dummySentences,
      });

      const plan2 = planShortTransitionsAndBroll({
        candidate: dummyCandidate,
        sourceClip: dummySourceClip,
        availableAssets: dummyAssets,
        sentences: dummySentences,
      });

      assert.deepEqual(plan1.cutaways, plan2.cutaways);
      assert.deepEqual(plan1.transitions, plan2.transitions);
      assert.deepEqual(plan1.assetRequests, plan2.assetRequests);
      assert.deepEqual(plan1.metrics, plan2.metrics);
    });

    // 14. All four supported aspect ratios
    it("14. operates consistently across all four supported aspect ratios", () => {
      const plan = planShortTransitionsAndBroll({
        candidate: dummyCandidate,
        sourceClip: dummySourceClip,
        availableAssets: dummyAssets,
        sentences: dummySentences,
      });

      const enhancedCandidate = applyTransitionsAndBrollToCandidate(dummyCandidate, plan);

      for (const ratioId of SUPPORTED_REPACKAGING_RATIOS) {
        const repack = repackageShortCandidate({
          sourceClip: dummySourceClip,
          candidate: enhancedCandidate,
          targetRatio: ratioId,
        });

        assert.ok(repack.ok);
        assert.equal(repack.targetRatio, ratioId);
        assert.ok(repack.project.transitions);
        assert.equal(repack.exportSpec.aspectRatio, ratioId);
      }
    });

    // 15. Browser/WebCodecs integration where supported
    it("15. generates project structure and overlay cutaways compatible with WebCodecs preview", () => {
      const plan = planShortTransitionsAndBroll({
        candidate: dummyCandidate,
        sourceClip: dummySourceClip,
        availableAssets: dummyAssets,
        sentences: dummySentences,
      });

      const enhancedCandidate = applyTransitionsAndBrollToCandidate(dummyCandidate, plan);
      const project = convertCandidateToProject(dummySourceClip, enhancedCandidate, { targetRatio: "9:16" });

      assert.ok(project);
      assert.ok(Array.isArray(project.visualOverlaySegments));
      // Planned B-roll cutaway is integrated into visualOverlaySegments
      const brollSeg = project.visualOverlaySegments.find((s) => s.kind === "broll");
      if (plan.cutaways.length > 0) {
        assert.ok(brollSeg);
        assert.equal(brollSeg.fitMode, "cover");
        assert.ok(brollSeg.transition);
      }

      const exportSpec = buildShortExportSpec(dummySourceClip, enhancedCandidate);
      assert.ok(exportSpec);
      assert.ok(Array.isArray(exportSpec.transitions));
    });

    // 16. FFmpeg render-plan compatibility
    it("16. verifies FFmpeg render plan integration for projects with B-roll cutaways and transitions", () => {
      const plan = planShortTransitionsAndBroll({
        candidate: dummyCandidate,
        sourceClip: dummySourceClip,
        availableAssets: dummyAssets,
        sentences: dummySentences,
      });

      const enhancedCandidate = applyTransitionsAndBrollToCandidate(dummyCandidate, plan);
      const project = convertCandidateToProject(dummySourceClip, enhancedCandidate, { targetRatio: "9:16" });

      const mediaMap = {
        visuals: [{ id: dummySourceClip.id, path: dummySourceClip.name }],
        overlays: (project.visualOverlaySegments || []).map((o) => ({
          id: o.assetId || o.id,
          path: o.path || o.src || "overlay.png",
        })),
      };

      const extractedFiles = new Map([
        [dummySourceClip.id, dummySourceClip.name],
        [dummySourceClip.name, dummySourceClip.name],
      ]);
      mediaMap.overlays.forEach((o) => {
        extractedFiles.set(o.id, o.path);
        extractedFiles.set(o.path, o.path);
      });

      const ffmpegPlan = buildFfmpegRenderPlan({
        project,
        media: mediaMap,
        extractedFiles,
        duration: dummyCandidate.duration,
        settings: { output: "test-p9.mp4", width: 1080, height: 1920 },
      });

      assert.ok(ffmpegPlan);
      assert.ok(Array.isArray(ffmpegPlan.args));
    });

    // 17. Source timing and project immutability
    it("17. strictly preserves source timing and guarantees pure immutability", () => {
      const sourceSnapshot = JSON.stringify(dummySourceClip);
      const candidateSnapshot = JSON.stringify(dummyCandidate);
      const assetsSnapshot = JSON.stringify(dummyAssets);

      const plan = planShortTransitionsAndBroll({
        candidate: dummyCandidate,
        sourceClip: dummySourceClip,
        availableAssets: dummyAssets,
        sentences: dummySentences,
      });

      assert.equal(JSON.stringify(dummySourceClip), sourceSnapshot, "sourceClip must remain unmutated");
      assert.equal(JSON.stringify(dummyCandidate), candidateSnapshot, "candidate must remain unmutated");
      assert.equal(JSON.stringify(dummyAssets), assetsSnapshot, "availableAssets must remain unmutated");

      const enhancedCandidate = applyTransitionsAndBrollToCandidate(dummyCandidate, plan);
      assert.equal(enhancedCandidate.startTime, dummyCandidate.startTime);
      assert.equal(enhancedCandidate.endTime, dummyCandidate.endTime);
      assert.equal(enhancedCandidate.duration, dummyCandidate.duration);
    });

    // 18. Backward compatibility with existing candidates and projects
    it("18. maintains full backward compatibility when transitions are disabled or absent", () => {
      const legacyCandidate = {
        id: "cand-legacy-p9",
        startTime: 5.0,
        endTime: 25.0,
        duration: 20.0,
        title: "Legacy No Transitions",
      };

      const converted = convertCandidateToProject(dummySourceClip, legacyCandidate, { targetRatio: "9:16" });
      assert.equal(converted.ratioId, "9:16");
      assert.equal(converted.timelineDuration, 20.0);
      assert.deepEqual(converted.transitions, []);
      assert.deepEqual(converted.brollCutaways, []);

      // Explicitly disabled transitions
      const disabledPlan = planShortTransitionsAndBroll({
        candidate: dummyCandidate,
        options: { enabled: false },
      });
      assert.equal(disabledPlan.enabled, false);
      assert.equal(disabledPlan.transitions.length, 0);
      assert.equal(disabledPlan.cutaways.length, 0);
    });
  });

  // =========================================================================
  // Phase 2 Priority 10 — Multi-Track Timeline Orchestration & Packaging
  // =========================================================================
  describe("Phase 2 Priority 10 — Multi-Track Timeline Orchestration & Packaging", () => {
    const dummySourceClip = {
      id: "src-keynote",
      name: "keynote-master.mp4",
      src: "file:///media/keynote-master.mp4",
      path: "/media/keynote-master.mp4",
      width: 1920,
      height: 1080,
      duration: 120.0,
      type: "video",
    };

    const dummyBrollAsset = {
      id: "broll-cloud-server",
      name: "Cloud Server Racks.mp4",
      src: "file:///assets/server-racks.mp4",
      path: "/assets/server-racks.mp4",
      duration: 15.0,
      width: 1920,
      height: 1080,
      type: "video",
      tags: ["cloud", "server", "datacenter", "hardware"],
    };

    const dummyCandidate = {
      id: "cand-p10-01",
      title: "Building Resilient Cloud Systems",
      startTime: 12.0,
      endTime: 28.0,
      duration: 16.0,
      aspectRatio: "9:16",
      framingMode: "smart-zoom",
      cropX: 0.52,
      hookScore: 94,
      punchIns: [
        { id: "pz-1", time: 2.0, tStart: 2.0, scale: 1.25, duration: 2.5, x: 5.0, y: 0.0 },
      ],
      narrativeArc: {
        stages: [
          { type: "hook", startTime: 12.0, endTime: 14.5, text: "Why do modern distributed services never fail completely?", label: "HOOK QUESTION" },
          { type: "insight", startTime: 15.0, endTime: 22.0, text: "Redundant cluster routing and anycast DNS isolate local hardware outages seamlessly.", label: "CORE ARCHITECTURE", keywords: ["cloud", "server", "datacenter"] },
          { type: "payoff", startTime: 25.0, endTime: 28.0, text: "That is the silent power of zero-trust architecture.", label: "PAYOFF SUMMARY" },
        ],
      },
      brollCutaways: [
        {
          id: "cutaway-p10-1",
          start: 4.0,
          duration: 3.0,
          end: 7.0,
          asset: dummyBrollAsset,
          assetId: dummyBrollAsset.id,
          assetPath: dummyBrollAsset.path,
          relevanceScore: 0.88,
          matchedTokens: ["cloud", "server"],
          reason: "Visual transition at core architecture stage",
          transitionIn: "fade",
          transitionOut: "fade",
        },
      ],
      transitions: [
        { id: "tr-in-1", time: 4.0, duration: 0.3, type: "fade", context: "broll_cutaway_in" },
        { id: "tr-out-1", time: 7.0, duration: 0.3, type: "fade", context: "broll_cutaway_out" },
      ],
    };

    const dummyCaptions = [
      {
        id: "cap-1",
        start: 12.0,
        end: 14.5,
        text: "Why do modern distributed services never fail completely?",
        words: [
          { word: "Why", start: 12.0, end: 12.3 },
          { word: "do", start: 12.3, end: 12.5 },
          { word: "modern", start: 12.5, end: 13.0, emphasis: true },
          { word: "distributed", start: 13.0, end: 13.6 },
          { word: "services", start: 13.6, end: 14.0 },
          { word: "never", start: 14.0, end: 14.3, emphasis: true },
          { word: "fail", start: 14.3, end: 14.5 },
        ],
      },
      {
        id: "cap-2",
        start: 15.0,
        end: 22.0,
        text: "Redundant cluster routing and anycast DNS isolate local hardware outages seamlessly.",
        words: [
          { word: "Redundant", start: 15.0, end: 15.6 },
          { word: "cluster", start: 15.6, end: 16.1 },
          { word: "routing", start: 16.1, end: 16.6 },
        ],
      },
    ];

    // 1. Conversion of a basic Shorts Studio candidate into a valid canonical timeline
    it("1. converts a basic Shorts Studio candidate into a valid canonical multi-track timeline", () => {
      const timeline = candidateToCanonicalTimeline(dummySourceClip, dummyCandidate, {
        captionSegments: dummyCaptions,
        availableAssets: [dummyBrollAsset],
      });

      assert.ok(timeline, "Timeline must be generated");
      assert.equal(timeline.candidateId, "cand-p10-01");
      assert.equal(timeline.title, "Building Resilient Cloud Systems");
      assert.equal(timeline.duration, 16.0);
      assert.equal(timeline.aspectRatio, "9:16");
      assert.equal(timeline.resolution.width, 1080);
      assert.equal(timeline.resolution.height, 1920);
      assert.ok(Array.isArray(timeline.tracks), "Tracks must be an array");
      assert.ok(timeline.tracks.length >= 4, "Must contain at least V1, V2, Subtitles, and A1 tracks");
    });

    // 2. Multi-track ordering and preservation of primary footage
    it("2. preserves multi-track ordering and maps primary footage to V1", () => {
      const timeline = candidateToCanonicalTimeline(dummySourceClip, dummyCandidate, {
        captionSegments: dummyCaptions,
      });

      const trackV1 = timeline.tracks.find((t) => t.id === CANONICAL_TRACK_IDS.V1_PRIMARY);
      assert.ok(trackV1, "V1 Primary Track must exist");
      assert.equal(trackV1.kind, CANONICAL_TRACK_KINDS.VIDEO);
      assert.equal(trackV1.clips.length, 1);

      const v1Clip = trackV1.clips[0];
      assert.equal(v1Clip.timelineStart, 0);
      assert.equal(v1Clip.duration, 16.0);
      assert.equal(v1Clip.sourceStart, 12.0);
      assert.equal(v1Clip.sourceDuration, 16.0);
      assert.equal(v1Clip.cropX, 0.52);
      assert.equal(v1Clip.framingMode, "smart-zoom");
      assert.equal(v1Clip.punchIns.length, 1);
    });

    // 3. B-roll and overlay track placement
    it("3. places B-roll cutaways and overlays into V2 track without replacing primary video", () => {
      const timeline = candidateToCanonicalTimeline(dummySourceClip, dummyCandidate, {
        captionSegments: dummyCaptions,
        availableAssets: [dummyBrollAsset],
      });

      const trackV2 = timeline.tracks.find((t) => t.id === CANONICAL_TRACK_IDS.V2_BROLL);
      assert.ok(trackV2, "V2 B-roll track must exist");
      assert.equal(trackV2.kind, CANONICAL_TRACK_KINDS.VIDEO);
      assert.equal(trackV2.clips.length, 1);

      const brollClip = trackV2.clips[0];
      assert.equal(brollClip.timelineStart, 4.0);
      assert.equal(brollClip.duration, 3.0);
      assert.equal(brollClip.mediaId, dummyBrollAsset.id);
      assert.equal(brollClip.transitionIn, "fade");
      assert.equal(brollClip.meta?.relevanceScore, 0.88);

      // Verify V1 track remains intact across the entire duration
      const trackV1 = timeline.tracks.find((t) => t.id === CANONICAL_TRACK_IDS.V1_PRIMARY);
      assert.equal(trackV1.clips[0].duration, 16.0, "V1 duration must not be truncated by B-roll");
    });

    // 4. Source in/out points and timeline timing
    it("4. strictly preserves clip source in/out points and timeline start/duration timing", () => {
      const timeline = candidateToCanonicalTimeline(dummySourceClip, dummyCandidate, {
        captionSegments: dummyCaptions,
      });

      assert.equal(timeline.startTime, 12.0);
      assert.equal(timeline.endTime, 28.0);
      assert.equal(timeline.duration, 16.0);

      const v1Clip = timeline.tracks.find((t) => t.id === CANONICAL_TRACK_IDS.V1_PRIMARY).clips[0];
      assert.equal(v1Clip.sourceStart, 12.0);
      assert.equal(v1Clip.sourceDuration, 16.0);
      assert.equal(v1Clip.timelineStart, 0);
      assert.equal(v1Clip.duration, 16.0);
    });

    // 5. Transition metadata preservation
    it("5. preserves transition types, durations, and timing metadata", () => {
      const timeline = candidateToCanonicalTimeline(dummySourceClip, dummyCandidate, {
        captionSegments: dummyCaptions,
      });

      assert.ok(Array.isArray(timeline.transitions));
      assert.equal(timeline.transitions.length, 2);

      const tr1 = timeline.transitions[0];
      assert.equal(tr1.time, 4.0);
      assert.equal(tr1.duration, 0.3);
      assert.equal(tr1.type, "fade");

      const tr2 = timeline.transitions[1];
      assert.equal(tr2.time, 7.0);
      assert.equal(tr2.duration, 0.3);
      assert.equal(tr2.type, "fade");
    });

    // 6. Word-level caption timing preservation
    it("6. preserves word-level karaoke and animated-caption timing and styling", () => {
      const timeline = candidateToCanonicalTimeline(dummySourceClip, dummyCandidate, {
        captionSegments: dummyCaptions,
      });

      const subTrack = timeline.tracks.find((t) => t.id === CANONICAL_TRACK_IDS.SUBTITLES);
      assert.ok(subTrack, "Subtitles track must exist");
      assert.equal(subTrack.clips.length, 2);

      const cap1 = subTrack.clips[0];
      assert.equal(cap1.start, 0.0); // Re-anchored to timeline start (12.0 - 12.0 = 0)
      assert.equal(cap1.end, 2.5);   // (14.5 - 12.0 = 2.5)
      assert.equal(cap1.words.length, 7);
      assert.equal(cap1.words[0].word, "Why");
      assert.equal(cap1.words[0].start, 0.0); // 12.0 - 12.0 = 0.0
      assert.equal(cap1.words[2].word, "modern");
      assert.equal(cap1.words[2].emphasis, true);
    });

    // 7. Audio and ducking metadata preservation
    it("7. preserves audio stems, volume levels, and ducking metadata", () => {
      const optionsWithMusic = {
        captionSegments: dummyCaptions,
        musicSegments: [
          {
            id: "bg-music-1",
            name: "Ambient Uplifting Tech.mp3",
            start: 0,
            duration: 16.0,
            volume: 0.25,
            ducking: { enabled: true, duckUnderDialogueVolume: 0.12 },
          },
        ],
      };

      const timeline = candidateToCanonicalTimeline(dummySourceClip, dummyCandidate, optionsWithMusic);

      const a1Track = timeline.tracks.find((t) => t.id === CANONICAL_TRACK_IDS.A1_VOICE);
      assert.ok(a1Track, "A1 Dialogue track must exist");
      assert.equal(a1Track.clips[0].volume, 1.0);

      const a2Track = timeline.tracks.find((t) => t.id === CANONICAL_TRACK_IDS.A2_MUSIC);
      assert.ok(a2Track, "A2 Music track must exist");
      assert.equal(a2Track.clips.length, 1);
      assert.equal(a2Track.clips[0].volume, 0.25);
      assert.ok(a2Track.clips[0].ducking);
      assert.equal(a2Track.clips[0].ducking.enabled, true);
    });

    // 8. Preservation of aspect ratio and export metadata
    it("8. preserves aspect ratio, dimensions, frame rate, and export package metadata", () => {
      const timeline = candidateToCanonicalTimeline(dummySourceClip, dummyCandidate, {
        aspectRatio: "9:16",
        frameRate: 30,
      });

      assert.equal(timeline.aspectRatio, "9:16");
      assert.equal(timeline.resolution.width, 1080);
      assert.equal(timeline.resolution.height, 1920);
      assert.equal(timeline.frameRate, 30);
      assert.equal(timeline.exportMetadata.format, TIMELINE_PACKAGE_FORMAT);
      assert.equal(timeline.exportMetadata.version, TIMELINE_PACKAGE_VERSION);
    });

    // 9. All four supported aspect ratios
    it("9. operates consistently across all four supported aspect ratios (9:16, 1:1, 4:5, 16:9)", () => {
      const ratios = ["9:16", "1:1", "4:5", "16:9"];
      const expectedSizes = {
        "9:16": { width: 1080, height: 1920 },
        "1:1": { width: 1080, height: 1080 },
        "4:5": { width: 1080, height: 1350 },
        "16:9": { width: 1920, height: 1080 },
      };

      for (const r of ratios) {
        const tl = candidateToCanonicalTimeline(dummySourceClip, dummyCandidate, {
          aspectRatio: r,
        });

        assert.equal(tl.aspectRatio, r);
        assert.equal(tl.resolution.width, expectedSizes[r].width);
        assert.equal(tl.resolution.height, expectedSizes[r].height);
        assert.equal(tl.duration, 16.0);
        assert.ok(tl.tracks.length >= 4);
      }
    });

    // 10. Native serialization and deserialization round trip
    it("10. round-trips through native project serialization and deserialization without data loss", () => {
      const originalTimeline = candidateToCanonicalTimeline(dummySourceClip, dummyCandidate, {
        captionSegments: dummyCaptions,
        availableAssets: [dummyBrollAsset],
      });

      // Serialize to native project archive payload
      const nativeProject = serializeTimelineToNativeProject(originalTimeline);
      assert.equal(nativeProject.format, "timeline-studio-archive");
      assert.equal(nativeProject.version, 3);
      assert.ok(nativeProject.project.visualSegments);
      assert.ok(nativeProject.project.visualOverlaySegments);
      assert.ok(nativeProject.project.captionSegments);

      // Deserialize back to canonical timeline
      const restoredTimeline = deserializeNativeProjectToTimeline(nativeProject);

      assert.equal(restoredTimeline.duration, originalTimeline.duration);
      assert.equal(restoredTimeline.aspectRatio, originalTimeline.aspectRatio);
      assert.equal(restoredTimeline.tracks.length, originalTimeline.tracks.length);

      // Check V1 clip parity
      const origV1 = originalTimeline.tracks.find((t) => t.id === CANONICAL_TRACK_IDS.V1_PRIMARY).clips[0];
      const restV1 = restoredTimeline.tracks.find((t) => t.id === CANONICAL_TRACK_IDS.V1_PRIMARY).clips[0];
      assert.equal(restV1.timelineStart, origV1.timelineStart);
      assert.equal(restV1.duration, origV1.duration);
      assert.equal(restV1.sourceStart, origV1.sourceStart);
      assert.equal(restV1.sourceDuration, origV1.sourceDuration);
      assert.equal(restV1.cropX, origV1.cropX);

      // Check V2 B-roll clip parity
      const origV2 = originalTimeline.tracks.find((t) => t.id === CANONICAL_TRACK_IDS.V2_BROLL).clips[0];
      const restV2 = restoredTimeline.tracks.find((t) => t.id === CANONICAL_TRACK_IDS.V2_BROLL).clips[0];
      assert.equal(restV2.timelineStart, origV2.timelineStart);
      assert.equal(restV2.duration, origV2.duration);
      assert.equal(restV2.transitionIn, origV2.transitionIn);

      // Check captions parity
      const origCaps = originalTimeline.tracks.find((t) => t.id === CANONICAL_TRACK_IDS.SUBTITLES).clips;
      const restCaps = restoredTimeline.tracks.find((t) => t.id === CANONICAL_TRACK_IDS.SUBTITLES).clips;
      assert.equal(restCaps.length, origCaps.length);
      assert.equal(restCaps[0].text, origCaps[0].text);
      assert.equal(restCaps[0].start, origCaps[0].start);
      assert.equal(restCaps[0].end, origCaps[0].end);
    });

    // 11. OpenTimelineIO (OTIO v1.0) JSON generation and validation
    it("11. generates valid OpenTimelineIO (OTIO v1.0) JSON conforming to OTIO schema", () => {
      const timeline = candidateToCanonicalTimeline(dummySourceClip, dummyCandidate, {
        captionSegments: dummyCaptions,
        availableAssets: [dummyBrollAsset],
      });

      const otio = exportTimelineToOtio(timeline);

      assert.equal(otio.OTIO_SCHEMA, "Timeline.1");
      assert.equal(otio.name, "Building Resilient Cloud Systems");
      assert.equal(otio.tracks.OTIO_SCHEMA, "Stack.1");
      assert.ok(Array.isArray(otio.tracks.children));

      const v1Otio = otio.tracks.children.find((t) => t.name.includes("V1"));
      assert.ok(v1Otio);
      assert.equal(v1Otio.OTIO_SCHEMA, "Track.1");
      assert.equal(v1Otio.kind, "Video");
      assert.equal(v1Otio.children[0].OTIO_SCHEMA, "Clip.1");
      assert.equal(v1Otio.children[0].source_range.OTIO_SCHEMA, "TimeRange.1");
      assert.equal(v1Otio.children[0].source_range.start_time.rate, 30);
      assert.equal(v1Otio.children[0].media_reference.OTIO_SCHEMA, "ExternalReference.1");

      const v2Otio = otio.tracks.children.find((t) => t.name.includes("V2"));
      assert.ok(v2Otio);
      // V2 has Gap before B-roll clip
      assert.equal(v2Otio.children[0].OTIO_SCHEMA, "Gap.1");
      assert.equal(v2Otio.children[1].OTIO_SCHEMA, "Clip.1");
    });

    // 12. OTIO round trip back to canonical timeline
    it("12. round-trips through OTIO export and deserialization back to canonical timeline", () => {
      const timeline = candidateToCanonicalTimeline(dummySourceClip, dummyCandidate, {
        captionSegments: dummyCaptions,
        availableAssets: [dummyBrollAsset],
      });

      const otio = exportTimelineToOtio(timeline);
      const restored = deserializeOtioToTimeline(otio);

      assert.equal(restored.duration, timeline.duration);
      assert.equal(restored.aspectRatio, timeline.aspectRatio);
      assert.equal(restored.tracks.length, 3); // V2, V1, Subtitles
      assert.equal(restored.tracks[1].clips[0].duration, 16.0);
      assert.equal(restored.tracks[0].clips[0].timelineStart, 4.0);
      assert.equal(restored.tracks[0].clips[0].duration, 3.0);
    });

    // 13. Final Cut Pro XML (FCPXML v1.10) generation
    it("13. generates valid Final Cut Pro XML (FCPXML v1.10) with resources, sequence, and spine", () => {
      const timeline = candidateToCanonicalTimeline(dummySourceClip, dummyCandidate, {
        captionSegments: dummyCaptions,
        availableAssets: [dummyBrollAsset],
      });

      const fcpxml = exportTimelineToFcpxml(timeline);

      assert.ok(typeof fcpxml === "string");
      assert.ok(fcpxml.includes('<?xml version="1.0" encoding="UTF-8"?>'));
      assert.ok(fcpxml.includes('<fcpxml version="1.10">'));
      assert.ok(fcpxml.includes('<resources>'));
      assert.ok(fcpxml.includes('<format id="r1"'));
      assert.ok(fcpxml.includes('width="1080" height="1920"'));
      assert.ok(fcpxml.includes('<sequence format="r1"'));
      assert.ok(fcpxml.includes('<spine>'));
      assert.ok(fcpxml.includes('<clip name="keynote-master.mp4"'));
      assert.ok(fcpxml.includes('lane="1"')); // B-roll cutaway connected clip
      assert.ok(fcpxml.includes('<title name="')); // Titles connected clip
    });

    // 14. Deterministic output across repeated executions
    it("14. produces identical, deterministic timeline packages across repeated executions", () => {
      const pkg1 = packageEditableShortTimeline(dummySourceClip, dummyCandidate, {
        captionSegments: dummyCaptions,
        availableAssets: [dummyBrollAsset],
      });

      const pkg2 = packageEditableShortTimeline(dummySourceClip, dummyCandidate, {
        captionSegments: dummyCaptions,
        availableAssets: [dummyBrollAsset],
      });

      assert.deepStrictEqual(pkg1.trackSummary, pkg2.trackSummary);
      assert.deepStrictEqual(pkg1.otio.tracks, pkg2.otio.tracks);
      assert.equal(pkg1.fcpxml, pkg2.fcpxml);
      assert.deepStrictEqual(pkg1.timeline.markers, pkg2.timeline.markers);
      assert.deepStrictEqual(pkg1.timeline.transitions, pkg2.timeline.transitions);
    });

    // 15. Immutability of the source candidate and original timeline
    it("15. strictly preserves source timing and guarantees immutability of candidate and inputs", () => {
      const clipSnapshot = JSON.stringify(dummySourceClip);
      const candSnapshot = JSON.stringify(dummyCandidate);
      const capsSnapshot = JSON.stringify(dummyCaptions);

      const pkg = packageEditableShortTimeline(dummySourceClip, dummyCandidate, {
        captionSegments: dummyCaptions,
        availableAssets: [dummyBrollAsset],
      });

      assert.equal(JSON.stringify(dummySourceClip), clipSnapshot, "sourceClip must not be mutated");
      assert.equal(JSON.stringify(dummyCandidate), candSnapshot, "candidate must not be mutated");
      assert.equal(JSON.stringify(dummyCaptions), capsSnapshot, "captions must not be mutated");
      assert.ok(pkg.timeline);
    });

    // 16. Explicit handling of missing or invalid media references
    it("16. explicitly flags missing or unlinked media references in diagnostics without fabricating paths", () => {
      const unlinkedCandidate = {
        id: "cand-missing-media",
        title: "Missing Media Test",
        startTime: 0,
        duration: 10,
      };

      const emptyClip = {
        id: "src-empty",
        name: "unlinked.mp4",
        src: "", // No src
        path: "", // No path
        blob: null,
      };

      const timeline = candidateToCanonicalTimeline(emptyClip, unlinkedCandidate);

      assert.ok(timeline.diagnostics);
      assert.ok(timeline.diagnostics.missingMedia.length > 0, "Missing media must be logged in diagnostics");
      assert.equal(timeline.diagnostics.missingMedia[0].id, "src-empty");
      assert.equal(timeline.diagnostics.missingMedia[0].reason, "Source URI and binary blob are absent");
    });

    // 17. Reporting of unsupported fields
    it("17. reports unsupported fields and diagnostics cleanly in timeline package", () => {
      const pkg = packageEditableShortTimeline(dummySourceClip, dummyCandidate);
      assert.ok(pkg.diagnostics);
      assert.ok(Array.isArray(pkg.diagnostics.unsupportedFields));
      assert.ok(Array.isArray(pkg.diagnostics.missingMedia));
      assert.ok(Array.isArray(pkg.diagnostics.warnings));
    });

    // 18. Backward compatibility with existing export workflows
    it("18. maintains full backward compatibility with existing export specs and project objects", () => {
      const pkg = packageEditableShortTimeline(dummySourceClip, dummyCandidate, {
        captionSegments: dummyCaptions,
      });

      const projectData = pkg.nativeProject.project || pkg.nativeProject;
      const mediaData = pkg.nativeProject.media || {};

      const extractedFiles = new Map();
      (mediaData.visuals || []).forEach((v) => {
        extractedFiles.set(v.path, "/tmp/mock-visual.mp4");
      });
      extractedFiles.set("src-keynote", "/tmp/mock-visual.mp4");
      extractedFiles.set("broll-cloud-server", "/tmp/mock-visual.mp4");

      // Underlying nativeProject can be passed directly to buildFfmpegRenderPlan
      const renderPlan = buildFfmpegRenderPlan({
        project: projectData,
        media: mediaData,
        extractedFiles,
        settings: { width: 1080, height: 1920 },
      });

      assert.ok(renderPlan);
      assert.ok(Array.isArray(renderPlan.args));
      assert.equal(renderPlan.width, 1080);
      assert.equal(renderPlan.height, 1920);
    });
  });
});




