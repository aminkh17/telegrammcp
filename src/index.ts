#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { log } from './log.js'
import { callDaemon } from './rpc.js'

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

function jsonResult(value: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  }
}

function errorResult(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error)
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  }
}

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return jsonResult(await fn())
  } catch (error) {
    log.debug('Tool error:', error instanceof Error ? error.stack : String(error))
    return errorResult(error)
  }
}

function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return callDaemon<T>(method, params)
}

async function main(): Promise<void> {
  const server = new McpServer(
    { name: 'telegram-readonly', version: '0.1.0' },
    {
      instructions:
        'Read-only Telegram access restricted to an allowlist of chats. ' +
        'If not signed in, call auth_status, then auth_start/auth_code/auth_password. ' +
        'Only read tools are provided; sending, editing, deleting, joining, and leaving are impossible.',
    },
  )

  // ---------------------------------------------------------------- auth

  server.registerTool(
    'auth_status',
    {
      title: 'Telegram auth status',
      description:
        'Check whether the Telegram session is signed in and which login step is required. ' +
        'Start here if Telegram tools return an authentication error.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => run(() => call('auth_status')),
  )

  server.registerTool(
    'auth_start',
    {
      title: 'Start Telegram login',
      description:
        'Start phone-number login. Telegram sends a login code to the account. ' +
        'After calling this, call auth_code with the code, and auth_password if two-step verification is enabled.',
      inputSchema: {
        phoneNumber: z
          .string()
          .min(6)
          .describe('International phone number including country code, for example +14155550123.'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ phoneNumber }) => run(() => call('auth_start', { phoneNumber })),
  )

  server.registerTool(
    'auth_code',
    {
      title: 'Submit Telegram login code',
      description: 'Submit the login code Telegram sent to the account.',
      inputSchema: {
        code: z.string().min(1).describe('The login code from Telegram (digits, sometimes with letters).'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ code }) => run(() => call('auth_code', { code })),
  )

  server.registerTool(
    'auth_password',
    {
      title: 'Submit Telegram two-step password',
      description: 'Submit the two-step verification password, if the account has one enabled.',
      inputSchema: {
        password: z.string().min(1).describe('The Telegram two-step verification password.'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ password }) => run(() => call('auth_password', { password })),
  )

  server.registerTool(
    'auth_logout',
    {
      title: 'Log out of Telegram',
      description:
        'Log out and destroy all local Telegram session data. This requires network access and cannot be undone without logging in again.',
      inputSchema: {
        confirm: z.boolean().describe('Must be true to confirm logout.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ confirm }) => run(() => call('auth_logout', { confirm })),
  )

  // ---------------------------------------------------------------- discovery

  server.registerTool(
    'discover_chats',
    {
      title: 'Discover Telegram chats',
      description:
        'List chat ids and titles to help populate the allowlist. This returns metadata only, never message contents. ' +
        'Requires allowChatDiscovery in config.json. Pass a query to search, or omit it to list top chats.',
      inputSchema: {
        query: z.string().optional().describe('Optional text to search in chat titles and usernames.'),
        limit: z.number().int().min(1).max(500).optional().describe('Maximum number of chats to return (default 100).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, limit }) => run(() => call('discover_chats', { query, limit })),
  )

  server.registerTool(
    'list_allowed_chats',
    {
      title: 'List allowlisted chats',
      description: 'List every chat in the allowlist, with ids, types, usernames, and any resolution errors.',
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => run(() => call('list_allowed_chats')),
  )

  server.registerTool(
    'get_chat',
    {
      title: 'Get chat info',
      description: 'Get details about one allowlisted chat: title, type, username, member count, and description.',
      inputSchema: {
        chat: z.string().min(1).describe('Allowlisted chat: @username, t.me link, numeric id, or exact title.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ chat }) => run(() => call('get_chat', { chat })),
  )

  // ---------------------------------------------------------------- messages

  server.registerTool(
    'get_messages',
    {
      title: 'Read chat history',
      description:
        'Read recent messages from one allowlisted chat, oldest first. ' +
        'Paginate older messages by passing the previous nextBeforeMessageId as beforeMessageId.',
      inputSchema: {
        chat: z.string().min(1).describe('Allowlisted chat: @username, t.me link, numeric id, or exact title.'),
        limit: z.number().int().min(1).max(100).optional().describe('Number of messages to return (default from config).'),
        beforeMessageId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Return messages older than this message id. Use nextBeforeMessageId from a previous call.'),
        sinceDate: z
          .union([z.string(), z.number()])
          .optional()
          .describe('Only return messages at or after this ISO date or Unix timestamp in seconds.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ chat, limit, beforeMessageId, sinceDate }) =>
      run(() => call('get_messages', { chat, limit, beforeMessageId, sinceDate })),
  )

  server.registerTool(
    'search_messages',
    {
      title: 'Search messages',
      description:
        'Search messages by text inside one allowlisted chat, or across all allowlisted chats. Results are newest first.',
      inputSchema: {
        chat: z
          .string()
          .min(1)
          .optional()
          .describe('Optional allowlisted chat to search. Omit to search every allowlisted chat.'),
        query: z.string().min(1).describe('Text to search for.'),
        limit: z.number().int().min(1).max(100).optional().describe('Maximum number of results (default from config).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ chat, query, limit }) =>
      run(() => call('search_messages', { chat, query, limit })),
  )

  server.registerTool(
    'get_message',
    {
      title: 'Get one message',
      description: 'Fetch a single message by id from an allowlisted chat.',
      inputSchema: {
        chat: z.string().min(1).describe('Allowlisted chat: @username, t.me link, numeric id, or exact title.'),
        messageId: z.number().int().positive().describe('Message id within the chat.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ chat, messageId }) => run(() => call('get_message', { chat, messageId })),
  )

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log.info(`Received ${signal}; closing MCP transport (the shared Telegram daemon keeps running)`)
    await server.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection:', reason instanceof Error ? reason.stack : String(reason))
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
  log.info('Telegram read-only MCP proxy is listening on stdio')
}

main().catch((error) => {
  log.error('Fatal error:', error instanceof Error ? error.stack : String(error))
  process.exit(1)
})
