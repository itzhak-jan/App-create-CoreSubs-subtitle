import {NativeModules} from 'react-native';
import RNFS from 'react-native-fs';

const {AudioChunkExtractorModule} = NativeModules;

if (!AudioChunkExtractorModule) {
  console.warn(
    '[ChunkExtractor] AudioChunkExtractorModule not found — native build required.',
  );
}

const TEMP_DIR = `${RNFS.CachesDirectoryPath}/coresubs_chunks`;

export async function ensureTempDir(): Promise<void> {
  const exists = await RNFS.exists(TEMP_DIR);
  if (!exists) {
    await RNFS.mkdir(TEMP_DIR);
  }
}

/**
 * Extracts a mono 16 kHz 16-bit PCM WAV segment from the source video's
 * audio track — whisper.cpp requires exactly this format.
 *
 * Backed by AudioChunkExtractorModule.kt (MediaExtractor/MediaCodec +
 * Media3's ChannelMixingAudioProcessor/SonicAudioProcessor), not FFmpeg —
 * see that file's header comment for why.
 *
 * Returns the path to the extracted WAV file.
 */
export async function extractChunk(
  videoUri: string,
  startSec: number,
  durationSec: number,
  chunkIndex: number,
): Promise<string> {
  await ensureTempDir();

  const outPath = `${TEMP_DIR}/chunk_${chunkIndex}.wav`;

  // Remove stale file from a previous session for this index
  if (await RNFS.exists(outPath)) {
    await RNFS.unlink(outPath);
  }

  if (!AudioChunkExtractorModule) {
    throw new Error(
      'AudioChunkExtractorModule not available — native build required.',
    );
  }

  try {
    await AudioChunkExtractorModule.extractChunk(
      videoUri,
      startSec,
      durationSec,
      outPath,
    );
  } catch (err) {
    throw new Error(
      `Chunk extraction failed (chunk ${chunkIndex}): ${String(err)}`,
    );
  }

  return outPath;
}

export async function deleteChunk(chunkIndex: number): Promise<void> {
  const outPath = `${TEMP_DIR}/chunk_${chunkIndex}.wav`;
  if (await RNFS.exists(outPath)) {
    await RNFS.unlink(outPath);
  }
}

export async function cleanAllChunks(): Promise<void> {
  if (await RNFS.exists(TEMP_DIR)) {
    await RNFS.unlink(TEMP_DIR);
  }
}

/** Abort any in-progress chunk extraction (called on seek). */
export function abortChunkExtraction(): void {
  AudioChunkExtractorModule?.abort();
}
