import { randomBytes } from "node:crypto";
import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "./db.js";
import { decrypt } from "./crypto.js";
import {
  normalizeSecretBackendKind,
  syncDeploymentBindingSecretReplicas,
  type SecretBackendKind,
  type SecretBackendTarget,
} from "./connection-secret-replicas.js";

export const workflowControlPlaneRoutes: Router = Router();

const GCP_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const GCP_EXECUTION_LIMIT_DEFAULT = 5;
const GCP_EXECUTION_LIMIT_MAX = 50;
const GCP_LOG_LIMIT_DEFAULT = 200;
const GCP_LOG_LIMIT_MAX = 500;
const GCP_ENCRYPTED_SETTING_KEYS = new Set(["gcp_service_account_key"]);

interface GcpServiceAccountKey {
  client_email?: string;
  private_key?: string;
  project_id?: string;
}

interface GcpSettingsSnapshot {
  projectId: string | null;
  region: string | null;
  serviceAccountKey: GcpServiceAccountKey | null;
}

interface GcpLivePlatformMetadata {
  computeType: "job" | "service";
  computeName: string | null;
  endpointUrl: string | null;
  schedulerJobId: string | null;
  region: string | null;
  gcpProject: string | null;
}

interface GcpExecutionSummary {
  executionName: string | null;
  fullName: string | null;
  status: "pending" | "running" | "success" | "failure" | "cancelled" | "unknown";
  startedAt: string | null;
  completedAt: string | null;
  logUri: string | null;
  runningCount: number;
  succeededCount: number;
  failedCount: number;
  cancelledCount: number;
}

interface DeploymentLogEntry {
  timestamp: string;
  level: "info" | "warn" | "error";
  message: string;
  executionName?: string;
  requestId?: string;
}

interface WorkflowDeploymentRow {
  id: string;
  workflowId: string;
  workflowVersion: string | null;
  provider: string;
  region: string | null;
  gcpProject: string | null;
  executionKind: string;
  authMode: string;
  authBackendKind: string | null;
  authBackendRegion: string | null;
  authBackendProjectId: string | null;
  authRuntimeAccess: string | null;
  runtimeAuthManifest: unknown;
  triggerType: string | null;
  triggerConfig: unknown;
  resourceInventory: unknown;
  endpointUrl: string | null;
  schedulerId: string | null;
  eventTriggerId: string | null;
  status: string;
  deployedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface WorkflowBindingRow {
  id: string;
  deploymentId: string;
  providerSlug: string;
  selectorType: string;
  selectorValue: string | null;
  connectionId: string | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}

interface WorkflowRunRow {
  id: string;
  deploymentId: string;
  executionId: string | null;
  triggerSource: string;
  status: string;
  cloudRef: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  requestPayload: unknown;
  responsePayload: unknown;
  error: unknown;
  createdAt: Date;
  updatedAt: Date;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function generateEntityId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = randomBytes(8).toString("hex");
  return `${prefix}${timestamp}${random}`;
}

function toQueryString(value: unknown): string | null {
  if (Array.isArray(value)) {
    return toQueryString(value[0]);
  }

  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function toNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function toBooleanQuery(value: unknown): boolean {
  const normalized = toQueryString(value)?.toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function toBoundedInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = Number.parseInt(toQueryString(value) || "", 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, parsed));
}

function parseSinceQuery(value: unknown): Date {
  const raw = toQueryString(value);
  if (!raw) {
    return new Date(Date.now() - 60 * 60 * 1000);
  }

  const durationMatch = raw.match(/^(\d+)([smhd])$/);
  if (durationMatch) {
    const amount = Number.parseInt(durationMatch[1], 10);
    const unit = durationMatch[2];
    const multipliers: Record<string, number> = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    };
    return new Date(Date.now() - amount * multipliers[unit]);
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return new Date(Date.now() - 60 * 60 * 1000);
  }

  return parsed;
}

function escapeLoggingFilterValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function toDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function jsonValueToSql(value: unknown): Prisma.Sql {
  if (value === undefined || value === null) {
    return Prisma.sql`NULL`;
  }

  return Prisma.sql`${JSON.stringify(value)}::jsonb`;
}

function hasOwn(
  object: Record<string, unknown>,
  key: string
): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function toNumberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function mapSeverityToLevel(value: unknown): "info" | "warn" | "error" {
  const severity = (typeof value === "string" ? value : "INFO").toUpperCase();
  if (
    severity === "ERROR" ||
    severity === "CRITICAL" ||
    severity === "ALERT" ||
    severity === "EMERGENCY"
  ) {
    return "error";
  }
  if (severity === "WARNING" || severity === "WARN") {
    return "warn";
  }
  return "info";
}

function stripCloudRunName(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("job:")) {
    return trimmed.slice(4) || null;
  }

  const jobMatch = trimmed.match(/\/jobs\/([^/]+)/);
  if (jobMatch?.[1]) {
    return jobMatch[1];
  }

  const serviceMatch = trimmed.match(/\/services\/([^/]+)/);
  if (serviceMatch?.[1]) {
    return serviceMatch[1];
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return null;
  }

  const parts = trimmed.split("/");
  return parts[parts.length - 1] || null;
}

function deriveGcpPlatformMetadata(
  deployment: WorkflowDeploymentRow
): GcpLivePlatformMetadata {
  const resourceInventory = asRecord(deployment.resourceInventory);
  const platformOutputs = asRecord(resourceInventory.platformOutputs);

  const serviceId =
    toNullableString(platformOutputs.serviceId) ||
    toNullableString(platformOutputs.computeId);
  const serviceUrl = toNullableString(platformOutputs.serviceUrl);
  const schedulerJobId =
    deployment.schedulerId || toNullableString(platformOutputs.schedulerJobId);
  const endpointUrl = deployment.endpointUrl || serviceUrl;
  const computeType = deployment.executionKind === "job" ? "job" : "service";
  const computeName = stripCloudRunName(
    serviceId || (endpointUrl?.startsWith("job:") ? endpointUrl : null)
  );

  return {
    computeType,
    computeName,
    endpointUrl,
    schedulerJobId,
    region: deployment.region,
    gcpProject: deployment.gcpProject,
  };
}

