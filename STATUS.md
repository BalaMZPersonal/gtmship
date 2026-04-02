# GTMShip — Project Status & Pending Tasks

> **Name:** GTMShip  
> **Domain:** gtmship.com (.dev, .io also available)  
> **Tagline:** "Build GTM workflows with AI. Ship to your cloud."  
> **License:** MIT  
> **Repo:** `~/gtmship`  
> **Last updated:** 2026-04-02

---

## Build Progress

### Completed

| # | Component | Package | Status | Notes |
|---|-----------|---------|--------|-------|
| 1 | **Monorepo scaffold** | root | Done | Turborepo + pnpm workspaces, tsconfig, docker-compose, .gitignore, .env.example |
| 2 | **SDK** | `@gtmship/sdk` | Done | `auth.getClient()`, `auth.getToken()`, `defineWorkflow()`, `triggers` (webhook/schedule/event). Fully typed. Builds clean. |
| 3 | **CLI** | `@gtmship/cli` | Done | Commands: `init`, `dev`, `auth add`, `validate`, `deploy`, `logs`. Builds clean. `init` scaffolds a project with config + example workflow. |
| 4 | **Auth Service** | `@gtmship/auth-service` | Done | Express.js + Prisma + PostgreSQL. Routes: providers CRUD, OAuth flow (popup bridge), connections CRUD, API proxy, settings. AES-256-GCM encrypted tokens. |
| 5 | **Deploy Engine** | `@gtmship/deploy-engine` | Done | Pulumi Automation API with LocalWorkspace. Provisions VPC, RDS, S3, Lambda, API Gateway, IAM. |
| 6 | **Connection Templates** | `templates/connections/` | Done | Pre-built YAML configs for HubSpot, Salesforce, Slack |
| 7 | **Example Workflow** | `templates/workflows/` | Done | Lead enrichment workflow using HubSpot API via `auth.getClient()` |
| 8 | **README** | root | Done | Architecture diagram, quick start, code examples, tech stack table |

| 9 | **Dashboard** | `@gtmship/dashboard` | Done | Next.js 14 + Tailwind CSS. Minimalistic. Pages: connections, workflows, deploy, settings. |
| 10 | **Agentic Chat UI** | dashboard component | Done | Vercel AI SDK chat panel with tool calling (searchTemplate, createProvider, connectApiKey, startOAuth, testConnection). |
| 11 | **CLI `dev` command** | `@gtmship/cli` | Done | Docker Compose + auth-service + dashboard process management with cleanup. |

### Not Started

| # | Component | Package | Status | Notes |
|---|-----------|---------|--------|-------|
| 12 | **Integration Tests** | root | Not started | End-to-end test flow |
| 13 | **Tutorial / Docs** | root | Not started | "Build your first GTM workflow with Claude Code in 10 minutes" |

---

## Pending Tasks (Detailed)

### Task 1: Build Dashboard (`packages/dashboard/`)

**Priority:** HIGH — This is the core user-facing product  
**Estimated files:** ~20  
**Tech:** Next.js 14 App Router + shadcn/ui + Tailwind CSS + Vercel AI SDK

#### 1a. Scaffold Next.js App
- Run `npx create-next-app@latest packages/dashboard` with App Router + Tailwind
- Install shadcn/ui (`npx shadcn@latest init`)
- Set up layout with sidebar navigation
- Pages: `/connections`, `/workflows`, `/deploy`, `/settings`

#### 1b. Settings Page (Build First — needed for AI features)
- AI Provider toggle: Claude vs OpenAI
- API key input field (encrypted via auth-service `/settings` API)
- Model selection dropdown (claude-sonnet-4-6, gpt-4o, etc.)
- Test connection button
- Cloud provider config (AWS credentials, region)

#### 1c. Connections Page
- List all connections from auth-service `/connections` API
- Status indicators (active/expired/revoked)
- "Test" button per connection → calls `/connections/:id/test`
- "Add Connection" button → opens agentic chat (Task 2)
- Delete connection

#### 1d. Workflows Page
- List workflow files from project directory
- Execution history table (from Trigger.dev API)
- "Trigger" button for manual webhook trigger
- View logs per execution
- Link to source code

#### 1e. Deploy Page
- Cloud provider selector (AWS / GCP)
- Region selector
- Current deployment status (from deploy-engine)
- "Deploy" button → calls deploy-engine
- Deployment history / rollback
- Infrastructure status (Lambda ARN, API Gateway URL, RDS endpoint)

---

### Task 2: Build Agentic Chat Interface

**Priority:** HIGH — Key differentiator  
**Location:** `packages/dashboard/components/auth-chat/`  
**Tech:** Vercel AI SDK (`@ai-sdk/react`, `useChat` hook) + Generative UI

#### 2a. Chat UI Component
- Chat message list with streaming support
- Input field with send button
- Supports rendering interactive React components inline (Generative UI)
- Persistent across page navigation (global chat panel)

#### 2b. AI Backend Route (`/api/chat`)
- Next.js API route using Vercel AI SDK `streamText`
- Reads AI provider & API key from auth-service settings
- System prompt: GTMShip auth setup specialist
- Supports both Anthropic and OpenAI providers (toggleable)

#### 2c. Tool Definitions (Function Calling)
The AI agent has these tools:

