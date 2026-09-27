/**
 * JITProcessor — master orchestrator for the Just-In-Time subtitle pipeline.
 *
 * Responsibilities:
 *  - Maintains a processing queue of AudioChunks
 *  - Advances the buffer ahead of the playhead
 *  - Handles seek flushes
 *  - Throttles concurrent work to avoid thermal pressure
 */

import {FFmpegKit} from 'ffmpeg-kit-react-native';
import type {AudioChunk, PipelineConfig} from '../types';
import {DEFAULT_PIPELINE_CONFIG} from '../types';
import {extractChunk, deleteChunk} from './ChunkExtractor';
import {transcribeAudio, abortTranscription} from './STTService';
import {translateSegments, abortTranslation} from './TranslationService';
import {
  mapSegmentsToCues,
  chunkIndexForTime,
  chunkStartTime,
} from './TimestampCalculator';
import {useSubtitleStore} from '../store/subtitleStore';
import {useVideoStore} from '../store/videoStore';

type ProcessorState = 'idle' | 'running';

class JITProcessor {
  private config: PipelineConfig = DEFAULT_PIPELINE_CONFIG;
  private videoUri = '';
  private videoDuration = 0;
  private state: ProcessorState = 'idle';
  private activeChunkIndex = -1;

  /**
   * Bumped on every init/seek/reset. Each processChunk() call captures the
   * generation it was started with and re-checks it after every await point.
   *
   * A boolean "flushSignal" used to serve this purpose, but it was reset
   * synchronously in seek() without waiting for the stale in-flight
   * processChunk() to actually observe it. Native abort (whisper.cpp /
   * TFLite) is only cooperative — whisper_full() and the interpreter run
   * loop are blocking calls that don't check the abort flag mid-inference —
   * so a stale call could resume seconds later, after the flag had already
   * been reset for the new position, and resurrect a chunk that seek() had
   * just removed, or clobber `this.state` out from under the new chunk.
   * A monotonically increasing generation counter can't be "un-bumped" by
   * a stale call, so this can't happen.
   */
  private generation = 0;

  init(uri: string, duration: number, config?: Partial<PipelineConfig>): void {
    this.generation++;
    this.videoUri = uri;
    this.videoDuration = duration;
    this.config = {...DEFAULT_PIPELINE_CONFIG, ...config};
    this.state = 'idle';
    this.activeChunkIndex = -1;
  }

  /**
   * Called by SubtitleManager whenever currentTime changes.
   * Decides whether to kick off the next chunk fetch.
   */
  onPlayheadUpdate(currentTimeSec: number): void {
    if (this.state !== 'idle') {
      return;
    }

    const bufferEnd = this.getBufferEndTime();
    const remaining = bufferEnd - currentTimeSec;

    if (remaining <= this.config.refetchThresholdSec) {
      const nextChunkIdx = chunkIndexForTime(
        bufferEnd,
        this.config.chunkDuration,
      );
      const nextChunkStart = chunkStartTime(
        nextChunkIdx,
        this.config.chunkDuration,
      );
      if (nextChunkStart < this.videoDuration) {
        this.processChunk(nextChunkIdx, nextChunkStart, this.generation);
      }
    }
  }

  /**
   * User jumped to a new position. Flush the current pipeline state and
   * restart from the seek position.
   */
  async seek(newTimeSec: number): Promise<void> {
    const myGen = ++this.generation; // invalidates any in-flight processChunk call

    // Cancel any in-flight FFmpeg session and AI calls. These are best-effort:
    // a stale call may still resume after this, but the generation bump above
    // means it can no longer touch the store or `this.state` once it does.
    await FFmpegKit.cancel();
    abortTranscription();
    abortTranslation();

    // Drop all chunks ahead of seek point from the store
    useSubtitleStore.getState().removeChunksAfter(newTimeSec);

    // Force state back to idle so the new chunk below isn't blocked by a
    // stale call that still believes it owns 'running' — its own finally
    // block will no-op once it notices the generation has moved on.
    this.state = 'idle';

    // Immediately start processing from the new position
    const targetChunkIdx = chunkIndexForTime(
      newTimeSec,
      this.config.chunkDuration,
    );
    const targetStart = chunkStartTime(
      targetChunkIdx,
      this.config.chunkDuration,
    );
    this.processChunk(targetChunkIdx, targetStart, myGen);
  }

