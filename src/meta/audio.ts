import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/** Up to five still frames from a video, one every three seconds, as JPEGs at most 1024 px wide. */
export function videoFrames(input: Buffer): Promise<Buffer[]> {
  return new Promise((resolve, reject) => {
    if (!FFMPEG) return reject(new Error('ffmpeg is not available'));
    // MP4 needs to be seekable, so it goes through a private temp folder rather than a pipe.
    const dir = mkdtempSync(join(tmpdir(), 'ip-frames-'));
    writeFileSync(join(dir, 'in'), input, { mode: 0o600 });
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', join(dir, 'in'), '-vf', "fps=1/3,scale='min(1024,iw)':-2", '-frames:v', '5', '-q:v', '4', join(dir, 'f%02d.jpg')]);
    let err = '';
    p.stderr.on('data', (c: Buffer) => { err += c.toString(); });
    const done = (fn: () => void) => { try { fn(); } finally { rmSync(dir, { recursive: true, force: true }); } };
    p.on('error', (e) => done(() => reject(e)));
    p.on('close', (code) => done(() => {
      const frames = readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort().map((f) => readFileSync(join(dir, f)));
      if (code === 0 && frames.length) resolve(frames);
      else reject(new Error(`ffmpeg frames failed: ${err.slice(0, 200)}`));
    }));
  });
}
