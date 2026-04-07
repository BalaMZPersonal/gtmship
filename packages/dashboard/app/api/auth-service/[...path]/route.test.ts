import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

describe("auth service proxy route", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("AUTH_SERVICE_URL", "http://auth.internal:4000");
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("forwards GET requests to the configured auth service URL", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([{ id: "dep_123" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const { GET } = await import("@/app/api/auth-service/[...path]/route");
    const response = await GET(
      new Request(
        "http://localhost/api/auth-service/workflow-control-plane/deployments?workflowId=wf_123"
      ),
      {
        params: { path: ["workflow-control-plane", "deployments"] },
      }
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://auth.internal:4000/workflow-control-plane/deployments?workflowId=wf_123",
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        redirect: "manual",
      })
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([{ id: "dep_123" }]);
  });

  it("forwards POST bodies and error statuses", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Bad credentials" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    );

    const { POST } = await import("@/app/api/auth-service/[...path]/route");
    const response = await POST(
      new Request("http://localhost/api/auth-service/cloud-auth/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "aws" }),
      }),
      {
        params: { path: ["cloud-auth", "validate"] },
      }
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://auth.internal:4000/cloud-auth/validate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ provider: "aws" }),
        cache: "no-store",
        redirect: "manual",
        headers: expect.any(Headers),
      })
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Bad credentials",
    });
  });
});
