import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "./db.js";
import {
  buildAwsExecutionSummaries,
  buildLocalExecutionSummaries,
  deleteWorkflowDeploymentsByWorkflowId,
  deriveAwsPlatformMetadata,
  deriveGcpPlatformMetadata,
  deriveLocalPlatformMetadata,
  preflightDeploymentAuthRecords,
  prepareDeploymentSyncRecords,
} from "./workflow-control-plane-routes.js";

test("deleteWorkflowDeploymentsByWorkflowId returns the deleted deployment count", async (t) => {
  const prismaClient = prisma as unknown as {
    $queryRaw: (...args: unknown[]) => Promise<Array<{ id: string }>>;
  };
  const originalQueryRaw = prismaClient.$queryRaw;

  prismaClient.$queryRaw = async () => [{ id: "wd_1" }, { id: "wd_2" }];

  t.after(async () => {
    prismaClient.$queryRaw = originalQueryRaw;
    await prisma.$disconnect();
  });

  const result = await deleteWorkflowDeploymentsByWorkflowId("workflow-demo");

  assert.deepEqual(result, {
    deletedDeploymentCount: 2,
  });
});

test("deriveAwsPlatformMetadata prefers runtime inventory fields and builds a log group fallback", () => {
  const deployment = {
    provider: "aws",
    region: "us-east-1",
    endpointUrl: "lambda:workflow-worker",
    schedulerId: "schedule-1",
    resourceInventory: {
      runtimeTarget: {
        computeType: "lambda",
        computeName: "workflow-worker",
        endpointUrl: "lambda:workflow-worker",
        schedulerId: "schedule-1",
        region: "us-east-1",
      },
      platformOutputs: {
        lambdaArn:
          "arn:aws:lambda:us-east-1:123456789012:function:workflow-worker",
      },
    },
  } as any;

  assert.deepEqual(deriveAwsPlatformMetadata(deployment), {
    computeType: "lambda",
    computeName: "workflow-worker",
    endpointUrl: "lambda:workflow-worker",
    schedulerJobId: "schedule-1",
    region: "us-east-1",
    logGroupName: "/aws/lambda/workflow-worker",
  });
});

test("deriveGcpPlatformMetadata keeps the current cloud run mapping intact", () => {
  const deployment = {
    executionKind: "job",
    region: "us-central1",
    gcpProject: "demo-project",
    endpointUrl: "job:workflow-job",
    schedulerId: "scheduler-1",
    resourceInventory: {
      platformOutputs: {
        serviceId:
          "projects/demo-project/locations/us-central1/jobs/workflow-job",
      },
    },
  } as any;

  assert.deepEqual(deriveGcpPlatformMetadata(deployment), {
    computeType: "job",
    computeName: "workflow-job",
    endpointUrl: "job:workflow-job",
    schedulerJobId: "scheduler-1",
    region: "us-central1",
    gcpProject: "demo-project",
  });
});

test("deriveLocalPlatformMetadata reads local runtime metadata from the deployment inventory", () => {
  const deployment = {
    workflowId: "workflow-local",
    provider: "local",
    region: "local",
    endpointUrl: "local://workflow-local",
    schedulerId: "gtmship-workflow-dispatch.timer",
    resourceInventory: {
      runtimeTarget: {
        computeType: "job",
        computeName: "workflow-local",
        endpointUrl: "local://workflow-local",
        schedulerId: "gtmship-workflow-dispatch.timer",
        region: "local",
        logPath: "/tmp/workflow-local.log",
      },
      platformOutputs: {
        localLogPath: "/tmp/workflow-local.log",
      },
    },
  } as any;

  assert.deepEqual(deriveLocalPlatformMetadata(deployment), {
    computeType: "job",
    computeName: "workflow-local",
    endpointUrl: "local://workflow-local",
    schedulerJobId: "gtmship-workflow-dispatch.timer",
    region: "local",
    logPath: "/tmp/workflow-local.log",
  });
});

test("buildAwsExecutionSummaries groups lambda request ids into recent runs", () => {
  const summaries = buildAwsExecutionSummaries(
    [
      {
        timestamp: "2026-04-05T10:00:00.000Z",
        level: "info",
        message: "START RequestId: req-1 Version: $LATEST",
        requestId: "req-1",
        executionName: "req-1",
      },
      {
        timestamp: "2026-04-05T10:00:01.000Z",
        level: "info",
        message: "REPORT RequestId: req-1 Duration: 12 ms",
        requestId: "req-1",
        executionName: "req-1",
      },
      {
        timestamp: "2026-04-05T10:05:00.000Z",
        level: "info",
        message: "START RequestId: req-2 Version: $LATEST",
        requestId: "req-2",
        executionName: "req-2",
      },
      {
        timestamp: "2026-04-05T10:05:01.000Z",
        level: "error",
        message: "Task timed out after 60.00 seconds RequestId: req-2",
        requestId: "req-2",
        executionName: "req-2",
      },
    ],
    5
  );

  assert.equal(summaries.length, 2);
  assert.deepEqual(
    summaries.map((summary) => ({
      executionName: summary.executionName,
      status: summary.status,
    })),
    [
      { executionName: "req-2", status: "failure" },
      { executionName: "req-1", status: "success" },
    ]
  );
});

