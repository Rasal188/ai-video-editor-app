import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestEnvironment, withServer } from "./test-helpers.js";
import {
  validateAndNormalizeVideoSpec,
  VIDEO_SPEC_SCHEMA_VERSION,
  SUPPORTED_ASPECT_RATIOS,
  SUPPORTED_STYLES,
  SUPPORTED_TRANSITIONS,
  SUPPORTED_CAPTION_STYLES,
} from "../services/ai/videoPlanSchema.js";
import {
  generateLocalFallbackSpec,
  generateVideoSpecification,
  setGeneratorFetch,
  resetGeneratorFetch,
} from "../services/ai/videoGeneratorService.js";
import { synthesizeSpeech, setKokoroProvider, resetKokoroProvider } from "../services/ai/ttsService.js";
import { generatorLimiter } from "../routes/generator.js";
import {
  concretizeVisualSearchQuery,
  normalizeCanonicalMediaKey,
  isNegativeAsset,
  scoreAssetRelevance,
  assembleGeneratedProject,
  computeSceneWordTimestamps,
} from "../../src/lib/videoGeneratorAssembler.js";
import { validateSegmentWords } from "../../src/lib/transcriptReview.js";
import {
  resolveSmartFrameCropAtTime,
  normalizeSmartFrame,
} from "../../src/lib/smartFrame.js";

