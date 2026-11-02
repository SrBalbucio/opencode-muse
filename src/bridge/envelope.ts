// The tool-call envelope forced by `muse exec --output-schema`.
//
// The muse CLI runs with every tool disabled and one model step, so the only
// way for the model to reach OpenCode's tools is to name them inside the
// final answer. The schema makes that answer machine-parseable; this module
// also degrades gracefully when the model ignores the schema (plain prose).

export const ENVELOPE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["content", "tool_calls"],
  properties: {
    content: { type: "string" },
    tool_calls: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "arguments"],
        properties: { name: { type: "string" }, arguments: { type: "string" } },
      },
    },
  },
} as const

export type EnvelopeToolCall = { name: string; arguments: string }

export type Envelope = {
  content: string
  tool_calls: EnvelopeToolCall[]
}

function normalizeToolCall(value: unknown): EnvelopeToolCall | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const name = typeof record.name === "string" ? record.name.trim() : ""
  if (!name) return undefined
  const raw = record.arguments
  let args: string
  if (typeof raw === "string") args = raw
  else if (raw === undefined || raw === null) args = "{}"
  else {
    try {
      args = JSON.stringify(raw)
    } catch {
      args = "{}"
    }
  }
  return { name, arguments: args }
}

function normalizeEnvelope(value: unknown): Envelope | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const content = typeof record.content === "string" ? record.content : ""
  const calls = Array.isArray(record.tool_calls) ? record.tool_calls : []
  const tool_calls = calls.map(normalizeToolCall).filter((c): c is EnvelopeToolCall => c !== undefined)
  return { content, tool_calls }
}

/** Best-effort JSON object extraction from arbitrary model text. */
function extractJsonObject(raw: string): string | undefined {
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start < 0 || end <= start) return undefined
  return raw.slice(start, end + 1)
}

/**
 * Parses the envelope from the CLI's terminal text. Returns undefined when no
 * JSON object could be recovered — callers fall back to treating the whole
 * text as plain content instead of failing the turn.
 */
export function parseEnvelope(raw: string): Envelope | undefined {
  if (!raw) return undefined
  const candidates: string[] = [raw]
  // A fenced block anywhere in the text wins when the whole text isn't JSON.
  const fence = /```(?:json)?\s*([\s\S]*?)```/g
  for (const match of raw.matchAll(fence)) {
    if (match[1]) candidates.push(match[1])
  }
  const sliced = extractJsonObject(raw)
  if (sliced && sliced !== raw) candidates.push(sliced)

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      const envelope = normalizeEnvelope(parsed)
      if (envelope) return envelope
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}

/**
 * Always yields an envelope: parses when possible, otherwise hands the raw
 * text back as content so a schema-violating answer still reaches the user.
 */
export function envelopeFromReply(raw: string): Envelope {
  return parseEnvelope(raw) ?? { content: raw, tool_calls: [] }
}
