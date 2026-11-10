import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { poTokenManager } from '../potoken/poTokenManager.ts'
import {
  base64ToU8,
  concatenateChunks,
  EnabledTrackTypes,
  type FormatIdMsg,
  FormatInitializationMetadata,
  type FormatInitializationMetadataMsg,
  MediaHeader,
  type MediaHeaderMsg,
  NextRequestPolicy,
  type NextRequestPolicyMsg,
  PlaybackStartPolicy,
  ProtoReader,
  ReloadPlaybackContext,
  RequestCancellationPolicy,
  RequestIdentifier,
  SabrContextSendingPolicy,
  SabrContextUpdate,
  SabrError,
  SabrRedirect,
  StreamProtectionStatus,
  UMPPartId,
  VideoPlaybackAbrRequest
} from './protor.ts'
import type {
  AbrState,
  BufferedRangeSummary,
  FormatEntry,
  PartDumpEntry,
  PartSequenceEntry,
  PreviousSessionState,
  SabrStreamConfig,
  SawFlags,
  TrafficLogEntry
} from '../types/index.ts'
import { logger } from '../utils/logger.ts'
import { resolveDefaultLogDir } from '../utils/paths.ts'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
const MAX_BUFFER_BYTES = 512 * 1024
const MIN_REQUEST_INTERVAL_MS = 500
const MAX_LIMITED_PLAYBACK_COUNT = 6
const PROTECTION_REFRESH_COOLDOWN_MS = 30_000
const MAX_TRACKED_SEGMENTS_PER_ITAG = 64

type RecoveryReason =
  | 'protection'
  | 'reload'
  | 'starvation'
  | 'http'
  | 'session'

type UmpPartType = (typeof UMPPartId)[keyof typeof UMPPartId]

interface UmpPart {
  type: UmpPartType
  size: number
  data: CompositeBuffer
}

interface IncompleteUmpPart {
  type: number
  size: number
  headerSize: number
  data: CompositeBuffer
  incomplete: true
}

type UmpPartHandler = (part: UmpPart) => void

interface DownloadedSegment {
  segmentNumber: number
  durationMs: number
  byteLength: number
  startMs: number
  endMs: number
}

interface PartialSegmentQueueEntry {
  formatIdKey: string
  segmentNumber: number
  mediaHeader: MediaHeaderMsg
  durationMs: string
  loadedBytes: number
  discard?: boolean
}

interface FormatInitializationEntry {
  formatInitializationMetadata: FormatInitializationMetadataMsg
}

interface ActivePartial {
  type: number
  totalSize: number
  headerSize: number
  processedBytes: number
  id: number | undefined
}

interface DetailedStateParams {
  abrState?: AbrState
  audioFormat?: FormatEntry
  videoFormat?: FormatEntry
  initializationFormatIds?: FormatIdMsg[]
  selectedAudioFormatIds?: FormatIdMsg[]
  selectedVideoFormatIds?: FormatIdMsg[]
  bufferedRanges?: BufferedRangeSummary[]
  contexts?: Array<{ type: number; value: Uint8Array }>
  unsent?: number[]
}

function sha256Hex(u8: Uint8Array): string {
  const h = createHash('sha256')
  h.update(u8)
  return h.digest('hex')
}

function b64Trunc(u8: Uint8Array, maxBytes: number): string {
  const slice = u8.length > maxBytes ? u8.subarray(0, maxBytes) : u8
  return Buffer.from(slice).toString('base64')
}

function umpPartName(type: number): string {
  switch (type) {
    case UMPPartId.FORMAT_INITIALIZATION_METADATA:
      return 'FORMAT_INITIALIZATION_METADATA'
    case UMPPartId.NEXT_REQUEST_POLICY:
      return 'NEXT_REQUEST_POLICY'
    case UMPPartId.SABR_ERROR:
      return 'SABR_ERROR'
    case UMPPartId.SABR_REDIRECT:
      return 'SABR_REDIRECT'
    case UMPPartId.PLAYBACK_START_POLICY:
      return 'PLAYBACK_START_POLICY'
    case UMPPartId.REQUEST_IDENTIFIER:
      return 'REQUEST_IDENTIFIER'
    case UMPPartId.REQUEST_CANCELLATION_POLICY:
      return 'REQUEST_CANCELLATION_POLICY'
    case UMPPartId.SABR_CONTEXT_UPDATE:
      return 'SABR_CONTEXT_UPDATE'
    case UMPPartId.SABR_CONTEXT_SENDING_POLICY:
      return 'SABR_CONTEXT_SENDING_POLICY'
    case UMPPartId.STREAM_PROTECTION_STATUS:
      return 'STREAM_PROTECTION_STATUS'
    case UMPPartId.RELOAD_PLAYER_RESPONSE:
      return 'RELOAD_PLAYER_RESPONSE'
    case UMPPartId.MEDIA_HEADER:
      return 'MEDIA_HEADER'
    case UMPPartId.MEDIA:
      return 'MEDIA'
    case UMPPartId.MEDIA_END:
      return 'MEDIA_END'
    case UMPPartId.SNACKBAR_MESSAGE:
      return 'SNACKBAR_MESSAGE'
    default:
      return `UNKNOWN_${type}`
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()

    let t: NodeJS.Timeout | undefined
    const onAbort = () => {
      if (t) clearTimeout(t)
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }

    t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    t.unref?.()

    if (signal) signal.addEventListener('abort', onAbort)
  })
}

function createKey(
  itag: number | undefined,
  xtags: string | undefined
): string {
  return `${itag ?? ''}:${xtags ?? ''}`
}

const FormatKeyUtils = {
  fromFormatInitializationMetadata(meta: {
    formatId?: FormatIdMsg
    itag?: number
    xtags?: string
  }): string {
    const itag = meta.formatId?.itag ?? meta.itag
    const xtags = meta.formatId?.xtags ?? meta.xtags
    return createKey(itag, xtags)
  },

  fromMediaHeader(mediaHeader: {
    formatId?: FormatIdMsg
    itag: number
    xtags?: string
  }): string {
    const itag = mediaHeader.formatId?.itag ?? mediaHeader.itag
    const xtags = mediaHeader.formatId?.xtags ?? mediaHeader.xtags
    return createKey(itag, xtags)
  }
}

export class CompositeBuffer {
  chunks: Uint8Array[] = []
  currentChunkOffset = 0
  currentChunkIndex = 0
  totalLength = 0

  constructor(chunks: Uint8Array[] = []) {
    for (const chunk of chunks) {
      this.append(chunk)
    }
  }

  append(chunk: Uint8Array | CompositeBuffer): void {
    if (chunk instanceof Uint8Array) {
      if (this.canMergeWithLastChunk(chunk)) {
        const lastChunk = this.chunks[this.chunks.length - 1]
        if (lastChunk) {
          this.chunks[this.chunks.length - 1] = new Uint8Array(
            lastChunk.buffer,
            lastChunk.byteOffset,
            lastChunk.length + chunk.length
          )
          this.resetFocus()
        } else {
          this.chunks.push(chunk)
        }
      } else {
        this.chunks.push(chunk)
      }
      this.totalLength += chunk.length
    } else if (chunk instanceof CompositeBuffer) {
      for (const c of chunk.chunks) {
        this.append(c)
      }
    }
  }

  canMergeWithLastChunk(chunk: Uint8Array): boolean {
    if (this.chunks.length === 0) return false
    const lastChunk = this.chunks[this.chunks.length - 1]
    if (!lastChunk) return false
    return (
      lastChunk.buffer === chunk.buffer &&
      lastChunk.byteOffset + lastChunk.length === chunk.byteOffset
    )
  }

  split(position: number): {
    extractedBuffer: CompositeBuffer
    remainingBuffer: CompositeBuffer
  } {
    const extractedBuffer = new CompositeBuffer()
    const remainingBuffer = new CompositeBuffer()
    let remainingPos = position

    for (const chunk of this.chunks) {
      if (remainingPos >= chunk.length) {
        extractedBuffer.append(chunk)
        remainingPos -= chunk.length
      } else if (remainingPos > 0) {
        extractedBuffer.append(chunk.subarray(0, remainingPos))
        remainingBuffer.append(chunk.subarray(remainingPos))
        remainingPos = 0
      } else {
        remainingBuffer.append(chunk)
      }
    }
    return { extractedBuffer, remainingBuffer }
  }

  canReadBytes(position: number, length: number): boolean {
    return position + length <= this.totalLength
  }

  getUint8(position: number): number {
    this.focus(position)
    const chunk = this.chunks[this.currentChunkIndex]
    if (!chunk) return 0
    return chunk[position - this.currentChunkOffset] ?? 0
  }

  getLength(): number {
    return this.totalLength
  }

  focus(position: number): void {
    if (position < this.currentChunkOffset) this.resetFocus()
    while (
      this.currentChunkIndex < this.chunks.length &&
      this.currentChunkOffset +
        (this.chunks[this.currentChunkIndex]?.length ?? 0) <=
        position
    ) {
      const chunk = this.chunks[this.currentChunkIndex]
      if (chunk) {
        this.currentChunkOffset += chunk.length
      }
      this.currentChunkIndex += 1
    }
  }

