import { Prisma } from "@prisma/client";
import { prisma } from "./db.js";
import { decrypt } from "./crypto.js";

const ENCRYPTED_SETTING_KEYS = new Set([
  "aws_secret_access_key",
  "gcp_service_account_key",
]);
const DEFAULT_SECRET_PREFIX = "gtmship-connections";

export type SecretBackendKind = "aws_secrets_manager" | "gcp_secret_manager";
export type SecretRuntimeAccess = "direct" | "local_cache";

export interface SecretBackendTarget {
  kind: SecretBackendKind;
  region?: string | null;
  projectId?: string | null;
}

export interface ConnectionSecretReplicaRow {
  id: string;
  connectionId: string;
  backendKind: SecretBackendKind;
  backendRegion: string;
  backendProjectId: string;
  runtimeSecretRef: string;
  controlSecretRef: string | null;
  status: string;
  lastSyncedAt: Date | null;
  lastError: string | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}

interface ConnectionForSecretSync {
  id: string;
  oauthCredentialId: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
  instanceUrl: string | null;
  label: string | null;
  metadata: unknown;
  provider: {
    slug: string;
    authType: string;
    headerName: string | null;
    baseUrl: string;
    apiSchema: unknown;
  };
  oauthCredential?: {
    id: string;
    accountEmail: string | null;
    accessToken: string;
    refreshToken: string | null;
    tokenExpiresAt: Date | null;
  } | null;
}

export function normalizeSecretBackendKind(
  value: string | null | undefined
): SecretBackendKind | undefined {
  if (value === "aws_secrets_manager" || value === "gcp_secret_manager") {
    return value;
  }

  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

async function readSetting(key: string): Promise<string | null> {
  const setting = await prisma.setting.findUnique({ where: { key } });
  if (!setting) {
    return null;
  }

  if (!ENCRYPTED_SETTING_KEYS.has(key)) {
    return setting.value;
  }

  try {
    return decrypt(setting.value);
  } catch {
    return null;
  }
}

function getEncryptedAccessToken(connection: ConnectionForSecretSync): string | null {
  return connection.oauthCredential?.accessToken || connection.accessToken || null;
}

function getEncryptedRefreshToken(connection: ConnectionForSecretSync): string | null {
  return connection.oauthCredential?.refreshToken || connection.refreshToken || null;
}

function getTokenExpiresAt(connection: ConnectionForSecretSync): Date | null {
  return connection.oauthCredential?.tokenExpiresAt || connection.tokenExpiresAt || null;
}

function sanitizeSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_/.]/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[-/.]+|[-/.]+$/g, "");
}

function sanitizeSecretId(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const safe = normalized.length > 0 ? normalized : "connection-secret";
  if (!/^[A-Za-z]/.test(safe)) {
    return `s-${safe}`.slice(0, 255);
  }
  return safe.slice(0, 255);
}

function getSecretPrefix(): string {
  const envPrefix = process.env.GTMSHIP_CONNECTION_SECRET_PREFIX;
  if (envPrefix && envPrefix.trim()) {
    return sanitizeSegment(envPrefix);
  }

  return DEFAULT_SECRET_PREFIX;
}

function buildSecretNames(connection: ConnectionForSecretSync): {
  awsRuntimeName: string;
  awsControlName: string;
  gcpRuntimeId: string;
  gcpControlId: string;
} {
  const prefix = getSecretPrefix();
  const providerSlug = sanitizeSegment(connection.provider.slug || "provider");
  const connectionId = sanitizeSegment(connection.id);
  const basePath = `${prefix}/${providerSlug}/${connectionId}`;
  const gcpBase = sanitizeSecretId(`${prefix}-${providerSlug}-${connectionId}`);

  return {
    awsRuntimeName: `${basePath}/runtime`,
    awsControlName: `${basePath}/control`,
    gcpRuntimeId: `${gcpBase}-runtime`,
    gcpControlId: `${gcpBase}-control`,
  };
}

