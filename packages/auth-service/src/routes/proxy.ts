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

export function buildProxyUpstreamUrl(
  baseUrl: string,
  path: string,
  originalUrl?: string
): string {
  const queryStart = originalUrl?.indexOf("?") ?? -1;
  const search = queryStart >= 0 ? originalUrl!.slice(queryStart) : "";
  return `${baseUrl}${path}${search}`;
}

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
    const url = buildProxyUpstreamUrl(baseUrl, path, req.originalUrl);

    const incomingContentType = req.headers["content-type"] || "application/json";
    const headers: Record<string, string> = {
      "Content-Type": incomingContentType,
      ...buildAuthHeaders({
        accessToken: token,
        provider: connection.provider,
      }),
    };

    // Forward the request body: use raw body for non-JSON, JSON.stringify for JSON
    let requestBody: string | Buffer | undefined;
    if (!["GET", "HEAD"].includes(req.method)) {
      if (incomingContentType.includes("application/json")) {
        requestBody = JSON.stringify(req.body);
      } else if (Buffer.isBuffer(req.body)) {
        requestBody = req.body;
      } else if (typeof req.body === "string") {
        requestBody = req.body;
      } else {
        requestBody = JSON.stringify(req.body);
      }
    }

    // Forward the request
    const response = await fetch(url, {
      method: req.method,
      headers,
      body: requestBody,
    });

    // Handle response based on upstream content type
    const responseContentType = response.headers.get("content-type") || "";
    const isJsonResponse =
      responseContentType.includes("application/json") ||
      responseContentType.includes("text/json");

    if (isJsonResponse) {
      const data = await response.json().catch(() => null);
      res.status(response.status).json(data);
    } else {
      // Binary or non-JSON response: return as base64 envelope
      const buffer = Buffer.from(await response.arrayBuffer());
      res.status(response.status).json({
        _binary: true,
        contentType: responseContentType,
        data: buffer.toString("base64"),
        size: buffer.length,
      });
    }
  } catch (error) {
    res.status(502).json({
      error: "Proxy request failed",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});
