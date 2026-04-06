import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_DASHBOARD_PORT = 3000;
export const DEFAULT_AUTH_PORT = 4000;
export const DEFAULT_DATABASE_PORT = 15433;
export const DEFAULT_DASHBOARD_URL = `http://localhost:${DEFAULT_DASHBOARD_PORT}`;
export const DEFAULT_AUTH_URL = `http://localhost:${DEFAULT_AUTH_PORT}`;

function resolveLocalDatabaseUser(): string {
  const hintedUser = process.env.GTMSHIP_DATABASE_USER?.trim();
  if (hintedUser) {
    return hintedUser;
  }

  try {
    const username = os.userInfo().username.trim();
    if (username) {
      return username;
    }
  } catch {
    // Fall through to environment/default fallback below.
  }

  return process.env.USER?.trim() || "postgres";
}

export const DEFAULT_DATABASE_URL = `postgresql://${encodeURIComponent(
  resolveLocalDatabaseUser()
)}@127.0.0.1:${DEFAULT_DATABASE_PORT}/gtmship`;

export interface RuntimeLayout {
  rootDir: string;
  cliEntry: string;
  authServiceDir: string;
  authServiceEntry: string;
  authServiceSchemaPath: string;
  dashboardDir: string;
  dashboardServerEntry: string;
  dashboardStandaloneDir: string;
  dashboardStaticDir: string;
  prismaBinary: string;
  appSupportDir: string;
  stateDir: string;
  logsDir: string;
  runDir: string;
  postgresDir: string;
  postgresDataDir: string;
  postgresLogPath: string;
  authLogPath: string;
  dashboardLogPath: string;
  localDispatchLogPath: string;
  runtimeConfigPath: string;
  backgroundServiceKind: "launch-agent" | "systemd-user" | "none";
  backgroundServiceName: string | null;
  backgroundServicePath: string | null;
  workflowSchedulerKind: "launch-agent" | "systemd-user" | "none";
  workflowSchedulerName: string | null;
  workflowSchedulerPath: string | null;
  workflowSchedulerTimerName: string | null;
  workflowSchedulerTimerPath: string | null;
  localDeploymentsDir: string;
  localWorkflowStateDir: string;
  localWorkflowLogsDir: string;
  projectRoot: string;
  authUrl: string;
  dashboardUrl: string;
  databaseUrl: string;
}

function currentCliDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function candidateRootDirs(): string[] {
  const override = process.env.GTMSHIP_INSTALL_ROOT?.trim();
  const candidates = [
    override ? path.resolve(override) : null,
    path.resolve(currentCliDir(), "../../../.."),
    path.resolve(currentCliDir(), "../../../../.."),
  ].filter((value): value is string => Boolean(value));

  return Array.from(new Set(candidates));
}

function looksLikeRuntimeRoot(dir: string): boolean {
  return existsSync(path.join(dir, "packages", "cli"));
}

function resolveRuntimeRoot(): string {
  for (const candidate of candidateRootDirs()) {
    if (looksLikeRuntimeRoot(candidate)) {
      return candidate;
    }
  }

  return candidateRootDirs()[0] || process.cwd();
}

function resolveDashboardServerEntry(rootDir: string): {
  serverEntry: string;
  standaloneDir: string;
} {
  const candidates = [
    {
      serverEntry: path.join(
        rootDir,
        "packages",
        "dashboard",
        ".next",
        "standalone",
        "packages",
        "dashboard",
        "server.js"
      ),
      standaloneDir: path.join(
        rootDir,
        "packages",
        "dashboard",
        ".next",
        "standalone"
      ),
    },
    {
      serverEntry: path.join(
        rootDir,
        "packages",
        "dashboard",
        ".next",
        "standalone",
        "server.js"
      ),
      standaloneDir: path.join(
        rootDir,
        "packages",
        "dashboard",
        ".next",
        "standalone"
      ),
    },
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate.serverEntry)) {
      return candidate;
    }
  }

  return candidates[0];
}

function resolvePrismaBinary(rootDir: string): string {
  const candidates = [
    path.join(rootDir, "node_modules", ".bin", "prisma"),
    path.join(rootDir, "packages", "auth-service", "node_modules", ".bin", "prisma"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

function resolveDataDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "GTMShip");
  }

  return path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
    "GTMShip"
  );
}

function resolveStateDir(appSupportDir: string): string {
  if (process.platform === "darwin") {
    return appSupportDir;
  }

  return path.join(
    process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
    "GTMShip"
  );
}

function resolveBackgroundService(): Pick<
  RuntimeLayout,
  "backgroundServiceKind" | "backgroundServiceName" | "backgroundServicePath"
