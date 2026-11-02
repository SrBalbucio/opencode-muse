// Values mirror the official `muse` CLI launcher 1:1. When upstream changes,
// update here; nothing else in the codebase should hard-code these strings.
//
// Source of truth: the `muse` launcher script (auth_url, client_id,
// authorization_endpoint, token_endpoint, device_code_grant).
//
// NOTE: client_id is a public constant shipped inside the official CLI, not a
// secret.

export const USER_AGENT = "opencode-muse/0.2.0"

export const AUTH_HOST = "https://auth.meta.com"
export const OAUTH_DEVICE_AUTH_URL = `${AUTH_HOST}/oidc/device/authorization/`
export const OAUTH_TOKEN_URL = `${AUTH_HOST}/oidc/device/token/`
export const OAUTH_CLIENT_ID = "1031625952748946"
export const OAUTH_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"

export const SUBSCRIBE_URL = "https://accountscenter.meta.com/muse_code/"
export const ACCOUNT_URL = "https://accountscenter.meta.com/muse_code/"

// Provider id the user selects in opencode (`muse/<model>`). Intentionally
// NOT "meta": that id is already used for Meta API-key auth, and sharing it
// would surface two auth methods under one login entry and route users onto
// the wrong integration path.
export const PLUGIN_ID = "opencode.provider.muse"
export const OAUTH_METHOD_ID = "muse-code"

export const PROVIDER_ID = "muse"
export const PROVIDER_NAME = "Muse"
export const PROVIDER_PACKAGE = "@opencode/ai/providers/openai-compatible"

export const DEFAULT_MODEL_ID = "muse-spark-1.3-contributor"

// Bridge-visible catalog, mirroring `staticModelInfos()` in src/models.ts
// (which carries the full opencode metadata; ids must stay in sync).
export const MODEL_IDS: readonly string[] = [
  "muse-spark-1.3-contributor",
  "muse-spark-1.3",
  "muse-spark-1.2-contributor",
  "muse-spark-1.2",
]

// Wire values accepted by the muse CLI's `--reasoning-effort` (the CLI's own
// effort ladder; `ultra` is accepted by the binary even though the direct API
// never took it — through the CLI it passes untouched).
export const REASONING_EFFORTS: ReadonlySet<string> = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
])

// ---------------------------------------------------------------------------
// Local bridge (OpenCode → muse CLI)
// ---------------------------------------------------------------------------

// Bind strictly to loopback: model traffic never leaves the machine except
// through the muse CLI's own connection.
export const BRIDGE_HOST = "127.0.0.1"

// Hard wall for one exec round-trip; the CLI streams long answers well under
// this. Env-overridable at the server layer.
export const BRIDGE_REQUEST_TIMEOUT_MS = 10 * 60 * 1000

// Without stdout activity for this long the exec is considered wedged.
export const BRIDGE_IDLE_TIMEOUT_MS = 120 * 1000

// Subscription quota is shared; keep parallel execs low. OpenCode's parallel
// calls (title/compaction + main) fit comfortably in two.
export const BRIDGE_MAX_CONCURRENCY = 2
export const BRIDGE_MAX_QUEUE = 8
export const BRIDGE_MAX_BODY_BYTES = 64 * 1024 * 1024

// Standalone `muse-bridge` exits after this much inactivity. The in-process
// plugin server never uses this (it dies with opencode).
export const BRIDGE_IDLE_EXIT_MS = 15 * 60 * 1000

// The plugin stores a marker credential (the CLI's own auth.json carries the
// real login); refresh just bumps this so opencode never nags.
export const CREDENTIAL_TTL_MS = 24 * 60 * 60 * 1000
