# Telegram MCP

A local [Model Context Protocol](https://modelcontextprotocol.io) server that connects to your
personal Telegram account through **TDLib**, Telegram's official client library. It is
**read-only by default**, limited to an explicit allowlist of chats, with optional
**approval-gated sending**.

- Every tool resolves its target and rejects anything outside the allowlist.
- Sending is off unless enabled, and every message requires your explicit approval in an
  approval prompt. The AI agent cannot approve on your behalf.
- No edit, delete, forward, join, leave, or reaction operations exist in the server.
- The Telegram session, database, and config stay on your machine and are gitignored.
- One shared daemon owns TDLib, so any number of MCP client sessions can use it at once.

## Requirements

- Node.js 20 or newer
- A Telegram account
- Telegram API credentials from [my.telegram.org](https://my.telegram.org)

## Setup

```bash
git clone https://github.com/aminkh17/telegrammcp.git
cd telegrammcp
npm install
npm run build
cp config.example.json config.json
```

Then edit `config.json` and set `apiId` and `apiHash`.

### API credentials

This project does not ship API credentials. Create your own application at
[my.telegram.org](https://my.telegram.org) → **API development tools**, then copy its `api_id`
and `api_hash` into `config.json`:

```json
{
  "apiId": 123456,
  "apiHash": "your_api_hash_here"
}
```

`config.json` is ignored by git and never leaves your machine.

## Authentication

Authentication is done through MCP tools, so it works entirely from your MCP client:

1. `auth_status` — see what step is needed.
2. `auth_start` with your international phone number, e.g. `+14155550123`.
3. `auth_code` with the code Telegram sent.
4. `auth_password` with your two-step verification password, if enabled.

The session is persisted under `data/tdlib`, so this is a one-time flow. `auth_logout` destroys
the local session and cached Telegram data.

## MCP client setup

### OpenCode

Add the server to your global `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "telegram": {
      "type": "local",
      "command": ["node", "/absolute/path/to/telegrammcp/dist/index.js"],
      "enabled": true
    }
  }
}
```

### Other MCP clients

Use the built entry point as a stdio server:

```json
{
  "mcpServers": {
    "telegram": {
      "command": "node",
      "args": ["/absolute/path/to/telegrammcp/dist/index.js"]
    }
  }
}
```

## Tools

| Tool | Purpose |
|---|---|
| `auth_status` | Check login state and required step |
| `auth_start` / `auth_code` / `auth_password` | Phone login flow |
| `auth_logout` | Destroy the local session (requires `confirm: true`) |
| `discover_chats` | List chat ids/titles (metadata only) to build the allowlist |
| `list_allowed_chats` | Show resolved allowlist entries and errors |
| `get_chat` | Chat details: type, username, member count, description |
| `get_messages` | Read history, oldest first, with pagination |
| `search_messages` | Search text in one or all allowlisted chats |
| `get_message` | Fetch one message by id |
| `send_message` | Send a text message to an allowlisted chat, only after user approval |

## Sending messages (approval required)

Sending is disabled by default. To enable it, set this in `config.json`:

```json
{
  "allowSending": true
}
```

Every `send_message` call then works like this:

1. The server checks that sending is enabled and that the chat is allowlisted, and stores the
   exact message as a short-lived draft.
2. The server asks **you** to approve it through an MCP approval prompt
   ([form elicitation](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation)).
   The prompt shows the target chat, any reply target, and the full text.
3. Only if you turn on **Send this message** and submit is that exact draft sent. Declining,
   cancelling, or ignoring the prompt for 10 minutes sends nothing.

The approval prompt comes from the server, not from the AI, so the agent cannot approve its own
messages. If your MCP client does not support approval prompts, sending is refused.

Messages are plain text, up to 4096 characters, and can optionally reply to a message in the same
chat or be sent silently. Sending uses the same allowlist as reading.

## Allowlist

Only chats listed in `allowedChats` can be read. Each entry accepts:

| Form | Example |
|---|---|
| Username | `@durov` or `durov` |
| Public link | `https://t.me/durov` |
| Numeric chat id | `-1001234567890` |
| Exact chat title | `Telegram Tips` |

Numeric ids and usernames are the most stable. If two chats share a title, resolution fails and
asks for an id or username.

To find chats:

1. Keep `"allowChatDiscovery": true` (default).
2. Call `discover_chats`, optionally with a query, to get ids and titles.
3. Add the ids or usernames to `allowedChats` in `config.json`.
4. Optionally set `"allowChatDiscovery": false` to make even chat metadata unavailable.

`config.json` is re-read on every tool call, so allowlist and limit changes apply immediately.
No restart is needed.

Discovery never returns message contents.

## Configuration reference

`config.json`:

| Key | Default | Meaning |
|---|---|---|
| `apiId`, `apiHash` | unset | Telegram API credentials from my.telegram.org |
| `allowedChats` | `[]` | Chats that may be read |
| `allowChatDiscovery` | `true` | Enable `discover_chats` metadata listing |
| `allowSending` | `false` | Enable `send_message` (each message still needs approval) |
| `defaultMessageLimit` | `30` | Default page size |
| `maxMessageLimit` | `100` | Upper bound for `limit` parameters |
| `tearOffMessageTextAt` | `4000` | Max characters per message text |
| `daemonIdleTimeoutSeconds` | `600` | Idle time before the shared daemon exits |
| `verbosityLevel` | `1` | TDLib log verbosity (stderr) |

Environment overrides:

- `TELEGRAM_MCP_CONFIG` — absolute path to `config.json`
- `TELEGRAM_MCP_DATA_DIR` — absolute path for the TDLib database and files
- `TELEGRAM_MCP_DEBUG=1` — verbose MCP-level logging to stderr

## Shared daemon

TDLib allows only one process to open a database at a time. MCP clients usually start one server
process per session, so every `dist/index.js` is a thin proxy: the first tool call starts a
detached `dist/daemon.js` that owns TDLib, and all sessions talk to it over `data/daemon.sock`.

- The daemon starts automatically on demand. There is only ever one.
- After `daemonIdleTimeoutSeconds` of inactivity it closes TDLib, removes the socket, and exits.
  The next tool call starts a fresh daemon.
- `config.json` is reloaded per request. Changing `allowedChats` or limits takes effect
  immediately; changing `apiId`/`apiHash` recreates the TDLib client on the next request.
- Daemon logs go to `data/daemon.log` (rotated to `data/daemon.log.old` at 5 MB).
- The socket is created with mode `0600`.

Useful commands:

```bash
# Show daemon health and PID
curl --unix-socket data/daemon.sock http://localhost/health

# Run the daemon in the foreground for debugging
npm run daemon

# Stop it manually (it restarts on the next tool call)
pkill -f 'telegrammcp/dist/daemon.js'
```

## Security model

- Reads only use TDLib `get*` and `search*` methods. The only write is `sendMessage`.
- The allowlist is enforced before any history, search, or send call.
- Sending requires `allowSending: true` plus explicit user approval of each exact message.
- Chat discovery is metadata-only and can be disabled.
- All logs go to stderr; stdout is reserved for MCP JSON-RPC.
- Daemon RPC uses a Unix socket with mode `0600`, so only your user can connect.
- API credentials, session data, and `config.json` are gitignored; nothing sensitive is in the repo.

The MCP client (your AI agent) can read messages from allowlisted chats. That is the intended
trust boundary. Do not allowlist chats you do not want an agent to read.

Approval is enforced on the MCP tool path. Any program running as your user, including an agent
with unrestricted shell access, could still use your local Telegram session directly. If that
matters, restrict shell access with your MCP client's permission settings.

## Troubleshooting

- **"Telegram API credentials are not configured"** — set `apiId` and `apiHash` in `config.json`.
- **Daemon problems** — check `data/daemon.log`; delete a stale `data/daemon.sock` if no daemon is running.
- **Signed out** — call `auth_status`, then `auth_start` to log in again.
- **"Sending is disabled"** — set `"allowSending": true` in `config.json`.
- **"This MCP client does not support approval prompts"** — use a client that supports MCP form
  elicitation; sending is refused otherwise.
- **Reboots** — nothing to do. The daemon starts again on the next tool call.

## Limitations

- Media is described, not downloaded. Message text and captions only.
- Secret chats and email-only login are not supported.
- Reading user accounts through unofficial automation is a grey area under Telegram's terms;
  this server is intentionally read-only and low-volume.
- Each machine or separate `data/` directory needs its own login and daemon.

## License

[MIT](LICENSE)
