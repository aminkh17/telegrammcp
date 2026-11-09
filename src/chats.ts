import { TDLibError, type Client } from 'tdl'
import type { Chat } from 'tdlib-types'
import type { Config } from './config.js'
import { log } from './log.js'
import type { TelegramClient } from './tdlib.js'

export type ChatKind = 'private' | 'bot' | 'basic_group' | 'supergroup' | 'channel' | 'secret' | 'unknown'

export type ChatSummary = {
  id: number
  title: string
  kind: ChatKind
  username?: string
  description?: string
  memberCount?: number
  unreadCount?: number
}

export type AllowedChat = {
  entry: string
  chatId: number
  summary: ChatSummary
}

export type AllowlistError = {
  entry: string
  error: string
}

function errorMessage(error: unknown): string {
  if (error instanceof TDLibError) return `${error.message} (code ${error.code})`
  if (error instanceof Error) return error.message
  return String(error)
}

function kindOf(chat: Chat): ChatKind {
  switch (chat.type._) {
    case 'chatTypePrivate':
      return 'private'
    case 'chatTypeBasicGroup':
      return 'basic_group'
    case 'chatTypeSupergroup':
      return chat.type.is_channel ? 'channel' : 'supergroup'
    case 'chatTypeSecret':
      return 'secret'
    default:
      return 'unknown'
  }
}

/**
 * Build a compact chat description. Full info calls (description, username,
 * member count) are best-effort and never fail the whole operation.
 */
export async function describeChat(client: Client, chat: Chat, detailed: boolean): Promise<ChatSummary> {
  const summary: ChatSummary = {
    id: chat.id,
    title: chat.title,
    kind: kindOf(chat),
    unreadCount: chat.unread_count,
  }
  if (!detailed) return summary

  try {
    switch (chat.type._) {
      case 'chatTypePrivate':
      case 'chatTypeSecret': {
        const user = await client.invoke({ _: 'getUser', user_id: chat.type.user_id })
        summary.username = user.usernames?.active_usernames[0]
        if (user.type._ === 'userTypeBot') {
          summary.kind = 'bot'
        }
        break
      }
      case 'chatTypeBasicGroup': {
        const group = await client.invoke({
          _: 'getBasicGroup',
          basic_group_id: chat.type.basic_group_id,
        })
        summary.memberCount = group.member_count
        const full = await client
          .invoke({ _: 'getBasicGroupFullInfo', basic_group_id: chat.type.basic_group_id })
          .catch(() => null)
        if (full?.description) summary.description = full.description
        break
      }
      case 'chatTypeSupergroup': {
        const [supergroup, full] = await Promise.all([
          client.invoke({ _: 'getSupergroup', supergroup_id: chat.type.supergroup_id }),
          client
            .invoke({ _: 'getSupergroupFullInfo', supergroup_id: chat.type.supergroup_id })
            .catch(() => null),
        ])
        summary.username = supergroup.usernames?.active_usernames[0]
        summary.memberCount = full?.member_count || supergroup.member_count
        if (full?.description) summary.description = full.description
        summary.kind = supergroup.is_channel ? 'channel' : 'supergroup'
        break
      }
      default:
        break
    }
  } catch (error) {
    log.debug(`Could not load full info for chat ${chat.id}: ${errorMessage(error)}`)
  }

  return summary
}

function normalizeUsername(value: string): string {
  return value.replace(/^@/, '')
}

function parseChatReference(
  input: string,
): { kind: 'id'; value: number } | { kind: 'username'; value: string } | { kind: 'query'; value: string } {
  const raw = input.trim()

  const link = raw.match(
    /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\/([A-Za-z0-9_]+)\/?$/i,
  )
  if (link) return { kind: 'username', value: link[1] }

  if (/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/\+/i.test(raw)) {
    throw new Error(
      'Invite links are not supported. Join the chat in Telegram first, then use its @username, numeric id, or exact title.',
    )
  }

  if (/^-?\d+$/.test(raw)) {
    const id = Number(raw)
    if (!Number.isSafeInteger(id)) {
      throw new Error(`Chat id is out of range: ${raw}`)
    }
    return { kind: 'id', value: id }
  }

  if (raw.startsWith('@')) return { kind: 'username', value: normalizeUsername(raw) }

  return { kind: 'query', value: raw }
}

