/**
 * @file shortsAudioEnergy.js
 * AI Shorts Studio — Phase 2, Priority 5
 * Multimodal Audio Energy & Vocal Intensity Alignment
 *
 * Implements:
 * 1. Short-window Root-Mean-Square (RMS) audio energy estimation.
 * 2. Relative energy normalization across diverse recording gain levels.
 * 3. Silence / near-silence noise-floor estimation and gating.
 * 4. Local energy peaks, intensity derivatives (surges), and dynamic contrast.
 * 5. Lightweight, dependency-free voiced fundamental frequency (F0) tracking with unvoiced detection.
 * 6. Temporal alignment of acoustic emphasis with transcript sentences and narrative arc stages.
 * 7. Candidate boundary protection against slicing during active vocal surges.
 * 8. Resilient, deterministic fallbacks for missing, partial, or malformed audio data.
 */

// Default analysis parameters
export const DEFAULT_AUDIO_ANALYSIS_OPTIONS = Object.freeze({
  windowDuration: 0.05, // 50ms window
  hopDuration: 0.025,   // 25ms hop (50% overlap)
  sampleRate: 16000,    // Default PCM reference sample rate
  noiseFloorPercentile: 0.15, // 15th percentile for ambient noise floor
  silenceThresholdDb: -42,    // dB cutoff below which signal is considered silence
  minVoicedFrequency: 75,     // Human vocal minimum (Hz)
  maxVoicedFrequency: 420,    // Human vocal maximum (Hz)
  voicingCorrelationThreshold: 0.42, // Minimum autocorrelation peak for voiced detection
});

/**
 * Extracts and sanitizes mono PCM audio samples from diverse input formats:
 * - Float32Array / Array
 * - Web Audio AudioBuffer
 * - Waveform peaks structure { peaks, duration }
 * - Object with { channelData, sampleRate }
 *
 * @param {any} audioInput
 * @param {number} [targetSampleRate=16000]
 * @returns {{ samples: Float32Array, sampleRate: number, duration: number, isWaveformOnly: boolean } | null}
 */
export function sanitizeAudioInput(audioInput, targetSampleRate = 16000) {
  if (!audioInput) return null;

  // Case 1: AudioBuffer (Web Audio API)
  if (typeof audioInput === "object" && typeof audioInput.getChannelData === "function") {
    try {
      const numChannels = audioInput.numberOfChannels || 1;
      const length = audioInput.length || 0;
      if (length <= 0) return null;

      const sr = audioInput.sampleRate || targetSampleRate;
      const mono = new Float32Array(length);

      for (let c = 0; c < numChannels; c++) {
        const channel = audioInput.getChannelData(c);
        for (let i = 0; i < length; i++) {
          mono[i] += (channel[i] || 0) / numChannels;
        }
      }

      return {
        samples: mono,
        sampleRate: sr,
        duration: Number((length / sr).toFixed(3)),
        isWaveformOnly: false,
      };
    } catch {
      return null;
    }
  }

  // Case 2: Float32Array / Array of raw samples
  if (audioInput instanceof Float32Array || Array.isArray(audioInput)) {
    if (audioInput.length === 0) return null;
    const len = audioInput.length;
    const cleanSamples = new Float32Array(len);

    for (let i = 0; i < len; i++) {
      const val = Number(audioInput[i]);
      // Clamp clipped values and replace NaN/Infinity with 0
      cleanSamples[i] = Number.isFinite(val) ? Math.max(-1.0, Math.min(1.0, val)) : 0;
    }

    const sr = Number(targetSampleRate) || 16000;
    return {
      samples: cleanSamples,
      sampleRate: sr,
      duration: Number((len / sr).toFixed(3)),
      isWaveformOnly: false,
    };
  }

  // Case 3: Object with samples and sampleRate { samples, sampleRate, duration }
  if (typeof audioInput === "object" && (audioInput.samples || audioInput.channelData)) {
    const raw = audioInput.samples || audioInput.channelData;
    if (raw instanceof Float32Array || Array.isArray(raw)) {
      const sr = Number(audioInput.sampleRate) || targetSampleRate;
      const len = raw.length;
      if (len === 0) return null;

      const clean = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        const val = Number(raw[i]);
        clean[i] = Number.isFinite(val) ? Math.max(-1.0, Math.min(1.0, val)) : 0;
      }
      return {
        samples: clean,
        sampleRate: sr,
        duration: Number(audioInput.duration) || Number((len / sr).toFixed(3)),
        isWaveformOnly: false,
      };
    }
  }

  // Case 4: Precomputed waveform peaks envelope { peaks, duration }
  if (typeof audioInput === "object" && (audioInput.peaks || Array.isArray(audioInput.waveform))) {
    const peaks = audioInput.peaks || audioInput.waveform;
    if (Array.isArray(peaks) || peaks instanceof Float32Array) {
      if (peaks.length === 0) return null;
      const len = peaks.length;
      const cleanPeaks = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        const val = Number(peaks[i]);
        cleanPeaks[i] = Number.isFinite(val) ? Math.max(0, Math.min(1.0, Math.abs(val))) : 0;
      }
      const dur = Number(audioInput.duration) || len * 0.04;
      return {
        samples: cleanPeaks,
        sampleRate: Math.round(len / Math.max(0.1, dur)),
        duration: Number(dur.toFixed(3)),
        isWaveformOnly: true,
      };
    }
  }

  return null;
}

