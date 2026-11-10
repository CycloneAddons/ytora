import { makeRequest } from '../network/httpClient.ts'
import {
  YOUTUBE_CONSTANTS,
  type AudioQualityPref,
  type FormatInventoryResult,
  type HttpProxyConfig,
  type HttpRequestResult,
  type ICachedPlayerScript,
  type ICipherManager,
  type IOAuth,
  type PlaylistData,
  type ProxySnapshot,
  type SourceResult,
  type StreamSelectionSpec,
  type TrackInfo,
  type YouTubeClientContext,
  type YouTubeContext,
  type YouTubePlayerResponse,
  type YouTubeRenderer,
  type YouTubeText
} from '../types/index.ts'
import { logger } from '../utils/logger.ts'
import {
  filterAudioTrackFormats,
  normalizePlayerFormats,
  parseContentLengthValue,
  parseQualityHeight,
  resolveFormatString,
  selectCompatibleAudioCandidates,
  selectProgressiveCandidates,
  selectVideoCandidates,
  summarizeFormat,
  toFormatEntries,
  type MediaExtractionResult,
  type NormalizedFormat,
  type ResolvedStreamComponent
} from './formatSelector.ts'
import {
  buildTrack,
  checkURLType,
  extractPlaylistSelection,
  fetchEmbedConfig,
  getItemValue,
  resolveSelectedTrackIndex,
  type YouTubeTrackData
} from './metadata.ts'

// ============================================================================
// Client Runtime & BaseClient
// ============================================================================

export interface ClientRuntime {
  options: {
    audioQuality: AudioQualityPref
    maxPlaylistLength: number
    targetItag?: number
    allowItag?: number[]
  }
  getProxy: (rotate?: boolean) => HttpProxyConfig | undefined
  reportProxyStatus: (
    proxy: ProxySnapshot | HttpProxyConfig | undefined,
    success: boolean,
    status: number,
    latency?: number
  ) => void
  getClient: (name: string) => BaseClient | undefined
}

export abstract class BaseClient {
  runtime: ClientRuntime
  name: string
  oauth: IOAuth | null

  constructor(runtime: ClientRuntime, name: string, oauth: IOAuth | null) {
    this.runtime = runtime
    this.name = name
    this.oauth = oauth
  }

  getProxy(_rotate = false): HttpProxyConfig | undefined {
    return this.runtime.getProxy(false)
  }

  abstract getClient(context: YouTubeContext): YouTubeClientContext

  requirePlayerScript(): boolean {
    return false
  }

  requiresOAuth(): boolean {
    return false
  }

  getApiEndpoint(): string {
    return 'https://youtubei.googleapis.com'
  }

  getPlayerParams(): string | null {
    return null
  }

  isEmbedded(): boolean {
    return false
  }

  async getAuthHeaders(): Promise<Record<string, string>> {
    return (await this.oauth?.getAuthHeaders()) ?? {}
  }

  async search(
    _query: string,
    _type: string,
    _context: YouTubeContext,
    _proxy?: HttpProxyConfig,
    _reportProxyStatus?: ClientRuntime['reportProxyStatus']
  ): Promise<SourceResult> {
    return { loadType: 'search', data: [] }
  }

  async _makePlayerRequest(
    videoId: string,
    context: YouTubeContext,
    headers: Record<string, string>,
    cipherManager: ICipherManager | null,
    proxy?: HttpProxyConfig
  ): Promise<HttpRequestResult> {
    const apiEndpoint = this.getApiEndpoint()
    const clientContext = this.getClient(context)
    const requestProxy = proxy || this.getProxy()
    const requestBody: Record<string, unknown> = {
      context: clientContext,
      videoId,
      contentCheckOk: true,
      attestationRequest: { omitBotguardData: true },
      racyCheckOk: true
    }

    const playerParams = this.getPlayerParams()
    if (playerParams) requestBody.params = playerParams

    if (this.isEmbedded()) {
      const embedConfig = await fetchEmbedConfig(videoId, requestProxy)
      if (embedConfig?.encryptedHostFlags) {
        if (
          clientContext.client.clientName === 'WEB_EMBEDDED_PLAYER' &&
          embedConfig.visitorData
        ) {
          clientContext.client.visitorData = embedConfig.visitorData
        }
        const playbackContext =
          (requestBody.playbackContext as Record<string, unknown> | undefined) ||
          {}
        playbackContext.contentPlaybackContext =
          (playbackContext.contentPlaybackContext as
            | Record<string, unknown>
            | undefined) || {}
        ;(
          playbackContext.contentPlaybackContext as Record<string, unknown>
        ).encryptedHostFlags = embedConfig.encryptedHostFlags
        requestBody.playbackContext = playbackContext
      }
    }

    if (this.requirePlayerScript() && cipherManager) {
      try {
        const playerScript = await cipherManager.getCachedPlayerScript()
        if (playerScript?.url) {
          const signatureTimestamp = await cipherManager.getTimestamp(
            playerScript.url
          )
          const playbackContext =
            (requestBody.playbackContext as
              | Record<string, unknown>
              | undefined) || {}
          playbackContext.contentPlaybackContext =
            (playbackContext.contentPlaybackContext as
              | Record<string, unknown>
              | undefined) || {}
          ;(
            playbackContext.contentPlaybackContext as Record<string, unknown>
          ).signatureTimestamp = signatureTimestamp
          requestBody.playbackContext = playbackContext
        }
      } catch (e: unknown) {
        logger(
          'warn',
          `youtube-${this.name}`,
          `Failed to get signature timestamp: ${e instanceof Error ? e.message : String(e)}`
        )
      }
    }

    const response: HttpRequestResult = await makeRequest(
      `${apiEndpoint}/youtubei/v1/player?prettyPrint=false`,
      {
        method: 'POST',
        headers: {
          'User-Agent': clientContext.client.userAgent,
          ...(clientContext.client.visitorData
            ? { 'X-Goog-Visitor-Id': clientContext.client.visitorData }
            : {}),
          ...(this.isEmbedded() ? { Referer: 'https://www.youtube.com' } : {}),
          ...headers
        },
        body: requestBody,
        disableBodyCompression: true,
        proxy: requestProxy
      }
    )

    if (response.statusCode !== 200) {
      const message = `Failed to get player data. Status: ${response.statusCode}`
      logger('error', `youtube-${this.name}`, message)
      return { ...response, error: message }
    }

    return response
  }

