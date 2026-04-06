import { Prisma } from "@prisma/client";
import { prisma } from "./db.js";
import {
  loadConfiguredSecretBackendTargets,
  syncConnectionSecretReplicasById,
  syncDeploymentBindingSecretReplicas,
  type SecretBackendTarget,
} from "./connection-secret-replicas.js";

export interface WorkflowDeploymentAuthRecord {
  id: string;
  provider: string;
  region: string | null;
  gcpProject: string | null;
  authMode: string;
  authBackendKind: string | null;
  authBackendRegion: string | null;
  authBackendProjectId: string | null;
  authRuntimeAccess: string | null;
  runtimeAuthManifest: unknown;
  status: string;
}

export interface WorkflowBindingReplicaCheck {
  providerSlug: string;
  connectionId: string | null;
  selectorType: string;
}

export interface DeploymentSecretSyncTask {
  deploymentId: string;
  authMode: string;
  backend: SecretBackendTarget | null;
  existingManifest: unknown;
}

export const workflowDeploymentSecretSyncRuntime = {
  syncConnectionSecretReplicasById,
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function jsonValueToSql(value: unknown): Prisma.Sql {
  if (value === undefined || value === null) {
    return Prisma.sql`NULL`;
  }

  return Prisma.sql`${JSON.stringify(value)}::jsonb`;
}

function normalizeText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function collectDistinctBindingConnectionIds(
  bindings: WorkflowBindingReplicaCheck[]
): string[] {
  return Array.from(
    new Set(
      bindings
        .map((binding) => normalizeText(binding.connectionId))
        .filter((connectionId): connectionId is string => Boolean(connectionId))
    )
  );
}

function secretBackendMatches(
  replica: {
    backendKind: string;
    backendRegion: string;
    backendProjectId: string;
  },
  backend: SecretBackendTarget
): boolean {
  return (
    replica.backendKind === backend.kind &&
    replica.backendRegion === (backend.region || "") &&
    replica.backendProjectId === (backend.projectId || "")
  );
}

export async function resolveSecretBackendForDeployment(input: {
  provider: string;
  region?: string | null;
  gcpProject?: string | null;
  requested?: SecretBackendTarget | null;
}): Promise<SecretBackendTarget | null> {
  if (input.provider === "local") {
    return null;
  }

  if (input.requested?.kind) {
    return {
      ...input.requested,
      region:
        input.requested.kind === "aws_secrets_manager"
          ? input.requested.region || input.region || "us-east-1"
          : input.requested.region,
      projectId:
        input.requested.kind === "gcp_secret_manager"
          ? input.requested.projectId || input.gcpProject
          : input.requested.projectId,
    };
  }

  const configuredTargets = await loadConfiguredSecretBackendTargets();
  if (input.provider === "aws") {
    const target = configuredTargets.find(
      (candidate) => candidate.kind === "aws_secrets_manager"
    );
    return target
      ? {
          ...target,
          region: input.region || target.region || "us-east-1",
        }
      : null;
  }

  if (input.provider === "gcp") {
    const target = configuredTargets.find(
      (candidate) => candidate.kind === "gcp_secret_manager"
    );
    const projectId = input.gcpProject || target?.projectId || null;
    return projectId
      ? {
          ...(target || { kind: "gcp_secret_manager" as const }),
          projectId,
        }
      : null;
  }

  return null;
}

export async function syncDeploymentRuntimeManifests(
  syncTasks: DeploymentSecretSyncTask[]
): Promise<void> {
  for (const task of syncTasks) {
    if (task.authMode !== "secret_manager" || !task.backend) {
      continue;
    }

    const replicas = await syncDeploymentBindingSecretReplicas({
      deploymentId: task.deploymentId,
      backend: task.backend,
    });
    const manifestRecord = asRecord(task.existingManifest);
    const providers = replicas.map((replica) => ({
      providerSlug: replica.providerSlug,
      connectionId: replica.connectionId,
      secretRef: replica.runtimeSecretRef,
    }));
    const mergedManifest = {
      ...manifestRecord,
      version:
        typeof manifestRecord.version === "string"
          ? manifestRecord.version
          : "1",
      generatedAt: new Date().toISOString(),
      providers,
    };

    await prisma.$executeRaw(Prisma.sql`
      UPDATE workflow_deployments
      SET
        runtime_auth_manifest = ${jsonValueToSql(mergedManifest)},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${task.deploymentId}
    `);
  }
}

export async function assertHealthySecretReplicasForBindings(input: {
  bindings: WorkflowBindingReplicaCheck[];
  backend: SecretBackendTarget;
}): Promise<void> {
  const missingConnectionIds = input.bindings.filter(
    (binding) => !normalizeText(binding.connectionId)
  );
  if (missingConnectionIds.length > 0) {
    throw new Error(
      `Secret-manager deploys require resolved connection bindings. Missing connectionId for: ${missingConnectionIds
        .map((binding) => `${binding.providerSlug} (${binding.selectorType})`)
        .join(", ")}.`
    );
  }

  const connectionIds = Array.from(
    new Set(
      input.bindings
        .map((binding) => normalizeText(binding.connectionId))
        .filter(Boolean) as string[]
    )
  );

  if (connectionIds.length === 0) {
    return;
  }

  const replicas = await prisma.connectionSecretReplica.findMany({
    where: {
      connectionId: { in: connectionIds },
    },
    select: {
      connectionId: true,
      backendKind: true,
      backendRegion: true,
      backendProjectId: true,
      status: true,
      lastError: true,
    },
  });

  const errors: string[] = [];
  for (const binding of input.bindings) {
    const connectionId = normalizeText(binding.connectionId);
    if (!connectionId) {
      continue;
    }

    const replica = replicas.find(
      (candidate) =>
        candidate.connectionId === connectionId &&
        secretBackendMatches(candidate, input.backend)
    );

    if (!replica) {
      errors.push(
        `${binding.providerSlug}: connection ${connectionId} has no secret replica for ${input.backend.kind}.`
      );
      continue;
    }

    if (replica.status !== "active") {
      errors.push(
        `${binding.providerSlug}: connection ${connectionId} replica is ${replica.status}${
          replica.lastError ? ` (${replica.lastError})` : ""
        }.`
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Secret-manager deploys are blocked until replicas are healthy. ${errors.join(" ")}`
    );
  }
}

export async function resyncSecretReplicasForBindings(input: {
  bindings: WorkflowBindingReplicaCheck[];
  backend: SecretBackendTarget;
}): Promise<{
  connectionIds: string[];
}> {
  const connectionIds = collectDistinctBindingConnectionIds(input.bindings);
  for (const connectionId of connectionIds) {
    await workflowDeploymentSecretSyncRuntime.syncConnectionSecretReplicasById(
      connectionId,
      input.backend
    );
  }

  return { connectionIds };
}

export async function syncAndAssertHealthySecretReplicasForBindings(input: {
  bindings: WorkflowBindingReplicaCheck[];
  backend: SecretBackendTarget;
}): Promise<void> {
  await resyncSecretReplicasForBindings(input);
  await assertHealthySecretReplicasForBindings(input);
}

export async function enforceAuthModeOnExistingDeployments(
  mode: "proxy" | "secret_manager"
): Promise<{
  total: number;
  updated: number;
  skipped: number;
}> {
  const deployments = await prisma.workflowDeployment.findMany({
    where: { status: "active" },
    select: {
      id: true,
      provider: true,
      region: true,
      gcpProject: true,
      authMode: true,
      authBackendKind: true,
      authBackendRegion: true,
      authBackendProjectId: true,
      authRuntimeAccess: true,
      runtimeAuthManifest: true,
      status: true,
    },
  });

  if (mode === "proxy") {
    const updated = await prisma.workflowDeployment.updateMany({
      where: { status: "active" },
      data: {
        authMode: "proxy",
        authBackendKind: null,
        authBackendRegion: null,
        authBackendProjectId: null,
        authRuntimeAccess: null,
        runtimeAuthManifest: Prisma.DbNull,
      },
    });

    return {
      total: deployments.length,
      updated: updated.count,
      skipped: 0,
    };
  }

  const syncTasks: DeploymentSecretSyncTask[] = [];
  let updated = 0;
  let skipped = 0;

  for (const deployment of deployments) {
    const backend = await resolveSecretBackendForDeployment({
      provider: deployment.provider,
      region: deployment.region,
      gcpProject: deployment.gcpProject,
      requested:
        deployment.authBackendKind === "aws_secrets_manager" ||
        deployment.authBackendKind === "gcp_secret_manager"
          ? {
              kind: deployment.authBackendKind,
              region: deployment.authBackendRegion,
              projectId: deployment.authBackendProjectId,
            }
          : null,
    });

    if (!backend) {
      skipped += 1;
      continue;
    }

    const bindings = await prisma.workflowBinding.findMany({
      where: { deploymentId: deployment.id },
      select: {
        providerSlug: true,
        connectionId: true,
        selectorType: true,
      },
    });

    try {
      await syncAndAssertHealthySecretReplicasForBindings({
        bindings: bindings.map((binding) => ({
          providerSlug: binding.providerSlug,
          connectionId: binding.connectionId,
          selectorType: binding.selectorType,
        })),
        backend,
      });
    } catch {
      skipped += 1;
      continue;
    }

    await prisma.workflowDeployment.update({
      where: { id: deployment.id },
      data: {
        authMode: "secret_manager",
        authBackendKind: backend.kind,
        authBackendRegion: backend.region || null,
        authBackendProjectId: backend.projectId || null,
        authRuntimeAccess: deployment.authRuntimeAccess || "direct",
      },
    });

    syncTasks.push({
      deploymentId: deployment.id,
      authMode: "secret_manager",
      backend,
      existingManifest: deployment.runtimeAuthManifest,
    });
    updated += 1;
  }

  await syncDeploymentRuntimeManifests(syncTasks);

  return {
    total: deployments.length,
    updated,
    skipped,
  };
}
