import { Router } from "express";
import { prisma } from "../services/db.js";
import { buildAuthHeaders } from "../services/auth-headers.js";
import {
  decryptAccessToken,
  getEncryptedRefreshToken,
  refreshConnectionAccessToken,
} from "../services/connection-auth.js";
import {
  getRuntimeIdentityFromRequest,
  resolveConnectionForProvider,
  validateRuntimeKey,
} from "../services/workflow-binding-resolver.js";
import {
  getConnectionSecretReplicas,
  normalizeSecretBackendKind,
  syncConnectionSecretReplicasById,
} from "../services/connection-secret-replicas.js";

export const connectionRoutes: Router = Router();

function toOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
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

// List all connections
connectionRoutes.get("/", async (_req, res) => {
  const connections = await prisma.connection.findMany({
    include: {
      provider: {
        select: {
          name: true, slug: true, authType: true, baseUrl: true,
          logoUrl: true, description: true, category: true,
          source: true, docsUrl: true, clientId: true,
          oauthProviderKey: true,
        },
      },
      oauthCredential: {
        select: {
          id: true,
          accountEmail: true,
          accessToken: true,
          refreshToken: true,
          tokenExpiresAt: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const sharedCredentialStatus = await getSharedCredentialStatus(
    connections.map((connection) => connection.provider.oauthProviderKey)
  );

  const safe = connections.map(({ accessToken, refreshToken, oauthCredential, ...c }) => {
    const { clientId, ...providerSafe } = c.provider;
    return {
      ...c,
      provider: {
        ...providerSafe,
        hasCredentials:
          !!clientId ||
          (providerSafe.oauthProviderKey
            ? sharedCredentialStatus.get(providerSafe.oauthProviderKey) || false
            : false),
      },
      hasToken: !!(oauthCredential?.accessToken || accessToken),
      hasRefreshToken: !!(oauthCredential?.refreshToken || refreshToken),
      tokenExpiresAt: oauthCredential?.tokenExpiresAt || c.tokenExpiresAt,
      accountEmail: oauthCredential?.accountEmail || null,
    };
  });

  res.json(safe);
});

// Get a connection's raw token (for SDK use)
connectionRoutes.get("/:slug/token", async (req, res) => {
  const runtimeKeyValidation = await validateRuntimeKey(req);
  if (!runtimeKeyValidation.ok) {
    res.status(401).json({ error: runtimeKeyValidation.error });
    return;
  }

  const runtimeIdentity = getRuntimeIdentityFromRequest(req);
  const { connection, resolution } = await resolveConnectionForProvider(
    req.params.slug,
    runtimeIdentity
  );

  if (!connection) {
    res.status(
      resolution.fallbackReason === "ambiguous_without_binding" ? 409 : 404
    ).json({
      error: `No active connection for ${req.params.slug}`,
      resolution,
    });
    return;
  }

  const accessToken = decryptAccessToken(connection);
  if (!accessToken) {
    res.status(404).json({ error: `No access token stored for ${req.params.slug}` });
    return;
  }

  res.json({ access_token: accessToken, resolution });
});

connectionRoutes.get("/:id/secret-replicas", async (req, res) => {
  const connection = await prisma.connection.findUnique({
    where: { id: req.params.id },
    select: { id: true },
  });

  if (!connection) {
    res.status(404).json({ error: "Connection not found" });
    return;
  }

  const replicas = await getConnectionSecretReplicas(connection.id);
  res.json(replicas);
});

connectionRoutes.post("/:id/secret-replicas/sync", async (req, res) => {
  const connection = await prisma.connection.findUnique({
    where: { id: req.params.id },
    select: { id: true },
  });

  if (!connection) {
    res.status(404).json({ error: "Connection not found" });
    return;
  }

  const backendKind = normalizeSecretBackendKind(
    toOptionalString(req.body?.backendKind)
  );
  const backendRegion = toOptionalString(req.body?.backendRegion);
  const backendProjectId = toOptionalString(req.body?.backendProjectId);

  if (req.body?.backendKind && !backendKind) {
    res.status(400).json({
      error:
        "backendKind must be one of aws_secrets_manager or gcp_secret_manager.",
    });
    return;
  }

  const replicas = await syncConnectionSecretReplicasById(
    connection.id,
    backendKind
      ? {
          kind: backendKind,
          region: backendRegion,
          projectId: backendProjectId,
        }
      : undefined
  );

  res.json({
    synced: replicas.length,
    replicas,
  });
});

// Test a connection
connectionRoutes.post("/:id/test", async (req, res) => {
  const connection = await prisma.connection.findUnique({
    where: { id: req.params.id },
    include: {
      provider: true,
      oauthCredential: {
        select: {
          id: true,
          accountEmail: true,
          accessToken: true,
          refreshToken: true,
          tokenExpiresAt: true,
        },
      },
    },
  });

  if (!connection) {
    res.status(404).json({ error: "Connection not found" });
    return;
  }

  try {
    const baseUrl = connection.instanceUrl || connection.provider.baseUrl;
    const testEndpoint = connection.provider.testEndpoint;
    const accessToken = decryptAccessToken(connection);

    if (!testEndpoint) {
      res.json({ success: true, message: "No test endpoint configured" });
      return;
    }

    if (!accessToken) {
      res.json({
        success: false,
        error: "No access token stored for this connection.",
      });
      return;
    }

    const response = await fetch(`${baseUrl}${testEndpoint}`, {
      headers: {
        "Content-Type": "application/json",
        ...buildAuthHeaders({
          accessToken,
          provider: connection.provider,
        }),
      },
    });

    if (response.ok) {
      res.json({ success: true, status: response.status });
    } else {
      res.json({
        success: false,
        status: response.status,
        error: await response.text(),
      });
    }
  } catch (error) {
    res.json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// Refresh an expired OAuth2 token
connectionRoutes.post("/:id/refresh", async (req, res) => {
  const connection = await prisma.connection.findUnique({
    where: { id: req.params.id },
    include: {
      provider: true,
      oauthCredential: {
        select: {
          id: true,
          accountEmail: true,
          accessToken: true,
          refreshToken: true,
          tokenExpiresAt: true,
        },
      },
    },
  });

  if (!connection) {
    res.status(404).json({ error: "Connection not found" });
    return;
  }

  if (connection.provider.authType !== "oauth2") {
    res.json({ success: true, message: "Not an OAuth2 connection — no refresh needed." });
    return;
  }

  if (!getEncryptedRefreshToken(connection)) {
    res.status(400).json({
      success: false,
      error: "No refresh token stored. Reconnect this integration to get a new token.",
      needsReconnect: true,
    });
    return;
  }

  const refreshed = await refreshConnectionAccessToken(connection);
  if (!refreshed.success) {
    res.status(400).json({
      success: false,
      error: refreshed.error,
      needsReconnect: refreshed.needsReconnect || false,
    });
    return;
  }

  console.log(`[connections] Refreshed token for ${connection.provider.slug}`);
  res.json({ success: true, message: "Token refreshed successfully." });
});

// Delete a connection
connectionRoutes.delete("/:id", async (req, res) => {
  await prisma.connection.delete({ where: { id: req.params.id } });
  res.status(204).end();
});
