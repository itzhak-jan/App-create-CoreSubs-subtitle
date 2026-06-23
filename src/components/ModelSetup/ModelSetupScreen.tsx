/**
 * ModelSetupScreen — shown on first launch when AI models aren't downloaded.
 *
 * Downloads whisper.cpp and NLLB models to DocumentDirectory.
 * This screen is only shown once; subsequent launches go directly to FilePicker.
 */
import React, {useState, useCallback} from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ScrollView,
} from 'react-native';
import {
  WHISPER_MODEL,
  NLLB_MODEL,
  downloadModel,
  isModelPresent,
  ModelInfo,
} from '../../services/ModelSetupService';

type DownloadPhase = 'idle' | 'downloading_whisper' | 'downloading_nllb' | 'done' | 'error';

interface ModelProgress {
  bytes: number;
  total: number;
}

interface ModelSetupScreenProps {
  onComplete: () => void;
}

function formatMB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function ProgressBar({progress}: {progress: number}): React.JSX.Element {
  return (
    <View style={styles.progressTrack}>
      <View style={[styles.progressFill, {width: `${Math.min(100, progress * 100)}%`}]} />
    </View>
  );
}

export function ModelSetupScreen({onComplete}: ModelSetupScreenProps): React.JSX.Element {
  const [phase, setPhase] = useState<DownloadPhase>('idle');
  const [whisperProg, setWhisperProg] = useState<ModelProgress>({bytes: 0, total: WHISPER_MODEL.sizeBytes});
  const [nllbProg, setNllbProg] = useState<ModelProgress>({bytes: 0, total: NLLB_MODEL.sizeBytes});
  const [errorMsg, setErrorMsg] = useState('');

  const downloadAll = useCallback(async () => {
    try {
      // Whisper
      const whisperPresent = await isModelPresent(WHISPER_MODEL);
      if (!whisperPresent) {
        setPhase('downloading_whisper');
        await downloadModel(WHISPER_MODEL, (b, t) =>
          setWhisperProg({bytes: b, total: t > 0 ? t : WHISPER_MODEL.sizeBytes}),
        );
      } else {
        setWhisperProg(p => ({...p, bytes: p.total}));
      }

      // NLLB
      const nllbPresent = await isModelPresent(NLLB_MODEL);
      if (!nllbPresent) {
        setPhase('downloading_nllb');
        await downloadModel(NLLB_MODEL, (b, t) =>
          setNllbProg({bytes: b, total: t > 0 ? t : NLLB_MODEL.sizeBytes}),
        );
      } else {
        setNllbProg(p => ({...p, bytes: p.total}));
      }

      setPhase('done');
      onComplete();
    } catch (e) {
      setPhase('error');
      setErrorMsg(String(e));
    }
  }, [onComplete]);

  const isActive = phase !== 'idle' && phase !== 'done' && phase !== 'error';

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.logo}>CoreSubs</Text>
      <Text style={styles.title}>First-Time Setup</Text>
      <Text style={styles.subtitle}>
        CoreSubs uses on-device AI models — nothing leaves your phone.{'\n'}
        Download them once (approx. 460 MB total).
      </Text>

      {/* Whisper model */}
      <ModelRow
        label="Whisper STT"
        description="Speech-to-text • ggml-base.en-q5 (~57 MB)"
        progress={whisperProg.bytes / whisperProg.total}
        active={phase === 'downloading_whisper'}
      />

      {/* NLLB model */}
      <ModelRow
        label="NLLB Translation"
        description="English → Hebrew • INT8 quantized (~310 MB)"
        progress={nllbProg.bytes / nllbProg.total}
        active={phase === 'downloading_nllb'}
      />

      {phase === 'error' && (
        <Text style={styles.errorText}>Error: {errorMsg}</Text>
      )}

      <TouchableOpacity
        style={[styles.btn, isActive && styles.btnDisabled]}
        onPress={downloadAll}
        disabled={isActive}
        activeOpacity={0.85}>
        <Text style={styles.btnText}>
          {phase === 'idle' ? 'Download Models'
            : phase === 'error' ? 'Retry'
            : 'Downloading…'}
        </Text>
      </TouchableOpacity>

      <Text style={styles.hint}>
        Requires a Wi-Fi connection. Models are stored locally and never uploaded.
      </Text>
    </ScrollView>
  );
}

function ModelRow({
  label,
  description,
  progress,
  active,
}: {
  label: string;
  description: string;
  progress: number;
  active: boolean;
}): React.JSX.Element {
  return (
    <View style={styles.modelRow}>
      <View style={styles.modelHeader}>
        <Text style={styles.modelLabel}>{label}</Text>
        {progress >= 1 && <Text style={styles.checkmark}>✓</Text>}
        {active && <Text style={styles.activeLabel}>Downloading…</Text>}
      </View>
      <Text style={styles.modelDesc}>{description}</Text>
      <ProgressBar progress={progress} />
    </View>
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
  modelRow: {
    width: '100%',
    backgroundColor: '#1A1A1A',
    borderRadius: 12,
    padding: 16,
    gap: 8,
  },
  modelHeader: {flexDirection: 'row', alignItems: 'center', gap: 8},
  modelLabel: {color: '#FFF', fontWeight: '600', fontSize: 15, flex: 1},
  checkmark: {color: '#4CAF50', fontSize: 16, fontWeight: '700'},
  activeLabel: {color: '#FFD700', fontSize: 12},
  modelDesc: {color: '#888', fontSize: 12},
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
