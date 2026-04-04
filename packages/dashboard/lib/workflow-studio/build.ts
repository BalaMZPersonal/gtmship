import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import { generateWorkflowArtifact } from "./ai";
import { buildWorkflowPlanFromArtifact } from "./deploy-plan";
import { previewWorkflowArtifact } from "./preview";
import { resolveProjectRoot } from "./project-root";
import { saveStoredWorkflow } from "./storage";
import type {
  WorkflowAccessRequirement,
  WorkflowBuildArtifactRef,
  WorkflowBuildResult,
  WorkflowBuildStep,
  WorkflowDeployProvider,
  WorkflowProjectDeploymentDefaults,
  WorkflowPreviewResult,
  WorkflowStudioArtifact,
  WorkflowStudioMessage,
  WorkflowValidationReport,
} from "./types";
import { validateWorkflowArtifact } from "./validate";

const execFileAsync = promisify(execFile);
const MAX_COMMAND_OUTPUT = 24_000;

function trimOutput(value: string | undefined, maxChars = MAX_COMMAND_OUTPUT): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.length <= maxChars
    ? value
    : `${value.slice(0, maxChars)}\n\n... (output truncated)`;
}

function formatValidationSummary(validation: WorkflowValidationReport): string {
  if (validation.ok) {
    return "Validation passed.";
  }

  return validation.issues.map((issue) => issue.message).join("\n");
}

function formatPreviewSummary(preview: WorkflowPreviewResult): string {
  if (preview.status === "success") {
    return preview.warnings?.length
      ? preview.warnings.join("\n")
      : `Preview completed with ${preview.operations.length} recorded operation(s).`;
  }

  if (preview.status === "needs_approval") {
    return preview.pendingApproval
      ? `Preview paused for approval at checkpoint "${preview.pendingApproval.checkpoint}". Additional declared write checkpoints may require approval in later preview reruns.`
      : "Preview paused pending approval.";
  }

  return preview.error || "Preview failed.";
}

function formatBuildError(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    ("stdout" in error || "stderr" in error)
  ) {
    const executionError = error as {
      message?: string;
      stdout?: string;
      stderr?: string;
    };
    const parts = [
      executionError.message,
      executionError.stdout,
      executionError.stderr,
    ].filter((value): value is string => Boolean(value && value.trim()));

    if (parts.length > 0) {
      return parts.join("\n");
    }
  }

  if (
    error &&
    typeof error === "object" &&
    "errors" in error &&
    Array.isArray((error as { errors?: unknown[] }).errors)
  ) {
    const errors = (error as {
      errors: Array<{ text?: string; location?: { file?: string; line?: number; column?: number } }>;
    }).errors;

    const serialized = errors.map((entry) => {
      const location = entry.location
        ? [entry.location.file, entry.location.line, entry.location.column]
            .filter((value) => value !== undefined && value !== "")
            .join(":")
        : "";

      return location ? `${location} ${entry.text || "Build error"}` : entry.text || "Build error";
    });

    if (serialized.length > 0) {
      return serialized.join("\n");
    }
  }

  if (error instanceof Error) {
    return error.stack || error.message;
  }

  return String(error);
}

function createStep(input: {
  stage: WorkflowBuildStep["stage"];
  label: string;
  status: WorkflowBuildStep["status"];
  summary: string;
  durationMs?: number;
  command?: string;
  output?: string;
}): WorkflowBuildStep {
  return {
    stage: input.stage,
    label: input.label,
    status: input.status,
    summary: input.summary,
    durationMs: input.durationMs,
    command: input.command,
    output: trimOutput(input.output),
  };
}

async function runExecFile(
  command: string,
  args: string[],
  cwd?: string
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd,
    maxBuffer: 1024 * 1024 * 8,
    encoding: "utf8",
  });

  return {
    stdout: stdout || "",
    stderr: stderr || "",
  };
}

function findMonorepoRoot(start: string): string {
  let dir = start;
  for (let index = 0; index < 10; index += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }

    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return start;
}

