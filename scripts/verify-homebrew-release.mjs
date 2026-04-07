#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync, readdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";

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

function parseArgs(argv) {
  const args = new Map();

  for (const entry of argv.slice(2)) {
    if (!entry.startsWith("--")) {
      continue;
    }

    const [key, value] = entry.slice(2).split("=", 2);
    if (value) {
      args.set(key, value);
    }
  }

  return {
    platform: normalizePlatform(args.get("platform") || process.platform),
    arch: normalizeArch(args.get("arch") || process.arch),
  };
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function walkSymlinks(dir, results = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      results.push(fullPath);
      continue;
    }

    if (entry.isDirectory()) {
      walkSymlinks(fullPath, results);
    }
  }

  return results;
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isSystemMachOPath(target) {
  return (
    target.startsWith("/usr/lib/") ||
    target.startsWith("/System/Library/") ||
    target.startsWith("/System/Volumes/Preboot/")
  );
}

function parseOtoolPaths(output) {
  return output
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/)[0] || "")
    .filter(Boolean);
}

function verifyStageStructure(stageDir) {
  const requiredPaths = [
    path.join(stageDir, "bin", "gtmship"),
    path.join(stageDir, "packages", "cli", "dist", "index.js"),
    path.join(stageDir, "packages", "auth-service", "dist", "server.js"),
    path.join(
      stageDir,
      "packages",
      "dashboard",
      ".next",
      "standalone",
      "packages",
      "dashboard",
      "server.js"
    ),
  ];

  for (const requiredPath of requiredPaths) {
    assert(existsSync(requiredPath), `Missing required staged file: ${requiredPath}`);
  }
}

function verifySymlinks(stageDir) {
  for (const symlinkPath of walkSymlinks(stageDir)) {
    const target = readlinkSync(symlinkPath);
    assert(!path.isAbsolute(target), `Absolute symlink found: ${symlinkPath} -> ${target}`);

    const resolvedTarget = path.resolve(path.dirname(symlinkPath), target);
    assert(existsSync(resolvedTarget), `Broken symlink found: ${symlinkPath} -> ${target}`);
    assert(
      isWithin(stageDir, resolvedTarget),
      `Symlink escapes release bundle: ${symlinkPath} -> ${target}`
    );
  }
}

function verifyCli(stageDir) {
  const launcherPath = path.join(stageDir, "bin", "gtmship");
  const result = spawnSync(launcherPath, ["--help"], {
    cwd: stageDir,
    encoding: "utf8",
    env: process.env,
  });

  assert(
    result.status === 0,
    `Packaged CLI failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );

  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  assert(
    combinedOutput.includes("Usage: gtmship"),
    "Packaged CLI help output did not contain the expected usage banner."
  );
}

function verifyNativeInstallNames(stageDir, platform) {
  if (platform !== "darwin") {
    return;
  }

  const nativeBinaries = walkFiles(
    stageDir,
    (filePath) => filePath.endsWith(".node") || filePath.endsWith(".dylib")
  );

  for (const filePath of nativeBinaries) {
    const result = spawnSync("otool", ["-L", filePath], {
      encoding: "utf8",
    });

    assert(
      result.status === 0,
      `Could not inspect Mach-O install names for ${filePath}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );

    const problematicPaths = parseOtoolPaths(result.stdout).filter(
      (target) => path.isAbsolute(target) && !isSystemMachOPath(target)
    );

    assert(
      problematicPaths.length === 0,
      `Mach-O file contains non-system absolute install names: ${filePath}\n${problematicPaths.join("\n")}`
    );
  }
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not determine an ephemeral port.")));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForHttp(url, matcher, timeoutMs = 20_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      const body = await response.text();
      if (response.ok && matcher(body)) {
        return body;
      }
    } catch {
      // Keep polling.
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return null;
}

async function stopChild(child) {
  if (!child.pid || child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (child.exitCode === null) {
    child.kill("SIGKILL");
  }
}

async function verifyServiceStart(input) {
  const child = spawn(process.execPath, input.args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const body = await waitForHttp(input.healthUrl, input.matcher);
    if (body) {
      return;
    }

    throw new Error(
      `${input.name} did not become healthy.\nstdout:\n${stdout}\nstderr:\n${stderr}`
    );
  } finally {
    await stopChild(child);
  }
}

async function verifyAuthService(stageDir) {
  const port = await reservePort();
  await verifyServiceStart({
    name: "Auth service",
    cwd: path.join(stageDir, "packages", "auth-service"),
    args: ["dist/server.js"],
    env: {
      ...process.env,
      PORT: `${port}`,
      DATABASE_URL: "postgresql://invalid:invalid@127.0.0.1:1/gtmship",
    },
    healthUrl: `http://127.0.0.1:${port}/health`,
    matcher: (body) => body.includes("\"service\":\"gtmship-auth\""),
  });
}

async function verifyDashboard(stageDir) {
  const port = await reservePort();
  const standaloneDir = path.join(
    stageDir,
    "packages",
    "dashboard",
    ".next",
    "standalone"
  );

  await verifyServiceStart({
    name: "Dashboard",
    cwd: standaloneDir,
    args: ["packages/dashboard/server.js"],
    env: {
      ...process.env,
      PORT: `${port}`,
      HOSTNAME: "127.0.0.1",
    },
    healthUrl: `http://127.0.0.1:${port}/api/health`,
    matcher: (body) => body.includes("\"service\":\"gtmship-dashboard\""),
  });
}

async function main() {
  const { platform, arch } = parseArgs(process.argv);
  const stageDir = path.join(
    process.cwd(),
    "dist",
    "homebrew",
    `gtmship-${platform}-${arch}`
  );

  assert(existsSync(stageDir), `Release stage directory not found: ${stageDir}`);
  assert(lstatSync(stageDir).isDirectory(), `Release stage path is not a directory: ${stageDir}`);

  verifyStageStructure(stageDir);
  verifySymlinks(stageDir);
  verifyNativeInstallNames(stageDir, platform);
  verifyCli(stageDir);
  await verifyAuthService(stageDir);
  await verifyDashboard(stageDir);

  console.log(`Verified ${path.basename(stageDir)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
