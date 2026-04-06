/**
 * Workflow Heuristic Knowledge Base
 *
 * Derived from common GTM workflow shapes, but intentionally generalized so the
 * agent reasons about reusable workflow capabilities instead of overly specific
 * playbooks. Examples: persistent state, deduplication, batching, routing,
 * staged handoffs, validation gates, writeback, and approvals.
 */

export interface GtmPatternCodeGuidance {
  description: string;
  triggerType: "manual" | "schedule" | "webhook";
  pseudocode: string;
}

export interface GtmPattern {
  id: string;
  name: string;
  category:
    | "state"
    | "reliability"
    | "analysis"
    | "orchestration"
    | "data-quality"
    | "delivery";
  description: string;
  whenToUse: string[];
  whenNotToUse: string[];
  intentKeywords: string[];
  integrationsInvolved: string[];
  analysisGuidance: string;
  codeGuidance: GtmPatternCodeGuidance;
  combinableWith: string[];
}

export interface GtmPatternMatch {
  pattern: GtmPattern;
  relevanceScore: number;
  matchedKeywords: string[];
}

export const GTM_PATTERNS: GtmPattern[] = [
  {
    id: "persistent-state-storage",
    name: "Persistent State Storage",
    category: "state",
    description:
      "When a workflow must remember prior runs, buffer work, or keep an audit trail, introduce a durable storage layer and keep the stored schema minimal.",
    whenToUse: [
      "The workflow needs memory across runs or between stages",
      "Data should be saved for later review, retries, batching, or auditability",
      "The workflow needs a staging area, queue, backlog, or tracking table",
    ],
    whenNotToUse: [
      "The workflow is fully stateless and completes from a single payload",
      "No later run needs to read anything produced by the current run",
      "The user explicitly wants one-pass processing with no retained state",
    ],
    intentKeywords: [
      "storage",
      "datastore",
      "database",
      "sheet",
      "table",
      "persist",
      "persistent state",
      "save for later",
      "tracking store",
      "queue",
      "backlog",
      "history",
      "audit trail",
      "staging area",
      "stateful",
    ],
    integrationsInvolved: ["google-sheets", "airtable", "notion"],
    analysisGuidance:
      "If the workflow needs memory, buffering, or an audit trail, include one writable storage integration. Prefer an already active provider that behaves like a table or list. Read it early, write it late, and store only stable keys, statuses, timestamps, and the minimum metadata needed for later steps.",
    codeGuidance: {
      description:
        "Initialize a storage client, read current state, derive the next set of records to process or save, then persist a compact record after successful work completes.",
      triggerType: "manual",
      pseudocode: `const storage = await ctx.integration("<storage-provider>");
const { data: existing } = await storage.read("<read-state>");
const records = Array.isArray(existing.items) ? existing.items : [];
// Build state index, backlog, or staging view
// ... fetch or compute new work ...
await storage.write("<write-state>", {
  method: "POST",
  body: { items: nextRecords },
  checkpoint: "persist-workflow-state"
});`,
    },
    combinableWith: [
      "idempotent-deduplication",
      "batch-aggregation",
      "staged-pipeline-handoff",
    ],
  },

  {
    id: "idempotent-deduplication",
    name: "Idempotent Deduplication",
    category: "reliability",
    description:
      "When duplicate inputs are possible, derive a stable key, check whether it has already been handled, and only mark it processed after the workflow succeeds.",
    whenToUse: [
      "The same lead, account, contact, or event may arrive more than once",
      "The user mentions skipping repeats, avoiding duplicate alerts, or processing each entity once",
      "A recurring job scans a feed and should ignore items handled earlier",
    ],
    whenNotToUse: [
      "Every occurrence must be processed even if it looks similar",
      "The upstream source already guarantees exactly-once delivery and the user trusts it",
      "The workflow has no meaningful stable key for deduplication",
    ],
    intentKeywords: [
      "dedup",
      "deduplicate",
      "duplicate",
      "idempotent",
      "already processed",
      "already alerted",
      "skip seen",
      "skip repeats",
      "once only",
      "no duplicates",
      "seen before",
      "avoid repeat",
    ],
    integrationsInvolved: [],
    analysisGuidance:
      "Use a stable dedupe key such as domain, email, record id, or event id. Check it before expensive reads, AI calls, or external writes. Mark the item processed only after the workflow finishes the intended side effects. This usually pairs with a persistent storage heuristic.",
    codeGuidance: {
      description:
        "Build a processed-key index, filter incoming records against it, process only the new items, and then persist the newly completed keys.",
      triggerType: "schedule",
      pseudocode: `const seenKeys = new Set(existingState.map((row) => row.key));
const pending = incomingItems.filter((item) => !seenKeys.has(item.key));
if (pending.length === 0) {
  return { processed: 0, skipped: incomingItems.length };
}
// ... process pending items ...
await storage.write("<write-state>", {
  method: "POST",
  body: { keys: pending.map((item) => item.key) },
  checkpoint: "mark-items-processed"
});`,
    },
    combinableWith: [
      "persistent-state-storage",
      "batch-aggregation",
      "system-of-record-writeback",
    ],
  },

  {
    id: "batch-aggregation",
    name: "Batch Aggregation",
    category: "analysis",
    description:
      "If multiple records contribute to one insight or one outbound action, collect them into a batch first instead of treating every item as a separate workflow outcome.",
    whenToUse: [
      "The user wants a digest, rollup, summary, batch review, or grouped analysis",
      "Many records should feed one AI call, one report, or one notification",
      "The workflow should detect patterns across a set of records rather than act on each row independently",
    ],
    whenNotToUse: [
      "Each record genuinely needs its own independent alert or AI response",
      "The workflow is triggered by one high-value event that should be handled immediately",
      "No grouped reasoning or grouped output is needed",
    ],
    intentKeywords: [
      "batch",
      "aggregate",
      "group",
      "digest",
      "summary",
      "rollup",
      "recap",
      "briefing",
      "compile",
      "collect then analyze",
      "periodic report",
      "combined analysis",
    ],
    integrationsInvolved: [],
    analysisGuidance:
      "When many records feed one decision or summary, read them into a bounded batch, transform them into structured context, and generate one combined result. Avoid one AI call, one Slack post, or one email per row unless the user explicitly wants per-record output.",
    codeGuidance: {
      description:
        "Fetch a bounded set of records, normalize them into one structured array or text block, and produce one combined analysis or outbound message.",
      triggerType: "schedule",
      pseudocode: `const rows = Array.isArray(sourceRows) ? sourceRows : [];
if (rows.length === 0) {
  return { sent: false, reason: "no-data" };
}
const context = rows
  .map((row) => \`- \${row.name}: \${row.summary}\`)
  .join("\\n");
const { text } = await ctx.ai.generate({
  providerSlug: "<ai-provider>",
  model: "<model>",
  prompt: \`Analyze this batch:\\n\${context}\`
});
// send or persist one combined result`,
    },
    combinableWith: [
      "persistent-state-storage",
      "staged-ai-processing",
      "staged-pipeline-handoff",
    ],
  },

  {
    id: "staged-ai-processing",
    name: "Staged AI Processing",
    category: "analysis",
    description:
      "If AI must do more than one job, split the work into smaller passes like extraction, classification, scoring, and recommendation instead of one oversized prompt.",
    whenToUse: [
      "The workflow needs structured extraction plus reasoning plus recommendations",
      "The user wants qualification, classification, scoring, and tailored follow-up from the same input",
      "The AI result has multiple dimensions and would be hard to validate as one monolithic response",
    ],
    whenNotToUse: [
      "A single narrow AI task is enough, such as one summary or one classification",
      "The workflow is deterministic and does not need LLM reasoning",
      "The user explicitly wants the simplest possible AI step",
    ],
    intentKeywords: [
      "classify",
      "extract",
      "score",
      "qualify",
      "recommend",
      "talking points",
      "fit score",
      "intent score",
      "multi-step ai",
      "multiple ai calls",
      "enrich with ai",
      "reasoning chain",
    ],
    integrationsInvolved: [],
    analysisGuidance:
      "Use one AI call per distinct concern when the workflow needs structured extraction, classification, scoring, or recommendations. Keep intermediate outputs small and reusable. If a single AI step is enough, do not force multiple calls.",
    codeGuidance: {
      description:
        "Start with extraction/classification, then pass the structured result into later scoring or recommendation steps.",
      triggerType: "manual",
      pseudocode: `const extraction = await ctx.ai.generate({
  providerSlug: "<ai-provider>",
  model: "<model>",
  responseFormat: "json",
  prompt: "Extract the key fields from the input."
});
const scoring = await ctx.ai.generate({
  providerSlug: "<ai-provider>",
  model: "<model>",
  responseFormat: "json",
  input: extraction.json,
  prompt: "Score and classify this structured result."
});
const recommendation = await ctx.ai.generate({
  providerSlug: "<ai-provider>",
  model: "<model>",
  input: scoring.json,
  prompt: "Recommend next actions."
});`,
    },
    combinableWith: [
      "batch-aggregation",
      "routing-and-branching",
      "system-of-record-writeback",
    ],
  },

  {
    id: "routing-and-branching",
    name: "Routing and Branching",
    category: "orchestration",
    description:
      "When inputs differ by segment, score, region, owner, or intent, compute a route once and keep branch logic explicit.",
    whenToUse: [
      "Different records need different handlers, channels, or enrichment paths",
      "The user mentions routing, branching, segments, priorities, or different actions by category",
      "Different destinations or write steps apply based on a computed result",
    ],
    whenNotToUse: [
      "All records should follow the same path",
      "The only decision is whether to continue or stop",
      "The user has not described any meaningful branching logic",
    ],
    intentKeywords: [
      "route",
      "routing",
      "branch",
      "conditional",
      "if else",
      "segment",
      "tier",
      "priority",
      "owner",
      "region",
      "stage",
      "different path",
    ],
    integrationsInvolved: [],
    analysisGuidance:
      "Read the data required to compute the route, calculate the route once, and keep branch conditions simple and inspectable. If different branches write to different systems, each branch needs its own verified access and write checkpoint.",
    codeGuidance: {
      description:
        "Compute the route early and isolate the branch-specific integration work inside clear condition blocks.",
      triggerType: "manual",
      pseudocode: `const route =
  payload.priority === "high" ? "high-priority"
  : payload.segment === "enterprise" ? "enterprise"
  : "default";

switch (route) {
  case "high-priority":
    // fast-path actions
    break;
  case "enterprise":
    // enterprise-specific enrichment or routing
    break;
  default:
    // standard handling
    break;
}`,
    },
    combinableWith: [
      "staged-ai-processing",
      "system-of-record-writeback",
      "approval-before-side-effects",
    ],
  },

  {
    id: "delay-and-recheck",
    name: "Delay and Recheck",
    category: "reliability",
    description:
      "If a follow-up action may happen shortly after an event, or if upstream systems need time to settle, wait briefly and then re-check instead of acting immediately.",
    whenToUse: [
      "The user wants to detect non-events or incomplete actions after a short window",
      "An external system has eventual consistency and immediate reads are unreliable",
      "A small grace period can prevent false positives or duplicate follow-up",
    ],
    whenNotToUse: [
      "The workflow must act immediately on every event",
      "The wait window is long enough that a staged pipeline would be cleaner",
      "No re-check or follow-up verification is needed",
    ],
    intentKeywords: [
      "wait",
      "delay",
      "sleep",
      "grace period",
      "cooldown",
      "recheck",
      "check later",
      "eventual consistency",
      "abandonment",
      "did not complete",
      "follow up after",
    ],
    integrationsInvolved: [],
    analysisGuidance:
      "Use a short delay only when it improves correctness. After the wait, perform a targeted verification read. For longer windows or higher volume, prefer a staged handoff through storage or a queue instead of holding a run open.",
    codeGuidance: {
      description:
        "Receive the event, wait for a bounded period, re-read the relevant source of truth, and continue only if the expected follow-up did not occur.",
      triggerType: "webhook",
      pseudocode: `await new Promise((resolve) => setTimeout(resolve, 60_000));
const verification = await source.read("<check-follow-up>");
const completed = Boolean(verification.data?.completed);
if (completed) {
  return { handled: false, reason: "follow-up-observed" };
}
// continue with the fallback or alert path`,
    },
    combinableWith: [
      "routing-and-branching",
      "approval-before-side-effects",
      "staged-pipeline-handoff",
    ],
  },

  {
    id: "staged-pipeline-handoff",
    name: "Staged Pipeline Handoff",
    category: "orchestration",
    description:
      "If the workflow mixes real-time ingestion with heavier analysis or outbound actions, split the flow into stages and hand off work through durable state.",
    whenToUse: [
      "The workflow has a fast ingestion step and a slower analysis or writeback step",
      "The user wants to accumulate data before downstream processing",
      "A single end-to-end run would be too slow, fragile, or hard to retry",
    ],
    whenNotToUse: [
      "The workflow is simple and can run safely in one pass",
      "The user needs truly immediate end-to-end handling",
      "There is no meaningful boundary between intake and later processing",
    ],
    intentKeywords: [
      "two stage",
      "multi stage",
      "pipeline",
      "handoff",
      "collect then analyze",
      "ingest then process",
      "accumulate",
      "buffer",
      "queue",
      "timeout",
      "stage 1",
      "stage 2",
    ],
    integrationsInvolved: [],
    analysisGuidance:
      "Recommend separate stages when ingestion speed, retries, and downstream processing have different needs. Use durable storage or a queue between stages. The first stage should validate and persist; the later stage should batch, analyze, and perform side effects.",
    codeGuidance: {
      description:
        "Stage 1 persists normalized inputs. Stage 2 reads pending work, processes it, and updates state after success.",
      triggerType: "webhook",
      pseudocode: `// Stage 1: intake
await storage.write("<append-pending>", {
  method: "POST",
  body: { item: normalizedInput, status: "pending" },
  checkpoint: "persist-pending-item"
});

// Stage 2: separate run
const { data: pending } = await storage.read("<read-pending>");
// process pending items, then mark them complete`,
    },
    combinableWith: [
      "persistent-state-storage",
      "batch-aggregation",
      "idempotent-deduplication",
    ],
  },

  {
    id: "system-of-record-writeback",
    name: "System of Record Writeback",
    category: "delivery",
    description:
      "If the workflow produces a score, classification, enrichment, or next action that belongs in a source-of-truth system, write it back explicitly and safely.",
    whenToUse: [
      "The user wants workflow results saved on accounts, leads, contacts, or tickets",
      "A CRM or other system of record should store the outcome for later human use",
      "The workflow computes structured output that should persist beyond the run",
    ],
    whenNotToUse: [
      "The result is only ephemeral and belongs in a notification",
      "The workflow reads from the system of record but should not modify it",
      "There is no durable destination that should own the result",
    ],
    intentKeywords: [
      "writeback",
      "update record",
      "patch field",
      "save score",
      "persist result",
      "sync back",
      "update crm",
      "update salesforce",
      "update hubspot",
      "write to source system",
    ],
    integrationsInvolved: ["salesforce", "hubspot"],
    analysisGuidance:
      "Treat system-of-record writes as the final side effect. Read first to locate the target record if needed, transform the payload into explicit fields, and perform the write behind a checkpoint. Keep the write payload narrow and deterministic.",
    codeGuidance: {
      description:
        "Read or resolve the destination record, build a field-level payload, then write the result back with an explicit checkpoint.",
      triggerType: "manual",
      pseudocode: `const system = await ctx.integration("<system-of-record>");
const { data: record } = await system.read("<find-record>");
if (!record?.id) {
  return { updated: false, reason: "record-not-found" };
}
await system.write("<update-record>", {
  method: "PATCH",
  body: { score: result.score, classification: result.classification },
  checkpoint: "write-result-back"
});`,
    },
    combinableWith: [
      "staged-ai-processing",
      "data-quality-gate",
      "approval-before-side-effects",
    ],
  },

  {
    id: "data-quality-gate",
    name: "Data Quality Gate",
    category: "data-quality",
    description:
      "Before outbound messaging, enrichment, or writeback, validate and normalize the incoming records so bad data does not propagate downstream.",
    whenToUse: [
      "Input data may be incomplete, invalid, scraped, or inconsistent",
      "The workflow sends messages, creates records, or updates systems using user/contact/account data",
      "The user mentions validation, hygiene, normalization, or standardization",
    ],
    whenNotToUse: [
      "The input source is already trusted and validated and the user does not want extra filtering",
      "The workflow never uses the input for outbound communication or persistent writes",
      "There is no meaningful quality check to perform",
    ],
    intentKeywords: [
      "validate",
      "verification",
      "verify",
      "normalize",
      "clean",
      "hygiene",
      "standardize",
      "missing fields",
      "bad data",
      "email verification",
      "quality gate",
    ],
    integrationsInvolved: [],
    analysisGuidance:
      "Insert a validation step before side effects. Normalize field formats, reject or flag incomplete records, and keep the pass/fail rule explicit. If invalid records should be retained, store them separately with a reason.",
    codeGuidance: {
      description:
        "Map input into a normalized shape, validate critical fields, and continue only with records that pass the gate.",
      triggerType: "manual",
      pseudocode: `const normalized = items.map((item) => ({
  id: item.id,
  email: String(item.email || "").trim().toLowerCase(),
  company: String(item.company || "").trim()
}));
const valid = normalized.filter((item) => item.email && item.company);
const invalid = normalized.filter((item) => !item.email || !item.company);
console.log("validation-summary", { valid: valid.length, invalid: invalid.length });`,
    },
    combinableWith: [
      "idempotent-deduplication",
      "system-of-record-writeback",
      "approval-before-side-effects",
    ],
  },

  {
    id: "approval-before-side-effects",
    name: "Approval Before Side Effects",
    category: "delivery",
    description:
      "When the workflow will create, update, post, or send something externally, keep the write steps explicit and approval-gated if the user wants human review or the action is high risk.",
    whenToUse: [
      "The workflow writes to external systems and mistakes would be costly or noisy",
      "The user wants review before posting, updating, sending, or creating records",
      "The workflow has one or more non-trivial side effects that should stay auditable",
    ],
    whenNotToUse: [
      "The workflow is read-only",
      "The user explicitly wants fully automatic side effects with no review",
      "The write is trivial and low risk and the user does not want approval",
    ],
    intentKeywords: [
      "approval",
      "review",
      "human in the loop",
      "confirm before send",
      "approve before post",
      "manual review",
      "checkpoint",
      "guardrail",
      "before updating",
    ],
    integrationsInvolved: [],
    analysisGuidance:
      "Keep write steps separate from read and analysis steps. Use explicit write checkpoints for side effects. If there are multiple writes, checkpoint each meaningful external action rather than bundling everything into one opaque step.",
    codeGuidance: {
      description:
        "Prepare the write payload first, log the intended action, and perform the external write only through a checkpointed write call.",
      triggerType: "manual",
      pseudocode: `const payloadToSend = {
  summary: result.summary,
  targetId: destination.id,
};
console.log("pending-side-effect", payloadToSend);
await destination.write("<perform-write>", {
  method: "POST",
  body: payloadToSend,
  checkpoint: "perform-external-write"
});`,
    },
    combinableWith: [
      "system-of-record-writeback",
      "routing-and-branching",
      "delay-and-recheck",
    ],
  },
];

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function collectOverlap(queryTokens: string[], candidateTokens: string[]): string[] {
  const candidateSet = new Set(candidateTokens);
  return unique(queryTokens.filter((token) => candidateSet.has(token)));
}

