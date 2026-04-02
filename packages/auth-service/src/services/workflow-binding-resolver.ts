import type { Request } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "./db.js";
import type { ConnectionWithResolvedAuth } from "./connection-auth.js";
import { decrypt } from "./crypto.js";

const connectionInclude = {
  provider: true,
  oauthCredential: {
    select: {
      id: true,
      accountEmail: true,
      accessToken: true,
      refreshToken: true,
      tokenExpiresAt: true,
    },
  },
} satisfies Prisma.ConnectionInclude;

export type ResolvedAuthConnection = ConnectionWithResolvedAuth;

type BindingSelectorType = "latest_active" | "connection_id" | "label";

export interface RequestedBindingSelector {
  type: BindingSelectorType;
  value?: string;
}

interface WorkflowBindingRow {
  id: string;
  deploymentId: string;
  providerSlug: string;
  selectorType: string;
  selectorValue: string | null;
  connectionId: string | null;
}

interface WorkflowDeploymentRefRow {
  id: string;
}

export interface RuntimeIdentityHeaders {
  deploymentId?: string;
  workflowId?: string;
  executionId?: string;
  runId?: string;
  runtimeKey?: string;
}

export function hasRuntimeIdentity(
  runtimeIdentity: RuntimeIdentityHeaders
): boolean {
  return Boolean(
    runtimeIdentity.deploymentId ||
      runtimeIdentity.workflowId ||
      runtimeIdentity.executionId ||
      runtimeIdentity.runId
  );
}

export interface ConnectionResolutionResult {
  connection: ResolvedAuthConnection | null;
  resolution: {
    source: "binding" | "request_selector" | "fallback_latest_active";
    deploymentId?: string;
    workflowId?: string;
    bindingId?: string;
    selectorType?: BindingSelectorType;
    selectorValue?: string | null;
    fallbackReason?: string;
  };
}

export function getRuntimeIdentityFromRequest(
  req: Request
): RuntimeIdentityHeaders {
  const deploymentId = req.header("x-gtmship-deployment-id")?.trim();
  const workflowId = req.header("x-gtmship-workflow-id")?.trim();
  const executionId = req.header("x-gtmship-execution-id")?.trim();
  const runId = req.header("x-gtmship-run-id")?.trim();
  const runtimeKey = req.header("x-gtmship-runtime-key")?.trim();

  return {
    deploymentId: deploymentId || undefined,
    workflowId: workflowId || undefined,
    executionId: executionId || undefined,
    runId: runId || undefined,
    runtimeKey: runtimeKey || undefined,
  };
}

export function getBindingSelectorFromRequest(
  req: Request
): RequestedBindingSelector | undefined {
  const selectorType = req.header("x-gtmship-binding-selector-type")?.trim();
  const selectorValue = req.header("x-gtmship-binding-selector-value")?.trim();

  if (!selectorType) {
    return undefined;
  }

  return {
    type: normalizeSelectorType(selectorType),
    value: selectorValue || undefined,
  };
}

function normalizeSelectorType(
  value: string | null | undefined
): BindingSelectorType {
  if (value === "connection_id" || value === "label") {
    return value;
  }

  return "latest_active";
}

async function getLatestActiveConnection(
  providerSlug: string
): Promise<ResolvedAuthConnection | null> {
  return prisma.connection.findFirst({
    where: { provider: { slug: providerSlug }, status: "active" },
    include: connectionInclude,
    orderBy: { createdAt: "desc" },
  });
}

async function getActiveConnections(
  providerSlug: string
): Promise<ResolvedAuthConnection[]> {
  return prisma.connection.findMany({
    where: { provider: { slug: providerSlug }, status: "active" },
    include: connectionInclude,
    orderBy: { createdAt: "desc" },
  });
}

async function getConnectionById(
  providerSlug: string,
  connectionId: string
): Promise<ResolvedAuthConnection | null> {
  return prisma.connection.findFirst({
    where: {
      id: connectionId,
      status: "active",
      provider: { slug: providerSlug },
    },
    include: connectionInclude,
  });
}

async function getConnectionByLabel(
  providerSlug: string,
  label: string
): Promise<ResolvedAuthConnection | null> {
  return prisma.connection.findFirst({
    where: {
      label,
      status: "active",
      provider: { slug: providerSlug },
    },
    include: connectionInclude,
    orderBy: { createdAt: "desc" },
  });
}

async function getBindingForDeployment(
  deploymentId: string,
  providerSlug: string
): Promise<WorkflowBindingRow | null> {
  const rows = await prisma.$queryRaw<WorkflowBindingRow[]>(Prisma.sql`
    SELECT
      id,
      deployment_id AS "deploymentId",
      provider_slug AS "providerSlug",
      selector_type AS "selectorType",
      selector_value AS "selectorValue",
      connection_id AS "connectionId"
    FROM workflow_bindings
    WHERE deployment_id = ${deploymentId}
      AND provider_slug = ${providerSlug}
    ORDER BY created_at DESC
    LIMIT 1
  `);

  return rows[0] || null;
}

async function getMostRecentDeploymentByWorkflow(
  workflowId: string
): Promise<WorkflowDeploymentRefRow | null> {
  const rows = await prisma.$queryRaw<WorkflowDeploymentRefRow[]>(Prisma.sql`
    SELECT id
    FROM workflow_deployments
    WHERE workflow_id = ${workflowId}
    ORDER BY updated_at DESC
    LIMIT 1
  `);

  return rows[0] || null;
}

