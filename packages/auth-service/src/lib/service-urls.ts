function normalizeUrl(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  const resolved = trimmed && trimmed.length > 0 ? trimmed : fallback;
  return resolved.replace(/\/+$/, "");
}

function normalizeOptionalUrl(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/\/+$/, "");
}

function normalizeOptionalOrigin(value: string | undefined | null): string | null {
  const normalized = normalizeOptionalUrl(value);
  if (!normalized) {
    return null;
  }

  try {
    return new URL(normalized).origin;
  } catch {
    return normalized;
  }
}

export function parseOriginList(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((entry) => normalizeOptionalOrigin(entry))
    .filter((entry): entry is string => Boolean(entry));
}

export function getDashboardUrl(): string {
  return normalizeUrl(
    process.env.DASHBOARD_URL || process.env.CORS_ORIGIN,
    "http://localhost:3000"
  );
}

export function getHomepageUrl(): string | null {
  return normalizeOptionalOrigin(process.env.HOMEPAGE_URL);
}

export function getAllowedWebOrigins(): string[] {
  const values = new Set<string>([
    normalizeOptionalOrigin(getDashboardUrl()) || getDashboardUrl(),
  ]);
  const homepageUrl = getHomepageUrl();

  if (homepageUrl) {
    values.add(homepageUrl);
  }

  for (const origin of parseOriginList(process.env.CORS_ORIGINS)) {
    values.add(origin);
  }

  return [...values];
}

export function isAllowedWebOrigin(
  origin: string | undefined | null,
  allowedOrigins: string[] = getAllowedWebOrigins()
): boolean {
  if (!origin || origin === "null") {
    return true;
  }

  const normalizedOrigin = normalizeOptionalOrigin(origin);
  if (!normalizedOrigin) {
    return true;
  }

  return allowedOrigins.includes(normalizedOrigin);
}

export function getAuthPublicUrl(): string {
  const explicit = process.env.AUTH_PUBLIC_URL?.trim();
  if (explicit) {
    return normalizeUrl(explicit, explicit);
  }

  const port = process.env.PORT || "4000";
  return `http://localhost:${port}`;
}

export function getOAuthCallbackUrl(callbackSlug: string): string {
  return new URL(`/auth/${callbackSlug}/callback`, `${getAuthPublicUrl()}/`).toString();
}
