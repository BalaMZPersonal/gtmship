import type {
  WorkflowDeployTargetMode,
  WorkflowDeploymentPlan,
  WorkflowDeployAuthMode,
  WorkflowDeploymentRun,
} from "@/lib/workflow-studio/types";

export type CloudProvider = "aws" | "gcp" | "local";
export type RemoteCloudProvider = Exclude<CloudProvider, "local">;
const AUTH_PROXY_BASE = "/api/auth-service";

export const AWS_DEFAULT_REGION = "us-east-1";
export const GCP_DEFAULT_REGION = "us-central1";
export const LOCAL_DEFAULT_REGION = "local";

export interface CloudSettingRecord {
  key: string;
  value: string;
}

export interface SavedRegions {
  aws: string;
  gcp: string;
  local: string;
}

export interface DeploySettings {
  provider: CloudProvider;
  region: string;
  gcpProject: string;
  savedRegions: SavedRegions;
}

export interface DashboardDeployRequest {
  provider: CloudProvider;
  region: string;
  gcpProject?: string;
  projectName: string;
  workflow?: string;
  artifact?: unknown;
}

export type ResolvedCloudDeploySettings = DeploySettings;

export interface WorkflowDeployTarget {
  target: WorkflowDeployTargetMode;
  provider: CloudProvider;
  region: string;
  gcpProject?: string;
  cloudProvider: RemoteCloudProvider;
  cloudRegion: string;
  cloudGcpProject?: string;
}

export interface ResolveWorkflowDeployTargetInput {
  workflowDeploy?:
    | Partial<{
        target: WorkflowDeployTargetMode;
        provider: CloudProvider;
        region: string;
        gcpProject: string;
      }>
    | null;
  cloudSettings?: ResolvedCloudDeploySettings | null;
  projectDefaults?: Partial<{
    provider: CloudProvider;
    region: string;
    gcpProject: string;
  }> | null;
}

export interface DashboardDeploySuccess {
  success: true;
  provider: CloudProvider;
  region?: string;
  projectName: string;
  apiEndpoint?: string | null;
  computeId?: string | null;
  databaseEndpoint?: string | null;
  storageBucket?: string | null;
  schedulerJobId?: string | null;
  output?: string;
}

export interface DashboardDeployError {
  error: string;
  output?: string;
}

export type DashboardDeployResponse = DashboardDeploySuccess | DashboardDeployError;

export interface DashboardLocalRunSuccess {
  success: true;
  workflowId: string;
  deploymentId?: string | null;
  runId?: string | null;
  executionId?: string | null;
  status?: "success" | "failure";
  output?: unknown;
}

export interface DashboardLocalRunError {
  error: string;
  workflowId?: string;
  deploymentId?: string | null;
  runId?: string | null;
  executionId?: string | null;
  status?: "failure";
  output?: unknown;
}

export type DashboardLocalRunResponse =
  | DashboardLocalRunSuccess
  | DashboardLocalRunError;
export type DashboardDeployInfraKey =
  | "apiEndpoint"
  | "computeId"
  | "databaseEndpoint"
  | "storageBucket"
  | "schedulerJobId";

export interface DashboardDeployInfraItem {
  label: string;
  key: DashboardDeployInfraKey;
}

export type GcpComputeType = "job" | "service";
export type WorkflowDeploymentComputeType = GcpComputeType | "lambda" | "job";

export interface WorkflowDeploymentPlatform {
  computeType?: WorkflowDeploymentComputeType | null;
  computeName?: string | null;
  endpointUrl?: string | null;
  schedulerJobId?: string | null;
  region?: string | null;
  gcpProject?: string | null;
  logGroupName?: string | null;
  logPath?: string | null;
}

export interface WorkflowExecutionHistoryEntry {
  executionName?: string | null;
  status?: string | null;
  triggerSource?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  logUri?: string | null;
  runningCount?: number | null;
  succeededCount?: number | null;
  failedCount?: number | null;
  cancelledCount?: number | null;
}

export interface WorkflowDeploymentOverview {
  id: string;
  workflowId: string;
  provider: string;
  region?: string | null;
  gcpProject?: string | null;
  executionKind?: string | null;
  triggerType?: string | null;
  triggerConfig?: Record<string, unknown> | null;
  endpointUrl?: string | null;
  schedulerId?: string | null;
  status?: string | null;
  deployedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  platform?: WorkflowDeploymentPlatform | null;
  recentExecutions?: WorkflowExecutionHistoryEntry[];
  liveError?: string | null;
}

