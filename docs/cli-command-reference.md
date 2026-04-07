# GTMShip CLI Command Reference

Verified against the built CLI on April 5, 2026 with `node packages/cli/dist/index.js --help`.

## Notation

- `[]` means optional.
- `<>` means required.
- Add `--help` to any command for live usage.
- `--json` is supported on the commands where it is shown below.

## Global

```bash
gtmship --help
gtmship --version
gtmship help [command]
```

## Project and Local Development

```bash
gtmship init [name]
gtmship dev
gtmship open
gtmship start
gtmship update [--check] [--yes] [--json]
gtmship restart
gtmship status
gtmship stop
gtmship validate
gtmship build [--workflow <id>] [--provider <provider>] [--push] [--project <name>] [--region <region>]
gtmship deploy [--provider <provider>] [--region <region>] [--project <name>] [--workflow <id>]
gtmship logs [--workflow <id>] [--provider <provider>] [--follow] [--since <duration>] [--limit <n>]
gtmship triggers [--workflow <id>]
```

- `gtmship init [name]`: Scaffold a new GTMShip project. Default name: `my-gtm-workflows`.
- `gtmship dev`: Start the local GTMShip development environment. This is the main entry point for a local-only run while you author, connect, validate, and preview workflows before deployment.
- `gtmship open`: Start the local GTMShip runtime and open the dashboard in a browser.
- `gtmship start`: Start the local GTMShip runtime without opening a browser.
- `gtmship update [--check] [--yes] [--json]`: Check for newer GTMShip releases and upgrade Homebrew installs. If the package is already upgraded but the local runtime is still on the older code, this command will offer to run `gtmship restart`.
- `gtmship restart`: Restart the local GTMShip runtime without opening a browser.
- `gtmship status`: Show the current local GTMShip runtime status.
- `gtmship stop`: Stop the local GTMShip runtime.
- `gtmship validate`: Validate workflows and connection configs.
- `gtmship build`: Build workflow code for deployment.
  Notes:
  `--provider <provider>` expects `aws` or `gcp`.
  `--push` is only for GCP image pushes.
- `gtmship deploy`: Deploy workflows to the configured cloud.
  Notes:
  `--provider <provider>` defaults to `aws`.
  `--project <name>` is required for GCP deploys.
- `gtmship logs`: View execution logs from deployed workflows.
- `gtmship triggers`: Show trigger configuration and webhook URLs.

### Typical local-only loop

```bash
gtmship init my-gtm-workflows
gtmship dev
gtmship connections connect hubspot
gtmship validate
```

Use this loop when you want to build and test locally without provisioning cloud infrastructure yet. Add `gtmship deploy ...` only when the workflow needs to move into AWS or GCP for always-on execution.

## Legacy Connection Helper

```bash
gtmship auth add <provider>
```

- `gtmship auth add <provider>`: Add a new platform connection using the older template-based helper path.
  Example provider values: `hubspot`, `salesforce`, `slack`.

## Connections

```bash
gtmship connections list [--json]
gtmship connections catalog [--query <q>] [--category <category>] [--json]
gtmship connections catalog-get <slug> [--json]
gtmship connections connect <slug> [--api-key <key>] [--label <label>] [--connection-id <id>] [--service-slugs <slugs>] [--json]
gtmship connections test <id> [--json]
gtmship connections refresh <id> [--json]
gtmship connections delete <id> [--force] [--json]
```

- `gtmship connections list`: List all connections.
- `gtmship connections catalog`: Browse the integration catalog.
- `gtmship connections catalog-get <slug>`: Get details for one catalog provider.
- `gtmship connections connect <slug>`: Create a new connection.
  Notes:
  `--api-key <key>` is for `api_key` and `basic` providers.
  `--connection-id <id>` supports reconnect flows.
  `--service-slugs <slugs>` accepts comma-separated service slugs for multi-service OAuth.
- `gtmship connections test <id>`: Test a connection.
- `gtmship connections refresh <id>`: Refresh an OAuth token.
- `gtmship connections delete <id>`: Delete a connection.

## Custom Providers

```bash
gtmship providers list [--json]
gtmship providers get <slug> [--json]
gtmship providers create --name <name> --slug <slug> --auth-type <type> --base-url <url> [--authorize-url <url>] [--token-url <url>] [--scopes <scopes>] [--header-name <name>] [--test-endpoint <path>] [--client-id <id>] [--client-secret <secret>] [--category <category>] [--description <text>] [--json]
gtmship providers update <slug> [--name <name>] [--auth-type <type>] [--base-url <url>] [--authorize-url <url>] [--token-url <url>] [--scopes <scopes>] [--header-name <name>] [--test-endpoint <path>] [--client-id <id>] [--client-secret <secret>] [--category <category>] [--description <text>] [--json]
gtmship providers delete <slug> [--force] [--json]
```

- `gtmship providers list`: List all custom providers.
- `gtmship providers get <slug>`: Get provider details.
- `gtmship providers create`: Create a custom provider.
- `gtmship providers update <slug>`: Update an existing provider.
- `gtmship providers delete <slug>`: Delete a provider.
  Notes:
  `--auth-type <type>` accepts `oauth2`, `api_key`, or `basic`.
  `--scopes <scopes>` is a comma-separated list.

## Workflows

