import {NativeModules, NativeEventEmitter} from 'react-native';
import RNFS from 'react-native-fs';
import {CameraRoll} from '@react-native-camera-roll/camera-roll';
import type {SubtitleCue} from '../types';
import {useSubtitleStore} from '../store/subtitleStore';

const {SubtitleExportModule} = NativeModules;

if (!SubtitleExportModule) {
  console.warn(
    '[ExportService] SubtitleExportModule not found — native build required.',
  );
}

const EXPORT_DIR = `${RNFS.CachesDirectoryPath}/coresubs_export`;

/**
 * Burns Hebrew subtitles into the video using AndroidX Media3's Transformer
 * plus a custom Canvas-based overlay effect — see SubtitleExportModule.kt's
 * header comment for why this replaced FFmpeg's `subtitles` filter
 * (libass + libfribidi): ffmpeg-kit-react-native's native binaries no
 * longer exist on any Maven repository.
 *
 * RTL rendering: handled natively by Android's own text layout stack
 * (StaticLayout with TextDirectionHeuristics.RTL) on the Kotlin side — no
 * SRT file or RTL marker character needed here; cues are passed straight
 * through as JSON.
 */
export async function exportWithSubtitles(
  videoUri: string,
  cues: SubtitleCue[],
): Promise<void> {
  const {setExportState} = useSubtitleStore.getState();

  if (!SubtitleExportModule) {
    const err = new Error(
      'SubtitleExportModule not available — native build required.',
    );
    setExportState({status: 'error', progress: 0, error: String(err)});
    throw err;
  }

  setExportState({status: 'encoding', progress: 0});

  if (!(await RNFS.exists(EXPORT_DIR))) {
    await RNFS.mkdir(EXPORT_DIR);
  }

  const outputPath = `${EXPORT_DIR}/exported_${Date.now()}.mp4`;

  const cuesPayload = JSON.stringify(
    cues.map(cue => ({
      startSec: cue.startTime,
      endSec: cue.endTime,
      text: cue.hebrewText,
    })),
  );

  const emitter = new NativeEventEmitter(SubtitleExportModule);
  const subscription = emitter.addListener(
    'SubtitleExportProgress',
    (event: {progress: number}) => {
      setExportState({status: 'encoding', progress: event.progress});
    },
  );

  try {
    await SubtitleExportModule.exportWithSubtitles(
      videoUri,
      cuesPayload,
      outputPath,
    );

    setExportState({status: 'saving', progress: 96});
    await CameraRoll.saveAsset(`file://${outputPath}`, {type: 'video'});

    setExportState({status: 'done', progress: 100, outputPath});
  } catch (err) {
    setExportState({status: 'error', progress: 0, error: String(err)});
    throw err;
  } finally {
    subscription.remove();
  }
}

/** Abort an in-progress export. */
export function abortExport(): void {
  SubtitleExportModule?.abort();
}
