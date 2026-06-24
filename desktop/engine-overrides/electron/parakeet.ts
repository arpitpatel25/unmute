// Unmute — on-device STT via NVIDIA Parakeet v3 (sherpa-onnx native).
//
// Replaces the whisper.cpp/ggml-tiny local engine. EXACT same public surface
// the callers depend on (transcribe(Buffer)->string, isModelReady,
// isBinaryReady, isAvailable, downloadModel) so the provider-router fallback,
// the sessionManager cloud-vs-local race, and dictation-recovery are untouched.
//
// Engine: sherpa-onnx-node OfflineRecognizer, NeMo TDT transducer, INT8.
//   model = parakeet-tdt-0.6b-v3 (encoder/decoder/joiner.int8.onnx + tokens.txt)
//   ~640MB on disk; ~20-25x realtime on M1 (measured). Loaded once, kept warm.
//
// Audio: callers hand us WebM/Opus (what MediaRecorder produces). We decode it
// to 16kHz mono PCM WAV via the engine's bundled ffmpeg, then sherpa-onnx reads
// it (it also resamples internally, but we normalize to 16k mono up front).

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { existsSync, statSync, createWriteStream } from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
const TAG = '[parakeet]'

// The four model files (sherpa-onnx NeMo transducer split).
const MODEL_FILES = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']

// On-demand model download. ~478MB bz2 archive published by k2-fsa/sherpa-onnx.
// macOS `tar` reads bz2 natively. The archive extracts to a single top-level
// dir (MODEL_ARCHIVE_DIR) containing the four MODEL_FILES.
const MODEL_ARCHIVE_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2'
const MODEL_ARCHIVE_DIR = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'

/** Decode a PCM-16 mono WAV (what our ffmpeg call produces) into a V8-owned
 *  Float32Array in [-1, 1]. Walks the RIFF chunks to find `fmt ` (sample rate)
 *  and `data` — robust to ffmpeg adding LIST/fact chunks. */
function decodePcm16Wav(buf: Buffer): { sampleRate: number; samples: Float32Array } {
  let off = 12 // skip 'RIFF' size 'WAVE'
  let sampleRate = 16000
  let dataOff = -1
  let dataLen = 0
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') sampleRate = buf.readUInt32LE(off + 12) // audioFmt(2)+channels(2) → rate at +12
    else if (id === 'data') { dataOff = off + 8; dataLen = size; break }
    off += 8 + size + (size & 1) // chunks are word-aligned
  }
  if (dataOff < 0) { dataOff = 44; dataLen = buf.length - 44 } // fallback: canonical header
  const n = Math.max(0, Math.min(dataLen, buf.length - dataOff) >> 1)
  const samples = new Float32Array(n)
  for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(dataOff + i * 2) / 32768
  return { sampleRate, samples }
}

class ParakeetManager {
  private modelsDir: string | null = null
  private recognizer: unknown | null = null
  private loading: Promise<void> | null = null

  private getModelDir(): string {
    if (!this.modelsDir) this.modelsDir = path.join(app.getPath('userData'), 'models', 'parakeet-v3')
    return this.modelsDir
  }

  private file(name: string): string { return path.join(this.getModelDir(), name) }

  /** sherpa-onnx-node loads (native addon + dylibs present). */
  isBinaryReady(): boolean {
    try { require('sherpa-onnx-node'); return true } catch { return false }
  }

  /** All model files present (encoder is the big one — sanity-check its size). */
  isModelReady(): boolean {
    try {
      if (!MODEL_FILES.every((f) => existsSync(this.file(f)))) return false
      return statSync(this.file('encoder.int8.onnx')).size > 100 * 1024 * 1024
    } catch { return false }
  }

  isAvailable(): boolean { return this.isBinaryReady() && this.isModelReady() }

