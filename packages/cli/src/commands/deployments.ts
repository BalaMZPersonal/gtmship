import type { Command } from "commander";
import chalk from "chalk";
import { apiGet, apiPost, apiDelete } from "../lib/api-client.js";
import {
  formatOutput,
  printTable,
  printDetail,
  printSuccess,
  printWarning,
  handleError,
  confirmAction,
  type OutputOptions,
} from "../lib/output.js";
import {
  buildLocalDeploymentSyncRecord,
  listLocalDeploymentManifests,
} from "../lib/local-deployments.js";

interface DeploymentListOpts extends OutputOptions {
  workflow?: string;
  provider?: string;
  status?: string;
  live?: boolean;
}

interface DeploymentRecord {
  id: string;
  workflowId: string;
  workflowVersion?: string | null;
  provider: string;
  region?: string | null;
  gcpProject?: string | null;
  executionKind: string;
  status: string;
  authMode?: string;
  authConfig?: unknown;
  triggerType?: string | null;
  triggerConfig?: unknown;
  endpointUrl?: string | null;
  schedulerId?: string | null;
  bindings?: unknown[];
  resourceInventory?: unknown;
  platform?: unknown;
  recentExecutions?: unknown[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function deploymentKey(workflowId: string, region?: string | null): string {
  return `${workflowId}::${region || ""}`;
}

function normalizeSyncResult(payload: unknown): {
  syncedCount: number;
  deployments: unknown[];
} {
  const record = asRecord(payload);
  const deployments = Array.isArray(record.deployments) ? record.deployments : [];
  return {
    syncedCount:
      typeof record.syncedCount === "number"
        ? record.syncedCount
        : deployments.length,
    deployments,
  };
}

async function listDeployments(opts: DeploymentListOpts) {
  try {
    const params = new URLSearchParams();
    if (opts.workflow) params.set("workflowId", opts.workflow);
    if (opts.provider) params.set("provider", opts.provider);
    if (opts.status) params.set("status", opts.status);
    if (opts.live) params.set("includeLive", "true");
    const qs = params.toString();

    const data = await apiGet(
      `/workflow-control/deployments${qs ? `?${qs}` : ""}`,
    );
    formatOutput(data, opts, () => {
      const items = data as Array<{
        id: string;
        workflowId: string;
        provider: string;
        executionKind: string;
        status: string;
        authMode?: string;
        deployedAt?: string;
        endpointUrl?: string;
      }>;
      printTable(
        items.map((d) => ({
          id: d.id,
          workflow: d.workflowId,
          provider: d.provider,
          kind: d.executionKind,
          status: d.status,
          authMode: d.authMode || "",
          deployed: d.deployedAt?.slice(0, 10) || "",
        })),
        [
          { key: "id", label: "ID" },
          { key: "workflow", label: "Workflow" },
          { key: "provider", label: "Provider" },
          { key: "kind", label: "Exec Kind" },
          { key: "status", label: "Status" },
          { key: "authMode", label: "Auth" },
          { key: "deployed", label: "Deployed" },
        ],
      );
    });
  } catch (err) {
    handleError(err, opts);
  }
}

async function getDeployment(
  id: string,
  opts: OutputOptions & { live?: boolean },
) {
  try {
    const params = new URLSearchParams();
    if (opts.live) params.set("includeLive", "true");
    const qs = params.toString();

    const data = await apiGet(
      `/workflow-control/deployments/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`,
    );
    formatOutput(data, opts, () => {
      const d = data as Record<string, unknown>;
      console.log("");
      printDetail("ID", d.id as string);
      printDetail("Workflow", d.workflowId as string);
      printDetail("Provider", d.provider as string);
      printDetail("Execution Kind", d.executionKind as string);
      printDetail("Status", d.status as string);
      printDetail("Auth Mode", d.authMode as string);
      printDetail("Region", d.region as string);
      printDetail("Endpoint", d.endpointUrl as string);
      printDetail("Deployed At", d.deployedAt as string);
      if (typeof d.triggerType === "string") {
        printDetail("Trigger Type", d.triggerType);
      }

      if (d.bindings && Array.isArray(d.bindings) && (d.bindings as unknown[]).length > 0) {
        console.log(chalk.bold("\n  Bindings:"));
        for (const binding of d.bindings as Array<{
          providerSlug: string;
          selectorType: string;
          connectionId?: string;
        }>) {
          console.log(
            chalk.gray(
              `    ${binding.providerSlug} → ${binding.selectorType}${binding.connectionId ? `:${binding.connectionId}` : ""}`,
            ),
          );
        }
      }

      if (d.recentExecutions && Array.isArray(d.recentExecutions)) {
        console.log(chalk.bold("\n  Recent Executions:"));
        for (const exec of d.recentExecutions as Array<{
          executionName?: string;
          fullName?: string;
          status?: string;
          triggerSource?: string;
          startedAt?: string;
          completedAt?: string;
        }>) {
          console.log(
            chalk.gray(
              `    ${exec.executionName || exec.fullName || "—"} | ${exec.status || "—"} | ${exec.triggerSource || "—"} | ${exec.startedAt || exec.completedAt || "—"}`,
            ),
          );
        }
      }

      if (d.liveError) {
        console.log(chalk.red(`\n  Live Error: ${d.liveError}`));
      }
      console.log("");
    });
  } catch (err) {
    handleError(err, opts);
  }
}

interface DeploymentLogsOpts extends OutputOptions {
  since?: string;
  limit?: string;
  execution?: string;
  follow?: boolean;
}

function renderLogEntries(
  result: {
    entries: Array<{
      timestamp: string;
      level: string;
      message: string;
      executionName?: string;
      requestId?: string;
    }>;
    liveError?: string;
  }
): number {
  if (result.liveError) {
    console.log(chalk.red(`  Error: ${result.liveError}\n`));
  }

  if (result.entries.length === 0) {
    console.log(chalk.yellow("  No log entries found."));
    return 0;
  }

  const levelColors: Record<string, (s: string) => string> = {
    error: chalk.red,
    warn: chalk.yellow,
    info: chalk.gray,
  };

  for (const entry of result.entries) {
    const ts = entry.timestamp?.replace("T", " ").replace("Z", "") || "";
    const colorize = levelColors[entry.level] || chalk.gray;
    const levelTag = colorize(`[${entry.level.toUpperCase()}]`.padEnd(7));
    const execTag = entry.executionName
      ? chalk.cyan(`[${entry.executionName}] `)
      : entry.requestId
        ? chalk.cyan(`[${entry.requestId}] `)
        : "";
    console.log(`  ${chalk.gray(ts)} ${levelTag} ${execTag}${entry.message}`);
  }

  return result.entries.length;
}

async function getDeploymentLogs(id: string, opts: DeploymentLogsOpts) {
  try {
    const buildQuery = (sinceValue?: string) => {
      const params = new URLSearchParams();
      if (sinceValue) params.set("since", sinceValue);
      if (opts.limit) params.set("limit", opts.limit);
      if (opts.execution) params.set("executionName", opts.execution);
      return params.toString();
    };

    if (opts.follow && opts.json) {
      throw new Error("--follow is not supported with --json.");
    }

    if (opts.follow) {
      console.log(chalk.gray("  Following deployment logs. Press Ctrl+C to stop.\n"));
      const seen = new Set<string>();
      let nextSince = opts.since;
      for (;;) {
        const qs = buildQuery(nextSince);
        const data = (await apiGet(
          `/workflow-control/deployments/${encodeURIComponent(id)}/logs${qs ? `?${qs}` : ""}`,
        )) as {
          entries: Array<{
            timestamp: string;
            level: string;
            message: string;
            executionName?: string;
            requestId?: string;
          }>;
          liveError?: string;
        };

        const freshEntries = data.entries.filter((entry) => {
          const key = [
            entry.timestamp,
            entry.level,
            entry.executionName || "",
            entry.requestId || "",
            entry.message,
          ].join("::");
          if (seen.has(key)) {
            return false;
          }
          seen.add(key);
          return true;
        });

        if (freshEntries.length > 0 || data.liveError) {
          renderLogEntries({
            ...data,
            entries: freshEntries,
          });
          if (freshEntries.length > 0) {
            console.log("");
          }
        }

        const latestTimestamp = freshEntries.at(-1)?.timestamp;
        if (latestTimestamp) {
          nextSince = latestTimestamp;
        }

        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }

    const qs = buildQuery(opts.since);
    const data = await apiGet(
      `/workflow-control/deployments/${encodeURIComponent(id)}/logs${qs ? `?${qs}` : ""}`,
    );
    formatOutput(data, opts, () => {
      const result = data as {
        entries: Array<{
          timestamp: string;
          level: string;
          message: string;
          executionName?: string;
          requestId?: string;
        }>;
        liveError?: string;
      };

      const count = renderLogEntries(result);
      if (count > 0) {
        console.log(chalk.gray(`\n  ${count} log entries shown.`));
      }
    });
  } catch (err) {
    handleError(err, opts);
  }
}

async function reconcileDeployments(
  opts: OutputOptions & {
    workflow?: string;
    provider?: string;
    region?: string;
    project?: string;
  },
) {
  try {
    if (opts.provider === "local") {
      const manifests = listLocalDeploymentManifests().filter((manifest) =>
        opts.workflow ? manifest.workflowId === opts.workflow : true
      );

      if (manifests.length === 0) {
        formatOutput({ syncedCount: 0, deployments: [] }, opts, () => {
          printWarning("No local deployments found to reconcile.");
        });
        return;
      }

      const existingDeployments = (await apiGet(
        `/workflow-control/deployments?provider=local`,
      )) as DeploymentRecord[];
      const existingByKey = new Map(
        existingDeployments.map((deployment) => [
          deploymentKey(deployment.workflowId, deployment.region),
          deployment,
        ])
      );

      const syncPayload = manifests.map((manifest) => {
        const baseRecord = buildLocalDeploymentSyncRecord(manifest);
        const existing = existingByKey.get(
          deploymentKey(manifest.workflowId, manifest.region)
        );

        if (!existing) {
          return baseRecord;
        }

        const baseResourceInventory = asRecord(baseRecord.resourceInventory);
        const baseRuntimeTarget = asRecord(baseResourceInventory.runtimeTarget);
        const basePlatformOutputs = asRecord(baseResourceInventory.platformOutputs);
        const existingResourceInventory = asRecord(existing.resourceInventory);
        const existingRuntimeTarget = asRecord(existingResourceInventory.runtimeTarget);
        const existingPlatformOutputs = asRecord(
          existingResourceInventory.platformOutputs
        );

        return {
          ...baseRecord,
          workflowVersion: existing.workflowVersion || undefined,
          authMode: existing.authMode,
          triggerType: existing.triggerType || baseRecord.triggerType,
          triggerConfig: existing.triggerConfig || baseRecord.triggerConfig,
          status: existing.status || "active",
          resourceInventory: {
            ...existingResourceInventory,
            ...baseResourceInventory,
            trigger:
              baseRecord.triggerConfig ||
              existing.triggerConfig ||
              existingResourceInventory.trigger,
            runtimeTarget: {
              ...existingRuntimeTarget,
              ...baseRuntimeTarget,
            },
            platformOutputs: {
              ...existingPlatformOutputs,
              ...basePlatformOutputs,
            },
          },
        };
      });

      const result = normalizeSyncResult(
        await apiPost("/workflow-control-plane/deployments/sync", {
          deployments: syncPayload,
        })
      );

      formatOutput(result, opts, () => {
        printSuccess(`Reconciled ${result.syncedCount} deployment(s).`);
      });
      return;
    }

    // Fetch all existing deployments with live status
    const params = new URLSearchParams();
    params.set("includeLive", "true");
    if (opts.workflow) params.set("workflowId", opts.workflow);
    if (opts.provider) params.set("provider", opts.provider);
    const qs = params.toString();

    const deployments = (await apiGet(
      `/workflow-control/deployments?${qs}`,
    )) as DeploymentRecord[];

    if (deployments.length === 0) {
      formatOutput({ syncedCount: 0, deployments: [] }, opts, () => {
        printWarning("No deployments found to reconcile.");
      });
      return;
    }

    // Re-sync deployments to update live platform state
    const syncPayload = deployments.map((d) => ({
      workflowId: d.workflowId,
      provider: d.provider,
      region: opts.region || d.region,
      gcpProject: opts.project || d.gcpProject,
      executionKind: d.executionKind,
      endpointUrl: d.endpointUrl,
      schedulerId: d.schedulerId,
      authMode: d.authMode,
      authConfig: d.authConfig,
      triggerType: d.triggerType,
      triggerConfig: d.triggerConfig,
      bindings: d.bindings,
      resourceInventory: d.resourceInventory,
      status: d.status,
    }));

    const result = normalizeSyncResult(await apiPost(
      "/workflow-control-plane/deployments/sync",
      { deployments: syncPayload },
    ));
    formatOutput(result, opts, () => {
      printSuccess(`Reconciled ${result.syncedCount} deployment(s).`);
    });
  } catch (err) {
    handleError(err, opts);
  }
}

async function deleteDeployments(
  opts: OutputOptions & { workflow?: string; force?: boolean },
) {
  try {
    if (!opts.workflow) {
      console.log("  --workflow <id> is required.");
      process.exit(1);
    }

    const confirmed = await confirmAction(
      `Delete all deployments for workflow "${opts.workflow}"?`,
      opts,
    );
    if (!confirmed) return;

    const data = await apiDelete(
      `/workflow-control/deployments?workflowId=${encodeURIComponent(opts.workflow)}`,
    );
    formatOutput(data, opts, () => {
      const result = data as { deletedDeploymentCount?: number };
      printSuccess(
        `Deleted ${result.deletedDeploymentCount ?? 0} deployment(s) for "${opts.workflow}".`,
      );
    });
  } catch (err) {
    handleError(err, opts);
  }
}

export function registerDeploymentsCommand(program: Command) {
  const cmd = program
    .command("deployments")
    .description("Manage workflow deployments");

  cmd
    .command("list")
    .description("List all deployments")
    .option("--workflow <id>", "Filter by workflow ID")
    .option("--provider <provider>", "Filter by provider (aws, gcp, or local)")
    .option("--status <status>", "Filter by status")
    .option("--live", "Include live platform status")
    .option("--json", "Output as JSON")
    .action((opts) => listDeployments(opts));

  cmd
    .command("get")
    .description("Get deployment details")
    .argument("<id>", "Deployment ID")
    .option("--live", "Include live platform status")
    .option("--json", "Output as JSON")
    .action((id, opts) => getDeployment(id, opts));

  cmd
    .command("logs")
    .description("View deployment logs")
    .argument("<id>", "Deployment ID")
    .option("--since <duration>", "Show logs since duration (e.g., 1h, 30m)", "1h")
    .option("--limit <n>", "Maximum log entries", "200")
    .option("--execution <name>", "Filter by execution name")
    .option("--follow", "Poll for new logs")
    .option("--json", "Output as JSON")
    .action((id, opts) => getDeploymentLogs(id, opts));

  cmd
    .command("reconcile")
    .description("Reconcile deployment state from cloud")
    .option("--workflow <id>", "Filter by workflow ID")
    .option("--provider <provider>", "Filter by provider (aws, gcp, or local)")
    .option("--region <region>", "Cloud region")
    .option("--project <name>", "GCP project ID")
    .option("--json", "Output as JSON")
    .action((opts) => reconcileDeployments(opts));

  cmd
    .command("delete")
    .description("Delete deployments for a workflow")
    .option("--workflow <id>", "Workflow ID (required)")
    .option("--force", "Skip confirmation")
    .option("--json", "Output as JSON")
    .action((opts) => deleteDeployments(opts));
}
