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
import { buildWorkflows, type BuildArtifact } from "./build.js";

interface DeployOptions {
  provider: string;
  region?: string;
  project?: string;
  workflow?: string;
}

/**
 * Resolve cloud credentials from auth service or environment.
 */
async function resolveCredentials(
  provider: string,
  authUrl: string,
): Promise<void> {
  try {
    const res = await fetch(`${authUrl}/cloud-auth/credentials/${provider}`);
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
        process.env.GOOGLE_APPLICATION_CREDENTIALS = tmpPath;
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
        "  No GCP credentials in auth service. Using environment/gcloud default credentials.",
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
}

async function syncWorkflowControlPlane(
  authUrl: string,
  workflowPlans: WorkflowPlanRecord[],
  context: {
    rawOutputs: Record<string, string>;
    provider: "aws" | "gcp";
    region: string;
    gcpProject?: string;
    computeId: string;
    apiEndpoint: string;
    schedulerJobId?: string;
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
  const response = await fetch(
    `${authUrl}/workflow-control-plane/deployments/sync`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deployments: workflowPlans.map((workflowPlan) => {
          const plan = workflowPlan.plan;
          const endpointUrl =
            context.gcpTarget?.endpointUrl || context.apiEndpoint || null;
          const schedulerId =
            context.gcpTarget?.schedulerJobId ||
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
                  computeType: "lambda",
                  computeName: context.computeId || null,
                  endpointUrl,
                  schedulerId: null,
                  region: plan.region || context.region,
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
              authManifest: plan.auth.manifest,
              runtimeTarget,
              platformOutputs: context.rawOutputs,
            },
            status: "active",
            deployedAt: new Date().toISOString(),
          };
        }),
      }),
    },
  );

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || response.statusText);
  }

  const payload = (await response.json()) as { deployments?: unknown[] };
  return Array.isArray(payload.deployments) ? payload.deployments.length : 0;
}

