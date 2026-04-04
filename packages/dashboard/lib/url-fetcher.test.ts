import { afterEach, describe, expect, it, vi } from "vitest";

const fetchPublicTextMock = vi.fn();
const buildStructuredPageMock = vi.fn();

vi.mock("@/lib/research/http", () => ({
  fetchPublicText: (...args: unknown[]) => fetchPublicTextMock(...args),
}));

vi.mock("@/lib/research/extract", () => ({
  buildStructuredPage: (...args: unknown[]) => buildStructuredPageMock(...args),
}));

import { fetchUrl } from "@/lib/url-fetcher";

describe("fetchUrl", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses the shared fetch and extract helpers for GET requests", async () => {
    fetchPublicTextMock.mockResolvedValue({
      status: 200,
      contentType: "text/html",
      finalUrl: "https://docs.acme.com/reference",
      body: "<html></html>",
      warnings: [],
    });
    buildStructuredPageMock.mockReturnValue({
      finalUrl: "https://docs.acme.com/reference",
      title: "Acme Docs",
      status: 200,
      contentType: "text/html",
      excerpt: "Acme docs",
      text: "Acme docs body",
      headings: [],
      links: [],
    });

    const result = await fetchUrl("https://docs.acme.com/reference");

    expect(fetchPublicTextMock).toHaveBeenCalledWith(
      "https://docs.acme.com/reference",
      expect.objectContaining({ method: "GET" })
    );
    expect(buildStructuredPageMock).toHaveBeenCalled();
    expect(result.title).toBe("Acme Docs");
    expect(result.body).toBe("Acme docs body");
  });
});