async function getChatsByIds(client: Client, ids: number[]): Promise<Chat[]> {
  const chats: Chat[] = []
  for (const id of ids) {
    try {
      chats.push(await client.invoke({ _: 'getChat', chat_id: id }))
    } catch (error) {
      log.debug(`getChat(${id}) failed: ${errorMessage(error)}`)
    }
  }
  return chats
}

function pickExactTitle(chats: Chat[], query: string): Chat {
  const exact = chats.filter((chat) => chat.title.toLowerCase() === query.toLowerCase())
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) {
    const options = exact.map((chat) => `${chat.title} (id ${chat.id})`).join(', ')
    throw new Error(`Multiple chats match "${query}": ${options}. Use @username or a numeric id instead.`)
  }
  throw new Error(
    `No chat titled "${query}" was found. Use @username, a numeric id, or run discover_chats to find the right chat.`,
  )
}

/**
 * Resolve an allowlist entry to a chat. Supported forms:
 * @username, t.me/username, numeric chat id, or an exact chat title.
 */
export async function resolveChatReference(
  client: Client,
  input: string,
  cache?: Map<string, Chat>,
): Promise<Chat> {
  const key = input.trim().toLowerCase()
  const cached = cache?.get(key)
  if (cached) return cached

  const ref = parseChatReference(input)
  let chat: Chat

  if (ref.kind === 'id') {
    chat = await client.invoke({ _: 'getChat', chat_id: ref.value })
  } else if (ref.kind === 'username') {
    chat = await client.invoke({ _: 'searchPublicChat', username: ref.value })
  } else {
    const local = await client.invoke({ _: 'searchChats', query: ref.value, limit: 50 })
    let chats = await getChatsByIds(client, local.chat_ids)

    try {
      chat = pickExactTitle(chats, ref.value)
    } catch (titleError) {
      // Fall back to a server-side title search, then treat the input as a username.
      try {
        const server = await client.invoke({ _: 'searchChatsOnServer', query: ref.value })
        chats = await getChatsByIds(client, server.chat_ids)
        chat = pickExactTitle(chats, ref.value)
      } catch {
        if (/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(ref.value)) {
          chat = await client.invoke({ _: 'searchPublicChat', username: ref.value })
        } else {
          throw titleError
        }
      }
    }
  }

  cache?.set(key, chat)
  return chat
}

export class ChatAccess {
  private byEntry = new Map<string, AllowedChat>()
  private byId = new Map<number, AllowedChat>()
  private refCache = new Map<string, Chat>()
  private loadPromise: Promise<void> | null = null
  private loaded = false
  private allowlistErrors: AllowlistError[] = []

