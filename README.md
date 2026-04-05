# GTMShip

**Build GTM workflows with AI. Connect real systems. Ship to your cloud.**

GTMShip is an open-source platform for GTM engineering. It gives you a full path from "I need a workflow that talks to HubSpot, Salesforce, Slack, Gmail, or a custom API" to "that workflow is validated, deployed, connected, and observable in my own AWS or GCP account."

It combines:

- a TypeScript workflow SDK
- a local and cloud deployment toolchain
- an auth service for providers, connections, OAuth, and proxying
- a dashboard with two AI agents: a Connections Agent and a Workflow Agent
- a deployment control plane for bindings, logs, and live deployment state
- a persistent memory system so agents can reuse verified knowledge across sessions

## What GTMShip Can Do

- Browse a built-in integration catalog with provider metadata, auth details, docs links, and extracted API schema hints.
- Create and manage connections for OAuth2, API key, and basic-auth providers.
- Create custom providers manually or through the Connections Agent.
- Reuse shared OAuth apps across provider families such as Google services.
- Build workflows in Workflow Studio with an AI chat that grounds APIs before it generates code.
- Validate workflow code, preview reads and writes, and pause at write checkpoints for approval.
- Build deployable artifacts for AWS and GCP.
- Deploy workflows to your own cloud and sync deployment metadata back into GTMShip's control plane.
- Stream logs, inspect triggers, manage deployment records, and reconcile live state.
- Persist app-level and workflow-level memory so future sessions start with verified context.

## Quick Start

### Run this repository locally

```bash
git clone https://github.com/gtmship/gtmship.git
cd gtmship
pnpm install
docker-compose up -d
pnpm dev
```

Then open:

- Dashboard: `http://localhost:3000`
- Auth service: `http://localhost:4000`

### Create a GTMShip project

```bash
gtmship init my-gtm-workflows
cd my-gtm-workflows
npm install
gtmship dev
```

That scaffolds:

```text
my-gtm-workflows/
├── gtmship.config.yaml
├── package.json
├── workflows/
│   └── hello-world.ts
├── connections/
└── .gtmship/
    ├── workflows/
    └── build/
```

Notes:

- Workflow source files live in `workflows/*.ts`.
- Workflow Studio metadata is stored in `.gtmship/workflows/*.json`.
- Build output metadata is written to `.gtmship/build/manifest.json`.
- Connection secrets are not stored in your project files. They live in the auth service database and, optionally, external secret managers.

## Architecture

```text
┌─────────────────────────────────────────────────────────────────────┐
│ Dashboard (Next.js)                                                │
│                                                                     │
│ Connections page   Workflow Studio   Deploy page   Settings page    │
│        │                 │                 │              │          │
│        ├──── Connections Agent ─────┐      │              │          │
│        └──── Workflow Agent ────────┼──────┘              │          │
└─────────────────────────────────────┼──────────────────────┘
                                      │
                          ┌───────────▼───────────┐
                          │ Auth Service          │
                          │ - provider registry   │
                          │ - connection storage  │
                          │ - OAuth callbacks     │
                          │ - auth proxy          │
                          │ - settings            │
                          │ - memories            │
                          │ - deployment control  │
                          └───────────┬───────────┘
                                      │
                 ┌────────────────────┼────────────────────┐
                 │                    │                    │
        ┌────────▼────────┐  ┌────────▼────────┐  ┌────────▼────────┐
        │ SDK / Runtime   │  │ CLI            │  │ Deploy Engine   │
        │ workflow code   │  │ init/build/    │  │ planner +       │
        │ ctx.integration │  │ deploy/logs    │  │ Pulumi deploy   │
        └────────┬────────┘  └────────┬────────┘  └────────┬────────┘
                 │                    │                    │
                 └────────────────────┴────────────────────┘
                                      │
                          ┌───────────▼───────────┐
                          │ Your Cloud            │
                          │ AWS Lambda / ECS      │
                          │ GCP Cloud Run         │
                          └───────────────────────┘
```

## Core Functionality

### 1. Connection Catalog

GTMShip ships with a built-in connection catalog powered by Activepieces metadata. Catalog entries include:

- provider slug and name
- category and description
- auth type (`oauth2`, `api_key`, `basic`)
- auth URLs and scopes when available
- base URL, docs URL, header name, and optional shared OAuth family key
- extracted API schema hints from installed Activepieces pieces

How it works:

- The auth service loads a curated registry of provider packages and extracts auth metadata, categories, docs links, and action schemas.
- Catalog responses are cached in memory after load for fast reuse.
- If a provider is not in the built-in registry but an installed `@activepieces/piece-{slug}` package exists, GTMShip can still dynamically load its API schema.

Why this matters:

- the dashboard can show "connectable" services immediately
- the Connections Agent starts from real provider defaults instead of guessing
- the Workflow Agent can inspect provider metadata before going to the open web

