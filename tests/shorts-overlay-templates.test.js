import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    APPLICABLE_ELEMENT_KINDS,
    OVERLAY_TEMPLATE_FORMAT,
    OVERLAY_TEMPLATE_LIMITS,
    OVERLAY_TEMPLATE_SCHEMA_VERSION,
    OverlayTemplateError,
    TEMPLATE_APPLY_REASONS,
    TEMPLATE_ELEMENT_SKIP_REASONS,
    createTemplateFromOverlays,
    createTemplateOverlayRenderSource,
    describeTemplate,
    duplicateOverlayTemplate,
    instantiateTemplate,
    isOverlayTemplateCompatible,
    mapTemplateLayoutToOverlayTransform,
    normalizeOverlayTemplate,
    serializeOverlayTemplateForApi,
    validateOverlayTemplate,
} from "../src/lib/shortsOverlayTemplates.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mediaElement = (overrides = {}) => ({
    id: "el-1",
    kind: "media",
    name: "Logo",
    baseTransform: { x: 27, y: -24, scale: 0.34, rotation: 0, opacity: 1 },
    keyframes: [
        { time: 0, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
        { time: 2, x: 10, y: 0, scale: 1, rotation: 0, opacity: 1 },
    ],
    animation: { in: { id: "fade", duration: 0.6 }, out: { id: "none", duration: 0.6 } },
    mask: { type: "none", feather: 0, inverted: false },
    layer: 2,
    start: 0,
    duration: 4,
    media: {
        mediaKind: "image",
        assetId: "asset-abc",
        archiveMediaId: "archive-abc",
        filename: "logo.png",
        mimeType: "image/png",
        width: 512,
        height: 512,
    },
    ...overrides,
});

const vectorElement = (overrides = {}) => ({
    id: "el-2",
    kind: "vector",
    name: "Badge",
    baseTransform: { x: -20, y: 30, scale: 0.5, rotation: 12, opacity: 0.9 },
    keyframes: [],
    animation: { in: { id: "zoom", duration: 0.4 }, out: { id: "none", duration: 0.6 } },
    mask: { type: "none", feather: 0, inverted: false },
    layer: 3,
    start: 1,
    duration: 3,
    vector: {
        assetId: "vector-badge",
        body: "<circle cx=\"600\" cy=\"600\" r=\"200\" fill=\"#ff0000\"/>",
        background: "transparent",
    },
    ...overrides,
});

const validTemplate = (overrides = {}) => ({
    name: "Lower Third Neon",
    description: "Bold lower third with logo",
    schemaVersion: 1,
    canvas: { aspectRatio: "9:16", width: 1080, height: 1920 },
    elements: [mediaElement()],
    ...overrides,
});

const liveOverlay = (overrides = {}) => ({
    id: "overlay-live-1",
    assetId: "asset-abc",
    archiveMediaId: "archive-abc",
    name: "Logo",
    type: "image",
    kind: "",
    src: "blob:http://localhost/deadbeef",
    blob: { fake: "blob" },
    width: 512,
    height: 512,
    start: 3,
    duration: 5,
    layer: 1,
    baseTransform: { x: 27, y: -24, scale: 0.34, rotation: 0, opacity: 1 },
    keyframes: [],
    animation: { in: { id: "fade", duration: 0.6 }, out: { id: "none", duration: 0.6 } },
    mask: { type: "none", feather: 0, inverted: false },
    filterId: "none",
    ...overrides,
});

const projectAsset = (overrides = {}) => ({
    id: "asset-abc",
    archiveMediaId: "archive-abc",
    name: "Logo",
    type: "image",
    src: "blob:http://localhost/aaaaaaaa",
    width: 512,
    height: 512,
    duration: 5,
    ...overrides,
});

const throwsCode = (fn, code) => assert.throws(fn, (error) => {
    assert.ok(error instanceof OverlayTemplateError, `expected OverlayTemplateError, got ${error?.name}`);
    assert.equal(error.code, code);
    return true;
});

// ---------------------------------------------------------------------------
// Template model: schema, normalization, compatibility
// ---------------------------------------------------------------------------

