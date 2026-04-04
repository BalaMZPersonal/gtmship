import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDuckDuckGoHtml } from "@/lib/research/providers/duckduckgo";
import { researchWeb } from "@/lib/research";

describe("research web", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses duckduckgo html and ranks documentation results first", () => {
    const html = `
      <div class="result results_links">
        <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fdevelopers.hubspot.com%2Fdocs%2Fapi%2Fcrm%2Fcontacts">
          HubSpot CRM Contacts API Reference
        </a>
        <a class="result__snippet">Read the API reference for HubSpot contacts.</a>
      </div>
      <div class="result results_links">
        <a class="result__a" href="https://www.hubspot.com/pricing">
          HubSpot Pricing
        </a>
        <a class="result__snippet">Compare pricing plans.</a>
      </div>
    `;

    const results = parseDuckDuckGoHtml(
      html,
      "documentation",
      "HubSpot API documentation",
      5
    );

    expect(results).toHaveLength(2);
    expect(results[0]?.url).toBe(
      "https://developers.hubspot.com/docs/api/crm/contacts"
    );
    expect(results[0]?.domain).toBe("developers.hubspot.com");
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score || 0);
  });

  it("flags weak documentation matches when search results are not useful", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          `
            <div class="result results_links">
              <a class="result__a" href="https://acme.com/">
                Acme Home
              </a>
              <a class="result__snippet">Welcome to Acme.</a>
            </div>
            <div class="result results_links">
              <a class="result__a" href="https://acme.com/pricing">
                Acme Pricing
              </a>
              <a class="result__snippet">See plan pricing.</a>
            </div>
          `,
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }
        )
      )
    );

    const result = await researchWeb({
      mode: "search",
      query: "Acme",
      focus: "documentation",
    });

    expect(result.noUsefulResults).toBe(true);
    expect(result.warnings).toContain(
      "Search results were weak matches for documentation intent."
    );
  });

  it("scrapes a single page with redirect handling and structured extraction", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "/reference" },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          `
            <html>
              <head><title>Acme API Reference</title></head>
              <body>
                <h1>Acme API</h1>
                <h2>Authentication</h2>
                <p>Use a bearer token to authenticate every request.</p>
                <a href="/docs/auth">Authentication docs</a>
              </body>
            </html>
          `,
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }
        )
      );

    vi.stubGlobal("fetch", fetchMock);

    const result = await researchWeb({
      mode: "scrape",
      url: "https://docs.acme.com/start",
    });

    expect(result.page?.finalUrl).toBe("https://docs.acme.com/reference");
    expect(result.page?.title).toBe("Acme API Reference");
    expect(result.page?.headings).toContain("Authentication");
    expect(result.page?.links[0]?.url).toBe("https://docs.acme.com/docs/auth");
    expect(result.warnings).toContain(
      "Followed redirect to https://docs.acme.com/reference"
    );
  });

  it("returns a structured unsupported-content result for PDFs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: { "content-type": "application/pdf" },
        })
      )
    );

    const result = await researchWeb({
      mode: "scrape",
      url: "https://docs.acme.com/reference.pdf",
    });

    expect(result.page?.unsupportedContent).toBe(true);
    expect(result.warnings?.[0]).toContain("Unsupported content type");
  });
});
