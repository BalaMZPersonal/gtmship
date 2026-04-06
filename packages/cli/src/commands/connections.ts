import type { Command } from "commander";
import { execSync } from "node:child_process";
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
  fetchConnectionAuthStrategyStatus,
  fetchConnectionSecretReplicas,
  formatSecretBackendTarget,
  isSecretManagerMode,
  summarizeConfiguredSecretBackends,
  summarizeConnectionSecretReplicas,
  triggerConnectionSecretReplicaSync,
  type CliConnectionSecretReplica,
  type CliSecretBackendKind,
} from "../lib/connection-auth.js";

function renderConnectionSecretReplicas(
  replicas: CliConnectionSecretReplica[]
): void {
  printTable(
    replicas.map((replica) => ({
      backend: formatSecretBackendTarget({
        kind: replica.backendKind,
        region: replica.backendRegion,
        projectId: replica.backendProjectId,
      }),
      status: replica.status,
      synced: replica.lastSyncedAt || "",
      runtime_ref: replica.runtimeSecretRef,
      error: replica.lastError || "",
    })),
    [
      { key: "backend", label: "Backend" },
      { key: "status", label: "Status" },
      { key: "synced", label: "Last Synced" },
      { key: "runtime_ref", label: "Runtime Ref" },
      { key: "error", label: "Last Error" },
    ],
  );
}

async function printBackgroundSecretSyncStatus(connectionId: string): Promise<void> {
  const strategy = await fetchConnectionAuthStrategyStatus();
  if (!strategy || !isSecretManagerMode(strategy)) {
    return;
  }

  const backendSummary = summarizeConfiguredSecretBackends(
    strategy.configuredBackends
  );

  try {
    const replicas = await fetchConnectionSecretReplicas(connectionId);
    const summary = summarizeConnectionSecretReplicas(replicas);
    const replicaTargets = Array.from(
      new Set(
        replicas.map((replica) =>
          formatSecretBackendTarget({
            kind: replica.backendKind,
            region: replica.backendRegion,
            projectId: replica.backendProjectId,
          })
        )
      )
    );
    const targetSummary =
      replicaTargets.length > 0 ? replicaTargets.join(", ") : backendSummary;

    if (summary.error > 0) {
      printWarning(
        `Connection saved locally, but ${summary.error} secret replica sync${summary.error === 1 ? "" : "s"} failed.`
      );
      console.log(
        chalk.gray(`  Inspect replicas with: gtmship connections replicas ${connectionId}`)
      );
      return;
    }

    if (summary.pending > 0 || replicas.length === 0) {
      printWarning(
        `Connection saved locally. Secret sync is running in the background for ${targetSummary}.`
      );
      console.log(
        chalk.gray(`  Inspect replicas with: gtmship connections replicas ${connectionId}`)
      );
      return;
    }

    printDetail(
      "Secret Sync",
      `${summary.active} active replica${summary.active === 1 ? "" : "s"} on ${targetSummary}`
    );
  } catch {
    printWarning(
      `Connection saved locally. Secret sync is running in the background for ${backendSummary}.`
    );
    console.log(
      chalk.gray(`  Inspect replicas with: gtmship connections replicas ${connectionId}`)
    );
  }
}

async function listConnections(opts: OutputOptions) {
  try {
    const data = await apiGet("/connections");
    formatOutput(data, opts, () => {
      const items = data as Array<{
        id: string;
        status: string;
        label?: string | null;
        hasToken: boolean;
        provider: { slug: string; name?: string };
      }>;
      printTable(
        items.map((c) => ({
          id: c.id,
          provider: c.provider.slug,
          name: c.provider.name || "",
          status: c.status,
          label: c.label || "",
          token: c.hasToken ? "yes" : "no",
        })),
        [
          { key: "id", label: "ID" },
          { key: "provider", label: "Provider" },
          { key: "name", label: "Name" },
          { key: "status", label: "Status" },
          { key: "label", label: "Label" },
          { key: "token", label: "Token" },
        ],
      );
    });
  } catch (err) {
    handleError(err, opts);
  }
}

