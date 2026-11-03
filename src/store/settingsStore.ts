import {create} from 'zustand';
import RNFS from 'react-native-fs';
import type {AppSettings} from '../types';
import {DEFAULT_SETTINGS} from '../types';

const SETTINGS_PATH = `${RNFS.DocumentDirectoryPath}/settings.json`;

interface SettingsStore extends AppSettings {
  loaded: boolean;
  load: () => Promise<void>;
  update: (partial: Partial<AppSettings>) => Promise<void>;
}

/**
 * User settings (translation engine, target/source language), persisted to
 * a small JSON file so they survive restarts.
 */
export const useSettingsStore = create<SettingsStore>((set, get) => ({
  ...DEFAULT_SETTINGS,
  loaded: false,

  load: async () => {
    try {
      if (await RNFS.exists(SETTINGS_PATH)) {
        const raw = JSON.parse(await RNFS.readFile(SETTINGS_PATH, 'utf8'));
        set({...DEFAULT_SETTINGS, ...pickSettings(raw), loaded: true});
        return;
      }
    } catch (e) {
      console.warn('[settings] failed to load, using defaults —', String(e));
    }
    set({loaded: true});
  },

  update: async partial => {
    set(partial);
    const {engine, targetLang, sourceLang} = get();
    try {
      await RNFS.writeFile(
        SETTINGS_PATH,
        JSON.stringify({engine, targetLang, sourceLang}),
        'utf8',
      );
    } catch (e) {
      console.warn('[settings] failed to save —', String(e));
    }
  },
}));

function pickSettings(raw: unknown): Partial<AppSettings> {
  if (typeof raw !== 'object' || raw === null) {
    return {};
  }
  const r = raw as Record<string, unknown>;
  const out: Partial<AppSettings> = {};
  if (r.engine === 'mlkit' || r.engine === 'llm') {
    out.engine = r.engine;
  }
  if (typeof r.targetLang === 'string' && r.targetLang) {
    out.targetLang = r.targetLang;
  }
  if (typeof r.sourceLang === 'string' && r.sourceLang) {
    out.sourceLang = r.sourceLang;
  }
  return out;
}

export function getSettings(): AppSettings {
  const {engine, targetLang, sourceLang} = useSettingsStore.getState();
  return {engine, targetLang, sourceLang};
}

/** Languages offered in the settings UI. All are supported by ML Kit
 *  on-device translation and by multilingual whisper. */
export const LANGUAGES: Array<{code: string; label: string}> = [
  {code: 'he', label: 'עברית'},
  {code: 'en', label: 'English'},
  {code: 'ar', label: 'العربية'},
  {code: 'ru', label: 'Русский'},
  {code: 'fr', label: 'Français'},
  {code: 'es', label: 'Español'},
  {code: 'de', label: 'Deutsch'},
  {code: 'ja', label: '日本語'},
  {code: 'zh', label: '中文'},
];
