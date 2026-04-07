"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle,
  ExternalLink,
  Loader2,
  Play,
  RefreshCw,
  ScrollText,
  Search,
  Server,
} from "lucide-react";
import { api } from "@/lib/api";
import {
  buildDeploymentLogsHref,
  canManuallyTriggerLocalDeployment,
  deploymentStatusTone,
  formatDeploymentDateTime,
  formatDeploymentTriggerSummary,
  formatProviderComputeLabel,
  getScopedWorkflowDeployments,
  isDashboardLocalRunSuccess,
  resolveSelectedExecutionName,
  resolveSelectedWorkflowDeploymentId,
  type WorkflowDeploymentLogEntry,
  type WorkflowDeploymentOverview,
} from "@/lib/deploy";
import type { WorkflowListItem } from "@/lib/workflow-studio/types";

const timeRanges = [
  { value: "1h", label: "Last 1h" },
  { value: "6h", label: "Last 6h" },
  { value: "24h", label: "Last 24h" },
  { value: "7d", label: "Last 7d" },
];

const fieldClassName =
  "w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm text-white outline-none transition-colors placeholder:text-zinc-600 focus:border-blue-500";

const levelColors: Record<string, string> = {
  info: "border-emerald-900/80 bg-emerald-950/40 text-emerald-300",
  warn: "border-amber-900/80 bg-amber-950/40 text-amber-200",
  error: "border-red-900/80 bg-red-950/40 text-red-200",
};

interface LocalRunCardState {
  status: "idle" | "running" | "success" | "error";
  message?: string;
  output?: string;
  deploymentId?: string | null;
  executionId?: string | null;
}

function formatRunOutput(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parsePayloadDraft(raw: string): {
  payload?: unknown;
  error?: string;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }

  try {
    return {
      payload: JSON.parse(trimmed),
    };
  } catch {
    return {
      error: "Payload must be valid JSON.",
    };
  }
}

