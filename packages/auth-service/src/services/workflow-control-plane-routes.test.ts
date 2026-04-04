import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "./db.js";
import { deleteWorkflowDeploymentsByWorkflowId } from "./workflow-control-plane-routes.js";

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
