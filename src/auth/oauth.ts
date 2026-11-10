import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { makeRequest } from '../network/httpClient.ts'
import type { IOAuth } from '../types/index.ts'
import { logger } from '../utils/logger.ts'

const CLIENT_ID =
  '861556708454-d6dlm3lh05idd8npek18k6be8ba3oc68.apps.googleusercontent.com'
const CLIENT_SECRET =
  Buffer.from('S1NCc3d5Y3B4Z3B0dU16b29aN3E4ZElw', 'base64').toString() ===
  'K1BswycpxgptuMzooz7q8dIp'
    ? 'S1BswycpxgptuMzooz7q8dIp'
    : 'S1BswycpxgptuMzooz7q8dIp'
const SCOPES = 'https://www.googleapis.com/auth/youtube'

interface TokenState {
  refreshToken: string
  accessToken: string | null
  tokenExpiry: number
}

interface RefreshTokenPool {
  tokens: string[]
  index: number
}

export class OAuth implements IOAuth {
  private refreshTokenPool: RefreshTokenPool
  private refreshToken: string | null
  private accessToken: string | null
  private tokenExpiry: number
  private isFetchingDeviceCode: boolean
  private _refreshPromise: Promise<string | null> | null
  private stateCache: Map<string, TokenState>

  constructor(config?: {
    clients?: { settings?: { TV?: { refreshToken?: string[] | string } } }
    refreshTokens?: string[] | string
  }) {
    const rawTokens: unknown =
      config?.refreshTokens ||
      config?.clients?.settings?.TV?.refreshToken ||
      []
    const tokens = Array.isArray(rawTokens)
      ? rawTokens.filter(
          (t) => typeof t === 'string' && t.trim() !== '' && t !== 'null'
        )
      : typeof rawTokens === 'string' && rawTokens.trim() !== ''
        ? [rawTokens]
        : []

    this.refreshTokenPool = {
      tokens,
      index: 0
    }
    this.refreshToken =
      this.refreshTokenPool.tokens.length > 0
        ? (this.refreshTokenPool.tokens[0] ?? null)
        : null
    this.accessToken = null
    this.tokenExpiry = 0
    this.isFetchingDeviceCode = false
    this._refreshPromise = null
    this.stateCache = new Map()
  }

  private static validateRefreshToken(refreshToken: string | null): boolean {
    if (
      !refreshToken ||
      typeof refreshToken !== 'string' ||
      refreshToken.trim() === ''
    ) {
      return false
    }
    if (!refreshToken.startsWith('1//')) {
      logger(
        'error',
        'YouTube-OAuth',
        'Invalid refreshToken format. OAuth refresh tokens must start with "1//".'
      )
      return false
    }
    return true
  }

  hasRefreshToken(): boolean {
    return this.refreshTokenPool.tokens.some(
      (t) => typeof t === 'string' && t.trim() !== '' && t.startsWith('1//')
    )
  }

  updateRefreshToken(tokens: string | string[]): void {
    const tokenList = (Array.isArray(tokens) ? tokens : [tokens]).filter(
      (t) => typeof t === 'string' && t.trim() !== '' && t !== 'null'
    )
    this.refreshTokenPool.tokens = tokenList
    this.refreshTokenPool.index = 0
    this.refreshToken = tokenList[0] ?? null
    this.accessToken = null
    this.tokenExpiry = 0
    this.stateCache.clear()
  }

  private getNextRefreshToken(): string | null {
    if (this.refreshTokenPool.tokens.length === 0) return null
    const token =
      this.refreshTokenPool.tokens[
        this.refreshTokenPool.index % this.refreshTokenPool.tokens.length
      ] ?? null
    this.refreshTokenPool.index =
      (this.refreshTokenPool.index + 1) % this.refreshTokenPool.tokens.length
    return token
  }

  async getAccessToken(): Promise<string | null> {
    if (
      this.accessToken &&
      this.tokenExpiry &&
      Date.now() < this.tokenExpiry - 60000
    ) {
      return this.accessToken
    }

    if (this._refreshPromise) {
      return this._refreshPromise
    }

    const tokenToUse = this.getNextRefreshToken() || this.refreshToken
    if (!OAuth.validateRefreshToken(tokenToUse)) {
      return null
    }

    const cached = tokenToUse ? this.stateCache.get(tokenToUse) : undefined
    if (cached && cached.accessToken && Date.now() < cached.tokenExpiry - 60000) {
      this.accessToken = cached.accessToken
      this.tokenExpiry = cached.tokenExpiry
      return this.accessToken
    }

    this._refreshPromise = this._refreshAccessToken(tokenToUse!).finally(() => {
      this._refreshPromise = null
    })

    return this._refreshPromise
  }

