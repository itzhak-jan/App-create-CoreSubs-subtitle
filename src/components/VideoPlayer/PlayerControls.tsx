import React, {useCallback, useRef} from 'react';
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
  onTogglePlay: () => void;
}

export function PlayerControls({
  onSeek,
  onTogglePlay,
}: PlayerControlsProps): React.JSX.Element {
  const {currentTime, duration, isPaused, playbackRate, setPlaybackRate} =
    useVideoStore();
  const {showSubtitles, setShowSubtitles, chunkAt} = useSubtitleStore();

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

  // The PanResponder is created once, so it must read live values through
  // refs. (It used to close over the first render's `duration` — 0 before
  // the video loaded — so every drag computed ratio × 0 and seeked to the
  // start.) Position comes from pageX minus the track's measured left edge:
  // locationX is relative to whichever child view is touched (fill/handle),
  // and the module-level screen width is wrong after rotating to landscape.
  const durationRef = useRef(duration);
  durationRef.current = duration;
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;
  const trackRef = useRef<View>(null);
  const track = useRef({x: 0, width: 1});

  const measureTrack = useCallback(() => {
    trackRef.current?.measureInWindow((x, _y, width) => {
      if (width > 0) {
        track.current = {x, width};
      }
    });
  }, []);

  const ratioAt = (pageX: number) =>
    Math.max(0, Math.min(1, (pageX - track.current.x) / track.current.width));

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: evt => {
        isSeeking.current = true;
        seekTime.current = ratioAt(evt.nativeEvent.pageX) * durationRef.current;
      },
      onPanResponderMove: evt => {
        seekTime.current = ratioAt(evt.nativeEvent.pageX) * durationRef.current;
      },
      onPanResponderRelease: () => {
        isSeeking.current = false;
        if (durationRef.current > 0) {
          onSeekRef.current(seekTime.current);
        }
      },
    }),
  ).current;

  const cyclePlaybackRate = useCallback(() => {
    const idx = PLAYBACK_RATES.indexOf(playbackRate);
    const next = PLAYBACK_RATES[(idx + 1) % PLAYBACK_RATES.length];
    setPlaybackRate(next);
  }, [playbackRate, setPlaybackRate]);

  const progress = duration > 0 ? currentTime / duration : 0;

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
        ref={trackRef}
        onLayout={measureTrack}
        style={styles.seekBarTrack}
        {...panResponder.panHandlers}>
        <View style={[styles.seekBarFill, {width: `${progress * 100}%`}]} />
        <View style={[styles.seekHandle, {left: `${progress * 100}%`}]} />
      </View>

      {/* Time row */}
      <View style={styles.timeRow}>
        <Text style={styles.timeText}>{formatTime(currentTime)}</Text>
        <Text style={styles.timeText}>{formatTime(duration)}</Text>
      </View>

      {/* Controls row */}
      <View style={styles.controlRow}>
        {/* Play/Pause */}
        <TouchableOpacity onPress={onTogglePlay} style={styles.btn}>
          <Text style={styles.btnText}>{isPaused ? '▶' : '⏸'}</Text>
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
