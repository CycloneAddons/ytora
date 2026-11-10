import type { RawProxyInput } from './common.ts'

export type DownloadMode = 'video' | 'audio' | 'progressive'
export type AudioQualityPref = 'high' | 'medium' | 'low' | 'lowest'
export type VideoQualityPref =
  | 'best'
  | '2160p'
  | '1440p'
  | '1080p'
  | '720p'
  | '480p'
  | '360p'
  | '240p'
  | '144p'
export type CodecPref = 'any' | 'h264' | 'vp9' | 'av1'

export interface StreamSelectionSpec {
  mode: DownloadMode
  /** When downloading a single stream inside adaptive pair (either 'video' or 'audio') */
  targetKind: 'audio' | 'video' | 'progressive'
  audioQuality?: AudioQualityPref
  videoQuality?: VideoQualityPref
  maxHeight?: number | null
  codec?: CodecPref
  itag?: number | null
  allowItag?: number[]
  /** Preferred container family constraint so adaptive video + audio can `-c copy` cleanly when possible */
  preferContainer?: 'mp4' | 'webm' | 'any'
  audioTrackId?: string
}

export interface FormatSummary {
  itag: number
  kind: 'progressive' | 'video-only' | 'audio-only'
  mimeType: string
  container: string
  codecs: string
  qualityLabel: string | null
  width: number | null
  height: number | null
  fps: number | null
  bitrate: number | null
  averageBitrate: number | null
  audioQuality: string | null
  audioChannels: number | null
  audioTrackId: string | null
  audioIsDefault: boolean
  contentLength: number | null
  isCiphered: boolean
  hasDirectUrl: boolean
  isDrc?: boolean
}

export interface FormatInventoryResult {
  client: string
  protocol: 'http' | 'sabr' | 'hls'
  videoId: string
  title: string
  author: string
  durationMs: number
  hlsUrl: string | null
  formats: FormatSummary[]
}

export interface DownloaderConfig {
  hl?: string
  gl?: string
  clients?: {
    search?: string[]
    playback?: string[]
    resolve?: string[]
  }
  proxies?: RawProxyInput[]
  refreshTokens?: string[]
  cipherUrl?: string
  cipherToken?: string | null
  debugLogs?: boolean
  logDir?: string
}

export interface DownloadOptions {
  mode: DownloadMode
  videoQuality: VideoQualityPref
  audioQuality: AudioQualityPref
  codec: CodecPref
  itag: number | null
  outDir: string
  filenameTemplate?: string
  clients?: string[]
  playlist?: boolean
  limit?: number
  onProgress?: (event: DownloadProgressEvent) => void
}

export interface DownloadProgressEvent {
  phase:
    | 'resolving'
    | 'probing'
    | 'downloading-video'
    | 'downloading-audio'
    | 'downloading'
    | 'muxing'
    | 'done'
  trackTitle: string
  videoId: string
  bytesDownloaded?: number
  totalBytes?: number | null
  client?: string
  protocol?: string
  itag?: number
  detail?: string
}

export interface DownloadedItemResult {
  videoId: string
  title: string
  author: string
  filePath: string
  sizeBytes: number
  client: string
  protocol: string
  mode: DownloadMode
  videoItag?: number
  audioItag?: number
  muxedWithFfmpeg: boolean
  durationMs: number
}

export interface FfmpegInfo {
  bin: string
  versionLine: string
  source?: 'env' | 'system' | 'ffmpeg-static'
}

