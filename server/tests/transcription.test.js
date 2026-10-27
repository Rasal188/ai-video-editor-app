import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { writeFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  transcribeMedia,
  extractAudioFromMedia,
  normalizeTranscriptOutput,
  resetHeadlessTranscriber,
  SUPPORTED_MEDIA_EXTENSIONS,
} from "../../src/lib/headlessTranscription.js";

describe("Headless Transcription Service", () => {
  const rootDir = process.cwd();
  let realVideoPath = path.join(rootDir, "test-artifacts", "video-3-https.mp4");
  const realAudioPath = path.join(rootDir, "public", "assets", "voice-samples", "af_heart.mp3");
  const iconImagePath = path.join(rootDir, "public", "icons", "timeline-studio-icon-192.png");
  let syntheticVideoDir = null;

  before(async () => {
    if (!fs.existsSync(realVideoPath)) {
      syntheticVideoDir = await mkdtemp(path.join(tmpdir(), "transcribe-fixture-"));
      const synPath = path.join(syntheticVideoDir, "synthetic-video.mp4");
      try {
        execFileSync("ffmpeg", [
          "-y",
          "-f", "lavfi", "-i", "testsrc=duration=31:size=64x64:rate=10",
          "-f", "lavfi", "-i", "sine=frequency=440:duration=31",
          "-c:v", "libx264", "-preset", "ultrafast",
          "-c:a", "aac",
          "-shortest",
          synPath,
        ], { stdio: "ignore" });
        realVideoPath = synPath;
      } catch (err) {
        console.warn("Could not generate synthetic video with ffmpeg:", err.message);
      }
    }
  });

  after(async () => {
    if (syntheticVideoDir) {
      await rm(syntheticVideoDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  beforeEach(() => {
    resetHeadlessTranscriber();
  });

  describe("Media Validation & Supported Formats", () => {
    it("should export a frozen set of supported media extensions", () => {
      assert.ok(SUPPORTED_MEDIA_EXTENSIONS.has(".mp4"));
      assert.ok(SUPPORTED_MEDIA_EXTENSIONS.has(".webm"));
      assert.ok(SUPPORTED_MEDIA_EXTENSIONS.has(".mp3"));
      assert.ok(SUPPORTED_MEDIA_EXTENSIONS.has(".wav"));
      assert.equal(SUPPORTED_MEDIA_EXTENSIONS.has(".png"), false);
      assert.equal(SUPPORTED_MEDIA_EXTENSIONS.has(".txt"), false);
    });

    it("should reject empty or non-string file paths with INVALID_ARGUMENT", async () => {
      await assert.rejects(
        () => transcribeMedia(""),
        (err) => err.code === "INVALID_ARGUMENT" && err.message.includes("non-empty string"),
      );
      await assert.rejects(
        () => transcribeMedia(null),
        (err) => err.code === "INVALID_ARGUMENT",
      );
    });

    it("should reject non-existent files with FILE_NOT_FOUND", async () => {
      const nonExistent = path.join(rootDir, "test-artifacts", "does-not-exist.mp4");
      await assert.rejects(
        () => transcribeMedia(nonExistent),
        (err) => err.code === "FILE_NOT_FOUND",
      );
    });

    it("should reject unsupported file extensions with UNSUPPORTED_MEDIA", async () => {
      const textFile = path.join(rootDir, "package.json");
      await assert.rejects(
        () => transcribeMedia(textFile),
        (err) => err.code === "UNSUPPORTED_MEDIA",
      );
    });
  });

  describe("Audio Extraction with FFmpeg", () => {
    it("should successfully extract 16kHz mono Float32 audio from a video file", async () => {
      const { audio, duration } = await extractAudioFromMedia(realVideoPath);

      assert.ok(audio instanceof Float32Array, "Audio must be a Float32Array");
      assert.ok(audio.length > 0, "Audio sample count must be greater than zero");
      assert.ok(duration > 30, `Expected duration > 30s, got ${duration}`);
      // 16000 samples per second
      assert.equal(Math.round(duration * 16000), audio.length);
    });

    it("should successfully extract audio from an mp3 audio file", async () => {
      const { audio, duration } = await extractAudioFromMedia(realAudioPath);

      assert.ok(audio instanceof Float32Array);
      assert.ok(audio.length > 0);
      assert.ok(duration > 0);
    });

    it("should reject media with no audio stream with NO_AUDIO_STREAM", async () => {
      // An image has no audio track
      await assert.rejects(
        () => extractAudioFromMedia(iconImagePath),
        (err) => err.code === "NO_AUDIO_STREAM",
      );
    });

    it("should clean up temporary audio files even when extraction is cancelled", async () => {
      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        () => extractAudioFromMedia(realVideoPath, { signal: controller.signal }),
        (err) => err.code === "TRANSCRIPTION_CANCELED",
      );
    });

    it("should reject corrupt or non-media files with CORRUPT_MEDIA", async () => {
      const corruptFile = path.join(tmpdir(), `corrupt-${randomUUID()}.mp4`);
      await writeFile(corruptFile, Buffer.from("this is definitely not a valid mp4 media file"));

      try {
        await assert.rejects(
          () => extractAudioFromMedia(corruptFile),
          (err) => err.code === "CORRUPT_MEDIA" || err.code === "NO_AUDIO_STREAM",
        );
      } finally {
        await rm(corruptFile, { force: true });
      }
    });
  });

  describe("Transcript Normalization & Caption Segmentation", () => {
    it("should normalize valid word chunks into structured words and grouped caption segments", () => {
      const rawOutput = {
        text: "What does HTTPS protect? Data in transit.",
        chunks: [
          { text: "What", timestamp: [0.1, 0.4] },
          { text: " does", timestamp: [0.4, 0.7] },
          { text: " HTTPS", timestamp: [0.7, 1.2] },
          { text: " protect?", timestamp: [1.2, 1.8] },
          { text: " Data", timestamp: [2.5, 2.9] },
          { text: " in", timestamp: [2.9, 3.1] },
          { text: " transit.", timestamp: [3.1, 3.7] },
        ],
      };

      const result = normalizeTranscriptOutput(rawOutput, 5.0, {
        timelineOffset: 0,
        grouping: "phrases",
        language: "en",
      });

      assert.equal(result.ok, true);
      assert.equal(result.language, "en");
      assert.equal(result.duration, 5.0);
      assert.equal(result.words.length, 7);
      assert.equal(result.words[0].text, "What");
      assert.equal(result.words[0].start, 0.1);
      assert.equal(result.words[0].end, 0.4);

      // Verify caption segments were created
      assert.ok(result.segments.length >= 2, "Expected punctuation to break into at least 2 segments");
      assert.match(result.segments[0].text, /What does HTTPS protect\?/);
      assert.equal(result.segments[0].source, "asr");
      assert.equal(result.segments[0].timingSource, "asr-word");
      assert.match(result.segments[1].text, /Data in transit\./);
    });

    it("should respect timelineOffset when generating words and segments", () => {
      const rawOutput = {
        text: "Hello world",
        chunks: [
          { text: "Hello", timestamp: [0.2, 0.6] },
          { text: " world", timestamp: [0.6, 1.0] },
        ],
      };

      const result = normalizeTranscriptOutput(rawOutput, 2.0, {
        timelineOffset: 10.5,
        grouping: "phrases",
      });

      assert.equal(result.words[0].start, 10.7);
      assert.equal(result.words[0].end, 11.1);
      assert.equal(result.segments[0].start, 10.7);
      assert.equal(result.segments[0].end, 11.5);
    });

    it("should reject non-finite or negative timestamps with INVALID_TIMESTAMPS", () => {
      const badStart = {
        chunks: [{ text: "Hello", timestamp: [NaN, 1.0] }],
      };
      assert.throws(
        () => normalizeTranscriptOutput(badStart, 5.0),
        (err) => err.code === "INVALID_TIMESTAMPS",
      );

      const badNegative = {
        chunks: [{ text: "Hello", timestamp: [-0.5, 1.0] }],
      };
      assert.throws(
        () => normalizeTranscriptOutput(badNegative, 5.0),
        (err) => err.code === "INVALID_TIMESTAMPS",
      );
    });

    it("should reject inverted timestamps (end < start) with INVALID_TIMESTAMPS", () => {
      const inverted = {
        chunks: [{ text: "Hello", timestamp: [2.5, 1.0] }],
      };
      assert.throws(
        () => normalizeTranscriptOutput(inverted, 5.0),
        (err) => err.code === "INVALID_TIMESTAMPS",
      );
    });

    it("should handle empty chunks gracefully without throwing", () => {
      const empty = { text: "", chunks: [] };
      const result = normalizeTranscriptOutput(empty, 5.0);

      assert.equal(result.ok, true);
      assert.equal(result.words.length, 0);
      assert.equal(result.segments.length, 0);
      assert.equal(result.text, "");
    });
  });

  describe("Mocked Headless Inference & Pipeline Factory Injection", () => {
    it("should run full transcription with injected mock pipeline factory", async () => {
      const progressPhases = [];
      const mockTranscriber = async (audio, opts) => {
        assert.ok(audio instanceof Float32Array);
        assert.equal(opts.return_timestamps, "word");
        return {
          text: "Mocked transcription result",
          chunks: [
            { text: "Mocked", timestamp: [0.2, 0.8] },
            { text: " transcription", timestamp: [0.8, 1.5] },
            { text: " result.", timestamp: [1.5, 2.2] },
          ],
        };
      };

      const result = await transcribeMedia(realAudioPath, {
        language: "en",
        pipelineFactory: async () => mockTranscriber,
        onProgress: (p) => progressPhases.push(p.phase),
      });

      assert.equal(result.ok, true);
      assert.equal(result.language, "en");
      assert.equal(result.words.length, 3);
      assert.equal(result.segments.length, 1);
      assert.equal(result.segments[0].text, "Mocked transcription result.");
      assert.ok(progressPhases.includes("extracting_audio"));
      assert.ok(progressPhases.includes("transcribing"));
      assert.ok(progressPhases.includes("complete"));
    });

    it("should propagate model loading errors with MODEL_LOAD_FAILED", async () => {
      await assert.rejects(
        () => transcribeMedia(realAudioPath, {
          pipelineFactory: async () => {
            throw new Error("Disk quota exceeded while downloading weights");
          },
        }),
        (err) => err.code === "MODEL_LOAD_FAILED" || err.message.includes("Disk quota"),
      );
    });

    it("should propagate inference execution failures with INFERENCE_FAILED", async () => {
      await assert.rejects(
        () => transcribeMedia(realAudioPath, {
          pipelineFactory: async () => {
            return async () => {
              throw new Error("CUDA/WASM out of memory in ONNX runtime");
            };
          },
        }),
        (err) => err.code === "INFERENCE_FAILED" && err.message.includes("out of memory"),
      );
    });

    it("should handle cancellation during inference with TRANSCRIPTION_CANCELED", async () => {
      const controller = new AbortController();

      await assert.rejects(
        () => transcribeMedia(realAudioPath, {
          pipelineFactory: async () => {
            return async () => {
              controller.abort();
              const err = new Error("Inference aborted");
              err.name = "AbortError";
              throw err;
            };
          },
          signal: controller.signal,
        }),
        (err) => err.code === "TRANSCRIPTION_CANCELED",
      );
    });

    it("should reject early if signal is already aborted before starting", async () => {
      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        () => transcribeMedia(realAudioPath, {
          signal: controller.signal,
          pipelineFactory: async () => {
            assert.fail("Pipeline factory should not be called when aborted");
          },
        }),
        (err) => err.code === "TRANSCRIPTION_CANCELED",
      );
    });
  });
});
