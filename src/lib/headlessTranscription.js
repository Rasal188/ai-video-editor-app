import fs from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AUTOMATIC_CAPTION_MODEL_ID, AUTOMATIC_CAPTION_MODEL_REVISION } from "../config/models.js";
import { captionSegmentsFromWords } from "./captionSegmentation.js";

const executeFile = promisify(execFile);

export const SUPPORTED_MEDIA_EXTENSIONS = Object.freeze(new Set([
  ".mp4", ".webm", ".mov", ".mkv", ".avi",
  ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".opus",
]));

export function transcriptionError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

/**
 * Extracts 16kHz mono Float32 PCM audio from any supported video or audio container using FFmpeg.
 * Ensures the temporary audio file is deleted under all circumstances (success, failure, or cancellation).
 */
export async function extractAudioFromMedia(filePath, { signal } = {}) {
  if (signal?.aborted) {
    throw transcriptionError("TRANSCRIPTION_CANCELED", "Audio extraction cancelled before starting");
  }

  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw transcriptionError("FILE_NOT_FOUND", `Media file not found: ${filePath}`);
  }

  // 1. Probe media streams using ffprobe to confirm presence of an audio stream
  let probeOutput;
  try {
    const { stdout } = await executeFile("ffprobe", [
      "-v", "error",
      "-show_entries", "stream=codec_type",
      "-of", "json",
      resolved,
    ], { signal });
    probeOutput = JSON.parse(stdout);
  } catch (err) {
    if (signal?.aborted || err?.name === "AbortError") {
      throw transcriptionError("TRANSCRIPTION_CANCELED", "Audio probe was cancelled", err);
    }
    if (err?.code === "ENOENT") {
      throw transcriptionError("FFMPEG_MISSING", "ffprobe executable was not found on system PATH", err);
    }
    throw transcriptionError("CORRUPT_MEDIA", `Failed to probe media file: ${err.message}`, err);
  }

  const streams = probeOutput?.streams || [];
  const hasAudio = streams.some((s) => s.codec_type === "audio");
  if (!hasAudio) {
    throw transcriptionError("NO_AUDIO_STREAM", `Media file contains no audio stream: ${path.basename(resolved)}`);
  }

  // 2. Extract audio to raw 16kHz mono Float32LE PCM
  const tempPath = path.join(tmpdir(), `transcribe-audio-${randomUUID()}.f32`);

  try {
    await executeFile("ffmpeg", [
      "-hide_banner",
      "-y",
      "-i", resolved,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-f", "f32le",
      tempPath,
    ], { signal });

    const buffer = await readFile(tempPath);
    if (!buffer.length || buffer.length < 4) {
      throw transcriptionError("EMPTY_AUDIO", "Extracted audio stream is empty");
    }

    const audio = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4));
    const duration = audio.length / 16000;
    if (duration <= 0) {
      throw transcriptionError("EMPTY_AUDIO", "Extracted audio duration is zero");
    }

    return { audio, duration };
  } catch (err) {
    if (signal?.aborted || err?.name === "AbortError") {
      throw transcriptionError("TRANSCRIPTION_CANCELED", "Audio extraction was cancelled", err);
    }
    if (err?.code === "ENOENT") {
      throw transcriptionError("FFMPEG_MISSING", "ffmpeg executable was not found on system PATH", err);
    }
    if (err.code && err.code !== "EMPTY_AUDIO") {
      throw err;
    }
    throw transcriptionError("FFMPEG_FAILED", `FFmpeg audio extraction failed: ${err.message}`, err);
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

/**
 * Validates word-level timestamps and normalizes recognizer output into structured words and caption segments.
 */
export function normalizeTranscriptOutput(rawOutput, duration, {
  timelineOffset = 0,
  grouping = "phrases",
  language = "unknown",
} = {}) {
  const chunks = Array.isArray(rawOutput?.chunks) ? rawOutput.chunks : [];

  // Validate timestamps
  for (const chunk of chunks) {
    if (!chunk || !Array.isArray(chunk.timestamp)) {
      continue;
    }
    const [start, end] = chunk.timestamp;
    if (start !== null && start !== undefined) {
      const s = Number(start);
      if (!Number.isFinite(s) || s < 0) {
        throw transcriptionError("INVALID_TIMESTAMPS", `Invalid non-finite start timestamp: ${start}`);
      }
    }
    if (end !== null && end !== undefined) {
      const e = Number(end);
      if (!Number.isFinite(e) || e < 0) {
        throw transcriptionError("INVALID_TIMESTAMPS", `Invalid non-finite end timestamp: ${end}`);
      }
    }
    if (start != null && end != null && Number(end) < Number(start)) {
      throw transcriptionError("INVALID_TIMESTAMPS", `Inverted timestamp interval: start=${start}, end=${end}`);
    }
  }

  const validChunks = chunks.filter((c) => String(c?.text ?? "").trim());
  let segments = [];

  if (validChunks.length && duration > 0) {
    try {
      segments = captionSegmentsFromWords(validChunks, duration, {
        timelineOffset,
        grouping,
      });
    } catch (err) {
      if (err.message === "ASR_WORD_TIMING_UNAVAILABLE") {
        throw transcriptionError("INVALID_TIMESTAMPS", "Word-level timing alignment is unavailable or invalid", err);
      }
      throw err;
    }
  }

  const words = validChunks.map((chunk) => {
    const rawStart = Number(chunk.timestamp?.[0]);
    const rawEnd = Number(chunk.timestamp?.[1]);
    return {
      text: String(chunk.text || "").trim(),
      start: Number.isFinite(rawStart) ? rawStart + timelineOffset : timelineOffset,
      end: Number.isFinite(rawEnd) ? rawEnd + timelineOffset : timelineOffset,
    };
  });

  const fullText = segments.map((s) => s.text).join("\n") || String(rawOutput?.text || "").trim();

  return {
    ok: true,
    text: fullText,
    words,
    segments,
    language: language || rawOutput?.language || "unknown",
    duration,
    sampleRate: 16000,
  };
}

let activeTranscriberPromise = null;
let cachedTranscriber = null;
let cachedModelKey = null;

/**
 * Thread-safe singleton model loader for headless Node.js Whisper inference.
 * Reuses model cache across calls and prevents parallel duplicate downloads.
 */
export async function getHeadlessTranscriber({
  modelId = AUTOMATIC_CAPTION_MODEL_ID,
  revision = AUTOMATIC_CAPTION_MODEL_REVISION,
  onProgress,
  signal,
} = {}) {
  const key = `${modelId}@${revision || "default"}`;
  if (cachedTranscriber && cachedModelKey === key) {
    return cachedTranscriber;
  }

  if (activeTranscriberPromise) {
    await activeTranscriberPromise;
    if (cachedTranscriber && cachedModelKey === key) {
      return cachedTranscriber;
    }
  }

  if (signal?.aborted) {
    throw transcriptionError("TRANSCRIPTION_CANCELED", "Model loading cancelled before starting");
  }

  activeTranscriberPromise = (async () => {
    try {
      const { pipeline } = await import("@huggingface/transformers");
      const transcriber = await pipeline("automatic-speech-recognition", modelId, {
        dtype: "q8",
        revision,
        progress_callback: (info) => {
          if (onProgress && info?.progress) {
            onProgress({
              progress: Math.min(30, Math.round(Number(info.progress) * 0.3)),
              phase: "downloading_model",
            });
          }
        },
      });
      cachedTranscriber = transcriber;
      cachedModelKey = key;
      return transcriber;
    } catch (err) {
      if (signal?.aborted || err?.name === "AbortError") {
        throw transcriptionError("TRANSCRIPTION_CANCELED", "Model loading was cancelled", err);
      }
      throw transcriptionError("MODEL_LOAD_FAILED", `Failed to load transcription model ${modelId}: ${err.message}`, err);
    } finally {
      activeTranscriberPromise = null;
    }
  })();

  return activeTranscriberPromise;
}

/**
 * Resets the in-memory transcriber cache.
 */
export function resetHeadlessTranscriber() {
  cachedTranscriber = null;
  cachedModelKey = null;
  activeTranscriberPromise = null;
}

/**
 * Public API for headless Node.js transcription.
 *
 * @param {string} filePath - Absolute or relative path to media file
 * @param {Object} [options] - Options
 * @param {string} [options.language] - Language code (e.g., 'en', 'zh', 'es')
 * @param {string} [options.modelId] - Whisper model identifier (defaults to whisper-small_timestamped)
 * @param {string} [options.revision] - Pinned model revision
 * @param {Function} [options.onProgress] - Callback for progress events { progress, phase }
 * @param {AbortSignal} [options.signal] - AbortSignal for cancellation
 * @param {string} [options.grouping] - Caption grouping ('phrases' | 'words')
 * @param {number} [options.timelineOffset] - Offset in seconds to add to caption timestamps
 * @param {Function} [options.pipelineFactory] - Optional factory for injecting mock transcriber in unit tests
 * @returns {Promise<{ ok: boolean, text: string, words: Array, segments: Array, language: string, duration: number, sampleRate: number }>}
 */
export async function transcribeMedia(filePath, options = {}) {
  if (!filePath || typeof filePath !== "string") {
    throw transcriptionError("INVALID_ARGUMENT", "Media file path must be a non-empty string");
  }

  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw transcriptionError("FILE_NOT_FOUND", `Media file not found: ${filePath}`);
  }

  const ext = path.extname(resolved).toLowerCase();
  if (!SUPPORTED_MEDIA_EXTENSIONS.has(ext)) {
    throw transcriptionError("UNSUPPORTED_MEDIA", `Unsupported media file extension: ${ext || "none"}`);
  }

  if (options.signal?.aborted) {
    throw transcriptionError("TRANSCRIPTION_CANCELED", "Transcription was cancelled before starting");
  }

  // 1. Audio Extraction
  options.onProgress?.({ progress: 10, phase: "extracting_audio" });
  const { audio, duration } = await extractAudioFromMedia(resolved, { signal: options.signal });

  if (options.signal?.aborted) {
    throw transcriptionError("TRANSCRIPTION_CANCELED", "Transcription was cancelled after audio extraction");
  }

  // 2. Transcriber Acquisition
  options.onProgress?.({ progress: 30, phase: "loading_model" });
  const modelId = options.modelId || AUTOMATIC_CAPTION_MODEL_ID;
  const revision = options.revision || AUTOMATIC_CAPTION_MODEL_REVISION;

  const transcriber = options.pipelineFactory
    ? await options.pipelineFactory({ modelId, revision, onProgress: options.onProgress, signal: options.signal })
    : await getHeadlessTranscriber({ modelId, revision, onProgress: options.onProgress, signal: options.signal });

  if (options.signal?.aborted) {
    throw transcriptionError("TRANSCRIPTION_CANCELED", "Transcription was cancelled before inference");
  }

  // 3. Inference
  options.onProgress?.({ progress: 50, phase: "transcribing" });

  const transcriptionOptions = {
    chunk_length_s: 25,
    max_new_tokens: 224,
    stride_length_s: 4,
    return_timestamps: "word",
    condition_on_previous_text: false,
  };
  if (options.language) {
    transcriptionOptions.language = options.language;
    transcriptionOptions.task = "transcribe";
  }

  let rawOutput;
  try {
    rawOutput = await transcriber(audio, transcriptionOptions);
  } catch (err) {
    if (options.signal?.aborted || err?.name === "AbortError") {
      throw transcriptionError("TRANSCRIPTION_CANCELED", "Transcription was cancelled during inference", err);
    }
    throw transcriptionError("INFERENCE_FAILED", `Transcription inference failed: ${err.message}`, err);
  }

  if (options.signal?.aborted) {
    throw transcriptionError("TRANSCRIPTION_CANCELED", "Transcription was cancelled after inference");
  }

  // 4. Normalization and Caption Segmentation
  options.onProgress?.({ progress: 85, phase: "segmenting_captions" });
  const normalized = normalizeTranscriptOutput(rawOutput, duration, {
    timelineOffset: options.timelineOffset || 0,
    grouping: options.grouping || "phrases",
    language: options.language,
  });

  options.onProgress?.({ progress: 100, phase: "complete" });
  return {
    ...normalized,
    model: modelId,
  };
}

