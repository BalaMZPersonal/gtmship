import { Router } from "express";
import { prisma } from "../services/db.js";
import { encrypt } from "../services/crypto.js";
import { resolveSharedOAuthProviderKey } from "../services/shared-oauth.js";
import { getApiSchemaForSlug } from "../services/catalog.js";
import { resolveOpenApiSpecUrl } from "../services/apis-guru.js";

export const providerRoutes: Router = Router();

function normalizeDefaultHeaders(
  value: unknown
): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value).filter(
    ([key, headerValue]) =>
      key.trim().length > 0 &&
      typeof headerValue === "string" &&
      headerValue.trim().length > 0
  );

  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    entries.map(([key, headerValue]) => [key.trim(), headerValue.trim()])
  );
}

async function getSharedCredentialStatus(
  keys: Array<string | null | undefined>
): Promise<Map<string, boolean>> {
  const uniqueKeys = Array.from(new Set(keys.filter(Boolean) as string[]));
  if (uniqueKeys.length === 0) {
    return new Map();
  }

  const oauthProviders = await prisma.oAuthProvider.findMany({
    where: {
      key: { in: uniqueKeys },
    },
    select: {
      key: true,
      clientId: true,
      clientSecret: true,
    },
  });

  return new Map(
    oauthProviders.map((provider) => [
      provider.key,
      !!(provider.clientId && provider.clientSecret),
    ])
  );
}

// List all providers
providerRoutes.get("/", async (_req, res) => {
  const providers = await prisma.provider.findMany({
    select: {
      id: true,
      name: true,
      slug: true,
      authType: true,
      authorizeUrl: true,
      tokenUrl: true,
      baseUrl: true,
      scopes: true,
      tokenRefresh: true,
      testEndpoint: true,
      headerName: true,
      docsUrl: true,
      notes: true,
      category: true,
      logoUrl: true,
      description: true,
      source: true,
      defaultHeaders: true,
      openApiSpecUrl: true,
      oauthProviderKey: true,
      clientId: true,
      createdAt: true,
      _count: { select: { connections: true } },
    },
  });

  const sharedCredentialStatus = await getSharedCredentialStatus(
    providers.map((provider) =>
      resolveSharedOAuthProviderKey({
        key: provider.oauthProviderKey,
        slug: provider.slug,
      })
    )
  );

  res.json(
    providers.map(({ clientId, ...provider }) => ({
      ...provider,
      hasCredentials:
        !!clientId ||
        (resolveSharedOAuthProviderKey({
          key: provider.oauthProviderKey,
          slug: provider.slug,
        })
          ? sharedCredentialStatus.get(
              resolveSharedOAuthProviderKey({
                key: provider.oauthProviderKey,
                slug: provider.slug,
              })!
            ) || false
          : false),
    }))
  );
});

// Get a single provider
providerRoutes.get("/:slug", async (req, res) => {
  const provider = await prisma.provider.findUnique({
    where: { slug: req.params.slug },
    include: { connections: { select: { id: true, label: true, status: true, createdAt: true } } },
  });
  if (!provider) {
    res.status(404).json({ error: "Provider not found" });
    return;
  }

  const sharedCredentialStatus = await getSharedCredentialStatus([
    resolveSharedOAuthProviderKey({
      key: provider.oauthProviderKey,
      slug: provider.slug,
    }),
  ]);
  // Strip sensitive fields
  const { clientId, clientSecret, ...safe } = provider;

  // Enrich with Activepieces-derived apiSchema when DB has none
  let apiSchema = safe.apiSchema as Record<string, unknown> | null;
  if (!apiSchema) {
    const pieceSchema = await getApiSchemaForSlug(safe.slug, safe.baseUrl);
    if (pieceSchema) {
      apiSchema = pieceSchema as unknown as Record<string, unknown>;
    }
  }

  // Enrich with APIs.guru OpenAPI spec URL when DB has none
  let openApiSpecUrl = safe.openApiSpecUrl;
  if (!openApiSpecUrl) {
    openApiSpecUrl = await resolveOpenApiSpecUrl(safe.slug);
  }

  res.json({
    ...safe,
    apiSchema,
    openApiSpecUrl,
    hasCredentials:
      !!clientId ||
      (resolveSharedOAuthProviderKey({
        key: provider.oauthProviderKey,
        slug: provider.slug,
      })
        ? sharedCredentialStatus.get(
            resolveSharedOAuthProviderKey({
              key: provider.oauthProviderKey,
              slug: provider.slug,
            })!
          ) || false
        : false),
  });
});

