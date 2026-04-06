import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "./db.js";
import {
  connectionSecretSyncRuntime,
  enqueueConnectionSecretSyncs,
  reconcileStaleConnectionSecretReplicas,
  resetConnectionSecretSyncRuntimeStateForTests,
} from "./auth-strategy.js";

test("enqueueConnectionSecretSyncs marks pending replicas once and schedules background sync", async (t) => {
  resetConnectionSecretSyncRuntimeStateForTests();

  const prismaClient = prisma as any;
  const originalFindUnique = prismaClient.setting.findUnique;
  const originalMarkPending =
    connectionSecretSyncRuntime.markConnectionSecretReplicasPendingById;
  const originalSync =
    connectionSecretSyncRuntime.syncConnectionSecretReplicasById;
  const syncedConnectionIds: string[] = [];

  prismaClient.setting.findUnique = (async () =>
    ({ value: "secret_manager" })) as any;
  connectionSecretSyncRuntime.markConnectionSecretReplicasPendingById = async (
    connectionId
  ) =>
    [
      {
        id: `replica-${connectionId}`,
        connectionId,
      },
    ] as never;
  connectionSecretSyncRuntime.syncConnectionSecretReplicasById = async (
    connectionId
  ) => {
    syncedConnectionIds.push(connectionId);
    return [] as never;
  };

  t.after(() => {
    prismaClient.setting.findUnique = originalFindUnique;
    connectionSecretSyncRuntime.markConnectionSecretReplicasPendingById =
      originalMarkPending;
    connectionSecretSyncRuntime.syncConnectionSecretReplicasById = originalSync;
    resetConnectionSecretSyncRuntimeStateForTests();
  });

  const pending = await enqueueConnectionSecretSyncs([
    "conn_1",
    "conn_1",
    "conn_2",
  ]);

  assert.equal(pending.length, 2);

  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(syncedConnectionIds.sort(), ["conn_1", "conn_2"]);
});

test("reconcileStaleConnectionSecretReplicas retries unique stale replica targets", async (t) => {
  resetConnectionSecretSyncRuntimeStateForTests();

  const prismaClient = prisma as any;
  const originalFindUnique = prismaClient.setting.findUnique;
  const originalFindMany = prismaClient.connectionSecretReplica.findMany;
  const originalSync =
    connectionSecretSyncRuntime.syncConnectionSecretReplicasById;
  const syncCalls: Array<{
    connectionId: string;
    target:
      | {
          kind: string;
          region?: string;
          projectId?: string;
        }
      | undefined;
  }> = [];

  prismaClient.setting.findUnique = (async () =>
    ({ value: "secret_manager" })) as any;
  prismaClient.connectionSecretReplica.findMany = (async () =>
    [
      {
        connectionId: "conn_1",
        backendKind: "aws_secrets_manager",
        backendRegion: "us-east-1",
        backendProjectId: "",
      },
      {
        connectionId: "conn_1",
        backendKind: "aws_secrets_manager",
        backendRegion: "us-east-1",
        backendProjectId: "",
      },
      {
        connectionId: "conn_2",
        backendKind: "gcp_secret_manager",
        backendRegion: "",
        backendProjectId: "gtmship-prod",
      },
      {
        connectionId: "conn_3",
        backendKind: "unsupported_backend",
        backendRegion: "",
        backendProjectId: "",
      },
    ]) as any;
  connectionSecretSyncRuntime.syncConnectionSecretReplicasById = async (
    connectionId,
    explicitTarget
  ) => {
    syncCalls.push({
      connectionId,
      target: explicitTarget
        ? {
            kind: explicitTarget.kind,
            region: explicitTarget.region || undefined,
            projectId: explicitTarget.projectId || undefined,
          }
        : undefined,
    });
    return [] as never;
  };

  t.after(() => {
    prismaClient.setting.findUnique = originalFindUnique;
    prismaClient.connectionSecretReplica.findMany = originalFindMany;
    connectionSecretSyncRuntime.syncConnectionSecretReplicasById = originalSync;
    resetConnectionSecretSyncRuntimeStateForTests();
  });

  const result = await reconcileStaleConnectionSecretReplicas({ limit: 10 });

  assert.deepEqual(result, {
    queued: 2,
    scanned: 4,
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
        kind: "gcp_secret_manager",
        region: undefined,
        projectId: "gtmship-prod",
      },
    },
  ]);
});
