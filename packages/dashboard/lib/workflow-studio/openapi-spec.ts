// OpenAPI spec fetcher, parser, and endpoint filter for workflow agent grounding.
// Fetches published OpenAPI specs (from stored URLs or APIs.guru), parses them,
// resolves $ref references, and returns filtered endpoint summaries.

import {
  resolveOpenApiSpecUrl,
  listAvailableSubApis,
} from "./apis-guru";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OpenApiEndpointSummary {
  method: string;
  path: string;
  operationId?: string;
  summary: string;
  parameters: Array<{
    name: string;
    in: string;
    type: string;
    required: boolean;
    description?: string;
  }>;
  requestBody?: {
    contentType: string;
    properties: Record<
      string,
      { type: string; description?: string; required?: boolean }
    >;
  };
  responseSchema?: {
    properties: Record<string, { type: string; description?: string }>;
  };
}

export interface OpenApiSpecResult {
  title: string;
  version: string;
  baseUrl: string;
  totalEndpoints: number;
  endpoints: OpenApiEndpointSummary[];
  specUrl: string;
  truncated: boolean;
  availableSubApis?: Array<{ key: string; specUrl: string; title?: string }>;
}

// ---------------------------------------------------------------------------
// Spec cache
// ---------------------------------------------------------------------------

const SPEC_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_SPEC_SIZE = 5 * 1024 * 1024; // 5MB

interface CachedSpec {
  data: Record<string, unknown>;
  fetchedAt: number;
}

const _specCache = new Map<string, CachedSpec>();

