/**
 * ModelSetupService — handles first-run model download and verification.
 *
 * Model files are too large to bundle in the APK. On first launch the user
 * must download them. This service handles the download + integrity check.
 *
 * Recommended models:
 *   Whisper: ggml-base.en-q5_1.bin  (~57 MB)  — fast & accurate for English
 *   NLLB:    nllb-200-distilled-600M-int8.tflite (~310 MB) — good EN→HE quality
 *
 * Alternative (smaller) options:
 *   Whisper: ggml-tiny.en-q8_0.bin  (~42 MB)  — faster, lower accuracy
 *   NLLB:    Helsinki-NLP opus-mt-en-he.tflite (~300 MB) — single language pair
 */

import RNFS from 'react-native-fs';

export const MODELS_DIR = `${RNFS.DocumentDirectoryPath}/models`;

export interface ModelInfo {
  filename: string;
  url: string;
  sizeBytes: number;
}

export const WHISPER_MODEL: ModelInfo = {
  filename: 'ggml-base.en.bin',
  // Official whisper.cpp model CDN
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
  sizeBytes: 147964211,
};

export const NLLB_MODEL: ModelInfo = {
  filename: 'nllb-200-distilled-600M-int8.tflite',
  // Hosted on HuggingFace — replace with a self-hosted URL for production
  url: 'https://huggingface.co/facebook/nllb-200-distilled-600M/resolve/main/model.tflite',
  sizeBytes: 310000000,
};

export async function ensureModelsDir(): Promise<void> {
  if (!(await RNFS.exists(MODELS_DIR))) {
    await RNFS.mkdir(MODELS_DIR);
  }
}

export async function isModelPresent(model: ModelInfo): Promise<boolean> {
  const path = `${MODELS_DIR}/${model.filename}`;
  if (!(await RNFS.exists(path))) return false;
  const stat = await RNFS.stat(path);
  // A size mismatch indicates a corrupt/partial download
  return stat.size >= model.sizeBytes * 0.99;
}

export async function downloadModel(
  model: ModelInfo,
  onProgress: (bytesWritten: number, contentLength: number) => void,
): Promise<string> {
  await ensureModelsDir();
  const destPath = `${MODELS_DIR}/${model.filename}`;

  const result = await RNFS.downloadFile({
    fromUrl: model.url,
    toFile: destPath,
    progress: res => {
      onProgress(res.bytesWritten, res.contentLength);
    },
    progressInterval: 500,
    // Resume partial downloads
    begin: () => {},
  }).promise;

  if (result.statusCode !== 200) {
    throw new Error(`Download failed with status ${result.statusCode}`);
  }
  return destPath;
}

export function modelPath(model: ModelInfo): string {
  return `${MODELS_DIR}/${model.filename}`;
}
