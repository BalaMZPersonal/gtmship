import chalk from "chalk";
import { getDeployStatus, getGcpDeployStatus } from "@gtmship/deploy-engine";
import { loadWorkflowPlans, readProjectConfig } from "../lib/workflow-plans.js";

interface TriggersOptions {
  workflow?: string;
}

export async function triggersCommand(options: TriggersOptions) {
  console.log(chalk.blue("\n  Workflow Triggers\n"));

  const config = readProjectConfig();
  const provider = (config?.deploy?.provider || "aws") as "aws" | "gcp";
  const region =
    config?.deploy?.region || (provider === "gcp" ? "us-central1" : "us-east-1");
  const gcpProject = config?.deploy?.gcpProject;
  const projectName = config?.name || "gtmship";

  let apiEndpoint = "";
  try {
    const status =
      provider === "gcp"
        ? await getGcpDeployStatus(projectName)
        : await getDeployStatus(projectName);

    if (status.isDeployed) {
      apiEndpoint = status.outputs["apiGatewayUrl"] || status.outputs["serviceUrl"] || "";
    }
  } catch {
    // Fall back to local planning only.
  }

  const workflowPlans = loadWorkflowPlans(process.cwd(), {
    providerOverride: provider,
    regionOverride: region,
    gcpProjectOverride: gcpProject,
    workflowId: options.workflow,
    baseUrl: apiEndpoint || undefined,
  });

  if (workflowPlans.length === 0) {
    console.log(
      chalk.yellow(
        options.workflow
          ? `  Workflow "${options.workflow}" not found.`
          : "  No workflow files found.",
      ),
    );
    console.log("");
    return;
  }

  if (!apiEndpoint) {
    console.log(
      chalk.gray(
        "  No deployed endpoint detected yet. Showing planned trigger metadata.\n",
      ),
    );
  }

  for (const workflowPlan of workflowPlans) {
    const plan = workflowPlan.plan;
    console.log(
      chalk.white(
        `  ${plan.workflowId}  ${chalk.cyan(plan.trigger.type)} -> ${chalk.cyan(plan.executionKind)}`,
      ),
    );
    console.log(chalk.gray(`     Trigger:   ${plan.trigger.description}`));
    if (plan.trigger.endpoint) {
      console.log(chalk.gray(`     Endpoint:  ${plan.trigger.endpoint}`));
    }
    if (plan.trigger.cron) {
      const timezone = plan.trigger.timezone ? ` (${plan.trigger.timezone})` : "";
      console.log(
        chalk.gray(
          `     Schedule:  ${plan.trigger.cron}${timezone}`,
        ),
      );
    }
    if (plan.trigger.nextRunTime) {
      console.log(
        chalk.gray(
          `     Next Run:  ${plan.trigger.nextRunTime}`,
        ),
      );
    }
    if (plan.trigger.eventName) {
      console.log(chalk.gray(`     Event:     ${plan.trigger.eventName}`));
    }
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
    console.log("");
  }
}
