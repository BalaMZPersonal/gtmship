export type CloudProvider = "aws" | "gcp";
const AUTH_URL = process.env.NEXT_PUBLIC_AUTH_URL || "http://localhost:4000";

export const AWS_DEFAULT_REGION = "us-east-1";
export const GCP_DEFAULT_REGION = "us-central1";

export interface CloudSettingRecord {
  key: string;
  value: string;
}

export interface SavedRegions {
  aws: string;
  gcp: string;
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
  provider: CloudProvider;
  region: string;
  gcpProject?: string;
}

export interface ResolveWorkflowDeployTargetInput {
  workflowDeploy?: Partial<WorkflowDeployTarget> | null;
  cloudSettings?: ResolvedCloudDeploySettings | null;
  projectDefaults?: Partial<WorkflowDeployTarget> | null;
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

export interface WorkflowDeploymentPlatform {
  computeType?: GcpComputeType | null;
  computeName?: string | null;
  endpointUrl?: string | null;
  schedulerJobId?: string | null;
  region?: string | null;
  gcpProject?: string | null;
}

export interface WorkflowExecutionHistoryEntry {
  executionName?: string | null;
  status?: string | null;
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

export function isDashboardDeploySuccess(
  value: DashboardDeployResponse
): value is DashboardDeploySuccess {
  return (value as DashboardDeploySuccess).success === true;
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
  if (provider === "aws") {
    return awsInfra;
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

function defaultRegion(provider: CloudProvider): string {
  return provider === "gcp" ? GCP_DEFAULT_REGION : AWS_DEFAULT_REGION;
}

export function resolveWorkflowDeployTarget(
  input: ResolveWorkflowDeployTargetInput
): WorkflowDeployTarget {
  const provider =
    input.workflowDeploy?.provider ||
    input.cloudSettings?.provider ||
    input.projectDefaults?.provider ||
    "aws";

  const region =
    input.workflowDeploy?.region ||
    input.cloudSettings?.savedRegions?.[provider] ||
    input.cloudSettings?.region ||
    (input.projectDefaults?.provider === provider
      ? input.projectDefaults.region
      : undefined) ||
    input.projectDefaults?.region ||
    defaultRegion(provider);

  return {
    provider,
    region,
    gcpProject:
      input.workflowDeploy?.gcpProject ||
      input.cloudSettings?.gcpProject ||
      input.projectDefaults?.gcpProject,
  };
}

export function deriveDeploySettings(
  settings: CloudSettingRecord[]
): DeploySettings {
  let savedProvider: CloudProvider = "aws";
  let savedAwsRegion = AWS_DEFAULT_REGION;
  let savedGcpRegion = GCP_DEFAULT_REGION;
  let savedGcpProject = "";

  for (const setting of settings) {
    if (setting.key === "cloud_provider" && (setting.value === "aws" || setting.value === "gcp")) {
      savedProvider = setting.value;
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

  const region = savedProvider === "aws" ? savedAwsRegion : savedGcpRegion;

  return {
    provider: savedProvider,
    region,
    gcpProject: savedGcpProject,
    savedRegions: {
      aws: savedAwsRegion,
      gcp: savedGcpRegion,
    },
  };
}

export async function loadCloudDeploySettings(): Promise<DeploySettings> {
  try {
    const response = await fetch(`${AUTH_URL}/settings`, {
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