Examples:

```bash
gtmship connections catalog
gtmship connections catalog --query slack
gtmship connections catalog-get hubspot
```

### 2. Custom Connections Through the Connections Agent

When a provider is not already configured, GTMShip can create it through the Connections Agent.

The Connections Agent workflow is:

1. Check memory for prior knowledge about the provider.
2. Look up the provider in the built-in catalog first.
3. If the catalog contains docs, inspect them.
4. If the provider is not in the catalog, research public docs.
5. Determine auth type, base URL, scopes, test endpoint, and useful API schema.
6. Validate the generated provider configuration.
7. Save the provider into the auth service.
8. Guide the user through OAuth or API-key connection.
9. Test the connection.
10. Save the verified setup details into memory.

Important behavior:

- OAuth flows are popup/callback based. The agent is explicitly instructed not to ask the user to paste authorization codes or callback URLs back into chat.
- API-key reconnects update the original connection row instead of creating duplicates when a connection ID is supplied.
- Saved providers store structured `api_schema` so the setup can be reused later for testing and workflow generation.
- Client secrets and access tokens are encrypted before storage.

Shared OAuth families:

- GTMShip supports shared OAuth app configuration for provider families such as Google.
- A single saved OAuth app can be reused across related services like Gmail and Google Sheets.
- The dashboard can authorize multiple related service slugs in one OAuth session.

You can also manage providers manually:

```bash
gtmship providers list
gtmship providers get <slug>
gtmship providers create --name "My API" --slug my-api --auth-type api_key --base-url https://api.example.com
gtmship providers update <slug> --base-url https://v2.api.example.com
gtmship providers delete <slug>
```

### 3. Workflow Builder and Workflow Studio

Workflow Studio is the design-time workspace for creating, debugging, and shipping workflows. It combines:

- AI chat
- generated Mermaid flow diagrams
- editable TypeScript code
- validation
- preview
- build
- deploy
- workflow memory

The Workflow Agent is not a one-shot code generator. It behaves like a workflow engineer with tools.

Its workflow is:

1. Read the current draft and transcript.
2. Recall relevant memory for the current workflow and for the app overall.
3. Inspect active connections early.
4. Read saved provider references.
5. Fetch OpenAPI specs when available.
6. Ground endpoint paths, request fields, and response shapes before generation.
7. Generate or repair the workflow draft.
8. Validate the code.
9. Run preview.
10. If preview or validation fails, repair and try again.
11. Generate Mermaid.
12. Generate a compact chat summary for future repair context.
13. Save the workflow artifact and deployment plan.

Workflow Studio explicitly stops when:

- required connections are missing or blocked
- preview hits a write checkpoint that needs approval
- external auth or scope problems make generation unsafe

This is intentional. GTMShip tries to avoid "hallucinated success."

### 4. Validation, Preview, and Build

GTMShip separates design-time confidence into three layers:

#### Validation

Validation checks that workflow code follows GTMShip's runtime rules:

- valid workflow module shape
- correct helper usage
- valid write checkpoint references
- no unsupported runtime patterns

#### Preview

Preview runs the workflow against sample input and records operations. It can return:

- `success`
- `needs_approval`
- `error`

Preview is where write safety shows up. Any `.write(...)` call must declare a checkpoint, and preview pauses when user approval is needed.

#### Build

Build runs the same validation and preview gates again, then uses the shared CLI build flow to package the workflow for the target cloud:

- AWS builds package zip artifacts for Lambda and related targets.
- GCP builds local container artifacts or images for Cloud Run.

If build fails, Workflow Studio can feed the failure details back into the generator and attempt a repair pass.

### 5. Workflow Deployment

Deployment in GTMShip is more than "run Pulumi."

The deployment flow is:

1. Read `gtmship.config.yaml` and per-workflow overrides.
2. Load the workflow source and infer trigger and provider usage.
3. Resolve connection bindings for each provider.
4. Choose provider, region, execution kind, auth mode, and resource plan.
5. Validate cloud-specific constraints, especially for GCP CPU and memory.
6. Build the artifact.
7. Resolve cloud credentials from the auth service or environment.
8. Deploy to AWS or GCP through the deploy engine.
9. Sync deployment metadata, bindings, auth manifests, and resource inventory into the workflow control plane.
10. Expose logs, live status, and deployment inspection through the dashboard and CLI.

The deployment planner handles:

- trigger type and trigger metadata
- execution kind (`service` or `job`)
- auth mode (`proxy` or `secret_manager`)
- provider bindings (`latest_active`, `connection_id`, `label`)
- warnings for missing or ambiguous configuration
- runtime auth manifest generation for secret-backed deployments
- cloud-specific resources for webhook, schedule, event, and manual workflows

