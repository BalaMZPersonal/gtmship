"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { CatalogProvider, CatalogResponse } from "@/lib/catalog";
import type { ConnectableProvider, SavedProvider } from "@/lib/providers";
import {
  normalizeCatalogProvider,
  normalizeSavedProvider,
} from "@/lib/providers";
import { CatalogGrid } from "@/components/catalog-grid";
import { ConnectModal } from "@/components/connect-modal";
import { ProviderDrawer } from "@/components/provider-drawer";
import {
  AlertTriangle,
  CheckCircle,
  ExternalLink,
  LayoutGrid,
  Link2,
  List,
  Loader2,
  RefreshCw,
  RotateCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  XCircle,
} from "lucide-react";

interface Connection {
  id: string;
  label: string | null;
  status: string;
  provider: {
    name: string;
    slug: string;
    authType: string;
    oauthProviderKey?: string | null;
    logoUrl?: string | null;
    description?: string | null;
    category?: string | null;
    source?: string | null;
    docsUrl?: string | null;
    hasCredentials?: boolean;
  };
  hasToken: boolean;
  hasRefreshToken: boolean;
  tokenExpiresAt: string | null;
  createdAt: string;
  updatedAt?: string;
  accountEmail?: string | null;
}

interface ConnectRequest {
  provider: ConnectableProvider;
  targetConnectionId?: string;
  targetConnectionLabel?: string | null;
}

function getTokenStatus(conn: Connection): "ok" | "expiring" | "expired" | "no-token" {
  if (!conn.hasToken) return "no-token";
  if (!conn.tokenExpiresAt) return "ok";

  const expiresAt = new Date(conn.tokenExpiresAt);
  const now = new Date();

  if (expiresAt <= now) return "expired";
  if (expiresAt.getTime() - now.getTime() < 10 * 60 * 1000) return "expiring";

  return "ok";
}

function connectionNeedsReconnect(connection: Connection) {
  const tokenStatus = getTokenStatus(connection);

  return (
    connection.provider.authType === "oauth2" &&
    (tokenStatus === "expired" ||
      tokenStatus === "expiring" ||
      tokenStatus === "no-token") &&
    !connection.hasRefreshToken
  );
}

function connectionCanRefresh(connection: Connection) {
  const tokenStatus = getTokenStatus(connection);

  return (
    connection.provider.authType === "oauth2" &&
    (tokenStatus === "expired" || tokenStatus === "expiring") &&
    connection.hasRefreshToken
  );
}

function connectionIsReady(connection: Connection) {
  return connection.status === "active" && !connectionNeedsReconnect(connection);
}

function formatConnectionDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function SummaryCard({
  icon,
  label,
  title,
  description,
}: {
  icon: React.ReactNode;
  label: string;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-4">
      <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-zinc-500">
        {icon}
        {label}
      </div>
      <p className="mt-3 text-sm font-medium text-white">{title}</p>
      <p className="mt-1 text-sm leading-6 text-zinc-500">{description}</p>
    </div>
  );
}

