import type { Readable } from 'node:stream'
import type { HttpProxyConfig } from './common.ts'

export type HLSFetchStrategy = 'streaming' | 'segmented' | 'sequential'

export interface HLSAttributes {
  [key: string]: string | Buffer | undefined
}

export interface HLSByteRange {
  length: number
  offset: number
}

export interface HLSSegmentKey {
  method: 'NONE' | 'AES-128' | 'SAMPLE-AES' | string
  uri?: string
  iv?: Buffer
}

export interface HLSSegmentMap {
  uri?: string
  byteRange?: HLSByteRange | null
}

export interface HLSSegment {
  url: string
  duration: number
  key: HLSSegmentKey | null
  map: HLSSegmentMap | null
  byteRange: HLSByteRange | null
  sequence: number
  discontinuity: boolean
}

export interface HLSAudioRendition {
  type?: string
  groupid?: string
  name?: string
  language?: string
  default?: string
  autoselect?: string
  uri?: string
  [key: string]: unknown
}

export interface HLSVariant {
  url: string
  bandwidth: number
  codecs: string
  audio?: string
  resolution?: string
  width?: number
  height?: number
}

export interface HLSMasterPlaylist {
  isMaster: true
  variants: HLSVariant[]
  audioGroups: Record<string, HLSAudioRendition[]>
}

export interface HLSMediaPlaylist {
  isMaster: false
  mediaSequence: number
  targetDuration: number
  isLive: boolean
  segments: HLSSegment[]
}

export type HLSPlaylist = HLSMasterPlaylist | HLSMediaPlaylist

export interface HLSSegmentFetchResult {
  segment: HLSSegment
  data?: Buffer
  stream?: Readable
}

export interface SegmentFetcherOptions {
  headers?: Record<string, string>
  localAddress?: string | null
  proxy?: HttpProxyConfig | null
  network?: { proxy?: HttpProxyConfig | null }
  onResolveUrl?: (url: string) => Promise<string | null>
}

export interface FetchSegmentOptions {
  stream?: boolean
}

export interface HLSHandlerOptions extends SegmentFetcherOptions {
  type?: string
  strategy?: HLSFetchStrategy
  startTime?: number
  highWaterMark?: number
  mediaMode?: 'audio' | 'video'
  maxHeight?: number | null
  onAudioRendition?: (audioUrl: string) => void
}

