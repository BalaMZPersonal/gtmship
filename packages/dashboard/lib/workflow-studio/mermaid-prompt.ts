import type {
  WorkflowAccessRequirement,
  WorkflowWriteCheckpoint,
} from "./types";

interface BuildMermaidGenerationPromptInput {
  title: string;
  summary: string;
  description?: string;
  accesses: WorkflowAccessRequirement[];
  writeCheckpoints: WorkflowWriteCheckpoint[];
  code: string;
  conversation: string;
  currentMermaid?: string | null;
  lastError?: string;
}

export function buildMermaidGenerationPrompt(
  input: BuildMermaidGenerationPromptInput
): string {
  return [
    "You are GTMShip Workflow Studio. Generate a Mermaid diagram for the finalized workflow draft.",
    "Return a Mermaid flowchart or graph that matches the workflow behavior.",
    "The diagram should highlight the trigger, the main business steps, any key decisions or approvals, the final updates, and the outcome.",
    "Write labels in simple business language so a non-technical teammate can quickly understand what the workflow does.",
    "Translate implementation details into plain-English actions whenever possible.",
    "Avoid technical labels such as HTTP methods, API endpoints, query parameters, payload field names, sheet ranges, status codes, helper names, or schema jargon unless they are essential to understanding the workflow.",
    "Prefer labels like 'Fetch latest tickets', 'Prepare sheet rows', 'Update the spreadsheet', or 'Log the error' over raw request or code details.",
    "When revising an existing diagram, simplify any overly technical labels instead of preserving them.",
    "Keep node labels short, readable, and outcome-oriented.",
    "Return raw Mermaid only, without markdown fences.",
    "Do not use emoji characters in node labels.",
    "IMPORTANT: Keep all node definitions on a single line. Never split closing delimiters like }}, ]), or )) across multiple lines.",
    "",
    "Finalized workflow draft:",
    JSON.stringify(
      {
        title: input.title,
        summary: input.summary,
        description: input.description,
        requiredAccesses: input.accesses,
        writeCheckpoints: input.writeCheckpoints,
      },
      null,
      2
    ),
    "",
    "Workflow code:",
    input.code,
    input.currentMermaid?.trim()
      ? [
          "",
          "Current Mermaid diagram to revise:",
          input.currentMermaid.trim(),
        ].join("\n")
      : "",
    input.lastError
      ? [
          "",
          "The previous Mermaid generation attempt failed. Fix the response so it returns valid Mermaid only.",
          `Previous error: ${input.lastError}`,
        ].join("\n")
      : "",
    "",
    "Conversation:",
    input.conversation,
  ]
    .filter(Boolean)
    .join("\n");
}
