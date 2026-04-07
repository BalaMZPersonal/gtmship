import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkflowStudioArtifact } from "./types";
import {
  ensureWithinProjectRoot,
  resolveProjectRoot,
} from "./project-root";

const execFileAsync = promisify(execFile);
const MAX_PROJECT_FILE_BYTES = 64_000;
const MAX_SEARCH_RESULTS = 20;
const FALLBACK_IGNORED_DIRS = new Set([
  ".git",
  ".gtmship",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
]);

function trimContent(value: string, maxChars = 12_000): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}\n\n... (content truncated)`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileSearchPattern(query: string): RegExp {
  try {
    return new RegExp(query);
  } catch {
    return new RegExp(escapeRegExp(query));
  }
}

function compileGlobPattern(glob?: string): RegExp | null {
  const trimmed = glob?.trim();
  if (!trimmed) {
    return null;
  }

  const escaped = trimmed
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__DOUBLE_STAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/__DOUBLE_STAR__/g, ".*");

  return new RegExp(`^${escaped}$`);
}

export async function searchProjectFilesWithoutRipgrep(
  projectRoot: string,
  input: {
    query: string;
    glob?: string;
    maxResults?: number;
  },
): Promise<Array<{ path: string; line: number; preview: string }>> {
  const maxResults = Math.min(
    Math.max(input.maxResults || 8, 1),
    MAX_SEARCH_RESULTS,
  );
  const pattern = compileSearchPattern(input.query);
  const globPattern = compileGlobPattern(input.glob);
  const matches: Array<{ path: string; line: number; preview: string }> = [];

  async function walk(relativeDir = ""): Promise<void> {
    if (matches.length >= maxResults) {
      return;
    }

    const absoluteDir = path.join(projectRoot, relativeDir);
    const entries = await readdir(absoluteDir, { withFileTypes: true });

    for (const entry of entries) {
      if (matches.length >= maxResults) {
        return;
      }

      const relativePath = relativeDir
        ? path.posix.join(relativeDir, entry.name)
        : entry.name;

      if (entry.isDirectory()) {
        if (!FALLBACK_IGNORED_DIRS.has(entry.name)) {
          await walk(relativePath);
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (globPattern && !globPattern.test(relativePath)) {
        continue;
      }

      const absolutePath = ensureWithinProjectRoot(
        projectRoot,
        path.join(projectRoot, relativePath),
      );

      let content = "";
      try {
        content = await readFile(absolutePath, {
          encoding: "utf8",
          flag: "r",
        });
      } catch {
        continue;
      }

      if (content.includes("\u0000")) {
        continue;
      }

      const lines = content
        .slice(0, MAX_PROJECT_FILE_BYTES)
        .split("\n");

      for (let index = 0; index < lines.length; index += 1) {
        if (pattern.test(lines[index])) {
          matches.push({
            path: absolutePath,
            line: index + 1,
            preview: lines[index].trim(),
          });
          break;
        }
      }
    }
  }

  await walk();
  return matches;
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
      error.code === "ENOENT"
    ) {
      const matches = await searchProjectFilesWithoutRipgrep(
        resolution.projectRoot,
        input,
      );

      return {
        projectRoot: resolution.projectRoot,
        query: input.query,
        matches,
      };
    }

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
