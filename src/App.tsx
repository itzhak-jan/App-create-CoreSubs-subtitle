import React, {useEffect, useState} from 'react';
import {
  SafeAreaView,
  StyleSheet,
  TouchableOpacity,
  Text,
  View,
} from 'react-native';
import {GestureHandlerRootView} from 'react-native-gesture-handler';
import {useVideoStore} from './store/videoStore';
import {FilePicker} from './components/FilePicker/FilePicker';
import {VideoPlayer} from './components/VideoPlayer/VideoPlayer';
import {ExportModal} from './components/ExportModal/ExportModal';
import {ModelSetupScreen} from './components/ModelSetup/ModelSetupScreen';
import {initWhisper} from './services/STTService';
import {jitProcessor} from './services/JITProcessor';
import {
  initTranslation,
  isLlmReady,
  resetTranslationCaches,
} from './services/TranslationService';
import {useSettingsStore} from './store/settingsStore';
import {SettingsModal} from './components/SettingsModal/SettingsModal';
import {GlossaryModal} from './components/GlossaryModal/GlossaryModal';
import type {AppSettings} from './types';
import {
  isModelPresent,
  checkForUpdates,
  modelPath,
} from './services/ModelSetupService';
import {
  fetchManifest,
  type ModelManifest,
  type ManifestKey,
} from './services/ModelManifest';

// Deliberately NOT calling I18nManager.forceRTL() here: that mirrors the
// entire app layout (every screen, every absolutely-positioned control),
// not just Hebrew text. This app's UI is English/LTR; only the Hebrew
// subtitle overlay needs RTL treatment, which it already gets locally via
// `hebrewTextStyle` (writingDirection/textAlign) in rtlUtils.ts — no global
// layout flip (and the disruptive forced reload that comes with it) needed.

type AppPhase = 'checking' | 'setup' | 'ready';

