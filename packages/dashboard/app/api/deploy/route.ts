import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { resolve as resolvePath, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveProjectRoot } from "@/lib/workflow-studio/project-root";

/** Walk up from a starting directory until we find pnpm-workspace.yaml (monorepo root). */
function findMonorepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start; // fallback
}
import {
  buildWorkflowPlanFromArtifact,
  extractTriggerFromSource,
  type DeploymentDefaults,
} from "@/lib/workflow-studio/deploy-plan";
import {
  listStoredWorkflows,
  loadStoredWorkflow,
  saveStoredWorkflow,
} from "@/lib/workflow-studio/storage";
import type {
  WorkflowDeployProvider,
  WorkflowDeploymentRun,
  WorkflowDeploymentPlan,
  WorkflowDeploymentPlanResponse,
  WorkflowDeployAuthMode,
  WorkflowPlannedBinding,
  WorkflowPlannedResource,
  WorkflowStudioArtifact,
} from "@/lib/workflow-studio/types";

type SharedPlanner = (input: Record<string, unknown>) => Promise<unknown>;

function extractValue(output: string, label: string): string | null {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${escapedLabel}\\s*:\\s+(.+)`);
  const match = output
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => pattern.test(line))
    .at(-1);

  if (!match) {
    return null;
  }

  return match.replace(pattern, "$1").trim();
}

function parseProvider(value: string | null): WorkflowDeployProvider {
  return value === "gcp" ? "gcp" : "aws";
}

function parseDefaults(request: Request): DeploymentDefaults {
  const { searchParams } = new URL(request.url);
  const provider = parseProvider(searchParams.get("provider"));
  const region = searchParams.get("region") || undefined;
  const gcpProject = searchParams.get("gcpProject") || undefined;

  return { provider, region, gcpProject };
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const allStrings = value.every((entry) => typeof entry === "string");
  return allStrings ? (value as string[]) : null;
}

function normalizeAuthMode(mode: unknown): WorkflowDeployAuthMode {
  if (mode === "secret_manager" || mode === "synced_secrets") {
    return "secret_manager";
  }

  return "proxy";
}

function normalizeSharedPlan(
  value: unknown,
  fallback: WorkflowDeploymentPlan
): WorkflowDeploymentPlan | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const shared = value as Record<string, unknown>;
  const triggerType =
    shared.triggerType === "manual" ||
    shared.triggerType === "webhook" ||
    shared.triggerType === "schedule" ||
    shared.triggerType === "event"
      ? shared.triggerType
      : fallback.triggerType;
  const executionKind =
    shared.executionKind === "service" || shared.executionKind === "job"
      ? shared.executionKind
      : fallback.executionKind;
  const provider =
    shared.provider === "gcp" || shared.provider === "aws"
      ? shared.provider
      : fallback.provider;
  const authMode = normalizeAuthMode(shared.authMode ?? fallback.authMode);
  const resources: WorkflowPlannedResource[] = Array.isArray(shared.resources)
    ? shared.resources.flatMap((resource, index) => {
        if (typeof resource === "string") {
          return [
            {
              kind: resource,
              name: `${fallback.workflowId}-${index + 1}`,
              description: resource,
              summary: resource,
            } satisfies WorkflowPlannedResource,
          ];
        }

        if (
          resource &&
          typeof resource === "object" &&
          typeof (resource as { kind?: unknown }).kind === "string"
        ) {
          const record = resource as Record<string, unknown>;
          const kind = record.kind as string;
          return [
            {
              kind,
              name:
                typeof record.name === "string"
                  ? record.name
                  : `${fallback.workflowId}-${index + 1}`,
              description:
                typeof record.description === "string"
                  ? record.description
                  : kind,
              summary:
                typeof record.summary === "string" ? record.summary : kind,
            } satisfies WorkflowPlannedResource,
          ];
        }

        return [];
      })
    : fallback.resources;

  const triggerInfo =
    shared.triggerInfo && typeof shared.triggerInfo === "object"
      ? (shared.triggerInfo as Record<string, unknown>)
      : {};
  const sharedTriggerSummary =
    typeof shared.triggerSummary === "string"
      ? shared.triggerSummary
      : undefined;
  const fallbackSummary = fallback.summary || {
    trigger: fallback.trigger.description,
    execution: fallback.executionKind,
    endpoint: fallback.trigger.endpoint,
    schedule: fallback.trigger.cron
      ? `${fallback.trigger.cron}${
          fallback.trigger.timezone ? ` (${fallback.trigger.timezone})` : ""
        }`
      : undefined,
    event: fallback.trigger.eventName
      ? fallback.trigger.source
        ? `${fallback.trigger.eventName} via ${fallback.trigger.source}`
        : fallback.trigger.eventName
      : undefined,
  };

  const summary: WorkflowDeploymentPlan["summary"] = {
    trigger: sharedTriggerSummary || fallbackSummary.trigger,
    execution: executionKind,
    endpoint:
      typeof triggerInfo.webhookUrl === "string"
        ? triggerInfo.webhookUrl
        : fallbackSummary.endpoint,
    schedule:
      typeof triggerInfo.cronExpression === "string"
        ? `${triggerInfo.cronExpression}${typeof triggerInfo.timezone === "string" ? ` (${triggerInfo.timezone})` : ""}`
        : fallbackSummary.schedule,
    event:
      typeof triggerInfo.eventName === "string"
        ? typeof triggerInfo.source === "string"
          ? `${triggerInfo.eventName} via ${triggerInfo.source}`
          : triggerInfo.eventName
        : fallbackSummary.event,
  };

  const bindings: WorkflowPlannedBinding[] = Array.isArray(shared.authBindings)
    ? shared.authBindings
        .flatMap((binding) => {
          if (!binding || typeof binding !== "object") {
            return [];
          }

          const record = binding as Record<string, unknown>;
          const selectorType =
            record.selectorType === "connection_id" ||
            record.selectorType === "label" ||
            record.selectorType === "latest_active"
              ? record.selectorType
              : "latest_active";

          return [
            {
              providerSlug:
                typeof record.providerSlug === "string"
                  ? record.providerSlug
                  : "",
              selector: {
                type: selectorType,
                value:
                  typeof record.value === "string" ? record.value : undefined,
                connectionId:
                  selectorType === "connection_id" &&
                  typeof record.value === "string"
                    ? record.value
                    : undefined,
                label:
                  selectorType === "label" && typeof record.value === "string"
                    ? record.value
                    : undefined,
              },
              status:
                selectorType === "latest_active"
                  ? "ambiguous"
                  : typeof record.value === "string" && record.value
                    ? "resolved"
                    : "missing",
              message:
                typeof record.warning === "string"
                  ? record.warning
                  : selectorType === "latest_active"
                    ? "Defaults to the latest active connection."
                    : "Missing selector value.",
              resolvedConnectionId:
                typeof record.resolvedConnectionId === "string"
                  ? record.resolvedConnectionId
                  : undefined,
            } satisfies WorkflowPlannedBinding,
          ];
        })
        .filter((binding) => binding.providerSlug)
    : fallback.bindings;

  const warnings = Array.isArray(shared.warnings)
    ? shared.warnings
        .map((warning) => {
          if (typeof warning === "string") {
            return warning;
          }

          if (
            warning &&
            typeof warning === "object" &&
            typeof (warning as { message?: unknown }).message === "string"
          ) {
            return (warning as { message: string }).message;
          }

          return null;
        })
        .filter((warning): warning is string => Boolean(warning))
    : fallback.warnings;

  const sharedAuth =
    shared.auth && typeof shared.auth === "object"
      ? (shared.auth as Record<string, unknown>)
      : undefined;
  const auth =
    authMode === "secret_manager"
      ? {
          mode: authMode,
          backend:
            sharedAuth?.backend && typeof sharedAuth.backend === "object"
              ? {
                  kind:
                    (sharedAuth.backend as Record<string, unknown>).kind ===
                      "aws_secrets_manager" ||
                    (sharedAuth.backend as Record<string, unknown>).kind ===
                      "gcp_secret_manager"
                      ? ((sharedAuth.backend as Record<string, unknown>).kind as
                          | "aws_secrets_manager"
                          | "gcp_secret_manager")
                      : undefined,
                  region:
                    typeof (sharedAuth.backend as Record<string, unknown>).region ===
                    "string"
                      ? ((sharedAuth.backend as Record<string, unknown>)
                          .region as string)
                      : undefined,
                  projectId:
                    typeof (sharedAuth.backend as Record<string, unknown>)
                      .projectId === "string"
                      ? ((sharedAuth.backend as Record<string, unknown>)
                          .projectId as string)
                      : undefined,
                  secretPrefix:
                    typeof (sharedAuth.backend as Record<string, unknown>)
                      .secretPrefix === "string"
                      ? ((sharedAuth.backend as Record<string, unknown>)
                          .secretPrefix as string)
                      : undefined,
                }
              : fallback.auth?.backend,
          runtimeAccess:
            sharedAuth?.runtimeAccess === "direct" ||
            sharedAuth?.runtimeAccess === "local_cache"
              ? sharedAuth.runtimeAccess
              : fallback.auth?.runtimeAccess || "direct",
          manifest:
            sharedAuth?.manifest &&
            typeof sharedAuth.manifest === "object" &&
            Array.isArray(
              (sharedAuth.manifest as Record<string, unknown>).providers
            )
              ? {
                  version:
                    typeof (sharedAuth.manifest as Record<string, unknown>)
                      .version === "string"
                      ? ((sharedAuth.manifest as Record<string, unknown>)
                          .version as string)
                      : undefined,
                  generatedAt:
                    typeof (sharedAuth.manifest as Record<string, unknown>)
                      .generatedAt === "string"
                      ? ((sharedAuth.manifest as Record<string, unknown>)
                          .generatedAt as string)
                      : undefined,
                  providers: (
                    (sharedAuth.manifest as Record<string, unknown>)
                      .providers as unknown[]
                  ).flatMap((provider) => {
                    if (!provider || typeof provider !== "object") {
                      return [];
                    }

                    const record = provider as Record<string, unknown>;
                    if (typeof record.providerSlug !== "string") {
                      return [];
                    }

                    return [
                      {
                        providerSlug: record.providerSlug,
                        connectionId:
                          typeof record.connectionId === "string"
                            ? record.connectionId
                            : undefined,
                        secretRef:
                          typeof record.secretRef === "string"
                            ? record.secretRef
                            : undefined,
                        authType: (() => {
                          if (
                            record.authType === "oauth2" ||
                            record.authType === "api_key" ||
                            record.authType === "basic"
                          ) {
                            return record.authType as
                              | "oauth2"
                              | "api_key"
                              | "basic";
                          }

                          return undefined;
                        })(),
                        headerName:
                          typeof record.headerName === "string"
                            ? record.headerName
                            : undefined,
                      },
                    ];
                  }),
                }
              : fallback.auth?.manifest,
          legacyModeAliasUsed:
            sharedAuth?.legacyModeAliasUsed === true ||
            shared.authMode === "synced_secrets" ||
            fallback.auth?.legacyModeAliasUsed,
        }
      : {
          mode: "proxy" as const,
          legacyModeAliasUsed:
            shared.authMode === "synced_secrets" ||
            fallback.auth?.legacyModeAliasUsed,
        };

  return {
    ...fallback,
    triggerType,
    executionKind,
    provider,
    region:
      typeof shared.region === "string" ? shared.region : fallback.region,
    gcpProject:
      typeof shared.gcpProject === "string"
        ? shared.gcpProject
        : fallback.gcpProject,
    authMode,
    auth,
    resources,
    bindings,
    warnings,
    summary,
    source: "shared-engine",
  };
}

async function resolveSharedPlanner(): Promise<SharedPlanner | null> {
  try {
    const engineModuleName: string = "@gtmship/deploy-engine";
    const engine = await import(engineModuleName);
    const candidate = (
      engine as Record<string, unknown>
    ).buildWorkflowDeploymentPlan;
    if (typeof candidate === "function") {
      return candidate as SharedPlanner;
    }
  } catch {
    // No-op: fallback planner will be used.
  }

  return null;
}

export async function GET(request: Request) {
  try {
    const defaults = parseDefaults(request);
    const listing = await listStoredWorkflows();
    if (!listing.projectRootConfigured) {
      return NextResponse.json(
        {
          error:
            "Project root is not configured. Configure it from Workflow Studio first.",
        },
        { status: 400 }
      );
    }

    const sharedPlanner = await resolveSharedPlanner();
    const records = await Promise.all(
      listing.workflows.map((workflow) => loadStoredWorkflow(workflow.slug))
    );

    let usedSharedPlanner = false;

    const plans: WorkflowDeploymentPlan[] = await Promise.all(
      records.map(async (record) => {
        const fallbackPlan = buildWorkflowPlanFromArtifact(
          record.artifact,
          defaults
        );

        if (!sharedPlanner) {
          return fallbackPlan;
        }

        try {
          const sharedPlan = await sharedPlanner({
            workflowId: fallbackPlan.workflowId,
            trigger: {
              ...extractTriggerFromSource(record.artifact.code),
              config: record.artifact.triggerConfig,
            },
            deploy: record.artifact.deploy,
            triggerConfig: record.artifact.triggerConfig,
            bindings: record.artifact.bindings,
            integrationProviders: record.artifact.requiredAccesses
              .filter(
                (access) =>
                  access.type === "integration" && Boolean(access.providerSlug),
              )
              .map((access) => access.providerSlug as string),
            defaultProvider: defaults.provider,
            defaultRegion: defaults.region,
            defaultGcpProject: defaults.gcpProject,
          });
          const normalized = normalizeSharedPlan(sharedPlan, fallbackPlan);
          if (normalized) {
            usedSharedPlanner = true;
            return normalized;
          }
        } catch {
          // Shared planner failed for this workflow; fallback planner is safe.
        }

        return fallbackPlan;
      })
    );

    const response: WorkflowDeploymentPlanResponse = {
      provider: defaults.provider || "aws",
      region:
        defaults.region ||
        (defaults.provider === "gcp" ? "us-central1" : "us-east-1"),
      gcpProject: defaults.gcpProject,
      plans,
      usedSharedPlanner,
    };

    return NextResponse.json(response);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to compute deployment plan.",
      },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  const body = await req.json();
  const {
    provider,
    region,
    gcpProject,
    projectName,
    workflow,
    artifact,
  } = body as {
    provider?: WorkflowDeployProvider;
    region?: string;
    gcpProject?: string;
    projectName?: string;
    workflow?: string;
    artifact?: WorkflowStudioArtifact;
  };

  if (!provider || !["aws", "gcp"].includes(provider)) {
    return NextResponse.json(
      { error: "Invalid provider. Must be 'aws' or 'gcp'." },
      { status: 400 }
    );
  }

  const authUrl = process.env.NEXT_PUBLIC_AUTH_URL || "http://localhost:4000";
  try {
    const credRes = await fetch(`${authUrl}/cloud-auth/credentials/${provider}`);
    if (!credRes.ok) {
      return NextResponse.json(
        { error: "Cloud credentials not configured. Add them in Settings." },
        { status: 400 }
      );
    }
  } catch {
    return NextResponse.json(
      { error: "Cannot reach auth service to verify credentials." },
      { status: 503 }
    );
  }

  const args = ["deploy", "--provider", provider];
  if (region) {
    args.push("--region", region);
  }
  if (gcpProject) {
    args.push("--project", gcpProject);
  }
  if (workflow) {
    args.push("--workflow", workflow);
  }

  // Resolve the project root from the database setting (same as Workflow Studio)
  const resolution = await resolveProjectRoot();
  const monorepoRoot = findMonorepoRoot(process.cwd());
  const cliEntry = resolvePath(monorepoRoot, "packages/cli/dist/index.js");
  const projectRoot = resolution.projectRoot || process.env.PROJECT_ROOT || monorepoRoot;
  const projectLabel = projectName || "gtmship";
  const baseArtifact =
    artifact && (!workflow || artifact.slug === workflow)
      ? artifact
      : workflow
        ? (await loadStoredWorkflow(workflow).catch(() => null))?.artifact
        : null;

  async function persistDeploymentRun(
    deploymentRun: WorkflowDeploymentRun
  ): Promise<WorkflowStudioArtifact | null> {
    if (!baseArtifact) {
      return null;
    }

    try {
      const saved = await saveStoredWorkflow({
        ...baseArtifact,
        deploymentRun,
      });
      return saved.artifact;
    } catch (error) {
      console.error("[deploy] Failed to persist workflow deploy run:", error);
      return null;
    }
  }

  return new Promise<NextResponse>((resolve) => {
    const output: string[] = [];
    const child = spawn("node", [cliEntry, ...args], {
      cwd: projectRoot,
      env: {
        ...process.env,
        // Ensure Pulumi local backend doesn't prompt for a passphrase
        PULUMI_CONFIG_PASSPHRASE: process.env.PULUMI_CONFIG_PASSPHRASE ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (data: Buffer) => output.push(data.toString()));
    child.stderr.on("data", (data: Buffer) => output.push(data.toString()));

    child.on("close", (code) => {
      void (async () => {
        const combinedOutput = output.join("");

        if (code === 0) {
          const deploymentRun: WorkflowDeploymentRun = {
            status: "success",
            provider,
            region,
            gcpProject,
            projectName: projectLabel,
            deployedAt: new Date().toISOString(),
            apiEndpoint: extractValue(combinedOutput, "API Endpoint"),
            computeId: extractValue(combinedOutput, "Compute"),
            databaseEndpoint: extractValue(combinedOutput, "Database"),
            storageBucket: extractValue(combinedOutput, "Storage"),
            output: combinedOutput,
          };
          const savedArtifact = await persistDeploymentRun(deploymentRun);

          resolve(
            NextResponse.json({
              success: true,
              provider,
              region,
              projectName: projectLabel,
              apiEndpoint: deploymentRun.apiEndpoint,
              computeId: deploymentRun.computeId,
              databaseEndpoint: deploymentRun.databaseEndpoint,
              storageBucket: deploymentRun.storageBucket,
              output: combinedOutput,
              artifact: savedArtifact,
            })
          );
          return;
        }

        const deploymentRun: WorkflowDeploymentRun = {
          status: "error",
          provider,
          region,
          gcpProject,
          projectName: projectLabel,
          deployedAt: new Date().toISOString(),
          output: combinedOutput,
          error: "Deployment failed",
        };
        const savedArtifact = await persistDeploymentRun(deploymentRun);

        resolve(
          NextResponse.json(
            {
              error: deploymentRun.error,
              output: combinedOutput,
              artifact: savedArtifact,
            },
            { status: 500 }
          )
        );
      })();
    });

    child.on("error", (err) => {
      void (async () => {
        const deploymentRun: WorkflowDeploymentRun = {
          status: "error",
          provider,
          region,
          gcpProject,
          projectName: projectLabel,
          deployedAt: new Date().toISOString(),
          error: `Failed to start deploy: ${err.message}`,
        };
        const savedArtifact = await persistDeploymentRun(deploymentRun);

        resolve(
          NextResponse.json(
            {
              error: deploymentRun.error,
              artifact: savedArtifact,
            },
            { status: 500 }
          )
        );
      })();
    });
  });
}
