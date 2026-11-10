import type { FormatInventoryResult } from '../types/index.ts'
import { formatBytes, formatDuration } from '../utils/format.ts'

function padRight(str: string, width: number): string {
  return str.length >= width
    ? str.slice(0, width)
    : str + ' '.repeat(width - str.length)
}

function padLeft(str: string, width: number): string {
  return str.length >= width ? str : ' '.repeat(width - str.length) + str
}

export function printFormatInventory(inv: FormatInventoryResult): void {
  console.log(`\nTitle:    ${inv.title}`)
  console.log(`Author:   ${inv.author}`)
  console.log(`Video ID: ${inv.videoId}`)
  console.log(`Duration: ${formatDuration(inv.durationMs)}`)
  console.log(`Client:   ${inv.client} (protocol: ${inv.protocol})`)
  if (inv.hlsUrl) {
    console.log(`HLS URL:  available`)
  }

  console.log('\nFormats:')
  const header = [
    padLeft('ITAG', 5),
    padRight('KIND', 12),
    padRight('EXT', 6),
    padRight('RES', 9),
    padRight('FPS', 4),
    padLeft('BITRATE', 10),
    padLeft('SIZE', 10),
    padRight('CODECS / INFO', 34)
  ].join('  ')
  console.log(header)
  console.log('-'.repeat(header.length))

  const sorted = [...inv.formats].sort((a, b) => {
    const order = { progressive: 0, 'video-only': 1, 'audio-only': 2 }
    if (order[a.kind] !== order[b.kind]) return order[a.kind] - order[b.kind]
    if ((b.height ?? 0) !== (a.height ?? 0)) return (b.height ?? 0) - (a.height ?? 0)
    return (b.bitrate ?? 0) - (a.bitrate ?? 0)
  })

  for (const f of sorted) {
    const res = f.height ? `${f.width ?? '?'}x${f.height}` : '-'
    const fps = f.fps ? String(f.fps) : '-'
    const kbps = f.bitrate ? `${Math.round(f.bitrate / 1000)}k` : '-'
    const size = f.contentLength ? formatBytes(f.contentLength) : '-'
    const extra: string[] = []
    if (f.codecs) extra.push(f.codecs)
    if (f.audioQuality) extra.push(f.audioQuality.replace('AUDIO_QUALITY_', ''))
    if (f.isDrc) extra.push('drc')
    if (f.audioTrackId) extra.push(`track=${f.audioTrackId}`)
    if (f.isCiphered) extra.push('cipher')
    else if (!f.hasDirectUrl) extra.push(inv.protocol === 'sabr' ? 'sabr' : 'no-url')

    console.log(
      [
        padLeft(String(f.itag), 5),
        padRight(f.kind, 12),
        padRight(f.container, 6),
        padRight(res, 9),
        padRight(fps, 4),
        padLeft(kbps, 10),
        padLeft(size, 10),
        extra.join(' ')
      ].join('  ')
    )
  }
  console.log('')
}

