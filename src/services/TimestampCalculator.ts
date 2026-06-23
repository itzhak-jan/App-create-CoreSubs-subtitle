import type {WhisperSegment, SubtitleCue} from '../types';

/**
 * Converts whisper segments (chunk-relative offsets) into absolute media-time
 * SubtitleCues. Playback speed does NOT affect these values — currentTime from
 * react-native-video is always media time, so cue comparison works at any rate.
 */
export function mapSegmentsToCues(
  segments: WhisperSegment[],
  chunkIndex: number,
  chunkStartSec: number,
  hebrewTexts: string[],
): SubtitleCue[] {
  return segments.map((seg, i) => ({
    id: `${chunkIndex}_${i}`,
    startTime: chunkStartSec + seg.t0,
    endTime: chunkStartSec + seg.t1,
    originalText: seg.text.trim(),
    hebrewText: hebrewTexts[i]?.trim() ?? seg.text.trim(),
  }));
}

/**
 * Binary search for the active cue at a given media position.
 * Assumes cues are sorted by startTime.
 */
export function findActiveCue(
  cues: SubtitleCue[],
  mediaTimeSec: number,
): SubtitleCue | null {
  if (cues.length === 0) return null;

  let lo = 0;
  let hi = cues.length - 1;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const cue = cues[mid];
    if (mediaTimeSec < cue.startTime) {
      hi = mid - 1;
    } else if (mediaTimeSec >= cue.endTime) {
      lo = mid + 1;
    } else {
      return cue;
    }
  }
  return null;
}

/** Returns the chunk index for a given media position and chunk duration. */
export function chunkIndexForTime(mediaSec: number, chunkDuration: number): number {
  return Math.floor(mediaSec / chunkDuration);
}

/** Returns the start time (seconds) of a given chunk index. */
export function chunkStartTime(index: number, chunkDuration: number): number {
  return index * chunkDuration;
}
