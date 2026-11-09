import fs from 'node:fs'
import http from 'node:http'
import { ChatAccess, discoverChats } from './chats.js'
import { defaultConfig, getPaths, loadConfig, type Config, type Paths } from './config.js'
import { log } from './log.js'
import { getMessage, getMessages, searchMessages } from './messages.js'
import { daemonSocketPath } from './rpc.js'
import { TelegramClient } from './tdlib.js'

type RuntimeState = {
  config: Config
  paths: Paths
  tg: TelegramClient
  access: ChatAccess
}

const STARTUP_HEALTH_PROBE_MS = 800
const SHUTDOWN_GRACE_MS = 5_000
const MAX_REQUEST_BYTES = 1_048_576

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createState(config: Config, paths: Paths): RuntimeState {
  const tg = new TelegramClient(config, paths)
  return { config, paths, tg, access: new ChatAccess(tg, config) }
}

let state: RuntimeState
let socketInode: number | null = null
let reloadPromise: Promise<void> | null = null
let idleTimer: NodeJS.Timeout | null = null
let inFlight = 0
let shuttingDown = false

// ------------------------------------------------------------------ config

/**
 * Reload config.json on every request so allowlist and limit changes apply
 * without restarting the daemon or any OpenCode session.
 */
async function reloadIfNeeded(): Promise<void> {
  if (reloadPromise) {
    await reloadPromise
    return
  }

  reloadPromise = (async () => {
    const loaded = loadConfig()
    const previous = state

    if (JSON.stringify(previous.config) === JSON.stringify(loaded.config)) return

    if (
      previous.config.apiId !== loaded.config.apiId ||
      previous.config.apiHash !== loaded.config.apiHash
    ) {
      log.info('API credentials changed; recreating TDLib client')
      state = createState(loaded.config, loaded.paths)
      await previous.tg.close()
    } else {
      log.info('Config reloaded')
      state = {
        config: loaded.config,
        paths: loaded.paths,
        tg: previous.tg,
        access: new ChatAccess(previous.tg, loaded.config),
      }
    }

    if (inFlight === 0) armIdleTimer()
  })().finally(() => {
    reloadPromise = null
  })

  await reloadPromise
}

// ------------------------------------------------------------------ params

function requiredString(params: Record<string, unknown>, name: string): string {
  const value = params[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Parameter "${name}" must be a non-empty string.`)
  }
  return value
}

function optionalString(params: Record<string, unknown>, name: string): string | undefined {
  const value = params[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Parameter "${name}" must be a non-empty string when provided.`)
  }
  return value
}

type NumberOptions = { integer?: boolean; min?: number; max?: number }

function checkNumber(value: number, name: string, options: NumberOptions): number {
  if (!Number.isFinite(value)) throw new Error(`Parameter "${name}" must be a finite number.`)
  if (options.integer && !Number.isInteger(value)) {
    throw new Error(`Parameter "${name}" must be an integer.`)
  }
  if (options.min !== undefined && value < options.min) {
    throw new Error(`Parameter "${name}" must be at least ${options.min}.`)
  }
  if (options.max !== undefined && value > options.max) {
    throw new Error(`Parameter "${name}" must be at most ${options.max}.`)
  }
  return value
}

function optionalNumber(
  params: Record<string, unknown>,
  name: string,
  options: NumberOptions = {},
): number | undefined {
  const value = params[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number') throw new Error(`Parameter "${name}" must be a number.`)
  return checkNumber(value, name, options)
}

function requiredNumber(
  params: Record<string, unknown>,
  name: string,
  options: NumberOptions = {},
): number {
  const value = optionalNumber(params, name, options)
  if (value === undefined) throw new Error(`Parameter "${name}" is required.`)
  return value
}

function optionalDate(params: Record<string, unknown>, name: string): string | number | undefined {
  const value = params[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`Parameter "${name}" must be an ISO date string or a Unix timestamp in seconds.`)
  }
  return value
}

