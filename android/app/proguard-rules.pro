# React Native
-keep class com.facebook.react.** { *; }
-keep class com.facebook.hermes.** { *; }
-keep class com.facebook.jni.** { *; }

# Our native modules
-keep class com.coresubsapp.whisper.** { *; }
-keep class com.coresubsapp.translation.** { *; }
-keep class com.coresubsapp.processing.** { *; }

# TFLite
-keep class org.tensorflow.lite.** { *; }
-keep class org.tensorflow.lite.gpu.** { *; }
-keep class org.tensorflow.lite.nnapi.** { *; }

# ffmpeg-kit
-keep class com.arthenica.ffmpegkit.** { *; }

# Keep JNI-accessible class members
-keepclassmembers class * {
    native <methods>;
}
