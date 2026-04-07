# GTMship

**Connect any integration. Build any workflow. Deploy anywhere.**

GTMship is an open-source workflow automation platform. Describe what you want in plain English and GTMship turns it into a running automation — on your laptop or in your own cloud.

- **Connect ANY integration** — If it has an API, GTMship can connect it. The AI agent researches schemas, maps endpoints, and configures authentication — including full OAuth flows — automatically. No pre-built connector needed.
- **Build ANY workflow** — Describe what you want. GTMship writes the code, wires up the integrations, and previews every write operation before anything touches live data. You approve what ships.
- **Run it YOUR way** — Writing code has gotten easy. AI can generate just about anything now. But deploying it? Configuring runtimes, wiring secrets, setting up infrastructure — that's the real bottleneck. GTMship solves exactly that. Keep it running on your laptop for personal automations, or deploy to your own AWS/GCP with a single click.

No vendor lock-in. No per-task pricing. No credits. No execution meters. Completely open source, MIT licensed.

### Yes, even that use case

GTMship can handle the most ridiculous workflows you can think of. Here's one:

> *"When a Freshdesk ticket is tagged `angry-ceo`, look up the customer in HubSpot, pull their last 3 invoices from Google Drive, draft an apology email in Gmail with the invoices attached, summarize the ticket history with OpenAI, post a panic alert to #cs-alerts on Slack, and log the whole thing back to Google Sheets so finance knows what happened before they do."*

Six integrations. One sentence. GTMship connects all of them, writes the workflow, previews every write, and lets you run it from your laptop or deploy it. You just describe it.

## Quick Start

### Install with Homebrew (macOS / Linux)

```bash
brew install BalaMZPersonal/tap/gtmship
gtmship open
```

This starts the GTMship runtime on your machine and opens the dashboard at `http://localhost:3000`.

On headless or VM environments:

```bash
gtmship start    # start without opening a browser
gtmship status   # check runtime status
```

### Create a project

```bash
gtmship init my-workflows
cd my-workflows
npm install
gtmship setup
```

This scaffolds a workflow project:

```text
my-workflows/
├── gtmship.config.yaml
├── package.json
├── workflows/
│   └── hello-world.ts
├── connections/
└── .gtmship/
    ├── workflows/
    └── build/
```

### Useful commands

```bash
gtmship open              # start runtime + open dashboard
gtmship start             # start runtime (headless)
gtmship stop              # stop runtime
gtmship restart           # restart runtime
gtmship status            # check status
gtmship update --check    # check for updates
gtmship update            # update to latest version
```

### Keeping GTMship updated

```bash
gtmship update --check    # see if a new version is available
gtmship update            # upgrade via Homebrew
gtmship restart           # restart if already upgraded on disk
```

GTMship does not silently self-upgrade. Updates are shown as dashboard banners and CLI reminders.

## How It Works

### 1. Connect any integration

GTMship ships with 25+ built-in connectors (HubSpot, Salesforce, Slack, Gmail, Stripe, and more). For anything not built-in, the **Custom Connections Agent** reads the API documentation, researches the schemas, determines the auth type, configures OAuth or API keys, and saves a ready-to-use connection — all automatically.

- OAuth flows are handled end-to-end (popup/callback — no pasting codes)
- Shared OAuth families let you connect Google once and use Gmail, Sheets, Docs, and Drive
- Credentials are encrypted before storage

### 2. Build any workflow

Open **Workflow Studio** and describe what you want in plain English. The **Workflow Builder Agent** checks your connected integrations, reads their API docs, and generates the workflow with proper branching, inputs, outputs, and execution steps.

The agent is not a one-shot code generator. It:

- Grounds every API call against real schemas before generating code
- Validates the workflow against runtime rules
- Previews every operation — reads hit live APIs, but writes pause at checkpoints for your approval
- Repairs and retries automatically if validation or preview fails
- Remembers your project context across sessions via persistent AI memory

