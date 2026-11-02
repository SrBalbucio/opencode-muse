import { Plugin } from "@opencode/plugin"
import { ACCOUNT_URL, OAUTH_METHOD_ID, PLUGIN_ID, PROVIDER_ID } from "./constants.ts"
import {
  credentialLabel,
  providerInfo,
  resolveEffort,
  staticModelInfos,
  toBridgeCredential,
} from "./models.ts"
import { readMuseCliAuth, writeMuseCliAuth } from "./muse-store.ts"
import { museUsageText, resolveMuseBinary, usageSummaryLine } from "./bridge/cli.ts"
import { startBridgeServer, type BridgeServer } from "./bridge/server.ts"
import { registerMuseProvider } from "./hooks.ts"
import { pollDeviceToken, startDeviceAuth } from "./oauth.ts"

// IMPORTANT: this module's default export is the whole plugin definition.
// Keep supporting modules beside it; the loader treats every top-level file
// as a plugin candidate, so only this file may default-export a definition.

/**
 * Muse subscription for opencode, routed through the official muse CLI:
 *
 * - setup hosts the local bridge (OpenAI-compatible HTTP server on loopback)
 *   in-process; `provider.transform` contributes the `muse` provider pointing
 *   at it, so Meta only ever sees the CLI's own client.
 * - `integration.transform` registers the device-flow login as GUIDANCE: a
 *   healthy `muse login` on the machine is reused with no browser; the device
 *   flow itself validates the account but model credentials still come from
 *   the CLI's auth.json.
 * - `http.request` stamps the bridge's bearer token; reasoning effort maps
 *   the semantic variant to the CLI's `--reasoning-effort` ladder.
 */

function bridgeLoginErrorMessage(): string {
  const hint = resolveMuseBinary()
    ? "run `muse login` in a terminal, then retry"
    : "install the muse CLI first (see the opencode-muse README), then run `muse login`"
  return `muse: no usable CLI login — ${hint}`
}

async function probeCliUsage(): Promise<string> {
  const bin = resolveMuseBinary()
  if (!bin) throw new Error(bridgeLoginErrorMessage())
  return await museUsageText({ bin, extraFirstArg: process.env.MUSE_BIN_EXTRA })
}

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const source = { models: staticModelInfos() }

    // In-process bridge. A reload re-runs setup and binds a fresh ephemeral
    // port; the previous socket simply goes unreferenced until process exit.
    let bridge: BridgeServer
    try {
      bridge = await startBridgeServer({})
    } catch (err) {
      throw new Error(`muse: could not start the local bridge — ${String(err)}`)
    }

    await ctx.provider.transform((editor) => {
      registerMuseProvider(editor, providerInfo({ baseURL: `${bridge.url}/v1`, apiKey: bridge.token }), source.models)
    })

    await ctx.integration.transform((editor) => {
      editor.method.update({
        integrationID: PROVIDER_ID,
        method: {
          id: OAUTH_METHOD_ID,
          type: "oauth",
          label: "Muse Code (via muse CLI)",
        },
        authorize: async () => {
          // Fast path: a working `muse login` needs no browser at all.
          const existing = await readMuseCliAuth()
          if (existing) {
            try {
              const usage = await probeCliUsage()
              const summary = usageSummaryLine(usage)
              return {
                url: ACCOUNT_URL,
                instructions: `Using the existing muse CLI login${summary ? ` — ${summary}` : ""}. No browser approval needed; model traffic runs through the CLI.`,
                mode: "auto",
                callback: Promise.resolve(toBridgeCredential(existing.email ? { email: existing.email } : {})),
              } as const
            } catch {
              // auth.json exists but the CLI rejects it — fall through so the
              // device flow can at least revalidate the account and guide.
            }
          }

          const device = await startDeviceAuth()
          return {
            url: device.verification_uri_complete ?? device.verification_uri,
            instructions: `Open the URL and approve code ${device.user_code}. This continues automatically once approved.`,
            mode: "auto",
            callback: (async () => {
              const tokens = await pollDeviceToken(device)

              // Experimental zero-terminal path: store the token where the
              // CLI reads it, then verify through the CLI itself.
              if (process.env.MUSE_EXPERIMENTAL_AUTH_WRITE === "1") {
                await writeMuseCliAuth(tokens.access_token)
              }

              const after = await readMuseCliAuth()
              if (!after) {
                throw new Error(
                  "muse: device login approved, but this machine has no muse CLI credentials — run `muse login` in a terminal with the same account; opencode routes model traffic through the CLI.",
                )
              }
              try {
                await probeCliUsage()
              } catch {
                throw new Error(
                  "muse: device login approved, but the muse CLI rejected this machine's stored login — run `muse login` again with the same account.",
                )
              }
              return toBridgeCredential(after.email ? { email: after.email } : {})
            })(),
          } as const
        },
        refresh: async (credential) => {
          // The marker carries no secret; the CLI's own login is the real
          // credential. Refresh just keeps opencode from nagging about expiry.
          return { ...credential, expires: Date.now() + 24 * 60 * 60 * 1000 }
        },
        label: (credential) => credentialLabel(credential),
      })
    })

    await ctx.session.hook(
      "http.request",
      async (event) => {
        const headers = new Headers(event.request.headers)
        headers.set("authorization", `Bearer ${bridge.token}`)
        event.request = new Request(event.request, { headers })
      },
      { providerID: PROVIDER_ID },
    )

    const applyEffort = async (event: {
      model: { id: string; variant?: string | undefined }
      options: Record<string, unknown>
    }) => {
      try {
        const { data: models } = await ctx.model.list()
        const model = models.find((entry) => entry.providerID === PROVIDER_ID && entry.id === event.model.id)
        const effort = resolveEffort(event.model, model)
        if (effort) event.options.reasoningEffort = effort
      } catch {
        // Server default applies.
      }
    }
    for (const name of ["context", "compaction", "generate", "title"] as const) {
      await ctx.session.hook(name, applyEffort, { providerID: PROVIDER_ID })
    }
  },
})
