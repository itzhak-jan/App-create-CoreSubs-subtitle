import React, {useCallback} from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  Platform,
} from 'react-native';
import {check, request, PERMISSIONS, RESULTS} from 'react-native-permissions';
import {useSubtitleStore} from '../../store/subtitleStore';
import {useVideoStore} from '../../store/videoStore';
import {exportWithSubtitles} from '../../services/ExportService';

async function ensureWritePermission(): Promise<boolean> {
  // Android 13+: saving to gallery via CameraRoll needs READ_MEDIA_VIDEO
  // which doubles as write access to MediaStore; no WRITE_EXTERNAL_STORAGE needed.
  if (Number(Platform.Version) < 33) {
    const status = await check(PERMISSIONS.ANDROID.WRITE_EXTERNAL_STORAGE);
    if (status !== RESULTS.GRANTED) {
      const req = await request(PERMISSIONS.ANDROID.WRITE_EXTERNAL_STORAGE);
      return req === RESULTS.GRANTED;
    }
  }
  return true;
}

interface ExportModalProps {
  visible: boolean;
  onClose: () => void;
}

export function ExportModal({
  visible,
  onClose,
}: ExportModalProps): React.JSX.Element {
  const {exportState, getAllCues, setExportState} = useSubtitleStore();
  const {meta} = useVideoStore();

  const isProcessing = ['generating_srt', 'encoding', 'saving'].includes(
    exportState.status,
  );

  const handleExport = useCallback(async () => {
    if (!meta?.uri) {
      return;
    }

    const granted = await ensureWritePermission();
    if (!granted) {
      Alert.alert(
        'Permission required',
        'Gallery write access is required to save the video.',
      );
      return;
    }

    const cues = getAllCues();
    if (cues.length === 0) {
      Alert.alert(
        'No subtitles',
        'No subtitles have been generated yet. Let the video play for a moment first.',
      );
      return;
    }

    try {
      await exportWithSubtitles(meta.uri, cues);
    } catch (_err) {
      // exportState.error is set by exportWithSubtitles
    }
  }, [meta, getAllCues]);

  const handleClose = useCallback(() => {
    if (isProcessing) {
      Alert.alert(
        'Export in progress',
        'The export is still running in the background. Close anyway?',
        [
          {text: 'Cancel', style: 'cancel'},
          {
            text: 'Close',
            style: 'destructive',
            onPress: () => {
              setExportState({status: 'idle', progress: 0});
              onClose();
            },
          },
        ],
      );
      return;
    }
    setExportState({status: 'idle', progress: 0});
    onClose();
  }, [isProcessing, setExportState, onClose]);

  const statusLabel: Record<string, string> = {
    idle: 'Ready to export',
    generating_srt: 'Generating subtitle file…',
    encoding: `Encoding video… ${Math.round(exportState.progress)}%`,
    saving: 'Saving to gallery…',
    done: '✓ Saved to gallery',
    error: `Error: ${exportState.error}`,
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>Export with Hebrew Subtitles</Text>

          <Text style={styles.description}>
            Burns the generated Hebrew subtitles permanently into a new MP4 file
            and saves it to your gallery. The original file is not modified.
          </Text>

          {/* Progress bar */}
          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                {width: `${exportState.progress}%`},
                exportState.status === 'done' && styles.progressDone,
                exportState.status === 'error' && styles.progressError,
              ]}
            />
          </View>

          <Text
            style={[
              styles.statusText,
              exportState.status === 'error' && styles.errorText,
              exportState.status === 'done' && styles.doneText,
            ]}>
            {statusLabel[exportState.status] ?? ''}
          </Text>

          {/* Actions */}
          <View style={styles.actionRow}>
            <TouchableOpacity style={styles.cancelBtn} onPress={handleClose}>
              <Text style={styles.cancelBtnText}>
                {exportState.status === 'done' ? 'Done' : 'Cancel'}
              </Text>
            </TouchableOpacity>

            {!isProcessing && exportState.status !== 'done' && (
              <TouchableOpacity
                style={styles.exportBtn}
                onPress={handleExport}
                activeOpacity={0.85}>
                {isProcessing ? (
                  <ActivityIndicator color="#000" />
                ) : (
                  <Text style={styles.exportBtnText}>Export</Text>
                )}
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.72)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#1A1A1A',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    paddingBottom: 40,
    gap: 16,
  },
  title: {color: '#FFF', fontSize: 18, fontWeight: '700'},
  description: {color: '#888', fontSize: 13, lineHeight: 19},
  progressTrack: {
    height: 6,
    backgroundColor: '#333',
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#FFD700',
    borderRadius: 3,
  },
  progressDone: {backgroundColor: '#4CAF50'},
  progressError: {backgroundColor: '#F44336'},
  statusText: {color: '#888', fontSize: 13},
  errorText: {color: '#F44336'},
  doneText: {color: '#4CAF50'},
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 8,
  },
  cancelBtn: {
    paddingVertical: 12,
    paddingHorizontal: 22,
    borderRadius: 10,
    backgroundColor: '#333',
  },
  cancelBtnText: {color: '#CCC', fontWeight: '600'},
  exportBtn: {
    paddingVertical: 12,
    paddingHorizontal: 28,
    borderRadius: 10,
    backgroundColor: '#FFD700',
  },
  exportBtnText: {color: '#000', fontWeight: '700', fontSize: 15},
});