GTMship explicitly stops when connections are missing, writes need approval, or auth problems make generation unsafe. No hallucinated success.

### 3. Preview before anything ships

Every write operation pauses at a checkpoint and waits for your approval. Preview runs the workflow in a sandbox so you see exactly what happens before anything touches live data.

### 4. Deploy with a click

This is the part most tools skip. Writing code is easy now — deploying it is the bottleneck. GTMship handles:

- Building the artifact for your target cloud
- Provisioning the runtime (AWS Lambda or GCP Cloud Run)
- Syncing secrets to your cloud's secret manager
- Setting up triggers, API gateways, and resource inventory
- Streaming execution logs back to the dashboard

Keep personal or occasional automations running locally on your machine. Deploy to your own cloud only when the workflow needs an always-on runtime. One click.

### 5. Track everything

After deployment, GTMship syncs state into a control plane: deployment records, connection bindings, resource inventory, and logs. Stream execution logs in real time from the dashboard or CLI.

## Example Workflow

```ts
import { defineWorkflow, triggers, type WorkflowContext } from "@gtmship/sdk";

export default defineWorkflow({
  id: "enrich-lead",
  name: "Enrich Lead",
  description: "Look up a contact in HubSpot and return the latest record.",
  trigger: triggers.webhook("/enrich"),

  async run(payload: { contactId: string }, ctx: WorkflowContext) {
    const hubspot = await ctx.integration("hubspot");
    const contact = await hubspot.read(
      `/crm/v3/objects/contacts/${payload.contactId}`
    );
    return { contact: contact.data };
  },
});
```

Configure deployment targets in `gtmship.config.yaml`:

```yaml
name: "my-workflows"

deploy:
  provider: aws
  region: us-east-1
```

## Two Ways to Use It

**Dashboard** — Visual UI for connecting integrations, building workflows with AI chat, previewing operations, and deploying. Open it with `gtmship open`.

**CLI** — Every dashboard feature is available from the terminal. Great for automation and CI pipelines. All commands support `--json` for scripting.

```bash
# Connections
gtmship connections catalog                    # browse available integrations
gtmship connections connect hubspot            # connect via OAuth
gtmship connections connect sendgrid --api-key <key>

# Workflows
gtmship validate
gtmship build
gtmship deploy

# Deployments
gtmship deployments list --live
gtmship deployments logs <id> --follow

# Everything else
gtmship providers list                         # manage custom providers
gtmship memories list                          # inspect AI memory
gtmship settings validate-cloud aws            # verify cloud credentials
```

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

## Repository Structure

| Package | What it does |
| --- | --- |
| `@gtmship/sdk` | Workflow definition API, runtime context, triggers |
| `@gtmship/cli` | Project scaffolding, build, deploy, and all management commands |
| `@gtmship/auth-service` | Provider registry, connections, OAuth, API proxy, memories, deployment control plane |
| `@gtmship/dashboard` | Visual UI for connections, Workflow Studio, deploy, settings, and AI agents |
| `@gtmship/deploy-engine` | Deployment planning and AWS/GCP infrastructure provisioning |
| `templates/` | Example connection and workflow templates |

## Tech Stack

| Area | Technology |
| --- | --- |
| Dashboard | Next.js, Tailwind CSS, Vercel AI SDK |
| Auth Service | Express, Prisma, PostgreSQL |
| Workflow SDK | TypeScript |
| Deployment Engine | Pulumi Automation API |
| Cloud Targets | AWS Lambda / ECS, GCP Cloud Run |
| CLI | Commander.js |

## Contributing

```bash
git clone https://github.com/BalaMZPersonal/gtmship.git
cd gtmship
pnpm install
docker-compose up -d
pnpm dev
```

Dashboard: `http://localhost:3000` | Auth service: `http://localhost:4000`

See `docs/homebrew-release.md` for release and packaging details.

## License

MIT

---

**Website:** [gtmship.com](https://gtmship.com)