function toUnixSeconds(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error('Date must be a positive Unix timestamp in seconds.')
    }
    return Math.floor(value)
  }
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  const parsed = Date.parse(trimmed)
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid date "${value}". Use an ISO 8601 date or a Unix timestamp in seconds.`)
  }
  return Math.floor(parsed / 1000)
}

function clampLimit(config: Config, requested: number | undefined, fallback?: number): number {
  const value = requested ?? fallback ?? config.defaultMessageLimit
  return Math.min(Math.max(1, Math.floor(value)), config.maxMessageLimit)
}

// ------------------------------------------------------------------ dispatch

async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
  await reloadIfNeeded()

  const { config, tg, access } = state

  switch (method) {
    case 'auth_status':
      return tg.getAuthStatus()

    case 'auth_start':
      return tg.startAuth(requiredString(params, 'phoneNumber'))

    case 'auth_code':
      return tg.submitCode(requiredString(params, 'code'))

    case 'auth_password':
      return tg.submitPassword(requiredString(params, 'password'))

    case 'auth_logout': {
      if (params.confirm !== true) {
        throw new Error('Logout not confirmed. Pass confirm: true to log out.')
      }
      const result = await tg.logout()
      state.access = new ChatAccess(tg, config)
      return result
    }

    case 'discover_chats': {
      if (!config.allowChatDiscovery) {
        throw new Error('Chat discovery is disabled by allowChatDiscovery: false in config.json.')
      }
      return discoverChats(
        tg,
        access,
        optionalString(params, 'query'),
        clampLimit(config, optionalNumber(params, 'limit', { integer: true, min: 1, max: 500 }), 100),
      )
    }

    case 'list_allowed_chats':
      return access.list()

    case 'get_chat': {
      const allowed = await access.resolve(requiredString(params, 'chat'))
      return { entry: allowed.entry, chat: allowed.summary }
    }

    case 'get_messages':
      return getMessages(tg, access, {
        chat: requiredString(params, 'chat'),
        limit: clampLimit(
          config,
          optionalNumber(params, 'limit', { integer: true, min: 1, max: 100 }),
        ),
        beforeMessageId: optionalNumber(params, 'beforeMessageId', { integer: true, min: 1 }),
        sinceDate: toUnixSeconds(optionalDate(params, 'sinceDate')),
        maxTextLength: config.tearOffMessageTextAt,
      })

    case 'search_messages':
      return searchMessages(tg, access, {
        chat: optionalString(params, 'chat'),
        query: requiredString(params, 'query'),
        limit: clampLimit(
          config,
          optionalNumber(params, 'limit', { integer: true, min: 1, max: 100 }),
        ),
        maxTextLength: config.tearOffMessageTextAt,
      })

    case 'get_message':
      return getMessage(
        tg,
        access,
        requiredString(params, 'chat'),
        requiredNumber(params, 'messageId', { integer: true, min: 1 }),
        config.tearOffMessageTextAt,
      )

    default:
      throw new Error(`Unknown daemon method "${method}".`)
  }
}

// ------------------------------------------------------------------ lifecycle

function armIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  if (shuttingDown || inFlight > 0) return

  const timeoutMs = state.config.daemonIdleTimeoutSeconds * 1000
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (inFlight > 0) {
      armIdleTimer()
      return
    }
    void shutdown('idle timeout')
  }, timeoutMs)
}

function removeSocket(): void {
  try {
    const stats = fs.statSync(daemonSocketPath)
    if (socketInode === null || stats.ino === socketInode) fs.unlinkSync(daemonSocketPath)
  } catch {
    // Socket already gone.
  }
}

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true

  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }

  log.info(`Shutting down (${reason})`)

  await Promise.race([
    new Promise<void>((resolve) => server.close(() => resolve())),
    delay(SHUTDOWN_GRACE_MS),
  ])
  removeSocket()

  try {
    await state.tg.close()
  } catch (error) {
    log.warn('Error while closing TDLib:', errorMessage(error))
  }

  process.exit(0)
}

// ------------------------------------------------------------------ HTTP

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    connection: 'close',
  })
  res.end(body)
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0

    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_REQUEST_BYTES) {
        reject(new Error('Request body is too large.'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

type RpcRequest = {
  method?: unknown
  params?: unknown
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, {
      ok: true,
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      authorized: state.tg.state?._ === 'authorizationStateReady',
    })
    return
  }

  if (req.method !== 'POST' || req.url !== '/rpc') {
    sendJson(res, 404, { ok: false, error: 'Not found.' })
    return
  }

  // Count the request and pause the idle timer before reading the body, so an
  // idle shutdown can never race a request that has already connected.
  inFlight += 1
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }

  try {
    let body: string
    try {
      body = await readBody(req)
    } catch (error) {
      sendJson(res, 400, { ok: false, error: errorMessage(error) })
      return
    }

    let request: RpcRequest
    try {
      request = JSON.parse(body) as RpcRequest
    } catch {
      sendJson(res, 400, { ok: false, error: 'Request body must be JSON.' })
      return
    }

    if (typeof request?.method !== 'string' || !request.method) {
      sendJson(res, 400, { ok: false, error: 'Request "method" must be a non-empty string.' })
      return
    }
    const params =
      request.params && typeof request.params === 'object' && !Array.isArray(request.params)
        ? (request.params as Record<string, unknown>)
        : {}

    try {
      const result = await dispatch(request.method, params)
      sendJson(res, 200, { ok: true, result })
    } catch (error) {
      log.warn(`RPC ${request.method} failed: ${errorMessage(error)}`)
      sendJson(res, 200, { ok: false, error: errorMessage(error) })
    }
  } finally {
    inFlight -= 1
    armIdleTimer()
  }
}

const server = http.createServer((req, res) => {
  void handleRequest(req, res).catch((error) => {
    log.error('Unhandled request error:', errorMessage(error))
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Internal daemon error.' })
    else res.destroy()
  })
})

// ------------------------------------------------------------------ startup

function probeExistingDaemon(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      resolve(value)
    }

    const req = http.get(
      { socketPath: daemonSocketPath, path: '/health', timeout: timeoutMs },
      (res) => {
        res.resume()
        finish(res.statusCode === 200)
      },
    )
    req.on('timeout', () => {
      req.destroy()
      finish(false)
    })
    req.on('error', () => finish(false))
  })
}

async function listen(): Promise<void> {
  if (fs.existsSync(daemonSocketPath)) {
    let alive = false
    for (let attempt = 0; attempt < 5; attempt += 1) {
      alive = await probeExistingDaemon(STARTUP_HEALTH_PROBE_MS)
      if (alive) break
      await delay(200)
    }
    if (alive) {
      log.info('Another Telegram daemon is already listening; exiting')
      process.exit(0)
    }
    log.warn('Removing stale daemon socket')
    try {
      fs.unlinkSync(daemonSocketPath)
    } catch {
      // Another daemon removed it first.
    }
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(daemonSocketPath)
  })

  try {
    fs.chmodSync(daemonSocketPath, 0o600)
    socketInode = fs.statSync(daemonSocketPath).ino
  } catch (error) {
    log.warn('Could not secure daemon socket permissions:', errorMessage(error))
  }
}

async function main(): Promise<void> {
  const paths = getPaths()
  fs.mkdirSync(paths.dataDir, { recursive: true })

  let initialConfig: Config
  try {
    initialConfig = loadConfig().config
  } catch (error) {
    log.error(
      'Could not load config at startup; using defaults until the file is fixed:',
      errorMessage(error),
    )
    initialConfig = defaultConfig()
  }

  state = createState(initialConfig, paths)

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection:', errorMessage(reason))
  })

  await listen()
  log.info(`Telegram daemon listening on ${daemonSocketPath} (pid ${process.pid})`)
  armIdleTimer()
}

main().catch((error) => {
  log.error('Fatal daemon error:', error instanceof Error ? error.stack : String(error))
  removeSocket()
  process.exit(1)
})
