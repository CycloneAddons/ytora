import { makeRequest } from '../network/httpClient.ts'
import {
  YOUTUBE_CONSTANTS,
  type HttpProxyConfig,
  type ICipherManager,
  type IOAuth,
  type SourceResult,
  type StreamSelectionSpec,
  type TrackData,
  type TrackInfo,
  type YouTubeClientContext,
  type YouTubeContext,
  type YouTubeRenderer
} from '../types/index.ts'
import { BaseClient, type ClientRuntime } from './baseClient.ts'
import {
  normalizePlayerFormats,
  toFormatEntries,
  type MediaExtractionResult
} from './formatSelector.ts'
import {
  buildTrack,
  checkURLType,
  extractPlaylistSelection
} from './metadata.ts'

export class VisionOs extends BaseClient {
  constructor(runtime: ClientRuntime, oauth: IOAuth | null) {
    super(runtime, 'VISIONOS', oauth)
  }

  override getClient(context: YouTubeContext): YouTubeClientContext {
    return {
      client: {
        clientName: 'VISIONOS',
        clientVersion: '1.08',
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.1)',
        deviceMake: 'Apple',
        deviceModel: 'RealityDevice17,1',
        osName: 'visionOS',
        osVersion: '26.5.23O471',
        hl: context.client.hl,
        gl: context.client.gl,
        visitorData: context.client.visitorData
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true }
    }
  }

  override getPlayerParams(): string | null {
    return '2AMB'
  }

  override async search(
    query: string,
    _type: string,
    context: YouTubeContext
  ): Promise<SourceResult> {
    const { body, error, statusCode } = await makeRequest(
      'https://youtubei.googleapis.com/youtubei/v1/search',
      {
        method: 'POST',
        headers: {
          'User-Agent': this.getClient(context).client.userAgent,
          'X-Goog-Api-Format-Version': '2'
        },
        body: {
          context: this.getClient(context),
          query,
          params: 'EgIQAQ%3D%3D'
        },
        disableBodyCompression: true,
        proxy: this.getProxy()
      }
    )

    if (error || statusCode !== 200 || !body) {
      return {
        loadType: 'error',
        exception: {
          message: error || `Search failed with status ${statusCode}`,
          severity: 'common',
          cause: 'Upstream'
        }
      }
    }

    const searchResult = body as {
      error?: { message: string }
      contents?: {
        sectionListRenderer?: {
          contents?: Array<{ itemSectionRenderer?: { contents?: YouTubeRenderer[] } }>
        }
      }
    }
    if (searchResult.error) {
      return {
        loadType: 'error',
        exception: {
          message: searchResult.error.message,
          severity: 'fault',
          cause: 'Upstream'
        }
      }
    }

    const allSections = searchResult.contents?.sectionListRenderer?.contents
    const lastIdx = (allSections?.length ?? 0) - 1
    const videos = allSections?.[lastIdx]?.itemSectionRenderer?.contents || []
    const tracks: TrackData[] = []

    for (const v of videos.slice(0, 15)) {
      if (v.videoRenderer || v.compactVideoRenderer) {
        const track = await buildTrack(v, 'youtube')
        if (track) tracks.push(track)
      }
    }

    return tracks.length > 0
      ? { loadType: 'search', data: tracks }
      : { loadType: 'empty', data: {} }
  }
}

export class AndroidVR extends BaseClient {
  constructor(runtime: ClientRuntime, oauth: IOAuth | null) {
    super(runtime, 'ANDROID_VR', oauth)
  }

  override getClient(context: YouTubeContext): YouTubeClientContext {
    return {
      client: {
        clientName: 'ANDROID_VR',
        clientVersion: '1.65.10',
        userAgent:
          'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
        deviceMake: 'Meta',
        osName: 'Android',
        osVersion: '12L',
        androidSdkVersion: '32',
        hl: context.client.hl,
        gl: context.client.gl,
        visitorData: context.client.visitorData
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true }
    }
  }

