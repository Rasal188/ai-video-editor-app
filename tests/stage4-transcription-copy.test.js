import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { APP_LANGUAGES, createTranslator, UI_COPY } from "../src/i18n.js";
import { I18N_COMPLETION_COPY } from "../src/i18nCompletion.js";
import { CAPTION_GROUPING_COPY } from "../src/i18nCaptionGrouping.js";
import { SMART_PIPELINE_COPY } from "../src/i18nSmartPipeline.js";

const readSource = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
// Check localized semantics, not just the presence of provider names.
const disclosures = {
    zh: [/默认/, /上传音频/, /也可选择本机/],
    en: [/default/, /uploads audio/, /on this device.*alternative/],
    ja: [/既定/, /音声をアップロード/, /端末上.*も選択/],
    ko: [/기본값/, /오디오 업로드/, /이 기기의.*선택/],
    es: [/predeterminada|por defecto/, /sube el audio/, /este dispositivo.*alternativa/],
    fr: [/par défaut/, /envoi audio/, /cet appareil.*alternative/],
    de: [/Standard|standardmäßig/, /Audio-Upload/, /alternativ.*diesem Gerät/],
    pt: [/padrão/, /envia o áudio/, /neste dispositivo.*alternativa/],
    th: [/ค่าเริ่มต้น/, /อัปโหลดเสียง/, /หรือเลือก.*บนอุปกรณ์นี้ได้/],
    vi: [/Mặc định|mặc định/, /tải âm thanh lên/, /có thể chọn.*trên thiết bị này/],
    ru: [/По умолчанию|по умолчанию/, /загрузка аудио/, /альтернатива.*на этом устройстве/],
    it: [/predefinito|predefinita/, /carica audio/, /questo dispositivo.*alternativa/],
    id: [/Defaultnya|default/, /mengunggah audio/, /perangkat ini.*alternatif/],
};

test("disclosure coverage matches all 13 existing UI locales", () => {
    assert.equal(APP_LANGUAGES.length, 13);
    assert.deepEqual(Object.keys(disclosures).sort(), APP_LANGUAGES.map(({ id }) => id).sort());
});

for (const [language, patterns] of Object.entries(disclosures)) {
    test(`${language}: effective Captions/Audio and Smart Pipeline copy disclose Cloud default and Local alternative`, () => {
        const translate = createTranslator(language);
        for (const [key, dictionary] of [
            ["autoCaptionsDesc", CAPTION_GROUPING_COPY],
            ["smartPipelineAnalyzingHint", SMART_PIPELINE_COPY],
        ]) {
            const text = translate(key);
            assert.equal(text, dictionary[language][key], `${key} must resolve to its localized active dictionary`);
            assert.match(text, /Ollalink Cloud/);
            assert.match(text, /Local Whisper/);
            for (const pattern of patterns) assert.match(text, pattern, `${language} ${key}: ${pattern}`);
            assert.doesNotMatch(text, /Whisper small|local AI models|本地 AI 模型|로컬 AI로/);
        }
        // Shadowed base/completion strings must not reintroduce local-only copy if reused.
        const base = UI_COPY[language]?.autoCaptionsDesc;
        const completion = I18N_COMPLETION_COPY[language]?.autoCaptionsDesc;
        // Several base locale dictionaries intentionally inherit the English description.
        if (base !== undefined) assert.ok([translate("autoCaptionsDesc"), CAPTION_GROUPING_COPY.en.autoCaptionsDesc].includes(base));
        if (completion !== undefined) assert.equal(completion, translate("autoCaptionsDesc"));
    });
}

