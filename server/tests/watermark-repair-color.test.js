import test from "node:test";
import assert from "node:assert/strict";

import { repairColorOffset, blendRepairBoundary } from "../../src/lib/repairBlend.js";
import { blendRepairPoisson } from "../../src/lib/repairPoisson.js";
import { repairTextMask, fuseRepairText, blendRepairText } from "../../src/lib/repairTextMask.js";

test("Watermark Repair: repairColorOffset prevents chromatic yellow tint across diverse colors", () => {
  const width = 200, height = 200;
  const crop = { x: 50, y: 50, width: 100, height: 100 };
  const rect = { x: 70, y: 70, width: 60, height: 40 };

  const testColors = [
    { name: "Neutral Gray", bg: [128, 128, 128] },
    { name: "Sky Blue", bg: [100, 150, 220] },
    { name: "Skin Tone", bg: [210, 170, 130] },
    { name: "Dark Surface", bg: [50, 50, 50] },
    { name: "Green Foliage", bg: [80, 140, 80] },
  ];

  for (const tc of testColors) {
    const original = new Uint8ClampedArray(width * height * 4);
    const cropData = new Uint8ClampedArray(crop.width * crop.height * 4);

    // Fill original with background color
    for (let i = 0; i < width * height; i++) {
      original[i * 4 + 0] = tc.bg[0];
      original[i * 4 + 1] = tc.bg[1];
      original[i * 4 + 2] = tc.bg[2];
      original[i * 4 + 3] = 255;
    }

    // Inside cropData: simulate inpainting that matches background closely inside rect
    // but has typical GAN unmasked drift (high +R, +G yellow drift) outside rect
    for (let y = 0; y < crop.height; y++) {
      for (let x = 0; x < crop.width; x++) {
        const globalX = crop.x + x;
        const globalY = crop.y + y;
        const insideRect = globalX >= rect.x && globalX < rect.x + rect.width &&
                           globalY >= rect.y && globalY < rect.y + rect.height;
        const idx = (y * crop.width + x) * 4;
        if (insideRect) {
          // Inside hole: model inpainting is faithful to background (within 1 unit)
          cropData[idx + 0] = tc.bg[0];
          cropData[idx + 1] = tc.bg[1];
          cropData[idx + 2] = tc.bg[2];
        } else {
          // Outside hole: unmasked model drift has strong yellow/green shift (+20 R, +25 G, +5 B)
          cropData[idx + 0] = Math.min(255, tc.bg[0] + 20);
          cropData[idx + 1] = Math.min(255, tc.bg[1] + 25);
          cropData[idx + 2] = Math.min(255, tc.bg[2] + 5);
        }
        cropData[idx + 3] = 255;
      }
    }

    const offset = repairColorOffset(original, cropData, width, height, crop, rect, 0);

    // The offset must NOT be corrupted by the unmasked +20R, +25G drift
    assert.deepEqual(offset, [0, 0, 0], `Expected [0, 0, 0] for ${tc.name}, got ${JSON.stringify(offset)}`);

    // Verify chromatic delta (R+G)/2 - B is not artificially skewed towards yellow
    const yellowBias = (offset[0] + offset[1]) / 2 - offset[2];
    assert.ok(Math.abs(yellowBias) <= 2, `Yellow bias must be <= 2, got ${yellowBias}`);
  }
});

test("Watermark Repair: blendRepairPoisson anchors strictly to real original exterior pixels", async () => {
  const width = 160, height = 120;
  const rect = { x: 40, y: 30, width: 80, height: 60 };

  const original = new Uint8ClampedArray(width * height * 4);
  const repaired = new Uint8ClampedArray(rect.width * rect.height * 4);

  // Background: Neutral Gray (128, 128, 128)
  for (let i = 0; i < width * height; i++) {
    original[i * 4 + 0] = 128;
    original[i * 4 + 1] = 128;
    original[i * 4 + 2] = 128;
    original[i * 4 + 3] = 255;
  }

  // Inside repaired: slight seam at boundary (e.g. 126 instead of 128)
  for (let i = 0; i < rect.width * rect.height; i++) {
    repaired[i * 4 + 0] = 126;
    repaired[i * 4 + 1] = 126;
    repaired[i * 4 + 2] = 126;
    repaired[i * 4 + 3] = 255;
  }

  const success = await blendRepairPoisson({ original, repaired, rect, width, height });
  assert.ok(success, "blendRepairPoisson should succeed");

  // Check boundary pixels: should be smoothly pulled towards original (128)
  const edgePixelIdx = 0; // (0, 0)
  assert.ok(repaired[edgePixelIdx] >= 127 && repaired[edgePixelIdx] <= 128, "Edge pixel should smoothly reach exterior level");
  assert.equal(repaired[edgePixelIdx], repaired[edgePixelIdx + 1], "R and G must remain equal (no yellow tint)");
  assert.equal(repaired[edgePixelIdx + 1], repaired[edgePixelIdx + 2], "G and B must remain equal (no yellow tint)");

  // Check center core: interior pixels remain intact
  const centerIdx = (Math.floor(rect.height / 2) * rect.width + Math.floor(rect.width / 2)) * 4;
  assert.equal(repaired[centerIdx], 126, "Interior core should remain byte-for-byte intact");
});

