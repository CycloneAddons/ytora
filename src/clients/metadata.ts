import { makeRequest } from '../network/httpClient.ts'
import {
  YOUTUBE_CONSTANTS,
  type YOUTUBE_CONSTANTS_TYPE,
  type HttpProxyConfig,
  type HttpRequestResult,
  type TrackData,
  type TrackEncodeInput,
  type TrackInfo,
  type YouTubeRenderer,
  type YouTubeText,
  type YouTubeTextRun
} from '../types/index.ts'
import { encodeTrack } from '../utils/format.ts'
import { logger } from '../utils/logger.ts'

export const YOUTUBE_WEBM_ITAGS = new Set([249, 250, 251])

const FALLBACK_TITLE = 'Unknown Title'
const FALLBACK_AUTHOR = 'Unknown Artist'

const URL_PATTERNS = {
  video: /^https?:\/\/(?:music\.)?(?:www\.)?youtube\.com\/watch\?v=[\w-]+/,
  musicVideo: /^https?:\/\/music\.youtube\.com\/watch\?v=[\w-]+/,
  playlist:
    /^https?:\/\/(?:music\.)?(?:www\.)?youtube\.com\/playlist\?list=[\w-]+/,
  shortUrl: /^https?:\/\/youtu\.be\/[\w-]+/,
  shorts: /^https?:\/\/(?:www\.)?youtube\.com\/shorts\/[\w-]+/,
  listParam: /[?&]list=/,
  videoId: /(?:v=|shorts\/|youtu\.be\/)([^&?]+)/,
  playlistId: /[?&]list=([\w-]+)/,
  videoIdParam: /[?&]v=([\w-]+)/
}

const TIME_UNIT_MULTIPLIERS = {
  year: 365.25 * 24 * 60 * 60 * 1000,
  month: 30.44 * 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  hour: 60 * 60 * 1000,
  minute: 60 * 1000,
  second: 1000
}

const TIME_UNIT_REGEX = /(\d+)\s*(year|month|week|day|hour|minute|second)/gi


// ============================================================================
// Common Metadata & URL Utilities
// ============================================================================

export function formatDurationInfo(ms: number | undefined): {
  ms: number
  formatted: string
  hms: string
} {
  if (!ms || ms === 0) return { ms: 0, formatted: 'LIVE', hms: 'LIVE' }
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const s = seconds % 60
  const m = minutes % 60
  const formatted =
    hours > 0
      ? `${hours}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`
  const hms = `${hours}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`
  return { ms, formatted, hms }
}

