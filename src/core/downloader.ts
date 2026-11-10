import { existsSync, rmSync } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { PassThrough, type Readable } from 'node:stream'
import CipherManager from '../auth/cipher.ts'
import OAuth, { loadSavedOAuthTokens, saveOAuthToken } from '../auth/oauth.ts'
import {
  Android,
  AndroidVR,
  BaseClient,
  type ClientRuntime,
  IOS,
  type MediaExtractionResult,
  Music,
  type ResolvedStreamComponent,
  TV,
  TVCast,
  TVEmbedded,
  TV_DOWN,
  VisionOs,
  Web,
  WebEmbedded,
  WebParentTools,
  WebRemix,
  YOUTUBE_WEBM_ITAGS,
  checkURLType,
  extractPlaylistSelection,
  parsePlaylistMeta,
  parseQualityHeight,
  selectVideoCandidates,
  summarizeFormat,
  type YouTubePlaylistMeta
} from '../clients/index.ts'
import { HLSHandler } from '../hls/hlsHandler.ts'
import { cleanupHttpAgents, http1makeRequest, makeRequest } from '../network/httpClient.ts'
import { YouTubeProxyManager } from '../network/proxyManager.ts'
import { poTokenManager } from '../potoken/poTokenManager.ts'
import { SabrStream } from '../sabr/sabrStream.ts'
import {
  YOUTUBE_CONSTANTS,
  type CancelSignal,
  type DownloadMode,
  type DownloadOptions,
  type DownloadProgressEvent,
  type DownloadedItemResult,
  type DownloaderConfig,
  type FfmpegInfo,
  type FormatEntry,
  type FormatInventoryResult,
  type FormatSummary,
  type HttpProxyConfig,
  type HttpRequestResult,
  type PlaylistData,
  type ProxySnapshot,
  type SabrStreamConfig,
  type SourceResult,
  type StreamResult,
  type StreamSelectionSpec,
  type TrackData,
  type TrackEncodeInput,
  type TrackInfo,
  type TrackUrlAdditionalData,
  type YouTubeContext
} from '../types/index.ts'
import { detectFfmpegBinary, muxVideoAndAudio, remuxToMp4 } from '../utils/ffmpeg.ts'
import { capTotalTracks, encodeTrack, resolveFilenameTemplate } from '../utils/format.ts'
import { logger } from '../utils/logger.ts'
import { resolveDefaultLogDir, resolveDefaultOAuthDir } from '../utils/paths.ts'
import {
  CHUNK_SIZE,
  DEFAULT_CIPHER_URL,
  DEFAULT_PLAYBACK_CLIENTS,
  DEFAULT_RESOLVE_CLIENTS,
  DEFAULT_SEARCH_CLIENTS,
  MAX_RETRIES,
  MAX_RETRY_DELAY_MS,
  MAX_URL_REFRESH,
  RECOVER_BASE_DELAY_MS,
  STREAM_BUFFER_SIZE,
  URL_CACHE_TTL_MS,
  URL_MAX_AGE_MS,
  VISITOR_DATA_INTERVAL,
  WEBM_CLUSTER_MAGIC,
  WEBM_SEEK_PROBE_WINDOWS
} from './constants.ts'
import {
  type CachedMediaEntry,
  type ResolvedMediaPlan,
  buildSelectionCacheKey,
  isMp4Container,
  pickAudioExtension,
  pipeStreamToFile,
  resolveSabrFormatContainer,
  selectSabrAudioCandidate
} from './mediaHelpers.ts'

export {
  DEFAULT_CIPHER_URL,
  DEFAULT_PLAYBACK_CLIENTS,
  DEFAULT_RESOLVE_CLIENTS,
  DEFAULT_SEARCH_CLIENTS,
  type FfmpegInfo,
  type ResolvedMediaPlan
}

export class YouTubeDownloader implements ClientRuntime {
  public readonly baseDir: string
  public readonly logDir: string
  public readonly options: ClientRuntime['options']
  public readonly config: {
    hl: string
    gl: string
    clients: {
      search: string[]
      playback: string[]
      resolve: string[]
    }
    cipherUrl: string
    cipherToken: string | null
    debugLogs: boolean
  }

  private readonly proxyManager: YouTubeProxyManager
  public readonly clients: Record<string, BaseClient>
  public oauth: OAuth | null
  public readonly cipherManager: CipherManager
  private readonly activeStreams: Map<string | symbol, CancelSignal>
  private readonly activeSabrStreams: Map<
    string | symbol,
    { sabr: SabrStream; stream: PassThrough }
  >
  private readonly failingClientsByTrack: Map<string, Set<string>>
  private readonly mediaCache: Map<string, CachedMediaEntry>
  private readonly activeTempFiles: Set<string>
  private visitorDataInterval: ReturnType<typeof setInterval> | null
  private failingClientsInterval: ReturnType<typeof setInterval> | null
  private bandwidthEstimate: number
  private setupDone: boolean
  public readonly ytContext: YouTubeContext
  private readonly initialRefreshTokens: string[]

  constructor(config: DownloaderConfig = {}, baseDir?: string) {
    const explicitBaseDir =
      typeof baseDir === 'string' && baseDir.trim().length > 0
        ? path.resolve(baseDir)
        : undefined
    this.baseDir = explicitBaseDir ?? resolveDefaultOAuthDir()
    this.logDir =
      config.logDir && config.logDir.trim().length > 0
        ? path.resolve(config.logDir)
        : explicitBaseDir ?? resolveDefaultLogDir()
    const savedTokens = loadSavedOAuthTokens(this.baseDir)
    const cliTokens = (config.refreshTokens ?? []).filter(
      (t) => typeof t === 'string' && t.trim() !== ''
    )
    this.initialRefreshTokens = Array.from(new Set([...cliTokens, ...savedTokens]))

    this.config = {
      hl: config.hl || 'en',
      gl: config.gl || 'US',
      clients: {
        search: config.clients?.search?.length
          ? [...config.clients.search]
          : [...DEFAULT_SEARCH_CLIENTS],
        playback: config.clients?.playback?.length
          ? [...config.clients.playback]
          : [...DEFAULT_PLAYBACK_CLIENTS],
        resolve: config.clients?.resolve?.length
          ? [...config.clients.resolve]
          : [...DEFAULT_RESOLVE_CLIENTS]
      },
      cipherUrl: config.cipherUrl || DEFAULT_CIPHER_URL,
      cipherToken: config.cipherToken ?? null,
      debugLogs: Boolean(config.debugLogs)
    }

    this.options = {
      audioQuality: 'high',
      maxPlaylistLength: 100,
      targetItag: undefined,
      allowItag: []
    }

    this.proxyManager = new YouTubeProxyManager(config.proxies || [])
    this.clients = {}
    this.oauth = null
    this.cipherManager = new CipherManager({
      url: this.config.cipherUrl,
      token: this.config.cipherToken
    })
    this.activeStreams = new Map()
    this.activeSabrStreams = new Map()
    this.failingClientsByTrack = new Map()
    this.mediaCache = new Map()
    this.activeTempFiles = new Set()
    this.visitorDataInterval = null
    this.failingClientsInterval = null
    this.bandwidthEstimate = 128_000
    this.setupDone = false

    this.ytContext = {
      client: {
        screenDensityFloat: 1,
        screenHeightPoints: 1080,
        screenPixelDensity: 1,
        screenWidthPoints: 1920,
        hl: this.config.hl,
        gl: this.config.gl,
        visitorData: null
      }
    }

    poTokenManager.setDebugLogs(this.config.debugLogs)
    poTokenManager.setLogDir(this.logDir)
  }

  public getProxy(_rotate = true): ProxySnapshot | undefined {
    return this.proxyManager.getBestProxy()
  }

  public reportProxyStatus(
    proxy: ProxySnapshot | HttpProxyConfig | undefined,
    success: boolean,
    status: number,
    latency = 0
  ): void {
    const url = proxy?.url
    if (url) {
      this.proxyManager.report(url, success, status, latency)
    }
  }

  public getClient(name: string): BaseClient | undefined {
    if (this.clients[name]) return this.clients[name]
    const targetLower = name.toLowerCase()
    for (const [k, client] of Object.entries(this.clients)) {
      if (k.toLowerCase() === targetLower || client.name.toLowerCase() === targetLower) {
        return client
      }
    }
    return undefined
  }

  private resolveConfiguredClientKey(name: string): string | undefined {
    if (this.clients[name]) return name
    const lower = name.toLowerCase()
    for (const key of Object.keys(this.clients)) {
      if (key.toLowerCase() === lower) return key
    }
    return undefined
  }

  public async setup(): Promise<boolean> {
    if (this.setupDone) return true
    logger('debug', 'YouTube', 'Setting up YouTube downloader...')

    this.oauth = new OAuth({
      refreshTokens: this.initialRefreshTokens
    })

    const clientMap: Record<
      string,
      new (runtime: ClientRuntime, oauth: OAuth | null) => BaseClient
    > = {
      Android,
      AndroidVR,
      IOS,
      Music,
      WebRemix,
      TV,
      TV_DOWN,
      TVCast,
      TVEmbedded,
      Web,
      WebEmbedded,
      WebParentTools,
      VisionOs
    }

    for (const [key, Ctor] of Object.entries(clientMap)) {
      this.clients[key] = new Ctor(this, this.oauth)
    }

    await this._fetchVisitorData()
    await this._loadPlayerScriptWithRetry()

    if (this.visitorDataInterval) clearInterval(this.visitorDataInterval)
    this.visitorDataInterval = setInterval(
      () => void this._fetchVisitorData(),
      VISITOR_DATA_INTERVAL
    )
    this.visitorDataInterval.unref?.()

    if (this.failingClientsInterval) clearInterval(this.failingClientsInterval)
    this.failingClientsInterval = setInterval(
      () => this.failingClientsByTrack.clear(),
      1000 * 60 * 60 * 12
    )
    this.failingClientsInterval.unref?.()

    this.setupDone = true
    logger('debug', 'YouTube', 'YouTube downloader setup complete.')
    return true
  }

