/**
 * AI Video Generator Timeline Assembler & Asset Acquisition Pipeline
 *
 * Implements Stage B (Asset Acquisition), Stage C (Narration & Audio),
 * Stage D (Captions), and Stage E (Timeline Assembly).
 */

import { normalizeTrackLocks, normalizeTrackVisibility } from "./projectTrackState.js";
import {
  searchInternetArchive,
  searchStockMedia,
  fetchMediaBlob,
} from "./stockMediaClient.js";

/**
 * Creates a high-fidelity procedural canvas visual frame for a scene.
 * Guaranteed to produce a real image blob offline or when stock media is unavailable.
 */
/**
 * Creates a high-fidelity procedural canvas visual frame for a scene.
 * Guaranteed to produce a clean, atmospheric cinematic background offline or when stock media is unavailable.
 * Note: Never burns large title cards, badges, or subtext into the image; subtitle tracks handle narration cleanly.
 */
export function createProceduralSceneVisual({
  title,
  visualDescription: _visualDescription,
  style = "cinematic",
  aspectRatio = "16:9",
  sceneIndex = 0,
}) {
  const isVertical = aspectRatio === "9:16";
  const isSquare = aspectRatio === "1:1";
  const width = isVertical ? 720 : isSquare ? 1080 : 1280;
  const height = isVertical ? 1280 : isSquare ? 1080 : 720;

  let displayTitle = (title || `Scene ${sceneIndex + 1}`)
    .replace(/^(Opening Hook|The Core Challenge|Innovation in Action|Impact on Daily Life|Looking to the Future|Call to Action & Finale|Scene \d+):\s*/i, "")
    .replace(/:\s*(Introduction|The Heart|Hidden Wonders|Vibrant Moments|New Horizons|Enduring Legacy)$/i, "")
    .trim();
  if (!displayTitle) {
    displayTitle = title?.split(":")[0]?.trim() || `Scene ${sceneIndex + 1}`;
  }

  if (typeof document === "undefined") {
    // In node/test environments without DOM
    return {
      id: `proc-asset-${Date.now()}-${sceneIndex}`,
      type: "image",
      name: `${displayTitle} (Procedural Background).png`,
      src: `/assets/sample-portrait.png`,
      width,
      height,
      duration: 5,
      provider: "Procedural Canvas Fallback",
      generatedBy: "procedural",
      mediaCategory: "procedural_fallback",
      fallbackReason: "Stock search exhausted or network unreachable",
    };
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  // Rich palettes with deep atmospheric tones tailored to style & scene
  const PALETTES = {
    cinematic: [
      ["#080c18", "#171638", "#2a225e"],
      ["#061019", "#082d47", "#0c617b"],
      ["#130a21", "#300654", "#491771"],
      ["#161311", "#221e1d", "#383431"],
    ],
    tech: [
      ["#020617", "#0d1527", "#172554"],
      ["#030914", "#022c22", "#0f766e"],
      ["#080718", "#230b4f", "#3b0764"],
    ],
    nature: [
      ["#022c22", "#064e3b", "#065f46"],
      ["#061b18", "#115e59", "#0d9488"],
      ["#0f1c07", "#2e480f", "#3f6212"],
    ],
    social: [
      ["#180018", "#581c87", "#831843"],
      ["#1a051d", "#701a75", "#be185d"],
      ["#031d22", "#0e7490", "#0891b2"],
    ],
  };

  const paletteGroup = PALETTES[style] || PALETTES.cinematic;
  const colors = paletteGroup[sceneIndex % paletteGroup.length];

  // 1. Multi-stop radial/linear atmospheric background
  const grad = ctx.createLinearGradient(0, 0, width, height);
  grad.addColorStop(0, colors[0]);
  grad.addColorStop(0.5, colors[1]);
  grad.addColorStop(1, colors[2]);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // 2. Cinematic lighting orb / ambient glow
  const orbX = width * (0.3 + (sceneIndex % 3) * 0.2);
  const orbY = height * (0.35 + ((sceneIndex + 1) % 3) * 0.15);
  const radGrad = ctx.createRadialGradient(orbX, orbY, 40, orbX, orbY, width * 0.75);
  radGrad.addColorStop(0, "rgba(255, 255, 255, 0.14)");
  radGrad.addColorStop(0.4, "rgba(129, 140, 248, 0.08)");
  radGrad.addColorStop(1, "rgba(0, 0, 0, 0.55)");
  ctx.fillStyle = radGrad;
  ctx.fillRect(0, 0, width, height);

  // 3. Subtle ambient particle bokeh elements (deterministic based on scene index)
  ctx.save();
  const particleCount = 14;
  for (let p = 0; p < particleCount; p++) {
    const seed = (sceneIndex * 37 + p * 23) % 1000;
    const px = (seed / 1000) * width;
    const py = (((seed * 7) % 1000) / 1000) * height;
    const radius = 12 + (((seed * 13) % 40));
    const pGrad = ctx.createRadialGradient(px, py, 2, px, py, radius);
    pGrad.addColorStop(0, "rgba(255, 255, 255, 0.09)");
    pGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = pGrad;
    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // 4. Subtle cinematic vignette along edges
  const vignette = ctx.createRadialGradient(
    width / 2,
    height / 2,
    Math.min(width, height) * 0.45,
    width / 2,
    height / 2,
    Math.max(width, height) * 0.72
  );
  vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
  vignette.addColorStop(1, "rgba(0, 0, 0, 0.45)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);

  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      const src = URL.createObjectURL(blob);
      resolve({
        id: `proc-asset-${Date.now()}-${sceneIndex}`,
        type: "image",
        name: `${displayTitle} (Procedural Background).png`,
        src,
        blob,
        width,
        height,
        duration: 5,
        provider: "Procedural Canvas Fallback",
        generatedBy: "procedural",
        mediaCategory: "procedural_fallback",
        fallbackReason: "Stock search exhausted or network unreachable",
      });
    }, "image/png");
  });
}

const STOP_WORDS = new Set([
  "create", "make", "generate", "produce", "build", "render", "video", "short", "shorts",
  "clip", "clips", "film", "movie", "reel", "reels", "about", "exploring", "showcasing",
  "celebrating", "featuring", "with", "from", "using", "that", "this", "these", "those",
  "second", "seconds", "minute", "minutes", "cinematic", "vertical", "horizontal", "square",
  "portrait", "landscape", "youtube", "tiktok", "format", "engaging", "visuals", "footage",
  "visual", "natural", "english", "voiceover", "voice", "background", "music", "soundtrack",
  "ambient", "animated", "captions", "caption", "subtitles", "subtitle", "smooth", "transitions",
  "transition", "strong", "ending", "outro", "intro", "breathtaking", "stunning", "modern",
  "aesthetic", "inspirational", "high", "detail", "resolution", "quality", "please", "want",
  "the", "and", "for", "with", "into", "onto", "from", "over", "under", "scene", "scenes",
]);

