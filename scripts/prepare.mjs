import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

function findTscEntry(startDir = process.cwd()) {
  let current = resolve(startDir)
  while (true) {
    const candidate = join(current, 'node_modules', 'typescript', 'bin', 'tsc')
    if (existsSync(candidate)) {
      return candidate
    }
    const parent = dirname(current)
    if (parent === current) {
      return null
    }
    current = parent
  }
}

function buildDist(tscEntry) {
  rmSync(join(process.cwd(), 'dist'), { recursive: true, force: true })
  execFileSync(
    process.execPath,
    [tscEntry, '-p', join(process.cwd(), 'tsconfig.json')],
    { stdio: 'inherit' }
  )
}

function createCleanNpmEnv() {
  const stripped = new Set([
    'node_env',
    'npm_config_global',
    'npm_config_location',
    'npm_config_prefix',
    'npm_config_global_prefix',
    'npm_config_local_prefix',
    'npm_config_omit',
    'npm_config_only',
    'npm_config_production',
    'npm_config_dry_run',
    'npm_config_package_lock_only',
    'npm_config_package_lock',
    'npm_config_save',
    'npm_config_ignore_scripts',
    'npm_config_workspaces',
    'npm_config_workspace'
  ])

  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !stripped.has(key.toLowerCase())) {
      env[key] = value
    }
  }
  return env
}

function installBuildDependencies() {
  const npmArgs = [
    'install',
    '--no-global',
    '--location=project',
    '--ignore-scripts',
    '--no-save',
    '--no-package-lock',
    '--no-audit',
    '--no-fund',
    '--no-dry-run',
    '--no-package-lock-only',
    '--include=dev',
    '--include=optional'
  ]

  const npmExecPath = process.env.npm_execpath
  const isNpmCliScript =
    typeof npmExecPath === 'string' &&
    npmExecPath.length > 0 &&
    existsSync(npmExecPath) &&
    /npm-cli\.(?:c|m)?js$/i.test(npmExecPath)

  const env = createCleanNpmEnv()

  if (isNpmCliScript) {
    execFileSync(process.execPath, [npmExecPath, ...npmArgs], {
      stdio: 'inherit',
      env
    })
    return
  }

  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', npmArgs, {
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32'
  })
}

let tscEntry = findTscEntry()

if (!tscEntry) {
  if (existsSync(join(process.cwd(), 'dist', 'cli', 'index.js'))) {
    process.exit(0)
  }

  if (!existsSync(join(process.cwd(), 'tsconfig.json'))) {
    throw new Error(
      'dist/cli/index.js is missing and tsconfig.json was not found.'
    )
  }

  installBuildDependencies()
  tscEntry = findTscEntry()

  if (!tscEntry) {
    throw new Error(
      'dist/ is missing and TypeScript compiler could not be installed. Run npm install && npm run build.'
    )
  }
}

buildDist(tscEntry)

