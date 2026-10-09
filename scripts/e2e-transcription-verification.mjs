import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";

const exec = promisify(execFile);

const rootDir = process.cwd();
const cliScript = path.join(rootDir, "scripts", "timeline-command.mjs");
const workDir = path.join(rootDir, "test-artifacts", "transcription-e2e");
const realVideo = path.join(rootDir, "test-artifacts", "video-3-https.mp4");
const sampleClip = path.join(workDir, "short-speech-sample.mp4");

async function runCli(args = []) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cliScript, ...args]);
    return { ok: true, code: 0, stdout, stderr };
  } catch (err) {
    return {
      ok: false,
      code: err.code || 1,
      stdout: err.stdout || "",
      stderr: err.stderr || "",
      error: err,
    };
  }
}

async function main() {
  console.log("==================================================================");
  console.log("       E2E Verification: Headless AI Transcription CLI            ");
  console.log("==================================================================");

  await mkdir(workDir, { recursive: true });

  // 1. Prepare short speech sample if needed
  if (!fs.existsSync(sampleClip)) {
    console.log("\n[Setup] Extracting 3.5s speech clip from test-artifacts/video-3-https.mp4...");
    await exec("ffmpeg", [
      "-y",
      "-ss", "0",
      "-t", "3.5",
      "-i", realVideo,
      "-c:v", "copy",
      "-c:a", "copy",
      sampleClip,
    ]);
    console.log("[Setup] Created fixture:", sampleClip);
  }

  // 2. Step 1: CLI Argument Validation & Error Contracts
  console.log("\n=== Step 1: Validating CLI Error Contracts & Argument Handling ===");

  const missingArgs = await runCli(["media.transcribe"]);
  if (missingArgs.code !== 2) {
    throw new Error(`Expected exit code 2 for missing argument, got: ${missingArgs.code}`);
  }
  const missingJson = JSON.parse(missingArgs.stdout);
  if (missingJson.code !== "INVALID_COMMAND") {
    throw new Error(`Expected INVALID_COMMAND, got: ${missingJson.code}`);
  }
  console.log("✔ Missing argument rejected with exit code 2 & INVALID_COMMAND");

  const nonExistent = await runCli(["media.transcribe", "non-existent-file.mp4"]);
  if (nonExistent.code !== 1) {
    throw new Error(`Expected exit code 1 for non-existent file, got: ${nonExistent.code}`);
  }
  const nonExistentJson = JSON.parse(nonExistent.stdout);
  if (nonExistentJson.code !== "FILE_NOT_FOUND") {
    throw new Error(`Expected FILE_NOT_FOUND, got: ${nonExistentJson.code}`);
  }
  console.log("✔ Non-existent file rejected with exit code 1 & FILE_NOT_FOUND");

  const unsupported = await runCli(["media.transcribe", path.join(workDir, "test.txt")]);
  await writeFile(path.join(workDir, "test.txt"), "hello");
  const unsupportedRun = await runCli(["media.transcribe", path.join(workDir, "test.txt")]);
  if (unsupportedRun.code !== 1) {
    throw new Error(`Expected exit code 1 for unsupported media, got: ${unsupportedRun.code}`);
  }
  const unsupportedJson = JSON.parse(unsupportedRun.stdout);
  if (unsupportedJson.code !== "UNSUPPORTED_MEDIA") {
    throw new Error(`Expected UNSUPPORTED_MEDIA, got: ${unsupportedJson.code}`);
  }
  console.log("✔ Unsupported extension rejected with exit code 1 & UNSUPPORTED_MEDIA");

  // Create silent video (no audio stream)
  const silentVideo = path.join(workDir, "silent-test.mp4");
  await exec("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", "color=c=blue:s=320x240:d=1",
    "-c:v", "libx264",
    "-an",
    silentVideo,
  ]);
  const silentRun = await runCli(["media.transcribe", silentVideo]);
  if (silentRun.code !== 1) {
    throw new Error(`Expected exit code 1 for video without audio stream, got: ${silentRun.code}`);
  }
  const silentJson = JSON.parse(silentRun.stdout);
  if (silentJson.code !== "NO_AUDIO_STREAM") {
    throw new Error(`Expected NO_AUDIO_STREAM, got: ${silentJson.code}`);
  }
  console.log("✔ Media with no audio stream rejected with exit code 1 & NO_AUDIO_STREAM");

  // 3. Step 2: File Output & Overwrite Guard
  console.log("\n=== Step 2: Validating Output File Writing & Overwrite Guard ===");

  const dummyOut = path.join(workDir, "test-guard-out.json");
  await writeFile(dummyOut, JSON.stringify({ existing: true }));

  // Try to write to existing file without --force
  const blockedRun = await runCli(["media.transcribe", sampleClip, "--out", dummyOut]);
  if (blockedRun.code !== 1) {
    throw new Error(`Expected exit code 1 when output file exists, got: ${blockedRun.code}`);
  }
  const blockedJson = JSON.parse(blockedRun.stdout);
  if (blockedJson.code !== "OUTPUT_EXISTS") {
    throw new Error(`Expected OUTPUT_EXISTS, got: ${blockedJson.code}`);
  }
  console.log("✔ Overwrite guard correctly blocked existing file with OUTPUT_EXISTS");

  // 4. Step 3: Human Summary vs JSON Output Mode
  console.log("\n=== Step 3: Validating Output Formatting (Summary vs JSON) ===");

  // Test formatting unit function verification
  const { formatHumanTranscriptSummary } = await import("../src/lib/headlessTranscription.js");
  const testPayload = {
    media: sampleClip,
    duration: 3.5,
    language: "en",
    model: "onnx-community/whisper-small_timestamped",
    text: "Question: What does HTTPS protect?",
    words: [
      { text: "Question:", start: 0.5, end: 1.1 },
      { text: "What", start: 1.2, end: 1.5 },
      { text: "does", start: 1.6, end: 1.8 },
      { text: "HTTPS", start: 1.9, end: 2.3 },
      { text: "protect?", start: 2.4, end: 3.1 },
    ],
    segments: [
      { text: "Question: What does HTTPS protect?", start: 0.5, end: 3.1 },
    ],
  };
  const formattedSummary = formatHumanTranscriptSummary(testPayload);
  if (!formattedSummary.includes("=== Media Transcription Summary ===") ||
      !formattedSummary.includes("Question: What does HTTPS protect?") ||
      !formattedSummary.includes("[00:00.50 -> 00:03.10]")) {
    throw new Error("Human summary formatting failed validation");
  }
  console.log("✔ Formatted human summary verified successfully");

  // 5. Step 4: Real Local Whisper Inference Execution (Opt-in)
  console.log("\n=== Step 4: Real Local Whisper Inference Execution ===");

  const optIn = process.argv.includes("--run-real-inference") ||
                process.argv.includes("--download-model") ||
                process.env.ENABLE_REAL_WHISPER_E2E === "1";

  if (!optIn) {
    console.log("ℹ [OPT-IN NOTICE] Real local Whisper inference test was skipped by default.");
    console.log("  To run real model inference and download local ONNX weights if needed, invoke with:");
    console.log("    node scripts/e2e-transcription-verification.mjs --run-real-inference");
    console.log("    (or set ENABLE_REAL_WHISPER_E2E=1)");
    console.log("\n✔ ALL PRE-FLIGHT E2E CLI CONTRACTS & WORKFLOWS VERIFIED SUCCESSFULLY!");
    return;
  }

  console.log("Opt-in active. Executing actual local Whisper model inference on:", sampleClip);
  const realOutFile = path.join(workDir, "real-inference-result.json");

  const realRun = await runCli([
    "media.transcribe",
    sampleClip,
    "--out", realOutFile,
    "--force",
    "--verbose",
  ]);

  if (!realRun.ok) {
    console.error("Real inference failed. Stderr:", realRun.stderr);
    console.error("Stdout:", realRun.stdout);
    throw new Error(`Real Whisper inference failed with code ${realRun.code}`);
  }

  if (!fs.existsSync(realOutFile)) {
    throw new Error(`Real inference output file was not created at: ${realOutFile}`);
  }

  const result = JSON.parse(await readFile(realOutFile, "utf8"));
  console.log("\n--- Real Inference Verification Results ---");
  console.log("Status: OK =", result.ok);
  console.log("Detected Language:", result.language);
  console.log("Model Used:", result.model);
  console.log("Duration:", result.duration, "s");
  console.log("Total Words Transcribed:", result.words?.length);
  console.log("Total Caption Segments:", result.segments?.length);
  console.log("Full Transcript Text:\n", `"${result.text}"`);

  if (!result.text || typeof result.text !== "string" || !result.text.trim()) {
    throw new Error("Real inference returned empty transcript text");
  }

  if (!Array.isArray(result.words) || result.words.length === 0) {
    throw new Error("Real inference returned no timestamped words");
  }

  for (const word of result.words) {
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end) || word.end < word.start) {
      throw new Error(`Invalid timestamp in real inference word: ${JSON.stringify(word)}`);
    }
  }

  if (!Array.isArray(result.segments) || result.segments.length === 0) {
    throw new Error("Real inference returned no grouped caption segments");
  }

  console.log("\nCaption Segments Generated from Speech:");
  for (const seg of result.segments) {
    console.log(`  [${seg.start.toFixed(2)}s -> ${seg.end.toFixed(2)}s]: ${seg.text}`);
  }

  console.log("\n✔ REAL LOCAL WHISPER INFERENCE VERIFIED AND PASSED SUCCESSFULLY!");
}

main().catch((err) => {
  console.error("\n❌ E2E TRANSCRIPTION VERIFICATION FAILED:", err);
  process.exit(1);
});