test("buildLocalExecutionSummaries maps workflow runs into recent local executions", () => {
  const summaries = buildLocalExecutionSummaries(
    [
      {
        id: "wr-2",
        deploymentId: "wd-local",
        executionId: "local_run_2",
        triggerSource: "schedule",
        status: "failure",
        cloudRef: "local:local_run_2",
        startedAt: new Date("2026-04-05T10:05:00.000Z"),
        endedAt: new Date("2026-04-05T10:05:03.000Z"),
        requestPayload: null,
        responsePayload: null,
        error: { message: "boom" },
        createdAt: new Date("2026-04-05T10:05:00.000Z"),
        updatedAt: new Date("2026-04-05T10:05:03.000Z"),
      },
      {
        id: "wr-1",
        deploymentId: "wd-local",
        executionId: "local_run_1",
        triggerSource: "manual",
        status: "success",
        cloudRef: "local:local_run_1",
        startedAt: new Date("2026-04-05T10:00:00.000Z"),
        endedAt: new Date("2026-04-05T10:00:02.000Z"),
        requestPayload: null,
        responsePayload: { ok: true },
        error: null,
        createdAt: new Date("2026-04-05T10:00:00.000Z"),
        updatedAt: new Date("2026-04-05T10:00:02.000Z"),
      },
    ] as any,
    5
  );

  assert.deepEqual(
    summaries.map((summary) => ({
      executionName: summary.executionName,
      status: summary.status,
      triggerSource: summary.triggerSource,
    })),
    [
      {
        executionName: "local_run_2",
        status: "failure",
        triggerSource: "schedule",
      },
      {
        executionName: "local_run_1",
        status: "success",
        triggerSource: "manual",
      },
    ]
  );
});

test("preflightDeploymentAuthRecords keeps local deployments on proxy auth without backend checks", async (t) => {
  const prismaClient = prisma as unknown as {
    setting: {
      findUnique: (args: unknown) => Promise<{ value: string } | null>;
    };
  };
  const originalFindUnique = prismaClient.setting.findUnique;

  prismaClient.setting.findUnique = async () => ({ value: "proxy" });

  t.after(async () => {
    prismaClient.setting.findUnique = originalFindUnique;
    await prisma.$disconnect();
  });

  const result = await preflightDeploymentAuthRecords([
    {
      workflowId: "workflow-demo",
      provider: "local",
      bindings: [
        {
          providerSlug: "slack",
          selectorType: "latest_active",
        },
      ],
    },
  ]);

  assert.deepEqual(result, {
    authMode: "proxy",
    deployments: [
      {
        workflowId: "workflow-demo",
        provider: "local",
        authBackendKind: null,
        authBackendRegion: null,
        authBackendProjectId: null,
        checkedBindings: 1,
      },
    ],
  });
});

test("preflightDeploymentAuthRecords rejects cloud deployments while auth strategy is proxy", async (t) => {
  const prismaClient = prisma as unknown as {
    setting: {
      findUnique: (args: unknown) => Promise<{ value: string } | null>;
    };
  };
  const originalFindUnique = prismaClient.setting.findUnique;

  prismaClient.setting.findUnique = async () => ({ value: "proxy" });

  t.after(async () => {
    prismaClient.setting.findUnique = originalFindUnique;
    await prisma.$disconnect();
  });

  await assert.rejects(
    () =>
      preflightDeploymentAuthRecords([
        {
          workflowId: "workflow-demo",
          provider: "aws",
          bindings: [],
        },
      ]),
    /Cloud deployments require secret_manager auth/
  );
});

test("prepareDeploymentSyncRecords keeps local deployments outside secret-manager preflight work", async () => {
  const result = await prepareDeploymentSyncRecords(
    [
      {
        workflowId: "workflow-local",
        provider: "local",
        executionKind: "job",
        bindings: [],
        status: "active",
      },
    ],
    "proxy",
  );

  assert.deepEqual(result, [
    {
      workflowId: "workflow-local",
      provider: "local",
      executionKind: "job",
      region: null,
      gcpProject: null,
      workflowVersion: null,
      authMode: "proxy",
      authBackend: null,
      authRuntimeAccess: null,
      runtimeAuthManifest: null,
      triggerType: null,
      triggerConfig: undefined,
      resourceInventory: undefined,
      endpointUrl: null,
      schedulerId: null,
      eventTriggerId: null,
      status: "active",
      deployedAt: null,
      bindings: [],
      bindingsProvided: true,
    },
  ]);
});
