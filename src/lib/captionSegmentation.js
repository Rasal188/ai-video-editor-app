import { makeId } from "./timeline.js";

// Sanitize word timestamps emitted by chunked ASR (e.g. Whisper ONNX DTW).
// When an audio chunk has speech at its beginning followed by long silence/music,
// DTW can stretch the leading tokens to the end of the chunk window, producing
// a backward jump when the next speech chunk begins at its actual acoustic onset.
export function sanitizeAsrWordTimestamps(chunks) {
  if (!Array.isArray(chunks) || chunks.length <= 1) {
    return chunks;
  }
  const result = chunks.map((c) => ({
    ...c,
    timestamp: Array.isArray(c?.timestamp) ? [...c.timestamp] : c?.timestamp,
  }));

  for (let i = 1; i < result.length; i++) {
    const prev = result[i - 1];
    const curr = result[i];
    const prevEnd = Number(prev?.timestamp?.[1] ?? prev?.timestamp?.[0]);
    const currStart = Number(curr?.timestamp?.[0]);

    if (Number.isFinite(prevEnd) && Number.isFinite(currStart) && currStart < prevEnd) {
      let runStart = i - 1;
      while (
        runStart > 0 &&
        Number(result[runStart - 1]?.timestamp?.[1] ?? result[runStart - 1]?.timestamp?.[0]) <=
          Number(result[runStart]?.timestamp?.[0])
      ) {
        runStart--;
      }
      const targetStart =
        runStart === 0
          ? 0
          : Number(result[runStart - 1]?.timestamp?.[1] ?? result[runStart - 1]?.timestamp?.[0] ?? 0);
      const runStartVal = Number(result[runStart]?.timestamp?.[0] ?? 0);
      const shift = runStartVal - targetStart;

      if (shift > 0) {
        for (let j = runStart; j < i; j++) {
          const rawS = Number(result[j]?.timestamp?.[0]);
          const rawE = Number(result[j]?.timestamp?.[1]);
          if (Number.isFinite(rawS)) {
            result[j].timestamp[0] = Math.max(0, Number((rawS - shift).toFixed(2)));
          }
          if (Number.isFinite(rawE)) {
            result[j].timestamp[1] = Math.max(
              result[j].timestamp[0],
              Number((rawE - shift).toFixed(2)),
            );
          }
        }
      }
    }
  }

  return result;
}

// Use recognizer word boundaries, never a character-weighted estimate of speech.
// Ordinary caption clips keep all preview/export/SRT and editing paths identical.
export function captionSegmentsFromWords(chunks, duration, {
  timelineOffset = 0, grouping = "phrases", normalizeText = (text) => text.trim(),
} = {}) {
  const timingError = () => new Error("ASR_WORD_TIMING_UNAVAILABLE");
  if (!Array.isArray(chunks) || !chunks.length || !(duration > 0)) throw timingError();
  const sanitizedChunks = sanitizeAsrWordTimestamps(chunks);
  const words = sanitizedChunks.filter((chunk) => String(chunk?.text ?? "").trim());
  const transcript = words.map((word) => String(word.text)).join("");
  const boundaries = typeof Intl.Segmenter === "function"
    ? new Set(Array.from(new Intl.Segmenter(undefined, { granularity: "word" }).segment(transcript), (part) => part.index))
    : null;
  let textOffset = 0;
  const offset = Math.max(0, Number(timelineOffset) || 0);
  const segments = [];
  let group = [];
  let previousEnd = 0;
  const timestamp = (value) => value !== null && value !== undefined && Number.isFinite(Number(value))
    ? Number(value) : null;
  const join = (items) => items.map((item) => item.text).join("").trim();
  const width = (text) => Array.from(text).reduce((sum, char) => sum + (/[^\u0000-\u024f]/u.test(char) ? 2 : 1), 0);
  function flush() {
    if (!group.length) return;
    const rawText = join(group);
    const start = group[0].start;
    const rawEnd = group.at(-1).end;
    if (rawEnd <= start) return; // Keep zero-length tokens with the next timed word.
    const end = Math.min(duration, Math.max(start + 0.2, rawEnd));
    const text = normalizeText(rawText);
    const segStart = offset + start;
    const segEnd = offset + end;
    const segWords = group
      .filter((item) => item && Number.isFinite(item.start) && Number.isFinite(item.end))
      .map((item) => {
        const itemStart = Math.max(start, Math.min(end, item.start));
        const itemEnd = Math.max(itemStart, Math.min(end, item.end));
        return {
          text: String(item.text).trim() || String(item.text),
          start: offset + itemStart,
          end: offset + itemEnd,
        };
      })
      .filter((w) => w.text.length > 0 && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start);
    segments.push({
      id: makeId("caption"), text, start: segStart, end: segEnd,
      hidden: false, source: "asr", timingSource: "asr-word",
      words: segWords,
      ...(text !== rawText ? { rawText } : {}),
    });
    group = [];
  }
  words.forEach((word, index) => {
    const rawStart = timestamp(word.timestamp?.[0]);
    const rawEnd = timestamp(word.timestamp?.[1]);
    if (rawStart === null) throw timingError();
    const nextStart = timestamp(words[index + 1]?.timestamp?.[0]);
    const effectivePrev = rawStart < previousEnd - 0.25 ? rawStart : previousEnd;
    const start = Math.min(duration, Math.max(effectivePrev, rawStart, 0));
    const fallbackEnd = nextStart !== null && nextStart >= start
      ? Math.min(start + 0.35, nextStart)
      : Math.min(duration, start + 0.35);
    const boundedRawEnd = rawEnd !== null ? (nextStart !== null && nextStart >= start ? Math.min(rawEnd, nextStart) : rawEnd) : null;
    const end = Math.max(start, Math.min(duration, boundedRawEnd ?? fallbackEnd));
    const item = { text: String(word.text), start, end };
    // Whisper emits individual characters for Chinese/Japanese. A four-token
    // limit intended for spaced languages would fragment these into tiny clips.
    const maxTokens = /[\u3040-\u30ff\u3400-\u9fff]/u.test(join([...group, item])) ? 12 : 4;
    const isSilenceGap = group.length > 0 && (start - group.at(-1).end > 0.35);
    const canBreak = !boundaries || boundaries.has(textOffset) || isSilenceGap;
    if (group.length && canBreak && (grouping === "words" || isSilenceGap || (group.length >= maxTokens
      || width(join([...group, item])) > 28 || end - group[0].start > 2.5))) flush();
    textOffset += item.text.length;
    group.push(item);
    previousEnd = end;
    if (/[.!?。！？,，;；:：][”’"']?\s*$/u.test(item.text)) flush();
  });
  flush();
  // A degenerate final token has no independent display interval. Preserve its
  // text on the preceding caption instead of dropping punctuation or a word.
  if (group.length && segments.length) {
    const last = segments.at(-1);
    last.text = normalizeText((last.rawText ?? last.text) + group.map((item) => item.text).join(""));
    delete last.rawText;
    if (Array.isArray(last.words)) {
      const extraWords = group
        .filter((item) => item && Number.isFinite(item.start) && Number.isFinite(item.end))
        .map((item) => {
          const itemStart = Math.min(last.end, Math.max(last.start, offset + item.start));
          const itemEnd = Math.max(itemStart, Math.min(last.end, offset + item.end));
          return {
            text: String(item.text).trim() || String(item.text),
            start: itemStart,
            end: itemEnd,
          };
        })
        .filter((w) => w.text.length > 0 && w.end >= w.start);
      last.words.push(...extraWords);
    }
  } else if (group.length || !segments.length) throw timingError();
  return segments;
}