export function formatNumber(num: number): string {
  if (!num || Number.isNaN(num)) return '0'
  if (num >= 1000000000) return `${(num / 1000000000).toFixed(1)}B`
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`
  return String(num)
}

function safeString(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback
  return String(value)
}

export interface PublishedAtInfo {
  original: string
  timestamp: number
  date: string
  readable: string
  compact: string
  ago: {
    years: number
    months: number
    weeks: number
    days: number
    hours: number
    minutes: number
    seconds: number
  }
}

function _buildReadableTime(units: PublishedAtInfo['ago']): string {
  if (units.years > 0)
    return `${units.years} year${units.years > 1 ? 's' : ''} ago`
  if (units.months > 0)
    return `${units.months} month${units.months > 1 ? 's' : ''} ago`
  if (units.weeks > 0)
    return `${units.weeks} week${units.weeks > 1 ? 's' : ''} ago`
  if (units.days > 0) return `${units.days} day${units.days > 1 ? 's' : ''} ago`
  if (units.hours > 0)
    return `${units.hours} hour${units.hours > 1 ? 's' : ''} ago`
  if (units.minutes > 0)
    return `${units.minutes} minute${units.minutes > 1 ? 's' : ''} ago`
  if (units.seconds > 0)
    return `${units.seconds} second${units.seconds > 1 ? 's' : ''} ago`
  return 'just now'
}

function _buildPublishedAtFromTimestamp(
  timestamp: number,
  originalText: string
): PublishedAtInfo {
  const diff = Date.now() - timestamp
  const diffAbs = Math.abs(diff)
  const resultUnits = {
    years: 0,
    months: 0,
    weeks: 0,
    days: 0,
    hours: 0,
    minutes: 0,
    seconds: 0
  }

  if (diffAbs >= TIME_UNIT_MULTIPLIERS.year) {
    resultUnits.years = Math.floor(diffAbs / TIME_UNIT_MULTIPLIERS.year)
  } else if (diffAbs >= TIME_UNIT_MULTIPLIERS.month) {
    resultUnits.months = Math.floor(diffAbs / TIME_UNIT_MULTIPLIERS.month)
  } else if (diffAbs >= TIME_UNIT_MULTIPLIERS.week) {
    resultUnits.weeks = Math.floor(diffAbs / TIME_UNIT_MULTIPLIERS.week)
  } else if (diffAbs >= TIME_UNIT_MULTIPLIERS.day) {
    resultUnits.days = Math.floor(diffAbs / TIME_UNIT_MULTIPLIERS.day)
  } else if (diffAbs >= TIME_UNIT_MULTIPLIERS.hour) {
    resultUnits.hours = Math.floor(diffAbs / TIME_UNIT_MULTIPLIERS.hour)
  } else if (diffAbs >= TIME_UNIT_MULTIPLIERS.minute) {
    resultUnits.minutes = Math.floor(diffAbs / TIME_UNIT_MULTIPLIERS.minute)
  } else {
    resultUnits.seconds = Math.floor(diffAbs / TIME_UNIT_MULTIPLIERS.second)
  }

  return {
    original: originalText,
    timestamp: Math.floor(timestamp),
    date: new Date(timestamp).toISOString(),
    readable: _buildReadableTime(resultUnits),
    compact: `${resultUnits.years}y ${resultUnits.months}mo ${resultUnits.weeks}w ${resultUnits.days}d ${resultUnits.hours}h ${resultUnits.minutes}m ${resultUnits.seconds}s`,
    ago: resultUnits
  }
}

export function parsePublishedAt(
  publishedText: string | undefined | null
): PublishedAtInfo | null {
  if (!publishedText) return null
  const date = new Date(publishedText)
  if (!Number.isNaN(date.getTime())) {
    return _buildPublishedAtFromTimestamp(date.getTime(), publishedText)
  }

  const text = publishedText.toLowerCase()
  const units = {
    years: 0,
    months: 0,
    weeks: 0,
    days: 0,
    hours: 0,
    minutes: 0,
    seconds: 0
  }

  const regex = new RegExp(TIME_UNIT_REGEX.source, TIME_UNIT_REGEX.flags)
  for (const match of text.matchAll(regex)) {
    const valueStr = match[1]
    const unitStr = match[2]
    if (!valueStr || !unitStr) continue

    const value = parseInt(valueStr, 10)
    const unit = unitStr.toLowerCase()

    if (unit.startsWith('year')) units.years = value
    else if (unit.startsWith('month')) units.months = value
    else if (unit.startsWith('week')) units.weeks = value
    else if (unit.startsWith('day')) units.days = value
    else if (unit.startsWith('hour')) units.hours = value
    else if (unit.startsWith('minute')) units.minutes = value
    else if (unit.startsWith('second')) units.seconds = value
  }

  const msAgo =
    units.years * TIME_UNIT_MULTIPLIERS.year +
    units.months * TIME_UNIT_MULTIPLIERS.month +
    units.weeks * TIME_UNIT_MULTIPLIERS.week +
    units.days * TIME_UNIT_MULTIPLIERS.day +
    units.hours * TIME_UNIT_MULTIPLIERS.hour +
    units.minutes * TIME_UNIT_MULTIPLIERS.minute +
    units.seconds * TIME_UNIT_MULTIPLIERS.second

  const timestamp = Date.now() - msAgo
  return {
    original: publishedText,
    timestamp: Math.floor(timestamp),
    date: new Date(timestamp).toISOString(),
    readable: _buildReadableTime(units),
    compact: `${units.years}y ${units.months}mo ${units.weeks}w ${units.days}d ${units.hours}h ${units.minutes}m ${units.seconds}s`,
    ago: units
  }
}

export function getItemValue<T = unknown>(
  obj: unknown,
  paths: string[],
  defaultValue: T | null = null
): T | null {
  if (!obj || typeof obj !== 'object') return defaultValue
  for (const path of paths) {
    const value = path
      .split('.')
      .reduce<unknown>(
        (o, k) => (o as Record<string, unknown> | null)?.[k],
        obj
      )
    if (value !== undefined && value !== null) return value as T
  }
  return defaultValue
}

function getRunsText(runsArray: YouTubeTextRun[] | undefined): string | null {
  if (Array.isArray(runsArray) && runsArray.length > 0) {
    return runsArray.map((run) => run.text || '').join('')
  }
  return null
}

function extractMetadataFromResponse(
  fullApiResponse: Record<string, unknown>
): { title: string | null; author: string | null } {
  const metadata: { title: string | null; author: string | null } = {
    title: null,
    author: null
  }

  const vd = fullApiResponse.videoDetails as Record<string, unknown> | undefined
  if (vd) {
    if (typeof vd.title === 'string' && vd.title !== 'undefined')
      metadata.title = vd.title
    if (typeof vd.author === 'string' && vd.author !== 'undefined')
      metadata.author = vd.author
  }
  if (metadata.title && metadata.author) return metadata

  const microRoot = fullApiResponse.microformat as
    | Record<string, unknown>
    | undefined
  const mf = microRoot?.playerMicroformatRenderer as
    | Record<string, unknown>
    | undefined
  if (mf) {
    const titleObj = mf.title as YouTubeText | string | undefined
    const title =
      typeof titleObj === 'string'
        ? titleObj
        : getRunsText(titleObj?.runs) || titleObj?.simpleText
    if (title && !metadata.title) metadata.title = title
    if (typeof mf.ownerChannelName === 'string' && !metadata.author)
      metadata.author = mf.ownerChannelName
  }

  return metadata
}

async function fetchOEmbedMetadata(
  videoId: string
): Promise<{
  title: string | null
  author: string | null
  thumbnail_url: string | null
} | null> {
  try {
    const { body, statusCode } = await makeRequest(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      {
        method: 'GET',
        maxRedirects: 5
      }
    )

    if (statusCode === 200 && body && typeof body === 'object') {
      const b = body as Record<string, unknown>
      return {
        title: (b.title as string | undefined) || null,
        author: (b.author_name as string | undefined) || null,
        thumbnail_url: (b.thumbnail_url as string | undefined) || null
      }
    }
  } catch (e: unknown) {
    logger(
      'debug',
      'fetchOEmbedMetadata',
      `Failed to fetch oEmbed data: ${e instanceof Error ? e.message : String(e)}`
    )
  }
  return null
}

function extractTitle(
  renderer: YouTubeRenderer | undefined,
  fullApiResponse: Record<string, unknown> | null
): string | null {
  if (fullApiResponse) {
    const metadata = extractMetadataFromResponse(fullApiResponse)
    if (metadata.title) return metadata.title
  }

  if (typeof renderer?.title === 'string' && renderer.title !== 'undefined') {
    return renderer.title
  }

  const title =
    getRunsText((renderer?.title as YouTubeText | undefined)?.runs) ||
    getItemValue<string>(fullApiResponse, [
      'videoDetails.endscreen.endscreenRenderer.elements.1.endscreenElementRenderer.title.simpleText'
    ]) ||
    getItemValue<string>(renderer, ['title.simpleText'])

  if (title && title !== 'undefined') return title
  return null
}

function extractAuthor(
  renderer: YouTubeRenderer | undefined,
  fullApiResponse: Record<string, unknown> | null
): string | null {
  if (fullApiResponse) {
    const metadata = extractMetadataFromResponse(fullApiResponse)
    if (metadata.author) return metadata.author
  }

  if (renderer?.author && renderer.author !== 'undefined') {
    return renderer.author
  }

  const author =
    getRunsText(
      getItemValue<YouTubeTextRun[]>(renderer, [
        'longBylineText.runs',
        'shortBylineText.runs',
        'ownerText.runs'
      ]) ?? undefined
    ) || getItemValue<string>(fullApiResponse, ['videoDetails.author'])

  if (author && author !== 'undefined') return author
  return null
}

function extractThumbnail(
  renderer: YouTubeRenderer | undefined,
  videoId: string | null
): string | null {
  let resultUrl: string | null = null

  const musicThumbnails =
    renderer?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails
  const regularThumbnails = renderer?.thumbnail?.thumbnails

  if (Array.isArray(musicThumbnails) && musicThumbnails.length > 0) {
    const firstThumb = musicThumbnails[0]
    if (firstThumb?.url) {
      resultUrl = firstThumb.url.replace(/=.*/, '=w1000-h1000')
    }
  } else if (Array.isArray(regularThumbnails) && regularThumbnails.length > 0) {
    const lastThumb = regularThumbnails[regularThumbnails.length - 1]
    const url = lastThumb?.url
    if (url?.includes('maxresdefault')) {
      resultUrl = url
    }
  }

  if (!resultUrl && videoId) {
    resultUrl = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`
  }

  return resultUrl
}

