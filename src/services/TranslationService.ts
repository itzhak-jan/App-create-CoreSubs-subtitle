import {NativeModules} from 'react-native';
import type {WhisperSegment, GlossaryEntry, TranslationEngine} from '../types';
import {useGlossaryStore, entryRegex} from '../store/glossaryStore';
import {getSettings} from '../store/settingsStore';

/**
 * Two interchangeable translation engines behind one API:
 *
 *  - 'mlkit' (default): Google ML Kit on-device MT. Milliseconds per line.
 *    It can't take instructions, so glossary consistency is enforced
 *    mechanically: known names/phrases are swapped for numeric placeholders
 *    before translation (MT engines copy numbers through untouched) and the
 *    locked rendering is put back afterwards. If a placeholder doesn't
 *    survive, that line is re-translated plainly — never worse than no
 *    glossary.
 *
 *  - 'llm': Gemma via MediaPipe. Slower, but follows glossary hints
 *    including grammatical gender. Lines are translated in batches (one
 *    model call per ~8 lines instead of one per line).
 */

const {TranslatorModule, MlKitTranslator} = NativeModules;

if (!MlKitTranslator) {
  console.warn(
    '[TranslationService] MlKitTranslator not found — native build required.',
  );
}

const LANGUAGE_NAMES: Record<string, string> = {
  he: 'Hebrew',
  en: 'English',
  ar: 'Arabic',
  ru: 'Russian',
  fr: 'French',
  es: 'Spanish',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  ja: 'Japanese',
  zh: 'Chinese',
  ko: 'Korean',
};

export function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code;
}

let llmReady = false;

/**
 * Initialise the LLM engine (only needed when settings.engine === 'llm').
 * modelPath: absolute path to the Gemma .task bundle on device.
 */
export async function initTranslation(modelPath: string): Promise<void> {
  if (!TranslatorModule) {
    return;
  }
  await TranslatorModule.init(modelPath);
  llmReady = true;
}

export function isLlmReady(): boolean {
  return llmReady;
}

/** Pre-downloads ML Kit's language pack for src→tgt (no-op for the LLM). */
export async function prepareTranslation(
  src: string,
  tgt: string,
): Promise<void> {
  if (getSettings().engine !== 'mlkit' || !MlKitTranslator || src === 'auto') {
    return;
  }
  try {
    await MlKitTranslator.prepare(src, tgt);
  } catch (e) {
    console.warn(
      '[TranslationService] language pack prepare failed —',
      String(e),
    );
  }
}

function activeEngine(): TranslationEngine {
  const {engine} = getSettings();
  // Fall back to ML Kit if the LLM was selected but never initialised.
  if (engine === 'llm' && !llmReady) {
    return 'mlkit';
  }
  return engine;
}

/**
 * Translate segments from `src` into the target language from settings.
 * Returns strings in the same order as the input.
 */
export async function translateSegments(
  segments: WhisperSegment[],
  src: string,
): Promise<string[]> {
  const {targetLang} = getSettings();
  const texts = segments.map(s => s.text.trim());
  if (texts.length === 0) {
    return [];
  }

  const {findRelevant} = useGlossaryStore.getState();
  const results: string[] = new Array(texts.length).fill('');
  const todo: number[] = [];

  texts.forEach((text, i) => {
    if (!text) {
      return;
    }
    // A line that IS a known fixed phrase reuses its stored rendering.
    const exact = findRelevant(text).find(
      e =>
        e.category === 'phrase' && e.term.toLowerCase() === text.toLowerCase(),
    );
    if (exact) {
      results[i] = exact.hebrew;
    } else {
      todo.push(i);
    }
  });

  if (todo.length === 0) {
    return results;
  }

  const lines = todo.map(i => texts[i]);
  const translated =
    activeEngine() === 'llm'
      ? await translateWithLlm(lines, src, targetLang)
      : await translateWithMlKit(lines, src, targetLang);

  todo.forEach((idx, j) => {
    results[idx] = (translated[j] ?? '').trim() || texts[idx];
  });
  return results;
}

// ─── ML Kit + placeholder locking ────────────────────────────────────────────

interface Protected {
  text: string;
  slots: Array<{token: string; rendering: string; count: number}>;
}

const PLACEHOLDER_BASE = 7301;