  resetFocus(): void {
    this.currentChunkIndex = 0
    this.currentChunkOffset = 0
  }
}

class UmpReader {
  compositeBuffer: CompositeBuffer

  constructor(compositeBuffer: CompositeBuffer) {
    this.compositeBuffer = compositeBuffer
  }

  read(handlePart: (part: UmpPart) => void): IncompleteUmpPart | undefined {
    while (true) {
      const offset = 0
      const [partType, nextOffset] = this.readVarInt(offset)
      if (partType < 0) break

      const [partSize, finalOffset] = this.readVarInt(nextOffset)
      if (partSize < 0) break

      if (!this.compositeBuffer.canReadBytes(finalOffset, partSize)) {
        const split = this.compositeBuffer.split(finalOffset)
        return {
          type: partType,
          size: partSize,
          headerSize: finalOffset,
          data: split.remainingBuffer,
          incomplete: true
        }
      }

      const splitResult = this.compositeBuffer
        .split(finalOffset)
        .remainingBuffer.split(partSize)
      handlePart({
        type: partType as UmpPart['type'],
        size: partSize,
        data: splitResult.extractedBuffer
      })
      this.compositeBuffer = splitResult.remainingBuffer
    }
    return undefined
  }

  readVarInt(offset: number): [number, number] {
    let byteLength: number
    if (this.compositeBuffer.canReadBytes(offset, 1)) {
      const firstByte = this.compositeBuffer.getUint8(offset)
      byteLength =
        firstByte < 128
          ? 1
          : firstByte < 192
            ? 2
            : firstByte < 224
              ? 3
              : firstByte < 240
                ? 4
                : 5
    } else {
      byteLength = 0
    }
    if (
      byteLength < 1 ||
      !this.compositeBuffer.canReadBytes(offset, byteLength)
    ) {
      return [-1, offset]
    }

    let value: number
    switch (byteLength) {
      case 1: {
        value = this.compositeBuffer.getUint8(offset++)
        break
      }
      case 2: {
        const b1 = this.compositeBuffer.getUint8(offset++)
        const b2 = this.compositeBuffer.getUint8(offset++)
        value = (b1 & 0x3f) + 64 * b2
        break
      }
      case 3: {
        const b1 = this.compositeBuffer.getUint8(offset++)
        const b2 = this.compositeBuffer.getUint8(offset++)
        const b3 = this.compositeBuffer.getUint8(offset++)
        value = (b1 & 0x1f) + 32 * (b2 + 256 * b3)
        break
      }
      case 4: {
        const b1 = this.compositeBuffer.getUint8(offset++)
        const b2 = this.compositeBuffer.getUint8(offset++)
        const b3 = this.compositeBuffer.getUint8(offset++)
        const b4 = this.compositeBuffer.getUint8(offset++)
        value = (b1 & 0x0f) + 16 * (b2 + 256 * (b3 + 256 * b4))
        break
      }
      default: {
        offset++
        const b1 = this.compositeBuffer.getUint8(offset++)
        const b2 = this.compositeBuffer.getUint8(offset++)
        const b3 = this.compositeBuffer.getUint8(offset++)
        const b4 = this.compositeBuffer.getUint8(offset++)
        value = b1 + 256 * (b2 + 256 * (b3 + 256 * b4))
        break
      }
    }
    return [value, offset]
  }
}

export class SabrStream extends PassThrough {
  private config: SabrStreamConfig
  videoId: string
  private umpPartHandlers: Map<number, UmpPartHandler>
  private initializedFormatsMap: Map<string, FormatInitializationEntry>
  private partialSegmentQueue: Map<number, PartialSegmentQueueEntry>
  private sabrContexts: Map<
    number,
    { type: number; value: Uint8Array; sendByDefault?: boolean }
  >
  private activeSabrContextTypes: Set<number>
  requestNumber: number
  private _aborted: boolean
  private formatSequenceCounters: Map<number, number>
  private downloadedSegmentsByItag: Map<number, Map<number, DownloadedSegment>>
  private endSegmentNumbers: Map<number, number>
  streamFinished: boolean
  private poToken: Uint8Array | null
  private visitorData: string | undefined
  serverAbrStreamingUrl: string | undefined
  private videoPlaybackUstreamerConfig: Uint8Array | string | undefined
  private clientInfo: { clientName: number; clientVersion: string } | undefined
  private formatIds: FormatEntry[]
  startTime: number
  private positionCallback: ((positionMs: number) => void) | undefined
  private playbackPaused: (() => boolean) | undefined
  private userAgent: string
  private recoveryPending: boolean
  private seekHandoffPending: boolean
  private usingTransferredSession: boolean
  private activeRequest: Promise<void> | null
  private poTokenGenerated: boolean
  private mediaProgressGeneration: number
  private limitedPlaybackCount: number
  private limitedPlaybackGeneration: number
  private lastProtectionRefreshAt: number
  private protectionRefreshPending: boolean
  private pendingRecoveryReason: RecoveryReason | null
  private pendingResponseError: Error | null
  totalDownloadedMs: number
  private virtualPlayerTimeMs: number
  private lastVirtualAdvanceAt: number
  private pendingRangesHeaders: Map<string, MediaHeaderMsg[]>
  private cachedBufferedRanges: BufferedRangeSummary[] | null
  private lastReportedRanges: Set<string>
  private enableTrafficLog: boolean
  private trafficLogDirPrepared = false
  private trafficLogPath: string
  private enableTrafficDump: boolean
  private trafficDumpMaxBytes: number
  private bandwidthEstimate: number
  private lastBandwidthLogAt: number
  private noMediaStreak: number
  abortController: AbortController
  private lastRequestAt: number
  private nextRequestPolicy: NextRequestPolicyMsg | undefined
  private lastStreamProtectionStatus: number | undefined
  private lastStreamProtectionLogAt: number
  private lastDetailedLogAt: number
  private _lastPolicyBackoff: number | undefined
  private _lastPolicyCookieLen: number | undefined
  private _lastPolicyLogAt: number
  cumulativeDownloadedMs: number
  private targetItag: number | null