  override async search(
    query: string,
    _type: string,
    context: YouTubeContext
  ): Promise<SourceResult> {
    const { body, error, statusCode } = await makeRequest(
      'https://youtubei.googleapis.com/youtubei/v1/search',
      {
        method: 'POST',
        headers: {
          'User-Agent': this.getClient(context).client.userAgent,
          'X-Goog-Api-Format-Version': '2'
        },
        body: {
          context: this.getClient(context),
          query,
          params: 'EgIQAQ%3D%3D'
        },
        disableBodyCompression: true,
        proxy: this.getProxy()
      }
    )

    if (error || statusCode !== 200 || !body) {
      return {
        loadType: 'error',
        exception: {
          message: error || `Search failed with status ${statusCode}`,
          severity: 'common',
          cause: 'Upstream'
        }
      }
    }

    const searchResult = body as {
      error?: { message: string }
      contents?: {
        sectionListRenderer?: {
          contents?: Array<{ itemSectionRenderer?: { contents?: YouTubeRenderer[] } }>
        }
      }
    }
    if (searchResult.error) {
      return {
        loadType: 'error',
        exception: {
          message: searchResult.error.message,
          severity: 'fault',
          cause: 'Upstream'
        }
      }
    }

    const allSections = searchResult.contents?.sectionListRenderer?.contents
    const lastIdx = (allSections?.length ?? 0) - 1
    const videos = allSections?.[lastIdx]?.itemSectionRenderer?.contents || []
    const tracks: TrackData[] = []

    for (const v of videos.slice(0, 15)) {
      if (v.videoRenderer || v.compactVideoRenderer) {
        const track = await buildTrack(v, 'youtube')
        if (track) tracks.push(track)
      }
    }

    return tracks.length > 0
      ? { loadType: 'search', data: tracks }
      : { loadType: 'empty', data: {} }
  }
}

export class IOS extends BaseClient {
  constructor(runtime: ClientRuntime, oauth: IOAuth | null) {
    super(runtime, 'IOS', oauth)
  }

  override getClient(context: YouTubeContext): YouTubeClientContext {
    return {
      client: {
        clientName: 'IOS',
        clientVersion: '21.02.1',
        userAgent:
          'com.google.ios.youtube/21.02.1 (iPhone16,2; U; CPU iOS 18_2 like Mac OS X;)',
        deviceMake: 'Apple',
        deviceModel: 'iPhone16,2',
        osName: 'iPhone',
        osVersion: '18.2.22C152',
        utcOffsetMinutes: 0,
        hl: context.client.hl,
        gl: context.client.gl,
        visitorData: context.client.visitorData
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true }
    }
  }

  override getPlayerParams(): string | null {
    return '2AMB'
  }

  override async search(
    query: string,
    type: string,
    context: YouTubeContext
  ): Promise<SourceResult> {
    const webClient = this.runtime.getClient('Web')
    if (webClient?.search) {
      return webClient.search(query, type, context)
    }
    return { loadType: 'empty', data: {} }
  }
}

export class Android extends BaseClient {
  constructor(runtime: ClientRuntime, oauth: IOAuth | null) {
    super(runtime, 'ANDROID', oauth)
  }

  override getClient(context: YouTubeContext): YouTubeClientContext {
    return {
      client: {
        clientName: 'ANDROID',
        clientVersion: '20.01.35',
        userAgent:
          'com.google.android.youtube/20.01.35 (Linux; U; Android 14) identity',
        deviceMake: 'Google',
        deviceModel: 'Pixel 6',
        osName: 'Android',
        osVersion: '14',
        androidSdkVersion: '34',
        hl: context.client.hl,
        gl: context.client.gl,
        visitorData: context.client.visitorData
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true }
    }
  }

  override getPlayerParams(): string | null {
    return '2AMB'
  }

