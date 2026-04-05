import { describe, expect, it } from "vitest";
import { buildMermaidGenerationPrompt } from "@/lib/workflow-studio/mermaid-prompt";

describe("buildMermaidGenerationPrompt", () => {
  it("guides Mermaid generation toward plain-language business steps", () => {
    const prompt = buildMermaidGenerationPrompt({
      title: "Freshdesk tickets to Google Sheet",
      summary: "Keep a sheet updated with the latest Freshdesk tickets.",
      description:
        "Fetch the newest tickets, format the rows, then update the team sheet.",
      accesses: [
        {
          id: "freshdesk-read",
          type: "integration",
          mode: "read",
          label: "Freshdesk",
          purpose: "Read recent tickets",
          providerSlug: "freshdesk",
          status: "verified",
        },
      ],
      writeCheckpoints: [
        {
          id: "google-sheets-write",
          label: "Google Sheets",
          description: "Write the latest ticket rows into the tracker sheet.",
          method: "PUT",
          targetType: "integration",
          providerSlug: "google-sheets",
        },
      ],
      code: "export default defineWorkflow({});",
      conversation:
        "USER: Build a workflow that syncs the latest support tickets into a sheet.",
      currentMermaid:
        "flowchart TD\nA[GET /api/v2/tickets] --> B[PUT Sheet1!A1:K11]",
      lastError: "The mermaid field must be a Mermaid diagram string.",
    });

    expect(prompt).toContain(
      "Write labels in simple business language so a non-technical teammate can quickly understand what the workflow does."
    );
    expect(prompt).toContain(
      "Avoid technical labels such as HTTP methods, API endpoints, query parameters, payload field names, sheet ranges, status codes, helper names, or schema jargon unless they are essential to understanding the workflow."
    );
    expect(prompt).toContain(
      "Prefer labels like 'Fetch latest tickets', 'Prepare sheet rows', 'Update the spreadsheet', or 'Log the error' over raw request or code details."
    );
    expect(prompt).toContain(
      "When revising an existing diagram, simplify any overly technical labels instead of preserving them."
    );
    expect(prompt).toContain("Current Mermaid diagram to revise:");
    expect(prompt).toContain("Previous error: The mermaid field must be a Mermaid diagram string.");
    expect(prompt).not.toContain("major read/transform steps");
  });
});
