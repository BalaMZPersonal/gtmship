import { Router } from "express";
import { prisma } from "../services/db.js";
import { encrypt } from "../services/crypto.js";
import {
  getSharedOAuthDefinition,
  getSharedOAuthProviderConfig,
} from "../services/shared-oauth.js";

export const oauthProviderRoutes: Router = Router();

function getBaseUrl(req: import("express").Request): string {
  const proto = (req.get("x-forwarded-proto") || req.protocol) as string;
  const host = req.get("x-forwarded-host") || req.get("host");
  return `${proto}://${host}`;
}

oauthProviderRoutes.get("/:key", async (req, res) => {
  const definition = getSharedOAuthDefinition(req.params.key);
  if (!definition) {
    res.status(404).json({ error: "Shared OAuth provider not found" });
    return;
  }

  const config = await getSharedOAuthProviderConfig(definition.key);
  if (!config) {
    res.status(404).json({ error: "Shared OAuth provider not found" });
    return;
  }

  const redirectUri = `${getBaseUrl(req)}/auth/${config.callbackSlug}/callback`;

  res.json({
    key: config.key,
    name: config.name,
    callback_slug: config.callbackSlug,
    authorize_url: config.authorizeUrl,
    token_url: config.tokenUrl,
    redirect_uri: redirectUri,
    has_credentials: config.hasCredentials,
  });
});

oauthProviderRoutes.put("/:key", async (req, res) => {
  const definition = getSharedOAuthDefinition(req.params.key);
  if (!definition) {
    res.status(404).json({ error: "Shared OAuth provider not found" });
    return;
  }

  const {
    name,
    callback_slug,
    authorize_url,
    token_url,
    client_id,
    client_secret,
  } = req.body;

  try {
    const existing = await prisma.oAuthProvider.findUnique({
      where: { key: definition.key },
    });

    const oauthProvider = await prisma.oAuthProvider.upsert({
      where: { key: definition.key },
      create: {
        key: definition.key,
        name: name || definition.name,
        callbackSlug: callback_slug || definition.callbackSlug,
        authorizeUrl: authorize_url || definition.authorizeUrl,
        tokenUrl: token_url || definition.tokenUrl,
        clientId: client_id || null,
        clientSecret: client_secret ? encrypt(client_secret) : null,
      },
      update: {
        name: name || existing?.name || definition.name,
        callbackSlug: callback_slug || existing?.callbackSlug || definition.callbackSlug,
        authorizeUrl: authorize_url || existing?.authorizeUrl || definition.authorizeUrl,
        tokenUrl: token_url || existing?.tokenUrl || definition.tokenUrl,
        clientId:
          client_id !== undefined ? client_id || null : existing?.clientId || null,
        clientSecret:
          client_secret !== undefined
            ? client_secret
              ? encrypt(client_secret)
              : null
            : existing?.clientSecret || null,
      },
    });

    res.json({
      key: oauthProvider.key,
      name: oauthProvider.name,
      callback_slug: oauthProvider.callbackSlug,
      has_credentials: !!(oauthProvider.clientId && oauthProvider.clientSecret),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to save shared OAuth provider";
    res.status(500).json({ error: message });
  }
});
