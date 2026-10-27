import { useCallback } from "react";
import { transcribeAudioToCaptionSegments } from "../lib/asr.js";
import { sliceAudioBlob } from "../lib/media.js";

export function localizeAutoCaptionPhase(phase, t) {
  const text = String(phase || "");
  const format = (key, fallback, values = {}) => Object.entries(values).reduce(
    (result, [name, value]) => result.replace(`{${name}}`, value),
    t(key, fallback),
  );
  if (text.includes("下载或读取") && text.includes("Whisper")) return t("asrDownloadingModel", text);
  if (text.includes("识别音频语言")) return t("asrDetectingLanguage", text);
  if (text.includes("初始化 WebGPU")) return t("asrInitializingWebGpu", text);
  if (text.includes("初始化 WASM")) return t("asrInitializingWasm", text);
  if (text.includes("WebGPU 初始化失败")) return t("asrFallingBackWasm", text);
  if (text.includes("解码原声音频")) return t("asrDecodingAudio", text);
  if (text.includes("Worker 不可用")) return t("asrWorkerFallback", text);
  if (text.includes("Worker 结果异常")) return t("asrRetryingWasm", text);
  if (text.includes("写入字幕轨道")) return t("asrWritingCaptions", text);
  const languageMatch = text.match(/(?:检测为|按)\s+(.+?)\s+转写字幕/);
  if (languageMatch) return format("asrTranscribingLanguage", text, { language: languageMatch[1] });
  return text;
}

import { resolveCaptionSourceMedia } from "../lib/captionSourceResolver.js";
export { resolveCaptionSourceMedia };

export function useAutoCaptions(d) {
  return useCallback(async (options = {}) => {
    if (d.status === "generating" || d.status === "captioning") {
      const busyMsg = typeof d.t === "function" ? d.t("captionGeneratorBusy", "Caption generator is busy. Please wait for the current task to finish.") : "Caption generator is busy.";
      d.notify?.(busyMsg);
      if (options.throwOnError) {
        const err = new Error(busyMsg);
        err.code = "CAPTION_GENERATOR_BUSY";
        throw err;
      }
      return null;
    }
    if (d.trackLocks?.caption || d.trackLocks?.captions) {
      const lockMsg = typeof d.t === "function" ? d.t("captionTrackLocked", "Caption track is locked.") : "Caption track is locked.";
      d.notify?.(lockMsg);
      if (options.throwOnError) {
        const err = new Error(lockMsg);
        err.code = "CAPTION_TRACK_LOCKED";
        throw err;
      }
      return null;
    }

    const resolvedSource = await resolveCaptionSourceMedia(d, options);
    if (!resolvedSource?.blob) {
      const needsSourceMsg = typeof d.t === "function" ? d.t("autoCaptionsNeedsSource", "Upload video or drop audio on the source track first") : "Upload video or drop audio on the source track first";
      d.notify?.(needsSourceMsg);
      if (options.throwOnError) {
        const err = new Error(needsSourceMsg);
        err.code = "CAPTION_SOURCE_MISSING";
        throw err;
      }
      return null;
    }

    const inputBlob = resolvedSource.blob;
    const timelineOffset = resolvedSource.start;
    const clipDuration = Number.isFinite(options.duration) ? options.duration : resolvedSource.duration;
    const clipSourceStart = Number.isFinite(options.sourceStart) ? options.sourceStart : resolvedSource.sourceStart;

    d.setStatus("captioning"); d.setStatusText(d.t("autoCaptionsPreparing")); d.setProgress(4); d.setActiveTool("audio");
    try {
      const clipBlob = Number.isFinite(clipDuration) && clipDuration > 0
        ? await sliceAudioBlob(inputBlob, clipSourceStart || 0, clipDuration)
        : inputBlob;
      const result = await transcribeAudioToCaptionSegments(clipBlob, {
        preferredLanguage: d.uiLanguage, timelineOffset, grouping: options.grouping,
        onProgress: ({ progress, phase }) => { d.setProgress((current) => Math.max(current, progress)); d.setStatusText(localizeAutoCaptionPhase(phase, d.t)); },
      });
      if (!result?.segments?.length) {
        const noSpeechMsg = typeof d.t === "function" ? d.t("noSpeechDetected", "No speech detected in audio.") : "No speech detected in audio.";
        d.notify?.(noSpeechMsg);
        if (options.throwOnError) {
          const err = new Error(noSpeechMsg);
          err.code = "NO_SPEECH_DETECTED";
          throw err;
        }
        return null;
      }
      if (typeof d.setTranscriptReview === "function" && !options.skipReview) {
        d.setTranscriptReview({
          isOpen: true,
          text: result.text,
          segments: result.segments,
          rawChunks: result.rawChunks || result.output?.chunks || [],
          duration: result.duration,
          timelineOffset,
          grouping: options.grouping || "phrases",
          language: result.language,
          append: Boolean(options.append),
        });
        const readyMsg = d.t("reviewCaptionsReady", "Captions ready for review");
        d.setStatus("done");
        d.setStatusText(readyMsg);
        d.setProgress(100);
        d.notify(readyMsg);
        return result;
      }

      d.setCaptionSegments((segments) => {
        const combined = (options.append ? [...segments, ...result.segments] : result.segments)
          .sort((a, b) => (a.start || 0) - (b.start || 0));
        let inheritedFontId = d.captionStyle?.fontId || "default";
        return combined.map((segment) => {
          inheritedFontId = segment.fontId || inheritedFontId;
          return segment.fontId ? segment : { ...segment, fontId: inheritedFontId };
        });
      });
      d.setScript((script) => options.append && script ? `${script}\n${result.text}` : result.text);
      d.setSelectedSegmentId(result.segments[0]?.id ?? ""); d.setSelectedTrack("caption"); d.setActiveTool("caption");
      d.setCaptionsEnabled(true); d.setTrackVisibility((visibility) => ({ ...visibility, caption: true }));
      const complete = d.t("autoCaptionsComplete").replace("{count}", result.segments.length);
      d.setStatus("done"); d.setStatusText(complete); d.setProgress(100);
      d.seekTo(result.segments[0]?.start ?? timelineOffset); d.notify(complete);
      return result;
    } catch (error) {
      console.error(error); d.setStatus("error"); d.setStatusText(/ASR_WORD_TIMING_UNAVAILABLE|alignment_heads|attentions|token-level timestamps/i.test(error?.message || "")
        ? d.t("captionTimingUnavailable") : d.t("autoCaptionsFailed"));
      d.setProgress(0); d.notify(d.t("autoCaptionsFailedHint"));
      if (options.throwOnError) {
        if (!error.code) {
          error.code = "CAPTION_GENERATION_FAILED";
        }
        throw error;
      }
      return null;
    }
  }, [d]);
}
