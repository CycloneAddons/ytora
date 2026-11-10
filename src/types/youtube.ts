import type { Readable } from 'node:stream'
import type {
  ICachedPlayerScript,
  ProxySnapshot,
  SourceException,
  TrackInfo
} from './common.ts'
import type { PreviousSessionState } from './sabr.ts'

export interface YouTubeContext {
  client: {
    screenDensityFloat?: number
    screenHeightPoints?: number
    screenPixelDensity?: number
    screenWidthPoints?: number
    hl: string
    gl: string
    visitorData: string | null
    clientName?: string
    clientVersion?: string
    platform?: string
    osName?: string
    utcOffsetMinutes?: number
    osVersion?: string
    userAgent?: string
    clientFormFactor?: string
    userInterfaceTheme?: string
    browserName?: string
    browserVersion?: string
  }
}

export interface ICipherManager {
  getCachedPlayerScript(): Promise<ICachedPlayerScript | null>
  getTimestamp(playerUrl: string): Promise<string>
  resolveUrl(
    streamUrl: string,
    encryptedSignature: string | null,
    nParam: string | null,
    signatureKey: string | null,
    playerScript: ICachedPlayerScript,
    context?: YouTubeContext
  ): Promise<string>
}

export interface YouTubeClientContext {
  client: {
    clientName: string
    clientVersion: string
    platform?: string
    userAgent: string
    hl: string
    gl: string
    visitorData?: string | null
    [key: string]: unknown
  }
  user?: {
    lockedSafetyMode?: boolean
    [key: string]: unknown
  }
  request?: {
    useSsl?: boolean
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface YouTubeThumbnail {
  url: string
  width?: number
  height?: number
}

export interface YouTubeTextRun {
  text: string
  navigationEndpoint?: unknown
}

export interface YouTubeText {
  runs?: YouTubeTextRun[]
  simpleText?: string
}

export interface YouTubeRenderer {
  videoId?: string
  playlistId?: string
  channelId?: string
  title?: string | YouTubeText
  author?: string
  thumbnail?: {
    thumbnails?: YouTubeThumbnail[]
    musicThumbnailRenderer?: {
      thumbnail?: {
        thumbnails?: YouTubeThumbnail[]
      }
    }
  }
  lengthText?: YouTubeText
  lengthSeconds?: string | number
  isLive?: boolean
  shortBylineText?: YouTubeText
  longBylineText?: YouTubeText
  ownerText?: YouTubeText
  viewCountText?: YouTubeText
  shortViewCountText?: YouTubeText
  publishedTimeText?: YouTubeText
  videoCountText?: YouTubeText
  subscriberCountText?: YouTubeText
  videoCount?: string | number
  subscriberCount?: string | number
  handle?: string
  displayName?: YouTubeText
  attributedTitle?: {
    content: string
  }
  flexColumns?: Array<{
    musicResponsiveListItemFlexColumnRenderer?: {
      text?: YouTubeText
    }
  }>
  _type?: string
  channelRenderer?: YouTubeRenderer
  [key: string]: unknown
}

export interface YouTubeFormat {
  itag: number
  url?: string
  signatureCipher?: string
  cipher?: string
  mimeType?: string
  mime_type?: string
  bitrate?: number
  averageBitrate?: number
  average_bitrate?: number
  width?: number
  height?: number
  fps?: number
  quality?: string
  qualityLabel?: string
  quality_label?: string
  audioQuality?: string
  audio_quality?: string
  audioSampleRate?: string
  audioChannels?: number
  contentLength?: string | number
  content_length?: string | number
  approxDurationMs?: string | number
  approx_duration_ms?: string | number
  lastModified?: string
  last_modified_ms?: string
  xtags?: string
  isDrc?: boolean
  audioTrack?: {
    id?: string
    displayName?: string
    audioIsDefault?: boolean
  }
  [key: string]: unknown
}

export interface YouTubePlayerResponse {
  videoDetails?: {
    videoId: string
    title: string
    author: string
    lengthSeconds?: string
    viewCount?: string | number
    keywords?: string[]
    shortDescription?: string
    isLiveContent?: boolean
    channelId?: string
    thumbnail?: {
      thumbnails: YouTubeThumbnail[]
    }
    publishDate?: string
    [key: string]: unknown
  }
  microformat?: {
    playerMicroformatRenderer?: Record<string, unknown>
    [key: string]: unknown
  }
  playabilityStatus?: {
    status: string
    reason?: string
    [key: string]: unknown
  }
  streamingData?: {
    formats?: YouTubeFormat[]
    adaptiveFormats?: YouTubeFormat[]
    adaptive_formats?: YouTubeFormat[]
    hlsManifestUrl?: string
    serverAbrStreamingUrl?: string
    server_abr_streaming_url?: string
    [key: string]: unknown
  }
  playerConfig?: {
    mediaCommonConfig?: {
      mediaUstreamerRequestConfig?: {
        videoPlaybackUstreamerConfig?: string
      }
    }
    [key: string]: unknown
  }
  error?: {
    message: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface FormatEntry {
  itag: number
  mimeType?: string
  bitrate?: number
  averageBitrate?: number
  width?: number
  height?: number
  fps?: number
  quality?: string
  qualityLabel?: string
  audioQuality?: string
  audioTrackId?: string
  audioIsDefault?: boolean
  approxDurationMs?: string | number
  contentLength?: string | number
  xtags?: string
  lastModified?: string
  isDrc?: boolean
  [key: string]: unknown
}

export interface TrackUrlAdditionalData {
  contentLength?: number | null
  proxy?: ProxySnapshot
  accessToken?: string | null
  visitorData?: string | null
  serverAbrStreamingUrl?: string
  videoPlaybackUstreamerConfig?: string | Uint8Array
  poToken?: string | Uint8Array | null
  clientInfo?: { clientName: number; clientVersion: string }
  formats?: FormatEntry[]
  itag?: number
  mimeType?: string
  qualityLabel?: string | null
  width?: number | null
  height?: number | null
  fps?: number | null
  bitrate?: number | null
  startTime?: number
  positionCallback?: (positionMs: number) => void
  playbackPaused?: () => boolean
  previousSession?: PreviousSessionState
  streamKey?: string | symbol
  userAgent?: string
  playbackCookie?: string | Uint8Array
  client?: string
  sabr?: boolean
  mediaMode?: 'audio' | 'video' | 'progressive'
  [key: string]: unknown
}

export interface TrackUrlData {
  loadType?: string
  url?: string
  protocol?: string | null
  format?: string | null
  hlsUrl?: string | null
  formats?: FormatEntry[]
  itag?: number
  additionalData?: TrackUrlAdditionalData
  newTrack?: { info: TrackInfo }
  exception?: SourceException
  [key: string]: unknown
}

export interface StreamResult {
  stream?: Readable & {
    responseStream?: Readable
    _sabrStream?: unknown
    beginSeekHandoff?: () => Promise<unknown>
    cancelSeekHandoff?: () => void
    destroy: (err?: Error) => void
  }
  type?: string
  exception?: SourceException
}

