import { TDLibError, type Client } from 'tdl'
import type {
  Chat,
  FormattedText,
  Message,
  MessageContent,
  MessageOrigin,
  MessageSender,
  User,
} from 'tdlib-types'
import type { AllowedChat, ChatAccess, ChatSummary } from './chats.js'
import type { TelegramClient } from './tdlib.js'
import { log } from './log.js'

export type FormattedSender = {
  kind: 'user' | 'chat'
  id: number
  name: string
}

export type FormattedMessage = {
  id: number
  date?: string
  editedAt?: string
  sender?: FormattedSender
  /** Present on cross-chat search results. */
  chat?: { id: number; title: string }
  type: string
  text?: string
  textTruncated?: boolean
  media?: Record<string, unknown>
  replyToMessageId?: number
  forwardedFrom?: {
    kind: 'user' | 'chat' | 'channel' | 'hidden' | 'unknown'
    id?: number
    messageId?: number
    name?: string
    date?: string
  }
  link?: string
}

const EMPTY = ''

function isoDate(unixSeconds: number | undefined): string | undefined {
  if (!unixSeconds) return undefined
  return new Date(unixSeconds * 1000).toISOString()
}

function textOf(value: FormattedText | undefined): string {
  return value?.text ?? EMPTY
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: `${text.slice(0, max)}… [truncated]`, truncated: true }
}

type ContentSummary = {
  text?: string
  media?: Record<string, unknown>
}

function summarizeContent(content: MessageContent): ContentSummary {
  switch (content._) {
    case 'messageText':
      return { text: content.text.text }
    case 'messagePhoto':
      return { text: content.caption.text, media: { type: 'photo' } }
    case 'messageVideo':
      return {
        text: content.caption.text,
        media: {
          type: 'video',
          duration: content.video.duration,
          width: content.video.width,
          height: content.video.height,
          fileName: content.video.file_name || undefined,
        },
      }
    case 'messageAnimation':
      return {
        text: content.caption.text,
        media: { type: 'animation', duration: content.animation.duration },
      }
    case 'messageAudio':
      return {
        text: content.caption.text,
        media: {
          type: 'audio',
          title: content.audio.title || undefined,
          performer: content.audio.performer || undefined,
          duration: content.audio.duration,
          fileName: content.audio.file_name || undefined,
        },
      }
    case 'messageDocument':
      return {
        text: content.caption.text,
        media: {
          type: 'document',
          fileName: content.document.file_name || undefined,
          mimeType: content.document.mime_type || undefined,
        },
      }
    case 'messageVoiceNote':
      return {
        text: content.caption.text,
        media: { type: 'voice_note', duration: content.voice_note.duration },
      }
    case 'messageVideoNote':
      return { media: { type: 'video_note', duration: content.video_note.duration } }
    case 'messageSticker':
      return {
        media: { type: 'sticker', emoji: content.sticker.emoji || undefined },
      }
    case 'messageAnimatedEmoji':
      return { text: content.emoji }
    case 'messagePoll': {
      const options = content.poll.options.map((option) => `- ${option.text.text}`).join('\n')
      const header = `${content.poll.question.text}${content.poll.is_closed ? ' (closed)' : ''}`
      return {
        text: options ? `${header}\n${options}` : header,
        media: {
          type: 'poll',
          totalVoterCount: content.poll.total_voter_count,
          isAnonymous: content.poll.is_anonymous,
        },
      }
    }
    case 'messageLocation':
      return {
        text: `Location: ${content.location.latitude}, ${content.location.longitude}`,
        media: { type: 'location' },
      }
    case 'messageVenue':
      return {
        text: `${content.venue.title} — ${content.venue.address}`,
        media: { type: 'venue' },
      }
    case 'messageContact':
      return {
        text: `${content.contact.first_name} ${content.contact.last_name}`.trim(),
        media: { type: 'contact', phoneNumber: content.contact.phone_number },
      }
    case 'messageGame':
      return { text: content.game.title, media: { type: 'game' } }
    case 'messageDice':
      return {
        text: `Dice ${content.emoji}${content.value ? ` = ${content.value}` : ''}`,
        media: { type: 'dice' },
      }
    case 'messageCall':
      return {
        text: `${content.is_video ? 'Video' : 'Voice'} call, ${content.duration}s`,
        media: { type: 'call' },
      }
    case 'messageExpiredPhoto':
      return { text: '[Photo expired]', media: { type: 'expired_photo' } }
    case 'messageExpiredVideo':
      return { text: '[Video expired]', media: { type: 'expired_video' } }
    case 'messageExpiredVideoNote':
      return { text: '[Video note expired]', media: { type: 'expired_video_note' } }
    case 'messageExpiredVoiceNote':
      return { text: '[Voice note expired]', media: { type: 'expired_voice_note' } }
    case 'messageUnsupported':
      return { media: { type: 'unsupported' } }
    case 'messageChatChangeTitle':
      return { text: `Chat title changed to "${content.title}"`, media: { type: 'service' } }
    case 'messagePinMessage':
      return {
        text: `Pinned message ${content.message_id || ''}`.trim(),
        media: { type: 'service' },
      }
    case 'messageChatAddMembers':
      return {
        text: `Members added: ${content.member_user_ids.join(', ')}`,
        media: { type: 'service' },
      }
    case 'messageChatJoinByLink':
      return { text: 'Member joined via invite link', media: { type: 'service' } }
    case 'messageChatJoinByRequest':
      return { text: 'Member joined by request', media: { type: 'service' } }
    case 'messageChatDeleteMember':
      return { text: 'Member removed', media: { type: 'service' } }
    default:
      return { media: { type: content._ } }
  }
}

