import { Router } from "express";
import { buildAuthHeaders } from "../services/auth-headers.js";
import {
  decryptAccessToken,
  getEncryptedRefreshToken,
  getTokenExpiresAt,
  refreshConnectionAccessToken,
} from "../services/connection-auth.js";
import {
  getRuntimeIdentityFromRequest,
  resolveConnectionForProvider,
  validateRuntimeKey,
} from "../services/workflow-binding-resolver.js";

export const proxyRoutes: Router = Router();

/**
 * Proxy requests to connected platforms with injected auth headers.
 *
 * Usage: GET/POST/PUT/DELETE /proxy/:providerSlug/any/path/here
 *
 * The auth service injects the correct Authorization header
 * based on the provider's auth_type and the connection's token.
 */
proxyRoutes.all("/:slug/{*splat}", async (req, res) => {
  const { slug, splat } = req.params as unknown as {
    slug: string;
    splat?: string | string[];
  };
  const path = "/" + (Array.isArray(splat) ? splat.join("/") : splat || "");
  const runtimeKeyValidation = await validateRuntimeKey(req);
  if (!runtimeKeyValidation.ok) {
    res.status(401).json({ error: runtimeKeyValidation.error });
    return;
  }
  const runtimeIdentity = getRuntimeIdentityFromRequest(req);
  const { connection, resolution } = await resolveConnectionForProvider(
    slug,
    runtimeIdentity
  );

  if (!connection) {
    res.status(
      resolution.fallbackReason === "ambiguous_without_binding" ? 409 : 404
    ).json({
      error: `No active connection for provider: ${slug}`,
      resolution,
    });
    return;
  }

  try {
    let token = decryptAccessToken(connection);

    // Auto-refresh expired OAuth2 tokens
    if (
      connection.provider.authType === "oauth2" &&
      getTokenExpiresAt(connection) &&
      getTokenExpiresAt(connection)! <= new Date() &&
      getEncryptedRefreshToken(connection)
    ) {
      const refreshed = await refreshConnectionAccessToken(connection);
      if (refreshed.success) {
        token = refreshed.accessToken;
        console.log(`[proxy] Refreshed token for ${connection.provider.slug}`);
      } else {
        console.warn(`[proxy] Token expired and refresh failed for ${slug}`);
      }
    }

    if (!token) {
      res.status(401).json({ error: `No access token stored for provider: ${slug}` });
      return;
    }

    const baseUrl = connection.instanceUrl || connection.provider.baseUrl;
    const url = `${baseUrl}${path}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...buildAuthHeaders({
        accessToken: token,
        provider: connection.provider,
      }),
    };

    // Forward the request
    const response = await fetch(url, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method)
        ? undefined
        : JSON.stringify(req.body),
    });

    const data = await response.json().catch(() => null);
    res.status(response.status).json(data);
  } catch (error) {
    res.status(502).json({
      error: "Proxy request failed",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});
