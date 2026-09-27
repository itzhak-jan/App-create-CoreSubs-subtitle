import {NativeModules} from 'react-native';
import type {GlossaryEntry, GlossaryCategory} from '../types';

const {TranslatorModule} = NativeModules;

export interface TranslatedPair {
  original: string;
  hebrew: string;
}

const VALID_CATEGORIES: GlossaryCategory[] = [
  'person',
  'place',
  'phrase',
  'other',
];

function buildExtractionPrompt(pairs: TranslatedPair[]): string {
  const lines = pairs
    .filter(p => p.original.trim() && p.hebrew.trim())
    .map((p, i) => `${i + 1}. EN: ${p.original}\n   HE: ${p.hebrew}`)
    .join('\n');

  return (
    'You are building a running glossary for consistent subtitle translation ' +
    'of a single video. Below are English sentences with their Hebrew ' +
    'translation. Identify proper names, places, or fixed phrases (like a ' +
    'password or magic word that should never be re-translated differently) ' +
    'that should be reused identically for the rest of the video.\n\n' +
    `${lines}\n\n` +
    'Respond with ONLY a JSON array, no other text. Each item: ' +
    '{"term": "<exact English term as it appears above>", ' +
    '"hebrew": "<the Hebrew rendering to reuse>", ' +
    '"gender": "m" | "f" | null (only for people), ' +
    '"category": "person" | "place" | "phrase" | "other"}. ' +
    'If nothing is worth remembering, respond with: []'
  );
}

/**
 * Extracts new glossary entries from a batch of (English, Hebrew) segment
 * pairs — typically one chunk's worth — via a single extra LLM call.
 * Never throws: on any failure (native module missing, malformed JSON,
 * whatever) it resolves to an empty array so callers can fire-and-forget
 * this without a catch block of their own.
 */
export async function extractGlossaryEntries(
  pairs: TranslatedPair[],
): Promise<GlossaryEntry[]> {
  if (!TranslatorModule || pairs.length === 0) {
    return [];
  }

  try {
    const prompt = buildExtractionPrompt(pairs);
    const [raw]: string[] = await TranslatorModule.generateBatch([prompt]);
    return parseGlossaryJson(raw ?? '');
  } catch (e) {
    console.warn('[GlossaryExtractor] extraction failed —', String(e));
    return [];
  }
}

function parseGlossaryJson(raw: string): GlossaryEntry[] {
  // LLMs occasionally wrap the array in prose despite instructions not to;
  // grab the first [...] block rather than requiring the whole response to
  // be pure JSON.
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) {
      return [];
    }

    const entries: GlossaryEntry[] = [];
    for (const item of parsed) {
      if (
        typeof item !== 'object' ||
        item === null ||
        typeof (item as {term?: unknown}).term !== 'string' ||
        typeof (item as {hebrew?: unknown}).hebrew !== 'string'
      ) {
        continue;
      }
      const term = (item as {term: string}).term.trim();
      const hebrew = (item as {hebrew: string}).hebrew.trim();
      if (!term || !hebrew) {
        continue;
      }
      const genderRaw = (item as {gender?: unknown}).gender;
      const categoryRaw = (item as {category?: unknown}).category;
      entries.push({
        term,
        hebrew,
        gender: genderRaw === 'm' || genderRaw === 'f' ? genderRaw : undefined,
        category: VALID_CATEGORIES.includes(categoryRaw as GlossaryCategory)
          ? (categoryRaw as GlossaryCategory)
          : undefined,
      });
    }
    return entries;
  } catch {
    return [];
  }
}
