import { generateObject } from "ai";
import { z } from "zod";
import { fetchUrl } from "@/lib/url-fetcher";
import { createConfiguredLanguageModel } from "@/lib/ai-settings";
import {
  listActiveConnections,
  testConnection,
} from "./auth-service";
import { buildWorkflowPlanFromArtifact } from "./deploy-plan";
import { previewWorkflowArtifact } from "./preview";
import { slugifyWorkflowTitle } from "./storage";
import type {
  WorkflowAccessRequirement,
  WorkflowBinding,
  WorkflowPreviewResult,
  WorkflowStudioArtifact,
  WorkflowStudioMessage,
  WorkflowValidationReport,
} from "./types";
import { validateWorkflowArtifact } from "./validate";

const requirementSchema = z.object({
  id: z.string(),
  type: z.enum(["integration", "public_url"]),
  mode: z.enum(["read", "write"]),
  label: z.string(),
  purpose: z.string(),
  providerSlug: z.string().optional(),
  url: z.string().optional(),
});

const checkpointSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  method: z.string(),
  targetType: z.enum(["integration", "public_url"]),
  providerSlug: z.string().optional(),
  url: z.string().optional(),
});

const analysisSchema = z.object({
  title: z.string(),
  slug: z.string().optional(),
  summary: z.string(),
  requiredAccesses: z.array(requirementSchema),
  writeCheckpoints: z.array(checkpointSchema),
  samplePayload: z.string(),
});

const artifactSchema = z.object({
  assistantMessage: z.string(),
  title: z.string(),
  slug: z.string(),
  summary: z.string(),
  description: z.string().optional(),
  mermaid: z.string(),
  code: z.string(),
  samplePayload: z.string(),
  chatSummary: z.string(),
  writeCheckpoints: z.array(checkpointSchema),
});

type ActiveConnection = Awaited<ReturnType<typeof listActiveConnections>>[number];
type WorkflowStudioModel = Awaited<ReturnType<typeof resolveModel>>;

function getMessageText(message: WorkflowStudioMessage): string {
  const content = message.content?.trim();
  if (content) {
    return content;
  }

  if (!message.parts?.length) {
    return "";
  }

  return message.parts
    .map((part) =>
      part.type === "text" && typeof part.text === "string" ? part.text : ""
    )
    .join("\n")
    .trim();
}

function formatConversation(messages: WorkflowStudioMessage[]): string {
  return messages
    .map((message) => ({
      role: message.role,
      text: getMessageText(message),
    }))
    .filter(
      (message) =>
        message.text &&
        (message.role === "user" ||
          message.role === "assistant" ||
          message.role === "system")
    )
    .map((message) => `${message.role.toUpperCase()}: ${message.text}`)
    .join("\n\n");
}

async function resolveModel() {
  return createConfiguredLanguageModel();
}

function summarizeBlockers(accesses: WorkflowAccessRequirement[]): string {
  const lines = accesses
    .filter((access) => access.status === "missing" || access.status === "blocked")
    .map((access) => {
      const target = access.type === "integration"
        ? access.providerSlug || access.label
        : access.url || access.label;
      return `- ${target}: ${access.statusMessage || access.status}`;
    });

  return [
    "I stopped before generating code because some required access is not ready:",
    ...lines,
    "",
    "Fix the blocked items, then ask me again and I’ll generate the workflow against the verified access.",
  ].join("\n");
}

function sanitizeJsonString(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return "{}";
  }
}

function ensureMermaid(value: string, title: string): string {
  if (/\b(flowchart|graph)\b/i.test(value)) {
    return value;
  }

  return [
    "flowchart LR",
    `  trigger([Trigger]) --> workflow[${title}]`,
    "  workflow --> output([Result])",
  ].join("\n");
}

