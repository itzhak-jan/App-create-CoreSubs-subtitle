import {NativeModules} from 'react-native';
import type {WhisperSegment} from '../types';

const {NLLBTranslationModule} = NativeModules;

if (!NLLBTranslationModule) {
  console.warn(
    '[TranslationService] NLLBTranslationModule not found — native build required.',
  );
}

/**
 * Initialise the TFLite NLLB model (call once at app startup).
 * modelPath: absolute path to the .tflite model file on device.
 */
export async function initTranslation(modelPath: string): Promise<void> {
  if (!NLLBTranslationModule) {
    return;
  }
  await NLLBTranslationModule.init(modelPath, 'eng_Latn', 'heb_Hebr');
}

/**
 * Translate an array of source segments into Hebrew.
 * Returns Hebrew strings in the same order as the input segments.
 */
export async function translateSegments(
  segments: WhisperSegment[],
): Promise<string[]> {
  if (!NLLBTranslationModule || segments.length === 0) {
    return segments.map(s => s.text);
  }

  const texts = segments.map(s => s.text.trim()).filter(Boolean);

  // The native module batches texts in a single TFLite call to amortise
  // per-call overhead and allow the NPU delegate to stay warm.
  const results: string[] = await NLLBTranslationModule.translateBatch(texts);
  return results;
}

/** Abort any pending translation batch. */
export function abortTranslation(): void {
  NLLBTranslationModule?.abort();
}