function extractExecutionStatus(
  execution: Record<string, unknown>
): GcpExecutionSummary["status"] {
  const runningCount = toNumberValue(execution.runningCount);
  const succeededCount = toNumberValue(execution.succeededCount);
  const failedCount = toNumberValue(execution.failedCount);
  const cancelledCount = toNumberValue(execution.cancelledCount);
  const completionTime = toNullableString(execution.completionTime);

  if (runningCount > 0) {
    return "running";
  }
  if (failedCount > 0) {
    return "failure";
  }
  if (cancelledCount > 0) {
    return "cancelled";
  }
  if (succeededCount > 0) {
    return "success";
  }
  if (!completionTime) {
    return "pending";
  }
  return "unknown";
}

async function loadCloudSettings(keys: string[]): Promise<Record<string, string | null>> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: keys } },
    select: { key: true, value: true },
  });

  const settings: Record<string, string | null> = {};
  for (const key of keys) {
    settings[key] = null;
  }

  for (const row of rows) {
    const value = GCP_ENCRYPTED_SETTING_KEYS.has(row.key)
      ? decrypt(row.value)
      : row.value;
    settings[row.key] = value;
  }

  return settings;
}

async function loadGcpSettingsSnapshot(): Promise<GcpSettingsSnapshot> {
  const settings = await loadCloudSettings([
    "gcp_service_account_key",
    "gcp_project_id",
    "gcp_region",
  ]);

  const serviceAccountRaw = settings["gcp_service_account_key"];
  let serviceAccountKey: GcpServiceAccountKey | null = null;
  if (serviceAccountRaw) {
    try {
      const parsed = JSON.parse(serviceAccountRaw) as GcpServiceAccountKey;
      serviceAccountKey = parsed;
    } catch {
      serviceAccountKey = null;
    }
  }

  return {
    projectId: settings["gcp_project_id"] || serviceAccountKey?.project_id || null,
    region: settings["gcp_region"] || null,
    serviceAccountKey,
  };
}

async function getGcpAccessToken(
  serviceAccountKey: GcpServiceAccountKey
): Promise<string | null> {
  const email = toNullableString(serviceAccountKey.client_email);
  const privateKey = toNullableString(serviceAccountKey.private_key);
  if (!email || !privateKey) {
    return null;
  }

  const authLib = await import("google-auth-library");
  const jwtClient = new authLib.JWT({
    email,
    key: privateKey,
    scopes: [GCP_PLATFORM_SCOPE],
  });

  const token = await jwtClient.authorize();
  return token.access_token || null;
}

async function fetchGcpJobExecutions(input: {
  projectId: string;
  region: string;
  jobName: string;
  accessToken: string;
  limit: number;
}): Promise<GcpExecutionSummary[]> {
  const url = new URL(
    `https://run.googleapis.com/v2/projects/${encodeURIComponent(
      input.projectId
    )}/locations/${encodeURIComponent(input.region)}/jobs/${encodeURIComponent(
      input.jobName
    )}/executions`
  );
  url.searchParams.set("pageSize", String(input.limit));

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
    },
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(
      `Cloud Run executions request failed (${response.status}): ${message || response.statusText}`
    );
  }

  const payload = (await response.json()) as { executions?: unknown[] };
  const executions = Array.isArray(payload.executions) ? payload.executions : [];

  return executions.map((executionValue) => {
    const execution = asRecord(executionValue);
    const fullName = toNullableString(execution.name);
    const executionName = fullName ? fullName.split("/").pop() || null : null;

    return {
      executionName,
      fullName,
      status: extractExecutionStatus(execution),
      startedAt:
        toNullableString(execution.startTime) ||
        toNullableString(execution.createTime),
      completedAt:
        toNullableString(execution.completionTime) ||
        toNullableString(execution.updateTime),
      logUri: toNullableString(execution.logUri),
      runningCount: toNumberValue(execution.runningCount),
      succeededCount: toNumberValue(execution.succeededCount),
      failedCount: toNumberValue(execution.failedCount),
      cancelledCount: toNumberValue(execution.cancelledCount),
    } satisfies GcpExecutionSummary;
  });
}

async function fetchGcpDeploymentLogs(input: {
  projectId: string;
  region: string | null;
  computeType: "job" | "service";
  computeName: string;
  accessToken: string;
  since: Date;
  limit: number;
  executionName?: string | null;
}): Promise<DeploymentLogEntry[]> {
  const filterParts: string[] = [
    `timestamp>="${input.since.toISOString()}"`,
    input.computeType === "job"
      ? `resource.type="cloud_run_job"`
      : `resource.type="cloud_run_revision"`,
    input.computeType === "job"
      ? `resource.labels.job_name="${escapeLoggingFilterValue(input.computeName)}"`
      : `resource.labels.service_name="${escapeLoggingFilterValue(input.computeName)}"`,
  ];

  if (input.region) {
    filterParts.push(
      `resource.labels.location="${escapeLoggingFilterValue(input.region)}"`
    );
  }

  if (input.executionName) {
    const escapedExecution = escapeLoggingFilterValue(input.executionName);
    filterParts.push(
      `(labels."run.googleapis.com/execution_name"="${escapedExecution}" OR labels.execution_name="${escapedExecution}")`
    );
  }

  const response = await fetch("https://logging.googleapis.com/v2/entries:list", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      resourceNames: [`projects/${input.projectId}`],
      filter: filterParts.join(" AND "),
      orderBy: "timestamp desc",
      pageSize: input.limit,
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(
      `Cloud Logging request failed (${response.status}): ${message || response.statusText}`
    );
  }

  const payload = (await response.json()) as { entries?: unknown[] };
  const entries = Array.isArray(payload.entries) ? payload.entries : [];

  return entries
    .map((entryValue) => {
      const entry = asRecord(entryValue);
      const jsonPayload = asRecord(entry.jsonPayload);
      const protoPayload = asRecord(entry.protoPayload);
      const protoStatus = asRecord(protoPayload.status);
      const labels = asRecord(entry.labels);

      const message =
        toNullableString(entry.textPayload) ||
        toNullableString(jsonPayload.message) ||
        toNullableString(protoStatus.message) ||
        (Object.keys(jsonPayload).length > 0
          ? JSON.stringify(jsonPayload)
          : Object.keys(protoPayload).length > 0
            ? JSON.stringify(protoPayload)
            : "");

      const timestamp =
        toNullableString(entry.timestamp) ||
        toNullableString(entry.receiveTimestamp) ||
        new Date().toISOString();

      return {
        timestamp,
        level: mapSeverityToLevel(entry.severity),
        message,
        executionName:
          toNullableString(labels["run.googleapis.com/execution_name"]) ||
          toNullableString(labels.execution_name) ||
          undefined,
        requestId: toNullableString(entry.trace) || toNullableString(entry.insertId) || undefined,
      } satisfies DeploymentLogEntry;
    })
    .filter((entry) => Boolean(entry.message));
}

