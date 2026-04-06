import { spawn } from "node:child_process";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import CronParser from "cron-parser";
import { startLocalRuntime } from "./local-runtime.js";
import {
  resolveRuntimeLayout,
  type RuntimeLayout,
} from "./install-layout.js";

const DEFAULT_LOCAL_REGION = "local";
const LOCAL_PROVIDER = "local";
const LOCAL_ENDPOINT_PREFIX = "local://";
const LOCAL_SCHEDULER_TOLERANCE_MS = 5 * 60 * 1000;

export interface LocalWorkflowDeploymentManifest {
  version: 1;
  provider: "local";
  workflowId: string;
  workflowName?: string;
  projectName: string;
  projectRoot: string;
  region: string;
  triggerType: "manual" | "schedule";
  schedule?: {
    cron: string;
    timezone?: string;
    payload?: unknown;
  };
  bundlePath: string;
  runnerPath: string;
  workflowPath: string;
  manifestPath: string;
  statePath: string;
  logPath: string;
  schedulerId?: string;
  deployedAt: string;
}

interface LocalWorkflowDeploymentState {
  version: 1;
  lastScheduledFor?: string;
  lastRunStartedAt?: string;
  lastRunCompletedAt?: string;
  lastRunStatus?: "success" | "failure";
}

interface LocalWorkflowRunInput {
  workflowId: string;
  payload?: unknown;
  triggerSource?: "manual" | "schedule";
  scheduledFor?: string;
}

export interface LocalWorkflowRunResult {
  success: boolean;
  workflowId: string;
  deploymentId?: string | null;
  runId?: string | null;
  executionId?: string | null;
  status: "success" | "failure";
  output?: unknown;
  error?: string;
}

export interface LocalDeployResult {
  provider: "local";
  apiEndpoint: string;
  computeId: string;
  databaseEndpoint: string;
  storageBucket: string;
  schedulerJobId: string;
  rawOutputs: Record<string, string>;
  runtimeTarget: {
    computeType: "job";
    computeName: string;
    endpointUrl: string;
    schedulerJobId?: string;
    region: string;
  };
}

export interface LocalLogEntry {
  timestamp: Date;
  level: "info" | "warn" | "error";
  message: string;
  workflowId?: string;
  executionName?: string;
  requestId?: string;
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function ensureFileParent(filePath: string): void {
  ensureDir(path.dirname(filePath));
}

function shellQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
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

function sanitizeWorkflowId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "") || "workflow";
}

function deploymentDir(layout: RuntimeLayout, workflowId: string): string {
  return path.join(layout.localDeploymentsDir, sanitizeWorkflowId(workflowId));
}

function manifestPath(layout: RuntimeLayout, workflowId: string): string {
  return path.join(deploymentDir(layout, workflowId), "deployment.json");
}

function statePath(layout: RuntimeLayout, workflowId: string): string {
  return path.join(
    layout.localWorkflowStateDir,
    `${sanitizeWorkflowId(workflowId)}.json`
  );
}

function logPath(layout: RuntimeLayout, workflowId: string): string {
  return path.join(
    layout.localWorkflowLogsDir,
    `${sanitizeWorkflowId(workflowId)}.log`
  );
}

function readState(filePath: string): LocalWorkflowDeploymentState {
  return (
    readJson<LocalWorkflowDeploymentState>(filePath) || {
      version: 1,
    }
  );
}

function writeState(filePath: string, value: LocalWorkflowDeploymentState): void {
  writeJson(filePath, value);
}

function resolvePathEntries(): string {
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/home/linuxbrew/.linuxbrew/bin",
    "/home/linuxbrew/.linuxbrew/sbin",
    "/usr/bin",
    process.env.PATH || "",
  ]
    .filter(Boolean)
    .join(path.delimiter);
}

