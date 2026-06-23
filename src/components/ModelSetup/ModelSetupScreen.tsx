/**
 * ModelSetupScreen — first-launch onboarding screen.
 *
 * Downloads all three runtime assets to DocumentDirectory:
 *   1. ggml-base.en.bin      — Whisper STT model  (~148 MB)
 *   2. nllb-200-…int8.tflite — NLLB translation    (~310 MB)
 *   3. Rubik-Regular.ttf     — Hebrew font for export (~140 KB)
 *
 * None of these are bundled in the APK. Downloading at runtime keeps the
 * repository and CI artefacts lightweight. The screen is shown exactly once;
 * App.tsx checks asset presence on every launch and skips setup if all three
 * files are already present and correctly sized.
 */
import React, {useState, useCallback} from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
} from 'react-native';
import {
  WHISPER_MODEL,
  NLLB_MODEL,
  RUBIK_FONT,
  downloadModel,
  isModelPresent,
  type ModelInfo,
} from '../../services/ModelSetupService';

type DownloadPhase =
  | 'idle'
  | 'downloading_whisper'
  | 'downloading_nllb'
  | 'downloading_font'
  | 'done'
  | 'error';

interface AssetProgress {
  bytes: number;
  total: number;
}

interface ModelSetupScreenProps {
  onComplete: () => void;
}

function ProgressBar({ratio}: {ratio: number}): React.JSX.Element {
  return (
    <View style={styles.progressTrack}>
      <View
        style={[
          styles.progressFill,
          {width: `${Math.min(100, ratio * 100)}%`},
        ]}
      />
    </View>
  );
}

function AssetRow({
  label,
  description,
  progress,
  active,
}: {
  label: string;
  description: string;
  progress: AssetProgress;
  active: boolean;
}): React.JSX.Element {
  const ratio = progress.total > 0 ? progress.bytes / progress.total : 0;
  const done = ratio >= 0.999;

  return (
    <View style={styles.assetRow}>
      <View style={styles.assetHeader}>
        <Text style={styles.assetLabel}>{label}</Text>
        {done && <Text style={styles.checkmark}>✓</Text>}
        {active && !done && <Text style={styles.activeLabel}>Downloading…</Text>}
      </View>
      <Text style={styles.assetDesc}>{description}</Text>
      <ProgressBar ratio={ratio} />
    </View>
  );
}

export function ModelSetupScreen({onComplete}: ModelSetupScreenProps): React.JSX.Element {
  const [phase, setPhase] = useState<DownloadPhase>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const [whisperProg, setWhisperProg] = useState<AssetProgress>({
    bytes: 0,
    total: WHISPER_MODEL.sizeBytes,
  });
  const [nllbProg, setNllbProg] = useState<AssetProgress>({
    bytes: 0,
    total: NLLB_MODEL.sizeBytes,
  });
  const [fontProg, setFontProg] = useState<AssetProgress>({
    bytes: 0,
    total: RUBIK_FONT.sizeBytes,
  });

  const downloadAsset = useCallback(
    async (
      model: ModelInfo,
      phaseLabel: DownloadPhase,
      setProgress: (p: AssetProgress) => void,
    ) => {
      const present = await isModelPresent(model);
      if (present) {
        setProgress({bytes: model.sizeBytes, total: model.sizeBytes});
        return;
      }
      setPhase(phaseLabel);
      await downloadModel(model, (bytes, contentLength) =>
        setProgress({
          bytes,
          total: contentLength > 0 ? contentLength : model.sizeBytes,
        }),
      );
      // Mark as fully complete regardless of reported contentLength
      setProgress({bytes: model.sizeBytes, total: model.sizeBytes});
    },
    [],
  );

  const downloadAll = useCallback(async () => {
    setErrorMsg('');
    try {
      await downloadAsset(WHISPER_MODEL, 'downloading_whisper', setWhisperProg);
      await downloadAsset(NLLB_MODEL, 'downloading_nllb', setNllbProg);
      await downloadAsset(RUBIK_FONT, 'downloading_font', setFontProg);
      setPhase('done');
      onComplete();
    } catch (e) {
      setPhase('error');
      setErrorMsg(String(e));
    }
  }, [downloadAsset, onComplete]);

  const isActive =
    phase === 'downloading_whisper' ||
    phase === 'downloading_nllb' ||
    phase === 'downloading_font';

  const btnLabel =
    phase === 'idle'
      ? 'Download & Continue'
      : phase === 'error'
        ? 'Retry'
        : 'Downloading…';

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.logo}>CoreSubs</Text>
      <Text style={styles.title}>First-Time Setup</Text>
      <Text style={styles.subtitle}>
        All AI processing runs entirely on-device.{'\n'}
        Download the models once — nothing leaves your phone.
      </Text>

      <AssetRow
        label="Whisper STT"
        description="Speech-to-text model  •  ggml-base.en  •  ~148 MB"
        progress={whisperProg}
        active={phase === 'downloading_whisper'}
      />

      <AssetRow
        label="NLLB Translation"
        description="English → Hebrew  •  INT8 quantized  •  ~310 MB"
        progress={nllbProg}
        active={phase === 'downloading_nllb'}
      />

      <AssetRow
        label="Hebrew Font"
        description="Rubik-Regular.ttf for subtitle export  •  ~140 KB"
        progress={fontProg}
        active={phase === 'downloading_font'}
      />

      {phase === 'error' && (
        <Text style={styles.errorText}>Error: {errorMsg}</Text>
      )}

      <TouchableOpacity
        style={[styles.btn, isActive && styles.btnDisabled]}
        onPress={downloadAll}
        disabled={isActive}
        activeOpacity={0.85}>
        <Text style={styles.btnText}>{btnLabel}</Text>
      </TouchableOpacity>

      <Text style={styles.hint}>
        Requires a network connection. All files are saved locally and never
        uploaded. Total download: ~458 MB.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: '#0A0A0A',
    alignItems: 'center',
    padding: 28,
    paddingTop: 60,
    gap: 18,
  },
  logo: {fontSize: 36, fontWeight: '700', color: '#FFD700'},
  title: {fontSize: 20, fontWeight: '700', color: '#FFF'},
  subtitle: {
    fontSize: 13,
    color: '#888',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 8,
  },
  assetRow: {
    width: '100%',
    backgroundColor: '#1A1A1A',
    borderRadius: 12,
    padding: 16,
    gap: 8,
  },
  assetHeader: {flexDirection: 'row', alignItems: 'center', gap: 8},
  assetLabel: {color: '#FFF', fontWeight: '600', fontSize: 15, flex: 1},
  checkmark: {color: '#4CAF50', fontSize: 16, fontWeight: '700'},
  activeLabel: {color: '#FFD700', fontSize: 12},
  assetDesc: {color: '#888', fontSize: 12},
  progressTrack: {
    height: 4,
    backgroundColor: '#333',
    borderRadius: 2,
    overflow: 'hidden',
    marginTop: 4,
  },
  progressFill: {height: '100%', backgroundColor: '#FFD700', borderRadius: 2},
  btn: {
    backgroundColor: '#FFD700',
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 48,
    marginTop: 16,
  },
  btnDisabled: {opacity: 0.5},
  btnText: {color: '#000', fontWeight: '700', fontSize: 16},
  errorText: {color: '#F44336', fontSize: 13, textAlign: 'center'},
  hint: {fontSize: 11, color: '#444', textAlign: 'center'},
});
