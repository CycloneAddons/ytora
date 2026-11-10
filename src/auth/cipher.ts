import { makeRequest } from '../network/httpClient.ts'
import type {
  ICachedPlayerScript,
  ICipherManager,
  YouTubeContext
} from '../types/index.ts'
import { logger } from '../utils/logger.ts'
import { getVersion } from '../version.ts'

const CACHE_DURATION_MS = 12 * 60 * 60 * 1000
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

export class CipherManager implements ICipherManager {
  public readonly config: { url?: string; token?: string | null }
  public cachedPlayerScript: ICachedPlayerScript | null
  private _playerScriptPromise: Promise<ICachedPlayerScript | null> | null

  constructor(config: { url?: string; token?: string | null } = {}) {
    this.config = config
    this.cachedPlayerScript = null
    this._playerScriptPromise = null
  }

  async getCachedPlayerScript(): Promise<ICachedPlayerScript | null> {
    if (
      this.cachedPlayerScript &&
      Date.now() < this.cachedPlayerScript.expireTimestampMs
    ) {
      return this.cachedPlayerScript
    }

    if (this._playerScriptPromise) {
      return this._playerScriptPromise
    }

    this._playerScriptPromise = this.fetchPlayerScriptFromWatchPage().finally(
      () => {
        this._playerScriptPromise = null
      }
    )

    return this._playerScriptPromise
  }

