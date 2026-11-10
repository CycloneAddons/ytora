# Ytora

A fast, standalone YouTube & YouTube Music downloader and Innertube extraction library written in strict TypeScript for Node.js, usable both programmatically via ESM/TypeScript `import` and as a global CLI (`npm i -g ytora`).

## Features

- **13 Innertube Clients**: Automatic client rotation across `VisionOs`, `AndroidVR`, `TV_DOWN`, `TV`, `TVCast`, `WebEmbedded`, `WebParentTools`, `Web`, `IOS`, `Android`, `Music`, `WebRemix`, and `TVEmbedded`.
- **Resilient Streaming Pipelines**:
  - **SABR (UMP/Protobuf)** adaptive streaming with session recovery and segment isolation.
  - **Dynamic-Chunk HTTP Range** streaming (`64 KiB` → `4 MiB` EWMA-tuned chunks) with `Range: bytes=0-0` pre-flight validation.
  - **HLS** M3U8 master/media parsing and AES-128 / byte-range segment fetching.
- **PoToken & BotGuard**: Built-in sandboxed DOM shim and BotGuard execution for content and session PoToken generation.
- **Cipher Resolution & OAuth**: Player `base.js` caching, remote cipher decryption support, and interactive YouTube TV device-code OAuth (`--oauth-login`).
- **Automatic FFmpeg Fallback**: Uses `FFMPEG_PATH` or system `ffmpeg` when installed, and automatically falls back to the bundled [`ffmpeg-static`](https://www.npmjs.com/package/ffmpeg-static) npm binary if system `ffmpeg` is not found.

## Requirements

- **Node.js `>= 22.22.1`**

## Installation

### Global CLI

```bash
npm install -g ytora
```

Or on Termux (Android):

```bash
pkg install nodejs-lts git ffmpeg
npm install -g git+https://github.com/CycloneAddons/ytora.git
```

Run from anywhere:

```bash
ytora --help
ytora "https://www.youtube.com/watch?v=jNQXAC9IVRw"
```

### Library / Project Dependency

```bash
npm install ytora
```

## Programmatic Usage (ESM & TypeScript)

Ytora ships compiled ESM JavaScript along with full `.d.ts` type declarations and source maps. Subpath exports are provided for `"ytora"`, `"ytora/clients"`, and `"ytora/types"`.

```ts
import { Ytora, detectFfmpegBinary } from 'ytora'

const downloader = new Ytora({
  hl: 'en',
  gl: 'US'
})

try {
  // Optional: inspect which ffmpeg binary will be used (env | system | ffmpeg-static)
  const ffmpeg = await detectFfmpegBinary()
  console.log('FFmpeg source:', ffmpeg?.source, ffmpeg?.bin)

  // Download best adaptive video + audio, losslessly muxed with ffmpeg -c copy
  const results = await downloader.download(
    'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    {
      mode: 'video',
      videoQuality: '1080p',
      audioQuality: 'high',
      codec: 'any',
      itag: null,
      outDir: './downloads',
      onProgress: (ev) => {
        if (ev.totalBytes && ev.bytesDownloaded !== undefined) {
          const pct = ((ev.bytesDownloaded / ev.totalBytes) * 100).toFixed(1)
          process.stdout.write(`\r[${ev.phase}] ${pct}%`)
        }
      }
    }
  )

  console.log('\nDownloaded:', results)
} finally {
  downloader.destroy()
}
```

You can also import `YouTubeDownloader` or `YtoraDownloader` (aliases of the same class), `buildTrackFromId`, search/resolve helpers, and Innertube client classes:

```ts
import { YouTubeDownloader, buildTrackFromId } from 'ytora'
import { AndroidVR, Web } from 'ytora/clients'
import type { DownloadOptions, FormatInventoryResult } from 'ytora/types'

const yt = new YouTubeDownloader()
try {
  const searchRes = await yt.search('Big Buck Bunny', 'ytsearch')
  const formats: FormatInventoryResult = await yt.listFormats(
    buildTrackFromId('jNQXAC9IVRw').info
  )
  console.log(searchRes.loadType, formats.formats.length)
} finally {
  yt.destroy()
}
```

## CLI Usage

```bash
# Default: download best adaptive video + compatible audio and mux losslessly
ytora "https://www.youtube.com/watch?v=jNQXAC9IVRw"

# Probe available formats without downloading
ytora jNQXAC9IVRw --list-formats

# Cap video resolution and pick preferred codec (any | h264 | vp9 | av1)
ytora "https://www.youtube.com/watch?v=jNQXAC9IVRw" -q 720p --codec h264

# Progressive single-file MP4 (itag 22 / 18; no ffmpeg required)
ytora "https://www.youtube.com/watch?v=jNQXAC9IVRw" --progressive

# Audio-only mode (itag priority: high=[251,250,140], medium=[250,140], low=[249,250,140], lowest=[249,139])
ytora "https://www.youtube.com/watch?v=jNQXAC9IVRw" --audio -q high

# YouTube / YouTube Music search, recommendations, and playlists
ytora "ytsearch:Big Buck Bunny 60fps" -q 1080p
ytora "ytmsearch:Sneaky Snitch Kevin MacLeod" --audio -q high
ytora "ytrec:jNQXAC9IVRw" --audio
ytora "https://www.youtube.com/playlist?list=..." --playlist --limit 5
```

Downloads are saved to `./downloads` in the current working directory by default using the filename template `"{title} [{id}]"`.

## CLI Options

### Mode & Quality
- `-a, --audio`: Audio-only download (`itag` priority `251/250/140/249/139`).
- `-p, --progressive`: Progressive single-file MP4 (`itag` `22` / `18`, HLS fallback if unavailable).
- `-q, --quality <val>`: Video target (`best`, `2160p`, `1440p`, `1080p`, `720p`, `480p`, `360p`, `240p`, `144p`) or audio quality (`high`, `medium`, `low`, `lowest`).
- `--audio-quality <q>`: Companion audio quality in video mode (`high`, `medium`, `low`, `lowest`; default `high`).
- `-c, --codec <codec>`: Preferred adaptive video codec (`any`, `h264`, `vp9`, `av1`; default `any`).
- `--itag <num>`: Download a specific format `itag`.
- `--list-formats`: Probe the first working Innertube client and print all available formats.

### Playlist & Output
- `--playlist`: Download all resolved playlist tracks instead of only the selected video on `watch?v=...&list=...`.
- `--limit <n>`: Maximum number of playlist tracks to download.
- `-o, --out <dir>`: Output directory (default: `./downloads`).
- `-f, --filename <tmpl>`: Output filename template supporting `{title}`, `{id}`, `{author}`, `{quality}`, `{ext}` (default: `"{title} [{id}]"`).

### Innertube, Auth & Network
- `--clients <list>`: Comma-separated Innertube playback client order (default: `VisionOs,AndroidVR,TV_DOWN,TV,TVCast,WebEmbedded,WebParentTools,Web,IOS`).
- `--hl <lang>`, `--gl <region>`: Innertube locale parameters (defaults: `en`, `US`).
- `--cipher-url <url>`, `--cipher-token <tok>`: Cipher decryption endpoint (default: `https://cipher.kikkia.dev/api`) and optional bearer token.
- `--proxy <url>`: HTTP/HTTPS proxy URL (repeatable).
- `--refresh-token <tok>`, `--oauth-login`: Supply or interactively acquire a YouTube TV OAuth refresh token (saved to `.oauth-tokens.json` in `$YTORA_HOME`, current directory if present, or `~/.ytora`).

### Diagnostics & Info
- `--debug-logs`: Write `po_tokens.jsonl` and `sabr_traffic.jsonl` into the current directory (or `config.logDir`).
- `-v, --verbose`: Enable debug logging.
- `--trace`: Enable trace and network debug logging.
- `--quiet`: Suppress progress output and non-error logs.
- `--version`: Show installed Ytora version.
- `-h, --help`: Print CLI usage.

## FFmpeg Resolution Order

Ytora resolves FFmpeg in the following order whenever lossless muxing (`-c copy`) is needed:

1. `FFMPEG_PATH` environment variable (if set and executable)
2. System `ffmpeg` in `PATH`, `$PREFIX/bin/ffmpeg`, `/usr/bin/ffmpeg`, or `/usr/local/bin/ffmpeg`
3. Bundled [`ffmpeg-static`](https://www.npmjs.com/package/ffmpeg-static) optional binary (used automatically when system `ffmpeg` is unavailable on Linux/macOS/Windows; skipped cleanly on unsupported platforms like Android/Termux where `pkg install ffmpeg` provides native FFmpeg)

If no FFmpeg binary is available or working, `video` mode gracefully falls back to `--progressive`.

## Architecture

```text
bin/
  ytora.js                # Global CLI executable entry point
src/
  index.ts                # Package root barrel export
  version.ts              # Runtime package version reader
  auth/                   # CipherManager & YouTube TV OAuth device flow
  cli/                    # CLI argument parsing, help text, format table, progress UI
  clients/                # BaseClient, 13 Innertube clients, metadata & format selector
  core/                   # YouTubeDownloader (Ytora), constants & media container helpers
  hls/                    # M3U8 playlist parser, segment fetcher & HLS stream handler
  network/                # HTTP/1.1 & HTTP/2 client & adaptive proxy manager
  potoken/                # BotGuard PoToken manager & NativeDOM sandbox shim
  sabr/                   # Protobuf codec & SABR adaptive UMP stream engine
  types/                  # Strict TypeScript interfaces and shared types
  utils/                  # FFmpeg (+ ffmpeg-static fallback), formatting, paths & logger
```

## Development

```bash
npm run type-check
npm run build
```
