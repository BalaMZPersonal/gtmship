import type {
  ConnectionAuthStrategyStatus,
  WorkflowAccessRequirement,
  WorkflowBinding,
  WorkflowDeployAuthMode,
  WorkflowDeployAuthModeInput,
  WorkflowDeployProvider,
  WorkflowDeploySpec,
  WorkflowDeployTargetMode,
  WorkflowDeploymentPlan,
  WorkflowPlannedBinding,
  WorkflowExecutionKind,
  WorkflowStudioArtifact,
  WorkflowTriggerConfig,
  WorkflowTriggerType,
  WorkflowRuntimeAuthManifest,
} from "./types";
import { applyGlobalAuthStrategyToPlan } from "./auth-strategy";

export interface WorkflowTriggerDescriptor {
  type: WorkflowTriggerType;
  path?: string;
  cron?: string;
  event?: string;
}

export interface BuildWorkflowDeploymentPlanInput {
  workflowId: string;
  workflowTitle?: string;
  code: string;
  deploy?: WorkflowDeploySpec;
  triggerConfig?: WorkflowTriggerConfig;
  bindings?: WorkflowBinding[];
  requiredAccesses?: WorkflowAccessRequirement[];
}

export interface DeploymentDefaults {
  provider?: WorkflowDeployProvider;
  region?: string;
  gcpProject?: string;
  authStrategy?: ConnectionAuthStrategyStatus | null;
}

function resolveDeployTargetMode(
  deploy?: WorkflowDeploySpec
): WorkflowDeployTargetMode {
  if (deploy?.target === "cloud" || deploy?.target === "local") {
    return deploy.target;
  }

  return deploy?.provider === "local" ? "local" : "cloud";
}

function resolveCloudDeployProvider(
  deploy?: WorkflowDeploySpec,
  defaults: DeploymentDefaults = {}
): Exclude<WorkflowDeployProvider, "local"> {
  if (deploy?.provider === "aws" || deploy?.provider === "gcp") {
    return deploy.provider;
  }

  if (defaults.provider === "aws" || defaults.provider === "gcp") {
    return defaults.provider;
  }

  return "aws";
}

function resolveEffectiveProvider(
  deploy?: WorkflowDeploySpec,
  defaults: DeploymentDefaults = {}
): WorkflowDeployProvider {
  return resolveDeployTargetMode(deploy) === "local"
    ? "local"
    : resolveCloudDeployProvider(deploy, defaults);
}

function resolveEffectiveRegion(
  deploy: WorkflowDeploySpec | undefined,
  defaults: DeploymentDefaults,
  provider: WorkflowDeployProvider
): string {
  if (provider === "local") {
    return "local";
  }

  if (deploy?.region && deploy.region !== "local") {
    return deploy.region;
  }

  if (defaults.provider === provider && defaults.region) {
    return defaults.region;
  }

  return defaultRegion(provider);
}

function resolveEffectiveGcpProject(
  deploy: WorkflowDeploySpec | undefined,
  defaults: DeploymentDefaults,
  provider: WorkflowDeployProvider
): string | undefined {
  if (provider !== "gcp") {
    return undefined;
  }

  return deploy?.gcpProject || defaults.gcpProject;
}

function defaultRegion(provider: WorkflowDeployProvider): string {
  return provider === "gcp"
    ? "us-central1"
    : provider === "local"
      ? "local"
      : "us-east-1";
}

function normalizeTextValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeWebhookVisibility(
  value: unknown
): "public" | "private" {
  return value === "private" ? "private" : "public";
}

function normalizeWebhookPath(path?: string): string {
  if (!path) {
    return "/";
  }

  return path.startsWith("/") ? path : `/${path}`;
}

function extractString(
  source: string,
  pattern: RegExp,
  fallback: string
): string {
  const match = source.match(pattern);
  return match?.[1]?.trim() || fallback;
}

