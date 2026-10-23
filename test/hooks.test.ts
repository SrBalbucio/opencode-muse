import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { AUTH_RETRY_COOLDOWN_MS, PROVIDER_ID, SUBSCRIBE_URL } from "../src/constants.ts"
import {
  registerMuseProvider,
  retryWithFreshKey,
  subscriptionActionUrl,
  subscriptionRequiredMessage,
  subscriptionSummary,
  type AuthRetryDeps,
  type AuthRetryEvent,
  type ProviderEditorLike,
} from "../src/hooks.ts"
import { providerInfo, staticModelInfos } from "../src/models.ts"
import type { MintResponse } from "../src/oauth.ts"

function editorWith(existing: { integrationID?: unknown } | undefined) {
  const added: Array<{ info: ReturnType<typeof providerInfo>; models: ReturnType<typeof staticModelInfos> }> = []
  const updated: Array<{ providerID: string; models: ReturnType<typeof staticModelInfos> }> = []
  const editor: ProviderEditorLike = {
    get: (providerID) => {
      assert.equal(providerID, PROVIDER_ID)
      return existing === undefined ? undefined : { provider: existing }
    },
    add: (input) => {
      added.push(input as { info: ReturnType<typeof providerInfo>; models: ReturnType<typeof staticModelInfos> })
    },
    models: {
      set: (providerID, models) => {
        updated.push({ providerID, models: models as ReturnType<typeof staticModelInfos> })
      },
    },
  }
  return { editor, added, updated }
}

describe("registerMuseProvider", () => {
  it("adds the provider and its models when absent", () => {
    const { editor, added, updated } = editorWith(undefined)
    const models = staticModelInfos()
    registerMuseProvider(editor, providerInfo(), models)
    assert.equal(added.length, 1)
    assert.equal(added[0]!.info.id, PROVIDER_ID)
    assert.equal(added[0]!.models, models)
    assert.equal(updated.length, 0)
  })

  it("refreshes models for the plugin-owned provider", () => {
    const { editor, added, updated } = editorWith({ integrationID: PROVIDER_ID })
    const models = staticModelInfos().slice(0, 2)
    registerMuseProvider(editor, providerInfo(), models)
    assert.equal(added.length, 0)
    assert.equal(updated.length, 1)
    assert.equal(updated[0]!.providerID, PROVIDER_ID)
    assert.equal(updated[0]!.models, models)
  })

  it("leaves a user-defined provider untouched", () => {
    for (const existing of [{ integrationID: "other" }, {}]) {
      const { editor, added, updated } = editorWith(existing)
      registerMuseProvider(editor, providerInfo(), staticModelInfos())
      assert.equal(added.length, 0)
      assert.equal(updated.length, 0)
    }
  })
})

describe("subscription helpers", () => {
  const active: MintResponse = {
    api_key: "LLM_test",
    base_url: "https://api.meta.ai/v1",
    subs_tier_name: "Tier",
    is_subs_active: true,
    subs_usage: { window: { used_percent: 5 }, weekly: { used_percent: 7 } },
  }

  it("summarizes tier and usage for the login screen", () => {
    assert.equal(subscriptionSummary(active), " (Tier · usage 5% window, 7% weekly)")
    assert.equal(subscriptionActionUrl(active), undefined)
    assert.equal(subscriptionRequiredMessage(active), undefined)
  })

  it("flags an inactive subscription with the default subscribe URL", () => {
    const inactive = { ...active, is_subs_active: false }
    assert.equal(subscriptionActionUrl(inactive), SUBSCRIBE_URL)
    assert.match(subscriptionRequiredMessage(inactive)!, /subscription action required/)
    assert.ok(subscriptionRequiredMessage(inactive)!.includes(SUBSCRIBE_URL))
    assert.match(subscriptionSummary(inactive), /action required/)
  })

  it("prefers the server-provided action url", () => {
    const minted = { ...active, require_payment: true, action_url: "https://pay.example/x" }
    assert.equal(subscriptionActionUrl(minted), "https://pay.example/x")
  })

  it("returns a bare summary when there is nothing to report", () => {
    assert.equal(subscriptionSummary({ api_key: "k", base_url: "u" }), "")
  })
})

