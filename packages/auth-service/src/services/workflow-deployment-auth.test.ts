import assert from "node:assert/strict";
import test from "node:test";
import {
  collectDistinctBindingConnectionIds,
  resyncSecretReplicasForBindings,
  workflowDeploymentSecretSyncRuntime,
} from "./workflow-deployment-auth.js";

test("collectDistinctBindingConnectionIds keeps unique non-empty connection ids in order", () => {
  const connectionIds = collectDistinctBindingConnectionIds([
    {
      providerSlug: "hubspot",
      connectionId: "conn_1",
      selectorType: "connection_id",
    },
    {
      providerSlug: "hubspot",
      connectionId: "conn_1",
      selectorType: "connection_id",
    },
    {
      providerSlug: "salesforce",
      connectionId: null,
      selectorType: "latest_active",
    },
    {
      providerSlug: "slack",
      connectionId: "conn_2",
      selectorType: "connection_id",
    },
  ]);

  assert.deepEqual(connectionIds, ["conn_1", "conn_2"]);
});

test("resyncSecretReplicasForBindings syncs each unique bound connection once", async (t) => {
  const originalSync =
    workflowDeploymentSecretSyncRuntime.syncConnectionSecretReplicasById;
  const syncCalls: Array<{
    connectionId: string;
    target: {
      kind: string;
      region?: string;
      projectId?: string;
    };
  }> = [];

  workflowDeploymentSecretSyncRuntime.syncConnectionSecretReplicasById = async (
    connectionId,
    explicitTarget
  ) => {
    syncCalls.push({
      connectionId,
      target: {
        kind: explicitTarget?.kind || "unknown",
        region: explicitTarget?.region || undefined,
        projectId: explicitTarget?.projectId || undefined,
      },
    });
    return [] as never;
  };

  t.after(() => {
    workflowDeploymentSecretSyncRuntime.syncConnectionSecretReplicasById =
      originalSync;
  });

  const result = await resyncSecretReplicasForBindings({
    bindings: [
      {
        providerSlug: "hubspot",
        connectionId: "conn_1",
        selectorType: "connection_id",
      },
      {
        providerSlug: "hubspot",
        connectionId: "conn_1",
        selectorType: "connection_id",
      },
      {
        providerSlug: "slack",
        connectionId: "conn_2",
        selectorType: "connection_id",
      },
    ],
    backend: {
      kind: "aws_secrets_manager",
      region: "us-east-1",
    },
  });

  assert.deepEqual(result, {
    connectionIds: ["conn_1", "conn_2"],
  });
  assert.deepEqual(syncCalls, [
    {
      connectionId: "conn_1",
      target: {
        kind: "aws_secrets_manager",
        region: "us-east-1",
        projectId: undefined,
      },
    },
    {
      connectionId: "conn_2",
      target: {
        kind: "aws_secrets_manager",
        region: "us-east-1",
        projectId: undefined,
      },
    },
  ]);
});
