/**
 * Video Generation Specification Schema & Validation
 *
 * Enforces strict validation and normalization on AI-generated
 * prompt-to-video plans.
 */

export const VIDEO_SPEC_SCHEMA_VERSION = 1;

export const SUPPORTED_ASPECT_RATIOS = Object.freeze(["9:16", "16:9", "1:1", "4:5"]);
export const SUPPORTED_STYLES = Object.freeze([
  "cinematic",
  "documentary",
  "tech",
  "nature",
  "minimalist",
  "social",
]);

export const SUPPORTED_TRANSITIONS = Object.freeze([
  "none",
  "fade",
  "wipe-left",
  "wipe-up",
  "zoom",
  "split",
  "flash",
]);

export const SUPPORTED_CAPTION_STYLES = Object.freeze([
  "neon",
  "classic",
  "bold",
  "minimal",
]);

/**
 * Validates and normalizes an untrusted raw video specification object.
 *
 * @param {Object} rawSpec
 * @param {Object} [options]
 * @param {number} [options.targetDuration] - Expected target duration (if specified by user)
 * @param {string} [options.aspectRatio] - Expected aspect ratio
 * @returns {Object} Validated and normalized video specification
 */
export function validateAndNormalizeVideoSpec(rawSpec, options = {}) {
  if (!rawSpec || typeof rawSpec !== "object" || Array.isArray(rawSpec)) {
    throw new Error("Video specification must be a non-null object.");
  }

  // 1. Title & Summary
  const title = typeof rawSpec.title === "string" && rawSpec.title.trim()
    ? rawSpec.title.trim().slice(0, 120)
    : "Untitled AI Video";

  const summary = typeof rawSpec.summary === "string" && rawSpec.summary.trim()
    ? rawSpec.summary.trim().slice(0, 500)
    : "";

  // 2. Aspect Ratio
  const requestedRatio = options.aspectRatio || rawSpec.aspectRatio || "16:9";
  const aspectRatio = SUPPORTED_ASPECT_RATIOS.includes(requestedRatio)
    ? requestedRatio
    : "16:9";

  // 3. Style
  const rawStyle = String(rawSpec.style || options.style || "cinematic").toLowerCase().trim();
  const style = SUPPORTED_STYLES.includes(rawStyle) ? rawStyle : "cinematic";

  // 4. Target Duration (between 10s and 180s)
  const explicitDuration = Number(options.targetDuration || rawSpec.targetDuration);
  const targetDuration = Number.isFinite(explicitDuration) && explicitDuration >= 10 && explicitDuration <= 180
    ? Math.round(explicitDuration)
    : 30;

  // 5. Narration Configuration
  const rawNarration = typeof rawSpec.narration === "object" && rawSpec.narration !== null ? rawSpec.narration : {};
  const narration = {
    enabled: rawNarration.enabled !== false,
    voiceId: typeof rawNarration.voiceId === "string" && rawNarration.voiceId.trim()
      ? rawNarration.voiceId.trim().slice(0, 64)
      : (options.voiceId || "af_heart"),
    language: typeof rawNarration.language === "string" && rawNarration.language.trim()
      ? rawNarration.language.trim().slice(0, 10)
      : "en",
    script: typeof rawNarration.script === "string" ? rawNarration.script.trim().slice(0, 3000) : "",
  };

  // 6. Music Configuration
  const rawMusic = typeof rawSpec.music === "object" && rawSpec.music !== null ? rawSpec.music : {};
  const music = {
    enabled: rawMusic.enabled !== false,
    mood: typeof rawMusic.mood === "string" && rawMusic.mood.trim() ? rawMusic.mood.trim().slice(0, 50) : "cinematic ambient",
    query: typeof rawMusic.query === "string" && rawMusic.query.trim() ? rawMusic.query.trim().slice(0, 100) : "ambient",
    volume: Number.isFinite(Number(rawMusic.volume)) ? Math.max(0, Math.min(1, Number(rawMusic.volume))) : 0.25,
  };

  // 7. Captions Configuration
  const rawCaptions = typeof rawSpec.captions === "object" && rawSpec.captions !== null ? rawSpec.captions : {};
  const captions = {
    enabled: rawCaptions.enabled !== false,
    stylePreset: SUPPORTED_CAPTION_STYLES.includes(rawCaptions.stylePreset) ? rawCaptions.stylePreset : "neon",
    position: ["top", "middle", "bottom"].includes(rawCaptions.position) ? rawCaptions.position : "bottom",
  };

  // 8. Scenes Array Validation
  const rawScenes = Array.isArray(rawSpec.scenes) ? rawSpec.scenes : [];
  if (rawScenes.length < 2) {
    throw new Error("Video specification must contain at least 2 scenes.");
  }
  if (rawScenes.length > 15) {
    throw new Error("Video specification cannot exceed 15 scenes.");
  }

  // Validate each scene
  const validatedScenes = [];
  let accumulatedRawDuration = 0;

  for (let i = 0; i < rawScenes.length; i++) {
    const s = rawScenes[i];
    if (!s || typeof s !== "object") {
      throw new Error(`Scene ${i + 1} must be an object.`);
    }

    const sceneId = typeof s.id === "string" && s.id.trim()
      ? s.id.trim().slice(0, 40)
      : `scene-${i + 1}`;

    const sceneTitle = typeof s.title === "string" && s.title.trim()
      ? s.title.trim().slice(0, 100)
      : `Scene ${i + 1}`;

    const rawDur = Number(s.duration);
    if (!Number.isFinite(rawDur) || rawDur < 1) {
      throw new Error(`Scene ${i + 1} duration must be a number >= 1 second.`);
    }
    const sceneDuration = Number(rawDur.toFixed(2));
    accumulatedRawDuration += sceneDuration;

    const visualDescription = typeof s.visualDescription === "string" && s.visualDescription.trim()
      ? s.visualDescription.trim().slice(0, 300)
      : "Visual scene footage";

    const searchQuery = typeof s.searchQuery === "string" && s.searchQuery.trim()
      ? s.searchQuery.trim().slice(0, 100)
      : visualDescription.slice(0, 60);

    const sceneNarration = typeof s.narration === "string"
      ? s.narration.trim().slice(0, 500)
      : "";

    const sceneCaption = typeof s.narration === "string" && s.narration.trim()
      ? s.narration.trim().slice(0, 500)
      : typeof s.caption === "string"
      ? s.caption.trim().slice(0, 500)
      : "";

    const rawTransition = String(s.transition || "fade").toLowerCase().trim();
    const transition = SUPPORTED_TRANSITIONS.includes(rawTransition) ? rawTransition : "fade";

    validatedScenes.push({
      id: sceneId,
      title: sceneTitle,
      duration: sceneDuration,
      visualDescription,
      searchQuery,
      narration: sceneNarration,
      caption: sceneCaption,
      transition,
      motion: typeof s.motion === "string" ? s.motion.slice(0, 50) : undefined,
      searchKeywords: Array.isArray(s.searchKeywords) ? s.searchKeywords.map((k) => String(k).slice(0, 50)) : undefined,
      assignedAssetId: typeof s.assignedAssetId === "string" ? s.assignedAssetId : undefined,
      useReferenceAsset: Boolean(s.useReferenceAsset),
      referenceRole: typeof s.referenceRole === "string" ? s.referenceRole : undefined,
    });
  }

  // 9. Duration Arithmetic & Normalization
  // If scene durations deviate from targetDuration, normalize them proportionally
  const durationDiff = Math.abs(accumulatedRawDuration - targetDuration);
  const tolerance = Math.max(2, targetDuration * 0.1);

  if (accumulatedRawDuration > 0 && durationDiff > tolerance) {
    const scaleFactor = targetDuration / accumulatedRawDuration;
    let runningTotal = 0;
    for (let i = 0; i < validatedScenes.length; i++) {
      if (i === validatedScenes.length - 1) {
        // Last scene takes the exact remainder
        validatedScenes[i].duration = Number((targetDuration - runningTotal).toFixed(2));
      } else {
        const scaled = Number((validatedScenes[i].duration * scaleFactor).toFixed(2));
        validatedScenes[i].duration = Math.max(1.5, scaled);
        runningTotal += validatedScenes[i].duration;
      }
    }
  }

  // Re-sum final duration
  const finalDuration = Number(
    validatedScenes.reduce((sum, sc) => sum + sc.duration, 0).toFixed(2)
  );

  return {
    schemaVersion: VIDEO_SPEC_SCHEMA_VERSION,
    title,
    summary,
    targetDuration,
    finalDuration,
    aspectRatio,
    style,
    narration,
    music,
    captions,
    scenes: validatedScenes,
  };
}