function SavedCustomProvidersSection({
  providers,
  existingConnectionSlugs,
  onConnect,
  onEdit,
  onDelete,
  deletingSlug,
  onCustomIntegration,
}: {
  providers: ConnectableProvider[];
  existingConnectionSlugs: Set<string>;
  onConnect: (provider: ConnectableProvider) => void;
  onEdit: (slug: string) => void;
  onDelete: (provider: ConnectableProvider) => void;
  deletingSlug: string | null;
  onCustomIntegration: () => void;
}) {
  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-5">
      <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
        <div className="max-w-2xl">
          <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-zinc-500">
            Saved custom integrations
          </p>
          <h3 className="mt-2 text-lg font-semibold text-white">
            Finish custom setups that still need a connection
          </h3>
          <p className="mt-2 text-sm leading-6 text-zinc-500">
            Saved custom providers stay here until setup is complete. Once a
            custom integration connects successfully, you can manage reconnects
            and provider edits from My connections.
          </p>
        </div>

        <button
          type="button"
          onClick={onCustomIntegration}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700"
        >
          <Sparkles size={14} />
          New custom integration
        </button>
      </div>

      {providers.length === 0 ? (
        <div className="mt-5 rounded-[24px] border border-dashed border-zinc-800 bg-zinc-950/70 px-6 py-10 text-center">
          <h4 className="text-lg font-semibold text-white">
            No custom setups waiting on auth
          </h4>
          <p className="mx-auto mt-3 max-w-2xl text-sm leading-7 text-zinc-500">
            Connected custom integrations now live under My connections. Use
            the agent to start another provider whenever you need a fresh
            setup.
          </p>
        </div>
      ) : (
        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {providers.map((provider) => {
            const hasExistingConnection = existingConnectionSlugs.has(provider.slug);

            return (
              <div
                key={provider.slug}
                className="flex h-full flex-col rounded-[24px] border border-zinc-800 bg-zinc-950/80 p-5 shadow-[0_0_0_1px_rgba(255,255,255,0.02)]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    {provider.logoUrl ? (
                      <img
                        src={provider.logoUrl}
                        alt={provider.name}
                        className="h-11 w-11 rounded-xl border border-zinc-800 bg-zinc-900 p-1"
                      />
                    ) : (
                      <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900 text-xs font-medium uppercase text-zinc-400">
                        {provider.slug.slice(0, 2)}
                      </div>
                    )}

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="text-lg font-semibold text-white">
                          {provider.name}
                        </h4>
                        <span className="rounded-full border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-zinc-300">
                          Custom
                        </span>
                        {hasExistingConnection ? (
                          <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-200">
                            Reconnect needed
                          </span>
                        ) : null}
                      </div>

                      <p className="mt-3 min-h-[5.25rem] text-sm leading-7 text-zinc-500 line-clamp-4">
                        {provider.description || "Saved custom provider configuration."}
                      </p>

                      <div className="mt-4 flex flex-wrap gap-2">
                        <span className="rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-300">
                          {provider.authType}
                        </span>
                        {provider.category ? (
                          <span className="rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-500">
                            {provider.category}
                          </span>
                        ) : null}
                        {provider.hasCredentials ? (
                          <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-emerald-300">
                            Credentials saved
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  {provider.docsUrl ? (
                    <a
                      href={provider.docsUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0 rounded-xl border border-zinc-800 p-2 text-zinc-500 transition-colors hover:border-zinc-700 hover:text-white"
                      aria-label={`Open ${provider.name} docs`}
                    >
                      <ExternalLink size={14} />
                    </a>
                  ) : <div className="w-9 shrink-0" />}
                </div>

                <div className="mt-6 border-t border-zinc-800/80 pt-4">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => onConnect(provider)}
                      className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-700 px-4 py-2.5 text-sm text-zinc-200 transition-colors hover:border-zinc-600 hover:text-white"
                    >
                      <Link2 size={14} />
                      {hasExistingConnection ? "Reconnect" : "Connect"}
                    </button>

                    <button
                      type="button"
                      onClick={() => onEdit(provider.slug)}
                      className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-700 px-4 py-2.5 text-sm text-zinc-300 transition-colors hover:border-zinc-600 hover:text-white"
                    >
                      <Settings2 size={14} />
                      Edit provider
                    </button>
                  </div>

                  <div className="mt-3 flex justify-end">
                    <button
                      type="button"
                      onClick={() => onDelete(provider)}
                      disabled={deletingSlug === provider.slug}
                      className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-red-300 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {deletingSlug === provider.slug ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Trash2 size={14} />
                      )}
                      Delete integration
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ConnectionStatusPill({ connection }: { connection: Connection }) {
  const tokenStatus = getTokenStatus(connection);

  if (tokenStatus === "expired") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-500/10 px-3 py-1 text-xs font-medium text-rose-300">
        <AlertTriangle size={12} />
        Expired
      </span>
    );
  }

  if (tokenStatus === "expiring") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-200">
        <AlertTriangle size={12} />
        Expiring soon
      </span>
    );
  }

  if (tokenStatus === "no-token") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-800 px-3 py-1 text-xs font-medium text-zinc-300">
        <AlertTriangle size={12} />
        Missing token
      </span>
    );
  }

  const isActive = connection.status === "active";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
        isActive ? "bg-emerald-500/10 text-emerald-300" : "bg-zinc-800 text-zinc-300"
      }`}
    >
      {isActive ? <CheckCircle size={12} /> : <XCircle size={12} />}
      {isActive ? "Active" : connection.status}
    </span>
  );
}

export default function ConnectionsPage() {
  const [tab, setTab] = useState<"catalog" | "connections">("catalog");
  const [connections, setConnections] = useState<Connection[]>([]);
  const [catalog, setCatalog] = useState<CatalogProvider[]>([]);
  const [customProviders, setCustomProviders] = useState<ConnectableProvider[]>([]);
  const [categories, setCategories] = useState<string[]>(["All"]);
  const [loading, setLoading] = useState(true);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [customProvidersLoading, setCustomProvidersLoading] = useState(true);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, boolean>>({});
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [refreshErrors, setRefreshErrors] = useState<Record<string, string>>({});
  const [deletingProviderSlug, setDeletingProviderSlug] = useState<string | null>(null);
  const [connectingRequest, setConnectingRequest] =
    useState<ConnectRequest | null>(null);
  const [editingSlug, setEditingSlug] = useState<string | null>(null);

  const openConnectModal = (
    provider: ConnectableProvider,
    options?: { connectionId?: string }
  ) => {
    const explicitConnection = options?.connectionId
      ? connections.find((connection) => connection.id === options.connectionId) || null
      : null;
    const activeProviderConnections = connections.filter(
      (connection) =>
        connection.provider.slug === provider.slug && connection.status === "active",
    );

    if (!explicitConnection && activeProviderConnections.length > 1) {
      setTab("connections");
      window.alert(
        `Multiple active ${provider.name} connections exist. Reconnect from the specific connection card in My connections so GTMShip updates the original row.`,
      );
      return;
    }

    const targetConnection =
      explicitConnection ||
      (activeProviderConnections.length === 1 ? activeProviderConnections[0] : null);

    setConnectingRequest({
      provider,
      targetConnectionId: targetConnection?.id,
      targetConnectionLabel: targetConnection?.label ?? null,
    });
  };

  const connectedSlugs = useMemo(
    () => new Set(connections.map((connection) => connection.provider.slug)),
    [connections],
  );
  const readyConnectionSlugs = useMemo(
    () =>
      new Set(
        connections
          .filter((connection) => connectionIsReady(connection))
          .map((connection) => connection.provider.slug),
      ),
    [connections],
  );
  const catalogBySlug = useMemo(
    () => new Map(catalog.map((provider) => [provider.slug, provider])),
    [catalog],
  );
  const connectableProviders = useMemo(
    () => [
      ...catalog.map((provider) => normalizeCatalogProvider(provider)),
      ...customProviders,
    ],
    [catalog, customProviders],
  );
  const connectableProviderBySlug = useMemo(
    () => new Map(connectableProviders.map((provider) => [provider.slug, provider])),
    [connectableProviders],
  );
  const activeConnections = useMemo(
    () => connections.filter((connection) => connection.status === "active").length,
    [connections],
  );
  const pendingCustomProviders = useMemo(
    () =>
      customProviders.filter((provider) => !readyConnectionSlugs.has(provider.slug)),
    [customProviders, readyConnectionSlugs],
  );
  const attentionCount = useMemo(
    () =>
      connections.filter((connection) => {
        const tokenStatus = getTokenStatus(connection);
        return tokenStatus === "expired" || tokenStatus === "expiring" || tokenStatus === "no-token";
      }).length,
    [connections],
  );
  const catalogWorkspaceLoading = catalogLoading || customProvidersLoading;

  const loadConnections = async () => {
    try {
      const data: Connection[] = await api.getConnections();
      setConnections(data);

      for (const conn of data) {
        if (
          conn.provider.authType === "oauth2" &&
          conn.hasRefreshToken &&
          getTokenStatus(conn) === "expired"
        ) {
          try {
            await api.refreshConnection(conn.id);
          } catch {
            // The UI will surface the expired state if refresh fails.
          }
        }
      }

      const hadExpired = data.some(
        (connection) =>
          connection.provider.authType === "oauth2" &&
          connection.hasRefreshToken &&
          getTokenStatus(connection) === "expired",
      );

      if (hadExpired) {
        const refreshed = await api.getConnections();
        setConnections(refreshed);
      }
    } catch {
      // auth-service may not be running
    } finally {
      setLoading(false);
    }
  };

  const loadCatalog = async () => {
    try {
      const data: CatalogResponse = await api.getCatalog();
      setCatalog(data.items);
      setCategories(data.categories);
    } catch {
      // auth-service may not be running
    } finally {
      setCatalogLoading(false);
    }
  };

  const loadCustomProviders = async () => {
    try {
      const data = (await api.getProviders()) as SavedProvider[];
      setCustomProviders(
        data
          .filter((provider) => (provider.source || "manual") !== "catalog")
          .map((provider) => normalizeSavedProvider(provider)),
      );
    } catch {
      // auth-service may not be running
    } finally {
      setCustomProvidersLoading(false);
    }
  };

  useEffect(() => {
    void loadConnections();
    void loadCatalog();
    void loadCustomProviders();
  }, []);

  useEffect(() => {
    const handler = () => {
      void loadConnections();
      void loadCatalog();
      void loadCustomProviders();
    };

    window.addEventListener("connections-changed", handler);
    return () => window.removeEventListener("connections-changed", handler);
  }, []);

  const handleReloadAll = async () => {
    setLoading(true);
    setCatalogLoading(true);
    setCustomProvidersLoading(true);
    await Promise.all([loadConnections(), loadCatalog(), loadCustomProviders()]);
  };

  const handleTest = async (id: string) => {
    setTesting(id);
    try {
      const result = await api.testConnection(id);
      setTestResults((current) => ({ ...current, [id]: result.success }));
    } catch {
      setTestResults((current) => ({ ...current, [id]: false }));
    } finally {
      setTesting(null);
    }
  };

  const handleRefresh = async (connection: Connection) => {
    setRefreshing(connection.id);
    setRefreshErrors((current) => {
      const next = { ...current };
      delete next[connection.id];
      return next;
    });

    try {
      await api.refreshConnection(connection.id);
      await loadConnections();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Refresh failed";
      setRefreshErrors((current) => ({ ...current, [connection.id]: message }));
    } finally {
      setRefreshing(null);
    }
  };

  const handleDelete = async (id: string) => {
    await api.deleteConnection(id);
    setConnections((current) => current.filter((connection) => connection.id !== id));
  };

  const handleDeleteProvider = async (provider: ConnectableProvider) => {
    if (provider.source === "catalog") {
      return;
    }

    const connectedCount = connections.filter(
      (connection) => connection.provider.slug === provider.slug,
    ).length;
    const warning = connectedCount
      ? `Delete "${provider.name}" and its ${connectedCount} saved connection${connectedCount === 1 ? "" : "s"}? This removes the custom integration and every linked credential from GTMShip.`
      : `Delete "${provider.name}"? This removes the custom integration from GTMShip.`;

    if (!window.confirm(warning)) {
      return;
    }

    setDeletingProviderSlug(provider.slug);
    try {
      await api.deleteProvider(provider.slug);
      setCustomProviders((current) =>
        current.filter((item) => item.slug !== provider.slug),
      );
      setConnections((current) =>
        current.filter((connection) => connection.provider.slug !== provider.slug),
      );
      if (editingSlug === provider.slug) {
        setEditingSlug(null);
      }
      if (connectingRequest?.provider.slug === provider.slug) {
        setConnectingRequest(null);
      }
    } catch (error) {
      window.alert(
        error instanceof Error
          ? error.message
          : "Failed to delete the custom integration.",
      );
    } finally {
      setDeletingProviderSlug(null);
    }
  };

  const handleOpenAgent = (provider?: ConnectableProvider) => {
    const providerConnections = provider
      ? connections.filter((connection) => connection.provider.slug === provider.slug)
      : [];
    const initialMessage = provider
      ? `I want to connect to ${provider.name}. Auth type: ${provider.authType}. Source: ${provider.source || "catalog"}. Docs: ${provider.docsUrl || "N/A"}${
          providerConnections.length > 0
            ? ` Existing connections: ${providerConnections
                .map(
                  (connection) =>
                    `${connection.id}${connection.label ? ` (${connection.label})` : ""}`
                )
                .join(", ")}. If this is a reconnect, update the original connection instead of creating a duplicate.`
            : ""
        }`
      : "I want to set up a custom integration.";

    window.dispatchEvent(
      new CustomEvent("open-agent", { detail: { initialMessage } }),
    );
  };

  const tabDescription =
    tab === "catalog"
      ? "Browse the live catalog, finish saved custom setups that still need auth, and kick off a new custom integration when the built-in list is not enough."
      : "Review every active connection, test credentials, refresh expiring OAuth tokens, and jump straight into provider configuration.";

  return (
    <div className="mx-auto max-w-7xl p-8">
      <div className="space-y-6">
        <section className="relative overflow-hidden rounded-[28px] border border-zinc-800 bg-gradient-to-br from-zinc-900 via-zinc-950 to-zinc-950">
          <div className="absolute right-0 top-0 h-64 w-64 rounded-full bg-blue-500/10 blur-3xl" />
          <div className="absolute bottom-0 left-8 h-40 w-40 rounded-full bg-cyan-500/10 blur-3xl" />

          <div className="relative p-6 sm:p-8">
            <div className="flex flex-col gap-8 xl:flex-row xl:items-end xl:justify-between">
              <div className="max-w-3xl">
                <div className="inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/80 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.2em] text-zinc-400">
                  <ShieldCheck size={12} />
                  Integrations and auth flows
                </div>
                <h1 className="mt-4 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                  Connections
                </h1>
                <p className="mt-3 max-w-2xl text-sm leading-7 text-zinc-400 sm:text-base">
                  Connect GTMShip to the services your team already uses, keep
                  credentials healthy, and manage provider-level configuration
                  without leaving this workspace.
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <SummaryCard
                  icon={<LayoutGrid size={13} />}
                  label="Catalog"
                  title={
                    catalogLoading
                      ? "Loading integrations"
                      : `${catalog.length} providers ready`
                  }
                  description="Search the integration catalog and start with a known auth flow whenever it exists."
                />
                <SummaryCard
                  icon={<Link2 size={13} />}
                  label="Connected"
                  title={
                    loading
                      ? "Syncing connections"
                      : `${connections.length} connected services`
                  }
                  description={`${activeConnections} currently active across your connected providers.`}
                />
                <SummaryCard
                  icon={<AlertTriangle size={13} />}
                  label="Attention"
                  title={
                    attentionCount > 0
                      ? `${attentionCount} need review`
                      : pendingCustomProviders.length > 0
                        ? `${pendingCustomProviders.length} custom setup${pendingCustomProviders.length === 1 ? "" : "s"} pending`
                        : "Everything looks healthy"
                  }
                  description={
                    attentionCount > 0
                      ? "Refresh or reconnect expiring credentials before they interrupt deployments."
                      : pendingCustomProviders.length > 0
                        ? "Finish saved custom integrations here, then manage healthy connections from My connections."
                        : "Stable connections and completed custom setups stay manageable from the same page."
                  }
                />
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6">
          <div className="space-y-6">
            <div className="max-w-3xl">
              <div className="inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-950 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.2em] text-zinc-500">
                <Link2 size={12} />
                Connection workspace
              </div>
              <h2 className="mt-4 text-2xl font-semibold text-white">
                {tab === "catalog" ? "Find the right integration" : "Manage connected services"}
              </h2>
              <p className="mt-2 text-sm leading-7 text-zinc-400">{tabDescription}</p>
            </div>

            <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setTab("catalog")}
                    className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm transition-colors ${
                      tab === "catalog"
                        ? "border-blue-500 bg-blue-500/10 text-white"
                        : "border-zinc-700 text-zinc-400 hover:border-zinc-600 hover:text-white"
                    }`}
                  >
                    <LayoutGrid size={14} />
                    Catalog
                    <span className="rounded-full bg-zinc-950/80 px-2 py-0.5 text-[10px] text-zinc-400">
                      {catalog.length}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setTab("connections")}
                    className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm transition-colors ${
                      tab === "connections"
                        ? "border-blue-500 bg-blue-500/10 text-white"
                        : "border-zinc-700 text-zinc-400 hover:border-zinc-600 hover:text-white"
                    }`}
                  >
                    <List size={14} />
                    My connections
                    <span className="rounded-full bg-zinc-950/80 px-2 py-0.5 text-[10px] text-zinc-400">
                      {connections.length}
                    </span>
                  </button>
                </div>

                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <p className="text-sm text-zinc-500">
                    {tab === "catalog"
                      ? "Search first, then connect or finish any saved custom setups."
                      : "Refresh statuses, test auth, and edit providers from one place."}
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      void handleReloadAll();
                    }}
                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-700 px-4 py-2.5 text-sm text-zinc-300 transition-colors hover:border-zinc-600 hover:text-white"
                  >
                    <RefreshCw size={14} />
                    Refresh data
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-6">
            {tab === "catalog" ? (
              catalogWorkspaceLoading ? (
                <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-5 py-12 text-center">
                  <div className="inline-flex items-center gap-2 text-sm text-zinc-500">
                    <Loader2 size={16} className="animate-spin" />
                    Loading integrations...
                  </div>
                </div>
              ) : (
                <div className="space-y-6">
                  <SavedCustomProvidersSection
                    providers={pendingCustomProviders}
                    existingConnectionSlugs={connectedSlugs}
                    onConnect={openConnectModal}
                    onEdit={setEditingSlug}
                    onDelete={handleDeleteProvider}
                    deletingSlug={deletingProviderSlug}
                    onCustomIntegration={() => handleOpenAgent()}
                  />

                  <CatalogGrid
                    catalog={catalog}
                    categories={categories}
                    connectedSlugs={connectedSlugs}
                    onConnect={(provider) =>
                      openConnectModal(normalizeCatalogProvider(provider))
                    }
                    onCustomIntegration={() => handleOpenAgent()}
                  />
                </div>
              )
            ) : loading ? (
              <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-5 py-12 text-center">
                <div className="inline-flex items-center gap-2 text-sm text-zinc-500">
                  <Loader2 size={16} className="animate-spin" />
                  Loading connections...
                </div>
              </div>
            ) : connections.length === 0 ? (
              <div className="rounded-[24px] border border-dashed border-zinc-800 bg-zinc-950/50 px-6 py-14 text-center">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900 text-zinc-400">
                  <Link2 size={22} />
                </div>
                <h3 className="mt-5 text-xl font-semibold text-white">
                  No connections yet
                </h3>
                <p className="mx-auto mt-3 max-w-xl text-sm leading-7 text-zinc-500">
                  Start with the catalog for a guided setup, or use the agent to
                  create a custom integration when your provider needs a more
                  tailored auth flow.
                </p>
                <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                  <button
                    type="button"
                    onClick={() => setTab("catalog")}
                    className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700"
                  >
                    <LayoutGrid size={14} />
                    Browse catalog
                  </button>
                  <button
                    type="button"
                    onClick={() => handleOpenAgent()}
                    className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 px-4 py-2.5 text-sm text-zinc-300 transition-colors hover:border-zinc-600 hover:text-white"
                  >
                    <Sparkles size={14} />
                    Custom integration
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-5">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div className="max-w-2xl">
                      <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-zinc-500">
                        Connection health
                      </p>
                      <h3 className="mt-2 text-lg font-semibold text-white">
                        Keep credentials healthy and providers editable
                      </h3>
                      <p className="mt-2 text-sm leading-6 text-zinc-500">
                        Test live auth, refresh expiring OAuth tokens, and jump
                        into provider config without leaving the connections page.
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleOpenAgent()}
                      className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 px-4 py-2.5 text-sm text-zinc-300 transition-colors hover:border-zinc-600 hover:text-white"
                    >
                      <Sparkles size={14} />
                      Custom integration
                    </button>
                  </div>
                </div>

                <div className="grid gap-4 xl:grid-cols-2">
                  {connections.map((connection) => {
                    const catalogEntry = catalogBySlug.get(connection.provider.slug);
                    const connectableEntry = connectableProviderBySlug.get(
                      connection.provider.slug,
                    );
                    const needsReconnect = connectionNeedsReconnect(connection);
                    const canRefresh = connectionCanRefresh(connection);
                    const testResult = testResults[connection.id];

                    return (
                      <div
                        key={connection.id}
                        className="rounded-[24px] border border-zinc-800 bg-zinc-950/60 p-5 shadow-[0_0_0_1px_rgba(255,255,255,0.02)]"
                      >
                        <div className="flex flex-col gap-5">
                          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                            <div className="flex items-start gap-3">
                              {connection.provider.logoUrl ? (
                                <img
                                  src={connection.provider.logoUrl}
                                  alt={connection.provider.name}
                                  className="h-11 w-11 rounded-xl border border-zinc-800 bg-zinc-900 p-1"
                                />
                              ) : (
                                <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900 text-xs font-medium uppercase text-zinc-400">
                                  {connection.provider.slug.slice(0, 2)}
                                </div>
                              )}

                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <h3 className="text-lg font-semibold text-white">
                                    {connection.provider.name}
                                  </h3>
                                  {connection.provider.source === "catalog" ? (
                                    <span className="rounded-full border border-blue-500/20 bg-blue-500/10 px-2.5 py-1 text-[11px] font-medium text-blue-300">
                                      Catalog
                                    </span>
                                  ) : (
                                    <span className="rounded-full border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-zinc-300">
                                      Custom
                                    </span>
                                  )}
                                  {connection.provider.hasCredentials ? (
                                    <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-300">
                                      Credentials saved
                                    </span>
                                  ) : null}
                                </div>

                                {connection.provider.description ? (
                                  <p className="mt-2 text-sm leading-6 text-zinc-500">
                                    {connection.provider.description}
                                  </p>
                                ) : null}

                                <div className="mt-3 flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.18em] text-zinc-500">
                                  <span>{connection.provider.authType}</span>
                                  {connection.provider.category ? (
                                    <span>{connection.provider.category}</span>
                                  ) : null}
                                  <span>Added {formatConnectionDate(connection.createdAt)}</span>
                                  {connection.updatedAt ? (
                                    <span>Updated {formatConnectionDate(connection.updatedAt)}</span>
                                  ) : null}
                                </div>

                                {connection.label ? (
                                  <p className="mt-3 text-sm text-zinc-300">
                                    Label: {connection.label}
                                  </p>
                                ) : null}

                                {connection.accountEmail ? (
                                  <p className="mt-1 text-sm text-zinc-400">
                                    Account: {connection.accountEmail}
                                  </p>
                                ) : null}
                              </div>
                            </div>

                            <div className="flex flex-wrap items-center gap-2">
                              <ConnectionStatusPill connection={connection} />
                              {testResult !== undefined ? (
                                <span
                                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
                                    testResult
                                      ? "bg-emerald-500/10 text-emerald-300"
                                      : "bg-rose-500/10 text-rose-300"
                                  }`}
                                >
                                  {testResult ? (
                                    <CheckCircle size={12} />
                                  ) : (
                                    <XCircle size={12} />
                                  )}
                                  {testResult ? "Test passed" : "Test failed"}
                                </span>
                              ) : null}
                            </div>
                          </div>

                          {refreshErrors[connection.id] ? (
                            <div className="rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                              {refreshErrors[connection.id]}
                            </div>
                          ) : null}

                          <div className="flex flex-wrap items-center gap-2">
                            {canRefresh ? (
                              <button
                                type="button"
                                onClick={() => {
                                  void handleRefresh(connection);
                                }}
                                disabled={refreshing === connection.id}
                                className="inline-flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-200 transition-colors hover:bg-amber-500/15 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {refreshing === connection.id ? (
                                  <Loader2 size={14} className="animate-spin" />
                                ) : (
                                  <RotateCw size={14} />
                                )}
                                Refresh token
                              </button>
                            ) : null}

                            {needsReconnect && (connectableEntry || catalogEntry) ? (
                              <button
                                type="button"
                                onClick={() =>
                                  openConnectModal(
                                    connectableEntry ||
                                      normalizeCatalogProvider(catalogEntry!),
                                    { connectionId: connection.id },
                                  )
                                }
                                className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 px-4 py-2 text-sm text-zinc-300 transition-colors hover:border-zinc-600 hover:text-white"
                              >
                                <Link2 size={14} />
                                Reconnect
                              </button>
                            ) : null}

                            <button
                              type="button"
                              onClick={() => {
                                void handleTest(connection.id);
                              }}
                              disabled={testing === connection.id}
                              className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 px-4 py-2 text-sm text-zinc-300 transition-colors hover:border-zinc-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {testing === connection.id ? (
                                <Loader2 size={14} className="animate-spin" />
                              ) : (
                                <CheckCircle size={14} />
                              )}
                              Test connection
                            </button>

                            <button
                              type="button"
                              onClick={() => setEditingSlug(connection.provider.slug)}
                              className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 px-4 py-2 text-sm text-zinc-300 transition-colors hover:border-zinc-600 hover:text-white"
                            >
                              <Settings2 size={14} />
                              Edit provider
                            </button>

                            {connection.provider.docsUrl ? (
                              <a
                                href={connection.provider.docsUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 px-4 py-2 text-sm text-zinc-300 transition-colors hover:border-zinc-600 hover:text-white"
                              >
                                Docs
                                <ExternalLink size={14} />
                              </a>
                            ) : null}

                            <button
                              type="button"
                              onClick={() => {
                                void handleDelete(connection.id);
                              }}
                              className="inline-flex items-center gap-2 rounded-xl border border-red-500/20 px-4 py-2 text-sm text-red-300 transition-colors hover:bg-red-500/10"
                            >
                              <Trash2 size={14} />
                              Delete
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </section>

        {connectingRequest ? (
          <ConnectModal
            provider={connectingRequest.provider}
            catalog={connectableProviders}
            connectedSlugs={connectedSlugs}
            targetConnectionId={connectingRequest.targetConnectionId}
            targetConnectionLabel={connectingRequest.targetConnectionLabel}
            onClose={() => setConnectingRequest(null)}
            onConnected={() => {
              setConnectingRequest(null);
              void loadConnections();
              void loadCustomProviders();
              setTab("connections");
            }}
            onUseAgent={(provider) => {
              setConnectingRequest(null);
              handleOpenAgent(provider);
            }}
          />
        ) : null}

        {editingSlug ? (
          <ProviderDrawer
            slug={editingSlug}
            onClose={() => setEditingSlug(null)}
            onConnect={(provider) => {
              setEditingSlug(null);
              openConnectModal(provider);
            }}
            onDelete={handleDeleteProvider}
            onUpdated={() => {
              void loadConnections();
              void loadCatalog();
              void loadCustomProviders();
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