/**
 * Computes short-window Root-Mean-Square (RMS) audio energy and voiced pitch.
 * Produces a time-series of acoustic frames covering the recording.
 *
 * @param {any} audioInput - Raw PCM samples, AudioBuffer, or peaks
 * @param {object} [options] - Analysis configuration
 * @returns {object} Energy timeline analysis with frames and global statistics
 */
export function analyzeAudioEnergy(audioInput, options = {}) {
  const sanitized = sanitizeAudioInput(audioInput, options.sampleRate);
  if (!sanitized || sanitized.samples.length === 0) {
    return createEmptyAudioEnergyResult();
  }

  const { samples, sampleRate, duration, isWaveformOnly } = sanitized;
  const opts = { ...DEFAULT_AUDIO_ANALYSIS_OPTIONS, ...options, sampleRate };

  const windowSize = Math.max(16, Math.round(opts.windowDuration * sampleRate));
  const hopSize = Math.max(8, Math.round(opts.hopDuration * sampleRate));

  const numFrames = Math.max(1, Math.floor((samples.length - windowSize) / hopSize) + 1);
  const rawRms = new Float32Array(numFrames);
  const rawDb = new Float32Array(numFrames);
  const timestamps = new Float32Array(numFrames);
  const pitchValues = new Float32Array(numFrames);
  const voicedFlags = new Uint8Array(numFrames);

  let sumRms = 0;
  let maxRmsVal = 0;

  // 1. First pass: compute windowed RMS energy
  for (let f = 0; f < numFrames; f++) {
    const startIdx = f * hopSize;
    const time = (startIdx + windowSize / 2) / sampleRate;
    timestamps[f] = Number(time.toFixed(3));

    let sumSquares = 0;
    const actualEnd = Math.min(samples.length, startIdx + windowSize);
    const count = actualEnd - startIdx;

    if (count > 0) {
      if (isWaveformOnly) {
        // Peaks envelope: average amplitude represents energy directly
        for (let i = startIdx; i < actualEnd; i++) {
          const v = samples[i];
          sumSquares += v * v;
        }
      } else {
        for (let i = startIdx; i < actualEnd; i++) {
          const s = samples[i];
          sumSquares += s * s;
        }
      }
      const frameRms = Math.sqrt(sumSquares / count);
      rawRms[f] = frameRms;
      sumRms += frameRms;
      if (frameRms > maxRmsVal) maxRmsVal = frameRms;

      // Decibel conversion with -90dB minimum floor
      const dbVal = 20 * Math.log10(Math.max(1e-5, frameRms));
      rawDb[f] = dbVal;
    } else {
      rawRms[f] = 0;
      rawDb[f] = -90;
    }
  }

  // 2. Global statistics & noise floor estimation
  const sortedRms = Float32Array.from(rawRms).sort();
  const noiseFloorIdx = Math.min(
    sortedRms.length - 1,
    Math.max(0, Math.floor(sortedRms.length * opts.noiseFloorPercentile))
  );
  const noiseFloorRms = sortedRms[noiseFloorIdx] || 0.001;
  const p95Idx = Math.min(sortedRms.length - 1, Math.floor(sortedRms.length * 0.95));
  const p95Rms = Math.max(noiseFloorRms + 0.005, sortedRms[p95Idx] || 0.05);

  const meanRms = sumRms / numFrames;
  const dynamicRangeDb = 20 * Math.log10(Math.max(1e-4, maxRmsVal / Math.max(1e-5, noiseFloorRms)));

  // 3. Second pass: relative normalization, derivative (intensity surge), and pitch tracking
  const frames = [];
  let previousNormalized = 0;

  for (let f = 0; f < numFrames; f++) {
    const rms = rawRms[f];
    const db = rawDb[f];
    const t = timestamps[f];

    // Relative intensity normalized [0.0, 1.0] relative to ambient noise and speech ceiling (P95)
    let relativeIntensity = (rms - noiseFloorRms) / (p95Rms - noiseFloorRms);
    relativeIntensity = Math.max(0.0, Math.min(1.0, relativeIntensity));

    const isSilence = db < opts.silenceThresholdDb || rms <= noiseFloorRms * 1.25;

    // Local energy change / intensity derivative (detects sudden vocal surges)
    const intensitySurge = f > 0 ? Number((relativeIntensity - previousNormalized).toFixed(3)) : 0;
    previousNormalized = relativeIntensity;

    // Pitch estimation via Normalized Autocorrelation (only for voiced non-waveform PCM audio)
    let pitchHz = null;
    let isVoiced = false;

    if (!isWaveformOnly && !isSilence && relativeIntensity > 0.15) {
      const pitchEstimate = estimatePitchAutocorrelation(
        samples,
        f * hopSize,
        windowSize,
        sampleRate,
        opts.minVoicedFrequency,
        opts.maxVoicedFrequency,
        opts.voicingCorrelationThreshold
      );
      if (pitchEstimate && pitchEstimate.voiced) {
        pitchHz = pitchEstimate.f0;
        isVoiced = true;
        pitchValues[f] = pitchHz;
        voicedFlags[f] = 1;
      }
    }

    frames.push({
      time: t,
      rms: Number(rms.toFixed(4)),
      db: Number(db.toFixed(1)),
      relativeIntensity: Number(relativeIntensity.toFixed(3)),
      isSilence,
      intensitySurge,
      pitchHz,
      isVoiced,
    });
  }

  // 4. Identify local prominence peaks (vocal emphasis events)
  const prominentPeaks = detectEnergyPeaks(frames);

  return {
    valid: true,
    duration,
    frameCount: frames.length,
    frames,
    prominentPeaks,
    statistics: {
      meanRms: Number(meanRms.toFixed(4)),
      maxRms: Number(maxRmsVal.toFixed(4)),
      noiseFloorRms: Number(noiseFloorRms.toFixed(4)),
      p95Rms: Number(p95Rms.toFixed(4)),
      dynamicRangeDb: Number(dynamicRangeDb.toFixed(1)),
      hasPitchData: !isWaveformOnly && frames.some((f) => f.isVoiced),
    },
    options: opts,
  };
}

