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

# R8 (full mode) traces referenced classes even when they're annotation-only
# and never needed at runtime. AutoValue and protobuf's nullability/proto
# annotation classes fall in that category — compile-time-only dependencies
# of com.google.mediapipe.tasks.genai's generated code that aren't actually
# on the runtime classpath. This is the standard, documented fix for this
# exact "Missing class com.google.auto.value.AutoValue$Builder" /
# "Missing class com.google.protobuf.Internal$ProtoNonnullApi" class of R8
# error, not specific to this project.
-dontwarn com.google.auto.value.**
-dontwarn com.google.protobuf.**

# Keep JNI-accessible class members
-keepclassmembers class * {
    native <methods>;
}