describe("Overlay template model", () => {
    it("normalizes a valid template into the versioned document shape", () => {
        const normalized = normalizeOverlayTemplate(validTemplate());

        assert.equal(normalized.format, OVERLAY_TEMPLATE_FORMAT);
        assert.equal(normalized.schemaVersion, OVERLAY_TEMPLATE_SCHEMA_VERSION);
        assert.equal(normalized.name, "Lower Third Neon");
        assert.equal(normalized.description, "Bold lower third with logo");
        assert.deepEqual(normalized.canvas, { aspectRatio: "9:16", width: 1080, height: 1920 });
        assert.equal(normalized.elements.length, 1);
        assert.equal(normalized.elements[0].kind, "media");
        assert.equal(normalized.elements[0].media.assetId, "asset-abc");
        assert.equal(normalized.elements[0].lane, null);
    });

    it("applies documented defaults for omitted fields", () => {
        const normalized = normalizeOverlayTemplate({ name: "Sparse", elements: [] });

        assert.deepEqual(normalized.canvas, { aspectRatio: "9:16", width: 1080, height: 1920 });
        assert.equal(normalized.schemaVersion, 1);
        assert.equal(normalized.description, null);
        assert.deepEqual(normalized.elements, []);
    });

    it("normalizes transforms, keyframes, animation and mask to canonical bounds", () => {
        const normalized = normalizeOverlayTemplate(validTemplate({
            elements: [mediaElement({
                baseTransform: { x: 99999, y: -99999, scale: 0, rotation: 0, opacity: 7 },
                keyframes: [
                    { time: 2, x: 10 },
                    { time: 0, x: 0 },
                    { time: 2.01, x: 11 },
                ],
                animation: { in: { id: "fade", duration: 99 }, out: { id: "none" } },
                mask: { type: "circle", feather: 9, inverted: true },
            })],
        }));

        const element = normalized.elements[0];
        assert.equal(element.baseTransform.x, 1000);
        assert.equal(element.baseTransform.y, -1000);
        assert.equal(element.baseTransform.scale, 0.01);
        assert.equal(element.baseTransform.opacity, 1);
        assert.deepEqual(element.keyframes.map((frame) => frame.time), [0, 2, 2.01]);
        assert.equal(element.animation.in.duration, 3);
        assert.equal(element.mask.feather, 1);
        assert.equal(element.mask.inverted, true);
    });

    it("sorts keyframes chronologically", () => {
        const normalized = normalizeOverlayTemplate(validTemplate({
            elements: [mediaElement({ keyframes: [{ time: 3 }, { time: 1 }, { time: 2 }] })],
        }));
        assert.deepEqual(normalized.elements[0].keyframes.map((frame) => frame.time), [1, 2, 3]);
    });

    it("supports text and shape element kinds without schema redesign", () => {
        const normalized = normalizeOverlayTemplate(validTemplate({
            elements: [
                { id: "t1", kind: "text", text: { content: "Hello", fontSize: 72 } },
                { id: "s1", kind: "shape", shape: { shapeType: "rect", fill: "#00ff00" } },
            ],
        }));

        assert.equal(normalized.elements[0].kind, "text");
        assert.equal(normalized.elements[0].text.content, "Hello");
        assert.equal(normalized.elements[0].text.align, "center");
        assert.equal(normalized.elements[1].kind, "shape");
        assert.equal(normalized.elements[1].shape.shapeType, "rect");
    });

    it("accepts empty text and preserves whitespace, newlines, and font identity", () => {
        const family = '"Poppins", Inter, system-ui, sans-serif';
        const normalized = normalizeOverlayTemplate(validTemplate({
            elements: [
                { id: "empty", kind: "text", text: { content: "", fontId: "poppins", fontFamily: family } },
                { id: "spaced", kind: "text", text: { content: "  One\nTwo  " } },
            ],
        }));

        assert.equal(normalized.elements[0].text.content, "");
        assert.equal(normalized.elements[0].text.fontId, "poppins");
        assert.equal(normalized.elements[0].text.fontFamily, family);
        assert.equal(normalized.elements[1].text.content, "  One\nTwo  ");
    });

    it("rejects an unsupported schema version", () => {
        throwsCode(() => normalizeOverlayTemplate(validTemplate({ schemaVersion: 99 })), "UNSUPPORTED_TEMPLATE_SCHEMA_VERSION");
    });

    it("rejects a missing name", () => {
        throwsCode(() => normalizeOverlayTemplate({ elements: [] }), "INVALID_TEMPLATE_NAME");
    });

    it("rejects an over-long name", () => {
        throwsCode(
            () => normalizeOverlayTemplate({ name: "x".repeat(OVERLAY_TEMPLATE_LIMITS.nameMaxLength + 1), elements: [] }),
            "INVALID_TEMPLATE_NAME",
        );
    });

    it("rejects flattened render artifacts on an element", () => {
        ["previewImage", "renderedFrame", "thumbnail", "src", "objectUrl", "dataUri"].forEach((field) => {
            throwsCode(
                () => normalizeOverlayTemplate(validTemplate({ elements: [mediaElement({ [field]: "data:image/png;base64,AAA" })] })),
                "TEMPLATE_FLATTENED_PAYLOAD_REJECTED",
            );
        });
    });

    it("rejects inline binary on a media reference", () => {
        throwsCode(
            () => normalizeOverlayTemplate(validTemplate({
                elements: [mediaElement({ media: { mediaKind: "image", assetId: "a", blob: "AAAA" } })],
            })),
            "TEMPLATE_FLATTENED_PAYLOAD_REJECTED",
        );
    });

    it("rejects a media element without any portable reference", () => {
        throwsCode(
            () => normalizeOverlayTemplate(validTemplate({
                elements: [mediaElement({ media: { mediaKind: "image", filename: "x.png" } })],
            })),
            "INVALID_TEMPLATE_MEDIA",
        );
    });

    it("rejects an unknown element kind", () => {
        throwsCode(
            () => normalizeOverlayTemplate(validTemplate({ elements: [{ id: "x", kind: "video-clip" }] })),
            "INVALID_TEMPLATE_ELEMENT",
        );
    });

    it("preserves stable vector identifiers during normalization and JSON reload", () => {
        const normalized = normalizeOverlayTemplate(validTemplate({
            elements: [
                vectorElement({
                    id: "vector-one",
                    vector: {
                        assetId: "vector-star",
                        body: '<path d="M0 0h10v10H0z"/>',
                    },
                }),
                vectorElement({
                    id: "vector-two",
                    vector: {
                        assetId: "vector-arrow-right",
                        body: '<path d="M0 5h8L5 2l1-1 5 4-5 4-1-1 3-2H0z"/>',
                    },
                }),
            ],
        }));
        const reloaded = normalizeOverlayTemplate(JSON.parse(JSON.stringify(normalized)));

        assert.deepEqual(
            reloaded.elements.map((element) => element.vector.assetId),
            ["vector-star", "vector-arrow-right"],
        );
    });

    it("rejects a vector element without a self-contained body", () => {
        throwsCode(
            () => normalizeOverlayTemplate(validTemplate({ elements: [{ id: "v", kind: "vector", vector: {} }] })),
            "INVALID_TEMPLATE_VECTOR",
        );
    });

    it("rejects more elements than the documented limit", () => {
        const elements = Array.from(
            { length: OVERLAY_TEMPLATE_LIMITS.maxElements + 1 },
            (_, index) => ({ id: `el-${index}`, kind: "shape" }),
        );
        throwsCode(() => normalizeOverlayTemplate(validTemplate({ elements })), "TEMPLATE_TOO_LARGE");
    });

    it("rejects a payload over the byte limit", () => {
        // Each body sits under the per-vector cap, but the document total exceeds
        // the payload limit, which is what the byte guard must catch.
        const chunk = "a".repeat(OVERLAY_TEMPLATE_LIMITS.maxVectorBodyLength);
        const perElement = JSON.stringify({ body: chunk }).length;
        const count = Math.ceil(OVERLAY_TEMPLATE_LIMITS.maxPayloadBytes / perElement) + 1;

        assert.ok(count <= OVERLAY_TEMPLATE_LIMITS.maxElements, "fixture must stay under the element cap");

        throwsCode(
            () => normalizeOverlayTemplate(validTemplate({
                elements: Array.from({ length: count }, (_, index) => ({
                    id: `v-${index}`,
                    kind: "vector",
                    vector: { body: chunk },
                })),
            })),
            "TEMPLATE_TOO_LARGE",
        );
    });

    it("reports validation results without throwing", () => {
        const good = validateOverlayTemplate(validTemplate());
        assert.equal(good.ok, true);
        assert.equal(good.code, null);
        assert.ok(good.template);
        assert.equal(isOverlayTemplateCompatible(validTemplate()), true);

        const bad = validateOverlayTemplate({ schemaVersion: 42, elements: [] });
        assert.equal(bad.ok, false);
        assert.equal(bad.code, "UNSUPPORTED_TEMPLATE_SCHEMA_VERSION");
        assert.equal(bad.template, null);
        assert.equal(isOverlayTemplateCompatible({ schemaVersion: 42 }), false);
    });

    it("round-trips through the API serializer", () => {
        const normalized = normalizeOverlayTemplate(validTemplate({ metadata: { team: "shorts" } }));
        const payload = serializeOverlayTemplateForApi(normalized);

        assert.deepEqual(Object.keys(payload).sort(), [
            "canvas", "description", "elements", "metadata", "name", "schemaVersion",
        ]);
        assert.equal(payload.schemaVersion, 1);
        assert.deepEqual(payload.metadata, { team: "shorts" });

        const reloaded = normalizeOverlayTemplate(payload);
        assert.equal(reloaded.name, normalized.name);
        assert.deepEqual(reloaded.elements, normalized.elements);
        assert.deepEqual(reloaded.canvas, normalized.canvas);
    });

    it("survives a JSON round-trip (save, reload, normalize)", () => {
        const original = normalizeOverlayTemplate(validTemplate({ elements: [mediaElement(), vectorElement()] }));
        const reloaded = normalizeOverlayTemplate(JSON.parse(JSON.stringify(original)));
        assert.deepEqual(reloaded.elements, original.elements);
        assert.equal(reloaded.schemaVersion, original.schemaVersion);
    });

    it("describes a template for library cards", () => {
        const summary = describeTemplate(validTemplate({ elements: [mediaElement(), vectorElement()] }));
        assert.equal(summary.elementCount, 2);
        assert.equal(summary.mediaCount, 1);
        assert.equal(summary.vectorCount, 1);
        assert.deepEqual(summary.kinds.sort(), ["media", "vector"]);
        assert.equal(summary.aspectRatio, "9:16");
        assert.equal(summary.duration, 4);
    });
});

