import { streamText, tool } from "ai";
import { z } from "zod";
import { executeCommand } from "@/lib/sandbox";
import { fetchUrl } from "@/lib/url-fetcher";
import { searchDocumentation } from "@/lib/doc-search";
import { createConfiguredLanguageModel } from "@/lib/ai-settings";

const AUTH_URL = process.env.AUTH_SERVICE_URL || "http://localhost:4000";

const SYSTEM_PROMPT = `You are GTMShip's Integration Agent — an expert at setting up API integrations.
You have access to bash, curl, python, and can fetch documentation URLs.

Your capabilities:
- Search the web for API documentation (when no URL is provided)
- Fetch and analyze API documentation from URLs
- Execute bash commands (curl, python3, node, jq, base64, pip3)
- Build provider configurations (OAuth2, API key, basic auth)
- Test API endpoints
- Save working configurations to the auth service

When a user wants to set up an integration:
1. If it's a known provider, look it up in the catalog first (readCatalogProvider)
2. If the catalog has a docs URL, fetch it with fetchUrl
3. If the provider is NOT in the catalog:
   a. Use searchDocumentation to find the API documentation
   b. Pick the most relevant result and fetch it with fetchUrl
   c. If search returns no useful results, ASK THE USER for the documentation URL
4. Analyze the documentation to determine:
   - Auth type (OAuth2, API key, basic)
   - Base URL
   - Required scopes/permissions
   - Test endpoint
5. Build the provider configuration
6. Guide the user through providing credentials (client_id/secret or API key)
7. Test the connection with curl
8. Save the working configuration with full API schema

When a catalog provider includes oauthProviderKey (for example Google-family services):
- Explain that the OAuth app/callback can be shared across those services
- Ask whether the same auth should also apply to the other supported services on that provider family
- Save the shared OAuth app credentials with saveSharedOAuthProvider before starting OAuth
- Pass every selected service slug in startOAuth.service_slugs

CRITICAL — For OAuth flows started with startOAuth:
- The chat UI renders the authorize button and listens for the popup callback automatically
- NEVER ask the user to paste the callback URL or authorization code back into chat
- NEVER manually exchange the authorization code with curl, python, or bash when the auth-service callback is being used
- After startOAuth, tell the user to complete the popup in chat and wait for the automatic success message before continuing
- Do not claim the integration is connected, ready, or fully set up until OAuth has actually completed
- Do not provide the final success summary in the same response that introduces the authorize button

CRITICAL — When saving a provider, ALWAYS include the api_schema field with:
- endpoints: Every API endpoint you discovered from the docs (method, path, description, parameters with type/required/location, and a sample response or response schema)
- auth: How authentication works (header format, token placement)
- test: A curl command to verify the connection, with expected status code

Example api_schema structure:
{
  "endpoints": [
    {
      "method": "GET",
      "path": "/v1/contacts",
      "description": "List all contacts",
      "parameters": [
        { "name": "limit", "type": "integer", "required": false, "in": "query", "description": "Max results" }
      ],
      "response": {
        "type": "array",
        "sample": { "id": "123", "name": "Acme Corp", "email": "contact@acme.com" }
      }
    }
  ],
  "auth": {
    "type": "bearer",
    "header": "Authorization",
    "format": "Bearer {token}"
  },
  "test": {
    "curl": "curl -s -H 'Authorization: Bearer {token}' https://api.example.com/v1/health",
    "expected_status": 200
  }
}

This schema is stored for the user to reference when testing and building schema mappings later.

Always show your work:
- Display curl command outputs
- Show the config you're building as JSON
- Explain what each step does
- If something fails, diagnose and try alternatives

Important:
- Never log or display API keys/secrets in full — mask them
- When testing with curl, use the user's actual credentials
- If you need to write and run a Python script, use: python3 -c "code here"
- Be thorough but concise

CRITICAL — Documentation Discovery Rules:
- NEVER guess or fabricate documentation URLs. Do not try URLs like "https://docs.example.com/api" or "https://developer.example.com" on spec.
- ALWAYS use searchDocumentation to find docs when you don't have a URL.
- If searchDocumentation returns no useful results AND the catalog doesn't have the provider, ASK the user: "I couldn't find the API documentation automatically. Could you share the documentation URL?"
- Do not repeatedly try different guessed URLs. Search once, then ask.
`;