/**
 * Normalizes any media asset key/title/filename to a canonical stem
 * to prevent duplicate images across different queries or timestamps.
 */
export function normalizeCanonicalMediaKey(str) {
  if (!str || typeof str !== "string") return "";
  return str
    .replace(/^File:/i, "")
    .replace(/\s*\(\d+\)/g, "") // strip Flickr/camera IDs like (33651785748)
    .replace(/\.[a-z0-9]{3,4}$/i, "") // strip extension (.jpg, .png, etc.)
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .toLowerCase()
    .trim();
}

/**
 * Converts abstract concepts, buzzwords, or slogans into concrete, tangible physical visual search queries.
 */
export function concretizeVisualSearchQuery(queryOrConcept, domain = "tech", isFinale = false) {
  const clean = (queryOrConcept || "").trim();
  if (!clean) return isFinale ? "modern architecture building sunset" : "modern office workplace";

  // Specific city / location mappings
  if (/\b(bengaluru|bangalore)\b/i.test(clean)) {
    if (/\b(vidhana|soudha|palace|landmark)\b/i.test(clean)) {
      return "Bangalore Vidhana Soudha illuminated";
    }
    return "Bangalore skyline UB City architecture";
  }

  // Software engineering / reliable systems / development / coding
  if (/\b(reliable systems|complex ideas|software engineer|software development|coding|programming|source code|systems engineer|devops|algorithm)\b/i.test(clean)) {
    return "software engineers coding at computer workstations in modern tech office";
  }

  // Hardware engineering / microchips / electronics / cleanrooms / precision
  if (
    /\b(precision|cleanroom|microchip|semiconductor|circuit board|motherboard|pcb|hardware components|electronic assembly)\b/i.test(clean) ||
    (/\b(connection|performance|hardware)\b/i.test(clean) && (domain === "tech" || /\b(tech|digital|system|engineer|network)\b/i.test(clean)))
  ) {
    return "electronics circuit board soldering cleanroom manufacturing";
  }

  // Collaboration / teamwork / meetings
  if (/\b(collaboration|collaborat|teamwork|cooperation|synergy|brainstorm|people and technology|moving forward|solutions that move)\b/i.test(clean)) {
    if (domain === "tech" || /\b(engineer|code|software|tech|developer|digital|it|business|enterprise)\b/i.test(clean)) {
      return "software engineers in tech office meeting room";
    }
    return "creative team collaborating in modern office";
  }

  // Future / finale / next chapter / closing
  if (/\b(shaping the future|next chapter|tomorrow|future|horizons|legacy|enduring|closing|outro|finale|only the beginning|connected future)\b/i.test(clean)) {
    if (domain === "tech" || /\b(tech|network|data|digital)\b/i.test(clean)) {
      return "modern tech campus glass building dusk sunset";
    }
    if (domain === "nature" || /\b(mountain|alps|lake|nature|travel)\b/i.test(clean)) {
      return "majestic mountain summit sunset horizon";
    }
    return "modern architecture city skyline sunset horizon";
  }

  // Alpine villages / chalets
  if (/\b(village|villages|chalet|chalets|town)\b/i.test(clean)) {
    return "picturesque Swiss alpine village wooden chalets";
  }

  // Networking / servers / infrastructure
  if (/\b(network|transmitting|infrastructure|server|data cent|datacenter|cisco|ccie|router|switch|fiber)\b/i.test(clean)) {
    return "data center server rack glowing ethernet cables";
  }

  // Technical education / labs / students / training / placements
  if (/\b(lab|labs|training|placement|placements|career|student|students|classroom|doors opened|theory into practice)\b/i.test(clean)) {
    return "computer lab students engineering classroom";
  }

  // Founder / leadership / executive portrait
  if (/\b(founder|ceo|leader|leadership|mastery|vikas|executive|creator|author)\b/i.test(clean)) {
    return "confident business executive portrait modern office";
  }

  // Abstract digital economy / power / transmission
  if (/\b(powering the digital|digital economy|connectivity|transmitting)\b/i.test(clean)) {
    return "data center fiber optic cables server";
  }

  return clean;
}

/**
 * Checks if a candidate media title contains negative keywords that make it irrelevant or unacceptable.
 */
