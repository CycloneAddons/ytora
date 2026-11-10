/** Default Innertube client lists for search, playback, and URL resolution. */
export const DEFAULT_SEARCH_CLIENTS = ['Android']

export const DEFAULT_PLAYBACK_CLIENTS = [
  'VisionOs',
  'AndroidVR',
  'TV_DOWN',
  'TV',
  'TVCast',
  'WebEmbedded',
  'WebParentTools',
  'Web',
  'IOS'
]

export const DEFAULT_RESOLVE_CLIENTS = [
  'VisionOs',
  'AndroidVR',
  'TV_DOWN',
  'TV',
  'TVCast',
  'WebEmbedded',
  'WebParentTools',
  'IOS',
  'Web'
]

export const DEFAULT_CIPHER_URL = 'https://cipher.kikkia.dev/api'

/** Streaming & recovery tuning constants. */
export const CHUNK_SIZE = 64 * 1024
export const MAX_RETRIES = 3
export const MAX_URL_REFRESH = 10
export const VISITOR_DATA_INTERVAL = 3_600_000
export const STREAM_BUFFER_SIZE = 48 * 1024
export const WEBM_CLUSTER_MAGIC = Buffer.from([0x1f, 0x43, 0xb6, 0x75])
export const WEBM_SEEK_PROBE_WINDOWS = [32767, 262143, 1048575]
export const URL_MAX_AGE_MS = 4.5 * 60 * 60 * 1000
export const RECOVER_BASE_DELAY_MS = 2000
export const MAX_RETRY_DELAY_MS = 8000
export const URL_CACHE_TTL_MS = 1000 * 60 * 60 * 5

