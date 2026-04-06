import type { Command } from "commander";
import chalk from "chalk";
import { apiGet, apiPut, apiDelete, apiPost } from "../lib/api-client.js";
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
  type CliConnectionAuthStrategyStatus,
  summarizeConfiguredSecretBackends,
} from "../lib/connection-auth.js";

function renderAuthStrategyStatus(
  status: CliConnectionAuthStrategyStatus,
  options?: { includeBackfill?: boolean }
): void {
  console.log("");
  printDetail("Mode", status.mode);
  printDetail("Status", status.status || (status.mode === "proxy" ? "healthy" : "unknown"));
  printDetail(
    "Backends",
    summarizeConfiguredSecretBackends(status.configuredBackends)
  );

  if (status.replicaSummary) {
    const summary = status.replicaSummary;
    printDetail(
      "Replicas",
      `${summary.active}/${summary.expectedReplicas} active, ${summary.pending} pending, ${summary.error} error, ${summary.missing} missing`
    );
    printDetail(
      "Connections",
      `${summary.activeConnections} active connection${summary.activeConnections === 1 ? "" : "s"}`
    );
  }

  if (options?.includeBackfill && status.backfill?.connections) {
    const connections = status.backfill.connections;
    printDetail(
      "Connection Backfill",
      `${connections.syncedReplicas} synced, ${connections.errorReplicas} error across ${connections.activeConnections} active connection${connections.activeConnections === 1 ? "" : "s"}`
    );
  }

  if (options?.includeBackfill && status.backfill?.deployments) {
    const deployments = status.backfill.deployments;
    printDetail(
      "Deployment Backfill",
      `${deployments.updated} updated, ${deployments.skipped} skipped out of ${deployments.total}`
    );
  }

  if (status.mode === "secret_manager" && status.status && status.status !== "healthy") {
    printWarning("Secret-manager auth still has pending, missing, or errored replicas.");
  }

  console.log("");
}

async function listSettings(opts: OutputOptions) {
  try {
    const data = await apiGet("/settings");
    formatOutput(data, opts, () => {
      const items = data as Array<{ key: string; value: string }>;
      printTable(
        items.map((s) => ({ key: s.key, value: s.value })),
        [
          { key: "key", label: "Key" },
          { key: "value", label: "Value" },
        ],
      );
    });
  } catch (err) {
    handleError(err, opts);
  }
}

async function getSetting(key: string, opts: OutputOptions) {
  try {
    const data = await apiGet(`/settings/${encodeURIComponent(key)}`);
    formatOutput(data, opts, () => {
      const setting = data as { key: string; value: string };
      printDetail(setting.key, setting.value);
    });
  } catch (err) {
    handleError(err, opts);
  }
}

async function setSetting(key: string, value: string, opts: OutputOptions) {
  try {
    const data = await apiPut(`/settings/${encodeURIComponent(key)}`, { value });
    formatOutput(data, opts, () => {
      printSuccess(`Setting "${key}" updated.`);
    });
  } catch (err) {
    handleError(err, opts);
  }
}

async function deleteSetting(
  key: string,
  opts: OutputOptions & { force?: boolean },
) {
  try {
    const confirmed = await confirmAction(
      `Delete setting "${key}"?`,
      opts,
    );
    if (!confirmed) return;

    await apiDelete(`/settings/${encodeURIComponent(key)}`);
    formatOutput({ deleted: true, key }, opts, () => {
      printSuccess(`Setting "${key}" deleted.`);
    });
  } catch (err) {
    handleError(err, opts);
  }
}

async function getAuthStrategy(opts: OutputOptions) {
  try {
    const data = await apiGet("/settings/auth-strategy");
    formatOutput(data, opts, () => {
      renderAuthStrategyStatus(data as CliConnectionAuthStrategyStatus);
    });
  } catch (err) {
    handleError(err, opts);
  }
}

async function setAuthStrategy(mode: string, opts: OutputOptions) {
  try {
    const data = await apiPut("/settings/auth-strategy", { mode });
    formatOutput(data, opts, () => {
      printSuccess(`Auth strategy set to "${mode}".`);
      renderAuthStrategyStatus(data as CliConnectionAuthStrategyStatus, {
        includeBackfill: true,
      });
    });
  } catch (err) {
    handleError(err, opts);
  }
}

async function validateCloud(provider: string, opts: OutputOptions) {
  try {
    const data = await apiPost("/cloud-auth/validate", { provider });
    formatOutput(data, opts, () => {
      const result = data as {
        valid: boolean;
        identity?: string;
        projectId?: string;
        error?: string;
      };
      if (result.valid) {
        printSuccess(`${provider.toUpperCase()} credentials are valid.`);
        if (result.identity) printDetail("Identity", result.identity);
        if (result.projectId) printDetail("Project", result.projectId);
      } else {
        console.log(chalk.red(`  ${provider.toUpperCase()} credentials are invalid.`));
        if (result.error) console.log(chalk.red(`  ${result.error}`));
      }
    });
  } catch (err) {
    handleError(err, opts);
  }
}

export function registerSettingsCommand(program: Command) {
  const cmd = program
    .command("settings")
    .description("Manage application settings");

  cmd
    .command("list")
    .description("List all settings")
    .option("--json", "Output as JSON")
    .action((opts) => listSettings(opts));

  cmd
    .command("get")
    .description("Get a specific setting")
    .argument("<key>", "Setting key")
    .option("--json", "Output as JSON")
    .action((key, opts) => getSetting(key, opts));

  cmd
    .command("set")
    .description("Set a setting value")
    .argument("<key>", "Setting key")
    .argument("<value>", "Setting value")
    .option("--json", "Output as JSON")
    .action((key, value, opts) => setSetting(key, value, opts));

  cmd
    .command("delete")
    .description("Delete a setting")
    .argument("<key>", "Setting key")
    .option("--force", "Skip confirmation")
    .option("--json", "Output as JSON")
    .action((key, opts) => deleteSetting(key, opts));

  cmd
    .command("auth-strategy")
    .description("View current auth strategy")
    .option("--json", "Output as JSON")
    .action((opts) => getAuthStrategy(opts));

  cmd
    .command("set-auth-strategy")
    .description("Change auth strategy mode")
    .argument("<mode>", "Auth mode (proxy or secret_manager)")
    .option("--json", "Output as JSON")
    .action((mode, opts) => setAuthStrategy(mode, opts));

  cmd
    .command("validate-cloud")
    .description("Validate cloud provider credentials")
    .argument("<provider>", "Cloud provider (aws or gcp)")
    .option("--json", "Output as JSON")
    .action((provider, opts) => validateCloud(provider, opts));
}
