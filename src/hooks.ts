import { AUTH_RETRY_COOLDOWN_MS, PROVIDER_ID, SUBSCRIBE_URL } from "./constants.ts"
import { isAuthRetryable } from "./models.ts"
import type { MintResponse } from "./oauth.ts"
import type { Model, Provider } from "@opencode/plugin"

/**
 * Structural subset of the provider editor used here, so the registration
 * logic stays testable without a live plugin context.
 */
export type ProviderEditorLike = {
  get(providerID: string): { provider: { integrationID?: unknown } } | undefined
  add(input: { info: Provider.Info; models: readonly Model.Info[] }): void
  readonly models: { set(providerID: string, models: readonly Model.Info[]): void }
}

/**
 * Registers the `muse` provider once, then keeps its account-specific model
 * inventory in sync on later reloads. A provider the user configured
 * themselves (no muse integration) is left untouched.
 */
export function registerMuseProvider(
  editor: ProviderEditorLike,
  info: Provider.Info,
  models: readonly Model.Info[],
): void {
  const existing = editor.get(PROVIDER_ID)
  if (!existing) {
    editor.add({ info, models })
  } else if (existing.provider.integrationID === PROVIDER_ID) {
    editor.models.set(PROVIDER_ID, models)
  }
}

export function subscriptionActionUrl(minted: MintResponse): string | undefined {
  if (minted.require_payment || minted.is_subs_active === false) {
    return minted.action_url ?? SUBSCRIBE_URL
  }
  return undefined
}

export function subscriptionRequiredMessage(minted: MintResponse): string | undefined {
  const url = subscriptionActionUrl(minted)
  if (!url) return undefined
  return `muse: subscription action required — ${url} (finish there, then run \`opencode auth login muse\` again)`
}

/**
 * One-line subscription summary for the login screen (plugin stdout is not
 * surfaced anywhere, so the visible `instructions` field carries it).
 */
export function subscriptionSummary(minted: MintResponse): string {
  const parts: string[] = []
  if (minted.subs_tier_name) parts.push(minted.subs_tier_name)
  const window = minted.subs_usage?.window
  const weekly = minted.subs_usage?.weekly
  const usage: string[] = []
  if (window?.used_percent !== undefined) usage.push(`${window.used_percent}% window`)
  if (weekly?.used_percent !== undefined) usage.push(`${weekly.used_percent}% weekly`)
  if (usage.length > 0) parts.push(`usage ${usage.join(", ")}`)
  const action = subscriptionActionUrl(minted)
  if (action) parts.push(`action required: ${action}`)
  return parts.length > 0 ? ` (${parts.join(" · ")})` : ""
}

export type AuthRetryEvent = {
  readonly sessionID: string
  readonly attempt: number
  readonly error: { status?: number; type?: string; message?: string }
  decision: { retry: false } | { retry: true; delay: number }
}

export type AuthRetryDeps = {
  /** Last re-mint timestamp per session; entries expire after the cooldown. */
  readonly lastRetryAt: Map<string, number>
  resolveToken(): Promise<string | undefined>
  mint(token: string): Promise<unknown>
  now?(): number
  cooldownMs?: number
}

/**
 * Re-mints at most once per session per cooldown window after an auth failure.
 * The timestamp is recorded before minting so a persistently failing mint is
 * throttled too instead of being retried on every attempt.
 */
export async function retryWithFreshKey(event: AuthRetryEvent, deps: AuthRetryDeps): Promise<boolean> {
  if (!isAuthRetryable(event.error)) return false

  const now = deps.now?.() ?? Date.now()
  const cooldown = deps.cooldownMs ?? AUTH_RETRY_COOLDOWN_MS
  for (const [sessionID, at] of deps.lastRetryAt) {
    if (now - at >= cooldown) deps.lastRetryAt.delete(sessionID)
  }
  const last = deps.lastRetryAt.get(event.sessionID)
  if (last !== undefined && now - last < cooldown) return false

  const token = await deps.resolveToken()
  if (!token) return false

  deps.lastRetryAt.set(event.sessionID, now)
  await deps.mint(token)
  event.decision = { retry: true, delay: 0 }
  return true
}