/**
 * Parses CLI arguments for media transcription.
 *
 * @param {string[]} args - Arguments passed after the command name
 * @returns {{ mediaFile: string, options: { output: string|null, overwrite: boolean, language: string|null, modelId: string|null, timelineOffset: number, grouping: string, format: string, quiet: boolean, verbose: boolean } }}
 */
export function parseTranscribeArgs(args = []) {
  let mediaFile = null;
  const options = {
    output: null,
    overwrite: false,
    language: null,
    modelId: null,
    timelineOffset: 0,
    grouping: "phrases",
    format: "json", // "json" | "summary"
    quiet: false,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-o" || arg === "--out" || arg === "--output") {
      const val = args[++i];
      if (!val || val.startsWith("-")) {
        const err = transcriptionError("INVALID_ARGUMENT", "Option --out requires a file path argument");
        err.exitCode = 2;
        throw err;
      }
      options.output = val;
    } else if (arg === "-f" || arg === "--force" || arg === "--overwrite") {
      options.overwrite = true;
    } else if (arg === "-l" || arg === "--language") {
      const val = args[++i];
      if (!val || val.startsWith("-")) {
        const err = transcriptionError("INVALID_ARGUMENT", "Option --language requires a language code argument");
        err.exitCode = 2;
        throw err;
      }
      options.language = val;
    } else if (arg === "-m" || arg === "--model") {
      const val = args[++i];
      if (!val || val.startsWith("-")) {
        const err = transcriptionError("INVALID_ARGUMENT", "Option --model requires a model ID argument");
        err.exitCode = 2;
        throw err;
      }
      options.modelId = val;
    } else if (arg === "--timeline-offset" || arg === "--offset") {
      const val = args[++i];
      const parsed = Number(val);
      if (!Number.isFinite(parsed)) {
        const err = transcriptionError("INVALID_ARGUMENT", `Option --timeline-offset must be a valid number, got: ${val}`);
        err.exitCode = 2;
        throw err;
      }
      options.timelineOffset = parsed;
    } else if (arg === "--grouping") {
      const val = args[++i];
      if (val !== "phrases" && val !== "words" && val !== "smart" && val !== "word") {
        const err = transcriptionError("INVALID_ARGUMENT", `Option --grouping must be 'phrases' or 'words', got: ${val}`);
        err.exitCode = 2;
        throw err;
      }
      options.grouping = val === "word" ? "words" : val === "smart" ? "phrases" : val;
    } else if (arg === "--human" || arg === "--summary") {
      options.format = "summary";
    } else if (arg === "--json") {
      options.format = "json";
    } else if (arg === "-q" || arg === "--quiet") {
      options.quiet = true;
    } else if (arg === "-v" || arg === "--verbose") {
      options.verbose = true;
    } else if (!arg.startsWith("-")) {
      if (!mediaFile) {
        mediaFile = arg;
      } else {
        const err = transcriptionError("INVALID_ARGUMENT", `Unexpected extra positional argument: ${arg}`);
        err.exitCode = 2;
        throw err;
      }
    } else {
      const err = transcriptionError("INVALID_ARGUMENT", `Unknown option: ${arg}`);
      err.exitCode = 2;
      throw err;
    }
  }

  if (!mediaFile) {
    const err = transcriptionError("INVALID_ARGUMENT", "media-file is required for media.transcribe");
    err.exitCode = 2;
    throw err;
  }

  return { mediaFile, options };
}