  override async search(
    query: string,
    type: string,
    context: YouTubeContext,
    proxy?: HttpProxyConfig,
    reportProxyStatus?: ClientRuntime['reportProxyStatus']
  ): Promise<SourceResult> {
    const sourceName = 'youtube'
    let params = 'oAIBEgIQAQ%3D%3D'
    if (type === 'playlist' || type === 'album') params = 'oAIBEgIQAw%3D%3D'
    if (type === 'artist' || type === 'channel') params = 'oAIBEgIQAg%3D%3D'

    const searchProxy = proxy || this.getProxy()
    const searchStart = Date.now()
    const {
      body: searchResultRaw,
      error,
      statusCode
    } = await makeRequest('https://youtubei.googleapis.com/youtubei/v1/search', {
      method: 'POST',
      headers: {
        'User-Agent': this.getClient(context).client.userAgent,
        'X-Goog-Api-Format-Version': '2',
        ...(context.client.visitorData
          ? { 'X-Goog-Visitor-Id': context.client.visitorData }
          : {}),
        'X-YouTube-Client-Name': '3',
        'X-YouTube-Client-Version': this.getClient(context).client.clientVersion
      },
      body: {
        context: this.getClient(context),
        query,
        params
      },
      disableBodyCompression: true,
      proxy: searchProxy
    })

    reportProxyStatus?.(
      searchProxy,
      !error && statusCode === 200,
      statusCode || 0,
      Date.now() - searchStart
    )

    if (error || statusCode !== 200 || !searchResultRaw) {
      return {
        loadType: 'error',
        exception: {
          message:
            error ||
            `Failed to load results from ${sourceName}. Status: ${statusCode}`,
          severity: 'common',
          cause: 'Upstream'
        }
      }
    }

    const searchResult = searchResultRaw as {
      error?: { message: string }
      contents?: {
        sectionListRenderer?: {
          contents?: Array<{
            itemSectionRenderer?: { contents?: unknown[] }
            shelfRenderer?: {
              content?: {
                verticalListRenderer?: { items?: unknown[] }
                richGridRenderer?: { contents?: unknown[] }
              }
            }
            richShelfRenderer?: {
              content?: {
                verticalListRenderer?: { items?: unknown[] }
                richGridRenderer?: { contents?: unknown[] }
              }
            }
          }>
        }
      }
    }

    if (searchResult.error) {
      return {
        loadType: 'error',
        exception: {
          message: searchResult.error.message,
          severity: 'fault',
          cause: 'Upstream'
        }
      }
    }

    const items: YouTubeRenderer[] = []
    const allSections = searchResult.contents?.sectionListRenderer?.contents || []
    for (const section of allSections) {
      let contents = section.itemSectionRenderer?.contents
      if (!contents) {
        const shelf = section.shelfRenderer || section.richShelfRenderer
        contents =
          shelf?.content?.verticalListRenderer?.items ||
          shelf?.content?.richGridRenderer?.contents
      }
      if (Array.isArray(contents)) {
        for (const item of contents) {
          const obj = item as { richItemRenderer?: { content?: YouTubeRenderer } }
          items.push((obj.richItemRenderer?.content || item) as YouTubeRenderer)
        }
      }
    }

    if (items.length === 0) return { loadType: 'empty', data: {} }

    const maxResults = 15
    const filtered = items
      .filter(
        (item) =>
          item.videoRenderer ||
          item.compactVideoRenderer ||
          item.playlistRenderer ||
          item.compactPlaylistRenderer ||
          item.channelRenderer
      )
      .slice(0, maxResults)

    const tracks: TrackData[] = []
    for (const itemData of filtered) {
      const track = await buildTrack(itemData, sourceName)
      if (track) tracks.push(track)
    }

    return tracks.length > 0
      ? { loadType: 'search', data: tracks }
      : { loadType: 'empty', data: {} }
  }

