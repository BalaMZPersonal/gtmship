import { apiGet, apiPost } from "./api-client.js";

export type CliConnectionAuthMode = "proxy" | "secret_manager";
export type CliConnectionAuthStrategyHealth = "healthy" | "degraded" | "migrating";
export type CliSecretBackendKind = "aws_secrets_manager" | "gcp_secret_manager";

export interface CliSecretBackendTarget {
  kind: CliSecretBackendKind;
  region?: string | null;
  projectId?: string | null;
  secretPrefix?: string | null;
}

export interface CliConnectionAuthStrategyStatus {
  mode: CliConnectionAuthMode;
  status?: CliConnectionAuthStrategyHealth;
  configuredBackends?: CliSecretBackendTarget[];
  replicaSummary?: {
    activeConnections: number;
    expectedReplicas: number;
    active: number;
    pending: number;
    error: number;
    missing: number;
  };
  updated?: boolean;
  backfill?: {
    connections?: {
      activeConnections: number;
      syncedReplicas: number;
      errorReplicas: number;
    };
    deployments?: {
      total: number;
      updated: number;
      skipped: number;
    };
  };
}

export interface CliConnectionSecretReplica {
  id: string;
  connectionId: string;
  backendKind: CliSecretBackendKind;
  backendRegion: string;
  backendProjectId: string;
  runtimeSecretRef: string;
  controlSecretRef: string | null;
  status: string;
  lastSyncedAt: string | null;
  lastError: string | null;
  metadata?: unknown;
}

export async function fetchConnectionAuthStrategyStatus(): Promise<CliConnectionAuthStrategyStatus | null> {
  try {
    return (await apiGet("/settings/auth-strategy")) as CliConnectionAuthStrategyStatus;
  } catch {
    return null;
  }
}

export function isSecretManagerMode(
  strategy: CliConnectionAuthStrategyStatus | null | undefined
): boolean {
  return strategy?.mode === "secret_manager";
}

export async function fetchConnectionSecretReplicas(
  connectionId: string
): Promise<CliConnectionSecretReplica[]> {
  return (await apiGet(
    `/connections/${encodeURIComponent(connectionId)}/secret-replicas`
  )) as CliConnectionSecretReplica[];
}

export async function triggerConnectionSecretReplicaSync(input: {
  connectionId: string;
  backendKind?: CliSecretBackendKind;
  backendRegion?: string;
  backendProjectId?: string;
}): Promise<{
  synced: number;
  replicas: CliConnectionSecretReplica[];
}> {
  const body: Record<string, string> = {};
  if (input.backendKind) body.backendKind = input.backendKind;
  if (input.backendRegion) body.backendRegion = input.backendRegion;
  if (input.backendProjectId) body.backendProjectId = input.backendProjectId;

  return (await apiPost(
    `/connections/${encodeURIComponent(input.connectionId)}/secret-replicas/sync`,
    Object.keys(body).length > 0 ? body : undefined
  )) as {
    synced: number;
    replicas: CliConnectionSecretReplica[];
  };
}

export function summarizeConnectionSecretReplicas(
  replicas: CliConnectionSecretReplica[]
): {
  active: number;
  pending: number;
  error: number;
} {
  return replicas.reduce(
    (summary, replica) => {
      if (replica.status === "active") {
        summary.active += 1;
      } else if (replica.status === "pending") {
        summary.pending += 1;
      } else if (replica.status === "error") {
        summary.error += 1;
      }

      return summary;
    },
    {
      active: 0,
      pending: 0,
      error: 0,
    }
  );
}

export function formatSecretBackendTarget(input: {
  kind: string;
  region?: string | null;
  projectId?: string | null;
}): string {
  if (input.kind === "aws_secrets_manager") {
    return input.region ? `aws:${input.region}` : "aws";
  }

  if (input.kind === "gcp_secret_manager") {
    return input.projectId ? `gcp:${input.projectId}` : "gcp";
  }

  return input.kind;
}

export function summarizeConfiguredSecretBackends(
  backends: Array<{
    kind: string;
    region?: string | null;
    projectId?: string | null;
  }> | null | undefined
): string {
  if (!backends || backends.length === 0) {
    return "none";
  }

  return backends.map((backend) => formatSecretBackendTarget(backend)).join(", ");
}