  reset(): void {
    this.generation++;
    FFmpegKit.cancel();
    abortTranscription();
    abortTranslation();
    this.state = 'idle';
    this.videoUri = '';
    this.videoDuration = 0;
    useSubtitleStore.getState().reset();
  }

  private getBufferEndTime(): number {
    const {chunks} = useSubtitleStore.getState();
    let maxEnd = 0;
    for (const chunk of chunks.values()) {
      if (chunk.status === 'ready' && chunk.endSec > maxEnd) {
        maxEnd = chunk.endSec;
      }
    }
    return maxEnd;
  }

  private async processChunk(
    index: number,
    startSec: number,
    gen: number,
  ): Promise<void> {
    if (gen !== this.generation) {
      return;
    } // superseded before we even started
    if (this.state === 'running') {
      return;
    } // already busy with a chunk
    if (useSubtitleStore.getState().chunks.has(index)) {
      return;
    } // already done

    this.state = 'running';
    this.activeChunkIndex = index;

    const endSec = Math.min(
      startSec + this.config.chunkDuration,
      this.videoDuration,
    );
    const actualDuration = endSec - startSec;

    const chunk: AudioChunk = {
      index,
      startSec,
      endSec,
      status: 'extracting',
      cues: [],
    };

    const {upsertChunk} = useSubtitleStore.getState();
    upsertChunk({...chunk});

    try {
      // ── Step 1: Audio extraction ──────────────────────────────────────────
      if (gen !== this.generation) {
        return;
      }
      const wavPath = await extractChunk(
        this.videoUri,
        startSec,
        actualDuration,
        index,
      );
      if (gen !== this.generation) {
        return;
      }
      upsertChunk({...chunk, status: 'transcribing', wavPath});

      // ── Step 2: STT via whisper.cpp ───────────────────────────────────────
      if (gen !== this.generation) {
        return;
      }
      const whisperResult = await transcribeAudio(wavPath);
      if (gen !== this.generation) {
        return;
      }
      upsertChunk({...chunk, status: 'translating', wavPath});

      // ── Step 3: Translation (TranslateGemma) ──────────────────────────────
      if (gen !== this.generation) {
        return;
      }
      const hebrewTexts = await translateSegments(whisperResult.segments);
      if (gen !== this.generation) {
        return;
      }

      // ── Step 4: Timestamp mapping & store ────────────────────────────────
      const cues = mapSegmentsToCues(
        whisperResult.segments,
        index,
        startSec,
        hebrewTexts,
      );

      upsertChunk({...chunk, status: 'ready', wavPath, cues});

      // Clean up the temp WAV to free storage
      deleteChunk(index);
    } catch (err) {
      if (gen === this.generation) {
        upsertChunk({...chunk, status: 'error', error: String(err)});
      }
    } finally {
      // Only release the lock if we still own it — a stale call whose
      // generation has been superseded must not clobber the new owner's
      // 'running' state.
      if (gen === this.generation) {
        this.state = 'idle';
      }
    }

    // ── Step 5: Schedule next chunk if still needed ───────────────────────
    if (gen === this.generation) {
      const nextIdx = index + 1;
      const nextStart = chunkStartTime(nextIdx, this.config.chunkDuration);
      if (nextStart < this.videoDuration) {
        const bufferEnd = this.getBufferEndTime();
        const playhead = readCurrentPlayheadTime();
        if (bufferEnd - playhead < this.config.bufferAheadSec) {
          this.processChunk(nextIdx, nextStart, gen);
        }
      }
    }
  }
}

// Reads the store directly (no hook) — this runs outside any React component.
function readCurrentPlayheadTime(): number {
  return useVideoStore.getState().currentTime;
}

export const jitProcessor = new JITProcessor();