/**
 * Formats structured transcript result into a clean, human-readable summary.
 *
 * @param {Object} payload - Transcript payload object
 * @returns {string} Human-readable multi-line summary string
 */
export function formatHumanTranscriptSummary(payload) {
  const lines = [
    "=== Media Transcription Summary ===",
    `Media: ${payload.media || "unknown"}`,
    `Duration: ${Number(payload.duration || 0).toFixed(2)}s`,
    `Language: ${payload.language || "unknown"}`,
    `Model: ${payload.model || "default"}`,
    `Words: ${Array.isArray(payload.words) ? payload.words.length : 0}`,
    `Caption Segments: ${Array.isArray(payload.segments) ? payload.segments.length : 0}`,
    "",
    "=== Full Transcript ===",
    payload.text || "(no speech detected)",
    "",
    "=== Caption Segments ===",
  ];

  if (!payload.segments || payload.segments.length === 0) {
    lines.push("(no caption segments generated)");
  } else {
    for (const seg of payload.segments) {
      const startMin = Math.floor((seg.start || 0) / 60);
      const startSec = ((seg.start || 0) % 60).toFixed(2).padStart(5, "0");
      const endMin = Math.floor((seg.end || 0) / 60);
      const endSec = ((seg.end || 0) % 60).toFixed(2).padStart(5, "0");
      lines.push(`[${String(startMin).padStart(2, "0")}:${startSec} -> ${String(endMin).padStart(2, "0")}:${endSec}] ${seg.text}`);
    }
  }

  return lines.join("\n") + "\n";
}

