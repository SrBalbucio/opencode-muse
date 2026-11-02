import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "node:test"
import {
  buildExecArgs,
  classifyFailure,
  resolveMuseBinary,
  usageSummaryLine,
} from "../src/bridge/cli.ts"
import path from "node:path"
import os from "node:os"

const realEnv = { ...process.env }

afterEach(() => {
  for (const key of ["MUSE_BIN", "MUSE_BIN_EXTRA", "PATH", "FAKE_MODE"] as const) {
    if (key in realEnv) process.env[key] = realEnv[key]
    else delete process.env[key]
  }
})

describe("resolveMuseBinary", () => {
  it("prefers MUSE_BIN verbatim", () => {
    assert.equal(resolveMuseBinary({ MUSE_BIN: "C:/bin/muse.exe" } as NodeJS.ProcessEnv), "C:/bin/muse.exe")
  })

  it("falls back to the launcher install dir then PATH", () => {
    const found = resolveMuseBinary({ PATH: realEnv.PATH } as NodeJS.ProcessEnv)
    if (found) {
      // Whatever exists on this machine must point at a muse-ish binary.
      assert.match(path.basename(found), /muse/i)
    }
  })
})

describe("buildExecArgs", () => {
  it("disables every agent capability and pins one step", () => {
    const args = buildExecArgs({
      model: "muse-spark-1.3",
      effort: "high",
      promptFile: "p.txt",
      schemaFile: "e.json",
      imageFiles: ["a.png"],
    })
    assert.deepEqual(args, [
      "exec",
      "--json",
      "--no-session-log",
      "--preset",
      "empty",
      "--disable-shell",
      "--disable-write",
      "--disable-web-tools",
      "--max-model-steps",
      "1",
      "--model",
      "muse-spark-1.3",
      "--reasoning-effort",
      "high",
      "--output-schema",
      "e.json",
      "--prompt-file",
      "p.txt",
      "--image",
      "a.png",
    ])
  })

  it("drops invalid effort tiers instead of failing the CLI", () => {
    const args = buildExecArgs({ model: "m", promptFile: "p", schemaFile: "e", effort: "bogus" })
    assert.ok(!args.includes("--reasoning-effort"))
    const ultra = buildExecArgs({ model: "m", promptFile: "p", schemaFile: "e", effort: "ultra" })
    assert.ok(ultra.includes("ultra"))
  })
})

describe("classifyFailure", () => {
  it("maps auth, quota, and timeout failures", () => {
    assert.equal(classifyFailure("muse: not logged in — run muse login", false).kind, "auth")
    assert.equal(classifyFailure("muse: usage limit reached", false).kind, "quota")
    assert.equal(classifyFailure("", true).kind, "timeout")
    assert.equal(classifyFailure("muse: something exploded", false).kind, "failed")
  })
})

describe("usageSummaryLine", () => {
  it("condenses tier, window, and weekly lines", () => {
    const line = usageSummaryLine(
      "Tier: Muse Code High Usage\nWindow: 2% used, resets in 4h 20m\nWeekly: 0% used, resets in 6d 21h",
    )
    assert.equal(line, "Muse Code High Usage · window 2% used, resets in 4h 20m · weekly 0% used, resets in 6d 21h")
  })

  it("keeps only what the output carries", () => {
    assert.equal(usageSummaryLine("Tier: Muse Code Free"), "Muse Code Free")
    assert.equal(usageSummaryLine(""), "")
  })
})

describe("resolveMuseBinary on this machine", () => {
  it("finds something under ~/.local/bin or PATH when present", () => {
    // Sanity only: the exact result depends on the machine's install state.
    const found = resolveMuseBinary({ PATH: realEnv.PATH ?? "" } as NodeJS.ProcessEnv)
    if (found && path.dirname(found) === path.join(os.homedir(), ".local", "bin")) {
      assert.match(path.basename(found), /muse/i)
    }
  })
})
