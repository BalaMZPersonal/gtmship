import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkflowStudioArtifact } from "./types";
import {
  ensureWithinProjectRoot,
  resolveProjectRoot,
} from "./project-root";

const execFileAsync = promisify(execFile);
const MAX_PROJECT_FILE_BYTES = 64_000;
const MAX_SEARCH_RESULTS = 20;

function trimContent(value: string, maxChars = 12_000): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}\n\n... (content truncated)`;
}

export async function readProjectFile(relativePath: string): Promise<{
  projectRoot: string;
  path: string;
  content: string;
}> {
  const resolution = await resolveProjectRoot();
  if (!resolution.configured || !resolution.projectRoot) {
    throw new Error(
      resolution.reason ||
        "Project root is not configured for Workflow Studio."
    );
  }

  const targetPath = ensureWithinProjectRoot(
    resolution.projectRoot,
    path.join(resolution.projectRoot, relativePath)
  );
  const content = await readFile(targetPath, {
    encoding: "utf8",
    flag: "r",
  });

  return {
    projectRoot: resolution.projectRoot,
    path: targetPath,
    content: trimContent(content.slice(0, MAX_PROJECT_FILE_BYTES)),
  };
}

export async function searchProjectFiles(input: {
  query: string;
  glob?: string;
  maxResults?: number;
}): Promise<{
  projectRoot: string;
  query: string;
  matches: Array<{
    path: string;
    line: number;
    preview: string;
  }>;
}> {
  const resolution = await resolveProjectRoot();
  if (!resolution.configured || !resolution.projectRoot) {
    throw new Error(
      resolution.reason ||
        "Project root is not configured for Workflow Studio."
    );
  }

  const maxResults = Math.min(
    Math.max(input.maxResults || 8, 1),
    MAX_SEARCH_RESULTS
  );
  const args = [
    "-n",
    "--no-heading",
    "--color",
    "never",
    "--max-count",
    String(maxResults),
  ];

  if (input.glob?.trim()) {
    args.push("-g", input.glob.trim());
  }

  args.push(input.query, ".");

  try {
    const { stdout } = await execFileAsync("rg", args, {
      cwd: resolution.projectRoot,
      maxBuffer: 1024 * 1024,
    });

    const matches = stdout
      .split("\n")
      .filter(Boolean)
      .slice(0, maxResults)
      .map((line) => {
        const [relativePath, lineNumber, ...rest] = line.split(":");
        const absolutePath = ensureWithinProjectRoot(
          resolution.projectRoot!,
          path.join(resolution.projectRoot!, relativePath)
        );

        return {
          path: absolutePath,
          line: Number(lineNumber) || 1,
          preview: rest.join(":").trim(),
        };
      });

    return {
      projectRoot: resolution.projectRoot,
      query: input.query,
      matches,
    };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === 1
    ) {
      return {
        projectRoot: resolution.projectRoot,
        query: input.query,
        matches: [],
      };
    }

    const message = error instanceof Error ? error.message : "Search failed.";
    throw new Error(`Project search failed: ${message}`);
  }
}

export async function prepareWorkflowScratchWorkspace(
  artifact?: Pick<
    WorkflowStudioArtifact,
    "slug" | "code" | "samplePayload" | "title" | "summary"
  > | null
): Promise<{
  workspacePath: string;
}> {
  const resolution = await resolveProjectRoot();
  const safeSlug = (artifact?.slug || "workflow-studio")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const workspaceRoot =
    resolution.configured && resolution.projectRoot
      ? ensureWithinProjectRoot(
          resolution.projectRoot,
          path.join(
            resolution.projectRoot,
            ".gtmship",
            "workflows",
            ".studio",
            safeSlug || "workflow-studio"
          )
        )
      : path.join("/tmp", "gtmship-workflow-studio", safeSlug || "workflow-studio");

  await mkdir(workspaceRoot, { recursive: true });

  if (artifact) {
    await writeFile(path.join(workspaceRoot, "draft.ts"), artifact.code, "utf8");
    await writeFile(
      path.join(workspaceRoot, "sample-payload.json"),
      artifact.samplePayload,
      "utf8"
    );
    await writeFile(
      path.join(workspaceRoot, "artifact-summary.json"),
      JSON.stringify(
        {
          slug: artifact.slug,
          title: artifact.title,
          summary: artifact.summary,
        },
        null,
        2
      ),
      "utf8"
    );
  }

  return { workspacePath: workspaceRoot };
}
