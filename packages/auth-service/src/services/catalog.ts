// Integration catalog powered by Activepieces (MIT license)
// Extracts auth config, display info, and categories from piece packages

export interface CatalogActionProp {
  type: string;
  required: boolean;
  displayName: string;
  description?: string;
}

export interface CatalogAction {
  name: string;
  displayName: string;
  description: string;
  props: Record<string, CatalogActionProp>;
}

export interface CatalogApiSchema {
  customApiBaseUrl?: string;
  actions: CatalogAction[];
}

export interface CatalogProvider {
  slug: string;
  name: string;
  description: string;
  logoUrl: string;
  category: string;
  authType: "oauth2" | "api_key" | "basic";
  authUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
  baseUrl?: string;
  headerName?: string;
  docsUrl?: string;
  oauthProviderKey?: string;
  defaultHeaders?: Record<string, string>;
  apiSchema?: CatalogApiSchema | null;
}

interface ActivepiecesAction {
  name: string;
  displayName: string;
  description?: string;
  props: Record<
    string,
    {
      type: string;
      required?: boolean;
      displayName?: string;
      description?: string;
    }
  >;
}

interface ActivepiecesDef {
  displayName: string;
  description?: string;
  logoUrl?: string;
  categories?: string[];
  actions?: (() => Record<string, ActivepiecesAction>) | Record<string, ActivepiecesAction>;
  auth?:
    | { type?: string; authUrl?: string; tokenUrl?: string; scope?: string[] }
    | Array<{ type?: string; authUrl?: string; tokenUrl?: string; scope?: string[] }>;
}

const CATEGORY_MAP: Record<string, string> = {
  SALES_AND_CRM: "CRM",
  COMMUNICATION: "Communication",
  MARKETING: "Marketing",
  DEVELOPER_TOOLS: "Developer Tools",
  PRODUCTIVITY: "Productivity",
  COMMERCE: "E-commerce",
  CONTENT_AND_FILES: "Content",
  BUSINESS_INTELLIGENCE: "Analytics",
  CUSTOMER_SUPPORT: "Support",
  ARTIFICIAL_INTELLIGENCE: "AI",
  HUMAN_RESOURCES: "HR",
  ACCOUNTING: "Finance",
};

function extractAuth(auth: ActivepiecesDef["auth"]): {
  type: "oauth2" | "api_key" | "basic";
  authUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
} {
  const a = Array.isArray(auth) ? auth[0] : auth;
  if (!a) return { type: "api_key" };

  const apType = a.type || (a.authUrl ? "OAUTH2" : "SECRET_TEXT");
  const type =
    apType === "OAUTH2"
      ? "oauth2"
      : apType === "BASIC"
        ? "basic"
        : "api_key";

  return {
    type,
    authUrl: a.authUrl?.split("?")[0],
    tokenUrl: a.tokenUrl,
    scopes: a.scope,
  };
}

function mapCategory(categories?: string[]): string {
  if (!categories?.length) return "Other";
  return CATEGORY_MAP[categories[0]] || "Other";
}

