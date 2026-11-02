// Spawns the official `muse` binary per request and decodes its `exec --json`
// event stream (JSONL envelopes: record_type status|event|reconciliation with
// payload.kind carrying the semantics).
//
// The exec runs the agent loop neutralized (`--preset empty`, one model
// step) — it is a model round-trip, not a nested agent run. OpenCode stays
// the only harness. Note: no `--disable-*` tool flags — see buildExecArgs.

import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  BRIDGE_IDLE_TIMEOUT_MS,
  BRIDGE_REQUEST_TIMEOUT_MS,
  REASONING_EFFORTS,
} from "../constants.ts"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type MuseErrorKind = "missing-binary" | "auth" | "quota" | "timeout" | "failed"

export type MuseCliError = Error & { kind: MuseErrorKind; detail?: string }

export function museError(kind: MuseErrorKind, message: string, detail?: string): MuseCliError {
  const err = new Error(message) as MuseCliError
  err.kind = kind
  if (detail) err.detail = detail
  return err
}

const AUTH_PATTERN = /not logged in|no credentials|muse login|unauthorized|invalid_grant|invalid token|authentication/i
const QUOTA_PATTERN = /usage limit|rate limit|quota|allowance|too many requests|429/i

export function classifyFailure(stderrTail: string, timedOut: boolean): MuseCliError {
  if (timedOut) {
    return museError("timeout", "muse CLI did not finish in time", stderrTail)
  }
  if (AUTH_PATTERN.test(stderrTail)) {
    return museError(
      "auth",
      "muse CLI has no usable login — run `muse login` in a terminal, then retry",
      stderrTail,
    )
  }
  if (QUOTA_PATTERN.test(stderrTail)) {
    return museError("quota", "muse subscription quota exhausted — check `muse usage`", stderrTail)
  }
  return museError("failed", "muse CLI run failed", stderrTail)
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

let cachedBinary: string | undefined

function versionRank(name: string): number[] {
  const match = name.match(/(\d+(?:\.\d+){0,3})/)
  if (!match) return [0, 0, 0, 0]
  return match[1]!.split(".").map((part) => Number.parseInt(part, 10) || 0)
}

function firstExisting(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      // Unreadable path; keep looking.
    }
  }
  return undefined
}

/**
 * Finds the muse binary:
 * 1. `MUSE_BIN` env (absolute path or command name)
 * 2. the launcher's install dir (`~/.local/bin`): `muse.exe` on Windows, the
 *    versioned `muse-bin-*` the launcher drops there, or the launcher itself
 * 3. `muse` on PATH
 */
export function resolveMuseBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.MUSE_BIN) return env.MUSE_BIN
  if (cachedBinary) return cachedBinary

  const home = os.homedir()
  const localBin = path.join(home, ".local", "bin")
  const exe = process.platform === "win32" ? "muse.exe" : "muse"
  const direct = firstExisting([path.join(localBin, exe)])
  if (direct) {
    cachedBinary = direct
    return direct
  }

  try {
    const versioned = fs
      .readdirSync(localBin)
      .filter((name) => /^muse-bin-/.test(name))
      .sort((a, b) => {
        const ra = versionRank(a)
        const rb = versionRank(b)
        for (let i = 0; i < 4; i++) {
          if (ra[i] !== rb[i]) return (rb[i] ?? 0) - (ra[i] ?? 0)
        }
        return 0
      })
      .map((name) => path.join(localBin, name))
    const newest = firstExisting(versioned)
    if (newest) {
      cachedBinary = newest
      return newest
    }
  } catch {
    // No install dir.
  }

  const launcher = process.platform === "win32" ? undefined : path.join(localBin, "muse")
  const launcherPath = launcher && fs.existsSync(launcher) ? launcher : undefined
  if (launcherPath) {
    cachedBinary = launcherPath
    return launcherPath
  }

  const fromPath = firstExisting(
    (env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, exe)),
  )
  if (fromPath) {
    cachedBinary = fromPath
    return fromPath
  }
  return undefined
}