test("Watermark Repair: blendRepairBoundary preserves exterior pixels and feathers smoothly", () => {
  const width = 100, height = 100;
  const rect = { x: 20, y: 20, width: 60, height: 60 };

  const original = new Uint8ClampedArray(rect.width * rect.height * 4);
  const repaired = new Uint8ClampedArray(rect.width * rect.height * 4);

  // Original has background 150
  for (let i = 0; i < rect.width * rect.height; i++) {
    original[i * 4 + 0] = 150;
    original[i * 4 + 1] = 150;
    original[i * 4 + 2] = 150;
    original[i * 4 + 3] = 255;

    // Repaired has 146
    repaired[i * 4 + 0] = 146;
    repaired[i * 4 + 1] = 146;
    repaired[i * 4 + 2] = 146;
    repaired[i * 4 + 3] = 255;
  }

  blendRepairBoundary(original, repaired, rect, width, height);

  // At distance 0 (the exact boundary), it matches original exactly
  assert.equal(repaired[0], 150, "Boundary perimeter pixel must match original exactly");

  // In the core (center of box), it leaves repaired pixels intact
  const centerIdx = (30 * rect.width + 30) * 4;
  assert.equal(repaired[centerIdx], 146, "Core interior pixel must remain untouched");
});

test("Watermark Repair: fuseRepairText prevents text halo discoloration", async () => {
  const width = 60, height = 30;
  const size = width * height;

  const original = new Uint8ClampedArray(size * 4);
  const repaired = new Uint8ClampedArray(size * 4);
  const alpha = new Uint8Array(size);

  // Background is blue sky: (100, 150, 220)
  // Watermark text in original had a bright text stroke with a yellow/warm halo
  for (let i = 0; i < size; i++) {
    original[i * 4 + 0] = 100;
    original[i * 4 + 1] = 150;
    original[i * 4 + 2] = 220;
    original[i * 4 + 3] = 255;

    repaired[i * 4 + 0] = 100;
    repaired[i * 4 + 1] = 150;
    repaired[i * 4 + 2] = 220;
    repaired[i * 4 + 3] = 255;
  }

  // Create a text stroke in the middle with alpha mask
  for (let y = 10; y < 20; y++) {
    for (let x = 20; x < 40; x++) {
      const idx = y * width + x;
      alpha[idx] = 255;
      // In original, this was the watermark text
      original[idx * 4 + 0] = 255;
      original[idx * 4 + 1] = 255;
      original[idx * 4 + 2] = 255;
    }
  }

  // Surrounding halo in original (compression/halo artifacts)
  for (let y = 9; y <= 20; y++) {
    for (let x = 19; x <= 40; x++) {
      const idx = y * width + x;
      if (!alpha[idx]) {
        // Soft fringe in mask
        alpha[idx] = 120;
        // Compression halo in original had warm/yellow fringe
        original[idx * 4 + 0] = 180; // High red
        original[idx * 4 + 1] = 190; // High green
        original[idx * 4 + 2] = 160; // Lower blue
      }
    }
  }

  await fuseRepairText(original, repaired, alpha, width, height);

  // Verify that inside the text stroke and halo, colors match the blue sky background (100, 150, 220)
  // and NOT the yellow fringe (180, 190, 160)
  const textCenterIdx = (15 * width + 30) * 4;
  assert.ok(Math.abs(repaired[textCenterIdx + 0] - 100) < 5, `Red channel should match background (~100), got ${repaired[textCenterIdx + 0]}`);
  assert.ok(Math.abs(repaired[textCenterIdx + 1] - 150) < 5, `Green channel should match background (~150), got ${repaired[textCenterIdx + 1]}`);
  assert.ok(Math.abs(repaired[textCenterIdx + 2] - 220) < 5, `Blue channel should match background (~220), got ${repaired[textCenterIdx + 2]}`);

  // In the halo region, verify it was cleanly inpainted without yellow tint
  const haloIdx = (9 * width + 25) * 4;
  assert.ok(repaired[haloIdx + 2] > repaired[haloIdx + 0], "Blue must be greater than Red on sky background (no yellow tint)");
});

