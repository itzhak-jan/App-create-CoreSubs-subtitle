import {NativeModules} from 'react-native';
import type {WhisperSegment} from '../types';

const {TranslatorModule} = NativeModules;

if (!TranslatorModule) {
  console.warn(
    '[TranslationService] TranslatorModule not found — native build required.',
  );
}

/**
 * Initialise the on-device translator (call once at app startup).
 * modelPath: absolute path to the TranslateGemma .task bundle on device.
 */
export async function initTranslation(modelPath: string): Promise<void> {
  if (!TranslatorModule) {
    return;
  }
  await TranslatorModule.init(modelPath);
}

/**
 * Translate an array of source segments into Hebrew.
 * Returns Hebrew strings in the same order as the input segments.
 */
export async function translateSegments(
  segments: WhisperSegment[],
): Promise<string[]> {
  if (!TranslatorModule || segments.length === 0) {
    return segments.map(s => s.text);
  }

  const texts = segments.map(s => s.text.trim()).filter(Boolean);

  // The LLM Inference API generates one response per prompt (no native
  // tensor-batching), so the native side loops sequentially over `texts`.
  const results: string[] = await TranslatorModule.translateBatch(texts);
  return results;
}

/** Abort any pending translation batch. */
export function abortTranslation(): void {
  TranslatorModule?.abort();
}
