import React, {useCallback, useRef} from 'react';
import {
  StyleSheet,
  View,
  TouchableWithoutFeedback,
  StatusBar,
} from 'react-native';
import Video, {type VideoRef} from 'react-native-video';
import {useVideoStore} from '../../store/videoStore';
import {SubtitleOverlay} from './SubtitleOverlay';
import {PlayerControls} from './PlayerControls';
import {onPlayheadProgress} from '../../services/SubtitleManager';
import {jitProcessor} from '../../services/JITProcessor';

const PROGRESS_INTERVAL_MS = 250;

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
      jitProcessor.init(meta!.uri, data.duration);
      // Immediately queue first chunk
      jitProcessor.onPlayheadUpdate(0);
    },
    [setDuration, setLoadState, meta],
  );

  const handleSeek = useCallback((timeSec: number) => {
    videoRef.current?.seek(timeSec);
    // Flush pipeline and restart from new position
    jitProcessor.seek(timeSec);
  }, []);

  const handleTogglePlay = useCallback(() => {
    setIsPaused(!isPaused);
  }, [isPaused, setIsPaused]);

  if (!meta) {
    return null;
  }

  return (
    <View style={styles.root}>
      <StatusBar hidden />
      <TouchableWithoutFeedback onPress={handleTogglePlay}>
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
      </TouchableWithoutFeedback>

      <SubtitleOverlay />

      <PlayerControls onSeek={handleSeek} onTogglePlay={handleTogglePlay} />
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
});