test("existing UI entry points retain description keys and the modal fallback agrees with localized copy", () => {
    for (const path of ["src/components/VoicePanel.jsx", "src/components/panels.jsx"]) {
        assert.match(readSource(path), /t\("autoCaptionsDesc"\)/);
    }
    const modal = readSource("src/components/SmartPipelineModal.jsx");
    const fallback = modal.match(/"smartPipelineAnalyzingHint",\s*("[^"\n]*")/);
    assert.ok(fallback);
    assert.equal(JSON.parse(fallback[1]), SMART_PIPELINE_COPY.en.smartPipelineAnalyzingHint);
    assert.doesNotMatch(modal, /Running local Silero VAD pause analysis & Whisper speech recognition/);
});

// Evaluate only existing pure mapping/detection helpers, not production module imports.
// No workers, model loading, model inference, audio decoding, or network requests run.
function loadLanguageHelpers(path) {
    const source = readSource(path);
    const names = [
        "normalizeTokenId", "getGeneratedTokenIds", "getWhisperLanguageIdMap",
        "normalizeWhisperLanguageToken", "getPreferredWhisperLanguage",
        "getLanguageDetectionSample", "isMultilingualWhisper", "detectWhisperLanguage",
    ];
    const declarations = ["UI_LANGUAGE_TO_WHISPER_LANGUAGE", "WHISPER_LANGUAGE_NAMES"].map((name) => {
        const match = source.match(new RegExp(`const ${name} = \\{[\\s\\S]*?\\n\\};`));
        assert.ok(match, `${path}: ${name}`);
        return match[0];
    });
    for (const name of names) {
        const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
        assert.ok(match, `${path}: ${name}`);
        declarations.push(match[0]);
    }
    const context = vm.createContext({
        console: { warn() { } },
        DOMException,
        ASR_SAMPLE_RATE: 16000,
        LANGUAGE_DETECTION_SECONDS: 20,
        postProgress() { },
        throwIfAborted(signal) {
            if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
        },
    });
    const helpers = vm.runInContext(`${declarations.join("\n")}\n({ getPreferredWhisperLanguage, detectWhisperLanguage, languageNames: WHISPER_LANGUAGE_NAMES });`, context);
    return {
        ...helpers,
        async detect(transcriber, language, signal) {
            // Main-thread helper takes progress + signal; worker takes request ID.
            const result = path.includes("workers/")
                ? await helpers.detectWhisperLanguage(transcriber, new Float32Array(400001), language, "test-request")
                : await helpers.detectWhisperLanguage(transcriber, new Float32Array(400001), language, undefined, signal);
            return { language: result.language, detected: result.detected };
        },
    };
}

function stubTranscriber({ token = 20, noMap = false, noStart = false, fail = false, multilingual = true } = {}) {
    const calls = { processor: 0, generate: 0 };
    return {
        calls,
        processor: async (audio) => {
            calls.processor++;
            assert.equal(audio.length, 20 * 16000, "detection continues to use the bounded sample");
            return { input_features: "stub features" };
        },
        model: {
            generation_config: {
                is_multilingual: multilingual,
                ...(noMap ? {} : { lang_to_id: { "<|es|>": 20, "<|hi|>": 21, "<|ar|>": 22 } }),
                ...(noStart ? {} : { decoder_start_token_id: 1 }),
            },
            generate: async (options) => {
                calls.generate++;
                assert.equal(options.max_new_tokens, 1);
                assert.equal(options.return_timestamps, false);
                assert.equal(options.inputs, "stub features");
                if (fail) throw new Error("simulated detection failure");
                return [[1, token]];
            },
        },
    };
}

for (const path of ["src/lib/asr.js", "src/workers/asr.worker.js"]) {
    const helpers = loadLanguageHelpers(path);
    test(`${path}: all existing preferences plus Hindi/Arabic map without changing unknown fallback`, () => {
        for (const language of [...Object.keys(disclosures), "hi", "ar"]) {
            assert.equal(helpers.getPreferredWhisperLanguage(language), language);
            assert.ok(helpers.languageNames[language]);
        }
        for (const language of [undefined, "", "unsupported"]) {
            assert.equal(helpers.getPreferredWhisperLanguage(language), "zh");
        }
    });
    for (const language of ["hi", "ar"]) {
        test(`${path}: successful autodetection still overrides ${language} preference`, async () => {
            const transcriber = stubTranscriber();
            assert.deepEqual(await helpers.detect(transcriber, language), { language: "es", detected: true });
            assert.deepEqual(transcriber.calls, { processor: 1, generate: 1 });
        });
        test(`${path}: successful ${language} autodetection still overrides other preferences`, async () => {
            const transcriber = stubTranscriber({ token: language === "hi" ? 21 : 22 });
            assert.deepEqual(await helpers.detect(transcriber, "en"), { language, detected: true });
        });
        for (const [condition, options, expectedCalls] of [
            ["unavailable language map", { noMap: true }, 0],
            ["unavailable decoder start", { noStart: true }, 0],
            ["unrecognized detection token", { token: 999 }, 1],
            ["failed detection", { fail: true }, 1],
        ]) {
            test(`${path}: ${condition} falls back to preferred ${language}`, async () => {
                const transcriber = stubTranscriber(options);
                assert.deepEqual(await helpers.detect(transcriber, language), { language, detected: false });
                assert.deepEqual(transcriber.calls, { processor: expectedCalls, generate: expectedCalls });
            });
        }
    }
    test(`${path}: English-only model behavior remains unchanged`, async () => {
        const transcriber = stubTranscriber({ multilingual: false });
        assert.deepEqual(await helpers.detect(transcriber, "hi"), { language: "en", detected: false });
        assert.deepEqual(transcriber.calls, { processor: 0, generate: 0 });
    });
    if (!path.includes("workers/")) {
        test(`${path}: an aborted detection is not converted to a language fallback`, async () => {
            const controller = new AbortController();
            controller.abort();
            const transcriber = stubTranscriber();
            await assert.rejects(helpers.detect(transcriber, "ar", controller.signal), { name: "AbortError" });
            assert.deepEqual(transcriber.calls, { processor: 0, generate: 0 });
        });
    }
}
