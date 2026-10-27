import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { synthesizeSpeech, float32ToWavBuffer } from "../services/ai/ttsService.js";
import { mirroredModelFileUrls } from "../../src/lib/modelSources.js";

describe("Kokoro TTS Speech Synthesis Engine", () => {
  it("converts Float32Array to valid PCM WAV RIFF buffer", () => {
    const sampleRate = 24000;
    const sampleCount = 24000; // 1 second of audio
    const samples = new Float32Array(sampleCount);
    // Generate simple sine wave
    for (let i = 0; i < sampleCount; i++) {
      samples[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate);
    }

    const buffer = float32ToWavBuffer(samples, sampleRate);
    assert.ok(Buffer.isBuffer(buffer), "Result must be a Node.js Buffer");
    assert.equal(buffer.length, 44 + sampleCount * 2, "Buffer length must equal 44-byte header + 2 bytes per sample");

    // Check RIFF header
    assert.equal(buffer.slice(0, 4).toString("ascii"), "RIFF");
    assert.equal(buffer.slice(8, 12).toString("ascii"), "WAVE");
    assert.equal(buffer.slice(12, 16).toString("ascii"), "fmt ");
    assert.equal(buffer.readUInt16LE(20), 1, "Format must be 1 (PCM)");
    assert.equal(buffer.readUInt16LE(22), 1, "Channels must be 1 (mono)");
    assert.equal(buffer.readUInt32LE(24), sampleRate, "Sample rate must match");
    assert.equal(buffer.readUInt16LE(34), 16, "Bits per sample must be 16");
    assert.equal(buffer.slice(36, 40).toString("ascii"), "data");
    assert.equal(buffer.readUInt32LE(40), sampleCount * 2, "Data chunk size must match");
  });

  it("validates input parameters and rejects empty text", async () => {
    await assert.rejects(
      async () => synthesizeSpeech({ text: "" }),
      (err) => {
        assert.ok(err.statusCode === 400 || err.message.includes("text"));
        return true;
      }
    );
  });

  it("resolves multi-mirror fallback URLs for Kokoro voice binary models", () => {
    const urls = mirroredModelFileUrls({
      repository: "timeline-studio-voice-models",
      revision: "main",
      path: "kokoro/voices/af_heart.bin",
    });
    assert.ok(Array.isArray(urls));
    assert.ok(urls.length >= 2, "Must configure at least two independent mirrors");
    assert.ok(urls.some((u) => u.includes("huggingface.co")), "Hugging Face mirror must be present");
    assert.ok(urls.some((u) => u.includes("modelscope.cn")), "ModelScope mirror must be present");
    assert.ok(urls.every((u) => u.endsWith("af_heart.bin")), "Target path must be preserved");
  });
});