interface AudioFormatInfo {
  itag: number
  mimeType: string
  bitrate: number
  averageBitrate: number | null
  audioQuality: string | null
  audioSampleRate: string | null
  audioChannels: number | null
  codec: string
  container: string | null
  contentLength: string | number | null
  loudnessDb: number | null
}

interface AudioTrackInfo {
  id: string
  name: string
  isDefault: boolean
  isAutoDubbed: boolean
}

function extractAudioFormats(
  streamingData: Record<string, unknown>
): AudioFormatInfo[] {
  if (!streamingData) return []
  const allFormats = [
    ...((streamingData.formats as unknown[] | undefined) || []),
    ...((streamingData.adaptiveFormats as unknown[] | undefined) || [])
  ]
  const qualityMap = new Map<string, AudioFormatInfo>()
  for (const formatRaw of allFormats) {
    const format = formatRaw as Record<string, unknown>
    if (
      (format.mimeType as string | undefined)?.startsWith('audio/') &&
      format.bitrate
    ) {
      const audioQuality =
        (format.audioQuality as string | undefined) || 'UNKNOWN'
      const existing = qualityMap.get(audioQuality)
      if (!existing || (format.bitrate as number) > existing.bitrate) {
        const mimeType = format.mimeType as string
        const codecMatch = mimeType.match(/codecs="([^"]+)"/)
        const codec = codecMatch?.[1] || 'unknown'
        qualityMap.set(audioQuality, {
          itag: format.itag as number,
          mimeType,
          bitrate: format.bitrate as number,
          averageBitrate: (format.averageBitrate as number | undefined) ?? null,
          audioQuality: (format.audioQuality as string | undefined) ?? null,
          audioSampleRate:
            (format.audioSampleRate as string | undefined) ?? null,
          audioChannels: (format.audioChannels as number | undefined) ?? null,
          codec,
          container: mimeType.split(';')[0]?.split('/')[1] ?? null,
          contentLength:
            (format.contentLength as string | number | undefined) ?? null,
          loudnessDb: (format.loudnessDb as number | undefined) ?? null
        })
      }
    }
  }
  return Array.from(qualityMap.values()).sort((a, b) => b.bitrate - a.bitrate)
}

