# Security Policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/aminkh17/telegrammcp/security/advisories/new).
Do not open a public issue for security problems.

Reports are especially welcome for:

- reading or sending outside the chat allowlist,
- sending a message without the user's approval,
- leaking session data, API credentials, or message content.

## Protecting your own data

This server runs locally with access to your Telegram account. Never commit or share
`config.json`, the `data/` directory (your Telegram session), or your API credentials.
They are gitignored by default.
