import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { parse as parseYaml } from "yaml";
import {
  planWorkflowDeployment,
  type DeployTarget,
  type TriggerConfig,
  type WorkflowBinding,
  type WorkflowBindingSelector,
  type WorkflowCloudProvider,
  type WorkflowDeploymentPlan,
  type WorkflowTriggerConfiguration,
} from "@gtmship/deploy-engine/planner";

interface RawProjectConfig {
  name?: string;
  auth?: {
    url?: string;
  };
  deploy?: Record<string, unknown>;
  workflows?: Record<
    string,
    {
      deploy?: Record<string, unknown>;
      trigger_config?: Record<string, unknown>;
      triggerConfig?: Record<string, unknown>;
      bindings?: unknown;
    }
  >;
}

interface WorkflowStudioMetadata {
  artifact?: {
    requiredAccesses?: Array<{
      providerSlug?: string;
    }>;
    deploy?: DeployTarget;
    triggerConfig?: WorkflowTriggerConfiguration;
    bindings?: WorkflowBinding[];
  };
}

interface LoadedWorkflowDefinition {
  id?: string;
  name?: string;
  trigger?: TriggerConfig;
  deploy?: DeployTarget;
  triggerConfig?: WorkflowTriggerConfiguration;
  bindings?: WorkflowBinding[];
}

export interface WorkflowProjectConfig {
  name?: string;
  authUrl?: string;
  deploy?: DeployTarget;
  workflows: Record<
    string,
    {
      deploy?: DeployTarget;
      triggerConfig?: WorkflowTriggerConfiguration;
      bindings?: WorkflowBinding[];
    }
  >;
}

export interface WorkflowPlanLoaderOptions {
  providerOverride?: WorkflowCloudProvider;
  regionOverride?: string;
  gcpProjectOverride?: string;
  workflowId?: string;
  baseUrl?: string;
  connections?: Array<{ id: string; label?: string | null; status: string; createdAt?: string; provider: { slug: string; name?: string } }>;
}

export interface WorkflowPlanRecord {
  workflowId: string;
  workflowName?: string;
  filePath: string;
  source: string;
  plan: WorkflowDeploymentPlan;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function toStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toNumberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function normalizeBindingSelector(
  value: unknown
): WorkflowBindingSelector | undefined {
  const record = asRecord(value);
  const type = toStringValue(record.type) || "latest_active";

  if (type === "connection_id") {
    return {
      type,
      connectionId:
        toStringValue(record.connectionId) || toStringValue(record.value),
    };
  }

  if (type === "label") {
    return {
      type,
      label: toStringValue(record.label) || toStringValue(record.value),
    };
  }

  return { type: "latest_active" };
}

function normalizeBindings(value: unknown): WorkflowBinding[] | undefined {
  if (!value) {
    return undefined;
  }

  if (Array.isArray(value)) {
    const bindings = value
      .map((item) => {
        const record = asRecord(item);
        const providerSlug = toStringValue(record.providerSlug);
        if (!providerSlug) {
          return null;
        }

        return {
          providerSlug,
          selector:
            normalizeBindingSelector(record.selector || record) || {
              type: "latest_active",
            },
        } satisfies WorkflowBinding;
      })
      .filter(Boolean) as WorkflowBinding[];

    return bindings.length > 0 ? bindings : undefined;
  }

  const record = asRecord(value);
  const bindings = Object.entries(record)
    .map(([providerSlug, bindingValue]) => {
      const bindingRecord = asRecord(bindingValue);
      return {
        providerSlug,
        selector:
          normalizeBindingSelector(bindingRecord.selector || bindingRecord) || {
            type: "latest_active",
          },
      } satisfies WorkflowBinding;
    })
    .filter(Boolean);

  return bindings.length > 0 ? bindings : undefined;
}

function normalizeDeployTarget(value: unknown): DeployTarget | undefined {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) {
    return undefined;
  }

  const execution = asRecord(record.execution);
  const auth = asRecord(record.auth);
  const backend = asRecord(auth.backend);
  const deploy: DeployTarget = {};

  const provider = toStringValue(record.provider);
  if (provider === "aws" || provider === "gcp" || provider === "local") {
    deploy.provider = provider;
  }

  deploy.region = toStringValue(record.region);
  deploy.gcpProject =
    toStringValue(record.gcpProject) || toStringValue(record.gcp_project);
  deploy.timeoutSeconds =
    toNumberValue(record.timeoutSeconds) || toNumberValue(record.timeout_seconds);

  if (hasValue(record.memory)) {
    deploy.memory = record.memory as number | string;
  }
  if (hasValue(record.cpu)) {
    deploy.cpu = record.cpu as number | string;
  }

