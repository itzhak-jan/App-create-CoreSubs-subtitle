
# App-create-CoreSubs-subtitle

## Overview
A local-first, high-performance React Native video player. The core functionality revolves around extracting audio, generating transcripts (STT), translating text, and displaying subtitles on-the-fly—entirely on-device. The application includes a feature to export the video with hardcoded RTL Hebrew subtitles.

## Target Architecture & Constraints
*   **Target Device:** Heavily optimized for Google Pixel 10 Pro XL (utilizing local NPU/GPU capabilities).
*   **Environment:** Completely offline functionality. No cloud syncing, no external APIs for transcription or translation.
*   **Performance:** Must handle concurrent video playback (up to 4x speed) alongside AI processing without severe thermal throttling or UI thread blocking.

## Tech Stack
*   **Framework:** React Native
*   **Media Processing:** `ffmpeg-kit-react-native` (for audio extraction and subtitle hardcoding).
*   **Speech-to-Text (STT):** `whisper.cpp` (mobile-optimized bindings).
*   **Local Translation:** Google ML Kit on-device translation (default — ~30 MB language packs, milliseconds per line), or Gemma via MediaPipe LLM Inference (optional, slower, follows glossary/gender hints). Selectable in the in-app settings, along with target and source language.
*   **Native Code:** Kotlin (Android) for background processing and hardware bridging where React Native is insufficient.

## Core Processing Pipeline (Just-In-Time)
The architecture must avoid full-file upfront processing to ensure immediate playback. Two stages run concurrently (`src/services/JITProcessor.ts`):
1.  **STT stage:** `ffmpeg-kit` extracts audio ahead of the playhead — a short first chunk (8 s) so subtitles appear within seconds, then 20 s chunks — and whisper.cpp transcribes it (CPU). If a sentence is cut by the chunk boundary, the next chunk starts at that sentence instead. It keeps up to 90 s transcribed ahead.
2.  **Translation stage:** consumes transcribed chunks (nearest to the playhead first) and translates them while the STT stage keeps going.
3.  **Seek Handling:** In-flight work is aborted; finished chunks are kept, so seeking back doesn't redo work. Transcribed-but-untranslated chunks are re-queued.
4.  **Timing:** every stage logs its duration — `adb logcat | grep CoreSubs`.

## Name & Phrase Consistency
A per-video glossary (`src/store/glossaryStore.ts`, saved per video + target language) locks one rendering per name/phrase:
*   **Detection** (`GlossaryService.ts`): capitalised words that aren't sentence-initial and appear at least twice are locked automatically, before the chunk containing them is translated. The rendering is produced with a carrier sentence ("My name is X.") so the MT transliterates rather than translates the name.
*   **Enforcement:** with ML Kit, locked terms are swapped for numeric placeholders before translation and restored afterwards (falls back to a plain translation if a placeholder is lost). With Gemma, they are passed as prompt hints including gender.
*   **Names screen:** shows every locked entry; correcting one updates future subtitles and rewrites the ones already shown.

## RTL & Localization Constraints
*   **Target Language:** Hebrew (Primary).
*   **UI Rendering:** Subtitle overlays must strictly enforce Right-To-Left (RTL) rendering. Punctuation, numbers, and sentence structure must remain intact and naturally readable during both playback and the final hardcoded export.

## Export Mechanics
*   Hardcoding subtitles into the final `.mp4` file must be executed as a background process using `ffmpeg-kit`.
*   The process must not block the main UI thread and should notify the user upon successful save to the device gallery.
