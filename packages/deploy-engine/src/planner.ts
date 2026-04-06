import {
  buildTriggerInfo,
  type TriggerConfig,
} from "./triggers.js";

export type { TriggerConfig } from "./triggers.js";

export type WorkflowCloudProvider = "aws" | "gcp" | "local";
export type WorkflowExecutionKind = "service" | "job";
export type WorkflowDeployAuthMode = "proxy" | "secret_manager";
export type LegacyWorkflowDeployAuthMode = "synced_secrets";
export type WorkflowDeployAuthModeInput =
  | WorkflowDeployAuthMode
  | LegacyWorkflowDeployAuthMode;
export type WorkflowSecretBackendKind =
  | "aws_secrets_manager"
  | "gcp_secret_manager";
export type WorkflowSecretRuntimeAccessMode = "direct" | "local_cache";
export type WorkflowBindingSelectorType =
  | "latest_active"
  | "connection_id"
  | "label";

export interface WorkflowExecutionConfig {
  kind?: WorkflowExecutionKind;
  timeoutSeconds?: number;
  memory?: number | string;
  cpu?: number | string;
}

export interface WorkflowDeployAuthConfig {
  mode?: WorkflowDeployAuthModeInput;
  backend?: {
    kind?: WorkflowSecretBackendKind;
    region?: string;
    projectId?: string;
    secretPrefix?: string;
  };
  runtimeAccess?: WorkflowSecretRuntimeAccessMode;
  manifest?: WorkflowRuntimeAuthManifest;
}

export interface DeployTarget {
  provider?: WorkflowCloudProvider;
  region?: string;
  gcpProject?: string;
  execution?: WorkflowExecutionConfig;
  timeoutSeconds?: number;
  memory?: number | string;
  cpu?: number | string;
  auth?: WorkflowDeployAuthConfig;
}

export type WorkflowDeployTarget = DeployTarget;

export interface WorkflowScheduleTriggerConfiguration {
  cron?: string;
  timezone?: string;
  payload?: unknown;
}

export interface WorkflowWebhookTriggerConfiguration {
  path?: string;
  access?: "public" | "private";
  signature?: {
    header?: string;
    secretRef?: string;
  };
}

export interface WorkflowEventTriggerConfiguration {
  event?: string;
  source?: string;
  bus?: string;
  topic?: string;
  subscription?: string;
  async?: boolean;
  payload?: unknown;
}

export interface WorkflowTriggerConfiguration {
  schedule?: WorkflowScheduleTriggerConfiguration;
  webhook?: WorkflowWebhookTriggerConfiguration;
  event?: WorkflowEventTriggerConfiguration;
}

export interface WorkflowBindingSelector {
  type: WorkflowBindingSelectorType;
  value?: string;
  connectionId?: string;
  label?: string;
}

export interface WorkflowBinding {
  providerSlug: string;
  selector: WorkflowBindingSelector;
}

export interface WorkflowRuntimeAuthManifestProvider {
  providerSlug: string;
  connectionId?: string;
  secretRef?: string;
  authType?: "oauth2" | "api_key" | "basic";
  headerName?: string;
}

export interface WorkflowRuntimeAuthManifest {
  version: string;
  generatedAt: string;
  providers: WorkflowRuntimeAuthManifestProvider[];
}

export interface WorkflowPlannedAuth {
  mode: WorkflowDeployAuthMode;
  backend?: {
    kind?: WorkflowSecretBackendKind;
    region?: string;
    projectId?: string;
    secretPrefix?: string;
  };
  runtimeAccess?: WorkflowSecretRuntimeAccessMode;
  manifest?: WorkflowRuntimeAuthManifest;
  legacyModeAliasUsed?: boolean;
}

export interface PlannerConnectionRecord {
  id: string;
  label?: string | null;
  status: string;
  createdAt?: string;
  provider: {
    slug: string;
    name?: string;
  };
}

export interface WorkflowBindingPlan {
  providerSlug: string;
  selector: WorkflowBindingSelector;
  status: "resolved" | "missing" | "ambiguous";
  message: string;
  resolvedConnectionId?: string;
  resolvedConnectionLabel?: string | null;
}

export interface PlannedTriggerSummary {
  type: TriggerConfig["type"];
  description: string;
  endpoint?: string;
  cron?: string;
  timezone?: string;
  nextRunTime?: string;
  eventName?: string;
  source?: string;
  access?: "public" | "private";
}

