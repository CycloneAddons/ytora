import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function resolveDefaultOutDir(): string {
  return path.join(process.cwd(), 'downloads')
}

export function resolveDefaultLogDir(): string {
  return process.cwd()
}

export function resolveDefaultOAuthDir(): string {
  if (process.env.YTORA_HOME?.trim()) {
    return path.resolve(process.env.YTORA_HOME.trim())
  }
  const cwdTokenPath = path.join(process.cwd(), '.oauth-tokens.json')
  if (existsSync(cwdTokenPath)) {
    return process.cwd()
  }
  const homeDir = os.homedir()
  if (homeDir) {
    return path.join(homeDir, '.ytora')
  }
  return process.cwd()
}

