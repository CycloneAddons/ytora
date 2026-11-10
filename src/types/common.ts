import type { Readable } from 'node:stream'

export type LogLevelName =
  | 'silent'
  | 'error'
  | 'warn'
  | 'info'
  | 'debug'
  | 'trace'

export type ApiHttpMethod = 'GET' | 'POST' | 'HEAD' | 'PUT' | 'DELETE' | 'OPTIONS'

export interface HttpProxyConfig {
  url: string
  username?: string
  password?: string
  type?: 'forward' | 'reverse' | string
}

export interface HttpRequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: unknown
  timeout?: number
  streamOnly?: boolean
  responseType?: 'buffer' | 'text' | 'json'
  localAddress?: string
  proxy?: HttpProxyConfig
  disableBodyCompression?: boolean
  maxRedirects?: number
  _redirectsFollowed?: number
  maxResponseBodyBytes?: number
}

export interface HttpRequestResult {
  statusCode?: number
  headers?: Record<string, string | string[] | undefined>
  body?: unknown
  stream?: Readable
  error?: string
}

export interface ProxyEntry {
  url: string
  type: 'forward' | 'reverse'
  failures: number
  lastFailure: number
  activeRequests: number
  score: number
  latency: number
}

export type ProxySnapshot = ProxyEntry

export type RawProxyInput = string | { url: string; type?: string }

export const YOUTUBE_CONSTANTS = {
  VIDEO: 0,
  PLAYLIST: 1,
  SHORTS: 2,
  UNKNOWN: -1
} as const

export type YOUTUBE_CONSTANTS_TYPE =
  (typeof YOUTUBE_CONSTANTS)[keyof typeof YOUTUBE_CONSTANTS]

export interface TrackInfo {
  identifier: string
  isSeekable: boolean
  author: string
  length: number
  isStream: boolean
  position: number
  title: string
  uri: string
  artworkUrl: string | null
  isrc: string | null
  sourceName: string
  audioTrackId?: string
}

export interface AudioFormat {
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

export interface AudioTrack {
  id: string
  name: string
  isDefault: boolean
  isAutoDubbed: boolean
}

export interface TrackEncodeInput {
  title: string
  author: string
  length: number
  identifier: string
  isStream: boolean
  uri?: string | null
  artworkUrl?: string | null
  isrc?: string | null
  sourceName: string
  details?: Array<string | null>
  position?: number
}

export interface TrackData {
  encoded: string
  info: TrackInfo
  pluginInfo: Record<string, unknown>
}

export interface PlaylistData {
  info: {
    name: string
    selectedTrack: number
  }
  pluginInfo: Record<string, unknown>
  tracks: TrackData[]
}

export interface SourceException {
  message: string
  severity: string
  cause?: string
  status?: number
}

export interface SourceResult {
  loadType: 'track' | 'playlist' | 'search' | 'empty' | 'error'
  data?: TrackData | PlaylistData | TrackData[] | Record<string, never>
  exception?: SourceException
}

export interface IOAuth {
  getAccessToken(): Promise<string | null>
  getAuthHeaders(): Promise<Record<string, string>>
  hasRefreshToken(): boolean
  updateRefreshToken(tokens: string | string[]): void
}

export interface ICachedPlayerScript {
  url: string
  expireTimestampMs: number
}

export interface CancelSignal {
  aborted: boolean
}