  const kind = toStringValue(execution.kind);
  const authMode = toStringValue(auth.mode);
  const runtimeAccess =
    toStringValue(auth.runtimeAccess) || toStringValue(auth.runtime_access);
  const backendKind =
    toStringValue(backend.kind) || toStringValue(auth.backend_kind);
  const backendRegion =
    toStringValue(backend.region) || toStringValue(auth.backend_region);
  const backendProjectId =
    toStringValue(backend.projectId) ||
    toStringValue(backend.project_id) ||
    toStringValue(auth.backend_project_id);
  const backendSecretPrefix =
    toStringValue(backend.secretPrefix) ||
    toStringValue(backend.secret_prefix) ||
    toStringValue(auth.secret_prefix);

  if (
    kind === "service" ||
    kind === "job" ||
    hasValue(execution.timeoutSeconds) ||
    hasValue(execution.memory) ||
    hasValue(execution.cpu)
  ) {
    deploy.execution = {
      kind: kind === "service" || kind === "job" ? kind : undefined,
      timeoutSeconds: toNumberValue(execution.timeoutSeconds),
      memory: execution.memory as number | string | undefined,
      cpu: execution.cpu as number | string | undefined,
    };
  }

  const normalizedAuthMode =
    authMode === "synced_secrets" ? "secret_manager" : authMode;
  const hasSecretManagerHints = Boolean(
    backendKind || runtimeAccess || backendRegion || backendProjectId || backendSecretPrefix
  );

  if (
    normalizedAuthMode === "proxy" ||
    normalizedAuthMode === "secret_manager" ||
    hasSecretManagerHints
  ) {
    deploy.auth = {
      mode:
        normalizedAuthMode === "proxy" || normalizedAuthMode === "secret_manager"
          ? normalizedAuthMode
          : hasSecretManagerHints
            ? "secret_manager"
            : undefined,
      runtimeAccess:
        runtimeAccess === "direct" || runtimeAccess === "local_cache"
          ? runtimeAccess
          : undefined,
      backend:
        backendKind ||
        backendRegion ||
        backendProjectId ||
        backendSecretPrefix
          ? {
              kind:
                backendKind === "aws_secrets_manager" ||
                backendKind === "gcp_secret_manager"
                  ? backendKind
                  : undefined,
              region: backendRegion,
              projectId: backendProjectId,
              secretPrefix: backendSecretPrefix,
            }
          : undefined,
    };
  }

  return deploy;
}

function normalizeTriggerConfig(
  value: unknown
): WorkflowTriggerConfiguration | undefined {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) {
    return undefined;
  }

  const schedule = asRecord(record.schedule);
  const webhook = asRecord(record.webhook);
  const signature = asRecord(webhook.signature);
  const event = asRecord(record.event);
  const triggerConfig: WorkflowTriggerConfiguration = {};

  if (Object.keys(schedule).length > 0) {
    triggerConfig.schedule = {
      cron: toStringValue(schedule.cron),
      timezone: toStringValue(schedule.timezone),
      payload:
        schedule.payload ??
        schedule.defaultPayload ??
        schedule.default_payload,
    };
  }

  if (Object.keys(webhook).length > 0) {
    const access =
      toStringValue(webhook.access) || toStringValue(webhook.visibility);
    triggerConfig.webhook = {
      path: toStringValue(webhook.path),
      access: access === "private" ? "private" : "public",
      signature:
        Object.keys(signature).length > 0 ||
        hasValue(webhook.signature_header) ||
        hasValue(webhook.signature_secret_ref)
          ? {
              header:
                toStringValue(signature.header) ||
                toStringValue(webhook.signature_header),
              secretRef:
                toStringValue(signature.secretRef) ||
                toStringValue(webhook.signature_secret_ref),
            }
          : undefined,
    };
  }

  if (Object.keys(event).length > 0) {
    triggerConfig.event = {
      event: toStringValue(event.event) || toStringValue(event.event_name),
      source: toStringValue(event.source),
      bus: toStringValue(event.bus),
      topic: toStringValue(event.topic),
      subscription: toStringValue(event.subscription),
      async:
        typeof event.async === "boolean"
          ? event.async
          : typeof event.heavy === "boolean"
            ? event.heavy
            : undefined,
      payload: event.payload ?? event.defaultPayload ?? event.default_payload,
    };
  }

  return triggerConfig;
}

function mergeDeployTargets(
  ...values: Array<DeployTarget | undefined>
): DeployTarget | undefined {
  let merged: DeployTarget | undefined;

  for (const value of values) {
    if (!value) {
      continue;
    }

    merged = {
      ...(merged || {}),
      ...value,
      execution: {
        ...(merged?.execution || {}),
        ...(value.execution || {}),
      },
      auth: {
        ...(merged?.auth || {}),
        ...(value.auth || {}),
      },
    };
  }

  return merged;
}

