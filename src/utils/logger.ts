import util from 'node:util'
import type { LogLevelName } from '../types/index.ts'

const logLevels: Record<LogLevelName, number> = {
  trace: -1,
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 99
}

let currentLogLevel: number = logLevels.warn
let debugNetworkEnabled = false

export function setLogLevel(level: LogLevelName, debugNetwork = false): void {
  currentLogLevel = logLevels[level] ?? logLevels.warn
  debugNetworkEnabled = debugNetwork
}

export function getLogLevel(): LogLevelName {
  for (const [name, num] of Object.entries(logLevels)) {
    if (num === currentLogLevel) return name as LogLevelName
  }
  return 'warn'
}

export function isDebugNetworkEnabled(): boolean {
  return debugNetworkEnabled
}

export function logger(level: string, ...args: unknown[]): void {
  const effectiveLevel =
    level === 'sources' || level === 'started' || level === 'network'
      ? 'info'
      : level
  const levelIndex = logLevels[effectiveLevel as LogLevelName]

  if (levelIndex === undefined || levelIndex < currentLogLevel) return

  const category = args.length > 1 ? args[0] : ''
  const levels = {
    info: { label: 'INFO', color: '\x1b[1m\x1b[3;42m' },
    warn: { label: 'WARN', color: '\x1b[1m\x1b[3;43m' },
    error: { label: 'ERROR', color: '\x1b[1m\x1b[3;41m' },
    debug: { label: 'DEBUG', color: '\x1b[1m\x1b[3;45m' },
    trace: { label: 'TRACE', color: '\x1b[1m\x1b[90m' },
    sources: { label: 'SOURCES', color: '\x1b[1m\x1b[3;46m' },
    started: { label: 'STARTED', color: '\x1b[1m\x1b[3;44m' },
    network: { label: 'NETWORK', color: '\x1b[1m\x1b[3;44m' }
  } as const

  const resetColor = '\x1b[0m'
  const time = new Date().toISOString().slice(11, 23)
  const lvl = levels[level as keyof typeof levels] || {
    label: level.toUpperCase(),
    color: ''
  }
  const formattedCategory = category ? ` ${category} >` : ''
  const messageArgs = args.length > 1 ? args.slice(1) : args
  const formattedArgs = messageArgs.map((arg) => {
    if (arg instanceof Error) return `${arg.stack || arg.message}`
    if (typeof arg === 'object' && arg !== null) {
      return util.inspect(arg, { depth: null, colors: false })
    }
    return arg
  })

  const rawMsg = util.format(...formattedArgs)
  const output = `[${time}] ${lvl.color}[${lvl.label}]${resetColor}${formattedCategory} ${rawMsg}`
  if (effectiveLevel === 'error' || effectiveLevel === 'warn') {
    console.error(output)
  } else {
    console.log(output)
  }
}