```bash
gtmship workflows list [--json]
gtmship workflows get <id> [--json]
gtmship workflows delete <id> [--force] [--remove-deployment] [--json]
```

- `gtmship workflows list`: List all workflows.
- `gtmship workflows get <id>`: Get workflow details.
- `gtmship workflows delete <id>`: Delete a workflow.
  Note:
  `--remove-deployment` also removes deployment records.

## Deployments

```bash
gtmship deployments list [--workflow <id>] [--provider <provider>] [--status <status>] [--live] [--json]
gtmship deployments get <id> [--live] [--json]
gtmship deployments logs <id> [--since <duration>] [--limit <n>] [--execution <name>] [--json]
gtmship deployments reconcile [--workflow <id>] [--provider <provider>] [--region <region>] [--project <name>] [--json]
gtmship deployments delete --workflow <id> [--force] [--json]
```

- `gtmship deployments list`: List deployment records.
- `gtmship deployments get <id>`: Get deployment details.
- `gtmship deployments logs <id>`: View deployment logs.
- `gtmship deployments reconcile`: Reconcile deployment state from the cloud provider.
- `gtmship deployments delete --workflow <id>`: Delete deployments for a workflow.
  Notes:
  `--provider <provider>` expects `aws` or `gcp`.
  `--live` includes live platform status where supported.

## Settings

```bash
gtmship settings list [--json]
gtmship settings get <key> [--json]
gtmship settings set <key> <value> [--json]
gtmship settings delete <key> [--force] [--json]
gtmship settings auth-strategy [--json]
gtmship settings set-auth-strategy <mode> [--json]
gtmship settings validate-cloud <provider> [--json]
```

- `gtmship settings list`: List all settings.
- `gtmship settings get <key>`: Get one setting.
- `gtmship settings set <key> <value>`: Set a setting value.
- `gtmship settings delete <key>`: Delete a setting.
- `gtmship settings auth-strategy`: View the current auth strategy.
- `gtmship settings set-auth-strategy <mode>`: Change auth strategy mode.
- `gtmship settings validate-cloud <provider>`: Validate cloud credentials.
  Notes:
  `mode` accepts `proxy` or `secret_manager`.
  `provider` accepts `aws` or `gcp`.

## Memories

```bash
gtmship memories list [--scope <scope>] [--category <category>] [--workflow <id>] [--query <q>] [--json]
gtmship memories create [--content <text>] [--category <category>] [--scope <scope>] [--workflow <id>] [--source <source>] [--json]
gtmship memories delete <id> [--force] [--json]
gtmship memories bulk-delete --ids <ids> [--force] [--json]
```

- `gtmship memories list`: List or search memories.
- `gtmship memories create`: Create a memory record.
- `gtmship memories delete <id>`: Delete one memory.
- `gtmship memories bulk-delete --ids <ids>`: Delete multiple memories.
  Notes:
  `--scope <scope>` accepts `app` or `workflow`.
  `--ids <ids>` is a comma-separated list of memory IDs.

## Shared OAuth Providers

```bash
gtmship oauth-providers get <key> [--json]
gtmship oauth-providers set <key> [--client-id <id>] [--client-secret <secret>] [--name <name>] [--callback-slug <slug>] [--authorize-url <url>] [--token-url <url>] [--json]
```

- `gtmship oauth-providers get <key>`: Get shared OAuth provider config.
- `gtmship oauth-providers set <key>`: Configure shared OAuth provider credentials.
  Example provider keys: `google`, `microsoft`.

## Setup

```bash
gtmship setup
gtmship setup status [--json]
```

- `gtmship setup`: Launch the interactive onboarding checklist.
- `gtmship setup status`: Show current setup checklist status.

## Source of Truth

- [`packages/cli/src/index.ts`](../packages/cli/src/index.ts)
- [`packages/cli/src/commands/auth.ts`](../packages/cli/src/commands/auth.ts)
- [`packages/cli/src/commands/build.ts`](../packages/cli/src/commands/build.ts)
- [`packages/cli/src/commands/connections.ts`](../packages/cli/src/commands/connections.ts)
- [`packages/cli/src/commands/deploy.ts`](../packages/cli/src/commands/deploy.ts)
- [`packages/cli/src/commands/deployments.ts`](../packages/cli/src/commands/deployments.ts)
- [`packages/cli/src/commands/dev.ts`](../packages/cli/src/commands/dev.ts)
- [`packages/cli/src/commands/init.ts`](../packages/cli/src/commands/init.ts)
- [`packages/cli/src/commands/logs.ts`](../packages/cli/src/commands/logs.ts)
- [`packages/cli/src/commands/memories.ts`](../packages/cli/src/commands/memories.ts)
- [`packages/cli/src/commands/oauth-providers.ts`](../packages/cli/src/commands/oauth-providers.ts)
- [`packages/cli/src/commands/providers.ts`](../packages/cli/src/commands/providers.ts)
- [`packages/cli/src/commands/settings.ts`](../packages/cli/src/commands/settings.ts)
- [`packages/cli/src/commands/setup.ts`](../packages/cli/src/commands/setup.ts)
- [`packages/cli/src/commands/triggers.ts`](../packages/cli/src/commands/triggers.ts)
- [`packages/cli/src/commands/validate.ts`](../packages/cli/src/commands/validate.ts)
- [`packages/cli/src/commands/workflows.ts`](../packages/cli/src/commands/workflows.ts)
