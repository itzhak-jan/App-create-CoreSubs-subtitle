import React, {useCallback, useRef, useState} from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  PanResponder,
  ActivityIndicator,
} from 'react-native';
import {useVideoStore} from '../../store/videoStore';
import {useSubtitleStore} from '../../store/subtitleStore';

export const SKIP_SEC = 15;
const PLAYBACK_RATES = [0.5, 1.0, 1.5, 2.0, 3.0, 4.0];

const STATUS_LABELS: Record<string, string> = {
  extracting: 'Extracting audio…',
  transcribing: 'Transcribing…',
  awaiting_translation: 'Translating…',
  translating: 'Translating…',
};

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

interface PlayerControlsProps {
  onSeek: (timeSec: number) => void;
  /** Relative jump in seconds (negative = back). */
  onSkip: (deltaSec: number) => void;
  onTogglePlay: () => void;
}

export function PlayerControls({
  onSeek,
  onSkip,
  onTogglePlay,
}: PlayerControlsProps): React.JSX.Element {
  const {currentTime, duration, isPaused, playbackRate, setPlaybackRate} =
    useVideoStore();
  const {showSubtitles, setShowSubtitles, chunkAt} = useSubtitleStore();

  const [showRemaining, setShowRemaining] = useState(false);
  const isSeeking = useRef(false);
  const seekTime = useRef(0);

  // Pipeline status for the current position. Chunks no longer sit on a
  // fixed grid (they follow speech and survive seeks), so look the chunk up
  // by time range. No chunk yet means the STT stage hasn't reached here.
  const currentChunk = chunkAt(currentTime);
  const statusLabel = !duration
    ? undefined
    : !currentChunk
    ? 'Waiting for audio…'
    : STATUS_LABELS[currentChunk.status];

  // The PanResponder is created once, so it reads live values through refs
  // (closing over the first render's duration — 0 — made every drag seek
  // to the start). The position is locationX on the track itself: the fill
  // and handle have pointerEvents="none", so the track is always the touch
  // target, and its width comes from onLayout (correct after rotation).
  // Screen-coordinate measuring (measureInWindow vs pageX) drifted in
  // landscape and overshot seeks by minutes.
  const durationRef = useRef(duration);
  durationRef.current = duration;
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;
  const trackWidth = useRef(1);
  const [dragRatio, setDragRatio] = useState<number | null>(null);

  const ratioAt = (locationX: number) =>
    Math.max(0, Math.min(1, locationX / trackWidth.current));

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: evt => {
        isSeeking.current = true;
        const r = ratioAt(evt.nativeEvent.locationX);
        seekTime.current = r * durationRef.current;
        setDragRatio(r);
      },
      onPanResponderMove: evt => {
        const r = ratioAt(evt.nativeEvent.locationX);
        seekTime.current = r * durationRef.current;
        setDragRatio(r);
      },
      onPanResponderRelease: () => {
        isSeeking.current = false;
        setDragRatio(null);
        if (durationRef.current > 0) {
          onSeekRef.current(seekTime.current);
        }
      },
      onPanResponderTerminate: () => {
        isSeeking.current = false;
        setDragRatio(null);
      },
    }),
  ).current;

  const cyclePlaybackRate = useCallback(() => {
    const idx = PLAYBACK_RATES.indexOf(playbackRate);
    const next = PLAYBACK_RATES[(idx + 1) % PLAYBACK_RATES.length];
    setPlaybackRate(next);
  }, [playbackRate, setPlaybackRate]);

  const progress =
    dragRatio ?? (duration > 0 ? Math.min(1, currentTime / duration) : 0);
  const shownTime = dragRatio !== null ? dragRatio * duration : currentTime;

  return (
    <View style={styles.container}>
      {/* Processing status — a labeled pill above the controls, not just a
          small spinner easy to miss among the buttons below. */}
      {statusLabel && (
        <View style={styles.statusPill}>
          <ActivityIndicator color="#FFD700" size="small" />
          <Text style={styles.statusText}>{statusLabel}</Text>
        </View>
      )}

      {/* Seek bar */}
      <View
        onLayout={e => {
          trackWidth.current = Math.max(1, e.nativeEvent.layout.width);
        }}
        style={styles.seekBarTrack}
        {...panResponder.panHandlers}>
        <View pointerEvents="none" style={styles.seekBarBg} />
        <View
          pointerEvents="none"
          style={[styles.seekBarFill, {width: `${progress * 100}%`}]}
        />
        <View
          pointerEvents="none"
          style={[
            styles.seekHandle,
            dragRatio !== null && styles.seekHandleActive,
            {left: `${progress * 100}%`},
          ]}
        />
      </View>

      {/* Time row */}
      <View style={styles.timeRow}>
        <Text style={[styles.timeText, dragRatio !== null && styles.timeDrag]}>
          {formatTime(shownTime)}
        </Text>
        <TouchableOpacity onPress={() => setShowRemaining(!showRemaining)}>
          <Text style={styles.timeText}>
            {showRemaining
              ? `-${formatTime(Math.max(0, duration - shownTime))}`
              : formatTime(duration)}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Controls row */}
      <View style={styles.controlRow}>
        {/* −15 s / Play-Pause / +15 s */}
        <TouchableOpacity onPress={() => onSkip(-SKIP_SEC)} style={styles.btn}>
          <Text style={styles.btnText}>⟲ {SKIP_SEC}</Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={onTogglePlay} style={styles.btn}>
          <Text style={styles.btnText}>{isPaused ? '▶' : '⏸'}</Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={() => onSkip(SKIP_SEC)} style={styles.btn}>
          <Text style={styles.btnText}>{SKIP_SEC} ⟳</Text>
        </TouchableOpacity>

        {/* Speed */}
        <TouchableOpacity onPress={cyclePlaybackRate} style={styles.btn}>
          <Text style={styles.btnText}>{playbackRate}×</Text>
        </TouchableOpacity>

        {/* Subtitle toggle */}
        <TouchableOpacity
          onPress={() => setShowSubtitles(!showSubtitles)}
          style={styles.btn}>
          <Text style={[styles.btnText, !showSubtitles && styles.disabled]}>
            CC
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    // Video controls stay left-to-right even with a Hebrew/RTL phone
    // locale: React Native auto-mirrors layout in RTL (the fill grew from
    // the right) while touch math is physical, so taps landed mirrored.
    direction: 'ltr',
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    paddingBottom: 20,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  seekBarTrack: {
    height: 36,
    justifyContent: 'center',
  },
  seekBarBg: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 3,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.25)',
  },
  seekBarFill: {
    height: 3,
    backgroundColor: '#FFD700',
    borderRadius: 2,
  },
  seekHandle: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#FFD700',
    marginLeft: -7,
    top: 11,
  },
  timeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  timeText: {color: '#CCC', fontSize: 12},
  timeDrag: {color: '#FFD700', fontWeight: '700'},
  seekHandleActive: {
    width: 20,
    height: 20,
    borderRadius: 10,
    marginLeft: -10,
    top: 8,
  },
  controlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 20,
  },
  btn: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  btnText: {color: '#FFF', fontSize: 15, fontWeight: '600'},
  disabled: {opacity: 0.35},
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: 8,
    backgroundColor: 'rgba(255,215,0,0.16)',
    borderRadius: 12,
    paddingVertical: 4,
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  statusText: {color: '#FFD700', fontSize: 12, fontWeight: '600'},
});
