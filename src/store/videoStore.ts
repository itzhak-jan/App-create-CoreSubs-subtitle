import {create} from 'zustand';
import type {VideoLoadState, VideoMeta} from '../types';

interface VideoStore {
  meta: VideoMeta | null;
  loadState: VideoLoadState;
  currentTime: number;
  duration: number;
  playbackRate: number;
  isPaused: boolean;
  isMuted: boolean;
  volume: number;

  setMeta: (meta: VideoMeta) => void;
  setLoadState: (state: VideoLoadState) => void;
  setCurrentTime: (t: number) => void;
  setDuration: (d: number) => void;
  setPlaybackRate: (rate: number) => void;
  setIsPaused: (paused: boolean) => void;
  setIsMuted: (muted: boolean) => void;
  setVolume: (v: number) => void;
  reset: () => void;
}

const initialState = {
  meta: null,
  loadState: 'idle' as VideoLoadState,
  currentTime: 0,
  duration: 0,
  playbackRate: 1.0,
  isPaused: true,
  isMuted: false,
  volume: 1.0,
};

export const useVideoStore = create<VideoStore>(set => ({
  ...initialState,

  setMeta: meta => set({meta, loadState: 'loading'}),
  setLoadState: loadState => set({loadState}),
  setCurrentTime: currentTime => set({currentTime}),
  setDuration: duration => set({duration}),
  setPlaybackRate: playbackRate => set({playbackRate}),
  setIsPaused: isPaused => set({isPaused}),
  setIsMuted: isMuted => set({isMuted}),
  setVolume: volume => set({volume}),
  reset: () => set(initialState),
}));
