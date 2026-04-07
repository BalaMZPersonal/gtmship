import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { printDetail, printWarning } from "./output.js";
import {
  DEFAULT_AUTH_URL,
  DEFAULT_DASHBOARD_URL,
  resolveRuntimeLayout,
} from "./install-layout.js";

const require = createRequire(import.meta.url);
const { version: currentVersion } = require("../../package.json") as {
  version: string;
};

const DEFAULT_HOMEBREW_OWNER = process.env.GTMSHIP_HOMEBREW_OWNER?.trim() || "BalaMZPersonal";
const DEFAULT_FORMULA_REF = `${DEFAULT_HOMEBREW_OWNER}/tap/gtmship`;
const DEFAULT_MANIFEST_URL =
  process.env.GTMSHIP_UPDATE_MANIFEST_URL?.trim() ||
  `https://raw.githubusercontent.com/${DEFAULT_HOMEBREW_OWNER}/homebrew-tap/main/gtmship-update.json`;
const DEFAULT_RECOMMENDED_COMMAND = `brew update && brew upgrade ${DEFAULT_FORMULA_REF}`;
const UPDATE_FETCH_TIMEOUT_MS = 5_000;

type InstallMethod = "homebrew" | "unknown";

type UpdateManifest = {
  version: string;
  notesUrl: string | null;
  severity: string;
  message: string | null;
  recommendedCommand: string;
};

type RemoteUpdateStatus = {
  installMethod: InstallMethod;
  runningVersion: string;
  installedVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  restartRequired: boolean;
  severity: string;
  message: string | null;
  notesUrl: string | null;
  recommendedCommand: string | null;
  checkedAt: string;
  stale: boolean;
  snoozedUntil: string | null;
};

type RunningRuntimeVersions = {
  runtimeRunning: boolean;
  authVersion: string | null;
  dashboardVersion: string | null;
  version: string | null;
};

export type CliUpdateStatus = RemoteUpdateStatus & {
  currentVersion: string;
  runtimeRunning: boolean;
  authVersion: string | null;
  dashboardVersion: string | null;
};

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

function parseVersionSegments(version: string): number[] | null {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) {
    return null;
  }

  return match.slice(1).map((segment) => Number.parseInt(segment, 10));
}

export function compareVersions(left: string, right: string): number {
  const leftParts = parseVersionSegments(left);
  const rightParts = parseVersionSegments(right);

  if (!leftParts || !rightParts) {
    return left.localeCompare(right, undefined, { numeric: true });
  }

  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const delta = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (delta !== 0) {
      return delta;
    }
  }

  return 0;
}

function normalizeManifest(value: unknown): UpdateManifest | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const version = typeof record.version === "string" ? record.version.trim() : "";
  if (!version) {
    return null;
  }

  const recommendedCommand =
    typeof record.recommendedCommand === "string" &&
    record.recommendedCommand.trim()
      ? record.recommendedCommand.trim()
      : DEFAULT_RECOMMENDED_COMMAND;

  return {
    version,
    notesUrl:
      typeof record.notesUrl === "string" && record.notesUrl.trim()
        ? record.notesUrl.trim()
        : null,
    severity:
      typeof record.severity === "string" && record.severity.trim()
        ? record.severity.trim().toLowerCase()
        : "info",
    message:
      typeof record.message === "string" && record.message.trim()
        ? record.message.trim()
        : null,
    recommendedCommand,
  };
}

function normalizeIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const normalized = value.trim();
  return Number.isNaN(Date.parse(normalized)) ? null : normalized;
}

function detectInstallMethod(): InstallMethod {
  const installRoot =
    process.env.GTMSHIP_INSTALL_ROOT?.trim() || fileURLToPath(import.meta.url);
  const normalized = installRoot.replace(/\\/g, "/");
  return normalized.includes("/Cellar/gtmship/") ? "homebrew" : "unknown";
}

function findExecutable(name: string, extraDirs: string[] = []): string | null {
  const searchDirs = [
    ...extraDirs,
    ...(process.env.PATH || "").split(path.delimiter).filter(Boolean),
  ];

  for (const dir of searchDirs) {
    const fullPath = path.join(dir, name);
    try {
      accessSync(fullPath, constants.X_OK);
      return fullPath;
    } catch {
      // Ignore missing executables.
    }
  }

  return null;
}

