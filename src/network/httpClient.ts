import http from 'node:http'
import http2 from 'node:http2'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import zlib from 'node:zlib'
import type {
  HttpProxyConfig,
  HttpRequestOptions,
  HttpRequestResult
} from '../types/index.ts'
import { isDebugNetworkEnabled, logger } from '../utils/logger.ts'

export const REDIRECT_STATUS_CODES = [301, 302, 303, 307, 308] as const
export const DEFAULT_MAX_REDIRECTS = 5

const hasZstd = typeof zlib.createZstdDecompress === 'function'

// ============================================================================
// HTTP Agents & Zero-Dependency Proxy Tunneling
// ============================================================================

const httpAgent = new http.Agent({
  keepAlive: true,
  maxFreeSockets: 32,
  maxSockets: Infinity,
  timeout: 60000
})

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxFreeSockets: 32,
  maxSockets: Infinity,
  timeout: 60000
})

const http2FailedHosts = new Set<string>()

setInterval(
  () => {
    if (http2FailedHosts.size > 0) {
      http2FailedHosts.clear()
    }
  },
  6 * 60 * 60 * 1000
).unref()

export function cleanupHttpAgents(): void {
  try {
    httpAgent.destroy()
    httpsAgent.destroy()
    http2FailedHosts.clear()
  } catch {}
}

export function shouldUseReverseProxy(
  url: string,
  proxy?: HttpProxyConfig
): boolean {
  if (!proxy?.url || proxy.type !== 'reverse') return false
  try {
    const parsed = new URL(url)
    return parsed.hostname.endsWith('.googlevideo.com')
  } catch {
    return false
  }
}

function buildProxyAuthHeader(
  proxy: HttpProxyConfig,
  parsedProxy: URL
): string | undefined {
  const user = proxy.username || parsedProxy.username
  const pass = proxy.password || parsedProxy.password
  if (!user && !pass) return undefined
  return `Basic ${Buffer.from(`${decodeURIComponent(user || '')}:${decodeURIComponent(pass || '')}`).toString('base64')}`
}