async function buildGcpLiveOverview(
  deployment: WorkflowDeploymentRow,
  options: {
    settings: GcpSettingsSnapshot;
    executionLimit: number;
  }
): Promise<{
  platform: GcpLivePlatformMetadata;
  recentExecutions: GcpExecutionSummary[];
  liveError?: string;
}> {
  const platform = deriveGcpPlatformMetadata(deployment);
  const serviceAccountKey = options.settings.serviceAccountKey;
  if (!serviceAccountKey) {
    return {
      platform,
      recentExecutions: [],
      liveError: "GCP service account key is not configured.",
    };
  }

  const gcpProject =
    deployment.gcpProject || options.settings.projectId || serviceAccountKey.project_id || null;
  if (!gcpProject) {
    return {
      platform,
      recentExecutions: [],
      liveError: "GCP project id is not configured for this deployment.",
    };
  }

  if (platform.computeType === "job" && !platform.computeName) {
    return {
      platform: { ...platform, gcpProject },
      recentExecutions: [],
      liveError: "Cloud Run job name is not available in deployment metadata.",
    };
  }

  try {
    const accessToken = await getGcpAccessToken(serviceAccountKey);
    if (!accessToken) {
      return {
        platform: { ...platform, gcpProject },
        recentExecutions: [],
        liveError: "Failed to obtain an OAuth token for Google Cloud APIs.",
      };
    }

    if (platform.computeType !== "job") {
      return {
        platform: { ...platform, gcpProject },
        recentExecutions: [],
      };
    }

    const region = deployment.region || options.settings.region;
    if (!region) {
      return {
        platform: { ...platform, gcpProject },
        recentExecutions: [],
        liveError: "GCP region is missing for this deployment.",
      };
    }

    const recentExecutions = await fetchGcpJobExecutions({
      projectId: gcpProject,
      region,
      jobName: platform.computeName as string,
      accessToken,
      limit: options.executionLimit,
    });

    return {
      platform: { ...platform, gcpProject, region },
      recentExecutions,
    };
  } catch (error) {
    return {
      platform: { ...platform, gcpProject },
      recentExecutions: [],
      liveError:
        error instanceof Error ? error.message : "Failed to load live GCP execution data.",
    };
  }
}

interface WorkflowBindingInput {
  providerSlug: string;
  selectorType?: string | null;
  selectorValue?: string | null;
  connectionId?: string | null;
  metadata?: unknown;
}

interface DeploymentSecretSyncTask {
  deploymentId: string;
  authMode: string;
  backend: SecretBackendTarget | null;
  existingManifest: unknown;
}

function normalizeBindingInput(value: unknown): WorkflowBindingInput | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const providerSlug = toNullableString(record.providerSlug);
  if (!providerSlug) {
    return null;
  }

  const selector = asRecord(record.selector);
  const selectorType =
    toNullableString(record.selectorType) ||
    toNullableString(selector.type) ||
    "latest_active";
  const selectorValue =
    toNullableString(record.selectorValue) ||
    toNullableString(selector.selectorValue) ||
    toNullableString(selector.label) ||
    toNullableString(selector.connectionId);
  const connectionId =
    toNullableString(record.connectionId) ||
    toNullableString(selector.connectionId);

  return {
    providerSlug,
    selectorType,
    selectorValue,
    connectionId,
    metadata: record.metadata ?? null,
  };
}

function normalizeRuntimeAccess(value: unknown): "direct" | "local_cache" | null {
  const normalized = toNullableString(value);
  if (normalized === "direct" || normalized === "local_cache") {
    return normalized;
  }

  return null;
}

function readAuthBackendConfig(record: Record<string, unknown>): {
  kind: SecretBackendKind | null;
  region: string | null;
  projectId: string | null;
  runtimeAccess: "direct" | "local_cache" | null;
} {
  const authConfigRecord = asRecord(record.authConfig);
  const authBackendRecord = asRecord(
    record.authBackend ?? authConfigRecord.backend
  );
  const authRecord = asRecord(record.auth ?? authConfigRecord);
  const kind = normalizeSecretBackendKind(
    toNullableString(record.authBackendKind) ||
      toNullableString(authBackendRecord.kind)
  );
  const region =
    toNullableString(record.authBackendRegion) ||
    toNullableString(authBackendRecord.region);
  const projectId =
    toNullableString(record.authBackendProjectId) ||
    toNullableString(authBackendRecord.projectId);
  const runtimeAccess =
    normalizeRuntimeAccess(record.authRuntimeAccess) ||
    normalizeRuntimeAccess(authBackendRecord.runtimeAccess) ||
    normalizeRuntimeAccess(authRecord.runtimeAccess);

  return {
    kind: kind || null,
    region,
    projectId,
    runtimeAccess,
  };
}

