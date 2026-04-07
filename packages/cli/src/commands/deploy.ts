import { join } from "node:path";
import { tmpdir } from "node:os";
import { unlinkSync, writeFileSync } from "node:fs";
import chalk from "chalk";
import ora from "ora";
import {
  loadWorkflowPlans,
  readProjectConfig,
  type WorkflowPlanRecord,
} from "../lib/workflow-plans.js";
import {
  buildWorkflows,
  ensureGcpApplicationDefaultCredentials,
  ensureGcpServicesEnabled,
  resolveRequiredGcpServices,
  type BuildArtifact,
  type GcpServicePreflightNeeds,
} from "./build.js";
import { deployLocalWorkflow } from "../lib/local-deployments.js";

/** Default timeout for HTTP requests to auth service / control plane. */
const FETCH_TIMEOUT_MS = 15_000;

/** Extended timeout for operations that sync secrets to external backends. */
const FETCH_TIMEOUT_EXTENDED_MS = 60_000;

function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

async function readResponseErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) {
    return response.statusText;
  }

  try {
    const payload = JSON.parse(text) as { error?: string };
    return payload.error || text;
  } catch {
    return text;
  }
}

interface DeployOptions {
  provider: string;
  region?: string;
  project?: string;
  workflow?: string;
}

type ConnectionAuthMode = "proxy" | "secret_manager";
type SecretBackendKind = "aws_secrets_manager" | "gcp_secret_manager";

interface AuthStrategyBackend {
  kind: SecretBackendKind;
  region?: string;
  projectId?: string;
  secretPrefix?: string;
}

interface AuthStrategyStatus {
  mode: ConnectionAuthMode;
  configuredBackends: AuthStrategyBackend[];
}

type DeployProvider = "aws" | "gcp" | "local";

const DEFAULT_SECRET_PREFIX = "gtmship-connections";

/**
 * Resolve cloud credentials from auth service or environment.
 */
async function resolveCredentials(
  provider: string,
  authUrl: string,
): Promise<void> {
  try {
    const res = await fetchWithTimeout(`${authUrl}/cloud-auth/credentials/${provider}`);
    if (res.ok) {
      const { credentials } = (await res.json()) as {
        credentials: Record<string, unknown>;
      };

      if (provider === "aws" && credentials.accessKeyId) {
        process.env.AWS_ACCESS_KEY_ID = credentials.accessKeyId as string;
        process.env.AWS_SECRET_ACCESS_KEY =
          credentials.secretAccessKey as string;
        if (credentials.region) {
          process.env.AWS_REGION = credentials.region as string;
        }
        return;
      }

      if (provider === "gcp" && credentials.serviceAccountKey) {
        const tmpPath = join(tmpdir(), `gtmship-gcp-${Date.now()}.json`);
        writeFileSync(tmpPath, JSON.stringify(credentials.serviceAccountKey));
        if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
          process.env._GTMSHIP_PREV_GOOGLE_APPLICATION_CREDENTIALS =
            process.env.GOOGLE_APPLICATION_CREDENTIALS;
        }
        if (process.env.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE) {
          process.env._GTMSHIP_PREV_CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE =
            process.env.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE;
        }
        process.env.GOOGLE_APPLICATION_CREDENTIALS = tmpPath;
        process.env.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE = tmpPath;
        process.env._GTMSHIP_GCP_TEMP_KEY = tmpPath;
        return;
      }
    }
  } catch {
    // Fall through to environment/default credentials.
  }

  if (provider === "aws" && !process.env.AWS_ACCESS_KEY_ID) {
    console.log(
      chalk.yellow(
        "  No AWS credentials in auth service. Using environment/~/.aws/credentials.",
      ),
    );
  }

  if (provider === "gcp" && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.log(
      chalk.yellow(
        "  No GCP credentials in auth service. Using local environment, gcloud, and ADC credentials.",
      ),
    );
  }
}

