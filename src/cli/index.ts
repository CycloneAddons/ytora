import path from 'node:path'
import { parseArgs } from 'node:util'
import { getOAuthStorePath } from '../auth/oauth.ts'
import { DEFAULT_CIPHER_URL } from '../core/constants.ts'
import { YouTubeDownloader } from '../core/downloader.ts'
import type {
  AudioQualityPref,
  CodecPref,
  DownloadMode,
  PlaylistData,
  TrackData,
  VideoQualityPref
} from '../types/index.ts'
import { formatBytes, formatDuration } from '../utils/format.ts'
import { logger, setLogLevel } from '../utils/logger.ts'
import { resolveDefaultOutDir } from '../utils/paths.ts'
import { getVersion } from '../version.ts'
import { printHelp } from './help.ts'
import { printFormatInventory } from './inventory.ts'
import { createProgressRenderer } from './progress.ts'

const VALID_AUDIO_QUALITIES = new Set<AudioQualityPref>([
  'high',
  'medium',
  'low',
  'lowest'
])

const VALID_VIDEO_QUALITIES = new Set<string>([
  'best',
  '2160p',
  '1440p',
  '1080p',
  '720p',
  '480p',
  '360p',
  '240p',
  '144p'
])

const VALID_CODECS = new Set<CodecPref>(['any', 'h264', 'vp9', 'av1'])

