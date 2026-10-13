# AI Scene Detection Engine — Phase 1

This document covers the Phase 1 milestone implementation of the AI Scene Detection Engine for the video editor.

## Overview

The Scene Detection Engine analyzes video content to identify visual scene boundaries (hard cuts) and produce structured scene intervals with timestamps, difference scores, and confidence metrics.

The engine operates independently of the timeline and UI, returning temporary analysis data without modifying user clips or saved project files.

---

## Architecture & How Detection Works

Scene detection operates in three layers:

```
[ Video Source / Frames ]
          │
          ▼
1. Frame Sampling & Feature Extraction (computeFrameSignature)
   - Downscaled to 64x36 for minimal CPU/memory overhead
   - 4x4x4 (64-bin) 3D RGB color histogram with trilinear soft binning
   - 8x8 (64-cell) spatial color grid (RGB averages per cell)
   - Perceptual luminance calculation (ITU-R BT.601)
          │
          ▼
2. Visual Difference Scoring (computeFrameDifference)
   - Normalized L1 Manhattan distance of 3D color distribution (60% weight)
   - Mean absolute difference of spatial color cells (40% weight)
   - Normalized difference score: [0.0 (identical) – 1.0 (disjoint)]
          │
          ▼
3. Boundary Filtering & Scene Synthesis (detectScenesFromSignatures)
   - Threshold filtering (`score >= threshold`)
   - Start / End guard exclusion (`startGuard`, `endGuard`)
   - Temporal non-maximum suppression / debounce window
   - Minimum scene duration enforcement (`minSceneDuration`)
   - Contiguous scene interval generation `[{ index, start, end, duration }]`
```

### Soft Binning (Discretization Invariance)

Traditional discrete histograms suffer from boundary artifacts: small shifts in pixel brightness (e.g. 31 to 32) can flip pixels into an adjacent bin, creating false visual spikes.

The engine uses **trilinear soft binning**: each pixel's weight is smoothly distributed across its 8 neighboring 3D color bins using trilinear interpolation weights:

$$w_{ijk} = (1 - \Delta r)(1 - \Delta g)(1 - \Delta b)$$

This guarantees continuous, smooth difference scores across lighting changes and noise.

---

## Configuration & Defaults

| Setting | Default | Description | Trade-offs |
| :--- | :--- | :--- | :--- |
| `sampleInterval` | `0.5s` | Time in seconds between sampled frames (2 fps). | Lower intervals (e.g. 0.25s) improve cut precision but increase decode time. Higher intervals (e.g. 1.0s) run faster on long clips. |
| `threshold` | `0.30` | Visual change score threshold `[0.0 - 1.0]`. | Lower thresholds (< 0.20) increase sensitivity to subtle cuts but may flag fast pans. Higher thresholds (> 0.50) ensure only stark cuts are accepted. |
| `minSceneDuration`| `1.0s` | Minimum duration of any resulting scene. | Prevents micro-scenes or flash cuts from fragmenting the timeline. |
| `startGuard` | `0.5s` | Exclusion band at the beginning of the video. | Ignores initial fade-ins or black frames at video start. |
| `endGuard` | `0.5s` | Exclusion band at the end of the video. | Ignores trailing fade-outs or black frames. |
| `maxSamples` | `1200` | Maximum number of frames evaluated per analysis. | Prevents runaway memory or execution loops on long media (10 minutes at 0.5s). |

---

## Confidence & Heuristic Scoring

Boundary confidence is a normalized strength indicator in `[0.0, 1.0]` calculated from how far the change score exceeds the detection threshold:

$$\text{confidence} = 0.50 + 0.50 \times \frac{\text{score} - \text{threshold}}{1.0 - \text{threshold}}$$

> [!NOTE]
> Confidence scores represent relative transition prominence above the threshold. They are **not** calibrated Bayesian probabilities.

---

## Output Data Format

The module returns a structured result object:

```json
{
  "duration": 12.0,
  "scenes": [
    { "index": 0, "start": 0, "end": 4.5, "duration": 4.5 },
    { "index": 1, "start": 4.5, "end": 8.0, "duration": 3.5 },
    { "index": 2, "start": 8.0, "end": 12.0, "duration": 4.0 }
  ],
  "boundaries": [
    { "time": 4.5, "score": 0.82, "confidence": 0.871, "transitionType": "cut" },
    { "time": 8.0, "score": 0.74, "confidence": 0.814, "transitionType": "cut" }
  ],
  "settings": {
    "sampleInterval": 0.5,
    "threshold": 0.3,
    "minSceneDuration": 1.0,
    "startGuard": 0.5,
    "endGuard": 0.5,
    "maxSamples": 1200
  },
  "stats": {
    "samplesAnalyzed": 25,
    "durationProcessed": 12.0,
    "processingTimeMs": 42,
    "cutsDetected": 2,
    "maxDifferenceScore": 0.82,
    "averageDifferenceScore": 0.14
  }
}
```

---

## Performance & Memory Management

- **Bounded Memory**: `detectScenesStream` processes sequentially and retains only the previous frame signature in memory. Total memory footprint during analysis is under 100 KB regardless of video length.
- **Downscaled Sampling**: Browser extraction draws into a compact 64x36 canvas (2,304 pixels), completing frame feature extraction in < 0.2ms per sample.
- **Resource Cleanup**: Temporary `<video>` elements, object URLs (`URL.revokeObjectURL`), and canvas contexts are explicitly released in `finally` blocks.
- **Cancellation**: Full support for `AbortSignal` across sequential seeking and stream analysis.

---

## Known Limitations

1. **Gradual Transitions**: Crossfades, dissolves, and wipes spread visual differences across multiple seconds with smaller inter-frame deltas. Phase 1 detects hard cuts. Multi-frame windowed accumulation for gradual transitions is planned for a subsequent milestone.
2. **Camera Motion & Strobe**: Rapid whip-pans or camera flashes may occasionally register as visual transitions if their delta exceeds the threshold. Adjusting `threshold` (e.g. 0.40–0.50) mitigates this in high-motion content.

---

## Running Automated Tests

Run the dedicated scene detection unit tests:

```bash
node --test server/tests/scene-detection.test.js
```

Or run all backend unit tests:

```bash
npm run test:backend
```
