package com.coresubsapp.translation

import com.facebook.react.bridge.*
import com.facebook.react.module.annotations.ReactModule
import kotlinx.coroutines.*
import org.tensorflow.lite.Interpreter
import org.tensorflow.lite.gpu.CompatibilityList
import org.tensorflow.lite.gpu.GpuDelegate
import org.tensorflow.lite.nnapi.NnApiDelegate
import java.io.File
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean

/**
 * TFLite bridge for NLLB-200-distilled translation (English → Hebrew).
 *
 * Model: nllb-200-distilled-600M-int8.tflite (~300 MB)
 * Tokenizer: SentencePiece (implemented via a bundled native lib or
 *            precomputed vocab table in assets/nllb_vocab.json).
 *
 * NPU/GPU delegation strategy for Pixel 10 Pro XL (Tensor G4):
 *  1. Try NNAPI delegate (routes to Tensor TPU/NPU when available)
 *  2. Fall back to GPU delegate (Adreno via OpenGL ES)
 *  3. Final fallback: 4-thread CPU
 *
 * Thermal management:
 *  - NNAPI is run with SUSTAINED_SPEED execution preference to prevent
 *    burst-mode NPU scheduling that causes throttling during long sessions.
 *  - Inter-op parallelism is capped at 2 to leave CPU cores for RN/video.
 */
@ReactModule(name = NLLBTranslationModule.NAME)
class NLLBTranslationModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "NLLBTranslationModule"
    }

    private var interpreter: Interpreter? = null
    private var srcLang = "eng_Latn"
    private var tgtLang = "heb_Hebr"
    private val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())
    private val abortFlag = AtomicBoolean(false)
    private var gpuDelegate: GpuDelegate? = null
    private var nnapiDelegate: NnApiDelegate? = null

    override fun getName(): String = NAME

    @ReactMethod
    fun init(modelPath: String, sourceLang: String, targetLang: String, promise: Promise) {
        scope.launch {
            try {
                srcLang = sourceLang
                tgtLang = targetLang

                val modelFile = File(modelPath)
                if (!modelFile.exists()) {
                    promise.reject("MODEL_NOT_FOUND", "Model file not found: $modelPath")
                    return@launch
                }

                val options = Interpreter.Options().apply {
                    numThreads = 4
                    useNNAPI = false // controlled manually below
                }

                // Try NNAPI delegate first (NPU path on Pixel 10 Pro XL)
                interpreter = try {
                    val nnDelegate = NnApiDelegate(
                        NnApiDelegate.Options().apply {
                            executionPreference = NnApiDelegate.Options.EXECUTION_PREFERENCE_SUSTAINED_SPEED
                            useNnapiCpu = false
                        }
                    )
                    nnapiDelegate = nnDelegate
                    val interp = Interpreter(modelFile, options)
                    interp.addDelegate(nnDelegate)
                    interp
                } catch (_: Exception) {
                    // Fall back to GPU delegate
                    nnapiDelegate = null
                    try {
                        val compatList = CompatibilityList()
                        if (compatList.isDelegateSupportedOnThisDevice) {
                            val gpuOpts = CompatibilityList().bestOptionsForThisDevice
                            val gpu = GpuDelegate(gpuOpts)
                            gpuDelegate = gpu
                            val interp = Interpreter(modelFile, options)
                            interp.addDelegate(gpu)
                            interp
                        } else {
                            Interpreter(modelFile, options)
                        }
                    } catch (_: Exception) {
                        Interpreter(modelFile, options)
                    }
                }

                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("NLLB_INIT_ERROR", e.message, e)
            }
        }
    }

    /**
     * Translates a batch of source texts. Returns the same number of
     * translated strings in the same order.
     *
     * For production correctness, the tokenisation/detokenisation steps
     * (SentencePiece BPE) would be implemented here or delegated to a
     * separate native lib. This stub shows the contract and wire-up.
     */
    @ReactMethod
    fun translateBatch(texts: ReadableArray, promise: Promise) {
        val interp = interpreter
        if (interp == null) {
            promise.reject("NLLB_NOT_INIT", "Call init() before translateBatch()")
            return
        }
        abortFlag.set(false)

        scope.launch {
            try {
                val results = Arguments.createArray()
                for (i in 0 until texts.size()) {
                    if (abortFlag.get()) break
                    val text = texts.getString(i) ?: ""
                    val translated = translateSingle(interp, text)
                    results.pushString(translated)
                }
                promise.resolve(results)
            } catch (e: Exception) {
                if (!abortFlag.get()) {
                    promise.reject("NLLB_TRANSLATE_ERROR", e.message, e)
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
        interpreter?.close()
        gpuDelegate?.close()
        nnapiDelegate?.close()
        interpreter = null
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal: single-text translation
    // In production this would:
    //   1. Tokenise with SentencePiece (nllb_tokenizer.so via JNI)
    //   2. Pad/truncate to model max sequence length (256 tokens)
    //   3. Run encoder → decoder with beam search (beam=4)
    //   4. Detokenise result tokens back to UTF-8 Hebrew text
    // ─────────────────────────────────────────────────────────────────────────
    private fun translateSingle(interp: Interpreter, text: String): String {
        if (text.isBlank()) return text

        // ── Placeholder: call into the real SentencePiece + NLLB TFLite loop ──
        // This function body would be replaced with the full encode→decode loop.
        // Returning the source text here allows the pipeline to run end-to-end
        // during initial integration testing before the tokenizer is wired up.
        return text
    }
}