The dashboard deploy button calls the same underlying CLI-based deploy flow used by `gtmship deploy`.

### 6. Deployment Control Plane

After a successful deploy, GTMShip syncs deployment state into its control plane so the product can keep working after the cloud command finishes.

The control plane stores:

- workflow deployments
- provider-to-connection bindings
- runtime auth manifests
- resource inventory
- run metadata
- recent platform state and logs

This enables:

- `gtmship deployments list --live`
- deployment detail views with platform metadata
- deployment log views
- deployment reconciliation when GTMShip needs to re-sync cloud state
- consistent binding and secret-manager behavior across future deploys

### 7. Memories and Their Logic

GTMShip includes persistent AI memory for both the Connections Agent and the Workflow Agent.

Each memory record stores:

- `content`
- `category`
- `scope`
- `workflowId` for workflow-scoped entries
- `source`
- timestamps

Categories:

- `integration`
- `business`
- `workflow`
- `general`

Scopes:

- `app`: shared across all workflows
- `workflow`: isolated to one workflow slug

Memory rules:

- Workflow-scoped memory requires `workflowId`.
- Workflow memory is never leaked across workflows.
- When an agent asks for `scope=all` inside a workflow, GTMShip fetches app memory and that workflow's memory separately, then combines them. This prevents accidental cross-workflow leakage.
- Memory queries can be filtered by scope, workflow, category, and text search.
- List queries return the latest records first and are capped to 50 results per request.
- Prompt memory context is intentionally compact: GTMShip injects up to 20 app-scoped memories and up to 20 workflow-scoped memories, then truncates the final memory block to roughly 4 KB to avoid prompt bloat.

When GTMShip expects agents to save memory:

- after verified provider setup
- after successful connection testing
- after grounded API discovery
- after confirmed business requirements
- after successful preview or build patterns that are worth reusing

What GTMShip avoids saving:

- raw secrets
- temporary tokens
- speculative API guesses
- large raw payload dumps

Operationally, memory shows up in two places:

- global memory management in Settings
- workflow-specific memory inside Workflow Studio

CLI examples:

```bash
gtmship memories list
gtmship memories list --scope workflow --workflow <id>
gtmship memories create --content "HubSpot rate limit is 100/10s"
gtmship memories delete <id>
gtmship memories bulk-delete --ids id1,id2,id3
```

### 8. Auth Modes: Proxy vs Secret Manager

GTMShip supports two connection auth strategies.

#### Proxy mode

- Workflow runtime calls go through the auth-service proxy.
- The proxy resolves the correct bound connection, injects auth headers, and can auto-refresh expired OAuth tokens.
- This is the simplest local and hosted mode.

#### Secret manager mode

- Active connection credentials are replicated into AWS Secrets Manager or GCP Secret Manager.
- Deployments carry a runtime auth manifest with deterministic connection bindings and secret references.
- GTMShip can backfill active connections and existing deployments when this mode is enabled.
- The auth strategy reports health as `healthy`, `migrating`, or `degraded` based on replica coverage and errors.

Use secret-manager mode when you want the runtime in your cloud account to fetch credentials from your cloud secret backend instead of routing all authenticated traffic through the GTMShip auth proxy.

### 9. Dashboard Pages

The dashboard is organized into four main product areas.

#### Connections

- browse the integration catalog
- inspect saved providers
- connect, reconnect, test, refresh, and delete connections
- launch the Connections Agent when catalog defaults are not enough

#### Workflows

- create or load workflow drafts
- chat with the Workflow Agent
- view Flow, Code, Validation, Preview, Build, and Deploy tabs
- manage bindings and approvals
- inspect workflow-local memory

#### Deploy

- review deployment plans
- deploy saved workflows
- inspect control-plane deployment records
- reconcile live deployment state

#### Settings

- configure AI provider keys
- configure AWS and GCP credentials
- choose auth strategy
- inspect and manage memory

## How GTMShip Works End to End

1. You scaffold a GTMShip project with `gtmship init`.
2. You connect a built-in provider from the catalog or create a custom provider through the Connections Agent.
3. The auth service stores the provider config, encrypted credentials, and optional shared OAuth configuration.
4. In Workflow Studio, the Workflow Agent checks connections, recalls memory, grounds API details, and generates a workflow draft.
5. GTMShip saves the workflow source into `workflows/<slug>.ts` and sidecar metadata into `.gtmship/workflows/<slug>.json`.
6. Validation checks runtime safety and helper usage.
7. Preview simulates reads and gated writes using sample payloads.
8. Build packages the workflow for AWS or GCP.
9. Deploy provisions or updates cloud resources through the deploy engine.
10. GTMShip syncs deployment records, bindings, auth manifests, and resource inventory back into its control plane.
11. Future sessions start with memory plus the saved workflow/chat summary, so both agents can continue from verified prior context.

