#!/usr/bin/env node
import dns from 'node:dns'
import { runCli } from '../dist/cli/index.js'

try {
  dns.setDefaultResultOrder('ipv4first')
} catch {
  // Ignore on runtimes without setDefaultResultOrder
}

runCli().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(`Error: ${msg}`)
  process.exitCode = 1
})

