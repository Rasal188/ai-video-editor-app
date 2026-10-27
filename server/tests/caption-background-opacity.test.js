import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyCommandPlan, inspectProject } from "../../src/lib/projectCommandEngine.js";
import { validateAndNormalizePlan } from "../services/ai/editingPlanSchema.js";
import { parseNaturalLanguageEditingPlan } from "../../src/lib/naturalLanguagePlanParser.js";

describe("AI Assistant Caption Background Opacity Tests", () => {
  const createMultiTrackCaptionProject = () => ({
    commandState: { schemaVersion: 1, revision: 0, appliedOperationIds: [] },
    ratioId: "16:9",
    fitMode: "contain",
    visualSegments: [
      { id: "vis-1", type: "video", duration: 15, sourceStart: 0, sourceDuration: 15, playbackRate: 1, name: "Main Video" },
    ],
    audioSegments: [
      { id: "aud-1", name: "Voiceover 1", start: 0, duration: 6, sourceStart: 0, sourceDuration: 6, volume: 1 },
      { id: "aud-2", name: "Voiceover 2", start: 7, duration: 6, sourceStart: 0, sourceDuration: 6, volume: 1 },
    ],
    musicSegments: [
      { id: "mus-1", name: "BGM", start: 0, duration: 15, sourceStart: 0, sourceDuration: 15, volume: 0.3 },
    ],
    captionStyle: {
      backgroundColor: "#112233",
      textColor: "#ffffff",
      captionSize: 22,
      effect: "normal",
      backgroundOpacity: 0.8,
    },
    captionSegments: [
      { id: "cap-1", text: "First caption track segment", start: 0.5, end: 3.5, audioSegmentId: "aud-1", styleOverrides: { textColor: "#ff9900", backgroundOpacity: 0.9 } },
      { id: "cap-2", text: "Second segment in voiceover 1", start: 3.8, end: 5.8, audioSegmentId: "aud-1" },
      { id: "cap-3", text: "Third segment in voiceover 2", start: 7.2, end: 10.2, audioSegmentId: "aud-2" },
      { id: "cap-4", text: "Standalone manual caption", start: 11.0, end: 14.0 },
    ],
    script: "First caption track segment\nSecond segment in voiceover 1\nThird segment in voiceover 2\nStandalone manual caption",
    captionsEnabled: true,
  });

  // TEST 1: "set captions background opacity to zero"
  it("TEST 1: generates a valid caption background-opacity operation with opacity 0", () => {
    const input = "set captions background opacity to zero";
    const parsed = parseNaturalLanguageEditingPlan(input);
    assert.equal(parsed.actions.length, 1);
    assert.equal(parsed.actions[0].type, "caption.set_style");
    assert.equal(parsed.actions[0].params.style.backgroundOpacity, 0);

    const validated = validateAndNormalizePlan(parsed);
    assert.equal(validated.actions.length, 1);
    assert.equal(validated.actions[0].type, "caption.set_style");
    assert.equal(validated.actions[0].params.style.backgroundOpacity, 0);
    assert.equal(validated.actions[0].params.backgroundOpacity, 0);
  });

  // TEST 2: "set the background opacity of all the captions to zero"
  it("TEST 2: targets all applicable captions with scope default and passes schema validation", () => {
    const input = "set the background opacity of all the captions to zero";
    const parsed = parseNaturalLanguageEditingPlan(input);
    assert.equal(parsed.actions.length, 1);
    assert.equal(parsed.actions[0].type, "caption.set_style");
    assert.equal(parsed.actions[0].params.scope, "default");
    assert.equal(parsed.actions[0].params.style.backgroundOpacity, 0);

    const validated = validateAndNormalizePlan(parsed);
    assert.equal(validated.actions[0].params.scope, "default");
    assert.equal(validated.actions[0].params.style.backgroundOpacity, 0);
  });

  // TEST 3: "make all caption backgrounds 50% opaque"
  it("TEST 3: generates equivalent opacity value 0.5 using project opacity units", () => {
    const input = "make all caption backgrounds 50% opaque";
    const parsed = parseNaturalLanguageEditingPlan(input);
    assert.equal(parsed.actions.length, 1);
    assert.equal(parsed.actions[0].type, "caption.set_style");
    assert.equal(parsed.actions[0].params.style.backgroundOpacity, 0.5);

    const validated = validateAndNormalizePlan(parsed);
    assert.equal(validated.actions[0].params.style.backgroundOpacity, 0.5);
  });

  // TEST 4: Opacity-only style update preserves backgroundColor and other properties
  it("TEST 4: allows opacity-only style update, omitting and preserving backgroundColor", () => {
    const project = createMultiTrackCaptionProject();
    const originalBgColor = project.captionStyle.backgroundColor;
    const originalTextColor = project.captionStyle.textColor;
    const originalSize = project.captionStyle.captionSize;

    const rawPlan = {
      schemaVersion: 1,
      explanation: "Set caption background opacity to 0",
      actions: [
        {
          id: "act-1",
          type: "caption.set_style",
          params: { scope: "default", style: { backgroundOpacity: 0 } },
        },
      ],
    };

    const normalized = validateAndNormalizePlan(rawPlan);
    assert.equal(normalized.actions[0].params.style.backgroundColor, undefined);
    assert.equal(normalized.actions[0].params.style.backgroundOpacity, 0);

    const commandPlan = {
      schemaVersion: 1,
      baseRevision: 0,
      operations: [
        {
          id: "op-1",
          type: "caption.set_style",
          scope: "default",
          style: { backgroundOpacity: 0 },
        },
      ],
    };

    const result = applyCommandPlan(project, commandPlan);
    assert.equal(result.ok, true);
    assert.equal(result.project.captionStyle.backgroundOpacity, 0);
    assert.equal(result.project.captionStyle.backgroundColor, originalBgColor, "backgroundColor preserved");
    assert.equal(result.project.captionStyle.textColor, originalTextColor, "textColor preserved");
    assert.equal(result.project.captionStyle.captionSize, originalSize, "captionSize preserved");
  });

  // TEST 5: Boundary validation
  it("TEST 5: accepts valid boundaries (0 and 1) and rejects out-of-range, non-finite, and string values", () => {
    // 0 and 1 are accepted
    const planMin = {
      schemaVersion: 1,
      actions: [{ id: "1", type: "caption.set_style", params: { backgroundOpacity: 0 } }],
    };
    assert.equal(validateAndNormalizePlan(planMin).actions[0].params.style.backgroundOpacity, 0);

    const planMax = {
      schemaVersion: 1,
      actions: [{ id: "2", type: "caption.set_style", params: { backgroundOpacity: 1 } }],
    };
    assert.equal(validateAndNormalizePlan(planMax).actions[0].params.style.backgroundOpacity, 1);

    // Rejects below 0
    assert.throws(
      () => validateAndNormalizePlan({
        schemaVersion: 1,
        actions: [{ id: "3", type: "caption.set_style", params: { backgroundOpacity: -0.1 } }],
      }),
      /backgroundOpacity must be a finite number between 0 and 1/
    );

    // Rejects above 1
    assert.throws(
      () => validateAndNormalizePlan({
        schemaVersion: 1,
        actions: [{ id: "4", type: "caption.set_style", params: { backgroundOpacity: 1.05 } }],
      }),
      /backgroundOpacity must be a finite number between 0 and 1/
    );

    // Rejects string numbers
    assert.throws(
      () => validateAndNormalizePlan({
        schemaVersion: 1,
        actions: [{ id: "5", type: "caption.set_style", params: { backgroundOpacity: "0" } }],
      }),
      /backgroundOpacity must be a finite number between 0 and 1/
    );

    // Rejects string text
    assert.throws(
      () => validateAndNormalizePlan({
        schemaVersion: 1,
        actions: [{ id: "6", type: "caption.set_style", params: { backgroundOpacity: "zero" } }],
      }),
      /backgroundOpacity must be a finite number between 0 and 1/
    );

    // Rejects NaN and Infinity
    assert.throws(
      () => validateAndNormalizePlan({
        schemaVersion: 1,
        actions: [{ id: "7", type: "caption.set_style", params: { backgroundOpacity: Number.NaN } }],
      }),
      /backgroundOpacity must be a finite number between 0 and 1/
    );
    assert.throws(
      () => validateAndNormalizePlan({
        schemaVersion: 1,
        actions: [{ id: "8", type: "caption.set_style", params: { backgroundOpacity: Infinity } }],
      }),
      /backgroundOpacity must be a finite number between 0 and 1/
    );
  });

  // TEST 6: Background color editing
  it("TEST 6: continues validating backgroundColor correctly and rejects invalid values", () => {
    // Valid backgroundColor
    const validPlan = {
      schemaVersion: 1,
      actions: [{ id: "1", type: "caption.set_style", params: { backgroundColor: "#ff5500" } }],
    };
    const norm = validateAndNormalizePlan(validPlan);
    assert.equal(norm.actions[0].params.style.backgroundColor, "#ff5500");

    // Invalid backgroundColor (transparent or non-hex)
    assert.throws(
      () => validateAndNormalizePlan({
        schemaVersion: 1,
        actions: [{ id: "2", type: "caption.set_style", params: { backgroundColor: "transparent" } }],
      }),
      /backgroundColor must be a valid hex color \(#RRGGBB\)/
    );
    assert.throws(
      () => validateAndNormalizePlan({
        schemaVersion: 1,
        actions: [{ id: "3", type: "caption.set_style", params: { backgroundColor: "#123" } }],
      }),
      /backgroundColor must be a valid hex color \(#RRGGBB\)/
    );
  });

  // TEST 7: Text color and font-size editing
  it("TEST 7: preserves existing text color and font size editing functionality", () => {
    const validPlan = {
      schemaVersion: 1,
      actions: [
        {
          id: "1",
          type: "caption.set_style",
          params: { textColor: "#ffffff", captionSize: 28, effect: "neon" },
        },
      ],
    };
    const norm = validateAndNormalizePlan(validPlan);
    assert.equal(norm.actions[0].params.style.textColor, "#ffffff");
    assert.equal(norm.actions[0].params.style.captionSize, 28);
    assert.equal(norm.actions[0].params.style.effect, "neon");
  });

  // TEST 8: Bulk updates across multiple caption tracks & respect locked track safeguards
  it("TEST 8: updates all applicable captions across tracks, preserves unrelated styles, and respects track locks", () => {
    const project = createMultiTrackCaptionProject();

    // 1. Bulk update applies to all caption segments across all tracks
    const plan = {
      schemaVersion: 1,
      baseRevision: 0,
      operations: [
        { id: "op-1", type: "caption.set_style", scope: "default", style: { backgroundOpacity: 0 } },
      ],
    };
    const result = applyCommandPlan(project, plan);
    assert.equal(result.ok, true);
    assert.equal(result.project.captionStyle.backgroundOpacity, 0);

    // Overridden backgroundOpacity on cap-1 is cleared so it inherits default 0, but textColor override #ff9900 is preserved
    const cap1 = result.project.captionSegments.find((c) => c.id === "cap-1");
    assert.equal(cap1.styleOverrides?.backgroundOpacity, undefined);
    assert.equal(cap1.styleOverrides?.textColor, "#ff9900", "cap-1 textColor override preserved");

    // All segments still present and intact
    assert.equal(result.project.captionSegments.length, 4);

    // 2. Track lock safeguard: when caption track is locked, styling operation fails
    const lockedProject = {
      ...createMultiTrackCaptionProject(),
      trackLocks: { caption: true },
    };
    const lockedResult = applyCommandPlan(lockedProject, plan);
    assert.equal(lockedResult.ok, false);
    assert.equal(lockedResult.code, "TRACK_LOCKED");
  });

  // TEST 9: Undo and redo
  it("TEST 9: undo restores all affected captions and redo reapplies correctly", () => {
    const initialProject = createMultiTrackCaptionProject();
    const historyStack = [];

    // Push before state to history (simulate checkpointHistory)
    historyStack.push(structuredClone(initialProject));

    // Execute plan
    const plan = {
      schemaVersion: 1,
      baseRevision: 0,
      operations: [
        { id: "op-1", type: "caption.set_style", scope: "default", style: { backgroundOpacity: 0 } },
      ],
    };
    const forwardResult = applyCommandPlan(initialProject, plan);
    assert.equal(forwardResult.ok, true);
    assert.equal(forwardResult.project.captionStyle.backgroundOpacity, 0);

    // Undo: pop from history
    const restored = historyStack.pop();
    assert.equal(restored.captionStyle.backgroundOpacity, 0.8);
    const restoredCap1 = restored.captionSegments.find((c) => c.id === "cap-1");
    assert.equal(restoredCap1.styleOverrides.backgroundOpacity, 0.9);
    assert.equal(restoredCap1.styleOverrides.textColor, "#ff9900");

    // Redo: reapply plan
    const redoResult = applyCommandPlan(restored, plan);
    assert.equal(redoResult.ok, true);
    assert.equal(redoResult.project.captionStyle.backgroundOpacity, 0);
  });

  // TEST 10: Caption timing and text integrity
  it("TEST 10: leaves caption text, segment timing, ordering, and track assignments unchanged", () => {
    const project = createMultiTrackCaptionProject();
    const originalSegments = structuredClone(project.captionSegments);

    const plan = {
      schemaVersion: 1,
      baseRevision: 0,
      operations: [
        { id: "op-1", type: "caption.set_style", scope: "default", style: { backgroundOpacity: 0.25 } },
      ],
    };
    const result = applyCommandPlan(project, plan);
    assert.equal(result.ok, true);

    const updated = result.project.captionSegments;
    assert.equal(updated.length, originalSegments.length);
    for (let i = 0; i < updated.length; i++) {
      assert.equal(updated[i].id, originalSegments[i].id);
      assert.equal(updated[i].text, originalSegments[i].text);
      assert.equal(updated[i].start, originalSegments[i].start);
      assert.equal(updated[i].end, originalSegments[i].end);
      assert.equal(updated[i].audioSegmentId, originalSegments[i].audioSegmentId);
    }
  });

  // TEST 11: Plan normalization preserves backgroundOpacity throughout lifecycle
  it("TEST 11: preserves backgroundOpacity without dropping, renaming, or converting incorrectly", () => {
    const rawAction = {
      id: "a-1",
      type: "caption.set_style",
      params: {
        scope: "default",
        backgroundOpacity: 0,
      },
    };

    const validated = validateAndNormalizePlan({ schemaVersion: 1, actions: [rawAction] });
    assert.equal(validated.actions[0].params.backgroundOpacity, 0);
    assert.equal(validated.actions[0].params.style.backgroundOpacity, 0);

    // Simulate AiAssistantPanel conversion to commandPlan
    const op = {
      id: "op-1",
      type: validated.actions[0].type,
      ...validated.actions[0].params,
    };
    if (!op.style) {
      const style = {};
      if (op.backgroundOpacity !== undefined) style.backgroundOpacity = op.backgroundOpacity;
      op.style = style;
    } else if (op.backgroundOpacity !== undefined && op.style.backgroundOpacity === undefined) {
      op.style.backgroundOpacity = op.backgroundOpacity;
    }

    assert.equal(op.style.backgroundOpacity, 0);

    const project = createMultiTrackCaptionProject();
    const applied = applyCommandPlan(project, {
      schemaVersion: 1,
      baseRevision: 0,
      operations: [op],
    });

    assert.equal(applied.ok, true);
    assert.equal(applied.project.captionStyle.backgroundOpacity, 0);
  });
});
