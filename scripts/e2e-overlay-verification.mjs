import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { strToU8, zipSync } from "fflate";

const executeFile = promisify(execFile);

async function main() {
  const artifactsDir = resolve(process.cwd(), "test-artifacts", "overlay-e2e");
  await rm(artifactsDir, { recursive: true, force: true });
  await mkdir(artifactsDir, { recursive: true });

  const realVideoPath = resolve(process.cwd(), "test-artifacts", "video-3-https.mp4");
  const logoPath = resolve(process.cwd(), "public", "icons", "timeline-studio-icon-192.png");
  const stickerPath = resolve(process.cwd(), "public", "assets", "stickers", "trend-verified.png");
  const project1Path = join(artifactsDir, "01-initial.timeline");
  const project2Path = join(artifactsDir, "02-with-overlays.timeline");
  const renderPlanPath = join(artifactsDir, "render-request.json");
  const renderedMp4Path = join(artifactsDir, "e2e-final-rendered.mp4");

  console.log("=== Step 1: Initialize base .timeline archive ===");
  const videoBytes = await readFile(realVideoPath);

  // Initial base timeline
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
            id: "vis-base",
            type: "video",
            duration: 10.0,
            sourceStart: 0,
            playbackRate: 1,
            volume: 1.0,
          },
        ],
      },
      media: {
        visuals: [
          { id: "vis-base", path: "media/visuals/base.mp4" },
        ],
      },
    })),
    "media/visuals/base.mp4": new Uint8Array(videoBytes),
  };
  await writeFile(project1Path, zipSync(initialArchive, { level: 6 }));
  console.log("Created base timeline:", project1Path);

  console.log("=== Step 2: Use CLI commands to import assets and add overlays/stickers/captions ===");
  const cliScript = resolve(process.cwd(), "scripts", "timeline-command.mjs");

  // Plan containing CLI operations:
  // 1. asset.import: logo PNG
  // 2. asset.import: sticker PNG
  // 3. overlay.add: overlay A (logo) at start=1.5, duration=4.0
  // 4. overlay.set_transform: overlay A transform (x=30, y=-20, scale=0.35, rotation=15, opacity=0.9)
  // 5. overlay.add: overlay B (sticker) at start=4.0, duration=3.0 (overlaps with overlay A at 4.0-5.5)
  // 6. overlay.set_transform: overlay B transform (x=-30, y=20, scale=0.5, rotation=0, opacity=1.0)
  // 7. overlay.add: overlay C (logo large) at start=7.2, duration=2.0
  // 8. overlay.set_transform: overlay C transform (x=0, y=0, scale=0.75, rotation=0, opacity=0.85)
  // 9. caption.create: caption at start=5.0, duration=2.5
  const editPlanPath = join(artifactsDir, "cli-edit-plan.json");
  const editPlan = {
    schemaVersion: 1,
    baseRevision: 0,
    project: project1Path,
    output: { project: project2Path },
    operations: [
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
        start: 1.0,
        duration: 3.5,
        layer: 1,
      },
      {
        id: "transform-ov-1",
        type: "overlay.set_transform",
        clipId: "ov-clip-1",
        transform: { x: 30, y: -20, scale: 0.35, rotation: 15, opacity: 0.9 },
      },
      {
        id: "move-ov-1",
        type: "timed.move",
        track: "overlays",
        clipId: "ov-clip-1",
        start: 1.5,
      },
      {
        id: "resize-ov-1",
        type: "timed.resize",
        track: "overlays",
        clipId: "ov-clip-1",
        duration: 4.0,
      },
      {
        id: "add-ov-2",
        type: "overlay.add",
        clipId: "ov-clip-2",
        sourceClipId: "clip-sticker",
        start: 4.0,
        duration: 3.0,
        layer: 2,
        transform: { x: -30, y: 20, scale: 0.5, rotation: 0, opacity: 1.0 },
      },
      {
        id: "add-ov-3",
        type: "overlay.add",
        clipId: "ov-clip-3",
        sourceClipId: "clip-logo",
        start: 7.2,
        duration: 2.0,
        layer: 3,
        transform: { x: 0, y: 0, scale: 0.75, rotation: 0, opacity: 0.85 },
      },
      {
        id: "add-caption",
        type: "caption.add",
        clipId: "cap-clip-1",
        text: "Verified Security Badge Active",
        start: 4.5,
        end: 7.0,
      },
    ],
  };

  await writeFile(editPlanPath, JSON.stringify(editPlan, null, 2));
  const { stdout: editOutput } = await executeFile(process.execPath, [cliScript, "project.run", editPlanPath]);
  console.log("project.run result:", editOutput);

  console.log("=== Step 3: Render MP4 using timeline-command.mjs project.render ===");
  const renderRequest = {
    schemaVersion: 1,
    project: project2Path,
    output: { video: renderedMp4Path },
    render: { preset: "medium", crf: 18 },
  };
  await writeFile(renderPlanPath, JSON.stringify(renderRequest, null, 2));

  const { stdout: renderOutput } = await executeFile(process.execPath, [cliScript, "project.render", renderPlanPath]);
  console.log("project.render result:", renderOutput);

  console.log("=== Step 4: Run FFprobe on rendered MP4 ===");
  const { stdout: probeOutput } = await executeFile("ffprobe", [
    "-v", "error",
    "-show_streams",
    "-show_format",
    "-of", "json",
    renderedMp4Path,
  ]);
  const probeData = JSON.parse(probeOutput);
  const videoStream = probeData.streams.find((s) => s.codec_type === "video");
  const audioStream = probeData.streams.find((s) => s.codec_type === "audio");

  console.log("\n--- FFprobe Verification ---");
  console.log("Path:", renderedMp4Path);
  console.log("Duration:", probeData.format.duration, "seconds");
  console.log("Resolution:", `${videoStream?.width}x${videoStream?.height}`);
  console.log("Video Codec:", videoStream?.codec_name);
  console.log("Video FPS:", videoStream?.r_frame_rate);
  console.log("Audio Codec:", audioStream?.codec_name);
  console.log("Audio Sample Rate:", audioStream?.sample_rate);
  console.log("Stream Count:", probeData.streams.length);

  console.log("\n=== Step 5: Extract Frames for Visual QA ===");
  const frames = [
    { time: "0.8", name: "frame-01-before-overlays.png", label: "t=0.8s: Base video only, no overlays" },
    { time: "2.5", name: "frame-02-overlay-a-active.png", label: "t=2.5s: Overlay A (rotated logo) active" },
    { time: "4.8", name: "frame-03-simultaneous-overlays-plus-caption.png", label: "t=4.8s: Overlay A + Overlay B + Caption simultaneous" },
    { time: "6.2", name: "frame-04-overlay-b-active.png", label: "t=6.2s: Overlay B (verified badge) alone after A ended" },
    { time: "8.0", name: "frame-05-overlay-c-large.png", label: "t=8.0s: Overlay C (large centered logo 75% scale)" },
    { time: "9.6", name: "frame-06-after-overlays.png", label: "t=9.6s: After all overlays ended" },
  ];

  for (const f of frames) {
    const framePath = join(artifactsDir, f.name);
    await executeFile("ffmpeg", [
      "-hide_banner", "-y",
      "-ss", f.time,
      "-i", renderedMp4Path,
      "-frames:v", "1",
      framePath,
    ]);
    console.log(`Extracted: ${f.name} (${f.label})`);
  }

  console.log("\n=== Step 6: 9:16 Aspect Ratio Test ===");
  const project916Path = join(artifactsDir, "03-vertical-916.timeline");
  const rendered916Path = join(artifactsDir, "e2e-final-rendered-916.mp4");
  const renderPlan916Path = join(artifactsDir, "render-request-916.json");

  // Modify ratio to 9:16
  const p2Bytes = await readFile(project2Path);
  const { unzipSync } = await import("fflate");
  const unzipped = unzipSync(new Uint8Array(p2Bytes));
  const projectJson = JSON.parse(new TextDecoder().decode(unzipped["project.json"]));
  projectJson.project.ratioId = "9:16";
  unzipped["project.json"] = strToU8(JSON.stringify(projectJson));
  await writeFile(project916Path, zipSync(unzipped, { level: 6 }));

  await writeFile(renderPlan916Path, JSON.stringify({
    schemaVersion: 1,
    project: project916Path,
    output: { video: rendered916Path },
    render: { preset: "medium", crf: 18 },
  }, null, 2));

  await executeFile(process.execPath, [cliScript, "project.render", renderPlan916Path]);
  const { stdout: probe916Out } = await executeFile("ffprobe", [
    "-v", "error",
    "-show_streams",
    "-show_format",
    "-of", "json",
    rendered916Path,
  ]);
  const p916Data = JSON.parse(probe916Out);
  const v916Stream = p916Data.streams.find((s) => s.codec_type === "video");
  console.log("9:16 Render Resolution:", `${v916Stream?.width}x${v916Stream?.height}`);

  const frame916Path = join(artifactsDir, "frame-07-vertical-916.png");
  await executeFile("ffmpeg", [
    "-hide_banner", "-y",
    "-ss", "4.8",
    "-i", rendered916Path,
    "-frames:v", "1",
    frame916Path,
  ]);
  console.log("Extracted: frame-07-vertical-916.png");

  console.log("\nE2E VERIFICATION FINISHED SUCCESSFULLY!");
}

main().catch((err) => {
  console.error("E2E FAILED:", err);
  process.exitCode = 1;
});
