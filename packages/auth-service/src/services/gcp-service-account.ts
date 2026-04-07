export interface GcpServiceAccountKey {
  type?: string;
  project_id?: string;
  private_key_id?: string;
  private_key?: string;
  client_email?: string;
  client_id?: string;
  auth_uri?: string;
  token_uri?: string;
  auth_provider_x509_cert_url?: string;
  client_x509_cert_url?: string;
  universe_domain?: string;
  [key: string]: unknown;
}

function normalizeText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function buildObjectBodyCandidate(rawValue: string): string | null {
  const trimmed = rawValue.trim();
  if (!trimmed || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return null;
  }

  if (/^"[^"]+"\s*:/.test(trimmed) || /^[A-Za-z_][\w-]*\s*:/.test(trimmed)) {
    return `{${trimmed}}`;
  }

  return null;
}

function parseCandidate(candidate: string): GcpServiceAccountKey {
  const parsed = JSON.parse(candidate) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Service account JSON must be a single JSON object.");
  }
  return parsed as GcpServiceAccountKey;
}

export function parseGcpServiceAccountKey(
  rawValue: string
): GcpServiceAccountKey {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    throw new Error("Service account JSON is required.");
  }

  const candidates = [trimmed];
  const objectBodyCandidate = buildObjectBodyCandidate(trimmed);
  if (objectBodyCandidate) {
    candidates.push(objectBodyCandidate);
  }

  let lastError: Error | null = null;
  for (const candidate of candidates) {
    try {
      return parseCandidate(candidate);
    } catch (error) {
      lastError =
        error instanceof Error ? error : new Error("Invalid service account JSON.");
    }
  }

  const detail = lastError?.message || "Invalid service account JSON.";
  throw new Error(
    `Service account JSON is invalid: ${detail} Paste the full Google Cloud key JSON, including the opening "{" and closing "}".`
  );
}

export function validateGcpServiceAccountKey(
  value: GcpServiceAccountKey
): GcpServiceAccountKey {
  const missing = ["client_email", "private_key", "project_id"].filter((key) => {
    return !normalizeText(value[key]);
  });

  if (missing.length > 0) {
    throw new Error(
      `Service account key missing required fields (${missing.join(", ")}).`
    );
  }

  return value;
}

export function parseAndValidateGcpServiceAccountKey(
  rawValue: string
): GcpServiceAccountKey {
  return validateGcpServiceAccountKey(parseGcpServiceAccountKey(rawValue));
}

export function normalizeGcpServiceAccountKey(rawValue: string): string {
  return JSON.stringify(parseAndValidateGcpServiceAccountKey(rawValue));
}
