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
import {mapSegmentsToCues, chunkIndexForTime, chunkStartTime} from './TimestampCalculator';
import {useSubtitleStore} from '../store/subtitleStore';

type ProcessorState = 'idle' | 'running' | 'flushing';

class JITProcessor {
  private config: PipelineConfig = DEFAULT_PIPELINE_CONFIG;
  private videoUri = '';
  private videoDuration = 0;
  private state: ProcessorState = 'idle';
  private activeChunkIndex = -1;
  private flushSignal = false;

  init(uri: string, duration: number, config?: Partial<PipelineConfig>): void {
    this.videoUri = uri;
    this.videoDuration = duration;
    this.config = {...DEFAULT_PIPELINE_CONFIG, ...config};
    this.state = 'idle';
    this.activeChunkIndex = -1;
    this.flushSignal = false;
  }

  /**
   * Called by SubtitleManager whenever currentTime changes.
   * Decides whether to kick off the next chunk fetch.
   */
  onPlayheadUpdate(currentTimeSec: number): void {
    if (this.state === 'flushing') return;

    const bufferEnd = this.getBufferEndTime();
    const remaining = bufferEnd - currentTimeSec;

    if (remaining <= this.config.refetchThresholdSec && this.state === 'idle') {
      const nextChunkIdx = chunkIndexForTime(bufferEnd, this.config.chunkDuration);
      const nextChunkStart = chunkStartTime(nextChunkIdx, this.config.chunkDuration);
      if (nextChunkStart < this.videoDuration) {
        this.processChunk(nextChunkIdx, nextChunkStart);
      }
    }
  }

  /**
   * User jumped to a new position. Flush the current pipeline state and
   * restart from the seek position.
   */
  async seek(newTimeSec: number): Promise<void> {
    this.flushSignal = true;
    this.state = 'flushing';

    // Cancel any in-flight FFmpeg session and AI calls
    await FFmpegKit.cancel();
    abortTranscription();
    abortTranslation();

    // Drop all chunks ahead of seek point from the store
    useSubtitleStore.getState().removeChunksAfter(newTimeSec);

    this.flushSignal = false;
    this.state = 'idle';

    // Immediately start processing from the new position
    const targetChunkIdx = chunkIndexForTime(newTimeSec, this.config.chunkDuration);
    const targetStart = chunkStartTime(targetChunkIdx, this.config.chunkDuration);
    this.processChunk(targetChunkIdx, targetStart);
  }

  reset(): void {
    this.flushSignal = true;
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

  private async processChunk(index: number, startSec: number): Promise<void> {
    if (this.flushSignal) return;
    if (this.state === 'running') return; // already busy with a chunk
    if (useSubtitleStore.getState().chunks.has(index)) return; // already done

    this.state = 'running';
    this.activeChunkIndex = index;

    const endSec = Math.min(startSec + this.config.chunkDuration, this.videoDuration);
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
      if (this.flushSignal) { this.state = 'idle'; return; }
      const wavPath = await extractChunk(
        this.videoUri, startSec, actualDuration, index,
      );
      upsertChunk({...chunk, status: 'transcribing', wavPath});

      // ── Step 2: STT via whisper.cpp ───────────────────────────────────────
      if (this.flushSignal) { this.state = 'idle'; return; }
      const whisperResult = await transcribeAudio(wavPath);
      upsertChunk({...chunk, status: 'translating', wavPath});

      // ── Step 3: Translation (NLLB) ────────────────────────────────────────
      if (this.flushSignal) { this.state = 'idle'; return; }
      const hebrewTexts = await translateSegments(whisperResult.segments);

      // ── Step 4: Timestamp mapping & store ────────────────────────────────
      const cues = mapSegmentsToCues(
        whisperResult.segments, index, startSec, hebrewTexts,
      );

      upsertChunk({...chunk, status: 'ready', wavPath, cues});

      // Clean up the temp WAV to free storage
      deleteChunk(index);
    } catch (err) {
      if (!this.flushSignal) {
        upsertChunk({...chunk, status: 'error', error: String(err)});
      }
    } finally {
      this.state = 'idle';
    }

    // ── Step 5: Schedule next chunk if still needed ───────────────────────
    if (!this.flushSignal) {
      const nextIdx = index + 1;
      const nextStart = chunkStartTime(nextIdx, this.config.chunkDuration);
      if (nextStart < this.videoDuration) {
        const bufferEnd = this.getBufferEndTime();
        const playhead = useVideoStore_currentTime();
        if (bufferEnd - playhead < this.config.bufferAheadSec) {
          this.processChunk(nextIdx, nextStart);
        }
      }
    }
  }
}

// Lightweight store accessor without a hook (called from non-component context)
function useVideoStore_currentTime(): number {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../store/videoStore').useVideoStore.getState().currentTime;
}

export const jitProcessor = new JITProcessor();