export function extractWorkflowIdFromSource(
  source: string,
  fallback: string
): string {
  return extractString(
    source,
    /defineWorkflow\(\s*\{[\s\S]*?\bid\s*:\s*["'`]([^"'`]+)["'`]/,
    fallback
  );
}

export function extractTriggerFromSource(
  source: string
): WorkflowTriggerDescriptor {
  if (source.includes("triggers.manual(")) {
    return { type: "manual" };
  }

  if (source.includes("triggers.webhook(")) {
    return {
      type: "webhook",
      path: normalizeWebhookPath(
        extractString(
          source,
          /triggers\.webhook\(\s*["'`]([^"'`]+)["'`]\s*\)/,
          "/"
        )
      ),
    };
  }

  if (source.includes("triggers.schedule(")) {
    const cronDirect = extractString(
      source,
      /triggers\.schedule\(\s*["'`]([^"'`]+)["'`]\s*\)/,
      ""
    );
    const cronFromObj = extractString(
      source,
      /triggers\.schedule\(\s*\{[^}]*cron:\s*["'`]([^"'`]+)["'`]/,
      ""
    );
    return {
      type: "schedule",
      cron: cronDirect || cronFromObj || "* * * * *",
    };
  }

  if (source.includes("triggers.event(")) {
    return {
      type: "event",
      event: extractString(
        source,
        /triggers\.event\(\s*["'`]([^"'`]+)["'`]\s*\)/,
        "custom.event"
      ),
    };
  }

  return { type: "manual" };
}

export function formatTriggerForListing(source: string): string {
  const trigger = extractTriggerFromSource(source);

  if (trigger.type === "webhook") {
    return `webhook ${trigger.path || "/"}`;
  }

  if (trigger.type === "schedule") {
    return `schedule ${trigger.cron || "* * * * *"}`;
  }

  if (trigger.type === "event") {
    return `event ${trigger.event || "custom.event"}`;
  }

  return trigger.type;
}

function inferExecutionKind(
  triggerType: WorkflowTriggerType,
  explicit?: WorkflowExecutionKind
): WorkflowExecutionKind {
  if (explicit) {
    return explicit;
  }

  if (triggerType === "schedule") {
    return "job";
  }

  return "service";
}

function inferBindings(
  bindings: WorkflowBinding[] | undefined,
  requiredAccesses: WorkflowAccessRequirement[] | undefined
): WorkflowBinding[] {
  const existing = bindings || [];
  const providerSlugs = new Set(
    (requiredAccesses || [])
      .filter((access) => access.type === "integration" && access.providerSlug)
      .map((access) => access.providerSlug as string)
  );

  for (const binding of existing) {
    providerSlugs.add(binding.providerSlug);
  }

  return Array.from(providerSlugs).map((providerSlug) => {
    const existingBinding = existing.find(
      (binding) => binding.providerSlug === providerSlug
    );

    if (existingBinding) {
      return existingBinding;
    }

    return {
      providerSlug,
      selector: { type: "latest_active" as const },
    };
  });
}

function selectorValue(binding: WorkflowBinding): string | undefined {
  return (
    binding.selector.connectionId ||
    binding.selector.label
  );
}

function normalizePlannedBindings(
  bindings: WorkflowBinding[]
): WorkflowPlannedBinding[] {
  return bindings.map((binding) => {
    const value = selectorValue(binding);
    const status =
      binding.selector.type === "latest_active"
        ? "ambiguous"
        : value
          ? "resolved"
          : "missing";

    return {
      providerSlug: binding.providerSlug,
      selector: binding.selector,
      status,
      message:
        status === "resolved"
          ? "Binding resolved from workflow metadata."
          : binding.selector.type === "latest_active"
            ? "Defaults to the latest active connection."
            : `Missing selector value for ${binding.selector.type}.`,
    };
  });
}

function buildResourcePlan(
  provider: WorkflowDeployProvider,
  triggerType: WorkflowTriggerType,
  executionKind: WorkflowExecutionKind
): string[] {
  if (provider === "local") {
    return triggerType === "schedule"
      ? ["Local Workflow Job", "Local Scheduler"]
      : ["Local Workflow Job"];
  }

  if (triggerType === "webhook") {
    if (provider === "gcp") {
      return executionKind === "service"
        ? ["Cloud Run Service"]
        : ["Cloud Run Job", "Cloud Scheduler"];
    }

    return executionKind === "service"
      ? ["Lambda Function", "API Gateway"]
      : ["ECS/Fargate Task", "API Gateway"];
  }

  if (triggerType === "schedule") {
    if (provider === "gcp") {
      return executionKind === "job"
        ? ["Cloud Run Job", "Cloud Scheduler"]
        : ["Cloud Run Service", "Cloud Scheduler"];
    }

    return executionKind === "job"
      ? ["EventBridge Scheduler", "Lambda Function"]
      : ["EventBridge Scheduler", "Lambda Function", "API Gateway"];
  }

  if (triggerType === "event") {
    if (provider === "gcp") {
      return executionKind === "job"
        ? ["Eventarc Trigger", "Workflows", "Cloud Run Job"]
        : ["Eventarc Trigger", "Cloud Run Service"];
    }

    return executionKind === "job"
      ? ["EventBridge Rule", "ECS/Fargate RunTask"]
      : ["EventBridge Rule", "Lambda Function"];
  }

  if (provider === "gcp") {
    return executionKind === "job"
      ? ["Cloud Run Job"]
      : ["Cloud Run Service"];
  }

  return executionKind === "job"
    ? ["ECS/Fargate RunTask"]
    : ["Lambda Function", "API Gateway"];
}

function bindingWarnings(bindings: WorkflowBinding[]): string[] {
  return bindings.flatMap((binding) => {
    if (binding.selector.type === "latest_active") {
      return [];
    }

    if (!selectorValue(binding)?.trim()) {
      return [
        `Binding for ${binding.providerSlug} requires a selector value for "${binding.selector.type}".`,
      ];
    }

    return [];
  });
}

function buildTriggerSummary(
  trigger: WorkflowTriggerDescriptor,
  triggerConfig: WorkflowTriggerConfig | undefined,
  executionKind: WorkflowExecutionKind
): WorkflowDeploymentPlan["trigger"] {
  if (trigger.type === "webhook") {
    const configuredPath =
      normalizeTextValue(triggerConfig?.webhook?.path) || trigger.path || "/";
    const visibility = normalizeWebhookVisibility(
      triggerConfig?.webhook?.visibility
    );
    return {
      type: "webhook",
      access: visibility,
      endpoint: normalizeWebhookPath(configuredPath),
      description: `${visibility.toUpperCase()} POST ${normalizeWebhookPath(configuredPath)}`,
    };
  }

  if (trigger.type === "schedule") {
    const cron =
      normalizeTextValue(triggerConfig?.schedule?.cron) || trigger.cron || "";
    const timezone =
      normalizeTextValue(triggerConfig?.schedule?.timezone) || "UTC";
    return {
      type: "schedule",
      cron: cron || undefined,
      timezone,
      description: cron ? `${cron} (${timezone})` : `Missing cron (${timezone})`,
    };
  }

  if (trigger.type === "event") {
    const eventName = trigger.event || "custom.event";
    const source =
      normalizeTextValue(triggerConfig?.event?.source) ||
      normalizeTextValue(triggerConfig?.event?.eventBus) ||
      normalizeTextValue(triggerConfig?.event?.queue) ||
      normalizeTextValue(triggerConfig?.event?.topic);
    return {
      type: "event",
      eventName,
      source,
      description: source ? `${eventName} from ${source}` : eventName,
    };
  }

  return {
    type: "manual",
    description:
      executionKind === "service"
        ? "Internal run endpoint"
        : "Direct job/task execution",
  };
}

function buildWarnings(input: {
  trigger: WorkflowTriggerDescriptor;
  triggerConfig?: WorkflowTriggerConfig;
  bindings: WorkflowBinding[];
  provider: WorkflowDeployProvider;
  gcpProject?: string;
  requiredAccesses?: WorkflowAccessRequirement[];
}): string[] {
  const warnings: string[] = [];

  if (
    input.trigger.type === "schedule" &&
    !normalizeTextValue(input.triggerConfig?.schedule?.cron) &&
    !input.trigger.cron
  ) {
    warnings.push(
      "Schedule trigger is missing cron configuration. Add workflow.triggerConfig.schedule.cron."
    );
  }

  if (
    input.trigger.type === "event" &&
    !normalizeTextValue(input.triggerConfig?.event?.source) &&
    !normalizeTextValue(input.triggerConfig?.event?.eventBus) &&
    !normalizeTextValue(input.triggerConfig?.event?.queue) &&
    !normalizeTextValue(input.triggerConfig?.event?.topic)
  ) {
    warnings.push(
      "Event trigger is missing source configuration. Add workflow.triggerConfig.event details."
    );
  }

  if (input.provider === "gcp" && !input.gcpProject) {
    warnings.push(
      "GCP project is not set. Configure workflow.deploy.gcpProject before deploying."
    );
  }

  if (
    input.provider === "local" &&
    input.trigger.type !== "manual" &&
    input.trigger.type !== "schedule"
  ) {
    warnings.push(
      "Local deployments currently support only manual and schedule triggers."
    );
  }

  const integrationAccessCount = (input.requiredAccesses || []).filter(
    (access) => access.type === "integration"
  ).length;

  if (integrationAccessCount > 0 && input.bindings.length === 0) {
    warnings.push(
      "No connection bindings found for integration accesses. Defaults to latest active connections."
    );
  }

  warnings.push(...bindingWarnings(input.bindings));

  return warnings;
}

function normalizeAuthMode(mode?: WorkflowDeployAuthModeInput): {
  mode: WorkflowDeployAuthMode;
  legacyModeAliasUsed: boolean;
} {
  if (mode === "secret_manager") {
    return { mode: "secret_manager", legacyModeAliasUsed: false };
  }

  if (mode === "synced_secrets") {
    return { mode: "secret_manager", legacyModeAliasUsed: true };
  }

  return { mode: "proxy", legacyModeAliasUsed: false };
}

function buildAuthManifest(
  authMode: WorkflowDeployAuthMode,
  bindings: WorkflowPlannedBinding[],
  secretPrefix?: string
): WorkflowRuntimeAuthManifest | undefined {
  if (authMode !== "secret_manager") {
    return undefined;
  }

  return {
    version: "1",
    generatedAt: new Date().toISOString(),
    providers: bindings.map((binding) => ({
      providerSlug: binding.providerSlug,
      connectionId: binding.resolvedConnectionId,
      secretRef: binding.resolvedConnectionId
        ? `${secretPrefix || "gtmship-connections"}/${binding.providerSlug}/${binding.resolvedConnectionId}/runtime`
        : undefined,
    })),
  };
}

export function buildWorkflowDeploymentPlan(
  input: BuildWorkflowDeploymentPlanInput,
  defaults: DeploymentDefaults = {}
): WorkflowDeploymentPlan {
  const trigger = extractTriggerFromSource(input.code);
  const provider = resolveEffectiveProvider(input.deploy, defaults);
  const region = resolveEffectiveRegion(input.deploy, defaults, provider);
  const gcpProject = resolveEffectiveGcpProject(input.deploy, defaults, provider);
  const explicitExecutionKind = input.deploy?.execution?.kind;
  const executionKind =
    provider === "local"
      ? "job"
      : inferExecutionKind(trigger.type, explicitExecutionKind);
  const normalizedAuth =
    provider === "local"
      ? { mode: "proxy" as const, legacyModeAliasUsed: false }
      : normalizeAuthMode(input.deploy?.auth?.mode || "proxy");
  const authMode = normalizedAuth.mode;
  const bindings = inferBindings(input.bindings, input.requiredAccesses);
  const plannedBindings = normalizePlannedBindings(bindings);
  const auth =
    authMode === "secret_manager"
      ? {
          mode: authMode,
          backend: input.deploy?.auth?.backend,
          runtimeAccess: input.deploy?.auth?.runtimeAccess || "direct",
          manifest: buildAuthManifest(
            authMode,
            plannedBindings,
            input.deploy?.auth?.backend?.secretPrefix
          ),
          legacyModeAliasUsed: normalizedAuth.legacyModeAliasUsed,
        }
      : {
          mode: authMode,
          legacyModeAliasUsed: normalizedAuth.legacyModeAliasUsed,
        };
  const warnings = buildWarnings({
    trigger,
    triggerConfig: input.triggerConfig,
    bindings,
    provider,
    gcpProject,
    requiredAccesses: input.requiredAccesses,
  });

  if (normalizedAuth.legacyModeAliasUsed) {
    warnings.push(
      "deploy.auth.mode=synced_secrets is deprecated. Use secret_manager."
    );
  }

  if (authMode === "secret_manager" && !input.deploy?.auth?.backend?.kind) {
    warnings.push(
      "secret_manager auth requires deploy.auth.backend.kind (aws_secrets_manager or gcp_secret_manager)."
    );
  }

  if (provider === "local" && explicitExecutionKind && explicitExecutionKind !== "job") {
    warnings.push(
      "Local deployments only support job execution. GTMShip will deploy this workflow as a local job."
    );
  }

  if (provider === "local" && input.deploy?.auth?.mode && input.deploy.auth.mode !== "proxy") {
    warnings.push(
      "Local deployments always use proxy auth through the local GTMShip auth service."
    );
  }

  return applyGlobalAuthStrategyToPlan({
    workflowId: input.workflowId,
    workflowName: input.workflowTitle,
    trigger: buildTriggerSummary(trigger, input.triggerConfig, executionKind),
    executionKind,
    executionSource: explicitExecutionKind ? "explicit" : "default",
    provider,
    region,
    gcpProject,
    authMode,
    auth,
    resources: buildResourcePlan(provider, trigger.type, executionKind).map(
      (resource, index) => ({
        kind: resource,
        name: `${input.workflowId}-${index + 1}`,
        description: resource,
      })
    ),
    bindings: plannedBindings,
    warnings,
  }, defaults.authStrategy);
}

export function buildWorkflowPlanFromArtifact(
  artifact: WorkflowStudioArtifact,
  defaults: DeploymentDefaults = {}
): WorkflowDeploymentPlan {
  return buildWorkflowDeploymentPlan(
    {
      workflowId: extractWorkflowIdFromSource(artifact.code, artifact.slug),
      workflowTitle: artifact.title,
      code: artifact.code,
      deploy: artifact.deploy,
      triggerConfig: artifact.triggerConfig,
      bindings: artifact.bindings,
      requiredAccesses: artifact.requiredAccesses,
    },
    defaults
  );
}
