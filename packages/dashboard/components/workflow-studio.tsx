"use client";

import {
  FormEvent,
  ReactNode,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { useChat } from "ai/react";
import type { UIMessage } from "ai";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertCircle,
  ArrowLeft,
  Brain,
  CheckCircle2,
  ChevronRight,
  Code2,
  FileJson,
  FolderPlus,
  Loader2,
  Package,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Save,
  Sparkles,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { api, type MemoryRecord } from "@/lib/api";
import type { AiModelOption } from "@/lib/ai-config";
import {
  buildDeploymentLogsHref,
  buildWorkflowSecretSyncSummary,
  deriveWorkflowDeploymentRunTarget,
  type DashboardDeployInfraKey,
  formatWorkflowDeploymentDisplayTarget,
  type GcpComputeType,
  type ResolvedCloudDeploySettings,
  type WorkflowDeployTarget,
  type WorkflowDeploymentOverview,
  type WorkflowExecutionHistoryEntry,
  getDeploymentInfra,
  getScopedWorkflowDeployments,
  isDashboardDeploySuccess,
  loadCloudDeploySettings,
  resolveWorkflowDeployTarget,
  workflowDeploymentTargetsMatch,
} from "@/lib/deploy";
import { firstDisplayValue } from "@/lib/display-value";
import { DeploymentSecretSyncCard } from "@/components/deployment-secret-sync-card";
import { MermaidDiagram } from "@/components/mermaid-diagram";
import { ToolRenderer } from "@/components/agent/tool-renderers";
import { buildWorkflowPlanFromArtifact } from "@/lib/workflow-studio/deploy-plan";
import {
  WORKFLOW_TRANSCRIPT_HARD_LIMIT_TOKENS,
  WORKFLOW_TRANSCRIPT_MAX_PENDING_MESSAGE_TOKENS,
  WORKFLOW_TRANSCRIPT_TRIGGER_TOKENS,
  applyTranscriptCompaction,
  buildFallbackTranscriptSummary,
  buildTranscriptCompactionPlan,
  createTranscriptTooLargeError,
  estimateTextTokens,
  estimateVisibleTranscriptTokens,
  getArtifactTranscriptCompaction,
  stripArchivedMessagesFromCompaction,
} from "@/lib/workflow-studio/transcript-compaction";
import { deriveWorkflowStudioState } from "@/lib/workflow-studio/transcript";
import type {
  WorkflowBindingSelectorType,
  StoredWorkflowRecord,
  WorkflowAccessRequirement,
  WorkflowAiConfig,
  WorkflowAiProviderSlug,
  WorkflowBuildResult,
  WorkflowDeploymentPlan,
  WorkflowDeploymentRun,
  WorkflowDeployTargetMode,
  WorkflowListItem,
  WorkflowListingResponse,
  WorkflowPendingApproval,
  WorkflowProjectDeploymentDefaults,
  WorkflowPreviewLogLevel,
  WorkflowPreviewResult,
  WorkflowStudioArtifact,
  WorkflowStudioMessage,
  WorkflowStudioMessagePart,
  WorkflowStudioToolInvocation,
  WorkflowTranscriptCompaction,
  WorkflowValidationIssue,
  WorkflowValidationReport,
  WorkflowWriteCheckpoint,
} from "@/lib/workflow-studio/types";

type StudioTab =
  | "flow"
  | "deploy"
  | "code"
  | "validation"
  | "preview"
  | "build";

interface WorkflowBuildRunResponse {
  artifact: WorkflowStudioArtifact;
  build: WorkflowBuildResult;
  repaired: boolean;
  assistantMessage?: string;
  blockedAccesses?: WorkflowAccessRequirement[];
}

interface WorkflowPreviewRunResponse {
  artifact: WorkflowStudioArtifact;
  preview: WorkflowPreviewResult;
}

type WorkflowStudioDeployResponse =
  | {
      success: true;
      provider: "aws" | "gcp" | "local";
      region?: string;
      projectName: string;
      apiEndpoint?: string | null;
      computeId?: string | null;
      databaseEndpoint?: string | null;
      storageBucket?: string | null;
      schedulerJobId?: string | null;
      output?: string;
      artifact?: WorkflowStudioArtifact;
    }
  | {
      error: string;
      output?: string;
      artifact?: WorkflowStudioArtifact;
    };

interface WorkflowConversationPanelHandle {
  sendPrompt: (content: string) => Promise<void>;
  cancelRun: () => void;
}

interface WorkflowConversationPanelProps {
  sessionKey: string;
  initialMessages: WorkflowStudioMessage[];
  artifact: WorkflowStudioArtifact | null;
  onTranscriptChange: (messages: WorkflowStudioMessage[]) => void;
  onArtifactSync: (
    nextArtifact: WorkflowStudioArtifact | null,
    blockedAccesses: WorkflowAccessRequirement[]
  ) => void;
  onBusyChange: (value: boolean) => void;
  onError: (message: string | null) => void;
}

type WorkflowStudioProject = {
  name: string;
  path: string;
  isDefault: boolean;
  workflowCount: number;
};

type WorkflowConnectionBlockerStatus = "missing" | "blocked" | "attention";

function serializeForStateComparison(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function areWorkflowMessagesEqual(
  left: WorkflowStudioMessage[],
  right: WorkflowStudioMessage[]
): boolean {
  return serializeForStateComparison(left) === serializeForStateComparison(right);
}

function areWorkflowArtifactsEqual(
  left: WorkflowStudioArtifact | null,
  right: WorkflowStudioArtifact | null
): boolean {
  return serializeForStateComparison(left) === serializeForStateComparison(right);
}

function areWorkflowAccessRequirementsEqual(
  left: WorkflowAccessRequirement[],
  right: WorkflowAccessRequirement[]
): boolean {
  return serializeForStateComparison(left) === serializeForStateComparison(right);
}

interface WorkflowConnectionBlocker {
  key: string;
  label: string;
  detail: string;
  status: WorkflowConnectionBlockerStatus;
  providerSlug?: string;
  purpose?: string;
}

interface WorkflowStudioConnectionRecord {
  id: string;
  label?: string | null;
  status: string;
  createdAt?: string;
  provider: {
    slug: string;
    name?: string;
  };
}

type WorkflowAiBindingResolutionStatus = "resolved" | "missing" | "ambiguous";

interface WorkflowAiBindingResolution {
  providerSlug: WorkflowAiProviderSlug;
  selectorType: WorkflowBindingSelectorType;
  status: WorkflowAiBindingResolutionStatus;
  message: string;
  connection: WorkflowStudioConnectionRecord | null;
  candidates: WorkflowStudioConnectionRecord[];
}

const WORKFLOW_AI_PROVIDER_LABELS: Record<WorkflowAiProviderSlug, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
};

const WORKFLOW_AI_PROVIDER_ORDER: WorkflowAiProviderSlug[] = [
  "openai",
  "anthropic",
];

function isWorkflowAiProviderSlug(value: string): value is WorkflowAiProviderSlug {
  return value === "openai" || value === "anthropic";
}

function mapWorkflowAiProviderToModelProvider(
  providerSlug: WorkflowAiProviderSlug
): "openai" | "claude" {
  return providerSlug === "openai" ? "openai" : "claude";
}

function normalizeWorkflowAiConfigs(
  aiConfigs?: WorkflowAiConfig[]
): WorkflowAiConfig[] {
  const normalized = new Map<WorkflowAiProviderSlug, WorkflowAiConfig>();

  for (const config of aiConfigs || []) {
    if (!isWorkflowAiProviderSlug(config.providerSlug)) {
      continue;
    }

    normalized.set(config.providerSlug, {
      providerSlug: config.providerSlug,
      ...(config.model?.trim() ? { model: config.model.trim() } : {}),
    });
  }

  return WORKFLOW_AI_PROVIDER_ORDER.flatMap((providerSlug) => {
    const config = normalized.get(providerSlug);
    return config ? [config] : [];
  });
}

function mergeWorkflowAiConfigs(
  nextAiConfigs?: WorkflowAiConfig[],
  currentAiConfigs?: WorkflowAiConfig[]
): WorkflowAiConfig[] {
  const merged = new Map<WorkflowAiProviderSlug, WorkflowAiConfig>();

  for (const config of normalizeWorkflowAiConfigs(nextAiConfigs)) {
    merged.set(config.providerSlug, config);
  }

  for (const config of normalizeWorkflowAiConfigs(currentAiConfigs)) {
    const existing = merged.get(config.providerSlug);
    merged.set(config.providerSlug, {
      ...existing,
      providerSlug: config.providerSlug,
      ...(config.model?.trim()
        ? { model: config.model.trim() }
        : existing?.model
          ? { model: existing.model }
          : {}),
    });
  }

  return normalizeWorkflowAiConfigs(Array.from(merged.values()));
}

function sortConnectionsByCreatedAtDesc(
  connections: WorkflowStudioConnectionRecord[]
): WorkflowStudioConnectionRecord[] {
  return [...connections].sort((left, right) => {
    const leftTime = left.createdAt ? Date.parse(left.createdAt) : NaN;
    const rightTime = right.createdAt ? Date.parse(right.createdAt) : NaN;

    if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime)) {
      return rightTime - leftTime;
    }

    if (!Number.isNaN(rightTime)) {
      return 1;
    }

    if (!Number.isNaN(leftTime)) {
      return -1;
    }

    return 0;
  });
}

function resolveWorkflowAiBinding(
  providerSlug: WorkflowAiProviderSlug,
  binding: NonNullable<WorkflowStudioArtifact["bindings"]>[number] | undefined,
  connections: WorkflowStudioConnectionRecord[]
): WorkflowAiBindingResolution {
  const activeProviderConnections = sortConnectionsByCreatedAtDesc(
    connections.filter(
      (connection) =>
        connection.status === "active" && connection.provider.slug === providerSlug
    )
  );
  const selectorType = binding?.selector.type || "latest_active";
  const selectorConnectionId = binding?.selector.connectionId?.trim() || "";
  const selectorLabel = binding?.selector.label?.trim() || "";

  if (selectorType === "latest_active") {
    if (activeProviderConnections.length === 1) {
      return {
        providerSlug,
        selectorType,
        status: "resolved",
        message: "Resolved to the only active connection for this provider.",
        connection: activeProviderConnections[0],
        candidates: activeProviderConnections,
      };
    }

    if (activeProviderConnections.length > 1) {
      return {
        providerSlug,
        selectorType,
        status: "ambiguous",
        message:
          "Binding is latest_active and multiple active connections match this provider.",
        connection: null,
        candidates: activeProviderConnections,
      };
    }

    return {
      providerSlug,
      selectorType,
      status: "missing",
      message: "No active connections found for this provider.",
      connection: null,
      candidates: [],
    };
  }

  if (selectorType === "connection_id") {
    if (!selectorConnectionId) {
      return {
        providerSlug,
        selectorType,
        status: "missing",
        message: "Binding is missing a connection_id value.",
        connection: null,
        candidates: activeProviderConnections,
      };
    }

    const matches = sortConnectionsByCreatedAtDesc(
      connections.filter(
        (connection) =>
          connection.provider.slug === providerSlug &&
          connection.id === selectorConnectionId
      )
    );

    if (matches.length === 1) {
      const connection = matches[0];
      const activeNote =
        connection.status === "active"
          ? ""
          : ` The selected connection is ${connection.status}.`;

      return {
        providerSlug,
        selectorType,
        status: "resolved",
        message: `Resolved by connection_id (${selectorConnectionId}).${activeNote}`,
        connection,
        candidates: matches,
      };
    }

    return {
      providerSlug,
      selectorType,
      status: "missing",
      message:
        matches.length === 0
          ? `No connection matched id "${selectorConnectionId}".`
          : `Multiple connections matched id "${selectorConnectionId}".`,
      connection: null,
      candidates: matches,
    };
  }

  if (!selectorLabel) {
    return {
      providerSlug,
      selectorType,
      status: "missing",
      message: "Binding is missing a label value.",
      connection: null,
      candidates: activeProviderConnections,
    };
  }

  const normalizedLabel = selectorLabel.toLowerCase();
  const matches = activeProviderConnections.filter(
    (connection) => (connection.label || "").trim().toLowerCase() === normalizedLabel
  );

  if (matches.length === 1) {
    return {
      providerSlug,
      selectorType,
      status: "resolved",
      message: `Resolved by label "${selectorLabel}".`,
      connection: matches[0],
      candidates: matches,
    };
  }

  if (matches.length > 1) {
    return {
      providerSlug,
      selectorType,
      status: "ambiguous",
      message: `Label "${selectorLabel}" matched multiple active connections.`,
      connection: null,
      candidates: matches,
    };
  }

  return {
    providerSlug,
    selectorType,
    status: "missing",
    message: `No active connection matched label "${selectorLabel}".`,
    connection: null,
    candidates: [],
  };
}

function describeWorkflowAiResolution(
  resolution: WorkflowAiBindingResolution
): string {
  if (resolution.status === "resolved" && resolution.connection) {
    return [
      resolution.message,
      resolution.connection.label
        ? `Using "${resolution.connection.label}".`
        : `Using ${resolution.connection.id}.`,
    ].join(" ");
  }

  if (resolution.status === "ambiguous") {
    return `${resolution.message} Pin a specific connection_id to load live models.`;
  }

  return resolution.message;
}

function buildWorkflowAiModelPlaceholder(
  resolution: WorkflowAiBindingResolution | undefined
): string {
  if (!resolution) {
    return "Select a provider binding first";
  }

  if (resolution.status === "resolved") {
    return "Select a model";
  }

  return "Pin a specific connection first";
}

function buildWorkflowAiModelDisabledReason(
  providerSlug: WorkflowAiProviderSlug,
  resolution: WorkflowAiBindingResolution | undefined
): string {
  if (!resolution) {
    return `Add a ${WORKFLOW_AI_PROVIDER_LABELS[providerSlug]} binding to load live models.`;
  }

  if (resolution.status === "resolved") {
    return "";
  }

  return describeWorkflowAiResolution(resolution);
}

function formatWorkflowAiModelError(
  providerSlug: WorkflowAiProviderSlug,
  error?: string
): string {
  if (!error) {
    return "";
  }

  return `${WORKFLOW_AI_PROVIDER_LABELS[providerSlug]} model lookup failed: ${error}`;
}

function withSelectedModelOption(
  options: AiModelOption[],
  providerSlug: WorkflowAiProviderSlug,
  selectedModel?: string
): AiModelOption[] {
  const normalizedSelectedModel = selectedModel?.trim() || "";

  if (
    !normalizedSelectedModel ||
    options.some((option) => option.id === normalizedSelectedModel)
  ) {
    return options;
  }

  return [
    {
      id: normalizedSelectedModel,
      displayName: `${normalizedSelectedModel} (saved)`,
      provider: mapWorkflowAiProviderToModelProvider(providerSlug),
      createdAt: null,
    },
    ...options,
  ];
}

function withDeploymentPlan(
  artifact: WorkflowStudioArtifact,
  defaults?: WorkflowProjectDeploymentDefaults
): WorkflowStudioArtifact {
  return {
    ...artifact,
    deploymentPlan: buildWorkflowPlanFromArtifact(artifact, defaults),
  };
}

function emptyArtifact(
  defaults?: WorkflowProjectDeploymentDefaults
): WorkflowStudioArtifact {
  return withDeploymentPlan({
    slug: "custom-workflow",
    title: "Untitled Workflow",
    summary:
      "Describe a workflow in chat to generate code and a data-flow diagram.",
    description: "",
    mermaid:
      "flowchart LR\n  trigger([Trigger]) --> workflow[Workflow]\n  workflow --> output([Result])",
    code: "",
    samplePayload: "{}",
    requiredAccesses: [],
    writeCheckpoints: [],
    chatSummary: "",
    messages: [],
    transcriptCompaction: undefined,
    deploy: undefined,
    triggerConfig: undefined,
    bindings: [],
    aiConfigs: [],
  }, defaults);
}

function defaultRegionForProvider(
  provider: "aws" | "gcp" | "local",
  defaults?: WorkflowProjectDeploymentDefaults
): string {
  if (defaults?.provider === provider && defaults.region) {
    return defaults.region;
  }

  return provider === "gcp"
    ? "us-central1"
    : provider === "local"
      ? "local"
      : "us-east-1";
}

const LOCAL_DEPLOY_UNSUPPORTED_WARNING =
  "Local deployments currently support only manual and schedule triggers.";

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

function summarizeDeploymentTrigger(
  plan: Pick<WorkflowDeploymentPlan, "trigger">
): string {
  return (
    firstDisplayValue(
      plan.trigger.endpoint,
      plan.trigger.cron,
      plan.trigger.eventName,
      plan.trigger.description
    ) || "Trigger details unavailable"
  );
}

function formatProviderComputeLabel(
  provider: "aws" | "gcp" | "local",
  computeType?: string | null
): string {
  if (provider === "local") {
    return "Local Workflow Job";
  }

  if (provider === "aws") {
    return "Lambda Function";
  }

  return computeType === "job" ? "Cloud Run Job" : "Cloud Run Service";
}

function truncateIssueContext(value: string | undefined, maxChars = 3000): string {
  if (!value) {
    return "";
  }

  return value.length <= maxChars
    ? value
    : `${value.slice(0, maxChars)}\n\n... (issue details truncated)`;
}

function getPreviewLogLevelClassName(level: WorkflowPreviewLogLevel): string {
  switch (level) {
    case "error":
      return "bg-rose-900/40 text-rose-300";
    case "warn":
      return "bg-amber-900/40 text-amber-300";
    case "info":
      return "bg-sky-900/40 text-sky-300";
    case "debug":
      return "bg-violet-900/40 text-violet-300";
    default:
      return "bg-zinc-800 text-zinc-300";
  }
}

function formatPreviewLogsForPrompt(
  preview: WorkflowPreviewResult,
  maxEntries = 24
): string {
  return (preview.logs || [])
    .slice(-maxEntries)
    .map(
      (entry) =>
        `[${entry.level.toUpperCase()} ${formatDateTime(entry.timestamp)}] ${entry.message}`
    )
    .join("\n");
}

type WorkflowCheckpointProgressStatus = "approved" | "current" | "pending";

interface WorkflowCheckpointProgressItem {
  id: string;
  label: string;
  description: string;
  method: string;
  target: string;
  status: WorkflowCheckpointProgressStatus;
}

function getCheckpointTarget(checkpoint: WorkflowWriteCheckpoint): string {
  return checkpoint.providerSlug || checkpoint.url || checkpoint.id;
}

function buildCheckpointProgress(
  checkpoints: WorkflowWriteCheckpoint[],
  approvedCheckpoints: string[],
  pendingApproval?: WorkflowPendingApproval
): WorkflowCheckpointProgressItem[] {
  const approved = new Set(approvedCheckpoints);
  const items = checkpoints.map((checkpoint) => ({
    id: checkpoint.id,
    label: checkpoint.label,
    description: checkpoint.description,
    method: checkpoint.method,
    target: getCheckpointTarget(checkpoint),
    status: approved.has(checkpoint.id)
      ? ("approved" as const)
      : pendingApproval?.checkpoint === checkpoint.id
        ? ("current" as const)
        : ("pending" as const),
  }));

  if (
    pendingApproval &&
    !items.some((item) => item.id === pendingApproval.checkpoint)
  ) {
    items.push({
      id: pendingApproval.checkpoint,
      label: pendingApproval.checkpoint,
      description:
        pendingApproval.description ||
        "This step wants to perform an external write.",
      method: pendingApproval.method,
      target: pendingApproval.target,
      status: approved.has(pendingApproval.checkpoint) ? "approved" : "current",
    });
  }

  return items;
}

function getCheckpointStatusClasses(
  status: WorkflowCheckpointProgressStatus
): string {
  switch (status) {
    case "approved":
      return "border-emerald-900/40 bg-emerald-950/20 text-emerald-100";
    case "current":
      return "border-amber-900/40 bg-amber-950/20 text-amber-100";
    default:
      return "border-zinc-800 bg-zinc-950/40 text-zinc-300";
  }
}

function getCheckpointStatusLabel(
  status: WorkflowCheckpointProgressStatus
): string {
  switch (status) {
    case "approved":
      return "Approved";
    case "current":
      return "Awaiting approval";
    default:
      return "Pending later";
  }
}