function cleanupCredentials(): void {
  const tmpPath = process.env._GTMSHIP_GCP_TEMP_KEY;
  if (tmpPath) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup failures.
    }
    delete process.env._GTMSHIP_GCP_TEMP_KEY;
  }

  if (process.env._GTMSHIP_PREV_GOOGLE_APPLICATION_CREDENTIALS) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS =
      process.env._GTMSHIP_PREV_GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env._GTMSHIP_PREV_GOOGLE_APPLICATION_CREDENTIALS;
  } else {
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  }

  if (process.env._GTMSHIP_PREV_CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE) {
    process.env.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE =
      process.env._GTMSHIP_PREV_CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE;
    delete process.env._GTMSHIP_PREV_CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE;
  } else {
    delete process.env.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE;
  }
}

export function resolveWorkflowPlanGcpServiceNeeds(
  workflowPlans: WorkflowPlanRecord[],
): GcpServicePreflightNeeds[] {
  return workflowPlans.map(({ plan }) => ({
    cloudScheduler: plan.trigger.type === "schedule",
    secretManager: plan.authMode === "secret_manager",
    database: plan.resources.some((resource) => resource.kind === "Cloud SQL"),
    storage: plan.resources.some((resource) => resource.kind === "Cloud Storage"),
  }));
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

function resolveSecretPrefix(secretPrefix?: string | null): string {
  return secretPrefix?.trim()
    ? sanitizeSegment(secretPrefix)
    : DEFAULT_SECRET_PREFIX;
}

async function loadAuthStrategy(authUrl: string): Promise<AuthStrategyStatus | null> {
  try {
    const response = await fetchWithTimeout(`${authUrl}/settings/auth-strategy`);
    if (!response.ok) {
      return null;
    }

    return (await response.json()) as AuthStrategyStatus;
  } catch {
    return null;
  }
}

function resolveBackendForPlan(
  strategy: AuthStrategyStatus,
  plan: WorkflowPlanRecord["plan"]
): AuthStrategyBackend | null {
  const requestedKind = plan.auth?.backend?.kind;
  const configured =
    requestedKind
      ? strategy.configuredBackends.find((backend) => backend.kind === requestedKind)
      : plan.provider === "aws"
        ? strategy.configuredBackends.find(
            (backend) => backend.kind === "aws_secrets_manager"
          )
        : strategy.configuredBackends.find(
            (backend) => backend.kind === "gcp_secret_manager"
          );

  const kind =
    requestedKind ||
    configured?.kind ||
    (plan.provider === "aws"
      ? "aws_secrets_manager"
      : "gcp_secret_manager");

  if (kind === "aws_secrets_manager") {
    const region =
      plan.auth?.backend?.region || plan.region || configured?.region || null;
    if (!region) {
      return null;
    }

    return {
      kind,
      region,
      secretPrefix:
        plan.auth?.backend?.secretPrefix || configured?.secretPrefix || undefined,
    };
  }

  const projectId =
    plan.auth?.backend?.projectId ||
    plan.gcpProject ||
    configured?.projectId ||
    null;
  if (!projectId) {
    return null;
  }

  return {
    kind,
    projectId,
    secretPrefix:
      plan.auth?.backend?.secretPrefix || configured?.secretPrefix || undefined,
  };
}

function buildSecretRef(
  backend: AuthStrategyBackend,
  providerSlug: string,
  connectionId?: string
): string | undefined {
  if (!connectionId) {
    return undefined;
  }

  const secretPrefix = resolveSecretPrefix(backend.secretPrefix);
  if (backend.kind === "aws_secrets_manager") {
    return `${secretPrefix}/${sanitizeSegment(providerSlug)}/${sanitizeSegment(
      connectionId
    )}/runtime`;
  }

  if (!backend.projectId) {
    return undefined;
  }

  const secretId = sanitizeSecretId(
    `${secretPrefix}-${providerSlug}-${connectionId}`
  );
  return `projects/${backend.projectId}/secrets/${secretId}-runtime`;
}

function applyAuthStrategyToWorkflowPlans(
  workflowPlans: WorkflowPlanRecord[],
  strategy: AuthStrategyStatus | null
): WorkflowPlanRecord[] {
  if (!strategy) {
    return workflowPlans;
  }

  return workflowPlans.map((workflowPlan) => {
    const plan = workflowPlan.plan;

    if (plan.provider === "local") {
      return {
        ...workflowPlan,
        plan: {
          ...plan,
          authMode: "proxy",
          auth: {
            ...(plan.auth || {}),
            mode: "proxy",
            backend: undefined,
            manifest: undefined,
          },
        },
      };
    }

    const backend = resolveBackendForPlan(strategy, plan);
    const existingProviders = plan.auth?.manifest?.providers || [];
    const manifest =
      backend && plan.bindings.length > 0
        ? {
            version: plan.auth?.manifest?.version || "1",
            generatedAt: new Date().toISOString(),
            providers: plan.bindings.map((binding) => {
              const existing = existingProviders.find(
                (provider) => provider.providerSlug === binding.providerSlug
              );

              return {
                ...(existing || {}),
                providerSlug: binding.providerSlug,
                connectionId:
                  binding.resolvedConnectionId || existing?.connectionId,
                secretRef: buildSecretRef(
                  backend,
                  binding.providerSlug,
                  binding.resolvedConnectionId
                ),
              };
            }),
          }
        : plan.auth?.manifest;

    return {
      ...workflowPlan,
      plan: {
        ...plan,
        authMode: "secret_manager",
        auth: {
          ...(plan.auth || {}),
          mode: "secret_manager",
          backend: backend || plan.auth?.backend,
          runtimeAccess: plan.auth?.runtimeAccess || "direct",
          manifest,
        },
      },
    };
  });
}

async function syncWorkflowControlPlane(
  authUrl: string,
  workflowPlans: WorkflowPlanRecord[],
  context: {
    rawOutputs: Record<string, string>;
    provider: DeployProvider;
    region: string;
    gcpProject?: string;
    computeId: string;
    apiEndpoint: string;
    schedulerJobId?: string;
    runtimeTarget?: {
      computeType: "service" | "job" | "lambda";
      computeName: string;
      endpointUrl: string;
      schedulerJobId?: string;
      region: string;
      gcpProject?: string;
      logGroupName?: string;
    };
    gcpTarget?: {
      kind: "service" | "job";
      name: string;
      endpointUrl: string;
      schedulerJobId?: string;
      projectId: string;
      region: string;
    };
  },
): Promise<number> {
  const response = await fetchWithTimeout(
    `${authUrl}/workflow-control-plane/deployments/sync`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deployments: workflowPlans.map((workflowPlan) => {
          const plan = workflowPlan.plan;
          const endpointUrl =
            context.provider === "gcp"
              ? context.gcpTarget?.endpointUrl || context.apiEndpoint || null
              : context.runtimeTarget?.endpointUrl || context.apiEndpoint || null;
          const schedulerId =
            context.provider === "gcp"
              ? context.gcpTarget?.schedulerJobId ||
                context.schedulerJobId ||
                null
              : context.runtimeTarget?.schedulerJobId ||
                context.schedulerJobId ||
                null;
          const runtimeTarget =
            context.provider === "gcp"
              ? {
                  computeType:
                    context.gcpTarget?.kind || plan.executionKind || "service",
                  computeName:
                    context.gcpTarget?.name || context.computeId || null,
                  endpointUrl,
                  schedulerId,
                  gcpProject:
                    plan.gcpProject || context.gcpTarget?.projectId || null,
                  region: plan.region || context.gcpTarget?.region || null,
                }
              : {
                  computeType: context.runtimeTarget?.computeType || "lambda",
                  computeName:
                    context.runtimeTarget?.computeName || context.computeId || null,
                  endpointUrl,
                  schedulerId,
                  region:
                    context.runtimeTarget?.region || plan.region || context.region,
                  logGroupName: context.runtimeTarget?.logGroupName || null,
                };

          return {
            workflowId: plan.workflowId,
            provider: plan.provider,
            region: plan.region,
            gcpProject: plan.gcpProject,
            executionKind: plan.executionKind,
            endpointUrl,
            schedulerId,
            authMode: plan.authMode,
            authConfig: plan.auth,
            triggerType: plan.trigger.type,
            triggerConfig: plan.trigger,
            resources: plan.resources,
            warnings: plan.warnings,
            bindings: plan.bindings.map((binding) => ({
              providerSlug: binding.providerSlug,
              selectorType: binding.selector.type,
              selectorValue:
                binding.selector.connectionId || binding.selector.label || null,
              connectionId:
                binding.selector.connectionId || binding.resolvedConnectionId || null,
              metadata: {
                status: binding.status,
                message: binding.message,
                resolvedConnectionId: binding.resolvedConnectionId || null,
                resolvedConnectionLabel: binding.resolvedConnectionLabel || null,
              },
            })),
            resourceInventory: {
              plannedResources: plan.resources,
              trigger: plan.trigger,
              auth: plan.auth,
              authManifest: plan.auth?.manifest,
              runtimeTarget,
              platformOutputs: context.rawOutputs,
            },
            status: "active",
            deployedAt: new Date().toISOString(),
          };
        }),
      }),
    },
    FETCH_TIMEOUT_EXTENDED_MS,
  );

  if (!response.ok) {
    throw new Error(await readResponseErrorMessage(response));
  }

  const payload = (await response.json()) as { deployments?: unknown[] };
  return Array.isArray(payload.deployments) ? payload.deployments.length : 0;
}

