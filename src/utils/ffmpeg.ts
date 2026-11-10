import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { FfmpegInfo } from '../types/index.ts'
import { logger } from './logger.ts'

const execFileAsync = promisify(execFile)

async function probeFfmpegCandidate(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(bin, ['-version'], {
      timeout: 5000
    })
    return stdout.split(/\r?\n/)[0]?.trim() || bin
  } catch {
    return null
  }
}

export async function resolveFfmpegStaticPath(): Promise<string | null> {
  try {
    const ffmpegStaticPkg = 'ffmpeg-static'
    const mod: unknown = await import(ffmpegStaticPkg)
    const defaultExport =
      typeof mod === 'object' && mod !== null && 'default' in mod
        ? (mod as { default?: unknown }).default
        : undefined
    const candidate =
      typeof defaultExport === 'string'
        ? defaultExport
        : typeof mod === 'string'
          ? mod
          : null
    if (candidate && candidate.trim().length > 0 && existsSync(candidate)) {
      return candidate
    }
  } catch {
    // ffmpeg-static unavailable
  }
  return null
}

/**
 * Resolves a working ffmpeg executable.
 * Checks FFMPEG_PATH, PATH/system locations first, then falls back to ffmpeg-static.
 */
export async function detectFfmpegBinary(options?: {
  skipSystem?: boolean
}): Promise<FfmpegInfo | null> {
  if (!options?.skipSystem) {
    const candidates: Array<{
      bin: string
      source: 'env' | 'system'
    }> = []
    const seen = new Set<string>()
    const addCandidate = (bin: string | undefined, source: 'env' | 'system') => {
      const trimmed = bin?.trim()
      if (!trimmed || seen.has(trimmed)) return
      seen.add(trimmed)
      candidates.push({ bin: trimmed, source })
    }

    addCandidate(process.env.FFMPEG_PATH, 'env')
    addCandidate('ffmpeg', 'system')
    if (process.env.PREFIX?.trim()) {
      addCandidate(path.join(process.env.PREFIX.trim(), 'bin', 'ffmpeg'), 'system')
    }
    if (process.platform === 'android') {
      addCandidate('/data/data/com.termux/files/usr/bin/ffmpeg', 'system')
    }
    addCandidate('/usr/bin/ffmpeg', 'system')
    addCandidate('/usr/local/bin/ffmpeg', 'system')

    for (const { bin, source } of candidates) {
      const versionLine = await probeFfmpegCandidate(bin)
      if (versionLine) {
        return { bin, versionLine, source }
      }
    }
  }

  const staticBin = await resolveFfmpegStaticPath()
  if (staticBin) {
    const versionLine = await probeFfmpegCandidate(staticBin)
    if (versionLine) {
      logger(
        'debug',
        'FFmpeg',
        `System ffmpeg not found; using ffmpeg-static fallback (${staticBin}).`
      )
      return { bin: staticBin, versionLine, source: 'ffmpeg-static' }
    }
  }

  return null
}

export async function muxVideoAndAudio(
  ffmpegBin: string,
  videoPath: string,
  audioPath: string,
  outputPath: string,
  ext: 'mp4' | 'mkv'
): Promise<void> {
  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    videoPath,
    '-i',
    audioPath,
    '-c',
    'copy'
  ]
  if (ext === 'mp4') {
    args.push('-movflags', '+faststart')
  }
  args.push(outputPath)

  try {
    await execFileAsync(ffmpegBin, args, {
      timeout: 0,
      maxBuffer: 10 * 1024 * 1024
    })
  } catch (err) {
    const e = err as Error & { stderr?: string }
    const detail = e.stderr?.trim() || e.message
    throw new Error(`ffmpeg mux failed: ${detail}`)
  }
}

export async function remuxToMp4(
  ffmpegBin: string,
  inputPath: string,
  outputPath: string
): Promise<void> {
  await execFileAsync(
    ffmpegBin,
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      inputPath,
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      outputPath
    ],
    { timeout: 0 }
  )
}
