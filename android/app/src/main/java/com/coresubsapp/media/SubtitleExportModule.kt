package com.coresubsapp.media

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.RectF
import android.os.Handler
import android.os.Looper
import android.text.Layout
import android.text.StaticLayout
import android.text.TextDirectionHeuristics
import android.text.TextPaint
import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.effect.CanvasOverlay
import androidx.media3.effect.OverlayEffect
import androidx.media3.effect.TextureOverlay
import androidx.media3.transformer.Composition
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONArray

private data class ExportCue(val startSec: Double, val endSec: Double, val text: String)

/**
 * Burns Hebrew subtitles into the exported video using AndroidX Media3's
 * Transformer + a custom CanvasOverlay effect, instead of FFmpeg's
 * `subtitles` filter (libass + libfribidi). Replaces ExportService.ts's old
 * FFmpeg pipeline for the same reason as AudioChunkExtractorModule — the
 * ffmpeg-kit-react-native binaries this app used to depend on no longer
 * exist on any Maven repository.
 *
 * RTL rendering: Android's own text layout stack (StaticLayout, backed by
 * the platform's ICU/HarfBuzz) shapes Hebrew correctly on its own — this
 * explicitly sets TextDirectionHeuristics.RTL on the paragraph rather than
 * relying on autodetection, so no U+200F marker trick (needed for the old
 * SRT-file-based approach) is required here.
 *
 * UNVERIFIED — written against Media3 1.10.1's real API (checked against
 * androidx/media source on GitHub, not fabricated), but this session has
 * no Android SDK/device to run it. Needs a real device/emulator test pass,
 * in particular: (a) whether CanvasOverlay's per-frame bitmap starts
 * transparent or needs the explicit CLEAR this code does defensively,
 * (b) actual on-screen subtitle sizing/positioning across real aspect
 * ratios, (c) whether Transformer remuxes the original audio track
 * untouched (expected, since no audio effects/mimeType are requested) or
 * re-encodes it, (d) that getProgress() reports usefully during a real
 * export rather than sitting in PROGRESS_STATE_WAITING_FOR_AVAILABILITY.
 */
@ReactModule(name = SubtitleExportModule.NAME)
class SubtitleExportModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "SubtitleExportModule"
    }

    private var transformer: Transformer? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private val progressHolder = ProgressHolder()
    private var progressPoller: Runnable? = null

    override fun getName(): String = NAME

    /** cuesJson: a JSON array of {"startSec": number, "endSec": number, "text": string}. */
    @ReactMethod
    fun exportWithSubtitles(videoUri: String, cuesJson: String, outputPath: String, promise: Promise) {
        val cues = try {
            parseCues(cuesJson)
        } catch (e: Exception) {
            promise.reject("EXPORT_BAD_CUES", e.message, e)
            return
        }

        // Transformer must be built/started on a thread with a Looper — it posts
        // its own callbacks back to that same thread.
        mainHandler.post {
            try {
                val overlay = SubtitleCanvasOverlay(cues)
                val overlayEffect = OverlayEffect(listOf<TextureOverlay>(overlay))

                val editedMediaItem = EditedMediaItem.Builder(MediaItem.fromUri(videoUri))
                    .setEffects(Effects(emptyList(), listOf<Effect>(overlayEffect)))
                    .build()

                val listener = object : Transformer.Listener {
                    override fun onCompleted(composition: Composition, exportResult: ExportResult) {
                        stopProgressPolling()
                        transformer = null
                        promise.resolve(outputPath)
                    }

                    override fun onError(
                        composition: Composition,
                        exportResult: ExportResult,
                        exportException: ExportException,
                    ) {
                        stopProgressPolling()
                        transformer = null
                        promise.reject("EXPORT_ERROR", exportException.message, exportException)
                    }
                }

                val t = Transformer.Builder(reactApplicationContext)
                    .addListener(listener)
                    .build()
                transformer = t
                t.start(editedMediaItem, outputPath)
                startProgressPolling(t)
            } catch (e: Exception) {
                transformer = null
                promise.reject("EXPORT_ERROR", e.message, e)
            }
        }
    }

    @ReactMethod
    fun abort() {
        mainHandler.post {
            stopProgressPolling()
            transformer?.cancel()
            transformer = null
        }
    }

    private fun startProgressPolling(t: Transformer) {
        val poller = object : Runnable {
            override fun run() {
                if (transformer !== t) return // superseded/cancelled
                val state = t.getProgress(progressHolder)
                if (state == Transformer.PROGRESS_STATE_AVAILABLE) {
                    val params = Arguments.createMap()
                    params.putInt("progress", progressHolder.progress)
                    reactApplicationContext
                        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                        .emit("SubtitleExportProgress", params)
                }
                mainHandler.postDelayed(this, 500)
            }
        }
        progressPoller = poller
        mainHandler.postDelayed(poller, 500)
    }

    private fun stopProgressPolling() {
        progressPoller?.let { mainHandler.removeCallbacks(it) }
        progressPoller = null
    }

    private fun parseCues(json: String): List<ExportCue> {
        val arr = JSONArray(json)
        val list = ArrayList<ExportCue>(arr.length())
        for (i in 0 until arr.length()) {
            val obj = arr.getJSONObject(i)
            list.add(ExportCue(obj.getDouble("startSec"), obj.getDouble("endSec"), obj.getString("text")))
        }
        return list
    }
}

private class SubtitleCanvasOverlay(
    private val cues: List<ExportCue>,
) : CanvasOverlay(/* useInputFrameSize= */ true) {

    private val backgroundPaint = Paint().apply {
        color = Color.argb(160, 0, 0, 0)
    }

    override fun onDraw(canvas: Canvas, presentationTimeUs: Long) {
        // Defensive: don't assume the framework hands back an already-cleared
        // bitmap between frames — a stale previous subtitle bleeding through
        // would be a much worse bug than one redundant clear per frame.
        canvas.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR)

        val presentationSec = presentationTimeUs / 1_000_000.0
        val cue = cues.firstOrNull { presentationSec >= it.startSec && presentationSec < it.endSec }
            ?: return
        val text = cue.text.trim()
        if (text.isEmpty()) return

        val textPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            textSize = canvas.height * 0.045f
            setShadowLayer(canvas.height * 0.004f, 0f, 0f, Color.BLACK)
        }

        val maxWidth = (canvas.width * 0.86f).toInt().coerceAtLeast(1)
        val layout = StaticLayout.Builder
            .obtain(text, 0, text.length, textPaint, maxWidth)
            .setAlignment(Layout.Alignment.ALIGN_CENTER)
            .setTextDirection(TextDirectionHeuristics.RTL)
            .build()

        val x = (canvas.width - maxWidth) / 2f
        val y = canvas.height - layout.height - (canvas.height * 0.08f)
        val padding = canvas.height * 0.015f

        canvas.drawRoundRect(
            RectF(x - padding, y - padding, x + maxWidth + padding, y + layout.height + padding),
            padding,
            padding,
            backgroundPaint,
        )

        canvas.save()
        canvas.translate(x, y)
        layout.draw(canvas)
        canvas.restore()
    }
}
