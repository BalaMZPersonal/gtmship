import { readProjectConfig } from "./workflow-plans.js";

export function getAuthUrl(): string {
  try {
    const config = readProjectConfig();
    return config?.authUrl || "http://localhost:4000";
  } catch {
    return "http://localhost:4000";
  }
}

export async function apiRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const baseUrl = getAuthUrl();
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(text || res.statusText);
    (err as Error & { status: number }).status = res.status;
    throw err;
  }

  if (res.status === 204) {
    return null;
  }

  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export function apiGet(path: string): Promise<unknown> {
  return apiRequest("GET", path);
}

export function apiPost(path: string, body?: unknown): Promise<unknown> {
  return apiRequest("POST", path, body);
}

export function apiPut(path: string, body?: unknown): Promise<unknown> {
  return apiRequest("PUT", path, body);
}

export function apiDelete(path: string, body?: unknown): Promise<unknown> {
  return apiRequest("DELETE", path, body);
}