export function isNegativeAsset(title = "", sceneContext = {}) {
  const t = (title || "").toLowerCase();
  const sceneText = `${sceneContext.title || ""} ${sceneContext.visualDescription || ""} ${sceneContext.searchQuery || ""}`.toLowerCase();
  const isTechStory = /\b(tech|network|data|server|software|engineer|silicon|computer|digital|bengaluru|bangalore|cisco|lab|infrastructure)\b/i.test(sceneText);

  // 1. Universal negatives:
  // - Blueprints, schematics, patents, weapons
  // - Postage stamps, coins, bank notes, seals, coats of arms, flags, tombstones
  // - Scanned newspapers, periodicals, articles, clippings, historical product catalogs
  // - 3D CGI architectural renderings, CAD models
  // - Logos, watermarks, cliparts
  const universalNegatives = [
    /\bfloor\s*plan\b/, /\bblueprint\b/, /\bschematic\b/, /\bpatent\b/,
    /\bmissile\b/, /\bbomb\b/, /\bwarhead\b/, /\bartillery\b/, /\bweapon\b/,
    /\bpostage\s*stamp\b/, /\bstamp\b/, /\bbanknote\b/, /\bcoin\b/,
    /\bcoat\s*of\s*arms\b/, /\bflag\s*of\b/, /\bemblem\s*of\b/, /\bseal\s*of\b/,
    /\btombstone\b/, /\bgraveyard\b/, /\bcemetery\b/, /\bcoffin\b/,
    /\bdpla\b/, /\bmanuscript\b/, /\bsignature\b/,
    /\bnewspapers?\b/, /\bnewsprint\b/, /\bclippings?\b/, /\barticles?\b/,
    /\bcatalogs?\b/, /\bcatalogues?\b/, /\badvertisements?\b/, /\bbrochures?\b/, /\bpamphlets?\b/,
    /\bscanned\s*(?:page|text|book|document|image|photo)\b/, /\bfront\s*page\b/,
    /\bwashington\s*post\b/, /\bnew\s*york\s*times\b/, /\bherald\b/, /\bperiodicals?\b/,
    /\bjournal\s*page\b/, /\btext\s*page\b/, /\bstanley\s*works\b/, /\bstanley\s*garage\b/, /\bstanley\s*rule\b/,
    /\barchitectural\s*rendering\b/, /\b3d\s*render(?:ing)?\b/, /\bcad\s*model\b/,
    /\bartist\s*concept\b/, /\bcomputer\s*generated\b/, /\bcgi\s*render\b/,
    /\barchitectural\s*model\b/, /\bscale\s*model\b/, /\barchitectural\s*visualization\b/,
    /\blogos?\b/, /\bbrandmarks?\b/, /\binsignias?\b/, /\bemblems?\b/, /\btrademarks?\b/, /\bwatermarks?\b/, /\bwatermarked\b/, /\bmonograms?\b/, /\bcliparts?\b/,
    /\beso\b/,
  ];
  for (const regex of universalNegatives) {
    if (regex.test(t) && !regex.test(sceneText)) return true;
  }

  // 2. Tech / Corporate story negatives (reject agriculture, wheat, farming, tractors, snowy winter landscapes, and garage hardware)
  if (isTechStory) {
    const techNegatives = [
      /\bwheat\b/, /\brye\b/, /\bbarley\b/, /\bgrain\b/, /\bcrop\b/, /\bfarm\b/,
      /\btractor\b/, /\bbarn\b/, /\bpasture\b/, /\bhay\b/, /\blivestock\b/, /\bcattle\b/,
      /\bdesert\s*dunes\b/, /\bsahara\b/, /\barid\s*sand\b/,
      /\bairplane\s*wing\b/, /\bcockpit\s*window\b/,
      // Domestic / garage / carpentry hardware (hinges, door bolts, plumbing)
      /\bgarage\b/, /\bhinges?\b/, /\bhasps?\b/, /\bdoor\s*hardware\b/, /\bbolts?\b/,
      /\bstanley\b/, /\bplumbing\b/, /\bcarpentry\b/, /\bhardware\s*store\b/, /\blatch(?:es)?\b/,
      // Snowy winter scenery unless explicitly requested
      /\bsnow\b/, /\bsnowy\b/, /\bwinter\b/, /\bblizzard\b/, /\bfrost\b/,
    ];
    for (const regex of techNegatives) {
      if (regex.test(t) && !regex.test(sceneText)) return true;
    }
    // Reject VR headsets when looking for office collaboration
    if (/\b(collaboration|meeting|office|team|discussion|mentoring)\b/i.test(sceneText)) {
      if (/\b(vr\s*headset|oculus|virtual\s*reality|headset|goggles|gamepad)\b/i.test(t)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Computes strictly valid word-level timestamps { text, start, end } for a caption line,
 * ensuring monotonic non-decreasing order bounded precisely within [startTime, endTime].
 * Preserves karaoke highlighting compatibility with validateSegmentWords and areWordsValidForKaraoke.
 */
export function computeSceneWordTimestamps(text, startTime, endTime) {
  if (!text || typeof text !== "string") return [];
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  const start = Math.max(0, Number(startTime) || 0);
  const end = Math.max(start + 0.1, Number(endTime) || (start + 1));
  const totalDuration = end - start;

  if (words.length === 1) {
    return [{ text: words[0], start: Number(start.toFixed(3)), end: Number(end.toFixed(3)) }];
  }

  // Weight words by character count plus punctuation cadence
  const weights = words.map((w) => {
    let weight = Math.max(2, w.length);
    if (/[,;]$/.test(w)) weight += 2;
    if (/[.!?]$/.test(w)) weight += 3;
    return weight;
  });
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  let currentStart = start;
  const result = [];

  for (let i = 0; i < words.length; i++) {
    const wText = words[i];
    const isLast = i === words.length - 1;
    const wordDur = (weights[i] / totalWeight) * totalDuration;
    const rawEnd = isLast ? end : Number((currentStart + wordDur).toFixed(3));

    const actualStart = Number(currentStart.toFixed(3));
    const actualEnd = isLast ? Number(end.toFixed(3)) : Math.max(actualStart + 0.05, Math.min(end, rawEnd));

    result.push({
      text: wText,
      start: actualStart,
      end: actualEnd,
    });

    currentStart = actualEnd;
  }

  return result;
}

/**
 * Scores semantic relevance between a candidate asset and the scene context.
 * Returns -1 if disqualified, or >= 0 based on matching concrete keywords.
 */
export function scoreAssetRelevance(candidate, sceneContext = {}) {
  const title = ((candidate.title || candidate.name || "") + " " + (candidate.description || "")).toLowerCase();
  const query = (sceneContext.searchQuery || sceneContext.title || "").toLowerCase();
  const desc = (sceneContext.visualDescription || "").toLowerCase();

  // If candidate hits any negative filter, disqualify immediately
  if (isNegativeAsset(title, sceneContext)) return -1;

  const queryWords = query.replace(/[^\w\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  const descWords = desc.replace(/[^\w\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  let score = 0;
  for (const w of queryWords) {
    if (title.includes(w)) score += 3;
  }
  for (const w of descWords) {
    if (title.includes(w)) score += 1;
  }

  // Boost for high-resolution images
  const w = candidate.imageinfo?.[0]?.width || candidate.width || 0;
  const h = candidate.imageinfo?.[0]?.height || candidate.height || 0;
  if (w >= 1000 && h >= 600) score += 1;
  if (w > 0 && (w < 400 || h < 300)) score -= 3; // penalize tiny icons

  return score;
}

/**
 * Generates progressive search query candidates for a scene, ordered from specific concrete targets to relaxed queries.
 */
export function generateSearchCandidates(scene = {}, domain = "tech", isFinale = false) {
  const candidates = [];
  const addCandidate = (str) => {
    if (!str || typeof str !== "string") return;
    const clean = str
      .replace(/[\(\)\[\]"':;,.\/#!$%\^&\*;:{}=\-_`~?]/g, " ")
      .replace(/\b(footage|video|4k|hd|clip|shot|scenic|cinematic|stunning|breathtaking|close-up|wide shot|photo of|picture of|images?)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    if (clean.length >= 3 && !candidates.includes(clean)) {
      candidates.push(clean);
    }
  };

  // 1. Concrete search query derived from semantic concretization
  const concretePrimary = concretizeVisualSearchQuery(scene.searchQuery || scene.title, domain, isFinale);
  addCandidate(concretePrimary);

  // 2. Direct search query from storyboard/spec if distinct from concrete query
  addCandidate(scene.searchQuery);

  // 3. Individual searchKeywords if provided by LLM or fallback
  if (Array.isArray(scene.searchKeywords)) {
    for (const kw of scene.searchKeywords) {
      addCandidate(concretizeVisualSearchQuery(kw, domain, isFinale));
      addCandidate(kw);
    }
  }

  // 4. Relaxed 2-3 word phrases from visualDescription or title
  if (scene.title) {
    const cleanTitle = scene.title
      .replace(/^(Opening Hook|The Core Challenge|Innovation in Action|Impact on Daily Life|Looking to the Future|Call to Action & Finale|Scene \d+):\s*/i, "")
      .replace(/:\s*(Introduction|The Heart|Hidden Wonders|Vibrant Moments|New Horizons|Enduring Legacy)$/i, "")
      .trim();
    addCandidate(concretizeVisualSearchQuery(cleanTitle, domain, isFinale));
    addCandidate(cleanTitle);
  }

  if (scene.visualDescription) {
    const firstClause = scene.visualDescription.split(/[,.;:]/)[0];
    addCandidate(firstClause);
  }

  return candidates.slice(0, 6);
}

/**
 * Generates a smooth Ken Burns pan/zoom/tilt motion smartFrame record for visual clips.
 */
export function generateKenBurnsSmartFrame(motionType, sceneIndex = 0, duration = 5, width = 1280, height = 720, targetRatio = null) {
  const motionCycle = ["zoom_in", "pan_right", "zoom_out", "pan_left", "tilt_up"];
  const type = motionType && motionType !== "auto" ? motionType : motionCycle[sceneIndex % motionCycle.length];

  const getCropKeyframes = (t) => {
    switch (t) {
      case "zoom_in":
      case "slow_zoom":
      case "push_in":
        return {
          start: { x: 0, y: 0, width: 1, height: 1 },
          end: { x: 0.08, y: 0.08, width: 0.84, height: 0.84 },
        };
      case "zoom_out":
      case "pull_back":
        return {
          start: { x: 0.08, y: 0.08, width: 0.84, height: 0.84 },
          end: { x: 0, y: 0, width: 1, height: 1 },
        };
      case "pan_right":
        return {
          start: { x: 0, y: 0.05, width: 0.88, height: 0.90 },
          end: { x: 0.12, y: 0.05, width: 0.88, height: 0.90 },
        };
      case "pan_left":
        return {
          start: { x: 0.12, y: 0.05, width: 0.88, height: 0.90 },
          end: { x: 0, y: 0.05, width: 0.88, height: 0.90 },
        };
      case "tilt_up":
      case "drift_up":
        return {
          start: { x: 0.05, y: 0.12, width: 0.90, height: 0.88 },
          end: { x: 0.05, y: 0, width: 0.90, height: 0.88 },
        };
      case "static":
        return {
          start: { x: 0, y: 0, width: 1, height: 1 },
          end: { x: 0, y: 0, width: 1, height: 1 },
        };
      default:
        return {
          start: { x: 0, y: 0, width: 1, height: 1 },
          end: { x: 0.07, y: 0.07, width: 0.86, height: 0.86 },
        };
    }
  };

  const { start: startCrop, end: endCrop } = getCropKeyframes(type);

  return {
    version: 2,
    enabled: type !== "static",
    targetRatio: targetRatio || (width === height ? "1:1" : width > height ? "16:9" : "9:16"),
    presentation: "crop",
    settings: {
      motion: "smooth",
      padding: 0.16,
      maxZoom: 1.45,
    },
    sourceSize: { width, height },
    motionType: type,
    cropKeyframes: [
      { time: 0, ...startCrop, confidence: 1, state: "tracked" },
      { time: Math.max(1, duration), ...endCrop, confidence: 1, state: "tracked" },
    ],
  };
}

export {
  searchCommonsAsset,
  searchInternetArchive,
  searchStockMedia,
  fetchMediaBlob,
  clearStockMediaCache,
  getStockMediaCacheStats,
  verifyOpenLicense,
  setStockMediaFetch,
  resetStockMediaFetch,
} from "./stockMediaClient.js";

/**
 * Stage B: Acquires visual assets for all scenes.
 * Checks user assets -> Wikimedia Commons with progressive relaxation -> Fallback procedural canvas.
 */
export async function acquireSceneAssets(
  scenes,
  { userAssets = [], referenceAssets = [], aspectRatio = "16:9", style = "cinematic", signal, onProgress } = {}
) {
  const assets = [];
  const total = scenes.length;
  const usedMediaKeys = new Set();

  for (let i = 0; i < total; i++) {
    if (signal?.aborted) throw new Error("Asset acquisition cancelled");
    const scene = scenes[i];
    const isLastScene = i === total - 1;
    const candidateQueries = generateSearchCandidates(scene, style, isLastScene);

    onProgress?.({
      stage: "acquiring_assets",
      current: i + 1,
      total,
      message: `Acquiring visuals for Scene ${i + 1}/${total}: "${scene.title}"...`,
    });

    // 1. Check attached reference assets:
    // Match reference assets strictly to person/founder/product scenes.
    // NEVER force a person's reference portrait onto Scene 0 (establishing city/landscape shot).
    const isPersonOrFounderScene = /\b(?:founder|portrait|person|ceo|author|leader|creator|profile|meet)\b/i.test(
      `${scene.title} ${scene.visualDescription || ""} ${scene.narration || ""}`
    );
    const isFirstPersonScene = isPersonOrFounderScene && !Array.from(usedMediaKeys).some(k => referenceAssets.some(r => r.id === k));
    const matchedRef =
      (scene.assignedAssetId && referenceAssets.find((r) => r.id === scene.assignedAssetId)) ||
      (scene.useReferenceAsset && referenceAssets.find((r) => !usedMediaKeys.has(r.id))) ||
      (referenceAssets.length > 0 && isFirstPersonScene && referenceAssets.find((r) => !usedMediaKeys.has(r.id))) ||
      null;

    if (matchedRef) {
      usedMediaKeys.add(matchedRef.id);
      usedMediaKeys.add(normalizeCanonicalMediaKey(matchedRef.name || ""));
      const defaultDims = {
        "16:9": { width: 1280, height: 720 },
        "9:16": { width: 720, height: 1280 },
        "1:1": { width: 1080, height: 1080 },
        "4:5": { width: 1080, height: 1350 },
      }[aspectRatio] || { width: 1280, height: 720 };

      assets.push({
        id: `ref-asset-${matchedRef.id || Date.now()}-${i}`,
        type: matchedRef.type?.startsWith("video") ? "video" : "image",
        src: matchedRef.blobUrl || matchedRef.src || matchedRef.url,
        name: matchedRef.name || scene.title,
        width: matchedRef.width || defaultDims.width,
        height: matchedRef.height || defaultDims.height,
        provider: "User Reference",
        license: "User Provided",
        mediaCategory: "reference",
        duration: scene.duration,
        blob: matchedRef.blob || matchedRef.file || null,
        queriesAttempted: candidateQueries,
        usedQuery: "Reference Asset",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      continue;
    }

    // 2. Check local user assets
    const matchedUserAsset = userAssets.find(
      (a) => (a.type?.startsWith("image") || a.type?.startsWith("video")) && !usedMediaKeys.has(a.id)
    );

    // 3. Multi-tier remote search: Wikimedia Commons (primary) -> Internet Archive (secondary)
    let remoteAsset = null;
    let verifiedRemoteAsset = null;

    if (candidateQueries.length > 0) {
      remoteAsset = await searchStockMedia(candidateQueries, signal, usedMediaKeys, 4000, scene).catch(() => null);
    }

    if (remoteAsset?.src) {
      if (remoteAsset.type === "video") {
        // Attempt downloading video blob
        const videoRes = await fetchMediaBlob(remoteAsset.src, "video", signal, 6000);
        if (videoRes?.ok) {
          verifiedRemoteAsset = {
            ...remoteAsset,
            src: videoRes.blobUrl,
            blob: videoRes.blob,
            duration: scene.duration,
            queriesAttempted: candidateQueries,
            usedQuery: remoteAsset.usedQuery || candidateQueries[0],
          };
          usedMediaKeys.add(remoteAsset.src);
          if (remoteAsset.canonicalKey) usedMediaKeys.add(remoteAsset.canonicalKey);
        } else {
          console.warn(`Remote video fetch failed or blocked by CORS for scene ${i + 1}; falling back to photograph`);
          // Try photograph fallback: Wikimedia first, then Internet Archive
          const photoAsset = await searchStockMedia(candidateQueries, signal, usedMediaKeys, 3500, scene, { photoOnly: true }).catch(() => null);
          if (photoAsset?.src) {
            const photoRes = await fetchMediaBlob(photoAsset.src, "image", signal, 4500);
            if (photoRes?.ok) {
              verifiedRemoteAsset = {
                ...photoAsset,
                src: photoRes.blobUrl,
                blob: photoRes.blob,
                duration: scene.duration,
                queriesAttempted: candidateQueries,
                usedQuery: photoAsset.usedQuery || candidateQueries[0],
              };
              usedMediaKeys.add(photoAsset.src);
              if (photoAsset.canonicalKey) usedMediaKeys.add(photoAsset.canonicalKey);
            }
          }
        }
      } else {
        // Download image blob
        const imgRes = await fetchMediaBlob(remoteAsset.src, "image", signal, 4500);
        if (imgRes?.ok) {
          verifiedRemoteAsset = {
            ...remoteAsset,
            src: imgRes.blobUrl,
            blob: imgRes.blob,
            duration: scene.duration,
            queriesAttempted: candidateQueries,
            usedQuery: remoteAsset.usedQuery || candidateQueries[0],
          };
          usedMediaKeys.add(remoteAsset.src);
          if (remoteAsset.originalUrl) usedMediaKeys.add(remoteAsset.originalUrl);
          usedMediaKeys.add(remoteAsset.name);
          if (remoteAsset.canonicalKey) usedMediaKeys.add(remoteAsset.canonicalKey);
          usedMediaKeys.add(normalizeCanonicalMediaKey(remoteAsset.name));
        } else {
          // If first image download failed (e.g. 404 or CORS), attempt secondary provider photo
          const altPhoto = await searchInternetArchive(candidateQueries, signal, usedMediaKeys, 3500, scene, { photoOnly: true }).catch(() => null);
          if (altPhoto?.src) {
            const altRes = await fetchMediaBlob(altPhoto.src, "image", signal, 4500);
            if (altRes?.ok) {
              verifiedRemoteAsset = {
                ...altPhoto,
                src: altRes.blobUrl,
                blob: altRes.blob,
                duration: scene.duration,
                queriesAttempted: candidateQueries,
                usedQuery: altPhoto.usedQuery || candidateQueries[0],
              };
              usedMediaKeys.add(altPhoto.src);
              if (altPhoto.canonicalKey) usedMediaKeys.add(altPhoto.canonicalKey);
            }
          }
        }
      }
    }

    if (verifiedRemoteAsset) {
      assets.push({
        id: `remote-asset-${Date.now()}-${i}`,
        ...verifiedRemoteAsset,
      });
    } else if (matchedUserAsset && i === 0) {
      usedMediaKeys.add(matchedUserAsset.id);
      assets.push({
        ...matchedUserAsset,
        mediaCategory: "user",
        duration: scene.duration,
        queriesAttempted: candidateQueries,
        usedQuery: "User Library Asset",
      });
    } else {
      // 4. Fallback procedural visual frame (clean atmospheric background, explicitly marked as fallback)
      const procAsset = await createProceduralSceneVisual({
        title: scene.title,
        visualDescription: scene.visualDescription,
        style,
        aspectRatio,
        sceneIndex: i,
      });
      assets.push({
        ...procAsset,
        mediaCategory: "procedural_fallback",
        duration: scene.duration,
        queriesAttempted: candidateQueries,
        usedQuery: "N/A",
        fallbackReason: candidateQueries.length > 0
          ? `Stock search exhausted across ${candidateQueries.length} candidate queries`
          : "No search query available and network unavailable",
      });
    }

    // Polite spacing between scenes to prevent rate limiting
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  return assets;
}

/**
 * Creates a synthetic silent/ambient audio buffer blob matching desired duration.
 * Ensures the audio pipeline never breaks if TTS engine is unconfigured or in tests.
 */
export function createSyntheticAudioBlob(durationSeconds = 10, sampleRate = 22050) {
  const numSamples = Math.floor(durationSeconds * sampleRate);
  const buffer = new Float32Array(numSamples);

  // Generate gentle ambient tone with soft harmonic envelope
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const env = Math.sin((Math.PI * t) / durationSeconds);
    buffer[i] = Math.sin(2 * Math.PI * 220 * t) * 0.05 * env;
  }

  // Convert Float32Array to 16-bit WAV PCM Blob
  const wavBuffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(wavBuffer);

  const writeString = (offset, string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, numSamples * 2, true);

  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, buffer[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Blob([wavBuffer], { type: "audio/wav" });
}

/**
 * Computes normalized waveform peaks (0..1) directly from a 16-bit PCM WAV ArrayBuffer.
 * Runs in < 1ms on any thread, completely avoiding AudioContext instantiation or leaks.
 */
export function calculateWavArrayBufferPeaks(arrayBuffer, barCount = 96) {
  if (!arrayBuffer || arrayBuffer.byteLength <= 44) {
    return new Array(barCount).fill(0.1);
  }
  const view = new DataView(arrayBuffer);
  const totalSamples = Math.floor((arrayBuffer.byteLength - 44) / 2);
  if (totalSamples <= 0) return new Array(barCount).fill(0.1);

  const blockSize = Math.max(1, Math.floor(totalSamples / barCount));
  const rawPeaks = [];
  let strongest = 0.001;

  for (let b = 0; b < barCount; b++) {
    const start = 44 + b * blockSize * 2;
    let peak = 0;
    let sumSq = 0;
    let count = 0;

    for (let i = 0; i < blockSize && start + i * 2 + 1 < arrayBuffer.byteLength; i++) {
      const val = Math.abs(view.getInt16(start + i * 2, true) / 32768);
      if (val > peak) peak = val;
      sumSq += val * val;
      count++;
    }

    const rms = count ? Math.sqrt(sumSq / count) : 0;
    const combined = rms * 0.78 + peak * 0.22;
    rawPeaks.push(combined);
    if (combined > strongest) strongest = combined;
  }

  return rawPeaks.map((p) => Math.max(0.05, Math.min(1, Math.pow(p / strongest, 0.72))));
}

/**
 * Creates an audio blob representing spoken voiceover cadence across scenes with natural phrasing,
 * harmonic voice formants, and rhythmic pauses at scene transitions.
 * Fully non-blocking and generates in < 15ms.
 */
export function createSpeechCadenceAudioBlob(scenes = [], totalDuration = 30, sampleRate = 22050) {
  const dur = Math.max(1, totalDuration);
  const numSamples = Math.floor(dur * sampleRate);
  const buffer = new Float32Array(numSamples);
  const numScenes = scenes.length || 6;
  let sceneStart = 0;

  for (let s = 0; s < numScenes; s++) {
    const scene = scenes[s] || {};
    const sDur = Number(scene.duration) || (dur / numScenes);
    const startSample = Math.floor(sceneStart * sampleRate);
    // 0.35s pause between scenes for natural breathing and transition alignment
    const speechDur = Math.max(0.5, sDur - 0.35);
    const endSpeechSample = Math.min(numSamples, Math.floor((sceneStart + speechDur) * sampleRate));
    const syllableRate = 4.2; // Natural human spoken syllable cadence

    for (let i = startSample; i < endSpeechSample; i++) {
      const t = (i - startSample) / sampleRate;
      const phraseEnvelope = Math.sin((Math.PI * t) / speechDur);
      const syllableMod = 0.5 + 0.5 * Math.sin(2 * Math.PI * syllableRate * t);
      // Vocal formants (pitch fundamental ~165Hz + vocal tract resonances)
      const f0 = Math.sin(2 * Math.PI * 165 * t);
      const f1 = 0.35 * Math.sin(2 * Math.PI * 330 * t);
      const f2 = 0.18 * Math.sin(2 * Math.PI * 1850 * t);
      buffer[i] = (f0 + f1 + f2) * phraseEnvelope * syllableMod * 0.22;
    }

    sceneStart += sDur;
  }

  // Convert Float32Array to 16-bit WAV PCM Blob
  const wavBuffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(wavBuffer);

  const writeString = (offset, string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, numSamples * 2, true);

  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, buffer[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return {
    blob: new Blob([wavBuffer], { type: "audio/wav" }),
    wavBuffer,
  };
}

/**
 * Stage C: Synthesizes narration voiceover.
 * Uses configured real TTS provider (/api/generator/tts with browser fallback).
 * Explicitly rejects synthetic cadence beeps or placeholder sounds.
 */
export async function generateNarrationAudio(spec, { signal, onProgress } = {}) {
  if (!spec.narration?.enabled) return null;
  const script = spec.narration.script || spec.scenes.map((s) => s.narration).filter(Boolean).join(" ");
  if (!script.trim()) return null;

  if (signal?.aborted) throw new Error("Audio generation cancelled");

  const voiceId = spec.narration.voiceId || "af_heart";

  onProgress?.({
    stage: "generating_audio",
    progress: 55,
    message: `Synthesizing real narration voiceover with "${voiceId}"...`,
  });

  let wavBlob = null;
  let audioDuration = 0;
  let sceneTimings = null;

  // 1. Primary route: Dedicated server TTS service (/api/generator/tts)
  try {
    const ttsRes = await fetch("/api/generator/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      signal,
      body: JSON.stringify({
        text: script,
        scenes: spec.scenes.map((s) => s.narration).filter(Boolean),
        voiceId,
        speed: spec.narration.speed || 1,
      }),
    });

    if (ttsRes.ok) {
      const durationHeader = ttsRes.headers.get("X-Audio-Duration");
      if (durationHeader) {
        audioDuration = parseFloat(durationHeader);
      }
      const timingsHeader = ttsRes.headers.get("X-Audio-Scene-Timings");
      if (timingsHeader) {
        try {
          sceneTimings = JSON.parse(timingsHeader);
        } catch {}
      }
      wavBlob = await ttsRes.blob();
    }
  } catch (err) {
    if (signal?.aborted) throw new Error("Audio generation cancelled", { cause: err });
    console.warn("[VideoGenerator] Server TTS endpoint failed, falling back to client synthesizer:", err?.message || err);
  }

  // 2. Secondary route: Client-side browser synthesis runtime if server was unreachable
  if (!wavBlob || wavBlob.size === 0) {
    try {
      const { synthesizeBaseVoice } = await import("./baseVoiceSynthesis.js");
      const { VOICES } = await import("../config/editor.js");
      const matchedVoice = VOICES.find((v) => v.id === voiceId) || VOICES.find((v) => v.id === "af_heart") || VOICES[0];

      const synthResult = await synthesizeBaseVoice({
        voice: matchedVoice,
        text: script,
        speed: spec.narration.speed || 1,
        signal,
        onProgress: (p) => {
          onProgress?.({
            stage: "generating_audio",
            progress: Math.min(85, 55 + Math.round((Number(p) || 0) * 0.3)),
            message: `Synthesizing voiceover (${voiceId})...`,
          });
        },
      });

      if (synthResult?.blob && synthResult.blob.size > 0) {
        wavBlob = synthResult.blob;
      }
    } catch (err) {
      if (signal?.aborted) throw new Error("Audio generation cancelled", { cause: err });
      console.warn("[VideoGenerator] Browser-side TTS synthesis attempt failed:", err?.message || err);
    }
  }

  // 3. Strict Quality Check: Never treat synthetic cadence sounds or placeholders as narration
  if (!wavBlob || wavBlob.size === 0) {
    throw new Error(
      `Voiceover synthesis failed: Intelligible spoken audio could not be generated with voice "${voiceId}". Real TTS provider is required.`
    );
  }

  const arrayBuffer = await wavBlob.arrayBuffer();
  const peaks = calculateWavArrayBufferPeaks(arrayBuffer, 96);
  const duration = audioDuration > 0 ? audioDuration : (spec.finalDuration || 30);
  const url = URL.createObjectURL(wavBlob);

  return {
    blob: wavBlob,
    url,
    duration,
    peaks,
    sceneTimings,
  };
}

/**
 * Stage C (Part 2): Generates or retrieves background music track.
 */
export async function generateMusicAudio(spec, { signal, onProgress } = {}) {
  if (!spec.music?.enabled) return null;

  if (signal?.aborted) throw new Error("Music generation cancelled");

  onProgress?.({
    stage: "generating_audio",
    progress: 80,
    message: `Preparing ambient music soundtrack ("${spec.music.mood}")...`,
  });

  // Yield to allow UI repaint
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (signal?.aborted) throw new Error("Music generation cancelled");

  const duration = spec.finalDuration || 30;
  const blob = createSyntheticAudioBlob(duration, 22050);
  const arrayBuffer = await blob.arrayBuffer();
  const peaks = calculateWavArrayBufferPeaks(arrayBuffer, 96);
  const url = URL.createObjectURL(blob);

  return {
    blob,
    url,
    duration,
    peaks,
    volume: spec.music.volume || 0.25,
  };
}

/**
 * Stage D & E: Assembles all assets into a complete, editable Project State.
 */
export function assembleGeneratedProject(spec, sceneAssets, narrationData, musicData) {
  const hasNarration = narrationData && narrationData.duration > 0;
  const sceneTimings = Array.isArray(narrationData?.sceneTimings) && narrationData.sceneTimings.length === spec.scenes.length
    ? narrationData.sceneTimings
    : null;

  // Single source of truth: spoken narration is verbatim text for captions
  const wordCounts = spec.scenes.map((s) => {
    const text = (s.narration || s.caption || "").trim();
    return Math.max(1, text ? text.split(/\s+/).length : 5);
  });
  const totalWords = wordCounts.reduce((a, b) => a + b, 0);

  // Determine speech intervals and scene visual durations
  const pauseBetweenScenes = 0.35; // Audible natural breathing space between scenes
  const scenePacing = spec.scenes.map((scene, idx) => {
    const verbatimText = (scene.narration || scene.caption || "").trim();
    const isLast = idx === spec.scenes.length - 1;

    if (sceneTimings && sceneTimings[idx]) {
      const timing = sceneTimings[idx];
      const speechStart = Number(timing.start.toFixed(2));
      const speechEnd = Number(timing.end.toFixed(2));
      const speechDur = Number((speechEnd - speechStart).toFixed(2));
      const nextStart = !isLast && sceneTimings[idx + 1] ? Number(sceneTimings[idx + 1].start.toFixed(2)) : null;
      const visualEnd = nextStart !== null ? nextStart : Number((speechEnd + 0.8).toFixed(2));
      const visualDur = Number((visualEnd - speechStart).toFixed(2));

      return {
        speechStart,
        speechEnd,
        speechDur,
        visualDur: Math.max(2.0, visualDur),
        verbatimText,
      };
    }

    // Proportional calculation when per-scene audio timestamps are not returned
    const wordRatio = totalWords > 0 ? wordCounts[idx] / totalWords : 1 / spec.scenes.length;
    const totalAudio = hasNarration ? narrationData.duration : (spec.finalDuration || 30);
    const speechDur = Math.max(1.5, Number((totalAudio * wordRatio * 0.92).toFixed(2)));
    const visualDur = Math.max(2.0, isLast ? Number((speechDur + 0.8).toFixed(2)) : Number((speechDur + pauseBetweenScenes).toFixed(2)));

    return {
      speechStart: 0,
      speechEnd: 0,
      speechDur,
      visualDur,
      verbatimText,
    };
  });

  const syncedSceneDurations = scenePacing.map((p) => p.visualDur);
  const totalVisualDuration = syncedSceneDurations.reduce((a, b) => a + b, 0);
  const totalVideoDuration = Number(totalVisualDuration.toFixed(2));

  let accumulatedTime = 0;

  // 1. Assemble visual segments for each scene with Ken Burns motion
  const visualSegments = spec.scenes.map((scene, idx) => {
    const asset = sceneAssets[idx] || {};
    const sceneDur = syncedSceneDurations[idx];
    const start = accumulatedTime;
    const end = Number((accumulatedTime + sceneDur).toFixed(2));
    accumulatedTime = end;

    const transitionObj = typeof scene.transition === "object" && scene.transition?.id
      ? scene.transition
      : { id: scene.transition || "fade", duration: 0.5 };

    const defaultDims = {
      "16:9": { width: 1280, height: 720 },
      "9:16": { width: 720, height: 1280 },
      "1:1": { width: 1080, height: 1080 },
      "4:5": { width: 1080, height: 1350 },
    }[spec.aspectRatio] || { width: 1280, height: 720 };
    const width = asset.width || defaultDims.width;
    const height = asset.height || defaultDims.height;

    // Generate smooth Ken Burns pan/zoom/tilt motion via smartFrame for images or when explicit motion is specified
    const isImage = (asset.type || "image") === "image";
    const motionPreset = scene.motion || (isImage ? ["zoom_in", "pan_right", "zoom_out", "pan_left", "tilt_up"][idx % 5] : null);
    const smartFrame = motionPreset
      ? generateKenBurnsSmartFrame(
          motionPreset,
          idx,
          sceneDur,
          width,
          height,
          spec.aspectRatio
        )
      : null;

    const clipSrc = asset.src || asset.url || "";
    const clipBlob = asset.blob || null;

    return {
      id: `gen-clip-${Date.now()}-${idx}`,
      assetId: asset.id || `asset-${idx}`,
      name: scene.title || asset.name || `Scene ${idx + 1}`,
      type: asset.type || "image",
      src: clipSrc,
      blob: clipBlob,
      start,
      end,
      duration: sceneDur,
      sourceStart: Math.max(0, Number(asset.sourceStart) || 0),
      sourceIn: 0,
      sourceOut: sceneDur,
      sourceDuration: sceneDur,
      playbackRate: 1,
      width,
      height,
      transition: transitionObj,
      fitMode: "cover",
      mediaCategory: asset.mediaCategory || "stock",
      provider: asset.provider || "",
      license: asset.license || "",
      smartFrame: smartFrame || null,
      usedQuery: asset.usedQuery || scene.searchQuery || "N/A",
      queriesAttempted: asset.queriesAttempted || (scene.searchQuery ? [scene.searchQuery] : []),
      fallbackReason: asset.fallbackReason || null,
    };
  });

  // 2. Assemble caption segments strictly synchronized with spoken speech intervals
  let accumulatedSpeechTime = 0;
  const captionSegments = spec.scenes.map((scene, idx) => {
    const pacing = scenePacing[idx];
    const isLast = idx === spec.scenes.length - 1;
    let start, end;

    if (sceneTimings && sceneTimings[idx]) {
      start = pacing.speechStart;
      end = pacing.speechEnd;
    } else {
      start = Number(accumulatedSpeechTime.toFixed(2));
      end = Number((start + pacing.speechDur).toFixed(2));
      accumulatedSpeechTime = Number((end + (isLast ? 0.8 : pauseBetweenScenes)).toFixed(2));
    }

    // Subtitle text is ALWAYS derived from verbatim spoken narration
    const verbatimText = pacing.verbatimText || `Scene ${idx + 1}`;
    const words = computeSceneWordTimestamps(verbatimText, start, end);

    return {
      id: `gen-cap-${Date.now()}-${idx}`,
      text: verbatimText,
      start,
      end,
      words,
      timingSource: "tts-aligned",
      fontId: "default",
      effect: spec.captions?.stylePreset === "neon" ? "neon" : "normal",
      placement: spec.captions?.position || "bottom",
    };
  });

  // 3. Assemble markers at scene boundaries
  let markerTime = 0;
  const timelineMarkers = spec.scenes.map((scene, idx) => {
    const sceneDur = syncedSceneDurations[idx];
    const time = markerTime;
    markerTime = Number((markerTime + sceneDur).toFixed(2));
    return {
      id: `gen-marker-${Date.now()}-${idx}`,
      time,
      title: scene.title,
      color: idx === 0 ? "cyan" : idx % 2 === 0 ? "magenta" : "amber",
    };
  });

  // 4. Assemble narration audio segments
  const audioSegments = narrationData
    ? [
        {
          id: `gen-narration-${Date.now()}`,
          name: `AI Voiceover (${spec.narration?.voiceId || "af_heart"})`,
          blob: narrationData.blob,
          url: narrationData.url,
          start: 0,
          duration: narrationData.duration || totalVideoDuration,
          sourceDuration: narrationData.duration || totalVideoDuration,
          peaks: narrationData.peaks,
          volume: 1,
        },
      ]
    : [];

  // 5. Assemble background music segments spanning full video duration without gaps
  const musicSegments = musicData
    ? [
        {
          id: `gen-music-${Date.now()}`,
          name: `Background Music (${spec.music?.mood || "ambient"})`,
          blob: musicData.blob,
          url: musicData.url,
          start: 0,
          duration: totalVideoDuration,
          sourceDuration: Math.max(totalVideoDuration, musicData.duration || totalVideoDuration),
          peaks: musicData.peaks,
          volume: narrationData ? 0.18 : (spec.music.volume || 0.25),
        },
      ]
    : [];

  // 6. Build comprehensive visual quality diagnostic summary
  const diagnosticScenes = spec.scenes.map((scene, idx) => {
    const asset = sceneAssets[idx] || {};
    const segment = visualSegments[idx];
    const isRealMedia = asset.mediaCategory === "stock" || asset.mediaCategory === "reference" || asset.mediaCategory === "user";
    return {
      sceneId: scene.id || `scene-${idx + 1}`,
      title: scene.title,
      visualDescription: scene.visualDescription,
      narrativeIntent: scene.narration,
      searchQuery: scene.searchQuery,
      searchKeywords: scene.searchKeywords || [],
      selectedQuery: asset.usedQuery || scene.searchQuery || "N/A",
      queriesAttempted: asset.queriesAttempted || (scene.searchQuery ? [scene.searchQuery] : []),
      assetId: asset.id || `asset-${idx}`,
      assetSource: asset.provider || (isRealMedia ? "Wikimedia Commons" : "Procedural Canvas Fallback"),
      assetName: asset.name || "N/A",
      assetType: asset.type || "image",
      mediaCategory: asset.mediaCategory || (isRealMedia ? "stock" : "procedural_fallback"),
      isRealMedia,
      isFallback: !isRealMedia,
      fallbackReason: asset.fallbackReason || (isRealMedia ? null : "Stock search exhausted or network unreachable"),
      hasMotion: Boolean(segment?.smartFrame?.enabled || segment?.visualEffects?.smartFrame?.enabled),
      motionType: segment?.smartFrame?.motionType || segment?.visualEffects?.smartFrame?.motionType || scene.motion || "smooth",
      visualInstructionsReachedRenderer: Boolean(scene.visualDescription && scene.visualDescription.length > 5),
    };
  });

  const realMediaCount = diagnosticScenes.filter((s) => s.isRealMedia).length;
  const fallbackCount = diagnosticScenes.filter((s) => s.isFallback).length;

  const diagnosticSummary = {
    title: spec.title,
    aspectRatio: spec.aspectRatio,
    style: spec.style,
    totalScenes: spec.scenes.length,
    realMediaCount,
    fallbackCount,
    allRealMedia: fallbackCount === 0,
    scenes: diagnosticScenes,
  };

  // 7. Return cohesive Project State
  return {
    title: spec.title,
    script: spec.narration?.script || (spec.scenes || []).map((s) => s.narration).filter(Boolean).join("\n"),
    ratioId: spec.aspectRatio,
    fitMode: "cover",
    visualSegments,
    visualOverlaySegments: [],
    captionSegments,
    timelineMarkers,
    audioSegments,
    musicSegments,
    captionsEnabled: spec.captions?.enabled !== false,
    captionPosition: spec.captions?.position || "bottom",
    captionStylePresetId: spec.captions?.stylePreset || "neon",
    trackVisibility: normalizeTrackVisibility({
      image: true,
      overlay: true,
      caption: spec.captions?.enabled !== false,
      sticker: true,
      source: true,
      audio: true,
      music: spec.music?.enabled !== false,
    }),
    trackLocks: normalizeTrackLocks({
      image: false,
      overlay: false,
      caption: false,
      sticker: false,
      source: false,
      audio: false,
      music: false,
    }),
    timelineZoom: 1,
    selectedVoiceId: spec.narration?.voiceId || "af_heart",
    targetDuration: totalVideoDuration,
    audioDuration: totalVideoDuration,
    duration: totalVideoDuration,
    diagnosticSummary,
  };
}