export class MessageFormatter {
  private userNames = new Map<number, string>()
  private chatNames = new Map<number, string>()

  constructor(
    private readonly client: Client,
    private readonly maxTextLength: number,
  ) {}

  private async userName(userId: number): Promise<string> {
    const cached = this.userNames.get(userId)
    if (cached) return cached

    let name = `User ${userId}`
    try {
      const user: User = await this.client.invoke({ _: 'getUser', user_id: userId })
      name =
        [user.first_name, user.last_name].filter(Boolean).join(' ') ||
        user.usernames?.active_usernames[0] ||
        name
    } catch (error) {
      log.debug(`Could not resolve user ${userId}: ${String(error)}`)
    }
    this.userNames.set(userId, name)
    return name
  }

  private async chatName(chatId: number): Promise<string> {
    const cached = this.chatNames.get(chatId)
    if (cached) return cached

    let name = `Chat ${chatId}`
    try {
      const chat: Chat = await this.client.invoke({ _: 'getChat', chat_id: chatId })
      name = chat.title || name
    } catch (error) {
      log.debug(`Could not resolve chat ${chatId}: ${String(error)}`)
    }
    this.chatNames.set(chatId, name)
    return name
  }

  private async sender(sender: MessageSender): Promise<FormattedSender> {
    if (sender._ === 'messageSenderUser') {
      return { kind: 'user', id: sender.user_id, name: await this.userName(sender.user_id) }
    }
    return { kind: 'chat', id: sender.chat_id, name: await this.chatName(sender.chat_id) }
  }

  private async forwardedFrom(origin: MessageOrigin | undefined): Promise<FormattedMessage['forwardedFrom']> {
    if (!origin) return undefined
    switch (origin._) {
      case 'messageOriginUser':
        return { kind: 'user', id: origin.sender_user_id, name: await this.userName(origin.sender_user_id) }
      case 'messageOriginChat':
        return { kind: 'chat', id: origin.sender_chat_id, name: await this.chatName(origin.sender_chat_id) }
      case 'messageOriginChannel':
        return {
          kind: 'channel',
          id: origin.chat_id,
          messageId: origin.message_id,
          name: await this.chatName(origin.chat_id),
        }
      case 'messageOriginHiddenUser':
        return { kind: 'hidden', name: origin.sender_name }
      default:
        return { kind: 'unknown' }
    }
  }

  async format(message: Message, chat?: ChatSummary): Promise<FormattedMessage> {
    const content = summarizeContent(message.content)
    const formatted: FormattedMessage = {
      id: message.id,
      date: isoDate(message.date),
      type: message.content._,
    }

    if (message.edit_date) formatted.editedAt = isoDate(message.edit_date)
    formatted.sender = await this.sender(message.sender_id)

    if (content.text) {
      const clipped = truncate(content.text, this.maxTextLength)
      formatted.text = clipped.text
      if (clipped.truncated) formatted.textTruncated = true
    }
    if (content.media) formatted.media = content.media

    if (message.reply_to?._ === 'messageReplyToMessage') {
      formatted.replyToMessageId = message.reply_to.message_id
    }

    const forward = await this.forwardedFrom(message.forward_info?.origin)
    if (forward) {
      formatted.forwardedFrom = {
        ...forward,
        date: isoDate(message.forward_info?.date),
      }
    }

    if (chat?.username && (chat.kind === 'channel' || chat.kind === 'supergroup')) {
      formatted.link = `https://t.me/${chat.username}/${message.id}`
    }

    return formatted
  }
}

