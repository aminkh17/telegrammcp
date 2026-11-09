const debugEnabled = /^(1|true|yes)$/i.test(process.env.TELEGRAM_MCP_DEBUG ?? '')

function format(args: unknown[]): string {
  return args
    .map((value) => {
      if (typeof value === 'string') return value
      try {
        return JSON.stringify(value)
      } catch {
        return String(value)
      }
    })
    .join(' ')
}

export const log = {
  debug(...args: unknown[]): void {
    if (debugEnabled) console.error('[telegram-mcp:debug]', format(args))
  },
  info(...args: unknown[]): void {
    console.error('[telegram-mcp]', format(args))
  },
  warn(...args: unknown[]): void {
    console.error('[telegram-mcp:warn]', format(args))
  },
  error(...args: unknown[]): void {
    console.error('[telegram-mcp:error]', format(args))
  },
}
