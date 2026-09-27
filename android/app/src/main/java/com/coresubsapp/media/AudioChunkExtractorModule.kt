package com.coresubsapp.media

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.ChannelMixingAudioProcessor
import androidx.media3.common.audio.ChannelMixingMatrix
import androidx.media3.common.audio.SonicAudioProcessor
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
 * own MediaExtractor/MediaCodec (decode) plus AndroidX Media3's
 * ChannelMixingAudioProcessor (downmix to mono) and SonicAudioProcessor
 * (resample) — Google-maintained code patched via normal Android/Play
 * updates, not a third-party C demuxer parsing untrusted video files.
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
            val inputChannelCount = trackFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
            val inputSampleRate = trackFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)

            codec = MediaCodec.createDecoderByType(mime)
            codec.configure(trackFormat, null, null, 0)
            codec.start()

            // ── Audio processing chain: downmix to mono, then resample to 16 kHz ──
            // A matrix is always registered (even for already-mono input, where it's
            // effectively an identity op) — ChannelMixingAudioProcessor throws if
            // asked to process a channel count it has no matrix for.
            val channelMixer = ChannelMixingAudioProcessor()
            channelMixer.putChannelMixingMatrix(
                ChannelMixingMatrix.createForConstantPower(inputChannelCount, 1),
            )
            val sonic = SonicAudioProcessor()
            sonic.setOutputSampleRateHz(TARGET_SAMPLE_RATE)

            val sourceFormat = AudioProcessor.AudioFormat(
                inputSampleRate,
                inputChannelCount,
                C.ENCODING_PCM_16BIT,
            )
            val mixedFormat = channelMixer.configure(sourceFormat)
            sonic.configure(mixedFormat)
            channelMixer.flush()
            sonic.flush()

            val pcmChunks = mutableListOf<ByteArray>()
            var totalPcmBytes = 0

            fun drainSonic() {
                while (true) {
                    val out = sonic.getOutput()
                    if (!out.hasRemaining()) break
                    val bytes = ByteArray(out.remaining())
                    out.get(bytes)
                    pcmChunks.add(bytes)
                    totalPcmBytes += bytes.size
                }
            }

            fun pumpProcessorChain(input: ByteBuffer) {
                channelMixer.queueInput(input)
                while (true) {
                    val mixed = channelMixer.getOutput()
                    if (!mixed.hasRemaining()) break
                    sonic.queueInput(mixed)
                }
                drainSonic()
            }

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
                if (outIndex >= 0) {
                    if (bufferInfo.size > 0 && bufferInfo.presentationTimeUs >= startUs) {
                        val outputBuffer = codec.getOutputBuffer(outIndex)!!
                        outputBuffer.position(bufferInfo.offset)
                        outputBuffer.limit(bufferInfo.offset + bufferInfo.size)
                        pumpProcessorChain(outputBuffer)
                    }
                    codec.releaseOutputBuffer(outIndex, false)
                    if (bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
                        sawOutputEOS = true
                    }
                }
            }

            if (!abortFlag.get()) {
                channelMixer.queueEndOfStream()
                sonic.queueEndOfStream()
                while (!sonic.isEnded()) {
                    val before = totalPcmBytes
                    drainSonic()
                    if (totalPcmBytes == before) break // no more forthcoming
                }
                writeWavFile(outputPath, pcmChunks, totalPcmBytes, TARGET_SAMPLE_RATE, channelCount = 1, bitsPerSample = 16)
            }
        } finally {
            codec?.stop()
            codec?.release()
            extractor.release()
        }
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