  async _makeNextRequest(
    videoId: string,
    context: YouTubeContext,
    headers: Record<string, string>,
    proxy?: HttpProxyConfig
  ): Promise<HttpRequestResult> {
    const apiEndpoint = this.getApiEndpoint()
    const clientCtx = this.getClient(context)
    return await makeRequest(`${apiEndpoint}/youtubei/v1/next?prettyPrint=false`, {
      method: 'POST',
      headers: {
        'User-Agent': clientCtx.client.userAgent,
        ...(clientCtx.client.visitorData
          ? { 'X-Goog-Visitor-Id': clientCtx.client.visitorData }
          : {}),
        ...headers
      },
      body: {
        context: clientCtx,
        videoId
      },
      disableBodyCompression: true,
      proxy: proxy || this.getProxy()
    })
  }

  async _handlePlayerResponse(
    playerResponseRaw: unknown,
    sourceName: string,
    videoId: string,
    _context?: YouTubeContext
  ): Promise<SourceResult> {
    if (!playerResponseRaw || typeof playerResponseRaw !== 'object') {
      logger(
        'error',
        `youtube-${this.name}`,
        `Null or invalid player response for ${videoId}`
      )
      return { loadType: 'empty', data: {} }
    }

    const playerResponse = playerResponseRaw as YouTubePlayerResponse

    if (playerResponse.error) {
      logger(
        'error',
        `youtube-${this.name}`,
        `API error for video/short ${videoId}: ${playerResponse.error.message}`
      )
      return {
        loadType: 'error',
        exception: {
          message: playerResponse.error.message,
          severity: 'fault',
          cause: 'Upstream'
        }
      }
    }

    const videoDetails = playerResponse.videoDetails
    const playabilityStatus = playerResponse.playabilityStatus?.status
    const micro = playerResponse.microformat as
      | { microformatDataRenderer?: { appName?: string } }
      | undefined

    if (
      playabilityStatus &&
      playabilityStatus !== 'OK' &&
      micro?.microformatDataRenderer?.appName !== 'YouTube Music'
    ) {
      const message =
        playerResponse.playabilityStatus?.reason || 'Video not playable.'
      logger(
        'warn',
        `youtube-${this.name}`,
        `Video/short ${videoId} not playable: ${message}`
      )
      return {
        loadType: 'error',
        exception: {
          message,
          severity: 'common',
          cause: 'UpstreamPlayability'
        }
      }
    }

    if (!videoDetails?.videoId) {
      logger(
        'error',
        `youtube-${this.name}`,
        `Missing videoDetails for ${videoId}`
      )
      return {
        loadType: 'error',
        exception: {
          message: 'No video details in response.',
          severity: 'fault',
          cause: 'NoVideoDetails'
        }
      }
    }

    const track = await buildTrack(
      videoDetails as YouTubeRenderer,
      sourceName,
      null,
      playerResponse as Record<string, unknown>
    )

    if (!track) {
      return {
        loadType: 'error',
        exception: {
          message: 'Failed to process video data.',
          severity: 'fault',
          cause: 'TrackBuildFailed'
        }
      }
    }

    return { loadType: 'track', data: track }
  }