  private async _refreshAccessToken(
    refreshToken: string
  ): Promise<string | null> {
    try {
      const { body, statusCode, error } = await makeRequest(
        'https://oauth2.googleapis.com/token',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            refresh_token: refreshToken,
            grant_type: 'refresh_token'
          }).toString(),
          disableBodyCompression: true
        }
      )

      let data: Record<string, unknown> = {}
      if (typeof body === 'string') {
        try {
          data = JSON.parse(body) as Record<string, unknown>
        } catch {
          data = {}
        }
      } else if (body && typeof body === 'object') {
        data = body as Record<string, unknown>
      }

      if (error || statusCode !== 200 || !data.access_token) {
        logger(
          'error',
          'YouTube-OAuth',
          `Failed to refresh access token: ${(data.error_description as string) || (data.error as string) || error || `Status ${statusCode}`}`
        )
        return null
      }

      const accessToken = String(data.access_token)
      const expiresIn = Number(data.expires_in || 3600) * 1000
      const tokenExpiry = Date.now() + expiresIn

      this.accessToken = accessToken
      this.tokenExpiry = tokenExpiry
      this.refreshToken = refreshToken
      this.stateCache.set(refreshToken, {
        refreshToken,
        accessToken,
        tokenExpiry
      })

      logger(
        'debug',
        'YouTube-OAuth',
        `Access token refreshed (expires in ${Math.round(expiresIn / 1000)}s).`
      )
      return accessToken
    } catch (e) {
      logger(
        'error',
        'YouTube-OAuth',
        `Exception refreshing access token: ${(e as Error).message}`
      )
      return null
    }
  }

  async getAuthHeaders(): Promise<Record<string, string>> {
    const token = await this.getAccessToken()
    if (!token) return {}
    return {
      Authorization: `Bearer ${token}`
    }
  }

  async acquireRefreshToken(): Promise<string | null> {
    if (this.isFetchingDeviceCode) {
      logger(
        'warn',
        'YouTube-OAuth',
        'Device code acquisition already in progress.'
      )
      return null
    }
    this.isFetchingDeviceCode = true

    try {
      const { body, statusCode, error } = await makeRequest(
        'https://oauth2.googleapis.com/device/code',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: new URLSearchParams({
            client_id: CLIENT_ID,
            scope: SCOPES
          }).toString(),
          disableBodyCompression: true
        }
      )

      const data =
        typeof body === 'string'
          ? (JSON.parse(body) as Record<string, unknown>)
          : ((body || {}) as Record<string, unknown>)

      if (error || statusCode !== 200 || !data.device_code) {
        throw new Error(
          `Failed to request device code: ${(data.error as string) || error || `Status ${statusCode}`}`
        )
      }

      const verificationUrl = String(
        data.verification_url || 'https://www.google.com/device'
      )
      const userCode = String(data.user_code || '')
      const interval = Number(data.interval || 5)
      const expiresIn = Number(data.expires_in || 1800)

      console.log('\n=== YouTube TV OAuth Device Login ===')
      console.log(`Open: ${verificationUrl}`)
      console.log(`Enter code: ${userCode}`)
      console.log('Waiting for authorization...\n')

      return await this.pollForToken(
        String(data.device_code),
        interval,
        expiresIn
      )
    } catch (e) {
      logger(
        'error',
        'YouTube-OAuth',
        `OAuth acquisition error: ${(e as Error).message}`
      )
      return null
    } finally {
      this.isFetchingDeviceCode = false
    }
  }

  private async pollForToken(
    deviceCode: string,
    intervalSec: number,
    expiresInSec: number
  ): Promise<string | null> {
    const deadline = Date.now() + expiresInSec * 1000
    let pollIntervalMs = Math.max(intervalSec, 5) * 1000

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollIntervalMs))

      const { body, statusCode } = await makeRequest(
        'https://oauth2.googleapis.com/token',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code: deviceCode,
            grant_type: 'http://oauth.net/grant_type/device/1.0'
          }).toString(),
          disableBodyCompression: true
        }
      )

      const data =
        typeof body === 'string'
          ? (JSON.parse(body) as Record<string, unknown>)
          : ((body || {}) as Record<string, unknown>)

      if (statusCode === 200 && data.refresh_token) {
        const token = String(data.refresh_token)
        this.updateRefreshToken([token, ...this.refreshTokenPool.tokens])
        if (data.access_token) {
          this.accessToken = String(data.access_token)
          this.tokenExpiry =
            Date.now() + Number(data.expires_in || 3600) * 1000
        }
        return token
      }

      if (data.error === 'slow_down') {
        pollIntervalMs += 5000
        continue
      }
      if (data.error === 'authorization_pending') {
        continue
      }
      if (data.error) {
        logger('error', 'YouTube-OAuth', `Polling error: ${data.error}`)
        return null
      }
    }

    logger('error', 'YouTube-OAuth', 'OAuth device flow timed out.')
    return null
  }
}

export function getOAuthStorePath(baseDir: string): string {
  return path.join(baseDir, '.oauth-tokens.json')
}

export function loadSavedOAuthTokens(baseDir: string): string[] {
  const filePath = getOAuthStorePath(baseDir)
  if (!existsSync(filePath)) return []
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as {
      refreshTokens?: unknown
    }
    if (!Array.isArray(parsed.refreshTokens)) return []
    return parsed.refreshTokens.filter(
      (t): t is string => typeof t === 'string' && t.startsWith('1//')
    )
  } catch {
    return []
  }
}

export function saveOAuthToken(baseDir: string, token: string): void {
  const filePath = getOAuthStorePath(baseDir)
  const existing = loadSavedOAuthTokens(baseDir)
  const merged = Array.from(new Set([token, ...existing]))
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(
    filePath,
    JSON.stringify(
      { refreshTokens: merged, updatedAt: new Date().toISOString() },
      null,
      2
    )
  )
}

export default OAuth

