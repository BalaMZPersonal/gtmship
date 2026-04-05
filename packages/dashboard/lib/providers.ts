import type { CatalogProvider } from "@/lib/catalog";

export interface SavedProvider {
  id: string;
  name: string;
  slug: string;
  authType: "oauth2" | "api_key" | "basic";
  baseUrl: string;
  authorizeUrl?: string | null;
  tokenUrl?: string | null;
  scopes?: string[];
  testEndpoint?: string | null;
  headerName?: string | null;
  docsUrl?: string | null;
  notes?: string | null;
  category?: string | null;
  description?: string | null;
  logoUrl?: string | null;
  source?: string | null;
  oauthProviderKey?: string | null;
  defaultHeaders?: Record<string, string> | null;
  apiSchema?: Record<string, unknown> | null;
  hasCredentials?: boolean;
}

export interface ConnectableProvider extends CatalogProvider {
  id?: string;
  existingProvider?: boolean;
  hasCredentials?: boolean;
  source?: string | null;
  notes?: string | null;
  testEndpoint?: string | null;
}

export function normalizeCatalogProvider(
  provider: CatalogProvider
): ConnectableProvider {
  return {
    ...provider,
    existingProvider: false,
  };
}

export function normalizeSavedProvider(
  provider: SavedProvider
): ConnectableProvider {
  return {
    id: provider.id,
    slug: provider.slug,
    name: provider.name,
    description: provider.description || "",
    logoUrl: provider.logoUrl || "",
    category: provider.category || "Other",
    authType: provider.authType,
    authUrl: provider.authorizeUrl || undefined,
    tokenUrl: provider.tokenUrl || undefined,
    scopes: provider.scopes || [],
    baseUrl: provider.baseUrl || "",
    headerName: provider.headerName || undefined,
    docsUrl: provider.docsUrl || undefined,
    oauthProviderKey: provider.oauthProviderKey || undefined,
    defaultHeaders: provider.defaultHeaders || undefined,
    apiSchema: provider.apiSchema || undefined,
    source: provider.source || "manual",
    hasCredentials: provider.hasCredentials,
    notes: provider.notes || null,
    testEndpoint: provider.testEndpoint || null,
    existingProvider: true,
  };
}
