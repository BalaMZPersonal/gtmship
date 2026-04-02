import type { AiModelOption, AiProvider } from "@/lib/ai-config";
import type {
  CloudSettingRecord,
  DashboardDeployRequest,
  DashboardDeployResponse,
  WorkflowDeploymentLogEntry,
  WorkflowDeploymentLogsResponse,
  WorkflowDeploymentOverview,
} from "@/lib/deploy";

const AUTH_URL = process.env.NEXT_PUBLIC_AUTH_URL || "http://localhost:4000";

async function request(path: string, options?: RequestInit) {
  const res = await fetch(`${AUTH_URL}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
  if (res.status === 204) {
    return null;
  }
  const body = await res.text();
  return body ? JSON.parse(body) : null;
}

async function localRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });

  const body = await res.text();
  const data = body ? (JSON.parse(body) as T & { error?: string }) : ({} as T & { error?: string });

  if (!res.ok) {
    throw new Error(data.error || `${res.status}`);
  }

  return data;
}

export const api = {
  // Providers
  getProviders: () => request("/providers"),
  getProvider: (slug: string) => request(`/providers/${slug}`),
  createProvider: (data: Record<string, unknown>) =>
    request("/providers", { method: "POST", body: JSON.stringify(data) }),
  updateProvider: (slug: string, data: Record<string, unknown>) =>
    request(`/providers/${slug}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteProvider: (slug: string) =>
    request(`/providers/${slug}`, { method: "DELETE" }),

  // Shared OAuth providers
  getOAuthProvider: (key: string) => request(`/oauth-providers/${key}`),
  upsertOAuthProvider: (key: string, data: Record<string, unknown>) =>
    request(`/oauth-providers/${key}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  // Connections
  getConnections: () => request("/connections"),
  testConnection: (id: string) =>
    request(`/connections/${id}/test`, { method: "POST" }),
  refreshConnection: (id: string) =>
    request(`/connections/${id}/refresh`, { method: "POST" }),
  deleteConnection: (id: string) =>
    request(`/connections/${id}`, { method: "DELETE" }),

  // OAuth
  startOAuth: (slug: string, options?: { serviceSlugs?: string[] }) => {
    const params = new URLSearchParams();
    for (const serviceSlug of options?.serviceSlugs || []) {
      params.append("service_slugs", serviceSlug);
    }
    const qs = params.toString();
    return request(`/auth/${slug}/connect${qs ? `?${qs}` : ""}`);
  },
  connectApiKey: (slug: string, apiKey: string, label?: string) =>
    request(`/auth/${slug}/connect-key`, {
      method: "POST",
      body: JSON.stringify({ api_key: apiKey, label }),
    }),

  // Catalog
  getCatalog: (query?: string, category?: string) => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (category && category !== "All") params.set("category", category);
    const qs = params.toString();
    return request(`/catalog${qs ? `?${qs}` : ""}`);
  },
  getCatalogProvider: (slug: string) => request(`/catalog/${slug}`),

  // Settings
  getSettings: () => request("/settings") as Promise<CloudSettingRecord[]>,
  getSetting: (key: string) => request(`/settings/${key}`),
  setSetting: (key: string, value: string) =>
    request(`/settings/${key}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    }),
  deleteSetting: (key: string) =>
    request(`/settings/${key}`, { method: "DELETE" }),
  searchAiModels: (input: {
    provider: AiProvider;
    apiKey?: string;
    query?: string;
  }) =>
    localRequest<{ models: AiModelOption[] }>("/api/ai/models", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  // Deploy
  deploy: (config: DashboardDeployRequest) =>
    fetch("/api/deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    }).then((r) => r.json() as Promise<DashboardDeployResponse>),
  getDeployPlan: (params: Record<string, string>) => {
    const qs = new URLSearchParams(params).toString();
    return fetch(`/api/deploy/plan?${qs}`, {
      cache: "no-store",
    }).then((r) => r.json());
  },
  getWorkflowDeployments: async (params?: {
    workflowId?: string;
    provider?: string;
    status?: string;
    includeLive?: boolean;
    executionLimit?: number;
  }) => {
    const query = new URLSearchParams();
    if (params?.workflowId) query.set("workflowId", params.workflowId);
    if (params?.provider) query.set("provider", params.provider);
    if (params?.status) query.set("status", params.status);
    if (params?.includeLive) query.set("includeLive", "true");
    if (typeof params?.executionLimit === "number") {
      query.set("executionLimit", String(params.executionLimit));
    }

    const suffix = query.toString();
    return request(
      `/workflow-control-plane/deployments${suffix ? `?${suffix}` : ""}`
    ) as Promise<WorkflowDeploymentOverview[]>;
  },
  getWorkflowDeployment: (id: string, params?: {
    includeLive?: boolean;
    executionLimit?: number;
  }) => {
    const query = new URLSearchParams();
    if (params?.includeLive) query.set("includeLive", "true");
    if (typeof params?.executionLimit === "number") {
      query.set("executionLimit", String(params.executionLimit));
    }

    const suffix = query.toString();
    return request(
      `/workflow-control-plane/deployments/${encodeURIComponent(id)}${
        suffix ? `?${suffix}` : ""
      }`
    ) as Promise<WorkflowDeploymentOverview>;
  },
  getWorkflowDeploymentLogs: async (
    deploymentId: string,
    params?: {
      since?: string;
      limit?: number;
      executionName?: string;
    }
  ): Promise<WorkflowDeploymentLogsResponse> => {
    const query = new URLSearchParams();
    if (params?.since) query.set("since", params.since);
    if (typeof params?.limit === "number") query.set("limit", String(params.limit));
    if (params?.executionName) {
      query.set("executionName", params.executionName);
    }

    const suffix = query.toString();
    const response = (await request(
      `/workflow-control-plane/deployments/${encodeURIComponent(
        deploymentId
      )}/logs${suffix ? `?${suffix}` : ""}`
    )) as
      | WorkflowDeploymentLogsResponse
      | WorkflowDeploymentLogEntry[]
      | null;

    if (Array.isArray(response)) {
      return {
        deploymentId,
        entries: response,
      };
    }

    return {
      deploymentId: response?.deploymentId || deploymentId,
      entries: Array.isArray(response?.entries) ? response.entries : [],
      liveError: response?.liveError || null,
    };
  },
  reconcileWorkflowDeployments: async (params?: {
    provider?: "aws" | "gcp";
    workflow?: string;
    region?: string;
    gcpProject?: string;
  }) => {
    const query = new URLSearchParams();
    if (params?.provider) query.set("provider", params.provider);
    if (params?.workflow) query.set("workflow", params.workflow);
    if (params?.region) query.set("region", params.region);
    if (params?.gcpProject) query.set("gcpProject", params.gcpProject);

    const response = await fetch(
      `/api/deploy/reconcile${query.toString() ? `?${query.toString()}` : ""}`,
      {
        method: "POST",
      }
    );

    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || "Failed to reconcile workflow deployments.");
    }

    return response.json() as Promise<{
      syncedCount: number;
      deployments: unknown[];
    }>;
  },

  // Logs
  getLogs: (params: Record<string, string>) => {
    const qs = new URLSearchParams(params).toString();
    return fetch(`/api/logs?${qs}`).then((r) => r.json());
  },

  // Cloud auth validation
  validateCloudAuth: (provider: string) =>
    fetch(`${AUTH_URL}/cloud-auth/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider }),
    }).then((r) => r.json()),
};