function CheckpointApprovalCallout({
  title,
  pendingApproval,
  progress,
  running,
  disabled,
  primaryLabel,
  runningLabel,
  onApproveNext,
  onApproveAllRemaining,
}: {
  title: string;
  pendingApproval?: WorkflowPendingApproval;
  progress: WorkflowCheckpointProgressItem[];
  running: boolean;
  disabled: boolean;
  primaryLabel: string;
  runningLabel: string;
  onApproveNext: () => void;
  onApproveAllRemaining: () => void;
}) {
  const approvedCount = progress.filter(
    (checkpoint) => checkpoint.status === "approved"
  ).length;
  const remainingCheckpoints = progress.filter(
    (checkpoint) => checkpoint.status !== "approved"
  );
  const hasMultipleRemaining = remainingCheckpoints.length > 1;

  return (
    <div className="mt-4 rounded-lg border border-amber-900/40 bg-amber-950/20 px-3 py-3 text-xs text-amber-100">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-medium">{title}</p>
          {pendingApproval ? (
            <p className="mt-1 text-amber-200/90">
              Next checkpoint: {pendingApproval.checkpoint}
            </p>
          ) : null}
          <p className="mt-1">
            Approve the next write step, or approve every remaining checkpoint
            to finish the run in one pass.
          </p>
          {pendingApproval ? (
            <p className="mt-1 text-amber-200/80">
              {pendingApproval.method} &middot; {pendingApproval.target}
            </p>
          ) : null}
        </div>
        {progress.length > 0 ? (
          <span className="rounded-full border border-amber-800/60 px-2 py-0.5 text-[10px] text-amber-200">
            {approvedCount}/{progress.length} approved
          </span>
        ) : null}
      </div>

      {progress.length > 0 ? (
        <div className="mt-3 space-y-2">
          {progress.map((checkpoint) => (
            <div
              key={checkpoint.id}
              className={cn(
                "rounded-lg border px-3 py-2",
                getCheckpointStatusClasses(checkpoint.status)
              )}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium text-white">{checkpoint.label}</p>
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-black/20 px-2 py-0.5 text-[10px] uppercase tracking-wide">
                    {checkpoint.method}
                  </span>
                  <span className="rounded-full bg-black/20 px-2 py-0.5 text-[10px]">
                    {getCheckpointStatusLabel(checkpoint.status)}
                  </span>
                </div>
              </div>
              <p className="mt-1 opacity-90">{checkpoint.description}</p>
              <p className="mt-1 text-[11px] opacity-70">{checkpoint.target}</p>
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={onApproveNext}
          disabled={disabled || !pendingApproval}
          className="flex items-center gap-2 rounded-md bg-amber-400 px-3 py-2 text-xs font-medium text-zinc-950 disabled:opacity-50"
        >
          {running ? <Loader2 size={12} className="animate-spin" /> : null}
          {running ? runningLabel : primaryLabel}
        </button>
        {hasMultipleRemaining ? (
          <button
            onClick={onApproveAllRemaining}
            disabled={disabled}
            className="rounded-md border border-amber-700/60 px-3 py-2 text-xs font-medium text-amber-100 transition-colors hover:bg-amber-950/40 disabled:opacity-50"
          >
            Approve All Remaining
          </button>
        ) : null}
        {hasMultipleRemaining ? (
          <p className="text-[11px] text-amber-200/80">
            More declared checkpoints will pause preview again unless you
            approve the remaining steps together.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function createValidationFixPrompt(
  artifact: WorkflowStudioArtifact,
  issue: WorkflowValidationIssue
): string {
  return [
    "Fix this issue in the current workflow.",
    "",
    `Workflow: ${artifact.title || artifact.slug}`,
    `Validation ${issue.level}: ${issue.message}`,
    "",
    "Update the draft to resolve the issue without breaking the intended workflow behavior, then explain what changed.",
  ].join("\n");
}

function createBuildFixPrompt(
  artifact: WorkflowStudioArtifact,
  build: WorkflowBuildResult
): string {
  const failedSteps = build.steps.filter((step) => step.status === "error");
  const validationIssues =
    build.validation?.issues.map((issue) => `- ${issue.message}`) || [];
  const failedStepSummary = failedSteps
    .slice(0, 3)
    .map((step) =>
      [
        `- ${step.label}: ${step.summary}`,
        step.command ? `  Command: ${step.command}` : "",
        step.output
          ? `  Output:\n${truncateIssueContext(step.output, 1600)
              .split("\n")
              .map((line) => `  ${line}`)
              .join("\n")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    );

  return [
    "Fix this issue in the current workflow build.",
    "",
    `Workflow: ${artifact.title || artifact.slug}`,
    build.error
      ? `Build error:\n${truncateIssueContext(build.error, 2400)}`
      : "",
    validationIssues.length > 0
      ? `Validation issues seen during build:\n${validationIssues.join("\n")}`
      : "",
    failedStepSummary.length > 0
      ? `Failed build steps:\n${failedStepSummary.join("\n")}`
      : "",
    "Update the workflow code or configuration to resolve the failure, then explain what changed.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function createPreviewFixPrompt(
  artifact: WorkflowStudioArtifact,
  preview: WorkflowPreviewResult
): string {
  const operationSummary = preview.operations
    .slice(-10)
    .map((operation) =>
      [
        `- ${operation.method} ${operation.target}`,
        `mode=${operation.mode}`,
        operation.responseStatus ? `status=${operation.responseStatus}` : "",
        operation.checkpoint ? `checkpoint=${operation.checkpoint}` : "",
      ]
        .filter(Boolean)
        .join(" ")
    )
    .join("\n");
  const logSummary = formatPreviewLogsForPrompt(preview, 30);

  return [
    "Review the latest workflow preview and fix any issues you find.",
    "",
    `Workflow: ${artifact.title || artifact.slug}`,
    `Preview status: ${preview.status}`,
    preview.error
      ? `Preview error:\n${truncateIssueContext(preview.error, 2400)}`
      : "",
    preview.warnings?.length
      ? `Preview warnings:\n${preview.warnings.map((warning) => `- ${warning}`).join("\n")}`
      : "",
    operationSummary ? `Operations observed:\n${operationSummary}` : "",
    logSummary
      ? `Execution logs:\n${truncateIssueContext(logSummary, 3200)}`
      : "No preview console output was captured.",
    "Update the current workflow draft if needed, then explain what changed and why.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function getWorkflowIntentSummary(
  artifact: WorkflowStudioArtifact,
  messages: WorkflowStudioMessage[]
): string {
  const chatSummary = artifact.chatSummary?.trim();
  if (chatSummary) {
    return chatSummary;
  }

  const summary = artifact.summary?.trim();
  if (
    summary &&
    summary !== "Describe a workflow in chat to generate code and a data-flow diagram."
  ) {
    return summary;
  }

  const latestUserPrompt = [...messages]
    .reverse()
    .find((message) => message.role === "user" && message.content?.trim())
    ?.content?.trim();

  return latestUserPrompt
    ? truncateIssueContext(latestUserPrompt, 700)
    : "No additional workflow description was captured yet.";
}

function isIntegrationConnectionBlocked(
  access: WorkflowAccessRequirement
): boolean {
  return (
    access.type === "integration" &&
    (access.status === "missing" || access.status === "blocked")
  );
}

function isConnectionIssueText(value?: string | null): value is string {
  if (!value) {
    return false;
  }

  return /(auth expired|reconnect in connections|no active .* connection|connection test failed|invalid credentials|oauth|unauthorized|forbidden)/i.test(
    value
  );
}

function inferProviderSlugFromText(
  value: string,
  providerHints: string[]
): string | undefined {
  const normalized = value.toLowerCase();
  return providerHints.find((providerSlug) =>
    normalized.includes(providerSlug.toLowerCase())
  );
}

function createConnectionAccessBlockers(
  accesses: WorkflowAccessRequirement[]
): WorkflowConnectionBlocker[] {
  return accesses.filter(isIntegrationConnectionBlocked).map((access) => ({
    key: `access:${access.id}`,
    label: access.providerSlug || access.label,
    detail: access.statusMessage || access.status,
    status: access.status === "missing" ? "missing" : "blocked",
    providerSlug: access.providerSlug,
    purpose: access.purpose,
  }));
}

function createConnectionWarningBlockers(
  messages: string[],
  providerHints: string[]
): WorkflowConnectionBlocker[] {
  return messages
    .filter(isConnectionIssueText)
    .map((message, index) => {
      const label = message.includes(" returned ")
        ? message.split(" returned ")[0]?.trim() || "Connection issue"
        : "Connection issue";

      return {
        key: `warning:${index}:${message}`,
        label,
        detail: message,
        status: "attention" as const,
        providerSlug: inferProviderSlugFromText(message, providerHints),
      };
    });
}

function dedupeConnectionBlockers(
  blockers: WorkflowConnectionBlocker[]
): WorkflowConnectionBlocker[] {
  const seen = new Set<string>();

  return blockers.filter((blocker) => {
    const signature = [
      blocker.providerSlug || blocker.label,
      blocker.detail,
      blocker.status,
    ].join("::");

    if (seen.has(signature)) {
      return false;
    }

    seen.add(signature);
    return true;
  });
}

function formatConnectionBlockersForPrompt(
  blockers: WorkflowConnectionBlocker[]
): string[] {
  return blockers.map((blocker) =>
    [
      `- ${blocker.providerSlug || blocker.label}: ${blocker.detail}`,
      blocker.purpose ? `  Needed for: ${blocker.purpose}` : "",
    ]
      .filter(Boolean)
      .join("\n")
  );
}

function createConnectionsAgentPrompt(
  artifact: WorkflowStudioArtifact,
  messages: WorkflowStudioMessage[],
  blockers: WorkflowConnectionBlocker[]
): string {
  const blockerLines = formatConnectionBlockersForPrompt(blockers);

  return [
    "Help me set up or repair the connections needed for a workflow I am building in GTMShip Workflow Studio.",
    "",
    `Workflow: ${artifact.title || artifact.slug}`,
    `Goal: ${getWorkflowIntentSummary(artifact, messages)}`,
    "",
    "The workflow is currently blocked on these connection issues:",
    ...blockerLines,
    "",
    "Please create or repair the required connection(s), verify them if useful, and tell me when I should return to Workflow Studio and click \"Recheck Connections\".",
  ].join("\n");
}

function createConnectionRecheckPrompt(
  artifact: WorkflowStudioArtifact,
  messages: WorkflowStudioMessage[],
  blockers: WorkflowConnectionBlocker[]
): string {
  const blockerLines = formatConnectionBlockersForPrompt(blockers);
  const providerSlugs = Array.from(
    new Set(
      blockers
        .map((blocker) => blocker.providerSlug)
        .filter((value): value is string => Boolean(value))
    )
  );

  return [
    "Recheck the required workflow connections before changing any code.",
    "",
    `Workflow: ${artifact.title || artifact.slug}`,
    `Goal: ${getWorkflowIntentSummary(artifact, messages)}`,
    providerSlugs.length > 0
      ? `Providers to recheck: ${providerSlugs.join(", ")}`
      : "",
    "",
    "Please list the active connections first, test the relevant provider connections if they exist, and only continue the workflow after you verify the required access is now ready.",
    "If the current blocker came from preview or build, rerun the relevant step after the connection check instead of just describing what to do next.",
    "If any connection is still missing or blocked, stop and tell me exactly what is not ready yet.",
    "",
    "Current connection blockers:",
    ...blockerLines,
  ]
    .filter(Boolean)
    .join("\n");
}

function ConnectionBlockerCallout({
  blockers,
  connectionsChanged,
  onUseConnectionsAgent,
  onRecheckConnections,
  recheckDisabled,
  rechecking,
}: {
  blockers: WorkflowConnectionBlocker[];
  connectionsChanged: boolean;
  onUseConnectionsAgent: () => void;
  onRecheckConnections: () => void;
  recheckDisabled: boolean;
  rechecking: boolean;
}) {
  if (blockers.length === 0) {
    return null;
  }

  return (
    <div className="rounded-lg border border-amber-900/40 bg-amber-950/20 px-4 py-4 text-xs text-amber-100">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-medium text-amber-50">
            <AlertCircle size={14} className="shrink-0 text-amber-300" />
            Connections need attention before the workflow can continue
          </div>
          <p className="mt-2 text-amber-200/90">
            {connectionsChanged
              ? "Connections were updated. Return to the workflow agent and recheck them before you continue."
              : "Use the Connections Agent to create or repair the missing integration setup, then come back here and recheck."}
          </p>
          <div className="mt-3 space-y-1.5">
            {blockers.slice(0, 4).map((blocker) => (
              <p key={blocker.key} className="text-amber-200/85">
                <span className="font-medium text-amber-50">
                  {blocker.providerSlug || blocker.label}
                </span>
                {": "}
                {blocker.detail}
              </p>
            ))}
            {blockers.length > 4 ? (
              <p className="text-amber-200/70">
                +{blockers.length - 4} more connection issue
                {blockers.length - 4 === 1 ? "" : "s"}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          <button
            onClick={onUseConnectionsAgent}
            className="flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-blue-500"
          >
            <Sparkles size={12} />
            Use Connections Agent
          </button>
          <button
            onClick={onRecheckConnections}
            disabled={recheckDisabled}
            className="flex items-center gap-2 rounded-md border border-amber-400/30 px-3 py-2 text-xs font-medium text-amber-50 transition-colors hover:bg-amber-400/10 disabled:opacity-50"
          >
            {rechecking ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <RefreshCw size={12} />
            )}
            Recheck Connections
          </button>
        </div>
      </div>
    </div>
  );
}

function CollapsibleSection(input: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <details className="group rounded-xl border border-zinc-800 bg-zinc-900/30">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4">
        <div>
          <h4 className="text-sm font-medium text-white">{input.title}</h4>
          <p className="mt-1 text-xs text-zinc-500">{input.description}</p>
        </div>
        <ChevronRight
          size={14}
          className="shrink-0 text-zinc-500 transition-transform group-open:rotate-90"
        />
      </summary>
      <div className="border-t border-zinc-800 px-5 py-5">{input.children}</div>
    </details>
  );
}

function isPlaceholderArtifact(
  artifact: WorkflowStudioArtifact | null | undefined
): boolean {
  if (!artifact) {
    return true;
  }

  return !(
    artifact.code.trim() ||
    artifact.requiredAccesses.length > 0 ||
    artifact.writeCheckpoints.length > 0 ||
    artifact.deploy ||
    artifact.bindings?.length ||
    artifact.aiConfigs?.length ||
    artifact.triggerConfig ||
    artifact.deploymentRun ||
    artifact.validation ||
    artifact.preview ||
    artifact.build
  );
}

function formatDate(value?: string): string {
  if (!value) {
    return "Unknown";
  }

  return new Date(value).toLocaleString();
}

function formatBytes(value?: number): string {
  if (!value) {
    return "0 KB";
  }

  if (value < 1024) {
    return `${value} B`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }

  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatWorkflowCount(count: number): string {
  return `${count} workflow${count === 1 ? "" : "s"}`;
}

async function parseResponse<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }

  return data as T;
}

function getToolInvocations(
  message: WorkflowStudioMessage
): WorkflowStudioToolInvocation[] {
  const fromToolInvocations: WorkflowStudioToolInvocation[] =
    message.toolInvocations || [];
  const fromParts: WorkflowStudioToolInvocation[] =
    message.parts?.flatMap((part) => {
      const invocation = getToolInvocationPart(part);
      return invocation ? [invocation] : [];
    }) || [];

  return fromParts.length > 0 ? fromParts : fromToolInvocations;
}

function getTextPartText(part: WorkflowStudioMessagePart): string | null {
  return part.type === "text" && typeof part.text === "string"
    ? part.text
    : null;
}

function getToolInvocationPart(
  part: WorkflowStudioMessagePart
): WorkflowStudioToolInvocation | null {
  return part.type === "tool-invocation" && part.toolInvocation
    ? (part.toolInvocation as WorkflowStudioToolInvocation)
    : null;
}

function getRenderableParts(
  message: WorkflowStudioMessage
): WorkflowStudioMessagePart[] {
  const parts = message.parts || [];
  const content = message.content?.trim();

  if (parts.length === 0) {
    const fallbackParts: WorkflowStudioMessagePart[] = [];

    if (content) {
      fallbackParts.push({ type: "text", text: content });
    }

    for (const invocation of getToolInvocations(message)) {
      fallbackParts.push({
        type: "tool-invocation",
        toolInvocation: invocation,
      });
    }

    return fallbackParts;
  }

  const hasTextPart = parts.some((part) => Boolean(getTextPartText(part)?.trim()));

  const seenToolKeys = new Set(
    parts.flatMap((part) => {
      const invocation = getToolInvocationPart(part);
      return invocation
        ? [[invocation.toolCallId || "", invocation.toolName, invocation.state].join(":")]
        : [];
    })
  );

  const trailingToolParts = getToolInvocations(message).flatMap((invocation) => {
    const key = [
      invocation.toolCallId || "",
      invocation.toolName,
      invocation.state,
    ].join(":");

    if (seenToolKeys.has(key)) {
      return [];
    }

    return [{ type: "tool-invocation", toolInvocation: invocation } satisfies WorkflowStudioMessagePart];
  });

  return [
    ...(content && !hasTextPart ? [{ type: "text", text: content } satisfies WorkflowStudioMessagePart] : []),
    ...parts,
    ...trailingToolParts,
  ];
}

function hasActiveToolInvocation(message?: WorkflowStudioMessage): boolean {
  if (!message) {
    return false;
  }

  return getToolInvocations(message).some((invocation) => invocation.state === "call");
}

function MarkdownContent({
  text,
  tone = "assistant",
}: {
  text: string;
  tone?: "assistant" | "system";
}) {
  const strongClassName =
    tone === "system" ? "text-amber-50 font-medium" : "text-white font-medium";
  const inlineCodeClassName =
    tone === "system"
      ? "rounded bg-amber-950/40 px-1 py-0.5 text-xs font-mono text-amber-100"
      : "rounded bg-zinc-800 px-1 py-0.5 text-xs font-mono text-zinc-300";
  const blockCodeClassName =
    tone === "system"
      ? "block overflow-x-auto whitespace-pre rounded border border-amber-900/40 bg-amber-950/40 px-3 py-2 text-xs font-mono text-amber-100 my-2"
      : "block overflow-x-auto whitespace-pre rounded border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs font-mono text-green-300/80 my-2";
  const tableBorderClassName =
    tone === "system" ? "border-amber-900/30" : "border-zinc-800";
  const tableHeadClassName =
    tone === "system" ? "bg-amber-950/20" : "bg-zinc-900/50";
  const tableTextClassName =
    tone === "system" ? "text-amber-100" : "text-zinc-300";
  const mutedTextClassName =
    tone === "system" ? "text-amber-200/80" : "text-zinc-400";
  const linkClassName =
    tone === "system" ? "text-amber-200 hover:underline" : "text-blue-400 hover:underline";

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h2: ({ children }) => (
          <h2 className="mb-2 mt-4 text-base font-semibold text-white first:mt-0">
            {children}
          </h2>
        ),
        h3: ({ children }) => (
          <h3 className="mb-1.5 mt-3 text-sm font-semibold text-white first:mt-0">
            {children}
          </h3>
        ),
        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
        strong: ({ children }) => (
          <strong className={strongClassName}>{children}</strong>
        ),
        code: ({ className, children }) => {
          const isBlock = className?.includes("language-");

          if (isBlock) {
            return <code className={blockCodeClassName}>{children}</code>;
          }

          return <code className={inlineCodeClassName}>{children}</code>;
        },
        pre: ({ children }) => <>{children}</>,
        ul: ({ children }) => (
          <ul className="mb-2 list-disc space-y-0.5 pl-5">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="mb-2 list-decimal space-y-0.5 pl-5">{children}</ol>
        ),
        li: ({ children }) => <li>{children}</li>,
        table: ({ children }) => (
          <div className="my-2 overflow-x-auto">
            <table className={`rounded border text-xs ${tableBorderClassName}`}>
              {children}
            </table>
          </div>
        ),
        thead: ({ children }) => <thead className={tableHeadClassName}>{children}</thead>,
        th: ({ children }) => (
          <th
            className={`border-b px-3 py-1.5 text-left font-medium ${tableBorderClassName} ${mutedTextClassName}`}
          >
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td
            className={`border-b px-3 py-1.5 ${tableBorderClassName} ${tableTextClassName}`}
          >
            {children}
          </td>
        ),
        hr: () => <hr className={`my-3 ${tableBorderClassName}`} />,
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className={linkClassName}
          >
            {children}
          </a>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

function ChatMessage({
  message,
  streamData,
}: {
  message: WorkflowStudioMessage;
  streamData?: unknown[];
}) {
  if (message.role === "user") {
    return (
      <div className="flex gap-3">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-700">
          <Workflow size={14} />
        </div>
        <div className="min-w-0 flex-1 break-words rounded-2xl bg-zinc-800/60 px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap text-zinc-200">
          {message.content}
        </div>
      </div>
    );
  }

  if (message.role === "system") {
    return (
      <div className="flex gap-3">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-600">
          <AlertCircle size={14} />
        </div>
        <div className="min-w-0 flex-1 break-words rounded-2xl border border-amber-900/40 bg-amber-950/20 px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap text-amber-100">
          <MarkdownContent text={message.content} tone="system" />
        </div>
      </div>
    );
  }

  const parts = getRenderableParts(message);
  let needsAvatar = true;

  return (
    <div className="space-y-2">
      {parts.map((part, index) => {
        const text = getTextPartText(part);

        if (text?.trim()) {
          const showAvatar = needsAvatar;
          needsAvatar = false;

          return (
            <div key={`${message.id}_text_${index}`} className="flex gap-3">
              {showAvatar ? (
                <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-600">
                  <Sparkles size={14} />
                </div>
              ) : (
                <div className="w-7 shrink-0" />
              )}
              <div className="min-w-0 flex-1 break-words rounded-2xl border border-zinc-800 bg-zinc-900/40 px-4 py-3 text-sm leading-relaxed text-zinc-200">
                <MarkdownContent text={text} />
              </div>
            </div>
          );
        }

        const invocation = getToolInvocationPart(part);

        if (invocation) {
          needsAvatar = true;

          return (
            <div
              key={`${message.id}_${invocation.toolCallId || invocation.toolName}_${index}`}
              className="pl-10"
            >
              <ToolRenderer
                invocation={{
                  toolName: invocation.toolName,
                  args: invocation.args || {},
                  state: invocation.state,
                  result: invocation.result,
                  toolCallId: invocation.toolCallId,
                }}
                streamData={streamData}
              />
            </div>
          );
        }

        return null;
      })}
    </div>
  );
}

const WorkflowConversationPanel = forwardRef<
  WorkflowConversationPanelHandle,
  WorkflowConversationPanelProps
>(function WorkflowConversationPanel({
  sessionKey,
  initialMessages,
  artifact,
  onTranscriptChange,
  onArtifactSync,
  onBusyChange,
  onError,
}, ref) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const compactionRef = useRef<WorkflowTranscriptCompaction | undefined>(
    getArtifactTranscriptCompaction(artifact)
  );
  const compactingRef = useRef(false);
  const [composer, setComposer] = useState("");

  const { messages, append, data, isLoading, setMessages, stop } = useChat({
    id: `workflow-studio-${sessionKey}`,
    api: "/api/workflows/agent",
    initialMessages: initialMessages as unknown as UIMessage[],
    maxSteps: 30,
    experimental_prepareRequestBody({
      messages: requestMessages,
      requestBody,
    }) {
      const currentArtifactBody =
        requestBody &&
        typeof requestBody === "object" &&
        "currentArtifact" in requestBody
          ? (
              requestBody as {
                currentArtifact?: WorkflowStudioArtifact | null;
              }
            ).currentArtifact
          : undefined;

      return {
        ...(requestBody || {}),
        messages: requestMessages,
        currentArtifact: stripArchivedMessagesFromCompaction(
          currentArtifactBody ?? null
        ),
      };
    },
    onError(error) {
      onError(error.message);
    },
  });

  useEffect(() => {
    compactionRef.current = getArtifactTranscriptCompaction(artifact);
  }, [artifact, sessionKey]);

  useEffect(() => {
    onBusyChange(isLoading);
  }, [isLoading, onBusyChange]);

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [messages, isLoading]);

  const cancelRun = useCallback(() => {
    if (!isLoading) {
      return;
    }

    onError(null);
    stop();
  }, [isLoading, onError, stop]);

  useEffect(() => {
    if (!isLoading) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }

      event.preventDefault();
      cancelRun();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [cancelRun, isLoading]);

  const applyCompactedMessages = useCallback(
    (nextMessages: WorkflowStudioMessage[], sync = false) => {
      const update = () => {
        setMessages(nextMessages as unknown as UIMessage[]);
      };

      if (sync) {
        flushSync(update);
        return;
      }

      update();
    },
    [setMessages]
  );

  const compactTranscriptIfNeeded = useCallback(
    async (
      inputMessages: WorkflowStudioMessage[],
      options?: { additionalText?: string; sync?: boolean }
    ) => {
      const additionalText = options?.additionalText?.trim() || "";
      const pendingTokens = estimateTextTokens(additionalText);

      if (pendingTokens > WORKFLOW_TRANSCRIPT_MAX_PENDING_MESSAGE_TOKENS) {
        throw createTranscriptTooLargeError(pendingTokens, true);
      }

      if (compactingRef.current) {
        return {
          messages: inputMessages,
          transcriptCompaction: compactionRef.current,
          changed: false,
        };
      }

      compactingRef.current = true;

      try {
        let nextMessages = inputMessages;
        let nextCompaction = compactionRef.current;
        let changed = false;

        for (let iteration = 0; iteration < 8; iteration += 1) {
          const plan = buildTranscriptCompactionPlan({
            messages: nextMessages,
            compaction: nextCompaction,
            additionalText,
          });

          if (!plan) {
            break;
          }

          let summary = "";
          try {
            const artifactForCompaction =
              artifact && !isPlaceholderArtifact(artifact)
                ? stripArchivedMessagesFromCompaction({
                    ...artifact,
                    transcriptCompaction: nextCompaction,
                  })
                : null;
            const response = await fetch("/api/workflows/compact", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                previousSummary: plan.existingSummary,
                messagesToCompact: plan.messagesToArchive,
                currentArtifact: artifactForCompaction,
              }),
            });
            const result = await parseResponse<{ summary: string }>(response);
            summary = result.summary?.trim();
          } catch {
            summary = buildFallbackTranscriptSummary({
              previousSummary: plan.existingSummary,
              messages: plan.messagesToArchive,
            });
          }

          if (!summary) {
            summary = buildFallbackTranscriptSummary({
              previousSummary: plan.existingSummary,
              messages: plan.messagesToArchive,
            });
          }

          const applied = applyTranscriptCompaction({
            messages: nextMessages,
            compaction: nextCompaction,
            summary,
            messagesToArchive: plan.messagesToArchive,
            recentMessages: plan.recentMessages,
          });

          nextMessages = applied.messages;
          nextCompaction = applied.transcriptCompaction;
          changed = true;
        }

        const finalEstimate = estimateVisibleTranscriptTokens({
          messages: nextMessages,
          compaction: nextCompaction,
          additionalText,
        });

        if (finalEstimate > WORKFLOW_TRANSCRIPT_HARD_LIMIT_TOKENS) {
          throw createTranscriptTooLargeError(
            pendingTokens || finalEstimate,
            pendingTokens > WORKFLOW_TRANSCRIPT_MAX_PENDING_MESSAGE_TOKENS
          );
        }

        if (changed) {
          compactionRef.current = nextCompaction;
          applyCompactedMessages(nextMessages, options?.sync);
        }

        return {
          messages: nextMessages,
          transcriptCompaction: nextCompaction,
          changed,
        };
      } finally {
        compactingRef.current = false;
      }
    },
    [applyCompactedMessages, artifact]
  );

  useEffect(() => {
    const nextMessages = messages as unknown as WorkflowStudioMessage[];
    onTranscriptChange(nextMessages);
    const state = deriveWorkflowStudioState(
      nextMessages,
      artifact
        ? {
            ...artifact,
            transcriptCompaction: compactionRef.current,
          }
        : artifact
    );
    onArtifactSync(state.artifact, state.blockedAccesses);
  }, [messages, onArtifactSync, onTranscriptChange]);

  useEffect(() => {
    if (isLoading) {
      return;
    }

    const transcript = messages as unknown as WorkflowStudioMessage[];
    if (transcript.length === 0) {
      return;
    }

    const estimate = estimateVisibleTranscriptTokens({
      messages: transcript,
      compaction: compactionRef.current,
    });

    if (estimate <= WORKFLOW_TRANSCRIPT_TRIGGER_TOKENS) {
      return;
    }

    void compactTranscriptIfNeeded(transcript).catch((error) => {
      onError(
        error instanceof Error
          ? error.message
          : "Workflow transcript compaction failed."
      );
    });
  }, [compactTranscriptIfNeeded, isLoading, messages, onError]);

  const sendPrompt = useCallback(
    async (rawContent: string) => {
      const content = rawContent.trim();
      if (!content) {
        return;
      }

      onError(null);
      const currentTranscript = messages as unknown as WorkflowStudioMessage[];
      await compactTranscriptIfNeeded(currentTranscript, {
        additionalText: content,
        sync: true,
      });

      await append(
        { role: "user", content },
        {
          body: {
            currentArtifact: isPlaceholderArtifact(artifact)
              ? null
              : {
                  ...artifact,
                  transcriptCompaction: compactionRef.current,
                },
          },
        }
      );
    },
    [append, artifact, compactTranscriptIfNeeded, messages, onError]
  );

  useImperativeHandle(
    ref,
    () => ({
      sendPrompt,
      cancelRun,
    }),
    [cancelRun, sendPrompt]
  );

  async function handleSend(event: FormEvent) {
    event.preventDefault();
    if (!composer.trim()) {
      return;
    }

    const content = composer.trim();
    setComposer("");
    await sendPrompt(content);
  }

  const transcript = messages as unknown as WorkflowStudioMessage[];
  const hasActiveTool = hasActiveToolInvocation(
    transcript[transcript.length - 1]
  );

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-5">
        {transcript.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-8">
              <Sparkles size={28} className="mx-auto text-blue-500" />
              <h3 className="mt-4 text-base font-medium text-white">
                Build with an agentic workflow loop
              </h3>
              <p className="mt-2 max-w-sm text-sm leading-relaxed text-zinc-500">
                Ask for a workflow, then the agent can inspect integrations,
                read docs, run <code>curl</code>, <code>rg</code>,{" "}
                <code>python</code>, and self-debug the draft in chat.
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {[
                  "Read the Factors Journey API and email the result",
                  "Pull data from a public API and transform it",
                  "Inspect docs first, then build the workflow",
                ].map((prompt) => (
                  <button
                    key={prompt}
                    onClick={() => setComposer(prompt)}
                    className="rounded-full border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {transcript.map((message) => (
              <ChatMessage
                key={message.id}
                message={message}
                streamData={data as unknown[] | undefined}
              />
            ))}
            {isLoading && !hasActiveTool ? (
              <div className="flex gap-3">
                <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-600">
                  <Sparkles size={14} />
                </div>
                <div className="flex items-center gap-1.5 rounded-2xl border border-zinc-800 bg-zinc-900/40 px-4 py-3">
                  <span className="h-1.5 w-1.5 rounded-full bg-zinc-500 animate-pulse" />
                  <span className="h-1.5 w-1.5 rounded-full bg-zinc-500 animate-pulse [animation-delay:0.2s]" />
                  <span className="h-1.5 w-1.5 rounded-full bg-zinc-500 animate-pulse [animation-delay:0.4s]" />
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>

      <form
        onSubmit={handleSend}
        className="border-t border-zinc-800 bg-zinc-950/80 p-4"
      >
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 transition-colors focus-within:border-zinc-600">
          <textarea
            value={composer}
            onChange={(event) => setComposer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && isLoading) {
                event.preventDefault();
                cancelRun();
                return;
              }

              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void handleSend(event);
              }
            }}
            rows={4}
            placeholder="Describe the workflow, ask it to inspect docs, or tell it to debug the current draft..."
            className="w-full resize-none bg-transparent text-sm text-white outline-none placeholder:text-zinc-600"
          />
          <div className="mt-2 flex items-center justify-between">
            <p className="text-[11px] text-zinc-600">
              {typeof navigator !== "undefined" &&
              navigator.platform?.includes("Mac")
                ? "\u2318"
                : "Ctrl"}
              +Enter to send
              {isLoading ? " • Esc to cancel" : ""}
            </p>
            <div className="flex items-center gap-2">
              {isLoading ? (
                <button
                  type="button"
                  onClick={cancelRun}
                  className="flex items-center gap-2 rounded-lg border border-rose-500/40 px-4 py-2 text-xs font-medium text-rose-200 transition-colors hover:bg-rose-500/10"
                >
                  <X size={12} />
                  Cancel
                </button>
              ) : null}
              <button
                type="submit"
                disabled={isLoading || !composer.trim()}
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
              >
                {isLoading ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Sparkles size={12} />
                )}
                Send
              </button>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
});

export function WorkflowStudio() {
  const [listing, setListing] = useState<WorkflowListingResponse | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<WorkflowStudioArtifact | null>(null);
  const [messages, setMessages] = useState<WorkflowStudioMessage[]>([]);
  const [activeTab, setActiveTab] = useState<StudioTab>("flow");
  const [loadingList, setLoadingList] = useState(true);
  const [loadingWorkflow, setLoadingWorkflow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [building, setBuilding] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deployingTargetMode, setDeployingTargetMode] =
    useState<WorkflowDeployTargetMode | null>(null);
  const [deletingWorkflow, setDeletingWorkflow] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveDeploymentOverview, setLiveDeploymentOverview] =
    useState<WorkflowDeploymentOverview | null>(null);
  const [liveDeploymentLoading, setLiveDeploymentLoading] = useState(false);
  const [liveDeploymentAction, setLiveDeploymentAction] = useState<
    "refresh" | "retry"
  >("refresh");
  const [liveDeploymentError, setLiveDeploymentError] = useState("");
  const [resolvedDeploymentPlan, setResolvedDeploymentPlan] =
    useState<WorkflowDeploymentPlan | null>(null);
  const [resolvedDeploymentPlanLoading, setResolvedDeploymentPlanLoading] =
    useState(false);
  const [resolvedDeploymentPlanError, setResolvedDeploymentPlanError] =
    useState("");
  const [cloudSettings, setCloudSettings] =
    useState<ResolvedCloudDeploySettings | null>(null);
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [projects, setProjects] = useState<WorkflowStudioProject[]>([]);
  const [newProjectName, setNewProjectName] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [switchingProject, setSwitchingProject] = useState(false);
  const [approvedCheckpoints, setApprovedCheckpoints] = useState<string[]>([]);
  const [blockedAccesses, setBlockedAccesses] = useState<
    WorkflowAccessRequirement[]
  >([]);
  const [connectionsChangedSinceBlocker, setConnectionsChangedSinceBlocker] =
    useState(false);
  const [workflowAiConnections, setWorkflowAiConnections] = useState<
    WorkflowStudioConnectionRecord[]
  >([]);
  const [workflowAiConnectionsLoading, setWorkflowAiConnectionsLoading] =
    useState(false);
  const [workflowAiConnectionsError, setWorkflowAiConnectionsError] =
    useState("");
  const [workflowAiModelOptions, setWorkflowAiModelOptions] = useState<
    Partial<Record<WorkflowAiProviderSlug, AiModelOption[]>>
  >({});
  const [workflowAiModelLoading, setWorkflowAiModelLoading] = useState<
    Partial<Record<WorkflowAiProviderSlug, boolean>>
  >({});
  const [workflowAiModelErrors, setWorkflowAiModelErrors] = useState<
    Partial<Record<WorkflowAiProviderSlug, string>>
  >({});
  const workflowAiModelConnectionIdsRef = useRef<
    Partial<Record<WorkflowAiProviderSlug, string>>
  >({});
  const [editingTitle, setEditingTitle] = useState(false);
  const [editorSessionKey, setEditorSessionKey] = useState(() =>
    `workflow-studio-${Date.now()}`
  );
  const [workflowMemories, setWorkflowMemories] = useState<MemoryRecord[]>([]);
  const [workflowMemoriesLoading, setWorkflowMemoriesLoading] = useState(false);
  const conversationRef = useRef<WorkflowConversationPanelHandle | null>(null);

  // Refs to preserve manually-run validation/preview/build results from being
  // overwritten by stale agent-derived state when the transcript effect re-runs.
  const manualPreviewRef = useRef<WorkflowPreviewResult | null>(null);
  const manualValidationRef = useRef<WorkflowValidationReport | null>(null);
  const manualBuildRef = useRef<WorkflowBuildResult | null>(null);
  const approvalDraftSignatureRef = useRef<string | null>(null);
  const deploymentDefaults = listing?.deploymentDefaults;

  const showEditor = artifact !== null;
  const currentArtifact = useMemo(
    () => artifact || emptyArtifact(deploymentDefaults),
    [artifact, deploymentDefaults]
  );
  const previewPendingApproval = currentArtifact.preview?.pendingApproval;
  const buildPendingApproval = currentArtifact.build?.preview?.pendingApproval;
  const previewCheckpointProgress = useMemo(
    () =>
      buildCheckpointProgress(
        currentArtifact.writeCheckpoints,
        approvedCheckpoints,
        previewPendingApproval
      ),
    [
      approvedCheckpoints,
      currentArtifact.writeCheckpoints,
      previewPendingApproval,
    ]
  );
  const buildCheckpointApprovalProgress = useMemo(
    () =>
      buildCheckpointProgress(
        currentArtifact.writeCheckpoints,
        approvedCheckpoints,
        buildPendingApproval
      ),
    [approvedCheckpoints, buildPendingApproval, currentArtifact.writeCheckpoints]
  );
  const previewRemainingCheckpointIds = useMemo(
    () =>
      previewCheckpointProgress
        .filter((checkpoint) => checkpoint.status !== "approved")
        .map((checkpoint) => checkpoint.id),
    [previewCheckpointProgress]
  );
  const buildRemainingCheckpointIds = useMemo(
    () =>
      buildCheckpointApprovalProgress
        .filter((checkpoint) => checkpoint.status !== "approved")
        .map((checkpoint) => checkpoint.id),
    [buildCheckpointApprovalProgress]
  );
  const configuredDeployTarget = useMemo(
    () =>
      resolveWorkflowDeployTarget({
        workflowDeploy: currentArtifact.deploy,
        cloudSettings,
        projectDefaults: deploymentDefaults,
      }),
    [cloudSettings, currentArtifact.deploy, deploymentDefaults]
  );
  const deployTarget = configuredDeployTarget.target;
  const configuredProvider = configuredDeployTarget.provider;
  const configuredRegion = configuredDeployTarget.region;
  const configuredGcpProject = configuredDeployTarget.gcpProject || "";
  const configuredCloudProvider = configuredDeployTarget.cloudProvider;
  const configuredCloudRegion = configuredDeployTarget.cloudRegion;
  const configuredCloudGcpProject =
    configuredDeployTarget.cloudGcpProject || "";
  const effectiveDeployTarget = configuredDeployTarget;
  const effectiveProvider = configuredProvider;
  const effectiveRegion = configuredRegion;
  const effectiveGcpProject = configuredGcpProject;
  const effectiveCloudProvider = configuredCloudProvider;
  const effectiveCloudRegion = configuredCloudRegion;
  const effectiveCloudGcpProject = configuredCloudGcpProject;
  const cloudDeployTarget = useMemo(
    () =>
      resolveWorkflowDeployTarget({
        workflowDeploy: {
          ...(currentArtifact.deploy || {}),
          target: "cloud",
          provider: configuredCloudProvider,
          region: configuredCloudRegion,
          gcpProject:
            configuredCloudProvider === "gcp"
              ? configuredCloudGcpProject
              : currentArtifact.deploy?.gcpProject,
        },
        cloudSettings,
        projectDefaults: deploymentDefaults,
      }),
    [
      cloudSettings,
      currentArtifact.deploy,
      deploymentDefaults,
      configuredCloudGcpProject,
      configuredCloudProvider,
      configuredCloudRegion,
    ]
  );
  const localDeployTarget = useMemo(
    () =>
      resolveWorkflowDeployTarget({
        workflowDeploy: {
          ...(currentArtifact.deploy || {}),
          target: "local",
        },
        cloudSettings,
        projectDefaults: deploymentDefaults,
      }),
    [cloudSettings, currentArtifact.deploy, deploymentDefaults]
  );
  const localDeployArtifact = {
    ...currentArtifact,
    deploy: {
      ...(currentArtifact.deploy || {}),
      target: "local" as const,
    },
  };
  const deployPlanArtifact = useMemo<WorkflowStudioArtifact>(
    () => ({
      slug: currentArtifact.slug,
      title: currentArtifact.title,
      summary: currentArtifact.summary,
      description: currentArtifact.description,
      mermaid: currentArtifact.mermaid,
      code: currentArtifact.code,
      samplePayload: currentArtifact.samplePayload,
      requiredAccesses: currentArtifact.requiredAccesses,
      writeCheckpoints: currentArtifact.writeCheckpoints,
      chatSummary: currentArtifact.chatSummary,
      messages: [],
      transcriptCompaction: currentArtifact.transcriptCompaction,
      deploy: currentArtifact.deploy,
      triggerConfig: currentArtifact.triggerConfig,
      bindings: currentArtifact.bindings,
      aiConfigs: currentArtifact.aiConfigs,
      groundedApiContext: currentArtifact.groundedApiContext,
    }),
    [
      currentArtifact.aiConfigs,
      currentArtifact.bindings,
      currentArtifact.chatSummary,
      currentArtifact.code,
      currentArtifact.deploy,
      currentArtifact.description,
      currentArtifact.groundedApiContext,
      currentArtifact.mermaid,
      currentArtifact.requiredAccesses,
      currentArtifact.samplePayload,
      currentArtifact.slug,
      currentArtifact.summary,
      currentArtifact.title,
      currentArtifact.transcriptCompaction,
      currentArtifact.triggerConfig,
      currentArtifact.writeCheckpoints,
    ]
  );
  const deploymentRun = currentArtifact.deploymentRun || null;
  const deploymentRunTarget = useMemo(
    () => deriveWorkflowDeploymentRunTarget(deploymentRun),
    [deploymentRun]
  );
  const deployStatus = deploymentRun?.status || "idle";
  const deployErrorMessage = deploymentRun?.error || "";
  const deployOutput = deploymentRun?.output || "";
  const deployResult = deploymentRun?.status === "success" ? deploymentRun : null;
  const hasSavedDeploymentRecord = deploymentRun?.status === "success";
  const hasLiveDeploymentRecord = liveDeploymentOverview !== null;
  const deploymentPlan = buildWorkflowPlanFromArtifact(
    currentArtifact,
    configuredDeployTarget
  );
  const localDeploymentPlan = buildWorkflowPlanFromArtifact(
    localDeployArtifact,
    localDeployTarget
  );
  const displayDeploymentPlan = resolvedDeploymentPlan || deploymentPlan;
  const deploymentSecretSyncSummary = resolvedDeploymentPlan
    ? buildWorkflowSecretSyncSummary([resolvedDeploymentPlan])
    : null;
  const selectedWorkflowId =
    listing?.workflows.find((workflow) => workflow.slug === selectedSlug)?.workflowId ||
    deploymentPlan.workflowId ||
    currentArtifact.slug;
  const configuredTargetMatchesLastRun = deploymentRunTarget
    ? workflowDeploymentTargetsMatch(configuredDeployTarget, deploymentRunTarget)
    : false;
  const deployResultTarget = deploymentRunTarget || {
    provider: configuredProvider,
    region: configuredRegion,
    gcpProject: configuredProvider === "gcp" ? configuredGcpProject : undefined,
  };
  const configuredTargetLabel = formatWorkflowDeploymentDisplayTarget(
    configuredDeployTarget
  );
  const deploymentRunTargetLabel = deploymentRunTarget
    ? formatWorkflowDeploymentDisplayTarget(deploymentRunTarget)
    : null;
  const liveGcpComputeType: GcpComputeType | null =
    configuredProvider === "gcp"
      ? liveDeploymentOverview?.platform?.computeType === "job"
        ? "job"
        : liveDeploymentOverview?.platform?.computeType === "service"
          ? "service"
          : liveDeploymentOverview?.executionKind === "job"
            ? "job"
            : "service"
      : null;
  const deployInfra = getDeploymentInfra(deployResultTarget.provider, {
    gcpComputeType:
      deployResultTarget.provider === "gcp" && configuredTargetMatchesLastRun
        ? liveGcpComputeType
        : null,
    includeScheduler: Boolean(
      deployResult?.schedulerJobId ||
        (configuredTargetMatchesLastRun &&
          (liveDeploymentOverview?.platform?.schedulerJobId ||
            liveDeploymentOverview?.schedulerId))
    ),
  });
  const cloudMissingGcpProject =
    cloudDeployTarget.provider === "gcp" && !cloudDeployTarget.gcpProject;
  const localDeployUnsupportedReason =
    localDeploymentPlan.warnings.find(
      (warning) => warning === LOCAL_DEPLOY_UNSUPPORTED_WARNING
    ) || null;
  const hasLiveDeploymentSyncWarning = Boolean(liveDeploymentOverview?.liveError);
  const deploymentActionDisabled =
    !artifact ||
    !listing?.projectRootConfigured ||
    validating ||
    previewing ||
    building ||
    saving ||
    deploying ||
    deletingWorkflow ||
    agentBusy;
  const cloudDeployDisabled =
    deploymentActionDisabled || cloudMissingGcpProject;
  const localDeployDisabled =
    deploymentActionDisabled || Boolean(localDeployUnsupportedReason);
  const fixWithAiDisabled =
    !artifact ||
    loadingWorkflow ||
    saving ||
    validating ||
    previewing ||
    building ||
    deploying ||
    deletingWorkflow ||
    agentBusy;
  const recheckConnectionsDisabled =
    loadingWorkflow ||
    saving ||
    validating ||
    previewing ||
    building ||
    deploying ||
    deletingWorkflow ||
    agentBusy;
  const deleteWorkflowDisabled =
    !selectedSlug ||
    loadingWorkflow ||
    saving ||
    validating ||
    previewing ||
    building ||
    deploying ||
    deletingWorkflow ||
    agentBusy;
  const bindingProviderSlugs = useMemo(() => {
    const providers = new Set<string>();
    for (const access of currentArtifact.requiredAccesses) {
      if (access.type === "integration" && access.providerSlug) {
        providers.add(access.providerSlug);
      }
    }
    for (const binding of currentArtifact.bindings || []) {
      providers.add(binding.providerSlug);
    }
    return Array.from(providers);
  }, [currentArtifact.requiredAccesses, currentArtifact.bindings]);
  const workflowAiConfigs = useMemo(
    () => normalizeWorkflowAiConfigs(currentArtifact.aiConfigs),
    [currentArtifact.aiConfigs]
  );
  const workflowAiConfigByProvider = useMemo(
    () => new Map(workflowAiConfigs.map((config) => [config.providerSlug, config])),
    [workflowAiConfigs]
  );
  const workflowAiProviderSlugs = useMemo(
    () =>
      WORKFLOW_AI_PROVIDER_ORDER.filter((providerSlug) =>
        workflowAiConfigByProvider.has(providerSlug) ||
        (currentArtifact.bindings || []).some(
          (binding) => binding.providerSlug === providerSlug
        )
      ),
    [currentArtifact.bindings, workflowAiConfigByProvider]
  );
  const workflowAiBindingResolutions = useMemo(
    () =>
      workflowAiProviderSlugs.map((providerSlug) => {
        const binding = (currentArtifact.bindings || []).find(
          (entry) => entry.providerSlug === providerSlug
        );
        return resolveWorkflowAiBinding(
          providerSlug,
          binding,
          workflowAiConnections
        );
      }),
    [currentArtifact.bindings, workflowAiConnections, workflowAiProviderSlugs]
  );
  const workflowAiBindingResolutionByProvider = useMemo(
    () =>
      new Map(
        workflowAiBindingResolutions.map((resolution) => [
          resolution.providerSlug,
          resolution,
        ])
      ),
    [workflowAiBindingResolutions]
  );
  const visibleAccesses = useMemo(
    () =>
      blockedAccesses.length > 0
        ? blockedAccesses
        : currentArtifact.requiredAccesses || [],
    [blockedAccesses, currentArtifact.requiredAccesses]
  );
  const accessConnectionBlockers = useMemo(
    () => createConnectionAccessBlockers(visibleAccesses),
    [visibleAccesses]
  );
  const connectionIssueMessages = useMemo(() => {
    const nextMessages = new Set<string>();

    for (const value of currentArtifact.preview?.warnings || []) {
      if (isConnectionIssueText(value)) {
        nextMessages.add(value);
      }
    }

    if (isConnectionIssueText(currentArtifact.preview?.error)) {
      nextMessages.add(currentArtifact.preview.error);
    }

    for (const value of currentArtifact.build?.preview?.warnings || []) {
      if (isConnectionIssueText(value)) {
        nextMessages.add(value);
      }
    }

    if (isConnectionIssueText(currentArtifact.build?.preview?.error)) {
      nextMessages.add(currentArtifact.build.preview.error);
    }

    if (isConnectionIssueText(currentArtifact.build?.error)) {
      nextMessages.add(currentArtifact.build.error);
    }

    return Array.from(nextMessages);
  }, [
    currentArtifact.build?.error,
    currentArtifact.build?.preview?.error,
    currentArtifact.build?.preview?.warnings,
    currentArtifact.preview?.error,
    currentArtifact.preview?.warnings,
  ]);
  const connectionWarningBlockers = useMemo(
    () =>
      createConnectionWarningBlockers(
        connectionIssueMessages,
        bindingProviderSlugs
      ),
    [bindingProviderSlugs, connectionIssueMessages]
  );
  const connectionBlockers = useMemo(
    () =>
      dedupeConnectionBlockers([
        ...accessConnectionBlockers,
        ...connectionWarningBlockers,
      ]),
    [accessConnectionBlockers, connectionWarningBlockers]
  );
  const hasConnectionBlockers = connectionBlockers.length > 0;

  function resetLiveDeploymentState() {
    setLiveDeploymentOverview(null);
    setLiveDeploymentAction("refresh");
    setLiveDeploymentError("");
  }

  const loadLiveDeploymentOverview = useCallback(
    async (options: {
      forceReconcile?: boolean;
      deploymentTarget?: WorkflowDeployTarget;
    } = {}) => {
      const forceReconcile = options.forceReconcile === true;
      if (!selectedWorkflowId) {
        resetLiveDeploymentState();
        return;
      }
      const targetForOverview = options.deploymentTarget || {
        provider: effectiveProvider,
        region: effectiveRegion,
        gcpProject:
          effectiveProvider === "gcp" ? effectiveGcpProject : undefined,
      };
      const overviewProvider = targetForOverview.provider;
      const overviewRegion = targetForOverview.region;
      const overviewGcpProject =
        targetForOverview.provider === "gcp"
          ? targetForOverview.gcpProject || ""
          : "";

      setLiveDeploymentLoading(true);
      setLiveDeploymentAction(forceReconcile ? "retry" : "refresh");
      setLiveDeploymentError("");
      try {
        const fetchDeployments = async () => {
          const deployments = await api.getWorkflowDeploymentsForWorkflow({
            workflowId: selectedWorkflowId || undefined,
            workflowSlug: selectedSlug || undefined,
            provider: overviewProvider,
            includeLive: true,
            executionLimit: 5,
          });
          return Array.isArray(deployments) ? deployments : [];
        };

        let matches = await fetchDeployments();
        if (forceReconcile) {
          await api.reconcileWorkflowDeployments({
            provider: overviewProvider,
            region: overviewRegion,
            gcpProject:
              overviewProvider === "gcp"
                ? overviewGcpProject.trim() || undefined
                : undefined,
            workflow: selectedSlug || undefined,
          });
          matches = await fetchDeployments();
        }

        const bestMatch =
          getScopedWorkflowDeployments(matches, {
            provider: overviewProvider,
            workflowId: selectedWorkflowId,
            workflowSlug: selectedSlug,
            region: overviewRegion,
            gcpProject:
              overviewProvider === "gcp" ? overviewGcpProject : undefined,
          })[0] || null;

        setLiveDeploymentOverview(bestMatch);
      } catch (liveError) {
        setLiveDeploymentOverview(null);
        setLiveDeploymentError(
          liveError instanceof Error
            ? liveError.message
            : "Failed to load live deployment details."
        );
      } finally {
        setLiveDeploymentLoading(false);
        setLiveDeploymentAction("refresh");
      }
    },
    [
      effectiveGcpProject,
      effectiveProvider,
      effectiveRegion,
      selectedSlug,
      selectedWorkflowId,
    ]
  );

  const loadWorkflowAiConnections = useCallback(async () => {
    setWorkflowAiConnectionsLoading(true);
    setWorkflowAiConnectionsError("");
    try {
      const connections = (await api.getConnections()) as WorkflowStudioConnectionRecord[];
      workflowAiModelConnectionIdsRef.current = {};
      setWorkflowAiConnections(Array.isArray(connections) ? connections : []);
    } catch (connectionError) {
      workflowAiModelConnectionIdsRef.current = {};
      setWorkflowAiConnections([]);
      setWorkflowAiConnectionsError(
        connectionError instanceof Error
          ? connectionError.message
          : "Failed to load connections."
      );
    } finally {
      setWorkflowAiConnectionsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWorkflowAiConnections();

    const handleConnectionsChanged = () => {
      void loadWorkflowAiConnections();
    };

    window.addEventListener("connections-changed", handleConnectionsChanged);
    return () =>
      window.removeEventListener("connections-changed", handleConnectionsChanged);
  }, [loadWorkflowAiConnections]);

  useEffect(() => {
    if (workflowAiProviderSlugs.length === 0) {
      setWorkflowAiModelOptions({});
      setWorkflowAiModelLoading({});
      setWorkflowAiModelErrors({});
      workflowAiModelConnectionIdsRef.current = {};
      return;
    }

    let cancelled = false;
    const activeProviders = new Set(workflowAiProviderSlugs);

    setWorkflowAiModelOptions((current) => {
      const next = { ...current };
      for (const providerSlug of Object.keys(next) as WorkflowAiProviderSlug[]) {
        if (!activeProviders.has(providerSlug)) {
          delete next[providerSlug];
        }
      }
      return next;
    });
    setWorkflowAiModelLoading((current) => {
      const next = { ...current };
      for (const providerSlug of Object.keys(next) as WorkflowAiProviderSlug[]) {
        if (!activeProviders.has(providerSlug)) {
          delete next[providerSlug];
        }
      }
      return next;
    });
    setWorkflowAiModelErrors((current) => {
      const next = { ...current };
      for (const providerSlug of Object.keys(next) as WorkflowAiProviderSlug[]) {
        if (!activeProviders.has(providerSlug)) {
          delete next[providerSlug];
        }
      }
      return next;
    });

    void (async () => {
      for (const providerSlug of workflowAiProviderSlugs) {
        const resolution =
          workflowAiBindingResolutionByProvider.get(providerSlug);

        if (
          !resolution ||
          resolution.status !== "resolved" ||
          !resolution.connection?.id
        ) {
          delete workflowAiModelConnectionIdsRef.current[providerSlug];
          setWorkflowAiModelLoading((current) => ({
            ...current,
            [providerSlug]: false,
          }));
          setWorkflowAiModelErrors((current) => {
            const next = { ...current };
            delete next[providerSlug];
            return next;
          });
          continue;
        }

        if (
          workflowAiModelConnectionIdsRef.current[providerSlug] ===
          resolution.connection.id
        ) {
          continue;
        }

        setWorkflowAiModelLoading((current) => ({
          ...current,
          [providerSlug]: true,
        }));
        setWorkflowAiModelErrors((current) => {
          const next = { ...current };
          delete next[providerSlug];
          return next;
        });

        try {
          const result = await api.searchConnectionAiModels(
            resolution.connection.id
          );

          if (cancelled) {
            return;
          }

          workflowAiModelConnectionIdsRef.current[providerSlug] =
            resolution.connection.id;
          setWorkflowAiModelOptions((current) => ({
            ...current,
            [providerSlug]: Array.isArray(result.models) ? result.models : [],
          }));
        } catch (modelError) {
          if (cancelled) {
            return;
          }

          setWorkflowAiModelErrors((current) => ({
            ...current,
            [providerSlug]:
              modelError instanceof Error
                ? modelError.message
                : "Unable to load live models.",
          }));
        } finally {
          if (!cancelled) {
            setWorkflowAiModelLoading((current) => ({
              ...current,
              [providerSlug]: false,
            }));
          }
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [workflowAiBindingResolutionByProvider, workflowAiProviderSlugs]);

  const sendIssueToChat = useCallback(
    async (prompt: string) => {
      if (!conversationRef.current) {
        setError("The workflow chat is not ready yet.");
        return;
      }

      try {
        await conversationRef.current.sendPrompt(prompt);
      } catch (chatError) {
        setError(
          chatError instanceof Error
            ? chatError.message
            : "Failed to send the issue to chat."
        );
      }
    },
    []
  );

  const cancelAgentRun = useCallback(() => {
    conversationRef.current?.cancelRun();
  }, []);

  const openConnectionsAgent = useCallback(() => {
    const initialMessage = createConnectionsAgentPrompt(
      currentArtifact,
      messages,
      connectionBlockers
    );

    window.dispatchEvent(
      new CustomEvent("open-agent", { detail: { initialMessage } })
    );
  }, [connectionBlockers, currentArtifact, messages]);

  const recheckConnections = useCallback(async () => {
    if (connectionBlockers.length === 0) {
      return;
    }

    setConnectionsChangedSinceBlocker(false);
    await sendIssueToChat(
      createConnectionRecheckPrompt(currentArtifact, messages, connectionBlockers)
    );
  }, [connectionBlockers, currentArtifact, messages, sendIssueToChat]);

  useEffect(() => {
    if (!hasConnectionBlockers) {
      setConnectionsChangedSinceBlocker(false);
      return;
    }

    const handleConnectionsChanged = () => {
      setConnectionsChangedSinceBlocker(true);
    };

    window.addEventListener("connections-changed", handleConnectionsChanged);
    return () =>
      window.removeEventListener("connections-changed", handleConnectionsChanged);
  }, [hasConnectionBlockers]);

  useEffect(() => {
    setConnectionsChangedSinceBlocker(false);
  }, [selectedSlug]);

  useEffect(() => {
    if (!artifact) {
      approvalDraftSignatureRef.current = null;
      return;
    }

    const nextSignature = `${artifact.slug}:${artifact.code}`;
    if (
      approvalDraftSignatureRef.current &&
      approvalDraftSignatureRef.current !== nextSignature &&
      approvedCheckpoints.length > 0
    ) {
      setApprovedCheckpoints([]);
    }
    approvalDraftSignatureRef.current = nextSignature;
  }, [approvedCheckpoints.length, artifact?.code, artifact?.slug]);

  async function loadListing() {
    setLoadingList(true);
    try {
      const response = await fetch("/api/workflows", { cache: "no-store" });
      const data = await parseResponse<WorkflowListingResponse>(response);
      setListing(data);
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "Failed to load workflows."
      );
    } finally {
      setLoadingList(false);
    }
  }

  async function loadWorkflow(slug: string) {
    setLoadingWorkflow(true);
    setSelectedSlug(slug);
    setLiveDeploymentOverview(null);
    setLiveDeploymentError("");
    try {
      const response = await fetch(`/api/workflows/${slug}`, {
        cache: "no-store",
      });
      const record = await parseResponse<StoredWorkflowRecord>(response);
      manualPreviewRef.current = null;
      manualValidationRef.current = null;
      manualBuildRef.current = null;
      setArtifact(withDeploymentPlan(record.artifact, deploymentDefaults));
      setMessages(record.artifact.messages || []);
      setApprovedCheckpoints([]);
      setBlockedAccesses([]);
      setActiveTab("flow");
      setEditorSessionKey(`${slug}-${Date.now()}`);
      setError(null);
      // Load workflow-level memories
      loadWorkflowMemories(slug);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "Failed to load workflow."
      );
    } finally {
      setLoadingWorkflow(false);
    }
  }

  async function loadWorkflowMemories(slug: string) {
    setWorkflowMemoriesLoading(true);
    try {
      const data = await api.getMemories({ scope: "workflow", workflowId: slug });
      setWorkflowMemories(Array.isArray(data) ? data : []);
    } catch {
      setWorkflowMemories([]);
    } finally {
      setWorkflowMemoriesLoading(false);
    }
  }

  useEffect(() => {
    void loadListing();
  }, []);

  useEffect(() => {
    let active = true;

    void (async () => {
      const settings = await loadCloudDeploySettings();
      if (active) {
        setCloudSettings(settings);
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!deploymentDefaults) {
      return;
    }

    setArtifact((current) =>
      current ? withDeploymentPlan(current, deploymentDefaults) : current
    );
  }, [deploymentDefaults]);

  useEffect(() => {
    void loadLiveDeploymentOverview();
  }, [loadLiveDeploymentOverview]);

  useEffect(() => {
    if (!artifact) {
      setResolvedDeploymentPlan(null);
      setResolvedDeploymentPlanError("");
      setResolvedDeploymentPlanLoading(false);
      return;
    }

    if (activeTab !== "deploy") {
      return;
    }

    let cancelled = false;
    setResolvedDeploymentPlan(null);
    setResolvedDeploymentPlanError("");
    setResolvedDeploymentPlanLoading(true);

    void api
      .getWorkflowDeploymentPlan({
        artifact: deployPlanArtifact,
        provider: configuredProvider,
        region: configuredRegion,
        gcpProject:
          configuredProvider === "gcp" ? configuredGcpProject || undefined : undefined,
      })
      .then((plan) => {
        if (cancelled) {
          return;
        }
        setResolvedDeploymentPlan(plan);
      })
      .catch((planError) => {
        if (cancelled) {
          return;
        }
        setResolvedDeploymentPlanError(
          planError instanceof Error
            ? planError.message
            : "Failed to resolve the deployment plan."
        );
      })
      .finally(() => {
        if (!cancelled) {
          setResolvedDeploymentPlanLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeTab,
    artifact,
    configuredGcpProject,
    configuredProvider,
    configuredRegion,
    deployPlanArtifact,
  ]);

  function startNewWorkflow() {
    const draft = emptyArtifact(deploymentDefaults);
    manualPreviewRef.current = null;
    manualValidationRef.current = null;
    manualBuildRef.current = null;
    setSelectedSlug(null);
    resetLiveDeploymentState();
    setArtifact(draft);
    setMessages([]);
    setApprovedCheckpoints([]);
    setBlockedAccesses([]);
    setActiveTab("flow");
    setEditingTitle(false);
    setEditorSessionKey(`new-${Date.now()}`);
    setError(null);
  }

  function goBackToList() {
    manualPreviewRef.current = null;
    manualValidationRef.current = null;
    manualBuildRef.current = null;
    setSelectedSlug(null);
    resetLiveDeploymentState();
    setArtifact(null);
    setMessages([]);
    setApprovedCheckpoints([]);
    setBlockedAccesses([]);
    setEditingTitle(false);
    setAgentBusy(false);
    setError(null);
  }

  async function deleteWorkflow() {
    if (!selectedSlug) {
      return;
    }

    const workflowTitle = currentArtifact.title || selectedSlug;
    const confirmed = window.confirm(
      `Delete "${workflowTitle}"? This removes the workflow file, studio metadata, and any unsaved edits from this project.`
    );
    if (!confirmed) {
      return;
    }

    const removeDeployment =
      hasSavedDeploymentRecord || hasLiveDeploymentRecord
        ? window.confirm(
            `"${workflowTitle}" has deployment history. Click OK to also remove GTMShip deployment records and run history. Click Cancel to keep deployment records and delete only the local workflow. Cloud resources will not be undeployed.`
          )
        : false;

    setDeletingWorkflow(true);
    setError(null);
    try {
      await api.deleteWorkflow(selectedSlug, {
        removeDeployment,
      });
      goBackToList();
      await loadListing();
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Failed to delete workflow."
      );
    } finally {
      setDeletingWorkflow(false);
    }
  }

  function updateArtifact(
    updater: (current: WorkflowStudioArtifact) => WorkflowStudioArtifact
  ) {
    setArtifact((current) =>
      withDeploymentPlan(
        updater(current || emptyArtifact(deploymentDefaults)),
        deploymentDefaults
      )
    );
  }

  function updateBindingSelectorType(
    providerSlug: string,
    selectorType: WorkflowBindingSelectorType
  ) {
    updateArtifact((current) => {
      const nextBindings = [...(current.bindings || [])];
      const existingIndex = nextBindings.findIndex(
        (binding) => binding.providerSlug === providerSlug
      );
      const existingBinding =
        existingIndex >= 0
          ? nextBindings[existingIndex]
          : {
              providerSlug,
              selector: {
                type: "latest_active" as const,
              },
            };

      const nextBinding = {
        ...existingBinding,
        selector: {
          type: selectorType,
          connectionId:
            selectorType === "connection_id"
              ? existingBinding.selector.connectionId || ""
              : undefined,
          label:
            selectorType === "label"
              ? existingBinding.selector.label || ""
              : undefined,
        },
      };

      if (existingIndex >= 0) {
        nextBindings[existingIndex] = nextBinding;
      } else {
        nextBindings.push(nextBinding);
      }

      return {
        ...current,
        bindings: nextBindings,
      };
    });
  }

  function updateBindingSelectorValue(providerSlug: string, value: string) {
    updateArtifact((current) => {
      const nextBindings = [...(current.bindings || [])];
      const existingIndex = nextBindings.findIndex(
        (binding) => binding.providerSlug === providerSlug
      );
      const existingBinding =
        existingIndex >= 0
          ? nextBindings[existingIndex]
          : {
              providerSlug,
              selector: {
                type: "connection_id" as const,
              },
            };

      const nextBinding = {
        ...existingBinding,
        selector: {
          ...existingBinding.selector,
          connectionId:
            existingBinding.selector.type === "connection_id"
              ? value
              : undefined,
          label:
            existingBinding.selector.type === "label" ? value : undefined,
        },
      };

      if (existingIndex >= 0) {
        nextBindings[existingIndex] = nextBinding;
      } else {
        nextBindings.push(nextBinding);
      }

      return {
        ...current,
        bindings: nextBindings,
      };
    });
  }

  function updateWorkflowAiModel(
    providerSlug: WorkflowAiProviderSlug,
    model: string
  ) {
    updateArtifact((current) => {
      const nextAiConfigs = [...normalizeWorkflowAiConfigs(current.aiConfigs)];
      const existingIndex = nextAiConfigs.findIndex(
        (config) => config.providerSlug === providerSlug
      );
      const nextConfig: WorkflowAiConfig = {
        providerSlug,
        ...(model.trim() ? { model: model.trim() } : {}),
      };

      if (existingIndex >= 0) {
        nextAiConfigs[existingIndex] = nextConfig;
      } else {
        nextAiConfigs.push(nextConfig);
      }

      return {
        ...current,
        aiConfigs: normalizeWorkflowAiConfigs(nextAiConfigs),
      };
    });
  }

  const handleTranscriptChange = useCallback(
    (nextMessages: WorkflowStudioMessage[]) => {
      setMessages((current) =>
        areWorkflowMessagesEqual(current, nextMessages) ? current : nextMessages
      );
    },
    []
  );

  const handleArtifactSync = useCallback(
    (
      nextArtifact: WorkflowStudioArtifact | null,
      nextBlockedAccesses: WorkflowAccessRequirement[]
    ) => {
      if (nextArtifact) {
        // If the agent generated a new draft (different code), clear manual overrides
        setArtifact((current) => {
          const isNewDraft = !current || nextArtifact.code !== current.code;
          if (isNewDraft) {
            manualPreviewRef.current = null;
            manualValidationRef.current = null;
            manualBuildRef.current = null;
          }

          // Preserve manually-run preview/validation over stale agent-derived state
          let merged: WorkflowStudioArtifact = {
            ...nextArtifact,
            deploy: nextArtifact.deploy || current?.deploy,
            deploymentRun:
              nextArtifact.deploymentRun || current?.deploymentRun,
            triggerConfig: nextArtifact.triggerConfig || current?.triggerConfig,
            bindings: nextArtifact.bindings || current?.bindings,
            aiConfigs: mergeWorkflowAiConfigs(
              nextArtifact.aiConfigs,
              current?.aiConfigs
            ),
            transcriptCompaction:
              nextArtifact.transcriptCompaction ||
              current?.transcriptCompaction,
          };
          if (manualBuildRef.current) {
            merged = { ...merged, build: manualBuildRef.current };
          }
          if (manualPreviewRef.current) {
            merged = { ...merged, preview: manualPreviewRef.current };
          }
          if (manualValidationRef.current) {
            merged = { ...merged, validation: manualValidationRef.current };
          }
          const nextResolvedArtifact = withDeploymentPlan(
            merged,
            deploymentDefaults
          );
          return areWorkflowArtifactsEqual(current, nextResolvedArtifact)
            ? current
            : nextResolvedArtifact;
        });
        setSelectedSlug((current) =>
          current === nextArtifact.slug ? current : nextArtifact.slug
        );
      }

      setBlockedAccesses((current) =>
        areWorkflowAccessRequirementsEqual(current, nextBlockedAccesses)
          ? current
          : nextBlockedAccesses
      );
    },
    [deploymentDefaults]
  );

  async function runValidation() {
    if (!artifact) {
      return;
    }

    setValidating(true);
    setError(null);
    try {
      const response = await fetch("/api/workflows/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          artifact: {
            ...artifact,
            messages,
          },
        }),
      });
      const validation = await parseResponse<WorkflowValidationReport>(response);
      manualValidationRef.current = validation;
      updateArtifact((current) => ({
        ...current,
        validation,
        messages,
      }));
      setActiveTab("validation");
    } catch (validationError) {
      setError(
        validationError instanceof Error
          ? validationError.message
          : "Validation failed."
      );
    } finally {
      setValidating(false);
    }
  }

  async function runPreview(extraApproved: string[] = []) {
    if (!artifact) {
      return;
    }

    const nextApproved = Array.from(
      new Set([...approvedCheckpoints, ...extraApproved])
    );

    setPreviewing(true);
    setError(null);
    try {
      const response = await fetch("/api/workflows/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          artifact: {
            ...artifact,
            messages,
          },
          approvedCheckpoints: nextApproved,
        }),
      });
      const result = await parseResponse<WorkflowPreviewRunResponse>(response);
      const preview = result.preview;
      console.log("[workflow-studio] Preview result:", preview.status, preview.error || "");
      manualPreviewRef.current = preview;
      setApprovedCheckpoints(nextApproved);
      setArtifact(withDeploymentPlan(result.artifact, deploymentDefaults));
      setMessages(result.artifact.messages || messages);
      setSelectedSlug(result.artifact.slug);
      await loadListing();
      setActiveTab("preview");
    } catch (previewError) {
      console.error("[workflow-studio] Preview error:", previewError);
      setError(
        previewError instanceof Error ? previewError.message : "Preview failed."
      );
    } finally {
      setPreviewing(false);
    }
  }

  async function runBuild(
    extraApproved: string[] = [],
    options: { repair?: boolean } = {}
  ) {
    if (!artifact) {
      return;
    }

    const nextApproved = Array.from(
      new Set([...approvedCheckpoints, ...extraApproved])
    );

    setBuilding(true);
    setError(null);
    try {
      const response = await fetch("/api/workflows/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          artifact: {
            ...artifact,
            messages,
          },
          approvedCheckpoints: nextApproved,
          repair: options.repair || undefined,
        }),
      });
      const result = await parseResponse<WorkflowBuildRunResponse>(response);
      const nextMessages = result.artifact.messages || messages;
      manualBuildRef.current = result.build;
      manualValidationRef.current = result.build.validation || null;
      manualPreviewRef.current = result.build.preview || null;
      setApprovedCheckpoints(nextApproved);
      setBlockedAccesses(result.blockedAccesses || []);
      setMessages(nextMessages);
      setArtifact(
        withDeploymentPlan(
          result.artifact,
          deploymentDefaults
        )
      );
      setSelectedSlug(result.artifact.slug);
      await loadListing();
      setActiveTab("build");
    } catch (buildError) {
      setError(buildError instanceof Error ? buildError.message : "Build failed.");
    } finally {
      setBuilding(false);
    }
  }

  async function persistWorkflow(
    artifactOverride?: WorkflowStudioArtifact
  ): Promise<StoredWorkflowRecord> {
    const artifactToSave = artifactOverride || artifact;
    if (!artifactToSave) {
      throw new Error("A workflow is required before saving.");
    }
    const deployTargetForSave = resolveWorkflowDeployTarget({
      workflowDeploy: artifactToSave.deploy,
      cloudSettings,
      projectDefaults: deploymentDefaults,
    });
    const deploymentPlanForSave = buildWorkflowPlanFromArtifact(
      artifactToSave,
      deployTargetForSave
    );

    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/workflows/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          artifact: {
            ...artifactToSave,
            deploymentPlan: deploymentPlanForSave,
            messages,
          },
        }),
      });
      const saved = await parseResponse<StoredWorkflowRecord>(response);
      setArtifact(withDeploymentPlan(saved.artifact, deploymentDefaults));
      setMessages(saved.artifact.messages || messages);
      setSelectedSlug(saved.slug);
      await loadListing();
      return saved;
    } catch (saveError) {
      const message =
        saveError instanceof Error ? saveError.message : "Save failed.";
      setError(message);
      throw new Error(message);
    } finally {
      setSaving(false);
    }
  }

  async function saveWorkflow() {
    try {
      await persistWorkflow();
    } catch {
      // persistWorkflow already surfaces the error toast.
    }
  }

  async function runDeploy(targetMode: WorkflowDeployTargetMode) {
    if (!artifact) {
      return;
    }
    const requestedDeployTarget =
      targetMode === "local" ? localDeployTarget : cloudDeployTarget;

    if (requestedDeployTarget.provider === "gcp" && !requestedDeployTarget.gcpProject) {
      setActiveTab("deploy");
      setError("Add a GCP project before deploying to GCP.");
      return;
    }

    if (
      targetMode === "local" &&
      localDeploymentPlan.warnings.includes(LOCAL_DEPLOY_UNSUPPORTED_WARNING)
    ) {
      setActiveTab("deploy");
      setError(LOCAL_DEPLOY_UNSUPPORTED_WARNING);
      return;
    }

    setDeploying(true);
    setDeployingTargetMode(targetMode);
    setActiveTab("deploy");
    setError(null);

    try {
      const saved = await persistWorkflow(artifact);
      const response = (await api.deploy({
        provider: requestedDeployTarget.provider,
        region: requestedDeployTarget.region,
        gcpProject:
          requestedDeployTarget.provider === "gcp"
            ? requestedDeployTarget.gcpProject || undefined
            : undefined,
        projectName: listing?.projectName || "gtmship",
        workflow: saved.slug,
        artifact: saved.artifact,
      })) as WorkflowStudioDeployResponse;
      const fallbackDeploymentRun: WorkflowDeploymentRun =
        isDashboardDeploySuccess(response)
          ? {
              status: "success",
              provider: requestedDeployTarget.provider,
              region: requestedDeployTarget.region,
              gcpProject:
                requestedDeployTarget.provider === "gcp"
                  ? requestedDeployTarget.gcpProject || undefined
                  : undefined,
              projectName: listing?.projectName || "gtmship",
              deployedAt: new Date().toISOString(),
              apiEndpoint: response.apiEndpoint,
              computeId: response.computeId,
              databaseEndpoint: response.databaseEndpoint,
              storageBucket: response.storageBucket,
              schedulerJobId: response.schedulerJobId,
              output: response.output,
            }
          : {
              status: "error",
              provider: requestedDeployTarget.provider,
              region: requestedDeployTarget.region,
              gcpProject:
                requestedDeployTarget.provider === "gcp"
                  ? requestedDeployTarget.gcpProject || undefined
                  : undefined,
              projectName: listing?.projectName || "gtmship",
              deployedAt: new Date().toISOString(),
              error: response.error,
              output: response.output,
            };

      if (response.artifact) {
        setArtifact(withDeploymentPlan(response.artifact, deploymentDefaults));
        setMessages(response.artifact.messages || messages);
        setSelectedSlug(response.artifact.slug);
      } else {
        updateArtifact((current) => ({
          ...current,
          deploymentRun: fallbackDeploymentRun,
          messages,
        }));
      }

      await loadListing();

      if (!isDashboardDeploySuccess(response)) {
        return;
      }

      if (
        workflowDeploymentTargetsMatch(
          configuredDeployTarget,
          requestedDeployTarget
        )
      ) {
        void loadLiveDeploymentOverview({
          forceReconcile: true,
          deploymentTarget: requestedDeployTarget,
        });
      }
    } catch (deployError) {
      setError(
        deployError instanceof Error ? deployError.message : "Deployment failed."
      );
    } finally {
      setDeploying(false);
      setDeployingTargetMode(null);
    }
  }

  async function loadProjects() {
    try {
      const response = await fetch("/api/projects", { cache: "no-store" });
      const data = await response.json();
      setProjects(data.projects || []);
    } catch {
      // ignore
    }
  }

  async function switchProject(projectPath: string) {
    setSwitchingProject(true);
    setError(null);
    try {
      await api.setSetting("project_root", projectPath);
      await loadListing();
      setShowProjectPicker(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to switch project.");
    } finally {
      setSwitchingProject(false);
    }
  }

  async function handleCreateProject() {
    if (!newProjectName.trim()) return;
    setCreatingProject(true);
    setError(null);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newProjectName.trim() }),
      });
      const project = await response.json();
      if (!response.ok) throw new Error(project.error);
      await api.setSetting("project_root", project.path);
      setNewProjectName("");
      await loadListing();
      setShowProjectPicker(false);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to create project."
      );
    } finally {
      setCreatingProject(false);
    }
  }

  const resolveDeployInfraValue = (key: DashboardDeployInfraKey): string | null => {
    const deployedValue = deployResult?.[key];
    if (typeof deployedValue === "string" && deployedValue.trim()) {
      return deployedValue.trim();
    }

    if (liveDeploymentOverview && configuredTargetMatchesLastRun) {
      if (key === "apiEndpoint") {
        return (
          liveDeploymentOverview.platform?.endpointUrl ||
          liveDeploymentOverview.endpointUrl ||
          null
        );
      }
      if (key === "computeId") {
        return liveDeploymentOverview.platform?.computeName || null;
      }
      if (key === "schedulerJobId") {
        return (
          liveDeploymentOverview.platform?.schedulerJobId ||
          liveDeploymentOverview.schedulerId ||
          null
        );
      }
    }

    return null;
  };

  const workflows: WorkflowListItem[] = listing?.workflows || [];
  const tabs: Array<{
    value: StudioTab;
    label: string;
    icon: typeof Workflow;
  }> = [
    { value: "flow", label: "Flow", icon: Workflow },
    { value: "code", label: "Code", icon: Code2 },
    { value: "validation", label: "Validation", icon: FileJson },
    { value: "preview", label: "Preview", icon: Play },
    { value: "build", label: "Build", icon: Package },
    { value: "deploy", label: "Deploy", icon: Rocket },
  ];
  const projectName =
    listing?.projectName || listing?.projectRoot?.split("/").pop() || "default";
  const workflowCountLabel = formatWorkflowCount(workflows.length);
  const projectPickerToggleLabel = showProjectPicker
    ? "Hide projects"
    : listing?.projectRootConfigured
      ? "Switch project"
      : "Choose project";

  return (
    <div
      className={cn(
        "relative",
        showEditor
          ? "flex h-[calc(100vh-1rem)] min-h-[720px] flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950"
          : "mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-8"
      )}
    >
      {!showEditor ? (
        <div className="space-y-6">
          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
            <div className="space-y-6">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                <div className="max-w-3xl">
                  <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                    Workflows
                  </h1>
                  <p className="mt-2 text-sm leading-7 text-zinc-400">
                    {listing?.projectRootConfigured
                      ? `${workflowCountLabel} in ${projectName}. Open an existing draft or start a new workflow.`
                      : "Pick a project workspace, then open an existing draft or start a new workflow."}
                  </p>
                </div>

                <button
                  onClick={startNewWorkflow}
                  disabled={loadingWorkflow}
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Plus size={14} />
                  New workflow
                </button>
              </div>

              <div className="flex flex-col gap-4 rounded-xl border border-zinc-800 bg-zinc-950/40 p-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="text-xs text-zinc-500">Project</p>
                  <p className="mt-1 text-sm font-medium text-zinc-200">
                    {listing?.projectRootConfigured
                      ? projectName
                      : "Choose where workflows live"}
                  </p>
                  <p className="mt-1 text-sm text-zinc-500">
                    {listing?.projectRootConfigured
                      ? `${workflowCountLabel} available in this workspace.`
                      : "Workflow Studio needs a project workspace before it can save drafts."}
                  </p>
                  {listing?.projectRoot ? (
                    <p className="mt-2 truncate text-xs text-zinc-600">
                      {listing.projectRoot}
                    </p>
                  ) : null}
                </div>

                <button
                  onClick={() => {
                    if (!showProjectPicker) {
                      void loadProjects();
                    }
                    setShowProjectPicker((current) => !current);
                  }}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-700 px-4 py-2.5 text-sm text-zinc-300 transition-colors hover:border-zinc-600 hover:text-white"
                >
                  {switchingProject ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : showProjectPicker ? (
                    <X size={14} />
                  ) : (
                    <ChevronRight size={14} />
                  )}
                  {projectPickerToggleLabel}
                </button>
              </div>

              {showProjectPicker ? (
                <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4">
                  <div className="flex flex-col gap-3">
                    <div className="max-w-2xl">
                      <p className="text-sm font-medium text-white">
                        Projects
                      </p>
                      <p className="mt-1 text-sm leading-6 text-zinc-500">
                        Each project keeps its own workflows directory. Pick an
                        existing project or create a new project for a separate
                        workflow list.
                      </p>
                    </div>
                  </div>

                  {projects.length === 0 ? (
                    <div className="mt-4 rounded-xl border border-dashed border-zinc-800 bg-zinc-950/60 px-6 py-10 text-center text-sm text-zinc-500">
                      No saved projects yet. Create one below to start a fresh
                      workflow workspace.
                    </div>
                  ) : (
                    <div className="mt-4 grid gap-3 lg:grid-cols-2">
                      {projects.map((project) => (
                        <button
                          key={project.path}
                          onClick={() => void switchProject(project.path)}
                          disabled={switchingProject}
                          className={cn(
                            "flex w-full items-start justify-between gap-4 rounded-xl border px-4 py-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-70",
                            listing?.projectRoot === project.path
                              ? "border-zinc-700 bg-zinc-900/80 text-white"
                              : "border-zinc-800 bg-zinc-950/60 text-zinc-300 hover:border-zinc-700 hover:bg-zinc-900/70"
                          )}
                        >
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-sm font-medium">
                                {project.name}
                              </p>
                              {project.isDefault ? (
                                <span className="rounded-full border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-zinc-500">
                                  Default
                                </span>
                              ) : null}
                            </div>
                            <p className="mt-2 text-sm leading-6 text-zinc-500">
                              {formatWorkflowCount(project.workflowCount)} in
                              this workspace.
                            </p>
                            <p className="mt-2 truncate text-xs text-zinc-600">
                              {project.path}
                            </p>
                          </div>

                          <div className="mt-0.5 shrink-0 text-zinc-500">
                            {switchingProject &&
                            listing?.projectRoot === project.path ? (
                              <Loader2 size={16} className="animate-spin" />
                            ) : (
                              <ChevronRight size={16} />
                            )}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                    <input
                      value={newProjectName}
                      onChange={(e) => setNewProjectName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void handleCreateProject();
                      }}
                      placeholder="New project name"
                      className="w-full rounded-xl border border-zinc-800 bg-zinc-950/90 px-3 py-3 text-sm text-white placeholder-zinc-600 outline-none transition-colors focus:border-blue-500"
                    />
                    <button
                      onClick={() => void handleCreateProject()}
                      disabled={creatingProject || !newProjectName.trim()}
                      className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {creatingProject ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <FolderPlus size={14} />
                      )}
                      Create project
                    </button>
                  </div>
                </div>
              ) : null}

              {loadingList ? (
                <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 px-5 py-12 text-center">
                  <div className="inline-flex items-center gap-2 text-sm text-zinc-500">
                    <Loader2 size={16} className="animate-spin" />
                    Loading workflows...
                  </div>
                </div>
              ) : workflows.length === 0 ? (
                <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 px-6 py-14 text-center">
                  <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900 text-zinc-400">
                    <Workflow size={22} />
                  </div>
                  <h3 className="mt-5 text-xl font-semibold text-white">
                    No workflows yet
                  </h3>
                  <p className="mx-auto mt-3 max-w-xl text-sm leading-7 text-zinc-500">
                    Start a new workflow when you are ready to generate code,
                    inspect docs, and keep the draft in sync with the agent.
                  </p>
                  <button
                    onClick={startNewWorkflow}
                    className="mt-6 inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700"
                  >
                    <Plus size={14} />
                    Create your first workflow
                  </button>
                </div>
              ) : (
                <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/40">
                  <div className="divide-y divide-zinc-800/80">
                    {workflows.map((workflow) => {
                      const isOpening =
                        loadingWorkflow && selectedSlug === workflow.slug;

                      return (
                        <button
                          key={workflow.slug}
                          onClick={() => void loadWorkflow(workflow.slug)}
                          disabled={loadingWorkflow}
                          className={cn(
                            "group flex w-full flex-col gap-3 px-5 py-4 text-left transition-colors hover:bg-zinc-900/60 focus:outline-none focus-visible:bg-zinc-900/60 disabled:cursor-not-allowed",
                            selectedSlug === workflow.slug
                              ? "bg-zinc-900/70"
                              : ""
                          )}
                        >
                          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                            <div className="min-w-0 max-w-3xl">
                              <div className="flex flex-wrap items-center gap-2">
                                <h3 className="truncate text-base font-semibold text-white">
                                  {workflow.title}
                                </h3>
                                <span
                                  className={cn(
                                    "rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.18em]",
                                    workflow.hasStudioMetadata
                                      ? "border-zinc-700 bg-zinc-900 text-zinc-300"
                                      : "border-zinc-800 bg-zinc-950 text-zinc-500"
                                  )}
                                >
                                  {workflow.hasStudioMetadata
                                    ? "Studio"
                                    : "Legacy"}
                                </span>
                              </div>
                              <p className="mt-2 line-clamp-2 text-sm leading-6 text-zinc-500">
                                {workflow.summary ||
                                  "No summary yet for this workflow."}
                              </p>
                            </div>

                            <div className="hidden shrink-0 items-center gap-2 self-center text-sm text-zinc-600 sm:flex">
                              {isOpening ? (
                                <>
                                  <Loader2
                                    size={14}
                                    className="animate-spin"
                                  />
                                  <span>Opening</span>
                                </>
                              ) : (
                                <ChevronRight
                                  size={16}
                                  className="transition-transform group-hover:translate-x-0.5"
                                />
                              )}
                            </div>
                          </div>

                          <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                            <span>{workflow.trigger}</span>
                            <span>Updated {formatDate(workflow.updatedAt)}</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      ) : (
        <>
          <header className="flex items-center justify-between gap-4 border-b border-zinc-800 bg-zinc-950/80 px-5 py-3">
            <div className="min-w-0 flex items-center gap-3">
              <button
                onClick={goBackToList}
                className="flex items-center gap-1.5 rounded-lg border border-zinc-800 px-2.5 py-2 text-xs text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-200"
              >
                <ArrowLeft size={14} />
              </button>

              <div className="min-w-0">
                {editingTitle ? (
                  <input
                    autoFocus
                    value={currentArtifact.title}
                    onChange={(event) =>
                      updateArtifact((current) => ({
                        ...current,
                        title: event.target.value,
                      }))
                    }
                    onBlur={() => setEditingTitle(false)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === "Escape") {
                        setEditingTitle(false);
                      }
                    }}
                    className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-base font-semibold text-white outline-none focus:border-blue-600"
                  />
                ) : (
                  <button
                    onClick={() => setEditingTitle(true)}
                    className="group flex items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-zinc-900"
                  >
                    <h2 className="truncate text-base font-semibold text-white">
                      {currentArtifact.title}
                    </h2>
                    <Pencil
                      size={12}
                      className="shrink-0 text-zinc-600 opacity-0 transition-opacity group-hover:opacity-100"
                    />
                  </button>
                )}
                <p className="mt-0.5 truncate px-2 text-xs text-zinc-500">
                  {currentArtifact.summary}
                </p>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {agentBusy ? (
                <span className="rounded-full bg-blue-500/10 px-2.5 py-1 text-[10px] uppercase tracking-wide text-blue-300">
                  agent running
                </span>
              ) : null}
              {agentBusy ? (
                <button
                  onClick={cancelAgentRun}
                  className="flex items-center gap-2 rounded-lg border border-rose-500/40 px-3 py-2 text-xs text-rose-200 transition-colors hover:bg-rose-500/10"
                  title="Stop the current workflow agent run (Esc)"
                >
                  <X size={12} />
                  Cancel
                </button>
              ) : null}
              <button
                onClick={() => void runValidation()}
                disabled={
                  !artifact ||
                  validating ||
                  building ||
                  deploying ||
                  deletingWorkflow ||
                  agentBusy
                }
                className="flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300 transition-colors hover:bg-zinc-900 disabled:opacity-50"
              >
                {validating ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <FileJson size={12} />
                )}
                Validate
              </button>
              <button
                onClick={() => void runPreview()}
                disabled={
                  !artifact ||
                  previewing ||
                  building ||
                  deploying ||
                  deletingWorkflow ||
                  agentBusy
                }
                className="flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300 transition-colors hover:bg-zinc-900 disabled:opacity-50"
              >
                {previewing ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Play size={12} />
                )}
                Preview
              </button>
              <button
                onClick={() => void runBuild()}
                disabled={
                  !artifact ||
                  validating ||
                  previewing ||
                  building ||
                  saving ||
                  deploying ||
                  deletingWorkflow ||
                  agentBusy
                }
                className="flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300 transition-colors hover:bg-zinc-900 disabled:opacity-50"
              >
                {building ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Package size={12} />
                )}
                Build
              </button>
              <button
                onClick={() => void saveWorkflow()}
                disabled={
                  !artifact ||
                  saving ||
                  building ||
                  deploying ||
                  deletingWorkflow ||
                  agentBusy
                }
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
              >
                {saving ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Save size={12} />
                )}
                Save
              </button>
              {selectedSlug ? (
                <button
                  onClick={() => void deleteWorkflow()}
                  disabled={deleteWorkflowDisabled}
                  className="flex items-center gap-2 rounded-lg border border-rose-500/40 px-3 py-2 text-xs font-medium text-rose-200 transition-colors hover:bg-rose-500/10 disabled:opacity-50"
                >
                  {deletingWorkflow ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Trash2 size={12} />
                  )}
                  {deletingWorkflow ? "Deleting..." : "Delete"}
                </button>
              ) : null}
            </div>
          </header>

          <div className="flex min-h-0 flex-1">
            <div className="flex w-[32rem] shrink-0 flex-col border-r border-zinc-800">
              {loadingWorkflow ? (
                <div className="flex flex-1 items-center justify-center gap-2 text-sm text-zinc-500">
                  <Loader2 size={14} className="animate-spin" />
                  Loading workflow...
                </div>
              ) : (
                <WorkflowConversationPanel
                  key={editorSessionKey}
                  ref={conversationRef}
                  sessionKey={editorSessionKey}
                  initialMessages={messages}
                  artifact={{
                    ...currentArtifact,
                    messages,
                  }}
                  onTranscriptChange={handleTranscriptChange}
                  onArtifactSync={handleArtifactSync}
                  onBusyChange={setAgentBusy}
                  onError={setError}
                />
              )}
            </div>

            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex items-center gap-1 border-b border-zinc-800 px-5 py-2">
                {tabs.map(({ value, label, icon: Icon }) => (
                  <button
                    key={value}
                    onClick={() => setActiveTab(value)}
                    className={cn(
                      "flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors",
                      activeTab === value
                        ? "bg-blue-600/10 text-blue-400"
                        : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
                    )}
                  >
                    <Icon size={14} />
                    {label}
                  </button>
                ))}
              </div>

              <div className="flex-1 overflow-y-auto p-5">
                {activeTab === "flow" ? (
                  <div className="space-y-6">
                    <MermaidDiagram chart={currentArtifact.mermaid} />

                    <details className="group overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/40 shadow-[0_0_0_1px_rgba(255,255,255,0.02)]">
                      <summary className="flex cursor-pointer items-center justify-between gap-3 px-5 py-4 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-900/60">
                        <div className="flex items-center gap-2">
                          <ChevronRight
                            size={14}
                            className="text-zinc-500 transition-transform group-open:rotate-90"
                          />
                          <span>Mermaid Source</span>
                        </div>
                        <span className="rounded-full border border-blue-500/20 bg-blue-500/10 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-blue-200">
                          Live editable
                        </span>
                      </summary>
                      <div className="border-t border-zinc-800 bg-zinc-950/35 px-5 py-5">
                        <p className="mb-4 max-w-2xl text-sm leading-6 text-zinc-500">
                          Fine-tune labels, group related steps, or adjust flow direction when you want the visual story to be tighter than the generated default.
                        </p>
                        <textarea
                          value={currentArtifact.mermaid}
                          onChange={(event) =>
                            updateArtifact((current) => ({
                              ...current,
                              mermaid: event.target.value,
                            }))
                          }
                          rows={8}
                          className="w-full rounded-2xl border border-zinc-800 bg-zinc-950/90 px-4 py-4 font-mono text-xs leading-6 text-zinc-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] outline-none transition-colors focus:border-blue-500"
                        />
                      </div>
                    </details>

                    <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-5">
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                        Required Access
                      </h4>
                      {hasConnectionBlockers ? (
                        <div className="mt-3">
                          <ConnectionBlockerCallout
                            blockers={connectionBlockers}
                            connectionsChanged={connectionsChangedSinceBlocker}
                            onUseConnectionsAgent={openConnectionsAgent}
                            onRecheckConnections={() => {
                              void recheckConnections();
                            }}
                            recheckDisabled={recheckConnectionsDisabled}
                            rechecking={agentBusy}
                          />
                        </div>
                      ) : null}
                      {visibleAccesses.length === 0 ? (
                        <p className="mt-3 text-xs text-zinc-600">
                          Access requirements will appear after generation.
                        </p>
                      ) : (
                        <div className="mt-3 space-y-2">
                          {visibleAccesses.map((access) => (
                            <div
                              key={access.id}
                              className="rounded-lg border border-zinc-800 px-3 py-2"
                            >
                              <div className="flex items-center justify-between gap-3">
                                <p className="text-xs font-medium text-white">
                                  {access.label}
                                </p>
                                <span
                                  className={cn(
                                    "rounded-full px-2 py-0.5 text-[10px]",
                                    access.status === "verified" ||
                                      access.status === "reachable"
                                      ? "bg-emerald-500/10 text-emerald-300"
                                      : access.status === "missing" ||
                                          access.status === "blocked"
                                        ? "bg-amber-500/10 text-amber-200"
                                        : "bg-zinc-800 text-zinc-400"
                                  )}
                                >
                                  {access.status}
                                </span>
                              </div>
                              <p className="mt-1 text-xs text-zinc-500">
                                {access.purpose}
                              </p>
                              {access.statusMessage ? (
                                <p className="mt-1 text-[11px] text-zinc-600">
                                  {access.statusMessage}
                                </p>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-5">
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                        Write Checkpoints
                      </h4>
                      {currentArtifact.writeCheckpoints.length === 0 ? (
                        <p className="mt-3 text-xs text-zinc-600">
                          No write approvals required for the current artifact.
                        </p>
                      ) : (
                        <div className="mt-3 space-y-2">
                          {currentArtifact.writeCheckpoints.map((checkpoint) => (
                            <div
                              key={checkpoint.id}
                              className="rounded-lg border border-zinc-800 px-3 py-2"
                            >
                              <div className="flex items-center justify-between gap-3">
                                <p className="text-xs font-medium text-white">
                                  {checkpoint.label}
                                </p>
                                <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-300">
                                  {checkpoint.method}
                                </span>
                              </div>
                              <p className="mt-1 text-xs text-zinc-500">
                                {checkpoint.description}
                              </p>
                              <p className="mt-1 text-[11px] text-zinc-600">
                                {checkpoint.providerSlug ||
                                  checkpoint.url ||
                                  checkpoint.id}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {selectedSlug && (
                      <details className="group overflow-hidden rounded-2xl border border-purple-800/30 bg-purple-950/10 shadow-[0_0_0_1px_rgba(255,255,255,0.02)]">
                        <summary className="flex cursor-pointer items-center justify-between gap-3 px-5 py-4 text-sm font-medium text-zinc-200 transition-colors hover:bg-purple-950/20">
                          <div className="flex items-center gap-2">
                            <Brain size={14} className="text-purple-400" />
                            <span>Workflow Memory</span>
                          </div>
                          <span className="rounded-full border border-purple-500/20 bg-purple-500/10 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-purple-300">
                            {workflowMemoriesLoading
                              ? "..."
                              : `${workflowMemories.length} saved`}
                          </span>
                        </summary>
                        <div className="border-t border-purple-800/20 px-5 py-4">
                          {workflowMemoriesLoading ? (
                            <div className="flex items-center gap-2 py-4 justify-center text-xs text-zinc-500">
                              <Loader2
                                size={12}
                                className="animate-spin"
                              />
                              Loading...
                            </div>
                          ) : workflowMemories.length === 0 ? (
                            <p className="py-4 text-center text-xs text-zinc-500">
                              No memories for this workflow yet. The AI agent
                              will save validated knowledge here during
                              conversations.
                            </p>
                          ) : (
                            <div className="space-y-2 max-h-60 overflow-y-auto">
                              {workflowMemories.map((memory) => (
                                <div
                                  key={memory.id}
                                  className="group/mem flex items-start gap-2 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2"
                                >
                                  <div className="flex-1 min-w-0">
                                    <p className="text-xs text-zinc-300 leading-relaxed">
                                      {memory.content}
                                    </p>
                                    <div className="mt-1.5 flex items-center gap-1.5 text-[10px]">
                                      <span className="rounded bg-purple-900/40 px-1.5 py-0.5 text-purple-300">
                                        {memory.category}
                                      </span>
                                      <span className="text-zinc-600">
                                        {new Date(
                                          memory.createdAt
                                        ).toLocaleDateString()}
                                      </span>
                                    </div>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={async () => {
                                      await api.deleteMemory(memory.id);
                                      setWorkflowMemories((ms) =>
                                        ms.filter((m) => m.id !== memory.id)
                                      );
                                    }}
                                    className="shrink-0 rounded p-1 text-zinc-600 opacity-0 transition-all group-hover/mem:opacity-100 hover:text-red-400"
                                  >
                                    <Trash2 size={12} />
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              if (selectedSlug) loadWorkflowMemories(selectedSlug);
                            }}
                            className="mt-3 flex items-center gap-1.5 text-[11px] text-zinc-500 transition-colors hover:text-purple-400"
                          >
                            <RefreshCw size={10} />
                            Refresh
                          </button>
                        </div>
                      </details>
                    )}
                  </div>
                ) : null}

                {activeTab === "deploy" ? (
                  <div className="space-y-5">
                    <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-5">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <h4 className="text-sm font-medium text-white">
                            Deployment Run
                          </h4>
                          <p className="mt-1 text-xs text-zinc-500">
                            Auto-saves this workflow, then deploys it with the
                            same shared deploy flow used by the Deploy page.
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-[10px] uppercase tracking-wide text-zinc-500">
                            Configured target
                          </p>
                          <span className="mt-1 inline-flex rounded-full border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300">
                            {configuredTargetLabel}
                          </span>
                        </div>
                      </div>

                      <div className="mt-4 grid gap-2 text-xs text-zinc-400 md:grid-cols-2">
                        <p>
                          <span className="text-zinc-500">Workflow:</span>{" "}
                          {selectedSlug || currentArtifact.slug}
                        </p>
                        <p>
                          <span className="text-zinc-500">
                            Configured provider:
                          </span>{" "}
                          {effectiveDeployTarget.provider.toUpperCase()}
                        </p>
                        <p>
                          <span className="text-zinc-500">Configured region:</span>{" "}
                          {effectiveDeployTarget.region}
                        </p>
                        {effectiveDeployTarget.provider === "gcp" ? (
                          <p>
                            <span className="text-zinc-500">
                              Configured GCP project:
                            </span>{" "}
                            {effectiveDeployTarget.gcpProject || "Missing"}
                          </p>
                        ) : null}
                      </div>

                      <div className="mt-4 flex flex-wrap gap-3">
                        <button
                          onClick={() => void runDeploy("local")}
                          disabled={localDeployDisabled}
                          className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs font-medium text-zinc-100 transition-colors hover:bg-zinc-900 disabled:opacity-50"
                        >
                          {deploying && deployingTargetMode === "local" ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <Rocket size={12} />
                          )}
                          {deploying && deployingTargetMode === "local"
                            ? saving
                              ? "Saving..."
                              : "Deploying..."
                            : "Deploy to Local"}
                        </button>
                        <button
                          onClick={() => void runDeploy("cloud")}
                          disabled={cloudDeployDisabled}
                          className="flex items-center gap-2 rounded-lg border border-emerald-700 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-200 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
                        >
                          {deploying && deployingTargetMode === "cloud" ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <Rocket size={12} />
                          )}
                          {deploying && deployingTargetMode === "cloud"
                            ? saving
                              ? "Saving..."
                              : "Deploying..."
                            : `Deploy to ${cloudDeployTarget.provider.toUpperCase()}`}
                        </button>
                      </div>

                      {cloudMissingGcpProject ? (
                        <div className="mt-4 rounded-md border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-100">
                          Add a GCP project in this workflow or in Settings
                          before deploying to GCP.
                        </div>
                      ) : null}

                      {localDeployUnsupportedReason ? (
                        <div className="mt-4 rounded-md border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-100">
                          Local deployments are available only for manual and
                          schedule workflows.
                        </div>
                      ) : null}

                      {deploying ? (
                        <div className="mt-4 flex items-center gap-2 rounded-md border border-blue-900/40 bg-blue-950/20 px-3 py-3 text-sm text-blue-100">
                          <Loader2 size={14} className="animate-spin text-blue-300" />
                          Saving and deploying this workflow...
                        </div>
                      ) : null}

                      {deployStatus === "idle" && !deploying ? (
                        <p className="mt-4 text-xs text-zinc-500">
                          Choose whether to deploy this workflow locally or to
                          the configured cloud target.
                        </p>
                      ) : null}

                      {deploymentSecretSyncSummary ? (
                        <DeploymentSecretSyncCard
                          summary={deploymentSecretSyncSummary}
                          title="Secrets Included In This Deploy"
                          description="These connection secret references are included for the configured workflow deployment."
                          className="mt-4"
                        />
                      ) : resolvedDeploymentPlanLoading ? (
                        <p className="mt-4 text-xs text-zinc-500">
                          Resolving connection bindings and included secrets for
                          the configured deploy target...
                        </p>
                      ) : resolvedDeploymentPlanError ? (
                        <div className="mt-4 rounded-md border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-100">
                          Failed to resolve the configured deploy plan. Secret
                          sync details may be temporarily unavailable.
                        </div>
                      ) : null}

                      {deployStatus === "success" ? (
                        <div className="mt-4 rounded-md border border-emerald-900/40 bg-emerald-950/20 px-3 py-3">
                          <div className="flex items-center gap-2 text-sm text-emerald-200">
                            <CheckCircle2 size={14} className="text-emerald-300" />
                            Deployment completed successfully.
                          </div>
                          {deploymentRun?.deployedAt ? (
                            <p className="mt-2 text-xs text-zinc-400">
                              Last run: {formatDate(deploymentRun.deployedAt)}
                            </p>
                          ) : null}
                          {deploymentRunTargetLabel ? (
                            <p className="mt-1 text-xs text-emerald-200/80">
                              Last run target: {deploymentRunTargetLabel}
                            </p>
                          ) : null}
                          <div className="mt-3 space-y-2 text-xs text-zinc-400">
                            {deployInfra.map((item) => (
                              <div
                                key={item.key}
                                className="flex items-center justify-between gap-4"
                              >
                                <span>{item.label}</span>
                                <span
                                  className={
                                    resolveDeployInfraValue(item.key)
                                      ? "text-emerald-300"
                                      : "text-zinc-600"
                                  }
                                >
                                  {resolveDeployInfraValue(item.key) || "Not deployed"}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      <div className="mt-4 rounded-md border border-zinc-800 bg-zinc-950/50 px-3 py-3">
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                            {effectiveProvider === "gcp"
                              ? "Live GCP Deployment"
                              : effectiveProvider === "local"
                                ? "Live Local Deployment"
                                : "Live AWS Deployment"}
                          </p>
                          <div className="flex items-center gap-2">
                            {(liveDeploymentError || hasLiveDeploymentSyncWarning) ? (
                              <button
                                onClick={() =>
                                  void loadLiveDeploymentOverview({
                                    forceReconcile: true,
                                  })
                                }
                                disabled={liveDeploymentLoading}
                                className="flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-900 disabled:opacity-50"
                              >
                                <RefreshCw size={12} />
                                {liveDeploymentLoading &&
                                liveDeploymentAction === "retry"
                                  ? "Retrying..."
                                  : "Retry status sync"}
                              </button>
                            ) : null}
                            <button
                              onClick={() =>
                                void loadLiveDeploymentOverview({
                                  forceReconcile:
                                    !liveDeploymentOverview && !liveDeploymentError,
                                })
                              }
                              disabled={liveDeploymentLoading}
                              className="rounded-md border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-900 disabled:opacity-50"
                            >
                              {liveDeploymentLoading &&
                              liveDeploymentAction === "refresh"
                                ? "Refreshing..."
                                : "Refresh"}
                            </button>
                          </div>
                        </div>

                        {liveDeploymentError ? (
                          <div className="rounded-md border border-red-900/40 bg-red-950/20 px-3 py-2 text-xs text-red-200">
                            <div className="flex items-center justify-between gap-3">
                              <p>{liveDeploymentError}</p>
                              <button
                                onClick={() =>
                                  void loadLiveDeploymentOverview({
                                    forceReconcile: true,
                                  })
                                }
                                disabled={liveDeploymentLoading}
                                className="whitespace-nowrap rounded-md border border-red-900/60 px-2 py-1 text-[11px] text-red-100 transition-colors hover:bg-red-900/20 disabled:opacity-50"
                              >
                                {liveDeploymentLoading &&
                                liveDeploymentAction === "retry"
                                  ? "Retrying..."
                                  : "Retry status sync"}
                              </button>
                            </div>
                          </div>
                        ) : null}

                        {!liveDeploymentLoading &&
                        !liveDeploymentOverview &&
                        !liveDeploymentError ? (
                          <p className="text-xs text-zinc-500">
                            No deployment record found for this workflow yet.
                          </p>
                        ) : null}

                        {liveDeploymentOverview ? (
                          <div className="space-y-3">
                            <div className="grid gap-2 text-xs text-zinc-400 md:grid-cols-2">
                              <p>
                                <span className="text-zinc-500">Compute:</span>{" "}
                                {formatProviderComputeLabel(
                                  effectiveProvider,
                                  liveDeploymentOverview.platform?.computeType ||
                                    liveDeploymentOverview.executionKind
                                )}{" "}
                                ({liveDeploymentOverview.platform?.computeName || "unknown"})
                              </p>
                              <p>
                                <span className="text-zinc-500">Scheduler:</span>{" "}
                                {liveDeploymentOverview.platform?.schedulerJobId ||
                                  liveDeploymentOverview.schedulerId ||
                                  "Not configured"}
                              </p>
                              <p>
                                <span className="text-zinc-500">
                                  {effectiveProvider === "gcp"
                                    ? "Project"
                                    : effectiveProvider === "local"
                                      ? "Log Path"
                                      : "Log Group"}
                                  :
                                </span>{" "}
                                {effectiveProvider === "gcp"
                                  ? liveDeploymentOverview.platform?.gcpProject ||
                                    liveDeploymentOverview.gcpProject ||
                                    "N/A"
                                  : effectiveProvider === "local"
                                    ? liveDeploymentOverview.platform?.logPath || "N/A"
                                    : liveDeploymentOverview.platform?.logGroupName ||
                                      "N/A"}
                              </p>
                              <p>
                                <span className="text-zinc-500">Last deployed:</span>{" "}
                                {formatDateTime(
                                  liveDeploymentOverview.deployedAt ||
                                    liveDeploymentOverview.updatedAt
                                )}
                              </p>
                              <p>
                                <span className="text-zinc-500">Status:</span>{" "}
                                {(
                                  liveDeploymentOverview.recentExecutions?.[0]?.status ||
                                  liveDeploymentOverview.status ||
                                  "unknown"
                                ).toUpperCase()}
                              </p>
                            </div>

                            {liveDeploymentOverview.platform?.endpointUrl ? (
                              <p className="break-all text-xs text-zinc-400">
                                <span className="text-zinc-500">Endpoint:</span>{" "}
                                {liveDeploymentOverview.platform.endpointUrl}
                              </p>
                            ) : null}

                            {liveDeploymentOverview.liveError ? (
                              <div className="rounded-md border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-100">
                                <div className="flex items-center justify-between gap-3">
                                  <p>{liveDeploymentOverview.liveError}</p>
                                  <button
                                    onClick={() =>
                                      void loadLiveDeploymentOverview({
                                        forceReconcile: true,
                                      })
                                    }
                                    disabled={liveDeploymentLoading}
                                    className="whitespace-nowrap rounded-md border border-amber-900/60 px-2 py-1 text-[11px] text-amber-100 transition-colors hover:bg-amber-900/20 disabled:opacity-50"
                                  >
                                    {liveDeploymentLoading &&
                                    liveDeploymentAction === "retry"
                                      ? "Retrying..."
                                      : "Retry status sync"}
                                  </button>
                                </div>
                              </div>
                            ) : null}

                            {(liveDeploymentOverview.recentExecutions || []).length > 0 ? (
                              <div className="space-y-2">
                                <p className="text-[11px] uppercase tracking-wide text-zinc-500">
                                  Recent Runs
                                </p>
                                {(liveDeploymentOverview.recentExecutions || []).map(
                                  (
                                    execution: WorkflowExecutionHistoryEntry,
                                    index: number
                                  ) => (
                                    <div
                                      key={`${liveDeploymentOverview.id}-run-${execution.executionName || index}`}
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
                                        <a
                                          href={buildDeploymentLogsHref({
                                            provider: effectiveProvider,
                                            deploymentId: liveDeploymentOverview.id,
                                            workflowId: selectedWorkflowId,
                                            workflowSlug: selectedSlug,
                                            executionName:
                                              execution.executionName || undefined,
                                          })}
                                          className="text-[11px] text-blue-300 hover:text-blue-200"
                                        >
                                          Logs
                                        </a>
                                      </div>
                                    </div>
                                  )
                                )}
                              </div>
                            ) : (
                              <p className="text-xs text-zinc-500">
                                No recent executions reported yet.
                              </p>
                            )}
                          </div>
                        ) : null}
                      </div>

                      {deployStatus === "error" ? (
                        <div className="mt-4 rounded-md border border-rose-900/40 bg-rose-950/20 px-3 py-3 text-sm text-rose-100">
                          <div className="flex items-center gap-2">
                            <AlertCircle size={14} className="text-rose-300" />
                            {deployErrorMessage || "Deployment failed."}
                          </div>
                          {deploymentRun?.deployedAt ? (
                            <p className="mt-2 text-xs text-rose-200/80">
                              Last attempt: {formatDate(deploymentRun.deployedAt)}
                            </p>
                          ) : null}
                          {deploymentRunTargetLabel ? (
                            <p className="mt-1 text-xs text-rose-200/80">
                              Last attempt target: {deploymentRunTargetLabel}
                            </p>
                          ) : null}
                        </div>
                      ) : null}

                      {deployOutput ? (
                        <div className="mt-4">
                          <h5 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                            Deploy Output
                          </h5>
                          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-3 text-xs text-zinc-300">
                            {deployOutput}
                          </pre>
                        </div>
                      ) : null}
                    </div>

                    <CollapsibleSection
                      title="Deployment Settings"
                      description="Configure deploy defaults and connection bindings for this workflow."
                    >
                      <div className="grid gap-4 md:grid-cols-2">
                        <label className="text-xs text-zinc-400">
                          Deploy Target
                          <select
                            value={deployTarget}
                            onChange={(event) =>
                              updateArtifact((current) => ({
                                ...current,
                                deploy: {
                                  ...(current.deploy || {}),
                                  target: event.target.value as
                                    | "cloud"
                                    | "local",
                                  provider:
                                    event.target.value === "cloud" &&
                                    current.deploy?.provider !== "aws" &&
                                    current.deploy?.provider !== "gcp"
                                      ? effectiveCloudProvider
                                      : current.deploy?.provider,
                                  region:
                                    event.target.value === "cloud" &&
                                    (!current.deploy?.region ||
                                      current.deploy.region === "local")
                                      ? effectiveCloudRegion
                                      : current.deploy?.region,
                                  auth:
                                    event.target.value === "cloud"
                                      ? {
                                          ...(current.deploy?.auth || {}),
                                          mode: "secret_manager",
                                        }
                                      : current.deploy?.auth,
                                },
                              }))
                            }
                            className="mt-1 block w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs text-white outline-none focus:border-blue-600"
                          >
                            <option value="cloud">Cloud</option>
                            <option value="local">Local</option>
                          </select>
                        </label>

                        {deployTarget === "cloud" ? (
                          <>
                            <label className="text-xs text-zinc-400">
                              Cloud Provider
                              <select
                                value={effectiveCloudProvider}
                                onChange={(event) =>
                                  updateArtifact((current) => ({
                                    ...current,
                                    deploy: {
                                      ...(current.deploy || {}),
                                      target: "cloud",
                                      provider: event.target.value as "aws" | "gcp",
                                      region:
                                        current.deploy?.region &&
                                        current.deploy.region !== "local"
                                          ? current.deploy.region
                                          : defaultRegionForProvider(
                                              event.target.value as "aws" | "gcp",
                                              deploymentDefaults
                                            ),
                                      auth: {
                                        ...(current.deploy?.auth || {}),
                                        mode: "secret_manager",
                                      },
                                    },
                                  }))
                                }
                                className="mt-1 block w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs text-white outline-none focus:border-blue-600"
                              >
                                <option value="aws">AWS</option>
                                <option value="gcp">GCP</option>
                              </select>
                            </label>

                            <label className="text-xs text-zinc-400">
                              Region
                              <input
                                value={effectiveCloudRegion}
                                onChange={(event) =>
                                  updateArtifact((current) => ({
                                    ...current,
                                    deploy: {
                                      ...(current.deploy || {}),
                                      target: "cloud",
                                      region: event.target.value,
                                    },
                                  }))
                                }
                                placeholder={defaultRegionForProvider(
                                  effectiveCloudProvider,
                                  deploymentDefaults
                                )}
                                className="mt-1 block w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs text-white outline-none focus:border-blue-600"
                              />
                            </label>

                            {effectiveCloudProvider === "gcp" ? (
                              <label className="text-xs text-zinc-400">
                                GCP Project
                                <input
                                  value={effectiveCloudGcpProject}
                                  onChange={(event) =>
                                    updateArtifact((current) => ({
                                      ...current,
                                      deploy: {
                                        ...(current.deploy || {}),
                                        target: "cloud",
                                        gcpProject: event.target.value,
                                      },
                                    }))
                                  }
                                  placeholder="my-gcp-project"
                                  className="mt-1 block w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs text-white outline-none focus:border-blue-600"
                                />
                              </label>
                            ) : null}

                            <label className="text-xs text-zinc-400">
                              Execution Kind
                              <select
                                value={currentArtifact.deploy?.execution?.kind || ""}
                                onChange={(event) =>
                                  updateArtifact((current) => ({
                                    ...current,
                                    deploy: {
                                      ...(current.deploy || {}),
                                      target: "cloud",
                                      execution: {
                                        kind: event.target.value as "service" | "job",
                                      },
                                    },
                                  }))
                                }
                                className="mt-1 block w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs text-white outline-none focus:border-blue-600"
                              >
                                <option value="">auto from trigger</option>
                                <option value="service">service</option>
                                <option value="job">job</option>
                              </select>
                            </label>

                            <label className="text-xs text-zinc-400">
                              Auth Mode
                              <input
                                value="secret_manager"
                                readOnly
                                className="mt-1 block w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-2 text-xs text-zinc-300 outline-none"
                              />
                            </label>

                            <div className="md:col-span-2 rounded-md border border-blue-900/40 bg-blue-950/20 px-3 py-3 text-xs text-blue-100">
                              Previews and local runs keep using the local GTMShip
                              auth service. Cloud deployments switch to the matched
                              secret manager backend at runtime.
                            </div>

                            <label className="text-xs text-zinc-400">
                              Secret Backend
                              <select
                                value={
                                  currentArtifact.deploy?.auth?.backend?.kind || ""
                                }
                                onChange={(event) =>
                                  updateArtifact((current) => ({
                                    ...current,
                                    deploy: {
                                      ...(current.deploy || {}),
                                      auth: {
                                        ...(current.deploy?.auth || {}),
                                        mode: "secret_manager",
                                        backend: {
                                          ...(current.deploy?.auth?.backend || {}),
                                          kind: (event.target.value || undefined) as
                                            | "aws_secrets_manager"
                                            | "gcp_secret_manager"
                                            | undefined,
                                        },
                                      },
                                    },
                                  }))
                                }
                                className="mt-1 block w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs text-white outline-none focus:border-blue-600"
                              >
                                <option value="">select backend</option>
                                <option value="aws_secrets_manager">
                                  aws_secrets_manager
                                </option>
                                <option value="gcp_secret_manager">
                                  gcp_secret_manager
                                </option>
                              </select>
                            </label>

                            <label className="text-xs text-zinc-400">
                              Runtime Access
                              <select
                                value={
                                  currentArtifact.deploy?.auth?.runtimeAccess ||
                                  "direct"
                                }
                                onChange={(event) =>
                                  updateArtifact((current) => ({
                                    ...current,
                                    deploy: {
                                      ...(current.deploy || {}),
                                      auth: {
                                        ...(current.deploy?.auth || {}),
                                        mode: "secret_manager",
                                        runtimeAccess: (event.target.value ||
                                          "direct") as "direct" | "local_cache",
                                      },
                                    },
                                  }))
                                }
                                className="mt-1 block w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs text-white outline-none focus:border-blue-600"
                              >
                                <option value="direct">direct</option>
                                <option value="local_cache">local_cache</option>
                              </select>
                            </label>

                            <label className="text-xs text-zinc-400">
                              Secret Prefix
                              <input
                                value={
                                  currentArtifact.deploy?.auth?.backend
                                    ?.secretPrefix || ""
                                }
                                onChange={(event) =>
                                  updateArtifact((current) => ({
                                    ...current,
                                    deploy: {
                                      ...(current.deploy || {}),
                                      auth: {
                                        ...(current.deploy?.auth || {}),
                                        mode: "secret_manager",
                                        backend: {
                                          ...(current.deploy?.auth?.backend || {}),
                                          secretPrefix:
                                            event.target.value || undefined,
                                        },
                                      },
                                    },
                                  }))
                                }
                                placeholder="gtmship-connections"
                                className="mt-1 block w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs text-white outline-none focus:border-blue-600"
                              />
                            </label>

                            {currentArtifact.deploy?.auth?.backend?.kind ===
                            "aws_secrets_manager" ? (
                              <label className="text-xs text-zinc-400">
                                Secret Region
                                <input
                                  value={
                                    currentArtifact.deploy?.auth?.backend?.region ||
                                    ""
                                  }
                                  onChange={(event) =>
                                    updateArtifact((current) => ({
                                      ...current,
                                      deploy: {
                                        ...(current.deploy || {}),
                                        auth: {
                                          ...(current.deploy?.auth || {}),
                                          mode: "secret_manager",
                                          backend: {
                                            ...(current.deploy?.auth?.backend ||
                                              {}),
                                            region: event.target.value || undefined,
                                          },
                                        },
                                      },
                                    }))
                                  }
                                  placeholder="us-east-1"
                                  className="mt-1 block w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs text-white outline-none focus:border-blue-600"
                                />
                              </label>
                            ) : null}

                            {currentArtifact.deploy?.auth?.backend?.kind ===
                            "gcp_secret_manager" ? (
                              <label className="text-xs text-zinc-400">
                                Secret Project ID
                                <input
                                  value={
                                    currentArtifact.deploy?.auth?.backend
                                      ?.projectId || ""
                                  }
                                  onChange={(event) =>
                                    updateArtifact((current) => ({
                                      ...current,
                                      deploy: {
                                        ...(current.deploy || {}),
                                        auth: {
                                          ...(current.deploy?.auth || {}),
                                          mode: "secret_manager",
                                          backend: {
                                            ...(current.deploy?.auth?.backend ||
                                              {}),
                                            projectId:
                                              event.target.value || undefined,
                                          },
                                        },
                                      },
                                    }))
                                  }
                                  placeholder="my-gcp-project"
                                  className="mt-1 block w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs text-white outline-none focus:border-blue-600"
                                />
                              </label>
                            ) : null}
                          </>
                        ) : (
                          <>
                            <label className="text-xs text-zinc-400">
                              Region
                              <input
                                value={effectiveRegion}
                                readOnly
                                className="mt-1 block w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-2 text-xs text-zinc-300 outline-none"
                              />
                            </label>

                            <label className="text-xs text-zinc-400">
                              Runtime
                              <input
                                value="job"
                                readOnly
                                className="mt-1 block w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-2 text-xs text-zinc-300 outline-none"
                              />
                            </label>

                            <div className="md:col-span-2 rounded-md border border-zinc-800 bg-zinc-950/70 px-3 py-3 text-xs text-zinc-300">
                              Local deployments are supported only for manual and
                              schedule workflows. They always use the local GTMShip
                              auth service and local encrypted secrets. Your cloud
                              provider settings stay saved when you switch back to
                              Cloud.
                            </div>
                          </>
                        )}
                      </div>
                    </CollapsibleSection>

                    <CollapsibleSection
                      title="Trigger Overrides"
                      description="Optional metadata for webhook, schedule, and event triggers."
                    >
                      <div className="grid gap-4 md:grid-cols-2">
                        <label className="text-xs text-zinc-400">
                          Webhook Path
                          <input
                            value={currentArtifact.triggerConfig?.webhook?.path || ""}
                            onChange={(event) =>
                              updateArtifact((current) => ({
                                ...current,
                                triggerConfig: {
                                  ...(current.triggerConfig || {}),
                                  webhook: {
                                    ...(current.triggerConfig?.webhook || {}),
                                    path: event.target.value,
                                  },
                                },
                              }))
                            }
                            placeholder="/inbound"
                            className="mt-1 block w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs text-white outline-none focus:border-blue-600"
                          />
                        </label>

                        <label className="text-xs text-zinc-400">
                          Webhook Visibility
                          <select
                            value={
                              currentArtifact.triggerConfig?.webhook?.visibility ||
                              "public"
                            }
                            onChange={(event) =>
                              updateArtifact((current) => ({
                                ...current,
                                triggerConfig: {
                                  ...(current.triggerConfig || {}),
                                  webhook: {
                                    ...(current.triggerConfig?.webhook || {}),
                                    visibility: event.target.value as
                                      | "public"
                                      | "private",
                                  },
                                },
                              }))
                            }
                            className="mt-1 block w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs text-white outline-none focus:border-blue-600"
                          >
                            <option value="public">public</option>
                            <option value="private">private</option>
                          </select>
                        </label>

                        <label className="text-xs text-zinc-400">
                          Schedule Cron Override
                          <input
                            value={currentArtifact.triggerConfig?.schedule?.cron || ""}
                            onChange={(event) =>
                              updateArtifact((current) => ({
                                ...current,
                                triggerConfig: {
                                  ...(current.triggerConfig || {}),
                                  schedule: {
                                    ...(current.triggerConfig?.schedule || {}),
                                    cron: event.target.value,
                                  },
                                },
                              }))
                            }
                            placeholder="0 * * * *"
                            className="mt-1 block w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs text-white outline-none focus:border-blue-600"
                          />
                        </label>

                        <label className="text-xs text-zinc-400">
                          Schedule Timezone
                          <input
                            value={
                              currentArtifact.triggerConfig?.schedule?.timezone || ""
                            }
                            onChange={(event) =>
                              updateArtifact((current) => ({
                                ...current,
                                triggerConfig: {
                                  ...(current.triggerConfig || {}),
                                  schedule: {
                                    ...(current.triggerConfig?.schedule || {}),
                                    timezone: event.target.value,
                                  },
                                },
                              }))
                            }
                            placeholder="UTC"
                            className="mt-1 block w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs text-white outline-none focus:border-blue-600"
                          />
                        </label>

                        <label className="text-xs text-zinc-400">
                          Event Source
                          <input
                            value={currentArtifact.triggerConfig?.event?.source || ""}
                            onChange={(event) =>
                              updateArtifact((current) => ({
                                ...current,
                                triggerConfig: {
                                  ...(current.triggerConfig || {}),
                                  event: {
                                    ...(current.triggerConfig?.event || {}),
                                    source: event.target.value,
                                  },
                                },
                              }))
                            }
                            placeholder="eventbridge://default"
                            className="mt-1 block w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs text-white outline-none focus:border-blue-600"
                          />
                        </label>
                      </div>
                    </CollapsibleSection>

                    <CollapsibleSection
                      title="Connection Bindings"
                      description="Select how each provider should resolve a connection at runtime."
                    >
                      {bindingProviderSlugs.length === 0 ? (
                        <p className="text-xs text-zinc-600">
                          No integration accesses detected yet.
                        </p>
                      ) : (
                        <div className="space-y-3">
                          {bindingProviderSlugs.map((providerSlug) => {
                            const binding = (currentArtifact.bindings || []).find(
                              (entry) => entry.providerSlug === providerSlug
                            );
                            const selectorType =
                              binding?.selector.type || "latest_active";
                            const selectorValue =
                              binding?.selector.connectionId ||
                              binding?.selector.label ||
                              "";

                            return (
                              <div
                                key={providerSlug}
                                className="rounded-lg border border-zinc-800 px-3 py-3"
                              >
                                <p className="text-xs font-medium text-white">
                                  {providerSlug}
                                </p>
                                <div className="mt-2 grid gap-2 md:grid-cols-2">
                                  <select
                                    value={selectorType}
                                    onChange={(event) =>
                                      updateBindingSelectorType(
                                        providerSlug,
                                        event.target.value as WorkflowBindingSelectorType
                                      )
                                    }
                                    className="rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs text-white outline-none focus:border-blue-600"
                                  >
                                    <option value="latest_active">
                                      latest_active
                                    </option>
                                    <option value="connection_id">
                                      connection_id
                                    </option>
                                    <option value="label">label</option>
                                  </select>
                                  <input
                                    value={selectorValue}
                                    onChange={(event) =>
                                      updateBindingSelectorValue(
                                        providerSlug,
                                        event.target.value
                                      )
                                    }
                                    disabled={selectorType === "latest_active"}
                                    placeholder={
                                      selectorType === "label"
                                        ? "production"
                                        : "conn_123"
                                    }
                                    className="rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs text-white outline-none focus:border-blue-600 disabled:opacity-50"
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </CollapsibleSection>

                    <CollapsibleSection
                      title="AI Models"
                      description="Select the live model for each workflow-scoped AI provider."
                    >
                      {workflowAiProviderSlugs.length === 0 ? (
                        <p className="text-xs text-zinc-600">
                          No workflow AI providers detected yet.
                        </p>
                      ) : (
                        <div className="space-y-3">
                          {workflowAiConnectionsError ? (
                            <p className="text-xs text-rose-300">
                              {workflowAiConnectionsError}
                            </p>
                          ) : null}

                          {workflowAiProviderSlugs.map((providerSlug) => {
                            const resolution =
                              workflowAiBindingResolutionByProvider.get(
                                providerSlug
                              );
                            const selectedModel =
                              workflowAiConfigByProvider.get(providerSlug)?.model ||
                              "";
                            const options = withSelectedModelOption(
                              workflowAiModelOptions[providerSlug] || [],
                              providerSlug,
                              selectedModel
                            );
                            const loadingModels =
                              workflowAiModelLoading[providerSlug] === true;
                            const disabledReason =
                              workflowAiConnectionsLoading
                                ? "Loading connections before model lookup."
                                : buildWorkflowAiModelDisabledReason(
                                    providerSlug,
                                    resolution
                                  );
                            const modelLookupError =
                              formatWorkflowAiModelError(
                                providerSlug,
                                workflowAiModelErrors[providerSlug]
                              );
                            const isDisabled =
                              workflowAiConnectionsLoading ||
                              loadingModels ||
                              !resolution ||
                              resolution.status !== "resolved";

                            return (
                              <div
                                key={providerSlug}
                                className="rounded-lg border border-zinc-800 px-3 py-3"
                              >
                                <div className="flex items-center justify-between gap-3">
                                  <div>
                                    <p className="text-xs font-medium text-white">
                                      {WORKFLOW_AI_PROVIDER_LABELS[providerSlug]}
                                    </p>
                                    <p
                                      className={cn(
                                        "mt-1 text-[11px]",
                                        resolution?.status === "resolved"
                                          ? "text-zinc-500"
                                          : "text-amber-300"
                                      )}
                                    >
                                      {resolution
                                        ? describeWorkflowAiResolution(resolution)
                                        : disabledReason}
                                    </p>
                                  </div>
                                  {loadingModels ? (
                                    <span className="inline-flex items-center gap-1 text-[11px] text-zinc-500">
                                      <Loader2 size={12} className="animate-spin" />
                                      Loading
                                    </span>
                                  ) : null}
                                </div>

                                <select
                                  value={selectedModel}
                                  onChange={(event) =>
                                    updateWorkflowAiModel(
                                      providerSlug,
                                      event.target.value
                                    )
                                  }
                                  disabled={isDisabled}
                                  className="mt-3 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs text-white outline-none focus:border-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  <option value="">
                                    {buildWorkflowAiModelPlaceholder(resolution)}
                                  </option>
                                  {options.map((option) => (
                                    <option key={option.id} value={option.id}>
                                      {option.displayName}
                                    </option>
                                  ))}
                                </select>

                                {disabledReason && isDisabled ? (
                                  <p className="mt-2 text-[11px] text-zinc-500">
                                    {disabledReason}
                                  </p>
                                ) : null}

                                {modelLookupError ? (
                                  <p className="mt-2 text-[11px] text-rose-300">
                                    {modelLookupError}
                                  </p>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </CollapsibleSection>

                    <CollapsibleSection
                      title="Computed Deployment Plan"
                      description={`Trigger ${displayDeploymentPlan.trigger.type} will run as ${displayDeploymentPlan.executionKind} on ${displayDeploymentPlan.provider.toUpperCase()}.`}
                    >
                      <div className="grid gap-2 text-xs text-zinc-400 md:grid-cols-2">
                        <p>
                          <span className="text-zinc-500">Summary:</span>{" "}
                          {summarizeDeploymentTrigger(displayDeploymentPlan)}
                        </p>
                        <p>
                          <span className="text-zinc-500">Auth mode:</span>{" "}
                          {displayDeploymentPlan.authMode}
                        </p>
                      </div>

                      <div className="mt-3 flex flex-wrap gap-2">
                        {displayDeploymentPlan.resources.map((resource) => (
                          <span
                            key={`${displayDeploymentPlan.workflowId}-${resource.name}`}
                            className="rounded-full border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-300"
                          >
                            {resource.kind}
                          </span>
                        ))}
                      </div>

                      {deploymentSecretSyncSummary ? (
                        <DeploymentSecretSyncCard
                          summary={deploymentSecretSyncSummary}
                          title="Secret Sync"
                          description="These connection secret references are included when deploying to the configured target."
                          className="mt-3"
                        />
                      ) : resolvedDeploymentPlanLoading ? (
                        <p className="mt-3 text-xs text-zinc-500">
                          Resolving the configured deployment plan...
                        </p>
                      ) : resolvedDeploymentPlanError ? (
                        <div className="mt-3 rounded-md border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-100">
                          Failed to resolve the configured deployment plan.
                          Showing the local computed plan while secret sync
                          details are unavailable.
                        </div>
                      ) : null}

                      {displayDeploymentPlan.warnings.length > 0 ? (
                        <div className="mt-3 rounded-md border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-100">
                          {displayDeploymentPlan.warnings.map((warning, index) => (
                            <p
                              key={`${displayDeploymentPlan.workflowId}-warning-${index}`}
                            >
                              {warning}
                            </p>
                          ))}
                        </div>
                      ) : null}
                    </CollapsibleSection>
                  </div>
                ) : null}

                {activeTab === "code" ? (
                  <div className="flex h-full flex-col gap-5">
                    <div className="flex flex-[3] flex-col">
                      <label className="mb-2 flex items-center gap-2 text-xs font-medium text-zinc-400">
                        <Code2 size={12} />
                        Workflow Code
                      </label>
                      <textarea
                        value={currentArtifact.code}
                        onChange={(event) =>
                          updateArtifact((current) => ({
                            ...current,
                            code: event.target.value,
                          }))
                        }
                        className="w-full flex-1 resize-none rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3 font-mono text-xs leading-relaxed text-zinc-200 outline-none focus:border-blue-600"
                      />
                    </div>
                    <div className="flex flex-1 flex-col">
                      <label className="mb-2 flex items-center gap-2 text-xs font-medium text-zinc-400">
                        <FileJson size={12} />
                        Sample Payload JSON
                      </label>
                      <textarea
                        value={currentArtifact.samplePayload}
                        onChange={(event) =>
                          updateArtifact((current) => ({
                            ...current,
                            samplePayload: event.target.value,
                          }))
                        }
                        className="w-full flex-1 resize-none rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3 font-mono text-xs leading-relaxed text-zinc-200 outline-none focus:border-blue-600"
                      />
                    </div>
                  </div>
                ) : null}

                {activeTab === "validation" ? (
                  <div className="space-y-5">
                    <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-5">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <h4 className="text-sm font-medium text-white">
                            Validation Report
                          </h4>
                          <p className="mt-1 text-xs text-zinc-500">
                            Compile checks, export checks, helper usage, and
                            write checkpoint coverage.
                          </p>
                        </div>
                        <button
                          onClick={() => void runValidation()}
                          disabled={
                            validating ||
                            building ||
                            deletingWorkflow ||
                            agentBusy
                          }
                          className="flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300 transition-colors hover:bg-zinc-900 disabled:opacity-50"
                        >
                          {validating ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <RefreshCw size={12} />
                          )}
                          Re-run
                        </button>
                      </div>

                      {currentArtifact.validation ? (
                        <>
                          <div className="mt-4 flex items-center gap-2">
                            {currentArtifact.validation.ok ? (
                              <CheckCircle2
                                size={16}
                                className="text-emerald-300"
                              />
                            ) : (
                              <AlertCircle
                                size={16}
                                className="text-amber-200"
                              />
                            )}
                            <p className="text-sm text-white">
                              {currentArtifact.validation.ok
                                ? "Validation passed"
                                : "Validation found issues"}
                            </p>
                          </div>
                          <div className="mt-4 space-y-2">
                            {currentArtifact.validation.issues.length === 0 ? (
                              <p className="text-xs text-zinc-500">
                                No issues found.
                              </p>
                            ) : (
                              currentArtifact.validation.issues.map(
                                (issue, index) => (
                                  <div
                                    key={`${issue.message}-${index}`}
                                    className={cn(
                                      "rounded-lg border px-3 py-2 text-xs",
                                      issue.level === "error"
                                        ? "border-amber-900/40 bg-amber-950/20 text-amber-100"
                                        : "border-zinc-800 bg-zinc-950 text-zinc-300"
                                    )}
                                  >
                                    <div className="flex items-start justify-between gap-3">
                                      <p className="min-w-0 flex-1">
                                        {issue.message}
                                      </p>
                                      <button
                                        onClick={() =>
                                          void sendIssueToChat(
                                            createValidationFixPrompt(
                                              currentArtifact,
                                              issue
                                            )
                                          )
                                        }
                                        disabled={fixWithAiDisabled}
                                        className="shrink-0 rounded-md bg-blue-600 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
                                      >
                                        Fix With AI
                                      </button>
                                    </div>
                                  </div>
                                )
                              )
                            )}
                          </div>
                        </>
                      ) : (
                        <p className="mt-4 text-xs text-zinc-500">
                          Run validation to inspect the generated code.
                        </p>
                      )}
                    </div>
                  </div>
                ) : null}

                {activeTab === "preview" ? (
                  <div className="space-y-5">
                    <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-5">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <h4 className="text-sm font-medium text-white">
                            Preview Execution
                          </h4>
                          <p className="mt-1 text-xs text-zinc-500">
                            Runs the workflow with the sample payload and pauses
                            before external writes.
                          </p>
                        </div>
                        <button
                          onClick={() => void runPreview()}
                          disabled={
                            previewing ||
                            building ||
                            deletingWorkflow ||
                            agentBusy
                          }
                          className="flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300 transition-colors hover:bg-zinc-900 disabled:opacity-50"
                        >
                          {previewing ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <Play size={12} />
                          )}
                          Run
                        </button>
                      </div>

                      {currentArtifact.preview ? (
                        <>
                          <div className="mt-4 flex items-center gap-2">
                            {currentArtifact.preview.status === "success" ? (
                              <CheckCircle2
                                size={16}
                                className="text-emerald-300"
                              />
                            ) : currentArtifact.preview.status ===
                              "needs_approval" ? (
                              <AlertCircle
                                size={16}
                                className="text-amber-200"
                              />
                            ) : (
                              <AlertCircle
                                size={16}
                                className="text-rose-300"
                              />
                            )}
                            <p className="text-sm text-white">
                              {currentArtifact.preview.status === "success"
                                ? "Preview completed"
                                : currentArtifact.preview.status ===
                                    "needs_approval"
                                  ? "Approval required"
                              : "Preview failed"}
                            </p>
                          </div>

                          {hasConnectionBlockers ? (
                            <div className="mt-4">
                              <ConnectionBlockerCallout
                                blockers={connectionBlockers}
                                connectionsChanged={connectionsChangedSinceBlocker}
                                onUseConnectionsAgent={openConnectionsAgent}
                                onRecheckConnections={() => {
                                  void recheckConnections();
                                }}
                                recheckDisabled={recheckConnectionsDisabled}
                                rechecking={agentBusy}
                              />
                            </div>
                          ) : null}

                          {previewPendingApproval ? (
                            <CheckpointApprovalCallout
                              title="Preview is waiting for write approval"
                              pendingApproval={previewPendingApproval}
                              progress={previewCheckpointProgress}
                              running={previewing}
                              disabled={previewing || building}
                              primaryLabel="Approve Next And Continue"
                              runningLabel="Running..."
                              onApproveNext={() => {
                                void runPreview([previewPendingApproval.checkpoint]);
                              }}
                              onApproveAllRemaining={() => {
                                void runPreview(previewRemainingCheckpointIds);
                              }}
                            />
                          ) : null}

                          {currentArtifact.preview.warnings?.length ? (
                            <div className="mt-4 rounded-lg border border-amber-900/40 bg-amber-950/20 px-3 py-3 text-xs text-amber-100">
                              <div className="flex items-center gap-2 font-medium mb-1">
                                <AlertCircle size={14} className="text-amber-300 shrink-0" />
                                Some API calls failed
                              </div>
                              <ul className="mt-1 space-y-0.5 text-amber-200/80">
                                {currentArtifact.preview.warnings.map((w, i) => (
                                  <li key={i}>{w}</li>
                                ))}
                              </ul>
                            </div>
                          ) : null}

                          {currentArtifact.preview.error ? (
                            <div className="mt-4 rounded-lg border border-rose-900/40 bg-rose-950/20 px-3 py-3 text-xs text-rose-100">
                              {currentArtifact.preview.error}
                            </div>
                          ) : null}

                          {currentArtifact.preview.result !== undefined ? (
                            <pre className="mt-4 overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-3 text-xs text-zinc-200">
                              {JSON.stringify(
                                currentArtifact.preview.result,
                                null,
                                2
                              )}
                            </pre>
                          ) : null}

                          <div className="mt-5">
                            <div className="flex items-center justify-between gap-3">
                              <h5 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                                Execution Logs
                              </h5>
                              <button
                                onClick={() =>
                                  void sendIssueToChat(
                                    createPreviewFixPrompt(
                                      currentArtifact,
                                      currentArtifact.preview!
                                    )
                                  )
                                }
                                disabled={fixWithAiDisabled}
                                className="shrink-0 rounded-md bg-blue-600 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
                              >
                                Send To AI
                              </button>
                            </div>
                            <div className="mt-2 max-h-80 overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950">
                              {currentArtifact.preview.logs?.length ? (
                                <div className="divide-y divide-zinc-900">
                                  {currentArtifact.preview.logs.map((entry) => (
                                    <div
                                      key={entry.id}
                                      className="px-3 py-3 text-xs"
                                    >
                                      <div className="flex flex-wrap items-center gap-2">
                                        <span
                                          className={cn(
                                            "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                                            getPreviewLogLevelClassName(
                                              entry.level
                                            )
                                          )}
                                        >
                                          {entry.level}
                                        </span>
                                        <span className="text-[11px] text-zinc-500">
                                          {formatDateTime(entry.timestamp)}
                                        </span>
                                      </div>
                                      <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-zinc-200">
                                        {entry.message}
                                      </pre>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <p className="px-3 py-3 text-xs text-zinc-600">
                                  No console output captured yet.
                                </p>
                              )}
                            </div>
                          </div>

                          <div className="mt-5">
                            <h5 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                              Operations
                            </h5>
                            <div className="mt-2 space-y-2">
                              {currentArtifact.preview.operations.length === 0 ? (
                                <p className="text-xs text-zinc-600">
                                  No operations captured yet.
                                </p>
                              ) : (
                                currentArtifact.preview.operations.map(
                                  (operation) => (
                                    <div
                                      key={operation.id}
                                      className={`rounded-lg border px-3 py-2 text-xs ${
                                        operation.responseStatus && (operation.responseStatus < 200 || operation.responseStatus >= 400)
                                          ? "border-rose-900/40 bg-rose-950/10"
                                          : "border-zinc-800"
                                      }`}
                                    >
                                      <div className="flex items-center justify-between gap-3">
                                        <p className="font-medium text-white">
                                          {operation.method} {operation.target}
                                        </p>
                                        <div className="flex items-center gap-1.5">
                                          {operation.responseStatus ? (
                                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                                              operation.responseStatus >= 200 && operation.responseStatus < 400
                                                ? "bg-emerald-900/40 text-emerald-400"
                                                : "bg-rose-900/40 text-rose-400"
                                            }`}>
                                              {operation.responseStatus}
                                            </span>
                                          ) : null}
                                          <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-300">
                                            {operation.mode}
                                          </span>
                                        </div>
                                      </div>
                                      <p className="mt-1 text-zinc-500">
                                        {operation.url}
                                      </p>
                                      {operation.checkpoint ? (
                                        <p className="mt-1 text-zinc-600">
                                          checkpoint: {operation.checkpoint}
                                        </p>
                                      ) : null}
                                    </div>
                                  )
                                )
                              )}
                            </div>
                          </div>
                        </>
                      ) : (
                        <p className="mt-4 text-xs text-zinc-500">
                          Run preview to test the current code.
                        </p>
                      )}
                    </div>
                  </div>
                ) : null}

                {activeTab === "build" ? (
                  <div className="space-y-5">
                    <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-5">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <h4 className="text-sm font-medium text-white">
                            Build Artifact
                          </h4>
                          <p className="mt-1 text-xs text-zinc-500">
                            Runs validation and preview, then auto-saves the
                            workflow and uses the same CLI build flow as Deploy
                            without publishing.
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          {currentArtifact.build?.status === "error" ? (
                            <button
                              onClick={() => {
                                const build = currentArtifact.build;
                                if (!build) {
                                  return;
                                }

                                const buildResult: WorkflowBuildResult = build;

                                void sendIssueToChat(
                                  createBuildFixPrompt(currentArtifact, buildResult)
                                );
                              }}
                              disabled={
                                fixWithAiDisabled
                              }
                              className="flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
                            >
                              {agentBusy ? (
                                <Loader2 size={12} className="animate-spin" />
                              ) : (
                                <Sparkles size={12} />
                              )}
                              Fix With AI
                            </button>
                          ) : null}
                          <button
                            onClick={() => void runBuild()}
                            disabled={
                              building ||
                              previewing ||
                              validating ||
                              deploying ||
                              deletingWorkflow ||
                              agentBusy
                            }
                            className="flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300 transition-colors hover:bg-zinc-900 disabled:opacity-50"
                          >
                            {building ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <Package size={12} />
                            )}
                            Run
                          </button>
                        </div>
                      </div>

                      {currentArtifact.build ? (
                        <>
                          <div className="mt-4 flex items-center gap-2">
                            {currentArtifact.build.status === "success" ? (
                              <CheckCircle2
                                size={16}
                                className="text-emerald-300"
                              />
                            ) : (
                              <AlertCircle
                                size={16}
                                className="text-rose-300"
                              />
                            )}
                            <p className="text-sm text-white">
                              {currentArtifact.build.status === "success"
                                ? "Build completed"
                                : "Build failed"}
                            </p>
                          </div>

                          {hasConnectionBlockers ? (
                            <div className="mt-4">
                              <ConnectionBlockerCallout
                                blockers={connectionBlockers}
                                connectionsChanged={connectionsChangedSinceBlocker}
                                onUseConnectionsAgent={openConnectionsAgent}
                                onRecheckConnections={() => {
                                  void recheckConnections();
                                }}
                                recheckDisabled={recheckConnectionsDisabled}
                                rechecking={agentBusy}
                              />
                            </div>
                          ) : null}

                          <div className="mt-4 grid gap-2 text-xs text-zinc-400 md:grid-cols-2">
                            <p>
                              <span className="text-zinc-500">Provider:</span>{" "}
                              {currentArtifact.build.provider.toUpperCase()}
                            </p>
                            <p>
                              <span className="text-zinc-500">Region:</span>{" "}
                              {currentArtifact.build.region || "default"}
                            </p>
                            <p>
                              <span className="text-zinc-500">Built:</span>{" "}
                              {formatDate(currentArtifact.build.builtAt)}
                            </p>
                            <p>
                              <span className="text-zinc-500">Workflow:</span>{" "}
                              {currentArtifact.build.artifact?.workflowId ||
                                currentArtifact.slug}
                            </p>
                          </div>

                          {currentArtifact.build.artifact ? (
                            <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-3 text-xs text-zinc-300">
                              <p>
                                <span className="text-zinc-500">Artifact:</span>{" "}
                                {currentArtifact.build.artifact.artifactPath}
                              </p>
                              <p className="mt-1">
                                <span className="text-zinc-500">Bundle size:</span>{" "}
                                {formatBytes(
                                  currentArtifact.build.artifact.bundleSizeBytes
                                )}
                              </p>
                              {currentArtifact.build.artifact.imageUri ? (
                                <p className="mt-1">
                                  <span className="text-zinc-500">Image:</span>{" "}
                                  {currentArtifact.build.artifact.imageUri}
                                </p>
                              ) : null}
                            </div>
                          ) : null}

                          {currentArtifact.build.error ? (
                            <div className="mt-4 rounded-lg border border-rose-900/40 bg-rose-950/20 px-3 py-3 text-xs text-rose-100">
                              {currentArtifact.build.error}
                            </div>
                          ) : null}

                          {buildPendingApproval ? (
                            <CheckpointApprovalCallout
                              title="Build preview is waiting for write approval"
                              pendingApproval={buildPendingApproval}
                              progress={buildCheckpointApprovalProgress}
                              running={building}
                              disabled={building || deletingWorkflow}
                              primaryLabel="Approve Next And Build Again"
                              runningLabel="Running..."
                              onApproveNext={() => {
                                void runBuild([buildPendingApproval.checkpoint]);
                              }}
                              onApproveAllRemaining={() => {
                                void runBuild(buildRemainingCheckpointIds);
                              }}
                            />
                          ) : null}

                          <div className="mt-5">
                            <h5 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                              Build Steps
                            </h5>
                            <div className="mt-2 space-y-2">
                              {currentArtifact.build.steps.map((step, index) => (
                                <div
                                  key={`${step.stage}-${index}`}
                                  className={cn(
                                    "rounded-lg border px-3 py-3 text-xs",
                                    step.status === "error"
                                      ? "border-rose-900/40 bg-rose-950/10"
                                      : "border-zinc-800 bg-zinc-950/40"
                                  )}
                                >
                                  <div className="flex items-center gap-2">
                                    {step.status === "error" ? (
                                      <AlertCircle
                                        size={14}
                                        className="text-rose-300 shrink-0"
                                      />
                                    ) : (
                                      <CheckCircle2
                                        size={14}
                                        className="text-emerald-300 shrink-0"
                                      />
                                    )}
                                    <p className="font-medium text-white">
                                      {step.label}
                                    </p>
                                    {step.durationMs !== undefined ? (
                                      <span className="text-zinc-500">
                                        {Math.max(
                                          0.1,
                                          step.durationMs / 1000
                                        ).toFixed(1)}
                                        s
                                      </span>
                                    ) : null}
                                  </div>
                                  <p className="mt-1 text-zinc-400">
                                    {step.summary}
                                  </p>
                                  {step.command ? (
                                    <p className="mt-2 rounded bg-zinc-900 px-2 py-1 font-mono text-[11px] text-zinc-300">
                                      {step.command}
                                    </p>
                                  ) : null}
                                  {step.output ? (
                                    <pre className="mt-2 overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-[11px] leading-relaxed text-zinc-300">
                                      {step.output}
                                    </pre>
                                  ) : null}
                                </div>
                              ))}
                            </div>
                          </div>
                        </>
                      ) : (
                        <p className="mt-4 text-xs text-zinc-500">
                          Run build to validate, preview, save, and package the
                          workflow with the shared deploy pipeline.
                        </p>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </>
      )}

      {error ? (
        <div
          className={cn(
            "z-50 flex items-center gap-2 rounded-lg border border-rose-900/40 bg-rose-950/90 px-4 py-3 text-sm text-rose-100 shadow-lg backdrop-blur-sm",
            showEditor
              ? "absolute bottom-6 left-1/2 -translate-x-1/2"
              : "fixed bottom-6 left-1/2 -translate-x-1/2"
          )}
        >
          <AlertCircle size={14} className="shrink-0 text-rose-400" />
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            className="ml-2 shrink-0 text-rose-400 hover:text-rose-200"
          >
            &times;
          </button>
        </div>
      ) : null}
    </div>
  );
}