function extractAudioTracks(
  streamingData: Record<string, unknown>
): AudioTrackInfo[] {
  if (!streamingData) return []
  const allFormats = [
    ...((streamingData.formats as unknown[] | undefined) || []),
    ...((streamingData.adaptiveFormats as unknown[] | undefined) || [])
  ]
  const tracksMap = new Map<string, AudioTrackInfo>()
  for (const formatRaw of allFormats) {
    const format = formatRaw as Record<string, unknown>
    const audioTrack = format.audioTrack as Record<string, unknown> | undefined
    if (audioTrack?.id) {
      const id = audioTrack.id as string
      if (!tracksMap.has(id)) {
        tracksMap.set(id, {
          id,
          name: (audioTrack.displayName as string) || id,
          isDefault: !!audioTrack.audioIsDefault,
          isAutoDubbed: !!audioTrack.isAutoDubbed
        })
      }
    }
  }
  return Array.from(tracksMap.values())
}

function extractCaptions(captionsData: Record<string, unknown>): Array<{
  languageCode: string
  name?: string
  isTranslatable: boolean
  baseUrl: string
  kind?: string
}> {
  const captionsRoot = captionsData?.playerCaptionsTracklistRenderer as
    | Record<string, unknown>
    | undefined
  const captionTracks = captionsRoot?.captionTracks as unknown[] | undefined
  if (!captionTracks) return []

  return captionTracks.map((cRaw) => {
    const c = cRaw as Record<string, unknown>
    return {
      languageCode: c.languageCode as string,
      name: (c.name as YouTubeText | undefined)?.simpleText,
      isTranslatable: !!c.isTranslatable,
      baseUrl: c.baseUrl as string,
      kind: c.kind as string | undefined
    }
  })
}

function parseLengthAndStream(
  lengthText: string | undefined | null,
  lengthSeconds: string | number | undefined | null,
  isLive: boolean | undefined | null
): { lengthMs: number; isStream: boolean } {
  if (isLive) return { lengthMs: -1, isStream: true }
  let lengthMs = 0
  let isStream = true

  if (lengthText && /[:\d]+/.test(lengthText)) {
    const parts = lengthText.split(':').map(Number)
    lengthMs = (parts.reduce((acc, val) => acc * 60 + val, 0) || 0) * 1000
    isStream = !Number.isFinite(lengthMs) || lengthMs <= 0
  } else if (lengthSeconds !== undefined && lengthSeconds !== null) {
    lengthMs = Number.parseInt(String(lengthSeconds), 10) * 1000
    isStream = !Number.isFinite(lengthMs) || lengthMs <= 0
  }
  return { lengthMs, isStream }
}