async function catalogCommand(
  opts: OutputOptions & { query?: string; category?: string },
) {
  try {
    const params = new URLSearchParams();
    if (opts.query) params.set("q", opts.query);
    if (opts.category) params.set("category", opts.category);
    const qs = params.toString();
    const data = await apiGet(`/catalog${qs ? `?${qs}` : ""}`);
    formatOutput(data, opts, () => {
      const result = data as {
        items: Array<{
          slug: string;
          name: string;
          category: string;
          description?: string;
        }>;
        categories: string[];
      };
      console.log(
        chalk.gray(`  Categories: ${result.categories.join(", ")}\n`),
      );
      printTable(
        result.items.map((item) => ({
          slug: item.slug,
          name: item.name,
          category: item.category,
          description: (item.description || "").slice(0, 60),
        })),
        [
          { key: "slug", label: "Slug" },
          { key: "name", label: "Name" },
          { key: "category", label: "Category" },
          { key: "description", label: "Description" },
        ],
      );
    });
  } catch (err) {
    handleError(err, opts);
  }
}

async function catalogGetCommand(slug: string, opts: OutputOptions) {
  try {
    const data = await apiGet(`/catalog/${encodeURIComponent(slug)}`);
    formatOutput(data, opts, () => {
      const p = data as Record<string, unknown>;
      console.log("");
      printDetail("Slug", p.slug as string);
      printDetail("Name", p.name as string);
      printDetail("Category", p.category as string);
      printDetail("Auth Type", (p.authType || p.auth_type) as string);
      printDetail("Description", p.description as string);
      if (p.baseUrl) printDetail("Base URL", p.baseUrl as string);
      if (p.docsUrl) printDetail("Docs URL", p.docsUrl as string);
      console.log("");
    });
  } catch (err) {
    handleError(err, opts);
  }
}

async function connectCommand(
  slug: string,
  opts: OutputOptions & {
    apiKey?: string;
    label?: string;
    connectionId?: string;
    serviceSlugs?: string;
  },
) {
  try {
    // Determine auth type from provider or catalog
    let authType: string | undefined;
    try {
      const provider = (await apiGet(`/providers/${encodeURIComponent(slug)}`)) as {
        auth_type?: string;
      };
      authType = provider.auth_type;
    } catch {
      try {
        const catalogEntry = (await apiGet(`/catalog/${encodeURIComponent(slug)}`)) as {
          authType?: string;
          auth_type?: string;
        };
        authType = catalogEntry.authType || catalogEntry.auth_type;
      } catch {
        // Provider not found anywhere
      }
    }

    // API key / basic auth flow
    if (authType === "api_key" || authType === "basic" || opts.apiKey) {
      let apiKey = opts.apiKey;
      if (!apiKey) {
        const { default: inquirer } = await import("inquirer");
        const answers = await inquirer.prompt([
          {
            type: "password",
            name: "apiKey",
            message: `Enter API key for ${slug}:`,
            mask: "*",
          },
        ]);
        apiKey = answers.apiKey;
      }

      const body: Record<string, string> = { api_key: apiKey! };
      if (opts.label) body.label = opts.label;
      if (opts.connectionId) body.connection_id = opts.connectionId;

      const data = await apiPost(
        `/auth/${encodeURIComponent(slug)}/connect-key`,
        body,
      );
      const result = data as { id: string; provider: string; status: string };
      formatOutput(data, opts, () => {
        printSuccess(`Connected to ${slug} (ID: ${result.id})`);
      });
      if (!opts.json) {
        await printBackgroundSecretSyncStatus(result.id);
      }
      return;
    }

    // OAuth flow
    if (authType === "oauth2" || !authType) {
      const oauthParams = new URLSearchParams();
      if (opts.serviceSlugs) {
        for (const s of opts.serviceSlugs.split(",").map((v) => v.trim())) {
          oauthParams.append("service_slugs", s);
        }
      }
      const oauthQs = oauthParams.toString();
      const data = (await apiGet(
        `/auth/${encodeURIComponent(slug)}/connect${oauthQs ? `?${oauthQs}` : ""}`,
      )) as { authorize_url: string };

      if (!data.authorize_url) {
        console.log(
          chalk.red(`  No authorize URL returned for ${slug}. Is the provider configured with OAuth credentials?`),
        );
        process.exit(1);
      }

      // Snapshot existing connections before opening browser
      let existingIds: Set<string>;
      try {
        const existing = (await apiGet("/connections")) as Array<{ id: string }>;
        existingIds = new Set(existing.map((c) => c.id));
      } catch {
        existingIds = new Set();
      }

      // Open browser
      try {
        execSync(`open "${data.authorize_url}"`, { stdio: "ignore" });
      } catch {
        console.log(
          chalk.cyan(`  Open this URL in your browser:\n  ${data.authorize_url}`),
        );
      }

      if (opts.json) {
        // In JSON mode, return the authorize_url for the caller to handle
        console.log(
          JSON.stringify({ authorize_url: data.authorize_url, polling: true }),
        );
      } else {
        console.log(
          chalk.gray("  Complete the OAuth flow in your browser. Waiting..."),
        );
      }

      // Poll for new connection
      const timeout = Date.now() + 120_000;
      while (Date.now() < timeout) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const connections = (await apiGet("/connections")) as Array<{
            id: string;
            provider: { slug: string };
            status: string;
          }>;
          const newConn = connections.find(
            (c) => c.provider.slug === slug && !existingIds.has(c.id),
          );
          if (newConn) {
            formatOutput(newConn, opts, () => {
              printSuccess(
                `Connected to ${slug} (ID: ${newConn.id}, status: ${newConn.status})`,
              );
            });
            if (!opts.json) {
              await printBackgroundSecretSyncStatus(newConn.id);
            }
            return;
          }
        } catch {
          // Keep polling
        }
      }

      printWarning("Timed out waiting for OAuth completion.");
      process.exit(1);
    }

    console.log(chalk.red(`  Unknown auth type "${authType}" for provider ${slug}.`));
    process.exit(1);
  } catch (err) {
    handleError(err, opts);
  }
}