function resolveCliEntry(): string {
  const monorepoRoot = findMonorepoRoot(process.cwd());
  const cliEntry = resolvePath(monorepoRoot, "packages/cli/dist/index.js");
  if (!existsSync(cliEntry)) {
    throw new Error(
      "Cannot find the GTMShip CLI build entrypoint. Build the CLI package first."
    );
  }

  return cliEntry;
}

function buildCliCommand(args: string[]): string {
  return ["node", ...args].join(" ");
}

function inferCliFailureStage(
  message: string,
  provider: WorkflowDeployProvider
): "bundle" | "package" {
  if (provider === "gcp" && /(docker|cloud run|image|artifact registry)/i.test(message)) {
    return "package";
  }

  if (provider === "aws" && /(zip|archive|archiver|lambda)/i.test(message)) {
    return "package";
  }

  return "bundle";
}

async function readBuiltArtifact(
  projectRoot: string,
  workflowId: string
): Promise<WorkflowBuildArtifactRef> {
  const manifestPath = join(projectRoot, ".gtmship", "build", "manifest.json");
  const manifestRaw = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestRaw) as {
    artifacts?: Array<{
      workflowId?: string;
      provider?: WorkflowDeployProvider;
      artifactPath?: string;
      imageUri?: string;
      bundleSizeBytes?: number;
    }>;
  };

  const artifact =
    manifest.artifacts?.find((entry) => entry.workflowId === workflowId) ||
    manifest.artifacts?.[0];

  if (!artifact?.workflowId || !artifact.provider || !artifact.artifactPath) {
    throw new Error(
      "Shared CLI build completed, but no build artifact was written to the manifest."
    );
  }

  return {
    workflowId: artifact.workflowId,
    provider: artifact.provider,
    artifactPath: artifact.artifactPath,
    imageUri: artifact.imageUri,
    bundleSizeBytes: artifact.bundleSizeBytes || 0,
  };
}

async function runSharedCliBuild(input: {
  projectRoot: string;
  workflowId: string;
  provider: WorkflowDeployProvider;
  region?: string;
  gcpProject?: string;
}): Promise<{
  artifact: WorkflowBuildArtifactRef;
  command: string;
  output?: string;
}> {
  const cliEntry = resolveCliEntry();
  const args = [cliEntry, "build", "--provider", input.provider, "--workflow", input.workflowId];

  if (input.region) {
    args.push("--region", input.region);
  }

  if (input.provider === "gcp" && input.gcpProject) {
    args.push("--project", input.gcpProject);
  }

  const command = buildCliCommand(args);
  try {
    const { stdout, stderr } = await runExecFile(
      process.execPath,
      args,
      input.projectRoot
    );
    const artifact = await readBuiltArtifact(input.projectRoot, input.workflowId);

    return {
      artifact,
      command,
      output: trimOutput([stdout, stderr].filter(Boolean).join("\n").trim()),
    };
  } catch (error) {
    if (error && typeof error === "object") {
      (
        error as {
          cliCommand?: string;
        }
      ).cliCommand = command;
    }
    throw error;
  }
}

function createFailureResult(input: {
  provider: WorkflowDeployProvider;
  region?: string;
  gcpProject?: string;
  steps: WorkflowBuildStep[];
  error: string;
  validation?: WorkflowValidationReport;
  preview?: WorkflowPreviewResult;
}): WorkflowBuildResult {
  return {
    status: "error",
    provider: input.provider,
    region: input.region,
    gcpProject: input.gcpProject,
    builtAt: new Date().toISOString(),
    steps: input.steps,
    error: input.error,
    validation: input.validation,
    preview: input.preview,
  };
}

