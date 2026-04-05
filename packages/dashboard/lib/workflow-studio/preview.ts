import { AUTH_URL } from "./auth-service";
import { loadWorkflowDefinitionFromSource } from "./runtime";
import { inspect } from "node:util";
import type {
  WorkflowPendingApproval,
  WorkflowPreviewLogEntry,
  WorkflowPreviewLogLevel,
  WorkflowPreviewOperation,
  WorkflowPreviewResult,
  WorkflowStudioArtifact,
} from "./types";

interface LegacyAuthClient {
  get: <T = unknown>(
    path: string,
    config?: RequestInit
  ) => Promise<{ data: T; status: number }>;
  post: <T = unknown>(
    path: string,
    data?: unknown,
    config?: RequestInit
  ) => Promise<{ data: T; status: number }>;
  put: <T = unknown>(
    path: string,
    data?: unknown,
    config?: RequestInit
  ) => Promise<{ data: T; status: number }>;
  patch: <T = unknown>(
    path: string,
    data?: unknown,
    config?: RequestInit
  ) => Promise<{ data: T; status: number }>;
  delete: <T = unknown>(
    path: string,
    config?: RequestInit
  ) => Promise<{ data: T; status: number }>;
}

type WorkflowAiProviderSlug = "openai" | "anthropic";
type WorkflowAiResponseFormat = "text" | "json" | "raw";

interface WorkflowAiGenerateInput {
  providerSlug: WorkflowAiProviderSlug;
  model: string;
  system?: string;
  prompt?: string;
  input?: unknown;
  responseFormat?: WorkflowAiResponseFormat;
  temperature?: number;
  maxOutputTokens?: number;
}

interface WorkflowAiGenerateResult<TJson = unknown> {
  providerSlug: WorkflowAiProviderSlug;
  model: string;
  status: number;
  text: string | null;
  json: TJson | null;
  raw: unknown;
  usage?: Record<string, unknown> | null;
  stopReason?: string | null;
}

const BLOCKED_HOSTS = [
  /^localhost$/,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^\[::1\]/,
];

const MAX_PREVIEW_LOG_ENTRIES = 120;
const MAX_PREVIEW_LOG_TOTAL_CHARS = 16_000;
const MAX_PREVIEW_LOG_MESSAGE_CHARS = 2_000;

class PreviewApprovalError extends Error {
  pendingApproval: WorkflowPendingApproval;

  constructor(pendingApproval: WorkflowPendingApproval) {
    super(`Approval required for checkpoint ${pendingApproval.checkpoint}`);
    this.pendingApproval = pendingApproval;
  }
}

function isBlockedHost(hostname: string): boolean {
  return BLOCKED_HOSTS.some((pattern) => pattern.test(hostname));
}