function tdErrorMessage(error: unknown): string {
  if (error instanceof TDLibError) return `${error.message} (code ${error.code})`
  if (error instanceof Error) return error.message
  return String(error)
}

export type GetMessagesOptions = {
  chat: string
  limit: number
  beforeMessageId?: number
  sinceDate?: number
  maxTextLength: number
}

export async function getMessages(
  tg: TelegramClient,
  access: ChatAccess,
  options: GetMessagesOptions,
): Promise<{
  chat: ChatSummary
  messages: FormattedMessage[]
  nextBeforeMessageId?: number
  note: string
}> {
  const client = await tg.requireAuthorized()
  const allowed: AllowedChat = await access.resolve(options.chat)

  let history: Message[]
  try {
    const page = await client.invoke({
      _: 'getChatHistory',
      chat_id: allowed.chatId,
      from_message_id: options.beforeMessageId ?? 0,
      offset: 0,
      limit: options.limit,
      only_local: false,
    })
    history = page.messages.filter((message): message is Message => message !== null)
  } catch (error) {
    throw new Error(`Could not read messages from "${allowed.summary.title}": ${tdErrorMessage(error)}`)
  }

  const oldestReturned = history.length > 0 ? history[history.length - 1].id : undefined
  let selected = history
  if (options.sinceDate) {
    selected = selected.filter((message) => message.date >= options.sinceDate!)
  }
  selected = [...selected].sort((a, b) => a.id - b.id)

  const formatter = new MessageFormatter(client, options.maxTextLength)
  const messages: FormattedMessage[] = []
  for (const message of selected) {
    messages.push(await formatter.format(message, allowed.summary))
  }

  return {
    chat: allowed.summary,
    messages,
    nextBeforeMessageId: oldestReturned,
    note: 'Messages are in chronological order (oldest first). Pass nextBeforeMessageId as beforeMessageId to fetch older messages.',
  }
}

export type SearchMessagesOptions = {
  chat?: string
  query: string
  limit: number
  maxTextLength: number
}

export async function searchMessages(
  tg: TelegramClient,
  access: ChatAccess,
  options: SearchMessagesOptions,
): Promise<{ results: FormattedMessage[]; warnings: string[]; note: string }> {
  const client = await tg.requireAuthorized()
  const targets: AllowedChat[] = options.chat
    ? [await access.resolve(options.chat)]
    : (await access.list()).chats

  if (targets.length === 0) {
    throw new Error('No chats are allowlisted, so there is nothing to search.')
  }

  const perChatLimit = options.chat ? options.limit : Math.max(5, Math.ceil(options.limit / targets.length))
  const warnings: string[] = []
  const matches: Array<{ message: Message; target: AllowedChat }> = []

  for (const target of targets) {
    try {
      const found = await client.invoke({
        _: 'searchChatMessages',
        chat_id: target.chatId,
        query: options.query,
        from_message_id: 0,
        offset: 0,
        limit: perChatLimit,
      })
      for (const message of found.messages) {
        matches.push({ message, target })
      }
    } catch (error) {
      const warning = `Search failed in "${target.summary.title}": ${tdErrorMessage(error)}`
      warnings.push(warning)
      log.debug(warning)
    }
  }

  matches.sort((a, b) => b.message.date - a.message.date || b.message.id - a.message.id)
  const formatter = new MessageFormatter(client, options.maxTextLength)
  const results: FormattedMessage[] = []
  for (const match of matches.slice(0, options.limit)) {
    const formatted = await formatter.format(match.message, match.target.summary)
    formatted.chat = { id: match.target.summary.id, title: match.target.summary.title }
    results.push(formatted)
  }

  return {
    results,
    warnings,
    note: 'Results are newest first. Search runs inside the allowlisted chats only.',
  }
}

export async function getMessage(
  tg: TelegramClient,
  access: ChatAccess,
  chat: string,
  messageId: number,
  maxTextLength: number,
): Promise<{ chat: ChatSummary; message: FormattedMessage }> {
  const client = await tg.requireAuthorized()
  const allowed = await access.resolve(chat)

  try {
    const message = await client.invoke({
      _: 'getMessage',
      chat_id: allowed.chatId,
      message_id: messageId,
    })
    const formatter = new MessageFormatter(client, maxTextLength)
    return {
      chat: allowed.summary,
      message: await formatter.format(message, allowed.summary),
    }
  } catch (error) {
    throw new Error(
      `Could not get message ${messageId} from "${allowed.summary.title}": ${tdErrorMessage(error)}`,
    )
  }
}
