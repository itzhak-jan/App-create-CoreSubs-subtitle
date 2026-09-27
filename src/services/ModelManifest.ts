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
 * `translator` history: originally pointed at TranslateGemma-4B, but Google
 *   never published an Android/mobile .task or .litertlm bundle for it —
 *   only a "-web.task" (MediaPipe Web/Wasm, incompatible with this app's
 *   Android LlmInference API). The one community Android conversion found
 *   (barakplasma/translategemma-4b-it-android-task-quantized) ships
 *   .litertlm, a different runtime (LiteRT-LM, not the MediaPipe Task Genai
 *   API this app uses) than what's implemented, and has a reported bug
 *   returning padding-only output on GPU. Switched to
 *   litert-community/Gemma3-1B-IT instead — a general-purpose instruct
 *   model (not translation-specialized, so quality depends on the prompt
 *   in TranslationService.ts rather than fine-tuning) whose README
 *   explicitly confirms Android + MediaPipe LLM Inference support, in the
 *   same .task format already used here. Cross-checked filename and size
 *   across several independent sources; this sandbox's network policy still
 *   blocks huggingface.co directly, so the URL itself hasn't had a live
 *   HTTP check — if it 404s, that's the first thing to verify.
 *
 *   Still open: whether the download requires accepting Gemma's license via
 *   a logged-in HuggingFace session (common for Gemma re-uploads) — an
 *   anonymous RNFS.downloadFile() would fail against a gated repo. Confirm
 *   by opening the URL below in a browser.
 */
export interface ManifestAsset {
  /** Model family, e.g. "whisper-ggml", "translategemma-4b". Purely
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
  dir: 'models';
}

export interface ModelManifest {
  whisper: ManifestAsset;
  translator: ManifestAsset;
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
    family: 'gemma3-1b',
    version: '2.0.0',
    filename: 'Gemma3-1B-IT_multi-prefill-seq_q4_ekv2048.task',
    url: 'https://huggingface.co/litert-community/Gemma3-1B-IT/resolve/main/Gemma3-1B-IT_multi-prefill-seq_q4_ekv2048.task',
    // ~555 MB per multiple independent sources — see file header for what's
    // still unconfirmed (license gating).
    sizeBytes: 555_000_000,
    dir: 'models',
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
  return ['whisper', 'translator'].every(key => {
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
