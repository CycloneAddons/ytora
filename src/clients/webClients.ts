import { makeRequest } from '../network/httpClient.ts'
import { poTokenManager } from '../potoken/poTokenManager.ts'
import type {
  HttpProxyConfig,
  HttpRequestResult,
  ICipherManager,
  IOAuth,
  SourceResult,
  StreamSelectionSpec,
  TrackData,
  TrackInfo,
  YouTubeClientContext,
  YouTubeContext,
  YouTubeRenderer
} from '../types/index.ts'
import { logger } from '../utils/logger.ts'
import { BaseClient, type ClientRuntime } from './baseClient.ts'
import {
  normalizePlayerFormats,
  toFormatEntries,
  type MediaExtractionResult
} from './formatSelector.ts'
import { buildTrack } from './metadata.ts'

export class WebEmbedded extends BaseClient {
  constructor(runtime: ClientRuntime, oauth: IOAuth | null) {
    super(runtime, 'WEB_EMBEDDED_PLAYER', oauth)
  }

  override getClient(context: YouTubeContext): YouTubeClientContext {
    return {
      client: {
        clientName: 'WEB_EMBEDDED_PLAYER',
        clientVersion: '2.20260630.09.00',
        platform: 'DESKTOP',
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36,gzip(gfe)',
        hl: context.client.hl,
        gl: context.client.gl,
        visitorData: context.client.visitorData
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true },
      thirdParty: {
        embedUrl: 'https://www.google.com/search?q=youtube',
        embeddedPlayerContext: {
          ancestorOrigins: ['https://www.google.com']
        }
      }
    }
  }

  override getPlayerParams(): string | null {
    return '2AMB'
  }

  override requirePlayerScript(): boolean {
    return true
  }

  override isEmbedded(): boolean {
    return true
  }

