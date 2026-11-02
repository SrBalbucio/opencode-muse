import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { PROVIDER_ID } from "../src/constants.ts"
import { registerMuseProvider, type ProviderEditorLike } from "../src/hooks.ts"
import { providerInfo, staticModelInfos } from "../src/models.ts"

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
    registerMuseProvider(editor, providerInfo({ baseURL: "http://127.0.0.1:1/v1", apiKey: "t" }), models)
    assert.equal(added.length, 1)
    assert.equal(added[0]!.info.id, PROVIDER_ID)
    assert.equal(added[0]!.models, models)
    assert.equal(updated.length, 0)
  })

  it("refreshes models for the plugin-owned provider", () => {
    const { editor, added, updated } = editorWith({ integrationID: PROVIDER_ID })
    const models = staticModelInfos().slice(0, 2)
    registerMuseProvider(editor, providerInfo({ baseURL: "http://127.0.0.1:1/v1", apiKey: "t" }), models)
    assert.equal(added.length, 0)
    assert.equal(updated.length, 1)
    assert.equal(updated[0]!.providerID, PROVIDER_ID)
    assert.equal(updated[0]!.models, models)
  })

  it("leaves a user-defined provider untouched", () => {
    for (const existing of [{ integrationID: "other" }, {}]) {
      const { editor, added, updated } = editorWith(existing)
      registerMuseProvider(editor, providerInfo({ baseURL: "http://127.0.0.1:1/v1", apiKey: "t" }), staticModelInfos())
      assert.equal(added.length, 0)
      assert.equal(updated.length, 0)
    }
  })
})
