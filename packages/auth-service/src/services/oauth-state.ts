import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_STATE_AGE_MS = 15 * 60 * 1000;

export interface OAuthStatePayload {
  callbackSlug: string;
  primaryServiceSlug: string;
  serviceSlugs: string[];
  oauthProviderKey?: string;
  createdAt: number;
}

function getStateSecret(): string {
  return process.env.AUTH_STATE_SECRET || process.env.ENCRYPTION_KEY || "gtmship-dev-state-secret";
}

function signStateBody(body: string): string {
  return createHmac("sha256", getStateSecret()).update(body).digest("base64url");
}

export function encodeOAuthState(payload: Omit<OAuthStatePayload, "createdAt">): string {
  const body = Buffer.from(
    JSON.stringify({
      ...payload,
      createdAt: Date.now(),
    } satisfies OAuthStatePayload)
  ).toString("base64url");
  const signature = signStateBody(body);
  return `${body}.${signature}`;
}

export function decodeOAuthState(
  state: unknown
): OAuthStatePayload | null {
  if (!state || typeof state === "object") {
    if (!Array.isArray(state)) {
      return null;
    }
  }

  if (Array.isArray(state)) return null;
  if (typeof state !== "string") return null;

  const [body, signature] = state.split(".");
  if (!body || !signature) return null;

  const expected = signStateBody(body);
  const signatureBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);

  if (
    signatureBytes.length !== expectedBytes.length ||
    !timingSafeEqual(signatureBytes, expectedBytes)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8")
    ) as OAuthStatePayload;

    if (
      !payload.callbackSlug ||
      !payload.primaryServiceSlug ||
      !Array.isArray(payload.serviceSlugs) ||
      typeof payload.createdAt !== "number"
    ) {
      return null;
    }

    if (Date.now() - payload.createdAt > MAX_STATE_AGE_MS) {
      return null;
    }

    return {
      ...payload,
      serviceSlugs: Array.from(new Set(payload.serviceSlugs.filter(Boolean))),
    };
  } catch {
    return null;
  }
}
