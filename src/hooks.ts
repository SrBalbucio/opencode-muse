import { PROVIDER_ID } from "./constants.ts"
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
 * Registers the `muse` provider once, then keeps its model inventory in sync
 * on later reloads. A provider the user configured themselves (no muse
 * integration) is left untouched.
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