// Register a new provider (upsert — updates if slug already exists)
providerRoutes.post("/", async (req, res) => {
  const {
    name, slug, auth_type, authorize_url, token_url, base_url,
    scopes, token_refresh, test_endpoint, header_name,
    docs_url, notes, client_id, client_secret,
    category, logo_url, description, source, api_schema, oauth_provider_key,
    openapi_spec_url, default_headers,
  } = req.body;

  try {
    // Auto-resolve OpenAPI spec URL from APIs.guru if not provided
    let resolvedSpecUrl = openapi_spec_url || undefined;
    if (!resolvedSpecUrl && slug) {
      resolvedSpecUrl = (await resolveOpenApiSpecUrl(slug)) ?? undefined;
    }

    const data = {
      name,
      slug,
      authType: auth_type,
      authorizeUrl: authorize_url,
      tokenUrl: token_url,
      baseUrl: base_url,
      scopes: scopes || [],
      tokenRefresh: token_refresh ?? true,
      testEndpoint: test_endpoint,
      headerName: header_name,
      docsUrl: docs_url,
      notes,
      category,
      logoUrl: logo_url,
      description,
      source: source || "manual",
      apiSchema: api_schema || undefined,
      defaultHeaders: normalizeDefaultHeaders(default_headers),
      openApiSpecUrl: resolvedSpecUrl,
      oauthProviderKey: oauth_provider_key || undefined,
      clientId: client_id,
      clientSecret: client_secret ? encrypt(client_secret) : null,
    };

    const provider = await prisma.provider.upsert({
      where: { slug },
      create: data,
      update: data,
    });

    res.status(201).json({ id: provider.id, slug: provider.slug, name: provider.name });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save provider";
    res.status(500).json({ error: message });
  }
});

// Validate a provider config (for AI-generated configs)
providerRoutes.post("/validate", async (req, res) => {
  const config = req.body;
  const errors: string[] = [];

  if (!config.name) errors.push("name is required");
  if (!config.slug) errors.push("slug is required");
  if (!config.auth_type) errors.push("auth_type is required");
  if (!["oauth2", "api_key", "basic"].includes(config.auth_type)) {
    errors.push("auth_type must be oauth2, api_key, or basic");
  }
  if (!config.base_url) errors.push("base_url is required");
  if (config.auth_type === "oauth2") {
    if (!config.authorize_url) errors.push("authorize_url required for oauth2");
    if (!config.token_url) errors.push("token_url required for oauth2");
  }
  if (config.auth_type === "api_key" && !config.header_name) {
    errors.push("header_name required for api_key auth (e.g., 'X-API-Key')");
  }

  if (errors.length > 0) {
    res.status(400).json({ valid: false, errors });
    return;
  }

  res.json({ valid: true, errors: [] });
});

// Update a provider
providerRoutes.put("/:slug", async (req, res) => {
  const {
    name, auth_type, authorize_url, token_url, base_url,
    scopes, token_refresh, test_endpoint, header_name,
    docs_url, notes, client_id, client_secret,
    category, logo_url, description, api_schema,
    oauth_provider_key, openapi_spec_url, default_headers,
  } = req.body;

  try {
    const existing = await prisma.provider.findUnique({ where: { slug: req.params.slug } });
    if (!existing) {
      res.status(404).json({ error: "Provider not found" });
      return;
    }

    const update: Record<string, unknown> = {};
    if (name !== undefined) update.name = name;
    if (auth_type !== undefined) update.authType = auth_type;
    if (authorize_url !== undefined) update.authorizeUrl = authorize_url;
    if (token_url !== undefined) update.tokenUrl = token_url;
    if (base_url !== undefined) update.baseUrl = base_url;
    if (scopes !== undefined) update.scopes = scopes;
    if (token_refresh !== undefined) update.tokenRefresh = token_refresh;
    if (test_endpoint !== undefined) update.testEndpoint = test_endpoint;
    if (header_name !== undefined) update.headerName = header_name;
    if (docs_url !== undefined) update.docsUrl = docs_url;
    if (notes !== undefined) update.notes = notes;
    if (category !== undefined) update.category = category;
    if (logo_url !== undefined) update.logoUrl = logo_url;
    if (description !== undefined) update.description = description;
    if (api_schema !== undefined) update.apiSchema = api_schema;
    if (default_headers !== undefined) {
      update.defaultHeaders = normalizeDefaultHeaders(default_headers) || null;
    }
    if (openapi_spec_url !== undefined) update.openApiSpecUrl = openapi_spec_url;
    if (oauth_provider_key !== undefined) {
      update.oauthProviderKey = oauth_provider_key || null;
    }
    if (client_id !== undefined) update.clientId = client_id;
    if (client_secret !== undefined) {
      update.clientSecret = client_secret ? encrypt(client_secret) : null;
    }

    const provider = await prisma.provider.update({
      where: { slug: req.params.slug },
      data: update,
    });

    res.json({ id: provider.id, slug: provider.slug, name: provider.name });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update provider";
    res.status(500).json({ error: message });
  }
});

// Delete a provider
providerRoutes.delete("/:slug", async (req, res) => {
  await prisma.provider.delete({ where: { slug: req.params.slug } });
  res.status(204).end();
});
