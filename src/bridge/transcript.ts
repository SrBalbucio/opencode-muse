// Renders an OpenAI-shaped chat request into the single prompt the muse CLI
// consumes, plus the ordered image list passed via --image.
//
// The muse CLI is itself an agent harness, so the prompt opens with a frame
// that puts the model in "model backend" mode: the harness (OpenCode) owns
// every tool and executes them; the model only answers in the tool-call
// envelope enforced by --output-schema.

export type ExtractedImage =
  | { kind: "data"; mediaType: string; base64: string }
  | { kind: "path"; path: string }

export type Transcript = {
  /** Full prompt text, ready for --prompt-file. */
  text: string
  /** Images in encounter order; each becomes one --image flag. */
  images: ExtractedImage[]
}

type ToolCallLike = {
  id?: unknown
  type?: unknown
  function?: { name?: unknown; arguments?: unknown } | undefined
}

export type ChatMessage = {
  role?: unknown
  content?: unknown
  tool_calls?: ToolCallLike[] | undefined
  tool_call_id?: unknown
  name?: unknown
}

type ToolLike = {
  type?: unknown
  function?: { name?: unknown; description?: unknown; parameters?: unknown } | undefined
}

export type TranscriptRequest = {
  messages: readonly ChatMessage[]
  tools?: unknown
  tool_choice?: unknown
}

// ---------------------------------------------------------------------------
// Content extraction
// ---------------------------------------------------------------------------

function textFromParts(parts: readonly unknown[], images: ExtractedImage[]): string {
  const out: string[] = []
  let imageIndex = images.length
  for (const part of parts) {
    if (part === null || part === undefined) continue
    if (typeof part === "string") {
      out.push(part)
      continue
    }
    if (typeof part !== "object") continue
    const record = part as Record<string, unknown>
    if (typeof record.text === "string") {
      out.push(record.text)
      continue
    }
    const image = extractImagePart(record)
    if (image) {
      imageIndex += 1
      images.push(image)
      out.push(`[image #${imageIndex} attached]`)
    }
  }
  return out.join("\n")
}

function extractImagePart(record: Record<string, unknown>): ExtractedImage | undefined {
  const url =
    (record.type === "image_url" &&
      typeof record.image_url === "object" &&
      record.image_url !== null &&
      typeof (record.image_url as Record<string, unknown>).url === "string" &&
      ((record.image_url as Record<string, unknown>).url as string)) ||
    (record.type === "image" && typeof record.image === "string" && (record.image as string)) ||
    (record.type === "image" &&
      typeof record.image === "object" &&
      record.image !== null &&
      typeof (record.image as Record<string, unknown>).url === "string" &&
      ((record.image as Record<string, unknown>).url as string))
  if (!url) return undefined
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",")
    if (comma < 0) return undefined
    const header = url.slice(5, comma)
    const base64 = url.slice(comma + 1)
    const mediaType = header.split(";", 1)[0] || "image/png"
    return { kind: "data", mediaType, base64 }
  }
  if (url.startsWith("file://")) {
    return { kind: "path", path: fileUrlToPath(url) }
  }
  // Plain filesystem paths are accepted best-effort (validated later).
  if (!/^[a-z]+:\/\//i.test(url)) return { kind: "path", path: url }
  // Remote URLs: the CLI only takes local files; skip rather than fetch.
  return undefined
}

function fileUrlToPath(url: string): string {
  try {
    const parsed = new URL(url)
    let p = decodeURIComponent(parsed.pathname)
    if (/^\/[a-z]:/i.test(p)) p = p.slice(1) // Windows drive letter
    return p
  } catch {
    return url
  }
}

function contentText(message: ChatMessage, images: ExtractedImage[]): string {
  const content = message.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) return textFromParts(content, images)
  return ""
}

// ---------------------------------------------------------------------------
// Tool rendering
// ---------------------------------------------------------------------------

function toolCatalog(tools: readonly unknown[]): string {
  const sections: string[] = []
  for (const entry of tools) {
    if (typeof entry !== "object" || entry === null) continue
    const tool = entry as ToolLike
    if (typeof tool.function !== "object" || tool.function === null) continue
    const { name, description, parameters } = tool.function
    if (typeof name !== "string" || !name) continue
    const lines = [`### ${name}`]
    if (typeof description === "string" && description.trim()) lines.push(description.trim())
    if (parameters !== undefined) {
      try {
        lines.push(`parameters: ${JSON.stringify(parameters)}`)
      } catch {
        // Schema not serializable; the name still tells the model it exists.
      }
    }
    sections.push(lines.join("\n"))
  }
  return sections.join("\n\n")
}

