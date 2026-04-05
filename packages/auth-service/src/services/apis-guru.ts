// APIs.guru integration — resolves OpenAPI spec URLs from the public directory
// https://apis.guru / https://github.com/APIs-guru/openapi-directory
// Falls back to direct GitHub spec URLs for providers where APIs.guru coverage is incomplete.

const APIS_GURU_DIRECTORY_URL = "https://api.apis.guru/v2/list.json";
const DIRECTORY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const HUBSPOT_SPEC_BASE =
  "https://raw.githubusercontent.com/HubSpot/HubSpot-public-api-spec-collection/main/PublicApiSpecs";

/**
 * Direct spec URLs for providers where APIs.guru doesn't cover the core API.
 * These take precedence over APIs.guru lookups.
 */
const DIRECT_SPEC_URLS: Record<string, string> = {
  hubspot: `${HUBSPOT_SPEC_BASE}/CRM/Objects/Rollouts/424/v3/objects.json`,
};

/**
 * Maps GTMShip provider slugs to APIs.guru directory keys.
 * Providers in DIRECT_SPEC_URLS are handled separately and don't need entries here.
 */
const SLUG_TO_APIS_GURU_KEY: Record<string, string | string[]> = {
  stripe: "stripe.com",
  slack: "slack.com",
  github: "github.com:api.github.com",
  gmail: "googleapis.com:gmail",
  "google-sheets": "googleapis.com:sheets",
  notion: "notion.com",
  sendgrid: "sendgrid.com",
  twilio: [
    "twilio.com:twilio_messaging_v1",
    "twilio.com:api",
    "twilio.com:twilio_conversations_v1",
    "twilio.com:twilio_verify_v2",
    "twilio.com:twilio_voice_v1",
    "twilio.com:twilio_video_v1",
  ],
  jira: "atlassian.com:jira",
  zoom: "zoom.us",
};

interface ApisGuruEntry {
  preferred: string;
  versions: Record<
    string,
    { swaggerUrl?: string; openapiVer?: string; info?: { title?: string } }
  >;
}

type ApisGuruDirectory = Record<string, ApisGuruEntry>;

let _cachedDirectory: { data: ApisGuruDirectory; fetchedAt: number } | null = null;
let _loading: Promise<ApisGuruDirectory | null> | null = null;

async function fetchDirectory(): Promise<ApisGuruDirectory | null> {
  if (_cachedDirectory && Date.now() - _cachedDirectory.fetchedAt < DIRECTORY_TTL_MS) {
    return _cachedDirectory.data;
  }
  if (_loading) return _loading;

  _loading = (async () => {
    try {
      const res = await fetch(APIS_GURU_DIRECTORY_URL, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        console.warn(`[apis-guru] Directory fetch failed: ${res.status}`);
        return _cachedDirectory?.data ?? null;
      }
      const data = (await res.json()) as ApisGuruDirectory;
      _cachedDirectory = { data, fetchedAt: Date.now() };
      return data;
    } catch (err) {
      console.warn("[apis-guru] Directory fetch error:", (err as Error).message);
      return _cachedDirectory?.data ?? null;
    } finally {
      _loading = null;
    }
  })();

  return _loading;
}

function extractSpecUrl(entry: ApisGuruEntry): string | null {
  const preferred = entry.versions[entry.preferred];
  return preferred?.swaggerUrl ?? null;
}

/**
 * Resolve the primary OpenAPI spec URL for a GTMShip provider slug.
 * Checks direct spec URLs first, then falls back to APIs.guru.
 * Returns null if no spec is available.
 */
export async function resolveOpenApiSpecUrl(slug: string): Promise<string | null> {
  // Check direct spec URLs first (e.g., HubSpot official GitHub specs)
  const direct = DIRECT_SPEC_URLS[slug];
  if (direct) return direct;

  // Fall back to APIs.guru
  const keys = SLUG_TO_APIS_GURU_KEY[slug];
  if (!keys) return null;

  const directory = await fetchDirectory();
  if (!directory) return null;

  const primaryKey = Array.isArray(keys) ? keys[0] : keys;
  const entry = directory[primaryKey];
  if (!entry) return null;

  return extractSpecUrl(entry);
}

/**
 * Check if a slug has any spec coverage (direct or APIs.guru).
 */
export function hasApisGuruCoverage(slug: string): boolean {
  return slug in DIRECT_SPEC_URLS || slug in SLUG_TO_APIS_GURU_KEY;
}
