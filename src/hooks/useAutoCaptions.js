import { captureTranscriptionPreferences } from "../lib/transcriptionPreferences.js";
import { useCallback, useEffect, useRef } from "react";
import { createAutoCaptionOperationScope } from "../lib/autoCaptionOperation.js";
import { attachTranscriptionOutcome, attachTranscriptionErrorOutcome, getTranscriptionOutcome } from "../lib/transcriptionOutcome.js";
import { workflowTranscriptionOutcome, isTranscriptionCancellation } from "../lib/workflowTranscription.js";
import { editorTranscriptionStatus } from "../lib/editorTranscription.js";
import { transcribeAudioToCaptionSegments } from "../lib/asr.js";
import { sliceAudioBlob } from "../lib/media.js";

export function localizeAutoCaptionPhase(phase, t) {
  const text = String(phase || "");
  const prefix = text.match(/^(Local Whisper(?: fallback)?): /);
  if (prefix) return prefix[0] + localizeAutoCaptionPhase(text.slice(prefix[0].length), t);
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
  const scopeRef = useRef(null);
  if (!scopeRef.current) scopeRef.current = createAutoCaptionOperationScope();
  const scope = scopeRef.current;
  useEffect(() => () => scope.dispose(), [scope]);
  const cancel = useCallback(() => {
    if (!scope.active) return;
    scope.cancel();
    d.setStatusText(d.t("captionCancelling", "Cancelling transcription…"));
  }, [scope, d]);
  const generate = useCallback(async (options = {}) => {
    options = captureTranscriptionPreferences(options);
    if (scope.active || d.status === "generating" || d.status === "captioning") {
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

    const operation = scope.begin();
    const signal = options.signal ? AbortSignal.any([operation.signal, options.signal]) : operation.signal;
    const isCurrent = () => operation.isCurrent() && !signal.aborted;
    const assertCurrent = () => { if (!isCurrent()) throw new DOMException("Cancelled", "AbortError"); };
    const onAbort = () => operation.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    d.setStatus("captioning");
    d.setStatusText(options.provider === "ollalink" ? "Preparing Ollalink transcription" : "Preparing Local Whisper transcription");
    d.setProgress(null);
    d.setActiveTool("audio");
    let completionOutcome = null;
    try {
      assertCurrent();
      const resolvedSource = await resolveCaptionSourceMedia(d, { ...options, signal });
      assertCurrent();
      if (!resolvedSource?.blob) {
        const needsSourceMsg = typeof d.t === "function" ? d.t("autoCaptionsNeedsSource", "Upload video or drop audio on the source track first") : "Upload video or drop audio on the source track first";
        d.setStatus("idle");
        d.setStatusText(needsSourceMsg);
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

      const clipBlob = Number.isFinite(clipDuration) && clipDuration > 0
        ? await sliceAudioBlob(inputBlob, clipSourceStart || 0, clipDuration)
        : inputBlob;
      assertCurrent();
      const transcribed = await transcribeAudioToCaptionSegments(clipBlob, {
        preferredLanguage: d.uiLanguage, timelineOffset, grouping: options.grouping,
        provider: options.provider, language: options.language, signal, requireWorker: options.requireWorker,
        onProgress: ({ progress, phase }) => {
          if (!isCurrent() || !scope.active) return;
          d.setProgress((current) => !isCurrent() || !scope.active ? current : Number.isFinite(progress) ? progress : null);
          d.setStatusText(localizeAutoCaptionPhase(phase, d.t));
        },
      });
      assertCurrent();
      const result = attachTranscriptionOutcome(transcribed, transcribed);
      completionOutcome = getTranscriptionOutcome(result);
      if (!result?.segments?.length) {
        const noSpeechMsg = typeof d.t === "function" ? d.t("noSpeechDetected", "No speech detected in audio.") : "No speech detected in audio.";
        d.setStatus("idle");
        d.setStatusText(noSpeechMsg);
        d.notify?.(noSpeechMsg);
        if (options.throwOnError) {
          const err = new Error(noSpeechMsg);
          err.code = "NO_SPEECH_DETECTED";
          throw err;
        }
        return null;
      }
      // Assistant transactions stage results; the caller validates live project
      // ownership again before its single editor commit. Normal callers retain
      // the existing review/apply flow and captured provider settings.
      const providerNote = editorTranscriptionStatus(result);
      if (options.stageOnly) {
        d.setStatus("done");
        d.setStatusText(`${d.t("reviewCaptionsReady", "Captions ready for review")} · ${providerNote}`);
        d.setProgress(100);
        return result;
      }
      if (typeof d.setTranscriptReview === "function" && !options.skipReview) {
        d.setTranscriptReview(attachTranscriptionOutcome({
          isOpen: true,
          text: result.text,
          segments: result.segments,
          rawChunks: result.rawChunks || result.output?.chunks || [],
          duration: result.duration,
          timelineOffset,
          grouping: options.grouping || "phrases",
          language: result.language,
          provider: result.provider,
          fallbackFrom: result.fallbackFrom,
          append: Boolean(options.append),
        }, result));
        const readyMsg = `${d.t("reviewCaptionsReady", "Captions ready for review")} · ${providerNote}`;
        d.setStatus("done");
        d.setStatusText(readyMsg);
        d.setProgress(100);
        d.notify(readyMsg);
        return result;
      }

      d.setCaptionSegments((segments) => {
        if (!isCurrent()) return segments;
        const combined = (options.append ? [...segments, ...result.segments] : result.segments)
          .sort((a, b) => (a.start || 0) - (b.start || 0));
        let inheritedFontId = d.captionStyle?.fontId || "default";
        return combined.map((segment) => {
          inheritedFontId = segment.fontId || inheritedFontId;
          return segment.fontId ? segment : { ...segment, fontId: inheritedFontId };
        });
      });
      d.setScript((script) => !isCurrent() ? script : options.append && script ? `${script}\n${result.text}` : result.text);
      d.setSelectedSegmentId(result.segments[0]?.id ?? ""); d.setSelectedTrack("caption"); d.setActiveTool("caption");
      d.setCaptionsEnabled(true); d.setTrackVisibility((visibility) => !isCurrent() ? visibility : ({ ...visibility, caption: true }));
      const complete = `${d.t("autoCaptionsComplete").replace("{count}", result.segments.length)} · ${providerNote}`;
      d.setStatus("done"); d.setStatusText(complete); d.setProgress(100);
      d.seekTo(result.segments[0]?.start ?? timelineOffset); d.notify(complete);
      return result;
    } catch (error) {
      const cancelled = !isCurrent() || isTranscriptionCancellation(error, signal);
      completionOutcome = workflowTranscriptionOutcome(error, options, cancelled ? "cancelled" : "failed");
      attachTranscriptionErrorOutcome(error, completionOutcome);
      if (cancelled) {
        operation.abort();
        if (options.throwOnError) throw error;
        return null;
      }
      d.setStatus("error"); d.setStatusText(`${/ASR_WORD_TIMING_UNAVAILABLE|alignment_heads|attentions|token-level timestamps/i.test(error?.message || "")
        ? d.t("captionTimingUnavailable") : d.t("autoCaptionsFailed")} · ${editorTranscriptionStatus(completionOutcome)}`);
      d.setProgress(0); d.notify(d.t("autoCaptionsFailedHint"));
      if (options.throwOnError) {
        if (!error.code && Object.isExtensible(error)) {
          error.code = "CAPTION_GENERATION_FAILED";
        }
        throw error;
      }
      return null;
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      if (operation.isOwner() && signal.aborted) {
        d.setStatus("idle");
        d.setStatusText(editorTranscriptionStatus(completionOutcome || workflowTranscriptionOutcome(null, options, "cancelled")));
        d.setProgress(0);
      }
      operation.finish();
    }
  }, [d, scope]);
  return { generate, cancel };
}