/**
 * Normalized Autocorrelation Fundamental Frequency (F0) estimator.
 * Lightweight, zero-dependency, bounded between minFreq and maxFreq.
 *
 * @param {Float32Array} samples
 * @param {number} startIdx
 * @param {number} windowSize
 * @param {number} sampleRate
 * @param {number} minFreq
 * @param {number} maxFreq
 * @param {number} threshold
 * @returns {{ f0: number, correlation: number, voiced: boolean } | null}
 */
export function estimatePitchAutocorrelation(
  samples,
  startIdx,
  windowSize,
  sampleRate,
  minFreq = 75,
  maxFreq = 420,
  threshold = 0.42
) {
  const minLag = Math.max(1, Math.floor(sampleRate / maxFreq));
  const maxLag = Math.min(Math.floor(windowSize / 2), Math.floor(sampleRate / minFreq));

  if (startIdx + windowSize > samples.length || maxLag <= minLag) {
    return null;
  }

  // Compute energy at zero lag
  let energy0 = 0;
  for (let i = 0; i < windowSize - maxLag; i++) {
    const s = samples[startIdx + i];
    energy0 += s * s;
  }
  if (energy0 < 1e-6) return { f0: null, correlation: 0, voiced: false };

  let bestLag = -1;
  let bestCorr = -1;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let crossProduct = 0;
    let lagEnergy = 0;

    for (let i = 0; i < windowSize - maxLag; i++) {
      const s0 = samples[startIdx + i];
      const sLag = samples[startIdx + i + lag];
      crossProduct += s0 * sLag;
      lagEnergy += sLag * sLag;
    }

    const norm = Math.sqrt(Math.max(1e-12, energy0 * lagEnergy));
    const r = crossProduct / norm;

    if (r > bestCorr) {
      bestCorr = r;
      bestLag = lag;
    }
  }

  if (bestCorr >= threshold && bestLag > 0) {
    // Parabolic interpolation for sub-sample lag refinement
    let refinedLag = bestLag;
    if (bestLag > minLag && bestLag < maxLag) {
      // Evaluate lag - 1 and lag + 1
      const prevR = computeAutocorrelationAtLag(samples, startIdx, windowSize - maxLag, bestLag - 1, energy0);
      const nextR = computeAutocorrelationAtLag(samples, startIdx, windowSize - maxLag, bestLag + 1, energy0);
      const denominator = 2 * (2 * bestCorr - prevR - nextR);
      if (Math.abs(denominator) > 1e-5) {
        const delta = (prevR - nextR) / denominator;
        refinedLag = bestLag + Math.max(-0.5, Math.min(0.5, delta));
      }
    }

    const f0 = sampleRate / refinedLag;
    if (f0 >= minFreq && f0 <= maxFreq) {
      return {
        f0: Number(f0.toFixed(1)),
        correlation: Number(bestCorr.toFixed(3)),
        voiced: true,
      };
    }
  }

  return { f0: null, correlation: Number(Math.max(0, bestCorr).toFixed(3)), voiced: false };
}