/** Replaces glossary terms with numeric placeholders. */
export function protectTerms(
  text: string,
  entries: GlossaryEntry[],
): Protected {
  let out = text;
  const slots: Protected['slots'] = [];
  let n = PLACEHOLDER_BASE;
  for (const entry of entries) {
    let token = String(n++);
    while (text.includes(token)) {
      token = String(n++);
    }
    let count = 0;
    out = out.replace(entryRegex(entry, true), (_m, pre: string) => {
      count++;
      return `${pre}${token}`;
    });
    if (count > 0) {
      slots.push({token, rendering: entry.hebrew, count});
    }
  }
  return {text: out, slots};
}

/** Puts locked renderings back. Returns null if any placeholder was lost
 *  or mangled by the MT engine. */
export function restoreTerms(translated: string, p: Protected): string | null {
  let out = translated;
  for (const slot of p.slots) {
    const found = out.split(slot.token).length - 1;
    if (found !== slot.count) {
      return null;
    }
    out = out.split(slot.token).join(slot.rendering);
  }
  return out;
}

async function mlkitTranslate(
  texts: string[],
  src: string,
  tgt: string,
): Promise<string[]> {
  if (!MlKitTranslator) {
    return texts;
  }
  return MlKitTranslator.translateBatch(texts, src, tgt);
}

async function translateWithMlKit(
  lines: string[],
  src: string,
  tgt: string,
): Promise<string[]> {
  const {findRelevant} = useGlossaryStore.getState();
  const prepared = lines.map(line => protectTerms(line, findRelevant(line)));
  const out = await mlkitTranslate(
    prepared.map(p => p.text),
    src,
    tgt,
  );

  const results: string[] = [];
  const retry: number[] = [];
  prepared.forEach((p, i) => {
    const raw = out[i] ?? '';
    const restored = p.slots.length ? restoreTerms(raw, p) : raw;
    if (restored === null) {
      retry.push(i);
      results.push('');
    } else {
      results.push(restored);
    }
  });

  if (retry.length > 0) {
    const plain = await mlkitTranslate(
      retry.map(i => lines[i]),
      src,
      tgt,
    );
    retry.forEach((i, j) => {
      results[i] = plain[j] ?? lines[i];
    });
  }
  return results;
}

// ─── LLM (batched) ───────────────────────────────────────────────────────────

const LLM_BATCH = 8;

function glossaryHint(entries: GlossaryEntry[]): string {
  if (entries.length === 0) {
    return '';
  }
  const lines = entries.map(e => {
    const gender =
      e.gender === 'm' ? ' (male)' : e.gender === 'f' ? ' (female)' : '';
    const note = e.category === 'phrase' ? ' — fixed phrase, keep as-is' : '';
    return `- "${e.term}" -> "${e.hebrew}"${gender}${note}`;
  });
  return (
    '\n\nAlways use these exact renderings, and keep grammatical gender ' +
    `consistent with the notes:\n${lines.join('\n')}`
  );
}

function buildBatchPrompt(lines: string[], src: string, tgt: string): string {
  const {findRelevant} = useGlossaryStore.getState();
  const seen = new Map<string, GlossaryEntry>();
  for (const line of lines) {
    for (const e of findRelevant(line)) {
      seen.set(e.term.toLowerCase(), e);
    }
  }
  const numbered = lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
  return (
    `Translate these ${lines.length} subtitle lines from ${languageName(
      src,
    )} ` +
    `to ${languageName(tgt)}. They are consecutive lines of the same scene. ` +
    `Reply with exactly ${lines.length} lines, each as "<number>. <translation>", ` +
    'and nothing else.' +
    glossaryHint(Array.from(seen.values())) +
    `\n\n${numbered}`
  );
}

export function parseNumbered(
  raw: string,
  expected: number,
): Array<string | undefined> {
  const out: Array<string | undefined> = new Array(expected).fill(undefined);
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(\d+)\s*[.)\-:]\s*(.*)$/);
    if (!m) {
      continue;
    }
    const idx = Number(m[1]) - 1;
    if (idx >= 0 && idx < expected && out[idx] === undefined && m[2].trim()) {
      out[idx] = m[2].trim();
    }
  }
  return out;
}