function mergeTriggerConfigurations(
  ...values: Array<WorkflowTriggerConfiguration | undefined>
): WorkflowTriggerConfiguration | undefined {
  let merged: WorkflowTriggerConfiguration | undefined;

  for (const value of values) {
    if (!value) {
      continue;
    }

    merged = {
      ...(merged || {}),
      ...value,
      schedule: {
        ...(merged?.schedule || {}),
        ...(value.schedule || {}),
      },
      webhook: {
        ...(merged?.webhook || {}),
        ...(value.webhook || {}),
        signature: {
          ...(merged?.webhook?.signature || {}),
          ...(value.webhook?.signature || {}),
        },
      },
      event: {
        ...(merged?.event || {}),
        ...(value.event || {}),
      },
    };
  }

  return merged;
}

function mergeBindings(
  ...values: Array<WorkflowBinding[] | undefined>
): WorkflowBinding[] | undefined {
  const bindings = new Map<string, WorkflowBinding>();

  for (const value of values) {
    for (const binding of value || []) {
      bindings.set(binding.providerSlug, binding);
    }
  }

  return bindings.size > 0 ? [...bindings.values()] : undefined;
}

function compileWorkflowSource(source: string, fileName: string): string {
  const result = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      strict: true,
    },
  });

  const diagnostics = (result.diagnostics || []).map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
  );

  if (diagnostics.length > 0) {
    throw new Error(diagnostics.join("\n"));
  }

  return result.outputText;
}

function loadWorkflowDefinition(
  source: string,
  fileName: string
): LoadedWorkflowDefinition | undefined {
  try {
    const compiled = compileWorkflowSource(source, fileName);
    const module = { exports: {} as Record<string, unknown> };
    const sandbox = {
      module,
      exports: module.exports,
      require(specifier: string) {
        if (specifier === "@gtmship/sdk") {
          return {
            defineWorkflow<T>(config: T): T {
              return config;
            },
            triggers: {
              manual() {
                return { type: "manual" };
              },
              webhook(path: string, options?: Record<string, unknown>) {
                return {
                  type: "webhook",
                  path,
                  config: {
                    webhook: {
                      path,
                      ...(options || {}),
                    },
                  },
                };
              },
              schedule(
                cronOrConfig: string | { cron?: string; timezone?: string; [key: string]: unknown },
                options?: Record<string, unknown>
              ) {
                const cron =
                  typeof cronOrConfig === "string"
                    ? cronOrConfig
                    : cronOrConfig?.cron || "";
                const extra =
                  typeof cronOrConfig === "object" ? cronOrConfig : options || {};
                return {
                  type: "schedule",
                  cron,
                  config: {
                    schedule: {
                      cron,
                      ...extra,
                      ...(typeof cronOrConfig === "string" ? options || {} : {}),
                    },
                  },
                };
              },
              event(eventName: string, options?: Record<string, unknown>) {
                return {
                  type: "event",
                  event: eventName,
                  config: {
                    event: {
                      event: eventName,
                      ...(options || {}),
                    },
                  },
                };
              },
            },
            auth: {
              getClient() {
                throw new Error("auth.getClient() is unavailable in plan mode.");
              },
              getToken() {
                throw new Error("auth.getToken() is unavailable in plan mode.");
              },
            },
          };
        }

        throw new Error(`Unsupported workflow import: ${specifier}`);
      },
      console,
      Buffer,
      URL,
      fetch,
      process: { env: {} },
    };

    vm.runInNewContext(compiled, sandbox, {
      filename: fileName,
      timeout: 2_000,
    });

    return (module.exports.default || module.exports) as LoadedWorkflowDefinition;
  } catch {
    return undefined;
  }
}

function extractString(
  source: string,
  pattern: RegExp
): string | undefined {
  return source.match(pattern)?.[1]?.trim();
}

