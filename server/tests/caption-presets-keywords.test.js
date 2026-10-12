import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BUILTIN_CAPTION_STYLE_PRESETS,
  CAPTION_VISUAL_STYLE_KEYS,
  applyCaptionPresetToStyle,
  getCaptionStylePreset,
} from "../../src/lib/captionStyles.js";
import { positionCaptionLayout } from "../../src/lib/captionLayout.js";
import {
  DEFAULT_ACTIVE_WORD_COLOR,
  DEFAULT_KEYWORD_COLOR,
  findKeywordRangesInLine,
  isWordMatchingKeywords,
  isKeywordHighlightEnabled,
  normalizeKeywords,
  resolveKeywordColor,
  resolveKeywords,
  splitLineIntoWordChunks,
} from "../../src/lib/karaoke.js";

describe("Milestone: Advanced Caption Presets & Keyword Highlighting", () => {
  describe("1. Reusable Caption Presets", () => {
    it("provides the 5 required presets: Classic, Bold, Karaoke, Minimal, Social", () => {
      const requiredIds = ["classic", "bold", "karaoke", "minimal", "social"];
      for (const id of requiredIds) {
        const preset = getCaptionStylePreset(id);
        assert.ok(preset, `Preset "${id}" should exist in BUILTIN_CAPTION_STYLE_PRESETS`);
        assert.ok(preset.labelKey, `Preset "${id}" must have a labelKey`);
        assert.ok(preset.sampleClass, `Preset "${id}" must have a sampleClass`);
        assert.ok(Number.isFinite(preset.captionSize) && preset.captionSize > 0, `Preset "${id}" must have a positive captionSize`);
        assert.ok(preset.position, `Preset "${id}" must define a vertical position`);
        assert.ok(preset.style, `Preset "${id}" must define a style object`);
      }
    });

    it("Classic preset defines clean typography with translucent dark pill background", () => {
      const preset = getCaptionStylePreset("classic");
      assert.equal(preset.position, "bottom");
      assert.equal(preset.captionSize, 14);
      assert.equal(preset.style.karaoke, false);
      assert.equal(preset.style.backgroundOpacity, 0.72);
      assert.equal(preset.style.textStrokeWidth, 0);
    });

    it("Bold preset defines punchy high-contrast styling with outline and zero background", () => {
      const preset = getCaptionStylePreset("bold");
      assert.equal(preset.position, "bottom");
      assert.equal(preset.captionSize, 17);
      assert.equal(preset.style.backgroundOpacity, 0);
      assert.ok(preset.style.textStrokeWidth >= 2, "Bold preset should have prominent stroke outline");
      assert.equal(preset.style.textStrokeColor, "#000000");
    });

    it("Karaoke preset defines active-word highlighting with vivid gold and dark backdrop", () => {
      const preset = getCaptionStylePreset("karaoke");
      assert.equal(preset.position, "bottom");
      assert.equal(preset.captionSize, 15);
      assert.equal(preset.style.karaoke, true);
      assert.equal(preset.style.activeWordColor, "#ffd43b");
    });

    it("Minimal preset defines clean borderless text with zero background opacity", () => {
      const preset = getCaptionStylePreset("minimal");
      assert.equal(preset.position, "bottom");
      assert.equal(preset.captionSize, 13);
      assert.equal(preset.style.backgroundOpacity, 0);
      assert.equal(preset.style.borderWidth, 0);
      assert.equal(preset.style.karaoke, false);
    });

    it("Social Media preset defines high-impact bottom-positioned viral styling with punchy colors", () => {
      const preset = getCaptionStylePreset("social");
      assert.equal(preset.position, "bottom");
      assert.equal(preset.captionSize, 18);
      assert.equal(preset.style.karaoke, true);
      assert.equal(preset.style.textColor, "#fff03b");
      assert.equal(preset.style.activeWordColor, "#00ffcc");
      assert.equal(preset.style.textStrokeColor, "#000000");
      assert.ok(preset.style.textStrokeWidth >= 2);
      assert.ok(preset.style.backgroundOpacity > 0.7);
    });

    it("positionCaptionLayout keeps standard bottom position within safe area", () => {
      const layout = {
        frame: { width: 360, height: 640 },
        width: 180,
        height: 80,
      };
      const pos = positionCaptionLayout(layout, "bottom");
      // bottom is y: 78% -> centerY = 640 * 0.78 = 499.2 -> y = 499.2 - 40 = 459.2
      assert.equal(pos.x, 90);
      assert.equal(pos.y, 459.2);
      assert.equal(pos.centerX, 180);
      assert.equal(pos.centerY, 499.2);
    });

    it("positionCaptionLayout clamps top edge to prevent clipping in portrait 9:16 canvas", () => {
      const layout = {
        frame: { width: 360, height: 640 },
        width: 200,
        height: 250,
      };
      // top is y: 18% -> centerY = 640 * 0.18 = 115.2 -> rawY = 115.2 - 125 = -9.8 (off-screen clipping)
      const pos = positionCaptionLayout(layout, "top");
      const safeMarginTop = Math.max(16, Math.round(640 * 0.05)); // 32
      assert.ok(pos.y >= safeMarginTop, `pos.y (${pos.y}) must be >= safeMarginTop (${safeMarginTop})`);
      assert.equal(pos.y, safeMarginTop);
      assert.equal(pos.centerY, pos.y + layout.height / 2);
    });

    it("positionCaptionLayout clamps bottom edge to prevent clipping in portrait 9:16 canvas", () => {
      const layout = {
        frame: { width: 360, height: 640 },
        width: 200,
        height: 200,
      };
      // custom placement near bottom edge y: 95%
      const pos = positionCaptionLayout(layout, { x: 50, y: 95 });
      const safeMarginBottom = Math.max(20, Math.round(640 * 0.06)); // 38
      const maxAllowedY = 640 - layout.height - safeMarginBottom; // 402
      assert.ok(pos.y <= maxAllowedY, `pos.y (${pos.y}) must be <= maxAllowedY (${maxAllowedY})`);
      assert.equal(pos.y, maxAllowedY);
      assert.equal(pos.centerY, pos.y + layout.height / 2);
    });

    it("positionCaptionLayout preserves user-customized positioning while guarding edges", () => {
      const layout = {
        frame: { width: 720, height: 1280 },
        width: 300,
        height: 100,
      };
      // User placed caption at x: 40%, y: 60%
      const customPlacement = { x: 40, y: 60 };
      const pos = positionCaptionLayout(layout, customPlacement);
      assert.equal(pos.centerX, 720 * 0.4);
      assert.equal(pos.centerY, 1280 * 0.6);
      assert.equal(pos.x, 720 * 0.4 - 150);
      assert.equal(pos.y, 1280 * 0.6 - 50);
    });

    it("applyCaptionPresetToStyle merges preset styles onto current style", () => {
      const current = { textColor: "#ffffff", paddingX: 10, customField: "keep" };
      const preset = getCaptionStylePreset("bold");
      const result = applyCaptionPresetToStyle(current, preset);
      assert.equal(result.textStrokeWidth, 3);
      assert.equal(result.textColor, "#ffffff");
      assert.equal(result.customField, "keep");
    });
  });

  describe("2. Keyword Normalization & Extraction", () => {
    it("normalizeKeywords handles arrays, strings, commas, newlines and trims whitespace", () => {
      assert.deepEqual(normalizeKeywords([" safe ", "password", ""]), ["safe", "password"]);
      assert.deepEqual(normalizeKeywords("password, secure website; important\nauth"), [
        "password",
        "secure website",
        "important",
        "auth",
      ]);
      assert.deepEqual(normalizeKeywords(null), []);
      assert.deepEqual(normalizeKeywords(""), []);
    });

    it("isWordMatchingKeywords matches words case-insensitively and tolerates punctuation", () => {
      const keywords = ["password", "secure website", "bank"];
      assert.equal(isWordMatchingKeywords("Password", keywords), true);
      assert.equal(isWordMatchingKeywords("password?", keywords), true);
      assert.equal(isWordMatchingKeywords("(password)", keywords), true);
      assert.equal(isWordMatchingKeywords("bank,", keywords), true);
      assert.equal(isWordMatchingKeywords("unrelated", keywords), false);
    });

    it("findKeywordRangesInLine accurately locates multi-word phrases and words in lines", () => {
      const line = "What if someone reads your password while it travels to a secure website?";
      const keywords = ["password", "secure website"];
      const ranges = findKeywordRangesInLine(line, keywords);

      assert.equal(ranges.length, 2);
      assert.equal(line.slice(ranges[0].start, ranges[0].end), "password");
      assert.equal(line.slice(ranges[1].start, ranges[1].end), "secure website");
    });
  });

  describe("3. Keyword Highlighting & Karaoke Overlap Behavior", () => {
    const sampleWords = [
      { text: "What", start: 0.0, end: 0.3 },
      { text: "if", start: 0.3, end: 0.38 },
      { text: "someone", start: 0.38, end: 0.64 },
      { text: "reads", start: 0.64, end: 0.9 },
      { text: "your", start: 0.9, end: 1.1 },
      { text: "password", start: 1.1, end: 1.5 },
      { text: "while", start: 1.5, end: 1.8 },
      { text: "it", start: 1.8, end: 2.0 },
      { text: "travels", start: 2.0, end: 2.4 },
      { text: "to", start: 2.4, end: 2.6 },
      { text: "a", start: 2.6, end: 2.7 },
      { text: "secure", start: 2.7, end: 3.1 },
      { text: "website", start: 3.1, end: 3.5 },
    ];
    const line = "reads your password while it travels to a secure website";

    it("highlights designated keywords when karaoke is disabled or inactive", () => {
      const result = splitLineIntoWordChunks(line, sampleWords, 3, -1, {
        keywords: ["password", "secure website"],
        keywordHighlight: true,
        keywordColor: "#38d9a9",
        activeWordColor: "#ffd43b",
        textColor: "#ffffff",
      });

      const pwChunk = result.chunks.find((c) => c.text === "password");
      assert.ok(pwChunk, "Chunk for 'password' should exist");
      assert.equal(pwChunk.isKeyword, true);
      assert.equal(pwChunk.isActive, false);
      assert.equal(pwChunk.color, "#38d9a9");

      const secureChunk = result.chunks.find((c) => c.text === "secure");
      assert.ok(secureChunk);
      assert.equal(secureChunk.isKeyword, true);
      assert.equal(secureChunk.color, "#38d9a9");

      const normalChunk = result.chunks.find((c) => c.text === "reads");
      assert.ok(normalChunk);
      assert.equal(normalChunk.isKeyword, false);
      assert.equal(normalChunk.color, "#ffffff");
    });

    it("active karaoke word takes precedence over keyword color when active (overlap resolution)", () => {
      // Word index 5 is 'password' (both keyword and currently spoken karaoke word)
      const result = splitLineIntoWordChunks(line, sampleWords, 3, 5, {
        keywords: ["password", "secure website"],
        keywordHighlight: true,
        keywordColor: "#38d9a9",
        activeWordColor: "#ffd43b",
        textColor: "#ffffff",
      });

      const pwChunk = result.chunks.find((c) => c.text === "password");
      assert.ok(pwChunk);
      assert.equal(pwChunk.isKeyword, true, "Should still be marked as a keyword");
      assert.equal(pwChunk.isActive, true, "Should be marked as active karaoke word");
      assert.equal(pwChunk.color, "#ffd43b", "Active karaoke color must take precedence during spoken interval");

      // 'secure' is not active right now, so it stays in keyword color
      const secureChunk = result.chunks.find((c) => c.text === "secure");
      assert.equal(secureChunk.isActive, false);
      assert.equal(secureChunk.color, "#38d9a9");
    });

    it("word returns to keywordColor when active karaoke speech moves to another word", () => {
      // Speech moves to word index 6 ('while')
      const result = splitLineIntoWordChunks(line, sampleWords, 3, 6, {
        keywords: ["password", "secure website"],
        keywordHighlight: true,
        keywordColor: "#38d9a9",
        activeWordColor: "#ffd43b",
        textColor: "#ffffff",
      });

      const pwChunk = result.chunks.find((c) => c.text === "password");
      assert.equal(pwChunk.isActive, false);
      assert.equal(pwChunk.isKeyword, true);
      assert.equal(pwChunk.color, "#38d9a9", "Must revert to keywordColor, not plain white");

      const whileChunk = result.chunks.find((c) => c.text === "while");
      assert.equal(whileChunk.isActive, true);
      assert.equal(whileChunk.isKeyword, false);
      assert.equal(whileChunk.color, "#ffd43b");
    });

    it("highlights keywords on legacy captions lacking Whisper word timestamps", () => {
      const phraseLine = "Please verify your password safely.";
      const result = splitLineIntoWordChunks(phraseLine, null, 0, -1, {
        keywords: ["password"],
        keywordHighlight: true,
        keywordColor: "#38d9a9",
        textColor: "#ffffff",
      });

      const pwChunk = result.chunks.find((c) => c.text.includes("password"));
      assert.ok(pwChunk);
      assert.equal(pwChunk.isKeyword, true);
      assert.equal(pwChunk.color, "#38d9a9");

      const prefixChunk = result.chunks.find((c) => c.text.includes("Please verify your"));
      assert.ok(prefixChunk);
      assert.equal(prefixChunk.isKeyword, false);
      assert.equal(prefixChunk.color, "#ffffff");
    });
  });

  describe("4. Project Serialization & Persistence", () => {
    it("CAPTION_VISUAL_STYLE_KEYS includes keyword configuration keys", () => {
      assert.ok(CAPTION_VISUAL_STYLE_KEYS.includes("keywordHighlight"));
      assert.ok(CAPTION_VISUAL_STYLE_KEYS.includes("keywords"));
      assert.ok(CAPTION_VISUAL_STYLE_KEYS.includes("keywordColor"));
    });

    it("round-trips project data with preset and keyword settings via JSON without loss", () => {
      const project = {
        schemaVersion: 3,
        captionStylePresetId: "social",
        captionPosition: "middle",
        captionSize: 18,
        captionStyle: {
          textColor: "#fff03b",
          backgroundColor: "#000000",
          backgroundOpacity: 0.85,
          textStrokeWidth: 2,
          karaoke: true,
          activeWordColor: "#00ffcc",
          keywordHighlight: true,
          keywords: ["important", "security"],
          keywordColor: "#ff4d4f",
        },
        captionSegments: [
          {
            id: "seg-1",
            text: "This is important security info",
            start: 0,
            end: 2.5,
            styleOverrides: {
              keywordColor: "#38d9a9",
            },
          },
        ],
      };

      const serialized = JSON.stringify(project);
      const restored = JSON.parse(serialized);

      assert.equal(restored.schemaVersion, 3);
      assert.equal(restored.captionStylePresetId, "social");
      assert.equal(restored.captionPosition, "middle");
      assert.equal(restored.captionStyle.keywordHighlight, true);
      assert.deepEqual(restored.captionStyle.keywords, ["important", "security"]);
      assert.equal(restored.captionStyle.keywordColor, "#ff4d4f");
      assert.equal(restored.captionSegments[0].styleOverrides.keywordColor, "#38d9a9");
    });
  });
});
