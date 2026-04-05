import { tool } from "ai";
import { z } from "zod";

const AUTH_URL = process.env.AUTH_SERVICE_URL || "http://localhost:4000";

interface MemoryToolDefaults {
  source?: string;
  workflowId?: string;
}

export function createSaveMemoryTool(defaults?: MemoryToolDefaults) {
  const hasWorkflow = !!defaults?.workflowId;
  return tool({
    description: hasWorkflow
      ? `Save knowledge to memory for future conversations. Use scope "workflow" for knowledge specific to THIS workflow (${defaults!.workflowId}) — field mappings, endpoint usage patterns, workflow-specific requirements. Use scope "app" for cross-workflow knowledge — provider details, API quirks, business context. Workflow memories are isolated and only visible when working on this same workflow.`
      : "Save knowledge to memory for future conversations. Only app-scoped memories are available (no workflow context). Save provider details, API patterns, business requirements, and other cross-workflow knowledge.",
    parameters: z.object({
      content: z
        .string()
        .describe("The knowledge to remember. Be specific and concise — one clear fact per save."),
      category: z
        .enum(["integration", "business", "workflow", "general"])
        .default("general")
        .describe(
          "Category: integration (API specifics, auth details), business (use cases, requirements), workflow (workflow-specific details), general (other)"
        ),
      scope: z
        .enum(["app", "workflow"])
        .default(hasWorkflow ? "workflow" : "app")
        .describe(
          hasWorkflow
            ? `Scope: "app" = global knowledge available everywhere. "workflow" = scoped to this workflow only (${defaults!.workflowId}), invisible to other workflows.`
            : 'Scope: only "app" is available (no active workflow context).'
        ),
    }),
    execute: async ({ content, category, scope }) => {
      try {
        // Prevent workflow-scoped saves when no workflowId is available
        if (scope === "workflow" && !defaults?.workflowId) {
          return {
            error:
              'Cannot save workflow-scoped memory: no active workflow. Use scope "app" instead.',
          };
        }
        const body: Record<string, string> = {
          content,
          category,
          scope,
          source: defaults?.source || "agent",
        };
        if (scope === "workflow" && defaults?.workflowId) {
          body.workflowId = defaults.workflowId;
        }
        const res = await fetch(`${AUTH_URL}/memories`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const err = await res.text();
          return { error: err || "Failed to save memory." };
        }
        const memory = await res.json();
        return { saved: true, id: memory.id, scope, content: memory.content };
      } catch {
        return { error: "Failed to save memory." };
      }
    },
  });
}

export function createRecallMemoriesTool(defaults?: MemoryToolDefaults) {
  const hasWorkflow = !!defaults?.workflowId;
  return tool({
    description: hasWorkflow
      ? `Search memory for previously saved knowledge. Scope "all" returns app-level memories + this workflow's memories (${defaults!.workflowId}). Scope "workflow" returns only this workflow's memories. Other workflows' memories are never included.`
      : "Search memory for previously saved knowledge. Returns app-level memories only (no workflow context).",
    parameters: z.object({
      query: z.string().describe("Keyword search term"),
      category: z
        .enum(["integration", "business", "workflow", "general", "all"])
        .default("all")
        .describe("Filter by category, or 'all' for everything"),
      scope: z
        .enum(["app", "workflow", "all"])
        .default("all")
        .describe(
          hasWorkflow
            ? `"app" = global only. "workflow" = this workflow only. "all" = app + this workflow.`
            : '"app" or "all" (no workflow context available).'
        ),
    }),
    execute: async ({ query, category, scope }) => {
      try {
        const catParam = category !== "all" ? category : undefined;

        // When in a workflow context and scope is "all", fetch app + current workflow separately
        // to prevent leaking other workflows' memories
        if (scope === "all" && hasWorkflow) {
          const baseParams: Record<string, string> = { q: query };
          if (catParam) baseParams.category = catParam;

          const [appRes, wfRes] = await Promise.all([
            fetch(
              `${AUTH_URL}/memories?${new URLSearchParams({ ...baseParams, scope: "app" })}`
            ),
            fetch(
              `${AUTH_URL}/memories?${new URLSearchParams({
                ...baseParams,
                scope: "workflow",
                workflowId: defaults!.workflowId!,
              })}`
            ),
          ]);

          const appMemories = appRes.ok ? await appRes.json() : [];
          const wfMemories = wfRes.ok ? await wfRes.json() : [];
          const app = Array.isArray(appMemories) ? appMemories : [];
          const wf = Array.isArray(wfMemories) ? wfMemories : [];
          const combined = [...app, ...wf];
          return { memories: combined, count: combined.length };
        }

        // Single-scope fetch
        const params = new URLSearchParams({ q: query });
        if (catParam) params.set("category", catParam);

        if (scope === "workflow" && hasWorkflow) {
          params.set("scope", "workflow");
          params.set("workflowId", defaults!.workflowId!);
        } else {
          // "app", or "all" without workflow context, or "workflow" without workflowId
          params.set("scope", "app");
        }

        const res = await fetch(`${AUTH_URL}/memories?${params.toString()}`);
        if (!res.ok) {
          return { error: "Failed to recall memories.", memories: [], count: 0 };
        }
        const memories = await res.json();
        return {
          memories: Array.isArray(memories) ? memories : [],
          count: Array.isArray(memories) ? memories.length : 0,
        };
      } catch {
        return { error: "Failed to recall memories.", memories: [], count: 0 };
      }
    },
  });
}

