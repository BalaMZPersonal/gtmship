import { spawn } from "node:child_process";
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import chalk from "chalk";
import ora from "ora";
import {
  DEFAULT_AUTH_PORT,
  DEFAULT_AUTH_URL,
  DEFAULT_DATABASE_URL,
  DEFAULT_DATABASE_PORT,
  DEFAULT_DASHBOARD_PORT,
  DEFAULT_DASHBOARD_URL,
  resolveRuntimeLayout,
  type RuntimeLayout,
} from "./install-layout.js";

interface RuntimeConfig {
  version: 1;
  encryptionKey: string;
  installRoot: string;
  projectRoot: string;
  authUrl: string;
  dashboardUrl: string;
  updatedAt: string;
}

interface RuntimeStatus {
  auth: "running" | "stopped" | "external";
  dashboard: "running" | "stopped" | "external";
  postgres: "running" | "stopped";
  authHealthy: boolean;
  dashboardHealthy: boolean;
  authUrl: string;
  dashboardUrl: string;
  projectRoot: string;
  authLogPath: string;
  dashboardLogPath: string;
  postgresLogPath: string;
  runtimeDebugLogPath: string;
}

function authServiceReady(body: string): boolean {
  return (
    body.includes("\"service\":\"gtmship-auth\"") &&
    body.includes("\"database\":\"ok\"")
  );
}

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type PostgresTools = {
  pgCtl: string;
  initdb: string;
  createdb: string;
  pgIsReady: string;
};

type BackgroundServiceKind = RuntimeLayout["backgroundServiceKind"];

function resolveDatabaseUser(): string {
  try {
    const url = new URL(DEFAULT_DATABASE_URL);
    return url.username || process.env.USER?.trim() || "postgres";
  } catch {
    return process.env.USER?.trim() || "postgres";
  }
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function ensureFileParent(filePath: string): void {
  ensureDir(path.dirname(filePath));
}

function appendRuntimeDebugLog(layout: RuntimeLayout, message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  ensureFileParent(layout.runtimeDebugLogPath);
  appendFileSync(layout.runtimeDebugLogPath, line, "utf8");
}

function safeUnlink(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // Ignore missing files.
  }
}

