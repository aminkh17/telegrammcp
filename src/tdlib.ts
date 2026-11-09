import { configure, createClient, TDLibError, type Client } from 'tdl'
import { getTdjson } from 'prebuilt-tdlib'
import type { AuthorizationState, Update, User } from 'tdlib-types'
import { hasApiCredentials, type Config, type Paths } from './config.js'
import { log } from './log.js'

export type AuthAction = 'phone' | 'code' | 'password' | 'email' | 'registration' | 'other_device' | null

export type AuthStatus = {
  authorized: boolean
  state: string
  action: AuthAction
  message: string
  user?: { id: number; name: string; username?: string }
  codeInfo?: { phoneNumber: string; type: string; timeout: number }
  passwordHint?: string
  otherDeviceLink?: string
}

const TD_ERROR_MESSAGES: Record<string, string> = {
  PHONE_NUMBER_INVALID: 'Invalid phone number. Use international format, for example +14155550123.',
  PHONE_NUMBER_BANNED: 'This phone number is banned from Telegram.',
  PHONE_CODE_INVALID: 'The login code is incorrect.',
  PHONE_CODE_EXPIRED: 'The login code has expired. Call auth_start again.',
  PHONE_CODE_EMPTY: 'The login code is empty.',
  PASSWORD_HASH_INVALID: 'The two-step verification password is incorrect.',
  PASSWORD_RECOVERY_NA: 'Password recovery is not available for this account.',
  AUTH_RESTART: 'The login flow was restarted. Call auth_start again.',
  FLOOD_WAIT: 'Too many attempts. Wait a while before trying again.',
}

function describeTdError(error: unknown): string {
  if (error instanceof TDLibError) {
    const mapped = Object.entries(TD_ERROR_MESSAGES).find(([code]) => error.message.startsWith(code))
    const extra = mapped ? ` ${mapped[1]}` : ''
    return `Telegram error ${error.message} (code ${error.code}).${extra}`
  }
  if (error instanceof Error) return error.message
  return String(error)
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  if (digits.length <= 4) return phone
  return `${phone.startsWith('+') ? '+' : ''}${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`
}