const PIECE_REGISTRY: Array<{
  pkg: string;
  exportName: string;
  slug: string;
  baseUrl: string;
  docsUrl: string;
  headerName?: string;
  oauthProviderKey?: string;
}> = [
  { slug: "hubspot", pkg: "@activepieces/piece-hubspot", exportName: "hubspot", baseUrl: "https://api.hubapi.com", docsUrl: "https://developers.hubspot.com/docs/api/overview" },
  { slug: "salesforce", pkg: "@activepieces/piece-salesforce", exportName: "salesforce", baseUrl: "{instance_url}", docsUrl: "https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest" },
  { slug: "slack", pkg: "@activepieces/piece-slack", exportName: "slack", baseUrl: "https://slack.com/api", docsUrl: "https://api.slack.com/methods" },
  { slug: "gmail", pkg: "@activepieces/piece-gmail", exportName: "gmail", baseUrl: "https://gmail.googleapis.com", docsUrl: "https://developers.google.com/gmail/api", oauthProviderKey: "google" },
  { slug: "google-sheets", pkg: "@activepieces/piece-google-sheets", exportName: "googleSheets", baseUrl: "https://sheets.googleapis.com", docsUrl: "https://developers.google.com/sheets/api", oauthProviderKey: "google" },
  { slug: "stripe", pkg: "@activepieces/piece-stripe", exportName: "stripe", baseUrl: "https://api.stripe.com", docsUrl: "https://stripe.com/docs/api", headerName: "Authorization" },
  { slug: "github", pkg: "@activepieces/piece-github", exportName: "github", baseUrl: "https://api.github.com", docsUrl: "https://docs.github.com/en/rest" },
  { slug: "notion", pkg: "@activepieces/piece-notion", exportName: "notion", baseUrl: "https://api.notion.com", docsUrl: "https://developers.notion.com" },
  { slug: "airtable", pkg: "@activepieces/piece-airtable", exportName: "airtable", baseUrl: "https://api.airtable.com", docsUrl: "https://airtable.com/developers/web/api" },
  { slug: "intercom", pkg: "@activepieces/piece-intercom", exportName: "intercom", baseUrl: "https://api.intercom.io", docsUrl: "https://developers.intercom.com/docs" },
  { slug: "mailchimp", pkg: "@activepieces/piece-mailchimp", exportName: "mailchimp", baseUrl: "https://server.api.mailchimp.com/3.0", docsUrl: "https://mailchimp.com/developer/marketing/api/" },
  { slug: "sendgrid", pkg: "@activepieces/piece-sendgrid", exportName: "sendgrid", baseUrl: "https://api.sendgrid.com", docsUrl: "https://docs.sendgrid.com/api-reference", headerName: "Authorization" },
  { slug: "twilio", pkg: "@activepieces/piece-twilio", exportName: "twilio", baseUrl: "https://api.twilio.com", docsUrl: "https://www.twilio.com/docs/usage/api" },
  { slug: "discord", pkg: "@activepieces/piece-discord", exportName: "discord", baseUrl: "https://discord.com/api/v10", docsUrl: "https://discord.com/developers/docs" },
  { slug: "linear", pkg: "@activepieces/piece-linear", exportName: "linear", baseUrl: "https://api.linear.app", docsUrl: "https://developers.linear.app/docs" },
  { slug: "jira", pkg: "@activepieces/piece-jira-cloud", exportName: "jiraCloud", baseUrl: "https://your-domain.atlassian.net", docsUrl: "https://developer.atlassian.com/cloud/jira/platform/rest/v3/" },
  { slug: "shopify", pkg: "@activepieces/piece-shopify", exportName: "shopify", baseUrl: "https://your-store.myshopify.com/admin/api/2024-01", docsUrl: "https://shopify.dev/docs/api" },
  { slug: "zoom", pkg: "@activepieces/piece-zoom", exportName: "zoom", baseUrl: "https://api.zoom.us/v2", docsUrl: "https://developers.zoom.us/docs/api/" },
  { slug: "microsoft-teams", pkg: "@activepieces/piece-microsoft-teams", exportName: "microsoftTeams", baseUrl: "https://graph.microsoft.com/v1.0", docsUrl: "https://learn.microsoft.com/en-us/graph/api/resources/teams-api-overview" },
  { slug: "apollo", pkg: "@activepieces/piece-apollo", exportName: "apollo", baseUrl: "https://api.apollo.io", docsUrl: "https://apolloio.github.io/apollo-api-docs/" },
  { slug: "hunter", pkg: "@activepieces/piece-hunter", exportName: "hunter", baseUrl: "https://api.hunter.io/v2", docsUrl: "https://hunter.io/api-documentation" },
  { slug: "instantly", pkg: "@activepieces/piece-instantly-ai", exportName: "instantlyAi", baseUrl: "https://api.instantly.ai/api/v1", docsUrl: "https://developer.instantly.ai/" },
  { slug: "google-calendar", pkg: "@activepieces/piece-google-calendar", exportName: "googleCalendar", baseUrl: "https://www.googleapis.com/calendar/v3", docsUrl: "https://developers.google.com/calendar/api", oauthProviderKey: "google" },
  { slug: "zendesk", pkg: "@activepieces/piece-zendesk", exportName: "zendesk", baseUrl: "https://{subdomain}.zendesk.com/api/v2", docsUrl: "https://developer.zendesk.com/api-reference/" },
  { slug: "linkedin", pkg: "@activepieces/piece-linkedin", exportName: "linkedin", baseUrl: "https://api.linkedin.com/v2", docsUrl: "https://learn.microsoft.com/en-us/linkedin/marketing/" },
  { slug: "smartlead", pkg: "@activepieces/piece-smartlead", exportName: "smartlead", baseUrl: "https://server.smartlead.ai/api/v1", docsUrl: "https://api.smartlead.ai/reference" },
  { slug: "neverbounce", pkg: "@activepieces/piece-neverbounce", exportName: "neverbounce", baseUrl: "https://api.neverbounce.com/v4", docsUrl: "https://developers.neverbounce.com/reference" },
];