async function preflightWorkflowAuth(
  authUrl: string,
  workflowPlans: WorkflowPlanRecord[]
): Promise<{
  validatedCount: number;
  checkedBindings: number;
}> {
  const response = await fetchWithTimeout(
    `${authUrl}/workflow-control-plane/deployments/preflight-auth`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deployments: workflowPlans.map((workflowPlan) => {
          const plan = workflowPlan.plan;
          return {
            workflowId: plan.workflowId,
            provider: plan.provider,
            region: plan.region,
            gcpProject: plan.gcpProject,
            executionKind: plan.executionKind,
            authConfig: plan.auth,
            bindings: plan.bindings.map((binding) => ({
              providerSlug: binding.providerSlug,
              selectorType: binding.selector.type,
              selectorValue:
                binding.selector.connectionId || binding.selector.label || null,
              connectionId:
                binding.selector.connectionId || binding.resolvedConnectionId || null,
              metadata: {
                status: binding.status,
                message: binding.message,
                resolvedConnectionId: binding.resolvedConnectionId || null,
                resolvedConnectionLabel: binding.resolvedConnectionLabel || null,
              },
            })),
          };
        }),
      }),
    },
    FETCH_TIMEOUT_EXTENDED_MS,
  );

  if (!response.ok) {
    throw new Error(await readResponseErrorMessage(response));
  }

  const payload = (await response.json()) as {
    validatedCount?: number;
    deployments?: Array<{ checkedBindings?: number }>;
  };

  return {
    validatedCount:
      typeof payload.validatedCount === "number"
        ? payload.validatedCount
        : Array.isArray(payload.deployments)
          ? payload.deployments.length
          : 0,
    checkedBindings: Array.isArray(payload.deployments)
      ? payload.deployments.reduce(
          (total, deployment) => total + (deployment.checkedBindings || 0),
          0
        )
      : 0,
  };
}