function toolCallLines(message: ChatMessage): string {
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  const lines: string[] = []
  let index = 0
  for (const call of calls) {
    if (typeof call !== "object" || call === null) continue
    const fn = typeof call.function === "object" && call.function !== null ? call.function : {}
    const name = typeof fn.name === "string" ? fn.name : "unknown"
    const id = typeof call.id === "string" && call.id ? ` id=${call.id}` : ""
    const args = typeof fn.arguments === "string" && fn.arguments ? fn.arguments : "{}"
    index += 1
    lines.push(`${index}. ${name}(${args})${id}`)
  }
  return lines.join("\n")
}

function toolChoiceNote(choice: unknown): string {
  if (choice === "required") {
    return "The harness requires at least one tool call this turn; keep content empty or a brief note."
  }
  if (choice === "none") {
    return "The harness forbids tool calls this turn; tool_calls must be []."
  }
  if (typeof choice === "object" && choice !== null) {
    const fn = (choice as Record<string, unknown>).function
    if (typeof fn === "object" && fn !== null && typeof (fn as Record<string, unknown>).name === "string") {
      const name = (fn as Record<string, unknown>).name as string
      return `The harness requires you to call exactly the tool \`${name}\` this turn (content empty or a brief note).`
    }
  }
  return ""
}

// ---------------------------------------------------------------------------
// Preamble
// ---------------------------------------------------------------------------

export function preamble(toolCount: number, toolChoice: unknown): string {
  const lines = [
    "You are the model behind an external coding harness (OpenCode). The harness owns the",
    "terminal, filesystem, tools, approvals, and conversation state. You never execute",
    "anything yourself: to act, list tool calls in the JSON envelope and the harness runs",
    "them and sends back results.",
    "",
    "Reply with EXACTLY one JSON object and nothing else:",
    '{"content": "<your visible reply>", "tool_calls": [{"name": "<tool>", "arguments": "<JSON object as a string>"}]}',
    "",
    "Rules:",
    "- `content` is what the harness shows the user; use \"\" when you only call tools.",
    "- `arguments` must be a string holding a JSON object that matches the tool's parameters.",
    "- List several calls to run tools in parallel; otherwise `tool_calls` is [].",
    "- No prose, no code fences: only the JSON object.",
    "",
    `## Tools available to the harness (${toolCount})`,
  ]
  if (toolCount === 0) {
    lines.push("(none — answer in plain `content`)")
  }
  const note = toolChoiceNote(toolChoice)
  if (note) lines.push("", `Tool-call requirement: ${note}`)
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

function renderMessage(message: ChatMessage, images: ExtractedImage[]): string {
  const role = typeof message.role === "string" ? message.role : "user"
  const text = contentText(message, images)
  switch (role) {
    case "system":
    case "developer":
      return `[System]\n${text}`
    case "assistant": {
      const calls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0
      const header = calls ? "[Assistant → harness tool calls]" : "[Assistant]"
      const body = [text.trim() && `${text}`, calls && toolCallLines(message)].filter(Boolean)
      return `${header}\n${body.join("\n\n")}`
    }
    case "tool": {
      const id = typeof message.tool_call_id === "string" ? message.tool_call_id : ""
      const name = typeof message.name === "string" && message.name ? ` (${message.name})` : ""
      return `[Tool result${name}${id ? ` for ${id}` : ""}]\n${text}`
    }
    default:
      return `[${role === "user" ? "User" : role}]\n${text}`
  }
}

/**
 * Builds the CLI prompt from an OpenAI chat-completions request. The last
 * rendered section is whatever the harness put last (usually the user turn or
 * a tool result feeding the next model step).
 */
export function renderTranscript(request: TranscriptRequest): Transcript {
  const images: ExtractedImage[] = []
  const messages = Array.isArray(request.messages) ? request.messages : []
  const tools = Array.isArray(request.tools) ? request.tools : []

  const sections: string[] = [preamble(tools.length, request.tool_choice)]
  if (tools.length > 0) {
    const catalog = toolCatalog(tools)
    if (catalog) sections.push(catalog)
  }
  sections.push("## Conversation")
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue
    sections.push(renderMessage(message as ChatMessage, images))
  }

  return { text: sections.join("\n\n") + "\n", images }
}
