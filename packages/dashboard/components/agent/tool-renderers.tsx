"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { ResearchResult } from "@/lib/research";
import {
  WORKFLOW_DRAFT_PROGRESS_LABELS,
  WORKFLOW_DRAFT_PROGRESS_STAGES,
  isWorkflowDraftProgressEvent,
  type WorkflowDraftProgressEvent,
  type WorkflowDraftProgressStage,
} from "@/lib/workflow-studio/types";
import {
  Globe,
  Terminal,
  FileJson,
  Save,
  Link2,
  Package,
  CheckCircle,
  AlertCircle,
  XCircle,
  Loader2,
  ExternalLink,
  Search,
  Brain,
} from "lucide-react";

interface ToolInvocation {
  toolName: string;
  args: Record<string, unknown>;
  state: "call" | "result" | "partial-call";
  result?: unknown;
  toolCallId?: string;
}

export interface OAuthCompletionPayload {
  connectionId?: string | null;
  connectionIds?: string[];
  provider?: string;
  providers?: string[];
}

export function ToolRenderer({
  invocation,
  onOAuthComplete,
  streamData,
}: {
  invocation: ToolInvocation;
  onOAuthComplete?: (payload: OAuthCompletionPayload) => void;
  streamData?: unknown[];
}) {
  const { toolName, args, state, result } = invocation;

  switch (toolName) {
    case "researchWeb":
      return <ResearchWebRenderer args={args} state={state} result={result} />;
    case "searchDocumentation":
      return <SearchResultsRenderer args={args} state={state} result={result} />;
    case "fetchUrl":
      return <FetchUrlRenderer args={args} state={state} result={result} />;
    case "executeCommand":
      return <CommandRenderer args={args} state={state} result={result} />;
    case "readCatalogProvider":
      return <CatalogLookupRenderer args={args} state={state} result={result} />;
    case "readIntegrationReference":
      return <IntegrationReferenceRenderer args={args} state={state} result={result} />;
    case "searchProjectFiles":
      return <ProjectSearchRenderer args={args} state={state} result={result} />;
    case "readProjectFile":
      return <ProjectFileRenderer args={args} state={state} result={result} />;
    case "generateWorkflowDraft":
      return (
        <DraftRenderer
          args={args}
          state={state}
          result={result}
          title="Generating draft"
          toolCallId={invocation.toolCallId}
          streamData={streamData}
        />
      );
    case "getCurrentDraft":
      return <DraftRenderer args={args} state={state} result={result} title="Inspecting draft" />;
    case "validateWorkflowDraft":
      return <ValidationRenderer args={args} state={state} result={result} />;
    case "previewWorkflowDraft":
      return <PreviewRenderer args={args} state={state} result={result} />;
    case "buildWorkflowDraft":
      return <BuildRenderer args={args} state={state} result={result} />;
    case "buildProviderConfig":
      return <ConfigRenderer args={args} state={state} result={result} title="Validating config" />;
    case "saveProvider":
      return <SaveResultRenderer args={args} state={state} result={result} />;
    case "connectApiKey":
      return <ConnectionRenderer args={args} state={state} result={result} title="Connecting API key" />;
    case "startOAuth":
      return (
        <OAuthStartRenderer
          args={args}
          state={state}
          result={result}
          onComplete={onOAuthComplete}
        />
      );
    case "testConnection":
      return <ConnectionRenderer args={args} state={state} result={result} title="Testing connection" />;
    case "listConnections":
      return <ConnectionRenderer args={args} state={state} result={result} title="Listing connections" />;
    case "listActiveConnections":
      return <ActiveConnectionsRenderer args={args} state={state} result={result} />;
    case "testActiveConnection":
      return <ConnectionRenderer args={args} state={state} result={result} title="Testing active connection" />;
    case "saveMemory":
      return <SaveMemoryRenderer args={args} state={state} result={result} />;
    case "recallMemories":
      return <RecallMemoriesRenderer args={args} state={state} result={result} />;
    default:
      return <GenericRenderer toolName={toolName} args={args} state={state} result={result} />;
  }
}

function getWorkflowDraftProgressEvents(
  streamData: unknown[] | undefined,
  toolCallId?: string
): WorkflowDraftProgressEvent[] {
  if (!toolCallId || !streamData?.length) {
    return [];
  }

  return streamData.filter(isWorkflowDraftProgressEvent).filter((event) => {
    return event.toolCallId === toolCallId;
  });
}

function getLatestDraftProgressByStage(
  progressEvents: WorkflowDraftProgressEvent[]
): Map<WorkflowDraftProgressStage, WorkflowDraftProgressEvent> {
  const latestByStage = new Map<
    WorkflowDraftProgressStage,
    WorkflowDraftProgressEvent
  >();

  for (const event of progressEvents) {
    latestByStage.set(event.stage, event);
  }

  return latestByStage;
}

type ResearchRenderResult = ResearchResult & {
  page?: NonNullable<ResearchResult["page"]>;
};

function getDomainLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function coerceString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeSearchResult(
  args: Record<string, unknown>,
  result: unknown
): ResearchRenderResult {
  const res = result as
    | {
        query?: string;
        results?: Array<{ title: string; url: string; snippet?: string }>;
        warnings?: string[];
        noUsefulResults?: boolean;
        error?: string;
      }
    | undefined;

  return {
    provider: "duckduckgo",
    mode: "search",
    query: coerceString(res?.query) || coerceString(args.query),
    results:
      res?.results?.map((entry) => ({
        title: entry.title,
        url: entry.url,
        snippet: entry.snippet || "",
        domain: getDomainLabel(entry.url),
        score: 0,
      })) || [],
    warnings: res?.warnings,
    noUsefulResults: res?.noUsefulResults,
    error: res?.error,
  };
}

