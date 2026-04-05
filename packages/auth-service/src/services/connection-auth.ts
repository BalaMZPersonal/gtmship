import type {
  Connection,
  OAuthCredential,
  Provider,
} from "@prisma/client";
import { prisma } from "./db.js";
import { decrypt, encrypt } from "./crypto.js";
import { scheduleConnectionSecretSync } from "./auth-strategy.js";
import {
  getSharedOAuthProviderConfig,
  resolveSharedOAuthProviderKey,
} from "./shared-oauth.js";

type ProviderWithSharedOAuth = Pick<
  Provider,
  | "slug"
  | "authType"
  | "clientId"
  | "clientSecret"
  | "tokenUrl"
  | "oauthProviderKey"
  | "baseUrl"
  | "headerName"
  | "defaultHeaders"
  | "apiSchema"
>;

type StoredCredential = Pick<
  OAuthCredential,
  "id" | "accessToken" | "refreshToken" | "tokenExpiresAt" | "accountEmail"
>;

export type ConnectionWithResolvedAuth = Pick<
  Connection,
  | "id"
  | "oauthCredentialId"
  | "accessToken"
  | "refreshToken"
  | "tokenExpiresAt"
  | "instanceUrl"
  | "createdAt"
  | "updatedAt"
> & {
  provider: ProviderWithSharedOAuth;
  oauthCredential?: StoredCredential | null;
};

export function getEncryptedAccessToken(
  connection: ConnectionWithResolvedAuth
): string | null {
  return connection.oauthCredential?.accessToken || connection.accessToken || null;
}

export function getEncryptedRefreshToken(
  connection: ConnectionWithResolvedAuth
): string | null {
  return connection.oauthCredential?.refreshToken || connection.refreshToken || null;
}

export function getTokenExpiresAt(
  connection: ConnectionWithResolvedAuth
): Date | null {
  return connection.oauthCredential?.tokenExpiresAt || connection.tokenExpiresAt || null;
}

export function hasAccessToken(connection: ConnectionWithResolvedAuth): boolean {
  return !!getEncryptedAccessToken(connection);
}

export function hasRefreshToken(connection: ConnectionWithResolvedAuth): boolean {
  return !!getEncryptedRefreshToken(connection);
}

export function getAccountEmail(
  connection: ConnectionWithResolvedAuth
): string | null {
  return connection.oauthCredential?.accountEmail || null;
}

export function decryptAccessToken(
  connection: ConnectionWithResolvedAuth
): string | null {
  const encryptedToken = getEncryptedAccessToken(connection);
  return encryptedToken ? decrypt(encryptedToken) : null;
}

export async function getEffectiveOAuthRefreshConfig(
  provider: ProviderWithSharedOAuth
): Promise<
  | {
      clientId: string;
      clientSecret: string;
      tokenUrl: string;
      slug: string;
    }
  | null
> {
  const sharedOAuthProviderKey = resolveSharedOAuthProviderKey({
    key: provider.oauthProviderKey,
    slug: provider.slug,
  });

  if (sharedOAuthProviderKey) {
    const sharedConfig = await getSharedOAuthProviderConfig(sharedOAuthProviderKey);
    if (
      !sharedConfig ||
      !sharedConfig.clientId ||
      !sharedConfig.clientSecret ||
      !sharedConfig.tokenUrl
    ) {
      return null;
    }

    return {
      clientId: sharedConfig.clientId,
      clientSecret: decrypt(sharedConfig.clientSecret),
      tokenUrl: sharedConfig.tokenUrl,
      slug: sharedConfig.key,
    };
  }

  if (!provider.clientId || !provider.clientSecret || !provider.tokenUrl) {
    return null;
  }

  return {
    clientId: provider.clientId,
    clientSecret: decrypt(provider.clientSecret),
    tokenUrl: provider.tokenUrl,
    slug: provider.slug,
  };
}

export async function persistRefreshedTokens(
  connection: ConnectionWithResolvedAuth,
  update: {
    accessToken: string;
    refreshToken?: string | null;
    expiresIn?: number;
  }
): Promise<void> {
  const data: Record<string, unknown> = {
    accessToken: encrypt(update.accessToken),
    tokenExpiresAt: update.expiresIn
      ? new Date(Date.now() + update.expiresIn * 1000)
      : null,
  };

  if (update.refreshToken) {
    data.refreshToken = encrypt(update.refreshToken);
  }

  if (connection.oauthCredentialId) {
    await prisma.oAuthCredential.update({
      where: { id: connection.oauthCredentialId },
      data,
    });
  } else {
    await prisma.connection.update({
      where: { id: connection.id },
      data,
    });
  }

  try {
    await scheduleConnectionSecretSync(connection.id);
  } catch (error) {
    console.warn(
      `[connections] Failed to sync secret replicas after refresh for ${connection.id}: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
  }
}

export async function refreshConnectionAccessToken(
  connection: ConnectionWithResolvedAuth
): Promise<
  | {
      success: true;
      accessToken: string;
      expiresIn?: number;
    }
  | {
      success: false;
      error: string;
      needsReconnect?: boolean;
    }
> {
  const refreshTokenEncrypted = getEncryptedRefreshToken(connection);
  if (!refreshTokenEncrypted) {
    return {
      success: false,
      error: "No refresh token stored. Reconnect this integration to get a new token.",
      needsReconnect: true,
    };
  }

  const providerConfig = await getEffectiveOAuthRefreshConfig(connection.provider);
  if (!providerConfig) {
    return {
      success: false,
      error: "Provider OAuth credentials not fully configured.",
    };
  }

  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: decrypt(refreshTokenEncrypted),
      client_id: providerConfig.clientId,
      client_secret: providerConfig.clientSecret,
    });

    const response = await fetch(providerConfig.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    });

    if (!response.ok) {
      return {
        success: false,
        error:
          "Token refresh failed. The refresh token may be revoked. Reconnect this integration.",
        needsReconnect: true,
      };
    }

    const data = (await response.json()) as Record<string, unknown>;
    const newAccessToken = data.access_token as string | undefined;

    if (!newAccessToken) {
      return {
        success: false,
        error: "No access token in refresh response.",
      };
    }

    await persistRefreshedTokens(connection, {
      accessToken: newAccessToken,
      refreshToken: data.refresh_token as string | undefined,
      expiresIn: data.expires_in ? Number(data.expires_in) : undefined,
    });

    return {
      success: true,
      accessToken: newAccessToken,
      expiresIn: data.expires_in ? Number(data.expires_in) : undefined,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Token refresh failed.",
    };
  }
}
