/**
 * whisper_jni.cpp — JNI bridge for whisper.cpp
 *
 * Compiled in two modes controlled by CMakeLists.txt:
 *
 *   WHISPER_AVAILABLE=1  (production)
 *     Requires libwhisper.so + whisper.h in the expected locations.
 *     Provides real STT via the whisper_full() C API.
 *
 *   (undefined)          (CI / stub)
 *     Provides do-nothing stubs that satisfy the JNI symbol contract.
 *     WhisperModule.kt returns empty transcription when ctxPtr == 0.
 *
 * See CMakeLists.txt for how to build whisper.cpp for arm64-v8a.
 */

#include <jni.h>
#include <android/log.h>

#define TAG "WhisperJNI"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  TAG, __VA_ARGS__)

// ═════════════════════════════════════════════════════════════════════════════
// PRODUCTION BUILD — full whisper.cpp integration
// ═════════════════════════════════════════════════════════════════════════════
#ifdef WHISPER_AVAILABLE

#include <string>
#include <vector>
#include "whisper.h"

static volatile bool g_abort = false;

extern "C" JNIEXPORT jlong JNICALL
Java_com_coresubsapp_whisper_WhisperModule_nativeInit(
    JNIEnv *env, jobject /* this */,
    jstring modelPath, jint /* nThreads */)
{
    const char *path = env->GetStringUTFChars(modelPath, nullptr);

    whisper_context_params cparams = whisper_context_default_params();
    cparams.use_gpu = true; // Vulkan compute on Adreno GPU

    whisper_context *ctx = whisper_init_from_file_with_params(path, cparams);
    env->ReleaseStringUTFChars(modelPath, path);

    if (!ctx) {
        LOGE("Failed to load whisper model");
        return 0L;
    }
    LOGI("Whisper model loaded. n_vocab=%d", whisper_n_vocab(ctx));
    return reinterpret_cast<jlong>(ctx);
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_coresubsapp_whisper_WhisperModule_nativeTranscribe(
    JNIEnv *env, jobject /* this */,
    jlong ctxPtr, jstring wavPath)
{
    g_abort = false;
    auto *ctx = reinterpret_cast<whisper_context *>(ctxPtr);
    if (!ctx) return env->NewStringUTF("{\"language\":\"en\",\"segments\":[]}");

    const char *path = env->GetStringUTFChars(wavPath, nullptr);

    std::vector<float> pcm;
    {
        FILE *f = fopen(path, "rb");
        env->ReleaseStringUTFChars(wavPath, path);
        if (!f) {
            LOGE("Cannot open WAV");
            return env->NewStringUTF("{\"language\":\"en\",\"segments\":[]}");
        }
        fseek(f, 44, SEEK_SET); // skip 44-byte WAV header
        int16_t sample;
        while (fread(&sample, sizeof(int16_t), 1, f) == 1) {
            pcm.push_back(static_cast<float>(sample) / 32768.0f);
        }
        fclose(f);
    }

    whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    params.n_threads        = 4;
    params.translate        = false;
    params.language         = "en";
    params.no_context       = true;
    params.single_segment   = false;
    params.print_realtime   = false;
    params.print_progress   = false;
    params.print_timestamps = true;

    if (whisper_full(ctx, params, pcm.data(), static_cast<int>(pcm.size())) != 0) {
        LOGE("whisper_full() failed");
        return env->NewStringUTF("{\"language\":\"en\",\"segments\":[]}");
    }

    const int n = whisper_full_n_segments(ctx);
    std::string json = "{\"language\":\"en\",\"segments\":[";
    for (int i = 0; i < n; ++i) {
        if (g_abort) break;
        const int64_t t0  = whisper_full_get_segment_t0(ctx, i);
        const int64_t t1  = whisper_full_get_segment_t1(ctx, i);
        std::string   txt = whisper_full_get_segment_text(ctx, i);

        // Escape embedded double-quotes
        for (size_t p = txt.find('"'); p != std::string::npos; p = txt.find('"', p + 2))
            txt.replace(p, 1, "\\\"");

        if (i > 0) json += ',';
        json += "{\"t0\":" + std::to_string(t0) +
                ",\"t1\":" + std::to_string(t1) +
                ",\"text\":\"" + txt + "\"}";
    }
    json += "]}";
    return env->NewStringUTF(json.c_str());
}

extern "C" JNIEXPORT void JNICALL
Java_com_coresubsapp_whisper_WhisperModule_nativeAbort(
    JNIEnv * /*env*/, jobject /* this */, jlong /*ctxPtr*/)
{
    g_abort = true;
}

extern "C" JNIEXPORT void JNICALL
Java_com_coresubsapp_whisper_WhisperModule_nativeFree(
    JNIEnv * /*env*/, jobject /* this */, jlong ctxPtr)
{
    auto *ctx = reinterpret_cast<whisper_context *>(ctxPtr);
    if (ctx) whisper_free(ctx);
}

// ═════════════════════════════════════════════════════════════════════════════
// STUB BUILD — CI / environments without libwhisper.so
// ═════════════════════════════════════════════════════════════════════════════
#else

extern "C" JNIEXPORT jlong JNICALL
Java_com_coresubsapp_whisper_WhisperModule_nativeInit(
    JNIEnv * /*env*/, jobject /* this */,
    jstring /*modelPath*/, jint /*nThreads*/)
{
    LOGI("WhisperJNI stub: nativeInit — libwhisper.so not linked");
    return 0L; // WhisperModule.kt returns empty results when ctxPtr == 0
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_coresubsapp_whisper_WhisperModule_nativeTranscribe(
    JNIEnv *env, jobject /* this */,
    jlong /*ctxPtr*/, jstring /*wavPath*/)
{
    return env->NewStringUTF("{\"language\":\"en\",\"segments\":[]}");
}

extern "C" JNIEXPORT void JNICALL
Java_com_coresubsapp_whisper_WhisperModule_nativeAbort(
    JNIEnv * /*env*/, jobject /* this */, jlong /*ctxPtr*/) {}

extern "C" JNIEXPORT void JNICALL
Java_com_coresubsapp_whisper_WhisperModule_nativeFree(
    JNIEnv * /*env*/, jobject /* this */, jlong /*ctxPtr*/) {}

#endif // WHISPER_AVAILABLE
