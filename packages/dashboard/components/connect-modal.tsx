"use client";

import { useEffect, useMemo, useState } from "react";
import {
  X,
  Loader2,
  ExternalLink,
  Sparkles,
  Copy,
  Check,
  ShieldCheck,
} from "lucide-react";
import { api } from "@/lib/api";
import type { ConnectableProvider } from "@/lib/providers";
import { resolveSharedOAuthProviderKey } from "@/lib/shared-oauth";

interface ConnectModalProps {
  provider: ConnectableProvider;
  catalog: ConnectableProvider[];
  connectedSlugs: Set<string>;
  onClose: () => void;
  onConnected: () => void;
  onUseAgent: (provider: ConnectableProvider) => void;
}

interface SharedOAuthProviderStatus {
  key: string;
  name: string;
  callback_slug: string;
  redirect_uri: string;
  has_credentials: boolean;
}

export function ConnectModal({
  provider,
  catalog,
  connectedSlugs,
  onClose,
  onConnected,
  onUseAgent,
}: ConnectModalProps) {
  const [step, setStep] = useState<"credentials" | "connecting" | "done" | "error">(
    "credentials"
  );
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [sharedOAuthProvider, setSharedOAuthProvider] =
    useState<SharedOAuthProviderStatus | null>(null);
  const [loadingSharedOAuth, setLoadingSharedOAuth] = useState(false);
  const [selectedServiceSlugs, setSelectedServiceSlugs] = useState<string[]>([
    provider.slug,
  ]);

  const isOAuth = provider.authType === "oauth2";
  const effectiveOAuthProviderKey = resolveSharedOAuthProviderKey({
    slug: provider.slug,
    oauthProviderKey: provider.oauthProviderKey,
  });
  const isSharedOAuth = isOAuth && !!effectiveOAuthProviderKey;
  const authServiceUrl = process.env.NEXT_PUBLIC_AUTH_URL || "http://localhost:4000";
  const providerSource = provider.source && provider.source !== "catalog" ? "custom" : "catalog";
  const savedProviderCredentials = !!provider.existingProvider && !!provider.hasCredentials;
  const enteredCredentials = !!clientId || !!clientSecret;

  const sharedFamilyProviders = useMemo(() => {
    if (!isSharedOAuth || !effectiveOAuthProviderKey) {
      return [];
    }

    return catalog.filter(
      (item) =>
        item.authType === "oauth2" &&
        resolveSharedOAuthProviderKey({
          slug: item.slug,
          oauthProviderKey: item.oauthProviderKey,
        }) === effectiveOAuthProviderKey &&
        (item.slug === provider.slug || !connectedSlugs.has(item.slug))
    );
  }, [
    catalog,
    connectedSlugs,
    effectiveOAuthProviderKey,
    isSharedOAuth,
    provider.slug,
  ]);

  const selectedProviders = useMemo(() => {
    const bySlug = new Map(catalog.map((item) => [item.slug, item]));
    return selectedServiceSlugs
      .map((slug) => bySlug.get(slug))
      .filter((item): item is ConnectableProvider => !!item);
  }, [catalog, selectedServiceSlugs]);

  const redirectUrl = useMemo(() => {
    if (sharedOAuthProvider?.redirect_uri) {
      return sharedOAuthProvider.redirect_uri;
    }

    const callbackSlug =
      sharedOAuthProvider?.callback_slug ||
      (isSharedOAuth ? effectiveOAuthProviderKey : provider.slug);
    return `${authServiceUrl}/auth/${callbackSlug}/callback`;
  }, [
    authServiceUrl,
    effectiveOAuthProviderKey,
    isSharedOAuth,
    provider.slug,
    sharedOAuthProvider?.callback_slug,
    sharedOAuthProvider?.redirect_uri,
  ]);

  const oauthAppName =
    sharedOAuthProvider?.name ||
    (effectiveOAuthProviderKey === "google" ? "Google" : provider.name);

  useEffect(() => {
    setStep("credentials");
    setError("");
    setCopied(false);
    setClientId("");
    setClientSecret("");
    setApiKey("");
    setLabel("");
    setSelectedServiceSlugs([provider.slug]);
  }, [provider.slug]);

  useEffect(() => {
    if (!isSharedOAuth || !effectiveOAuthProviderKey) {
      setSharedOAuthProvider(null);
      return;
    }

    let active = true;
    setLoadingSharedOAuth(true);
    api
      .getOAuthProvider(effectiveOAuthProviderKey)
      .then((data) => {
        if (!active) return;
        setSharedOAuthProvider(data as SharedOAuthProviderStatus);
      })
      .catch(() => {
        if (!active) return;
        setSharedOAuthProvider(null);
      })
      .finally(() => {
        if (active) {
          setLoadingSharedOAuth(false);
        }
      });

    return () => {
      active = false;
    };
  }, [effectiveOAuthProviderKey, isSharedOAuth]);

  const handleCopyRedirect = () => {
    navigator.clipboard.writeText(redirectUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const toggleServiceSlug = (slug: string) => {
    if (slug === provider.slug) {
      return;
    }

    setSelectedServiceSlugs((current) =>
      current.includes(slug)
        ? current.filter((item) => item !== slug)
        : [...current, slug]
    );
  };

  const buildProviderConfig = (connectableProvider: ConnectableProvider) => {
    const providerConfig: Record<string, unknown> = {
      name: connectableProvider.name,
      slug: connectableProvider.slug,
      auth_type: connectableProvider.authType,
      base_url: connectableProvider.baseUrl || "",
      docs_url: connectableProvider.docsUrl,
      category: connectableProvider.category,
      logo_url: connectableProvider.logoUrl,
      description: connectableProvider.description,
      source: connectableProvider.source || "catalog",
      oauth_provider_key: resolveSharedOAuthProviderKey({
        slug: connectableProvider.slug,
        oauthProviderKey: connectableProvider.oauthProviderKey,
      }),
    };

    if (connectableProvider.authType === "oauth2") {
      providerConfig.authorize_url = connectableProvider.authUrl;
      providerConfig.token_url = connectableProvider.tokenUrl;
      providerConfig.scopes = connectableProvider.scopes || [];
      if (
        !resolveSharedOAuthProviderKey({
          slug: connectableProvider.slug,
          oauthProviderKey: connectableProvider.oauthProviderKey,
        })
      ) {
        providerConfig.client_id = clientId;
        providerConfig.client_secret = clientSecret;
      }
    } else {
      providerConfig.header_name = connectableProvider.headerName || "Authorization";
    }

    return providerConfig;
  };

  const ensureSharedOAuthProvider = async () => {
    if (!isSharedOAuth || !effectiveOAuthProviderKey) {
      return;
    }

    if (enteredCredentials && (!clientId || !clientSecret)) {
      throw new Error("Enter both Client ID and Client Secret to replace the saved OAuth app.");
    }

    if (!sharedOAuthProvider?.has_credentials && (!clientId || !clientSecret)) {
      throw new Error(`Enter your ${oauthAppName} OAuth app credentials first.`);
    }

    if (!sharedOAuthProvider?.has_credentials || enteredCredentials) {
      const data = (await api.upsertOAuthProvider(effectiveOAuthProviderKey, {
        name: oauthAppName,
        authorize_url: provider.authUrl,
        token_url: provider.tokenUrl,
        client_id: clientId,
        client_secret: clientSecret,
      })) as SharedOAuthProviderStatus;
      setSharedOAuthProvider(data);
    }
  };

  const ensureOAuthProviderCanConnect = () => {
    if (!isOAuth) {
      return;
    }

    if (!provider.authUrl || !provider.tokenUrl) {
      throw new Error(
        provider.existingProvider
          ? "This custom OAuth provider is missing its authorize or token URL. Open Edit provider and finish the OAuth configuration first."
          : "This OAuth provider is missing an authorize or token URL."
      );
    }

    if (isSharedOAuth) {
      return;
    }

    if (enteredCredentials && (!clientId || !clientSecret)) {
      throw new Error(
        savedProviderCredentials
          ? "Enter both Client ID and Client Secret to replace the saved OAuth app."
          : "Enter both Client ID and Client Secret."
      );
    }

    if (!savedProviderCredentials && (!clientId || !clientSecret)) {
      throw new Error(
        provider.existingProvider
          ? "This provider does not have saved OAuth app credentials yet. Enter Client ID and Client Secret to continue."
          : "Enter both Client ID and Client Secret."
      );
    }
  };

  const ensureSelectedProviders = async () => {
    await Promise.all(
      selectedProviders.map(async (selectedProvider) => {
        const selectedSharedOAuthKey = resolveSharedOAuthProviderKey({
          slug: selectedProvider.slug,
          oauthProviderKey: selectedProvider.oauthProviderKey,
        });

        if (selectedProvider.existingProvider) {
          if (
            selectedProvider.authType === "oauth2" &&
            (!selectedProvider.authUrl || !selectedProvider.tokenUrl)
          ) {
            throw new Error(
              `"${selectedProvider.name}" is missing its authorize or token URL. Open Edit provider and finish the OAuth configuration first.`
            );
          }

          if (
            selectedProvider.authType === "oauth2" &&
            !selectedSharedOAuthKey &&
            enteredCredentials
          ) {
            await api.updateProvider(selectedProvider.slug, {
              client_id: clientId,
              client_secret: clientSecret,
            });
          }

          return;
        }

        await api.createProvider(buildProviderConfig(selectedProvider));
      })
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStep("connecting");
    setError("");

    try {
      if (isSharedOAuth) {
        await ensureSharedOAuthProvider();
      } else {
        ensureOAuthProviderCanConnect();
      }

      await ensureSelectedProviders();

      if (isOAuth) {
        const serviceSlugs = isSharedOAuth ? selectedServiceSlugs : [provider.slug];
        const oauthStart = (await api.startOAuth(provider.slug, {
          serviceSlugs,
        })) as {
          authorize_url?: string;
          error?: string;
        };
        if (!oauthStart.authorize_url) {
          throw new Error(oauthStart.error || "Failed to start OAuth flow.");
        }
        const { authorize_url } = oauthStart;

        const popup = window.open(
          authorize_url,
          "oauth",
          "popup=yes,width=620,height=760,scrollbars=yes,resizable=yes"
        );

        if (!popup) {
          window.location.assign(authorize_url);
          return;
        }

        let completed = false;
        const successSlugs = new Set(serviceSlugs);

        const cleanup = (pollId?: ReturnType<typeof setInterval>) => {
          if (pollId) clearInterval(pollId);
          window.removeEventListener("message", handler);
        };

        const handler = (event: MessageEvent) => {
          if (event.data?.type === "OAUTH_SUCCESS") {
            const providersFromEvent: string[] = Array.isArray(
              event.data?.providers
            )
              ? event.data.providers.filter(
                  (slug: unknown): slug is string =>
                    typeof slug === "string" && slug.length > 0
                )
              : [event.data?.provider].filter(
                  (slug: unknown): slug is string =>
                    typeof slug === "string" && slug.length > 0
                );

            if (
              providersFromEvent.length === 0 ||
              providersFromEvent.some((slug) => successSlugs.has(slug))
            ) {
              completed = true;
              cleanup(pollClosed);
              popup.close();
              setStep("done");
              onConnected();
            }
          } else if (event.data?.type === "OAUTH_ERROR") {
            completed = true;
            cleanup(pollClosed);
            popup.close();
            setStep("error");
            setError(event.data.error || "OAuth flow failed");
          }
        };
        window.addEventListener("message", handler);

        const pollForConnection = async () => {
          try {
            const connections = (await api.getConnections()) as Array<{
              provider: { slug: string };
              createdAt: string;
              updatedAt?: string;
            }>;
            const found = connections.some((connection) => {
              const changedAt = new Date(
                connection.updatedAt || connection.createdAt
              ).getTime();
              return (
                successSlugs.has(connection.provider.slug) &&
                changedAt > Date.now() - 60000
              );
            });

            if (found) {
              completed = true;
              cleanup(pollClosed);
              popup.close();
              setStep("done");
              onConnected();
            }
          } catch {
            // ignore and retry
          }
        };

        const pollClosed = setInterval(() => {
          if (completed) {
            cleanup(pollClosed);
            return;
          }

          if (popup.closed) {
            pollForConnection().then(() => {
              if (!completed) {
                cleanup(pollClosed);
                setStep((prev) => (prev === "connecting" ? "error" : prev));
                setError(
                  (prev) => prev || "OAuth popup was closed before completing."
                );
              }
            });
          }
        }, 2000);

        setTimeout(() => cleanup(pollClosed), 300000);
      } else {
        await api.connectApiKey(
          provider.slug,
          apiKey,
          label || `${provider.slug}-${Date.now()}`
        );
        setStep("done");
        onConnected();
      }
    } catch (err) {
      setStep("error");
      setError(err instanceof Error ? err.message : "Connection failed");
    }
  };

  const credentialsMessage = isSharedOAuth
    ? loadingSharedOAuth
      ? `Checking saved ${oauthAppName} OAuth app credentials...`
      : sharedOAuthProvider?.has_credentials
        ? `Using saved ${oauthAppName} OAuth app credentials. Fill the fields only if you want to replace them.`
        : `Save your ${oauthAppName} OAuth app credentials once, then reuse them across every supported ${oauthAppName} service.`
    : savedProviderCredentials
      ? "This provider already has saved OAuth app credentials. Fill the fields only if you want to replace them."
      : provider.existingProvider
        ? "Enter the OAuth app credentials for this saved custom provider so GTMShip can start the authorization flow."
        : "Enter the OAuth app credentials from the provider's developer portal.";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-5xl overflow-hidden rounded-[28px] border border-zinc-800 bg-zinc-950 shadow-[0_32px_120px_rgba(0,0,0,0.55)]">
        <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-5">
          <div className="flex items-center gap-4">
            {provider.logoUrl ? (
              <img
                src={provider.logoUrl}
                alt={provider.name}
                className="h-12 w-12 rounded-2xl border border-zinc-800 bg-zinc-900 p-2"
              />
            ) : (
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900 text-sm font-medium uppercase text-zinc-400">
                {provider.slug.slice(0, 2)}
              </div>
            )}
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">
                  {providerSource}
                </span>
                <span className="rounded-full border border-blue-500/20 bg-blue-500/10 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.2em] text-blue-300">
                  {provider.authType}
                </span>
              </div>
              <h3 className="mt-2 text-xl font-semibold text-white">
                {connectedSlugs.has(provider.slug) ? "Reconnect" : "Connect"} {provider.name}
              </h3>
              <p className="mt-1 text-sm text-zinc-500">
                {provider.existingProvider
                  ? "Use the provider config you already saved, then authorize cleanly without re-creating the integration."
                  : "Start from the catalog defaults and save everything GTMShip needs for future reconnects."}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="rounded-full border border-zinc-800 p-2 text-zinc-500 transition-colors hover:border-zinc-700 hover:text-white"
          >
            <X size={16} />
          </button>
        </div>

        {step === "done" ? (
          <div className="px-6 py-16 text-center">
            <div className="mb-4 inline-flex h-14 w-14 items-center justify-center rounded-full border border-emerald-500/20 bg-emerald-500/10">
              <Check className="text-emerald-300" size={22} />
            </div>
            <p className="text-xl font-semibold text-white">Connection ready</p>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-7 text-zinc-500">
              {provider.name} is now connected. GTMShip saved the provider config and refreshed the connection state for this workspace.
            </p>
            <button
              onClick={onClose}
              className="mt-6 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700"
            >
              Back to connections
            </button>
          </div>
        ) : (
          <div className="grid lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
            <form onSubmit={handleSubmit} className="p-6 sm:p-7">
              <div className="space-y-6">
                {step === "connecting" ? (
                  <div className="rounded-2xl border border-blue-500/20 bg-blue-500/10 px-4 py-3 text-sm text-blue-100">
                    <div className="flex items-center gap-2">
                      <Loader2 size={16} className="animate-spin" />
                      <span>Opening the authorization step now.</span>
                    </div>
                    <p className="mt-2 text-xs leading-6 text-blue-100/75">
                      If a popup is blocked, GTMShip will fall back to the same browser tab so the OAuth flow still completes cleanly.
                    </p>
                  </div>
                ) : null}

                {isOAuth ? (
                  <>
                    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="text-sm font-medium text-white">
                            OAuth app setup
                          </p>
                          <p className="mt-1 text-sm leading-6 text-zinc-500">
                            {credentialsMessage}
                          </p>
                        </div>
                        {provider.docsUrl ? (
                          <a
                            href={provider.docsUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:border-zinc-600 hover:text-white"
                          >
                            Docs
                            <ExternalLink size={12} />
                          </a>
                        ) : null}
                      </div>

                      <div className="mt-4 rounded-xl border border-amber-900/50 bg-amber-950/30 px-3 py-3">
                        <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.18em] text-amber-300/90">
                          Redirect URL
                        </p>
                        <div className="flex items-center gap-2">
                          <code className="flex-1 select-all break-all rounded-lg bg-black/30 px-3 py-2 font-mono text-[11px] leading-5 text-amber-100/85">
                            {redirectUrl}
                          </code>
                          <button
                            type="button"
                            onClick={handleCopyRedirect}
                            className="shrink-0 rounded-lg border border-amber-400/20 p-2 text-amber-300/80 transition-colors hover:border-amber-300/40 hover:text-amber-200"
                            title="Copy redirect URL"
                          >
                            {copied ? <Check size={14} /> : <Copy size={14} />}
                          </button>
                        </div>
                      </div>
                    </div>

                    {isSharedOAuth && sharedFamilyProviders.length > 1 ? (
                      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4">
                        <p className="text-sm font-medium text-white">
                          Apply this OAuth session to related services
                        </p>
                        <p className="mt-1 text-sm leading-6 text-zinc-500">
                          One {oauthAppName} authorization can cover multiple services handled by the same OAuth app.
                        </p>

                        <div className="mt-4 space-y-2">
                          {sharedFamilyProviders.map((item) => {
                            const checked = selectedServiceSlugs.includes(item.slug);
                            const disabled = item.slug === provider.slug;
                            return (
                              <label
                                key={item.slug}
                                className="flex items-start gap-3 rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-3 text-sm text-zinc-300"
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={disabled}
                                  onChange={() => toggleServiceSlug(item.slug)}
                                  className="mt-1"
                                />
                                <span>
                                  <span className="block font-medium text-zinc-100">
                                    {item.name}
                                  </span>
                                  <span className="mt-1 block text-xs leading-5 text-zinc-500">
                                    {disabled
                                      ? "Required for this authorization flow."
                                      : "Authorize this service in the same session."}
                                  </span>
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <label className="mb-1.5 block text-xs font-medium uppercase tracking-[0.16em] text-zinc-500">
                          Client ID
                        </label>
                        <input
                          type="text"
                          value={clientId}
                          onChange={(e) => setClientId(e.target.value)}
                          required={
                            !isSharedOAuth &&
                            !savedProviderCredentials
                          }
                          className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-3 text-sm text-white outline-none transition-colors focus:border-blue-500"
                          placeholder={
                            savedProviderCredentials || sharedOAuthProvider?.has_credentials
                              ? "Leave blank to keep the saved client ID"
                              : "Your OAuth client ID"
                          }
                        />
                      </div>
                      <div>
                        <label className="mb-1.5 block text-xs font-medium uppercase tracking-[0.16em] text-zinc-500">
                          Client Secret
                        </label>
                        <input
                          type="password"
                          value={clientSecret}
                          onChange={(e) => setClientSecret(e.target.value)}
                          required={
                            !isSharedOAuth &&
                            !savedProviderCredentials
                          }
                          className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-3 text-sm text-white outline-none transition-colors focus:border-blue-500"
                          placeholder={
                            savedProviderCredentials || sharedOAuthProvider?.has_credentials
                              ? "Leave blank to keep the saved client secret"
                              : "Your OAuth client secret"
                          }
                        />
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
                    <div>
                      <p className="text-sm font-medium text-white">API key setup</p>
                      <p className="mt-1 text-sm leading-6 text-zinc-500">
                        Save the key GTMShip should use for {provider.name} and give it a label you will recognize later.
                      </p>
                    </div>

                    <div>
                      <label className="mb-1.5 block text-xs font-medium uppercase tracking-[0.16em] text-zinc-500">
                        API Key
                      </label>
                      <input
                        type="password"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        required
                        className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-3 text-sm text-white outline-none transition-colors focus:border-blue-500"
                        placeholder="Your API key"
                      />
                    </div>

                    <div>
                      <label className="mb-1.5 block text-xs font-medium uppercase tracking-[0.16em] text-zinc-500">
                        Label
                      </label>
                      <input
                        type="text"
                        value={label}
                        onChange={(e) => setLabel(e.target.value)}
                        className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-3 text-sm text-white outline-none transition-colors focus:border-blue-500"
                        placeholder={`${provider.slug}-production`}
                      />
                    </div>
                  </div>
                )}

                {error ? (
                  <div className="rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                    {error}
                  </div>
                ) : null}

                <div className="flex flex-col gap-3 border-t border-zinc-800 pt-5 sm:flex-row sm:items-center sm:justify-between">
                  <button
                    type="button"
                    onClick={() => onUseAgent(provider)}
                    className="inline-flex items-center gap-1.5 text-sm text-zinc-500 transition-colors hover:text-blue-400"
                  >
                    <Sparkles size={14} />
                    Use the agent instead
                  </button>

                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={onClose}
                      className="rounded-xl border border-zinc-700 px-4 py-2.5 text-sm text-zinc-300 transition-colors hover:border-zinc-600 hover:bg-zinc-900"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={step === "connecting"}
                      className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                    >
                      {step === "connecting" ? (
                        <>
                          <Loader2 size={14} className="animate-spin" />
                          Opening...
                        </>
                      ) : isOAuth ? (
                        "Authorize"
                      ) : (
                        "Connect"
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </form>

            <aside className="border-t border-zinc-800 bg-zinc-900/40 p-6 lg:border-l lg:border-t-0">
              <div className="space-y-5">
                <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4">
                  <div className="flex items-center gap-2 text-sm font-medium text-white">
                    <ShieldCheck size={15} className="text-emerald-300" />
                    What GTMShip will do
                  </div>
                  <div className="mt-4 space-y-3 text-sm leading-6 text-zinc-500">
                    <p>1. Save the provider configuration that should back this connection.</p>
                    <p>2. Launch the authorization step with the callback URL above.</p>
                    <p>3. Return here and update the saved connection instead of creating a duplicate reconnect.</p>
                  </div>
                </div>

                <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4">
                  <p className="text-sm font-medium text-white">Connection summary</p>
                  <div className="mt-4 space-y-3 text-sm text-zinc-400">
                    <div className="flex items-center justify-between gap-3">
                      <span>Provider</span>
                      <span className="font-medium text-white">{provider.name}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span>Slug</span>
                      <code className="rounded bg-zinc-900 px-2 py-1 text-xs text-zinc-200">
                        {provider.slug}
                      </code>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span>Source</span>
                      <span className="capitalize text-zinc-200">{providerSource}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span>Credentials</span>
                      <span className="text-zinc-200">
                        {isSharedOAuth
                          ? sharedOAuthProvider?.has_credentials
                            ? "Saved shared app"
                            : "Need shared app"
                          : savedProviderCredentials
                            ? "Saved on provider"
                            : isOAuth
                              ? "Need app credentials"
                              : "Collected on submit"}
                      </span>
                    </div>
                    {isSharedOAuth && selectedProviders.length > 1 ? (
                      <div className="pt-1">
                        <span className="text-xs uppercase tracking-[0.18em] text-zinc-500">
                          Included services
                        </span>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {selectedProviders.map((item) => (
                            <span
                              key={item.slug}
                              className="rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1 text-xs text-zinc-200"
                            >
                              {item.name}
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>

                {provider.existingProvider ? (
                  <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4 text-sm leading-6 text-zinc-500">
                    <p className="font-medium text-white">Saved custom provider</p>
                    <p className="mt-2">
                      GTMShip will reuse the provider definition you already saved here. If the OAuth endpoints look wrong, close this modal and update them from the provider editor first.
                    </p>
                  </div>
                ) : null}
              </div>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}
