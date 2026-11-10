import {
  DEFAULT_CIPHER_URL,
  DEFAULT_PLAYBACK_CLIENTS
} from '../core/constants.ts'
import { resolveDefaultOutDir } from '../utils/paths.ts'
import { getVersion } from '../version.ts'

export function printHelp(): void {
  const defaultOutDir = resolveDefaultOutDir()
  console.log(`
Ytora v${getVersion()} — Standalone YouTube & YouTube Music Downloader

Usage:
  ytora <url|videoId|query> [options]

Targets:
  <url>                     YouTube / YouTube Music / Shorts / Live / Playlist URL
  <videoId>                 11-character YouTube video ID (e.g. jNQXAC9IVRw)
  ytsearch:<query>          Search YouTube and download top match
  ytmsearch:<query>         Search YouTube Music and download top match
  ytrec:<videoId|query>     Fetch YouTube auto-mix recommendations

Mode & Quality Options:
  -a, --audio               Audio-only mode (itag priority: 251/250/140/249/139)
  -p, --progressive         Progressive single-file MP4 mode (itag 22/18, no ffmpeg needed)
  -q, --quality <val>       Video: best, 2160p, 1440p, 1080p, 720p, 480p, 360p, 240p, 144p
                            Audio: high, medium, low, lowest
      --audio-quality <q>   Companion audio quality in video mode: high|medium|low|lowest (default: high)
  -c, --codec <codec>       Preferred video codec: any|h264|vp9|av1 (default: any)
      --itag <num>          Download exact format itag
      --list-formats        Probe and print all available formats without downloading

Playlist & Output Options:
      --playlist            Download all tracks in a resolved playlist
      --limit <n>           Maximum number of tracks to download from a playlist
  -o, --out <dir>           Output directory (default: ${defaultOutDir})
  -f, --filename <tmpl>     Filename template: {title}, {id}, {author}, {quality}, {ext}
                            (default: "{title} [{id}]")

Innertube / Auth / Network Options:
      --clients <list>      Comma-separated Innertube playback clients
                            (default: ${DEFAULT_PLAYBACK_CLIENTS.join(',')})
      --hl <lang>           Language code (default: en)
      --gl <region>         Country code (default: US)
      --cipher-url <url>    Cipher decryption API URL (default: ${DEFAULT_CIPHER_URL})
      --cipher-token <tok>  Bearer token for cipher API
      --proxy <url>         HTTP/HTTPS proxy URL (repeatable)
      --refresh-token <tok> YouTube TV OAuth refresh token ("1//...")
      --oauth-login         Run interactive Google TV device OAuth flow and save token

Diagnostics & Info:
      --debug-logs          Write po_tokens.jsonl and sabr_traffic.jsonl into the current directory
  -v, --verbose             Enable debug logs
      --trace               Enable trace logs
      --quiet               Minimal output (errors only)
      --version             Show installed Ytora version
  -h, --help                Show this help text

Media Processing:
  Uses system ffmpeg (FFMPEG_PATH or PATH) when available, and automatically
  falls back to the bundled ffmpeg-static binary if system ffmpeg is not installed.

Examples:
  ytora "https://www.youtube.com/watch?v=jNQXAC9IVRw"
  ytora jNQXAC9IVRw --list-formats
  ytora "https://www.youtube.com/watch?v=jNQXAC9IVRw" -q 720p
  ytora "ytmsearch:Sneaky Snitch Kevin MacLeod" --audio -q high
  ytora "https://www.youtube.com/watch?v=jNQXAC9IVRw" --progressive
`)
}