export interface WorkflowDeploymentLogEntry {
  timestamp: string;
  level: "info" | "warn" | "error";
  message: string;
  executionName?: string | null;
  requestId?: string | null;
}

export interface WorkflowDeploymentLogsResponse {
  deploymentId?: string;
  entries: WorkflowDeploymentLogEntry[];
  liveError?: string | null;
}

export interface WorkflowDeploymentScope {
  workflowId?: string | null;
  workflowSlug?: string | null;
}

export interface WorkflowDeploymentTargeting {
  provider?: string | null;
  region?: string | null;
  gcpProject?: string | null;
}

export type WorkflowDeploymentDisplayTarget = Pick<
  WorkflowDeployTarget,
  "provider" | "region" | "gcpProject"
>;

export interface WorkflowSecretSyncEntry {
  key: string;
  workflowId: string;
  workflowTitle: string;
  providerSlug: string;
  connectionId: string;
  secretRef: string;
}

export interface WorkflowSecretSyncSummary {
  authMode: WorkflowDeployAuthMode;
  backendKind: string | null;
  backendTarget: string | null;
  secretPrefix: string | null;
  runtimeAccess: string | null;
  workflowCount: number;
  secretCount: number;
  entries: WorkflowSecretSyncEntry[];
}

export function isDashboardDeploySuccess(
  value: DashboardDeployResponse
): value is DashboardDeploySuccess {
  return (value as DashboardDeploySuccess).success === true;
}

export function isDashboardLocalRunSuccess(
  value: DashboardLocalRunResponse
): value is DashboardLocalRunSuccess {
  return (value as DashboardLocalRunSuccess).success === true;
}

function normalizeTextValue(value?: string | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function dedupeTextValues(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.map((value) => normalizeTextValue(value)).filter(Boolean))
  );
}

function summarizeTextValues(
  values: Array<string | null | undefined>
): string | null {
  const unique = dedupeTextValues(values);
  return unique.length > 0 ? unique.join(", ") : null;
}

function formatPlanTitle(plan: WorkflowDeploymentPlan): string {
  return (
    normalizeTextValue(plan.workflowTitle) ||
    normalizeTextValue(plan.workflowName) ||
    plan.workflowId
  );
}

function buildPlanSecretSyncEntries(
  plan: WorkflowDeploymentPlan
): WorkflowSecretSyncEntry[] {
  if (plan.authMode !== "secret_manager") {
    return [];
  }

  const workflowTitle = formatPlanTitle(plan);
  const manifestProviders = plan.auth?.manifest?.providers || [];
  if (manifestProviders.length === 0) {
    return [];
  }

  return manifestProviders.map((provider, index) => ({
    key: [
      plan.workflowId,
      provider.providerSlug,
      provider.connectionId || "pending-connection",
      provider.secretRef || "pending-secret-ref",
      String(index),
    ].join(":"),
    workflowId: plan.workflowId,
    workflowTitle,
    providerSlug: provider.providerSlug,
    connectionId:
      normalizeTextValue(provider.connectionId) || "Pending connection resolution",
    secretRef:
      normalizeTextValue(provider.secretRef) || "Pending secret target",
  }));
}

export function buildWorkflowSecretSyncSummary(
  plans: WorkflowDeploymentPlan[]
): WorkflowSecretSyncSummary | null {
  const secretManagerPlans = plans.filter(
    (plan) => plan.authMode === "secret_manager"
  );
  if (secretManagerPlans.length === 0) {
    return null;
  }

  const dedupedEntries = new Map<string, WorkflowSecretSyncEntry>();
  for (const plan of secretManagerPlans) {
    for (const entry of buildPlanSecretSyncEntries(plan)) {
      const entryKey = [
        entry.workflowId,
        entry.providerSlug,
        entry.connectionId,
        entry.secretRef,
      ].join(":");
      if (!dedupedEntries.has(entryKey)) {
        dedupedEntries.set(entryKey, {
          ...entry,
          key: entryKey,
        });
      }
    }
  }

  return {
    authMode: "secret_manager",
    backendKind: summarizeTextValues(
      secretManagerPlans.map((plan) => plan.auth?.backend?.kind)
    ),
    backendTarget: summarizeTextValues(
      secretManagerPlans.map(
        (plan) => plan.auth?.backend?.projectId || plan.auth?.backend?.region
      )
    ),
    secretPrefix: summarizeTextValues(
      secretManagerPlans.map((plan) => plan.auth?.backend?.secretPrefix)
    ),
    runtimeAccess: summarizeTextValues(
      secretManagerPlans.map((plan) => plan.auth?.runtimeAccess)
    ),
    workflowCount: new Set(secretManagerPlans.map((plan) => plan.workflowId)).size,
    secretCount: dedupedEntries.size,
    entries: Array.from(dedupedEntries.values()).sort((left, right) =>
      `${left.workflowTitle}:${left.providerSlug}`.localeCompare(
        `${right.workflowTitle}:${right.providerSlug}`
      )
    ),
  };
}

