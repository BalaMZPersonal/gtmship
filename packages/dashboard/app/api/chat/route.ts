import { streamText, tool } from "ai";
import { z } from "zod";
import { createConfiguredLanguageModel } from "@/lib/ai-settings";

const AUTH_URL = process.env.AUTH_SERVICE_URL || "http://localhost:4000";

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
    maxSteps: 5,
    system: `You are the GTMShip setup assistant. You help users:
- Set up OAuth and API key connections to platforms (HubSpot, Salesforce, Slack, etc.)
- Create and configure workflows
- Debug connection issues
- Deploy workflows to AWS

You have tools to search provider templates, create connections, test them, and manage providers.
Be concise and helpful. When setting up a connection, guide the user step by step.

When a provider uses a shared OAuth family such as Google, explain that one OAuth app/callback can cover multiple Google services, ask whether the user also wants the other supported Google services enabled, save the shared OAuth app credentials, and pass every selected service slug to startOAuth.

For OAuth flows started with startOAuth:
- The UI handles the popup callback for the user
- Never ask the user to paste the callback URL or auth code back into chat
- Never manually exchange the auth code with curl or scripts when the auth-service callback is being used.
- Do not claim the integration is connected, ready, or fully set up until OAuth has actually completed
- Do not provide the final success summary in the same response that introduces the authorize button.`,
    messages,
    tools: {
      searchTemplate: tool({
        description:
          "Search for a pre-built connection template by provider name",
        parameters: z.object({
          name: z.string().describe("Provider name like hubspot, salesforce, slack"),
        }),
        execute: async ({ name }) => {
          try {
            const res = await fetch(`${AUTH_URL}/providers/${name.toLowerCase()}`);
            if (res.ok) return await res.json();
            return { found: false, message: `No template found for "${name}". You can create a custom config.` };
          } catch {
            return { found: false, message: "Auth service not reachable." };
          }
        },
      }),
      listProviders: tool({
        description: "List all registered providers and their connections",
        parameters: z.object({}),
        execute: async () => {
          try {
            const res = await fetch(`${AUTH_URL}/providers`);
            return await res.json();
          } catch {
            return { error: "Auth service not reachable." };
          }
        },
      }),
      createProvider: tool({
        description: "Register a new provider (platform) for OAuth or API key connections",
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
          oauth_provider_key: z.string().optional(),
        }),
        execute: async (config) => {
          try {
            const res = await fetch(`${AUTH_URL}/providers`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(config),
            });
            return await res.json();
          } catch {
            return { error: "Failed to create provider." };
          }
        },
      }),
      saveSharedOAuthProvider: tool({
        description: "Save a shared OAuth app configuration such as the Google OAuth app reused across multiple services.",
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
            return await res.json();
          } catch {
            return { error: "Failed to save shared OAuth provider." };
          }
        },
      }),
      connectApiKey: tool({
        description: "Create a connection using an API key",
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
            return await res.json();
          } catch {
            return { error: "Failed to connect." };
          }
        },
      }),
      startOAuth: tool({
        description: "Get the OAuth authorization URL for a provider. The chat UI will render an authorize button and continue automatically after the popup succeeds. Do not ask the user to paste the callback URL back into chat.",
        parameters: z.object({
          provider: z.string().describe("Provider slug"),
          service_slugs: z.array(z.string()).optional(),
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
        description: "Test if a connection is working by calling the provider's test endpoint",
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
        description: "List all active connections",
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
