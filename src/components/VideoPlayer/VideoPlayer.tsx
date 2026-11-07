import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  StyleSheet,
  View,
  Pressable,
  I18nManager,
  StatusBar,
  Text,
  type GestureResponderEvent,
} from 'react-native';
import Video, {type VideoRef} from 'react-native-video';
import {useVideoStore} from '../../store/videoStore';
import {SubtitleOverlay} from './SubtitleOverlay';
import {PlayerControls, SKIP_SEC} from './PlayerControls';
import {onPlayheadProgress} from '../../services/SubtitleManager';
import {jitProcessor} from '../../services/JITProcessor';

const PROGRESS_INTERVAL_MS = 250;
const DOUBLE_TAP_MS = 280;

export function VideoPlayer(): React.JSX.Element | null {
  const videoRef = useRef<VideoRef>(null);

  const {
    meta,
    isPaused,
    playbackRate,
    isMuted,
    volume,
    setCurrentTime,
    setDuration,
    setLoadState,
    setIsPaused,
  } = useVideoStore();

  const handleProgress = useCallback(
    (data: {currentTime: number}) => {
      setCurrentTime(data.currentTime);
      onPlayheadProgress(data.currentTime);
    },
    [setCurrentTime],
  );

  const handleLoad = useCallback(
    (data: {duration: number}) => {
      setDuration(data.duration);
      setLoadState('ready');
      // Kick off JIT processing from position 0
      jitProcessor.init(meta!.uri, data.duration, meta!.displayName);
      // Immediately queue first chunk
      jitProcessor.onPlayheadUpdate(0);
    },
    [setDuration, setLoadState, meta],
  );

  const handleSeek = useCallback(
    (timeSec: number) => {
      const {duration} = useVideoStore.getState();
      const t = Math.max(0, Math.min(timeSec, Math.max(0, duration - 0.5)));
      videoRef.current?.seek(t);
      // Update the store right away so the seek bar and the pipeline see
      // the new position before the next onProgress tick.
      setCurrentTime(t);
      // Flush pipeline and restart from new position
      jitProcessor.seek(t);
    },
    [setCurrentTime],
  );

  const [skipFlash, setSkipFlash] = useState<{
    side: 'left' | 'right';
    key: number;
  } | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSkip = useCallback(
    (deltaSec: number) => {
      handleSeek(useVideoStore.getState().currentTime + deltaSec);
      setSkipFlash({side: deltaSec < 0 ? 'left' : 'right', key: Date.now()});
      if (flashTimer.current) {
        clearTimeout(flashTimer.current);
      }
      flashTimer.current = setTimeout(() => setSkipFlash(null), 600);
    },
    [handleSeek],
  );

  const handleTogglePlay = useCallback(() => {
    setIsPaused(!useVideoStore.getState().isPaused);
  }, [setIsPaused]);

  // Tap = play/pause; double-tap on the left/right third = ∓15 s (like
  // YouTube). The single tap waits DOUBLE_TAP_MS to rule out a double.
  const viewWidth = useRef(1);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTap = useRef(0);

  const handleVideoPress = useCallback(
    (e: GestureResponderEvent) => {
      const x = e.nativeEvent.locationX;
      const now = Date.now();
      if (now - lastTap.current < DOUBLE_TAP_MS) {
        if (tapTimer.current) {
          clearTimeout(tapTimer.current);
          tapTimer.current = null;
        }
        lastTap.current = 0;
        if (x < viewWidth.current / 3) {
          handleSkip(-SKIP_SEC);
        } else if (x > (viewWidth.current * 2) / 3) {
          handleSkip(SKIP_SEC);
        } else {
          handleTogglePlay();
        }
        return;
      }
      lastTap.current = now;
      tapTimer.current = setTimeout(() => {
        tapTimer.current = null;
        handleTogglePlay();
      }, DOUBLE_TAP_MS);
    },
    [handleSkip, handleTogglePlay],
  );

  useEffect(
    () => () => {
      if (tapTimer.current) {
        clearTimeout(tapTimer.current);
      }
      if (flashTimer.current) {
        clearTimeout(flashTimer.current);
      }
    },
    [],
  );

  if (!meta) {
    return null;
  }

  return (
    <View
      style={styles.root}
      onLayout={e => {
        viewWidth.current = Math.max(1, e.nativeEvent.layout.width);
      }}>
      <StatusBar hidden />
      <Video
        ref={videoRef}
        source={{uri: meta.uri}}
        style={styles.video}
        paused={isPaused}
        rate={playbackRate}
        muted={isMuted}
        volume={volume}
        resizeMode="contain"
        progressUpdateInterval={PROGRESS_INTERVAL_MS}
        onProgress={handleProgress}
        onLoad={handleLoad}
        onError={e => {
          console.error('[VideoPlayer] error:', e);
          setLoadState('error');
        }}
        // Hardware decoder configuration for Pixel 10 Pro XL
        // Prefers hardware-accelerated H.264/H.265 via MediaCodec
        useTextureView={true}
        ignoreSilentSwitch="ignore"
      />

      {/* Tap layer above the video. Wrapping <Video> in a Touchable didn't
          work: Video doesn't forward the responder props to its native
          view, so taps on the picture never arrived. */}
      <Pressable style={styles.tapLayer} onPress={handleVideoPress} />

      <SubtitleOverlay />

      {skipFlash && (
        <View
          key={skipFlash.key}
          pointerEvents="none"
          style={[
            styles.skipFlash,
            // Absolute left/right are mirrored by RN under an RTL locale;
            // swap so the flash shows on the physical side that was tapped.
            (skipFlash.side === 'left') !== I18nManager.isRTL
              ? styles.skipLeft
              : styles.skipRight,
          ]}>
          <Text style={styles.skipText}>
            {skipFlash.side === 'left' ? `⟲ ${SKIP_SEC}` : `${SKIP_SEC} ⟳`}
          </Text>
        </View>
      )}

      <PlayerControls
        onSeek={handleSeek}
        onSkip={handleSkip}
        onTogglePlay={handleTogglePlay}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000',
  },
  video: {
    ...StyleSheet.absoluteFillObject,
  },
  tapLayer: {
    ...StyleSheet.absoluteFillObject,
  },
  skipFlash: {
    position: 'absolute',
    top: '40%',
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 24,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  skipLeft: {left: '12%'},
  skipRight: {right: '12%'},
  skipText: {color: '#FFF', fontSize: 18, fontWeight: '700'},
});
