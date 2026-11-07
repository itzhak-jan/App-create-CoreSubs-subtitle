import {create} from 'zustand';
import RNFS from 'react-native-fs';
import type {GlossaryEntry} from '../types';

/**
 * Running "translation memory" for the video currently loaded: names,
 * places and fixed phrases, so every subtitle renders them the same way.
 *
 * Sources, in order of authority:
 *   'user' — typed in the Names screen. Never overwritten automatically.
 *   'llm'  — extracted by the Gemma engine (can carry grammatical gender).
 *   'auto' — detected by GlossaryService's proper-noun heuristic.
 *
 * Once a term has a rendering, automatic sources never change it — that's
 * the whole point (a name that flips spelling mid-movie is the bug this
 * store exists to prevent). Automatic sources may only fill in missing
 * gender/category.
 *
 * Persisted per video (keyed by file name) so a re-watch, or a correction
 * the user made, carries over.
 */
interface GlossaryStore {
  /** Keyed by term.toLowerCase(). */
  entries: Map<string, GlossaryEntry>;
  videoKey: string | null;

  loadForVideo: (videoKey: string) => Promise<void>;
  upsertEntries: (entries: GlossaryEntry[]) => void;
  /** User correction — always wins. Returns the previous rendering, if any. */
  setUserEntry: (entry: GlossaryEntry) => string | undefined;
  removeEntry: (term: string) => void;
  /** Entries whose term occurs as a whole word in `text`, longest first. */
  findRelevant: (text: string) => GlossaryEntry[];
  reset: () => void;
}

const GLOSSARY_DIR = `${RNFS.DocumentDirectoryPath}/glossaries`;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

// Explicit ranges instead of \p{L}: Hermes' Unicode property-escape support
// is incomplete. Latin (+accents), Greek, Cyrillic, Hebrew, Arabic, digits.
const WORD_CHARS =
  'A-Za-z0-9\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF';
const CJK = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF]/;

function fileFor(videoKey: string): string {
  const safe = videoKey
    .replace(new RegExp(`[^${WORD_CHARS}._-]+`, 'g'), '_')
    .slice(0, 120);
  return `${GLOSSARY_DIR}/${safe}.json`;
}

async function saveNow(
  videoKey: string | null,
  entries: Map<string, GlossaryEntry>,
): Promise<void> {
  if (!videoKey) {
    return;
  }
  try {
    if (!(await RNFS.exists(GLOSSARY_DIR))) {
      await RNFS.mkdir(GLOSSARY_DIR);
    }
    await RNFS.writeFile(
      fileFor(videoKey),
      JSON.stringify(Array.from(entries.values())),
      'utf8',
    );
  } catch (e) {
    console.warn('[glossary] save failed —', String(e));
  }
}

function scheduleSave(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
  }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const {videoKey, entries} = useGlossaryStore.getState();
    saveNow(videoKey, entries);
  }, 1000);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whole-word, case-insensitive matcher for a term. Group 1 is the boundary
 * character before the term (or empty at start), group 2 the term itself —
 * no lookbehind, for Hermes compatibility. For scripts without spaces
 * between words (Japanese, Chinese) it's a plain substring match (group 1
 * always empty).
 */
export function termRegex(term: string, flags = 'i'): RegExp {
  const body = escapeRegex(term.trim());
  if (CJK.test(term)) {
    return new RegExp(`()(${body})`, flags);
  }
  return new RegExp(
    `(^|[^${WORD_CHARS}])(${body})(?=[^${WORD_CHARS}]|$)`,
    flags,
  );
}

/**
 * Matcher for a glossary entry. Names/places match case-sensitively, so a
 * character called "Will" doesn't hijack the verb "will"; fixed phrases
 * match case-insensitively.
 */
export function entryRegex(entry: GlossaryEntry, global = false): RegExp {
  const flags = (entry.category === 'phrase' ? 'i' : '') + (global ? 'g' : '');
  return termRegex(entry.term, flags);
}

export const useGlossaryStore = create<GlossaryStore>((set, get) => ({
  entries: new Map(),
  videoKey: null,

  loadForVideo: async videoKey => {
    get().reset(); // flushes any pending save for the previous video
    set({videoKey, entries: new Map()});
    try {
      const path = fileFor(videoKey);
      if (!(await RNFS.exists(path))) {
        return;
      }
      const list: unknown = JSON.parse(await RNFS.readFile(path, 'utf8'));
      if (!Array.isArray(list) || get().videoKey !== videoKey) {
        return;
      }
      const map = new Map<string, GlossaryEntry>();
      for (const e of list as GlossaryEntry[]) {
        if (typeof e?.term === 'string' && typeof e?.hebrew === 'string') {
          map.set(e.term.trim().toLowerCase(), e);
        }
      }
      set({entries: map});
    } catch (e) {
      console.warn('[glossary] load failed —', String(e));
    }
  },

  upsertEntries: newEntries =>
    set(state => {
      if (newEntries.length === 0) {
        return state;
      }
      const next = new Map(state.entries);
      let changed = false;
      for (const entry of newEntries) {
        const key = entry.term.trim().toLowerCase();
        if (!key || !entry.hebrew.trim()) {
          continue;
        }
        const existing = next.get(key);
        if (!existing) {
          next.set(key, {...entry, term: entry.term.trim()});
          changed = true;
          continue;
        }
        if (existing.origin === 'user') {
          continue;
        }
        // Keep the locked rendering; only fill in missing details.
        const merged: GlossaryEntry = {
          ...existing,
          gender: existing.gender ?? entry.gender,
          category: existing.category ?? entry.category,
        };
        if (
          merged.gender !== existing.gender ||
          merged.category !== existing.category
        ) {
          next.set(key, merged);
          changed = true;
        }
      }
      if (!changed) {
        return state;
      }
      scheduleSave();
      return {entries: next};
    }),

  setUserEntry: entry => {
    const key = entry.term.trim().toLowerCase();
    const previous = get().entries.get(key)?.hebrew;
    if (!key) {
      return previous;
    }
    set(state => {
      const next = new Map(state.entries);
      next.set(key, {...entry, term: entry.term.trim(), origin: 'user'});
      return {entries: next};
    });
    scheduleSave();
    return previous;
  },

  removeEntry: term => {
    set(state => {
      const next = new Map(state.entries);
      next.delete(term.trim().toLowerCase());
      return {entries: next};
    });
    scheduleSave();
  },

  findRelevant: text => {
    const result: GlossaryEntry[] = [];
    for (const entry of get().entries.values()) {
      if (entryRegex(entry).test(text)) {
        result.push(entry);
      }
    }
    // Longest first, so "Jon Snow" is matched before "Jon".
    return result.sort((a, b) => b.term.length - a.term.length);
  },

  reset: () => {
    if (saveTimer) {
      // Flush the pending write before forgetting this video.
      clearTimeout(saveTimer);
      saveTimer = null;
      saveNow(get().videoKey, get().entries);
    }
    set({entries: new Map(), videoKey: null});
  },
}));
