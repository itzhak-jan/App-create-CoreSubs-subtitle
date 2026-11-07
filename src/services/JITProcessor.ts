/**
 * JITProcessor — orchestrates the Just-In-Time subtitle pipeline as two
 * independent stages that run at the same time:
 *
 *   STT stage          extract audio → whisper (CPU)      → translation queue
 *   Translation stage  lock new names → translate (ML Kit / GPU) → cues ready
 *
 * Previously one chunk went through every step before the next chunk
 * started, so whisper sat idle during translation (and vice versa), and a
 * 60 s chunk that took more than 60 s to process meant a guaranteed stall.
 * Now whisper keeps transcribing ahead while translation catches up.
 *
 * Other latency details:
 *  - The first chunk after load/seek is short (firstChunkDuration), so
 *    subtitles appear within seconds; later chunks are chunkDuration.
 *  - Chunk boundaries follow speech: if whisper's last segment runs into
 *    the end of the chunk (a sentence cut in half), it's dropped and the
 *    next chunk starts at that segment instead.
 *  - Finished chunks are kept across seeks, so jumping back doesn't redo
 *    work; the STT cursor just skips over audio that's already covered.
 *  - Every stage logs its duration under the "[CoreSubs][timing]" tag
 *    (adb logcat | grep CoreSubs) so the slow stage is visible on-device.
 */

import type {AudioChunk, PipelineConfig, WhisperSegment} from '../types';
import {DEFAULT_PIPELINE_CONFIG} from '../types';
import {
  extractChunk,
  deleteChunk,
  abortChunkExtraction,
} from './ChunkExtractor';
import {transcribeAudio, abortTranscription} from './STTService';
import {
  translateSegments,
  abortTranslation,
  prepareTranslation,
  isLlmReady,
} from './TranslationService';
import {extractGlossaryEntries} from './GlossaryExtractor';
import {
  observeSegments,
  lockPendingTerms,
  resetGlossaryDetection,
} from './GlossaryService';
import {useGlossaryStore} from '../store/glossaryStore';
import {getSettings} from '../store/settingsStore';
import {mapSegmentsToCues} from './TimestampCalculator';
import {useSubtitleStore} from '../store/subtitleStore';
import {useVideoStore} from '../store/videoStore';

/** Seconds — a last segment ending this close to the chunk end is treated
 *  as cut off mid-sentence. */
const CUT_TOLERANCE_SEC = 1.0;
/** Never shrink a chunk below this when re-aligning to speech. */
const MIN_CHUNK_SEC = 12; // every whisper call costs the same, so avoid tiny chunks
/** With the LLM engine, run glossary extraction every N translated chunks. */
const LLM_GLOSSARY_EVERY = 3;

const log = (msg: string) => console.log(`[CoreSubs][timing] ${msg}`);

class JITProcessor {
  private config: PipelineConfig = DEFAULT_PIPELINE_CONFIG;
  private videoUri = '';
  private videoDuration = 0;

  /**
   * Bumped on every init/seek/reset. Each stage call captures the
   * generation it started with and re-checks it after every await point,
   * so a stale call (native abort is cooperative) can never write to the
   * store or steal the busy flags of the new position.
   */
  private generation = 0;

  private sttBusy = false;
  private trBusy = false;
  /** Media time where the STT stage will cut its next chunk. */
  private sttCursor = 0;
  private nextIsFirst = true;
  private nextIndex = 0;
  /** Chunk indices that are transcribed and waiting for translation. */
  private translateQueue = new Set<number>();
  private translatedSinceGlossary = 0;
  private lastLanguage = 'en';
  /** Language whisper detected for this video (auto mode), reused afterwards. */
  private detectedLanguage: string | null = null;
  private videoName = '';
  private glossaryLoading: Promise<void> = Promise.resolve();
  private recentPairs: Array<{original: string; hebrew: string}> = [];
  private recentLang = 'en';

