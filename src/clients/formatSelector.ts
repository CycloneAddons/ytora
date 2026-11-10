import type {
  AudioQualityPref,
  CodecPref,
  FormatEntry,
  FormatSummary,
  StreamSelectionSpec,
  VideoQualityPref,
  YouTubeFormat
} from '../types/index.ts'

// ============================================================================
// Normalized Format & Selection Helpers (Audio, Progressive, Adaptive Video+Audio)
// ============================================================================

export interface NormalizedFormat extends YouTubeFormat {
  isAdaptive: boolean
}

export function parseQualityHeight(
  quality?: VideoQualityPref | string | null
): number | null {
  if (!quality || quality === 'best') return null
  const match = /^(\d{3,4})p?$/i.exec(String(quality).trim())
  if (!match?.[1]) return null
  const num = Number.parseInt(match[1], 10)
  return Number.isFinite(num) && num > 0 ? num : null
}

export function extractContainerFromMime(mimeType?: string): string {
  if (!mimeType) return 'unknown'
  const base = mimeType.split(';')[0]?.trim().toLowerCase() ?? ''
  const parts = base.split('/')
  return parts[1] || base || 'unknown'
}

export function extractCodecsFromMime(mimeType?: string): string {
  if (!mimeType) return ''
  const match = mimeType.match(/codecs="([^"]+)"/i)
  return match?.[1]?.trim() ?? ''
}

