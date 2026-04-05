"use client";

import { useState, useEffect } from "react";
import {
  X,
  Save,
  Loader2,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  Play,
  Copy,
  Check,
  Link2,
  Trash2,
} from "lucide-react";
import { api } from "@/lib/api";
import type { ConnectableProvider, SavedProvider } from "@/lib/providers";
import { normalizeSavedProvider } from "@/lib/providers";
import { resolveSharedOAuthProviderKey } from "@/lib/shared-oauth";

interface ApiEndpoint {
  method: string;
  path: string;
  description?: string;
  parameters?: {
    name: string;
    type?: string;
    required?: boolean;
    in?: string;
    description?: string;
  }[];
  response?: Record<string, unknown>;
}

interface ApiSchema {
  endpoints?: ApiEndpoint[];
  auth?: { type: string; header?: string; format?: string };
  test?: { curl: string; expected_status?: number };
}

interface ProviderDetail extends SavedProvider {
  tokenRefresh?: boolean;
  apiSchema?: ApiSchema;
  connections: { id: string; label: string; status: string; createdAt: string }[];
}

interface ProviderDrawerProps {
  slug: string;
  onClose: () => void;
  onUpdated: () => void;
  onConnect?: (provider: ConnectableProvider) => void;
  onDelete?: (provider: ConnectableProvider) => void;
}

function parseScopes(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\n,\s]+/)
        .map((scope) => scope.trim())
        .filter(Boolean)
    )
  );
}

