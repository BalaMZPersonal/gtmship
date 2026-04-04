import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const streamTextMock = vi.fn();
const createConfiguredLanguageModelMock = vi.fn();
const researchWebMock = vi.fn();
const searchDocumentationMock = vi.fn();
const fetchUrlMock = vi.fn();
const executeCommandMock = vi.fn();
const fetchMock = vi.fn();

vi.mock("ai", () => ({
  streamText: (...args: unknown[]) => streamTextMock(...args),
  tool: (config: unknown) => config,
}));

vi.mock("@/lib/ai-settings", () => ({
  createConfiguredLanguageModel: (...args: unknown[]) =>
    createConfiguredLanguageModelMock(...args),
}));

vi.mock("@/lib/research", async () => {
  const actual = await vi.importActual<typeof import("@/lib/research")>(
    "@/lib/research"
  );

  return {
    ...actual,
    researchWeb: (...args: unknown[]) => researchWebMock(...args),
  };
});

vi.mock("@/lib/doc-search", () => ({
  searchDocumentation: (...args: unknown[]) => searchDocumentationMock(...args),
}));

vi.mock("@/lib/url-fetcher", () => ({
  fetchUrl: (...args: unknown[]) => fetchUrlMock(...args),
}));

vi.mock("@/lib/sandbox", () => ({
  executeCommand: (...args: unknown[]) => executeCommandMock(...args),
}));

describe("integration agent route", () => {
  let capturedTools: Record<string, { execute: (...args: unknown[]) => unknown }>;

  beforeEach(() => {
    capturedTools = {};
    vi.stubGlobal("fetch", fetchMock);
    createConfiguredLanguageModelMock.mockResolvedValue({ id: "test-model" });
    researchWebMock.mockResolvedValue({
      provider: "duckduckgo",
      mode: "search",
      query: "HubSpot API documentation",
      results: [],
    });
    searchDocumentationMock.mockResolvedValue({
      query: "HubSpot API documentation",
      results: [],
    });
    fetchUrlMock.mockResolvedValue({
      status: 200,
      contentType: "text/html",
      body: "docs",
    });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: "conn_1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    executeCommandMock.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    streamTextMock.mockImplementation((input: { tools: typeof capturedTools }) => {
      capturedTools = input.tools;
      return {
        toDataStreamResponse: () => new Response("ok"),
      };
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("registers researchWeb alongside the legacy compatibility tools", async () => {
    const { POST } = await import("@/app/api/agent/route");

    await POST(
      new Request("http://localhost/api/agent", {
        method: "POST",
        body: JSON.stringify({
          messages: [{ role: "user", content: "Set up HubSpot" }],
        }),
      })
    );

    expect(capturedTools.researchWeb).toBeDefined();
    expect(capturedTools.searchDocumentation).toBeDefined();
    expect(capturedTools.fetchUrl).toBeDefined();

    await capturedTools.researchWeb.execute({
      mode: "search",
      query: "HubSpot",
    });
    expect(researchWebMock).toHaveBeenCalledWith({
      mode: "search",
      query: "HubSpot",
    });
  });

  it("forwards connectionId when reconnecting an existing API-key connection", async () => {
    const { POST } = await import("@/app/api/agent/route");

    await POST(
      new Request("http://localhost/api/agent", {
        method: "POST",
        body: JSON.stringify({
          messages: [{ role: "user", content: "Reconnect Freshdesk" }],
        }),
      })
    );

    await capturedTools.connectApiKey.execute({
      provider: "freshdesk",
      api_key: "secret",
      label: "factors-help Freshdesk",
      connectionId: "conn_original",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/auth/freshdesk/connect-key",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          api_key: "secret",
          label: "factors-help Freshdesk",
          connection_id: "conn_original",
        }),
      })
    );
  });
});