function getRendererFromItemData(
  itemData: YouTubeRenderer | null,
  itemType: string
): YouTubeRenderer | null {
  if (!itemData) return null

  if (itemType === 'ytmusic') {
    const data = getItemValue<YouTubeRenderer>(itemData, [
      'musicResponsiveListItemRenderer',
      'playlistPanelVideoRenderer',
      'musicTwoColumnItemRenderer'
    ])
    if (data) return { ...data, _type: 'track' }
  }

  const rendererTypes = [
    { key: 'videoRenderer', type: 'track' },
    { key: 'compactVideoRenderer', type: 'track' },
    { key: 'playlistRenderer', type: 'playlist' },
    { key: 'compactPlaylistRenderer', type: 'playlist' },
    { key: 'channelRenderer', type: 'channel' },
    { key: 'playlistPanelVideoRenderer', type: 'track' },
    { key: 'playlistVideoRenderer', type: 'track' },
    { key: 'gridVideoRenderer', type: 'track' }
  ]

  for (const r of rendererTypes) {
    const renderer = itemData[r.key] as YouTubeRenderer | undefined
    if (renderer) return { ...renderer, _type: r.type }
  }

  if (itemData.elementRenderer) {
    const model = getItemValue<Record<string, unknown>>(
      itemData.elementRenderer,
      ['newElement.type.componentType.model']
    )
    const data =
      ((model?.compactChannelModel as Record<string, unknown> | undefined)
        ?.compactChannelData as YouTubeRenderer | undefined) ||
      ((model?.compactPlaylistModel as Record<string, unknown> | undefined)
        ?.compactPlaylistData as YouTubeRenderer | undefined)

    if (data) {
      return {
        ...data,
        _type: model?.compactChannelModel ? 'channel' : 'playlist'
      }
    }
  }

  return itemData.videoId ? { ...itemData, _type: 'track' } : null
}

export interface YouTubeTrackData extends TrackData {
  info: TrackInfo
}