function computeAutocorrelationAtLag(samples, startIdx, len, lag, energy0) {
  let cross = 0;
  let lagEnergy = 0;
  for (let i = 0; i < len; i++) {
    const s0 = samples[startIdx + i];
    const sLag = samples[startIdx + i + lag];
    cross += s0 * sLag;
    lagEnergy += sLag * sLag;
  }
  return cross / Math.sqrt(Math.max(1e-12, energy0 * lagEnergy));
}

/**
 * Detects local energy peaks representing vocal emphasis moments.
 */
function detectEnergyPeaks(frames, minProminence = 0.20, minSeparationSeconds = 0.35) {
  if (!frames || frames.length < 3) return [];

  const peaks = [];
  const windowRadius = 4; // Look 4 frames left and right (approx 100ms each side)

  for (let i = windowRadius; i < frames.length - windowRadius; i++) {
    const curr = frames[i];
    if (curr.isSilence || curr.relativeIntensity < 0.35) continue;

    let isLocalMax = true;
    let localMin = curr.relativeIntensity;

    for (let offset = -windowRadius; offset <= windowRadius; offset++) {
      if (offset === 0) continue;
      const neighbor = frames[i + offset];
      if (neighbor.relativeIntensity > curr.relativeIntensity) {
        isLocalMax = false;
        break;
      }
      if (neighbor.relativeIntensity < localMin) {
        localMin = neighbor.relativeIntensity;
      }
    }

    const prominence = curr.relativeIntensity - localMin;
    if (isLocalMax && prominence >= minProminence) {
      // Check minimum separation from last accepted peak
      const lastPeak = peaks.at(-1);
      if (!lastPeak || curr.time - lastPeak.time >= minSeparationSeconds) {
        peaks.push({
          time: curr.time,
          intensity: curr.relativeIntensity,
          prominence: Number(prominence.toFixed(3)),
          db: curr.db,
          isVoiced: curr.isVoiced,
          pitchHz: curr.pitchHz,
        });
      } else if (lastPeak && curr.relativeIntensity > lastPeak.intensity) {
        // Replace with higher peak
        peaks[peaks.length - 1] = {
          time: curr.time,
          intensity: curr.relativeIntensity,
          prominence: Number(prominence.toFixed(3)),
          db: curr.db,
          isVoiced: curr.isVoiced,
          pitchHz: curr.pitchHz,
        };
      }
    }
  }

  return peaks;
}

