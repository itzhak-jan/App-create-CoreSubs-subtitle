cmake_minimum_required(VERSION 3.22.1)
project("coresubs_jni")

# ── Import the pre-compiled whisper.cpp shared library ───────────────────────
# Place libwhisper.so in android/app/src/main/jniLibs/arm64-v8a/
add_library(whisper SHARED IMPORTED)
set_target_properties(whisper PROPERTIES
    IMPORTED_LOCATION
    "${CMAKE_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libwhisper.so"
)

# ── Build our JNI bridge ──────────────────────────────────────────────────────
add_library(
    whisper_jni
    SHARED
    whisper_jni.cpp
)

# whisper.h lives next to whisper_jni.cpp
target_include_directories(whisper_jni PRIVATE ${CMAKE_SOURCE_DIR})

target_link_libraries(
    whisper_jni
    whisper
    android
    log
)

# ARM NEON optimisations for Tensor G4 (Cortex-X4 big cores)
target_compile_options(whisper_jni PRIVATE
    -O3
    -march=armv8.4-a+dotprod+fp16
    -ffast-math
)
