import type {
  AuthClient,
  WorkflowDeployAuthMode,
  WorkflowDeployAuthModeInput,
  WorkflowHttpMethod,
  WorkflowRuntimeLocalCacheConfig,
  WorkflowRuntimeAuthManifestProvider,
  WorkflowRuntimeAuthOptions,
  WorkflowRuntimeSecretValue,
  WorkflowRequestResult,
  WorkflowRuntimeIdentity,
} from "./types.js";

const DEFAULT_AUTH_SERVICE_URL = "http://localhost:4000";
const RUNTIME_HEADER_NAMES = {
  workflowId: "x-gtmship-workflow-id",
  deploymentId: "x-gtmship-deployment-id",
  executionId: "x-gtmship-execution-id",
  runId: "x-gtmship-run-id",
  runtimeKey: "x-gtmship-runtime-key",
} as const;
const RUNTIME_AUTH_ENV_NAMES = {
  mode: "GTMSHIP_RUNTIME_AUTH_MODE",
  backendKind: "GTMSHIP_SECRET_BACKEND_KIND",
  backendRegion: "GTMSHIP_SECRET_BACKEND_REGION",
  backendProjectId: "GTMSHIP_SECRET_BACKEND_PROJECT_ID",
  backendSecretPrefix: "GTMSHIP_SECRET_PREFIX",
  runtimeAccess: "GTMSHIP_SECRET_RUNTIME_ACCESS",
  manifest: "GTMSHIP_RUNTIME_AUTH_MANIFEST",
  inlineSecrets: "GTMSHIP_RUNTIME_AUTH_SECRETS",
  localCacheKey: "GTMSHIP_LOCAL_CACHE_KEY",
  localCachePath: "GTMSHIP_LOCAL_CACHE_PATH",
  localCacheTtlSeconds: "GTMSHIP_LOCAL_CACHE_TTL_SECONDS",
} as const;
const localRuntimeSecretCache = new Map<string, WorkflowRuntimeSecretValue>();

interface WorkflowRuntimeSecretCacheFile {
  version: 1;
  entries: Record<
    string,
    {
      updatedAt: string;
      value: string;
    }
  >;
}

interface ResolvedLocalCacheConfig {
  path?: string;
  ttlSeconds: number;
  encryptionKey?: string;
}

export function resolveAuthServiceUrl(explicitUrl?: string): string {
  return explicitUrl || process.env.GTMSHIP_AUTH_URL || DEFAULT_AUTH_SERVICE_URL;
}

export function normalizeDeployAuthMode(
  mode?: WorkflowDeployAuthModeInput
): WorkflowDeployAuthMode {
  if (mode === "secret_manager" || mode === "synced_secrets") {
    return "secret_manager";
  }

  return "proxy";
}

function parseJsonEnv<T>(name: string): T | undefined {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function toRecordHeaders(headers?: RequestInit["headers"]): Record<string, string> {
  if (!headers) {
    return {};
  }

  if (headers instanceof Headers) {
    const normalized: Record<string, string> = {};
    headers.forEach((value, key) => {
      normalized[key] = value;
    });
    return normalized;
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  return { ...(headers as Record<string, string>) };
}

function normalizeDefaultHeaders(
  value: unknown
): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([key, headerValue]) =>
      key.trim().length > 0 &&
      typeof headerValue === "string" &&
      headerValue.trim().length > 0
  );

  return entries.length > 0
    ? Object.fromEntries(entries) as Record<string, string>
    : undefined;
}

function normalizeProviderPath(path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  return path.startsWith("/") ? path : `/${path}`;
}

function joinBaseUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  return `${baseUrl.replace(/\/+$/, "")}${normalizeProviderPath(path)}`;
}

function hasSecretManagerHints(config?: WorkflowRuntimeAuthOptions): boolean {
  return Boolean(
    config?.backend?.kind ||
      config?.runtimeAccess ||
      config?.manifest?.providers?.length ||
      config?.resolveSecret ||
      config?.localCache?.path ||
      config?.localCache?.encryptionKey
  );
}

function parseNumberEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeLocalCacheConfig(
  explicit?: WorkflowRuntimeLocalCacheConfig
): ResolvedLocalCacheConfig {
  return {
    path:
      explicit?.path || process.env[RUNTIME_AUTH_ENV_NAMES.localCachePath],
    ttlSeconds:
      explicit?.ttlSeconds ||
      parseNumberEnv(RUNTIME_AUTH_ENV_NAMES.localCacheTtlSeconds) ||
      3600,
    encryptionKey:
      explicit?.encryptionKey ||
      process.env[RUNTIME_AUTH_ENV_NAMES.localCacheKey],
  };
}

async function getDefaultLocalCachePath(): Promise<string | undefined> {
  if (
    typeof process === "undefined" ||
    !process.versions?.node
  ) {
    return undefined;
  }

  const [{ homedir }, pathModule] = await Promise.all([
    import("node:os"),
    import("node:path"),
  ]);
  return pathModule.join(homedir(), ".gtmship", "runtime-auth-cache.json");
}

function resolveRuntimeAuthOptions(
  explicit?: WorkflowRuntimeAuthOptions
): WorkflowRuntimeAuthOptions | undefined {
  const envMode = process.env[
    RUNTIME_AUTH_ENV_NAMES.mode
  ] as WorkflowDeployAuthModeInput | undefined;
  const envBackendKind = process.env[
    RUNTIME_AUTH_ENV_NAMES.backendKind
  ] as NonNullable<WorkflowRuntimeAuthOptions["backend"]>["kind"] | undefined;
  const envRuntimeAccess = process.env[
    RUNTIME_AUTH_ENV_NAMES.runtimeAccess
  ] as WorkflowRuntimeAuthOptions["runtimeAccess"] | undefined;
  const envManifest = parseJsonEnv<WorkflowRuntimeAuthOptions["manifest"]>(
    RUNTIME_AUTH_ENV_NAMES.manifest
  );
  const envConfig: WorkflowRuntimeAuthOptions = {
    mode: envMode,
    backend:
      envBackendKind ||
      process.env[RUNTIME_AUTH_ENV_NAMES.backendRegion] ||
      process.env[RUNTIME_AUTH_ENV_NAMES.backendProjectId] ||
      process.env[RUNTIME_AUTH_ENV_NAMES.backendSecretPrefix]
        ? {
            kind: envBackendKind,
            region: process.env[RUNTIME_AUTH_ENV_NAMES.backendRegion],
            projectId: process.env[RUNTIME_AUTH_ENV_NAMES.backendProjectId],
            secretPrefix: process.env[RUNTIME_AUTH_ENV_NAMES.backendSecretPrefix],
          }
        : undefined,
    runtimeAccess: envRuntimeAccess,
    manifest: envManifest,
    localCache: normalizeLocalCacheConfig(),
  };
  const hinted = hasSecretManagerHints(explicit) || hasSecretManagerHints(envConfig);
  const modeInput = explicit?.mode || envConfig.mode || (hinted ? "secret_manager" : undefined);

  if (!modeInput && !hinted) {
    return undefined;
  }

  return {
    mode: normalizeDeployAuthMode(modeInput || "secret_manager"),
    backend: {
      ...(envConfig.backend || {}),
      ...(explicit?.backend || {}),
    },
    runtimeAccess:
      explicit?.runtimeAccess ||
      envConfig.runtimeAccess ||
      (normalizeDeployAuthMode(modeInput || "secret_manager") === "secret_manager"
        ? "direct"
        : undefined),
    manifest: explicit?.manifest || envConfig.manifest,
    resolveSecret: explicit?.resolveSecret,
    localCache: {
      ...(envConfig.localCache || {}),
      ...(explicit?.localCache || {}),
    },
  };
}

function getManifestEntry(
  providerSlug: string,
  runtimeAuth?: WorkflowRuntimeAuthOptions
): WorkflowRuntimeAuthManifestProvider | undefined {
  return runtimeAuth?.manifest?.providers?.find(
    (entry) => entry.providerSlug === providerSlug
  );
}