  override async resolve(
    url: string,
    _type: string,
    context: YouTubeContext,
    cipherManager: ICipherManager | null,
    reportProxyStatus?: ClientRuntime['reportProxyStatus']
  ): Promise<SourceResult> {
    const sourceName = 'youtube'
    const urlType = checkURLType(url, 'youtube')
    const apiEndpoint = 'https://youtubei.googleapis.com'

    switch (urlType) {
      case YOUTUBE_CONSTANTS.VIDEO:
      case YOUTUBE_CONSTANTS.SHORTS: {
        const videoIdMatch = url.match(/(?:v=|\/shorts\/|youtu\.be\/)([^&?]+)/)
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
        const { body: playerResponse, statusCode } =
          await this._makePlayerRequest(videoId, context, {}, cipherManager)

        if (statusCode !== 200) {
          return {
            loadType: 'error',
            exception: {
              message: `Failed to load video/short player data. Status: ${statusCode}`,
              severity: 'common',
              cause: 'Upstream'
            }
          }
        }

        return await this._handlePlayerResponse(
          playerResponse,
          sourceName,
          videoId
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

        const isRadio = playlistId.startsWith('RD')
        const requestBody: Record<string, unknown> = isRadio
          ? {
              context: this.getClient(context),
              playlistId,
              contentCheckOk: true,
              racyCheckOk: true
            }
          : { context: this.getClient(context), browseId: `VL${playlistId}` }
        if (isRadio && currentVideoId) requestBody.videoId = currentVideoId

        const playlistProxy = this.getProxy()
        const playlistStart = Date.now()
        const { body: playlistResponseRaw, statusCode } = await makeRequest(
          `${apiEndpoint}/youtubei/v1/${isRadio ? 'next' : 'browse'}`,
          {
            headers: {
              'User-Agent': this.getClient(context).client.userAgent,
              ...(context.client.visitorData
                ? { 'X-Goog-Visitor-Id': context.client.visitorData }
                : {}),
              'X-YouTube-Client-Name': '3',
              'X-YouTube-Client-Version':
                this.getClient(context).client.clientVersion
            },
            body: requestBody,
            method: 'POST',
            disableBodyCompression: true,
            proxy: playlistProxy
          }
        )

        reportProxyStatus?.(
          playlistProxy,
          statusCode === 200,
          statusCode || 0,
          Date.now() - playlistStart
        )

        if (statusCode !== 200 || !playlistResponseRaw) {
          return {
            loadType: 'error',
            exception: {
              message: `Failed to fetch playlist. Status: ${statusCode}`,
              severity: 'common',
              cause: 'Upstream'
            }
          }
        }

        if (!isRadio) {
          return await this._handleBrowsePlaylistResponse(
            playlistId,
            playlistResponseRaw,
            sourceName,
            context,
            currentVideoId,
            targetIndex
          )
        }

        return await this._handlePlaylistResponse(
          playlistId,
          currentVideoId,
          playlistResponseRaw,
          sourceName,
          context,
          targetIndex
        )
      }

      default:
        return { loadType: 'empty', data: {} }
    }
  }

  override async getTrackUrl(
    decodedTrack: TrackInfo,
    context: YouTubeContext,
    cipherManager: ICipherManager | null,
    itag?: number | string,
    proxy?: HttpProxyConfig,
    selection?: StreamSelectionSpec
  ): Promise<MediaExtractionResult> {
    const { body: playerResponse, statusCode } = await this._makePlayerRequest(
      decodedTrack.identifier,
      context,
      {},
      cipherManager,
      proxy
    )

    if (statusCode !== 200 || !playerResponse) {
      return {
        loadType: 'error',
        exception: {
          message: `Failed to get player data for stream. Status: ${statusCode}`,
          severity: 'common',
          cause: 'Upstream',
          status: statusCode
        }
      }
    }

    const playerData = playerResponse as Record<string, unknown>
    const streamingData = (playerData.streamingData ||
      playerData.streaming_data) as Record<string, unknown> | undefined
    const serverAbrUrl =
      streamingData?.serverAbrStreamingUrl ||
      streamingData?.server_abr_streaming_url
    const ustreamerConfig = (
      playerData.playerConfig as Record<string, unknown> | undefined
    )?.mediaCommonConfig as Record<string, unknown> | undefined
    const videoPlaybackConfig = ustreamerConfig?.mediaUstreamerRequestConfig as
      | Record<string, unknown>
      | undefined

    if (serverAbrUrl) {
      const normalized = normalizePlayerFormats(streamingData ?? {})
      const formats = toFormatEntries(normalized)

      return {
        protocol: 'sabr',
        mode: selection?.mode ?? 'audio',
        url: String(serverAbrUrl),
        hlsUrl: (streamingData?.hlsManifestUrl as string | undefined) || null,
        formats,
        additionalData: {
          serverAbrStreamingUrl: String(serverAbrUrl),
          videoPlaybackUstreamerConfig:
            videoPlaybackConfig?.videoPlaybackUstreamerConfig,
          visitorData: this.getClient(context).client.visitorData,
          clientInfo: { clientName: 3, clientVersion: '20.51.39' },
          formats,
          accessToken: null,
          userAgent: this.getClient(context).client.userAgent
        }
      }
    }

    return await this._extractStreamData(
      playerResponse,
      decodedTrack,
      context,
      cipherManager,
      itag,
      selection
    )
  }
}
