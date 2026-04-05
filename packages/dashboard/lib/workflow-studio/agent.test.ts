import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const streamTextMock = vi.fn();
const createDataStreamResponseMock = vi.fn();
const generateObjectMock = vi.fn();
const createConfiguredLanguageModelMock = vi.fn();
const researchWebMock = vi.fn();
const searchDocumentationMock = vi.fn();
const fetchUrlMock = vi.fn();
const generateWorkflowArtifactMock = vi.fn();
const previewWorkflowArtifactMock = vi.fn();
const buildWorkflowArtifactMock = vi.fn();
const loadProjectDeploymentDefaultsMock = vi.fn();
const compactWorkflowTranscriptIfNeededMock = vi.fn();

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

vi.mock("@/lib/workflow-studio/ai", async () => {
  const actual = await vi.importActual<typeof import("@/lib/workflow-studio/ai")>(
    "@/lib/workflow-studio/ai"
  );

  return {
    ...actual,
    generateWorkflowArtifact: (...args: unknown[]) =>
      generateWorkflowArtifactMock(...args),
  };
});

vi.mock("@/lib/workflow-studio/preview", () => ({
  previewWorkflowArtifact: (...args: unknown[]) =>
    previewWorkflowArtifactMock(...args),
}));

vi.mock("@/lib/workflow-studio/build", () => ({
  buildWorkflowArtifact: (...args: unknown[]) =>
    buildWorkflowArtifactMock(...args),
}));

vi.mock("@/lib/workflow-studio/project-config", () => ({
  loadProjectDeploymentDefaults: (...args: unknown[]) =>
    loadProjectDeploymentDefaultsMock(...args),
}));

vi.mock("@/lib/workflow-studio/transcript-compaction-server", () => ({
  compactWorkflowTranscriptIfNeeded: (...args: unknown[]) =>
    compactWorkflowTranscriptIfNeededMock(...args),
}));

function makeDraftArtifact() {
  return {
    slug: "demo-workflow",
    title: "Demo Workflow",
    summary: "A workflow",
    description: "A workflow",
    mermaid: "flowchart LR\n  a --> b",
    code: "export default {}",
    samplePayload: "{}",
    requiredAccesses: [],
    writeCheckpoints: [
      {
        id: "append-to-sheets",
        label: "Append to Sheets",
        description: "Append a row to Google Sheets",
        method: "POST",
        targetType: "integration",
        providerSlug: "google-sheets",
      },
    ],
    chatSummary: "",
    messages: [],
    bindings: [],
  };
}

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
    generateWorkflowArtifactMock.mockResolvedValue({
      assistantMessage: "Draft generated.",
      artifact: makeDraftArtifact(),
    });
    previewWorkflowArtifactMock.mockResolvedValue({
      status: "needs_approval",
      operations: [],
      pendingApproval: {
        checkpoint: "append-to-sheets",
        target: "google-sheets",
        method: "POST",
        source: "integration",
      },
    });
    buildWorkflowArtifactMock.mockResolvedValue({
      status: "success",
      provider: "gcp",
      region: "us-central1",
      gcpProject: "demo-project",
      builtAt: "2026-04-05T00:00:00.000Z",
      steps: [],
      preview: {
        status: "success",
        operations: [],
      },
      artifact: {
        workflowId: "demo-workflow",
        provider: "gcp",
        artifactPath: "/tmp/demo-workflow",
        bundleSizeBytes: 0,
      },
    });
    loadProjectDeploymentDefaultsMock.mockResolvedValue({});
    compactWorkflowTranscriptIfNeededMock.mockImplementation(
      async ({
        messages,
        currentArtifact,
      }: {
        messages: unknown[];
        currentArtifact?: unknown;
      }) => ({
        messages,
        currentArtifact,
      })
    );
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

  it("does not let the chat agent build on its own when the user did not ask for a build", async () => {
    const { createWorkflowAgentResponse } = await import(
      "@/lib/workflow-studio/agent"
    );

    await createWorkflowAgentResponse({
      messages: [{ role: "user", content: "Create a workflow for GitHub issues" }],
      currentArtifact: makeDraftArtifact(),
    });

    const result = (await capturedTools.buildWorkflowDraft.execute({})) as {
      skipped?: boolean;
      assistantMessage?: string;
    };

    expect(buildWorkflowArtifactMock).not.toHaveBeenCalled();
    expect(result.skipped).toBe(true);
    expect(result.assistantMessage).toContain("Build not started.");
  });

  it("ignores chat-supplied approval checkpoints and keeps preview approval in the UI", async () => {
    const { createWorkflowAgentResponse } = await import(
      "@/lib/workflow-studio/agent"
    );

    await createWorkflowAgentResponse({
      messages: [{ role: "user", content: "Preview this workflow" }],
      currentArtifact: makeDraftArtifact(),
    });

    const result = (await capturedTools.previewWorkflowDraft.execute({
      approvedCheckpoints: ["append-to-sheets"],
    })) as {
      assistantMessage?: string;
    };

    expect(previewWorkflowArtifactMock).toHaveBeenCalledWith(
      {
        slug: "demo-workflow",
        code: "export default {}",
        samplePayload: "{}",
      },
      []
    );
    expect(result.assistantMessage).toContain("The user must approve this");
  });

  it("allows an explicit build request and returns a non-deploying build summary", async () => {
    const { createWorkflowAgentResponse } = await import(
      "@/lib/workflow-studio/agent"
    );

    await createWorkflowAgentResponse({
      messages: [{ role: "user", content: "Build the workflow now" }],
      currentArtifact: makeDraftArtifact(),
    });

    const result = (await capturedTools.buildWorkflowDraft.execute({})) as {
      assistantMessage?: string;
    };

    expect(buildWorkflowArtifactMock).toHaveBeenCalledWith({
      artifact: makeDraftArtifact(),
      defaults: {},
    });
    expect(result.assistantMessage).toContain(
      "This did not deploy the workflow."
    );
  });
});
