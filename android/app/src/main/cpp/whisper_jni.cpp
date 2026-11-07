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
#include <atomic>
#include <cstdio>
#include "whisper.h"

// Checked by whisper.cpp between decoder steps (abort_callback), so a seek
// actually stops an in-flight transcription instead of waiting for it.
static std::atomic<bool> g_abort{false};

static bool abort_cb(void * /*user_data*/) {
    return g_abort.load();
}

static std::string json_escape(const std::string &in) {
    std::string out;
    out.reserve(in.size() + 8);
    for (unsigned char c : in) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out += static_cast<char>(c);
                }
        }
    }
    return out;
}

static std::string empty_json(const std::string &lang) {
    return "{\"language\":\"" + lang + "\",\"segments\":[]}";
}

extern "C" JNIEXPORT jlong JNICALL
Java_com_coresubsapp_whisper_WhisperModule_nativeInit(
    JNIEnv *env, jobject /* this */,
    jstring modelPath, jint /* nThreads */)
{
    const char *path = env->GetStringUTFChars(modelPath, nullptr);

    whisper_context_params cparams = whisper_context_default_params();
    // No GPU backend is compiled in (GGML_VULKAN is off in CMakeLists.txt),
    // so this runs on the CPU (NEON). Say so explicitly rather than asking
    // for a GPU that isn't there. base/small models are fast enough on the
    // Tensor G5 big cores for a pipeline that keeps STT running ahead.
    cparams.use_gpu = false;

    whisper_context *ctx = whisper_init_from_file_with_params(path, cparams);
    env->ReleaseStringUTFChars(modelPath, path);

    if (!ctx) {
        LOGE("Failed to load whisper model");
        return 0L;
    }
    LOGI("Whisper model loaded. multilingual=%d", whisper_is_multilingual(ctx));
    return reinterpret_cast<jlong>(ctx);
}

/**
 * language: ISO 639-1 code, or "auto" to detect. English-only (.en) models
 * are always run as "en".
 * Returns {"language":"<used or detected>","segments":[{t0,t1,text}...]}
 * with t0/t1 in centiseconds, relative to the start of the WAV.
 */
extern "C" JNIEXPORT jstring JNICALL
Java_com_coresubsapp_whisper_WhisperModule_nativeTranscribe(
    JNIEnv *env, jobject /* this */,
    jlong ctxPtr, jstring wavPath, jstring language)
{
    g_abort.store(false);
    auto *ctx = reinterpret_cast<whisper_context *>(ctxPtr);

    std::string lang = "en";
    if (language) {
        const char *l = env->GetStringUTFChars(language, nullptr);
        lang = l;
        env->ReleaseStringUTFChars(language, l);
    }
    if (!ctx) return env->NewStringUTF(empty_json(lang).c_str());
    if (!whisper_is_multilingual(ctx)) lang = "en";

    std::vector<float> pcm;
    {
        const char *path = env->GetStringUTFChars(wavPath, nullptr);
        FILE *f = fopen(path, "rb");
        env->ReleaseStringUTFChars(wavPath, path);
        if (!f) {
            LOGE("Cannot open WAV");
            return env->NewStringUTF(empty_json(lang).c_str());
        }
        fseek(f, 0, SEEK_END);
        long bytes = ftell(f);
        fseek(f, 44, SEEK_SET); // skip 44-byte WAV header (ffmpeg pcm_s16le)
        std::vector<int16_t> raw(bytes > 44 ? (bytes - 44) / 2 : 0);
        size_t n = raw.empty() ? 0 : fread(raw.data(), sizeof(int16_t), raw.size(), f);
        fclose(f);
        pcm.resize(n);
        for (size_t i = 0; i < n; ++i) pcm[i] = static_cast<float>(raw[i]) / 32768.0f;
    }

    whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    params.n_threads        = 4;
    params.translate        = false;
    params.language         = lang.c_str(); // "auto" → whisper detects
    params.no_context       = true;
    params.single_segment   = false;
    params.print_realtime   = false;
    params.print_progress   = false;
    params.print_timestamps = false;
    params.abort_callback           = abort_cb;
    params.abort_callback_user_data = nullptr;

    if (whisper_full(ctx, params, pcm.data(), static_cast<int>(pcm.size())) != 0) {
        if (!g_abort.load()) LOGE("whisper_full() failed");
        return env->NewStringUTF(empty_json(lang).c_str());
    }

    std::string detected = lang;
    if (lang == "auto") {
        const char *s = whisper_lang_str(whisper_full_lang_id(ctx));
        detected = s ? s : "en";
    }

    const int n = whisper_full_n_segments(ctx);
    std::string json = "{\"language\":\"" + json_escape(detected) + "\",\"segments\":[";
    for (int i = 0; i < n; ++i) {
        if (g_abort.load()) break;
        const int64_t t0 = whisper_full_get_segment_t0(ctx, i);
        const int64_t t1 = whisper_full_get_segment_t1(ctx, i);
        const char *txt  = whisper_full_get_segment_text(ctx, i);

        if (i > 0) json += ',';
        json += "{\"t0\":" + std::to_string(t0) +
                ",\"t1\":" + std::to_string(t1) +
                ",\"text\":\"" + json_escape(txt ? txt : "") + "\"}";
    }
    json += "]}";
    return env->NewStringUTF(json.c_str());
}

extern "C" JNIEXPORT void JNICALL
Java_com_coresubsapp_whisper_WhisperModule_nativeAbort(
    JNIEnv * /*env*/, jobject /* this */, jlong /*ctxPtr*/)
{
    g_abort.store(true);
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
    jlong /*ctxPtr*/, jstring /*wavPath*/, jstring /*language*/)
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
