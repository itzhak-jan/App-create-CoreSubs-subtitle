import {create} from 'zustand';
import type {AudioChunk, SubtitleCue, ExportState} from '../types';

interface SubtitleStore {
  chunks: Map<number, AudioChunk>;
  activeCue: SubtitleCue | null;
  exportState: ExportState;
  showSubtitles: boolean;
  subtitleFontSize: number;

  upsertChunk: (chunk: AudioChunk) => void;
  removeChunksAfter: (mediaSec: number) => void;
  setActiveCue: (cue: SubtitleCue | null) => void;
  setExportState: (state: Partial<ExportState>) => void;
  setShowSubtitles: (show: boolean) => void;
  setSubtitleFontSize: (size: number) => void;
  getAllCues: () => SubtitleCue[];
  reset: () => void;
}

const initialExport: ExportState = {
  status: 'idle',
  progress: 0,
};

export const useSubtitleStore = create<SubtitleStore>((set, get) => ({
  chunks: new Map(),
  activeCue: null,
  exportState: initialExport,
  showSubtitles: true,
  subtitleFontSize: 20,

  upsertChunk: chunk =>
    set(state => {
      const next = new Map(state.chunks);
      next.set(chunk.index, chunk);
      return {chunks: next};
    }),

  removeChunksAfter: mediaSec =>
    set(state => {
      const next = new Map(state.chunks);
      for (const [idx, chunk] of next) {
        if (chunk.startSec >= mediaSec) {
          next.delete(idx);
        }
      }
      return {chunks: next, activeCue: null};
    }),

  setActiveCue: activeCue => set({activeCue}),

  setExportState: partial =>
    set(state => ({exportState: {...state.exportState, ...partial}})),

  setShowSubtitles: showSubtitles => set({showSubtitles}),
  setSubtitleFontSize: subtitleFontSize => set({subtitleFontSize}),

  getAllCues: () => {
    const {chunks} = get();
    const cues: SubtitleCue[] = [];
    const sortedChunks = Array.from(chunks.values()).sort(
      (a, b) => a.startSec - b.startSec,
    );
    for (const chunk of sortedChunks) {
      if (chunk.status === 'ready') {
        cues.push(...chunk.cues);
      }
    }
    return cues;
  },

  reset: () =>
    set({
      chunks: new Map(),
      activeCue: null,
      exportState: initialExport,
    }),
}));