async function runCommand(
  command: string,
  args: string[],
  input: { stream?: boolean; cwd?: string } = {}
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: input.cwd,
      stdio: input.stream ? "inherit" : ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    if (!input.stream) {
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
    }

    child.on("error", (error) => {
      resolve({
        code: 1,
        stdout,
        stderr: `${stderr}${error.message}`,
      });
    });

    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(UPDATE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

async function fetchRuntimeHealth(url: string): Promise<string | null> {
  const payload = await fetchJson<{ version?: string }>(url);
  return typeof payload?.version === "string" && payload.version.trim()
    ? payload.version.trim()
    : null;
}

async function getRunningRuntimeVersions(): Promise<RunningRuntimeVersions> {
  const layout = resolveRuntimeLayout();
  const authVersion = await fetchRuntimeHealth(`${layout.authUrl || DEFAULT_AUTH_URL}/health`);
  const dashboardVersion = await fetchRuntimeHealth(
    `${layout.dashboardUrl || DEFAULT_DASHBOARD_URL}/api/health`
  );

  return {
    runtimeRunning: Boolean(authVersion || dashboardVersion),
    authVersion,
    dashboardVersion,
    version: authVersion || dashboardVersion || null,
  };
}

function isRemoteUpdateStatus(value: unknown): value is RemoteUpdateStatus {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.runningVersion === "string";
}

async function fetchRemoteUpdateStatus(): Promise<RemoteUpdateStatus | null> {
  const layout = resolveRuntimeLayout();
  const payload = await fetchJson<unknown>(`${layout.authUrl}/updates/status`);
  return isRemoteUpdateStatus(payload) ? payload : null;
}

async function fetchUpdateManifest(): Promise<UpdateManifest | null> {
  return normalizeManifest(await fetchJson<unknown>(DEFAULT_MANIFEST_URL));
}

async function getInstalledHomebrewVersion(
  brewPath: string
): Promise<string | null> {
  const result = await runCommand(brewPath, ["info", "--json=v2", DEFAULT_FORMULA_REF]);
  if (result.code !== 0 || !result.stdout.trim()) {
    return null;
  }

  try {
    const data = JSON.parse(result.stdout) as {
      formulae?: Array<{
        installed?: Array<{ version?: string }>;
      }>;
    };
    const installedVersions = (data.formulae?.[0]?.installed || [])
      .map((entry) => entry.version?.trim() || "")
      .filter(Boolean)
      .sort(compareVersions);
    return installedVersions.at(-1) || null;
  } catch {
    return null;
  }
}

async function getHomebrewPrefix(brewPath: string): Promise<string | null> {
  const result = await runCommand(brewPath, ["--prefix"]);
  return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

function buildLocalStatus(input: {
  installMethod: InstallMethod;
  runtime: RunningRuntimeVersions;
  installedVersion: string | null;
  manifest: UpdateManifest | null;
  stale: boolean;
}): CliUpdateStatus {
  const latestVersion = input.manifest?.version || null;
  const installedVersion = input.installedVersion || currentVersion;
  const runningVersion = input.runtime.version || currentVersion;
  const updateAvailable = Boolean(
    latestVersion && compareVersions(latestVersion, installedVersion) > 0
  );
  const restartRequired = Boolean(
    input.runtime.version &&
      input.installedVersion &&
      compareVersions(input.installedVersion, input.runtime.version) > 0
  );

  return {
    installMethod: input.installMethod,
    currentVersion,
    runtimeRunning: input.runtime.runtimeRunning,
    authVersion: input.runtime.authVersion,
    dashboardVersion: input.runtime.dashboardVersion,
    runningVersion,
    installedVersion: input.installedVersion || currentVersion,
    latestVersion,
    updateAvailable,
    restartRequired,
    severity: input.manifest?.severity || "info",
    message: restartRequired
      ? `GTMShip ${input.installedVersion} is installed. Run \`gtmship restart\` to load the new runtime.`
      : input.manifest?.message ||
        (updateAvailable && latestVersion ? `GTMShip ${latestVersion} is available.` : null),
    notesUrl: input.manifest?.notesUrl || null,
    recommendedCommand: restartRequired
      ? "gtmship restart"
      : updateAvailable && input.installMethod === "homebrew"
        ? input.manifest?.recommendedCommand || DEFAULT_RECOMMENDED_COMMAND
        : null,
    checkedAt: new Date().toISOString(),
    stale: input.stale,
    snoozedUntil: null,
  };
}

export async function getCliUpdateStatus(input: {
  preferRemote?: boolean;
} = {}): Promise<CliUpdateStatus> {
  const runtime = await getRunningRuntimeVersions();

  if (input.preferRemote !== false && runtime.runtimeRunning) {
    const remote = await fetchRemoteUpdateStatus();
    if (remote) {
      return {
        ...remote,
        currentVersion,
        runtimeRunning: runtime.runtimeRunning,
        authVersion: runtime.authVersion,
        dashboardVersion: runtime.dashboardVersion,
      };
    }
  }

  const installMethod = detectInstallMethod();
  const brewPath =
    installMethod === "homebrew"
      ? findExecutable("brew", [
          "/opt/homebrew/bin",
          "/usr/local/bin",
          "/home/linuxbrew/.linuxbrew/bin",
        ])
      : null;
  const installedVersion =
    installMethod === "homebrew" && brewPath
      ? await getInstalledHomebrewVersion(brewPath)
      : currentVersion;
  const manifest = await fetchUpdateManifest();

  return buildLocalStatus({
    installMethod,
    runtime,
    installedVersion,
    manifest,
    stale: !manifest,
  });
}

export function shouldShowUpdateNotice(status: CliUpdateStatus): boolean {
  if (status.snoozedUntil && Date.parse(status.snoozedUntil) > Date.now()) {
    return false;
  }

  return status.updateAvailable || status.restartRequired;
}

export function printUpdateNotice(status: CliUpdateStatus): void {
  if (!shouldShowUpdateNotice(status) || !status.message) {
    return;
  }

  console.log("");
  printWarning(status.message);
  if (status.recommendedCommand) {
    printDetail("Next", status.recommendedCommand);
  }
  if (status.notesUrl) {
    printDetail("Release Notes", status.notesUrl);
  }
  if (status.stale) {
    console.log(
      chalk.gray("  Update metadata could not be refreshed, so this check may be stale.")
    );
  }
  console.log("");
}

export async function maybePrintRuntimeUpdateNotice(): Promise<void> {
  try {
    printUpdateNotice(await getCliUpdateStatus({ preferRemote: true }));
  } catch {
    // Keep runtime commands quiet if the update check fails.
  }
}

export async function runHomebrewUpdate(input: {
  stream?: boolean;
} = {}): Promise<{
  code: number;
  brewPath: string | null;
  prefix: string | null;
  stdout: string;
  stderr: string;
}> {
  const brewPath = findExecutable("brew", [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/home/linuxbrew/.linuxbrew/bin",
  ]);

  if (!brewPath) {
    return {
      code: 1,
      brewPath: null,
      prefix: null,
      stdout: "",
      stderr: "Could not find Homebrew. Install Homebrew first.",
    };
  }

  const updateResult = await runCommand(brewPath, ["update"], {
    stream: input.stream,
  });
  if (updateResult.code !== 0) {
    return {
      code: updateResult.code,
      brewPath,
      prefix: null,
      stdout: updateResult.stdout,
      stderr: updateResult.stderr,
    };
  }

  const upgradeResult = await runCommand(brewPath, ["upgrade", DEFAULT_FORMULA_REF], {
    stream: input.stream,
  });
  const prefix = await getHomebrewPrefix(brewPath);

  return {
    code: upgradeResult.code,
    brewPath,
    prefix,
    stdout: `${updateResult.stdout}${upgradeResult.stdout}`,
    stderr: `${updateResult.stderr}${upgradeResult.stderr}`,
  };
}

export async function restartInstalledRuntime(input: {
  brewPrefix?: string | null;
  stream?: boolean;
} = {}): Promise<CommandResult> {
  const candidate =
    input.brewPrefix && input.brewPrefix.trim()
      ? path.join(input.brewPrefix, "bin", "gtmship")
      : null;
  const command =
    candidate && findExecutable(path.basename(candidate), [path.dirname(candidate)])
      ? candidate
      : findExecutable("gtmship", [
          "/opt/homebrew/bin",
          "/usr/local/bin",
          "/home/linuxbrew/.linuxbrew/bin",
        ]) || "gtmship";

  return runCommand(command, ["restart"], {
    stream: input.stream,
  });
}