  constructor(config: SabrStreamConfig = {} as SabrStreamConfig) {
    super()
    this.config = config
    this.videoId = config.videoId

    this.umpPartHandlers = new Map([
      [
        UMPPartId.FORMAT_INITIALIZATION_METADATA,
        this.handleFormatInitializationMetadata.bind(this)
      ],
      [UMPPartId.NEXT_REQUEST_POLICY, this.handleNextRequestPolicy.bind(this)],
      [
        UMPPartId.PLAYBACK_START_POLICY,
        this.handlePlaybackStartPolicy.bind(this)
      ],
      [UMPPartId.REQUEST_IDENTIFIER, this.handleRequestIdentifier.bind(this)],
      [
        UMPPartId.REQUEST_CANCELLATION_POLICY,
        this.handleRequestCancellationPolicy.bind(this)
      ],
      [UMPPartId.SABR_ERROR, this.handleSabrError.bind(this)],
      [UMPPartId.SABR_REDIRECT, this.handleSabrRedirect.bind(this)],
      [UMPPartId.SABR_CONTEXT_UPDATE, this.handleSabrContextUpdate.bind(this)],
      [
        UMPPartId.SABR_CONTEXT_SENDING_POLICY,
        this.handleSabrContextSendingPolicy.bind(this)
      ],
      [
        UMPPartId.STREAM_PROTECTION_STATUS,
        this.handleStreamProtectionStatus.bind(this)
      ],
      [
        UMPPartId.RELOAD_PLAYER_RESPONSE,
        this.handleReloadPlayerResponse.bind(this)
      ],
      [UMPPartId.MEDIA_HEADER, this.handleMediaHeader.bind(this)],
      [UMPPartId.MEDIA, this.handleMedia.bind(this)],
      [UMPPartId.MEDIA_END, this.handleMediaEnd.bind(this)],
      [UMPPartId.SNACKBAR_MESSAGE, this.handleSnackbarMessage.bind(this)]
    ])

    this.initializedFormatsMap = new Map()
    this.partialSegmentQueue = new Map()
    this.sabrContexts = new Map()
    this.activeSabrContextTypes = new Set()
    this.requestNumber = 0
    this._aborted = false
    this.formatSequenceCounters = new Map()
    this.downloadedSegmentsByItag = new Map()
    this.endSegmentNumbers = new Map()
    this.streamFinished = false

    this.poToken = null
    this.visitorData = config.visitorData

    this.serverAbrStreamingUrl = config.serverAbrStreamingUrl
    if (this.serverAbrStreamingUrl) {
      const url = new URL(this.serverAbrStreamingUrl)
      url.searchParams.set('alr', 'yes')
      url.searchParams.set('ump', '1')
      url.searchParams.set('srfvp', '1')
      this.serverAbrStreamingUrl = url.toString()
    }
    this.videoPlaybackUstreamerConfig = config.videoPlaybackUstreamerConfig
    this.clientInfo = config.clientInfo
    this.formatIds = config.formats ?? []
    this.startTime = config.startTime ?? 0
    this.positionCallback = config.positionCallback
    this.playbackPaused = config.playbackPaused
    this.userAgent = config.userAgent ?? USER_AGENT
    this.recoveryPending = false
    this.seekHandoffPending = false
    this.usingTransferredSession = config.previousSession != null
    this.activeRequest = null
    this.poTokenGenerated = false
    this.mediaProgressGeneration = 0
    this.limitedPlaybackCount = 0
    this.limitedPlaybackGeneration = 0
    this.lastProtectionRefreshAt = 0
    this.protectionRefreshPending = false
    this.pendingRecoveryReason = null
    this.pendingResponseError = null

    this.totalDownloadedMs = 0
    this.virtualPlayerTimeMs = 0
    this.lastVirtualAdvanceAt = 0

    this.pendingRangesHeaders = new Map()
    this.cachedBufferedRanges = null
    this.lastReportedRanges = new Set()

    this.enableTrafficLog = config.enableTrafficLog ?? false
    this.trafficLogPath =
      config.trafficLogPath ?? path.join(resolveDefaultLogDir(), 'sabr_traffic.jsonl')
    this.enableTrafficDump = true
    this.trafficDumpMaxBytes = 64 * 1024

    this.bandwidthEstimate = 5_000_000
    this.lastBandwidthLogAt = 0

    this.noMediaStreak = 0
    this.abortController = new AbortController()

    if (typeof config.poToken === 'string') {
      try {
        this.poToken = base64ToU8(config.poToken)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        logger('error', 'SABR', `Failed to decode PO token: ${message}`)
        this.poToken = null
      }
    } else if (config.poToken instanceof Uint8Array) {
      this.poToken = config.poToken
    }
    this.poTokenGenerated = (this.poToken?.length ?? 0) > 0

    if (config.previousSession) {
      const ps = config.previousSession
      this.requestNumber = ps.requestNumber ?? 0
      this.bandwidthEstimate = ps.bandwidthEstimate ?? 5_000_000
      this.nextRequestPolicy = ps.nextRequestPolicy
      this.sabrContexts = new Map(
        (ps.sabrContexts ?? []).map((context) => [
          context.type,
          {
            ...context,
            value: context.value.slice()
          }
        ])
      )
      this.activeSabrContextTypes = new Set(ps.activeSabrContextTypes ?? [])
      logger(
        'info',
        'SABR',
        `Session state transferred: rn=${this.requestNumber}, bw=${(this.bandwidthEstimate / 1_000_000).toFixed(2)}Mbps, hasCookie=${!!this.nextRequestPolicy?.playbackCookie}`
      )
    }

    if (config.playbackCookie) {
      if (!this.nextRequestPolicy) this.nextRequestPolicy = {}
      this.nextRequestPolicy.playbackCookie =
        config.playbackCookie instanceof Uint8Array
          ? config.playbackCookie
          : base64ToU8(config.playbackCookie)
    }

    this.lastRequestAt = 0
    this.lastStreamProtectionStatus = undefined
    this.lastStreamProtectionLogAt = 0
    this.lastDetailedLogAt = 0
    this._lastPolicyBackoff = undefined
    this._lastPolicyCookieLen = undefined
    this._lastPolicyLogAt = 0
    this.cumulativeDownloadedMs = this.startTime
    this.targetItag = null
  }

  getSessionState(): PreviousSessionState {
    return {
      requestNumber: this.requestNumber,
      bandwidthEstimate: this.bandwidthEstimate,
      nextRequestPolicy: this.nextRequestPolicy
        ? {
            ...this.nextRequestPolicy,
            playbackCookie: this.nextRequestPolicy.playbackCookie?.slice()
          }
        : undefined,
      sabrContexts: Array.from(this.sabrContexts.values(), (context) => ({
        ...context,
        value: context.value.slice()
      })),
      activeSabrContextTypes: Array.from(this.activeSabrContextTypes)
    }
  }

  async beginSeekHandoff(): Promise<PreviousSessionState | null> {
    if (
      this._aborted ||
      this.destroyed ||
      this.recoveryPending ||
      this.seekHandoffPending
    ) {
      return null
    }

    this.seekHandoffPending = true
    const request = this.activeRequest
    if (request) {
      try {
        await request
      } catch {
        this.seekHandoffPending = false
        return null
      }
    }

    if (this._aborted || this.destroyed || this.recoveryPending) {
      this.seekHandoffPending = false
      return null
    }

    return this.getSessionState()
  }

  cancelSeekHandoff(): void {
    this.seekHandoffPending = false
  }

  private logTraffic(entry: TrafficLogEntry): void {
    if (!this.enableTrafficLog) return
    if (!this.trafficLogDirPrepared) {
      this.trafficLogDirPrepared = true
      try {
        mkdirSync(path.dirname(this.trafficLogPath), { recursive: true })
      } catch {}
    }
    void appendFile(this.trafficLogPath, `${JSON.stringify(entry)}\n`).catch(
      () => {}
    )
  }

  private updateBandwidthEstimate(bytes: number, durationMs: number): void {
    if (bytes <= 0 || durationMs <= 0) return

    const bits = bytes * 8
    const throughput = (bits / durationMs) * 1000

    const alpha = 0.15
    this.bandwidthEstimate =
      alpha * throughput + (1 - alpha) * this.bandwidthEstimate

    if (Date.now() - this.lastBandwidthLogAt > 2000) {
      this.lastBandwidthLogAt = Date.now()
      logger(
        'debug',
        'SABR',
        `Bandwidth Update: measured=${(throughput / 1_000_000).toFixed(2)}Mbps est=${(this.bandwidthEstimate / 1_000_000).toFixed(2)}Mbps`
      )
    }
  }

  start(targetItag: number, mode?: 'audio' | 'video'): void {
    this.targetItag = targetItag
    const targetFormat = this.formatIds.find((f) => f.itag === targetItag)
    if (!targetFormat) {
      this.emit(
        'error',
        new Error(
          mode === 'video'
            ? 'Video format not found in sabr config'
            : 'Audio format not found in sabr config'
        )
      )
      return
    }

    const isVideo =
      mode === 'video' ||
      (!mode && targetFormat.mimeType?.startsWith('video/'))

    if (isVideo) {
      void this.loop(undefined, targetFormat)
    } else {
      void this.loop(targetFormat, undefined)
    }
  }

  getMediaProgressGeneration(): number {
    return this.mediaProgressGeneration
  }

  canCommitRecovery(generation: number): boolean {
    return (
      this.recoveryPending &&
      !this._aborted &&
      !this.destroyed &&
      this.mediaProgressGeneration === generation
    )
  }

  cancelRecovery(): void {
    this.recoveryPending = false
  }

