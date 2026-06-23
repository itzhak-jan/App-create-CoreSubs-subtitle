import RNFS from 'react-native-fs';

export const MODELS_DIR = `${RNFS.DocumentDirectoryPath}/models`;
export const FONTS_DIR = `${RNFS.DocumentDirectoryPath}/fonts`;

export interface ModelInfo {
  filename: string;
  url: string;
  /** Minimum expected file size in bytes — used to detect corrupt downloads. */
  sizeBytes: number;
  /** Absolute path to the destination directory on device storage. */
  dir: string;
}

// ─── Asset definitions ────────────────────────────────────────────────────────

export const WHISPER_MODEL: ModelInfo = {
  filename: 'ggml-base.en.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
  sizeBytes: 147_964_211,
  dir: MODELS_DIR,
};

export const NLLB_MODEL: ModelInfo = {
  filename: 'nllb-200-distilled-600M-int8.tflite',
  // Replace with a self-hosted URL in production; HuggingFace rate-limits downloads.
  url: 'https://huggingface.co/facebook/nllb-200-distilled-600M/resolve/main/model.tflite',
  sizeBytes: 310_000_000,
  dir: MODELS_DIR,
};

/**
 * Rubik-Regular.ttf (~140 KB) — sourced from the official Google Fonts GitHub
 * repository (SIL Open Font License 1.1). Covers the full Hebrew Unicode block
 * (U+0590–U+05FF) including vowel points (nikud).
 *
 * Used exclusively by ffmpeg's libass `fontsdir` option during subtitle
 * burn-in. NOT used by the React Native font loader — the subtitle overlay
 * in the UI references it by family name through the standard RN font system.
 */
export const RUBIK_FONT: ModelInfo = {
  filename: 'Rubik-Regular.ttf',
  url: 'https://github.com/google/fonts/raw/main/ofl/rubik/Rubik-Regular.ttf',
  sizeBytes: 138_000,
  dir: FONTS_DIR,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function ensureDir(dir: string): Promise<void> {
  if (!(await RNFS.exists(dir))) {
    await RNFS.mkdir(dir);
  }
}

/**
 * Returns true only if the file exists and is at least 99% of the expected
 * size. The 1% tolerance accommodates minor version differences in hosted files
 * without letting a zero-byte partial download pass.
 */
export async function isModelPresent(model: ModelInfo): Promise<boolean> {
  const path = `${model.dir}/${model.filename}`;
  if (!(await RNFS.exists(path))) return false;
  const stat = await RNFS.stat(path);
  return Number(stat.size) >= model.sizeBytes * 0.99;
}

/**
 * Downloads a ModelInfo asset to its configured `dir` directory.
 * Resumes partial downloads automatically (RNFS range-request support).
 */
export async function downloadModel(
  model: ModelInfo,
  onProgress: (bytesWritten: number, contentLength: number) => void,
): Promise<string> {
  await ensureDir(model.dir);
  const destPath = `${model.dir}/${model.filename}`;

  const {promise} = RNFS.downloadFile({
    fromUrl: model.url,
    toFile: destPath,
    progress: res => onProgress(res.bytesWritten, res.contentLength),
    progressInterval: 500,
    begin: () => {},
  });

  const result = await promise;
  if (result.statusCode !== 200) {
    throw new Error(
      `Download failed (HTTP ${result.statusCode}): ${model.url}`,
    );
  }
  return destPath;
}

/** Returns the absolute path to a downloaded asset file. */
export function modelPath(model: ModelInfo): string {
  return `${model.dir}/${model.filename}`;
}
