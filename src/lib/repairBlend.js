const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] || 0;

// Estimate boundary color offset between true original perimeter pixels immediately
// outside rect and model inpainted pixels immediately inside rect perimeter.
// Never sample the model outside the mask, where generative weights drift warm/yellow.
export function repairColorOffset(original, cropData, width, height, crop, rect, maskPadding = 0) {
  const channels = [[], [], []];
  const sampleOrig = (x, y, c) => original[(y * width + x) * 4 + c];
  const sampleModel = (x, y, c) => cropData[((y - crop.y) * crop.width + (x - crop.x)) * 4 + c];

  const step = 2;
  // Top and bottom edges:
  for (let x = rect.x; x < rect.x + rect.width; x += step) {
    if (x <= 0 || x >= width - 1) continue;
    // Top edge:
    if (rect.y > 0 && rect.y < height &&
        x >= crop.x && x < crop.x + crop.width &&
        rect.y - 1 >= crop.y && rect.y < crop.y + crop.height) {
      let texture = 0;
      for (let c = 0; c < 3; c++) {
        texture += Math.abs(sampleOrig(x + 1, rect.y - 1, c) - sampleOrig(x - 1, rect.y - 1, c));
      }
      if (texture <= 48) {
        for (let c = 0; c < 3; c++) {
          channels[c].push(sampleOrig(x, rect.y - 1, c) - sampleModel(x, rect.y, c));
        }
      }
    }
    // Bottom edge:
    const by = rect.y + rect.height;
    if (by < height && by > 0 &&
        x >= crop.x && x < crop.x + crop.width &&
        by < crop.y + crop.height && by - 1 >= crop.y) {
      let texture = 0;
      for (let c = 0; c < 3; c++) {
        texture += Math.abs(sampleOrig(x + 1, by, c) - sampleOrig(x - 1, by, c));
      }
      if (texture <= 48) {
        for (let c = 0; c < 3; c++) {
          channels[c].push(sampleOrig(x, by, c) - sampleModel(x, by - 1, c));
        }
      }
    }
  }
  // Left and right edges:
  for (let y = rect.y; y < rect.y + rect.height; y += step) {
    if (y <= 0 || y >= height - 1) continue;
    // Left edge:
    if (rect.x > 0 && rect.x < width &&
        y >= crop.y && y < crop.y + crop.height &&
        rect.x - 1 >= crop.x && rect.x < crop.x + crop.width) {
      let texture = 0;
      for (let c = 0; c < 3; c++) {
        texture += Math.abs(sampleOrig(rect.x - 1, y + 1, c) - sampleOrig(rect.x - 1, y - 1, c));
      }
      if (texture <= 48) {
        for (let c = 0; c < 3; c++) {
          channels[c].push(sampleOrig(rect.x - 1, y, c) - sampleModel(rect.x, y, c));
        }
      }
    }
    // Right edge:
    const rx = rect.x + rect.width;
    if (rx < width && rx > 0 &&
        y >= crop.y && y < crop.y + crop.height &&
        rx < crop.x + crop.width && rx - 1 >= crop.x) {
      let texture = 0;
      for (let c = 0; c < 3; c++) {
        texture += Math.abs(sampleOrig(rx, y + 1, c) - sampleOrig(rx, y - 1, c));
      }
      if (texture <= 48) {
        for (let c = 0; c < 3; c++) {
          channels[c].push(sampleOrig(rx, y, c) - sampleModel(rx - 1, y, c));
        }
      }
    }
  }

  const raw = channels.map((values) => values.length < 12 ? 0 : clamp(median(values), -6, 6));
  const luma = (raw[0] + raw[1] + raw[2]) / 3;
  // Guard against chromatic discoloration (yellow / warm / cyan shifts):
  return raw.map((v) => clamp(v, Math.round(luma - 2), Math.round(luma + 2)));
}

export function blendRepairBoundary(original, repaired, rect, width, height) {
  // A large color difference needs a continuous transition, not a thinner one.
  // Keep the perimeter exactly anchored, including corners and very small boxes.
  const feather = Math.min(Math.max(1, (Math.min(rect.width, rect.height) - 1) / 2),
    clamp(Math.min(rect.width, rect.height) * 0.10, 3, 12));
  for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) {
    const i = (y * rect.width + x) * 4;
    const distance = Math.min(rect.x > 0 ? x : feather, rect.y > 0 ? y : feather,
      rect.x + rect.width < width ? rect.width - x - 1 : feather,
      rect.y + rect.height < height ? rect.height - y - 1 : feather);
    if (distance >= feather) continue;
    let texture = 0;
    const left = (y * rect.width + Math.max(0, x - 1)) * 4;
    const right = (y * rect.width + Math.min(rect.width - 1, x + 1)) * 4;
    const above = (Math.max(0, y - 1) * rect.width + x) * 4;
    const below = (Math.min(rect.height - 1, y + 1) * rect.width + x) * 4;
    for (let c = 0; c < 3; c++) {
      texture += Math.abs(original[left + c] - original[right + c]) + Math.abs(original[above + c] - original[below + c]);
    }
    // Detail can shorten the transition modestly, but cannot collapse a skin or
    // clothing seam to one pixel. Do not use color delta as a texture proxy.
    const localFeather = Math.max(Math.min(2, feather), feather / (1 + Math.min(1, texture / 120)));
    const t = clamp(distance / localFeather, 0, 1), alpha = t * t * (3 - 2 * t);
    for (let c = 0; c < 3; c++) repaired[i + c] = original[i + c] * (1 - alpha) + repaired[i + c] * alpha;
  }
}
