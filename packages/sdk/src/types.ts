export type WorkflowHttpMethod =
  | "GET"
  | "HEAD"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE";

export type WorkflowAccessMode = "read" | "write";
export type WorkflowTriggerType = "webhook" | "schedule" | "event" | "manual";
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
export type WorkflowProviderAuthType = "oauth2" | "api_key" | "basic";
export type WorkflowBindingSelectorType =
  | "latest_active"
  | "connection_id"
  | "label";
export type WorkflowAiProviderSlug = "openai" | "anthropic";
export type WorkflowAiResponseFormat = "text" | "json" | "raw";

/** A single tracked network interaction performed by a workflow. */
export interface WorkflowAccessOperation {
  id: string;
  source: "integration" | "web";
  target: string;
  url: string;
  method: WorkflowHttpMethod;
  mode: WorkflowAccessMode;
  checkpoint?: string;
  description?: string;
}

export interface WorkflowWriteApprovalRequest {
  checkpoint: string;
  operation: WorkflowAccessOperation;
  reason?: string;
}

export interface WorkflowRequestResult<T = unknown> {
  data: T;
  status: number;
}

export interface WorkflowReadOptions {
  method?: Extract<WorkflowHttpMethod, "GET" | "HEAD">;
  headers?: Record<string, string>;
  description?: string;
}

export interface WorkflowWriteOptions {
  method: Exclude<WorkflowHttpMethod, "GET" | "HEAD">;
  headers?: Record<string, string>;
  body?: unknown;
  checkpoint: string;
  description?: string;
}

export interface WorkflowContextOptions {
  authServiceUrl?: string;
  runtime?: WorkflowRuntimeIdentity;
  runtimeAuth?: WorkflowRuntimeAuthOptions;
  onOperation?: (
    operation: WorkflowAccessOperation
  ) => void | Promise<void>;
  approveWrite?: (
    request: WorkflowWriteApprovalRequest
  ) => void | Promise<void>;
}

/** Configuration for a GTMShip workflow */
export interface WorkflowConfig<TPayload = unknown, TResult = unknown> {
  /** Unique identifier for this workflow */
  id: string;
  /** Human-readable name */
  name?: string;
  /** Description of what this workflow does */
  description?: string;
  /** How this workflow is triggered */
  trigger: TriggerConfig;
  /** Optional deployment target override for this workflow */
  deploy?: DeployTarget;
  /** Optional trigger provisioning metadata used during deployment planning */
  triggerConfig?: WorkflowTriggerConfiguration;
  /** Optional auth bindings used to resolve provider connections at runtime */
  bindings?: WorkflowBinding[];
  /** The workflow execution function */
  run: (payload: TPayload, ctx: WorkflowContext) => Promise<TResult>;
}

/** Result returned after workflow execution */
export interface WorkflowResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  duration_ms: number;
}

/** Trigger configuration */
export interface TriggerConfig {
  type: WorkflowTriggerType;
  /** Webhook path (e.g., "/enrich") */
  path?: string;
  /** Cron expression (e.g., "0 9 * * MON") */
  cron?: string;
  /** Event name (e.g., "lead.created") */
  event?: string;
  /** Optional richer trigger metadata used by the deployment planner */
  config?: WorkflowTriggerConfiguration;
}

/** Authenticated HTTP client for a connected platform */
export interface AuthClient {
  /** Make a GET request to the platform API */
  get: <T = unknown>(
    path: string,
    config?: RequestInit
  ) => Promise<WorkflowRequestResult<T>>;
  /** Make a POST request to the platform API */
  post: <T = unknown>(
    path: string,
    data?: unknown,
    config?: RequestInit
  ) => Promise<WorkflowRequestResult<T>>;
  /** Make a PUT request to the platform API */
  put: <T = unknown>(
    path: string,
    data?: unknown,
    config?: RequestInit
  ) => Promise<WorkflowRequestResult<T>>;
  /** Make a PATCH request to the platform API */
  patch: <T = unknown>(
    path: string,
    data?: unknown,
    config?: RequestInit
  ) => Promise<WorkflowRequestResult<T>>;
  /** Make a DELETE request to the platform API */
  delete: <T = unknown>(
    path: string,
    config?: RequestInit
  ) => Promise<WorkflowRequestResult<T>>;
}

export interface WorkflowIntegrationClient {
  slug: string;
  get: <T = unknown>(
    path: string,
    options?: WorkflowReadOptions
  ) => Promise<WorkflowRequestResult<T>>;
  read: <T = unknown>(
    path: string,
    options?: WorkflowReadOptions
  ) => Promise<WorkflowRequestResult<T>>;
  write: <T = unknown>(
    path: string,
    options: WorkflowWriteOptions
  ) => Promise<WorkflowRequestResult<T>>;
}

export interface WorkflowWebAccess {
  read: <T = unknown>(
    url: string,
    options?: WorkflowReadOptions
  ) => Promise<WorkflowRequestResult<T>>;
  write: <T = unknown>(
    url: string,
    options: WorkflowWriteOptions
  ) => Promise<WorkflowRequestResult<T>>;
}

