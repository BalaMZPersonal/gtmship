import {
  canonicalizeUrl,
  getDomainFromUrl,
  isHttpUrl,
} from "./http";
import type { ResearchPageLink, ResearchPageResult } from "./types";

const MAX_TEXT_LENGTH = 8_000;
const MAX_EXCERPT_LENGTH = 280;
const MAX_HEADINGS = 12;
const MAX_LINKS = 12;

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ");
}

export function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ");
}

function collapseWhitespace(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clipText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit)}\n\n... (content truncated)`;
}

export function buildExcerpt(text: string, maxLength = MAX_EXCERPT_LENGTH): string {
  const normalized = collapseWhitespace(text.replace(/\n+/g, " "));
  if (normalized.length <= maxLength) {
    return normalized;
  }

  const clipped = normalized.slice(0, maxLength);
  const lastWhitespace = clipped.lastIndexOf(" ");
  const safe = lastWhitespace > maxLength * 0.6 ? clipped.slice(0, lastWhitespace) : clipped;
  return `${safe.trim()}...`;
}

function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "")
    .replace(/<form[\s\S]*?<\/form>/gi, "");
}

export function htmlToText(html: string): string {
  let text = sanitizeHtml(html);

  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/section>/gi, "\n")
    .replace(/<\/article>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/td>/gi, " | ")
    .replace(/<\/th>/gi, " | ");

  text = decodeHtmlEntities(stripTags(text));
  return collapseWhitespace(text);
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(normalized);
  }

  return unique;
}

function extractTitle(html: string): string {
  const titleMatch =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) ||
    html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);

  if (!titleMatch) {
    return "";
  }

  return collapseWhitespace(decodeHtmlEntities(stripTags(titleMatch[1])));
}

function extractHeadings(html: string): string[] {
  const matches = Array.from(
    html.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi)
  ).map((match) => collapseWhitespace(decodeHtmlEntities(stripTags(match[1]))));

  return dedupeStrings(matches).slice(0, MAX_HEADINGS);
}

function resolveLink(baseUrl: string, href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  if (/^(javascript|mailto|tel):/i.test(trimmed)) return null;

  try {
    const resolved = new URL(trimmed, baseUrl).toString();
    if (!isHttpUrl(resolved)) {
      return null;
    }
    return canonicalizeUrl(resolved);
  } catch {
    return null;
  }
}

function extractLinks(baseUrl: string, html: string): ResearchPageLink[] {
  const seen = new Set<string>();
  const links: ResearchPageLink[] = [];

  for (const match of html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const resolved = resolveLink(baseUrl, decodeHtmlEntities(match[1]));
    if (!resolved || seen.has(resolved)) {
      continue;
    }

    const title = collapseWhitespace(decodeHtmlEntities(stripTags(match[2])));
    seen.add(resolved);
    links.push({
      title: title || getDomainFromUrl(resolved),
      url: resolved,
    });

    if (links.length >= MAX_LINKS) {
      break;
    }
  }

  return links;
}

function inferTitleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const segment = parsed.pathname.split("/").filter(Boolean).pop();
    return segment || parsed.hostname;
  } catch {
    return url;
  }
}

function formatJsonBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

export function buildStructuredPage(
  finalUrl: string,
  status: number,
  contentType: string,
  body: string,
  options?: { unsupportedContent?: boolean }
): ResearchPageResult {
  if (contentType.includes("html")) {
    const title = extractTitle(body) || inferTitleFromUrl(finalUrl);
    const text = clipText(htmlToText(body), MAX_TEXT_LENGTH);
    const excerpt = buildExcerpt(text);

    return {
      finalUrl,
      title,
      status,
      contentType,
      excerpt,
      text,
      headings: extractHeadings(body),
      links: extractLinks(finalUrl, body),
      unsupportedContent: options?.unsupportedContent,
    };
  }

  const formattedBody = contentType.includes("json") ? formatJsonBody(body) : body;
  const text = clipText(collapseWhitespace(formattedBody), MAX_TEXT_LENGTH);

  return {
    finalUrl,
    title: inferTitleFromUrl(finalUrl),
    status,
    contentType,
    excerpt: buildExcerpt(text),
    text,
    headings: [],
    links: [],
    unsupportedContent: options?.unsupportedContent,
  };
}
