export type ResearchMode = "search" | "scrape" | "research";

export type ResearchFocus = "documentation" | "general";

export interface ResearchSearchResult {
  title: string;
  url: string;
  snippet: string;
  domain: string;
  score: number;
}

export interface ResearchPageLink {
  title: string;
  url: string;
}

export interface ResearchPageResult {
  finalUrl: string;
  title: string;
  status: number;
  contentType: string;
  excerpt: string;
  text: string;
  headings: string[];
  links: ResearchPageLink[];
  unsupportedContent?: boolean;
}

export interface ResearchResult {
  provider: string;
  mode: ResearchMode;
  query?: string;
  results?: ResearchSearchResult[];
  page?: ResearchPageResult;
  warnings?: string[];
  error?: string;
  noUsefulResults?: boolean;
}

export interface ResearchRequest {
  mode: ResearchMode;
  query?: string;
  url?: string;
  focus?: ResearchFocus;
  maxResults?: number;
  selectedResult?: number;
  allowedDomains?: string[];
}

export interface SearchProviderInput {
  query: string;
  focus: ResearchFocus;
  maxResults: number;
  allowedDomains?: string[];
}

export interface SearchProviderResult {
  provider: string;
  query: string;
  results: ResearchSearchResult[];
  warnings?: string[];
}

export interface SearchProvider {
  id: string;
  search(input: SearchProviderInput): Promise<SearchProviderResult>;
}
