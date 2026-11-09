import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { getPaths, projectRoot } from './config.js'
import { log } from './log.js'

const paths = getPaths()
export const daemonSocketPath = path.join(paths.dataDir, 'daemon.sock')
const daemonLockPath = path.join(paths.dataDir, 'daemon.lock')
const daemonLogPath = path.join(paths.dataDir, 'daemon.log')
const daemonEntry = path.join(projectRoot, 'dist', 'daemon.js')

const HEALTH_TIMEOUT_MS = 800
const START_TIMEOUT_MS = 20_000
const RPC_TIMEOUT_MS = 150_000

class DaemonUnavailableError extends Error {}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function httpRequest(
  method: 'GET' | 'POST',
  urlPath: string,
  body: string | undefined,
  timeoutMs: number,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = { connection: 'close' }
    if (body) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = Buffer.byteLength(body)
    }

    const req = http.request(
      {
        socketPath: daemonSocketPath,
        path: urlPath,
        method,
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          data += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
      },
    )

    req.on('error', (error) => reject(new DaemonUnavailableError(error.message)))
    req.on('timeout', () => req.destroy(new DaemonUnavailableError('Telegram daemon request timed out')))
    if (body) req.write(body)
    req.end()
  })
}

async function isHealthy(): Promise<boolean> {
  try {
    const response = await httpRequest('GET', '/health', undefined, HEALTH_TIMEOUT_MS)
    if (response.status !== 200) return false
    const parsed = JSON.parse(response.body) as { ok?: boolean }
    return parsed.ok === true
  } catch {
    return false
  }
}

async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isHealthy()) return true
    await delay(200)
  }
  return false
}

function rotateLog(): void {
  try {
    const stats = fs.statSync(daemonLogPath)
    if (stats.size > 5_000_000) fs.renameSync(daemonLogPath, `${daemonLogPath}.old`)
  } catch {
    // No log yet.
  }
}

function spawnDaemon(): void {
  if (!fs.existsSync(daemonEntry)) {
    throw new Error(`Telegram daemon entry not found at ${daemonEntry}. Run "npm run build" in the telegram folder.`)
  }

  fs.mkdirSync(paths.dataDir, { recursive: true })
  rotateLog()

  const logFd = fs.openSync(daemonLogPath, 'a')
  try {
    const child = spawn(process.execPath, [daemonEntry], {
      cwd: projectRoot,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    })
    child.unref()
  } finally {
    fs.closeSync(logFd)
  }
}

async function removeStaleLock(): Promise<void> {
  try {
    const stats = fs.statSync(daemonLockPath)
    if (Date.now() - stats.mtimeMs > START_TIMEOUT_MS) fs.unlinkSync(daemonLockPath)
  } catch {
    // Lock already gone.
  }
}

function acquireLock(): boolean {
  try {
    fs.mkdirSync(paths.dataDir, { recursive: true })
    fs.writeFileSync(daemonLockPath, `${process.pid} ${Date.now()}`, { flag: 'wx', mode: 0o600 })
    return true
  } catch {
    return false
  }
}

export async function ensureDaemon(): Promise<void> {
  if (await isHealthy()) return
  if (!fs.existsSync(daemonEntry)) {
    throw new Error(`Telegram daemon entry not found at ${daemonEntry}. Run "npm run build" in the telegram folder.`)
  }

  let ownsLock = acquireLock()
  if (!ownsLock) {
    // A lock left behind by a crashed process would otherwise stall every
    // caller for the full start timeout.
    await removeStaleLock()
    ownsLock = acquireLock()
  }

  if (!ownsLock) {
    // Another MCP process is starting the daemon; wait for it.
    if (await waitForHealth(START_TIMEOUT_MS)) return
    // That process failed and should have released its lock. Take over once.
    await removeStaleLock()
    ownsLock = acquireLock()
    if (!ownsLock) {
      if (await isHealthy()) return
      throw new Error(`Telegram daemon did not start. See ${daemonLogPath}.`)
    }
  }

  try {
    if (!(await isHealthy())) spawnDaemon()
    if (!(await waitForHealth(START_TIMEOUT_MS))) {
      throw new Error(`Telegram daemon did not start. See ${daemonLogPath}.`)
    }
  } finally {
    if (ownsLock) {
      try {
        fs.unlinkSync(daemonLockPath)
      } catch {
        // Lock already removed.
      }
    }
  }
}

async function rpcCall<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const response = await httpRequest(
    'POST',
    '/rpc',
    JSON.stringify({ method, params }),
    RPC_TIMEOUT_MS,
  )
  if (response.status !== 200) {
    throw new Error(`Telegram daemon HTTP ${response.status}: ${response.body}`)
  }

  let parsed: { ok?: boolean; result?: T; error?: string }
  try {
    parsed = JSON.parse(response.body) as { ok?: boolean; result?: T; error?: string }
  } catch {
    throw new Error('Invalid response from Telegram daemon.')
  }

  if (!parsed.ok) throw new Error(parsed.error ?? 'Unknown Telegram daemon error.')
  return parsed.result as T
}

/**
 * Call a method on the shared daemon, starting it if needed. A single daemon
 * owns the TDLib database so any number of OpenCode sessions can share it.
 */
export async function callDaemon<T>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  try {
    return await rpcCall<T>(method, params)
  } catch (error) {
    if (!(error instanceof DaemonUnavailableError)) throw error
    log.warn('Telegram daemon is not reachable, starting it')
    await ensureDaemon()
    return rpcCall<T>(method, params)
  }
}