  override async search(
    query: string,
    _type: string,
    context: YouTubeContext
  ): Promise<SourceResult> {
    const { body, error, statusCode } = await makeRequest(
      'https://www.youtube.com/youtubei/v1/search',
      {
        method: 'POST',
        headers: {
          'User-Agent': this.getClient(context).client.userAgent,
          'X-Goog-Api-Format-Version': '2'
        },
        body: {
          context: this.getClient(context),
          query,
          params: 'EgVo2aDSNQ=='
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

export class WebParentTools extends BaseClient {
  constructor(runtime: ClientRuntime, oauth: IOAuth | null) {
    super(runtime, 'WEB_PARENT_TOOLS', oauth)
  }

  override getClient(context: YouTubeContext): YouTubeClientContext {
    return {
      client: {
        clientName: 'WEB_PARENT_TOOLS',
        clientVersion: '1.20220918',
        hl: context.client.hl,
        gl: context.client.gl,
        visitorData: context.client.visitorData,
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36,gzip(gfe)'
      },
      thirdParty: {
        embedUrl: 'https://www.youtube.com/'
      }
    }
  }

  override getPlayerParams(): string | null {
    return '2AMB'
  }

  override requirePlayerScript(): boolean {
    return true
  }

  override async _makePlayerRequest(
    videoId: string,
    context: YouTubeContext,
    headers: Record<string, string>,
    cipherManager: ICipherManager | null,
    proxy?: HttpProxyConfig
  ): Promise<HttpRequestResult> {
    const requestBody: Record<string, unknown> = {
      context: this.getClient(context),
      videoId,
      contentCheckOk: true,
      racyCheckOk: true
    }

    if (this.requirePlayerScript() && cipherManager) {
      try {
        const playerScript = await cipherManager.getCachedPlayerScript()
        if (playerScript?.url) {
          const signatureTimestamp = await cipherManager.getTimestamp(
            playerScript.url
          )
          requestBody.playbackContext = {
            contentPlaybackContext: {
              signatureTimestamp
            }
          }
        }
      } catch (e) {
        logger(
          'warn',
          'YouTube-WebParentTools',
          `Failed to get signature timestamp: ${e instanceof Error ? e.message : String(e)}`
        )
      }
    }

    return await makeRequest('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': this.getClient(context).client.userAgent,
        'X-YouTube-Client-Name': '88',
        'X-YouTube-Client-Version': '1.20220918',
        'X-Goog-Visitor-Id': context.client.visitorData ?? '',
        Origin: 'https://www.youtube.com',
        Referer: 'https://www.youtube.com/',
        ...headers
      },
      body: requestBody,
      disableBodyCompression: true,
      proxy: proxy || this.getProxy()
    })
  }
}

export class Web extends BaseClient {
  constructor(runtime: ClientRuntime, oauth: IOAuth | null) {
    super(runtime, 'WEB', oauth)
  }

  override getClient(context: YouTubeContext): YouTubeClientContext {
    return {
      client: {
        clientName: 'WEB',
        clientVersion: '2.20260706.00.00',
        platform: 'DESKTOP',
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
        hl: context.client.hl,
        gl: context.client.gl
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true }
    }
  }

  override requirePlayerScript(): boolean {
    return true
  }

  override async search(
    query: string,
    _type: string,
    context: YouTubeContext
  ): Promise<SourceResult> {
    const { body, error, statusCode } = await makeRequest(
      'https://www.youtube.com/youtubei/v1/search',
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

  override async getTrackUrl(
    decodedTrack: TrackInfo,
    context: YouTubeContext,
    cipherManager: ICipherManager | null,
    itag?: number | string,
    proxy?: HttpProxyConfig,
    selection?: StreamSelectionSpec
  ): Promise<MediaExtractionResult> {
    if (this.oauth?.getAccessToken) {
      await this.oauth.getAccessToken()
    }

    const { poToken, visitorData } = await poTokenManager.generate(
      decodedTrack.identifier
    )

    if (poToken) {
      const client = this.getClient(context)
      client.client.visitorData = visitorData

      let signatureTimestamp: string | null = null
      try {
        const playerScript = await cipherManager?.getCachedPlayerScript()
        if (cipherManager && playerScript) {
          signatureTimestamp = await cipherManager.getTimestamp(playerScript.url)
        }
      } catch (e: unknown) {
        logger(
          'warn',
          'YouTube-Web',
          `Failed to get STS: ${e instanceof Error ? e.message : String(e)}`
        )
      }

      const requestBody: Record<string, unknown> = {
        context: client,
        videoId: decodedTrack.identifier,
        contentCheckOk: true,
        racyCheckOk: true,
        serviceIntegrityDimensions: { poToken }
      }

      if (signatureTimestamp) {
        requestBody.playbackContext = {
          contentPlaybackContext: {
            signatureTimestamp
          }
        }
      }

      try {
        const { body: playerResponseRaw } = await makeRequest(
          'https://youtubei.googleapis.com/youtubei/v1/player?prettyPrint=false',
          {
            method: 'POST',
            headers: {
              'User-Agent': client.client.userAgent,
              ...(visitorData ? { 'X-Goog-Visitor-Id': visitorData } : {}),
              'X-Youtube-Client-Name': '1',
              'X-Youtube-Client-Version': client.client.clientVersion ?? '',
              Origin: 'https://www.youtube.com',
              Referer: `https://www.youtube.com/watch?v=${decodedTrack.identifier}`
            },
            body: requestBody,
            disableBodyCompression: true,
            proxy: proxy || this.getProxy()
          }
        )

        const playerResponse = (playerResponseRaw || {}) as Record<
          string,
          unknown
        >
        const streamingData = (playerResponse.streamingData ||
          playerResponse.streaming_data) as Record<string, unknown> | undefined
        const serverAbrUrl =
          streamingData?.serverAbrStreamingUrl ||
          streamingData?.server_abr_streaming_url
        const mediaCommonConfig = (
          playerResponse.playerConfig as Record<string, unknown> | undefined
        )?.mediaCommonConfig as Record<string, unknown> | undefined
        const ustreamerConfig = (
          mediaCommonConfig?.mediaUstreamerRequestConfig as
            | Record<string, unknown>
            | undefined
        )?.videoPlaybackUstreamerConfig as string | undefined

        if (serverAbrUrl) {
          const playerScript = await cipherManager?.getCachedPlayerScript()
          let resolvedUrl = String(serverAbrUrl)
          if (cipherManager && playerScript) {
            try {
              resolvedUrl = await cipherManager.resolveUrl(
                resolvedUrl,
                null,
                null,
                null,
                playerScript,
                context
              )
            } catch (e: unknown) {
              logger(
                'warn',
                'YouTube-Web',
                `Failed to resolve SABR URL via cipher server: ${e instanceof Error ? e.message : String(e)}`
              )
            }
          }

          const normalized = normalizePlayerFormats(streamingData ?? {})
          const formats = toFormatEntries(normalized)

          return {
            protocol: 'sabr',
            mode: selection?.mode ?? 'audio',
            url: resolvedUrl,
            hlsUrl: (streamingData?.hlsManifestUrl as string | undefined) || null,
            formats,
            additionalData: {
              serverAbrStreamingUrl: resolvedUrl,
              videoPlaybackUstreamerConfig: ustreamerConfig,
              poToken,
              visitorData,
              clientInfo: {
                clientName: 1,
                clientVersion: client.client.clientVersion
              },
              formats,
              accessToken: null,
              userAgent: client.client.userAgent
            }
          }
        }
      } catch {
        // Fall through to super.getTrackUrl
      }
    }

    return super.getTrackUrl(
      decodedTrack,
      context,
      cipherManager,
      itag,
      proxy,
      selection
    )
  }
}
