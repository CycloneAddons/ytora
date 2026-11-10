import { makeRequest } from '../network/httpClient.ts'
import {
  YOUTUBE_CONSTANTS,
  type ICipherManager,
  type IOAuth,
  type SourceResult,
  type TrackData,
  type YouTubeClientContext,
  type YouTubeContext,
  type YouTubeRenderer
} from '../types/index.ts'
import { BaseClient, type ClientRuntime } from './baseClient.ts'
import type { MediaExtractionResult } from './formatSelector.ts'
import {
  buildTrack,
  checkURLType,
  extractPlaylistSelection
} from './metadata.ts'

export class WebRemix extends BaseClient {
  constructor(runtime: ClientRuntime, oauth: IOAuth | null) {
    super(runtime, 'WEB_REMIX', oauth)
  }

  override getClient(context: YouTubeContext): YouTubeClientContext {
    return {
      client: {
        clientName: 'WEB_REMIX',
        clientVersion: '1.20260721.00.00',
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) YouTubeMusic/3.12.0 Chrome/148.0.7778.271 Electron/42.5.0 Safari/537.36',
        hl: context.client.hl,
        gl: context.client.gl,
        applicationState: 'ACTIVE'
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true }
    }
  }

  override async search(
    query: string,
    type: string,
    context: YouTubeContext
  ): Promise<SourceResult> {
    let params = 'EgWKAQIIAWoQEAQQAxAJEAUQChAQEBUQEQ%3D%3D'
    if (type === 'playlist') params = 'EgeKAQQoAEABahAQBBADEAkQBRAKEBAQFRAR'
    if (type === 'album') params = 'EgWKAQIYAWoQEAQQAxAJEAUQChAQEBUQEQ%3D%3D'
    if (type === 'artist') params = 'EgWKAQIgAWoQEAQQAxAJEAUQChAQEBUQEQ%3D%3D'

    const { body, error, statusCode } = await makeRequest(
      'https://music.youtube.com/youtubei/v1/search?prettyPrint=false',
      {
        method: 'POST',
        headers: {
          'User-Agent': this.getClient(context).client.userAgent,
          'X-Goog-Api-Format-Version': '2'
        },
        body: {
          context: this.getClient(context),
          query,
          params
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
        tabbedSearchResultsRenderer?: {
          tabs?: Array<{
            tabRenderer?: {
              content?: {
                sectionListRenderer?: { contents?: unknown[] }
                musicSplitViewRenderer?: {
                  mainContent?: {
                    sectionListRenderer?: { contents?: unknown[] }
                  }
                }
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

    const tabContent =
      searchResult.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer
        ?.content

    const findShelf = (contents: unknown[] | undefined): unknown[] | null => {
      if (!Array.isArray(contents)) return null
      for (const section of contents) {
        const sec = section as Record<string, unknown>
        if (sec.musicShelfRenderer) {
          return (sec.musicShelfRenderer as Record<string, unknown>)
            .contents as unknown[]
        }
      }
      return null
    }

    let videos = findShelf(tabContent?.sectionListRenderer?.contents)
    if (!videos) {
      videos = findShelf(
        tabContent?.musicSplitViewRenderer?.mainContent?.sectionListRenderer
          ?.contents
      )
    }
    if (!videos || videos.length === 0) return { loadType: 'empty', data: {} }

    const tracks: TrackData[] = []
    for (const video of videos) {
      const v = video as Record<string, unknown>
      if (
        !v.musicResponsiveListItemRenderer &&
        !v.musicTwoColumnItemRenderer &&
        !v.videoId
      ) {
        continue
      }
      const track = await buildTrack(
        v as YouTubeRenderer,
        'ytmusic',
        'ytmusic',
        body as Record<string, unknown>
      )
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
    cipherManager: ICipherManager | null
  ): Promise<SourceResult> {
    const sourceName = 'ytmusic'
    const urlType = checkURLType(url, sourceName)

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
        if (!playlistId) return { loadType: 'empty', data: {} }

        const body: Record<string, unknown> = {
          context: this.getClient(context),
          playlistId,
          enablePersistentPlaylistPanel: true,
          isAudioOnly: true
        }
        if (currentVideoId) body.videoId = currentVideoId

        const { body: resRaw, statusCode } = await makeRequest(
          'https://music.youtube.com/youtubei/v1/next',
          {
            method: 'POST',
            body,
            headers: {
              'User-Agent': this.getClient(context).client.userAgent,
              'X-Goog-Api-Format-Version': '2'
            },
            disableBodyCompression: true,
            proxy: this.getProxy()
          }
        )
        if (statusCode !== 200 || !resRaw) return { loadType: 'empty', data: {} }

        return await this._handlePlaylistResponse(
          playlistId,
          currentVideoId,
          resRaw,
          sourceName,
          context,
          targetIndex
        )
      }

      default:
        return { loadType: 'empty', data: {} }
    }
  }

  override async getTrackUrl(): Promise<MediaExtractionResult> {
    return {
      loadType: 'error',
      exception: {
        message: 'WebRemix client does not provide direct track URLs.',
        severity: 'common'
      }
    }
  }
}

export class Music extends BaseClient {
  constructor(runtime: ClientRuntime, oauth: IOAuth | null) {
    super(runtime, 'ANDROID_MUSIC', oauth)
  }

  override getClient(context: YouTubeContext): YouTubeClientContext {
    return {
      client: {
        clientName: 'ANDROID_MUSIC',
        clientVersion: '8.47.54',
        userAgent:
          'com.google.android.apps.youtube.music/8.47.54 (Linux; U; Android 14 gzip)',
        deviceMake: 'Google',
        deviceModel: 'Pixel 6',
        osName: 'Android',
        osVersion: '14',
        androidSdkVersion: '30',
        hl: context.client.hl,
        gl: context.client.gl
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true }
    }
  }

  override async search(
    query: string,
    type: string,
    context: YouTubeContext
  ): Promise<SourceResult> {
    let params = 'EgWKAQIIAWoQEAMQBBAJEAoQBRAREBAQFQ%3D%3D'
    if (type === 'playlist') params = 'EgWKAQIoAWoKEAMQBBAJEAoQBRAB'
    if (type === 'album') params = 'EgWKAQIYAWoKEAMQBBAJEAoQBRAB'
    if (type === 'artist') params = 'EgWKAQIYAWoKEAMQBBAJEAoQBRAB'

    const { body, error, statusCode } = await makeRequest(
      'https://music.youtube.com/youtubei/v1/search',
      {
        method: 'POST',
        headers: {
          'User-Agent': this.getClient(context).client.userAgent,
          'X-Goog-Api-Format-Version': '2'
        },
        body: {
          context: this.getClient(context),
          query,
          params
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
        tabbedSearchResultsRenderer?: {
          tabs?: Array<{
            tabRenderer?: {
              content?: {
                sectionListRenderer?: { contents?: unknown[] }
                musicSplitViewRenderer?: {
                  mainContent?: {
                    sectionListRenderer?: { contents?: unknown[] }
                  }
                }
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

    const tabContent =
      searchResult.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer
        ?.content

    const findShelf = (contents: unknown[] | undefined): unknown[] | null => {
      if (!Array.isArray(contents)) return null
      for (const section of contents) {
        const sec = section as Record<string, unknown>
        if (sec.musicShelfRenderer) {
          return (sec.musicShelfRenderer as Record<string, unknown>)
            .contents as unknown[]
        }
      }
      return null
    }

    let videos = findShelf(tabContent?.sectionListRenderer?.contents)
    if (!videos) {
      videos = findShelf(
        tabContent?.musicSplitViewRenderer?.mainContent?.sectionListRenderer
          ?.contents
      )
    }
    if (!videos || videos.length === 0) return { loadType: 'empty', data: {} }

    const tracks: TrackData[] = []
    for (const video of videos) {
      const v = video as Record<string, unknown>
      if (
        !v.musicResponsiveListItemRenderer &&
        !v.musicTwoColumnItemRenderer
      ) {
        continue
      }
      const track = await buildTrack(
        v as YouTubeRenderer,
        'ytmusic',
        'ytmusic',
        body as Record<string, unknown>
      )
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
    cipherManager: ICipherManager | null
  ): Promise<SourceResult> {
    const sourceName = 'ytmusic'
    const urlType = checkURLType(url, sourceName)

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
        if (!playlistId) return { loadType: 'empty', data: {} }

        const body: Record<string, unknown> = {
          context: this.getClient(context),
          playlistId,
          enablePersistentPlaylistPanel: true,
          isAudioOnly: true
        }
        if (currentVideoId) body.videoId = currentVideoId

        const { body: resRaw, statusCode } = await makeRequest(
          'https://music.youtube.com/youtubei/v1/next',
          {
            method: 'POST',
            body,
            headers: {
              'User-Agent': this.getClient(context).client.userAgent,
              'X-Goog-Api-Format-Version': '2'
            },
            disableBodyCompression: true,
            proxy: this.getProxy()
          }
        )
        if (statusCode !== 200 || !resRaw) return { loadType: 'empty', data: {} }

        return await this._handlePlaylistResponse(
          playlistId,
          currentVideoId,
          resRaw,
          sourceName,
          context,
          targetIndex
        )
      }

      default:
        return { loadType: 'empty', data: {} }
    }
  }

  override async getTrackUrl(): Promise<MediaExtractionResult> {
    return {
      loadType: 'error',
      exception: {
        message: 'Music client does not provide direct track URLs.',
        severity: 'common'
      }
    }
  }
}