function getInlineSecretFromEnv(
  providerSlug: string
): WorkflowRuntimeSecretValue | null {
  const inline = parseJsonEnv<Record<string, WorkflowRuntimeSecretValue>>(
    RUNTIME_AUTH_ENV_NAMES.inlineSecrets
  );
  if (!inline || typeof inline !== "object") {
    return null;
  }

  return inline[providerSlug] || null;
}

function getSecretCacheKey(
  providerSlug: string,
  runtimeAuth?: WorkflowRuntimeAuthOptions,
  manifestEntry?: WorkflowRuntimeAuthManifestProvider
): string {
  return [
    runtimeAuth?.backend?.kind || "none",
    runtimeAuth?.backend?.region || "none",
    runtimeAuth?.backend?.projectId || "none",
    runtimeAuth?.backend?.secretPrefix || "none",
    manifestEntry?.secretRef || "none",
    providerSlug,
  ].join("|");
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

function buildDefaultSecretRef(
  providerSlug: string,
  manifestEntry: WorkflowRuntimeAuthManifestProvider | undefined,
  runtimeAuth?: WorkflowRuntimeAuthOptions
): string | undefined {
  if (manifestEntry?.secretRef) {
    return manifestEntry.secretRef;
  }

  if (!manifestEntry?.connectionId) {
    return undefined;
  }

  const prefix = runtimeAuth?.backend?.secretPrefix || "gtmship-connections";
  if (runtimeAuth?.backend?.kind === "gcp_secret_manager") {
    const secretId = sanitizeSecretId(
      `${prefix}-${providerSlug}-${manifestEntry.connectionId}`
    );
    const fullSecretId = `${secretId}-runtime`;
    return runtimeAuth.backend.projectId
      ? `projects/${runtimeAuth.backend.projectId}/secrets/${fullSecretId}`
      : fullSecretId;
  }

  return `${sanitizeSegment(prefix)}/${sanitizeSegment(
    providerSlug
  )}/${sanitizeSegment(manifestEntry.connectionId)}/runtime`;
}

function normalizeSecretPayload(
  value: unknown
): WorkflowRuntimeSecretValue | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  return {
    accessToken:
      typeof record.accessToken === "string" ? record.accessToken : undefined,
    apiKey: typeof record.apiKey === "string" ? record.apiKey : undefined,
    username:
      typeof record.username === "string" ? record.username : undefined,
    password:
      typeof record.password === "string" ? record.password : undefined,
    authType:
      record.authType === "oauth2" ||
      record.authType === "api_key" ||
      record.authType === "basic"
        ? record.authType
        : undefined,
    headerName:
      typeof record.headerName === "string" ? record.headerName : undefined,
    defaultHeaders: normalizeDefaultHeaders(record.defaultHeaders),
    baseUrl: typeof record.baseUrl === "string" ? record.baseUrl : undefined,
    instanceUrl:
      typeof record.instanceUrl === "string" ? record.instanceUrl : undefined,
  };
}

async function fetchAwsRuntimeSecret(
  secretRef: string,
  region?: string
): Promise<WorkflowRuntimeSecretValue | null> {
  const awsModule = (await import(
    "@aws-sdk/client-secrets-manager"
  )) as unknown as {
    SecretsManagerClient: new (config?: Record<string, unknown>) => {
      send(command: unknown): Promise<{
        SecretString?: string;
        SecretBinary?: Uint8Array;
      }>;
    };
    GetSecretValueCommand: new (input: Record<string, unknown>) => unknown;
  };
  const client = new awsModule.SecretsManagerClient({
    region: region || process.env.AWS_REGION || "us-east-1",
  });
  const response = await client.send(
    new awsModule.GetSecretValueCommand({
      SecretId: secretRef,
    })
  );

  const rawValue =
    typeof response.SecretString === "string"
      ? response.SecretString
      : response.SecretBinary
        ? Buffer.from(response.SecretBinary).toString("utf8")
        : null;

  if (!rawValue) {
    return null;
  }

  return normalizeSecretPayload(JSON.parse(rawValue));
}