function extractTriggerFromSource(source: string): TriggerConfig {
  const webhookPath = extractString(
    source,
    /triggers\.webhook\(\s*["'`]([^"'`]+)["'`]\s*\)/
  );
  if (webhookPath) {
    return { type: "webhook", path: webhookPath };
  }

  const cronDirect = extractString(
    source,
    /triggers\.schedule\(\s*["'`]([^"'`]+)["'`]\s*\)/
  );
  if (cronDirect) {
    return { type: "schedule", cron: cronDirect };
  }

  const cronFromObj = extractString(
    source,
    /triggers\.schedule\(\s*\{[^}]*cron:\s*["'`]([^"'`]+)["'`]/
  );
  if (cronFromObj) {
    return { type: "schedule", cron: cronFromObj };
  }

  const eventName = extractString(
    source,
    /triggers\.event\(\s*["'`]([^"'`]+)["'`]\s*\)/
  );
  if (eventName) {
    return { type: "event", event: eventName };
  }

  return { type: "manual" };
}

function detectProviderUsages(source: string): string[] {
  return Array.from(
    new Set([
      ...Array.from(
        source.matchAll(
          /ctx\.integration\(\s*["'`]([^"'`]+)["'`]\s*\)/g
        )
      ).map((match) => match[1]),
      ...Array.from(
        source.matchAll(
          /auth\.get(?:Client|Token)\(\s*["'`]([^"'`]+)["'`]\s*\)/g
        )
      ).map((match) => match[1]),
    ])
  );
}

function loadStudioMetadata(
  projectRoot: string,
  workflowId: string
): WorkflowStudioMetadata | null {
  const metadataPath = join(
    projectRoot,
    ".gtmship",
    "workflows",
    `${workflowId}.json`
  );

  if (!existsSync(metadataPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(metadataPath, "utf8")) as WorkflowStudioMetadata;
  } catch {
    return null;
  }
}

export function readProjectConfig(): WorkflowProjectConfig | null {
  return readProjectConfigAt(process.cwd());
}

export function readProjectConfigAt(
  projectRoot: string
): WorkflowProjectConfig | null {
  const configPath = join(projectRoot, "gtmship.config.yaml");
  if (!existsSync(configPath)) {
    return null;
  }

  const raw = parseYaml(readFileSync(configPath, "utf8")) as RawProjectConfig;
  const workflows = Object.fromEntries(
    Object.entries(raw.workflows || {}).map(([workflowId, value]) => [
      workflowId,
      {
        deploy: normalizeDeployTarget(value.deploy),
        triggerConfig: normalizeTriggerConfig(
          value.triggerConfig || value.trigger_config
        ),
        bindings: normalizeBindings(value.bindings),
      },
    ])
  );

  return {
    name: raw.name,
    authUrl: raw.auth?.url,
    deploy: normalizeDeployTarget(raw.deploy),
    workflows,
  };
}

export function loadWorkflowPlans(
  projectRoot: string = process.cwd(),
  options: WorkflowPlanLoaderOptions = {}
): WorkflowPlanRecord[] {
  const workflowsDir = join(projectRoot, "workflows");
  if (!existsSync(workflowsDir)) {
    return [];
  }

  const projectConfig = readProjectConfigAt(projectRoot);
  const workflowFiles = readdirSync(workflowsDir)
    .filter((file) => file.endsWith(".ts") || file.endsWith(".js"))
    .sort();

  return workflowFiles.flatMap((file): WorkflowPlanRecord[] => {
      const workflowId = file.replace(/\.(ts|js)$/, "");
      const filePath = join(workflowsDir, file);
      const source = readFileSync(filePath, "utf8");
      const definition = loadWorkflowDefinition(source, file);
      const resolvedWorkflowId = definition?.id || workflowId;

      if (
        options.workflowId &&
        workflowId !== options.workflowId &&
        resolvedWorkflowId !== options.workflowId
      ) {
        return [];
      }

      const studioMetadata = loadStudioMetadata(projectRoot, workflowId);
      const projectWorkflowConfig = projectConfig?.workflows[workflowId];

      const deploy = mergeDeployTargets(
        projectConfig?.deploy,
        projectWorkflowConfig?.deploy,
        definition?.deploy,
        studioMetadata?.artifact?.deploy
      );
      const triggerConfig = mergeTriggerConfigurations(
        definition?.trigger?.config,
        projectWorkflowConfig?.triggerConfig,
        definition?.triggerConfig,
        studioMetadata?.artifact?.triggerConfig
      );
      const bindings = mergeBindings(
        projectWorkflowConfig?.bindings,
        definition?.bindings,
        studioMetadata?.artifact?.bindings
      );
      const requiredProviders = Array.from(
        new Set([
          ...detectProviderUsages(source),
          ...((studioMetadata?.artifact?.requiredAccesses || []).map(
            (access) => access.providerSlug
          ) as string[]),
        ])
      ).filter(Boolean);

      const plan = planWorkflowDeployment({
        workflowId: resolvedWorkflowId,
        workflowName: definition?.name,
        trigger: definition?.trigger || extractTriggerFromSource(source),
        deploy,
        triggerConfig,
        bindings,
        requiredProviders,
        providerOverride: options.providerOverride,
        regionOverride: options.regionOverride,
        gcpProjectOverride: options.gcpProjectOverride,
        baseUrl: options.baseUrl,
        connections: options.connections,
      });

      return [
        {
          workflowId: resolvedWorkflowId,
          workflowName: definition?.name,
          filePath,
          source,
          plan,
        },
      ];
    });
}
