const TIMEOUT_MS = 10_000;
const MAX_SIZE = 1_048_576; // 1MB
const MAX_BODY_LENGTH = 12_000; // chars returned to LLM

// Block private/internal IPs to prevent SSRF
const BLOCKED_HOSTS = [
  /^localhost$/,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^\[::1\]/,
];

function isBlockedHost(hostname: string): boolean {
  return BLOCKED_HOSTS.some((pattern) => pattern.test(hostname));
}

// Strip HTML tags and extract readable text content
function htmlToText(html: string): string {
  // Remove script and style tags with content
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, "");
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, "");

  // Convert common elements to readable format
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<\/h[1-6]>/gi, "\n\n");
  text = text.replace(/<\/li>/gi, "\n");
  text = text.replace(/<li[^>]*>/gi, "- ");
  text = text.replace(/<\/tr>/gi, "\n");
  text = text.replace(/<\/td>/gi, " | ");

  // Strip all remaining tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");

  // Clean up whitespace
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  return text;
}

export interface FetchResult {
  status: number;
  contentType: string;
  body: string;
  error?: string;
}

export async function fetchUrl(
  url: string,
  options?: { method?: string; headers?: Record<string, string> },
): Promise<FetchResult> {
  try {
    const parsed = new URL(url);

    if (isBlockedHost(parsed.hostname)) {
      return {
        status: 0,
        contentType: "",
        body: "",
        error: "Blocked: cannot fetch from private/internal addresses.",
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await fetch(url, {
      method: options?.method || "GET",
      headers: {
        "User-Agent": "GTMShip-Agent/1.0",
        ...options?.headers,
      },
      signal: controller.signal,
      redirect: "follow",
    });

    clearTimeout(timeout);

    const contentType = res.headers.get("content-type") || "";
    const contentLength = parseInt(res.headers.get("content-length") || "0", 10);

    if (contentLength > MAX_SIZE) {
      return {
        status: res.status,
        contentType,
        body: "",
        error: `Response too large: ${contentLength} bytes (limit: ${MAX_SIZE})`,
      };
    }

    let body = await res.text();

    // Convert HTML to readable text
    if (contentType.includes("html")) {
      body = htmlToText(body);
    }

    // Truncate
    if (body.length > MAX_BODY_LENGTH) {
      body = body.slice(0, MAX_BODY_LENGTH) + "\n\n... (content truncated)";
    }

    return { status: res.status, contentType, body };
  } catch (err) {
    return {
      status: 0,
      contentType: "",
      body: "",
      error: err instanceof Error ? err.message : "Fetch failed",
    };
  }
}