async function testConnection(id: string, opts: OutputOptions) {
  try {
    const data = await apiPost(`/connections/${encodeURIComponent(id)}/test`);
    formatOutput(data, opts, () => {
      const result = data as {
        success: boolean;
        status?: number;
        error?: string;
        message?: string;
      };
      if (result.success) {
        printSuccess("Connection test passed.");
        if (result.message) console.log(chalk.gray(`  ${result.message}`));
      } else {
        console.log(chalk.red("  Connection test failed."));
        if (result.error) console.log(chalk.red(`  ${result.error}`));
      }
    });
  } catch (err) {
    handleError(err, opts);
  }
}

async function refreshConnection(id: string, opts: OutputOptions) {
  try {
    const data = await apiPost(
      `/connections/${encodeURIComponent(id)}/refresh`,
    );
    const result = data as {
      success: boolean;
      message?: string;
      error?: string;
      needsReconnect?: boolean;
    };
    formatOutput(data, opts, () => {
      if (result.success) {
        printSuccess("Token refreshed.");
      } else {
        console.log(chalk.red("  Refresh failed."));
        if (result.error) console.log(chalk.red(`  ${result.error}`));
        if (result.needsReconnect) {
          printWarning("Provider requires re-authentication.");
        }
      }
    });
    if (result.success && !opts.json) {
      await printBackgroundSecretSyncStatus(id);
    }
  } catch (err) {
    handleError(err, opts);
  }
}

async function listConnectionSecretReplicas(
  id: string,
  opts: OutputOptions
) {
  try {
    const replicas = await fetchConnectionSecretReplicas(id);
    formatOutput(replicas, opts, () => {
      if (replicas.length === 0) {
        printWarning("No secret replicas found for this connection.");
        return;
      }

      renderConnectionSecretReplicas(replicas);
      const summary = summarizeConnectionSecretReplicas(replicas);
      printDetail(
        "Summary",
        `${summary.active} active, ${summary.pending} pending, ${summary.error} error`
      );
    });
  } catch (err) {
    handleError(err, opts);
  }
}