function normalizeGcpSecretName(secretRef: string, projectId?: string): string {
  if (secretRef.startsWith("projects/")) {
    return secretRef.includes("/versions/")
      ? secretRef
      : `${secretRef}/versions/latest`;
  }

  if (!projectId) {
    throw new Error(
      `GCP secret-manager auth needs backend.projectId when secretRef is not fully qualified (${secretRef}).`
    );
  }

  const base = `projects/${projectId}/secrets/${secretRef}`;
  return `${base}/versions/latest`;
}

async function fetchGcpRuntimeSecret(
  secretRef: string,
  projectId?: string
): Promise<WorkflowRuntimeSecretValue | null> {
  const gcpModule = (await import("@google-cloud/secret-manager")) as {
    SecretManagerServiceClient: new (config?: Record<string, unknown>) => {
      accessSecretVersion(args: Record<string, unknown>): Promise<
        Array<{
          payload?: {
            data?: Uint8Array | Buffer;
          };
        }>
      >;
    };
  };
  const client = new gcpModule.SecretManagerServiceClient();
  const [response] = await client.accessSecretVersion({
    name: normalizeGcpSecretName(secretRef, projectId),
  });
  const rawValue = response.payload?.data
    ? Buffer.from(response.payload.data).toString("utf8")
    : null;

  if (!rawValue) {
    return null;
  }

  return normalizeSecretPayload(JSON.parse(rawValue));
}

async function resolveSecretFromBackend(
  providerSlug: string,
  runtimeAuth?: WorkflowRuntimeAuthOptions,
  manifestEntry?: WorkflowRuntimeAuthManifestProvider
): Promise<WorkflowRuntimeSecretValue | null> {
  if (!runtimeAuth?.backend?.kind) {
    return null;
  }

  const secretRef = buildDefaultSecretRef(providerSlug, manifestEntry, runtimeAuth);
  if (!secretRef) {
    return null;
  }

  if (runtimeAuth.backend.kind === "aws_secrets_manager") {
    return fetchAwsRuntimeSecret(secretRef, runtimeAuth.backend.region);
  }

  return fetchGcpRuntimeSecret(secretRef, runtimeAuth.backend.projectId);
}

async function encryptCacheValue(
  value: WorkflowRuntimeSecretValue,
  encryptionKey: string
): Promise<string> {
  const cryptoModule = await import("node:crypto");
  const key = cryptoModule
    .createHash("sha256")
    .update(encryptionKey)
    .digest();
  const iv = cryptoModule.randomBytes(12);
  const cipher = cryptoModule.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

async function decryptCacheValue(
  value: string,
  encryptionKey: string
): Promise<WorkflowRuntimeSecretValue | null> {
  const cryptoModule = await import("node:crypto");
  const key = cryptoModule
    .createHash("sha256")
    .update(encryptionKey)
    .digest();
  const buffer = Buffer.from(value, "base64");
  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const ciphertext = buffer.subarray(28);
  const decipher = cryptoModule.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
  return normalizeSecretPayload(JSON.parse(plaintext));
}

async function readCachedRuntimeSecret(
  cacheKey: string,
  localCache?: WorkflowRuntimeLocalCacheConfig
): Promise<WorkflowRuntimeSecretValue | null> {
  if (
    typeof process === "undefined" ||
    !process.versions?.node
  ) {
    return null;
  }

  const config = normalizeLocalCacheConfig(localCache);
  const cachePath = config.path || (await getDefaultLocalCachePath());
  if (!cachePath || !config.encryptionKey) {
    return null;
  }

  const { readFile } = await import("node:fs/promises");
  try {
    const file = JSON.parse(
      await readFile(cachePath, "utf8")
    ) as WorkflowRuntimeSecretCacheFile;
    const entry = file.entries?.[cacheKey];
    if (!entry) {
      return null;
    }

    const ageSeconds =
      (Date.now() - new Date(entry.updatedAt).getTime()) / 1000;
    if (!Number.isFinite(ageSeconds) || ageSeconds > config.ttlSeconds) {
      return null;
    }

    return decryptCacheValue(entry.value, config.encryptionKey);
  } catch {
    return null;
  }
}

async function writeCachedRuntimeSecret(
  cacheKey: string,
  secret: WorkflowRuntimeSecretValue,
  localCache?: WorkflowRuntimeLocalCacheConfig
): Promise<void> {
  if (
    typeof process === "undefined" ||
    !process.versions?.node
  ) {
    return;
  }

  const config = normalizeLocalCacheConfig(localCache);
  const cachePath = config.path || (await getDefaultLocalCachePath());
  if (!cachePath || !config.encryptionKey) {
    return;
  }

  const [{ dirname }, { mkdir, readFile, writeFile }] = await Promise.all([
    import("node:path"),
    import("node:fs/promises"),
  ]);
  const encryptedValue = await encryptCacheValue(secret, config.encryptionKey);
  let file: WorkflowRuntimeSecretCacheFile = {
    version: 1,
    entries: {},
  };

  try {
    file = JSON.parse(
      await readFile(cachePath, "utf8")
    ) as WorkflowRuntimeSecretCacheFile;
  } catch {
    // Start from a fresh cache file.
  }

  file.entries = file.entries || {};
  file.entries[cacheKey] = {
    updatedAt: new Date().toISOString(),
    value: encryptedValue,
  };

  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(file, null, 2), "utf8");
}

