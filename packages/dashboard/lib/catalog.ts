// Catalog types — data fetched from auth-service /catalog endpoint

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
}

export interface CatalogResponse {
  items: CatalogProvider[];
  categories: string[];
}
