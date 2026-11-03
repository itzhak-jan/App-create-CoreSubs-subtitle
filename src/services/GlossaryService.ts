/**
 * GlossaryService — finds recurring proper names in the transcript and
 * locks one rendering for each, *before* the chunk that contains them is
 * translated. Works with both engines and needs no LLM.
 *
 * Detection is a heuristic over languages that capitalise names (Latin and
 * Cyrillic scripts): a run of Capitalised words that isn't at the start of
 * a sentence is a name candidate. A candidate seen twice gets locked. For
 * languages without capitalisation (Arabic, Japanese…) only user entries
 * and — with the LLM engine — LLM-extracted entries apply.
 *
 * The rendering itself comes from TranslationService.renderTerm. When it's
 * wrong (e.g. a name that is also a common word), the user fixes it once in
 * the Names screen and every later subtitle — and the ones already shown —
 * follow.
 */

import type {WhisperSegment} from '../types';
import {useGlossaryStore} from '../store/glossaryStore';
import {renderTerm} from './TranslationService';

const CAPITALISING_LANGS = new Set([
  'en',
  'fr',
  'es',
  'de',
  'it',
  'pt',
  'nl',
  'ru',
  'uk',
  'pl',
]);
const MIN_SIGHTINGS = 2;
const MAX_LOCKS_PER_CHUNK = 6;

const STOPWORDS = new Set([
  'i',
  "i'm",
  "i'll",
  "i've",
  "i'd",
  'ok',
  'okay',
  'oh',
  'hey',
  'yes',
  'no',
  'mr',
  'mrs',
  'ms',
  'dr',
  'sir',
  'madam',
  'mister',
  'miss',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
  'god',
  'tv',
  'usa',
  'uk',
]);

const WORD = /[A-Za-zÀ-ɏЀ-ӿ][A-Za-zÀ-ɏЀ-ӿ'’-]*/g;
const UPPER = /^[A-ZÀ-ÞЀ-Я]/;

interface Sighting {
  term: string;
  /** Seen capitalised mid-sentence — real evidence it's a name. */
  mid: number;
  /** Seen only as a capitalised first word — weak evidence. */
  start: number;
}

const sightings = new Map<string, Sighting>();
/** Words seen in lowercase mid-sentence: those are ordinary words. */
const lowercaseWords = new Set<string>();
const pending = new Set<string>();

export function resetGlossaryDetection(): void {
  sightings.clear();
  lowercaseWords.clear();
  pending.clear();
}

function stripPossessive(w: string): string {
  return w.replace(/['’]s$/i, '');
}

export interface Candidate {
  term: string;
  atSentenceStart: boolean;
}

/**
 * Extracts name candidates from one line of transcript, plus the lowercase
 * words seen (to rule out ordinary words). Exported for tests.
 */
export function findCandidates(
  text: string,
  lowercaseSink?: Set<string>,
): Candidate[] {
  // Abbreviations shouldn't end a sentence ("Mr. Smith" → Smith is mid-sentence).
  const clean = text.replace(/\b(Mr|Mrs|Ms|Dr|St|Jr|Sr)\./g, '$1');
  const sentences = clean.split(/[.!?…]+\s*|\s+-\s+|^-\s*/);
  const out: Candidate[] = [];

  for (const sentence of sentences) {
    const words = sentence.match(WORD) ?? [];
    let run: string[] = [];
    let runStartsSentence = false;

    const flush = () => {
      if (run.length > 0) {
        const term = run
          .map((w, i) => (i === run.length - 1 ? stripPossessive(w) : w))
          .join(' ');
        if (term.length >= 2 && term.length <= 40) {
          // A multi-word run ("Jon Snow left") is good evidence even at the
          // start of a sentence; a lone capitalised first word is not.
          out.push({
            term,
            atSentenceStart: runStartsSentence && run.length === 1,
          });
        }
      }
      run = [];
    };

    const isName = (w: string | undefined) =>
      !!w && UPPER.test(w) && !STOPWORDS.has(stripPossessive(w).toLowerCase());

    words.forEach((w, i) => {
      if (isName(w)) {
        if (run.length === 0) {
          runStartsSentence = i === 0;
        }
        run.push(w);
        // A possessive ends the name ("Jon's sword") unless the name goes
        // on ("King's Landing").
        if (/['’]s$/i.test(w) && !isName(words[i + 1])) {
          flush();
        }
      } else {
        if (i > 0 && !UPPER.test(w)) {
          lowercaseSink?.add(stripPossessive(w).toLowerCase());
        }
        flush();
      }
    });
    flush();
  }
  return out;
}

/** Records sightings from a freshly transcribed chunk. Cheap; call from the STT stage. */
export function observeSegments(
  segments: WhisperSegment[],
  lang: string,
): void {
  if (!CAPITALISING_LANGS.has(lang)) {
    return;
  }
  const {entries} = useGlossaryStore.getState();
  const touched = new Set<string>();
  for (const seg of segments) {
    for (const c of findCandidates(seg.text, lowercaseWords)) {
      const key = c.term.toLowerCase();
      if (entries.has(key)) {
        continue;
      }
      const s = sightings.get(key) ?? {term: c.term, mid: 0, start: 0};
      if (c.atSentenceStart) {
        s.start++;
      } else {
        s.mid++;
      }
      sightings.set(key, s);
      touched.add(key);
    }
  }
  for (const key of touched) {
    const s = sightings.get(key)!;
    const ordinaryWord = !key.includes(' ') && lowercaseWords.has(key);
    if (!ordinaryWord && s.mid >= 1 && s.mid + s.start >= MIN_SIGHTINGS) {
      pending.add(s.term);
    }
  }
}

/**
 * Locks renderings for names that crossed the sighting threshold. Call from
 * the translation stage right before translating a chunk, so the chunk
 * already uses them. Bounded per call to keep latency predictable.
 */
export async function lockPendingTerms(src: string): Promise<void> {
  if (pending.size === 0) {
    return;
  }
  const {entries, upsertEntries} = useGlossaryStore.getState();
  const batch = Array.from(pending).slice(0, MAX_LOCKS_PER_CHUNK);
  const locked = [];
  for (const term of batch) {
    pending.delete(term);
    if (entries.has(term.toLowerCase())) {
      continue;
    }
    try {
      const rendering = await renderTerm(term, src);
      if (rendering) {
        locked.push({term, hebrew: rendering, origin: 'auto' as const});
      }
    } catch (e) {
      console.warn('[glossary] could not render', term, String(e));
    }
  }
  upsertEntries(locked);
}
