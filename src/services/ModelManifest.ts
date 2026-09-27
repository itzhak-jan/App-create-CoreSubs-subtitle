/**
 * ModelManifest — describes which AI model files the app downloads, and at
 * what version.
 *
 * Why a remote manifest instead of hardcoded URLs:
 *   Swapping in a better checkpoint (e.g. a newer TranslateGemma release,
 *   or a Whisper model fine-tuned for a specific accent) used to mean shipping a
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
 * IMPORTANT — the `translator` entry below is a placeholder, not a
 *   verified working download. It points at the right HuggingFace org
 *   (litert-community/TranslateGemma-4B-IT — a real, Google-published
 *   LiteRT conversion of TranslateGemma-4B, confirmed via web search to
 *   support Hebrew) but this session's sandbox could not browse
 *   huggingface.co (network egress policy) to confirm the exact Android
 *   .task filename, its real size, or whether the download is gated
 *   behind a Gemma license acceptance. Before relying on translation in
 *   production: open that HF page yourself, get the exact file, and update
 *   models-manifest.json's `translator.url`/`sizeBytes`/`version`. See
 *   TranslatorModule.kt's header comment for the full detail.
 */
export interface ManifestAsset {
  /** Model family, e.g. "whisper-ggml", "translategemma-4b", "rubik-font". Purely
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
  translator: ManifestAsset;
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
  translator: {
    family: 'translategemma-4b',
    version: '1.0.0',
    filename: 'translategemma-4b-it.task',
    // PLACEHOLDER — NOT VERIFIED. See file header: confirm the exact
    // filename, size, and any license gating on huggingface.co/
    // litert-community/TranslateGemma-4B-IT before shipping, then update
    // this url/sizeBytes and bump version.
    url: 'https://huggingface.co/litert-community/TranslateGemma-4B-IT/resolve/main/translategemma-4b-it.task',
    // Rough estimate for a 4B-parameter model at ~4-bit quantization —
    // unconfirmed. Replace with the real file size once known.
    sizeBytes: 2_800_000_000,
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
  return ['whisper', 'translator', 'font'].every(key => {
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