  /**
   * videoName keys the persisted glossary (together with the target
   * language — renderings are per language).
   */
  init(
    uri: string,
    duration: number,
    videoName = '',
    config?: Partial<PipelineConfig>,
  ): void {
    this.generation++;
    this.videoUri = uri;
    this.videoName = videoName;
    this.videoDuration = duration;
    this.config = {...DEFAULT_PIPELINE_CONFIG, ...config};
    this.sttBusy = false;
    this.trBusy = false;
    this.sttCursor = 0;
    this.nextIsFirst = true;
    this.nextIndex = 0;
    this.translateQueue.clear();
    this.translatedSinceGlossary = 0;
    this.recentPairs = [];
    this.detectedLanguage = null;
    resetGlossaryDetection();

    const {sourceLang, targetLang} = getSettings();
    this.glossaryLoading = videoName
      ? useGlossaryStore.getState().loadForVideo(`${videoName}.${targetLang}`)
      : Promise.resolve();
    this.lastLanguage = sourceLang === 'auto' ? 'en' : sourceLang;
    // Fetch the ML Kit language pack now rather than on the first chunk.
    prepareTranslation(sourceLang, targetLang);
  }

  /** Called ~4×/s from SubtitleManager; cheap when there's nothing to do. */
  onPlayheadUpdate(_currentTimeSec: number): void {
    this.pumpStt();
    this.pumpTranslate();
  }

  /**
   * User jumped to a new position. Abort in-flight work, keep everything
   * already finished, and restart both stages from the new position.
   */
  async seek(newTimeSec: number): Promise<void> {
    this.generation++;

    // Best-effort cancels; the generation bump is what actually makes
    // stale calls harmless.
    abortChunkExtraction();
    abortTranscription();
    abortTranslation();

    const store = useSubtitleStore.getState();
    this.translateQueue.clear();
    for (const chunk of Array.from(store.chunks.values())) {
      if (chunk.status === 'ready') {
        continue;
      }
      if (
        (chunk.status === 'awaiting_translation' ||
          chunk.status === 'translating') &&
        chunk.segments
      ) {
        // Transcription survived — only the translation needs redoing.
        store.upsertChunk({...chunk, status: 'awaiting_translation'});
        this.translateQueue.add(chunk.index);
      } else {
        // Interrupted mid-extraction/transcription, or errored: redo.
        store.removeChunk(chunk.index);
        deleteChunk(chunk.index);
      }
    }
    store.setActiveCue(null);

    this.sttBusy = false;
    this.trBusy = false;
    this.sttCursor = Math.max(0, newTimeSec);
    this.nextIsFirst = true;

    this.pumpStt();
    this.pumpTranslate();
  }

  /**
   * Settings changed (engine / languages): drop all subtitles and start
   * again from the current position with the new settings.
   */
  restart(): void {
    if (!this.videoUri) {
      return;
    }
    abortChunkExtraction();
    abortTranscription();
    abortTranslation();
    const playhead = useVideoStore.getState().currentTime;
    useSubtitleStore.getState().reset();
    this.init(this.videoUri, this.videoDuration, this.videoName, this.config);
    this.sttCursor = playhead;
    this.pumpStt();
  }

  reset(): void {
    this.generation++;
    abortChunkExtraction();
    abortTranscription();
    abortTranslation();
    this.sttBusy = false;
    this.trBusy = false;
    this.translateQueue.clear();
    this.videoUri = '';
    this.videoDuration = 0;
    useSubtitleStore.getState().reset();
    // Glossary entries are facts about THIS video — forget them on a new
    // video (they're persisted per video and reloaded next time), but not
    // on seek().
    useGlossaryStore.getState().reset();
    resetGlossaryDetection();
  }

  // ─── Coverage helpers ─────────────────────────────────────────────────────

  /** Moves `t` past any existing chunk(s) covering it. */
  private skipCovered(t: number): number {
    const chunks = Array.from(useSubtitleStore.getState().chunks.values());
    let cursor = t;
    let moved = true;
    while (moved) {
      moved = false;
      for (const c of chunks) {
        if (cursor >= c.startSec - 0.05 && cursor < c.endSec - 0.05) {
          cursor = c.endSec;
          moved = true;
        }
      }
    }
    return cursor;
  }

