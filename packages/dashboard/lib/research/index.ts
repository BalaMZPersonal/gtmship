import { z } from "zod";
import {
  buildStructuredPage,
  buildExcerpt,
} from "./extract";
import {
  fetchPublicText,
} from "./http";
import { createDuckDuckGoSearchProvider } from "./providers/duckduckgo";
import type {
  ResearchFocus,
  ResearchRequest,
  ResearchResult,
  SearchProvider,
} from "./types";

const DEFAULT_MAX_RESULTS = 5;
const ABSOLUTE_MAX_RESULTS = 10;
const MIN_USEFUL_DOCUMENTATION_SCORE = 5;
const DIRECT_PROVIDER_ID = "direct";
const DOCUMENTATION_SIGNAL_PATTERNS = [
  /docs?\./i,
  /\bdocs?\b/i,
  /\bdocumentation\b/i,
  /\bdeveloper\b/i,
  /\bapi\b/i,
  /\breference\b/i,
  /\bopenapi\b/i,
  /\bswagger\b/i,
];

const searchProvider: SearchProvider = createDuckDuckGoSearchProvider();

export const researchWebInputSchema = z.object({
  mode: z.enum(["search", "scrape", "research"]),
  query: z.string().optional(),
  url: z.string().optional(),
  focus: z.enum(["documentation", "general"]).optional(),
  maxResults: z.number().int().min(1).max(10).optional(),
  selectedResult: z.number().int().min(0).optional(),
  allowedDomains: z.array(z.string()).optional(),
});

function normalizeAllowedDomains(allowedDomains?: string[]): string[] | undefined {
  const normalized = (allowedDomains || [])
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean)
    .map((domain) => domain.replace(/^www\./, ""));

  return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
}

function filterResultsByDomain(
  results: NonNullable<ResearchResult["results"]>,
  allowedDomains?: string[]
) {
  if (!allowedDomains?.length) {
    return { results, warnings: [] as string[] };
  }

  const normalizedDomains = normalizeAllowedDomains(allowedDomains) || [];
  const filtered = results.filter((result) =>
    normalizedDomains.some(
      (allowedDomain) =>
        result.domain === allowedDomain || result.domain.endsWith(`.${allowedDomain}`)
    )
  );

  if (filtered.length > 0) {
    return { results: filtered, warnings: [] as string[] };
  }

  return {
    results: [] as typeof results,
    warnings: [
      `No results matched the allowed domains: ${normalizedDomains.join(", ")}.`,
    ],
  };
}

function resolveFocus(inputFocus?: ResearchFocus): ResearchFocus {
  return inputFocus || "documentation";
}

function resolveMaxResults(inputMaxResults?: number): number {
  return Math.min(inputMaxResults ?? DEFAULT_MAX_RESULTS, ABSOLUTE_MAX_RESULTS);
}

function hasDocumentationSignal(result: NonNullable<ResearchResult["results"]>[number]) {
  const haystacks = [result.title, result.url, result.snippet, result.domain];
  return DOCUMENTATION_SIGNAL_PATTERNS.some((pattern) =>
    haystacks.some((value) => pattern.test(value))
  );
}

async function runSearch(input: ResearchRequest): Promise<ResearchResult> {
  const query = input.query?.trim() || "";
  if (!query) {
    return {
      provider: searchProvider.id,
      mode: "search",
      query,
      results: [],
      error: "Search query is empty.",
      noUsefulResults: true,
    };
  }

  const focus = resolveFocus(input.focus);
  const providerResult = await searchProvider.search({
    query,
    focus,
    maxResults: resolveMaxResults(input.maxResults),
    allowedDomains: input.allowedDomains,
  });
  const domainFilter = filterResultsByDomain(
    providerResult.results,
    input.allowedDomains
  );
  const warnings = [...(providerResult.warnings || []), ...domainFilter.warnings];
  const results = domainFilter.results;
  const noUsefulResults =
    results.length === 0 ||
    (focus === "documentation" &&
      results.every(
        (result) =>
          result.score < MIN_USEFUL_DOCUMENTATION_SCORE ||
          !hasDocumentationSignal(result)
      ));

  if (
    noUsefulResults &&
    results.length > 0 &&
    focus === "documentation"
  ) {
    warnings.push("Search results were weak matches for documentation intent.");
  }

  return {
    provider: providerResult.provider,
    mode: "search",
    query: providerResult.query,
    results,
    warnings: warnings.length > 0 ? warnings : undefined,
    noUsefulResults,
  };
}

