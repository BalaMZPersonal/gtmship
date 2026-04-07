#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { devCommand } from "./commands/dev.js";
import { authCommand } from "./commands/auth.js";
import { validateCommand } from "./commands/validate.js";
import { buildCommand } from "./commands/build.js";
import { deployCommand } from "./commands/deploy.js";
import { logsCommand } from "./commands/logs.js";
import { triggersCommand } from "./commands/triggers.js";
import { registerConnectionsCommand } from "./commands/connections.js";
import { registerProvidersCommand } from "./commands/providers.js";
import { registerWorkflowsCommand } from "./commands/workflows.js";
import { registerDeploymentsCommand } from "./commands/deployments.js";
import { registerSettingsCommand } from "./commands/settings.js";
import { registerMemoriesCommand } from "./commands/memories.js";
import { registerOAuthProvidersCommand } from "./commands/oauth-providers.js";
import { registerSetupCommand } from "./commands/setup.js";
import { openCommand } from "./commands/open.js";
import { startCommand } from "./commands/start.js";
import { stopCommand } from "./commands/stop.js";
import { statusCommand } from "./commands/status.js";
import {
  localDispatchCommand,
  localRunCommand,
} from "./commands/local.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };
const program = new Command();

program
  .name("gtmship")
  .description("Build GTM workflows with AI. Ship to your cloud.")
  .version(version);

program
  .command("init")
  .description("Scaffold a new GTMShip project")
  .argument("[name]", "Project name", "my-gtm-workflows")
  .action(initCommand);

program
  .command("dev")
  .description("Start local development environment")
  .action(devCommand);

program
  .command("open")
  .description("Start the local GTMShip runtime and open the dashboard")
  .action(openCommand);

program
  .command("start")
  .description("Start the local GTMShip runtime")
  .action(startCommand);

program
  .command("stop")
  .description("Stop the local GTMShip runtime")
  .action(stopCommand);

program
  .command("status")
  .description("Show the local GTMShip runtime status")
  .action(statusCommand);

program
  .command("auth")
  .description("Manage platform connections")
  .command("add")
  .argument("<provider>", "Provider slug (e.g., hubspot, salesforce, slack)")
  .description("Add a new platform connection")
  .action(authCommand);

program
  .command("validate")
  .description("Validate workflows and connection configs")
  .action(validateCommand);

program
  .command("build")
  .description("Build workflow code for deployment")
  .option("--workflow <id>", "Build a specific workflow only")
  .option("--provider <provider>", "Target cloud provider (aws or gcp)")
  .option("--push", "Push container image to registry (GCP only)")
  .option("--project <name>", "GCP project ID (for Artifact Registry)")
  .option("--region <region>", "Cloud region")
  .action(buildCommand);

program
  .command("deploy")
  .description("Deploy workflows to configured cloud")
  .option("--provider <provider>", "Cloud provider (aws or gcp)", "aws")
  .option("--region <region>", "Cloud region")
  .option("--project <name>", "GCP project ID (required for GCP)")
  .option("--workflow <id>", "Deploy a specific workflow only")
  .action(deployCommand);

program
  .command("logs")
  .description("View execution logs from deployed workflows")
  .option("--workflow <id>", "Filter by workflow ID")
  .option("--provider <provider>", "Cloud provider (aws or gcp)")
  .option("--follow", "Stream logs in real-time")
  .option("--since <duration>", "Show logs since duration (e.g., 1h, 30m)", "1h")
  .option("--limit <n>", "Maximum number of log entries", "100")
  .action(logsCommand);

const localProgram = program
  .command("local")
  .description("Manage local workflow deployments");

localProgram
  .command("dispatch")
  .description("Dispatch locally scheduled workflows that are due to run")
  .action(localDispatchCommand);

localProgram
  .command("run")
  .description("Run a locally deployed workflow immediately")
  .argument("<workflow>", "Workflow ID")
  .option("--payload <json>", "Inline JSON payload or a path to a JSON file")
  .option("--json", "Output as JSON")
  .action(localRunCommand);

program
  .command("triggers")
  .description("Show trigger configuration and webhook URLs")
  .option("--workflow <id>", "Filter by workflow ID")
  .action(triggersCommand);

registerConnectionsCommand(program);
registerProvidersCommand(program);
registerWorkflowsCommand(program);
registerDeploymentsCommand(program);
registerSettingsCommand(program);
registerMemoriesCommand(program);
registerOAuthProvidersCommand(program);
registerSetupCommand(program);

program.parse();
