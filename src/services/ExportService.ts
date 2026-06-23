import {FFmpegKit, FFmpegKitConfig, ReturnCode} from 'ffmpeg-kit-react-native';
import RNFS from 'react-native-fs';
import {CameraRoll} from '@react-native-camera-roll/camera-roll';
import type {SubtitleCue} from '../types';
import {writeSRTFile} from '../utils/srtUtils';
import {useSubtitleStore} from '../store/subtitleStore';

const EXPORT_DIR = `${RNFS.CachesDirectoryPath}/coresubs_export`;

/**
 * Burns the Hebrew SRT subtitles into the video using ffmpeg's
 * `subtitles` filter. The export runs in the background; progress is
 * piped through the zustand exportState slice.
 *
 * Font considerations for Hebrew RTL:
 *  - FontName is set to a bundled Hebrew-capable font (NotoSansHebrew)
 *  - MarginV (vertical margin) keeps subs off the bottom edge
 *  - Alignment=2 is bottom-centre, which ASS wraps to RTL for Hebrew
 */
export async function exportWithSubtitles(
  videoUri: string,
  cues: SubtitleCue[],
): Promise<void> {
  const {setExportState} = useSubtitleStore.getState();

  setExportState({status: 'generating_srt', progress: 0});

  // Ensure export directory
  if (!(await RNFS.exists(EXPORT_DIR))) {
    await RNFS.mkdir(EXPORT_DIR);
  }

  const srtPath = `${EXPORT_DIR}/subtitles.srt`;
  const outputPath = `${EXPORT_DIR}/exported_${Date.now()}.mp4`;

  try {
    // ── Generate SRT ─────────────────────────────────────────────────────────
    await writeSRTFile(cues, srtPath);
    setExportState({status: 'encoding', progress: 5});

    // ── FFmpeg burn-in command ────────────────────────────────────────────────
    //
    // Subtitle filter options:
    //   force_style: overrides SRT styling with ASS-style options.
    //   FontName=NotoSansHebrew: bundled Hebrew font (see android/app/src/main/assets/)
    //   FontSize=22, PrimaryColour=&H00FFFFFF: white text
    //   Outline=1, Shadow=1: readability shadow
    //   MarginV=40: keep away from bottom edge
    //   Alignment=2: bottom-centre (ASS numpad alignment)
    //
    // Note: srtPath must be escaped for ffmpeg filter_complex syntax
    const escapedSrt = srtPath.replace(/:/g, '\\:').replace(/'/g, "\\'");

    const cmd = [
      '-i', `"${videoUri}"`,
      '-vf', `"subtitles='${escapedSrt}':force_style='FontName=NotoSansHebrew,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=1,Shadow=1,MarginV=40,Alignment=2'"`,
      '-c:v', 'libx264',
      '-crf', '23',
      '-preset', 'fast',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      `"${outputPath}"`,
    ].join(' ');

    // Register a statistics callback to report encoding progress
    FFmpegKitConfig.enableStatisticsCallback(stats => {
      const timeMs = stats.getTime();
      // We use a rough estimate: assume constant bitrate for progress %
      // A more precise method would require probing total duration frames.
      const approxProgress = Math.min(95, 5 + (timeMs / 1000 / 60) * 90);
      setExportState({status: 'encoding', progress: approxProgress});
    });

    const session = await FFmpegKit.execute(cmd);
    const rc = await session.getReturnCode();

    FFmpegKitConfig.enableStatisticsCallback(null);

    if (!ReturnCode.isSuccess(rc)) {
      const logs = await session.getAllLogsAsString();
      throw new Error(`FFmpeg export failed: ${logs}`);
    }

    // ── Save to gallery ───────────────────────────────────────────────────────
    setExportState({status: 'saving', progress: 96});
    await CameraRoll.saveAsset(`file://${outputPath}`, {type: 'video'});

    setExportState({status: 'done', progress: 100, outputPath});
  } catch (err) {
    setExportState({status: 'error', progress: 0, error: String(err)});
    throw err;
  } finally {
    // Clean temp SRT (keep output until user explicitly dismisses)
    RNFS.exists(srtPath).then(exists => {
      if (exists) RNFS.unlink(srtPath);
    });
  }
}