function retryEvent(error: AuthRetryEvent["error"], sessionID = "s1", attempt = 0): AuthRetryEvent {
  return { sessionID, attempt, error, decision: { retry: false } }
}

function retryDeps(overrides: Partial<AuthRetryDeps> = {}) {
  const minted: string[] = []
  const deps: AuthRetryDeps = {
    lastRetryAt: new Map(),
    resolveToken: async () => "dca:test",
    mint: async (token) => {
      minted.push(token)
    },
    ...overrides,
  }
  return { deps, minted }
}

describe("retryWithFreshKey", () => {
  it("re-mints and asks for one retry on an auth failure", async () => {
    const { deps, minted } = retryDeps()
    const event = retryEvent({ status: 401 })
    assert.equal(await retryWithFreshKey(event, deps), true)
    assert.deepEqual(minted, ["dca:test"])
    assert.deepEqual(event.decision, { retry: true, delay: 0 })
    assert.ok(deps.lastRetryAt.has("s1"))
  })

  it("throttles repeat mints for the same session until the cooldown passes", async () => {
    let now = 1_000
    const { deps, minted } = retryDeps({ now: () => now })
    assert.equal(await retryWithFreshKey(retryEvent({ status: 401 }), deps), true)

    const second = retryEvent({ status: 401 }, "s1", 1)
    assert.equal(await retryWithFreshKey(second, deps), false)
    assert.deepEqual(second.decision, { retry: false })
    assert.equal(minted.length, 1)

    now += AUTH_RETRY_COOLDOWN_MS
    assert.equal(await retryWithFreshKey(retryEvent({ status: 401 }, "s1", 2), deps), true)
    assert.equal(minted.length, 2)
  })

  it("throttles even when minting fails", async () => {
    const { deps } = retryDeps({
      mint: async () => {
        throw new Error("mint down")
      },
    })
    await assert.rejects(retryWithFreshKey(retryEvent({ status: 401 }), deps), /mint down/)
    assert.ok(deps.lastRetryAt.has("s1"))
    let calls = 0
    deps.mint = async () => {
      calls++
    }
    assert.equal(await retryWithFreshKey(retryEvent({ status: 401 }, "s1", 1), deps), false)
    assert.equal(calls, 0)
  })

  it("tracks sessions independently", async () => {
    const { deps, minted } = retryDeps({ now: () => 1_000 })
    assert.equal(await retryWithFreshKey(retryEvent({ status: 401 }, "a"), deps), true)
    assert.equal(await retryWithFreshKey(retryEvent({ status: 401 }, "b"), deps), true)
    assert.equal(minted.length, 2)
    assert.equal(deps.lastRetryAt.size, 2)
  })

  it("prunes stale session entries", async () => {
    let now = 100_000
    const { deps } = retryDeps({ now: () => now })
    deps.lastRetryAt.set("stale", 0)
    deps.lastRetryAt.set("recent", now - 1)
    assert.equal(await retryWithFreshKey(retryEvent({ status: 401 }, "s3"), deps), true)
    assert.equal(deps.lastRetryAt.has("stale"), false)
    assert.equal(deps.lastRetryAt.has("recent"), true)
    assert.equal(deps.lastRetryAt.has("s3"), true)
  })

  it("ignores non-auth errors", async () => {
    const { deps, minted } = retryDeps()
    const event = retryEvent({ status: 500, message: "boom" })
    assert.equal(await retryWithFreshKey(event, deps), false)
    assert.equal(minted.length, 0)
    assert.deepEqual(event.decision, { retry: false })
  })

  it("does nothing without a usable token", async () => {
    const { deps, minted } = retryDeps({ resolveToken: async () => undefined })
    assert.equal(await retryWithFreshKey(retryEvent({ status: 401 }), deps), false)
    assert.equal(minted.length, 0)
    assert.equal(deps.lastRetryAt.size, 0)
  })
})
