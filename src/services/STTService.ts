import {NativeModules, NativeEventEmitter} from 'react-native';
import type {WhisperResult} from '../types';

const {WhisperModule} = NativeModules;

if (!WhisperModule) {
  console.warn(
    '[STTService] WhisperModule not found — native build required. ' +
    'Ensure the Android module is compiled and linked.',
  );
}

export const WhisperEvents = new NativeEventEmitter(WhisperModule ?? {});

/**
 * Initialise the whisper.cpp model (call once at app startup).
 * modelPath: absolute path to the .gguf model file on device storage.
 */
export async function initWhisper(modelPath: string): Promise<void> {
  if (!WhisperModule) return;
  await WhisperModule.init(modelPath);
}

/**
 * Transcribe a 16 kHz mono WAV file. Returns segments with chunk-relative
 * timestamps (t0/t1 in seconds).
 */
export async function transcribeAudio(wavPath: string): Promise<WhisperResult> {
  if (!WhisperModule) {
    // Dev-mode stub — returns an empty result so the pipeline stays alive
    return {segments: [], language: 'en'};
  }

  const raw: {segments: Array<{t0: number; t1: number; text: string}>; language: string} =
    await WhisperModule.transcribe(wavPath);

  return {
    segments: raw.segments.map(s => ({
      t0: s.t0 / 100.0, // whisper timestamps are in centiseconds
      t1: s.t1 / 100.0,
      text: s.text,
    })),
    language: raw.language,
  };
}

/** Abort any in-progress transcription immediately. */
export function abortTranscription(): void {
  WhisperModule?.abort();
}
