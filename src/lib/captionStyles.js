export const CAPTION_VISUAL_STYLE_KEYS = [
  "fontId",
  "textColor",
  "backgroundColor",
  "backgroundOpacity",
  "borderColor",
  "borderWidth",
  "radius",
  "paddingX",
  "paddingY",
  "shadowOpacity",
  "effect",
  "textStrokeColor",
  "textStrokeWidth",
  "karaoke",
  "activeWordColor",
  "keywordHighlight",
  "keywords",
  "keywordColor",
];

export const CAPTION_SEGMENT_STYLE_KEYS = [...CAPTION_VISUAL_STYLE_KEYS, "captionSize"];

export const BUILTIN_CAPTION_STYLE_PRESETS = [
  {
    id: "classic",
    labelKey: "captionStylePresetClassic",
    sampleClass: "is-classic",
    captionSize: 14,
    position: "bottom",
    style: {
      textColor: "#f5fbff",
      backgroundColor: "#05080d",
      backgroundOpacity: 0.72,
      borderColor: "#35f0dd",
      borderWidth: 0,
      radius: 7,
      paddingX: 22,
      paddingY: 12,
      shadowOpacity: 0.45,
      effect: "normal",
      textStrokeColor: "#05080d",
      textStrokeWidth: 0,
      karaoke: false,
      activeWordColor: "#ffd43b",
      keywordHighlight: false,
      keywords: [],
      keywordColor: "#38d9a9",
    },
  },
  {
    id: "bold",
    labelKey: "captionStylePresetBold",
    sampleClass: "is-bold",
    captionSize: 17,
    position: "bottom",
    style: {
      textColor: "#ffffff",
      backgroundColor: "#000000",
      backgroundOpacity: 0,
      borderColor: "#ffffff",
      borderWidth: 0,
      radius: 6,
      paddingX: 18,
      paddingY: 8,
      shadowOpacity: 0.85,
      effect: "normal",
      textStrokeColor: "#000000",
      textStrokeWidth: 3,
      karaoke: false,
      activeWordColor: "#ffd43b",
      keywordHighlight: false,
      keywords: [],
      keywordColor: "#38d9a9",
    },
  },
  {
    id: "karaoke",
    labelKey: "captionStylePresetKaraoke",
    sampleClass: "is-karaoke",
    captionSize: 15,
    position: "bottom",
    style: {
      textColor: "#f0f6fc",
      backgroundColor: "#0b1320",
      backgroundOpacity: 0.68,
      borderColor: "#3b82f6",
      borderWidth: 1,
      radius: 10,
      paddingX: 22,
      paddingY: 12,
      shadowOpacity: 0.5,
      effect: "normal",
      textStrokeColor: "#05080d",
      textStrokeWidth: 1,
      karaoke: true,
      activeWordColor: "#ffd43b",
      keywordHighlight: false,
      keywords: [],
      keywordColor: "#38d9a9",
    },
  },
  {
    id: "minimal",
    labelKey: "captionStylePresetMinimal",
    sampleClass: "is-minimal",
    captionSize: 13,
    position: "bottom",
    style: {
      textColor: "#f8fafc",
      backgroundColor: "#05080d",
      backgroundOpacity: 0,
      borderColor: "#ffffff",
      borderWidth: 0,
      radius: 4,
      paddingX: 14,
      paddingY: 6,
      shadowOpacity: 0.35,
      effect: "normal",
      textStrokeColor: "#0f172a",
      textStrokeWidth: 1,
      karaoke: false,
      activeWordColor: "#ffd43b",
      keywordHighlight: false,
      keywords: [],
      keywordColor: "#38d9a9",
    },
  },
  {
    id: "social",
    labelKey: "captionStylePresetSocial",
    sampleClass: "is-social",
    captionSize: 18,
    position: "bottom",
    style: {
      textColor: "#fff03b",
      backgroundColor: "#000000",
      backgroundOpacity: 0.85,
      borderColor: "#fff03b",
      borderWidth: 0,
      radius: 14,
      paddingX: 24,
      paddingY: 12,
      shadowOpacity: 0.7,
      effect: "normal",
      textStrokeColor: "#000000",
      textStrokeWidth: 2,
      karaoke: true,
      activeWordColor: "#00ffcc",
      keywordHighlight: false,
      keywords: [],
      keywordColor: "#ff4d4f",
    },
  },
  {
    id: "plain",
    labelKey: "captionStylePresetPlain",
    sampleClass: "is-plain",
    captionSize: 14,
    position: "bottom",
    style: {
      textColor: "#f5fbff",
      backgroundColor: "#05080d",
      backgroundOpacity: 0,
      borderColor: "#35f0dd",
      borderWidth: 0,
      radius: 7,
      paddingX: 16,
      paddingY: 8,
      shadowOpacity: 0.55,
      effect: "normal",
      textStrokeColor: "#05080d",
      textStrokeWidth: 0,
      karaoke: false,
      activeWordColor: "#ffd43b",
      keywordHighlight: false,
      keywords: [],
      keywordColor: "#38d9a9",
    },
  },
  {
    id: "outline",
    labelKey: "captionStylePresetOutline",
    sampleClass: "is-outline",
    captionSize: 14,
    position: "bottom",
    style: {
      textColor: "#ffffff",
      backgroundColor: "#05080d",
      backgroundOpacity: 0,
      borderColor: "#35f0dd",
      borderWidth: 0,
      radius: 7,
      paddingX: 16,
      paddingY: 8,
      shadowOpacity: 0.35,
      effect: "normal",
      textStrokeColor: "#05080d",
      textStrokeWidth: 2,
      karaoke: false,
      activeWordColor: "#ffd43b",
      keywordHighlight: false,
      keywords: [],
      keywordColor: "#38d9a9",
    },
  },
  {
    id: "translucent",
    labelKey: "captionStylePresetTranslucent",
    sampleClass: "is-translucent",
    captionSize: 14,
    position: "bottom",
    style: {
      textColor: "#effffd",
      backgroundColor: "#17303a",
      backgroundOpacity: 0.46,
      borderColor: "#8ef7ed",
      borderWidth: 1,
      radius: 12,
      paddingX: 22,
      paddingY: 11,
      shadowOpacity: 0.35,
      effect: "normal",
      textStrokeColor: "#05080d",
      textStrokeWidth: 0,
      karaoke: false,
      activeWordColor: "#ffd43b",
      keywordHighlight: false,
      keywords: [],
      keywordColor: "#38d9a9",
    },
  },
  {
    id: "neon",
    labelKey: "captionStylePresetNeon",
    sampleClass: "is-neon",
    captionSize: 14,
    position: "bottom",
    style: {
      textColor: "#ecfffd",
      backgroundColor: "#071517",
      backgroundOpacity: 0.22,
      borderColor: "#35f0dd",
      borderWidth: 1,
      radius: 9,
      paddingX: 22,
      paddingY: 11,
      shadowOpacity: 0.5,
      effect: "neon",
      textStrokeColor: "#071517",
      textStrokeWidth: 0,
      karaoke: false,
      activeWordColor: "#ffd43b",
      keywordHighlight: false,
      keywords: [],
      keywordColor: "#38d9a9",
    },
  },
];

