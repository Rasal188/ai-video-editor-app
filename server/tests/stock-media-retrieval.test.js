import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  setStockMediaFetch,
  resetStockMediaFetch,
  clearStockMediaCache,
  getStockMediaCacheStats,
  fetchWithRateLimit,
  verifyOpenLicense,
  searchCommonsAsset,
  searchInternetArchive,
  searchStockMedia,
  fetchMediaBlob,
} from "../../src/lib/stockMediaClient.js";
import {
  acquireSceneAssets,
  assembleGeneratedProject,
} from "../../src/lib/videoGeneratorAssembler.js";

describe("Stock Media Retrieval & Provider Resilience", () => {
  beforeEach(() => {
    clearStockMediaCache();
    resetStockMediaFetch();
  });

  afterEach(() => {
    clearStockMediaCache();
    resetStockMediaFetch();
  });

  describe("HTTP 429 Rate Limiting & Bounded Retries", () => {
    it("handles 429 Too Many Requests with Retry-After header and succeeds on retry", async () => {
      let attempts = 0;
      setStockMediaFetch(async (url, opts) => {
        attempts++;
        if (attempts === 1) {
          return new Response(JSON.stringify({ error: "rate limited" }), {
            status: 429,
            statusText: "Too Many Requests",
            headers: {
              "Content-Type": "application/json",
              "Retry-After": "1", // 1 second
            },
          });
        }
        return new Response(JSON.stringify({ query: { pages: { 1: { title: "File:Server.jpg" } } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const startTime = Date.now();
      const res = await fetchWithRateLimit("https://commons.wikimedia.org/test", {}, "wikimedia");
      const elapsed = Date.now() - startTime;

      assert.equal(attempts, 2, "Should retry once after receiving 429");
      assert.equal(res.status, 200, "Should return 200 on successful retry");
      assert.ok(elapsed >= 900, `Should have backed off at least ~1s according to Retry-After, elapsed: ${elapsed}ms`);
    });

    it("exhausts bounded retries on continuous 429 and returns 429 response without throwing", async () => {
      let attempts = 0;
      setStockMediaFetch(async () => {
        attempts++;
        return new Response("Too Many Requests", {
          status: 429,
          headers: { "Retry-After": "0" },
        });
      });

      const res = await fetchWithRateLimit("https://commons.wikimedia.org/test", {}, "wikimedia");
      // maxRetries is 2 -> attempt 0, attempt 1, attempt 2 (3 calls total)
      assert.equal(attempts, 3, "Should bound retries to max 2 retries (3 attempts total)");
      assert.equal(res.status, 429, "Should return 429 response when retries are exhausted");
    });

    it("sets provider cooldown on 429 to protect concurrent requests", async () => {
      setStockMediaFetch(async () => {
        return new Response("Too Many Requests", {
          status: 429,
          headers: { "Retry-After": "2" },
        });
      });

      await fetchWithRateLimit("https://commons.wikimedia.org/test", {}, "wikimedia");
      const stats = getStockMediaCacheStats();
      assert.equal(stats.wikimediaCooldownActive, true, "Wikimedia cooldown should be active after 429");
    });
  });

  describe("In-Memory Search Caching & Deduplication", () => {
    it("caches search results to avoid redundant API queries", async () => {
      let networkCalls = 0;
      setStockMediaFetch(async (url) => {
        networkCalls++;
        return new Response(
          JSON.stringify({
            query: {
              pages: {
                101: {
                  pageid: 101,
                  title: "File:Datacenter server racks.jpg",
                  imageinfo: [
                    {
                      url: "https://upload.wikimedia.org/datacenter.jpg",
                      thumburl: "https://upload.wikimedia.org/thumb_datacenter.jpg",
                      width: 1920,
                      height: 1080,
                      mime: "image/jpeg",
                    },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      });

      const usedKeys1 = new Set();
      const res1 = await searchCommonsAsset(["server room"], null, usedKeys1);
      assert.ok(res1, "First search should return an asset");
      assert.equal(networkCalls, 2, "First search should make 2 calls (video search then photo fallback)");

      // Second search with same candidate
      const usedKeys2 = new Set();
      const res2 = await searchCommonsAsset(["server room"], null, usedKeys2);
      assert.ok(res2, "Second search should return cached asset");
      assert.equal(networkCalls, 2, "Should have reused cache without any additional network calls");

      const stats = getStockMediaCacheStats();
      assert.ok(stats.searchEntries >= 1, "Search cache should have stored entries");
    });

    it("prevents duplicate assets across consecutive scenes using canonical media keys", async () => {
      setStockMediaFetch(async () => {
        return new Response(
          JSON.stringify({
            query: {
              pages: {
                101: {
                  pageid: 101,
                  title: "File:Fiber optic cables in server rack.jpg",
                  imageinfo: [
                    {
                      url: "https://upload.wikimedia.org/fiber.jpg",
                      thumburl: "https://upload.wikimedia.org/thumb_fiber.jpg",
                      width: 1920,
                      height: 1080,
                      mime: "image/jpeg",
                    },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      });

      const usedKeys = new Set();
      const asset1 = await searchCommonsAsset(["fiber cables"], null, usedKeys);
      assert.ok(asset1, "First query gets asset1");

      // Second query with same usedKeys set should reject duplicate
      const asset2 = await searchCommonsAsset(["fiber cables"], null, usedKeys);
      assert.equal(asset2, null, "Should reject already used canonical asset key to prevent duplicates");
    });
  });

  describe("Secondary Provider: Internet Archive & Strict Licensing", () => {
    it("validates open licenses correctly and rejects non-open/unspecified licenses", () => {
      // 1. Creative Commons CC-BY
      const ccBy = verifyOpenLicense({
        licenseurl: "https://creativecommons.org/licenses/by/4.0/",
        creator: "Open Technology Lab",
      });
      assert.ok(ccBy.valid);
      assert.equal(ccBy.licenseName, "CC BY");
      assert.equal(ccBy.attribution, "Open Technology Lab");

      // 2. Public Domain / CC0
      const pd = verifyOpenLicense({
        rights: "Public Domain Dedication (CC0 1.0)",
        uploader: "National Archives",
      });
      assert.ok(pd.valid);
      assert.equal(pd.licenseName, "Public Domain / CC0");

      // 3. CC BY-SA
      const ccBySa = verifyOpenLicense({
        licenseurl: "http://creativecommons.org/licenses/by-sa/3.0/",
        title: "Microprocessor Die Shot",
      });
      assert.ok(ccBySa.valid);
      assert.equal(ccBySa.licenseName, "CC BY-SA");

      // 4. Missing/Undefined licenseurl and rights MUST be rejected (never assume public domain)
      const unverified = verifyOpenLicense({
        title: "Random Video Clip",
        creator: "Unknown",
      });
      assert.equal(unverified, null, "Must reject documents without explicit open licensing metadata");

      // 5. All Rights Reserved MUST be rejected
      const copyrighted = verifyOpenLicense({
        rights: "All Rights Reserved (c) 2024",
      });
      assert.equal(copyrighted, null, "Must reject All Rights Reserved");
    });

    it("falls back to Internet Archive when Wikimedia Commons yields no results", async () => {
      setStockMediaFetch(async (url) => {
        if (url.includes("commons.wikimedia.org")) {
          // Return empty Wikimedia search
          return new Response(JSON.stringify({ query: { pages: {} } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.includes("archive.org/advancedsearch.php")) {
          // Return open-licensed Internet Archive result
          return new Response(
            JSON.stringify({
              response: {
                docs: [
                  {
                    identifier: "silicon_superhighway_1995",
                    title: "Silicon Superhighway Modern Computing",
                    description: "High speed network routing and supercomputer architecture",
                    mediatype: "movies",
                    licenseurl: "https://creativecommons.org/licenses/by-sa/4.0/",
                    creator: "Computer History Institute",
                  },
                ],
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        return new Response("Not found", { status: 404 });
      });

      const usedKeys = new Set();
      const asset = await searchStockMedia(["network routing infrastructure"], null, usedKeys);

      assert.ok(asset, "Should find asset via Internet Archive secondary provider");
      assert.equal(asset.provider, "Internet Archive");
      assert.equal(asset.license, "CC BY-SA");
      assert.equal(asset.attribution, "Computer History Institute");
      assert.ok(asset.src.includes("silicon_superhighway_1995"));
    });
  });

  describe("Negative Asset & Logo Rejection", () => {
    it("rejects logos, coat of arms, and irrelevant emblems", async () => {
      setStockMediaFetch(async () => {
        return new Response(
          JSON.stringify({
            query: {
              pages: {
                1: {
                  pageid: 1,
                  title: "File:Logo of European Southern Observatory.svg.png",
                  imageinfo: [
                    {
                      url: "https://upload.wikimedia.org/eso_logo.png",
                      thumburl: "https://upload.wikimedia.org/thumb_eso_logo.png",
                      width: 800,
                      height: 800,
                      mime: "image/png",
                    },
                  ],
                },
                2: {
                  pageid: 2,
                  title: "File:Modern Cloud Datacenter Server Infrastructure.jpg",
                  imageinfo: [
                    {
                      url: "https://upload.wikimedia.org/datacenter_racks.jpg",
                      thumburl: "https://upload.wikimedia.org/thumb_datacenter_racks.jpg",
                      width: 1920,
                      height: 1080,
                      mime: "image/jpeg",
                    },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      });

      const usedKeys = new Set();
      const asset = await searchCommonsAsset(
        ["datacenter cloud servers"],
        null,
        usedKeys,
        3500,
        { title: "Modern Technology Cloud Datacenters" }
      );

      assert.ok(asset, "Should return an asset");
      assert.notEqual(asset.name, "Logo of European Southern Observatory.svg.png", "Must reject ESO logo");
      assert.ok(asset.name.includes("Datacenter Server Infrastructure"), "Must select the relevant infrastructure photo");
    });
  });

  describe("CORS Resilience & Media Download Fallback", () => {
    it("safely handles CORS failure or network error in fetchMediaBlob without throwing uncaught exceptions", async () => {
      setStockMediaFetch(async () => {
        throw new TypeError("Failed to fetch due to CORS NetworkError");
      });

      const result = await fetchMediaBlob("https://blocked-by-cors.org/video.webm", "video");
      assert.equal(result, null, "fetchMediaBlob should catch CORS error and cleanly return null");
    });

    it("falls back to photo when remote video fetch fails due to CORS or size limits", async () => {
      let photoRequested = false;

      setStockMediaFetch(async (url) => {
        if (url.includes("api.php")) {
          // If search for video
          if (url.includes("filetype=video")) {
            return new Response(
              JSON.stringify({
                query: {
                  pages: {
                    1: {
                      pageid: 1,
                      title: "File:Server room timelapse.webm",
                      imageinfo: [
                        {
                          url: "https://upload.wikimedia.org/cors_blocked_video.webm",
                          thumburl: "https://upload.wikimedia.org/thumb_video.jpg",
                          width: 1920,
                          height: 1080,
                          mime: "video/webm",
                        },
                      ],
                    },
                  },
                },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          // Search for fallback photo
          photoRequested = true;
          return new Response(
            JSON.stringify({
              query: {
                pages: {
                  2: {
                    pageid: 2,
                    title: "File:Server room high res.jpg",
                    imageinfo: [
                      {
                        url: "https://upload.wikimedia.org/server_photo.jpg",
                        thumburl: "https://upload.wikimedia.org/thumb_server_photo.jpg",
                        width: 1920,
                        height: 1080,
                        mime: "image/jpeg",
                      },
                    ],
                  },
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        // Binary downloads
        if (url.includes("cors_blocked_video.webm")) {
          throw new TypeError("Blocked by CORS policy");
        }
        if (url.includes("thumb_server_photo.jpg") || url.includes("server_photo.jpg")) {
          return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), {
            status: 200,
            headers: { "Content-Type": "image/jpeg" },
          });
        }

        return new Response("Not found", { status: 404 });
      });

      const scenes = [
        {
          id: "s1",
          title: "Inside the Data Fortress",
          visualDescription: "Rows of servers glowing in cool blue light",
          narration: "Massive datacenters power the global digital infrastructure.",
          duration: 5,
          searchQuery: "datacenter server racks",
        },
      ];

      const acquired = await acquireSceneAssets(scenes, { aspectRatio: "16:9", style: "cinematic" });
      assert.equal(acquired.length, 1);
      assert.ok(photoRequested, "Should have requested fallback photo after video fetch failed");
      assert.equal(acquired[0].type, "image", "Acquired asset should be fallback image");
      assert.equal(acquired[0].provider, "Wikimedia Commons");
    });
  });

  describe("Total Provider Failure & Honest Procedural Fallback", () => {
    it("falls back to procedural visuals when all providers are unavailable, and labels them honestly as fallback", async () => {
      // Both Wikimedia and Internet Archive return 503 Service Unavailable
      setStockMediaFetch(async () => {
        return new Response("Service Unavailable", { status: 503 });
      });

      const scenes = [
        {
          id: "s1",
          title: "The Architecture of Tomorrow",
          visualDescription: "Engineers collaborating on quantum processor design",
          narration: "Engineers push the frontiers of computing forward.",
          duration: 5,
          searchQuery: "quantum computing lab engineers",
        },
      ];

      const acquired = await acquireSceneAssets(scenes, { aspectRatio: "16:9", style: "cinematic" });
      assert.equal(acquired.length, 1);
      const asset = acquired[0];

      // Verify procedural asset attributes
      assert.equal(asset.mediaCategory, "procedural_fallback", "Must honestly categorize as procedural fallback");
      assert.equal(asset.provider, "Procedural Canvas Fallback", "Provider must state Procedural Canvas Fallback");
      assert.equal(asset.generatedBy, "procedural", "Must declare generatedBy procedural");
      assert.notEqual(asset.mediaCategory, "stock", "Must never falsely categorize procedural visual as real stock footage");
      assert.ok(asset.fallbackReason, "Must contain explanatory fallbackReason");

      // Verify assembled timeline project attributes
      const spec = {
        title: "Future of Computing",
        aspectRatio: "16:9",
        fps: 30,
        finalDuration: 5,
        scenes,
      };
      const project = assembleGeneratedProject(spec, acquired, null, null);
      const seg = project.visualSegments[0];

      assert.equal(seg.mediaCategory, "procedural_fallback", "Timeline segment must carry procedural_fallback label");
      assert.equal(seg.provider, "Procedural Canvas Fallback");
    });
  });
});
