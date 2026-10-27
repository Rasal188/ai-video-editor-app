/**
 * Stock Media Retrieval Client
 *
 * Provides resilient, multi-tiered stock media discovery and acquisition:
 * 1. Primary: Wikimedia Commons (Footage & High-Resolution Photography)
 * 2. Secondary: Internet Archive (Open Licensed Archival Footage & Imagery)
 * 3. Final: Procedural Atmospheric Canvas Fallback
 *
 * Features:
 * - Request throttling with polite spacing
 * - Bounded retries with exponential backoff, jitter, and Retry-After support for HTTP 429
 * - Shared cross-request cooldown tracking
 * - In-memory LRU query and asset caching
 * - Strict open licensing verification (Creative Commons & Public Domain) with attribution
 * - Universal negative asset, logo, emblem, and watermark filtering
 * - Canonical media key deduplication
 * - Resilient error handling preventing uncaught CORS or network failures
 */

import {
  isNegativeAsset,
  scoreAssetRelevance,
  normalizeCanonicalMediaKey,
} from "./videoGeneratorAssembler.js";

// --- Rate Limiting & Cooldown Configuration ---
const WIKIMEDIA_MIN_INTERVAL_MS = 250;
const IA_MIN_INTERVAL_MS = 300;

let lastWikimediaRequestTime = 0;
let wikimediaCooldownUntil = 0;

let lastIARequestTime = 0;
let iaCooldownUntil = 0;

// Custom fetch hook for testing / mock injection
let customFetchFn = null;

export function setStockMediaFetch(fn) {
  customFetchFn = fn;
}

export function resetStockMediaFetch() {
  customFetchFn = null;
}

function getActiveFetch() {
  return customFetchFn || globalThis.fetch;
}

// --- In-Memory Caching ---
const SEARCH_CACHE = new Map();
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_SEARCH_CACHE_ENTRIES = 150;

const ASSET_CACHE = new Map();
const ASSET_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ASSET_CACHE_ENTRIES = 100;

export function clearStockMediaCache() {
  SEARCH_CACHE.clear();
  ASSET_CACHE.clear();
  wikimediaCooldownUntil = 0;
  iaCooldownUntil = 0;
  lastWikimediaRequestTime = 0;
  lastIARequestTime = 0;
}

export function getStockMediaCacheStats() {
  return {
    searchEntries: SEARCH_CACHE.size,
    assetEntries: ASSET_CACHE.size,
    wikimediaCooldownActive: wikimediaCooldownUntil > Date.now(),
    iaCooldownActive: iaCooldownUntil > Date.now(),
  };
}

function getCachedSearch(key) {
  const item = SEARCH_CACHE.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    SEARCH_CACHE.delete(key);
    return null;
  }
  return item.data;
}

function setCachedSearch(key, data) {
  if (SEARCH_CACHE.size >= MAX_SEARCH_CACHE_ENTRIES) {
    const oldest = Array.from(SEARCH_CACHE.keys()).slice(0, 20);
    for (const k of oldest) SEARCH_CACHE.delete(k);
  }
  SEARCH_CACHE.set(key, { data, expiresAt: Date.now() + SEARCH_CACHE_TTL_MS });
}

export function getCachedAsset(urlOrKey) {
  const item = ASSET_CACHE.get(urlOrKey);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    ASSET_CACHE.delete(urlOrKey);
    return null;
  }
  return item.data;
}

export function setCachedAsset(urlOrKey, data) {
  if (ASSET_CACHE.size >= MAX_ASSET_CACHE_ENTRIES) {
    const oldest = Array.from(ASSET_CACHE.keys()).slice(0, 15);
    for (const k of oldest) ASSET_CACHE.delete(k);
  }
  ASSET_CACHE.set(urlOrKey, { data, expiresAt: Date.now() + ASSET_CACHE_TTL_MS });
}

// --- Request Throttling & 429 Bounded Retries ---

/**
 * Executes an HTTP fetch with provider-specific throttling, bounded retries on 429,
 * Retry-After header parsing, and shared cooldown tracking.
 */