function normalizeGeneratedCode(value: string): string {
  const withoutFences = value
    .trim()
    .replace(/^```(?:ts|tsx|typescript)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  if (
    /export\s+default\s+\w+\s*;?/.test(withoutFences) ||
    /export\s+default\s+defineWorkflow\s*\(/.test(withoutFences)
  ) {
    return withoutFences;
  }

  if (/defineWorkflow\s*\(/.test(withoutFences)) {
    return withoutFences.replace(
      /defineWorkflow\s*\(/,
      "export default defineWorkflow("
    );
  }

  return withoutFences;
}

function normalizeText(value?: string | null): string {
  return (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.map((value) => (value || "").trim()).filter(Boolean))
  );
}

function getConnectionSearchTexts(connection: ActiveConnection): string[] {
  return uniqueNonEmpty([
    connection.provider.slug,
    connection.provider.name,
    connection.label,
    connection.provider.description,
  ]);
}

function connectionSupportsEmail(connection: ActiveConnection): boolean {
  const haystack = normalizeText(getConnectionSearchTexts(connection).join(" "));
  return /\b(email|gmail|inbox|mailbox)\b/.test(haystack);
}

function looksLikeEmailIntent(value: string): boolean {
  const normalized = normalizeText(value);
  return (
    /\b(email|gmail|mail|inbox|mailbox)\b/.test(normalized) ||
    /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(value)
  );
}

function scoreCandidateText(query: string, candidate: string): number {
  const normalizedQuery = normalizeText(query);
  const normalizedCandidate = normalizeText(candidate);

  if (!normalizedQuery || !normalizedCandidate) {
    return 0;
  }

  if (normalizedQuery === normalizedCandidate) {
    return 120;
  }

  let score = 0;

  if (
    normalizedCandidate.includes(normalizedQuery) ||
    normalizedQuery.includes(normalizedCandidate)
  ) {
    score = Math.max(score, 70);
  }

  const queryTokens = Array.from(
    new Set(normalizedQuery.split(" ").filter((token) => token.length > 1))
  );
  const candidateTokens = new Set(
    normalizedCandidate.split(" ").filter((token) => token.length > 1)
  );
  const overlap = queryTokens.filter((token) => candidateTokens.has(token)).length;

  score += overlap * 12;

  if (overlap > 0 && overlap === queryTokens.length) {
    score += 16;
  }

  return score;
}

function resolveConnectionMatch(
  searchTerms: Array<string | null | undefined>,
  connections: ActiveConnection[]
): ActiveConnection | null {
  const terms = uniqueNonEmpty(searchTerms);
  if (terms.length === 0 || connections.length === 0) {
    return null;
  }

  const primaryTerms = terms.slice(0, 2);
  const joinedTerms = terms.join(" ");
  const hasEmailIntent = primaryTerms.some(looksLikeEmailIntent);
  const scopedConnections = hasEmailIntent
    ? connections.filter(connectionSupportsEmail)
    : connections;
  const candidates = scopedConnections.length > 0 ? scopedConnections : connections;

  for (const term of terms) {
    const normalizedTerm = normalizeText(term);
    if (!normalizedTerm) {
      continue;
    }

    const exactMatch = candidates.find((connection) =>
      getConnectionSearchTexts(connection).some(
        (candidate) => normalizeText(candidate) === normalizedTerm
      )
    );

    if (exactMatch) {
      return exactMatch;
    }
  }

  let bestMatch: { connection: ActiveConnection; score: number } | null = null;

  for (const connection of candidates) {
    const searchTexts = getConnectionSearchTexts(connection);
    let score = 0;

    for (const term of primaryTerms) {
      for (const candidate of searchTexts) {
        score = Math.max(score, scoreCandidateText(term, candidate));
      }
    }

    if (joinedTerms) {
      for (const candidate of searchTexts) {
        score = Math.max(score, scoreCandidateText(joinedTerms, candidate));
      }
    }

    if (hasEmailIntent && connectionSupportsEmail(connection)) {
      score += 32;
    }

    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { connection, score };
    }
  }

  return bestMatch && bestMatch.score >= 30 ? bestMatch.connection : null;
}

function normalizeAccessRequirement(
  access: z.infer<typeof requirementSchema>,
  connections: ActiveConnection[]
): z.infer<typeof requirementSchema> {
  if (access.type === "public_url" && access.url) {
    return access;
  }

  const match = resolveConnectionMatch(
    [access.providerSlug, access.label, access.purpose],
    connections
  );

  if (!match) {
    return access;
  }

  return {
    ...access,
    type: "integration",
    providerSlug: match.provider.slug,
    url: undefined,
  };
}

function normalizeWriteCheckpoint(
  checkpoint: z.infer<typeof checkpointSchema>,
  connections: ActiveConnection[]
): z.infer<typeof checkpointSchema> {
  if (checkpoint.targetType === "public_url" && checkpoint.url) {
    return checkpoint;
  }

  const match = resolveConnectionMatch(
    [checkpoint.providerSlug, checkpoint.label, checkpoint.description],
    connections
  );

  if (!match) {
    return checkpoint;
  }

  return {
    ...checkpoint,
    targetType: "integration",
    providerSlug: match.provider.slug,
    url: undefined,
  };
}

function deriveBindingsFromAccesses(
  accesses: WorkflowAccessRequirement[],
  existingBindings?: WorkflowBinding[]
): WorkflowBinding[] {
  const existing = existingBindings || [];
  const providerSlugs = new Set(
    accesses
      .filter((access) => access.type === "integration" && access.providerSlug)
      .map((access) => access.providerSlug as string)
  );

  for (const binding of existing) {
    providerSlugs.add(binding.providerSlug);
  }

  return Array.from(providerSlugs).map((providerSlug) => {
    const existingBinding = existing.find(
      (binding) => binding.providerSlug === providerSlug
    );
    if (existingBinding) {
      return existingBinding;
    }

    return {
      providerSlug,
      selector: {
        type: "latest_active",
      },
    };
  });
}

async function preflightAccesses(
  accesses: z.infer<typeof requirementSchema>[],
  connections?: ActiveConnection[]
): Promise<WorkflowAccessRequirement[]> {
  const activeConnections = connections || (await listActiveConnections());

  return Promise.all(
    accesses.map(async (rawAccess) => {
      const access = normalizeAccessRequirement(rawAccess, activeConnections);

      if (access.type === "integration") {
        const connection = resolveConnectionMatch(
          [access.providerSlug, access.label, access.purpose],
          activeConnections
        );
        const providerSlug = connection?.provider.slug || access.providerSlug || "";

        if (!connection) {
          return {
            ...access,
            providerSlug,
            status: "missing" as const,
            statusMessage: providerSlug
              ? `No active ${providerSlug} connection found.`
              : `No active integration matched "${access.label}".`,
          };
        }

        const result = await testConnection(connection.id);
        return {
          ...access,
          providerSlug,
          connectionId: connection.id,
          status: result.success ? "verified" : "blocked",
          statusMessage: result.success
            ? `Verified against active ${providerSlug} connection.`
            : result.error || "Connection test failed.",
        };
      }

      if (!access.url) {
        return {
          ...access,
          status: "blocked" as const,
          statusMessage: "A public URL is required for this access.",
        };
      }

      const result = await fetchUrl(access.url, {
        method: access.mode === "read" ? "GET" : "HEAD",
      });

      return {
        ...access,
        status: !result.error && result.status > 0 && result.status < 400
          ? "reachable"
          : "blocked",
        statusMessage:
          !result.error && result.status > 0 && result.status < 400
            ? `Preflight ${access.mode === "read" ? "GET" : "HEAD"} succeeded (${result.status}).`
            : result.error || `Preflight failed with status ${result.status}.`,
      };
    })
  );
}

async function generateAnalysis(
  messages: WorkflowStudioMessage[],
  currentArtifact?: WorkflowStudioArtifact | null,
  resolvedModel?: WorkflowStudioModel
) {
  const model = resolvedModel ?? (await resolveModel());
  const connections = await listActiveConnections();
  const prompt = [
    "You are designing a GTMShip workflow request before any code is generated.",
    "Infer the required accesses, write checkpoints, slug, title, and sample payload from the conversation.",
    "Be conservative: only include integrations the workflow truly needs, and only include public URLs when the user explicitly mentions them or they are necessary to satisfy the request.",
    "When an active integration can satisfy the request, prefer a required access of type `integration` and use the exact active provider slug.",
    "Only use `public_url` when the user explicitly provides a literal public URL or clearly asks for an authless/public HTTP endpoint.",
    "For write operations, create stable checkpoint ids that will be reused in generated code.",
    "",
    connections.length > 0
      ? [
          "Active integrations available right now:",
          ...connections.map((connection) =>
            `- slug: ${connection.provider.slug}; name: ${connection.provider.name}; label: ${connection.label || "n/a"}; description: ${connection.provider.description || "n/a"}`
          ),
          "Map references like Gmail/email sending to `gmail` when Gmail is active.",
          "Map references like Factors Journey API, Factors Account Journey API, or Factors.ai API to `factors` when that integration is active.",
          "",
        ].join("\n")
      : "",
    "Conversation:",
    formatConversation(messages),
    currentArtifact
      ? [
          "",
          "Current artifact summary:",
          `Title: ${currentArtifact.title}`,
          `Slug: ${currentArtifact.slug}`,
          `Summary: ${currentArtifact.summary}`,
        ].join("\n")
      : "",
  ].join("\n");

  const result = await generateObject({
    model,
    schema: analysisSchema,
    system:
      "Return structured analysis for a workflow request. Do not generate code yet.",
    prompt,
  });

  return result.object;
}

async function generateArtifactOnce(
  messages: WorkflowStudioMessage[],
  accesses: WorkflowAccessRequirement[],
  writeCheckpoints: z.infer<typeof checkpointSchema>[],
  currentArtifact?: WorkflowStudioArtifact | null,
  previousValidation?: WorkflowValidationReport,
  previousPreview?: WorkflowPreviewResult,
  resolvedModel?: WorkflowStudioModel
) {
  const model = resolvedModel ?? (await resolveModel());
  const prompt = [
    "You are GTMShip Workflow Studio. Generate a complete workflow artifact.",
    "The workflow must be open-ended and support arbitrary TypeScript data transformation, but all network access must go through WorkflowContext helpers.",
    "Generated code requirements:",
    '- Start with a comment containing "Generated by GTMShip Workflow Studio".',
    '- Use `import { defineWorkflow, triggers, type WorkflowContext } from "@gtmship/sdk";`.',
    "- Export a default defineWorkflow({...}) object.",
    "- Implement `async run(payload, ctx: WorkflowContext)`.",
    "- Add deploy-visible logging with `console.log(...)` and `console.error(...)` so runtime logs stay useful after deployment.",
    "- Log the workflow start, important checkpoints, and the final success or failure outcome.",
    "- Include the workflow id in every log message so `gtmship logs --workflow <id>` is useful.",
    "- When you call `integration.read(...)`, `integration.write(...)`, `ctx.web.read(...)`, or `ctx.web.write(...)`, log the operation before it runs and log the returned `status` afterward.",
    "- Keep logs concise and JSON-serializable, and never log secrets, access tokens, or raw auth headers.",
    "- Wrap the run body in `try/catch`, log failures with `console.error(...)`, and rethrow the error.",
    "- Use `const integration = await ctx.integration(\"provider-slug\")` for active integrations.",
    "- Use `integration.read(...)` for reads and `integration.write(..., { method, checkpoint, ... })` for writes.",
    "- `ctx.integration(...).read/write(...)` must use provider-relative paths like `/open/v1/...`, never full `https://...` URLs.",
    "- Use `ctx.web.read(url, ...)` for public/authless reads and `ctx.web.write(url, ...)` for public/authless writes.",
    "- `integration.read(...)`, `integration.write(...)`, `ctx.web.read(...)`, and `ctx.web.write(...)` return an object shaped like `{ data, status }`.",
    "- Read response data from the `.data` property before transforming it.",
    "- Never use raw fetch, axios, auth.getClient, auth.getToken, process.env, fs, child_process, or external imports.",
    "- Keep the workflow valid TypeScript and return JSON-serializable results.",
    "- The `code` field must be raw TypeScript only. Do not wrap it in markdown fences.",
    "- The `code` field must contain `export default defineWorkflow({ ... })` directly.",
    "- Reuse the verified access list exactly as provided.",
    "- Reuse checkpoint ids exactly as provided.",
    "- The `samplePayload` field must be valid JSON and should satisfy any required payload inputs so preview can run successfully.",
    "- A preview outcome of `needs_approval` is acceptable when the only remaining step is a declared write checkpoint.",
    "",
    "Use this exact module shape for the generated code:",
    [
      "// Generated by GTMShip Workflow Studio",
      'import { defineWorkflow, triggers, type WorkflowContext } from "@gtmship/sdk";',
      "",
      "export default defineWorkflow({",
      '  id: \"workflow-id\",',
      '  name: \"Workflow Name\",',
      '  description: \"What this workflow does.\",',
      "  trigger: triggers.manual(),",
      "  async run(payload, ctx: WorkflowContext) {",
      '    console.log("[workflow-id] Starting workflow run", { payload });',
      "    try {",
      "      const result = { ok: true };",
      '      console.log("[workflow-id] Workflow completed", { result });',
      "      return result;",
      "    } catch (error) {",
      '      console.error("[workflow-id] Workflow failed", {',
      '        error: error instanceof Error ? error.message : String(error),',
      "      });",
      "      throw error;",
      "    }",
      "  },",
      "});",
    ].join("\n"),
    "",
    "Verified access list:",
    JSON.stringify(accesses, null, 2),
    "",
    "Write checkpoints:",
    JSON.stringify(writeCheckpoints, null, 2),
    currentArtifact
      ? [
          "",
          "Current artifact to modify:",
          JSON.stringify(
            {
              slug: currentArtifact.slug,
              title: currentArtifact.title,
              summary: currentArtifact.summary,
              mermaid: currentArtifact.mermaid,
              code: currentArtifact.code,
            },
            null,
            2
          ),
        ].join("\n")
      : "",
    previousValidation
      ? [
          "",
          "Previous validation errors to fix:",
          JSON.stringify(previousValidation.issues, null, 2),
        ].join("\n")
      : "",
    previousPreview?.status === "error"
      ? [
          "",
          "Previous preview error to fix:",
          JSON.stringify(
            {
              error: previousPreview.error,
              operations: previousPreview.operations,
            },
            null,
            2
          ),
        ].join("\n")
      : "",
    "",
    "Conversation:",
    formatConversation(messages),
  ].join("\n");

  const result = await generateObject({
    model,
    schema: artifactSchema,
    system:
      "Return only the structured workflow artifact. The code must compile and follow the helper rules exactly.",
    prompt,
  });

  return result.object;
}

export async function generateWorkflowArtifact(input: {
  messages: WorkflowStudioMessage[];
  currentArtifact?: WorkflowStudioArtifact | null;
  resolvedModel?: WorkflowStudioModel;
}): Promise<{
  assistantMessage: string;
  artifact?: WorkflowStudioArtifact;
  blockedAccesses?: WorkflowAccessRequirement[];
}> {
  if (input.messages.length === 0) {
    throw new Error("Workflow Studio needs at least one chat message.");
  }

  const analysis = await generateAnalysis(
    input.messages,
    input.currentArtifact,
    input.resolvedModel
  );
  const activeConnections = await listActiveConnections();
  const normalizedAccesses = analysis.requiredAccesses.map((access) =>
    normalizeAccessRequirement(access, activeConnections)
  );
  const normalizedWriteCheckpoints = analysis.writeCheckpoints.map((checkpoint) =>
    normalizeWriteCheckpoint(checkpoint, activeConnections)
  );
  const slug = slugifyWorkflowTitle(
    analysis.slug || input.currentArtifact?.slug || analysis.title
  );
  const verifiedAccesses = await preflightAccesses(
    normalizedAccesses,
    activeConnections
  );
  const hasBlockers = verifiedAccesses.some(
    (access) => access.status === "missing" || access.status === "blocked"
  );

  if (hasBlockers) {
    return {
      assistantMessage: summarizeBlockers(verifiedAccesses),
      blockedAccesses: verifiedAccesses,
    };
  }

  let previousValidation: WorkflowValidationReport | undefined;
  let latestValidation: WorkflowValidationReport | undefined;
  let previousPreview: WorkflowPreviewResult | undefined;
  let latestPreview: WorkflowPreviewResult | undefined;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const generated = await generateArtifactOnce(
      input.messages,
      verifiedAccesses,
      normalizedWriteCheckpoints,
      input.currentArtifact,
      previousValidation,
      previousPreview,
      input.resolvedModel
    );

    const artifact: WorkflowStudioArtifact = {
      slug,
      title: generated.title,
      summary: generated.summary,
      description: generated.description,
      mermaid: ensureMermaid(generated.mermaid, generated.title),
      code: normalizeGeneratedCode(generated.code),
      samplePayload: sanitizeJsonString(generated.samplePayload),
      requiredAccesses: verifiedAccesses,
      writeCheckpoints: generated.writeCheckpoints.map((checkpoint) =>
        normalizeWriteCheckpoint(checkpoint, activeConnections)
      ),
      chatSummary: generated.chatSummary,
      messages: input.messages,
      deploy: input.currentArtifact?.deploy,
      triggerConfig: input.currentArtifact?.triggerConfig,
      bindings: deriveBindingsFromAccesses(
        verifiedAccesses,
        input.currentArtifact?.bindings
      ),
    };
    const validation = validateWorkflowArtifact({
      slug: artifact.slug,
      code: artifact.code,
      writeCheckpoints: artifact.writeCheckpoints,
    });
    latestValidation = validation;
    artifact.validation = validation;
    const preview = await previewWorkflowArtifact({
      slug: artifact.slug,
      code: artifact.code,
      samplePayload: artifact.samplePayload,
    });
    latestPreview = preview;
    artifact.preview = preview;
    artifact.deploymentPlan = buildWorkflowPlanFromArtifact(artifact);

    if (validation.ok && preview.status !== "error") {
      return {
        assistantMessage: generated.assistantMessage,
        artifact,
      };
    }

    previousValidation = validation;
    previousPreview = preview.status === "error" ? preview : undefined;
  }

  throw new Error(
    latestValidation?.issues?.length
      ? `Workflow Studio could not generate valid code after multiple attempts. Last validation issues: ${latestValidation.issues.map((issue) => issue.message).join(" | ")}`
      : latestPreview?.status === "error" && latestPreview.error
        ? `Workflow Studio could not produce a working preview after multiple attempts. Last preview error: ${latestPreview.error}`
        : "Workflow Studio could not generate valid code after multiple attempts."
  );
}