async function fetchSpec(
  url: string
): Promise<Record<string, unknown> | null> {
  const cached = _specCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < SPEC_CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(20_000),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;

    const contentLength = res.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_SPEC_SIZE) {
      console.warn(`[openapi-spec] Spec too large (${contentLength} bytes): ${url}`);
      return null;
    }

    const text = await res.text();
    if (text.length > MAX_SPEC_SIZE) {
      console.warn(`[openapi-spec] Spec body too large (${text.length} chars): ${url}`);
      return null;
    }

    const data = JSON.parse(text) as Record<string, unknown>;
    _specCache.set(url, { data, fetchedAt: Date.now() });
    return data;
  } catch (err) {
    console.warn(`[openapi-spec] Fetch failed for ${url}:`, (err as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// $ref resolution (1 level deep)
// ---------------------------------------------------------------------------

function resolveRef(
  ref: string,
  root: Record<string, unknown>
): Record<string, unknown> | null {
  if (!ref.startsWith("#/")) return null;

  const parts = ref.slice(2).split("/");
  let current: unknown = root;
  for (const part of parts) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[part];
  }

  return current && typeof current === "object"
    ? (current as Record<string, unknown>)
    : null;
}

function resolveSchemaRef(
  schema: unknown,
  root: Record<string, unknown>,
  depth: number = 0
): Record<string, unknown> | null {
  if (!schema || typeof schema !== "object") return null;

  const s = schema as Record<string, unknown>;

  // Resolve $ref
  if (typeof s.$ref === "string") {
    if (depth > 0) {
      // Beyond first level, just return a hint
      const name = (s.$ref as string).split("/").pop() || "object";
      return { type: `object (see ${name})` } as Record<string, unknown>;
    }
    const resolved = resolveRef(s.$ref, root);
    if (!resolved) return null;
    return resolveSchemaRef(resolved, root, depth + 1);
  }

  // Handle allOf by merging
  if (Array.isArray(s.allOf)) {
    const merged: Record<string, unknown> = { type: "object", properties: {} };
    const requiredSet = new Set<string>();
    for (const sub of s.allOf) {
      const resolved = resolveSchemaRef(sub, root, depth);
      if (resolved?.properties && typeof resolved.properties === "object") {
        Object.assign(
          merged.properties as Record<string, unknown>,
          resolved.properties
        );
      }
      if (Array.isArray(resolved?.required)) {
        for (const r of resolved.required as string[]) requiredSet.add(r);
      }
    }
    if (requiredSet.size > 0) merged.required = Array.from(requiredSet);
    return merged;
  }

  // Handle items for arrays
  if (s.type === "array" && s.items) {
    const itemSchema = resolveSchemaRef(s.items, root, depth);
    return { ...s, items: itemSchema } as Record<string, unknown>;
  }

  // Resolve nested $ref in properties
  if (s.properties && typeof s.properties === "object") {
    const resolvedProps: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(
      s.properties as Record<string, unknown>
    )) {
      if (val && typeof val === "object" && (val as Record<string, unknown>).$ref) {
        resolvedProps[key] = resolveSchemaRef(val, root, depth + 1);
      } else {
        resolvedProps[key] = val;
      }
    }
    return { ...s, properties: resolvedProps };
  }

  return s;
}

// ---------------------------------------------------------------------------
// Schema flattening
// ---------------------------------------------------------------------------

function flattenSchemaProperties(
  schema: Record<string, unknown> | null
): Record<string, { type: string; description?: string; required?: boolean }> {
  if (!schema) return {};

  // If it's an array, describe the items
  if (schema.type === "array" && schema.items) {
    const items = schema.items as Record<string, unknown>;
    if (items.properties) {
      return flattenSchemaProperties(items);
    }
    return { "[]": { type: String(items.type || "object") } };
  }

  const properties = schema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!properties) return {};

  const requiredFields = new Set(
    Array.isArray(schema.required) ? (schema.required as string[]) : []
  );

  const result: Record<
    string,
    { type: string; description?: string; required?: boolean }
  > = {};

  for (const [key, prop] of Object.entries(properties)) {
    if (!prop || typeof prop !== "object") continue;
    result[key] = {
      type: String(prop.type || prop.format || "object"),
      ...(prop.description ? { description: String(prop.description) } : {}),
      ...(requiredFields.has(key) ? { required: true } : {}),
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Endpoint extraction — OpenAPI 3.x and 2.0 (Swagger)
// ---------------------------------------------------------------------------

const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
]);

function extractEndpoints(
  spec: Record<string, unknown>
): OpenApiEndpointSummary[] {
  const isSwagger2 = "swagger" in spec;
  const paths = spec.paths as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!paths) return [];

  const endpoints: OpenApiEndpointSummary[] = [];

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;

    // Path-level parameters
    const pathParams = Array.isArray(pathItem.parameters)
      ? (pathItem.parameters as Array<Record<string, unknown>>)
      : [];

    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue;
      if (!operation || typeof operation !== "object") continue;

      const op = operation as Record<string, unknown>;
      const summary =
        String(op.summary || op.description || "").slice(0, 200) || path;

      // Parameters
      const opParams = Array.isArray(op.parameters)
        ? (op.parameters as Array<Record<string, unknown>>)
        : [];
      const allParams = [...pathParams, ...opParams];

      const parameters: OpenApiEndpointSummary["parameters"] = [];
      for (const param of allParams) {
        if (!param || typeof param !== "object") continue;

        // Resolve param $ref
        let resolved = param;
        if (typeof param.$ref === "string") {
          const r = resolveRef(param.$ref, spec);
          if (r) resolved = r;
          else continue;
        }

        // Skip body params in Swagger 2 (handled separately)
        if (isSwagger2 && resolved.in === "body") continue;

        const schema = resolved.schema as Record<string, unknown> | undefined;
        parameters.push({
          name: String(resolved.name || ""),
          in: String(resolved.in || "query"),
          type: String(
            resolved.type || schema?.type || resolved.format || "string"
          ),
          required: Boolean(resolved.required),
          ...(resolved.description
            ? { description: String(resolved.description).slice(0, 150) }
            : {}),
        });
      }

      // Request body
      let requestBody: OpenApiEndpointSummary["requestBody"] | undefined;
      if (isSwagger2) {
        // Swagger 2: body param
        const bodyParam = allParams.find((p) => p.in === "body");
        if (bodyParam) {
          const schema = resolveSchemaRef(
            bodyParam.schema,
            spec
          );
          const props = flattenSchemaProperties(schema);
          if (Object.keys(props).length > 0) {
            requestBody = {
              contentType: "application/json",
              properties: props,
            };
          }
        }
      } else {
        // OpenAPI 3.x: requestBody
        const rb = op.requestBody as Record<string, unknown> | undefined;
        let resolvedRb = rb;
        if (rb && typeof rb.$ref === "string") {
          resolvedRb =
            (resolveRef(rb.$ref, spec) as Record<string, unknown>) || rb;
        }
        if (resolvedRb) {
          const content = resolvedRb.content as
            | Record<string, Record<string, unknown>>
            | undefined;
          if (content) {
            const jsonContent =
              content["application/json"] ||
              content["application/x-www-form-urlencoded"];
            if (jsonContent?.schema) {
              const schema = resolveSchemaRef(jsonContent.schema, spec);
              const props = flattenSchemaProperties(schema);
              if (Object.keys(props).length > 0) {
                requestBody = {
                  contentType: "application/json",
                  properties: props,
                };
              }
            }
          }
        }
      }

      // Response schema (200 or 201)
      let responseSchema: OpenApiEndpointSummary["responseSchema"] | undefined;
      const responses = op.responses as
        | Record<string, Record<string, unknown>>
        | undefined;
      if (responses) {
        const successResponse =
          responses["200"] || responses["201"] || responses["default"];
        if (successResponse) {
          let resolvedResp = successResponse;
          if (typeof successResponse.$ref === "string") {
            resolvedResp =
              (resolveRef(
                successResponse.$ref,
                spec
              ) as Record<string, unknown>) || successResponse;
          }

          if (isSwagger2) {
            // Swagger 2: schema directly on response
            if (resolvedResp.schema) {
              const schema = resolveSchemaRef(resolvedResp.schema, spec);
              const props = flattenSchemaProperties(schema);
              if (Object.keys(props).length > 0) {
                responseSchema = { properties: props };
              }
            }
          } else {
            // OpenAPI 3.x: content.application/json.schema
            const content = resolvedResp.content as
              | Record<string, Record<string, unknown>>
              | undefined;
            if (content) {
              const jsonContent = content["application/json"];
              if (jsonContent?.schema) {
                const schema = resolveSchemaRef(jsonContent.schema, spec);
                const props = flattenSchemaProperties(schema);
                if (Object.keys(props).length > 0) {
                  responseSchema = { properties: props };
                }
              }
            }
          }
        }
      }

      endpoints.push({
        method: method.toUpperCase(),
        path,
        ...(op.operationId ? { operationId: String(op.operationId) } : {}),
        summary,
        parameters,
        ...(requestBody ? { requestBody } : {}),
        ...(responseSchema ? { responseSchema } : {}),
      });
    }
  }

  return endpoints;
}

