import {
  canonicalizeUrl,
  getDomainFromUrl,
} from "../http";
import type {
  ResearchFocus,
  ResearchSearchResult,
  SearchProvider,
  SearchProviderInput,
  SearchProviderResult,
} from "../types";
import { decodeHtmlEntities, stripTags } from "../extract";

const SEARCH_TIMEOUT_MS = 10_000;
const DOCUMENTATION_QUERY_TERMS =
  /\b(docs?|documentation|api\s*reference|developer|swagger|openapi)\b/i;
const DOCUMENTATION_URL_PATTERNS = [
  /docs?\./i,
  /developer\./i,
  /\/docs?\b/i,
  /\/api\b/i,
  /\/reference\b/i,
  /swagger/i,
  /openapi/i,
];
const DOCUMENTATION_TITLE_PATTERNS = [
  /\bdocs?\b/i,
  /\bdocumentation\b/i,
  /\bdeveloper\b/i,
  /\bapi\b/i,
  /\breference\b/i,
  /\bopenapi\b/i,
  /\bswagger\b/i,
];
const GENERIC_QUERY_TOKENS = new Set([
  "api",
  "documentation",
  "docs",
  "developer",
  "developers",
  "reference",
  "openapi",
  "swagger",
]);
const NON_DOC_URL_PATTERNS = [/\/blog\b/i, /\/pricing\b/i, /\/careers\b/i, /\/about\b/i];

function augmentQuery(
  rawQuery: string,
  focus: ResearchFocus,
  allowedDomains?: string[]
): string {
  let query = rawQuery.trim();

  if (focus === "documentation" && !DOCUMENTATION_QUERY_TERMS.test(query)) {
    query = `${query} API documentation`;
  }

  if (allowedDomains?.length === 1) {
    query = `${query} site:${allowedDomains[0]}`;
  }

  return query;
}

function extractQueryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !GENERIC_QUERY_TOKENS.has(token));
}

function scoreResult(
  result: Pick<ResearchSearchResult, "title" | "url" | "snippet" | "domain">,
  focus: ResearchFocus,
  queryTokens: string[]
): number {
  let score = 0;
  const title = result.title.toLowerCase();
  const url = result.url.toLowerCase();
  const snippet = result.snippet.toLowerCase();

  if (focus === "documentation") {
    for (const pattern of DOCUMENTATION_URL_PATTERNS) {
      if (pattern.test(url)) score += 2;
      if (pattern.test(result.domain)) score += 1;
    }

    for (const pattern of DOCUMENTATION_TITLE_PATTERNS) {
      if (pattern.test(title)) score += 2;
      if (pattern.test(snippet)) score += 1;
    }

    for (const pattern of NON_DOC_URL_PATTERNS) {
      if (pattern.test(url)) score -= 2;
    }
  }

  for (const token of queryTokens) {
    if (result.domain.includes(token)) score += 2;
    if (title.includes(token)) score += 2;
    if (snippet.includes(token)) score += 1;
    if (url.includes(token)) score += 1;
  }

  return score;
}

export function parseDuckDuckGoHtml(
  html: string,
  focus: ResearchFocus,
  query: string,
  limit: number
): ResearchSearchResult[] {
  const anchors = Array.from(
    html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)
  );
  const queryTokens = extractQueryTokens(query);
  const deduped = new Map<string, ResearchSearchResult>();

  for (let index = 0; index < anchors.length; index += 1) {
    if (deduped.size >= limit * 2) {
      break;
    }

    const anchor = anchors[index];
    const rawUrl = decodeHtmlEntities(anchor[1]);
    const nextAnchorIndex = anchors[index + 1]?.index ?? html.length;
    const currentAnchorIndex = anchor.index ?? 0;
    const chunk = html.slice(currentAnchorIndex, nextAnchorIndex);

    let resolvedUrl = rawUrl;
    const redirectMatch = rawUrl.match(/[?&]uddg=([^&]+)/);
    if (redirectMatch) {
      resolvedUrl = decodeURIComponent(redirectMatch[1]);
    }

    if (!/^https?:\/\//i.test(resolvedUrl)) {
      continue;
    }

    const canonicalUrl = canonicalizeUrl(resolvedUrl);
    const title = decodeHtmlEntities(stripTags(anchor[2])).trim() || canonicalUrl;
    const snippetMatch =
      chunk.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/i) ||
      chunk.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = snippetMatch
      ? decodeHtmlEntities(stripTags(snippetMatch[1])).trim()
      : "";
    const domain = getDomainFromUrl(canonicalUrl);
    const candidate: ResearchSearchResult = {
      title,
      url: canonicalUrl,
      snippet,
      domain,
      score: 0,
    };

    candidate.score = scoreResult(candidate, focus, queryTokens);

    const existing = deduped.get(canonicalUrl);
    if (
      !existing ||
      candidate.score > existing.score ||
      candidate.snippet.length > existing.snippet.length
    ) {
      deduped.set(canonicalUrl, candidate);
    }
  }

  return Array.from(deduped.values())
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

export function createDuckDuckGoSearchProvider(): SearchProvider {
  return {
    id: "duckduckgo",
    async search(input: SearchProviderInput): Promise<SearchProviderResult> {
      const query = augmentQuery(input.query, input.focus, input.allowedDomains);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

      try {
        const params = new URLSearchParams({ q: query });
        const response = await fetch(`https://html.duckduckgo.com/html/?${params}`, {
          method: "GET",
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
          },
          signal: controller.signal,
          redirect: "follow",
        });

        if (!response.ok) {
          return {
            provider: this.id,
            query,
            results: [],
            warnings: [`Search returned HTTP ${response.status}.`],
          };
        }

        const html = await response.text();
        return {
          provider: this.id,
          query,
          results: parseDuckDuckGoHtml(html, input.focus, query, input.maxResults),
        };
      } catch (error) {
        return {
          provider: this.id,
          query,
          results: [],
          warnings: [
            error instanceof Error ? error.message : "DuckDuckGo search failed.",
          ],
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
