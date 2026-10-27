import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import {
  parseTranscribeArgs,
  formatHumanTranscriptSummary,
  transcribeMediaCli,
} from "../../src/lib/headlessTranscription.js";

const executeFile = promisify(execFile);
const cliScript = path.resolve(process.cwd(), "scripts/timeline-command.mjs");
let validVideoPath = [
  path.resolve(process.cwd(), "test-artifacts/video-3-https.mp4"),
  path.resolve(process.cwd(), "public/assets/voice-samples/af_heart.mp3"),
].find((p) => fs.existsSync(p));
let syntheticMediaDir = null;

before(async () => {
  if (!validVideoPath || !fs.existsSync(validVideoPath)) {
    syntheticMediaDir = await mkdtemp(path.join(tmpdir(), "transcribe-cli-fixture-"));
    const synPath = path.join(syntheticMediaDir, "sample.mp4");
    try {
      execFileSync("ffmpeg", [
        "-y",
        "-f", "lavfi", "-i", "testsrc=duration=2:size=64x64:rate=10",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
        "-c:v", "libx264", "-preset", "ultrafast",
        "-c:a", "aac",
        "-shortest",
        synPath,
      ], { stdio: "ignore" });
      validVideoPath = synPath;
    } catch (err) {
      console.warn("Could not generate synthetic media fixture:", err.message);
    }
  }
});

