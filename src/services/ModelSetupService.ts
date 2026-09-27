import RNFS from 'react-native-fs';
import type {ManifestAsset, ManifestKey, ModelManifest} from './ModelManifest';

export const MODELS_DIR = `${RNFS.DocumentDirectoryPath}/models`;
const INSTALLED_VERSIONS_PATH = `${RNFS.DocumentDirectoryPath}/.installed_versions.json`;

/** Returns the absolute path to a manifest asset's file on device. */
export function modelPath(asset: ManifestAsset): string {
  return `${MODELS_DIR}/${asset.filename}`;
}

async function ensureDir(dir: string): Promise<void> {
  if (!(await RNFS.exists(dir))) {
    await RNFS.mkdir(dir);
  }
}

/**
 * Returns true only if the file exists and is at least 99% of the expected
 * size. The 1% tolerance accommodates minor version differences in hosted
 * files without letting a zero-byte partial download pass.
 */
export async function isModelPresent(asset: ManifestAsset): Promise<boolean> {
  const path = modelPath(asset);
  if (!(await RNFS.exists(path))) {
    return false;
  }
  const stat = await RNFS.stat(path);
  return Number(stat.size) >= asset.sizeBytes * 0.99;
}

// ─── Installed-version bookkeeping ─────────────────────────────────────────
//
// A small JSON file recording which manifest `version` string was installed
// for each asset key. Compared against the live manifest to decide whether
// a newer checkpoint is available — presence alone (isModelPresent) can't
// tell "installed" apart from "installed but outdated".

async function readInstalledVersions(): Promise<
  Partial<Record<ManifestKey, string>>
> {
  try {
    if (!(await RNFS.exists(INSTALLED_VERSIONS_PATH))) {
      return {};
    }
    const raw = await RNFS.readFile(INSTALLED_VERSIONS_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeInstalledVersion(
  key: ManifestKey,
  version: string,
): Promise<void> {
  const versions = await readInstalledVersions();
  versions[key] = version;
  await RNFS.writeFile(
    INSTALLED_VERSIONS_PATH,
    JSON.stringify(versions),
    'utf8',
  );
}

/**
 * Compares each manifest asset's version against what's recorded as
 * installed. Only considers assets that are actually present — a missing
 * asset belongs to first-time setup, not an update prompt. Doesn't download
 * anything; callers decide whether to prompt or auto-fetch.
 */
export async function checkForUpdates(
  manifest: ModelManifest,
): Promise<ManifestKey[]> {
  const keys: ManifestKey[] = ['whisper', 'translator'];
  const installed = await readInstalledVersions();
  const outdated: ManifestKey[] = [];

  for (const key of keys) {
    const asset = manifest[key];
    if (!(await isModelPresent(asset))) {
      continue;
    }
    if (installed[key] !== asset.version) {
      outdated.push(key);
    }
  }
  return outdated;
}

/**
 * Downloads a manifest asset to its configured `dir` directory and records
 * its version as installed. Resumes partial downloads automatically (RNFS
 * range-request support).
 */
export async function downloadModel(
  key: ManifestKey,
  asset: ManifestAsset,
  onProgress: (bytesWritten: number, contentLength: number) => void,
): Promise<string> {
  await ensureDir(MODELS_DIR);
  const destPath = modelPath(asset);

  const {promise} = RNFS.downloadFile({
    fromUrl: asset.url,
    toFile: destPath,
    progress: res => onProgress(res.bytesWritten, res.contentLength),
    progressInterval: 500,
    begin: () => {},
  });

  const result = await promise;
  if (result.statusCode !== 200) {
    throw new Error(
      `Download failed (HTTP ${result.statusCode}): ${asset.url}`,
    );
  }

  await writeInstalledVersion(key, asset.version);
  return destPath;
}