export interface WorkflowAiGenerateInput {
  providerSlug: WorkflowAiProviderSlug;
  model: string;
  system?: string;
  prompt?: string;
  input?: unknown;
  responseFormat?: WorkflowAiResponseFormat;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface WorkflowAiGenerateResult<TJson = unknown> {
  providerSlug: WorkflowAiProviderSlug;
  model: string;
  status: number;
  text: string | null;
  json: TJson | null;
  raw: unknown;
  usage?: Record<string, unknown> | null;
  stopReason?: string | null;
}

export interface WorkflowAiAccess {
  generate: <TJson = unknown>(
    input: WorkflowAiGenerateInput
  ) => Promise<WorkflowAiGenerateResult<TJson>>;
}

export interface WorkflowContext {
  integration: (providerSlug: string) => Promise<WorkflowIntegrationClient>;
  web: WorkflowWebAccess;
  ai: WorkflowAiAccess;
  requestWriteApproval: (
    request: WorkflowWriteApprovalRequest
  ) => Promise<void>;
}

export interface WorkflowRuntimeIdentity {
  workflowId?: string;
  deploymentId?: string;
  executionId?: string;
  runId?: string;
  runtimeKey?: string;
}

export interface WorkflowExecutionConfig {
  kind?: WorkflowExecutionKind;
  timeoutSeconds?: number;
  memory?: number | string;
  cpu?: number | string;
}

export interface WorkflowDeployAuthConfig {
  mode?: WorkflowDeployAuthModeInput;
  backend?: WorkflowSecretBackendConfig;
  runtimeAccess?: WorkflowSecretRuntimeAccessMode;
  manifest?: WorkflowRuntimeAuthManifest;
}

/** Deployment target for a workflow */
export interface DeployTarget {
  /** Deployment provider */
  provider?: WorkflowCloudProvider;
  /** Deployment region or target scope (e.g., "us-east-1", "us-central1", or "local") */
  region?: string;
  /** GCP project ID (required when provider is "gcp") */
  gcpProject?: string;
  /** Execution profile for this workflow */
  execution?: WorkflowExecutionConfig;
  /** Optional timeout for workflow runs */
  timeoutSeconds?: number;
  /** Optional memory request/limit for the runtime */
  memory?: number | string;
  /** Optional CPU request/limit for the runtime */
  cpu?: number | string;
  /** Authentication mode for connected integrations */
  auth?: WorkflowDeployAuthConfig;
}

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

export interface WorkflowSecretBackendConfig {
  kind?: WorkflowSecretBackendKind;
  region?: string;
  projectId?: string;
  secretPrefix?: string;
}

export interface WorkflowRuntimeAuthManifestProvider {
  providerSlug: string;
  connectionId?: string;
  secretRef?: string;
  authType?: WorkflowProviderAuthType;
  headerName?: string;
  defaultHeaders?: Record<string, string>;
  baseUrl?: string;
  instanceUrl?: string;
}

export interface WorkflowRuntimeAuthManifest {
  version?: string;
  generatedAt?: string;
  providers: WorkflowRuntimeAuthManifestProvider[];
}

export interface WorkflowRuntimeSecretValue {
  accessToken?: string;
  apiKey?: string;
  username?: string;
  password?: string;
  authType?: WorkflowProviderAuthType;
  headerName?: string;
  defaultHeaders?: Record<string, string>;
  baseUrl?: string;
  instanceUrl?: string;
}

export interface WorkflowRuntimeLocalCacheConfig {
  path?: string;
  ttlSeconds?: number;
  encryptionKey?: string;
}

export interface WorkflowSecretResolverInput {
  providerSlug: string;
  backend?: WorkflowSecretBackendConfig;
  runtimeAccess?: WorkflowSecretRuntimeAccessMode;
  manifestEntry?: WorkflowRuntimeAuthManifestProvider;
}

export type WorkflowSecretResolver = (
  input: WorkflowSecretResolverInput
) => Promise<WorkflowRuntimeSecretValue | null>;

export interface WorkflowRuntimeAuthOptions {
  mode?: WorkflowDeployAuthModeInput;
  backend?: WorkflowSecretBackendConfig;
  runtimeAccess?: WorkflowSecretRuntimeAccessMode;
  manifest?: WorkflowRuntimeAuthManifest;
  resolveSecret?: WorkflowSecretResolver;
  localCache?: WorkflowRuntimeLocalCacheConfig;
}

/** Trigger metadata returned after deployment */
export interface TriggerMetadata {
  /** Full webhook URL (for webhook triggers) */
  webhookUrl?: string;
  /** Next scheduled run time as ISO date string (for schedule triggers) */
  nextRunTime?: string;
  /** Cron expression (for schedule triggers) */
  cronExpression?: string;
  /** Schedule timezone when configured */
  timezone?: string;
  /** Event name (for event triggers) */
  eventName?: string;
  /** Resolved execution kind for the workflow */
  executionKind?: WorkflowExecutionKind;
}

/** Provider configuration (YAML template structure) */
export interface ProviderConfig {
  name: string;
  slug: string;
  auth_type: "oauth2" | "api_key" | "basic";
  authorize_url?: string;
  token_url?: string;
  base_url: string;
  scopes?: string[];
  token_refresh?: boolean;
  test_endpoint?: string;
  header?: string;
  docs_url?: string;
  notes?: string;
}
