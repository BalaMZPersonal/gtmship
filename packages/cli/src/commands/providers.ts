import type { Command } from "commander";
import chalk from "chalk";
import { apiGet, apiPost, apiPut, apiDelete } from "../lib/api-client.js";
import {
  formatOutput,
  printTable,
  printDetail,
  printSuccess,
  handleError,
  confirmAction,
  type OutputOptions,
} from "../lib/output.js";

async function listProviders(opts: OutputOptions) {
  try {
    const data = await apiGet("/providers");
    formatOutput(data, opts, () => {
      const items = data as Array<{
        slug: string;
        name: string;
        auth_type: string;
        base_url?: string;
        category?: string;
        _connectionCount?: number;
      }>;
      printTable(
        items.map((p) => ({
          slug: p.slug,
          name: p.name,
          auth_type: p.auth_type,
          category: p.category || "",
          connections: String(p._connectionCount ?? 0),
        })),
        [
          { key: "slug", label: "Slug" },
          { key: "name", label: "Name" },
          { key: "auth_type", label: "Auth Type" },
          { key: "category", label: "Category" },
          { key: "connections", label: "Connections" },
        ],
      );
    });
  } catch (err) {
    handleError(err, opts);
  }
}

async function getProvider(slug: string, opts: OutputOptions) {
  try {
    const data = await apiGet(`/providers/${encodeURIComponent(slug)}`);
    formatOutput(data, opts, () => {
      const p = data as Record<string, unknown>;
      console.log("");
      printDetail("Name", p.name as string);
      printDetail("Slug", p.slug as string);
      printDetail("Auth Type", p.auth_type as string);
      printDetail("Base URL", p.base_url as string);
      if (p.authorize_url)
        printDetail("Authorize URL", p.authorize_url as string);
      if (p.token_url) printDetail("Token URL", p.token_url as string);
      if (p.scopes)
        printDetail("Scopes", (p.scopes as string[]).join(", "));
      if (p.header_name) printDetail("Header Name", p.header_name as string);
      if (p.test_endpoint)
        printDetail("Test Endpoint", p.test_endpoint as string);
      if (p.category) printDetail("Category", p.category as string);
      if (p.description) printDetail("Description", p.description as string);
      if (p.docs_url) printDetail("Docs URL", p.docs_url as string);
      if (p.source) printDetail("Source", p.source as string);
      console.log("");
    });
  } catch (err) {
    handleError(err, opts);
  }
}

interface CreateProviderFlags extends OutputOptions {
  name?: string;
  slug?: string;
  authType?: string;
  baseUrl?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  scopes?: string;
  headerName?: string;
  testEndpoint?: string;
  clientId?: string;
  clientSecret?: string;
  category?: string;
  description?: string;
}

function buildProviderBody(flags: CreateProviderFlags): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (flags.name) body.name = flags.name;
  if (flags.slug) body.slug = flags.slug;
  if (flags.authType) body.auth_type = flags.authType;
  if (flags.baseUrl) body.base_url = flags.baseUrl;
  if (flags.authorizeUrl) body.authorize_url = flags.authorizeUrl;
  if (flags.tokenUrl) body.token_url = flags.tokenUrl;
  if (flags.scopes) body.scopes = flags.scopes.split(",").map((s) => s.trim());
  if (flags.headerName) body.header_name = flags.headerName;
  if (flags.testEndpoint) body.test_endpoint = flags.testEndpoint;
  if (flags.clientId) body.client_id = flags.clientId;
  if (flags.clientSecret) body.client_secret = flags.clientSecret;
  if (flags.category) body.category = flags.category;
  if (flags.description) body.description = flags.description;
  return body;
}

