// Local HTTP server exposing the muse CLI as an OpenAI-compatible endpoint.
//
//   GET  /healthz               liveness (token required)
//   GET  /v1/models             static catalog
//   POST /v1/chat/completions   buffered completion via `muse exec`
//
// Buffered by design: tool calls must be recovered from the envelope JSON, so
// nothing is streamed to the client until the CLI's run_terminal arrives.
// Bearer-token auth + loopback bind keep the endpoint private to this machine.

import http from "node:http"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  BRIDGE_HOST,
  BRIDGE_IDLE_EXIT_MS,
  BRIDGE_MAX_BODY_BYTES,
  BRIDGE_MAX_CONCURRENCY,
  BRIDGE_MAX_QUEUE,
  DEFAULT_MODEL_ID,
  MODEL_IDS,
  REASONING_EFFORTS,
} from "../constants.ts"
import { buildExecArgs, classifyFailure, museError, resolveMuseBinary, runMuseExec, type MuseCliError } from "./cli.ts"
import { ENVELOPE_JSON_SCHEMA, envelopeFromReply, type Envelope } from "./envelope.ts"
import { renderTranscript, type ChatMessage, type ExtractedImage } from "./transcript.ts"

type ResponseData = { envelope: Envelope; usage?: { inputTokens: number; outputTokens: number }; model: string }

export type BridgeOptions = {
  /** Defaults to a fresh random token. */
  token?: string
  host?: string
  port?: number
  /** Standalone mode: close the server after this much inactivity. */
  idleExitMs?: number
  requestTimeoutMs?: number
  idleTimeoutMs?: number
  maxConcurrency?: number
  maxQueue?: number
  log?: (line: string) => void
}

export type BridgeServer = {
  /** Root URL, e.g. http://127.0.0.1:53217 (append /v1 for an SDK baseURL). */
  url: string
  port: number
  token: string
  close(): Promise<void>
  /** Resolves once the underlying server has fully closed. */
  closed: Promise<void>
}

type ServerDeps = {
  requestTimeoutMs: number
  idleTimeoutMs: number
  maxConcurrency: number
  maxQueue: number
  log: (line: string) => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tokensMatch(expected: string, provided: string | undefined): boolean {
  if (!provided) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(provided)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

function authorized(req: http.IncomingMessage, token: string): boolean {
  const header = req.headers.authorization
  if (!header?.startsWith("Bearer ")) return false
  return tokensMatch(token, header.slice("Bearer ".length).trim())
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return
  const payload = JSON.stringify(body)
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) })
  res.end(payload)
}

function sendError(res: http.ServerResponse, err: MuseCliError, model: string): void {
  const status =
    err.kind === "auth" ? 401 : err.kind === "quota" ? 429 : err.kind === "timeout" ? 504 : err.kind === "missing-binary" ? 500 : 502
  const detail = err.detail ? `\n\n${err.detail.split("\n").slice(-4).join("\n")}` : ""
  sendJson(res, status, {
    error: {
      message: `${err.message} (model ${model})${detail}`,
      type: "muse_bridge_error",
      code: err.kind,
    },
  })
}

function stripProviderPrefix(model: unknown): string {
  const id = typeof model === "string" ? model.trim() : ""
  const bare = id.startsWith("muse/") ? id.slice("muse/".length) : id
  return bare || DEFAULT_MODEL_ID
}

function extractEffort(body: Record<string, unknown>): string | undefined {
  const raw = body.reasoning_effort ?? body.reasoningEffort
  if (typeof raw !== "string") return undefined
  const normalized = raw.trim().toLowerCase()
  return normalized && REASONING_EFFORTS.has(normalized) ? normalized : undefined
}

function extForMediaType(mediaType: string): string {
  if (/jpeg|jpg/i.test(mediaType)) return ".jpg"
  if (/webp/i.test(mediaType)) return ".webp"
  if (/gif/i.test(mediaType)) return ".gif"
  return ".png"
}

// ---------------------------------------------------------------------------
// OpenAI response shapes
// ---------------------------------------------------------------------------

function mapToolCalls(envelope: Envelope): Array<Record<string, unknown>> {
  return envelope.tool_calls.map((call) => ({
    id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "function",
    function: { name: call.name, arguments: call.arguments },
  }))
}

function messageFor(envelope: Envelope): Record<string, unknown> {
  const toolCalls = mapToolCalls(envelope)
  const message: Record<string, unknown> = {
    role: "assistant",
    content: toolCalls.length > 0 && !envelope.content ? null : envelope.content,
  }
  if (toolCalls.length > 0) message.tool_calls = toolCalls
  return message
}

function usageBlock(usage: { inputTokens: number; outputTokens: number } | undefined): Record<string, number> {
  const input = usage?.inputTokens ?? 0
  const output = usage?.outputTokens ?? 0
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output }
}

