import { streamText, tool } from "ai";
import { z } from "zod";
import { executeCommand } from "@/lib/sandbox";
import { fetchUrl } from "@/lib/url-fetcher";
import { searchDocumentation } from "@/lib/doc-search";
import { researchWeb, researchWebInputSchema } from "@/lib/research";
import { createConfiguredLanguageModel } from "@/lib/ai-settings";

const AUTH_URL = process.env.AUTH_SERVICE_URL || "http://localhost:4000";
const MAX_PROVIDER_SAVE_PAYLOAD_BYTES = 250_000;
const MAX_PROVIDER_SCHEMA_ENDPOINTS = 24;
const MAX_PROVIDER_SCHEMA_PARAMETERS = 12;
const MAX_PROVIDER_TEXT_CHARS = 500;
const MAX_PROVIDER_RESPONSE_TEXT_CHARS = 300;
const MAX_PROVIDER_CURL_CHARS = 1_200;
const MAX_PROVIDER_JSON_KEYS = 16;
const MAX_PROVIDER_JSON_ARRAY_ITEMS = 12;
const MAX_PROVIDER_JSON_DEPTH = 4;

function trimText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}... (truncated)`;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function compactJsonValue(value: unknown, depth = 0): unknown {
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "string") {
    return trimText(value, MAX_PROVIDER_RESPONSE_TEXT_CHARS);
  }

  if (depth >= MAX_PROVIDER_JSON_DEPTH) {
    return Array.isArray(value) ? ["... (truncated)"] : "... (truncated)";
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_PROVIDER_JSON_ARRAY_ITEMS)
      .map((entry) => compactJsonValue(entry, depth + 1));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const entries = Object.entries(value as Record<string, unknown>).slice(
    0,
    MAX_PROVIDER_JSON_KEYS
  );

  return Object.fromEntries(
    entries.map(([key, entryValue]) => [
      key,
      compactJsonValue(entryValue, depth + 1),
    ])
  );
}

function compactProviderParameter(parameter: unknown): Record<string, unknown> | null {
  if (!parameter || typeof parameter !== "object" || Array.isArray(parameter)) {
    return null;
  }

  const typedParameter = parameter as Record<string, unknown>;

  return {
    name:
      typeof typedParameter.name === "string"
        ? trimText(typedParameter.name, 80)
        : typedParameter.name,
    type:
      typeof typedParameter.type === "string"
        ? trimText(typedParameter.type, 60)
        : typedParameter.type,
    required:
      typeof typedParameter.required === "boolean"
        ? typedParameter.required
        : undefined,
    in:
      typeof typedParameter.in === "string"
        ? trimText(typedParameter.in, 40)
        : typedParameter.in,
    description:
      typeof typedParameter.description === "string"
        ? trimText(typedParameter.description, 200)
        : typedParameter.description,
  };
}

function compactProviderEndpoint(endpoint: unknown): Record<string, unknown> | null {
  if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) {
    return null;
  }

  const typedEndpoint = endpoint as Record<string, unknown>;

  return {
    method:
      typeof typedEndpoint.method === "string"
        ? trimText(typedEndpoint.method, 24)
        : typedEndpoint.method,
    path:
      typeof typedEndpoint.path === "string"
        ? trimText(typedEndpoint.path, 240)
        : typedEndpoint.path,
    description:
      typeof typedEndpoint.description === "string"
        ? trimText(typedEndpoint.description, 240)
        : typedEndpoint.description,
    parameters: Array.isArray(typedEndpoint.parameters)
      ? typedEndpoint.parameters
          .slice(0, MAX_PROVIDER_SCHEMA_PARAMETERS)
          .map(compactProviderParameter)
          .filter(
            (
              parameter
            ): parameter is Record<string, unknown> => parameter !== null
          )
      : undefined,
    response: compactJsonValue(typedEndpoint.response),
  };
}

function compactProviderApiSchema(apiSchema: unknown): Record<string, unknown> | undefined {
  if (!apiSchema || typeof apiSchema !== "object" || Array.isArray(apiSchema)) {
    return undefined;
  }

  const typedSchema = apiSchema as Record<string, unknown>;
  const compactedSchema: Record<string, unknown> = {};

  if (Array.isArray(typedSchema.endpoints)) {
    compactedSchema.endpoints = typedSchema.endpoints
      .slice(0, MAX_PROVIDER_SCHEMA_ENDPOINTS)
      .map(compactProviderEndpoint)
      .filter(
        (endpoint): endpoint is Record<string, unknown> => endpoint !== null
      );
  }

  if (
    typedSchema.auth &&
    typeof typedSchema.auth === "object" &&
    !Array.isArray(typedSchema.auth)
  ) {
    const auth = typedSchema.auth as Record<string, unknown>;
    compactedSchema.auth = {
      type: typeof auth.type === "string" ? trimText(auth.type, 40) : auth.type,
      header:
        typeof auth.header === "string"
          ? trimText(auth.header, 80)
          : auth.header,
      format:
        typeof auth.format === "string"
          ? trimText(auth.format, 160)
          : auth.format,
    };
  }

  if (
    typedSchema.test &&
    typeof typedSchema.test === "object" &&
    !Array.isArray(typedSchema.test)
  ) {
    const test = typedSchema.test as Record<string, unknown>;
    compactedSchema.test = {
      curl:
        typeof test.curl === "string"
          ? trimText(test.curl, MAX_PROVIDER_CURL_CHARS)
          : test.curl,
      expected_status:
        typeof test.expected_status === "number"
          ? test.expected_status
          : test.expected_status,
    };
  }

  return compactedSchema;
}

function buildCompactProviderSavePayload(
  config: Record<string, unknown>
): Record<string, unknown> {
  const compactedPayload: Record<string, unknown> = {
    ...config,
    description:
      typeof config.description === "string"
        ? trimText(config.description, MAX_PROVIDER_TEXT_CHARS)
        : config.description,
    notes:
      typeof config.notes === "string"
        ? trimText(config.notes, 1_500)
        : config.notes,
  };

  if ("api_schema" in config) {
    compactedPayload.api_schema = compactProviderApiSchema(config.api_schema);
  }

  const compactedJson = JSON.stringify(compactedPayload);
  if (byteLength(compactedJson) <= MAX_PROVIDER_SAVE_PAYLOAD_BYTES) {
    return compactedPayload;
  }

  const schema =
    compactedPayload.api_schema &&
    typeof compactedPayload.api_schema === "object" &&
    !Array.isArray(compactedPayload.api_schema)
      ? (compactedPayload.api_schema as Record<string, unknown>)
      : null;

  if (!schema) {
    return compactedPayload;
  }

  const reducedEndpoints = Array.isArray(schema.endpoints)
    ? schema.endpoints.slice(0, 10).map((endpoint) => {
        if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) {
          return endpoint;
        }

        const typedEndpoint = endpoint as Record<string, unknown>;
        return {
          method: typedEndpoint.method,
          path: typedEndpoint.path,
          description: typedEndpoint.description,
          parameters: Array.isArray(typedEndpoint.parameters)
            ? typedEndpoint.parameters
                .slice(0, 6)
                .map(compactProviderParameter)
                .filter(
                  (
                    parameter
                  ): parameter is Record<string, unknown> => parameter !== null
                )
            : undefined,
        };
      })
    : undefined;

  return {
    ...compactedPayload,
    api_schema: {
      auth: schema.auth,
      test: schema.test,
      endpoints: reducedEndpoints,
    },
  };
}

const SYSTEM_PROMPT = `You are GTMShip's Integration Agent — an expert at setting up API integrations.
You have access to bash, curl, python, and a web research tool for documentation discovery.