function normalizePhone(input: string): string {
  let phone = input.trim().replace(/[\s\-().]/g, '')
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`
  if (!phone.startsWith('+')) {
    throw new Error('Phone number must be in international format starting with +, for example +14155550123.')
  }
  if (!/^\+\d{6,15}$/.test(phone)) {
    throw new Error('Phone number looks invalid. Use international format, for example +14155550123.')
  }
  return phone
}

function actionForState(state: AuthorizationState): AuthAction {
  switch (state._) {
    case 'authorizationStateWaitPhoneNumber':
      return 'phone'
    case 'authorizationStateWaitCode':
      return 'code'
    case 'authorizationStateWaitPassword':
      return 'password'
    case 'authorizationStateWaitEmailAddress':
    case 'authorizationStateWaitEmailCode':
      return 'email'
    case 'authorizationStateWaitRegistration':
      return 'registration'
    case 'authorizationStateWaitOtherDeviceConfirmation':
      return 'other_device'
    default:
      return null
  }
}

export class TelegramClient {
  private client: Client | null = null
  private opening: Promise<Client> | null = null
  private authState: AuthorizationState | null = null
  private stateWaiters = new Set<(state: AuthorizationState) => void>()
  private me: User | null = null

  constructor(
    private readonly config: Config,
    private readonly paths: Paths,
  ) {}

  get state(): AuthorizationState | null {
    return this.authState
  }

  async getClient(): Promise<Client> {
    if (this.client) return this.client
    if (!this.opening) {
      this.opening = this.open().finally(() => {
        this.opening = null
      })
    }
    return this.opening
  }

  private async open(): Promise<Client> {
    if (!hasApiCredentials(this.config)) {
      throw new Error(
        'Telegram API credentials are not configured. Create an application at ' +
          'https://my.telegram.org, then set "apiId" and "apiHash" in config.json.',
      )
    }

    configure({
      tdjson: getTdjson(),
      verbosityLevel: this.config.verbosityLevel,
    })

    log.info(`Opening TDLib database at ${this.paths.databaseDirectory}`)
    const client = createClient({
      apiId: this.config.apiId,
      apiHash: this.config.apiHash,
      databaseDirectory: this.paths.databaseDirectory,
      filesDirectory: this.paths.filesDirectory,
      skipOldUpdates: true,
      tdlibParameters: {
        use_message_database: true,
        use_secret_chats: false,
        use_chat_info_database: true,
        use_file_database: true,
        system_language_code: 'en',
        device_model: 'OpenCode Telegram MCP',
        system_version: `${process.platform} ${process.arch}`,
        application_version: '0.1.0',
      },
    })

    this.client = client
    client.on('update', this.handleUpdate)
    client.on('error', (error) => {
      log.error('TDLib error event:', error.message)
    })
    client.on('close', () => {
      log.info('TDLib client closed')
      this.client = null
      this.authState = null
      this.me = null
    })

    await this.waitForAuthState(
      (state) => state._ !== 'authorizationStateWaitTdlibParameters',
      30_000,
      'TDLib initialization',
    )
    return client
  }

  private handleUpdate = (update: Update): void => {
    if (update._ !== 'updateAuthorizationState') return
    this.authState = update.authorization_state
    log.debug('Authorization state:', update.authorization_state._)
    for (const waiter of [...this.stateWaiters]) {
      waiter(update.authorization_state)
    }
  }

  private waitForAuthState(
    predicate: (state: AuthorizationState) => boolean,
    timeoutMs: number,
    description: string,
  ): Promise<AuthorizationState> {
    if (this.authState && predicate(this.authState)) return Promise.resolve(this.authState)

    return new Promise((resolve, reject) => {
      const listener = (state: AuthorizationState): void => {
        if (!predicate(state)) return
        clearTimeout(timer)
        this.stateWaiters.delete(listener)
        resolve(state)
      }
      const timer = setTimeout(() => {
        this.stateWaiters.delete(listener)
        reject(
          new Error(
            `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${description}. ` +
              'Telegram may be slow, or another process may be using the same TDLib database.',
          ),
        )
      }, timeoutMs)
      this.stateWaiters.add(listener)
    })
  }

  private async runAuthAction(action: () => Promise<unknown>): Promise<void> {
    const previous = this.authState?._
    try {
      await action()
    } catch (error) {
      throw new Error(describeTdError(error))
    }
    await this.waitForAuthState((state) => state._ !== previous, 30_000, 'the next authorization step')
  }

  private async describeState(state: AuthorizationState, action: AuthAction): Promise<AuthStatus> {
    const base: AuthStatus = {
      authorized: state._ === 'authorizationStateReady',
      state: state._,
      action,
      message: '',
    }

    switch (state._) {
      case 'authorizationStateReady': {
        const client = await this.getClient()
        if (!this.me) {
          try {
            this.me = await client.invoke({ _: 'getMe' })
          } catch (error) {
            log.warn('Authorized but getMe failed:', error instanceof Error ? error.message : String(error))
          }
        }
        const name = this.me ? [this.me.first_name, this.me.last_name].filter(Boolean).join(' ') : ''
        base.message = `Signed in as ${name || 'Telegram user'}.`
        if (this.me) {
          base.user = {
            id: this.me.id,
            name,
            username: this.me.usernames?.active_usernames[0],
          }
        }
        break
      }
      case 'authorizationStateWaitTdlibParameters':
        base.message = 'TDLib is still initializing. Try again in a moment.'
        break
      case 'authorizationStateWaitPhoneNumber':
        base.message = 'Phone number required. Call auth_start with your international phone number (for example +14155550123).'
        break
      case 'authorizationStateWaitCode':
        base.message = 'Login code required. Call auth_code with the code Telegram sent you.'
        base.codeInfo = {
          phoneNumber: maskPhone(state.code_info.phone_number),
          type: state.code_info.type._,
          timeout: state.code_info.timeout,
        }
        break
      case 'authorizationStateWaitPassword':
        base.message = 'Two-step verification password required. Call auth_password.'
        base.passwordHint = state.password_hint
        break
      case 'authorizationStateWaitEmailAddress':
      case 'authorizationStateWaitEmailCode':
        base.message =
          'This account is configured for email-based login, which this server does not support. ' +
          'Log in with the official Telegram app first, or use an account that signs in by phone.'
        break
      case 'authorizationStateWaitRegistration':
        base.message = 'This phone number has no Telegram account yet. Sign up in the official Telegram app first.'
        break
      case 'authorizationStateWaitOtherDeviceConfirmation':
        base.message = 'Confirm the login on another Telegram device using the link below.'
        base.otherDeviceLink = state.link
        break
      case 'authorizationStateWaitPremiumPurchase':
        base.message = 'Telegram is asking for a Premium purchase before login; this is not supported.'
        break
      case 'authorizationStateLoggingOut':
        base.message = 'Logging out.'
        break
      case 'authorizationStateClosing':
        base.message = 'TDLib is closing.'
        break
      case 'authorizationStateClosed':
        base.message = 'TDLib is closed. Call any tool to reopen it.'
        break
      default:
        base.message = `Unhandled authorization state: ${(state as unknown as { _: string })._}`
    }

    return base
  }

  async getAuthStatus(): Promise<AuthStatus> {
    await this.getClient()
    if (!this.authState) throw new Error('TDLib is not initialized yet. Try again in a moment.')
    return this.describeState(this.authState, actionForState(this.authState))
  }

  /** Return an initialized client or fail with a clear sign-in hint. */
  async requireAuthorized(): Promise<Client> {
    const client = await this.getClient()
    if (this.authState?._ === 'authorizationStateReady') return client

    const status = this.authState
      ? await this.describeState(this.authState, actionForState(this.authState))
      : null
    throw new Error(
      `Not signed in to Telegram${status ? ` (${status.state})` : ''}. ` +
        (status?.message ?? 'Call auth_status for details.'),
    )
  }

  async startAuth(phoneInput: string): Promise<AuthStatus> {
    const client = await this.getClient()
    const state = this.authState
    if (!state) throw new Error('TDLib is not initialized yet. Try again in a moment.')

    if (state._ === 'authorizationStateReady') return this.describeState(state, null)
    if (state._ === 'authorizationStateWaitCode' || state._ === 'authorizationStateWaitPassword') {
      return this.describeState(state, actionForState(state))
    }
    if (state._ !== 'authorizationStateWaitPhoneNumber') {
      throw new Error(`Cannot start phone login in state ${state._}. Call auth_status for details.`)
    }

    const phoneNumber = normalizePhone(phoneInput)
    await this.runAuthAction(() =>
      client.invoke({
        _: 'setAuthenticationPhoneNumber',
        phone_number: phoneNumber,
        settings: {
          _: 'phoneNumberAuthenticationSettings',
          allow_flash_call: false,
          is_current_phone_number: false,
          allow_sms_retriever_api: false,
          authentication_tokens: [],
        },
      }),
    )

    return this.getAuthStatus()
  }

  async submitCode(code: string): Promise<AuthStatus> {
    const client = await this.getClient()
    const state = this.authState
    if (!state) throw new Error('TDLib is not initialized yet. Try again in a moment.')
    if (state._ === 'authorizationStateReady') return this.describeState(state, null)
    if (state._ !== 'authorizationStateWaitCode') {
      throw new Error(`No login code is expected right now (state: ${state._}). Call auth_status for details.`)
    }

    const trimmed = code.trim()
    if (!trimmed) throw new Error('Login code is empty.')
    await this.runAuthAction(() => client.invoke({ _: 'checkAuthenticationCode', code: trimmed }))
    return this.getAuthStatus()
  }

  async submitPassword(password: string): Promise<AuthStatus> {
    const client = await this.getClient()
    const state = this.authState
    if (!state) throw new Error('TDLib is not initialized yet. Try again in a moment.')
    if (state._ === 'authorizationStateReady') return this.describeState(state, null)
    if (state._ !== 'authorizationStateWaitPassword') {
      throw new Error(`No password is expected right now (state: ${state._}). Call auth_status for details.`)
    }

    if (!password) throw new Error('Password is empty.')
    await this.runAuthAction(() => client.invoke({ _: 'checkAuthenticationPassword', password }))
    return this.getAuthStatus()
  }

  async logout(): Promise<AuthStatus> {
    const client = await this.getClient()
    if (!this.authState || this.authState._ !== 'authorizationStateReady') {
      throw new Error('Not signed in; there is no session to log out of.')
    }

    try {
      await client.invoke({ _: 'logOut' })
    } catch (error) {
      throw new Error(describeTdError(error))
    }
    await this.waitForAuthState(
      (state) => state._ === 'authorizationStateClosed',
      60_000,
      'logout to complete',
    )

    return {
      authorized: false,
      state: 'authorizationStateClosed',
      action: null,
      message: 'Logged out and local Telegram data was destroyed. Call auth_start to sign in again.',
    }
  }

  async close(): Promise<void> {
    const client = this.client
    this.client = null
    if (!client) return
    try {
      await client.close()
    } catch (error) {
      log.warn('Error while closing TDLib client:', error instanceof Error ? error.message : String(error))
    }
  }
}
