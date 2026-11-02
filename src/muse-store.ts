import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export type MuseCliAuth = {
  accessToken: string
  apiBaseUrl?: string
  email?: string
}

/**
 * Read-only view of the `muse` CLI's credential store. The bridge spawns the
 * CLI, which authenticates from this store — opencode itself never needs the
 * token.
 *
 * This module never writes by default: like the `muse` launcher, it only
 * reads. `writeMuseCliAuth` exists behind MUSE_EXPERIMENTAL_AUTH_WRITE=1 for
 * the zero-terminal login spike (see README).
 */
export function museAuthPath(): string {
  if (process.env.MUSE_AUTH_PATH) return process.env.MUSE_AUTH_PATH
  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config")
  return path.join(configHome, "muse", "auth.json")
}

export async function readMuseCliAuth(): Promise<MuseCliAuth | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(museAuthPath(), "utf8")) as {
      providers?: { meta?: Record<string, unknown> }
    }
    const meta = parsed?.providers?.meta
    if (!meta || typeof meta !== "object") return undefined
    if (meta.mechanism !== "oauth") return undefined
    const accessToken = meta.access_token
    if (typeof accessToken !== "string" || !accessToken) return undefined
    const apiBaseUrl = typeof meta.api_base_url === "string" ? meta.api_base_url : undefined
    const email = typeof meta.user_email === "string" && meta.user_email ? meta.user_email : undefined
    return { accessToken, apiBaseUrl, email }
  } catch {
    return undefined
  }
}

/**
 * EXPERIMENTAL (MUSE_EXPERIMENTAL_AUTH_WRITE=1): stores a device-flow token
 * in the CLI's format so `muse` runs without a separate `muse login`. The
 * stored token replaces any existing one and drops the stale api_key so the
 * CLI re-derives it; every other field is preserved.
 */
export async function writeMuseCliAuth(accessToken: string): Promise<void> {
  if (process.env.MUSE_EXPERIMENTAL_AUTH_WRITE !== "1") {
    throw new Error("muse: auth write requires MUSE_EXPERIMENTAL_AUTH_WRITE=1")
  }
  if (!accessToken) throw new Error("muse: refusing to store an empty token")
  const target = museAuthPath()
  let document: { providers?: { meta?: Record<string, unknown> } } = {}
  try {
    document = JSON.parse(await fs.readFile(target, "utf8")) as typeof document
  } catch {
    document = {}
  }
  document.providers = document.providers ?? {}
  const previous = (document.providers.meta as Record<string, unknown> | undefined) ?? {}
  const next: Record<string, unknown> = { ...previous }
  delete next.api_key // stale for the new token; the CLI re-mints its own
  next.mechanism = "oauth"
  next.obtained_via = "device_code"
  next.access_token = accessToken
  if (typeof next.api_base_url !== "string" || !next.api_base_url) {
    next.api_base_url = "https://api.meta.ai/v1"
  }
  document.providers.meta = next
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, `${JSON.stringify(document, null, 2)}\n`, "utf8")
}
