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
import {initTranslation} from './services/TranslationService';
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
  const {meta, reset: resetVideo} = useVideoStore();

  useEffect(() => {
    checkModelsAndInit();
    // Intentionally run once on mount only — checkModelsAndInit reads
    // state via closures that are only meaningful on first launch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function checkModelsAndInit() {
    const m = await fetchManifest();
    setManifest(m);

    const [whisperOk, nllbOk, fontOk] = await Promise.all([
      isModelPresent(m.whisper),
      isModelPresent(m.nllb),
      isModelPresent(m.font),
    ]);

    if (!whisperOk || !nllbOk || !fontOk) {
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
      await initTranslation(modelPath(m.nllb));
    } catch (e) {
      console.error('[App] Model init error:', e);
    }
  }

  async function handleSetupComplete() {
    if (!manifest) {
      return;
    }
    await initModels(manifest);
    setUpdateKeys([]);
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
              <TouchableOpacity onPress={resetVideo} style={styles.topBtn}>
                <Text style={styles.topBtnText}>← Back</Text>
              </TouchableOpacity>

              <Text style={styles.videoTitle} numberOfLines={1}>
                {meta.displayName}
              </Text>

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
