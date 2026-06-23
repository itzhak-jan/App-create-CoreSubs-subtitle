import type {SubtitleCue} from '../types';

function pad(n: number, digits: number): string {
  return String(n).padStart(digits, '0');
}

function secondsToSrtTimestamp(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  const ms = Math.round((totalSec % 1) * 1000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

/**
 * Generates a valid SRT string from an array of SubtitleCues.
 * For Hebrew RTL text, SRT doesn't need special tags — the font renderer
 * and ffmpeg's subtitles filter handle BiDi natively. We do prepend the
 * RTL mark (U+200F) to each line to force correct BiDi resolution when the
 * renderer is ambiguous.
 */
export function cuestoSRT(cues: SubtitleCue[]): string {
  const RTL_MARK = '‏';
  return cues
    .map((cue, i) => {
      const start = secondsToSrtTimestamp(cue.startTime);
      const end = secondsToSrtTimestamp(cue.endTime);
      const text = `${RTL_MARK}${cue.hebrewText}`;
      return `${i + 1}\n${start} --> ${end}\n${text}\n`;
    })
    .join('\n');
}

/**
 * Writes an SRT file to the given path.
 * Returns the path for convenience.
 */
export async function writeSRTFile(
  cues: SubtitleCue[],
  destPath: string,
): Promise<string> {
  const RNFS = await import('react-native-fs');
  const content = cuestoSRT(cues);
  await RNFS.default.writeFile(destPath, content, 'utf8');
  return destPath;
}