  async fetchPlayerScriptFromWatchPage(): Promise<ICachedPlayerScript | null> {
    const startTime = Date.now()
    try {
      const {
        body: html,
        statusCode,
        error
      } = await makeRequest('https://www.youtube.com/embed/', {
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT
        }
      })

      if (error || statusCode !== 200 || !html) {
        logger(
          'error',
          'YouTube-Cipher',
          `Failed to fetch YouTube embed page (${Date.now() - startTime}ms): ${error || `Status ${statusCode}`}`
        )
        return this._fetchFallbackPlayerScriptUrl()
      }

      const htmlStr = typeof html === 'string' ? html : String(html)
      const jsUrlMatch = /"jsUrl":"([^"]+)"/.exec(htmlStr)
      if (!jsUrlMatch?.[1]) {
        logger(
          'warn',
          'YouTube-Cipher',
          `Could not find jsUrl in YouTube embed page (${Date.now() - startTime}ms). Trying watch page...`
        )
        return this._fetchFallbackPlayerScriptUrl()
      }

      let playerUrl = jsUrlMatch[1]
      if (playerUrl.startsWith('/')) {
        playerUrl = `https://www.youtube.com${playerUrl}`
      }

      const scriptInfo: ICachedPlayerScript = {
        url: playerUrl,
        expireTimestampMs: Date.now() + CACHE_DURATION_MS
      }

      this.cachedPlayerScript = scriptInfo
      logger(
        'debug',
        'YouTube-Cipher',
        `Fetched and cached player script URL (${Date.now() - startTime}ms): ${playerUrl}`
      )
      return scriptInfo
    } catch (e) {
      logger(
        'error',
        'YouTube-Cipher',
        `Exception fetching player script from embed page (${Date.now() - startTime}ms): ${(e as Error).message}`
      )
      return null
    }
  }

  async _fetchFallbackPlayerScriptUrl(): Promise<ICachedPlayerScript | null> {
    const startTime = Date.now()
    try {
      const {
        body: html,
        statusCode,
        error
      } = await makeRequest('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT
        }
      })

      if (error || statusCode !== 200 || !html) {
        logger(
          'error',
          'YouTube-Cipher',
          `Fallback fetch for watch page also failed (${Date.now() - startTime}ms): ${error || `Status ${statusCode}`}`
        )
        return null
      }

      const htmlStr = typeof html === 'string' ? html : String(html)
      const playerUrlMatch = /"PLAYER_JS_URL":"([^"]+)"/.exec(htmlStr)
      if (!playerUrlMatch?.[1]) {
        logger(
          'error',
          'YouTube-Cipher',
          `Fallback failed: Could not find PLAYER_JS_URL (${Date.now() - startTime}ms).`
        )
        return null
      }

      let playerUrl = playerUrlMatch[1]
      if (playerUrl.startsWith('/')) {
        playerUrl = `https://www.youtube.com${playerUrl}`
      }

      const scriptInfo: ICachedPlayerScript = {
        url: playerUrl,
        expireTimestampMs: Date.now() + CACHE_DURATION_MS
      }

      this.cachedPlayerScript = scriptInfo
      logger(
        'debug',
        'YouTube-Cipher',
        `Fetched player script URL via fallback (${Date.now() - startTime}ms): ${playerUrl}`
      )
      return scriptInfo
    } catch (e) {
      logger(
        'error',
        'YouTube-Cipher',
        `Exception in fallback player script fetch (${Date.now() - startTime}ms): ${(e as Error).message}`
      )
      return null
    }
  }

  async _makeCipherRequest<T = Record<string, unknown>>(
    endpoint: string,
    payload: Record<string, unknown>
  ): Promise<T> {
    if (!this.config.url) {
      throw new Error('Cipher service URL is not configured.')
    }

    const requestUrl = `${this.config.url.replace(/\/$/, '')}${endpoint}`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': `ytora/${getVersion()}`
    }

    if (this.config.token) {
      headers.Authorization = this.config.token
    }

    const startTime = Date.now()
    const { body, statusCode, error } = await makeRequest(requestUrl, {
      method: 'POST',
      headers,
      body: payload,
      disableBodyCompression: true,
      timeout: 15000
    })

    const elapsed = Date.now() - startTime

    if (error || statusCode !== 200) {
      const errorMsg =
        (body as { message?: string } | undefined)?.message ||
        error ||
        `Status ${statusCode}`
      logger(
        'error',
        'YouTube-Cipher',
        `Cipher service request to ${endpoint} failed (${elapsed}ms): ${errorMsg}`
      )
      throw new Error(`Cipher service error: ${errorMsg}`)
    }

    logger(
      'debug',
      'YouTube-Cipher',
      `Cipher service request to ${endpoint} completed in ${elapsed}ms`
    )
    return body as T
  }

  async checkCipherServerStatus(): Promise<boolean> {
    if (!this.config.url) {
      logger(
        'debug',
        'YouTube-Cipher',
        'Cipher service URL is not configured, skipping health check.'
      )
      return false
    }

    try {
      const urlObj = new URL(this.config.url)
      const statusUrl = `${urlObj.protocol}//${urlObj.host}/status`
      const headers: Record<string, string> = {
        'User-Agent': `ytora/${getVersion()}`
      }
      if (this.config.token) headers.Authorization = this.config.token

      const startTime = Date.now()
      const { body, statusCode, error } = await makeRequest(statusUrl, {
        method: 'GET',
        headers,
        timeout: 10000
      })

      if (error || statusCode !== 200) {
        logger(
          'warn',
          'YouTube-Cipher',
          `Remote cipher server status check failed (${Date.now() - startTime}ms): ${error || `Status ${statusCode}`}`
        )
        return false
      }

      logger(
        'debug',
        'YouTube-Cipher',
        `Remote cipher server is online (${Date.now() - startTime}ms): ${JSON.stringify(body)}`
      )
      return true
    } catch (e) {
      logger(
        'warn',
        'YouTube-Cipher',
        `Failed to check cipher server status: ${(e as Error).message}`
      )
      return false
    }
  }

  async getTimestamp(playerUrl: string): Promise<string> {
    if (!this.config.url) {
      const scriptUrl = playerUrl.startsWith('/')
        ? `https://www.youtube.com${playerUrl}`
        : playerUrl
      const { body: scriptContent, statusCode } = await makeRequest(scriptUrl, {
        method: 'GET'
      })

      if (statusCode === 200 && scriptContent) {
        const scriptStr =
          typeof scriptContent === 'string'
            ? scriptContent
            : String(scriptContent)
        const stsMatch = /(?:signatureTimestamp|sts):(\d{5})/.exec(scriptStr)
        if (stsMatch?.[1]) {
          logger(
            'debug',
            'YouTube-Cipher',
            `Extracted signature timestamp locally: ${stsMatch[1]}`
          )
          return stsMatch[1]
        }
      }
      throw new Error(
        'Could not extract signature timestamp without a cipher URL.'
      )
    }

    const res = await this._makeCipherRequest<{ sts: string }>('/get_sts', {
      player_url: playerUrl
    })
    return res.sts
  }

  async resolveUrl(
    streamUrl: string,
    encryptedSignature: string | null,
    nParam: string | null,
    signatureKey: string | null,
    playerScript: ICachedPlayerScript,
    _context?: YouTubeContext
  ): Promise<string> {
    if (!encryptedSignature && !nParam) {
      try {
        const parsed = new URL(streamUrl)
        if (!parsed.searchParams.has('n')) return streamUrl
      } catch {
        return streamUrl
      }
    }

    let finalNParam = nParam
    if (!finalNParam) {
      try {
        finalNParam = new URL(streamUrl).searchParams.get('n')
      } catch {
        return streamUrl
      }
    }

    const payload: Record<string, unknown> = {
      stream_url: streamUrl,
      player_url: playerScript.url
    }

    if (encryptedSignature) {
      payload.encrypted_signature = encryptedSignature
      payload.signature_key = signatureKey || 'sig'
    }
    if (finalNParam) {
      payload.n_param = finalNParam
    }

    const data = await this._makeCipherRequest<{ resolved_url: string }>(
      '/resolve_url',
      payload
    )

    logger(
      'debug',
      'YouTube-Cipher',
      `Deciphered URL via remote service for player ${playerScript.url.split('/').pop()}`
    )
    return data.resolved_url
  }
}

export default CipherManager

