import { Router } from "express";
import { prisma } from "../services/db.js";

export const memoriesRoutes: Router = Router();

// List memories with optional filters
memoriesRoutes.get("/", async (req, res) => {
  const { scope, workflowId, category, q } = req.query as Record<
    string,
    string | undefined
  >;

  const where: Record<string, unknown> = {};

  if (scope) {
    where.scope = scope;
  }
  if (workflowId) {
    where.workflowId = workflowId;
  }
  if (category) {
    where.category = category;
  }
  if (q) {
    where.content = { contains: q, mode: "insensitive" };
  }

  const memories = await prisma.memory.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  res.json(memories);
});

// Create a memory
memoriesRoutes.post("/", async (req, res) => {
  const { content, category, scope, workflowId, source } = req.body;

  if (!content || typeof content !== "string" || !content.trim()) {
    res.status(400).json({ error: "content is required." });
    return;
  }

  if (scope === "workflow" && !workflowId) {
    res
      .status(400)
      .json({ error: "workflowId is required for workflow-scoped memories." });
    return;
  }

  const memory = await prisma.memory.create({
    data: {
      content: content.trim(),
      category: category || "general",
      scope: scope || "app",
      workflowId: scope === "workflow" ? workflowId : null,
      source: source || "agent",
    },
  });

  res.status(201).json(memory);
});

// Delete a single memory
memoriesRoutes.delete("/:id", async (req, res) => {
  await prisma.memory.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

// Bulk delete memories
memoriesRoutes.delete("/", async (req, res) => {
  const { ids } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: "ids array is required." });
    return;
  }

  await prisma.memory.deleteMany({ where: { id: { in: ids } } });
  res.status(204).end();
});
