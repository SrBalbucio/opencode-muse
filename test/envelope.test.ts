import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { ENVELOPE_JSON_SCHEMA, envelopeFromReply, parseEnvelope } from "../src/bridge/envelope.ts"

describe("parseEnvelope", () => {
  it("parses a clean envelope", () => {
    const envelope = parseEnvelope('{"content":"hi","tool_calls":[]}')!
    assert.equal(envelope.content, "hi")
    assert.deepEqual(envelope.tool_calls, [])
  })

  it("parses tool calls with string arguments", () => {
    const envelope = parseEnvelope(
      '{"content":"","tool_calls":[{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}]}',
    )!
    assert.equal(envelope.content, "")
    assert.deepEqual(envelope.tool_calls, [{ name: "bash", arguments: '{"command":"ls"}' }])
  })

  it("stringifies object arguments so the OpenAI shape always carries a string", () => {
    const envelope = parseEnvelope('{"content":"","tool_calls":[{"name":"t","arguments":{"a":1}}]}')!
    assert.equal(envelope.tool_calls[0]!.arguments, '{"a":1}')
  })

  it("recovers the outermost object from fenced or padded text", () => {
    const fenced = parseEnvelope('```json\n{"content":"ok","tool_calls":[]}\n```')!
    assert.equal(fenced.content, "ok")
    const padded = parseEnvelope('sure! {"content":"ok","tool_calls":[]} hope that helps')!
    assert.equal(padded.content, "ok")
  })

  it("drops malformed tool call entries", () => {
    const envelope = parseEnvelope(
      '{"content":"x","tool_calls":[{"arguments":"{}"},{"name":"keep","arguments":"{}"},7]}',
    )!
    assert.deepEqual(envelope.tool_calls, [{ name: "keep", arguments: "{}" }])
  })

  it("returns undefined when no JSON object exists", () => {
    assert.equal(parseEnvelope(""), undefined)
    assert.equal(parseEnvelope("just prose"), undefined)
    assert.equal(parseEnvelope('["not","an","object"]'), undefined)
  })
})

describe("envelopeFromReply", () => {
  it("falls back to plain content when the schema was ignored", () => {
    const envelope = envelopeFromReply("I will not be boxed.")
    assert.equal(envelope.content, "I will not be boxed.")
    assert.deepEqual(envelope.tool_calls, [])
  })
})

describe("ENVELOPE_JSON_SCHEMA", () => {
  it("requires both keys so the CLI enforces parseable replies", () => {
    assert.deepEqual(ENVELOPE_JSON_SCHEMA.required, ["content", "tool_calls"])
    assert.equal(ENVELOPE_JSON_SCHEMA.additionalProperties, false)
  })
})
