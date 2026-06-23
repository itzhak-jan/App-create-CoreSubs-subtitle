import {FFmpegKit, ReturnCode} from 'ffmpeg-kit-react-native';
import RNFS from 'react-native-fs';

const TEMP_DIR = `${RNFS.CachesDirectoryPath}/coresubs_chunks`;

export async function ensureTempDir(): Promise<void> {
  const exists = await RNFS.exists(TEMP_DIR);
  if (!exists) {
    await RNFS.mkdir(TEMP_DIR);
  }
}

/**
 * Extracts a mono 16 kHz WAV segment from the source video.
 * whisper.cpp requires 16-bit PCM 16 kHz mono audio.
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

  // -ss before -i for fast stream seek; -t caps chunk duration
  // -ar 16000 -ac 1 -c:a pcm_s16le satisfies whisper.cpp input requirements
  const cmd = [
    '-ss', String(startSec),
    '-i', videoUri,
    '-t', String(durationSec),
    '-ar', '16000',
    '-ac', '1',
    '-c:a', 'pcm_s16le',
    '-vn',
    outPath,
  ].join(' ');

  const session = await FFmpegKit.execute(cmd);
  const rc = await session.getReturnCode();

  if (!ReturnCode.isSuccess(rc)) {
    const logs = await session.getAllLogsAsString();
    throw new Error(`FFmpeg chunk extraction failed (chunk ${chunkIndex}): ${logs}`);
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