export async function buildTrack(
  itemData: YouTubeRenderer | null,
  itemType: string,
  sourceNameOverride: string | null = null,
  fullApiResponse: Record<string, unknown> | null = null
): Promise<YouTubeTrackData | null> {
  if (!itemData) {
    logger('warn', 'buildTrack', 'itemData is null or undefined')
    return null
  }

  const renderer = getRendererFromItemData(itemData, itemType)

  if (renderer?._type === 'channel') {
    const ch = renderer.channelRenderer || renderer
    const channelId =
      ch.channelId ||
      getItemValue<string>(ch, [
        'onTap.innertubeCommand.browseEndpoint.browseId'
      ]) ||
      getItemValue<string>(ch, [
        'endpoint.innertubeCommand.browseEndpoint.browseId'
      ])
    const title =
      (ch.attributedTitle as { content: string } | undefined)?.content ||
      (typeof ch.title === 'string'
        ? ch.title
        : getRunsText((ch.title as YouTubeText | undefined)?.runs) ||
          (ch.title as YouTubeText | undefined)?.simpleText) ||
      getRunsText((ch.displayName as YouTubeText | undefined)?.runs) ||
      FALLBACK_TITLE

    if (!channelId) return null

    const trackInfo: TrackInfo = {
      identifier: channelId,
      isSeekable: false,
      author: title,
      length: 0,
      isStream: false,
      position: 0,
      title,
      uri: `https://www.youtube.com/channel/${channelId}`,
      artworkUrl: extractThumbnail(ch, null) || null,
      isrc: null,
      sourceName: sourceNameOverride || 'youtube'
    }

    return {
      encoded: encodeTrack({ ...trackInfo, details: [] } as TrackEncodeInput),
      info: trackInfo,
      pluginInfo: {
        type: 'channel_result',
        videoCount: String(
          getRunsText((ch.videoCountText as YouTubeText | undefined)?.runs) ||
            (ch.videoCount as string | number | undefined) ||
            '0'
        ),
        subscriberCount: String(
          getRunsText(
            (ch.subscriberCountText as YouTubeText | undefined)?.runs
          ) ||
            (ch.subscriberCount as string | number | undefined) ||
            '0'
        ),
        handle: String(ch.handle ?? '')
      }
    }
  }

  if (renderer?._type === 'playlist') {
    const pl = renderer
    const playlistId = pl.playlistId
    const title =
      (pl.attributedTitle as { content: string } | undefined)?.content ||
      (typeof pl.title === 'string'
        ? pl.title
        : getRunsText((pl.title as YouTubeText | undefined)?.runs) ||
          (pl.title as YouTubeText | undefined)?.simpleText) ||
      FALLBACK_TITLE
    const author =
      (typeof pl.authorName === 'string'
        ? pl.authorName
        : getRunsText((pl.longBylineText as YouTubeText | undefined)?.runs) ||
          getRunsText((pl.shortBylineText as YouTubeText | undefined)?.runs)) ||
      FALLBACK_AUTHOR
    const videoCount =
      getRunsText((pl.videoCountText as YouTubeText | undefined)?.runs) ||
      (pl.videoCount as string | number | undefined) ||
      '0'

    if (!playlistId) return null

    const trackInfo: TrackInfo = {
      identifier: playlistId,
      isSeekable: false,
      author,
      length: 0,
      isStream: false,
      position: 0,
      title,
      uri: `https://www.youtube.com/playlist?list=${playlistId}`,
      artworkUrl: extractThumbnail(pl, null) || null,
      isrc: null,
      sourceName: sourceNameOverride || 'youtube'
    }

    return {
      encoded: encodeTrack({ ...trackInfo, details: [] } as TrackEncodeInput),
      info: trackInfo,
      pluginInfo: {
        type: 'playlist_result',
        videoCount: String(videoCount)
      }
    }
  }

  const videoId =
    getItemValue<string>(renderer, [
      'playlistItemData.videoId',
      'navigationEndpoint.watchEndpoint.videoId',
      'videoId'
    ]) ||
    itemData.videoId ||
    renderer?.videoId

  if (!videoId) {
    logger('warn', 'buildTrack', 'Could not extract videoId from item data')
    return null
  }

  let title = FALLBACK_TITLE
  let author = FALLBACK_AUTHOR
  let lengthMs = 0
  let isStream = true
  let artworkUrl: string | null = null
  let uri = ''

  if (itemType === 'ytmusic') {
    title = safeString(
      getRunsText(
        getItemValue<YouTubeTextRun[]>(renderer, ['title.runs']) ?? undefined
      ) ||
        getItemValue<string>(renderer, ['title.simpleText']) ||
        renderer?.title,
      FALLBACK_TITLE
    )

    if (title === FALLBACK_TITLE && Array.isArray(renderer?.flexColumns)) {
      const firstCol = renderer.flexColumns[0]
      title = safeString(
        getRunsText(
          firstCol?.musicResponsiveListItemFlexColumnRenderer?.text?.runs
        ),
        FALLBACK_TITLE
      )
    }

    const subtitleRuns = getItemValue<YouTubeTextRun[]>(renderer, [
      'subtitle.runs'
    ])
    const longBylineRuns = getItemValue<YouTubeTextRun[]>(renderer, [
      'longBylineText.runs'
    ])
    const shortBylineRuns = getItemValue<YouTubeTextRun[]>(renderer, [
      'shortBylineText.runs'
    ])

    if (Array.isArray(subtitleRuns) && subtitleRuns.length > 0) {
      author = safeString(subtitleRuns[0]?.text, FALLBACK_AUTHOR)
    } else if (Array.isArray(longBylineRuns) && longBylineRuns.length > 0) {
      author = safeString(longBylineRuns[0]?.text, FALLBACK_AUTHOR)
    } else if (Array.isArray(shortBylineRuns) && shortBylineRuns.length > 0) {
      author = safeString(shortBylineRuns[0]?.text, FALLBACK_AUTHOR)
    } else {
      author = safeString(renderer?.author, FALLBACK_AUTHOR)
    }

    if (author === FALLBACK_AUTHOR && Array.isArray(renderer?.flexColumns)) {
      const secondCol = renderer.flexColumns[1]
      author = safeString(
        secondCol?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]
          ?.text,
        FALLBACK_AUTHOR
      )
    }

    let lengthText: string | null = null
    if (Array.isArray(subtitleRuns)) {
      const lengthRun = subtitleRuns.find(
        (run) => run.text && /^\d{1,2}:\d{2}(:\d{2})?$/.test(run.text)
      )
      lengthText = lengthRun?.text || null
    }

    if (!lengthText) {
      lengthText =
        getItemValue<string>(renderer, ['lengthText.simpleText']) ||
        getRunsText(
          getItemValue<YouTubeTextRun[]>(renderer, ['lengthText.runs']) ??
            undefined
        )
    }

    if (!lengthText && Array.isArray(renderer?.flexColumns)) {
      for (const column of renderer.flexColumns) {
        const textObj = column.musicResponsiveListItemFlexColumnRenderer?.text
        if (Array.isArray(textObj?.runs)) {
          const found = textObj.runs.find(
            (run) => run.text && /^\d{1,2}:\d{2}(:\d{2})?$/.test(run.text)
          )
          if (found) {
            lengthText = found.text
            break
          }
        }
      }
    }

    const parsed = parseLengthAndStream(
      lengthText,
      itemData.lengthSeconds as string | number | undefined,
      itemData.isLive as boolean | undefined
    )
    lengthMs = parsed.lengthMs
    isStream = parsed.isStream

    artworkUrl = extractThumbnail(renderer || undefined, videoId)
    uri = `https://music.youtube.com/watch?v=${videoId}`
  } else {
    const extractedTitle = extractTitle(
      renderer || undefined,
      fullApiResponse
    )
    const extractedAuthor = extractAuthor(
      renderer || undefined,
      fullApiResponse
    )

    let oEmbedData: Awaited<ReturnType<typeof fetchOEmbedMetadata>> | null =
      null
    if (!!fullApiResponse && (extractedTitle === null || extractedAuthor === null)) {
      try {
        oEmbedData = await fetchOEmbedMetadata(videoId)
      } catch {
        // Ignore oEmbed failure
      }
    }

    title = safeString(oEmbedData?.title ?? extractedTitle, FALLBACK_TITLE)
    author = safeString(oEmbedData?.author ?? extractedAuthor, FALLBACK_AUTHOR)

    if (oEmbedData?.thumbnail_url && !artworkUrl) {
      artworkUrl = oEmbedData.thumbnail_url.includes('hqdefault.jpg')
        ? oEmbedData.thumbnail_url.replace('hqdefault.jpg', 'mqdefault.jpg')
        : oEmbedData.thumbnail_url
    }

    const lengthText =
      getItemValue<string>(renderer, ['lengthText.simpleText']) ||
      getRunsText((renderer?.lengthText as YouTubeText | undefined)?.runs)

    const parsed = parseLengthAndStream(
      lengthText,
      renderer?.lengthSeconds as string | number | undefined,
      renderer?.isLive as boolean | undefined
    )
    lengthMs = parsed.lengthMs
    isStream = parsed.isStream

    artworkUrl = artworkUrl || extractThumbnail(renderer || undefined, videoId)
    uri = `https://www.youtube.com/watch?v=${videoId}`
  }

  let sourceName = sourceNameOverride
  if (!sourceName) {
    sourceName = uri.includes('music.youtube.com') ? 'ytmusic' : 'youtube'
  }

  const trackInfo: TrackInfo = {
    identifier: videoId,
    isSeekable: !isStream,
    author: safeString(author, FALLBACK_AUTHOR),
    length: lengthMs,
    isStream,
    position: 0,
    title: safeString(title, FALLBACK_TITLE),
    uri: safeString(uri, `https://www.youtube.com/watch?v=${videoId}`),
    artworkUrl: artworkUrl || null,
    isrc: null,
    sourceName: safeString(sourceName, 'youtube')
  }

  const streamingData = fullApiResponse?.streamingData as
    | Record<string, unknown>
    | undefined

  return {
    encoded: encodeTrack({ ...trackInfo, details: [] } as TrackEncodeInput),
    info: trackInfo,
    pluginInfo: {
      captions: JSON.stringify(
        extractCaptions(
          (fullApiResponse?.captions as Record<string, unknown>) ?? {}
        )
      ),
      audioFormats: JSON.stringify(
        streamingData ? extractAudioFormats(streamingData) : []
      ),
      audioTracks: JSON.stringify(
        streamingData ? extractAudioTracks(streamingData) : []
      )
    }
  }
}

