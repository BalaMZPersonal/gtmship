import { describe, expect, it } from "vitest";
import type { ActiveConnectionRecord } from "./auth-service";
import { buildWorkflowDeploymentPlanForArtifact } from "./deployment";
import type {
  ConnectionAuthStrategyStatus,
  WorkflowStudioArtifact,
} from "./types";

function createArtifact(
  overrides: Partial<WorkflowStudioArtifact> = {}
): WorkflowStudioArtifact {
  return {
    slug: "workflow-alpha",
    title: "Workflow Alpha",
    summary: "A workflow",
    description: "A workflow",
    mermaid: "flowchart LR\n  trigger --> workflow",
    code: `
      import { defineWorkflow, triggers } from "@gtmship/sdk";

      export default defineWorkflow({
        id: "workflow-alpha",
        name: "Workflow Alpha",
        trigger: triggers.manual(),
        run: async () => ({ ok: true }),
      });
    `,
    samplePayload: "{}",
    requiredAccesses: [
      {
        id: "google-sheets-access",
        type: "integration",
        mode: "read",
        label: "Google Sheets",
        purpose: "Read Google Sheets data",
        providerSlug: "google-sheets",
        status: "verified",
      },
    ],
    writeCheckpoints: [],
    chatSummary: "",
    messages: [],
    bindings: [
      {
        providerSlug: "google-sheets",
        selector: {
          type: "latest_active",
        },
      },
    ],
    ...overrides,
  };
}

const activeConnections: ActiveConnectionRecord[] = [
  {
    id: "conn-123",
    label: "Google Sheets Prod",
    createdAt: "2026-04-06T12:00:00.000Z",
    status: "active",
    provider: {
      slug: "google-sheets",
      name: "Google Sheets",
      authType: "oauth2",
    },
  },
];

const authStrategy: ConnectionAuthStrategyStatus = {
  mode: "secret_manager",
  status: "healthy",
  configuredBackends: [
    {
      kind: "gcp_secret_manager",
      projectId: "factors-development",
    },
  ],
  replicaSummary: {
    activeConnections: 1,
    expectedReplicas: 1,
    active: 1,
    pending: 0,
    error: 0,
    missing: 0,
  },
};

describe("buildWorkflowDeploymentPlanForArtifact", () => {
  it("resolves latest_active bindings into secret-manager manifest entries", () => {
    const plan = buildWorkflowDeploymentPlanForArtifact({
      artifact: createArtifact(),
      connections: activeConnections,
      provider: "gcp",
      region: "us-central1",
      gcpProject: "factors-development",
      authStrategy,
    });

    expect(plan.provider).toBe("gcp");
    expect(plan.authMode).toBe("secret_manager");
    expect(plan.bindings[0]).toMatchObject({
      providerSlug: "google-sheets",
      resolvedConnectionId: "conn-123",
      status: "resolved",
    });
    expect(plan.auth?.backend).toMatchObject({
      kind: "gcp_secret_manager",
      projectId: "factors-development",
    });
    expect(plan.auth?.manifest?.providers[0]).toMatchObject({
      providerSlug: "google-sheets",
      connectionId: "conn-123",
      secretRef:
        "projects/factors-development/secrets/gtmship-connections-google-sheets-conn-123-runtime",
    });
  });
});
