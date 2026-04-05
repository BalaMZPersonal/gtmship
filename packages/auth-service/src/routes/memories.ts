import type { Memory, Prisma } from "@prisma/client";
import { Router } from "express";
import { prisma } from "../services/db.js";

export const memoriesRoutes: Router = Router();
const MEMORY_SEARCH_RESULT_LIMIT = 50;
const MEMORY_SEARCH_CANDIDATE_LIMIT = 200;
const MEMORY_QUERY_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "via",
  "with",
]);

type MemorySearchFilters = {
  scope?: string;
  workflowId?: string;
  category?: string;
  q?: string;
};

function normalizeMemoryQuery(query?: string): string {
  return (query || "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function tokenizeMemoryQuery(query?: string): string[] {
  const tokens = normalizeMemoryQuery(query).match(/[a-z0-9]+/g) || [];
  return [...new Set(tokens)].filter(
    (token) => token.length >= 2 && !MEMORY_QUERY_STOP_WORDS.has(token)
  );
}

export function buildMemorySearchWhere({
  scope,
  workflowId,
  category,
  q,
}: MemorySearchFilters): {
  where: Prisma.MemoryWhereInput;
  normalizedQuery: string;
  queryTokens: string[];
} {
  const normalizedQuery = normalizeMemoryQuery(q);
  const queryTokens = tokenizeMemoryQuery(normalizedQuery);
  const where: Prisma.MemoryWhereInput = {};

  if (scope) {
    where.scope = scope;
  }
  if (workflowId) {
    where.workflowId = workflowId;
  }
  if (category) {
    where.category = category;
  }
  if (normalizedQuery) {
    const clauses: Prisma.MemoryWhereInput[] = [
      {
        content: { contains: normalizedQuery, mode: "insensitive" },
      },
      ...queryTokens
        .filter((token) => token !== normalizedQuery)
        .map((token) => ({
          content: { contains: token, mode: "insensitive" as const },
        })),
    ];
    where.OR = clauses;
  }

  return { where, normalizedQuery, queryTokens };
}

function scoreMemoryMatch(
  memory: Pick<Memory, "content">,
  normalizedQuery: string,
  queryTokens: string[]
): number {
  const content = memory.content.toLowerCase();
  let score = 0;

  if (normalizedQuery && content.includes(normalizedQuery)) {
    score += 100;
  }

  for (const [index, token] of queryTokens.entries()) {
    if (content.includes(token)) {
      score += Math.max(queryTokens.length - index, 1) * 5;
    }
  }

  return score;
}

export function rankMemoriesByQuery<T extends Pick<Memory, "content" | "createdAt">>(
  memories: T[],
  normalizedQuery: string,
  queryTokens: string[]
): T[] {
  if (!normalizedQuery) {
    return memories;
  }

  return [...memories].sort((left, right) => {
    const scoreDelta =
      scoreMemoryMatch(right, normalizedQuery, queryTokens) -
      scoreMemoryMatch(left, normalizedQuery, queryTokens);

    if (scoreDelta !== 0) {
      return scoreDelta;
    }

    return (
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
    );
  });
}

// List memories with optional filters
memoriesRoutes.get("/", async (req, res) => {
  const { scope, workflowId, category, q } = req.query as MemorySearchFilters;
  const { where, normalizedQuery, queryTokens } = buildMemorySearchWhere({
    scope,
    workflowId,
    category,
    q,
  });

  const memories = await prisma.memory.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: normalizedQuery
      ? MEMORY_SEARCH_CANDIDATE_LIMIT
      : MEMORY_SEARCH_RESULT_LIMIT,
  });

  const rankedMemories = normalizedQuery
    ? rankMemoriesByQuery(memories, normalizedQuery, queryTokens).slice(
        0,
        MEMORY_SEARCH_RESULT_LIMIT
      )
    : memories;

  res.json(rankedMemories);
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