describe("AI Video Generator Service & API", () => {
  let env;

  beforeEach(async () => {
    generatorLimiter?.reset?.();
    env = await setupTestEnvironment();
    setGeneratorFetch(async (_url, opts) => {
      let reqPayload;
      try {
        const bodyObj = JSON.parse(opts?.body || "{}");
        reqPayload = JSON.parse(bodyObj.messages?.[1]?.content || "{}");
      } catch (_err) {
        reqPayload = {};
      }
      const style = reqPayload.style || "cinematic";
      const targetDuration = Number(reqPayload.targetDuration) || 30;
      const aspectRatio = reqPayload.aspectRatio || "9:16";

      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  schemaVersion: 1,
                  title: "Mock AI Video",
                  summary: "Mock summary",
                  targetDuration,
                  aspectRatio,
                  style,
                  narration: { enabled: true, voiceId: "af_heart", language: "en", script: "Mock narration." },
                  music: { enabled: true, mood: "ambient", volume: 0.25 },
                  captions: { enabled: true, stylePreset: "neon" },
                  scenes: [
                    { title: "Scene 1", duration: targetDuration / 3, transition: "fade", searchQuery: "query 1", visualDescription: "shot 1", narration: "narration 1", caption: "caption 1" },
                    { title: "Scene 2", duration: targetDuration / 3, transition: "fade", searchQuery: "query 2", visualDescription: "shot 2", narration: "narration 2", caption: "caption 2" },
                    { title: "Scene 3", duration: targetDuration / 3, transition: "fade", searchQuery: "query 3", visualDescription: "shot 3", narration: "narration 3", caption: "caption 3" },
                  ],
                }),
              },
            },
          ],
        }),
      };
    });
  });

  afterEach(async () => {
    resetGeneratorFetch();
    await env.teardown();
  });

  describe("Video Specification Schema Validation", () => {
    it("should validate and normalize a well-formed video specification", () => {
      const raw = {
        schemaVersion: 1,
        title: "Future of AI in Medicine",
        summary: "Exploring robotic surgery and automated diagnosis.",
        aspectRatio: "9:16",
        style: "tech",
        targetDuration: 30,
        narration: {
          enabled: true,
          voiceId: "af_heart",
          language: "en",
          script: "Artificial intelligence is revolutionizing modern healthcare from the ground up.",
        },
        music: {
          enabled: true,
          mood: "inspirational ambient",
          volume: 0.3,
        },
        captions: {
          enabled: true,
          stylePreset: "neon",
          position: "bottom",
        },
        scenes: [
          {
            id: "scene-1",
            title: "Robotic Precision",
            duration: 10,
            visualDescription: "Macro shot of a surgical robot arm operating with precision laser guide.",
            searchQuery: "robotic surgery medical",
            narration: "Precision robotic surgery now enables microscopic operations.",
            caption: "Precision robotic surgery",
            transition: "fade",
          },
          {
            id: "scene-2",
            title: "Neural Diagnostics",
            duration: 20,
            visualDescription: "Futuristic holographic medical scan displaying neural pathways.",
            searchQuery: "hologram brain scan",
            narration: "Neural network algorithms detect pathology before symptoms appear.",
            caption: "Early neural detection",
            transition: "zoom",
          },
        ],
      };

      const normalized = validateAndNormalizeVideoSpec(raw);
      assert.equal(normalized.schemaVersion, VIDEO_SPEC_SCHEMA_VERSION);
      assert.equal(normalized.title, "Future of AI in Medicine");
      assert.equal(normalized.aspectRatio, "9:16");
      assert.equal(normalized.style, "tech");
      assert.equal(normalized.finalDuration, 30);
      assert.equal(normalized.scenes.length, 2);
      assert.equal(normalized.scenes[0].transition, "fade");
      assert.equal(normalized.scenes[1].transition, "zoom");
      assert.equal(normalized.music.volume, 0.3);
      assert.equal(normalized.captions.stylePreset, "neon");
    });

    it("should clamp durations, volumes, and sanitize unexpected fields", () => {
      const raw = {
        title: "   Trimmed Title   ",
        aspectRatio: "invalid-ratio",
        style: "unsupported-style",
        targetDuration: 500, // exceeds 180s limit
        music: {
          volume: 5.0, // should clamp to 1.0
        },
        captions: {
          stylePreset: "wild-preset", // should fallback to neon
        },
        scenes: [
          {
            title: "Scene 1",
            duration: 2, // too short, should normalize to min duration
            transition: "non-existent-transition",
          },
          {
            title: "Scene 2",
            duration: 5,
            transition: "zoom",
          },
        ],
      };

      const normalized = validateAndNormalizeVideoSpec(raw);
      assert.equal(normalized.title, "Trimmed Title");
      assert.equal(normalized.aspectRatio, "16:9"); // fallback default (YouTube widescreen standard)
      assert.equal(normalized.style, "cinematic"); // fallback default
      assert.equal(normalized.targetDuration, 30); // fallback default
      assert.equal(normalized.music.volume, 1.0); // clamped to 1
      assert.equal(normalized.captions.stylePreset, "neon"); // fallback
      assert.equal(normalized.scenes[0].transition, "fade"); // fallback
      assert.ok(normalized.scenes[0].duration >= 2);
    });

    it("should reject non-object payloads with an error", () => {
      assert.throws(() => validateAndNormalizeVideoSpec(null), /must be a non-null object/i);
      assert.throws(() => validateAndNormalizeVideoSpec([]), /must be a non-null object/i);
      assert.throws(() => validateAndNormalizeVideoSpec("string"), /must be a non-null object/i);
    });
  });

  describe("Deterministic Local Fallback Generator", () => {
    it("should decompose prompts into timed scenes with search queries and narration", () => {
      const spec = generateLocalFallbackSpec({
        prompt: "Create a 30s video about deep sea exploration and bioluminescent creatures in the Mariana Trench",
        targetDuration: 30,
        aspectRatio: "16:9",
        style: "nature",
        voiceId: "af_bella",
      });

      assert.equal(spec.schemaVersion, 1);
      assert.equal(spec.aspectRatio, "16:9");
      assert.equal(spec.style, "nature");
      assert.equal(spec.narration.voiceId, "af_bella");
      assert.ok(spec.scenes.length >= 3 && spec.scenes.length <= 8);

      const totalSceneDuration = spec.scenes.reduce((sum, s) => sum + s.duration, 0);
      assert.ok(Math.abs(totalSceneDuration - 30) <= 2, `Total duration ${totalSceneDuration} should be close to 30`);

      for (const scene of spec.scenes) {
        assert.ok(scene.title, "Scene should have title");
        assert.ok(scene.visualDescription, "Scene should have visual description");
        assert.ok(scene.searchQuery, "Scene should have stock search query");
        assert.ok(scene.narration, "Scene should have voiceover narration");
        assert.ok(SUPPORTED_TRANSITIONS.includes(scene.transition));
      }
    });

    it("should adapt scene count and timings based on requested duration", () => {
      const shortSpec = generateLocalFallbackSpec({
        prompt: "Coffee brewing",
        targetDuration: 15,
        aspectRatio: "1:1",
      });
      assert.ok(shortSpec.scenes.length >= 3);
      assert.equal(shortSpec.aspectRatio, "1:1");

      const longSpec = generateLocalFallbackSpec({
        prompt: "Space exploration history",
        targetDuration: 60,
        aspectRatio: "16:9",
      });
      assert.ok(longSpec.scenes.length >= 5);
    });
  });

  describe("Ollama LLM Orchestration & Error Fallbacks", () => {
    it("should successfully parse valid model output from Ollima", async () => {
      const mockLlmSpec = {
        schemaVersion: 1,
        title: "Urban Skyline at Dusk",
        summary: "Cinematic drone view of skyscrapers at sunset.",
        targetDuration: 15,
        aspectRatio: "9:16",
        style: "cinematic",
        narration: {
          enabled: true,
          voiceId: "af_heart",
          language: "en",
          script: "As dusk falls, the city transforms into a labyrinth of light.",
        },
        music: {
          enabled: true,
          mood: "synthwave",
          volume: 0.2,
        },
        captions: {
          enabled: true,
          stylePreset: "neon",
        },
        scenes: [
          {
            id: "scene-1",
            title: "Golden Hour Glow",
            duration: 7.5,
            visualDescription: "Drone shot gliding over glowing glass towers during sunset.",
            searchQuery: "city skyline sunset drone",
            narration: "As dusk falls across the metropolitan canyon...",
            caption: "As dusk falls",
            transition: "fade",
          },
          {
            id: "scene-2",
            title: "Neon Awakening",
            duration: 7.5,
            visualDescription: "Night falls as neon signs and headlights streak through the streets.",
            searchQuery: "neon city night traffic timelapse",
            narration: "The city awakens with electric energy.",
            caption: "Electric energy",
            transition: "zoom",
          },
        ],
      };

      const mockFetchSuccess = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify(mockLlmSpec),
              },
            },
          ],
        }),
      });

      const spec = await generateVideoSpecification({
        prompt: "A drone video of skyscrapers at dusk",
        targetDuration: 15,
        aspectRatio: "9:16",
        style: "cinematic",
        overrides: {
          apiKey: "ollima-test-key",
          model: "deepseek-v4-flash",
          fetchFn: mockFetchSuccess,
        },
      });

      assert.equal(spec.title, "Urban Skyline at Dusk");
      assert.equal(spec.scenes.length, 2);
      assert.equal(spec.scenes[0].transition, "fade");
    });

    it("should strip markdown fences from Ollima output before parsing", async () => {
      const mockLlmSpec = {
        schemaVersion: 1,
        title: "Clean JSON with Fences",
        targetDuration: 15,
        scenes: [
          { title: "S1", duration: 7.5, transition: "fade" },
          { title: "S2", duration: 7.5, transition: "fade" },
        ],
      };

      const fenced = "```json\n" + JSON.stringify(mockLlmSpec) + "\n```";
      const mockFetchFenced = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: fenced } }],
        }),
      });

      const spec = await generateVideoSpecification({
        prompt: "Fenced prompt",
        targetDuration: 15,
        overrides: {
          apiKey: "ollima-key",
          fetchFn: mockFetchFenced,
        },
      });

      assert.equal(spec.title, "Clean JSON with Fences");
    });

    it("should transparently fall back to local spec when Ollima returns HTTP 500", async () => {
      const mockFetch500 = async () => ({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      const spec = await generateVideoSpecification({
        prompt: "Deep ocean exploration video",
        targetDuration: 30,
        overrides: {
          apiKey: "ollima-test-key",
          fetchFn: mockFetch500,
        },
      });

      assert.ok(spec, "Should return fallback specification");
      assert.ok(spec.scenes.length >= 3);
      assert.ok(spec.narration.script.length > 0);
    });

    it("should transparently fall back to local spec when Ollima response times out", async () => {
      const mockFetchTimeout = async () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      };

      const spec = await generateVideoSpecification({
        prompt: "Mountain trekking adventure",
        targetDuration: 30,
        overrides: {
          apiKey: "ollima-test-key",
          fetchFn: mockFetchTimeout,
        },
      });

      assert.ok(spec, "Should return fallback specification on timeout");
      assert.ok(spec.scenes.length >= 3);
    });

    it("should transparently fall back to local spec when Ollima returns malformed JSON", async () => {
      const mockFetchBadJson = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "Here is your video plan: { invalid JSON..." } }],
        }),
      });

      const spec = await generateVideoSpecification({
        prompt: "Desert dunes drone footage",
        targetDuration: 30,
        overrides: {
          apiKey: "ollima-test-key",
          fetchFn: mockFetchBadJson,
        },
      });

      assert.ok(spec, "Should return fallback specification on malformed JSON");
      assert.ok(spec.scenes.length >= 3);
    });

    it("should reject unsupported model names with 400 UNSUPPORTED_MODEL", async () => {
      await assert.rejects(
        generateVideoSpecification({
          prompt: "Valid prompt",
          model: "unsupported-super-ai",
          overrides: {
            apiKey: "ollima-key",
          },
        }),
        (err) => err.code === "UNSUPPORTED_MODEL" && err.status === 400
      );
    });
  });

  describe("API Endpoints: Retired /api/generator Endpoint Status & Service Integrity", () => {
    it("should return 404 for retired GET /api/generator/config", async () => {
      await withServer(env.app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/generator/config`);
        assert.equal(res.status, 404);
        const data = await res.json();
        assert.equal(data.code, "NOT_FOUND");
      });
    });

    it("should return 404 for GET /api/generator/config even for authenticated users", async () => {
      const session = await env.createSession("creator@example.com");

      await withServer(env.app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/generator/config`, {
          headers: { Cookie: session.cookie },
        });

        assert.equal(res.status, 404);
        const data = await res.json();
        assert.equal(data.code, "NOT_FOUND");
      });
    });

    it("should return 404 for retired POST /api/generator/spec", async () => {
      await withServer(env.app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/generator/spec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "Make a video" }),
        });
        assert.equal(res.status, 404);
        const data = await res.json();
        assert.equal(data.code, "NOT_FOUND");
      });
    });

    it("should validate prompts in direct spec service logic", async () => {
      // Empty scenes in spec validation
      assert.throws(() => {
        validateAndNormalizeVideoSpec({ scenes: [] });
      });

      // Prompt above 2000 characters should succeed in local fallback planner
      const prompt3500 = "Create an epic documentary film about world wonders: " + "exploring historical landscapes and architecture ".repeat(60);
      assert.ok(prompt3500.length > 2000 && prompt3500.length < 5000);
      const spec3500 = generateLocalFallbackSpec({ prompt: prompt3500, targetDuration: 30 });
      assert.ok(spec3500.scenes.length >= 3);

      // Prompt at exactly 5000 character boundary should succeed
      const prompt5000 = "Documentary: " + "a".repeat(5000 - 13);
      assert.equal(prompt5000.length, 5000);
      const spec5000 = generateLocalFallbackSpec({ prompt: prompt5000, targetDuration: 30 });
      assert.ok(spec5000.scenes.length >= 3);
    });

    it("should generate a complete, valid video specification via service", async () => {
      const spec = generateLocalFallbackSpec({
        prompt: "Create a 30s video exploring renewable solar energy installations",
        targetDuration: 30,
        aspectRatio: "9:16",
        style: "tech",
        voiceId: "af_heart",
      });

      assert.ok(spec);
      assert.equal(spec.schemaVersion, 1);
      assert.equal(spec.aspectRatio, "9:16");
      assert.equal(spec.style, "tech");
      assert.ok(spec.scenes.length >= 3);
      assert.ok(spec.narration.script.length > 0);
    });

    it("should accept referenceAssets in generateLocalFallbackSpec and assign them to scenes", async () => {
      const spec = generateLocalFallbackSpec({
        prompt: "Create a 30-second premium coffee advertisement using my product photo",
        targetDuration: 30,
        aspectRatio: "9:16",
        style: "cinematic",
        referenceAssets: [
          { id: "img-coffee-1", name: "coffee_bag.jpg", type: "image/jpeg", role: "product" },
          { id: "vid-pour-1", name: "b-roll_pour.mp4", type: "video/mp4", role: "alongside" },
        ],
      });

      assert.ok(spec);
      assert.equal(spec.aspectRatio, "9:16");
      assert.equal(spec.style, "cinematic");

      // Verify that reference assets are assigned to scenes
      const scenes = spec.scenes;
      assert.ok(scenes.length >= 2, "Expected at least 2 scenes");

      const productScene = scenes.find((s) => s.assignedAssetId === "img-coffee-1");
      assert.ok(productScene, "Expected a scene assigned to img-coffee-1");
      assert.equal(productScene.useReferenceAsset, true);
      assert.equal(productScene.referenceRole, "product");

      const videoScene = scenes.find((s) => s.assignedAssetId === "vid-pour-1");
      assert.ok(videoScene, "Expected a scene assigned to vid-pour-1");
      assert.equal(videoScene.useReferenceAsset, true);
      assert.equal(videoScene.referenceRole, "alongside");
    });

    it("should verify active editor routes remain mounted while generator is retired", async () => {
      await withServer(env.app, async (baseUrl) => {
        const healthRes = await fetch(`${baseUrl}/health`);
        assert.equal(healthRes.status, 200);

        const asstRes = await fetch(`${baseUrl}/api/assistant/plan`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "Make captions slightly bigger" }),
        });
        assert.notEqual(asstRes.status, 404, "Active assistant endpoint must not return 404");
      });
    });

    it("should generate fresh, distinct storyboards for sequential requests without reusing previous video spec (Bug 1 Regression)", async () => {
      // 1. First generation: Swiss Alps
      const specSwiss = generateLocalFallbackSpec({
        prompt: "Create a 30-second cinematic travel video about the Swiss Alps, 9:16 vertical, with six specified scenes, titles, music, and narration.",
        targetDuration: 30,
        aspectRatio: "9:16",
        style: "cinematic",
      });

      assert.equal(specSwiss.aspectRatio, "9:16");
      assert.equal(specSwiss.targetDuration, 30);
      assert.ok(specSwiss.scenes.length >= 3);
      assert.ok(specSwiss.title.toLowerCase().includes("swiss") || specSwiss.title.toLowerCase().includes("alps"));
      const swissQueries = specSwiss.scenes.map((s) => s.searchQuery.toLowerCase());
      assert.ok(swissQueries.some((q) => q.includes("alps") || q.includes("mountain") || q.includes("swiss")));

      // 2. Second generation: Artisanal Coffee
      const specCoffee = generateLocalFallbackSpec({
        prompt: "Create a 15-second tech showcase video about artisanal coffee, espresso brewing, and bean roasting.",
        targetDuration: 15,
        aspectRatio: "16:9",
        style: "tech",
      });

      assert.equal(specCoffee.aspectRatio, "16:9");
      assert.equal(specCoffee.targetDuration, 15);
      assert.ok(specCoffee.scenes.length >= 3);
      assert.ok(specCoffee.title.toLowerCase().includes("coffee") || specCoffee.title.toLowerCase().includes("espresso"));
      const coffeeQueries = specCoffee.scenes.map((s) => s.searchQuery.toLowerCase());
      assert.ok(coffeeQueries.some((q) => q.includes("coffee") || q.includes("espresso") || q.includes("roast")));

      // Prove that the second storyboard did NOT reuse the first storyboard's title, queries, or narration
      assert.notEqual(specCoffee.title, specSwiss.title);
      assert.notEqual(specCoffee.narration.script, specSwiss.narration.script);
      assert.notEqual(specCoffee.targetDuration, specSwiss.targetDuration);
      assert.notEqual(specCoffee.aspectRatio, specSwiss.aspectRatio);

      for (const scene of specCoffee.scenes) {
        assert.ok(!scene.searchQuery.toLowerCase().includes("alps"), "Coffee scene must not contain Swiss Alps query");
        assert.ok(!scene.visualDescription.toLowerCase().includes("alps"), "Coffee scene must not contain Swiss Alps description");
      }
    });

    it("should generate distinct, brief-specific storyboards and search candidates for Brief A (Vikas Swami) and Brief B (Swiss Alps) (P0 Repetitive Template Fix)", async () => {
      // Brief A: Vikas Swami founder film
      const briefA = "Vikas Swami founder film: real founder portrait, networking infrastructure, technical labs, professional careers.";
      const specA = generateLocalFallbackSpec({
        prompt: briefA,
        targetDuration: 30,
        aspectRatio: "16:9",
        style: "cinematic",
      });

      assert.equal(specA.aspectRatio, "16:9");
      assert.equal(specA.targetDuration, 30);
      assert.ok(specA.scenes.length >= 4);

      // Verify Brief A preserves specific concepts
      const titlesA = specA.scenes.map((s) => s.title.toLowerCase());
      const descA = specA.scenes.map((s) => s.visualDescription.toLowerCase()).join(" ");
      const queriesA = specA.scenes.map((s) => s.searchQuery.toLowerCase()).join(" ");

      assert.ok(
        descA.includes("founder") || descA.includes("leader") || descA.includes("portrait"),
        "Brief A must have founder portrait visual instructions"
      );
      assert.ok(
        descA.includes("network") || descA.includes("infrastructure") || descA.includes("server") || descA.includes("cable"),
        "Brief A must have networking infrastructure visual instructions"
      );
      assert.ok(
        descA.includes("lab") || descA.includes("engineer") || descA.includes("technical") || descA.includes("workstation"),
        "Brief A must have technical lab visual instructions"
      );

      // Must NOT contain generic hardcoded fallback titles
      assert.ok(!titlesA.includes("the heart"), "Must not contain template title 'The Heart'");
      assert.ok(!titlesA.includes("hidden wonders"), "Must not contain template title 'Hidden Wonders'");

      // Verify each scene has motion specified
      for (const scene of specA.scenes) {
        assert.ok(scene.motion, `Scene ${scene.title} must have a motion preset`);
        assert.ok(Array.isArray(scene.searchKeywords), `Scene ${scene.title} must have searchKeywords`);
        assert.ok(scene.searchKeywords.length >= 2, `Scene ${scene.title} must have at least 2 search keywords`);
      }

      // Brief B: Swiss Alps travel film
      const briefB = "Swiss Alps travel film: mountains, turquoise lakes, scenic trains and alpine villages.";
      const specB = generateLocalFallbackSpec({
        prompt: briefB,
        targetDuration: 30,
        aspectRatio: "9:16",
        style: "cinematic",
      });

      assert.equal(specB.aspectRatio, "9:16");
      assert.ok(specB.scenes.length >= 4);

      const descB = specB.scenes.map((s) => s.visualDescription.toLowerCase()).join(" ");
      const queriesB = specB.scenes.map((s) => s.searchQuery.toLowerCase()).join(" ");

      assert.ok(
        descB.includes("mountain") || descB.includes("peak") || descB.includes("alps"),
        "Brief B must have mountain visual instructions"
      );
      assert.ok(
        descB.includes("lake") || descB.includes("turquoise") || descB.includes("water"),
        "Brief B must have turquoise lake visual instructions"
      );
      assert.ok(
        descB.includes("train") || descB.includes("viaduct") || descB.includes("railway"),
        "Brief B must have scenic train visual instructions"
      );
      assert.ok(
        descB.includes("village") || descB.includes("chalet") || descB.includes("alpine"),
        "Brief B must have alpine village visual instructions"
      );

      // Verify that Brief B does not leak any Brief A concepts
      assert.ok(!queriesB.includes("founder"), "Brief B queries must not mention founder");
      assert.ok(!queriesB.includes("network"), "Brief B queries must not mention network");
      assert.ok(!descB.includes("vikas"), "Brief B visual description must not mention Vikas");
      assert.ok(!queriesA.includes("lake"), "Brief A queries must not mention lake");
      assert.ok(!queriesA.includes("alps"), "Brief A queries must not mention alps");

      // Verify schema normalization preserves motion and searchKeywords
      const normalizedA = validateAndNormalizeVideoSpec(specA);
      for (let i = 0; i < normalizedA.scenes.length; i++) {
        assert.equal(normalizedA.scenes[i].motion, specA.scenes[i].motion);
        assert.deepEqual(normalizedA.scenes[i].searchKeywords, specA.scenes[i].searchKeywords);
      }
    });

    it("should return 404 for retired POST /api/generator/tts", async () => {
      await withServer(env.app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/generator/tts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "Testing TTS" }),
        });
        assert.equal(res.status, 404);
        const data = await res.json();
        assert.equal(data.code, "NOT_FOUND");
      });
    });

    it("should synthesize spoken audio via synthesizeSpeech service with valid WAV headers and duration", async () => {
      const mockEngine = {
        generate: async (text) => {
          const sampleRate = 24000;
          const durationSeconds = Math.max(1.5, (text.split(/\s+/).length || 1) * 0.3);
          const sampleCount = Math.round(sampleRate * durationSeconds);
          const audio = new Float32Array(sampleCount);
          for (let i = 0; i < sampleCount; i++) {
            audio[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
          }
          return { audio };
        },
      };

      setKokoroProvider(mockEngine);
      try {
        const res = await synthesizeSpeech({
          text: "Welcome to Timeline Studio video creation.",
          voiceId: "af_heart",
          speed: 1,
        });

        assert.ok(res);
        assert.ok(res.buffer instanceof Buffer);
        assert.ok(res.duration > 1.0 && res.duration < 10.0, `Duration ${res.duration}s must be a realistic speech duration`);
        assert.ok(res.buffer.length > 10000, "WAV buffer must contain real audio samples (>10KB)");
        assert.equal(res.buffer.slice(0, 4).toString(), "RIFF");
        assert.equal(res.buffer.slice(8, 12).toString(), "WAVE");
        assert.equal(res.buffer.slice(12, 16).toString(), "fmt ");
      } finally {
        resetKokoroProvider();
      }
    });

    it("should synthesize scene-by-scene audio via synthesizeSpeech service and return exact scene timings", async () => {
      const mockEngine = {
        generate: async (text) => {
          const sampleRate = 24000;
          const durationSeconds = Math.max(1.2, (text.split(/\s+/).length || 1) * 0.2);
          const sampleCount = Math.round(sampleRate * durationSeconds);
          const audio = new Float32Array(sampleCount);
          for (let i = 0; i < sampleCount; i++) {
            audio[i] = 0.3 * Math.sin((2 * Math.PI * 330 * i) / sampleRate);
          }
          return { audio };
        },
      };

      setKokoroProvider(mockEngine);
      try {
        const res = await synthesizeSpeech({
          scenes: [
            "Modern technology connects our world in ways once unimaginable.",
            "Behind every digital experience, powerful infrastructure processes enormous amounts of data.",
          ],
          voiceId: "af_heart",
          speed: 1,
        });

        assert.ok(res);
        assert.ok(Array.isArray(res.sceneTimings));
        assert.equal(res.sceneTimings.length, 2, "Must return timings for both scenes");
        assert.equal(res.sceneTimings[0].index, 0);
        assert.ok(res.sceneTimings[0].duration > 1.0);
        assert.equal(res.sceneTimings[1].index, 1);
        assert.ok(res.sceneTimings[1].start >= res.sceneTimings[0].end, "Scene 1 start must be after Scene 0 end (including pause)");
      } finally {
        resetKokoroProvider();
      }
    });

    it("should accurately persist requested aspect ratio (16:9, 9:16, 1:1) without defaulting or polluting", async () => {
      // Test 16:9 explicit request with "portrait" in prompt (founder portrait)
      const spec169 = generateLocalFallbackSpec({
        prompt: "Founder profile film: executive portrait and datacenter tour",
        aspectRatio: "16:9",
      });
      assert.equal(spec169.aspectRatio, "16:9", "Explicit 16:9 must be preserved even with word 'portrait' in prompt");

      // Test 1:1 square request
      const spec11 = generateLocalFallbackSpec({
        prompt: "Product square showcase",
        aspectRatio: "1:1",
      });
      assert.equal(spec11.aspectRatio, "1:1", "1:1 square ratio must be preserved");

      // Test 9:16 vertical request
      const spec916 = generateLocalFallbackSpec({
        prompt: "Mobile reel for Instagram",
        aspectRatio: "9:16",
      });
      assert.equal(spec916.aspectRatio, "9:16", "9:16 vertical ratio must be preserved");
    });
  });

  describe("Quality & Regression: Visual Relevance, Deduplication, & Scene Synchronization", () => {
    it("should transform abstract slogans into concrete physical visual search queries", () => {
      // Tech slogans
      assert.equal(concretizeVisualSearchQuery("Collaboration drives innovation", "tech"), "software engineers in tech office meeting room");
      assert.equal(concretizeVisualSearchQuery("Shaping the future", "tech", true), "modern tech campus glass building dusk sunset");
      assert.equal(concretizeVisualSearchQuery("Powering the digital economy", "tech"), "data center fiber optic cables server");
      assert.equal(concretizeVisualSearchQuery("Bengaluru: India's Silicon Valley", "tech"), "Bangalore skyline UB City architecture");
      assert.equal(concretizeVisualSearchQuery("Networkers Home labs and theory into practice", "tech"), "computer lab students engineering classroom");
      assert.equal(concretizeVisualSearchQuery("Meet Vikas Swami — founder", "tech"), "confident business executive portrait modern office");

      // Technology brief concretizations
      assert.equal(
        concretizeVisualSearchQuery("Engineers turn complex ideas into reliable systems that solve real problems", "tech"),
        "software engineers coding at computer workstations in modern tech office"
      );
      assert.equal(
        concretizeVisualSearchQuery("Every connection depends on precision, performance, and attention to detail", "tech"),
        "electronics circuit board soldering cleanroom manufacturing"
      );
      assert.equal(
        concretizeVisualSearchQuery("Together, people and technology create solutions that move businesses forward", "tech"),
        "software engineers in tech office meeting room"
      );
      assert.equal(
        concretizeVisualSearchQuery("And this is only the beginning of a more connected future", "tech", true),
        "modern tech campus glass building dusk sunset"
      );

      // Nature & travel
      assert.equal(concretizeVisualSearchQuery("alpine villages and wooden chalets", "nature"), "picturesque Swiss alpine village wooden chalets");
    });

    it("should strictly reject negative assets (newspapers, catalogs, 3D renderings, snow in tech, garage hardware, wheat, VR headsets) in tech scenes", () => {
      const techContext = {
        title: "Collaboration drives innovation",
        visualDescription: "Software engineers collaborating in a modern office meeting room",
        searchQuery: "software engineers in tech office meeting room",
      };

      // Disqualify agricultural / wheat photos via negative filter
      assert.equal(isNegativeAsset("Golden wheat field in harvest season.jpg", techContext), true);
      // Disqualify abstract speech / ceremony photos via relevance score threshold (< 1)
      assert.ok(scoreAssetRelevance({ title: "Opening speech ‘Shaping the future’ (33651785748).jpg" }, techContext) < 1, "Unrelated speech photo must fail relevance score threshold");

      // Disqualify VR headset in collaboration scene
      assert.equal(isNegativeAsset("Creatorium person testing VR headset hardware.jpg", techContext), true);
      assert.equal(scoreAssetRelevance({ title: "Creatorium person testing VR headset hardware.jpg" }, techContext), -1);

      // Disqualify scanned newspapers, newsprint, clippings, articles, and product catalogs
      assert.equal(isNegativeAsset("The Washington Post (October 24 1999) Pixar's Palette article clipping.jpg", techContext), true);
      assert.equal(isNegativeAsset("Stanley Works Catalog 1915 Garage Hardware Door Hinges.pdf", techContext), true);
      assert.equal(isNegativeAsset("Scanned newspaper front page text clipping.jpg", techContext), true);

      // Disqualify 3D architectural CGI renderings and CAD models
      assert.equal(isNegativeAsset("Commercial building 3d architectural rendering dusk.png", techContext), true);
      assert.equal(isNegativeAsset("CGI render modern office architectural visualization.jpg", techContext), true);

      // Disqualify snowy winter landscapes/buildings in tech stories
      assert.equal(isNegativeAsset("Snowy university building winter blizzard bare trees.jpg", techContext), true);

      // Disqualify domestic garage / home hardware (hinges, door bolts)
      assert.equal(isNegativeAsset("Stanley garage door hinges and latch bolt hardware.jpg", techContext), true);

      // Disqualify desert wing aerial photo for Bangalore city
      const cityContext = {
        title: "Bengaluru: India's Silicon Valley",
        visualDescription: "Establishing view of Bangalore modern high-rise skyline",
        searchQuery: "Bangalore skyline UB City architecture",
      };
      assert.equal(isNegativeAsset("Airplane wing flying over desert dunes.jpg", cityContext), true);

      // Highly score genuine office collaboration meeting
      const goodAsset = {
        title: "Software engineers collaborating in tech office meeting room.jpg",
        imageinfo: [{ width: 1920, height: 1080 }],
      };
      const score = scoreAssetRelevance(goodAsset, techContext);
      assert.ok(score >= 5, `Relevant asset must score highly (got ${score})`);
    });

    it("should normalize and prevent duplicate assets across timestamps even with varied Flickr IDs or formats", () => {
      const key1 = normalizeCanonicalMediaKey("File:Opening speech ‘Shaping the future’ (33651785748).jpg");
      const key2 = normalizeCanonicalMediaKey("File:Opening speech ‘Shaping the future’ (47475767412).jpg");
      assert.equal(key1, "opening speech shaping the future");
      assert.equal(key2, "opening speech shaping the future");
      assert.equal(key1, key2, "Canonical keys must match across Flickr ID variations to prevent repetition");
    });

    it("should assign founder reference asset to the founder scene, NEVER the establishing city scene", () => {
      const spec = generateLocalFallbackSpec({
        prompt: "Bengaluru tech story. A city that never stops transmitting. Meet Vikas Swami — founder of Networkers Home. Dual CCIE certification and labs.",
        targetDuration: 30,
        aspectRatio: "16:9",
        style: "tech",
        referenceAssets: [
          { id: "ref-vikas-swami", name: "Vikas Swami Portrait.jpg", role: "founder", type: "image/jpeg" },
        ],
      });

      // Scene 0 is establishing city shot -> MUST NOT be assigned reference portrait
      assert.equal(spec.scenes[0].assignedAssetId, undefined, "Scene 0 establishing shot must NOT have founder portrait assigned");
      assert.equal(spec.scenes[0].useReferenceAsset, false);

      // The Founder scene -> MUST have founder reference asset assigned
      const founderScene = spec.scenes.find((s) => s.assignedAssetId === "ref-vikas-swami");
      assert.ok(founderScene, "Must assign founder reference asset to the founder scene");
      assert.equal(founderScene.useReferenceAsset, true);
      assert.match(founderScene.title, /Executive Portrait/i);
    });

    it("should synchronize scene durations with spoken narration and eliminate dead air gaps across diverse briefs", () => {
      const spec = {
        schemaVersion: 1,
        title: "Enterprise Networking Leadership",
        aspectRatio: "16:9",
        style: "tech",
        finalDuration: 18,
        narration: { enabled: true, voiceId: "af_heart" },
        music: { enabled: true, mood: "tech ambient", volume: 0.25 },
        captions: { enabled: true, stylePreset: "neon" },
        scenes: [
          {
            id: "sc-1",
            title: "The City That Never Stops Transmitting",
            duration: 3,
            visualDescription: "Bangalore modern skyline",
            narration: "Bengaluru. A city that never stops transmitting. Every signal and session depends on strong infrastructure.",
          },
          {
            id: "sc-2",
            title: "The Founder",
            duration: 3,
            visualDescription: "Executive founder portrait",
            narration: "Meet Vikas Swami — founder of Networkers Home.",
          },
          {
            id: "sc-3",
            title: "Engineering the Next Chapter",
            duration: 3,
            visualDescription: "Modern tech campus dusk sunset",
            narration: "Vikas Swami. Engineering the next chapter.",
          },
        ],
      };

      const sceneAssets = [
        { id: "a1", type: "image", width: 1920, height: 1080, name: "Bangalore Skyline.jpg", mediaCategory: "stock" },
        { id: "a2", type: "image", width: 1920, height: 1080, name: "Vikas Swami.jpg", mediaCategory: "reference" },
        { id: "a3", type: "image", width: 1920, height: 1080, name: "Tech Campus Sunset.jpg", mediaCategory: "stock" },
      ];

      // Simulate real TTS audio of 12.5 seconds
      const fakeNarration = {
        blob: { size: 60000 },
        duration: 12.5,
        peaks: new Array(96).fill(0.8),
      };

      const fakeMusic = {
        blob: { size: 100000 },
        duration: 30,
        peaks: new Array(96).fill(0.4),
      };

      const assembled = assembleGeneratedProject(spec, sceneAssets, fakeNarration, fakeMusic);

      // Verify scene duration allocation is proportional to narration word count
      const dur0 = assembled.visualSegments[0].duration;
      const dur1 = assembled.visualSegments[1].duration;
      assert.ok(dur0 > dur1, "Scene 0 (15 words) must be longer than Scene 1 (7 words)");

      // Verify background music covers the entire video duration without leaving silence
      assert.equal(assembled.musicSegments[0].duration, assembled.duration);
      assert.ok(assembled.duration >= fakeNarration.duration, "Total video duration must cover entire narration");

      // Verify no duplicate assets across scenes
      const assetIds = assembled.visualSegments.map((s) => s.assetId);
      const uniqueAssetIds = new Set(assetIds);
      assert.equal(uniqueAssetIds.size, assetIds.length, "No two scenes can share identical assetId");

      // Verify aspect ratio width/height
      assert.equal(assembled.ratioId, "16:9");
      assert.equal(assembled.visualSegments[0].width, 1920);
      assert.equal(assembled.visualSegments[0].height, 1080);

      // Verify captions strictly match spoken narration verbatim (NOT headline summary cards)
      assert.equal(assembled.captionSegments[0].text, spec.scenes[0].narration);
      assert.equal(assembled.captionSegments[1].text, spec.scenes[1].narration);
      assert.equal(assembled.captionSegments[2].text, spec.scenes[2].narration);

      // Verify each caption segment has valid word timings for karaoke highlighting
      for (let i = 0; i < assembled.captionSegments.length; i++) {
        const cap = assembled.captionSegments[i];
        assert.ok(Array.isArray(cap.words) && cap.words.length > 0, `Caption ${i} must have words array`);
        const validation = validateSegmentWords(cap.words, cap.start, cap.end);
        assert.equal(validation.valid, true, `Caption ${i} words must be valid for karaoke: ${validation.error}`);
        // Ensure caption does not linger past the visual cut (leaves breathing pause)
        assert.ok(cap.end <= assembled.visualSegments[i].end, `Caption ${i} end must not exceed visual cut`);
      }
    });

    it("should accurately align captions and visual cuts when sceneTimings are provided from TTS", () => {
      const spec = {
        title: "Modern Technology",
        aspectRatio: "16:9",
        style: "tech",
        scenes: [
          {
            id: "s1",
            title: "Scene 1",
            duration: 5,
            narration: "Modern technology connects our world in ways once unimaginable.",
            caption: "Technology connects our world.", // LLM editorial headline card
          },
          {
            id: "s2",
            title: "Scene 2",
            duration: 5,
            narration: "Behind every digital experience, powerful infrastructure processes enormous amounts of data.",
            caption: "Powerful infrastructure behind every experience.", // LLM editorial headline card
          },
        ],
      };

      const sceneAssets = [
        { id: "a1", name: "Skyline.jpg", type: "image", width: 1920, height: 1080 },
        { id: "a2", name: "Server.jpg", type: "image", width: 1920, height: 1080 },
      ];

      const sceneTimings = [
        { index: 0, text: spec.scenes[0].narration, start: 0.0, end: 3.6, duration: 3.6 },
        { index: 1, text: spec.scenes[1].narration, start: 3.95, end: 9.15, duration: 5.2 },
      ];

      const narrationData = {
        duration: 9.15,
        sceneTimings,
        peaks: new Array(96).fill(0.7),
      };

      const assembled = assembleGeneratedProject(spec, sceneAssets, narrationData, null);

      // Verbatim spoken words used, not editorial summary cards
      assert.equal(assembled.captionSegments[0].text, spec.scenes[0].narration);
      assert.equal(assembled.captionSegments[1].text, spec.scenes[1].narration);

      // Exact speech boundaries
      assert.equal(assembled.captionSegments[0].start, 0.0);
      assert.equal(assembled.captionSegments[0].end, 3.6);
      assert.equal(assembled.captionSegments[1].start, 3.95);
      assert.equal(assembled.captionSegments[1].end, 9.15);

      // Caption 0 does not linger into the 3.6s-3.95s silence gap
      assert.ok(assembled.captionSegments[0].end <= 3.6);
      assert.ok(assembled.visualSegments[0].end >= 3.95);

      // Karaoke word timestamps exist and validate
      const cap0WordsValidation = validateSegmentWords(assembled.captionSegments[0].words, 0.0, 3.6);
      assert.equal(cap0WordsValidation.valid, true);
      assert.equal(assembled.captionSegments[0].words[0].text, "Modern");
    });
  });

  describe("P0 Ken Burns Smart-Frame Motion in Generated Videos", () => {
    const baseSpec = {
      title: "Ken Burns Motion Verification",
      aspectRatio: "16:9",
      style: "cinematic",
      narration: { enabled: true, script: "Scenic drone shot over the mountain ridge." },
      music: { enabled: true, mood: "ambient", volume: 0.25 },
      scenes: [
        {
          id: "sc-1",
          title: "Mountain Ridge Still",
          duration: 4,
          motion: "zoom_in",
          visualDescription: "Aerial view of mountain range in golden hour",
          narration: "Scenic drone shot over the mountain ridge.",
        },
        {
          id: "sc-2",
          title: "Valley River Still",
          duration: 4,
          motion: "pan_right",
          visualDescription: "Winding river through forest valley",
          narration: "A winding river flowing through a lush green valley.",
        },
      ],
    };

    const imageAssets = [
      { id: "img-1", type: "image", width: 1920, height: 1080, name: "Mountain.jpg", mediaCategory: "stock" },
      { id: "img-2", type: "image", width: 1920, height: 1080, name: "Valley.jpg", mediaCategory: "stock" },
    ];

    const fakeNarration = {
      blob: { size: 40000 },
      duration: 8,
      peaks: new Array(64).fill(0.7),
    };

    const fakeMusic = {
      blob: { size: 80000 },
      duration: 16,
      peaks: new Array(64).fill(0.3),
    };

    it("should attach smartFrame directly to visual segments and preserve keyframes for still images", () => {
      const assembled = assembleGeneratedProject(baseSpec, imageAssets, fakeNarration, fakeMusic);

      assert.equal(assembled.visualSegments.length, 2);

      for (let i = 0; i < assembled.visualSegments.length; i++) {
        const segment = assembled.visualSegments[i];
        assert.ok(segment.smartFrame, `Segment ${i} must have smartFrame attached directly at root`);
        assert.equal(segment.smartFrame.enabled, true, `Segment ${i} smartFrame must be enabled`);
        assert.ok(Array.isArray(segment.smartFrame.cropKeyframes), `Segment ${i} must contain cropKeyframes array`);
        assert.ok(segment.smartFrame.cropKeyframes.length >= 2, `Segment ${i} must have at least 2 crop keyframes`);
        assert.equal(segment.smartFrame.cropKeyframes[0].time, 0, "First keyframe must start at time 0");
        assert.ok(segment.smartFrame.cropKeyframes[1].time >= segment.duration, "Last keyframe must reach end of clip duration");

        // Verify no conflicting duplicate representations
        assert.equal(segment.cropKeyframes, undefined, "Segment must not have redundant top-level cropKeyframes");
        assert.equal(segment.visualEffects?.smartFrame, undefined, "Segment must not have duplicate visualEffects.smartFrame");
      }
    });

    it("should produce continuously changing crop coordinates over time (Ken Burns pan/zoom motion)", () => {
      const assembled = assembleGeneratedProject(baseSpec, imageAssets, fakeNarration, fakeMusic);
      const zoomSegment = assembled.visualSegments[0]; // zoom_in
      const panSegment = assembled.visualSegments[1];  // pan_right

      // 1. Test zoom_in motion over time
      const cropZoomStart = resolveSmartFrameCropAtTime(zoomSegment.smartFrame, 0);
      const cropZoomMid = resolveSmartFrameCropAtTime(zoomSegment.smartFrame, zoomSegment.duration / 2);
      const cropZoomEnd = resolveSmartFrameCropAtTime(zoomSegment.smartFrame, zoomSegment.duration);

      assert.ok(cropZoomStart, "Start crop must resolve");
      assert.ok(cropZoomMid, "Mid crop must resolve");
      assert.ok(cropZoomEnd, "End crop must resolve");

      // In zoom_in, width and height decrease over time (zooming into the image)
      assert.ok(cropZoomStart.width > cropZoomEnd.width, "Zoom in: width must decrease over time");
      assert.ok(cropZoomStart.height > cropZoomEnd.height, "Zoom in: height must decrease over time");
      assert.ok(cropZoomMid.width < cropZoomStart.width && cropZoomMid.width > cropZoomEnd.width, "Midpoint width must interpolate smoothly");
      assert.ok(cropZoomEnd.x > cropZoomStart.x, "Zoom in: x offset moves towards crop center");

      // 2. Test pan_right motion over time
      const cropPanStart = resolveSmartFrameCropAtTime(panSegment.smartFrame, 0);
      const cropPanMid = resolveSmartFrameCropAtTime(panSegment.smartFrame, panSegment.duration / 2);
      const cropPanEnd = resolveSmartFrameCropAtTime(panSegment.smartFrame, panSegment.duration);

      assert.ok(cropPanStart, "Pan start crop must resolve");
      assert.ok(cropPanMid, "Pan mid crop must resolve");
      assert.ok(cropPanEnd, "Pan end crop must resolve");

      // In pan_right, x increases over time while height and width remain steady
      assert.ok(cropPanEnd.x > cropPanStart.x, "Pan right: x coordinate must increase over time");
      assert.ok(cropPanMid.x > cropPanStart.x && cropPanMid.x < cropPanEnd.x, "Pan right: midpoint x must be strictly between start and end");
      assert.equal(cropPanStart.y, cropPanEnd.y, "Pan right: y coordinate remains stable");
    });

    it("should preserve backward compatibility for legacy projects with visualEffects.smartFrame", () => {
      const legacySegment = {
        id: "legacy-clip-1",
        type: "image",
        duration: 5,
        visualEffects: {
          smartFrame: {
            version: 2,
            enabled: true,
            targetRatio: "16:9",
            presentation: "crop",
            sourceSize: { width: 1920, height: 1080 },
            cropKeyframes: [
              { time: 0, x: 0, y: 0, width: 1, height: 1, confidence: 1 },
              { time: 5, x: 0.1, y: 0.1, width: 0.8, height: 0.8, confidence: 1 },
            ],
          },
        },
      };

      // 1. normalizeSmartFrame accepts legacy structure
      const normalized = normalizeSmartFrame(legacySegment);
      assert.ok(normalized, "normalizeSmartFrame must successfully extract and normalize legacy smartFrame");
      assert.equal(normalized.cropKeyframes.length, 2);

      // 2. Fallback resolution works exactly as in media.js / offlineVideoExport
      const smartFrameRecord = legacySegment.smartFrame || legacySegment.visualEffects?.smartFrame;
      const cropStart = resolveSmartFrameCropAtTime(smartFrameRecord, 0);
      const cropEnd = resolveSmartFrameCropAtTime(smartFrameRecord, 5);

      assert.ok(cropStart, "Legacy start crop must resolve");
      assert.ok(cropEnd, "Legacy end crop must resolve");
      assert.equal(cropStart.width, 1);
      assert.equal(cropEnd.width, 0.8);
    });

    it("should leave ordinary video clips unaffected unless motion is explicitly requested", () => {
      const mixedSpec = {
        title: "Mixed Media Project",
        aspectRatio: "16:9",
        narration: { enabled: true, script: "Video and image combination." },
        music: { enabled: true, mood: "ambient", volume: 0.25 },
        scenes: [
          { id: "s-1", title: "Video Scene Default", duration: 5, visualDescription: "Drone footage flying" },
          { id: "s-2", title: "Video Scene Explicit Motion", duration: 5, motion: "zoom_in", visualDescription: "City timelapse" },
          { id: "s-3", title: "Image Scene Default", duration: 5, visualDescription: "Still photo" },
        ],
      };

      const mixedAssets = [
        { id: "v-1", type: "video", width: 1920, height: 1080, duration: 5, name: "Drone.mp4" },
        { id: "v-2", type: "video", width: 1920, height: 1080, duration: 5, name: "City.mp4" },
        { id: "img-3", type: "image", width: 1920, height: 1080, name: "Photo.jpg" },
      ];

      const assembled = assembleGeneratedProject(mixedSpec, mixedAssets, fakeNarration, fakeMusic);

      // 1. Ordinary video without explicit motion -> smartFrame is null (native footage motion preserved)
      assert.equal(assembled.visualSegments[0].smartFrame, null, "Ordinary video without scene.motion must have null smartFrame");

      // 2. Video with explicit motion -> smartFrame is generated
      assert.ok(assembled.visualSegments[1].smartFrame, "Video with explicit scene.motion must have smartFrame");
      assert.equal(assembled.visualSegments[1].smartFrame.motionType, "zoom_in");

      // 3. Image -> smartFrame is automatically generated (Ken Burns)
      assert.ok(assembled.visualSegments[2].smartFrame, "Image must have Ken Burns smartFrame generated");
    });

    it("should adapt smartFrame dimensions and targetRatio across 16:9, 9:16, and 1:1 while preserving captions and audio", () => {
      const ratios = ["16:9", "9:16", "1:1"];

      for (const ratio of ratios) {
        const spec = {
          ...baseSpec,
          aspectRatio: ratio,
        };
        const ratioAssets = [
          { id: "img-1", type: "image", name: "Photo 1.jpg" },
          { id: "img-2", type: "image", name: "Photo 2.jpg" },
        ];
        const assembled = assembleGeneratedProject(spec, ratioAssets, fakeNarration, fakeMusic);

        assert.equal(assembled.ratioId, ratio);
        assert.equal(assembled.visualSegments[0].smartFrame.targetRatio, ratio);

        if (ratio === "16:9") {
          assert.equal(assembled.visualSegments[0].smartFrame.sourceSize.width, 1280);
          assert.equal(assembled.visualSegments[0].smartFrame.sourceSize.height, 720);
        } else if (ratio === "9:16") {
          assert.equal(assembled.visualSegments[0].smartFrame.sourceSize.width, 720);
          assert.equal(assembled.visualSegments[0].smartFrame.sourceSize.height, 1280);
        } else if (ratio === "1:1") {
          assert.equal(assembled.visualSegments[0].smartFrame.sourceSize.width, 1080);
          assert.equal(assembled.visualSegments[0].smartFrame.sourceSize.height, 1080);
        }

        // Verify captions and audio remain synchronized
        assert.equal(assembled.captionSegments.length, spec.scenes.length);
        assert.equal(assembled.audioSegments.length, 1);
        assert.equal(assembled.musicSegments.length, 1);
        assert.equal(assembled.musicSegments[0].duration, assembled.duration);
      }
    });

    it("should reject unrelated logos, ESO logo, brandmarks, and insignia via isNegativeAsset unless explicitly requested", () => {
      const techScene = {
        title: "Inside the World of Modern Technology",
        visualDescription: "Rows of server racks glowing in a high-tech data center",
        searchQuery: "data center server infrastructure",
      };

      // Unrelated ESO logo must be disqualified
      assert.equal(isNegativeAsset("File:ESO logo (eso colour).jpg", techScene), true);
      assert.equal(isNegativeAsset("File:European Southern Observatory ESO logo.png", techScene), true);
      assert.equal(isNegativeAsset("File:Company Brandmark Logo.svg", techScene), true);
      assert.equal(isNegativeAsset("File:Corporate Insignia Emblem.png", techScene), true);
      assert.equal(isNegativeAsset("File:Watermarked Stock Image.jpg", techScene), true);

      // Legitimate tech assets must NOT be disqualified
      assert.equal(isNegativeAsset("File:Wikimedia Foundation Servers-8055 35.jpg", techScene), false);
      assert.equal(isNegativeAsset("File:Modern Data Center Server Racks.jpg", techScene), false);
      assert.equal(isNegativeAsset("File:Cabling in Server Room.jpg", techScene), false);

      // If user explicitly asks for ESO or a logo, it should be permitted
      const logoScene = {
        title: "ESO Astronomy Headquarters",
        visualDescription: "The official ESO logo and emblem",
        searchQuery: "ESO logo",
      };
      assert.equal(isNegativeAsset("File:ESO logo (eso colour).jpg", logoScene), false);
    });

    it("should default to gemini-3-flash and report effectiveModel without secret exposure", async () => {
      let sentModel = null;
      const mockFetch = async (_url, opts) => {
        const body = JSON.parse(opts.body);
        sentModel = body.model;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    schemaVersion: 1,
                    title: "Gemini 3 Flash Generation",
                    targetDuration: 15,
                    scenes: [
                      { title: "Scene 1", duration: 7.5, transition: "fade", searchQuery: "data center servers" },
                      { title: "Scene 2", duration: 7.5, transition: "fade", searchQuery: "fiber optic cabling" },
                    ],
                  }),
                },
              },
            ],
          }),
        };
      };

      const spec = await generateVideoSpecification({
        prompt: "Inside the World of Modern Technology",
        targetDuration: 15,
        overrides: {
          apiKey: "test-gemini-key",
          fetchFn: mockFetch,
        },
      });

      assert.equal(sentModel, "gemini-3-flash");
      assert.equal(spec.effectiveModel, "gemini-3-flash");
      assert.equal(spec.isFallbackSpec, false);
    });

    it("should transparently report fallback when Ollima fails or is unconfigured", async () => {
      const fallbackSpec = await generateVideoSpecification({
        prompt: "Inside the World of Modern Technology",
        targetDuration: 15,
        overrides: {
          apiKey: "",
        },
      });

      assert.equal(fallbackSpec.effectiveModel, "local-deterministic-planner");
      assert.equal(fallbackSpec.isFallbackSpec, true);
      assert.equal(fallbackSpec.fallbackReason, "OLLIMA_API_KEY_NOT_CONFIGURED");
    });

    it("should return 404 NOT_FOUND for retired GET /api/generator/config with auth", async () => {
      const user = await env.createSession("gen-config-user@example.com");

      await withServer(env.app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/generator/config`, {
          headers: { Cookie: user.cookie },
        });
        assert.equal(res.status, 404);
        const data = await res.json();
        assert.equal(data.code, "NOT_FOUND");
      });
    });
  });
});