  private refreshProtectionToken(): void {
    if (this.protectionRefreshPending || this._aborted || this.destroyed) return
    this.protectionRefreshPending = true
    void (async () => {
      try {
        const tokenData = await poTokenManager.generate(this.videoId)
        if (this._aborted || this.destroyed) return
        if (tokenData.poToken) {
          this.poToken = base64ToU8(tokenData.poToken)
          if (tokenData.visitorData) {
            this.visitorData = tokenData.visitorData
          }
          logger(
            'debug',
            'SABR',
            'Refreshed PO token after protection status 2 (session kept)'
          )
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        logger('warn', 'SABR', `Failed to refresh PO token: ${message}`)
      } finally {
        this.lastProtectionRefreshAt = Date.now()
        this.protectionRefreshPending = false
      }
    })()
  }

  private signalRecovery(reason: RecoveryReason): void {
    if (this.recoveryPending || this._aborted || this.destroyed) return
    this.recoveryPending = true
    this.emit('stall', reason, this.mediaProgressGeneration)
  }

  private queueRecovery(reason: RecoveryReason): void {
    if (this.pendingRecoveryReason === 'reload') return
    if (reason === 'reload' || !this.pendingRecoveryReason) {
      this.pendingRecoveryReason = reason
    }
  }

  private recordMediaProgress(): void {
    if (this.mediaProgressGeneration === 0) {
      this.lastVirtualAdvanceAt = Date.now()
    }
    this.mediaProgressGeneration++
    this.emit('mediaProgress', this.mediaProgressGeneration)
    this.limitedPlaybackCount = 0
    this.limitedPlaybackGeneration = this.mediaProgressGeneration
    if (this.pendingRecoveryReason === 'protection') {
      this.pendingRecoveryReason = null
    }
  }

  private flushPendingRecovery(): void {
    const reason = this.pendingRecoveryReason
    this.pendingRecoveryReason = null
    if (reason) this.signalRecovery(reason)
  }

  private async loop(
    audioFormat?: FormatEntry,
    videoFormat?: FormatEntry
  ): Promise<void> {
    const signal = this.abortController.signal
    const isVideoOnly = !audioFormat && !!videoFormat
    const enabledTrackTypesBitfield = isVideoOnly
      ? EnabledTrackTypes.VIDEO_ONLY
      : audioFormat && videoFormat
        ? EnabledTrackTypes.VIDEO_AND_AUDIO
        : EnabledTrackTypes.AUDIO_ONLY
    const targetRes =
      typeof videoFormat?.height === 'number' && videoFormat.height > 0
        ? videoFormat.height
        : 1080

    try {
      while (!this._aborted && !this.destroyed && !this.streamFinished) {
        if (this.recoveryPending || this.seekHandoffPending) {
          await wait(500, signal)
          continue
        }
        if (this.requestNumber === 0 && !this.poTokenGenerated) {
          this.poTokenGenerated = true
          try {
            const tokenData = await poTokenManager.generate(this.videoId)
            if (this._aborted || this.destroyed) break

            if (tokenData.poToken) {
              this.poToken = base64ToU8(tokenData.poToken)
              if (tokenData.visitorData) {
                this.visitorData = tokenData.visitorData
              }
              logger(
                'debug',
                'SABR',
                `Generated PO Token for session start. Used existing VD: ${!!this.visitorData}`
              )
            }
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e)
            logger('warn', 'SABR', `Failed to generate PO Token: ${message}`)
          }
        }

        const now = Date.now()
        const prevPlayerTime = this.virtualPlayerTimeMs
        const paused = this.playbackPaused?.() ?? false

        if (
          !paused &&
          this.mediaProgressGeneration > 0 &&
          this.lastVirtualAdvanceAt > 0 &&
          this.totalDownloadedMs > this.virtualPlayerTimeMs
        ) {
          this.virtualPlayerTimeMs = Math.min(
            this.virtualPlayerTimeMs + (now - this.lastVirtualAdvanceAt),
            this.totalDownloadedMs
          )
        }
        this.lastVirtualAdvanceAt = now

        if (
          Math.floor(this.virtualPlayerTimeMs / 1000) !==
          Math.floor(prevPlayerTime / 1000)
        ) {
          logger(
            'debug',
            'SABR',
            `Tracking: downloaded=${Math.floor(this.totalDownloadedMs)}ms virtualPlayerTime=${Math.floor(prevPlayerTime)}ms -> ${Math.floor(this.virtualPlayerTimeMs)}ms`
          )
        }

        const baseTimeMs = this.startTime ?? 0
        const reportedPlayerTime = Math.floor(
          this.virtualPlayerTimeMs + baseTimeMs
        )
        const requestCursorMs = Math.floor(this.totalDownloadedMs + baseTimeMs)

        if (this.readableLength > MAX_BUFFER_BYTES) {
          await wait(250, signal)
          continue
        }

        if (this.mediaProgressGeneration > 0 && this.positionCallback) {
          this.positionCallback(reportedPlayerTime)
        }

        if (paused && this.mediaProgressGeneration > 0) {
          await wait(250, signal)
          continue
        }

        if (this.lastRequestAt) {
          const since = now - this.lastRequestAt
          if (since < MIN_REQUEST_INTERVAL_MS) {
            await wait(MIN_REQUEST_INTERVAL_MS - since, signal)
          }
        }
        this.lastRequestAt = Date.now()

        const request = this.fetchAndProcessSegments(
          {
            playerTimeMs: requestCursorMs,
            bandwidthEstimate: Math.max(
              Math.floor(this.bandwidthEstimate),
              500_000
            ),
            enabledTrackTypesBitfield,
            audioTrackId: audioFormat?.audioTrackId ?? '',
            playerState: 1n,
            visibility: 1,
            playbackRate: 1.0,
            stickyResolution: targetRes,
            lastManualSelectedResolution: targetRes,
            clientViewportIsFlexible: false
          },
          audioFormat,
          videoFormat
        )
        this.activeRequest = request
        try {
          await request
        } catch (e) {
          if (this._aborted || this.destroyed) break

          const message = e instanceof Error ? e.message : String(e)
          if (message.startsWith('HTTP ')) {
            logger(
              'warn',
              'SABR',
              `HTTP failure detected: ${message}. Triggering session recovery...`
            )
            this.signalRecovery('http')
            continue
          }

          throw e
        } finally {
          if (this.activeRequest === request) this.activeRequest = null
        }

        if (
          !this.nextRequestPolicy?.backoffTimeMs &&
          this.initializedFormatsMap.size === 0
        ) {
          await wait(250, signal)
        }
      }
    } catch (e) {
      if (!this.destroyed) {
        this.destroy(e instanceof Error ? e : new Error(String(e)))
      }
    }
  }

  override destroy(err?: Error): this {
    if (this._aborted) return this
    this._aborted = true
    this.abortController.abort()
    this.initializedFormatsMap.clear()
    this.partialSegmentQueue.clear()
    this.sabrContexts.clear()
    this.activeSabrContextTypes.clear()
    this.formatSequenceCounters.clear()
    this.downloadedSegmentsByItag.clear()
    this.endSegmentNumbers.clear()
    this.pendingRangesHeaders.clear()
    this.cachedBufferedRanges = null
    this.lastReportedRanges.clear()
    this.nextRequestPolicy = undefined
    this.formatIds = []
    this.poToken = null
    this.videoPlaybackUstreamerConfig = undefined
    this.clientInfo = undefined
    this.config = {} as SabrStreamConfig
    super.destroy(err)
    return this
  }

  updateSession(config: Partial<SabrStreamConfig>): void {
    if (config.serverAbrStreamingUrl) {
      const url = new URL(config.serverAbrStreamingUrl)
      url.searchParams.set('alr', 'yes')
      url.searchParams.set('ump', '1')
      url.searchParams.set('srfvp', '1')
      this.serverAbrStreamingUrl = url.toString()
    }
    if (config.videoPlaybackUstreamerConfig) {
      this.videoPlaybackUstreamerConfig = config.videoPlaybackUstreamerConfig
    }
    if (config.poToken != null) {
      try {
        this.poToken =
          typeof config.poToken === 'string'
            ? base64ToU8(config.poToken)
            : config.poToken
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        logger(
          'error',
          'SABR',
          `Failed to decode PO token (session update): ${message}`
        )
        this.poToken = null
      }
    }
    if (config.visitorData) {
      this.visitorData = config.visitorData
    }
    if (config.clientInfo) {
      this.clientInfo = config.clientInfo
    }
    if (config.formats) {
      this.formatIds = config.formats
    }
    if (config.userAgent) {
      this.userAgent = config.userAgent
    }
    if (config.playbackCookie) {
      if (!this.nextRequestPolicy) this.nextRequestPolicy = {}
      this.nextRequestPolicy.playbackCookie =
        config.playbackCookie instanceof Uint8Array
          ? config.playbackCookie
          : base64ToU8(config.playbackCookie)
    } else if (this.nextRequestPolicy) {
      delete this.nextRequestPolicy.playbackCookie
    }
    this.requestNumber = 0
    this.noMediaStreak = 0
    this.pendingRangesHeaders.clear()
    this.recoveryPending = false
    this.poTokenGenerated =
      config.poToken != null && (this.poToken?.length ?? 0) > 0
    this.pendingRecoveryReason = null
    this.pendingResponseError = null
    this.limitedPlaybackCount = 0
    this.limitedPlaybackGeneration = this.mediaProgressGeneration
    this.lastProtectionRefreshAt = 0
    this.protectionRefreshPending = false
    this.usingTransferredSession = false

    logger(
      'info',
      'SABR',
      `Session updated. Continuing with RN=${this.requestNumber}, URL=${this.serverAbrStreamingUrl?.slice(0, 50)}...`
    )
  }

  clearBuffers(): void {
    this.initializedFormatsMap.clear()
    this.partialSegmentQueue.clear()

    this.pendingRangesHeaders.clear()
    this.cachedBufferedRanges = null
    this.lastReportedRanges.clear()

    this.sabrContexts.clear()
    this.activeSabrContextTypes.clear()

    logger(
      'info',
      'SABR',
      `Buffers cleared for recovery. Preserving timeline position: ${this.cumulativeDownloadedMs}ms, totalDownloaded: ${this.totalDownloadedMs}ms`
    )
  }

  private decodePart<T>(
    part: UmpPart,
    decoder: { decode: (reader: ProtoReader, len: number) => T }
  ): T | undefined {
    try {
      const chunks = part.data.chunks
      const data =
        chunks.length === 1
          ? (chunks[0] as Uint8Array)
          : concatenateChunks(chunks)
      return decoder.decode(new ProtoReader(data), data.length)
    } catch {
      return undefined
    }
  }

  private resolveFormatIdForRequest(
    format: FormatEntry
  ): { itag: number; lastModified?: string; xtags?: string } | undefined {
    if (!format) return undefined
    if (format.xtags) {
      return {
        itag: format.itag,
        lastModified: format.lastModified,
        xtags: format.xtags
      }
    }

    const prefix = `${format.itag}:`
    for (const [k, v] of this.initializedFormatsMap.entries()) {
      if (!k.startsWith(prefix)) continue

      const fid = v?.formatInitializationMetadata?.formatId
      if (fid?.itag) {
        return {
          itag: fid.itag,
          lastModified: (fid.lastModified ??
            fid.last_modified ??
            format.lastModified) as string | undefined,
          xtags: fid.xtags
        }
      }
    }

    return {
      itag: format.itag,
      lastModified: format.lastModified,
      xtags: format.xtags
    }
  }

