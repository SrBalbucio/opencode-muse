// Device-flow auth, exactly like `muse login`. The plugin performs the flow
// only to guide and validate sign-in: model traffic never carries an OAuth
// token — it goes through the local bridge into the official muse binary,
// which reads its own credential store.
//
// The old mint/list-models calls (POST /muse-code/key, GET /muse-code/models)
// are gone: Meta closed the direct-subscription API path to external harness
// clients, and the CLI is now the sole API surface.

import {
  OAUTH_CLIENT_ID,
  OAUTH_DEVICE_AUTH_URL,
  OAUTH_DEVICE_GRANT,
  OAUTH_TOKEN_URL,
  REASONING_EFFORTS,
  USER_AGENT,
} from "./constants.ts"

export type DeviceAuth = {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in: number
  interval: number
}

export type TokenResponse = {
  access_token: string
  refresh_token?: string
  token_type?: string
  expires_in?: number
}

export type OAuthError = Error & { code?: string; status?: number }

function oauthError(message: string, code?: unknown, status?: number): OAuthError {
  const err = new Error(message) as OAuthError
  if (typeof code === "string") err.code = code
  if (status !== undefined) err.status = status
  return err
}

async function postForm<T>(url: string, params: Record<string, string>): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(60_000),
  })
  const text = await res.text()
  let json: any = {}
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    throw oauthError(`muse oauth: non-JSON response from ${url} (status ${res.status}): ${text.slice(0, 200)}`)
  }
  if (!res.ok) {
    const code = json?.error ?? json?.title ?? res.status
    const detail = json?.error_description ?? json?.Detail ?? json?.error?.message ?? `HTTP ${res.status}`
    throw oauthError(`muse oauth ${code}: ${detail} (${url})`, json?.error, res.status)
  }
  return json as T
}

/**
 * Starts the RFC 8628 device flow, exactly like `muse login`: only
 * `client_id` is sent, no scope.
 */
export async function startDeviceAuth(): Promise<DeviceAuth> {
  const json = await postForm<Record<string, unknown>>(OAUTH_DEVICE_AUTH_URL, {
    client_id: OAUTH_CLIENT_ID,
  })
  const device_code = json.device_code
  const user_code = json.user_code
  const verification_uri = json.verification_uri
  if (typeof device_code !== "string" || !device_code || typeof user_code !== "string" || !user_code) {
    throw oauthError("muse oauth: device authorization response missing device_code or user_code")
  }
  if (typeof verification_uri !== "string" || !verification_uri.startsWith("https://")) {
    throw oauthError("muse oauth: device authorization response missing verification_uri")
  }
  const verification_uri_complete =
    typeof json.verification_uri_complete === "string" &&
    json.verification_uri_complete.startsWith("https://")
      ? json.verification_uri_complete
      : undefined
  let expires_in = typeof json.expires_in === "number" ? json.expires_in : 900
  if (!(expires_in >= 60)) expires_in = 60
  if (expires_in > 1800) expires_in = 1800
  const interval = typeof json.interval === "number" && json.interval > 0 ? json.interval : 5
  return { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval }
}

/**
 * Polls the token endpoint until the user approves the device code, the code
 * expires, or an unexpected error occurs. Honors `authorization_pending` and
 * `slow_down` per RFC 8628.
 */
export async function pollDeviceToken(device: DeviceAuth): Promise<TokenResponse> {
  let interval = Math.max(1, device.interval ?? 5) * 1000
  const deadline = Date.now() + device.expires_in * 1000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval))
    try {
      const tokens = await postForm<TokenResponse>(OAUTH_TOKEN_URL, {
        client_id: OAUTH_CLIENT_ID,
        device_code: device.device_code,
        grant_type: OAUTH_DEVICE_GRANT,
      })
      if (!tokens.access_token) throw oauthError("muse oauth: token response carried an empty access token")
      return tokens
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === "authorization_pending") continue
      if (code === "slow_down") {
        interval += 5_000
        continue
      }
      if (code === "access_denied") throw oauthError("muse oauth: the sign-in request was denied")
      if (code === "expired_token") throw oauthError("muse oauth: the sign-in request expired — run login again")
      throw err
    }
  }
  throw oauthError("muse oauth: the sign-in request expired before it was approved")
}

/**
 * Normalizes a user-facing reasoning effort to the CLI's `--reasoning-effort`
 * value, or undefined when the default should apply. Through the bridge the
 * CLI's own ladder applies — including `ultra`, which the old direct API
 * rejected but the binary accepts.
 */
export function mapEffort(effort: unknown): string | undefined {
  if (typeof effort !== "string") return undefined
  const normalized = effort.trim().toLowerCase()
  if (normalized === "" || normalized === "auto" || normalized === "default") return undefined
  if (normalized === "off") return "none"
  if (REASONING_EFFORTS.has(normalized)) return normalized
  return undefined
}
