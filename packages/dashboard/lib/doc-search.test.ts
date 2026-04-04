import { afterEach, describe, expect, it, vi } from "vitest";

const researchWebMock = vi.fn();
const normalizeSearchResultSummaryMock = vi.fn();

vi.mock("@/lib/research", () => ({
  researchWeb: (...args: unknown[]) => researchWebMock(...args),
  normalizeSearchResultSummary: (...args: unknown[]) =>
    normalizeSearchResultSummaryMock(...args),
}));

import { searchDocumentation } from "@/lib/doc-search";

describe("searchDocumentation", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to researchWeb search mode", async () => {
    researchWebMock.mockResolvedValue({
      provider: "duckduckgo",
      mode: "search",
      query: "HubSpot API documentation",
      results: [{ title: "HubSpot Docs", url: "https://developers.hubspot.com", snippet: "" }],
      warnings: ["warning"],
      noUsefulResults: false,
    });
    normalizeSearchResultSummaryMock.mockReturnValue([
      {
        title: "HubSpot Docs",
        url: "https://developers.hubspot.com",
        snippet: "",
      },
    ]);

    const result = await searchDocumentation("HubSpot", 4);

    expect(researchWebMock).toHaveBeenCalledWith({
      mode: "search",
      query: "HubSpot",
      maxResults: 4,
      focus: "documentation",
    });
    expect(result.results).toHaveLength(1);
    expect(result.warnings).toEqual(["warning"]);
  });
});
