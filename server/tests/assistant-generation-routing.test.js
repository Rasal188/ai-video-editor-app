import test from "node:test";
import assert from "node:assert/strict";
import { classifyUserIntent } from "../../src/lib/intentClassifier.js";

const EXACT_SWISS_ALPS_PROMPT =
  "Create a 30-second cinematic travel video about the Swiss Alps for Instagram Reels and YouTube Shorts, 9:16 vertical, 1080 × 1920, 30 FPS, with six specified scenes, titles, music, and narration.";

test("Intent Routing: Exact detailed Swiss Alps prompt routes to unsupported_creation with clear guidance", () => {
  const intent = classifyUserIntent(EXACT_SWISS_ALPS_PROMPT, {
    visualClips: [],
    duration: 0,
    ratio: "16:9",
  });

  assert.equal(
    intent.type,
    "unsupported_creation",
    "Must classify creation prompts as unsupported_creation since AI Video Generator is retired"
  );
  assert.ok(
    intent.message.includes("retired") || intent.message.includes("copilot"),
    "Message must explain that generation is retired and the assistant is an editing copilot"
  );
  assert.ok(
    intent.message.includes("imported"),
    "Message must guide user to import timeline media"
  );
});

test("Intent Routing: Multi-scene briefs route to unsupported_creation and do not produce generation actions", () => {
  const detailedBrief = `Create a 30-second cinematic travel video about the Swiss Alps for Instagram Reels and YouTube Shorts, 9:16 vertical, 1080 × 1920, 30 FPS, with six specified scenes, titles, music, and narration.
Scene 1: Snow-covered alpine peaks at sunrise
Scene 2: Green mountain pastures with grazing cows
Scene 3: Historic red train crossing a stone viaduct
Scene 4: Turquoise alpine lake reflecting the Matterhorn
Scene 5: Cozy mountain village chalet with smoke from chimney
Scene 6: Golden hour panorama over the snow ridge
Music: Majestic cinematic orchestral soundtrack
Narration: Journey into the heart of the Swiss Alps where towering peaks meet timeless beauty.`;

  const intent = classifyUserIntent(detailedBrief, { visualClips: [{ id: "existing-c1" }] });

  assert.equal(intent.type, "unsupported_creation");
  assert.ok(intent.message.length > 20);
});

test("Intent Routing: Short explicit generation prompts route to unsupported_creation", () => {
  const generationPrompts = [
    "Create a 30-second cinematic travel video about Switzerland.",
    "Generate a vertical video about coffee roasting for TikTok.",
    "Make a new 15-second promotional video about our product.",
    "Produce a 60 second tech documentary about deep ocean creatures in 16:9 widescreen.",
    "Build a new 30s clean calm clip about productivity.",
  ];

  for (const prompt of generationPrompts) {
    const intent = classifyUserIntent(prompt, { visualClips: [{ id: "c1" }] });
    assert.equal(
      intent.type,
      "unsupported_creation",
      `Expected "${prompt}" to be classified as unsupported_creation, got "${intent.type}"`
    );
  }
});

test("Intent Routing: Editing requests route to assistant planner", () => {
  const editingPrompts = [
    "Change my current video's aspect ratio to 9:16.",
    "Remove long pauses.",
    "Add English captions to this project.",
    "Split first clip at 3 seconds",
    "Trim clip 2 to 5 seconds",
    "Set caption style to neon and place at top",
    "Add chapter marker at 10 seconds titled Intro",
    "Delete the last clip from timeline",
    "Reorder first clip to index 2",
    "Change canvas ratio to 1:1 square",
    "Set fit mode to cover",
    "Mute the background music track.",
    "Make this clip a little faster",
    "Apply a warm cinematic look",
    "Duck the music when people speak",
  ];

  for (const prompt of editingPrompts) {
    const intent = classifyUserIntent(prompt, {
      visualClips: [{ id: "c1", duration: 10 }, { id: "c2", duration: 10 }],
      musicSegments: [{ id: "m1", duration: 20 }],
    });
    assert.equal(
      intent.type,
      "editing",
      `Expected "${prompt}" to be classified as editing, got "${intent.type}"`
    );
  }
});

test("Intent Routing: Creation requests never output timeline editing actions or generator params", () => {
  const intent = classifyUserIntent(EXACT_SWISS_ALPS_PROMPT, {
    visualClips: [],
    duration: 0,
    ratio: "16:9",
  });

  assert.equal(intent.type, "unsupported_creation");
  assert.notEqual(intent.type, "editing");
  assert.notEqual(intent.type, "generation");
  assert.equal(intent.isGenerationRequest, undefined);
});

test("Project Isolation: Original project remains completely unchanged when creation request is handled", () => {
  const originalProject = {
    id: "proj-orig-1",
    name: "Original My Vacation",
    ratioId: "16:9",
    fitMode: "contain",
    duration: 45,
    visualClips: [
      { id: "c1", name: "Beach clip", duration: 20, start: 0, end: 20 },
      { id: "c2", name: "Sunset clip", duration: 25, start: 20, end: 45 },
    ],
    captionSegments: [{ id: "cap1", text: "Welcome to Hawaii", start: 1, end: 5 }],
    markers: [{ id: "m1", time: 10, title: "Highlight" }],
  };

  const originalSnapshot = JSON.parse(JSON.stringify(originalProject));

  const intent = classifyUserIntent(EXACT_SWISS_ALPS_PROMPT, originalProject);
  assert.equal(intent.type, "unsupported_creation");
  assert.deepEqual(originalProject, originalSnapshot, "Original project must be unaffected");
});

test("Regression: Common video creation phrases route to unsupported_creation", () => {
  const phrases = [
    "create a video from scratch",
    "generate a promotional video",
    "make a video with narration and stock footage",
    "build a new 30s teaser video",
    "produce a short film about nature",
  ];

  for (const phrase of phrases) {
    const intent = classifyUserIntent(phrase, { visualClips: [] });
    assert.equal(
      intent.type,
      "unsupported_creation",
      `Expected "${phrase}" to route to unsupported_creation, got "${intent.type}"`
    );
  }
});

test("Regression: Empty timeline routes creation request to unsupported_creation", () => {
  const emptyProject = {
    visualClips: [],
    visualsCount: 0,
    duration: 0,
    ratio: "16:9",
  };

  const intent = classifyUserIntent("create a video on this timeline", emptyProject);
  assert.equal(intent.type, "unsupported_creation", "Must route to unsupported_creation on empty timeline");
});

test("Regression: Populated timeline routes editing request to editing", () => {
  const populatedProject = {
    visualClips: [{ id: "c1", duration: 10 }, { id: "c2", duration: 15 }],
    visualsCount: 2,
    duration: 25,
    ratio: "16:9",
  };

  const intent = classifyUserIntent("Trim first clip to 5s", populatedProject);
  assert.equal(intent.type, "editing", "Must route editing request on populated timeline to editing");
});