  async _handlePlaylistResponse(
    playlistId: string,
    currentVideoId: string | null,
    playlistResponseRaw: unknown,
    sourceName: string,
    _context?: YouTubeContext,
    targetIndex?: number | null
  ): Promise<SourceResult> {
    if (!playlistResponseRaw || typeof playlistResponseRaw !== 'object') {
      return { loadType: 'empty', data: {} }
    }

    const playlistResponse = playlistResponseRaw as Record<string, unknown>

    if (playlistResponse.error) {
      const error = playlistResponse.error as Record<string, unknown>
      const errMsg =
        (error.message as string | undefined) || 'Failed to fetch playlist.'
      return {
        loadType: 'error',
        exception: { message: errMsg, severity: 'common', cause: 'Upstream' }
      }
    }

    const contentsRoot =
      ((playlistResponse.contents as Record<string, unknown> | undefined)
        ?.singleColumnWatchNextResults as
        | Record<string, unknown>
        | undefined) ||
      ((playlistResponse.contents as Record<string, unknown> | undefined)
        ?.singleColumnMusicWatchNextResultsRenderer as
        | Record<string, unknown>
        | undefined)

    let playlistContent: unknown[] | null = null
    const playlist = contentsRoot?.playlist as
      | Record<string, unknown>
      | undefined
    const plData = playlist?.playlist as Record<string, unknown> | undefined

    if (plData?.contents) {
      playlistContent = plData.contents as unknown[]
    } else {
      const tabbedRenderer = contentsRoot?.tabbedRenderer as
        | Record<string, unknown>
        | undefined
      const watchNext = tabbedRenderer?.watchNextTabbedResultsRenderer as
        | Record<string, unknown>
        | undefined
      const tabs = watchNext?.tabs as Record<string, unknown>[] | undefined
      const tabRenderer = tabs?.[0]?.tabRenderer as
        | Record<string, unknown>
        | undefined
      const musicQueue = tabRenderer?.content as
        | Record<string, unknown>
        | undefined
      const mqRenderer = musicQueue?.musicQueueRenderer as
        | Record<string, unknown>
        | undefined

      if (mqRenderer) {
        const plPanel = mqRenderer.content as
          | Record<string, unknown>
          | undefined
        const panelRenderer = plPanel?.playlistPanelRenderer as
          | Record<string, unknown>
          | undefined
        playlistContent =
          (panelRenderer?.contents as unknown[] | undefined) ||
          (mqRenderer.contents as unknown[] | undefined) ||
          null
      }
    }

    if (!playlistContent || playlistContent.length === 0) {
      return { loadType: 'empty', data: {} }
    }

    const tracks: YouTubeTrackData[] = []
    const maxLength = this.runtime.options.maxPlaylistLength || 100

    if (sourceName === 'ytmusic') {
      playlistContent = playlistContent.filter((item) =>
        getItemValue(item, ['playlistPanelVideoRenderer.videoId'])
      )
    }

    let continuation = getItemValue<string>(playlistResponse, [
      'contents.singleColumnMusicWatchNextResultsRenderer.tabbedRenderer.watchNextTabbedResultsRenderer.tabs.0.tabRenderer.content.musicQueueRenderer.content.playlistPanelRenderer.continuations.0.nextContinuationData.continuation'
    ])
    const seenContinuations = new Set<string>()

    while (
      sourceName === 'ytmusic' &&
      _context &&
      continuation &&
      !seenContinuations.has(continuation) &&
      playlistContent.length < maxLength
    ) {
      seenContinuations.add(continuation)
      const client = this.getClient(_context)
      const { body, statusCode } = await makeRequest(
        'https://music.youtube.com/youtubei/v1/next',
        {
          method: 'POST',
          headers: {
            'User-Agent': client.client.userAgent,
            'X-Goog-Api-Format-Version': '2'
          },
          body: { context: client, continuation },
          disableBodyCompression: true,
          proxy: this.getProxy()
        }
      )
      if (statusCode !== 200 || !body) break
      const page = getItemValue<Record<string, unknown>>(body, [
        'continuationContents.playlistPanelContinuation'
      ])
      const items = (page?.contents as unknown[] | undefined)?.filter((item) =>
        getItemValue(item, ['playlistPanelVideoRenderer.videoId'])
      )
      if (!items?.length) break
      playlistContent.push(
        ...items.slice(0, maxLength - playlistContent.length)
      )
      continuation = getItemValue<string>(page, [
        'continuations.0.nextContinuationData.continuation'
      ])
    }

    for (let i = 0; i < Math.min(playlistContent.length, maxLength); i++) {
      const item = playlistContent[i] as YouTubeRenderer
      try {
        const track = await buildTrack(item, sourceName || 'youtube')
        if (track) tracks.push(track)
      } catch (err) {
        logger(
          'warn',
          `youtube-${this.name}`,
          `Failed to build track: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }

    if (tracks.length === 0) return { loadType: 'empty', data: {} }

    const selectedTrack = resolveSelectedTrackIndex(
      tracks,
      currentVideoId,
      targetIndex
    )

    let playlistTitle = 'Unknown Playlist'
    if (plData?.title) {
      playlistTitle = plData.title as string
    } else {
      const tabbedRenderer = contentsRoot?.tabbedRenderer as
        | Record<string, unknown>
        | undefined
      const watchNext = tabbedRenderer?.watchNextTabbedResultsRenderer as
        | Record<string, unknown>
        | undefined
      const tabs = watchNext?.tabs as Record<string, unknown>[] | undefined
      const tabRenderer = tabs?.[0]?.tabRenderer as
        | Record<string, unknown>
        | undefined
      const musicQueue = tabRenderer?.content as
        | Record<string, unknown>
        | undefined
      const mqRenderer = musicQueue?.musicQueueRenderer as
        | Record<string, unknown>
        | undefined
      const headerRoot = mqRenderer?.header as
        | Record<string, unknown>
        | undefined
      const mqHeader = headerRoot?.musicQueueHeaderRenderer as
        | Record<string, unknown>
        | undefined
      const subtitle = mqHeader?.subtitle as YouTubeText | undefined
      if (subtitle?.runs?.[0]?.text) playlistTitle = subtitle.runs[0].text
    }

    return {
      loadType: 'playlist',
      data: {
        info: { name: playlistTitle, selectedTrack },
        pluginInfo: {},
        tracks
      } satisfies PlaylistData
    }
  }

  async _handleBrowsePlaylistResponse(
    playlistId: string,
    browseResponseRaw: unknown,
    sourceName: string,
    _context?: YouTubeContext,
    currentVideoId?: string | null,
    targetIndex?: number | null
  ): Promise<SourceResult> {
    if (!browseResponseRaw || typeof browseResponseRaw !== 'object') {
      return { loadType: 'empty', data: {} }
    }

    const browseResponse = browseResponseRaw as Record<string, unknown>
    if (browseResponse.error) {
      const error = browseResponse.error as Record<string, unknown>
      const errMsg =
        (error.message as string | undefined) || 'Failed to browse playlist.'
      return {
        loadType: 'error',
        exception: { message: errMsg, severity: 'common', cause: 'Upstream' }
      }
    }

    const contents = browseResponse.contents as
      | Record<string, unknown>
      | undefined
    const singleColumn = contents?.singleColumnBrowseResultsRenderer as
      | Record<string, unknown>
      | undefined
    const tabs = singleColumn?.tabs as Record<string, unknown>[] | undefined
    const tabRenderer = tabs?.[0]?.tabRenderer as
      | Record<string, unknown>
      | undefined
    const tabContent = tabRenderer?.content as
      | Record<string, unknown>
      | undefined
    const sectionList = tabContent?.sectionListRenderer as
      | Record<string, unknown>
      | undefined
    const sectionContents = sectionList?.contents as
      | Record<string, unknown>[]
      | undefined
    const section = sectionContents?.[0]
    const shelf =
      (section?.musicPlaylistShelfRenderer as
        | Record<string, unknown>
        | undefined) ||
      (section?.playlistVideoListRenderer as
        | Record<string, unknown>
        | undefined)

    const shelfContentsCheck = shelf?.contents as unknown[] | undefined
    if (!shelf || !shelfContentsCheck || shelfContentsCheck.length === 0) {
      return { loadType: 'empty', data: {} }
    }

    const maxLength = this.runtime.options.maxPlaylistLength || 100
    const shelfContents = shelfContentsCheck.filter(
      (item) => !getItemValue(item, ['messageRenderer'])
    )
    let continuation = getItemValue<string>(shelf, [
      'continuations.0.nextContinuationData.continuation'
    ])
    const seenContinuations = new Set<string>()

    while (
      this.name === 'ANDROID' &&
      _context &&
      continuation &&
      !seenContinuations.has(continuation) &&
      shelfContents.length < maxLength
    ) {
      seenContinuations.add(continuation)
      const client = this.getClient(_context)
      const { body, statusCode } = await makeRequest(
        `${this.getApiEndpoint()}/youtubei/v1/browse`,
        {
          method: 'POST',
          headers: {
            'User-Agent': client.client.userAgent,
            'X-YouTube-Client-Name': '3',
            'X-YouTube-Client-Version': client.client.clientVersion ?? ''
          },
          body: { context: client, continuation },
          disableBodyCompression: true,
          proxy: this.getProxy()
        }
      )
      if (statusCode !== 200 || !body) break
      const page = getItemValue<Record<string, unknown>>(body, [
        'continuationContents.playlistVideoListContinuation'
      ])
      const items = page?.contents as unknown[] | undefined
      if (!items?.length) break
      shelfContents.push(...items.slice(0, maxLength - shelfContents.length))
      continuation = getItemValue<string>(page, [
        'continuations.0.nextContinuationData.continuation'
      ])
    }

    const tracks: YouTubeTrackData[] = []
    for (let i = 0; i < Math.min(shelfContents.length, maxLength); i++) {
      const item = shelfContents[i] as YouTubeRenderer
      try {
        const track = await buildTrack(
          item,
          sourceName || 'ytmusic',
          sourceName,
          browseResponse
        )
        if (track) tracks.push(track)
      } catch (err) {
        logger(
          'warn',
          `youtube-${this.name}`,
          `Failed to build track: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }

    if (tracks.length === 0) return { loadType: 'empty', data: {} }

    let playlistTitle = 'Unknown Playlist'
    const headerRoot = browseResponse.header as
      | Record<string, unknown>
      | undefined
    const pageHeader = headerRoot?.pageHeaderRenderer as
      | Record<string, unknown>
      | undefined
    const musicDetail = headerRoot?.musicDetailHeaderRenderer as
      | Record<string, unknown>
      | undefined
    const musicTitle = musicDetail?.title as YouTubeText | undefined

    if (typeof pageHeader?.pageTitle === 'string') {
      playlistTitle = pageHeader.pageTitle
    } else if (musicTitle?.runs?.[0]?.text) {
      playlistTitle = musicTitle.runs[0].text
    } else {
      const editableHeaderRoot =
        headerRoot?.musicEditablePlaylistDetailHeaderRenderer as
          | Record<string, unknown>
          | undefined
      const editableHeader = editableHeaderRoot?.header as
        | Record<string, unknown>
        | undefined
      const editableMusicDetail = editableHeader?.musicDetailHeaderRenderer as
        | Record<string, unknown>
        | undefined
      const editableMusicTitle = editableMusicDetail?.title as
        | YouTubeText
        | undefined
      if (editableMusicTitle?.runs?.[0]?.text) {
        playlistTitle = editableMusicTitle.runs[0].text
      }
    }

    const selectedTrack = resolveSelectedTrackIndex(
      tracks,
      currentVideoId,
      targetIndex
    )

    return {
      loadType: 'playlist',
      data: {
        info: { name: playlistTitle, selectedTrack },
        pluginInfo: {},
        tracks
      } satisfies PlaylistData
    }
  }

  protected async _attemptCipherResolution(
    formatToResolve: NormalizedFormat,
    playerScript: ICachedPlayerScript | null,
    context: YouTubeContext,
    cipherManager: ICipherManager | null
  ): Promise<ResolvedStreamComponent | null> {
    let currentStreamUrl = formatToResolve.url
    let currentEncryptedSignature: string | null = null
    let currentNParam: string | null = null
    let currentSignatureKey: string | null = null

    const cipherStr = formatToResolve.signatureCipher || formatToResolve.cipher
    if (cipherStr) {
      const cipher = new URLSearchParams(cipherStr)
      currentStreamUrl = cipher.get('url') || undefined
      currentEncryptedSignature = cipher.get('s')
      currentSignatureKey = cipher.get('sp') || 'sig'
      currentNParam = cipher.get('n')
    }

    let resolvedUrl: string | undefined
    if (!playerScript) {
      if (currentEncryptedSignature || !currentStreamUrl) return null
      resolvedUrl = currentStreamUrl
    } else if (currentStreamUrl && cipherManager) {
      try {
        resolvedUrl = await cipherManager.resolveUrl(
          currentStreamUrl,
          currentEncryptedSignature,
          currentNParam,
          currentSignatureKey,
          playerScript,
          context
        )
      } catch (e: unknown) {
        logger(
          'warn',
          `youtube-${this.name}`,
          `Failed to resolve format URL for itag ${formatToResolve.itag}: ${e instanceof Error ? e.message : String(e)}`
        )
        return null
      }
    }

    if (!resolvedUrl) return null

    return {
      itag: formatToResolve.itag,
      url: resolvedUrl,
      mimeType: formatToResolve.mimeType,
      format: resolveFormatString(formatToResolve.mimeType),
      qualityLabel: formatToResolve.qualityLabel || null,
      width: typeof formatToResolve.width === 'number' ? formatToResolve.width : null,
      height:
        typeof formatToResolve.height === 'number' ? formatToResolve.height : null,
      fps: typeof formatToResolve.fps === 'number' ? formatToResolve.fps : null,
      bitrate:
        typeof formatToResolve.bitrate === 'number'
          ? formatToResolve.bitrate
          : null,
      contentLength: parseContentLengthValue(formatToResolve.contentLength)
    }
  }

  async _extractStreamData(
    playerResponseRaw: unknown,
    decodedTrack: TrackInfo,
    context: YouTubeContext,
    cipherManager: ICipherManager | null,
    itag?: number | string,
    selection?: StreamSelectionSpec
  ): Promise<MediaExtractionResult> {
    const playerResponse = playerResponseRaw as YouTubePlayerResponse
    const streamingData = playerResponse.streamingData

    if (!streamingData) {
      const reason =
        playerResponse.playabilityStatus?.reason || 'No streaming data available.'
      logger(
        'error',
        `youtube-${this.name}`,
        `No streaming data found for ${decodedTrack.identifier}: ${reason}`
      )
      return {
        loadType: 'error',
        exception: {
          message: reason,
          severity: 'common',
          cause: 'UpstreamNoStream'
        }
      }
    }

    const normalized = normalizePlayerFormats(
      streamingData as Record<string, unknown>
    )
    const { filtered: formats, missing } = filterAudioTrackFormats(
      normalized,
      selection?.audioTrackId ?? decodedTrack.audioTrackId
    )
    if (missing) {
      return {
        loadType: 'error',
        exception: {
          message: 'Requested audio track not available in this client.',
          severity: 'common',
          cause: 'AudioTrackNotFound'
        }
      }
    }

    const playerScript =
      this.requirePlayerScript() && cipherManager
        ? await cipherManager.getCachedPlayerScript()
        : null

    if (this.requirePlayerScript() && !playerScript) {
      return {
        loadType: 'error',
        exception: {
          message: 'Failed to obtain player script for deciphering.',
          severity: 'fault',
          cause: 'Internal'
        }
      }
    }

    const mode = selection?.mode ?? 'audio'
    const hlsUrl = (streamingData.hlsManifestUrl as string | undefined) || null
    const formatEntries = toFormatEntries(formats)

    // ------------------------------------------------------------------------
    // Video / Progressive / Single-Itag Selection Mode
    // ------------------------------------------------------------------------
    if (mode === 'progressive' || (mode === 'video' && selection?.targetKind === 'progressive')) {
      const explicitItag = itag ? Number(itag) : selection?.itag ?? null
      const candidates = explicitItag
        ? formats.filter((f) => f.itag === explicitItag)
        : selectProgressiveCandidates(
            formats,
            selection?.maxHeight ?? parseQualityHeight(selection?.videoQuality)
          )

      for (const fmt of candidates) {
        const resolved = await this._attemptCipherResolution(
          fmt,
          playerScript,
          context,
          cipherManager
        )
        if (resolved?.url && !decodedTrack.isStream) {
          return {
            protocol: 'http',
            mode: 'progressive',
            url: resolved.url,
            format: resolved.format,
            itag: resolved.itag,
            contentLength: resolved.contentLength,
            hlsUrl,
            formats: formatEntries,
            progressive: resolved
          }
        }
      }

      if (hlsUrl) {
        return {
          protocol: null,
          mode: 'progressive',
          hlsUrl,
          formats: formatEntries
        }
      }

      return {
        loadType: 'error',
        exception: {
          message: 'No progressive video stream found.',
          severity: 'common',
          cause: 'Upstream'
        },
        formats: formatEntries
      }
    }

    if (mode === 'video') {
      const explicitItag = itag ? Number(itag) : selection?.itag ?? null
      if (explicitItag) {
        const explicitFmt = formats.find((f) => f.itag === explicitItag)
        if (!explicitFmt) {
          return {
            loadType: 'error',
            exception: {
              message: `Requested itag ${explicitItag} not available in client ${this.name}.`,
              severity: 'common',
              cause: 'Upstream'
            },
            formats: formatEntries
          }
        }

        const resolvedExplicit = await this._attemptCipherResolution(
          explicitFmt,
          playerScript,
          context,
          cipherManager
        )
        if (!resolvedExplicit?.url) {
          return {
            loadType: 'error',
            exception: {
              message: `Failed to resolve URL for itag ${explicitItag}.`,
              severity: 'common',
              cause: 'Upstream'
            },
            formats: formatEntries
          }
        }

        const summary = summarizeFormat(explicitFmt)
        if (summary.kind === 'progressive') {
          return {
            protocol: 'http',
            mode: 'progressive',
            url: resolvedExplicit.url,
            format: resolvedExplicit.format,
            itag: resolvedExplicit.itag,
            contentLength: resolvedExplicit.contentLength,
            hlsUrl,
            formats: formatEntries,
            progressive: resolvedExplicit
          }
        }
        if (summary.kind === 'audio-only') {
          return {
            protocol: 'http',
            mode: 'audio',
            url: resolvedExplicit.url,
            format: resolvedExplicit.format,
            itag: resolvedExplicit.itag,
            contentLength: resolvedExplicit.contentLength,
            hlsUrl,
            formats: formatEntries,
            audio: resolvedExplicit
          }
        }

        // Video-only explicit itag: resolve companion audio too if targetKind isn't strictly single audio
        const audioCandidates = selectCompatibleAudioCandidates(
          formats,
          explicitFmt.mimeType,
          selection?.audioQuality ?? this.runtime.options.audioQuality
        )
        let resolvedAudio: ResolvedStreamComponent | undefined
        for (const aFmt of audioCandidates) {
          const aRes = await this._attemptCipherResolution(
            aFmt,
            playerScript,
            context,
            cipherManager
          )
          if (aRes?.url) {
            resolvedAudio = aRes
            break
          }
        }

        return {
          protocol: 'http',
          mode: 'video',
          url: resolvedExplicit.url,
          format: resolvedExplicit.format,
          itag: resolvedExplicit.itag,
          contentLength: resolvedExplicit.contentLength,
          hlsUrl,
          formats: formatEntries,
          video: resolvedExplicit,
          audio: resolvedAudio
        }
      }

      // Adaptive best/capped video + compatible companion audio
      const videoCandidates = selectVideoCandidates(
        formats,
        selection ?? { mode: 'video', targetKind: 'video' }
      )
      let resolvedVideo: ResolvedStreamComponent | null = null
      let matchedVideoRaw: NormalizedFormat | null = null

      for (const vFmt of videoCandidates) {
        const res = await this._attemptCipherResolution(
          vFmt,
          playerScript,
          context,
          cipherManager
        )
        if (res?.url && !decodedTrack.isStream) {
          resolvedVideo = res
          matchedVideoRaw = vFmt
          break
        }
      }

      if (resolvedVideo && matchedVideoRaw) {
        const audioCandidates = selectCompatibleAudioCandidates(
          formats,
          matchedVideoRaw.mimeType,
          selection?.audioQuality ?? this.runtime.options.audioQuality
        )
        let resolvedAudio: ResolvedStreamComponent | undefined
        for (const aFmt of audioCandidates) {
          const aRes = await this._attemptCipherResolution(
            aFmt,
            playerScript,
            context,
            cipherManager
          )
          if (aRes?.url) {
            resolvedAudio = aRes
            break
          }
        }

        if (resolvedAudio) {
          return {
            protocol: 'http',
            mode: 'video',
            url: resolvedVideo.url,
            format: resolvedVideo.format,
            itag: resolvedVideo.itag,
            contentLength: resolvedVideo.contentLength,
            hlsUrl,
            formats: formatEntries,
            video: resolvedVideo,
            audio: resolvedAudio
          }
        }
      }

      // Fallback to progressive when adaptive pair cannot be completed (only if codec == 'any')
      if ((selection?.codec ?? 'any') === 'any') {
        const progCandidates = selectProgressiveCandidates(
          formats,
          selection?.maxHeight ?? parseQualityHeight(selection?.videoQuality)
        )
        for (const pFmt of progCandidates) {
          const pRes = await this._attemptCipherResolution(
            pFmt,
            playerScript,
            context,
            cipherManager
          )
          if (pRes?.url && !decodedTrack.isStream) {
            return {
              protocol: 'http',
              mode: 'progressive',
              url: pRes.url,
              format: pRes.format,
              itag: pRes.itag,
              contentLength: pRes.contentLength,
              hlsUrl,
              formats: formatEntries,
              progressive: pRes
            }
          }
        }
      }

      if (hlsUrl) {
        return {
          protocol: null,
          mode: 'video',
          hlsUrl,
          formats: formatEntries
        }
      }

      return {
        loadType: 'error',
        exception: {
          message: 'No suitable video stream found in this client.',
          severity: 'common',
          cause: 'Upstream'
        },
        formats: formatEntries
      }
    }

    // ------------------------------------------------------------------------
    // Audio Stream Selection Mode (_extractStreamData)
    // ------------------------------------------------------------------------
    const targetItag = selection?.itag ?? this.runtime.options.targetItag
    const allowItag = selection?.allowItag ?? this.runtime.options.allowItag ?? []
    let targetItags: number[] = []

    if (itag) {
      targetItags = [Number(itag)]
    } else if (targetItag) {
      targetItags = [Number(targetItag)]
    } else {
      const qualityPriority = this._getQualityPriority()
      const audioQuality =
        selection?.audioQuality ?? this.runtime.options.audioQuality ?? 'high'
      targetItags = qualityPriority[audioQuality] || []
      if (allowItag.length > 0) {
        targetItags = [...new Set([...targetItags, ...allowItag])]
      }
    }

    let resolvedFormat: ResolvedStreamComponent | null = null
    logger(
      'debug',
      `youtube-${this.name}`,
      `Initial target itags: ${targetItags.join(', ')}`
    )

    const audioCandidates = formats
      .filter(
        (format) =>
          targetItags.includes(format.itag) &&
          (format.mimeType?.startsWith('audio/') ||
            Boolean(itag && format.itag === Number(itag)))
      )
      .sort((a, b) => targetItags.indexOf(a.itag) - targetItags.indexOf(b.itag))

    for (const format of audioCandidates) {
      resolvedFormat = await this._attemptCipherResolution(
        format,
        playerScript,
        context,
        cipherManager
      )
      if (resolvedFormat) break
    }

    if (!resolvedFormat) {
      logger(
        'debug',
        `youtube-${this.name}`,
        'Audio-only candidates failed. Attempting fallback to itag 18.'
      )
      const itag18 = formats.find((format) => format.itag === 18)
      if (itag18) {
        resolvedFormat = await this._attemptCipherResolution(
          itag18,
          playerScript,
          context,
          cipherManager
        )
      }
    }

    if (!resolvedFormat && !hlsUrl) {
      return {
        loadType: 'error',
        exception: {
          message: 'No suitable audio stream found after all fallbacks.',
          severity: 'common',
          cause: 'Upstream'
        },
        formats: formatEntries
      }
    }

    const directUrl =
      resolvedFormat?.url && !decodedTrack.isStream
        ? resolvedFormat.url
        : undefined

    if (!directUrl && !hlsUrl) {
      return {
        loadType: 'error',
        exception: {
          message: 'No suitable audio stream found.',
          severity: 'common',
          cause: 'Upstream'
        },
        formats: formatEntries
      }
    }

    return {
      mode: 'audio',
      url: directUrl,
      protocol: directUrl ? 'http' : null,
      format: resolveFormatString(resolvedFormat?.mimeType, decodedTrack.isStream),
      itag: resolvedFormat?.itag,
      contentLength: resolvedFormat?.contentLength ?? null,
      hlsUrl,
      formats: formatEntries,
      audio: resolvedFormat ?? undefined
    }
  }

  _getQualityPriority(): Record<string, number[]> {
    return {
      high: [251, 250, 140],
      medium: [250, 140],
      low: [249, 250, 140],
      lowest: [249, 139]
    }
  }

  async resolve(
    url: string,
    _type: string,
    context: YouTubeContext,
    cipherManager: ICipherManager | null,
    _reportProxyStatus?: ClientRuntime['reportProxyStatus']
  ): Promise<SourceResult> {
    const sourceName = 'youtube'
    const urlType = checkURLType(url, 'youtube')
    const apiEndpoint = this.getApiEndpoint()

    switch (urlType) {
      case YOUTUBE_CONSTANTS.VIDEO:
      case YOUTUBE_CONSTANTS.SHORTS: {
        const videoIdMatch = url.match(/(?:v=|shorts\/|youtu\.be\/)([^&?]+)/)
        if (!videoIdMatch?.[1]) {
          return {
            loadType: 'error',
            exception: {
              message: 'Invalid video URL.',
              severity: 'common',
              cause: 'Input'
            }
          }
        }
        const videoId = videoIdMatch[1]
        const headers = await this.getAuthHeaders()
        const playerResult = await this._makePlayerRequest(
          videoId,
          context,
          headers,
          cipherManager
        )

        if (playerResult.statusCode !== 200 || !playerResult.body) {
          return {
            loadType: 'error',
            exception: {
              message: `Failed to load video/short player data. Status: ${playerResult.statusCode}`,
              severity: 'common',
              cause: 'Upstream'
            }
          }
        }

        return await this._handlePlayerResponse(
          playerResult.body,
          sourceName,
          videoId,
          context
        )
      }

      case YOUTUBE_CONSTANTS.PLAYLIST: {
        const {
          playlistId,
          videoId: currentVideoId,
          targetIndex
        } = extractPlaylistSelection(url)
        if (!playlistId) {
          return {
            loadType: 'error',
            exception: {
              message: 'Invalid playlist URL.',
              severity: 'common',
              cause: 'Input'
            }
          }
        }

        const headers = await this.getAuthHeaders()
        const requestBody: Record<string, unknown> = {
          context: this.getClient(context),
          playlistId,
          contentCheckOk: true,
          racyCheckOk: true
        }
        if (currentVideoId) requestBody.videoId = currentVideoId

        const playlistResponse = await makeRequest(
          `${apiEndpoint}/youtubei/v1/next`,
          {
            headers: {
              'User-Agent': this.getClient(context).client.userAgent,
              ...headers
            },
            body: requestBody,
            method: 'POST',
            disableBodyCompression: true,
            proxy: this.getProxy()
          }
        )

        const plBody = playlistResponse.body as
          | Record<string, unknown>
          | undefined
        if (playlistResponse.statusCode !== 200 || plBody?.error) {
          const error = plBody?.error as Record<string, unknown> | undefined
          const errMsg =
            (error?.message as string | undefined) ||
            `Failed to fetch playlist. Status: ${playlistResponse.statusCode}`
          return {
            loadType: 'error',
            exception: {
              message: errMsg,
              severity: 'common',
              cause: 'Upstream'
            }
          }
        }

        return await this._handlePlaylistResponse(
          playlistId,
          currentVideoId,
          plBody ?? {},
          sourceName,
          context,
          targetIndex
        )
      }

      default:
        return { loadType: 'empty', data: {} }
    }
  }

  async getTrackUrl(
    decodedTrack: TrackInfo,
    context: YouTubeContext,
    cipherManager: ICipherManager | null,
    itag?: number | string,
    proxy?: HttpProxyConfig,
    selection?: StreamSelectionSpec
  ): Promise<MediaExtractionResult> {
    const headers = await this.getAuthHeaders()
    const playerResult = await this._makePlayerRequest(
      decodedTrack.identifier,
      context,
      headers,
      cipherManager,
      proxy
    )

    if (playerResult.statusCode !== 200 || !playerResult.body) {
      return {
        loadType: 'error',
        exception: {
          message: `Failed to get player data for stream. Status: ${playerResult.statusCode}`,
          severity: 'common',
          cause: 'Upstream',
          status: playerResult.statusCode
        }
      }
    }

    return await this._extractStreamData(
      playerResult.body,
      decodedTrack,
      context,
      cipherManager,
      itag,
      selection
    )
  }

  async getFormatInventory(
    decodedTrack: TrackInfo,
    context: YouTubeContext,
    cipherManager: ICipherManager | null,
    proxy?: HttpProxyConfig
  ): Promise<FormatInventoryResult | { error: string }> {
    const headers = await this.getAuthHeaders()
    const playerResult = await this._makePlayerRequest(
      decodedTrack.identifier,
      context,
      headers,
      cipherManager,
      proxy
    )

    if (playerResult.statusCode !== 200 || !playerResult.body) {
      return {
        error: `Player request failed with status ${playerResult.statusCode}`
      }
    }

    const player = playerResult.body as YouTubePlayerResponse
    if (
      player.playabilityStatus?.status &&
      player.playabilityStatus.status !== 'OK'
    ) {
      return {
        error: player.playabilityStatus.reason || player.playabilityStatus.status
      }
    }

    const streamingData = (player.streamingData ||
      (player as Record<string, unknown>).streaming_data) as
      | Record<string, unknown>
      | undefined
    if (!streamingData) {
      return { error: 'No streamingData in player response' }
    }

    const normalized = normalizePlayerFormats(streamingData)
    const serverAbrUrl =
      streamingData.serverAbrStreamingUrl ||
      streamingData.server_abr_streaming_url
    const hlsUrl = (streamingData.hlsManifestUrl as string | undefined) || null
    const hasHttpStreams = normalized.some((f) =>
      Boolean(f.url || f.signatureCipher || f.cipher)
    )

    return {
      client: this.name,
      protocol:
        serverAbrUrl && !hasHttpStreams
          ? 'sabr'
          : hlsUrl && normalized.length === 0
            ? 'hls'
            : 'http',
      videoId: decodedTrack.identifier,
      title: player.videoDetails?.title || decodedTrack.title,
      author: player.videoDetails?.author || decodedTrack.author,
      durationMs:
        (Number(player.videoDetails?.lengthSeconds || 0) || 0) * 1000 ||
        decodedTrack.length,
      hlsUrl,
      formats: normalized.map((f) => summarizeFormat(f))
    }
  }

  async getVisitorData(): Promise<string | null> {
    try {
      const response = await makeRequest('https://www.youtube.com', {
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        proxy: this.getProxy()
      })

      if (response.statusCode !== 200 || !response.body) return null
      const body = String(response.body)
      const match = body.match(/ytcfg\.set\((\{.*?\})\);/)
      if (match?.[1]) {
        try {
          const ytcfg = JSON.parse(match[1]) as { VISITOR_DATA?: string }
          if (ytcfg.VISITOR_DATA) return ytcfg.VISITOR_DATA
        } catch {
          // fallback regex
        }
      }
      return body.match(/"visitorData":"([^"]+)"/)?.[1] || null
    } catch {
      return null
    }
  }
}
