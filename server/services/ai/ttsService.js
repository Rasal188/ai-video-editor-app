import path from "node:path";
import { fileURLToPath } from "node:url";
import { KokoroTTS } from "kokoro-js";
import { env as transformersEnv } from "@huggingface/transformers";
import { ApiError } from "../errors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../../..");
const CACHE_DIR = path.resolve(ROOT_DIR, ".cache/timeline-studio-voice-models");

transformersEnv.cacheDir = CACHE_DIR;
transformersEnv.allowLocalModels = true;
transformersEnv.useBrowserCache = false;

let customKokoroProvider = null;
let kokoroModelPromise = null;

export function setKokoroProvider(provider) {
  customKokoroProvider = provider;
}

export function resetKokoroProvider() {
  customKokoroProvider = null;
  kokoroModelPromise = null;
}

/**
 * Returns a warm, cached KokoroTTS singleton instance.
 */
async function getKokoroInstance() {
  if (customKokoroProvider) {
    return typeof customKokoroProvider === "function" ? await customKokoroProvider() : customKokoroProvider;
  }
  if (!kokoroModelPromise) {
    kokoroModelPromise = (async () => {
      try {
        const model = await KokoroTTS.from_pretrained("kokoro", {
          dtype: "q8",
          device: "cpu",
        });
        return model;
      } catch (err) {
        kokoroModelPromise = null;
        throw new ApiError(503, "TTS_MODEL_LOAD_FAILED", `Failed to initialize TTS model: ${err.message}`);
      }
    })();
  }
  return kokoroModelPromise;
}

/**
 * Converts a Float32Array of audio samples to a 16-bit mono PCM WAV Buffer.
 *
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @returns {Buffer}
 */
export function float32ToWavBuffer(samples, sampleRate = 24000) {
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF Chunk
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);

  // fmt Subchunk
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  buffer.writeUInt16LE(1, 20); // AudioFormat (1 = PCM)
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34); // BitsPerSample

  // data Subchunk
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, offset);
    offset += 2;
  }

  return buffer;
}

/**
 * Synthesizes real spoken narration using KokoroTTS.
 * Supports synthesizing either a unified text script or scene-by-scene narration
 * with natural inter-scene breathing pauses and exact scene timings.
 *
 * @param {object} options
 * @param {string} [options.text] - Input narration text
 * @param {Array<string|object>} [options.scenes] - Optional array of scene narration texts or scene objects
 * @param {string} [options.voiceId="af_heart"] - Kokoro voice identifier
 * @param {number} [options.speed=1] - Playback speed multiplier
 * @param {object} [options.ttsEngine] - Optional injectable TTS engine
 * @returns {Promise<{ buffer: Buffer, duration: number, sampleRate: number, voiceId: string, sceneTimings?: Array }>}
 */
export async function synthesizeSpeech({ text, scenes, voiceId = "af_heart", speed = 1, ttsEngine = null }) {
  const cleanVoice = typeof voiceId === "string" && voiceId.trim() ? voiceId.trim() : "af_heart";
  const numSpeed = Number(speed);
  const cleanSpeed = Number.isFinite(numSpeed) && numSpeed >= 0.5 && numSpeed <= 2 ? numSpeed : 1;

  // Validate input parameters BEFORE loading the model or making network calls
  const hasScenes = Array.isArray(scenes) && scenes.length > 0;
  const cleanScenes = hasScenes
    ? scenes
        .map((s) => (typeof s === "string" ? s.trim() : (s?.narration || s?.text || "").trim()))
        .filter(Boolean)
    : [];

  const cleanText = typeof text === "string" ? text.trim() : "";

  if (!cleanText && cleanScenes.length === 0) {
    throw new ApiError(400, "INVALID_TEXT", "Narration text must be a non-empty string or provide non-empty scenes.");
  }

  const tts = ttsEngine || (await getKokoroInstance());
  const sampleRate = 24000;

  // Scene-by-scene audio synthesis: guarantees exact per-scene speech start/end and pause intervals
  if (cleanScenes.length > 0) {
    const pauseSamples = Math.round(sampleRate * 0.35); // 0.35s natural breathing space
    const pauseBuffer = new Float32Array(pauseSamples);
    const allSamples = [];
    const sceneTimings = [];
    let currentSampleCount = 0;

    for (let i = 0; i < cleanScenes.length; i++) {
      const sceneText = cleanScenes[i];
      const res = await tts.generate(sceneText, {
        voice: cleanVoice,
        speed: cleanSpeed,
      });

      const sceneSamples = res?.audio;
      if (!(sceneSamples instanceof Float32Array) || sceneSamples.length === 0) {
        throw new ApiError(500, "TTS_GENERATION_FAILED", `TTS model returned empty audio for scene ${i + 1}.`);
      }

      const start = Number((currentSampleCount / sampleRate).toFixed(3));
      const duration = Number((sceneSamples.length / sampleRate).toFixed(3));
      const end = Number((start + duration).toFixed(3));

      sceneTimings.push({
        index: i,
        text: sceneText,
        start,
        end,
        duration,
      });

      allSamples.push(sceneSamples);
      currentSampleCount += sceneSamples.length;

      // Insert pause between scenes (except after last scene)
      if (i < cleanScenes.length - 1) {
        allSamples.push(pauseBuffer);
        currentSampleCount += pauseSamples;
      }
    }

    const totalLength = allSamples.reduce((acc, s) => acc + s.length, 0);
    const combinedSamples = new Float32Array(totalLength);
    let offset = 0;
    for (const s of allSamples) {
      combinedSamples.set(s, offset);
      offset += s.length;
    }

    const totalDuration = Number((totalLength / sampleRate).toFixed(2));
    const buffer = float32ToWavBuffer(combinedSamples, sampleRate);

    return {
      buffer,
      duration: totalDuration,
      sampleRate,
      voiceId: cleanVoice,
      mimeType: "audio/wav",
      sceneTimings,
    };
  }

  const result = await tts.generate(cleanText, {
    voice: cleanVoice,
    speed: cleanSpeed,
  });

  const samples = result?.audio;
  if (!(samples instanceof Float32Array) || samples.length === 0) {
    throw new ApiError(500, "TTS_GENERATION_FAILED", "TTS model returned empty audio samples.");
  }

  const duration = Number((samples.length / sampleRate).toFixed(2));
  const buffer = float32ToWavBuffer(samples, sampleRate);

  return {
    buffer,
    duration,
    sampleRate,
    voiceId: cleanVoice,
    mimeType: "audio/wav",
  };
}