  /** Start of the first existing chunk after `t` (so new chunks don't overlap it). */
  private nextChunkStartAfter(t: number): number {
    let next = Infinity;
    for (const c of useSubtitleStore.getState().chunks.values()) {
      if (c.startSec > t + 0.05 && c.startSec < next) {
        next = c.startSec;
      }
    }
    return next;
  }

  // ─── Stage 1: STT ─────────────────────────────────────────────────────────

  private async pumpStt(): Promise<void> {
    if (this.sttBusy || !this.videoUri) {
      return;
    }
    const gen = this.generation;
    const playhead = useVideoStore.getState().currentTime;

    const start = this.skipCovered(this.sttCursor);
    this.sttCursor = start;
    if (start >= this.videoDuration - 0.1) {
      return;
    }
    if (start - playhead > this.config.bufferAheadSec) {
      return; // far enough ahead
    }

    const len = this.nextIsFirst
      ? this.config.firstChunkDurationSec
      : this.config.chunkDuration;
    let end = Math.min(
      start + len,
      this.videoDuration,
      this.nextChunkStartAfter(start),
    );
    if (end - start < 0.2) {
      this.sttCursor = end;
      return;
    }

    this.sttBusy = true;
    this.nextIsFirst = false;
    const index = this.nextIndex++;
    const store = useSubtitleStore.getState();
    const chunk: AudioChunk = {
      index,
      startSec: start,
      endSec: end,
      status: 'extracting',
      cues: [],
    };
    store.upsertChunk(chunk);

    try {
      const t0 = Date.now();
      const wavPath = await extractChunk(
        this.videoUri,
        start,
        end - start,
        index,
      );
      const t1 = Date.now();
      if (gen !== this.generation) {
        deleteChunk(index);
        return;
      }
      store.upsertChunk({...chunk, status: 'transcribing', wavPath});

      // With auto-detect, detect once per video and then pass the language
      // explicitly: detection costs whisper an extra encoder pass per call.
      const {sourceLang} = getSettings();
      const lang =
        sourceLang === 'auto' && this.detectedLanguage
          ? this.detectedLanguage
          : sourceLang;
      const result = await transcribeAudio(wavPath, lang);
      const t2 = Date.now();
      deleteChunk(index);
      if (gen !== this.generation) {
        return;
      }

      let segments: WhisperSegment[] = result.segments.filter(s =>
        s.text.trim(),
      );
      const isLastChunk = end >= this.videoDuration - 0.1;
      const last = segments[segments.length - 1];
      if (
        !isLastChunk &&
        segments.length >= 2 &&
        last.t1 >= end - start - CUT_TOLERANCE_SEC &&
        last.t0 >= MIN_CHUNK_SEC
      ) {
        // Sentence cut by the chunk boundary — let the next chunk own it.
        segments = segments.slice(0, -1);
        end = start + last.t0;
      }

      const language = result.language || this.lastLanguage;
      this.lastLanguage = language;
      if (sourceLang === 'auto' && segments.length > 0) {
        this.detectedLanguage = language;
      }
      observeSegments(segments, language);

      log(
        `chunk ${index} [${start.toFixed(1)}–${end.toFixed(1)}s] ` +
          `extract ${t1 - t0}ms, stt ${t2 - t1}ms, ${
            segments.length
          } segs, lang ${language}`,
      );

      store.upsertChunk({
        ...chunk,
        endSec: end,
        status: 'awaiting_translation',
        segments,
        language,
      });
      this.sttCursor = end;
      this.translateQueue.add(index);
    } catch (err) {
      if (gen === this.generation) {
        console.error(`[JITProcessor] STT chunk ${index} failed:`, err);
        store.upsertChunk({...chunk, status: 'error', error: String(err)});
        this.sttCursor = end; // skip it rather than loop on a bad spot
      }
    } finally {
      if (gen === this.generation) {
        this.sttBusy = false;
      }
    }

    if (gen === this.generation) {
      this.pumpTranslate();
      this.pumpStt();
    }
  }

  // ─── Stage 2: Translation ─────────────────────────────────────────────────

