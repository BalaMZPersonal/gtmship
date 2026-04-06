#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const distRoot = path.join(repoRoot, "dist", "homebrew");
const platformArg = process.argv.find((arg) => arg.startsWith("--platform="));
const archArg = process.argv.find((arg) => arg.startsWith("--arch="));
const supportedPlatforms = new Set(["darwin", "linux"]);
const supportedArchitectures = new Set(["arm64", "x64"]);

function normalizePlatform(value) {
  return value === "macos" ? "darwin" : value;
}

function normalizeArch(value) {
  if (value === "amd64" || value === "x86_64") {
    return "x64";
  }

  if (value === "aarch64") {
    return "arm64";
  }

  return value;
}

const platform = normalizePlatform(
  platformArg ? platformArg.split("=")[1] : process.platform
);
const arch = normalizeArch(archArg ? archArg.split("=")[1] : process.arch);

if (!supportedPlatforms.has(platform)) {
  throw new Error(`Unsupported release platform: ${platform}`);
}

if (!supportedArchitectures.has(arch)) {
  throw new Error(`Unsupported release architecture: ${arch}`);
}

if (
  platform !== normalizePlatform(process.platform) ||
  arch !== normalizeArch(process.arch)
) {
  throw new Error(
    `Build ${platform}-${arch} releases on a matching ${platform}/${arch} machine or CI runner so bundled dependencies stay compatible.`
  );
}

const releaseName = `gtmship-${platform}-${arch}`;
const stagingDir = path.join(distRoot, releaseName);
const tarballPath = path.join(distRoot, `${releaseName}.tar.gz`);

function run(command, args) {
  execFileSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      FORCE_COLOR: "1",
    },
  });
}

function copyIntoStage(relativePath) {
  const source = path.join(repoRoot, relativePath);
  const destination = path.join(stagingDir, relativePath);

  if (!existsSync(source)) {
    throw new Error(`Missing required release input: ${relativePath}`);
  }

  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
  });
}

function writeLauncher() {
  const launcherPath = path.join(stagingDir, "bin", "gtmship");
  mkdirSync(path.dirname(launcherPath), { recursive: true });
  writeFileSync(
    launcherPath,
    `#!/bin/sh
set -e
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
ROOT_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
export GTMSHIP_INSTALL_ROOT="$ROOT_DIR"
export GTMSHIP_POSTGRES_BIN="\${GTMSHIP_POSTGRES_BIN:-}"

if [ -z "\${GTMSHIP_POSTGRES_BIN}" ]; then
  if [ -n "\${HOMEBREW_PREFIX:-}" ] && [ -x "\${HOMEBREW_PREFIX}/opt/postgresql@16/bin/pg_ctl" ]; then
    export GTMSHIP_POSTGRES_BIN="\${HOMEBREW_PREFIX}/opt/postgresql@16/bin"
  elif [ -x "/opt/homebrew/opt/postgresql@16/bin/pg_ctl" ]; then
    export GTMSHIP_POSTGRES_BIN="/opt/homebrew/opt/postgresql@16/bin"
  elif [ -x "/usr/local/opt/postgresql@16/bin/pg_ctl" ]; then
    export GTMSHIP_POSTGRES_BIN="/usr/local/opt/postgresql@16/bin"
  elif [ -x "/home/linuxbrew/.linuxbrew/opt/postgresql@16/bin/pg_ctl" ]; then
    export GTMSHIP_POSTGRES_BIN="/home/linuxbrew/.linuxbrew/opt/postgresql@16/bin"
  fi
fi

if [ -n "\${GTMSHIP_NODE_BIN:-}" ] && [ -x "\${GTMSHIP_NODE_BIN}" ]; then
  exec "\${GTMSHIP_NODE_BIN}" "$ROOT_DIR/packages/cli/dist/index.js" "$@"
fi

if [ -n "\${HOMEBREW_PREFIX:-}" ] && [ -x "\${HOMEBREW_PREFIX}/opt/node@20/bin/node" ]; then
  exec "\${HOMEBREW_PREFIX}/opt/node@20/bin/node" "$ROOT_DIR/packages/cli/dist/index.js" "$@"
fi

if [ -x "/opt/homebrew/opt/node@20/bin/node" ]; then
  exec "/opt/homebrew/opt/node@20/bin/node" "$ROOT_DIR/packages/cli/dist/index.js" "$@"
fi

if [ -x "/usr/local/opt/node@20/bin/node" ]; then
  exec "/usr/local/opt/node@20/bin/node" "$ROOT_DIR/packages/cli/dist/index.js" "$@"
fi

if [ -x "/home/linuxbrew/.linuxbrew/opt/node@20/bin/node" ]; then
  exec "/home/linuxbrew/.linuxbrew/opt/node@20/bin/node" "$ROOT_DIR/packages/cli/dist/index.js" "$@"
fi

exec node "$ROOT_DIR/packages/cli/dist/index.js" "$@"
`,
    { encoding: "utf8", mode: 0o755 }
  );
}

rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(distRoot, { recursive: true });

run("pnpm", ["build"]);
run("pnpm", ["--filter", "@gtmship/dashboard", "build"]);

[
  "node_modules",
  "package.json",
  "pnpm-workspace.yaml",
  "packages/cli/package.json",
  "packages/cli/dist",
  "packages/auth-service/package.json",
  "packages/auth-service/dist",
  "packages/auth-service/src/prisma",
  "packages/dashboard/package.json",
  "packages/dashboard/.next/standalone",
  "packages/dashboard/.next/static",
  "packages/dashboard/next.config.js",
  "packages/deploy-engine/package.json",
  "packages/deploy-engine/dist",
  "packages/sdk/package.json",
  "packages/sdk/dist",
  "packages/sdk/Dockerfile.cloudrun",
].forEach(copyIntoStage);

writeLauncher();

rmSync(tarballPath, { force: true });
run("tar", ["-czf", tarballPath, "-C", distRoot, releaseName]);

console.log(`Created ${tarballPath}`);
