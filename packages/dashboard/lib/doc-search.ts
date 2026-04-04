import {
  normalizeSearchResultSummary,
  researchWeb,
} from "@/lib/research";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface DocSearchResult {
  results: SearchResult[];
  query: string;
  warnings?: string[];
  noUsefulResults?: boolean;
  error?: string;
}

export async function searchDocumentation(
  query: string,
  maxResults?: number
): Promise<DocSearchResult> {
  const result = await researchWeb({
    mode: "search",
    query,
    maxResults,
    focus: "documentation",
  });

  return {
    results: normalizeSearchResultSummary(result),
    query: result.query || query,
    warnings: result.warnings,
    noUsefulResults: result.noUsefulResults,
    error: result.error,
  };
}
