import type { DownloadProgressEvent } from '../types/index.ts'
import { formatBytes } from '../utils/format.ts'

export interface ProgressRenderer {
  onEvent(ev: DownloadProgressEvent): void
  finish(): void
}

export function createProgressRenderer(
  useTty: boolean,
  quiet: boolean
): ProgressRenderer {
  let lastRenderAt = 0
  let lastPhaseKey = ''
  let phaseStartAt = Date.now()
  let hasActiveLine = false
  let lastEmittedProgress: DownloadProgressEvent | null = null
  let lastRenderedBytes = -1

  const formatLine = (ev: DownloadProgressEvent): string => {
    const bytes = ev.bytesDownloaded ?? 0
    const total = ev.totalBytes ?? null
    const elapsedSec = Math.max(0.05, (Date.now() - phaseStartAt) / 1000)
    const speedBps = bytes / elapsedSec
    const pct = total && total > 0 ? Math.min(100, (bytes / total) * 100) : null
    const label =
      ev.phase === 'downloading-video'
        ? 'Video'
        : ev.phase === 'downloading-audio'
          ? 'Audio'
          : 'Stream'
    const tag = `[${ev.client ?? '?'} / ${ev.protocol ?? 'http'}${ev.itag ? ` itag=${ev.itag}` : ''}]`

    return pct !== null
      ? `  ${label} ${pct.toFixed(1)}% | ${formatBytes(bytes)} / ${formatBytes(total)} | ${formatBytes(speedBps)}/s ${tag}`
      : `  ${label} ${formatBytes(bytes)} | ${formatBytes(speedBps)}/s ${tag}`
  }

  const fitTtyLine = (line: string): string => {
    if (!useTty) return line
    const cols = process.stdout.columns
    if (typeof cols === 'number' && cols > 8 && line.length >= cols) {
      return `${line.slice(0, cols - 2)}…`
    }
    return line
  }

  const flushPending = () => {
    if (
      lastEmittedProgress &&
      (lastEmittedProgress.bytesDownloaded ?? -1) > lastRenderedBytes
    ) {
      const line = fitTtyLine(formatLine(lastEmittedProgress))
      if (useTty) {
        process.stdout.write(`\r\x1b[K${line}\n`)
        hasActiveLine = false
      } else {
        console.log(line)
      }
      lastRenderedBytes = lastEmittedProgress.bytesDownloaded ?? -1
    } else if (hasActiveLine) {
      process.stdout.write('\n')
      hasActiveLine = false
    }
    lastEmittedProgress = null
  }

  const clearLine = () => {
    if (useTty && hasActiveLine) {
      process.stdout.write('\r\x1b[K')
      hasActiveLine = false
    }
  }

  return {
    onEvent(ev: DownloadProgressEvent): void {
      if (quiet) return
      const now = Date.now()
      const phaseKey = `${ev.videoId}:${ev.phase}:${ev.itag ?? ''}`
      if (phaseKey !== lastPhaseKey) {
        flushPending()
        lastPhaseKey = phaseKey
        phaseStartAt = now
        lastRenderAt = 0
        lastRenderedBytes = -1
      }

      if (ev.phase === 'resolving') {
        console.log(`Resolving: ${ev.trackTitle} (${ev.videoId})...`)
        return
      }
      if (ev.phase === 'probing') {
        console.log(`Probing clients: ${ev.detail || ''}`)
        return
      }
      if (ev.phase === 'muxing') {
        console.log(`Muxing with ffmpeg (${ev.detail || 'copy'})...`)
        return
      }
      if (ev.phase === 'done') {
        clearLine()
        return
      }

      const bytes = ev.bytesDownloaded ?? 0
      const total = ev.totalBytes ?? null
      const isDownloading =
        ev.phase === 'downloading-video' ||
        ev.phase === 'downloading-audio' ||
        ev.phase === 'downloading'
      if (!isDownloading) return

      lastEmittedProgress = ev
      const finishedChunk = total !== null && bytes >= total
      if (!finishedChunk && now - lastRenderAt < (useTty ? 120 : 1000)) {
        return
      }
      lastRenderAt = now
      lastRenderedBytes = bytes

      const line = fitTtyLine(formatLine(ev))

      if (useTty) {
        process.stdout.write(`\r\x1b[K${line}`)
        hasActiveLine = true
      } else {
        console.log(line)
      }
    },
    finish(): void {
      flushPending()
    }
  }
}