export async function deployCommand(options: DeployOptions) {
  console.log(chalk.blue("\n  Deploying GTMShip workflows...\n"));

  const config = readProjectConfig();
  const provider = (options.provider ||
    config?.deploy?.provider ||
    "aws") as "aws" | "gcp";
  const region =
    options.region ||
    config?.deploy?.region ||
    (provider === "aws" ? "us-east-1" : "us-central1");
  const compute = provider === "aws" ? "lambda" : "cloud-run";
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
    const connRes = await fetch(`${authUrl}/connections`);
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

  const workflowPlans = loadWorkflowPlans(process.cwd(), {
    providerOverride: provider,
    regionOverride: region,
    gcpProjectOverride: gcpProject,
    workflowId: options.workflow,
    connections,
  });

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

  // Derive resource needs from workflow plans
  const hasSchedule = workflowPlans.some((wp) => wp.plan.trigger.type === "schedule");
  const hasJob = workflowPlans.some((wp) => wp.plan.executionKind === "job");
  const hasSecretManager = workflowPlans.some((wp) => wp.plan.authMode === "secret_manager");
  const schedulePlan = workflowPlans.find((wp) => wp.plan.trigger.type === "schedule")?.plan;

  const gcpNeeds = provider === "gcp" ? {
    executionKind: (hasJob ? "job" : "service") as "job" | "service",
    cloudScheduler: hasSchedule,
    scheduleCron: schedulePlan?.trigger.cron,
    scheduleTimezone: schedulePlan?.trigger.timezone,
    secretManager: hasSecretManager,
    database: false,
    storage: false,
  } : undefined;

  console.log("");

  // -------------------------------------------------------------------------
  // Build workflow code
  // -------------------------------------------------------------------------

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

  const lambdaCodePath =
    provider === "aws" ? buildArtifacts[0]?.artifactPath : undefined;
  const serviceCodePath =
    provider === "gcp" ? (buildArtifacts[0]?.imageUri || buildArtifacts[0]?.artifactPath) : undefined;

  // -------------------------------------------------------------------------
  // Build runtime environment variables
  // -------------------------------------------------------------------------

  const executionKind = gcpNeeds?.executionKind || "service";
  const runtimeEnvVars: Record<string, string> = {
    GTMSHIP_RUNTIME_MODE:
      provider === "aws"
        ? "lambda"
        : executionKind === "job"
          ? "cloud-run-job"
          : "cloud-run-service",
    GTMSHIP_WORKFLOW_ID: workflowPlans[0]?.workflowId || "",
    GTMSHIP_RUNTIME_AUTH_MODE: "secret_manager",
    GTMSHIP_SECRET_BACKEND_KIND:
      provider === "aws" ? "aws_secrets_manager" : "gcp_secret_manager",
    GTMSHIP_SECRET_BACKEND_REGION: region,
    ...(provider === "gcp" && gcpProject
      ? { GTMSHIP_SECRET_BACKEND_PROJECT_ID: gcpProject }
      : {}),
    GTMSHIP_RUNTIME_AUTH_MANIFEST: JSON.stringify(
      workflowPlans[0]?.plan.auth?.manifest || { providers: [] },
    ),
  };

  // Ensure Pulumi local backend doesn't prompt for a passphrase
  if (!process.env.PULUMI_CONFIG_PASSPHRASE && !process.env.PULUMI_CONFIG_PASSPHRASE_FILE) {
    process.env.PULUMI_CONFIG_PASSPHRASE = "";
  }

  const credSpinner = ora("Resolving cloud credentials...").start();
  await resolveCredentials(provider, authUrl);
  credSpinner.succeed("Cloud credentials resolved");

  const deploySpinner = ora(
    `Deploying to ${provider.toUpperCase()} ${region}...`,
  ).start();

  try {
    const { deploy } = await import("@gtmship/deploy-engine");

    const result = await deploy({
      provider,
      region,
      compute: compute as "lambda" | "ecs" | "cloud-run",
      projectName,
      gcpProject,
      gcpNeeds,
      lambdaCodePath,
      serviceCodePath,
      runtimeEnvVars,
    });

    deploySpinner.succeed("Infrastructure deployed successfully");
    console.log("");

    console.log(chalk.green("  Deployment Summary"));
    console.log(chalk.green("  " + "─".repeat(50)));
    console.log(
      chalk.white(`  API Endpoint:   ${chalk.cyan(result.apiEndpoint)}`),
    );
    console.log(
      chalk.white(`  Compute:        ${chalk.gray(result.computeId)}`),
    );
    console.log(
      chalk.white(
        `  Database:       ${chalk.gray(result.databaseEndpoint)}`,
      ),
    );
    console.log(
      chalk.white(`  Storage:        ${chalk.gray(result.storageBucket)}`),
    );
	    console.log("");

	    try {
	      const deployedWorkflowPlans = loadWorkflowPlans(process.cwd(), {
	        providerOverride: provider,
	        regionOverride: region,
	        gcpProjectOverride: gcpProject,
	        workflowId: options.workflow,
	        baseUrl: result.apiEndpoint,
	        connections,
	      });
	      const syncedCount = await syncWorkflowControlPlane(
	        authUrl,
	        deployedWorkflowPlans,
	        {
            rawOutputs: result.rawOutputs,
            provider,
            region,
            gcpProject,
            computeId: result.computeId,
            apiEndpoint: result.apiEndpoint,
            schedulerJobId: result.schedulerJobId || undefined,
            gcpTarget: result.gcpTarget,
          },
	      );
      console.log(
        chalk.gray(
          `  Control Plane: synced ${syncedCount} workflow deployment record${syncedCount === 1 ? "" : "s"}`,
        ),
      );
      console.log("");
    } catch (error) {
      console.log(
        chalk.yellow(
          `  Control Plane sync skipped: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      console.log("");
    }

	    console.log(chalk.green("  Workflow Triggers"));
	    console.log(chalk.green("  " + "─".repeat(50)));
	    for (const workflowPlan of loadWorkflowPlans(process.cwd(), {
	      providerOverride: provider,
	      regionOverride: region,
	      gcpProjectOverride: gcpProject,
	      workflowId: options.workflow,
	      baseUrl: result.apiEndpoint,
	      connections,
	    })) {
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
  } catch (err) {
    deploySpinner.fail("Deployment failed");
    console.log(
      chalk.red(
        `\n  ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    process.exit(1);
  } finally {
    cleanupCredentials();
  }
}