after(async () => {
  if (syntheticMediaDir) {
    await rm(syntheticMediaDir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("Headless Transcription CLI Integration", () => {
  describe("parseTranscribeArgs", () => {
    it("should parse media path and default options", () => {
      const { mediaFile, options } = parseTranscribeArgs(["clip.mp4"]);
      assert.equal(mediaFile, "clip.mp4");
      assert.equal(options.output, null);
      assert.equal(options.overwrite, false);
      assert.equal(options.language, null);
      assert.equal(options.modelId, null);
      assert.equal(options.timelineOffset, 0);
      assert.equal(options.grouping, "phrases");
      assert.equal(options.format, "json");
      assert.equal(options.quiet, false);
      assert.equal(options.verbose, false);
    });

    it("should parse all flags correctly", () => {
      const args = [
        "-o", "out.json",
        "-f",
        "-l", "en",
        "-m", "whisper-tiny",
        "--timeline-offset", "2.5",
        "--grouping", "word",
        "--summary",
        "-q",
        "-v",
        "video.mov",
      ];
      const { mediaFile, options } = parseTranscribeArgs(args);
      assert.equal(mediaFile, "video.mov");
      assert.equal(options.output, "out.json");
      assert.equal(options.overwrite, true);
      assert.equal(options.language, "en");
      assert.equal(options.modelId, "whisper-tiny");
      assert.equal(options.timelineOffset, 2.5);
      assert.equal(options.grouping, "words");
      assert.equal(options.format, "summary");
      assert.equal(options.quiet, true);
      assert.equal(options.verbose, true);
    });

    it("should map alias flags (--output, --overwrite, --language, --model, --human, --json)", () => {
      const { mediaFile, options } = parseTranscribeArgs([
        "speech.mp3",
        "--output", "result.json",
        "--overwrite",
        "--language", "es",
        "--model", "custom-model",
        "--grouping", "smart",
        "--human",
        "--json",
      ]);
      assert.equal(mediaFile, "speech.mp3");
      assert.equal(options.output, "result.json");
      assert.equal(options.overwrite, true);
      assert.equal(options.language, "es");
      assert.equal(options.modelId, "custom-model");
      assert.equal(options.grouping, "phrases");
      assert.equal(options.format, "json");
    });

    it("should throw INVALID_ARGUMENT when media file is missing", () => {
      assert.throws(
        () => parseTranscribeArgs([]),
        (err) => err.code === "INVALID_ARGUMENT" && err.exitCode === 2
      );
    });

    it("should throw INVALID_ARGUMENT when unknown flag is encountered", () => {
      assert.throws(
        () => parseTranscribeArgs(["audio.wav", "--unknown-flag"]),
        (err) => err.code === "INVALID_ARGUMENT" && err.message.includes("Unknown option")
      );
    });

    it("should throw INVALID_ARGUMENT when option value is missing", () => {
      assert.throws(
        () => parseTranscribeArgs(["audio.wav", "--out"]),
        (err) => err.code === "INVALID_ARGUMENT" && err.message.includes("requires a file path")
      );
      assert.throws(
        () => parseTranscribeArgs(["audio.wav", "--language"]),
        (err) => err.code === "INVALID_ARGUMENT" && err.message.includes("requires a language code")
      );
      assert.throws(
        () => parseTranscribeArgs(["audio.wav", "--model"]),
        (err) => err.code === "INVALID_ARGUMENT" && err.message.includes("requires a model ID")
      );
    });

    it("should throw INVALID_ARGUMENT when timeline offset is non-numeric", () => {
      assert.throws(
        () => parseTranscribeArgs(["audio.wav", "--timeline-offset", "abc"]),
        (err) => err.code === "INVALID_ARGUMENT" && err.message.includes("must be a valid number")
      );
    });

    it("should throw INVALID_ARGUMENT on extra positional arguments", () => {
      assert.throws(
        () => parseTranscribeArgs(["audio1.wav", "audio2.wav"]),
        (err) => err.code === "INVALID_ARGUMENT" && err.message.includes("Unexpected extra positional")
      );
    });
  });

  describe("formatHumanTranscriptSummary", () => {
    it("should format valid transcript payload into readable summary", () => {
      const payload = {
        media: "C:/videos/intro.mp4",
        duration: 12.34,
        language: "en",
        model: "whisper-test",
        words: [{ text: "Hello" }, { text: "world" }],
        segments: [
          { start: 0.5, end: 3.2, text: "Hello world" },
          { start: 3.5, end: 6.8, text: "Welcome to video editor" },
        ],
        text: "Hello world\nWelcome to video editor",
      };

      const summary = formatHumanTranscriptSummary(payload);
      assert.ok(summary.includes("=== Media Transcription Summary ==="));
      assert.ok(summary.includes("Media: C:/videos/intro.mp4"));
      assert.ok(summary.includes("Duration: 12.34s"));
      assert.ok(summary.includes("Language: en"));
      assert.ok(summary.includes("Model: whisper-test"));
      assert.ok(summary.includes("Words: 2"));
      assert.ok(summary.includes("Caption Segments: 2"));
      assert.ok(summary.includes("[00:00.50 -> 00:03.20] Hello world"));
      assert.ok(summary.includes("[00:03.50 -> 00:06.80] Welcome to video editor"));
    });

    it("should handle empty speech results gracefully", () => {
      const payload = {
        media: "silent.mp4",
        duration: 5.0,
        language: "unknown",
        model: "default",
        words: [],
        segments: [],
        text: "",
      };

      const summary = formatHumanTranscriptSummary(payload);
      assert.ok(summary.includes("(no speech detected)"));
      assert.ok(summary.includes("(no caption segments generated)"));
    });
  });

  describe("transcribeMediaCli (Mocked In-Process Execution)", () => {
    const mockFactory = () => {
      return async () => ({
        text: "Question: What is HTTPS?",
        chunks: [
          { text: " Question:", timestamp: [0.5, 1.2] },
          { text: " What", timestamp: [1.3, 1.6] },
          { text: " is", timestamp: [1.7, 1.9] },
          { text: " HTTPS?", timestamp: [2.0, 2.8] },
        ],
        language: "en",
      });
    };

    it("should execute transcription and output JSON to stdout by default", async () => {
      let stdoutData = "";
      const res = await transcribeMediaCli([validVideoPath, "-q"], {
        pipelineFactory: mockFactory,
        stdout: (chunk) => { stdoutData += chunk; },
      });

      assert.equal(res.ok, true);
      assert.equal(res.language, "en");
      assert.equal(res.words.length, 4);
      assert.equal(res.summary.wordCount, 4);
      assert.equal(res.summary.segmentCount, res.segments.length);

      const parsedStdout = JSON.parse(stdoutData);
      assert.equal(parsedStdout.ok, true);
      assert.equal(parsedStdout.words.length, 4);
    });

    it("should write output to file when --out is specified", async () => {
      const tempDir = await mkdtemp(path.join(tmpdir(), "transcribe-cli-test-"));
      const outFile = path.join(tempDir, "output.json");

      try {
        const res = await transcribeMediaCli([validVideoPath, "--out", outFile, "-q"], {
          pipelineFactory: mockFactory,
          stdout: () => {},
        });

        assert.equal(res.ok, true);
        assert.equal(res.artifacts.output, outFile);
        assert.ok(fs.existsSync(outFile));

        const savedContent = JSON.parse(await readFile(outFile, "utf8"));
        assert.equal(savedContent.ok, true);
        assert.equal(savedContent.words.length, 4);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("should prevent overwriting existing output file unless --force is used", async () => {
      const tempDir = await mkdtemp(path.join(tmpdir(), "transcribe-cli-test-"));
      const outFile = path.join(tempDir, "output.json");

      try {
        await writeFile(outFile, JSON.stringify({ existing: true }));

        // Attempt without --force
        await assert.rejects(
          async () => {
            await transcribeMediaCli([validVideoPath, "--out", outFile, "-q"], {
              pipelineFactory: mockFactory,
              stdout: () => {},
            });
          },
          (err) => err.code === "OUTPUT_EXISTS" && err.exitCode === 1
        );

        // Attempt with --force
        const res = await transcribeMediaCli([validVideoPath, "--out", outFile, "--force", "-q"], {
          pipelineFactory: mockFactory,
          stdout: () => {},
        });
        assert.equal(res.ok, true);
        const updated = JSON.parse(await readFile(outFile, "utf8"));
        assert.equal(updated.ok, true);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("should output human summary when --summary is passed", async () => {
      let stdoutData = "";
      const res = await transcribeMediaCli([validVideoPath, "--summary", "-q"], {
        pipelineFactory: mockFactory,
        stdout: (chunk) => { stdoutData += chunk; },
      });

      assert.equal(res.ok, true);
      assert.ok(stdoutData.includes("=== Media Transcription Summary ==="));
      assert.ok(stdoutData.includes("Words: 4"));
    });

    it("should emit progress to stderr when not quiet", async () => {
      let stderrData = "";
      await transcribeMediaCli([validVideoPath], {
        pipelineFactory: mockFactory,
        stdout: () => {},
        stderr: (chunk) => { stderrData += chunk; },
      });

      assert.ok(stderrData.includes("[transcribe] extracting_audio"));
      assert.ok(stderrData.includes("[transcribe] complete"));
    });

    it("should support cancellation via AbortSignal", async () => {
      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        async () => {
          await transcribeMediaCli([validVideoPath, "-q"], {
            signal: controller.signal,
            pipelineFactory: mockFactory,
            stdout: () => {},
          });
        },
        (err) => err.code === "TRANSCRIPTION_CANCELED"
      );
    });
  });

  describe("Child Process CLI Executions (timeline-command.mjs)", () => {
    it("should exit with code 2 on invalid command or usage", async () => {
      try {
        await executeFile(process.execPath, [cliScript, "invalid.command"]);
        assert.fail("Should have failed with exit code 2");
      } catch (err) {
        assert.equal(err.code, 2);
        const out = JSON.parse(err.stdout);
        assert.equal(out.ok, false);
        assert.equal(out.code, "INVALID_COMMAND");
      }
    });

    it("should exit with code 2 when media.transcribe is invoked without media file", async () => {
      try {
        await executeFile(process.execPath, [cliScript, "media.transcribe"]);
        assert.fail("Should have failed with exit code 2");
      } catch (err) {
        assert.equal(err.code, 2);
        const out = JSON.parse(err.stdout);
        assert.equal(out.ok, false);
        assert.equal(out.code, "INVALID_COMMAND");
      }
    });

    it("should accept 'transcribe' alias and route identically", async () => {
      try {
        await executeFile(process.execPath, [cliScript, "transcribe"]);
        assert.fail("Should have failed with exit code 2");
      } catch (err) {
        assert.equal(err.code, 2);
      }
    });

    it("should exit with code 1 and FILE_NOT_FOUND for non-existent file", async () => {
      try {
        await executeFile(process.execPath, [cliScript, "media.transcribe", "non-existent-media-file.mp4"]);
        assert.fail("Should have failed with exit code 1");
      } catch (err) {
        assert.equal(err.code, 1);
        const out = JSON.parse(err.stdout);
        assert.equal(out.ok, false);
        assert.equal(out.code, "FILE_NOT_FOUND");
      }
    });

    it("should exit with code 1 and UNSUPPORTED_MEDIA for unsupported extension", async () => {
      const tempDir = await mkdtemp(path.join(tmpdir(), "transcribe-cli-unsupported-"));
      const unsupportedFile = path.join(tempDir, "unsupported.txt");

      try {
        await writeFile(unsupportedFile, "not media");
        await executeFile(process.execPath, [cliScript, "media.transcribe", unsupportedFile]);
        assert.fail("Should have failed with exit code 1");
      } catch (err) {
        assert.equal(err.code, 1);
        const out = JSON.parse(err.stdout);
        assert.equal(out.ok, false);
        assert.equal(out.code, "UNSUPPORTED_MEDIA");
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("should exit with code 1 and NO_AUDIO_STREAM for media with no audio stream", async () => {
      const imageCandidates = [
        path.resolve(process.cwd(), "test-artifacts/test-rotate.png"),
        path.resolve(process.cwd(), "public/icons/timeline-studio-icon-192.png"),
        path.resolve(process.cwd(), "public/assets/sample-portrait.png"),
      ];
      const imagePath = imageCandidates.find((p) => fs.existsSync(p));
      const tempDir = await mkdtemp(path.join(tmpdir(), "transcribe-cli-noaudio-"));
      // Copy image to .mp4 container so extension passes validation but probe detects no audio
      const noAudioVideo = path.join(tempDir, "silent-image.mp4");

      try {
        await executeFile("ffmpeg", [
          "-y",
          "-loop", "1",
          "-i", imagePath,
          "-c:v", "libx264",
          "-t", "1",
          "-pix_fmt", "yuv420p",
          "-an",
          noAudioVideo,
        ]);

        await executeFile(process.execPath, [cliScript, "media.transcribe", noAudioVideo]);
        assert.fail("Should have failed with exit code 1");
      } catch (err) {
        assert.equal(err.code, 1);
        const out = JSON.parse(err.stdout);
        assert.equal(out.ok, false);
        assert.equal(out.code, "NO_AUDIO_STREAM");
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});