function buildRuntimeSecretPayload(connection: ConnectionForSecretSync): {
  accessToken: string;
  payload: Record<string, unknown>;
} | null {
  const encryptedAccessToken = getEncryptedAccessToken(connection);
  if (!encryptedAccessToken) {
    return null;
  }

  const accessToken = decrypt(encryptedAccessToken);
  return {
    accessToken,
    payload: {
      version: 1,
      scope: "runtime",
      connectionId: connection.id,
      providerSlug: connection.provider.slug,
      authType: connection.provider.authType,
      headerName: connection.provider.headerName,
      baseUrl: connection.instanceUrl || connection.provider.baseUrl,
      accessToken,
      label: connection.label,
      metadata: connection.metadata ?? null,
      updatedAt: new Date().toISOString(),
    },
  };
}

function buildControlSecretPayload(connection: ConnectionForSecretSync): {
  payload: Record<string, unknown>;
} {
  const encryptedRefreshToken = getEncryptedRefreshToken(connection);
  const refreshToken = encryptedRefreshToken ? decrypt(encryptedRefreshToken) : null;

  return {
    payload: {
      version: 1,
      scope: "control",
      connectionId: connection.id,
      providerSlug: connection.provider.slug,
      oauthCredentialId: connection.oauthCredentialId,
      refreshToken,
      tokenExpiresAt: getTokenExpiresAt(connection)?.toISOString() || null,
      accountEmail: connection.oauthCredential?.accountEmail || null,
      updatedAt: new Date().toISOString(),
    },
  };
}

async function loadAwsClient(
  region: string
): Promise<{ client: unknown; commands: Record<string, unknown> }> {
  const specifier = ["@aws-sdk", "client-secrets-manager"].join("/");
  const awsModule = (await import(specifier)) as Record<string, unknown>;
  const SecretsManagerClient = awsModule.SecretsManagerClient as new (
    config?: Record<string, unknown>
  ) => unknown;

  if (!SecretsManagerClient) {
    throw new Error("Unable to load AWS Secrets Manager client.");
  }

  const accessKeyId = await readSetting("aws_access_key_id");
  const secretAccessKey = await readSetting("aws_secret_access_key");
  const sessionToken = await readSetting("aws_session_token");
  const clientConfig: Record<string, unknown> = { region };

  if (accessKeyId && secretAccessKey) {
    clientConfig.credentials = {
      accessKeyId,
      secretAccessKey,
      sessionToken: sessionToken || undefined,
    };
  }

  return {
    client: new SecretsManagerClient(clientConfig),
    commands: awsModule,
  };
}

async function putAwsSecretValue(params: {
  region: string;
  secretName: string;
  payload: Record<string, unknown>;
}): Promise<string> {
  const { client, commands } = await loadAwsClient(params.region);
  const DescribeSecretCommand = commands.DescribeSecretCommand as new (
    input: Record<string, unknown>
  ) => unknown;
  const CreateSecretCommand = commands.CreateSecretCommand as new (
    input: Record<string, unknown>
  ) => unknown;
  const PutSecretValueCommand = commands.PutSecretValueCommand as new (
    input: Record<string, unknown>
  ) => unknown;

  if (!DescribeSecretCommand || !CreateSecretCommand || !PutSecretValueCommand) {
    throw new Error("AWS Secrets Manager commands are unavailable.");
  }

  const secretValue = JSON.stringify(params.payload);
  let arn: string | undefined;

  try {
    const describeResponse = (await (client as { send: (command: unknown) => Promise<Record<string, unknown>> }).send(
      new DescribeSecretCommand({ SecretId: params.secretName })
    )) as Record<string, unknown>;
    arn = normalizeText(describeResponse.ARN) || undefined;
  } catch (error) {
    const errorName =
      typeof error === "object" && error && "name" in error
        ? String((error as { name?: unknown }).name)
        : "UnknownError";
    if (errorName !== "ResourceNotFoundException") {
      throw error;
    }

    const createResponse = (await (client as { send: (command: unknown) => Promise<Record<string, unknown>> }).send(
      new CreateSecretCommand({
        Name: params.secretName,
        SecretString: secretValue,
      })
    )) as Record<string, unknown>;
    arn = normalizeText(createResponse.ARN) || undefined;
  }

  await (client as { send: (command: unknown) => Promise<unknown> }).send(
    new PutSecretValueCommand({
      SecretId: params.secretName,
      SecretString: secretValue,
    })
  );

  return arn || params.secretName;
}

