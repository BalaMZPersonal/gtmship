export type WorkflowStudioRole = "user" | "assistant" | "system" | "data";

export interface WorkflowStudioToolInvocation {
  toolName: string;
  args?: Record<string, unknown>;
  state: "call" | "partial-call" | "result";
  result?: unknown;
  toolCallId?: string;
}

export type WorkflowStudioMessagePart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "tool-invocation";
      toolInvocation: WorkflowStudioToolInvocation;
    }
  | {
      type: "step-start";
    }
  | {
      type: string;
      [key: string]: unknown;
    };

export interface WorkflowStudioMessage {
  id: string;
  role: WorkflowStudioRole;
  content: string;
  createdAt?: string;
  parts?: WorkflowStudioMessagePart[];
  toolInvocations?: WorkflowStudioToolInvocation[];
  annotations?: unknown[];
}

export type WorkflowAccessRequirementType = "integration" | "public_url";
export type WorkflowAccessRequirementMode = "read" | "write";
export type WorkflowAccessRequirementStatus =
  | "verified"
  | "reachable"
  | "pending"
  | "missing"
  | "blocked";

export interface WorkflowAccessRequirement {
  id: string;
  type: WorkflowAccessRequirementType;
  mode: WorkflowAccessRequirementMode;
  label: string;
  purpose: string;
  providerSlug?: string;
  connectionId?: string;
  url?: string;
  status: WorkflowAccessRequirementStatus;
  statusMessage?: string;
}

export interface WorkflowWriteCheckpoint {
  id: string;
  label: string;
  description: string;
  method: string;
  targetType: WorkflowAccessRequirementType;
  providerSlug?: string;
  url?: string;
}

export interface WorkflowValidationIssue {
  level: "error" | "warning";
  message: string;
}

export interface WorkflowValidationReport {
  ok: boolean;
  issues: WorkflowValidationIssue[];
  details: {
    mode: "studio" | "legacy";
    workflowId?: string;
    workflowName?: string;
    triggerType?: string;
    usesContext: boolean;
    forbiddenPatterns: string[];
    detectedWriteCheckpoints: string[];
  };
}

export interface WorkflowPreviewOperation {
  id: string;
  source: "integration" | "web";
  target: string;
  url: string;
  method: string;
  mode: "read" | "write";
  checkpoint?: string;
  description?: string;
  responseStatus?: number;
}

export interface WorkflowPendingApproval {
  checkpoint: string;
  description?: string;
  target: string;
  method: string;
  source: "integration" | "web";
}

export interface WorkflowPreviewResult {
  status: "success" | "needs_approval" | "error";
  operations: WorkflowPreviewOperation[];
  result?: unknown;
  error?: string;
  warnings?: string[];
  pendingApproval?: WorkflowPendingApproval;
}

export type WorkflowTriggerType =
  | "manual"
  | "webhook"
  | "schedule"
  | "event";

export type WorkflowExecutionKind = "service" | "job";
export type WorkflowDeployProvider = "aws" | "gcp";
export type WorkflowDeployAuthMode = "proxy" | "secret_manager";
export type WorkflowDeployAuthModeInput =
  | WorkflowDeployAuthMode
  | "synced_secrets";
export type WorkflowSecretBackendKind =
  | "aws_secrets_manager"
  | "gcp_secret_manager";
export type WorkflowSecretRuntimeAccessMode = "direct" | "local_cache";

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

export interface WorkflowDeploySpec {
  provider?: WorkflowDeployProvider;
  region?: string;
  gcpProject?: string;
  execution?: WorkflowExecutionConfig;
  timeoutSeconds?: number;
  memory?: number | string;
  cpu?: number | string;
  auth?: WorkflowDeployAuthConfig;
}

export interface WorkflowScheduleTriggerConfig {
  cron?: string;
  timezone?: string;
  defaultPayload?: Record<string, unknown>;
}

export interface WorkflowWebhookTriggerConfig {
  path?: string;
  visibility?: "public" | "private";
  signatureHeader?: string;
  signatureSecretRef?: string;
}

export interface WorkflowEventTriggerConfig {
  event?: string;
  source?: string;
  eventBus?: string;
  queue?: string;
  topic?: string;
  detailType?: string;
  async?: boolean;
}

export interface WorkflowTriggerConfig {
  schedule?: WorkflowScheduleTriggerConfig;
  webhook?: WorkflowWebhookTriggerConfig;
  event?: WorkflowEventTriggerConfig;
}

export type WorkflowBindingSelectorType =
  | "latest_active"
  | "connection_id"
  | "label";

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
  version?: string;
  generatedAt?: string;
  providers: WorkflowRuntimeAuthManifestProvider[];
}

