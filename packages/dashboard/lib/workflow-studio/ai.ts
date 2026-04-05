import { generateObject } from "ai";
import { z } from "zod";
import { fetchUrl } from "@/lib/url-fetcher";
import { createConfiguredLanguageModel } from "@/lib/ai-settings";
import {
  listActiveConnections,
  testConnection,
} from "./auth-service";
import { buildWorkflowPlanFromArtifact } from "./deploy-plan";
import { buildMermaidGenerationPrompt } from "./mermaid-prompt";
import { previewWorkflowArtifact } from "./preview";
import { slugifyWorkflowTitle } from "./storage";
import { ContextManager, GENERATION_TOKEN_BUDGET } from "./context-manager";
import { compactWorkflowTranscriptIfNeeded } from "./transcript-compaction-server";
import {
  getArtifactTranscriptCompaction,
  getWorkflowMessageModelText,
  isWorkflowPromptTooLongError,
} from "./transcript-compaction";
import type {
  GroundedApiContext,
  GroundedEndpoint,
  WorkflowAccessRequirement,
  WorkflowBinding,
  WorkflowDraftProgressEvent,
  WorkflowPreviewResult,
  WorkflowStudioArtifact,
  WorkflowStudioMessage,
  WorkflowTranscriptCompaction,
  WorkflowValidationReport,
} from "./types";
import { validateWorkflowArtifact } from "./validate";

const GROUNDED_API_CONTEXT_MARKER = "GROUNDED API CONTEXT:";
const ENDPOINT_LINE_PATTERN =
  /^-\s*(\S+):\s*(GET|POST|PUT|PATCH|DELETE|HEAD)\s+(\S+)\s*(?:—\s*(.*))?$/i;

export function parseGroundedApiContext(
  instructions: string | undefined
): GroundedApiContext | undefined {
  if (!instructions) return undefined;

  const idx = instructions.indexOf(GROUNDED_API_CONTEXT_MARKER);
  if (idx === -1) return undefined;

  const section = instructions.slice(idx + GROUNDED_API_CONTEXT_MARKER.length);
  const endpoints: GroundedEndpoint[] = [];
  const researchNotes: string[] = [];
  let current: Partial<GroundedEndpoint> | null = null;

  for (const rawLine of section.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    const endpointMatch = trimmed.match(ENDPOINT_LINE_PATTERN);
    if (endpointMatch) {
      if (current?.provider && current?.path) {
        endpoints.push(current as GroundedEndpoint);
      }
      current = {
        provider: endpointMatch[1],
        method: endpointMatch[2].toUpperCase(),
        path: endpointMatch[3],
        purpose: endpointMatch[4]?.trim() || "",
      };
      continue;
    }

    if (current) {
      const testedMatch = trimmed.match(
        /^Tested:\s*(yes|no)\s*Status:\s*(\d+)/i
      );
      if (testedMatch) {
        current.tested = testedMatch[1].toLowerCase() === "yes";
        current.testStatus = parseInt(testedMatch[2], 10);
        continue;
      }

      const requestMatch = trimmed.match(/^Request:\s*(.+)/i);
      if (requestMatch) {
        current.requestSchema = requestMatch[1].trim();
        continue;
      }

      const responseMatch = trimmed.match(/^Response:\s*(.+)/i);
      if (responseMatch) {
        current.responseSchema = responseMatch[1].trim();
        continue;
      }

      const docsMatch = trimmed.match(/^Docs:\s*(.+)/i);
      if (docsMatch) {
        current.docsSource = docsMatch[1].trim();
        continue;
      }
    }

    researchNotes.push(trimmed);
  }

  if (current?.provider && current?.path) {
    endpoints.push(current as GroundedEndpoint);
  }

  if (endpoints.length === 0 && researchNotes.length === 0) {
    return undefined;
  }

  return {
    endpoints,
    researchNotes,
    groundedAt: new Date().toISOString(),
  };
}

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
  summary: z.string(),
  requiredAccesses: z.array(requirementSchema),
  writeCheckpoints: z.array(checkpointSchema),
});

const codeDraftSchema = z.object({
  assistantMessage: z.string(),
  description: z.string().optional(),
  code: z.string(),
  samplePayload: z.string(),
});

const mermaidSchema = z.object({
  mermaid: z.string(),
});

const chatSummarySchema = z.object({
  chatSummary: z.string(),
});

type ActiveConnection = Awaited<ReturnType<typeof listActiveConnections>>[number];
type WorkflowStudioModel = Awaited<ReturnType<typeof resolveModel>>;
type WorkflowDraftGenerationStage =
  | "analysis"
  | "code"
  | "mermaid"
  | "chatSummary";
type WorkflowDraftProgressUpdate = Omit<
  WorkflowDraftProgressEvent,
  "type" | "toolCallId" | "timestamp" | "label"
>;
type WorkflowDraftProgressReporter = (
  update: WorkflowDraftProgressUpdate
) => void;
type WorkflowAnalysis = z.infer<typeof analysisSchema>;
type WorkflowCodeDraft = z.infer<typeof codeDraftSchema>;

