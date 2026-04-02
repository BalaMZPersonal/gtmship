# GTMShip

**Build GTM workflows with AI. Ship to your cloud.**

GTMShip is an open-source platform for GTM (Go-To-Market) engineering. Build workflows with AI coding tools like Claude Code or Codex, manage OAuth connections through an agentic chat interface, and deploy to your own AWS or GCP with a single command.

## The Problem

GTM engineers can build data workflows easily with AI coding tools. But getting them into production — handling OAuth to 20+ platforms, provisioning cloud infra, managing secrets, monitoring executions — is where 95% of AI pilots fail.

## The Solution

```bash
gtmship init my-workflows        # Scaffold a project
gtmship auth add hubspot          # Connect HubSpot via AI-guided chat
gtmship dev                       # Run locally
gtmship deploy                    # Ship to your AWS/GCP
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Dashboard                         │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │Connections│ │Workflows │ │   AI Chat Agent   │   │
│  │  Manager  │ │ Manager  │ │ (Claude/OpenAI)   │   │
│  └────┬─────┘ └────┬─────┘ └────────┬──────────┘   │
│       │             │                │               │
├───────┼─────────────┼────────────────┼───────────────┤
│       │             │                │               │
│  ┌────▼─────┐ ┌─────▼────┐ ┌────────▼──────────┐   │
│  │   Auth   │ │ Workflow │ │     Deploy        │   │
│  │ Service  │ │   SDK    │ │     Engine        │   │
│  │(OAuth+   │ │(Trigger  │ │   (Pulumi)        │   │
│  │ Proxy)   │ │  .dev)   │ │                   │   │
│  └──────────┘ └──────────┘ └───────────────────┘   │
│                                                      │
│  Your Cloud (AWS Lambda / GCP Cloud Run)             │
└─────────────────────────────────────────────────────┘
```

## Packages

| Package | Description |
|---------|------------|
| `@gtmship/sdk` | TypeScript SDK for writing AI-generatable workflows |
| `@gtmship/cli` | CLI tool — init, dev, validate, deploy |
| `@gtmship/auth-service` | Self-hosted OAuth manager + API proxy |
| `@gtmship/dashboard` | Next.js dashboard with embedded AI agent |
| `@gtmship/deploy-engine` | Pulumi programs for AWS/GCP deployment |

## Quick Start

```bash
# Clone and install
git clone https://github.com/gtmship/gtmship.git
cd gtmship
pnpm install

# Start local dev (requires Docker)
docker-compose up -d
pnpm dev

# Open dashboard
open http://localhost:3000
```

## Writing Workflows

Workflows are TypeScript functions that AI tools can generate:

```typescript
import { defineWorkflow, triggers, auth } from "@gtmship/sdk";

export default defineWorkflow({
  id: "enrich-lead",
  trigger: triggers.webhook("/enrich"),

  async run(payload: { email: string }) {
    const hubspot = await auth.getClient("hubspot");
    const result = await hubspot.post("/crm/v3/objects/contacts/search", {
      filterGroups: [{
        filters: [{ propertyName: "email", operator: "EQ", value: payload.email }]
      }]
    });
    return result.data;
  },
});
```

## Managing Connections

Add platform connections through the AI-powered chat interface:

1. Open the dashboard at `http://localhost:3000`
2. Configure your AI provider (Claude or OpenAI)
3. Click "Add Connection" and chat with the AI agent
4. The agent guides you through OAuth setup, tests the connection, and saves it

Supports OAuth2, API Key, and Basic Auth. Pre-built templates for HubSpot, Salesforce, and Slack.

## Tech Stack

| Component | Technology | License |
|-----------|-----------|---------|
| Workflow Runtime | Trigger.dev | Apache 2.0 |
| Dashboard | Next.js + shadcn/ui | MIT |
| AI Chat | Vercel AI SDK | Apache 2.0 |
| Deployment | Pulumi | Apache 2.0 |
| Database | PostgreSQL | PostgreSQL |
| Auth Service | Custom (Pizzly-inspired) | MIT |
| CLI | Commander.js | MIT |

## License

MIT
