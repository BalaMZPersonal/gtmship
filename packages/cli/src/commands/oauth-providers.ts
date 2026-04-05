import type { Command } from "commander";
import { apiGet, apiPut } from "../lib/api-client.js";
import {
  formatOutput,
  printDetail,
  printSuccess,
  handleError,
  type OutputOptions,
} from "../lib/output.js";

async function getOAuthProvider(key: string, opts: OutputOptions) {
  try {
    const data = await apiGet(`/oauth-providers/${encodeURIComponent(key)}`);
    formatOutput(data, opts, () => {
      const p = data as {
        key: string;
        name: string;
        callback_slug: string;
        authorize_url: string;
        token_url: string;
        redirect_uri: string;
        has_credentials: boolean;
      };
      console.log("");
      printDetail("Key", p.key);
      printDetail("Name", p.name);
      printDetail("Callback Slug", p.callback_slug);
      printDetail("Authorize URL", p.authorize_url);
      printDetail("Token URL", p.token_url);
      printDetail("Redirect URI", p.redirect_uri);
      printDetail("Has Credentials", p.has_credentials ? "yes" : "no");
      console.log("");
    });
  } catch (err) {
    handleError(err, opts);
  }
}

interface SetOAuthProviderFlags extends OutputOptions {
  clientId?: string;
  clientSecret?: string;
  name?: string;
  callbackSlug?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
}

async function setOAuthProvider(key: string, flags: SetOAuthProviderFlags) {
  try {
    const body: Record<string, string> = {};
    if (flags.clientId) body.client_id = flags.clientId;
    if (flags.clientSecret) body.client_secret = flags.clientSecret;
    if (flags.name) body.name = flags.name;
    if (flags.callbackSlug) body.callback_slug = flags.callbackSlug;
    if (flags.authorizeUrl) body.authorize_url = flags.authorizeUrl;
    if (flags.tokenUrl) body.token_url = flags.tokenUrl;

    if (!flags.clientId && !flags.clientSecret && !flags.json) {
      const { default: inquirer } = await import("inquirer");
      const answers = await inquirer.prompt([
        ...(!body.client_id
          ? [
              {
                type: "input" as const,
                name: "client_id",
                message: "Client ID:",
              },
            ]
          : []),
        ...(!body.client_secret
          ? [
              {
                type: "password" as const,
                name: "client_secret",
                message: "Client Secret:",
                mask: "*",
              },
            ]
          : []),
      ]);
      Object.assign(body, answers);
    }

    const data = await apiPut(
      `/oauth-providers/${encodeURIComponent(key)}`,
      body,
    );
    formatOutput(data, flags, () => {
      const result = data as {
        key: string;
        name: string;
        has_credentials: boolean;
      };
      printSuccess(
        `Shared OAuth provider "${result.name}" (${result.key}) updated. Credentials: ${result.has_credentials ? "configured" : "missing"}`,
      );
    });
  } catch (err) {
    handleError(err, flags);
  }
}

export function registerOAuthProvidersCommand(program: Command) {
  const cmd = program
    .command("oauth-providers")
    .description("Manage shared OAuth provider credentials (Google, Microsoft, etc.)");

  cmd
    .command("get")
    .description("Get shared OAuth provider config")
    .argument("<key>", "OAuth provider key (e.g., google, microsoft)")
    .option("--json", "Output as JSON")
    .action((key, opts) => getOAuthProvider(key, opts));

  cmd
    .command("set")
    .description("Configure shared OAuth provider credentials")
    .argument("<key>", "OAuth provider key (e.g., google, microsoft)")
    .option("--client-id <id>", "OAuth client ID")
    .option("--client-secret <secret>", "OAuth client secret")
    .option("--name <name>", "Provider name")
    .option("--callback-slug <slug>", "Callback slug")
    .option("--authorize-url <url>", "Authorize URL")
    .option("--token-url <url>", "Token URL")
    .option("--json", "Output as JSON")
    .action((key, opts) => setOAuthProvider(key, opts));
}
