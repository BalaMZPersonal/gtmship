import {
  mkdir,
  readdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  ensureWithinProjectRoot,
  resolveProjectRoot,
} from "./project-root";
import { loadProjectDeploymentDefaults } from "./project-config";
import {
  buildWorkflowPlanFromArtifact,
  extractTriggerFromSource,
  formatTriggerForListing,
} from "./deploy-plan";
import { extractWorkflowIdFromSource } from "./runtime";
import type {
  StoredWorkflowRecord,
  WorkflowListItem,
  WorkflowListingResponse,
  WorkflowStudioArtifact,
} from "./types";

function defaultMermaid(title: string): string {
  return [
    "flowchart LR",
    `  trigger([Trigger]) --> workflow[${title}]`,
    "  workflow --> output([Result])",
  ].join("\n");
}

function extractString(
  source: string,
  pattern: RegExp,
  fallback: string
): string {
  const match = source.match(pattern);
  return match?.[1]?.trim() || fallback;
}

function fallbackArtifactFromCode(
  slug: string,
  code: string
): WorkflowStudioArtifact {
  const title = extractString(code, /name:\s*["'`]([^"'`]+)["'`]/, slug);
  const summary = extractString(
    code,
    /description:\s*["'`]([^"'`]+)["'`]/,
    "Existing workflow"
  );

  const trigger = extractTriggerFromSource(code);
  const artifact: WorkflowStudioArtifact = {
    slug,
    title,
    summary,
    description: summary,
    mermaid: defaultMermaid(title),
    code,
    samplePayload: "{}",
    requiredAccesses: [],
    writeCheckpoints: [],
    chatSummary: "Loaded from an existing workflow file.",
    messages: [],
    transcriptCompaction: undefined,
    triggerConfig: {
      schedule:
        trigger.type === "schedule" ? { cron: trigger.cron } : undefined,
      webhook:
        trigger.type === "webhook" ? { path: trigger.path } : undefined,
      event:
        trigger.type === "event"
          ? { detailType: trigger.event }
          : undefined,
    },
    bindings: [],
  };

  return {
    ...artifact,
    deploymentPlan: buildWorkflowPlanFromArtifact(artifact),
  };
}

function buildWorkflowPaths(projectRoot: string, slug: string) {
  const workflowPath = ensureWithinProjectRoot(
    projectRoot,
    path.join(projectRoot, "workflows", `${slug}.ts`)
  );
  const metadataPath = ensureWithinProjectRoot(
    projectRoot,
    path.join(projectRoot, ".gtmship", "workflows", `${slug}.json`)
  );

  return { workflowPath, metadataPath };
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

export function slugifyWorkflowTitle(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "custom-workflow";
}

export async function listStoredWorkflows(): Promise<WorkflowListingResponse> {
  const resolution = await resolveProjectRoot();
  if (!resolution.configured || !resolution.projectRoot) {
    return {
      projectRootConfigured: false,
      workflows: [],
    };
  }

  const deploymentDefaults = await loadProjectDeploymentDefaults(
    resolution.projectRoot
  );

  const workflowsDir = path.join(resolution.projectRoot, "workflows");
  const metadataDir = path.join(resolution.projectRoot, ".gtmship", "workflows");

  // Ensure workflows directory exists for new projects
  try {
    await mkdir(workflowsDir, { recursive: true });
  } catch {
    // ignore — will fail gracefully below
  }

  let entries: string[] = [];
  try {
    entries = (await readdir(workflowsDir)).filter((file) =>
      file.endsWith(".ts")
    );
  } catch {
    return {
      projectRootConfigured: true,
      projectRoot: resolution.projectRoot,
      projectName: resolution.projectName,
      deploymentDefaults,
      workflows: [],
    };
  }

  const workflows = await Promise.all(
    entries.map(async (fileName): Promise<WorkflowListItem> => {
      const slug = fileName.replace(/\.ts$/, "");
      const workflowPath = path.join(workflowsDir, fileName);
      const metadataPath = path.join(metadataDir, `${slug}.json`);
      const code = await readFile(workflowPath, "utf8");
      const workflowId = extractWorkflowIdFromSource(code, slug, fileName);

      let artifact = fallbackArtifactFromCode(slug, code);
      let hasStudioMetadata = false;

      try {
        const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
          artifact?: WorkflowStudioArtifact;
        };
        if (metadata.artifact) {
          artifact = metadata.artifact;
          hasStudioMetadata = true;
        }
      } catch {
        // Existing workflow with no sidecar.
      }

      const workflowStats = await stat(workflowPath);

      return {
        slug,
        workflowId,
        title: artifact.title,
        summary: artifact.summary,
        updatedAt: workflowStats.mtime.toISOString(),
        trigger: formatTriggerForListing(code),
        filePath: workflowPath,
        hasStudioMetadata,
      };
    })
  );

  workflows.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  return {
    projectRootConfigured: true,
    projectRoot: resolution.projectRoot,
    projectName: resolution.projectName,
    deploymentDefaults,
    workflows,
  };
}

export async function loadStoredWorkflow(
  slug: string
): Promise<StoredWorkflowRecord> {
  const resolution = await resolveProjectRoot();
  if (!resolution.configured || !resolution.projectRoot) {
    throw new Error(
      resolution.reason ||
        "Project root is not configured for Workflow Studio."
    );
  }

  const { workflowPath, metadataPath } = buildWorkflowPaths(
    resolution.projectRoot,
    slug
  );
  const deploymentDefaults = await loadProjectDeploymentDefaults(
    resolution.projectRoot
  );
  const code = await readFile(workflowPath, "utf8");
  const workflowId = extractWorkflowIdFromSource(code, slug, `${slug}.ts`);

  let artifact = fallbackArtifactFromCode(slug, code);
  try {
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
      artifact?: WorkflowStudioArtifact;
    };
    if (metadata.artifact) {
      artifact = {
        ...metadata.artifact,
        code,
      };
    }
  } catch {
    artifact = {
      ...artifact,
      code,
    };
  }

  artifact = {
    ...artifact,
    deploymentPlan: buildWorkflowPlanFromArtifact(artifact, deploymentDefaults),
  };

  const workflowStats = await stat(workflowPath);

  return {
    slug,
    workflowId,
    filePath: workflowPath,
    metadataPath,
    artifact,
    updatedAt: workflowStats.mtime.toISOString(),
  };
}

export async function saveStoredWorkflow(
  artifact: WorkflowStudioArtifact
): Promise<StoredWorkflowRecord> {
  const resolution = await resolveProjectRoot();
  if (!resolution.configured || !resolution.projectRoot) {
    throw new Error(
      resolution.reason ||
        "Project root is not configured for Workflow Studio."
    );
  }

  const { workflowPath, metadataPath } = buildWorkflowPaths(
    resolution.projectRoot,
    artifact.slug
  );
  const deploymentDefaults = await loadProjectDeploymentDefaults(
    resolution.projectRoot
  );
  const artifactWithPlan: WorkflowStudioArtifact = {
    ...artifact,
    deploymentPlan: buildWorkflowPlanFromArtifact(artifact, deploymentDefaults),
  };
  const workflowId = extractWorkflowIdFromSource(
    artifactWithPlan.code,
    artifactWithPlan.slug,
    `${artifactWithPlan.slug}.ts`
  );

  await mkdir(path.dirname(workflowPath), { recursive: true });
  await mkdir(path.dirname(metadataPath), { recursive: true });

  await writeFile(workflowPath, artifactWithPlan.code, "utf8");
  await writeFile(
    metadataPath,
    JSON.stringify(
      {
        savedAt: new Date().toISOString(),
        artifact: artifactWithPlan,
      },
      null,
      2
    ),
    "utf8"
  );

  const workflowStats = await stat(workflowPath);

  return {
    slug: artifactWithPlan.slug,
    workflowId,
    filePath: workflowPath,
    metadataPath,
    artifact: artifactWithPlan,
    updatedAt: workflowStats.mtime.toISOString(),
  };
}

export async function deleteStoredWorkflow(slug: string): Promise<void> {
  const resolution = await resolveProjectRoot();
  if (!resolution.configured || !resolution.projectRoot) {
    throw new Error(
      resolution.reason ||
        "Project root is not configured for Workflow Studio."
    );
  }

  const { workflowPath, metadataPath } = buildWorkflowPaths(
    resolution.projectRoot,
    slug
  );

  try {
    await unlink(workflowPath);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      throw new Error(`Workflow "${slug}" not found.`);
    }
    throw error;
  }

  try {
    await unlink(metadataPath);
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
  }
}
