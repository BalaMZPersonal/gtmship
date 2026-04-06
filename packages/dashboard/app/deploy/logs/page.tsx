"use client";

import {
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Cloud, Loader2, RefreshCw, ScrollText, Search } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import {
  getScopedWorkflowDeployments,
  loadCloudDeploySettings,
  resolveCloudProvider,
  resolvePreferredCloudProvider,
  resolveSelectedExecutionName,
  resolveSelectedWorkflowDeploymentId,
  type CloudProvider,
  type WorkflowDeploymentLogEntry,
  type WorkflowDeploymentOverview,
} from "@/lib/deploy";

const timeRanges = [
  { value: "1h", label: "Last 1h" },
  { value: "6h", label: "Last 6h" },
  { value: "24h", label: "Last 24h" },
  { value: "7d", label: "Last 7d" },
];

const cloudProviders: CloudProvider[] = ["aws", "gcp", "local"];

const CLOUD_PROVIDER_LABELS: Record<CloudProvider, string> = {
  aws: "AWS",
  gcp: "Google Cloud",
  local: "Local Machine",
};

const fieldClassName =
  "w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm text-white outline-none transition-colors placeholder:text-zinc-600 focus:border-blue-500";

const levelColors: Record<string, string> = {
  info: "border-emerald-900/80 bg-emerald-950/40 text-emerald-300",
  warn: "border-amber-900/80 bg-amber-950/40 text-amber-200",
  error: "border-red-900/80 bg-red-950/40 text-red-200",
};

function SectionEyebrow({
  icon,
  children,
}: {
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/80 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.2em] text-zinc-400">
      {icon}
      {children}
    </div>
  );
}

function StatusBanner({
  tone,
  children,
}: {
  tone: "error" | "warning";
  children: ReactNode;
}) {
  const className =
    tone === "error"
      ? "border-red-900/40 bg-red-950/20 text-red-200"
      : "border-amber-900/40 bg-amber-950/20 text-amber-100";

  return (
    <div className={`rounded-xl border px-4 py-3 text-sm ${className}`}>
      {children}
    </div>
  );
}

function formatDateTime(value?: string | null): string {
  if (!value) {
    return "N/A";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function describeDeployment(deployment: WorkflowDeploymentOverview): string {
  const computeType =
    deployment.provider === "local"
      ? "Local Workflow Job"
      : deployment.provider === "aws" ||
          deployment.platform?.computeType === "lambda"
      ? "Lambda Function"
      : deployment.platform?.computeType === "job"
        ? "Cloud Run Job"
        : "Cloud Run Service";
  const computeName = deployment.platform?.computeName || "unknown";
  return `${deployment.workflowId} • ${computeType} (${computeName})`;
}

function normalizeLegacyLogEntries(
  response: unknown
): WorkflowDeploymentLogEntry[] {
  const record =
    typeof response === "object" && response !== null
      ? (response as Record<string, unknown>)
      : {};
  const candidates = Array.isArray(record.entries)
    ? record.entries
    : Array.isArray(record.logs)
      ? record.logs
      : [];

  return candidates.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const structured = entry as Record<string, unknown>;
    if (
      typeof structured.timestamp === "string" &&
      typeof structured.level === "string" &&
      typeof structured.message === "string"
    ) {
      return [
        {
          timestamp: structured.timestamp,
          level:
            structured.level === "warn" || structured.level === "error"
              ? structured.level
              : "info",
          message: structured.message,
          executionName:
            typeof structured.executionName === "string"
              ? structured.executionName
              : null,
          requestId:
            typeof structured.requestId === "string"
              ? structured.requestId
              : null,
        } satisfies WorkflowDeploymentLogEntry,
      ];
    }

    if (typeof structured.raw === "string") {
      return [
        {
          timestamp: "",
          level: "info",
          message: structured.raw,
          executionName: null,
          requestId: null,
        } satisfies WorkflowDeploymentLogEntry,
      ];
    }

    return [];
  });
}