export async function POST(req: Request) {
  const { messages } = await req.json();

  let model;
  try {
    model = await createConfiguredLanguageModel();
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "AI model is not configured. Go to Settings to add it.",
      },
      { status: 400 },
    );
  }

  const result = streamText({
    model,
    maxSteps: 25,
    system: SYSTEM_PROMPT,
    messages,
    tools: {
      searchDocumentation: tool({
        description:
          "Search the web for API documentation pages. Use this when you need to find documentation for a service/platform but don't have the URL. Returns search results with titles, URLs, and snippets. After finding results, use fetchUrl to read the most promising documentation page.",
        parameters: z.object({
          query: z.string().describe("Search query — typically the service/platform name"),
          maxResults: z
            .number()
            .min(1)
            .max(10)
            .optional()
            .describe("Maximum number of results to return (default: 5)"),
        }),
        execute: async ({ query, maxResults }) => {
          return await searchDocumentation(query, maxResults);
        },
      }),

      fetchUrl: tool({
        description:
          "Fetch a URL to read API documentation, check endpoint responses, or download configuration. Returns the page content as text.",
        parameters: z.object({
          url: z.string().describe("The URL to fetch"),
          method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional().describe("HTTP method, defaults to GET"),
          headers: z.record(z.string()).optional().describe("Additional headers"),
        }),
        execute: async ({ url, method, headers }) => {
          return await fetchUrl(url, { method, headers });
        },
      }),

      executeCommand: tool({
        description:
          "Execute a shell command. Allowed commands: curl, python3, python, node, jq, base64, echo, cat, pip3, which. Use this to test APIs with curl, run Python/Node scripts, parse JSON with jq, etc.",
        parameters: z.object({
          command: z.string().describe(
            'The command to execute. Examples: \'curl -s https://api.example.com/health\', \'python3 -c "print(1+1)"\', \'echo "test" | jq .\'',
          ),
        }),
        execute: async ({ command }) => {
          return await executeCommand(command);
        },
      }),

      readCatalogProvider: tool({
        description:
          "Look up a provider in the built-in integration catalog (powered by Activepieces). Returns pre-configured auth URLs, scopes, base URL, and docs URL if available.",
        parameters: z.object({
          slug: z.string().describe("Provider slug like 'hubspot', 'slack', 'github'"),
        }),
        execute: async ({ slug }) => {
          try {
            const res = await fetch(`${AUTH_URL}/catalog/${slug.toLowerCase()}`);
            if (res.ok) {
              const provider = await res.json();
              return { found: true, ...provider };
            }
            // Try search
            const searchRes = await fetch(`${AUTH_URL}/catalog?q=${encodeURIComponent(slug)}`);
            if (searchRes.ok) {
              const data = await searchRes.json();
              if (data.items?.length > 0) return { found: true, ...data.items[0] };
            }
            return { found: false, message: `"${slug}" not in catalog. Use fetchUrl to read API docs instead.` };
          } catch {
            return { found: false, message: "Catalog service not reachable." };
          }
        },
      }),

      buildProviderConfig: tool({
        description:
          "Validate a provider configuration against the auth-service. Returns validation errors if any.",
        parameters: z.object({
          name: z.string(),
          slug: z.string(),
          auth_type: z.enum(["oauth2", "api_key", "basic"]),
          base_url: z.string(),
          authorize_url: z.string().optional(),
          token_url: z.string().optional(),
          scopes: z.array(z.string()).optional(),
          test_endpoint: z.string().optional(),
          header_name: z.string().optional(),
          docs_url: z.string().optional(),
          oauth_provider_key: z.string().optional(),
        }),
        execute: async (config) => {
          try {
            const res = await fetch(`${AUTH_URL}/providers/validate`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(config),
            });
            return await res.json();
          } catch {
            return { valid: false, errors: ["Auth service not reachable."] };
          }
        },
      }),

      saveProvider: tool({
        description:
          "Register a provider in the auth service. After saving, you can connect using OAuth or API key. If the provider slug already exists, it will be updated. ALWAYS include api_schema with endpoints, auth details, and test instructions.",
        parameters: z.object({
          name: z.string(),
          slug: z.string(),
          auth_type: z.enum(["oauth2", "api_key", "basic"]),
          base_url: z.string(),
          authorize_url: z.string().optional(),
          token_url: z.string().optional(),
          scopes: z.array(z.string()).optional(),
          token_refresh: z.boolean().optional(),
          test_endpoint: z.string().optional(),
          header_name: z.string().optional(),
          docs_url: z.string().optional(),
          notes: z.string().optional(),
          client_id: z.string().optional(),
          client_secret: z.string().optional(),
          category: z.string().optional(),
          description: z.string().optional(),
          oauth_provider_key: z.string().optional(),
          api_schema: z.object({
            endpoints: z.array(z.object({
              method: z.string(),
              path: z.string(),
              description: z.string().optional(),
              parameters: z.array(z.object({
                name: z.string(),
                type: z.string().optional(),
                required: z.boolean().optional(),
                in: z.string().optional(),
                description: z.string().optional(),
              })).optional(),
              response: z.record(z.unknown()).optional(),
            })).optional(),
            auth: z.object({
              type: z.string(),
              header: z.string().optional(),
              format: z.string().optional(),
            }).optional(),
            test: z.object({
              curl: z.string(),
              expected_status: z.number().optional(),
            }).optional(),
          }).optional().describe("API structure: endpoints, auth details, response schemas, and test instructions"),
        }),
        execute: async (config) => {
          try {
            const res = await fetch(`${AUTH_URL}/providers`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...config, source: "agent" }),
            });
            if (!res.ok) {
              const text = await res.text();
              try {
                return JSON.parse(text);
              } catch {
                return { error: `Save failed (${res.status}): ${text.slice(0, 200)}` };
              }
            }
            return await res.json();
          } catch {
            return { error: "Failed to save provider. Auth service may not be running." };
          }
        },
      }),

      saveSharedOAuthProvider: tool({
        description:
          "Save a shared OAuth app configuration, such as the Google OAuth app reused across Gmail and Google Sheets.",
        parameters: z.object({
          key: z.string().describe("Shared OAuth provider key like 'google'"),
          client_id: z.string().optional(),
          client_secret: z.string().optional(),
          authorize_url: z.string().optional(),
          token_url: z.string().optional(),
        }),
        execute: async ({ key, ...config }) => {
          try {
            const res = await fetch(`${AUTH_URL}/oauth-providers/${key}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(config),
            });
            if (!res.ok) {
              const text = await res.text();
              return { error: `Save failed (${res.status}): ${text.slice(0, 200)}` };
            }
            return await res.json();
          } catch {
            return { error: "Failed to save shared OAuth provider." };
          }
        },
      }),

      connectApiKey: tool({
        description: "Create a connection using an API key for a registered provider.",
        parameters: z.object({
          provider: z.string().describe("Provider slug"),
          api_key: z.string().describe("The API key"),
          label: z.string().optional(),
        }),
        execute: async ({ provider, api_key, label }) => {
          try {
            const res = await fetch(`${AUTH_URL}/auth/${provider}/connect-key`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ api_key, label }),
            });
            if (!res.ok) {
              const text = await res.text();
              try {
                return JSON.parse(text);
              } catch {
                return { error: `Connection failed (${res.status}): ${text.slice(0, 200)}` };
              }
            }
            return await res.json();
          } catch {
            return { error: "Failed to connect. Auth service may not be running." };
          }
        },
      }),

      startOAuth: tool({
        description:
          "Get the OAuth authorization URL for a provider. The chat UI will render an authorize button and continue automatically after the popup succeeds. Do not ask the user to paste the callback URL back into chat.",
        parameters: z.object({
          provider: z.string().describe("Provider slug"),
          service_slugs: z.array(z.string()).optional().describe(
            "Optional related service slugs to authorize in the same shared OAuth flow"
          ),
        }),
        execute: async ({ provider, service_slugs }) => {
          try {
            const params = new URLSearchParams();
            for (const serviceSlug of service_slugs || []) {
              params.append("service_slugs", serviceSlug);
            }
            const res = await fetch(
              `${AUTH_URL}/auth/${provider}/connect${params.toString() ? `?${params.toString()}` : ""}`
            );
            return await res.json();
          } catch {
            return { error: "Failed to start OAuth flow." };
          }
        },
      }),

      testConnection: tool({
        description: "Test if an existing connection is working.",
        parameters: z.object({
          connectionId: z.string(),
        }),
        execute: async ({ connectionId }) => {
          try {
            const res = await fetch(`${AUTH_URL}/connections/${connectionId}/test`, {
              method: "POST",
            });
            return await res.json();
          } catch {
            return { error: "Failed to test connection." };
          }
        },
      }),

      listConnections: tool({
        description: "List all active connections.",
        parameters: z.object({}),
        execute: async () => {
          try {
            const res = await fetch(`${AUTH_URL}/connections`);
            return await res.json();
          } catch {
            return { error: "Auth service not reachable." };
          }
        },
      }),
    },
  });

  return result.toDataStreamResponse();
}