export async function fetchMemoryContext(
  workflowId?: string | null
): Promise<string> {
  try {
    const appRes = await fetch(`${AUTH_URL}/memories?scope=app`);
    const appMemories = appRes.ok ? await appRes.json() : [];

    let workflowMemories: { category: string; content: string }[] = [];
    if (workflowId) {
      const wfRes = await fetch(
        `${AUTH_URL}/memories?scope=workflow&workflowId=${encodeURIComponent(workflowId)}`
      );
      workflowMemories = wfRes.ok ? await wfRes.json() : [];
    }

    const hasApp = Array.isArray(appMemories) && appMemories.length > 0;
    const hasWf =
      Array.isArray(workflowMemories) && workflowMemories.length > 0;

    if (!hasApp && !hasWf) {
      return "";
    }

    const lines: string[] = ["\n\n--- MEMORY CONTEXT (from previous conversations) ---"];

    if (hasApp) {
      lines.push(
        "## App-level memories (shared across ALL workflows):"
      );
      for (const m of appMemories.slice(0, 20)) {
        lines.push(`- [${m.category}] ${m.content}`);
      }
    }

    if (hasWf) {
      lines.push(
        `\n## Workflow memories (ONLY for workflow "${workflowId}" — not visible to other workflows):`
      );
      for (const m of workflowMemories.slice(0, 20)) {
        lines.push(`- [${m.category}] ${m.content}`);
      }
    }

    lines.push("--- END MEMORY CONTEXT ---\n");

    const result = lines.join("\n");
    // Cap at ~4000 chars to avoid bloating system prompts
    if (result.length > 4000) {
      return result.slice(0, 3950) + "\n... (truncated)\n--- END MEMORY CONTEXT ---\n";
    }
    return result;
  } catch {
    return "";
  }
}

export const MEMORY_SYSTEM_PROMPT_ADDITION = `

MEMORY — Use memory proactively to build up knowledge across conversations.

TWO MEMORY SCOPES:
- **App-level** (scope "app"): Shared across ALL workflows and conversations. Use for: provider details (base URLs, auth quirks), API patterns (pagination, rate limits), verified connection info, business requirements, user preferences. Any agent can read and write these.
- **Workflow-level** (scope "workflow"): Isolated to ONE specific workflow. Use for: field mappings, endpoint usage specific to this workflow, workflow-specific requirements, grounded API context for this workflow's providers. These memories are INVISIBLE to other workflows — they only appear when working on the same workflow.

WHEN TO SAVE (use saveMemory):
- After grounding API endpoints: save confirmed endpoint paths, methods, key fields. Use category "integration", scope "app" (reusable) or "workflow" (if specific to this flow).
- After verifying a connection works: save provider slug, auth type, base URL, quirks. Use category "integration", scope "app".
- After the user confirms a business requirement: save it. Use category "business". Scope "app" if general, "workflow" if workflow-specific.
- After a successful workflow preview/build: save the working approach. Use category "workflow", scope "workflow".
- After discovering an API quirk or pattern firsthand: save it. Use category "integration", scope "app".
- When the user shares preferences or setup details: save it. Use category "business" or "general", scope "app".

WHAT NOT TO SAVE:
- Raw API responses or large data dumps.
- Information that changes frequently (token values, temporary IDs).
- Speculation or untested assumptions about how an API works.

WHEN TO RECALL (use recallMemories):
- At the start of every conversation, recall relevant context about the providers involved.
- Before grounding API endpoints, check if endpoints were previously grounded.
- When the user references past work or asks you to build something similar.
- Use scope "all" to get both app + current workflow memories. Use scope "workflow" to see only this workflow's memories.

Be concise in what you save. One clear sentence per fact is better than a paragraph.`;
