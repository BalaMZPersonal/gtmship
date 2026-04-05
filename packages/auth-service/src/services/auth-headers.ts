function readApiSchemaAuth(apiSchema: unknown): {
  type?: string;
  format?: string;
} | null {
  if (!apiSchema || typeof apiSchema !== "object" || Array.isArray(apiSchema)) {
    return null;
  }

  const auth = (apiSchema as { auth?: unknown }).auth;
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    return null;
  }

  const typedAuth = auth as { type?: unknown; format?: unknown };
  return {
    type: typeof typedAuth.type === "string" ? typedAuth.type : undefined,
    format: typeof typedAuth.format === "string" ? typedAuth.format : undefined,
  };
}

function formatApiKeyHeaderValue(
  token: string,
  headerName: string | null,
  apiSchema: unknown
): string {
  if (/^(Bearer|Basic)\s+/i.test(token)) {
    return token;
  }

  const auth = readApiSchemaAuth(apiSchema);
  const authType = auth?.type?.toLowerCase() || "";
  const authFormat = auth?.format?.toLowerCase() || "";

  if (authType.includes("basic") || authFormat.includes("basic")) {
    return `Basic ${Buffer.from(
      token.includes(":") ? token : `${token}:`
    ).toString("base64")}`;
  }

  if (
    authType.includes("bearer") ||
    authFormat.includes("bearer") ||
    (headerName || "").toLowerCase() === "authorization"
  ) {
    return `Bearer ${token}`;
  }

  return token;
}

function normalizeDefaultHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, headerValue]) =>
        key.trim().length > 0 &&
        typeof headerValue === "string" &&
        headerValue.trim().length > 0
    )
  ) as Record<string, string>;
}

export function buildAuthHeaders(connection: {
  accessToken: string;
  provider: {
    authType: string;
    headerName: string | null;
    apiSchema?: unknown;
    defaultHeaders?: unknown;
  };
}): Record<string, string> {
  const token = connection.accessToken;
  const defaultHeaders = normalizeDefaultHeaders(
    connection.provider.defaultHeaders
  );

  switch (connection.provider.authType) {
    case "oauth2":
      return { ...defaultHeaders, Authorization: `Bearer ${token}` };
    case "api_key":
      return {
        ...defaultHeaders,
        [connection.provider.headerName || "X-API-Key"]: formatApiKeyHeaderValue(
          token,
          connection.provider.headerName,
          connection.provider.apiSchema
        ),
      };
    case "basic":
      return {
        ...defaultHeaders,
        Authorization: `Basic ${Buffer.from(
          token.includes(":") ? token : `${token}:`
        ).toString("base64")}`,
      };
    default:
      return { ...defaultHeaders, Authorization: `Bearer ${token}` };
  }
}
