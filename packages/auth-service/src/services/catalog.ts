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
  const catalog: CatalogProvider[] = [];

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
