const SEARCH_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESULTS = 5;
const ABSOLUTE_MAX_RESULTS = 10;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface DocSearchResult {
  results: SearchResult[];
  query: string;
  error?: string;
}

const DOC_TERMS =
  /\b(docs?|documentation|api\s*reference|developer|swagger|openapi)\b/i;

function augmentQuery(raw: string): string {
  if (DOC_TERMS.test(raw)) return raw;
  return `${raw} API documentation`;
}

const DOC_URL_PATTERNS = [
  /docs?\./i,
  /developer\./i,
  /\/api\b/i,
  /\/docs?\b/i,
  /\/reference\b/i,
  /swagger/i,
  /openapi/i,
];

function scoreResult(result: SearchResult): number {
  let score = 0;
  for (const pattern of DOC_URL_PATTERNS) {
    if (pattern.test(result.url)) score += 2;
    if (pattern.test(result.title)) score += 1;
  }
  return score;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").trim();
}

function parseDDGHtml(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];

  // DuckDuckGo HTML lite wraps each result in a div with class "result"
  // Each result has: <a class="result__a" href="...">title</a>
  // and <a class="result__snippet">snippet text</a>
  const resultBlocks = html.split(/class="result\s/g);

  for (let i = 1; i < resultBlocks.length && results.length < limit; i++) {
    const block = resultBlocks[i];

    // Extract URL from result__a href
    const urlMatch = block.match(/class="result__a"[^>]*href="([^"]+)"/);
    if (!urlMatch) continue;

    let url = urlMatch[1];
    // DDG lite sometimes wraps URLs through a redirect — extract the actual URL
    const uddgMatch = url.match(/[?&]uddg=([^&]+)/);
    if (uddgMatch) {
      url = decodeURIComponent(uddgMatch[1]);
    }

    // Skip non-http results
    if (!url.startsWith("http")) continue;

    // Extract title from result__a content
    const titleMatch = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/);
    const title = titleMatch ? decodeEntities(stripTags(titleMatch[1])) : url;

    // Extract snippet from result__snippet
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    const snippet = snippetMatch ? decodeEntities(stripTags(snippetMatch[1])) : "";

    results.push({ title, url, snippet });
  }

  return results;
}

export async function searchDocumentation(
  query: string,
  maxResults?: number,
): Promise<DocSearchResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { results: [], query, error: "Search query is empty" };
  }

  const limit = Math.min(maxResults ?? DEFAULT_MAX_RESULTS, ABSOLUTE_MAX_RESULTS);
  const augmented = augmentQuery(trimmed);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

    const params = new URLSearchParams({ q: augmented });
    const res = await fetch(`https://html.duckduckgo.com/html/?${params}`, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: controller.signal,
      redirect: "follow",
    });

    clearTimeout(timeout);

    if (!res.ok) {
      return {
        results: [],
        query: augmented,
        error: `Search returned HTTP ${res.status}`,
      };
    }

    const html = await res.text();
    const parsed = parseDDGHtml(html, limit);

    // Sort doc-looking results to the top
    parsed.sort((a, b) => scoreResult(b) - scoreResult(a));

    return { results: parsed, query: augmented };
  } catch (err) {
    return {
      results: [],
      query: augmented,
      error: err instanceof Error ? err.message : "Search failed",
    };
  }
}
