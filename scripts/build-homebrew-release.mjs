#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: options.cwd || repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      FORCE_COLOR: "1",
      ...options.env,
    },
  });
}

function capture(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      FORCE_COLOR: "1",
      ...options.env,
    },
  });
}

function copyIntoStage(relativePath, options = {}) {
  const source = path.join(repoRoot, relativePath);
  const destination = path.join(stagingDir, relativePath);
  const { dereference = false, filter } = options;

  if (!existsSync(source)) {
    throw new Error(`Missing required release input: ${relativePath}`);
  }

  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination, {
    recursive: true,
    dereference,
    filter,
    preserveTimestamps: true,
  });
}

function copyIntoStageAs(sourceRelativePath, destinationRelativePath, options = {}) {
  const source = path.join(repoRoot, sourceRelativePath);
  const destination = path.join(stagingDir, destinationRelativePath);
  const { dereference = false, filter } = options;

  if (!existsSync(source)) {
    throw new Error(`Missing required release input: ${sourceRelativePath}`);
  }

  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination, {
    recursive: true,
    dereference,
    filter,
    preserveTimestamps: true,
  });
}

function deployWorkspacePackage(packageName, targetRelativePath) {
  const targetDir = path.join(stagingDir, targetRelativePath);
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(path.dirname(targetDir), { recursive: true });
  run("pnpm", ["--filter", packageName, "deploy", "--prod", targetDir]);
  rewritePackageSelfReference(targetDir, packageName);
  return targetDir;
}

function rewritePackageSelfReference(packageDir, packageName) {
  const linkPath = path.join(
    packageDir,
    "node_modules",
    ".pnpm",
    "node_modules",
    ...packageName.split("/")
  );

  if (!existsSync(linkPath) || !lstatSync(linkPath).isSymbolicLink()) {
    return;
  }

  const linkTarget = readlinkSync(linkPath);
  const resolvedTarget = path.resolve(path.dirname(linkPath), linkTarget);
  if (resolvedTarget === packageDir) {
    return;
  }

  unlinkSync(linkPath);
  symlinkSync(path.relative(path.dirname(linkPath), packageDir), linkPath, "dir");
}

function generatePrismaClient(authServiceDir) {
  const prismaBinary = path.join(authServiceDir, "node_modules", ".bin", "prisma");
  if (!existsSync(prismaBinary)) {
    throw new Error(`Missing Prisma CLI in staged auth-service bundle: ${prismaBinary}`);
  }

  run(prismaBinary, ["generate", "--schema", "src/prisma/schema.prisma"], {
    cwd: authServiceDir,
  });
}

function rewriteAbsoluteStageSymlinks(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const linkTarget = readlinkSync(fullPath);
      if (!path.isAbsolute(linkTarget)) {
        continue;
      }

      if (!linkTarget.startsWith(repoRoot)) {
        throw new Error(`Absolute symlink points outside the repository: ${fullPath} -> ${linkTarget}`);
      }

      const stagedTarget = path.join(stagingDir, path.relative(repoRoot, linkTarget));
      if (!existsSync(stagedTarget)) {
        throw new Error(`Missing staged target for absolute symlink: ${fullPath} -> ${linkTarget}`);
      }

      unlinkSync(fullPath);
      symlinkSync(
        path.relative(path.dirname(fullPath), stagedTarget),
        fullPath,
        lstatSync(stagedTarget).isDirectory() ? "dir" : "file"
      );
      continue;
    }

    if (entry.isDirectory()) {
      rewriteAbsoluteStageSymlinks(fullPath);
    }
  }
}

function walkFiles(dir, predicate, results = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, predicate, results);
      continue;
    }

    if (entry.isFile() && predicate(fullPath)) {
      results.push(fullPath);
    }
  }

  return results;
}

function isSystemMachOPath(target) {
  return (
    target.startsWith("/usr/lib/") ||
    target.startsWith("/System/Library/") ||
    target.startsWith("/System/Volumes/Preboot/")
  );
}

function rewriteMachOInstallNames(dir) {
  if (platform !== "darwin") {
    return;
  }

  const nativeBinaries = walkFiles(
    dir,
    (filePath) => filePath.endsWith(".node") || filePath.endsWith(".dylib")
  );

  for (const filePath of nativeBinaries) {
    let dylibId = "";
    try {
      const output = capture("otool", ["-D", filePath]);
      const lines = output
        .split("\n")
        .slice(1)
        .map((line) => line.trim())
        .filter(Boolean);
      dylibId = lines[0] || "";
    } catch {
      continue;
    }

    if (!dylibId || !path.isAbsolute(dylibId) || isSystemMachOPath(dylibId)) {
      continue;
    }

    run("install_name_tool", [
      "-id",
      `@loader_path/${path.basename(dylibId)}`,
      filePath,
    ]);
  }
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

deployWorkspacePackage("@gtmship/cli", path.join("packages", "cli"));
const authServiceDir = deployWorkspacePackage(
  "@gtmship/auth-service",
  path.join("packages", "auth-service")
);
generatePrismaClient(authServiceDir);

copyIntoStage("packages/dashboard/.next/standalone");
copyIntoStageAs(
  "packages/dashboard/.next/static",
  path.join(
    "packages",
    "dashboard",
    ".next",
    "standalone",
    "packages",
    "dashboard",
    ".next",
    "static"
  )
);
copyIntoStageAs(
  "packages/dashboard/public",
  path.join(
    "packages",
    "dashboard",
    ".next",
    "standalone",
    "packages",
    "dashboard",
    "public"
  )
);
rewriteAbsoluteStageSymlinks(stagingDir);
rewriteMachOInstallNames(stagingDir);

writeLauncher();

rmSync(tarballPath, { force: true });
run("tar", ["-czf", tarballPath, "-C", distRoot, releaseName]);

console.log(`Created ${tarballPath}`);