Your capabilities:
- Research the web for API documentation and inspect public pages
- Execute bash commands (curl, python3, node, jq, base64, pip3)
- Build provider configurations (OAuth2, API key, basic auth)
- Test API endpoints
- Save working configurations to the auth service

When a user wants to set up an integration:
1. If it's a known provider, look it up in the catalog first (readCatalogProvider)
2. If the catalog has a docs URL, inspect it with researchWeb in scrape mode
3. If the provider is NOT in the catalog:
   a. Use researchWeb in research mode to search for and inspect the API documentation
   b. If researchWeb returns no useful results, ASK THE USER for the documentation URL
4. Analyze the documentation to determine:
   - Auth type (OAuth2, API key, basic)
   - Base URL
   - Required scopes/permissions
   - Test endpoint
5. Build the provider configuration
6. Guide the user through providing credentials (client_id/secret or API key)
7. Test the connection with curl
8. Save the working configuration with full API schema

When reconnecting an existing API key or basic-auth integration:
- Call listConnections first and inspect any existing connections for that provider
- Reuse the original connection row whenever the user is replacing credentials
- Pass connectApiKey.connectionId for the specific connection you intend to update
- Never create a duplicate connection when the user intends to reconnect or rotate credentials for an existing one

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
- Keep api_schema compact. Do not paste whole docs pages or huge sample payloads when a short schema or trimmed example will do.

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
- ALWAYS use researchWeb when you do not already have a trusted docs URL.
- Use researchWeb with mode="research" when you only know the provider/query.
- Use researchWeb with mode="scrape" when you already have a concrete public URL.
- If researchWeb returns noUsefulResults AND the catalog doesn't have the provider, ASK the user: "I couldn't find the API documentation automatically. Could you share the documentation URL?"
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
      researchWeb: tool({
        description:
          "Search the web and optionally inspect a public page in one tool call. Use mode='research' when you only know the provider or query. Use mode='scrape' when you already have a docs URL. Prefer focus='documentation' for API research.",
        parameters: researchWebInputSchema,
        execute: async (input) => {
          return await researchWeb(input);
        },
      }),

      searchDocumentation: tool({
        description:
          "Legacy wrapper around researchWeb search mode. Prefer researchWeb for new calls.",
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
          "Legacy wrapper around the shared web scraping core. Prefer researchWeb in scrape mode for new calls.",
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
            return { found: false, message: `"${slug}" not in catalog. Use researchWeb to inspect API docs instead.` };
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
            const compactConfig = buildCompactProviderSavePayload(
              config as Record<string, unknown>
            );
            const res = await fetch(`${AUTH_URL}/providers`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...compactConfig, source: "agent" }),
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
        description:
          "Create or update a connection using an API key for a registered provider. Provide connectionId when reconnecting an existing integration so GTMShip updates the original connection instead of creating a duplicate.",
        parameters: z.object({
          provider: z.string().describe("Provider slug"),
          api_key: z.string().describe("The API key"),
          label: z.string().optional(),
          connectionId: z
            .string()
            .optional()
            .describe("Existing connection id to update when reconnecting"),
        }),
        execute: async ({ provider, api_key, label, connectionId }) => {
          try {
            const res = await fetch(`${AUTH_URL}/auth/${provider}/connect-key`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                api_key,
                label,
                connection_id: connectionId,
              }),
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
