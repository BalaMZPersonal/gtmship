const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_SIZE_BYTES = 1_048_576;

const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^\[::1\]$/i,
];

const TRACKING_QUERY_PARAMS = [
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
  "utm_campaign",
  "utm_content",
  "utm_medium",
  "utm_source",
  "utm_term",
];

export interface PublicFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRedirects?: number;
  maxSizeBytes?: number;
  userAgent?: string;
}

export interface PublicFetchResult {
  status: number;
  contentType: string;
  finalUrl: string;
  body: string;
  warnings: string[];
  error?: string;
  unsupportedContent?: boolean;
}

export function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return BLOCKED_HOST_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function getDomainFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

export function canonicalizeUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";

  for (const param of TRACKING_QUERY_PARAMS) {
    parsed.searchParams.delete(param);
  }

  if (
    (parsed.protocol === "https:" && parsed.port === "443") ||
    (parsed.protocol === "http:" && parsed.port === "80")
  ) {
    parsed.port = "";
  }

  if (parsed.pathname !== "/") {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  }

  return parsed.toString();
}

function normalizeUrl(input: string): URL {
  const parsed = new URL(input);

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported.");
  }

  if (isBlockedHostname(parsed.hostname)) {
    throw new Error("Blocked: cannot fetch from private/internal addresses.");
  }

  return parsed;
}

function isRedirectStatus(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function resolveRedirectMethod(status: number, method: string): string {
  if ([301, 302, 303].includes(status) && method !== "GET" && method !== "HEAD") {
    return "GET";
  }

  return method;
}

function isSupportedTextContentType(contentType: string): boolean {
  if (!contentType) return true;

  return (
    contentType.includes("html") ||
    contentType.includes("json") ||
    contentType.includes("text/") ||
    contentType.includes("xml") ||
    contentType.includes("javascript")
  );
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export async function fetchPublicText(
  url: string,
  options?: PublicFetchOptions
): Promise<PublicFetchResult> {
  const warnings: string[] = [];
  const maxRedirects = options?.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxSizeBytes = options?.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const headers = {
    "User-Agent": options?.userAgent || "GTMShip-Agent/1.0",
    ...options?.headers,
  };

  try {
    let currentUrl = normalizeUrl(url);
    let method = (options?.method || "GET").toUpperCase();

    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
      );

      try {
        const response = await fetch(currentUrl.toString(), {
          method,
          headers,
          signal: controller.signal,
          redirect: "manual",
        });

        if (isRedirectStatus(response.status)) {
          const location = response.headers.get("location");
          if (!location) {
            return {
              status: response.status,
              contentType: response.headers.get("content-type") || "",
              finalUrl: currentUrl.toString(),
              body: "",
              warnings,
              error: `Redirect response ${response.status} did not include a Location header.`,
            };
          }

          if (redirectCount === maxRedirects) {
            return {
              status: response.status,
              contentType: response.headers.get("content-type") || "",
              finalUrl: currentUrl.toString(),
              body: "",
              warnings,
              error: `Too many redirects while fetching ${currentUrl.toString()}.`,
            };
          }

          currentUrl = normalizeUrl(new URL(location, currentUrl).toString());
          method = resolveRedirectMethod(response.status, method);

          warnings.push(`Followed redirect to ${currentUrl.toString()}`);
          continue;
        }

        const contentType = response.headers.get("content-type") || "";
        const contentLength = Number.parseInt(
          response.headers.get("content-length") || "0",
          10
        );

        if (Number.isFinite(contentLength) && contentLength > maxSizeBytes) {
          return {
            status: response.status,
            contentType,
            finalUrl: currentUrl.toString(),
            body: "",
            warnings,
            error: `Response too large: ${contentLength} bytes (limit: ${maxSizeBytes}).`,
          };
        }

        if (method === "HEAD" || response.status === 204 || response.status === 304) {
          return {
            status: response.status,
            contentType,
            finalUrl: currentUrl.toString(),
            body: "",
            warnings,
          };
        }

        if (!isSupportedTextContentType(contentType)) {
          return {
            status: response.status,
            contentType,
            finalUrl: currentUrl.toString(),
            body: "",
            warnings,
            unsupportedContent: true,
          };
        }

        const body = await response.text();
        if (byteLength(body) > maxSizeBytes) {
          return {
            status: response.status,
            contentType,
            finalUrl: currentUrl.toString(),
            body: "",
            warnings,
            error: `Response exceeded the ${maxSizeBytes}-byte limit after download.`,
          };
        }

        return {
          status: response.status,
          contentType,
          finalUrl: currentUrl.toString(),
          body,
          warnings,
        };
      } finally {
        clearTimeout(timeout);
      }
    }

    return {
      status: 0,
      contentType: "",
      finalUrl: url,
      body: "",
      warnings,
      error: `Too many redirects while fetching ${url}.`,
    };
  } catch (error) {
    return {
      status: 0,
      contentType: "",
      finalUrl: url,
      body: "",
      warnings,
      error: error instanceof Error ? error.message : "Fetch failed.",
    };
  }
}
