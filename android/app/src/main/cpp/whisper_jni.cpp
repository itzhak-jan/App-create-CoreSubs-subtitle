/**
 * whisper_jni.cpp — JNI wrapper for whisper.cpp
 *
 * Build: referenced from CMakeLists.txt, compiled into libwhisper_jni.so
 *
 * Dependency: whisper.cpp headers + libwhisper.so placed in
 *   android/app/src/main/jniLibs/arm64-v8a/libwhisper.so
 *   android/app/src/main/cpp/whisper.h
 *
 * whisper.cpp source: https://github.com/ggerganov/whisper.cpp
 * Use the quantized model: ggml-base.en-q5_1.bin (~57 MB) for best
 * speed/accuracy tradeoff on the Tensor G4 NPU.
 */

#include <jni.h>
#include <string>
#include <vector>
#include <android/log.h>
#include "whisper.h"

#define TAG "WhisperJNI"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  TAG, __VA_ARGS__)

static volatile bool g_abort = false;

// ─── nativeInit ──────────────────────────────────────────────────────────────

extern "C" JNIEXPORT jlong JNICALL
Java_com_coresubsapp_whisper_WhisperModule_nativeInit(
    JNIEnv *env, jobject /* this */,
    jstring modelPath, jint nThreads)
{
    const char *path = env->GetStringUTFChars(modelPath, nullptr);

    whisper_context_params cparams = whisper_context_default_params();
    // Route through GPU via Vulkan when available on Adreno
    cparams.use_gpu = true;

    whisper_context *ctx = whisper_init_from_file_with_params(path, cparams);
    env->ReleaseStringUTFChars(modelPath, path);

    if (!ctx) {
        LOGE("Failed to load whisper model");
        return 0L;
    }
    LOGI("Whisper model loaded. n_vocab=%d", whisper_n_vocab(ctx));
    return reinterpret_cast<jlong>(ctx);
}

// ─── nativeTranscribe ────────────────────────────────────────────────────────

extern "C" JNIEXPORT jstring JNICALL
Java_com_coresubsapp_whisper_WhisperModule_nativeTranscribe(
    JNIEnv *env, jobject /* this */,
    jlong ctxPtr, jstring wavPath)
{
    g_abort = false;
    auto *ctx = reinterpret_cast<whisper_context *>(ctxPtr);
    if (!ctx) return env->NewStringUTF("{\"language\":\"en\",\"segments\":[]}");

    const char *path = env->GetStringUTFChars(wavPath, nullptr);

    // Read 16 kHz mono PCM from WAV
    std::vector<float> pcm;
    {
        FILE *f = fopen(path, "rb");
        env->ReleaseStringUTFChars(wavPath, path);

        if (!f) {
            LOGE("Cannot open WAV: %s", path);
            return env->NewStringUTF("{\"language\":\"en\",\"segments\":[]}");
        }

        // Skip 44-byte WAV header
        fseek(f, 44, SEEK_SET);

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

    if (whisper_full(ctx, params, pcm.data(), (int)pcm.size()) != 0) {
        LOGE("whisper_full failed");
        return env->NewStringUTF("{\"language\":\"en\",\"segments\":[]}");
    }

    const int n_segments = whisper_full_n_segments(ctx);
    std::string json = "{\"language\":\"en\",\"segments\":[";

    for (int i = 0; i < n_segments; ++i) {
        if (g_abort) break;

        const int64_t t0  = whisper_full_get_segment_t0(ctx, i);
        const int64_t t1  = whisper_full_get_segment_t1(ctx, i);
        const char   *txt = whisper_full_get_segment_text(ctx, i);

        // Escape double-quotes inside text
        std::string text(txt);
        for (size_t p = text.find('"'); p != std::string::npos; p = text.find('"', p + 2))
            text.replace(p, 1, "\\\"");

        if (i > 0) json += ",";
        json += "{\"t0\":" + std::to_string(t0) +
                ",\"t1\":" + std::to_string(t1) +
                ",\"text\":\"" + text + "\"}";
    }
    json += "]}";

    return env->NewStringUTF(json.c_str());
}

// ─── nativeAbort ─────────────────────────────────────────────────────────────

extern "C" JNIEXPORT void JNICALL
Java_com_coresubsapp_whisper_WhisperModule_nativeAbort(
    JNIEnv * /*env*/, jobject /* this */, jlong /*ctxPtr*/)
{
    g_abort = true;
}

// ─── nativeFree ──────────────────────────────────────────────────────────────

extern "C" JNIEXPORT void JNICALL
Java_com_coresubsapp_whisper_WhisperModule_nativeFree(
    JNIEnv * /*env*/, jobject /* this */, jlong ctxPtr)
{
    auto *ctx = reinterpret_cast<whisper_context *>(ctxPtr);
    if (ctx) whisper_free(ctx);
}
