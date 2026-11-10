import type { FormatEntry } from './youtube.ts'

export interface SabrStreamConfig {
  videoId: string
  serverAbrStreamingUrl?: string
  videoPlaybackUstreamerConfig?: string | Uint8Array
  clientInfo?: { clientName: number; clientVersion: string }
  formats?: FormatEntry[]
  poToken?: string | Uint8Array | null
  visitorData?: string
  accessToken?: string
  userAgent?: string
  startTime?: number
  positionCallback?: (positionMs: number) => void
  playbackPaused?: () => boolean
  previousSession?: PreviousSessionState
  playbackCookie?: string | Uint8Array
  enableTrafficLog?: boolean
  trafficLogPath?: string
}

export interface PreviousSessionState {
  requestNumber: number
  bandwidthEstimate: number
  nextRequestPolicy?: {
    targetAudioReadaheadMs?: number
    targetVideoReadaheadMs?: number
    maxTimeSinceLastRequestMs?: number
    backoffTimeMs?: number
    minAudioReadaheadMs?: number
    minVideoReadaheadMs?: number
    playbackCookie?: Uint8Array
  }
  sabrContexts?: Array<{
    type: number
    value: Uint8Array
    sendByDefault?: boolean
  }>
  activeSabrContextTypes?: number[]
}

export interface BufferedRangeSummary {
  formatId?: { itag: number; lastModified?: string; xtags?: string }
  startTimeMs?: string
  durationMs?: string
  startSegmentIndex?: number
  endSegmentIndex?: number
  timeRange?: {
    startTicks: string
    durationTicks: string
    timescale: number
  }
}

export interface AbrState {
  playerTimeMs: number
  bandwidthEstimate: number
  enabledTrackTypesBitfield: number
  audioTrackId?: string
  playerState: bigint
  visibility: number
  playbackRate: number
  stickyResolution: number
  lastManualSelectedResolution: number
  clientViewportIsFlexible: boolean
}

export interface SawFlags {
  media: boolean
  mediaHeader: boolean
  mediaEnd: boolean
  nextRequestPolicy: boolean
  playbackStartPolicy: boolean
  requestIdentifier: boolean
  requestCancellationPolicy: boolean
  sabrError: boolean
  sabrRedirect: boolean
  sabrContextUpdate: boolean
  streamProtectionStatus: boolean
}

export interface PartSequenceEntry {
  type: number
  name: string
  size: number
}

export interface PartDumpEntry {
  type: number
  name: string
  size: number
  sha256: string
  payloadB64: string
  payloadB64Truncated: boolean
  decoded?: Record<string, unknown>
}

export interface TrafficLogEntry {
  ts: string
  dir: 'client->yt' | 'yt->client'
  rn: number
  url?: string
  status?: number
  ok?: boolean
  statusText?: string
  durationMs?: number
  playerTimeMs?: number
  requestBodyBytes?: number
  requestBodySha256?: string
  requestBodyB64?: string
  requestBodyB64Truncated?: boolean
  selectedAudioItags?: number[]
  selectedVideoItags?: number[]
  initializationItags?: number[]
  bufferedRanges?: Array<{
    itag?: number
    startMs: string
    durMs: string
    seg: [number, number]
  }>
  cookieLen?: number
  contexts?: Array<{ type: number; valueLen: number }>
  unsentContexts?: number[]
  responseBytes?: number
  responseSha256?: string
  responseBodyB64?: string
  responseBodyB64Truncated?: boolean
  contentType?: string
  contentLength?: string
  parts?: Record<string, number>
  partSeq?: PartSequenceEntry[]
  partDumps?: PartDumpEntry[]
  saw?: SawFlags
  policy?: {
    backoffTimeMs: number
    cookieLen: number
    targetAudioReadaheadMs?: number
    minAudioReadaheadMs?: number
    maxTimeSinceLastRequestMs?: number
  }
  errorText?: string
}