async function updateRuntimeManifest(
  syncTasks: DeploymentSecretSyncTask[]
): Promise<void> {
  for (const task of syncTasks) {
    if (task.authMode !== "secret_manager" || !task.backend) {
      continue;
    }

    try {
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
    } catch (error) {
      console.warn(
        `[workflow-control] Failed to sync deployment secret replicas for ${task.deploymentId}: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }
}

workflowControlPlaneRoutes.get("/deployments", async (req, res) => {
  const workflowId = toQueryString(req.query.workflowId);
  const provider = toQueryString(req.query.provider);
  const status = toQueryString(req.query.status);
  const includeLive = toBooleanQuery(req.query.includeLive);
  const executionLimit = toBoundedInt(
    req.query.executionLimit,
    GCP_EXECUTION_LIMIT_DEFAULT,
    1,
    GCP_EXECUTION_LIMIT_MAX
  );
  const whereClauses: Prisma.Sql[] = [];

  if (workflowId) {
    whereClauses.push(Prisma.sql`workflow_id = ${workflowId}`);
  }
  if (provider) {
    whereClauses.push(Prisma.sql`provider = ${provider}`);
  }
  if (status) {
    whereClauses.push(Prisma.sql`status = ${status}`);
  }

  const whereSql =
    whereClauses.length > 0
      ? Prisma.sql`WHERE ${Prisma.join(whereClauses, " AND ")}`
      : Prisma.empty;

  const rows = await prisma.$queryRaw<WorkflowDeploymentRow[]>(Prisma.sql`
    SELECT
      id,
      workflow_id AS "workflowId",
      workflow_version AS "workflowVersion",
      provider,
      region,
      gcp_project AS "gcpProject",
      execution_kind AS "executionKind",
      auth_mode AS "authMode",
      auth_backend_kind AS "authBackendKind",
      auth_backend_region AS "authBackendRegion",
      auth_backend_project_id AS "authBackendProjectId",
      auth_runtime_access AS "authRuntimeAccess",
      runtime_auth_manifest AS "runtimeAuthManifest",
      trigger_type AS "triggerType",
      trigger_config AS "triggerConfig",
      resource_inventory AS "resourceInventory",
      endpoint_url AS "endpointUrl",
      scheduler_id AS "schedulerId",
      event_trigger_id AS "eventTriggerId",
      status,
      deployed_at AS "deployedAt",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM workflow_deployments
    ${whereSql}
    ORDER BY updated_at DESC
  `);

  if (!includeLive) {
    res.json(rows);
    return;
  }

  const gcpSettings = await loadGcpSettingsSnapshot();
  const deploymentsWithLive = await Promise.all(
    rows.map(async (deployment) => {
      if (deployment.provider !== "gcp") {
        return deployment;
      }

      const live = await buildGcpLiveOverview(deployment, {
        settings: gcpSettings,
        executionLimit,
      });

      return {
        ...deployment,
        ...live,
      };
    })
  );

  res.json(deploymentsWithLive);
});

workflowControlPlaneRoutes.get("/deployments/:id", async (req, res) => {
  const includeLive = toBooleanQuery(req.query.includeLive);
  const executionLimit = toBoundedInt(
    req.query.executionLimit,
    GCP_EXECUTION_LIMIT_DEFAULT,
    1,
    GCP_EXECUTION_LIMIT_MAX
  );
  const deploymentRows = await prisma.$queryRaw<WorkflowDeploymentRow[]>(Prisma.sql`
    SELECT
      id,
      workflow_id AS "workflowId",
      workflow_version AS "workflowVersion",
      provider,
      region,
      gcp_project AS "gcpProject",
      execution_kind AS "executionKind",
      auth_mode AS "authMode",
      auth_backend_kind AS "authBackendKind",
      auth_backend_region AS "authBackendRegion",
      auth_backend_project_id AS "authBackendProjectId",
      auth_runtime_access AS "authRuntimeAccess",
      runtime_auth_manifest AS "runtimeAuthManifest",
      trigger_type AS "triggerType",
      trigger_config AS "triggerConfig",
      resource_inventory AS "resourceInventory",
      endpoint_url AS "endpointUrl",
      scheduler_id AS "schedulerId",
      event_trigger_id AS "eventTriggerId",
      status,
      deployed_at AS "deployedAt",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM workflow_deployments
    WHERE id = ${req.params.id}
    LIMIT 1
  `);

  const deployment = deploymentRows[0];
  if (!deployment) {
    res.status(404).json({ error: "Workflow deployment not found." });
    return;
  }

  const bindings = await prisma.$queryRaw<WorkflowBindingRow[]>(Prisma.sql`
    SELECT
      id,
      deployment_id AS "deploymentId",
      provider_slug AS "providerSlug",
      selector_type AS "selectorType",
      selector_value AS "selectorValue",
      connection_id AS "connectionId",
      metadata,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM workflow_bindings
    WHERE deployment_id = ${deployment.id}
    ORDER BY created_at DESC
  `);

  const runs = await prisma.$queryRaw<WorkflowRunRow[]>(Prisma.sql`
    SELECT
      id,
      deployment_id AS "deploymentId",
      execution_id AS "executionId",
      trigger_source AS "triggerSource",
      status,
      cloud_ref AS "cloudRef",
      started_at AS "startedAt",
      ended_at AS "endedAt",
      request_payload AS "requestPayload",
      response_payload AS "responsePayload",
      error,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM workflow_runs
    WHERE deployment_id = ${deployment.id}
    ORDER BY created_at DESC
    LIMIT 100
  `);

  const payload: Record<string, unknown> = {
    ...deployment,
    bindings,
    runs,
  };

  if (includeLive && deployment.provider === "gcp") {
    const gcpSettings = await loadGcpSettingsSnapshot();
    const live = await buildGcpLiveOverview(deployment, {
      settings: gcpSettings,
      executionLimit,
    });

    payload.platform = live.platform;
    payload.recentExecutions = live.recentExecutions;
    if (live.liveError) {
      payload.liveError = live.liveError;
    }
  }

  res.json(payload);
});

workflowControlPlaneRoutes.get("/deployments/:id/logs", async (req, res) => {
  const since = parseSinceQuery(req.query.since);
  const limit = toBoundedInt(
    req.query.limit,
    GCP_LOG_LIMIT_DEFAULT,
    1,
    GCP_LOG_LIMIT_MAX
  );
  const executionName = toQueryString(req.query.executionName);

  const deploymentRows = await prisma.$queryRaw<WorkflowDeploymentRow[]>(Prisma.sql`
    SELECT
      id,
      workflow_id AS "workflowId",
      workflow_version AS "workflowVersion",
      provider,
      region,
      gcp_project AS "gcpProject",
      execution_kind AS "executionKind",
      auth_mode AS "authMode",
      auth_backend_kind AS "authBackendKind",
      auth_backend_region AS "authBackendRegion",
      auth_backend_project_id AS "authBackendProjectId",
      auth_runtime_access AS "authRuntimeAccess",
      runtime_auth_manifest AS "runtimeAuthManifest",
      trigger_type AS "triggerType",
      trigger_config AS "triggerConfig",
      resource_inventory AS "resourceInventory",
      endpoint_url AS "endpointUrl",
      scheduler_id AS "schedulerId",
      event_trigger_id AS "eventTriggerId",
      status,
      deployed_at AS "deployedAt",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM workflow_deployments
    WHERE id = ${req.params.id}
    LIMIT 1
  `);

  const deployment = deploymentRows[0];
  if (!deployment) {
    res.status(404).json({ error: "Workflow deployment not found." });
    return;
  }

  if (deployment.provider !== "gcp") {
    res.json({
      deploymentId: deployment.id,
      provider: deployment.provider,
      entries: [],
      liveError: "Live deployment logs are currently supported for GCP deployments only.",
    });
    return;
  }

  const platform = deriveGcpPlatformMetadata(deployment);
  if (!platform.computeName) {
    res.json({
      deploymentId: deployment.id,
      provider: deployment.provider,
      platform,
      entries: [],
      liveError: "Cloud Run target name is missing in deployment metadata.",
    });
    return;
  }

  const gcpSettings = await loadGcpSettingsSnapshot();
  const serviceAccountKey = gcpSettings.serviceAccountKey;
  if (!serviceAccountKey) {
    res.json({
      deploymentId: deployment.id,
      provider: deployment.provider,
      platform,
      entries: [],
      liveError: "GCP service account key is not configured.",
    });
    return;
  }

  const gcpProject =
    deployment.gcpProject || gcpSettings.projectId || serviceAccountKey.project_id || null;
  if (!gcpProject) {
    res.json({
      deploymentId: deployment.id,
      provider: deployment.provider,
      platform,
      entries: [],
      liveError: "GCP project id is not configured for this deployment.",
    });
    return;
  }

  try {
    const accessToken = await getGcpAccessToken(serviceAccountKey);
    if (!accessToken) {
      res.json({
        deploymentId: deployment.id,
        provider: deployment.provider,
        platform,
        entries: [],
        liveError: "Failed to obtain an OAuth token for Google Cloud APIs.",
      });
      return;
    }

    const entries = await fetchGcpDeploymentLogs({
      projectId: gcpProject,
      region: deployment.region || gcpSettings.region,
      computeType: platform.computeType,
      computeName: platform.computeName,
      accessToken,
      since,
      limit,
      executionName,
    });

    res.json({
      deploymentId: deployment.id,
      provider: deployment.provider,
      platform: { ...platform, gcpProject },
      entries,
    });
  } catch (error) {
    res.json({
      deploymentId: deployment.id,
      provider: deployment.provider,
      platform: { ...platform, gcpProject },
      entries: [],
      liveError:
        error instanceof Error ? error.message : "Failed to load deployment logs.",
    });
  }
});

workflowControlPlaneRoutes.post("/deployments", async (req, res) => {
  const body = asRecord(req.body);
  const workflowId = toNullableString(body.workflowId);
  const provider = toNullableString(body.provider);
  const executionKind = toNullableString(body.executionKind);
  const authBackend = readAuthBackendConfig(body);
  const runtimeAuthManifest =
    body.runtimeAuthManifest ??
    asRecord(body.authConfig).manifest ??
    asRecord(body.resourceInventory).authManifest ??
    null;

  if (!workflowId || !provider || !executionKind) {
    res.status(400).json({
      error:
        "workflowId, provider, and executionKind are required to create a deployment.",
    });
    return;
  }

  const deploymentId = generateEntityId("wd");
  const rows = await prisma.$queryRaw<WorkflowDeploymentRow[]>(Prisma.sql`
    INSERT INTO workflow_deployments (
      id,
      workflow_id,
      workflow_version,
      provider,
      region,
      gcp_project,
      execution_kind,
      auth_mode,
      auth_backend_kind,
      auth_backend_region,
      auth_backend_project_id,
      auth_runtime_access,
      runtime_auth_manifest,
      trigger_type,
      trigger_config,
      resource_inventory,
      endpoint_url,
      scheduler_id,
      event_trigger_id,
      status,
      deployed_at,
      updated_at
    ) VALUES (
      ${deploymentId},
      ${workflowId},
      ${toNullableString(body.workflowVersion)},
      ${provider},
      ${toNullableString(body.region)},
      ${toNullableString(body.gcpProject)},
      ${executionKind},
      ${toNullableString(body.authMode) || "proxy"},
      ${authBackend.kind},
      ${authBackend.region},
      ${authBackend.projectId},
      ${authBackend.runtimeAccess},
      ${jsonValueToSql(runtimeAuthManifest)},
      ${toNullableString(body.triggerType)},
      ${jsonValueToSql(body.triggerConfig)},
      ${jsonValueToSql(body.resourceInventory)},
      ${toNullableString(body.endpointUrl)},
      ${toNullableString(body.schedulerId)},
      ${toNullableString(body.eventTriggerId)},
      ${toNullableString(body.status) || "active"},
      ${toDate(body.deployedAt)},
      CURRENT_TIMESTAMP
    )
    RETURNING
      id,
      workflow_id AS "workflowId",
      workflow_version AS "workflowVersion",
      provider,
      region,
      gcp_project AS "gcpProject",
      execution_kind AS "executionKind",
      auth_mode AS "authMode",
      auth_backend_kind AS "authBackendKind",
      auth_backend_region AS "authBackendRegion",
      auth_backend_project_id AS "authBackendProjectId",
      auth_runtime_access AS "authRuntimeAccess",
      runtime_auth_manifest AS "runtimeAuthManifest",
      trigger_type AS "triggerType",
      trigger_config AS "triggerConfig",
      resource_inventory AS "resourceInventory",
      endpoint_url AS "endpointUrl",
      scheduler_id AS "schedulerId",
      event_trigger_id AS "eventTriggerId",
      status,
      deployed_at AS "deployedAt",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
  `);

  res.status(201).json(rows[0]);
});

workflowControlPlaneRoutes.post("/deployments/sync", async (req, res) => {
  const body = asRecord(req.body);
  const rawDeployments = Array.isArray(body.deployments) ? body.deployments : [];

  if (rawDeployments.length === 0) {
    res.status(400).json({
      error: "deployments must be a non-empty array.",
    });
    return;
  }

  try {
    const syncTasks: DeploymentSecretSyncTask[] = [];
    const synced = await prisma.$transaction(async (tx) => {
      const deployments: WorkflowDeploymentRow[] = [];

      for (const item of rawDeployments) {
        const record = asRecord(item);
        const workflowId = toNullableString(record.workflowId);
        const provider = toNullableString(record.provider);
        const executionKind = toNullableString(record.executionKind);
        const region = toNullableString(record.region);
        const authBackend = readAuthBackendConfig(record);
        const authMode = toNullableString(record.authMode) || "proxy";
        const runtimeAuthManifest =
          record.runtimeAuthManifest ??
          asRecord(record.authConfig).manifest ??
          asRecord(record.resourceInventory).authManifest ??
          null;

        if (!workflowId || !provider || !executionKind) {
          throw new Error(
            "Each deployment requires workflowId, provider, and executionKind."
          );
        }

        const existingRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT id
          FROM workflow_deployments
          WHERE workflow_id = ${workflowId}
            AND provider = ${provider}
            AND COALESCE(region, '') = COALESCE(${region}, '')
          ORDER BY updated_at DESC
          LIMIT 1
        `);

        let deployment: WorkflowDeploymentRow;

        if (existingRows[0]) {
          const rows = await tx.$queryRaw<WorkflowDeploymentRow[]>(Prisma.sql`
            UPDATE workflow_deployments
            SET
              workflow_version = ${toNullableString(record.workflowVersion)},
              region = ${region},
              gcp_project = ${toNullableString(record.gcpProject)},
              execution_kind = ${executionKind},
              auth_mode = ${authMode},
              auth_backend_kind = ${authBackend.kind},
              auth_backend_region = ${authBackend.region},
              auth_backend_project_id = ${authBackend.projectId},
              auth_runtime_access = ${authBackend.runtimeAccess},
              runtime_auth_manifest = ${jsonValueToSql(runtimeAuthManifest)},
              trigger_type = ${toNullableString(record.triggerType)},
              trigger_config = ${jsonValueToSql(record.triggerConfig)},
              resource_inventory = ${jsonValueToSql(
                record.resourceInventory || record.resourceIds
              )},
              endpoint_url = ${toNullableString(record.endpointUrl)},
              scheduler_id = ${toNullableString(record.schedulerId)},
              event_trigger_id = ${toNullableString(record.eventTriggerId)},
              status = ${toNullableString(record.status) || "active"},
              deployed_at = ${toDate(record.deployedAt)},
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ${existingRows[0].id}
            RETURNING
              id,
              workflow_id AS "workflowId",
              workflow_version AS "workflowVersion",
              provider,
              region,
              gcp_project AS "gcpProject",
              execution_kind AS "executionKind",
              auth_mode AS "authMode",
              auth_backend_kind AS "authBackendKind",
              auth_backend_region AS "authBackendRegion",
              auth_backend_project_id AS "authBackendProjectId",
              auth_runtime_access AS "authRuntimeAccess",
              runtime_auth_manifest AS "runtimeAuthManifest",
              trigger_type AS "triggerType",
              trigger_config AS "triggerConfig",
              resource_inventory AS "resourceInventory",
              endpoint_url AS "endpointUrl",
              scheduler_id AS "schedulerId",
              event_trigger_id AS "eventTriggerId",
              status,
              deployed_at AS "deployedAt",
              created_at AS "createdAt",
              updated_at AS "updatedAt"
          `);

          deployment = rows[0];
        } else {
          const deploymentId = generateEntityId("wd");
          const rows = await tx.$queryRaw<WorkflowDeploymentRow[]>(Prisma.sql`
            INSERT INTO workflow_deployments (
              id,
              workflow_id,
              workflow_version,
              provider,
              region,
              gcp_project,
              execution_kind,
              auth_mode,
              auth_backend_kind,
              auth_backend_region,
              auth_backend_project_id,
              auth_runtime_access,
              runtime_auth_manifest,
              trigger_type,
              trigger_config,
              resource_inventory,
              endpoint_url,
              scheduler_id,
              event_trigger_id,
              status,
              deployed_at,
              updated_at
            ) VALUES (
              ${deploymentId},
              ${workflowId},
              ${toNullableString(record.workflowVersion)},
              ${provider},
              ${region},
              ${toNullableString(record.gcpProject)},
              ${executionKind},
              ${authMode},
              ${authBackend.kind},
              ${authBackend.region},
              ${authBackend.projectId},
              ${authBackend.runtimeAccess},
              ${jsonValueToSql(runtimeAuthManifest)},
              ${toNullableString(record.triggerType)},
              ${jsonValueToSql(record.triggerConfig)},
              ${jsonValueToSql(record.resourceInventory || record.resourceIds)},
              ${toNullableString(record.endpointUrl)},
              ${toNullableString(record.schedulerId)},
              ${toNullableString(record.eventTriggerId)},
              ${toNullableString(record.status) || "active"},
              ${toDate(record.deployedAt)},
              CURRENT_TIMESTAMP
            )
            RETURNING
              id,
              workflow_id AS "workflowId",
              workflow_version AS "workflowVersion",
              provider,
              region,
              gcp_project AS "gcpProject",
              execution_kind AS "executionKind",
              auth_mode AS "authMode",
              auth_backend_kind AS "authBackendKind",
              auth_backend_region AS "authBackendRegion",
              auth_backend_project_id AS "authBackendProjectId",
              auth_runtime_access AS "authRuntimeAccess",
              runtime_auth_manifest AS "runtimeAuthManifest",
              trigger_type AS "triggerType",
              trigger_config AS "triggerConfig",
              resource_inventory AS "resourceInventory",
              endpoint_url AS "endpointUrl",
              scheduler_id AS "schedulerId",
              event_trigger_id AS "eventTriggerId",
              status,
              deployed_at AS "deployedAt",
              created_at AS "createdAt",
              updated_at AS "updatedAt"
          `);

          deployment = rows[0];
        }

        if (Array.isArray(record.bindings)) {
          await tx.$executeRaw(Prisma.sql`
            DELETE FROM workflow_bindings
            WHERE deployment_id = ${deployment.id}
          `);

          for (const bindingValue of record.bindings) {
            const binding = normalizeBindingInput(bindingValue);
            if (!binding) {
              continue;
            }

            const bindingId = generateEntityId("wb");
            await tx.$queryRaw<WorkflowBindingRow[]>(Prisma.sql`
              INSERT INTO workflow_bindings (
                id,
                deployment_id,
                provider_slug,
                selector_type,
                selector_value,
                connection_id,
                metadata,
                updated_at
              ) VALUES (
                ${bindingId},
                ${deployment.id},
                ${binding.providerSlug},
                ${binding.selectorType || "latest_active"},
                ${toNullableString(binding.selectorValue)},
                ${toNullableString(binding.connectionId)},
                ${jsonValueToSql(binding.metadata)},
                CURRENT_TIMESTAMP
              )
            `);
          }
        }

        syncTasks.push({
          deploymentId: deployment.id,
          authMode: deployment.authMode,
          backend: authBackend.kind
            ? {
                kind: authBackend.kind,
                region: authBackend.region,
                projectId: authBackend.projectId,
              }
            : null,
          existingManifest: runtimeAuthManifest,
        });
        deployments.push(deployment);
      }

      return deployments;
    });

    await updateRuntimeManifest(syncTasks);

    const deploymentIds = synced.map((deployment) => deployment.id);
    if (deploymentIds.length === 0) {
      res.status(201).json({ deployments: synced });
      return;
    }

    const updatedRows = await prisma.$queryRaw<WorkflowDeploymentRow[]>(Prisma.sql`
      SELECT
        id,
        workflow_id AS "workflowId",
        workflow_version AS "workflowVersion",
        provider,
        region,
        gcp_project AS "gcpProject",
        execution_kind AS "executionKind",
        auth_mode AS "authMode",
        auth_backend_kind AS "authBackendKind",
        auth_backend_region AS "authBackendRegion",
        auth_backend_project_id AS "authBackendProjectId",
        auth_runtime_access AS "authRuntimeAccess",
        runtime_auth_manifest AS "runtimeAuthManifest",
        trigger_type AS "triggerType",
        trigger_config AS "triggerConfig",
        resource_inventory AS "resourceInventory",
        endpoint_url AS "endpointUrl",
        scheduler_id AS "schedulerId",
        event_trigger_id AS "eventTriggerId",
        status,
        deployed_at AS "deployedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM workflow_deployments
      WHERE id IN (${Prisma.join(deploymentIds)})
      ORDER BY updated_at DESC
    `);

    res.status(201).json({ deployments: updatedRows });
  } catch (error) {
    res.status(400).json({
      error:
        error instanceof Error
          ? error.message
          : "Failed to sync workflow deployments.",
    });
  }
});