// ---------------------------------------------------------------------------
// Save as Template
// ---------------------------------------------------------------------------

describe("Create template from overlays", () => {
    it("builds a portable template and drops blob/object-URL fields", () => {
        const template = createTemplateFromOverlays({
            overlays: [liveOverlay()],
            name: "Saved Look",
            description: "from project",
        });

        assert.equal(template.schemaVersion, 1);
        assert.equal(template.name, "Saved Look");
        assert.equal(template.elements.length, 1);

        const element = template.elements[0];
        assert.equal(element.kind, "media");
        assert.equal(element.media.assetId, "asset-abc");
        assert.equal(element.media.archiveMediaId, "archive-abc");
        assert.equal(element.media.mediaKind, "image");

        const serialized = JSON.stringify(template);
        assert.equal(serialized.includes("blob:http"), false);
        assert.equal(serialized.includes("\"blob\""), false);
        assert.equal(serialized.includes("\"src\""), false);
    });

    it("preserves transforms, keyframes, animation and duration", () => {
        const overlay = liveOverlay({
            keyframes: [
                { time: 0, x: -50, y: 0, scale: 0.2, rotation: 0, opacity: 0 },
                { time: 2, x: 50, y: 0, scale: 0.6, rotation: 90, opacity: 1 },
            ],
            duration: 7,
        });
        const template = createTemplateFromOverlays({ overlays: [overlay], name: "Animated" });
        const element = template.elements[0];

        assert.deepEqual(element.baseTransform, { x: 27, y: -24, scale: 0.34, rotation: 0, opacity: 1 });
        assert.equal(element.keyframes.length, 2);
        assert.equal(element.keyframes[1].rotation, 90);
        assert.deepEqual(element.animation, { in: { id: "fade", duration: 0.6 }, out: { id: "none", duration: 0.6 } });
        assert.equal(element.duration, 7);
    });

    it("rebases element start times to the earliest overlay", () => {
        const template = createTemplateFromOverlays({
            overlays: [liveOverlay({ id: "a", start: 10 }), liveOverlay({ id: "b", start: 13 })],
            name: "Rebased",
        });
        assert.deepEqual(template.elements.map((element) => element.start), [0, 3]);
    });

    it("limits to the explicitly selected overlays", () => {
        const template = createTemplateFromOverlays({
            overlays: [liveOverlay({ id: "a" }), liveOverlay({ id: "b" })],
            selectedIds: ["b"],
            name: "Selected",
        });
        assert.equal(template.elements.length, 1);
    });

    it("keeps vector overlays self-contained with their stable vector identity", () => {
        const overlay = liveOverlay({
            id: "vec-1",
            assetId: "",
            archiveMediaId: "",
            vectorAssetId: "vector-square",
            vectorBody: "<rect x=\"0\" y=\"0\" width=\"10\" height=\"10\" fill=\"#00ff00\"/>",
            vectorBackground: "transparent",
            vectorColorSlots: { primary: ["#00ff00"], secondary: [], accent: [] },
        });
        const template = createTemplateFromOverlays({ overlays: [overlay], name: "Vector Look" });

        assert.equal(template.elements[0].kind, "vector");
        assert.equal(template.elements[0].vector.assetId, "vector-square");
        assert.ok(template.elements[0].vector.body.includes("<rect"));
        assert.equal(JSON.stringify(template).includes("\"src\""), false);
    });

    it("skips overlays that have no portable identity instead of silently dropping them", () => {
        const template = createTemplateFromOverlays({
            overlays: [
                liveOverlay({ id: "portable" }),
                liveOverlay({ id: "blob-only", assetId: "", archiveMediaId: "", integrity: undefined, sha256: undefined }),
            ],
            name: "Mixed",
        });
        assert.equal(template.elements.length, 1);
        assert.equal(template.metadata.sourceElementCount, 2);
    });

    it("throws when nothing can be saved", () => {
        throwsCode(
            () => createTemplateFromOverlays({
                overlays: [liveOverlay({ assetId: "", archiveMediaId: "" })],
                name: "Empty",
            }),
            "TEMPLATE_NO_ELIGIBLE_ELEMENTS",
        );
    });

    it("requires a name", () => {
        assert.equal(createTemplateFromOverlays({ overlays: [liveOverlay()] }).name, "Overlay Template");
    });

    it("excludes hidden overlays", () => {
        const template = createTemplateFromOverlays({
            overlays: [liveOverlay({ id: "visible" }), liveOverlay({ id: "hidden", hidden: true })],
            name: "Visible Only",
        });
        assert.equal(template.elements.length, 1);
    });
});

