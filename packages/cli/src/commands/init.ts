import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";

const CONFIG_TEMPLATE = `# GTMShip Configuration
name: "{name}"
version: "0.1.0"

# Cloud deployment target (aws or gcp)
deploy:
  provider: aws          # aws or gcp
  region: us-east-1      # AWS: us-east-1, us-west-2 | GCP: us-central1, europe-west1
  # gcp_project: my-project-id  # Required for GCP deployments

# Per-workflow deployment overrides (optional)
# workflows:
#   my-workflow:
#     deploy:
#       provider: gcp
#       region: us-central1
#       gcp_project: my-project-id
#       execution:
#         kind: job
#       auth:
#         mode: proxy
#     trigger_config:
#       schedule:
#         cron: "0 * * * *"
#         timezone: UTC
#     bindings:
#       hubspot:
#         type: connection_id
#         value: conn_123

# Auth service
auth:
  url: http://localhost:4000

# AI Provider (for agentic features)
ai:
  provider: claude  # or "openai"
`;

const WORKFLOW_TEMPLATE = `import { defineWorkflow, triggers, type WorkflowContext } from "@gtmship/sdk";

export default defineWorkflow({
  id: "hello-world",
  name: "Hello World",
  description: "A simple example workflow",
  trigger: triggers.webhook("/hello"),

  async run(payload: { name?: string }, _ctx: WorkflowContext) {
    console.log("[hello-world] Starting workflow run", {
      name: payload.name || "World",
    });

    try {
      const result = {
        message: \`Hello, \${payload.name || "World"}!\`,
        timestamp: new Date().toISOString(),
      };

      console.log("[hello-world] Workflow completed", { result });
      return result;
    } catch (error) {
      console.error("[hello-world] Workflow failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});
`;

export async function initCommand(name: string) {
  const projectDir = join(process.cwd(), name);

  if (existsSync(projectDir)) {
    console.log(chalk.red(`Directory "${name}" already exists.`));
    process.exit(1);
  }

  console.log(chalk.blue(`\n🚀 Creating GTMShip project: ${name}\n`));

  // Create directories
  mkdirSync(join(projectDir, "workflows"), { recursive: true });
  mkdirSync(join(projectDir, "connections"), { recursive: true });

  // Write config
  writeFileSync(
    join(projectDir, "gtmship.config.yaml"),
    CONFIG_TEMPLATE.replace("{name}", name)
  );

  // Write example workflow
  writeFileSync(
    join(projectDir, "workflows", "hello-world.ts"),
    WORKFLOW_TEMPLATE
  );

  // Write package.json
  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify(
      {
        name,
        private: true,
        type: "module",
        dependencies: {
          "@gtmship/sdk": "^0.1.0",
        },
        devDependencies: {
          typescript: "^5.7.0",
        },
      },
      null,
      2
    )
  );

  console.log(chalk.green("  ✓ Created gtmship.config.yaml"));
  console.log(chalk.green("  ✓ Created workflows/hello-world.ts"));
  console.log(chalk.green("  ✓ Created package.json"));
  console.log(
    chalk.blue(`\n  Next steps:
    cd ${name}
    npm install
    gtmship setup
    gtmship dev
  `)
  );
}
