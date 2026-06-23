/**
 * SubtitleManager — bridges the playhead position to the active subtitle cue.
 *
 * Called from VideoPlayer's onProgress callback (fires ~250 ms).
 * Uses binary search over sorted ready cues for O(log n) lookup.
 */

import {findActiveCue} from './TimestampCalculator';
import {jitProcessor} from './JITProcessor';
import {useSubtitleStore} from '../store/subtitleStore';
import type {SubtitleCue} from '../types';

export function onPlayheadProgress(currentTimeSec: number): void {
  const store = useSubtitleStore.getState();
  const allCues = store.getAllCues();

  const cue: SubtitleCue | null = findActiveCue(allCues, currentTimeSec);

  // Only update React state when cue identity changes (prevents re-renders)
  const prev = store.activeCue;
  if (cue?.id !== prev?.id) {
    store.setActiveCue(cue);
  }

  // Let the JIT processor decide whether to queue the next chunk
  jitProcessor.onPlayheadUpdate(currentTimeSec);
}