  private async _loadPlayerScriptWithRetry(): Promise<void> {
    const maxAttempts = 3
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.cipherManager.getCachedPlayerScript()
        return
      } catch (e) {
        logger(
          'warn',
          'YouTube',
          `Player script load failed (attempt ${attempt}/${maxAttempts}): ${(e as Error).message}`
        )
        if (attempt === maxAttempts) {
          logger(
            'warn',
            'YouTube',
            'Continuing without a cached player script; it will be fetched lazily.'
          )
          return
        }
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 1000 * attempt)
          t.unref?.()
        })
      }
    }
  }

  private async _fetchVisitorData(): Promise<void> {
    const proxy = this.getProxy()

    try {
      const { body, error, statusCode } = await http1makeRequest(
        'https://music.youtube.com/sw.js_data',
        {
          method: 'GET',
          responseType: 'buffer',
          disableBodyCompression: true,
          proxy
        }
      )
      if (!error && statusCode === 200 && Buffer.isBuffer(body)) {
        const text = body.toString('utf-8')
        const json = text.slice(text.indexOf('\n') + 1)
        const data = JSON.parse(json) as Array<[string, unknown, unknown[]]>
        const visitorData = data.find(([name]) => name === 'yt.sw.adr')?.[2]?.[6]

        if (typeof visitorData === 'string' && visitorData) {
          this.ytContext.client.visitorData = visitorData
          logger('debug', 'YouTube', 'visitorData refreshed from sw.js_data.')
          return
        }
      }
    } catch (error) {
      logger(
        'debug',
        'YouTube',
        `sw.js_data endpoint failed: ${(error as Error).message}`
      )
    }

    try {
      const webCtx = this.clients.Web?.getClient(this.ytContext)
      const { body, error, statusCode } = await makeRequest(
        'https://www.youtube.com/youtubei/v1/guide',
        {
          method: 'POST',
          body: { context: webCtx },
          disableBodyCompression: true,
          proxy
        }
      )
      const visitorData = (
        body as { responseContext?: { visitorData?: string } } | undefined
      )?.responseContext?.visitorData
      if (!error && statusCode === 200 && typeof visitorData === 'string' && visitorData) {
        this.ytContext.client.visitorData = visitorData
        logger('debug', 'YouTube', 'visitorData refreshed via guide.')
      } else {
        logger('debug', 'YouTube', 'Failed to refresh visitorData via guide.')
      }
    } catch (error) {
      logger(
        'debug',
        'YouTube',
        `Error refreshing visitor data: ${(error as Error).message}`
      )
    }
  }

  public async acquireOAuthToken(): Promise<string | null> {
    if (!this.oauth) {
      this.oauth = new OAuth({ refreshTokens: this.initialRefreshTokens })
    }
    const token = await this.oauth.acquireRefreshToken()
    if (token) {
      saveOAuthToken(this.baseDir, token)
    }
    return token
  }

  public destroy(): void {
    for (const cancelSignal of this.activeStreams.values()) {
      cancelSignal.aborted = true
    }
    this.activeStreams.clear()

    for (const entry of this.activeSabrStreams.values()) {
      try {
        entry.stream.destroy()
      } catch {}
      try {
        entry.sabr.destroy()
      } catch {}
    }
    this.activeSabrStreams.clear()

    if (this.visitorDataInterval) {
      clearInterval(this.visitorDataInterval)
      this.visitorDataInterval = null
    }
    if (this.failingClientsInterval) {
      clearInterval(this.failingClientsInterval)
      this.failingClientsInterval = null
    }

    this.failingClientsByTrack.clear()
    this.mediaCache.clear()
    for (const tmp of this.activeTempFiles) {
      try {
        rmSync(tmp, { force: true })
      } catch {}
    }
    this.activeTempFiles.clear()
    poTokenManager.reset()
    cleanupHttpAgents()
  }

  private rejectOAuthClientWithoutToken(clientName: string): string | null {
    const client = this.getClient(clientName)
    if (client?.requiresOAuth() && !client.oauth?.hasRefreshToken()) {
      return (
        `Client ${clientName} requires a YouTube refresh token and none is ` +
        `configured (run with --oauth-login or pass --refresh-token). Skipping.`
      )
    }
    return null
  }

  public async search(
    query: string,
    type = 'ytsearch',
    searchType = 'track'
  ): Promise<SourceResult> {
    await this.setup()
    if (type === 'ytrec') {
      return await this.getRecommendations(query)
    }

    let clientList = this.config.clients.search
    if (type === 'ytmsearch') {
      clientList = ['WebRemix', 'Music']
    }

    const clientErrors: Array<{ client: string; message: string }> = []

    for (const clientName of clientList) {
      const client = this.getClient(clientName)
      if (!client) continue

      try {
        const searchProxy = clientName === 'Android' ? this.getProxy(true) : undefined
        const result = await client.search(
          query,
          searchType,
          this.ytContext,
          searchProxy,
          this.reportProxyStatus.bind(this)
        )

        if (result && result.loadType === 'search') {
          return result
        }

        const errorMessage =
          (result?.data as { message?: string } | undefined)?.message ||
          result?.exception?.message ||
          'Client returned empty or failed.'
        clientErrors.push({ client: clientName, message: errorMessage })
      } catch (e) {
        clientErrors.push({
          client: clientName,
          message: (e as Error).message
        })
      }
    }

    return {
      loadType: 'error',
      exception: {
        message: `No search results found (${clientErrors.map((e) => `${e.client}: ${e.message}`).join('; ')})`,
        severity: 'fault',
        cause: 'All clients failed.'
      }
    }
  }

  public async getRecommendations(query: string): Promise<SourceResult> {
    await this.setup()
    let videoId = query
    if (!/^[a-zA-Z0-9_-]{11}$/.test(query)) {
      const searchRes = await this.search(query, 'ytmsearch')
      if (
        searchRes.loadType !== 'search' ||
        !Array.isArray(searchRes.data) ||
        searchRes.data.length === 0
      ) {
        return { loadType: 'empty', data: {} }
      }
      const first = searchRes.data[0]
      if (!first) return { loadType: 'empty', data: {} }
      videoId = first.info.identifier
    }

    try {
      const automixId = `RD${videoId}`
      let automixRes: SourceResult | null = null

      const musicClient = this.getClient('WebRemix') ?? this.getClient('Music')
      if (musicClient) {
        try {
          automixRes = await musicClient.resolve(
            `https://music.youtube.com/playlist?list=${automixId}`,
            'ytmusic',
            this.ytContext,
            this.cipherManager
          )
        } catch {}
      }

      if (automixRes?.loadType !== 'playlist') {
        const tvClient = this.getClient('TV') ?? this.getClient('TVCast')
        if (tvClient) {
          try {
            automixRes = await tvClient.resolve(
              `https://www.youtube.com/playlist?list=${automixId}`,
              'youtube',
              this.ytContext,
              this.cipherManager
            )
          } catch {}
        }
      }

      if (automixRes && automixRes.loadType === 'playlist') {
        const plData = automixRes.data as PlaylistData
        if (plData.tracks.length > 0) {
          const tracks = plData.tracks.filter((t) => t.info.identifier !== videoId)
          return {
            loadType: 'playlist',
            data: {
              info: { name: 'YouTube Recommendations', selectedTrack: 0 },
              pluginInfo: { type: 'recommendations' },
              tracks
            }
          }
        }
      }

      return { loadType: 'empty', data: {} }
    } catch (e) {
      return {
        loadType: 'error',
        exception: { message: (e as Error).message, severity: 'fault' }
      }
    }
  }

  public async resolveInput(
    input: string,
    overrideClients?: string[]
  ): Promise<{ sourceResult: SourceResult; explicitWatchId: string | null }> {
    await this.setup()
    const trimmed = input.trim()

    if (trimmed.startsWith('ytsearch:')) {
      return {
        sourceResult: await this.search(trimmed.slice('ytsearch:'.length).trim(), 'ytsearch'),
        explicitWatchId: null
      }
    }
    if (trimmed.startsWith('ytmsearch:')) {
      return {
        sourceResult: await this.search(trimmed.slice('ytmsearch:'.length).trim(), 'ytmsearch'),
        explicitWatchId: null
      }
    }
    if (trimmed.startsWith('ytrec:')) {
      return {
        sourceResult: await this.getRecommendations(trimmed.slice('ytrec:'.length).trim()),
        explicitWatchId: null
      }
    }

    if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
      const watchUrl = `https://www.youtube.com/watch?v=${trimmed}`
      return {
        sourceResult: await this.resolve(watchUrl, undefined, overrideClients),
        explicitWatchId: trimmed
      }
    }

    if (/^https?:\/\//i.test(trimmed)) {
      const sel = extractPlaylistSelection(trimmed)
      return {
        sourceResult: await this.resolve(trimmed, undefined, overrideClients),
        explicitWatchId: sel.videoId
      }
    }

    // Fallback: treat plain text input as ytsearch query
    return {
      sourceResult: await this.search(trimmed, 'ytsearch'),
      explicitWatchId: null
    }
  }

  public async resolve(
    url: string,
    type?: string,
    overrideClients?: string[]
  ): Promise<SourceResult> {
    await this.setup()

    try {
      const parsedUrl = new URL(url)
      if (
        parsedUrl.hostname === 'music.youtube.com' &&
        parsedUrl.pathname === '/search'
      ) {
        const query =
          parsedUrl.searchParams.get('q') ||
          parsedUrl.searchParams.get('search_query')
        if (query) {
          return await this.search(query, 'ytmsearch')
        }
      }

      if (
        (parsedUrl.hostname === 'www.youtube.com' ||
          parsedUrl.hostname === 'youtube.com' ||
          parsedUrl.hostname === 'm.youtube.com') &&
        (parsedUrl.pathname === '/results' || parsedUrl.pathname === '/search')
      ) {
        const query =
          parsedUrl.searchParams.get('search_query') ||
          parsedUrl.searchParams.get('q')
        if (query) {
          return await this.search(query, 'ytsearch')
        }
      }

      if (
        (parsedUrl.hostname === 'music.youtube.com' ||
          parsedUrl.hostname === 'www.youtube.com' ||
          parsedUrl.hostname === 'youtube.com' ||
          parsedUrl.hostname === 'm.youtube.com') &&
        parsedUrl.pathname.startsWith('/browse/')
      ) {
        const browseId = parsedUrl.pathname.slice('/browse/'.length).split('/')[0]
        if (browseId) {
          if (browseId.startsWith('VL')) {
            const playlistId = browseId.slice(2)
            const targetUrl =
              parsedUrl.hostname === 'music.youtube.com'
                ? `https://music.youtube.com/playlist?list=${playlistId}`
                : `https://www.youtube.com/playlist?list=${playlistId}`
            return await this.resolve(targetUrl, type, overrideClients)
          }

          const isMusic = parsedUrl.hostname === 'music.youtube.com'
          const clientContext = isMusic
            ? (this.getClient('WebRemix')?.getClient(this.ytContext) ??
              this.getClient('Web')?.getClient(this.ytContext))
            : this.getClient('Web')?.getClient(this.ytContext)

          const endpoint = isMusic
            ? 'https://music.youtube.com/youtubei/v1/browse'
            : 'https://www.youtube.com/youtubei/v1/browse'

          const proxy = this.getProxy()
          const startedAt = Date.now()
          const { body, statusCode } = await makeRequest(endpoint, {
            method: 'POST',
            body: { context: clientContext, browseId },
            headers: {
              'User-Agent': clientContext?.client?.userAgent || '',
              'X-Goog-Api-Format-Version': '2'
            },
            disableBodyCompression: true,
            proxy
          })

          this.reportProxyStatus(proxy, statusCode === 200, statusCode ?? 0, Date.now() - startedAt)

          if (statusCode === 200 && body && typeof body === 'object') {
            const typedBody = body as Record<string, unknown>
            const microformat = typedBody.microformat as
              | { microformatDataRenderer?: { urlCanonical?: string } }
              | undefined
            const canonicalUrl = microformat?.microformatDataRenderer?.urlCanonical
            if (canonicalUrl && canonicalUrl !== url) {
              return await this.resolve(canonicalUrl, type, overrideClients)
            }

            const bodyStr = JSON.stringify(body)
            const playlistMatch = bodyStr.match(
              /"watchPlaylistEndpoint":\s*\{\s*"playlistId":\s*"([^"]+)"/
            )
            if (playlistMatch?.[1]) {
              const targetUrl = isMusic
                ? `https://music.youtube.com/playlist?list=${playlistMatch[1]}`
                : `https://www.youtube.com/playlist?list=${playlistMatch[1]}`
              return await this.resolve(targetUrl, type, overrideClients)
            }
          }

          return { loadType: 'empty', data: {} }
        }
      }
    } catch {
      // non-URL inputs continue below
    }

    const result = await this._resolveWorker(url, type, overrideClients)
    if (result.loadType === 'playlist' && result.data) {
      await this._applyPlaylistMeta(url, result.data as PlaylistData)
    }
    return result
  }

  private async _applyPlaylistMeta(
    url: string,
    playlist: PlaylistData
  ): Promise<void> {
    if (!playlist?.info) return
    const playlistId = url.match(/[?&]list=([\w-]+)/)?.[1]
    if (!playlistId) return

    const current = playlist.pluginInfo ?? {}
    const meta =
      current.author && current.artworkUrl
        ? { author: '', thumbnail: '' }
        : await this._fetchPlaylistMeta(playlistId)

    playlist.pluginInfo = {
      ...current,
      type: current.type ?? 'playlist',
      identifier: current.identifier ?? playlistId,
      url: current.url ?? `https://www.youtube.com/playlist?list=${playlistId}`,
      artworkUrl: current.artworkUrl || meta.thumbnail,
      author: current.author || meta.author,
      totalTracks: capTotalTracks(
        (current.totalTracks as number | undefined) ?? playlist.tracks.length,
        this.options.maxPlaylistLength
      )
    }
  }

  private async _fetchPlaylistMeta(playlistId: string): Promise<YouTubePlaylistMeta> {
    const empty: YouTubePlaylistMeta = { author: '', thumbnail: '' }
    const proxy = this.getProxy()
    const startedAt = Date.now()
    try {
      const { body, statusCode } = await makeRequest(
        `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}&hl=en`,
        {
          method: 'GET',
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
            Cookie: 'SOCS=CAI'
          },
          timeout: 5000,
          proxy
        }
      )
      this.reportProxyStatus(proxy, statusCode === 200, statusCode ?? 0, Date.now() - startedAt)
      if (statusCode !== 200 || typeof body !== 'string') return empty
      return parsePlaylistMeta(body)
    } catch {
      return empty
    }
  }

  private async _resolveWorker(
    url: string,
    type?: string,
    overrideClients?: string[]
  ): Promise<SourceResult> {
    const liveMatch = url.match(/^https?:\/\/(?:www\.)?youtube\.com\/live\/([\w-]+)/)
    if (liveMatch?.[1]) {
      url = `https://www.youtube.com/watch?v=${liveMatch[1]}`
      logger('debug', 'YouTube', `Normalized live URL to: ${url}`)
    }

    const isMusicUrl = url.includes('music.youtube.com')
    const sourceType = isMusicUrl ? 'ytmusic' : 'youtube'

    const clientList = overrideClients?.length
      ? overrideClients
      : this.config.clients.resolve || this.config.clients.playback

    const clientErrors: Array<{ client: string; message: string }> = []
    const urlType = checkURLType(url, sourceType)

    if (isMusicUrl) {
      const musicClients = ['WebRemix', 'Music']
      for (const clientName of musicClients) {
        const musicClient = this.getClient(clientName)
        if (!musicClient) continue

        try {
          const result = await musicClient.resolve(
            url,
            sourceType,
            this.ytContext,
            this.cipherManager
          )
          if (result && (result.loadType === 'track' || result.loadType === 'playlist')) {
            return result
          }

          if (
            result?.loadType === 'error' &&
            result.exception?.cause === 'UpstreamPlayability'
          ) {
            const listIdMatch = url.match(/[?&]list=([\w-]+)/)
            const videoIdMatch = url.match(/[?&]v=([\w-]+)/)
            const listId = listIdMatch?.[1] ?? null
            const videoId = videoIdMatch?.[1] ?? null
            const fallbackId = listId || videoId
            if (fallbackId) {
              let fallbackUrl: string
              if (listId) {
                fallbackUrl = `https://www.youtube.com/playlist?list=${listId}`
                if (videoId) fallbackUrl += `&v=${videoId}`
                const indexMatch = url.match(/[?&]index=(\d+)/)
                if (indexMatch?.[1]) fallbackUrl += `&index=${indexMatch[1]}`
              } else {
                fallbackUrl = `https://www.youtube.com/watch?v=${videoId}`
              }
              const fallbackResult = await this.resolve(fallbackUrl, 'youtube', overrideClients)
              if (
                fallbackResult &&
                (fallbackResult.loadType === 'track' ||
                  fallbackResult.loadType === 'playlist' ||
                  fallbackResult.loadType === 'empty')
              ) {
                if (fallbackResult.loadType === 'track' && fallbackResult.data) {
                  const td = fallbackResult.data as TrackData
                  td.info.sourceName = 'ytmusic'
                  td.info.uri = url
                } else if (fallbackResult.loadType === 'playlist' && fallbackResult.data) {
                  const pl = fallbackResult.data as PlaylistData
                  for (const t of pl.tracks) {
                    t.info.sourceName = 'ytmusic'
                    t.info.uri = `https://music.youtube.com/watch?v=${t.info.identifier}`
                  }
                }
                return fallbackResult
              }
            }
          }

          clientErrors.push({
            client: clientName,
            message: result?.exception?.message || `${clientName} failed.`
          })
        } catch (e) {
          clientErrors.push({ client: clientName, message: (e as Error).message })
        }
      }

      return {
        loadType: 'error',
        exception: {
          message: 'All music clients failed for direct Music URL.',
          severity: 'fault',
          cause: 'MusicClientsFailure'
        }
      }
    }

    if (urlType === YOUTUBE_CONSTANTS.PLAYLIST) {
      const androidClient = this.getClient('Android')
      if (androidClient) {
        try {
          const result = await androidClient.resolve(
            url,
            sourceType,
            this.ytContext,
            this.cipherManager
          )
          if (
            result &&
            (result.loadType === 'track' ||
              result.loadType === 'playlist' ||
              result.loadType === 'empty')
          ) {
            return result
          }
          clientErrors.push({
            client: 'Android',
            message: result?.exception?.message || 'Android playlist resolve failed.'
          })
        } catch (e) {
          clientErrors.push({ client: 'Android', message: (e as Error).message })
        }
      }
    }

    for (const rawName of clientList) {
      const resolvedKey = this.resolveConfiguredClientKey(rawName) ?? rawName
      const client = this.getClient(resolvedKey)
      if (!client) continue

      const oauthRejection = this.rejectOAuthClientWithoutToken(resolvedKey)
      if (oauthRejection) {
        clientErrors.push({ client: resolvedKey, message: oauthRejection })
        continue
      }

      if (!isMusicUrl && resolvedKey === 'Music') continue
      if (isMusicUrl && resolvedKey !== 'Music' && type !== 'youtube-fallback') continue
      if (type === 'youtube-fallback' && !['Android', 'Web'].includes(resolvedKey)) continue

      try {
        logger('debug', 'YouTube', `Attempting to resolve URL with client: ${resolvedKey}`)
        const result = await client.resolve(
          url,
          sourceType,
          this.ytContext,
          this.cipherManager,
          this.reportProxyStatus.bind(this)
        )

        if (
          result &&
          (result.loadType === 'track' ||
            result.loadType === 'playlist' ||
            result.loadType === 'empty')
        ) {
          logger('debug', 'YouTube', `Successfully resolved URL with client: ${resolvedKey}`)
          return result
        }

        clientErrors.push({
          client: resolvedKey,
          message: result?.exception?.message || 'Client returned empty or failed.'
        })
      } catch (e) {
        clientErrors.push({ client: resolvedKey, message: (e as Error).message })
      }
    }

    return {
      loadType: 'error',
      exception: {
        message: `All clients failed to resolve URL (${clientErrors.map((e) => `${e.client}: ${e.message}`).join('; ')})`,
        severity: 'fault',
        cause: 'All clients failed.'
      }
    }
  }

  public async listFormats(
    trackInfo: TrackInfo,
    explicitClients?: string[]
  ): Promise<FormatInventoryResult> {
    await this.setup()
    const clientList = explicitClients?.length
      ? explicitClients
      : this.config.clients.playback
    const errors: string[] = []

    for (const rawName of clientList) {
      const clientName = this.resolveConfiguredClientKey(rawName) ?? rawName
      const client = this.getClient(clientName)
      if (!client) {
        errors.push(`${rawName}: unknown client`)
        continue
      }

      const oauthRejection = this.rejectOAuthClientWithoutToken(clientName)
      if (oauthRejection) {
        errors.push(`${clientName}: requires OAuth token`)
        continue
      }

      try {
        const proxy = this.getProxy(true)
        if (clientName === 'Web') {
          // Web typically uses PoToken/SABR when calling getTrackUrl
          const res = await client.getTrackUrl(
            trackInfo,
            this.ytContext,
            this.cipherManager,
            undefined,
            proxy,
            { mode: 'audio', targetKind: 'audio' }
          )
          if (!res.exception && res.formats && res.formats.length > 0) {
            return {
              client: clientName,
              protocol: res.protocol === 'sabr' ? 'sabr' : res.hlsUrl && res.formats.length === 0 ? 'hls' : 'http',
              videoId: trackInfo.identifier,
              title: trackInfo.title,
              author: trackInfo.author,
              durationMs: trackInfo.length,
              hlsUrl: res.hlsUrl ?? null,
              formats: res.formats.map((f): FormatSummary => summarizeFormat({ ...f, itag: f.itag }))
            }
          }
        }

        const inv = await client.getFormatInventory(
          trackInfo,
          this.ytContext,
          this.cipherManager,
          proxy
        )
        if ('error' in inv) {
          errors.push(`${clientName}: ${inv.error}`)
          continue
        }
        return {
          ...inv,
          client: clientName
        }
      } catch (e) {
        errors.push(`${clientName}: ${(e as Error).message}`)
      }
    }

    throw new Error(`Failed to fetch format inventory (${errors.join('; ')})`)
  }

  private async runRangePreflight(
    url: string,
    proxy: ProxySnapshot | undefined,
    startedAt: number
  ): Promise<{
    ok: boolean
    statusCode: number
    error?: string
    contentLength: number | null
  }> {
    const check: HttpRequestResult = await http1makeRequest(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      streamOnly: true,
      proxy
    })

    if (check.stream) {
      check.stream.destroy()
    }

    const ok = !check.error && (check.statusCode === 200 || check.statusCode === 206)
    this.reportProxyStatus(proxy, ok, check.statusCode || 0, Date.now() - startedAt)

    if (!ok) {
      return {
        ok: false,
        statusCode: check.statusCode || 0,
        error: check.error,
        contentLength: null
      }
    }

    let contentLength: number | null = null
    const headers = check.headers as Record<string, string | string[] | undefined> | undefined
    const rawRange = headers?.['content-range']
    const contentRange = Array.isArray(rawRange) ? rawRange[0] : rawRange
    if (typeof contentRange === 'string') {
      const match = contentRange.match(/\/(\d+)/)
      if (match?.[1]) {
        contentLength = Number.parseInt(match[1], 10)
      }
    }
    if (!contentLength) {
      const rawLen = headers?.['content-length']
      const lenStr = Array.isArray(rawLen) ? rawLen[0] : rawLen
      if (typeof lenStr === 'string' && /^\d+$/.test(lenStr)) {
        contentLength = Number.parseInt(lenStr, 10)
      }
    }

    return {
      ok: true,
      statusCode: check.statusCode || 200,
      contentLength
    }
  }

  public async getTrackMedia(
    decodedTrack: TrackInfo,
    selection: StreamSelectionSpec,
    itagOverride?: number | null,
    forceRefresh = false,
    overrideClients?: string[]
  ): Promise<ResolvedMediaPlan> {
    await this.setup()

    const cacheKey = buildSelectionCacheKey(decodedTrack.identifier, selection, itagOverride)
    if (!forceRefresh) {
      const cached = this.mediaCache.get(cacheKey)
      if (cached && Date.now() < cached.expiresAt) {
        return cached.value
      }
    }

    let clientList = overrideClients?.length
      ? [...overrideClients]
      : [...this.config.clients.playback]
    if (clientList.length === 0) clientList = ['Web']

    const clientErrors: Array<{ client: string; message: string }> = []
    const failingClients = this.failingClientsByTrack.get(decodedTrack.identifier)
    let hlsProgressiveFallback: ResolvedMediaPlan | null = null

    for (const rawName of clientList) {
      const clientName = this.resolveConfiguredClientKey(rawName) ?? rawName
      if (failingClients?.has(clientName)) {
        logger(
          'debug',
          'YouTube',
          `Skipping known failing client ${clientName} for track ${decodedTrack.identifier}`
        )
        continue
      }

      const client = this.getClient(clientName)
      if (!client) continue

      const oauthRejection = this.rejectOAuthClientWithoutToken(clientName)
      if (oauthRejection) {
        clientErrors.push({ client: clientName, message: oauthRejection })
        logger('debug', 'YouTube', oauthRejection)
        continue
      }

      try {
        logger(
          'debug',
          'YouTube',
          `Attempting to get track media (${selection.mode}) for "${decodedTrack.title}" with client: ${clientName}`
        )
        const proxyToUse = this.getProxy(true)
        const proxyStartTime = Date.now()

        const effectiveItag = itagOverride ?? selection.itag ?? undefined
        const urlData: MediaExtractionResult = await client.getTrackUrl(
          decodedTrack,
          this.ytContext,
          this.cipherManager,
          effectiveItag,
          proxyToUse,
          selection
        )
        const proxyLatency = Date.now() - proxyStartTime

        if (urlData.exception) {
          const isNoStream = urlData.exception.cause === 'UpstreamNoStream'
          const isNotFound = urlData.exception.status === 404
          if (isNoStream || isNotFound) {
            let set = this.failingClientsByTrack.get(decodedTrack.identifier)
            if (!set) {
              set = new Set()
              this.failingClientsByTrack.set(decodedTrack.identifier, set)
            }
            set.add(clientName)
          }

          this.reportProxyStatus(
            proxyToUse,
            false,
            urlData.exception.status || 500,
            proxyLatency
          )
          clientErrors.push({ client: clientName, message: urlData.exception.message })
          logger('debug', 'YouTube', `Client ${clientName} failed: ${urlData.exception.message}`)
          continue
        }

        // 1. SABR Protocol (Web / Android)
        if (urlData.protocol === 'sabr') {
          this.reportProxyStatus(proxyToUse, true, 200, proxyLatency)
          const formats = urlData.formats ?? []
          const effectiveMode: DownloadMode =
            selection.mode === 'audio' ? 'audio' : 'video'

          let sabrVideo: ResolvedStreamComponent | undefined
          let sabrAudio: ResolvedStreamComponent | undefined

          if (effectiveMode === 'video') {
            if (effectiveItag) {
              const explicitFmt = formats.find((f) => f.itag === effectiveItag)
              if (!explicitFmt) {
                clientErrors.push({
                  client: clientName,
                  message: `SABR format itag ${effectiveItag} not found`
                })
                continue
              }
              const summary = summarizeFormat(explicitFmt)
              if (summary.kind === 'audio-only') {
                sabrAudio = {
                  itag: explicitFmt.itag,
                  mimeType: explicitFmt.mimeType,
                  format: resolveSabrFormatContainer(explicitFmt.mimeType),
                  qualityLabel: null,
                  width: null,
                  height: null,
                  fps: null,
                  bitrate: explicitFmt.bitrate ?? null,
                  contentLength: null
                }
              } else {
                sabrVideo = {
                  itag: explicitFmt.itag,
                  mimeType: explicitFmt.mimeType,
                  format: explicitFmt.mimeType?.includes('webm') ? 'webm' : 'mp4',
                  qualityLabel: explicitFmt.qualityLabel || null,
                  width: explicitFmt.width ?? null,
                  height: explicitFmt.height ?? null,
                  fps: explicitFmt.fps ?? null,
                  bitrate: explicitFmt.bitrate ?? null,
                  contentLength: null
                }
                const compatAudio = selectSabrAudioCandidate(
                  formats,
                  selection.audioQuality ?? 'high',
                  undefined,
                  explicitFmt.mimeType
                )
                if (compatAudio) {
                  sabrAudio = {
                    itag: compatAudio.itag,
                    mimeType: compatAudio.mimeType,
                    format: resolveSabrFormatContainer(compatAudio.mimeType),
                    qualityLabel: null,
                    width: null,
                    height: null,
                    fps: null,
                    bitrate: compatAudio.bitrate ?? null,
                    contentLength: null
                  }
                }
              }
            } else {
              const vCand = selectVideoCandidates(formats, selection)[0]
              if (vCand) {
                sabrVideo = {
                  itag: vCand.itag,
                  mimeType: vCand.mimeType,
                  format: vCand.mimeType?.includes('webm') ? 'webm' : 'mp4',
                  qualityLabel: vCand.qualityLabel || null,
                  width: vCand.width ?? null,
                  height: vCand.height ?? null,
                  fps: vCand.fps ?? null,
                  bitrate: vCand.bitrate ?? null,
                  contentLength: null
                }
                const aCand = selectSabrAudioCandidate(
                  formats,
                  selection.audioQuality ?? 'high',
                  undefined,
                  vCand.mimeType
                )
                if (aCand) {
                  sabrAudio = {
                    itag: aCand.itag,
                    mimeType: aCand.mimeType,
                    format: resolveSabrFormatContainer(aCand.mimeType),
                    qualityLabel: null,
                    width: null,
                    height: null,
                    fps: null,
                    bitrate: aCand.bitrate ?? null,
                    contentLength: null
                  }
                }
              }
            }
          } else {
            const bestAudio = selectSabrAudioCandidate(
              formats,
              selection.audioQuality ?? 'high',
              effectiveItag
            )
            if (bestAudio) {
              sabrAudio = {
                itag: bestAudio.itag,
                mimeType: bestAudio.mimeType,
                format: resolveSabrFormatContainer(bestAudio.mimeType),
                qualityLabel: null,
                width: null,
                height: null,
                fps: null,
                bitrate: bestAudio.bitrate ?? null,
                contentLength: null
              }
            }
          }

          if (effectiveMode === 'video' && (!sabrVideo || !sabrAudio)) {
            if (!sabrAudio && urlData.hlsUrl) {
              const hlsCheck = await this.runRangePreflight(
                urlData.hlsUrl,
                proxyToUse,
                proxyStartTime
              )
              if (hlsCheck.ok) {
                return {
                  url: urlData.hlsUrl,
                  protocol: 'hls',
                  format: 'mpegts',
                  mode: 'video',
                  hlsUrl: urlData.hlsUrl,
                  client: clientName,
                  additionalData: {
                    client: clientName,
                    proxy: proxyToUse,
                    mediaMode: 'video'
                  }
                }
              }
            }
            clientErrors.push({
              client: clientName,
              message: 'No compatible SABR video/audio formats found'
            })
            continue
          }

          if (effectiveMode === 'audio' && !sabrAudio) {
            clientErrors.push({
              client: clientName,
              message: 'No audio format available in SABR stream'
            })
            continue
          }

          const finalMode: DownloadMode = sabrVideo ? 'video' : 'audio'
          const sabrAd = (urlData.additionalData || {}) as TrackUrlAdditionalData
          return {
            protocol: 'sabr',
            mode: finalMode,
            url: urlData.url,
            format: sabrAudio
              ? resolveSabrFormatContainer(sabrAudio.mimeType)
              : sabrVideo?.format ?? 'webm',
            itag: sabrVideo?.itag ?? sabrAudio?.itag,
            hlsUrl: urlData.hlsUrl ?? null,
            formats,
            video: sabrVideo,
            audio: sabrAudio,
            client: clientName,
            additionalData: {
              ...sabrAd,
              client: clientName,
              sabr: true,
              proxy: proxyToUse,
              formats,
              mediaMode: finalMode === 'audio' ? 'audio' : 'video'
            }
          }
        }

        // 2. Paired Adaptive Video + Audio HTTP (default video mode)
        if (urlData.mode === 'video' && urlData.video?.url) {
          const videoCheck = await this.runRangePreflight(
            urlData.video.url,
            proxyToUse,
            proxyStartTime
          )

          let audioCheck: Awaited<ReturnType<YouTubeDownloader['runRangePreflight']>> = {
            ok: true,
            statusCode: 206,
            contentLength: urlData.audio?.contentLength ?? null
          }
          if (videoCheck.ok && urlData.audio?.url) {
            audioCheck = await this.runRangePreflight(
              urlData.audio.url,
              proxyToUse,
              proxyStartTime
            )
          }

          if (videoCheck.ok && audioCheck.ok) {
            logger(
              'debug',
              'YouTube',
              `Paired video+audio pre-flight passed for client ${clientName} (video itag=${urlData.video.itag}, audio itag=${urlData.audio?.itag ?? 'none'}).`
            )

            const videoComp: ResolvedStreamComponent = {
              ...urlData.video,
              contentLength: videoCheck.contentLength ?? urlData.video.contentLength
            }
            const audioComp: ResolvedStreamComponent | undefined = urlData.audio
              ? {
                  ...urlData.audio,
                  contentLength: audioCheck.contentLength ?? urlData.audio.contentLength
                }
              : undefined

            const plan: ResolvedMediaPlan = {
              url: videoComp.url,
              protocol: 'http',
              format: videoComp.format,
              itag: videoComp.itag,
              mode: 'video',
              hlsUrl: urlData.hlsUrl ?? null,
              formats: urlData.formats,
              video: videoComp,
              audio: audioComp,
              client: clientName,
              additionalData: {
                contentLength: videoComp.contentLength,
                proxy: proxyToUse,
                itag: videoComp.itag,
                formats: urlData.formats,
                client: clientName,
                mediaMode: 'video'
              }
            }
            this.mediaCache.set(cacheKey, {
              value: plan,
              expiresAt: Date.now() + URL_CACHE_TTL_MS
            })
            return plan
          }

          const failedStatus = !videoCheck.ok ? videoCheck.statusCode : audioCheck.statusCode
          const failedError = !videoCheck.ok ? videoCheck.error : audioCheck.error
          const errMsg = `URL pre-flight failed. Status: ${failedStatus}, Error: ${failedError}`
          clientErrors.push({ client: clientName, message: errMsg })
          logger('warn', 'YouTube', `Client ${clientName}: ${errMsg}`)

          if (failedStatus === 403 && urlData.hlsUrl) {
            logger(
              'warn',
              'YouTube',
              `Direct URL 403, attempting HLS fallback for client ${clientName}.`
            )
            const hlsCheck = await this.runRangePreflight(
              urlData.hlsUrl,
              proxyToUse,
              proxyStartTime
            )
            if (hlsCheck.ok) {
              const plan: ResolvedMediaPlan = {
                url: urlData.hlsUrl,
                protocol: 'hls',
                format: 'mpegts',
                mode: 'video',
                hlsUrl: urlData.hlsUrl,
                client: clientName,
                additionalData: {
                  client: clientName,
                  proxy: proxyToUse,
                  mediaMode: 'video'
                }
              }
              this.mediaCache.set(cacheKey, {
                value: plan,
                expiresAt: Date.now() + URL_CACHE_TTL_MS
              })
              return plan
            }
          }
          continue
        }

        // 3. Single Direct HTTP URL (audio-only or progressive)
        if (urlData.url) {
          const check = await this.runRangePreflight(
            urlData.url,
            proxyToUse,
            proxyStartTime
          )

          if (check.ok) {
            const actualMode: DownloadMode =
              urlData.mode === 'progressive'
                ? 'progressive'
                : urlData.mode === 'video'
                  ? 'video'
                  : 'audio'

            logger(
              'debug',
              'YouTube',
              `URL pre-flight check successful for client ${clientName} (mode=${actualMode}, itag=${urlData.itag ?? '?'}).`
            )

            const plan: ResolvedMediaPlan = {
              url: urlData.url,
              protocol: 'http',
              format: urlData.format ?? null,
              itag: urlData.itag,
              mode: actualMode,
              hlsUrl: urlData.hlsUrl ?? null,
              formats: urlData.formats,
              audio: urlData.audio
                ? {
                    ...urlData.audio,
                    contentLength: check.contentLength ?? urlData.audio.contentLength
                  }
                : undefined,
              progressive: urlData.progressive
                ? {
                    ...urlData.progressive,
                    contentLength: check.contentLength ?? urlData.progressive.contentLength
                  }
                : undefined,
              client: clientName,
              additionalData: {
                contentLength: check.contentLength ?? urlData.contentLength ?? null,
                proxy: proxyToUse,
                itag: urlData.itag,
                formats: urlData.formats,
                client: clientName,
                mediaMode: actualMode === 'audio' ? 'audio' : actualMode
              }
            }

            this.mediaCache.set(cacheKey, {
              value: plan,
              expiresAt: Date.now() + URL_CACHE_TTL_MS
            })
            return plan
          }

          const errorMessage = `URL pre-flight failed. Status: ${check.statusCode}, Error: ${check.error}`
          clientErrors.push({ client: clientName, message: `Direct URL: ${errorMessage}` })
          logger('warn', 'YouTube', `Client ${clientName}: ${errorMessage}`)

          if (check.statusCode === 403 && urlData.hlsUrl) {
            logger(
              'warn',
              'YouTube',
              `Direct URL 403, attempting HLS fallback for client ${clientName}.`
            )
            const hlsCheck = await this.runRangePreflight(
              urlData.hlsUrl,
              proxyToUse,
              proxyStartTime
            )
            if (hlsCheck.ok) {
              const fallbackMode = selection.mode === 'audio' ? 'audio' : selection.mode
              const plan: ResolvedMediaPlan = {
                url: urlData.hlsUrl,
                protocol: 'hls',
                format: 'mpegts',
                mode: fallbackMode,
                hlsUrl: urlData.hlsUrl,
                client: clientName,
                additionalData: {
                  client: clientName,
                  proxy: proxyToUse,
                  mediaMode: fallbackMode === 'audio' ? 'audio' : 'video'
                }
              }
              this.mediaCache.set(cacheKey, {
                value: plan,
                expiresAt: Date.now() + URL_CACHE_TTL_MS
              })
              return plan
            }
          }
        } else if (urlData.hlsUrl) {
          const hlsCheck = await this.runRangePreflight(
            urlData.hlsUrl,
            proxyToUse,
            proxyStartTime
          )
          if (hlsCheck.ok) {
            const actualMode = selection.mode
            const plan: ResolvedMediaPlan = {
              url: urlData.hlsUrl,
              protocol: 'hls',
              format: 'mpegts',
              mode: actualMode,
              hlsUrl: urlData.hlsUrl,
              client: clientName,
              additionalData: {
                client: clientName,
                proxy: proxyToUse,
                mediaMode: actualMode === 'audio' ? 'audio' : 'video'
              }
            }
            if (selection.mode === 'progressive' && !decodedTrack.isStream) {
              if (!hlsProgressiveFallback) {
                hlsProgressiveFallback = plan
              }
              clientErrors.push({
                client: clientName,
                message: 'No direct progressive format; saved HLS fallback'
              })
              logger(
                'debug',
                'YouTube',
                `Client ${clientName} has no direct progressive stream (saving HLS fallback); checking remaining clients.`
              )
              continue
            }
            this.mediaCache.set(cacheKey, {
              value: plan,
              expiresAt: Date.now() + URL_CACHE_TTL_MS
            })
            return plan
          }

          clientErrors.push({
            client: clientName,
            message: `HLS-only check failed. Status: ${hlsCheck.statusCode}, Error: ${hlsCheck.error}`
          })
        }
      } catch (e) {
        clientErrors.push({ client: clientName, message: (e as Error).message })
        logger(
          'warn',
          'YouTube',
          `Client ${clientName} threw an exception in getTrackMedia: ${(e as Error).message}`
        )
      }
    }

    if (hlsProgressiveFallback) {
      this.mediaCache.set(cacheKey, {
        value: hlsProgressiveFallback,
        expiresAt: Date.now() + URL_CACHE_TTL_MS
      })
      return hlsProgressiveFallback
    }

    if (decodedTrack.audioTrackId) {
      logger(
        'warn',
        'YouTube',
        `Requested audio track "${decodedTrack.audioTrackId}" not found on any client. Falling back to default audio.`
      )
      const fallbackTrack: TrackInfo = { ...decodedTrack }
      delete fallbackTrack.audioTrackId
      return await this.getTrackMedia(
        fallbackTrack,
        selection,
        itagOverride,
        forceRefresh,
        overrideClients
      )
    }

    return {
      loadType: 'error',
      mode: selection.mode,
      exception: {
        message: `Failed to get a working stream URL (${clientErrors.map((e) => `${e.client}: ${e.message}`).join('; ')})`,
        severity: 'fault',
        cause: 'All clients failed.'
      }
    }
  }

  public async loadStream(
    decodedTrack: TrackInfo,
    url: string,
    protocol: string,
    additionalData?: TrackUrlAdditionalData & {
      refreshSelection?: StreamSelectionSpec
      overrideClients?: string[]
      maxHeight?: number | null
      onAudioRendition?: (audioUrl: string) => void
    }
  ): Promise<StreamResult> {
    logger(
      'debug',
      'YouTube',
      `Loading stream for "${decodedTrack.title}" with protocol ${protocol}`
    )

    const cancelSignal: CancelSignal = { aborted: false }
    const streamKey: string | symbol = additionalData?.streamKey || Symbol('streamKey')
    this.activeStreams.set(streamKey, cancelSignal)

    try {
      if (protocol === 'sabr') {
        return await this._loadSabrStream(
          decodedTrack,
          additionalData ?? {},
          cancelSignal,
          streamKey
        )
      }

      if (protocol === 'hls') {
        return this._loadHlsStream(url, cancelSignal, streamKey, additionalData)
      }

      if (!url) throw new Error('No direct URL')

      let contentLength = additionalData?.contentLength ?? null

      if (!contentLength) {
        const testResponse = await http1makeRequest(url, {
          method: 'HEAD',
          timeout: 5000,
          proxy: additionalData?.proxy
        })

        const headers = testResponse.headers as
          | Record<string, string | string[] | undefined>
          | undefined
        const clRaw = headers?.['content-length']
        const clStr = Array.isArray(clRaw) ? clRaw[0] : clRaw
        if (clStr && /^\d+$/.test(clStr)) {
          contentLength = Number.parseInt(clStr, 10)
        }

        if (testResponse.statusCode === 403) {
          throw new Error('URL returned 403 Forbidden')
        }

        if (!contentLength) {
          const rangeResponse = await http1makeRequest(url, {
            method: 'GET',
            headers: { Range: 'bytes=0-0' },
            streamOnly: true,
            proxy: additionalData?.proxy || this.getProxy()
          })
          rangeResponse.stream?.destroy()

          const rangeHeaders = rangeResponse.headers as
            | Record<string, string | string[] | undefined>
            | undefined
          const crRaw = rangeHeaders?.['content-range']
          const crStr = Array.isArray(crRaw) ? crRaw[0] : crRaw
          if (crStr) {
            const match = crStr.match(/\/(\d+)/)
            if (match?.[1]) contentLength = Number.parseInt(match[1], 10)
          }
        }
      }

      if (contentLength && contentLength > 0) {
        logger(
          'debug',
          'YouTube',
          `Using Chunked HTTP buffering for "${decodedTrack.title}" (${(contentLength / 1024 / 1024).toFixed(2)} MiB)`
        )
        return this._streamChunkedHttp(
          url,
          contentLength,
          decodedTrack,
          cancelSignal,
          streamKey,
          additionalData
        )
      }

      return await this._loadDirectStream(
        url,
        decodedTrack,
        cancelSignal,
        streamKey,
        additionalData
      )
    } catch (e) {
      this.activeStreams.delete(streamKey)
      logger(
        'error',
        'YouTube',
        `Error loading stream for ${decodedTrack.identifier}: ${(e as Error).message}`
      )
      return {
        exception: {
          message: (e as Error).message,
          severity: 'fault',
          cause: 'Upstream'
        }
      }
    }
  }

  private async _loadSabrStream(
    decodedTrack: TrackInfo,
    additionalData: TrackUrlAdditionalData & {
      refreshSelection?: StreamSelectionSpec
      overrideClients?: string[]
    },
    cancelSignal: CancelSignal,
    streamKey: string | symbol
  ): Promise<StreamResult> {
    const sabrConfig: SabrStreamConfig = {
      videoId: decodedTrack.identifier,
      accessToken: additionalData.accessToken ?? undefined,
      visitorData: additionalData.visitorData ?? undefined,
      serverAbrStreamingUrl: additionalData.serverAbrStreamingUrl,
      videoPlaybackUstreamerConfig: additionalData.videoPlaybackUstreamerConfig,
      poToken: additionalData.poToken,
      clientInfo: additionalData.clientInfo,
      formats: additionalData.formats,
      startTime: additionalData.startTime ?? 0,
      positionCallback: additionalData.positionCallback,
      playbackPaused: additionalData.playbackPaused,
      previousSession: additionalData.previousSession,
      userAgent: additionalData.userAgent,
      playbackCookie: additionalData.playbackCookie,
      enableTrafficLog: this.config.debugLogs,
      trafficLogPath: path.join(this.logDir, 'sabr_traffic.jsonl')
    }
    const sabr = new SabrStream(sabrConfig)
    const stream = new PassThrough()
    this.activeSabrStreams.set(streamKey, { sabr, stream })

    let readyResolved = false
    let readyResolve!: () => void
    let readyReject!: (err: Error) => void
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve
      readyReject = reject
    })
    let isRecovering = false

    sabr.once('mediaProgress', () => {
      if (readyResolved) return
      readyResolved = true
      readyResolve()
    })

    sabr.on('data', (chunk: Buffer) => {
      if (!stream.write(chunk)) {
        sabr.pause()
      }
    })
    const onSabrDrain = () => sabr.resume()
    stream.on('drain', onSabrDrain)

    sabr.on('end', () => {
      if (!readyResolved) {
        readyResolved = true
        readyReject(new Error('SABR stream ended before data'))
      }
      stream.end()
    })
    sabr.on('finishBuffering', () => stream.emit('finishBuffering'))

    const targetMode: 'audio' | 'video' =
      additionalData.mediaMode === 'video' ? 'video' : 'audio'
    const formats = additionalData.formats ?? []
    let chosenFormat: FormatEntry | undefined
    if (additionalData.itag) {
      chosenFormat = formats.find((f) => f.itag === additionalData.itag)
    }
    if (!chosenFormat) {
      chosenFormat =
        targetMode === 'video'
          ? selectVideoCandidates(formats, { mode: 'video', targetKind: 'video' })[0]
          : selectSabrAudioCandidate(formats, 'high')
    }

    if (!chosenFormat) {
      stream.destroy(new Error(`No ${targetMode} format available in SABR stream`))
      throw new Error(`No ${targetMode} format available in SABR stream`)
    }

    sabr.on(
      'stall',
      async (reason = 'starvation', recoveryGeneration?: number) => {
        if (
          isRecovering ||
          stream.destroyed ||
          sabr.destroyed ||
          cancelSignal.aborted
        ) {
          return
        }

        isRecovering = true
        const generation = recoveryGeneration ?? sabr.getMediaProgressGeneration()
        try {
          logger(
            'warn',
            'YouTube',
            `SABR ${reason} recovery requested for ${decodedTrack.title}. Refreshing session...`
          )
          const recoverySel: StreamSelectionSpec = additionalData.refreshSelection ?? {
            mode: targetMode === 'video' ? 'video' : 'audio',
            targetKind: targetMode,
            itag: chosenFormat.itag
          }
          const newUrlData = await this.getTrackMedia(
            decodedTrack,
            recoverySel,
            chosenFormat.itag,
            true,
            additionalData.overrideClients
          )
          if (newUrlData?.protocol !== 'sabr') {
            throw new Error('No SABR session available for recovery')
          }

          if (!sabr.canCommitRecovery(generation)) {
            logger(
              'debug',
              'YouTube',
              `Discarding stale SABR replacement for ${decodedTrack.title}; media advanced during recovery.`
            )
            sabr.cancelRecovery()
            return
          }

          const ad = (newUrlData.additionalData || {}) as TrackUrlAdditionalData
          sabr.clearBuffers()
          sabr.updateSession({
            serverAbrStreamingUrl: ad.serverAbrStreamingUrl || newUrlData.url,
            videoPlaybackUstreamerConfig: ad.videoPlaybackUstreamerConfig,
            poToken: ad.poToken,
            visitorData: ad.visitorData ?? undefined,
            clientInfo: ad.clientInfo,
            formats: ad.formats,
            userAgent: ad.userAgent,
            playbackCookie: ad.playbackCookie
          })
        } catch (err) {
          logger('warn', 'YouTube', `SABR recovery failed: ${(err as Error).message}`)
          if (!readyResolved) {
            readyResolved = true
            readyReject(err as Error)
            if (!stream.destroyed) stream.destroy()
          } else if (!stream.destroyed) {
            stream.destroy(err as Error)
          }
        } finally {
          isRecovering = false
        }
      }
    )

    sabr.on('error', (err: Error) => {
      logger('error', 'YouTube', `SABR stream error: ${err.message}`)
      if (!readyResolved) {
        readyResolved = true
        readyReject(err)
        if (!stream.destroyed) stream.destroy()
        return
      }
      if (!stream.destroyed) stream.destroy(err)
    })

    const originalDestroy = stream.destroy.bind(stream)
    let isDestroying = false
    stream.destroy = ((err?: Error) => {
      if (isDestroying) return stream
      isDestroying = true
      cancelSignal.aborted = true
      stream.removeListener('drain', onSabrDrain)
      sabr.destroy(err)
      this.activeStreams.delete(streamKey)
      this.activeSabrStreams.delete(streamKey)
      originalDestroy(err)
      return stream
    }) as typeof stream.destroy

    stream.once('close', () => {
      if (isDestroying) return
      isDestroying = true
      cancelSignal.aborted = true
      stream.removeListener('drain', onSabrDrain)
      sabr.destroy()
      this.activeStreams.delete(streamKey)
      this.activeSabrStreams.delete(streamKey)
    })

    sabr.start(chosenFormat.itag, targetMode)
    const type =
      targetMode === 'video'
        ? chosenFormat.mimeType?.includes('webm')
          ? 'webm'
          : 'mp4'
        : resolveSabrFormatContainer(chosenFormat.mimeType)

    await ready
    return { stream, type }
  }

  private _loadHlsStream(
    url: string,
    cancelSignal: CancelSignal,
    streamKey: string | symbol,
    additionalData?: TrackUrlAdditionalData & {
      maxHeight?: number | null
      onAudioRendition?: (audioUrl: string) => void
    }
  ): StreamResult {
    const playerScriptPromise = this.cipherManager.getCachedPlayerScript()
    const stream = new HLSHandler(url, {
      type: 'mpegts',
      proxy: additionalData?.proxy,
      mediaMode: additionalData?.mediaMode === 'video' ? 'video' : 'audio',
      maxHeight: additionalData?.maxHeight ?? null,
      onAudioRendition: additionalData?.onAudioRendition,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        Referer: 'https://www.youtube.com/',
        Origin: 'https://www.youtube.com'
      },
      onResolveUrl: async (segmentUrl: string): Promise<string | null> => {
        if (segmentUrl.includes('/n/')) {
          const nToken = segmentUrl.match(/\/n\/([^/]+)/)?.[1]
          const playerScript = await playerScriptPromise
          if (nToken && playerScript) {
            try {
              return await this.cipherManager.resolveUrl(
                segmentUrl,
                null,
                nToken,
                null,
                playerScript
              )
            } catch (err) {
              logger(
                'warn',
                'YouTube',
                `Failed to resolve n-token: ${(err as Error).message}`
              )
            }
          }
        }
        return null
      }
    })

    const originalDestroy = stream.destroy.bind(stream)
    stream.destroy = ((err?: Error) => {
      if (cancelSignal.aborted) return stream
      cancelSignal.aborted = true
      this.activeStreams.delete(streamKey)
      originalDestroy(err)
      return stream
    }) as typeof stream.destroy

    return { stream, type: 'mpegts' }
  }

  private async _loadDirectStream(
    url: string,
    _decodedTrack: TrackInfo,
    cancelSignal: CancelSignal,
    streamKey: string | symbol,
    additionalData?: TrackUrlAdditionalData
  ): Promise<StreamResult> {
    const fetchStartTime = Date.now()
    const response = await http1makeRequest(url, {
      method: 'GET',
      streamOnly: true,
      proxy: additionalData?.proxy || this.getProxy(),
      timeout: 20000
    })

    this.reportProxyStatus(
      additionalData?.proxy || this.getProxy(false),
      !response.error && (response.statusCode === 200 || response.statusCode === 206),
      response.statusCode || 0,
      Date.now() - fetchStartTime
    )

    if (response.statusCode !== 200 && response.statusCode !== 206) {
      response.stream?.destroy()
      throw new Error(`HTTP status ${response.statusCode}`)
    }

    const responseStream = response.stream
    if (!responseStream) throw new Error('Missing response stream')

    const stream = new PassThrough()
    let cleanedUp = false

    const onDrain = () => {
      if (!responseStream.destroyed) responseStream.resume()
    }
    const cleanup = () => {
      if (cleanedUp) return
      cleanedUp = true
      cancelSignal.aborted = true
      stream.removeListener('drain', onDrain)
      responseStream.removeAllListeners()
      if (!responseStream.destroyed) responseStream.destroy()
      this.activeStreams.delete(streamKey)
      stream.removeListener('close', cleanup)
    }

    responseStream.on('data', (chunk: Buffer) => {
      if (!stream.write(chunk)) {
        responseStream.pause()
      }
    })
    stream.on('drain', onDrain)

    responseStream.on('end', () => {
      cleanup()
      if (!stream.writableEnded) {
        stream.emit('finishBuffering')
        stream.end()
      }
    })

    responseStream.on('error', (error: Error & { code?: string }) => {
      cleanup()
      if (!stream.destroyed) {
        stream.destroy(new Error(`Stream failed: ${error.message}`))
      }
    })

    const originalDestroy = stream.destroy.bind(stream)
    stream.destroy = ((err?: Error) => {
      cleanup()
      originalDestroy(err)
      return stream
    }) as typeof stream.destroy

    stream.once('close', cleanup)

    return { stream }
  }

  private _streamChunkedHttp(
    url: string,
    contentLength: number,
    decodedTrack: TrackInfo,
    cancelSignal: CancelSignal,
    streamKey: string | symbol,
    additionalData?: TrackUrlAdditionalData & {
      refreshSelection?: StreamSelectionSpec
      overrideClients?: string[]
    }
  ): StreamResult {
    const stream = new PassThrough({
      highWaterMark: STREAM_BUFFER_SIZE
    })

    let currentUrl = url
    let currentProxy = additionalData?.proxy || this.getProxy()
    let urlFetchTime = Date.now()
    let isDestroyed = false
    let isBackpressured = false
    let totalBytesReceived = 0
    const initialSeekMs =
      typeof additionalData?.startTime === 'number' && additionalData.startTime > 0
        ? additionalData.startTime
        : 0
    let needsClusterAlignment = false
    let clusterSearchRemainder = Buffer.alloc(0)
    let currentItag = additionalData?.itag
    let currentClient = additionalData?.client
    let consecutiveClientFailures = 0
    let availableFormats = additionalData?.formats || []
    const failedItags = new Set<number>()
    let refreshAttempts = 0
    let consecutiveResets = 0
    let cleanChunks = 0
    let activeResponseStream: Readable | null = null

    let bandwidthEstimate = this.bandwidthEstimate || 128_000
    const updateBandwidthEstimate = (bytes: number, durationMs: number): void => {
      if (bytes <= 0 || durationMs <= 0) return
      const bits = bytes * 8
      const throughput = (bits / durationMs) * 1000
      const alpha = 0.25
      bandwidthEstimate = Math.max(
        128_000,
        alpha * throughput + (1 - alpha) * bandwidthEstimate
      )
      this.bandwidthEstimate = bandwidthEstimate
    }

    const onDrain = () => {
      isBackpressured = false
      if (activeResponseStream && !activeResponseStream.destroyed) {
        activeResponseStream.resume()
      }
    }

    let wakeUp: (() => void) | null = null
    const cancelSleep = () => {
      wakeUp?.()
      wakeUp = null
    }
    const sleep = (ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          wakeUp = null
          resolve()
        }, ms)
        t.unref?.()
        wakeUp = () => {
          clearTimeout(t)
          resolve()
        }
      })

    const cleanup = (err?: Error): void => {
      if (isDestroyed) return
      isDestroyed = true
      cancelSignal.aborted = true
      cancelSleep()
      stream.removeListener('drain', onDrain)

      if (activeResponseStream && !activeResponseStream.destroyed) {
        activeResponseStream.destroy()
        activeResponseStream = null
      }

      if (!stream.destroyed) stream.destroy(err)
      this.activeStreams.delete(streamKey)
    }

    const waitForDrainOrClose = (): Promise<void> =>
      new Promise<void>((resolve) => {
        const onReady = () => {
          stream.removeListener('drain', onReady)
          stream.removeListener('close', onReady)
          resolve()
        }
        stream.once('drain', onReady)
        stream.once('close', onReady)
      })

    stream.once('close', () => cleanup())
    stream.once('error', (err: Error) => cleanup(err))
    stream.on('drain', onDrain)

    let totalContentLength = contentLength
    const refreshSelection: StreamSelectionSpec = additionalData?.refreshSelection ?? {
      mode: 'audio',
      targetKind: 'audio',
      itag: currentItag ?? null
    }

    const refreshUrl = async (reason: string): Promise<string | null> => {
      if (isDestroyed || cancelSignal.aborted) return null
      if (++refreshAttempts > MAX_URL_REFRESH) {
        logger(
          'error',
          'YouTube',
          `Max URL refresh (${MAX_URL_REFRESH}) reached for ${decodedTrack.title}`
        )
        return null
      }

      logger(
        'debug',
        'YouTube',
        `Refreshing URL for "${decodedTrack.title}" (reason: ${reason}, ${refreshAttempts}/${MAX_URL_REFRESH})`
      )

      try {
        let itagToTry: number | null = null
        if (
          totalBytesReceived === 0 &&
          currentItag &&
          failedItags.has(currentItag) &&
          availableFormats.length > 0 &&
          refreshSelection.targetKind === 'audio'
        ) {
          const currentMime =
            availableFormats.find((f) => f.itag === currentItag)?.mimeType || ''
          const isWebm = currentMime.includes('webm')
          const fallback = availableFormats
            .filter(
              (f) =>
                f.itag !== currentItag &&
                !failedItags.has(f.itag) &&
                f.mimeType?.includes('audio') &&
                (isWebm ? f.mimeType.includes('webm') : f.mimeType.includes('mp4'))
            )
            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0]

          if (fallback) {
            itagToTry = fallback.itag
          }
        } else if (totalBytesReceived > 0 && currentItag) {
          itagToTry = currentItag
        }

        if (consecutiveClientFailures >= 2 && currentClient) {
          let set = this.failingClientsByTrack.get(decodedTrack.identifier)
          if (!set) {
            set = new Set()
            this.failingClientsByTrack.set(decodedTrack.identifier, set)
          }
          set.add(currentClient)
          logger(
            'warn',
            'YouTube',
            `Client ${currentClient} failed repeatedly mid-stream for "${decodedTrack.title}". Rotating client...`
          )
          for (const key of this.mediaCache.keys()) {
            if (key.startsWith(`${decodedTrack.identifier}:`)) {
              this.mediaCache.delete(key)
            }
          }
          consecutiveClientFailures = 0
        }

        const selForRefresh: StreamSelectionSpec = {
          ...refreshSelection,
          itag: itagToTry ?? refreshSelection.itag
        }
        let newUrlData = await this.getTrackMedia(
          decodedTrack,
          selForRefresh,
          itagToTry,
          true,
          additionalData?.overrideClients
        )
        if ((newUrlData.exception || !newUrlData.url) && itagToTry !== null) {
          newUrlData = await this.getTrackMedia(
            decodedTrack,
            { ...refreshSelection, itag: null },
            null,
            true,
            additionalData?.overrideClients
          )
        }
        if (isDestroyed || cancelSignal.aborted) return null

        let refreshedComponentUrl: string | undefined
        let refreshedItag: number | undefined
        let refreshedLen: number | null | undefined

        if (refreshSelection.targetKind === 'video' && newUrlData.video?.url) {
          refreshedComponentUrl = newUrlData.video.url
          refreshedItag = newUrlData.video.itag
          refreshedLen = newUrlData.video.contentLength
        } else if (refreshSelection.targetKind === 'audio' && (newUrlData.audio?.url || newUrlData.url)) {
          refreshedComponentUrl = newUrlData.audio?.url ?? newUrlData.url
          refreshedItag = newUrlData.audio?.itag ?? newUrlData.itag
          refreshedLen = newUrlData.audio?.contentLength ?? newUrlData.additionalData?.contentLength
        } else if (newUrlData.url) {
          refreshedComponentUrl = newUrlData.url
          refreshedItag = newUrlData.itag
          refreshedLen = newUrlData.additionalData?.contentLength
        }

        if (newUrlData.exception || !refreshedComponentUrl) return null

        const newAd = newUrlData.additionalData
        if (newAd?.client) currentClient = newAd.client

        if (
          totalBytesReceived > 0 &&
          refreshedItag &&
          currentItag &&
          refreshedItag !== currentItag
        ) {
          cleanup(
            new Error(
              `Mid-stream format change (${currentItag} -> ${refreshedItag}) at ${totalBytesReceived} bytes cannot be stitched into single file`
            )
          )
          return null
        }

        currentUrl = refreshedComponentUrl
        currentProxy = newAd?.proxy || currentProxy
        currentItag = refreshedItag || currentItag
        if (newUrlData.formats) availableFormats = newUrlData.formats
        if (totalBytesReceived === 0 && refreshedLen) {
          totalContentLength = refreshedLen
        }
        urlFetchTime = Date.now()
        consecutiveResets = 0
        cleanChunks = 0

        logger(
          'debug',
          'YouTube',
          `URL refreshed for "${decodedTrack.title}" (itag ${currentItag}, client: ${currentClient || 'unknown'})`
        )
        return currentUrl
      } catch (err) {
        logger('error', 'YouTube', `URL refresh failed: ${(err as Error).message}`)
        return null
      }
    }

    let effectiveSeekMs = initialSeekMs
    if (initialSeekMs > 0) {
      const seekMime =
        availableFormats.find((formatEntry) => formatEntry.itag === currentItag)?.mimeType || ''
      const seekIsWebm =
        seekMime.toLowerCase().includes('webm') ||
        (typeof currentItag === 'number' && YOUTUBE_WEBM_ITAGS.has(currentItag))
      if (!seekIsWebm) {
        effectiveSeekMs = 0
      }
    }

    const startStreaming = async (): Promise<void> => {
      const MIN_TARGET_SECONDS = 2
      const MAX_TARGET_SECONDS = 12
      const INITIAL_TARGET_SECONDS = 4
      let targetSeconds = INITIAL_TARGET_SECONDS

      const ABS_MIN_BYTES = CHUNK_SIZE
      const ABS_MAX_BYTES = 512 * 1024
      const HEALTHY_MAX_BYTES = 4 * 1024 * 1024
      const CLEAN_TO_UNLOCK = 3

      const trackBytesPerSecond =
        contentLength > 0 && decodedTrack.length > 0
          ? contentLength / (decodedTrack.length / 1000)
          : 16_000

      let chunkCount = 0

      if (effectiveSeekMs > 0 && totalContentLength > 0 && decodedTrack.length > 0) {
        try {
          let headerData: Buffer | null = null
          let firstClusterIndex = -1
          for (const windowEnd of WEBM_SEEK_PROBE_WINDOWS) {
            if (isDestroyed || cancelSignal.aborted) break
            const headerResult = await http1makeRequest(currentUrl, {
              method: 'GET',
              streamOnly: true,
              proxy: currentProxy,
              timeout: 15000,
              headers: {
                Range: `bytes=0-${windowEnd}`,
                'Accept-Encoding': 'identity;q=1, *;q=0',
                'Sec-Fetch-Dest': 'video',
                'Sec-Fetch-Mode': 'no-cors',
                'Sec-Fetch-Site': 'same-origin',
                Referer: currentUrl,
                Accept: '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Cache-Control': 'no-cache',
                Pragma: 'no-cache',
                Priority: 'i'
              }
            })
            const headerStream = headerResult.stream
            if (
              headerResult.error ||
              (headerResult.statusCode !== 206 && headerResult.statusCode !== 200) ||
              !headerStream
            ) {
              headerStream?.destroy()
              break
            }
            const headerChunks: Buffer[] = []
            let headerBytes = 0
            for await (const headerChunk of headerStream as AsyncIterable<Buffer>) {
              if (isDestroyed || cancelSignal.aborted) break
              headerChunks.push(headerChunk)
              headerBytes += headerChunk.length
              if (headerBytes > windowEnd) break
            }
            try {
              headerStream.destroy()
            } catch {}
            headerData = Buffer.concat(headerChunks)
            firstClusterIndex = headerData.indexOf(WEBM_CLUSTER_MAGIC)
            if (firstClusterIndex > 0) break
          }
          if (!isDestroyed && !cancelSignal.aborted && headerData && firstClusterIndex > 0) {
            stream.write(headerData.subarray(0, firstClusterIndex))
            const seekRatio = Math.min(Math.max(effectiveSeekMs / decodedTrack.length, 0), 1)
            totalBytesReceived = Math.min(
              Math.floor(seekRatio * totalContentLength),
              totalContentLength - 1
            )
            needsClusterAlignment = true
          }
        } catch {}
      }

      while (!isDestroyed && !cancelSignal.aborted && totalBytesReceived < totalContentLength) {
        if (stream.writableLength > STREAM_BUFFER_SIZE) {
          await Promise.race([waitForDrainOrClose(), sleep(30000)])
          continue
        }

        const urlAge = Date.now() - urlFetchTime
        if (urlAge > URL_MAX_AGE_MS) {
          const refreshed = await refreshUrl('URL age > 4.5h')
          if (!refreshed) {
            cleanup(new Error('Failed to refresh expired URL'))
            return
          }
        }

        const proxyToUse = currentProxy
        const fetchStartTime = Date.now()

        if (stream.writableLength > STREAM_BUFFER_SIZE * 0.75) {
          targetSeconds = Math.max(MIN_TARGET_SECONDS, targetSeconds - 2)
        } else if (stream.writableLength === 0 && cleanChunks >= CLEAN_TO_UNLOCK) {
          targetSeconds = Math.min(MAX_TARGET_SECONDS, targetSeconds + 2)
        }

        const maxBytes =
          cleanChunks >= CLEAN_TO_UNLOCK ? HEALTHY_MAX_BYTES : ABS_MAX_BYTES
        const bytesPerSecond = bandwidthEstimate / 8
        let dynamicChunkSize = Math.floor(bytesPerSecond * targetSeconds)
        dynamicChunkSize = Math.max(
          ABS_MIN_BYTES,
          Math.min(dynamicChunkSize, maxBytes)
        )
        if (dynamicChunkSize > ABS_MAX_BYTES) {
          const jitter = 0.95 + Math.random() * 0.1
          dynamicChunkSize = Math.min(Math.floor(dynamicChunkSize * jitter), maxBytes)
        }

        const start = totalBytesReceived
        const end = Math.min(start + dynamicChunkSize - 1, totalContentLength - 1)
        const rangeHeader = `bytes=${start}-${end}`

        try {
          const result = await http1makeRequest(currentUrl, {
            method: 'GET',
            streamOnly: true,
            proxy: proxyToUse,
            timeout: 30000,
            headers: {
              Range: rangeHeader,
              'Accept-Encoding': 'identity;q=1, *;q=0',
              'Sec-Fetch-Dest': 'video',
              'Sec-Fetch-Mode': 'no-cors',
              'Sec-Fetch-Site': 'same-origin',
              Referer: currentUrl,
              Accept: '*/*',
              'Accept-Language': 'en-US,en;q=0.9',
              'Cache-Control': 'no-cache',
              Pragma: 'no-cache',
              Priority: 'i'
            }
          })

          if (isDestroyed || cancelSignal.aborted) {
            if (result.stream && !result.stream.destroyed) result.stream.destroy()
            return
          }

          this.reportProxyStatus(
            proxyToUse,
            !result.error && result.statusCode === 206,
            result.statusCode || 0,
            Date.now() - fetchStartTime
          )

          if (result.error || (result.statusCode !== 200 && result.statusCode !== 206)) {
            result.stream?.destroy()

            if (result.statusCode === 416) {
              if (totalBytesReceived >= totalContentLength) {
                if (!stream.writableEnded) {
                  stream.emit('finishBuffering')
                  stream.end()
                }
                return
              }
              if (totalBytesReceived === 0 && currentItag) failedItags.add(currentItag)
              const refreshed = await refreshUrl('HTTP 416')
              if (refreshed) continue
              cleanup(new Error('HTTP 416: max URL refresh reached'))
              return
            }

            if (result.statusCode === 403 || result.statusCode === 404) {
              consecutiveClientFailures++
              logger(
                'warn',
                'YouTube',
                `HTTP ${result.statusCode} for "${decodedTrack.title}" (client: ${currentClient || 'unknown'}, failure #${consecutiveClientFailures}) -- refreshing...`
              )
              if (totalBytesReceived === 0 && currentItag) failedItags.add(currentItag)
              const refreshed = await refreshUrl(`HTTP ${result.statusCode}`)
              if (refreshed) continue
              cleanup(new Error(`HTTP ${result.statusCode}: max URL refresh reached`))
              return
            }

            const retryDelay = Math.min(
              RECOVER_BASE_DELAY_MS * 2 ** Math.max(0, refreshAttempts - 1),
              MAX_RETRY_DELAY_MS
            )
            cleanChunks = 0
            await sleep(retryDelay)
            continue
          }

          const rawCr = result.headers?.['content-range']
          const contentRange = Array.isArray(rawCr) ? rawCr[0] : rawCr ?? null
          const rangeMatch =
            result.statusCode === 206
              ? /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange ?? '')
              : null
          const responseStart = rangeMatch ? Number(rangeMatch[1]) : -1
          const responseEnd = rangeMatch ? Number(rangeMatch[2]) : -1

          if (
            result.statusCode !== 206 ||
            responseStart !== start ||
            responseEnd < responseStart ||
            responseEnd > end
          ) {
            result.stream?.destroy()
            const refreshed = await refreshUrl('invalid range response')
            if (refreshed) continue
            cleanup(new Error('Invalid HTTP range response'))
            return
          }

          const responseStream = result.stream
          if (!responseStream) {
            cleanup(new Error('Missing response stream'))
            return
          }

          activeResponseStream = responseStream
          let bytesThisChunk = 0
          let dataStartTime = 0

          await new Promise<void>((resolve, reject) => {
            if (isDestroyed || cancelSignal.aborted) {
              if (!responseStream.destroyed) responseStream.destroy()
              resolve()
              return
            }

            const onData = (chunk: Buffer) => {
              if (isDestroyed || cancelSignal.aborted) {
                responseStream.destroy()
                return
              }
              consecutiveClientFailures = 0
              if (dataStartTime === 0) dataStartTime = Date.now()
              bytesThisChunk += chunk.length
              totalBytesReceived += chunk.length

              let dataToWrite: Buffer | null = chunk
              if (needsClusterAlignment) {
                const combined =
                  clusterSearchRemainder.length > 0
                    ? Buffer.concat([clusterSearchRemainder, chunk])
                    : chunk
                const magicIndex = combined.indexOf(WEBM_CLUSTER_MAGIC)
                if (magicIndex !== -1) {
                  needsClusterAlignment = false
                  clusterSearchRemainder = Buffer.alloc(0)
                  dataToWrite = Buffer.from(combined.subarray(magicIndex))
                } else {
                  clusterSearchRemainder = Buffer.from(
                    combined.subarray(Math.max(0, combined.length - 3))
                  )
                  dataToWrite = null
                }
              }

              if (dataToWrite && dataToWrite.length > 0) {
                if (!stream.write(dataToWrite)) {
                  isBackpressured = true
                  responseStream.pause()
                }
              }
            }

            const onEnd = () => {
              responseStream.removeListener('data', onData)
              responseStream.removeListener('error', onError)
              activeResponseStream = null
              resolve()
            }

            const onError = (err: Error) => {
              responseStream.removeListener('data', onData)
              responseStream.removeListener('end', onEnd)
              activeResponseStream = null
              if (isDestroyed || cancelSignal.aborted) resolve()
              else reject(err)
            }

            responseStream.once('end', onEnd)
            responseStream.once('error', onError)
            responseStream.on('data', onData)
          })

          if (!responseStream.destroyed) responseStream.destroy()

          const transferDuration = dataStartTime
            ? Date.now() - dataStartTime
            : Date.now() - fetchStartTime
          updateBandwidthEstimate(bytesThisChunk, transferDuration)

          chunkCount++
          cleanChunks++
          if (chunkCount <= 2) {
            targetSeconds = MIN_TARGET_SECONDS
          } else if (chunkCount <= 5) {
            targetSeconds = INITIAL_TARGET_SECONDS
          } else {
            const estimatedSecondsInChunk = bytesThisChunk / trackBytesPerSecond
            if (estimatedSecondsInChunk >= targetSeconds * 0.8) {
              targetSeconds = Math.min(targetSeconds + 2, MAX_TARGET_SECONDS)
            } else {
              targetSeconds = Math.max(targetSeconds - 2, MIN_TARGET_SECONDS)
            }
          }

          if (totalBytesReceived >= totalContentLength) {
            if (!stream.writableEnded) {
              stream.emit('finishBuffering')
              stream.end()
            }
            return
          }

          consecutiveResets = 0
          isBackpressured = false
        } catch (err) {
          if (isDestroyed || cancelSignal.aborted) return
          const error = err as Error & { code?: string }

          if (
            error.code === 'ECONNRESET' ||
            error.code === 'ERR_STREAM_DESTROYED'
          ) {
            bandwidthEstimate = Math.max(128_000, bandwidthEstimate * 0.7)
            cleanChunks = 0

            if (isBackpressured) {
              consecutiveResets = 0
              isBackpressured = false
              if (stream.writableLength > 0) await waitForDrainOrClose()
              continue
            }

            const retryDelay = Math.min(250 * 2 ** consecutiveResets, 1000)
            consecutiveResets++
            await sleep(retryDelay)

            if (consecutiveResets >= MAX_RETRIES) {
              consecutiveResets = 0
              const refreshed = await refreshUrl('multiple ECONNRESET on same URL')
              if (refreshed) continue
              cleanup(new Error('ECONNRESET: max URL refresh reached'))
              return
            }
            continue
          }

          if (error.message?.includes('403') || error.message?.includes('404')) {
            consecutiveClientFailures++
            if (totalBytesReceived === 0 && currentItag) failedItags.add(currentItag)
            const refreshed = await refreshUrl('mid-stream 403/404')
            if (refreshed) continue
            cleanup(new Error('mid-stream 403/404: max URL refresh reached'))
            return
          }

          const retryDelay = Math.min(
            RECOVER_BASE_DELAY_MS * 2 ** Math.max(0, refreshAttempts - 1),
            MAX_RETRY_DELAY_MS
          )
          cleanChunks = 0
          await sleep(retryDelay)
        }
      }
    }

    startStreaming().catch((err: Error) => {
      logger('error', 'YouTube', `Fatal streaming error: ${err.message}`)
      cleanup(err)
    })

    return { stream }
  }

  public async detectFfmpeg(): Promise<FfmpegInfo | null> {
    return await detectFfmpegBinary()
  }

  private async downloadTrack(
    track: TrackInfo,
    options: DownloadOptions,
    ffmpegInfo: FfmpegInfo | null
  ): Promise<DownloadedItemResult> {
    const emit = (ev: Omit<DownloadProgressEvent, 'trackTitle' | 'videoId'>) => {
      options.onProgress?.({
        ...ev,
        trackTitle: track.title,
        videoId: track.identifier
      })
    }

    let requestedMode = options.mode
    if (requestedMode === 'video' && !ffmpegInfo) {
      logger(
        'warn',
        'Downloader',
        'ffmpeg not found (checked FFMPEG_PATH, system PATH, and ffmpeg-static); falling back to progressive single-file mode.'
      )
      requestedMode = 'progressive'
    }

    emit({ phase: 'probing', detail: `Resolving streams (${requestedMode})...` })

    const maxHeight = parseQualityHeight(options.videoQuality)
    const selection: StreamSelectionSpec = {
      mode: requestedMode,
      targetKind:
        requestedMode === 'audio'
          ? 'audio'
          : requestedMode === 'progressive'
            ? 'progressive'
            : 'video',
      videoQuality: options.videoQuality,
      audioQuality: options.audioQuality,
      maxHeight,
      codec: options.codec,
      itag: options.itag
    }

    const mediaPlan = await this.getTrackMedia(
      track,
      selection,
      options.itag,
      false,
      options.clients
    )

    if (mediaPlan.loadType === 'error' || mediaPlan.exception) {
      throw new Error(mediaPlan.exception?.message || 'Failed to resolve track stream')
    }

    const activeClient = mediaPlan.client || mediaPlan.additionalData?.client || 'unknown'
    const protocol = mediaPlan.protocol || 'http'
    await mkdir(options.outDir, { recursive: true })

    const tempTag = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
    const tempFiles: string[] = []
    const registerTemp = (filePath: string): string => {
      tempFiles.push(filePath)
      this.activeTempFiles.add(filePath)
      return filePath
    }

    try {
      // Case A: HLS (live or VOD fallback)
      if (protocol === 'hls' && mediaPlan.url) {
        const isVideoMode = mediaPlan.mode !== 'audio'
        let capturedAudioRendition: string | null = null

        const ext = isVideoMode && ffmpegInfo ? 'mp4' : 'ts'
        const fileName = resolveFilenameTemplate(options.filenameTemplate, {
          title: track.title,
          id: track.identifier,
          author: track.author,
          quality: options.videoQuality,
          ext
        })
        const outPath = path.join(options.outDir, fileName)
        const mainPart = registerTemp(path.join(options.outDir, `.${fileName}.${tempTag}.main.part`))

        const mainRes = await this.loadStream(track, mediaPlan.url, 'hls', {
          ...mediaPlan.additionalData,
          mediaMode: isVideoMode ? 'video' : 'audio',
          maxHeight,
          onAudioRendition: isVideoMode
            ? (audioUri) => {
                capturedAudioRendition = audioUri
              }
            : undefined
        })
        if (!mainRes.stream) {
          throw new Error(mainRes.exception?.message || 'Failed to open HLS stream')
        }

        await pipeStreamToFile(mainRes.stream, mainPart, null, (bytes) => {
          emit({
            phase: capturedAudioRendition ? 'downloading-video' : 'downloading',
            bytesDownloaded: bytes,
            totalBytes: null,
            client: activeClient,
            protocol: 'hls',
            detail: 'HLS'
          })
        })

        if (isVideoMode && capturedAudioRendition && ffmpegInfo) {
          const audioPart = registerTemp(
            path.join(options.outDir, `.${fileName}.${tempTag}.audio.part`)
          )
          const audioRes = await this.loadStream(track, capturedAudioRendition, 'hls', {
            ...mediaPlan.additionalData,
            mediaMode: 'audio'
          })
          if (!audioRes.stream) {
            throw new Error(audioRes.exception?.message || 'Failed to open HLS audio rendition')
          }
          await pipeStreamToFile(audioRes.stream, audioPart, null, (bytes) => {
            emit({
              phase: 'downloading-audio',
              bytesDownloaded: bytes,
              totalBytes: null,
              client: activeClient,
              protocol: 'hls',
              detail: 'HLS audio rendition'
            })
          })

          emit({ phase: 'muxing', client: activeClient, protocol: 'hls', detail: 'ffmpeg -c copy' })
          await muxVideoAndAudio(ffmpegInfo.bin, mainPart, audioPart, outPath, 'mp4')
          const info = await stat(outPath)
          emit({ phase: 'done', detail: outPath })
          return {
            videoId: track.identifier,
            title: track.title,
            author: track.author,
            filePath: outPath,
            sizeBytes: info.size,
            client: activeClient,
            protocol: 'hls',
            mode: mediaPlan.mode,
            muxedWithFfmpeg: true,
            durationMs: track.length
          }
        }

        // Single-stream muxed HLS (.ts)
        if (isVideoMode && ffmpegInfo) {
          try {
            emit({ phase: 'muxing', client: activeClient, protocol: 'hls', detail: 'remux ts -> mp4' })
            await remuxToMp4(ffmpegInfo.bin, mainPart, outPath)
            const info = await stat(outPath)
            emit({ phase: 'done', detail: outPath })
            return {
              videoId: track.identifier,
              title: track.title,
              author: track.author,
              filePath: outPath,
              sizeBytes: info.size,
              client: activeClient,
              protocol: 'hls',
              mode: mediaPlan.mode,
              muxedWithFfmpeg: true,
              durationMs: track.length
            }
          } catch {
            // Fallback to raw .ts if copy remux failed
            const tsPath = outPath.replace(/\.mp4$/i, '.ts')
            await rename(mainPart, tsPath)
            const info = await stat(tsPath)
            emit({ phase: 'done', detail: tsPath })
            return {
              videoId: track.identifier,
              title: track.title,
              author: track.author,
              filePath: tsPath,
              sizeBytes: info.size,
              client: activeClient,
              protocol: 'hls',
              mode: mediaPlan.mode,
              muxedWithFfmpeg: false,
              durationMs: track.length
            }
          }
        }

        await rename(mainPart, outPath)
        const info = await stat(outPath)
        emit({ phase: 'done', detail: outPath })
        return {
          videoId: track.identifier,
          title: track.title,
          author: track.author,
          filePath: outPath,
          sizeBytes: info.size,
          client: activeClient,
          protocol: 'hls',
          mode: mediaPlan.mode,
          muxedWithFfmpeg: false,
          durationMs: track.length
        }
      }

      // Case B: Adaptive Video + Companion Audio (HTTP or SABR), muxed via ffmpeg
      if (mediaPlan.mode === 'video' && mediaPlan.video) {
        const videoComp = mediaPlan.video
        const audioComp = mediaPlan.audio

        if (!audioComp && !options.itag) {
          throw new Error('Adaptive video resolved without compatible audio stream')
        }
        if (audioComp && !ffmpegInfo) {
          throw new Error('ffmpeg is required to mux adaptive video + audio')
        }

        const useMp4 =
          isMp4Container(videoComp.mimeType, videoComp.itag) &&
          (!audioComp || isMp4Container(audioComp.mimeType, audioComp.itag))
        const containerExt: 'mp4' | 'mkv' = useMp4 ? 'mp4' : 'mkv'
        const fileName = resolveFilenameTemplate(options.filenameTemplate, {
          title: track.title,
          id: track.identifier,
          author: track.author,
          quality: videoComp.qualityLabel || options.videoQuality,
          ext: containerExt
        })
        const finalPath = path.join(options.outDir, fileName)
        const videoPart = registerTemp(
          path.join(options.outDir, `.${fileName}.${tempTag}.video.part`)
        )

        const videoSelection: StreamSelectionSpec = {
          ...selection,
          mode: 'video',
          targetKind: 'video',
          itag: videoComp.itag
        }

        const videoStreamRes = await this.loadStream(
          track,
          videoComp.url || mediaPlan.url || '',
          protocol,
          {
            ...mediaPlan.additionalData,
            itag: videoComp.itag,
            contentLength: videoComp.contentLength,
            mediaMode: 'video',
            refreshSelection: videoSelection,
            overrideClients: options.clients
          }
        )
        if (!videoStreamRes.stream) {
          throw new Error(videoStreamRes.exception?.message || 'Failed to open video stream')
        }

        await pipeStreamToFile(
          videoStreamRes.stream,
          videoPart,
          videoComp.contentLength,
          (bytes, total) => {
            emit({
              phase: 'downloading-video',
              bytesDownloaded: bytes,
              totalBytes: total,
              client: activeClient,
              protocol,
              itag: videoComp.itag,
              detail: videoComp.qualityLabel || `itag ${videoComp.itag}`
            })
          }
        )

        if (!audioComp) {
          // User explicitly requested a single video-only itag without companion audio
          await rename(videoPart, finalPath)
          const info = await stat(finalPath)
          emit({ phase: 'done', detail: finalPath })
          return {
            videoId: track.identifier,
            title: track.title,
            author: track.author,
            filePath: finalPath,
            sizeBytes: info.size,
            client: activeClient,
            protocol,
            mode: 'video',
            videoItag: videoComp.itag,
            muxedWithFfmpeg: false,
            durationMs: track.length
          }
        }

        const audioPart = registerTemp(
          path.join(options.outDir, `.${fileName}.${tempTag}.audio.part`)
        )
        const audioSelection: StreamSelectionSpec = {
          mode: 'audio',
          targetKind: 'audio',
          audioQuality: options.audioQuality,
          itag: audioComp.itag
        }

        const audioStreamRes = await this.loadStream(
          track,
          audioComp.url || mediaPlan.url || '',
          protocol,
          {
            ...mediaPlan.additionalData,
            itag: audioComp.itag,
            contentLength: audioComp.contentLength,
            mediaMode: 'audio',
            refreshSelection: audioSelection,
            overrideClients: options.clients
          }
        )
        if (!audioStreamRes.stream) {
          throw new Error(audioStreamRes.exception?.message || 'Failed to open companion audio stream')
        }

        await pipeStreamToFile(
          audioStreamRes.stream,
          audioPart,
          audioComp.contentLength,
          (bytes, total) => {
            emit({
              phase: 'downloading-audio',
              bytesDownloaded: bytes,
              totalBytes: total,
              client: activeClient,
              protocol,
              itag: audioComp.itag,
              detail: `itag ${audioComp.itag}`
            })
          }
        )

        emit({
          phase: 'muxing',
          client: activeClient,
          protocol,
          detail: `Muxing video=${videoComp.itag} + audio=${audioComp.itag} -> .${containerExt}`
        })
        await muxVideoAndAudio(ffmpegInfo!.bin, videoPart, audioPart, finalPath, containerExt)
        const finalStat = await stat(finalPath)
        emit({ phase: 'done', detail: finalPath })

        return {
          videoId: track.identifier,
          title: track.title,
          author: track.author,
          filePath: finalPath,
          sizeBytes: finalStat.size,
          client: activeClient,
          protocol,
          mode: 'video',
          videoItag: videoComp.itag,
          audioItag: audioComp.itag,
          muxedWithFfmpeg: true,
          durationMs: track.length
        }
      }

      // Case C: Single Stream (Audio-only or Progressive MP4)
      const isProg = mediaPlan.mode === 'progressive'
      const comp = isProg ? mediaPlan.progressive : mediaPlan.audio
      const resolvedItag = comp?.itag ?? mediaPlan.itag
      const ext = isProg
        ? 'mp4'
        : pickAudioExtension(mediaPlan.format, comp?.mimeType, resolvedItag)
      const qualityTag = isProg
        ? comp?.qualityLabel || (resolvedItag === 22 ? '720p' : '360p')
        : options.audioQuality
      const fileName = resolveFilenameTemplate(options.filenameTemplate, {
        title: track.title,
        id: track.identifier,
        author: track.author,
        quality: qualityTag,
        ext
      })
      const finalPath = path.join(options.outDir, fileName)
      const singlePart = registerTemp(
        path.join(options.outDir, `.${fileName}.${tempTag}.part`)
      )

      const singleSelection: StreamSelectionSpec = {
        mode: isProg ? 'progressive' : 'audio',
        targetKind: isProg ? 'progressive' : 'audio',
        audioQuality: options.audioQuality,
        videoQuality: options.videoQuality,
        itag: resolvedItag ?? null
      }

      const singleRes = await this.loadStream(
        track,
        comp?.url || mediaPlan.url || '',
        protocol,
        {
          ...mediaPlan.additionalData,
          itag: resolvedItag,
          contentLength: comp?.contentLength ?? mediaPlan.additionalData?.contentLength,
          mediaMode: isProg ? 'progressive' : 'audio',
          refreshSelection: singleSelection,
          overrideClients: options.clients
        }
      )
      if (!singleRes.stream) {
        throw new Error(singleRes.exception?.message || 'Failed to open download stream')
      }

      const expectedBytes =
        comp?.contentLength ?? mediaPlan.additionalData?.contentLength ?? null
      await pipeStreamToFile(singleRes.stream, singlePart, expectedBytes, (bytes, total) => {
        emit({
          phase: 'downloading',
          bytesDownloaded: bytes,
          totalBytes: total,
          client: activeClient,
          protocol,
          itag: resolvedItag,
          detail: qualityTag
        })
      })

      await rename(singlePart, finalPath)
      const info = await stat(finalPath)
      emit({ phase: 'done', detail: finalPath })

      return {
        videoId: track.identifier,
        title: track.title,
        author: track.author,
        filePath: finalPath,
        sizeBytes: info.size,
        client: activeClient,
        protocol,
        mode: isProg ? 'progressive' : 'audio',
        videoItag: isProg ? resolvedItag : undefined,
        audioItag: isProg ? undefined : resolvedItag,
        muxedWithFfmpeg: false,
        durationMs: track.length
      }
    } finally {
      for (const tmp of tempFiles) {
        this.activeTempFiles.delete(tmp)
        if (existsSync(tmp)) {
          await rm(tmp, { force: true }).catch(() => {})
        }
      }
    }
  }

  public async download(
    target: string,
    options: DownloadOptions
  ): Promise<DownloadedItemResult[]> {
    await this.setup()
    const { sourceResult, explicitWatchId } = await this.resolveInput(
      target,
      options.clients
    )

    if (sourceResult.loadType === 'error') {
      throw new Error(sourceResult.exception?.message || 'Failed to resolve target')
    }
    if (sourceResult.loadType === 'empty' || !sourceResult.data) {
      throw new Error(`No YouTube results found for "${target}"`)
    }

    const tracksToDownload: TrackInfo[] = []
    if (sourceResult.loadType === 'track') {
      tracksToDownload.push((sourceResult.data as TrackData).info)
    } else if (sourceResult.loadType === 'search') {
      const results = sourceResult.data as TrackData[]
      const first = results[0]
      if (!first) throw new Error('Search returned empty track list')
      tracksToDownload.push(first.info)
    } else if (sourceResult.loadType === 'playlist') {
      const playlist = sourceResult.data as PlaylistData
      if (!playlist.tracks.length) throw new Error('Playlist contains no tracks')

      const wantPlaylist =
        Boolean(options.playlist) ||
        Boolean(options.limit && options.limit > 1) ||
        !explicitWatchId

      if (wantPlaylist) {
        const cap =
          options.limit && options.limit > 0
            ? Math.min(options.limit, playlist.tracks.length)
            : playlist.tracks.length
        for (let i = 0; i < cap; i++) {
          const item = playlist.tracks[i]
          if (item) tracksToDownload.push(item.info)
        }
      } else {
        const idx = Math.max(
          0,
          Math.min(playlist.info.selectedTrack || 0, playlist.tracks.length - 1)
        )
        const selected = playlist.tracks[idx]
        if (!selected) throw new Error('Selected track missing from playlist')
        tracksToDownload.push(selected.info)
      }
    }

    const ffmpegInfo = await this.detectFfmpeg()
    const results: DownloadedItemResult[] = []

    for (const track of tracksToDownload) {
      options.onProgress?.({
        phase: 'resolving',
        trackTitle: track.title,
        videoId: track.identifier,
        detail: `${track.author}`
      })
      const downloaded = await this.downloadTrack(track, options, ffmpegInfo)
      results.push(downloaded)
    }

    return results
  }
}

export function buildTrackFromId(videoId: string): TrackData {
  const info: TrackInfo = {
    identifier: videoId,
    isSeekable: true,
    author: 'Unknown Artist',
    length: 0,
    isStream: false,
    position: 0,
    title: videoId,
    uri: `https://www.youtube.com/watch?v=${videoId}`,
    artworkUrl: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    isrc: null,
    sourceName: 'youtube'
  }
  return {
    encoded: encodeTrack({ ...info, details: [] } as TrackEncodeInput),
    info,
    pluginInfo: {}
  }
}
export { YouTubeDownloader as Ytora, YouTubeDownloader as YtoraDownloader }
