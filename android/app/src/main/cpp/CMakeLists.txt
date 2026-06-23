cmake_minimum_required(VERSION 3.22.1)
project("coresubs_jni")

# ── Conditional whisper.cpp integration ──────────────────────────────────────
#
# A full device build requires two files that are NOT committed to the repo
# (too large for git / platform-specific binaries):
#   android/app/src/main/jniLibs/arm64-v8a/libwhisper.so
#   android/app/src/main/cpp/whisper.h
#
# When these are absent (CI, fresh clone), the build falls back to a stub that
# satisfies the JNI contract and links cleanly. WhisperModule.kt already handles
# ctxPtr == 0 by returning empty transcription results, so the app remains
# fully functional in that mode (subtitles simply stay empty).
#
# To produce a production build with real STT:
#   1. Build whisper.cpp for arm64-v8a:
#        git clone https://github.com/ggerganov/whisper.cpp
#        cd whisper.cpp && cmake -B build/android -DCMAKE_TOOLCHAIN_FILE=$NDK/build/cmake/android.toolchain.cmake \
#          -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-26 -DWHISPER_BUILD_TESTS=OFF
#        cmake --build build/android --target whisper -j4
#   2. Copy outputs:
#        build/android/src/libwhisper.so  → android/app/src/main/jniLibs/arm64-v8a/
#        whisper.h                        → android/app/src/main/cpp/

set(WHISPER_SO   "${CMAKE_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libwhisper.so")
set(WHISPER_H    "${CMAKE_SOURCE_DIR}/whisper.h")

if(EXISTS "${WHISPER_SO}" AND EXISTS "${WHISPER_H}")
    message(STATUS "[CoreSubs] whisper.cpp found — building full JNI bridge")

    add_library(whisper SHARED IMPORTED)
    set_target_properties(whisper PROPERTIES IMPORTED_LOCATION "${WHISPER_SO}")

    add_library(whisper_jni SHARED whisper_jni.cpp)

    target_compile_definitions(whisper_jni PRIVATE WHISPER_AVAILABLE=1)
    target_include_directories(whisper_jni PRIVATE ${CMAKE_SOURCE_DIR})

    target_link_libraries(whisper_jni whisper android log)

    # ARM NEON / FP16 / dotprod optimisations for Tensor G4 (Cortex-X4 cores)
    target_compile_options(whisper_jni PRIVATE
        -O3
        -march=armv8.4-a+dotprod+fp16
        -ffast-math
    )
else()
    message(STATUS "[CoreSubs] whisper.so not found — building stub (CI mode)")

    add_library(whisper_jni SHARED whisper_jni.cpp)
    # No WHISPER_AVAILABLE — stub path compiled
    target_link_libraries(whisper_jni android log)
endif()
