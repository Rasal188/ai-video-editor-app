import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { buildFfmpegRenderPlan } from "../../src/lib/projectRenderPlan.js";

const executeFile = promisify(execFile);

describe("Headless Render Plan & Embedded Audio", () => {
  const dummyFiles = new Map([
    ["media/visuals/clip1.mp4", "C:/temp/clip1.mp4"],
    ["media/visuals/clip2.mp4", "C:/temp/clip2.mp4"],
    ["media/audio/voice.mp3", "C:/temp/voice.mp3"],
    ["media/music/track.mp3", "C:/temp/track.mp3"],
  ]);

  const baseMedia = {
    visuals: [
      { id: "vis-1", path: "media/visuals/clip1.mp4" },
      { id: "vis-2", path: "media/visuals/clip2.mp4" },
    ],
    audioSegments: [
      { id: "audio-1", path: "media/audio/voice.mp3" },
    ],
    music: { id: "music-1", path: "media/music/track.mp3" },
  };

  it("should preserve embedded video audio, map AAC, and not emit -an", () => {
    const project = {
      ratioId: "16:9",
      visualSegments: [
        {
          id: "vis-1",
          type: "video",
          duration: 3,
          sourceStart: 0,
          playbackRate: 1,
          volume: 0.8,
        },
      ],
    };

    const plan = buildFfmpegRenderPlan({
      project,
      media: baseMedia,
      extractedFiles: dummyFiles,
    });

    assert.equal(plan.hasAudio, true);
    assert.equal(plan.args.includes("-an"), false);
    assert.equal(plan.args.includes("-map"), true);
    const mapIndices = plan.args.flatMap((arg, i) => arg === "-map" ? [i] : []);
    const mappedLabels = mapIndices.map((i) => plan.args[i + 1]);
    assert.deepEqual(mappedLabels, ["[vout]", "[aout]"]);

    const aacIdx = plan.args.indexOf("-c:a");
    assert.notEqual(aacIdx, -1);
    assert.equal(plan.args[aacIdx + 1], "aac");

    const fcIdx = plan.args.indexOf("-filter_complex");
    const filterGraph = plan.args[fcIdx + 1];
    assert.match(filterGraph, /\[0:a\]atrim=start=0:duration=3/);
    assert.match(filterGraph, /volume=0.8/);
    assert.match(filterGraph, /concat=n=1:v=1:a=1\[vout\]\[vaout\]/);
  });

  it("should respect sourceStart trim points and clip duration", () => {
    const project = {
      ratioId: "16:9",
      visualSegments: [
        {
          id: "vis-1",
          type: "video",
          duration: 2.5,
          sourceStart: 4.25,
          playbackRate: 1,
          volume: 1,
        },
      ],
    };

    const plan = buildFfmpegRenderPlan({
      project,
      media: baseMedia,
      extractedFiles: dummyFiles,
    });

    const fcIdx = plan.args.indexOf("-filter_complex");
    const filterGraph = plan.args[fcIdx + 1];
    assert.match(filterGraph, /atrim=start=4.25:duration=2.5/);
    assert.match(filterGraph, /atrim=duration=2.5\[a0\]/);
  });

  it("should respect playbackRate tempo adjustments", () => {
    const project = {
      ratioId: "16:9",
      visualSegments: [
        {
          id: "vis-1",
          type: "video",
          duration: 2,
          sourceStart: 0,
          playbackRate: 2,
          volume: 1,
        },
      ],
    };

    const plan = buildFfmpegRenderPlan({
      project,
      media: baseMedia,
      extractedFiles: dummyFiles,
    });

    const fcIdx = plan.args.indexOf("-filter_complex");
    const filterGraph = plan.args[fcIdx + 1];
    // sourceDuration = 2 * 2 = 4
    assert.match(filterGraph, /atrim=start=0:duration=4/);
    assert.match(filterGraph, /atempo=2/);
  });

  it("should respect custom volume levels", () => {
    const project = {
      ratioId: "16:9",
      visualSegments: [
        {
          id: "vis-1",
          type: "video",
          duration: 3,
          sourceStart: 0,
          playbackRate: 1,
          volume: 0.42,
        },
      ],
    };

    const plan = buildFfmpegRenderPlan({
      project,
      media: baseMedia,
      extractedFiles: dummyFiles,
    });

    const fcIdx = plan.args.indexOf("-filter_complex");
    const filterGraph = plan.args[fcIdx + 1];
    assert.match(filterGraph, /volume=0.42/);
  });

  it("should emit -an when the project has zero audio sources", () => {
    const project = {
      ratioId: "16:9",
      visualSegments: [
        {
          id: "vis-1",
          type: "image",
          duration: 3,
        },
      ],
    };

    const plan = buildFfmpegRenderPlan({
      project,
      media: baseMedia,
      extractedFiles: dummyFiles,
    });

    assert.equal(plan.hasAudio, false);
    assert.equal(plan.args.includes("-an"), true);
    assert.equal(plan.args.includes("-c:a"), false);
    const fcIdx = plan.args.indexOf("-filter_complex");
    const filterGraph = plan.args[fcIdx + 1];
    assert.match(filterGraph, /concat=n=1:v=1:a=0\[vout\]/);
  });

  it("should coexist and mix embedded video audio with voiceover and music", () => {
    const project = {
      ratioId: "16:9",
      visualSegments: [
        {
          id: "vis-1",
          type: "video",
          duration: 5,
          sourceStart: 0,
          playbackRate: 1,
          volume: 0.9,
        },
      ],
      audioSegments: [
        {
          id: "audio-1",
          start: 0.5,
          duration: 2,
          volume: 1,
        },
      ],
      musicSegments: [
        {
          id: "music-1",
          start: 0,
          duration: 5,
          volume: 0.3,
        },
      ],
    };

    const plan = buildFfmpegRenderPlan({
      project,
      media: baseMedia,
      extractedFiles: dummyFiles,
    });

    assert.equal(plan.hasAudio, true);
    assert.equal(plan.args.includes("-an"), false);

    const fcIdx = plan.args.indexOf("-filter_complex");
    const filterGraph = plan.args[fcIdx + 1];
    assert.match(filterGraph, /concat=n=1:v=1:a=1\[vout\]\[vaout\]/);
    assert.match(filterGraph, /\[vaout\]\[voice0\]\[music0\]amix=inputs=3/);
  });

  it("should execute end-to-end CLI render on a video with embedded audio and produce valid MP4 with AAC", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "render-audio-test-"));
    const sourceVideoPath = join(tempDir, "source.mp4");
    const projectPath = join(tempDir, "test.timeline");
    const outputPath = join(tempDir, "rendered.mp4");
    const planPath = join(tempDir, "render-plan.json");

    try {
      // 1. Generate synthetic source video with 3s H.264 video + 3s AAC stereo audio
      await executeFile("ffmpeg", [
        "-hide_banner", "-y",
        "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=30",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=3:sample_rate=44100",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        sourceVideoPath,
      ]);

      const sourceBytes = await (await import("node:fs/promises")).readFile(sourceVideoPath);

      // 2. Build .timeline archive
      const archiveFiles = {
        "project.json": strToU8(JSON.stringify({
          format: "timeline-studio-archive",
          version: 1,
          project: {
            ratioId: "16:9",
            visualSegments: [
              {
                id: "vis-cut-1",
                type: "video",
                duration: 1.5,
                sourceStart: 0,
                playbackRate: 1,
                volume: 0.8,
              },
              {
                id: "vis-cut-2",
                type: "video",
                duration: 1.0,
                sourceStart: 1.8,
                playbackRate: 1,
                volume: 0.8,
              },
            ],
          },
          media: {
            visuals: [
              { id: "vis-cut-1", path: "media/visuals/source.mp4" },
              { id: "vis-cut-2", path: "media/visuals/source.mp4" },
            ],
          },
        })),
        "media/visuals/source.mp4": new Uint8Array(sourceBytes),
      };

      await writeFile(projectPath, zipSync(archiveFiles, { level: 6 }));

      // 3. Write render plan
      await writeFile(planPath, JSON.stringify({
        schemaVersion: 1,
        project: projectPath,
        output: { video: outputPath },
        render: { preset: "ultrafast" },
      }));

      // 4. Run CLI render
      const cliScript = resolve(process.cwd(), "scripts", "timeline-command.mjs");
      const { stdout } = await executeFile(process.execPath, [cliScript, "project.render", planPath]);
      const res = JSON.parse(stdout);

      assert.equal(res.ok, true);
      assert.equal(res.verification.hasAudio, true);

      // 5. Run FFprobe on rendered output
      const probeRes = await executeFile("ffprobe", [
        "-v", "error",
        "-show_streams",
        "-show_format",
        "-of", "json",
        outputPath,
      ]);
      const meta = JSON.parse(probeRes.stdout);

      const videoStream = meta.streams.find((s) => s.codec_type === "video");
      const audioStream = meta.streams.find((s) => s.codec_type === "audio");

      assert.ok(videoStream, "Rendered MP4 must contain video stream");
      assert.equal(videoStream.codec_name, "h264");

      assert.ok(audioStream, "Rendered MP4 must contain audio stream");
      assert.equal(audioStream.codec_name, "aac");
      assert.equal(audioStream.channels, 2);
      assert.equal(audioStream.sample_rate, "44100");

      const duration = Number(meta.format.duration);
      // Total duration = 1.5 + 1.0 = 2.5s
      assert.ok(Math.abs(duration - 2.5) < 0.15, `Duration should be ~2.5s, got ${duration}`);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