> {
  if (process.platform === "darwin") {
    return {
      backgroundServiceKind: "launch-agent",
      backgroundServiceName: "com.gtmship.runtime",
      backgroundServicePath: path.join(
        os.homedir(),
        "Library",
        "LaunchAgents",
        "com.gtmship.runtime.plist"
      ),
    };
  }

  if (process.platform === "linux") {
    return {
      backgroundServiceKind: "systemd-user",
      backgroundServiceName: "gtmship-runtime.service",
      backgroundServicePath: path.join(
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
        "systemd",
        "user",
        "gtmship-runtime.service"
      ),
    };
  }

  return {
    backgroundServiceKind: "none",
    backgroundServiceName: null,
    backgroundServicePath: null,
  };
}

function resolveWorkflowScheduler(): Pick<
  RuntimeLayout,
  | "workflowSchedulerKind"
  | "workflowSchedulerName"
  | "workflowSchedulerPath"
  | "workflowSchedulerTimerName"
  | "workflowSchedulerTimerPath"
> {
  if (process.platform === "darwin") {
    return {
      workflowSchedulerKind: "launch-agent",
      workflowSchedulerName: "com.gtmship.workflow-dispatch",
      workflowSchedulerPath: path.join(
        os.homedir(),
        "Library",
        "LaunchAgents",
        "com.gtmship.workflow-dispatch.plist"
      ),
      workflowSchedulerTimerName: null,
      workflowSchedulerTimerPath: null,
    };
  }

  if (process.platform === "linux") {
    const systemdUserDir = path.join(
      process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
      "systemd",
      "user"
    );

    return {
      workflowSchedulerKind: "systemd-user",
      workflowSchedulerName: "gtmship-workflow-dispatch.service",
      workflowSchedulerPath: path.join(
        systemdUserDir,
        "gtmship-workflow-dispatch.service"
      ),
      workflowSchedulerTimerName: "gtmship-workflow-dispatch.timer",
      workflowSchedulerTimerPath: path.join(
        systemdUserDir,
        "gtmship-workflow-dispatch.timer"
      ),
    };
  }

  return {
    workflowSchedulerKind: "none",
    workflowSchedulerName: null,
    workflowSchedulerPath: null,
    workflowSchedulerTimerName: null,
    workflowSchedulerTimerPath: null,
  };
}

export function resolveRuntimeLayout(): RuntimeLayout {
  const rootDir = resolveRuntimeRoot();
  const cliEntry = path.join(rootDir, "packages", "cli", "dist", "index.js");
  const authServiceDir = path.join(rootDir, "packages", "auth-service");
  const dashboardDir = path.join(rootDir, "packages", "dashboard");
  const appSupportDir = resolveDataDir();
  const stateDir = resolveStateDir(appSupportDir);
  const logsDir = path.join(stateDir, "logs");
  const runDir = path.join(stateDir, "run");
  const postgresDir = path.join(appSupportDir, "postgres");
  const projectRoot = path.join(os.homedir(), ".gtmship", "projects", "default");
  const { serverEntry, standaloneDir } = resolveDashboardServerEntry(rootDir);
  const backgroundService = resolveBackgroundService();
  const workflowScheduler = resolveWorkflowScheduler();

  return {
    rootDir,
    cliEntry,
    authServiceDir,
    authServiceEntry: path.join(authServiceDir, "dist", "server.js"),
    authServiceSchemaPath: path.join(
      authServiceDir,
      "src",
      "prisma",
      "schema.prisma"
    ),
    dashboardDir,
    dashboardServerEntry: serverEntry,
    dashboardStandaloneDir: standaloneDir,
    dashboardStaticDir: path.join(dashboardDir, ".next", "static"),
    prismaBinary: resolvePrismaBinary(rootDir),
    appSupportDir,
    stateDir,
    logsDir,
    runDir,
    postgresDir,
    postgresDataDir: path.join(postgresDir, "data"),
    postgresLogPath: path.join(logsDir, "postgres.log"),
    authLogPath: path.join(logsDir, "auth-service.log"),
    dashboardLogPath: path.join(logsDir, "dashboard.log"),
    localDispatchLogPath: path.join(logsDir, "workflow-dispatch.log"),
    runtimeConfigPath: path.join(appSupportDir, "runtime.json"),
    ...backgroundService,
    ...workflowScheduler,
    localDeploymentsDir: path.join(appSupportDir, "workflow-deployments"),
    localWorkflowStateDir: path.join(stateDir, "workflow-deployments"),
    localWorkflowLogsDir: path.join(logsDir, "workflows"),
    projectRoot,
    authUrl: DEFAULT_AUTH_URL,
    dashboardUrl: DEFAULT_DASHBOARD_URL,
    databaseUrl: DEFAULT_DATABASE_URL,
  };
}