export interface PlannedResource {
  kind: string;
  name: string;
  description: string;
  summary: string;
}

export interface WorkflowDeploymentPlan {
  workflowId: string;
  workflowName?: string;
  provider: WorkflowCloudProvider;
  region: string;
  gcpProject?: string;
  trigger: PlannedTriggerSummary;
  triggerType: TriggerConfig["type"];
  triggerInfo: {
    webhookUrl?: string;
    cronExpression?: string;
    timezone?: string;
    nextRunTime?: Date;
    eventName?: string;
    source?: string;
  };
  triggerSummary: string;
  executionKind: WorkflowExecutionKind;
  executionSource: "explicit" | "default";
  authMode: WorkflowDeployAuthMode;
  auth: WorkflowPlannedAuth;
  resources: PlannedResource[];
  bindings: WorkflowBindingPlan[];
  authBindings: Array<{
    providerSlug: string;
    selectorType: WorkflowBindingSelectorType;
    value?: string;
    resolvedConnectionId?: string;
    warning?: string;
  }>;
  heavyExecution: boolean;
  memory?: string;
  cpu?: string;
  warnings: string[];
}

export interface WorkflowPlanInput {
  workflowId: string;
  workflowName?: string;
  trigger: TriggerConfig;
  deploy?: DeployTarget;
  triggerConfig?: WorkflowTriggerConfiguration;
  bindings?: WorkflowBinding[];
  requiredProviders?: string[];
  providerOverride?: WorkflowCloudProvider;
  regionOverride?: string;
  gcpProjectOverride?: string;
  baseUrl?: string;
  connections?: PlannerConnectionRecord[];
}

export interface SharedWorkflowDeploymentPlanInput {
  workflowId: string;
  workflowTitle?: string;
  code?: string;
  trigger?: TriggerConfig;
  deploy?: DeployTarget;
  triggerConfig?: WorkflowTriggerConfiguration;
  bindings?: WorkflowBinding[];
  integrationProviders?: string[];
  requiredAccesses?: Array<{
    type?: string;
    providerSlug?: string;
  }>;
  provider?: WorkflowCloudProvider;
  defaultProvider?: WorkflowCloudProvider;
  region?: string;
  defaultRegion?: string;
  gcpProject?: string;
  defaultGcpProject?: string;
  baseUrl?: string;
  connections?: PlannerConnectionRecord[];
  activeConnections?: Array<{
    id: string;
    label?: string | null;
    providerSlug: string;
    status: string;
  }>;
}

function resource(
  kind: string,
  name: string,
  description: string
): PlannedResource {
  return { kind, name, description, summary: kind };
}

function unique(values: Array<string | undefined | null>): string[] {
  return Array.from(new Set(values.filter(Boolean) as string[]));
}

