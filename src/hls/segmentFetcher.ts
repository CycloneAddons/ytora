import crypto from 'node:crypto'
import type { Readable, TransformCallback } from 'node:stream'
import { Transform } from 'node:stream'
import { http1makeRequest } from '../network/httpClient.ts'
import type {
  FetchSegmentOptions,
  HLSSegment,
  HLSSegmentKey,
  HLSSegmentMap,
  SegmentFetcherOptions
} from '../types/index.ts'
import { logger } from '../utils/logger.ts'

// ============================================================================
// HLS Segment Fetcher & AES Decryption
// ============================================================================

class DecryptTransform extends Transform {
  private readonly decipher: ReturnType<typeof crypto.createDecipheriv>

  constructor(algorithm: string, key: Buffer, iv: Buffer) {
    super()
    this.decipher = crypto.createDecipheriv(algorithm, key, iv)
    this.decipher.setAutoPadding(false)
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    try {
      this.push(this.decipher.update(chunk))
      callback()
    } catch (err) {
      callback(err as Error)
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      this.push(this.decipher.final())
      callback()
    } catch (err) {
      callback(err as Error)
    }
  }
}

export class SegmentFetcher {
  private readonly headers: Record<string, string>
  private readonly localAddress: string | null
  private readonly proxy: {
    url: string
    username?: string
    password?: string
  } | null
  private readonly onResolveUrl:
    | ((url: string) => Promise<string | null>)
    | null
  private readonly keyMap: Map<string, Buffer>

  constructor(options: SegmentFetcherOptions = {}) {
    this.headers = options.headers || {}
    this.localAddress = options.localAddress || null
    this.proxy = options.network?.proxy || options.proxy || null
    this.onResolveUrl = options.onResolveUrl || null
    this.keyMap = new Map()
  }

  async fetchKey(keyInfo: HLSSegmentKey | null): Promise<Buffer | null> {
    if (!keyInfo || keyInfo.method === 'NONE' || !keyInfo.uri) return null
    const cached = this.keyMap.get(keyInfo.uri)
    if (cached) return cached

    let url = keyInfo.uri
    if (this.onResolveUrl) {
      const resolved = await this.onResolveUrl(url)
      if (resolved) url = resolved
    }

    const { body, error, statusCode } = await http1makeRequest(url, {
      headers: this.headers,
      responseType: 'buffer',
      localAddress: this.localAddress ?? undefined,
      proxy: this.proxy ?? undefined
    })

    const bodyBuffer = body as Buffer | undefined
    if (error || statusCode !== 200 || !bodyBuffer || bodyBuffer.length === 0) {
      logger(
        'error',
        'SegmentFetcher',
        `Key fetch failed for ${keyInfo.uri}: Status ${statusCode}, Error: ${error || 'Empty Body'}`
      )
      throw new Error(`Key fetch failed: ${statusCode}`)
    }

    if (this.keyMap.size >= 20) {
      const firstKey = this.keyMap.keys().next().value
      if (firstKey) this.keyMap.delete(firstKey)
    }

    this.keyMap.set(keyInfo.uri, bodyBuffer)
    return bodyBuffer
  }

  async fetchMap(
    mapInfo: HLSSegmentMap | null,
    keyInfo: HLSSegmentKey | null = null
  ): Promise<Buffer | null> {
    if (!mapInfo?.uri) return null

    const headers: Record<string, string> & { Range?: string } = {
      ...this.headers
    }
    if (mapInfo.byteRange) {
      const end = mapInfo.byteRange.offset + mapInfo.byteRange.length - 1
      headers.Range = `bytes=${mapInfo.byteRange.offset}-${end}`
    }

    const { body, error, statusCode } = await http1makeRequest(mapInfo.uri, {
      headers,
      responseType: 'buffer',
      localAddress: this.localAddress ?? undefined,
      proxy: this.proxy ?? undefined
    })

    if (error || (statusCode !== 200 && statusCode !== 206)) {
      throw new Error(`Map fetch failed: ${statusCode}`)
    }

    const buffer = body as Buffer
    if (keyInfo?.iv && buffer.length % 16 === 0) {
      const keyData = await this.fetchKey(keyInfo)
      if (keyData) {
        const algorithm =
          keyInfo.method === 'AES-128' ? 'aes-128-cbc' : 'aes-256-cbc'
        const decipher = crypto.createDecipheriv(algorithm, keyData, keyInfo.iv)
        decipher.setAutoPadding(false)
        return Buffer.concat([decipher.update(buffer), decipher.final()])
      }
    }

    return buffer
  }

  async fetchSegment(
    segment: HLSSegment,
    options: FetchSegmentOptions = { stream: true }
  ): Promise<Buffer | Readable | null> {
    let url = segment.url
    if (this.onResolveUrl) {
      const resolved = await this.onResolveUrl(url)
      if (resolved) url = resolved
    }

    const headers: Record<string, string> & { Range?: string } = {
      ...this.headers
    }
    if (segment.byteRange) {
      const end = segment.byteRange.offset + segment.byteRange.length - 1
      headers.Range = `bytes=${segment.byteRange.offset}-${end}`
    }

    const { body, stream, error, statusCode } = await http1makeRequest(url, {
      headers,
      responseType: options.stream ? undefined : 'buffer',
      streamOnly: options.stream,
      localAddress: this.localAddress ?? undefined,
      proxy: this.proxy ?? undefined,
      timeout: 15000
    })

    if (error || (statusCode !== 200 && statusCode !== 206)) {
      if (statusCode === 403) {
        logger(
          'warn',
          'SegmentFetcher',
          `Segment 403 Forbidden: ${url.substring(0, 100)}...`
        )
      }
      throw new Error(`Segment failed: ${statusCode}`)
    }

    if (segment.key && segment.key.method !== 'NONE') {
      const keyData = await this.fetchKey(segment.key)
      if (!keyData) throw new Error('Failed to fetch decryption key')

      const iv = segment.key.iv || this._getIv(segment.sequence)
      const algorithm =
        segment.key.method === 'AES-128' ? 'aes-128-cbc' : 'aes-256-cbc'

      logger(
        'debug',
        'SegmentFetcher',
        `Decrypting segment ${segment.sequence} (Key: OK, IV: ${iv.toString('hex')})`
      )

      if (options.stream && stream) {
        return (stream as Readable).pipe(
          new DecryptTransform(algorithm, keyData, iv)
        )
      }

      const decipher = crypto.createDecipheriv(algorithm, keyData, iv)
      decipher.setAutoPadding(false)
      const buffer = body as Buffer
      return Buffer.concat([decipher.update(buffer), decipher.final()])
    }

    return options.stream
      ? (stream as Readable) || null
      : (body as Buffer) || null
  }

  private _getIv(sequence: number): Buffer {
    const iv = Buffer.alloc(16)
    iv.writeBigUInt64BE(BigInt(sequence), 8)
    return iv
  }
}

