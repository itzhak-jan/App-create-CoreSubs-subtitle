import {FFmpegKit, FFmpegKitConfig, ReturnCode} from 'ffmpeg-kit-react-native';
import RNFS from 'react-native-fs';
import {CameraRoll} from '@react-native-camera-roll/camera-roll';
import type {SubtitleCue} from '../types';
import {writeSRTFile} from '../utils/srtUtils';
import {useSubtitleStore} from '../store/subtitleStore';
import {modelPath, MODELS_DIR, FONTS_DIR} from './ModelSetupService';
import {getCachedManifest} from './ModelManifest';

const EXPORT_DIR = `${RNFS.CachesDirectoryPath}/coresubs_export`;

/**
 * Burns Hebrew subtitles into the video using ffmpeg's subtitles filter
 * backed by libass + libfribidi (included in the `video` ffmpeg-kit package).
 *
 * RTL rendering chain:
 *   SRT file (each line prefixed with U+200F RTL mark)
 *     → libass parses cues
 *     → libfribidi runs the Unicode BiDi algorithm
 *     → Hebrew glyphs are shaped and ordered right-to-left
 *     → Rubik font (downloaded at first launch to DocumentDirectory/fonts/)
 *        renders the glyphs
 *     → libass composites the subtitle onto the decoded video frame
 *
 * Font path: the font manifest asset is downloaded by ModelSetupScreen at
 *   first launch. fontsdir points to the same directory it was saved to
 *   (DocumentDirectory/fonts/ by default). No APK-bundled assets are needed.
 *
 * Why executeWithArguments:
 *   FFmpegKit.execute(string) splits on whitespace; the subtitles filter
 *   value contains spaces inside force_style which would cause a parse error.
 *   Passing a pre-split string[] bypasses all shell-level tokenisation.
 */
export async function exportWithSubtitles(
  videoUri: string,
  cues: SubtitleCue[],
): Promise<void> {
  const {setExportState} = useSubtitleStore.getState();

  setExportState({status: 'generating_srt', progress: 0});

  if (!(await RNFS.exists(EXPORT_DIR))) {
    await RNFS.mkdir(EXPORT_DIR);
  }

  const srtPath = `${EXPORT_DIR}/subtitles.srt`;
  const outputPath = `${EXPORT_DIR}/exported_${Date.now()}.mp4`;

  try {
    // ── Step 1: Generate the SRT file ────────────────────────────────────────
    await writeSRTFile(cues, srtPath);
    setExportState({status: 'encoding', progress: 5});

    // ── Step 2: Verify the font was downloaded ───────────────────────────────
    // The font lives at DocumentDirectory/fonts/<filename>, written by
    // ModelSetupScreen on first launch. No copy from assets is needed.
    // getCachedManifest() is populated by App.tsx at startup before the user
    // can ever reach the export screen, so this never needs a network call.
    const fontAsset = getCachedManifest().font;
    const fontFilePath = modelPath(fontAsset);
    if (!(await RNFS.exists(fontFilePath))) {
      throw new Error(
        'Hebrew font not found. Please complete the first-time setup before exporting.',
      );
    }
    // fontsdir is the directory containing the TTF; libass resolves fonts by
    // family name within that directory.
    const fontsDirPath = fontAsset.dir === 'fonts' ? FONTS_DIR : MODELS_DIR;

    // ── Step 3: Build the subtitles filter ───────────────────────────────────
    //
    // force_style ASS options:
    //   FontName     — must match the font's internal family name ("Rubik")
    //   FontSize     — 22pt: legible on 1080p without covering too much frame
    //   PrimaryColour  &HAABBGGRR → &H00FFFFFF = fully opaque white
    //   OutlineColour  &H00000000 = fully opaque black
    //   BackColour     &H80000000 = 50% transparent black (box behind text)
    //   Outline      2 = border thickness in pixels
    //   Shadow       0 = no drop shadow (outline is sufficient)
    //   MarginV      40 = px from bottom edge
    //   Alignment    2 = ASS numpad bottom-centre; libfribidi reorders
    //                    glyphs within the line to RTL automatically
    const subsFilter = [
      `subtitles=filename='${srtPath}'`,
      `fontsdir='${fontsDirPath}'`,
      "force_style='FontName=Rubik,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H80000000,Outline=2,Shadow=0,MarginV=40,Alignment=2'",
    ].join(':');

    // Scale ensures even dimensions required by h264_mediacodec;
    // trunc(iw/2)*2 is a no-op when the source is already compliant.
    const vfFilter = `scale=trunc(iw/2)*2:trunc(ih/2)*2,${subsFilter}`;

    // ── Step 4: Build argument array ─────────────────────────────────────────
    //
    // h264_mediacodec: Android hardware H.264 encoder (MediaCodec API).
    //   Faster than libx264 software encode on Tensor G4; LGPL-compatible
    //   so it works with the "video" ffmpeg-kit package (no GPL needed).
    const args = [
      '-i',
      videoUri,
      '-vf',
      vfFilter,
      '-c:v',
      'h264_mediacodec',
      '-b:v',
      '4M',
      '-c:a',
      'copy',
      '-movflags',
      '+faststart',
      outputPath,
    ];

    // ── Step 5: Progress callback ─────────────────────────────────────────────
    FFmpegKitConfig.enableStatisticsCallback(stats => {
      const elapsedSec = stats.getTime() / 1000;
      // Log curve: reaches ~90% after ~2 minutes of encoding time
      const approxProgress = Math.min(93, 5 + Math.log1p(elapsedSec) * 20);
      setExportState({status: 'encoding', progress: approxProgress});
    });

    // ── Step 6: Execute ───────────────────────────────────────────────────────
    const session = await FFmpegKit.executeWithArguments(args);
    FFmpegKitConfig.enableStatisticsCallback(() => {});

    const rc = await session.getReturnCode();
    if (!ReturnCode.isSuccess(rc)) {
      const logs = await session.getAllLogsAsString();
      throw new Error(`FFmpeg export failed:\n${logs}`);
    }

    // ── Step 7: Save to gallery ───────────────────────────────────────────────
    setExportState({status: 'saving', progress: 96});
    await CameraRoll.saveAsset(`file://${outputPath}`, {type: 'video'});

    setExportState({status: 'done', progress: 100, outputPath});
  } catch (err) {
    FFmpegKitConfig.enableStatisticsCallback(() => {});
    setExportState({status: 'error', progress: 0, error: String(err)});
    throw err;
  } finally {
    RNFS.exists(srtPath).then(exists => {
      if (exists) {
        RNFS.unlink(srtPath);
      }
    });
  }
}
