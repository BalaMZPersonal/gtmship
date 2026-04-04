import type { ConnectionAuthStrategyStatus } from "./types";

const AUTH_URL = process.env.AUTH_SERVICE_URL || "http://localhost:4000";

export interface ActiveConnectionRecord {
  id: string;
  label?: string | null;
  createdAt?: string;
  provider: {
    slug: string;
    name: string;
    authType: string;
    description?: string | null;
    hasCredentials?: boolean;
  };
  status: string;
}

export interface ProviderDetailRecord {
  id: string;
  name: string;
  slug: string;
  authType: string;
  baseUrl: string;
  scopes?: string[] | null;
  docsUrl?: string | null;
  category?: string | null;
  logoUrl?: string | null;
  description?: string | null;
  source?: string | null;
  testEndpoint?: string | null;
  headerName?: string | null;
  apiSchema?: Record<string, unknown> | null;
  hasCredentials?: boolean;
  connections: Array<{
    id: string;
    label?: string | null;
    status: string;
    createdAt?: string;
  }>;
}

async function parseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) {
    return null as T;
  }

  return JSON.parse(text) as T;
}

export async function getSetting(
  key: string
): Promise<string | null> {
  try {
    const response = await fetch(`${AUTH_URL}/settings/${key}`, {
      cache: "no-store",
    });

    if (!response.ok) {
      return null;
    }

    const data = await parseJson<{ value?: string }>(response);
    return data.value ?? null;
  } catch {
    return null;
  }
}

export async function getAuthStrategy(): Promise<ConnectionAuthStrategyStatus | null> {
  try {
    const response = await fetch(`${AUTH_URL}/settings/auth-strategy`, {
      cache: "no-store",
    });

    if (!response.ok) {
      return null;
    }

    return parseJson<ConnectionAuthStrategyStatus>(response);
  } catch {
    return null;
  }
}

export async function listActiveConnections(): Promise<
  ActiveConnectionRecord[]
> {
  try {
    const response = await fetch(`${AUTH_URL}/connections`, {
      cache: "no-store",
    });

    if (!response.ok) {
      return [];
    }

    const data = await parseJson<ActiveConnectionRecord[]>(response);

    return data.filter((connection) => connection.status === "active");
  } catch {
    return [];
  }
}

export async function getProviderDetail(
  providerSlug: string
): Promise<ProviderDetailRecord | null> {
  try {
    const response = await fetch(
      `${AUTH_URL}/providers/${encodeURIComponent(providerSlug)}`,
      {
        cache: "no-store",
      }
    );

    if (!response.ok) {
      return null;
    }

    return parseJson<ProviderDetailRecord>(response);
  } catch {
    return null;
  }
}

export async function testConnection(
  connectionId: string
): Promise<{ success: boolean; status?: number; error?: string }> {
  try {
    const response = await fetch(`${AUTH_URL}/connections/${connectionId}/test`, {
      method: "POST",
      cache: "no-store",
    });

    if (!response.ok) {
      const message = await response.text();
      return {
        success: false,
        error: message || `Connection test failed with ${response.status}`,
      };
    }

    return parseJson<{ success: boolean; status?: number; error?: string }>(
      response
    );
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Connection test failed",
    };
  }
}

export async function deleteWorkflowDeploymentRecords(
  workflowId: string
): Promise<{ deletedDeploymentCount: number }> {
  try {
    const response = await fetch(
      `${AUTH_URL}/workflow-control-plane/deployments?workflowId=${encodeURIComponent(
        workflowId
      )}`,
      {
        method: "DELETE",
        cache: "no-store",
      }
    );

    const text = await response.text();
    let data: {
      deletedDeploymentCount?: number;
      error?: string;
    } | null = null;

    if (text) {
      try {
        data = JSON.parse(text) as {
          deletedDeploymentCount?: number;
          error?: string;
        };
      } catch {
        data = { error: text };
      }
    }

    if (!response.ok) {
      throw new Error(
        data?.error || "Failed to remove workflow deployment records."
      );
    }

    return {
      deletedDeploymentCount: data?.deletedDeploymentCount || 0,
    };
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? error.message
        : "Failed to remove workflow deployment records."
    );
  }
}

export { AUTH_URL };
