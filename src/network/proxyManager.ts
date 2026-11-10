import type {
  ProxyEntry,
  ProxySnapshot,
  RawProxyInput
} from '../types/index.ts'

// ============================================================================
// Proxy Pool Manager
// ============================================================================

export class YouTubeProxyManager {
  private proxies: ProxyEntry[]

  constructor(rawProxies: RawProxyInput[] = []) {
    this.proxies = (rawProxies || []).map(
      (p): ProxyEntry => ({
        url: typeof p === 'string' ? p : p.url,
        type: (typeof p === 'string' ? 'forward' : p.type || 'forward') as
          | 'forward'
          | 'reverse',
        failures: 0,
        lastFailure: 0,
        activeRequests: 0,
        score: 100,
        latency: 0
      })
    )
  }

  getBestProxy(): ProxySnapshot | undefined {
    if (!this.proxies.length) return undefined
    const now = Date.now()

    const available = this.proxies.filter((p) => {
      if (p.score <= 0) return now - p.lastFailure > 600_000
      if (p.failures > 5) return now - p.lastFailure > 60_000
      return true
    })

    const list = available.length ? available : this.proxies
    list.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      if (a.activeRequests !== b.activeRequests) {
        return a.activeRequests - b.activeRequests
      }
      return a.latency - b.latency
    })

    const topCount = Math.min(3, list.length)
    const selected = list[Math.floor(Math.random() * topCount)]
    if (!selected) return undefined

    selected.activeRequests++
    return { ...selected } as ProxySnapshot
  }

  report(
    proxyUrl: string,
    success: boolean,
    status: number,
    latency = 0
  ): void {
    const p = this.proxies.find((pr) => pr.url === proxyUrl)
    if (!p) return

    if (p.activeRequests > 0) p.activeRequests--
    if (latency > 0) {
      p.latency = p.latency === 0 ? latency : p.latency * 0.8 + latency * 0.2
    }

    if (success) {
      p.score = Math.min(100, p.score + 5)
      p.failures = 0
    } else {
      p.failures++
      p.lastFailure = Date.now()
      let penalty = 10
      if (status === 403) penalty = 50
      if (status === 429) penalty = 30
      if (status === 503) penalty = 20
      p.score = Math.max(0, p.score - penalty)
    }
  }
}

