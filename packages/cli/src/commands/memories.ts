import type { Command } from "commander";
import { apiGet, apiPost, apiDelete } from "../lib/api-client.js";
import {
  formatOutput,
  printTable,
  printSuccess,
  handleError,
  confirmAction,
  type OutputOptions,
} from "../lib/output.js";

async function listMemories(
  opts: OutputOptions & {
    scope?: string;
    category?: string;
    workflow?: string;
    query?: string;
  },
) {
  try {
    const params = new URLSearchParams();
    if (opts.scope) params.set("scope", opts.scope);
    if (opts.category) params.set("category", opts.category);
    if (opts.workflow) params.set("workflowId", opts.workflow);
    if (opts.query) params.set("q", opts.query);
    const qs = params.toString();
    const data = await apiGet(`/memories${qs ? `?${qs}` : ""}`);
    formatOutput(data, opts, () => {
      const items = data as Array<{
        id: string;
        content: string;
        category: string;
        scope: string;
        source: string;
        createdAt: string;
      }>;
      printTable(
        items.map((m) => ({
          id: m.id,
          category: m.category,
          scope: m.scope,
          source: m.source,
          content: m.content.slice(0, 60),
          created: m.createdAt?.slice(0, 10) || "",
        })),
        [
          { key: "id", label: "ID" },
          { key: "category", label: "Category" },
          { key: "scope", label: "Scope" },
          { key: "content", label: "Content" },
          { key: "created", label: "Created" },
        ],
      );
    });
  } catch (err) {
    handleError(err, opts);
  }
}

async function createMemory(
  opts: OutputOptions & {
    content?: string;
    category?: string;
    scope?: string;
    workflow?: string;
    source?: string;
  },
) {
  try {
    let content = opts.content;
    if (!content) {
      const { default: inquirer } = await import("inquirer");
      const answers = await inquirer.prompt([
        {
          type: "input",
          name: "content",
          message: "Memory content:",
        },
      ]);
      content = answers.content;
    }

    const body: Record<string, string> = { content: content! };
    if (opts.category) body.category = opts.category;
    if (opts.scope) body.scope = opts.scope;
    if (opts.workflow) body.workflowId = opts.workflow;
    if (opts.source) body.source = opts.source;

    const data = await apiPost("/memories", body);
    formatOutput(data, opts, () => {
      const result = data as { id: string };
      printSuccess(`Memory created (ID: ${result.id})`);
    });
  } catch (err) {
    handleError(err, opts);
  }
}

async function deleteMemory(
  id: string,
  opts: OutputOptions & { force?: boolean },
) {
  try {
    const confirmed = await confirmAction(`Delete memory "${id}"?`, opts);
    if (!confirmed) return;

    await apiDelete(`/memories/${encodeURIComponent(id)}`);
    formatOutput({ deleted: true, id }, opts, () => {
      printSuccess(`Memory "${id}" deleted.`);
    });
  } catch (err) {
    handleError(err, opts);
  }
}

async function bulkDeleteMemories(
  opts: OutputOptions & { ids?: string; force?: boolean },
) {
  try {
    if (!opts.ids) {
      console.log("  --ids is required (comma-separated list of memory IDs).");
      process.exit(1);
    }

    const ids = opts.ids.split(",").map((id) => id.trim());
    const confirmed = await confirmAction(
      `Delete ${ids.length} memories?`,
      opts,
    );
    if (!confirmed) return;

    await apiDelete("/memories", { ids });
    formatOutput({ deleted: true, count: ids.length }, opts, () => {
      printSuccess(`${ids.length} memories deleted.`);
    });
  } catch (err) {
    handleError(err, opts);
  }
}

export function registerMemoriesCommand(program: Command) {
  const cmd = program
    .command("memories")
    .description("Manage AI memories");

  cmd
    .command("list")
    .description("List memories")
    .option("--scope <scope>", "Filter by scope (app or workflow)")
    .option("--category <category>", "Filter by category")
    .option("--workflow <id>", "Filter by workflow ID")
    .option("--query <q>", "Search in content")
    .option("--json", "Output as JSON")
    .action((opts) => listMemories(opts));

  cmd
    .command("create")
    .description("Create a memory")
    .option("--content <text>", "Memory content")
    .option("--category <category>", "Category (integration, business, workflow, general)")
    .option("--scope <scope>", "Scope (app or workflow)")
    .option("--workflow <id>", "Workflow ID (required if scope=workflow)")
    .option("--source <source>", "Source (default: cli)")
    .option("--json", "Output as JSON")
    .action((opts) => createMemory(opts));

  cmd
    .command("delete")
    .description("Delete a memory")
    .argument("<id>", "Memory ID")
    .option("--force", "Skip confirmation")
    .option("--json", "Output as JSON")
    .action((id, opts) => deleteMemory(id, opts));

  cmd
    .command("bulk-delete")
    .description("Delete multiple memories")
    .option("--ids <ids>", "Comma-separated list of memory IDs")
    .option("--force", "Skip confirmation")
    .option("--json", "Output as JSON")
    .action((opts) => bulkDeleteMemories(opts));
}