function readJson<T>(filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(filePath: string, value: unknown): void {
  ensureFileParent(filePath);
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isProcessRunning(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile(filePath: string): number | null {
  if (!existsSync(filePath)) {
    return null;
  }

  const value = Number.parseInt(readFileSync(filePath, "utf8").trim(), 10);
  return Number.isFinite(value) ? value : null;
}

function writePidFile(filePath: string, pid: number): void {
  ensureFileParent(filePath);
  writeFileSync(filePath, `${pid}\n`, "utf8");
}

async function readProcessCommand(pid: number): Promise<string | null> {
  const result = await runCommand("ps", ["-p", `${pid}`, "-o", "command="], {
    allowedExitCodes: [0, 1],
  });

  if (result.code !== 0) {
    return null;
  }

  const command = result.stdout.trim();
  return command || null;
}

async function stopStaleManagedProcess(
  layout: RuntimeLayout,
  pidPath: string,
  expectedEntrypoint: string
): Promise<boolean> {
  const pid = readPidFile(pidPath);
  if (!pid || !isProcessRunning(pid)) {
    appendRuntimeDebugLog(
      layout,
      `No stale managed process found for ${pidPath} (pid missing or not running).`
    );
    return false;
  }

  const command = await readProcessCommand(pid);
  if (command && command.includes(expectedEntrypoint)) {
    appendRuntimeDebugLog(
      layout,
      `Managed process ${pid} matches expected entrypoint for ${pidPath}; keeping it for now.`
    );
    return false;
  }

  appendRuntimeDebugLog(
    layout,
    `Stopping stale managed process ${pid} from ${pidPath}. Command: ${command || "(unknown)"}`
  );
  await stopPidFile(pidPath);
  return true;
}

async function stopManagedProcessIfMatching(
  layout: RuntimeLayout,
  pidPath: string,
  expectedEntrypoint: string
): Promise<boolean> {
  const pid = readPidFile(pidPath);
  if (!pid || !isProcessRunning(pid)) {
    appendRuntimeDebugLog(
      layout,
      `No matching managed process found for ${pidPath} (pid missing or not running).`
    );
    return false;
  }

  const command = await readProcessCommand(pid);
  if (!command || !command.includes(expectedEntrypoint)) {
    appendRuntimeDebugLog(
      layout,
      `Managed process ${pid} for ${pidPath} does not match expected entrypoint. Command: ${command || "(unknown)"}`
    );
    return false;
  }

  appendRuntimeDebugLog(
    layout,
    `Stopping matching managed process ${pid} from ${pidPath} before restart. Command: ${command}`
  );
  await stopPidFile(pidPath);
  return true;
}

async function stopManagedListenerIfPidMatches(input: {
  layout: RuntimeLayout;
  pidPath: string;
  port: number;
  serviceLabel: string;
}): Promise<boolean> {
  const managedPid = readPidFile(input.pidPath);
  if (!managedPid || !isProcessRunning(managedPid)) {
    appendRuntimeDebugLog(
      input.layout,
      `No managed pid available to refresh ${input.serviceLabel} on port ${input.port}.`
    );
    return false;
  }

  const listenerPid = await findListeningPid(input.port);
  if (!listenerPid || listenerPid !== managedPid) {
    appendRuntimeDebugLog(
      input.layout,
      `Managed pid ${managedPid} for ${input.serviceLabel} does not own listener on port ${input.port}. Listener pid: ${listenerPid || "none"}.`
    );
    return false;
  }

  appendRuntimeDebugLog(
    input.layout,
    `Stopping managed ${input.serviceLabel} listener pid ${managedPid} on port ${input.port} before restart.`
  );
  await stopPidFile(input.pidPath);
  return true;
}

async function findListeningPid(port: number): Promise<number | null> {
  const lsof = findExecutable("lsof");
  if (!lsof) {
    return null;
  }

  const result = await runCommand(
    lsof,
    ["-t", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"],
    {
      allowedExitCodes: [0, 1],
    }
  );

  if (result.code !== 0) {
    return null;
  }

  const firstLine = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) {
    return null;
  }

  const pid = Number.parseInt(firstLine, 10);
  return Number.isFinite(pid) ? pid : null;
}

async function resolveConflictingServiceCommand(port: number): Promise<string | null> {
  const pid = await findListeningPid(port);
  if (!pid) {
    return null;
  }

  return readProcessCommand(pid);
}

export async function assertNoConflictingHealthyService(input: {
  layout: RuntimeLayout;
  port: number;
  url: string;
  healthPath: string;
  matcher: (body: string) => boolean;
  expectedEntrypoint: string;
  pidPath: string;
  serviceLabel: string;
}): Promise<"running" | "external" | null> {
  const healthy = await waitForHttp(
    `${input.url}${input.healthPath}`,
    input.matcher,
    1_000
  );
  if (!healthy) {
    appendRuntimeDebugLog(
      input.layout,
      `No healthy service detected on ${input.url}${input.healthPath} for ${input.serviceLabel}.`
    );
    return null;
  }

  const managedPid = readPidFile(input.pidPath);
  if (managedPid && isProcessRunning(managedPid)) {
    appendRuntimeDebugLog(
      input.layout,
      `Healthy ${input.serviceLabel} already running from managed pid ${managedPid}.`
    );
    return "running";
  }

  const command = await resolveConflictingServiceCommand(input.port);
  if (command && command.includes(input.expectedEntrypoint)) {
    appendRuntimeDebugLog(
      input.layout,
      `Healthy ${input.serviceLabel} found on port ${input.port} as external runtime. Command: ${command}`
    );
    return "external";
  }

  const detail = command ? `\nConflicting process: ${command}` : "";
  appendRuntimeDebugLog(
    input.layout,
    `Conflicting healthy service found on port ${input.port} for ${input.serviceLabel}. Command: ${command || "(unknown)"}`
  );
  throw new Error(
    `${input.serviceLabel} is already responding on ${input.url}, but it is not the current GTMShip runtime.${detail}\nStop the conflicting service before running GTMShip so it uses the expected local database and runtime.`
  );
}

async function stopHealthyServiceOnPort(input: {
  layout: RuntimeLayout;
  port: number;
  url: string;
  healthPath: string;
  matcher: (body: string) => boolean;
  serviceLabel: string;
}): Promise<boolean> {
  const healthy = await waitForHttp(
    `${input.url}${input.healthPath}`,
    input.matcher,
    1_000
  );
  if (!healthy) {
    appendRuntimeDebugLog(
      input.layout,
      `No healthy ${input.serviceLabel} found on port ${input.port} during cleanup.`
    );
    return false;
  }

  const pid = await findListeningPid(input.port);
  if (!pid || !isProcessRunning(pid)) {
    appendRuntimeDebugLog(
      input.layout,
      `Healthy ${input.serviceLabel} responded on port ${input.port}, but no live listener pid was found during cleanup.`
    );
    return false;
  }

  const command = await readProcessCommand(pid);
  appendRuntimeDebugLog(
    input.layout,
    `Stopping lingering ${input.serviceLabel} pid ${pid} on port ${input.port}. Command: ${command || "(unknown)"}`
  );

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < 7_500) {
    if (!isProcessRunning(pid)) {
      return true;
    }
    await sleep(250);
  }

  if (isProcessRunning(pid)) {
    process.kill(pid, "SIGKILL");
  }

  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;

    const finish = (inUse: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(inUse);
    };

    server.once("error", () => finish(true));
    server.once("listening", () => {
      server.close(() => finish(false));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function waitForHttp(
  url: string,
  matcher: (body: string) => boolean,
  timeoutMs = 30_000
): Promise<boolean> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      const body = await response.text();
      if (response.ok && matcher(body)) {
        return true;
      }
    } catch {
      // Keep waiting.
    }

    await sleep(800);
  }

  return false;
}

function findExecutable(name: string, extraDirs: string[] = []): string | null {
  const searchDirs = [
    ...extraDirs,
    ...`${process.env.PATH || ""}`.split(path.delimiter).filter(Boolean),
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

function withRuntimeNodeEnv(
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const nodeBin = process.execPath;
  const pathEntries = [
    path.dirname(nodeBin),
    ...(env.PATH || process.env.PATH || "").split(path.delimiter),
  ].filter(Boolean);

  return {
    ...env,
    GTMSHIP_NODE_BIN: env.GTMSHIP_NODE_BIN || nodeBin,
    PATH: Array.from(new Set(pathEntries)).join(path.delimiter),
  };
}

function withPostgresLocaleEnv(
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  if (process.platform !== "darwin") {
    return env;
  }

  const locale = env.GTMSHIP_POSTGRES_LOCALE?.trim() || "en_US.UTF-8";
  return {
    ...env,
    LANG: locale,
    LC_ALL: locale,
    LC_CTYPE: locale,
  };
}

async function postgresPortReady(tools: PostgresTools): Promise<boolean> {
  const ready = await runCommand(
    tools.pgIsReady,
    ["-h", "127.0.0.1", "-p", `${DEFAULT_DATABASE_PORT}`],
    {
      env: withPostgresLocaleEnv(),
      allowedExitCodes: [0, 1, 2],
    }
  );
  return ready.code === 0;
}

function resolvePostgresTools(): PostgresTools {
  const hintedDir = process.env.GTMSHIP_POSTGRES_BIN?.trim();
  const brewDirs = [
    hintedDir || "",
    process.env.HOMEBREW_PREFIX
      ? path.join(process.env.HOMEBREW_PREFIX, "opt", "postgresql@16", "bin")
      : "",
    "/opt/homebrew/opt/postgresql@16/bin",
    "/usr/local/opt/postgresql@16/bin",
    "/home/linuxbrew/.linuxbrew/opt/postgresql@16/bin",
  ].filter(Boolean);

  const pgCtl = findExecutable("pg_ctl", brewDirs);
  const initdb = findExecutable("initdb", brewDirs);
  const createdb = findExecutable("createdb", brewDirs);
  const pgIsReady = findExecutable("pg_isready", brewDirs);

  if (!pgCtl || !initdb || !createdb || !pgIsReady) {
    throw new Error(
      "Could not find the PostgreSQL 16 command-line tools. Install `postgresql@16` with Homebrew or set GTMSHIP_POSTGRES_BIN."
    );
  }

  return {
    pgCtl,
    initdb,
    createdb,
    pgIsReady,
  };
}

function runtimeConfig(layout: RuntimeLayout): RuntimeConfig {
  const current = readJson<RuntimeConfig>(layout.runtimeConfigPath);
  if (current?.version === 1 && current.encryptionKey) {
    return current;
  }

  const next: RuntimeConfig = {
    version: 1,
    encryptionKey: crypto.randomBytes(24).toString("hex"),
    installRoot: layout.rootDir,
    projectRoot: layout.projectRoot,
    authUrl: layout.authUrl,
    dashboardUrl: layout.dashboardUrl,
    updatedAt: new Date().toISOString(),
  };
  writeJson(layout.runtimeConfigPath, next);
  return next;
}

function persistRuntimeConfig(
  layout: RuntimeLayout,
  current: RuntimeConfig
): RuntimeConfig {
  const next: RuntimeConfig = {
    ...current,
    installRoot: layout.rootDir,
    projectRoot: layout.projectRoot,
    authUrl: layout.authUrl,
    dashboardUrl: layout.dashboardUrl,
    updatedAt: new Date().toISOString(),
  };
  writeJson(layout.runtimeConfigPath, next);
  return next;
}

function pidFile(layout: RuntimeLayout, name: "auth" | "dashboard"): string {
  return path.join(layout.runDir, `${name}.pid`);
}

function spawnDetachedProcess(input: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  pidPath: string;
}): number {
  ensureFileParent(input.logPath);
  const stdout = openSync(input.logPath, "a");
  const stderr = openSync(input.logPath, "a");

  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    env: withRuntimeNodeEnv(input.env),
    detached: true,
    stdio: ["ignore", stdout, stderr],
  });

  child.unref();

  if (!child.pid) {
    throw new Error(`Failed to start ${path.basename(input.command)}.`);
  }

  writePidFile(input.pidPath, child.pid);
  return child.pid;
}

async function runCommand(
  command: string,
  args: string[],
  input: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    allowedExitCodes?: number[];
  } = {}
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: input.cwd,
      env: withRuntimeNodeEnv(input.env),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
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

function createSharedRuntimeEnv(
  layout: RuntimeLayout,
  config: RuntimeConfig
): NodeJS.ProcessEnv {
  return {
    ...withRuntimeNodeEnv(),
    DATABASE_URL: layout.databaseUrl,
    REDIS_URL: "redis://127.0.0.1:6380",
    ENCRYPTION_KEY: config.encryptionKey,
    CORS_ORIGIN: layout.dashboardUrl,
    DASHBOARD_URL: layout.dashboardUrl,
    AUTH_PUBLIC_URL: layout.authUrl,
    AUTH_SERVICE_URL: layout.authUrl,
    NEXT_PUBLIC_AUTH_URL: layout.authUrl,
    GTMSHIP_PROJECT_ROOT: layout.projectRoot,
    PROJECT_ROOT: layout.projectRoot,
    GTMSHIP_INSTALL_ROOT: layout.rootDir,
    GTMSHIP_CLI_ENTRY: layout.cliEntry,
  };
}

async function ensurePostgresCluster(
  layout: RuntimeLayout,
  tools: PostgresTools
): Promise<void> {
  ensureDir(layout.postgresDir);
  const postgresEnv = withPostgresLocaleEnv();
  appendRuntimeDebugLog(
    layout,
    `Ensuring PostgreSQL cluster at ${layout.postgresDataDir} using database URL ${layout.databaseUrl}.`
  );

  if (!existsSync(path.join(layout.postgresDataDir, "PG_VERSION"))) {
    const initSpinner = ora("Initializing local PostgreSQL data directory...").start();
    const result = await runCommand(tools.initdb, [
      "-D",
      layout.postgresDataDir,
      "-U",
      resolveDatabaseUser(),
      "--auth=trust",
      "--encoding=UTF8",
    ], {
      env: postgresEnv,
    });

    if (result.code !== 0) {
      initSpinner.fail("Failed to initialize PostgreSQL");
      const output = result.stderr || result.stdout || "initdb failed.";
      const localeHint =
        process.platform === "darwin" && /invalid locale settings/i.test(output)
          ? "\nSet GTMSHIP_POSTGRES_LOCALE=en_US.UTF-8 and try again if your shell exports a custom locale."
          : "";
      throw new Error(`${output}${localeHint}`);
    }

    initSpinner.succeed("Initialized local PostgreSQL data directory");
    appendRuntimeDebugLog(layout, `Initialized PostgreSQL data directory at ${layout.postgresDataDir}.`);
  }

  const status = await runCommand(
    tools.pgCtl,
    ["-D", layout.postgresDataDir, "status"],
    { env: postgresEnv }
  );
  if (status.code === 0 && (await postgresPortReady(tools))) {
    appendRuntimeDebugLog(
      layout,
      `PostgreSQL already running for ${layout.postgresDataDir} and accepting connections on port ${DEFAULT_DATABASE_PORT}.`
    );
    return;
  }

  if (status.code === 0) {
    appendRuntimeDebugLog(
      layout,
      `PostgreSQL reported running for ${layout.postgresDataDir}, but port ${DEFAULT_DATABASE_PORT} did not pass readiness check.`
    );
    throw new Error(
      `PostgreSQL reports itself as running for ${layout.postgresDataDir}, but ${layout.databaseUrl} is not reachable. Stop the stale cluster or the conflicting listener on port ${DEFAULT_DATABASE_PORT} before running GTMShip.`
    );
  }

  if (await portInUse(DEFAULT_DATABASE_PORT)) {
    const command = await resolveConflictingServiceCommand(DEFAULT_DATABASE_PORT);
    appendRuntimeDebugLog(
      layout,
      `Port ${DEFAULT_DATABASE_PORT} already in use before PostgreSQL start. Listener: ${command || "(unknown)"}`
    );
    throw new Error(
      `Port ${DEFAULT_DATABASE_PORT} is already in use. Stop the conflicting process before running GTMShip.`
    );
  }

  const startSpinner = ora("Starting local PostgreSQL...").start();
  const start = await runCommand(tools.pgCtl, [
    "-D",
    layout.postgresDataDir,
    "-l",
    layout.postgresLogPath,
    "-o",
    `-p ${DEFAULT_DATABASE_PORT}`,
    "-w",
    "start",
  ], {
    env: postgresEnv,
  });

  if (start.code !== 0) {
    appendRuntimeDebugLog(
      layout,
      `Failed to start PostgreSQL for ${layout.postgresDataDir}. stderr: ${start.stderr || "(empty)"} stdout: ${start.stdout || "(empty)"}`
    );
    startSpinner.fail("Failed to start PostgreSQL");
    throw new Error(start.stderr || start.stdout || "pg_ctl start failed.");
  }

  const ready = await runCommand(tools.pgIsReady, [
    "-h",
    "127.0.0.1",
    "-p",
    `${DEFAULT_DATABASE_PORT}`,
  ], {
    env: postgresEnv,
  });
  if (ready.code !== 0) {
    startSpinner.fail("PostgreSQL did not become ready");
    throw new Error(ready.stderr || ready.stdout || "pg_isready failed.");
  }

  startSpinner.succeed("PostgreSQL is running");
  appendRuntimeDebugLog(
    layout,
    `Started PostgreSQL for ${layout.postgresDataDir} on port ${DEFAULT_DATABASE_PORT}.`
  );
}

async function ensureDatabase(
  layout: RuntimeLayout,
  tools: PostgresTools
): Promise<void> {
  const postgresEnv = withPostgresLocaleEnv();
  const result = await runCommand(
    tools.createdb,
    [
      "-h",
      "127.0.0.1",
      "-p",
      `${DEFAULT_DATABASE_PORT}`,
      "-U",
      resolveDatabaseUser(),
      "gtmship",
    ],
    {
      env: postgresEnv,
      allowedExitCodes: [0, 1],
    }
  );

  if (
    result.code !== 0 &&
    !/already exists/i.test(`${result.stdout}\n${result.stderr}`)
  ) {
    appendRuntimeDebugLog(
      layout,
      `createdb failed for database gtmship on ${layout.databaseUrl}. stderr: ${result.stderr || "(empty)"} stdout: ${result.stdout || "(empty)"}`
    );
    throw new Error(result.stderr || result.stdout || "createdb failed.");
  }

  appendRuntimeDebugLog(layout, `Verified database "gtmship" exists on ${layout.databaseUrl}.`);
}

async function runPrismaMigrations(layout: RuntimeLayout): Promise<void> {
  if (!existsSync(layout.prismaBinary)) {
    throw new Error(
      `Cannot find the Prisma CLI at ${layout.prismaBinary}. Run \`pnpm install\` and rebuild the release bundle.`
    );
  }

  const spinner = ora("Applying auth-service database migrations...").start();
  const result = await runCommand(
    layout.prismaBinary,
    ["migrate", "deploy", "--schema", layout.authServiceSchemaPath],
    {
      cwd: layout.authServiceDir,
      env: {
        ...withRuntimeNodeEnv(),
        DATABASE_URL: layout.databaseUrl,
      },
    }
  );

  if (result.code !== 0) {
    appendRuntimeDebugLog(
      layout,
      `Prisma migrate deploy failed for ${layout.authServiceSchemaPath}. stderr: ${result.stderr || "(empty)"} stdout: ${result.stdout || "(empty)"}`
    );
    spinner.fail("Failed to apply database migrations");
    throw new Error(result.stderr || result.stdout || "prisma migrate deploy failed.");
  }

  spinner.succeed("Auth-service database is up to date");
  appendRuntimeDebugLog(
    layout,
    `Prisma migrations applied successfully for ${layout.authServiceSchemaPath}.`
  );
}

function ensureRuntimePrerequisites(
  layout: RuntimeLayout,
  input: {
    requireDashboard?: boolean;
  } = {}
): void {
  const requireDashboard = input.requireDashboard !== false;
  ensureDir(layout.appSupportDir);
  ensureDir(layout.logsDir);
  ensureDir(layout.runDir);
  ensureDir(layout.projectRoot);

  if (!existsSync(layout.authServiceEntry)) {
    throw new Error(
      `Cannot find the compiled auth service at ${layout.authServiceEntry}. Build the release bundle first.`
    );
  }

  if (requireDashboard && !existsSync(layout.dashboardServerEntry)) {
    throw new Error(
      `Cannot find the built dashboard server at ${layout.dashboardServerEntry}. Build the dashboard bundle first.`
    );
  }
}

async function ensureAuthService(
  layout: RuntimeLayout,
  config: RuntimeConfig
): Promise<"running" | "external"> {
  await stopStaleManagedProcess(layout, pidFile(layout, "auth"), layout.authServiceEntry);
  await stopManagedProcessIfMatching(layout, pidFile(layout, "auth"), layout.authServiceEntry);
  await stopManagedListenerIfPidMatches({
    layout,
    pidPath: pidFile(layout, "auth"),
    port: DEFAULT_AUTH_PORT,
    serviceLabel: "auth service",
  });

  const existing = await assertNoConflictingHealthyService({
    layout,
    port: DEFAULT_AUTH_PORT,
    url: layout.authUrl,
    healthPath: "/health",
    matcher: authServiceReady,
    expectedEntrypoint: layout.authServiceEntry,
    pidPath: pidFile(layout, "auth"),
    serviceLabel: "A GTMShip auth service",
  });
  if (existing) {
    return existing;
  }

  if (await portInUse(DEFAULT_AUTH_PORT)) {
    const command = await resolveConflictingServiceCommand(DEFAULT_AUTH_PORT);
    appendRuntimeDebugLog(
      layout,
      `Port ${DEFAULT_AUTH_PORT} already in use before auth-service start. Listener: ${command || "(unknown)"}`
    );
    throw new Error(
      `Port ${DEFAULT_AUTH_PORT} is already in use by another process. GTMShip needs ${layout.authUrl}.`
    );
  }

  const spinner = ora("Starting GTMShip auth service...").start();
  spawnDetachedProcess({
    command: process.execPath,
    args: [layout.authServiceEntry],
    cwd: layout.authServiceDir,
    env: {
      ...createSharedRuntimeEnv(layout, config),
      PORT: `${DEFAULT_AUTH_PORT}`,
    },
    logPath: layout.authLogPath,
    pidPath: pidFile(layout, "auth"),
  });

  const ready = await waitForHttp(
    `${layout.authUrl}/health`,
    authServiceReady
  );

  if (!ready) {
    appendRuntimeDebugLog(
      layout,
      `Auth service failed readiness checks at ${layout.authUrl}/health.`
    );
    spinner.fail("Auth service failed to become ready");
    throw new Error(
      `Auth service failed to start. See ${layout.authLogPath} for details.`
    );
  }

  spinner.succeed("Auth service is running");
  appendRuntimeDebugLog(
    layout,
    `Started auth service from ${layout.authServiceEntry} with auth URL ${layout.authUrl}.`
  );
  return "running";
}

async function ensureDashboard(
  layout: RuntimeLayout,
  config: RuntimeConfig
): Promise<"running" | "external"> {
  await stopStaleManagedProcess(
    layout,
    pidFile(layout, "dashboard"),
    layout.dashboardServerEntry
  );
  await stopManagedProcessIfMatching(
    layout,
    pidFile(layout, "dashboard"),
    layout.dashboardServerEntry
  );
  await stopManagedListenerIfPidMatches({
    layout,
    pidPath: pidFile(layout, "dashboard"),
    port: DEFAULT_DASHBOARD_PORT,
    serviceLabel: "dashboard",
  });

  const existing = await assertNoConflictingHealthyService({
    layout,
    port: DEFAULT_DASHBOARD_PORT,
    url: layout.dashboardUrl,
    healthPath: "/api/health",
    matcher: (body) => body.includes("\"service\":\"gtmship-dashboard\""),
    expectedEntrypoint: layout.dashboardServerEntry,
    pidPath: pidFile(layout, "dashboard"),
    serviceLabel: "A GTMShip dashboard",
  });
  if (existing) {
    return existing;
  }

  if (await portInUse(DEFAULT_DASHBOARD_PORT)) {
    const command = await resolveConflictingServiceCommand(DEFAULT_DASHBOARD_PORT);
    appendRuntimeDebugLog(
      layout,
      `Port ${DEFAULT_DASHBOARD_PORT} already in use before dashboard start. Listener: ${command || "(unknown)"}`
    );
    throw new Error(
      `Port ${DEFAULT_DASHBOARD_PORT} is already in use by another process. GTMShip needs ${layout.dashboardUrl}.`
    );
  }

  const spinner = ora("Starting GTMShip dashboard...").start();
  spawnDetachedProcess({
    command: process.execPath,
    args: [layout.dashboardServerEntry],
    cwd: layout.dashboardStandaloneDir,
    env: {
      ...createSharedRuntimeEnv(layout, config),
      PORT: `${DEFAULT_DASHBOARD_PORT}`,
      HOSTNAME: "127.0.0.1",
    },
    logPath: layout.dashboardLogPath,
    pidPath: pidFile(layout, "dashboard"),
  });

  const ready = await waitForHttp(
    `${layout.dashboardUrl}/api/health`,
    (body) => body.includes("\"service\":\"gtmship-dashboard\"")
  );

  if (!ready) {
    appendRuntimeDebugLog(
      layout,
      `Dashboard failed readiness checks at ${layout.dashboardUrl}/api/health.`
    );
    spinner.fail("Dashboard failed to become ready");
    throw new Error(
      `Dashboard failed to start. See ${layout.dashboardLogPath} for details.`
    );
  }

  spinner.succeed("Dashboard is running");
  appendRuntimeDebugLog(
    layout,
    `Started dashboard from ${layout.dashboardServerEntry} with dashboard URL ${layout.dashboardUrl}.`
  );
  return "running";
}

async function installLaunchAgent(layout: RuntimeLayout): Promise<void> {
  if (
    layout.backgroundServiceKind !== "launch-agent" ||
    !layout.backgroundServicePath ||
    typeof process.getuid !== "function"
  ) {
    return;
  }

  const pathEntries = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/home/linuxbrew/.linuxbrew/bin",
    process.env.PATH || "",
  ]
    .filter(Boolean)
    .join(path.delimiter);

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.gtmship.runtime</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${layout.cliEntry}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>WorkingDirectory</key>
  <string>${layout.rootDir}</string>
  <key>StandardOutPath</key>
  <string>${layout.dashboardLogPath}</string>
  <key>StandardErrorPath</key>
  <string>${layout.dashboardLogPath}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${pathEntries}</string>
    <key>GTMSHIP_INSTALL_ROOT</key>
    <string>${layout.rootDir}</string>
    ${process.env.GTMSHIP_POSTGRES_BIN
      ? `<key>GTMSHIP_POSTGRES_BIN</key>
    <string>${process.env.GTMSHIP_POSTGRES_BIN}</string>`
      : ""}
  </dict>
</dict>
</plist>
`;

  writeFileSync(layout.backgroundServicePath, plist, "utf8");

  const uid = process.getuid();
  const domain = `gui/${uid}`;

  await runCommand("launchctl", ["bootout", domain, layout.backgroundServicePath]);
  await runCommand("launchctl", ["bootstrap", domain, layout.backgroundServicePath]);
}

async function openDashboard(url: string): Promise<void> {
  const openTarget =
    process.platform === "darwin"
      ? { command: "open", args: [url] }
      : process.platform === "linux"
        ? findExecutable("xdg-open")
          ? { command: findExecutable("xdg-open") as string, args: [url] }
          : findExecutable("gio")
            ? { command: findExecutable("gio") as string, args: ["open", url] }
            : null
        : null;

  if (!openTarget) {
    console.log(chalk.blue(`Open ${url} in your browser.`));
    return;
  }

  const result = await runCommand(openTarget.command, openTarget.args);
  if (result.code !== 0) {
    console.log(chalk.blue(`Open ${url} in your browser.`));
  }
}

function shellQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

async function installSystemdUserService(layout: RuntimeLayout): Promise<void> {
  if (
    layout.backgroundServiceKind !== "systemd-user" ||
    !layout.backgroundServicePath ||
    !layout.backgroundServiceName
  ) {
    return;
  }

  const systemctl = findExecutable("systemctl");
  if (!systemctl) {
    return;
  }

  const pathEntries = [
    "/home/linuxbrew/.linuxbrew/bin",
    "/home/linuxbrew/.linuxbrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    process.env.PATH || "",
  ]
    .filter(Boolean)
    .join(path.delimiter);

  const envLines = [
    `Environment=PATH=${shellQuote(pathEntries)}`,
    `Environment=GTMSHIP_INSTALL_ROOT=${shellQuote(layout.rootDir)}`,
  ];

  if (process.env.GTMSHIP_POSTGRES_BIN) {
    envLines.push(
      `Environment=GTMSHIP_POSTGRES_BIN=${shellQuote(process.env.GTMSHIP_POSTGRES_BIN)}`
    );
  }

  const unit = `[Unit]
Description=GTMShip local runtime bootstrap
After=network.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${shellQuote(layout.rootDir)}
${envLines.join("\n")}
ExecStart=${shellQuote(process.execPath)} ${shellQuote(layout.cliEntry)} start
ExecStop=${shellQuote(process.execPath)} ${shellQuote(layout.cliEntry)} stop

[Install]
WantedBy=default.target
`;

  ensureFileParent(layout.backgroundServicePath);
  writeFileSync(layout.backgroundServicePath, unit, "utf8");

  const reload = await runCommand(systemctl, ["--user", "daemon-reload"]);
  if (reload.code !== 0) {
    throw new Error(reload.stderr || reload.stdout || "systemctl --user daemon-reload failed.");
  }

  const enable = await runCommand(systemctl, [
    "--user",
    "enable",
    "--now",
    layout.backgroundServiceName,
  ]);
  if (enable.code !== 0) {
    throw new Error(enable.stderr || enable.stdout || "systemctl --user enable failed.");
  }
}

async function installBackgroundService(
  layout: RuntimeLayout,
  kind: BackgroundServiceKind
): Promise<void> {
  if (kind === "launch-agent") {
    await installLaunchAgent(layout);
    return;
  }

  if (kind === "systemd-user") {
    await installSystemdUserService(layout);
  }
}

async function stopPidFile(filePath: string): Promise<void> {
  const pid = readPidFile(filePath);
  if (!pid) {
    safeUnlink(filePath);
    return;
  }

  if (!isProcessRunning(pid)) {
    safeUnlink(filePath);
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    safeUnlink(filePath);
    return;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < 7_500) {
    if (!isProcessRunning(pid)) {
      break;
    }
    await sleep(250);
  }

  if (isProcessRunning(pid)) {
    process.kill(pid, "SIGKILL");
  }

  safeUnlink(filePath);
}

async function postgresStatus(
  layout: RuntimeLayout,
  tools: PostgresTools
): Promise<"running" | "stopped"> {
  const result = await runCommand(
    tools.pgCtl,
    ["-D", layout.postgresDataDir, "status"],
    { env: withPostgresLocaleEnv() }
  );
  if (result.code !== 0) {
    return "stopped";
  }

  return (await postgresPortReady(tools)) ? "running" : "stopped";
}

async function authStatus(layout: RuntimeLayout): Promise<{
  state: "running" | "stopped" | "external";
  healthy: boolean;
}> {
  const healthy = await waitForHttp(
    `${layout.authUrl}/health`,
    authServiceReady,
    1_000
  );

  if (!healthy) {
    return {
      state: "stopped",
      healthy: false,
    };
  }

  return {
    state: readPidFile(pidFile(layout, "auth")) ? "running" : "external",
    healthy: true,
  };
}

async function dashboardStatus(layout: RuntimeLayout): Promise<{
  state: "running" | "stopped" | "external";
  healthy: boolean;
}> {
  const healthy = await waitForHttp(
    `${layout.dashboardUrl}/api/health`,
    (body) => body.includes("\"service\":\"gtmship-dashboard\""),
    1_000
  );

  if (!healthy) {
    return {
      state: "stopped",
      healthy: false,
    };
  }

  return {
    state: readPidFile(pidFile(layout, "dashboard")) ? "running" : "external",
    healthy: true,
  };
}

export async function getLocalRuntimeStatus(): Promise<RuntimeStatus> {
  const layout = resolveRuntimeLayout();
  const tools = resolvePostgresTools();
  const auth = await authStatus(layout);
  const dashboard = await dashboardStatus(layout);

  return {
    auth: auth.state,
    dashboard: dashboard.state,
    postgres: await postgresStatus(layout, tools),
    authHealthy: auth.healthy,
    dashboardHealthy: dashboard.healthy,
    authUrl: layout.authUrl,
    dashboardUrl: layout.dashboardUrl,
    projectRoot: layout.projectRoot,
    authLogPath: layout.authLogPath,
    dashboardLogPath: layout.dashboardLogPath,
    postgresLogPath: layout.postgresLogPath,
    runtimeDebugLogPath: layout.runtimeDebugLogPath,
  };
}

export async function startLocalRuntime(input: {
  openBrowser?: boolean;
  installLaunchAgent?: boolean;
  ensureDashboard?: boolean;
} = {}): Promise<RuntimeStatus> {
  const layout = resolveRuntimeLayout();
  const requireDashboard = input.ensureDashboard !== false;
  appendRuntimeDebugLog(
    layout,
    `Starting local runtime. installRoot=${layout.rootDir} projectRoot=${layout.projectRoot} authUrl=${layout.authUrl} dashboardUrl=${layout.dashboardUrl} postgresDir=${layout.postgresDataDir}`
  );

  ensureRuntimePrerequisites(layout, {
    requireDashboard,
  });

  const tools = resolvePostgresTools();
  const config = persistRuntimeConfig(layout, runtimeConfig(layout));

  await ensurePostgresCluster(layout, tools);
  await ensureDatabase(layout, tools);
  await runPrismaMigrations(layout);
  await ensureAuthService(layout, config);
  if (requireDashboard) {
    await ensureDashboard(layout, config);
  }

  if (input.installLaunchAgent && requireDashboard) {
    await installBackgroundService(layout, layout.backgroundServiceKind).catch((error) => {
      console.warn(
        chalk.yellow(
          `Could not install the GTMShip background service: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    });
  }

  if (input.openBrowser && requireDashboard) {
    await openDashboard(layout.dashboardUrl);
  }

  return getLocalRuntimeStatus();
}

