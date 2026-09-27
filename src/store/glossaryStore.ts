import {create} from 'zustand';
import type {GlossaryEntry} from '../types';

/**
 * Running "translation memory" for the video currently loaded: names,
 * places and fixed phrases the app has learned so far, so later segments
 * translate them consistently (including grammatical gender agreement in
 * Hebrew, which English doesn't mark on names/pronouns the same way).
 *
 * Populated asynchronously by GlossaryExtractor after each chunk finishes
 * translating (see JITProcessor.ts) — never blocks the real-time pipeline.
 * Reset when a new video is loaded (JITProcessor.reset()), not on seek —
 * entries are facts about the video's content, not the playhead position.
 */
interface GlossaryStore {
  /** Keyed by term.toLowerCase() for case-insensitive lookups. */
  entries: Map<string, GlossaryEntry>;
  upsertEntries: (entries: GlossaryEntry[]) => void;
  /** Entries whose term appears (case-insensitive substring) in `text`. */
  findRelevant: (text: string) => GlossaryEntry[];
  reset: () => void;
}

export const useGlossaryStore = create<GlossaryStore>((set, get) => ({
  entries: new Map(),

  upsertEntries: newEntries =>
    set(state => {
      if (newEntries.length === 0) {
        return state;
      }
      const next = new Map(state.entries);
      for (const entry of newEntries) {
        const key = entry.term.trim().toLowerCase();
        if (!key) {
          continue;
        }
        next.set(key, entry);
      }
      return {entries: next};
    }),

  findRelevant: text => {
    const lower = text.toLowerCase();
    const result: GlossaryEntry[] = [];
    for (const entry of get().entries.values()) {
      if (lower.includes(entry.term.toLowerCase())) {
        result.push(entry);
      }
    }
    return result;
  },

  reset: () => set({entries: new Map()}),
}));
