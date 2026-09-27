cmake_minimum_required(VERSION 3.22.1)
project("coresubs_jni")

# ── whisper.cpp integration ───────────────────────────────────────────────────
#
# CI and production builds: whisper.cpp source is cloned to whisper_src/ by the
# GitHub Actions workflow (cached by tag). CMake compiles whisper + GGML as
# static libraries via add_subdirectory and links them into libwhisper_jni.so —
# a single self-contained shared library that ships in the APK.
#
# Local dev without the source clone falls back to a do-nothing stub so the
# project still builds. WhisperModule.kt returns empty results when ctxPtr == 0.
#
# To get full STT locally (without CI):
#   git clone --depth=1 --branch v1.7.4 \
#     https://github.com/ggerganov/whisper.cpp.git \
#     android/app/src/main/cpp/whisper_src

set(WHISPER_SRC_DIR "${CMAKE_SOURCE_DIR}/whisper_src")

if(EXISTS "${WHISPER_SRC_DIR}/CMakeLists.txt")
    message(STATUS "[CoreSubs] whisper.cpp source found — compiling from source")

    # Disable unnecessary whisper.cpp sub-targets to keep build fast.
    set(GGML_METAL        OFF CACHE BOOL "" FORCE)
    set(GGML_CUDA         OFF CACHE BOOL "" FORCE)
    set(GGML_OPENCL       OFF CACHE BOOL "" FORCE)
    set(WHISPER_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
    set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
    # Static libraries get linked into libwhisper_jni.so — no separate .so needed.
    set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)

    add_subdirectory(${WHISPER_SRC_DIR} whisper_build EXCLUDE_FROM_ALL)

    add_library(whisper_jni SHARED whisper_jni.cpp)

    target_compile_definitions(whisper_jni PRIVATE WHISPER_AVAILABLE=1)

    # whisper.cpp v1.6+ moved whisper.h to include/; older tags keep it at root.
    # List both so we resolve correctly regardless of exact tag layout.
    target_include_directories(whisper_jni PRIVATE
        "${WHISPER_SRC_DIR}/include"
        "${WHISPER_SRC_DIR}"
        "${WHISPER_SRC_DIR}/ggml/include"
    )

    target_link_libraries(whisper_jni whisper android log)

    # ARM NEON / FP16 / dotprod optimisations for Tensor G4 (Cortex-X4 cores)
    target_compile_options(whisper_jni PRIVATE
        -O3
        -march=armv8.4-a+dotprod+fp16
        -ffast-math
    )

else()
    message(STATUS "[CoreSubs] whisper_src not found — building stub (local dev)")

    add_library(whisper_jni SHARED whisper_jni.cpp)
    # No WHISPER_AVAILABLE — stub path compiled; ctxPtr == 0 at runtime
    target_link_libraries(whisper_jni android log)
endif()
