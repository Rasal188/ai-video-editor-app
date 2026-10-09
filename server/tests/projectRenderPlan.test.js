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

describe("Headless Caption Rendering & Drawtext Filters", () => {
  const dummyFiles = new Map([
    ["media/visuals/clip1.mp4", "C:/temp/clip1.mp4"],
    ["media/audio/voice.mp3", "C:/temp/voice.mp3"],
  ]);

  const baseMedia = {
    visuals: [{ id: "vis-1", path: "media/visuals/clip1.mp4" }],
    audioSegments: [{ id: "audio-1", path: "media/audio/voice.mp3" }],
  };

  it("should keep render plan unchanged when no captions exist", () => {
    const project = {
      ratioId: "16:9",
      visualSegments: [{ id: "vis-1", type: "video", duration: 4 }],
      captionSegments: [],
    };
    const plan = buildFfmpegRenderPlan({ project, media: baseMedia, extractedFiles: dummyFiles });
    const fc = plan.args[plan.args.indexOf("-filter_complex") + 1];
    assert.equal(fc.includes("drawtext"), false);
    assert.equal(plan.args.includes("[vout]"), true);
    assert.equal(plan.args.includes("[vfinal]"), false);
  });

  it("should skip hidden captions and disabled caption tracks", () => {
    const projectHidden = {
      ratioId: "16:9",
      visualSegments: [{ id: "vis-1", type: "video", duration: 4 }],
      captionSegments: [
        { id: "c-1", text: "I am hidden", start: 0, end: 2, hidden: true },
      ],
    };
    const planHidden = buildFfmpegRenderPlan({ project: projectHidden, media: baseMedia, extractedFiles: dummyFiles });
    assert.equal(planHidden.args.join(" ").includes("drawtext"), false);

    const projectDisabled = {
      ratioId: "16:9",
      captionsEnabled: false,
      visualSegments: [{ id: "vis-1", type: "video", duration: 4 }],
      captionSegments: [
        { id: "c-1", text: "I am disabled", start: 0, end: 2 },
      ],
    };
    const planDisabled = buildFfmpegRenderPlan({ project: projectDisabled, media: baseMedia, extractedFiles: dummyFiles });
    assert.equal(planDisabled.args.join(" ").includes("drawtext"), false);

    const projectTrackHidden = {
      ratioId: "16:9",
      trackVisibility: { caption: false },
      visualSegments: [{ id: "vis-1", type: "video", duration: 4 }],
      captionSegments: [
        { id: "c-1", text: "Track hidden", start: 0, end: 2 },
      ],
    };
    const planTrackHidden = buildFfmpegRenderPlan({ project: projectTrackHidden, media: baseMedia, extractedFiles: dummyFiles });
    assert.equal(planTrackHidden.args.join(" ").includes("drawtext"), false);
  });

  it("should render a single caption with correct timing, scaling, and [vfinal] mapping", () => {
    const project = {
      ratioId: "16:9",
      visualSegments: [{ id: "vis-1", type: "video", duration: 5 }],
      captionSegments: [
        { id: "c-1", text: "Hello World", start: 1.0, end: 3.5 },
      ],
    };
    const plan = buildFfmpegRenderPlan({ project, media: baseMedia, extractedFiles: dummyFiles });
    const fc = plan.args[plan.args.indexOf("-filter_complex") + 1];

    assert.match(fc, /\[vout\]drawtext=.*text='Hello World'/);
    assert.match(fc, /between\(t,1\.000,3\.500\)/);
    assert.match(fc, /\[vfinal\]/);
    assert.equal(plan.args.includes("[vfinal]"), true);
    // [vout] is chained to [vfinal], so -map must be [vfinal]
    const mapIndices = plan.args.flatMap((arg, i) => arg === "-map" ? [i] : []);
    assert.equal(plan.args[mapIndices[0] + 1], "[vfinal]");
  });

  it("should render multiple caption segments with sequential intervals", () => {
    const project = {
      ratioId: "16:9",
      visualSegments: [{ id: "vis-1", type: "video", duration: 9 }],
      captionSegments: [
        { id: "c-1", text: "Question: What does HTTPS protect?", start: 0, end: 3 },
        { id: "c-2", text: "Think carefully...", start: 3, end: 6 },
        { id: "c-3", text: "Answer: Data in transit", start: 6, end: 9 },
      ],
    };
    const plan = buildFfmpegRenderPlan({ project, media: baseMedia, extractedFiles: dummyFiles });
    const fc = plan.args[plan.args.indexOf("-filter_complex") + 1];

    assert.match(fc, /text='Question\\: What does HTTPS protect\?':expansion=none.*between\(t,0\.000,3\.000\)'\[vc0\]/);
    assert.match(fc, /\[vc0\]drawtext=.*text='Think carefully\.\.\.':expansion=none.*between\(t,3\.000,6\.000\)'\[vc1\]/);
    assert.match(fc, /\[vc1\]drawtext=.*text='Answer\\: Data in transit':expansion=none.*between\(t,6\.000,9\.000\)'\[vfinal\]/);
  });

  it("should support top, center, and bottom caption positioning", () => {
    const projectTop = {
      ratioId: "16:9",
      visualSegments: [{ id: "vis-1", type: "video", duration: 3 }],
      captionSegments: [{ id: "c-1", text: "Top text", start: 0, end: 3, placement: "top" }],
    };
    const planTop = buildFfmpegRenderPlan({ project: projectTop, media: baseMedia, extractedFiles: dummyFiles });
    const fcTop = planTop.args[planTop.args.indexOf("-filter_complex") + 1];
    assert.match(fcTop, /y='\(h\*18\/100\)-\(text_h\/2\)'/);

    const projectMiddle = {
      ratioId: "16:9",
      visualSegments: [{ id: "vis-1", type: "video", duration: 3 }],
      captionSegments: [{ id: "c-1", text: "Mid text", start: 0, end: 3, placement: "middle" }],
    };
    const planMid = buildFfmpegRenderPlan({ project: projectMiddle, media: baseMedia, extractedFiles: dummyFiles });
    const fcMid = planMid.args[planMid.args.indexOf("-filter_complex") + 1];
    assert.match(fcMid, /y='\(h\*50\/100\)-\(text_h\/2\)'/);

    const projectBottom = {
      ratioId: "16:9",
      visualSegments: [{ id: "vis-1", type: "video", duration: 3 }],
      captionSegments: [{ id: "c-1", text: "Bottom text", start: 0, end: 3, placement: "bottom" }],
    };
    const planBot = buildFfmpegRenderPlan({ project: projectBottom, media: baseMedia, extractedFiles: dummyFiles });
    const fcBot = planBot.args[planBot.args.indexOf("-filter_complex") + 1];
    assert.match(fcBot, /y='\(h\*78\/100\)-\(text_h\/2\)'/);

    const projectCustom = {
      ratioId: "16:9",
      visualSegments: [{ id: "vis-1", type: "video", duration: 3 }],
      captionSegments: [{ id: "c-1", text: "Custom text", start: 0, end: 3, placement: { x: 30, y: 40 } }],
    };
    const planCust = buildFfmpegRenderPlan({ project: projectCustom, media: baseMedia, extractedFiles: dummyFiles });
    const fcCust = planCust.args[planCust.args.indexOf("-filter_complex") + 1];
    assert.match(fcCust, /x='\(w\*30\/100\)-\(text_w\/2\)'/);
    assert.match(fcCust, /y='\(h\*40\/100\)-\(text_h\/2\)'/);
  });

  it("should apply custom styling: colors, opacity, box, stroke and font size", () => {
    const project = {
      ratioId: "16:9",
      captionStyle: {
        textColor: "#ffcc00",
        backgroundColor: "#112233",
        backgroundOpacity: 0.75,
        textStrokeWidth: 2,
        textStrokeColor: "#000000",
      },
      captionSize: 20,
      visualSegments: [{ id: "vis-1", type: "video", duration: 3 }],
      captionSegments: [{ id: "c-1", text: "Styled", start: 0, end: 3 }],
    };
    const plan = buildFfmpegRenderPlan({ project, media: baseMedia, extractedFiles: dummyFiles });
    const fc = plan.args[plan.args.indexOf("-filter_complex") + 1];

    assert.match(fc, /fontcolor='0xffcc00'/);
    assert.match(fc, /box=1:boxcolor='0x112233@0.75'/);
    assert.match(fc, /borderw=\d+:bordercolor='0x000000'/);
  });

  it("should scale font size proportionally for 16:9 (720h) and 9:16 (1280h)", () => {
    const project169 = {
      ratioId: "16:9",
      captionSize: 14,
      visualSegments: [{ id: "vis-1", type: "video", duration: 3 }],
      captionSegments: [{ id: "c-1", text: "Scale test", start: 0, end: 3 }],
    };
    const plan169 = buildFfmpegRenderPlan({ project: project169, media: baseMedia, extractedFiles: dummyFiles });
    const fc169 = plan169.args[plan169.args.indexOf("-filter_complex") + 1];
    // height = 720, scale = 720 / 360 = 2 -> fontsize = 14 * 2 = 28
    assert.match(fc169, /fontsize=28/);

    const project916 = {
      ratioId: "9:16",
      captionSize: 14,
      visualSegments: [{ id: "vis-1", type: "video", duration: 3 }],
      captionSegments: [{ id: "c-1", text: "Scale test", start: 0, end: 3 }],
    };
    const plan916 = buildFfmpegRenderPlan({ project: project916, media: baseMedia, extractedFiles: dummyFiles });
    const fc916 = plan916.args[plan916.args.indexOf("-filter_complex") + 1];
    // height = 1280, scale = 1280 / 360 = 3.555 -> fontsize = Math.round(14 * 3.555) = 50
    assert.match(fc916, /fontsize=50/);
  });

  it("should safely escape quotes, colons, ampersands, percent, and punctuation", () => {
    const project = {
      ratioId: "16:9",
      visualSegments: [{ id: "vis-1", type: "video", duration: 3 }],
      captionSegments: [
        { id: "c-1", text: "Don't share your password! 100% secure: \"Yes\" & safe?", start: 0, end: 3 },
      ],
    };
    const plan = buildFfmpegRenderPlan({ project, media: baseMedia, extractedFiles: dummyFiles });
    const fc = plan.args[plan.args.indexOf("-filter_complex") + 1];

    assert.match(fc, /text='Don’t share your password! 100% secure\\: "Yes" & safe\?'/);
    assert.match(fc, /expansion=none/);
  });

  it("should preserve audio mixing when captions are present", () => {
    const project = {
      ratioId: "16:9",
      visualSegments: [{ id: "vis-1", type: "video", duration: 4, volume: 0.9 }],
      audioSegments: [{ id: "audio-1", start: 0.5, duration: 2, volume: 1 }],
      captionSegments: [{ id: "c-1", text: "Audio + Caption", start: 0, end: 3 }],
    };
    const plan = buildFfmpegRenderPlan({ project, media: baseMedia, extractedFiles: dummyFiles });
    assert.equal(plan.hasAudio, true);
    assert.equal(plan.args.includes("-an"), false);
    assert.equal(plan.args.includes("[vfinal]"), true);
    assert.equal(plan.args.includes("[aout]"), true);
  });

  it("should reject unsupported caption animation in assertSupportedProject", () => {
    const project = {
      ratioId: "16:9",
      visualSegments: [{ id: "vis-1", type: "video", duration: 4 }],
      captionSegments: [
        {
          id: "c-1",
          text: "Karaoke caption",
          start: 0,
          end: 3,
          animation: "karaoke",
          words: [{ text: "Karaoke", start: 0, end: 1 }, { text: "caption", start: 1, end: 2 }],
        },
      ],
    };
    assert.throws(
      () => buildFfmpegRenderPlan({ project, media: baseMedia, extractedFiles: dummyFiles }),
      (err) => err.code === "UNSUPPORTED_RENDER_FEATURE" && err.message.includes("karaoke caption animation")
    );
  });

  it("should execute end-to-end CLI render with burned-in captions and verify output", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "render-caption-test-"));
    const sourceVideoPath = join(tempDir, "source.mp4");
    const projectPath = join(tempDir, "test.timeline");
    const outputPath = join(tempDir, "rendered-caption.mp4");
    const planPath = join(tempDir, "render-plan.json");

    try {
      // 1. Synthetic test video (2 seconds)
      await executeFile("ffmpeg", [
        "-hide_banner", "-y",
        "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=30",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=44100",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        sourceVideoPath,
      ]);

      const sourceBytes = await (await import("node:fs/promises")).readFile(sourceVideoPath);

      // 2. Build .timeline archive with 2 captions
      const archiveFiles = {
        "project.json": strToU8(JSON.stringify({
          format: "timeline-studio-archive",
          version: 1,
          project: {
            ratioId: "16:9",
            captionStyle: {
              textColor: "#ffffff",
              backgroundColor: "#05080d",
              backgroundOpacity: 0.7,
            },
            captionSize: 16,
            visualSegments: [
              {
                id: "vis-cut-1",
                type: "video",
                duration: 2.0,
                sourceStart: 0,
                playbackRate: 1,
                volume: 0.8,
              },
            ],
            captionSegments: [
              {
                id: "cap-1",
                text: "Don't share your password!",
                start: 0.0,
                end: 1.0,
                placement: "top",
              },
              {
                id: "cap-2",
                text: "HTTPS protects data in transit.",
                start: 1.0,
                end: 2.0,
                placement: "bottom",
              },
            ],
          },
          media: {
            visuals: [
              { id: "vis-cut-1", path: "media/visuals/source.mp4" },
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

      // 5. Probe rendered video
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
      assert.equal(videoStream.width, 1280);
      assert.equal(videoStream.height, 720);

      assert.ok(audioStream, "Rendered MP4 must contain audio stream");
      assert.equal(audioStream.codec_name, "aac");

      const duration = Number(meta.format.duration);
      assert.ok(Math.abs(duration - 2.0) < 0.2, `Duration should be ~2.0s, got ${duration}`);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("Headless Overlay & Sticker Rendering", () => {
  const dummyFiles = new Map([
    ["media/visuals/clip1.mp4", "C:/temp/clip1.mp4"],
    ["media/overlays/logo.png", "C:/temp/logo.png"],
    ["media/overlays/badge.jpg", "C:/temp/badge.jpg"],
    ["media/stickers/spark.png", "C:/temp/spark.png"],
    ["media/audio/voice.mp3", "C:/temp/voice.mp3"],
  ]);

  const baseMedia = {
    visuals: [
      { id: "vis-1", path: "media/visuals/clip1.mp4" },
    ],
    overlays: [
      { id: "ov-logo", path: "media/overlays/logo.png" },
      { id: "ov-badge", path: "media/overlays/badge.jpg" },
    ],
    stickers: [
      { id: "st-spark", path: "media/stickers/spark.png" },
    ],
    audioSegments: [
      { id: "audio-1", path: "media/audio/voice.mp3" },
    ],
  };

  const dummyProbes = new Map([
    ["C:/temp/logo.png", { width: 400, height: 200 }],
    ["C:/temp/badge.jpg", { width: 300, height: 300 }],
    ["C:/temp/spark.png", { width: 128, height: 128 }],
  ]);

  it("should keep render plan unchanged when no overlays or stickers exist", () => {
    const project = {
      ratioId: "16:9",
      visualSegments: [{ id: "vis-1", type: "video", duration: 5, sourceStart: 0, playbackRate: 1, volume: 1 }],
    };

    const plan = buildFfmpegRenderPlan({ project, media: baseMedia, extractedFiles: dummyFiles });
    const fcIdx = plan.args.indexOf("-filter_complex");
    const filterGraph = plan.args[fcIdx + 1];
    assert.match(filterGraph, /concat=n=1:v=1:a=[01]\[vout\]/);
    assert.equal(filterGraph.includes("overlay="), false);
    const mapIdx = plan.args.indexOf("-map");
    assert.equal(plan.args[mapIdx + 1], "[vout]");
  });

  it("should skip hidden overlays and disabled overlay tracks", () => {
    const projectHidden = {
      ratioId: "16:9",
      visualSegments: [{ id: "vis-1", type: "video", duration: 5 }],
      visualOverlaySegments: [
        { id: "ov-1", archiveMediaId: "ov-logo", start: 1, duration: 2, hidden: true },
      ],
    };
    const planHidden = buildFfmpegRenderPlan({ project: projectHidden, media: baseMedia, extractedFiles: dummyFiles });
    assert.equal(planHidden.args.join(" ").includes("overlay="), false);

    const projectDisabled = {
      ratioId: "16:9",
      trackVisibility: { overlay: false },
      visualSegments: [{ id: "vis-1", type: "video", duration: 5 }],
      visualOverlaySegments: [
        { id: "ov-1", archiveMediaId: "ov-logo", start: 1, duration: 2 },
      ],
    };
    const planDisabled = buildFfmpegRenderPlan({ project: projectDisabled, media: baseMedia, extractedFiles: dummyFiles });
    assert.equal(planDisabled.args.join(" ").includes("overlay="), false);
  });

  it("should render a single overlay with timing, placement, scaling, and format=rgba", () => {
    const project = {
      ratioId: "16:9",
      visualSegments: [{ id: "vis-1", type: "video", duration: 10 }],
      visualOverlaySegments: [
        {
          id: "ov-1",
          archiveMediaId: "ov-logo",
          start: 2,
          end: 6,
          baseTransform: { x: 20, y: -10, scale: 0.5, rotation: 0, opacity: 0.85 },
        },
      ],
    };

    const plan = buildFfmpegRenderPlan({ project, media: baseMedia, extractedFiles: dummyFiles, mediaProbes: dummyProbes });
    assert.equal(plan.args.includes("C:/temp/logo.png"), true);
    const fcIdx = plan.args.indexOf("-filter_complex");
    const filterGraph = plan.args[fcIdx + 1];

    assert.match(filterGraph, /format=rgba/);
    assert.match(filterGraph, /colorchannelmixer=aa=0.850/);
    assert.match(filterGraph, /between\(t,2\.000,6\.000\)/);
    assert.match(filterGraph, /eof_action=repeat/);
    assert.match(filterGraph, /\[vout\]\[ov_prep_0\]overlay=x='.*':y='.*':enable='between\(t,2\.000,6\.000\)':eof_action=repeat\[v_ov_0\]/);

    const mapIdx = plan.args.indexOf("-map");
    assert.equal(plan.args[mapIdx + 1], "[v_ov_0]");
  });

  it("should render multiple overlays with layer ordering and simultaneous co-existence", () => {
    const project = {
      ratioId: "16:9",
      visualSegments: [{ id: "vis-1", type: "video", duration: 10 }],
      visualOverlaySegments: [
        {
          id: "ov-top",
          archiveMediaId: "ov-logo",
          layer: 2,
          start: 3,
          end: 7,
          baseTransform: { x: -20, y: 0, scale: 0.3 },
        },
        {
          id: "ov-bottom",
          archiveMediaId: "ov-badge",
          layer: 1,
          start: 1,
          end: 8,
          baseTransform: { x: 20, y: 0, scale: 0.4 },
        },
      ],
    };

    const plan = buildFfmpegRenderPlan({ project, media: baseMedia, extractedFiles: dummyFiles, mediaProbes: dummyProbes });
    const fcIdx = plan.args.indexOf("-filter_complex");
    const filterGraph = plan.args[fcIdx + 1];

    // Layer 1 (ov-bottom) is composited first onto [vout]
    assert.match(filterGraph, /\[vout\]\[ov_prep_0\]overlay=.*\[v_ov_0\]/);
    // Layer 2 (ov-top) is composited next onto [v_ov_0]
    assert.match(filterGraph, /\[v_ov_0\]\[ov_prep_1\]overlay=.*\[v_ov_1\]/);

    const mapIdx = plan.args.indexOf("-map");
    assert.equal(plan.args[mapIdx + 1], "[v_ov_1]");
  });

  it("should support rotation with transparent padding", () => {
    const project = {
      ratioId: "16:9",
      visualSegments: [{ id: "vis-1", type: "video", duration: 5 }],
      visualOverlaySegments: [
        {
          id: "ov-rot",
          archiveMediaId: "ov-logo",
          start: 0,
          duration: 3,
          baseTransform: { x: 0, y: 0, scale: 0.5, rotation: 45 },
        },
      ],
    };

    const plan = buildFfmpegRenderPlan({ project, media: baseMedia, extractedFiles: dummyFiles, mediaProbes: dummyProbes });
    const fcIdx = plan.args.indexOf("-filter_complex");
    const filterGraph = plan.args[fcIdx + 1];
    assert.match(filterGraph, /rotate=0\.7854:c=none:ow='rotw\(0\.7854\)':oh='roth\(0\.7854\)'/);
  });

  it("should render stickers using sticker geometry", () => {
    const project = {
      ratioId: "16:9",
      visualSegments: [{ id: "vis-1", type: "video", duration: 5 }],
      stickerSegments: [
        {
          id: "st-1",
          archiveMediaId: "st-spark",
          start: 1,
          duration: 3,
          x: 75,
          y: 25,
          scale: 1.2,
          opacity: 0.9,
        },
      ],
    };

    const plan = buildFfmpegRenderPlan({ project, media: baseMedia, extractedFiles: dummyFiles, mediaProbes: dummyProbes });
    assert.equal(plan.args.includes("C:/temp/spark.png"), true);
    const fcIdx = plan.args.indexOf("-filter_complex");
    const filterGraph = plan.args[fcIdx + 1];
    assert.match(filterGraph, /\[st_prep_0\]/);
    assert.match(filterGraph, /between\(t,1\.000,4\.000\)/);
    assert.match(filterGraph, /colorchannelmixer=aa=0.900/);
    const mapIdx = plan.args.indexOf("-map");
    assert.equal(plan.args[mapIdx + 1], "[v_ov_0]");
  });

  it("should composite overlays, stickers, captions, and audio seamlessly", () => {
    const project = {
      ratioId: "16:9",
      visualSegments: [{ id: "vis-1", type: "video", duration: 5, sourceStart: 0, playbackRate: 1, volume: 1 }],
      visualOverlaySegments: [
        { id: "ov-1", archiveMediaId: "ov-logo", start: 0, duration: 4 },
      ],
      stickerSegments: [
        { id: "st-1", archiveMediaId: "st-spark", start: 1, duration: 3 },
      ],
      captionSegments: [
        { id: "cap-1", text: "Important notice!", start: 0.5, duration: 2 },
      ],
      audioSegments: [
        { id: "audio-1", duration: 4, start: 0, volume: 0.9 },
      ],
    };

    const plan = buildFfmpegRenderPlan({ project, media: baseMedia, extractedFiles: dummyFiles, mediaProbes: dummyProbes });
    assert.equal(plan.hasAudio, true);
    const fcIdx = plan.args.indexOf("-filter_complex");
    const filterGraph = plan.args[fcIdx + 1];

    // Pipeline chain:
    // [vout] -> overlay [v_ov_0] -> sticker [v_ov_1] -> caption [vfinal]
    assert.match(filterGraph, /\[vout\]\[ov_prep_0\]overlay=.*\[v_ov_0\]/);
    assert.match(filterGraph, /\[v_ov_0\]\[st_prep_1\]overlay=.*\[v_ov_1\]/);
    assert.match(filterGraph, /\[v_ov_1\]drawtext=.*\[vfinal\]/);

    const mapIndices = plan.args.flatMap((arg, i) => arg === "-map" ? [i] : []);
    const mappedLabels = mapIndices.map((i) => plan.args[i + 1]);
    assert.deepEqual(mappedLabels, ["[vfinal]", "[aout]"]);
  });

  it("should adapt overlay scaling to 16:9 and 9:16 aspect ratios", () => {
    const project169 = {
      ratioId: "16:9",
      visualSegments: [{ id: "vis-1", type: "video", duration: 5 }],
      visualOverlaySegments: [{ id: "ov-1", archiveMediaId: "ov-logo", start: 0, duration: 2, baseTransform: { scale: 0.5 } }],
    };
    const plan169 = buildFfmpegRenderPlan({ project: project169, media: baseMedia, extractedFiles: dummyFiles, mediaProbes: dummyProbes });
    assert.equal(plan169.width, 1280);
    assert.equal(plan169.height, 720);

    const project916 = {
      ratioId: "9:16",
      visualSegments: [{ id: "vis-1", type: "video", duration: 5 }],
      visualOverlaySegments: [{ id: "ov-1", archiveMediaId: "ov-logo", start: 0, duration: 2, baseTransform: { scale: 0.5 } }],
    };
    const plan916 = buildFfmpegRenderPlan({ project: project916, media: baseMedia, extractedFiles: dummyFiles, mediaProbes: dummyProbes });
    assert.equal(plan916.width, 720);
    assert.equal(plan916.height, 1280);
  });

  it("should reject genuinely unsupported overlay features via feature gate", () => {
    const projectWithKeyframes = {
      ratioId: "16:9",
      visualSegments: [{ id: "vis-1", type: "video", duration: 5 }],
      visualOverlaySegments: [
        { id: "ov-1", archiveMediaId: "ov-logo", start: 0, duration: 2, keyframes: [{ time: 0, x: 0 }, { time: 1, x: 20 }] },
      ],
    };
    assert.throws(
      () => buildFfmpegRenderPlan({ project: projectWithKeyframes, media: baseMedia, extractedFiles: dummyFiles }),
      (err) => err.code === "UNSUPPORTED_RENDER_FEATURE" && err.message.includes("overlay keyframes")
    );

    const projectWithAnimation = {
      ratioId: "16:9",
      visualSegments: [{ id: "vis-1", type: "video", duration: 5 }],
      visualOverlaySegments: [
        { id: "ov-1", archiveMediaId: "ov-logo", start: 0, duration: 2, animation: "bounce" },
      ],
    };
    assert.throws(
      () => buildFfmpegRenderPlan({ project: projectWithAnimation, media: baseMedia, extractedFiles: dummyFiles }),
      (err) => err.code === "UNSUPPORTED_RENDER_FEATURE" && err.message.includes("overlay animation")
    );

    const projectWithMask = {
      ratioId: "16:9",
      visualSegments: [{ id: "vis-1", type: "video", duration: 5 }],
      visualOverlaySegments: [
        { id: "ov-1", archiveMediaId: "ov-logo", start: 0, duration: 2, mask: { type: "circle" } },
      ],
    };
    assert.throws(
      () => buildFfmpegRenderPlan({ project: projectWithMask, media: baseMedia, extractedFiles: dummyFiles }),
      (err) => err.code === "UNSUPPORTED_RENDER_FEATURE" && err.message.includes("overlay masks")
    );
  });

  it("should execute end-to-end CLI render with overlays, stickers, captions and audio", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "render-overlay-test-"));
    const sourceVideoPath = join(tempDir, "source.mp4");
    const overlayPngPath = join(tempDir, "overlay.png");
    const stickerPngPath = join(tempDir, "sticker.png");
    const projectPath = join(tempDir, "test.timeline");
    const outputPath = join(tempDir, "rendered-overlay.mp4");
    const planPath = join(tempDir, "render-plan.json");

    try {
      // 1. Synthetic test video (2 seconds)
      await executeFile("ffmpeg", [
        "-hide_banner", "-y",
        "-f", "lavfi", "-i", "testsrc=duration=2:size=640x360:rate=30",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=44100",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        sourceVideoPath,
      ]);

      // 2. Synthetic transparent PNG overlay
      await executeFile("ffmpeg", [
        "-hide_banner", "-y",
        "-f", "lavfi", "-i", "color=c=red@0.8:s=120x120:d=1",
        "-frames:v", "1",
        overlayPngPath,
      ]);

      // 3. Synthetic transparent PNG sticker
      await executeFile("ffmpeg", [
        "-hide_banner", "-y",
        "-f", "lavfi", "-i", "color=c=yellow@0.9:s=100x100:d=1",
        "-frames:v", "1",
        stickerPngPath,
      ]);

      const sourceBytes = await (await import("node:fs/promises")).readFile(sourceVideoPath);
      const overlayBytes = await (await import("node:fs/promises")).readFile(overlayPngPath);
      const stickerBytes = await (await import("node:fs/promises")).readFile(stickerPngPath);

      // 4. Build .timeline archive
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
                duration: 2.0,
                sourceStart: 0,
                playbackRate: 1,
                volume: 0.8,
              },
            ],
            visualOverlaySegments: [
              {
                id: "ov-test-1",
                archiveMediaId: "ov-media-1",
                start: 0.2,
                end: 1.5,
                baseTransform: { x: 25, y: -20, scale: 0.4, rotation: 15, opacity: 0.8 },
              },
            ],
            stickerSegments: [
              {
                id: "st-test-1",
                archiveMediaId: "st-media-1",
                start: 0.5,
                end: 1.8,
                x: 75,
                y: 75,
                scale: 1.0,
                opacity: 0.9,
              },
            ],
            captionSegments: [
              {
                id: "cap-1",
                text: "Overlay + Sticker Active",
                start: 0.4,
                end: 1.6,
                placement: "bottom",
              },
            ],
          },
          media: {
            visuals: [
              { id: "vis-cut-1", path: "media/visuals/source.mp4" },
            ],
            overlays: [
              { id: "ov-media-1", path: "media/overlays/overlay.png" },
            ],
            stickers: [
              { id: "st-media-1", path: "media/stickers/sticker.png" },
            ],
          },
        })),
        "media/visuals/source.mp4": new Uint8Array(sourceBytes),
        "media/overlays/overlay.png": new Uint8Array(overlayBytes),
        "media/stickers/sticker.png": new Uint8Array(stickerBytes),
      };

      await writeFile(projectPath, zipSync(archiveFiles, { level: 6 }));

      // 5. Write render plan
      await writeFile(planPath, JSON.stringify({
        schemaVersion: 1,
        project: projectPath,
        output: { video: outputPath },
        render: { preset: "ultrafast" },
      }));

      // 6. Run CLI render
      const cliScript = resolve(process.cwd(), "scripts", "timeline-command.mjs");
      const { stdout } = await executeFile(process.execPath, [cliScript, "project.render", planPath]);
      const res = JSON.parse(stdout);

      assert.equal(res.ok, true);
      assert.equal(res.verification.hasAudio, true);

      // 7. Probe rendered video
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
      assert.equal(videoStream.width, 1280);
      assert.equal(videoStream.height, 720);

      assert.ok(audioStream, "Rendered MP4 must contain audio stream");
      assert.equal(audioStream.codec_name, "aac");

      const duration = Number(meta.format.duration);
      assert.ok(Math.abs(duration - 2.0) < 0.2, `Duration should be ~2.0s, got ${duration}`);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("Headless Transition Rendering & Compositing", () => {
  const dummyFiles = new Map([
    ["media/visuals/clip1.mp4", "C:/temp/clip1.mp4"],
    ["media/visuals/clip2.mp4", "C:/temp/clip2.mp4"],
    ["media/visuals/clip3.mp4", "C:/temp/clip3.mp4"],
    ["media/audio/voice.mp3", "C:/temp/voice.mp3"],
    ["media/music/track.mp3", "C:/temp/track.mp3"],
    ["media/overlays/logo.png", "C:/temp/logo.png"],
    ["media/stickers/badge.png", "C:/temp/badge.png"],
  ]);

  const baseMedia = {
    visuals: [
      { id: "vis-1", path: "media/visuals/clip1.mp4" },
      { id: "vis-2", path: "media/visuals/clip2.mp4" },
      { id: "vis-3", path: "media/visuals/clip3.mp4" },
    ],
    audioSegments: [
      { id: "audio-1", path: "media/audio/voice.mp3" },
    ],
    music: { id: "music-1", path: "media/music/track.mp3" },
    overlays: [
      { id: "ov-logo", path: "media/overlays/logo.png" },
    ],
    stickers: [
      { id: "st-badge", path: "media/stickers/badge.png" },
    ],
  };

  const dummyProbes = new Map([
    ["C:/temp/clip1.mp4", { hasAudio: true, width: 1280, height: 720 }],
    ["C:/temp/clip2.mp4", { hasAudio: true, width: 1280, height: 720 }],
    ["C:/temp/clip3.mp4", { hasAudio: true, width: 1280, height: 720 }],
  ]);

  it("should keep render plan unchanged when no transitions exist", () => {
    const project = {
      ratioId: "16:9",
      visualSegments: [
        { id: "vis-1", type: "video", duration: 3.0 },
        { id: "vis-2", type: "video", duration: 3.0 },
      ],
    };
    const plan = buildFfmpegRenderPlan({ project, media: baseMedia, extractedFiles: dummyFiles, mediaProbes: dummyProbes });
    assert.equal(plan.duration, 6.0);
    const filterStr = plan.args[plan.args.indexOf("-filter_complex") + 1];
    assert.match(filterStr, /concat=n=2:v=1:a=1\[vout\]\[vaout\]/);
    assert.doesNotMatch(filterStr, /xfade/);
  });

  it("should skip transition when id is 'none' or on the final clip", () => {
    const project = {
      ratioId: "16:9",
      visualSegments: [
        { id: "vis-1", type: "video", duration: 3.0, transition: { id: "none", duration: 0.5 } },
        { id: "vis-2", type: "video", duration: 3.0, transition: { id: "fade", duration: 0.5 } }, // final clip transition has no target
      ],
    };
    const plan = buildFfmpegRenderPlan({ project, media: baseMedia, extractedFiles: dummyFiles, mediaProbes: dummyProbes });
    assert.equal(plan.duration, 6.0);
    const filterStr = plan.args[plan.args.indexOf("-filter_complex") + 1];
    assert.match(filterStr, /concat=n=2:v=1:a=1\[vout\]\[vaout\]/);
  });

  it("should render a single fade transition with correct offset, duration, and adjusted plan duration", () => {
    const project = {
      ratioId: "16:9",
      visualSegments: [
        { id: "vis-1", type: "video", duration: 4.0, transition: { id: "fade", duration: 1.0 } },
        { id: "vis-2", type: "video", duration: 4.0 },
      ],
    };
    const plan = buildFfmpegRenderPlan({ project, media: baseMedia, extractedFiles: dummyFiles, mediaProbes: dummyProbes });
    assert.equal(plan.duration, 7.0); // 4 + 4 - 1 = 7s
    const filterStr = plan.args[plan.args.indexOf("-filter_complex") + 1];
    assert.match(filterStr, /\[v0\]\[v1\]xfade=transition=fade:duration=1:offset=3\.0000,settb=1\/30\[vout\]/);
    assert.match(filterStr, /\[a0\]\[a1\]acrossfade=d=1:c1=tri:c2=tri\[vaout\]/);
  });

  it("should support multiple transition durations (0.25s, 0.5s, 1.0s)", () => {
    const durations = [0.25, 0.5, 1.0];
    for (const d of durations) {
      const project = {
        ratioId: "16:9",
        visualSegments: [
          { id: "vis-1", type: "video", duration: 4.0, transition: { id: "fade", duration: d } },
          { id: "vis-2", type: "video", duration: 4.0 },
        ],
      };
      const plan = buildFfmpegRenderPlan({ project, media: baseMedia, extractedFiles: dummyFiles, mediaProbes: dummyProbes });
      const expectedDuration = 4.0 + 4.0 - d;
      const expectedOffset = (4.0 - d).toFixed(4);
      assert.equal(plan.duration, expectedDuration);
      const filterStr = plan.args[plan.args.indexOf("-filter_complex") + 1];
      assert.match(filterStr, new RegExp(`\\[v0\\]\\[v1\\]xfade=transition=fade:duration=${d}:offset=${expectedOffset},settb=1\\/30\\[vout\\]`));
      assert.match(filterStr, new RegExp(`\\[a0\\]\\[a1\\]acrossfade=d=${d}:c1=tri:c2=tri\\[vaout\\]`));
    }
  });

  it("should render multiple sequential transitions across 3 clips", () => {
    const project = {
      ratioId: "16:9",
      visualSegments: [
        { id: "vis-1", type: "video", duration: 3.0, transition: { id: "fade", duration: 0.5 } },
        { id: "vis-2", type: "video", duration: 3.0, transition: { id: "wipe-left", duration: 0.5 } },
        { id: "vis-3", type: "video", duration: 3.0 },
      ],
    };
    const plan = buildFfmpegRenderPlan({ project, media: baseMedia, extractedFiles: dummyFiles, mediaProbes: dummyProbes });
    assert.equal(plan.duration, 8.0); // 3 + 3 + 3 - 0.5 - 0.5 = 8.0s
    const filterStr = plan.args[plan.args.indexOf("-filter_complex") + 1];
    // First transition: offset = 3 - 0.5 = 2.5
    assert.match(filterStr, /\[v0\]\[v1\]xfade=transition=fade:duration=0\.5:offset=2\.5000,settb=1\/30\[vx_0\]/);
    assert.match(filterStr, /\[a0\]\[a1\]acrossfade=d=0\.5:c1=tri:c2=tri\[ax_0\]/);
    // Second transition: offset = (3 + 3 - 0.5) - 0.5 = 5.0
    assert.match(filterStr, /\[vx_0\]\[v2\]xfade=transition=wipeleft:duration=0\.5:offset=5\.0000,settb=1\/30\[vout\]/);
    assert.match(filterStr, /\[ax_0\]\[a2\]acrossfade=d=0\.5:c1=tri:c2=tri\[vaout\]/);
  });

  it("should support mixed cut and transition across 3 clips", () => {
    const project = {
      ratioId: "16:9",
      visualSegments: [
        { id: "vis-1", type: "video", duration: 3.0, transition: { id: "fade", duration: 0.5 } },
        { id: "vis-2", type: "video", duration: 3.0 }, // cut to clip 3
        { id: "vis-3", type: "video", duration: 3.0 },
      ],
    };
    const plan = buildFfmpegRenderPlan({ project, media: baseMedia, extractedFiles: dummyFiles, mediaProbes: dummyProbes });
    assert.equal(plan.duration, 8.5); // 3 + 3 - 0.5 + 3 = 8.5s
    const filterStr = plan.args[plan.args.indexOf("-filter_complex") + 1];
    assert.match(filterStr, /\[v0\]\[v1\]xfade=transition=fade:duration=0\.5:offset=2\.5000,settb=1\/30\[vx_0\]/);
    assert.match(filterStr, /\[vx_0\]\[v2\]concat=n=2:v=1:a=0,settb=1\/30\[vout\]/);
  });

  it("should map all supported transition types to valid FFmpeg xfade filters", () => {
    const supported = [
      { id: "fade", expected: "fade" },
      { id: "wipe-left", expected: "wipeleft" },
      { id: "wipe-up", expected: "wipeup" },
      { id: "split", expected: "horzopen" },
      { id: "zoom", expected: "zoomin" },
      { id: "flash", expected: "fadewhite" },
      { id: "blur", expected: "hblur" },
    ];

    for (const { id, expected } of supported) {
      const project = {
        ratioId: "16:9",
        visualSegments: [
          { id: "vis-1", type: "video", duration: 2.0, transition: { id, duration: 0.5 } },
          { id: "vis-2", type: "video", duration: 2.0 },
        ],
      };
      const plan = buildFfmpegRenderPlan({ project, media: baseMedia, extractedFiles: dummyFiles, mediaProbes: dummyProbes });
      const filterStr = plan.args[plan.args.indexOf("-filter_complex") + 1];
      assert.match(filterStr, new RegExp(`xfade=transition=${expected}:duration=0\\.5:offset=1\\.5000`));
    }
  });

  it("should adapt transitions to 16:9 and 9:16 aspect ratios", () => {
    const project169 = {
      ratioId: "16:9",
      visualSegments: [
        { id: "vis-1", type: "video", duration: 2.0, transition: { id: "wipe-left", duration: 0.5 } },
        { id: "vis-2", type: "video", duration: 2.0 },
      ],
    };
    const plan169 = buildFfmpegRenderPlan({ project: project169, media: baseMedia, extractedFiles: dummyFiles, mediaProbes: dummyProbes });
    assert.equal(plan169.width, 1280);
    assert.equal(plan169.height, 720);

    const project916 = {
      ratioId: "9:16",
      visualSegments: [
        { id: "vis-1", type: "video", duration: 2.0, transition: { id: "wipe-up", duration: 0.5 } },
        { id: "vis-2", type: "video", duration: 2.0 },
      ],
    };
    const plan916 = buildFfmpegRenderPlan({ project: project916, media: baseMedia, extractedFiles: dummyFiles, mediaProbes: dummyProbes });
    assert.equal(plan916.width, 720);
    assert.equal(plan916.height, 1280);
  });

  it("should seamlessly composite transitions with voiceover, music, captions, overlays, and stickers", () => {
    const project = {
      ratioId: "16:9",
      visualSegments: [
        { id: "vis-1", type: "video", duration: 3.0, transition: { id: "fade", duration: 1.0 } },
        { id: "vis-2", type: "video", duration: 3.0 },
      ],
      audioSegments: [
        { id: "audio-1", duration: 2.0, start: 0.5, volume: 1.0 },
      ],
      musicSegments: [
        { id: "music-1", duration: 5.0, start: 0, volume: 0.4 },
      ],
      visualOverlaySegments: [
        { id: "ov-1", archiveMediaId: "ov-logo", start: 1.0, end: 4.0, baseTransform: { x: 20, y: -20, scale: 0.5 } },
      ],
      stickerSegments: [
        { id: "st-1", archiveMediaId: "st-badge", start: 2.0, end: 4.5, x: 80, y: 20, scale: 1.0 },
      ],
      captionSegments: [
        { id: "cap-1", text: "Transition Active", start: 1.5, end: 3.5, placement: "bottom" },
      ],
    };

    const plan = buildFfmpegRenderPlan({ project, media: baseMedia, extractedFiles: dummyFiles, mediaProbes: dummyProbes });
    assert.equal(plan.duration, 5.0); // 3 + 3 - 1 = 5.0s
    assert.equal(plan.hasAudio, true);

    const filterStr = plan.args[plan.args.indexOf("-filter_complex") + 1];
    // Video transition
    assert.match(filterStr, /xfade=transition=fade:duration=1:offset=2\.0000/);
    // Audio crossfade
    assert.match(filterStr, /acrossfade=d=1:c1=tri:c2=tri/);
    // Voiceover & music mixing
    assert.match(filterStr, /amix=inputs=3:duration=longest:normalize=0,atrim=duration=5\[aout\]/);
    // Overlay & sticker & caption chain
    assert.match(filterStr, /overlay=x='.*':y='.*':enable='between\(t,1\.000,4\.000\)'/);
    assert.match(filterStr, /overlay=x='.*':y='.*':enable='between\(t,2\.000,4\.500\)'/);
    assert.match(filterStr, /drawtext=.*text='Transition Active'.*enable='between\(t,1\.500,3\.500\)'/);
  });

  it("should reject unsupported transition types with UNSUPPORTED_RENDER_FEATURE", () => {
    const projectWithGlitch = {
      ratioId: "16:9",
      visualSegments: [
        { id: "vis-1", type: "video", duration: 3.0, transition: { id: "glitch", duration: 0.5 } },
        { id: "vis-2", type: "video", duration: 3.0 },
      ],
    };
    assert.throws(
      () => buildFfmpegRenderPlan({ project: projectWithGlitch, media: baseMedia, extractedFiles: dummyFiles, mediaProbes: dummyProbes }),
      (err) => err.code === "UNSUPPORTED_RENDER_FEATURE" && err.message.includes('transition "glitch"')
    );
  });

  it("should reject transition duration exceeding clip duration with INVALID_TRANSITION", () => {
    const projectTooLong = {
      ratioId: "16:9",
      visualSegments: [
        { id: "vis-1", type: "video", duration: 1.0, transition: { id: "fade", duration: 1.5 } },
        { id: "vis-2", type: "video", duration: 2.0 },
      ],
    };
    assert.throws(
      () => buildFfmpegRenderPlan({ project: projectTooLong, media: baseMedia, extractedFiles: dummyFiles, mediaProbes: dummyProbes }),
      (err) => err.code === "INVALID_TRANSITION" && err.message.includes("Transition duration")
    );
  });

  it("should execute real end-to-end CLI render with video transition, audio, captions, overlays, and stickers", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "render-transition-test-"));
    const sourceVideo1 = join(tempDir, "source1.mp4");
    const sourceVideo2 = join(tempDir, "source2.mp4");
    const overlayPng = join(tempDir, "overlay.png");
    const stickerPng = join(tempDir, "sticker.png");
    const projectPath = join(tempDir, "test.timeline");
    const outputPath = join(tempDir, "rendered-transition.mp4");
    const planPath = join(tempDir, "render-plan.json");

    try {
      // 1. Synthetic video 1 (red, 2 seconds, 440Hz tone)
      await executeFile("ffmpeg", [
        "-hide_banner", "-y",
        "-f", "lavfi", "-i", "color=c=red:size=640x360:duration=2:rate=30",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=44100",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        sourceVideo1,
      ]);

      // 2. Synthetic video 2 (blue, 2 seconds, 880Hz tone)
      await executeFile("ffmpeg", [
        "-hide_banner", "-y",
        "-f", "lavfi", "-i", "color=c=blue:size=640x360:duration=2:rate=30",
        "-f", "lavfi", "-i", "sine=frequency=880:duration=2:sample_rate=44100",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        sourceVideo2,
      ]);

      // 3. Synthetic transparent overlay & sticker
      await executeFile("ffmpeg", [
        "-hide_banner", "-y",
        "-f", "lavfi", "-i", "color=c=green@0.8:s=100x100:d=1",
        "-frames:v", "1",
        overlayPng,
      ]);
      await executeFile("ffmpeg", [
        "-hide_banner", "-y",
        "-f", "lavfi", "-i", "color=c=yellow@0.9:s=80x80:d=1",
        "-frames:v", "1",
        stickerPng,
      ]);

      const [s1Bytes, s2Bytes, ovBytes, stBytes] = await Promise.all([
        (await import("node:fs/promises")).readFile(sourceVideo1),
        (await import("node:fs/promises")).readFile(sourceVideo2),
        (await import("node:fs/promises")).readFile(overlayPng),
        (await import("node:fs/promises")).readFile(stickerPng),
      ]);

      // 4. Build .timeline archive
      const archiveFiles = {
        "project.json": strToU8(JSON.stringify({
          format: "timeline-studio-archive",
          version: 1,
          project: {
            ratioId: "16:9",
            visualSegments: [
              {
                id: "vis-1",
                type: "video",
                duration: 2.0,
                sourceStart: 0,
                playbackRate: 1,
                transition: { id: "fade", duration: 0.5 },
              },
              {
                id: "vis-2",
                type: "video",
                duration: 2.0,
                sourceStart: 0,
                playbackRate: 1,
              },
            ],
            visualOverlaySegments: [
              {
                id: "ov-test",
                archiveMediaId: "ov-media",
                start: 0.5,
                end: 2.5,
                baseTransform: { x: 20, y: -20, scale: 0.4 },
              },
            ],
            stickerSegments: [
              {
                id: "st-test",
                archiveMediaId: "st-media",
                start: 1.0,
                end: 3.0,
                x: 80,
                y: 80,
                scale: 1.0,
              },
            ],
            captionSegments: [
              {
                id: "cap-1",
                text: "Crossfade Active",
                start: 1.0,
                end: 2.5,
                placement: "bottom",
              },
            ],
          },
          media: {
            visuals: [
              { id: "vis-1", path: "media/visuals/source1.mp4" },
              { id: "vis-2", path: "media/visuals/source2.mp4" },
            ],
            overlays: [
              { id: "ov-media", path: "media/overlays/overlay.png" },
            ],
            stickers: [
              { id: "st-media", path: "media/stickers/sticker.png" },
            ],
          },
        })),
        "media/visuals/source1.mp4": s1Bytes,
        "media/visuals/source2.mp4": s2Bytes,
        "media/overlays/overlay.png": ovBytes,
        "media/stickers/sticker.png": stBytes,
      };

      await writeFile(projectPath, zipSync(archiveFiles));

      // 5. Build render plan request
      await writeFile(planPath, JSON.stringify({
        schemaVersion: 1,
        project: projectPath,
        output: { video: outputPath },
        render: { width: 1280, height: 720 },
      }, null, 2));

      // 6. Execute project.render via CLI
      const cliScript = resolve(process.cwd(), "scripts/timeline-command.mjs");
      const { stdout } = await executeFile(process.execPath, [cliScript, "project.render", planPath]);
      const res = JSON.parse(stdout);

      assert.equal(res.ok, true);
      assert.equal(res.verification.hasAudio, true);

      // 7. Probe rendered video
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
      assert.equal(videoStream.width, 1280);
      assert.equal(videoStream.height, 720);

      assert.ok(audioStream, "Rendered MP4 must contain audio stream");
      assert.equal(audioStream.codec_name, "aac");

      // Expected duration is 2.0 + 2.0 - 0.5 = 3.5s
      const duration = Number(meta.format.duration);
      assert.ok(Math.abs(duration - 3.5) < 0.25, `Duration should be ~3.5s, got ${duration}`);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
