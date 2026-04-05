import {
  createDataStreamResponse,
  streamText,
  tool,
  type DataStreamWriter,
} from "ai";
import { z } from "zod";
import { createConfiguredLanguageModel } from "@/lib/ai-settings";
import { executeCommand } from "@/lib/sandbox";
import { fetchUrl } from "@/lib/url-fetcher";
import { searchDocumentation } from "@/lib/doc-search";
import { researchWeb, researchWebInputSchema } from "@/lib/research";
import {
  generateWorkflowArtifact,
  parseGroundedApiContext,
} from "./ai";
import { fetchAndFilterOpenApiSpec } from "./openapi-spec";
import { buildWorkflowArtifact } from "./build";
import { buildWorkflowPlanFromArtifact } from "./deploy-plan";
import {
  didUserExplicitlyRequestBuild,
  formatBuildStatusMessage,
  formatPreviewStatusMessage,
} from "./status-messaging";
import {
  getProviderDetail,
  listActiveConnections,
  testConnection,
} from "./auth-service";
import { previewWorkflowArtifact } from "./preview";
import { loadProjectDeploymentDefaults } from "./project-config";
import { readProjectFile, searchProjectFiles, prepareWorkflowScratchWorkspace } from "./project-docs";
import {
  ContextManager,
  COORDINATOR_TOKEN_BUDGET,
  truncateToolResult,
} from "./context-manager";
import {
  createSaveMemoryTool,
  createRecallMemoriesTool,
  fetchMemoryContext,
  MEMORY_SYSTEM_PROMPT_ADDITION,
} from "@/lib/memory-tools";
import { compactWorkflowTranscriptIfNeeded } from "./transcript-compaction-server";
import { normalizeWorkflowMessagesForModel } from "./transcript-compaction";
import type {
  WorkflowDraftProgressEvent,
  WorkflowStudioArtifact,
  WorkflowStudioMessage,
} from "./types";
import { WORKFLOW_DRAFT_PROGRESS_LABELS } from "./types";
import { validateWorkflowArtifact } from "./validate";

const messageSchema = z.object({
  id: z.string().optional(),
  role: z.string(),
  content: z.string().optional(),
  createdAt: z.string().optional(),
  parts: z.array(z.any()).optional(),
  toolInvocations: z.array(z.any()).optional(),
  annotations: z.array(z.any()).optional(),
});

const routeRequestSchema = z.object({
  messages: z.array(messageSchema).default([]),
  currentArtifact: z.any().nullable().optional(),
});

