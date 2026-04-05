# Memory Search Reference

Verified on April 5, 2026 against the local GTMShip auth service at `http://localhost:4000`.

## Behavior

- Memory search still respects `scope`, `workflowId`, and `category` filters.
- Text queries use case-insensitive phrase and keyword matching.
- Results are ranked by relevance first, then by recency when relevance ties.
- The auth service returns up to 50 ranked matches per request.

Implementation reference:

- [packages/auth-service/src/routes/memories.ts](/Users/bala/gtmship/packages/auth-service/src/routes/memories.ts)
- [packages/auth-service/src/routes/memories.test.ts](/Users/bala/gtmship/packages/auth-service/src/routes/memories.test.ts)

## CLI Verification

Commands used from the repo root:

```bash
node packages/cli/dist/index.js memories list --query "GitHub issues Google Sheets Gmail" --json
node packages/cli/dist/index.js memories list --query "GitHub issues"
```

Observed result for the mixed query:

- The CLI returned 5 memories instead of `0 found`.
- The top-ranked result was the GitHub issues endpoint memory:

```text
GitHub issues endpoint: GET /repos/{owner}/{repo}/issues?state=open&per_page=5&page=1
```

- Additional ranked matches included GitHub repo context, Google Sheets append, GitHub integration auth, and Gmail send endpoint memories.

## Why This Fix Matters

The earlier behavior required the full query string to appear contiguously in one memory record. A query like `GitHub issues Google Sheets Gmail` therefore missed relevant memories unless one entry contained that exact phrase. The current behavior surfaces partial matches across the query terms and ranks the most relevant memory first.
