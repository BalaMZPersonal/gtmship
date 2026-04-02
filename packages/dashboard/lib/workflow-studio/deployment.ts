import {
  planWorkflowDeployment,
  type DeployTarget,
  type PlannerConnectionRecord,
  type TriggerConfig,
  type WorkflowBinding as PlannerWorkflowBinding,
  type WorkflowBindingSelector as PlannerWorkflowBindingSelector,
  type WorkflowTriggerConfiguration as PlannerWorkflowTriggerConfiguration,
} from "@gtmship/deploy-engine/planner";
import { loadWorkflowDefinitionFromSource } from "./runtime";
import type { ActiveConnectionRecord } from "./auth-service";
import type {
  WorkflowBinding,
  WorkflowBindingSelector,
  WorkflowDeploySpec,
  WorkflowDeploymentPlan,
  WorkflowStudioArtifact,
  WorkflowTriggerConfig,
} from "./types";

interface WorkflowDefinitionLike {
  id?: string;
  name?: string;
  trigger?: TriggerConfig;
  deploy?: DeployTarget;
  triggerConfig?: PlannerWorkflowTriggerConfiguration;
  bindings?: PlannerWorkflowBinding[];
}

function buildPlannerSdkStub() {
  return {
    defineWorkflow<T>(config: T): T {
      return config;
    },
    triggers: {
      manual() {
        return { type: "manual" as const };
      },
      webhook(path: string) {
        return { type: "webhook" as const, path };
      },
      schedule(cron: string) {
        return { type: "schedule" as const, cron };
      },
      event(eventName: string) {
        return { type: "event" as const, event: eventName };
      },
    },
    auth: {
      getClient() {
        throw new Error("auth.getClient() is unavailable in plan mode.");
      },
      getToken() {
        throw new Error("auth.getToken() is unavailable in plan mode.");
      },
    },
    createWorkflowContext() {
      return {};
    },
  };
}

function extractString(source: string, pattern: RegExp): string | undefined {
  return source.match(pattern)?.[1]?.trim();
}

