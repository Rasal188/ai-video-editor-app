import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { synthesizeSpeech } from "../services/ai/ttsService.js";

const isExplicitlyRequested = process.env.RUN_LIVE_TTS_TESTS === "1";

describe("Kokoro Live Neural Inference (Dedicated Integration Suite)", { skip: !isExplicitlyRequested }, () => {
  it("synthesizes genuine spoken audio with Kokoro ONNX model weights and valid WAV headers", async () => {
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
  });

  it("synthesizes scene-by-scene audio via live Kokoro service and returns exact scene timings", async () => {
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
  });
});