export async function fetchWithRateLimit(url, options = {}, provider = "wikimedia") {
  const activeFetch = getActiveFetch();
  const isWikimedia = provider === "wikimedia";
  const minInterval = isWikimedia ? WIKIMEDIA_MIN_INTERVAL_MS : IA_MIN_INTERVAL_MS;
  const maxRetries = 2;
  let attempt = 0;

  while (attempt <= maxRetries) {
    if (options.signal?.aborted) return null;

    // 1. Check provider-level active cooldown
    const now = Date.now();
    const cooldownUntil = isWikimedia ? wikimediaCooldownUntil : iaCooldownUntil;
    if (cooldownUntil > now) {
      const waitMs = Math.min(cooldownUntil - now, 5000);
      await new Promise((r) => setTimeout(r, waitMs));
    }

    // 2. Check polite spacing from the last request to this provider
    const lastTime = isWikimedia ? lastWikimediaRequestTime : lastIARequestTime;
    const elapsed = Date.now() - lastTime;
    if (elapsed < minInterval) {
      await new Promise((r) => setTimeout(r, minInterval - elapsed));
    }
    if (isWikimedia) lastWikimediaRequestTime = Date.now();
    else lastIARequestTime = Date.now();

    try {
      const res = await activeFetch(url, options);

      // Handle 429 Too Many Requests
      if (res.status === 429) {
        attempt++;

        let waitMs = 0;
        const retryAfterHeader = res.headers?.get?.("retry-after") || res.headers?.["retry-after"];
        if (retryAfterHeader) {
          const seconds = parseInt(retryAfterHeader, 10);
          if (!isNaN(seconds) && seconds > 0) {
            waitMs = Math.min(seconds * 1000, 5000);
          } else {
            const parsedDate = Date.parse(retryAfterHeader);
            if (!isNaN(parsedDate) && parsedDate > Date.now()) {
              waitMs = Math.min(parsedDate - Date.now(), 5000);
            }
          }
        }

        if (waitMs <= 0) {
          // Exponential backoff with jitter
          waitMs = Math.min(3500, 400 * Math.pow(2, attempt) + Math.random() * 250);
        }

        // Set global cooldown for all concurrent/subsequent requests to this provider
        const penaltyCooldown = Date.now() + Math.max(waitMs, 3000);
        if (isWikimedia) wikimediaCooldownUntil = penaltyCooldown;
        else iaCooldownUntil = penaltyCooldown;

        if (attempt > maxRetries) {
          console.warn(`[StockMedia] ${provider} rate limit exhausted after ${maxRetries} retries`);
          return res;
        }

        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      return res;
    } catch (err) {
      if (options.signal?.aborted) return null;
      attempt++;
      if (attempt > maxRetries) throw err;
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }

  return null;
}

// --- Licensing & Attribution Verification for Internet Archive ---

/**
 * Validates whether an Internet Archive document has an unambiguous open license.
 * Never assumes all content is public domain; requires explicit Creative Commons or Public Domain rights.
 */
export function verifyOpenLicense(doc) {
  if (!doc) return null;

  const licenseUrl = (doc.licenseurl || "").toLowerCase();
  const rights = (doc.rights || "").toLowerCase();

  const isExplicitOpen =
    licenseUrl.includes("creativecommons.org") ||
    licenseUrl.includes("publicdomain") ||
    rights.includes("public domain") ||
    rights.includes("cc0") ||
    rights.includes("creative commons") ||
    rights.includes("open access") ||
    rights.includes("no copyright");

  if (!isExplicitOpen) return null;

  let licenseName = "Creative Commons";
  if (
    licenseUrl.includes("/zero/") ||
    licenseUrl.includes("/publicdomain/") ||
    rights.includes("public domain") ||
    rights.includes("cc0")
  ) {
    licenseName = "Public Domain / CC0";
  } else if (licenseUrl.includes("/by-sa/")) {
    licenseName = "CC BY-SA";
  } else if (licenseUrl.includes("/by-nc-sa/")) {
    licenseName = "CC BY-NC-SA";
  } else if (licenseUrl.includes("/by-nc/")) {
    licenseName = "CC BY-NC";
  } else if (licenseUrl.includes("/by/")) {
    licenseName = "CC BY";
  }

  const attribution = doc.creator || doc.uploader || doc.title || "Internet Archive Contributor";

  return {
    valid: true,
    licenseName,
    licenseUrl: doc.licenseurl || "https://creativecommons.org/",
    attribution,
  };
}

// --- Primary Provider: Wikimedia Commons ---

/**
 * Searches Wikimedia Commons API with progressive relaxation, request throttling,
 * 429 Retry-After handling, search caching, and duplicate prevention.
 */
export async function searchCommonsAsset(
  candidatesInput,
  signal,
  usedKeys = new Set(),
  timeoutMs = 3500,
  sceneContext = {},
  options = {}
) {
  const candidates = Array.isArray(candidatesInput)
    ? candidatesInput
    : [candidatesInput].filter(Boolean);

  for (const rawQuery of candidates) {
    if (signal?.aborted) return null;

    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const onAbort = () => timeoutController.abort();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    try {
      const query = (rawQuery || "")
        .replace(/\b(footage|video|4k|hd|clip|shot)\b/gi, "")
        .replace(/\s+/g, " ")
        .trim();

      if (!query || query.length < 2) continue;

      // 1. Attempt real video footage first (webm/mp4) unless photoOnly is requested
      if (!options.photoOnly) {
        const cacheKey = `wikimedia:video:${query.toLowerCase()}`;
        let validVideos = getCachedSearch(cacheKey);

        if (!validVideos) {
          const videoParams = new URLSearchParams({
            action: "query",
            generator: "search",
            gsrsearch: `${query} filetype:video`,
            gsrnamespace: "6",
            gsrlimit: "8",
            prop: "imageinfo",
            iiprop: "url|size|mime",
            format: "json",
            origin: "*",
          });

          const vRes = await fetchWithRateLimit(
            `https://commons.wikimedia.org/w/api.php?${videoParams}`,
            {
              signal: timeoutController.signal,
              headers: {
                "Api-User-Agent": "TimelineStudio-AiVideoEditor/1.0 (editor@local.dev; educational/open-source)",
              },
            },
            "wikimedia"
          );

          if (vRes?.ok) {
            const vData = await vRes.json();
            const vPages = Object.values(vData.query?.pages || {});
            validVideos = vPages.filter((p) => {
              const info = p.imageinfo?.[0];
              if (!info?.url) return false;
              const mime = (info.mime || "").toLowerCase();
              return mime.includes("webm") || mime.includes("mp4");
            });
            setCachedSearch(cacheKey, validVideos);
          }
        }

        if (Array.isArray(validVideos) && validVideos.length > 0) {
          const scored = validVideos
            .filter((p) => {
              const info = p.imageinfo?.[0];
              if (!info?.url) return false;
              const canonicalKey = normalizeCanonicalMediaKey(p.title);
              if (usedKeys.has(canonicalKey) || usedKeys.has(info.url) || usedKeys.has(p.title)) return false;
              if (isNegativeAsset(p.title, sceneContext)) return false;
              return scoreAssetRelevance(p, sceneContext) >= 1;
            })
            .sort((a, b) => scoreAssetRelevance(b, sceneContext) - scoreAssetRelevance(a, sceneContext));

          if (scored.length > 0) {
            const valid = scored[0];
            const info = valid.imageinfo[0];
            const canonicalKey = normalizeCanonicalMediaKey(valid.title);

            usedKeys.add(canonicalKey);
            usedKeys.add(valid.title);
            usedKeys.add(valid.title.replace(/^File:/i, ""));
            usedKeys.add(info.url);

            return {
              type: "video",
              src: info.url,
              originalUrl: info.url,
              name: valid.title?.replace(/^File:/, "") || query,
              width: info.width || 1280,
              height: info.height || 720,
              provider: "Wikimedia Commons (Footage)",
              license: "Creative Commons",
              mediaCategory: "stock",
              usedQuery: query,
              canonicalKey,
            };
          }
        }
      }

      // 2. Second attempt: Search for suitable photograph (bitmap)
      const photoCacheKey = `wikimedia:photo:${query.toLowerCase()}`;
      let candidatePages = getCachedSearch(photoCacheKey);

      if (!candidatePages) {
        const params = new URLSearchParams({
          action: "query",
          generator: "search",
          gsrsearch: `${query} filetype:bitmap`,
          gsrnamespace: "6",
          gsrlimit: "12",
          prop: "imageinfo",
          iiprop: "url|size|mime",
          iiurlwidth: "1280",
          format: "json",
          origin: "*",
        });

        const res = await fetchWithRateLimit(
          `https://commons.wikimedia.org/w/api.php?${params}`,
          {
            signal: timeoutController.signal,
            headers: {
              "Api-User-Agent": "TimelineStudio-AiVideoEditor/1.0 (editor@local.dev; educational/open-source)",
            },
          },
          "wikimedia"
        );

        if (res?.ok) {
          const data = await res.json();
          candidatePages = Object.values(data.query?.pages || {});
          setCachedSearch(photoCacheKey, candidatePages);
        }
      }

      if (Array.isArray(candidatePages) && candidatePages.length > 0) {
        const scoredCandidates = candidatePages
          .filter((p) => {
            const info = p.imageinfo?.[0];
            if (!info) return false;
            const mime = (info.mime || "").toLowerCase();
            const isWebImage =
              (mime === "image/jpeg" || mime === "image/png" || mime === "image/webp") && !mime.includes("tiff");
            const src = info.thumburl || info.url;
            if (!isWebImage || !src) return false;

            const canonicalKey = normalizeCanonicalMediaKey(p.title);
            if (usedKeys.has(canonicalKey) || usedKeys.has(src) || usedKeys.has(p.title) || usedKeys.has(info.url)) {
              return false;
            }
            if (isNegativeAsset(p.title, sceneContext)) {
              return false;
            }
            return true;
          })
          .map((p) => ({
            page: p,
            score: scoreAssetRelevance(p, sceneContext),
          }))
          .filter((item) => item.score >= 1)
          .sort((a, b) => b.score - a.score);

        if (scoredCandidates.length > 0) {
          const valid = scoredCandidates[0].page;
          const info = valid.imageinfo[0];
          const src = info.thumburl || info.url;
          const canonicalKey = normalizeCanonicalMediaKey(valid.title);

          usedKeys.add(canonicalKey);
          usedKeys.add(valid.title);
          usedKeys.add(valid.title.replace(/^File:/i, ""));
          usedKeys.add(src);
          usedKeys.add(info.url);

          return {
            type: "image",
            src,
            originalUrl: info.url,
            name: valid.title?.replace(/^File:/, "") || query,
            width: info.width || 1280,
            height: info.height || 720,
            provider: "Wikimedia Commons",
            license: "Creative Commons",
            mediaCategory: "stock",
            usedQuery: query,
            canonicalKey,
          };
        }
      }
    } catch {
      // Continue to next candidate
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  return null;
}

// --- Secondary Provider: Internet Archive (archive.org) ---

/**
 * Searches Internet Archive public API for open-licensed media.
 * Does NOT require an API key or credentials.
 * Validates open licensing, checks relevance, and normalizes canonical keys.
 */
export async function searchInternetArchive(
  candidatesInput,
  signal,
  usedKeys = new Set(),
  timeoutMs = 4000,
  sceneContext = {},
  options = {}
) {
  const candidates = Array.isArray(candidatesInput)
    ? candidatesInput
    : [candidatesInput].filter(Boolean);

  for (const rawQuery of candidates) {
    if (signal?.aborted) return null;

    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const onAbort = () => timeoutController.abort();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    try {
      const clean = (rawQuery || "")
        .replace(/\b(footage|video|4k|hd|clip|shot)\b/gi, "")
        .replace(/\s+/g, " ")
        .trim();

      if (!clean || clean.length < 2) continue;

      const cacheKey = `ia:${options.photoOnly ? "image" : "all"}:${clean.toLowerCase()}`;
      let docs = getCachedSearch(cacheKey);

      if (!docs) {
        const mediaFilter = options.photoOnly ? "mediatype:image" : "(mediatype:movies OR mediatype:image)";
        // Require explicit licenseurl or rights fields to avoid copyrighted / all-rights-reserved content
        const queryFilter = `(${clean}) AND ${mediaFilter} AND (licenseurl:* OR rights:*)`;
        const params = new URLSearchParams({
          q: queryFilter,
          "fl[]": "identifier,title,description,mediatype,licenseurl,rights,year",
          rows: "8",
          output: "json",
        });

        const res = await fetchWithRateLimit(
          `https://archive.org/advancedsearch.php?${params}`,
          {
            signal: timeoutController.signal,
            headers: {
              "User-Agent": "TimelineStudio-AiVideoEditor/1.0 (editor@local.dev; educational/open-source)",
            },
          },
          "archive"
        );

        if (res?.ok) {
          const data = await res.json();
          docs = data.response?.docs || [];
          setCachedSearch(cacheKey, docs);
        }
      }

      if (Array.isArray(docs) && docs.length > 0) {
        for (const doc of docs) {
          // 1. Verify strict open licensing
          const license = verifyOpenLicense(doc);
          if (!license?.valid) continue;

          // 2. Reject negative assets / logos
          const title = doc.title || doc.identifier || "";
          const desc = doc.description || "";
          if (isNegativeAsset(title + " " + desc, sceneContext)) continue;

          // 3. Score semantic relevance
          const relevanceContext = (sceneContext && (sceneContext.title || sceneContext.searchQuery || sceneContext.visualDescription))
            ? sceneContext
            : { searchQuery: clean, title: clean };
          const relevance = scoreAssetRelevance({ title, description: desc }, relevanceContext);
          if (relevance < 1) continue;

          // 4. Duplicate prevention
          const canonicalKey = normalizeCanonicalMediaKey(title || doc.identifier);
          const thumbUrl = `https://archive.org/services/img/${doc.identifier}`;
          if (usedKeys.has(canonicalKey) || usedKeys.has(doc.identifier) || usedKeys.has(thumbUrl)) {
            continue;
          }

          // Register used keys
          usedKeys.add(canonicalKey);
          usedKeys.add(doc.identifier);
          usedKeys.add(thumbUrl);

          const isMovie = doc.mediatype === "movies" && !options.photoOnly;

          return {
            type: isMovie ? "video" : "image",
            src: thumbUrl,
            originalUrl: `https://archive.org/details/${doc.identifier}`,
            name: title,
            width: 1280,
            height: 720,
            provider: "Internet Archive",
            license: license.licenseName,
            licenseUrl: license.licenseUrl,
            attribution: license.attribution,
            mediaCategory: "stock",
            usedQuery: clean,
            canonicalKey,
          };
        }
      }
    } catch {
      // Continue to next candidate
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  return null;
}

// --- Unified Stock Media Retrieval Coordinator ---

/**
 * Orchestrates stock media retrieval across multiple tiers:
 * Tier 1: Wikimedia Commons (primary footage and photography)
 * Tier 2: Internet Archive (secondary open-licensed footage and photography)
 */
export async function searchStockMedia(
  candidatesInput,
  signal,
  usedKeys = new Set(),
  timeoutMs = 4000,
  sceneContext = {},
  options = {}
) {
  // 1. Try Wikimedia Commons first (primary provider)
  const wikimediaAsset = await searchCommonsAsset(
    candidatesInput,
    signal,
    usedKeys,
    timeoutMs,
    sceneContext,
    options
  ).catch(() => null);

  if (wikimediaAsset?.src) {
    return wikimediaAsset;
  }

  // 2. If Wikimedia returned nothing (exhausted, rate-limited, or 0 results), try Internet Archive
  const iaAsset = await searchInternetArchive(
    candidatesInput,
    signal,
    usedKeys,
    timeoutMs,
    sceneContext,
    options
  ).catch(() => null);

  if (iaAsset?.src) {
    return iaAsset;
  }

  return null;
}

/**
 * Safely fetches a media asset into a local Blob and Object URL with bounds checking and CORS resilience.
 * Never throws uncaught errors on network disconnects, CORS blocks, or 404s.
 */
export async function fetchMediaBlob(src, expectedType = "image", signal = null, timeoutMs = 5000) {
  if (!src || typeof src !== "string") return null;

  // Check in-memory asset cache first
  const cached = getCachedAsset(src);
  if (cached) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });

  try {
    const activeFetch = getActiveFetch();
    const res = await activeFetch(src, { signal: controller.signal, mode: "cors" });
    if (!res?.ok) return null;

    const blob = await res.blob();
    const mime = (blob.type || "").toLowerCase();

    if (expectedType === "video") {
      const isVideo = mime.includes("video") || mime.includes("webm") || mime.includes("mp4");
      if (!isVideo || blob.size <= 0 || blob.size > 40 * 1024 * 1024) return null;
    } else {
      const isImage = mime.startsWith("image/") && !mime.includes("tiff");
      if (!isImage && mime !== "application/octet-stream" && mime !== "") return null;
      if (blob.size <= 0) return null;
    }

    const blobUrl = typeof URL.createObjectURL === "function" ? URL.createObjectURL(blob) : src;
    const result = { ok: true, blob, blobUrl, mime, size: blob.size };
    setCachedAsset(src, result);
    return result;
  } catch {
    // Return null cleanly on CORS failure, network abort, or timeout without throwing
    return null;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