function createContextMessage(content: string): WorkflowStudioMessage {
  return {
    id: `workflow_agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    role: "system",
    content,
    createdAt: new Date().toISOString(),
  };
}

async function resolveModel() {
  return createConfiguredLanguageModel();
}

function withTranscript(
  artifact: WorkflowStudioArtifact | null,
  messages: WorkflowStudioMessage[]
): WorkflowStudioArtifact | null {
  if (!artifact) {
    return null;
  }

  return {
    ...artifact,
    messages,
  };
}

function hasMeaningfulDraft(
  artifact: WorkflowStudioArtifact | null | undefined
): artifact is WorkflowStudioArtifact {
  if (!artifact) {
    return false;
  }

  return Boolean(
    artifact.code.trim() ||
      artifact.requiredAccesses.length > 0 ||
      artifact.writeCheckpoints.length > 0 ||
      artifact.bindings?.length ||
      artifact.deploy ||
      artifact.triggerConfig ||
      artifact.validation ||
      artifact.preview ||
      artifact.build
  );
}

function writeWorkflowDraftProgress(
  dataStream: DataStreamWriter,
  toolCallId: string,
  update: Omit<
    WorkflowDraftProgressEvent,
    "type" | "toolCallId" | "timestamp" | "label"
  >
) {
  dataStream.writeData({
    type: "workflow-draft-progress",
    toolCallId,
    label: WORKFLOW_DRAFT_PROGRESS_LABELS[update.stage],
    timestamp: new Date().toISOString(),
    ...update,
  } satisfies WorkflowDraftProgressEvent);
}

function summarizeDraft(artifact: WorkflowStudioArtifact | null) {
  if (!artifact) {
    return {
      hasDraft: false,
      message: "No workflow draft exists yet.",
    };
  }

  return {
    hasDraft: true,
    slug: artifact.slug,
    title: artifact.title,
    summary: artifact.summary,
    requiredAccesses: artifact.requiredAccesses,
    writeCheckpoints: artifact.writeCheckpoints,
    validation: artifact.validation,
    preview: artifact.preview,
    code: artifact.code,
    mermaid: artifact.mermaid,
    samplePayload: artifact.samplePayload,
    deploy: artifact.deploy,
    triggerConfig: artifact.triggerConfig,
    bindings: artifact.bindings,
    deploymentPlan: artifact.deploymentPlan,
    build: artifact.build,
  };
}

const SYSTEM_PROMPT = `You are GTMShip's Workflow Agent.
You behave like an agentic workflow builder during design time: you can inspect integrations, read docs, run sandboxed commands, validate drafts, preview them, build deployable artifacts, diagnose failures, and revise the workflow code in chat.

Your capabilities:
- List and test active integrations.
- Read provider schema, docs URLs, and test metadata for active integrations.
- Research the web for documentation when needed.
- Execute sandboxed commands in a scratch workspace using curl, python3, node, jq, rg, grep, sed, head, tail, ls, pwd, cat, base64, and which.
- Read and search files under the configured project root through dedicated tools.
- Generate or revise the workflow draft.
- Validate and preview the draft.
- Build the workflow into a deployable artifact.

Critical behavior:
1. Treat this as an agentic workflow design/debug session, not a one-shot generator.
2. When integrations are involved, inspect active connections early and read the provider reference before searching the open web.
3. API Grounding — Before calling generateWorkflowDraft, ground every API endpoint the workflow will use:
   a. Call readIntegrationReference for each provider to get metadata, docsUrl, and connection status.
   b. Call fetchOpenApiSpec with the provider slug and a query describing the endpoints you need.
      - If it returns structured endpoint definitions, use those directly as grounded context.
      - The response includes exact paths, methods, parameters, request bodies, and response schemas from the provider's published OpenAPI spec.
      - If the provider has multiple sub-APIs (e.g. HubSpot CRM vs Marketing), check the availableSubApis field and make a follow-up call with the specific sub-API's specUrl if needed.
   c. If fetchOpenApiSpec returns an error or no matching endpoints (provider has no published OpenAPI spec):
      - Fall back to researchWeb with mode="research" and a targeted query like "<provider> <endpoint> API reference".
      - If the auto-selected page is not useful, call researchWeb with mode="scrape" on a better result URL.
      - Extract the exact endpoint path, HTTP method, required request fields, and expected response shape.
   d. For READ endpoints covered by the OpenAPI spec: optionally verify one key endpoint with curl through the auth proxy to confirm the spec matches reality:
      curl -s http://localhost:4000/proxy/<provider-slug>/v1/endpoint --max-time 10
      Do NOT use -o, pipes (|), chaining (&&), or redirection (>). The sandbox runs execFile, not a shell. Each curl must be a single standalone command. To process output, run a separate executeCommand with jq or python3 on the previous result.
   e. For WRITE endpoints: use the spec's request schema directly — do NOT call them during grounding.
   f. Pass grounded findings in the instructions parameter of generateWorkflowDraft using this format:
      GROUNDED API CONTEXT:
      - <provider>: <METHOD> <path> — <purpose>
        Request: <key fields>
        Response: <key fields observed or documented>
        Tested: <yes/no> Status: <code>
        Docs: <source URL>
   This prevents hallucinated endpoints, wrong field names, and incorrect request formats.
   g. After grounding is complete, use saveMemory to save the key grounded endpoints for each provider (category: "integration", scope: "app"). This avoids re-grounding the same provider in future conversations.
4. If researchWeb returns noUsefulResults or weak matches, try alternative queries (e.g. "<provider> REST API endpoints", "<provider> developer documentation") before falling back to general knowledge. Never fabricate an endpoint path from memory alone when research tools are available.
5. If the user says they configured connections, asks you to recheck connections, or returns from the Connections Agent, call listActiveConnections first, test the relevant providers when possible, and only continue generating/fixing/building after you verify the needed access is ready.
6. Documentation handling should mirror the connection agent:
   - Prefer active integration/provider docs first.
   - If you still need docs, use researchWeb with mode="research".
   - If you already have a concrete public URL, use researchWeb with mode="scrape".
   - Do not guess documentation URLs.
7. The command runner is a single-command sandbox using execFile (NOT a shell). These will NOT work: pipes (|), redirection (> >>), chaining (&& ;), subshells ($(...)), globbing (*). Each executeCommand call runs exactly one command. To test an endpoint: executeCommand('curl -s http://localhost:4000/proxy/gmail/gmail/v1/users/me/profile --max-time 10'). To process output from a previous call, run a separate executeCommand with jq, python3 -c, or node -e.
8. The current draft, if any, is available in the scratch workspace as draft.ts and sample-payload.json.
9. The saved workflow runtime itself MUST stay constrained to WorkflowContext helpers. Do not try to give the saved workflow shell access, child_process, fs, raw fetch, or external imports.
10. Unless the latest user message explicitly asks to build, package, ship, or deploy, stop after generateWorkflowDraft and explain the current draft/preview state. Do not call buildWorkflowDraft on your own.
11. Never pass approved write checkpoints through the chat tools. Users must approve write checkpoints only from the Preview or Build sections of the Workflow Studio UI.
12. If preview returns needs_approval, say so clearly and stop. Do not continue preview approvals or call buildWorkflowDraft automatically after needs_approval.
13. There is no deploy tool in this chat flow. Never say a workflow was deployed, published, or live unless a later tool explicitly confirms a real deployment.
14. If validation, preview, or build exposes a code issue, analyze it and call generateWorkflowDraft again with repair instructions.
15. Intelligent Error Recovery — When preview, validation, or build fails with an API-related error:
    a. Identify which specific API call failed. Check preview operations for non-2xx responseStatus values and error messages referencing endpoints or providers.
    b. Test the failing endpoint in isolation using executeCommand with curl through the auth proxy:
       curl http://localhost:4000/proxy/<provider-slug>/<the-failing-path>
    c. If isolated test returns 404: the endpoint path is wrong. Use researchWeb mode="research" to find the correct path. Update repair instructions with the correct path.
    d. If isolated test returns 401/403: auth expired or scopes insufficient. Report as external blocker — do not rewrite code.
    e. If isolated test returns 400: request format is wrong. Use researchWeb mode="scrape" on the provider's API docs for that endpoint. Extract the correct request schema.
    f. If isolated test succeeds but workflow still fails: the issue is in code logic (wrong field access, missing data transform). Include the actual response shape from the test in repair instructions.
    g. Call generateWorkflowDraft with detailed repair instructions including test results and documentation findings.
    Never retry generateWorkflowDraft with the same information. Always add new evidence from isolated testing or documentation research.
16. If the issue is external, such as missing access or invalid credentials, explain that clearly and stop rewriting code.
17. If connections are still missing or blocked after a recheck, stop and summarize exactly which providers are still not ready.
18. Do not remove or weaken legitimate write checkpoints just to avoid preview-only approvals. Workflow Studio preview can require multiple sequential approvals in the UI.
19. If any tool returns an error, treat that step as failed. Do not say the workflow is done or describe changes as completed unless a later tool result confirms success.
20. A generateWorkflowDraft error means the draft was not updated. Retry with clearer repair instructions or explain the failure.
21. Memory usage:
    a. At the start of every conversation, call recallMemories with scope "all" and relevant provider names to load both app-level and this workflow's prior context.
    b. After successfully grounding API endpoints, save provider-level knowledge (base URL, auth type, API quirks) as scope "app" — it's reusable across workflows. Save workflow-specific endpoint usage (which endpoints THIS workflow calls, field mappings) as scope "workflow".
    c. After a successful build/preview, save the working approach as scope "workflow" — these details are specific to this workflow and should not leak into other workflows.
    d. After the user confirms a requirement, save as scope "app" if it applies broadly (business rules, preferences) or scope "workflow" if it's specific to this workflow's behavior.
    e. Workflow memories are ISOLATED — they are only visible when the user is working on this same workflow. App memories are shared everywhere.

Be concise, but show your work through tools and short reasoning updates in the chat.${MEMORY_SYSTEM_PROMPT_ADDITION}`;

export async function createWorkflowAgentResponse(
  rawBody: unknown
): Promise<Response> {
  const body = routeRequestSchema.parse(rawBody);
  const requestMessages = body.messages as WorkflowStudioMessage[];
  const userExplicitlyRequestedBuild = didUserExplicitlyRequestBuild(
    requestMessages
  );

  let draft =
    body.currentArtifact && typeof body.currentArtifact === "object"
      ? (body.currentArtifact as WorkflowStudioArtifact)
      : null;

  if (!hasMeaningfulDraft(draft)) {
    draft = null;
  }

  const model = await resolveModel();
  const compactedTranscript = await compactWorkflowTranscriptIfNeeded({
    messages: requestMessages,
    currentArtifact: draft,
    additionalText: SYSTEM_PROMPT,
    resolvedModel: model,
  });
  const modelRequestMessages = normalizeWorkflowMessagesForModel(
    compactedTranscript.messages
  );
  if (
    modelRequestMessages.length === 0 ||
    modelRequestMessages[modelRequestMessages.length - 1]?.role !== "user"
  ) {
    throw new Error(
      "Workflow Studio needs a fresh user message before it can continue the AI chat."
    );
  }

  const memoryContext = await fetchMemoryContext(draft?.slug);

  const contextManager = new ContextManager({
    tokenBudget: COORDINATOR_TOKEN_BUDGET,
  });
  const managed = contextManager.manage(modelRequestMessages);
  const transcriptMessages = managed.messages;

  return createDataStreamResponse({
    execute(dataStream) {
      dataStream.writeData({ ...managed.pressure });

      const result = streamText({
        model,
        maxSteps: 30,
        system: SYSTEM_PROMPT + memoryContext,
        messages: managed.messages as never,
        tools: {
      saveMemory: createSaveMemoryTool({ source: "workflow", workflowId: draft?.slug }),
      recallMemories: createRecallMemoriesTool({ workflowId: draft?.slug }),

      listActiveConnections: tool({
        description:
          "List the active integrations available right now. Use this early when the workflow depends on integrations.",
        parameters: z.object({}),
        execute: async () => {
          const connections = await listActiveConnections();
          return { connections };
        },
      }),

      testActiveConnection: tool({
        description:
          "Test an active integration connection by provider slug or connection id.",
        parameters: z.object({
          providerSlug: z.string().optional(),
          connectionId: z.string().optional(),
        }),
        execute: async ({ providerSlug, connectionId }) => {
          let targetConnectionId = connectionId;

          if (!targetConnectionId && providerSlug) {
            const connections = await listActiveConnections();
            targetConnectionId =
              connections.find(
                (connection) => connection.provider.slug === providerSlug
              )?.id || undefined;
          }

          if (!targetConnectionId) {
            return {
              error:
                "No matching active connection found for that provider or connection id.",
            };
          }

          return testConnection(targetConnectionId);
        },
      }),

      readIntegrationReference: tool({
        description:
          "Read the saved provider reference for an active integration, including docsUrl, test endpoint, API schema, and connection metadata.",
        parameters: z.object({
          providerSlug: z.string(),
        }),
        execute: async ({ providerSlug }) => {
          const provider = await getProviderDetail(providerSlug);
          if (!provider) {
            return {
              error: `Provider "${providerSlug}" was not found.`,
            };
          }

          return provider;
        },
      }),

      fetchOpenApiSpec: tool({
        description:
          "Fetch and search the published OpenAPI specification for a provider. Returns structured endpoint definitions with paths, parameters, request bodies, and response schemas from APIs.guru or the provider's stored spec URL. Use this for API grounding before generating workflow code — more comprehensive than readIntegrationReference's apiSchema.",
        parameters: z.object({
          providerSlug: z.string().describe("Provider slug to fetch the spec for"),
          query: z.string().optional().describe("Filter endpoints by keyword (e.g., 'contacts', 'create deal', 'send message')"),
          maxEndpoints: z.number().int().min(1).max(50).optional().describe("Max endpoints to return. Default 15."),
          specUrl: z.string().optional().describe("Direct URL to a specific sub-API spec. Use this when availableSubApis indicates multiple specs and you need a specific one."),
        }),
        execute: async ({ providerSlug, query, maxEndpoints, specUrl }) => {
          // If no explicit specUrl, try to get it from the stored provider record
          let resolvedSpecUrl = specUrl;
          if (!resolvedSpecUrl) {
            const provider = await getProviderDetail(providerSlug);
            resolvedSpecUrl = provider?.openApiSpecUrl ?? undefined;
          }

          const result = await fetchAndFilterOpenApiSpec({
            specUrl: resolvedSpecUrl,
            providerSlug,
            query,
            maxEndpoints,
          });

          return truncateToolResult(result, contextManager.getToolResultLimit());
        },
      }),

      researchWeb: tool({
        description:
          "Search the web and optionally inspect a public page in one tool call. Use this only after checking active integration/provider references first. Prefer mode='research' for doc discovery and mode='scrape' for a known public URL.",
        parameters: researchWebInputSchema,
        execute: async (input) =>
          truncateToolResult(
            await researchWeb(input),
            contextManager.getToolResultLimit()
          ),
      }),

      searchDocumentation: tool({
        description:
          "Legacy wrapper around researchWeb search mode. Prefer researchWeb for new calls.",
        parameters: z.object({
          query: z.string(),
          maxResults: z.number().min(1).max(10).optional(),
        }),
        execute: async ({ query, maxResults }) =>
          truncateToolResult(
            await searchDocumentation(query, maxResults),
            contextManager.getToolResultLimit()
          ),
      }),

      fetchUrl: tool({
        description:
          "Legacy wrapper around the shared web scraping core. Prefer researchWeb in scrape mode for new calls.",
        parameters: z.object({
          url: z.string(),
          method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional(),
          headers: z.record(z.string()).optional(),
        }),
        execute: async ({ url, method, headers }) =>
          truncateToolResult(
            await fetchUrl(url, { method, headers }),
            contextManager.getToolResultLimit()
          ),
      }),

      executeCommand: tool({
        description:
          "Run a single sandboxed command in the scratch workspace. Use this for curl (including testing API endpoints through the auth proxy at localhost:4000/proxy/<provider>/<path>), rg, grep, jq, python3, node, and related debugging commands. No pipes or redirection.",
        parameters: z.object({
          command: z.string(),
        }),
        execute: async ({ command }) => {
          const workspace = await prepareWorkflowScratchWorkspace(draft);
          const execution = await executeCommand(command, {
            cwd: workspace.workspacePath,
          });

          return truncateToolResult(
            { workspacePath: workspace.workspacePath, ...execution },
            contextManager.getToolResultLimit()
          );
        },
      }),

      searchProjectFiles: tool({
        description:
          "Search files under the configured project root for documentation, examples, or references.",
        parameters: z.object({
          query: z.string(),
          glob: z.string().optional(),
          maxResults: z.number().min(1).max(20).optional(),
        }),
        execute: async ({ query, glob, maxResults }) =>
          truncateToolResult(
            await searchProjectFiles({ query, glob, maxResults }),
            contextManager.getToolResultLimit()
          ),
      }),

      readProjectFile: tool({
        description:
          "Read a file under the configured project root by relative path.",
        parameters: z.object({
          path: z.string(),
        }),
        execute: async ({ path: targetPath }) =>
          truncateToolResult(
            await readProjectFile(targetPath),
            contextManager.getToolResultLimit()
          ),
      }),

      getCurrentDraft: tool({
        description:
          "Read the current workflow draft, including code, mermaid, validation, and preview state.",
        parameters: z.object({}),
        execute: async () => summarizeDraft(draft),
      }),

      generateWorkflowDraft: tool({
        description:
          "Generate or revise the workflow draft. Before calling this, ensure you have grounded all API endpoints by reading integration references, researching documentation, and testing READ endpoints. Pass grounded API findings in the instructions parameter using the GROUNDED API CONTEXT format.",
        parameters: z.object({
          instructions: z
            .string()
            .optional()
            .describe(
              "Optional extra instructions, findings, or repair notes to incorporate."
            ),
        }),
        execute: async ({ instructions }, { toolCallId }) => {
          try {
            const groundedApiContext = instructions
              ? parseGroundedApiContext(instructions)
              : undefined;

            const draftMessages = instructions?.trim()
              ? [
                  ...transcriptMessages,
                  createContextMessage(
                    `Workflow agent notes for this draft revision:\n${instructions.trim()}`
                  ),
                ]
              : transcriptMessages;

            const generated = await generateWorkflowArtifact({
              messages: draftMessages,
              currentArtifact: draft,
              resolvedModel: model,
              groundedApiContext,
              onProgress(update) {
                writeWorkflowDraftProgress(dataStream, toolCallId, update);
              },
            });

            if (generated.artifact) {
              draft = withTranscript(generated.artifact, requestMessages);
            }

            return {
              assistantMessage: generated.assistantMessage,
              artifact: withTranscript(
                generated.artifact || draft,
                requestMessages
              ),
              blockedAccesses: generated.blockedAccesses || [],
            };
          } catch (error) {
            const hasDraft = hasMeaningfulDraft(draft);
            return {
              error:
                error instanceof Error
                  ? error.message
                  : "Workflow generation failed.",
              hasDraft,
              message: hasDraft
                ? "The previous draft is still available, but this generation attempt did not update it. Use getCurrentDraft if you need to inspect it before retrying."
                : "No draft was created from this generation attempt.",
            };
          }
        },
      }),

      validateWorkflowDraft: tool({
        description:
          "Validate the current workflow draft and return the structured validation report.",
        parameters: z.object({}),
        execute: async () => {
          try {
            if (!draft) {
              return { error: "No draft exists yet. Generate the workflow first." };
            }

            const validation = validateWorkflowArtifact({
              slug: draft.slug,
              code: draft.code,
              writeCheckpoints: draft.writeCheckpoints,
            });

            draft = {
              ...draft,
              validation,
            };

            return {
              validation,
              artifact: withTranscript(draft, requestMessages),
            };
          } catch (error) {
            return {
              error:
                error instanceof Error
                  ? error.message
                  : "Workflow validation failed.",
              artifact: withTranscript(
                hasMeaningfulDraft(draft) ? draft : null,
                requestMessages
              ),
            };
          }
        },
      }),

      previewWorkflowDraft: tool({
        description:
          "Run preview for the current workflow draft without approving any write checkpoints.",
        parameters: z.object({}),
        execute: async () => {
          try {
            if (!draft) {
              return { error: "No draft exists yet. Generate the workflow first." };
            }

            const preview = await previewWorkflowArtifact(
              {
                slug: draft.slug,
                code: draft.code,
                samplePayload: draft.samplePayload,
              },
              []
            );

            if (preview.status === "error") {
              console.error("[agent:preview] Preview returned error:", preview.error);
            } else {
              console.log(
                `[agent:preview] status=${preview.status} ops=${preview.operations.length}` +
                  (preview.pendingApproval
                    ? ` pending=${preview.pendingApproval.checkpoint}`
                    : "")
              );
            }

            draft = {
              ...draft,
              preview,
            };

            return {
              preview,
              assistantMessage: formatPreviewStatusMessage(preview),
              artifact: withTranscript(draft, requestMessages),
            };
          } catch (error) {
            console.error("[agent:preview] Unhandled exception:", error);
            return {
              error:
                error instanceof Error
                  ? error.message
                  : "Workflow preview failed.",
              artifact: withTranscript(
                hasMeaningfulDraft(draft) ? draft : null,
                requestMessages
              ),
            };
          }
        },
      }),

      buildWorkflowDraft: tool({
        description:
          "Run the full build workflow for the current draft when the user has explicitly asked to build or package it.",
        parameters: z.object({}),
        execute: async () => {
          try {
            if (!draft) {
              return { error: "No draft exists yet. Generate the workflow first." };
            }

            if (!userExplicitlyRequestedBuild) {
              const approvalSuffix =
                draft.preview?.status === "needs_approval"
                  ? ` Preview is still waiting for approval at checkpoint "${draft.preview.pendingApproval?.checkpoint || "unknown"}" in the Preview section.`
                  : "";

              return {
                skipped: true,
                assistantMessage:
                  "Build not started. The agent only runs builds when the user explicitly asks for one. Use the Build tab or ask me to build/package the workflow." +
                  approvalSuffix,
                artifact: withTranscript(draft, requestMessages),
              };
            }

            const defaults = await loadProjectDeploymentDefaults();
            const build = await buildWorkflowArtifact({
              artifact: draft,
              defaults,
            });

            draft = {
              ...draft,
              deploymentPlan: buildWorkflowPlanFromArtifact(draft, defaults),
              validation: build.validation || draft.validation,
              preview: build.preview || draft.preview,
              build,
            };

            return {
              build,
              assistantMessage: formatBuildStatusMessage(build),
              artifact: withTranscript(draft, requestMessages),
            };
          } catch (error) {
            return {
              error:
                error instanceof Error
                  ? error.message
                  : "Workflow build failed.",
              artifact: withTranscript(
                hasMeaningfulDraft(draft) ? draft : null,
                requestMessages
              ),
            };
          }
        },
      }),
    },
      });

      result.mergeIntoDataStream(dataStream);
    },
    onError(error) {
      return error instanceof Error
        ? error.message
        : "Workflow agent execution failed.";
    },
  });
}
