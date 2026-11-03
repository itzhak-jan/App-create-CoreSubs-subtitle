package com.coresubsapp.translation

import com.facebook.react.bridge.*
import com.facebook.react.module.annotations.ReactModule
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.common.model.DownloadConditions
import com.google.mlkit.nl.translate.TranslateLanguage
import com.google.mlkit.nl.translate.Translation
import com.google.mlkit.nl.translate.Translator
import com.google.mlkit.nl.translate.TranslatorOptions
import kotlinx.coroutines.*
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * React Native bridge to Google ML Kit on-device translation — the default
 * translation engine.
 *
 * Why: it's a dedicated neural MT model (not a general LLM), so a subtitle
 * line translates in milliseconds on the CPU instead of seconds on the GPU,
 * and each language pack is ~30 MB instead of a 500 MB+ LLM bundle. Packs
 * are downloaded once by ML Kit (needs network the first time a language
 * pair is used) and then work fully offline.
 *
 * Consistency of names/fixed phrases is handled in TypeScript
 * (TranslationService.ts) by swapping glossary terms for placeholders before
 * translation and restoring the locked rendering afterwards — this module
 * just translates strings.
 */
@ReactModule(name = MlKitTranslatorModule.NAME)
class MlKitTranslatorModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "MlKitTranslator"
        private const val DOWNLOAD_TIMEOUT_MIN = 10L
        private const val TRANSLATE_TIMEOUT_SEC = 20L
    }

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val translators = HashMap<String, Translator>()
    private val ready = HashSet<String>()
    private val abortFlag = AtomicBoolean(false)

    override fun getName(): String = NAME

    private fun key(src: String, tgt: String) = "$src>$tgt"

    @Synchronized
    private fun translatorFor(src: String, tgt: String): Translator? {
        val k = key(src, tgt)
        translators[k]?.let { return it }
        val s = TranslateLanguage.fromLanguageTag(src) ?: return null
        val t = TranslateLanguage.fromLanguageTag(tgt) ?: return null
        val options = TranslatorOptions.Builder()
            .setSourceLanguage(s)
            .setTargetLanguage(t)
            .build()
        val translator = Translation.getClient(options)
        translators[k] = translator
        return translator
    }

    /** Blocking: downloads the language pack for src→tgt if needed. */
    private fun ensureReady(src: String, tgt: String): Translator {
        val translator = translatorFor(src, tgt)
            ?: throw IllegalArgumentException("Unsupported language pair $src → $tgt")
        val k = key(src, tgt)
        if (!ready.contains(k)) {
            Tasks.await(
                translator.downloadModelIfNeeded(DownloadConditions.Builder().build()),
                DOWNLOAD_TIMEOUT_MIN, TimeUnit.MINUTES,
            )
            synchronized(this) { ready.add(k) }
        }
        return translator
    }

    @ReactMethod
    fun isSupported(lang: String, promise: Promise) {
        promise.resolve(TranslateLanguage.fromLanguageTag(lang) != null)
    }

    /** Pre-downloads the language pack so the first chunk isn't delayed. */
    @ReactMethod
    fun prepare(src: String, tgt: String, promise: Promise) {
        scope.launch {
            try {
                if (src != tgt) ensureReady(src, tgt)
                promise.resolve(true)
            } catch (e: Exception) {
                promise.reject("MLKIT_PREPARE_ERROR", e.message, e)
            }
        }
    }

    /** Translates each string; returns results in the same order. */
    @ReactMethod
    fun translateBatch(texts: ReadableArray, src: String, tgt: String, promise: Promise) {
        abortFlag.set(false)
        scope.launch {
            try {
                val out = Arguments.createArray()
                if (src == tgt) {
                    for (i in 0 until texts.size()) out.pushString(texts.getString(i) ?: "")
                    promise.resolve(out)
                    return@launch
                }
                val translator = ensureReady(src, tgt)
                for (i in 0 until texts.size()) {
                    if (abortFlag.get()) break
                    val text = texts.getString(i) ?: ""
                    out.pushString(
                        if (text.isBlank()) ""
                        else Tasks.await(
                            translator.translate(text),
                            TRANSLATE_TIMEOUT_SEC, TimeUnit.SECONDS,
                        ),
                    )
                }
                promise.resolve(out)
            } catch (e: Exception) {
                if (abortFlag.get()) {
                    promise.resolve(Arguments.createArray())
                } else {
                    promise.reject("MLKIT_TRANSLATE_ERROR", e.message, e)
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
        synchronized(this) {
            translators.values.forEach { it.close() }
            translators.clear()
            ready.clear()
        }
    }
}