function extractTriggerFromSource(source: string): TriggerConfig {
  const webhookPath = extractString(
    source,
    /triggers\.webhook\(\s*["'`]([^"'`]+)["'`]\s*\)/
  );
  if (webhookPath) {
    return { type: "webhook", path: webhookPath };
  }

  const cron = extractString(
    source,
    /triggers\.schedule\(\s*["'`]([^"'`]+)["'`]\s*\)/
  );
  if (cron) {
    return { type: "schedule", cron };
  }

  const eventName = extractString(
    source,
    /triggers\.event\(\s*["'`]([^"'`]+)["'`]\s*\)/
  );
  if (eventName) {
    return { type: "event", event: eventName };
  }

  return { type: "manual" };
}

function detectProviderUsages(source: string): string[] {
  return Array.from(
    new Set([
      ...Array.from(
        source.matchAll(/ctx\.integration\(\s*["'`]([^"'`]+)["'`]\s*\)/g)
      ).map((match) => match[1]),
      ...Array.from(
        source.matchAll(/auth\.get(?:Client|Token)\(\s*["'`]([^"'`]+)["'`]\s*\)/g)
      ).map((match) => match[1]),
    ])
  );
}

function normalizeConnectionRecords(
  connections: ActiveConnectionRecord[]
): PlannerConnectionRecord[] {
  return connections.map((connection) => ({
    id: connection.id,
    label: connection.label,
    status: connection.status,
    createdAt: connection.createdAt,
    provider: {
      slug: connection.provider.slug,
      name: connection.provider.name,
    },
  }));
}

function normalizeBindingSelector(
  selector?: WorkflowBindingSelector
): PlannerWorkflowBindingSelector | undefined {
  if (!selector) {
    return undefined;
  }

  return {
    type: selector.type,
    connectionId: selector.connectionId,
    label: selector.label,
  };
}

function normalizeBindings(
  bindings?: WorkflowBinding[]
): PlannerWorkflowBinding[] | undefined {
  if (!bindings || bindings.length === 0) {
    return undefined;
  }

  return bindings.map((binding) => ({
    providerSlug: binding.providerSlug,
    selector: normalizeBindingSelector(binding.selector) || {
      type: "latest_active",
    },
  }));
}

function normalizeDeploySpec(
  deploy?: WorkflowDeploySpec
): DeployTarget | undefined {
  if (!deploy) {
    return undefined;
  }

  return {
    provider: deploy.provider,
    region: deploy.region,
    gcpProject: deploy.gcpProject,
    execution: {
      kind: deploy.execution?.kind,
      timeoutSeconds: deploy.execution?.timeoutSeconds || deploy.timeoutSeconds,
      memory: deploy.execution?.memory || deploy.memory,
      cpu: deploy.execution?.cpu || deploy.cpu,
    },
    timeoutSeconds: deploy.timeoutSeconds,
    memory: deploy.memory,
    cpu: deploy.cpu,
    auth: deploy.auth
      ? {
          mode: deploy.auth.mode,
          backend: deploy.auth.backend,
          runtimeAccess: deploy.auth.runtimeAccess,
          manifest: deploy.auth.manifest
            ? {
                version: deploy.auth.manifest.version || "1",
                generatedAt:
                  deploy.auth.manifest.generatedAt ||
                  new Date().toISOString(),
                providers: deploy.auth.manifest.providers,
              }
            : undefined,
        }
      : undefined,
  };
}

function normalizeTriggerConfig(
  triggerConfig?: WorkflowTriggerConfig
): PlannerWorkflowTriggerConfiguration | undefined {
  if (!triggerConfig) {
    return undefined;
  }

  return {
    schedule: triggerConfig.schedule
      ? {
          cron: triggerConfig.schedule.cron,
          timezone: triggerConfig.schedule.timezone,
          payload: triggerConfig.schedule.defaultPayload,
        }
      : undefined,
    webhook: triggerConfig.webhook
      ? {
          path: triggerConfig.webhook.path,
          access:
            triggerConfig.webhook.visibility === "private"
              ? "private"
              : "public",
          signature:
            triggerConfig.webhook.signatureHeader ||
            triggerConfig.webhook.signatureSecretRef
              ? {
                  header: triggerConfig.webhook.signatureHeader,
                  secretRef: triggerConfig.webhook.signatureSecretRef,
                }
              : undefined,
        }
      : undefined,
    event: triggerConfig.event
      ? {
          source: triggerConfig.event.source,
          bus: triggerConfig.event.eventBus,
          topic: triggerConfig.event.topic,
          subscription: triggerConfig.event.queue,
          event: triggerConfig.event.detailType,
        }
      : undefined,
  };
}

function mergeDeploySpecs(
  ...values: Array<DeployTarget | undefined>
): DeployTarget | undefined {
  let merged: DeployTarget | undefined;

  for (const value of values) {
    if (!value) {
      continue;
    }

    merged = {
      ...(merged || {}),
      ...value,
      execution: {
        ...(merged?.execution || {}),
        ...(value.execution || {}),
      },
      auth: {
        ...(merged?.auth || {}),
        ...(value.auth || {}),
      },
    };
  }

  return merged;
}

function mergeTriggerConfigs(
  ...values: Array<PlannerWorkflowTriggerConfiguration | undefined>
): PlannerWorkflowTriggerConfiguration | undefined {
  let merged: PlannerWorkflowTriggerConfiguration | undefined;

  for (const value of values) {
    if (!value) {
      continue;
    }

    merged = {
      ...(merged || {}),
      ...value,
      schedule: {
        ...(merged?.schedule || {}),
        ...(value.schedule || {}),
      },
      webhook: {
        ...(merged?.webhook || {}),
        ...(value.webhook || {}),
        signature: {
          ...(merged?.webhook?.signature || {}),
          ...(value.webhook?.signature || {}),
        },
      },
      event: {
        ...(merged?.event || {}),
        ...(value.event || {}),
      },
    };
  }

  return merged;
}

function mergeBindings(
  ...values: Array<PlannerWorkflowBinding[] | undefined>
): PlannerWorkflowBinding[] | undefined {
  const bindings = new Map<string, PlannerWorkflowBinding>();

  for (const value of values) {
    for (const binding of value || []) {
      bindings.set(binding.providerSlug, binding);
    }
  }

  return bindings.size > 0 ? [...bindings.values()] : undefined;
}

function loadWorkflowDefinition(
  artifact: WorkflowStudioArtifact
): WorkflowDefinitionLike | undefined {
  try {
    return loadWorkflowDefinitionFromSource<WorkflowDefinitionLike>(
      artifact.code,
      buildPlannerSdkStub(),
      `${artifact.slug}.ts`
    );
  } catch {
    return undefined;
  }
}

export function buildWorkflowDeploymentPlanForArtifact(input: {
  artifact: WorkflowStudioArtifact;
  connections: ActiveConnectionRecord[];
  provider?: "aws" | "gcp";
  region?: string;
  gcpProject?: string;
}): WorkflowDeploymentPlan {
  const definition = loadWorkflowDefinition(input.artifact);
  const requiredProviders = Array.from(
    new Set([
      ...detectProviderUsages(input.artifact.code),
      ...input.artifact.requiredAccesses
        .map((access) => access.providerSlug)
        .filter(Boolean),
      ...(input.artifact.bindings || []).map((binding) => binding.providerSlug),
    ])
  ) as string[];

  const plan = planWorkflowDeployment({
    workflowId: definition?.id || input.artifact.slug,
    workflowName: definition?.name || input.artifact.title,
    trigger: definition?.trigger || extractTriggerFromSource(input.artifact.code),
    deploy: mergeDeploySpecs(
      definition?.deploy,
      normalizeDeploySpec(input.artifact.deploy)
    ),
    triggerConfig: mergeTriggerConfigs(
      definition?.trigger?.config,
      definition?.triggerConfig,
      normalizeTriggerConfig(input.artifact.triggerConfig)
    ),
    bindings: mergeBindings(
      definition?.bindings,
      normalizeBindings(input.artifact.bindings)
    ),
    requiredProviders,
    providerOverride: input.provider,
    regionOverride: input.region,
    gcpProjectOverride: input.gcpProject,
    connections: normalizeConnectionRecords(input.connections),
  });

  return plan as WorkflowDeploymentPlan;
}