const MERMAID_SYNTAX_RE =
  /\b(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|mindmap|timeline)\b/i;
const CODE_GENERATION_MAX_ATTEMPTS = 3;

function formatConversation(messages: WorkflowStudioMessage[]): string {
  return messages
    .map((message) => ({
      role: message.role,
      text: getWorkflowMessageModelText(message),
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

function formatPreviewContextForPrompt(
  preview: WorkflowPreviewResult
): Record<string, unknown> {
  // Include all failed operations + last 15 operations (deduped)
  const failedOps = preview.operations.filter(
    (op) => op.responseStatus && (op.responseStatus < 200 || op.responseStatus >= 400)
  );
  const recentOps = preview.operations.slice(-15);
  const seenIds = new Set<string>();
  const ops = [...failedOps, ...recentOps].filter((op) => {
    if (seenIds.has(op.id)) return false;
    seenIds.add(op.id);
    return true;
  });

  return {
    status: preview.status,
    error: preview.error,
    stack: preview.stack,
    warnings: preview.warnings,
    operations: ops,
    logs:
      preview.logs
        ?.slice(-40)
        .map((entry) => ({
          level: entry.level,
          timestamp: entry.timestamp,
          message: entry.message,
        })) || [],
  };
}

async function resolveModel() {
  return createConfiguredLanguageModel();
}

function getGenerationErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback;
}

function emitDraftProgress(
  onProgress: WorkflowDraftProgressReporter | undefined,
  update: WorkflowDraftProgressUpdate
) {
  onProgress?.(update);
}

function buildDraftGenerationCompactionBudgetText(
  currentArtifact?: WorkflowStudioArtifact | null
): string {
  const artifactContext = currentArtifact
    ? JSON.stringify(
        {
          title: currentArtifact.title,
          slug: currentArtifact.slug,
          summary: currentArtifact.summary,
          description: currentArtifact.description,
          chatSummary: currentArtifact.chatSummary,
          code: currentArtifact.code,
          mermaid: currentArtifact.mermaid,
          samplePayload: currentArtifact.samplePayload,
          requiredAccesses: currentArtifact.requiredAccesses,
          writeCheckpoints: currentArtifact.writeCheckpoints,
          validation: currentArtifact.validation,
          preview: currentArtifact.preview,
        },
        null,
        2
      )
    : "";

  return [
    "Reserve prompt budget for Workflow Studio analysis, code generation, Mermaid generation, and draft finalization.",
    "These prompts include workflow instructions, verified accesses, write checkpoints, validation feedback, preview feedback, and current draft context.",
    artifactContext
      ? ["Current draft context:", artifactContext].join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function compactDraftTranscriptForGeneration(input: {
  messages: WorkflowStudioMessage[];
  currentArtifact?: WorkflowStudioArtifact | null;
  resolvedModel?: WorkflowStudioModel;
  force?: boolean;
}): Promise<{
  messages: WorkflowStudioMessage[];
  transcriptCompaction?: WorkflowTranscriptCompaction;
  changed: boolean;
}> {
  return compactWorkflowTranscriptIfNeeded({
    messages: input.messages,
    currentArtifact: input.currentArtifact,
    additionalText: buildDraftGenerationCompactionBudgetText(
      input.currentArtifact
    ),
    resolvedModel: input.resolvedModel,
    triggerTokens: input.force ? 1 : undefined,
    recentTokens: input.force ? 4_000 : undefined,
  });
}

async function retryStageWithTranscriptCompaction<T>(input: {
  messages: WorkflowStudioMessage[];
  currentArtifact?: WorkflowStudioArtifact | null;
  resolvedModel?: WorkflowStudioModel;
  run: (messages: WorkflowStudioMessage[]) => Promise<T>;
  onCompaction?: () => void;
}): Promise<{
  result: T;
  messages: WorkflowStudioMessage[];
  transcriptCompaction?: WorkflowTranscriptCompaction;
}> {
  let messages = input.messages;
  let transcriptCompaction = getArtifactTranscriptCompaction(input.currentArtifact);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return {
        result: await input.run(messages),
        messages,
        transcriptCompaction,
      };
    } catch (error) {
      if (attempt > 0 || !isWorkflowPromptTooLongError(error)) {
        throw error;
      }

      const compacted = await compactDraftTranscriptForGeneration({
        messages,
        currentArtifact: input.currentArtifact,
        resolvedModel: input.resolvedModel,
        force: true,
      });

      if (!compacted.changed) {
        throw error;
      }

      messages = compacted.messages;
      transcriptCompaction =
        compacted.transcriptCompaction || transcriptCompaction;
      input.onCompaction?.();
    }
  }

  throw new Error("Workflow Studio could not retry the compacted transcript.");
}

class WorkflowDraftGenerationError extends Error {
  stage: WorkflowDraftGenerationStage;

  constructor(stage: WorkflowDraftGenerationStage, detail: string) {
    super(
      `Workflow Studio could not complete the ${formatGenerationStage(stage)} stage after multiple attempts. ${detail}`
    );
    this.name = "WorkflowDraftGenerationError";
    this.stage = stage;
  }
}

function formatGenerationStage(stage: WorkflowDraftGenerationStage): string {
  switch (stage) {
    case "chatSummary":
      return "chat summary";
    default:
      return stage;
  }
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

function stripMarkdownFences(value: string): string {
  return value
    .trim()
    .replace(/^```(?:\w+)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function normalizeGeneratedJson(value: string): string {
  const normalized = stripMarkdownFences(value);

  try {
    return JSON.stringify(JSON.parse(normalized), null, 2);
  } catch {
    throw new Error("The samplePayload field must be valid JSON.");
  }
}

function normalizeGeneratedMermaid(value: string): string {
  let normalized = stripMarkdownFences(value);
  if (!MERMAID_SYNTAX_RE.test(normalized)) {
    throw new Error(
      "The mermaid field must be a Mermaid diagram string without markdown fences."
    );
  }

  // Fix orphaned closing delimiters split across lines by AI generation.
  // E.g., hexagon nodes: D{{"text"}\n  } → D{{"text"}}
  normalized = normalized.replace(/([}\])])\s*\n[ \t]*([}\])])/g, "$1$2");

  return normalized;
}

function normalizeGeneratedCode(value: string): string {
  const withoutFences = stripMarkdownFences(value);

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
): Promise<WorkflowAnalysis> {
  const model = resolvedModel ?? (await resolveModel());
  const connections = await listActiveConnections();
  let lastError: string | undefined;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const prompt = [
      "You are designing a GTMShip workflow request before any code is generated.",
      "Infer the workflow title, summary, required accesses, and write checkpoints from the conversation.",
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
      lastError
        ? [
            "The previous structured analysis attempt failed. Fix the response so it strictly matches the schema.",
            `Previous error: ${lastError}`,
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

    try {
      const result = await generateObject({
        model,
        schema: analysisSchema,
        system:
          "Return structured analysis for a workflow request. Do not generate code yet.",
        prompt,
      });

      return result.object;
    } catch (error) {
      if (isWorkflowPromptTooLongError(error)) {
        throw error;
      }

      lastError = getGenerationErrorMessage(
        error,
        "Workflow Studio could not produce structured analysis."
      );
    }
  }

  throw new WorkflowDraftGenerationError(
    "analysis",
    `Last generation error: ${lastError || "Workflow Studio could not produce structured analysis."}`
  );
}

async function generateCodeDraftOnce(
  messages: WorkflowStudioMessage[],
  analysis: WorkflowAnalysis,
  accesses: WorkflowAccessRequirement[],
  writeCheckpoints: z.infer<typeof checkpointSchema>[],
  currentArtifact?: WorkflowStudioArtifact | null,
  previousValidation?: WorkflowValidationReport,
  previousPreview?: WorkflowPreviewResult,
  previousGenerationError?: string,
  resolvedModel?: WorkflowStudioModel,
  groundedApiContext?: GroundedApiContext
): Promise<WorkflowCodeDraft> {
  const model = resolvedModel ?? (await resolveModel());
  const prompt = [
    "You are GTMShip Workflow Studio. Generate the code-facing portion of the workflow draft.",
    "The workflow must be open-ended and support arbitrary TypeScript data transformation, but all network access must go through WorkflowContext helpers.",
    "Use the provided workflow title and summary as the source of truth for what should be built.",
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
    "- Use `integration.read(...)` for reads and `integration.write(..., { method, checkpoint, ... })` for writes. CRITICAL: Every `.write(...)` call MUST include `checkpoint: \"<checkpoint-id>\"` from the write checkpoints list. Omitting it causes a hard validation failure.",
    "- `ctx.integration(...).read/write(...)` must use provider-relative paths like `/open/v1/...`, never full `https://...` URLs.",
    "- Use `ctx.web.read(url, ...)` for public/authless reads and `ctx.web.write(url, ...)` for public/authless writes.",
    "- `integration.read(...)`, `integration.write(...)`, `ctx.web.read(...)`, and `ctx.web.write(...)` return an object shaped like `{ data, status }`.",
    "- Read response data from the `.data` property before transforming it.",
    "- When the auth proxy encounters a non-JSON upstream response (e.g., file exports, binary downloads), the response `.data` is a JSON envelope: `{ _binary: true, contentType: string, data: string, size: number }` where `data` is the base64-encoded content. Access the raw bytes via `Buffer.from(result.data.data, 'base64')`. Check for `result.data._binary` to detect this case.",
    "- Available globals: `Buffer`, `URL`, `setTimeout`, `clearTimeout`, `console`. No `crypto`, `fs`, `child_process`, or `AbortController`.",
    "- You can override the default `Content-Type: application/json` header by passing `headers: { 'Content-Type': '...' }` in the read/write config.",
    "- For non-JSON request bodies (e.g., form-encoded, XML, raw text), pass the body as a string — string bodies are sent as-is without JSON serialization. Object bodies are JSON-stringified automatically.",
    "- Preview stops at the first unapproved write checkpoint and returns `needs_approval`. This is expected and correct — don't remove checkpoints to avoid it.",
    "- Never use raw fetch, axios, auth.getClient, auth.getToken, process.env, fs, child_process, or external imports.",
    "- Keep the workflow valid TypeScript and return JSON-serializable results.",
    "- The `code` field must be raw TypeScript only. Do not wrap it in markdown fences.",
    "- The `code` field must contain `export default defineWorkflow({ ... })` directly.",
    "- Reuse the verified access list exactly as provided.",
    "- Reuse checkpoint ids exactly as provided.",
    "- The `samplePayload` field must be valid JSON and should satisfy any required payload inputs so preview can run successfully.",
    "- A preview outcome of `needs_approval` is acceptable when the only remaining work is one or more declared write checkpoint approvals.",
    "- Do not remove legitimate write checkpoints just to avoid preview-only approvals. The studio UI can resume through multiple checkpoint approvals in sequence.",
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
      '      // Read example:',
      '      // const integration = await ctx.integration("provider-slug");',
      '      // const readResult = await integration.read("/path");',
      '      // Write example — MUST include checkpoint from the write checkpoints list:',
      '      // await integration.write("/path", { method: "POST", body: data, checkpoint: "checkpoint-id" });',
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
    "Workflow outline:",
    JSON.stringify(
      {
        title: analysis.title,
        summary: analysis.summary,
      },
      null,
      2
    ),
    "",
    "Verified access list:",
    JSON.stringify(accesses, null, 2),
    ...(groundedApiContext?.endpoints.length
      ? [
          "",
          "Grounded API Context (verified endpoints — use these exact paths and schemas):",
          JSON.stringify(groundedApiContext.endpoints, null, 2),
          ...(groundedApiContext.researchNotes.length > 0
            ? ["", "API Research Notes:", ...groundedApiContext.researchNotes]
            : []),
          "",
          "IMPORTANT: Use the exact endpoint paths, methods, request fields, and response fields above.",
          "Do not guess or hallucinate endpoint paths or field names.",
        ]
      : [
          "",
          "WARNING: No grounded API context was provided for this generation.",
          "The workflow agent did not verify endpoint paths, request schemas, or response shapes before calling generateWorkflowDraft.",
          "Use only well-known, stable API patterns. Do not guess endpoint paths or field names.",
        ]),
    "",
    "Write checkpoints (EVERY .write() call MUST pass one of these ids as `checkpoint:`):",
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
              description: currentArtifact.description,
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
    previousPreview &&
    (previousPreview.status === "error" ||
      (previousPreview.warnings?.length || 0) > 0)
      ? [
          "",
          "Previous preview issue to fix:",
          JSON.stringify(formatPreviewContextForPrompt(previousPreview), null, 2),
        ].join("\n")
      : "",
    previousGenerationError
      ? [
          "",
          "Previous code generation attempt failed before validation. Fix the structured response so it matches the schema exactly and keeps every required field present.",
          `Previous generation error: ${previousGenerationError}`,
        ].join("\n")
      : "",
    "",
    "Conversation:",
    formatConversation(messages),
  ].join("\n");

  const result = await generateObject({
    model,
    schema: codeDraftSchema,
    system:
      "Return only the structured code draft. The code must compile and follow the helper rules exactly.",
    prompt,
  });

  return result.object;
}

async function generateMermaid(
  messages: WorkflowStudioMessage[],
  input: {
    title: string;
    summary: string;
    description?: string;
    accesses: WorkflowAccessRequirement[];
    writeCheckpoints: z.infer<typeof checkpointSchema>[];
    code: string;
  },
  currentArtifact?: WorkflowStudioArtifact | null,
  resolvedModel?: WorkflowStudioModel
): Promise<string> {
  const model = resolvedModel ?? (await resolveModel());
  let lastError: string | undefined;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const prompt = buildMermaidGenerationPrompt({
      title: input.title,
      summary: input.summary,
      description: input.description,
      accesses: input.accesses,
      writeCheckpoints: input.writeCheckpoints,
      code: input.code,
      conversation: formatConversation(messages),
      currentMermaid: currentArtifact?.mermaid,
      lastError,
    });

    try {
      const result = await generateObject({
        model,
        schema: mermaidSchema,
        system:
          "Return only the Mermaid diagram for the workflow. Do not include prose or markdown fences.",
        prompt,
      });

      return normalizeGeneratedMermaid(result.object.mermaid);
    } catch (error) {
      if (isWorkflowPromptTooLongError(error)) {
        throw error;
      }

      lastError = getGenerationErrorMessage(
        error,
        "Workflow Studio could not generate Mermaid."
      );
    }
  }

  throw new WorkflowDraftGenerationError(
    "mermaid",
    `Last generation error: ${lastError || "Workflow Studio could not generate Mermaid."}`
  );
}

async function generateChatSummary(
  messages: WorkflowStudioMessage[],
  input: {
    title: string;
    summary: string;
    description?: string;
    accesses: WorkflowAccessRequirement[];
    writeCheckpoints: z.infer<typeof checkpointSchema>[];
    code: string;
    mermaid: string;
  },
  currentArtifact?: WorkflowStudioArtifact | null,
  resolvedModel?: WorkflowStudioModel
): Promise<string> {
  const model = resolvedModel ?? (await resolveModel());
  let lastError: string | undefined;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const prompt = [
      "Write a durable, compact chat summary for the finalized GTMShip workflow draft.",
      "Capture the workflow goal, important integrations or URLs, approval checkpoints, and the key output.",
      "Keep it concise and factual, suitable for future workflow repair context.",
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
      currentArtifact?.chatSummary?.trim()
        ? [
            "",
            "Current chat summary to improve:",
            currentArtifact.chatSummary.trim(),
          ].join("\n")
        : "",
      lastError
        ? [
            "",
            "The previous chat summary generation attempt failed. Fix the response so it returns a concise summary string.",
            `Previous error: ${lastError}`,
          ].join("\n")
        : "",
      "",
      "Conversation:",
      formatConversation(messages),
    ]
      .filter(Boolean)
      .join("\n");

    try {
      const result = await generateObject({
        model,
        schema: chatSummarySchema,
        system:
          "Return only the structured chat summary field for the finalized workflow draft.",
        prompt,
      });

      return result.object.chatSummary.trim();
    } catch (error) {
      if (isWorkflowPromptTooLongError(error)) {
        throw error;
      }

      lastError = getGenerationErrorMessage(
        error,
        "Workflow Studio could not generate a chat summary."
      );
    }
  }

  throw new WorkflowDraftGenerationError(
    "chatSummary",
    `Last generation error: ${lastError || "Workflow Studio could not generate a chat summary."}`
  );
}

export async function generateWorkflowArtifact(input: {
  messages: WorkflowStudioMessage[];
  currentArtifact?: WorkflowStudioArtifact | null;
  resolvedModel?: WorkflowStudioModel;
  onProgress?: WorkflowDraftProgressReporter;
  groundedApiContext?: GroundedApiContext;
}): Promise<{
  assistantMessage: string;
  artifact?: WorkflowStudioArtifact;
  blockedAccesses?: WorkflowAccessRequirement[];
}> {
  if (input.messages.length === 0) {
    throw new Error("Workflow Studio needs at least one chat message.");
  }

  emitDraftProgress(input.onProgress, {
    stage: "analysis",
    status: "started",
    detail: "Reviewing the request and outlining the workflow.",
  });

  let compactedTranscript: Awaited<
    ReturnType<typeof compactWorkflowTranscriptIfNeeded>
  >;
  let analysis: WorkflowAnalysis;
  try {
    compactedTranscript = await compactDraftTranscriptForGeneration({
      messages: input.messages,
      currentArtifact: input.currentArtifact,
      resolvedModel: input.resolvedModel,
    });
  } catch (error) {
    emitDraftProgress(input.onProgress, {
      stage: "analysis",
      status: "failed",
      detail: getGenerationErrorMessage(
        error,
        "Workflow Studio could not define the workflow."
      ),
    });
    throw error;
  }

  const genContextManager = new ContextManager({
    tokenBudget: GENERATION_TOKEN_BUDGET,
  });
  const managed = genContextManager.manage(compactedTranscript.messages);

  let modelMessages = managed.messages;
  let transcriptCompaction =
    compactedTranscript.transcriptCompaction ||
    getArtifactTranscriptCompaction(input.currentArtifact);

  try {
    const analysisResult = await retryStageWithTranscriptCompaction({
      messages: modelMessages,
      currentArtifact: input.currentArtifact,
      resolvedModel: input.resolvedModel,
      run: (messages) =>
        generateAnalysis(messages, input.currentArtifact, input.resolvedModel),
      onCompaction: () => {
        emitDraftProgress(input.onProgress, {
          stage: "analysis",
          status: "update",
          detail:
            "Older chat was compacted to stay within the model context budget. Retrying analysis.",
        });
      },
    });
    analysis = analysisResult.result;
    modelMessages = analysisResult.messages;
    transcriptCompaction =
      analysisResult.transcriptCompaction || transcriptCompaction;
  } catch (error) {
    emitDraftProgress(input.onProgress, {
      stage: "analysis",
      status: "failed",
      detail: getGenerationErrorMessage(
        error,
        "Workflow Studio could not define the workflow."
      ),
    });
    throw error;
  }

  emitDraftProgress(input.onProgress, {
    stage: "analysis",
    status: "completed",
    detail: "Workflow definition is ready.",
  });

  emitDraftProgress(input.onProgress, {
    stage: "access",
    status: "started",
    detail: "Verifying integrations and public endpoints.",
  });

  let activeConnections: ActiveConnection[];
  let normalizedAccesses: z.infer<typeof requirementSchema>[];
  let normalizedWriteCheckpoints: z.infer<typeof checkpointSchema>[];
  let verifiedAccesses: WorkflowAccessRequirement[];

  try {
    activeConnections = await listActiveConnections();
    normalizedAccesses = analysis.requiredAccesses.map((access) =>
      normalizeAccessRequirement(access, activeConnections)
    );
    normalizedWriteCheckpoints = analysis.writeCheckpoints.map((checkpoint) =>
      normalizeWriteCheckpoint(checkpoint, activeConnections)
    );
    verifiedAccesses = await preflightAccesses(
      normalizedAccesses,
      activeConnections
    );
  } catch (error) {
    emitDraftProgress(input.onProgress, {
      stage: "access",
      status: "failed",
      detail: getGenerationErrorMessage(
        error,
        "Workflow Studio could not verify required access."
      ),
    });
    throw error;
  }

  const slug = slugifyWorkflowTitle(
    input.currentArtifact?.slug || analysis.title
  );
  const hasBlockers = verifiedAccesses.some(
    (access) => access.status === "missing" || access.status === "blocked"
  );

  if (hasBlockers) {
    const blockedCount = verifiedAccesses.filter(
      (access) => access.status === "missing" || access.status === "blocked"
    ).length;

    emitDraftProgress(input.onProgress, {
      stage: "access",
      status: "blocked",
      detail:
        blockedCount === 1
          ? "1 required connection or URL still needs attention."
          : `${blockedCount} required connections or URLs still need attention.`,
    });

    return {
      assistantMessage: summarizeBlockers(verifiedAccesses),
      blockedAccesses: verifiedAccesses,
    };
  }

  emitDraftProgress(input.onProgress, {
    stage: "access",
    status: "completed",
    detail: "Required access is ready.",
  });

  if (input.groundedApiContext?.endpoints.length) {
    emitDraftProgress(input.onProgress, {
      stage: "grounding",
      status: "started",
      detail: `Applying grounded API context with ${input.groundedApiContext.endpoints.length} verified endpoint(s).`,
    });
    emitDraftProgress(input.onProgress, {
      stage: "grounding",
      status: "completed",
      detail: "API schemas are grounded and ready for code generation.",
    });
  } else {
    emitDraftProgress(input.onProgress, {
      stage: "grounding",
      status: "completed",
      detail: "No grounded API context was provided. Code generation will use fallback hints — endpoint paths and field names may be less reliable.",
    });
  }

  let previousValidation: WorkflowValidationReport | undefined;
  let latestValidation: WorkflowValidationReport | undefined;
  let previousPreview: WorkflowPreviewResult | undefined;
  let latestPreview: WorkflowPreviewResult | undefined;
  let latestGenerationError: string | undefined;
  let codeDraft: WorkflowCodeDraft | undefined;

  emitDraftProgress(input.onProgress, {
    stage: "code",
    status: "started",
    detail: "Generating the workflow implementation.",
    attempt: 1,
    totalAttempts: CODE_GENERATION_MAX_ATTEMPTS,
  });

  for (let attempt = 0; attempt < CODE_GENERATION_MAX_ATTEMPTS; attempt += 1) {
    const attemptNumber = attempt + 1;
    console.log(`[workflow-studio:code] Attempt ${attemptNumber}/${CODE_GENERATION_MAX_ATTEMPTS} starting for slug="${slug}"`);

    emitDraftProgress(input.onProgress, {
      stage: "code",
      status: "update",
      detail: `Generating attempt ${attemptNumber} of ${CODE_GENERATION_MAX_ATTEMPTS}.`,
      attempt: attemptNumber,
      totalAttempts: CODE_GENERATION_MAX_ATTEMPTS,
    });

    let generated: WorkflowCodeDraft;
    let normalizedCode: string;
    let normalizedSamplePayload: string;
    try {
      const codeGenerationResult = await retryStageWithTranscriptCompaction({
        messages: modelMessages,
        currentArtifact: input.currentArtifact,
        resolvedModel: input.resolvedModel,
        run: (messages) =>
          generateCodeDraftOnce(
            messages,
            analysis,
            verifiedAccesses,
            normalizedWriteCheckpoints,
            input.currentArtifact,
            previousValidation,
            previousPreview,
            latestGenerationError,
            input.resolvedModel,
            input.groundedApiContext
          ),
        onCompaction: () => {
          emitDraftProgress(input.onProgress, {
            stage: "code",
            status: "update",
            detail:
              "Older chat was compacted to stay within the model context budget. Retrying this draft attempt.",
            attempt: attemptNumber,
            totalAttempts: CODE_GENERATION_MAX_ATTEMPTS,
          });
        },
      });
      generated = codeGenerationResult.result;
      modelMessages = codeGenerationResult.messages;
      transcriptCompaction =
        codeGenerationResult.transcriptCompaction || transcriptCompaction;
      normalizedCode = normalizeGeneratedCode(generated.code);
      normalizedSamplePayload = normalizeGeneratedJson(generated.samplePayload);
      latestGenerationError = undefined;
    } catch (error) {
      latestGenerationError = getGenerationErrorMessage(
        error,
        "Workflow Studio could not generate a valid structured code draft."
      );
      console.error(`[workflow-studio:code] Attempt ${attemptNumber} generation failed:`, latestGenerationError);
      if (error instanceof Error && error.stack) {
        console.error(`[workflow-studio:code] Stack:`, error.stack);
      }
      emitDraftProgress(input.onProgress, {
        stage: "code",
        status: "update",
        detail: `Attempt ${attemptNumber} needs another pass before validation.`,
        attempt: attemptNumber,
        totalAttempts: CODE_GENERATION_MAX_ATTEMPTS,
      });
      continue;
    }

    emitDraftProgress(input.onProgress, {
      stage: "code",
      status: "update",
      detail: `Validating attempt ${attemptNumber}.`,
      attempt: attemptNumber,
      totalAttempts: CODE_GENERATION_MAX_ATTEMPTS,
    });

    const validation = validateWorkflowArtifact({
      slug,
      code: normalizedCode,
      writeCheckpoints: normalizedWriteCheckpoints,
    });
    latestValidation = validation;
    if (!validation.ok) {
      console.error(`[workflow-studio:code] Attempt ${attemptNumber} validation failed (${validation.issues.length} issues):`,
        validation.issues.map((i) => `[${i.level}] ${i.message}`).join(" | "));
    } else {
      console.log(`[workflow-studio:code] Attempt ${attemptNumber} validation passed`);
    }

    emitDraftProgress(input.onProgress, {
      stage: "code",
      status: "update",
      detail: `Running preview for attempt ${attemptNumber}.`,
      attempt: attemptNumber,
      totalAttempts: CODE_GENERATION_MAX_ATTEMPTS,
    });

    const preview = await previewWorkflowArtifact({
      slug,
      code: normalizedCode,
      samplePayload: normalizedSamplePayload,
    });
    latestPreview = preview;
    if (preview.status === "error") {
      console.error(`[workflow-studio:code] Attempt ${attemptNumber} preview error:`, preview.error);
      if (preview.stack) console.error(`[workflow-studio:code] Preview stack:`, preview.stack);
      const failedOps = preview.operations.filter((op) => op.responseStatus && (op.responseStatus < 200 || op.responseStatus >= 400));
      if (failedOps.length > 0) {
        console.error(`[workflow-studio:code] Failed operations:`, failedOps.map((op) => `${op.method} ${op.target} -> ${op.responseStatus}`).join(", "));
      }
    } else if (preview.warnings?.length) {
      console.log(`[workflow-studio:code] Attempt ${attemptNumber} preview passed with warnings:`, preview.warnings.join(" | "));
    } else {
      console.log(`[workflow-studio:code] Attempt ${attemptNumber} preview status="${preview.status}"`);
    }

    if (validation.ok && preview.status !== "error") {
      codeDraft = {
        ...generated,
        code: normalizedCode,
        samplePayload: normalizedSamplePayload,
      };
      console.log(`[workflow-studio:code] Attempt ${attemptNumber} succeeded (validation=ok, preview=${preview.status})`);
      emitDraftProgress(input.onProgress, {
        stage: "code",
        status: "completed",
        detail:
          preview.status === "needs_approval"
            ? "Workflow code is ready and only waiting on declared approvals."
            : "Workflow code passed validation and preview.",
        attempt: attemptNumber,
        totalAttempts: CODE_GENERATION_MAX_ATTEMPTS,
      });
      break;
    }

    previousValidation = validation;
    previousPreview = preview.status === "error" ? preview : undefined;

    emitDraftProgress(input.onProgress, {
      stage: "code",
      status: "update",
      detail: validation.ok
        ? "Preview found an issue, so the draft is being revised."
        : "Validation found issues, so the draft is being revised.",
      attempt: attemptNumber,
      totalAttempts: CODE_GENERATION_MAX_ATTEMPTS,
    });
  }

  if (!codeDraft) {
    const detail = latestValidation?.issues?.length
      ? `Last validation issues: ${latestValidation.issues.map((issue) => issue.message).join(" | ")}`
      : latestPreview?.status === "error" && latestPreview.error
        ? `Last preview error: ${latestPreview.error}`
        : latestGenerationError
          ? `Last generation error: ${latestGenerationError}`
          : "The code stage did not produce a valid workflow draft.";

    console.error(`[workflow-studio:code] All ${CODE_GENERATION_MAX_ATTEMPTS} attempts failed for slug="${slug}"`);
    console.error(`[workflow-studio:code] Final detail:`, detail);
    if (latestValidation && !latestValidation.ok) {
      console.error(`[workflow-studio:code] Last validation issues:`, latestValidation.issues.map((i) => `[${i.level}] ${i.message}`).join(" | "));
    }
    if (latestPreview?.status === "error") {
      console.error(`[workflow-studio:code] Last preview error:`, latestPreview.error);
      if (latestPreview.stack) console.error(`[workflow-studio:code] Last preview stack:`, latestPreview.stack);
      const failedOps = latestPreview.operations.filter((op) => op.responseStatus && (op.responseStatus < 200 || op.responseStatus >= 400));
      if (failedOps.length > 0) {
        console.error(`[workflow-studio:code] Last failed ops:`, failedOps.map((op) => `${op.method} ${op.target} -> ${op.responseStatus}`).join(", "));
      }
    }
    if (latestGenerationError) {
      console.error(`[workflow-studio:code] Last generation error:`, latestGenerationError);
    }

    emitDraftProgress(input.onProgress, {
      stage: "code",
      status: "failed",
      detail,
      attempt: CODE_GENERATION_MAX_ATTEMPTS,
      totalAttempts: CODE_GENERATION_MAX_ATTEMPTS,
    });

    throw new WorkflowDraftGenerationError("code", detail);
  }

  emitDraftProgress(input.onProgress, {
    stage: "mermaid",
    status: "started",
    detail: "Turning the workflow into a visual flow.",
  });

  let mermaid: string;
  try {
    const mermaidResult = await retryStageWithTranscriptCompaction({
      messages: modelMessages,
      currentArtifact: input.currentArtifact,
      resolvedModel: input.resolvedModel,
      run: (messages) =>
        generateMermaid(
          messages,
          {
            title: analysis.title,
            summary: analysis.summary,
            description: codeDraft.description,
            accesses: verifiedAccesses,
            writeCheckpoints: normalizedWriteCheckpoints,
            code: codeDraft.code,
          },
          input.currentArtifact,
          input.resolvedModel
        ),
      onCompaction: () => {
        emitDraftProgress(input.onProgress, {
          stage: "mermaid",
          status: "update",
          detail:
            "Older chat was compacted to stay within the model context budget. Retrying the diagram step.",
        });
      },
    });
    mermaid = mermaidResult.result;
    modelMessages = mermaidResult.messages;
    transcriptCompaction =
      mermaidResult.transcriptCompaction || transcriptCompaction;
  } catch (error) {
    emitDraftProgress(input.onProgress, {
      stage: "mermaid",
      status: "failed",
      detail: getGenerationErrorMessage(
        error,
        "Workflow Studio could not visualize the workflow."
      ),
    });
    throw error;
  }

  emitDraftProgress(input.onProgress, {
    stage: "mermaid",
    status: "completed",
    detail: "Workflow diagram is ready.",
  });

  emitDraftProgress(input.onProgress, {
    stage: "finalize",
    status: "started",
    detail: "Saving the draft summary and final metadata.",
  });

  let artifact: WorkflowStudioArtifact;
  try {
    const chatSummaryResult = await retryStageWithTranscriptCompaction({
      messages: modelMessages,
      currentArtifact: input.currentArtifact,
      resolvedModel: input.resolvedModel,
      run: (messages) =>
        generateChatSummary(
          messages,
          {
            title: analysis.title,
            summary: analysis.summary,
            description: codeDraft.description,
            accesses: verifiedAccesses,
            writeCheckpoints: normalizedWriteCheckpoints,
            code: codeDraft.code,
            mermaid,
          },
          input.currentArtifact,
          input.resolvedModel
        ),
      onCompaction: () => {
        emitDraftProgress(input.onProgress, {
          stage: "finalize",
          status: "update",
          detail:
            "Older chat was compacted to stay within the model context budget. Retrying finalization.",
        });
      },
    });
    const chatSummary = chatSummaryResult.result;
    modelMessages = chatSummaryResult.messages;
    transcriptCompaction =
      chatSummaryResult.transcriptCompaction || transcriptCompaction;
    artifact = {
      slug,
      title: analysis.title,
      summary: analysis.summary,
      description: codeDraft.description,
      mermaid,
      code: codeDraft.code,
      samplePayload: codeDraft.samplePayload,
      requiredAccesses: verifiedAccesses,
      writeCheckpoints: normalizedWriteCheckpoints,
      chatSummary,
      messages: modelMessages,
      transcriptCompaction,
      deploy: input.currentArtifact?.deploy,
      triggerConfig: input.currentArtifact?.triggerConfig,
      bindings: deriveBindingsFromAccesses(
        verifiedAccesses,
        input.currentArtifact?.bindings
      ),
      validation: latestValidation,
      preview: latestPreview,
      groundedApiContext: input.groundedApiContext,
    };
    artifact.deploymentPlan = buildWorkflowPlanFromArtifact(artifact);
  } catch (error) {
    emitDraftProgress(input.onProgress, {
      stage: "finalize",
      status: "failed",
      detail: getGenerationErrorMessage(
        error,
        "Workflow Studio could not finalize the draft."
      ),
    });
    throw error;
  }

  emitDraftProgress(input.onProgress, {
    stage: "finalize",
    status: "completed",
    detail: "Draft is ready.",
  });

  return {
    assistantMessage: codeDraft.assistantMessage,
    artifact,
  };
}