// ---------------------------------------------------------------------------
// Endpoint filtering by keyword relevance
// ---------------------------------------------------------------------------

function scoreEndpoint(
  endpoint: OpenApiEndpointSummary,
  query: string
): number {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;

  const searchable = [
    endpoint.path,
    endpoint.summary,
    endpoint.operationId || "",
    ...endpoint.parameters.map((p) => p.name),
  ]
    .join(" ")
    .toLowerCase();

  let score = 0;
  for (const term of terms) {
    if (searchable.includes(term)) {
      score += 1;
      // Bonus for path match (most specific)
      if (endpoint.path.toLowerCase().includes(term)) score += 2;
      // Bonus for operationId match
      if (endpoint.operationId?.toLowerCase().includes(term)) score += 1;
    }
  }

  return score;
}

function filterEndpoints(
  endpoints: OpenApiEndpointSummary[],
  query: string | undefined,
  maxEndpoints: number
): { endpoints: OpenApiEndpointSummary[]; truncated: boolean } {
  if (!query) {
    // No query — return first N sorted by path
    const sorted = [...endpoints].sort((a, b) => a.path.localeCompare(b.path));
    return {
      endpoints: sorted.slice(0, maxEndpoints),
      truncated: sorted.length > maxEndpoints,
    };
  }

  // Score and rank
  const scored = endpoints
    .map((ep) => ({ ep, score: scoreEndpoint(ep, query) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  return {
    endpoints: scored.slice(0, maxEndpoints).map(({ ep }) => ep),
    truncated: scored.length > maxEndpoints,
  };
}

// ---------------------------------------------------------------------------
// Extract base URL from spec
// ---------------------------------------------------------------------------

function extractBaseUrl(spec: Record<string, unknown>): string {
  // OpenAPI 3.x: servers[0].url
  if (Array.isArray(spec.servers) && spec.servers.length > 0) {
    const server = spec.servers[0] as Record<string, unknown>;
    return String(server.url || "");
  }

  // Swagger 2: host + basePath
  if (spec.host) {
    const scheme = Array.isArray(spec.schemes)
      ? (spec.schemes[0] as string)
      : "https";
    const basePath = String(spec.basePath || "");
    return `${scheme}://${spec.host}${basePath}`;
  }

  return "";
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function fetchAndFilterOpenApiSpec(options: {
  specUrl?: string;
  providerSlug?: string;
  query?: string;
  maxEndpoints?: number;
}): Promise<OpenApiSpecResult | { error: string }> {
  const { providerSlug, query, maxEndpoints = 15 } = options;
  let { specUrl } = options;

  // Resolve spec URL if not provided
  if (!specUrl && providerSlug) {
    specUrl = (await resolveOpenApiSpecUrl(providerSlug)) ?? undefined;
  }

  if (!specUrl) {
    return {
      error: `No OpenAPI spec available for ${providerSlug || "this provider"}. Use researchWeb to find API documentation instead.`,
    };
  }

  // Fetch and parse the spec
  const spec = await fetchSpec(specUrl);
  if (!spec) {
    // If stored URL fails, try fresh lookup for the slug
    if (providerSlug) {
      const freshUrl = await resolveOpenApiSpecUrl(providerSlug);
      if (freshUrl && freshUrl !== specUrl) {
        const freshSpec = await fetchSpec(freshUrl);
        if (freshSpec) {
          return buildResult(freshSpec, freshUrl, query, maxEndpoints, providerSlug);
        }
      }
    }
    return {
      error: `Failed to fetch OpenAPI spec from ${specUrl}. The URL may be unavailable. Use researchWeb as a fallback.`,
    };
  }

  return buildResult(spec, specUrl, query, maxEndpoints, providerSlug);
}

async function buildResult(
  spec: Record<string, unknown>,
  specUrl: string,
  query: string | undefined,
  maxEndpoints: number,
  providerSlug: string | undefined
): Promise<OpenApiSpecResult> {
  const info = (spec.info as Record<string, unknown>) || {};
  const allEndpoints = extractEndpoints(spec);
  const filtered = filterEndpoints(allEndpoints, query, maxEndpoints);

  // Include sub-API list for multi-spec providers
  let availableSubApis:
    | Array<{ key: string; specUrl: string; title?: string }>
    | undefined;
  if (providerSlug) {
    const subApis = await listAvailableSubApis(providerSlug);
    if (subApis.length > 1) {
      availableSubApis = subApis;
    }
  }

  return {
    title: String(info.title || "Unknown API"),
    version: String(info.version || ""),
    baseUrl: extractBaseUrl(spec),
    totalEndpoints: allEndpoints.length,
    endpoints: filtered.endpoints,
    specUrl,
    truncated: filtered.truncated,
    ...(availableSubApis ? { availableSubApis } : {}),
  };
}
