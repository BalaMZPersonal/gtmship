import { prisma } from "./db.js";

export interface SharedOAuthDefinition {
  key: string;
  name: string;
  callbackSlug: string;
  authorizeUrl: string;
  tokenUrl: string;
  extraScopes?: string[];
}

const SHARED_OAUTH_DEFINITIONS: Record<string, SharedOAuthDefinition> = {
  google: {
    key: "google",
    name: "Google",
    callbackSlug: "google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    extraScopes: ["openid", "email"],
  },
};

const SHARED_OAUTH_SERVICE_SLUGS: Record<string, string> = {
  gmail: "google",
  "google-sheets": "google",
  "google-calendar": "google",
  "google-ads": "google",
};

export function inferSharedOAuthProviderKeyFromSlug(
  slug: string | null | undefined
): string | null {
  if (!slug) return null;
  return SHARED_OAUTH_SERVICE_SLUGS[slug] || null;
}

export function resolveSharedOAuthProviderKey(input: {
  key?: string | null;
  slug?: string | null;
}): string | null {
  return input.key || inferSharedOAuthProviderKeyFromSlug(input.slug) || null;
}

export function getSharedOAuthDefinition(
  key: string | null | undefined
): SharedOAuthDefinition | null {
  if (!key) return null;
  return SHARED_OAUTH_DEFINITIONS[key] || null;
}

export async function getSharedOAuthProviderConfig(
  key: string | null | undefined
): Promise<
  | {
      key: string;
      name: string;
      callbackSlug: string;
      authorizeUrl: string;
      tokenUrl: string;
      clientId: string | null;
      clientSecret: string | null;
      hasCredentials: boolean;
      extraScopes: string[];
    }
  | null
> {
  const definition = getSharedOAuthDefinition(key);
  if (!definition) return null;

  const stored = await prisma.oAuthProvider.findUnique({
    where: { key: definition.key },
  });

  const clientId = stored?.clientId || null;
  const clientSecret = stored?.clientSecret || null;

  return {
    key: definition.key,
    name: stored?.name || definition.name,
    callbackSlug: stored?.callbackSlug || definition.callbackSlug,
    authorizeUrl: stored?.authorizeUrl || definition.authorizeUrl,
    tokenUrl: stored?.tokenUrl || definition.tokenUrl,
    clientId,
    clientSecret,
    hasCredentials: !!(clientId && clientSecret),
    extraScopes: definition.extraScopes || [],
  };
}
