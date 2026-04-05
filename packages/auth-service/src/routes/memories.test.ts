import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMemorySearchWhere,
  rankMemoriesByQuery,
  tokenizeMemoryQuery,
} from "./memories.js";

test("tokenizeMemoryQuery keeps useful keywords and drops connector words", () => {
  assert.deepEqual(tokenizeMemoryQuery("GitHub issues Google Sheets Gmail"), [
    "github",
    "issues",
    "google",
    "sheets",
    "gmail",
  ]);
  assert.deepEqual(tokenizeMemoryQuery("the GitHub issues and Gmail flow"), [
    "github",
    "issues",
    "gmail",
    "flow",
  ]);
});

test("buildMemorySearchWhere preserves filters and broadens multi-keyword search", () => {
  const { where, normalizedQuery, queryTokens } = buildMemorySearchWhere({
    scope: "workflow",
    workflowId: "workflow-demo",
    category: "integration",
    q: "GitHub issues Google Sheets Gmail",
  });

  assert.equal(normalizedQuery, "github issues google sheets gmail");
  assert.deepEqual(queryTokens, [
    "github",
    "issues",
    "google",
    "sheets",
    "gmail",
  ]);
  assert.equal(where.scope, "workflow");
  assert.equal(where.workflowId, "workflow-demo");
  assert.equal(where.category, "integration");
  assert.deepEqual(where.OR, [
    {
      content: {
        contains: "github issues google sheets gmail",
        mode: "insensitive",
      },
    },
    { content: { contains: "github", mode: "insensitive" } },
    { content: { contains: "issues", mode: "insensitive" } },
    { content: { contains: "google", mode: "insensitive" } },
    { content: { contains: "sheets", mode: "insensitive" } },
    { content: { contains: "gmail", mode: "insensitive" } },
  ]);
});

test("rankMemoriesByQuery surfaces the most relevant memory even without an exact phrase match", () => {
  const query = "GitHub issues Google Sheets Gmail";
  const ranked = rankMemoriesByQuery(
    [
      {
        id: "old-github",
        content:
          "GitHub issues endpoint: GET /repos/{owner}/{repo}/issues?state=open&per_page=5&page=1",
        createdAt: new Date("2026-04-04T10:00:00.000Z"),
      },
      {
        id: "newer-gmail",
        content: "Gmail provider uses OAuth with bearer token auth.",
        createdAt: new Date("2026-04-05T10:00:00.000Z"),
      },
      {
        id: "newest-generic",
        content: "Google Sheets rows can be appended via the values API.",
        createdAt: new Date("2026-04-06T10:00:00.000Z"),
      },
    ],
    query.toLowerCase(),
    tokenizeMemoryQuery(query)
  );

  assert.deepEqual(
    ranked.map((memory) => memory.id),
    ["old-github", "newest-generic", "newer-gmail"]
  );
});
