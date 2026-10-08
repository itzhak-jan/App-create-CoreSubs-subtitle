// ─── Subtitle Cue ────────────────────────────────────────────────────────────

export interface SubtitleCue {
  /** Unique id: `${chunkIndex}_${segmentIndex}` */
  id: string;
  /** Absolute media-time start in seconds */
  startTime: number;
  /** Absolute media-time end in seconds */
  endTime: number;
  /** Original transcribed text */
  originalText: string;
  /** Translated Hebrew text */
  hebrewText: string;
}

// ─── Chunk / Pipeline ────────────────────────────────────────────────────────

export type ChunkStatus =
  | 'pending'
  | 'extracting'
  | 'transcribing'
  | 'translating'
  | 'ready'
  | 'error';

export interface AudioChunk {
  index: number;
  /** Media-time start of this chunk (seconds) */
  startSec: number;
  /** Media-time end of this chunk (seconds) */
  endSec: number;
  /** Temp file path for the extracted WAV */
  wavPath?: string;
  status: ChunkStatus;
  cues: SubtitleCue[];
  error?: string;
}

// ─── Whisper / STT ───────────────────────────────────────────────────────────

export interface WhisperSegment {
  /** Relative offset within this chunk (seconds) */
  t0: number;
  t1: number;
  text: string;
}

export interface WhisperResult {
  segments: WhisperSegment[];
  language: string;
}

// ─── Translation ─────────────────────────────────────────────────────────────

export interface TranslationResult {
  originalText: string;
  hebrewText: string;
}

// ─── Glossary (running translation-memory for a single video) ────────────────

export type GlossaryCategory = 'person' | 'place' | 'phrase' | 'other';

export interface GlossaryEntry {
  /** The exact English term/phrase as it appears in Whisper's transcript —
   *  the stable identifier used to detect this entry's relevance in later
   *  segments (case-insensitive substring match). */
  term: string;
  /** The Hebrew rendering to reuse consistently for this term. */
  hebrew: string;
  /** For people — keeps Hebrew's grammatical gender agreement (verbs/
   *  adjectives) consistent across segments that refer back to them. */
  gender?: 'm' | 'f';
  category?: GlossaryCategory;
}

// ─── Video State ─────────────────────────────────────────────────────────────

export type VideoLoadState = 'idle' | 'loading' | 'ready' | 'error';

export interface VideoMeta {
  uri: string;
  duration: number;
  /** Filename without extension */
  displayName: string;
}

// ─── Export ──────────────────────────────────────────────────────────────────

export type ExportStatus = 'idle' | 'encoding' | 'saving' | 'done' | 'error';

export interface ExportState {
  status: ExportStatus;
  progress: number;
  outputPath?: string;
  error?: string;
}

// ─── Processing Pipeline ─────────────────────────────────────────────────────

export interface PipelineConfig {
  /** Duration of each audio chunk in seconds (chunk 0 excluded — see firstChunkDurationSec) */
  chunkDuration: number;
  /**
   * Duration of chunk 0 specifically, in seconds. Short on purpose: the
   * first subtitle shouldn't need a full chunkDuration's worth of
   * extract+transcribe+translate before it can appear, since the video
   * itself already starts playing as soon as it's loaded (see
   * VideoPlayer.tsx's onLoad). Chunk 1 onward reverts to chunkDuration.
   */
  firstChunkDurationSec: number;
  /** How many seconds ahead of playhead to maintain in the buffer */
  bufferAheadSec: number;
  /** Trigger re-fetch when buffer remaining drops below this (seconds) */
  refetchThresholdSec: number;
}

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  chunkDuration: 60,
  firstChunkDurationSec: 8,
  bufferAheadSec: 120,
  refetchThresholdSec: 30,
};
