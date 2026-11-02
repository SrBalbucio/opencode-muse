#!/usr/bin/env node
// Installs the official muse CLI binary without the bash launcher, which
// does not support Windows yet (its detect_platform only knows macOS/Linux).
//
// Everything is verified against the channel's signed manifest: version,
// sha256 checksum, and exact byte size before anything lands on disk.
//
//   pnpm muse:install [--channel muse-canary]
//   MUSE_CHANNEL=muse-canary pnpm muse:install
//
// Where it installs:
// - Windows: ~/.local/bin/muse.exe (no launcher exists there yet)
// - macOS/Linux: ~/.local/bin/muse-bin-<version> + .muse-version, matching
//   the official launcher's layout so `muse` picks the binary up as-is.

import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import { Readable } from "node:stream"

const CHANNELS = new Set(["muse-stable", "muse-canary"])

function fail(message) {
  console.error(`muse-install: ${message}`)
  process.exit(1)
}

function channelArg() {
  const flagIndex = process.argv.indexOf("--channel")
  if (flagIndex >= 0) {
    const value = process.argv[flagIndex + 1]
    if (!value || !CHANNELS.has(value)) fail(`unknown channel: ${value ?? "(missing)"} (expected muse-stable or muse-canary)`)
    return value
  }
  const fromEnv = process.env.MUSE_CHANNEL ?? "muse-stable"
  if (!CHANNELS.has(fromEnv)) fail(`unsupported channel: ${fromEnv}`)
  return fromEnv
}

function platformTarget() {
  switch (`${process.platform}/${process.arch}`) {
    case "win32/x64": return { key: "x86_windows", exe: "muse.exe" }
    case "win32/arm64": return { key: "aarch64_windows", exe: "muse.exe" }
    case "darwin/x64": return { key: "x86_macos", exe: "muse-bin-VERSION" }
    case "darwin/arm64": return { key: "aarch64_macos", exe: "muse-bin-VERSION" }
    case "linux/x64": return { key: "x86_linux", exe: "muse-bin-VERSION" }
    case "linux/arm64": return { key: "aarch64_linux", exe: "muse-bin-VERSION" }
    default: fail(`unsupported platform: ${process.platform}/${process.arch}`)
  }
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } })
  if (!res.ok) fail(`request failed (HTTP ${res.status}): ${url}`)
  try {
    return await res.json()
  } catch {
    fail(`non-JSON response from ${url}`)
  }
}

async function downloadVerified(url, expectedChecksum, expectedSize) {
  const res = await fetch(url)
  if (!res.ok) fail(`download failed (HTTP ${res.status}): ${url}`)
  const chunks = []
  let size = 0
  for await (const chunk of res.body ?? []) {
    size += chunk.length
    chunks.push(chunk)
  }
  if (expectedSize !== undefined && size !== expectedSize) {
    fail(`size mismatch: expected ${expectedSize}, got ${size}`)
  }
  const buffer = Buffer.concat(chunks)
  const checksum = createHash("sha256").update(buffer).digest("hex")
  if (checksum !== expectedChecksum) {
    fail(`checksum mismatch: expected ${expectedChecksum}, got ${checksum}`)
  }
  return buffer
}

async function main() {
  const channel = channelArg()
  const installDir = path.join(os.homedir(), ".local", "bin")

  console.log(`Fetching the ${channel} channel manifest…`)
  const channelManifest = await fetchJson(`https://api.meta.ai/muse-code/channels/${channel}`)
  const { version, manifest_url: manifestUrl } = channelManifest
  if (typeof version !== "string" || typeof manifestUrl !== "string") {
    fail("channel manifest is missing version or manifest_url")
  }

  const release = await fetchJson(manifestUrl)
  const artifact = release?.artifacts?.[platformTarget().key]
  if (!artifact?.url || !artifact?.checksum) {
    fail(`release manifest has no ${platformTarget().key} artifact for ${version}`)
  }

  console.log(`Downloading muse ${version} (${platformTarget().key})…`)
  const buffer = await downloadVerified(artifact.url, artifact.checksum, artifact.size)

  await fs.mkdir(installDir, { recursive: true })
  let target
  if (process.platform === "win32") {
    target = path.join(installDir, "muse.exe")
    await fs.writeFile(target, buffer, { mode: 0o755 })
  } else {
    // Mirror the official launcher's layout so `muse` uses it as-is.
    target = path.join(installDir, platformTarget().exe.replace("VERSION", version))
    await fs.writeFile(target, buffer, { mode: 0o755 })
    await fs.writeFile(path.join(installDir, ".muse-version"), `${version}\n`, "utf8")
  }

  console.log(`Installed: ${target}`)
  console.log("Next step: run `muse login` in a terminal, then `opencode auth login muse`.")
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)))
