import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Platform,
} from 'react-native';
import DocumentPicker, {types} from 'react-native-document-picker';
import {
  check,
  request,
  PERMISSIONS,
  RESULTS,
} from 'react-native-permissions';
import {useVideoStore} from '../../store/videoStore';
import {useSubtitleStore} from '../../store/subtitleStore';
import {jitProcessor} from '../../services/JITProcessor';
import {cleanAllChunks} from '../../services/ChunkExtractor';

async function ensureStoragePermission(): Promise<boolean> {
  // Android 13+ uses READ_MEDIA_VIDEO; earlier versions use READ_EXTERNAL_STORAGE
  const permission =
    Platform.Version >= 33
      ? PERMISSIONS.ANDROID.READ_MEDIA_VIDEO
      : PERMISSIONS.ANDROID.READ_EXTERNAL_STORAGE;

  let status = await check(permission);
  if (status === RESULTS.DENIED) {
    status = await request(permission);
  }
  return status === RESULTS.GRANTED;
}

export function FilePicker(): React.JSX.Element {
  const {setMeta, reset: resetVideo} = useVideoStore();
  const {reset: resetSubtitles} = useSubtitleStore();

  const pickVideo = async () => {
    const granted = await ensureStoragePermission();
    if (!granted) {
      Alert.alert(
        'Permission required',
        'Storage access is required to load video files.',
      );
      return;
    }

    try {
      const result = await DocumentPicker.pickSingle({
        type: [types.video],
        copyTo: 'cachesDirectory',
      });

      if (!result.fileCopyUri && !result.uri) {
        Alert.alert('Error', 'Could not read the selected file.');
        return;
      }

      // Reset any previous session
      jitProcessor.reset();
      await cleanAllChunks();
      resetVideo();
      resetSubtitles();

      // Derive display name
      const name =
        result.name?.replace(/\.[^.]+$/, '') ?? 'Video';

      const uri = result.fileCopyUri ?? result.uri;

      setMeta({
        uri,
        duration: 0,       // updated by VideoPlayer's onLoad
        displayName: name,
      });
    } catch (err) {
      if (!DocumentPicker.isCancel(err)) {
        Alert.alert('Error', String(err));
      }
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.logo}>CoreSubs</Text>
      <Text style={styles.tagline}>On-device Hebrew subtitle generation</Text>

      <TouchableOpacity style={styles.btn} onPress={pickVideo} activeOpacity={0.8}>
        <Text style={styles.btnText}>Open Video</Text>
      </TouchableOpacity>

      <Text style={styles.hint}>Supports MP4, MKV, AVI and most common formats</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0A',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 18,
    paddingHorizontal: 32,
  },
  logo: {
    fontSize: 40,
    fontWeight: '700',
    color: '#FFD700',
    letterSpacing: -1,
  },
  tagline: {
    fontSize: 14,
    color: '#888',
    marginBottom: 24,
  },
  btn: {
    backgroundColor: '#FFD700',
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 48,
    shadowColor: '#FFD700',
    shadowOffset: {width: 0, height: 4},
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 6,
  },
  btnText: {
    color: '#000',
    fontSize: 16,
    fontWeight: '700',
  },
  hint: {
    fontSize: 12,
    color: '#555',
    textAlign: 'center',
  },
});
