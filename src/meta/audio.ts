import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

// System ffmpeg first, then FFMPEG_PATH, then the prebuilt binary from ffmpeg-static
// (Homebrew no longer builds ffmpeg on older macOS).
function findFfmpeg(): string | null {
  const bundled = (() => { try { return createRequire(import.meta.url)('ffmpeg-static') as string | null; } catch { return null; } })();
  for (const bin of ['ffmpeg', process.env.FFMPEG_PATH, bundled]) {
    if (bin && spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0) return bin;
  }
  return null;
}

const FFMPEG = findFfmpeg();

export function ffmpegAvailable(): boolean {
  return FFMPEG !== null;
}

/** WhatsApp voice notes are OGG/Opus. Muse Voice Transcribe takes WAV: convert to mono 16-bit PCM at 24 kHz. */
export function toWav(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!FFMPEG) return reject(new Error('ffmpeg is not available'));
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1']);
    const chunks: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (c: Buffer) => chunks.push(c));
    p.stderr.on('data', (c: Buffer) => { err += c.toString(); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg failed: ${err.slice(0, 200)}`))));
    p.stdin.end(input);
  });
}
