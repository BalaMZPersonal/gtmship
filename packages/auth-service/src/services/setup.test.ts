import assert from "node:assert/strict";
import test from "node:test";
import { deriveSetupStatus, type PersistedSetupState } from "./setup.js";

const defaultPreferences: PersistedSetupState = {
  version: 1,
  steps: {},
};

function createStatusInput(overrides?: {
  settings?: Record<string, string | null>;
  secretPresence?: Record<string, boolean>;
  preferences?: PersistedSetupState;
  authStrategy?: {
    mode: "proxy" | "secret_manager";
    status: "healthy" | "degraded" | "migrating";
    configuredBackends: Array<{
      kind: "aws_secrets_manager" | "gcp_secret_manager";
      region?: string | null;
      projectId?: string | null;
      secretPrefix?: string | null;
    }>;
    replicaSummary: {
      activeConnections: number;
      expectedReplicas: number;
      active: number;
      pending: number;
      error: number;
      missing: number;
    };
  };
  sharedOAuth?: {
    google: {
      hasCredentials: boolean;
    };
  };
}) {
  return {
    settings: {
      ai_provider: "claude",
      cloud_provider: "aws",
      ...overrides?.settings,
    },
    secretPresence: {
      anthropic_api_key: false,
      openai_api_key: false,
      aws_secret_access_key: false,
      gcp_service_account_key: false,
      ...overrides?.secretPresence,
    },
    preferences: overrides?.preferences || defaultPreferences,
    authStrategy: overrides?.authStrategy || {
      mode: "proxy" as const,
      status: "healthy" as const,
      configuredBackends: [],
      replicaSummary: {
        activeConnections: 0,
        expectedReplicas: 0,
        active: 0,
        pending: 0,
        error: 0,
        missing: 0,
      },
    },
    sharedOAuth: overrides?.sharedOAuth || {
      google: {
        hasCredentials: false,
      },
    },
  };
}

test("deriveSetupStatus marks proxy mode as ready while AI and cloud stay incomplete by default", () => {
  const status = deriveSetupStatus(createStatusInput());

  assert.equal(status.overallStatus, "incomplete");
  assert.equal(status.steps.find((step) => step.id === "secret_storage")?.status, "complete");
  assert.equal(status.steps.find((step) => step.id === "ai")?.status, "incomplete");
  assert.equal(status.steps.find((step) => step.id === "cloud")?.status, "incomplete");
});

test("deriveSetupStatus treats environment-backed cloud setup as complete", () => {
  const status = deriveSetupStatus(
    createStatusInput({
      preferences: {
        version: 1,
        steps: {
          cloud: {
            skipped: false,
            choice: "environment:gcp",
          },
        },
      },
      settings: {
        cloud_provider: "gcp",
        gcp_project_id: "gtmship-prod",
      },
      secretPresence: {
        anthropic_api_key: true,
        openai_api_key: false,
        aws_secret_access_key: false,
        gcp_service_account_key: false,
      },
    })
  );

  assert.equal(status.steps.find((step) => step.id === "cloud")?.status, "complete");
});

test("deriveSetupStatus blocks secret manager mode without configured backends", () => {
  const status = deriveSetupStatus(
    createStatusInput({
      authStrategy: {
        mode: "secret_manager",
        status: "degraded",
        configuredBackends: [],
        replicaSummary: {
          activeConnections: 1,
          expectedReplicas: 0,
          active: 0,
          pending: 0,
          error: 0,
          missing: 0,
        },
      },
    })
  );

  assert.equal(status.steps.find((step) => step.id === "secret_storage")?.status, "blocked");
});