const NATIVE_PROVIDERS: CatalogProvider[] = [
  {
    slug: "openai",
    name: "OpenAI",
    description:
      "Use OpenAI models in GTM workflows for summarization, classification, enrichment, and other AI-driven steps.",
    logoUrl: "https://cdn.activepieces.com/pieces/openai.png",
    category: "AI",
    authType: "api_key",
    baseUrl: "https://api.openai.com",
    headerName: "Authorization",
    docsUrl: "https://platform.openai.com/docs/overview",
    apiSchema: {
      actions: [],
      customApiBaseUrl: "https://api.openai.com",
    },
  },
  {
    slug: "anthropic",
    name: "Anthropic",
    description:
      "Use Anthropic Claude models in GTM workflows for analysis, generation, and structured decision support.",
    logoUrl: "https://upload.wikimedia.org/wikipedia/commons/7/78/Anthropic_logo.svg",
    category: "AI",
    authType: "api_key",
    baseUrl: "https://api.anthropic.com",
    headerName: "x-api-key",
    docsUrl: "https://docs.anthropic.com/en/api/overview",
    defaultHeaders: {
      "anthropic-version": "2023-06-01",
    },
    apiSchema: {
      actions: [],
      customApiBaseUrl: "https://api.anthropic.com",
    },
  },
  {
    slug: "clari",
    name: "Clari",
    description:
      "Connect to Clari for revenue operations data, forecasting insights, and pipeline analytics in your GTM workflows.",
    logoUrl: "https://www.clari.com/Static/img/logo-white.svg",
    category: "CRM",
    authType: "api_key",
    baseUrl: "https://api.clari.com/v4",
    headerName: "apikey",
    docsUrl: "https://developer.clari.com/",
    apiSchema: {
      actions: [],
      customApiBaseUrl: "https://api.clari.com/v4",
    },
  },
  {
    slug: "heyreach",
    name: "HeyReach",
    description:
      "Automate LinkedIn outreach campaigns, manage prospect lists, and track engagement with HeyReach in your GTM workflows.",
    logoUrl: "https://cdn.prod.website-files.com/65492afe86bfa964d89f2005/682dda82b79d5479ee98f3bc_HeyReach_Icon-Primary-Dark.png",
    category: "Marketing",
    authType: "api_key",
    baseUrl: "https://api.heyreach.io/api",
    headerName: "X-API-KEY",
    docsUrl: "https://api.heyreach.io/swagger/index.html",
    apiSchema: {
      actions: [],
      customApiBaseUrl: "https://api.heyreach.io/api",
    },
  },
  {
    slug: "clay",
    name: "Clay",
    description:
      "Enrich leads and companies with Clay's data enrichment and waterfall enrichment engine for your GTM workflows.",
    logoUrl: "https://cdn.prod.website-files.com/61477f2c24a826836f969afe/677c0a6767557563354e34a3_Clay%20icon.png",
    category: "CRM",
    authType: "api_key",
    baseUrl: "https://api.clay.com/v1",
    headerName: "X-Api-Key",
    docsUrl: "https://docs.clay.com/api-reference",
    apiSchema: {
      actions: [],
      customApiBaseUrl: "https://api.clay.com/v1",
    },
  },
  {
    slug: "zoominfo",
    name: "ZoomInfo",
    description:
      "Access B2B contact and company intelligence from ZoomInfo for lead enrichment and prospecting in GTM workflows.",
    logoUrl: "https://www.zoominfo.com/_next/static/media/zoominfo-red-logomark.d5d9ef37.svg",
    category: "CRM",
    authType: "api_key",
    baseUrl: "https://api.zoominfo.com",
    headerName: "Authorization",
    docsUrl: "https://api-docs.zoominfo.com/",
    apiSchema: {
      actions: [],
      customApiBaseUrl: "https://api.zoominfo.com",
    },
  },
  {
    slug: "google-ads",
    name: "Google Ads",
    description:
      "Manage Google Ads campaigns, retrieve performance metrics, and sync conversion data in your GTM workflows.",
    logoUrl: "https://upload.wikimedia.org/wikipedia/commons/c/c7/Google_Ads_logo.svg",
    category: "Marketing",
    authType: "oauth2",
    baseUrl: "https://googleads.googleapis.com",
    docsUrl: "https://developers.google.com/google-ads/api/docs/start",
    oauthProviderKey: "google",
    apiSchema: {
      actions: [],
      customApiBaseUrl: "https://googleads.googleapis.com",
    },
  },
  {
    slug: "snov-io",
    name: "SNOV.io",
    description:
      "Find and verify email addresses, automate outreach drip campaigns, and manage leads with SNOV.io in your GTM workflows.",
    logoUrl: "https://app.snov.io/img/logo.svg",
    category: "Marketing",
    authType: "api_key",
    baseUrl: "https://api.snov.io",
    headerName: "Authorization",
    docsUrl: "https://snov.io/api",
    apiSchema: {
      actions: [],
      customApiBaseUrl: "https://api.snov.io",
    },
  },
  {
    slug: "firmable",
    name: "Firmable",
    description:
      "Access Australian B2B company and contact data from Firmable for local market enrichment in your GTM workflows.",
    logoUrl: "https://firmable.com/wp-content/uploads/2025/12/firmable-iso-seal.png",
    category: "CRM",
    authType: "api_key",
    baseUrl: "https://api.firmable.com",
    headerName: "Authorization",
    docsUrl: "https://docs.firmable.com/api-reference/overview",
    apiSchema: {
      actions: [],
      customApiBaseUrl: "https://api.firmable.com",
    },
  },
];