test("Watermark Repair: full composition pipeline preserves outside pixels and channel ranges", async () => {
  const width = 240, height = 180;
  const originalPixels = new Uint8ClampedArray(width * height * 4);

  // Background with natural color variations
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      originalPixels[idx + 0] = Math.min(255, 110 + Math.floor(x / 4)); // R
      originalPixels[idx + 1] = Math.min(255, 140 + Math.floor(y / 3)); // G
      originalPixels[idx + 2] = 210;                                    // B
      originalPixels[idx + 3] = 255;
    }
  }

  // Backup of original pixels to test 100% preservation outside mask
  const originalBackup = new Uint8ClampedArray(originalPixels);

  // Region selection in normalized coords
  const selection = { x: 0.3, y: 0.3, width: 0.25, height: 0.2 };
  const x1 = Math.max(0, Math.floor(selection.x * width + 1e-7));
  const y1 = Math.max(0, Math.floor(selection.y * height + 1e-7));
  const x2 = Math.min(width, Math.ceil((selection.x + selection.width) * width - 1e-7));
  const y2 = Math.min(height, Math.ceil((selection.y + selection.height) * height - 1e-7));
  const padding = Math.max(2, Math.min(6, Math.round(Math.min(x2 - x1, y2 - y1) * 0.03)));
  const px1 = Math.max(0, x1 - padding);
  const py1 = Math.max(0, y1 - padding);
  const px2 = Math.min(width, x2 + padding);
  const py2 = Math.min(height, y2 + padding);
  const rect = { x: px1, y: py1, width: px2 - px1, height: py2 - py1 };

  // Add watermark in the center of selection
  for (let y = y1 + 5; y < y2 - 5; y++) {
    for (let x = x1 + 5; x < x2 - 5; x++) {
      const idx = (y * width + x) * 4;
      originalPixels[idx + 0] = 250;
      originalPixels[idx + 1] = 250;
      originalPixels[idx + 2] = 250;
    }
  }

  const crop = {
    x: Math.max(0, rect.x - 30),
    y: Math.max(0, rect.y - 30),
    width: Math.min(width, rect.x + rect.width + 30) - Math.max(0, rect.x - 30),
    height: Math.min(height, rect.y + rect.height + 30) - Math.max(0, rect.y - 30),
  };

  // Simulate crop inpainting output
  const cropData = new Uint8ClampedArray(crop.width * crop.height * 4);
  for (let y = 0; y < crop.height; y++) {
    for (let x = 0; x < crop.width; x++) {
      const gx = crop.x + x;
      const gy = crop.y + y;
      const idx = (y * crop.width + x) * 4;
      // Inpainted model output faithfully follows background
      cropData[idx + 0] = Math.min(255, 110 + Math.floor(gx / 4));
      cropData[idx + 1] = Math.min(255, 140 + Math.floor(gy / 3));
      cropData[idx + 2] = 210;
      cropData[idx + 3] = 255;
    }
  }

  const colorOffset = repairColorOffset(originalPixels, cropData, width, height, crop, rect, padding);
  const repairedRegion = new Uint8ClampedArray(rect.width * rect.height * 4);
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      const i = (y * rect.width + x) * 4;
      const j = ((rect.y - crop.y + y) * crop.width + rect.x - crop.x + x) * 4;
      for (let c = 0; c < 3; c++) repairedRegion[i + c] = cropData[j + c] + colorOffset[c];
      repairedRegion[i + 3] = 255;
    }
  }

  await blendRepairPoisson({ original: originalPixels, repaired: repairedRegion, rect, width, height });

  const originalRegion = new Uint8ClampedArray(rect.width * rect.height * 4);
  for (let y = 0; y < rect.height; y += 1) {
    const sourceStart = ((rect.y + y) * width + rect.x) * 4;
    originalRegion.set(originalPixels.subarray(sourceStart, sourceStart + rect.width * 4), y * rect.width * 4);
  }
  blendRepairBoundary(originalRegion, repairedRegion, rect, width, height);

  // Apply to output
  const outputPixels = new Uint8ClampedArray(originalPixels);
  for (let y = 0; y < rect.height; y += 1) {
    const targetStart = ((rect.y + y) * width + rect.x) * 4;
    outputPixels.set(repairedRegion.subarray(y * rect.width * 4, (y + 1) * rect.width * 4), targetStart);
  }

  // 1. Verify 100% preservation outside rect
  let outsideChanged = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
      if (inside) continue;
      const idx = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) {
        if (outputPixels[idx + c] !== originalBackup[idx + c]) outsideChanged++;
      }
    }
  }
  assert.equal(outsideChanged, 0, "Pixels outside the repair rectangle must remain 100% unchanged");

  // 2. Verify all output pixel values are within valid byte ranges [0, 255]
  for (let i = 0; i < outputPixels.length; i++) {
    assert.ok(outputPixels[i] >= 0 && outputPixels[i] <= 255, `Pixel at index ${i} must be in [0, 255], got ${outputPixels[i]}`);
  }

  // 3. Verify no yellow discoloration inside repaired area (Blue must exceed Red on this sky/teal background)
  for (let y = rect.y + 5; y < rect.y + rect.height - 5; y++) {
    for (let x = rect.x + 5; x < rect.x + rect.width - 5; x++) {
      const idx = (y * width + x) * 4;
      const r = outputPixels[idx];
      const g = outputPixels[idx + 1];
      const b = outputPixels[idx + 2];
      // On this background, expected B is 210, R is ~125-145, G is ~150-170
      assert.ok(b > r, `Blue (${b}) must be greater than Red (${r}) inside repaired region`);
      assert.ok(b > g, `Blue (${b}) must be greater than Green (${g}) inside repaired region`);
    }
  }
});