/**
 * CLI command runner for media.transcribe.
 * Handles parsing, validation, cancellation, file writing, progress reporting, and output formatting.
 *
 * @param {string[]} argv - Arguments passed to media.transcribe
 * @param {Object} [overrides] - Test injection overrides
 * @returns {Promise<Object>} Output payload
 */
export async function transcribeMediaCli(argv = [], overrides = {}) {
  const { mediaFile, options } = parseTranscribeArgs(argv);

  const resolvedMedia = path.resolve(mediaFile);
  const resolvedOutput = options.output ? path.resolve(options.output) : null;

  if (resolvedOutput && !options.overwrite && fs.existsSync(resolvedOutput)) {
    const err = transcriptionError("OUTPUT_EXISTS", `Output file already exists: ${resolvedOutput}. Use --force to overwrite.`);
    err.exitCode = 1;
    throw err;
  }

  const abortController = new AbortController();
  const onCancel = () => abortController.abort();
  process.once("SIGINT", onCancel);
  process.once("SIGTERM", onCancel);

  if (overrides.signal) {
    if (overrides.signal.aborted) abortController.abort();
    else overrides.signal.addEventListener("abort", onCancel, { once: true });
  }

  const writeStderr = overrides.stderr || ((msg) => process.stderr.write(msg));
  const writeStdout = overrides.stdout || ((msg) => process.stdout.write(msg));

  const onProgress = ({ phase, progress, message }) => {
    if (!options.quiet) {
      writeStderr(`[transcribe] ${phase} (${progress}%)${message ? ` - ${message}` : ""}\n`);
    }
  };

  try {
    const result = await transcribeMedia(resolvedMedia, {
      language: options.language,
      modelId: options.modelId,
      timelineOffset: options.timelineOffset,
      grouping: options.grouping,
      onProgress,
      signal: abortController.signal,
      pipelineFactory: overrides.pipelineFactory,
    });

    const outputPayload = {
      ok: true,
      media: resolvedMedia,
      duration: result.duration,
      language: result.language,
      model: result.model || options.modelId || AUTOMATIC_CAPTION_MODEL_ID,
      text: result.text,
      words: result.words,
      segments: result.segments,
      summary: {
        wordCount: result.words.length,
        segmentCount: result.segments.length,
        duration: result.duration,
        language: result.language,
      },
      artifacts: resolvedOutput ? { output: resolvedOutput } : undefined,
    };

    if (resolvedOutput) {
      await fs.promises.mkdir(path.dirname(resolvedOutput), { recursive: true });
      await fs.promises.writeFile(resolvedOutput, JSON.stringify(outputPayload, null, 2), "utf8");
    }

    if (options.format === "summary") {
      writeStdout(formatHumanTranscriptSummary(outputPayload));
    } else {
      writeStdout(`${JSON.stringify(outputPayload, null, 2)}\n`);
    }

    return outputPayload;
  } finally {
    process.removeListener("SIGINT", onCancel);
    process.removeListener("SIGTERM", onCancel);
  }
}