async function loadGcpClient(
  projectId: string
): Promise<{ client: unknown; projectId: string }> {
  const specifier = ["@google-cloud", "secret-manager"].join("/");
  const gcpModule = (await import(specifier)) as Record<string, unknown>;
  const SecretManagerServiceClient = gcpModule.SecretManagerServiceClient as new (
    config?: Record<string, unknown>
  ) => unknown;

  if (!SecretManagerServiceClient) {
    throw new Error("Unable to load GCP Secret Manager client.");
  }

  const rawServiceAccount = await readSetting("gcp_service_account_key");
  let credentials: Record<string, unknown> | undefined;
  if (rawServiceAccount) {
    const parsed = JSON.parse(rawServiceAccount) as Record<string, unknown>;
    if (parsed.client_email && parsed.private_key) {
      credentials = {
        client_email: parsed.client_email,
        private_key: parsed.private_key,
      };
    }
  }

  const config: Record<string, unknown> = {};
  if (credentials) {
    config.credentials = credentials;
    config.projectId = projectId;
  }

  return {
    client: new SecretManagerServiceClient(config),
    projectId,
  };
}

async function putGcpSecretValue(params: {
  projectId: string;
  secretId: string;
  payload: Record<string, unknown>;
}): Promise<string> {
  const { client, projectId } = await loadGcpClient(params.projectId);
  const parent = `projects/${projectId}`;
  const secretName = `${parent}/secrets/${params.secretId}`;
  const secretPayload = Buffer.from(JSON.stringify(params.payload), "utf8");

  try {
    await (client as { getSecret: (args: Record<string, unknown>) => Promise<unknown> }).getSecret({
      name: secretName,
    });
  } catch (error) {
    const errorCode =
      typeof error === "object" && error && "code" in error
        ? Number((error as { code?: unknown }).code)
        : undefined;
    if (errorCode !== 5) {
      throw error;
    }

    await (client as {
      createSecret: (args: Record<string, unknown>) => Promise<unknown>;
    }).createSecret({
      parent,
      secretId: params.secretId,
      secret: {
        replication: {
          automatic: {},
        },
      },
    });
  }

  await (client as {
    addSecretVersion: (args: Record<string, unknown>) => Promise<unknown>;
  }).addSecretVersion({
    parent: secretName,
    payload: { data: secretPayload },
  });

  return secretName;
}

function buildReplicaMetadata(connection: ConnectionForSecretSync): Record<string, unknown> {
  return {
    providerSlug: connection.provider.slug,
    authType: connection.provider.authType,
    headerName: connection.provider.headerName,
    oauthCredentialId: connection.oauthCredentialId,
  };
}

async function generateId(): Promise<string> {
  const { randomBytes } = await import("node:crypto");
  const timestamp = Date.now().toString(36);
  const random = randomBytes(8).toString("hex");
  return `cr${timestamp}${random}`;
}