/**
 * Aligns acoustic features with transcript sentences and computes vocal emphasis metrics.
 *
 * @param {Array<object>} sentences - Transcript sentence objects { start, end, text }
 * @param {object} energyTimeline - Output of analyzeAudioEnergy
 * @returns {Array<object>} Enriched sentences with acoustic metrics
 */
export function alignAudioFeaturesWithTranscript(sentences = [], energyTimeline = null) {
  if (!Array.isArray(sentences) || sentences.length === 0) return [];
  if (!energyTimeline || !energyTimeline.valid || !energyTimeline.frames.length) {
    // Graceful fallback: return original sentences with default neutral acoustic values
    return sentences.map((s) => ({
      ...s,
      acousticEnergy: {
        averageIntensity: 0.5,
        peakIntensity: 0.5,
        emphasisScore: 50,
        hasEmphasisPeak: false,
        isMutedOrSilent: false,
        vocalSurgesCount: 0,
        hasPitchData: false,
      },
    }));
  }

  const { frames, prominentPeaks, statistics } = energyTimeline;

  return sentences.map((sentence) => {
    const sStart = Math.max(0, Number(sentence.start) || 0);
    const sEnd = Math.max(sStart, Number(sentence.end) || sStart + 2.0);

    // Filter frames strictly inside this sentence's time boundary
    let sentenceFrames = frames.filter((f) => f.time >= sStart && f.time < sEnd);
    if (sentenceFrames.length === 0) {
      sentenceFrames = frames.filter((f) => f.time >= sStart - 0.05 && f.time <= sEnd + 0.05);
    }

    if (sentenceFrames.length === 0) {
      return {
        ...sentence,
        acousticEnergy: {
          averageIntensity: 0.5,
          peakIntensity: 0.5,
          emphasisScore: 50,
          hasEmphasisPeak: false,
          isMutedOrSilent: false,
          vocalSurgesCount: 0,
          hasPitchData: false,
        },
      };
    }

    let sumIntensity = 0;
    let maxIntensity = 0;
    let silenceCount = 0;
    let vocalSurges = 0;
    const voicedPitches = [];

    for (const f of sentenceFrames) {
      sumIntensity += f.relativeIntensity;
      if (f.relativeIntensity > maxIntensity) maxIntensity = f.relativeIntensity;
      if (f.isSilence) silenceCount++;
      if (f.intensitySurge > 0.20) vocalSurges++;
      if (f.isVoiced && f.pitchHz !== null) voicedPitches.push(f.pitchHz);
    }

    const avgIntensity = sumIntensity / sentenceFrames.length;
    const silenceRatio = silenceCount / sentenceFrames.length;
    const isMutedOrSilent = silenceRatio > 0.85;

    // Check if prominent peaks occur in this sentence
    const matchingPeaks = prominentPeaks.filter((p) => p.time >= sStart && p.time < sEnd);
    const hasEmphasisPeak = matchingPeaks.length > 0;

    // Pitch metrics
    let meanPitch = null;
    let pitchInflection = 0;
    if (voicedPitches.length >= 2) {
      const sumPitch = voicedPitches.reduce((acc, p) => acc + p, 0);
      meanPitch = Number((sumPitch / voicedPitches.length).toFixed(1));
      // End minus start pitch inflection
      pitchInflection = Number((voicedPitches.at(-1) - voicedPitches[0]).toFixed(1));
    }

    // Composite sentence vocal emphasis score (0 - 100)
    let emphasisScore = 50;
    if (isMutedOrSilent) {
      emphasisScore = 20;
    } else {
      // Relative intensity contribution (+/- 25)
      emphasisScore += (avgIntensity - 0.40) * 40;
      // Peak bonus
      if (maxIntensity > 0.70) emphasisScore += 15;
      if (hasEmphasisPeak) emphasisScore += 15;
      if (vocalSurges > 0) emphasisScore += 10;
      // Rising pitch inflection bonus for questions
      if (sentence.isQuestion && pitchInflection > 15) emphasisScore += 10;
    }

    emphasisScore = Math.max(10, Math.min(100, Math.round(emphasisScore)));

    return {
      ...sentence,
      acousticEnergy: {
        averageIntensity: Number(avgIntensity.toFixed(3)),
        peakIntensity: Number(maxIntensity.toFixed(3)),
        emphasisScore,
        hasEmphasisPeak,
        isMutedOrSilent,
        vocalSurgesCount: vocalSurges,
        peakCount: matchingPeaks.length,
        hasPitchData: voicedPitches.length > 0,
        meanPitchHz: meanPitch,
        pitchInflectionHz: pitchInflection,
      },
    };
  });
}

