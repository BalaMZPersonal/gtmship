import { spawn } from "node:child_process";
import { NextResponse } from "next/server";
import {
  getAuthStrategy,
  listActiveConnections,
} from "@/lib/workflow-studio/auth-service";
import { resolveCliInvocation } from "@/lib/runtime/cli";
import { buildWorkflowDeploymentPlanForArtifact } from "@/lib/workflow-studio/deployment";
import {
  listStoredWorkflows,
  loadStoredWorkflow,
} from "@/lib/workflow-studio/storage";
import { resolveProjectRoot } from "@/lib/workflow-studio/project-root";

function readQueryString(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeOutput(output?: string | null): string {
  return (output || "").replace(/\x1b\[[0-9;]*m/g, "");
}

function extractOutputValue(output: string, label: string): string | null {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${escapedLabel}\\s*:\\s+(.+)`);
  const line = normalizeOutput(output)
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => pattern.test(entry))
    .at(-1);

  if (!line) {
    return null;
  }

  return line.replace(pattern, "$1").replace(/^"|"$/g, "").trim() || null;
}

function stripCloudRunName(value?: string | null): string | null {
  const trimmed = value?.trim();
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

  return trimmed;
}

function stripLambdaName(value?: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("lambda:")) {
    return trimmed.slice("lambda:".length) || null;
  }

  const arnMatch = trimmed.match(/:function:([^:/]+)(?::[^/]+)?$/);
  if (arnMatch?.[1]) {
    return arnMatch[1];
  }

  return trimmed.startsWith("arn:") ? null : trimmed;
}

function buildAwsLogGroupName(lambdaName?: string | null): string {
  return lambdaName ? `/aws/lambda/${lambdaName}` : "";
}

function buildGcpPlatformOutputs(input: {
  output?: string | null;
  apiEndpoint?: string | null;
  schedulerJobId?: string | null;
  stackOutputs?: Record<string, string>;
  executionKind: "job" | "service";
}): Record<string, string> {
  const outputText = input.output || "";
  const stackOutputs = input.stackOutputs || {};
  const serviceUrl =
    stackOutputs.gcpEndpointUrl ||
    stackOutputs.serviceUrl ||
    input.apiEndpoint ||
    extractOutputValue(outputText, "API Endpoint") ||
    extractOutputValue(outputText, "serviceUrl") ||
    "";
  const serviceId =
    stackOutputs.gcpComputeName ||
    stackOutputs.serviceId ||
    extractOutputValue(outputText, "Compute") ||
    extractOutputValue(outputText, "serviceId") ||
    stripCloudRunName(serviceUrl) ||
    "";
  const schedulerJobId =
    stackOutputs.schedulerJobId ||
    input.schedulerJobId ||
    extractOutputValue(outputText, "schedulerJobId") ||
    "";
  const targetKind =
    stackOutputs.gcpTargetKind ||
    (serviceUrl.startsWith("job:") || input.executionKind === "job"
      ? "job"
      : "service");

  return {
    ...stackOutputs,
    serviceUrl,
    serviceId,
    schedulerJobId,
    gcpEndpointUrl: stackOutputs.gcpEndpointUrl || serviceUrl,
    gcpComputeName: stackOutputs.gcpComputeName || serviceId,
    gcpTargetKind: targetKind,
  };
}

function buildAwsPlatformOutputs(input: {
  output?: string | null;
  apiEndpoint?: string | null;
  computeId?: string | null;
  schedulerJobId?: string | null;
  stackOutputs?: Record<string, string>;
}): Record<string, string> {
  const outputText = input.output || "";
  const stackOutputs = input.stackOutputs || {};
  const apiGatewayUrl =
    stackOutputs.apiGatewayUrl ||
    input.apiEndpoint ||
    extractOutputValue(outputText, "apiGatewayUrl") ||
    "";
  const lambdaArn =
    stackOutputs.lambdaArn ||
    input.computeId ||
    extractOutputValue(outputText, "lambdaArn") ||
    "";
  const lambdaName =
    stackOutputs.lambdaName ||
    extractOutputValue(outputText, "lambdaName") ||
    stripLambdaName(lambdaArn) ||
    stripLambdaName(input.apiEndpoint) ||
    "";
  const endpointToken =
    stackOutputs.endpointToken ||
    (apiGatewayUrl || (lambdaName ? `lambda:${lambdaName}` : "")) ||
    extractOutputValue(outputText, "endpointToken") ||
    "";
  const schedulerJobId =
    stackOutputs.schedulerJobId ||
    input.schedulerJobId ||
    extractOutputValue(outputText, "schedulerJobId") ||
    "";
  const logGroupName =
    stackOutputs.awsLogGroup ||
    stackOutputs.logGroupName ||
    extractOutputValue(outputText, "awsLogGroup") ||
    extractOutputValue(outputText, "logGroupName") ||
    buildAwsLogGroupName(lambdaName);

  return {
    ...stackOutputs,
    apiGatewayUrl,
    lambdaArn,
    lambdaName,
    endpointToken,
    schedulerJobId,
    logGroupName,
    awsLogGroup: stackOutputs.awsLogGroup || logGroupName,
  };
}

function buildLocalPlatformOutputs(input: {
  output?: string | null;
  apiEndpoint?: string | null;
  computeId?: string | null;
  schedulerJobId?: string | null;
}): Record<string, string> {
  const outputText = input.output || "";
  return {
    apiEndpoint:
      input.apiEndpoint || extractOutputValue(outputText, "API Endpoint") || "",
    computeId:
      input.computeId || extractOutputValue(outputText, "Compute") || "",
    databaseEndpoint: extractOutputValue(outputText, "Database") || "",
    storageBucket: extractOutputValue(outputText, "Storage") || "",
    schedulerJobId:
      input.schedulerJobId ||
      extractOutputValue(outputText, "schedulerJobId") ||
      "",
    localLogPath: extractOutputValue(outputText, "localLogPath") || "",
    localManifestPath: extractOutputValue(outputText, "localManifestPath") || "",
  };
}

export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const provider = readQueryString(searchParams.get("provider")) || "gcp";
    const workflow = readQueryString(searchParams.get("workflow"));
    const region = readQueryString(searchParams.get("region"));
    const gcpProject = readQueryString(searchParams.get("gcpProject"));

    if (provider === "local") {
      const cliInvocation = resolveCliInvocation();
      const resolution = await resolveProjectRoot();
      const projectRoot =
        resolution.projectRoot || process.env.PROJECT_ROOT || process.cwd();
      const workflowId = workflow
        ? (await loadStoredWorkflow(workflow).catch(() => null))?.workflowId || workflow
        : undefined;
      const args = [
        ...cliInvocation.baseArgs,
        "deployments",
        "reconcile",
        "--provider",
        "local",
        "--json",
      ];

      if (workflowId) {
        args.push("--workflow", workflowId);
      }

      return await new Promise<NextResponse>((resolve) => {
        const stdout: string[] = [];
        const stderr: string[] = [];
        const child = spawn(cliInvocation.command, args, {
          cwd: projectRoot,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });

        child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));

        child.on("close", (code) => {
          const stdoutText = stdout.join("");
          const stderrText = stderr.join("");
          try {
            const parsed = stdoutText.trim()
              ? (JSON.parse(stdoutText) as {
                  syncedCount?: number;
                  deployments?: unknown[];
                  error?: string;
                })
              : { syncedCount: 0, deployments: [] };
            if (code === 0) {
              resolve(
                NextResponse.json({
                  syncedCount:
                    typeof parsed.syncedCount === "number"
                      ? parsed.syncedCount
                      : Array.isArray(parsed.deployments)
                        ? parsed.deployments.length
                        : 0,
                  deployments: Array.isArray(parsed.deployments)
                    ? parsed.deployments
                    : [],
                })
              );
              return;
            }

            resolve(
              NextResponse.json(
                {
                  error:
                    parsed.error ||
                    stderrText.trim() ||
                    "Failed to reconcile local workflow deployments.",
                },
                { status: 500 }
              )
            );
          } catch {
            resolve(
              NextResponse.json(
                {
                  error:
                    stderrText.trim() ||
                    stdoutText.trim() ||
                    "Failed to reconcile local workflow deployments.",
                },
                { status: 500 }
              )
            );
          }
        });

        child.on("error", (error) => {
          resolve(
            NextResponse.json(
              {
                error: `Failed to start local deployment reconcile: ${error.message}`,
              },
              { status: 500 }
            )
          );
        });
      });
    }

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

    const workflowSlugs = workflow
      ? [workflow]
      : listing.workflows.map((item) => item.slug);
    const [connections, records, authStrategy] = await Promise.all([
      listActiveConnections(),
      Promise.all(
        workflowSlugs.map((slug) =>
          loadStoredWorkflow(slug).catch(() => null)
        )
      ),
      getAuthStrategy(),
    ]);

    const deployments = [];

    for (const record of records) {
      if (!record) {
        continue;
      }

      const deploymentRun = record.artifact.deploymentRun;
      if (
        !deploymentRun ||
        deploymentRun.status !== "success" ||
        deploymentRun.provider !== provider
      ) {
        continue;
      }

      const plan = buildWorkflowDeploymentPlanForArtifact({
        artifact: record.artifact,
        connections,
        provider,
        region: region || deploymentRun.region || undefined,
        gcpProject:
          provider === "gcp"
            ? gcpProject || deploymentRun.gcpProject || undefined
            : undefined,
        authStrategy,
      });

      const platformOutputs =
        provider === "gcp"
          ? buildGcpPlatformOutputs({
              output: deploymentRun.output,
              apiEndpoint: deploymentRun.apiEndpoint,
              schedulerJobId: deploymentRun.schedulerJobId,
              stackOutputs: {},
              executionKind: plan.executionKind,
            })
          : provider === "local"
            ? buildLocalPlatformOutputs({
                output: deploymentRun.output,
                apiEndpoint: deploymentRun.apiEndpoint,
                computeId: deploymentRun.computeId,
                schedulerJobId: deploymentRun.schedulerJobId,
              })
          : buildAwsPlatformOutputs({
              output: deploymentRun.output,
              apiEndpoint: deploymentRun.apiEndpoint,
              computeId: deploymentRun.computeId,
              schedulerJobId: deploymentRun.schedulerJobId,
              stackOutputs: {},
            });

      const endpointUrl =
        provider === "gcp"
          ? platformOutputs.gcpEndpointUrl || null
          : provider === "local"
            ? platformOutputs.apiEndpoint || null
          : platformOutputs.endpointToken || platformOutputs.apiGatewayUrl || null;
      const schedulerId = platformOutputs.schedulerJobId || null;
      const resolvedRegion = region || deploymentRun.region || plan.region;
      const resolvedProject =
        gcpProject || deploymentRun.gcpProject || plan.gcpProject || null;

      if (
        provider === "gcp" &&
        !endpointUrl &&
        !platformOutputs.gcpComputeName
      ) {
        continue;
      }

      if (
        provider === "aws" &&
        !endpointUrl &&
        !platformOutputs.lambdaName &&
        !platformOutputs.lambdaArn
      ) {
        continue;
      }

      deployments.push({
        workflowId: plan.workflowId,
        provider: plan.provider,
        region: resolvedRegion,
        gcpProject: provider === "gcp" ? resolvedProject : null,
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
          runtimeTarget:
            provider === "gcp"
              ? {
                  computeType:
                    platformOutputs.gcpTargetKind === "job" ? "job" : "service",
                  computeName: platformOutputs.gcpComputeName || null,
                  endpointUrl,
                  schedulerId,
                  gcpProject: resolvedProject,
                  region: resolvedRegion,
                }
              : provider === "local"
                ? {
                    computeType: "job",
                    computeName: platformOutputs.computeId || plan.workflowId,
                    endpointUrl,
                    schedulerId,
                    region: resolvedRegion,
                    logPath: platformOutputs.localLogPath || null,
                  }
              : {
                  computeType: "lambda",
                  computeName: platformOutputs.lambdaName || null,
                  endpointUrl,
                  schedulerId,
                  region: resolvedRegion,
                  logGroupName:
                    platformOutputs.awsLogGroup ||
                    platformOutputs.logGroupName ||
                    null,
                },
          platformOutputs,
        },
        status: "active",
        deployedAt: deploymentRun.deployedAt || new Date().toISOString(),
      });
    }

    if (deployments.length === 0) {
      return NextResponse.json({
        syncedCount: 0,
        deployments: [],
      });
    }

    const authUrl =
      process.env.AUTH_SERVICE_URL ||
      process.env.NEXT_PUBLIC_AUTH_URL ||
      "http://localhost:4000";

    const response = await fetch(
      `${authUrl}/workflow-control-plane/deployments/sync`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deployments }),
      }
    );

    const text = await response.text();
    if (!response.ok) {
      return NextResponse.json(
        {
          error: text || "Failed to reconcile workflow deployments.",
        },
        { status: response.status }
      );
    }

    const payload =
      text.trim().length > 0
        ? (JSON.parse(text) as { deployments?: unknown[] })
        : { deployments: [] };

    return NextResponse.json({
      syncedCount: Array.isArray(payload.deployments)
        ? payload.deployments.length
        : deployments.length,
      deployments: Array.isArray(payload.deployments) ? payload.deployments : [],
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to reconcile workflow deployments.",
      },
      { status: 500 }
    );
  }
}
