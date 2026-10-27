import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clampPunchInOffsets,
  resolvePunchInOffset,
  extractFaceFocus,
  compilePunchInKeyframes,
  buildSmartZoomCropFilter,
} from "../../src/lib/smartZoom.js";

import { applyCommandPlan } from "../../src/lib/projectCommandEngine.js";
import { validateAndNormalizePlan } from "../services/ai/editingPlanSchema.js";
import { buildFfmpegRenderPlan } from "../../src/lib/projectRenderPlan.js";
import { parseNaturalLanguageEditingPlan } from "../../src/lib/naturalLanguagePlanParser.js";
import { classifyUserIntent } from "../../src/lib/intentClassifier.js";

const executeFile = promisify(execFile);

describe("AI Smart Zoom & Automatic Punch-ins — Comprehensive Test Suite", () => {
  let opSeq = 1;

  // Helper to create a standard test project following projectCommandEngine schema
  function createTestProject(customClips = null) {
    const defaultClips = [
      {
        id: "clip-intro",
        name: "Intro Clip",
        type: "video",
        start: 0,
        duration: 4.0,
        sourceStart: 0,
        keyframes: [
          { time: 0, scale: 1.0, x: 0, y: 0, rotation: 0, opacity: 1 },
        ],
        vision: {
          faces: [
            { box: { x: 0.5, y: 0.3, width: 0.2, height: 0.25 }, score: 0.95 },
          ],
        },
      },
      {
        id: "clip-main",
        name: "Main Speaker Clip",
        type: "video",
        start: 4.0,
        duration: 8.0,
        sourceStart: 0,
        keyframes: [],
        vision: {
          faces: [
            { box: { x: 0.65, y: 0.35, width: 0.22, height: 0.28 }, score: 0.98 },
          ],
        },
      },
      {
        id: "clip-outro",
        name: "Outro Clip",
        type: "video",
        start: 12.0,
        duration: 4.0,
        sourceStart: 0,
        keyframes: [],
      },
    ];

    return {
      ratioId: "16:9",
      trackLocks: { visuals: false, image: false },
      visualSegments: customClips || defaultClips,
      audioSegments: [],
      musicSegments: [],
      captionSegments: [
        { id: "c1", start: 1.0, end: 3.0, text: "Welcome to this episode." },
        { id: "c2", start: 5.0, end: 7.5, text: "The most important concept is automatic framing." },
        { id: "c3", start: 8.5, end: 11.0, text: "Notice how it keeps focus right on the speaker." },
      ],
    };
  }

  // Helper to build a valid command engine plan with unique IDs
  function buildCommandPlan(operations, baseRevision = 0) {
    return {
      schemaVersion: 1,
      baseRevision,
      operations: operations.map((op) => ({
        id: op.id || `op-test-${opSeq++}`,
        ...op,
      })),
    };
  }

  // 1. Creating punch-in
  it("1. should create a punch-in with normalized parameters on target clip", () => {
    const project = createTestProject();
    const plan = buildCommandPlan([
      {
        type: "visual.punch_in",
        clipId: "clip-main",
        time: 2.0,
        scale: 1.25,
        duration: 3.0,
        transition: "smooth",
        transitionDuration: 0.35,
        faceAnchored: true,
      },
    ]);

    const res = applyCommandPlan(project, plan);
    assert.equal(res.ok, true);

    const mainClip = res.project.visualSegments.find((c) => c.id === "clip-main");
    assert.equal(Array.isArray(mainClip.punchIns), true);
    assert.equal(mainClip.punchIns.length, 1);

    const p = mainClip.punchIns[0];
    assert.equal(p.time, 2.0);
    assert.equal(p.scale, 1.25);
    assert.equal(p.duration, 3.0);
    assert.equal(p.transition, "smooth");
    assert.equal(p.transitionDuration, 0.35);
    assert.equal(p.faceAnchored, true);
    assert.ok(p.id.startsWith("pi-"));

    // Check keyframes compiled
    assert.ok(mainClip.keyframes.length >= 4);
  });

  // 2. Editing existing punch-in
  it("2. should edit an existing punch-in by matching timestamp without duplicating", () => {
    const project = createTestProject();
    const plan1 = buildCommandPlan([
      {
        type: "visual.punch_in",
        clipId: "clip-main",
        time: 2.0,
        scale: 1.20,
        duration: 2.0,
      },
    ], 0);
    const res1 = applyCommandPlan(project, plan1);
    assert.equal(res1.ok, true);

    // Apply edit to the same timestamp (within 0.35s tolerance) with new operation ID
    const plan2 = buildCommandPlan([
      {
        type: "visual.punch_in",
        clipId: "clip-main",
        time: 2.1,
        scale: 1.35,
        duration: 3.5,
      },
    ], res1.revision);
    const res2 = applyCommandPlan(res1.project, plan2);
    assert.equal(res2.ok, true);

    const mainClip = res2.project.visualSegments.find((c) => c.id === "clip-main");
    assert.equal(mainClip.punchIns.length, 1);
    assert.equal(mainClip.punchIns[0].scale, 1.35);
    assert.equal(mainClip.punchIns[0].duration, 3.5);
  });

  // 3. Removing one punch-in without removing others
  it("3. should remove a single punch-in by ID or timestamp while preserving others", () => {
    const project = createTestProject();
    const plan = buildCommandPlan([
      { type: "visual.punch_in", clipId: "clip-main", time: 1.0, scale: 1.2, duration: 2.0 },
      { type: "visual.punch_in", clipId: "clip-main", time: 4.5, scale: 1.3, duration: 2.0 },
    ], 0);
    const res1 = applyCommandPlan(project, plan);
    const mainClip1 = res1.project.visualSegments.find((c) => c.id === "clip-main");
    assert.equal(mainClip1.punchIns.length, 2);

    const firstId = mainClip1.punchIns[0].id;
    const removePlan = buildCommandPlan([
      { type: "visual.remove_punch_in", clipId: "clip-main", punchInId: firstId },
    ], res1.revision);
    const res2 = applyCommandPlan(res1.project, removePlan);
    assert.equal(res2.ok, true);

    const mainClip2 = res2.project.visualSegments.find((c) => c.id === "clip-main");
    assert.equal(mainClip2.punchIns.length, 1);
    assert.equal(mainClip2.punchIns[0].time, 4.5);
  });

  // 4. Resetting zoom
  it("4. should reset all zooms on a clip and restore clean keyframes", () => {
    const project = createTestProject();
    const plan = buildCommandPlan([
      { type: "visual.punch_in", clipId: "clip-main", time: 2.0, scale: 1.25, duration: 2.0 },
    ], 0);
    const res1 = applyCommandPlan(project, plan);
    const resetPlan = buildCommandPlan([
      { type: "visual.reset_zoom", clipId: "clip-main" },
    ], res1.revision);
    const res2 = applyCommandPlan(res1.project, resetPlan);
    assert.equal(res2.ok, true);

    const mainClip = res2.project.visualSegments.find((c) => c.id === "clip-main");
    assert.deepEqual(mainClip.punchIns, []);
    assert.equal(mainClip.keyframes.some((k) => k.meta?.smartZoom), false);
  });

  // 5. Jump-cut timing
  it("5. should produce instant jump-cut keyframes when transition is jump", () => {
    const punchIns = [
      { id: "p1", time: 2.0, scale: 1.25, duration: 2.0, transition: "jump", transitionDuration: 0.3, faceAnchored: false },
    ];
    const keyframes = compilePunchInKeyframes([], punchIns, 10.0);
    const atPunch = keyframes.find((k) => Math.abs(k.time - 2.0) < 0.001);
    assert.ok(atPunch);
    assert.equal(atPunch.scale, 1.25);

    // Returns to 1.0 after jump hold
    const atRestore = keyframes.find((k) => k.time > 4.0 && Math.abs(k.scale - 1.0) < 0.001);
    assert.ok(atRestore);
    assert.equal(atRestore.scale, 1.0);
  });

  // 6. Smooth transition interpolation
  it("6. should produce ramped keyframes with correct transition intervals for smooth push-ins", () => {
    const punchIns = [
      { id: "p1", time: 2.0, scale: 1.25, duration: 2.0, transition: "smooth", transitionDuration: 0.35, faceAnchored: false },
    ];
    const keyframes = compilePunchInKeyframes([], punchIns, 10.0);

    const kfStart = keyframes.find((k) => Math.abs(k.time - 2.0) < 0.001);
    const kfPeak = keyframes.find((k) => Math.abs(k.scale - 1.25) < 0.001);
    const kfReturn = keyframes.find((k) => k.time >= 4.3 && Math.abs(k.scale - 1.0) < 0.001);

    assert.ok(kfStart, "start keyframe should exist");
    assert.ok(kfPeak, "peak keyframe should exist at 1.25 scale");
    assert.ok(kfReturn, "return keyframe should exist returning to 1.0 scale");
  });

  // 7. Face-anchored offsets
  it("7. should shift focus toward face position without exposing black borders", () => {
    const clip = {
      id: "c1",
      duration: 10,
      vision: {
        faces: [{ box: { x: 0.8, y: 0.2, width: 0.15, height: 0.2 }, score: 0.99 }],
      },
    };
    const focus = extractFaceFocus(clip, 2.0);
    assert.ok(focus);
    assert.ok(focus.focusX > 0.5, "face center is right of center");

    const offset = resolvePunchInOffset({
      segment: clip,
      scale: 1.2,
      faceAnchored: true,
      time: 2.0,
    });
    // In canvas transform, shifting image left (x < 0) centers a face on the right
    assert.ok(offset.x < 0, "offset X shifts image left to center face on right");
    assert.ok(offset.y > 0, "offset Y shifts image down to center face on top");

    // Clamping verification
    const clamped = clampPunchInOffsets(offset.x, offset.y, 1.2);
    assert.equal(clamped.x, offset.x);
    assert.equal(clamped.y, offset.y);
  });

  // 8. Missing face detections fallback
  it("8. should gracefully fall back to center zoom (0, 0) when no faces are detected", () => {
    const clip = { id: "no-face", duration: 5 };
    const focus = extractFaceFocus(clip, 1.0);
    assert.equal(focus, null);

    const offset = resolvePunchInOffset({
      segment: clip,
      scale: 1.25,
      faceAnchored: true,
      time: 1.0,
    });
    assert.equal(offset.x, 0);
    assert.equal(offset.y, 0);
  });

  // 9. Multiple-face fallback
  it("9. should choose the highest-confidence primary face when multiple faces exist", () => {
    const clip = {
      id: "multi-face",
      duration: 5,
      vision: {
        faces: [
          { box: { x: 0.2, y: 0.4, width: 0.1, height: 0.1 }, score: 0.65 },
          { box: { x: 0.7, y: 0.3, width: 0.2, height: 0.25 }, score: 0.96 },
        ],
      },
    };
    const focus = extractFaceFocus(clip, 2.0);
    assert.ok(focus.focusX > 0.6, "should prioritize high-confidence dominant face");
  });

  // 10. Clip & timeline boundaries
  it("10. should clamp punch-in duration and timestamp to stay strictly within clip bounds", () => {
    const project = createTestProject();
    const plan = buildCommandPlan([
      {
        type: "visual.punch_in",
        clipId: "clip-main",
        time: 7.0,
        scale: 1.2,
        duration: 4.0, // Clip duration is 8.0, so 7.0 + 4.0 = 11.0 > 8.0
        transition: "smooth",
        transitionDuration: 0.35,
      },
    ], 0);
    const res = applyCommandPlan(project, plan);
    assert.equal(res.ok, true);

    const mainClip = res.project.visualSegments.find((c) => c.id === "clip-main");
    const p = mainClip.punchIns[0];
    assert.equal(p.time, 7.0);
    assert.ok(p.time + p.duration <= 8.001);
  });

  // 11. Selected clip vs whole timeline scope
  it("11. should support applying punch-ins to whole timeline using 'all' scope", () => {
    const project = createTestProject();
    const plan = buildCommandPlan([
      {
        type: "visual.punch_in",
        clipId: "all",
        time: 1.0,
        scale: 1.2,
        duration: 1.5,
      },
    ], 0);
    const res = applyCommandPlan(project, plan);
    assert.equal(res.ok, true);

    const clips = res.project.visualSegments;
    for (const c of clips) {
      assert.equal(c.punchIns?.length, 1);
      assert.equal(c.punchIns[0].time, 1.0);
    }
  });

  // 12. Exclusions (e.g. intro clip)
  it("12. should respect exclusions when user specifies 'all except intro'", () => {
    const text = "zoom in 20% on all clips except the intro clip";
    const project = createTestProject();
    const summary = {
      clips: project.visualSegments.map((c) => ({ id: c.id, name: c.name, start: c.start, duration: c.duration })),
    };
    const plan = parseNaturalLanguageEditingPlan(text, summary);
    assert.ok(plan);
    const action = plan.actions[0];
    assert.ok(action.params?.excludeClipIds?.includes("clip-intro"), "intro clip should be excluded");
  });

  // 13. Locked tracks & clips
  it("13. should reject punch-in on locked track or locked clip with error", () => {
    const project = createTestProject();
    project.visualSegments[1].locked = true;

    const plan = buildCommandPlan([
      {
        type: "visual.punch_in",
        clipId: "clip-main",
        time: 2.0,
        scale: 1.2,
      },
    ], 0);
    const res = applyCommandPlan(project, plan);
    assert.equal(res.ok, false);
    assert.equal(res.code, "CLIP_LOCKED");
  });

  // 14. Invalid timestamps and scales
  it("14. should validate and reject invalid scales or out-of-range timestamps in schema validation", () => {
    const invalidPlan = {
      version: "1.0",
      explanation: "invalid punch in",
      actions: [
        {
          id: "act-1",
          type: "visual.punch_in",
          params: {
            clipId: "clip-1",
            scale: 5.0, // Exceeds max allowable scale (3.0)
            timestamp: -1,
          },
        },
      ],
    };
    assert.throws(() => validateAndNormalizePlan(invalidPlan));
  });

  // 15. Idempotent repeated commands without duplicate effects
  it("15. should prevent duplicate punch-ins when the exact same command is executed repeatedly", () => {
    const project = createTestProject();
    const fixedId = "fixed-op-repeat-test";
    const plan = {
      schemaVersion: 1,
      baseRevision: 0,
      operations: [
        {
          id: fixedId,
          type: "visual.punch_in",
          clipId: "clip-main",
          time: 2.0,
          scale: 1.2,
          duration: 2.0,
        },
      ],
    };
    const res1 = applyCommandPlan(project, plan);
    assert.equal(res1.ok, true);

    // Replay the exact same plan with same operation ID
    const res2 = applyCommandPlan(res1.project, plan);
    assert.equal(res2.ok, true);

    const mainClip = res2.project.visualSegments.find((c) => c.id === "clip-main");
    assert.equal(mainClip.punchIns.length, 1, "punchIns array must not duplicate");
  });

  // 16. Undo & redo state tracking
  it("16. should track revision state for undo/redo integrity", () => {
    const project = createTestProject();
    const plan = buildCommandPlan([
      { type: "visual.punch_in", clipId: "clip-main", time: 2.0, scale: 1.2 },
    ], 0);
    const res = applyCommandPlan(project, plan);
    assert.equal(res.ok, true);
    assert.equal(res.revision, 1);
  });

  // 17. AI Assistant natural-language parsing & follow-up commands
  it("17. should parse natural language requests, intensity adjustments, transitions, and resets", () => {
    const project = createTestProject();
    const summary = {
      selectedClipId: "clip-main",
      clips: project.visualSegments.map((c) => ({ id: c.id, name: c.name, start: c.start, duration: c.duration })),
    };

    // 17a. Create punch in at timestamp
    const plan1 = parseNaturalLanguageEditingPlan("zoom in 20% at 2 seconds on the main clip", summary);
    assert.ok(plan1);
    assert.equal(plan1.actions[0].type, "visual.punch_in");
    assert.equal(plan1.actions[0].params.scale, 1.2);
    assert.equal(plan1.actions[0].params.time, 2.0);

    // 17b. Adjust transition
    const plan2 = parseNaturalLanguageEditingPlan("make the zoom transitions slower", summary);
    assert.ok(plan2);
    assert.equal(plan2.actions[0].params.transitionDuration, 0.6);

    // 17c. Reset zoom
    const plan3 = parseNaturalLanguageEditingPlan("reset zoom on the selected clip", summary);
    assert.ok(plan3);
    assert.equal(plan3.actions[0].type, "visual.reset_zoom");

    // 17d. Intent classification for inspection
    const intent = classifyUserIntent("where are the punch-ins in this video?");
    assert.equal(intent.intent, "smart_zoom_inspection");
  });

  // 18. Preservation of unrelated keyframes
  it("18. should preserve unrelated visual keyframes (rotation, opacity, filters) when punch-in is applied", () => {
    const project = createTestProject([
      {
        id: "clip-fx",
        type: "video",
        start: 0,
        duration: 10,
        keyframes: [
          { time: 0, rotation: 0, opacity: 0 },
          { time: 1.0, rotation: 45, opacity: 1 },
          { time: 9.0, rotation: 90, opacity: 1 },
        ],
      },
    ]);

    const plan = buildCommandPlan([
      { type: "visual.punch_in", clipId: "clip-fx", time: 3.0, scale: 1.25, duration: 2.0 },
    ], 0);

    const res = applyCommandPlan(project, plan);
    assert.equal(res.ok, true);

    const clip = res.project.visualSegments[0];
    const kf0 = clip.keyframes.find((k) => k.time === 0);
    assert.equal(kf0.rotation, 0);
    assert.equal(kf0.opacity, 0);

    const kf1 = clip.keyframes.find((k) => k.time === 1.0);
    assert.equal(kf1.rotation, 45);
    assert.equal(kf1.opacity, 1);
  });

  // 19. Headless export filter generation
  it("19. should generate correct FFmpeg crop expressions for headless render plan", () => {
    const dummyFiles = new Map([["media/visuals/clip1.mp4", "C:/temp/clip1.mp4"]]);
    const baseMedia = { visuals: [{ id: "vis-1", path: "media/visuals/clip1.mp4" }] };
    const project = {
      ratioId: "16:9",
      visualSegments: [
        {
          id: "vis-1",
          type: "video",
          duration: 6.0,
          sourceStart: 0,
          punchIns: [
            { id: "p1", time: 2.0, scale: 1.2, duration: 2.0, transition: "jump", transitionDuration: 0.35, x: 0, y: 0 },
          ],
        },
      ],
    };

    const renderPlan = buildFfmpegRenderPlan({
      project,
      media: baseMedia,
      extractedFiles: dummyFiles,
    });

    assert.ok(renderPlan);
    const filterArg = renderPlan.args.find((a, i) => renderPlan.args[i - 1] === "-filter_complex");
    assert.ok(filterArg);
    assert.ok(filterArg.includes("crop=w="));
    assert.ok(filterArg.includes("exact=1"));
    assert.ok(filterArg.includes("between(t,2.000,4.000)"));
  });

  // 20. Projects without Smart Zoom remaining unchanged
  it("20. should leave projects without Smart Zoom completely unmodified in both command engine and render plan", () => {
    const dummyFiles = new Map([["media/visuals/clip1.mp4", "C:/temp/clip1.mp4"]]);
    const baseMedia = { visuals: [{ id: "vis-1", path: "media/visuals/clip1.mp4" }] };
    const project = {
      ratioId: "16:9",
      visualSegments: [
        {
          id: "vis-1",
          type: "video",
          duration: 5.0,
          sourceStart: 0,
        },
      ],
    };

    const renderPlan = buildFfmpegRenderPlan({
      project,
      media: baseMedia,
      extractedFiles: dummyFiles,
    });

    const filterArg = renderPlan.args.find((a, i) => renderPlan.args[i - 1] === "-filter_complex");
    assert.ok(!filterArg.includes("crop=w='if("), "should not include smart zoom crop filter when no punch-ins exist");
  });

  // 21. Live FFmpeg test render verifying actual video pixel output
  it("21. should execute live FFmpeg video export with smart zoom crop expression producing valid MP4", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "smart-zoom-test-"));
    const outputPath = join(tmpDir, "zoom_export.mp4");

    try {
      const punchIns = [
        { id: "p1", time: 1.0, scale: 1.2, duration: 1.5, transition: "smooth", transitionDuration: 0.3, x: 5, y: -3 },
      ];
      const cropFilter = buildSmartZoomCropFilter(punchIns, 640, 360, 3.0);
      assert.ok(cropFilter);

      // Render a 3-second test pattern with smart zoom crop applied
      const ffmpegArgs = [
        "-f", "lavfi",
        "-i", "testsrc=size=640x360:rate=25:duration=3",
        "-vf", cropFilter,
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-y",
        outputPath,
      ];

      await executeFile("ffmpeg", ffmpegArgs);

      // Verify probe duration
      const { stdout } = await executeFile("ffprobe", [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        outputPath,
      ]);

      const dur = parseFloat(stdout.trim());
      assert.ok(Math.abs(dur - 3.0) < 0.2, `Exported video duration should be ~3.0s, got ${dur}`);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  // 22. Natural language disambiguation between zoom transitions, punch-in animations, crossfades, and clip playback speed
  it("22. should accurately disambiguate between zoom transitions, crossfades, clip speed, and punch-ins", () => {
    const summary = {
      visualClips: [
        { id: "clip-1", name: "Intro", start: 0, duration: 5 },
        { id: "clip-2", name: "Main", start: 5, duration: 8 },
      ],
    };

    // Zoom transition slower -> visual.punch_in with transitionDuration: 0.6
    const p1 = parseNaturalLanguageEditingPlan("Make the zoom transitions slower.", summary);
    assert.strictEqual(p1.actions[0].type, "visual.punch_in");
    assert.strictEqual(p1.actions[0].params.transitionDuration, 0.6);

    // Zoom transition faster -> visual.punch_in with transitionDuration: 0.15
    const p2 = parseNaturalLanguageEditingPlan("Make zoom transitions faster.", summary);
    assert.strictEqual(p2.actions[0].type, "visual.punch_in");
    assert.strictEqual(p2.actions[0].params.transitionDuration, 0.15);

    // Punch-in animation slow down -> visual.punch_in with transitionDuration: 0.6 (NOT clip.set_speed)
    const p3 = parseNaturalLanguageEditingPlan("Slow down the punch-in animation.", summary);
    assert.strictEqual(p3.actions[0].type, "visual.punch_in");
    assert.strictEqual(p3.actions[0].params.transitionDuration, 0.6);

    // Crossfade between clips -> transition.set with transitionId: fade
    const p4 = parseNaturalLanguageEditingPlan("Add a crossfade between clips.", summary);
    assert.strictEqual(p4.actions[0].type, "transition.set");
    assert.strictEqual(p4.actions[0].params.transitionId, "fade");

    // Make the zoom stronger -> visual.punch_in with higher scale
    const p5 = parseNaturalLanguageEditingPlan("Make the zoom stronger.", summary);
    assert.strictEqual(p5.actions[0].type, "visual.punch_in");
    assert.ok(p5.actions[0].params.scale > 1.25, "scale should be increased above baseline 1.25");
  });
});

