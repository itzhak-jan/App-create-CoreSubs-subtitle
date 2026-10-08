import type {WhisperSegment, SubtitleCue, PipelineConfig} from '../types';

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
  if (cues.length === 0) {
    return null;
  }

  let lo = 0;
  let hi = cues.length - 1;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
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

/**
 * Chunk boundaries are piecewise, not a uniform grid: chunk 0 is
 * `firstChunkDurationSec` long (short, so the first subtitle appears fast),
 * and every chunk after it is a full `chunkDuration`. These three helpers
 * are the single source of truth for that boundary math — every caller
 * (JITProcessor's scheduling, PlayerControls' status lookup) must go
 * through them rather than re-deriving chunk boundaries itself.
 */
export function chunkIndexForTime(
  mediaSec: number,
  config: Pick<PipelineConfig, 'chunkDuration' | 'firstChunkDurationSec'>,
): number {
  if (mediaSec < config.firstChunkDurationSec) {
    return 0;
  }
  return (
    1 +
    Math.floor((mediaSec - config.firstChunkDurationSec) / config.chunkDuration)
  );
}

/** Returns the start time (seconds) of a given chunk index. */
export function chunkStartTime(
  index: number,
  config: Pick<PipelineConfig, 'chunkDuration' | 'firstChunkDurationSec'>,
): number {
  if (index <= 0) {
    return 0;
  }
  return config.firstChunkDurationSec + (index - 1) * config.chunkDuration;
}

/** Returns the nominal duration (seconds) of a given chunk index. */
export function chunkDurationForIndex(
  index: number,
  config: Pick<PipelineConfig, 'chunkDuration' | 'firstChunkDurationSec'>,
): number {
  return index <= 0 ? config.firstChunkDurationSec : config.chunkDuration;
}