## Writing Workflows

The recommended runtime shape is a typed workflow that uses `WorkflowContext` helpers for network access.

```ts
import { defineWorkflow, triggers, type WorkflowContext } from "@gtmship/sdk";

export default defineWorkflow({
  id: "enrich-lead",
  name: "Enrich Lead",
  description: "Look up a contact in HubSpot and return the latest record.",
  trigger: triggers.webhook("/enrich"),

  async run(payload: { contactId: string }, ctx: WorkflowContext) {
    console.log("[enrich-lead] Starting workflow run", { contactId: payload.contactId });

    try {
      const hubspot = await ctx.integration("hubspot");
      const contact = await hubspot.read(
        `/crm/v3/objects/contacts/${payload.contactId}`
      );

      console.log("[enrich-lead] Workflow completed", { status: contact.status });
      return { contact: contact.data };
    } catch (error) {
      console.error("[enrich-lead] Workflow failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});
```

Deployment defaults and per-workflow overrides live in `gtmship.config.yaml`:

```yaml
name: "my-gtm-workflows"

deploy:
  provider: aws
  region: us-east-1

workflows:
  enrich-lead:
    deploy:
      provider: gcp
      region: us-central1
      gcp_project: my-project-id
      execution:
        kind: job
      auth:
        mode: secret_manager
    bindings:
      hubspot:
        type: connection_id
        value: conn_123
```

## CLI Reference

Every major dashboard feature is available through the CLI.

### Project Lifecycle

```bash
gtmship init my-workflows
gtmship dev
gtmship validate
gtmship build
gtmship deploy
```

### Connections

```bash
gtmship connections catalog
gtmship connections catalog --query slack
gtmship connections catalog-get hubspot
gtmship connections connect hubspot
gtmship connections connect sendgrid --api-key <key>
gtmship connections connect gmail --service-slugs gmail,google-sheets
gtmship connections list
gtmship connections test <id>
gtmship connections refresh <id>
gtmship connections delete <id>
```

### Custom Providers and Shared OAuth

```bash
gtmship providers list
gtmship providers get <slug>
gtmship providers create --name "My API" --slug my-api --auth-type api_key --base-url https://api.example.com
gtmship providers update <slug> --base-url https://v2.api.example.com
gtmship providers delete <slug>

gtmship oauth-providers get google
gtmship oauth-providers set google --client-id <id> --client-secret <secret>
```

### Workflows and Deployments

```bash
gtmship workflows list
gtmship workflows get <id>
gtmship workflows delete <id>
gtmship workflows delete <id> --remove-deployment

gtmship deployments list
gtmship deployments list --live
gtmship deployments get <id> --live
gtmship deployments logs <id>
gtmship deployments logs <id> --since 6h --limit 500
gtmship deployments reconcile
gtmship deployments delete --workflow <id>
```

### Settings, Memory, Logs, and Triggers

```bash
gtmship settings list
gtmship settings get <key>
gtmship settings set anthropic_api_key <value>
gtmship settings delete <key>
gtmship settings auth-strategy
gtmship settings set-auth-strategy secret_manager
gtmship settings validate-cloud aws
gtmship settings validate-cloud gcp

gtmship memories list
gtmship memories list --scope workflow --workflow <id>
gtmship memories create --content "HubSpot rate limit is 100/10s"
gtmship memories delete <id>
gtmship memories bulk-delete --ids id1,id2,id3

gtmship logs --workflow <id> --follow
gtmship triggers --workflow <id>
```

Every major command also supports `--json`, which makes GTMShip scriptable from terminals and AI coding tools.

## Repository Structure

| Package | Responsibility |
| --- | --- |
| `@gtmship/sdk` | Workflow definition API, runtime context helpers, triggers, deploy types |
| `@gtmship/cli` | Project init, local dev, provider and connection management, workflow and deployment operations |
| `@gtmship/auth-service` | Providers, connections, OAuth callbacks, API proxy, settings, memories, deployment control plane |
| `@gtmship/dashboard` | Next.js UI for connections, Workflow Studio, deploy, settings, and embedded agents |
| `@gtmship/deploy-engine` | Deployment planning plus AWS and GCP infrastructure provisioning |
| `templates/connections` | Example connection templates |
| `templates/workflows` | Example workflow templates |

## Tech Stack

| Area | Technology |
| --- | --- |
| Dashboard | Next.js 14, Tailwind CSS, Vercel AI SDK |
| Auth Service | Express, Prisma, PostgreSQL |
| Workflow SDK | TypeScript SDK and runtime helpers |
| Connection Catalog | Activepieces provider metadata |
| Deployment Engine | Pulumi Automation API |
| Cloud Targets | AWS Lambda / ECS and GCP Cloud Run |
| CLI | Commander.js |

## License

MIT
