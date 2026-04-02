import {
  makeIntegrationRequest,
  parseResponseData,
  resolveIntegrationOperationUrl,
} from "./auth.js";
import type {
  WorkflowAccessOperation,
  WorkflowContext,
  WorkflowContextOptions,
  WorkflowHttpMethod,
  WorkflowIntegrationClient,
  WorkflowReadOptions,
  WorkflowRequestResult,
  WorkflowWebAccess,
  WorkflowWriteApprovalRequest,
  WorkflowWriteOptions,
} from "./types.js";

function createOperationId(): string {
  return `wfop_${Math.random().toString(36).slice(2, 10)}`;
}

function buildOperation(
  source: "integration" | "web",
  target: string,
  url: string,
  method: WorkflowHttpMethod,
  mode: "read" | "write",
  description?: string,
  checkpoint?: string
): WorkflowAccessOperation {
  return {
    id: createOperationId(),
    source,
    target,
    url,
    method,
    mode,
    description,
    checkpoint,
  };
}

async function trackOperation(
  options: WorkflowContextOptions,
  operation: WorkflowAccessOperation
): Promise<void> {
  await options.onOperation?.(operation);
  if (operation.mode === "write") {
    await options.approveWrite?.({
      checkpoint: operation.checkpoint || "write-operation",
      operation,
      reason: operation.description,
    });
  }
}

async function requestWeb<T>(
  url: string,
  method: WorkflowHttpMethod,
  options: WorkflowContextOptions,
  config: {
    headers?: Record<string, string>;
    body?: unknown;
    description?: string;
    checkpoint?: string;
  }
): Promise<WorkflowRequestResult<T>> {
  const operation = buildOperation(
    "web",
    url,
    url,
    method,
    method === "GET" || method === "HEAD" ? "read" : "write",
    config.description,
    config.checkpoint
  );

  await trackOperation(options, operation);

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

  return {
    data: (await parseResponseData(response)) as T,
    status: response.status,
  };
}

function createIntegrationClient(
  providerSlug: string,
  options: WorkflowContextOptions
): WorkflowIntegrationClient {
  const read = async <T = unknown>(
    path: string,
    config?: WorkflowReadOptions
  ): Promise<WorkflowRequestResult<T>> => {
    const method = config?.method || "GET";
    const url = resolveIntegrationOperationUrl(providerSlug, path, {
      authServiceUrl: options.authServiceUrl,
      runtimeAuth: options.runtimeAuth,
    });
    const operation = buildOperation(
      "integration",
      providerSlug,
      url,
      method,
      "read",
      config?.description
    );
    await trackOperation(options, operation);
    return makeIntegrationRequest<T>(providerSlug, method, path, undefined, {
      headers: config?.headers,
      authServiceUrl: options.authServiceUrl,
      runtime: options.runtime,
      runtimeAuth: options.runtimeAuth,
    });
  };

  return {
    slug: providerSlug,
    get: async <T = unknown>(
      path: string,
      config?: WorkflowReadOptions
    ): Promise<WorkflowRequestResult<T>> => read<T>(path, config),
    read,
    write: async <T = unknown>(
      path: string,
      config: WorkflowWriteOptions
    ): Promise<WorkflowRequestResult<T>> => {
      const url = resolveIntegrationOperationUrl(providerSlug, path, {
        authServiceUrl: options.authServiceUrl,
        runtimeAuth: options.runtimeAuth,
      });
      const operation = buildOperation(
        "integration",
        providerSlug,
        url,
        config.method,
        "write",
        config.description,
        config.checkpoint
      );
      await trackOperation(options, operation);
      return makeIntegrationRequest<T>(
        providerSlug,
        config.method,
        path,
        config.body,
        {
          headers: config.headers,
          authServiceUrl: options.authServiceUrl,
          runtime: options.runtime,
          runtimeAuth: options.runtimeAuth,
        }
      );
    },
  };
}

function createWebAccess(
  options: WorkflowContextOptions
): WorkflowWebAccess {
  return {
    read: async <T = unknown>(
      url: string,
      config?: WorkflowReadOptions
    ): Promise<WorkflowRequestResult<T>> => {
      return requestWeb<T>(url, config?.method || "GET", options, {
        headers: config?.headers,
        description: config?.description,
      });
    },
    write: async <T = unknown>(
      url: string,
      config: WorkflowWriteOptions
    ): Promise<WorkflowRequestResult<T>> => {
      return requestWeb<T>(url, config.method, options, {
        headers: config.headers,
        body: config.body,
        description: config.description,
        checkpoint: config.checkpoint,
      });
    },
  };
}

export function createWorkflowContext(
  options: WorkflowContextOptions = {}
): WorkflowContext {
  return {
    integration: async (
      providerSlug: string
    ): Promise<WorkflowIntegrationClient> =>
      createIntegrationClient(providerSlug, options),
    web: createWebAccess(options),
    requestWriteApproval: async (
      request: WorkflowWriteApprovalRequest
    ): Promise<void> => {
      await options.approveWrite?.(request);
    },
  };
}
