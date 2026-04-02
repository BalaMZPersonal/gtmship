#!/usr/bin/env node
import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { devCommand } from "./commands/dev.js";
import { authCommand } from "./commands/auth.js";
import { validateCommand } from "./commands/validate.js";
import { buildCommand } from "./commands/build.js";
import { deployCommand } from "./commands/deploy.js";
import { logsCommand } from "./commands/logs.js";
import { triggersCommand } from "./commands/triggers.js";

const program = new Command();

program
  .name("gtmship")
  .description("Build GTM workflows with AI. Ship to your cloud.")
  .version("0.1.0");

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

program
  .command("triggers")
  .description("Show trigger configuration and webhook URLs")
  .option("--workflow <id>", "Filter by workflow ID")
  .action(triggersCommand);

program.parse();
