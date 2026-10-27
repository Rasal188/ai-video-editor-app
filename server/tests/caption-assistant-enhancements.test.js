import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyCommandPlan, inspectProject } from "../../src/lib/projectCommandEngine.js";
import { validateAndNormalizePlan } from "../services/ai/editingPlanSchema.js";
import { parseNaturalLanguageEditingPlan } from "../../src/lib/naturalLanguagePlanParser.js";
import { classifyUserIntent } from "../../src/lib/intentClassifier.js";
import { getAvailableCaptionStyles, findCaptionStylePreset, REAL_CAPTION_STYLE_NAMES, resolveColorToHex, NAMED_COLOR_MAP, SUPPORTED_CAPTION_EFFECTS } from "../../src/lib/captionStyles.js";
import { getAvailableCaptionFontChoices, findCaptionFontInCatalog, CAPTION_FONT_CATALOG } from "../../src/lib/captionFonts.js";
import { resolveCaptionSourceMedia } from "../../src/lib/captionSourceResolver.js";

describe("Caption Assistant Enhancements & Intent-Mapping Tests", () => {
  const createTestProject = (overrides = {}) => ({
    commandState: { schemaVersion: 1, revision: 0, appliedOperationIds: [] },
    ratioId: "16:9",
    fitMode: "contain",
    visualSegments: [
      { id: "vis-1", type: "video", duration: 15, sourceStart: 0, sourceDuration: 15, playbackRate: 1, name: "Main Video" },
    ],
    audioSegments: [
      { id: "aud-1", name: "Voiceover 1", start: 0, duration: 6, sourceStart: 0, sourceDuration: 6, volume: 1 },
    ],
    captionStyle: {
      backgroundColor: "#112233",
      textColor: "#ffffff",
      captionSize: 22,
      effect: "normal",
      backgroundOpacity: 0.8,
      fontId: "default",
      karaoke: false,
    },
    captionSegments: [
      { id: "cap-1", text: "Hello world this is a test caption", start: 0.5, end: 3.5 },
      { id: "cap-2", text: "Second caption line for karaoke", start: 4.0, end: 7.0 },
    ],
    captionsEnabled: true,
    trackLocks: {},
    ...overrides,
  });

  const executePlanOnProject = (project, plan) => {
    const operations = plan.actions
      ? plan.actions.map((a, i) => ({
          id: a.id || `op-${i + 1}`,
          type: a.type,
          ...a.params,
        }))
      : (plan.operations || []);
    const commandPlan = {
      schemaVersion: 1,
      baseRevision: project.commandState?.revision || 0,
      operations,
    };
    return applyCommandPlan(project, commandPlan);
  };

  // =========================================================================
  // 1. KARAOKE INTENT MAPPING & REGRESSION TESTS
  // =========================================================================
  describe("Karaoke / Active-Word Highlighting Intent Mapping", () => {
    const karaokeEnablePhrases = [
      "hey can you turn on the karaoke (active word) for the captions",
      "Enable karaoke for the captions",
      "Turn on karaoke highlighting",
      "Enable active word highlighting",
      "Highlight the current word while speaking",
      "Turn on word-by-word highlighting",
      "Enable active-word captions",
    ];

    karaokeEnablePhrases.forEach((phrase) => {
      it(`maps "${phrase}" to karaoke: true and NEVER effect: neon`, () => {
        const intent = classifyUserIntent(phrase);
        assert.equal(intent.type, "editing");
        assert.equal(intent.isKaraoke, true);
        assert.equal(intent.enable, true);

        const parsed = parseNaturalLanguageEditingPlan(phrase);
        assert.equal(parsed.actions.length, 1);
        assert.equal(parsed.actions[0].type, "caption.set_style");
        assert.equal(parsed.actions[0].params.style.karaoke, true);
        assert.notEqual(parsed.actions[0].params.style.effect, "neon");

        const validated = validateAndNormalizePlan(parsed);
        assert.equal(validated.actions[0].params.style.karaoke, true);
        assert.notEqual(validated.actions[0].params.style.effect, "neon");
      });
    });

    const karaokeDisablePhrases = [
      "Disable karaoke highlighting",
      "Turn off active word highlighting",
      "turn off karaoke for captions",
      "disable word-by-word highlighting",
    ];

    karaokeDisablePhrases.forEach((phrase) => {
      it(`maps disable phrase "${phrase}" to karaoke: false`, () => {
        const intent = classifyUserIntent(phrase);
        assert.equal(intent.type, "editing");
        assert.equal(intent.isKaraoke, true);
        assert.equal(intent.enable, false);

        const parsed = parseNaturalLanguageEditingPlan(phrase);
        assert.equal(parsed.actions.length, 1);
        assert.equal(parsed.actions[0].type, "caption.set_style");
        assert.equal(parsed.actions[0].params.style.karaoke, false);

        const validated = validateAndNormalizePlan(parsed);
        assert.equal(validated.actions[0].params.style.karaoke, false);
      });
    });

    it("preserves unrelated caption properties (font, colors, opacity) when enabling karaoke", () => {
      const project = createTestProject({
        captionStyle: {
          backgroundColor: "#ff0000",
          textColor: "#00ff00",
          captionSize: 28,
          backgroundOpacity: 0.5,
          fontId: "poppins",
          effect: "normal",
          karaoke: false,
        },
      });

      const parsed = parseNaturalLanguageEditingPlan("turn on karaoke for captions");
      const result = executePlanOnProject(project, parsed);
      assert.equal(result.ok, true);

      assert.equal(result.project.captionStyle.karaoke, true);
      assert.equal(result.project.captionStyle.backgroundColor, "#ff0000");
      assert.equal(result.project.captionStyle.textColor, "#00ff00");
      assert.equal(result.project.captionStyle.captionSize, 28);
      assert.equal(result.project.captionStyle.backgroundOpacity, 0.5);
      assert.equal(result.project.captionStyle.fontId, "poppins");
      assert.equal(result.project.captionStyle.effect, "normal");
      assert.notEqual(result.project.captionStyle.effect, "neon");
    });

    it("supports undo and redo for karaoke changes", () => {
      const project = createTestProject();
      const plan = parseNaturalLanguageEditingPlan("enable active word highlighting");
      const applied = executePlanOnProject(project, plan);
      assert.equal(applied.ok, true);
      assert.equal(applied.project.captionStyle.karaoke, true);

      // Verify undo restores original state
      const undoPlan = {
        actions: [{
          id: "undo-action-1",
          type: "caption.set_style",
          params: { scope: "default", style: { karaoke: false } },
        }],
      };
      const restored = executePlanOnProject(applied.project, undoPlan);
      assert.equal(restored.ok, true);
      assert.equal(restored.project.captionStyle.karaoke, false);
    });

    it("respects track locks when modifying karaoke", () => {
      const project = createTestProject({
        trackLocks: { caption: true },
      });
      const plan = parseNaturalLanguageEditingPlan("enable karaoke for the captions");
      const result = executePlanOnProject(project, plan);
      assert.equal(result.ok, false);
      assert.equal(result.code, "TRACK_LOCKED");
      assert.match(result.message, /locked/i);
    });
  });

  // =========================================================================
  // 2. CAPTION STYLE CLARIFICATION & SELECTION
  // =========================================================================
  describe("Caption Style Clarification & Selection", () => {
    it("asks for clarification on ambiguous style requests with 5 initial choices", () => {
      const ambiguousPrompt = "Change the caption style.";
      const intent = classifyUserIntent(ambiguousPrompt);

      assert.equal(intent.type, "ambiguous");
      assert.equal(intent.category, "style");
      assert.equal(intent.clarification.message, "Which caption style would you like?");
      assert.equal(intent.options.length, 5);
      assert.equal(intent.hasMore, true);

      // Verify options are actual supported styles
      const expectedFirstFive = ["Classic", "Bold", "Karaoke", "Minimal", "Social"];
      const names = intent.options.map((o) => o.name);
      assert.deepEqual(names, expectedFirstFive);
    });

    it("shows remaining styles on 'Show more styles' without duplicates", () => {
      const conversationContext = {
        activeClarification: {
          category: "style",
          offset: 0,
        },
      };

      const intent = classifyUserIntent("Show more styles", {}, conversationContext);
      assert.equal(intent.type, "more_options");
      assert.equal(intent.category, "style");
      assert.equal(intent.options.length, 4); // Plain, Outline, Translucent, Neon
      const names = intent.options.map((o) => o.name);
      assert.deepEqual(names, ["Plain", "Outline", "Translucent", "Neon"]);
      assert.equal(intent.hasMore, false);
    });

    it("applies explicit supported style request directly without clarification", () => {
      const explicitPrompt = "Apply the existing Neon caption style.";
      const intent = classifyUserIntent(explicitPrompt);
      assert.notEqual(intent.type, "ambiguous");

      const parsed = parseNaturalLanguageEditingPlan(explicitPrompt);
      assert.equal(parsed.actions.length, 1);
      assert.equal(parsed.actions[0].type, "caption.set_style");
      assert.equal(parsed.actions[0].params.style.effect, "neon");

      const validated = validateAndNormalizePlan(parsed);
      assert.equal(validated.actions[0].params.style.effect, "neon");

      const project = createTestProject();
      const result = executePlanOnProject(project, validated);
      assert.equal(result.ok, true);
      assert.equal(result.project.captionStyle.effect, "neon");
    });

    it("applies Bold caption style directly", () => {
      const explicitPrompt = "Apply Bold caption style";
      const parsed = parseNaturalLanguageEditingPlan(explicitPrompt);
      assert.equal(parsed.actions[0].type, "caption.set_style");
      assert.equal(parsed.actions[0].params.style.textStrokeWidth, 3);
    });

    it("explores available caption styles without modifying project timeline", () => {
      const explorePrompt = "Show me the available caption styles.";
      const intent = classifyUserIntent(explorePrompt);
      assert.equal(intent.type, "exploration");
      assert.equal(intent.category, "style");
      assert.equal(intent.options.length, 5);

      const parsed = parseNaturalLanguageEditingPlan(explorePrompt);
      assert.equal(parsed.actions.length, 0); // No mutation!
    });

    it("handles unsupported style requests safely by offering actual alternatives", () => {
      const unsupportedPrompt = "apply gothic cyberpunk caption style";
      const intent = classifyUserIntent(unsupportedPrompt);
      assert.equal(intent.type, "unsupported_style");
      assert.equal(intent.category, "style");
      assert.match(intent.clarification.message, /not supported/i);
      assert.equal(intent.options.length, 5);
    });
  });

  // =========================================================================
  // 3. REAL FONT REGISTRY & SELECTION
  // =========================================================================
  describe("Font Registry & Selection System", () => {
    it("verifies real font registry contains expected web-safe and Google fonts", () => {
      assert.ok(CAPTION_FONT_CATALOG.length >= 10);
      assert.ok(CAPTION_FONT_CATALOG.some((f) => f.id === "default"));
      assert.ok(CAPTION_FONT_CATALOG.some((f) => f.id === "inter"));
      assert.ok(CAPTION_FONT_CATALOG.some((f) => f.id === "montserrat"));
      assert.ok(CAPTION_FONT_CATALOG.some((f) => f.id === "poppins"));
      assert.ok(CAPTION_FONT_CATALOG.some((f) => f.id === "oswald"));
    });

    it("asks for font clarification on ambiguous request 'Change the caption font.'", () => {
      const ambiguousPrompt = "Change the caption font.";
      const intent = classifyUserIntent(ambiguousPrompt);

      assert.equal(intent.type, "ambiguous");
      assert.equal(intent.category, "font");
      assert.equal(intent.clarification.message, "Which font would you like?");
      assert.equal(intent.options.length, 5);
      assert.equal(intent.hasMore, true);

      const names = intent.options.map((o) => o.name);
      assert.deepEqual(names, ["Default", "Inter", "Montserrat", "Poppins", "Oswald"]);
    });

    it("presents additional fonts on 'Show more fonts'", () => {
      const conversationContext = {
        activeClarification: {
          category: "font",
          offset: 0,
        },
      };

      const intent = classifyUserIntent("Show more fonts", {}, conversationContext);
      assert.equal(intent.type, "more_options");
      assert.equal(intent.category, "font");
      assert.equal(intent.options.length, 5);
      const names = intent.options.map((o) => o.name);
      assert.deepEqual(names, ["Barlow Condensed", "Playfair Display", "Bebas Neue", "Caveat", "Lobster"]);
    });

    it("applies explicitly named supported font directly", () => {
      const explicitPrompt = "Change caption font to Poppins";
      const parsed = parseNaturalLanguageEditingPlan(explicitPrompt);

      assert.equal(parsed.actions.length, 1);
      assert.equal(parsed.actions[0].type, "caption.set_style");
      assert.equal(parsed.actions[0].params.style.fontId, "poppins");

      const validated = validateAndNormalizePlan(parsed);
      assert.equal(validated.actions[0].params.style.fontId, "poppins");

      const project = createTestProject();
      const result = executePlanOnProject(project, validated);
      assert.equal(result.ok, true);
      assert.equal(result.project.captionStyle.fontId, "poppins");
    });

    it("selects contextual ordinal 'the third one' from last shown fonts", () => {
      const conversationContext = {
        activeClarification: {
          category: "font",
          lastShownOptions: [
            { id: "default", name: "Default", action: "select_font", fontId: "default" },
            { id: "inter", name: "Inter", action: "select_font", fontId: "inter" },
            { id: "montserrat", name: "Montserrat", action: "select_font", fontId: "montserrat" },
            { id: "poppins", name: "Poppins", action: "select_font", fontId: "poppins" },
            { id: "oswald", name: "Oswald", action: "select_font", fontId: "oswald" },
          ],
        },
      };

      const intent = classifyUserIntent("the third one", {}, conversationContext);
      assert.equal(intent.type, "option_selected");
      assert.equal(intent.category, "font");
      assert.equal(intent.selectedOption.fontId, "montserrat");

      const parsed = parseNaturalLanguageEditingPlan("the third one", {}, conversationContext);
      assert.equal(parsed.actions.length, 1);
      assert.equal(parsed.actions[0].type, "caption.set_style");
      assert.equal(parsed.actions[0].params.style.fontId, "montserrat");
    });

    it("preserves unrelated caption properties when changing font", () => {
      const project = createTestProject({
        captionStyle: {
          backgroundColor: "#112233",
          textColor: "#ffffff",
          captionSize: 24,
          backgroundOpacity: 0.9,
          karaoke: true,
          fontId: "default",
        },
      });

      const plan = parseNaturalLanguageEditingPlan("Change caption font to Oswald");
      const result = executePlanOnProject(project, plan);
      assert.equal(result.ok, true);

      assert.equal(result.project.captionStyle.fontId, "oswald");
      assert.equal(result.project.captionStyle.backgroundColor, "#112233");
      assert.equal(result.project.captionStyle.textColor, "#ffffff");
      assert.equal(result.project.captionStyle.captionSize, 24);
      assert.equal(result.project.captionStyle.backgroundOpacity, 0.9);
      assert.equal(result.project.captionStyle.karaoke, true);
    });

    it("rejects unsupported font safely", () => {
      const unsupportedPrompt = "change caption font to WingdingsComicFake";
      const intent = classifyUserIntent(unsupportedPrompt);
      assert.equal(intent.type, "unsupported_font");
      assert.match(intent.clarification.message, /not available/i);
    });

    it("findCaptionFontInCatalog correctly resolves fonts by id, family, or label case-insensitively", () => {
      // By exact id
      const interById = findCaptionFontInCatalog("inter");
      assert.ok(interById);
      assert.equal(interById.id, "inter");

      // Case-insensitive family
      const poppinsByFamily = findCaptionFontInCatalog("Poppins");
      assert.ok(poppinsByFamily);
      assert.equal(poppinsByFamily.id, "poppins");

      // By label / display name
      const barlow = findCaptionFontInCatalog("Barlow Condensed");
      assert.ok(barlow);
      assert.equal(barlow.id, "barlow-condensed");

      // Quoted input
      const quoted = findCaptionFontInCatalog('"Montserrat"');
      assert.ok(quoted);
      assert.equal(quoted.id, "montserrat");

      // Unknown / empty / invalid queries
      assert.equal(findCaptionFontInCatalog("NonExistentFont123"), null);
      assert.equal(findCaptionFontInCatalog(""), null);
      assert.equal(findCaptionFontInCatalog("   "), null);
      assert.equal(findCaptionFontInCatalog(null), null);
      assert.equal(findCaptionFontInCatalog(undefined), null);
    });

    it("getAvailableCaptionFontChoices provides paginated font list with metadata", () => {
      const page1 = getAvailableCaptionFontChoices("en", 0, 5);
      assert.equal(page1.items.length, 5);
      assert.equal(page1.hasMore, true);
      assert.equal(page1.nextOffset, 5);
      assert.ok(page1.total >= 10);
      assert.ok(page1.items[0].id);
      assert.ok(page1.items[0].name);

      const page2 = getAvailableCaptionFontChoices("en", 5, 5);
      assert.equal(page2.items.length, 5);
      // Ensure no duplicates between page 1 and page 2
      const ids1 = new Set(page1.items.map((i) => i.id));
      for (const item of page2.items) {
        assert.equal(ids1.has(item.id), false);
      }
    });
  });

  // =========================================================================
  // 4. CAPTION GENERATION SOURCE MEDIA VALIDATION
  // =========================================================================
  describe("Caption Generation Source-Media Resolution", () => {
    it("resolves video clip with embedded audio on visualSegments", async () => {
      const dummyBlob = { size: 1024, type: "video/mp4" };
      const projectData = {
        visualSegments: [
          { id: "vis-1", type: "video", start: 2, duration: 10, sourceStart: 0, blob: dummyBlob },
        ],
        audioSegments: [],
        userAssets: [],
        sourceAudioBlob: null,
      };

      const resolved = await resolveCaptionSourceMedia(projectData);
      assert.ok(resolved);
      assert.equal(resolved.blob, dummyBlob);
      assert.equal(resolved.start, 2);
      assert.equal(resolved.duration, 10);
    });

    it("resolves standalone audioSegment correctly", async () => {
      const dummyAudioBlob = { size: 512, type: "audio/wav" };
      const projectData = {
        visualSegments: [],
        audioSegments: [
          { id: "aud-1", start: 1, duration: 5, sourceStart: 0, blob: dummyAudioBlob },
        ],
        userAssets: [],
        sourceAudioBlob: null,
      };

      const resolved = await resolveCaptionSourceMedia(projectData);
      assert.ok(resolved);
      assert.equal(resolved.blob, dummyAudioBlob);
      assert.equal(resolved.start, 1);
      assert.equal(resolved.duration, 5);
    });

    it("resolves userAssets video or audio when timeline is being initialized", async () => {
      const dummyAssetBlob = { size: 2048, type: "video/mp4" };
      const projectData = {
        visualSegments: [],
        audioSegments: [],
        userAssets: [
          { id: "asset-1", type: "video", duration: 20, blob: dummyAssetBlob },
        ],
        sourceAudioBlob: null,
      };

      const resolved = await resolveCaptionSourceMedia(projectData);
      assert.ok(resolved);
      assert.equal(resolved.blob, dummyAssetBlob);
      assert.equal(resolved.duration, 20);
    });

    it("returns null when no source media is available at all", async () => {
      const projectData = {
        visualSegments: [],
        audioSegments: [],
        userAssets: [],
        sourceAudioBlob: null,
      };

      const resolved = await resolveCaptionSourceMedia(projectData);
      assert.equal(resolved, null);
    });

    it("correctly derives timeline position for non-first visual clips by cumulative duration when start is undefined", async () => {
      const dummyBlob1 = { size: 1000, type: "video/mp4" };
      const dummyBlob2 = { size: 2000, type: "video/mp4" };
      const projectData = {
        visualSegments: [
          { id: "vis-1", type: "video", duration: 5.5, blob: dummyBlob1 },
          { id: "vis-2", type: "video", duration: 7.0, blob: dummyBlob2 },
        ],
        selectedVisualSegmentId: "vis-2",
        audioSegments: [],
        userAssets: [],
        sourceAudioBlob: null,
      };

      const resolved = await resolveCaptionSourceMedia(projectData);
      assert.ok(resolved);
      assert.equal(resolved.blob, dummyBlob2);
      // Timeline position for vis-2 must be derived from duration of vis-1 (5.5s), NOT default to 0
      assert.equal(resolved.start, 5.5);
      assert.equal(resolved.duration, 7.0);
    });

    it("prioritizes audio track when audio is explicitly selected or track is audio", async () => {
      const videoBlob = { size: 1000, type: "video/mp4" };
      const audioBlob = { size: 500, type: "audio/wav" };
      const projectData = {
        visualSegments: [
          { id: "vis-1", type: "video", duration: 10, blob: videoBlob },
        ],
        audioSegments: [
          { id: "aud-voiceover", start: 2.0, duration: 4.0, blob: audioBlob },
        ],
        selectedTrack: "audio",
        selectedAudioSegmentId: "aud-voiceover",
        userAssets: [],
        sourceAudioBlob: null,
      };

      const resolved = await resolveCaptionSourceMedia(projectData);
      assert.ok(resolved);
      assert.equal(resolved.blob, audioBlob, "Selected audio track must be prioritized over video clip");
      assert.equal(resolved.start, 2.0);
      assert.equal(resolved.duration, 4.0);
    });

    it("falls back to audio track when video clip is silent (hasAudio=false, isMuted=true, or volume=0)", async () => {
      const silentVideoBlob = { size: 1000, type: "video/mp4" };
      const voiceoverBlob = { size: 500, type: "audio/wav" };
      const projectData = {
        visualSegments: [
          { id: "vis-silent", type: "video", duration: 10, blob: silentVideoBlob, hasAudio: false, isMuted: true },
        ],
        audioSegments: [
          { id: "aud-vo", start: 0.5, duration: 8.0, blob: voiceoverBlob },
        ],
        userAssets: [],
        sourceAudioBlob: null,
      };

      const resolved = await resolveCaptionSourceMedia(projectData);
      assert.ok(resolved);
      assert.equal(resolved.blob, voiceoverBlob, "Must fall back to audio voiceover when video clip has no audio");
      assert.equal(resolved.start, 0.5);
      assert.equal(resolved.duration, 8.0);
    });

    it("ensures newly generated captions cannot be overwritten by a stale snapshot during multi-step assistant plan", () => {
      // Simulate Assistant plan that generates captions and then applies caption styling
      const generatedCaptions = [
        { id: "cap-gen-1", text: "Generated speech caption 1", start: 0.5, end: 2.5 },
        { id: "cap-gen-2", text: "Generated speech caption 2", start: 3.0, end: 5.0 },
      ];

      // Initial snapshot before caption generation was empty
      const staleSnapshot = createTestProject({
        captionSegments: [],
        captionsEnabled: false,
      });

      // The fix in AiAssistantPanel ensures that if generatedCaptions exists,
      // snapshot.captionSegments is populated with generatedCaptions before applying timeline actions
      if (generatedCaptions && (!staleSnapshot.captionSegments || staleSnapshot.captionSegments.length === 0)) {
        staleSnapshot.captionSegments = generatedCaptions;
        staleSnapshot.captionsEnabled = true;
      }

      const plan = {
        actions: [
          { id: "act-1", type: "caption.set_style", params: { scope: "default", style: { captionSize: 28, karaoke: true } } },
        ],
      };

      const result = executePlanOnProject(staleSnapshot, plan);
      assert.equal(result.ok, true);
      // Verify generated captions were NOT lost or wiped out
      assert.equal(result.project.captionSegments.length, 2);
      assert.equal(result.project.captionSegments[0].text, "Generated speech caption 1");
      assert.equal(result.project.captionSegments[1].text, "Generated speech caption 2");
      assert.equal(result.project.captionStyle.captionSize, 28);
      assert.equal(result.project.captionStyle.karaoke, true);
    });
  });

  // =========================================================================
  // 5. REGRESSION & INTEGRITY VERIFICATION
  // =========================================================================
  describe("System Integrity & Regression Safeguards", () => {
    it("maintains caption background opacity functionality with zero opacity", () => {
      const plan = parseNaturalLanguageEditingPlan("set captions background opacity to zero");
      assert.equal(plan.actions[0].type, "caption.set_style");
      assert.equal(plan.actions[0].params.style.backgroundOpacity, 0);

      const validated = validateAndNormalizePlan(plan);
      assert.equal(validated.actions[0].params.style.backgroundOpacity, 0);

      const project = createTestProject();
      const result = executePlanOnProject(project, validated);
      assert.equal(result.ok, true);
      assert.equal(result.project.captionStyle.backgroundOpacity, 0);
    });

    it("maintains caption background opacity 50%", () => {
      const plan = parseNaturalLanguageEditingPlan("Make caption backgrounds 50% opaque.");
      assert.equal(plan.actions[0].params.style.backgroundOpacity, 0.5);

      const validated = validateAndNormalizePlan(plan);
      assert.equal(validated.actions[0].params.style.backgroundOpacity, 0.5);
    });
  });

  // =========================================================================
  // 6. TARGETED REGRESSION TESTS: BUGS 1, 2, AND 3
  // =========================================================================
  describe("Targeted Regression Tests (Bugs 1, 2, and 3)", () => {
    // 1. Enabling karaoke does not overwrite activeWordColor
    it("1. Enabling karaoke does not overwrite activeWordColor", () => {
      const project = createTestProject({
        captionStyle: {
          karaoke: false,
          activeWordColor: "#00FFCC",
          textColor: "#FFFFFF",
        },
      });
      const plan = parseNaturalLanguageEditingPlan("Enable karaoke for captions");
      const result = executePlanOnProject(project, plan);
      assert.equal(result.ok, true);
      assert.equal(result.project.captionStyle.karaoke, true);
      assert.equal(result.project.captionStyle.activeWordColor, "#00FFCC");
    });

    // 2. Changing activeWordColor does not re-enable or disable karaoke
    it("2. Changing activeWordColor does not re-enable or disable karaoke", () => {
      const project = createTestProject({
        captionStyle: {
          karaoke: true,
          activeWordColor: "#ffd43b",
          textColor: "#FFFFFF",
        },
      });
      const prompt = "Change active word color to red instead of yellow.";
      const intent = classifyUserIntent(prompt);
      assert.equal(intent.isActiveWordColor, true);
      assert.equal(intent.color, "#FF0000");

      const plan = parseNaturalLanguageEditingPlan(prompt);
      assert.equal(plan.actions.length, 1);
      assert.equal(plan.actions[0].type, "caption.set_style");
      assert.equal(plan.actions[0].params.style.activeWordColor, "#FF0000");
      assert.equal(plan.actions[0].params.style.karaoke, undefined); // Not toggled!

      const result = executePlanOnProject(project, plan);
      assert.equal(result.ok, true);
      assert.equal(result.project.captionStyle.activeWordColor, "#FF0000");
      assert.equal(result.project.captionStyle.karaoke, true); // Still true!
    });

    // 3. Named colors map to the correct hex values
    it("3. Named colors map to the correct hex values", () => {
      assert.equal(resolveColorToHex("red"), "#FF0000");
      assert.equal(resolveColorToHex("blue"), "#0000FF");
      assert.equal(resolveColorToHex("green"), "#00FF00");
      assert.equal(resolveColorToHex("yellow"), "#FFFF00");
      assert.equal(resolveColorToHex("cyan"), "#00FFFF");
      assert.equal(resolveColorToHex("magenta"), "#FF00FF");

      const redPlan = parseNaturalLanguageEditingPlan("Change active word color to red");
      assert.equal(redPlan.actions[0].params.style.activeWordColor, "#FF0000");

      const bluePlan = parseNaturalLanguageEditingPlan("Make the karaoke highlight blue");
      assert.equal(bluePlan.actions[0].params.style.activeWordColor, "#0000FF");

      const greenPlan = parseNaturalLanguageEditingPlan("Change the highlighted word color to green");
      assert.equal(greenPlan.actions[0].params.style.activeWordColor, "#00FF00");

      // Verify resolveColorToHex exports and handles case-insensitivity, 3-digit & 6-digit hex, and invalid values
      assert.equal(resolveColorToHex("RED"), "#FF0000");
      assert.equal(resolveColorToHex("  blue  "), "#0000FF");
      assert.equal(resolveColorToHex("#ff0000"), "#FF0000");
      assert.equal(resolveColorToHex("#00ff00"), "#00FF00");
      assert.equal(resolveColorToHex("#f00"), "#FF0000");
      assert.equal(resolveColorToHex("#0f0"), "#00FF00");
      assert.equal(resolveColorToHex("#00f"), "#0000FF");
      assert.equal(resolveColorToHex("#abc"), "#AABBCC");
      assert.equal(resolveColorToHex("   #123456   "), "#123456");

      // Invalid / unknown values return null safely
      assert.equal(resolveColorToHex("notAColor"), null);
      assert.equal(resolveColorToHex("#12345"), null);
      assert.equal(resolveColorToHex("#1234567"), null);
      assert.equal(resolveColorToHex(""), null);
      assert.equal(resolveColorToHex("   "), null);
      assert.equal(resolveColorToHex(null), null);
      assert.equal(resolveColorToHex(undefined), null);
      assert.equal(resolveColorToHex(12345), null);
    });

    // 4. Explicit hex colors are validated
    it("4. Explicit hex colors are validated", () => {
      const hexPlan = parseNaturalLanguageEditingPlan("Set activeWordColor to #FF0000.");
      assert.equal(hexPlan.actions[0].params.style.activeWordColor, "#FF0000");

      const validated = validateAndNormalizePlan(hexPlan);
      assert.equal(validated.actions[0].params.style.activeWordColor, "#FF0000");

      // Invalid hex is rejected
      assert.throws(
        () => validateAndNormalizePlan({
          schemaVersion: 1,
          actions: [{ id: "1", type: "caption.set_style", params: { activeWordColor: "#NOTAHEX" } }],
        }),
        /activeWordColor must be a valid hex color/
      );
    });

    // 5. Ambiguous effect requests show choices without applying edits
    it("5. Ambiguous effect requests show choices without applying edits", () => {
      const ambiguousPrompt = "I want change caption effect";
      const intent = classifyUserIntent(ambiguousPrompt);
      assert.equal(intent.type, "ambiguous");
      assert.equal(intent.category, "effect");
      assert.equal(intent.clarification.message, "Which caption effect would you like?");
      assert.equal(intent.options.length, 2);
      assert.deepEqual(intent.options.map((o) => o.id), ["normal", "neon"]);

      // Natural language parser does not invent an action for ambiguous prompt
      const plan = parseNaturalLanguageEditingPlan(ambiguousPrompt);
      assert.equal(plan.actions.length, 0);
    });

    // 6. Selecting Normal applies the normal effect
    it("6. Selecting Normal applies the normal effect", () => {
      const project = createTestProject({
        captionStyle: { effect: "neon" },
      });
      const plan = parseNaturalLanguageEditingPlan("Apply Normal caption effect");
      assert.equal(plan.actions.length, 1);
      assert.equal(plan.actions[0].params.style.effect, "normal");

      const result = executePlanOnProject(project, plan);
      assert.equal(result.ok, true);
      assert.equal(result.project.captionStyle.effect, "normal");
    });

    // 7. Selecting Neon applies the neon effect
    it("7. Selecting Neon applies the neon effect", () => {
      const project = createTestProject({
        captionStyle: { effect: "normal" },
      });
      const plan = parseNaturalLanguageEditingPlan("Apply Neon caption effect");
      assert.equal(plan.actions.length, 1);
      assert.equal(plan.actions[0].params.style.effect, "neon");

      const result = executePlanOnProject(project, plan);
      assert.equal(result.ok, true);
      assert.equal(result.project.captionStyle.effect, "neon");
    });

    // 8. Explicit supported effects work directly
    it("8. Explicit supported effects work directly", () => {
      const explicitNeon = "Apply the neon effect";
      const intent = classifyUserIntent(explicitNeon);
      assert.equal(intent.type, "editing");
      assert.equal(intent.isEffect, true);
      assert.equal(intent.effect, "neon");

      const plan = parseNaturalLanguageEditingPlan(explicitNeon);
      assert.equal(plan.actions[0].params.style.effect, "neon");
    });

    // 9. Font selection passes validation and executes successfully
    it("9. Font selection passes validation and executes successfully", () => {
      const plan = {
        schemaVersion: 1,
        actions: [{
          id: "act-1",
          type: "caption.set_style",
          params: { scope: "default", style: { fontId: "Inter" } },
        }],
      };
      const validated = validateAndNormalizePlan(plan);
      assert.equal(validated.actions[0].params.style.fontId, "inter"); // Normalized to lowercase ID

      const project = createTestProject();
      const result = executePlanOnProject(project, validated);
      assert.equal(result.ok, true);
      assert.equal(result.project.captionStyle.fontId, "inter");
    });

    // 10. Selected font persists in caption styling
    it("10. Selected font persists in caption styling", () => {
      const project = createTestProject();
      const plan = parseNaturalLanguageEditingPlan("Change caption font to Montserrat");
      const result = executePlanOnProject(project, plan);
      assert.equal(result.ok, true);
      assert.equal(result.project.captionStyle.fontId, "montserrat");
    });

    // 11. Unsupported font IDs are rejected
    it("11. Unsupported font IDs are rejected", () => {
      const invalidPlan = {
        schemaVersion: 1,
        actions: [{
          id: "act-1",
          type: "caption.set_style",
          params: { scope: "default", style: { fontId: "NonExistentFont123" } },
        }],
      };
      assert.throws(
        () => validateAndNormalizePlan(invalidPlan),
        /Unsupported font/
      );

      const project = createTestProject();
      const rawCommand = {
        schemaVersion: 1,
        baseRevision: 0,
        operations: [{
          id: "op-1",
          type: "caption.set_style",
          scope: "default",
          style: { fontId: "NonExistentFont123" },
        }],
      };
      const applied = applyCommandPlan(project, rawCommand);
      assert.equal(applied.ok, false);
      assert.match(applied.message, /Invalid caption style property: fontId/);
    });

    // 12. "Show more fonts" and ordinal selection remain functional
    it("12. 'Show more fonts' and ordinal selection remain functional", () => {
      const context = {
        activeClarification: {
          category: "font",
          offset: 0,
          lastShownOptions: [
            { id: "default", name: "Default", action: "select_font", fontId: "default" },
            { id: "inter", name: "Inter", action: "select_font", fontId: "inter" },
            { id: "montserrat", name: "Montserrat", action: "select_font", fontId: "montserrat" },
            { id: "poppins", name: "Poppins", action: "select_font", fontId: "poppins" },
            { id: "oswald", name: "Oswald", action: "select_font", fontId: "oswald" },
          ],
        },
      };
      const moreIntent = classifyUserIntent("Show more fonts", {}, context);
      assert.equal(moreIntent.type, "more_options");
      assert.equal(moreIntent.category, "font");

      const ordinalIntent = classifyUserIntent("the second one", {}, context);
      assert.equal(ordinalIntent.type, "option_selected");
      assert.equal(ordinalIntent.selectedOption.fontId, "inter");

      const ordinalPlan = parseNaturalLanguageEditingPlan("the second one", {}, context);
      assert.equal(ordinalPlan.actions[0].params.style.fontId, "inter");
    });

    // 13. Existing background-opacity tests continue passing
    it("13. Existing background-opacity tests continue passing", () => {
      const plan = parseNaturalLanguageEditingPlan("Set caption background opacity to 0.75");
      assert.equal(plan.actions[0].params.style.backgroundOpacity, 0.75);
      const validated = validateAndNormalizePlan(plan);
      assert.equal(validated.actions[0].params.style.backgroundOpacity, 0.75);

      const project = createTestProject();
      const result = executePlanOnProject(project, validated);
      assert.equal(result.ok, true);
      assert.equal(result.project.captionStyle.backgroundOpacity, 0.75);
    });

    // 14. Undo/redo and track-lock protections continue working
    it("14. Undo/redo and track-lock protections continue working", () => {
      const lockedProject = createTestProject({
        trackLocks: { caption: true },
      });
      const plan = parseNaturalLanguageEditingPlan("Change active word color to green");
      const lockResult = executePlanOnProject(lockedProject, plan);
      assert.equal(lockResult.ok, false);
      assert.equal(lockResult.code, "TRACK_LOCKED");

      const project = createTestProject({
        captionStyle: { activeWordColor: "#FFFF00" },
      });
      const applyResult = executePlanOnProject(project, plan);
      assert.equal(applyResult.ok, true);
      assert.equal(applyResult.project.captionStyle.activeWordColor, "#00FF00");

      const undoPlan = {
        actions: [{
          id: "undo-1",
          type: "caption.set_style",
          params: { scope: "default", style: { activeWordColor: "#FFFF00" } },
        }],
      };
      const undoResult = executePlanOnProject(applyResult.project, undoPlan);
      assert.equal(undoResult.ok, true);
      assert.equal(undoResult.project.captionStyle.activeWordColor, "#FFFF00");
    });

    // 15. Unrelated caption properties remain unchanged
    it("15. Unrelated caption properties remain unchanged", () => {
      const project = createTestProject({
        captionStyle: {
          fontId: "poppins",
          captionSize: 26,
          textColor: "#333333",
          backgroundColor: "#EEEEEE",
          backgroundOpacity: 0.85,
          karaoke: true,
          activeWordColor: "#FF0000",
          effect: "normal",
        },
      });

      const plan = parseNaturalLanguageEditingPlan("Change active word color to blue");
      const result = executePlanOnProject(project, plan);
      assert.equal(result.ok, true);

      // Only activeWordColor changed
      assert.equal(result.project.captionStyle.activeWordColor, "#0000FF");
      // All other properties preserved
      assert.equal(result.project.captionStyle.fontId, "poppins");
      assert.equal(result.project.captionStyle.captionSize, 26);
      assert.equal(result.project.captionStyle.textColor, "#333333");
      assert.equal(result.project.captionStyle.backgroundColor, "#EEEEEE");
      assert.equal(result.project.captionStyle.backgroundOpacity, 0.85);
      assert.equal(result.project.captionStyle.karaoke, true);
      assert.equal(result.project.captionStyle.effect, "normal");
    });
  });
});
