# React Native
-keep class com.facebook.react.** { *; }
-keep class com.facebook.hermes.** { *; }
-keep class com.facebook.jni.** { *; }

# Our native modules
-keep class com.coresubsapp.whisper.** { *; }
-keep class com.coresubsapp.translation.** { *; }
-keep class com.coresubsapp.processing.** { *; }
-keep class com.coresubsapp.media.** { *; }

# MediaPipe LLM Inference (TranslatorModule.kt) — uses JNI + protobuf/AutoValue
# generated code that R8 needs protected from stripping/renaming.
-keep class com.google.mediapipe.** { *; }

# AndroidX Media3 (AudioChunkExtractorModule.kt, SubtitleExportModule.kt)
-keep class androidx.media3.** { *; }

# R8 (full mode) traces every class referenced anywhere in mediapipe's own
# code, including optional feature paths this app never uses (multi-modal
# image input's com.google.mediapipe.framework.image.*, AutoValue/protobuf
# codegen's annotation-only classes) and compile-time-only annotation
# classes that were never meant to be on the runtime classpath. Both showed
# up as separate "Missing class" build failures in back-to-back CI runs —
# this is a known, ongoing issue with this exact library (see
# google-ai-edge/mediapipe#6110, #6138), not specific to this project;
# -dontwarn com.google.mediapipe.** is the community-standard workaround,
# broad enough to not need another CI round-trip for the next optional
# feature path R8 happens to trace into.
-dontwarn com.google.mediapipe.**
-dontwarn com.google.auto.value.**
-dontwarn com.google.protobuf.**

# Keep JNI-accessible class members
-keepclassmembers class * {
    native <methods>;
}