// ---------------------------------------------------------------------------
// Duplicate
// ---------------------------------------------------------------------------

describe("Duplicate template", () => {
    it("creates an independent copy with a derived name and provenance", () => {
        const original = normalizeOverlayTemplate({ ...validTemplate(), id: "tpl-original" });
        const copy = duplicateOverlayTemplate(original);

        assert.notEqual(copy.id, original.id);
        assert.equal(copy.name, "Lower Third Neon (copy)");
        assert.equal(copy.metadata.duplicatedFrom, "tpl-original");
        assert.deepEqual(copy.elements, original.elements);
        assert.deepEqual(copy, { ...copy }, copy);
    });

    it("accepts an explicit name and id", () => {
        const copy = duplicateOverlayTemplate(validTemplate(), { name: "Variant B", id: "tpl-fixed" });
        assert.equal(copy.name, "Variant B");
        assert.equal(copy.id, "tpl-fixed");
    });

    it("does not mutate the original template", () => {
        const original = normalizeOverlayTemplate({ ...validTemplate(), id: "tpl-original" });
        const snapshot = JSON.stringify(original);
        duplicateOverlayTemplate(original, { name: "Copy" });
        assert.equal(JSON.stringify(original), snapshot);
    });

    it("truncates a derived name to the documented limit", () => {
        const longName = "x".repeat(OVERLAY_TEMPLATE_LIMITS.nameMaxLength);
        const copy = duplicateOverlayTemplate(validTemplate({ name: longName }));
        assert.ok(copy.name.length <= OVERLAY_TEMPLATE_LIMITS.nameMaxLength);
    });
});

