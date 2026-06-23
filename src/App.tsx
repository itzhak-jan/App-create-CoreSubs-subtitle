import React, {useEffect, useState} from 'react';
import {SafeAreaView, StyleSheet, TouchableOpacity, Text, View} from 'react-native';
import {GestureHandlerRootView} from 'react-native-gesture-handler';
import {useVideoStore} from './store/videoStore';
import {FilePicker} from './components/FilePicker/FilePicker';
import {VideoPlayer} from './components/VideoPlayer/VideoPlayer';
import {ExportModal} from './components/ExportModal/ExportModal';
import {ModelSetupScreen} from './components/ModelSetup/ModelSetupScreen';
import {enableRTL} from './utils/rtlUtils';
import {initWhisper} from './services/STTService';
import {initTranslation} from './services/TranslationService';
import {
  isModelPresent,
  WHISPER_MODEL,
  NLLB_MODEL,
  modelPath,
} from './services/ModelSetupService';

enableRTL();

type AppPhase = 'checking' | 'setup' | 'ready';

export default function App(): React.JSX.Element {
  const [appPhase, setAppPhase] = useState<AppPhase>('checking');
  const [exportVisible, setExportVisible] = useState(false);
  const {meta, reset: resetVideo} = useVideoStore();

  useEffect(() => {
    checkModelsAndInit();
  }, []);

  async function checkModelsAndInit() {
    const whisperOk = await isModelPresent(WHISPER_MODEL);
    const nllbOk = await isModelPresent(NLLB_MODEL);

    if (!whisperOk || !nllbOk) {
      setAppPhase('setup');
      return;
    }

    await initModels();
    setAppPhase('ready');
  }

  async function initModels() {
    try {
      await initWhisper(modelPath(WHISPER_MODEL));
      await initTranslation(modelPath(NLLB_MODEL));
    } catch (e) {
      console.error('[App] Model init error:', e);
    }
  }

  async function handleSetupComplete() {
    await initModels();
    setAppPhase('ready');
  }

  if (appPhase === 'checking') {
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
          <ModelSetupScreen onComplete={handleSetupComplete} />
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
            <VideoPlayer onRequestExport={() => setExportVisible(true)} />

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
});