export function resetBinaryCache(): void {
  cachedBinary = undefined
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export type ExecArgsOptions = {
  model: string
  effort?: string | undefined
  promptFile: string
  schemaFile: string
  imageFiles?: readonly string[]
}

/**
 * One completion = one exec with the agent loop neutralized:
 * `--preset empty` drops skills/reminders and `--max-model-steps 1`
 * guarantees exactly one model round-trip, and `--output-schema` pins the
 * reply to the tool-call envelope.
 *
 * The `--disable-shell` / `--disable-write` / `--disable-web-tools` flags are
 * deliberately NOT passed. They make the CLI inject a `capability_policy`
 * fact into its system prompt ("Shell execution is disabled for this
 * session... Work read-only"), and the model then refuses to call the
 * harness's bash/edit/web tools even in build mode. CLI-side execution stays
 * impossible without them: the single model step's reply is schema-pinned to
 * the envelope, which cannot express CLI tool calls, and the run ends there.
 */
export function buildExecArgs(options: ExecArgsOptions): string[] {
  const args = [
    "exec",
    "--json",
    "--no-session-log",
    "--preset",
    "empty",
    "--max-model-steps",
    "1",
    "--model",
    options.model,
  ]
  if (options.effort && REASONING_EFFORTS.has(options.effort)) {
    args.push("--reasoning-effort", options.effort)
  }
  args.push("--output-schema", options.schemaFile, "--prompt-file", options.promptFile)
  for (const image of options.imageFiles ?? []) args.push("--image", image)
  return args
}

// ---------------------------------------------------------------------------
// Event stream decoding
// ---------------------------------------------------------------------------

export type UsageSummary = {
  inputTokens: number
  outputTokens: number
  models: string[]
}

export type ExecResult = {
  /** `terminal` value from the run_terminal event ("completed", ...). */
  terminal?: string
  /** Final answer text from the run_terminal event (the envelope JSON). */
  reply?: string
  usage?: UsageSummary
  stderrTail: string
  exitCode: number | null
  timedOut: boolean
}

function pickNumber(record: Record<string, unknown>, pattern: RegExp): number | undefined {
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "number" && pattern.test(key)) return value
  }
  return undefined
}

function usageFromPayload(payload: Record<string, unknown>): UsageSummary | undefined {
  const models = Array.isArray(payload.models) ? payload.models : []
  let inputTokens = 0
  let outputTokens = 0
  const names: string[] = []
  let sawToken = false
  for (const entry of models) {
    if (typeof entry !== "object" || entry === null) continue
    const record = entry as Record<string, unknown>
    const input = pickNumber(record, /input|prompt/)
    const output = pickNumber(record, /output|completion/)
    if (typeof record.model === "string") names.push(record.model)
    if (input !== undefined || output !== undefined) sawToken = true
    inputTokens += input ?? 0
    outputTokens += output ?? 0
  }
  if (!sawToken) return undefined
  return { inputTokens, outputTokens, models: names }
}

// ---------------------------------------------------------------------------
// Exec runner
// ---------------------------------------------------------------------------

export type RunExecOptions = {
  bin: string
  args: readonly string[]
  cwd?: string
  timeoutMs?: number
  idleTimeoutMs?: number
  env?: NodeJS.ProcessEnv
  /** Extra args spliced in first (test hook: run the fake through node). */
  extraFirstArg?: string | undefined
}