export function extractDashboardErrorMessage(
  payload: string,
  fallback: string
): string {
  let current = payload.trim();
  if (!current) {
    return fallback;
  }

  for (let index = 0; index < 3; index += 1) {
    try {
      const parsed = JSON.parse(current) as unknown;
      if (typeof parsed === "string") {
        const nested = parsed.trim();
        if (!nested) {
          break;
        }
        current = nested;
        continue;
      }

      if (parsed && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        const nested =
          typeof record.error === "string"
            ? record.error
            : typeof record.message === "string"
              ? record.message
              : "";
        if (!nested.trim()) {
          break;
        }
        current = nested.trim();
        continue;
      }
    } catch {
      break;
    }
    break;
  }

  return current || fallback;
}

const awsInfra: DashboardDeployInfraItem[] = [
  { label: "API Gateway", key: "apiEndpoint" },
  { label: "Lambda Function", key: "computeId" },
  { label: "RDS PostgreSQL", key: "databaseEndpoint" },
  { label: "S3 Bucket", key: "storageBucket" },
];

export interface DeploymentInfraOptions {
  gcpComputeType?: GcpComputeType | null;
  includeScheduler?: boolean;
}

export function getDeploymentInfra(
  provider: CloudProvider,
  options: DeploymentInfraOptions = {}
) {
  if (provider === "local") {
    const infra: DashboardDeployInfraItem[] = [
      { label: "Local Endpoint", key: "apiEndpoint" },
      { label: "Local Workflow Job", key: "computeId" },
      { label: "Local Database", key: "databaseEndpoint" },
      { label: "Bundle Path", key: "storageBucket" },
    ];

    if (options.includeScheduler) {
      infra.push({ label: "Local Scheduler", key: "schedulerJobId" });
    }

    return infra;
  }

  if (provider === "aws") {
    const infra = [...awsInfra];
    if (options.includeScheduler) {
      infra.push({ label: "EventBridge Scheduler", key: "schedulerJobId" });
    }
    return infra;
  }

  const computeLabel =
    options.gcpComputeType === "job" ? "Cloud Run Job" : "Cloud Run Service";
  const infra: DashboardDeployInfraItem[] = [
    { label: "Cloud Run URL", key: "apiEndpoint" },
    { label: computeLabel, key: "computeId" },
    { label: "Cloud SQL PostgreSQL", key: "databaseEndpoint" },
    { label: "Cloud Storage", key: "storageBucket" },
  ];

  if (options.includeScheduler) {
    infra.push({ label: "Cloud Scheduler Job", key: "schedulerJobId" });
  }

  return infra;
}

