import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, unlink } from "node:fs/promises";
import path from "node:path";

const exec = promisify(execFile);

const rootDir = process.cwd();
const cliScript = path.join(rootDir, "scripts", "timeline-command.mjs");
const workDir = path.join(rootDir, "test-artifacts", "caption-e2e");
const realVideo = path.join(rootDir, "test-artifacts", "video-3-https.mp4");

async function runCliCommand(command, arg) {
  const { stdout } = await exec(process.execPath, [cliScript, command, arg]);
  return JSON.parse(stdout);
}

async function main() {
  const filesToClean = [
    "step1-imported.timeline",
    "step2-trimmed.timeline",
    "step3-captions.timeline",
    "step4-styled.timeline",
    "final-caption-9-16.mp4",
    "final-caption-16-9.mp4",
  ];
  for (const f of filesToClean) {
    try {
      await unlink(path.join(workDir, f));
    } catch (e) {
      void e;
    }
  }

  console.log("=== 1. IMPORTING REAL VIDEO ===");
  const plan1 = {
    schemaVersion: 1,
    project: path.join(workDir, "base.timeline"),
    baseRevision: 0,
    dryRun: false,
    operations: [
      {
        id: "op-import-video",
        type: "asset.import",
        track: "visuals",
        clipId: "video-1",
        file: realVideo,
      },
      {
        id: "op-set-ratio",
        type: "project.set_ratio",
        ratio: "9:16",
      },
    ],
    output: {
      project: path.join(workDir, "step1-imported.timeline"),
    },
  };
  const plan1Path = path.join(workDir, "plan1-import.json");
  await writeFile(plan1Path, JSON.stringify(plan1, null, 2));
  const res1 = await runCliCommand("project.run", plan1Path);
  console.log("Step 1 result:", res1.ok, "rev:", res1.appliedOperationIds);

  console.log("=== 2. TRIMMING VIDEO TO 9 SECONDS ===");
  const plan2 = {
    schemaVersion: 1,
    project: path.join(workDir, "step1-imported.timeline"),
    baseRevision: 1,
    dryRun: false,
    operations: [
      {
        id: "op-trim-video",
        type: "visual.trim",
        clipId: "video-1",
        sourceIn: 0,
        sourceOut: 9,
      },
    ],
    output: {
      project: path.join(workDir, "step2-trimmed.timeline"),
    },
  };
  const plan2Path = path.join(workDir, "plan2-trim.json");
  await writeFile(plan2Path, JSON.stringify(plan2, null, 2));
  const res2 = await runCliCommand("project.run", plan2Path);
  console.log("Step 2 result:", res2.ok, "rev:", res2.appliedOperationIds);

  console.log("=== 3. ADDING MULTIPLE CAPTIONS VIA CLI ===");
  const plan3 = {
    schemaVersion: 1,
    project: path.join(workDir, "step2-trimmed.timeline"),
    baseRevision: 2,
    dryRun: false,
    operations: [
      {
        id: "op-add-cap-1",
        type: "caption.add",
        clipId: "cap-1",
        text: "Question: What does HTTPS protect?",
        start: 0.5,
        end: 3.5,
      },
      {
        id: "op-add-cap-2",
        type: "caption.add",
        clipId: "cap-2",
        text: "Don't share your password!",
        start: 3.5,
        end: 6.5,
      },
      {
        id: "op-add-cap-3",
        type: "caption.add",
        clipId: "cap-3",
        text: "Answer: Data in transit",
        start: 6.5,
        end: 8.5,
      },
    ],
    output: {
      project: path.join(workDir, "step3-captions.timeline"),
    },
  };
  const plan3Path = path.join(workDir, "plan3-captions.json");
  await writeFile(plan3Path, JSON.stringify(plan3, null, 2));
  const res3 = await runCliCommand("project.run", plan3Path);
  console.log("Step 3 result:", res3.ok, "rev:", res3.appliedOperationIds);

  console.log("=== 4. STYLING & POSITIONING CAPTIONS VIA CLI ===");
  const plan4 = {
    schemaVersion: 1,
    project: path.join(workDir, "step3-captions.timeline"),
    baseRevision: 3,
    dryRun: false,
    operations: [
      {
        id: "op-set-default-style",
        type: "caption.set_style",
        scope: "default",
        style: {
          captionSize: 13,
          textColor: "#ffffff",
          backgroundColor: "#05080d",
          backgroundOpacity: 0.75,
          textStrokeWidth: 2,
          textStrokeColor: "#000000",
        },
      },
      {
        id: "op-set-cap2-position",
        type: "caption.set_position",
        scope: "current",
        clipId: "cap-2",
        placement: { x: 50, y: 50 }, // Middle / center
      },
      {
        id: "op-set-cap1-position",
        type: "caption.set_position",
        scope: "current",
        clipId: "cap-1",
        placement: { x: 50, y: 22 }, // Top
      },
      {
        id: "op-set-cap3-style",
        type: "caption.set_style",
        scope: "current",
        clipId: "cap-3",
        style: {
          textColor: "#38ef7d", // Green highlight for answer
        },
      },
    ],
    output: {
      project: path.join(workDir, "step4-styled.timeline"),
    },
  };
  const plan4Path = path.join(workDir, "plan4-style.json");
  await writeFile(plan4Path, JSON.stringify(plan4, null, 2));
  const res4 = await runCliCommand("project.run", plan4Path);
  console.log("Step 4 result:", res4.ok, "rev:", res4.appliedOperationIds);

  console.log("=== 5. RENDERING 9:16 PROJECT THROUGH CLI ===");
  const renderPlan = {
    schemaVersion: 1,
    project: path.join(workDir, "step4-styled.timeline"),
    output: {
      video: path.join(workDir, "final-caption-9-16.mp4"),
    },
    render: {
      width: 720,
      height: 1280,
      frameRate: 30,
      preset: "ultrafast",
    },
  };
  const renderPlanPath = path.join(workDir, "render-plan-9-16.json");
  await writeFile(renderPlanPath, JSON.stringify(renderPlan, null, 2));
  const renderRes = await runCliCommand("project.render", renderPlanPath);
  console.log("Render Result:", renderRes);

  console.log("=== 6. FFPROBE INSPECTION OF RENDERED MP4 ===");
  const { stdout: probeOut } = await exec("ffprobe", [
    "-v", "error",
    "-show_format",
    "-show_streams",
    "-count_frames",
    "-of", "json",
    path.join(workDir, "final-caption-9-16.mp4"),
  ]);
  const probeData = JSON.parse(probeOut);
  const vStream = probeData.streams.find((s) => s.codec_type === "video");
  const aStream = probeData.streams.find((s) => s.codec_type === "audio");

  console.log("FFPROBE METRICS:");
  console.log("- Duration:", probeData.format.duration, "s");
  console.log("- Resolution:", `${vStream.width}x${vStream.height}`);
  console.log("- FPS:", vStream.r_frame_rate);
  console.log("- Video Codec:", vStream.codec_name);
  console.log("- Audio Codec:", aStream?.codec_name);
  console.log("- Audio Sample Rate:", aStream?.sample_rate);
  console.log("- Audio Channels:", aStream?.channels);
  console.log("- Total Streams:", probeData.streams.length);
  console.log("- Video Frames:", vStream.nb_read_frames || vStream.nb_frames);

  console.log("=== 7. EXTRACTING QA FRAMES ===");
  const frames = [
    { time: "0.2", label: "01_before_caption" },
    { time: "1.5", label: "02_caption1_top_active" },
    { time: "4.5", label: "03_caption2_center_active" },
    { time: "7.2", label: "04_caption3_answer_green_active" },
    { time: "8.7", label: "05_after_caption_disappears" },
  ];

  for (const f of frames) {
    const framePath = path.join(workDir, `qa_${f.label}.png`);
    await exec("ffmpeg", [
      "-hide_banner", "-y",
      "-ss", f.time,
      "-i", path.join(workDir, "final-caption-9-16.mp4"),
      "-vframes", "1",
      framePath,
    ]);
    console.log(`Extracted frame at t=${f.time}s -> ${framePath}`);
  }

  console.log("=== 8. CREATING AND RENDERING 16:9 TEST PROJECT ===");
  // Also render a 16:9 version to verify landscape
  const renderPlan169 = {
    schemaVersion: 1,
    project: path.join(workDir, "step4-styled.timeline"),
    output: {
      video: path.join(workDir, "final-caption-16-9.mp4"),
    },
    render: {
      width: 1280,
      height: 720,
      frameRate: 30,
      preset: "ultrafast",
    },
  };
  const renderPlan169Path = path.join(workDir, "render-plan-16-9.json");
  await writeFile(renderPlan169Path, JSON.stringify(renderPlan169, null, 2));
  const renderRes169 = await runCliCommand("project.render", renderPlan169Path);
  console.log("16:9 Render Result:", renderRes169.ok, renderRes169.verification);

  const frame169Path = path.join(workDir, "qa_16_9_caption.png");
  await exec("ffmpeg", [
    "-hide_banner", "-y",
    "-ss", "1.5",
    "-i", path.join(workDir, "final-caption-16-9.mp4"),
    "-vframes", "1",
    frame169Path,
  ]);
  console.log("Extracted 16:9 QA frame ->", frame169Path);
  console.log("ALL E2E WORKFLOWS COMPLETED SUCCESSFULLY!");
}

main().catch((err) => {
  console.error("E2E FAILED:", err);
  process.exit(1);
});
