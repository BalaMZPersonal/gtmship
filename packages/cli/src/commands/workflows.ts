import type { Command } from "commander";
import { existsSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import {
  loadWorkflowPlans,
  type WorkflowPlanRecord,
} from "../lib/workflow-plans.js";
import { apiDelete } from "../lib/api-client.js";
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

function loadPlans(workflowId?: string): WorkflowPlanRecord[] {
  try {
    return loadWorkflowPlans(process.cwd(), {
      workflowId,
    });
  } catch {
    return [];
  }
}

async function listWorkflows(opts: OutputOptions) {
  try {
    const plans = loadPlans();
    const data = plans.map((p) => ({
      workflowId: p.workflowId,
      name: p.workflowName || "",
      filePath: p.filePath,
      trigger: p.plan.trigger.type,
      executionKind: p.plan.executionKind,
      provider: p.plan.provider,
      bindings: p.plan.bindings.length,
    }));

    formatOutput(data, opts, () => {
      if (data.length === 0) {
        printWarning("No workflows found in ./workflows/");
        return;
      }
      printTable(
        data.map((w) => ({
          id: w.workflowId,
          name: w.name,
          trigger: w.trigger,
          kind: w.executionKind,
          provider: w.provider,
          bindings: String(w.bindings),
        })),
        [
          { key: "id", label: "ID" },
          { key: "name", label: "Name" },
          { key: "trigger", label: "Trigger" },
          { key: "kind", label: "Exec Kind" },
          { key: "provider", label: "Provider" },
          { key: "bindings", label: "Bindings" },
        ],
      );
    });
  } catch (err) {
    handleError(err, opts);
  }
}

async function getWorkflow(id: string, opts: OutputOptions) {
  try {
    const plans = loadPlans(id);
    if (plans.length === 0) {
      if (opts.json) {
        console.log(JSON.stringify({ error: `Workflow "${id}" not found.` }));
      } else {
        console.log(chalk.red(`  Workflow "${id}" not found.`));
      }
      process.exit(1);
    }

    const plan = plans[0];
    const detail = {
      workflowId: plan.workflowId,
      name: plan.workflowName,
      filePath: plan.filePath,
      plan: plan.plan,
    };

    formatOutput(detail, opts, () => {
      console.log("");
      printDetail("Workflow ID", plan.workflowId);
      printDetail("Name", plan.workflowName || "—");
      printDetail("File", plan.filePath);
      printDetail("Trigger", plan.plan.trigger.type);
      printDetail("Trigger Detail", plan.plan.trigger.description);
      printDetail("Execution Kind", plan.plan.executionKind);
      printDetail("Provider", plan.plan.provider);
      printDetail("Region", plan.plan.region);
      printDetail("Auth Mode", plan.plan.authMode);

      if (plan.plan.bindings.length > 0) {
        console.log(chalk.bold("\n  Bindings:"));
        for (const binding of plan.plan.bindings) {
          console.log(
            chalk.gray(
              `    ${binding.providerSlug} → ${binding.selector.type}${binding.selector.connectionId ? `:${binding.selector.connectionId}` : binding.selector.label ? `:${binding.selector.label}` : ""}`,
            ),
          );
        }
      }

      if (plan.plan.resources.length > 0) {
        console.log(chalk.bold("\n  Resources:"));
        for (const resource of plan.plan.resources) {
          console.log(chalk.gray(`    ${resource.kind}`));
        }
      }

      if (plan.plan.warnings.length > 0) {
        console.log(chalk.bold("\n  Warnings:"));
        for (const warning of plan.plan.warnings) {
          console.log(chalk.yellow(`    ${warning}`));
        }
      }
      console.log("");
    });
  } catch (err) {
    handleError(err, opts);
  }
}

async function deleteWorkflow(
  id: string,
  opts: OutputOptions & { force?: boolean; removeDeployment?: boolean },
) {
  try {
    const confirmed = await confirmAction(
      `Delete workflow "${id}"?${opts.removeDeployment ? " This will also remove its deployments." : ""}`,
      opts,
    );
    if (!confirmed) return;

    // Find and delete workflow file
    const workflowsDir = join(process.cwd(), "workflows");
    let deleted = false;
    if (existsSync(workflowsDir)) {
      const files = readdirSync(workflowsDir);
      for (const file of files) {
        if (
          file === `${id}.ts` ||
          file === `${id}.js`
        ) {
          unlinkSync(join(workflowsDir, file));
          deleted = true;
          break;
        }
      }
    }

    // Delete studio metadata
    const metadataPath = join(
      process.cwd(),
      ".gtmship",
      "workflows",
      `${id}.json`,
    );
    if (existsSync(metadataPath)) {
      unlinkSync(metadataPath);
    }

    // Optionally remove deployments
    if (opts.removeDeployment) {
      try {
        await apiDelete(
          `/workflow-control/deployments?workflowId=${encodeURIComponent(id)}`,
        );
      } catch {
        printWarning("Could not remove deployments from control plane.");
      }
    }

    const result = { deleted, workflowId: id };
    formatOutput(result, opts, () => {
      if (deleted) {
        printSuccess(`Workflow "${id}" deleted.`);
      } else {
        printWarning(`Workflow file for "${id}" not found locally.`);
      }
    });
  } catch (err) {
    handleError(err, opts);
  }
}

export function registerWorkflowsCommand(program: Command) {
  const cmd = program
    .command("workflows")
    .description("Manage workflows");

  cmd
    .command("list")
    .description("List all workflows")
    .option("--json", "Output as JSON")
    .action((opts) => listWorkflows(opts));

  cmd
    .command("get")
    .description("Get workflow details")
    .argument("<id>", "Workflow ID")
    .option("--json", "Output as JSON")
    .action((id, opts) => getWorkflow(id, opts));

  cmd
    .command("delete")
    .description("Delete a workflow")
    .argument("<id>", "Workflow ID")
    .option("--force", "Skip confirmation")
    .option("--remove-deployment", "Also remove deployments")
    .option("--json", "Output as JSON")
    .action((id, opts) => deleteWorkflow(id, opts));
}