function createTunnelSocket(
  proxy: HttpProxyConfig,
  targetHost: string,
  targetPort: number,
  upgradeTls: boolean,
  cb: (err: Error | null, socket?: net.Socket | tls.TLSSocket) => void
): void {
  let proxyUrl: URL
  try {
    proxyUrl = new URL(proxy.url)
  } catch (err) {
    cb(err instanceof Error ? err : new Error(String(err)))
    return
  }

  const proxyHost = proxyUrl.hostname
  const proxyPort = Number(
    proxyUrl.port || (proxyUrl.protocol === 'https:' ? 443 : 80)
  )
  const isHttpsProxy = proxyUrl.protocol === 'https:'
  const authHeader = buildProxyAuthHeader(proxy, proxyUrl)

  const connectOpts: net.NetConnectOpts = {
    host: proxyHost,
    port: proxyPort
  }

  const rawSocket: net.Socket | tls.TLSSocket = isHttpsProxy
    ? tls.connect({
        host: proxyHost,
        port: proxyPort,
        servername: proxyHost
      })
    : net.connect(connectOpts)

  let finished = false
  const finish = (err: Error | null, sock?: net.Socket | tls.TLSSocket) => {
    if (finished) return
    finished = true
    if (err && !rawSocket.destroyed) rawSocket.destroy()
    cb(err, sock)
  }

  rawSocket.once('error', (err) => finish(err))

  const onConnect = () => {
    const lines = [
      `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
      `Host: ${targetHost}:${targetPort}`,
      'Proxy-Connection: Keep-Alive'
    ]
    if (authHeader) lines.push(`Proxy-Authorization: ${authHeader}`)
    lines.push('', '')
    rawSocket.write(lines.join('\r\n'))

    let head = ''
    const onData = (chunk: Buffer) => {
      head += chunk.toString('latin1')
      const idx = head.indexOf('\r\n\r\n')
      if (idx === -1) return

      rawSocket.removeListener('data', onData)
      const statusLine = head.slice(0, head.indexOf('\r\n'))
      const statusMatch = /^HTTP\/\d+\.\d+\s+(\d+)/i.exec(statusLine)
      const code = statusMatch ? Number(statusMatch[1]) : 0
      if (code < 200 || code >= 300) {
        finish(new Error(`Proxy CONNECT failed: ${statusLine || 'unknown'}`))
        return
      }

      const extra = Buffer.from(head.slice(idx + 4), 'latin1')
      if (extra.length > 0) rawSocket.unshift(extra)

      if (!upgradeTls) {
        finish(null, rawSocket)
        return
      }

      const tlsSock = tls.connect({
        socket: rawSocket,
        servername: targetHost
      })
      tlsSock.once('secureConnect', () => finish(null, tlsSock))
      tlsSock.once('error', (err) => finish(err))
    }

    rawSocket.on('data', onData)
  }

  rawSocket.once(isHttpsProxy ? 'secureConnect' : 'connect', onConnect)
}

function getAgentForRequest(
  targetUrl: URL,
  proxy?: HttpProxyConfig
): http.Agent | https.Agent {
  const isHttps = targetUrl.protocol === 'https:'
  if (!proxy?.url || proxy.type === 'reverse') {
    return isHttps ? httpsAgent : httpAgent
  }

  if (isHttps) {
    const agent = new https.Agent({ keepAlive: false })
    ;(
      agent as unknown as {
        createConnection: (
          opts: { host?: string; hostname?: string; port?: number | string },
          cb: (err: Error | null, sock?: net.Socket | tls.TLSSocket) => void
        ) => void
      }
    ).createConnection = (opts, cb) => {
      const host = opts.hostname || opts.host || targetUrl.hostname
      const port = Number(opts.port || targetUrl.port || 443)
      createTunnelSocket(proxy, host, port, true, cb)
    }
    return agent
  }

  const agent = new http.Agent({ keepAlive: false })
  ;(
    agent as unknown as {
      createConnection: (
        opts: { host?: string; hostname?: string; port?: number | string },
        cb: (err: Error | null, sock?: net.Socket | tls.TLSSocket) => void
      ) => void
    }
  ).createConnection = (opts, cb) => {
    const host = opts.hostname || opts.host || targetUrl.hostname
    const port = Number(opts.port || targetUrl.port || 80)
    createTunnelSocket(proxy, host, port, false, cb)
  }
  return agent
}

// ============================================================================
// Redirect Handling & HTTP/1.1 + HTTP/2 Engine
// ============================================================================

const CROSS_ORIGIN_SENSITIVE_HEADERS =
  /^(?:authorization|cookie|proxy-authorization)$/i

function resolveRedirect(
  currentUrl: URL,
  location: string,
  statusCode: number,
  responseHeaders: http.IncomingHttpHeaders,
  options: HttpRequestOptions
): { url: string; options: HttpRequestOptions } {
  const redirectsFollowed = options._redirectsFollowed ?? 0
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS

  if (redirectsFollowed >= maxRedirects) {
    throw new Error(`Too many redirects (>${maxRedirects}) for ${currentUrl}`)
  }

  const nextUrl = new URL(location, currentUrl)
  if (!['http:', 'https:'].includes(nextUrl.protocol)) {
    throw new Error(
      `Unsupported redirect protocol "${nextUrl.protocol}" for ${nextUrl}`
    )
  }

  const setCookie = responseHeaders['set-cookie']
  const baseHeaders: Record<string, string> = { ...(options.headers ?? {}) }
  if (nextUrl.origin !== currentUrl.origin) {
    for (const key of Object.keys(baseHeaders)) {
      if (CROSS_ORIGIN_SENSITIVE_HEADERS.test(key)) {
        delete baseHeaders[key]
      }
    }
  }
  if (setCookie) {
    baseHeaders.Cookie = Array.isArray(setCookie)
      ? setCookie.join('; ')
      : String(setCookie)
  }

  const nextOptions: HttpRequestOptions = {
    ...options,
    headers: baseHeaders,
    _redirectsFollowed: redirectsFollowed + 1
  }

  if (statusCode === 303 && nextOptions.method !== 'HEAD') {
    nextOptions.method = 'GET'
    delete nextOptions.body
  }

  return { url: nextUrl.toString(), options: nextOptions }
}

function _internalHttp1Request(
  urlString: string,
  options: HttpRequestOptions
): Promise<HttpRequestResult> {
  return new Promise((resolve, reject) => {
    const {
      method = 'GET',
      headers: customHeaders = {},
      body,
      timeout = 30000,
      streamOnly = false,
      localAddress,
      proxy,
      disableBodyCompression = false,
      maxResponseBodyBytes = 10 * 1024 * 1024
    } = options

    const logId = Math.random().toString(36).substring(2, 8)
    let parsedUrl: URL
    try {
      parsedUrl = new URL(urlString)
    } catch {
      return reject(new Error(`Invalid URL: ${urlString}`))
    }

    const useReverseProxy = shouldUseReverseProxy(urlString, proxy)
    let requestUrl = urlString

    if (useReverseProxy && proxy) {
      try {
        const proxyBase = new URL(proxy.url)
        const target = new URL(urlString)
        proxyBase.searchParams.set('url', target.toString())
        requestUrl = proxyBase.toString()
        parsedUrl = proxyBase
      } catch {}
    }

    const isHttps = parsedUrl.protocol === 'https:'
    const httpModule = isHttps ? https : http
    const agent = getAgentForRequest(parsedUrl, proxy)

    const headers: Record<string, string> = {
      'Accept-Encoding': hasZstd
        ? 'zstd, br, gzip, deflate'
        : 'br, gzip, deflate',
      'User-Agent': 'Mozilla/5.0 (Node.js Http1Client)',
      DNT: '1',
      ...customHeaders
    }

    if (proxy?.type === 'reverse' && (proxy.username || proxy.password)) {
      const auth = Buffer.from(
        `${proxy.username || ''}:${proxy.password || ''}`
      ).toString('base64')
      headers['Proxy-Authorization'] = `Basic ${auth}`
    }

    const reqOptions: http.RequestOptions = {
      method,
      headers,
      timeout,
      agent,
      localAddress,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port ? Number(parsedUrl.port) : isHttps ? 443 : 80,
      path: `${parsedUrl.pathname}${parsedUrl.search}`
    }

    if (body && !['GET', 'HEAD'].includes(method)) {
      if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
        reqOptions.headers = {
          'Content-Length': String(body.length),
          ...reqOptions.headers
        }
      } else {
        const hasContentType = Object.keys(customHeaders).some(
          (k) => k.toLowerCase() === 'content-type'
        )
        const isUrlEncoded = Object.entries(customHeaders).some(
          ([k, v]) =>
            k.toLowerCase() === 'content-type' &&
            v.includes('application/x-www-form-urlencoded')
        )
        const payload =
          typeof body === 'string'
            ? body
            : isUrlEncoded && typeof body === 'object'
              ? new URLSearchParams(body as Record<string, string>).toString()
              : JSON.stringify(body)

        const bodyHeaders: Record<string, string> = {
          ...(hasContentType ? {} : { 'Content-Type': 'application/json' }),
          ...(reqOptions.headers as Record<string, string>),
          ...(!disableBodyCompression ? { 'Content-Encoding': 'gzip' } : {})
        }
        if (disableBodyCompression) {
          bodyHeaders['Content-Length'] = String(
            Buffer.byteLength(payload)
          )
        }
        reqOptions.headers = bodyHeaders
      }
    }

    if (isDebugNetworkEnabled()) {
      logger(
        'debug',
        'Network',
        `[${logId}] HTTP/1.1 ${method} ${requestUrl} (Origin: ${urlString})`
      )
    }

    const req = httpModule.request(reqOptions, (res) => {
      const statusCode = res.statusCode

      if (
        REDIRECT_STATUS_CODES.includes(
          (statusCode ?? 0) as (typeof REDIRECT_STATUS_CODES)[number]
        ) &&
        res.headers.location
      ) {
        res.resume()
        try {
          const redirect = resolveRedirect(
            parsedUrl,
            res.headers.location,
            statusCode ?? 0,
            res.headers,
            options
          )
          return resolve(http1makeRequest(redirect.url, redirect.options))
        } catch (err) {
          return reject(err)
        }
      }

      let responseStream: NodeJS.ReadableStream = res
      const encodingHeader = res.headers['content-encoding']
      const encoding = Array.isArray(encodingHeader)
        ? encodingHeader.join(',')
        : String(encodingHeader || '')

      if (encoding === 'zstd' && hasZstd) {
        responseStream = res.pipe(zlib.createZstdDecompress())
      } else if (encoding === 'br') {
        responseStream = res.pipe(zlib.createBrotliDecompress())
      } else if (encoding === 'gzip') {
        responseStream = res.pipe(zlib.createGunzip())
      } else if (encoding === 'deflate') {
        responseStream = res.pipe(zlib.createInflate())
      }

      if (streamOnly) {
        const passThrough = responseStream as import('node:stream').Readable & {
          destroyed?: boolean
          destroy: (err?: Error) => void
        }
        if (responseStream !== res) {
          const origDestroy = passThrough.destroy.bind(passThrough)
          passThrough.destroy = (err?: Error) => {
            if (!res.destroyed) res.destroy()
            return origDestroy(err)
          }
          res.once('error', (err) => {
            if (!passThrough.destroyed) passThrough.destroy(err)
          })
          res.once('close', () => {
            if (!passThrough.destroyed && !passThrough.readableEnded) {
              passThrough.destroy()
            }
          })
        }
        return resolve({
          statusCode,
          headers: res.headers,
          stream: passThrough
        })
      }

      if (method === 'HEAD') {
        res.resume()
        return resolve({ statusCode, headers: res.headers })
      }

      const chunks: Buffer[] = []
      let bufferedBytes = 0
      let abortedByLimit = false
      let settled = false

      responseStream.on('data', (chunk: Buffer) => {
        if (abortedByLimit) return
        bufferedBytes += chunk.length
        if (bufferedBytes > maxResponseBodyBytes) {
          abortedByLimit = true
          res.destroy()
          if (responseStream !== res && 'destroy' in responseStream) {
            ;(responseStream as { destroy?: () => void }).destroy?.()
          }
          if (!settled) {
            settled = true
            reject(
              new Error(
                `Response body too large for ${urlString} (${bufferedBytes} bytes > ${maxResponseBodyBytes} bytes)`
              )
            )
          }
          return
        }
        chunks.push(chunk)
      })

      responseStream.on('end', () => {
        if (abortedByLimit || settled) return
        settled = true
        const rawBuffer = Buffer.concat(chunks)

        if (options.responseType === 'buffer') {
          return resolve({
            statusCode,
            headers: res.headers,
            body: rawBuffer
          })
        }

        const text = rawBuffer.toString()
        const isJson = res.headers['content-type']
          ?.toLowerCase()
          .startsWith('application/json')
        let responseBody: unknown = text

        if (isJson && text) {
          try {
            responseBody = JSON.parse(text)
          } catch {
            const trimmed = text.trim()
            const firstNewline = trimmed.indexOf('\n')
            if (firstNewline !== -1) {
              try {
                responseBody = JSON.parse(trimmed.slice(0, firstNewline))
              } catch {
                responseBody = text
              }
            } else {
              responseBody = text
            }
          }
        }

        resolve({ statusCode, headers: res.headers, body: responseBody })
      })

      responseStream.on('error', (err) => {
        if (abortedByLimit || settled) return
        settled = true
        resolve({ statusCode, headers: res.headers, error: err.message })
      })
    })

    req.on('error', (err) => reject(err))
    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`HTTP/1.1 request timeout for ${urlString}`))
    })

    if (body && !['GET', 'HEAD'].includes(method)) {
      if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
        req.end(Buffer.from(body))
      } else {
        const isUrlEncoded = Object.entries(customHeaders).some(
          ([k, v]) =>
            k.toLowerCase() === 'content-type' &&
            v.includes('application/x-www-form-urlencoded')
        )
        const payload =
          typeof body === 'string'
            ? body
            : isUrlEncoded && typeof body === 'object'
              ? new URLSearchParams(body as Record<string, string>).toString()
              : JSON.stringify(body)

        if (disableBodyCompression) {
          req.end(payload)
        } else {
          zlib.gzip(payload, (err, data) => {
            if (err) {
              req.destroy()
              return reject(new Error(`Gzip error: ${err.message}`))
            }
            req.end(data)
          })
        }
      }
    } else {
      req.end()
    }
  })
}

export async function http1makeRequest(
  urlString: string,
  options: HttpRequestOptions = {}
): Promise<HttpRequestResult> {
  try {
    return await _internalHttp1Request(urlString, options)
  } catch (err) {
    const error = err as Error & { code?: string }
    const message = error.code ? `${error.message} (${error.code})` : error.message
    logger('debug', 'Network', `http1makeRequest failed for ${urlString}: ${message}`)
    return { error: message }
  }
}

export async function makeRequest(
  urlString: string,
  options: HttpRequestOptions
): Promise<HttpRequestResult> {
  const {
    method = 'GET',
    headers: customHeaders = {},
    body,
    timeout = 30000,
    streamOnly = false,
    localAddress,
    disableBodyCompression = false,
    proxy,
    maxResponseBodyBytes = 10 * 1024 * 1024
  } = options

  let host: string | undefined
  try {
    host = new URL(urlString).host
  } catch {}

  const useProxy = Boolean(proxy?.url)

  if (
    !urlString.startsWith('https://') ||
    (host && http2FailedHosts.has(host)) ||
    useProxy
  ) {
    return http1makeRequest(urlString, { ...options, localAddress })
  }

  return new Promise((resolve, reject) => {
    let session: http2.ClientHttp2Session | undefined
    let sessionClosed = false
    let settled = false
    let currentUrl: URL | undefined

    const fallbackToHttp1 = (): void => {
      if (!sessionClosed && session) {
        sessionClosed = true
        session.close()
      }
      try {
        const url = new URL(urlString)
        http2FailedHosts.add(url.host)
      } catch {}
      if (settled) return
      settled = true
      resolve(http1makeRequest(urlString, { ...options, localAddress }))
    }

    try {
      currentUrl = new URL(urlString)
      session = http2.connect(currentUrl.origin, {
        localAddress
      } as http2.ClientSessionOptions)

      const closeSessionGracefully = (): void => {
        if (
          session &&
          !session.closed &&
          !session.destroyed &&
          !sessionClosed
        ) {
          sessionClosed = true
          session.close()
        }
      }

      session.on('error', fallbackToHttp1)
      session.on('goaway', closeSessionGracefully)

      const h2Headers: http2.OutgoingHttpHeaders = {
        ':method': method,
        ':path': currentUrl.pathname + currentUrl.search,
        ':scheme': currentUrl.protocol.slice(0, -1),
        ':authority': currentUrl.host,
        'accept-encoding': hasZstd
          ? 'zstd, br, gzip, deflate'
          : 'br, gzip, deflate',
        'user-agent': 'Mozilla/5.0 (Node.js Http2Client)',
        dnt: '1',
        ...customHeaders
      }

      if (body && !['GET', 'HEAD'].includes(method)) {
        h2Headers['Content-Type'] =
          typeof body === 'object'
            ? 'application/json'
            : (h2Headers['Content-Type'] as string | undefined)
        if (!disableBodyCompression) h2Headers['content-encoding'] = 'gzip'
      }

      const req = session.request(h2Headers)
      let reqClosed = false

      if (timeout) {
        req.setTimeout(timeout, () => {
          if (!reqClosed) {
            reqClosed = true
            req.close(http2.constants.NGHTTP2_CANCEL)
          }
          closeSessionGracefully()
          fallbackToHttp1()
        })
      }

      req.on('error', () => {
        if (!reqClosed) reqClosed = true
        closeSessionGracefully()
        fallbackToHttp1()
      })

      req.on('response', async (headers) => {
        const statusHeader = headers[':status']
        const rawStatus =
          typeof statusHeader === 'number' ? statusHeader : Number(statusHeader)
        const statusCode = Number.isNaN(rawStatus) ? undefined : rawStatus

        const locationHeader = headers.location
        const location = Array.isArray(locationHeader)
          ? locationHeader[0]
          : locationHeader

        if (
          REDIRECT_STATUS_CODES.includes(
            (statusCode ?? 0) as (typeof REDIRECT_STATUS_CODES)[number]
          ) &&
          location &&
          currentUrl
        ) {
          if (!reqClosed) {
            reqClosed = true
            req.close(http2.constants.NGHTTP2_NO_ERROR)
          }
          closeSessionGracefully()
          if (settled) return
          settled = true
          try {
            const redirect = resolveRedirect(
              currentUrl,
              location,
              statusCode ?? 0,
              headers,
              options
            )
            return resolve(makeRequest(redirect.url, redirect.options))
          } catch (err) {
            return reject(err)
          }
        }

        const isNoBodyResponse =
          method === 'HEAD' ||
          statusCode === 204 ||
          statusCode === 304 ||
          (statusCode !== undefined && statusCode >= 100 && statusCode < 200)

        if (isNoBodyResponse) {
          if (streamOnly) {
            req.on('end', closeSessionGracefully)
            req.on('error', closeSessionGracefully)
            req.on('close', closeSessionGracefully)
            if (!settled) {
              settled = true
              resolve({ statusCode, headers, stream: req })
            }
            return
          }
          closeSessionGracefully()
          if (!settled) {
            settled = true
            resolve({
              statusCode,
              headers,
              body: options.responseType === 'buffer' ? Buffer.alloc(0) : ''
            })
          }
          return
        }

        let responseStream: NodeJS.ReadableStream = req
        const encodingHeader = headers['content-encoding']
        const encoding = Array.isArray(encodingHeader)
          ? encodingHeader.join(',')
          : String(encodingHeader || '')
        if (encoding === 'zstd' && hasZstd) {
          responseStream = req.pipe(zlib.createZstdDecompress())
        } else if (encoding === 'br') {
          responseStream = req.pipe(zlib.createBrotliDecompress())
        } else if (encoding === 'gzip') {
          responseStream = req.pipe(zlib.createGunzip())
        } else if (encoding === 'deflate') {
          responseStream = req.pipe(zlib.createInflate())
        }

        if (streamOnly) {
          responseStream.on('end', closeSessionGracefully)
          responseStream.on('error', closeSessionGracefully)
          responseStream.on('close', closeSessionGracefully)
          if (!settled) {
            settled = true
            resolve({
              statusCode,
              headers,
              stream: responseStream as import('node:stream').Readable
            })
          }
          return
        }

        try {
          const chunks: Buffer[] = []
          let bufferedBytes = 0
          for await (const chunk of responseStream) {
            const bufferChunk = chunk as Buffer
            bufferedBytes += bufferChunk.length
            if (bufferedBytes > maxResponseBodyBytes) {
              throw new Error(
                `Response body too large for ${urlString} (${bufferedBytes} bytes > ${maxResponseBodyBytes} bytes)`
              )
            }
            chunks.push(bufferChunk)
          }
          const rawBuffer = Buffer.concat(chunks)

          if (options.responseType === 'buffer') {
            if (!settled) {
              settled = true
              resolve({ statusCode, headers, body: rawBuffer })
            }
            return
          }

          const text = rawBuffer.toString()
          const contentTypeHeader = headers['content-type']
          const contentType = Array.isArray(contentTypeHeader)
            ? contentTypeHeader[0]
            : contentTypeHeader || ''
          const isJson = (contentType || '')
            .toLowerCase()
            .startsWith('application/json')
          let responseBody: unknown = text
          if (isJson && text) {
            try {
              responseBody = JSON.parse(text)
            } catch {
              const trimmed = text.trim()
              const firstNewline = trimmed.indexOf('\n')
              if (firstNewline !== -1) {
                try {
                  responseBody = JSON.parse(trimmed.slice(0, firstNewline))
                } catch {
                  responseBody = text
                }
              } else {
                responseBody = text
              }
            }
          }

          if (!settled) {
            settled = true
            resolve({ statusCode, headers, body: responseBody })
          }
        } catch (err) {
          if (!settled) {
            settled = true
            resolve({
              statusCode,
              headers,
              error: err instanceof Error ? err.message : String(err)
            })
          }
        } finally {
          if (!streamOnly) closeSessionGracefully()
        }
      })

      if (body && !['GET', 'HEAD'].includes(method)) {
        if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
          req.end(Buffer.from(body))
        } else {
          const payload =
            typeof body === 'string' ? body : JSON.stringify(body)
          if (
            disableBodyCompression ||
            h2Headers['content-encoding'] !== 'gzip'
          ) {
            req.end(payload)
          } else {
            zlib.gzip(payload, (err, data) => {
              if (err) {
                req.close(http2.constants.NGHTTP2_INTERNAL_ERROR)
                closeSessionGracefully()
                if (!settled) {
                  settled = true
                  reject(
                    new Error(`Gzip error for ${urlString}: ${err.message}`)
                  )
                }
                return
              }
              req.end(data)
            })
          }
        }
      } else {
        req.end()
      }
    } catch {
      if (session && !session.closed && !session.destroyed && !sessionClosed) {
        session.close()
      }
      fallbackToHttp1()
    }
  })
}

