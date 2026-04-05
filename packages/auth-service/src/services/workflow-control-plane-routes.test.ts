import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "./db.js";
import {
  buildAwsExecutionSummaries,
  deleteWorkflowDeploymentsByWorkflowId,
  deriveAwsPlatformMetadata,
  deriveGcpPlatformMetadata,
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
