import { buildStructuredPage } from "@/lib/research/extract";
import { fetchPublicText } from "@/lib/research/http";

const MAX_BODY_LENGTH = 12_000;

export interface FetchResult {
  status: number;
  contentType: string;
  body: string;
  finalUrl?: string;
  title?: string;
  excerpt?: string;
  warnings?: string[];
  error?: string;
}

export async function fetchUrl(
  url: string,
  options?: { method?: string; headers?: Record<string, string> }
): Promise<FetchResult> {
  const method = (options?.method || "GET").toUpperCase();
  const result = await fetchPublicText(url, {
    method,
    headers: options?.headers,
    userAgent: "GTMShip-Agent/1.0",
  });

  if (result.error) {
    return {
      status: result.status,
      contentType: result.contentType,
      body: "",
      finalUrl: result.finalUrl,
      warnings: result.warnings,
      error: result.error,
    };
  }

  if (result.unsupportedContent) {
    return {
      status: result.status,
      contentType: result.contentType,
      body: "",
      finalUrl: result.finalUrl,
      warnings: result.warnings,
      error: `Unsupported content type: ${result.contentType || "unknown"}.`,
    };
  }

  if (method === "HEAD") {
    return {
      status: result.status,
      contentType: result.contentType,
      body: "",
      finalUrl: result.finalUrl,
      warnings: result.warnings,
    };
  }

  const page = buildStructuredPage(
    result.finalUrl,
    result.status,
    result.contentType,
    result.body
  );
  const body =
    page.text.length > MAX_BODY_LENGTH
      ? `${page.text.slice(0, MAX_BODY_LENGTH)}\n\n... (content truncated)`
      : page.text;

  return {
    status: page.status,
    contentType: page.contentType,
    body,
    finalUrl: page.finalUrl,
    title: page.title,
    excerpt: page.excerpt,
    warnings: result.warnings,
  };
}