// ---------------------------------------------------------------------------
// Apply / instantiate
// ---------------------------------------------------------------------------

describe("Instantiate template", () => {
    it("appends fresh overlays and never mutates existing content", () => {
        const existing = [liveOverlay({ id: "existing-1", start: 0, duration: 4, lane: 0 })];
        const existingSnapshot = JSON.stringify(existing);

        const result = instantiateTemplate({
            template: validTemplate({ elements: [mediaElement(), vectorElement()] }),
            existingOverlays: existing,
            assets: [projectAsset()],
        });

        assert.equal(result.applied, true);
        assert.equal(result.reason, TEMPLATE_APPLY_REASONS.applied);
        assert.equal(result.created.length, 2);
        assert.equal(result.overlays.length, 3);

        // Existing content is untouched.
        assert.equal(JSON.stringify(existing), existingSnapshot);
        assert.deepEqual(result.overlays[0], existing[0]);

        // New overlays carry fresh ids.
        const createdIds = result.created.map((overlay) => overlay.id);
        assert.equal(new Set(createdIds).size, 2);
        assert.equal(createdIds.includes("existing-1"), false);
        createdIds.forEach((id) => assert.ok(id.startsWith("overlay-")));
    });

    it("generates fresh ids for every application of the same template", () => {
        const first = instantiateTemplate({
            template: validTemplate(),
            existingOverlays: [],
            assets: [projectAsset()],
        });
        const second = instantiateTemplate({
            template: validTemplate(),
            existingOverlays: first.overlays,
            assets: [projectAsset()],
        });

        assert.notEqual(first.created[0].id, second.created[0].id);
        assert.equal(second.overlays.length, 2);
    });

    it("preserves transforms, keyframes and animations", () => {
        const result = instantiateTemplate({
            template: validTemplate(),
            existingOverlays: [],
            assets: [projectAsset()],
        });
        const overlay = result.created[0];

        assert.deepEqual(overlay.baseTransform, { x: 27, y: -24, scale: 0.34, rotation: 0, opacity: 1 });
        assert.equal(overlay.keyframes.length, 2);
        assert.equal(overlay.keyframes[1].x, 10);
        assert.deepEqual(overlay.animation, { in: { id: "fade", duration: 0.6 }, out: { id: "none", duration: 0.6 } });
        assert.equal(overlay.filterId, "none");
        assert.equal(overlay.layer, 2);
    });

    it("defaults the start time to the end of existing overlays", () => {
        const result = instantiateTemplate({
            template: validTemplate({ elements: [mediaElement({ start: 0 })] }),
            existingOverlays: [liveOverlay({ id: "e1", start: 2, duration: 6 })],
            assets: [projectAsset()],
        });
        assert.equal(result.created[0].start, 8);
    });

    it("honours an explicit start time and element offsets", () => {
        const result = instantiateTemplate({
            template: validTemplate({ elements: [mediaElement({ start: 1.5 })] }),
            existingOverlays: [],
            assets: [projectAsset()],
            startTime: 10,
        });
        assert.equal(result.created[0].start, 11.5);
    });

    it("assigns non-conflicting lanes via the existing lane packing", () => {
        const existing = [liveOverlay({ id: "existing-1", start: 0, duration: 10, lane: 0 })];
        const result = instantiateTemplate({
            template: validTemplate({ elements: [mediaElement({ start: 0, duration: 5, lane: null })] }),
            existingOverlays: existing,
            assets: [projectAsset()],
            startTime: 0,
        });

        const created = result.created[0];
        const existingAfter = result.overlays.find((overlay) => overlay.id === "existing-1");

        assert.equal(existingAfter.lane, 0);
        assert.notEqual(created.lane, 0);
        // Every overlay must be present in exactly one lane.
        assert.equal(result.overlays.length, 2);
    });

    it("reuses an existing lane when there is no time conflict", () => {
        const existing = [liveOverlay({ id: "existing-1", start: 0, duration: 2, lane: 0 })];
        const result = instantiateTemplate({
            template: validTemplate({ elements: [mediaElement({ start: 0, duration: 2 })] }),
            existingOverlays: existing,
            assets: [projectAsset()],
            startTime: 5,
        });
        assert.equal(result.created[0].lane, 0);
    });

    it("refuses to apply when the overlay track is locked", () => {
        const existing = [liveOverlay({ id: "existing-1" })];
        const result = instantiateTemplate({
            template: validTemplate(),
            existingOverlays: existing,
            assets: [projectAsset()],
            trackLocks: { overlay: true },
        });

        assert.equal(result.applied, false);
        assert.equal(result.reason, TEMPLATE_APPLY_REASONS.trackLocked);
        assert.equal(result.created.length, 0);
        assert.equal(result.selectedId, null);
        assert.equal(result.overlays, existing);
        assert.ok(result.warnings.length > 0);
    });

    it("applies when the overlay track is unlocked", () => {
        const result = instantiateTemplate({
            template: validTemplate(),
            existingOverlays: [],
            assets: [projectAsset()],
            trackLocks: { overlay: false },
        });
        assert.equal(result.applied, true);
    });

    it("reports missing assets instead of silently dropping elements", () => {
        const result = instantiateTemplate({
            template: validTemplate(),
            existingOverlays: [],
            assets: [],
        });

        assert.equal(result.applied, false);
        assert.equal(result.reason, TEMPLATE_APPLY_REASONS.nothingToApply);
        assert.equal(result.unresolved.length, 1);
        assert.equal(result.unresolved[0].reason, TEMPLATE_ELEMENT_SKIP_REASONS.missingAsset);

        // Provenance is preserved for a relink flow.
        assert.equal(result.unresolved[0].media.assetId, "asset-abc");
        assert.equal(result.unresolved[0].media.filename, "logo.png");
        assert.ok(result.warnings.some((warning) => warning.includes("not in this project")));
    });

    it("applies the resolvable elements and reports the rest", () => {
        const result = instantiateTemplate({
            template: validTemplate({ elements: [mediaElement(), vectorElement()] }),
            existingOverlays: [],
            assets: [],
        });

        // The vector element needs no asset; the media element does.
        assert.equal(result.applied, true);
        assert.equal(result.created.length, 1);
        assert.equal(result.created[0].templateElementId, "el-2");
        assert.equal(result.unresolved.length, 1);
        assert.equal(result.unresolved[0].elementId, "el-1");
    });

    it("relinks by archiveMediaId when the asset id changed", () => {
        const result = instantiateTemplate({
            template: validTemplate({
                elements: [mediaElement({
                    media: {
                        mediaKind: "image",
                        assetId: "stale-asset-id",
                        archiveMediaId: "archive-abc",
                        width: 512,
                        height: 512,
                    }
                })],
            }),
            existingOverlays: [],
            assets: [projectAsset({ id: "fresh-asset-id" })],
        });

        assert.equal(result.applied, true);
        assert.equal(result.created[0].archiveMediaId, "archive-abc");
        assert.equal(result.created[0].src, "blob:http://localhost/aaaaaaaa");
    });

    it("relinks by checksum when no id matches", () => {
        const result = instantiateTemplate({
            template: validTemplate({
                elements: [mediaElement({ media: { mediaKind: "image", checksum: "abc123", width: 8, height: 8 } })],
            }),
            existingOverlays: [],
            assets: [projectAsset({ id: "other", archiveMediaId: "other", sha256: "abc123" })],
        });
        assert.equal(result.applied, true);
    });

    it("tags created overlays with template provenance", () => {
        const result = instantiateTemplate({
            template: normalizeOverlayTemplate({ ...validTemplate(), id: "tpl-123", name: "Neon" }),
            existingOverlays: [],
            assets: [projectAsset()],
        });
        const overlay = result.created[0];
        assert.equal(overlay.templateId, "tpl-123");
        assert.equal(overlay.templateName, "Neon");
        assert.equal(overlay.templateElementId, "el-1");
    });

    it("creates individually editable text and shape overlays", () => {
        const fontFamily = '"Playfair Display", Inter, system-ui, sans-serif';
        const result = instantiateTemplate({
            template: validTemplate({
                elements: [
                    mediaElement(),
                    {
                        id: "t1",
                        kind: "text",
                        name: "Headline",
                        layout: { x: 100, y: 200, width: 600, height: 180 },
                        text: {
                            content: "Hi & <friends>",
                            color: "#00ffff",
                            fontId: "playfair-display",
                            fontFamily,
                        },
                    },
                    {
                        id: "s1",
                        kind: "shape",
                        name: "Panel",
                        layout: { x: 80, y: 160, width: 640, height: 240 },
                        shape: { shapeType: "rect", fill: "#101820", radius: 24 },
                    },
                ],
            }),
            existingOverlays: [],
            assets: [projectAsset()],
        });

        assert.equal(result.applied, true);
        assert.equal(result.created.length, 3);
        assert.equal(result.skipped.length, 0);

        const text = result.created.find((overlay) => overlay.kind === "text");
        const shape = result.created.find((overlay) => overlay.kind === "shape");
        assert.deepEqual(text.text.content, "Hi & <friends>");
        assert.equal(text.text.fontId, "playfair-display");
        assert.equal(text.text.fontFamily, fontFamily);
        assert.deepEqual(shape.shape.shapeType, "rect");
        assert.ok(text.src.startsWith("data:image/svg+xml"));
        assert.ok(shape.src.startsWith("data:image/svg+xml"));
        assert.deepEqual(text.templateLayout, { x: 100, y: 200, width: 600, height: 180 });
        assert.deepEqual(shape.templateLayout, { x: 80, y: 160, width: 640, height: 240 });
        const decodedTextSvg = decodeURIComponent(text.src);
        assert.match(decodedTextSvg, /Hi .*amp; .*lt;friends.*gt;/);
        assert.match(decodedTextSvg, /Playfair Display/);
        assert.doesNotMatch(decodedTextSvg, /Hi & <friends>/);
    });

    it("applies an empty text element as an editable blank overlay", () => {
        const result = instantiateTemplate({
            template: validTemplate({
                elements: [{
                    id: "empty-text",
                    kind: "text",
                    name: "Blank headline",
                    layout: { x: 100, y: 200, width: 600, height: 180 },
                    text: {
                        content: "",
                        fontId: "montserrat",
                        fontFamily: '"Montserrat", Inter, system-ui, sans-serif',
                    },
                }],
            }),
            existingOverlays: [],
            assets: [],
        });

        assert.equal(result.applied, true);
        assert.equal(result.created.length, 1);
        assert.equal(result.created[0].text.content, "");
        assert.equal(result.created[0].text.fontId, "montserrat");
        assert.doesNotMatch(decodeURIComponent(result.created[0].src), />Text</);
    });

    it("regenerates text and shape render sources after editable payload changes", () => {
        const textSource = createTemplateOverlayRenderSource({
            kind: "text",
            name: "Headline",
            width: 600,
            height: 180,
            text: { content: "Updated", color: "#ff00ff", fontSize: 64 },
        });
        const emptyTextSource = createTemplateOverlayRenderSource({
            kind: "text",
            width: 600,
            height: 180,
            text: { content: "", color: "#ffffff", fontSize: 64 },
        });
        const shapeSource = createTemplateOverlayRenderSource({
            kind: "shape",
            width: 600,
            height: 180,
            shape: { shapeType: "ellipse", fill: "#00ff00", stroke: "#ffffff", strokeWidth: 4 },
        });

        assert.match(decodeURIComponent(textSource), /Updated/);
        assert.doesNotMatch(decodeURIComponent(emptyTextSource), />Text</);
        assert.match(decodeURIComponent(shapeSource), /<ellipse/);
    });

    it("maps Studio layout geometry and keyframes into normal overlay transforms", () => {
        const layout = { x: 108, y: 384, width: 540, height: 384 };
        assert.deepEqual(
            mapTemplateLayoutToOverlayTransform(layout, { width: 1080, height: 1920 }, {
                x: 27, y: -24, scale: 0.34, rotation: 12, opacity: 0.8,
            }),
            { x: 12, y: -44, scale: 0.17, rotation: 12, opacity: 0.8 },
        );

        const result = instantiateTemplate({
            template: validTemplate({
                elements: [mediaElement({
                    layout,
                    media: {
                        ...mediaElement().media,
                        fit: "contain",
                        positionX: 25,
                        positionY: 75,
                        zoom: 1.4,
                    },
                })],
            }),
            existingOverlays: [],
            assets: [projectAsset()],
        });
        const overlay = result.created[0];

        assert.equal(overlay.width, 540);
        assert.equal(overlay.height, 384);
        assert.equal(overlay.mediaSourceWidth, 512);
        assert.equal(overlay.mediaSourceHeight, 512);
        assert.deepEqual(overlay.mediaPresentation, {
            fit: "contain",
            positionX: 25,
            positionY: 75,
            zoom: 1.4,
        });
        assert.deepEqual(overlay.baseTransform, {
            x: 12, y: -44, scale: 0.17, rotation: 0, opacity: 1,
        });
        assert.deepEqual(overlay.keyframes[1], {
            time: 2, x: -5, y: -20, scale: 0.5, rotation: 0, opacity: 1,
        });
    });

    it("selects the first newly created overlay", () => {
        const result = instantiateTemplate({
            template: validTemplate({ elements: [mediaElement(), vectorElement()] }),
            existingOverlays: [],
            assets: [projectAsset()],
        });
        assert.equal(result.selectedId, result.created[0].id);
    });

    it("derives the vector data URL at apply time and keeps the exact selected identifier", () => {
        const template = validTemplate({ elements: [vectorElement()] });
        assert.equal(JSON.stringify(template).includes("data:image/svg"), false);

        const result = instantiateTemplate({ template, existingOverlays: [], assets: [] });
        assert.equal(result.applied, true);
        assert.ok(result.created[0].src.startsWith("data:image/svg+xml"));
        assert.equal(result.created[0].kind, "vector");
        assert.equal(result.created[0].vectorAssetId, "vector-badge");
        assert.ok(result.created[0].vectorBody.includes("<circle"));
    });

    it("uses asset duration when the element has none", () => {
        const result = instantiateTemplate({
            template: validTemplate({ elements: [mediaElement({ duration: null })] }),
            existingOverlays: [],
            assets: [projectAsset({ duration: 9 })],
        });
        assert.equal(result.created[0].duration, 9);
    });

    it("exposes every editable Studio element kind as applicable", () => {
        assert.deepEqual([...APPLICABLE_ELEMENT_KINDS], ["media", "vector", "text", "shape"]);
    });

    it("rejects an invalid template before touching the timeline", () => {
        throwsCode(
            () => instantiateTemplate({ template: { schemaVersion: 7, elements: [] }, existingOverlays: [] }),
            "UNSUPPORTED_TEMPLATE_SCHEMA_VERSION",
        );
    });
});
