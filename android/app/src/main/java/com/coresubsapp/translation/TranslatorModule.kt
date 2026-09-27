package com.coresubsapp.translation

import com.facebook.react.bridge.*
import com.facebook.react.module.annotations.ReactModule
import com.google.mediapipe.tasks.genai.llminference.LlmInference
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/**
 * React Native bridge to Google's TranslateGemma-4B, run through the
 * MediaPipe LLM Inference ("Task Genai") API. Deliberately thin: prompt
 * construction (translation prompts with glossary hints, glossary
 * extraction prompts) lives in TypeScript (TranslationService.ts,
 * GlossaryExtractor.ts) so those can be iterated on without a native
 * rebuild. This module only knows how to run a batch of already-built
 * prompts through the model.
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
 *     prompts built in TranslationService.ts are a reasonable
 *     instruction-style guess, not copied from that file. Mismatched
 *     formatting will still produce output, just with lower quality than
 *     the model is capable of.
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

        private const val MAX_TOKENS = 512 // headroom for glossary-extraction JSON, not just short subtitle lines
        private const val TOP_K = 40
        private const val TEMPERATURE = 0.3f // low — translation/extraction want fidelity, not creativity
    }

    private var llmInference: LlmInference? = null
    private val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())
    private val abortFlag = AtomicBoolean(false)

    // TranslationService (per-segment translation) and GlossaryExtractor
    // (fire-and-forget, after each chunk) can both call generateBatch()
    // around the same time. The LLM Inference engine isn't documented as
    // safe for concurrent generateResponse() calls on one instance, so
    // serialize all of them through this mutex rather than assume it is.
    private val inferenceMutex = Mutex()

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
     * Runs a batch of already-built prompts through the model, returning one
     * response string per prompt in the same order. The LLM Inference API
     * generates one response per prompt (no native tensor-batching), so this
     * loops sequentially — acceptable given the on-device thermal budget
     * this project already designs around (one AI task in flight at a time).
     *
     * Callers: TranslationService (per-chunk segment translation) and
     * GlossaryExtractor (fire-and-forget, after each chunk) can both invoke
     * this around the same time — inferenceMutex serializes them so two
     * calls never run generateResponse() concurrently on the same engine.
     */
    @ReactMethod
    fun generateBatch(prompts: ReadableArray, promise: Promise) {
        val engine = llmInference
        if (engine == null) {
            promise.reject("TRANSLATOR_NOT_INIT", "Call init() before generateBatch()")
            return
        }

        scope.launch {
            try {
                val results = inferenceMutex.withLock {
                    // Reset inside the lock: if a call is queued behind
                    // another, its "no one has asked to abort yet" state
                    // should start fresh once it actually begins running.
                    abortFlag.set(false)
                    val batch = Arguments.createArray()
                    for (i in 0 until prompts.size()) {
                        if (abortFlag.get()) break
                        val prompt = prompts.getString(i) ?: ""
                        batch.pushString(
                            if (prompt.isBlank()) "" else engine.generateResponse(prompt).trim(),
                        )
                    }
                    batch
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
}
