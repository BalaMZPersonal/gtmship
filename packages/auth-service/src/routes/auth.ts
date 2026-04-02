import { Router } from "express";
import type { Prisma, Provider } from "@prisma/client";
import { prisma } from "../services/db.js";
import { decrypt, encrypt } from "../services/crypto.js";
import {
  decodeOAuthState,
  encodeOAuthState,
} from "../services/oauth-state.js";
import {
  getSharedOAuthProviderConfig,
  resolveSharedOAuthProviderKey,
} from "../services/shared-oauth.js";
import { syncConnectionSecretReplicasById } from "../services/connection-secret-replicas.js";

export const authRoutes: Router = Router();

function getBaseUrl(req: import("express").Request): string {
  const proto = (req.get("x-forwarded-proto") || req.protocol) as string;
  const host = req.get("x-forwarded-host") || req.get("host");
  return `${proto}://${host}`;
}

function applyOAuthPopupHeaders(res: import("express").Response): void {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; base-uri 'self'; form-action 'self'; object-src 'none'"
  );
  res.setHeader("Cross-Origin-Opener-Policy", "unsafe-none");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

function readServiceSlugs(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return Array.from(
      new Set(
        value
          .flatMap((item) => `${item}`.split(","))
          .map((item) => item.trim())
          .filter(Boolean)
      )
    );
  }

  return Array.from(
    new Set(
      `${value}`
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}

async function getSelectedProviders(
  primaryProvider: Provider,
  requestedSlugs: string[]
): Promise<Provider[]> {
  const serviceSlugs = Array.from(
    new Set([primaryProvider.slug, ...requestedSlugs])
  );

  const sharedOAuthProviderKey = resolveSharedOAuthProviderKey({
    key: primaryProvider.oauthProviderKey,
    slug: primaryProvider.slug,
  });

  if (!sharedOAuthProviderKey) {
    return [primaryProvider];
  }

  const providers = await prisma.provider.findMany({
    where: {
      slug: { in: serviceSlugs },
    },
  });

  if (providers.length !== serviceSlugs.length) {
    throw new Error("One or more selected Google services are not registered yet.");
  }

  const bySlug = new Map(providers.map((provider) => [provider.slug, provider]));
  const orderedProviders = serviceSlugs
    .map((slug) => bySlug.get(slug))
    .filter((provider): provider is Provider => !!provider);

  if (
    orderedProviders.some(
      (provider) =>
        provider.authType !== "oauth2" ||
        resolveSharedOAuthProviderKey({
          key: provider.oauthProviderKey,
          slug: provider.slug,
        }) !== sharedOAuthProviderKey
    )
  ) {
    throw new Error(
      "Selected services must share the same OAuth provider and use OAuth2."
    );
  }

  return orderedProviders;
}

async function getEffectiveOAuthConfig(provider: Provider) {
  const sharedOAuthProviderKey = resolveSharedOAuthProviderKey({
    key: provider.oauthProviderKey,
    slug: provider.slug,
  });

  if (sharedOAuthProviderKey) {
    const sharedConfig = await getSharedOAuthProviderConfig(sharedOAuthProviderKey);
    if (!sharedConfig) {
      return null;
    }

    return {
      displayName: sharedConfig.name,
      callbackSlug: sharedConfig.callbackSlug,
      authorizeUrl: sharedConfig.authorizeUrl,
      tokenUrl: sharedConfig.tokenUrl,
      clientId: sharedConfig.clientId,
      clientSecret: sharedConfig.clientSecret,
      extraScopes: sharedConfig.extraScopes,
    };
  }

  return {
    displayName: provider.name,
    callbackSlug: provider.slug,
    authorizeUrl: provider.authorizeUrl,
    tokenUrl: provider.tokenUrl,
    clientId: provider.clientId,
    clientSecret: provider.clientSecret,
    extraScopes: [],
  };
}

function buildRequestedScopes(
  providers: Provider[],
  extraScopes: string[] = []
): string[] {
  const scopes = new Set<string>();
  for (const scope of extraScopes) {
    if (scope) scopes.add(scope);
  }
  for (const provider of providers) {
    for (const scope of provider.scopes) {
      if (scope) scopes.add(scope);
    }
  }
  return Array.from(scopes);
}

function parseGrantedScopes(
  rawScope: unknown,
  fallbackScopes: string[]
): string[] {
  if (typeof rawScope === "string" && rawScope.trim()) {
    return Array.from(
      new Set(rawScope.split(/[,\s]+/).map((scope) => scope.trim()).filter(Boolean))
    );
  }

  return fallbackScopes;
}

function decodeJwtPayload(token: string | undefined): Record<string, unknown> | null {
  if (!token) return null;

  const [, payload] = token.split(".");
  if (!payload) return null;

  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

function extractSharedAccountIdentity(
  oauthProviderKey: string | undefined,
  tokenData: Record<string, unknown>
): {
  externalAccountId?: string;
  accountEmail?: string;
} {
  if (oauthProviderKey !== "google") {
    return {};
  }

  const payload = decodeJwtPayload(tokenData.id_token as string | undefined);
  return {
    externalAccountId:
      (payload?.sub as string | undefined) ||
      (tokenData.sub as string | undefined),
    accountEmail:
      (payload?.email as string | undefined) ||
      (tokenData.email as string | undefined),
  };
}

function buildSharedConnectionMetadata(
  oauthProviderKey: string,
  accountEmail: string | undefined,
  tokens: ExtractedTokens
): Prisma.InputJsonValue | undefined {
  const metadata = {
    ...(tokens.metadata || {}),
    shared_oauth_provider_key: oauthProviderKey,
    account_email: accountEmail || null,
  } as Record<string, unknown>;

  return metadata as Prisma.InputJsonValue;
}

async function saveSharedConnections(params: {
  providers: Provider[];
  primaryServiceSlug: string;
  oauthProviderKey: string;
  tokenData: Record<string, unknown>;
  tokens: ExtractedTokens;
}): Promise<Array<{ id: string; provider: string }>> {
  const sharedProvider = await prisma.oAuthProvider.findUnique({
    where: { key: params.oauthProviderKey },
  });

  if (!sharedProvider) {
    throw new Error("Shared OAuth provider is not configured.");
  }

  const identity = extractSharedAccountIdentity(
    params.oauthProviderKey,
    params.tokenData
  );
  const grantedScopes = parseGrantedScopes(
    params.tokenData.scope,
    buildRequestedScopes(
      params.providers,
      params.oauthProviderKey === "google" ? ["openid", "email"] : []
    )
  );

  const sharedCredential =
    identity.externalAccountId
      ? await prisma.oAuthCredential.upsert({
          where: {
            oauthProviderId_externalAccountId: {
              oauthProviderId: sharedProvider.id,
              externalAccountId: identity.externalAccountId,
            },
          },
          create: {
            oauthProviderId: sharedProvider.id,
            externalAccountId: identity.externalAccountId,
            accountEmail: identity.accountEmail || null,
            accessToken: encrypt(params.tokens.accessToken),
            refreshToken: params.tokens.refreshToken
              ? encrypt(params.tokens.refreshToken)
              : null,
            tokenExpiresAt: params.tokens.expiresIn
              ? new Date(Date.now() + params.tokens.expiresIn * 1000)
              : null,
            scopes: grantedScopes,
            metadata: (params.tokens.metadata || undefined) as
              | Prisma.InputJsonValue
              | undefined,
          },
          update: {
            accountEmail: identity.accountEmail || null,
            accessToken: encrypt(params.tokens.accessToken),
            refreshToken: params.tokens.refreshToken
              ? encrypt(params.tokens.refreshToken)
              : undefined,
            tokenExpiresAt: params.tokens.expiresIn
              ? new Date(Date.now() + params.tokens.expiresIn * 1000)
              : null,
            scopes: grantedScopes,
            metadata: (params.tokens.metadata || undefined) as
              | Prisma.InputJsonValue
              | undefined,
          },
        })
      : await prisma.oAuthCredential.create({
          data: {
            oauthProviderId: sharedProvider.id,
            accountEmail: identity.accountEmail || null,
            accessToken: encrypt(params.tokens.accessToken),
            refreshToken: params.tokens.refreshToken
              ? encrypt(params.tokens.refreshToken)
              : null,
            tokenExpiresAt: params.tokens.expiresIn
              ? new Date(Date.now() + params.tokens.expiresIn * 1000)
              : null,
            scopes: grantedScopes,
            metadata: (params.tokens.metadata || undefined) as
              | Prisma.InputJsonValue
              | undefined,
          },
        });

  const connections: Array<{ id: string; provider: string }> = [];

  for (const provider of params.providers) {
    const existingSharedConnection = await prisma.connection.findFirst({
      where: {
        providerId: provider.id,
        oauthCredentialId: sharedCredential.id,
      },
      orderBy: { updatedAt: "desc" },
    });

    const sharedData = {
      oauthCredentialId: sharedCredential.id,
      label:
        existingSharedConnection?.label ||
        `${provider.slug}-${identity.accountEmail || Date.now()}`,
      status: "active",
      accessToken: null,
      refreshToken: null,
      tokenExpiresAt: null,
      instanceUrl: params.tokens.instanceUrl || null,
      metadata: buildSharedConnectionMetadata(
        params.oauthProviderKey,
        identity.accountEmail,
        params.tokens
      ),
    };

    let connection;

    if (existingSharedConnection) {
      connection = await prisma.connection.update({
        where: { id: existingSharedConnection.id },
        data: sharedData,
      });
    } else if (provider.slug === params.primaryServiceSlug) {
      const existingLegacyConnection = await prisma.connection.findFirst({
        where: {
          providerId: provider.id,
          oauthCredentialId: null,
        },
        orderBy: { updatedAt: "desc" },
      });

      if (existingLegacyConnection) {
        connection = await prisma.connection.update({
          where: { id: existingLegacyConnection.id },
          data: sharedData,
        });
      } else {
        connection = await prisma.connection.create({
          data: {
            providerId: provider.id,
            ...sharedData,
          },
        });
      }
    } else {
      connection = await prisma.connection.create({
        data: {
          providerId: provider.id,
          ...sharedData,
        },
      });
    }

    connections.push({ id: connection.id, provider: provider.slug });
  }

  return connections;
}

async function syncSecretReplicasForConnections(
  connections: Array<{ id: string }>
): Promise<void> {
  const connectionIds = Array.from(new Set(connections.map((item) => item.id)));
  for (const connectionId of connectionIds) {
    try {
      await syncConnectionSecretReplicasById(connectionId);
    } catch (error) {
      console.warn(
        `[auth] Failed to sync secret replicas for ${connectionId}: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }
}

// Initiate OAuth flow — returns the authorize URL for the frontend to redirect/popup
authRoutes.get("/:slug/connect", async (req, res) => {
  const provider = await prisma.provider.findUnique({
    where: { slug: req.params.slug },
  });

  if (!provider) {
    res.status(404).json({ error: "Provider not found" });
    return;
  }

  if (provider.authType !== "oauth2") {
    res.status(400).json({
      error: `Provider ${provider.name} uses ${provider.authType} auth, not OAuth2`,
    });
    return;
  }

  try {
    const selectedProviders = await getSelectedProviders(
      provider,
      readServiceSlugs(req.query.service_slugs)
    );
    const oauthConfig = await getEffectiveOAuthConfig(provider);

    if (
      !oauthConfig ||
      !oauthConfig.authorizeUrl ||
      !oauthConfig.tokenUrl ||
      !oauthConfig.clientId ||
      !oauthConfig.clientSecret
    ) {
      res.status(400).json({
        error: `Client credentials not configured for ${oauthConfig?.displayName || provider.name}`,
      });
      return;
    }

    const redirectUri = `${getBaseUrl(req)}/auth/${oauthConfig.callbackSlug}/callback`;
    const scopes = buildRequestedScopes(selectedProviders, oauthConfig.extraScopes);
    const state = encodeOAuthState({
      callbackSlug: oauthConfig.callbackSlug,
      primaryServiceSlug: provider.slug,
      serviceSlugs: selectedProviders.map((item) => item.slug),
      oauthProviderKey:
        resolveSharedOAuthProviderKey({
          key: provider.oauthProviderKey,
          slug: provider.slug,
        }) || undefined,
    });

    const params = new URLSearchParams({
      client_id: oauthConfig.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: scopes.join(" "),
      state,
      access_type: "offline",
      prompt: "consent",
    });

    if (
      resolveSharedOAuthProviderKey({
        key: provider.oauthProviderKey,
        slug: provider.slug,
      }) === "google"
    ) {
      params.set("include_granted_scopes", "true");
    }

    const authorizeUrl = `${oauthConfig.authorizeUrl}?${params.toString()}`;

    res.json({
      authorize_url: authorizeUrl,
      redirect_uri: redirectUri,
      state,
      service_slugs: selectedProviders.map((item) => item.slug),
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Failed to start OAuth flow",
    });
  }
});

// OAuth callback — exchanges code for tokens
authRoutes.get("/:slug/callback", async (req, res) => {
  const { code, state, error: oauthError } = req.query;
  const stateValue = typeof state === "string" ? state : undefined;
  const oauthErrorValue =
    typeof oauthError === "string" ? oauthError : undefined;
  const codeValue = typeof code === "string" ? code : undefined;
  const statePayload = decodeOAuthState(stateValue);

  if (!statePayload || statePayload.callbackSlug !== req.params.slug) {
    applyOAuthPopupHeaders(res);
    res.status(400).send(
      errorPage("Invalid or expired OAuth state.", req.params.slug, req.params.slug)
    );
    return;
  }

  const primaryProvider = await prisma.provider.findUnique({
    where: { slug: statePayload.primaryServiceSlug },
  });

  if (!primaryProvider) {
    applyOAuthPopupHeaders(res);
    res.status(404).send(
      errorPage("Provider not found", statePayload.primaryServiceSlug, req.params.slug)
    );
    return;
  }

  if (oauthErrorValue) {
    applyOAuthPopupHeaders(res);
    res
      .status(400)
      .send(
        errorPage(
          `OAuth error: ${oauthErrorValue}`,
          primaryProvider.slug,
          req.params.slug
        )
      );
    return;
  }

  if (!codeValue) {
    applyOAuthPopupHeaders(res);
    res
      .status(400)
      .send(errorPage("Missing authorization code", primaryProvider.slug, req.params.slug));
    return;
  }

  try {
    const selectedProviders = await getSelectedProviders(
      primaryProvider,
      statePayload.serviceSlugs
    );
    const oauthConfig = await getEffectiveOAuthConfig(primaryProvider);

    if (
      !oauthConfig ||
      !oauthConfig.clientId ||
      !oauthConfig.clientSecret ||
      !oauthConfig.tokenUrl
    ) {
      applyOAuthPopupHeaders(res);
      res
        .status(400)
        .send(
          errorPage(
            `Client credentials not configured for ${oauthConfig?.displayName || primaryProvider.name}`,
            primaryProvider.slug,
            req.params.slug
          )
        );
      return;
    }

    const clientSecret = decrypt(oauthConfig.clientSecret);
    const redirectUri = `${getBaseUrl(req)}/auth/${oauthConfig.callbackSlug}/callback`;

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code: codeValue,
      redirect_uri: redirectUri,
      client_id: oauthConfig.clientId,
      client_secret: clientSecret,
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    };

    if (!primaryProvider.oauthProviderKey && primaryProvider.slug === "notion") {
      const basic = Buffer.from(`${oauthConfig.clientId}:${clientSecret}`).toString(
        "base64"
      );
      headers.Authorization = `Basic ${basic}`;
    }

    const tokenResponse = await fetch(oauthConfig.tokenUrl, {
      method: "POST",
      headers,
      body: tokenBody,
    });

    const responseText = await tokenResponse.text();
    if (!tokenResponse.ok) {
      applyOAuthPopupHeaders(res);
      res
        .status(400)
        .send(
          errorPage(
            `Token exchange failed: ${responseText}`,
            primaryProvider.slug,
            req.params.slug
          )
        );
      return;
    }

    let tokenData: Record<string, unknown>;
    try {
      tokenData = JSON.parse(responseText);
    } catch {
      tokenData = Object.fromEntries(new URLSearchParams(responseText));
    }

    const tokens = extractTokens(tokenData, primaryProvider.slug);
    if (!tokens.accessToken) {
      applyOAuthPopupHeaders(res);
      res
        .status(400)
        .send(
          errorPage(
            `No access token in response. Keys: ${Object.keys(tokenData).join(", ")}`,
            primaryProvider.slug,
            req.params.slug
          )
        );
      return;
    }

    const createdConnections = statePayload.oauthProviderKey
      ? await saveSharedConnections({
          providers: selectedProviders,
          primaryServiceSlug: statePayload.primaryServiceSlug,
          oauthProviderKey: statePayload.oauthProviderKey,
          tokenData,
          tokens,
        })
      : [
          await (async () => {
            const existingConnection = await prisma.connection.findFirst({
              where: { providerId: primaryProvider.id },
              orderBy: { updatedAt: "desc" },
            });

            const connectionData = {
              label:
                existingConnection?.label ||
                `${primaryProvider.slug}-${Date.now()}`,
              status: "active",
              oauthCredentialId: null,
              accessToken: encrypt(tokens.accessToken),
              refreshToken: tokens.refreshToken
                ? encrypt(tokens.refreshToken)
                : null,
              tokenExpiresAt: tokens.expiresIn
                ? new Date(Date.now() + tokens.expiresIn * 1000)
                : null,
              instanceUrl: tokens.instanceUrl || null,
              metadata: tokens.metadata as Prisma.InputJsonValue | undefined,
            };

            const connection = existingConnection
              ? await prisma.connection.update({
                  where: { id: existingConnection.id },
                  data: connectionData,
                })
              : await prisma.connection.create({
                  data: {
                    providerId: primaryProvider.id,
                    ...connectionData,
                  },
                });

            return {
              id: connection.id,
              provider: primaryProvider.slug,
            };
          })(),
        ];
    await syncSecretReplicasForConnections(createdConnections);

    const dashboardUrl = process.env.CORS_ORIGIN || "http://localhost:3000";
    const primaryConnection = createdConnections.find(
      (connection) => connection.provider === primaryProvider.slug
    );
    const successPayload = {
      type: "OAUTH_SUCCESS",
      connectionId: primaryConnection?.id || null,
      connectionIds: createdConnections.map((connection) => connection.id),
      provider: primaryProvider.slug,
      providers: createdConnections.map((connection) => connection.provider),
    };
    const fallbackUrl = `${dashboardUrl}/connections`;

    applyOAuthPopupHeaders(res);
    res.send(`
      <!DOCTYPE html>
      <html>
      <body>
        <p id="msg" style="font-family: system-ui; text-align: center; margin-top: 40px; color: #666;">
          Connected successfully! Redirecting...
        </p>
        <script>
          const payload = ${JSON.stringify(successPayload)};
          const fallbackUrl = ${JSON.stringify(fallbackUrl)};

          try {
            if (window.opener) {
              // Use a permissive target origin here because the opener may not
              // exactly match the auth-service's configured dashboard origin.
              window.opener.postMessage(payload, '*');
            }
          } catch (error) {
            console.warn('Failed to notify opener window', error);
          }

          if (window.opener) {
            setTimeout(() => window.close(), 150);
            setTimeout(() => {
              if (!window.closed) {
                window.location.href = fallbackUrl;
              }
            }, 1200);
          } else {
            window.location.href = fallbackUrl;
          }
        </script>
      </body>
      </html>
    `);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Token exchange failed";
    applyOAuthPopupHeaders(res);
    res.status(500).send(errorPage(msg, primaryProvider.slug, req.params.slug));
  }
});

// API Key auth — create connection directly
authRoutes.post("/:slug/connect-key", async (req, res) => {
  const { api_key, label } = req.body;
  const provider = await prisma.provider.findUnique({
    where: { slug: req.params.slug },
  });

  if (!provider) {
    res.status(404).json({ error: "Provider not found" });
    return;
  }

  if (provider.authType !== "api_key") {
    res.status(400).json({ error: `Provider uses ${provider.authType}, not api_key` });
    return;
  }

  const connection = await prisma.connection.create({
    data: {
      providerId: provider.id,
      label: label || `${provider.slug}-${Date.now()}`,
      accessToken: encrypt(api_key),
    },
  });
  await syncSecretReplicasForConnections([{ id: connection.id }]);

  res.status(201).json({ id: connection.id, provider: provider.slug, status: "active" });
});

interface ExtractedTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  instanceUrl?: string;
  metadata?: Record<string, unknown>;
}

function extractTokens(data: Record<string, unknown>, slug: string): ExtractedTokens {
  if (slug === "slack") {
    const authedUser = data.authed_user as Record<string, unknown> | undefined;
    const team = data.team as { id?: unknown; name?: unknown } | undefined;
    return {
      accessToken:
        (data.access_token as string) ||
        (authedUser?.access_token as string) ||
        "",
      refreshToken: data.refresh_token as string | undefined,
      metadata: {
        team_id: team?.id ?? data.team_id,
        team_name: team?.name,
        bot_user_id: data.bot_user_id,
        authed_user_token: authedUser?.access_token,
      },
    };
  }

  if (slug === "salesforce") {
    return {
      accessToken: (data.access_token as string) || "",
      refreshToken: data.refresh_token as string | undefined,
      instanceUrl: data.instance_url as string | undefined,
      metadata: { sf_id: data.id, issued_at: data.issued_at },
    };
  }

  if (slug === "notion") {
    return {
      accessToken: (data.access_token as string) || "",
      metadata: {
        bot_id: data.bot_id,
        workspace_id: data.workspace_id,
        workspace_name: data.workspace_name,
      },
    };
  }

  if (slug === "shopify") {
    return {
      accessToken: (data.access_token as string) || "",
      metadata: { scope: data.scope },
    };
  }

  const metadata: Record<string, unknown> = {};
  if (data.scope !== undefined) metadata.scope = data.scope;
  if (data.token_type !== undefined) metadata.token_type = data.token_type;

  return {
    accessToken: (data.access_token as string) || "",
    refreshToken: data.refresh_token as string | undefined,
    expiresIn: data.expires_in ? Number(data.expires_in) : undefined,
    instanceUrl: data.instance_url as string | undefined,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

function errorPage(
  message: string,
  slug: string,
  callbackSlug: string = slug
): string {
  const dashboardUrl = process.env.CORS_ORIGIN || "http://localhost:3000";
  const errorPayload = { type: "OAUTH_ERROR", error: message, provider: slug };

  return `
    <!DOCTYPE html>
    <html>
    <head><title>Connection Error</title></head>
    <body style="font-family: system-ui; max-width: 500px; margin: 40px auto; padding: 20px;">
      <h2 style="color: #e55; font-size: 16px;">Connection Failed</h2>
      <p style="color: #666; font-size: 14px;">${escapeHtml(message)}</p>
      <p style="color: #999; font-size: 12px; margin-top: 20px;">
        Provider: <strong>${escapeHtml(slug)}</strong><br/>
        Make sure the redirect URL in your OAuth app is set to:<br/>
        <code style="background: #f5f5f5; padding: 2px 6px; border-radius: 3px; font-size: 12px;">
          ${escapeHtml(`${process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.replace(":3000", ":4000") : "http://localhost:4000"}/auth/${callbackSlug}/callback`)}
        </code>
      </p>
      <script>
        const payload = ${JSON.stringify(errorPayload)};
        if (window.opener) {
          try {
            window.opener.postMessage(payload, '*');
          } catch (error) {
            console.warn('Failed to notify opener window', error);
          }
        }
      </script>
    </body>
    </html>
  `;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