async function translateWithLlm(
  lines: string[],
  src: string,
  tgt: string,
): Promise<string[]> {
  if (!TranslatorModule) {
    return lines;
  }
  const results: string[] = new Array(lines.length).fill('');
  const batches: number[][] = [];
  for (let i = 0; i < lines.length; i += LLM_BATCH) {
    batches.push(lines.slice(i, i + LLM_BATCH).map((_, j) => i + j));
  }

  const prompts = batches.map(b =>
    buildBatchPrompt(
      b.map(i => lines[i]),
      src,
      tgt,
    ),
  );
  const responses: string[] = await TranslatorModule.generateBatch(prompts);

  const missing: number[] = [];
  batches.forEach((b, bi) => {
    const parsed = parseNumbered(responses[bi] ?? '', b.length);
    b.forEach((lineIdx, j) => {
      if (parsed[j]) {
        results[lineIdx] = parsed[j] as string;
      } else {
        missing.push(lineIdx);
      }
    });
  });

  // Lines the model skipped or mis-numbered: translate one by one.
  if (missing.length > 0) {
    const single: string[] = await TranslatorModule.generateBatch(
      missing.map(i => buildBatchPrompt([lines[i]], src, tgt)),
    );
    missing.forEach((lineIdx, j) => {
      results[lineIdx] =
        parseNumbered(single[j] ?? '', 1)[0] ?? (single[j] ?? '').trim();
    });
  }
  return results;
}

// ─── Rendering a single name for the glossary ────────────────────────────────

/** Carrier sentences make MT treat the term as a name (transliterate it)
 *  instead of translating its words — "My name is Jon Snow", not "snow". */
const CARRIERS: Record<string, string> = {
  en: 'My name is {X}.',
  fr: "Je m'appelle {X}.",
  es: 'Me llamo {X}.',
  de: 'Ich heiße {X}.',
  it: 'Mi chiamo {X}.',
  pt: 'Meu nome é {X}.',
  ru: 'Меня зовут {X}.',
};
const templateCache = new Map<
  string,
  {prefix: string; suffix: string} | null
>();

async function carrierTemplate(src: string, tgt: string) {
  const key = `${src}>${tgt}`;
  if (templateCache.has(key)) {
    return templateCache.get(key) ?? null;
  }
  const carrier = CARRIERS[src];
  let tmpl: {prefix: string; suffix: string} | null = null;
  if (carrier) {
    const [out] = await mlkitTranslate(
      [carrier.replace('{X}', '7301')],
      src,
      tgt,
    );
    const parts = (out ?? '').split('7301');
    if (parts.length === 2) {
      tmpl = {prefix: parts[0], suffix: parts[1]};
    }
  }
  templateCache.set(key, tmpl);
  return tmpl;
}

const stripPunct = (s: string) =>
  s.trim().replace(/^[\s"'“”«».,!?:;-]+|[\s"'“”«».,!?:;-]+$/g, '');

/** Produces the target-language rendering for a name/place to lock in the glossary. */
export async function renderTerm(term: string, src: string): Promise<string> {
  const {targetLang} = getSettings();
  if (src === targetLang) {
    return term;
  }

  if (activeEngine() === 'llm') {
    const [raw] = await TranslatorModule.generateBatch([
      `How is the proper name "${term}" written in ${languageName(
        targetLang,
      )} ` +
        'subtitles? Transliterate it; do not translate its meaning. ' +
        'Reply with only the name.',
    ]);
    return stripPunct((raw ?? '').split('\n')[0] ?? '');
  }

  const tmpl = await carrierTemplate(src, targetLang);
  if (tmpl) {
    const [out] = await mlkitTranslate(
      [CARRIERS[src].replace('{X}', term)],
      src,
      targetLang,
    );
    if (out && out.startsWith(tmpl.prefix) && out.endsWith(tmpl.suffix)) {
      const name = stripPunct(
        out.slice(tmpl.prefix.length, out.length - tmpl.suffix.length),
      );
      if (name && name.length <= term.length * 3 + 10) {
        return name;
      }
    }
  }
  const [plain] = await mlkitTranslate([term], src, targetLang);
  return stripPunct(plain ?? '');
}

/** Abort any pending translation batch. */
export function abortTranslation(): void {
  TranslatorModule?.abort();
  MlKitTranslator?.abort();
}

/** Clears per-language caches (call when target language changes). */
export function resetTranslationCaches(): void {
  templateCache.clear();
}