export function checkURLType(url: string, type: string): YOUTUBE_CONSTANTS_TYPE {
  const isMusicSource = type === 'ytmusic'

  if (URL_PATTERNS.listParam.test(url)) {
    return YOUTUBE_CONSTANTS.PLAYLIST
  }

  if (isMusicSource) {
    if (URL_PATTERNS.musicVideo.test(url)) return YOUTUBE_CONSTANTS.VIDEO
  } else {
    if (URL_PATTERNS.video.test(url)) return YOUTUBE_CONSTANTS.VIDEO
    if (URL_PATTERNS.shorts.test(url)) return YOUTUBE_CONSTANTS.SHORTS
    if (URL_PATTERNS.shortUrl.test(url)) return YOUTUBE_CONSTANTS.VIDEO
  }

  return YOUTUBE_CONSTANTS.UNKNOWN
}

export interface YouTubePlaylistSelection {
  playlistId: string | null
  videoId: string | null
  targetIndex: number | null
}

export function extractPlaylistSelection(url: string): YouTubePlaylistSelection {
  let playlistId: string | null = null
  let videoId: string | null = null
  let targetIndex: number | null = null

  try {
    const parsed = new URL(url)
    const listParam = parsed.searchParams.get('list')
    if (listParam && /^[\w-]+$/.test(listParam)) playlistId = listParam

    const vParam = parsed.searchParams.get('v')
    if (vParam && /^[\w-]+$/.test(vParam)) {
      videoId = vParam
    } else if (
      parsed.hostname === 'youtu.be' ||
      parsed.hostname.endsWith('.youtu.be')
    ) {
      const pathId = parsed.pathname.slice(1).split('/')[0]
      if (pathId && /^[\w-]+$/.test(pathId)) videoId = pathId
    } else if (
      parsed.pathname.startsWith('/embed/') ||
      parsed.pathname.startsWith('/v/') ||
      parsed.pathname.startsWith('/shorts/') ||
      parsed.pathname.startsWith('/live/')
    ) {
      const segments = parsed.pathname.split('/').filter(Boolean)
      const candidate = segments[1]
      if (candidate && /^[\w-]+$/.test(candidate)) videoId = candidate
    }

    const indexParam = parsed.searchParams.get('index')
    if (indexParam && /^\d+$/.test(indexParam)) {
      const parsedNum = parseInt(indexParam, 10)
      targetIndex = parsedNum >= 1 ? parsedNum - 1 : 0
    }
  } catch {
    const listMatch = url.match(/[?&]list=([\w-]+)/)
    if (listMatch?.[1]) playlistId = listMatch[1]

    const vMatch = url.match(/[?&]v=([\w-]+)/)
    if (vMatch?.[1]) {
      videoId = vMatch[1]
    } else {
      const shortMatch = url.match(
        /(?:youtu\.be\/|(?:\/(?:embed|v|shorts|live)\/))([\w-]+)/
      )
      if (shortMatch?.[1]) videoId = shortMatch[1]
    }

    const indexMatch = url.match(/[?&]index=(\d+)/)
    if (indexMatch?.[1]) {
      const parsedNum = parseInt(indexMatch[1], 10)
      targetIndex = parsedNum >= 1 ? parsedNum - 1 : 0
    }
  }

  return { playlistId, videoId, targetIndex }
}

