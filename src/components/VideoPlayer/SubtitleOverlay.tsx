import React, {useEffect} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import {useSubtitleStore} from '../../store/subtitleStore';
import {hebrewTextStyle, normaliseHebrewText} from '../../utils/rtlUtils';

const FADE_DURATION_MS = 150;

export function SubtitleOverlay(): React.JSX.Element | null {
  const activeCue = useSubtitleStore(s => s.activeCue);
  const showSubtitles = useSubtitleStore(s => s.showSubtitles);
  const fontSize = useSubtitleStore(s => s.subtitleFontSize);

  const opacity = useSharedValue(0);

  useEffect(() => {
    opacity.value = withTiming(activeCue && showSubtitles ? 1 : 0, {
      duration: FADE_DURATION_MS,
      easing: Easing.out(Easing.quad),
    });
  }, [activeCue, showSubtitles, opacity]);

  const animStyle = useAnimatedStyle(() => ({opacity: opacity.value}));

  if (!showSubtitles) {
    return null;
  }

  return (
    <Animated.View style={[styles.container, animStyle]} pointerEvents="none">
      <View style={styles.bubble}>
        <Text
          style={[styles.text, hebrewTextStyle, {fontSize}]}
          numberOfLines={3}
          adjustsFontSizeToFit
          allowFontScaling={false}>
          {activeCue ? normaliseHebrewText(activeCue.hebrewText) : ''}
        </Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 72,
    left: 12,
    right: 12,
    alignItems: 'center',
  },
  bubble: {
    backgroundColor: 'rgba(0,0,0,0.62)',
    borderRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 6,
    maxWidth: '92%',
  },
  text: {
    color: '#FFFFFF',
    // No fontFamily override: a custom font can't be wired into RN's Text
    // component on Android just by sitting in DocumentDirectory (it would
    // need to be bundled under android/assets/fonts/ at build time, which
    // the project intentionally avoids — see ModelSetupService.ts). Leaving
    // this unset falls back to the system font, which resolves Hebrew
    // glyphs via Android's built-in Noto Sans Hebrew fallback. Rubik is
    // used only for the burned-in export video, via ffmpeg's fontsdir.
    lineHeight: 28,
    letterSpacing: 0.2,
  },
});
