import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyUserIntent,
  extractDuration,
  extractAspectRatio,
  extractStyle,
} from "../../src/lib/intentClassifier.js";

describe("AI Assistant Intent Classifier", () => {
  describe("Exact Swiss Alps Manual Test Prompt", () => {
    const swissAlpsPrompt =
      "Create a 30-second cinematic travel video about the Swiss Alps for Instagram Reels and YouTube Shorts, 9:16 vertical, 1080 × 1920, 30 FPS, with six specified scenes, titles, music, and narration.";

    it("should classify the exact Swiss Alps prompt as unsupported_creation", () => {
      const res = classifyUserIntent(swissAlpsPrompt);
      assert.equal(res.type, "unsupported_creation");
      assert.ok(res.message);
      assert.equal(res.params?.prompt, swissAlpsPrompt);
    });

    it("should classify detailed video briefs with multi-scene storyboard as unsupported_creation", () => {
      const briefPrompt = `Create a 30-second cinematic travel video about the Swiss Alps for Instagram Reels and YouTube Shorts, 9:16 vertical, 1080 × 1920, 30 FPS, with six specified scenes, titles, music, and narration.
Scene 1: Snow-capped peaks under crisp morning light.
Scene 2: Alpine meadows with yellow wildflowers.
Scene 3: Red mountain train on a stone viaduct.
Scene 4: Crystal clear glacial lake reflection.
Scene 5: Traditional wooden chalet at dusk.
Scene 6: Sunset over mountain ridge.
Music: Ambient acoustic.
Narration: Discover timeless beauty.`;

      const res = classifyUserIntent(briefPrompt);
      assert.equal(res.type, "unsupported_creation");
      assert.ok(res.message);
      assert.equal(res.params?.prompt, briefPrompt);
    });
  });

  describe("Short and Platform Video Generation Intent Detection", () => {
    it("should classify creating a 30-second cinematic video as unsupported_creation", () => {
      const res = classifyUserIntent("Create a 30-second cinematic travel video about Switzerland.");
      assert.equal(res.type, "unsupported_creation");
      assert.ok(res.message);
    });

    it("should classify generating a vertical video for TikTok as unsupported_creation", () => {
      const res = classifyUserIntent("Generate a vertical video about coffee roasting for TikTok.");
      assert.equal(res.type, "unsupported_creation");
      assert.ok(res.message);
    });

    it("should classify making a new 15-second promotional video as unsupported_creation", () => {
      const res = classifyUserIntent("Make a new 15-second promotional video about our product.");
      assert.equal(res.type, "unsupported_creation");
      assert.ok(res.message);
    });

    it("should classify producing a documentary as unsupported_creation", () => {
      const res = classifyUserIntent("Produce a 60-second tech documentary about artificial intelligence.");
      assert.equal(res.type, "unsupported_creation");
      assert.ok(res.message);
    });

    it("should classify Prompt to video prefixes as unsupported_creation", () => {
      const res = classifyUserIntent("Prompt to video: Cyberpunk metropolis in 2099.");
      assert.equal(res.type, "unsupported_creation");
      assert.ok(res.message);
    });
  });

  describe("Project Editing Intent Detection", () => {
    it("should classify aspect ratio changes on project as editing", () => {
      const res = classifyUserIntent("Change my current video's aspect ratio to 9:16.");
      assert.equal(res.type, "editing");
    });

    it("should classify pause/silence removal as editing", () => {
      const res = classifyUserIntent("Remove long pauses.");
      assert.equal(res.type, "editing");
    });

    it("should classify adding captions to current project as editing", () => {
      const res = classifyUserIntent("Add English captions to this project.");
      assert.equal(res.type, "editing");
    });

    it("should classify clip splitting as editing", () => {
      const res = classifyUserIntent("Split the first clip at 3 seconds.");
      assert.equal(res.type, "editing");
    });

    it("should classify clip trimming as editing", () => {
      const res = classifyUserIntent("Trim the video to 5 seconds.");
      assert.equal(res.type, "editing");
    });

    it("should classify caption styling as editing", () => {
      const res = classifyUserIntent("Set caption style to neon and position bottom.");
      assert.equal(res.type, "editing");
    });

    it("should classify chapter markers as editing", () => {
      const res = classifyUserIntent("Add a chapter marker at 2.0 seconds.");
      assert.equal(res.type, "editing");
    });

    it("should classify rough cut operations as editing", () => {
      const res = classifyUserIntent("Apply rough cut to strip filler words and silence.");
      assert.equal(res.type, "editing");
    });

    it("should classify audio volume / muting as editing", () => {
      const res = classifyUserIntent("Mute the background music track.");
      assert.equal(res.type, "editing");
    });

    it("should classify setting canvas fit mode as editing", () => {
      const res = classifyUserIntent("Set fit mode to cover.");
      assert.equal(res.type, "editing");
    });

    it("should classify refining captions and music volume as editing", () => {
      const res = classifyUserIntent("Make the captions larger and reduce the background music volume.");
      assert.equal(res.type, "editing");
    });

    it("should classify edits explicitly targeting the generated video as editing", () => {
      const res = classifyUserIntent("In the generated video, remove long pauses and add captions.");
      assert.equal(res.type, "editing");
    });
  });

  describe("Ambiguous Intent Detection & Clarification", () => {
    it("should flag short topic-only video queries as ambiguous", () => {
      const res = classifyUserIntent("A video about dogs");
      assert.equal(res.type, "ambiguous");
      assert.ok(res.clarification?.message);
      assert.ok(res.clarification?.options?.length >= 2);
    });

    it("should flag Switzerland travel video as ambiguous", () => {
      const res = classifyUserIntent("Switzerland travel video");
      assert.equal(res.type, "ambiguous");
    });

    it("should flag 'make it 30 seconds' as ambiguous", () => {
      const res = classifyUserIntent("make it 30 seconds");
      assert.equal(res.type, "ambiguous");
    });

    it("should flag 'new video' as ambiguous", () => {
      const res = classifyUserIntent("new video");
      assert.equal(res.type, "ambiguous");
    });
  });

  describe("Parameter Extraction Helpers", () => {
    it("should extract durations correctly", () => {
      assert.equal(extractDuration("15 seconds"), 15);
      assert.equal(extractDuration("30s"), 30);
      assert.equal(extractDuration("30-second"), 30);
      assert.equal(extractDuration("60 secs"), 60);
      assert.equal(extractDuration("1 minute"), 60);
      assert.equal(extractDuration("no duration mentioned"), null);
      // Ensure FPS is not treated as seconds duration
      assert.equal(extractDuration("30 FPS"), null);
      assert.equal(extractDuration("30-second video at 30 FPS"), 30);
    });

    it("should extract aspect ratios correctly including resolutions", () => {
      assert.equal(extractAspectRatio("in 9:16 format"), "9:16");
      assert.equal(extractAspectRatio("create a vertical reel"), "9:16");
      assert.equal(extractAspectRatio("portrait orientation video"), "9:16");
      assert.equal(extractAspectRatio("1080 × 1920 vertical"), "9:16");
      assert.equal(extractAspectRatio("1080x1920"), "9:16");
      assert.equal(extractAspectRatio("16:9 widescreen"), "16:9");
      assert.equal(extractAspectRatio("1920x1080 landscape"), "16:9");
      assert.equal(extractAspectRatio("YouTube video in landscape"), "16:9");
      assert.equal(extractAspectRatio("square post for Instagram"), "1:1");
      assert.equal(extractAspectRatio("1080x1080"), "1:1");
      assert.equal(extractAspectRatio("social portrait 4:5"), "4:5");
      assert.equal(extractAspectRatio("no ratio specified"), null);
      // Ensure portrait subject (e.g. founder portrait, person portrait) does NOT match 9:16 aspect ratio
      assert.equal(extractAspectRatio("real founder portrait, networking infrastructure"), null);
      assert.equal(extractAspectRatio("a painted portrait of the author"), null);
    });

    it("should extract styles correctly", () => {
      assert.equal(extractStyle("cinematic look"), "cinematic");
      assert.equal(extractStyle("aerial nature footage"), "nature");
      assert.equal(extractStyle("futuristic tech style"), "tech");
      assert.equal(extractStyle("modern documentary"), "documentary");
      assert.equal(extractStyle("social and vibrant"), "social");
      assert.equal(extractStyle("clean minimalist look"), "minimalist");
      assert.equal(extractStyle("no style specified"), null);
    });
  });

  describe("P0 Bug Regression: New Video Creation & Empty Timeline Routing", () => {
    it("should classify the reproduction prompt as unsupported_creation", () => {
      const prompt =
        "Create a brand-new 30-second promotional video about modern technology, with relevant stock footage, neural voiceover, synchronized captions, background music, and automatic timeline assembly.";
      const res = classifyUserIntent(prompt, { visualClips: [], duration: 0 });
      assert.equal(res.type, "unsupported_creation");
      assert.ok(res.message);
      assert.equal(res.params?.prompt, prompt);
    });

    it("should classify common video creation prompts as unsupported_creation", () => {
      const creationPrompts = [
        "create a video from scratch",
        "generate a promotional video",
        "make a video with narration and stock footage",
      ];
      for (const p of creationPrompts) {
        const res = classifyUserIntent(p, { visualClips: [] });
        assert.equal(res.type, "unsupported_creation", `Failed on prompt: ${p}`);
      }
    });

    it("should route creation requests on an empty timeline to unsupported_creation even with project indicators", () => {
      const res = classifyUserIntent("create a video on this timeline", {
        visualClips: [],
        visualsCount: 0,
        duration: 0,
      });
      assert.equal(res.type, "unsupported_creation");
    });

    it("should keep timeline editing behavior unchanged on populated timeline", () => {
      const res = classifyUserIntent("Trim first clip to 5s", {
        visualClips: [{ id: "c1", duration: 10 }],
        visualsCount: 1,
        duration: 10,
      });
      assert.equal(res.type, "editing");
    });
  });
});

