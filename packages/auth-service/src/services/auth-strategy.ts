import { prisma } from "./db.js";
import {
  loadConfiguredSecretBackendTargets,
  markConnectionSecretReplicasPendingById,
  normalizeSecretBackendKind,
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
const DEFAULT_SECRET_REPLICA_RECONCILE_INTERVAL_MS = 30_000;
const DEFAULT_SECRET_REPLICA_RECONCILE_BATCH_SIZE = 100;
const ALL_SECRET_SYNC_TARGET_KEY = "*";

export const connectionSecretSyncRuntime = {
  markConnectionSecretReplicasPendingById,
  syncConnectionSecretReplicasById,
};

let reconcileIntervalHandle: ReturnType<typeof setInterval> | null = null;
let reconcileRunInFlight = false;
const queuedConnectionSecretSyncKeys = new Set<string>();

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

function buildSecretSyncTargetKey(explicitTarget?: SecretBackendTarget): string {
  if (!explicitTarget) {
    return ALL_SECRET_SYNC_TARGET_KEY;
  }

  return [
    explicitTarget.kind,
    explicitTarget.region || "",
    explicitTarget.projectId || "",
  ].join("|");
}

function buildConnectionSecretSyncKey(
  connectionId: string,
  explicitTarget?: SecretBackendTarget
): string {
  return `${connectionId}|${buildSecretSyncTargetKey(explicitTarget)}`;
}

function hasQueuedConnectionSecretSync(
  connectionId: string,
  explicitTarget?: SecretBackendTarget
): boolean {
  const allKey = buildConnectionSecretSyncKey(connectionId);
  if (queuedConnectionSecretSyncKeys.has(allKey)) {
    return true;
  }

  return queuedConnectionSecretSyncKeys.has(
    buildConnectionSecretSyncKey(connectionId, explicitTarget)
  );
}

function markQueuedConnectionSecretSync(
  connectionId: string,
  explicitTarget?: SecretBackendTarget
): string {
  const key = buildConnectionSecretSyncKey(connectionId, explicitTarget);
  queuedConnectionSecretSyncKeys.add(key);
  return key;
}

async function runConnectionSecretSyncNow(
  connectionId: string,
  explicitTarget?: SecretBackendTarget
): Promise<boolean> {
  if (hasQueuedConnectionSecretSync(connectionId, explicitTarget)) {
    return false;
  }

  const queueKey = markQueuedConnectionSecretSync(connectionId, explicitTarget);

  try {
    await connectionSecretSyncRuntime.syncConnectionSecretReplicasById(
      connectionId,
      explicitTarget
    );
    return true;
  } catch (error) {
    logScheduledSyncError(connectionId, error);
    return false;
  } finally {
    queuedConnectionSecretSyncKeys.delete(queueKey);
  }
}

function queueConnectionSecretSync(
  connectionId: string,
  explicitTarget?: SecretBackendTarget
): void {
  setTimeout(() => {
    void runConnectionSecretSyncNow(connectionId, explicitTarget);
  }, 0);
}

export async function enqueueConnectionSecretSyncs(
  connectionIds: string[],
  explicitTarget?: SecretBackendTarget
): Promise<ConnectionSecretReplicaRow[]> {
  const uniqueConnectionIds = Array.from(
    new Set(
      connectionIds
        .map((connectionId) => connectionId?.trim())
        .filter((connectionId): connectionId is string => Boolean(connectionId))
    )
  );
  if (uniqueConnectionIds.length === 0) {
    return [];
  }

  const mode = await getConnectionAuthMode();
  if (mode !== "secret_manager") {
    return [];
  }

  const pendingReplicas: ConnectionSecretReplicaRow[] = [];
  for (const connectionId of uniqueConnectionIds) {
    const pending =
      await connectionSecretSyncRuntime.markConnectionSecretReplicasPendingById(
        connectionId,
        explicitTarget
      );

    if (pending.length === 0) {
      continue;
    }

    pendingReplicas.push(...pending);
    queueConnectionSecretSync(connectionId, explicitTarget);
  }

  return pendingReplicas;
}

export async function scheduleConnectionSecretSync(
  connectionId: string,
  explicitTarget?: SecretBackendTarget
): Promise<ConnectionSecretReplicaRow[]> {
  const pending = await enqueueConnectionSecretSyncs(
    [connectionId],
    explicitTarget
  );
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

export async function reconcileStaleConnectionSecretReplicas(options?: {
  limit?: number;
}): Promise<{
  queued: number;
  scanned: number;
}> {
  const mode = await getConnectionAuthMode();
  if (mode !== "secret_manager") {
    return {
      queued: 0,
      scanned: 0,
    };
  }

  const staleReplicas = await prisma.connectionSecretReplica.findMany({
    where: {
      status: { in: ["pending", "error"] },
    },
    orderBy: [{ updatedAt: "asc" }],
    take: options?.limit || DEFAULT_SECRET_REPLICA_RECONCILE_BATCH_SIZE,
    select: {
      connectionId: true,
      backendKind: true,
      backendRegion: true,
      backendProjectId: true,
    },
  });

  const descriptors = Array.from(
    new Map(
      staleReplicas
        .map((replica) => {
          const backendKind = normalizeSecretBackendKind(replica.backendKind);
          if (!backendKind) {
            return null;
          }

          const target: SecretBackendTarget = {
            kind: backendKind,
            region: replica.backendRegion || undefined,
            projectId: replica.backendProjectId || undefined,
          };

          return [
            buildConnectionSecretSyncKey(replica.connectionId, target),
            {
              connectionId: replica.connectionId,
              explicitTarget: target,
            },
          ] as const;
        })
        .filter(
          (
            entry
          ): entry is readonly [
            string,
            { connectionId: string; explicitTarget: SecretBackendTarget }
          ] => Boolean(entry)
        )
    ).values()
  );

  let queued = 0;
  for (const descriptor of descriptors) {
    const executed = await runConnectionSecretSyncNow(
      descriptor.connectionId,
      descriptor.explicitTarget
    );
    if (executed) {
      queued += 1;
    }
  }

  return {
    queued,
    scanned: staleReplicas.length,
  };
}

function logReconcileError(error: unknown): void {
  console.warn(
    `[auth-strategy] Failed to reconcile stale secret replicas: ${
      error instanceof Error ? error.message : "Unknown error"
    }`
  );
}

export function startConnectionSecretSyncReconciler(options?: {
  intervalMs?: number;
  batchSize?: number;
}): void {
  if (reconcileIntervalHandle) {
    return;
  }

  const run = async () => {
    if (reconcileRunInFlight) {
      return;
    }

    reconcileRunInFlight = true;
    try {
      await reconcileStaleConnectionSecretReplicas({
        limit: options?.batchSize,
      });
    } catch (error) {
      logReconcileError(error);
    } finally {
      reconcileRunInFlight = false;
    }
  };

  void run();

  reconcileIntervalHandle = setInterval(
    () => {
      void run();
    },
    options?.intervalMs || DEFAULT_SECRET_REPLICA_RECONCILE_INTERVAL_MS
  );
  reconcileIntervalHandle.unref?.();
}

export function stopConnectionSecretSyncReconciler(): void {
  if (reconcileIntervalHandle) {
    clearInterval(reconcileIntervalHandle);
    reconcileIntervalHandle = null;
  }
}

export function resetConnectionSecretSyncRuntimeStateForTests(): void {
  stopConnectionSecretSyncReconciler();
  queuedConnectionSecretSyncKeys.clear();
  reconcileRunInFlight = false;
}