function createBuildRepairMessage(
  artifact: WorkflowStudioArtifact,
  build: WorkflowBuildResult
): WorkflowStudioMessage {
  const stepDetails = build.steps.map((step) => ({
    stage: step.stage,
    status: step.status,
    summary: step.summary,
    command: step.command,
    output: step.output,
  }));

  return {
    id: `workflow_build_repair_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    role: "system",
    createdAt: new Date().toISOString(),
    content: [
      `Repair the current workflow draft "${artifact.slug}" so the full build passes.`,
      "Use the existing workflow shape and fix only the concrete issues surfaced below.",
      "",
      "Build failure:",
      build.error || "Unknown build failure.",
      "",
      "Validation issues:",
      JSON.stringify(build.validation?.issues || [], null, 2),
      "",
      "Preview result:",
      JSON.stringify(
        build.preview
          ? {
              status: build.preview.status,
              error: build.preview.error,
              warnings: build.preview.warnings,
              pendingApproval: build.preview.pendingApproval,
            }
          : null,
        null,
        2
      ),
      "",
      "Build steps:",
      JSON.stringify(stepDetails, null, 2),
    ].join("\n"),
  };
}

export async function buildWorkflowArtifact(input: {
  artifact: WorkflowStudioArtifact;
  approvedCheckpoints?: string[];
  defaults?: WorkflowProjectDeploymentDefaults;
}): Promise<WorkflowBuildResult> {
  const deploymentPlan = buildWorkflowPlanFromArtifact(
    input.artifact,
    input.defaults
  );
  const provider = deploymentPlan.provider;
  const region = deploymentPlan.region;
  const gcpProject = deploymentPlan.gcpProject;
  const steps: WorkflowBuildStep[] = [];

  const validationStartedAt = Date.now();
  const validation = validateWorkflowArtifact({
    slug: input.artifact.slug,
    code: input.artifact.code,
    writeCheckpoints: input.artifact.writeCheckpoints,
  });
  steps.push(
    createStep({
      stage: "validation",
      label: "Validation",
      status: validation.ok ? "success" : "error",
      summary: validation.ok
        ? "Workflow passed compile and helper checks."
        : "Workflow failed validation.",
      durationMs: Date.now() - validationStartedAt,
      output: formatValidationSummary(validation),
    })
  );

  if (!validation.ok) {
    return createFailureResult({
      provider,
      region,
      gcpProject,
      steps,
      error: "Workflow must pass validation before it can build.",
      validation,
    });
  }

  const previewStartedAt = Date.now();
  const preview = await previewWorkflowArtifact(
    {
      slug: input.artifact.slug,
      code: input.artifact.code,
      samplePayload: input.artifact.samplePayload,
    },
    input.approvedCheckpoints || []
  );
  steps.push(
    createStep({
      stage: "preview",
      label: "Preview",
      status: preview.status === "error" ? "error" : "success",
      summary:
        preview.status === "success"
          ? "Workflow preview completed."
          : preview.status === "needs_approval"
            ? "Preview reached a write checkpoint and build continued."
            : "Workflow preview failed.",
      durationMs: Date.now() - previewStartedAt,
      output: formatPreviewSummary(preview),
    })
  );

  if (preview.status === "error") {
    return createFailureResult({
      provider,
      region,
      gcpProject,
      steps,
      error: preview.error || "Workflow preview failed.",
      validation,
      preview,
    });
  }

  const projectResolution = await resolveProjectRoot();
  if (!projectResolution.configured || !projectResolution.projectRoot) {
    throw new Error(
      projectResolution.reason ||
        "Project root is not configured for Workflow Studio."
    );
  }

  await saveStoredWorkflow({
    ...input.artifact,
    validation,
    preview,
    deploymentPlan,
  });

  const buildStartedAt = Date.now();
  try {
    const cliBuild = await runSharedCliBuild({
      projectRoot: projectResolution.projectRoot,
      workflowId: input.artifact.slug,
      provider,
      region,
      gcpProject,
    });
    const packageOutput = [
      `Artifact: ${cliBuild.artifact.artifactPath}`,
      cliBuild.artifact.imageUri
        ? `Image: ${cliBuild.artifact.imageUri}`
        : undefined,
      cliBuild.output,
    ]
      .filter(Boolean)
      .join("\n\n");

    steps.push(
      createStep({
        stage: "bundle",
        label: "Bundle",
        status: "success",
        summary: "Bundled workflow using the shared deploy CLI flow.",
        command: cliBuild.command,
      })
    );
    steps.push(
      createStep({
        stage: "package",
        label: provider === "aws" ? "Package" : "Container Build",
        status: "success",
        summary:
          provider === "aws"
            ? "Packaged workflow as an AWS Lambda zip artifact."
            : "Built a local GCP container image.",
        durationMs: Date.now() - buildStartedAt,
        command: cliBuild.command,
        output: packageOutput,
      })
    );

    return {
      status: "success",
      provider,
      region,
      gcpProject,
      builtAt: new Date().toISOString(),
      steps,
      validation,
      preview,
      artifact: cliBuild.artifact,
    };
  } catch (error) {
    const message = formatBuildError(error);
    const command =
      error && typeof error === "object" && "cliCommand" in error
        ? (error as { cliCommand?: string }).cliCommand
        : undefined;
    const failedStage = inferCliFailureStage(message, provider);

    if (failedStage === "package") {
      steps.push(
        createStep({
          stage: "bundle",
          label: "Bundle",
          status: "success",
          summary: "Bundled workflow using the shared deploy CLI flow.",
          command,
        })
      );
    }

    steps.push(
      createStep({
        stage: failedStage,
        label: failedStage === "bundle" ? "Bundle" : provider === "aws" ? "Package" : "Container Build",
        status: "error",
        summary:
          failedStage === "bundle"
            ? "Bundling failed."
            : provider === "aws"
              ? "Packaging failed."
              : "Container image build failed.",
        durationMs: Date.now() - buildStartedAt,
        command,
        output: message,
      })
    );

    return createFailureResult({
      provider,
      region,
      gcpProject,
      steps,
      error: message,
      validation,
      preview,
    });
  }
}

export async function repairWorkflowBuildFailure(input: {
  artifact: WorkflowStudioArtifact;
  approvedCheckpoints?: string[];
  defaults?: WorkflowProjectDeploymentDefaults;
}): Promise<{
  artifact: WorkflowStudioArtifact;
  build: WorkflowBuildResult;
  repaired: boolean;
  assistantMessage?: string;
  blockedAccesses?: WorkflowAccessRequirement[];
}> {
  const initialBuild = await buildWorkflowArtifact({
    artifact: input.artifact,
    approvedCheckpoints: input.approvedCheckpoints,
    defaults: input.defaults,
  });
  const baseDeploymentPlan = buildWorkflowPlanFromArtifact(
    input.artifact,
    input.defaults
  );

  const baseArtifact: WorkflowStudioArtifact = {
    ...input.artifact,
    validation: initialBuild.validation || input.artifact.validation,
    preview: initialBuild.preview || input.artifact.preview,
    build: initialBuild,
    deploymentPlan: baseDeploymentPlan,
  };

  if (initialBuild.status === "success") {
    return {
      artifact: baseArtifact,
      build: initialBuild,
      repaired: false,
    };
  }

  const repairMessages = [
    ...(input.artifact.messages || []),
    createBuildRepairMessage(baseArtifact, initialBuild),
  ];

  const generated = await generateWorkflowArtifact({
    messages: repairMessages,
    currentArtifact: baseArtifact,
  });

  if (!generated.artifact) {
    throw new Error(
      generated.assistantMessage ||
        "Workflow Studio could not repair the build failure."
    );
  }

  const repairedBuild = await buildWorkflowArtifact({
    artifact: generated.artifact,
    approvedCheckpoints: input.approvedCheckpoints,
    defaults: input.defaults,
  });
  const repairedDeploymentPlan = buildWorkflowPlanFromArtifact(
    generated.artifact,
    input.defaults
  );

  const repairedArtifact: WorkflowStudioArtifact = {
    ...generated.artifact,
    messages: input.artifact.messages || generated.artifact.messages,
    validation: repairedBuild.validation || generated.artifact.validation,
    preview: repairedBuild.preview || generated.artifact.preview,
    build: repairedBuild,
    deploymentPlan: repairedDeploymentPlan,
  };

  return {
    artifact: repairedArtifact,
    build: repairedBuild,
    repaired: true,
    assistantMessage: generated.assistantMessage,
    blockedAccesses: generated.blockedAccesses,
  };
}