  constructor(
    private readonly tg: TelegramClient,
    private readonly config: Config,
  ) {}

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    if (!this.loadPromise) {
      this.loadPromise = this.load().finally(() => {
        this.loadPromise = null
      })
    }
    await this.loadPromise
  }

  private async load(): Promise<void> {
    this.allowlistErrors = []

    if (this.config.allowedChats.length === 0) {
      this.loaded = true
      return
    }

    const client = await this.tg.requireAuthorized()

    for (const entry of this.config.allowedChats) {
      try {
        const chat = await resolveChatReference(client, entry, this.refCache)
        const summary = await describeChat(client, chat, true)
        const allowed: AllowedChat = { entry, chatId: chat.id, summary }
        this.byEntry.set(entry.trim().toLowerCase(), allowed)
        this.byId.set(chat.id, allowed)
        log.debug(`Allowlisted "${entry}" -> ${chat.id} (${chat.title})`)
      } catch (error) {
        const message = errorMessage(error)
        this.allowlistErrors.push({ entry, error: message })
        log.warn(`Could not resolve allowlisted chat "${entry}": ${message}`)
      }
    }

    this.loaded = true
  }

  isAllowed(chatId: number): boolean {
    return this.byId.has(chatId)
  }

  async resolve(input: string): Promise<AllowedChat> {
    await this.ensureLoaded()
    if (this.byId.size === 0) {
      const details = this.allowlistErrors.length
        ? ` Unresolved entries: ${this.allowlistErrors.map((item) => `"${item.entry}" (${item.error})`).join('; ')}.`
        : ''
      throw new Error(
        `No chats are allowlisted. Add @username, numeric id, or exact title entries to allowedChats in config.json, then restart the MCP server.${details}`,
      )
    }

    const key = input.trim().toLowerCase()
    const exact = this.byEntry.get(key)
    if (exact) return exact

    let chat: Chat
    try {
      const client = await this.tg.requireAuthorized()
      chat = await resolveChatReference(client, input, this.refCache)
    } catch (error) {
      throw new Error(`Could not resolve chat "${input}": ${errorMessage(error)}`)
    }
    const allowed = this.byId.get(chat.id)
    if (!allowed) {
      throw new Error(
        `Chat "${input}" resolves to "${chat.title}" (id ${chat.id}), which is not in the allowlist. ` +
          'Add it to allowedChats in config.json to grant access.',
      )
    }
    return allowed
  }

  async list(): Promise<{ chats: AllowedChat[]; errors: AllowlistError[] }> {
    await this.ensureLoaded()
    return { chats: [...this.byId.values()], errors: this.allowlistErrors }
  }
}

export type DiscoveredChat = ChatSummary & { allowed: boolean }

async function loadChatList(client: Client, limit: number): Promise<number[]> {
  const batches = Math.max(1, Math.ceil(limit / 100))
  for (let i = 0; i < batches; i += 1) {
    try {
      await client.invoke({ _: 'loadChats', limit: 100 })
    } catch (error) {
      if (error instanceof TDLibError && error.code === 404) break
      throw error
    }
  }
  const result = await client.invoke({ _: 'getChats', limit })
  return result.chat_ids
}

export async function discoverChats(
  tg: TelegramClient,
  access: ChatAccess,
  query: string | undefined,
  limit: number,
): Promise<{ chats: DiscoveredChat[]; hint: string }> {
  const client = await tg.requireAuthorized()
  await access.ensureLoaded()

  let ids: number[]
  let hint: string

  const trimmed = query?.trim()
  if (trimmed) {
    const local = await client.invoke({ _: 'searchChats', query: trimmed, limit })
    ids = local.chat_ids
    hint =
      'Search results come from chats Telegram already knows locally. Use a numeric chat id or @username in the allowlist for stability.'
    if (ids.length === 0) {
      const publicChats = await client
        .invoke({ _: 'searchPublicChats', query: trimmed })
        .catch(() => ({ chat_ids: [] as number[] }))
      ids = publicChats.chat_ids
      hint = 'No local chats matched, so public Telegram chats were searched instead.'
    }
  } else {
    ids = await loadChatList(client, limit)
    hint =
      'Lists chats from the top of your main chat list. Pass a query to search for less recent chats.'
  }

  const uniqueIds = [...new Set(ids)].slice(0, limit)
  const chats: DiscoveredChat[] = []
  for (const id of uniqueIds) {
    try {
      const chat = await client.invoke({ _: 'getChat', chat_id: id })
      const summary = await describeChat(client, chat, false)
      chats.push({ ...summary, allowed: access.isAllowed(chat.id) })
    } catch (error) {
      log.debug(`Skipping chat ${id} during discovery: ${errorMessage(error)}`)
    }
  }

  return { chats, hint }
}