  private handleFormatInitializationMetadata(part: UmpPart): void {
    const m = this.decodePart(part, FormatInitializationMetadata)
    if (!m) return
    const k = FormatKeyUtils.fromFormatInitializationMetadata(m)
    if (!this.initializedFormatsMap.has(k)) {
      this.initializedFormatsMap.set(k, { formatInitializationMetadata: m })
      logger(
        'debug',
        'SABR',
        `Format init: key=${k} mime=${m.mimeType ?? ''} endSeg=${m.endSegmentNumber ?? ''}`
      )

      const itag = m.formatId?.itag ?? m.itag
      if (
        itag &&
        m.endSegmentNumber !== undefined &&
        Number(m.endSegmentNumber) > 0
      ) {
        this.endSegmentNumbers.set(itag, Number(m.endSegmentNumber))
        logger(
          'debug',
          'SABR',
          `Tracking completion: itag=${itag} will finish at segment ${m.endSegmentNumber}`
        )
      }
    }
  }

  private handleSabrError(part: UmpPart): void {
    const err = this.decodePart(part, SabrError)
    if (err) {
      const error = new Error(`SABR Error: ${err.code} ${err.type}`)
      ;(error as Error & { code?: number; type?: string }).code = err.code
      ;(error as Error & { code?: number; type?: string }).type = err.type
      if (this._aborted || this.destroyed) return
      this.pendingResponseError ??= error
    }
  }

  private handleSabrRedirect(part: UmpPart): void {
    const red = this.decodePart(part, SabrRedirect)
    if (red?.url) {
      this.serverAbrStreamingUrl = red.url
    }
  }

  private handleStreamProtectionStatus(part: UmpPart): void {
    const status = this.decodePart(part, StreamProtectionStatus)
    if (!status) return

    const now = Date.now()
    const changed = this.lastStreamProtectionStatus !== status.status
    const shouldLog =
      changed ||
      !this.lastStreamProtectionLogAt ||
      now - this.lastStreamProtectionLogAt > 5000

    this.lastStreamProtectionStatus = status.status
    if (status.status === 2) {
      if (this.limitedPlaybackGeneration !== this.mediaProgressGeneration) {
        this.limitedPlaybackGeneration = this.mediaProgressGeneration
        this.limitedPlaybackCount = 0
      }
      this.limitedPlaybackCount++

      if (shouldLog) {
        this.lastStreamProtectionLogAt = now
        logger(
          'warn',
          'SABR',
          `Stream Protection Status: ${status.status} (Limited Playback), observation ${this.limitedPlaybackCount} without media progress.`
        )
      }

      if (this.limitedPlaybackCount >= 2) {
        const sinceRefresh = now - this.lastProtectionRefreshAt
        if (
          !this.protectionRefreshPending &&
          sinceRefresh > PROTECTION_REFRESH_COOLDOWN_MS
        ) {
          this.refreshProtectionToken()
        }
        if (this.limitedPlaybackCount >= MAX_LIMITED_PLAYBACK_COUNT) {
          poTokenManager.reset()
          this.queueRecovery('protection')
        }
      }
      return
    }

    this.limitedPlaybackCount = 0
    this.limitedPlaybackGeneration = this.mediaProgressGeneration
    if (!shouldLog) return
    this.lastStreamProtectionLogAt = now

    if (status.status === 3) {
      logger(
        'debug',
        'SABR',
        `Stream Protection Status: ${status.status} (Attestation pending/required)`
      )
      return
    }

    logger('warn', 'SABR', `Stream Protection Status: ${status.status}`)
  }

  private handleMediaPartial(
    buffer: CompositeBuffer,
    headerId: number,
    isFirstChunk: boolean
  ): void {
    const s = this.partialSegmentQueue.get(headerId)
    if (s) {
      let dataToPush = buffer

      if (isFirstChunk) {
        if (buffer.getLength() > 1) {
          dataToPush = buffer.split(1).remainingBuffer
        } else if (buffer.getLength() === 1) {
          return
        }
      }

      const bytes = dataToPush.getLength()
      s.loadedBytes = (s.loadedBytes ?? 0) + bytes

      if (s.discard) return

      for (const c of dataToPush.chunks) this.push(c)
    }
  }

  private handleMedia(part: UmpPart): void {
    const headerId = part.data.getUint8(0)
    const s = this.partialSegmentQueue.get(headerId)
    if (s) {
      const d = part.data.split(1).remainingBuffer
      const bytes = d.getLength()
      s.loadedBytes = (s.loadedBytes ?? 0) + bytes

      if (!s.discard) {
        for (const c of d.chunks) this.push(c)
      }

      if (bytes > 0 && !s.discard) {
        logger(
          'debug',
          'SABR',
          `Media data: id=${headerId} bytes=${bytes} total=${s.loadedBytes}/${s.mediaHeader?.contentLength ?? '?'}`
        )
      }
    } else {
      logger('trace', 'SABR', `Media data for unknown headerId: ${headerId}`)
    }
  }

  private handleMediaHeader(part: UmpPart): void {
    const h = this.decodePart(part, MediaHeader)
    if (h) {
      const key = FormatKeyUtils.fromMediaHeader(h)
      const headerId = h.headerId ?? 0

      let segmentNumber = h.sequenceNumber
      if (h.isInitSeg) {
        segmentNumber = 0
      } else if (segmentNumber === undefined || segmentNumber === 0) {
        const count = (this.formatSequenceCounters.get(h.itag) ?? 0) + 1
        this.formatSequenceCounters.set(h.itag, count)
        segmentNumber = count
      } else {
        this.formatSequenceCounters.set(h.itag, segmentNumber)
      }

      if (!h.durationMs || h.durationMs === '0') {
        if (h.timeRange && h.timeRange.timescale > 0) {
          h.durationMs = Math.ceil(
            (Number(h.timeRange.durationTicks ?? 0n) / h.timeRange.timescale) *
              1000
          ).toString()
        }
      }

      const mediaHeader = h
      const formatIdKey = key
      const itag = h.itag ?? h.formatId?.itag
      const isWrongItag =
        this.targetItag !== null &&
        itag !== undefined &&
        itag !== this.targetItag
      const discard =
        isWrongItag ||
        (itag !== undefined &&
          this.downloadedSegmentsByItag.get(itag)?.has(segmentNumber) === true)

      if (!discard) {
        if (!this.pendingRangesHeaders.has(formatIdKey)) {
          this.pendingRangesHeaders.set(formatIdKey, [])
        }
        this.pendingRangesHeaders.get(formatIdKey)?.push(mediaHeader)
      }

      logger(
        discard ? 'trace' : 'debug',
        'SABR',
        `${discard ? 'Duplicate media header' : 'MediaHeader'}: id=${headerId} itag=${h.itag} seq=${segmentNumber} dur=${h.durationMs}ms`
      )

      this.partialSegmentQueue.set(headerId, {
        formatIdKey: key,
        segmentNumber,
        mediaHeader: h,
        durationMs: h.durationMs,
        loadedBytes: 0,
        discard
      })
    } else {
      logger('warn', 'SABR', 'Failed to decode MediaHeader')
    }
  }

  private handleMediaEnd(part: UmpPart): void {
    const id = part.data.getUint8(0)
    const s = this.partialSegmentQueue.get(id)
    if (s) {
      logger(
        'debug',
        'SABR',
        `MediaEnd: id=${id} seq=${s.segmentNumber} totalBytes=${s.loadedBytes}`
      )

      const itag = s.mediaHeader?.itag ?? s.mediaHeader?.formatId?.itag

      if (s.discard) {
        logger(
          'debug',
          'SABR',
          `Discarded duplicate segment ${s.segmentNumber} for itag ${itag ?? 'unknown'} (${s.loadedBytes} bytes)`
        )
        this.partialSegmentQueue.delete(id)
        return
      }

      let segmentDuration = 0
      if (s.durationMs) {
        segmentDuration = Number(s.durationMs)
      } else if (
        s.mediaHeader?.timeRange &&
        s.mediaHeader.timeRange.timescale > 0
      ) {
        segmentDuration = Math.ceil(
          (Number(s.mediaHeader.timeRange.durationTicks ?? 0n) /
            s.mediaHeader.timeRange.timescale) *
            1000
        )
      }

      if (segmentDuration > 0) {
        this.totalDownloadedMs += segmentDuration
        if ((s.loadedBytes ?? 0) > 0) this.recordMediaProgress()
        logger(
          'debug',
          'SABR',
          `Segment received: itag=${itag} seq=${s.segmentNumber} dur=${segmentDuration}ms totalDownloaded=${Math.floor(this.totalDownloadedMs)}ms`
        )
      }

      if (itag) {
        if (!this.downloadedSegmentsByItag.has(itag)) {
          this.downloadedSegmentsByItag.set(itag, new Map())
        }
        const segMap = this.downloadedSegmentsByItag.get(itag)

        if (segMap?.has(s.segmentNumber)) {
          logger(
            'warn',
            'SABR',
            `Ignoring duplicate segment ${s.segmentNumber} for itag ${itag}`
          )
        } else if (segMap) {
          let startMs = Number(s.mediaHeader.startMs ?? 0)
          if (
            startMs === 0 &&
            s.mediaHeader.timeRange &&
            s.mediaHeader.timeRange.timescale > 0
          ) {
            startMs = Number(
              (BigInt(s.mediaHeader.timeRange.startTicks ?? 0n) * 1000n) /
                BigInt(s.mediaHeader.timeRange.timescale)
            )
          }
          const endMs = startMs + segmentDuration

          if (segMap.size >= MAX_TRACKED_SEGMENTS_PER_ITAG) {
            const oldest = segMap.keys().next().value
            if (oldest !== undefined) segMap.delete(oldest)
          }
          segMap.set(s.segmentNumber, {
            segmentNumber: s.segmentNumber,
            durationMs: segmentDuration,
            byteLength: s.loadedBytes ?? 0,
            startMs,
            endMs
          })

          let maxEdge = this.cumulativeDownloadedMs ?? 0
          if (endMs > maxEdge) maxEdge = endMs
          this.cumulativeDownloadedMs = maxEdge

          const endSegmentNumber = this.endSegmentNumbers.get(itag)
          if (
            endSegmentNumber !== undefined &&
            s.segmentNumber >= endSegmentNumber &&
            !this.streamFinished
          ) {
            this.streamFinished = true
            logger(
              'info',
              'SABR',
              `Stream complete: received final segment ${s.segmentNumber}/${endSegmentNumber} for itag ${itag}`
            )

            setImmediate(() => {
              if (!this.destroyed && !this._aborted) {
                logger('info', 'SABR', 'Emitting finishBuffering event')
                this.emit('finishBuffering')
                this.end()
              }
            })
          }
        }
      }

      this.partialSegmentQueue.delete(id)
    }
  }

