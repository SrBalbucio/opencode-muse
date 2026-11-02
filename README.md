# opencode-muse

Use your **Muse Code subscription** in [OpenCode](https://opencode.ai) — through the
official `muse` CLI, so Meta only ever sees its own client.

```
OpenCode (harness: tools, UI, sessions)
   │  provider "muse" (OpenAI-compatible, localhost)
   ▼
muse-bridge (in-process HTTP server, 127.0.0.1 + bearer token)
   │  one `muse exec` per completion (agent loop disabled)
   ▼
muse CLI ─── your subscription ───▶ api.meta.ai
```

## Why a bridge

Meta closed the direct subscription API to external harness clients, so the old
mint-a-key-and-call-the-API path no longer works. The bridge keeps OpenCode as
the harness (its tools, its UI, its sessions) while the official CLI makes every
model call: each completion spawns one headless `muse exec --json` with the
agent loop neutralized (`--preset empty`, `--max-model-steps 1`) and the reply
pinned to a JSON envelope via
`--output-schema`. The envelope is translated back into OpenAI-shaped
`tool_calls`, so OpenCode's tools keep working end to end.

Trade-off: completions are **buffered** — the reply arrives in one piece, not
token by token, because tool calls can only be recovered after the CLI finishes.

## Requirements

- OpenCode v2 (`opencode --version` shows `2.x`)
- Node.js 22+ (to run the install scripts)
- A Muse Code subscription (or a Meta account eligible for one)
- The `muse` CLI installed and logged in
- pnpm 11 (`corepack enable` uses the version pinned in `package.json`)

## Install

### 1. The muse CLI

macOS/Linux (official launcher):

```sh
curl -fsSL https://api.meta.ai/muse-launcher.sh | bash
```

Windows (the launcher does not support Windows yet — this repo ships an
installer that downloads the same official binary and verifies its sha256
against Meta's release manifest):

```sh
pnpm muse:install          # → ~/.local/bin/muse.exe
```

### 2. Log in (once, in a terminal)

```sh
muse login
```

### 3. The plugin

```sh
git clone https://github.com/SrBalbucio/opencode-muse.git
cd opencode-muse
pnpm install
pnpm run build
cp dist/muse.js ~/.config/opencode/plugins/muse.js
opencode reload
```

No config changes are needed: the provider, models, and login method are all
contributed by the plugin, which hosts the bridge inside the opencode process.

## Log in inside opencode

```sh
opencode auth login
```

Choose **muse**, then **Muse Code (via muse CLI)**:

- If `muse login` succeeded on this machine, the login completes immediately
  with no browser step and prints your tier and usage window.
- Otherwise the guided device flow opens in the browser to validate your
  account; model credentials still come from the CLI, so finish with
  `muse login` using the same account when asked.

`MUSE_EXPERIMENTAL_AUTH_WRITE=1` opts into an experimental path that stores the
device-flow token in the CLI's `auth.json`, skipping the terminal step. Off by
default.

## Use

```sh
opencode run --model muse/muse-spark-1.3-contributor "Explain this repo"
```

Models: `muse-spark-1.3-contributor`, `muse-spark-1.3`,
`muse-spark-1.2-contributor`, `muse-spark-1.2`, with reasoning variants:

```sh
opencode run --model muse/muse-spark-1.3-contributor#minimal "Quick question"
opencode run --model muse/muse-spark-1.3-contributor#max "Think hard about this"
```

Valid tiers: `none`, `minimal`, `low`, `medium`, `high` (default), `xhigh`,
`max`, `ultra`.

## Standalone bridge (optional)

The plugin hosts the bridge itself; you only need this for debugging or
non-opencode clients:

```sh
node dist/muse-bridge.js --port 8080 --token mysecret
# point an OpenAI-compatible client at http://127.0.0.1:8080/v1
```

Flags: `--port`, `--token`, `--host`, `--idle-exit-seconds` (auto-stops after
15 idle minutes by default). `MUSE_BIN` overrides the binary path; the bridge
finds `~/.local/bin/muse*` and PATH `muse` on its own.

## Troubleshooting

- **`muse CLI has no usable login`** — run `muse login` in a terminal, then
  retry. The bridge uses the CLI's own credential store.
- **`muse CLI binary not found`** — run `pnpm muse:install` (or set `MUSE_BIN`
  to the binary path).
- **`muse subscription quota exhausted`** — check `muse usage`; the window
  resets on Meta's schedule.
- **Replies arrive all at once** — that's the buffered design: tool calls are
  recovered from the CLI's final envelope, so streaming to OpenCode is one
  chunk.
- **Login says the muse CLI rejected the stored login** — the CLI's login and
  the device-flow approval point at different accounts; run `muse login` again
  with the approved one.
- **First model call is slow** — the CLI process is spawned per completion
  (~1s warm-up) on top of the model time.

## Development

```sh
pnpm install
pnpm run typecheck   # tsc --noEmit
pnpm test            # node --test (fake CLI fixture, no network)
pnpm run build       # dist/muse.js (plugin) + dist/muse-bridge.js (standalone)
```

Layout:

- `src/index.ts` — v2 plugin definition (bridge lifecycle, provider/login
  transforms, session hooks)
- `src/bridge/transcript.ts` — OpenAI messages → CLI prompt (+ image files)
- `src/bridge/envelope.ts` — the `--output-schema` tool-call envelope
- `src/bridge/cli.ts` — binary resolution, exec args, JSONL event decoding
- `src/bridge/server.ts` — loopback HTTP server (token auth, concurrency)
- `src/bridge/main.ts` — standalone entry (`dist/muse-bridge.js`)
- `src/oauth.ts` — device flow (login guidance) + effort mapping
- `src/models.ts` — opencode model metadata, marker credential
- `src/muse-store.ts` — read-only view of the CLI's credential store (+ the
  gated experimental writer)
- `scripts/install-muse.mjs` — checksum-verified CLI installer
- `test/` — unit tests; `test/fixtures/fake-muse.js` fakes the CLI

The `client_id` in `src/constants.ts` is a public constant shipped inside the
official `muse` launcher, not a secret.

## License

MIT