/**
 * Evaluates candidate clip acoustic delivery and aligns with narrative stages.
 * Rewards speech climaxes and key insights delivered with high vocal energy.
 *
 * @param {object} candidate - Candidate moment with startTime, endTime, narrativeArc
 * @param {Array<object>} sentences - Enriched transcript sentences
 * @param {object} [energyTimeline] - Global energy timeline
 * @returns {{ acousticScore: number, reasons: string[], warnings: string[], metrics: object }}
 */
export function evaluateCandidateAcousticAlignment(candidate, sentences = [], energyTimeline = null) {
  if (!candidate || !Array.isArray(sentences) || sentences.length === 0) {
    return {
      acousticScore: 75,
      reasons: [],
      warnings: [],
      metrics: { hasAcousticData: false },
    };
  }

  // Filter sentences that fall within this candidate's window
  const candStart = Number(candidate.startTime) || 0;
  const candEnd = Number(candidate.endTime) || candStart + 15;
  const candSentences = sentences.filter(
    (s) => Number.isFinite(s.start) && s.start >= candStart - 0.5 && s.start < candEnd
  );

  if (!candSentences.length) {
    return {
      acousticScore: 75,
      reasons: [],
      warnings: [],
      metrics: { hasAcousticData: false },
    };
  }

  // Check if sentences have computed acousticEnergy
  const hasAcousticData = candSentences.some((s) => s.acousticEnergy?.hasEmphasisPeak !== undefined);
  if (!hasAcousticData || !energyTimeline?.valid) {
    return {
      acousticScore: 75,
      reasons: [],
      warnings: [],
      metrics: { hasAcousticData: false },
    };
  }

  const reasons = [];
  const warnings = [];

  const avgIntensity =
    candSentences.reduce((acc, s) => acc + (s.acousticEnergy?.averageIntensity || 0.5), 0) /
    candSentences.length;

  const peakIntensity = Math.max(
    ...candSentences.map((s) => s.acousticEnergy?.peakIntensity || 0)
  );

  const totalPeaks = candSentences.reduce((acc, s) => acc + (s.acousticEnergy?.peakCount || 0), 0);
  const totalSurges = candSentences.reduce(
    (acc, s) => acc + (s.acousticEnergy?.vocalSurgesCount || 0),
    0
  );

  // Check correlation with narrative stages (Priority 4)
  const climaxSentence = candSentences.find(
    (s) => s.narrativeStage === "climax" || s.narrativeArc?.stages?.hasClimax
  );
  const setupSentence = candSentences.find(
    (s) => s.narrativeStage === "setup" || s.isQuestion
  );
  const resolutionSentence = candSentences.find((s) => s.narrativeStage === "resolution");

  let alignmentBonus = 0;

  // 1. Climax alignment: Core turning point delivered with elevated vocal energy
  if (climaxSentence?.acousticEnergy) {
    if (climaxSentence.acousticEnergy.hasEmphasisPeak || climaxSentence.acousticEnergy.peakIntensity > 0.70) {
      alignmentBonus += 15;
      reasons.push("Vocal delivery peaks with high acoustic emphasis at key moment");
    }
  }

  // 2. Setup hook alignment: Question asked with clear vocal projection or pitch rise
  if (setupSentence?.acousticEnergy) {
    if (setupSentence.acousticEnergy.pitchInflectionHz > 12 || setupSentence.acousticEnergy.averageIntensity > 0.55) {
      alignmentBonus += 8;
      reasons.push("Engaging vocal inflection on opening question");
    }
  }

  // 3. Resolution statement delivered with steady declarative authority
  if (resolutionSentence?.acousticEnergy) {
    if (!resolutionSentence.acousticEnergy.isMutedOrSilent && resolutionSentence.acousticEnergy.averageIntensity > 0.35) {
      alignmentBonus += 7;
    }
  }

  // 4. Dead air or flat monotone warning
  if (avgIntensity < 0.20 && totalPeaks === 0) {
    warnings.push("Candidate exhibits low acoustic energy or flat vocal delivery");
  }

  // Base score from overall energy distribution
  let score = 55 + avgIntensity * 25 + (peakIntensity > 0.75 ? 10 : 0) + alignmentBonus;
  if (totalPeaks >= 2) score += 5;
  if (warnings.length > 0) score -= 10;

  const acousticScore = Math.max(30, Math.min(100, Math.round(score)));

  return {
    acousticScore,
    reasons,
    warnings,
    metrics: {
      hasAcousticData: true,
      averageIntensity: Number(avgIntensity.toFixed(3)),
      peakIntensity: Number(peakIntensity.toFixed(3)),
      totalPeaks,
      totalSurges,
      alignmentBonus,
    },
  };
}