function normalizeVideoQuality(raw: string): VideoQualityPref {
  const lower = raw.trim().toLowerCase()
  if (lower === 'best') return 'best'
  const withP = lower.endsWith('p') ? lower : `${lower}p`
  if (VALID_VIDEO_QUALITIES.has(withP)) {
    return withP as VideoQualityPref
  }
  throw new Error(
    `Invalid video quality "${raw}". Allowed: best, 2160p, 1440p, 1080p, 720p, 480p, 360p, 240p, 144p`
  )
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const defaultOutDir = resolveDefaultOutDir()

  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      audio: { type: 'boolean', short: 'a', default: false },
      progressive: { type: 'boolean', short: 'p', default: false },
      quality: { type: 'string', short: 'q' },
      'audio-quality': { type: 'string', default: 'high' },
      codec: { type: 'string', short: 'c', default: 'any' },
      itag: { type: 'string' },
      'list-formats': { type: 'boolean', default: false },
      playlist: { type: 'boolean', default: false },
      limit: { type: 'string' },
      out: { type: 'string', short: 'o', default: defaultOutDir },
      filename: { type: 'string', short: 'f' },
      clients: { type: 'string' },
      hl: { type: 'string', default: 'en' },
      gl: { type: 'string', default: 'US' },
      'cipher-url': { type: 'string', default: DEFAULT_CIPHER_URL },
      'cipher-token': { type: 'string' },
      proxy: { type: 'string', multiple: true },
      'refresh-token': { type: 'string' },
      'oauth-login': { type: 'boolean', default: false },
      'debug-logs': { type: 'boolean', default: false },
      verbose: { type: 'boolean', short: 'v', default: false },
      trace: { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
      version: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false }
    }
  })

  if (values.version) {
    console.log(`ytora v${getVersion()}`)
    return
  }

  if (values.help) {
    printHelp()
    return
  }

  const quiet = Boolean(values.quiet)
  const verbose = Boolean(values.verbose)
  const trace = Boolean(values.trace)
  if (trace) {
    setLogLevel('trace', true)
  } else if (verbose) {
    setLogLevel('debug', false)
  } else if (quiet) {
    setLogLevel('error', false)
  } else {
    setLogLevel('warn', false)
  }

  if (values.audio && values.progressive) {
    throw new Error('Cannot combine --audio and --progressive')
  }

  const codecRaw = (values.codec || 'any').trim().toLowerCase() as CodecPref
  if (!VALID_CODECS.has(codecRaw)) {
    throw new Error(`Invalid codec "${values.codec}". Allowed: any, h264, vp9, av1`)
  }

  const companionAudioRaw = (values['audio-quality'] || 'high')
    .trim()
    .toLowerCase() as AudioQualityPref
  if (!VALID_AUDIO_QUALITIES.has(companionAudioRaw)) {
    throw new Error(
      `Invalid --audio-quality "${values['audio-quality']}". Allowed: high, medium, low, lowest`
    )
  }

  const mode: DownloadMode = values.audio
    ? 'audio'
    : values.progressive
      ? 'progressive'
      : 'video'

  let videoQuality: VideoQualityPref = 'best'
  let audioQuality: AudioQualityPref = companionAudioRaw
  if (values.quality) {
    const qLower = values.quality.trim().toLowerCase()
    if (mode === 'audio') {
      if (!VALID_AUDIO_QUALITIES.has(qLower as AudioQualityPref)) {
        throw new Error(
          `Invalid audio quality "${values.quality}". Allowed: high, medium, low, lowest`
        )
      }
      audioQuality = qLower as AudioQualityPref
    } else if (VALID_AUDIO_QUALITIES.has(qLower as AudioQualityPref)) {
      audioQuality = qLower as AudioQualityPref
    } else {
      videoQuality = normalizeVideoQuality(qLower)
    }
  }

  let itag: number | null = null
  if (values.itag !== undefined) {
    if (!/^\d+$/.test(values.itag.trim())) {
      throw new Error(`Invalid itag "${values.itag}"`)
    }
    itag = Number.parseInt(values.itag.trim(), 10)
  }

  let limit: number | undefined
  if (values.limit !== undefined) {
    if (
      !/^\d+$/.test(values.limit.trim()) ||
      Number.parseInt(values.limit.trim(), 10) <= 0
    ) {
      throw new Error(`Invalid --limit "${values.limit}"`)
    }
    limit = Number.parseInt(values.limit.trim(), 10)
  }

  const clientList = values.clients
    ? values.clients
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean)
    : undefined

  const refreshTokens = values['refresh-token']
    ? values['refresh-token']
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    : undefined

  const proxies = values.proxy?.length ? values.proxy : undefined
  const outDir = path.resolve(values.out || defaultOutDir)

  const downloader = new YouTubeDownloader({
    hl: values.hl,
    gl: values.gl,
    clients: clientList
      ? { playback: clientList, resolve: clientList }
      : undefined,
    proxies,
    refreshTokens,
    cipherUrl: values['cipher-url'],
    cipherToken: values['cipher-token'] ?? null,
    debugLogs: Boolean(values['debug-logs'])
  })

  const onSignal = (sig: NodeJS.Signals) => {
    logger('warn', 'CLI', `Received ${sig}, aborting...`)
    downloader.destroy()
    process.exit(130)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  try {
    if (values['oauth-login']) {
      await downloader.setup()
      const token = await downloader.acquireOAuthToken()
      if (!token) {
        throw new Error('Failed to acquire OAuth refresh token')
      }
      console.log(
        `OAuth refresh token saved to ${getOAuthStorePath(downloader.baseDir)}`
      )
      if (positionals.length === 0) return
    }

    const target = positionals.join(' ').trim()
    if (!target) {
      printHelp()
      process.exitCode = 1
      return
    }

    if (values['list-formats']) {
      const { sourceResult } = await downloader.resolveInput(target, clientList)
      if (sourceResult.loadType === 'error') {
        throw new Error(
          sourceResult.exception?.message || 'Failed to resolve target'
        )
      }
      let track: TrackData | undefined
      if (sourceResult.loadType === 'track') {
        track = sourceResult.data as TrackData
      } else if (sourceResult.loadType === 'search') {
        track = (sourceResult.data as TrackData[])[0]
      } else if (sourceResult.loadType === 'playlist') {
        const pl = sourceResult.data as PlaylistData
        track = pl.tracks[pl.info.selectedTrack || 0] ?? pl.tracks[0]
      }
      if (!track) throw new Error(`No track found for "${target}"`)

      const inv = await downloader.listFormats(track.info, clientList)
      printFormatInventory(inv)
      return
    }

    const useTty = Boolean(process.stdout.isTTY && !verbose && !trace && !quiet)
    const renderer = createProgressRenderer(useTty, quiet)

    const downloaded = await downloader.download(target, {
      mode,
      videoQuality,
      audioQuality,
      codec: codecRaw,
      itag,
      outDir,
      filenameTemplate: values.filename,
      clients: clientList,
      playlist: Boolean(values.playlist),
      limit,
      onProgress: (ev) => renderer.onEvent(ev)
    })

    renderer.finish()

    if (!quiet) {
      for (const item of downloaded) {
        const streamsDesc = [
          item.videoItag ? `video=${item.videoItag}` : null,
          item.audioItag ? `audio=${item.audioItag}` : null
        ]
          .filter(Boolean)
          .join(', ')

        console.log(`\nSaved:    ${item.filePath}`)
        console.log(`Title:    ${item.title} — ${item.author}`)
        console.log(`Duration: ${formatDuration(item.durationMs)}`)
        console.log(
          `Size:     ${formatBytes(item.sizeBytes)} (${item.sizeBytes.toLocaleString('en-US')} bytes)`
        )
        console.log(
          `Pipeline: client=${item.client} protocol=${item.protocol} mode=${item.mode}${streamsDesc ? ` (${streamsDesc})` : ''} muxed=${item.muxedWithFfmpeg ? 'ffmpeg -c copy' : 'no'}`
        )
      }
    }
  } finally {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    downloader.destroy()
  }
}

export { printHelp } from './help.ts'
export { printFormatInventory } from './inventory.ts'
export { createProgressRenderer, type ProgressRenderer } from './progress.ts'