function trimPreviewLogMessage(
  value: string,
  maxChars = MAX_PREVIEW_LOG_MESSAGE_CHARS
): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}\n... (log truncated)`;
}

function formatPreviewLogValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value instanceof Error) {
    return value.stack || value.message;
  }

  return inspect(value, {
    depth: 5,
    breakLength: 100,
    maxArrayLength: 40,
    maxStringLength: 2_000,
  });
}

function createPreviewLogCapture(): {
  logs: WorkflowPreviewLogEntry[];
  console: typeof console;
  appendLog: (level: WorkflowPreviewLogLevel, ...args: unknown[]) => void;
} {
  const logs: WorkflowPreviewLogEntry[] = [];
  let nextLogId = 1;
  let totalChars = 0;
  let limitReached = false;

  const appendNotice = () => {
    if (logs.some((entry) => entry.message.includes("Additional preview logs were truncated"))) {
      return;
    }

    logs.push({
      id: `preview_log_${nextLogId++}`,
      level: "warn",
      timestamp: new Date().toISOString(),
      message: "Additional preview logs were truncated to keep preview responsive.",
    });
  };

  const appendLog = (level: WorkflowPreviewLogLevel, ...args: unknown[]) => {
    if (limitReached) {
      return;
    }

    const message = trimPreviewLogMessage(
      args.length > 0
        ? args.map((value) => formatPreviewLogValue(value)).join(" ")
        : "(empty log entry)"
    );

    const nextTotalChars = totalChars + message.length;
    if (
      logs.length >= MAX_PREVIEW_LOG_ENTRIES ||
      nextTotalChars > MAX_PREVIEW_LOG_TOTAL_CHARS
    ) {
      limitReached = true;
      appendNotice();
      return;
    }

    logs.push({
      id: `preview_log_${nextLogId++}`,
      level,
      timestamp: new Date().toISOString(),
      message,
    });
    totalChars = nextTotalChars;
  };

  const previewConsole = Object.create(console) as typeof console;
  previewConsole.log = (...args: unknown[]) => appendLog("log", ...args);
  previewConsole.info = (...args: unknown[]) => appendLog("info", ...args);
  previewConsole.warn = (...args: unknown[]) => appendLog("warn", ...args);
  previewConsole.error = (...args: unknown[]) => appendLog("error", ...args);
  previewConsole.debug = (...args: unknown[]) => appendLog("debug", ...args);
  previewConsole.trace = (...args: unknown[]) => appendLog("debug", ...args);

  return {
    logs,
    console: previewConsole,
    appendLog,
  };
}

async function parseResponseData(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") || "";

  if (response.status === 204) {
    return null;
  }

  if (contentType.includes("application/json")) {
    return response.json();
  }

  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function stringifyInput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined) {
    return "";
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function buildAiUserPrompt(input: WorkflowAiGenerateInput): string {
  const sections: string[] = [];

  if (input.prompt?.trim()) {
    sections.push(input.prompt.trim());
  }

  const serializedInput = stringifyInput(input.input).trim();
  if (serializedInput) {
    sections.push(
      sections.length > 0
        ? ["Input data:", serializedInput].join("\n")
        : serializedInput
    );
  }

  if (sections.length === 0) {
    throw new Error("ctx.ai.generate requires prompt or input.");
  }

  return sections.join("\n\n");
}

function buildAiSystemPrompt(input: WorkflowAiGenerateInput): string | undefined {
  const instructions: string[] = [];

  if (input.system?.trim()) {
    instructions.push(input.system.trim());
  }

  if (input.responseFormat === "json") {
    instructions.push("Return only valid JSON. Do not include markdown fences.");
  }

  return instructions.length > 0 ? instructions.join("\n\n") : undefined;
}

function isWorkflowAiProviderSlug(
  value: string
): value is WorkflowAiProviderSlug {
  return value === "openai" || value === "anthropic";
}

function normalizeWorkflowAiResponseFormat(
  value?: WorkflowAiResponseFormat
): WorkflowAiResponseFormat {
  if (value === "json" || value === "raw") {
    return value;
  }

  return "text";
}

function buildWorkflowAiRequest(input: WorkflowAiGenerateInput): {
  path: string;
  body: Record<string, unknown>;
} {
  const model = input.model.trim();
  if (!model) {
    throw new Error("ctx.ai.generate requires a model.");
  }

  const system = buildAiSystemPrompt(input);
  const prompt = buildAiUserPrompt(input);

  if (input.providerSlug === "anthropic") {
    return {
      path: "/v1/messages",
      body: {
        model,
        max_tokens: input.maxOutputTokens || 1024,
        ...(typeof input.temperature === "number"
          ? { temperature: input.temperature }
          : {}),
        ...(system ? { system } : {}),
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
      },
    };
  }

  return {
    path: "/v1/chat/completions",
    body: {
      model,
      ...(typeof input.temperature === "number"
        ? { temperature: input.temperature }
        : {}),
      ...(typeof input.maxOutputTokens === "number"
        ? { max_tokens: input.maxOutputTokens }
        : {}),
      messages: [
        ...(system
          ? [
              {
                role: "system",
                content: system,
              },
            ]
          : []),
        {
          role: "user",
          content: prompt,
        },
      ],
      ...(input.responseFormat === "json"
        ? { response_format: { type: "json_object" } }
        : {}),
    },
  };
}

function extractOpenAiText(payload: unknown): string {
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const choices = Array.isArray(record.choices)
    ? (record.choices as Array<Record<string, unknown>>)
    : [];
  const message =
    choices[0] &&
    typeof choices[0].message === "object" &&
    choices[0].message !== null
      ? (choices[0].message as Record<string, unknown>)
      : null;
  const content = message?.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((entry) =>
        entry && typeof entry === "object" && "text" in entry
          ? String((entry as { text?: unknown }).text || "")
          : ""
      )
      .join("")
      .trim();
  }

  return "";
}

function extractAnthropicText(payload: unknown): string {
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const content = Array.isArray(record.content)
    ? (record.content as Array<Record<string, unknown>>)
    : [];

  return content
    .map((entry) =>
      entry?.type === "text" && typeof entry.text === "string" ? entry.text : ""
    )
    .join("")
    .trim();
}

function extractUsage(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const usage = (payload as { usage?: unknown }).usage;
  return usage && typeof usage === "object" && !Array.isArray(usage)
    ? (usage as Record<string, unknown>)
    : null;
}

function extractStopReason(
  payload: unknown,
  providerSlug: WorkflowAiProviderSlug
) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  if (providerSlug === "anthropic") {
    return typeof (payload as { stop_reason?: unknown }).stop_reason === "string"
      ? ((payload as { stop_reason?: string }).stop_reason as string)
      : null;
  }

  const choices = Array.isArray((payload as { choices?: unknown }).choices)
    ? ((payload as { choices: Array<Record<string, unknown>> }).choices as Array<
        Record<string, unknown>
      >)
    : [];

  return typeof choices[0]?.finish_reason === "string"
    ? (choices[0].finish_reason as string)
    : null;
}

function parseWorkflowAiResponse<TJson = unknown>(input: {
  providerSlug: WorkflowAiProviderSlug;
  model: string;
  status: number;
  responseFormat?: WorkflowAiResponseFormat;
  raw: unknown;
}): WorkflowAiGenerateResult<TJson> {
  const responseFormat = normalizeWorkflowAiResponseFormat(input.responseFormat);
  const text =
    input.providerSlug === "anthropic"
      ? extractAnthropicText(input.raw)
      : extractOpenAiText(input.raw);

  let json: TJson | null = null;
  if (responseFormat === "json") {
    try {
      json = JSON.parse(text) as TJson;
    } catch (error) {
      throw new Error(
        `AI response from ${input.providerSlug} was not valid JSON: ${
          error instanceof Error ? error.message : "unknown parse error"
        }`
      );
    }
  }

  return {
    providerSlug: input.providerSlug,
    model: input.model.trim(),
    status: input.status,
    text: text || null,
    json,
    raw: input.raw,
    usage: extractUsage(input.raw),
    stopReason: extractStopReason(input.raw, input.providerSlug),
  };
}

function createLegacyAuthClient(): {
  getClient(providerSlug: string): Promise<LegacyAuthClient>;
  getToken(providerSlug: string): Promise<string>;
} {
  return {
    async getClient(providerSlug: string): Promise<LegacyAuthClient> {
      const request = async <T>(
        method: string,
        path: string,
        body?: unknown
      ) => {
        const response = await fetch(`${AUTH_URL}/proxy/${providerSlug}${path}`, {
          method,
          headers: {
            "Content-Type": "application/json",
          },
          body:
            body === undefined || method === "GET" || method === "HEAD"
              ? undefined
              : JSON.stringify(body),
        });

        return {
          data: (await parseResponseData(response)) as T,
          status: response.status,
        };
      };

      return {
        get: (path, config) => request("GET", path, undefined),
        post: (path, data) => request("POST", path, data),
        put: (path, data) => request("PUT", path, data),
        patch: (path, data) => request("PATCH", path, data),
        delete: (path) => request("DELETE", path, undefined),
      };
    },
    async getToken(providerSlug: string): Promise<string> {
      const response = await fetch(`${AUTH_URL}/connections/${providerSlug}/token`);
      if (!response.ok) {
        throw new Error(`Failed to load token for ${providerSlug}`);
      }

      const data = (await response.json()) as { access_token: string };
      return data.access_token;
    },
  };
}

function createTrackedContext(
  operations: WorkflowPreviewOperation[],
  approvedCheckpoints: Set<string>
) {
  const pushOperation = (
    operation: WorkflowPreviewOperation
  ) => {
    operations.push(operation);
  };

  const requireApproval = (operation: WorkflowPreviewOperation) => {
    if (operation.mode !== "write") {
      return;
    }

    if (!operation.checkpoint) {
      throw new Error("Write operations must include a checkpoint.");
    }

    if (!approvedCheckpoints.has(operation.checkpoint)) {
      throw new PreviewApprovalError({
        checkpoint: operation.checkpoint,
        description: operation.description,
        target: operation.target,
        method: operation.method,
        source: operation.source,
      });
    }
  };

  const requestWeb = async <T>(
    url: string,
    method: string,
    config: {
      mode: "read" | "write";
      checkpoint?: string;
      description?: string;
      headers?: Record<string, string>;
      body?: unknown;
    }
  ) => {
    const parsedUrl = new URL(url);
    if (isBlockedHost(parsedUrl.hostname)) {
      throw new Error("Workflow Studio blocks private/internal web targets.");
    }

    const operation: WorkflowPreviewOperation = {
      id: `preview_${operations.length + 1}`,
      source: "web",
      target: url,
      url,
      method,
      mode: config.mode,
      checkpoint: config.checkpoint,
      description: config.description,
    };

    pushOperation(operation);
    requireApproval(operation);

    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...config.headers,
      },
      body:
        config.body === undefined || method === "GET" || method === "HEAD"
          ? undefined
          : typeof config.body === "string"
            ? config.body
            : Buffer.isBuffer(config.body)
              ? new Uint8Array(config.body)
              : JSON.stringify(config.body),
    });

    operation.responseStatus = response.status;

    const data = (await parseResponseData(response)) as T;
    try {
      operation.responseBodySnippet = JSON.stringify(data)?.slice(0, 500);
    } catch { /* non-serializable — skip */ }

    return { data, status: response.status };
  };

  return {
    integration: async (providerSlug: string) => {
      const read = async <T = unknown>(
        path: string,
        config?: { method?: "GET" | "HEAD"; description?: string; headers?: Record<string, string> }
      ) => {
        const method = config?.method || "GET";
        const url = `${AUTH_URL}/proxy/${providerSlug}${path}`;
        const operation: WorkflowPreviewOperation = {
          id: `preview_${operations.length + 1}`,
          source: "integration",
          target: providerSlug,
          url,
          method,
          mode: "read",
          description: config?.description,
        };
        pushOperation(operation);
        const response = await fetch(url, {
          method,
          headers: {
            "Content-Type": "application/json",
            ...config?.headers,
          },
        });

        operation.responseStatus = response.status;

        const data = (await parseResponseData(response)) as T;
        try {
          operation.responseBodySnippet = JSON.stringify(data)?.slice(0, 500);
        } catch { /* non-serializable — skip */ }

        return { data, status: response.status };
      };

      return {
        slug: providerSlug,
        get: async <T = unknown>(path: string) => read<T>(path),
        read,
        write: async <T = unknown>(
          path: string,
          config: {
            method: "POST" | "PUT" | "PATCH" | "DELETE";
            checkpoint: string;
            description?: string;
            headers?: Record<string, string>;
            body?: unknown;
          }
        ) => {
          const url = `${AUTH_URL}/proxy/${providerSlug}${path}`;
          const operation: WorkflowPreviewOperation = {
            id: `preview_${operations.length + 1}`,
            source: "integration",
            target: providerSlug,
            url,
            method: config.method,
            mode: "write",
            checkpoint: config.checkpoint,
            description: config.description,
          };
          pushOperation(operation);
          requireApproval(operation);

          const response = await fetch(url, {
            method: config.method,
            headers: {
              "Content-Type": "application/json",
              ...config.headers,
            },
            body:
              config.body === undefined
                ? undefined
                : typeof config.body === "string"
                  ? config.body
                  : Buffer.isBuffer(config.body)
                    ? new Uint8Array(config.body)
                    : JSON.stringify(config.body),
          });

          operation.responseStatus = response.status;

          const data = (await parseResponseData(response)) as T;
          try {
            operation.responseBodySnippet = JSON.stringify(data)?.slice(0, 500);
          } catch { /* non-serializable — skip */ }

          return { data, status: response.status };
        },
      };
    },
    web: {
      read: async <T = unknown>(
        url: string,
        config?: {
          method?: "GET" | "HEAD";
          description?: string;
          headers?: Record<string, string>;
        }
      ) =>
        requestWeb<T>(url, config?.method || "GET", {
          mode: "read",
          description: config?.description,
          headers: config?.headers,
        }),
      write: async <T = unknown>(
        url: string,
        config: {
          method: "POST" | "PUT" | "PATCH" | "DELETE";
          checkpoint: string;
          description?: string;
          headers?: Record<string, string>;
          body?: unknown;
        }
      ) =>
        requestWeb<T>(url, config.method, {
          mode: "write",
          checkpoint: config.checkpoint,
          description: config.description,
          headers: config.headers,
          body: config.body,
        }),
    },
    ai: {
      generate: async <TJson = unknown>(
        input: WorkflowAiGenerateInput
      ): Promise<WorkflowAiGenerateResult<TJson>> => {
        if (!isWorkflowAiProviderSlug(input.providerSlug)) {
          throw new Error(
            `Unsupported workflow AI provider: ${input.providerSlug}`
          );
        }

        const model = input.model.trim();
        const request = buildWorkflowAiRequest(input);
        const url = `${AUTH_URL}/proxy/${input.providerSlug}${request.path}`;
        const operation: WorkflowPreviewOperation = {
          id: `preview_${operations.length + 1}`,
          source: "integration",
          target: input.providerSlug,
          url,
          method: "POST",
          mode: "read",
          description: `AI generation via ${input.providerSlug} (${model})`,
        };
        pushOperation(operation);

        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(request.body),
        });

        operation.responseStatus = response.status;

        const raw = await parseResponseData(response);
        try {
          operation.responseBodySnippet = JSON.stringify(raw)?.slice(0, 500);
        } catch { /* non-serializable — skip */ }

        return parseWorkflowAiResponse<TJson>({
          providerSlug: input.providerSlug,
          model,
          status: response.status,
          responseFormat: input.responseFormat,
          raw,
        });
      },
    },
    requestWriteApproval: async ({
      checkpoint,
      operation,
      reason,
    }: {
      checkpoint: string;
      operation: WorkflowPreviewOperation;
      reason?: string;
    }) => {
      const pendingOperation = {
        ...operation,
        checkpoint,
        description: reason || operation.description,
      };
      requireApproval(pendingOperation);
    },
  };
}

function buildRuntimeSdk(
  operations: WorkflowPreviewOperation[],
  approvedCheckpoints: Set<string>
) {
  return {
    defineWorkflow<T>(config: T): T {
      return config;
    },
    triggers: {
      manual() {
        return { type: "manual" as const };
      },
      webhook(path: string, options?: Record<string, unknown>) {
        return {
          type: "webhook" as const,
          path,
          config: {
            webhook: {
              path,
              ...(options || {}),
            },
          },
        };
      },
      schedule(cron: string, options?: Record<string, unknown>) {
        return {
          type: "schedule" as const,
          cron,
          config: {
            schedule: {
              cron,
              ...(options || {}),
            },
          },
        };
      },
      event(eventName: string, options?: Record<string, unknown>) {
        return {
          type: "event" as const,
          event: eventName,
          config: {
            event: {
              event: eventName,
              ...(options || {}),
            },
          },
        };
      },
    },
    auth: createLegacyAuthClient(),
    createWorkflowContext() {
      return createTrackedContext(operations, approvedCheckpoints);
    },
  };
}

export async function previewWorkflowArtifact(
  artifact: Pick<WorkflowStudioArtifact, "code" | "slug" | "samplePayload">,
  approvedCheckpoints: string[] = []
): Promise<WorkflowPreviewResult> {
  const operations: WorkflowPreviewOperation[] = [];
  const approved = new Set(approvedCheckpoints);
  const previewLogs = createPreviewLogCapture();

  let payload: unknown = {};
  try {
    payload = artifact.samplePayload.trim()
      ? JSON.parse(artifact.samplePayload)
      : {};
  } catch {
    return {
      status: "error",
      operations,
      error: "Sample payload must be valid JSON.",
    };
  }

  try {
    const workflow = loadWorkflowDefinitionFromSource<{
      deploy?: Record<string, unknown>;
      run: (payload: unknown, ctx: unknown) => Promise<unknown>;
    }>(
      artifact.code,
      buildRuntimeSdk(operations, approved),
      `${artifact.slug}.ts`,
      { console: previewLogs.console }
    );

    const PREVIEW_TIMEOUT_MS = 30_000;
    const ctx = createTrackedContext(operations, approved);
    const result = await Promise.race([
      workflow.run(payload, ctx),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `Preview timed out after ${PREVIEW_TIMEOUT_MS / 1000}s. Check for slow API calls or infinite loops.`
              )
            ),
          PREVIEW_TIMEOUT_MS
        )
      ),
    ]);

    // Detect API failures that the workflow code didn't throw on
    const failedOps = operations.filter(
      (op) => op.responseStatus && (op.responseStatus < 200 || op.responseStatus >= 400)
    );
    const warnings = failedOps.map(
      (op) => `${op.method} ${op.target}${op.url.replace(/^.*\/proxy\/[^/]+/, "")} returned ${op.responseStatus}${op.responseStatus === 401 ? " (auth expired — reconnect in Connections)" : ""}`
    );

    return {
      status: "success",
      operations,
      ...(previewLogs.logs.length > 0 ? { logs: previewLogs.logs } : {}),
      result,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } catch (error) {
    if (error instanceof PreviewApprovalError) {
      return {
        status: "needs_approval",
        operations,
        ...(previewLogs.logs.length > 0 ? { logs: previewLogs.logs } : {}),
        pendingApproval: error.pendingApproval,
      };
    }

    const errorMessage = error instanceof Error ? error.message : "Preview run failed.";
    const errorStack = error instanceof Error ? error.stack : undefined;
    previewLogs.appendLog("error", "[workflow-studio] Preview failed", {
      error: errorMessage,
      ...(errorStack ? { stack: errorStack } : {}),
    });
    console.error("[preview] Workflow execution error:", errorMessage);
    if (errorStack) {
      console.error("[preview] Stack:", errorStack);
    }
    return {
      status: "error",
      operations,
      ...(previewLogs.logs.length > 0 ? { logs: previewLogs.logs } : {}),
      error: errorMessage,
      ...(errorStack ? { stack: errorStack } : {}),
    };
  }
}
