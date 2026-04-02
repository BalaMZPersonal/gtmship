import { streamText, tool } from "ai";
import { z } from "zod";
import { createConfiguredLanguageModel } from "@/lib/ai-settings";
import { executeCommand } from "@/lib/sandbox";
import { fetchUrl } from "@/lib/url-fetcher";
import { searchDocumentation } from "@/lib/doc-search";
import {
  generateWorkflowArtifact,
} from "./ai";
import { buildWorkflowArtifact } from "./build";
import { buildWorkflowPlanFromArtifact } from "./deploy-plan";
import {
  getProviderDetail,
  listActiveConnections,
  testConnection,
} from "./auth-service";
import { previewWorkflowArtifact } from "./preview";
import { loadProjectDeploymentDefaults } from "./project-config";
import { readProjectFile, searchProjectFiles, prepareWorkflowScratchWorkspace } from "./project-docs";
import type { WorkflowStudioArtifact, WorkflowStudioMessage } from "./types";
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

function normalizeConversationMessages(
  messages: WorkflowStudioMessage[]
): WorkflowStudioMessage[] {
  return messages
    .map((message) => ({
      id: message.id,
      role:
        message.role === "user" ||
        message.role === "assistant" ||
        message.role === "system"
          ? message.role
          : "assistant",
      content: getMessageText(message),
      createdAt: message.createdAt,
    }))
    .filter((message) => message.content.trim().length > 0);
}

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
- Search the web for documentation when needed.
- Fetch and read documentation URLs.
- Execute sandboxed commands in a scratch workspace using curl, python3, node, jq, rg, grep, sed, head, tail, ls, pwd, cat, base64, and which.
- Read and search files under the configured project root through dedicated tools.
- Generate or revise the workflow draft.
- Validate and preview the draft.
- Build the workflow into a deployable artifact.

Critical behavior:
1. Treat this as an agentic workflow design/debug session, not a one-shot generator.
2. When integrations are involved, inspect active connections early and read the provider reference before searching the open web.
3. Documentation handling should mirror the connection agent:
   - Prefer active integration/provider docs first.
   - If you still need docs, use searchDocumentation, then fetchUrl on the best result.
   - Do not guess documentation URLs.
4. The command runner is a single-command sandbox in a scratch workspace. No shell pipes or redirection. If you need transformations, use jq, python3 -c, or node -e inline.
5. The current draft, if any, is available in the scratch workspace as draft.ts and sample-payload.json.
6. The saved workflow runtime itself MUST stay constrained to WorkflowContext helpers. Do not try to give the saved workflow shell access, child_process, fs, raw fetch, or external imports.
7. Before your final answer, you must either:
   - produce a ready draft by calling generateWorkflowDraft, validateWorkflowDraft, previewWorkflowDraft, and buildWorkflowDraft when the user asks to finish, ship, or build the workflow, or
   - clearly explain the blocker after verifying it with tools.
8. If validation, preview, or build exposes a code issue, analyze it and call generateWorkflowDraft again with repair instructions.
9. If the issue is external, such as missing access or invalid credentials, explain that clearly and stop rewriting code.
10. A preview result of needs_approval is considered ready if the only remaining step is the declared write checkpoint approval.

Be concise, but show your work through tools and short reasoning updates in the chat.`;

export async function createWorkflowAgentResponse(
  rawBody: unknown
): Promise<Response> {
  const body = routeRequestSchema.parse(rawBody);
  const requestMessages = body.messages as WorkflowStudioMessage[];
  const transcriptMessages = normalizeConversationMessages(requestMessages);
  const model = await resolveModel();

  let draft =
    body.currentArtifact && typeof body.currentArtifact === "object"
      ? (body.currentArtifact as WorkflowStudioArtifact)
      : null;

  if (!hasMeaningfulDraft(draft)) {
    draft = null;
  }

  const result = streamText({
    model,
    maxSteps: 30,
    system: SYSTEM_PROMPT,
    messages: requestMessages as never,
    tools: {
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

      searchDocumentation: tool({
        description:
          "Search the web for API documentation pages. Use this only after checking active integration/provider references first.",
        parameters: z.object({
          query: z.string(),
          maxResults: z.number().min(1).max(10).optional(),
        }),
        execute: async ({ query, maxResults }) =>
          searchDocumentation(query, maxResults),
      }),

      fetchUrl: tool({
        description:
          "Fetch a public URL to read documentation or inspect a public HTTP endpoint.",
        parameters: z.object({
          url: z.string(),
          method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional(),
          headers: z.record(z.string()).optional(),
        }),
        execute: async ({ url, method, headers }) =>
          fetchUrl(url, { method, headers }),
      }),

      executeCommand: tool({
        description:
          "Run a single sandboxed command in the scratch workspace. Use this for curl, rg, grep, jq, python3, node, and related debugging commands. No pipes or redirection.",
        parameters: z.object({
          command: z.string(),
        }),
        execute: async ({ command }) => {
          const workspace = await prepareWorkflowScratchWorkspace(draft);
          const execution = await executeCommand(command, {
            cwd: workspace.workspacePath,
          });

          return {
            workspacePath: workspace.workspacePath,
            ...execution,
          };
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
          searchProjectFiles({ query, glob, maxResults }),
      }),

      readProjectFile: tool({
        description:
          "Read a file under the configured project root by relative path.",
        parameters: z.object({
          path: z.string(),
        }),
        execute: async ({ path: targetPath }) => readProjectFile(targetPath),
      }),

      getCurrentDraft: tool({
        description:
          "Read the current workflow draft, including code, mermaid, validation, and preview state.",
        parameters: z.object({}),
        execute: async () => summarizeDraft(draft),
      }),

      generateWorkflowDraft: tool({
        description:
          "Generate or revise the workflow draft. Use this after you have enough context or after you diagnose a draft issue.",
        parameters: z.object({
          instructions: z
            .string()
            .optional()
            .describe(
              "Optional extra instructions, findings, or repair notes to incorporate."
            ),
        }),
        execute: async ({ instructions }) => {
          try {
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
            return {
              error:
                error instanceof Error
                  ? error.message
                  : "Workflow generation failed.",
              artifact: withTranscript(
                hasMeaningfulDraft(draft) ? draft : null,
                requestMessages
              ),
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
          "Run preview for the current workflow draft with optional approved write checkpoints.",
        parameters: z.object({
          approvedCheckpoints: z.array(z.string()).optional(),
        }),
        execute: async ({ approvedCheckpoints }) => {
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
              approvedCheckpoints || []
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
          "Run the full build workflow for the current draft: validation, preview, bundling, and packaging.",
        parameters: z.object({
          approvedCheckpoints: z.array(z.string()).optional(),
        }),
        execute: async ({ approvedCheckpoints }) => {
          try {
            if (!draft) {
              return { error: "No draft exists yet. Generate the workflow first." };
            }

            const defaults = await loadProjectDeploymentDefaults();
            const build = await buildWorkflowArtifact({
              artifact: draft,
              approvedCheckpoints: approvedCheckpoints || [],
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

  return result.toDataStreamResponse({
    getErrorMessage(error) {
      return error instanceof Error
        ? error.message
        : "Workflow agent execution failed.";
    },
  });
}
