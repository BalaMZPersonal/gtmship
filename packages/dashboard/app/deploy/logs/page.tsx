"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Loader2, Search } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import type {
  WorkflowDeploymentLogEntry,
  WorkflowDeploymentOverview,
} from "@/lib/deploy";

const timeRanges = [
  { value: "1h", label: "Last 1h" },
  { value: "6h", label: "Last 6h" },
  { value: "24h", label: "Last 24h" },
  { value: "7d", label: "Last 7d" },
];

const levelColors: Record<string, string> = {
  info: "bg-green-900/40 text-green-400 border-green-800",
  warn: "bg-yellow-900/40 text-yellow-400 border-yellow-800",
  error: "bg-red-900/40 text-red-400 border-red-800",
};

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
    deployment.platform?.computeType === "job"
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

export default function LogsPage() {
  const searchParams = useSearchParams();
  const queryProvider =
    searchParams.get("provider") === "gcp" ? "gcp" : "aws";
  const queryWorkflow = searchParams.get("workflow") || "";
  const queryDeploymentId = searchParams.get("deploymentId") || "";
  const queryExecutionName = searchParams.get("executionName") || "";

  const [provider, setProvider] = useState<"aws" | "gcp">(queryProvider);
  const [workflowId, setWorkflowId] = useState(queryWorkflow);
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
    setProvider(queryProvider);
    setWorkflowId(queryWorkflow);
    setSelectedDeploymentId(queryDeploymentId);
    setSelectedExecutionName(queryExecutionName);
  }, [queryDeploymentId, queryExecutionName, queryProvider, queryWorkflow]);

  const selectedDeployment = useMemo(
    () =>
      gcpDeployments.find((deployment) => deployment.id === selectedDeploymentId) ||
      null,
    [gcpDeployments, selectedDeploymentId]
  );

  const executionOptions = selectedDeployment?.recentExecutions || [];
  const hasCustomExecutionSelection =
    Boolean(selectedExecutionName) &&
    !executionOptions.some(
      (execution) => execution.executionName === selectedExecutionName
    );

  const loadDeployments = useCallback(async () => {
    if (provider !== "gcp") {
      setGcpDeployments([]);
      setDeploymentError("");
      return;
    }

    setDeploymentsLoading(true);
    setDeploymentError("");
    try {
      const fetchDeployments = async () => {
        const deployments = await api.getWorkflowDeployments({
          provider: "gcp",
          includeLive: true,
          executionLimit: 10,
        });
        return Array.isArray(deployments) ? deployments : [];
      };

      let nextDeployments = await fetchDeployments();
      if (nextDeployments.length === 0) {
        await api.reconcileWorkflowDeployments({
          provider: "gcp",
          workflow: workflowId.trim() || undefined,
        });
        nextDeployments = await fetchDeployments();
      }

      setGcpDeployments(nextDeployments);
      setSelectedDeploymentId((current) => {
        if (current && nextDeployments.some((deployment) => deployment.id === current)) {
          return current;
        }
        if (
          queryDeploymentId &&
          nextDeployments.some((deployment) => deployment.id === queryDeploymentId)
        ) {
          return queryDeploymentId;
        }
        return nextDeployments[0]?.id || "";
      });
    } catch (loadError) {
      setGcpDeployments([]);
      setDeploymentError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load GCP deployments."
      );
    } finally {
      setDeploymentsLoading(false);
    }
  }, [provider, queryDeploymentId, workflowId]);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError("");
    setLiveError("");
    try {
      if (provider === "gcp") {
        if (!selectedDeploymentId) {
          setLogs([]);
          return;
        }

        const response = await api.getWorkflowDeploymentLogs(
          selectedDeploymentId,
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
  }, [provider, selectedDeploymentId, selectedExecutionName, since, workflowId]);

  useEffect(() => {
    void loadDeployments();
  }, [loadDeployments]);

  useEffect(() => {
    void fetchLogs();
  }, [fetchLogs]);

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(() => {
        void fetchLogs();
        if (provider === "gcp") {
          void loadDeployments();
        }
      }, 10000);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [autoRefresh, fetchLogs, loadDeployments, provider]);

  return (
    <div className="p-8 max-w-5xl">
      <div className="mb-6">
        <h2 className="text-xl font-semibold">Execution Logs</h2>
        <p className="mt-1 text-sm text-zinc-500">
          View workflow execution logs from your cloud infrastructure.
        </p>
      </div>

      <div className="mb-4 rounded-lg border border-zinc-800 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1.5 block text-xs text-zinc-500">Provider</label>
            <select
              value={provider}
              onChange={(event) =>
                setProvider(event.target.value as "aws" | "gcp")
              }
              className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-600"
            >
              <option value="aws">AWS</option>
              <option value="gcp">GCP</option>
            </select>
          </div>

          <div>
            <label className="mb-1.5 block text-xs text-zinc-500">
              {provider === "gcp" ? "Workflow Filter" : "Workflow ID"}
            </label>
            <div className="relative">
              <Search
                size={14}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500"
              />
              <input
                type="text"
                value={workflowId}
                onChange={(event) => setWorkflowId(event.target.value)}
                placeholder={
                  provider === "gcp"
                    ? "Filter deployments by workflow..."
                    : "Filter AWS logs by workflow..."
                }
                className="rounded-md border border-zinc-700 bg-zinc-900 pl-8 pr-3 py-2 text-sm text-white placeholder-zinc-600 outline-none focus:border-blue-600"
              />
            </div>
          </div>

          {provider === "gcp" ? (
            <div className="min-w-[280px] flex-1">
              <label className="mb-1.5 block text-xs text-zinc-500">
                Deployment
              </label>
              <select
                value={selectedDeploymentId}
                onChange={(event) => setSelectedDeploymentId(event.target.value)}
                className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-600"
              >
                {gcpDeployments.length === 0 ? (
                  <option value="">
                    {deploymentsLoading ? "Loading deployments..." : "No deployments"}
                  </option>
                ) : null}
                {gcpDeployments.map((deployment) => (
                  <option key={deployment.id} value={deployment.id}>
                    {describeDeployment(deployment)}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {provider === "gcp" ? (
            <div className="min-w-[220px]">
              <label className="mb-1.5 block text-xs text-zinc-500">
                Execution
              </label>
              <select
                value={selectedExecutionName}
                onChange={(event) => setSelectedExecutionName(event.target.value)}
                className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-600"
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
                      ` • ${execution.status || "unknown"}`}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div>
            <label className="mb-1.5 block text-xs text-zinc-500">
              Time Range
            </label>
            <select
              value={since}
              onChange={(event) => setSince(event.target.value)}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-600"
            >
              {timeRanges.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </select>
          </div>

          <button
            onClick={() => {
              void loadDeployments();
              void fetchLogs();
            }}
            disabled={loading || deploymentsLoading}
            className="flex items-center gap-2 rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-400 transition-colors hover:text-white hover:border-zinc-600 disabled:opacity-50"
          >
            <RefreshCw
              size={14}
              className={loading || deploymentsLoading ? "animate-spin" : ""}
            />
            Refresh
          </button>

          <label className="ml-auto flex items-center gap-2 text-sm text-zinc-400 cursor-pointer">
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

      {provider === "gcp" && selectedDeployment ? (
        <div className="mb-4 rounded-lg border border-zinc-800 bg-zinc-950/40 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium text-white">
                {describeDeployment(selectedDeployment)}
              </h3>
              <p className="mt-1 text-xs text-zinc-500">
                {selectedDeployment.platform?.gcpProject ||
                  selectedDeployment.gcpProject ||
                  "Unknown project"}
                {" • "}
                {selectedDeployment.platform?.region ||
                  selectedDeployment.region ||
                  "Unknown region"}
              </p>
            </div>
            <p className="text-xs text-zinc-500">
              Last deployed:{" "}
              {formatDateTime(
                selectedDeployment.deployedAt || selectedDeployment.updatedAt
              )}
            </p>
          </div>

          {selectedDeployment.liveError ? (
            <div className="mt-3 rounded-md border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-100">
              {selectedDeployment.liveError}
            </div>
          ) : null}
        </div>
      ) : null}

      {deploymentError ? (
        <div className="mb-4 rounded-md border border-red-900/40 bg-red-950/20 px-3 py-2 text-xs text-red-200">
          {deploymentError}
        </div>
      ) : null}

      {error ? (
        <div className="mb-4 rounded-md border border-red-900/40 bg-red-950/20 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      ) : null}

      {liveError ? (
        <div className="mb-4 rounded-md border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-100">
          {liveError}
        </div>
      ) : null}

      <div className="rounded-lg border border-zinc-800 bg-zinc-950">
        {loading && logs.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-zinc-500">
            <Loader2 size={16} className="animate-spin" />
            Loading logs...
          </div>
        ) : logs.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-sm text-zinc-500">
            {provider === "gcp" && !selectedDeploymentId
              ? "Select a deployment to view logs."
              : "No logs found"}
          </div>
        ) : (
          <div className="max-h-[640px] overflow-y-auto p-4 space-y-1 font-mono text-xs">
            {logs.map((log, index) => (
              <div key={`${log.timestamp}-${index}`} className="flex items-start gap-2 py-1">
                <span className="whitespace-nowrap shrink-0 text-zinc-600">
                  {log.timestamp || "unknown-time"}
                </span>
                <span
                  className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium border shrink-0 ${
                    levelColors[log.level] || levelColors.info
                  }`}
                >
                  {log.level.toUpperCase()}
                </span>
                {log.executionName ? (
                  <span className="shrink-0 rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400">
                    {log.executionName}
                  </span>
                ) : null}
                <span className="break-all text-zinc-300">{log.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