let _catalog: CatalogProvider[] | null = null;
let _loading: Promise<CatalogProvider[]> | null = null;

export async function getCatalog(): Promise<CatalogProvider[]> {
  if (_catalog) return _catalog;
  if (_loading) return _loading;

  _loading = loadCatalog();
  _catalog = await _loading;
  _loading = null;
  return _catalog;
}

function extractApiSchema(
  piece: ActivepiecesDef,
  baseUrl: string
): CatalogApiSchema | null {
  try {
    const rawActions =
      typeof piece.actions === "function" ? piece.actions() : piece.actions;
    if (!rawActions) return null;

    const actions: CatalogAction[] = [];
    let customApiBaseUrl: string | undefined;

    for (const action of Object.values(rawActions)) {
      if (!action.name) continue;

      const props: Record<string, CatalogActionProp> = {};
      if (action.props) {
        for (const [key, prop] of Object.entries(action.props)) {
          props[key] = {
            type: prop.type || "UNKNOWN",
            required: prop.required ?? false,
            displayName: prop.displayName || key,
            ...(prop.description ? { description: prop.description } : {}),
          };
        }
      }

      actions.push({
        name: action.name,
        displayName: action.displayName || action.name,
        description: action.description || "",
        props,
      });

      if (action.name === "custom_api_call") {
        customApiBaseUrl = baseUrl;
      }
    }

    if (actions.length === 0) return null;

    return { customApiBaseUrl, actions };
  } catch {
    return null;
  }
}