function completionBody(options: {
  id: string
  created: number
  model: string
  envelope: Envelope
  usage?: { inputTokens: number; outputTokens: number }
}): Record<string, unknown> {
  const toolCalls = mapToolCalls(options.envelope)
  return {
    id: options.id,
    object: "chat.completion",
    created: options.created,
    model: options.model,
    choices: [
      {
        index: 0,
        message: messageFor(options.envelope),
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage: usageBlock(options.usage),
  }
}

function writeSseCompletion(
  res: http.ServerResponse,
  options: {
    id: string
    created: number
    model: string
    envelope: Envelope
    usage?: { inputTokens: number; outputTokens: number }
    includeUsage: boolean
  },
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  })
  const writeChunk = (payload: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify({ id: options.id, created: options.created, model: options.model, object: "chat.completion.chunk", ...payload })}\n\n`)
  }
  const message = messageFor(options.envelope)
  const toolCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as Array<Record<string, unknown>>) : []
  const content = typeof message.content === "string" ? message.content : null

  writeChunk({ choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })
  if (toolCalls.length > 0) {
    writeChunk({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: toolCalls.map((call, index) => ({ index, ...call })),
          },
          finish_reason: null,
        },
      ],
    })
  }
  writeChunk({
    choices: [{ index: 0, delta: {}, finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop" }],
  })
  if (options.includeUsage) {
    writeChunk({ choices: [], usage: usageBlock(options.usage) })
  }
  res.write("data: [DONE]\n\n")
  res.end()
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export async function startBridgeServer(options: BridgeOptions = {}): Promise<BridgeServer> {
  const token = options.token ?? crypto.randomBytes(24).toString("base64url")
  const host = options.host ?? BRIDGE_HOST
  const deps: ServerDeps = {
    requestTimeoutMs: options.requestTimeoutMs ?? 10 * 60 * 1000,
    idleTimeoutMs: options.idleTimeoutMs ?? 120 * 1000,
    maxConcurrency: options.maxConcurrency ?? BRIDGE_MAX_CONCURRENCY,
    maxQueue: options.maxQueue ?? BRIDGE_MAX_QUEUE,
    log: options.log ?? (() => {}),
  }

  let active = 0
  const queue: Array<{ resolve: () => void; reject: (err: MuseCliError) => void }> = []

  const acquire = async (): Promise<() => void> => {
    if (active < deps.maxConcurrency) {
      active += 1
      return release
    }
    if (queue.length >= deps.maxQueue) {
      throw museError("failed", "muse bridge is busy — too many in-flight completions")
    }
    return await new Promise<() => void>((resolve, reject) => {
      queue.push({
        resolve: () => {
          active += 1
          resolve(release)
        },
        reject,
      })
    })
  }

  const release = () => {
    active -= 1
    const next = queue.shift()
    if (next) next.resolve()
  }

  async function runCompletion(body: Record<string, unknown>): Promise<ResponseData> {
    const messages = Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : []
    if (messages.length === 0) {
      throw museError("failed", "request carries no messages")
    }
    const model = stripProviderPrefix(body.model)
    const effort = extractEffort(body)
    const transcript = renderTranscript({
      messages,
      tools: body.tools,
      tool_choice: body.tool_choice,
    })

    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "muse-bridge-"))
    let releaseSlot: (() => void) | undefined
    try {
      releaseSlot = await acquire()
      const promptFile = path.join(workDir, "prompt.txt")
      const schemaFile = path.join(workDir, "envelope.json")
      const writes: Array<Promise<unknown>> = [
        fs.writeFile(promptFile, transcript.text, "utf8"),
        fs.writeFile(schemaFile, JSON.stringify(ENVELOPE_JSON_SCHEMA), "utf8"),
      ]
      const imageFiles: string[] = []
      let imageIndex = 0
      for (const image of transcript.images) {
        if (image.kind === "path") {
          try {
            await fs.access(image.path)
            imageFiles.push(image.path)
          } catch {
            // Missing local path; the transcript already marks it inline.
          }
          continue
        }
        imageIndex += 1
        const target = path.join(workDir, `image-${imageIndex}${extForMediaType(image.mediaType)}`)
        await fs.writeFile(target, Buffer.from(image.base64, "base64"))
        imageFiles.push(target)
      }
      await Promise.all(writes)

      const bin = resolveMuseBinary()
      if (!bin) {
        throw museError(
          "missing-binary",
          "muse CLI binary not found — install it (pnpm muse:install) or set MUSE_BIN",
        )
      }
      const result = await runMuseExec({
        bin,
        args: buildExecArgs({ model, effort, promptFile, schemaFile, imageFiles }),
        cwd: workDir,
        timeoutMs: deps.requestTimeoutMs,
        idleTimeoutMs: deps.idleTimeoutMs,
        env: process.env,
        extraFirstArg: process.env.MUSE_BIN_EXTRA,
      })
      if (result.terminal !== undefined && result.terminal !== "completed") {
        throw classifyFromResult(result)
      }
      if (result.reply === undefined) {
        throw classifyFromResult(result)
      }
      const envelope = envelopeFromReply(result.reply)
      return {
        envelope,
        usage: result.usage,
        model,
      }
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {})
      releaseSlot?.()
    }
  }

  function classifyFromResult(result: { exitCode: number | null; stderrTail: string; timedOut: boolean; terminal?: string; reply?: string }): MuseCliError {
    if (result.timedOut) return museError("timeout", "muse CLI did not finish in time", result.stderrTail)
    return classifyFailure(
      result.stderrTail || (result.terminal ? `run ${result.terminal}` : "run ended without a terminal event"),
      result.timedOut,
    )
  }

  const server = http.createServer((req, res) => {
    void handle(req, res)
  })

  async function readBody(req: http.IncomingMessage): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      let size = 0
      const chunks: Buffer[] = []
      req.on("data", (chunk: Buffer) => {
        size += chunk.length
        if (size > BRIDGE_MAX_BODY_BYTES) {
          reject(museError("failed", "request body too large"))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
      req.on("error", (err) => reject(museError("failed", "request stream error", String(err))))
    })
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = (req.url ?? "/").split("?", 1)[0]!
    try {
      if (!authorized(req, token)) {
        sendJson(res, 401, { error: { message: "muse bridge: missing or invalid bearer token", type: "muse_bridge_error" } })
        return
      }
      if (req.method === "GET" && url === "/healthz") {
        sendJson(res, 200, { ok: true })
        return
      }
      if (req.method === "GET" && url === "/v1/models") {
        sendJson(res, 200, {
          object: "list",
          data: MODEL_IDS.map((id) => ({ id, object: "model", created: 0, owned_by: "meta-muse" })),
        })
        return
      }
      if (req.method === "POST" && url === "/v1/chat/completions") {
        const raw = await readBody(req)
        let body: Record<string, unknown>
        try {
          body = JSON.parse(raw) as Record<string, unknown>
        } catch {
          sendJson(res, 400, { error: { message: "invalid JSON body", type: "invalid_request_error" } })
          return
        }
        if (typeof body !== "object" || body === null) {
          sendJson(res, 400, { error: { message: "body must be a JSON object", type: "invalid_request_error" } })
          return
        }
        let data: ResponseData
        try {
          data = await runCompletion(body)
        } catch (err) {
          const museErr = err as MuseCliError
          if (typeof museErr?.kind !== "string") {
            sendJson(res, 500, { error: { message: `muse bridge error: ${String(err)}`, type: "muse_bridge_error" } })
            return
          }
          if (museErr.kind === "failed" && /bridge is busy/.test(museErr.message)) {
            sendJson(res, 429, { error: { message: museErr.message, type: "muse_bridge_error", code: "busy" } })
            return
          }
          if (museErr.kind === "failed" && /carries no messages/.test(museErr.message)) {
            sendJson(res, 400, { error: { message: museErr.message, type: "invalid_request_error" } })
            return
          }
          sendError(res, museErr, stripProviderPrefix(body.model))
          return
        }
        const id = `chatcmpl-${crypto.randomUUID()}`
        const created = Math.floor(Date.now() / 1000)
        if (body.stream === true) {
          const streamOptions = body.stream_options
          const includeUsage =
            typeof streamOptions === "object" &&
            streamOptions !== null &&
            (streamOptions as Record<string, unknown>).include_usage === true
          writeSseCompletion(res, { id, created, model: data.model, envelope: data.envelope, usage: data.usage, includeUsage })
          return
        }
        sendJson(res, 200, completionBody({ id, created, model: data.model, envelope: data.envelope, usage: data.usage }))
        return
      }
      sendJson(res, 404, { error: { message: `no such route: ${req.method} ${url}`, type: "invalid_request_error" } })
    } catch (err) {
      if (!res.writableEnded) {
        sendJson(res, 500, { error: { message: `muse bridge error: ${String(err)}`, type: "muse_bridge_error" } })
      }
    }
  }

  // Idle exit (standalone mode only).
  let idleExit: NodeJS.Timeout | undefined
  const bumpIdleExit = () => {
    if (!options.idleExitMs) return
    if (idleExit) clearTimeout(idleExit)
    idleExit = setTimeout(() => {
      deps.log("muse-bridge: idle timeout — shutting down")
      void server.close()
    }, options.idleExitMs)
    idleExit.unref?.()
  }
  server.on("request", bumpIdleExit)
  bumpIdleExit()

  const closed = new Promise<void>((resolve) => {
    server.on("close", () => resolve())
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port ?? 0, host, () => resolve())
  })

  const address = server.address()
  if (!address || typeof address === "string") {
    throw museError("failed", "bridge server failed to bind a TCP port")
  }
  const url = `http://${host}:${address.port}`
  deps.log(`muse-bridge listening at ${url}/v1 (token ${token.slice(0, 4)}…)`)

  return {
    url,
    port: address.port,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        if (idleExit) clearTimeout(idleExit)
        if (!server.listening) {
          resolve()
          return
        }
        server.close(() => resolve())
      }),
    closed,
  }
}
