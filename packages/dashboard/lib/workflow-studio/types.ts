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

export const WORKFLOW_DRAFT_PROGRESS_STAGES = [
  "analysis",
  "access",
  "grounding",
  "code",
  "mermaid",
  "finalize",
] as const;

export type WorkflowDraftProgressStage =
  (typeof WORKFLOW_DRAFT_PROGRESS_STAGES)[number];

export type WorkflowDraftProgressStatus =
  | "started"
  | "completed"
  | "failed"
  | "blocked"
  | "update";

export const WORKFLOW_DRAFT_PROGRESS_LABELS: Record<
  WorkflowDraftProgressStage,
  string
> = {
  analysis: "Defining the workflow",
  access: "Checking required access",
  grounding: "Researching API schemas",
  code: "Writing and testing the workflow",
  mermaid: "Visualizing the workflow",
  finalize: "Finalizing the draft",
};

export interface WorkflowDraftProgressEvent {
  type: "workflow-draft-progress";
  toolCallId: string;
  stage: WorkflowDraftProgressStage;
  status: WorkflowDraftProgressStatus;
  label: string;
  detail?: string;
  attempt?: number;
  totalAttempts?: number;
  timestamp: string;
}

export interface ContextPressureEvent {
  type: "context-pressure";
  tier: 0 | 1 | 2 | 3;
  usageRatio: number;
  tokenEstimate: number;
  tokenBudget: number;
  toolResultLimit: number;
  timestamp: string;
}

export function isWorkflowDraftProgressEvent(
  value: unknown
): value is WorkflowDraftProgressEvent {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<WorkflowDraftProgressEvent>;

  return (
    candidate.type === "workflow-draft-progress" &&
    typeof candidate.toolCallId === "string" &&
    typeof candidate.stage === "string" &&
    typeof candidate.status === "string" &&
    typeof candidate.label === "string" &&
    typeof candidate.timestamp === "string"
  );
}

export interface WorkflowTranscriptCompaction {
  version: 1;
  summary: string;
  compactedAt: string;
  archivedMessages: WorkflowStudioMessage[];
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
  responseBodySnippet?: string;
}

export type WorkflowPreviewLogLevel =
  | "log"
  | "info"
  | "warn"
  | "error"
  | "debug";

export interface WorkflowPreviewLogEntry {
  id: string;
  level: WorkflowPreviewLogLevel;
  timestamp: string;
  message: string;
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
  logs?: WorkflowPreviewLogEntry[];
  result?: unknown;
  error?: string;
  stack?: string;
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
export type ConnectionAuthStrategyHealth =
  | "healthy"
  | "degraded"
  | "migrating";

export interface ConnectionAuthStrategyBackend {
  kind: WorkflowSecretBackendKind;
  region?: string;
  projectId?: string;
  secretPrefix?: string;
}

export interface ConnectionAuthReplicaSummary {
  activeConnections: number;
  expectedReplicas: number;
  active: number;
  pending: number;
  error: number;
  missing: number;
}

export interface ConnectionAuthStrategyStatus {
  mode: WorkflowDeployAuthMode;
  status: ConnectionAuthStrategyHealth;
  configuredBackends: ConnectionAuthStrategyBackend[];
  replicaSummary: ConnectionAuthReplicaSummary;
}

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
  authStrategy?: ConnectionAuthStrategyStatus | null;
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
  transcriptCompaction?: WorkflowTranscriptCompaction;
  deploy?: WorkflowDeploySpec;
  triggerConfig?: WorkflowTriggerConfig;
  bindings?: WorkflowBinding[];
  deploymentPlan?: WorkflowDeploymentPlan;
  deploymentRun?: WorkflowDeploymentRun;
  validation?: WorkflowValidationReport;
  preview?: WorkflowPreviewResult;
  build?: WorkflowBuildResult;
  groundedApiContext?: GroundedApiContext;
}

export interface GroundedEndpoint {
  provider: string;
  path: string;
  method: string;
  purpose: string;
  requestSchema?: string;
  responseSchema?: string;
  tested?: boolean;
  testStatus?: number;
  docsSource?: string;
}

export interface GroundedApiContext {
  endpoints: GroundedEndpoint[];
  researchNotes: string[];
  groundedAt: string;
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