  private handlePlaybackStartPolicy(part: UmpPart): void {
    this.decodePart(part, PlaybackStartPolicy)
  }

  private handleRequestIdentifier(part: UmpPart): void {
    this.decodePart(part, RequestIdentifier)
  }

  private handleRequestCancellationPolicy(part: UmpPart): void {
    this.decodePart(part, RequestCancellationPolicy)
  }

  private handleNextRequestPolicy(part: UmpPart): void {
    const policy = this.decodePart(part, NextRequestPolicy)
    if (!policy) return

    this.nextRequestPolicy = policy

    const cookieLen = policy.playbackCookie?.length ?? 0
    const backoff = policy.backoffTimeMs ?? 0

    const now = Date.now()
    const changed =
      this._lastPolicyBackoff !== backoff ||
      this._lastPolicyCookieLen !== cookieLen
    const shouldLog =
      changed || !this._lastPolicyLogAt || now - this._lastPolicyLogAt > 2000

    this._lastPolicyBackoff = backoff
    this._lastPolicyCookieLen = cookieLen
    if (!shouldLog) return
    this._lastPolicyLogAt = now

    logger(
      'debug',
      'SABR',
      `NextRequestPolicy: backoff=${backoff}ms cookieLen=${cookieLen}`
    )
  }

  private handleSabrContextUpdate(part: UmpPart): void {
    const ctx = this.decodePart(part, SabrContextUpdate)
    if (ctx && ctx.type !== undefined && ctx.value?.length) {
      this.sabrContexts.set(ctx.type, {
        type: ctx.type,
        value: ctx.value,
        sendByDefault: ctx.sendByDefault
      })
      if (ctx.sendByDefault) this.activeSabrContextTypes.add(ctx.type)
      logger(
        'debug',
        'SABR',
        `Received context update type=${ctx.type} len=${ctx.value?.length} sendByDefault=${ctx.sendByDefault}`
      )
    }
  }

  private handleSabrContextSendingPolicy(part: UmpPart): void {
    const policy = this.decodePart(part, SabrContextSendingPolicy)
    if (policy) {
      for (const type of policy.startPolicy) {
        this.activeSabrContextTypes.add(type)
      }
      for (const type of policy.stopPolicy) {
        this.activeSabrContextTypes.delete(type)
      }
      for (const type of policy.discardPolicy) this.sabrContexts.delete(type)
    }
  }

  private handleSnackbarMessage(_part: UmpPart): void {}

  private handleReloadPlayerResponse(part: UmpPart): void {
    const reloadContext = this.decodePart(part, ReloadPlaybackContext)
    if (reloadContext) {
      const reason = (reloadContext as Record<string, unknown>).reason
      logger(
        'warn',
        'SABR',
        `Reload requested by server. Reason: ${reason ?? 'unknown'}`
      )
      this.queueRecovery('reload')
    }
  }

  private logDetailedState(params: DetailedStateParams): void {
    const {
      abrState,
      audioFormat,
      videoFormat,
      initializationFormatIds,
      selectedAudioFormatIds,
      bufferedRanges,
      contexts,
      unsent
    } = params

    const now = Date.now()
    if (this.lastDetailedLogAt && now - this.lastDetailedLogAt < 2000) return
    this.lastDetailedLogAt = now

    const cookieLen = this.nextRequestPolicy?.playbackCookie?.length ?? 0
    const initKeys = Array.from(this.initializedFormatsMap.keys()).slice(0, 5)

    const playbackTimeMs = Math.floor(
      this.virtualPlayerTimeMs + (this.startTime ?? 0)
    )
    const bufferedAheadMs = Math.max(
      0,
      Math.floor(this.totalDownloadedMs - this.virtualPlayerTimeMs)
    )

    const fmt = (f: FormatEntry | undefined): string =>
      f ? `${f.itag}:${f.xtags ?? ''}` : 'none'
    const fmtId = (f: FormatIdMsg): string => `${f.itag ?? ''}:${f.xtags ?? ''}`

    logger(
      'debug',
      'SABR',
      `State rn=${this.requestNumber} requestCursorMs=${abrState?.playerTimeMs} playbackTimeMs=${playbackTimeMs} startTime=${this.startTime} readable=${this.readableLength}/${MAX_BUFFER_BYTES} initKeys=[${initKeys.join(',')}] downloadedMs=${Math.floor(this.totalDownloadedMs)} bufferedAheadMs=${bufferedAheadMs}`
    )

    logger(
      'debug',
      'SABR',
      `Req formats audio=${fmt(audioFormat)} video=${fmt(videoFormat)} init=[${(initializationFormatIds ?? []).map(fmtId).join(',')}] selectedA=[${(selectedAudioFormatIds ?? []).map(fmtId).join(',')}] bufferedRanges=${bufferedRanges?.length ?? 0} ctx=${contexts?.length ?? 0} unsentCtx=${unsent?.length ?? 0} backoff=${this.nextRequestPolicy?.backoffTimeMs ?? 0} cookieLen=${cookieLen}`
    )

    if (bufferedRanges?.length) {
      const br = bufferedRanges[0]
      if (br) {
        logger(
          'debug',
          'SABR',
          `BufferedRange[0]: itag=${br.formatId?.itag} xtags=${br.formatId?.xtags ?? ''} startMs=${br.startTimeMs ?? ''} durMs=${br.durationMs ?? ''} seg=[${br.startSegmentIndex ?? ''},${br.endSegmentIndex ?? ''}] ts=${br.timeRange?.timescale ?? ''} durTicks=${br.timeRange?.durationTicks ?? ''}`
        )
      }
    }
  }

  private buildBufferedRanges(
    vFormat: FormatEntry | undefined,
    aFormat: FormatEntry | undefined
  ): BufferedRangeSummary[] {
    const bufferedRanges: BufferedRangeSummary[] = []
    const formats = [vFormat, aFormat].filter(
      (f): f is FormatEntry => f !== undefined
    )

    for (const format of formats) {
      const itag = format.itag
      const formatIdKey = createKey(itag, format.xtags)
      const headers = this.pendingRangesHeaders.get(formatIdKey)

      if (!headers || headers.length === 0) continue

      const durationMs = headers.reduce(
        (sum, h) => sum + parseInt(h.durationMs ?? '0', 10),
        0
      )
      const startH = headers[0]
      const endH = headers[headers.length - 1]

      if (!startH || !endH) continue

      bufferedRanges.push({
        durationMs: durationMs.toString(),
        formatId: this.resolveFormatIdForRequest(format),
        startTimeMs: (startH.startMs ?? '0').toString(),
        startSegmentIndex: startH.sequenceNumber ?? 1,
        endSegmentIndex: endH.sequenceNumber ?? 1,
        timeRange: {
          durationTicks: (
            (BigInt(durationMs) * BigInt(startH.timeRange?.timescale ?? 1000)) /
            1000n
          ).toString(),
          startTicks: (startH.startMs ?? '0').toString(),
          timescale: startH.timeRange?.timescale ?? 1000
        }
      })

      this.pendingRangesHeaders.set(formatIdKey, [])
    }

    return bufferedRanges
  }

