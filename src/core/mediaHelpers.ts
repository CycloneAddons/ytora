import { createWriteStream } from 'node:fs'
import type { Readable } from 'node:stream'
import {
  YOUTUBE_WEBM_ITAGS,
  selectCompatibleAudioCandidates,
  type ResolvedStreamComponent
} from '../clients/index.ts'
import type {
  AudioQualityPref,
  DownloadMode,
  FormatEntry,
  StreamSelectionSpec,
  TrackUrlData
} from '../types/index.ts'

export interface ResolvedMediaPlan extends TrackUrlData {
  mode: DownloadMode
  video?: ResolvedStreamComponent
  audio?: ResolvedStreamComponent
  progressive?: ResolvedStreamComponent
  client?: string
}

export interface CachedMediaEntry {
  value: ResolvedMediaPlan
  expiresAt: number
}

export function buildSelectionCacheKey(
  videoId: string,
  selection: StreamSelectionSpec,
  itag?: number | null
): string {
  return [
    videoId,
    selection.mode,
    selection.targetKind,
    selection.videoQuality ?? 'best',
    selection.audioQuality ?? 'high',
    selection.codec ?? 'any',
    itag ?? selection.itag ?? 'auto',
    selection.audioTrackId ?? 'default'
  ].join(':')
}

export function resolveSabrFormatContainer(mimeType?: string): string {
  return mimeType?.includes('webm') ? 'webm/opus' : 'm4a'
}

export function isWebmContainer(mimeType?: string, itag?: number): boolean {
  const lower = mimeType?.toLowerCase() ?? ''
  if (lower.includes('webm')) return true
  if (lower.includes('mp4')) return false
  if (typeof itag === 'number' && YOUTUBE_WEBM_ITAGS.has(itag)) return true
  return false
}

export function isMp4Container(mimeType?: string, itag?: number): boolean {
  const lower = mimeType?.toLowerCase() ?? ''
  if (lower.includes('mp4') || lower.includes('m4a')) return true
  if (lower.includes('webm')) return false
  if (itag === 139 || itag === 140 || itag === 141 || itag === 18 || itag === 22) {
    return true
  }
  return false
}

export function pickAudioExtension(
  format?: string | null,
  mimeType?: string,
  itag?: number
): string {
  const lowerFormat = format?.toLowerCase() ?? ''
  const lowerMime = mimeType?.toLowerCase() ?? ''
  if (lowerFormat.includes('mpegts') || lowerFormat.includes('ts')) return 'ts'
  if (
    lowerFormat.includes('webm') ||
    lowerMime.includes('webm') ||
    (itag && YOUTUBE_WEBM_ITAGS.has(itag))
  ) {
    return 'webm'
  }
  if (lowerFormat.includes('mp3')) return 'mp3'
  if (lowerFormat.includes('aac')) return 'aac'
  if (
    lowerFormat.includes('mp4') ||
    lowerFormat.includes('m4a') ||
    lowerMime.includes('mp4')
  ) {
    return itag === 18 || itag === 22 ? 'mp4' : 'm4a'
  }
  return 'm4a'
}

export function selectSabrAudioCandidate(
  formats: FormatEntry[],
  audioQuality: AudioQualityPref = 'high',
  explicitItag?: number | null,
  videoMimeType?: string
): FormatEntry | undefined {
  if (explicitItag) {
    const exact = formats.find((f) => f.itag === explicitItag)
    if (exact) return exact
  }
  const candidates = selectCompatibleAudioCandidates(
    formats,
    videoMimeType,
    audioQuality
  )
  return candidates[0]
}

export async function pipeStreamToFile(
  readable: Readable,
  destPath: string,
  totalBytes: number | null,
  onBytes?: (bytesWritten: number, totalBytes: number | null) => void,
  abortRef?: { aborted: boolean }
): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const writable = createWriteStream(destPath)
    let bytesWritten = 0
    let settled = false

    const cleanup = () => {
      readable.off('data', onData)
      readable.off('end', onEnd)
      readable.off('error', onReadError)
      readable.off('close', onReadClose)
      writable.off('drain', onDrain)
      writable.off('finish', onFinish)
      writable.off('error', onWriteError)
    }

    const fail = (err: Error) => {
      if (settled) return
      settled = true
      cleanup()
      try {
        if (!readable.destroyed) readable.destroy()
      } catch {}
      try {
        if (!writable.destroyed) writable.destroy()
      } catch {}
      reject(err)
    }

    const onData = (chunk: Buffer) => {
      if (settled) return
      if (abortRef?.aborted) {
        fail(new Error('Download aborted'))
        return
      }
      bytesWritten += chunk.length
      onBytes?.(bytesWritten, totalBytes)
      if (!writable.write(chunk)) {
        readable.pause()
      }
    }

    const onDrain = () => {
      if (!settled && !readable.destroyed) {
        readable.resume()
      }
    }

    const onEnd = () => {
      if (settled) return
      writable.end()
    }

    const onFinish = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(bytesWritten)
    }

    const onReadError = (err: Error) => fail(err)
    const onWriteError = (err: Error) => fail(err)
    const onReadClose = () => {
      if (!settled && !readable.readableEnded && !writable.writableEnded) {
        fail(new Error('Source stream closed before completion'))
      }
    }

    readable.on('data', onData)
    readable.once('end', onEnd)
    readable.once('error', onReadError)
    readable.once('close', onReadClose)
    writable.on('drain', onDrain)
    writable.once('finish', onFinish)
    writable.once('error', onWriteError)
  })
}

