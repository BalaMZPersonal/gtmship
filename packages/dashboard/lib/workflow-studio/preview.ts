import { AUTH_URL } from "./auth-service";
import { loadWorkflowDefinitionFromSource } from "./runtime";
import type {
  WorkflowPendingApproval,
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
          : JSON.stringify(config.body),
    });

    operation.responseStatus = response.status;

    return {
      data: (await parseResponseData(response)) as T,
      status: response.status,
    };
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

        return {
          data: (await parseResponseData(response)) as T,
          status: response.status,
        };
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
              config.body === undefined ? undefined : JSON.stringify(config.body),
          });

          operation.responseStatus = response.status;

          return {
            data: (await parseResponseData(response)) as T,
            status: response.status,
          };
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
    }>(artifact.code, buildRuntimeSdk(operations, approved), `${artifact.slug}.ts`);

    const ctx = createTrackedContext(operations, approved);
    const result = await workflow.run(payload, ctx);

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
      result,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } catch (error) {
    if (error instanceof PreviewApprovalError) {
      return {
        status: "needs_approval",
        operations,
        pendingApproval: error.pendingApproval,
      };
    }

    const errorMessage = error instanceof Error ? error.message : "Preview run failed.";
    const errorStack = error instanceof Error ? error.stack : undefined;
    console.error("[preview] Workflow execution error:", errorMessage);
    if (errorStack) {
      console.error("[preview] Stack:", errorStack);
    }
    return {
      status: "error",
      operations,
      error: errorMessage,
    };
  }
}
