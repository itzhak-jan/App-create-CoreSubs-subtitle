package com.coresubsapp.media

import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicBoolean

private const val TARGET_SAMPLE_RATE = 16000
private const val TIMEOUT_US = 10_000L

private fun MediaFormat.safeInt(key: String, fallback: Int): Int =
    if (containsKey(key)) getInteger(key) else fallback

/**
 * Extracts a mono 16 kHz 16-bit PCM WAV segment from a video's audio track —
 * the same contract whisper.cpp already expects (see ChunkExtractor.ts /
 * whisper_jni.cpp, which read a plain 44-byte-header WAV file and never
 * changed).
 *
 * Replaces an FFmpeg CLI invocation. ffmpeg-kit-react-native's native
 * binaries (com.arthenica:ffmpeg-kit-*) were pulled from Maven Central,
 * CocoaPods and npm on 2026-04-01 when the project retired — there is no
 * version of that dependency CI can resolve any more. This uses Android's
 * own MediaExtractor/MediaCodec to decode; downmix to mono and resampling
 * to 16 kHz are done here in plain Kotlin.
 *
 * (An earlier version used Media3's ChannelMixingAudioProcessor +
 * SonicAudioProcessor for those two steps. On-device it failed every chunk
 * with "Unhandled input format: AudioFormat[sampleRate=-1, ...]" — the
 * processors' configure/flush lifecycle didn't match what the code
 * assumed. The plain implementation has no such lifecycle, and it also
 * reads the decoder's real output format instead of the container's.)
 *
 * UNVERIFIED: written against Media3 1.10.1's real API (checked against
 * the androidx/media source on GitHub — no fabricated signatures), but
 * this session has no Android SDK/device to actually run it. Needs a real
 * device/emulator test pass before relying on it in production.
 */
