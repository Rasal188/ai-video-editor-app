import * as ort from "onnxruntime-web/wasm";
import wasmModule from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";
import wasmBinary from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import { sileroModelUrls, SILERO_MODEL_SHA256 } from "../config/sileroVad.js";
import { fetchFirstAvailableModel } from "../lib/modelSources.js";

ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = { mjs: wasmModule, wasm: wasmBinary };
let session = null;
let state = new Float32Array(256);
let context = new Float32Array(64);

/**
 * Local-first audio energy, SNR, and zero-crossing speech detector.
 * Guaranteed to run in-worker without internet access or remote model downloads.
 */
function analyzePcmLocal(pcm, onProgress) {
  const count = Math.ceil(pcm.length / 512);
  const probabilities = new Float32Array(count);
  let noiseFloor = 0.003;
  let smoothedProb = 0;

  for (let i = 0; i < count; i++) {
    const start = i * 512;
    const end = Math.min(pcm.length, start + 512);
    const len = end - start;
    let sumSq = 0;
    let zeroCrossings = 0;

    for (let j = start; j < end; j++) {
      const sample = pcm[j];
      sumSq += sample * sample;
      if (j > start && ((sample >= 0 && pcm[j - 1] < 0) || (sample < 0 && pcm[j - 1] >= 0))) {
        zeroCrossings++;
      }
    }

    const rms = Math.sqrt(sumSq / Math.max(1, len));
    const zcr = zeroCrossings / Math.max(1, len);

    // Track dynamic background noise floor
    if (rms < noiseFloor) {
      noiseFloor = noiseFloor * 0.85 + rms * 0.15;
    } else {
      noiseFloor = noiseFloor * 0.996 + rms * 0.004;
    }
    noiseFloor = Math.max(0.0005, Math.min(0.06, noiseFloor));

    const snr = rms / noiseFloor;

    // Speech probability estimation based on RMS energy and SNR
    const energyScore = Math.max(0, Math.min(1, (rms - 0.004) / 0.02));
    const snrScore = Math.max(0, Math.min(1, (snr - 1.5) / 2.5));
    const zcrScore = zcr >= 0.01 && zcr <= 0.45 ? 1.0 : zcr < 0.01 ? 0.3 : 0.5;

    let instantProb = (energyScore * 0.7 + snrScore * 0.3) * zcrScore;
    if (rms < 0.003) instantProb = 0;

    // Temporal smoothing to maintain speech continuity
    const alpha = instantProb > smoothedProb ? 0.65 : 0.25;
    smoothedProb = smoothedProb * (1 - alpha) + instantProb * alpha;

    probabilities[i] = Math.max(0, Math.min(1, smoothedProb));

    if (i % 32 === 0) {
      onProgress?.(i / count);
    }
  }

  return probabilities;
}

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === "init") {
      try {
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Model download timeout")), 2500)
        );
        const fetchPromise = (async () => {
          const { response } = await fetchFirstAvailableModel(sileroModelUrls(data.language));
          const bytes = await response.arrayBuffer();
          const digest = Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
            (byte) => byte.toString(16).padStart(2, "0")
          ).join("");
          if (digest !== SILERO_MODEL_SHA256) throw new Error("Model checksum mismatch");
          return bytes;
        })();

        const bytes = await Promise.race([fetchPromise, timeoutPromise]);
        self.postMessage({ id, type: "phase", phase: "pauseStarting" });
        session = await ort.InferenceSession.create(bytes, {
          executionProviders: ["wasm"],
          graphOptimizationLevel: "all",
        });
        state = new Float32Array(256);
        context = new Float32Array(64);
        self.postMessage({ id, type: "done" });
        return;
      } catch {
        // Fall back seamlessly to local audio VAD analysis without throwing or requiring cloud AI
        self.postMessage({ id, type: "phase", phase: "pauseStarting" });
        self.postMessage({ id, type: "done" });
        return;
      }
    }

    const pcm = data.pcm;
    if (!pcm || !pcm.length) {
      const probabilities = new Float32Array(0);
      self.postMessage({ id, type: "done", probabilities }, [probabilities.buffer]);
      return;
    }

    if (!session) {
      // Execute local audio analysis non-blockingly
      const probabilities = analyzePcmLocal(pcm, (p) => {
        self.postMessage({ id, type: "progress", progress: p });
      });
      self.postMessage({ id, type: "done", probabilities }, [probabilities.buffer]);
      return;
    }

    // ONNX session inference
    const count = Math.ceil(pcm.length / 512);
    const probabilities = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const input = new Float32Array(576);
      input.set(context);
      input.set(pcm.subarray(i * 512, (i + 1) * 512), 64);
      const feeds = {
        input: new ort.Tensor("float32", input, [1, 576]),
        state: new ort.Tensor("float32", state, [2, 1, 128]),
        sr: new ort.Tensor("int64", BigInt64Array.of(16000n), []),
      };
      let output;
      try {
        output = await session.run(feeds);
        const probability = Number(output.output.data[0]);
        if (!Number.isFinite(probability)) throw new Error("Invalid model result");
        probabilities[i] = probability;
        state = new Float32Array(output.stateN.data);
        context = input.slice(-64);
      } finally {
        Object.values(feeds).forEach((tensor) => tensor.dispose());
        Object.values(output || {}).forEach((tensor) => tensor.dispose());
      }
      if (i % 32 === 0) self.postMessage({ id, type: "progress", progress: i / count });
    }
    self.postMessage({ id, type: "done", probabilities }, [probabilities.buffer]);
  } catch {
    self.postMessage({ id, type: "error", code: type === "init" ? "pauseModelFailed" : "pauseFailed" });
  }
};
