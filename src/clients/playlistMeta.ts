// ============================================================================
// Playlist Metadata HTML Scraper
// ============================================================================

export interface YouTubePlaylistMeta {
  author: string
  thumbnail: string
}

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&lt;': '<',
  '&gt;': '>'
}

function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(?:amp|quot|#39|#x27|lt|gt);/g,
    (entity) => HTML_ENTITIES[entity] ?? entity
  )
}

function extractPlaylistThumbnail(html: string): string {
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? []

  for (const tag of metaTags) {
    if (!/\bproperty=["']og:image["']/i.test(tag)) continue
    const content = tag.match(/\bcontent=["']([^"']+)["']/i)?.[1]
    if (!content) continue

    return decodeHtmlEntities(content)
      .replace(/([?&])days_since_epoch=[^&#]*&?/, '$1')
      .replace(/[?&]$/, '')
  }

  return ''
}

function findKey(root: unknown, key: string): unknown {
  const stack: unknown[] = [root]

  while (stack.length > 0) {
    const node = stack.pop()
    if (!node || typeof node !== 'object') continue

    const record = node as Record<string, unknown>
    if (key in record && record[key] && typeof record[key] === 'object') {
      return record[key]
    }

    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') stack.push(value)
    }
  }

  return undefined
}

function textOf(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const text = value as {
    simpleText?: unknown
    runs?: Array<{ text?: unknown }>
  }

  if (typeof text.simpleText === 'string') return text.simpleText
  if (Array.isArray(text.runs)) {
    return text.runs
      .map((run) => (typeof run?.text === 'string' ? run.text : ''))
      .join('')
  }
  return ''
}

function extractPlaylistAuthor(html: string): string {
  const match = html.match(/ytInitialData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/)
  if (!match?.[1]) return ''

  let data: unknown
  try {
    data = JSON.parse(match[1])
  } catch {
    return ''
  }

  const sidebar = findKey(data, 'playlistSidebarSecondaryInfoRenderer') as
    | { videoOwner?: { videoOwnerRenderer?: { title?: unknown } } }
    | undefined
  const fromSidebar = textOf(sidebar?.videoOwner?.videoOwnerRenderer?.title)
  if (fromSidebar) return fromSidebar.trim()

  const header = findKey(data, 'playlistHeaderRenderer') as
    | { ownerText?: unknown }
    | undefined
  return textOf(header?.ownerText).trim()
}

export function parsePlaylistMeta(html: string): YouTubePlaylistMeta {
  return {
    author: extractPlaylistAuthor(html),
    thumbnail: extractPlaylistThumbnail(html)
  }
}