async function runCommand(
  command: string,
  args: string[],
  input: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: input.cwd,
      env: input.env,
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
      resolve({ code: 1, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function installLaunchAgentScheduler(layout: RuntimeLayout): Promise<void> {
  if (
    layout.workflowSchedulerKind !== "launch-agent" ||
    !layout.workflowSchedulerPath ||
    typeof process.getuid !== "function"
  ) {
    return;
  }

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${layout.workflowSchedulerName}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${layout.cliEntry}</string>
    <string>local</string>
    <string>dispatch</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>WorkingDirectory</key>
  <string>${layout.rootDir}</string>
  <key>StandardOutPath</key>
  <string>${layout.localDispatchLogPath}</string>
  <key>StandardErrorPath</key>
  <string>${layout.localDispatchLogPath}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${resolvePathEntries()}</string>
    <key>GTMSHIP_INSTALL_ROOT</key>
    <string>${layout.rootDir}</string>
    <key>GTMSHIP_CLI_ENTRY</key>
    <string>${layout.cliEntry}</string>
  </dict>
</dict>
</plist>
`;

  ensureFileParent(layout.workflowSchedulerPath);
  writeFileSync(layout.workflowSchedulerPath, plist, "utf8");

  const domain = `gui/${process.getuid()}`;
  await runCommand("launchctl", ["bootout", domain, layout.workflowSchedulerPath]);
  const bootstrap = await runCommand("launchctl", [
    "bootstrap",
    domain,
    layout.workflowSchedulerPath,
  ]);

  if (bootstrap.code !== 0) {
    throw new Error(
      bootstrap.stderr || bootstrap.stdout || "launchctl bootstrap failed."
    );
  }
}

async function installSystemdScheduler(layout: RuntimeLayout): Promise<void> {
  if (
    layout.workflowSchedulerKind !== "systemd-user" ||
    !layout.workflowSchedulerPath ||
    !layout.workflowSchedulerName ||
    !layout.workflowSchedulerTimerPath ||
    !layout.workflowSchedulerTimerName
  ) {
    return;
  }

  const service = `[Unit]
Description=GTMShip local workflow dispatcher
After=network.target

[Service]
Type=oneshot
WorkingDirectory=${shellQuote(layout.rootDir)}
Environment=PATH=${shellQuote(resolvePathEntries())}
Environment=GTMSHIP_INSTALL_ROOT=${shellQuote(layout.rootDir)}
Environment=GTMSHIP_CLI_ENTRY=${shellQuote(layout.cliEntry)}
ExecStart=${shellQuote(process.execPath)} ${shellQuote(layout.cliEntry)} local dispatch
StandardOutput=append:${shellQuote(layout.localDispatchLogPath)}
StandardError=append:${shellQuote(layout.localDispatchLogPath)}
`;

  const timer = `[Unit]
Description=Run GTMShip local workflow dispatcher every minute

[Timer]
OnCalendar=*-*-* *:*:00
Persistent=true
Unit=${layout.workflowSchedulerName}

[Install]
WantedBy=timers.target
`;

  ensureFileParent(layout.workflowSchedulerPath);
  ensureFileParent(layout.workflowSchedulerTimerPath);
  writeFileSync(layout.workflowSchedulerPath, service, "utf8");
  writeFileSync(layout.workflowSchedulerTimerPath, timer, "utf8");

  const reload = await runCommand("systemctl", ["--user", "daemon-reload"]);
  if (reload.code !== 0) {
    throw new Error(
      reload.stderr || reload.stdout || "systemctl --user daemon-reload failed."
    );
  }

  const enable = await runCommand("systemctl", [
    "--user",
    "enable",
    "--now",
    layout.workflowSchedulerTimerName,
  ]);
  if (enable.code !== 0) {
    throw new Error(
      enable.stderr ||
        enable.stdout ||
        "systemctl --user enable timer failed."
    );
  }
}

export async function installLocalWorkflowScheduler(): Promise<string> {
  const layout = resolveRuntimeLayout();
  ensureDir(layout.localWorkflowLogsDir);
  ensureDir(layout.localWorkflowStateDir);
  ensureDir(layout.localDeploymentsDir);

  if (layout.workflowSchedulerKind === "launch-agent") {
    await installLaunchAgentScheduler(layout);
    return layout.workflowSchedulerName || "launchd";
  }

  if (layout.workflowSchedulerKind === "systemd-user") {
    await installSystemdScheduler(layout);
    return layout.workflowSchedulerTimerName || layout.workflowSchedulerName || "systemd-user";
  }

  return "manual";
}

function loadManifestByWorkflowId(
  workflowId: string
): LocalWorkflowDeploymentManifest | null {
  const layout = resolveRuntimeLayout();
  return readJson<LocalWorkflowDeploymentManifest>(manifestPath(layout, workflowId));
}

function resolveLocalSchedulerId(layout: RuntimeLayout): string | null {
  return (
    layout.workflowSchedulerTimerName ||
    layout.workflowSchedulerName ||
    null
  );
}

export function listLocalDeploymentManifests(): LocalWorkflowDeploymentManifest[] {
  const layout = resolveRuntimeLayout();
  if (!existsSync(layout.localDeploymentsDir)) {
    return [];
  }

  const manifests: LocalWorkflowDeploymentManifest[] = [];
  const deploymentIds = readdirSync(layout.localDeploymentsDir, {
    withFileTypes: true,
  });

  for (const entry of deploymentIds) {
    if (!entry.isDirectory()) {
      continue;
    }

    const manifest = readJson<LocalWorkflowDeploymentManifest>(
      path.join(layout.localDeploymentsDir, entry.name, "deployment.json")
    );
    if (manifest) {
      manifests.push(manifest);
    }
  }

  return manifests.sort((left, right) => left.workflowId.localeCompare(right.workflowId));
}

function listDeploymentManifests(): LocalWorkflowDeploymentManifest[] {
  return listLocalDeploymentManifests();
}

export function buildLocalDeploymentSyncRecord(
  manifest: LocalWorkflowDeploymentManifest
): Record<string, unknown> {
  const layout = resolveRuntimeLayout();
  const schedulerId = manifest.schedulerId || resolveLocalSchedulerId(layout);
  const triggerConfig =
    manifest.triggerType === "schedule"
      ? {
          type: "schedule",
          description: `Runs on schedule ${manifest.schedule?.cron || "unknown"}.`,
          cron: manifest.schedule?.cron,
          timezone: manifest.schedule?.timezone,
          payload: manifest.schedule?.payload,
        }
      : {
          type: "manual",
          description: "Manual run from GTMShip.",
        };

  return {
    workflowId: manifest.workflowId,
    provider: LOCAL_PROVIDER,
    region: manifest.region || DEFAULT_LOCAL_REGION,
    executionKind: "job",
    endpointUrl: `${LOCAL_ENDPOINT_PREFIX}${manifest.workflowId}`,
    schedulerId,
    authMode: "proxy",
    triggerType: manifest.triggerType,
    triggerConfig,
    resourceInventory: {
      trigger: triggerConfig,
      runtimeTarget: {
        computeType: "job",
        computeName: manifest.workflowId,
        endpointUrl: `${LOCAL_ENDPOINT_PREFIX}${manifest.workflowId}`,
        schedulerId,
        region: manifest.region || DEFAULT_LOCAL_REGION,
        logPath: manifest.logPath,
      },
      platformOutputs: {
        localManifestPath: manifest.manifestPath,
        localBundlePath: manifest.bundlePath,
        localLogPath: manifest.logPath,
        localStatePath: manifest.statePath,
        localSchedulerId: schedulerId || "",
        projectRoot: manifest.projectRoot,
        projectName: manifest.projectName,
        workflowName: manifest.workflowName || "",
      },
    },
    status: "active",
    deployedAt: manifest.deployedAt,
  };
}

async function resolveDeploymentId(
  workflowId: string,
  authUrl: string
): Promise<string | null> {
  try {
    const response = await fetch(
      `${authUrl}/workflow-control-plane/deployments?workflowId=${encodeURIComponent(
        workflowId
      )}&provider=${LOCAL_PROVIDER}`
    );
    if (!response.ok) {
      return null;
    }

    const deployments = (await response.json()) as Array<{ id?: string }> | null;
    return Array.isArray(deployments) && typeof deployments[0]?.id === "string"
      ? deployments[0].id
      : null;
  } catch {
    return null;
  }
}

async function ensureLocalDeploymentSynced(
  manifest: LocalWorkflowDeploymentManifest,
  authUrl: string
): Promise<string | null> {
  try {
    const response = await fetch(
      `${authUrl}/workflow-control-plane/deployments/sync`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deployments: [buildLocalDeploymentSyncRecord(manifest)],
        }),
      }
    );
    if (!response.ok) {
      return null;
    }
  } catch {
    return null;
  }

  return resolveDeploymentId(manifest.workflowId, authUrl);
}

async function createRunRecord(input: {
  authUrl: string;
  deploymentId: string | null;
  executionId: string;
  triggerSource: string;
  payload: unknown;
}): Promise<string | null> {
  if (!input.deploymentId) {
    return null;
  }

  try {
    const response = await fetch(`${input.authUrl}/workflow-control-plane/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deploymentId: input.deploymentId,
        executionId: input.executionId,
        triggerSource: input.triggerSource,
        status: "running",
        cloudRef: `local:${input.executionId}`,
        startedAt: new Date().toISOString(),
        requestPayload: input.payload,
      }),
    });
    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as { id?: string } | null;
    return typeof payload?.id === "string" ? payload.id : null;
  } catch {
    return null;
  }
}