/**
 * Checks whether candidate boundaries coincide with an ongoing high-energy vocal surge.
 * Prevents truncating a speaker mid-shout or during peak emphasis.
 *
 * @param {number} endTime - Proposed cut end time
 * @param {object} energyTimeline - Output of analyzeAudioEnergy
 * @returns {{ isSafeToCut: boolean, suggestedEndTime: number }}
 */
export function checkVocalBoundarySafety(endTime, energyTimeline) {
  if (!energyTimeline || !energyTimeline.valid || !energyTimeline.frames.length) {
    return { isSafeToCut: true, suggestedEndTime: endTime };
  }

  const { frames } = energyTimeline;
  const frameAtCut = frames.find((f) => Math.abs(f.time - endTime) < 0.06);

  // If the cut point is experiencing high relative intensity or positive surge, shift slightly forward to quiet breath
  if (frameAtCut && frameAtCut.relativeIntensity > 0.65 && !frameAtCut.isSilence) {
    // Look ahead up to 0.6 seconds for an acoustic valley
    const futureFrames = frames.filter((f) => f.time > endTime && f.time <= endTime + 0.6);
    const quietest = futureFrames.reduce(
      (best, f) => (f.relativeIntensity < best.relativeIntensity ? f : best),
      frameAtCut
    );

    if (quietest && quietest.time > endTime) {
      return {
        isSafeToCut: false,
        suggestedEndTime: Number(quietest.time.toFixed(2)),
      };
    }
  }

  return { isSafeToCut: true, suggestedEndTime: endTime };
}

/**
 * Creates empty fallback audio energy result.
 */
function createEmptyAudioEnergyResult() {
  return {
    valid: false,
    duration: 0,
    frameCount: 0,
    frames: [],
    prominentPeaks: [],
    statistics: {
      meanRms: 0,
      maxRms: 0,
      noiseFloorRms: 0,
      p95Rms: 0,
      dynamicRangeDb: 0,
      hasPitchData: false,
    },
    options: DEFAULT_AUDIO_ANALYSIS_OPTIONS,
  };
}