  /** Lazily build the recognizer once and keep it warm. */
  private async ensureRecognizer(): Promise<void> {
    if (this.recognizer) return
    if (this.loading) return this.loading
    this.loading = (async () => {
      const sherpa = require('sherpa-onnx-node')
      const t0 = Date.now()
      this.recognizer = new sherpa.OfflineRecognizer({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          transducer: {
            encoder: this.file('encoder.int8.onnx'),
            decoder: this.file('decoder.int8.onnx'),
            joiner: this.file('joiner.int8.onnx'),
          },
          tokens: this.file('tokens.txt'),
          modelType: 'nemo_transducer',
          numThreads: 4,
          debug: 0,
        },
        decodingMethod: 'greedy_search',
      })
      console.log(`${TAG} recognizer loaded in ${Date.now() - t0}ms`)
    })()
    try { await this.loading } finally { this.loading = null }
  }

  /** Transcribe a WebM/Opus (or WAV) buffer → text. Same contract as whisper. */
  async transcribe(audioBuffer: Buffer): Promise<string> {
    const t0 = Date.now()
    await this.ensureRecognizer()
    const { getFFmpegPath } = await import('./ffmpeg')

    const base = path.join(os.tmpdir(), `parakeet_${Date.now()}_${Math.random().toString(36).slice(2)}`)
    const inPath = `${base}.webm`
    const wavPath = `${base}.wav`
    try {
      await fs.writeFile(inPath, audioBuffer)
      const ff = getFFmpegPath()
      if (!ff) throw new Error('ffmpeg not found')
      // Decode WebM/Opus → 16kHz mono 16-bit PCM WAV.
      await execFileP(ff, ['-y', '-i', inPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath])

      // Parse the WAV into a fresh V8-owned Float32Array ourselves. We deliberately
      // DON'T use sherpa.readWave: it returns native EXTERNAL buffers, and Electron's
      // Node refuses to re-pass those to a native addon ("External buffers are not
      // allowed"). Building the samples from a plain Node Buffer avoids that entirely.
      const wavBuf = await fs.readFile(wavPath)
      const { sampleRate, samples } = decodePcm16Wav(wavBuf)

      const rec = this.recognizer as {
        createStream: () => { acceptWaveform: (w: { sampleRate: number; samples: Float32Array }) => void }
        decode: (s: unknown) => void
        getResult: (s: unknown) => { text: string }
      }
      const stream = rec.createStream()
      stream.acceptWaveform({ sampleRate, samples })
      rec.decode(stream)
      const text = (rec.getResult(stream).text || '').trim()
      console.log(`${TAG} transcribed ${text.length} chars in ${Date.now() - t0}ms (${(samples.length / sampleRate).toFixed(1)}s audio)`)
      return text
    } finally {
      void fs.unlink(inPath).catch(() => {})
      void fs.unlink(wavPath).catch(() => {})
    }
  }

  /** Stream the ~478MB bz2 archive to a temp file (progress 0..100 from
   *  Content-Length), extract it with macOS `tar xjf`, then move the four
   *  model files into the model dir. Fail-safe: any error cleans up partial
   *  files (temp archive, extract dir, half-written model dir) and rethrows a
   *  clear message — never leaves a half-installed model behind. */
  async downloadModel(onProgress?: (p: number) => void): Promise<void> {
    if (this.isModelReady()) return

    const modelDir = this.getModelDir()
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'parakeet-dl-'))
    const archivePath = path.join(tmpRoot, 'model.tar.bz2')
    const extractedDir = path.join(tmpRoot, MODEL_ARCHIVE_DIR)

    const cleanupTmp = async () => { await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {}) }

    try {
      // 1) Stream the archive to disk, emitting progress from Content-Length.
      console.log(`${TAG} downloading model from ${MODEL_ARCHIVE_URL}`)
      await new Promise<void>((resolve, reject) => {
        const download = (url: string, redirectCount = 0) => {
          if (redirectCount > 5) { reject(new Error('Too many redirects')); return }
          const protocol = url.startsWith('https') ? https : require('node:http')
          protocol.get(url, (res: any) => {
            if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
              res.resume()
              download(res.headers.location, redirectCount + 1)
              return
            }
            if (res.statusCode !== 200) {
              res.resume()
              reject(new Error(`Download failed: HTTP ${res.statusCode}`))
              return
            }
            const totalBytes = parseInt(res.headers['content-length'] || '0', 10)
            let downloadedBytes = 0
            let lastPct = -1
            const file = createWriteStream(archivePath)
            res.on('data', (chunk: Buffer) => {
              downloadedBytes += chunk.length
              if (totalBytes > 0) {
                const pct = Math.min(99, Math.round((downloadedBytes / totalBytes) * 100))
                if (pct !== lastPct) { lastPct = pct; onProgress?.(pct) }
              }
            })
            res.pipe(file)
            file.on('finish', () => file.close(() => resolve()))
            file.on('error', (err: Error) => { file.destroy(); reject(err) })
            res.on('error', (err: Error) => { file.destroy(); reject(err) })
          }).on('error', (err: Error) => reject(err))
        }
        download(MODEL_ARCHIVE_URL)
      })

      // 2) Extract (macOS tar handles bz2 via -j).
      console.log(`${TAG} extracting archive`)
      await execFileP('tar', ['xjf', archivePath, '-C', tmpRoot])

      // 3) Verify the four files landed, then move them into the model dir.
      for (const f of MODEL_FILES) {
        if (!existsSync(path.join(extractedDir, f))) {
          throw new Error(`extracted archive missing ${f}`)
        }
      }
      await fs.mkdir(modelDir, { recursive: true })
      for (const f of MODEL_FILES) {
        const src = path.join(extractedDir, f)
        const dest = path.join(modelDir, f)
        // rename can fail across filesystems (tmp vs userData) → fall back to copy.
        try { await fs.rename(src, dest) }
        catch { await fs.copyFile(src, dest); await fs.unlink(src).catch(() => {}) }
      }

      if (!this.isModelReady()) throw new Error('model files moved but readiness check failed')
      onProgress?.(100)
      console.log(`${TAG} model installed at ${modelDir}`)
    } catch (err) {
      // Don't leave a half-written model dir — remove any partial model files.
      await Promise.all(MODEL_FILES.map((f) => fs.unlink(path.join(modelDir, f)).catch(() => {})))
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`${TAG} model download failed: ${msg}`)
      throw new Error(`Parakeet model download failed: ${msg}`)
    } finally {
      await cleanupTmp()
    }
  }

  /** No subprocess to manage (in-process). Kept for interface parity. */
  isServerRunning(): boolean { return !!this.recognizer }
  async startServer(): Promise<void> { /* in-process; recognizer loads lazily on first transcribe */ }
  stopServer(): void { this.recognizer = null }
}

export const parakeetManager = new ParakeetManager()