function normalizeFetchResult(
  args: Record<string, unknown>,
  result: unknown
): ResearchRenderResult {
  const res = result as
    | {
        status?: number;
        contentType?: string;
        body?: string;
        finalUrl?: string;
        title?: string;
        excerpt?: string;
        warnings?: string[];
        error?: string;
      }
    | undefined;
  const body = coerceString(res?.body);
  const finalUrl = coerceString(res?.finalUrl) || coerceString(args.url);

  return {
    provider: "direct",
    mode: "scrape",
    warnings: res?.warnings,
    error: res?.error,
    page: {
      finalUrl,
      title: coerceString(res?.title) || finalUrl,
      status: typeof res?.status === "number" ? res.status : 0,
      contentType: coerceString(res?.contentType),
      excerpt: coerceString(res?.excerpt) || body.slice(0, 240),
      text: body,
      headings: [],
      links: [],
    },
  };
}

function ResearchWebRenderer({
  args,
  state,
  result,
}: {
  args: Record<string, unknown>;
  state: string;
  result: unknown;
}) {
  const res = (result || {}) as ResearchRenderResult;
  const mode =
    coerceString(args.mode) ||
    coerceString(res.mode) ||
    (res.page ? "scrape" : "search");
  const target =
    coerceString(args.query) ||
    coerceString(args.url) ||
    coerceString(res.query) ||
    coerceString(res.page?.finalUrl);
  const isScrape = mode === "scrape";
  const isResearch = mode === "research";
  const icon = isScrape ? Globe : Search;
  const iconColor = isScrape ? "text-blue-400" : "text-purple-400";
  const title = isScrape
    ? "Scraping page"
    : isResearch
      ? "Researching web"
      : "Searching web";

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 overflow-hidden my-2">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 text-xs">
        {icon === Globe ? (
          <Globe size={12} className={iconColor} />
        ) : (
          <Search size={12} className={iconColor} />
        )}
        <span className="text-zinc-400">{title}</span>
        <span className={`truncate font-mono ${isScrape ? "text-blue-300" : "text-purple-300"}`}>
          {target}
        </span>
        {res.provider ? (
          <span className="ml-auto rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
            {res.provider}
          </span>
        ) : null}
        {state === "call" && <Loader2 size={12} className="animate-spin text-zinc-500" />}
        {res.page?.status ? (
          <span
            className={`font-mono ${
              res.page.status >= 200 && res.page.status < 300
                ? "text-green-400"
                : "text-red-400"
            }`}
          >
            {res.page.status}
          </span>
        ) : null}
      </div>

      {res.error ? (
        <div className="px-3 py-2 text-xs text-red-400">{res.error}</div>
      ) : null}

      {res.warnings?.length ? (
        <div className="px-3 py-2 border-b border-zinc-800/80 space-y-1">
          {res.warnings.map((warning) => (
            <p key={warning} className="text-[11px] text-amber-300">
              {warning}
            </p>
          ))}
        </div>
      ) : null}

      {res.noUsefulResults ? (
        <div className="px-3 py-2 text-[11px] text-zinc-400">
          No strong documentation matches were found.
        </div>
      ) : null}

      {res.results?.length ? (
        <div className="px-3 py-2 space-y-2">
          {res.results.slice(0, 4).map((entry) => (
            <div
              key={entry.url}
              className="rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2"
            >
              <div className="flex items-start justify-between gap-3">
                <p className="text-xs font-medium text-white">{entry.title}</p>
                {entry.domain ? (
                  <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                    {entry.domain}
                  </span>
                ) : null}
              </div>
              <a
                href={entry.url}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-[11px] text-blue-400 hover:underline"
              >
                {entry.url}
                <ExternalLink size={10} />
              </a>
              {entry.snippet ? (
                <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                  {entry.snippet}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {res.page ? (
        <div className="border-t border-zinc-800 px-3 py-2 space-y-2">
          <div>
            <p className="text-xs font-medium text-white">
              {res.page.title || res.page.finalUrl}
            </p>
            {res.page.finalUrl ? (
              <a
                href={res.page.finalUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-[11px] text-blue-400 hover:underline"
              >
                {res.page.finalUrl}
                <ExternalLink size={10} />
              </a>
            ) : null}
          </div>

          {res.page.excerpt ? (
            <p className="text-[11px] leading-relaxed text-zinc-400">
              {res.page.excerpt}
            </p>
          ) : null}

          {res.page.headings?.length ? (
            <div className="flex flex-wrap gap-1">
              {res.page.headings.slice(0, 4).map((heading) => (
                <span
                  key={heading}
                  className="rounded bg-zinc-800 px-2 py-1 text-[10px] text-zinc-300"
                >
                  {heading}
                </span>
              ))}
            </div>
          ) : null}

          {res.page.text ? (
            <div className="max-h-48 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950/70 p-3">
              <pre className="text-xs text-zinc-400 whitespace-pre-wrap font-mono leading-relaxed">
                {res.page.text.slice(0, 2000)}
                {res.page.text.length > 2000 && "..."}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SearchResultsRenderer({
  args,
  state,
  result,
}: {
  args: Record<string, unknown>;
  state: string;
  result: unknown;
}) {
  return (
    <ResearchWebRenderer
      args={{ ...args, mode: "search" }}
      state={state}
      result={normalizeSearchResult(args, result)}
    />
  );
}

function FetchUrlRenderer({
  args,
  state,
  result,
}: {
  args: Record<string, unknown>;
  state: string;
  result: unknown;
}) {
  return (
    <ResearchWebRenderer
      args={{ ...args, mode: "scrape" }}
      state={state}
      result={normalizeFetchResult(args, result)}
    />
  );
}

function CommandRenderer({
  args,
  state,
  result,
}: {
  args: Record<string, unknown>;
  state: string;
  result: unknown;
}) {
  const res = result as { exitCode?: number; stdout?: string; stderr?: string } | undefined;
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden my-2">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 text-xs">
        <Terminal size={12} className="text-green-400" />
        <span className="text-zinc-500 font-mono">$</span>
        <span className="text-green-300 font-mono truncate">{String(args.command || "")}</span>
        {state === "call" && <Loader2 size={12} className="animate-spin text-zinc-500 ml-auto" />}
        {res && res.exitCode !== undefined && (
          <span
            className={`ml-auto text-[10px] rounded px-1.5 py-0.5 font-mono ${
              res.exitCode === 0
                ? "bg-green-900/40 text-green-400"
                : "bg-red-900/40 text-red-400"
            }`}
          >
            exit {res.exitCode}
          </span>
        )}
      </div>
      {(res?.stdout || res?.stderr) && (
        <div className="px-3 py-2 max-h-64 overflow-y-auto">
          {res.stdout && (
            <pre className="text-xs text-green-300/80 whitespace-pre-wrap font-mono leading-relaxed">
              {res.stdout.slice(0, 4000)}
              {res.stdout.length > 4000 && "\n... (output truncated)"}
            </pre>
          )}
          {res.stderr && (
            <pre className="text-xs text-red-400/80 whitespace-pre-wrap font-mono leading-relaxed mt-1">
              {res.stderr.slice(0, 2000)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function CatalogLookupRenderer({
  args,
  state,
  result,
}: {
  args: Record<string, unknown>;
  state: string;
  result: unknown;
}) {
  const res = result as { found?: boolean; name?: string; authType?: string; message?: string } | undefined;
  return (
    <div className="flex items-center gap-2 my-2 text-xs">
      <Search size={12} className="text-purple-400" />
      <span className="text-zinc-400">Looking up</span>
      <span className="text-purple-400 font-mono">{String(args.slug || "")}</span>
      {state === "call" && <Loader2 size={12} className="animate-spin text-zinc-500" />}
      {res?.found && (
        <span className="text-green-400">
          Found: {res.name} ({res.authType})
        </span>
      )}
      {res && !res.found && <span className="text-zinc-500">{res.message}</span>}
    </div>
  );
}

function IntegrationReferenceRenderer({
  args,
  state,
  result,
}: {
  args: Record<string, unknown>;
  state: string;
  result: unknown;
}) {
  const res = result as {
    name?: string;
    slug?: string;
    docsUrl?: string | null;
    testEndpoint?: string | null;
    apiSchema?: { endpoints?: unknown[] } | null;
    error?: string;
  } | undefined;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 overflow-hidden my-2">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 text-xs">
        <Link2 size={12} className="text-blue-400" />
        <span className="text-zinc-400">Provider reference</span>
        <span className="font-mono text-white">{String(args.providerSlug || res?.slug || "")}</span>
        {state === "call" && <Loader2 size={12} className="animate-spin text-zinc-500 ml-auto" />}
      </div>
      {res?.error ? (
        <div className="px-3 py-2 text-xs text-red-400">{res.error}</div>
      ) : (
        <div className="px-3 py-2 space-y-1 text-xs text-zinc-400">
          <p className="text-white">{res?.name || res?.slug}</p>
          <p>Docs: {res?.docsUrl ? "available" : "not set"}</p>
          <p>Test endpoint: {res?.testEndpoint || "not set"}</p>
          <p>
            API schema endpoints: {Array.isArray(res?.apiSchema?.endpoints) ? res?.apiSchema?.endpoints.length : 0}
          </p>
        </div>
      )}
    </div>
  );
}

function ConfigRenderer({
  args,
  state,
  result,
  title,
}: {
  args: Record<string, unknown>;
  state: string;
  result: unknown;
  title: string;
}) {
  const res = result as { valid?: boolean; errors?: string[] } | undefined;
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 overflow-hidden my-2">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 text-xs">
        <FileJson size={12} className="text-yellow-400" />
        <span className="text-zinc-400">{title}</span>
        {state === "call" && <Loader2 size={12} className="animate-spin text-zinc-500 ml-auto" />}
        {res?.valid !== undefined && (
          res.valid ? (
            <CheckCircle size={12} className="text-green-400 ml-auto" />
          ) : (
            <XCircle size={12} className="text-red-400 ml-auto" />
          )
        )}
      </div>
      <div className="px-3 py-2 max-h-48 overflow-y-auto">
        <pre className="text-xs text-zinc-400 whitespace-pre-wrap font-mono">
          {JSON.stringify(args, null, 2)}
        </pre>
      </div>
      {res?.errors && res.errors.length > 0 && (
        <div className="px-3 py-2 border-t border-zinc-800">
          {res.errors.map((e, i) => (
            <p key={i} className="text-xs text-red-400">{e}</p>
          ))}
        </div>
      )}
    </div>
  );
}

function SaveResultRenderer({
  args,
  state,
  result,
}: {
  args: Record<string, unknown>;
  state: string;
  result: unknown;
}) {
  const res = result as { id?: string; slug?: string; name?: string; error?: string } | undefined;
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 overflow-hidden my-2">
      <div className="flex items-center gap-2 px-3 py-2 text-xs">
        <Save size={12} className="text-blue-400" />
        <span className="text-zinc-400">Saving provider</span>
        <span className="text-white font-medium">{String(args.name || args.slug || "")}</span>
        {state === "call" && <Loader2 size={12} className="animate-spin text-zinc-500 ml-auto" />}
        {res?.id && <CheckCircle size={12} className="text-green-400 ml-auto" />}
        {res?.error && <XCircle size={12} className="text-red-400 ml-auto" />}
      </div>
      {res?.error && <p className="px-3 pb-2 text-xs text-red-400">{res.error}</p>}
      {res?.id && (
        <p className="px-3 pb-2 text-xs text-green-400">
          Saved as {res.slug} (ID: {res.id})
        </p>
      )}
    </div>
  );
}

function ConnectionRenderer({
  args,
  state,
  result,
  title,
}: {
  args: Record<string, unknown>;
  state: string;
  result: unknown;
  title: string;
}) {
  const res = result as Record<string, unknown> | undefined;
  const hasError = res && ("error" in res);
  return (
    <div className="flex items-center gap-2 my-2 text-xs">
      <Link2 size={12} className="text-blue-400" />
      <span className="text-zinc-400">{title}</span>
      {args.provider ? <span className="text-white font-mono">{String(args.provider)}</span> : null}
      {state === "call" && <Loader2 size={12} className="animate-spin text-zinc-500" />}
      {res && !hasError && <CheckCircle size={12} className="text-green-400" />}
      {hasError && (
        <>
          <XCircle size={12} className="text-red-400" />
          <span className="text-red-400">{String(res?.error || "")}</span>
        </>
      )}
    </div>
  );
}

function OAuthStartRenderer({
  args,
  state,
  result,
  onComplete,
}: {
  args: Record<string, unknown>;
  state: string;
  result: unknown;
  onComplete?: (payload: OAuthCompletionPayload) => void;
}) {
  const res = result as
    | {
        authorize_url?: string;
        redirect_uri?: string;
        service_slugs?: string[];
        error?: string;
      }
    | undefined;
  const providerSlug =
    typeof args.provider === "string" && args.provider.length > 0
      ? args.provider
      : "provider";
  const [status, setStatus] = useState<"idle" | "waiting" | "connected" | "error">(
    "idle"
  );
  const [errorMessage, setErrorMessage] = useState("");
  const popupRef = useRef<Window | null>(null);
  const completedRef = useRef(false);
  const startedAtRef = useRef<number | null>(null);
  const authOrigin = useMemo(() => {
    try {
      return new URL(
        process.env.NEXT_PUBLIC_AUTH_URL || "http://localhost:4000"
      ).origin;
    } catch {
      return null;
    }
  }, []);
  const expectedProviders = useMemo(() => {
    const serviceSlugs = Array.isArray(res?.service_slugs)
      ? res.service_slugs.filter(
          (slug): slug is string => typeof slug === "string" && slug.length > 0
        )
      : [];
    return new Set(
      serviceSlugs.length > 0
        ? serviceSlugs
        : [providerSlug].filter((slug) => slug.length > 0)
    );
  }, [providerSlug, res?.service_slugs]);

  useEffect(() => {
    if (status !== "waiting") {
      return;
    }

    const handleMessage = (event: MessageEvent) => {
      if (authOrigin && event.origin !== authOrigin) {
        return;
      }

      const data = event.data as
        | ({
            type?: string;
            error?: string;
          } & OAuthCompletionPayload)
        | undefined;

      if (!data?.type) {
        return;
      }

      const providers = Array.isArray(data.providers)
        ? data.providers.filter(
            (slug): slug is string => typeof slug === "string" && slug.length > 0
          )
        : [data.provider].filter(
            (slug): slug is string => typeof slug === "string" && slug.length > 0
          );

      const matchesExpectedProvider =
        expectedProviders.size === 0 ||
        providers.length === 0 ||
        providers.some((slug) => expectedProviders.has(slug));

      if (!matchesExpectedProvider) {
        return;
      }

      if (data.type === "OAUTH_SUCCESS") {
        completedRef.current = true;
        popupRef.current?.close();
        popupRef.current = null;
        setStatus("connected");
        setErrorMessage("");
        onComplete?.(data);
      }

      if (data.type === "OAUTH_ERROR") {
        completedRef.current = true;
        popupRef.current?.close();
        popupRef.current = null;
        setStatus("error");
        setErrorMessage(data.error || "OAuth flow failed.");
      }
    };

    const pollClosed = window.setInterval(() => {
      if (popupRef.current && popupRef.current.closed && !completedRef.current) {
        popupRef.current = null;
        setStatus("idle");
      }
    }, 500);

    const pollConnections = window.setInterval(async () => {
      if (completedRef.current || expectedProviders.size === 0) {
        return;
      }

      try {
        const startedAt = startedAtRef.current ?? Date.now() - 60_000;
        const connections = (await api.getConnections()) as Array<{
          id: string;
          createdAt?: string;
          updatedAt?: string;
          provider?: { slug?: string };
        }>;

        const matched = connections.filter((connection) => {
          const slug = connection.provider?.slug;
          if (!slug || !expectedProviders.has(slug)) {
            return false;
          }

          const changedAt = new Date(
            connection.updatedAt || connection.createdAt || 0
          ).getTime();

          return Number.isFinite(changedAt) && changedAt >= startedAt - 1_000;
        });

        if (matched.length > 0) {
          completedRef.current = true;
          popupRef.current?.close();
          popupRef.current = null;
          setStatus("connected");
          setErrorMessage("");
          onComplete?.({
            connectionIds: matched.map((connection) => connection.id),
            providers: matched
              .map((connection) => connection.provider?.slug)
              .filter((slug): slug is string => typeof slug === "string"),
          });
        }
      } catch {
        // Ignore transient polling failures and keep waiting.
      }
    }, 1000);

    window.addEventListener("message", handleMessage);
    return () => {
      window.clearInterval(pollClosed);
      window.clearInterval(pollConnections);
      window.removeEventListener("message", handleMessage);
    };
  }, [authOrigin, expectedProviders, onComplete, status]);

  const handleAuthorize = () => {
    if (!res?.authorize_url) {
      return;
    }

    completedRef.current = false;
    startedAtRef.current = Date.now();
    setErrorMessage("");

    const popup = window.open(
      res.authorize_url,
      "oauth",
      "popup=yes,width=620,height=760,scrollbars=yes,resizable=yes"
    );

    if (!popup) {
      setStatus("error");
      setErrorMessage("Popup blocked. Allow popups and try again.");
      return;
    }

    popupRef.current = popup;
    setStatus("waiting");
  };

  const actionLabel =
    status === "connected"
      ? "Authorized"
      : status === "waiting"
        ? "Waiting..."
        : status === "error"
          ? "Try again"
          : "Authorize";
  const actionDisabled = status === "connected" || status === "waiting";

  if (state === "call") {
    return (
      <div className="flex items-center gap-2 my-2 text-xs">
        <Link2 size={12} className="text-blue-400" />
        <span className="text-zinc-400">Starting OAuth</span>
        <span className="text-white font-mono">{providerSlug}</span>
        <Loader2 size={12} className="animate-spin text-zinc-500" />
      </div>
    );
  }

  if (res?.error) {
    return (
      <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-300">
        <div className="flex items-center gap-2">
          <XCircle size={12} className="text-red-400" />
          <span className="font-medium">OAuth setup failed for {providerSlug}</span>
        </div>
        <p className="mt-2 text-red-200/80">{res.error}</p>
      </div>
    );
  }

  if (!res?.authorize_url) {
    return (
      <div className="flex items-center gap-2 my-2 text-xs text-zinc-500">
        <Link2 size={12} className="text-blue-400" />
        <span>OAuth is ready, but no authorize URL was returned.</span>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 my-2 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-white">Authorize {providerSlug}</p>
          <p className="mt-1 text-xs leading-relaxed text-zinc-400">
            Launch the consent screen in a popup. When you finish there, this chat
            will resume automatically.
          </p>
        </div>
        <button
          type="button"
          onClick={handleAuthorize}
          disabled={actionDisabled}
          className="shrink-0 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-400"
        >
          {actionLabel}
        </button>
      </div>

      {status === "waiting" ? (
        <div className="flex items-center gap-2 rounded-md border border-blue-500/20 bg-blue-500/10 px-3 py-2 text-xs text-blue-200">
          <Loader2 size={12} className="animate-spin text-blue-300" />
          <span>Waiting for the OAuth popup to finish…</span>
        </div>
      ) : null}

      {status === "connected" ? (
        <div className="flex items-center gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
          <CheckCircle size={12} className="text-emerald-300" />
          <span>Connected. The agent is continuing the setup here in chat.</span>
        </div>
      ) : null}

      {status === "error" && errorMessage ? (
        <div className="flex items-center gap-2 rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          <XCircle size={12} className="text-red-300" />
          <span>{errorMessage}</span>
        </div>
      ) : null}

      {Array.isArray(res.service_slugs) && res.service_slugs.length > 1 ? (
        <p className="text-[11px] text-zinc-500">
          This flow will connect: {res.service_slugs.join(", ")}
        </p>
      ) : null}
    </div>
  );
}

function ActiveConnectionsRenderer({
  state,
  result,
}: {
  args: Record<string, unknown>;
  state: string;
  result: unknown;
}) {
  const res = result as {
    connections?: Array<{
      id: string;
      label?: string | null;
      provider: { slug: string; name: string };
    }>;
  } | undefined;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 overflow-hidden my-2">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 text-xs">
        <Link2 size={12} className="text-blue-400" />
        <span className="text-zinc-400">Active connections</span>
        {state === "call" && <Loader2 size={12} className="animate-spin text-zinc-500 ml-auto" />}
        {res?.connections ? (
          <span className="ml-auto text-[10px] text-zinc-500">
            {res.connections.length}
          </span>
        ) : null}
      </div>
      {res?.connections?.length ? (
        <div className="px-3 py-2 space-y-1">
          {res.connections.slice(0, 6).map((connection) => (
            <p key={connection.id} className="text-xs text-zinc-400">
              <span className="font-mono text-white">
                {connection.provider.slug}
              </span>{" "}
              {connection.label ? `· ${connection.label}` : ""}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ProjectSearchRenderer({
  args,
  state,
  result,
}: {
  args: Record<string, unknown>;
  state: string;
  result: unknown;
}) {
  const res = result as {
    matches?: Array<{ path: string; line: number; preview: string }>;
    error?: string;
  } | undefined;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 overflow-hidden my-2">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 text-xs">
        <Search size={12} className="text-yellow-400" />
        <span className="text-zinc-400">Searching project</span>
        <span className="truncate font-mono text-yellow-300">
          {String(args.query || "")}
        </span>
        {state === "call" && <Loader2 size={12} className="animate-spin text-zinc-500 ml-auto" />}
      </div>
      {res?.error ? (
        <div className="px-3 py-2 text-xs text-red-400">{res.error}</div>
      ) : null}
      {res?.matches?.length ? (
        <div className="px-3 py-2 space-y-2">
          {res.matches.slice(0, 6).map((match) => (
            <div key={`${match.path}:${match.line}`} className="rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2">
              <p className="text-[11px] font-mono text-blue-300">{match.path}:{match.line}</p>
              <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                {match.preview}
              </p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ProjectFileRenderer({
  args,
  state,
  result,
}: {
  args: Record<string, unknown>;
  state: string;
  result: unknown;
}) {
  const res = result as { path?: string; content?: string; error?: string } | undefined;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 overflow-hidden my-2">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 text-xs">
        <FileJson size={12} className="text-yellow-400" />
        <span className="text-zinc-400">Reading project file</span>
        <span className="truncate font-mono text-yellow-300">
          {String(args.path || res?.path || "")}
        </span>
        {state === "call" && <Loader2 size={12} className="animate-spin text-zinc-500 ml-auto" />}
      </div>
      {res?.error ? (
        <div className="px-3 py-2 text-xs text-red-400">{res.error}</div>
      ) : null}
      {res?.content ? (
        <div className="px-3 py-2 max-h-56 overflow-y-auto">
          <pre className="text-xs whitespace-pre-wrap font-mono leading-relaxed text-zinc-400">
            {res.content.slice(0, 4000)}
            {res.content.length > 4000 ? "\n... (output truncated)" : ""}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function DraftRenderer({
  state,
  result,
  title,
  toolCallId,
  streamData,
}: {
  args: Record<string, unknown>;
  state: string;
  result: unknown;
  title: string;
  toolCallId?: string;
  streamData?: unknown[];
}) {
  const res = result as {
    assistantMessage?: string;
    artifact?: { title?: string; slug?: string; summary?: string; code?: string };
    blockedAccesses?: unknown[];
    hasDraft?: boolean;
    message?: string;
    error?: string;
  } | undefined;
  const hasRenderableArtifact = Boolean(
    !res?.error && res?.artifact?.code?.trim()
  );
  const isRunning = state === "call" || state === "partial-call";
  const progressEvents = useMemo(
    () => getWorkflowDraftProgressEvents(streamData, toolCallId),
    [streamData, toolCallId]
  );
  const latestByStage = useMemo(
    () => getLatestDraftProgressByStage(progressEvents),
    [progressEvents]
  );
  const stageStates = useMemo(
    () =>
      WORKFLOW_DRAFT_PROGRESS_STAGES.map((stage) => {
        const event = latestByStage.get(stage);
        return {
          stage,
          event,
          label: event?.label || WORKFLOW_DRAFT_PROGRESS_LABELS[stage],
        };
      }),
    [latestByStage]
  );
  const activeStageIndex = stageStates.findIndex(({ event }) => {
    return event?.status === "started" || event?.status === "update";
  });
  const blockedStageIndex = stageStates.findIndex(
    ({ event }) => event?.status === "blocked"
  );
  const failedStageIndex = stageStates.findIndex(
    ({ event }) => event?.status === "failed"
  );
  const completedCount = stageStates.filter(
    ({ event }) => event?.status === "completed"
  ).length;
  const currentIndex =
    activeStageIndex >= 0
      ? activeStageIndex
      : blockedStageIndex >= 0
        ? blockedStageIndex
        : failedStageIndex >= 0
          ? failedStageIndex
          : Math.min(completedCount, stageStates.length - 1);
  const currentEvent =
    stageStates[currentIndex]?.event ||
    (progressEvents.length > 0 ? progressEvents[progressEvents.length - 1] : undefined);
  const statusLabel =
    blockedStageIndex >= 0
      ? "Needs attention"
      : failedStageIndex >= 0
        ? "Failed"
        : `Step ${Math.min(currentIndex + 1, stageStates.length)} of ${stageStates.length}`;
  const currentAttemptLabel =
    currentEvent?.attempt && currentEvent?.totalAttempts
      ? `Attempt ${currentEvent.attempt} of ${currentEvent.totalAttempts}`
      : null;

  if (isRunning) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 overflow-hidden my-2">
        <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2 text-xs">
          <FileJson size={12} className="text-blue-400" />
          <span className="text-zinc-300">{title}</span>
          <span
            className={
              blockedStageIndex >= 0
                ? "ml-auto text-amber-300"
                : failedStageIndex >= 0
                  ? "ml-auto text-red-300"
                  : "ml-auto text-zinc-500"
            }
          >
            {statusLabel}
          </span>
        </div>
        <div className="space-y-3 px-3 py-3">
          <div className="rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2">
            <div className="flex items-center gap-2 text-[11px] text-zinc-400">
              {blockedStageIndex >= 0 ? (
                <XCircle size={12} className="text-amber-400" />
              ) : failedStageIndex >= 0 ? (
                <XCircle size={12} className="text-red-400" />
              ) : (
                <Loader2 size={12} className="animate-spin text-blue-400" />
              )}
              <span>{currentEvent?.detail || "Starting draft generation..."}</span>
            </div>
            {currentAttemptLabel ? (
              <p className="mt-1 text-[11px] text-zinc-500">
                {currentAttemptLabel}
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            {stageStates.map(({ stage, label, event }, index) => {
              const isBlocked = event?.status === "blocked";
              const isFailed = event?.status === "failed";
              const isCompleted = event?.status === "completed";
              const isActive =
                (!isBlocked && !isFailed && !isCompleted && index === currentIndex) ||
                event?.status === "started" ||
                event?.status === "update";
              const rowToneClassName = isCompleted
                ? "border-emerald-900/40 bg-emerald-950/20"
                : isBlocked
                  ? "border-amber-900/40 bg-amber-950/20"
                  : isFailed
                    ? "border-red-900/40 bg-red-950/20"
                    : isActive
                      ? "border-blue-900/40 bg-blue-950/20"
                      : "border-zinc-800 bg-zinc-950/40";
              const labelToneClassName = isCompleted
                ? "text-emerald-100"
                : isBlocked
                  ? "text-amber-100"
                  : isFailed
                    ? "text-red-100"
                    : isActive
                      ? "text-blue-100"
                      : "text-zinc-400";
              const detailToneClassName = isCompleted
                ? "text-emerald-300/80"
                : isBlocked
                  ? "text-amber-300/80"
                  : isFailed
                    ? "text-red-300/80"
                    : isActive
                      ? "text-blue-200/80"
                      : "text-zinc-500";

              return (
                <div
                  key={stage}
                  className={`rounded-md border px-3 py-2 ${rowToneClassName}`}
                >
                  <div className="flex items-center gap-2">
                    {isCompleted ? (
                      <CheckCircle size={13} className="shrink-0 text-emerald-400" />
                    ) : isBlocked ? (
                      <XCircle size={13} className="shrink-0 text-amber-400" />
                    ) : isFailed ? (
                      <XCircle size={13} className="shrink-0 text-red-400" />
                    ) : isActive ? (
                      <Loader2 size={13} className="shrink-0 animate-spin text-blue-400" />
                    ) : (
                      <span className="h-2 w-2 shrink-0 rounded-full bg-zinc-700" />
                    )}
                    <span className={`text-xs font-medium ${labelToneClassName}`}>
                      {label}
                    </span>
                  </div>
                  {event?.detail ? (
                    <p className={`mt-1 pl-5 text-[11px] ${detailToneClassName}`}>
                      {event.detail}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 overflow-hidden my-2">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 text-xs">
        <FileJson size={12} className="text-blue-400" />
        <span className="text-zinc-400">{title}</span>
        {state === "call" && <Loader2 size={12} className="animate-spin text-zinc-500 ml-auto" />}
        {res?.error ? <XCircle size={12} className="text-red-400 ml-auto" /> : null}
        {!res?.error && hasRenderableArtifact ? (
          <CheckCircle size={12} className="text-green-400 ml-auto" />
        ) : null}
      </div>
      <div className="px-3 py-2 space-y-1 text-xs text-zinc-400">
        {hasRenderableArtifact ? (
          <>
            <p className="text-white">{res?.artifact?.title}</p>
            <p className="font-mono text-zinc-500">{res?.artifact?.slug}</p>
            <p>{res?.artifact?.summary}</p>
          </>
        ) : null}
        {res?.error ? <p className="text-red-400">{res.error}</p> : null}
        {res?.assistantMessage ? <p>{res.assistantMessage}</p> : null}
        {!res?.artifact && res?.message ? <p>{res.message}</p> : null}
        {Array.isArray(res?.blockedAccesses) && res.blockedAccesses.length > 0 ? (
          <p className="text-amber-300">
            Blocked accesses: {res.blockedAccesses.length}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ValidationRenderer({
  state,
  result,
}: {
  args: Record<string, unknown>;
  state: string;
  result: unknown;
}) {
  const res = result as {
    validation?: { ok?: boolean; issues?: Array<{ message: string }> };
    error?: string;
  } | undefined;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 overflow-hidden my-2">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 text-xs">
        <FileJson size={12} className="text-yellow-400" />
        <span className="text-zinc-400">Validating draft</span>
        {state === "call" && <Loader2 size={12} className="animate-spin text-zinc-500 ml-auto" />}
        {res?.validation?.ok === true ? (
          <CheckCircle size={12} className="text-green-400 ml-auto" />
        ) : null}
        {res?.validation?.ok === false || res?.error ? (
          <XCircle size={12} className="text-red-400 ml-auto" />
        ) : null}
      </div>
      {res?.error ? (
        <div className="px-3 py-2 text-xs text-red-400">{res.error}</div>
      ) : null}
      {res?.validation?.issues?.length ? (
        <div className="px-3 py-2 space-y-1">
          {res.validation.issues.slice(0, 6).map((issue, index) => (
            <p key={index} className="text-xs text-red-400">
              {issue.message}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PreviewRenderer({
  state,
  result,
}: {
  args: Record<string, unknown>;
  state: string;
  result: unknown;
}) {
  const res = result as {
    preview?: {
      status?: string;
      error?: string;
      pendingApproval?: { checkpoint?: string; target?: string };
    };
    assistantMessage?: string;
    error?: string;
  } | undefined;
  const preview = res?.preview;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 overflow-hidden my-2">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 text-xs">
        <Globe size={12} className="text-blue-400" />
        <span className="text-zinc-400">Previewing draft</span>
        {state === "call" && <Loader2 size={12} className="animate-spin text-zinc-500 ml-auto" />}
        {preview?.status === "success" ? (
          <CheckCircle size={12} className="text-green-400 ml-auto" />
        ) : null}
        {preview?.status === "needs_approval" ? (
          <AlertCircle size={12} className="text-amber-400 ml-auto" />
        ) : null}
        {preview?.status === "error" || res?.error ? (
          <XCircle size={12} className="text-red-400 ml-auto" />
        ) : null}
      </div>
      <div className="px-3 py-2 space-y-1 text-xs text-zinc-400">
        {res?.error ? <p className="text-red-400">{res.error}</p> : null}
        {preview?.status ? <p>Status: {preview.status}</p> : null}
        {preview?.error ? <p className="text-red-400">{preview.error}</p> : null}
        {res?.assistantMessage ? <p>{res.assistantMessage}</p> : null}
        {preview?.pendingApproval ? (
          <p className="text-amber-300">
            Waiting for approval: {preview.pendingApproval.checkpoint} → {preview.pendingApproval.target}. More declared checkpoints may appear after this one is approved.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function BuildRenderer({
  state,
  result,
}: {
  args: Record<string, unknown>;
  state: string;
  result: unknown;
}) {
  const res = result as {
    build?: {
      status?: string;
      provider?: string;
      region?: string;
      gcpProject?: string;
      builtAt?: string;
      error?: string;
      artifact?: {
        workflowId?: string;
        artifactPath?: string;
        imageUri?: string;
      };
      preview?: {
        status?: string;
        pendingApproval?: { checkpoint?: string; target?: string };
      };
    };
    assistantMessage?: string;
    skipped?: boolean;
    error?: string;
  } | undefined;
  const build = res?.build;
  const previewStatus = build?.preview?.status;
  const needsApproval = previewStatus === "needs_approval";
  const showSuccess = build?.status === "success" && !needsApproval;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 overflow-hidden my-2">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 text-xs">
        <Package size={12} className="text-blue-400" />
        <span className="text-zinc-400">Building draft</span>
        {state === "call" && <Loader2 size={12} className="animate-spin text-zinc-500 ml-auto" />}
        {showSuccess ? (
          <CheckCircle size={12} className="text-green-400 ml-auto" />
        ) : null}
        {res?.skipped || needsApproval ? (
          <AlertCircle size={12} className="text-amber-400 ml-auto" />
        ) : null}
        {build?.status === "error" || res?.error ? (
          <XCircle size={12} className="text-red-400 ml-auto" />
        ) : null}
      </div>
      <div className="px-3 py-2 space-y-1 text-xs text-zinc-400">
        {build?.status ? <p>Status: {build.status}</p> : null}
        {previewStatus ? <p>Preview during build: {previewStatus}</p> : null}
        {build?.provider ? <p>Provider: {String(build.provider).toUpperCase()}</p> : null}
        {build?.artifact?.workflowId ? <p>Workflow: {build.artifact.workflowId}</p> : null}
        {build?.artifact?.artifactPath ? (
          <p className="break-all">Artifact: {build.artifact.artifactPath}</p>
        ) : null}
        {build?.artifact?.imageUri ? (
          <p className="break-all">Image: {build.artifact.imageUri}</p>
        ) : null}
        {build?.error ? <p className="text-red-400">{build.error}</p> : null}
        {res?.error ? <p className="text-red-400">{res.error}</p> : null}
        {res?.assistantMessage ? <p>{res.assistantMessage}</p> : null}
        {build?.preview?.pendingApproval ? (
          <p className="text-amber-300">
            Waiting for approval: {build.preview.pendingApproval.checkpoint} → {build.preview.pendingApproval.target}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function SaveMemoryRenderer({
  args,
  state,
  result,
}: {
  args: Record<string, unknown>;
  state: string;
  result: unknown;
}) {
  const content = String(args.content || "");
  const category = String(args.category || "general");
  const scope = String(args.scope || "app");
  const res = result as { saved?: boolean; id?: string; error?: string } | undefined;

  return (
    <div className="rounded-lg border border-purple-800/50 bg-purple-950/20 overflow-hidden my-2">
      <div className="flex items-center gap-2 px-3 py-2 text-xs">
        <Brain size={12} className="text-purple-400" />
        <span className="text-purple-300 font-medium">
          {state === "call" ? "Saving to memory..." : "Saved to memory"}
        </span>
        <span className="rounded bg-purple-900/40 px-1.5 py-0.5 text-[10px] text-purple-300">
          {category}
        </span>
        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
          {scope}
        </span>
        {state === "call" && (
          <Loader2 size={12} className="animate-spin text-purple-400 ml-auto" />
        )}
        {res?.saved && (
          <CheckCircle size={12} className="text-purple-400 ml-auto" />
        )}
        {res?.error && <XCircle size={12} className="text-red-400 ml-auto" />}
      </div>
      <div className="px-3 pb-2 text-xs text-zinc-300">
        {content.length > 150 ? content.slice(0, 150) + "..." : content}
      </div>
      {res?.error && (
        <p className="px-3 pb-2 text-xs text-red-400">{res.error}</p>
      )}
    </div>
  );
}

function RecallMemoriesRenderer({
  args,
  state,
  result,
}: {
  args: Record<string, unknown>;
  state: string;
  result: unknown;
}) {
  const query = String(args.query || "");
  const res = result as
    | { count?: number; error?: string; memories?: unknown[] }
    | undefined;

  return (
    <div className="flex items-center gap-2 my-2 px-3 py-2 rounded-lg border border-purple-800/30 bg-purple-950/10 text-xs">
      <Brain size={12} className="text-purple-400 shrink-0" />
      <span className="text-zinc-400">Recalling memories</span>
      <span className="text-purple-300 font-mono truncate max-w-[200px]">
        {query}
      </span>
      {state === "call" && (
        <Loader2 size={12} className="animate-spin text-purple-400 ml-auto shrink-0" />
      )}
      {res && !res.error && (
        <span className="text-purple-300 ml-auto shrink-0">
          {res.count || 0} found
        </span>
      )}
      {res?.error && (
        <span className="text-red-400 ml-auto shrink-0">{res.error}</span>
      )}
    </div>
  );
}

function GenericRenderer({
  toolName,
  args,
  state,
  result,
}: {
  toolName: string;
  args: Record<string, unknown>;
  state: string;
  result: unknown;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 overflow-hidden my-2">
      <div className="flex items-center gap-2 px-3 py-2 text-xs">
        <Terminal size={12} className="text-zinc-500" />
        <span className="text-zinc-400">{toolName}</span>
        {state === "call" && <Loader2 size={12} className="animate-spin text-zinc-500 ml-auto" />}
      </div>
      {result ? (
        <div className="px-3 py-2 max-h-32 overflow-y-auto">
          <pre className="text-xs text-zinc-400 whitespace-pre-wrap font-mono">
            {JSON.stringify(result, null, 2).slice(0, 1000)}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
