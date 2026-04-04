import { prisma } from "./db.js";
import {
  loadConfiguredSecretBackendTargets,
  markConnectionSecretReplicasPendingById,
  syncConnectionSecretReplicasById,
  type ConnectionSecretReplicaRow,
  type SecretBackendTarget,
} from "./connection-secret-replicas.js";

export type ConnectionAuthMode = "proxy" | "secret_manager";
export type ConnectionAuthStrategyHealth = "healthy" | "degraded" | "migrating";

export interface ConnectionAuthReplicaSummary {
  activeConnections: number;
  expectedReplicas: number;
  active: number;
  pending: number;
  error: number;
  missing: number;
}

export interface ConnectionAuthStrategyStatus {
  mode: ConnectionAuthMode;
  status: ConnectionAuthStrategyHealth;
  configuredBackends: SecretBackendTarget[];
  replicaSummary: ConnectionAuthReplicaSummary;
}

export const CONNECTION_AUTH_MODE_SETTING_KEY = "connection_auth_mode";

export function normalizeConnectionAuthMode(
  value: unknown
): ConnectionAuthMode {
  return value === "secret_manager" ? "secret_manager" : "proxy";
}

async function readConnectionAuthModeSetting(): Promise<string | null> {
  const setting = await prisma.setting.findUnique({
    where: { key: CONNECTION_AUTH_MODE_SETTING_KEY },
    select: { value: true },
  });

  return setting?.value || null;
}

export async function getConnectionAuthMode(): Promise<ConnectionAuthMode> {
  return normalizeConnectionAuthMode(await readConnectionAuthModeSetting());
}

export async function setConnectionAuthMode(
  mode: ConnectionAuthMode
): Promise<void> {
  await prisma.setting.upsert({
    where: { key: CONNECTION_AUTH_MODE_SETTING_KEY },
    update: { value: mode },
    create: { key: CONNECTION_AUTH_MODE_SETTING_KEY, value: mode },
  });
}

export async function validateSecretManagerReadiness(): Promise<SecretBackendTarget[]> {
  const targets = await loadConfiguredSecretBackendTargets();
  if (targets.length === 0) {
    throw new Error(
      "Secret manager mode requires at least one configured secret backend. Add AWS or GCP credentials in Settings first."
    );
  }

  return targets;
}

function classifyAuthStrategyHealth(
  mode: ConnectionAuthMode,
  configuredBackends: SecretBackendTarget[],
  replicaSummary: ConnectionAuthReplicaSummary
): ConnectionAuthStrategyHealth {
  if (mode !== "secret_manager") {
    return "healthy";
  }

  if (configuredBackends.length === 0) {
    return "degraded";
  }

  if (replicaSummary.error > 0 || replicaSummary.missing > 0) {
    return "degraded";
  }

  if (replicaSummary.pending > 0) {
    return "migrating";
  }

  return "healthy";
}

export async function getConnectionAuthStrategyStatus(): Promise<ConnectionAuthStrategyStatus> {
  const [mode, configuredBackends, activeConnections, replicas] = await Promise.all([
    getConnectionAuthMode(),
    loadConfiguredSecretBackendTargets(),
    prisma.connection.findMany({
      where: { status: "active" },
      select: { id: true },
    }),
    prisma.connectionSecretReplica.findMany({
      select: {
        connectionId: true,
        backendKind: true,
        backendRegion: true,
        backendProjectId: true,
        status: true,
      },
    }),
  ]);

  const activeConnectionIds = new Set(activeConnections.map((connection) => connection.id));
  const activeReplicaRows = replicas.filter((replica) =>
    activeConnectionIds.has(replica.connectionId)
  );

  const replicaLookup = new Map<string, string>();
  for (const replica of activeReplicaRows) {
    replicaLookup.set(
      [
        replica.connectionId,
        replica.backendKind,
        replica.backendRegion || "",
        replica.backendProjectId || "",
      ].join("|"),
      replica.status
    );
  }

  const replicaSummary: ConnectionAuthReplicaSummary = {
    activeConnections: activeConnections.length,
    expectedReplicas: activeConnections.length * configuredBackends.length,
    active: 0,
    pending: 0,
    error: 0,
    missing: 0,
  };

  for (const connection of activeConnections) {
    for (const backend of configuredBackends) {
      const status = replicaLookup.get(
        [
          connection.id,
          backend.kind,
          backend.region || "",
          backend.projectId || "",
        ].join("|")
      );

      if (!status) {
        replicaSummary.missing += 1;
        continue;
      }

      if (status === "active") {
        replicaSummary.active += 1;
      } else if (status === "pending") {
        replicaSummary.pending += 1;
      } else {
        replicaSummary.error += 1;
      }
    }
  }

  return {
    mode,
    status: classifyAuthStrategyHealth(mode, configuredBackends, replicaSummary),
    configuredBackends,
    replicaSummary,
  };
}

function logScheduledSyncError(connectionId: string, error: unknown): void {
  console.warn(
    `[auth-strategy] Failed to sync secret replicas for ${connectionId}: ${
      error instanceof Error ? error.message : "Unknown error"
    }`
  );
}

export async function scheduleConnectionSecretSync(
  connectionId: string,
  explicitTarget?: SecretBackendTarget
): Promise<ConnectionSecretReplicaRow[]> {
  const mode = await getConnectionAuthMode();
  if (mode !== "secret_manager") {
    return [];
  }

  const pending = await markConnectionSecretReplicasPendingById(
    connectionId,
    explicitTarget
  );

  if (pending.length === 0) {
    return [];
  }

  setTimeout(() => {
    void syncConnectionSecretReplicasById(connectionId, explicitTarget).catch(
      (error) => logScheduledSyncError(connectionId, error)
    );
  }, 0);

  return pending;
}

export async function syncAllActiveConnectionsToSecretManagers(): Promise<{
  activeConnections: number;
  syncedReplicas: number;
  errorReplicas: number;
}> {
  const mode = await getConnectionAuthMode();
  if (mode !== "secret_manager") {
    return {
      activeConnections: 0,
      syncedReplicas: 0,
      errorReplicas: 0,
    };
  }

  await validateSecretManagerReadiness();

  const activeConnections = await prisma.connection.findMany({
    where: { status: "active" },
    select: { id: true },
  });

  let syncedReplicas = 0;
  let errorReplicas = 0;

  for (const connection of activeConnections) {
    const replicas = await syncConnectionSecretReplicasById(connection.id);
    syncedReplicas += replicas.filter((replica) => replica.status === "active").length;
    errorReplicas += replicas.filter((replica) => replica.status === "error").length;
  }

  return {
    activeConnections: activeConnections.length,
    syncedReplicas,
    errorReplicas,
  };
}