  private async fetchAndProcessSegments(
    abrState: AbrState,
    audioFormat?: FormatEntry,
    videoFormat?: FormatEntry
  ): Promise<void> {
    if (!this.videoPlaybackUstreamerConfig || !this.clientInfo) {
      throw new Error('Missing config')
    }

    const collectTrafficDumps = this.enableTrafficLog && this.enableTrafficDump

    if (
      this.nextRequestPolicy?.backoffTimeMs &&
      this.nextRequestPolicy.backoffTimeMs > 0
    ) {
      const backoff = this.nextRequestPolicy.backoffTimeMs
      logger('warn', 'SABR', `Waiting for backoff: ${backoff}ms`)
      await wait(backoff, this.abortController.signal)
      this.nextRequestPolicy.backoffTimeMs = 0
    }

    const formats = [videoFormat, audioFormat].filter(
      (f): f is FormatEntry => f !== undefined
    )
    const formatsInitialized = this.initializedFormatsMap.size > 0
    const requestFormatIds = formats
      .map((f) => this.resolveFormatIdForRequest(f))
      .filter(
        (
          f
        ): f is NonNullable<
          ReturnType<typeof this.resolveFormatIdForRequest>
        > => f !== undefined
      )

    const initializationFormatIds = formatsInitialized ? requestFormatIds : []

    if (!this.cachedBufferedRanges) {
      this.cachedBufferedRanges = this.buildBufferedRanges(
        videoFormat,
        audioFormat
      )
    }

    const contexts: Array<{ type: number; value: Uint8Array }> = []
    const unsent: number[] = []

    for (const ctx of this.sabrContexts.values()) {
      if (this.activeSabrContextTypes.has(ctx.type)) {
        contexts.push({ type: ctx.type, value: ctx.value })
      } else {
        unsent.push(ctx.type)
      }
    }

    const selectedAudioFormatIds = audioFormat
      ? [this.resolveFormatIdForRequest(audioFormat)].filter(
          (
            f
          ): f is NonNullable<
            ReturnType<typeof this.resolveFormatIdForRequest>
          > => f !== undefined
        )
      : []
    const selectedVideoFormatIds = videoFormat
      ? [this.resolveFormatIdForRequest(videoFormat)].filter(
          (
            f
          ): f is NonNullable<
            ReturnType<typeof this.resolveFormatIdForRequest>
          > => f !== undefined
        )
      : []
    const bufferedRanges = this.cachedBufferedRanges ?? []

    this.logDetailedState({
      abrState,
      audioFormat,
      videoFormat,
      initializationFormatIds,
      selectedAudioFormatIds,
      selectedVideoFormatIds,
      bufferedRanges,
      contexts,
      unsent
    })

    const requestBody = VideoPlaybackAbrRequest.encode({
      clientAbrState: {
        ...abrState,
        playerTimeMs: BigInt(abrState.playerTimeMs ?? 0).toString(),
        bandwidthEstimate: BigInt(abrState.bandwidthEstimate ?? 0).toString(),
        timeSinceLastActionMs: 0n
      },
      initializationFormatIds,
      bufferedRanges: bufferedRanges.map((r) => ({
        formatId: r.formatId,
        startTimeMs: r.startTimeMs ?? '0',
        durationMs: r.durationMs ?? '0',
        startSegmentIndex: r.startSegmentIndex ?? 1,
        endSegmentIndex: r.endSegmentIndex ?? 1,
        timeRange: r.timeRange
          ? {
              startTicks: r.timeRange.startTicks ?? '0',
              durationTicks: r.timeRange.durationTicks ?? '0',
              timescale: r.timeRange.timescale ?? 1000
            }
          : undefined
      })),
      videoPlaybackUstreamerConfig:
        typeof this.videoPlaybackUstreamerConfig === 'string'
          ? base64ToU8(this.videoPlaybackUstreamerConfig)
          : this.videoPlaybackUstreamerConfig,
      selectedAudioFormatIds,
      selectedVideoFormatIds,
      streamerContext: {
        poToken: this.poToken ?? undefined,
        playbackCookie: this.nextRequestPolicy?.playbackCookie,
        clientInfo: this.clientInfo,
        sabrContexts: contexts,
        unsentSabrContexts: unsent
      }
    })

    const trafficReq: TrafficLogEntry = {
      ts: new Date().toISOString(),
      dir: 'client->yt',
      rn: this.requestNumber,
      url: this.serverAbrStreamingUrl,
      playerTimeMs: abrState.playerTimeMs,
      requestBodyBytes: requestBody.length,
      requestBodySha256: sha256Hex(requestBody),
      requestBodyB64: collectTrafficDumps
        ? b64Trunc(requestBody, this.trafficDumpMaxBytes)
        : undefined,
      requestBodyB64Truncated: collectTrafficDumps
        ? requestBody.length > this.trafficDumpMaxBytes
        : undefined,
      selectedAudioItags: selectedAudioFormatIds.map((f) => f.itag),
      selectedVideoItags: selectedVideoFormatIds.map((f) => f.itag),
      initializationItags: initializationFormatIds.map((f) => f.itag),
      bufferedRanges: bufferedRanges.map((r) => ({
        itag: r.formatId?.itag,
        startMs: r.startTimeMs ?? '0',
        durMs: r.durationMs ?? '0',
        seg: [r.startSegmentIndex ?? 0, r.endSegmentIndex ?? 0] as [
          number,
          number
        ]
      })),
      cookieLen: this.nextRequestPolicy?.playbackCookie?.length ?? 0,
      contexts: contexts.map((c) => ({
        type: c.type,
        valueLen: c.value.length
      })),
      unsentContexts: unsent
    }
    this.logTraffic(trafficReq)

    logger(
      'debug',
      'SABR',
      `Traffic -> rn=${trafficReq.rn} body=${trafficReq.requestBodyBytes}B br=${trafficReq.bufferedRanges?.length ?? 0} cookieLen=${trafficReq.cookieLen} sha256=${trafficReq.requestBodySha256}`
    )
    logger(
      'debug',
      'SABR',
      `Traffic -> rn=${trafficReq.rn} abrState(playerTimeMs=${trafficReq.playerTimeMs} enabled=${abrState.enabledTrackTypesBitfield} visibility=${abrState.visibility} rate=${abrState.playbackRate}) ctx=${trafficReq.contexts?.length ?? 0} unsentCtx=${trafficReq.unsentContexts?.length ?? 0}`
    )

    const reqPreviewB64 = b64Trunc(requestBody, 1024)
    logger(
      'debug',
      'SABR',
      `Traffic -> rn=${trafficReq.rn} bodyB64[1024B]=${reqPreviewB64.length > 260 ? `${reqPreviewB64.slice(0, 260)}...` : reqPreviewB64}`
    )

    const rn = this.requestNumber
    const url = new URL(this.serverAbrStreamingUrl ?? '')
    url.searchParams.set('rn', rn.toString())
    this.requestNumber++

    const headers: Record<string, string> = {
      'content-type': 'application/x-protobuf',
      accept: 'application/vnd.yt-ump',
      'x-goog-visitor-id': this.visitorData ?? '',
      'x-youtube-client-name': String(this.clientInfo?.clientName ?? '1'),
      'x-youtube-client-version': this.clientInfo?.clientVersion ?? '',
      origin: 'https://www.youtube.com',
      referer: `https://www.youtube.com/watch?v=${this.videoId}`,
      'user-agent': this.userAgent
    }

    if (this.config.accessToken) {
      headers.Authorization = `Bearer ${this.config.accessToken}`
    }

    const fetchStart = Date.now()
    let res: Response
    try {
      res = await fetch(url.toString(), {
        method: 'POST',
        headers,
        body: Buffer.from(requestBody),
        signal: this.abortController.signal
      })
    } catch (error) {
      if (
        this._aborted ||
        this.destroyed ||
        this.abortController.signal.aborted
      ) {
        throw error
      }
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`HTTP request failed: ${message}`, { cause: error })
    }

    if (!res.ok) {
      let errorText = ''
      try {
        errorText = await res.text()
      } catch {
        errorText = '(Failed to read response body)'
      }

      this.logTraffic({
        ts: new Date().toISOString(),
        dir: 'yt->client',
        rn,
        status: res.status,
        ok: false,
        statusText: res.statusText,
        url: url.toString(),
        durationMs: Date.now() - fetchStart,
        responseBytes: (errorText ?? '').length,
        errorText: errorText.slice(0, 2000)
      })

      logger('error', 'SABR', `Fetch failed: ${res.status} ${res.statusText}`)
      logger('error', 'SABR', `URL: ${url.toString()}`)
      logger('error', 'SABR', `Response Body: ${errorText}`)
      throw new Error(`HTTP ${res.status}: ${errorText}`)
    }

    const signal = this.abortController.signal

    if (!res.body) throw new Error('Missing response body')

    const t0 = Date.now()
    const reader = res.body.getReader()
    let buffer = new CompositeBuffer()
    const ump = new UmpReader(buffer)
    let responseBytes = 0
    const responseHash = createHash('sha256')
    const responseDumpChunks: Uint8Array[] = []
    let responseDumpBytes = 0

    const partCounts: Record<string, number> = Object.create(null)
    const partSeq: PartSequenceEntry[] = []
    const partDumps: PartDumpEntry[] = []
    const saw: SawFlags = {
      media: false,
      mediaHeader: false,
      mediaEnd: false,
      nextRequestPolicy: false,
      playbackStartPolicy: false,
      requestIdentifier: false,
      requestCancellationPolicy: false,
      sabrError: false,
      sabrRedirect: false,
      sabrContextUpdate: false,
      streamProtectionStatus: false
    }

    this.pendingResponseError = null
    const responseStartGeneration = this.mediaProgressGeneration