async function upsertReplicaRecord(params: {
  connectionId: string;
  backend: SecretBackendTarget;
  runtimeSecretRef: string;
  controlSecretRef?: string | null;
  status: "active" | "error";
  lastError?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<ConnectionSecretReplicaRow> {
  const id = await generateId();
  const rows = await prisma.$queryRaw<ConnectionSecretReplicaRow[]>(Prisma.sql`
    INSERT INTO connection_secret_replicas (
      id,
      connection_id,
      backend_kind,
      backend_region,
      backend_project_id,
      runtime_secret_ref,
      control_secret_ref,
      status,
      last_synced_at,
      last_error,
      metadata,
      updated_at
    ) VALUES (
      ${id},
      ${params.connectionId},
      ${params.backend.kind},
      ${params.backend.region || ""},
      ${params.backend.projectId || ""},
      ${params.runtimeSecretRef},
      ${params.controlSecretRef || null},
      ${params.status},
      ${params.status === "active" ? new Date() : null},
      ${params.lastError || null},
      ${params.metadata ? JSON.stringify(params.metadata) : null}::jsonb,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT (connection_id, backend_kind, backend_region, backend_project_id)
    DO UPDATE SET
      runtime_secret_ref = EXCLUDED.runtime_secret_ref,
      control_secret_ref = EXCLUDED.control_secret_ref,
      status = EXCLUDED.status,
      last_synced_at = EXCLUDED.last_synced_at,
      last_error = EXCLUDED.last_error,
      metadata = EXCLUDED.metadata,
      updated_at = CURRENT_TIMESTAMP
    RETURNING
      id,
      connection_id AS "connectionId",
      backend_kind AS "backendKind",
      backend_region AS "backendRegion",
      backend_project_id AS "backendProjectId",
      runtime_secret_ref AS "runtimeSecretRef",
      control_secret_ref AS "controlSecretRef",
      status,
      last_synced_at AS "lastSyncedAt",
      last_error AS "lastError",
      metadata,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
  `);

  return rows[0];
}

async function loadConnectionForSecretSync(
  connectionId: string
): Promise<ConnectionForSecretSync | null> {
  return prisma.connection.findUnique({
    where: { id: connectionId },
    include: {
      provider: {
        select: {
          slug: true,
          authType: true,
          headerName: true,
          baseUrl: true,
          apiSchema: true,
        },
      },
      oauthCredential: {
        select: {
          id: true,
          accountEmail: true,
          accessToken: true,
          refreshToken: true,
          tokenExpiresAt: true,
        },
      },
    },
  }) as Promise<ConnectionForSecretSync | null>;
}

export async function loadConfiguredSecretBackendTargets(): Promise<
  SecretBackendTarget[]
> {
  const targets: SecretBackendTarget[] = [];

  const awsRegion =
    normalizeText(await readSetting("aws_region")) ||
    normalizeText(process.env.AWS_REGION) ||
    "us-east-1";
  const awsAccessKey = normalizeText(await readSetting("aws_access_key_id"));
  const awsSecret = normalizeText(await readSetting("aws_secret_access_key"));
  if ((awsAccessKey && awsSecret) || process.env.AWS_ACCESS_KEY_ID) {
    targets.push({
      kind: "aws_secrets_manager",
      region: awsRegion,
    });
  }

  const gcpProject =
    normalizeText(await readSetting("gcp_project_id")) ||
    normalizeText(process.env.GOOGLE_CLOUD_PROJECT);
  const rawGcpServiceAccount = await readSetting("gcp_service_account_key");
  if (rawGcpServiceAccount || gcpProject) {
    let projectId = gcpProject;
    if (!projectId && rawGcpServiceAccount) {
      try {
        const parsed = JSON.parse(rawGcpServiceAccount) as Record<string, unknown>;
        projectId = normalizeText(parsed.project_id) || null;
      } catch {
        projectId = null;
      }
    }

    if (projectId) {
      targets.push({
        kind: "gcp_secret_manager",
        projectId,
      });
    }
  }

  return targets;
}

export async function syncConnectionSecretReplicas(
  connection: ConnectionForSecretSync,
  explicitTarget?: SecretBackendTarget
): Promise<ConnectionSecretReplicaRow[]> {
  const runtimeSecret = buildRuntimeSecretPayload(connection);
  if (!runtimeSecret) {
    return [];
  }

  const controlSecret = buildControlSecretPayload(connection);
  const names = buildSecretNames(connection);
  const targets = explicitTarget
    ? [explicitTarget]
    : await loadConfiguredSecretBackendTargets();
  const replicas: ConnectionSecretReplicaRow[] = [];

  for (const target of targets) {
    try {
      let runtimeSecretRef = "";
      let controlSecretRef: string | null = null;

      if (target.kind === "aws_secrets_manager") {
        const region = target.region || "us-east-1";
        runtimeSecretRef = await putAwsSecretValue({
          region,
          secretName: names.awsRuntimeName,
          payload: runtimeSecret.payload,
        });
        controlSecretRef = await putAwsSecretValue({
          region,
          secretName: names.awsControlName,
          payload: controlSecret.payload,
        });
      } else {
        const projectId = target.projectId;
        if (!projectId) {
          throw new Error("GCP secret backend requires projectId.");
        }

        runtimeSecretRef = await putGcpSecretValue({
          projectId,
          secretId: names.gcpRuntimeId,
          payload: runtimeSecret.payload,
        });
        controlSecretRef = await putGcpSecretValue({
          projectId,
          secretId: names.gcpControlId,
          payload: controlSecret.payload,
        });
      }

      const replica = await upsertReplicaRecord({
        connectionId: connection.id,
        backend: target,
        runtimeSecretRef,
        controlSecretRef,
        status: "active",
        lastError: null,
        metadata: buildReplicaMetadata(connection),
      });
      replicas.push(replica);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to sync secret replica";
      const failed = await upsertReplicaRecord({
        connectionId: connection.id,
        backend: target,
        runtimeSecretRef:
          target.kind === "aws_secrets_manager"
            ? names.awsRuntimeName
            : `projects/${target.projectId || "unknown"}/secrets/${names.gcpRuntimeId}`,
        controlSecretRef:
          target.kind === "aws_secrets_manager"
            ? names.awsControlName
            : `projects/${target.projectId || "unknown"}/secrets/${names.gcpControlId}`,
        status: "error",
        lastError: message,
        metadata: buildReplicaMetadata(connection),
      });
      replicas.push(failed);
    }
  }

  return replicas;
}

export async function syncConnectionSecretReplicasById(
  connectionId: string,
  explicitTarget?: SecretBackendTarget
): Promise<ConnectionSecretReplicaRow[]> {
  const connection = await loadConnectionForSecretSync(connectionId);
  if (!connection) {
    return [];
  }

  return syncConnectionSecretReplicas(connection, explicitTarget);
}

export async function getConnectionSecretReplicas(
  connectionId: string
): Promise<ConnectionSecretReplicaRow[]> {
  return prisma.$queryRaw<ConnectionSecretReplicaRow[]>(Prisma.sql`
    SELECT
      id,
      connection_id AS "connectionId",
      backend_kind AS "backendKind",
      backend_region AS "backendRegion",
      backend_project_id AS "backendProjectId",
      runtime_secret_ref AS "runtimeSecretRef",
      control_secret_ref AS "controlSecretRef",
      status,
      last_synced_at AS "lastSyncedAt",
      last_error AS "lastError",
      metadata,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM connection_secret_replicas
    WHERE connection_id = ${connectionId}
    ORDER BY updated_at DESC
  `);
}

export async function syncDeploymentBindingSecretReplicas(params: {
  deploymentId: string;
  backend: SecretBackendTarget;
}): Promise<
  Array<{
    providerSlug: string;
    connectionId: string;
    runtimeSecretRef: string;
    controlSecretRef: string | null;
    backendKind: SecretBackendKind;
    backendRegion?: string;
    backendProjectId?: string;
  }>
> {
  const bindingRows = await prisma.$queryRaw<
    Array<{
      providerSlug: string;
      connectionId: string;
    }>
  >(Prisma.sql`
    SELECT
      provider_slug AS "providerSlug",
      connection_id AS "connectionId"
    FROM workflow_bindings
    WHERE deployment_id = ${params.deploymentId}
      AND connection_id IS NOT NULL
  `);

  const descriptors: Array<{
    providerSlug: string;
    connectionId: string;
    runtimeSecretRef: string;
    controlSecretRef: string | null;
    backendKind: SecretBackendKind;
    backendRegion?: string;
    backendProjectId?: string;
  }> = [];

  for (const binding of bindingRows) {
    const replicas = await syncConnectionSecretReplicasById(
      binding.connectionId,
      params.backend
    );
    const replica = replicas.find(
      (item) =>
        item.backendKind === params.backend.kind &&
        item.backendRegion === (params.backend.region || "") &&
        item.backendProjectId === (params.backend.projectId || "")
    );

    if (!replica || replica.status !== "active") {
      continue;
    }

    descriptors.push({
      providerSlug: binding.providerSlug,
      connectionId: binding.connectionId,
      runtimeSecretRef: replica.runtimeSecretRef,
      controlSecretRef: replica.controlSecretRef,
      backendKind: replica.backendKind,
      backendRegion: replica.backendRegion || undefined,
      backendProjectId: replica.backendProjectId || undefined,
    });
  }

  return descriptors;
}
