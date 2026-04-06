import { describe, expect, it } from "vitest";
import {
  matchGtmPatterns,
  GTM_PATTERNS,
  type GtmPatternMatch,
} from "./gtm-patterns";
import { parseGtmPatternContext } from "./ai";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function matchIds(matches: GtmPatternMatch[]): string[] {
  return matches.map((m) => m.pattern.id);
}

function topMatchId(matches: GtmPatternMatch[]): string | undefined {
  return matches[0]?.pattern.id;
}

// ---------------------------------------------------------------------------
// matchGtmPatterns
// ---------------------------------------------------------------------------

describe("matchGtmPatterns", () => {
  it("returns no matches for an unrelated query", () => {
    const matches = matchGtmPatterns("send a simple slack message");
    expect(matches).toHaveLength(0);
  });

  it("matches idempotent-deduplication for dedup intent", () => {
    const matches = matchGtmPatterns(
      "avoid duplicate alerts for accounts already processed"
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matchIds(matches)).toContain("idempotent-deduplication");
  });

  it("matches batch-aggregation for digest/summary intent", () => {
    const matches = matchGtmPatterns(
      "daily digest summarizing new leads in a batch"
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matchIds(matches)).toContain("batch-aggregation");
  });

  it("matches staged-ai-processing for multi-step AI intent", () => {
    const matches = matchGtmPatterns(
      "classify and score accounts then recommend next actions with multiple ai calls"
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matchIds(matches)).toContain("staged-ai-processing");
  });

  it("matches routing-and-branching for segment/routing intent", () => {
    const matches = matchGtmPatterns(
      "route enterprise accounts differently from SMB with conditional branching"
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matchIds(matches)).toContain("routing-and-branching");
  });

  it("matches delay-and-recheck for abandonment detection", () => {
    const matches = matchGtmPatterns(
      "wait 60 seconds after visit then check if form was completed, detect abandonment"
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matchIds(matches)).toContain("delay-and-recheck");
  });

  it("matches staged-pipeline-handoff for multi-stage pipeline", () => {
    const matches = matchGtmPatterns(
      "two stage pipeline: ingest webhook then process later in a separate scheduled run"
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matchIds(matches)).toContain("staged-pipeline-handoff");
  });

  it("matches system-of-record-writeback for CRM update intent", () => {
    const matches = matchGtmPatterns(
      "writeback enrichment scores to the CRM, update salesforce custom fields and persist result"
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matchIds(matches)).toContain("system-of-record-writeback");
  });

  it("matches data-quality-gate for validation intent", () => {
    const matches = matchGtmPatterns(
      "verify and validate email addresses, clean bad data before outreach"
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matchIds(matches)).toContain("data-quality-gate");
  });

  it("matches approval-before-side-effects for human review intent", () => {
    const matches = matchGtmPatterns(
      "require human approval and review before posting the update"
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matchIds(matches)).toContain("approval-before-side-effects");
  });

  // ---- maxResults ----------------------------------------------------------

  it("respects maxResults limit", () => {
    // Use a broad query that could match many patterns
    const matches = matchGtmPatterns(
      "batch aggregate data, deduplicate, route by segment, validate, and write back to CRM",
      [],
      2
    );
    expect(matches.length).toBeLessThanOrEqual(2);
  });

  it("defaults to max 3 results", () => {
    const matches = matchGtmPatterns(
      "batch aggregate data, deduplicate, route by segment, validate, and write back to CRM"
    );
    expect(matches.length).toBeLessThanOrEqual(3);
  });

  // ---- provider slug boosting ----------------------------------------------

  it("boosts patterns when active provider slugs match", () => {
    const withoutProviders = matchGtmPatterns(
      "persist workflow state in a table"
    );
    const withProviders = matchGtmPatterns(
      "persist workflow state in a table",
      ["google-sheets"]
    );

    const scoreWithout =
      withoutProviders.find((m) => m.pattern.id === "persistent-state-storage")
        ?.relevanceScore ?? 0;
    const scoreWith =
      withProviders.find((m) => m.pattern.id === "persistent-state-storage")
        ?.relevanceScore ?? 0;

    expect(scoreWith).toBeGreaterThanOrEqual(scoreWithout);
  });

  // ---- relevance threshold -------------------------------------------------

  it("does not return matches below the relevance threshold", () => {
    const matches = matchGtmPatterns("hello world");
    expect(matches).toHaveLength(0);
  });

  // ---- matchedKeywords transparency ----------------------------------------

  it("includes matchedKeywords in each result", () => {
    const matches = matchGtmPatterns("deduplicate already processed accounts");
    expect(matches.length).toBeGreaterThan(0);
    for (const match of matches) {
      expect(match.matchedKeywords.length).toBeGreaterThan(0);
    }
  });

  // ---- sorted by score descending ------------------------------------------

  it("returns results sorted by relevanceScore descending", () => {
    const matches = matchGtmPatterns(
      "batch aggregate then deduplicate and validate data quality"
    );
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i - 1].relevanceScore).toBeGreaterThanOrEqual(
        matches[i].relevanceScore
      );
    }
  });

  // ---- all patterns are well-formed ----------------------------------------

  it("every pattern has required fields", () => {
    for (const pattern of GTM_PATTERNS) {
      expect(pattern.id).toBeTruthy();
      expect(pattern.name).toBeTruthy();
      expect(pattern.category).toBeTruthy();
      expect(pattern.description).toBeTruthy();
      expect(pattern.whenToUse.length).toBeGreaterThan(0);
      expect(pattern.whenNotToUse.length).toBeGreaterThan(0);
      expect(pattern.intentKeywords.length).toBeGreaterThan(0);
      expect(pattern.analysisGuidance).toBeTruthy();
      expect(pattern.codeGuidance.description).toBeTruthy();
      expect(pattern.codeGuidance.triggerType).toBeTruthy();
      expect(pattern.codeGuidance.pseudocode).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// parseGtmPatternContext
// ---------------------------------------------------------------------------

describe("parseGtmPatternContext", () => {
  it("returns undefined when no marker is present", () => {
    expect(parseGtmPatternContext("just some instructions")).toBeUndefined();
  });

  it("returns undefined for empty/undefined input", () => {
    expect(parseGtmPatternContext(undefined)).toBeUndefined();
    expect(parseGtmPatternContext("")).toBeUndefined();
  });

  it("extracts content after the WORKFLOW HEURISTIC CONTEXT: marker", () => {
    const instructions =
      "Some notes.\nWORKFLOW HEURISTIC CONTEXT:\nUse dedup pattern.\nCheck storage.";
    const result = parseGtmPatternContext(instructions);
    expect(result).toContain("Use dedup pattern.");
    expect(result).toContain("Check storage.");
  });

  it("extracts content after the legacy GTM PATTERN CONTEXT: marker", () => {
    const instructions =
      "Some notes.\nGTM PATTERN CONTEXT:\nApply batch aggregation.";
    const result = parseGtmPatternContext(instructions);
    expect(result).toContain("Apply batch aggregation.");
  });

  it("stops at the GROUNDED API CONTEXT: marker", () => {
    const instructions = [
      "WORKFLOW HEURISTIC CONTEXT:",
      "Use staged AI processing.",
      "GROUNDED API CONTEXT:",
      "- hubspot: GET /contacts — list contacts",
    ].join("\n");
    const result = parseGtmPatternContext(instructions);
    expect(result).toContain("Use staged AI processing.");
    expect(result).not.toContain("hubspot");
  });

  it("prefers WORKFLOW HEURISTIC CONTEXT: over GTM PATTERN CONTEXT:", () => {
    const instructions = [
      "WORKFLOW HEURISTIC CONTEXT:",
      "Heuristic content here.",
      "GTM PATTERN CONTEXT:",
      "Legacy content here.",
    ].join("\n");
    const result = parseGtmPatternContext(instructions);
    expect(result).toContain("Heuristic content here.");
  });
});