export async function scrapeWebPage(url: string): Promise<ResearchResult> {
  const fetchResult = await fetchPublicText(url, {
    method: "GET",
    userAgent: "GTMShip-Research/1.0",
  });
  const warnings = [...fetchResult.warnings];

  if (fetchResult.unsupportedContent) {
    warnings.push(
      `Unsupported content type for structured extraction: ${fetchResult.contentType || "unknown"}.`
    );
  }

  if (fetchResult.error) {
    return {
      provider: DIRECT_PROVIDER_ID,
      mode: "scrape",
      page: buildStructuredPage(
        fetchResult.finalUrl || url,
        fetchResult.status,
        fetchResult.contentType,
        fetchResult.body,
        { unsupportedContent: fetchResult.unsupportedContent }
      ),
      warnings: warnings.length > 0 ? warnings : undefined,
      error: fetchResult.error,
    };
  }

  return {
    provider: DIRECT_PROVIDER_ID,
    mode: "scrape",
    page: buildStructuredPage(
      fetchResult.finalUrl,
      fetchResult.status,
      fetchResult.contentType,
      fetchResult.body,
      { unsupportedContent: fetchResult.unsupportedContent }
    ),
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

export async function researchWeb(input: ResearchRequest): Promise<ResearchResult> {
  const mode = input.mode;

  if (mode === "search") {
    return runSearch(input);
  }

  if (mode === "scrape") {
    const url = input.url?.trim() || "";
    if (!url) {
      return {
        provider: DIRECT_PROVIDER_ID,
        mode,
        error: "URL is required for scrape mode.",
      };
    }

    return scrapeWebPage(url);
  }

  const searchResult = await runSearch(input);
  if (
    searchResult.error ||
    searchResult.noUsefulResults ||
    !searchResult.results ||
    searchResult.results.length === 0
  ) {
    return {
      ...searchResult,
      mode: "research",
    };
  }

  const selectedIndex = Math.min(
    Math.max(input.selectedResult ?? 0, 0),
    searchResult.results.length - 1
  );
  const selected = searchResult.results[selectedIndex];
  const pageResult = await scrapeWebPage(selected.url);

  return {
    provider: searchResult.provider,
    mode: "research",
    query: searchResult.query,
    results: searchResult.results,
    page: pageResult.page,
    warnings: [...(searchResult.warnings || []), ...(pageResult.warnings || [])],
    error: pageResult.error,
    noUsefulResults: false,
  };
}

export function normalizeSearchResultSummary(result: ResearchResult) {
  return (result.results || []).map(({ title, url, snippet }) => ({
    title,
    url,
    snippet,
  }));
}

export function normalizeLegacyFetchBody(result: ResearchResult): {
  status: number;
  contentType: string;
  body: string;
  finalUrl?: string;
  title?: string;
  excerpt?: string;
  warnings?: string[];
  error?: string;
} {
  const page = result.page;

  if (!page) {
    return {
      status: 0,
      contentType: "",
      body: "",
      warnings: result.warnings,
      error: result.error || "No page content was returned.",
    };
  }

  return {
    status: page.status,
    contentType: page.contentType,
    body: page.text,
    finalUrl: page.finalUrl,
    title: page.title,
    excerpt: page.excerpt || buildExcerpt(page.text),
    warnings: result.warnings,
    error: result.error,
  };
}

export function summarizeResultTarget(result: ResearchResult): string {
  if (result.page?.finalUrl) {
    return result.page.finalUrl;
  }

  if (result.results?.[0]?.url) {
    return result.results[0].url;
  }

  return result.query || result.provider || "";
}

export type {
  ResearchFocus,
  ResearchMode,
  ResearchPageResult,
  ResearchRequest,
  ResearchResult,
  ResearchSearchResult,
} from "./types";
