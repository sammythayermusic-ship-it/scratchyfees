import type { RuntimeEnv } from '../env'
import type { EventsSink } from './events-sink'
import { jsonLineLogger, TelegramAlerter, type AlertLogger } from './telegram'

/**
 * Alerts entry point: build the process-wide Alerter from env. Every event always lands in the sink
 * (Postgres `events` via DbEventsSink) and the log; Telegram delivery is added only when both
 * TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set — otherwise the alerter is log + sink only.
 */

export type AlertsEnv = Pick<
  RuntimeEnv,
  'TELEGRAM_BOT_TOKEN' | 'TELEGRAM_CHAT_ID' | 'TELEGRAM_DIGEST_SECONDS'
> &
  Partial<Pick<RuntimeEnv, 'CHAIN_MODE' | 'SOLANA_CLUSTER' | 'DEPLOY_ID'>>

export interface CreateAlerterOptions {
  logger?: AlertLogger
  fetchImpl?: typeof fetch
  now?: () => Date
}

export function createAlerter(
  env: AlertsEnv,
  sink: EventsSink,
  opts: CreateAlerterOptions = {},
): TelegramAlerter {
  const logger = opts.logger ?? jsonLineLogger
  const token = env.TELEGRAM_BOT_TOKEN?.trim() || undefined
  const chatId = env.TELEGRAM_CHAT_ID?.trim() || undefined
  if (!token !== !chatId) {
    try {
      logger.warn(
        { alert: 'alerts.config', hasBotToken: !!token, hasChatId: !!chatId },
        'TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must both be set; alerts are log + Postgres only',
      )
    } catch {
      /* ignore */
    }
  }
  return new TelegramAlerter({
    botToken: token && chatId ? token : undefined,
    chatId: token && chatId ? chatId : undefined,
    digestSeconds: env.TELEGRAM_DIGEST_SECONDS,
    sink,
    logger,
    label: alertLabel(env),
    fetchImpl: opts.fetchImpl,
    now: opts.now,
  })
}

/** "devnet·local", "mainnet-beta·prod-1", "memory·local" — prefixed to every Telegram message */
export function alertLabel(
  env: Partial<Pick<RuntimeEnv, 'CHAIN_MODE' | 'SOLANA_CLUSTER' | 'DEPLOY_ID'>>,
): string {
  const cluster = env.CHAIN_MODE === 'memory' ? 'memory' : env.SOLANA_CLUSTER
  return [cluster, env.DEPLOY_ID].filter((s): s is string => !!s).join('·')
}

export { DbEventsSink, MemoryEventsSink, NullEventsSink, type EventsSink } from './events-sink'
export { TelegramAlerter, jsonLineLogger, type AlertLogger, type TelegramAlerterOptions } from './telegram'
export type { AlertEvent, Alerter, Severity } from './types'
