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

interface DeploymentListOpts extends OutputOptions {
  workflow?: string;
  provider?: string;
  status?: string;
  live?: boolean;
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
          name?: string;
          status?: string;
          createTime?: string;
        }>) {
          console.log(
            chalk.gray(
              `    ${exec.name || "—"} | ${exec.status || "—"} | ${exec.createTime || "—"}`,
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
}

async function getDeploymentLogs(id: string, opts: DeploymentLogsOpts) {
  try {
    const params = new URLSearchParams();
    if (opts.since) params.set("since", opts.since);
    if (opts.limit) params.set("limit", opts.limit);
    if (opts.execution) params.set("executionName", opts.execution);
    const qs = params.toString();

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
        }>;
        liveError?: string;
      };

      if (result.liveError) {
        console.log(chalk.red(`  Error: ${result.liveError}\n`));
      }

      if (result.entries.length === 0) {
        console.log(chalk.yellow("  No log entries found."));
        return;
      }

      const levelColors: Record<string, (s: string) => string> = {
        error: chalk.red,
        warn: chalk.yellow,
        info: chalk.gray,
      };

      for (const entry of result.entries) {
        const ts = entry.timestamp?.replace("T", " ").replace("Z", "") || "";
        const colorize = levelColors[entry.level] || chalk.gray;
        const levelTag = colorize(
          `[${entry.level.toUpperCase()}]`.padEnd(7),
        );
        const execTag = entry.executionName
          ? chalk.cyan(`[${entry.executionName}] `)
          : "";
        console.log(
          `  ${chalk.gray(ts)} ${levelTag} ${execTag}${entry.message}`,
        );
      }

      console.log(
        chalk.gray(`\n  ${result.entries.length} log entries shown.`),
      );
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
    // Fetch all existing deployments with live status
    const params = new URLSearchParams();
    params.set("includeLive", "true");
    if (opts.workflow) params.set("workflowId", opts.workflow);
    if (opts.provider) params.set("provider", opts.provider);
    const qs = params.toString();

    const deployments = (await apiGet(
      `/workflow-control/deployments?${qs}`,
    )) as Array<{
      id: string;
      workflowId: string;
      provider: string;
      region?: string;
      gcpProject?: string;
      executionKind: string;
      status: string;
      authMode?: string;
      authConfig?: unknown;
      triggerType?: string;
      triggerConfig?: unknown;
      endpointUrl?: string;
      schedulerId?: string;
      bindings?: unknown[];
      resourceInventory?: unknown;
      platform?: unknown;
      recentExecutions?: unknown[];
    }>;

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

    const result = await apiPost(
      "/workflow-control-plane/deployments/sync",
      { deployments: syncPayload },
    );
    formatOutput(result, opts, () => {
      const payload = result as { deployments?: unknown[] };
      const count = Array.isArray(payload.deployments)
        ? payload.deployments.length
        : 0;
      printSuccess(`Reconciled ${count} deployment(s).`);
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
    .option("--provider <provider>", "Filter by provider (aws or gcp)")
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
    .option("--json", "Output as JSON")
    .action((id, opts) => getDeploymentLogs(id, opts));

  cmd
    .command("reconcile")
    .description("Reconcile deployment state from cloud")
    .option("--workflow <id>", "Filter by workflow ID")
    .option("--provider <provider>", "Filter by provider (aws or gcp)")
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
