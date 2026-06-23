
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
*   **Local Translation:** Quantized translation model (e.g., NLLB ggml/tflite via native modules).
*   **Native Code:** Kotlin (Android) for background processing and hardware bridging where React Native is insufficient.

## Core Processing Pipeline (Just-In-Time)
The architecture must avoid full-file upfront processing to ensure immediate playback.
1.  **Chunking:** Use `ffmpeg-kit` in a background service to extract audio in short intervals (e.g., 1-minute chunks) ahead of the current playback position.
2.  **Transcription & Translation:** Feed extracted chunks to the local STT model, pass results to the translation model, and store mapped objects with precise timestamps.
3.  **Seek Handling:** On video seek, immediately flush the current processing queue and initiate a new extraction pipeline from the new timestamp to prevent memory leaks and desync.

## RTL & Localization Constraints
*   **Target Language:** Hebrew (Primary).
*   **UI Rendering:** Subtitle overlays must strictly enforce Right-To-Left (RTL) rendering. Punctuation, numbers, and sentence structure must remain intact and naturally readable during both playback and the final hardcoded export.

## Export Mechanics
*   Hardcoding subtitles into the final `.mp4` file must be executed as a background process using `ffmpeg-kit`.
*   The process must not block the main UI thread and should notify the user upon successful save to the device gallery.