function StatusBanner({
  tone,
  children,
}: {
  tone: "error" | "warning";
  children: React.ReactNode;
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

function buildDeploymentDescriptor(
  deployment: WorkflowDeploymentOverview,
  workflowTitle?: string
): string {
  return `${workflowTitle || deployment.workflowId} • ${formatProviderComputeLabel(
    "local",
    deployment.platform?.computeType || deployment.executionKind
  )}`;
}

function LocalLogStream({
  logs,
  loading,
  emptyMessage,
}: {
  logs: WorkflowDeploymentLogEntry[];
  loading: boolean;
  emptyMessage: string;
}) {
  if (loading && logs.length === 0) {
    return (
      <div className="flex items-center justify-center gap-2 py-20 text-sm text-zinc-500">
        <Loader2 size={16} className="animate-spin" />
        Loading logs...
      </div>
    );
  }

  if (logs.length === 0) {
    return (
      <div className="flex items-center justify-center py-20 text-sm text-zinc-500">
        {emptyMessage}
      </div>
    );
  }

  return (
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
  );
}

export function LocalDeploymentDashboard() {
  const searchParams = useSearchParams();
  const getQueryParam = (name: string) => searchParams?.get(name) || "";
  const queryWorkflow = getQueryParam("workflow");
  const queryWorkflowSlug = getQueryParam("workflowSlug");
  const queryWorkflowValue = queryWorkflow || queryWorkflowSlug;
  const queryDeploymentId = getQueryParam("deploymentId");
  const queryExecutionName = getQueryParam("executionName");

  const [workflowQuery, setWorkflowQuery] = useState(queryWorkflowValue);
  const [workflowList, setWorkflowList] = useState<WorkflowListItem[]>([]);
  const [deployments, setDeployments] = useState<WorkflowDeploymentOverview[]>([]);
  const [deploymentLoading, setDeploymentLoading] = useState(true);
  const [deploymentError, setDeploymentError] = useState("");
  const [selectedDeploymentId, setSelectedDeploymentId] =
    useState(queryDeploymentId);
  const [selectedExecutionName, setSelectedExecutionName] =
    useState(queryExecutionName);
  const [since, setSince] = useState("1h");
  const [logs, setLogs] = useState<WorkflowDeploymentLogEntry[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState("");
  const [liveError, setLiveError] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [localRunDrafts, setLocalRunDrafts] = useState<Record<string, string>>(
    {}
  );
  const [localRunStates, setLocalRunStates] = useState<
    Record<string, LocalRunCardState>
  >({});
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setWorkflowQuery(queryWorkflowValue);
    setSelectedDeploymentId(queryDeploymentId);
    setSelectedExecutionName(queryExecutionName);
  }, [queryDeploymentId, queryExecutionName, queryWorkflowValue]);

  const workflowNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const workflow of workflowList) {
      map.set(workflow.workflowId, workflow.title || workflow.workflowId);
      map.set(workflow.slug, workflow.title || workflow.slug);
    }
    return map;
  }, [workflowList]);

  const workflowSlugById = useMemo(() => {
    const map = new Map<string, string>();
    for (const workflow of workflowList) {
      map.set(workflow.workflowId, workflow.slug);
    }
    return map;
  }, [workflowList]);

  const visibleDeployments = useMemo(() => {
    const normalizedQuery = workflowQuery.trim().toLowerCase();
    return getScopedWorkflowDeployments(deployments, {
      provider: "local",
      region: "local",
    }).filter((deployment) => {
      if (!normalizedQuery) {
        return true;
      }

      const workflowTitle = workflowNameById.get(deployment.workflowId) || "";
      const workflowSlug = workflowSlugById.get(deployment.workflowId) || "";
      return [deployment.workflowId, workflowTitle, workflowSlug].some((value) =>
        value.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [deployments, workflowNameById, workflowQuery, workflowSlugById]);

  const selectedDeployment = useMemo(
    () =>
      visibleDeployments.find((deployment) => deployment.id === selectedDeploymentId) ||
      null,
    [selectedDeploymentId, visibleDeployments]
  );

  const executionOptions = selectedDeployment?.recentExecutions || [];
  const hasCustomExecutionSelection =
    Boolean(selectedExecutionName) &&
    !executionOptions.some(
      (execution) => execution.executionName === selectedExecutionName
    );

  const selectedLogsHref = selectedDeployment
    ? buildDeploymentLogsHref({
        provider: "local",
        deploymentId: selectedDeployment.id,
        workflowId: selectedDeployment.workflowId,
        workflowSlug:
          workflowSlugById.get(selectedDeployment.workflowId) || undefined,
        executionName:
          selectedExecutionName || executionOptions[0]?.executionName || undefined,
      })
    : "/deploy/logs?provider=local";

  const loadWorkflowList = useCallback(async () => {
    try {
      const response = await fetch("/api/workflows", { cache: "no-store" });
      const data = (await response.json()) as { workflows?: WorkflowListItem[] };
      if (Array.isArray(data.workflows)) {
        setWorkflowList(data.workflows);
      }
    } catch {
      // Ignore workflow lookup failures and fall back to raw workflow ids.
    }
  }, []);

  const loadDeployments = useCallback(
    async (options: { forceReconcile?: boolean } = {}) => {
      const forceReconcile = options.forceReconcile === true;

      setDeploymentLoading(true);
      setDeploymentError("");
      try {
        const fetchDeployments = async () => {
          const response = await api.getWorkflowDeployments({
            provider: "local",
            includeLive: true,
            executionLimit: 10,
          });
          return Array.isArray(response) ? response : [];
        };

        let nextDeployments = await fetchDeployments();
        if (forceReconcile) {
          await api.reconcileWorkflowDeployments({
            provider: "local",
          });
          nextDeployments = await fetchDeployments();
        }

        setDeployments(nextDeployments);
      } catch (error) {
        setDeployments([]);
        setDeploymentError(
          error instanceof Error
            ? error.message
            : "Failed to load local deployments."
        );
      } finally {
        setDeploymentLoading(false);
      }
    },
    []
  );

  const fetchLogs = useCallback(async () => {
    if (!selectedDeployment) {
      setLogs([]);
      setLogsError("");
      setLiveError("");
      return;
    }

    setLogsLoading(true);
    setLogsError("");
    setLiveError("");
    try {
      const response = await api.getWorkflowDeploymentLogs(selectedDeployment.id, {
        since,
        limit: 200,
        executionName: selectedExecutionName || undefined,
      });
      setLogs(Array.isArray(response.entries) ? response.entries : []);
      setLiveError(response.liveError || "");
    } catch (error) {
      setLogs([]);
      setLogsError(
        error instanceof Error ? error.message : "Failed to fetch trigger logs."
      );
    } finally {
      setLogsLoading(false);
    }
  }, [selectedDeployment, selectedExecutionName, since]);

  const handleSelectDeployment = useCallback(
    (deploymentId: string, executionName?: string | null) => {
      setSelectedDeploymentId(deploymentId);
      setSelectedExecutionName(executionName || "");
    },
    []
  );

  const handleRunLocalWorkflow = useCallback(
    async (deployment: WorkflowDeploymentOverview) => {
      const workflowId = deployment.workflowId;
      const payloadDraft = localRunDrafts[workflowId] || "";
      const payloadResult = parsePayloadDraft(payloadDraft);

      if (payloadResult.error) {
        setLocalRunStates((current) => ({
          ...current,
          [workflowId]: {
            status: "error",
            message: payloadResult.error,
            output: "",
            deploymentId: deployment.id,
          },
        }));
        return;
      }

      setLocalRunStates((current) => ({
        ...current,
        [workflowId]: {
          status: "running",
          message: "Running local workflow...",
          output: "",
          deploymentId: deployment.id,
        },
      }));

      try {
        const response = await api.runLocalWorkflow({
          workflowId,
          workflowSlug: workflowSlugById.get(workflowId),
          payload: payloadResult.payload,
        });

        if (!isDashboardLocalRunSuccess(response)) {
          setLocalRunStates((current) => ({
            ...current,
            [workflowId]: {
              status: "error",
              message: response.error,
              output: formatRunOutput(response.output),
              deploymentId: response.deploymentId || deployment.id,
              executionId: response.executionId || null,
            },
          }));
          if (response.deploymentId || response.executionId) {
            await loadDeployments();
            handleSelectDeployment(
              response.deploymentId || deployment.id,
              response.executionId || null
            );
          }
          return;
        }

        setLocalRunStates((current) => ({
          ...current,
          [workflowId]: {
            status: "success",
            message: `Local workflow ${response.workflowId} completed successfully.`,
            output: formatRunOutput(response.output),
            deploymentId: response.deploymentId || deployment.id,
            executionId: response.executionId || null,
          },
        }));

        await loadDeployments();
        handleSelectDeployment(
          response.deploymentId || deployment.id,
          response.executionId || null
        );
      } catch (error) {
        setLocalRunStates((current) => ({
          ...current,
          [workflowId]: {
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : "Local workflow run failed.",
            output: "",
            deploymentId: deployment.id,
          },
        }));
      }
    },
    [handleSelectDeployment, loadDeployments, localRunDrafts, workflowSlugById]
  );

  useEffect(() => {
    void loadWorkflowList();
    void loadDeployments();
  }, [loadDeployments, loadWorkflowList]);

  useEffect(() => {
    setSelectedDeploymentId((current) =>
      resolveSelectedWorkflowDeploymentId(
        visibleDeployments,
        current,
        queryDeploymentId
      )
    );
  }, [queryDeploymentId, visibleDeployments]);

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
        current || queryExecutionName
      );
    });
  }, [
    queryDeploymentId,
    queryExecutionName,
    selectedDeployment,
    selectedDeploymentId,
  ]);

  useEffect(() => {
    void fetchLogs();
  }, [fetchLogs]);

  useEffect(() => {
    if (!autoRefresh) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    intervalRef.current = setInterval(() => {
      void loadDeployments();
      void fetchLogs();
    }, 5000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [autoRefresh, fetchLogs, loadDeployments]);

  return (
    <div className="mx-auto max-w-7xl p-8">
      <div className="space-y-6">
        <section className="relative overflow-hidden rounded-[28px] border border-zinc-800 bg-gradient-to-br from-zinc-900 via-zinc-950 to-zinc-950">
          <div className="absolute right-0 top-0 h-64 w-64 rounded-full bg-blue-500/10 blur-3xl" />
          <div className="absolute bottom-0 left-10 h-40 w-40 rounded-full bg-cyan-500/10 blur-3xl" />

          <div className="relative p-6 sm:p-8">
            <div className="inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/80 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.2em] text-zinc-400">
              <Server size={12} />
              Published locally
            </div>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              Local Deployments
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-zinc-400 sm:text-base">
              See what is published on this machine, trigger manual workflows,
              and follow execution logs without leaving the dashboard.
            </p>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Link
                href="/deploy"
                className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 px-4 py-2.5 text-sm text-zinc-300 transition-colors hover:border-zinc-600 hover:text-white"
              >
                Back to Deploy
              </Link>
              <Link
                href={selectedLogsHref}
                className="inline-flex items-center gap-2 rounded-xl border border-blue-500/40 bg-blue-500/10 px-4 py-2.5 text-sm text-blue-100 transition-colors hover:border-blue-400 hover:bg-blue-500/15"
              >
                <ExternalLink size={14} />
                Open full logs
              </Link>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_auto_auto] xl:items-end">
            <div>
              <label className="mb-2 block text-xs text-zinc-500">
                Workflow search
              </label>
              <div className="relative">
                <Search
                  size={14}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500"
                />
                <input
                  type="text"
                  value={workflowQuery}
                  onChange={(event) => setWorkflowQuery(event.target.value)}
                  placeholder="Search local deployments by workflow..."
                  className={`${fieldClassName} pl-9`}
                />
              </div>
            </div>

            <button
              type="button"
              onClick={() =>
                void loadDeployments({
                  forceReconcile: visibleDeployments.length === 0,
                })
              }
              disabled={deploymentLoading || logsLoading}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-700 px-4 py-2.5 text-sm text-zinc-300 transition-colors hover:border-zinc-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw
                size={14}
                className={deploymentLoading || logsLoading ? "animate-spin" : ""}
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

          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            <span className="rounded-full border border-zinc-800 bg-zinc-950 px-3 py-1">
              {visibleDeployments.length} local deployment
              {visibleDeployments.length === 1 ? "" : "s"}
            </span>
            <span className="rounded-full border border-zinc-800 bg-zinc-950 px-3 py-1">
              {autoRefresh ? "Auto-refresh every 5s" : "Manual refresh"}
            </span>
          </div>
        </section>

        {deploymentError ? (
          <StatusBanner tone="error">{deploymentError}</StatusBanner>
        ) : null}

        {logsError ? <StatusBanner tone="error">{logsError}</StatusBanner> : null}

        {liveError ? <StatusBanner tone="warning">{liveError}</StatusBanner> : null}

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
          <section className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-zinc-500">
                  Local runtime
                </p>
                <h2 className="mt-1 text-xl font-semibold text-white">
                  Published workflows
                </h2>
              </div>
            </div>

            {deploymentLoading && visibleDeployments.length === 0 ? (
              <div className="flex min-h-60 items-center justify-center gap-3 text-sm text-zinc-500">
                <Loader2 size={16} className="animate-spin" />
                Loading local deployments...
              </div>
            ) : visibleDeployments.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-zinc-800 bg-zinc-950/40 px-6 py-16 text-center">
                <p className="text-sm text-zinc-400">
                  No local deployments are published yet.
                </p>
                <p className="mt-2 text-sm text-zinc-500">
                  Deploy a workflow locally from the main deploy page and it will
                  show up here with run controls and trigger logs.
                </p>
                <Link
                  href="/deploy"
                  className="mt-5 inline-flex items-center gap-2 rounded-xl border border-zinc-700 px-4 py-2.5 text-sm text-zinc-300 transition-colors hover:border-zinc-600 hover:text-white"
                >
                  Go to Deploy
                </Link>
              </div>
            ) : (
              <div className="space-y-4">
                {visibleDeployments.map((deployment) => {
                  const executions = deployment.recentExecutions || [];
                  const latestExecution = executions[0] || null;
                  const localRunState: LocalRunCardState =
                    localRunStates[deployment.workflowId] || { status: "idle" };
                  const workflowTitle =
                    workflowNameById.get(deployment.workflowId) || deployment.workflowId;
                  const workflowSlug =
                    workflowSlugById.get(deployment.workflowId) || undefined;
                  const isSelected = selectedDeploymentId === deployment.id;
                  const canRunManually =
                    canManuallyTriggerLocalDeployment(deployment);
                  const logsHref = buildDeploymentLogsHref({
                    provider: "local",
                    deploymentId: deployment.id,
                    workflowId: deployment.workflowId,
                    workflowSlug,
                    executionName:
                      localRunState.executionId ||
                      selectedExecutionName ||
                      latestExecution?.executionName ||
                      undefined,
                  });

                  return (
                    <div
                      key={deployment.id}
                      className={`rounded-2xl border p-4 transition-colors ${
                        isSelected
                          ? "border-blue-500/60 bg-blue-950/10"
                          : "border-zinc-800 bg-zinc-950/40"
                      }`}
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <p className="text-sm font-medium text-white">
                            {workflowTitle}
                          </p>
                          <p className="mt-1 text-xs text-zinc-500">
                            {buildDeploymentDescriptor(deployment, workflowTitle)}
                          </p>
                        </div>

                        <div className="flex items-center gap-2">
                          <span
                            className={`rounded-full border px-2 py-0.5 text-[10px] ${deploymentStatusTone(
                              latestExecution?.status || deployment.status
                            )}`}
                          >
                            {(latestExecution?.status ||
                              deployment.status ||
                              "unknown").toUpperCase()}
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              handleSelectDeployment(
                                deployment.id,
                                latestExecution?.executionName || null
                              )
                            }
                            className="rounded-md border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-900"
                          >
                            Inspect logs
                          </button>
                        </div>
                      </div>

                      <div className="mt-4 grid gap-2 text-xs text-zinc-400 md:grid-cols-2">
                        <p>
                          <span className="text-zinc-500">Trigger:</span>{" "}
                          {formatDeploymentTriggerSummary(deployment)}
                        </p>
                        <p>
                          <span className="text-zinc-500">Region:</span>{" "}
                          {deployment.platform?.region || deployment.region || "local"}
                        </p>
                        <p>
                          <span className="text-zinc-500">Scheduler:</span>{" "}
                          {deployment.platform?.schedulerJobId ||
                            deployment.schedulerId ||
                            "Not configured"}
                        </p>
                        <p>
                          <span className="text-zinc-500">Last deployed:</span>{" "}
                          {formatDeploymentDateTime(
                            deployment.deployedAt || deployment.updatedAt
                          )}
                        </p>
                        <p className="md:col-span-2">
                          <span className="text-zinc-500">Local logs:</span>{" "}
                          {(deployment.platform as { logPath?: string | null } | null)
                            ?.logPath || "N/A"}
                        </p>
                        <p className="md:col-span-2">
                          <span className="text-zinc-500">Latest run:</span>{" "}
                          {latestExecution
                            ? `${formatDeploymentDateTime(
                                latestExecution.startedAt ||
                                  latestExecution.completedAt
                              )} (${latestExecution.triggerSource || "manual"})`
                            : "No runs yet"}
                        </p>
                      </div>

                      {canRunManually ? (
                        <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-950/70 p-3">
                          <div className="flex flex-col gap-3">
                            <div className="flex items-center justify-between gap-3">
                              <p className="text-[11px] uppercase tracking-wide text-zinc-500">
                                Run now
                              </p>
                              <Link
                                href={logsHref}
                                className="text-[11px] text-blue-300 hover:text-blue-200"
                              >
                                Open full logs
                              </Link>
                            </div>

                            <textarea
                              value={localRunDrafts[deployment.workflowId] || ""}
                              onChange={(event) =>
                                setLocalRunDrafts((current) => ({
                                  ...current,
                                  [deployment.workflowId]: event.target.value,
                                }))
                              }
                              placeholder='Optional JSON payload, for example {"dryRun":true}'
                              className="min-h-24 w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-white outline-none focus:border-blue-600"
                            />

                            <div className="flex flex-wrap items-center gap-3">
                              <button
                                type="button"
                                onClick={() => void handleRunLocalWorkflow(deployment)}
                                disabled={localRunState.status === "running"}
                                className="inline-flex items-center gap-2 rounded-md border border-zinc-700 px-3 py-2 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-900 disabled:opacity-50"
                              >
                                {localRunState.status === "running" ? (
                                  <>
                                    <Loader2 size={12} className="animate-spin" />
                                    Running...
                                  </>
                                ) : (
                                  <>
                                    <Play size={12} />
                                    Run now
                                  </>
                                )}
                              </button>

                              <span className="text-[11px] text-zinc-500">
                                Leave the payload blank to run with an empty input.
                              </span>
                              {deployment.triggerType === "schedule" ? (
                                <span className="text-[11px] text-zinc-500">
                                  This ad hoc run does not change the saved schedule.
                                </span>
                              ) : null}
                            </div>

                            {localRunState.status === "success" ? (
                              <div className="rounded-md border border-green-800 bg-green-900/20 px-3 py-2 text-xs text-green-300">
                                <div className="flex items-center gap-2">
                                  <CheckCircle size={12} />
                                  {localRunState.message}
                                </div>
                                {localRunState.output ? (
                                  <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded border border-green-900/40 bg-black/30 p-3 text-[11px] text-green-200/80">
                                    {localRunState.output}
                                  </pre>
                                ) : null}
                              </div>
                            ) : null}

                            {localRunState.status === "error" ? (
                              <div className="rounded-md border border-red-800 bg-red-900/20 px-3 py-2 text-xs text-red-300">
                                <div className="flex items-center gap-2">
                                  <AlertCircle size={12} />
                                  {localRunState.message || "Local workflow run failed."}
                                </div>
                                {localRunState.output ? (
                                  <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded border border-red-900/40 bg-black/30 p-3 text-[11px] text-red-200/80">
                                    {localRunState.output}
                                  </pre>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      ) : (
                        <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-sm text-zinc-400">
                          This local deployment does not expose a dashboard run
                          action yet. Inspect recent executions or open full logs
                          for the selected run.
                        </div>
                      )}

                      {executions.length > 0 ? (
                        <div className="mt-4 space-y-2">
                          <p className="text-[11px] uppercase tracking-wide text-zinc-500">
                            Recent Runs
                          </p>
                          {executions.map((execution, index) => (
                            <div
                              key={`${deployment.id}-run-${execution.executionName || index}`}
                              className="flex flex-col gap-3 rounded-xl border border-zinc-800 px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                            >
                              <div className="space-y-1 text-xs text-zinc-400">
                                <p className="break-all text-zinc-200">
                                  {execution.executionName || "execution"}
                                </p>
                                <p>
                                  {formatDeploymentDateTime(execution.startedAt)}
                                  {" -> "}
                                  {formatDeploymentDateTime(execution.completedAt)}
                                </p>
                                <p>
                                  Trigger: {execution.triggerSource || "manual"}
                                </p>
                              </div>

                              <div className="flex flex-wrap items-center gap-2">
                                <span
                                  className={`rounded-full border px-2 py-0.5 text-[10px] ${deploymentStatusTone(
                                    execution.status
                                  )}`}
                                >
                                  {(execution.status || "unknown").toUpperCase()}
                                </span>
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleSelectDeployment(
                                      deployment.id,
                                      execution.executionName || null
                                    )
                                  }
                                  className="rounded-md border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-900"
                                >
                                  Focus logs
                                </button>
                                <Link
                                  href={buildDeploymentLogsHref({
                                    provider: "local",
                                    deploymentId: deployment.id,
                                    workflowId: deployment.workflowId,
                                    workflowSlug,
                                    executionName:
                                      execution.executionName || undefined,
                                  })}
                                  className="text-[11px] text-blue-300 hover:text-blue-200"
                                >
                                  Full logs
                                </Link>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-4 text-xs text-zinc-500">
                          No recent executions reported yet.
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 xl:sticky xl:top-8 xl:self-start">
            <div className="border-b border-zinc-800 bg-zinc-950/80 px-5 py-4">
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-zinc-500">
                      Trigger logs
                    </p>
                    <h2 className="mt-1 text-base font-medium text-white">
                      {selectedDeployment
                        ? buildDeploymentDescriptor(
                            selectedDeployment,
                            workflowNameById.get(selectedDeployment.workflowId)
                          )
                        : "Select a local deployment"}
                    </h2>
                  </div>

                  <Link
                    href={selectedLogsHref}
                    className="inline-flex items-center gap-1 text-xs text-zinc-400 transition-colors hover:text-white"
                  >
                    <ExternalLink size={12} />
                    Full logs
                  </Link>
                </div>

                <div className="grid gap-3">
                  <div>
                    <label className="mb-2 block text-xs text-zinc-500">
                      Deployment
                    </label>
                    <select
                      value={selectedDeploymentId}
                      onChange={(event) =>
                        handleSelectDeployment(event.target.value, null)
                      }
                      className={fieldClassName}
                    >
                      {visibleDeployments.length === 0 ? (
                        <option value="">
                          {deploymentLoading ? "Loading deployments..." : "No deployments"}
                        </option>
                      ) : null}
                      {visibleDeployments.map((deployment) => (
                        <option key={deployment.id} value={deployment.id}>
                          {buildDeploymentDescriptor(
                            deployment,
                            workflowNameById.get(deployment.workflowId)
                          )}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
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
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        void loadDeployments();
                        void fetchLogs();
                      }}
                      disabled={deploymentLoading || logsLoading}
                      className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 px-4 py-2.5 text-sm text-zinc-300 transition-colors hover:border-zinc-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <RefreshCw
                        size={14}
                        className={
                          deploymentLoading || logsLoading ? "animate-spin" : ""
                        }
                      />
                      Refresh logs
                    </button>

                    <span className="rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1 text-[11px] text-zinc-500">
                      {timeRanges.find((entry) => entry.value === since)?.label || since}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {selectedDeployment ? (
              <div className="border-b border-zinc-800 bg-zinc-950/60 px-5 py-4 text-xs text-zinc-400">
                <div className="space-y-1">
                  <p>
                    <span className="text-zinc-500">Log path:</span>{" "}
                    {(selectedDeployment.platform as { logPath?: string | null } | null)
                      ?.logPath || "N/A"}
                  </p>
                  <p>
                    <span className="text-zinc-500">Last deployed:</span>{" "}
                    {formatDeploymentDateTime(
                      selectedDeployment.deployedAt ||
                        selectedDeployment.updatedAt
                    )}
                  </p>
                </div>
              </div>
            ) : null}

            <div className="border-b border-zinc-800 px-5 py-3">
              <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                <span className="inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1">
                  <ScrollText size={12} />
                  Deployment-scoped trigger logs
                </span>
                <span className="rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1">
                  {autoRefresh ? "Auto-refresh on" : "Manual refresh"}
                </span>
              </div>
            </div>

            <LocalLogStream
              logs={logs}
              loading={logsLoading}
              emptyMessage={
                visibleDeployments.length === 0
                  ? "No local deployments found for this filter set."
                  : !selectedDeployment
                    ? "Select a deployment to inspect logs."
                    : "No trigger logs found for this deployment yet."
              }
            />
          </section>
        </div>
      </div>
    </div>
  );
}