export async function deployCommand(options: DeployOptions) {
  console.log(chalk.blue("\n  Deploying GTMShip workflows...\n"));

  const config = readProjectConfig();
  const provider = (options.provider ||
    config?.deploy?.provider ||
    "aws") as DeployProvider;
  const region =
    options.region ||
    config?.deploy?.region ||
    (provider === "aws"
      ? "us-east-1"
      : provider === "gcp"
        ? "us-central1"
        : "local");
  const compute = provider === "aws" ? "lambda" : provider === "gcp" ? "cloud-run" : "local-job";
  const gcpProject = options.project || config?.deploy?.gcpProject;
  const authUrl = config?.authUrl || "http://localhost:4000";
  const projectName = config?.name || "gtmship";

  if (provider === "gcp" && !gcpProject) {
    console.log(
      chalk.red(
        "  GCP project ID is required. Use --project <id> or set deploy.gcp_project in gtmship.config.yaml",
      ),
    );
    process.exit(1);
  }

  console.log(chalk.gray(`  Provider:  ${provider.toUpperCase()}`));
  console.log(chalk.gray(`  Region:    ${region}`));
  console.log(chalk.gray(`  Compute:   ${compute}`));
  if (gcpProject) {
    console.log(chalk.gray(`  GCP Project: ${gcpProject}`));
  }
  console.log("");

  // Fetch active connections from auth service so the planner can resolve
  // bindings (connectionId, secretRef) for the runtime auth manifest.
  let connections: Array<{ id: string; label?: string | null; status: string; createdAt?: string; provider: { slug: string; name?: string } }> = [];
  try {
    const connRes = await fetchWithTimeout(`${authUrl}/connections`);
    if (connRes.ok) {
      const connData = (await connRes.json()) as Array<{
        id: string; label?: string | null; status: string; createdAt?: string;
        provider: { slug: string; name?: string };
      }>;
      connections = connData.filter((c) => c.status === "active");
    }
  } catch {
    console.log(chalk.yellow("  Could not fetch connections from auth service. Bindings may be unresolved."));
  }

  const authStrategy = await loadAuthStrategy(authUrl);
  if (provider !== "local" && !authStrategy) {
    console.log(
      chalk.red(
        "  Could not load connection auth settings from auth service. Cloud deployments require secret-manager configuration before deploy.",
      ),
    );
    process.exit(1);
  }

  if (provider !== "local" && authStrategy?.mode !== "secret_manager") {
    console.log(
      chalk.red(
        "  Cloud deployments require Secret manager mode. Switch Connection auth source of truth to secret_manager in Settings before deploying to AWS or GCP.",
      ),
    );
    process.exit(1);
  }

  const workflowPlans = applyAuthStrategyToWorkflowPlans(
    loadWorkflowPlans(process.cwd(), {
      providerOverride: provider,
      regionOverride: region,
      gcpProjectOverride: gcpProject,
      workflowId: options.workflow,
      connections,
    }),
    authStrategy
  );

  if (workflowPlans.length === 0) {
    if (options.workflow) {
      console.log(chalk.red(`  Workflow "${options.workflow}" not found.`));
      return;
    }

    console.log(
      chalk.yellow(
        "  No workflows found in ./workflows/. Create one first with gtmship init.",
      ),
    );
    return;
  }

  if (
    provider !== "local" &&
    workflowPlans.some((workflowPlan) => !workflowPlan.plan.auth?.backend?.kind)
  ) {
    console.log(
      chalk.red(
        "  Cloud deployments require a matching configured secret backend for each workflow deployment target.",
      ),
    );
    process.exit(1);
  }

  const requiresSecretManagerPreflight = workflowPlans.some(
    (workflowPlan) => workflowPlan.plan.authMode === "secret_manager"
  );

  console.log(
    chalk.gray(
      `  Workflows: ${workflowPlans.map((workflow) => workflow.workflowId).join(", ")}`,
    ),
  );
  console.log("");

  console.log(chalk.green("  Deployment Plan"));
  console.log(chalk.green("  " + "─".repeat(50)));
  for (const workflowPlan of workflowPlans) {
    const plan = workflowPlan.plan;
    console.log(
      chalk.white(
        `  ${plan.workflowId}: ${plan.trigger.type} -> ${plan.executionKind} (${plan.authMode})`,
      ),
    );
    console.log(chalk.gray(`     Trigger:   ${plan.trigger.description}`));
    console.log(
      chalk.gray(
        `     Resources: ${plan.resources.map((resource) => resource.kind).join(", ")}`,
      ),
    );
    if (plan.bindings.length > 0) {
      console.log(
        chalk.gray(
          `     Bindings:  ${plan.bindings
            .map((binding) =>
              `${binding.providerSlug} -> ${binding.selector.type}${binding.selector.connectionId ? `:${binding.selector.connectionId}` : binding.selector.label ? `:${binding.selector.label}` : ""}`,
            )
            .join(", ")}`,
        ),
      );
    }
    for (const warning of plan.warnings) {
      console.log(chalk.yellow(`     Warning:   ${warning}`));
    }
  }
  console.log("");

  // -------------------------------------------------------------------------
  // Validate GCP resource constraints before building
  // -------------------------------------------------------------------------

  if (provider === "gcp") {
    const { validateGcpResourceConstraints } = await import("@gtmship/deploy-engine");
    const validationErrors: Array<{ workflowId: string; field: string; message: string }> = [];

    for (const workflowPlan of workflowPlans) {
      const errors = validateGcpResourceConstraints(workflowPlan.plan);
      for (const error of errors) {
        validationErrors.push({
          workflowId: workflowPlan.workflowId,
          ...error,
        });
      }
    }

    if (validationErrors.length > 0) {
      console.log("");
      console.log(chalk.red("  GCP Resource Validation Failed"));
      console.log(chalk.red("  " + "─".repeat(50)));
      for (const error of validationErrors) {
        console.log(chalk.red(`  ${error.workflowId}: ${error.message}`));
      }
      console.log("");
      console.log(chalk.yellow("  Fix the resource configuration in your workflow definition or gtmship.config.yaml."));
      process.exit(1);
    }
  }

  if (requiresSecretManagerPreflight) {
    const authPreflightSpinner = ora(
      "Preflighting secret-manager bindings..."
    ).start();

    try {
      const preflight = await preflightWorkflowAuth(authUrl, workflowPlans);
      authPreflightSpinner.succeed(
        `Secret-manager preflight passed (${preflight.validatedCount} workflow${preflight.validatedCount === 1 ? "" : "s"}, ${preflight.checkedBindings} binding${preflight.checkedBindings === 1 ? "" : "s"})`
      );
    } catch (err) {
      const isTimeout = err instanceof DOMException && err.name === "AbortError";
      const message = isTimeout
        ? "Request to auth service timed out. The secret-manager sync may need more time — check that the auth service is running and responsive."
        : err instanceof Error ? err.message : String(err);
      authPreflightSpinner.fail("Secret-manager preflight failed");
      console.log(
        chalk.red(
          `  ${message}`
        ),
      );
      process.exit(1);
    }
  }

  if (provider === "local") {
    const localValidationErrors = workflowPlans.flatMap((workflowPlan) => {
      const errors: string[] = [];
      if (
        workflowPlan.plan.trigger.type !== "manual" &&
        workflowPlan.plan.trigger.type !== "schedule"
      ) {
        errors.push("Local deployments support only manual and schedule triggers.");
      }
      if (workflowPlan.plan.executionKind !== "job") {
        errors.push("Local deployments support only job execution.");
      }
      if (workflowPlan.plan.authMode !== "proxy") {
        errors.push("Local deployments support only proxy auth.");
      }

      return errors.map((message) => ({
        workflowId: workflowPlan.workflowId,
        message,
      }));
    });

    if (localValidationErrors.length > 0) {
      console.log("");
      console.log(chalk.red("  Local Deployment Validation Failed"));
      console.log(chalk.red("  " + "─".repeat(50)));
      for (const error of localValidationErrors) {
        console.log(chalk.red(`  ${error.workflowId}: ${error.message}`));
      }
      console.log("");
      process.exit(1);
    }
  }

  console.log("");

  // -------------------------------------------------------------------------
  // Build workflow code
  // -------------------------------------------------------------------------

  if (provider !== "local") {
    const credSpinner = ora("Resolving cloud credentials...").start();
    await resolveCredentials(provider, authUrl);
    credSpinner.succeed("Cloud credentials resolved");
  }

  if (provider === "gcp" && gcpProject) {
    const gcpPreflightSpinner = ora(
      "Preflighting GCP auth, APIs, and deploy prerequisites...",
    ).start();

    try {
      const requiredServices = resolveRequiredGcpServices(
        resolveWorkflowPlanGcpServiceNeeds(workflowPlans),
      );
      ensureGcpServicesEnabled(gcpProject, requiredServices);
      ensureGcpApplicationDefaultCredentials();
      gcpPreflightSpinner.succeed(
        `GCP preflight passed (${requiredServices.length} API${requiredServices.length === 1 ? "" : "s"})`,
      );
    } catch (err) {
      gcpPreflightSpinner.fail("GCP preflight failed");
      console.log(
        chalk.red(
          `  ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      process.exit(1);
    }
  }

  console.log("");

  let buildArtifacts: BuildArtifact[];
  const buildSpinner = ora("Building workflow code...").start();
  try {
    buildArtifacts = await buildWorkflows(workflowPlans, {
      provider,
      gcpProject,
      region,
      push: provider === "gcp",
    });
    buildSpinner.succeed(
      `Workflow code built (${buildArtifacts.length} artifact${buildArtifacts.length === 1 ? "" : "s"})`,
    );
  } catch (err) {
    buildSpinner.fail("Workflow build failed");
    console.log(
      chalk.red(
        `\n  ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    process.exit(1);
  }

  // Ensure Pulumi local backend doesn't prompt for a passphrase
  if (
    provider !== "local" &&
    !process.env.PULUMI_CONFIG_PASSPHRASE &&
    !process.env.PULUMI_CONFIG_PASSPHRASE_FILE
  ) {
    process.env.PULUMI_CONFIG_PASSPHRASE = "";
  }

  // -------------------------------------------------------------------------
  // Deploy each workflow individually
  // -------------------------------------------------------------------------

  const { deploy } = await import("@gtmship/deploy-engine");
  type UnifiedDeployResult = Awaited<ReturnType<typeof deploy>> | Awaited<ReturnType<typeof deployLocalWorkflow>>;
  const deployResults: Array<{ workflowId: string; result: UnifiedDeployResult }> = [];
  let deployFailures = 0;

  for (const wp of workflowPlans) {
    const artifact = buildArtifacts.find((a) => a.workflowId === wp.workflowId);
    if (!artifact) {
      console.log(chalk.yellow(`  Skipping ${wp.workflowId}: no build artifact found.`));
      continue;
    }

    const plan = wp.plan;

    // Per-workflow GCP needs
    const gcpNeeds = provider === "gcp" ? {
      executionKind: plan.executionKind as "job" | "service",
      cloudScheduler: plan.trigger.type === "schedule",
      scheduleCron: plan.trigger.cron,
      scheduleTimezone: plan.trigger.timezone,
      secretManager: plan.authMode === "secret_manager",
      publicIngress: plan.trigger.type === "webhook",
      database: false,
      storage: false,
      memory: plan.memory,
      cpu: plan.cpu,
    } : undefined;
    const awsNeeds = provider === "aws" ? {
      publicIngress: plan.trigger.type === "webhook",
      cloudScheduler: plan.trigger.type === "schedule",
      scheduleCron: plan.trigger.cron,
      scheduleTimezone: plan.trigger.timezone,
      secretManager: plan.authMode === "secret_manager",
      database: false,
      storage: false,
      memory: plan.memory,
      cpu: plan.cpu,
    } : undefined;

    const lambdaCodePath = provider === "aws" ? artifact.artifactPath : undefined;
    const serviceCodePath = provider === "gcp"
      ? (artifact.imageUri || artifact.artifactPath)
      : undefined;

    // Per-workflow runtime env vars
    const runtimeBackend = plan.auth?.backend;
    const runtimeEnvVars: Record<string, string> = {
      GTMSHIP_RUNTIME_MODE:
        provider === "aws"
          ? "lambda"
          : provider === "local"
            ? "local-job"
            : plan.executionKind === "job"
            ? "cloud-run-job"
            : "cloud-run-service",
      GTMSHIP_WORKFLOW_ID: wp.workflowId,
      GTMSHIP_RUNTIME_AUTH_MODE: plan.authMode || "proxy",
      ...(plan.authMode === "secret_manager" && runtimeBackend?.kind
        ? {
            GTMSHIP_SECRET_BACKEND_KIND: runtimeBackend.kind,
            ...(runtimeBackend.region
              ? { GTMSHIP_SECRET_BACKEND_REGION: runtimeBackend.region }
              : {}),
            ...(runtimeBackend.projectId
              ? { GTMSHIP_SECRET_BACKEND_PROJECT_ID: runtimeBackend.projectId }
              : {}),
            GTMSHIP_RUNTIME_AUTH_MANIFEST: JSON.stringify(
              plan.auth?.manifest || { providers: [] },
            ),
          }
        : {}),
    };

    const deploySpinner = ora(
      `Deploying ${wp.workflowId} to ${provider.toUpperCase()} ${region}...`,
    ).start();

    try {
      const result =
        provider === "local"
          ? await deployLocalWorkflow({
              workflowId: wp.workflowId,
              workflowName: wp.workflowName,
              projectName,
              bundleSourcePath: artifact.artifactPath,
              triggerType: plan.trigger.type as "manual" | "schedule",
              scheduleCron: plan.trigger.cron,
              scheduleTimezone: plan.trigger.timezone,
            })
          : await deploy({
              provider,
              region,
              compute: compute as "lambda" | "ecs" | "cloud-run",
              projectName,
              workflowId: wp.workflowId,
              gcpProject,
              gcpNeeds,
              awsNeeds,
              lambdaCodePath,
              serviceCodePath,
              runtimeEnvVars,
            });

      deploySpinner.succeed(`${wp.workflowId} deployed successfully`);
      deployResults.push({ workflowId: wp.workflowId, result });
      console.log(chalk.gray(`     API Endpoint: ${result.apiEndpoint}`));
      console.log(chalk.gray(`     Compute: ${result.computeId}`));
      console.log(chalk.gray(`     Database: ${result.databaseEndpoint}`));
      console.log(chalk.gray(`     Storage: ${result.storageBucket}`));
      if (result.schedulerJobId) {
        console.log(chalk.gray(`     schedulerJobId: ${result.schedulerJobId}`));
      }
      if (result.rawOutputs.localLogPath) {
        console.log(chalk.gray(`     localLogPath: ${result.rawOutputs.localLogPath}`));
      }
      if (result.rawOutputs.localManifestPath) {
        console.log(chalk.gray(`     localManifestPath: ${result.rawOutputs.localManifestPath}`));
      }

      // Sync this workflow's deployment to the control plane
      try {
        const deployedPlans = applyAuthStrategyToWorkflowPlans(
          loadWorkflowPlans(process.cwd(), {
            providerOverride: provider,
            regionOverride: region,
            gcpProjectOverride: gcpProject,
            workflowId: wp.workflowId,
            baseUrl: result.apiEndpoint,
            connections,
          }),
          authStrategy,
        );
        await syncWorkflowControlPlane(authUrl, deployedPlans, {
          rawOutputs: result.rawOutputs,
          provider,
          region,
          gcpProject,
          computeId: result.computeId,
          apiEndpoint: result.apiEndpoint,
          schedulerJobId: result.schedulerJobId || undefined,
          runtimeTarget: result.runtimeTarget,
          gcpTarget: "gcpTarget" in result ? result.gcpTarget : undefined,
        });
      } catch (syncErr) {
        console.log(
          chalk.yellow(
            `  Control Plane sync skipped for ${wp.workflowId}: ${syncErr instanceof Error ? syncErr.message : String(syncErr)}`,
          ),
        );
      }
    } catch (err) {
      deploySpinner.fail(`${wp.workflowId} deployment failed`);
      console.log(
        chalk.red(
          `  ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      deployFailures++;
    }
  }

  if (provider !== "local") {
    cleanupCredentials();
  }

  if (deployResults.length === 0) {
    console.log(chalk.red("\n  All deployments failed."));
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------

  console.log("");
  console.log(chalk.green("  Deployment Summary"));
  console.log(chalk.green("  " + "─".repeat(50)));
  for (const { workflowId, result } of deployResults) {
    console.log(
      chalk.white(`  ${workflowId}: ${chalk.cyan(result.apiEndpoint || result.computeId)}`),
    );
  }
  if (deployFailures > 0) {
    console.log(chalk.yellow(`  ${deployFailures} workflow(s) failed to deploy.`));
  }
  console.log("");

  console.log(chalk.green("  Workflow Triggers"));
  console.log(chalk.green("  " + "─".repeat(50)));
  for (const workflowPlan of applyAuthStrategyToWorkflowPlans(
      loadWorkflowPlans(process.cwd(), {
        providerOverride: provider,
        regionOverride: region,
        gcpProjectOverride: gcpProject,
        workflowId: options.workflow,
        connections,
      }),
      authStrategy
    )) {
    const triggerSummary =
      workflowPlan.plan.trigger.endpoint ||
      workflowPlan.plan.trigger.cron ||
      workflowPlan.plan.trigger.eventName ||
      workflowPlan.plan.trigger.description;
    console.log(
      chalk.white(
        `  ${workflowPlan.plan.workflowId}: ${chalk.cyan(triggerSummary)}`,
      ),
    );
  }
  console.log("");

  console.log(
    chalk.gray("  View logs with: gtmship logs --provider " + provider),
  );
  console.log(chalk.gray("  View triggers with: gtmship triggers"));
}
