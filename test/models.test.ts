import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { CREDENTIAL_TTL_MS, DEFAULT_MODEL_ID, OAUTH_METHOD_ID, PROVIDER_ID } from "../src/constants.ts"
import {
  credentialLabel,
  isMuseOAuthCredential,
  isValidEffort,
  providerInfo,
  resolveEffort,
  staticModelInfos,
  toBridgeCredential,
  toModelInfo,
  toModelInfos,
} from "../src/models.ts"
import type { MuseModelInfo } from "../src/models.ts"

function meta(overrides = {}) {
  return {
    name: "m",
    family: "avocado",
    release_date: "2026-09-02",
    attachment: true,
    reasoning: true,
    temperature: false,
    tool_call: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    limit: { context: 1007997, output: 128000 },
    options: { reasoningEffort: "high", temperature: 0.9, top_p: 0.9 },
    variants: {
      low: { reasoningEffort: "low" },
      xhigh: { reasoningEffort: "xhigh", selector: { description: "deep" } },
    },
    ...overrides,
  }
}

describe("providerInfo", () => {
  it("registers the openai-compatible package against the bridge", () => {
    const info = providerInfo({ baseURL: "http://127.0.0.1:9999/v1", apiKey: "tok" })
    assert.equal(info.id, PROVIDER_ID)
    assert.equal(info.package, "@opencode/ai/providers/openai-compatible")
    const settings = info.settings as Record<string, unknown>
    assert.equal(settings.baseURL, "http://127.0.0.1:9999/v1")
    assert.equal(settings.apiKey, "tok")
    assert.equal(info.integrationID, PROVIDER_ID)
    assert.equal(info.activation, "enabled")
  })
})

describe("toModelInfo", () => {
  it("maps discovery metadata to capabilities, limits, and settings", () => {
    const model = toModelInfo({ id: "m", metadata: { "muse-code": meta() } })!
    assert.equal(model.id, "m")
    assert.equal(model.providerID, PROVIDER_ID)
    assert.equal(model.name, "m")
    assert.equal(model.capabilities.tools, true)
    assert.deepEqual(model.capabilities.input, ["text", "image"])
    assert.deepEqual(model.capabilities.output, ["text"])
    assert.equal(model.limit.context, 1007997)
    assert.equal(model.limit.output, 128000)
    assert.equal(model.status, "active")
    assert.equal(model.enabled, true)
    const settings = model.settings as Record<string, unknown>
    assert.equal(settings.reasoningEffort, "high")
    assert.equal(settings.temperature, 0.9)
    assert.equal(settings.topP, 0.9)
  })

  it("maps variants to id/settings pairs without extra fields", () => {
    const model = toModelInfo({ id: "m", metadata: { "muse-code": meta() } })!
    const low = model.variants.find((v) => v.id === "low")
    assert.deepEqual((low as { settings: unknown }).settings, { reasoningEffort: "low" })
    const xhigh = model.variants.find((v) => v.id === "xhigh")
    assert.deepEqual((xhigh as { settings: unknown }).settings, { reasoningEffort: "xhigh" })
  })

  it("falls back when metadata is missing", () => {
    const model = toModelInfo({ id: "m" })!
    assert.equal(model.name, "m")
    assert.ok(model.limit.context > 0)
    assert.ok(model.limit.output > 0)
  })

  it("skips hidden models in lists", () => {
    const discovered: MuseModelInfo[] = [
      { id: "a", metadata: { "muse-code": meta({ name: "a" }) } },
      { id: "hidden", metadata: { "muse-code": meta({ name: "hidden", is_hidden: true }) } },
    ]
    const models = toModelInfos(discovered)
    assert.deepEqual(models.map((m) => m.id), ["a"])
  })
})

describe("staticModelInfos", () => {
  it("contains the default model with the full effort ladder including ultra", () => {
    const models = staticModelInfos()
    const current = models.find((m) => m.id === DEFAULT_MODEL_ID)!
    assert.ok(current)
    assert.ok(current.limit.context > 0)
    assert.ok(current.limit.output > 0)
    assert.deepEqual(
      current.variants.map((v) => v.id).sort(),
      ["high", "low", "max", "medium", "minimal", "ultra", "xhigh"],
    )
  })
})

describe("resolveEffort", () => {
  const model = {
    settings: { reasoningEffort: "high" },
    variants: [{ id: "low", settings: { reasoningEffort: "low" } }, { id: "ultra", settings: { reasoningEffort: "ultra" } }],
  }
  it("prefers the selected variant then model settings", () => {
    assert.equal(resolveEffort({ variant: "low" }, model), "low")
    assert.equal(resolveEffort({ variant: "ultra" }, model), "ultra")
    assert.equal(resolveEffort({}, model), "high")
    assert.equal(resolveEffort({ variant: "missing" }, model), "high")
  })
  it("returns undefined when nothing applies", () => {
    assert.equal(resolveEffort({}, undefined), undefined)
    assert.equal(resolveEffort({}, {}), undefined)
    assert.equal(resolveEffort({}, { settings: { reasoningEffort: "bogus" } }), undefined)
  })
})

describe("marker credential", () => {
  it("carries metadata but no secrets", () => {
    const before = Date.now()
    const credential = toBridgeCredential({ email: "a@b.c" })
    assert.equal(credential.type, "oauth")
    assert.equal(credential.methodID, OAUTH_METHOD_ID)
    assert.equal(credential.access, "bridge")
    assert.equal(credential.refresh, "bridge")
    assert.ok(credential.expires >= before + CREDENTIAL_TTL_MS - 1000)
    assert.equal(credentialLabel(credential), "a@b.c")
    assert.equal(isMuseOAuthCredential(credential), true)
  })

  it("omits empty metadata and rejects other credential shapes", () => {
    const credential = toBridgeCredential()
    assert.equal(credential.metadata, undefined)
    assert.equal(credentialLabel(credential), undefined)
    assert.equal(isMuseOAuthCredential({ type: "oauth", methodID: "other" }), false)
    assert.equal(isMuseOAuthCredential({ type: "key", key: "x" }), false)
    assert.equal(isMuseOAuthCredential(undefined), false)
  })
})

describe("isValidEffort", () => {
  it("accepts the CLI ladder including ultra", () => {
    for (const tier of ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]) {
      assert.equal(isValidEffort(tier), true, tier)
    }
    assert.equal(isValidEffort("bogus"), false)
  })
})
