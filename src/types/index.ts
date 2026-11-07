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
  /** Translated text in the target language. (Field name kept from when the
   *  target was always Hebrew — it's whatever settings.targetLang is.) */
  hebrewText: string;
}

// ─── Chunk / Pipeline ────────────────────────────────────────────────────────

export type ChunkStatus =
  | 'pending'
  | 'extracting'
  | 'transcribing'
  /** Transcribed; waiting in the translation queue. */
  | 'awaiting_translation'
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
  /** Whisper output, held between the STT stage and the translation stage. */
  segments?: WhisperSegment[];
  /** Source language whisper used/detected for this chunk (ISO 639-1). */
  language?: string;
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
  /** Where the entry came from. 'user' entries are never overwritten by
   *  automatic detection/extraction. */
  origin?: 'auto' | 'llm' | 'user';
}

// ─── Settings ────────────────────────────────────────────────────────────────

/**
 * 'mlkit' — Google ML Kit on-device translation: tiny per-language models
 *           (~30 MB, downloaded once), milliseconds per sentence. Default.
 * 'llm'   — Gemma via MediaPipe: slower, needs the 500 MB+ model, but can
 *           follow glossary hints incl. grammatical gender.
 */
export type TranslationEngine = 'mlkit' | 'llm';

export interface AppSettings {
  engine: TranslationEngine;
  /** ISO 639-1 target language, e.g. 'he'. */
  targetLang: string;
  /** ISO 639-1 source language, or 'auto' to let whisper detect it
   *  (requires a multilingual whisper model — '.en' models are English-only). */
  sourceLang: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  engine: 'mlkit',
  targetLang: 'he',
  sourceLang: 'auto',
};

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
  /** Duration of a regular audio chunk in seconds. */
  chunkDuration: number;
  /** Duration of the first chunk after load/seek — short, so the first
   *  subtitle shows up within a few seconds. */
  firstChunkDurationSec: number;
  /** How many seconds ahead of the playhead the STT stage keeps transcribed. */
  bufferAheadSec: number;
}

// chunkDuration stays just under 30 s: whisper's encoder processes a fixed
// 30 s window per call, so anything shorter wastes compute per second of
// audio. Measured on a Pixel 10 Pro XL with whisper small: a 28 s chunk
// takes ~14.5 s, a 5 s chunk 17–22 s — so the first chunk after a seek is
// full length too (short ones only cost more).
export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  chunkDuration: 28,
  firstChunkDurationSec: 28,
  bufferAheadSec: 90,
};