export interface WorkflowPlannedResource {
  kind: string;
  name: string;
  description: string;
  summary?: string;
}

export interface WorkflowPlannedBinding {
  providerSlug: string;
  selector: WorkflowBindingSelector;
  status?: "resolved" | "missing" | "ambiguous";
  message?: string;
  resolvedConnectionId?: string;
  resolvedConnectionLabel?: string | null;
}

export interface WorkflowPlannedTrigger {
  type: WorkflowTriggerType;
  description: string;
  endpoint?: string;
  cron?: string;
  timezone?: string;
  nextRunTime?: string;
  eventName?: string;
  source?: string;
  access?: "public" | "private";
}

export interface WorkflowDeploymentPlan {
  workflowId: string;
  workflowName?: string;
  workflowTitle?: string;
  provider: WorkflowDeployProvider;
  region: string;
  gcpProject?: string;
  trigger: WorkflowPlannedTrigger;
  triggerType?: WorkflowTriggerType;
  executionKind: WorkflowExecutionKind;
  executionSource: "explicit" | "default";
  authMode: WorkflowDeployAuthMode;
  auth?: {
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
  };
  resources: WorkflowPlannedResource[];
  bindings: WorkflowPlannedBinding[];
  warnings: string[];
  summary?: {
    trigger: string;
    execution: string;
    endpoint?: string;
    schedule?: string;
    event?: string;
  };
  source?: "shared-engine" | "dashboard-fallback";
}

export interface WorkflowDeploymentPlanResponse {
  projectRootConfigured?: boolean;
  projectName?: string;
  provider: WorkflowDeployProvider;
  region: string;
  gcpProject?: string;
  plans: WorkflowDeploymentPlan[];
  usedSharedPlanner?: boolean;
}

export type WorkflowBuildStage =
  | "validation"
  | "preview"
  | "bundle"
  | "package";

export interface WorkflowBuildStep {
  stage: WorkflowBuildStage;
  label: string;
  status: "success" | "error" | "skipped";
  summary: string;
  command?: string;
  output?: string;
  durationMs?: number;
}

export interface WorkflowBuildArtifactRef {
  workflowId: string;
  provider: WorkflowDeployProvider;
  artifactPath: string;
  imageUri?: string;
  bundleSizeBytes: number;
}

export interface WorkflowBuildResult {
  status: "success" | "error";
  provider: WorkflowDeployProvider;
  region?: string;
  gcpProject?: string;
  builtAt: string;
  steps: WorkflowBuildStep[];
  error?: string;
  validation?: WorkflowValidationReport;
  preview?: WorkflowPreviewResult;
  artifact?: WorkflowBuildArtifactRef;
}

export interface WorkflowDeploymentRun {
  status: "success" | "error";
  provider: WorkflowDeployProvider;
  region?: string;
  gcpProject?: string;
  projectName: string;
  deployedAt: string;
  apiEndpoint?: string | null;
  computeId?: string | null;
  databaseEndpoint?: string | null;
  storageBucket?: string | null;
  schedulerJobId?: string | null;
  output?: string;
  error?: string;
}

export interface WorkflowProjectDeploymentDefaults {
  provider?: WorkflowDeployProvider;
  region?: string;
  gcpProject?: string;
}

export interface WorkflowStudioArtifact {
  slug: string;
  title: string;
  summary: string;
  description?: string;
  mermaid: string;
  code: string;
  samplePayload: string;
  requiredAccesses: WorkflowAccessRequirement[];
  writeCheckpoints: WorkflowWriteCheckpoint[];
  chatSummary: string;
  messages: WorkflowStudioMessage[];
  deploy?: WorkflowDeploySpec;
  triggerConfig?: WorkflowTriggerConfig;
  bindings?: WorkflowBinding[];
  deploymentPlan?: WorkflowDeploymentPlan;
  deploymentRun?: WorkflowDeploymentRun;
  validation?: WorkflowValidationReport;
  preview?: WorkflowPreviewResult;
  build?: WorkflowBuildResult;
}

export interface StoredWorkflowRecord {
  slug: string;
  workflowId: string;
  filePath: string;
  metadataPath: string;
  artifact: WorkflowStudioArtifact;
  updatedAt: string;
}

export interface WorkflowListItem {
  slug: string;
  workflowId: string;
  title: string;
  summary: string;
  updatedAt: string;
  trigger: string;
  filePath: string;
  hasStudioMetadata: boolean;
}

export interface WorkflowListingResponse {
  projectRootConfigured: boolean;
  projectRoot?: string;
  projectName?: string;
  deploymentDefaults?: WorkflowProjectDeploymentDefaults;
  workflows: WorkflowListItem[];
}