async function resolveRuntimeSecret(
  providerSlug: string,
  runtimeAuth?: WorkflowRuntimeAuthOptions
): Promise<{
  secret: WorkflowRuntimeSecretValue;
  manifestEntry?: WorkflowRuntimeAuthManifestProvider;
}> {
  const manifestEntry = getManifestEntry(providerSlug, runtimeAuth);
  const useCache = runtimeAuth?.runtimeAccess === "local_cache";
  const cacheKey = getSecretCacheKey(providerSlug, runtimeAuth, manifestEntry);

  if (useCache && localRuntimeSecretCache.has(cacheKey)) {
    return {
      secret: localRuntimeSecretCache.get(cacheKey) as WorkflowRuntimeSecretValue,
      manifestEntry,
    };
  }

  let secret: WorkflowRuntimeSecretValue | null = null;
  let resolutionError: Error | null = null;

  try {
    if (runtimeAuth?.resolveSecret) {
      secret = await runtimeAuth.resolveSecret({
        providerSlug,
        backend: runtimeAuth.backend,
        runtimeAccess: runtimeAuth.runtimeAccess,
        manifestEntry,
      });
    }
  } catch (error) {
    resolutionError =
      error instanceof Error ? error : new Error(String(error));
  }

  if (!secret) {
    try {
      secret = await resolveSecretFromBackend(
        providerSlug,
        runtimeAuth,
        manifestEntry
      );
    } catch (error) {
      resolutionError =
        error instanceof Error ? error : new Error(String(error));
    }
  }

  if (!secret) {
    secret = getInlineSecretFromEnv(providerSlug);
  }

  if (!secret && useCache) {
    const cachedSecret = await readCachedRuntimeSecret(
      cacheKey,
      runtimeAuth?.localCache
    );
    if (cachedSecret) {
      localRuntimeSecretCache.set(cacheKey, cachedSecret);
      return {
        secret: cachedSecret,
        manifestEntry,
      };
    }
  }

  if (!secret) {
    if (resolutionError) {
      throw resolutionError;
    }

    throw new Error(
      `No runtime secret could be resolved for ${providerSlug}. Configure runtimeAuth.resolveSecret, backend access, or GTMSHIP_RUNTIME_AUTH_SECRETS.`
    );
  }

  localRuntimeSecretCache.set(cacheKey, secret);

  if (useCache) {
    await writeCachedRuntimeSecret(cacheKey, secret, runtimeAuth?.localCache);
  }

  return { secret, manifestEntry };
}

function encodeBasicCredentials(username: string, password: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(`${username}:${password}`).toString("base64");
  }

  if (typeof btoa === "function") {
    return btoa(`${username}:${password}`);
  }

  throw new Error("Unable to encode basic auth credentials in this runtime.");
}

