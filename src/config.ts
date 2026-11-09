import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { log } from './log.js'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
export const projectRoot = path.resolve(moduleDir, '..')

const configSchema = z.object({
  /**
   * Telegram API credentials from https://my.telegram.org.
   * They are intentionally not bundled: create your own application there.
   * Zero/empty values mean "not configured yet".
   */
  apiId: z.number().int().min(0).default(0),
  apiHash: z.string().default(''),
  /** Chats the MCP server is allowed to read. Accepts @username, numeric id, t.me link, or exact title. */
  allowedChats: z.array(z.string().min(1)).default([]),
  /** Allow the discovery tool to list chats (metadata only) so the allowlist can be populated. */
  allowChatDiscovery: z.boolean().default(true),
  defaultMessageLimit: z.number().int().min(1).max(100).default(30),
  maxMessageLimit: z.number().int().min(1).max(100).default(100),
  tearOffMessageTextAt: z.number().int().min(200).max(100_000).default(4000),
  /** Seconds of inactivity before the shared daemon closes TDLib and exits. */
  daemonIdleTimeoutSeconds: z.number().int().min(60).max(86_400).default(600),
  verbosityLevel: z.number().int().min(0).max(10).default(1),
})

export type Config = z.infer<typeof configSchema>

export function hasApiCredentials(config: Config): boolean {
  return config.apiId > 0 && config.apiHash.trim() !== ''
}

export type Paths = {
  configPath: string
  dataDir: string
  databaseDirectory: string
  filesDirectory: string
}

export function getPaths(): Paths {
  const configPath = process.env.TELEGRAM_MCP_CONFIG
    ? path.resolve(process.env.TELEGRAM_MCP_CONFIG)
    : path.join(projectRoot, 'config.json')
  const dataDir = process.env.TELEGRAM_MCP_DATA_DIR
    ? path.resolve(process.env.TELEGRAM_MCP_DATA_DIR)
    : path.join(projectRoot, 'data')

  return {
    configPath,
    dataDir,
    databaseDirectory: path.join(dataDir, 'tdlib'),
    filesDirectory: path.join(dataDir, 'files'),
  }
}

export function defaultConfig(): Config {
  return configSchema.parse({})
}

export function ensureConfigFile(paths: Paths): Config {
  if (!fs.existsSync(paths.configPath)) {
    fs.mkdirSync(path.dirname(paths.configPath), { recursive: true })
    fs.writeFileSync(paths.configPath, `${JSON.stringify(defaultConfig(), null, 2)}\n`, 'utf8')
    log.info(`Created default config at ${paths.configPath}`)
  }

  let raw: string
  try {
    raw = fs.readFileSync(paths.configPath, 'utf8')
  } catch (error) {
    throw new Error(`Cannot read config at ${paths.configPath}: ${String(error)}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`Invalid JSON in ${paths.configPath}: ${String(error)}`)
  }

  const result = configSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`Invalid config at ${paths.configPath}:\n${issues}`)
  }

  const config = result.data
  if (config.maxMessageLimit < config.defaultMessageLimit) {
    config.maxMessageLimit = config.defaultMessageLimit
  }
  return config
}

export function loadConfig(): { config: Config; paths: Paths } {
  const paths = getPaths()
  const config = ensureConfigFile(paths)
  fs.mkdirSync(paths.databaseDirectory, { recursive: true })
  fs.mkdirSync(paths.filesDirectory, { recursive: true })
  return { config, paths }
}