async function loadCatalog(): Promise<CatalogProvider[]> {
  const catalog: CatalogProvider[] = [...NATIVE_PROVIDERS];

  for (const entry of PIECE_REGISTRY) {
    try {
      const mod = await import(entry.pkg);
      const piece: ActivepiecesDef = mod[entry.exportName];
      if (!piece) continue;

      const auth = extractAuth(piece.auth);
      const apiSchema = extractApiSchema(piece, entry.baseUrl);
      catalog.push({
        slug: entry.slug,
        name: piece.displayName || entry.slug,
        description: piece.description || "",
        logoUrl: piece.logoUrl || "",
        category: mapCategory(piece.categories),
        authType: auth.type,
        authUrl: auth.authUrl,
        tokenUrl: auth.tokenUrl,
        scopes: auth.scopes,
        baseUrl: entry.baseUrl,
        headerName: entry.headerName,
        docsUrl: entry.docsUrl,
        oauthProviderKey: entry.oauthProviderKey,
        apiSchema,
      });
    } catch {
      // Skip pieces that fail to load
    }
  }

  return catalog;
}

export async function searchCatalog(query: string): Promise<CatalogProvider[]> {
  const q = query.toLowerCase();
  const all = await getCatalog();
  return all.filter(
    (p) =>
      p.name.toLowerCase().includes(q) ||
      p.slug.includes(q) ||
      p.category.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q),
  );
}

export async function getCatalogProvider(slug: string): Promise<CatalogProvider | undefined> {
  const all = await getCatalog();
  return all.find((p) => p.slug === slug);
}

export async function getCatalogCategories(): Promise<string[]> {
  const all = await getCatalog();
  const cats = new Set(all.map((p) => p.category));
  return ["All", ...Array.from(cats).sort()];
}

// ---------------------------------------------------------------------------
// Dynamic piece loader: resolves any installed @activepieces/piece-* package
// by provider slug, without requiring a PIECE_REGISTRY entry.
// ---------------------------------------------------------------------------

const _pieceSchemaCache = new Map<string, CatalogApiSchema | null>();

function findPieceExport(
  mod: Record<string, unknown>
): ActivepiecesDef | null {
  for (const val of Object.values(mod)) {
    if (
      val &&
      typeof val === "object" &&
      "actions" in val &&
      typeof (val as ActivepiecesDef).actions === "function" &&
      "displayName" in val
    ) {
      return val as ActivepiecesDef;
    }
  }
  return null;
}

/**
 * Attempt to load an Activepieces piece by provider slug and extract its
 * API schema. Works for any installed `@activepieces/piece-{slug}` package
 * regardless of whether it appears in PIECE_REGISTRY.
 *
 * Results are cached so repeated calls for the same slug are free.
 */
export async function getApiSchemaForSlug(
  slug: string,
  baseUrl?: string
): Promise<CatalogApiSchema | null> {
  if (_pieceSchemaCache.has(slug)) {
    return _pieceSchemaCache.get(slug)!;
  }

  // Check the catalog first (pieces already loaded via PIECE_REGISTRY)
  const catalogEntry = await getCatalogProvider(slug);
  if (catalogEntry?.apiSchema) {
    _pieceSchemaCache.set(slug, catalogEntry.apiSchema);
    return catalogEntry.apiSchema;
  }

  // Try dynamic import of @activepieces/piece-{slug}
  const pkgName = `@activepieces/piece-${slug}`;
  try {
    const mod = await import(pkgName);
    const piece = findPieceExport(mod);
    if (!piece) {
      _pieceSchemaCache.set(slug, null);
      return null;
    }

    const schema = extractApiSchema(piece, baseUrl || "");
    _pieceSchemaCache.set(slug, schema);
    return schema;
  } catch {
    // Package not installed — that's fine
    _pieceSchemaCache.set(slug, null);
    return null;
  }
}
