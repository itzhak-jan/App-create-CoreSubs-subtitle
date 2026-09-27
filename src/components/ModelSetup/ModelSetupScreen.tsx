/**
 * ModelSetupScreen — first-launch onboarding screen, and the "update
 * available" screen (via the `onlyKeys` prop restricting which assets are
 * shown/downloaded).
 *
 * Downloads runtime assets described by the manifest (src/services/
 * ModelManifest.ts) to DocumentDirectory:
 *   1. Whisper STT model     (~148 MB)
 *   2. NLLB translation model (~310 MB)
 *   3. Rubik-Regular.ttf Hebrew font for export (~140 KB)
 *
 * None of these are bundled in the APK. Downloading at runtime keeps the
 * repository and CI artefacts lightweight, and lets a newer checkpoint be
 * rolled out by editing models-manifest.json — no app update needed.
 */
import React, {useState, useCallback, useMemo} from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
} from 'react-native';
import type {
  ManifestAsset,
  ManifestKey,
  ModelManifest,
} from '../../services/ModelManifest';
import {downloadModel, isModelPresent} from '../../services/ModelSetupService';

type DownloadPhase = 'idle' | ManifestKey | 'done' | 'error';

const ALL_KEYS: ManifestKey[] = ['whisper', 'nllb', 'font'];

interface AssetProgress {
  bytes: number;
  total: number;
}

interface ModelSetupScreenProps {
  manifest: ModelManifest;
  onComplete: () => void;
  /** Restrict to a subset of assets — used by the "update available" flow
   *  to re-download only the outdated ones. Defaults to all three. */
  onlyKeys?: ManifestKey[];
}

const ASSET_LABELS: Record<
  ManifestKey,
  {label: string; describe: (a: ManifestAsset) => string}
> = {
  whisper: {
    label: 'Whisper STT',
    describe: a =>
      `Speech-to-text model  •  ${a.family}  •  ~${Math.round(
        a.sizeBytes / 1_000_000,
      )} MB`,
  },
  nllb: {
    label: 'NLLB Translation',
    describe: a =>
      `English → Hebrew  •  ${a.family}  •  ~${Math.round(
        a.sizeBytes / 1_000_000,
      )} MB`,
  },
  font: {
    label: 'Hebrew Font',
    describe: a =>
      `${a.filename} for subtitle export  •  ~${Math.round(
        a.sizeBytes / 1_000,
      )} KB`,
  },
};

function ProgressBar({ratio}: {ratio: number}): React.JSX.Element {
  return (
    <View style={styles.progressTrack}>
      <View
        style={[styles.progressFill, {width: `${Math.min(100, ratio * 100)}%`}]}
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
        {active && !done && (
          <Text style={styles.activeLabel}>Downloading…</Text>
        )}
      </View>
      <Text style={styles.assetDesc}>{description}</Text>
      <ProgressBar ratio={ratio} />
    </View>
  );
}

export function ModelSetupScreen({
  manifest,
  onComplete,
  onlyKeys,
}: ModelSetupScreenProps): React.JSX.Element {
  const keys = useMemo(() => onlyKeys ?? ALL_KEYS, [onlyKeys]);
  const isUpdate = !!onlyKeys;

  const [phase, setPhase] = useState<DownloadPhase>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [progress, setProgress] = useState<Record<ManifestKey, AssetProgress>>(
    () => {
      const initial = {} as Record<ManifestKey, AssetProgress>;
      for (const key of keys) {
        initial[key] = {bytes: 0, total: manifest[key].sizeBytes};
      }
      return initial;
    },
  );

  const setAssetProgress = useCallback((key: ManifestKey, p: AssetProgress) => {
    setProgress(prev => ({...prev, [key]: p}));
  }, []);

  const downloadAsset = useCallback(
    async (key: ManifestKey) => {
      const asset = manifest[key];
      const present = await isModelPresent(asset);
      if (present && !isUpdate) {
        setAssetProgress(key, {bytes: asset.sizeBytes, total: asset.sizeBytes});
        return;
      }
      setPhase(key);
      await downloadModel(key, asset, (bytes, contentLength) =>
        setAssetProgress(key, {
          bytes,
          total: contentLength > 0 ? contentLength : asset.sizeBytes,
        }),
      );
      setAssetProgress(key, {bytes: asset.sizeBytes, total: asset.sizeBytes});
    },
    [manifest, isUpdate, setAssetProgress],
  );

  const downloadAll = useCallback(async () => {
    setErrorMsg('');
    try {
      for (const key of keys) {
        await downloadAsset(key);
      }
      setPhase('done');
      onComplete();
    } catch (e) {
      setPhase('error');
      setErrorMsg(String(e));
    }
  }, [keys, downloadAsset, onComplete]);

  const isActive = keys.includes(phase as ManifestKey);

  const btnLabel =
    phase === 'idle'
      ? isUpdate
        ? 'Update & Continue'
        : 'Download & Continue'
      : phase === 'error'
      ? 'Retry'
      : 'Downloading…';

  const totalMB = Math.round(
    keys.reduce((sum, key) => sum + manifest[key].sizeBytes, 0) / 1_000_000,
  );

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.logo}>CoreSubs</Text>
      <Text style={styles.title}>
        {isUpdate ? 'Model Update Available' : 'First-Time Setup'}
      </Text>
      <Text style={styles.subtitle}>
        All AI processing runs entirely on-device.{'\n'}
        {isUpdate
          ? 'A newer version of one or more models is available.'
          : 'Download the models once — nothing leaves your phone.'}
      </Text>

      {keys.map(key => (
        <AssetRow
          key={key}
          label={ASSET_LABELS[key].label}
          description={ASSET_LABELS[key].describe(manifest[key])}
          progress={progress[key]}
          active={phase === key}
        />
      ))}

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
        uploaded. Total download: ~{totalMB} MB.
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
