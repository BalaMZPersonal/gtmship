"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle,
  Cloud,
  ExternalLink,
  Loader2,
  Rocket,
} from "lucide-react";
import Link from "next/link";
import { api } from "@/lib/api";
import {
  type GcpComputeType,
  type DashboardDeployInfraKey,
  type DashboardDeploySuccess,
  type WorkflowDeploymentOverview,
  type WorkflowExecutionHistoryEntry,
  getDeploymentInfra,
  isDashboardDeploySuccess,
  loadCloudDeploySettings,
} from "@/lib/deploy";
import { awsRegions, gcpRegions } from "@/lib/cloud-regions";
import type {
  WorkflowDeploymentPlan,
  WorkflowDeploymentPlanResponse,
  WorkflowDeployProvider,
  WorkflowListItem,
} from "@/lib/workflow-studio/types";

function buildPlanUrl(
  provider: WorkflowDeployProvider,
  region: string,
  gcpProject: string
): string {
  const params = new URLSearchParams({
    provider,
    region,
  });

  if (provider === "gcp" && gcpProject.trim()) {
    params.set("gcpProject", gcpProject.trim());
  }

  return `/api/deploy?${params.toString()}`;
}

function deploymentStatusTone(status?: string | null): string {
  const normalized = (status || "").toLowerCase();
  if (
    normalized === "success" ||
    normalized === "succeeded" ||
    normalized === "completed"
  ) {
    return "border-emerald-900/40 bg-emerald-950/20 text-emerald-200";
  }
  if (normalized === "running" || normalized === "in_progress") {
    return "border-blue-900/40 bg-blue-950/20 text-blue-200";
  }
  if (
    normalized === "failed" ||
    normalized === "error" ||
    normalized === "cancelled"
  ) {
    return "border-rose-900/40 bg-rose-950/20 text-rose-200";
  }
  return "border-zinc-800 bg-zinc-900 text-zinc-300";
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

function buildLogsHref(deploymentId: string, executionName?: string | null): string {
  const params = new URLSearchParams({
    provider: "gcp",
    deploymentId,
  });
  if (executionName) {
    params.set("executionName", executionName);
  }
  return `/deploy/logs?${params.toString()}`;
}

export default function DeployPage() {
  const [provider, setProvider] = useState<WorkflowDeployProvider>("aws");
  const [region, setRegion] = useState("us-east-1");
  const [gcpProject, setGcpProject] = useState("");
  const [deploying, setDeploying] = useState(false);
  const [status, setStatus] = useState<"idle" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [deployOutput, setDeployOutput] = useState("");
  const [result, setResult] = useState<DashboardDeploySuccess | null>(null);
  const [plans, setPlans] = useState<WorkflowDeploymentPlan[]>([]);
  const [plansLoading, setPlansLoading] = useState(false);
  const [plansError, setPlansError] = useState("");
  const [usedSharedPlanner, setUsedSharedPlanner] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [savedRegions, setSavedRegions] = useState({ aws: "us-east-1", gcp: "us-central1" });
  const [workflowList, setWorkflowList] = useState<WorkflowListItem[]>([]);
  const [selectedWorkflow, setSelectedWorkflow] = useState("");
  const [deploymentOverviewLoading, setDeploymentOverviewLoading] = useState(false);
  const [deploymentOverviewError, setDeploymentOverviewError] = useState("");
  const [deploymentOverviews, setDeploymentOverviews] = useState<
    WorkflowDeploymentOverview[]
  >([]);

  const regions = provider === "aws" ? awsRegions : gcpRegions;
  const workflowNameBySlug = useMemo(() => {
    const map = new Map<string, string>();
    for (const workflow of workflowList) {
      map.set(workflow.slug, workflow.title || workflow.slug);
      map.set(workflow.workflowId, workflow.title || workflow.workflowId);
    }
    return map;
  }, [workflowList]);

  const selectedWorkflowId = useMemo(() => {
    if (!selectedWorkflow) {
      return "";
    }

    return (
      workflowList.find((workflow) => workflow.slug === selectedWorkflow)?.workflowId ||
      selectedWorkflow
    );
  }, [selectedWorkflow, workflowList]);

  const filteredDeploymentOverviews = useMemo(() => {
    if (provider !== "gcp") {
      return [];
    }

    const normalizedProject = gcpProject.trim();
    return deploymentOverviews
      .filter((entry) => {
        if (entry.provider !== "gcp") {
          return false;
        }
        if (
          selectedWorkflowId &&
          entry.workflowId !== selectedWorkflowId &&
          entry.workflowId !== selectedWorkflow
        ) {
          return false;
        }
        return true;
      })
      .sort((left, right) => {
        const leftScore =
          (left.region === region ? 1 : 0) +
          (normalizedProject && left.gcpProject === normalizedProject ? 1 : 0);
        const rightScore =
          (right.region === region ? 1 : 0) +
          (normalizedProject && right.gcpProject === normalizedProject ? 1 : 0);
        return rightScore - leftScore;
      });
  }, [
    deploymentOverviews,
    gcpProject,
    provider,
    region,
    selectedWorkflow,
    selectedWorkflowId,
  ]);

  const primaryDeploymentOverview = filteredDeploymentOverviews[0] || null;
  const gcpComputeType: GcpComputeType | null =
    primaryDeploymentOverview?.platform?.computeType ||
    (primaryDeploymentOverview?.executionKind === "job" ? "job" : "service");
  const infra = getDeploymentInfra(provider, {
    gcpComputeType,
    includeScheduler:
      provider === "gcp" &&
      Boolean(
        result?.schedulerJobId ||
          primaryDeploymentOverview?.platform?.schedulerJobId ||
          primaryDeploymentOverview?.schedulerId
      ),
  });

  // Load saved settings and workflow list on mount
  useEffect(() => {
    (async () => {
      const settings = await loadCloudDeploySettings();
      setSavedRegions(settings.savedRegions);
      setProvider(settings.provider);
      setRegion(settings.savedRegions[settings.provider]);
      if (settings.gcpProject) {
        setGcpProject(settings.gcpProject);
      }
      setSettingsLoaded(true);
    })();

    // Load workflow list
    (async () => {
      try {
        const data = await fetch("/api/workflows").then((r) => r.json());
        if (Array.isArray(data.workflows)) {
          setWorkflowList(data.workflows);
        }
      } catch {
        // ignore
      }
    })();
  }, []);

  const handleProviderChange = (nextProvider: WorkflowDeployProvider) => {
    setProvider(nextProvider);
    setRegion(savedRegions[nextProvider]);
    setResult(null);
    setStatus("idle");
  };

  async function loadPlans() {
    setPlansLoading(true);
    setPlansError("");

    try {
      const response = await fetch(buildPlanUrl(provider, region, gcpProject), {
        cache: "no-store",
      });
      const data = (await response.json()) as
        | WorkflowDeploymentPlanResponse
        | { error?: string };

      if (!response.ok) {
        const message = "error" in data ? data.error : undefined;
        throw new Error(message || "Failed to load deployment plan.");
      }

      const planData = data as WorkflowDeploymentPlanResponse;
      setPlans(planData.plans || []);
      setUsedSharedPlanner(Boolean(planData.usedSharedPlanner));
    } catch (error) {
      setPlans([]);
      setUsedSharedPlanner(false);
      setPlansError(
        error instanceof Error
          ? error.message
          : "Failed to load deployment plan."
      );
    } finally {
      setPlansLoading(false);
    }
  }

  const loadDeploymentOverviews = useCallback(async () => {
    if (provider !== "gcp") {
      setDeploymentOverviews([]);
      setDeploymentOverviewError("");
      return;
    }

    setDeploymentOverviewLoading(true);
    setDeploymentOverviewError("");
    try {
      const fetchOverviews = async () => {
        const overviews = await api.getWorkflowDeployments({
          provider: "gcp",
          includeLive: true,
          executionLimit: 5,
        });
        return Array.isArray(overviews) ? overviews : [];
      };

      let overviews = await fetchOverviews();
      if (overviews.length === 0) {
        await api.reconcileWorkflowDeployments({
          provider: "gcp",
          region,
          gcpProject: gcpProject.trim() || undefined,
          workflow: selectedWorkflow || undefined,
        });
        overviews = await fetchOverviews();
      }

      setDeploymentOverviews(overviews);
    } catch (overviewError) {
      setDeploymentOverviews([]);
      setDeploymentOverviewError(
        overviewError instanceof Error
          ? overviewError.message
          : "Failed to load deployment overview."
      );
    } finally {
      setDeploymentOverviewLoading(false);
    }
  }, [gcpProject, provider, region, selectedWorkflow]);

  useEffect(() => {
    if (!settingsLoaded) return;
    void loadPlans();
  }, [provider, region, gcpProject, settingsLoaded]);

  useEffect(() => {
    if (!settingsLoaded) return;
    void loadDeploymentOverviews();
  }, [gcpProject, provider, region, selectedWorkflow, settingsLoaded, loadDeploymentOverviews]);

  const handleDeploy = async () => {
    setDeploying(true);
    setStatus("idle");
    setErrorMessage("");
    setDeployOutput("");
    setResult(null);
    try {
      const res = await api.deploy({
        provider,
        region,
        gcpProject: provider === "gcp" ? gcpProject : undefined,
        projectName: "gtmship",
        workflow: selectedWorkflow || undefined,
      });

      if (!isDashboardDeploySuccess(res)) {
        setStatus("error");
        setErrorMessage(res.error);
        if (res.output) setDeployOutput(res.output);
      } else {
        setStatus("success");
        setResult(res);
        void loadDeploymentOverviews();
      }
    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : "Deployment failed");
    }
    setDeploying(false);
  };

  const resolveInfraValue = (key: DashboardDeployInfraKey): string | null => {
    const deployedValue = result?.[key];
    if (typeof deployedValue === "string" && deployedValue.trim()) {
      return deployedValue.trim();
    }

    if (provider === "gcp" && primaryDeploymentOverview) {
      if (key === "apiEndpoint") {
        return (
          primaryDeploymentOverview.platform?.endpointUrl ||
          primaryDeploymentOverview.endpointUrl ||
          null
        );
      }
      if (key === "computeId") {
        return primaryDeploymentOverview.platform?.computeName || null;
      }
      if (key === "schedulerJobId") {
        return (
          primaryDeploymentOverview.platform?.schedulerJobId ||
          primaryDeploymentOverview.schedulerId ||
          null
        );
      }
    }

    return null;
  };

  return (
    <div className="max-w-5xl p-8">
      <div className="mb-6">
        <h2 className="text-xl font-semibold">Deploy</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Review the deployment plan before shipping workflows.
        </p>
      </div>

      <div className="rounded-lg border border-zinc-800 p-6 space-y-5">
        <div>
          <label className="mb-1.5 block text-xs text-zinc-500">
            Cloud Provider
          </label>
          <div className="flex gap-2">
            <button
              onClick={() => handleProviderChange("aws")}
              className={`flex items-center gap-2 rounded-md border px-4 py-2 text-sm transition-colors ${
                provider === "aws"
                  ? "border-blue-600 bg-blue-600/10 text-white"
                  : "border-zinc-700 text-zinc-400 hover:border-zinc-600"
              }`}
            >
              <Cloud size={14} /> AWS
            </button>
            <button
              onClick={() => handleProviderChange("gcp")}
              className={`flex items-center gap-2 rounded-md border px-4 py-2 text-sm transition-colors ${
                provider === "gcp"
                  ? "border-blue-600 bg-blue-600/10 text-white"
                  : "border-zinc-700 text-zinc-400 hover:border-zinc-600"
              }`}
            >
              <Cloud size={14} /> GCP
            </button>
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-xs text-zinc-500">Region</label>
          <select
            value={region}
            onChange={(event) => setRegion(event.target.value)}
            className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-600"
          >
            {regions.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>

        {provider === "gcp" ? (
          <div>
            <label className="mb-1.5 block text-xs text-zinc-500">
              GCP Project ID
            </label>
            <input
              type="text"
              value={gcpProject}
              onChange={(event) => setGcpProject(event.target.value)}
              placeholder="my-gcp-project"
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white placeholder-zinc-600 outline-none focus:border-blue-600"
            />
          </div>
        ) : null}

        <div>
          <label className="mb-1.5 block text-xs text-zinc-500">Workflow</label>
          <select
            value={selectedWorkflow}
            onChange={(event) => setSelectedWorkflow(event.target.value)}
            className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-600"
          >
            <option value="">All workflows</option>
            {workflowList.map((wf) => (
              <option key={wf.slug} value={wf.slug}>
                {wf.title || wf.slug}
              </option>
            ))}
          </select>
        </div>

        <button
          onClick={handleDeploy}
          disabled={deploying || (provider === "gcp" && !gcpProject)}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {deploying ? (
            <>
              <Loader2 size={14} className="animate-spin" /> Deploying...
            </>
          ) : (
            <>
              <Rocket size={14} /> Deploy to {provider.toUpperCase()} ({region})
            </>
          )}
        </button>

        {status === "success" ? (
          <div className="flex items-center gap-2 rounded-md border border-green-800 bg-green-900/20 px-4 py-3 text-sm text-green-400">
            <CheckCircle size={14} />
            Deployment completed successfully.
          </div>
        ) : null}

        {status === "error" ? (
          <div className="rounded-md border border-red-800 bg-red-900/20 px-4 py-3 text-sm text-red-400">
            <div className="flex items-center gap-2">
              <AlertCircle size={14} />
              {errorMessage || "Deployment failed."}
            </div>
            {deployOutput ? (
              <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded border border-red-900/40 bg-black/30 p-3 text-xs text-red-300/80">
                {deployOutput}
              </pre>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="mt-6 rounded-lg border border-zinc-800 p-6">
        <h3 className="mb-3 text-sm font-medium">Infrastructure</h3>
        <div className="space-y-2 text-xs text-zinc-500">
          {infra.map((item) => (
            <div key={item.key} className="flex justify-between">
              <span>{item.label}</span>
              <span
                className={
                  resolveInfraValue(item.key) ? "text-green-400" : "text-zinc-600"
                }
              >
                {resolveInfraValue(item.key) || "Not deployed"}
              </span>
            </div>
          ))}
        </div>
      </div>

      {provider === "gcp" ? (
        <div className="mt-6 rounded-lg border border-zinc-800 p-6">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium">GCP Deployment Status</h3>
            <button
              onClick={() => void loadDeploymentOverviews()}
              disabled={deploymentOverviewLoading}
              className="rounded-md border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-900 disabled:opacity-50"
            >
              {deploymentOverviewLoading ? "Refreshing..." : "Refresh"}
            </button>
          </div>

          {deploymentOverviewError ? (
            <div className="rounded-md border border-red-900/40 bg-red-950/20 px-3 py-2 text-xs text-red-200">
              {deploymentOverviewError}
            </div>
          ) : null}

          {!deploymentOverviewLoading && filteredDeploymentOverviews.length === 0 && !deploymentOverviewError ? (
            <p className="text-xs text-zinc-500">
              No GCP deployment records found for the current filters.
            </p>
          ) : null}

          <div className="space-y-3">
            {filteredDeploymentOverviews.map((deployment) => {
              const executions = deployment.recentExecutions || [];
              const latestExecution: WorkflowExecutionHistoryEntry | null =
                executions[0] || null;
              return (
                <div
                  key={deployment.id}
                  className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-white">
                        {workflowNameBySlug.get(deployment.workflowId) || deployment.workflowId}
                      </p>
                      <p className="mt-1 text-xs text-zinc-500">
                        {deployment.platform?.computeType === "job"
                          ? "Cloud Run Job"
                          : "Cloud Run Service"}
                        {" • "}
                        {deployment.platform?.computeName || "Unknown compute target"}
                      </p>
                    </div>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10px] ${deploymentStatusTone(
                        latestExecution?.status || deployment.status
                      )}`}
                    >
                      {(latestExecution?.status || deployment.status || "unknown").toUpperCase()}
                    </span>
                  </div>

                  <div className="mt-3 grid gap-2 text-xs text-zinc-400 md:grid-cols-2">
                    <p>
                      <span className="text-zinc-500">Region:</span>{" "}
                      {deployment.platform?.region || deployment.region || "N/A"}
                    </p>
                    <p>
                      <span className="text-zinc-500">Project:</span>{" "}
                      {deployment.platform?.gcpProject ||
                        deployment.gcpProject ||
                        "N/A"}
                    </p>
                    <p>
                      <span className="text-zinc-500">Scheduler:</span>{" "}
                      {deployment.platform?.schedulerJobId ||
                        deployment.schedulerId ||
                        "Not configured"}
                    </p>
                    <p>
                      <span className="text-zinc-500">Last deployed:</span>{" "}
                      {formatDateTime(deployment.deployedAt || deployment.updatedAt)}
                    </p>
                  </div>

                  {deployment.platform?.endpointUrl ? (
                    <p className="mt-2 break-all text-xs text-zinc-400">
                      <span className="text-zinc-500">Endpoint:</span>{" "}
                      {deployment.platform.endpointUrl}
                    </p>
                  ) : null}

                  {deployment.liveError ? (
                    <div className="mt-3 rounded-md border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-100">
                      {deployment.liveError}
                    </div>
                  ) : null}

                  {executions.length > 0 ? (
                    <div className="mt-3 space-y-2">
                      <p className="text-[11px] uppercase tracking-wide text-zinc-500">
                        Recent Runs
                      </p>
                      {executions.map((execution, index) => (
                        <div
                          key={`${deployment.id}-run-${execution.executionName || index}`}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-800 px-3 py-2 text-xs text-zinc-300"
                        >
                          <div className="space-y-1">
                            <p className="break-all text-zinc-200">
                              {execution.executionName || "execution"}
                            </p>
                            <p className="text-zinc-500">
                              {formatDateTime(execution.startedAt)}
                              {" -> "}
                              {formatDateTime(execution.completedAt)}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <span
                              className={`rounded-full border px-2 py-0.5 text-[10px] ${deploymentStatusTone(
                                execution.status
                              )}`}
                            >
                              {(execution.status || "unknown").toUpperCase()}
                            </span>
                            <Link
                              href={buildLogsHref(
                                deployment.id,
                                execution.executionName || undefined
                              )}
                              className="text-[11px] text-blue-300 hover:text-blue-200"
                            >
                              Logs
                            </Link>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-3 text-xs text-zinc-500">
                      No recent executions reported yet.
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="mt-6 rounded-lg border border-zinc-800 p-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium">Deployment Plan</h3>
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-zinc-500">
              planner: {usedSharedPlanner ? "shared-engine" : "dashboard-fallback"}
            </span>
            <button
              onClick={() => void loadPlans()}
              disabled={plansLoading}
              className="rounded-md border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-900 disabled:opacity-50"
            >
              {plansLoading ? "Refreshing..." : "Refresh"}
            </button>
          </div>
        </div>

        {plansError ? (
          <div className="rounded-md border border-red-900/40 bg-red-950/20 px-3 py-2 text-xs text-red-200">
            {plansError}
          </div>
        ) : null}

        {!plansLoading && plans.length === 0 && !plansError ? (
          <p className="text-xs text-zinc-500">
            No workflows found. Create or save a workflow in Workflow Studio.
          </p>
        ) : null}

        <div className="space-y-3">
          {plans
            .filter((plan) => !selectedWorkflowId || plan.workflowId === selectedWorkflowId)
            .map((plan) => (
              <div
                key={plan.workflowId}
                className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-white">
                      {plan.workflowTitle || plan.workflowId}
                    </p>
                    <p className="mt-1 text-xs text-zinc-500">
                      trigger: {plan.triggerType} • execution: {plan.executionKind}
                    </p>
                  </div>
                  <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400">
                    {plan.provider.toUpperCase()} {plan.region || ""}
                  </span>
                </div>

                <div className="mt-3 grid gap-2 text-xs text-zinc-400 md:grid-cols-2">
                  <p>
                    <span className="text-zinc-500">Auth mode:</span> {plan.authMode}
                  </p>
                  <p>
                    <span className="text-zinc-500">Trigger summary:</span>{" "}
                    {plan.summary?.endpoint ||
                      plan.summary?.schedule ||
                      plan.summary?.event ||
                      plan.summary?.trigger ||
                      plan.trigger.description}
                  </p>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  {plan.resources.map((resource) => (
                    <span
                      key={`${plan.workflowId}-${resource.name}`}
                      className="rounded-full border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-300"
                    >
                      {resource.summary || resource.kind}
                    </span>
                  ))}
                </div>

                <div className="mt-3">
                  <p className="text-[11px] uppercase tracking-wide text-zinc-500">
                    Auth bindings
                  </p>
                  {plan.bindings.length === 0 ? (
                    <p className="mt-1 text-xs text-zinc-600">No bindings configured.</p>
                  ) : (
                    <div className="mt-1 space-y-1.5 text-xs text-zinc-400">
                      {plan.bindings.map((binding) => (
                        <p key={`${plan.workflowId}-${binding.providerSlug}`}>
                          {binding.providerSlug}: {binding.selector.type}
                          {binding.selector.value
                            ? ` (${binding.selector.value})`
                            : ""}
                        </p>
                      ))}
                    </div>
                  )}
                </div>

                {plan.warnings.length > 0 ? (
                  <div className="mt-3 rounded-md border border-amber-900/40 bg-amber-950/20 px-3 py-2">
                    <p className="text-[11px] uppercase tracking-wide text-amber-200">
                      Warnings
                    </p>
                    <div className="mt-1 space-y-1 text-xs text-amber-100">
                      {plan.warnings.map((warning, index) => (
                        <p key={`${plan.workflowId}-warn-${index}`}>{warning}</p>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
        </div>
      </div>

      <div className="mt-6">
        <Link
          href={
            provider === "gcp" && primaryDeploymentOverview
              ? buildLogsHref(
                  primaryDeploymentOverview.id,
                  primaryDeploymentOverview.recentExecutions?.[0]
                    ?.executionName || undefined
                )
              : "/deploy/logs"
          }
          className="flex items-center gap-2 text-sm text-zinc-400 transition-colors hover:text-white"
        >
          <ExternalLink size={14} />
          View Logs
        </Link>
      </div>
    </div>
  );
}
