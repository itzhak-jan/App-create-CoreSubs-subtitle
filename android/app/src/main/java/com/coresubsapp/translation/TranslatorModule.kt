package com.coresubsapp.translation

import com.facebook.react.bridge.*
import com.facebook.react.module.annotations.ReactModule
import com.google.mediapipe.tasks.genai.llminference.LlmInference
import kotlinx.coroutines.*
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/**
 * React Native bridge to on-device English→Hebrew translation via Google's
 * TranslateGemma-4B, run through the MediaPipe LLM Inference ("Task Genai")
 * API.
 *
 * Why this replaced a raw TFLite Interpreter + NLLB-200 approach: there is
 * no verified, stably-hosted NLLB-200 TFLite conversion — Meta only
 * publishes NLLB as PyTorch checkpoints, and the community conversions
 * found are CTranslate2/ONNX, not TFLite (see ModelManifest.ts). Google
 * officially publishes TranslateGemma as a LiteRT-converted .task bundle
 * under the `litert-community` org, ready for the LLM Inference API — no
 * custom tokenizer/encoder-decoder loop to hand-roll (the task handles
 * tokenisation internally), at the cost of a much larger download (a 4B
 * parameter model vs. NLLB's 600M).
 *
 * UNVERIFIED — confirm before shipping (this session's sandbox couldn't
 * browse huggingface.co to check; see ModelManifest.ts header):
 *   - The exact filename/size of the Android-usable .task bundle under
 *     litert-community/TranslateGemma-4B-IT. Search results surfaced a
 *     "-web.task" variant for MediaPipe *web*, which is NOT this API —
 *     confirm there's a mobile/Android bundle before pointing the manifest
 *     at it.
 *   - Whether the download is gated behind a Gemma license acceptance /
 *     HuggingFace account. If so, an anonymous RNFS.downloadFile() won't
 *     work — either self-host a copy after accepting the license once
 *     yourself, or add an Authorization header (ManifestAsset would need
 *     an optional `headers` field; not implemented here since it's
 *     unneeded until the gating question is settled).
 *   - The model's official prompt/chat template for translation
 *     (google/translategemma-4b-it ships a chat_template.jinja) — the
 *     PROMPT_TEMPLATE below is a reasonable instruction-style guess, not
 *     copied from that file. Mismatched formatting will still produce
 *     output, just with lower quality than the model is capable of.
 *
 * Hardware notes for Pixel 10 Pro XL: the LLM Inference API dispatches to
 * GPU/NPU automatically where supported by the backend build; no manual
 * delegate wiring is needed here (unlike the old raw-TFLite module).
 */
@ReactModule(name = TranslatorModule.NAME)
class TranslatorModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "TranslatorModule"

        // Keep the model's own turn markers in sync with whatever chat
        // template TranslateGemma actually expects — see class doc above.
        private const val PROMPT_TEMPLATE =
            "Translate the following English text to Hebrew. " +
                "Respond with only the Hebrew translation, no explanation.\n\n" +
                "Text: %s\nTranslation:"

        private const val MAX_TOKENS = 256
        private const val TOP_K = 40
        private const val TEMPERATURE = 0.3f // low — translation wants fidelity, not creativity
    }

    private var llmInference: LlmInference? = null
    private val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())
    private val abortFlag = AtomicBoolean(false)

    override fun getName(): String = NAME

    @ReactMethod
    fun init(modelPath: String, promise: Promise) {
        scope.launch {
            try {
                llmInference?.close()

                val modelFile = File(modelPath)
                if (!modelFile.exists()) {
                    promise.reject("TRANSLATOR_MODEL_NOT_FOUND", "Model file not found: $modelPath")
                    return@launch
                }

                val options = LlmInference.LlmInferenceOptions.builder()
                    .setModelPath(modelPath)
                    .setMaxTokens(MAX_TOKENS)
                    .setTopK(TOP_K)
                    .setTemperature(TEMPERATURE)
                    .build()

                llmInference = LlmInference.createFromOptions(reactApplicationContext, options)
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("TRANSLATOR_INIT_ERROR", e.message, e)
            }
        }
    }

    /**
     * Translates a batch of source texts. The LLM Inference API generates
     * one response per prompt (no native tensor-batching), so this loops
     * sequentially — acceptable given the on-device thermal budget this
     * project already designs around (one AI task in flight at a time).
     */
    @ReactMethod
    fun translateBatch(texts: ReadableArray, promise: Promise) {
        val engine = llmInference
        if (engine == null) {
            promise.reject("TRANSLATOR_NOT_INIT", "Call init() before translateBatch()")
            return
        }
        abortFlag.set(false)

        scope.launch {
            try {
                val results = Arguments.createArray()
                for (i in 0 until texts.size()) {
                    if (abortFlag.get()) break
                    val text = texts.getString(i) ?: ""
                    results.pushString(translateSingle(engine, text))
                }
                promise.resolve(results)
            } catch (e: Exception) {
                if (!abortFlag.get()) {
                    promise.reject("TRANSLATOR_ERROR", e.message, e)
                } else {
                    promise.resolve(Arguments.createArray())
                }
            }
        }
    }

    @ReactMethod
    fun abort() {
        abortFlag.set(true)
    }

    override fun onCatalystInstanceDestroy() {
        scope.cancel()
        llmInference?.close()
        llmInference = null
    }

    private fun translateSingle(engine: LlmInference, text: String): String {
        if (text.isBlank()) return text
        val prompt = PROMPT_TEMPLATE.format(text)
        return engine.generateResponse(prompt).trim()
    }
}