async function resolveConnectionFromBinding(
  providerSlug: string,
  binding: WorkflowBindingRow
): Promise<ResolvedAuthConnection | null> {
  const selectorType = normalizeSelectorType(binding.selectorType);

  if (selectorType === "connection_id") {
    const explicitConnectionId = binding.connectionId || binding.selectorValue;
    if (!explicitConnectionId) {
      return null;
    }

    return getConnectionById(providerSlug, explicitConnectionId);
  }

  if (selectorType === "label") {
    if (!binding.selectorValue) {
      return null;
    }

    return getConnectionByLabel(providerSlug, binding.selectorValue);
  }

  return getLatestActiveConnection(providerSlug);
}

async function resolveConnectionFromRequestedSelector(
  providerSlug: string,
  selector: RequestedBindingSelector
): Promise<ResolvedAuthConnection | null> {
  if (selector.type === "connection_id") {
    if (!selector.value) {
      return null;
    }

    return getConnectionById(providerSlug, selector.value);
  }

  if (selector.type === "label") {
    if (!selector.value) {
      return null;
    }

    return getConnectionByLabel(providerSlug, selector.value);
  }

  return getLatestActiveConnection(providerSlug);
}

export async function resolveConnectionForProvider(
  providerSlug: string,
  runtimeIdentity: RuntimeIdentityHeaders,
  requestedSelector?: RequestedBindingSelector
): Promise<ConnectionResolutionResult> {
  let selectedBinding: WorkflowBindingRow | null = null;
  let fallbackReason: string | undefined;

  if (requestedSelector) {
    const explicitConnection = await resolveConnectionFromRequestedSelector(
      providerSlug,
      requestedSelector
    );

    if (explicitConnection) {
      return {
        connection: explicitConnection,
        resolution: {
          source: "request_selector",
          deploymentId: runtimeIdentity.deploymentId,
          workflowId: runtimeIdentity.workflowId,
          selectorType: requestedSelector.type,
          selectorValue: requestedSelector.value || null,
        },
      };
    }

    fallbackReason = "request_selector_not_resolvable";
  }

  if (runtimeIdentity.deploymentId) {
    selectedBinding = await getBindingForDeployment(
      runtimeIdentity.deploymentId,
      providerSlug
    );

    if (!selectedBinding) {
      fallbackReason = "deployment_binding_not_found";
    }
  }

  if (!selectedBinding && runtimeIdentity.workflowId) {
    const deployment = await getMostRecentDeploymentByWorkflow(
      runtimeIdentity.workflowId
    );

    if (deployment) {
      selectedBinding = await getBindingForDeployment(deployment.id, providerSlug);
      if (!selectedBinding && !fallbackReason) {
        fallbackReason = "workflow_binding_not_found";
      }
    } else if (!fallbackReason) {
      fallbackReason = "workflow_deployment_not_found";
    }
  }

  if (selectedBinding) {
    const boundConnection = await resolveConnectionFromBinding(
      providerSlug,
      selectedBinding
    );
    if (boundConnection) {
      return {
        connection: boundConnection,
        resolution: {
          source: "binding",
          deploymentId: selectedBinding.deploymentId,
          workflowId: runtimeIdentity.workflowId,
          bindingId: selectedBinding.id,
          selectorType: normalizeSelectorType(selectedBinding.selectorType),
          selectorValue: selectedBinding.selectorValue,
        },
      };
    }

    fallbackReason = "binding_target_not_resolvable";
  }

  const requiresDeterministicBinding = Boolean(
    runtimeIdentity.deploymentId || runtimeIdentity.workflowId
  );
  const activeConnections = requiresDeterministicBinding
    ? await getActiveConnections(providerSlug)
    : [];

  if (requiresDeterministicBinding && activeConnections.length > 1) {
    return {
      connection: null,
      resolution: {
        source: "fallback_latest_active",
        deploymentId: runtimeIdentity.deploymentId,
        workflowId: runtimeIdentity.workflowId,
        fallbackReason: fallbackReason || "ambiguous_without_binding",
      },
    };
  }

  const fallbackConnection =
    activeConnections[0] || (await getLatestActiveConnection(providerSlug));
  return {
    connection: fallbackConnection,
    resolution: {
      source: "fallback_latest_active",
      deploymentId: runtimeIdentity.deploymentId,
      workflowId: runtimeIdentity.workflowId,
      fallbackReason,
    },
  };
}

export async function validateRuntimeKey(
  req: Request
): Promise<{ ok: true } | { ok: false; error: string }> {
  const runtimeIdentity = getRuntimeIdentityFromRequest(req);
  if (!runtimeIdentity.deploymentId && !runtimeIdentity.workflowId) {
    return { ok: true };
  }

  const runtimeKeySetting = await prisma.setting.findUnique({
    where: { key: "workflow_runtime_key" },
  });

  if (!runtimeKeySetting) {
    return { ok: true };
  }

  const configuredKey = decrypt(runtimeKeySetting.value);
  if (!runtimeIdentity.runtimeKey) {
    return {
      ok: false,
      error:
        "Missing x-gtmship-runtime-key for workflow-bound runtime credentials.",
    };
  }

  if (runtimeIdentity.runtimeKey !== configuredKey) {
    return {
      ok: false,
      error: "Invalid x-gtmship-runtime-key for workflow-bound runtime access.",
    };
  }

  return { ok: true };
}