export function getCaptionStylePreset(id) {
  return BUILTIN_CAPTION_STYLE_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function getCaptionSegmentOverrides(segment) {
  const overrides = { ...(segment?.styleOverrides ?? {}) };
  if (!overrides.fontId && segment?.fontId && segment.fontId !== "default") {
    overrides.fontId = segment.fontId;
  }
  return overrides;
}

export function countCaptionSegmentOverrides(segment) {
  const styleCount = Object.keys(getCaptionSegmentOverrides(segment)).filter((key) => (
    CAPTION_SEGMENT_STYLE_KEYS.includes(key)
  )).length;
  return styleCount + (segment?.placement ? 1 : 0);
}

export function resolveCaptionSizeForSegment(captionSize, segment) {
  const override = Number(getCaptionSegmentOverrides(segment).captionSize);
  return Number.isFinite(override) && override > 0 ? override : captionSize;
}

export function applyCaptionPresetToStyle(currentStyle, preset) {
  if (!preset) return currentStyle;
  return {
    ...currentStyle,
    ...preset.style,
  };
}

export function buildCaptionPresetSnapshot(name, captionStyle, captionSize) {
  return {
    id: `caption-style-${crypto.randomUUID()}`,
    name,
    captionSize,
    style: Object.fromEntries(CAPTION_VISUAL_STYLE_KEYS.map((key) => [key, captionStyle[key]])),
  };
}

export const REAL_CAPTION_STYLE_NAMES = Object.freeze({
  classic: "Classic",
  bold: "Bold",
  karaoke: "Karaoke",
  minimal: "Minimal",
  social: "Social",
  plain: "Plain",
  outline: "Outline",
  translucent: "Translucent",
  neon: "Neon",
});

export function getAvailableCaptionStyles(offset = 0, limit = 5) {
  const all = BUILTIN_CAPTION_STYLE_PRESETS.map((p) => ({
    id: p.id,
    name: REAL_CAPTION_STYLE_NAMES[p.id] || p.id,
    labelKey: p.labelKey,
    sampleClass: p.sampleClass,
    captionSize: p.captionSize,
    style: p.style,
  }));
  const items = all.slice(offset, offset + limit);
  const nextOffset = offset + limit < all.length ? offset + limit : null;
  const hasMore = nextOffset !== null;
  return { items, hasMore, nextOffset, total: all.length };
}

export function findCaptionStylePreset(query) {
  if (!query || typeof query !== "string") return null;
  const q = query.trim().toLowerCase();
  return (
    BUILTIN_CAPTION_STYLE_PRESETS.find(
      (p) =>
        p.id.toLowerCase() === q ||
        (REAL_CAPTION_STYLE_NAMES[p.id] && REAL_CAPTION_STYLE_NAMES[p.id].toLowerCase() === q)
    ) || null
  );
}

export const SUPPORTED_CAPTION_EFFECTS = Object.freeze(["normal", "neon"]);

export const NAMED_COLOR_MAP = Object.freeze({
  red: "#FF0000",
  green: "#00FF00",
  blue: "#0000FF",
  yellow: "#FFFF00",
  cyan: "#00FFFF",
  magenta: "#FF00FF",
  white: "#FFFFFF",
  black: "#000000",
  orange: "#FFA500",
  purple: "#800080",
  pink: "#FFC0CB",
  gold: "#FFD700",
  teal: "#008080",
  lime: "#00FF00",
  violet: "#EE82EE",
  amber: "#FFBF00",
  emerald: "#50C878",
  indigo: "#4B0082",
  crimson: "#DC143C",
  coral: "#FF7F50",
  turquoise: "#40E0D0",
  navy: "#000080",
  silver: "#C0C0C0",
  gray: "#808080",
  grey: "#808080",
});

export function resolveColorToHex(input) {
  if (!input || typeof input !== "string") return null;
  const str = input.trim();
  const lower = str.toLowerCase();
  if (NAMED_COLOR_MAP[lower]) return NAMED_COLOR_MAP[lower];
  if (/^#[0-9a-fA-F]{6}$/.test(str)) {
    return str.toUpperCase();
  }
  if (/^#[0-9a-fA-F]{3}$/.test(str)) {
    return `#${str[1]}${str[1]}${str[2]}${str[2]}${str[3]}${str[3]}`.toUpperCase();
  }
  return null;
}
