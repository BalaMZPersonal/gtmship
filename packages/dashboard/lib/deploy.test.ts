import { describe, expect, it } from "vitest";
import {
  buildDeploymentLogsHref,
  dedupeWorkflowDeploymentsById,
  getScopedWorkflowDeployments,
  getWorkflowDeploymentRefs,
  resolvePreferredCloudProvider,
  resolveSelectedExecutionName,
  resolveSelectedWorkflowDeploymentId,
  type WorkflowDeploymentOverview,
  type WorkflowExecutionHistoryEntry,
} from "@/lib/deploy";

function createDeployment(
  overrides: Partial<WorkflowDeploymentOverview>
): WorkflowDeploymentOverview {
  return {
    id: "dep-default",
    workflowId: "workflow-default",
    provider: "gcp",
    region: "us-central1",
    gcpProject: "project-default",
    updatedAt: "2026-04-04T10:00:00.000Z",
    ...overrides,
  };
}

describe("deploy helpers", () => {
  it("builds unique workflow lookup refs in id-then-slug order", () => {
    expect(
      getWorkflowDeploymentRefs({
        workflowId: " workflow-alpha ",
        workflowSlug: "workflow-alpha",
      })
    ).toEqual(["workflow-alpha"]);

    expect(
      getWorkflowDeploymentRefs({
        workflowId: "workflow-alpha",
        workflowSlug: "workflow-alpha-slug",
      })
    ).toEqual(["workflow-alpha", "workflow-alpha-slug"]);
  });

  it("dedupes deployments and keeps workflow-compatible matches sorted by target", () => {
    const scoped = getScopedWorkflowDeployments(
      dedupeWorkflowDeploymentsById([
        createDeployment({
          id: "dep-1",
          workflowId: "workflow-alpha",
          region: "us-central1",
          gcpProject: "project-a",
          updatedAt: "2026-04-03T10:00:00.000Z",
        }),
        createDeployment({
          id: "dep-1",
          workflowId: "workflow-alpha",
          region: "us-east1",
          gcpProject: "project-b",
          updatedAt: "2026-04-04T10:00:00.000Z",
        }),
        createDeployment({
          id: "dep-2",
          workflowId: "workflow-alpha-slug",
          region: "us-east1",
          gcpProject: "project-b",
          updatedAt: "2026-04-04T11:00:00.000Z",
        }),
        createDeployment({
          id: "dep-3",
          workflowId: "workflow-beta",
          region: "us-east1",
          gcpProject: "project-b",
          updatedAt: "2026-04-04T12:00:00.000Z",
        }),
      ]),
      {
        provider: "gcp",
        workflowId: "workflow-alpha",
        workflowSlug: "workflow-alpha-slug",
        region: "us-east1",
        gcpProject: "project-b",
      }
    );

    expect(scoped.map((deployment) => deployment.id)).toEqual([
      "dep-2",
      "dep-1",
    ]);
  });

  it("resolves deployment and execution selections without leaking stale values", () => {
    const deployments = [
      createDeployment({ id: "dep-1" }),
      createDeployment({ id: "dep-2", updatedAt: "2026-04-04T12:00:00.000Z" }),
    ];
    const executions: WorkflowExecutionHistoryEntry[] = [
      { executionName: "run-1" },
      { executionName: "run-2" },
    ];

    expect(
      resolveSelectedWorkflowDeploymentId(deployments, "dep-1", "dep-2")
    ).toBe("dep-1");
    expect(
      resolveSelectedWorkflowDeploymentId(deployments, "dep-missing", "dep-2")
    ).toBe("dep-2");
    expect(
      resolveSelectedWorkflowDeploymentId([], "dep-missing", "dep-2")
    ).toBe("");

    expect(resolveSelectedExecutionName(executions, "run-2")).toBe("run-2");
    expect(resolveSelectedExecutionName(executions, "run-missing")).toBe("");
  });

  it("builds workflow-scoped logs links with slug compatibility", () => {
    expect(
      buildDeploymentLogsHref({
        deploymentId: "dep-123",
        workflowId: "workflow-alpha",
        workflowSlug: "workflow-alpha-slug",
        executionName: "run-9",
      })
    ).toBe(
      "/deploy/logs?provider=gcp&deploymentId=dep-123&workflow=workflow-alpha&workflowSlug=workflow-alpha-slug&executionName=run-9"
    );
  });

  it("prefers an explicit logs provider over the saved settings cloud", () => {
    expect(
      resolvePreferredCloudProvider({
        requestedProvider: "gcp",
        savedProvider: "aws",
      })
    ).toBe("gcp");
  });

  it("falls back to the saved cloud provider, then aws when no override exists", () => {
    expect(
      resolvePreferredCloudProvider({
        requestedProvider: null,
        savedProvider: "gcp",
      })
    ).toBe("gcp");

    expect(
      resolvePreferredCloudProvider({
        requestedProvider: null,
        savedProvider: null,
      })
    ).toBe("aws");
  });
});
