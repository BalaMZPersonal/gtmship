import { access, mkdir, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getSetting } from "./auth-service";

const PROJECTS_DIR = path.join(os.homedir(), ".gtmship", "projects");
const DEFAULT_PROJECT = "default";

export interface ProjectRootResolution {
  configured: boolean;
  projectRoot?: string;
  projectName?: string;
  source?: "setting" | "env" | "default";
  reason?: string;
}

export interface ProjectInfo {
  name: string;
  path: string;
  isDefault: boolean;
  workflowCount: number;
  updatedAt: string | null;
}

/**
 * Returns the base directory where all projects live.
 */
export function getProjectsDir(): string {
  return PROJECTS_DIR;
}

/**
 * Resolve which project directory to use.
 *
 * Priority:
 *   1. `project_root` setting from the database (explicit override)
 *   2. `GTMSHIP_PROJECT_ROOT` env var
 *   3. Default project at ~/.gtmship/projects/default (auto-created)
 */
export async function resolveProjectRoot(): Promise<ProjectRootResolution> {
  // 1. Check explicit setting
  const setting = await getSetting("project_root");
  if (setting) {
    const projectRoot = path.resolve(setting);
    const isRoot = projectRoot === path.parse(projectRoot).root;

    if (!isRoot) {
      try {
        await access(projectRoot);
        return {
          configured: true,
          projectRoot,
          projectName: path.basename(projectRoot),
          source: "setting",
        };
      } catch {
        // Setting points to a non-existent directory — fall through to default
      }
    }
    // Invalid setting (filesystem root or non-existent) — fall through to default
  }

  // 2. Check env var
  const envRoot = process.env.GTMSHIP_PROJECT_ROOT;
  if (envRoot) {
    const projectRoot = path.resolve(envRoot);
    try {
      await access(projectRoot);
      return {
        configured: true,
        projectRoot,
        projectName: path.basename(projectRoot),
        source: "env",
      };
    } catch {
      // Env var points to a non-existent directory — fall through to default
    }
  }

  // 3. Fall back to default project — auto-create if missing
  const defaultRoot = path.join(PROJECTS_DIR, DEFAULT_PROJECT);
  await mkdir(defaultRoot, { recursive: true });

  return {
    configured: true,
    projectRoot: defaultRoot,
    projectName: DEFAULT_PROJECT,
    source: "default",
  };
}

/**
 * List all projects under ~/.gtmship/projects/ plus any custom project_root.
 */
export async function listProjects(): Promise<ProjectInfo[]> {
  const projects: ProjectInfo[] = [];

  // Ensure projects dir exists
  await mkdir(PROJECTS_DIR, { recursive: true });

  try {
    const entries = await readdir(PROJECTS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectPath = path.join(PROJECTS_DIR, entry.name);
      projects.push(await buildProjectInfo(entry.name, projectPath));
    }
  } catch {
    // projects dir doesn't exist yet — that's fine
  }

  // If there's an explicit setting pointing outside ~/.gtmship/projects, include it too
  const setting = await getSetting("project_root");
  if (setting) {
    const settingRoot = path.resolve(setting);
    const alreadyListed = projects.some((p) => p.path === settingRoot);
    if (!alreadyListed && settingRoot !== path.parse(settingRoot).root) {
      try {
        await access(settingRoot);
        projects.push(
          await buildProjectInfo(path.basename(settingRoot), settingRoot)
        );
      } catch {
        // configured path doesn't exist — skip it
      }
    }
  }

  // Ensure "default" always appears first
  projects.sort((a, b) => {
    if (a.isDefault) return -1;
    if (b.isDefault) return 1;
    return a.name.localeCompare(b.name);
  });

  return projects;
}

/**
 * Create a new project directory under ~/.gtmship/projects/<name>.
 * Returns the project info for the newly created project.
 */
export async function createProject(name: string): Promise<ProjectInfo> {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

  if (!slug) {
    throw new Error("Invalid project name.");
  }

  const projectPath = path.join(PROJECTS_DIR, slug);
  await mkdir(path.join(projectPath, "workflows"), { recursive: true });

  return buildProjectInfo(slug, projectPath);
}

async function buildProjectInfo(
  name: string,
  projectPath: string
): Promise<ProjectInfo> {
  let workflowCount = 0;
  let updatedAt: string | null = null;

  const workflowsDir = path.join(projectPath, "workflows");
  try {
    const files = (await readdir(workflowsDir)).filter((f) =>
      f.endsWith(".ts")
    );
    workflowCount = files.length;

    // Find most recent modification
    for (const file of files) {
      const s = await stat(path.join(workflowsDir, file));
      const mtime = s.mtime.toISOString();
      if (!updatedAt || mtime > updatedAt) {
        updatedAt = mtime;
      }
    }
  } catch {
    // no workflows dir yet
  }

  return {
    name,
    path: projectPath,
    isDefault: name === DEFAULT_PROJECT,
    workflowCount,
    updatedAt,
  };
}

export function ensureWithinProjectRoot(
  projectRoot: string,
  candidatePath: string
): string {
  const resolved = path.resolve(candidatePath);
  const relative = path.relative(projectRoot, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path escapes the configured project root.");
  }

  return resolved;
}