function normalizeDeploymentRef(value?: string | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseDeploymentTimestamp(
  deployment: WorkflowDeploymentOverview
): number {
  const candidate =
    deployment.deployedAt || deployment.updatedAt || deployment.createdAt || "";
  const parsed = Date.parse(candidate);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function scoreWorkflowDeploymentTarget(
  deployment: WorkflowDeploymentOverview,
  target: WorkflowDeploymentTargeting
): number {
  let score = 0;
  const normalizedRegion = normalizeDeploymentRef(target.region);
  const normalizedProject = normalizeDeploymentRef(target.gcpProject);
  const deploymentRegion = normalizeDeploymentRef(
    deployment.platform?.region || deployment.region
  );
  const deploymentProject = normalizeDeploymentRef(
    deployment.platform?.gcpProject || deployment.gcpProject
  );

  if (normalizedRegion && deploymentRegion === normalizedRegion) {
    score += 2;
  }
  if (normalizedProject && deploymentProject === normalizedProject) {
    score += 1;
  }

  return score;
}

export function getWorkflowDeploymentRefs(
  scope: WorkflowDeploymentScope = {}
): string[] {
  return Array.from(
    new Set(
      [scope.workflowId, scope.workflowSlug]
        .map((value) => normalizeDeploymentRef(value))
        .filter(Boolean)
    )
  );
}

export function deriveWorkflowDeploymentRunTarget(
  run?: Pick<WorkflowDeploymentRun, "provider" | "region" | "gcpProject"> | null
): WorkflowDeploymentDisplayTarget | null {
  const provider = resolveCloudProvider(run?.provider);
  if (!provider) {
    return null;
  }

  return {
    provider,
    region: normalizeDeploymentRef(run?.region) || defaultRegion(provider),
    gcpProject:
      provider === "gcp"
        ? normalizeDeploymentRef(run?.gcpProject) || undefined
        : undefined,
  };
}

export function formatWorkflowDeploymentDisplayTarget(
  target?: Partial<WorkflowDeploymentDisplayTarget> | null
): string {
  const provider = resolveCloudProvider(target?.provider);
  if (!provider) {
    return "Unknown";
  }

  const region = normalizeDeploymentRef(target?.region) || defaultRegion(provider);
  const project = normalizeDeploymentRef(target?.gcpProject);
  const base = `${provider.toUpperCase()} ${region}`;

  return provider === "gcp" && project ? `${base} · ${project}` : base;
}

export function workflowDeploymentTargetsMatch(
  left?: Partial<WorkflowDeploymentDisplayTarget> | null,
  right?: Partial<WorkflowDeploymentDisplayTarget> | null
): boolean {
  const leftProvider = resolveCloudProvider(left?.provider);
  const rightProvider = resolveCloudProvider(right?.provider);

  if (!leftProvider || !rightProvider || leftProvider !== rightProvider) {
    return false;
  }

  const leftRegion = normalizeDeploymentRef(left?.region) || defaultRegion(leftProvider);
  const rightRegion =
    normalizeDeploymentRef(right?.region) || defaultRegion(rightProvider);
  if (leftRegion !== rightRegion) {
    return false;
  }

  if (leftProvider !== "gcp") {
    return true;
  }

  return (
    normalizeDeploymentRef(left?.gcpProject) ===
    normalizeDeploymentRef(right?.gcpProject)
  );
}

export function dedupeWorkflowDeploymentsById(
  deployments: WorkflowDeploymentOverview[]
): WorkflowDeploymentOverview[] {
  const byId = new Map<string, WorkflowDeploymentOverview>();

  for (const deployment of deployments) {
    const normalizedId = normalizeDeploymentRef(deployment.id);
    if (!normalizedId || byId.has(normalizedId)) {
      continue;
    }
    byId.set(normalizedId, deployment);
  }

  return Array.from(byId.values());
}

export function getScopedWorkflowDeployments(
  deployments: WorkflowDeploymentOverview[],
  target: WorkflowDeploymentScope & WorkflowDeploymentTargeting = {}
): WorkflowDeploymentOverview[] {
  const workflowRefs = getWorkflowDeploymentRefs(target);

  return deployments
    .filter((deployment) => {
      if (target.provider && deployment.provider !== target.provider) {
        return false;
      }
      if (workflowRefs.length === 0) {
        return true;
      }
      return workflowRefs.includes(normalizeDeploymentRef(deployment.workflowId));
    })
    .sort((left, right) => {
      const scoreDiff =
        scoreWorkflowDeploymentTarget(right, target) -
        scoreWorkflowDeploymentTarget(left, target);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }

      return parseDeploymentTimestamp(right) - parseDeploymentTimestamp(left);
    });
}

export function resolveSelectedWorkflowDeploymentId(
  deployments: WorkflowDeploymentOverview[],
  currentDeploymentId?: string | null,
  preferredDeploymentId?: string | null
): string {
  const availableIds = new Set(deployments.map((deployment) => deployment.id));

  if (currentDeploymentId && availableIds.has(currentDeploymentId)) {
    return currentDeploymentId;
  }
  if (preferredDeploymentId && availableIds.has(preferredDeploymentId)) {
    return preferredDeploymentId;
  }

  return deployments[0]?.id || "";
}

export function resolveSelectedExecutionName(
  executions: WorkflowExecutionHistoryEntry[],
  currentExecutionName?: string | null
): string {
  if (!currentExecutionName) {
    return "";
  }

  return executions.some(
    (execution) => execution.executionName === currentExecutionName
  )
    ? currentExecutionName
    : "";
}

export function buildDeploymentLogsHref(input: {
  provider?: CloudProvider;
  deploymentId: string;
  workflowId?: string | null;
  workflowSlug?: string | null;
  executionName?: string | null;
}): string {
  const params = new URLSearchParams({
    provider: input.provider || "gcp",
    deploymentId: input.deploymentId,
  });
  const workflowRefs = getWorkflowDeploymentRefs(input);
  const normalizedSlug = normalizeDeploymentRef(input.workflowSlug);

  if (workflowRefs[0]) {
    params.set("workflow", workflowRefs[0]);
  }
  if (normalizedSlug && normalizedSlug !== workflowRefs[0]) {
    params.set("workflowSlug", normalizedSlug);
  }
  if (input.executionName) {
    params.set("executionName", input.executionName);
  }

  return `/deploy/logs?${params.toString()}`;
}

export function buildLocalDeploymentDashboardHref(input: {
  workflowId?: string | null;
  workflowSlug?: string | null;
  deploymentId?: string | null;
  executionName?: string | null;
} = {}): string {
  const params = new URLSearchParams();
  const workflowRefs = getWorkflowDeploymentRefs(input);
  const normalizedSlug = normalizeDeploymentRef(input.workflowSlug);
  const normalizedDeploymentId = normalizeDeploymentRef(input.deploymentId);

  if (workflowRefs[0]) {
    params.set("workflow", workflowRefs[0]);
  }
  if (normalizedSlug && normalizedSlug !== workflowRefs[0]) {
    params.set("workflowSlug", normalizedSlug);
  }
  if (normalizedDeploymentId) {
    params.set("deploymentId", normalizedDeploymentId);
  }
  if (input.executionName) {
    params.set("executionName", input.executionName);
  }

  const suffix = params.toString();
  return `/deploy/local${suffix ? `?${suffix}` : ""}`;
}

export function deploymentStatusTone(status?: string | null): string {
  const normalized = (status || "").toLowerCase();
  if (
    normalized === "success" ||
    normalized === "succeeded" ||
    normalized === "completed"
  ) {
    return "border-emerald-900/40 bg-emerald-950/20 text-emerald-200";
  }
  if (normalized === "running" || normalized === "in_progress") {
    return "border-blue-900/40 bg-blue-950/20 text-blue-200";
  }
  if (
    normalized === "failed" ||
    normalized === "error" ||
    normalized === "cancelled"
  ) {
    return "border-rose-900/40 bg-rose-950/20 text-rose-200";
  }
  return "border-zinc-800 bg-zinc-900 text-zinc-300";
}

export function formatDeploymentDateTime(value?: string | null): string {
  if (!value) {
    return "N/A";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

export function formatProviderComputeLabel(
  provider: CloudProvider,
  computeType?: string | null
): string {
  if (provider === "local") {
    return "Local Workflow Job";
  }

  if (provider === "aws") {
    return "Lambda Function";
  }

  return computeType === "job" ? "Cloud Run Job" : "Cloud Run Service";
}

export function formatDeploymentTriggerSummary(input: {
  triggerType?: string | null;
  triggerConfig?: Record<string, unknown> | null;
}): string {
  if (input.triggerType === "manual") {
    return "Manual";
  }

  if (input.triggerType === "schedule") {
    const triggerConfig =
      input.triggerConfig && typeof input.triggerConfig === "object"
        ? (input.triggerConfig as Record<string, unknown>)
        : {};
    const cron =
      typeof triggerConfig.cron === "string"
        ? triggerConfig.cron
        : typeof triggerConfig.schedule === "string"
          ? triggerConfig.schedule
          : "";
    const timezone =
      typeof triggerConfig.timezone === "string" ? triggerConfig.timezone : "";
    return cron ? `${cron}${timezone ? ` (${timezone})` : ""}` : "Scheduled";
  }

  if (input.triggerType === "webhook") {
    return "Webhook";
  }

  if (input.triggerType === "event") {
    const triggerConfig =
      input.triggerConfig && typeof input.triggerConfig === "object"
        ? (input.triggerConfig as Record<string, unknown>)
        : {};
    return typeof triggerConfig.eventName === "string"
      ? `Event: ${triggerConfig.eventName}`
      : "Event";
  }

  return "Unknown";
}

export function resolveCloudProvider(value?: string | null): CloudProvider | null {
  return value === "aws" || value === "gcp" || value === "local"
    ? value
    : null;
}

function resolveRemoteCloudProvider(
  value?: string | null
): RemoteCloudProvider | null {
  return value === "aws" || value === "gcp" ? value : null;
}

function resolveWorkflowDeployMode(input: {
  target?: WorkflowDeployTargetMode | null;
  provider?: string | null;
}): WorkflowDeployTargetMode {
  if (input.target === "cloud" || input.target === "local") {
    return input.target;
  }

  return input.provider === "local" ? "local" : "cloud";
}

export function resolvePreferredCloudProvider(input: {
  requestedProvider?: string | null;
  savedProvider?: CloudProvider | null;
}): CloudProvider {
  return resolveCloudProvider(input.requestedProvider) || input.savedProvider || "aws";
}

function defaultRegion(provider: CloudProvider): string {
  if (provider === "gcp") {
    return GCP_DEFAULT_REGION;
  }

  if (provider === "local") {
    return LOCAL_DEFAULT_REGION;
  }

  return AWS_DEFAULT_REGION;
}

export function resolveWorkflowDeployTarget(
  input: ResolveWorkflowDeployTargetInput
): WorkflowDeployTarget {
  const target = resolveWorkflowDeployMode({
    target: input.workflowDeploy?.target || null,
    provider: input.workflowDeploy?.provider || null,
  });
  const cloudProvider =
    resolveRemoteCloudProvider(input.workflowDeploy?.provider) ||
    resolveRemoteCloudProvider(input.cloudSettings?.provider) ||
    resolveRemoteCloudProvider(input.projectDefaults?.provider) ||
    "aws";
  const cloudRegion =
    (input.workflowDeploy?.region || "").trim() &&
    input.workflowDeploy?.region !== LOCAL_DEFAULT_REGION
      ? input.workflowDeploy?.region
      : input.cloudSettings?.savedRegions?.[cloudProvider] ||
        (input.cloudSettings?.provider === cloudProvider
          ? input.cloudSettings?.region
          : undefined) ||
        (input.projectDefaults?.provider === cloudProvider
          ? input.projectDefaults.region
          : undefined) ||
        defaultRegion(cloudProvider);
  const cloudGcpProject =
    input.workflowDeploy?.gcpProject ||
    input.cloudSettings?.gcpProject ||
    input.projectDefaults?.gcpProject;

  if (target === "local") {
    return {
      target,
      provider: "local",
      region: LOCAL_DEFAULT_REGION,
      cloudProvider,
      cloudRegion: cloudRegion || defaultRegion(cloudProvider),
      cloudGcpProject: cloudGcpProject || undefined,
    };
  }

  return {
    target,
    provider: cloudProvider,
    region: cloudRegion || defaultRegion(cloudProvider),
    gcpProject: cloudProvider === "gcp" ? cloudGcpProject : undefined,
    cloudProvider,
    cloudRegion: cloudRegion || defaultRegion(cloudProvider),
    cloudGcpProject: cloudGcpProject || undefined,
  };
}

export function deriveDeploySettings(
  settings: CloudSettingRecord[]
): DeploySettings {
  let savedProvider: CloudProvider = "aws";
  let savedAwsRegion = AWS_DEFAULT_REGION;
  let savedGcpRegion = GCP_DEFAULT_REGION;
  let savedLocalRegion = LOCAL_DEFAULT_REGION;
  let savedGcpProject = "";

  for (const setting of settings) {
    if (setting.key === "cloud_provider") {
      const normalizedProvider = resolveCloudProvider(setting.value);
      if (normalizedProvider) {
        savedProvider = normalizedProvider;
      }
    }
    if (setting.key === "aws_region" && setting.value) {
      savedAwsRegion = setting.value;
    }
    if (setting.key === "gcp_region" && setting.value) {
      savedGcpRegion = setting.value;
    }
    if (setting.key === "gcp_project_id" && setting.value) {
      savedGcpProject = setting.value;
    }
  }

  const region =
    savedProvider === "aws"
      ? savedAwsRegion
      : savedProvider === "gcp"
        ? savedGcpRegion
        : savedLocalRegion;

  return {
    provider: savedProvider,
    region,
    gcpProject: savedGcpProject,
    savedRegions: {
      aws: savedAwsRegion,
      gcp: savedGcpRegion,
      local: savedLocalRegion,
    },
  };
}

export async function loadCloudDeploySettings(): Promise<DeploySettings> {
  try {
    const response = await fetch(`${AUTH_PROXY_BASE}/settings`, {
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`Failed to load settings (${response.status})`);
    }
    const settings = (await response.json()) as CloudSettingRecord[];
    return deriveDeploySettings(settings);
  } catch {
    return deriveDeploySettings([]);
  }
}