async function updateRunRecord(input: {
  authUrl: string;
  runId: string | null;
  status: "success" | "failure";
  responsePayload?: unknown;
  error?: unknown;
}): Promise<void> {
  if (!input.runId) {
    return;
  }

  try {
    await fetch(`${input.authUrl}/workflow-control-plane/runs/${input.runId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: input.status,
        endedAt: new Date().toISOString(),
        responsePayload: input.responsePayload,
        error: input.error,
      }),
    });
  } catch {
    // Ignore control-plane update failures for local runs.
  }
}

function appendLocalLog(
  filePath: string,
  input: {
    level: "info" | "warn" | "error";
    message: string;
    workflowId: string;
    executionName?: string;
    requestId?: string;
  }
): void {
  ensureFileParent(filePath);
  const line = {
    timestamp: new Date().toISOString(),
    level: input.level,
    message: input.message,
    workflowId: input.workflowId,
    executionName: input.executionName,
    requestId: input.requestId,
  };

  const fd = openSync(filePath, "a");
  try {
    writeFileSync(fd, `${JSON.stringify(line)}\n`, "utf8");
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Ignore close failures.
    }
  }
}

function parseLocalLogEntries(
  filePath: string,
  input: {
    startTime?: Date;
    limit?: number;
    workflowId?: string;
  } = {}
): LocalLogEntry[] {
  if (!existsSync(filePath)) {
    return [];
  }

  const raw = readFileSync(filePath, "utf8");
  const entries = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const record = JSON.parse(line) as {
          timestamp?: string;
          level?: string;
          message?: string;
          workflowId?: string;
          executionName?: string;
          requestId?: string;
        };
        if (
          typeof record.timestamp !== "string" ||
          typeof record.message !== "string"
        ) {
          return [];
        }

        const timestamp = new Date(record.timestamp);
        if (Number.isNaN(timestamp.getTime())) {
          return [];
        }
        if (input.startTime && timestamp.getTime() < input.startTime.getTime()) {
          return [];
        }
        if (input.workflowId && record.workflowId !== input.workflowId) {
          return [];
        }

        return [
          {
            timestamp,
            level:
              record.level === "warn" || record.level === "error"
                ? record.level
                : "info",
            message: record.message,
            workflowId: record.workflowId,
            executionName: record.executionName,
            requestId: record.requestId,
          } satisfies LocalLogEntry,
        ];
      } catch {
        return [];
      }
    });

  const limit = input.limit ?? 100;
  return entries.length > limit ? entries.slice(entries.length - limit) : entries;
}

function scheduleDueAt(
  manifest: LocalWorkflowDeploymentManifest,
  state: LocalWorkflowDeploymentState,
  now: Date
): string | null {
  if (manifest.triggerType !== "schedule" || !manifest.schedule?.cron) {
    return null;
  }

  try {
    const interval = CronParser.parseExpression(manifest.schedule.cron, {
      currentDate: now,
      tz: manifest.schedule.timezone,
    });
    const previous = interval.prev().toDate();
    const scheduledIso = previous.toISOString();
    if (state.lastScheduledFor === scheduledIso) {
      return null;
    }
    if (now.getTime() - previous.getTime() > LOCAL_SCHEDULER_TOLERANCE_MS) {
      return null;
    }
    return scheduledIso;
  } catch {
    return null;
  }
}

export async function deployLocalWorkflow(input: {
  workflowId: string;
  workflowName?: string;
  projectName: string;
  bundleSourcePath: string;
  triggerType: "manual" | "schedule";
  scheduleCron?: string;
  scheduleTimezone?: string;
  schedulePayload?: unknown;
}): Promise<LocalDeployResult> {
  const layout = resolveRuntimeLayout();
  await startLocalRuntime({ ensureDashboard: false });
  const schedulerId = await installLocalWorkflowScheduler();

  const installDir = deploymentDir(layout, input.workflowId);
  const bundlePath = path.join(installDir, "bundle");
  const nextManifestPath = manifestPath(layout, input.workflowId);
  const nextStatePath = statePath(layout, input.workflowId);
  const nextLogPath = logPath(layout, input.workflowId);

  rmSync(bundlePath, { recursive: true, force: true });
  ensureDir(installDir);
  ensureDir(layout.localWorkflowStateDir);
  ensureDir(layout.localWorkflowLogsDir);
  cpSync(input.bundleSourcePath, bundlePath, { recursive: true });

  const manifest: LocalWorkflowDeploymentManifest = {
    version: 1,
    provider: "local",
    workflowId: input.workflowId,
    workflowName: input.workflowName,
    projectName: input.projectName,
    projectRoot: process.cwd(),
    region: DEFAULT_LOCAL_REGION,
    triggerType: input.triggerType,
    schedule:
      input.triggerType === "schedule" && input.scheduleCron
        ? {
            cron: input.scheduleCron,
            timezone: input.scheduleTimezone,
            payload: input.schedulePayload,
          }
        : undefined,
    bundlePath,
    runnerPath: path.join(bundlePath, "runner.js"),
    workflowPath: path.join(bundlePath, "workflow.js"),
    manifestPath: nextManifestPath,
    statePath: nextStatePath,
    logPath: nextLogPath,
    schedulerId,
    deployedAt: new Date().toISOString(),
  };

  writeJson(nextManifestPath, manifest);
  if (!existsSync(nextStatePath)) {
    writeState(nextStatePath, { version: 1 });
  }

  return {
    provider: "local",
    apiEndpoint: `${LOCAL_ENDPOINT_PREFIX}${input.workflowId}`,
    computeId: `local:${input.workflowId}`,
    databaseEndpoint: layout.databaseUrl,
    storageBucket: bundlePath,
    schedulerJobId: schedulerId,
    runtimeTarget: {
      computeType: "job",
      computeName: input.workflowId,
      endpointUrl: `${LOCAL_ENDPOINT_PREFIX}${input.workflowId}`,
      schedulerJobId: schedulerId,
      region: DEFAULT_LOCAL_REGION,
    },
    rawOutputs: {
      localManifestPath: nextManifestPath,
      localBundlePath: bundlePath,
      localLogPath: nextLogPath,
      localStatePath: nextStatePath,
      localSchedulerId: schedulerId,
    },
  };
}

export async function runLocalWorkflow(
  input: LocalWorkflowRunInput
): Promise<LocalWorkflowRunResult> {
  await startLocalRuntime({ ensureDashboard: false });
  const manifest = loadManifestByWorkflowId(input.workflowId);
  if (!manifest) {
    throw new Error(`No local deployment found for workflow ${input.workflowId}.`);
  }

  if (!existsSync(manifest.runnerPath) || !existsSync(manifest.workflowPath)) {
    throw new Error(
      `Local deployment for ${input.workflowId} is incomplete. Re-run deploy first.`
    );
  }

  const executionId = `local_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const authUrl = resolveRuntimeLayout().authUrl;
  let deploymentId = await resolveDeploymentId(manifest.workflowId, authUrl);
  if (!deploymentId) {
    deploymentId = await ensureLocalDeploymentSynced(manifest, authUrl);
  }
  const payload =
    input.payload !== undefined
      ? input.payload
      : input.triggerSource === "schedule"
        ? manifest.schedule?.payload || {}
        : {};
  const runId = await createRunRecord({
    authUrl,
    deploymentId,
    executionId,
    triggerSource: input.triggerSource || "manual",
    payload,
  });

  const resultDir = mkdtempSync(path.join(os.tmpdir(), "gtmship-local-run-"));
  const resultPath = path.join(resultDir, "result.json");
  const state = readState(manifest.statePath);
  state.lastRunStartedAt = new Date().toISOString();
  if (input.scheduledFor) {
    state.lastScheduledFor = input.scheduledFor;
  }
  writeState(manifest.statePath, state);

  appendLocalLog(manifest.logPath, {
    level: "info",
    workflowId: manifest.workflowId,
    executionName: executionId,
    requestId: executionId,
    message: `Starting local workflow run (${input.triggerSource || "manual"})`,
  });

  const child = spawn(process.execPath, [manifest.runnerPath], {
    cwd: manifest.bundlePath,
    env: {
      ...process.env,
      GTMSHIP_RUNTIME_MODE: "local-job",
      GTMSHIP_WORKFLOW_ID: manifest.workflowId,
      GTMSHIP_EXECUTION_ID: executionId,
      GTMSHIP_AUTH_URL: authUrl,
      GTMSHIP_RUNTIME_AUTH_MODE: "proxy",
      GTMSHIP_WORKFLOW_PATH: manifest.workflowPath,
      GTMSHIP_JOB_PAYLOAD: JSON.stringify(payload),
      GTMSHIP_RESULT_PATH: resultPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdoutBuffer = "";
  let stderrBuffer = "";

  const flushLines = (
    buffer: string,
    level: "info" | "error"
  ): { rest: string } => {
    const lines = buffer.split(/\r?\n/);
    const rest = lines.pop() || "";
    for (const line of lines.map((entry) => entry.trim()).filter(Boolean)) {
      appendLocalLog(manifest.logPath, {
        level,
        workflowId: manifest.workflowId,
        executionName: executionId,
        requestId: executionId,
        message: line,
      });
    }
    return { rest };
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString();
    stdoutBuffer = flushLines(stdoutBuffer, "info").rest;
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBuffer += chunk.toString();
    stderrBuffer = flushLines(stderrBuffer, "error").rest;
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });

  if (stdoutBuffer.trim()) {
    appendLocalLog(manifest.logPath, {
      level: "info",
      workflowId: manifest.workflowId,
      executionName: executionId,
      requestId: executionId,
      message: stdoutBuffer.trim(),
    });
  }
  if (stderrBuffer.trim()) {
    appendLocalLog(manifest.logPath, {
      level: "error",
      workflowId: manifest.workflowId,
      executionName: executionId,
      requestId: executionId,
      message: stderrBuffer.trim(),
    });
  }

  const result = readJson<{ success?: boolean; data?: unknown; error?: string }>(
    resultPath
  );
  rmSync(resultDir, { recursive: true, force: true });

  const nextState = readState(manifest.statePath);
  nextState.lastRunCompletedAt = new Date().toISOString();
  nextState.lastRunStatus =
    exitCode === 0 && result?.success !== false ? "success" : "failure";
  writeState(manifest.statePath, nextState);

  if (exitCode === 0 && result?.success !== false) {
    appendLocalLog(manifest.logPath, {
      level: "info",
      workflowId: manifest.workflowId,
      executionName: executionId,
      requestId: executionId,
      message: "Local workflow run completed successfully.",
    });
    await updateRunRecord({
      authUrl,
      runId,
      status: "success",
      responsePayload: result?.data,
    });
    return {
      success: true,
      workflowId: manifest.workflowId,
      deploymentId,
      runId,
      executionId,
      status: "success",
      output: result?.data,
    };
  }

  const errorMessage = result?.error || `Workflow exited with code ${exitCode}.`;
  appendLocalLog(manifest.logPath, {
    level: "error",
    workflowId: manifest.workflowId,
    executionName: executionId,
    requestId: executionId,
    message: `Local workflow run failed: ${errorMessage}`,
  });
  await updateRunRecord({
    authUrl,
    runId,
    status: "failure",
    error: { message: errorMessage },
  });
  return {
    success: false,
    workflowId: manifest.workflowId,
    deploymentId,
    runId,
    executionId,
    status: "failure",
    error: errorMessage,
  };
}

export async function dispatchLocalWorkflows(): Promise<{
  checked: number;
  dispatched: number;
}> {
  const manifests = listDeploymentManifests();
  if (manifests.length > 0) {
    await startLocalRuntime({ ensureDashboard: false });
  }
  let dispatched = 0;
  const now = new Date();

  for (const manifest of manifests) {
    if (manifest.triggerType !== "schedule") {
      continue;
    }

    const state = readState(manifest.statePath);
    const scheduledFor = scheduleDueAt(manifest, state, now);
    if (!scheduledFor) {
      continue;
    }

    const result = await runLocalWorkflow({
      workflowId: manifest.workflowId,
      triggerSource: "schedule",
      scheduledFor,
      payload: manifest.schedule?.payload,
    });
    if (result.success) {
      dispatched++;
    }
  }

  return {
    checked: manifests.length,
    dispatched,
  };
}

export function listLocalLogEntries(input: {
  workflowId?: string;
  startTime?: Date;
  limit?: number;
}): LocalLogEntry[] {
  const manifests = input.workflowId
    ? [loadManifestByWorkflowId(input.workflowId)].filter(Boolean)
    : listDeploymentManifests();

  const entries = manifests.flatMap((manifest) =>
    manifest
      ? parseLocalLogEntries(manifest.logPath, {
          startTime: input.startTime,
          limit: input.limit,
          workflowId: manifest.workflowId,
        })
      : []
  );

  const sorted = entries.sort(
    (left, right) => left.timestamp.getTime() - right.timestamp.getTime()
  );
  const limit = input.limit ?? 100;
  return sorted.length > limit ? sorted.slice(sorted.length - limit) : sorted;
}
