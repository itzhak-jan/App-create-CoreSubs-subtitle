/**
 * ModelManifest — describes which AI model files the app downloads, and at
 * what version.
 *
 * Why a remote manifest instead of hardcoded URLs:
 *   Swapping in a better checkpoint (e.g. a newer NLLB distillation, or a
 *   Whisper model fine-tuned for a specific accent) used to mean shipping a
 *   new app build. With the manifest hosted as a plain JSON file in this
 *   repo, updating the recommended model is a one-line edit + git push —
 *   every install picks it up next time it checks, no app-store release
 *   required. Bump an asset's `version` string whenever its `url` changes;
 *   that's the only signal the app uses to know an update exists.
 *
 * Resolution order:
 *   1. Try to fetch MANIFEST_URL (a few seconds, best-effort).
 *   2. On any failure (offline, 404, malformed JSON) fall back to the last
 *      manifest we fetched successfully in this process, or — on the very
 *      first run — DEFAULT_MANIFEST below.
 *
 * IMPORTANT — the `nllb` entry's URL is not a verified, working download:
 *   there is no officially hosted NLLB-200 TFLite conversion at a stable
 *   public URL as of this writing (Meta only publishes NLLB as PyTorch
 *   checkpoints; community conversions found so far are CTranslate2/ONNX,
 *   not TFLite). Ship a self-converted, self-hosted file and update
 *   models-manifest.json (repo root) with its real URL/size/version before
 *   relying on translation in production — see the NLLBTranslationModule.kt
 *   header comment for what the conversion needs to produce.
 */
export interface ManifestAsset {
  /** Model family, e.g. "whisper-ggml", "nllb-200", "rubik-font". Purely
   *  informational — lets a future manifest swap in a sibling checkpoint
   *  from the same family without the app needing to know the difference. */
  family: string;
  /** Bump this whenever `url` changes. The app compares it against the
   *  locally recorded installed version to detect available updates. */
  version: string;
  filename: string;
  url: string;
  /** Minimum expected file size in bytes — used to detect corrupt/partial downloads. */
  sizeBytes: number;
  dir: 'models' | 'fonts';
}

export interface ModelManifest {
  whisper: ManifestAsset;
  nllb: ManifestAsset;
  font: ManifestAsset;
}

export type ManifestKey = keyof ModelManifest;

// Hosted in this project's own repo (raw content), so updating the
// recommended model is just an edit to models-manifest.json at the repo
// root, on the default branch.
export const MANIFEST_URL =
  'https://raw.githubusercontent.com/itzhak-jan/app-create-coresubs-subtitle/main/models-manifest.json';

/**
 * Bundled fallback, used only when the remote manifest can't be reached.
 * Keep in sync with models-manifest.json at the repo root — this is a
 * copy baked into the app so first launch works even before any network
 * call succeeds.
 */
export const DEFAULT_MANIFEST: ModelManifest = {
  whisper: {
    family: 'whisper-ggml',
    version: '1.0.0',
    filename: 'ggml-base.en.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
    sizeBytes: 147_964_211,
    dir: 'models',
  },
  nllb: {
    family: 'nllb-200',
    version: '1.0.0',
    filename: 'nllb-200-distilled-600M-int8.tflite',
    // NOT VERIFIED — see file header. Replace with a real self-hosted
    // conversion before shipping; bump `version` when you do.
    url: 'https://huggingface.co/facebook/nllb-200-distilled-600M/resolve/main/model.tflite',
    sizeBytes: 310_000_000,
    dir: 'models',
  },
  font: {
    family: 'rubik-font',
    version: '1.0.0',
    filename: 'Rubik-Regular.ttf',
    url: 'https://github.com/google/fonts/raw/main/ofl/rubik/Rubik-Regular.ttf',
    sizeBytes: 138_000,
    dir: 'fonts',
  },
};

let cachedManifest: ModelManifest = DEFAULT_MANIFEST;

/** Returns the last successfully fetched manifest without hitting the network. */
export function getCachedManifest(): ModelManifest {
  return cachedManifest;
}

function isValidManifest(json: unknown): json is ModelManifest {
  if (typeof json !== 'object' || json === null) {
    return false;
  }
  const m = json as Partial<ModelManifest>;
  return ['whisper', 'nllb', 'font'].every(key => {
    const asset = (m as Record<string, unknown>)[key] as
      | Partial<ManifestAsset>
      | undefined;
    return (
      typeof asset?.url === 'string' &&
      typeof asset?.filename === 'string' &&
      typeof asset?.version === 'string' &&
      typeof asset?.sizeBytes === 'number'
    );
  });
}

/**
 * Fetches the remote manifest. Falls back to the last known-good manifest
 * (or DEFAULT_MANIFEST on first run) if the network call fails or the
 * response is malformed — callers never have to handle a rejected promise.
 */
export async function fetchManifest(): Promise<ModelManifest> {
  try {
    const res = await fetch(MANIFEST_URL);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const json = await res.json();
    if (!isValidManifest(json)) {
      throw new Error('malformed manifest');
    }
    cachedManifest = json;
    return json;
  } catch (e) {
    console.warn(
      '[ModelManifest] Falling back to bundled manifest —',
      String(e),
    );
    return cachedManifest;
  }
}
