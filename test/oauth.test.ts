import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "node:test"
import { OAUTH_CLIENT_ID, OAUTH_DEVICE_AUTH_URL, OAUTH_TOKEN_URL } from "../src/constants.ts"
import { mapEffort, pollDeviceToken, startDeviceAuth } from "../src/oauth.ts"

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

describe("mapEffort", () => {
  it("passes valid tiers through lowercased", () => {
    assert.equal(mapEffort("high"), "high")
    assert.equal(mapEffort("HIGH"), "high")
    assert.equal(mapEffort("xhigh"), "xhigh")
    assert.equal(mapEffort("none"), "none")
    assert.equal(mapEffort("max"), "max")
    // Through the CLI, `ultra` is a first-class tier now.
    assert.equal(mapEffort("ultra"), "ultra")
  })
  it("maps aliases", () => {
    assert.equal(mapEffort("off"), "none")
    assert.equal(mapEffort("OFF"), "none")
  })
  it("returns undefined for auto/unset/unknown", () => {
    assert.equal(mapEffort(undefined), undefined)
    assert.equal(mapEffort("auto"), undefined)
    assert.equal(mapEffort(""), undefined)
    assert.equal(mapEffort("bogus"), undefined)
    assert.equal(mapEffort(42), undefined)
  })
})

describe("startDeviceAuth", () => {
  it("posts client_id and parses the device response", async () => {
    let seenUrl = ""
    let seenBody = ""
    globalThis.fetch = (async (url: any, init: any) => {
      seenUrl = String(url)
      seenBody = String(init?.body ?? "")
      return jsonResponse({
        device_code: "dc",
        user_code: "UC-1",
        verification_uri: "https://example.com/verify",
        verification_uri_complete: "https://example.com/verify?code=UC-1",
        expires_in: 900,
        interval: 5,
      })
    }) as typeof fetch

    const device = await startDeviceAuth()
    assert.equal(seenUrl, OAUTH_DEVICE_AUTH_URL)
    assert.ok(seenBody.includes(`client_id=${OAUTH_CLIENT_ID}`))
    assert.equal(device.device_code, "dc")
    assert.equal(device.user_code, "UC-1")
    assert.equal(device.verification_uri_complete, "https://example.com/verify?code=UC-1")
    assert.equal(device.expires_in, 900)
    assert.equal(device.interval, 5)
  })

  it("rejects responses missing codes", async () => {
    globalThis.fetch = (async () => jsonResponse({ user_code: "x" })) as typeof fetch
    await assert.rejects(startDeviceAuth, /device_code or user_code/)
  })
})

describe("pollDeviceToken", () => {
  it("waits through authorization_pending then returns the token", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      if (calls === 1) return jsonResponse({ error: "authorization_pending" }, 400)
      return jsonResponse({ access_token: "dca:tok", token_type: "Bearer" })
    }) as typeof fetch

    const device = {
      device_code: "dc",
      user_code: "UC",
      verification_uri: "https://example.com/verify",
      expires_in: 900,
      interval: 0, // no wait in tests (clamped to 1s below)
    }
    // Interval is clamped to >=1s; speed the loop up by monkey-patching wait.
    const realSetTimeout = globalThis.setTimeout
    // @ts-expect-error test-only override of the wait inside pollDeviceToken
    globalThis.setTimeout = (fn: () => void, _ms?: number, ...rest: unknown[]) =>
      realSetTimeout(fn, 1, ...rest)
    try {
      const tokens = await pollDeviceToken(device)
      assert.equal(tokens.access_token, "dca:tok")
      assert.equal(calls, 2)
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
  })

  it("surfaces access_denied", async () => {
    globalThis.fetch = (async () => jsonResponse({ error: "access_denied" }, 403)) as typeof fetch
    const device = { device_code: "dc", user_code: "UC", verification_uri: "https://x", expires_in: 900, interval: 0 }
    const realSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 1)) as typeof setTimeout
    try {
      await assert.rejects(pollDeviceToken(device), /denied/)
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
  })
})