export async function stopLocalRuntime(): Promise<RuntimeStatus> {
  const layout = resolveRuntimeLayout();
  const tools = resolvePostgresTools();
  appendRuntimeDebugLog(layout, "Stopping local runtime.");

  await stopPidFile(pidFile(layout, "dashboard"));
  await stopPidFile(pidFile(layout, "auth"));
  await stopHealthyServiceOnPort({
    layout,
    port: DEFAULT_DASHBOARD_PORT,
    url: layout.dashboardUrl,
    healthPath: "/api/health",
    matcher: (body) => body.includes("\"service\":\"gtmship-dashboard\""),
    serviceLabel: "dashboard",
  });
  await stopHealthyServiceOnPort({
    layout,
    port: DEFAULT_AUTH_PORT,
    url: layout.authUrl,
    healthPath: "/health",
    matcher: authServiceReady,
    serviceLabel: "auth service",
  });

  if (existsSync(path.join(layout.postgresDataDir, "PG_VERSION"))) {
    await runCommand(tools.pgCtl, [
      "-D",
      layout.postgresDataDir,
      "-m",
      "fast",
      "stop",
    ], {
      env: withPostgresLocaleEnv(),
    });
  }

  return getLocalRuntimeStatus();
}

export async function restartLocalRuntime(input: {
  openBrowser?: boolean;
  installLaunchAgent?: boolean;
  ensureDashboard?: boolean;
} = {}): Promise<RuntimeStatus> {
  await stopLocalRuntime();
  return startLocalRuntime(input);
}

