import {FFmpegKit, FFmpegKitConfig, ReturnCode} from 'ffmpeg-kit-react-native';
import RNFS from 'react-native-fs';
import {CameraRoll} from '@react-native-camera-roll/camera-roll';
import type {SubtitleCue} from '../types';
import {writeSRTFile} from '../utils/srtUtils';
import {useSubtitleStore} from '../store/subtitleStore';

const EXPORT_DIR = `${RNFS.CachesDirectoryPath}/coresubs_export`;
const FONTS_CACHE_DIR = `${RNFS.CachesDirectoryPath}/coresubs_fonts`;

/**
 * Copies the Hebrew font from Android assets into the app's cache directory
 * so that ffmpeg's subtitles filter can locate it via `fontsdir`.
 *
 * Font setup (one-time, done manually before building):
 *   1. Download Rubik-Regular.ttf from Google Fonts (supports full Hebrew Unicode block)
 *      Alternative: AssistantHebrew-Regular.ttf or NotoSansHebrew-Regular.ttf
 *   2. Place the file at:
 *        android/app/src/main/assets/fonts/Rubik-Regular.ttf
 *   The Metro bundler does NOT need to know about this file — it is referenced
 *   only by the native Android asset system and accessed here via RNFS.copyFileAssets().
 *
 * Returns the directory path passed to ffmpeg's `fontsdir` option.
 */
async function prepareFontDirectory(): Promise<string> {
  if (!(await RNFS.exists(FONTS_CACHE_DIR))) {
    await RNFS.mkdir(FONTS_CACHE_DIR);
  }

  const destPath = `${FONTS_CACHE_DIR}/Rubik-Regular.ttf`;

  // Only copy if the cached copy is absent (avoids redundant I/O on repeat exports)
  if (!(await RNFS.exists(destPath))) {
    // Copies from android/app/src/main/assets/fonts/Rubik-Regular.ttf
    // The assets path is relative to the assets root.
    await RNFS.copyFileAssets('fonts/Rubik-Regular.ttf', destPath);
  }

  return FONTS_CACHE_DIR;
}

/**
 * Burns Hebrew subtitles into the video using ffmpeg's subtitles filter
 * backed by libass + libfribidi (included in the `video` ffmpeg-kit package).
 *
 * RTL rendering chain:
 *   SRT file (U+200F RTL mark on each line)
 *     → libass parses cues
 *     → libfribidi runs the Unicode BiDi algorithm
 *     → Hebrew glyphs are ordered and shaped right-to-left
 *     → Rubik font renders the shaped glyphs
 *     → libass composites the subtitle onto the video frame
 *
 * Why `executeWithArguments` instead of `execute`:
 *   `FFmpegKit.execute(string)` splits on whitespace, which breaks the
 *   subtitles filter value (it contains spaces in force_style). Passing
 *   arguments as a pre-split array bypasses all shell-level parsing.
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
    // ── Step 1: Generate SRT ──────────────────────────────────────────────────
    await writeSRTFile(cues, srtPath);
    setExportState({status: 'encoding', progress: 5});

    // ── Step 2: Copy Hebrew font from Android assets → cache ─────────────────
    const fontsDirPath = await prepareFontDirectory();

    // ── Step 3: Build the subtitles filter string ─────────────────────────────
    //
    // Filter option reference:
    //   filename     — absolute path to the SRT file
    //   fontsdir     — directory where libass searches for fonts by family name.
    //                  Must be set explicitly; Android has no Hebrew system fonts.
    //   force_style  — ASS-style overrides applied to all SRT cues:
    //     FontName       : must match the font family name inside the TTF exactly
    //                      ("Rubik" for Rubik-Regular.ttf).
    //     FontSize       : 22pt balances legibility and screen coverage
    //     PrimaryColour  : &HAABBGGRR — &H00FFFFFF = fully opaque white
    //     OutlineColour  : &H00000000 = fully opaque black outline
    //     BackColour     : &H80000000 = 50% transparent black box shadow
    //     Outline        : 2 = outline thickness in pixels
    //     Shadow         : 0 = no drop shadow (outline already provides contrast)
    //     MarginV        : 40 = pixels from the bottom edge
    //     Alignment      : 2 = ASS numpad bottom-centre
    //                      libfribidi flips glyph order to RTL automatically;
    //                      the paragraph anchor stays centred.
    //
    // Paths on Android never contain colons, so no ':' escaping is needed.
    // Single-quoting each value protects against commas or spaces inside
    // the force_style list being misread as filter-graph separators.
    const subsFilter = [
      `subtitles=filename='${srtPath}'`,
      `fontsdir='${fontsDirPath}'`,
      "force_style='FontName=Rubik,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H80000000,Outline=2,Shadow=0,MarginV=40,Alignment=2'",
    ].join(':');

    // Prepend a scale pass that rounds dimensions to even numbers.
    // h264_mediacodec (and most H.264 encoders) require width and height to
    // be multiples of 2; trunc(iw/2)*2 is a no-op for compliant source.
    const vfFilter = `scale=trunc(iw/2)*2:trunc(ih/2)*2,${subsFilter}`;

    // ── Step 4: Build the argument array ─────────────────────────────────────
    //
    // Encoder: h264_mediacodec — Android's hardware H.264 encoder via MediaCodec.
    // Benefits over libx264 (software):
    //   - 5-10x faster on Pixel 10 Pro XL (Tensor G4 dedicated video block)
    //   - Lower battery consumption during export
    //   - Does not require GPL licensing (unlike libx264)
    // -b:v 4M: 4 Mbit/s is adequate for 1080p; adjust if source is 4K.
    const args = [
      '-i',        videoUri,
      '-vf',       vfFilter,
      '-c:v',      'h264_mediacodec',
      '-b:v',      '4M',
      '-c:a',      'copy',
      '-movflags', '+faststart',
                   outputPath,
    ];

    // ── Step 5: Register progress callback ───────────────────────────────────
    FFmpegKitConfig.enableStatisticsCallback(stats => {
      // stats.getTime() is encoding position in milliseconds.
      // We don't know the total duration here, so we map elapsed time
      // to a logarithmic curve that reaches ~90% around the 2-minute mark.
      const elapsedSec = stats.getTime() / 1000;
      const approxProgress = Math.min(93, 5 + Math.log1p(elapsedSec) * 20);
      setExportState({status: 'encoding', progress: approxProgress});
    });

    // ── Step 6: Run ffmpeg ────────────────────────────────────────────────────
    const session = await FFmpegKit.executeWithArguments(args);
    FFmpegKitConfig.enableStatisticsCallback(null);

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
    FFmpegKitConfig.enableStatisticsCallback(null);
    setExportState({status: 'error', progress: 0, error: String(err)});
    throw err;
  } finally {
    RNFS.exists(srtPath).then(exists => {
      if (exists) RNFS.unlink(srtPath);
    });
  }
}