workflowControlPlaneRoutes.get("/bindings", async (req, res) => {
  const deploymentId = toQueryString(req.query.deploymentId);
  const providerSlug = toQueryString(req.query.providerSlug);
  const whereClauses: Prisma.Sql[] = [];

  if (deploymentId) {
    whereClauses.push(Prisma.sql`deployment_id = ${deploymentId}`);
  }
  if (providerSlug) {
    whereClauses.push(Prisma.sql`provider_slug = ${providerSlug}`);
  }

  const whereSql =
    whereClauses.length > 0
      ? Prisma.sql`WHERE ${Prisma.join(whereClauses, " AND ")}`
      : Prisma.empty;

  const rows = await prisma.$queryRaw<WorkflowBindingRow[]>(Prisma.sql`
    SELECT
      id,
      deployment_id AS "deploymentId",
      provider_slug AS "providerSlug",
      selector_type AS "selectorType",
      selector_value AS "selectorValue",
      connection_id AS "connectionId",
      metadata,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM workflow_bindings
    ${whereSql}
    ORDER BY created_at DESC
  `);

  res.json(rows);
});

workflowControlPlaneRoutes.post("/bindings", async (req, res) => {
  const body = asRecord(req.body);
  const deploymentId = toNullableString(body.deploymentId);
  const providerSlug = toNullableString(body.providerSlug);
  const selectorType = toNullableString(body.selectorType) || "latest_active";
  const allowedSelectorTypes = new Set(["latest_active", "connection_id", "label"]);

  if (!deploymentId || !providerSlug) {
    res.status(400).json({
      error: "deploymentId and providerSlug are required to create a binding.",
    });
    return;
  }

  if (!allowedSelectorTypes.has(selectorType)) {
    res.status(400).json({
      error: "selectorType must be one of latest_active, connection_id, or label.",
    });
    return;
  }

  const bindingId = generateEntityId("wb");
  const rows = await prisma.$queryRaw<WorkflowBindingRow[]>(Prisma.sql`
    INSERT INTO workflow_bindings (
      id,
      deployment_id,
      provider_slug,
      selector_type,
      selector_value,
      connection_id,
      metadata,
      updated_at
    ) VALUES (
      ${bindingId},
      ${deploymentId},
      ${providerSlug},
      ${selectorType},
      ${toNullableString(body.selectorValue)},
      ${toNullableString(body.connectionId)},
      ${jsonValueToSql(body.metadata)},
      CURRENT_TIMESTAMP
    )
    ON CONFLICT (deployment_id, provider_slug)
    DO UPDATE SET
      selector_type = EXCLUDED.selector_type,
      selector_value = EXCLUDED.selector_value,
      connection_id = EXCLUDED.connection_id,
      metadata = EXCLUDED.metadata,
      updated_at = CURRENT_TIMESTAMP
    RETURNING
      id,
      deployment_id AS "deploymentId",
      provider_slug AS "providerSlug",
      selector_type AS "selectorType",
      selector_value AS "selectorValue",
      connection_id AS "connectionId",
      metadata,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
  `);

  res.status(201).json(rows[0]);
});

