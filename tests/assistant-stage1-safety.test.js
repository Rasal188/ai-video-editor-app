import test from "node:test";
import assert from "node:assert/strict";
import { createAssistantProjectClock, captureAssistantBase, assertAssistantBase, prepareAssistantProposal, assertDestructiveAssistantTargets, assertAssistantOperationUnlocked, assertAssistantChangedTracksUnlocked } from "../src/lib/assistantSafety.js";
import { parseNaturalLanguageEditingPlan } from "../src/lib/naturalLanguagePlanParser.js";

const fixture = () => ({ visualSegments: [{ id: "v1", duration: 4 }, { id: "v2", duration: 4 }], captionSegments: [{ id: "c1", start: 0, end: 1, text: "Existing" }], audioSegments: [], musicSegments: [], trackLocks: {} });
test("project clock observes edits, undo/redo, media replacement, lifecycle and import ownership", () => {
    const clock = createAssistantProjectClock();
    const project = fixture();
    const source = new Blob(["a"]);
    project.commandState = clock.observe(project, [source]);
    const base = captureAssistantBase(project);
    assertAssistantBase(project, base);
    assert.equal(clock.observe(project, [source]).revision, 0);
    project.visualSegments[0].duration = 3;
    project.commandState = clock.observe(project, [source]);
    assert.equal(project.commandState.revision, 1);
    assert.throws(() => assertAssistantBase(project, base), { code: "BROWSER_EDIT_STALE_PLAN" });
    project.visualSegments[0].duration = 4;
    project.commandState = clock.observe(project, [source]);
    assert.equal(project.commandState.revision, 2);
    project.commandState = clock.observe(project, [new Blob(["a"])]);
    assert.equal(project.commandState.revision, 3);
    clock.commit({ revision: 4, appliedOperationIds: ["approved-op"] });
    project.commandState = clock.observe(project, [source]);
    assert.ok(project.commandState.appliedOperationIds.includes("approved-op"));
    const currentBase = captureAssistantBase(project);
    clock.setChanging(true);
    project.commandState = clock.observe(project, [source]);
    assert.throws(() => assertAssistantBase(project, currentBase));
    clock.setChanging(false);
    clock.replace({ appliedOperationIds: ["imported-op"] });
    project.commandState = clock.observe(project, [source]);
    assert.notEqual(project.commandState.projectIdentity, base.projectIdentity);
    assert.deepEqual(project.commandState.appliedOperationIds, ["imported-op"]);
    assert.throws(() => assertAssistantBase(project, currentBase));
});
test("proposal identities are owned by planning, stable on reuse and destructive by action", () => {
    const raw = { actions: [{ id: "untrusted", type: "visual.delete", params: { clipId: "v1" } }] };
    const plan = prepareAssistantProposal(raw, { baseRevision: 2 }, "request-a");
    assert.equal(plan.actions[0].id, "request-a-op-0");
    assert.equal(plan.approvalId, "request-a");
    assert.equal(plan.destructive, true);
    assert.deepEqual(structuredClone(plan).actions, plan.actions);
    assert.notEqual(prepareAssistantProposal(raw, {}, "request-b").actions[0].id, plan.actions[0].id);
});
test("destruction requires exact existing targets, including generic clip deletion", () => {
    for (const params of [{}, { clipId: "selected" }, { clipId: "all" }, { clipId: "missing" }]) {
        assert.throws(() => assertDestructiveAssistantTargets([{ type: "visual.delete", params }], fixture()));
    }
    for (const type of ["visual.delete", "clip.delete"]) assertDestructiveAssistantTargets([{ type, params: { clipId: "v1" } }], fixture());
});
test("pause/filler/removal ambiguity never becomes visual deletion; explicit clip deletion still works", () => {
    const summary = { visuals: [{ id: "v1", index: 0, name: "Opening", duration: 4 }, { id: "v2", index: 1, name: "Closing", duration: 4 }], selectedVisualId: "v1" };
    for (const prompt of ["remove pauses", "remove filler words", "remove long pauses and filler words", "remove silence", "remove background noise", "remove something"]) {
        const result = parseNaturalLanguageEditingPlan(prompt, summary);
        const actions = result?.plan?.actions || result?.actions || [];
        assert.equal(actions.some(action => action.type === "visual.delete"), false, prompt);
    }
    const result = parseNaturalLanguageEditingPlan("delete clip 2", summary);
    assert.ok((result?.plan?.actions || result?.actions || []).some(action => action.type === "visual.delete" && action.params.clipId === "v2"));
});
test("assistant checks track aliases, lane locks, clip locks and indirect locked-track changes", () => {
    for (const [key, type, params] of [["image", "visual.trim", { clipId: "v1" }], ["audio-0", "audio.set_volume", {}], ["captions", "tool.generate_captions", {}], ["overlay-1", "project.set_ratio", {}], ["music", "music.set_volume", {}]]) {
        const project = { ...fixture(), trackLocks: { [key]: true } };
        assert.throws(() => assertAssistantOperationUnlocked(project, { type, ...params }), { code: "TRACK_LOCKED" });
    }
    const project = fixture();
    project.visualSegments[1].locked = true;
    assertAssistantOperationUnlocked(project, { type: "visual.trim", clipId: "v1" });
    assertAssistantOperationUnlocked(project, { type: "marker.add" });
    assertAssistantOperationUnlocked(project, { type: "tool.export" });
    assert.throws(() => assertAssistantOperationUnlocked(project, { type: "visual.delete", clipId: "v2" }), { code: "CLIP_LOCKED" });
    const next = structuredClone(project);
    next.visualSegments[0].duration = 3;
    assertAssistantChangedTracksUnlocked(project, next);
    next.visualSegments[1].duration = 3;
    assert.throws(() => assertAssistantChangedTracksUnlocked(project, next), { code: "CLIP_LOCKED" });
    const locked = { ...fixture(), trackLocks: { caption: true } };
    assert.throws(() => assertAssistantChangedTracksUnlocked(locked, { ...locked, script: "changed indirectly" }), { code: "TRACK_LOCKED" });
});