function encodeBasicToken(token: string): string {
  const normalizedToken = token.includes(":") ? token : `${token}:`;
  if (typeof Buffer !== "undefined") {
    return Buffer.from(normalizedToken).toString("base64");
  }

  if (typeof btoa === "function") {
    return btoa(normalizedToken);
  }

  throw new Error("Unable to encode basic auth token in this runtime.");
}

function formatApiKeyHeaderValue(
  token: string,
  headerName?: string
): string {
  if (/^(Bearer|Basic)\s+/i.test(token)) {
    return token;
  }

  return (headerName || "").toLowerCase() === "authorization"
    ? `Bearer ${token}`
    : token;
}

function buildDirectAuthHeaders(
  providerSlug: string,
  secret: WorkflowRuntimeSecretValue,
  manifestEntry?: WorkflowRuntimeAuthManifestProvider
): Record<string, string> {
  const authType = manifestEntry?.authType || secret.authType || "oauth2";
  const defaultHeaders = {
    ...(manifestEntry?.defaultHeaders || {}),
    ...(secret.defaultHeaders || {}),
  };

  switch (authType) {
    case "api_key": {
      const token = secret.apiKey || secret.accessToken;
      if (!token) {
        throw new Error(
          `Missing api_key token for ${providerSlug} in secret-manager mode.`
        );
      }
      const headerName = manifestEntry?.headerName || secret.headerName || "X-API-Key";
      return {
        ...defaultHeaders,
        [headerName]: formatApiKeyHeaderValue(token, headerName),
      };
    }
    case "basic": {
      if (secret.username && secret.password) {
        return {
          ...defaultHeaders,
          Authorization: `Basic ${encodeBasicCredentials(
            secret.username,
            secret.password
          )}`,
        };
      }

      if (secret.accessToken) {
        if (/^Basic\s+/i.test(secret.accessToken)) {
          return { Authorization: secret.accessToken };
        }

        return {
          ...defaultHeaders,
          Authorization: `Basic ${encodeBasicToken(secret.accessToken)}`,
        };
      }

      throw new Error(
        `Missing basic auth credentials for ${providerSlug} in secret-manager mode.`
      );
    }
    case "oauth2":
    default: {
      const token = secret.accessToken || secret.apiKey;
      if (!token) {
        throw new Error(
          `Missing oauth2 access token for ${providerSlug} in secret-manager mode.`
        );
      }
      return { ...defaultHeaders, Authorization: `Bearer ${token}` };
    }
  }
}

function resolveProviderBaseUrl(
  providerSlug: string,
  secret: WorkflowRuntimeSecretValue,
  manifestEntry?: WorkflowRuntimeAuthManifestProvider
): string {
  const baseUrl =
    manifestEntry?.instanceUrl ||
    secret.instanceUrl ||
    manifestEntry?.baseUrl ||
    secret.baseUrl;

  if (!baseUrl) {
    throw new Error(
      `Missing base URL for ${providerSlug} in secret-manager mode. Include it in manifest or resolved secret.`
    );
  }

  return baseUrl;
}

async function makeSecretManagerIntegrationRequest<T>(
  providerSlug: string,
  method: WorkflowHttpMethod,
  path: string,
  data?: unknown,
  options?: {
    headers?: RequestInit["headers"];
    runtimeAuth?: WorkflowRuntimeAuthOptions;
  }
): Promise<WorkflowRequestResult<T>> {
  const runtimeAuth = resolveRuntimeAuthOptions(options?.runtimeAuth);
  const { secret, manifestEntry } = await resolveRuntimeSecret(
    providerSlug,
    runtimeAuth
  );
  const baseUrl = resolveProviderBaseUrl(providerSlug, secret, manifestEntry);
  const url = joinBaseUrl(baseUrl, normalizeProviderPath(path));
  const baseHeaders = buildDirectAuthHeaders(providerSlug, secret, manifestEntry);
  const userHeaders = toRecordHeaders(options?.headers);
  const requestHeaders: Record<string, string> = {
    ...baseHeaders,
    ...userHeaders,
  };
  const bodyAllowed = method !== "GET" && method !== "HEAD";

  if (bodyAllowed && !Object.keys(requestHeaders).some((name) => name.toLowerCase() === "content-type")) {
    requestHeaders["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    method,
    headers: requestHeaders,
    body: bodyAllowed
      ? typeof data === "string"
        ? data
        : data === undefined
          ? undefined
          : JSON.stringify(data)
      : undefined,
  });

  return {
    data: (await parseResponseData(response)) as T,
    status: response.status,
  };
}