export async function runMuseExec(options: RunExecOptions): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? BRIDGE_REQUEST_TIMEOUT_MS
  const idleTimeoutMs = options.idleTimeoutMs ?? BRIDGE_IDLE_TIMEOUT_MS
  const args = [...options.args]
  if (options.extraFirstArg) args.unshift(options.extraFirstArg)

  return await new Promise<ExecResult>((resolve, reject) => {
    let child
    try {
      child = spawn(options.bin, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })
    } catch (err) {
      reject(museError("missing-binary", `could not spawn the muse binary: ${options.bin}`, String(err)))
      return
    }

    const result: ExecResult = { stderrTail: "", exitCode: null, timedOut: false }
    let stdoutBuffer = ""
    let finished = false

    const stderrLines: string[] = []
    const pushStderr = (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line) stderrLines.push(line)
      }
      while (stderrLines.length > 8) stderrLines.shift()
    }

    let armTimeout = () => {}

    let deadline: NodeJS.Timeout | undefined
    let idle: NodeJS.Timeout | undefined
    const clearTimers = () => {
      if (deadline) clearTimeout(deadline)
      if (idle) clearTimeout(idle)
    }
    const fail = (err: MuseCliError) => {
      if (finished) return
      finished = true
      clearTimers()
      child.kill()
      reject(err)
    }
    armTimeout = () => {
      if (idle) clearTimeout(idle)
      idle = setTimeout(() => {
        result.timedOut = true
        fail(museError("timeout", "muse CLI stalled", result.stderrTail))
      }, idleTimeoutMs)
      if (idle.unref) idle.unref()
    }
    deadline = setTimeout(() => {
      result.timedOut = true
      fail(museError("timeout", "muse CLI exceeded the request deadline", result.stderrTail))
    }, timeoutMs)
    if (deadline.unref) deadline.unref()
    armTimeout()

    child.stdout!.setEncoding("utf8")
    child.stdout!.on("data", (chunk: string) => {
      stdoutBuffer += chunk
      let newline = stdoutBuffer.indexOf("\n")
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim()
        stdoutBuffer = stdoutBuffer.slice(newline + 1)
        newline = stdoutBuffer.indexOf("\n")
        if (!line) continue
        armTimeout()
        try {
          const record = JSON.parse(line) as { payload?: Record<string, unknown> }
          const payload = record.payload
          if (typeof payload !== "object" || payload === null) continue
          switch (payload.kind) {
            case "run_output_delta":
              // Liveness only; buffered mode forwards nothing until terminal.
              break
            case "run_usage":
              result.usage = usageFromPayload(payload) ?? result.usage
              break
            case "run_terminal":
              result.terminal = typeof payload.terminal === "string" ? payload.terminal : result.terminal
              result.reply = typeof payload.text === "string" ? payload.text : result.reply
              break
          }
        } catch {
          // Non-JSON stdout line; the CLI prints progress banners on stderr
          // but tolerate stray stdout noise too.
        }
      }
    })
    child.stderr!.setEncoding("utf8")
    child.stderr!.on("data", (chunk: string) => {
      pushStderr(chunk)
      armTimeout()
    })

    child.on("error", (err) => {
      fail(museError("missing-binary", `could not run the muse binary: ${options.bin}`, String(err)))
    })
    child.on("close", (code) => {
      if (finished) return
      finished = true
      clearTimers()
      result.exitCode = code
      result.stderrTail = stderrLines.join("\n")
      resolve(result)
    })
  })
}

// ---------------------------------------------------------------------------
// `muse usage` (quota/tier text for the login screens)
// ---------------------------------------------------------------------------

export async function museUsageText(options: {
  bin: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  extraFirstArg?: string | undefined
}): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const args = ["usage"]
    if (options.extraFirstArg) args.unshift(options.extraFirstArg)
    let child
    try {
      child = spawn(options.bin, args, {
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })
    } catch (err) {
      reject(museError("missing-binary", `could not spawn the muse binary: ${options.bin}`, String(err)))
      return
    }
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill()
      reject(museError("timeout", "muse usage timed out"))
    }, options.timeoutMs ?? 30_000)
    if (timer.unref) timer.unref()
    child.stdout!.setEncoding("utf8")
    child.stdout!.on("data", (chunk: string) => (stdout += chunk))
    child.stderr!.setEncoding("utf8")
    child.stderr!.on("data", (chunk: string) => (stderr += chunk))
    child.on("error", (err) => {
      clearTimeout(timer)
      reject(museError("missing-binary", `could not run the muse binary: ${options.bin}`, String(err)))
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0 && stdout.trim()) resolve(stdout.trim())
      else reject(classifyFailure(stderr || stdout, false))
    })
  })
}

/** Condenses `muse usage` output into one login-screen line. */
export function usageSummaryLine(usageText: string): string {
  const tier = usageText.match(/^Tier:\s*(.+)$/m)?.[1]?.trim()
  const window = usageText.match(/^Window:\s*(.+)$/m)?.[1]?.trim()
  const weekly = usageText.match(/^Weekly:\s*(.+)$/m)?.[1]?.trim()
  const parts: string[] = []
  if (tier) parts.push(tier)
  if (window) parts.push(`window ${lowerFirst(window)}`)
  if (weekly) parts.push(`weekly ${lowerFirst(weekly)}`)
  return parts.join(" · ")
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1)
}
