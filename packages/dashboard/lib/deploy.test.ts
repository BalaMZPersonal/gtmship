import { describe, expect, it } from "vitest";
import {
  buildWorkflowSecretSyncSummary,
  buildDeploymentLogsHref,
  dedupeWorkflowDeploymentsById,
  extractDashboardErrorMessage,
  getScopedWorkflowDeployments,
  getWorkflowDeploymentRefs,
  resolvePreferredCloudProvider,
  resolveSelectedExecutionName,
  resolveSelectedWorkflowDeploymentId,
  type WorkflowDeploymentOverview,
  type WorkflowExecutionHistoryEntry,
} from "@/lib/deploy";
import type { WorkflowDeploymentPlan } from "@/lib/workflow-studio/types";

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

function createPlan(
  overrides: Partial<WorkflowDeploymentPlan>
): WorkflowDeploymentPlan {
  return {
    workflowId: "workflow-alpha",
    workflowTitle: "Workflow Alpha",
    provider: "gcp",
    region: "us-central1",
    trigger: {
      type: "manual",
      description: "Manual trigger",
    },
    executionKind: "job",
    executionSource: "explicit",
    authMode: "proxy",
    auth: {
      mode: "proxy",
    },
    resources: [],
    bindings: [],
    warnings: [],
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

  it("builds aws deployment logs links without changing the gcp default", () => {
    expect(
      buildDeploymentLogsHref({
        provider: "aws",
        deploymentId: "dep-aws-1",
        workflowId: "workflow-aws",
      })
    ).toBe("/deploy/logs?provider=aws&deploymentId=dep-aws-1&workflow=workflow-aws");

    expect(
      buildDeploymentLogsHref({
        deploymentId: "dep-gcp-default",
      })
    ).toBe("/deploy/logs?provider=gcp&deploymentId=dep-gcp-default");
  });

  it("keeps aws deployments selectable by provider and region without using gcp fields", () => {
    const scoped = getScopedWorkflowDeployments(
      [
        createDeployment({
          id: "dep-aws-east",
          provider: "aws",
          workflowId: "workflow-aws",
          region: "us-east-1",
          gcpProject: null,
          updatedAt: "2026-04-05T10:00:00.000Z",
        }),
        createDeployment({
          id: "dep-aws-west",
          provider: "aws",
          workflowId: "workflow-aws",
          region: "us-west-2",
          gcpProject: null,
          updatedAt: "2026-04-05T11:00:00.000Z",
        }),
      ],
      {
        provider: "aws",
        workflowId: "workflow-aws",
        region: "us-west-2",
      }
    );

    expect(scoped.map((deployment) => deployment.id)).toEqual([
      "dep-aws-west",
      "dep-aws-east",
    ]);
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

  it("returns no secret sync summary for proxy auth plans", () => {
    expect(buildWorkflowSecretSyncSummary([createPlan({ authMode: "proxy" })])).toBeNull();
  });

  it("builds gcp secret sync summaries from manifest providers", () => {
    const summary = buildWorkflowSecretSyncSummary([
      createPlan({
        authMode: "secret_manager",
        auth: {
          mode: "secret_manager",
          backend: {
            kind: "gcp_secret_manager",
            projectId: "gtmship-prod",
            secretPrefix: "gtmship-connections",
          },
          runtimeAccess: "direct",
          manifest: {
            providers: [
              {
                providerSlug: "google-sheets",
                connectionId: "conn-123",
                secretRef:
                  "projects/gtmship-prod/secrets/gtmship-connections-google-sheets-conn-123-runtime",
              },
            ],
          },
        },
      }),
    ]);

    expect(summary).not.toBeNull();
    expect(summary?.backendKind).toBe("gcp_secret_manager");
    expect(summary?.backendTarget).toBe("gtmship-prod");
    expect(summary?.secretCount).toBe(1);
    expect(summary?.entries[0]).toMatchObject({
      providerSlug: "google-sheets",
      connectionId: "conn-123",
    });
  });

  it("builds aws secret sync summaries and preserves pending fallback labels", () => {
    const summary = buildWorkflowSecretSyncSummary([
      createPlan({
        workflowId: "workflow-bravo",
        workflowTitle: "Workflow Bravo",
        authMode: "secret_manager",
        auth: {
          mode: "secret_manager",
          backend: {
            kind: "aws_secrets_manager",
            region: "us-east-1",
            secretPrefix: "team-prod",
          },
          runtimeAccess: "local_cache",
          manifest: {
            providers: [
              {
                providerSlug: "hubspot",
                secretRef: "team-prod/hubspot/runtime",
              },
            ],
          },
        },
      }),
    ]);

    expect(summary?.backendKind).toBe("aws_secrets_manager");
    expect(summary?.backendTarget).toBe("us-east-1");
    expect(summary?.runtimeAccess).toBe("local_cache");
    expect(summary?.entries[0]).toMatchObject({
      providerSlug: "hubspot",
      connectionId: "Pending connection resolution",
      secretRef: "team-prod/hubspot/runtime",
    });
  });

  it("dedupes repeated secret sync entries across multi-workflow summaries", () => {
    const sharedEntry = {
      providerSlug: "slack",
      connectionId: "conn-shared",
      secretRef: "projects/gtmship-prod/secrets/slack-runtime",
    };
    const summary = buildWorkflowSecretSyncSummary([
      createPlan({
        authMode: "secret_manager",
        auth: {
          mode: "secret_manager",
          backend: {
            kind: "gcp_secret_manager",
            projectId: "gtmship-prod",
          },
          manifest: { providers: [sharedEntry] },
        },
      }),
      createPlan({
        authMode: "secret_manager",
        auth: {
          mode: "secret_manager",
          backend: {
            kind: "gcp_secret_manager",
            projectId: "gtmship-prod",
          },
          manifest: { providers: [sharedEntry] },
        },
      }),
    ]);

    expect(summary?.workflowCount).toBe(1);
    expect(summary?.secretCount).toBe(1);
  });

  it("extracts nested dashboard error messages from json payloads", () => {
    const payload =
      '{"error":"{\\"error\\":\\"Secret-manager deploys are blocked until replicas are healthy.\\"}"}';

    expect(
      extractDashboardErrorMessage(
        payload,
        "Failed to reconcile workflow deployments."
      )
    ).toBe("Secret-manager deploys are blocked until replicas are healthy.");
  });
});
