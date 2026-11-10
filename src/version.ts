import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function readPackageVersion(): string {
  try {
    const currentDir = path.dirname(fileURLToPath(import.meta.url))
    const candidates = [
      path.resolve(currentDir, '../package.json'),
      path.resolve(currentDir, '../../package.json')
    ]
    for (const candidate of candidates) {
      try {
        const raw = readFileSync(candidate, 'utf8')
        const parsed = JSON.parse(raw) as { name?: string; version?: string }
        if (parsed.version && typeof parsed.version === 'string') {
          return parsed.version
        }
      } catch {
        // try next path
      }
    }
  } catch {
    // ignore read failure
  }
  return '1.0.0'
}

export const YTORA_VERSION = readPackageVersion()

export function getVersion(): string {
  return YTORA_VERSION
}

