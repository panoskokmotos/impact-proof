import { spawn, spawnSync } from 'node:child_process';

export function ffmpegAvailable(): boolean {
  return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
}

/** WhatsApp voice notes are OGG/Opus. Muse Voice Transcribe takes WAV: convert to mono 16-bit PCM at 24 kHz. */
export function toWav(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1']);
    const chunks: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (c: Buffer) => chunks.push(c));
    p.stderr.on('data', (c: Buffer) => { err += c.toString(); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg failed: ${err.slice(0, 200)}`))));
    p.stdin.end(input);
  });
}