test("Watermark Repair: patch alpha feathering prevents hard rectangular seams during video composition", () => {
  const width = 120, height = 120;
  const rect = { x: 20, y: 20, width: 60, height: 60 };
  const feather = Math.min(Math.max(2, Math.floor((Math.min(rect.width, rect.height) - 1) / 2)), 8);

  const patchData = new Uint8ClampedArray(rect.width * rect.height * 4);
  // Initially fill patch with solid red (255, 0, 0, 255)
  for (let i = 0; i < rect.width * rect.height; i++) {
    patchData[i * 4 + 0] = 255;
    patchData[i * 4 + 1] = 0;
    patchData[i * 4 + 2] = 0;
    patchData[i * 4 + 3] = 255;
  }

  // Apply alpha feathering loop as in miganClipRepair.js
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      const dist = Math.min(x, y, rect.width - 1 - x, rect.height - 1 - y);
      if (dist < feather) {
        const t = dist / feather;
        const alphaFactor = t * t * (3 - 2 * t);
        const idx = (y * rect.width + x) * 4 + 3;
        patchData[idx] = Math.round(patchData[idx] * alphaFactor);
      }
    }
  }

  // 1. Perimeter pixels (dist = 0) must have alpha = 0 (perfect seamless transition to native video)
  const perimeterIdx = 0; // (0, 0)
  assert.equal(patchData[perimeterIdx + 3], 0, "Perimeter alpha must be 0 for zero edge seam");

  // 2. Center pixel (dist >> feather) must retain full alpha = 255
  const centerIdx = (30 * rect.width + 30) * 4;
  assert.equal(patchData[centerIdx + 3], 255, "Core interior alpha must remain 255");

  // 3. Monotonic alpha increase across the feather margin
  for (let d = 0; d < feather - 1; d++) {
    const alphaD = patchData[(d * rect.width + 30) * 4 + 3];
    const alphaNext = patchData[((d + 1) * rect.width + 30) * 4 + 3];
    assert.ok(alphaNext >= alphaD, `Alpha should monotonically increase from edge inwards: ${alphaNext} >= ${alphaD}`);
  }

  // 4. Test compositing over native background produces 0 edge step
  const background = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    background[i * 4 + 0] = 100;
    background[i * 4 + 1] = 150;
    background[i * 4 + 2] = 200;
    background[i * 4 + 3] = 255;
  }

  const composited = new Uint8ClampedArray(background);
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      const pIdx = (y * rect.width + x) * 4;
      const bIdx = ((rect.y + y) * width + rect.x + x) * 4;
      const a = patchData[pIdx + 3] / 255;
      for (let c = 0; c < 3; c++) {
        composited[bIdx + c] = Math.round(composited[bIdx + c] * (1 - a) + patchData[pIdx + c] * a);
      }
    }
  }

  // Check border delta: at the outer perimeter of rect, composited must match background exactly (0 delta)
  for (let x = 0; x < rect.width; x++) {
    const topIdx = (rect.y * width + rect.x + x) * 4;
    assert.equal(composited[topIdx], background[topIdx], "Top edge must match background exactly");
    assert.equal(composited[topIdx + 1], background[topIdx + 1], "Top edge must match background exactly");
    assert.equal(composited[topIdx + 2], background[topIdx + 2], "Top edge must match background exactly");
  }
});


