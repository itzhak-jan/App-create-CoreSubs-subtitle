package com.coresubsapp.whisper

import com.facebook.react.bridge.*
import com.facebook.react.module.annotations.ReactModule
import kotlinx.coroutines.*
import java.util.concurrent.atomic.AtomicBoolean

/**
 * React Native bridge to whisper.cpp via JNI.
 *
 * The native library (libwhisper.so) is compiled separately and placed in
 * android/app/src/main/jniLibs/arm64-v8a/. The JNI declarations below
 * mirror the C-language wrapper in whisper_jni.cpp.
 *
 * Hardware notes for Pixel 10 Pro XL:
 *  - whisper.cpp uses GGML which can dispatch to the Adreno GPU via
 *    Vulkan compute. Set WHISPER_USE_VULKAN=1 in whisper_jni.cpp params.
 *  - Keep threads <= 4 to leave headroom for the MediaCodec decoder thread
 *    and reduce thermal pressure.
 */
@ReactModule(name = WhisperModule.NAME)
class WhisperModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "WhisperModule"

        init {
            System.loadLibrary("whisper")
            System.loadLibrary("whisper_jni")
        }
    }

    // JNI declarations — implemented in whisper_jni.cpp
    private external fun nativeInit(modelPath: String, nThreads: Int): Long
    private external fun nativeTranscribe(ctxPtr: Long, wavPath: String): String
    private external fun nativeAbort(ctxPtr: Long)
    private external fun nativeFree(ctxPtr: Long)

    private var ctxPtr: Long = 0L
    private val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())
    private val abortFlag = AtomicBoolean(false)

    override fun getName(): String = NAME

    // Keep JNI-heavy calls off the main thread; React Native will
    // schedule on the NativeModules thread automatically via Promises.
    override fun canOverrideExistingModule(): Boolean = false

    @ReactMethod
    fun init(modelPath: String, promise: Promise) {
        scope.launch {
            try {
                if (ctxPtr != 0L) nativeFree(ctxPtr)
                // 4 threads: conservative for sustained workloads on Tensor G4
                ctxPtr = nativeInit(modelPath, 4)
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("WHISPER_INIT_ERROR", e.message, e)
            }
        }
    }

    @ReactMethod
    fun transcribe(wavPath: String, promise: Promise) {
        if (ctxPtr == 0L) {
            promise.reject("WHISPER_NOT_INIT", "Call init() before transcribe()")
            return
        }
        abortFlag.set(false)

        scope.launch {
            try {
                // nativeTranscribe returns a JSON string:
                // {"language":"en","segments":[{"t0":0,"t1":300,"text":"Hello"}]}
                val json = nativeTranscribe(ctxPtr, wavPath)
                val result = parseWhisperJson(json)
                promise.resolve(result)
            } catch (e: Exception) {
                if (!abortFlag.get()) {
                    promise.reject("WHISPER_TRANSCRIBE_ERROR", e.message, e)
                } else {
                    promise.resolve(emptyResult())
                }
            }
        }
    }

    @ReactMethod
    fun abort() {
        abortFlag.set(true)
        if (ctxPtr != 0L) nativeAbort(ctxPtr)
    }

    override fun onCatalystInstanceDestroy() {
        scope.cancel()
        if (ctxPtr != 0L) {
            nativeFree(ctxPtr)
            ctxPtr = 0L
        }
    }

    // ── JSON parsing helpers ──────────────────────────────────────────────────

    private fun parseWhisperJson(json: String): WritableMap {
        val result = Arguments.createMap()
        val org = org.json.JSONObject(json)

        result.putString("language", org.optString("language", "en"))

        val segmentsArray = Arguments.createArray()
        val segs = org.optJSONArray("segments") ?: return emptyResult()

        for (i in 0 until segs.length()) {
            val seg = segs.getJSONObject(i)
            val map = Arguments.createMap()
            // whisper.cpp reports time in centiseconds
            map.putInt("t0", seg.getInt("t0"))
            map.putInt("t1", seg.getInt("t1"))
            map.putString("text", seg.getString("text"))
            segmentsArray.pushMap(map)
        }
        result.putArray("segments", segmentsArray)
        return result
    }

    private fun emptyResult(): WritableMap {
        val result = Arguments.createMap()
        result.putString("language", "en")
        result.putArray("segments", Arguments.createArray())
        return result
    }
}