function describeState(
  label: string,
  state: "running" | "stopped" | "external",
  healthy: boolean
): string {
  const stateText =
    state === "running"
      ? chalk.green("running")
      : state === "external"
        ? chalk.yellow("external")
        : chalk.gray("stopped");
  const healthText = healthy ? chalk.green("healthy") : chalk.gray("not responding");
  return `  ${label}: ${stateText} (${healthText})`;
}

export function printRuntimeStatus(status: RuntimeStatus): void {
  const postgresText =
    status.postgres === "running" ? chalk.green("running") : chalk.gray("stopped");

  console.log("");
  console.log("GTMShip Local Runtime");
  console.log(describeState("Dashboard", status.dashboard, status.dashboardHealthy));
  console.log(describeState("Auth", status.auth, status.authHealthy));
  console.log(`  Postgres: ${postgresText}`);
  console.log("");
  console.log(`  Dashboard URL: ${status.dashboardUrl}`);
  console.log(`  Auth URL:      ${status.authUrl}`);
  console.log(`  Project Root:  ${status.projectRoot}`);
  console.log("");
  console.log(`  Dashboard Log: ${status.dashboardLogPath}`);
  console.log(`  Auth Log:      ${status.authLogPath}`);
  console.log(`  Postgres Log:  ${status.postgresLogPath}`);
  console.log(`  Runtime Debug: ${status.runtimeDebugLogPath}`);
  console.log("");
}
