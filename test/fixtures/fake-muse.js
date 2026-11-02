#!/usr/bin/env node
// Test double for the muse binary. The bridge runs it through
// MUSE_BIN=<node> MUSE_BIN_EXTRA=<this file>; it never touches the network.
//
// Modes (FAKE_MODE env):
//   text        (default) completed run with content "PONG"
//   tools       completed run whose envelope carries one tool call
//   echo-prompt terminal content = the prompt file the bridge sent (integration)
//   authfail    exits 1 with an auth error on stderr
//   quota       exits 1 with a quota error on stderr
// FAKE_DELAY_MS sleeps before emitting, for the busy/queue test.

import fs from "node:fs"

const args = process.argv.slice(2)
const mode = process.env.FAKE_MODE ?? "text"
const delay = Number(process.env.FAKE_DELAY_MS ?? 0)

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`)
const status = (payload) => emit({ schema_version: 1, record_type: "status", payload })
const event = (payload) => emit({ schema_version: 1, record_type: "event", payload })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  if (args.includes("usage")) {
    console.log("Tier: Muse Code High Usage")
    console.log("Window: 2% used, resets in 4h 20m")
    console.log("Weekly: 0% used, resets in 6d 21h")
    return
  }
  if (mode === "authfail") {
    console.error("muse: not logged in — run muse login")
    process.exit(1)
  }
  if (mode === "quota") {
    console.error("muse: usage limit reached for this window")
    process.exit(1)
  }

  const promptIndex = args.indexOf("--prompt-file")
  const promptPath = promptIndex >= 0 ? args[promptIndex + 1] : undefined
  const prompt = promptPath && fs.existsSync(promptPath) ? fs.readFileSync(promptPath, "utf8") : ""

  if (delay > 0) await sleep(delay)

  const base = { command_id: "c1", run_stream: { kind: "run", id: "r1" } }
  status({ ...base, kind: "turn_input_user", prompt })
  event({ ...base, kind: "run_started", prompt })
  status({ ...base, kind: "run_output_delta", text: "PONG" })

  if (mode === "echo-prompt") {
    status({ ...base, kind: "run_usage", models: [{ model: "muse-spark-1.3", input_tokens: 10, output_tokens: 5 }] })
    event({
      ...base,
      kind: "run_terminal",
      terminal: "completed",
      text: JSON.stringify({ content: `ARGS:${JSON.stringify(args)}\n---\n${prompt}`, tool_calls: [] }),
    })
    return
  }
  if (mode === "tools") {
    status({ ...base, kind: "run_usage", models: [{ model: "muse-spark-1.3", input_tokens: 42, output_tokens: 7 }] })
    event({
      ...base,
      kind: "run_terminal",
      terminal: "completed",
      text: JSON.stringify({
        content: "",
        tool_calls: [{ name: "bash", arguments: JSON.stringify({ command: "ls" }) }],
      }),
    })
    return
  }

  status({ ...base, kind: "run_usage", models: [{ model: "muse-spark-1.3", prompt_tokens: 3, completion_tokens: 2 }] })
  event({ ...base, kind: "run_terminal", terminal: "completed", text: JSON.stringify({ content: "PONG", tool_calls: [] }) })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