workflowControlPlaneRoutes.delete("/bindings/:id", async (req, res) => {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    DELETE FROM workflow_bindings
    WHERE id = ${req.params.id}
    RETURNING id
  `);

  if (!rows[0]) {
    res.status(404).json({ error: "Workflow binding not found." });
    return;
  }

  res.status(204).end();
});

workflowControlPlaneRoutes.get("/runs", async (req, res) => {
  const deploymentId = toQueryString(req.query.deploymentId);
  const status = toQueryString(req.query.status);
  const requestedLimit = Number.parseInt(toQueryString(req.query.limit) || "100", 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(requestedLimit, 500))
    : 100;

  const whereClauses: Prisma.Sql[] = [];
  if (deploymentId) {
    whereClauses.push(Prisma.sql`deployment_id = ${deploymentId}`);
  }
  if (status) {
    whereClauses.push(Prisma.sql`status = ${status}`);
  }

  const whereSql =
    whereClauses.length > 0
      ? Prisma.sql`WHERE ${Prisma.join(whereClauses, " AND ")}`
      : Prisma.empty;

  const rows = await prisma.$queryRaw<WorkflowRunRow[]>(Prisma.sql`
    SELECT
      id,
      deployment_id AS "deploymentId",
      execution_id AS "executionId",
      trigger_source AS "triggerSource",
      status,
      cloud_ref AS "cloudRef",
      started_at AS "startedAt",
      ended_at AS "endedAt",
      request_payload AS "requestPayload",
      response_payload AS "responsePayload",
      error,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM workflow_runs
    ${whereSql}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `);

  res.json(rows);
});

workflowControlPlaneRoutes.post("/runs", async (req, res) => {
  const body = asRecord(req.body);
  const deploymentId = toNullableString(body.deploymentId);
  if (!deploymentId) {
    res.status(400).json({ error: "deploymentId is required to create a run." });
    return;
  }

  const runId = generateEntityId("wr");
  const rows = await prisma.$queryRaw<WorkflowRunRow[]>(Prisma.sql`
    INSERT INTO workflow_runs (
      id,
      deployment_id,
      execution_id,
      trigger_source,
      status,
      cloud_ref,
      started_at,
      ended_at,
      request_payload,
      response_payload,
      error,
      updated_at
    ) VALUES (
      ${runId},
      ${deploymentId},
      ${toNullableString(body.executionId)},
      ${toNullableString(body.triggerSource) || "manual"},
      ${toNullableString(body.status) || "queued"},
      ${toNullableString(body.cloudRef)},
      ${toDate(body.startedAt)},
      ${toDate(body.endedAt)},
      ${jsonValueToSql(body.requestPayload)},
      ${jsonValueToSql(body.responsePayload)},
      ${jsonValueToSql(body.error)},
      CURRENT_TIMESTAMP
    )
    RETURNING
      id,
      deployment_id AS "deploymentId",
      execution_id AS "executionId",
      trigger_source AS "triggerSource",
      status,
      cloud_ref AS "cloudRef",
      started_at AS "startedAt",
      ended_at AS "endedAt",
      request_payload AS "requestPayload",
      response_payload AS "responsePayload",
      error,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
  `);

  res.status(201).json(rows[0]);
});

workflowControlPlaneRoutes.patch("/runs/:id", async (req, res) => {
  const body = asRecord(req.body);
  const updates: Prisma.Sql[] = [];

  if (hasOwn(body, "executionId")) {
    updates.push(Prisma.sql`execution_id = ${toNullableString(body.executionId)}`);
  }
  if (hasOwn(body, "triggerSource")) {
    updates.push(Prisma.sql`trigger_source = ${toNullableString(body.triggerSource)}`);
  }
  if (hasOwn(body, "status")) {
    updates.push(Prisma.sql`status = ${toNullableString(body.status)}`);
  }
  if (hasOwn(body, "cloudRef")) {
    updates.push(Prisma.sql`cloud_ref = ${toNullableString(body.cloudRef)}`);
  }
  if (hasOwn(body, "startedAt")) {
    updates.push(Prisma.sql`started_at = ${toDate(body.startedAt)}`);
  }
  if (hasOwn(body, "endedAt")) {
    updates.push(Prisma.sql`ended_at = ${toDate(body.endedAt)}`);
  }
  if (hasOwn(body, "requestPayload")) {
    updates.push(Prisma.sql`request_payload = ${jsonValueToSql(body.requestPayload)}`);
  }
  if (hasOwn(body, "responsePayload")) {
    updates.push(Prisma.sql`response_payload = ${jsonValueToSql(body.responsePayload)}`);
  }
  if (hasOwn(body, "error")) {
    updates.push(Prisma.sql`error = ${jsonValueToSql(body.error)}`);
  }

  if (updates.length === 0) {
    res.status(400).json({ error: "No updatable fields were provided." });
    return;
  }

  updates.push(Prisma.sql`updated_at = CURRENT_TIMESTAMP`);

  const rows = await prisma.$queryRaw<WorkflowRunRow[]>(Prisma.sql`
    UPDATE workflow_runs
    SET ${Prisma.join(updates, ", ")}
    WHERE id = ${req.params.id}
    RETURNING
      id,
      deployment_id AS "deploymentId",
      execution_id AS "executionId",
      trigger_source AS "triggerSource",
      status,
      cloud_ref AS "cloudRef",
      started_at AS "startedAt",
      ended_at AS "endedAt",
      request_payload AS "requestPayload",
      response_payload AS "responsePayload",
      error,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
  `);

  if (!rows[0]) {
    res.status(404).json({ error: "Workflow run not found." });
    return;
  }

  res.json(rows[0]);
});