export function resolveSelectedTrackIndex(
  tracks: readonly YouTubeTrackData[],
  currentVideoId?: string | null,
  targetIndex?: number | null
): number {
  if (
    typeof targetIndex === 'number' &&
    targetIndex >= 0 &&
    targetIndex < tracks.length &&
    currentVideoId &&
    tracks[targetIndex]?.info?.identifier === currentVideoId
  ) {
    return targetIndex
  }

  if (currentVideoId) {
    const foundIndex = tracks.findIndex(
      (t) => t.info?.identifier === currentVideoId
    )
    if (foundIndex !== -1) return foundIndex
  }

  if (
    typeof targetIndex === 'number' &&
    targetIndex >= 0 &&
    targetIndex < tracks.length
  ) {
    return targetIndex
  }

  return 0
}

export async function fetchEmbedConfig(
  videoId: string,
  proxy?: HttpProxyConfig
): Promise<{
  encryptedHostFlags: string | null
  visitorData: string | null
} | null> {
  try {
    const embedUrl = `https://www.youtube.com/embed/${videoId}`
    const { body, statusCode, error }: HttpRequestResult = await makeRequest(
      embedUrl,
      {
        method: 'GET',
        headers: {
          Referer: 'https://www.google.com',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'
        },
        proxy
      }
    )

    if (error || statusCode !== 200 || !body || typeof body !== 'string') {
      logger(
        'warn',
        'fetchEncryptedHostFlags',
        `Failed to fetch embed page: ${statusCode} - ${error ?? 'Unknown error'}`
      )
      return null
    }
    return {
      encryptedHostFlags:
        body.match(/"encryptedHostFlags"\s*:\s*"([^"]+)"/)?.[1] ?? null,
      visitorData: body.match(/"VISITOR_DATA"\s*:\s*"([^"]+)"/)?.[1] ?? null
    }
  } catch (e: unknown) {
    logger(
      'error',
      'fetchEncryptedHostFlags',
      `Error fetching encryptedHostFlags: ${e instanceof Error ? e.message : String(e)}`
    )
    return null
  }
}

export async function fetchEncryptedHostFlags(
  videoId: string
): Promise<string | null> {
  return (await fetchEmbedConfig(videoId))?.encryptedHostFlags ?? null
}
