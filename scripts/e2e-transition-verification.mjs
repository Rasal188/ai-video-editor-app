import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { strToU8, zipSync } from "fflate";

const executeFile = promisify(execFile);

async function main() {
  const artifactsDir = resolve(process.cwd(), "test-artifacts", "transition-e2e");
  await rm(artifactsDir, { recursive: true, force: true });
  await mkdir(artifactsDir, { recursive: true });

  const video1Path = resolve(process.cwd(), "test-artifacts", "video-1-dns.mp4");
  const video2Path = resolve(process.cwd(), "test-artifacts", "video-2-tcp-udp.mp4");
  const video3Path = resolve(process.cwd(), "test-artifacts", "video-3-https.mp4");
  const logoPath = resolve(process.cwd(), "public", "icons", "timeline-studio-icon-192.png");
  const stickerPath = resolve(process.cwd(), "public", "assets", "stickers", "trend-verified.png");

  const project1Path = join(artifactsDir, "01-initial.timeline");
  const project2Path = join(artifactsDir, "02-with-transitions.timeline");
  const renderPlanPath = join(artifactsDir, "render-request.json");
  const renderedMp4Path = join(artifactsDir, "e2e-final-rendered.mp4");
  const renderPlan916Path = join(artifactsDir, "render-request-916.json");
  const rendered916Mp4Path = join(artifactsDir, "e2e-final-rendered-916.mp4");

  const voicePath = resolve(process.cwd(), "public", "assets", "voice-samples", "af_heart.mp3");
  const musicPath = resolve(process.cwd(), "public", "assets", "voice-samples", "am_fenrir.mp3");

  console.log("=== Step 1: Initialize base .timeline archive with 3 distinct real videos + voice + music ===");
  const [v1Bytes, v2Bytes, v3Bytes, voiceBytes, musicBytes] = await Promise.all([
    readFile(video1Path),
    readFile(video2Path),
    readFile(video3Path),
    readFile(voicePath),
    readFile(musicPath),
  ]);

  const initialArchive = {
    "project.json": strToU8(JSON.stringify({
      format: "timeline-studio-archive",
      version: 1,
      project: {
        ratioId: "16:9",
        captionStyle: {
          textColor: "#ffff00",
          backgroundColor: "#05080d",
          backgroundOpacity: 0.75,
        },
        captionSize: 16,
        visualSegments: [
          {
            id: "vis-1",
            type: "video",
            duration: 4.0,
            sourceStart: 0,
            playbackRate: 1,
            volume: 0.9,
          },
          {
            id: "vis-2",
            type: "video",
            duration: 4.0,
            sourceStart: 0,
            playbackRate: 1,
            volume: 0.9,
          },
          {
            id: "vis-3",
            type: "video",
            duration: 4.0,
            sourceStart: 0,
            playbackRate: 1,
            volume: 0.9,
          },
        ],
        audioSegments: [
          {
            id: "voice-1",
            start: 0.5,
            duration: 4.5,
            sourceStart: 0,
            sourceDuration: 4.5,
            playbackRate: 1,
            volume: 1.0,
          },
        ],
        musicSegments: [
          {
            id: "music-1",
            start: 0,
            duration: 10.2,
            sourceStart: 0,
            sourceDuration: 5.7,
            playbackRate: 1,
            volume: 0.25,
          },
        ],
      },
      media: {
        visuals: [
          { id: "vis-1", path: "media/visuals/clip1.mp4" },
          { id: "vis-2", path: "media/visuals/clip2.mp4" },
          { id: "vis-3", path: "media/visuals/clip3.mp4" },
        ],
        audio: { id: "voice-1", path: "media/audio/voice.mp3" },
        music: { id: "music-1", path: "media/audio/music.mp3" },
      },
    })),
    "media/visuals/clip1.mp4": new Uint8Array(v1Bytes),
    "media/visuals/clip2.mp4": new Uint8Array(v2Bytes),
    "media/visuals/clip3.mp4": new Uint8Array(v3Bytes),
    "media/audio/voice.mp3": new Uint8Array(voiceBytes),
    "media/audio/music.mp3": new Uint8Array(musicBytes),
  };
  await writeFile(project1Path, zipSync(initialArchive, { level: 6 }));
  console.log("Created initial 3-clip timeline with voiceover and music:", project1Path);

  console.log("=== Step 2: Use CLI commands to apply transition.set, captions, and overlays ===");
  const cliScript = resolve(process.cwd(), "scripts", "timeline-command.mjs");
  const editPlanPath = join(artifactsDir, "cli-edit-plan.json");

  // Operations via CLI project.run:
  // 1. transition.set: Clip 1 -> Clip 2 with 'fade', duration: 1.0s
  // 2. transition.set: Clip 2 -> Clip 3 with 'wipe-left', duration: 0.8s
  // 3. asset.import: logo PNG for overlay
  // 4. asset.import: sticker PNG for sticker overlay
  // 5. overlay.add: logo overlay spanning transition 1 (start: 2.5, duration: 2.5)
  // 6. overlay.set_transform: logo transform
  // 7. overlay.add: sticker overlay spanning transition 2 (start: 5.5, duration: 2.5)
  // 8. overlay.set_transform: sticker transform
  // 9. visual.delete: remove imported logo from visual sequence so main sequence is purely 3 videos
  // 10. visual.delete: remove imported sticker from visual sequence
  // 11. caption.add: caption across transition 1 (start: 2.5, end: 4.5, text: "Crossfade: DNS to TCP")
  // 12. caption.add: caption across transition 2 (start: 5.8, end: 7.2, text: "Wipe Left: TCP to HTTPS")
  const editPlan = {
    schemaVersion: 1,
    baseRevision: 0,
    project: project1Path,
    output: { project: project2Path },
    operations: [
      {
        id: "trans-1",
        type: "transition.set",
        clipId: "vis-1",
        transitionId: "fade",
        duration: 1.0,
      },
      {
        id: "trans-2",
        type: "transition.set",
        clipId: "vis-2",
        transitionId: "wipe-left",
        duration: 0.8,
      },
      {
        id: "import-logo",
        type: "asset.import",
        track: "visuals",
        clipId: "clip-logo",
        file: logoPath,
      },
      {
        id: "import-sticker",
        type: "asset.import",
        track: "visuals",
        clipId: "clip-sticker",
        file: stickerPath,
      },
      {
        id: "add-ov-1",
        type: "overlay.add",
        clipId: "ov-clip-1",
        sourceClipId: "clip-logo",
        start: 2.5,
        duration: 2.5,
        layer: 1,
      },
      {
        id: "set-tf-1",
        type: "overlay.set_transform",
        clipId: "ov-clip-1",
        transform: { x: 30, y: -22, scale: 0.35, rotation: 12, opacity: 0.9 },
      },
      {
        id: "add-ov-2",
        type: "overlay.add",
        clipId: "ov-clip-2",
        sourceClipId: "clip-sticker",
        start: 5.5,
        duration: 2.5,
        layer: 2,
      },
      {
        id: "set-tf-2",
        type: "overlay.set_transform",
        clipId: "ov-clip-2",
        transform: { x: -30, y: 22, scale: 0.45, rotation: 0, opacity: 0.95 },
      },
      {
        id: "del-logo",
        type: "visual.delete",
        clipId: "clip-logo",
      },
      {
        id: "del-sticker",
        type: "visual.delete",
        clipId: "clip-sticker",
      },
      {
        id: "add-cap-1",
        type: "caption.add",
        clipId: "cap-1",
        text: "Crossfade: DNS to TCP",
        start: 2.5,
        end: 4.5,
      },
      {
        id: "add-cap-2",
        type: "caption.add",
        clipId: "cap-2",
        text: "Wipe Left: TCP to HTTPS",
        start: 5.8,
        end: 7.2,
      },
    ],
  };

  await writeFile(editPlanPath, JSON.stringify(editPlan, null, 2));
  console.log("Wrote edit plan:", editPlanPath);

  const { stdout: runOut } = await executeFile(process.execPath, [cliScript, "project.run", editPlanPath]);
  console.log("project.run result:", runOut);
  const runResult = JSON.parse(runOut);
  if (!runResult.ok) {
    throw new Error(`CLI project.run failed: ${JSON.stringify(runResult)}`);
  }
  console.log("Successfully created updated project:", project2Path);

  console.log("=== Step 3: Render 16:9 MP4 via CLI project.render ===");
  const renderRequest = {
    schemaVersion: 1,
    project: project2Path,
    output: { video: renderedMp4Path },
    render: { width: 1280, height: 720, frameRate: 30 },
  };
  await writeFile(renderPlanPath, JSON.stringify(renderRequest, null, 2));

  const { stdout: renderOut } = await executeFile(process.execPath, [cliScript, "project.render", renderPlanPath]);
  console.log("project.render (16:9) result:", renderOut);
  const renderResult = JSON.parse(renderOut);
  if (!renderResult.ok) {
    throw new Error(`CLI project.render failed: ${JSON.stringify(renderResult)}`);
  }

  console.log("=== Step 4: Render 9:16 MP4 via CLI project.render ===");
  const renderRequest916 = {
    schemaVersion: 1,
    project: project2Path,
    output: { video: rendered916Mp4Path },
    render: { width: 720, height: 1280, frameRate: 30 },
  };
  await writeFile(renderPlan916Path, JSON.stringify(renderRequest916, null, 2));

  const { stdout: render916Out } = await executeFile(process.execPath, [cliScript, "project.render", renderPlan916Path]);
  console.log("project.render (9:16) result:", render916Out);
  const render916Result = JSON.parse(render916Out);
  if (!render916Result.ok) {
    throw new Error(`CLI project.render 9:16 failed: ${JSON.stringify(render916Result)}`);
  }

  console.log("=== Step 5: Probe final MP4s with FFprobe ===");
  const probeBoth = async (path, label) => {
    const { stdout: probeOut } = await executeFile("ffprobe", [
      "-v", "error",
      "-show_streams",
      "-show_format",
      "-of", "json",
      path,
    ]);
    const probe = JSON.parse(probeOut);
    const videoStream = probe.streams.find((s) => s.codec_type === "video");
    const audioStream = probe.streams.find((s) => s.codec_type === "audio");
    const duration = Number(probe.format?.duration);

    console.log(`\n--- FFprobe Report for ${label} ---`);
    console.log(`Path: ${path}`);
    console.log(`Duration: ${duration.toFixed(3)}s`);
    console.log(`Streams: total=${probe.streams.length}`);
    console.log(`Video: codec=${videoStream?.codec_name}, ${videoStream?.width}x${videoStream?.height}, fps=${videoStream?.r_frame_rate}, frames=${videoStream?.nb_frames}`);
    console.log(`Audio: codec=${audioStream?.codec_name}, rate=${audioStream?.sample_rate}Hz, channels=${audioStream?.channels}`);
    return { probe, videoStream, audioStream, duration };
  };

  const probe169 = await probeBoth(renderedMp4Path, "16:9 Final Render");
  const probe916 = await probeBoth(rendered916Mp4Path, "9:16 Vertical Render");

  // Expected duration: 4.0 + 4.0 + 4.0 - 1.0 (trans 1) - 0.8 (trans 2) = 10.20s
  console.log("\n=== Duration Verification ===");
  console.log(`Expected duration: 10.200s (4.0 + 4.0 + 4.0 - 1.0 - 0.8)`);
  console.log(`Measured 16:9 duration: ${probe169.duration.toFixed(3)}s (delta = ${Math.abs(probe169.duration - 10.2).toFixed(3)}s)`);
  console.log(`Measured 9:16 duration: ${probe916.duration.toFixed(3)}s (delta = ${Math.abs(probe916.duration - 10.2).toFixed(3)}s)`);

  console.log("=== Step 6: Extract QA frames around transitions ===");
  // Transition 1 (fade): starts at 3.0s, ends at 4.0s
  // Transition 2 (wipe-left): starts at 4.0 + 4.0 - 1.0 - 0.8 = 6.2s, ends at 7.0s
  const keyFrames = [
    { time: "1.5", name: "frame-01-clipA-before-trans.png", note: "t=1.5s: Pure Clip A (DNS)" },
    { time: "3.1", name: "frame-02-trans1-fade-start.png", note: "t=3.1s: Transition 1 start (early fade A->B + caption + overlay)" },
    { time: "3.5", name: "frame-03-trans1-fade-mid.png", note: "t=3.5s: Transition 1 mid (50% blend of DNS + TCP, caption, logo)" },
    { time: "3.9", name: "frame-04-trans1-fade-end.png", note: "t=3.9s: Transition 1 end (late fade, TCP predominantly visible)" },
    { time: "4.8", name: "frame-05-clipB-mid.png", note: "t=4.8s: Pure Clip B (TCP/UDP, between transitions)" },
    { time: "6.3", name: "frame-06-trans2-wipe-start.png", note: "t=6.3s: Transition 2 start (wipe-left begins right edge)" },
    { time: "6.6", name: "frame-07-trans2-wipe-mid.png", note: "t=6.6s: Transition 2 mid (wipe-left line in center, sticker, caption)" },
    { time: "6.9", name: "frame-08-trans2-wipe-end.png", note: "t=6.9s: Transition 2 end (wipe-left almost fully revealing HTTPS)" },
    { time: "8.5", name: "frame-09-clipC-after-trans.png", note: "t=8.5s: Pure Clip C (HTTPS, post-transitions)" },
  ];

  for (const kf of keyFrames) {
    const outFramePath = join(artifactsDir, kf.name);
    await executeFile("ffmpeg", [
      "-hide_banner", "-y",
      "-ss", kf.time,
      "-i", renderedMp4Path,
      "-frames:v", "1",
      outFramePath,
    ]);
    console.log(`Extracted ${kf.name} (${kf.note})`);
  }

  // Extract vertical 9:16 frame at mid-transition 1
  const outFrame916 = join(artifactsDir, "frame-10-vertical-916-trans.png");
  await executeFile("ffmpeg", [
    "-hide_banner", "-y",
    "-ss", "3.5",
    "-i", rendered916Mp4Path,
    "-frames:v", "1",
    outFrame916,
  ]);
  console.log(`Extracted frame-10-vertical-916-trans.png (t=3.5s in 9:16 vertical orientation)`);

  console.log("\n=== All E2E Transition Verification Steps Completed Successfully ===");
}

main().catch((err) => {
  console.error("E2E Verification Failed:", err);
  process.exitCode = 1;
});