export function resolveIntegrationOperationUrl(
  providerSlug: string,
  path: string,
  options?: {
    authServiceUrl?: string;
    runtimeAuth?: WorkflowRuntimeAuthOptions;
  }
): string {
  const runtimeAuth = resolveRuntimeAuthOptions(options?.runtimeAuth);
  const normalizedPath = normalizeProviderPath(path);

  if (runtimeAuth?.mode === "secret_manager") {
    const manifestEntry = getManifestEntry(providerSlug, runtimeAuth);
    const baseUrl = manifestEntry?.instanceUrl || manifestEntry?.baseUrl;
    return baseUrl
      ? joinBaseUrl(baseUrl, normalizedPath)
      : `secret-manager://${providerSlug}${normalizedPath}`;
  }

  const authServiceUrl = resolveAuthServiceUrl(options?.authServiceUrl);
  return `${authServiceUrl}/proxy/${providerSlug}${normalizedPath}`;
}

export function resolveRuntimeIdentity(
  explicitRuntime?: WorkflowRuntimeIdentity
): WorkflowRuntimeIdentity | undefined {
  const runtime: WorkflowRuntimeIdentity = {
    workflowId: explicitRuntime?.workflowId || process.env.GTMSHIP_WORKFLOW_ID,
    deploymentId:
      explicitRuntime?.deploymentId || process.env.GTMSHIP_DEPLOYMENT_ID,
    executionId:
      explicitRuntime?.executionId || process.env.GTMSHIP_EXECUTION_ID,
    runId: explicitRuntime?.runId || process.env.GTMSHIP_RUN_ID,
    runtimeKey: explicitRuntime?.runtimeKey || process.env.GTMSHIP_RUNTIME_KEY,
  };

  return (
    runtime.workflowId ||
    runtime.deploymentId ||
    runtime.executionId ||
    runtime.runId ||
    runtime.runtimeKey
  )
    ? runtime
    : undefined;
}

export function buildRuntimeHeaders(
  explicitRuntime?: WorkflowRuntimeIdentity
): Record<string, string> {
  const runtime = resolveRuntimeIdentity(explicitRuntime);
  if (!runtime) {
    return {};
  }

  const headers: Record<string, string> = {};
  if (runtime.workflowId) {
    headers[RUNTIME_HEADER_NAMES.workflowId] = runtime.workflowId;
  }
  if (runtime.deploymentId) {
    headers[RUNTIME_HEADER_NAMES.deploymentId] = runtime.deploymentId;
  }
  if (runtime.executionId) {
    headers[RUNTIME_HEADER_NAMES.executionId] = runtime.executionId;
  }
  if (runtime.runId) {
    headers[RUNTIME_HEADER_NAMES.runId] = runtime.runId;
  }
  if (runtime.runtimeKey) {
    headers[RUNTIME_HEADER_NAMES.runtimeKey] = runtime.runtimeKey;
  }

  return headers;
}