function scorePattern(
  queryTokens: string[],
  queryLower: string,
  pattern: GtmPattern,
  activeProviderSlugs: string[]
): { score: number; matchedKeywords: string[] } {
  const matchedKeywords: string[] = [];
  let score = 0;

  for (const keyword of pattern.intentKeywords) {
    if (!queryLower.includes(keyword)) {
      continue;
    }

    matchedKeywords.push(keyword);
    score += keyword.includes(" ") ? 0.22 : 0.12;
  }

  const keywordOverlap = collectOverlap(
    queryTokens,
    pattern.intentKeywords.flatMap((keyword) => tokenize(keyword))
  );
  if (queryTokens.length > 0) {
    score += Math.min(0.22, (keywordOverlap.length / queryTokens.length) * 0.22);
    matchedKeywords.push(...keywordOverlap.slice(0, 3));
  }

  for (const condition of pattern.whenToUse) {
    const overlap = collectOverlap(queryTokens, tokenize(condition));
    if (overlap.length >= 2) {
      score += Math.min(0.16, overlap.length * 0.04);
      matchedKeywords.push(...overlap.slice(0, 2));
    }
  }

  for (const condition of pattern.whenNotToUse) {
    const overlap = collectOverlap(queryTokens, tokenize(condition));
    if (overlap.length >= 2) {
      score -= Math.min(0.2, overlap.length * 0.05);
    }
  }

  if (activeProviderSlugs.length > 0 && pattern.integrationsInvolved.length > 0) {
    const providerOverlap = pattern.integrationsInvolved.filter((providerSlug) =>
      activeProviderSlugs.includes(providerSlug)
    );
    if (providerOverlap.length > 0) {
      score += Math.min(0.12, providerOverlap.length * 0.04);
      matchedKeywords.push(...providerOverlap);
    }
  }

  return {
    score: Math.max(0, Math.min(score, 1)),
    matchedKeywords: unique(matchedKeywords),
  };
}

export function matchGtmPatterns(
  query: string,
  activeProviderSlugs: string[] = [],
  maxResults: number = 3
): GtmPatternMatch[] {
  const queryLower = query.toLowerCase();
  const queryTokens = tokenize(query);

  return GTM_PATTERNS.map((pattern) => {
    const { score, matchedKeywords } = scorePattern(
      queryTokens,
      queryLower,
      pattern,
      activeProviderSlugs
    );

    return {
      pattern,
      relevanceScore: score,
      matchedKeywords,
    };
  })
    .filter(
      (match) =>
        match.relevanceScore >= 0.28 &&
        (match.matchedKeywords.length > 0 || match.relevanceScore >= 0.45)
    )
    .sort((left, right) => right.relevanceScore - left.relevanceScore)
    .slice(0, maxResults);
}
