// Standalone muse-bridge entry point.
//
//   node dist/muse-bridge.js [--port N] [--token T] [--host H] [--idle-exit-seconds N]
//
// The opencode plugin hosts the same server in-process; this entry exists for
// manual use, debugging, and setups that prefer a separate process.

import crypto from "node:crypto"

import { BRIDGE_HOST, BRIDGE_IDLE_EXIT_MS } from "../constants.ts"
import { resolveMuseBinary } from "./cli.ts"
import { startBridgeServer } from "./server.ts"

function flagValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const port = Number.parseInt(flagValue(args, "--port") ?? "", 10)
  const idleSeconds = Number.parseInt(flagValue(args, "--idle-exit-seconds") ?? "", 10)
  const token = flagValue(args, "--token") ?? crypto.randomBytes(24).toString("base64url")
  const host = flagValue(args, "--host") ?? BRIDGE_HOST

  const binary = resolveMuseBinary()
  if (!binary) {
    console.error("muse-bridge: no muse binary found — install it (pnpm muse:install) or set MUSE_BIN")
    process.exitCode = 1
    return
  }

  const server = await startBridgeServer({
    token,
    host,
    port: Number.isFinite(port) ? port : undefined,
    idleExitMs: Number.isFinite(idleSeconds) ? idleSeconds * 1000 : BRIDGE_IDLE_EXIT_MS,
    log: (line) => console.log(line),
  })

  console.log(`muse-bridge token: ${token}`)
  console.log(`muse-bridge binary: ${binary}`)
  console.log("muse-bridge ready — point an OpenAI-compatible client at <url>/v1")
  console.log("muse-bridge stops after its idle window; Ctrl+C to stop now")

  const stop = () => void server.close()
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  await server.closed
}

main().catch((err) => {
  console.error(`muse-bridge: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