export async function parseResponseData(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") || "";

  if (response.status === 204) {
    return null;
  }

  if (contentType.includes("application/json")) {
    return response.json();
  }

  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function makeIntegrationRequest<T>(
  providerSlug: string,
  method: WorkflowHttpMethod,
  path: string,
  data?: unknown,
  options?: {
    headers?: RequestInit["headers"];
    authServiceUrl?: string;
    runtime?: WorkflowRuntimeIdentity;
    runtimeAuth?: WorkflowRuntimeAuthOptions;
  }
): Promise<WorkflowRequestResult<T>> {
  const runtimeAuth = resolveRuntimeAuthOptions(options?.runtimeAuth);
  if (runtimeAuth?.mode === "secret_manager") {
    return makeSecretManagerIntegrationRequest<T>(providerSlug, method, path, data, {
      headers: options?.headers,
      runtimeAuth,
    });
  }

  const baseUrl = `${resolveAuthServiceUrl(
    options?.authServiceUrl
  )}/proxy/${providerSlug}`;
  const response = await fetch(`${baseUrl}${normalizeProviderPath(path)}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...buildRuntimeHeaders(options?.runtime),
      ...options?.headers,
    },
    body:
      data === undefined || method === "GET" || method === "HEAD"
        ? undefined
        : JSON.stringify(data),
  });

  return {
    data: (await parseResponseData(response)) as T,
    status: response.status,
  };
}

/**
 * Auth module — provides authenticated HTTP clients for connected platforms.
 *
 * Usage:
 *   const hubspot = await auth.getClient("hubspot");
 *   const contacts = await hubspot.get("/crm/v3/objects/contacts");
 */
export const auth = {
  /**
   * Get an authenticated HTTP client for a connected platform.
   * In `proxy` mode requests are forwarded through auth-service.
   * In `secret_manager` mode requests go directly to the provider API
   * using runtime-resolved credentials.
   */
  async getClient(
    providerSlug: string,
    options?: {
      authServiceUrl?: string;
      runtime?: WorkflowRuntimeIdentity;
      runtimeAuth?: WorkflowRuntimeAuthOptions;
    }
  ): Promise<AuthClient> {
    return {
      get: (path, config) =>
        makeIntegrationRequest(providerSlug, "GET", path, undefined, {
          ...config,
          authServiceUrl: options?.authServiceUrl,
          runtime: options?.runtime,
          runtimeAuth: options?.runtimeAuth,
        }),
      post: (path, data, config) =>
        makeIntegrationRequest(providerSlug, "POST", path, data, {
          ...config,
          authServiceUrl: options?.authServiceUrl,
          runtime: options?.runtime,
          runtimeAuth: options?.runtimeAuth,
        }),
      put: (path, data, config) =>
        makeIntegrationRequest(providerSlug, "PUT", path, data, {
          ...config,
          authServiceUrl: options?.authServiceUrl,
          runtime: options?.runtime,
          runtimeAuth: options?.runtimeAuth,
        }),
      patch: (path, data, config) =>
        makeIntegrationRequest(providerSlug, "PATCH", path, data, {
          ...config,
          authServiceUrl: options?.authServiceUrl,
          runtime: options?.runtime,
          runtimeAuth: options?.runtimeAuth,
        }),
      delete: (path, config) =>
        makeIntegrationRequest(providerSlug, "DELETE", path, undefined, {
          ...config,
          authServiceUrl: options?.authServiceUrl,
          runtime: options?.runtime,
          runtimeAuth: options?.runtimeAuth,
        }),
    };
  },

  /**
   * Get a raw access token for a connected platform.
   * Use this when you need to pass the token to a third-party SDK.
   */
  async getToken(
    providerSlug: string,
    options?: {
      authServiceUrl?: string;
      runtime?: WorkflowRuntimeIdentity;
      runtimeAuth?: WorkflowRuntimeAuthOptions;
    }
  ): Promise<string> {
    const runtimeAuth = resolveRuntimeAuthOptions(options?.runtimeAuth);
    if (runtimeAuth?.mode === "secret_manager") {
      const { secret } = await resolveRuntimeSecret(providerSlug, runtimeAuth);
      const token = secret.accessToken || secret.apiKey;
      if (!token) {
        throw new Error(
          `No token material available for ${providerSlug} in secret-manager mode.`
        );
      }
      return token;
    }

    const response = await fetch(
      `${resolveAuthServiceUrl(
        options?.authServiceUrl
      )}/connections/${providerSlug}/token`,
      {
        headers: buildRuntimeHeaders(options?.runtime),
      }
    );
    if (!response.ok) {
      throw new Error(
        `Failed to get token for ${providerSlug}: ${response.statusText}`
      );
    }
    const data = (await response.json()) as { access_token: string };
    return data.access_token;
  },
};
