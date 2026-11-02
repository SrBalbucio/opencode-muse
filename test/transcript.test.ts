import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { renderTranscript } from "../src/bridge/transcript.ts"

const TOOL = {
  type: "function",
  function: {
    name: "bash",
    description: "Run a shell command.",
    parameters: { type: "object", properties: { command: { type: "string" } } },
  },
}

describe("renderTranscript", () => {
  it("renders roles as labeled sections", () => {
    const { text } = renderTranscript({
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "bye" },
      ],
    })
    assert.match(text, /\[System\]\nBe terse\./)
    assert.match(text, /\[User\]\nhi/)
    assert.match(text, /\[Assistant\]\nhello/)
    assert.match(text, /\[User\]\nbye/)
    assert.ok(text.trimEnd().endsWith("bye"))
  })

  it("lists the tool catalog and describes the envelope", () => {
    const { text } = renderTranscript({ messages: [{ role: "user", content: "x" }], tools: [TOOL] })
    assert.match(text, /### bash/)
    assert.match(text, /Run a shell command\./)
    assert.match(text, /"command"/)
    assert.match(text, /Tools available to the harness \(1\)/)
    assert.match(text, /tool_calls/)
  })

  it("renders assistant tool calls and tool results", () => {
    const { text } = renderTranscript({
      messages: [
        { role: "user", content: "list files" },
        {
          role: "assistant",
          content: "Checking.",
          tool_calls: [{ id: "call_1", function: { name: "bash", arguments: '{"command":"ls"}' } }],
        },
        { role: "tool", tool_call_id: "call_1", name: "bash", content: "a.txt" },
      ],
      tools: [TOOL],
    })
    assert.match(text, /\[Assistant → harness tool calls\]/)
    assert.match(text, /1\. bash\(\{"command":"ls"\}\) id=call_1/)
    assert.match(text, /\[Tool result \(bash\) for call_1\]\na\.txt/)
  })

  it("honors tool_choice requirements", () => {
    const required = renderTranscript({
      messages: [{ role: "user", content: "x" }],
      tool_choice: "required",
    }).text
    assert.match(required, /requires at least one tool call/)

    const forced = renderTranscript({
      messages: [{ role: "user", content: "x" }],
      tool_choice: { type: "function", function: { name: "bash" } },
    }).text
    assert.match(forced, /exactly the tool `bash`/)
  })

  it("extracts data-url images in order and marks them inline", () => {
    const { text, images } = renderTranscript({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,BBBB" } },
          ],
        },
      ],
    })
    assert.match(text, /\[image #1 attached\]/)
    assert.match(text, /\[image #2 attached\]/)
    assert.equal(images.length, 2)
    assert.deepEqual(images[0], { kind: "data", mediaType: "image/png", base64: "AAAA" })
    assert.deepEqual(images[1], { kind: "data", mediaType: "image/jpeg", base64: "BBBB" })
  })

  it("passes local paths through and skips remote urls", () => {
    const { images } = renderTranscript({
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "C:\\tmp\\shot.png" } },
            { type: "image_url", image_url: { url: "https://example.com/x.png" } },
          ],
        },
      ],
    })
    assert.deepEqual(images, [{ kind: "path", path: "C:\\tmp\\shot.png" }])
  })

  it("degrades gracefully on odd shapes", () => {
    const { text, images } = renderTranscript({
      messages: [{ role: 42, content: null }, null, "nope"] as unknown as Parameters<typeof renderTranscript>[0]["messages"],
      tools: [null, "x", { function: null }],
    })
    // Unknown roles degrade to a plain user section; junk entries are skipped.
    const sections = text.match(/^\[(?:System|User|Assistant[^\]]*)\]$/gm) ?? []
    assert.equal(sections.length, 1)
    assert.equal(sections[0], "[User]")
    assert.equal(images.length, 0)
    assert.ok(text.length > 0)
  })
})
