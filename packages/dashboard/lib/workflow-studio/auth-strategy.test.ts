import { describe, expect, it } from "vitest";
import { applyGlobalAuthStrategyToPlan } from "./auth-strategy";
import type { WorkflowDeploymentPlan } from "./types";

function createPlan(
  overrides: Partial<WorkflowDeploymentPlan>
): WorkflowDeploymentPlan {
  return {
    workflowId: "workflow-alpha",
    workflowTitle: "Workflow Alpha",
    provider: "aws",
    region: "us-east-1",
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

describe("applyGlobalAuthStrategyToPlan", () => {
  it("keeps local deployments on proxy auth", () => {
    const plan = applyGlobalAuthStrategyToPlan(
      createPlan({
        provider: "local",
        region: "local",
        authMode: "secret_manager",
        auth: {
          mode: "secret_manager",
        },
      }),
      {
        mode: "secret_manager",
        status: "healthy",
        configuredBackends: [],
        replicaSummary: {
          activeConnections: 0,
          expectedReplicas: 0,
          active: 0,
          pending: 0,
          error: 0,
          missing: 0,
        },
      }
    );

    expect(plan.authMode).toBe("proxy");
    expect(plan.auth?.mode).toBe("proxy");
  });

  it("forces cloud plans onto secret_manager when settings are still proxy", () => {
    const plan = applyGlobalAuthStrategyToPlan(createPlan({}), {
      mode: "proxy",
      status: "healthy",
      configuredBackends: [],
      replicaSummary: {
        activeConnections: 0,
        expectedReplicas: 0,
        active: 0,
        pending: 0,
        error: 0,
        missing: 0,
      },
    });

    expect(plan.authMode).toBe("secret_manager");
    expect(plan.auth?.mode).toBe("secret_manager");
    expect(plan.warnings).toContain(
      "Cloud deployments to AWS always use secret_manager auth. Enable Secret manager in Settings before deploying this workflow."
    );
  });
});
