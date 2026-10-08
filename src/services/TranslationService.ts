import {NativeModules} from 'react-native';
import type {WhisperSegment, GlossaryEntry} from '../types';
import {useGlossaryStore} from '../store/glossaryStore';

const {TranslatorModule} = NativeModules;

// Conservative character cap for a single segment's text, well under the
// translator's 512-token budget (TranslatorModule.kt's MAX_TOKENS) even
// after accounting for the instruction wrapper and glossary references —
// see the crash-prevention comment in translateSegments() below.
const MAX_SEGMENT_CHARS = 500;

if (!TranslatorModule) {
  console.warn(
    '[TranslationService] TranslatorModule not found — native build required.',
  );
}

/**
 * Initialise the on-device translator (call once at app startup).
 * modelPath: absolute path to the translator .task bundle on device
 * (currently Gemma3-1B-IT — see ModelManifest.ts).
 */
export async function initTranslation(modelPath: string): Promise<void> {
  if (!TranslatorModule) {
    return;
  }
  await TranslatorModule.init(modelPath);
}

function buildTranslationPrompt(
  text: string,
  glossary: GlossaryEntry[],
): string {
  let reference = '';
  if (glossary.length > 0) {
    const lines = glossary.map(e => {
      const gender =
        e.gender === 'm' ? ' (male)' : e.gender === 'f' ? ' (female)' : '';
      const note = e.category === 'phrase' ? ' — fixed phrase, keep as-is' : '';
      return `- "${e.term}" -> "${e.hebrew}"${gender}${note}`;
    });
    reference =
      '\n\nReference — use these exact renderings, and keep Hebrew grammatical ' +
      `gender consistent with the notes below:\n${lines.join('\n')}`;
  }
  return (
    'Translate the following English text to Hebrew. ' +
    'Respond with only the Hebrew translation, no explanation.' +
    reference +
    `\n\nText: ${text}\nTranslation:`
  );
}

/**
 * Translate an array of source segments into Hebrew.
 * Returns Hebrew strings in the same order as the input segments.
 *
 * For each segment, looks up glossary entries (names/places/fixed phrases
 * learned from earlier in this video — see glossaryStore.ts) whose term
 * appears in the segment, and includes them as in-prompt reference so the
 * model reuses the same Hebrew rendering and gender consistently. A
 * segment that is *exactly* a known fixed phrase (category 'phrase')
 * skips the model entirely and reuses the stored translation verbatim —
 * more reliable than hoping the model repeats its own earlier wording.
 */
export async function translateSegments(
  segments: WhisperSegment[],
): Promise<string[]> {
  if (!TranslatorModule || segments.length === 0) {
    return segments.map(s => s.text);
  }

  const {findRelevant} = useGlossaryStore.getState();
  const results: string[] = new Array(segments.length).fill('');
  const pending: Array<{index: number; prompt: string}> = [];

  segments.forEach((seg, i) => {
    let text = seg.text.trim();
    if (!text) {
      return;
    }

    // MediaPipe's native LLM engine doesn't fail gracefully when a prompt's
    // token count exceeds its configured maxTokens (512, see
    // TranslatorModule.kt) — confirmed on a real device as a native SIGSEGV
    // crashing the whole app, not a catchable JS/Kotlin exception. Whisper
    // can emit a pathologically long "segment" for a whole chunk (e.g.
    // runaway/repeating output when fed audio in a language its model
    // doesn't support — this app's whisper.cpp model is English-only, see
    // ModelManifest.ts) instead of several short ones, so cap segment
    // length defensively here rather than trust whatever Whisper returns.
    if (text.length > MAX_SEGMENT_CHARS) {
      console.warn(
        `[TranslationService] Segment ${i} is abnormally long ` +
          `(${text.length} chars) — truncating to avoid a native crash.`,
      );
      text = text.slice(0, MAX_SEGMENT_CHARS);
    }

    const relevant = findRelevant(text);
    const exactPhrase = relevant.find(
      e =>
        e.category === 'phrase' && e.term.toLowerCase() === text.toLowerCase(),
    );
    if (exactPhrase) {
      results[i] = exactPhrase.hebrew;
      return;
    }

    pending.push({index: i, prompt: buildTranslationPrompt(text, relevant)});
  });

  if (pending.length > 0) {
    const responses: string[] = await TranslatorModule.generateBatch(
      pending.map(p => p.prompt),
    );
    pending.forEach((p, j) => {
      results[p.index] = (responses[j] ?? '').trim();
    });
  }

  return results;
}

/** Abort any pending translation batch. */
export function abortTranslation(): void {
  TranslatorModule?.abort();
}
