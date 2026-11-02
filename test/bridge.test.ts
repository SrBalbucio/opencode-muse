import { strict as assert } from "node:assert"
import { after, before, describe, it } from "node:test"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { startBridgeServer, type BridgeServer } from "../src/bridge/server.ts"

const fixture = fileURLToPath(new URL("./fixtures/fake-muse.js", import.meta.url))

// The bridge spawns `MUSE_BIN` with `MUSE_BIN_EXTRA` spliced in first; here
// that runs the fake muse through node. Env is read per request, so each test
// can flip FAKE_MODE.
before(() => {
  process.env.MUSE_BIN = process.execPath
  process.env.MUSE_BIN_EXTRA = fixture
})

after(() => {
  delete process.env.MUSE_BIN
  delete process.env.MUSE_BIN_EXTRA
})

async function completion(server: BridgeServer, body: Record<string, unknown>): Promise<Response> {
  return await fetch(`${server.url}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function startServer(extra = {}): Promise<BridgeServer> {
  return await startBridgeServer({ log: () => {}, ...extra })
}

describe("bridge server auth", () => {
  it("rejects requests without the bearer token", async () => {
    const server = await startServer()
    try {
      const res = await fetch(`${server.url}/v1/models`)
      assert.equal(res.status, 401)
      const health = await fetch(`${server.url}/healthz`)
      assert.equal(health.status, 401)
    } finally {
      await server.close()
    }
  })

  it("accepts the right token", async () => {
    const server = await startServer({ token: "sekrit" })
    try {
      const res = await fetch(`${server.url}/healthz`, { headers: { Authorization: "Bearer sekrit" } })
      assert.equal(res.status, 200)
      assert.deepEqual((await res.json()) as unknown, { ok: true })
    } finally {
      await server.close()
    }
  })
})

describe("bridge server routes", () => {
  it("lists the catalog models", async () => {
    const server = await startServer({ token: "t" })
    try {
      const res = await fetch(`${server.url}/v1/models`, { headers: { Authorization: "Bearer t" } })
      const body = (await res.json()) as { object: string; data: Array<{ id: string }> }
      assert.equal(body.object, "list")
      assert.ok(body.data.some((m) => m.id === "muse-spark-1.3-contributor"))
    } finally {
      await server.close()
    }
  })

  it("404s unknown routes", async () => {
    const server = await startServer({ token: "t" })
    try {
      const res = await fetch(`${server.url}/nope`, { headers: { Authorization: "Bearer t" } })
      assert.equal(res.status, 404)
    } finally {
      await server.close()
    }
  })
})

describe("bridge completions", () => {
  it("maps a text reply into an OpenAI response with usage", async () => {
    const server = await startServer({ token: "t" })
    try {
      const res = await completion(server, {
        model: "muse/muse-spark-1.3",
        messages: [{ role: "user", content: "ping" }],
      })
      assert.equal(res.status, 200)
      const body = (await res.json()) as {
        object: string
        model: string
        choices: Array<{ message: { role: string; content: string | null }; finish_reason: string }>
        usage: { prompt_tokens: number; completion_tokens: number }
      }
      assert.equal(body.object, "chat.completion")
      assert.equal(body.model, "muse-spark-1.3")
      assert.equal(body.choices[0]!.finish_reason, "stop")
      assert.equal(body.choices[0]!.message.content, "PONG")
      assert.equal(body.usage.prompt_tokens, 3)
      assert.equal(body.usage.completion_tokens, 2)
    } finally {
      await server.close()
    }
  })

  it("maps envelope tool calls into OpenAI tool_calls", async () => {
    process.env.FAKE_MODE = "tools"
    const server = await startServer({ token: "t" })
    try {
      const res = await completion(server, {
        model: "muse-spark-1.3",
        messages: [{ role: "user", content: "list files" }],
        tools: [{ type: "function", function: { name: "bash", parameters: {} } }],
      })
      const body = (await res.json()) as {
        choices: Array<{ message: { content: string | null; tool_calls: Array<{ function: { name: string; arguments: string } }> }; finish_reason: string }>
        usage: { prompt_tokens: number }
      }
      assert.equal(body.choices[0]!.finish_reason, "tool_calls")
      const call = body.choices[0]!.message.tool_calls[0]!
      assert.equal(call.function.name, "bash")
      assert.equal(call.function.arguments, '{"command":"ls"}')
      assert.equal(body.choices[0]!.message.content, null)
      assert.equal(body.usage.prompt_tokens, 42)
    } finally {
      await server.close()
      delete process.env.FAKE_MODE
    }
  })

  it("streams the buffered reply as SSE chunks", async () => {
    const server = await startServer({ token: "t" })
    try {
      const res = await completion(server, {
        model: "muse-spark-1.3",
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: "ping" }],
      })
      assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/)
      const text = await res.text()
      assert.ok(text.includes('"object":"chat.completion.chunk"'))
      assert.ok(text.includes("PONG"))
      assert.ok(text.includes('"finish_reason":"stop"'))
      assert.ok(text.includes('"prompt_tokens":3'))
      assert.ok(text.trimEnd().endsWith("data: [DONE]"))
      assert.ok(text.split("\n\n").length >= 3) // delta + finish (+ usage) + done
    } finally {
      await server.close()
    }
  })

  it("hands the harness tools to the CLI via the transcript", async () => {
    process.env.FAKE_MODE = "echo-prompt"
    const server = await startServer({ token: "t" })
    try {
      const res = await completion(server, {
        model: "muse-spark-1.3",
        messages: [{ role: "user", content: "reply with the prompt" }],
        tools: [{ type: "function", function: { name: "edit_file", parameters: {} } }],
        reasoning_effort: "low",
      })
      const body = (await res.json()) as { choices: Array<{ message: { content: string } }> }
      const content = body.choices[0]!.message.content
      assert.match(content, /### edit_file/)
      assert.match(content, /--reasoning-effort","low"/)
      assert.match(content, /\[User\]\nreply with the prompt/)
    } finally {
      await server.close()
      delete process.env.FAKE_MODE
    }
  })

  it("writes data-url images as --image files", async () => {
    process.env.FAKE_MODE = "echo-prompt"
    const server = await startServer({ token: "t" })
    try {
      const res = await completion(server, {
        model: "muse-spark-1.3",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            ],
          },
        ],
      })
      const body = (await res.json()) as { choices: Array<{ message: { content: string } }> }
      assert.match(body.choices[0]!.message.content, /\[image #1 attached\]/)
    } finally {
      await server.close()
      delete process.env.FAKE_MODE
    }
  })

  it("surfaces auth failures as 401 with a muse login hint", async () => {
    process.env.FAKE_MODE = "authfail"
    const server = await startServer({ token: "t" })
    try {
      const res = await completion(server, {
        model: "muse-spark-1.3",
        messages: [{ role: "user", content: "x" }],
      })
      assert.equal(res.status, 401)
      const body = (await res.json()) as { error: { code: string; message: string } }
      assert.equal(body.error.code, "auth")
      assert.match(body.error.message, /muse login/)
    } finally {
      await server.close()
      delete process.env.FAKE_MODE
    }
  })

  it("rejects malformed bodies", async () => {
    const server = await startServer({ token: "t" })
    try {
      const bad = await fetch(`${server.url}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
        body: "not json",
      })
      assert.equal(bad.status, 400)
      const empty = await completion(server, { model: "m", messages: [] })
      assert.equal(empty.status, 400)
      const body = (await empty.json()) as { error: { message: string } }
      assert.match(body.error.message, /no messages/)
    } finally {
      await server.close()
    }
  })

  it("queues over the concurrency cap and 429s when the queue is full", async () => {
    process.env.FAKE_DELAY_MS = "200"
    const server = await startServer({ token: "t", maxConcurrency: 1, maxQueue: 0 })
    try {
      const first = completion(server, { model: "m", messages: [{ role: "user", content: "1" }] })
      const second = completion(server, { model: "m", messages: [{ role: "user", content: "2" }] })
      const [r1, r2] = await Promise.all([first, second])
      assert.equal(r1.status, 200)
      assert.equal(r2.status, 429)
    } finally {
      await server.close()
      delete process.env.FAKE_DELAY_MS
    }
  })
})

describe("standalone binary resolution guard", () => {
  it("completions fail with a clear message when no binary exists", async () => {
    const server = await startServer({ token: "t" })
    try {
      const saved = process.env.MUSE_BIN
      process.env.MUSE_BIN = path.join(os_tmp(), "definitely-not-muse.exe")
      const res = await completion(server, { model: "m", messages: [{ role: "user", content: "x" }] })
      assert.equal(res.status, 500)
      const body = (await res.json()) as { error: { code: string } }
      assert.equal(body.error.code, "missing-binary")
      if (saved === undefined) delete process.env.MUSE_BIN
      else process.env.MUSE_BIN = saved
    } finally {
      await server.close()
    }
  })
})

function os_tmp(): string {
  return os.tmpdir()
}