  /** Next chunk to translate: the earliest one the viewer hasn't passed yet. */
  private pickNextToTranslate(): AudioChunk | undefined {
    const {chunks} = useSubtitleStore.getState();
    const playhead = useVideoStore.getState().currentTime;
    let best: AudioChunk | undefined;
    let bestBehind: AudioChunk | undefined;
    for (const idx of Array.from(this.translateQueue)) {
      const c = chunks.get(idx);
      if (!c || c.status !== 'awaiting_translation' || !c.segments) {
        this.translateQueue.delete(idx);
        continue;
      }
      if (c.endSec >= playhead) {
        if (!best || c.startSec < best.startSec) {
          best = c;
        }
      } else if (!bestBehind || c.startSec > bestBehind.startSec) {
        bestBehind = c;
      }
    }
    return best ?? bestBehind;
  }

  private async pumpTranslate(): Promise<void> {
    if (this.trBusy) {
      return;
    }
    const chunk = this.pickNextToTranslate();
    if (!chunk) {
      this.maybeRunLlmGlossary();
      return;
    }

    const gen = this.generation;
    this.trBusy = true;
    this.translateQueue.delete(chunk.index);
    const store = useSubtitleStore.getState();
    store.upsertChunk({...chunk, status: 'translating'});

    try {
      const segments = chunk.segments ?? [];
      const src = chunk.language ?? this.lastLanguage;
      await this.glossaryLoading;
      const t0 = Date.now();
      // Lock renderings for names first seen around here, so THIS chunk
      // already uses them.
      await lockPendingTerms(src);
      const t1 = Date.now();
      const texts = await translateSegments(segments, src);
      const t2 = Date.now();
      if (gen !== this.generation) {
        return; // seek() re-queued this chunk
      }

      log(
        `chunk ${chunk.index} translate ${t2 - t1}ms` +
          (t1 - t0 > 5 ? ` (+${t1 - t0}ms locking names)` : '') +
          `, ${segments.length} lines`,
      );

      store.upsertChunk({
        ...chunk,
        status: 'ready',
        segments: undefined,
        cues: mapSegmentsToCues(segments, chunk.index, chunk.startSec, texts),
      });
      this.translatedSinceGlossary++;
      this.recentPairs.push(
        ...segments.map((s, i) => ({
          original: s.text.trim(),
          hebrew: texts[i] ?? '',
        })),
      );
      this.recentPairs = this.recentPairs.slice(-24);
      this.recentLang = src;
    } catch (err) {
      if (gen === this.generation) {
        console.error(
          `[JITProcessor] translation chunk ${chunk.index} failed:`,
          err,
        );
        store.upsertChunk({...chunk, status: 'error', error: String(err)});
      }
    } finally {
      if (gen === this.generation) {
        this.trBusy = false;
      }
    }

    if (gen === this.generation) {
      this.pumpTranslate();
      this.pumpStt();
    }
  }

  // ─── LLM glossary extraction (llm engine only, idle time only) ────────────

  /**
   * The Gemma engine can also extract names with grammatical gender. It
   * shares the model with translation, so it only runs when the
   * translation queue is empty, and at most every LLM_GLOSSARY_EVERY
   * chunks — it must never delay a subtitle. Holding trBusy while it runs
   * means a newly queued chunk waits for at most one extraction call.
   */
  private async maybeRunLlmGlossary(): Promise<void> {
    if (
      getSettings().engine !== 'llm' ||
      !isLlmReady() ||
      this.translatedSinceGlossary < LLM_GLOSSARY_EVERY ||
      this.recentPairs.length === 0
    ) {
      return;
    }
    const gen = this.generation;
    this.trBusy = true;
    this.translatedSinceGlossary = 0;
    const pairs = this.recentPairs;
    this.recentPairs = [];
    try {
      const entries = await extractGlossaryEntries(
        pairs,
        this.recentLang,
        getSettings().targetLang,
      );
      useGlossaryStore.getState().upsertEntries(entries);
    } finally {
      if (gen === this.generation) {
        this.trBusy = false;
        this.pumpTranslate();
      }
    }
  }
}

export const jitProcessor = new JITProcessor();