**Developer tools** (via `bash-tool` / `just-bash`):
- `bash` — execute shell commands (grep, curl, etc.) in sandboxed environment
- `readFile` — read file contents from project directory
- `writeFile` — create/modify files (connection configs, workflows)

**Auth tools** (custom):
- `searchProviderTemplate(name)` — look up pre-built YAML templates
- `createConnection(config)` — register connection via auth-service API
- `testConnection(connectionId)` — validate connection works
- `triggerOAuth(provider, clientId, scopes)` — initiate OAuth popup flow

**Deploy tools** (custom):
- `deployWorkflow(name)` — trigger Pulumi deployment
- `getDeployStatus()` — check infrastructure status
- `viewLogs(workflowId)` — tail production logs

#### 2d. Generative UI Components
Interactive components rendered inline in chat responses:
- `CredentialForm` — Client ID / Secret / API Key input fields
- `ScopeSelector` — Checkbox list of OAuth scopes
- `OAuthButton` — Triggers popup bridge for OAuth flow
- `ConnectionTestResult` — Success/failure with details
- `YamlPreview` — Generated config preview (editable)

#### 2e. OAuth Popup Bridge
- `[Connect]` button opens centered popup window → provider OAuth page
- `/auth-callback` page captures auth code via URL params
- Uses `window.postMessage()` to send code back to main window
- Main window exchanges code for tokens via auth-service
- PKCE for security
- Mobile fallback: full-page redirect with localStorage state preservation

---

### Task 3: Implement Deploy Engine (Flesh Out Stub)

**Priority:** MEDIUM — can use `gtmship dev` for local testing meanwhile  
**Location:** `packages/deploy-engine/src/aws.ts`

- Integrate Pulumi Automation API (`@pulumi/pulumi/automation`)
- Implement `LocalWorkspace.createOrSelectStack()` 
- Provision resources:
  - VPC with private subnets
  - RDS PostgreSQL (db.t3.micro)
  - ElastiCache Redis (cache.t3.micro)
  - S3 bucket for workflow artifacts
  - Lambda function with Trigger.dev worker runtime
  - API Gateway v2 (HTTP) for webhook ingress
  - IAM roles with least-privilege policies
- Wire CLI `deploy` command to call deploy engine
- Wire dashboard deploy page to call deploy engine
- Store deployment outputs in auth-service settings

---

### Task 4: Wire CLI `dev` Command

**Priority:** MEDIUM  
**Location:** `packages/cli/src/commands/dev.ts`

- Use `child_process.spawn` to run `docker-compose up -d` (Postgres + Redis)
- Start auth-service dev server (`tsx watch`)
- Start dashboard dev server (`next dev`)
- Use `concurrently` or manual process management
- Handle Ctrl+C to stop all services
- Auto-run Prisma migrations on first start

---

### Task 5: Integration Testing & Tutorial

**Priority:** LOW (after MVP works)

- End-to-end test script:
  1. `gtmship init test-project`
  2. `gtmship dev` (starts services)
  3. Register HubSpot provider via API
  4. Create mock connection
  5. Trigger example workflow via webhook
  6. Verify response
- Write tutorial: "Build and deploy a lead enrichment workflow with Claude Code in 10 minutes"
- Create demo GIF for README

---

## Architecture Recap

```
~/gtmship/
├── packages/
│   ├── sdk/              ✅ Done — @gtmship/sdk
│   ├── cli/              ✅ Done — @gtmship/cli  
│   ├── auth-service/     ✅ Done — Express + Prisma + OAuth
│   ├── dashboard/        ✅ Done — Next.js + AI Chat
│   └── deploy-engine/    ✅ Done — Pulumi Automation API
├── templates/
│   ├── connections/      ✅ Done — HubSpot, Salesforce, Slack
│   └── workflows/        ✅ Done — Lead enrichment example
├── docker-compose.yml    ✅ Done
├── turbo.json            ✅ Done
├── package.json          ✅ Done
└── README.md             ✅ Done
```

## Tech Stack

| Component | Technology | License | Status |
|-----------|-----------|---------|--------|
| Workflow Runtime | Trigger.dev | Apache 2.0 | SDK wrapper done |
| Dashboard | Next.js + shadcn/ui | MIT | Not started |
| AI Chat UI | Vercel AI SDK | Apache 2.0 | Not started |
| Agent Tools | bash-tool + just-bash | MIT | Not started |
| LLM Backend | User's Claude / OpenAI key | BYOK | Settings API done |
| Deployment IaC | Pulumi | Apache 2.0 | Stub done |
| Database | PostgreSQL | PostgreSQL | Docker Compose done |
| Cache/Queue | Redis (Valkey) | BSD | Docker Compose done |
| Auth Service | Custom (Pizzly-inspired) | MIT | Done |
| CLI | Commander.js | MIT | Done |

---

## Key Decisions Made

1. **Name:** GTMShip (gtmship.com available)
2. **Runtime:** Trigger.dev (Apache 2.0, code-first, AI-friendly SDK)
3. **Auth:** Custom MIT-licensed OAuth manager (Nango is AGPL, Composio server is proprietary)
4. **Deploy:** Pulumi (Apache 2.0, programmable IaC in TypeScript)
5. **AI Chat:** Vercel AI SDK + bash-tool (model-agnostic: Claude + OpenAI toggleable)
6. **Audience:** Progressive disclosure — CLI for technical users, dashboard for operators
7. **MVP cloud:** AWS Lambda only (GCP in v0.2)