async function syncConnectionSecrets(
  id: string,
  opts: OutputOptions & {
    backendKind?: CliSecretBackendKind;
    backendRegion?: string;
    backendProjectId?: string;
  }
) {
  try {
    const result = await triggerConnectionSecretReplicaSync({
      connectionId: id,
      backendKind: opts.backendKind,
      backendRegion: opts.backendRegion,
      backendProjectId: opts.backendProjectId,
    });

    formatOutput(result, opts, () => {
      printSuccess(`Secret replicas synced for connection "${id}".`);
      renderConnectionSecretReplicas(result.replicas);
      const summary = summarizeConnectionSecretReplicas(result.replicas);
      printDetail(
        "Summary",
        `${summary.active} active, ${summary.pending} pending, ${summary.error} error`
      );
    });
  } catch (err) {
    handleError(err, opts);
  }
}

async function deleteConnection(
  id: string,
  opts: OutputOptions & { force?: boolean },
) {
  try {
    const confirmed = await confirmAction(
      `Delete connection "${id}"?`,
      opts,
    );
    if (!confirmed) return;

    await apiDelete(`/connections/${encodeURIComponent(id)}`);
    formatOutput({ deleted: true, id }, opts, () => {
      printSuccess(`Connection "${id}" deleted.`);
    });
  } catch (err) {
    handleError(err, opts);
  }
}

export function registerConnectionsCommand(program: Command) {
  const cmd = program
    .command("connections")
    .description("Manage platform connections");

  cmd
    .command("list")
    .description("List all connections")
    .option("--json", "Output as JSON")
    .action((opts) => listConnections(opts));

  cmd
    .command("catalog")
    .description("Browse integration catalog")
    .option("--query <q>", "Search query")
    .option("--category <category>", "Filter by category")
    .option("--json", "Output as JSON")
    .action((opts) => catalogCommand(opts));

  cmd
    .command("catalog-get")
    .description("Get details for a specific catalog provider")
    .argument("<slug>", "Provider slug")
    .option("--json", "Output as JSON")
    .action((slug, opts) => catalogGetCommand(slug, opts));

  cmd
    .command("connect")
    .description("Create a new connection")
    .argument("<slug>", "Provider slug (e.g., hubspot, slack)")
    .option("--api-key <key>", "API key (for api_key/basic providers)")
    .option("--label <label>", "Connection label")
    .option("--connection-id <id>", "Existing connection ID (for reconnect)")
    .option("--service-slugs <slugs>", "Comma-separated service slugs for multi-service OAuth")
    .option("--json", "Output as JSON")
    .action((slug, opts) => connectCommand(slug, opts));

  cmd
    .command("test")
    .description("Test a connection")
    .argument("<id>", "Connection ID")
    .option("--json", "Output as JSON")
    .action((id, opts) => testConnection(id, opts));

  cmd
    .command("refresh")
    .description("Refresh an OAuth token")
    .argument("<id>", "Connection ID")
    .option("--json", "Output as JSON")
    .action((id, opts) => refreshConnection(id, opts));

  cmd
    .command("replicas")
    .description("List secret-manager replicas for a connection")
    .argument("<id>", "Connection ID")
    .option("--json", "Output as JSON")
    .action((id, opts) => listConnectionSecretReplicas(id, opts));

  cmd
    .command("sync-secrets")
    .description("Force a secret-manager sync for a connection")
    .argument("<id>", "Connection ID")
    .option(
      "--backend-kind <kind>",
      "Secret backend kind (aws_secrets_manager or gcp_secret_manager)"
    )
    .option("--backend-region <region>", "AWS secret-manager region override")
    .option("--backend-project-id <projectId>", "GCP secret-manager project override")
    .option("--json", "Output as JSON")
    .action((id, opts) => syncConnectionSecrets(id, opts));

  cmd
    .command("delete")
    .description("Delete a connection")
    .argument("<id>", "Connection ID")
    .option("--force", "Skip confirmation")
    .option("--json", "Output as JSON")
    .action((id, opts) => deleteConnection(id, opts));
}