function LogsPageContent() {
  const searchParams = useSearchParams();
  const getQueryParam = (name: string) => searchParams?.get(name) || "";
  const requestedProvider = resolveCloudProvider(getQueryParam("provider"));
  const queryWorkflow = getQueryParam("workflow");
  const queryWorkflowSlug = getQueryParam("workflowSlug");
  const queryWorkflowValue = queryWorkflow || queryWorkflowSlug;
  const queryDeploymentId = getQueryParam("deploymentId");
  const queryExecutionName = getQueryParam("executionName");

  const [provider, setProvider] = useState<CloudProvider | null>(requestedProvider);
  const [providerReady, setProviderReady] = useState(Boolean(requestedProvider));
  const [workflowId, setWorkflowId] = useState(queryWorkflowValue);
  const [since, setSince] = useState("1h");
  const [logs, setLogs] = useState<WorkflowDeploymentLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [error, setError] = useState("");
  const [liveError, setLiveError] = useState("");
  const [gcpDeployments, setGcpDeployments] = useState<
    WorkflowDeploymentOverview[]
  >([]);
  const [deploymentsLoading, setDeploymentsLoading] = useState(false);
  const [deploymentError, setDeploymentError] = useState("");
  const [selectedDeploymentId, setSelectedDeploymentId] =
    useState(queryDeploymentId);
  const [selectedExecutionName, setSelectedExecutionName] =
    useState(queryExecutionName);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setWorkflowId(queryWorkflowValue);
    setSelectedDeploymentId(queryDeploymentId);
    setSelectedExecutionName(queryExecutionName);
  }, [queryDeploymentId, queryExecutionName, queryWorkflowValue]);

  useEffect(() => {
    let cancelled = false;

    if (requestedProvider) {
      setProvider(requestedProvider);
      setProviderReady(true);
      return () => {
        cancelled = true;
      };
    }

    setProvider(null);
    setProviderReady(false);

    void (async () => {
      const settings = await loadCloudDeploySettings();
      if (cancelled) {
        return;
      }

      setProvider(
        resolvePreferredCloudProvider({
          requestedProvider,
          savedProvider: settings.provider,
        })
      );
      setProviderReady(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [requestedProvider]);

  const workflowLookup = useMemo(() => {
    const trimmedWorkflow = workflowId.trim();
    if (!trimmedWorkflow) {
      return {
        workflowId: undefined,
        workflowSlug: undefined,
      };
    }

    return {
      workflowId: trimmedWorkflow,
      workflowSlug:
        queryWorkflowSlug &&
        (trimmedWorkflow === queryWorkflow ||
          trimmedWorkflow === queryWorkflowSlug)
          ? queryWorkflowSlug
          : undefined,
    };
  }, [queryWorkflow, queryWorkflowSlug, workflowId]);

  const visibleGcpDeployments = useMemo(() => {
    if (!provider) {
      return [];
    }

    return getScopedWorkflowDeployments(gcpDeployments, {
      provider,
      workflowId: workflowLookup.workflowId,
      workflowSlug: workflowLookup.workflowSlug,
    });
  }, [gcpDeployments, provider, workflowLookup]);

  const selectedDeployment = useMemo(
    () =>
      visibleGcpDeployments.find(
        (deployment) => deployment.id === selectedDeploymentId
      ) || null,
    [selectedDeploymentId, visibleGcpDeployments]
  );

  const executionOptions = selectedDeployment?.recentExecutions || [];
  const hasCustomExecutionSelection =
    Boolean(selectedExecutionName) &&
    !executionOptions.some(
      (execution) => execution.executionName === selectedExecutionName
    );

  const activeProviderLabel = provider
    ? CLOUD_PROVIDER_LABELS[provider]
    : "your primary cloud";
  const providerStatusCopy = !providerReady
    ? "Loading the deployment target configured in Settings..."
    : provider === "local"
      ? "Showing local deployments and logs from this machine."
    : requestedProvider && provider === requestedProvider
      ? `Showing ${activeProviderLabel} from the current provider-specific link.`
      : requestedProvider
        ? `Switched to ${activeProviderLabel} for this session after opening from a provider-specific link.`
        : `Opening ${activeProviderLabel} because it is configured as your primary cloud in Settings.`;

  const handleProviderChange = (nextProvider: CloudProvider) => {
    setProvider(nextProvider);
    setLogs([]);
    setError("");
    setLiveError("");
    setDeploymentError("");
    setAutoRefresh(nextProvider === "local");
  };

  const loadDeployments = useCallback(async () => {
    if (!providerReady || !provider) {
      setGcpDeployments([]);
      setDeploymentError("");
      return;
    }

    setDeploymentsLoading(true);
    setDeploymentError("");
    try {
      const fetchDeployments = async () => {
        const deployments = await api.getWorkflowDeploymentsForWorkflow({
          workflowId: workflowLookup.workflowId,
          workflowSlug: workflowLookup.workflowSlug,
          provider,
          includeLive: true,
          executionLimit: 10,
        });
        return Array.isArray(deployments) ? deployments : [];
      };

      let nextDeployments = await fetchDeployments();
      if (nextDeployments.length === 0) {
        await api.reconcileWorkflowDeployments({
          provider,
          workflow: queryWorkflowSlug || workflowId.trim() || undefined,
        });
        nextDeployments = await fetchDeployments();
      }

      setGcpDeployments(nextDeployments);
    } catch (loadError) {
      setGcpDeployments([]);
      setDeploymentError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load deployments."
      );
    } finally {
      setDeploymentsLoading(false);
    }
  }, [provider, providerReady, queryWorkflowSlug, workflowId, workflowLookup]);

  useEffect(() => {
    if (!provider) {
      return;
    }

    setSelectedDeploymentId((current) =>
      resolveSelectedWorkflowDeploymentId(
        visibleGcpDeployments,
        current,
        queryDeploymentId
      )
    );
  }, [provider, queryDeploymentId, visibleGcpDeployments]);

  useEffect(() => {
    setSelectedExecutionName((current) => {
      if (
        current &&
        current === queryExecutionName &&
        selectedDeploymentId === queryDeploymentId
      ) {
        return current;
      }

      return resolveSelectedExecutionName(
        selectedDeployment?.recentExecutions || [],
        current
      );
    });
  }, [
    queryDeploymentId,
    queryExecutionName,
    selectedDeployment,
    selectedDeploymentId,
  ]);

  const fetchLogs = useCallback(async () => {
    if (!providerReady || !provider) {
      return;
    }

    setLoading(true);
    setError("");
    setLiveError("");
    try {
      if (selectedDeployment) {
        const response = await api.getWorkflowDeploymentLogs(
          selectedDeployment.id,
          {
            since,
            limit: 200,
            executionName: selectedExecutionName || undefined,
          }
        );
        setLogs(Array.isArray(response.entries) ? response.entries : []);
        setLiveError(response.liveError || "");
        return;
      }

      if (provider === "gcp") {
        setLogs([]);
        return;
      }

      const response = await api.getLogs({
        provider,
        since,
        limit: "200",
        ...(workflowId.trim() ? { workflow: workflowId.trim() } : {}),
      });
      setLogs(normalizeLegacyLogEntries(response));
    } catch (fetchError) {
      setLogs([]);
      setError(
        fetchError instanceof Error
          ? fetchError.message
          : "Failed to fetch logs."
      );
    } finally {
      setLoading(false);
    }
  }, [
    provider,
    providerReady,
    selectedDeployment,
    selectedExecutionName,
    since,
    workflowId,
  ]);

  useEffect(() => {
    if (!providerReady || !provider) {
      return;
    }

    void loadDeployments();
  }, [loadDeployments, provider, providerReady]);

  useEffect(() => {
    if (!providerReady || !provider) {
      return;
    }

    void fetchLogs();
  }, [fetchLogs, provider, providerReady]);

  useEffect(() => {
    if (provider) {
      setAutoRefresh(provider === "local");
    }
  }, [provider]);

  useEffect(() => {
    if (!providerReady || !provider || !autoRefresh) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    intervalRef.current = setInterval(() => {
      void fetchLogs();
      if (provider) {
        void loadDeployments();
      }
    }, provider === "local" ? 5000 : 10000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [autoRefresh, fetchLogs, loadDeployments, provider, providerReady]);

  return (
    <div className="mx-auto max-w-6xl p-8">
      <div className="space-y-6">
        <section className="relative overflow-hidden rounded-[28px] border border-zinc-800 bg-gradient-to-br from-zinc-900 via-zinc-950 to-zinc-950">
          <div className="absolute right-0 top-0 h-64 w-64 rounded-full bg-blue-500/10 blur-3xl" />
          <div className="absolute bottom-0 left-10 h-40 w-40 rounded-full bg-cyan-500/10 blur-3xl" />

          <div className="relative p-6 sm:p-8">
            <div className="max-w-3xl">
              <SectionEyebrow icon={<ScrollText size={12} />}>
                Execution observability
              </SectionEyebrow>
              <h1 className="mt-4 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                Logs
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-zinc-400 sm:text-base">
                Review workflow executions from your deployment target, narrow the
                stream to a specific workflow or time window, and jump into
                deployment-scoped logs when recent execution metadata is available.
              </p>
            </div>

            <p className="mt-5 text-sm leading-6 text-zinc-400">
              {providerStatusCopy}
            </p>
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6">
          <div className="max-w-3xl">
            <SectionEyebrow icon={<Cloud size={12} />}>Log filters</SectionEyebrow>
            <h2 className="mt-4 text-2xl font-semibold text-white">
              Choose what to inspect
            </h2>
            <p className="mt-2 text-sm leading-7 text-zinc-400">
              Start with your preferred deployment target from Settings, refine
              the workflow scope, then refresh the stream manually or keep it
              live while you investigate.
            </p>
          </div>

          <div className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-950/60 p-5">
            {!providerReady || !provider ? (
              <div className="flex min-h-40 items-center justify-center gap-3 text-sm text-zinc-500">
                <Loader2 size={16} className="animate-spin" />
                Loading your preferred cloud...
              </div>
            ) : (
              <div className="space-y-6">
                <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
                  <div className="max-w-2xl">
                    <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-zinc-500">
                      Primary cloud
                    </p>
                    <p className="mt-2 text-sm leading-6 text-zinc-400">
                      Open the same provider configured in Settings by default,
                      or switch clouds here for the current session.
                    </p>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    {cloudProviders.map((entry) => (
                      <button
                        key={entry}
                        type="button"
                        onClick={() => handleProviderChange(entry)}
                        className={`rounded-2xl border px-5 py-4 text-left transition-colors ${
                          provider === entry
                            ? "border-blue-500 bg-blue-500/10 text-white"
                            : "border-zinc-800 bg-zinc-950/70 text-zinc-400 hover:border-zinc-700 hover:text-white"
                        }`}
                      >
                        <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">
                          Cloud source
                        </p>
                        <p className="mt-2 text-sm font-medium">
                          {CLOUD_PROVIDER_LABELS[entry]}
                        </p>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid gap-4 xl:grid-cols-[minmax(0,1.7fr)_220px_auto] xl:items-end">
                  <div>
                    <label className="mb-2 block text-xs text-zinc-500">
                      Workflow filter
                    </label>
                    <div className="relative">
                      <Search
                        size={14}
                        className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500"
                      />
                      <input
                        type="text"
                        value={workflowId}
                        onChange={(event) => setWorkflowId(event.target.value)}
                        placeholder={
                          provider === "gcp"
                            ? "Filter deployments by workflow..."
                            : provider === "local"
                              ? "Filter local deployments by workflow..."
                            : "Filter AWS deployments or legacy logs by workflow..."
                        }
                        className={`${fieldClassName} pl-9`}
                      />
                    </div>
                  </div>

                  <div>
                    <label className="mb-2 block text-xs text-zinc-500">
                      Time range
                    </label>
                    <select
                      value={since}
                      onChange={(event) => setSince(event.target.value)}
                      className={fieldClassName}
                    >
                      {timeRanges.map((entry) => (
                        <option key={entry.value} value={entry.value}>
                          {entry.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex flex-wrap items-center gap-3 xl:justify-end">
                    <button
                      type="button"
                      onClick={() => {
                        void loadDeployments();
                        void fetchLogs();
                      }}
                      disabled={loading || deploymentsLoading}
                      className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 px-4 py-2.5 text-sm text-zinc-300 transition-colors hover:border-zinc-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <RefreshCw
                        size={14}
                        className={
                          loading || deploymentsLoading ? "animate-spin" : ""
                        }
                      />
                      Refresh
                    </button>

                    <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-400">
                      <input
                        type="checkbox"
                        checked={autoRefresh}
                        onChange={(event) => setAutoRefresh(event.target.checked)}
                        className="rounded border-zinc-700 bg-zinc-900"
                      />
                      Auto-refresh
                    </label>
                  </div>
                </div>

                {provider ? (
                  <div className="border-t border-zinc-800 pt-6">
                    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(220px,0.8fr)]">
                      <div>
                        <label className="mb-2 block text-xs text-zinc-500">
                          Deployment
                        </label>
                        <select
                          value={selectedDeploymentId}
                          onChange={(event) =>
                            setSelectedDeploymentId(event.target.value)
                          }
                          className={fieldClassName}
                        >
                          {visibleGcpDeployments.length === 0 ? (
                            <option value="">
                              {deploymentsLoading
                                ? "Loading deployments..."
                                : "No deployments"}
                            </option>
                          ) : null}
                          {visibleGcpDeployments.map((deployment) => (
                            <option key={deployment.id} value={deployment.id}>
                              {describeDeployment(deployment)}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="mb-2 block text-xs text-zinc-500">
                          Execution
                        </label>
                        <select
                          value={selectedExecutionName}
                          onChange={(event) =>
                            setSelectedExecutionName(event.target.value)
                          }
                          className={fieldClassName}
                        >
                          <option value="">All recent runs</option>
                          {hasCustomExecutionSelection ? (
                            <option value={selectedExecutionName}>
                              {selectedExecutionName}
                            </option>
                          ) : null}
                          {executionOptions.map((execution, index) => (
                            <option
                              key={`${execution.executionName || index}`}
                              value={execution.executionName || ""}
                            >
                              {(execution.executionName || "execution") +
                                ` • ${execution.status || "unknown"}${
                                  execution.triggerSource
                                    ? ` • ${execution.triggerSource}`
                                    : ""
                                }`}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    {selectedDeployment ? (
                      <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <p className="text-sm font-medium text-white">
                              {describeDeployment(selectedDeployment)}
                            </p>
                            <p className="mt-1 text-sm text-zinc-500">
                              {provider === "gcp"
                                ? selectedDeployment.platform?.gcpProject ||
                                  selectedDeployment.gcpProject ||
                                  "Unknown project"
                                : provider === "local"
                                  ? selectedDeployment.platform?.logPath ||
                                    "Unknown local log path"
                                : selectedDeployment.platform?.logGroupName ||
                                  "Unknown log group"}
                              {" • "}
                              {selectedDeployment.platform?.region ||
                                selectedDeployment.region ||
                                "Unknown region"}
                            </p>
                          </div>

                          <p className="text-sm text-zinc-500">
                            Last deployed{" "}
                            {formatDateTime(
                              selectedDeployment.deployedAt ||
                                selectedDeployment.updatedAt
                            )}
                          </p>
                        </div>

                        {selectedDeployment.liveError ? (
                          <div className="mt-3">
                            <StatusBanner tone="warning">
                              {selectedDeployment.liveError}
                            </StatusBanner>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </section>

        {deploymentError ? (
          <StatusBanner tone="error">{deploymentError}</StatusBanner>
        ) : null}

        {error ? <StatusBanner tone="error">{error}</StatusBanner> : null}

        {liveError ? <StatusBanner tone="warning">{liveError}</StatusBanner> : null}

        <section className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950">
          <div className="border-b border-zinc-800 bg-zinc-950/80 px-5 py-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-zinc-500">
                  Log stream
                </p>
                <h2 className="mt-1 text-base font-medium text-white">
                  {!providerReady || !provider
                    ? "Preparing execution logs"
                    : `${activeProviderLabel} execution logs`}
                </h2>
              </div>

              {providerReady && provider ? (
                <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                  <span className="rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1">
                    {timeRanges.find((entry) => entry.value === since)?.label ||
                      since}
                  </span>
                  <span className="rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1">
                    {autoRefresh ? "Auto-refresh on" : "Manual refresh"}
                  </span>
                </div>
              ) : null}
            </div>
          </div>

          {!providerReady || !provider ? (
            <div className="flex items-center justify-center gap-2 py-20 text-sm text-zinc-500">
              <Loader2 size={16} className="animate-spin" />
              Loading logs...
            </div>
          ) : loading && logs.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-20 text-sm text-zinc-500">
              <Loader2 size={16} className="animate-spin" />
              Loading logs...
            </div>
          ) : logs.length === 0 ? (
            <div className="flex items-center justify-center py-20 text-sm text-zinc-500">
              {visibleGcpDeployments.length > 0 && !selectedDeploymentId
                ? "Select a deployment to view logs."
                : "No logs found for this filter set."}
            </div>
          ) : (
            <div className="max-h-[680px] overflow-y-auto">
              {logs.map((log, index) => (
                <div
                  key={`${log.timestamp}-${index}`}
                  className="flex flex-col gap-2 border-b border-zinc-900/80 px-5 py-3 last:border-b-0 lg:flex-row lg:items-start"
                >
                  <span className="shrink-0 whitespace-nowrap font-mono text-[11px] text-zinc-600 lg:min-w-40">
                    {log.timestamp || "unknown-time"}
                  </span>

                  <div className="flex min-w-0 flex-1 flex-wrap items-start gap-2">
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-1 text-[10px] font-medium uppercase tracking-wide ${
                        levelColors[log.level] || levelColors.info
                      }`}
                    >
                      {log.level.toUpperCase()}
                    </span>

                    {log.executionName ? (
                      <span className="inline-flex items-center rounded-full border border-zinc-800 bg-zinc-900 px-2 py-1 text-[10px] text-zinc-400">
                        {log.executionName}
                      </span>
                    ) : null}

                    <span className="min-w-0 flex-1 break-words font-mono text-xs leading-6 text-zinc-300">
                      {log.message}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function LogsPageFallback() {
  return (
    <main className="min-h-screen bg-zinc-950 text-white">
      <section className="mx-auto flex min-h-screen max-w-6xl items-center justify-center px-6 py-24">
        <div className="inline-flex items-center gap-3 rounded-full border border-zinc-800 bg-zinc-900/70 px-5 py-3 text-sm text-zinc-300">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading deployment logs...
        </div>
      </section>
    </main>
  );
}

export default function LogsPage() {
  return (
    <Suspense fallback={<LogsPageFallback />}>
      <LogsPageContent />
    </Suspense>
  );
}