export function parseContentLengthValue(val: unknown): number | null {
  if (typeof val === 'number' && Number.isFinite(val) && val > 0) return val
  if (typeof val === 'string' && /^\d+$/.test(val.trim())) {
    const parsed = Number.parseInt(val.trim(), 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }
  return null
}

export function matchesCodecPref(
  mimeType: string | undefined,
  pref: CodecPref = 'any'
): boolean {
  if (!mimeType) return false
  if (pref === 'any') return true
  const codecs = extractCodecsFromMime(mimeType).toLowerCase()
  if (pref === 'h264') return codecs.includes('avc1') || codecs.includes('avc')
  if (pref === 'vp9') return codecs.includes('vp9') || codecs.includes('vp09')
  if (pref === 'av1') return codecs.includes('av01') || codecs.includes('av1')
  return true
}

function getVideoCodecRank(mimeType?: string): number {
  const codecs = extractCodecsFromMime(mimeType).toLowerCase()
  if (codecs.includes('avc1')) return 3 // Prefer H.264 for universal MP4 at equal res+fps
  if (codecs.includes('vp9') || codecs.includes('vp09')) return 2
  if (codecs.includes('av01')) return 1
  return 0
}

export function summarizeFormat(
  f: Partial<NormalizedFormat> & { itag: number }
): FormatSummary {
  const mime = f.mimeType || f.mime_type || ''
  const codecs = extractCodecsFromMime(mime)
  const container = extractContainerFromMime(mime)
  const hasCommaCodecs = codecs.includes(',')
  let kind: FormatSummary['kind'] = 'video-only'
  if (mime.startsWith('audio/')) {
    kind = 'audio-only'
  } else if (f.isAdaptive === false || hasCommaCodecs) {
    kind = 'progressive'
  }

  return {
    itag: f.itag,
    kind,
    mimeType: mime,
    container,
    codecs,
    qualityLabel: f.qualityLabel || f.quality_label || null,
    width: typeof f.width === 'number' ? f.width : null,
    height: typeof f.height === 'number' ? f.height : null,
    fps: typeof f.fps === 'number' ? f.fps : null,
    bitrate: typeof f.bitrate === 'number' ? f.bitrate : null,
    averageBitrate:
      typeof (f.averageBitrate ?? f.average_bitrate) === 'number'
        ? ((f.averageBitrate ?? f.average_bitrate) as number)
        : null,
    audioQuality: f.audioQuality || f.audio_quality || null,
    audioChannels:
      typeof f.audioChannels === 'number' ? f.audioChannels : null,
    audioTrackId:
      f.audioTrack?.id ||
      (typeof f.audioTrackId === 'string' ? f.audioTrackId : null),
    audioIsDefault: Boolean(
      f.audioTrack?.audioIsDefault ?? f.audioIsDefault ?? false
    ),
    contentLength: parseContentLengthValue(f.contentLength ?? f.content_length),
    isCiphered: Boolean(f.signatureCipher || f.cipher),
    hasDirectUrl: Boolean(f.url),
    isDrc: Boolean(f.isDrc)
  }
}

export function normalizePlayerFormats(
  streamingData: Record<string, unknown>
): NormalizedFormat[] {
  const prog = ((streamingData.formats as unknown[] | undefined) || []).map(
    (raw): NormalizedFormat => {
      const f = raw as Record<string, unknown>
      return {
        ...(f as YouTubeFormat),
        itag: Number(f.itag),
        mimeType: (f.mimeType || f.mime_type) as string | undefined,
        qualityLabel: (f.qualityLabel || f.quality_label) as
          | string
          | undefined,
        audioQuality: (f.audioQuality || f.audio_quality) as
          | string
          | undefined,
        averageBitrate: (f.averageBitrate ?? f.average_bitrate) as
          | number
          | undefined,
        contentLength: (f.contentLength ?? f.content_length) as
          | string
          | number
          | undefined,
        lastModified: (f.lastModified ?? f.last_modified_ms) as
          | string
          | undefined,
        isAdaptive: false
      }
    }
  )

  const adaptive = (
    ((streamingData.adaptiveFormats || streamingData.adaptive_formats) as
      | unknown[]
      | undefined) || []
  ).map((raw): NormalizedFormat => {
    const f = raw as Record<string, unknown>
    return {
      ...(f as YouTubeFormat),
      itag: Number(f.itag),
      mimeType: (f.mimeType || f.mime_type) as string | undefined,
      qualityLabel: (f.qualityLabel || f.quality_label) as
        | string
        | undefined,
      audioQuality: (f.audioQuality || f.audio_quality) as
        | string
        | undefined,
      averageBitrate: (f.averageBitrate ?? f.average_bitrate) as
        | number
        | undefined,
      contentLength: (f.contentLength ?? f.content_length) as
        | string
        | number
        | undefined,
      lastModified: (f.lastModified ?? f.last_modified_ms) as
        | string
        | undefined,
      isAdaptive: true
    }
  })

  return [...adaptive, ...prog]
}

export function filterAudioTrackFormats<
  T extends {
    mimeType?: string
    audioTrack?: { id?: string; audioIsDefault?: boolean }
    audioTrackId?: string
    audioIsDefault?: boolean
  }
>(formats: T[], requestedTrackId?: string): { filtered: T[]; missing: boolean } {
  const audioFormats = formats.filter((f) => f.mimeType?.startsWith('audio/'))
  const nonAudioFormats = formats.filter(
    (f) => !f.mimeType?.startsWith('audio/')
  )

  if (requestedTrackId) {
    const matched = audioFormats.filter(
      (f) => (f.audioTrack?.id || f.audioTrackId) === requestedTrackId
    )
    if (matched.length > 0) {
      return { filtered: [...nonAudioFormats, ...matched], missing: false }
    }
    const hasTracks = audioFormats.some(
      (f) => Boolean(f.audioTrack || f.audioTrackId)
    )
    if (hasTracks) {
      return { filtered: formats, missing: true }
    }
    return { filtered: formats, missing: false }
  }

  const defaultAudio = audioFormats.filter(
    (f) => Boolean(f.audioTrack?.audioIsDefault ?? f.audioIsDefault)
  )
  if (defaultAudio.length > 0) {
    return { filtered: [...nonAudioFormats, ...defaultAudio], missing: false }
  }
  return { filtered: formats, missing: false }
}

const AUDIO_ITAG_PRIORITIES: Record<AudioQualityPref, number[]> = {
  high: [251, 250, 140],
  medium: [250, 140],
  low: [249, 250, 140],
  lowest: [249, 139]
}

const MP4_AUDIO_PRIORITIES: Record<AudioQualityPref, number[]> = {
  high: [140, 141, 139],
  medium: [140, 139],
  low: [139, 140],
  lowest: [139, 140]
}

const WEBM_AUDIO_PRIORITIES: Record<AudioQualityPref, number[]> = {
  high: [251, 250, 249],
  medium: [250, 249, 251],
  low: [249, 250, 251],
  lowest: [249, 250]
}

export function selectVideoCandidates<
  T extends {
    itag: number
    mimeType?: string
    height?: number
    width?: number
    fps?: number
    bitrate?: number
    isAdaptive?: boolean
  }
>(formats: T[], selection: StreamSelectionSpec): T[] {
  const cap =
    selection.maxHeight ?? parseQualityHeight(selection.videoQuality) ?? Infinity
  const codecPref = selection.codec ?? 'any'

  const allVideoOnly = formats.filter((f) => {
    if (!f.mimeType?.startsWith('video/')) return false
    const codecs = extractCodecsFromMime(f.mimeType)
    if (f.isAdaptive === false || codecs.includes(',')) return false
    return true
  })

  const filtered = allVideoOnly.filter((f) =>
    matchesCodecPref(f.mimeType, codecPref)
  )
  const pool = filtered.length > 0 ? filtered : codecPref === 'any' ? allVideoOnly : []

  if (pool.length === 0) return []

  const getH = (f: T) => (typeof f.height === 'number' ? f.height : 0)
  const getFps = (f: T) => (typeof f.fps === 'number' ? f.fps : 0)
  const getBr = (f: T) => (typeof f.bitrate === 'number' ? f.bitrate : 0)

  const withinCap = pool.filter((f) => getH(f) <= cap || cap === Infinity)
  const aboveCap = pool.filter((f) => getH(f) > cap && cap !== Infinity)

  withinCap.sort((a, b) => {
    if (getH(b) !== getH(a)) return getH(b) - getH(a)
    if (getFps(b) !== getFps(a)) return getFps(b) - getFps(a)
    if (codecPref === 'any') {
      const rankDiff = getVideoCodecRank(b.mimeType) - getVideoCodecRank(a.mimeType)
      if (rankDiff !== 0) return rankDiff
    }
    return getBr(b) - getBr(a)
  })

  // If no format fits within cap, pick lowest height above cap first
  aboveCap.sort((a, b) => {
    if (getH(a) !== getH(b)) return getH(a) - getH(b)
    if (getFps(b) !== getFps(a)) return getFps(b) - getFps(a)
    if (codecPref === 'any') {
      const rankDiff = getVideoCodecRank(b.mimeType) - getVideoCodecRank(a.mimeType)
      if (rankDiff !== 0) return rankDiff
    }
    return getBr(b) - getBr(a)
  })

  return [...withinCap, ...aboveCap]
}

export function selectCompatibleAudioCandidates<
  T extends {
    itag: number
    mimeType?: string
    bitrate?: number
    isDrc?: boolean
  }
>(
  formats: T[],
  videoMimeType: string | undefined,
  audioQuality: AudioQualityPref = 'high',
  preferContainer: 'mp4' | 'webm' | 'any' = 'any'
): T[] {
  const audioFormats = formats.filter((f) => f.mimeType?.startsWith('audio/'))
  if (audioFormats.length === 0) return []

  const videoIsWebm =
    preferContainer === 'webm' ||
    (preferContainer === 'any' && Boolean(videoMimeType?.toLowerCase().includes('webm')))
  const videoIsMp4 =
    preferContainer === 'mp4' ||
    (preferContainer === 'any' && Boolean(videoMimeType?.toLowerCase().includes('mp4')))

  const primaryItags = videoIsMp4
    ? MP4_AUDIO_PRIORITIES[audioQuality]
    : videoIsWebm
      ? WEBM_AUDIO_PRIORITIES[audioQuality]
      : AUDIO_ITAG_PRIORITIES[audioQuality]

  const secondaryItags = videoIsMp4
    ? WEBM_AUDIO_PRIORITIES[audioQuality]
    : videoIsWebm
      ? MP4_AUDIO_PRIORITIES[audioQuality]
      : []

  const priorityOrder = [...new Set([...primaryItags, ...secondaryItags])]

  return [...audioFormats].sort((a, b) => {
    const aSameContainer = videoIsMp4
      ? Boolean(a.mimeType?.includes('mp4'))
      : videoIsWebm
        ? Boolean(a.mimeType?.includes('webm'))
        : false
    const bSameContainer = videoIsMp4
      ? Boolean(b.mimeType?.includes('mp4'))
      : videoIsWebm
        ? Boolean(b.mimeType?.includes('webm'))
        : false

    if (aSameContainer !== bSameContainer) return aSameContainer ? -1 : 1

    const aIdx = priorityOrder.indexOf(a.itag)
    const bIdx = priorityOrder.indexOf(b.itag)
    if (aIdx !== -1 && bIdx !== -1) {
      if (aIdx !== bIdx) return aIdx - bIdx
      // Prefer non-DRC when itags tie (some clients expose DRC with same itag + xtags)
      if (Boolean(a.isDrc) !== Boolean(b.isDrc)) return a.isDrc ? 1 : -1
      return (b.bitrate || 0) - (a.bitrate || 0)
    }
    if (aIdx !== -1) return -1
    if (bIdx !== -1) return 1

    if (audioQuality === 'low' || audioQuality === 'lowest') {
      return (a.bitrate || 0) - (b.bitrate || 0)
    }
    return (b.bitrate || 0) - (a.bitrate || 0)
  })
}

export function selectProgressiveCandidates<
  T extends {
    itag: number
    mimeType?: string
    height?: number
    bitrate?: number
    isAdaptive?: boolean
  }
>(formats: T[], maxHeight: number | null = null): T[] {
  const prog = formats.filter((f) => {
    const codecs = extractCodecsFromMime(f.mimeType)
    return f.isAdaptive === false || (f.mimeType?.startsWith('video/') && codecs.includes(','))
  })
  if (prog.length === 0) return []

  const cap = maxHeight ?? Infinity
  return [...prog].sort((a, b) => {
    const aH = a.height ?? (a.itag === 22 ? 720 : a.itag === 18 ? 360 : 0)
    const bH = b.height ?? (b.itag === 22 ? 720 : b.itag === 18 ? 360 : 0)
    const aFits = aH <= cap
    const bFits = bH <= cap
    if (aFits !== bFits) return aFits ? -1 : 1
    if (aFits) {
      if (bH !== aH) return bH - aH
    } else {
      if (aH !== bH) return aH - bH
    }
    return (b.bitrate || 0) - (a.bitrate || 0)
  })
}

export interface ResolvedStreamComponent {
  itag: number
  url?: string
  mimeType?: string
  format: string | null
  qualityLabel: string | null
  width: number | null
  height: number | null
  fps: number | null
  bitrate: number | null
  contentLength: number | null
}

export interface MediaExtractionResult {
  loadType?: 'error'
  exception?: {
    message: string
    severity: string
    cause?: string
    status?: number
  }
  protocol?: string | null
  mode?: 'audio' | 'video' | 'progressive'
  url?: string
  format?: string | null
  itag?: number
  contentLength?: number | null
  hlsUrl?: string | null
  formats?: FormatEntry[]
  video?: ResolvedStreamComponent
  audio?: ResolvedStreamComponent
  progressive?: ResolvedStreamComponent
  additionalData?: Record<string, unknown>
}

export function toFormatEntries(formats: NormalizedFormat[]): FormatEntry[] {
  return formats.map((f) => ({
    itag: f.itag,
    mimeType: f.mimeType,
    bitrate: f.bitrate,
    averageBitrate: f.averageBitrate,
    width: f.width,
    height: f.height,
    fps: f.fps,
    quality: f.quality,
    qualityLabel: f.qualityLabel,
    audioQuality: f.audioQuality,
    audioTrackId: f.audioTrack?.id,
    audioIsDefault: Boolean(f.audioTrack?.audioIsDefault),
    approxDurationMs: f.approxDurationMs ?? f.approx_duration_ms,
    contentLength: f.contentLength,
    xtags: f.xtags,
    lastModified: f.lastModified,
    isDrc: Boolean(f.isDrc),
    isAdaptive: f.isAdaptive
  }))
}

export function resolveFormatString(
  mimeType: string | undefined,
  isStream = false
): string | null {
  if (!mimeType) return null
  const lowerMime = mimeType.toLowerCase()
  if (lowerMime.includes('opus')) return 'webm/opus'
  if (lowerMime.includes('mp4')) return 'mp4'
  if (lowerMime.includes('webm')) return 'webm'
  if (lowerMime.includes('mp3')) return 'mp3'
  if (lowerMime.includes('aac')) return 'aac'
  if (isStream) return 'mpegts'
  return null
}
