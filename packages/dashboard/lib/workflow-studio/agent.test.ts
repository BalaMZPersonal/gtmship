import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const streamTextMock = vi.fn();
const createDataStreamResponseMock = vi.fn();
const generateObjectMock = vi.fn();
const createConfiguredLanguageModelMock = vi.fn();
const researchWebMock = vi.fn();
const searchDocumentationMock = vi.fn();
const fetchUrlMock = vi.fn();

vi.mock("ai", () => ({
  streamText: (...args: unknown[]) => streamTextMock(...args),
  tool: (config: unknown) => config,
  createDataStreamResponse: (...args: unknown[]) =>
    createDataStreamResponseMock(...args),
  generateObject: (...args: unknown[]) => generateObjectMock(...args),
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
  executeCommand: vi.fn(),
}));

describe("workflow agent", () => {
  let capturedTools: Record<string, { execute: (...args: unknown[]) => unknown }>;

  beforeEach(() => {
    capturedTools = {};
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
    generateObjectMock.mockResolvedValue({ object: { summary: "summary" } });
    createDataStreamResponseMock.mockImplementation(
      ({ execute }: { execute: (stream: { writeData: (value: unknown) => void }) => void }) => {
        execute({ writeData: vi.fn() });
        return new Response("ok");
      }
    );
    streamTextMock.mockImplementation((input: { tools: typeof capturedTools }) => {
      capturedTools = input.tools;
      return {
        mergeIntoDataStream: vi.fn(),
      };
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("registers researchWeb alongside the legacy compatibility tools", async () => {
    const { createWorkflowAgentResponse } = await import(
      "@/lib/workflow-studio/agent"
    );

    await createWorkflowAgentResponse({
      messages: [{ role: "user", content: "Build a workflow for HubSpot" }],
    });

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
});
