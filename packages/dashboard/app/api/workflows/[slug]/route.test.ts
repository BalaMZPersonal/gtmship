import { beforeEach, describe, expect, it, vi } from "vitest";

const loadStoredWorkflowMock = vi.fn();
const deleteStoredWorkflowMock = vi.fn();
const deleteWorkflowDeploymentRecordsMock = vi.fn();

vi.mock("@/lib/workflow-studio/storage", () => ({
  loadStoredWorkflow: (...args: unknown[]) => loadStoredWorkflowMock(...args),
  deleteStoredWorkflow: (...args: unknown[]) => deleteStoredWorkflowMock(...args),
}));

vi.mock("@/lib/workflow-studio/auth-service", () => ({
  deleteWorkflowDeploymentRecords: (...args: unknown[]) =>
    deleteWorkflowDeploymentRecordsMock(...args),
}));

async function callDelete(body?: unknown) {
  const { DELETE } = await import("@/app/api/workflows/[slug]/route");

  return DELETE(
    new Request("http://localhost/api/workflows/demo", {
      method: "DELETE",
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: { slug: "demo" } }
  );
}

describe("workflow delete route", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    loadStoredWorkflowMock.mockResolvedValue({
      slug: "demo",
      workflowId: "workflow-demo",
      filePath: "/tmp/demo.ts",
      metadataPath: "/tmp/demo.json",
      artifact: {
        slug: "demo",
        title: "Demo",
        summary: "A workflow",
        mermaid: "",
        code: "export default {}",
        samplePayload: "{}",
        requiredAccesses: [],
        writeCheckpoints: [],
        chatSummary: "",
        messages: [],
      },
      updatedAt: new Date().toISOString(),
    });
    deleteStoredWorkflowMock.mockResolvedValue(undefined);
    deleteWorkflowDeploymentRecordsMock.mockResolvedValue({
      deletedDeploymentCount: 0,
    });
  });

  it("deletes the local workflow without deployment cleanup by default", async () => {
    const response = await callDelete();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(deleteWorkflowDeploymentRecordsMock).not.toHaveBeenCalled();
    expect(deleteStoredWorkflowMock).toHaveBeenCalledWith("demo");
    expect(payload).toEqual({
      slug: "demo",
      workflowId: "workflow-demo",
      removedDeploymentCount: 0,
    });
  });

  it("removes deployment records before deleting the local workflow when requested", async () => {
    deleteWorkflowDeploymentRecordsMock.mockResolvedValue({
      deletedDeploymentCount: 2,
    });

    const response = await callDelete({ removeDeployment: true });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(deleteWorkflowDeploymentRecordsMock).toHaveBeenCalledWith(
      "workflow-demo"
    );
    expect(deleteStoredWorkflowMock).toHaveBeenCalledWith("demo");
    expect(payload).toEqual({
      slug: "demo",
      workflowId: "workflow-demo",
      removedDeploymentCount: 2,
    });
  });

  it("does not delete the local workflow when deployment cleanup fails", async () => {
    deleteWorkflowDeploymentRecordsMock.mockRejectedValue(
      new Error("Failed to remove workflow deployment records.")
    );

    const response = await callDelete({ removeDeployment: true });
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(deleteWorkflowDeploymentRecordsMock).toHaveBeenCalledWith(
      "workflow-demo"
    );
    expect(deleteStoredWorkflowMock).not.toHaveBeenCalled();
    expect(payload).toEqual({
      error: "Failed to remove workflow deployment records.",
    });
  });
});