export default function App(): React.JSX.Element {
  const [appPhase, setAppPhase] = useState<AppPhase>('checking');
  const [exportVisible, setExportVisible] = useState(false);
  const [manifest, setManifest] = useState<ModelManifest | null>(null);
  const [updateKeys, setUpdateKeys] = useState<ManifestKey[]>([]);
  const [updateModalVisible, setUpdateModalVisible] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [glossaryVisible, setGlossaryVisible] = useState(false);
  const [setupKeys, setSetupKeys] = useState<ManifestKey[]>([]);
  const {meta, reset: resetVideo} = useVideoStore();

  useEffect(() => {
    checkModelsAndInit();
    // Intentionally run once on mount only — checkModelsAndInit reads
    // state via closures that are only meaningful on first launch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** The Gemma bundle is only required for the optional 'llm' engine. */
  function requiredKeys(): ManifestKey[] {
    return useSettingsStore.getState().engine === 'llm'
      ? ['whisper', 'translator', 'font']
      : ['whisper', 'font'];
  }

  async function checkModelsAndInit() {
    await useSettingsStore.getState().load();
    const m = await fetchManifest();
    setManifest(m);

    const keys = requiredKeys();
    const present = await Promise.all(keys.map(k => isModelPresent(m[k])));
    const missing = keys.filter((_, i) => !present[i]);
    if (missing.length > 0) {
      setSetupKeys(missing);
      setAppPhase('setup');
      return;
    }

    // All assets present — check whether a newer version is available for
    // any of them (edited models-manifest.json since last launch). This
    // never blocks startup; it just surfaces a dismissible banner once ready.
    setUpdateKeys(await checkForUpdates(m));

    await initModels(m);
    setAppPhase('ready');
  }

  async function initModels(m: ModelManifest) {
    try {
      await initWhisper(modelPath(m.whisper));
    } catch (e) {
      console.error('[App] Whisper init error:', e);
    }
    await initLlmIfNeeded(m);
  }

  async function initLlmIfNeeded(m: ModelManifest) {
    if (useSettingsStore.getState().engine !== 'llm') {
      return;
    }
    try {
      if (await isModelPresent(m.translator)) {
        await initTranslation(modelPath(m.translator));
      }
    } catch (e) {
      console.error('[App] Translator init error:', e);
    }
  }

  async function handleSettingsChanged(prev: AppSettings, next: AppSettings) {
    if (
      next.targetLang !== prev.targetLang ||
      next.sourceLang !== prev.sourceLang
    ) {
      resetTranslationCaches();
    }
    if (next.engine === 'llm' && !isLlmReady() && manifest) {
      if (!(await isModelPresent(manifest.translator))) {
        // Download the Gemma bundle first; the player resumes afterwards.
        setSettingsVisible(false);
        setSetupKeys(['translator']);
        setAppPhase('setup');
        return;
      }
      await initLlmIfNeeded(manifest);
    }
    // Re-run subtitles from the current position with the new settings.
    jitProcessor.restart();
  }

  async function handleSetupComplete() {
    if (!manifest) {
      return;
    }
    await initModels(manifest);
    setUpdateKeys([]);
    setSetupKeys([]);
    setAppPhase('ready');
  }

  async function handleUpdateComplete() {
    if (!manifest) {
      return;
    }
    await initModels(manifest);
    setUpdateKeys([]);
    setUpdateModalVisible(false);
  }

  if (appPhase === 'checking' || !manifest) {
    return (
      <GestureHandlerRootView style={styles.root}>
        <View style={styles.root} />
      </GestureHandlerRootView>
    );
  }

  if (appPhase === 'setup') {
    return (
      <GestureHandlerRootView style={styles.root}>
        <SafeAreaView style={styles.root}>
          <ModelSetupScreen
            manifest={manifest}
            requiredKeys={setupKeys.length ? setupKeys : undefined}
            onComplete={handleSetupComplete}
          />
        </SafeAreaView>
      </GestureHandlerRootView>
    );
  }

  if (updateModalVisible) {
    return (
      <GestureHandlerRootView style={styles.root}>
        <SafeAreaView style={styles.root}>
          <ModelSetupScreen
            manifest={manifest}
            onlyKeys={updateKeys}
            onComplete={handleUpdateComplete}
          />
        </SafeAreaView>
      </GestureHandlerRootView>
    );
  }

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaView style={styles.root}>
        {!meta ? (
          <FilePicker />
        ) : (
          <View style={styles.root}>
            <VideoPlayer />

            <View style={styles.topBar}>
              <TouchableOpacity
                onPress={() => {
                  jitProcessor.reset();
                  resetVideo();
                }}
                style={styles.topBtn}>
                <Text style={styles.topBtnText}>← Back</Text>
              </TouchableOpacity>

              <Text style={styles.videoTitle} numberOfLines={1}>
                {meta.displayName}
              </Text>

              <TouchableOpacity
                onPress={() => setGlossaryVisible(true)}
                style={styles.topBtn}>
                <Text style={styles.topBtnText}>Names</Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => setSettingsVisible(true)}
                style={styles.topBtn}>
                <Text style={styles.topBtnText}>⚙</Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => setExportVisible(true)}
                style={styles.topBtn}>
                <Text style={styles.topBtnText}>Export</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {updateKeys.length > 0 && (
          <View style={styles.updateBanner}>
            <Text style={styles.updateBannerText}>
              {updateKeys.length === 1
                ? 'A newer AI model is available.'
                : `${updateKeys.length} newer AI models are available.`}
            </Text>
            <View style={styles.updateBannerActions}>
              <TouchableOpacity onPress={() => setUpdateKeys([])}>
                <Text style={styles.updateBannerDismiss}>Dismiss</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setUpdateModalVisible(true)}>
                <Text style={styles.updateBannerAction}>Update</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        <ExportModal
          visible={exportVisible}
          onClose={() => setExportVisible(false)}
        />

        <SettingsModal
          visible={settingsVisible}
          onClose={() => setSettingsVisible(false)}
          onChanged={handleSettingsChanged}
        />

        <GlossaryModal
          visible={glossaryVisible}
          onClose={() => setGlossaryVisible(false)}
        />
      </SafeAreaView>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000',
  },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  topBtn: {paddingVertical: 6, paddingHorizontal: 10},
  topBtnText: {color: '#FFD700', fontWeight: '600', fontSize: 14},
  videoTitle: {
    flex: 1,
    textAlign: 'center',
    color: '#FFF',
    fontSize: 13,
    marginHorizontal: 8,
  },
  updateBanner: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: 'rgba(20,20,20,0.92)',
  },
  updateBannerText: {color: '#FFF', fontSize: 13, flex: 1, marginRight: 12},
  updateBannerActions: {flexDirection: 'row', gap: 16},
  updateBannerDismiss: {color: '#888', fontWeight: '600', fontSize: 13},
  updateBannerAction: {color: '#FFD700', fontWeight: '700', fontSize: 13},
});