@ReactModule(name = AudioChunkExtractorModule.NAME)
class AudioChunkExtractorModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "AudioChunkExtractorModule"
    }

    private val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())
    private val abortFlag = AtomicBoolean(false)

    override fun getName(): String = NAME

    @ReactMethod
    fun extractChunk(
        videoUri: String,
        startSec: Double,
        durationSec: Double,
        outputPath: String,
        promise: Promise,
    ) {
        abortFlag.set(false)
        scope.launch {
            try {
                extractChunkInternal(videoUri, startSec, durationSec, outputPath)
                if (abortFlag.get()) {
                    promise.reject("EXTRACT_ABORTED", "Extraction aborted")
                } else {
                    promise.resolve(outputPath)
                }
            } catch (e: Exception) {
                promise.reject("EXTRACT_ERROR", e.message, e)
            }
        }
    }

    @ReactMethod
    fun abort() {
        abortFlag.set(true)
    }

    private fun extractChunkInternal(
        videoUri: String,
        startSec: Double,
        durationSec: Double,
        outputPath: String,
    ) {
        val extractor = MediaExtractor()
        var codec: MediaCodec? = null
        try {
            extractor.setDataSource(reactApplicationContext, Uri.parse(videoUri), null)

            var audioTrackIndex = -1
            var format: MediaFormat? = null
            for (i in 0 until extractor.trackCount) {
                val candidate = extractor.getTrackFormat(i)
                val mime = candidate.getString(MediaFormat.KEY_MIME) ?: continue
                if (mime.startsWith("audio/")) {
                    audioTrackIndex = i
                    format = candidate
                    break
                }
            }
            val trackFormat = format ?: throw IllegalStateException("No audio track found in $videoUri")
            extractor.selectTrack(audioTrackIndex)

            val startUs = (startSec * 1_000_000).toLong()
            val endUs = ((startSec + durationSec) * 1_000_000).toLong()
            extractor.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)

            val mime = trackFormat.getString(MediaFormat.KEY_MIME)!!
            codec = MediaCodec.createDecoderByType(mime)
            codec.configure(trackFormat, null, null, 0)
            codec.start()

            // The DECODER's output format is the truth — it can differ from
            // the container's track format (e.g. HE-AAC reports half the real
            // sample rate; some decoders upmix/downmix). Start from the track
            // values and update on INFO_OUTPUT_FORMAT_CHANGED.
            var sampleRate = trackFormat.safeInt(MediaFormat.KEY_SAMPLE_RATE, 44100)
            var channels = trackFormat.safeInt(MediaFormat.KEY_CHANNEL_COUNT, 2)
            var pcmFloat = false

            val mono = MonoSamples()
            val bufferInfo = MediaCodec.BufferInfo()
            var sawInputEOS = false
            var sawOutputEOS = false

            while (!sawOutputEOS && !abortFlag.get()) {
                if (!sawInputEOS) {
                    val inIndex = codec.dequeueInputBuffer(TIMEOUT_US)
                    if (inIndex >= 0) {
                        val inputBuffer = codec.getInputBuffer(inIndex)!!
                        inputBuffer.clear()
                        val sampleSize = extractor.readSampleData(inputBuffer, 0)
                        val sampleTimeUs = extractor.sampleTime
                        if (sampleSize < 0 || sampleTimeUs > endUs) {
                            codec.queueInputBuffer(inIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            sawInputEOS = true
                        } else {
                            codec.queueInputBuffer(inIndex, 0, sampleSize, sampleTimeUs, 0)
                            extractor.advance()
                        }
                    }
                }

                val outIndex = codec.dequeueOutputBuffer(bufferInfo, TIMEOUT_US)
                if (outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    val f = codec.outputFormat
                    sampleRate = f.safeInt(MediaFormat.KEY_SAMPLE_RATE, sampleRate)
                    channels = f.safeInt(MediaFormat.KEY_CHANNEL_COUNT, channels)
                    pcmFloat = f.safeInt(MediaFormat.KEY_PCM_ENCODING, AudioFormat.ENCODING_PCM_16BIT) ==
                        AudioFormat.ENCODING_PCM_FLOAT
                } else if (outIndex >= 0) {
                    if (bufferInfo.size > 0 && bufferInfo.presentationTimeUs >= startUs) {
                        val out = codec.getOutputBuffer(outIndex)!!
                        out.position(bufferInfo.offset)
                        out.limit(bufferInfo.offset + bufferInfo.size)
                        appendMono(out.slice().order(ByteOrder.nativeOrder()), channels, pcmFloat, mono)
                    }
                    codec.releaseOutputBuffer(outIndex, false)
                    if (bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
                        sawOutputEOS = true
                    }
                }
            }

            if (!abortFlag.get()) {
                val maxOut = (durationSec * TARGET_SAMPLE_RATE).toInt()
                val pcm = resampleTo16k(mono, sampleRate, maxOut)
                writeWav(outputPath, pcm, TARGET_SAMPLE_RATE)
            }
        } finally {
            try { codec?.stop() } catch (_: Exception) {}
            codec?.release()
            extractor.release()
        }
    }

    /** Growable float array (avoids boxing in a MutableList<Float>). */
    private class MonoSamples {
        var data = FloatArray(16000 * 30)
        var size = 0
        fun add(v: Float) {
            if (size == data.size) data = data.copyOf(data.size * 2)
            data[size++] = v
        }
    }

    /** Interleaved PCM (16-bit or float) → mono floats in [-1, 1], appended to `dst`. */
    private fun appendMono(buf: ByteBuffer, channels: Int, pcmFloat: Boolean, dst: MonoSamples) {
        val ch = channels.coerceAtLeast(1)
        if (pcmFloat) {
            val fb = buf.asFloatBuffer()
            val frames = fb.remaining() / ch
            for (i in 0 until frames) {
                var sum = 0f
                for (c in 0 until ch) sum += fb.get()
                dst.add(sum / ch)
            }
        } else {
            val sb = buf.asShortBuffer()
            val frames = sb.remaining() / ch
            for (i in 0 until frames) {
                var sum = 0f
                for (c in 0 until ch) sum += sb.get() / 32768f
                dst.add(sum / ch)
            }
        }
    }

    /**
     * Resamples mono audio to 16 kHz. Downsampling averages every input
     * sample that falls in each output sample's window (a box low-pass,
     * which keeps aliasing out of the speech band — plenty for whisper);
     * upsampling interpolates linearly.
     */
    private fun resampleTo16k(src: MonoSamples, inRate: Int, maxOut: Int): ShortArray {
        if (src.size == 0 || inRate <= 0) return ShortArray(0)
        val ratio = inRate.toDouble() / TARGET_SAMPLE_RATE
        val outLen = minOf((src.size / ratio).toInt(), maxOut)
        val out = ShortArray(outLen)
        for (i in 0 until outLen) {
            val v: Float = if (ratio > 1.0) {
                val a = (i * ratio).toInt()
                val b = minOf(((i + 1) * ratio).toInt(), src.size).coerceAtLeast(a + 1)
                var sum = 0f
                for (j in a until b) sum += src.data[j]
                sum / (b - a)
            } else {
                val pos = i * ratio
                val a = pos.toInt().coerceAtMost(src.size - 1)
                val b = (a + 1).coerceAtMost(src.size - 1)
                val t = (pos - a).toFloat()
                src.data[a] * (1 - t) + src.data[b] * t
            }
            out[i] = (v.coerceIn(-1f, 1f) * 32767f).toInt().toShort()
        }
        return out
    }

    private fun writeWav(path: String, pcm: ShortArray, sampleRate: Int) {
        val bytes = ByteBuffer.allocate(pcm.size * 2).order(ByteOrder.LITTLE_ENDIAN)
        bytes.asShortBuffer().put(pcm)
        writeWavFile(path, listOf(bytes.array()), pcm.size * 2, sampleRate, channelCount = 1, bitsPerSample = 16)
    }

    private fun writeWavFile(
        path: String,
        pcmChunks: List<ByteArray>,
        totalPcmBytes: Int,
        sampleRate: Int,
        channelCount: Int,
        bitsPerSample: Int,
    ) {
        val byteRate = sampleRate * channelCount * bitsPerSample / 8
        val blockAlign = channelCount * bitsPerSample / 8
        val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        header.put("RIFF".toByteArray(Charsets.US_ASCII))
        header.putInt(36 + totalPcmBytes)
        header.put("WAVE".toByteArray(Charsets.US_ASCII))
        header.put("fmt ".toByteArray(Charsets.US_ASCII))
        header.putInt(16) // fmt chunk size for PCM
        header.putShort(1) // audio format = PCM
        header.putShort(channelCount.toShort())
        header.putInt(sampleRate)
        header.putInt(byteRate)
        header.putShort(blockAlign.toShort())
        header.putShort(bitsPerSample.toShort())
        header.put("data".toByteArray(Charsets.US_ASCII))
        header.putInt(totalPcmBytes)

        FileOutputStream(path).use { fos ->
            fos.write(header.array())
            for (chunk in pcmChunks) {
                fos.write(chunk)
            }
        }
    }
}