export function extractTriggerFromSource(source: string): TriggerConfig {
  const webhookMatch = source.match(/triggers\.webhook\(\s*["'`]([^"'`]+)["'`]\s*\)/);
  if (webhookMatch) {
    const path = webhookMatch[1];
    return {
      type: "webhook",
      path: path.startsWith("/") ? path : `/${path}`,
    };
  }

  const scheduleMatch = source.match(/triggers\.schedule\(\s*["'`]([^"'`]+)["'`]\s*\)/);
  if (scheduleMatch) {
    return {
      type: "schedule",
      cron: scheduleMatch[1],
    };
  }

  const scheduleObjMatch = source.match(/triggers\.schedule\(\s*\{[^}]*cron:\s*["'`]([^"'`]+)["'`]/);
  if (scheduleObjMatch) {
    return {
      type: "schedule",
      cron: scheduleObjMatch[1],
    };
  }

  const eventMatch = source.match(/triggers\.event\(\s*["'`]([^"'`]+)["'`]\s*\)/);
  if (eventMatch) {
    return {
      type: "event",
      event: eventMatch[1],
    };
  }

  return /triggers\.manual\(\s*\)/.test(source)
    ? { type: "manual" }
    : { type: "manual" };
}

function defaultRegion(provider: WorkflowCloudProvider): string {
  if (provider === "gcp") {
    return "us-central1";
  }

  if (provider === "local") {
    return "local";
  }

  return "us-east-1";
}

function parseNumeric(value?: number | string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const match = String(value).match(/[\d.]+/);
  if (!match) {
    return undefined;
  }

  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeMemoryString(
  value?: number | string
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return `${value}Mi`;
  if (/^\d+$/.test(value)) return `${value}Mi`;
  return value;
}

function normalizeCpuString(
  value?: number | string
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return String(value);
}

function parseMemoryToMi(value?: string | number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return value;

  const giMatch = value.match(/^([\d.]+)\s*Gi$/i);
  if (giMatch) return Math.round(parseFloat(giMatch[1]) * 1024);

  const miMatch = value.match(/^([\d.]+)\s*Mi$/i);
  if (miMatch) return Math.round(parseFloat(miMatch[1]));

  const num = parseFloat(value);
  return Number.isFinite(num) ? num : undefined;
}

function normalizeAuthMode(
  mode?: WorkflowDeployAuthModeInput
): {
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

function normalizeAuthConfig(
  auth?: WorkflowDeployAuthConfig
): WorkflowPlannedAuth {
  const normalized = normalizeAuthMode(auth?.mode);
  const hasBackendHints = Boolean(
    auth?.backend?.kind ||
      auth?.backend?.region ||
      auth?.backend?.projectId ||
      auth?.backend?.secretPrefix ||
      auth?.runtimeAccess
  );
  const mode =
    normalized.mode === "proxy" && hasBackendHints
      ? "secret_manager"
      : normalized.mode;

  return {
    mode,
    backend: auth?.backend,
    runtimeAccess:
      auth?.runtimeAccess || (mode === "secret_manager" ? "direct" : undefined),
    legacyModeAliasUsed: normalized.legacyModeAliasUsed,
  };
}

function isHeavyExecution(deploy?: DeployTarget): boolean {
  const timeout =
    deploy?.execution?.timeoutSeconds ?? deploy?.timeoutSeconds ?? 0;
  const memory = parseNumeric(deploy?.execution?.memory ?? deploy?.memory) ?? 0;
  const cpu = parseNumeric(deploy?.execution?.cpu ?? deploy?.cpu) ?? 0;

  return timeout > 900 || memory > 10240 || cpu > 2;
}

function normalizeBindingSelector(
  selector?: WorkflowBindingSelector
): WorkflowBindingSelector {
  if (!selector) {
    return { type: "latest_active" };
  }

  if (selector.type === "connection_id" && !selector.connectionId && selector.value) {
    return {
      ...selector,
      connectionId: selector.value,
    };
  }

  if (selector.type === "label" && !selector.label && selector.value) {
    return {
      ...selector,
      label: selector.value,
    };
  }

  return selector;
}

function describeSelector(selector: WorkflowBindingSelector): string {
  switch (selector.type) {
    case "connection_id":
      return selector.connectionId
        ? `connection ${selector.connectionId}`
        : "connection id";
    case "label":
      return selector.label ? `label "${selector.label}"` : "label";
    case "latest_active":
    default:
      return "latest active connection";
  }
}

function sortConnections(
  connections: PlannerConnectionRecord[]
): PlannerConnectionRecord[] {
  return [...connections].sort((left, right) => {
    const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
    const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;
    return rightTime - leftTime;
  });
}

function resolveBinding(
  providerSlug: string,
  selector: WorkflowBindingSelector,
  connections: PlannerConnectionRecord[]
): WorkflowBindingPlan {
  const candidates = sortConnections(
    connections.filter(
      (connection) =>
        connection.status === "active" && connection.provider.slug === providerSlug
    )
  );

  if (selector.type === "connection_id") {
    const match = candidates.find(
      (connection) => connection.id === selector.connectionId
    );

    if (!match) {
      return {
        providerSlug,
        selector,
        status: "missing",
        message: selector.connectionId
          ? `No active ${providerSlug} connection matches ${selector.connectionId}.`
          : `A connection id is required to bind ${providerSlug}.`,
      };
    }

    return {
      providerSlug,
      selector,
      status: "resolved",
      message: `Pinned to ${match.label || match.id}.`,
      resolvedConnectionId: match.id,
      resolvedConnectionLabel: match.label,
    };
  }

  if (selector.type === "label") {
    const matches = candidates.filter(
      (connection) => connection.label === selector.label
    );

    if (!selector.label) {
      return {
        providerSlug,
        selector,
        status: "missing",
        message: `A label is required to bind ${providerSlug}.`,
      };
    }

    if (matches.length === 0) {
      return {
        providerSlug,
        selector,
        status: "missing",
        message: `No active ${providerSlug} connection matches label "${selector.label}".`,
      };
    }

    if (matches.length > 1) {
      return {
        providerSlug,
        selector,
        status: "ambiguous",
        message: `Multiple active ${providerSlug} connections use label "${selector.label}".`,
      };
    }

    return {
      providerSlug,
      selector,
      status: "resolved",
      message: `Resolved label "${selector.label}" to ${matches[0].id}.`,
      resolvedConnectionId: matches[0].id,
      resolvedConnectionLabel: matches[0].label,
    };
  }

  if (candidates.length === 0) {
    return {
      providerSlug,
      selector,
      status: "missing",
      message: `No active ${providerSlug} connection is available.`,
    };
  }

  if (candidates.length > 1) {
    return {
      providerSlug,
      selector,
      status: "ambiguous",
      message: `Multiple active ${providerSlug} connections are available. Latest active will be used unless you pin one.`,
      resolvedConnectionId: candidates[0].id,
      resolvedConnectionLabel: candidates[0].label,
    };
  }

  return {
    providerSlug,
    selector,
    status: "resolved",
    message: `Using active connection ${candidates[0].label || candidates[0].id}.`,
    resolvedConnectionId: candidates[0].id,
    resolvedConnectionLabel: candidates[0].label,
  };
}

function buildSecretRef(
  providerSlug: string,
  connectionId: string,
  auth: WorkflowPlannedAuth
): string {
  const prefix = auth.backend?.secretPrefix || "gtmship-connections";
  if (auth.backend?.kind === "gcp_secret_manager") {
    const secretId = `${prefix}-${providerSlug}-${connectionId}`
      .replace(/[^a-zA-Z0-9-_]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
    const runtimeSecretId = `${secretId}-runtime`;
    return auth.backend.projectId
      ? `projects/${auth.backend.projectId}/secrets/${runtimeSecretId}`
      : runtimeSecretId;
  }

  return `${prefix}/${providerSlug}/${connectionId}/runtime`;
}

function buildRuntimeAuthManifest(
  auth: WorkflowPlannedAuth,
  bindings: WorkflowBindingPlan[]
): WorkflowRuntimeAuthManifest | undefined {
  if (auth.mode !== "secret_manager") {
    return undefined;
  }

  const providers = bindings.map((binding) => ({
    providerSlug: binding.providerSlug,
    connectionId: binding.resolvedConnectionId,
    secretRef: binding.resolvedConnectionId
      ? buildSecretRef(binding.providerSlug, binding.resolvedConnectionId, auth)
      : undefined,
  }));

  return {
    version: "1",
    generatedAt: new Date().toISOString(),
    providers,
  };
}

export function getDefaultExecutionKind(
  triggerType: TriggerConfig["type"]
): WorkflowExecutionKind {
  switch (triggerType) {
    case "schedule":
    case "manual":
      return "job";
    case "webhook":
    case "event":
    default:
      return "service";
  }
}

function buildTriggerSummary(
  input: WorkflowPlanInput
): PlannedTriggerSummary {
  const trigger = input.trigger;
  const config = input.triggerConfig;

  switch (trigger.type) {
    case "webhook": {
      const path = config?.webhook?.path || trigger.path || `/${input.workflowId}`;
      const access = config?.webhook?.access || "public";
      const triggerInfo = input.baseUrl
        ? buildTriggerInfo({ type: "webhook", path }, input.workflowId, input.baseUrl)
        : undefined;

      return {
        type: "webhook",
        access,
        endpoint: triggerInfo?.webhookUrl || path,
        description:
          access === "private"
            ? `Private webhook at ${path}`
            : `Public webhook at ${path}`,
      };
    }
    case "schedule": {
      const cron = config?.schedule?.cron || trigger.cron;
      const timezone = config?.schedule?.timezone || "UTC";
      const triggerInfo =
        cron && input.baseUrl
          ? buildTriggerInfo({ type: "schedule", cron }, input.workflowId, input.baseUrl)
          : undefined;

      return {
        type: "schedule",
        cron,
        timezone,
        nextRunTime: triggerInfo?.nextRunTime?.toISOString(),
        description: cron
          ? `Cron ${cron} (${timezone})`
          : "Schedule trigger requires a cron expression.",
      };
    }
    case "event": {
      const eventName = config?.event?.event || trigger.event;
      const source =
        config?.event?.source ||
        config?.event?.topic ||
        config?.event?.subscription ||
        config?.event?.bus;

      return {
        type: "event",
        eventName,
        source,
        description: eventName
          ? `Event ${eventName}${source ? ` from ${source}` : ""}`
          : "Event trigger",
      };
    }
    case "manual":
    default:
      return {
        type: "manual",
        description: "Manual run from GTMShip.",
      };
  }
}

function buildResourcePlan(
  workflowId: string,
  provider: WorkflowCloudProvider,
  triggerType: TriggerConfig["type"],
  executionKind: WorkflowExecutionKind,
  heavy: boolean
): PlannedResource[] {
  const resources: PlannedResource[] = [];

  if (provider === "local") {
    resources.push(
      resource(
        "Local Workflow Job",
        `${workflowId}-local-job`,
        "Runs the workflow directly on the current machine."
      )
    );

    if (triggerType === "schedule") {
      resources.push(
        resource(
          process.platform === "darwin"
            ? "LaunchAgent Scheduler"
            : process.platform === "linux"
              ? "systemd Timer"
              : "Local Scheduler",
          `${workflowId}-local-schedule`,
          "Triggers the workflow on the local machine schedule."
        )
      );
    }

    return resources;
  }

  if (triggerType === "webhook") {
    if (provider === "gcp") {
      if (executionKind === "job") {
        resources.push(
          resource(
            "Cloud Run Service",
            `${workflowId}-webhook`,
            "Receives webhook traffic and hands off to the job runtime."
          ),
          resource(
            "Cloud Run Job",
            `${workflowId}-job`,
            "Runs the webhook workload asynchronously."
          )
        );
        return resources;
      }

      resources.push(
        resource(
          "Cloud Run Service",
          `${workflowId}-service`,
          "Serves webhook requests and manual run invocations."
        )
      );
      return resources;
    }

    resources.push(
      resource(
        "API Gateway",
        `${workflowId}-http`,
        "Receives webhook requests."
      )
    );

    if (executionKind === "job" && heavy) {
      resources.push(
        resource(
          "Lambda Function",
          `${workflowId}-bridge`,
          "Transforms the webhook into an asynchronous task dispatch."
        ),
        resource(
          "ECS/Fargate Task",
          `${workflowId}-task`,
          "Runs the heavy webhook workload."
        )
      );
      return resources;
    }

    resources.push(
      resource(
        "Lambda Function",
        `${workflowId}-lambda`,
        executionKind === "job"
          ? "Runs the webhook workload asynchronously."
          : "Handles webhook and manual invocations."
      )
    );
    return resources;
  }

  if (triggerType === "schedule") {
    if (provider === "gcp") {
      resources.push(
        resource(
          executionKind === "job" ? "Cloud Run Job" : "Cloud Run Service",
          executionKind === "job" ? `${workflowId}-job` : `${workflowId}-service`,
          executionKind === "job"
            ? "Executes scheduled workflow runs."
            : "Receives scheduled workflow invocations."
        ),
        resource(
          "Cloud Scheduler",
          `${workflowId}-schedule`,
          "Triggers the workflow on the configured cron."
        )
      );
      return resources;
    }

    resources.push(
      resource(
        "EventBridge Scheduler",
        `${workflowId}-schedule`,
        "Triggers the workflow on the configured cron."
      )
    );

    if (executionKind === "job" && heavy) {
      resources.push(
        resource(
          "ECS/Fargate Task",
          `${workflowId}-task`,
          "Runs the heavy scheduled workload."
        )
      );
      return resources;
    }

    resources.push(
      resource(
        "Lambda Function",
        `${workflowId}-lambda`,
        executionKind === "job"
          ? "Runs the scheduled workflow."
          : "Receives scheduled workflow invocations."
      )
    );
    return resources;
  }

  if (triggerType === "event") {
    if (provider === "gcp") {
      if (executionKind === "job") {
        resources.push(
          resource(
            "Eventarc",
            `${workflowId}-eventarc`,
            "Receives provider events."
          ),
          resource(
            "Workflows",
            `${workflowId}-workflow`,
            "Bridges event delivery into the job runtime."
          ),
          resource(
            "Cloud Run Job",
            `${workflowId}-job`,
            "Runs heavy event processing."
          )
        );
        return resources;
      }

      resources.push(
        resource(
          "Eventarc",
          `${workflowId}-eventarc`,
          "Receives provider events."
        ),
        resource(
          "Cloud Run Service",
          `${workflowId}-service`,
          "Processes event traffic."
        )
      );
      return resources;
    }

    resources.push(
      resource(
        "EventBridge",
        `${workflowId}-events`,
        "Receives provider events."
      )
    );

    if (executionKind === "job" || heavy) {
      resources.push(
        resource(
          "ECS/Fargate Task",
          `${workflowId}-task`,
          "Runs heavy event processing."
        )
      );
      return resources;
    }

    resources.push(
      resource(
        "Lambda Function",
        `${workflowId}-lambda`,
        "Processes event traffic."
      )
    );
    return resources;
  }

  if (provider === "gcp") {
    resources.push(
      resource(
        executionKind === "job" ? "Cloud Run Job" : "Cloud Run Service",
        executionKind === "job" ? `${workflowId}-job` : `${workflowId}-service`,
        executionKind === "job"
          ? "Runs manual workflow executions."
          : "Handles manual workflow executions."
      )
    );
    return resources;
  }

  resources.push(
    resource(
      executionKind === "job" && heavy ? "ECS/Fargate Task" : "Lambda Function",
      executionKind === "job" && heavy ? `${workflowId}-task` : `${workflowId}-lambda`,
      executionKind === "job"
        ? "Runs manual workflow executions."
        : "Handles manual workflow executions."
    )
  );
  return resources;
}

export function planWorkflowDeployment(
  input: WorkflowPlanInput
): WorkflowDeploymentPlan {
  const provider =
    input.providerOverride || input.deploy?.provider || "aws";
  const region =
    input.regionOverride || input.deploy?.region || defaultRegion(provider);
  const gcpProject = input.gcpProjectOverride || input.deploy?.gcpProject;
  const trigger = buildTriggerSummary(input);
  const explicitExecutionKind = input.deploy?.execution?.kind;
  const executionKind =
    provider === "local"
      ? "job"
      : explicitExecutionKind || getDefaultExecutionKind(input.trigger.type);
  const executionSource = explicitExecutionKind ? "explicit" : "default";
  const normalizedAuth = normalizeAuthConfig(input.deploy?.auth);
  const auth: WorkflowPlannedAuth =
    provider === "local"
      ? {
          mode: "proxy",
        }
      : normalizedAuth.mode === "secret_manager"
      ? {
          ...normalizedAuth,
          backend: {
            ...normalizedAuth.backend,
            region:
              normalizedAuth.backend?.kind === "aws_secrets_manager"
                ? normalizedAuth.backend?.region || region
                : normalizedAuth.backend?.region,
            projectId:
              normalizedAuth.backend?.kind === "gcp_secret_manager"
                ? normalizedAuth.backend?.projectId || gcpProject
                : normalizedAuth.backend?.projectId,
          },
        }
      : normalizedAuth;
  const authMode = auth.mode;
  const heavy = isHeavyExecution(input.deploy);
  const resolvedMemory = normalizeMemoryString(
    input.deploy?.execution?.memory ?? input.deploy?.memory
  );
  const resolvedCpu = normalizeCpuString(
    input.deploy?.execution?.cpu ?? input.deploy?.cpu
  );
  const warnings: string[] = [];

  if (provider === "gcp" && !gcpProject) {
    warnings.push("GCP deployments require a gcpProject value before deploy.");
  }

  if (provider === "local" && explicitExecutionKind && explicitExecutionKind !== "job") {
    warnings.push(
      "Local deployments only support job execution. GTMShip will deploy this workflow as a local job."
    );
  }

  if (
    provider === "local" &&
    normalizedAuth.mode === "secret_manager"
  ) {
    warnings.push(
      "Local deployments always use proxy auth through the local GTMShip auth service. secret_manager auth is ignored."
    );
  }

  if (
    provider === "local" &&
    (input.trigger.type === "webhook" || input.trigger.type === "event")
  ) {
    warnings.push(
      "Local deployments currently support only manual and schedule triggers."
    );
  }

  if (input.trigger.type === "manual" && !explicitExecutionKind) {
    warnings.push(
      "Manual workflows default to job execution. Set deploy.execution.kind explicitly to override."
    );
  }

  if (input.trigger.type === "event" && !explicitExecutionKind) {
    warnings.push(
      "Event workflows default to service execution. Set deploy.execution.kind=job for heavy async processing."
    );
  }

  if (input.trigger.type === "event" && !trigger.source) {
    warnings.push(
      "Event triggers need triggerConfig.event.source (or topic/bus/subscription) before infrastructure can be provisioned."
    );
  }

  if (input.trigger.type === "schedule" && !trigger.cron) {
    warnings.push(
      "Schedule triggers need a cron expression. The planner could not infer one."
    );
  }

  if (input.trigger.type === "webhook" && executionKind === "job") {
    warnings.push(
      "Webhook triggers default to service execution. A job override requires an ingress bridge before the job runtime."
    );
  }

  if (input.trigger.type === "schedule" && executionKind === "service") {
    warnings.push(
      "Schedule triggers default to job execution. A service override will run through a scheduled HTTP/event invocation path."
    );
  }

  if (auth.legacyModeAliasUsed) {
    warnings.push(
      "deploy.auth.mode=synced_secrets is deprecated. Use deploy.auth.mode=secret_manager instead."
    );
  }

  if (authMode === "secret_manager" && !auth.backend?.kind) {
    warnings.push(
      "secret_manager auth requires deploy.auth.backend.kind (aws_secrets_manager or gcp_secret_manager)."
    );
  }

  if (
    authMode === "secret_manager" &&
    auth.backend?.kind === "aws_secrets_manager" &&
    !auth.backend.region
  ) {
    warnings.push(
      "AWS secret-manager auth should set deploy.auth.backend.region to avoid region mismatch."
    );
  }

  if (
    authMode === "secret_manager" &&
    auth.backend?.kind === "gcp_secret_manager" &&
    !auth.backend.projectId &&
    !gcpProject
  ) {
    warnings.push(
      "GCP secret-manager auth should set deploy.auth.backend.projectId or workflow deploy gcpProject."
    );
  }

  const providerSet = unique([
    ...(input.requiredProviders || []),
    ...(input.bindings || []).map((binding) => binding.providerSlug),
  ]);

  const bindings = providerSet.map((providerSlug) => {
    const configuredBinding = input.bindings?.find(
      (binding) => binding.providerSlug === providerSlug
    );
    const resolved = resolveBinding(
      providerSlug,
      normalizeBindingSelector(configuredBinding?.selector),
      input.connections || []
    );

    if (resolved.status !== "resolved") {
      warnings.push(resolved.message);
    }

    return resolved;
  });
  const manifest = buildRuntimeAuthManifest(auth, bindings);

  if (
    authMode === "secret_manager" &&
    manifest?.providers.some((provider) => !provider.connectionId)
  ) {
    warnings.push(
      "secret_manager auth requires deterministic connection bindings. Resolve missing/ambiguous bindings before deploy."
    );
  }

  return {
    workflowId: input.workflowId,
    workflowName: input.workflowName,
    provider,
    region,
    gcpProject,
    trigger,
    triggerType: input.trigger.type,
    triggerInfo: {
      webhookUrl: trigger.endpoint,
      cronExpression: trigger.cron,
      timezone: trigger.timezone,
      nextRunTime: trigger.nextRunTime
        ? new Date(trigger.nextRunTime)
        : undefined,
      eventName: trigger.eventName,
      source: trigger.source,
    },
    triggerSummary: trigger.description,
    executionKind,
    executionSource,
    authMode,
    auth: {
      ...auth,
      manifest,
    },
    resources: buildResourcePlan(
      input.workflowId,
      provider,
      input.trigger.type,
      executionKind,
      heavy
    ),
    bindings,
    authBindings: bindings.map((binding) => ({
      providerSlug: binding.providerSlug,
      selectorType: binding.selector.type,
      value:
        binding.selector.type === "connection_id"
          ? binding.selector.connectionId
          : binding.selector.type === "label"
            ? binding.selector.label
            : undefined,
      resolvedConnectionId: binding.resolvedConnectionId,
      warning: binding.status === "resolved" ? undefined : binding.message,
    })),
    heavyExecution: heavy,
    memory: resolvedMemory,
    cpu: resolvedCpu,
    warnings,
  };
}

export function planWorkflowDeployments(
  inputs: WorkflowPlanInput[]
): WorkflowDeploymentPlan[] {
  return inputs.map((input) => planWorkflowDeployment(input));
}

export function buildWorkflowDeploymentPlan(
  input: SharedWorkflowDeploymentPlanInput
): {
  workflowId: string;
  workflowTitle?: string;
  triggerType: TriggerConfig["type"];
  executionKind: WorkflowExecutionKind;
  provider: WorkflowCloudProvider;
  region: string;
  gcpProject?: string;
  authMode: WorkflowDeployAuthMode;
  auth: WorkflowPlannedAuth;
  resources: string[];
  summary: {
    trigger: string;
    execution: string;
    endpoint?: string;
    schedule?: string;
    event?: string;
  };
  bindings: WorkflowBinding[];
  warnings: string[];
} {
  const requiredProviders = unique(
    [
      ...(input.integrationProviders || []),
      ...(input.requiredAccesses || [])
        .filter((access) => access.type === "integration")
        .map((access) => access.providerSlug),
    ]
  );

  const inferredBindings =
    requiredProviders.length === 0
      ? input.bindings || []
      : requiredProviders.map((providerSlug) => {
          const existing = input.bindings?.find(
            (binding) => binding.providerSlug === providerSlug
          );
          return existing || {
            providerSlug,
            selector: {
              type: "latest_active" as const,
            },
          };
        });

  const connections =
    input.connections ||
    (input.activeConnections || []).map((connection) => ({
      id: connection.id,
      label: connection.label,
      status: connection.status,
      provider: {
        slug: connection.providerSlug,
      },
    }));

  const plan = planWorkflowDeployment({
    workflowId: input.workflowId,
    workflowName: input.workflowTitle,
    trigger: input.trigger || extractTriggerFromSource(input.code || ""),
    deploy: input.deploy,
    triggerConfig: input.triggerConfig,
    bindings: inferredBindings,
    requiredProviders,
    providerOverride: input.provider || input.defaultProvider,
    regionOverride: input.region || input.defaultRegion,
    gcpProjectOverride: input.gcpProject || input.defaultGcpProject,
    baseUrl: input.baseUrl,
    connections,
  });

  return {
    workflowId: plan.workflowId,
    workflowTitle: plan.workflowName,
    triggerType: plan.trigger.type,
    executionKind: plan.executionKind,
    provider: plan.provider,
    region: plan.region,
    gcpProject: plan.gcpProject,
    authMode: plan.authMode,
    auth: plan.auth,
    resources: plan.resources.map((resource) => resource.kind),
    summary: {
      trigger:
        plan.trigger.type === "manual"
          ? "Manual"
          : plan.trigger.type === "webhook"
            ? "Webhook"
            : plan.trigger.type === "schedule"
              ? "Schedule"
              : "Event",
      execution: plan.executionKind,
      endpoint: plan.trigger.endpoint,
      schedule: plan.trigger.cron
        ? `${plan.trigger.cron}${
            plan.trigger.timezone ? ` (${plan.trigger.timezone})` : ""
          }`
        : undefined,
      event: plan.trigger.eventName
        ? plan.trigger.source
          ? `${plan.trigger.eventName} from ${plan.trigger.source}`
          : plan.trigger.eventName
        : undefined,
    },
    bindings: inferredBindings,
    warnings: plan.warnings,
  };
}

// ---------------------------------------------------------------------------
// GCP resource constraint validation
// ---------------------------------------------------------------------------

export interface GcpValidationError {
  field: string;
  message: string;
  value?: string;
}

const GCP_MEMORY_CPU_LIMITS: Record<number, [number, number]> = {
  1: [512, 4096],
  2: [1024, 8192],
  4: [2048, 16384],
  6: [4096, 24576],
  8: [4096, 32768],
};

export function validateGcpResourceConstraints(
  plan: WorkflowDeploymentPlan
): GcpValidationError[] {
  const errors: GcpValidationError[] = [];

  if (plan.provider !== "gcp") return errors;

  const effectiveMemory = plan.memory || "512Mi";
  const effectiveCpu = plan.cpu || "1";
  const memoryMi = parseMemoryToMi(effectiveMemory);
  const cpuValue = parseNumeric(effectiveCpu);

  if (memoryMi !== undefined && memoryMi < 512) {
    errors.push({
      field: "memory",
      message: `Cloud Run requires at least 512Mi of memory when CPU is always allocated. Got: ${effectiveMemory}.`,
      value: effectiveMemory,
    });
  }

  if (cpuValue !== undefined && ![1, 2, 4, 6, 8].includes(cpuValue)) {
    errors.push({
      field: "cpu",
      message: `Cloud Run CPU must be 1, 2, 4, 6, or 8. Got: ${effectiveCpu}.`,
      value: effectiveCpu,
    });
  }

  if (cpuValue !== undefined && memoryMi !== undefined) {
    const range = GCP_MEMORY_CPU_LIMITS[cpuValue];
    if (range && (memoryMi < range[0] || memoryMi > range[1])) {
      errors.push({
        field: "memory",
        message: `Cloud Run with ${cpuValue} CPU requires memory between ${range[0]}Mi and ${range[1]}Mi. Got: ${memoryMi}Mi.`,
        value: effectiveMemory,
      });
    }
  }

  return errors;
}