    let activePartial: ActivePartial | null = null

    try {
      while (!this._aborted && !this.destroyed) {
        const { done, value } = await reader.read()
        if (done) break

        responseBytes += value.length
        if (collectTrafficDumps) responseHash.update(value)

        if (
          collectTrafficDumps &&
          this.trafficDumpMaxBytes > 0 &&
          responseDumpBytes < this.trafficDumpMaxBytes
        ) {
          const take = Math.min(
            value.length,
            this.trafficDumpMaxBytes - responseDumpBytes
          )
          if (take > 0) {
            responseDumpChunks.push(value.subarray(0, take))
            responseDumpBytes += take
          }
        }

        buffer.append(value)
        ump.compositeBuffer = buffer

        const incomplete = ump.read((part) => {
          if (this._aborted) return

          let handled = false
          if (
            part.type === UMPPartId.MEDIA &&
            activePartial &&
            activePartial.type === UMPPartId.MEDIA
          ) {
            const alreadyPushed = activePartial.processedBytes
            const remainder = part.data.split(alreadyPushed).remainingBuffer

            const headerId =
              activePartial.id ??
              (part.data.getLength() > 0 ? part.data.getUint8(0) : 0)
            const isFirst = alreadyPushed === 0

            this.handleMediaPartial(remainder, headerId, isFirst)
            handled = true
            activePartial = null
          }

          if (activePartial) activePartial = null

          partCounts[part.type] = (partCounts[part.type] ?? 0) + 1
          partSeq.push({
            type: part.type,
            name: umpPartName(part.type),
            size: part.size
          })

          if (part.type === UMPPartId.MEDIA) saw.media = true
          else if (part.type === UMPPartId.MEDIA_HEADER) saw.mediaHeader = true
          else if (part.type === UMPPartId.MEDIA_END) saw.mediaEnd = true
          else if (part.type === UMPPartId.NEXT_REQUEST_POLICY) {
            saw.nextRequestPolicy = true
          } else if (part.type === UMPPartId.PLAYBACK_START_POLICY) {
            saw.playbackStartPolicy = true
          } else if (part.type === UMPPartId.REQUEST_IDENTIFIER) {
            saw.requestIdentifier = true
          } else if (part.type === UMPPartId.REQUEST_CANCELLATION_POLICY) {
            saw.requestCancellationPolicy = true
          } else if (part.type === UMPPartId.SABR_ERROR) saw.sabrError = true
          else if (part.type === UMPPartId.SABR_REDIRECT) {
            saw.sabrRedirect = true
          } else if (part.type === UMPPartId.SABR_CONTEXT_UPDATE) {
            saw.sabrContextUpdate = true
          } else if (part.type === UMPPartId.STREAM_PROTECTION_STATUS) {
            saw.streamProtectionStatus = true
          }

          if (collectTrafficDumps && this.trafficDumpMaxBytes > 0) {
            const shouldDumpPayload =
              part.type !== UMPPartId.MEDIA &&
              part.type !== UMPPartId.MEDIA_HEADER &&
              part.type !== UMPPartId.MEDIA_END
            if (shouldDumpPayload && part.size <= this.trafficDumpMaxBytes) {
              try {
                const payload = concatenateChunks(part.data.chunks)
                let decoded: Record<string, unknown> | undefined
                try {
                  if (part.type === UMPPartId.PLAYBACK_START_POLICY) {
                    decoded = PlaybackStartPolicy.decode(
                      new ProtoReader(payload),
                      payload.length
                    )
                  } else if (part.type === UMPPartId.REQUEST_IDENTIFIER) {
                    decoded = RequestIdentifier.decode(
                      new ProtoReader(payload),
                      payload.length
                    ) as unknown as Record<string, unknown>
                  } else if (
                    part.type === UMPPartId.REQUEST_CANCELLATION_POLICY
                  ) {
                    decoded = RequestCancellationPolicy.decode(
                      new ProtoReader(payload),
                      payload.length
                    )
                  }
                } catch {}

                partDumps.push({
                  type: part.type,
                  name: umpPartName(part.type),
                  size: part.size,
                  sha256: sha256Hex(payload),
                  payloadB64: b64Trunc(payload, this.trafficDumpMaxBytes),
                  payloadB64Truncated:
                    payload.length > this.trafficDumpMaxBytes,
                  decoded
                })
              } catch {}
            }
          }

          if (!handled) {
            const handler = this.umpPartHandlers.get(part.type)
            if (handler) handler(part)
          }
        })

        if (ump.compositeBuffer) {
          const resIncomplete = incomplete
          if (resIncomplete?.incomplete) {
            if (!activePartial) {
              activePartial = {
                type: resIncomplete.type,
                totalSize: resIncomplete.size,
                headerSize: resIncomplete.headerSize,
                processedBytes: 0,
                id: undefined
              }
            }

            if (resIncomplete.type === UMPPartId.MEDIA) {
              const available = resIncomplete.data.getLength()
              const newBytesCount = available - activePartial.processedBytes

              if (newBytesCount > 0) {
                const split = resIncomplete.data.split(
                  activePartial.processedBytes
                )
                const newChunk = split.remainingBuffer

                let headerId = activePartial.id

                if (
                  activePartial.processedBytes === 0 &&
                  newChunk.getLength() >= 1
                ) {
                  headerId = newChunk.getUint8(0)
                  activePartial.id = headerId
                }

                if (headerId !== undefined) {
                  const isFirst = activePartial.processedBytes === 0
                  this.handleMediaPartial(newChunk, headerId, isFirst)
                }

                activePartial.processedBytes += newBytesCount
              }
            }
          }

          buffer = ump.compositeBuffer
        }
      }
    } catch (err) {
      if (!(this._aborted || this.destroyed || signal.aborted)) throw err
    } finally {
      try {
        await reader.cancel()
      } catch {}
      try {
        reader.releaseLock()
      } catch {}
      const totalDuration = Date.now() - t0
      if (responseBytes > 0 && totalDuration > 0) {
        if (saw.media || responseBytes > 5000) {
          this.updateBandwidthEstimate(responseBytes, totalDuration)
        }
      }
    }

    const responseDump =
      collectTrafficDumps && responseDumpChunks.length
        ? concatenateChunks(responseDumpChunks)
        : undefined

    const trafficRes: TrafficLogEntry = {
      ts: new Date().toISOString(),
      dir: 'yt->client',
      rn,
      status: res.status,
      ok: true,
      url: url.toString(),
      durationMs: Date.now() - t0,
      responseBytes,
      responseSha256: collectTrafficDumps
        ? responseHash.digest('hex')
        : undefined,
      responseBodyB64: responseDump
        ? Buffer.from(responseDump).toString('base64')
        : undefined,
      responseBodyB64Truncated: collectTrafficDumps
        ? responseBytes > this.trafficDumpMaxBytes
        : undefined,
      contentType: res.headers.get('content-type') ?? '',
      contentLength: res.headers.get('content-length') ?? '',
      parts: partCounts,
      partSeq,
      partDumps: partDumps.length ? partDumps : undefined,
      saw,
      policy: {
        backoffTimeMs: this.nextRequestPolicy?.backoffTimeMs ?? 0,
        cookieLen: this.nextRequestPolicy?.playbackCookie?.length ?? 0,
        targetAudioReadaheadMs: this.nextRequestPolicy?.targetAudioReadaheadMs,
        minAudioReadaheadMs: this.nextRequestPolicy?.minAudioReadaheadMs,
        maxTimeSinceLastRequestMs:
          this.nextRequestPolicy?.maxTimeSinceLastRequestMs
      }
    }

    this.logTraffic(trafficRes)
    logger(
      'debug',
      'SABR',
      `Traffic <- rn=${rn} status=${res.status} bytes=${responseBytes} parts=${Object.keys(partCounts).length} hasMedia=${saw.media} backoff=${trafficRes.policy?.backoffTimeMs} cookieLen=${trafficRes.policy?.cookieLen}`
    )

    const mediaAdvanced = this.mediaProgressGeneration > responseStartGeneration

    if (mediaAdvanced) {
      this.cachedBufferedRanges = null
      this.noMediaStreak = 0
    } else if (trafficRes.policy && trafficRes.policy.backoffTimeMs > 0) {
      this.noMediaStreak++
      this.cachedBufferedRanges = null

      if (this.noMediaStreak >= 12) {
        logger(
          'warn',
          'SABR',
          `Stall detected (noMediaStreak=${this.noMediaStreak}). Signaling for re-resolution.`
        )
        this.queueRecovery('starvation')
        this.noMediaStreak = 0
      }
    }

    const responseError = this.pendingResponseError
    this.pendingResponseError = null
    const responseErrorType = (
      responseError as (Error & { type?: string }) | null
    )?.type
    if (
      responseError &&
      this.usingTransferredSession &&
      responseErrorType === 'sabr.media_serving_enforcement_id_error'
    ) {
      logger(
        'warn',
        'SABR',
        'Transferred session was rejected by media enforcement. Requesting a fresh session.'
      )
      this.queueRecovery('session')
    }
    this.flushPendingRecovery()
    if (responseError && !this.recoveryPending) throw responseError
  }
}
