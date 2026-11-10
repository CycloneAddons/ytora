import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TrackEncodeInput } from '../types/index.ts'

export function encodeTrack(track: TrackEncodeInput): string {
  if (!track || typeof track !== 'object') {
    throw new Error('Encode Error: Input track must be a valid object')
  }

  const encodeModifiedUTF8 = (value: string): Buffer => {
    const str = String(value)
    const bytes: number[] = []
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i)
      if (ch >= 0x0001 && ch <= 0x007f) {
        bytes.push(ch)
      } else if (ch === 0x0000 || (ch >= 0x0080 && ch <= 0x07ff)) {
        bytes.push(0xc0 | ((ch >> 6) & 0x1f))
        bytes.push(0x80 | (ch & 0x3f))
      } else {
        bytes.push(0xe0 | ((ch >> 12) & 0x0f))
        bytes.push(0x80 | ((ch >> 6) & 0x3f))
        bytes.push(0x80 | (ch & 0x3f))
      }
    }
    if (bytes.length > 65535) {
      throw new Error('Encode Error: UTF string too long')
    }
    const lenBuf = Buffer.alloc(2)
    lenBuf.writeUInt16BE(bytes.length)
    return Buffer.concat([lenBuf, Buffer.from(bytes)])
  }

  const chunks: Buffer[] = []
  const push = (b: Buffer): void => {
    chunks.push(b)
  }
  const writeByte = (v: number): void => push(Buffer.from([v & 0xff]))
  const writeLong = (v: number): void => {
    const b = Buffer.alloc(8)
    b.writeBigInt64BE(BigInt(v))
    push(b)
  }
  const writeUTF = (v: string): void => push(encodeModifiedUTF8(v))
  const writeNullableText = (v: string | null | undefined): void => {
    if (v === undefined || v === null) {
      writeByte(0)
    } else {
      writeByte(1)
      writeUTF(String(v))
    }
  }

  const version = track.artworkUrl || track.isrc ? 3 : track.uri ? 2 : 1
  const flags = 1

  writeByte(version)
  writeUTF(track.title)
  writeUTF(track.author)
  writeLong(track.length)
  writeUTF(track.identifier)
  writeByte(track.isStream ? 1 : 0)

  if (version >= 2) writeNullableText(track.uri ?? null)
  if (version >= 3) {
    writeNullableText(track.artworkUrl ?? null)
    writeNullableText(track.isrc ?? null)
  }

  writeUTF(track.sourceName)
  if (Array.isArray(track.details)) {
    for (const detail of track.details) writeNullableText(detail)
  }
  writeLong(track.position ?? 0)

  const messageBuf = Buffer.concat(chunks)
  const header = (messageBuf.length & 0x3fffffff) | ((flags & 0x3) << 30)
  const headerBuf = Buffer.alloc(4)
  headerBuf.writeInt32BE(header)
  return Buffer.concat([headerBuf, messageBuf]).toString('base64')
}

export function capTotalTracks(total: number, max: unknown): number {
  return typeof max === 'number' && Number.isFinite(max) && max > 0
    ? Math.min(total, max)
    : total
}

export function sanitizeFilename(name: string, fallback = 'video'): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
  return cleaned.slice(0, 180) || fallback
}

export function resolveFilenameTemplate(
  template: string | undefined,
  vars: {
    title: string
    id: string
    author: string
    quality?: string | null
    ext: string
  }
): string {
  const raw = template?.trim() || '{title} [{id}]'
  const base = raw
    .replaceAll('{title}', sanitizeFilename(vars.title, vars.id))
    .replaceAll('{id}', sanitizeFilename(vars.id, 'video'))
    .replaceAll('{author}', sanitizeFilename(vars.author, 'unknown'))
    .replaceAll('{quality}', sanitizeFilename(vars.quality || '', 'auto'))
    .replaceAll('{ext}', vars.ext.replace(/^\./, ''))
  const cleanExt = vars.ext.replace(/^\./, '')
  if (base.toLowerCase().endsWith(`.${cleanExt.toLowerCase()}`)) {
    return (
      sanitizeFilename(base.slice(0, -(cleanExt.length + 1)), vars.id) +
      `.${cleanExt}`
    )
  }
  return `${sanitizeFilename(base, vars.id)}.${cleanExt}`
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) {
    return '?'
  }
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let val = bytes / 1024
  let idx = 0
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024
    idx++
  }
  return `${val.toFixed(val >= 100 ? 0 : val >= 10 ? 1 : 2)} ${units[idx]}`
}

export function resolvePackageRoot(metaUrl: string): string {
  let dir = path.dirname(fileURLToPath(metaUrl))
  for (let i = 0; i < 3; i++) {
    const base = path.basename(dir)
    if (base === 'src' || base === 'dist') {
      return path.dirname(dir)
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.dirname(fileURLToPath(metaUrl))
}

export function formatDuration(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return '0:00'
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${m}:${String(s).padStart(2, '0')}`
}