async function createProvider(flags: CreateProviderFlags) {
  try {
    let body = buildProviderBody(flags);

    // If required fields missing, prompt interactively
    if (!body.name || !body.slug || !body.auth_type || !body.base_url) {
      if (flags.json) {
        console.log(
          JSON.stringify({
            error:
              "Missing required flags: --name, --slug, --auth-type, --base-url",
          }),
        );
        process.exit(1);
      }

      const { default: inquirer } = await import("inquirer");
      const answers = await inquirer.prompt([
        ...(!body.name
          ? [{ type: "input" as const, name: "name", message: "Provider name:" }]
          : []),
        ...(!body.slug
          ? [{ type: "input" as const, name: "slug", message: "Provider slug:" }]
          : []),
        ...(!body.auth_type
          ? [
              {
                type: "list" as const,
                name: "auth_type",
                message: "Auth type:",
                choices: ["oauth2", "api_key", "basic"],
              },
            ]
          : []),
        ...(!body.base_url
          ? [
              {
                type: "input" as const,
                name: "base_url",
                message: "Base URL:",
              },
            ]
          : []),
      ]);
      body = { ...body, ...answers };

      // Auth-type-specific prompts
      if (body.auth_type === "oauth2" && (!body.authorize_url || !body.token_url)) {
        const oauthAnswers = await inquirer.prompt([
          ...(!body.authorize_url
            ? [
                {
                  type: "input" as const,
                  name: "authorize_url",
                  message: "Authorize URL:",
                },
              ]
            : []),
          ...(!body.token_url
            ? [
                {
                  type: "input" as const,
                  name: "token_url",
                  message: "Token URL:",
                },
              ]
            : []),
        ]);
        body = { ...body, ...oauthAnswers };
      }

      if (body.auth_type === "api_key" && !body.header_name) {
        const keyAnswers = await inquirer.prompt([
          {
            type: "input",
            name: "header_name",
            message: "Header name (e.g., X-Api-Key):",
            default: "Authorization",
          },
        ]);
        body = { ...body, ...keyAnswers };
      }
    }

    const data = await apiPost("/providers", body);
    formatOutput(data, flags, () => {
      const result = data as { slug: string; name: string };
      printSuccess(`Provider "${result.name}" (${result.slug}) created.`);
    });
  } catch (err) {
    handleError(err, flags);
  }
}

async function updateProvider(slug: string, flags: CreateProviderFlags) {
  try {
    const body = buildProviderBody(flags);
    if (Object.keys(body).length === 0) {
      console.log(chalk.yellow("  No fields to update. Pass flags like --name, --base-url, etc."));
      return;
    }
    const data = await apiPut(
      `/providers/${encodeURIComponent(slug)}`,
      body,
    );
    formatOutput(data, flags, () => {
      printSuccess(`Provider "${slug}" updated.`);
    });
  } catch (err) {
    handleError(err, flags);
  }
}

async function deleteProvider(
  slug: string,
  opts: OutputOptions & { force?: boolean },
) {
  try {
    const confirmed = await confirmAction(
      `Delete provider "${slug}"? This will also remove its connections.`,
      opts,
    );
    if (!confirmed) return;

    await apiDelete(`/providers/${encodeURIComponent(slug)}`);
    formatOutput({ deleted: true, slug }, opts, () => {
      printSuccess(`Provider "${slug}" deleted.`);
    });
  } catch (err) {
    handleError(err, opts);
  }
}

export function registerProvidersCommand(program: Command) {
  const cmd = program
    .command("providers")
    .description("Manage custom integration providers");

  cmd
    .command("list")
    .description("List all providers")
    .option("--json", "Output as JSON")
    .action((opts) => listProviders(opts));

  cmd
    .command("get")
    .description("Get provider details")
    .argument("<slug>", "Provider slug")
    .option("--json", "Output as JSON")
    .action((slug, opts) => getProvider(slug, opts));

  cmd
    .command("create")
    .description("Create a custom provider")
    .option("--name <name>", "Provider name")
    .option("--slug <slug>", "Provider slug")
    .option("--auth-type <type>", "Auth type (oauth2, api_key, basic)")
    .option("--base-url <url>", "Base URL")
    .option("--authorize-url <url>", "OAuth authorize URL")
    .option("--token-url <url>", "OAuth token URL")
    .option("--scopes <scopes>", "Comma-separated scopes")
    .option("--header-name <name>", "API key header name")
    .option("--test-endpoint <path>", "Test endpoint path")
    .option("--client-id <id>", "OAuth client ID")
    .option("--client-secret <secret>", "OAuth client secret")
    .option("--category <category>", "Provider category")
    .option("--description <text>", "Provider description")
    .option("--json", "Output as JSON")
    .action((opts) => createProvider(opts));

  cmd
    .command("update")
    .description("Update a provider")
    .argument("<slug>", "Provider slug")
    .option("--name <name>", "Provider name")
    .option("--auth-type <type>", "Auth type (oauth2, api_key, basic)")
    .option("--base-url <url>", "Base URL")
    .option("--authorize-url <url>", "OAuth authorize URL")
    .option("--token-url <url>", "OAuth token URL")
    .option("--scopes <scopes>", "Comma-separated scopes")
    .option("--header-name <name>", "API key header name")
    .option("--test-endpoint <path>", "Test endpoint path")
    .option("--client-id <id>", "OAuth client ID")
    .option("--client-secret <secret>", "OAuth client secret")
    .option("--category <category>", "Provider category")
    .option("--description <text>", "Provider description")
    .option("--json", "Output as JSON")
    .action((slug, opts) => updateProvider(slug, opts));

  cmd
    .command("delete")
    .description("Delete a provider")
    .argument("<slug>", "Provider slug")
    .option("--force", "Skip confirmation")
    .option("--json", "Output as JSON")
    .action((slug, opts) => deleteProvider(slug, opts));
}
