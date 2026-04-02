"use client";

import { useMemo, useState } from "react";
import { ExternalLink, Search, Sparkles } from "lucide-react";
import type { CatalogProvider } from "@/lib/catalog";
import { resolveSharedOAuthProviderKey } from "@/lib/shared-oauth";

interface CatalogGridProps {
  catalog: CatalogProvider[];
  categories: string[];
  connectedSlugs: Set<string>;
  onConnect: (provider: CatalogProvider) => void;
  onCustomIntegration: () => void;
}

export function CatalogGrid({
  catalog,
  categories,
  connectedSlugs,
  onConnect,
  onCustomIntegration,
}: CatalogGridProps) {
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("All");

  const filtered = useMemo(() => {
    let items = catalog;

    if (activeCategory !== "All") {
      items = items.filter((provider) => provider.category === activeCategory);
    }

    if (search.trim()) {
      const query = search.toLowerCase();
      items = items.filter((provider) => {
        const description = provider.description?.toLowerCase() || "";

        return (
          provider.name.toLowerCase().includes(query) ||
          provider.slug.toLowerCase().includes(query) ||
          description.includes(query)
        );
      });
    }

    return items;
  }, [catalog, activeCategory, search]);

  const connectedCount = useMemo(
    () => filtered.filter((provider) => connectedSlugs.has(provider.slug)).length,
    [connectedSlugs, filtered],
  );

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-5">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div className="max-w-2xl">
            <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-zinc-500">
              Integration catalog
            </p>
            <h3 className="mt-2 text-lg font-semibold text-white">
              Search the providers GTMShip already knows about
            </h3>
            <p className="mt-2 text-sm leading-6 text-zinc-500">
              Filter by category, search for a product or auth pattern, and use
              the agent when you need a custom setup outside the built-in catalog.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="rounded-xl border border-zinc-800 bg-zinc-950/90 px-4 py-3">
              <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">
                Showing
              </p>
              <p className="mt-2 text-sm font-medium text-white">
                {filtered.length} provider{filtered.length === 1 ? "" : "s"}
              </p>
              <p className="mt-1 text-xs leading-5 text-zinc-500">
                {connectedCount} already connected in this view.
              </p>
            </div>

            <button
              type="button"
              onClick={onCustomIntegration}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700"
            >
              <Sparkles size={14} />
              Custom integration
            </button>
          </div>
        </div>

        <div className="relative mt-6 self-start">
          <Search
            size={16}
            className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500"
          />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search integrations, auth types, or provider names..."
            className="w-full rounded-xl border border-zinc-800 bg-zinc-950/90 py-3 pl-11 pr-4 text-sm text-white placeholder-zinc-600 outline-none transition-colors focus:border-blue-500"
          />
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          {categories.map((category) => (
            <button
              key={category}
              type="button"
              onClick={() => setActiveCategory(category)}
              className={`rounded-full border px-3 py-2 text-xs transition-colors ${
                activeCategory === category
                  ? "border-blue-500 bg-blue-500/10 text-white"
                  : "border-zinc-800 bg-zinc-950 text-zinc-400 hover:border-zinc-700 hover:text-white"
              }`}
            >
              {category}
            </button>
          ))}
        </div>
      </section>

      {filtered.length === 0 ? (
        <div className="rounded-[24px] border border-dashed border-zinc-800 bg-zinc-950/50 px-6 py-14 text-center">
          <h3 className="text-xl font-semibold text-white">No integrations found</h3>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-7 text-zinc-500">
            Try a different search term or category, or use the custom
            integration flow if the provider is not part of the built-in catalog yet.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((provider) => {
            const connected = connectedSlugs.has(provider.slug);

            return (
              <div
                key={provider.slug}
                className="rounded-[24px] border border-zinc-800 bg-zinc-950/60 p-5 shadow-[0_0_0_1px_rgba(255,255,255,0.02)] transition-colors hover:border-zinc-700"
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

                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="text-lg font-semibold text-white">
                          {provider.name}
                        </h4>
                        {connected ? (
                          <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-300">
                            Connected
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-2 text-sm leading-6 text-zinc-500 line-clamp-3">
                        {provider.description}
                      </p>
                    </div>
                  </div>

                  {provider.docsUrl ? (
                    <a
                      href={provider.docsUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-xl border border-zinc-800 p-2 text-zinc-500 transition-colors hover:border-zinc-700 hover:text-white"
                      aria-label={`Open ${provider.name} docs`}
                    >
                      <ExternalLink size={14} />
                    </a>
                  ) : null}
                </div>

                <div className="mt-5 flex flex-wrap gap-2">
                  <span className="rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-300">
                    {provider.authType}
                  </span>
                  <span className="rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-500">
                    {provider.category}
                  </span>
                  {resolveSharedOAuthProviderKey({
                    slug: provider.slug,
                    oauthProviderKey: provider.oauthProviderKey,
                  }) ? (
                    <span className="rounded-full border border-blue-500/20 bg-blue-500/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-blue-300">
                      Shared OAuth
                    </span>
                  ) : null}
                </div>

                <div className="mt-5 flex items-end justify-between gap-3">
                  <p className="max-w-[16rem] text-xs leading-6 text-zinc-500">
                    {connected
                      ? "Reconnect to rotate credentials or re-run the setup flow for this integration."
                      : "Start the guided auth flow and save the credentials GTMShip needs."}
                  </p>

                  <button
                    type="button"
                    onClick={() => onConnect(provider)}
                    className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 px-4 py-2 text-sm text-zinc-200 transition-colors hover:border-zinc-600 hover:text-white"
                  >
                    {connected ? "Reconnect" : "Connect"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