export function ProviderDrawer({
  slug,
  onClose,
  onUpdated,
  onConnect,
  onDelete,
}: ProviderDrawerProps) {
  const [provider, setProvider] = useState<ProviderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<"config" | "api" | "test">("config");
  const [copied, setCopied] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saveSuccess, setSaveSuccess] = useState("");

  const [name, setName] = useState("");
  const [authType, setAuthType] = useState<"oauth2" | "api_key" | "basic">("api_key");
  const [baseUrl, setBaseUrl] = useState("");
  const [authorizeUrl, setAuthorizeUrl] = useState("");
  const [tokenUrl, setTokenUrl] = useState("");
  const [scopesText, setScopesText] = useState("");
  const [oauthProviderKey, setOauthProviderKey] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [headerName, setHeaderName] = useState("");
  const [testEndpoint, setTestEndpoint] = useState("");
  const [docsUrl, setDocsUrl] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [tokenRefresh, setTokenRefresh] = useState(true);

  const authServiceUrl = process.env.NEXT_PUBLIC_AUTH_URL || "http://localhost:4000";
  const effectiveOAuthProviderKey = resolveSharedOAuthProviderKey({
    slug: provider?.slug,
    oauthProviderKey,
  });
  const redirectUrl =
    authType === "oauth2"
      ? `${authServiceUrl}/auth/${effectiveOAuthProviderKey || slug}/callback`
      : null;
  const usesSharedOAuth = authType === "oauth2" && !!effectiveOAuthProviderKey;

  useEffect(() => {
    let active = true;

    (async () => {
      try {
        const data = (await api.getProvider(slug)) as ProviderDetail;
        if (!active) return;

        setProvider(data);
        setName(data.name || "");
        setAuthType((data.authType as "oauth2" | "api_key" | "basic") || "api_key");
        setBaseUrl(data.baseUrl || "");
        setAuthorizeUrl(data.authorizeUrl || "");
        setTokenUrl(data.tokenUrl || "");
        setScopesText((data.scopes || []).join("\n"));
        setOauthProviderKey(data.oauthProviderKey || "");
        setClientId("");
        setClientSecret("");
        setHeaderName(data.headerName || "");
        setTestEndpoint(data.testEndpoint || "");
        setDocsUrl(data.docsUrl || "");
        setCategory(data.category || "");
        setDescription(data.description || "");
        setNotes(data.notes || "");
        setTokenRefresh(data.tokenRefresh ?? true);
      } catch {
        if (!active) return;
        setProvider(null);
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [slug]);

  const handleSave = async () => {
    setSaveError("");
    setSaveSuccess("");

    if (!name.trim() || !baseUrl.trim()) {
      setSaveError("Name and base URL are required.");
      return;
    }

    if (authType === "oauth2" && (!authorizeUrl.trim() || !tokenUrl.trim())) {
      setSaveError("OAuth providers need both an authorize URL and a token URL.");
      return;
    }

    if (authType === "api_key" && !headerName.trim()) {
      setSaveError("API key providers need the header name GTMShip should send.");
      return;
    }

    if ((clientId || clientSecret) && (!clientId || !clientSecret)) {
      setSaveError("Enter both Client ID and Client Secret to replace saved credentials.");
      return;
    }

    setSaving(true);
    try {
      await api.updateProvider(slug, {
        name: name.trim(),
        auth_type: authType,
        base_url: baseUrl.trim(),
        authorize_url:
          authType === "oauth2" ? authorizeUrl.trim() : undefined,
        token_url: authType === "oauth2" ? tokenUrl.trim() : undefined,
        scopes: authType === "oauth2" ? parseScopes(scopesText) : [],
        token_refresh: authType === "oauth2" ? tokenRefresh : undefined,
        oauth_provider_key:
          authType === "oauth2" ? oauthProviderKey.trim() || null : null,
        client_id: clientId || undefined,
        client_secret: clientSecret || undefined,
        header_name: authType === "api_key" ? headerName.trim() : undefined,
        test_endpoint: testEndpoint.trim() || undefined,
        docs_url: docsUrl.trim() || undefined,
        category: category.trim() || undefined,
        description: description.trim() || undefined,
        notes: notes.trim() || undefined,
      });

      const refreshed = (await api.getProvider(slug)) as ProviderDetail;
      setProvider(refreshed);
      setClientId("");
      setClientSecret("");
      setSaveSuccess("Provider saved.");
      onUpdated();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Failed to save provider.");
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const schema = provider?.apiSchema as ApiSchema | undefined;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <div
        className="h-full w-full max-w-3xl overflow-y-auto border-l border-zinc-800 bg-zinc-950 animate-in slide-in-from-right"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
          <div className="flex items-center justify-between px-6 py-4">
            <div className="flex items-center gap-3">
              {provider?.logoUrl ? (
                <img
                  src={provider.logoUrl}
                  alt={provider.name}
                  className="h-10 w-10 rounded-xl border border-zinc-800 bg-zinc-900 p-1"
                />
              ) : (
                <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900 text-xs font-medium uppercase text-zinc-400">
                  {slug.slice(0, 2)}
                </div>
              )}
              <div>
                <h3 className="text-sm font-medium text-white">
                  {provider?.name || slug}
                </h3>
                <p className="text-xs text-zinc-500">
                  {provider?.authType} · {provider?.source || "manual"} · {slug}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {provider && provider.source !== "catalog" && onDelete ? (
                <button
                  onClick={() => onDelete(normalizeSavedProvider(provider))}
                  disabled={loading}
                  className="inline-flex items-center gap-1.5 rounded-md border border-red-500/20 px-3 py-1.5 text-xs text-red-300 transition-colors hover:bg-red-500/10 disabled:opacity-50"
                >
                  <Trash2 size={12} />
                  Delete
                </button>
              ) : null}
              {provider && onConnect ? (
                <button
                  onClick={() => onConnect(normalizeSavedProvider(provider))}
                  disabled={loading}
                  className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 transition-colors hover:border-zinc-600 hover:text-white disabled:opacity-50"
                >
                  <Link2 size={12} />
                  {provider.connections.length > 0 ? "Reconnect" : "Connect"}
                </button>
              ) : null}
              <button
                onClick={handleSave}
                disabled={saving || loading}
                className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                Save
              </button>
              <button
                onClick={onClose}
                className="rounded-md border border-zinc-700 p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          <div className="flex items-center gap-1 border-t border-zinc-800 px-6">
            {(["config", "api", "test"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`-mb-px border-b-2 px-3 py-2.5 text-xs capitalize transition-colors ${
                  activeTab === tab
                    ? "border-blue-600 text-white"
                    : "border-transparent text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {tab === "api" ? "API Schema" : tab === "test" ? "Test" : "Config"}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 size={20} className="animate-spin text-zinc-500" />
          </div>
        ) : !provider ? (
          <div className="px-6 py-12 text-center text-sm text-zinc-500">
            Provider not found.
          </div>
        ) : (
          <div className="px-6 py-5">
            {saveError ? (
              <div className="mb-4 rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                {saveError}
              </div>
            ) : null}
            {saveSuccess ? (
              <div className="mb-4 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
                {saveSuccess}
              </div>
            ) : null}

            {activeTab === "config" ? (
              <ConfigTab
                slug={slug}
                authType={authType}
                setAuthType={setAuthType}
                name={name}
                setName={setName}
                baseUrl={baseUrl}
                setBaseUrl={setBaseUrl}
                authorizeUrl={authorizeUrl}
                setAuthorizeUrl={setAuthorizeUrl}
                tokenUrl={tokenUrl}
                setTokenUrl={setTokenUrl}
                scopesText={scopesText}
                setScopesText={setScopesText}
                oauthProviderKey={oauthProviderKey}
                setOauthProviderKey={setOauthProviderKey}
                clientId={clientId}
                setClientId={setClientId}
                clientSecret={clientSecret}
                setClientSecret={setClientSecret}
                headerName={headerName}
                setHeaderName={setHeaderName}
                testEndpoint={testEndpoint}
                setTestEndpoint={setTestEndpoint}
                docsUrl={docsUrl}
                setDocsUrl={setDocsUrl}
                category={category}
                setCategory={setCategory}
                description={description}
                setDescription={setDescription}
                notes={notes}
                setNotes={setNotes}
                tokenRefresh={tokenRefresh}
                setTokenRefresh={setTokenRefresh}
                redirectUrl={redirectUrl}
                usesSharedOAuth={usesSharedOAuth}
                hasCredentials={!!provider.hasCredentials}
                onCopy={handleCopy}
                copied={copied}
              />
            ) : null}

            {activeTab === "api" ? (
              <ApiSchemaTab schema={schema} onCopy={handleCopy} copied={copied} />
            ) : null}

            {activeTab === "test" ? (
              <TestTab
                schema={schema}
                provider={provider}
                onCopy={handleCopy}
                copied={copied}
              />
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function ConfigTab({
  slug,
  authType,
  setAuthType,
  name,
  setName,
  baseUrl,
  setBaseUrl,
  authorizeUrl,
  setAuthorizeUrl,
  tokenUrl,
  setTokenUrl,
  scopesText,
  setScopesText,
  oauthProviderKey,
  setOauthProviderKey,
  clientId,
  setClientId,
  clientSecret,
  setClientSecret,
  headerName,
  setHeaderName,
  testEndpoint,
  setTestEndpoint,
  docsUrl,
  setDocsUrl,
  category,
  setCategory,
  description,
  setDescription,
  notes,
  setNotes,
  tokenRefresh,
  setTokenRefresh,
  redirectUrl,
  usesSharedOAuth,
  hasCredentials,
  onCopy,
  copied,
}: {
  slug: string;
  authType: "oauth2" | "api_key" | "basic";
  setAuthType: (value: "oauth2" | "api_key" | "basic") => void;
  name: string;
  setName: (value: string) => void;
  baseUrl: string;
  setBaseUrl: (value: string) => void;
  authorizeUrl: string;
  setAuthorizeUrl: (value: string) => void;
  tokenUrl: string;
  setTokenUrl: (value: string) => void;
  scopesText: string;
  setScopesText: (value: string) => void;
  oauthProviderKey: string;
  setOauthProviderKey: (value: string) => void;
  clientId: string;
  setClientId: (value: string) => void;
  clientSecret: string;
  setClientSecret: (value: string) => void;
  headerName: string;
  setHeaderName: (value: string) => void;
  testEndpoint: string;
  setTestEndpoint: (value: string) => void;
  docsUrl: string;
  setDocsUrl: (value: string) => void;
  category: string;
  setCategory: (value: string) => void;
  description: string;
  setDescription: (value: string) => void;
  notes: string;
  setNotes: (value: string) => void;
  tokenRefresh: boolean;
  setTokenRefresh: (value: boolean) => void;
  redirectUrl: string | null;
  usesSharedOAuth: boolean;
  hasCredentials: boolean;
  onCopy: (value: string) => void;
  copied: boolean;
}) {
  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.18em] text-zinc-500">
          <span className="rounded-full border border-zinc-800 bg-zinc-950 px-2.5 py-1">
            {slug}
          </span>
          <span className="rounded-full border border-zinc-800 bg-zinc-950 px-2.5 py-1">
            {authType}
          </span>
          {hasCredentials ? (
            <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-emerald-300">
              Credentials saved
            </span>
          ) : null}
        </div>
        <p className="mt-3 text-sm leading-6 text-zinc-500">
          Update the provider definition that powers your connection flow. Saved
          OAuth credentials can be replaced here or left alone for reconnects.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" value={name} onChange={setName} />
        <SelectField label="Auth Type" value={authType} onChange={setAuthType} />
      </div>

      <Field label="Base URL" value={baseUrl} onChange={setBaseUrl} mono />

      {authType === "oauth2" ? (
        <div className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
          <div>
            <p className="text-sm font-medium text-white">OAuth settings</p>
            <p className="mt-1 text-sm leading-6 text-zinc-500">
              Configure the authorize and token endpoints GTMShip should use for
              this provider. If this provider shares an OAuth family, set the
              shared key here and the connect flow will reuse the shared app.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Authorize URL"
              value={authorizeUrl}
              onChange={setAuthorizeUrl}
              mono
              placeholder="https://provider.com/oauth/authorize"
            />
            <Field
              label="Token URL"
              value={tokenUrl}
              onChange={setTokenUrl}
              mono
              placeholder="https://provider.com/oauth/token"
            />
          </div>

          <Field
            label="Shared OAuth Key"
            value={oauthProviderKey}
            onChange={setOauthProviderKey}
            mono
            placeholder="google"
          />

          <div>
            <label className="mb-1 block text-xs text-zinc-400">Scopes</label>
            <textarea
              value={scopesText}
              onChange={(e) => setScopesText(e.target.value)}
              rows={4}
              placeholder="scope.one&#10;scope.two"
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-600 font-mono resize-y"
            />
            <p className="mt-1 text-[11px] leading-5 text-zinc-500">
              Separate scopes with spaces, commas, or new lines.
            </p>
          </div>

          <label className="flex items-start gap-3 rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-3 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={tokenRefresh}
              onChange={(e) => setTokenRefresh(e.target.checked)}
              className="mt-1"
            />
            <span>
              <span className="block font-medium text-zinc-100">
                Refresh access tokens automatically
              </span>
              <span className="mt-1 block text-xs leading-5 text-zinc-500">
                Keep this enabled for providers that issue refresh tokens during
                OAuth so GTMShip can rotate them later.
              </span>
            </span>
          </label>

          {redirectUrl ? (
            <div className="rounded-xl border border-amber-900/50 bg-amber-950/30 px-3 py-3">
              <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.18em] text-amber-300/90">
                Redirect URL
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 select-all break-all rounded-lg bg-black/30 px-3 py-2 font-mono text-[11px] leading-5 text-amber-100/85">
                  {redirectUrl}
                </code>
                <button
                  type="button"
                  onClick={() => onCopy(redirectUrl)}
                  className="rounded-lg border border-amber-400/20 p-2 text-amber-300/80 transition-colors hover:border-amber-300/40 hover:text-amber-200"
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
              <p className="mt-2 text-[11px] leading-5 text-amber-100/70">
                {usesSharedOAuth
                  ? "This provider will use a shared OAuth app and callback family."
                  : "Add this redirect URL to the OAuth app before connecting."}
              </p>
            </div>
          ) : null}

          {!usesSharedOAuth ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Client ID"
                value={clientId}
                onChange={setClientId}
                mono
                placeholder={
                  hasCredentials
                    ? "Leave blank to keep saved value"
                    : "Provider OAuth client ID"
                }
              />
              <Field
                label="Client Secret"
                value={clientSecret}
                onChange={setClientSecret}
                mono
                placeholder={
                  hasCredentials
                    ? "Leave blank to keep saved value"
                    : "Provider OAuth client secret"
                }
                type="password"
              />
            </div>
          ) : (
            <div className="rounded-xl border border-emerald-900/40 bg-emerald-950/20 px-3 py-3 text-sm leading-6 text-emerald-200/90">
              Credentials for shared OAuth families are managed once in the
              connect flow and then reused across the related services.
            </div>
          )}
        </div>
      ) : null}

      {authType === "api_key" ? (
        <Field
          label="Header Name"
          value={headerName}
          onChange={setHeaderName}
          mono
          placeholder="Authorization"
        />
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Test Endpoint"
          value={testEndpoint}
          onChange={setTestEndpoint}
          mono
          placeholder="/health"
        />
        <Field label="Docs URL" value={docsUrl} onChange={setDocsUrl} mono />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Category"
          value={category}
          onChange={setCategory}
          placeholder="Analytics"
        />
        <Field
          label="Description"
          value={description}
          onChange={setDescription}
        />
      </div>

      <div>
        <label className="mb-1 block text-xs text-zinc-400">Notes</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={4}
          className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-600 font-mono resize-y"
        />
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  mono,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  mono?: boolean;
  placeholder?: string;
  type?: "text" | "password";
}) {
  return (
    <div>
      <label className="mb-1 block text-xs text-zinc-400">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-600 ${
          mono ? "font-mono" : ""
        }`}
      />
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: "oauth2" | "api_key" | "basic";
  onChange: (value: "oauth2" | "api_key" | "basic") => void;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs text-zinc-400">{label}</label>
      <select
        value={value}
        onChange={(e) =>
          onChange(e.target.value as "oauth2" | "api_key" | "basic")
        }
        className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-600"
      >
        <option value="oauth2">OAuth 2.0</option>
        <option value="api_key">API key</option>
        <option value="basic">Basic auth</option>
      </select>
    </div>
  );
}

function ApiSchemaTab({
  schema,
  onCopy,
  copied,
}: {
  schema?: ApiSchema;
  onCopy: (s: string) => void;
  copied: boolean;
}) {
  if (!schema?.endpoints?.length) {
    return (
      <div className="rounded-lg border border-zinc-800 p-8 text-center">
        <p className="text-sm text-zinc-500">No API schema available.</p>
        <p className="mt-1 text-xs text-zinc-600">
          Use the Connections Agent to set up this integration. It will
          capture the API structure from docs for you.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {schema.auth ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
          <p className="mb-1 text-xs text-zinc-400">Authentication</p>
          <p className="font-mono text-sm text-white">
            {schema.auth.format ||
              `${schema.auth.type} via ${schema.auth.header || "Authorization"}`}
          </p>
        </div>
      ) : null}

      <div>
        <p className="mb-2 text-xs text-zinc-400">
          Endpoints ({schema.endpoints.length})
        </p>
        <div className="space-y-2">
          {schema.endpoints.map((endpoint, index) => (
            <EndpointCard
              key={index}
              endpoint={endpoint}
              onCopy={onCopy}
              copied={copied}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function EndpointCard({
  endpoint,
  onCopy,
  copied,
}: {
  endpoint: ApiEndpoint;
  onCopy: (s: string) => void;
  copied: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const methodColors: Record<string, string> = {
    GET: "bg-green-900/30 text-green-400",
    POST: "bg-blue-900/30 text-blue-400",
    PUT: "bg-yellow-900/30 text-yellow-400",
    PATCH: "bg-orange-900/30 text-orange-400",
    DELETE: "bg-red-900/30 text-red-400",
  };
  const color = methodColors[endpoint.method] || "bg-zinc-800 text-zinc-400";

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-zinc-900/50"
      >
        {expanded ? (
          <ChevronDown size={12} className="shrink-0 text-zinc-500" />
        ) : (
          <ChevronRight size={12} className="shrink-0 text-zinc-500" />
        )}
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-mono font-bold ${color}`}>
          {endpoint.method}
        </span>
        <span className="truncate font-mono text-sm text-white">
          {endpoint.path}
        </span>
        {endpoint.description ? (
          <span className="ml-auto truncate text-xs text-zinc-500">
            {endpoint.description}
          </span>
        ) : null}
      </button>

      {expanded ? (
        <div className="space-y-3 border-t border-zinc-800 px-3 py-3">
          {endpoint.parameters && endpoint.parameters.length > 0 ? (
            <div>
              <p className="mb-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
                Parameters
              </p>
              <div className="overflow-hidden rounded border border-zinc-800">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-zinc-900/50 text-zinc-500">
                      <th className="px-2 py-1 text-left font-medium">Name</th>
                      <th className="px-2 py-1 text-left font-medium">Type</th>
                      <th className="px-2 py-1 text-left font-medium">In</th>
                      <th className="px-2 py-1 text-left font-medium">Required</th>
                      <th className="px-2 py-1 text-left font-medium">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {endpoint.parameters.map((parameter, index) => (
                      <tr key={index} className="border-t border-zinc-800/50">
                        <td className="px-2 py-1 font-mono text-white">
                          {parameter.name}
                        </td>
                        <td className="px-2 py-1 text-zinc-400">
                          {parameter.type || "-"}
                        </td>
                        <td className="px-2 py-1 text-zinc-400">
                          {parameter.in || "-"}
                        </td>
                        <td className="px-2 py-1">
                          {parameter.required ? (
                            <span className="text-amber-400">yes</span>
                          ) : (
                            <span className="text-zinc-600">no</span>
                          )}
                        </td>
                        <td className="px-2 py-1 text-zinc-500">
                          {parameter.description || "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {endpoint.response ? (
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <p className="text-[10px] uppercase tracking-wider text-zinc-500">
                  Response
                </p>
                <button
                  onClick={() => onCopy(JSON.stringify(endpoint.response, null, 2))}
                  className="text-zinc-600 transition-colors hover:text-zinc-400"
                  title="Copy response schema"
                >
                  {copied ? <Check size={10} /> : <Copy size={10} />}
                </button>
              </div>
              <pre className="max-h-48 overflow-x-auto overflow-y-auto whitespace-pre-wrap rounded border border-zinc-800 bg-zinc-900/50 px-3 py-2 font-mono text-xs text-zinc-400">
                {JSON.stringify(endpoint.response, null, 2)}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TestTab({
  schema,
  provider,
  onCopy,
  copied,
}: {
  schema?: ApiSchema;
  provider: ProviderDetail;
  onCopy: (s: string) => void;
  copied: boolean;
}) {
  const [testResult, setTestResult] = useState<{
    success: boolean;
    status?: number;
  } | null>(null);
  const [testing, setTesting] = useState(false);

  const handleTestConnection = async () => {
    if (!provider.connections[0]) return;
    setTesting(true);
    try {
      const result = await api.testConnection(provider.connections[0].id);
      setTestResult(result);
    } catch {
      setTestResult({ success: false });
    }
    setTesting(false);
  };

  return (
    <div className="space-y-4">
      {provider.connections.length > 0 ? (
        <div className="rounded-lg border border-zinc-800 p-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs text-zinc-400">Quick Connection Test</p>
            {testResult ? (
              <span
                className={`text-xs ${
                  testResult.success ? "text-green-400" : "text-red-400"
                }`}
              >
                {testResult.success ? `Pass (${testResult.status})` : "Failed"}
              </span>
            ) : null}
          </div>
          <p className="mb-3 text-xs text-zinc-500">
            Tests the first active connection by calling{" "}
            <code className="text-zinc-400">
              {provider.testEndpoint || "test endpoint"}
            </code>
          </p>
          <button
            onClick={handleTestConnection}
            disabled={testing}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-700 disabled:opacity-50"
          >
            {testing ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
            Run Test
          </button>
        </div>
      ) : null}

      {schema?.test?.curl ? (
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-xs text-zinc-400">Test Command</p>
            <button
              onClick={() => onCopy(schema.test!.curl)}
              className="text-zinc-600 transition-colors hover:text-zinc-400"
            >
              {copied ? <Check size={10} /> : <Copy size={10} />}
            </button>
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2.5 font-mono text-xs text-green-300/80">
            {schema.test.curl}
          </pre>
          {schema.test.expected_status ? (
            <p className="mt-1 text-[10px] text-zinc-600">
              Expected: HTTP {schema.test.expected_status}
            </p>
          ) : null}
        </div>
      ) : null}

      {provider.docsUrl ? (
        <a
          href={provider.docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs text-blue-400 hover:underline"
        >
          <ExternalLink size={12} />
          View API Documentation
        </a>
      ) : null}

      {!schema?.test && !provider.connections.length ? (
        <div className="rounded-lg border border-zinc-800 p-8 text-center">
          <p className="text-sm text-zinc-500">No test configuration available.</p>
          <p className="mt-1 text-xs text-zinc-600">
            Connect a credential and the Connections Agent will generate test
            instructions.
          </p>
        </div>
      ) : null}
    </div>
  );
}
